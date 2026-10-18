//! 문서 정책이 TAC 조판·점유 bbox·수식 paint·편집 크기까지 함께 전달되는 공개 계약.
//! MIT 소유 source fixture만 등록한다. 설치된 한컴 서체·외부 실행 파일은 필요 없다.
use rhwp::document_core::DocumentCore;
use rhwp::model::control::{Control, Equation};
use rhwp::model::paragraph::{CharShapeRef, LineSeg, Paragraph};
use rhwp::model::provenance::FontMetricsPolicy::{self, HancomWindows, HcrDeclared};
use rhwp::model::shape::{CommonObjAttr, RectangleShape, ShapeObject, TextBox};
use rhwp::model::style::Alignment;
use rhwp::model::table::{Cell, Table};
use rhwp::renderer::composer::{
    compose_paragraph, compose_paragraph_with_policy, compose_paragraph_with_styles,
};
use rhwp::renderer::equation::layout::LayoutKind;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};
use rhwp::renderer::style_resolver::resolve_styles;
use std::path::PathBuf;

const TEST: &str = "issue_math10_windows_equation_policy::windows_equation_policy_reaches_document_composition_paint_and_edit";

fn isolated() -> bool {
    const CHILD: &str = "RHWP_WINDOWS_EQUATION_DOCUMENT_CHILD";
    if std::env::var_os(CHILD).is_some() {
        return false;
    }
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .arg(TEST)
        .args(["--exact", "--nocapture"])
        .env(CHILD, "1")
        .env_remove(rhwp::renderer::font_paths::FONT_PATH_ENV);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command
        .output()
        .expect("isolated public document policy test");
    assert!(
        output.status.success() && String::from_utf8_lossy(&output.stdout).contains("1 passed"),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    print!("{}", String::from_utf8_lossy(&output.stdout));
    true
}

fn checksum(bytes: &[u8]) -> u32 {
    bytes.chunks(4).fold(0u32, |sum, chunk| {
        let mut word = [0; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        sum.wrapping_add(u32::from_be_bytes(word))
    })
}

// MIT 소유 face의 사각형만 사용하고 hmtx 비율을 1/2 또는 4/5 em으로 바꾼다.
fn source_bytes(numerator: u16, denominator: u16) -> Vec<u8> {
    let mut bytes = include_bytes!("../fixtures/fonts/HYhwpEQSourceFixture.ttf").to_vec();
    let (glyph, metric_count, em) = {
        let face = ttf_parser::Face::parse(&bytes, 0).unwrap();
        let gid = face.glyph_index('\u{e034}').unwrap().0;
        for ch in ['\u{e037}', '\u{e038}', '\u{e0fc}'] {
            assert_eq!(
                face.glyph_index(ch).unwrap().0,
                gid,
                "owned common rectangle"
            );
        }
        (
            gid,
            face.tables().hhea.number_of_metrics,
            face.units_per_em(),
        )
    };
    let count = u16::from_be_bytes(bytes[4..6].try_into().unwrap()) as usize;
    let directory = |tag: &[u8; 4]| {
        (0..count)
            .map(|i| 12 + i * 16)
            .find(|&offset| &bytes[offset..offset + 4] == tag)
            .unwrap()
    };
    let head_record = directory(b"head");
    let hmtx_record = directory(b"hmtx");
    let head =
        u32::from_be_bytes(bytes[head_record + 8..head_record + 12].try_into().unwrap()) as usize;
    let hmtx =
        u32::from_be_bytes(bytes[hmtx_record + 8..hmtx_record + 12].try_into().unwrap()) as usize;
    let offset = hmtx + usize::from(glyph.min(metric_count - 1)) * 4;
    bytes[offset..offset + 2].copy_from_slice(&(em * numerator / denominator).to_be_bytes());
    bytes[head + 8..head + 12].fill(0);
    for record in [head_record, hmtx_record] {
        let start = u32::from_be_bytes(bytes[record + 8..record + 12].try_into().unwrap()) as usize;
        let length =
            u32::from_be_bytes(bytes[record + 12..record + 16].try_into().unwrap()) as usize;
        let value = checksum(&bytes[start..start + length]);
        bytes[record + 4..record + 8].copy_from_slice(&value.to_be_bytes());
    }
    let adjustment = 0xb1b0afbau32.wrapping_sub(checksum(&bytes));
    bytes[head + 8..head + 12].copy_from_slice(&adjustment.to_be_bytes());
    assert_eq!(checksum(&bytes), 0xb1b0afba);
    bytes
}

struct SourceFixture {
    directory: PathBuf,
    path: PathBuf,
}
impl SourceFixture {
    fn new(bytes: &[u8]) -> Self {
        let directory = std::env::temp_dir().join(format!(
            "rhwp-document-equation-policy-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("source.ttf");
        std::fs::write(&path, bytes).unwrap();
        rhwp::renderer::font_paths::register_font_face_availability(&[path.clone()]);
        Self { directory, path }
    }
}
impl Drop for SourceFixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.directory).unwrap();
    }
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.02,
        "actual={actual}, expected={expected}"
    );
}

fn equation_paragraph(script: &str) -> Paragraph {
    let mut eq = Equation::default();
    eq.script = script.into();
    eq.font_size = 1100;
    eq.common.ctrl_id = rhwp::parser::tags::CTRL_EQUATION;
    eq.common.treat_as_char = true;
    eq.common.width = 4000;
    eq.common.height = 1500;
    eq.common.margin.left = 37;
    eq.common.margin.right = 53;
    Paragraph {
        text: "T".into(),
        char_offsets: vec![8],
        char_count: 10,
        char_shapes: vec![CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        }],
        controls: vec![Control::Equation(Box::new(eq))],
        line_segs: vec![LineSeg {
            line_height: 1500,
            text_height: 1500,
            baseline_distance: 1275,
            segment_width: 20000,
            tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
            ..Default::default()
        }],
        ..Default::default()
    }
}

fn inline_table(paragraph: Paragraph) -> Table {
    let mut table = Table {
        row_count: 1,
        col_count: 1,
        row_sizes: vec![1],
        common: CommonObjAttr {
            ctrl_id: rhwp::parser::tags::CTRL_TABLE,
            treat_as_char: true,
            width: 20000,
            height: 5000,
            ..Default::default()
        },
        cells: vec![Cell {
            col_span: 1,
            row_span: 1,
            width: 20000,
            height: 5000,
            paragraphs: vec![paragraph],
            ..Default::default()
        }],
        ..Default::default()
    };
    table.rebuild_grid();
    table
}

fn host(control: Control) -> Paragraph {
    Paragraph {
        char_count: 9,
        controls: vec![control],
        char_shapes: vec![CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        }],
        line_segs: vec![LineSeg {
            line_height: 5000,
            text_height: 5000,
            baseline_distance: 4250,
            segment_width: 30000,
            tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
            ..Default::default()
        }],
        ..Default::default()
    }
}

fn document(policy: FontMetricsPolicy, script: &str, container: usize) -> DocumentCore {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().unwrap();
    let mut doc = core.document().clone();
    doc.provenance = Default::default();
    doc.doc_info.font_metrics_policy = policy;
    doc.doc_info.para_shapes[0].alignment = Alignment::Left;
    doc.doc_info.char_shapes[0].base_size = 1000;
    doc.doc_info.char_shapes[0].ratios = [100; 7];
    doc.doc_info.char_shapes[0].relative_sizes = [100; 7];
    let mut paragraph = equation_paragraph(script);
    match container {
        0 => {}
        1 | 2 => {
            for _ in 0..container {
                paragraph = host(Control::Table(Box::new(inline_table(paragraph))));
            }
        }
        3 => {
            let mut shape = RectangleShape::default();
            shape.common = CommonObjAttr {
                treat_as_char: true,
                width: 20000,
                height: 5000,
                ..Default::default()
            };
            shape.drawing.shape_attr.current_width = 20000;
            shape.drawing.shape_attr.current_height = 5000;
            shape.drawing.shape_attr.original_width = 20000;
            shape.drawing.shape_attr.original_height = 5000;
            shape.drawing.text_box = Some(TextBox {
                max_width: 20000,
                paragraphs: vec![paragraph],
                ..Default::default()
            });
            paragraph = host(Control::Shape(Box::new(ShapeObject::Rectangle(shape))));
        }
        _ => unreachable!(),
    }
    doc.sections[0].paragraphs = vec![paragraph];
    core.set_document(doc);
    core
}

fn nodes<'a>(node: &'a RenderNode, out: &mut Vec<&'a RenderNode>) {
    out.push(node);
    for child in &node.children {
        nodes(child, out);
    }
}

fn check_render(core: &DocumentCore, step: f64, width_hu: i32, container: usize) {
    let tree = core.build_page_render_tree(0).unwrap();
    let mut all = vec![];
    nodes(&tree.root, &mut all);
    let equation = all
        .iter()
        .copied()
        .find(|node| matches!(&node.node_type, RenderNodeType::Equation(_)))
        .expect("public equation node");
    let prose = all
        .iter()
        .copied()
        .find(|node| matches!(&node.node_type, RenderNodeType::TextRun(run) if run.text == "T"))
        .expect("following prose");
    let RenderNodeType::Equation(data) = &equation.node_type else {
        unreachable!()
    };
    let LayoutKind::Row(children) = &data.layout_box.kind else {
        panic!("digit-variable row")
    };
    assert_eq!(children.len(), 2);
    near(children[1].x - children[0].x, step);
    near(data.font_size, 1100.0 / 75.0);
    near(children[0].resolved_font_size.unwrap(), data.font_size);
    near(data.layout_box.width, 2.0 * step);
    near(equation.bbox.width, f64::from(width_hu) / 75.0);
    near(
        prose.bbox.x - equation.bbox.x,
        f64::from(width_hu + 53) / 75.0,
    );
    if container == 1 || container == 2 {
        assert_eq!(data.cell_context.as_ref().unwrap().path.len(), container);
    }
    let controls: serde_json::Value =
        serde_json::from_str(&core.get_page_control_layout_native(0).unwrap()).unwrap();
    let control = controls["controls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["type"] == "equation")
        .unwrap();
    assert!(
        (control["w"].as_f64().unwrap() - equation.bbox.width).abs() <= 0.06,
        "public selection bbox follows the policy-specific occupied content"
    );
}

fn body_equation(core: &DocumentCore) -> &Equation {
    core.document().sections[0].paragraphs[0]
        .controls
        .iter()
        .find_map(|control| {
            if let Control::Equation(eq) = control {
                Some(eq.as_ref())
            } else {
                None
            }
        })
        .expect("body equation")
}

#[test]
fn windows_equation_policy_reaches_document_composition_paint_and_edit() {
    if isolated() {
        return;
    }
    let half_em = source_bytes(1, 2);
    let fixture = SourceFixture::new(&half_em);
    // 4x/5x의 숫자→변수는 Windows 5.25pt, Mac 4.725pt. 같은 source 등록으로 번갈아 호출한다.
    for policy in [HancomWindows, HcrDeclared, HancomWindows, HcrDeclared] {
        let step = if policy == HancomWindows { 7.0 } else { 6.3 };
        let width = if policy == HancomWindows { 1050 } else { 945 };
        for script in ["4x", "5x"] {
            let core = document(policy, script, 0);
            let para = &core.document().sections[0].paragraphs[0];
            assert_eq!(
                compose_paragraph_with_policy(para, policy).tac_controls[0].1,
                width + 90
            );
            assert_eq!(
                compose_paragraph_with_styles(
                    para,
                    &resolve_styles(&core.document().doc_info, 96.0)
                )
                .tac_controls[0]
                    .1,
                width + 90
            );
            assert_eq!(
                compose_paragraph(para).tac_controls[0].1,
                945 + 90,
                "fontless default composer remains HcrDeclared"
            );
            check_render(&core, step, width, 0);
        }
        for container in [1, 2, 3] {
            check_render(&document(policy, "4x", container), step, width, container);
        }
        let mut edited = DocumentCore::new_empty();
        edited.create_blank_document_native().unwrap();
        edited.set_font_metrics_policy_native(policy);
        let inserted: serde_json::Value = serde_json::from_str(
            &edited
                .insert_equation_native(0, 0, 0, "4x", 1100, 0)
                .unwrap(),
        )
        .unwrap();
        let control_index = inserted["controlIdx"].as_u64().unwrap() as usize;
        assert_eq!(
            body_equation(&edited).common.width,
            width as u32,
            "public create uses document policy"
        );
        edited
            .set_equation_properties_native(0, 0, control_index, None, None, r#"{"script":"4545"}"#)
            .unwrap();
        assert_eq!(
            body_equation(&edited).common.width,
            2 * width as u32,
            "public edit uses document policy"
        );
        let mut nested = document(policy, "4x", 2);
        let path = r#"[{"controlIdx":0,"cellIdx":0,"cellParaIdx":0},{"controlIdx":0,"cellIdx":0,"cellParaIdx":0}]"#;
        nested
            .set_equation_properties_by_path_native(0, 0, path, 0, r#"{"script":"4545"}"#)
            .unwrap();
        let properties: serde_json::Value = serde_json::from_str(
            &nested
                .get_equation_properties_by_path_native(0, 0, path, 0)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            properties["width"].as_u64(),
            Some(2 * width as u64),
            "nested edit sizing uses document policy"
        );
        let mut noted = document(policy, "4x", 0);
        let mut doc = noted.document().clone();
        let paragraph = doc.sections[0].paragraphs[0].clone();
        doc.sections[0].paragraphs[0] =
            host(Control::Endnote(Box::new(rhwp::model::footnote::Endnote {
                number: 1,
                paragraphs: vec![paragraph],
                ..Default::default()
            })));
        noted.set_document(doc);
        noted
            .set_note_equation_properties_native("endnote", 0, 0, 0, 0, 0, r#"{"script":"4545"}"#)
            .unwrap();
        let properties: serde_json::Value = serde_json::from_str(
            &noted
                .get_note_equation_properties_native("endnote", 0, 0, 0, 0, 0)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            properties["width"].as_u64(),
            Some(2 * width as u64),
            "note edit sizing uses document policy"
        );
    }
    let mut warmed = [
        document(HcrDeclared, "4x", 0),
        document(HancomWindows, "4x", 0),
    ];
    std::fs::write(&fixture.path, source_bytes(4, 5)).unwrap();
    for (index, core) in warmed.iter_mut().enumerate() {
        core.refresh_layout_native();
        check_render(
            core,
            if index == 0 { 10.08 } else { 11.2 },
            if index == 0 { 1512 } else { 1680 },
            0,
        );
    }
    #[cfg(not(feature = "native-skia"))]
    {
        std::fs::remove_file(&fixture.path).unwrap();
        for core in &mut warmed {
            core.refresh_layout_native();
            let para = &core.document().sections[0].paragraphs[0];
            assert_eq!(
                compose_paragraph_with_policy(para, core.document().doc_info.font_metrics_policy)
                    .tac_controls[0]
                    .1,
                4090,
                "unavailable source retains the saved box plus external margins"
            );
            let tree = core.build_page_render_tree(0).unwrap();
            let mut all = vec![];
            nodes(&tree.root, &mut all);
            let eq = all
                .iter()
                .copied()
                .find(|node| matches!(&node.node_type, RenderNodeType::Equation(_)))
                .unwrap();
            let prose = all.iter().copied().find(|node| matches!(&node.node_type, RenderNodeType::TextRun(run) if run.text == "T")).unwrap();
            near(eq.bbox.width, 4000.0 / 75.0);
            near(prose.bbox.x - eq.bbox.x, 4053.0 / 75.0);
        }
    }
    std::fs::write(&fixture.path, &half_em).unwrap();
    for (index, core) in warmed.iter_mut().enumerate() {
        core.refresh_layout_native();
        check_render(
            core,
            if index == 0 { 6.3 } else { 7.0 },
            if index == 0 { 945 } else { 1050 },
            0,
        );
    }
}

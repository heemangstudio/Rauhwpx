//! 공개 DPI 변경은 수식·본문·캐시·편집 표의 기하를 같은 출력 단위로 바꾼다.

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::document::{Document, Section};
use rhwp::model::paragraph::{CharShapeRef, Paragraph};
use rhwp::model::provenance::{FontMetricsPolicy, SourceFormat};
use rhwp::model::style::{CharShape, ParaShape};
use rhwp::renderer::equation::layout::LayoutKind;
use rhwp::renderer::render_tree::{BoundingBox, RenderNode, RenderNodeType};
use serde_json::Value;

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.02,
        "actual={actual}, expected={expected}"
    );
}

fn nodes(node: &RenderNode) -> Vec<&RenderNode> {
    let mut out = vec![node];
    for child in &node.children {
        out.extend(nodes(child));
    }
    out
}

fn text_box(root: &RenderNode, text: &str) -> BoundingBox {
    nodes(root)
        .into_iter()
        .find(|node| matches!(&node.node_type, RenderNodeType::TextRun(run) if run.text == text))
        .expect("본문 글자 노드")
        .bbox
}

fn find_op<'a>(value: &'a Value, kind: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some(kind) {
                Some(value)
            } else {
                map.values().find_map(|child| find_op(child, kind))
            }
        }
        Value::Array(values) => values.iter().find_map(|child| find_op(child, kind)),
        _ => None,
    }
}

// 렌더 트리와 캐시를 타는 공개 JSON 양쪽에서 실제 좌표와 em을 읽는다.
fn equation_geometry(core: &DocumentCore) -> Vec<f64> {
    let tree = core.build_page_render_tree(0).unwrap();
    let equation = nodes(&tree.root)
        .into_iter()
        .find(|node| matches!(&node.node_type, RenderNodeType::Equation(_)))
        .expect("수식 노드");
    let RenderNodeType::Equation(data) = &equation.node_type else {
        unreachable!()
    };
    let LayoutKind::Row(children) = &data.layout_box.kind else {
        panic!("4x 수식의 두 글자")
    };
    assert_eq!(children.len(), 2);
    let text = text_box(&tree.root, "T");
    let json = core.get_page_layer_tree_native(0).unwrap();
    assert_eq!(core.get_page_layer_tree_native(0).unwrap(), json);
    let cached: Value = serde_json::from_str(&json).unwrap();
    let op = find_op(&cached, "equation").expect("캐시된 수식 paint");
    near(op["fontSize"].as_f64().unwrap(), data.font_size);
    near(
        op["layoutBox"]["width"].as_f64().unwrap(),
        data.layout_box.width,
    );
    let run = find_op(&cached, "textRun").expect("캐시된 본문 paint");
    assert_eq!(run["text"], "T");
    near(run["bbox"]["x"].as_f64().unwrap(), text.x);
    near(cached["pageWidth"].as_f64().unwrap(), tree.root.bbox.width);
    vec![
        tree.root.bbox.width,
        tree.root.bbox.height,
        equation.bbox.x,
        equation.bbox.y,
        equation.bbox.width,
        equation.bbox.height,
        data.font_size,
        data.layout_box.width,
        data.layout_box.height,
        children[1].x - children[0].x,
        text.x,
        text.y,
        text.width,
        text.height,
        run["style"]["fontSize"].as_f64().unwrap(),
    ]
}

fn equation_document(policy: FontMetricsPolicy, dpi: f64) -> DocumentCore {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().unwrap();
    core.set_dpi(dpi);
    core.set_font_metrics_policy_native(policy);
    core.insert_text_native(0, 0, 0, "T").unwrap();
    core.insert_equation_native(0, 0, 0, "4x", 1100, 0).unwrap();
    core
}

#[test]
fn dpi_before_insertion_and_warm_roundtrip_scale_equation_text_and_cached_paint() {
    for policy in [
        FontMetricsPolicy::HancomWindows,
        FontMetricsPolicy::HcrDeclared,
    ] {
        let mut core = equation_document(policy, 96.0);
        let initial = equation_geometry(&core);
        near(initial[6], 1100.0 / 75.0);
        assert!(initial[9] > 0.0, "숫자 다음 변수의 실제 advance");
        for dpi in [200.0, 96.0] {
            let fresh = equation_document(policy, dpi);
            let cold = equation_geometry(&fresh);
            near(cold[6], 1100.0 / 75.0 * dpi / 96.0);
            core.set_dpi(dpi);
            let warm = equation_geometry(&core);
            assert_eq!(warm.len(), cold.len());
            // 원본 HY가 없을 때와 HCR 정책은 출력 px에서 advance를 양자화한다.
            // 폭·advance·자연 높이는 같은 DPI의 새 문서와 비교한다.
            for (actual, expected) in warm.iter().zip(&cold) {
                near(*actual, *expected);
            }
            near(warm[6], 1100.0 / 75.0 * dpi / 96.0);
            // 쪽 크기, 첫 수식 x, 저장 TAC 폭 뒤의 본문 x, 본문 명목 em.
            // 글리프 실측 폭과 수식 기준선에 따른 y는 선형 비례를 요구하지 않는다.
            for index in [0, 1, 2, 10, 14] {
                near(warm[index], initial[index] * dpi / 96.0);
            }
        }
        let restored = equation_geometry(&core);
        assert_eq!(restored, initial, "96 DPI 복귀는 최초 공개 기하를 복원한다");
        for invalid in [0.0, -96.0, f64::NAN, f64::INFINITY] {
            core.set_dpi(invalid);
            assert_eq!(equation_geometry(&core), restored);
        }
    }
}

#[test]
fn generated_hwpx_lines_keep_hwpunit_metrics_across_dpi_refresh() {
    let mut doc = Document::default();
    doc.provenance.format = SourceFormat::Hwpx;
    doc.is_hwpx_variant = true;
    doc.doc_info.char_shapes.push(CharShape {
        base_size: 1000,
        ratios: [100; 7],
        relative_sizes: [100; 7],
        ..Default::default()
    });
    doc.doc_info.para_shapes.push(ParaShape {
        line_spacing: 160,
        ..Default::default()
    });
    let mut section = Section::default();
    for text in ["FIRST", "SECOND"] {
        section.paragraphs.push(Paragraph {
            text: text.into(),
            char_count: text.len() as u32 + 1,
            char_shapes: vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: 0,
            }],
            ..Default::default()
        });
    }
    doc.sections.push(section);
    let bytes = rhwp::serializer::hwpx::serialize_hwpx(&doc).unwrap();
    let mut core = DocumentCore::from_bytes(&bytes).unwrap();
    assert!(core.document().provenance.own_line_layout);
    let metrics = |core: &DocumentCore| {
        core.document().sections[0]
            .paragraphs
            .iter()
            .flat_map(|para| &para.line_segs)
            .flat_map(|seg| {
                [
                    seg.line_height,
                    seg.text_height,
                    seg.baseline_distance,
                    seg.segment_width,
                ]
            })
            .collect::<Vec<_>>()
    };
    let initial_metrics = metrics(&core);
    assert!(!initial_metrics.is_empty());
    let initial_tree = core.build_page_render_tree(0).unwrap();
    let first = text_box(&initial_tree.root, "FIRST");
    let second = text_box(&initial_tree.root, "SECOND");
    core.get_page_layer_tree_native(0).unwrap();
    for dpi in [200.0, 96.0] {
        core.set_dpi(dpi);
        let current = metrics(&core);
        assert_eq!(current.len(), initial_metrics.len());
        for (actual, original) in current.iter().zip(&initial_metrics) {
            assert!((actual - original).abs() <= 1, "{actual} != {original} HU");
        }
        let tree = core.build_page_render_tree(0).unwrap();
        near(
            text_box(&tree.root, "FIRST").height,
            first.height * dpi / 96.0,
        );
        near(
            text_box(&tree.root, "SECOND").y - text_box(&tree.root, "FIRST").y,
            (second.y - first.y) * dpi / 96.0,
        );
        let cached: Value =
            serde_json::from_str(&core.get_page_layer_tree_native(0).unwrap()).unwrap();
        near(cached["pageWidth"].as_f64().unwrap(), tree.root.bbox.width);
    }
}

#[test]
fn edited_table_keeps_loaded_row_floors_after_dpi_roundtrip_and_merge() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("samples/issue6882/synth_cell_enter_table_growth.hwp");
    let mut core = DocumentCore::from_bytes(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(core.page_count(), 2);
    let Control::Table(table) = &core.document().sections[0].paragraphs[1].controls[0] else {
        panic!("기존 합성 회귀 문서의 표")
    };
    let anchor = table.cells[31].paragraphs.len() - 1;
    let offset = table.cells[31].paragraphs[anchor].char_offsets.len();
    for i in 0..8 {
        core.split_paragraph_in_cell_native(
            0,
            1,
            0,
            31,
            anchor + i,
            if i == 0 { offset } else { 0 },
            None,
        )
        .unwrap();
    }
    assert!(core.document().layout_profile().session_edited());
    assert_eq!(core.page_count(), 3);
    let table_geometry = |core: &DocumentCore| {
        let mut out = vec![];
        for page in 0..core.page_count() {
            let tree = core.build_page_render_tree(page).unwrap();
            for node in nodes(&tree.root) {
                if matches!(&node.node_type, RenderNodeType::Table(table)
                    if table.para_index == Some(1) && table.control_index == Some(0))
                {
                    out.push(node.bbox);
                }
            }
            core.get_page_layer_tree_native(page).unwrap();
        }
        out
    };
    let before = table_geometry(&core);
    assert!(!before.is_empty());
    for dpi in [200.0, 96.0] {
        core.set_dpi(dpi);
        assert_eq!(core.page_count(), 3);
        let current = table_geometry(&core);
        assert_eq!(current.len(), before.len());
        for (actual, original) in current.iter().zip(&before) {
            assert!((actual.height / (dpi / 96.0) - original.height).abs() < 1.0);
            near(actual.width, original.width * dpi / 96.0);
        }
    }
    for i in (0..8).rev() {
        core.merge_paragraph_in_cell_native(0, 1, 0, 31, anchor + i + 1)
            .unwrap();
    }
    assert_eq!(core.page_count(), 2, "병합 뒤 로드 시점 행 배분으로 복원");
}

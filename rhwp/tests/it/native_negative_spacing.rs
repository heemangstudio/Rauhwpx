//! 저장된 일반 셀 줄의 음수 조판 간격과 작성된 자간을 구분한다.
use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::document::{Document, Section};
use rhwp::model::paragraph::{CharShapeRef, LineSeg, Paragraph};
use rhwp::model::provenance::FontMetricsPolicy;
use rhwp::model::style::{Alignment, CharShape, Font, ParaShape};
use rhwp::model::table::{Cell, CellLineWrap, Table};
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType, TextRunNode};

const FONT: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/ttfs/opensource/NotoSansKR-Regular.ttf"
));

#[derive(Default)]
struct Context {
    windows: bool,
    ms_word: bool,
    hwp3_lineage: bool,
    grid: i16,
    vertical: u8,
    tracking: i8,
    positioned: bool,
    relative_size: bool,
    control: bool,
    field: bool,
    mixed: bool,
    ordinary_wrap: bool,
}

fn loaded(text: &str, width: i32, ctx: Context) -> (DocumentCore, Vec<(f64, f64, TextRunNode)>) {
    rhwp::wasm_api::clear_runtime_font_metrics();
    let registered: serde_json::Value = serde_json::from_str(
        &rhwp::wasm_api::register_runtime_font_metrics(FONT, "[\"Noto Sans KR\"]", false, false),
    )
    .unwrap();
    assert_eq!(registered["registered"], true);
    let mut doc = Document::default();
    if ctx.ms_word {
        doc.doc_info.hwpx_target_program = Some("MS_WORD".into());
    }
    doc.doc_info.font_faces = vec![
        vec![Font {
            name: "Noto Sans KR".into(),
            ..Default::default()
        }];
        7
    ];
    doc.doc_info.char_shapes = vec![
        CharShape {
            base_size: 1200,
            ratios: [100; 7],
            relative_sizes: [if ctx.relative_size { 95 } else { 100 }; 7],
            spacings: [ctx.tracking; 7],
            char_offsets: [i8::from(ctx.positioned); 7],
            ..Default::default()
        },
        CharShape {
            base_size: 1200,
            ..Default::default()
        },
    ];
    doc.doc_info.para_shapes = vec![
        ParaShape::default(),
        ParaShape {
            alignment: Alignment::Center,
            ..Default::default()
        },
    ];
    let mut refs = vec![CharShapeRef::default()];
    if ctx.mixed {
        refs.push(CharShapeRef {
            start_pos: 1,
            char_shape_id: 1,
        });
    }
    // A trailing empty style must not replace the last visible glyph's style.
    refs.push(CharShapeRef {
        start_pos: text.encode_utf16().count() as u32,
        char_shape_id: 1,
    });
    let mut label = Paragraph {
        text: text.into(),
        char_count: text.encode_utf16().count() as u32 + 1,
        para_shape_id: 1,
        char_shapes: refs,
        line_segs: vec![LineSeg {
            line_height: 1200,
            text_height: 1200,
            baseline_distance: 1020,
            segment_width: width,
            tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
            ..Default::default()
        }],
        ..Default::default()
    };
    if ctx.control {
        label.controls.push(Control::PageHide(Default::default()));
    }
    if ctx.field {
        label.controls.push(Control::Field(Default::default()));
    }
    let mut table = Table {
        row_count: 1,
        col_count: 1,
        cells: vec![Cell {
            width: width as u32,
            height: 2400,
            row_span: 1,
            col_span: 1,
            line_wrap: if ctx.ordinary_wrap {
                CellLineWrap::Break
            } else {
                CellLineWrap::Squeeze
            },
            paragraphs: vec![label],
            ..Default::default()
        }],
        ..Default::default()
    };
    table.common.width = width as u32;
    table.common.height = 2400;
    table.common.treat_as_char = true;
    table.rebuild_grid();
    let mut section = Section::default();
    section.section_def.text_direction = ctx.vertical;
    section.section_def.line_grid = ctx.grid;
    section.section_def.page_def.width = 30000;
    section.section_def.page_def.height = 30000;
    section.paragraphs = vec![
        Paragraph {
            char_count: 17,
            char_shapes: vec![CharShapeRef::default()],
            controls: vec![
                Control::SectionDef(Box::new(section.section_def.clone())),
                Control::ColumnDef(Default::default()),
            ],
            ..Default::default()
        },
        Paragraph {
            char_count: 9,
            char_shapes: vec![CharShapeRef::default()],
            controls: vec![Control::Table(Box::new(table))],
            ..Default::default()
        },
    ];
    doc.sections = vec![section];
    let bytes = rhwp::serializer::hwpx::serialize_hwpx(&doc).unwrap();
    let mut core = DocumentCore::from_bytes_with_font_metrics(
        &bytes,
        if ctx.windows {
            FontMetricsPolicy::HancomWindows
        } else {
            FontMetricsPolicy::HcrDeclared
        },
    )
    .unwrap();
    if ctx.ms_word {
        assert!(core.document().layout_profile().ms_word_compatible_layout());
    }
    if ctx.hwp3_lineage {
        // HWPX는 HWP3 계보를 저장하지 않아 로드된 IR의 공개 입력으로 정책을 검증한다.
        let mut imported = core.document().clone();
        imported.provenance.hwp3_lineage = true;
        imported.is_hwp3_variant = true;
        core.set_document(imported);
        assert!(core.document().layout_profile().hwp3_layout());
    }
    fn collect(node: &RenderNode, runs: &mut Vec<(f64, f64, TextRunNode)>) {
        if let RenderNodeType::TextRun(run) = &node.node_type {
            if run.cell_context.is_some() && !run.text.is_empty() {
                runs.push((node.bbox.x, node.bbox.width, run.clone()));
            }
        }
        for child in &node.children {
            collect(child, runs);
        }
    }
    let source_before = rhwp::serializer::hwpx::serialize_hwpx(core.document()).unwrap();
    let mut runs = Vec::new();
    collect(&core.build_page_render_tree(0).unwrap().root, &mut runs);
    assert_eq!(
        source_before,
        rhwp::serializer::hwpx::serialize_hwpx(core.document()).unwrap(),
        "render keeps model/source unchanged"
    );
    (core, runs)
}

fn widths(text: &str) -> Vec<i32> {
    let face = ttf_parser::Face::parse(FONT, 0).unwrap();
    text.chars()
        .map(|ch| {
            let advance = u32::from(
                face.glyph_hor_advance(face.glyph_index(ch).unwrap())
                    .unwrap(),
            );
            let em = u32::from(face.units_per_em());
            // 12pt는 300 배치 단위다. hmtx를 4HU 격자에 0.5 올림한다.
            ((advance * 300 * 2 + em) / (em * 2) * 4) as i32
        })
        .collect()
}

#[test]
fn loaded_script_runs_compress_only_between_positive_glyph_advances() {
    let text = "가A1.i";
    let natural = widths(text);
    let narrow = natural[3];
    let gap = -(narrow * 3 / 4);
    let width = natural.iter().sum::<i32>() + gap * (natural.len() as i32 - 1);
    // signed HU 나눗셈은 N-1 틈마다 같은 정수 간격을 쓰고 나머지는 남긴다.
    for remainder in 0..natural.len() as i32 - 1 {
        let saved_width = width - remainder;
        let (core, runs) = loaded(text, saved_width, Context::default());
        assert!(
            runs.len() > 2,
            "script runs and terminal glyph remain separate"
        );
        assert_eq!(
            runs.iter()
                .map(|(_, _, run)| run.text.as_str())
                .collect::<String>(),
            text
        );
        let terminal = &runs.last().unwrap().2;
        assert_eq!(terminal.text, "i");
        assert_eq!(terminal.style.extra_char_spacing, 0.0);
        let mut offset = 0usize;
        let start = runs[0].0;
        let mut expected = 0i32;
        for (x, _, run) in &runs {
            assert!((x - start - f64::from(expected) / 75.0).abs() < 0.02);
            assert_eq!(run.char_start, Some(offset));
            for _ in run.text.chars() {
                expected += natural[offset] + if offset + 1 == natural.len() { 0 } else { gap };
                offset += 1;
            }
            if run.text != "i" {
                assert!((run.style.extra_char_spacing - f64::from(gap) / 75.0).abs() < 1e-6);
            }
        }
        let last = runs.last().unwrap();
        let span = last.0 + last.1 - start;
        assert!((span - f64::from(expected) / 75.0).abs() < 1e-6);
        if remainder == 0 {
            assert!((span - f64::from(saved_width) / 75.0).abs() < 0.02);
        } else {
            let overrun = span * 75.0 - f64::from(saved_width);
            assert!((overrun - f64::from(remainder)).abs() < 1e-6);
            assert!(overrun > 0.0 && overrun < (natural.len() - 1) as f64);
        }
        // Exercise the public character walk, including a narrow punctuation below its legacy half width.
        let json: serde_json::Value =
            serde_json::from_str(&core.get_page_text_layout_native(0).unwrap()).unwrap();
        let dot = json["runs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|run| run["text"].as_str().is_some_and(|t| t.contains('.')))
            .unwrap();
        let chars: Vec<_> = dot["text"].as_str().unwrap().chars().collect();
        let index = chars.iter().position(|ch| *ch == '.').unwrap();
        let advance =
            dot["charX"][index + 1].as_f64().unwrap() - dot["charX"][index].as_f64().unwrap();
        assert!(advance > 0.0 && advance < f64::from(narrow) / 150.0);
    }
    rhwp::wasm_api::clear_runtime_font_metrics();
}

#[test]
fn unsupported_loaded_contexts_keep_the_legacy_spacing_walk() {
    let text = "가A1.i";
    let natural = widths(text);
    let width = natural.iter().sum::<i32>() - natural[3] * 3;
    for context in [
        Context {
            windows: true,
            ..Default::default()
        },
        Context {
            ms_word: true,
            ..Default::default()
        },
        Context {
            hwp3_lineage: true,
            ..Default::default()
        },
        Context {
            grid: 100,
            ..Default::default()
        },
        Context {
            vertical: 1,
            ..Default::default()
        },
        Context {
            tracking: -4,
            ..Default::default()
        },
        Context {
            positioned: true,
            ..Default::default()
        },
        Context {
            relative_size: true,
            ..Default::default()
        },
        Context {
            control: true,
            ..Default::default()
        },
        Context {
            field: true,
            ..Default::default()
        },
        Context {
            mixed: true,
            ..Default::default()
        },
        Context {
            ordinary_wrap: true,
            ..Default::default()
        },
    ] {
        let (_, runs) = loaded(text, width, context);
        assert!(!runs.is_empty());
        assert!(runs
            .iter()
            .all(|(_, _, run)| !run.style.native_negative_spacing));
    }
    for unsupported in [
        "가\u{0301}A.i",
        "가\u{1100}A.i",
        "가 A.i",
        "가\tA.i",
        "가\u{fb55}A.i",
    ] {
        let (_, runs) = loaded(unsupported, width, Context::default());
        assert!(runs
            .iter()
            .all(|(_, _, run)| !run.style.native_negative_spacing));
    }
    for interval in [
        natural.iter().sum::<i32>(),
        natural.iter().sum::<i32>() + 300,
        20,
    ] {
        let (_, runs) = loaded(text, interval, Context::default());
        assert!(runs
            .iter()
            .all(|(_, _, run)| !run.style.native_negative_spacing));
    }
    rhwp::wasm_api::clear_runtime_font_metrics();
}

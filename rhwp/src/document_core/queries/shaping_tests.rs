use crate::document_core::DocumentCore;
use crate::model::bin_data::BinDataContent;
use crate::model::paragraph::{CharShapeRef, Paragraph};
use crate::model::style::{CharShape, Font};
use serde_json::Value;

const FONT: &[u8] = include_bytes!("../../../tests/fixtures/fonts/RHWPShapingFixture.ttf");

fn document(text: &str) -> DocumentCore {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().unwrap();
    let mut document = core.document.clone();
    document.doc_info.font_faces = vec![
        vec![Font {
            name: "RHWP Shaping Fixture".into(),
            is_embedded: true,
            resolved_bin_data_id: Some(1),
            ..Default::default()
        }];
        7
    ];
    document.doc_info.char_shapes = vec![CharShape {
        font_ids: [0; 7],
        ratios: [100; 7],
        relative_sizes: [100; 7],
        base_size: 1500,
        ..Default::default()
    }];
    document.bin_data_content = vec![BinDataContent {
        id: 1,
        data: FONT.to_vec().into(),
        extension: "ttf".into(),
    }];
    document.sections[0].paragraphs = vec![Paragraph {
        text: text.into(),
        char_count: text.encode_utf16().count() as u32 + 1,
        char_offsets: (0..text.chars().count() as u32).collect(),
        char_shapes: vec![CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        }],
        has_para_text: true,
        ..Default::default()
    }];
    core.set_document(document);
    core
}

fn cursor(core: &DocumentCore, offset: usize) -> Value {
    serde_json::from_str(&core.get_cursor_rect_native(0, 0, offset).unwrap()).unwrap()
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.15,
        "expected {expected}, got {actual}"
    );
}

#[test]
fn embedded_shaping_keeps_caret_selection_and_hit_testing_in_agreement() {
    for (text, width) in [
        ("AV", 24.0),
        ("To", 24.0),
        ("office", 60.0),
        ("e\u{301}", 12.0),
        ("한AV", 44.0),
    ] {
        let core = document(text);
        let start = cursor(&core, 0);
        let end = cursor(&core, text.chars().count());
        let x = start["x"].as_f64().unwrap();
        near(end["x"].as_f64().unwrap() - x, width);
        let rects: Vec<Value> = serde_json::from_str(
            &core
                .get_selection_rects_native(0, 0, 0, 0, text.chars().count(), None, None, true)
                .unwrap(),
        )
        .unwrap();
        near(rects[0]["width"].as_f64().unwrap(), width);
        let hit: Value = serde_json::from_str(
            &core
                .hit_test_native(
                    0,
                    end["x"].as_f64().unwrap() - 0.01,
                    end["y"].as_f64().unwrap() + end["height"].as_f64().unwrap() * 0.5,
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            hit["charOffset"].as_u64(),
            Some(text.chars().count() as u64),
            "{text}: {hit}"
        );
    }
}

#[test]
fn embedded_ligatures_keep_scalar_caret_boundaries() {
    let core = document("office");
    let positions = (0..=6)
        .map(|offset| cursor(&core, offset)["x"].as_f64().unwrap())
        .collect::<Vec<_>>();
    near(positions[2] - positions[1], 8.0);
    near(positions[3] - positions[2], 8.0);
    near(positions[4] - positions[3], 8.0);
    let accented = document("e\u{301}");
    near(
        cursor(&accented, 1)["x"].as_f64().unwrap(),
        cursor(&accented, 2)["x"].as_f64().unwrap(),
    );
}

#[test]
fn embedded_font_kerning_and_clusters_share_measurement_geometry() {
    use crate::renderer::layout::{compute_char_positions, estimate_text_width_unrounded};
    use crate::renderer::TextStyle;

    let core = document("AV");
    let _scope = core.resolved_shaping_font_scope();
    let style = TextStyle {
        font_family: "RHWP Shaping Fixture".into(),
        font_size: 20.0,
        kerning: true,
        ..Default::default()
    };
    for (text, expected) in [
        ("AV", 20.0),
        ("To", 22.0),
        ("office", 60.0),
        ("e\u{301}", 12.0),
        ("한AV", 40.0),
    ] {
        let positions = compute_char_positions(text, &style);
        assert_eq!(positions.len(), text.chars().count() + 1);
        near(*positions.last().unwrap(), expected);
        near(estimate_text_width_unrounded(text, &style), expected);
        let equation =
            crate::renderer::equation::layout::EqLayout::with_font(20.0, "RHWP Shaping Fixture")
                .layout(&crate::renderer::equation::ast::EqNode::Text(text.into()));
        near(equation.width, expected);
    }
}

#[test]
fn embedded_ligature_advance_controls_line_fitting() {
    let mut core = document("office office");
    let mut source = core.document.clone();
    let page = &mut source.sections[0].section_def.page_def;
    page.width = 4800;
    page.margin_left = 0;
    page.margin_right = 0;
    page.margin_gutter = 0;
    core.set_document(source);

    let first = cursor(&core, 0);
    let first_word_last_character = cursor(&core, 5);
    let second_word_end = cursor(&core, 13);
    near(
        first_word_last_character["y"].as_f64().unwrap(),
        first["y"].as_f64().unwrap(),
    );
    assert!(second_word_end["y"].as_f64().unwrap() > first["y"].as_f64().unwrap());
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn embedded_font_space_context_matches_load_refresh_edit_and_reopen() {
    use crate::model::paragraph::LineSeg;
    use crate::model::provenance::FontMetricsPolicy;
    use crate::renderer::layout::{resolved_to_text_style, source_font_space_advance_px};

    const FAMILY: &str = "RHWP Embedded Space Context";
    // 이 테스트는 외부 설치·runtime 등록을 하지 않는다. BinData만 공급자다.
    assert!(!crate::renderer::runtime_font_metrics::face_available(
        FAMILY
    ));
    assert!(!crate::renderer::font_paths::custom_font_face_available(
        FAMILY
    ));
    let mut model = document("A 한").document;
    // 단일 SFNT face는 문서 선언 별칭으로 해소된다(font_glyph.rs).
    // 다른 테스트가 등록한 실제 fixture family가 임베드 공급자를 가리지 않게 한다.
    for fonts in &mut model.doc_info.font_faces {
        for font in fonts {
            font.name = FAMILY.into();
        }
    }
    model.doc_info.font_metrics_policy = FontMetricsPolicy::HcrDeclared;
    let cs = &mut model.doc_info.char_shapes[0];
    cs.base_size = 1150;
    cs.relative_sizes = [100, 106, 100, 100, 100, 100, 100];
    cs.ratios = [95, 100, 100, 100, 100, 100, 100];
    cs.spacings = [0; 7];
    cs.use_font_space = true;
    cs.bold = false;
    cs.italic = false;
    cs.kerning = false;
    model.sections[0].paragraphs[0].line_segs = vec![LineSeg {
        text_start: 0,
        line_height: 1600,
        text_height: 1150,
        baseline_distance: 1000,
        segment_width: 40000,
        ..Default::default()
    }];
    let mut unrelated = model.sections[0].paragraphs[0].clone();
    unrelated.text = "한".into();
    unrelated.char_count = 2;
    unrelated.char_offsets = vec![0];
    unrelated.line_segs[0].vertical_pos = 1600;
    model.sections[0].paragraphs.push(unrelated);

    fn check(core: &DocumentCore, font_type: u8, stage: &str) -> (f64, f64) {
        assert!(!core.collect_resolved_shaping_fonts().is_empty());
        let space = core.composed[0][0]
            .lines
            .iter()
            .flat_map(|line| &line.runs)
            .find(|run| run.text.contains(' '))
            .unwrap();
        assert_eq!(space.lang_index, 1);
        let _scope = core.resolved_shaping_font_scope();
        let style = resolved_to_text_style(&core.styles, 0, space.lang_index);
        assert_eq!(style.font_family.split(',').next().unwrap().trim(), FAMILY);
        let width = source_font_space_advance_px(' ', &style).unwrap();
        assert!((width * 75.0 - 304.0).abs() < 1e-9);
        let before = cursor(core, 1)["x"].as_f64().unwrap();
        let after = cursor(core, 2)["x"].as_f64().unwrap();
        fn painted_space(node: &crate::renderer::render_tree::RenderNode) -> Option<(f64, f64)> {
            use crate::renderer::render_tree::RenderNodeType;
            if let RenderNodeType::TextRun(run) = &node.node_type {
                if run.section_index == Some(0)
                    && run.para_index == Some(0)
                    && run.cell_context.is_none()
                {
                    if let Some(start) = run.char_start.filter(|&start| start <= 1) {
                        let offset = 1 - start;
                        if run.text.chars().nth(offset) == Some(' ') {
                            let positions = crate::renderer::layout::compute_char_positions(
                                &run.text, &run.style,
                            );
                            return Some((
                                node.bbox.x + positions[offset],
                                node.bbox.x + positions[offset + 1],
                            ));
                        }
                    }
                }
            }
            node.children.iter().find_map(painted_space)
        }
        let tree = core.build_page_render_tree(0).unwrap();
        let (paint_before, paint_after) =
            painted_space(&tree.root).expect("actual space render node");
        assert!((paint_after - paint_before - width).abs() < 0.01,
            "font_type={font_type} stage={stage} paint_before={paint_before} paint_after={paint_after} expected={width}");
        // 공개 커서 JSON은 각 끝점을 소수 한 자리로 직렬화한다(cursor_rect.rs).
        // 차이의 허용치를 늘리는 대신 실제 paint 끝점에 같은 직렬화를 적용한다.
        let public_x = |x: f64| format!("{x:.1}").parse::<f64>().unwrap();
        assert_eq!(
            before,
            public_x(paint_before),
            "font_type={font_type} stage={stage}"
        );
        assert_eq!(
            after,
            public_x(paint_after),
            "font_type={font_type} stage={stage}"
        );
        (before, after)
    }

    // HFT로 선언된 materialized SFNT도 paginate 재해소 뒤 다시 분류한다.
    for font_type in [1, 2] {
        for fonts in &mut model.doc_info.font_faces {
            fonts[0].alt_type = font_type;
        }
        let bytes = crate::serializer::hwpx::serialize_hwpx(&model).unwrap();
        let mut loaded =
            DocumentCore::from_bytes_with_font_metrics(&bytes, FontMetricsPolicy::HcrDeclared)
                .unwrap();
        let original = format!("{:?}", loaded.document.sections[0].paragraphs[0]);
        let initial = check(&loaded, font_type, "load");
        loaded.refresh_layout_native();
        assert_eq!(check(&loaded, font_type, "refresh"), initial);
        loaded.insert_text_native(0, 1, 1, " ").unwrap();
        assert_eq!(check(&loaded, font_type, "edit"), initial);
        let saved = loaded.export_hwpx_native().unwrap();
        assert_eq!(
            format!("{:?}", loaded.document.sections[0].paragraphs[0]),
            original
        );
        let reopened =
            DocumentCore::from_bytes_with_font_metrics(&saved, FontMetricsPolicy::HcrDeclared)
                .unwrap();
        assert_eq!(check(&reopened, font_type, "reopen"), initial);
    }
}

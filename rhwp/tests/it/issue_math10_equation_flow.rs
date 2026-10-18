//! Windows 수식 줄은 전체 점유 높이 H와 비율 간격 기준 B를 따로 유지한다.
//! round11 P11-01/02의 원본 바이트 계약. 네이티브 실행 실측값은 아니다.

use rhwp::document_core::DocumentCore;
use rhwp::model::control::{Control, Equation};
use rhwp::model::document::{Document, Section};
use rhwp::model::paragraph::{CharShapeRef, LineSeg, Paragraph};
use rhwp::model::provenance::{FontMetricsPolicy, SourceFormat};
use rhwp::model::style::{CharShape, ParaShape};
use rhwp::renderer::composer::compose_paragraph;
use rhwp::renderer::render_tree::{BoundingBox, RenderNode, RenderNodeType};

fn document(mixed: bool, affect: bool, height: u32, baseline: i16) -> Document {
    let mut eq = Equation::default();
    eq.version_info = "Equation Version 60".into();
    eq.font_name = "HYhwpEQ".into();
    eq.script = "x over y".into();
    eq.font_size = 1000;
    eq.baseline = baseline;
    eq.common.treat_as_char = true;
    eq.common.affect_line_spacing = affect;
    eq.common.width = 1000;
    eq.common.height = height;
    // 원본 서체 설치 유무와 무관하게 개체 둘이 서로 다른 줄을 차지하게 한다.
    eq.common.margin.left = 2500;
    eq.common.margin.right = 2500;
    let para = Paragraph {
        text: if mixed { "A\nB".into() } else { String::new() },
        char_offsets: if mixed { vec![8, 9, 10] } else { vec![] },
        char_count: if mixed { 12 } else { 17 },
        controls: if mixed {
            vec![Control::Equation(Box::new(eq))]
        } else {
            vec![
                Control::Equation(Box::new(eq.clone())),
                Control::Equation(Box::new(eq)),
            ]
        },
        char_shapes: vec![CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        }],
        // 로드의 공개 재조판 경로를 타는 미계산 줄이다.
        line_segs: vec![LineSeg {
            tag: LineSeg::TAG_IMPLEMENTATION_PROPERTY,
            ..Default::default()
        }],
        ..Default::default()
    };
    let mut section = Section::default();
    section.section_def.page_def = rhwp::model::page::PageDef {
        width: 10000,
        height: 30000,
        margin_left: 1000,
        margin_right: 1000,
        margin_top: 1000,
        margin_bottom: 1000,
        ..Default::default()
    };
    section.paragraphs.push(para);
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
    doc.sections.push(section);
    doc
}

fn load(doc: &Document, policy: FontMetricsPolicy) -> DocumentCore {
    let bytes = rhwp::serializer::hwpx::serialize_hwpx(doc).expect("합성 HWPX 저장");
    DocumentCore::from_bytes_with_font_metrics(&bytes, policy).expect("공개 로드/재조판")
}

fn lines(node: &RenderNode, out: &mut Vec<(u32, BoundingBox, f64)>) {
    if let RenderNodeType::TextLine(line) = &node.node_type {
        if line.para_index == Some(0) {
            out.push((
                line.line_index.expect("줄 인덱스"),
                node.bbox,
                line.baseline,
            ));
        }
    }
    for child in &node.children {
        lines(child, out);
    }
}

fn equations(node: &RenderNode, out: &mut Vec<BoundingBox>) {
    if let RenderNodeType::Equation(_) = &node.node_type {
        out.push(node.bbox);
    }
    for child in &node.children {
        equations(child, out);
    }
}

fn assert_rendered_pitch(core: &DocumentCore, pitch: i32, equation_only: bool) {
    let tree = core.build_page_render_tree(0).expect("첫 쪽 렌더 트리");
    let mut rendered = vec![];
    lines(&tree.root, &mut rendered);
    rendered.sort_by_key(|line| line.0);
    assert_eq!(rendered.len(), 2, "{rendered:?}");
    let hu = |value| rhwp::renderer::hwpunit_to_px(value, 96.0);
    assert!(
        (rendered[0].1.height - hu(2400)).abs() < 0.02,
        "{rendered:?}"
    );
    assert!(
        (rendered[1].1.y - rendered[0].1.y - hu(pitch)).abs() < 0.02,
        "{rendered:?}"
    );
    if equation_only {
        let mut objects = vec![];
        equations(&tree.root, &mut objects);
        objects.sort_by(|a, b| a.y.total_cmp(&b.y));
        assert_eq!(objects.len(), 2, "{objects:?}");
        assert!(
            (objects[1].y - objects[0].y - hu(pitch)).abs() < 0.02,
            "수식 원점 간격: {objects:?}"
        );
    }
}

#[test]
fn fresh_percent_flow_keeps_full_height_and_changes_only_spacing_basis() {
    for mixed in [false, true] {
        for (affect, spacing) in [(false, 600), (true, 1440)] {
            let core = load(
                &document(mixed, affect, 2400, 85),
                FontMetricsPolicy::HancomWindows,
            );
            let p = &core.document().sections[0].paragraphs[0];
            assert_eq!(p.line_segs.len(), 2, "mixed={mixed} affect={affect}");
            let first = &p.line_segs[0];
            assert_eq!(
                (
                    first.line_height,
                    first.text_height,
                    first.baseline_distance
                ),
                (2400, 2400, 2040),
                "mixed={mixed} affect={affect}"
            );
            assert_eq!(first.line_spacing, spacing, "mixed={mixed} affect={affect}");
            assert_eq!(
                p.line_segs[1].vertical_pos - first.vertical_pos,
                2400 + spacing
            );
            let composed = compose_paragraph(p);
            assert_eq!(composed.lines[0].line_height, 2400);
            assert_eq!(composed.lines[0].line_spacing, spacing);
            assert_rendered_pitch(&core, 2400 + spacing, !mixed);
        }
    }
}

#[test]
fn mixed_line_uses_larger_control_slot_style_for_unaffected_spacing() {
    for (affect, spacing) in [(false, 960), (true, 1440)] {
        let mut doc = document(true, affect, 2400, 85);
        let mut control_style = doc.doc_info.char_shapes[0].clone();
        control_style.base_size = 1600;
        doc.doc_info.char_shapes.push(control_style);
        // 수식은 UTF-16 [0,8)의 1600 HU 스타일, 가시 A/줄바꿈/B는 1000 HU다.
        doc.sections[0].paragraphs[0].char_shapes = vec![
            CharShapeRef {
                start_pos: 0,
                char_shape_id: 1,
            },
            CharShapeRef {
                start_pos: 8,
                char_shape_id: 0,
            },
        ];
        let core = load(&doc, FontMetricsPolicy::HancomWindows);
        let p = &core.document().sections[0].paragraphs[0];
        assert_eq!(p.line_segs.len(), 2);
        assert_eq!(p.line_segs[0].line_height, 2400);
        assert_eq!(p.line_segs[0].baseline_distance, 2040);
        assert_eq!(p.line_segs[0].line_spacing, spacing, "affect={affect}");
        assert_eq!(
            p.line_segs[1].vertical_pos - p.line_segs[0].vertical_pos,
            2400 + spacing
        );
        assert_rendered_pitch(&core, 2400 + spacing, false);
    }
}

#[test]
fn fresh_line_baseline_rounds_full_placement_height_once() {
    for (height, top, bottom, expected_height, expected_baseline) in
        [(1001, 0, 0, 1001, 851), (1000, 100, 300, 1400, 1190)]
    {
        let mut doc = document(true, false, height, 85);
        let Control::Equation(eq) = &mut doc.sections[0].paragraphs[0].controls[0] else {
            unreachable!()
        };
        eq.common.margin.top = top;
        eq.common.margin.bottom = bottom;
        let core = load(&doc, FontMetricsPolicy::HancomWindows);
        let p = &core.document().sections[0].paragraphs[0];
        assert_eq!(
            (p.line_segs[0].line_height, p.line_segs[0].baseline_distance),
            (expected_height, expected_baseline)
        );
        let mut rendered = vec![];
        lines(&core.build_page_render_tree(0).unwrap().root, &mut rendered);
        let first = rendered.iter().find(|line| line.0 == 0).expect("첫 줄");
        assert!(
            (first.2 - rhwp::renderer::hwpunit_to_px(expected_baseline, 96.0)).abs() < 0.02,
            "{rendered:?}"
        );
    }
}

#[test]
fn missing_stored_height_keeps_the_full_natural_box_for_both_flags() {
    let mut heights = vec![];
    for affect in [false, true] {
        let core = load(
            &document(true, affect, 0, 85),
            FontMetricsPolicy::HancomWindows,
        );
        let p = &core.document().sections[0].paragraphs[0];
        let first = &p.line_segs[0];
        assert!(first.line_height > 1000, "분수의 전체 높이: {first:?}");
        heights.push((first.line_height, first.baseline_distance));
        assert_eq!(
            p.line_segs[1].vertical_pos - first.vertical_pos,
            first.text_height + first.line_spacing
        );
    }
    assert_eq!(
        heights[0], heights[1],
        "플래그는 높이/기준선을 바꾸지 않는다"
    );
}

#[test]
fn percent_rounding_stays_on_the_equation_basis_grid() {
    for (percent, expected_spacing) in [(0, -1000), (60, -400), (115, 152), (160, 600)] {
        let mut doc = document(true, false, 2400, 85);
        doc.doc_info.char_shapes[0].base_size = 1001;
        doc.doc_info.para_shapes[0].line_spacing = percent;
        let core = load(&doc, FontMetricsPolicy::HancomWindows);
        let p = &core.document().sections[0].paragraphs[0];
        assert_eq!(p.line_segs[0].line_spacing, expected_spacing, "{percent}%");
        assert_eq!(
            p.line_segs[1].vertical_pos - p.line_segs[0].vertical_pos,
            2400 + expected_spacing
        );
    }
}

#[test]
fn authored_equation_line_geometry_survives_read_only_render() {
    let mut doc = document(true, false, 2400, 85);
    let p = &mut doc.sections[0].paragraphs[0];
    p.line_segs = vec![
        LineSeg {
            text_start: 0,
            line_height: 2600,
            text_height: 2600,
            baseline_distance: 2101,
            line_spacing: 599,
            segment_width: 8000,
            tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
            ..Default::default()
        },
        LineSeg {
            text_start: 10,
            vertical_pos: 3199,
            line_height: 1000,
            text_height: 1000,
            baseline_distance: 850,
            line_spacing: 600,
            segment_width: 8000,
            tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
            ..Default::default()
        },
    ];
    let core = load(&doc, FontMetricsPolicy::HancomWindows);
    let before = core.document().sections[0].paragraphs[0].line_segs.clone();
    let mut rendered = vec![];
    lines(&core.build_page_render_tree(0).unwrap().root, &mut rendered);
    let first = rendered
        .iter()
        .find(|line| line.0 == 0)
        .expect("저장 첫 줄");
    assert!((first.2 - rhwp::renderer::hwpunit_to_px(2101, 96.0)).abs() < 0.02);
    let after = &core.document().sections[0].paragraphs[0].line_segs;
    let geometry = |s: &LineSeg| {
        (
            s.vertical_pos,
            s.line_height,
            s.text_height,
            s.baseline_distance,
            s.line_spacing,
            s.tag,
        )
    };
    assert_eq!(
        before.iter().map(geometry).collect::<Vec<_>>(),
        after.iter().map(geometry).collect::<Vec<_>>()
    );
}

#[test]
fn mac_and_legacy_keep_existing_percentage_basis() {
    for (policy, legacy) in [
        (FontMetricsPolicy::HcrDeclared, false),
        (FontMetricsPolicy::HancomWindows, true),
    ] {
        let mut doc = document(true, true, 2400, 85);
        if legacy {
            let Control::Equation(eq) = &mut doc.sections[0].paragraphs[0].controls[0] else {
                unreachable!()
            };
            eq.version_info.clear();
        }
        let core = load(&doc, policy);
        let first = &core.document().sections[0].paragraphs[0].line_segs[0];
        assert_eq!(
            (
                first.line_height,
                first.baseline_distance,
                first.line_spacing
            ),
            (2400, 2040, 600)
        );
    }
}

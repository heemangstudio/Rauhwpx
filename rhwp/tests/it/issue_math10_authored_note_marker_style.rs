//! 참조 번호는 가시 본문이 아닌 원본 8-unit 제어 슬롯의 글자 모양을 따른다.
use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::paint::{LayerBuilder, RenderProfile};
use rhwp::parser::{body_text::parse_body_text_section, tags};
use rhwp::renderer::render_tree::{PageRenderTree, RenderNode, RenderNodeType};
#[cfg(feature = "native-skia")]
use rhwp::renderer::svg::SvgRenderer;
use serde_json::Value;

#[derive(Clone, Copy)]
enum Slot {
    Note(u32),
    Footnote(u32),
    Equation,
    Unknown,
}

fn record(out: &mut Vec<u8>, tag: u16, level: u16, data: &[u8]) {
    let header = u32::from(tag) | (u32::from(level) << 10) | ((data.len() as u32) << 20);
    out.extend(header.to_le_bytes());
    out.extend(data);
}

fn raw_paragraph(prefix: &str, slots: &[Slot], suffix: &str, level: u16) -> Vec<u8> {
    let mut text = Vec::new();
    let mut shapes = vec![(0u32, if level == 0 { 1u32 } else { 3u32 })];
    let mut controls = Vec::new();
    for unit in prefix.encode_utf16() {
        text.extend(unit.to_le_bytes());
    }
    let mut number = 1u32;
    for slot in slots {
        let (id, code, style) = match slot {
            Slot::Note(style) => (tags::CTRL_ENDNOTE, 0x11u16, *style),
            Slot::Footnote(style) => (tags::CTRL_FOOTNOTE, 0x11u16, *style),
            Slot::Equation => (tags::CTRL_EQUATION, 0x0bu16, 1),
            Slot::Unknown => (u32::from_le_bytes(*b"????"), 0x0bu16, 1),
        };
        shapes.push(((text.len() / 2) as u32, style));
        text.extend(code.to_le_bytes());
        text.extend(id.to_le_bytes());
        text.extend([0u8; 8]);
        text.extend(code.to_le_bytes());
        let mut payload = id.to_le_bytes().to_vec();
        match slot {
            Slot::Note(_) | Slot::Footnote(_) => {
                payload.extend(number.to_le_bytes());
                payload.extend(0u16.to_le_bytes());
                payload.extend((']' as u16).to_le_bytes());
                payload.extend(0u32.to_le_bytes());
                record(&mut controls, tags::HWPTAG_CTRL_HEADER, level + 1, &payload);
                let mut list = vec![0; 16];
                list[..4].copy_from_slice(&1u32.to_le_bytes());
                record(&mut controls, tags::HWPTAG_LIST_HEADER, level + 2, &list);
                controls.extend(raw_paragraph("NOTE", &[], "", level + 2));
                number += 1;
            }
            Slot::Equation => {
                // TAC, y/x, 폭/높이, z, 여백. 검은 x 수식은 참조 뒤에도 그대로 남는다.
                for value in [1u32, 0, 0, 1200, 1000, 0, 0, 0, 0] {
                    payload.extend(value.to_le_bytes());
                }
                record(&mut controls, tags::HWPTAG_CTRL_HEADER, level + 1, &payload);
                let mut eq = 0u32.to_le_bytes().to_vec();
                eq.extend(1u16.to_le_bytes());
                eq.extend(('x' as u16).to_le_bytes());
                eq.extend(1000u32.to_le_bytes());
                eq.extend(0u32.to_le_bytes());
                eq.extend(80i16.to_le_bytes());
                eq.extend([0; 6]);
                record(&mut controls, tags::HWPTAG_EQEDIT, level + 2, &eq);
            }
            Slot::Unknown => {
                record(&mut controls, tags::HWPTAG_CTRL_HEADER, level + 1, &payload);
            }
        }
    }
    if !suffix.is_empty() {
        shapes.push(((text.len() / 2) as u32, 1));
    }
    for unit in suffix.encode_utf16().chain(std::iter::once(0x0d)) {
        text.extend(unit.to_le_bytes());
    }
    let mut header = vec![0u8; 22];
    header[..4].copy_from_slice(&((text.len() / 2) as u32).to_le_bytes());
    header[12..14].copy_from_slice(&(shapes.len() as u16).to_le_bytes());
    header[16..18].copy_from_slice(&1u16.to_le_bytes());
    let mut out = Vec::new();
    record(&mut out, tags::HWPTAG_PARA_HEADER, level, &header);
    record(&mut out, tags::HWPTAG_PARA_TEXT, level + 1, &text);
    let mut refs = Vec::new();
    for (pos, id) in shapes {
        refs.extend(pos.to_le_bytes());
        refs.extend(id.to_le_bytes());
    }
    record(&mut out, tags::HWPTAG_PARA_CHAR_SHAPE, level + 1, &refs);
    let line: Vec<_> = [0i32, 0, 1200, 1200, 1000, 600, 0, 30000, 0]
        .into_iter()
        .flat_map(i32::to_le_bytes)
        .collect();
    record(&mut out, tags::HWPTAG_PARA_LINE_SEG, level + 1, &line);
    out.extend(controls);
    out
}

fn document(prefix: &str, slots: &[Slot], marker_color: u32, marker_size: i32) -> DocumentCore {
    let bytes = raw_paragraph(prefix, slots, "Z", 0);
    let parsed = parse_body_text_section(&bytes).expect("parse synthetic raw HWP records");
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().unwrap();
    let doc = core.document_mut();
    let body = doc.doc_info.char_shapes[0].clone();
    doc.doc_info.char_shapes = (0..4)
        .map(|id| {
            let mut style = body.clone();
            style.raw_data = None;
            style.base_size = match id {
                0 => marker_size,
                2 => 200,
                3 => 1000,
                _ => 1150,
            };
            style.text_color = if id == 0 { marker_color } else { 0 };
            style.bold = id == 2;
            style.ratios = [100; 7];
            style.relative_sizes = [100; 7];
            style.spacings = [0; 7];
            style.superscript = false;
            style.subscript = false;
            style
        })
        .collect();
    doc.provenance = Default::default();
    doc.sections[0].paragraphs = parsed.paragraphs;
    doc.sections[0].raw_stream = Some(bytes);
    let source = source_snapshot(&core);
    core.refresh_layout_native();
    assert_eq!(
        source_snapshot(&core),
        source,
        "render refresh must preserve raw source and stored lines"
    );
    core
}

fn nodes(node: &RenderNode) -> Vec<&RenderNode> {
    let mut out = vec![node];
    for child in &node.children {
        out.extend(nodes(child));
    }
    out
}

fn markers(tree: &PageRenderTree) -> Vec<&RenderNode> {
    nodes(&tree.root)
        .into_iter()
        .filter(|n| matches!(n.node_type, RenderNodeType::FootnoteMarker(_)))
        .collect()
}

fn json_markers(value: &Value) -> Vec<&Value> {
    match value {
        Value::Object(map) => {
            let mut out = Vec::new();
            if map.get("type").and_then(Value::as_str) == Some("footnoteMarker") {
                out.push(value);
            }
            for child in map.values() {
                out.extend(json_markers(child));
            }
            out
        }
        Value::Array(values) => values.iter().flat_map(json_markers).collect(),
        _ => Vec::new(),
    }
}

fn source_snapshot(core: &DocumentCore) -> String {
    // 참조 스타일, raw offsets, 저장 LINE_SEG, 주석 본문과 수식까지 비교한다.
    format!(
        "{:?}/{:?}",
        core.document().sections,
        core.document().doc_info.char_shapes
    )
}

#[test]
fn raw_white_one_point_note_keeps_black_body_equation_and_source() {
    let core = document("", &[Slot::Note(0), Slot::Equation], 0x00ff_ffff, 100);
    let para = &core.document().sections[0].paragraphs[0];
    assert_eq!(para.char_offsets, vec![16]);
    assert!(matches!(para.controls[0], Control::Endnote(_)));
    assert!(matches!(para.controls[1], Control::Equation(_)));
    let source = source_snapshot(&core);
    let tree = core.build_page_render_tree(0).unwrap();
    let found = markers(&tree);
    assert_eq!(found.len(), 1);
    let RenderNodeType::FootnoteMarker(marker) = &found[0].node_type else {
        unreachable!()
    };
    assert_eq!(marker.text, "1]");
    assert_eq!(marker.color, 0x00ff_ffff);
    assert!((marker.base_font_size - 4.0 / 3.0).abs() < 0.001);
    assert!((marker.font_size - 1.0).abs() < 0.001);
    assert!(found[0].visible && found[0].bbox.width > 0.0 && found[0].bbox.width < 2.0);
    let all = nodes(&tree.root);
    let body = all
        .iter()
        .find(|n| matches!(&n.node_type, RenderNodeType::TextRun(r) if r.text == "Z"))
        .unwrap();
    let equation = all
        .iter()
        .find(|n| matches!(&n.node_type, RenderNodeType::Equation(_)))
        .unwrap();
    assert!(equation.bbox.x >= found[0].bbox.x + found[0].bbox.width - 0.1);
    assert!(body.bbox.x > equation.bbox.x);
    if let RenderNodeType::TextRun(run) = &body.node_type {
        assert_eq!(run.style.color, 0);
    }
    assert!(all.iter().any(|n| matches!(&n.node_type, RenderNodeType::TextRun(r) if r.text.contains("NOTE") && r.style.color == 0 && r.style.font_size > 10.0)));

    let layer = LayerBuilder::new(RenderProfile::Print).build(&tree);
    let json: Value = serde_json::from_str(&layer.to_json()).unwrap();
    let painted = json_markers(&json);
    assert_eq!(painted.len(), 1);
    assert_eq!(painted[0]["text"], "1]");
    assert_eq!(painted[0]["color"], "#ffffff");
    assert!((painted[0]["fontSize"].as_f64().unwrap() - marker.font_size).abs() < 0.001);
    assert!((painted[0]["bbox"]["width"].as_f64().unwrap() - found[0].bbox.width).abs() < 0.001);
    let svg = core.render_page_svg_native(0).unwrap();
    let tag = svg
        .split("<text ")
        .skip(1)
        .find(|tag| tag.contains(">1]</text>"))
        .unwrap();
    assert!(
        tag.contains("font-size=\"1\"") && tag.contains("fill=\"#ffffff\""),
        "{tag}"
    );
    assert_eq!(source_snapshot(&core), source);
}

#[test]
fn footnote_reference_uses_its_slot_without_changing_note_content() {
    let core = document("A", &[Slot::Footnote(0)], 0xffffff, 100);
    let tree = core.build_page_render_tree(0).unwrap();
    let found = markers(&tree);
    assert_eq!(found.len(), 1);
    let RenderNodeType::FootnoteMarker(marker) = &found[0].node_type else {
        unreachable!()
    };
    assert_eq!(marker.text, "1]");
    assert_eq!(marker.color, 0xffffff);
    assert!((marker.font_size - 1.0).abs() < 0.001);
    assert!(nodes(&tree.root).iter().any(|node| matches!(&node.node_type,
        RenderNodeType::TextRun(run) if run.text.contains("NOTE") && run.style.color == 0 && run.style.font_size > 10.0)));
}

#[test]
fn consecutive_midparagraph_notes_keep_distinct_raw_styles_around_equation() {
    let core = document(
        "A😀",
        &[Slot::Note(0), Slot::Note(2), Slot::Equation, Slot::Note(0)],
        0xffffff,
        100,
    );
    let para = &core.document().sections[0].paragraphs[0];
    assert_eq!(para.char_offsets, vec![0, 1, 35]);
    let tree = core.build_page_render_tree(0).unwrap();
    let found = markers(&tree);
    assert_eq!(found.len(), 3);
    for (index, node) in found.iter().enumerate() {
        let RenderNodeType::FootnoteMarker(marker) = &node.node_type else {
            unreachable!()
        };
        assert_eq!(marker.text, format!("{}]", index + 1));
        assert_eq!(marker.color, if index == 1 { 0 } else { 0xffffff });
        assert!((marker.font_size - if index == 1 { 2.0 } else { 1.0 }).abs() < 0.001);
        assert_eq!(marker.bold, index == 1);
    }
    assert!((found[1].bbox.x - found[0].bbox.x - found[0].bbox.width).abs() < 0.1);
    let all = nodes(&tree.root);
    let equation = all
        .iter()
        .find(|n| matches!(n.node_type, RenderNodeType::Equation(_)))
        .unwrap();
    assert!(equation.bbox.x >= found[1].bbox.x + found[1].bbox.width - 0.1);
    assert!(found[2].bbox.x > equation.bbox.x);
}

#[test]
fn visible_small_black_reference_and_white_reference_reserve_identical_advance() {
    let render = |color, size| {
        document("", &[Slot::Note(0), Slot::Equation], color, size)
            .build_page_render_tree(0)
            .unwrap()
    };
    let white = render(0xffffff, 100);
    let black = render(0, 100);
    let large = render(0, 1000);
    let w = markers(&white)[0];
    let b = markers(&black)[0];
    let l = markers(&large)[0];
    assert!((w.bbox.width - b.bbox.width).abs() < 0.001);
    assert!(l.bbox.width > b.bbox.width * 5.0);
    let origin = |tree: &PageRenderTree| {
        nodes(&tree.root)
            .into_iter()
            .find(|n| matches!(n.node_type, RenderNodeType::Equation(_)))
            .unwrap()
            .bbox
            .x
    };
    assert!((origin(&white) - origin(&black)).abs() < 0.001);
    assert!((origin(&large) - origin(&black) - (l.bbox.width - b.bbox.width)).abs() < 0.1);
}

#[test]
fn unsupported_or_ambiguous_control_slots_keep_legacy_style_and_floor() {
    for mode in 0..3 {
        let mut core = document("", &[Slot::Unknown, Slot::Note(0)], 0xffffff, 100);
        if mode == 1 {
            // 미지원 제어를 빼도 16-unit 갭과 제어 한 개는 정확히 대응하지 않는다.
            core.document_mut().sections[0].paragraphs[0]
                .controls
                .remove(0);
        }
        if mode == 2 {
            core.document_mut().sections[0].paragraphs[0]
                .char_offsets
                .clear();
        }
        core.document_mut().doc_info.char_shapes[1].base_size = 100;
        core.refresh_layout_native();
        let tree = core.build_page_render_tree(0).unwrap();
        let found = markers(&tree);
        assert_eq!(found.len(), 1);
        let RenderNodeType::FootnoteMarker(marker) = &found[0].node_type else {
            unreachable!()
        };
        assert_eq!(marker.color, 0);
        assert!((marker.font_size - 7.0).abs() < 0.001);
    }
}

#[cfg(feature = "native-skia")]
#[test]
fn small_white_marker_is_painted_on_color_and_native_uses_final_size() {
    use rhwp::renderer::layer_renderer::RasterRenderOptions;
    use rhwp::renderer::render_tree::{BoundingBox, PageBackgroundNode};
    use rhwp::renderer::skia::SkiaLayerRenderer;
    for (color, background) in [(0xffffff, 0x00ff_0000), (0, 0xffffff)] {
        let core = document("", &[Slot::Note(0)], color, 100);
        let tree = core.build_page_render_tree(0).unwrap();
        let original = markers(&tree)[0];
        let mut isolated = PageRenderTree::new(0, 20.0, 20.0);
        isolated.root.children.push(RenderNode::new(
            1,
            RenderNodeType::PageBackground(PageBackgroundNode {
                background_color: Some(background),
                border_color: None,
                border_width: 0.0,
                gradient: None,
                image: None,
            }),
            BoundingBox::new(0.0, 0.0, 20.0, 20.0),
        ));
        let mut marker_node = original.clone();
        marker_node.bbox.x = 5.0;
        marker_node.bbox.y = 5.0;
        if let RenderNodeType::FootnoteMarker(marker) = &mut marker_node.node_type {
            marker.baseline = 3.0;
        }
        isolated.root.children.push(marker_node);
        let mut svg = SvgRenderer::new();
        svg.render_tree(&isolated);
        assert!(svg.output().contains(">1]</text>"));
        let render = |tree: &PageRenderTree| {
            let layer = LayerBuilder::new(RenderProfile::Print).build(tree);
            let output = SkiaLayerRenderer::new()
                .render_raster_with_options(
                    &layer,
                    RasterRenderOptions {
                        scale: 16.0,
                        ..Default::default()
                    },
                )
                .unwrap();
            image::load_from_memory(&output.bytes).unwrap().to_rgba8()
        };
        let image = render(&isolated);
        let ink = image
            .pixels()
            .filter(|p| {
                if color == 0 {
                    p[0] < 180 && p[1] < 180 && p[2] < 180
                } else {
                    p[0] > 80 && p[1] > 80 && p[2] > 180
                }
            })
            .count();
        assert!(
            ink > 0,
            "small authored marker must paint, including white on blue"
        );

        let RenderNodeType::FootnoteMarker(marker) = &isolated.root.children[1].node_type else {
            unreachable!()
        };
        let mut expected_run = nodes(&tree.root)
            .into_iter()
            .find_map(|node| match &node.node_type {
                RenderNodeType::TextRun(run) if run.text == "Z" => Some(run.clone()),
                _ => None,
            })
            .unwrap();
        expected_run.text = "1]".into();
        expected_run.style = rhwp::renderer::TextStyle {
            font_family: marker.font_family.clone(),
            font_size: 1.0,
            color,
            bold: marker.bold,
            ..Default::default()
        };
        expected_run.baseline = 3.0 - (4.0 / 3.0 - 1.0) * 0.85;
        expected_run.is_para_end = false;
        expected_run.is_line_break_end = false;
        let mut expected = isolated.clone();
        expected.root.children[1].node_type = RenderNodeType::TextRun(expected_run);
        assert_eq!(
            image,
            render(&expected),
            "native marker must match 1px text without another scale or minimum"
        );
    }
}

//! 저장 제목 프레임의 예약 경계를 실제 단 구분선에 적용하는 공개 동작 계약.
//! 독립 작성 IR/CFB만 사용한다. 다른 테스트 모듈, 외부 문서나 설치 서체에 의존하지 않는다.

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::document::{Document, Section};
use rhwp::model::page::{ColumnDef, PageDef};
use rhwp::model::paragraph::{ColumnBreakType, LineSeg, Paragraph};
use rhwp::model::provenance::FontMetricsPolicy;
use rhwp::model::shape::{
    CommonObjAttr, HorzRelTo, LineShape, RectangleShape, ShapeObject, TextBox, TextWrap,
};
use rhwp::model::style::{CharShape, ParaShape};
use rhwp::model::Point;
use rhwp::renderer::composer::compose_section_with_styles;
use rhwp::renderer::layout::LayoutEngine;
use rhwp::renderer::page_layout::PageLayoutInfo;
use rhwp::renderer::pagination::{ColumnContent, PageContent, PageItem};
use rhwp::renderer::render_tree::{LineNode, PageRenderTree, RenderNode, RenderNodeType};
use rhwp::renderer::style_resolver::resolve_styles;
use rhwp::serializer::serialize_document;

const DPI: f64 = 72.0;

fn paragraph(text: &str, y: i32) -> Paragraph {
    Paragraph {
        text: text.into(),
        char_count: text.encode_utf16().count() as u32 + 1,
        line_segs: vec![LineSeg {
            vertical_pos: y,
            line_height: 1200,
            text_height: 1200,
            baseline_distance: 900,
            segment_width: 29000,
            tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
            ..Default::default()
        }],
        ..Default::default()
    }
}

fn columns() -> ColumnDef {
    ColumnDef {
        column_count: 2,
        same_width: true,
        spacing: 2000,
        separator_type: 1,
        separator_width: 1,
        ..Default::default()
    }
}

fn title(current_height: u32, declared_height: u32) -> Control {
    let mut rect = RectangleShape::default();
    rect.common = CommonObjAttr {
        width: 60000,
        height: declared_height,
        vertical_offset: 6000,
        horz_rel_to: HorzRelTo::Page,
        text_wrap: TextWrap::TopAndBottom,
        ..Default::default()
    };
    let attr = &mut rect.drawing.shape_attr;
    attr.current_width = 60000;
    attr.current_height = current_height;
    attr.original_width = 65000;
    attr.original_height = 16000;
    attr.render_sx = 60000.0 / 65000.0;
    attr.render_sy = f64::from(current_height) / 16000.0;
    rect.drawing.text_box = Some(TextBox {
        paragraphs: vec![paragraph("TITLE", 0)],
        ..Default::default()
    });
    Control::Shape(Box::new(ShapeObject::Rectangle(rect)))
}

fn horizontal_rule(y: u32) -> Control {
    let mut line = LineShape::default();
    line.common = CommonObjAttr {
        width: 60000,
        height: 1,
        vertical_offset: y,
        horz_rel_to: HorzRelTo::Page,
        text_wrap: TextWrap::InFrontOfText,
        ..Default::default()
    };
    line.start = Point { x: 0, y: 0 };
    line.end = Point { x: 60000, y: 0 };
    line.drawing.shape_attr.original_width = 60000;
    line.drawing.shape_attr.current_width = 60000;
    line.drawing.shape_attr.original_height = 1;
    line.drawing.shape_attr.current_height = 1;
    Control::Shape(Box::new(ShapeObject::Line(line)))
}

fn page_paragraphs(current_height: u32, declared_height: u32) -> Vec<Paragraph> {
    let host_y = (6000 + current_height - 10000) as i32;
    let mut left = paragraph("LEFT", host_y);
    left.controls = vec![
        title(current_height, declared_height),
        horizontal_rule(6000 + current_height),
    ];
    let mut right = paragraph("RIGHT", host_y);
    right.column_type = ColumnBreakType::Column;
    vec![
        left,
        paragraph("LEFT LATER", host_y + 2500),
        right,
        paragraph("RIGHT LATER", host_y + 2500),
    ]
}

fn fixture(current_height: u32, declared_height: u32) -> Document {
    let mut section = Section::default();
    section.section_def.page_def = PageDef {
        width: 80000,
        height: 100000,
        margin_left: 10000,
        margin_right: 10000,
        margin_top: 8000,
        margin_header: 2000,
        margin_bottom: 8000,
        margin_footer: 2000,
        ..Default::default()
    };
    section.paragraphs = page_paragraphs(current_height, declared_height);
    section.paragraphs[0]
        .controls
        .push(Control::ColumnDef(columns()));
    let mut doc = Document::default();
    doc.header.version.major = 5;
    doc.doc_properties.section_count = 1;
    doc.doc_info.char_shapes.push(CharShape::default());
    doc.doc_info.para_shapes.push(ParaShape::default());
    doc.sections.push(section);
    doc
}

fn core(doc: Document) -> DocumentCore {
    let mut core = DocumentCore::new_empty();
    core.set_dpi(DPI);
    core.set_document(doc);
    core
}

fn title_mut(doc: &mut Document) -> &mut RectangleShape {
    let Control::Shape(shape) = &mut doc.sections[0].paragraphs[0].controls[0] else {
        panic!("title control")
    };
    let ShapeObject::Rectangle(rect) = shape.as_mut() else {
        panic!("title rectangle")
    };
    rect
}

fn nodes(node: &RenderNode) -> Vec<&RenderNode> {
    let mut out = vec![node];
    for child in &node.children {
        out.extend(nodes(child));
    }
    out
}

fn text_in(node: &RenderNode) -> String {
    nodes(node)
        .into_iter()
        .filter_map(|node| match &node.node_type {
            RenderNodeType::TextRun(run) => Some(run.display_or_text()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

fn is_divider(line: &LineNode) -> bool {
    line.para_index.is_none() && (line.x1 - line.x2).abs() < 1e-9
}

fn dividers(tree: &PageRenderTree) -> Vec<&LineNode> {
    nodes(&tree.root)
        .into_iter()
        .filter_map(|node| match &node.node_type {
            RenderNodeType::Line(line) if is_divider(line) => Some(line),
            _ => None,
        })
        .collect()
}

#[track_caller]
fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.02,
        "actual={actual}, expected={expected}"
    );
}

fn divider_start(tree: &PageRenderTree, expected: f64) {
    let lines = dividers(tree);
    assert_eq!(lines.len(), 1, "one center divider survives");
    near(lines[0].x1, 400.0);
    near(lines[0].y1, expected);
    assert!(lines[0].y2 > lines[0].y1, "divider has positive length");
    near(lines[0].style.width, 0.5);
}

fn non_divider_geometry(tree: &PageRenderTree) -> Vec<serde_json::Value> {
    // Node IDs may shift when a zone emits its divider before later content.
    nodes(&tree.root)
        .into_iter()
        .filter(|node| !matches!(&node.node_type, RenderNodeType::Line(line) if is_divider(line)))
        .map(|node| serde_json::to_value((&node.node_type, &node.bbox, node.visible)).unwrap())
        .collect()
}

fn without_separators(mut doc: Document) -> Document {
    for para in &mut doc.sections[0].paragraphs {
        for control in &mut para.controls {
            if let Control::ColumnDef(cd) = control {
                cd.separator_type = 0;
            }
        }
    }
    doc
}

fn check_title_rule_and_body(tree: &PageRenderTree, boundary: f64) {
    let all = nodes(&tree.root);
    let rectangles: Vec<_> = all
        .iter()
        .filter(|node| matches!(node.node_type, RenderNodeType::Rectangle(_)))
        .collect();
    assert_eq!(rectangles.len(), 1, "title frame survives once");
    assert_eq!(text_in(rectangles[0]), "TITLE");
    let rules: Vec<_> = all
        .iter()
        .filter_map(|node| match &node.node_type {
            RenderNodeType::Line(line) if line.para_index.is_some() => Some(line),
            _ => None,
        })
        .collect();
    assert_eq!(rules.len(), 1, "authored horizontal rule survives once");
    near(rules[0].y1, boundary);
    near(rules[0].y2, boundary);
    near(rules[0].x2 - rules[0].x1, 600.0);
    let mut body_bottom: f64 = 0.0;
    for (text, y) in [
        ("LEFT", boundary),
        ("RIGHT", boundary),
        ("LEFT LATER", boundary + 25.0),
        ("RIGHT LATER", boundary + 25.0),
    ] {
        let lines: Vec<_> = all
            .iter()
            .filter(|node| {
                matches!(node.node_type, RenderNodeType::TextLine(_)) && text_in(node) == text
            })
            .collect();
        assert_eq!(lines.len(), 1, "body line {text} survives once");
        near(lines[0].bbox.y, y);
        body_bottom = body_bottom.max(lines[0].bbox.y + lines[0].bbox.height);
    }
    near(dividers(tree)[0].y2, body_bottom);
}

#[test]
fn public_document_divider_tracks_current_frame_and_host_without_moving_content() {
    for policy in [
        FontMetricsPolicy::HancomWindows,
        FontMetricsPolicy::HcrDeclared,
    ] {
        for (height, declared) in [(10000, 8000), (12000, 9000)] {
            let mut doc = fixture(height, declared);
            doc.doc_info.font_metrics_policy = policy;
            let expected = f64::from(6000 + height) / 100.0;
            let with_separator = core(doc.clone());
            let tree = with_separator.build_page_render_tree(0).unwrap();
            // BEFORE fails here: its divider starts at body top 100, not 160/180.
            divider_start(&tree, expected);
            check_title_rule_and_body(&tree, expected);
            let plain = core(without_separators(doc));
            assert_eq!(with_separator.page_count(), 1);
            assert_eq!(plain.page_count(), 1);
            assert_eq!(
                non_divider_geometry(&tree),
                non_divider_geometry(&plain.build_page_render_tree(0).unwrap()),
                "separator reservation must not move, remove or restyle content"
            );
        }
    }
}

#[test]
fn unsupported_or_uncertified_titles_keep_body_top_divider() {
    for case in [
        "synthetic row",
        "host mismatch",
        "rotation",
        "wrapping",
        "narrow frame",
        "outside title area",
        "missing textbox",
        "own layout",
    ] {
        let mut doc = fixture(10000, 8000);
        match case {
            "synthetic row" => {
                doc.sections[0].paragraphs[0].line_segs[0].tag |=
                    LineSeg::TAG_IMPLEMENTATION_PROPERTY;
            }
            "host mismatch" => doc.sections[0].paragraphs[0].line_segs[0].vertical_pos += 500,
            "rotation" => title_mut(&mut doc).drawing.shape_attr.rotation_angle = 15,
            "wrapping" => title_mut(&mut doc).common.text_wrap = TextWrap::InFrontOfText,
            "narrow frame" => {
                let title = title_mut(&mut doc);
                title.common.width = 20000;
                title.drawing.shape_attr.current_width = 20000;
                title.drawing.shape_attr.render_sx = 20000.0 / 65000.0;
            }
            "outside title area" => {
                title_mut(&mut doc).common.vertical_offset = 40000;
                doc.sections[0].paragraphs[0].line_segs[0].vertical_pos = 40000;
            }
            "missing textbox" => title_mut(&mut doc).drawing.text_box = None,
            "own layout" => doc.provenance.own_line_layout = true,
            _ => unreachable!(),
        }
        let tree = core(doc).build_page_render_tree(0).unwrap();
        assert_eq!(dividers(&tree).len(), 1, "{case}: divider survives");
        divider_start(&tree, 100.0);
    }
}

#[test]
fn public_edit_rejects_stale_title_certificate_after_owned_cfb_import() {
    let bytes = serialize_document(&fixture(10000, 8000)).expect("owned CFB");
    let mut core = DocumentCore::from_bytes(&bytes).expect("public CFB importer");
    core.set_dpi(DPI);
    assert!(core.document().sections[0].raw_stream.is_some());
    assert!(core.document().layout_profile().native_hwp5_layout());
    assert!(!core.document().layout_profile().session_edited());
    divider_start(&core.build_page_render_tree(0).unwrap(), 160.0);
    let stored_host_y = core.document().sections[0].paragraphs[0].line_segs[0].vertical_pos;
    // Edit a later body paragraph. The untouched title still has its saved host line.
    core.insert_text_native(0, 1, 0, "EDIT ").unwrap();
    assert!(core.document().layout_profile().session_edited());
    assert_eq!(
        core.document().sections[0].paragraphs[0].line_segs[0].vertical_pos,
        stored_host_y,
        "editing a different paragraph leaves the saved title host intact"
    );
    let tree = core.build_page_render_tree(0).unwrap();
    divider_start(&tree, 100.0);
    assert!(text_in(&tree.root).contains("EDIT LEFT LATER"));
    assert!(text_in(&tree.root).contains("TITLE"));
    assert_eq!(
        nodes(&tree.root)
            .iter()
            .filter(|node| matches!(&node.node_type, RenderNodeType::Line(line) if line.para_index.is_some()))
            .count(),
        1,
        "authored rule survives editing"
    );
}

#[test]
fn public_document_resets_reservation_for_each_title_and_ordinary_page() {
    let mut doc = fixture(10000, 8000);
    let mut second = page_paragraphs(12000, 9000);
    second[0].column_type = ColumnBreakType::Page;
    let mut third = page_paragraphs(10000, 8000);
    third[0].column_type = ColumnBreakType::Page;
    third[0].controls.clear();
    doc.sections[0].paragraphs.extend(second);
    doc.sections[0].paragraphs.extend(third);
    let core = core(doc);
    assert_eq!(core.page_count(), 3);
    // Revisit pages out of order to expose retained reservation state.
    for (page, start) in [(0, 160.0), (1, 180.0), (2, 100.0), (0, 160.0)] {
        divider_start(&core.build_page_render_tree(page).unwrap(), start);
    }
}

fn column(index: u16, zone: f64, items: Vec<PageItem>) -> ColumnContent {
    ColumnContent {
        column_index: index,
        items,
        start_height: 0.0,
        endnote_flow: false,
        zone_layout: None,
        zone_y_offset: zone,
        wrap_around_paras: Vec::new(),
        used_height: 0.0,
        wrap_anchors: Default::default(),
    }
}

#[test]
fn later_zone_title_does_not_raise_an_earlier_zone_divider() {
    // Supplement the public DocumentCore cases with an explicit public pagination fixture.
    // No private helper is called; both assertions inspect emitted LineNodes.
    let mut doc = fixture(16000, 8000);
    let title_controls = std::mem::take(&mut doc.sections[0].paragraphs[0].controls);
    let mut later = paragraph("LATER ZONE", 12000);
    later.controls = title_controls;
    doc.sections[0].paragraphs.push(later);
    let section = &doc.sections[0];
    let styles = resolve_styles(&doc.doc_info, DPI);
    let composed = compose_section_with_styles(section, &styles);
    let layout = PageLayoutInfo::from_page_def(&section.section_def.page_def, &columns(), DPI);
    let page = PageContent {
        page_index: 0,
        page_number: 1,
        section_index: 0,
        layout,
        column_contents: vec![
            column(0, 0.0, vec![PageItem::FullParagraph { para_index: 0 }]),
            column(1, 0.0, vec![PageItem::FullParagraph { para_index: 2 }]),
            column(
                0,
                100.0,
                vec![
                    PageItem::FullParagraph { para_index: 4 },
                    PageItem::Shape {
                        para_index: 4,
                        control_index: 0,
                    },
                    PageItem::Shape {
                        para_index: 4,
                        control_index: 1,
                    },
                ],
            ),
        ],
        active_header: None,
        active_footer: None,
        page_number_pos: None,
        page_hide: None,
        footnotes: Vec::new(),
        active_master_page: None,
        extra_master_pages: Vec::new(),
    };
    let engine = LayoutEngine::new(DPI);
    engine.set_layout_profile(doc.layout_profile());
    let render = |selected: &PageContent| {
        engine.build_render_tree(
            selected,
            &section.paragraphs,
            &section.paragraphs,
            &section.paragraphs,
            &composed,
            &styles,
            &Default::default(),
            &[],
            None,
            &[],
            None,
            0,
            &[],
        )
    };
    let tree = render(&page);
    let lines = dividers(&tree);
    assert_eq!(lines.len(), 2, "both zone dividers survive");
    near(lines[0].y1, 100.0);
    assert!(
        lines[1].y1 >= lines[0].y2,
        "later zone keeps its own flow start"
    );

    // Move the host and shape into the second column of the SAME zone.
    // The existing emitter treats offsets within 0.1px as the same zone.
    let mut same_zone = page.clone();
    same_zone.column_contents.truncate(2);
    same_zone.column_contents[1].items = page.column_contents[2].items.clone();
    same_zone.column_contents[1].zone_y_offset = 0.05;
    divider_start(&render(&same_zone), 220.0);
}

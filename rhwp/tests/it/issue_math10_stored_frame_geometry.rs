//! 저장 LINE_SEG/현재 글상자 경계, 중첩 TAC baseline, 본문 Page AutoNumber 회귀.
//! 외부 시험지/폰트/네이티브 렌더러 없이 공개 조판·렌더 트리 API를 검사한다.

use rhwp::model::control::{AutoNumber, AutoNumberType, Control, PageHide};
use rhwp::model::document::{Document, Section};
use rhwp::model::header_footer::{Footer, Header, MasterPage};
use rhwp::model::page::{ColumnDef, PageDef};
use rhwp::model::paragraph::{ColumnBreakType, LineSeg, Paragraph};
use rhwp::model::shape::{
    CommonObjAttr, HorzRelTo, RectangleShape, ShapeObject, TextBox, TextWrap,
};
use rhwp::model::style::{CharShape, ParaShape};
use rhwp::renderer::composer::compose_section_with_styles;
use rhwp::renderer::layout::LayoutEngine;
use rhwp::renderer::page_layout::PageLayoutInfo;
use rhwp::renderer::pagination::{ColumnContent, HeaderFooterRef, PageContent, PageItem};
use rhwp::renderer::render_tree::{PageRenderTree, RenderNode, RenderNodeType};
use rhwp::renderer::style_resolver::resolve_styles;
use rhwp::renderer::typeset::TypesetEngine;

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

fn textbox(width: u32, height: u32, children: Vec<Paragraph>) -> RectangleShape {
    let mut rect = RectangleShape::default();
    rect.common = CommonObjAttr {
        width,
        height,
        horz_rel_to: HorzRelTo::Page,
        text_wrap: TextWrap::InFrontOfText,
        ..Default::default()
    };
    rect.drawing.shape_attr.current_width = width;
    rect.drawing.shape_attr.current_height = height;
    rect.drawing.text_box = Some(TextBox {
        paragraphs: children,
        ..Default::default()
    });
    rect
}

fn shape(rect: RectangleShape) -> Control {
    Control::Shape(Box::new(ShapeObject::Rectangle(rect)))
}

fn fixture() -> (Document, PageDef, ColumnDef) {
    let page_def = PageDef {
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
    let columns = ColumnDef {
        column_count: 2,
        same_width: true,
        spacing: 2000,
        ..Default::default()
    };
    let mut title = textbox(60000, 8000, vec![paragraph("TITLE", 0)]);
    title.common.vertical_offset = 6000;
    title.common.text_wrap = TextWrap::TopAndBottom;
    // 선언 하단 14000, 저장 프레임/본문 첫 줄 하단 경계 16000.
    title.drawing.shape_attr.current_height = 10000;
    title.drawing.shape_attr.original_width = 65000;
    title.drawing.shape_attr.original_height = 16000;
    title.drawing.shape_attr.render_sx = 60000.0 / 65000.0;
    title.drawing.shape_attr.render_sy = 10000.0 / 16000.0;
    let mut left = paragraph("LEFT", 6000);
    left.controls.push(shape(title));
    let mut right = paragraph("RIGHT", 6000);
    right.column_type = ColumnBreakType::Column;
    let mut section = Section::default();
    section.paragraphs = vec![
        left,
        paragraph("LEFT LATER", 8500),
        right,
        paragraph("RIGHT LATER", 8500),
    ];
    let mut doc = Document::default();
    doc.doc_info.char_shapes.push(CharShape::default());
    doc.doc_info.para_shapes.push(ParaShape::default());
    doc.sections.push(section);
    (doc, page_def, columns)
}

fn column(index: u16, items: Vec<PageItem>) -> ColumnContent {
    ColumnContent {
        column_index: index,
        items,
        start_height: 0.0,
        endnote_flow: false,
        zone_layout: None,
        zone_y_offset: 0.0,
        wrap_around_paras: Vec::new(),
        used_height: 0.0,
        wrap_anchors: Default::default(),
    }
}

fn page(page_def: &PageDef, columns: &ColumnDef) -> PageContent {
    PageContent {
        page_index: 0,
        page_number: 1,
        section_index: 0,
        layout: PageLayoutInfo::from_page_def(page_def, columns, DPI),
        column_contents: vec![
            column(
                0,
                vec![
                    PageItem::FullParagraph { para_index: 0 },
                    PageItem::Shape {
                        para_index: 0,
                        control_index: 0,
                    },
                    PageItem::FullParagraph { para_index: 1 },
                ],
            ),
            column(
                1,
                vec![
                    PageItem::FullParagraph { para_index: 2 },
                    PageItem::FullParagraph { para_index: 3 },
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
    }
}

fn render(
    engine: &LayoutEngine,
    doc: &Document,
    page: &PageContent,
    master: Option<&MasterPage>,
) -> PageRenderTree {
    let styles = resolve_styles(&doc.doc_info, DPI);
    let section = &doc.sections[0];
    let composed = compose_section_with_styles(section, &styles);
    engine.set_layout_profile(doc.layout_profile());
    engine.build_render_tree(
        page,
        &section.paragraphs,
        &section.paragraphs,
        &section.paragraphs,
        &composed,
        &styles,
        &Default::default(),
        &[],
        master,
        &[],
        None,
        0,
        &[],
    )
}

fn nodes(node: &RenderNode) -> Vec<&RenderNode> {
    let mut out = vec![node];
    for child in &node.children {
        out.extend(nodes(child));
    }
    out
}

fn line_y(tree: &PageRenderTree, text: &str) -> f64 {
    nodes(&tree.root)
        .into_iter()
        .find(|node| matches!(node.node_type, RenderNodeType::TextLine(_)) && text_in(node) == text)
        .unwrap_or_else(|| panic!("missing line {text}"))
        .bbox
        .y
}

fn close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.02,
        "actual {actual}, expected {expected}"
    );
}

fn title_mut(doc: &mut Document) -> &mut RectangleShape {
    let Control::Shape(s) = &mut doc.sections[0].paragraphs[0].controls[0] else {
        panic!()
    };
    let ShapeObject::Rectangle(rect) = s.as_mut() else {
        panic!()
    };
    rect
}

#[test]
fn stored_boundary_anchors_both_columns_once_and_keeps_authored_geometry() {
    let (doc, pd, cd) = fixture();
    let input = format!("{:?}", doc.sections[0].paragraphs);
    let tree = render(&LayoutEngine::new(DPI), &doc, &page(&pd, &cd), None);
    close(line_y(&tree, "LEFT"), 160.0);
    close(line_y(&tree, "RIGHT"), 160.0);
    close(line_y(&tree, "LEFT LATER"), 185.0);
    close(line_y(&tree, "RIGHT LATER"), 185.0);
    let title = nodes(&tree.root)
        .into_iter()
        .find(|n| {
            matches!(&n.node_type,
        RenderNodeType::Rectangle(r) if r.para_index == Some(0) && r.control_index == Some(0))
        })
        .unwrap();
    close(title.bbox.y, 60.0);
    close(title.bbox.height, 80.0);
    assert_eq!(
        input,
        format!("{:?}", doc.sections[0].paragraphs),
        "LINE_SEG and shape storage stay authored"
    );
}

#[test]
fn typesetter_reuses_boundary_for_next_column_capacity_without_zone_translation() {
    let (doc, pd, cd) = fixture();
    let styles = resolve_styles(&doc.doc_info, DPI);
    let section = &doc.sections[0];
    let composed = compose_section_with_styles(section, &styles);
    let pagination = TypesetEngine::new(DPI).typeset_section(
        &section.paragraphs,
        &composed,
        &styles,
        &pd,
        &cd,
        0,
        &[],
        false,
        &Default::default(),
    );
    assert_eq!(pagination.pages.len(), 1);
    let second = pagination.pages[0]
        .column_contents
        .iter()
        .find(|c| c.column_index == 1)
        .expect("second column");
    close(second.start_height, 60.0);
    close(second.zone_y_offset, 0.0);
    let tree = render(&LayoutEngine::new(DPI), &doc, &pagination.pages[0], None);
    close(line_y(&tree, "LEFT"), 160.0);
    close(line_y(&tree, "RIGHT"), 160.0);
}

#[test]
fn unrelated_stale_generated_edited_or_transformed_frames_keep_declared_reservation() {
    for variant in 0..9 {
        let (mut doc, pd, cd) = fixture();
        match variant {
            0 => doc.sections[0].paragraphs[0].line_segs.clear(),
            1 => {
                doc.sections[0].paragraphs[0].line_segs[0].tag |=
                    LineSeg::TAG_IMPLEMENTATION_PROPERTY
            }
            2 => doc.sections[0].raw_provenance = Some(()), // raw_stream is absent after editing
            3 => title_mut(&mut doc).drawing.shape_attr.rotation_angle = 15,
            4 => title_mut(&mut doc).drawing.shape_attr.render_ty = 100.0,
            5 => title_mut(&mut doc).drawing.shape_attr.render_b = 0.2,
            6 => title_mut(&mut doc).drawing.shape_attr.render_sy = 1.5,
            7 => title_mut(&mut doc).drawing.shape_attr.current_height = 11000, // no matching line
            8 => doc.provenance.own_line_layout = true,
            _ => unreachable!(),
        }
        let tree = render(&LayoutEngine::new(DPI), &doc, &page(&pd, &cd), None);
        // The untouched next-column line isolates reservation from first-paragraph reflow.
        close(line_y(&tree, "RIGHT"), 140.0);
    }
}

#[test]
fn nested_inline_rectangles_use_host_baseline_and_outer_margins() {
    for margins in [false, true] {
        let (mut doc, pd, cd) = fixture();
        let mut host = paragraph("\u{fffc}\u{fffc}", 0);
        host.char_count = 17;
        host.char_offsets = vec![0, 8];
        host.line_segs[0].line_height = 4200;
        host.line_segs[0].text_height = 4200;
        host.line_segs[0].baseline_distance = 3570;
        let mut period = textbox(9605, 2833, Vec::new());
        period.common.treat_as_char = true;
        let mut grade = textbox(6563, 3144, Vec::new());
        grade.common.treat_as_char = true;
        if margins {
            grade.common.margin.left = 200;
            grade.common.margin.right = 300;
            grade.common.margin.top = 100;
            grade.common.margin.bottom = 200;
        }
        host.controls = vec![shape(period), shape(grade)];
        let mut parent = textbox(60000, 8000, vec![host]);
        parent.common.vertical_offset = 6000;
        doc.sections[0].paragraphs[0].controls = vec![shape(parent)];
        let mut p = page(&pd, &cd);
        p.column_contents = vec![column(
            0,
            vec![PageItem::Shape {
                para_index: 0,
                control_index: 0,
            }],
        )];
        let tree = render(&LayoutEngine::new(DPI), &doc, &p, None);
        let rectangles: Vec<_> = nodes(&tree.root)
            .into_iter()
            .filter(|n| matches!(n.node_type, RenderNodeType::Rectangle(_)))
            .collect();
        let period = rectangles
            .iter()
            .find(|n| (n.bbox.width - 96.05).abs() < 0.01)
            .expect("period rectangle");
        let grade = rectangles
            .iter()
            .find(|n| (n.bbox.width - 65.63).abs() < 0.01)
            .expect("grade rectangle");
        close(period.bbox.y, 71.6195);
        close(grade.bbox.y, if margins { 67.426 } else { 68.976 });
        close(
            grade.bbox.x - period.bbox.x,
            if margins { 98.05 } else { 96.05 },
        );
    }
}

fn page_number_box() -> Paragraph {
    let mut number = paragraph(" ", 0);
    number.char_count = 9;
    number.char_offsets = vec![0];
    number.controls.push(Control::AutoNumber(AutoNumber {
        number_type: AutoNumberType::Page,
        number: 1,
        ..Default::default()
    }));
    let mut rect = textbox(6000, 5000, vec![number]);
    rect.common.vertical_offset = 2000;
    let mut owner = paragraph("", 0);
    owner.controls.push(shape(rect));
    owner
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

#[test]
fn body_page_number_ignores_header_footer_visibility_and_render_order() {
    let (mut doc, pd, cd) = fixture();
    doc.sections[0].paragraphs = vec![page_number_box()];
    doc.sections[0].paragraphs[0]
        .controls
        .push(Control::Header(Box::new(Header {
            paragraphs: vec![paragraph("HEADER", 0)],
            ..Default::default()
        })));
    doc.sections[0].paragraphs[0]
        .controls
        .push(Control::Footer(Box::new(Footer {
            paragraphs: vec![paragraph("FOOTER", 0)],
            ..Default::default()
        })));
    let engine = LayoutEngine::new(DPI);
    for (hide_header, hide_footer, active) in [
        (true, false, true),
        (true, true, true),
        (false, true, true),
        (false, false, false),
    ] {
        for (index, number) in [(0, 1), (8, 9), (2, 3), (9, 1), (0, 1)] {
            let mut p = page(&pd, &cd);
            p.page_index = index;
            p.page_number = number;
            p.column_contents = vec![column(
                0,
                vec![PageItem::Shape {
                    para_index: 0,
                    control_index: 0,
                }],
            )];
            p.page_hide = Some(PageHide {
                hide_header,
                hide_footer,
                ..Default::default()
            });
            if active {
                p.active_header = Some(HeaderFooterRef {
                    control_index: 1,
                    ..Default::default()
                });
                p.active_footer = Some(HeaderFooterRef {
                    control_index: 2,
                    ..Default::default()
                });
            }
            let tree = render(&engine, &doc, &p, None);
            let fresh = render(&LayoutEngine::new(DPI), &doc, &p, None);
            let body_number = nodes(&tree.root)
                .into_iter()
                .find(|n| matches!(n.node_type, RenderNodeType::Rectangle(_)))
                .unwrap();
            assert_eq!(text_in(body_number).trim(), number.to_string());
            assert_eq!(text_in(&tree.root), text_in(&fresh.root));
            assert_eq!(
                text_in(&tree.root).contains("HEADER"),
                active && !hide_header
            );
            assert_eq!(
                text_in(&tree.root).contains("FOOTER"),
                active && !hide_footer
            );
        }
    }
}

#[test]
fn master_page_number_scope_restores_the_current_body_number() {
    let (mut doc, pd, cd) = fixture();
    doc.sections[0].paragraphs = vec![page_number_box()];
    let master = MasterPage {
        text_width: 60000,
        text_height: 80000,
        paragraphs: vec![page_number_box()],
        ..Default::default()
    };
    let engine = LayoutEngine::new(DPI);
    for number in [7, 1, 4] {
        let mut p = page(&pd, &cd);
        p.page_number = number;
        p.page_hide = Some(PageHide {
            hide_header: true,
            hide_footer: true,
            ..Default::default()
        });
        p.column_contents = vec![column(
            0,
            vec![PageItem::Shape {
                para_index: 0,
                control_index: 0,
            }],
        )];
        let tree = render(&engine, &doc, &p, Some(&master));
        let rectangles: Vec<_> = nodes(&tree.root)
            .into_iter()
            .filter(|n| matches!(n.node_type, RenderNodeType::Rectangle(_)))
            .collect();
        assert_eq!(
            rectangles.len(),
            2,
            "master and body each keep their own textbox"
        );
        for rect in rectangles {
            assert_eq!(text_in(rect).trim(), number.to_string());
        }
    }
}

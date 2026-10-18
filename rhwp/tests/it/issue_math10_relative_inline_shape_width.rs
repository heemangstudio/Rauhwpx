//! 상대 폭 TAC 도형의 정렬·후행 문자 전진은 실제 프레임과 같은 폭을 쓴다.
//! 외부 시험지/서체 없이 공개 조판 → 페이지 렌더 트리 경로를 검사한다.

use rhwp::model::control::Control;
use rhwp::model::document::{Document, Section};
use rhwp::model::page::{ColumnDef, PageDef};
use rhwp::model::paragraph::{CharShapeRef, LineSeg, Paragraph};
use rhwp::model::shape::{RectangleShape, ShapeObject, SizeCriterion, TextBox};
use rhwp::model::style::{Alignment, CharShape, ParaShape};
use rhwp::renderer::composer::compose_section_with_styles;
use rhwp::renderer::layout::LayoutEngine;
use rhwp::renderer::page_layout::PageLayoutInfo;
use rhwp::renderer::pagination::{ColumnContent, PageContent, PageItem};
use rhwp::renderer::render_tree::{PageRenderTree, RenderNode, RenderNodeType};
use rhwp::renderer::style_resolver::resolve_styles;

const DPI: f64 = 72.0;

fn shape(criterion: SizeCriterion, width: u32, current: u32, margins: (i16, i16)) -> Control {
    let mut rect = RectangleShape::default();
    rect.common.treat_as_char = true;
    rect.common.width_criterion = criterion;
    rect.common.width = width;
    rect.common.height = 1200;
    rect.common.margin.left = margins.0;
    rect.common.margin.right = margins.1;
    rect.drawing.shape_attr.current_width = current;
    rect.drawing.shape_attr.current_height = 1200;
    rect.drawing.text_box = Some(TextBox::default());
    Control::Shape(Box::new(ShapeObject::Rectangle(rect)))
}

fn document(controls: Vec<Control>, alignment: Alignment, text: &str) -> Document {
    let mut doc = Document::default();
    doc.doc_info.char_shapes.push(CharShape {
        base_size: 1000,
        ratios: [100; 7],
        relative_sizes: [100; 7],
        ..Default::default()
    });
    doc.doc_info.para_shapes.push(ParaShape {
        alignment,
        line_spacing: 160,
        ..Default::default()
    });
    // A<shape>B 또는 A<shape>B<shape>C의 원본 8-unit 제어 슬롯.
    let char_offsets = text
        .chars()
        .enumerate()
        .map(|(i, _)| i as u32 + 8 * (i.min(controls.len()) as u32))
        .collect();
    let count = text.encode_utf16().count() as u32 + controls.len() as u32 * 8 + 1;
    let paragraph = Paragraph {
        text: text.into(),
        char_offsets,
        char_count: count,
        char_shapes: vec![CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        }],
        line_segs: vec![LineSeg {
            line_height: 1600,
            text_height: 1200,
            baseline_distance: 1020,
            line_spacing: 600,
            segment_width: 32456,
            tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
            ..Default::default()
        }],
        controls,
        ..Default::default()
    };
    let mut section = Section::default();
    section.paragraphs.push(paragraph);
    doc.sections.push(section);
    doc
}

fn page(column_index: u16) -> PageContent {
    let pd = PageDef {
        width: 84188,
        height: 119052,
        margin_left: 8787,
        margin_right: 8787,
        margin_top: 9921,
        margin_bottom: 8503,
        margin_header: 4251,
        margin_footer: 2834,
        ..Default::default()
    };
    let cd = ColumnDef {
        column_count: 2,
        same_width: true,
        spacing: 1702,
        ..Default::default()
    };
    PageContent {
        page_index: 0,
        page_number: 1,
        section_index: 0,
        layout: PageLayoutInfo::from_page_def(&pd, &cd, DPI),
        column_contents: vec![ColumnContent {
            column_index,
            items: vec![
                PageItem::FullParagraph { para_index: 0 },
                PageItem::Shape {
                    para_index: 0,
                    control_index: 0,
                },
            ],
            start_height: 0.0,
            endnote_flow: false,
            zone_layout: None,
            zone_y_offset: 0.0,
            wrap_around_paras: Vec::new(),
            used_height: 0.0,
            wrap_anchors: Default::default(),
        }],
        active_header: None,
        active_footer: None,
        page_number_pos: None,
        page_hide: None,
        footnotes: Vec::new(),
        active_master_page: None,
        extra_master_pages: Vec::new(),
    }
}

fn render(doc: &Document, column_index: u16) -> PageRenderTree {
    let before = format!("{:?}", doc.sections[0].paragraphs);
    let styles = resolve_styles(&doc.doc_info, DPI);
    let section = &doc.sections[0];
    let composed = compose_section_with_styles(section, &styles);
    let mut page = page(column_index);
    for ci in 1..section.paragraphs[0].controls.len() {
        page.column_contents[0].items.push(PageItem::Shape {
            para_index: 0,
            control_index: ci,
        });
    }
    let engine = LayoutEngine::new(DPI);
    engine.set_layout_profile(doc.layout_profile());
    let tree = engine.build_render_tree(
        &page,
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
    );
    assert_eq!(format!("{:?}", doc.sections[0].paragraphs), before);
    tree
}

fn nodes(node: &RenderNode) -> Vec<&RenderNode> {
    let mut out = vec![node];
    for child in &node.children {
        out.extend(nodes(child));
    }
    out
}

fn frame(tree: &PageRenderTree, ci: usize) -> &RenderNode {
    let found: Vec<_> = nodes(&tree.root)
        .into_iter()
        .filter(|n| {
            matches!(&n.node_type, RenderNodeType::Rectangle(r)
                if r.section_index == Some(0) && r.para_index == Some(0)
                    && r.control_index == Some(ci))
        })
        .collect();
    assert_eq!(found.len(), 1, "exactly one painted authored frame");
    found[0]
}

fn close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.025,
        "actual={actual}, expected={expected}"
    );
}

fn same_frame(actual: &PageRenderTree, expected: &PageRenderTree, ci: usize) {
    let a = &frame(actual, ci).bbox;
    let b = &frame(expected, ci).bbox;
    close(a.x, b.x);
    close(a.y, b.y);
    close(a.width, b.width);
    close(a.height, b.height);
}

#[test]
fn column_percent_centered_frames_fit_both_columns_and_keep_source_attributes() {
    for column in [0, 1] {
        for (percent, physical_width) in
            [(9758, 31670.5648), (9704, 31495.3024), (9797, 31797.1432)]
        {
            // current_width가 반대 방향으로 크게 달라도 퍼센트의 단 기준을 대체하지 않는다.
            for current in [900, 90000] {
                let doc = document(
                    vec![shape(SizeCriterion::Column, percent, current, (56, 56))],
                    Alignment::Center,
                    "",
                );
                let tree = render(&doc, column);
                let rect = &frame(&tree, 0).bbox;
                let layout = page(column).layout;
                let col = layout.column_areas[column as usize];
                close(rect.width, physical_width / 100.0);
                close(rect.x, col.x + (col.width - rect.width) / 2.0);
                // 200DPI의 4px 가장자리 가드보다도 충분히 안쪽이다. 픽셀 검사는 root 담당.
                assert!(rect.x > 4.0 * 72.0 / 200.0);
                assert!(rect.x + rect.width < layout.page_width - 4.0 * 72.0 / 200.0);
            }
        }
    }
}

#[test]
fn right_alignment_counts_asymmetric_external_margins_once() {
    let doc = document(
        vec![shape(SizeCriterion::Column, 5000, 90000, (200, 500))],
        Alignment::Right,
        "",
    );
    let tree = render(&doc, 1);
    let col = page(1).layout.column_areas[1];
    let rect = &frame(&tree, 0).bbox;
    close(rect.width, 162.28);
    close(rect.x + rect.width, col.x + col.width - 5.0);
}

#[test]
fn percentage_bases_match_independently_authored_absolute_widths_with_para_indent() {
    for alignment in [Alignment::Left, Alignment::Center, Alignment::Right] {
        // Paraは左右余白を引き、Columnは引かない。indentは物理サイズの基準ではない。
        for (criterion, percent, absolute) in [
            (SizeCriterion::Column, 5000, 16228),
            (SizeCriterion::Para, 5000, 14978),
            (SizeCriterion::Page, 5000, 33307),
            (SizeCriterion::Paper, 2500, 21047),
        ] {
            let make = |kind, width| {
                let mut doc = document(vec![shape(kind, width, 91000, (200, 500))], alignment, "");
                let ps = &mut doc.doc_info.para_shapes[0];
                ps.margin_left = 2000; // public style resolver: 10pt
                ps.margin_right = 3000; // 15pt
                ps.indent = 1200; // 6pt; percentage basis remains the paragraph rectangle
                doc
            };
            let actual = render(&make(criterion, percent), 1);
            let expected = render(&make(SizeCriterion::Absolute, absolute), 1);
            same_frame(&actual, &expected, 0);
        }
    }
}

#[test]
fn mixed_text_and_multiple_shapes_share_one_resolved_advance() {
    for alignment in [Alignment::Left, Alignment::Center, Alignment::Right] {
        let actual_doc = document(
            vec![
                shape(SizeCriterion::Column, 2500, 91000, (100, 200)),
                shape(SizeCriterion::Column, 2500, 900, (300, 400)),
            ],
            alignment,
            "ABC",
        );
        let expected_doc = document(
            vec![
                shape(SizeCriterion::Absolute, 8114, 91000, (100, 200)),
                shape(SizeCriterion::Absolute, 8114, 900, (300, 400)),
            ],
            alignment,
            "ABC",
        );
        let actual = render(&actual_doc, 1);
        let expected = render(&expected_doc, 1);
        for ci in [0, 1] {
            same_frame(&actual, &expected, ci);
        }
        let visible = |tree: &PageRenderTree| {
            nodes(&tree.root)
                .into_iter()
                .filter_map(|n| match &n.node_type {
                    RenderNodeType::TextRun(run) if !run.text.is_empty() => {
                        Some((run.text.clone(), n.bbox.x, n.bbox.width))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        let a = visible(&actual);
        let b = visible(&expected);
        assert!(!a.is_empty());
        assert_eq!(a.len(), b.len());
        for (a, b) in a.iter().zip(&b) {
            assert_eq!(a.0, b.0);
            close(a.1, b.1);
            close(a.2, b.2);
        }
        let tail = a
            .iter()
            .find(|(text, _, _)| text == "C")
            .expect("following C");
        let last_frame = &frame(&actual, 1).bbox;
        assert!(tail.1 >= last_frame.x + last_frame.width);
    }
}

#[test]
fn missing_stored_lines_still_place_the_final_frame_using_live_column_width() {
    let mut actual = document(
        vec![shape(SizeCriterion::Column, 5000, 91000, (56, 56))],
        Alignment::Center,
        "",
    );
    let mut expected = document(
        vec![shape(SizeCriterion::Absolute, 16228, 91000, (56, 56))],
        Alignment::Center,
        "",
    );
    actual.sections[0].paragraphs[0].line_segs.clear();
    expected.sections[0].paragraphs[0].line_segs.clear();
    let actual_tree = render(&actual, 1);
    same_frame(&actual_tree, &render(&expected, 1), 0);
    close(frame(&actual_tree, 0).bbox.x, 510.59);
    close(frame(&actual_tree, 0).bbox.width, 162.28);
    // Fresh wrapping before this final placement still has no full page geometry contract.
    // This test intentionally verifies placement, not a new wrapping/pagination policy.
}

#[test]
fn textless_shape_item_fallback_shares_relative_width_and_paragraph_basis() {
    for column in [0, 1] {
        for alignment in [Alignment::Center, Alignment::Right] {
            for (criterion, absolute) in
                [(SizeCriterion::Column, 16228), (SizeCriterion::Para, 14978)]
            {
                let make = |kind, width| {
                    let mut doc =
                        document(vec![shape(kind, width, 91000, (200, 500))], alignment, "");
                    doc.sections[0].paragraphs[0].line_segs.clear();
                    let style = &mut doc.doc_info.para_shapes[0];
                    style.margin_left = 2000;
                    style.margin_right = 3000;
                    style.indent = 1200;
                    doc
                };
                same_frame(
                    &render(&make(criterion, 5000), column),
                    &render(&make(SizeCriterion::Absolute, absolute), column),
                    0,
                );
            }
        }
    }
}

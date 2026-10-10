//! A peeled page wrapper must retain its cell coordinate frame for all sibling objects.
use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::paragraph::{LineSeg, Paragraph};
use rhwp::model::shape::{CommonObjAttr, HorzAlign, HorzRelTo, TextWrap, VertAlign, VertRelTo};
use rhwp::model::table::{Cell, Table, VerticalAlign};
use rhwp::model::Padding;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

fn table(width: u32, height: u32, common: CommonObjAttr) -> Table {
    let mut table = Table {
        row_count: 1,
        col_count: 1,
        common: CommonObjAttr {
            width,
            height,
            ..common
        },
        cells: vec![Cell {
            width,
            height,
            row_span: 1,
            col_span: 1,
            paragraphs: vec![Paragraph::new_empty()],
            ..Default::default()
        }],
        ..Default::default()
    };
    table.rebuild_grid();
    table
}

fn document(align: VertAlign, offset: u32, saved: bool, padding: bool) -> DocumentCore {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().unwrap();
    let mut doc = core.document().clone();
    let page = &mut doc.sections[0].section_def.page_def;
    page.width = 30_000;
    page.height = 30_000;
    page.margin_left = 3_000;
    page.margin_right = 3_000;
    page.margin_top = 3_000;
    page.margin_bottom = 3_000;
    page.margin_header = 0;
    page.margin_footer = 0;
    let local = CommonObjAttr {
        vert_rel_to: VertRelTo::Para,
        horz_rel_to: HorzRelTo::Para,
        vert_align: VertAlign::Top,
        horz_align: HorzAlign::Center,
        text_wrap: TextWrap::TopAndBottom,
        flow_with_text: true,
        vertical_offset: 1_500,
        ..Default::default()
    };
    let primary = table(10_000, 6_000, local.clone());
    let overlay = table(
        2_000,
        2_000,
        CommonObjAttr {
            text_wrap: TextWrap::BehindText,
            vert_align: VertAlign::Bottom,
            vertical_offset: 0,
            ..local
        },
    );
    let mut host = Paragraph {
        controls: vec![
            Control::Table(Box::new(primary)),
            Control::Table(Box::new(overlay)),
        ],
        ..Paragraph::new_empty()
    };
    if saved {
        host.line_segs = vec![LineSeg {
            line_height: 1_000,
            text_height: 1_000,
            baseline_distance: 850,
            line_spacing: 600,
            segment_width: 20_000,
            ..Default::default()
        }];
    } else {
        host.line_segs.clear();
    }
    let mut wrapper = table(
        20_000,
        9_000,
        CommonObjAttr {
            vert_rel_to: VertRelTo::Page,
            horz_rel_to: HorzRelTo::Column,
            horz_align: HorzAlign::Center,
            vert_align: align,
            text_wrap: TextWrap::TopAndBottom,
            flow_with_text: true,
            vertical_offset: offset,
            ..Default::default()
        },
    );
    wrapper.cells[0].paragraphs = vec![host];
    wrapper.cells[0].vertical_align = VerticalAlign::Center;
    if padding {
        wrapper.cells[0].apply_inner_margin = true;
        wrapper.cells[0].padding = Padding {
            top: 300,
            bottom: 600,
            ..Default::default()
        };
        wrapper.padding = wrapper.cells[0].padding.clone();
    }
    let mut root = Paragraph::new_empty();
    root.controls = vec![Control::Table(Box::new(wrapper))];
    let prefix = Paragraph {
        text: "Before".into(),
        char_count: 7,
        has_para_text: true,
        line_segs: vec![LineSeg {
            line_height: 6_000,
            text_height: 1_000,
            baseline_distance: 850,
            segment_width: 24_000,
            ..Default::default()
        }],
        ..Paragraph::new_empty()
    };
    doc.sections[0].paragraphs = vec![prefix, root];
    core.set_document(doc);
    // Exercise the public loaded HWPX path as well as generated/saved inner geometry.
    DocumentCore::from_bytes(&core.export_hwpx_native().unwrap()).unwrap()
}

fn table_y(node: &RenderNode, width: f64) -> Option<f64> {
    if matches!(node.node_type, RenderNodeType::Table(_)) && (node.bbox.width - width).abs() < 0.1 {
        return Some(node.bbox.y);
    }
    node.children.iter().find_map(|child| table_y(child, width))
}

fn positions(core: &DocumentCore) -> (f64, f64) {
    let tree = core.build_page_render_tree(0).unwrap();
    let mut table_order = Vec::new();
    fn collect(node: &RenderNode, order: &mut Vec<f64>) {
        if matches!(node.node_type, RenderNodeType::Table(_)) {
            order.push(node.bbox.width);
        }
        for child in &node.children {
            collect(child, order);
        }
    }
    collect(&tree.root, &mut table_order);
    let overlay = table_order
        .iter()
        .position(|width| (*width - 2_000.0 / 75.0).abs() < 0.1)
        .unwrap();
    let primary = table_order
        .iter()
        .position(|width| (*width - 10_000.0 / 75.0).abs() < 0.1)
        .unwrap();
    assert!(
        overlay < primary,
        "BehindText sibling must paint before the primary table"
    );
    (
        table_y(&tree.root, 10_000.0 / 75.0).expect("primary"),
        table_y(&tree.root, 2_000.0 / 75.0).expect("overlay sibling"),
    )
}

fn near(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < 0.15, "{actual} != {expected}");
}

#[test]
fn page_anchor_translation_survives_peeling_for_saved_and_fresh_cells() {
    for saved in [false, true] {
        let original = positions(&document(VertAlign::Bottom, 0, saved, false));
        let shifted = positions(&document(VertAlign::Bottom, 3_000, saved, false));
        let top = positions(&document(VertAlign::Top, 0, saved, false));
        near(original.0, 20_250.0 / 75.0);
        near(top.0, 5_250.0 / 75.0);
        near(original.0 - shifted.0, 40.0);
        near(original.1 - shifted.1, 40.0);
        // The shorter overlay shares the same local cell frame, rather than increasing
        // the wrapper's occupied height or disappearing during the peel.
        near(original.0 - original.1, 1_500.0 / 75.0);
    }
}

#[test]
fn wrapper_cell_padding_and_centering_remain_in_the_local_origin() {
    let unpadded = positions(&document(VertAlign::Top, 0, true, false));
    let padded = positions(&document(VertAlign::Top, 0, true, true));
    near(padded.0 - unpadded.0, -150.0 / 75.0);
    near(padded.1 - unpadded.1, -150.0 / 75.0);
}

fn primary_x(core: &DocumentCore) -> f64 {
    fn find(node: &RenderNode) -> Option<f64> {
        if matches!(node.node_type, RenderNodeType::Table(_))
            && (node.bbox.width - 10_000.0 / 75.0).abs() < 0.1
        {
            return Some(node.bbox.x);
        }
        node.children.iter().find_map(find)
    }
    find(&core.build_page_render_tree(0).unwrap().root).unwrap()
}

#[test]
fn parent_and_child_horizontal_offsets_share_the_wrapper_frame() {
    for saved in [false, true] {
        let mut core = document(VertAlign::Bottom, 0, saved, false);
        let original_x = primary_x(&core);
        let mut doc = core.document().clone();
        let mut root_style = doc.doc_info.para_shapes[0].clone();
        root_style.indent = 660;
        let root_style_id = doc.doc_info.para_shapes.len() as u16;
        doc.doc_info.para_shapes.push(root_style);
        doc.sections[0].paragraphs[1].para_shape_id = root_style_id;
        let Control::Table(wrapper) = &mut doc.sections[0].paragraphs[1].controls[0] else {
            panic!("wrapper")
        };
        wrapper.common.horizontal_offset = 3_000;
        core.set_document(doc.clone());
        near(primary_x(&core) - original_x, 40.0);
        let Control::Table(wrapper) = &mut doc.sections[0].paragraphs[1].controls[0] else {
            panic!("wrapper")
        };
        let Control::Table(child) = &mut wrapper.cells[0].paragraphs[0].controls[0] else {
            panic!("child")
        };
        child.common.horizontal_offset = 1_500;
        core.set_document(doc);
        near(primary_x(&core) - original_x, 60.0);
    }
}

#[test]
fn an_overwide_page_wrapper_keeps_signed_centering() {
    let mut core = document(VertAlign::Top, 0, true, false);
    let before = primary_x(&core);
    let mut doc = core.document().clone();
    let Control::Table(wrapper) = &mut doc.sections[0].paragraphs[1].controls[0] else {
        panic!("wrapper")
    };
    wrapper.common.width = 30_000;
    wrapper.cells[0].width = 30_000;
    core.set_document(doc);
    // Widening a centered wrapper moves its own left edge left and the centered child
    // right by equal amounts; clipping negative slack would shift the child instead.
    near(primary_x(&core), before);
}

//! Overlapping local objects must not become a serial pagination stack.
use rhwp::model::control::Control;
use rhwp::model::paragraph::{LineSeg, Paragraph};
use rhwp::model::shape::{CommonObjAttr, HorzAlign, HorzRelTo, TextWrap, VertAlign, VertRelTo};
use rhwp::model::table::{Cell, Table};
use rhwp::renderer::height_measurer::HeightMeasurer;
use rhwp::renderer::style_resolver::ResolvedStyleSet;

fn child(height: u32, wrap: TextWrap, offset: u32) -> Table {
    let mut table = Table {
        row_count: 1,
        col_count: 1,
        common: CommonObjAttr {
            width: 10_000,
            height,
            text_wrap: wrap,
            vert_rel_to: VertRelTo::Para,
            horz_rel_to: HorzRelTo::Para,
            vert_align: VertAlign::Top,
            horz_align: HorzAlign::Center,
            flow_with_text: true,
            vertical_offset: offset,
            ..Default::default()
        },
        cells: vec![Cell {
            width: 10_000,
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
fn wrapper(overlay: bool, grown: bool, saved: bool) -> Table {
    let mut main = child(6_000, TextWrap::TopAndBottom, 1_500);
    if grown {
        main.cells[0].height = 12_000;
    }
    let mut sibling = child(
        4_000,
        if overlay {
            TextWrap::BehindText
        } else {
            TextWrap::TopAndBottom
        },
        0,
    );
    sibling.common.vert_align = VertAlign::Bottom;
    let mut para = Paragraph::new_empty();
    para.line_segs = if saved {
        vec![LineSeg {
            line_height: 1_000,
            text_height: 1_000,
            baseline_distance: 850,
            segment_width: 20_000,
            ..Default::default()
        }]
    } else {
        vec![]
    };
    para.controls = vec![
        Control::Table(Box::new(main)),
        Control::Table(Box::new(sibling)),
    ];
    let mut table = child(7_500, TextWrap::TopAndBottom, 0);
    table.common.width = 20_000;
    table.common.vert_rel_to = VertRelTo::Page;
    table.common.horz_rel_to = HorzRelTo::Column;
    table.common.vert_align = VertAlign::Bottom;
    table.cells[0].width = 20_000;
    table.cells[0].height = 6_000;
    table.cells[0].paragraphs = vec![para];
    table.rebuild_grid();
    table
}
fn height(table: Table, edited: bool) -> f64 {
    let host = Paragraph {
        controls: vec![Control::Table(Box::new(table))],
        ..Paragraph::new_empty()
    };
    HeightMeasurer::new(96.0)
        .with_hwpx_cell_spacing(true)
        .with_native_hwpx_cell_margin(true)
        .with_session_edited(edited)
        .measure_section(&[host], &[], &ResolvedStyleSet::default(), None)
        .tables[0]
        .total_height
}
#[test]
fn local_overlay_uses_occupied_endpoint_instead_of_serial_sum() {
    let h = height(wrapper(true, false, true), false);
    assert!((h - 100.0).abs() < 0.15, "local endpoint: {h}");
}
#[test]
fn a_second_flow_child_keeps_stack_measurement() {
    assert!(height(wrapper(false, false, true), false) > 125.0);
}
#[test]
fn recursive_child_growth_is_not_clamped_to_wrapper_declaration() {
    assert!(height(wrapper(true, true, true), false) > 175.0);
}
#[test]
fn fresh_and_edited_wrappers_keep_existing_measurement() {
    assert!(height(wrapper(true, false, false), false) > 125.0);
    assert!(height(wrapper(true, false, true), true) > 125.0);
}

fn loaded_wrapper(zero_id: bool, duplicate_id: bool) -> rhwp::document_core::DocumentCore {
    use rhwp::document_core::DocumentCore;
    use rhwp::model::provenance::FontMetricsPolicy;
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().unwrap();
    let mut doc = core.document().clone();
    doc.provenance.format = rhwp::model::provenance::SourceFormat::Hwpx;
    let page = &mut doc.sections[0].section_def.page_def;
    page.width = 30_000;
    page.height = 30_000;
    page.margin_left = 3_000;
    page.margin_right = 3_000;
    page.margin_top = 3_000;
    page.margin_bottom = 3_000;
    page.margin_header = 0;
    page.margin_footer = 0;
    let mut table = wrapper(true, false, true);
    table.common.instance_id = if zero_id { 0 } else { 1 };
    for (index, control) in table.cells[0].paragraphs[0].controls.iter_mut().enumerate() {
        if let Control::Table(child) = control {
            child.common.instance_id = if duplicate_id { 1 } else { index as u32 + 2 };
            child.cells[0].paragraphs[0].line_segs = vec![LineSeg {
                line_height: 1_000,
                text_height: 1_000,
                baseline_distance: 850,
                segment_width: 10_000,
                ..Default::default()
            }];
        }
    }
    let before = Paragraph {
        text: "Before".into(),
        char_count: 7,
        has_para_text: true,
        line_segs: vec![LineSeg {
            line_height: 12_500,
            text_height: 1_000,
            baseline_distance: 850,
            segment_width: 24_000,
            ..Default::default()
        }],
        ..Paragraph::new_empty()
    };
    doc.sections[0].paragraphs = vec![
        before,
        Paragraph {
            controls: vec![Control::Table(Box::new(table))],
            ..Paragraph::new_empty()
        },
    ];
    core.set_document(doc);
    DocumentCore::from_bytes_with_font_metrics(
        &rhwp::serializer::hwpx::serialize_hwpx(core.document()).unwrap(),
        FontMetricsPolicy::HcrDeclared,
    )
    .unwrap()
}

fn loaded_table(core: &rhwp::document_core::DocumentCore) -> &Table {
    let Control::Table(table) = &core.document().sections[0].paragraphs[1].controls[0] else {
        panic!("loaded wrapper");
    };
    table
}

#[test]
fn loaded_overlap_keeps_pagination_and_geometry_after_font_refresh() {
    let mut core = loaded_wrapper(false, false);
    assert!(core.document().layout_profile().native_hwpx_cell_margin());
    assert_eq!(
        core.page_count(),
        1,
        "saved overlap fits the remaining body"
    );
    let before = core.get_page_control_layout_native(0).unwrap();
    for _ in 0..2 {
        core.refresh_layout_native();
        assert_eq!(
            core.page_count(),
            1,
            "cache refresh must not create a serial stack"
        );
        assert_eq!(core.get_page_control_layout_native(0).unwrap(), before);
    }
}

#[test]
fn refresh_does_not_exempt_preexisting_dirty_or_ambiguous_wrapper_ids() {
    for (zero, duplicate) in [(true, false), (false, true)] {
        let mut core = loaded_wrapper(zero, duplicate);
        assert_eq!(
            loaded_table(&core).common.instance_id,
            if zero { 0 } else { 1 }
        );
        core.refresh_layout_native();
        assert_eq!(
            core.page_count(),
            2,
            "unproven identity keeps legacy measurement"
        );
    }
    for invalidation in 0..3 {
        let mut core = loaded_wrapper(false, false);
        let Control::Table(table) = &mut core.document_mut().sections[0].paragraphs[1].controls[0]
        else {
            panic!("loaded wrapper");
        };
        match invalidation {
            0 => table.cells[0].dirty_flag = true,
            1 => {
                let Control::Table(child) = &mut table.cells[0].paragraphs[0].controls[0] else {
                    panic!("flow child");
                };
                child.dirty = true;
            }
            _ => table.local_resize_rows.push(0),
        }
        assert!(!table.dirty, "only the root cache is clean");
        core.refresh_layout_native();
        assert_eq!(
            core.page_count(),
            2,
            "nested/cell/resize invalidation is retained"
        );
    }
    for vertical_edit in [false, true] {
        let mut core = loaded_wrapper(false, false);
        let Control::Table(table) = &mut core.document_mut().sections[0].paragraphs[1].controls[0]
        else {
            panic!("loaded wrapper");
        };
        if vertical_edit {
            table.cells[0].vertical_align = rhwp::model::table::VerticalAlign::Center;
        } else {
            table.cells[0].apply_inner_margin = true;
            table.cells[0].padding.top = 500;
        }
        // Cell-property edits invalidate the owner without changing the cell's authored dirty bit.
        table.dirty = true;
        assert!(!table.cells[0].dirty_flag);
        core.refresh_layout_native();
        assert_eq!(
            core.page_count(),
            2,
            "actual dirty owner must not become a refresh exemption"
        );
    }
}

#[test]
fn nested_text_growth_survives_edit_pagination_and_later_refresh() {
    let mut core = loaded_wrapper(false, false);
    let before = height(loaded_table(&core).clone(), false);
    core.insert_text_in_cell_by_path(0, 1, &[(0, 0, 0), (0, 0, 0)], 0, &"Growth\n".repeat(24))
        .unwrap();
    let Control::Table(child) = &loaded_table(&core).cells[0].paragraphs[0].controls[0] else {
        panic!("flow child");
    };
    assert!(child.cells[0].paragraphs[0].line_segs.len() > 1);
    let grown = height(loaded_table(&core).clone(), false);
    assert!(
        grown > before + 40.0,
        "real content grows beyond the wrapper declaration"
    );
    assert!(
        !loaded_table(&core).dirty,
        "ordinary pagination consumed the root cache flag"
    );
    core.refresh_layout_native();
    assert!(
        height(loaded_table(&core).clone(), false) >= grown - 0.15,
        "refresh must retain real nested growth after the root dirty flag was cleared"
    );
}

//! 덧말은 하나의 원본 제어 슬롯을 유지하며 본문 폭만 전진한다.
use rhwp::document_core::DocumentCore;
use rhwp::model::control::{Control, Ruby};
use rhwp::model::document::{Document, Section};
use rhwp::model::paragraph::{CharShapeRef, LineSeg, Paragraph};
use rhwp::model::provenance::SourceFormat;
use rhwp::model::style::{CharShape, ParaShape};
use rhwp::renderer::render_tree::{BoundingBox, RenderNode, RenderNodeType};
use rhwp::renderer::TextStyle;

fn document(bottom: bool, long: bool, saved: bool) -> Document {
    let p = Paragraph {
        text: "AB".into(),
        char_offsets: vec![0, 9],
        char_count: 11,
        char_shapes: vec![
            CharShapeRef {
                start_pos: 0,
                char_shape_id: 0,
            },
            CharShapeRef {
                start_pos: 1,
                char_shape_id: 1,
            },
            CharShapeRef {
                start_pos: 9,
                char_shape_id: 0,
            },
        ],
        controls: vec![Control::Ruby(Ruby {
            main_text: "훈련".into(),
            ruby_text: if long { "a long annotation" } else { "x" }.into(),
            pos_type: u8::from(bottom),
            align: 2,
            sz_ratio: 0,
            option: 0,
            style_id_ref: 0,
        })],
        line_segs: if saved {
            vec![LineSeg {
                line_height: 1950,
                text_height: 1950,
                baseline_distance: 1755,
                segment_width: 30000,
                ..Default::default()
            }]
        } else {
            vec![]
        },
        ..Default::default()
    };
    let mut section = Section::default();
    section.section_def.page_def = rhwp::model::page::PageDef::a4_default();
    section.paragraphs.push(p);
    let mut doc = Document::default();
    doc.provenance.format = SourceFormat::Hwpx;
    doc.is_hwpx_variant = true;
    doc.doc_info.para_shapes.push(ParaShape::default());
    for size in [1000, 1300] {
        doc.doc_info.char_shapes.push(CharShape {
            base_size: size,
            ratios: [100; 7],
            relative_sizes: [100; 7],
            ..Default::default()
        });
    }
    doc.sections.push(section);
    doc
}
fn runs(n: &RenderNode, out: &mut Vec<(String, TextStyle, BoundingBox, f64)>) {
    if let RenderNodeType::TextRun(r) = &n.node_type {
        out.push((
            r.display_text.clone().unwrap_or_else(|| r.text.clone()),
            r.style.clone(),
            n.bbox,
            n.bbox.y + r.baseline,
        ));
    }
    for c in &n.children {
        runs(c, out);
    }
}
#[test]
fn saved_and_fresh_ruby_preserve_anchor_style_and_emit_both_strings_once() {
    for saved in [false, true] {
        let d = document(false, false, saved);
        let original = d.sections[0].paragraphs[0].clone();
        let mut core = DocumentCore::new_empty();
        core.set_document(d);
        let mut r = vec![];
        runs(&core.build_page_render_tree(0).unwrap().root, &mut r);
        let main: Vec<_> = r.iter().filter(|x| x.0 == "훈련").collect();
        let sub: Vec<_> = r.iter().filter(|x| x.0 == "x").collect();
        assert_eq!(main.len(), 1, "{r:?}");
        assert_eq!(sub.len(), 1, "{r:?}");
        assert!((main[0].1.font_size - 1300.0 / 75.0).abs() < 0.01);
        assert!((sub[0].1.font_size * 2.0 - main[0].1.font_size).abs() < 0.01);
        assert!(sub[0].3 < main[0].3);
        let suffix = r.iter().find(|r| r.0 == "B").unwrap();
        assert!(
            (suffix.2.x - main[0].2.x - main[0].2.width).abs() < 0.02,
            "annotation must not advance the ordinary suffix: {r:?}"
        );
        let p = &core.document().sections[0].paragraphs[0];
        assert_eq!(p.text, original.text);
        assert_eq!(p.char_offsets, original.char_offsets);
        assert_eq!(p.controls.len(), 1);
    }
}
#[test]
fn annotation_fitting_changes_width_ratio_and_bottom_moves_baseline_without_shrinking_height() {
    for bottom in [false, true] {
        let mut core = DocumentCore::new_empty();
        core.set_document(document(bottom, true, true));
        let mut r = vec![];
        runs(&core.build_page_render_tree(0).unwrap().root, &mut r);
        let main = r.iter().find(|x| x.0 == "훈련").unwrap();
        let sub = r.iter().find(|x| x.0 == "a long annotation").unwrap();
        assert!(sub.1.ratio < 1.0);
        assert!((sub.1.font_size * 2.0 - main.1.font_size).abs() < 0.01);
        assert!(sub.2.width <= main.2.width + 0.01);
        assert_eq!(sub.3 > main.3, bottom);
    }
}

#[test]
fn ruby_only_cell_and_wrapped_body_keep_one_control_and_roundtrip_attributes() {
    use rhwp::model::shape::CommonObjAttr;
    use rhwp::model::table::{Cell, Table};
    let mut d = document(false, false, false);
    let mut p = d.sections[0].paragraphs.remove(0);
    p.text.clear();
    p.char_offsets.clear();
    p.char_count = 9;
    p.char_shapes = vec![CharShapeRef {
        start_pos: 0,
        char_shape_id: 1,
    }];
    let mut table = Table {
        row_count: 1,
        col_count: 1,
        common: CommonObjAttr {
            width: 10_000,
            height: 5_000,
            treat_as_char: true,
            ..Default::default()
        },
        cells: vec![Cell {
            width: 10_000,
            height: 5_000,
            row_span: 1,
            col_span: 1,
            paragraphs: vec![p],
            ..Default::default()
        }],
        ..Default::default()
    };
    table.rebuild_grid();
    d.sections[0].paragraphs = vec![Paragraph {
        controls: vec![Control::Table(Box::new(table))],
        ..Default::default()
    }];
    let mut core = DocumentCore::new_empty();
    core.set_document(d);
    let mut result = vec![];
    runs(&core.build_page_render_tree(0).unwrap().root, &mut result);
    assert_eq!(
        result.iter().filter(|r| r.0 == "훈련").count(),
        1,
        "{result:?}"
    );
    assert_eq!(result.iter().filter(|r| r.0 == "x").count(), 1);
    let exported = core.export_hwpx_native().unwrap();
    let loaded = DocumentCore::from_bytes(&exported).unwrap();
    let t = loaded.document().sections[0]
        .paragraphs
        .iter()
        .flat_map(|p| &p.controls)
        .find_map(|c| {
            if let Control::Table(t) = c {
                Some(t)
            } else {
                None
            }
        })
        .unwrap();
    let Control::Ruby(r) = &t.cells[0].paragraphs[0].controls[0] else {
        panic!()
    };
    assert_eq!((&*r.main_text, &*r.ruby_text), ("훈련", "x"));
    assert_eq!(
        (r.pos_type, r.align, r.sz_ratio, r.option, r.style_id_ref),
        (0, 2, 0, 0, 0)
    );
    let mut replay = vec![];
    runs(&loaded.build_page_render_tree(0).unwrap().root, &mut replay);
    assert_eq!(replay.iter().filter(|r| r.0 == "훈련").count(), 1);
}

#[test]
fn unsupported_annotation_style_option_preserves_the_original_control() {
    let mut d = document(false, false, true);
    let Control::Ruby(r) = &mut d.sections[0].paragraphs[0].controls[0] else {
        panic!()
    };
    r.option = 4;
    let mut core = DocumentCore::new_empty();
    core.set_document(d);
    let mut result = vec![];
    runs(&core.build_page_render_tree(0).unwrap().root, &mut result);
    assert!(!result.iter().any(|r| r.0 == "훈련"));
    let Control::Ruby(r) = &core.document().sections[0].paragraphs[0].controls[0] else {
        panic!()
    };
    assert_eq!(r.option, 4);
}

#[test]
fn explicit_size_and_horizontal_alignment_keep_independent_annotation_axes() {
    for align in 0..3 {
        let mut d = document(false, false, true);
        let Control::Ruby(r) = &mut d.sections[0].paragraphs[0].controls[0] else {
            panic!()
        };
        r.sz_ratio = 25;
        r.align = align;
        let mut core = DocumentCore::new_empty();
        core.set_document(d);
        let mut all = vec![];
        runs(&core.build_page_render_tree(0).unwrap().root, &mut all);
        let main = all.iter().find(|r| r.0 == "훈련").unwrap();
        let sub = all.iter().find(|r| r.0 == "x").unwrap();
        assert!((sub.1.font_size * 4.0 - main.1.font_size).abs() < 0.01);
        let slack = main.2.width - sub.2.width;
        let offset = match align {
            0 => 0.0,
            1 => slack,
            _ => slack / 2.0,
        };
        assert!((sub.2.x - main.2.x - offset).abs() < 0.01);
    }
}

#[test]
fn paragraph_vertical_alignment_selects_the_main_height_adjustment() {
    for align in 1..4 {
        let mut d = document(false, false, true);
        d.doc_info.para_shapes[0].attr1 = align << 20;
        let mut core = DocumentCore::new_empty();
        core.set_document(d);
        let mut all = vec![];
        runs(&core.build_page_render_tree(0).unwrap().root, &mut all);
        let main = all.iter().find(|r| r.0 == "훈련").unwrap();
        let sub = all.iter().find(|r| r.0 == "x").unwrap();
        let adjustment = match align {
            1 => 0.0,
            2 => main.1.font_size / 2.0,
            _ => main.1.font_size,
        };
        assert!((main.3 - sub.3 - adjustment).abs() < 0.01);
    }
}

#[test]
fn a_saved_ruby_at_an_explicit_line_boundary_paints_once_after_page_fragmentation() {
    let mut d = document(false, false, true);
    let p = &mut d.sections[0].paragraphs[0];
    p.text = "A\nB".into();
    p.char_offsets = vec![0, 1, 10];
    p.char_count = 12;
    p.char_shapes[1].start_pos = 2;
    p.char_shapes[2].start_pos = 10;
    p.line_segs = vec![
        LineSeg {
            text_start: 0,
            line_height: 1_000,
            text_height: 1_000,
            baseline_distance: 850,
            line_spacing: 600,
            segment_width: 30_000,
            ..Default::default()
        },
        LineSeg {
            text_start: 2,
            vertical_pos: 1_600,
            line_height: 1_948,
            text_height: 1_948,
            baseline_distance: 1_753,
            segment_width: 30_000,
            ..Default::default()
        },
    ];
    let page = &mut d.sections[0].section_def.page_def;
    page.height = 3_000;
    page.margin_top = 0;
    page.margin_bottom = 0;
    page.margin_header = 0;
    page.margin_footer = 0;
    let mut core = DocumentCore::new_empty();
    core.set_document(d);
    assert_eq!(core.page_count(), 2);
    let mut all = vec![];
    let mut first = vec![];
    runs(&core.build_page_render_tree(0).unwrap().root, &mut first);
    assert!(!first.iter().any(|r| r.0 == "훈련"));
    for page in 0..core.page_count() {
        runs(&core.build_page_render_tree(page).unwrap().root, &mut all);
    }
    assert_eq!(all.iter().filter(|r| r.0 == "훈련").count(), 1, "{all:?}");
    assert_eq!(all.iter().filter(|r| r.0 == "x").count(), 1);
}

#[test]
fn metadata_does_not_steal_extended_ruby_slots_or_suffix_advance() {
    for saved in [false, true] {
        for metadata_first in [false, true] {
            for location in 0..3 {
                let mut d = document(false, false, saved);
                d.doc_info.char_shapes.push(CharShape {
                    base_size: 2000,
                    ratios: [100; 7],
                    relative_sizes: [100; 7],
                    ..Default::default()
                });
                let p = &mut d.sections[0].paragraphs[0];
                let first = p.controls[0].clone();
                let mut second = first.clone();
                let Control::Ruby(r) = &mut second else {
                    panic!()
                };
                r.main_text = "점검".into();
                r.ruby_text = "y".into();
                let bookmark = Control::Bookmark(Default::default());
                let comment = Control::HiddenComment(Default::default());
                p.controls = if metadata_first {
                    vec![bookmark, first, comment, second]
                } else {
                    vec![first, bookmark, second, comment]
                };
                p.char_offsets = vec![0, 17];
                p.char_count = 19;
                p.char_shapes = vec![
                    CharShapeRef {
                        start_pos: 0,
                        char_shape_id: 0,
                    },
                    CharShapeRef {
                        start_pos: 1,
                        char_shape_id: 1,
                    },
                    CharShapeRef {
                        start_pos: 9,
                        char_shape_id: 2,
                    },
                    CharShapeRef {
                        start_pos: 17,
                        char_shape_id: 0,
                    },
                ];
                if location == 1 {
                    p.text = "A".into();
                    p.char_offsets = vec![0];
                    p.char_count = 18;
                } else if location == 2 {
                    p.text.clear();
                    p.char_offsets.clear();
                    p.char_count = 17;
                    p.char_shapes = vec![
                        CharShapeRef {
                            start_pos: 0,
                            char_shape_id: 1,
                        },
                        CharShapeRef {
                            start_pos: 8,
                            char_shape_id: 2,
                        },
                    ];
                }
                let original = p.clone();
                let mut core = DocumentCore::new_empty();
                core.set_document(d);
                let mut all = vec![];
                runs(&core.build_page_render_tree(0).unwrap().root, &mut all);
                let prefix = all.iter().find(|r| r.0 == "A");
                let main = all.iter().find(|r| r.0 == "훈련").unwrap();
                let next = all.iter().find(|r| r.0 == "점검").unwrap_or_else(|| panic!("location={location}, saved={saved}, metadata_first={metadata_first}, runs={all:?}"));
                let suffix = all.iter().find(|r| r.0 == "B");
                assert_eq!(all.iter().filter(|r| r.0 == "훈련").count(), 1);
                assert_eq!(all.iter().filter(|r| r.0 == "점검").count(), 1);
                assert!((main.1.font_size - 1300.0 / 75.0).abs() < 0.01);
                assert!((next.1.font_size - 2000.0 / 75.0).abs() < 0.01);
                if let Some(prefix) = prefix {
                    assert!(
                        (main.2.x - prefix.2.x - prefix.2.width).abs() < 0.02,
                        "{all:?}"
                    );
                }
                assert!((next.2.x - main.2.x - main.2.width).abs() < 0.02, "{all:?}");
                if let Some(suffix) = suffix {
                    assert!(
                        (suffix.2.x - next.2.x - next.2.width).abs() < 0.02,
                        "{all:?}"
                    );
                }
                let actual = &core.document().sections[0].paragraphs[0];
                assert_eq!(actual.text, original.text);
                assert_eq!(actual.char_offsets, original.char_offsets);
                assert_eq!(actual.char_count, original.char_count);
                assert_eq!(
                    format!("{:?}", actual.controls),
                    format!("{:?}", original.controls)
                );
                assert_eq!(
                    format!("{:?}", actual.char_shapes),
                    format!("{:?}", original.char_shapes)
                );
            }
        }
    }
}

#[test]
fn textless_ruby_controls_keep_distinct_owners_when_width_forces_two_lines() {
    let mut d = document(false, false, false);
    d.doc_info.char_shapes.push(CharShape {
        base_size: 2000,
        ratios: [100; 7],
        relative_sizes: [100; 7],
        ..Default::default()
    });
    let p = &mut d.sections[0].paragraphs[0];
    let first = p.controls[0].clone();
    let mut second = first.clone();
    let Control::Ruby(r) = &mut second else {
        panic!()
    };
    r.main_text = "점검".into();
    r.ruby_text = "y".into();
    p.controls = vec![
        Control::Bookmark(Default::default()),
        first,
        Control::HiddenComment(Default::default()),
        second,
    ];
    p.text.clear();
    p.char_offsets.clear();
    p.char_count = 17;
    p.char_shapes = vec![
        CharShapeRef {
            start_pos: 0,
            char_shape_id: 1,
        },
        CharShapeRef {
            start_pos: 8,
            char_shape_id: 2,
        },
    ];
    let original = p.clone();
    let page = &mut d.sections[0].section_def.page_def;
    page.width = 4500;
    page.margin_left = 0;
    page.margin_right = 0;
    let styles = rhwp::renderer::style_resolver::resolve_styles(&d.doc_info, 96.0);
    let mut composed = rhwp::renderer::composer::compose_paragraph(&original);
    rhwp::renderer::composer::recompose_for_body_width(&mut composed, &original, 60.0, &styles);
    assert_eq!(composed.lines.len(), 2);
    let mut core = DocumentCore::new_empty();
    core.set_document(d);
    let mut all = vec![];
    runs(&core.build_page_render_tree(0).unwrap().root, &mut all);
    let main = all.iter().find(|r| r.0 == "훈련").unwrap();
    let next = all.iter().find(|r| r.0 == "점검").unwrap();
    for text in ["훈련", "점검", "x", "y"] {
        assert_eq!(all.iter().filter(|r| r.0 == text).count(), 1, "{all:?}");
    }
    assert!(
        next.3 > main.3,
        "separate packed lines must retain distinct owners: {all:?}"
    );
    let main_index = all.iter().position(|r| r.0 == "훈련").unwrap();
    let next_index = all.iter().position(|r| r.0 == "점검").unwrap();
    assert!(main_index < next_index);
    let actual = &core.document().sections[0].paragraphs[0];
    assert_eq!(actual.text, original.text);
    assert_eq!(actual.char_offsets, original.char_offsets);
    assert_eq!(actual.char_count, original.char_count);
    assert_eq!(
        format!("{:?}", actual.controls),
        format!("{:?}", original.controls)
    );
    assert_eq!(
        format!("{:?}", actual.char_shapes),
        format!("{:?}", original.char_shapes)
    );
}

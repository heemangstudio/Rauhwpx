//! Saved RHWP line caches retain interval tabs; native caches retain resolved movement.
use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::document::{
    Document, HWP5_ORIGIN_HWPX_MARKER_PATH, OWN_LINE_LAYOUT_HWPX_MARKER_PATH, RAW_FIELDS_HWPX_PATH,
};
use rhwp::model::footnote::{Endnote, Footnote};
use rhwp::model::header_footer::{Footer, Header, MasterPage};
use rhwp::model::paragraph::{LineSeg, Paragraph};
use rhwp::model::shape::{Caption, CommonObjAttr, RectangleShape, ShapeObject, TextBox};
use rhwp::model::table::{Cell, Table};
use rhwp::parser::hwpx::{parse_hwpx, section};
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};
use rhwp::serializer::serialize_hwpx;
use std::io::{Cursor, Read, Write};

fn tab_paragraph(label: &str, saved: bool) -> Paragraph {
    let text = format!("A\t{label}");
    Paragraph {
        char_count: text.chars().count() as u32 + 8,
        text,
        has_para_text: true,
        tab_extended: vec![[4000, 0, 0x0100, 0, 0, 0x8000, 9]],
        line_segs: if saved {
            vec![LineSeg {
                line_height: 1000,
                text_height: 1000,
                baseline_distance: 850,
                segment_width: 20000,
                tag: 393216,
                ..Default::default()
            }]
        } else {
            Vec::new()
        },
        ..Paragraph::new_empty()
    }
}

fn table(paragraphs: Vec<Paragraph>, caption: Option<Caption>) -> Table {
    let mut table = Table {
        row_count: 1,
        col_count: 1,
        common: CommonObjAttr {
            width: 20000,
            height: 3000,
            treat_as_char: true,
            flow_with_text: true,
            ..Default::default()
        },
        cells: vec![Cell {
            width: 20000,
            height: 3000,
            row_span: 1,
            col_span: 1,
            paragraphs,
            ..Default::default()
        }],
        caption,
        ..Default::default()
    };
    table.rebuild_grid();
    table
}

fn table_host(paragraphs: Vec<Paragraph>, caption: Option<Caption>) -> Paragraph {
    let mut host = Paragraph::new_empty();
    host.line_segs.clear();
    host.controls = vec![Control::Table(Box::new(table(paragraphs, caption)))];
    host
}

fn document(saved: bool) -> Document {
    let mut doc = parse_hwpx(include_bytes!("../../samples/hwpx/ref/ref_empty.hwpx")).unwrap();
    doc.provenance.own_line_layout = true;
    doc.sections[0].paragraphs = vec![
        Paragraph::new_empty(),
        tab_paragraph("body", saved),
        table_host(
            vec![
                tab_paragraph("cell", saved),
                table_host(vec![tab_paragraph("nested", saved)], None),
            ],
            None,
        ),
    ];
    doc
}

fn tabs(doc: &Document) -> Vec<(String, [u16; 7])> {
    fn collect(paragraphs: &[Paragraph], result: &mut Vec<(String, [u16; 7])>) {
        for para in paragraphs {
            for tab in &para.tab_extended {
                result.push((para.text.clone(), *tab));
            }
            for ctrl in &para.controls {
                match ctrl {
                    Control::Table(table) => {
                        for cell in &table.cells {
                            collect(&cell.paragraphs, result);
                        }
                        if let Some(caption) = &table.caption {
                            collect(&caption.paragraphs, result);
                        }
                    }
                    Control::Header(header) => collect(&header.paragraphs, result),
                    Control::Footer(footer) => collect(&footer.paragraphs, result),
                    Control::Footnote(note) => collect(&note.paragraphs, result),
                    Control::Endnote(note) => collect(&note.paragraphs, result),
                    Control::Shape(shape) => {
                        if let Some(drawing) = shape.drawing() {
                            if let Some(text_box) = &drawing.text_box {
                                collect(&text_box.paragraphs, result);
                            }
                            if let Some(caption) = &drawing.caption {
                                collect(&caption.paragraphs, result);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    let mut result = Vec::new();
    for section in &doc.sections {
        collect(&section.paragraphs, &mut result);
        for master in &section.section_def.master_pages {
            collect(&master.paragraphs, &mut result);
        }
    }
    result
}

#[test]
fn owned_saved_tabs_survive_recursive_package_roundtrips() {
    let mut doc = document(true);
    let mut controls = vec![
        Control::Header(Box::new(Header {
            paragraphs: vec![tab_paragraph("header", true)],
            ..Default::default()
        })),
        Control::Footer(Box::new(Footer {
            paragraphs: vec![tab_paragraph("footer", true)],
            ..Default::default()
        })),
        Control::Footnote(Box::new(Footnote {
            paragraphs: vec![tab_paragraph("footnote", true)],
            ..Default::default()
        })),
        Control::Endnote(Box::new(Endnote {
            paragraphs: vec![tab_paragraph("endnote", true)],
            ..Default::default()
        })),
    ];
    let mut rectangle = RectangleShape::default();
    rectangle.drawing.text_box = Some(TextBox {
        paragraphs: vec![tab_paragraph("drawing", true)],
        ..Default::default()
    });
    rectangle.drawing.caption = Some(Caption {
        paragraphs: vec![tab_paragraph("shape-caption", true)],
        ..Default::default()
    });
    controls.push(Control::Shape(Box::new(ShapeObject::Rectangle(rectangle))));
    let mut host = table_host(
        vec![tab_paragraph("caption-cell", true)],
        Some(Caption {
            paragraphs: vec![tab_paragraph("table-caption", true)],
            ..Default::default()
        }),
    );
    host.controls.extend(controls);
    doc.sections[0].paragraphs.push(host);
    doc.sections[0].section_def.master_pages.push(MasterPage {
        paragraphs: vec![
            tab_paragraph("master", true),
            table_host(vec![tab_paragraph("master-cell", true)], None),
        ],
        ..Default::default()
    });
    let expected = tabs(&doc);
    assert_eq!(expected.len(), 13);
    for _ in 0..2 {
        doc = parse_hwpx(&serialize_hwpx(&doc).unwrap()).unwrap();
        assert!(doc.layout_profile().own_line_layout());
        assert_eq!(
            tabs(&doc),
            expected,
            "saved tabs changed their interval semantics"
        );
    }
}

fn text_geometry(core: &DocumentCore) -> Vec<serde_json::Value> {
    fn collect(node: &RenderNode, result: &mut Vec<serde_json::Value>) {
        if let RenderNodeType::TextRun(run) = &node.node_type {
            result.push(serde_json::json!({
                "text": run.text, "bbox": node.bbox, "baseline": run.baseline,
                "inline_tabs": run.style.inline_tabs,
            }));
        }
        for child in &node.children {
            collect(child, result);
        }
    }
    let mut result = Vec::new();
    for page in 0..core.page_count() {
        collect(
            &core.build_page_render_tree(page).unwrap().root,
            &mut result,
        );
    }
    result
}

fn assert_tab_geometry_roundtrip(saved: bool) {
    let mut core = DocumentCore::from_bytes(&serialize_hwpx(&document(saved)).unwrap()).unwrap();
    let before = text_geometry(&core);
    assert!(!before.is_empty());
    assert!(before
        .iter()
        .any(|run| run["text"].as_str().unwrap().contains("nested")));
    let expected_tabs = tabs(core.document());
    assert_eq!(expected_tabs.len(), 3);
    assert!(expected_tabs.iter().all(|(_, tab)| tab[5] == 0x8000));
    for _ in 0..2 {
        let saved = core.export_hwpx_native().unwrap();
        let parsed = parse_hwpx(&saved).unwrap();
        assert!(tabs(&parsed).iter().all(|(_, tab)| tab[5] == 0x8000));
        core = DocumentCore::from_bytes(&saved).unwrap();
        assert_eq!(tabs(core.document()), expected_tabs);
        assert_eq!(
            text_geometry(&core),
            before,
            "tab geometry changed after reopening"
        );
    }
}

#[test]
fn owned_saved_body_and_nested_cell_tab_geometry_survives_save_reopen() {
    assert_tab_geometry_roundtrip(true);
}

#[test]
fn uncached_body_and_nested_cell_tab_geometry_survives_save_reopen() {
    assert_tab_geometry_roundtrip(false);
}

fn markers(bytes: &[u8], own: Option<&[u8]>, hwp5: bool) -> Vec<u8> {
    let mut input = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut output = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    for index in 0..input.len() {
        let mut entry = input.by_index(index).unwrap();
        let name = entry
            .name()
            .expect("serialized ZIP entry names are valid UTF-8")
            .into_owned();
        if name == OWN_LINE_LAYOUT_HWPX_MARKER_PATH
            || name == HWP5_ORIGIN_HWPX_MARKER_PATH
            || name == RAW_FIELDS_HWPX_PATH
        {
            continue;
        }
        output.start_file(name, options).unwrap();
        let mut payload = Vec::new();
        entry.read_to_end(&mut payload).unwrap();
        output.write_all(&payload).unwrap();
    }
    if let Some(own) = own {
        output
            .start_file(OWN_LINE_LAYOUT_HWPX_MARKER_PATH, options)
            .unwrap();
        output.write_all(own).unwrap();
    }
    if hwp5 {
        output
            .start_file(HWP5_ORIGIN_HWPX_MARKER_PATH, options)
            .unwrap();
        output.write_all(b"1").unwrap();
    }
    output.finish().unwrap().into_inner()
}

#[test]
fn native_unmarked_malformed_and_hwp5_origin_caches_keep_resolved_tabs() {
    let bytes = serialize_hwpx(&document(true)).unwrap();
    for marker in [
        None,
        Some(&b""[..]),
        Some(&b"0"[..]),
        Some(&b"11"[..]),
        Some(&b"1\n"[..]),
    ] {
        let parsed = parse_hwpx(&markers(&bytes, marker, false)).unwrap();
        assert!(!parsed.layout_profile().own_line_layout());
        assert_eq!(tabs(&parsed).len(), 3);
        assert!(tabs(&parsed).iter().all(|(_, tab)| tab[5] == 0x4000));
        let reparsed = parse_hwpx(&serialize_hwpx(&parsed).unwrap()).unwrap();
        assert_eq!(tabs(&reparsed), tabs(&parsed));
    }
    let parsed = parse_hwpx(&markers(&bytes, Some(b"1"), true)).unwrap();
    assert!(parsed.layout_profile().hwp5_origin_hwpx());
    assert!(!parsed.layout_profile().own_line_layout());
    assert!(tabs(&parsed).iter().all(|(_, tab)| tab[5] == 0x4000));
}

#[test]
fn legacy_section_and_master_page_entry_points_keep_native_default() {
    let bytes = serialize_hwpx(&document(true)).unwrap();
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut xml = String::new();
    zip.by_name("Contents/section0.xml")
        .unwrap()
        .read_to_string(&mut xml)
        .unwrap();
    let parsed = section::parse_hwpx_section(&xml).unwrap();
    assert_eq!(parsed.paragraphs[1].tab_extended[0][5], 0x4000);
    let master =
        section::parse_hwpx_master_page(&format!("<masterPage>{xml}</masterPage>")).unwrap();
    assert_eq!(master.paragraphs[1].tab_extended[0][5], 0x4000);
}

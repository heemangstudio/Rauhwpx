//! Raw tab semantics belong to each emitted tab, independently of cache provenance.
use std::collections::BTreeMap;
use std::io::{Cursor, Read, Write};

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
use serde_json::{json, Value};

fn paragraph(label: &str, flags: &[u16]) -> Paragraph {
    let text = format!("{label}{}end", "\t".repeat(flags.len()));
    Paragraph {
        char_count: text.chars().count() as u32 + 7 * flags.len() as u32 + 1,
        text,
        has_para_text: true,
        tab_extended: flags
            .iter()
            .enumerate()
            .map(|(i, &flag)| [4000 + i as u16 * 100, 0, 0x0100 + i as u16, 0, 0, flag, 9])
            .collect(),
        line_segs: vec![LineSeg {
            line_height: 1000,
            text_height: 1000,
            baseline_distance: 850,
            segment_width: 20000,
            tag: 393216,
            ..Default::default()
        }],
        ..Paragraph::new_empty()
    }
}

fn table_host(paragraphs: Vec<Paragraph>, caption: Option<Caption>) -> Paragraph {
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
    let mut host = Paragraph::new_empty();
    host.line_segs.clear();
    host.controls.push(Control::Table(Box::new(table)));
    host
}

fn document(nested: bool) -> Document {
    let mut doc = parse_hwpx(include_bytes!("../../samples/hwpx/ref/ref_empty.hwpx")).unwrap();
    doc.sections[0].paragraphs = vec![
        Paragraph::new_empty(),
        paragraph("body", &[0, 0x8000, 0x4000]),
        paragraph("second", &[0x8000]),
    ];
    // XML mutations below address these paragraphs by explicit stored IDs.
    // New model paragraphs have no imported ID and serialize as 0.
    for (id, para) in doc.sections[0].paragraphs.iter_mut().enumerate() {
        para.raw_header_extra = vec![0; 10];
        para.raw_header_extra[6..10].copy_from_slice(&(id as u32).to_le_bytes());
    }
    if nested {
        let mut host = table_host(
            vec![
                paragraph("cell", &[0]),
                table_host(vec![paragraph("nested", &[0x4000])], None),
            ],
            Some(Caption {
                paragraphs: vec![paragraph("table-caption", &[0x8000])],
                ..Default::default()
            }),
        );
        host.controls.extend([
            Control::Header(Box::new(Header {
                paragraphs: vec![paragraph("header", &[0])],
                ..Default::default()
            })),
            Control::Footer(Box::new(Footer {
                paragraphs: vec![paragraph("footer", &[0x4000])],
                ..Default::default()
            })),
            Control::Footnote(Box::new(Footnote {
                paragraphs: vec![paragraph("footnote", &[0x8000])],
                ..Default::default()
            })),
            Control::Endnote(Box::new(Endnote {
                paragraphs: vec![paragraph("endnote", &[0])],
                ..Default::default()
            })),
        ]);
        let mut rectangle = RectangleShape::default();
        rectangle.drawing.text_box = Some(TextBox {
            paragraphs: vec![paragraph("drawing", &[0x4000])],
            ..Default::default()
        });
        rectangle.drawing.caption = Some(Caption {
            paragraphs: vec![paragraph("shape-caption", &[0])],
            ..Default::default()
        });
        host.controls
            .push(Control::Shape(Box::new(ShapeObject::Rectangle(rectangle))));
        doc.sections[0].paragraphs.push(host);
        doc.sections[0].section_def.master_pages.push(MasterPage {
            paragraphs: vec![
                paragraph("master", &[0x8000]),
                table_host(vec![paragraph("master-cell", &[0])], None),
            ],
            ..Default::default()
        });
    }
    doc
}

fn entries(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    (0..zip.len())
        .map(|index| {
            let mut entry = zip.by_index(index).unwrap();
            let name = entry
                .name()
                .expect("serialized ZIP entry names are valid UTF-8")
                .into_owned();
            let mut payload = Vec::new();
            entry.read_to_end(&mut payload).unwrap();
            (name, payload)
        })
        .collect()
}

fn package(entries: &BTreeMap<String, Vec<u8>>) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, payload) in entries {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(payload).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn tabs(doc: &Document) -> BTreeMap<String, Vec<[u16; 7]>> {
    fn collect(paragraphs: &[Paragraph], out: &mut BTreeMap<String, Vec<[u16; 7]>>) {
        for para in paragraphs {
            if !para.tab_extended.is_empty() {
                assert!(out
                    .insert(para.text.clone(), para.tab_extended.clone())
                    .is_none());
            }
            for control in &para.controls {
                match control {
                    Control::Table(table) => {
                        for cell in &table.cells {
                            collect(&cell.paragraphs, out);
                        }
                        if let Some(caption) = &table.caption {
                            collect(&caption.paragraphs, out);
                        }
                    }
                    Control::Header(h) => collect(&h.paragraphs, out),
                    Control::Footer(h) => collect(&h.paragraphs, out),
                    Control::Footnote(n) => collect(&n.paragraphs, out),
                    Control::Endnote(n) => collect(&n.paragraphs, out),
                    Control::Shape(shape) => {
                        if let Some(drawing) = shape.drawing() {
                            if let Some(text) = &drawing.text_box {
                                collect(&text.paragraphs, out);
                            }
                            if let Some(caption) = &drawing.caption {
                                collect(&caption.paragraphs, out);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    let mut result = BTreeMap::new();
    for section in &doc.sections {
        collect(&section.paragraphs, &mut result);
        for master in &section.section_def.master_pages {
            collect(&master.paragraphs, &mut result);
        }
    }
    result
}

#[test]
fn raw_tabs_survive_nested_routes_and_both_origin_profiles() {
    let source = document(true);
    let expected = tabs(&source);
    assert_eq!(expected.len(), 13);
    for hwp5 in [false, true] {
        for own in [false, true] {
            let mut zip = entries(&serialize_hwpx(&source).unwrap());
            zip.remove(HWP5_ORIGIN_HWPX_MARKER_PATH);
            zip.remove(OWN_LINE_LAYOUT_HWPX_MARKER_PATH);
            if hwp5 {
                zip.insert(HWP5_ORIGIN_HWPX_MARKER_PATH.into(), b"1".to_vec());
            }
            if own {
                zip.insert(OWN_LINE_LAYOUT_HWPX_MARKER_PATH.into(), b"1".to_vec());
            }
            for (name, xml) in &zip {
                if name.ends_with(".xml") {
                    assert!(!String::from_utf8_lossy(xml).contains("rhwpRawTabFlags"));
                }
            }
            let mut doc = parse_hwpx(&package(&zip)).unwrap();
            for _ in 0..2 {
                assert_eq!(doc.layout_profile().hwp5_origin_hwpx(), hwp5);
                assert_eq!(doc.layout_profile().own_line_layout(), own && !hwp5);
                assert_eq!(tabs(&doc), expected);
                doc = parse_hwpx(&serialize_hwpx(&doc).unwrap()).unwrap();
            }
            assert_eq!(tabs(&doc), expected);
        }
    }
}

fn geometry(core: &DocumentCore) -> Vec<Value> {
    fn collect(node: &RenderNode, out: &mut Vec<Value>) {
        if let RenderNodeType::TextRun(run) = &node.node_type {
            out.push(json!({"text": run.text, "bbox": node.bbox, "baseline": run.baseline, "tabs": run.style.inline_tabs}));
        }
        for child in &node.children {
            collect(child, out);
        }
    }
    let mut out = Vec::new();
    for page in 0..core.page_count() {
        collect(&core.build_page_render_tree(page).unwrap().root, &mut out);
    }
    out
}

#[test]
fn raw_tab_geometry_survives_public_save_reopen() {
    let mut doc = document(false);
    doc.sections[0].paragraphs.push(table_host(
        vec![
            paragraph("cell", &[0]),
            table_host(vec![paragraph("nested", &[0x4000])], None),
        ],
        None,
    ));
    let mut core = DocumentCore::from_bytes(&serialize_hwpx(&doc).unwrap()).unwrap();
    let before = geometry(&core);
    assert!(!before.is_empty());
    assert!(before
        .iter()
        .any(|run| run["text"].as_str().unwrap().contains("nested")));
    let expected = tabs(core.document());
    for _ in 0..2 {
        core = DocumentCore::from_bytes(&core.export_hwpx_native().unwrap()).unwrap();
        assert_eq!(tabs(core.document()), expected);
        assert_eq!(geometry(&core), before);
    }
}

fn assert_native(zip: &BTreeMap<String, Vec<u8>>, case: &str) {
    let parsed = parse_hwpx(&package(zip)).unwrap();
    assert!(
        tabs(&parsed).values().flatten().all(|tab| tab[5] == 0x4000),
        "{case}"
    );
}

#[test]
fn malformed_stale_or_ambiguous_tab_metadata_keeps_native_defaults() {
    let original = entries(&serialize_hwpx(&document(false)).unwrap());
    let metadata: Value = serde_json::from_slice(&original[RAW_FIELDS_HWPX_PATH]).unwrap();
    let mut removed = original.clone();
    removed.remove(RAW_FIELDS_HWPX_PATH);
    assert_native(&removed, "absent sidecar");
    for mutation in 0..8 {
        let mut value = metadata.clone();
        match mutation {
            0 => value["version"] = json!(2),
            1 => {
                let duplicate = value["parts"][0]["tabs"][0].clone();
                value["parts"][0]["tabs"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            2 => value["parts"][0]["tabs"][0]["flags"] = json!(65536),
            3 => value["parts"][0]["tabs"][0]["key"]["width"] = json!(123),
            4 => value["parts"][0]["tabs"][0]["key"]["ordinal"] = json!(99),
            5 => value["parts"][0]["tabs"][0]["key"]["paragraph_id"] = json!(99),
            6 => value["parts"][0]["tabs"][0]["key"]["route"] = json!(vec![0; 257]),
            7 => value["unexpected"] = json!(true),
            _ => unreachable!(),
        }
        let mut zip = original.clone();
        zip.insert(
            RAW_FIELDS_HWPX_PATH.into(),
            serde_json::to_vec(&value).unwrap(),
        );
        assert_native(&zip, &format!("malformed metadata case {mutation}"));
    }
    let original_xml = String::from_utf8(original["Contents/section0.xml"].clone()).unwrap();
    for (case, xml) in [
        (
            "changed tab leader",
            original_xml.replace("leader=\"0\"", "leader=\"2\""),
        ),
        (
            "changed paragraph ID",
            original_xml.replace("<hp:p id=\"1\"", "<hp:p id=\"2\""),
        ),
    ] {
        assert_ne!(
            xml, original_xml,
            "stale-metadata mutation must change the XML"
        );
        let mut zip = original.clone();
        zip.insert("Contents/section0.xml".into(), xml.into_bytes());
        assert_native(&zip, case);
    }
    let mut reordered = original.clone();
    let xml = String::from_utf8(original["Contents/section0.xml"].clone()).unwrap();
    let start1 = xml.find("<hp:p id=\"1\"").unwrap();
    let end1 = start1 + xml[start1..].find("</hp:p>").unwrap() + "</hp:p>".len();
    let start2 = xml.find("<hp:p id=\"2\"").unwrap();
    let end2 = start2 + xml[start2..].find("</hp:p>").unwrap() + "</hp:p>".len();
    let changed = format!(
        "{}{}{}{}{}",
        &xml[..start1],
        &xml[start2..end2],
        &xml[end1..start2],
        &xml[start1..end1],
        &xml[end2..]
    );
    assert_ne!(changed, xml, "paragraph reorder must change the XML");
    reordered.insert("Contents/section0.xml".into(), changed.into_bytes());
    assert_native(&reordered, "reordered paragraphs");
    for payload in [b"{".to_vec(), vec![b' '; 16 * 1024 * 1024 + 1]] {
        let mut zip = original.clone();
        zip.insert(RAW_FIELDS_HWPX_PATH.into(), payload);
        assert_native(&zip, "invalid JSON or oversized sidecar");
    }
}

#[test]
fn duplicate_paragraph_ids_are_bound_by_structure_and_ordinal() {
    let source = document(false);
    let mut zip = entries(&serialize_hwpx(&source).unwrap());
    let mut xml = String::from_utf8(zip["Contents/section0.xml"].clone()).unwrap();
    let mut cursor = 0;
    while let Some(relative) = xml[cursor..].find("<hp:p id=\"") {
        let start = cursor + relative + "<hp:p id=\"".len();
        let end = start + xml[start..].find('"').unwrap();
        xml.replace_range(start..end, "7");
        cursor = start + 1;
    }
    let mut value: Value = serde_json::from_slice(&zip[RAW_FIELDS_HWPX_PATH]).unwrap();
    value["parts"][0]["digest"] = json!(*blake3::hash(xml.as_bytes()).as_bytes());
    for tab in value["parts"][0]["tabs"].as_array_mut().unwrap() {
        tab["key"]["paragraph_id"] = json!(7);
    }
    zip.insert("Contents/section0.xml".into(), xml.into_bytes());
    zip.insert(
        RAW_FIELDS_HWPX_PATH.into(),
        serde_json::to_vec(&value).unwrap(),
    );
    assert_eq!(tabs(&parse_hwpx(&package(&zip)).unwrap()), tabs(&source));
    let records = value["parts"][0]["tabs"].as_array_mut().unwrap();
    records.swap(0, 3); // Payload order cannot change the addressed tab.
    zip.insert(
        RAW_FIELDS_HWPX_PATH.into(),
        serde_json::to_vec(&value).unwrap(),
    );
    assert_eq!(tabs(&parse_hwpx(&package(&zip)).unwrap()), tabs(&source));
}

#[test]
fn inbound_carriers_and_stale_passthrough_cannot_override_raw_tabs() {
    let mut zip = entries(&serialize_hwpx(&document(false)).unwrap());
    zip.remove(RAW_FIELDS_HWPX_PATH);
    let xml = String::from_utf8(zip["Contents/section0.xml"].clone())
        .unwrap()
        .replace("<hp:tab ", "<hp:tab rhwpRawTabFlags=\"0\" ");
    zip.insert("Contents/section0.xml".into(), xml.clone().into_bytes());
    assert_native(&zip, "untrusted inbound carrier");
    assert_eq!(
        section::parse_hwpx_section(&xml).unwrap().paragraphs[1].tab_extended[0][5],
        0x4000
    );
    assert_eq!(
        section::parse_hwpx_master_page(&format!("<masterPage>{xml}</masterPage>"))
            .unwrap()
            .paragraphs[1]
            .tab_extended[0][5],
        0x4000
    );
    let mut doc = document(false);
    doc.hwpx_aux_entries
        .push((RAW_FIELDS_HWPX_PATH.into(), b"stale payload".to_vec()));
    doc.sections[0].paragraphs[1].tab_extended[0][5] = 0x4000;
    assert_eq!(
        tabs(&parse_hwpx(&serialize_hwpx(&doc).unwrap()).unwrap()),
        tabs(&doc)
    );
}

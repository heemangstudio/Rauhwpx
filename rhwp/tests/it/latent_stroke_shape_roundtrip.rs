//! Inactive raw stroke shapes survive engine saves without enabling decoration.
use std::collections::BTreeMap;
use std::io::{Cursor, Read, Write};

use rhwp::document_core::DocumentCore;
use rhwp::model::document::{Document, RAW_FIELDS_HWPX_PATH};
use rhwp::model::paragraph::{CharShapeRef, Paragraph};
use rhwp::model::style::UnderlineType;
use rhwp::parser::hwpx::parse_hwpx;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};
use rhwp::serializer::serialize_hwpx;
use serde_json::{json, Value};

fn document(active: bool) -> Document {
    let mut doc = parse_hwpx(include_bytes!("../../samples/hwpx/ref/ref_empty.hwpx")).unwrap();
    let base = doc.doc_info.char_shapes[0].clone();
    doc.doc_info.char_shapes = (0..=if active { 12 } else { 15 })
        .map(|raw| {
            let mut cs = base.clone();
            cs.underline_type = if active {
                UnderlineType::Bottom
            } else {
                UnderlineType::None
            };
            cs.strikethrough = active;
            cs.underline_shape = raw;
            cs.strike_shape = raw;
            cs
        })
        .collect();
    doc.sections[0].paragraphs = doc
        .doc_info
        .char_shapes
        .iter()
        .enumerate()
        .map(|(id, _)| Paragraph {
            text: "*".into(),
            char_count: 2,
            has_para_text: true,
            char_shapes: vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: id as u32,
            }],
            line_segs: Vec::new(),
            ..Paragraph::new_empty()
        })
        .collect();
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

fn char_blocks(xml: &str) -> Vec<&str> {
    let mut blocks = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = xml[cursor..].find("<hh:charPr ") {
        let start = cursor + relative;
        let end = start + xml[start..].find("</hh:charPr>").unwrap() + "</hh:charPr>".len();
        blocks.push(&xml[start..end]);
        cursor = end;
    }
    blocks
}

fn assert_no_decoration(bytes: &[u8]) {
    fn collect(node: &RenderNode, seen: &mut usize) {
        if let RenderNodeType::TextRun(run) = &node.node_type {
            if run.text.contains('*') {
                *seen += 1;
                assert_eq!(run.style.underline, UnderlineType::None);
                assert!(!run.style.strikethrough);
            }
        }
        for child in &node.children {
            collect(child, seen);
        }
    }
    let core = DocumentCore::from_bytes(bytes).unwrap();
    let mut seen = 0;
    for page in 0..core.page_count() {
        collect(&core.build_page_render_tree(page).unwrap().root, &mut seen);
    }
    assert_eq!(seen, 16);
}

#[test]
fn inactive_raw_shapes_survive_two_saves_without_active_paint() {
    let mut doc = document(false);
    for _ in 0..2 {
        let bytes = serialize_hwpx(&doc).unwrap();
        let zip = entries(&bytes);
        let header = std::str::from_utf8(&zip["Contents/header.xml"]).unwrap();
        let shape15 = char_blocks(header)
            .into_iter()
            .find(|block| block.starts_with("<hh:charPr id=\"15\""))
            .unwrap();
        assert!(shape15.contains("<hh:underline type=\"NONE\" shape=\"SOLID\""));
        assert!(shape15.contains("<hh:strikeout shape=\"3D\""));
        assert_no_decoration(&bytes);
        doc = parse_hwpx(&bytes).unwrap();
        for (raw, cs) in doc.doc_info.char_shapes.iter().enumerate() {
            assert_eq!(cs.underline_type, UnderlineType::None);
            assert!(!cs.strikethrough);
            assert_eq!(
                (cs.underline_shape, cs.strike_shape),
                (raw as u8, raw as u8)
            );
        }
    }
}

#[test]
fn supported_active_shapes_keep_standard_semantics_without_auxiliary_help() {
    let doc = document(true);
    let mut zip = entries(&serialize_hwpx(&doc).unwrap());
    zip.remove(RAW_FIELDS_HWPX_PATH);
    let reopened = parse_hwpx(&package(&zip)).unwrap();
    for (raw, cs) in reopened.doc_info.char_shapes.iter().enumerate() {
        assert_eq!(cs.underline_type, UnderlineType::Bottom);
        assert!(cs.strikethrough);
        assert_eq!(
            (cs.underline_shape, cs.strike_shape),
            (raw as u8, raw as u8)
        );
    }
}

#[test]
fn unmarked_native_3d_stays_inactive_without_invented_raw15() {
    let mut zip = entries(&serialize_hwpx(&document(false)).unwrap());
    zip.remove(RAW_FIELDS_HWPX_PATH);
    let reopened = parse_hwpx(&package(&zip)).unwrap();
    let cs = &reopened.doc_info.char_shapes[15];
    assert_eq!(cs.underline_type, UnderlineType::None);
    assert!(!cs.strikethrough);
    assert_eq!((cs.underline_shape, cs.strike_shape), (0, 0));
    assert_no_decoration(&package(&zip));
}

#[test]
fn sparse_reordered_char_ids_restore_the_addressed_style_only() {
    let mut zip = entries(&serialize_hwpx(&document(false)).unwrap());
    let mut header = String::from_utf8(zip["Contents/header.xml"].clone()).unwrap();
    let blocks = char_blocks(&header);
    let first = header.find(blocks[0]).unwrap();
    let last = header.find(blocks[15]).unwrap() + blocks[15].len();
    let reordered = blocks
        .iter()
        .rev()
        .map(|block| block.replace("<hh:charPr id=\"15\"", "<hh:charPr id=\"42\""))
        .collect::<String>();
    header.replace_range(first..last, &reordered);
    let shape42 = char_blocks(&header)
        .into_iter()
        .find(|block| block.starts_with("<hh:charPr id=\"42\""))
        .unwrap();
    let mut value: Value = serde_json::from_slice(&zip[RAW_FIELDS_HWPX_PATH]).unwrap();
    for record in value["strokes"].as_array_mut().unwrap() {
        if record["id"] == 15 {
            record["id"] = json!(42);
            record["digest"] = json!(*blake3::hash(shape42.as_bytes()).as_bytes());
        }
    }
    let section = String::from_utf8(zip["Contents/section0.xml"].clone())
        .unwrap()
        .replace("charPrIDRef=\"15\"", "charPrIDRef=\"42\"");
    zip.insert("Contents/section0.xml".into(), section.into_bytes());
    zip.insert("Contents/header.xml".into(), header.into_bytes());
    zip.insert(
        RAW_FIELDS_HWPX_PATH.into(),
        serde_json::to_vec(&value).unwrap(),
    );
    let mut reopened = parse_hwpx(&package(&zip)).unwrap();
    for _ in 0..2 {
        assert_eq!(
            (
                reopened.doc_info.char_shapes[42].underline_shape,
                reopened.doc_info.char_shapes[42].strike_shape
            ),
            (15, 15)
        );
        assert_eq!(reopened.doc_info.char_shapes[14].strike_shape, 14);
        assert_eq!(reopened.doc_info.char_shapes[15].strike_shape, 0);
        reopened = parse_hwpx(&serialize_hwpx(&reopened).unwrap()).unwrap();
    }
}

#[test]
fn style_edits_and_stale_passthrough_cannot_reactivate_old_raw_shapes() {
    let original = entries(&serialize_hwpx(&document(false)).unwrap());
    let mut recolored = original.clone();
    let header = String::from_utf8(original["Contents/header.xml"].clone()).unwrap();
    let block = char_blocks(&header)
        .into_iter()
        .find(|block| block.starts_with("<hh:charPr id=\"15\""))
        .unwrap();
    let mut changed = block.to_owned();
    let start = changed.find("textColor=\"").unwrap() + "textColor=\"".len();
    let end = start + changed[start..].find('"').unwrap();
    changed.replace_range(start..end, "#112233");
    recolored.insert(
        "Contents/header.xml".into(),
        header.replace(block, &changed).into_bytes(),
    );
    let colored = parse_hwpx(&package(&recolored)).unwrap();
    assert_eq!(colored.doc_info.char_shapes[15].text_color, 0x332211);
    assert_eq!(
        (
            colored.doc_info.char_shapes[15].underline_shape,
            colored.doc_info.char_shapes[15].strike_shape
        ),
        (0, 0)
    );
    let mut edited = original.clone();
    let mut header = String::from_utf8(edited["Contents/header.xml"].clone()).unwrap();
    let block = char_blocks(&header)
        .into_iter()
        .find(|block| block.starts_with("<hh:charPr id=\"15\""))
        .unwrap()
        .to_owned();
    header = header.replace(
        &block,
        &block.replace(
            "<hh:strikeout shape=\"3D\"",
            "<hh:strikeout shape=\"SOLID\"",
        ),
    );
    edited.insert("Contents/header.xml".into(), header.into_bytes());
    let mut doc = parse_hwpx(&package(&edited)).unwrap();
    assert!(doc.doc_info.char_shapes[15].strikethrough);
    assert_eq!(doc.doc_info.char_shapes[15].strike_shape, 0);
    doc.doc_info.char_shapes[15].strikethrough = false;
    doc.doc_info.char_shapes[15].strike_shape = 0;
    doc.doc_info.char_shapes[15].underline_shape = 0;
    doc.hwpx_aux_entries.push((
        RAW_FIELDS_HWPX_PATH.into(),
        original[RAW_FIELDS_HWPX_PATH].clone(),
    ));
    let reopened = parse_hwpx(&serialize_hwpx(&doc).unwrap()).unwrap();
    assert_eq!(
        (
            reopened.doc_info.char_shapes[15].underline_shape,
            reopened.doc_info.char_shapes[15].strike_shape
        ),
        (0, 0)
    );
}

#[test]
fn malformed_or_ambiguous_stroke_metadata_never_restores_latent_values() {
    let original = entries(&serialize_hwpx(&document(false)).unwrap());
    let metadata: Value = serde_json::from_slice(&original[RAW_FIELDS_HWPX_PATH]).unwrap();
    for mutation in 0..5 {
        let mut value = metadata.clone();
        match mutation {
            0 => value["version"] = json!(0),
            1 => value["strokes"][0]["strike"] = json!(16),
            2 => {
                let duplicate = value["strokes"][0].clone();
                value["strokes"].as_array_mut().unwrap().push(duplicate);
            }
            3 => value["strokes"][0]["underline"] = json!(255),
            4 => value["strokes"][0]["unknown"] = json!(true),
            _ => unreachable!(),
        }
        let mut zip = original.clone();
        zip.insert(
            RAW_FIELDS_HWPX_PATH.into(),
            serde_json::to_vec(&value).unwrap(),
        );
        let reopened = parse_hwpx(&package(&zip)).unwrap();
        assert!(reopened
            .doc_info
            .char_shapes
            .iter()
            .all(|cs| cs.strike_shape == 0 && !cs.strikethrough));
        assert_eq!(reopened.doc_info.char_shapes[15].underline_shape, 0);
    }
    let mut duplicate = original.clone();
    let mut header = String::from_utf8(duplicate["Contents/header.xml"].clone()).unwrap();
    let block = char_blocks(&header)[15].to_owned();
    header = header.replace(&block, &format!("{block}{block}"));
    duplicate.insert("Contents/header.xml".into(), header.into_bytes());
    let reopened = parse_hwpx(&package(&duplicate)).unwrap();
    assert_eq!(
        (
            reopened.doc_info.char_shapes[15].underline_shape,
            reopened.doc_info.char_shapes[15].strike_shape
        ),
        (0, 0)
    );
}

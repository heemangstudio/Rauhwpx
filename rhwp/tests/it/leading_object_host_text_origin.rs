//! 원본 개체/글줄 사다리와 실제 편집·저장·다시열기를 함께 보호한다.
#![cfg(not(target_arch = "wasm32"))]

use rhwp::document_core::DocumentCore;
use rhwp::model::{control::Control, paragraph::LineSeg, provenance::FontMetricsPolicy};
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};
use rhwp::wasm_api::HwpDocument;
use serde_json::{json, Value};

const SOURCE: &[u8] = include_bytes!("../../samples/editing/leading_object_host_text_origin.hwpx");
const ORACLE: &str =
    include_str!("../../samples/editing/leading_object_host_text_origin_native_oracle.json");

fn load() -> HwpDocument {
    let core = HwpDocument::from_bytes(SOURCE).unwrap();
    assert_eq!(
        core.document().doc_info.font_metrics_policy,
        FontMetricsPolicy::HcrDeclared
    );
    core
}

fn fields(line: &LineSeg) -> [i64; 9] {
    [
        i64::from(line.text_start),
        i64::from(line.vertical_pos),
        i64::from(line.line_height),
        i64::from(line.text_height),
        i64::from(line.baseline_distance),
        i64::from(line.line_spacing),
        i64::from(line.column_start),
        i64::from(line.segment_width),
        i64::from(line.tag),
    ]
}

fn all_lines(core: &DocumentCore) -> Vec<Vec<[i64; 9]>> {
    core.document().sections[0]
        .paragraphs
        .iter()
        .map(|p| p.line_segs.iter().map(fields).collect())
        .collect()
}

fn full_lines(document: &rhwp::model::document::Document) -> Vec<[i64; 9]> {
    fn visit(p: &rhwp::model::paragraph::Paragraph, out: &mut Vec<[i64; 9]>) {
        for control in &p.controls {
            if let Control::Table(table) = control {
                for cell in &table.cells {
                    for p in &cell.paragraphs {
                        visit(p, out);
                    }
                }
            }
        }
        out.extend(p.line_segs.iter().map(fields));
    }
    let mut out = Vec::new();
    for section in &document.sections {
        for p in &section.paragraphs {
            visit(p, &mut out);
        }
    }
    out
}

fn wire_document(core: &DocumentCore) -> rhwp::model::document::Document {
    rhwp::parser::parse_document(&core.export_hwpx_native().unwrap()).unwrap()
}

fn saved_xml_lines(core: &DocumentCore) -> Vec<[i64; 9]> {
    use std::io::Read;
    let bytes = core.export_hwpx_native().unwrap();
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut xml = Vec::new();
    archive
        .by_name("Contents/section0.xml")
        .unwrap()
        .read_to_end(&mut xml)
        .unwrap();
    let mut reader = quick_xml::Reader::from_reader(xml.as_slice());
    let mut buffer = Vec::new();
    let names = [
        "textpos",
        "vertpos",
        "vertsize",
        "textheight",
        "baseline",
        "spacing",
        "horzpos",
        "horzsize",
        "flags",
    ];
    let mut out = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer).unwrap() {
            quick_xml::events::Event::Empty(e) | quick_xml::events::Event::Start(e)
                if e.local_name().as_ref() == b"lineseg" =>
            {
                let mut line = [None; 9];
                for a in e.attributes() {
                    let a = a.unwrap();
                    if let Some(i) = names.iter().position(|n| n.as_bytes() == a.key.as_ref()) {
                        line[i] = Some(
                            std::str::from_utf8(&a.value)
                                .unwrap()
                                .parse::<i64>()
                                .unwrap(),
                        );
                    }
                }
                out.push(line.map(Option::unwrap));
            }
            quick_xml::events::Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    out
}

fn assert_native_wire(core: &DocumentCore, expected: &Value) {
    let native: Vec<[i64; 9]> = serde_json::from_value(expected["all_xml_lines"].clone()).unwrap();
    assert_eq!(
        saved_xml_lines(core),
        native,
        "all native root/cell nine-field vectors in saved XML order"
    );
}

fn assert_saved_root_contract(
    core: &DocumentCore,
    parsed: &rhwp::model::document::Document,
    label: &str,
) {
    let mut expected = all_lines(core);
    if let Some(payload) = parsed.hwpx_aux_entry("META-INF/rhwp-tac-line-origin") {
        let origin: Value = serde_json::from_slice(payload).unwrap();
        for group in origin["groups"].as_array().unwrap() {
            assert_eq!(group["section"], 0);
            let i = group["paragraph"].as_u64().unwrap() as usize;
            assert!(matches!(
                core.document().sections[0].paragraphs[i].tac_line_origin,
                Some(rhwp::model::paragraph::TacLineOrigin::Owner(_))
            ));
            assert_eq!(expected[i].len(), 1);
            assert_eq!(
                expected[i][0][8],
                i64::from(LineSeg::TAG_SINGLE_SEGMENT_LINE | LineSeg::TAG_IMPLEMENTATION_PROPERTY)
            );
            expected[i][0][8] = i64::from(LineSeg::TAG_SINGLE_SEGMENT_LINE);
        }
    }
    let actual: Vec<Vec<_>> = parsed.sections[0]
        .paragraphs
        .iter()
        .map(|p| p.line_segs.iter().map(fields).collect())
        .collect();
    assert_eq!(
        actual, expected,
        "{label}: exact ordinary owned wire flags, all8 geometry and other flags unchanged"
    );
}

fn make_source_zero_record(bytes: &[u8]) -> Vec<u8> {
    use std::io::{Read, Write};
    let mut source = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut output = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for i in 0..source.len() {
        let mut entry = source.by_index(i).unwrap();
        let name = entry.name().to_owned();
        let options =
            zip::write::SimpleFileOptions::default().compression_method(entry.compression());
        let mut body = Vec::new();
        entry.read_to_end(&mut body).unwrap();
        if name == "Contents/section0.xml" {
            let xml = String::from_utf8(body).unwrap();
            assert_eq!(xml.matches("vertsize=\"1\"").count(), 1);
            assert_eq!(xml.matches("textheight=\"1\"").count(), 1);
            body = xml
                .replacen("vertsize=\"1\"", "vertsize=\"0\"", 1)
                .replacen("textheight=\"1\"", "textheight=\"0\"", 1)
                .into_bytes();
        }
        output.start_file(name, options).unwrap();
        output.write_all(&body).unwrap();
    }
    output.finish().unwrap().into_inner()
}

fn native_lines(step: &Value) -> Vec<Vec<[i64; 9]>> {
    let names = [
        "textpos",
        "vertpos",
        "vertsize",
        "textheight",
        "baseline",
        "spacing",
        "horzpos",
        "horzsize",
        "flags",
    ];
    step["roots"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            p["lines"]
                .as_array()
                .unwrap()
                .iter()
                .map(|line| names.map(|name| line[name].as_str().unwrap().parse().unwrap()))
                .collect()
        })
        .collect()
}

fn apply(core: &mut DocumentCore, operation: &Value) {
    let n = |key: &str| operation[key].as_u64().unwrap() as usize;
    let section = n("section");
    let paragraph = n("paragraph");
    match operation["kind"].as_str().unwrap() {
        "type" => {
            core.insert_text_native(
                section,
                paragraph,
                n("offset"),
                operation["text"].as_str().unwrap(),
            )
            .unwrap();
        }
        "replace_local" => {
            core.replace_body_text_local_native(
                section,
                paragraph,
                n("offset"),
                n("count"),
                operation["text"].as_str().unwrap(),
            )
            .unwrap();
        }
        "delete" => {
            core.delete_text_native(section, paragraph, n("offset"), n("count"))
                .unwrap();
        }
        "paragraph_split" => {
            core.split_paragraph_native(section, paragraph, n("offset"), None)
                .unwrap();
        }
        "paragraph_merge" => {
            core.merge_paragraph_native(section, paragraph).unwrap();
        }
        kind => panic!("unknown native operation {kind}"),
    }
}

fn tree(core: &DocumentCore) -> RenderNode {
    assert_eq!(core.page_count(), 1);
    core.build_page_render_tree(0).unwrap().root
}

fn body_items(node: &RenderNode, in_column: bool, out: &mut Vec<(u8, f64, f64, String)>) {
    let in_column = in_column || matches!(node.node_type, RenderNodeType::Column(_));
    if in_column && matches!(node.node_type, RenderNodeType::Table(_)) {
        out.push((0, node.bbox.y, node.bbox.height, String::new()));
        return;
    }
    if in_column && matches!(node.node_type, RenderNodeType::TextLine(_)) {
        fn text(n: &RenderNode, s: &mut String) {
            if let RenderNodeType::TextRun(run) = &n.node_type {
                s.push_str(&run.text);
            }
            for c in &n.children {
                text(c, s);
            }
        }
        let mut value = String::new();
        text(node, &mut value);
        out.push((1, node.bbox.y, node.bbox.height, value));
        return;
    }
    for c in &node.children {
        body_items(c, in_column, out);
    }
}

fn geometry(core: &DocumentCore) -> Vec<(u8, f64, f64, String)> {
    let mut out = Vec::new();
    body_items(&tree(core), false, &mut out);
    out
}

fn check_persistence(core: &DocumentCore) {
    let immediate = geometry(core);
    let saved = core.export_hwpx_native().unwrap();
    let reopened =
        DocumentCore::from_bytes_with_font_metrics(&saved, FontMetricsPolicy::HcrDeclared).unwrap();
    assert_eq!(
        full_lines(reopened.document()),
        full_lines(core.document()),
        "own reopen restores all internal root/cell fields"
    );
    assert_eq!(
        geometry(&reopened),
        immediate,
        "reopened body item order/geometry"
    );
}

fn run_native_steps(all_nine: bool) {
    let oracle: Value = serde_json::from_str(ORACLE).unwrap();
    let mut core = load();
    let first = &core.document().sections[0].paragraphs[0];
    let certificate = first
        .leading_block_host_layout
        .as_ref()
        .expect("source-certified host");
    let reserve = certificate.reserve_hu;
    let original_table = certificate.table.clone();
    let table_box = geometry(&core)[0].clone();
    assert_eq!(table_box.0, 0, "leading Table precedes body host text");
    check_persistence(&core);
    let mut flag_failures = Vec::new();
    for (operation, expected) in oracle["operation_manifest"]["operations"]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .zip(oracle["steps"].as_array().unwrap())
    {
        apply(&mut core, &operation["operation"]);
        let actual = all_lines(&core);
        let native = native_lines(expected);
        assert_eq!(actual.len(), native.len());
        for (pi, (actual, native)) in actual.iter().zip(&native).enumerate() {
            assert_eq!(actual.len(), native.len());
            for (li, (actual, native)) in actual.iter().zip(native).enumerate() {
                assert_eq!(
                    &actual[..8],
                    &native[..8],
                    "{} paragraph {pi} line {li} geometry",
                    operation["id"]
                );
                if actual[8] != native[8] {
                    flag_failures
                        .push(json!({"step": operation["id"], "paragraph": pi, "line": li,
                        "native_flags": native[8], "engine_flags": actual[8]}));
                }
            }
        }
        let paragraphs = &core.document().sections[0].paragraphs;
        let texts: Vec<_> = paragraphs.iter().map(|p| p.text.as_str()).collect();
        let expected_texts: Vec<_> = expected["roots"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["text"].as_str().unwrap())
            .collect();
        assert_eq!(texts, expected_texts);
        let certificate = paragraphs[0].leading_block_host_layout.as_ref().unwrap();
        assert_eq!(certificate.reserve_hu, reserve);
        assert_eq!(
            certificate.table, original_table,
            "body edits preserve object geometry/content"
        );
        assert_eq!(geometry(&core)[0], table_box);
        check_persistence(&core);
        if all_nine {
            assert_native_wire(&core, expected);
        }
    }
    {
        assert_eq!(
            flag_failures.len(),
            oracle["steps"].as_array().unwrap().len()
        );
        for failure in flag_failures {
            assert_eq!(
                failure["engine_flags"].as_u64().unwrap()
                    - failure["native_flags"].as_u64().unwrap(),
                u64::from(LineSeg::TAG_IMPLEMENTATION_PROPERTY),
                "runtime retains the source-absence marker"
            );
        }
    }
}

#[test]
fn native_host_origins_survive_five_public_edits_and_reopen() {
    run_native_steps(false);
}

#[test]
fn all_nine_native_saved_line_fields() {
    run_native_steps(true);
}

fn marker_count(document: &rhwp::model::document::Document) -> usize {
    full_lines(document)
        .iter()
        .filter(|l| l[8] as u32 & LineSeg::TAG_IMPLEMENTATION_PROPERTY != 0)
        .count()
}

fn tac_owner_index(core: &DocumentCore) -> usize {
    core.document().sections[0]
        .paragraphs
        .iter()
        .position(|p| {
            matches!(
                p.tac_line_origin,
                Some(rhwp::model::paragraph::TacLineOrigin::Owner(_))
            )
        })
        .expect("proved source-absent TAC owner")
}

#[test]
fn tac_wire_conversion_keeps_live_synthesis_and_restores_owned_reopen() {
    let mut core = load();
    let original = full_lines(core.document());
    let before = serde_json::to_value(tree(&core)).unwrap();
    assert_eq!(marker_count(core.document()), 3);
    assert_eq!(marker_count(&wire_document(&core)), 0);
    assert_eq!(
        full_lines(core.document()),
        original,
        "read-only export never promotes live records"
    );
    assert_eq!(serde_json::to_value(tree(&core)).unwrap(), before);
    let bytes = core.export_hwpx_native().unwrap();
    let mut reopened =
        DocumentCore::from_bytes_with_font_metrics(&bytes, FontMetricsPolicy::HcrDeclared).unwrap();
    assert_eq!(full_lines(reopened.document()), original);
    assert_eq!(
        marker_count(&wire_document(&reopened)),
        0,
        "own reopen remains eligible"
    );
    core.refresh_layout_native();
    reopened.refresh_layout_native();
    assert_eq!(full_lines(core.document()), full_lines(reopened.document()));
    assert_eq!(
        serde_json::to_value(tree(&core)).unwrap(),
        serde_json::to_value(tree(&reopened)).unwrap()
    );
    assert_eq!(marker_count(&wire_document(&reopened)), 0);
}

#[test]
fn tac_native_cache_replacement_and_untracked_snapshot_restore_keep_authorship() {
    let mut core = load();
    let owner = tac_owner_index(&core);
    let before = core.save_snapshot_native();
    let mut native = wire_document(&core);
    let Control::Table(table) = &mut native.sections[0].paragraphs[owner].controls[0] else {
        panic!()
    };
    let (ci, pi) = table
        .cells
        .iter()
        .enumerate()
        .find_map(|(ci, c)| {
            c.paragraphs
                .iter()
                .position(|p| p.text.starts_with(" *********************"))
                .map(|pi| (ci, pi))
        })
        .unwrap();
    let mut replacement = table.cells[ci].paragraphs[pi].clone();
    assert!(replacement.tac_line_origin.is_none());
    replacement.line_segs[0].tag |= LineSeg::TAG_IMPLEMENTATION_PROPERTY;
    let Control::Table(table) = &mut core.document_mut().sections[0].paragraphs[owner].controls[0]
    else {
        panic!()
    };
    table.cells[ci].paragraphs[pi] = replacement;
    let after = core.save_snapshot_native();
    assert_eq!(
        marker_count(&wire_document(&core)),
        3,
        "native cache never inherits source-absence permission"
    );
    core.restore_snapshot_native(before).unwrap();
    assert_eq!(
        marker_count(&wire_document(&core)),
        0,
        "snapshot restores genuine derived origin"
    );
    core.restore_snapshot_native(after).unwrap();
    assert_eq!(
        marker_count(&wire_document(&core)),
        3,
        "same revision cannot resurrect an older source origin"
    );
}

#[test]
fn tac_snapshot_tracks_upstream_multiline_cascade_without_sequence_change() {
    let mut core = load();
    let original = full_lines(core.document());
    let before = core.save_snapshot_native();
    core.insert_text_native(0, 1, 0, "additional line\n")
        .unwrap();
    let changed = full_lines(core.document());
    assert_ne!(changed, original);
    let after = core.save_snapshot_native();
    core.restore_snapshot_native(before).unwrap();
    assert_eq!(full_lines(core.document()), original);
    core.restore_snapshot_native(after).unwrap();
    assert_eq!(full_lines(core.document()), changed);
    check_persistence(&core);
}

#[test]
fn tac_changed_table_style_context_and_unknown_metadata_use_existing_synthetic_path() {
    for kind in [
        "table",
        "cell",
        "font",
        "neighbor",
        "neighbor_field",
        "column",
        "style",
        "context",
        "unknown",
    ] {
        let mut core = load();
        let owner = tac_owner_index(&core);
        match kind {
            "table" => {
                let Control::Table(t) =
                    &mut core.document_mut().sections[0].paragraphs[owner].controls[0]
                else {
                    panic!()
                };
                t.common.width += 4;
            }
            "cell" => {
                let Control::Table(t) =
                    &mut core.document_mut().sections[0].paragraphs[owner].controls[0]
                else {
                    panic!()
                };
                t.cells[0].width += 4;
            }
            "font" => {
                let id = core.document().sections[0].paragraphs[owner].char_shapes[0].char_shape_id
                    as usize;
                core.document_mut().doc_info.char_shapes[id].base_size += 4;
            }
            "neighbor" => {
                core.document_mut().sections[0].paragraphs[owner - 1].line_segs[0].segment_width +=
                    4
            }
            "neighbor_field" => {
                let Control::Table(t) =
                    &mut core.document_mut().sections[0].paragraphs[owner + 1].controls[0]
                else {
                    panic!()
                };
                t.cells[0].field_name = Some("changed template name".into());
            }
            "column" => {
                let column = core.document_mut().sections[0]
                    .paragraphs
                    .iter_mut()
                    .flat_map(|p| &mut p.controls)
                    .find_map(|c| match c {
                        Control::ColumnDef(c) => Some(c),
                        _ => None,
                    })
                    .unwrap();
                column.spacing += 4;
            }
            "style" => {
                let id = core.document().sections[0].paragraphs[owner].para_shape_id as usize;
                core.document_mut().doc_info.para_shapes[id].margin_left += 4;
            }
            "context" => {
                core.document_mut().sections[0]
                    .section_def
                    .page_def
                    .margin_left += 4
            }
            "unknown" => core
                .document_mut()
                .hwpx_aux_entries
                .push(("META-INF/rhwp-tac-line-origin".into(), b"unknown".to_vec())),
            _ => unreachable!(),
        }
        assert_eq!(
            marker_count(&wire_document(&core)),
            3,
            "{kind} rejects the entire wire group"
        );
        assert_eq!(
            marker_count(core.document()),
            3,
            "{kind} never changes live flags"
        );
    }
}

#[test]
fn tac_cloned_leaf_outside_its_source_owner_does_not_promote() {
    let mut core = load();
    let owner = tac_owner_index(&core);
    let Control::Table(table) = &mut core.document_mut().sections[0].paragraphs[owner].controls[0]
    else {
        panic!()
    };
    let clone = table
        .cells
        .iter()
        .flat_map(|c| &c.paragraphs)
        .find(|p| p.tac_line_origin.is_some())
        .unwrap()
        .clone();
    table.cells[0].paragraphs.push(clone);
    assert_eq!(marker_count(core.document()), 4);
    assert_eq!(marker_count(&wire_document(&core)), 4);
}

#[test]
fn tac_malformed_private_origin_never_changes_saved_flags() {
    let core = load();
    let owner = tac_owner_index(&core);
    for kind in [
        "duplicate",
        "index",
        "line_domain",
        "source_text",
        "wire_text",
        "prefix_absence",
        "coordinated_cached_text",
        "nonfinite_style",
    ] {
        let mut saved = wire_document(&core);
        let (_, bytes) = saved
            .hwpx_aux_entries
            .iter_mut()
            .find(|(p, _)| p == "META-INF/rhwp-tac-line-origin")
            .expect("own origin payload");
        let mut value: Value = serde_json::from_slice(bytes).unwrap();
        match kind {
            "duplicate" => {
                let group = value["groups"][0].clone();
                value["groups"].as_array_mut().unwrap().push(group);
            }
            "index" => value["groups"][0]["paragraph"] = json!(usize::MAX),
            "line_domain" => {
                value["groups"][0]["origin"]["source"][0]["lines"][0][1] = json!(i64::MIN)
            }
            "source_text" => {
                let cells = value["groups"][0]["origin"]["source"][1]["controls"][0]["Table"]
                    ["paragraphs"]
                    .as_array_mut()
                    .unwrap();
                let leaf = cells
                    .iter_mut()
                    .flat_map(|c| c.as_array_mut().unwrap())
                    .find(|p| p["lines"].as_array().unwrap().is_empty())
                    .unwrap();
                leaf["text"] = json!("changed origin stream");
            }
            "coordinated_cached_text" => {
                value["groups"][0]["origin"]["source"][1]["controls"][0]["Table"]["paragraphs"]
                    [0][0]["text"] = json!("출처");
                value["groups"][0]["wire"][1]["controls"][0]["Table"]["paragraphs"][0][0]["text"] =
                    json!("출처");
            }
            "nonfinite_style" => {
                value["groups"][0]["origin"]["para_styles"][0][1]["margins"][0] =
                    json!({"$rhwpF64Bits": f64::NAN.to_bits()})
            }
            "prefix_absence" => {
                value["groups"][0]["origin"]["source"][1]["controls"][0]["Table"]["paragraphs"][0]
                    [0]["lines"] = json!([])
            }
            "wire_text" => value["groups"][0]["wire"][1]["text"] = json!("changed association"),
            _ => unreachable!(),
        }
        *bytes = serde_json::to_vec(&value).unwrap();
        let bytes = rhwp::serializer::serialize_hwpx(&saved).unwrap();
        let reopened =
            DocumentCore::from_bytes_with_font_metrics(&bytes, FontMetricsPolicy::HcrDeclared)
                .unwrap();
        assert_eq!(
            marker_count(reopened.document()),
            0,
            "{kind} leaves saved flags untouched"
        );
        assert!(
            reopened.document().sections[0].paragraphs[owner]
                .tac_line_origin
                .is_none(),
            "{kind} never gains an origin"
        );
    }
}

#[test]
fn tac_direct_and_batched_owner_change_preserve_synthetic_fallback() {
    for batch in [false, true] {
        let mut core = load();
        let owner = tac_owner_index(&core);
        if batch {
            core.begin_batch_native().unwrap();
        }
        core.move_table_offset(0, owner as u32, 0, 0, 100).unwrap();
        let markers = marker_count(core.document());
        assert_eq!(marker_count(&wire_document(&core)), markers);
        if batch {
            core.end_batch_native().unwrap();
        }
        assert_eq!(
            marker_count(&wire_document(&core)),
            marker_count(core.document())
        );
    }
}

#[test]
fn tac_source_proof_survives_actual_para_meta_json_roundtrip() {
    let mut core = load();
    let owner = tac_owner_index(&core);
    let paragraph = &core.document().sections[0].paragraphs[owner];
    let origin = paragraph.tac_line_origin.clone();
    let bytes = serde_json::to_vec(&paragraph.capture_meta()).unwrap();
    let meta = serde_json::from_slice(&bytes).unwrap();
    core.document_mut().sections[0].paragraphs[owner].apply_meta(meta);
    assert_eq!(
        core.document().sections[0].paragraphs[owner].tac_line_origin,
        origin
    );
    assert_eq!(marker_count(&wire_document(&core)), 0);
}

#[test]
fn tac_own_stale_context_restores_markers_before_import_without_reauthorizing() {
    let core = load();
    let mut saved = wire_document(&core);
    saved.sections[0].section_def.page_def.margin_left += 4;
    let bytes = rhwp::serializer::serialize_hwpx(&saved).unwrap();
    let reopened =
        DocumentCore::from_bytes_with_font_metrics(&bytes, FontMetricsPolicy::HcrDeclared).unwrap();
    assert_eq!(
        marker_count(reopened.document()),
        3,
        "known owned wire records return to synthetic fallback"
    );
    assert_eq!(
        marker_count(&wire_document(&reopened)),
        3,
        "changed context cannot reuse the old proof"
    );
}

#[test]
fn tac_metadata_free_authored_bit31_and_zero_placeholders_never_gain_permission() {
    let core = load();
    let mut native = wire_document(&core);
    native
        .hwpx_aux_entries
        .retain(|(p, _)| p != "META-INF/rhwp-tac-line-origin");
    let owner = tac_owner_index(&core);
    native.sections[0].paragraphs[owner].line_segs[0].tag |= LineSeg::TAG_IMPLEMENTATION_PROPERTY;
    let bytes = rhwp::serializer::serialize_hwpx(&native).unwrap();
    let reopened =
        DocumentCore::from_bytes_with_font_metrics(&bytes, FontMetricsPolicy::HcrDeclared).unwrap();
    assert_eq!(
        marker_count(&wire_document(&reopened)),
        1,
        "authored positive bit31 remains verbatim"
    );
    assert!(reopened.document().sections[0].paragraphs[owner]
        .tac_line_origin
        .is_none());
    for target in ["root", "tail"] {
        let mut placeholder = rhwp::parser::parse_document(SOURCE).unwrap();
        let root = &mut placeholder.sections[0].paragraphs[owner];
        let paragraph = if target == "root" {
            root
        } else {
            let Control::Table(table) = &mut root.controls[0] else {
                panic!()
            };
            table
                .cells
                .iter_mut()
                .flat_map(|c| &mut c.paragraphs)
                .find(|p| p.line_segs.is_empty())
                .unwrap()
        };
        paragraph.line_segs = vec![LineSeg {
            line_height: 1,
            text_height: 1,
            ..Default::default()
        }];
        let bytes = rhwp::serializer::serialize_hwpx(&placeholder).unwrap();
        let bytes = make_source_zero_record(&bytes);
        let raw = rhwp::parser::parse_document(&bytes).unwrap();
        assert!(
            raw.sections[0].paragraphs[owner].line_segs.is_empty(),
            "raw parser discards stored zero record before import"
        );
        let reopened =
            DocumentCore::from_bytes_with_font_metrics(&bytes, FontMetricsPolicy::HcrDeclared)
                .unwrap();
        assert!(
            reopened.document().sections[0].paragraphs[owner]
                .tac_line_origin
                .is_none(),
            "{target}: genuine source-present zero record never grants absence ownership"
        );
    }
}

#[test]
fn split_merge_undo_restores_the_certified_host_and_saved_origins() {
    let mut core = load();
    let before = all_lines(&core);
    let before_geometry = geometry(&core);
    let split = core.split_paragraph_native(0, 0, 8, None).unwrap();
    let merged: Value = serde_json::from_str(&core.merge_paragraph_native(0, 1).unwrap()).unwrap();
    assert_eq!(all_lines(&core), before);
    assert_eq!(geometry(&core), before_geometry);
    // The real public merge reply carries the removed paragraph metadata for split undo.
    let removed_meta = merged
        .get("removedParaMeta")
        .or_else(|| merged.get("paraMeta"));
    if let Some(meta) = removed_meta {
        let meta = serde_json::from_value(meta.clone()).unwrap();
        core.split_paragraph_native(0, 0, 8, Some(meta)).unwrap();
        core.merge_paragraph_native(0, 1).unwrap();
    } else {
        panic!("merge reply lacks undo metadata: {merged}; split={split}");
    }
    assert_eq!(all_lines(&core), before);
    check_persistence(&core);
}

#[test]
fn real_table_delete_reopens_and_snapshot_undo_restores_authored_streams() {
    let mut core = load();
    let before_lines = full_lines(core.document());
    let before_tree = serde_json::to_value(tree(&core)).unwrap();
    let before = core.save_snapshot_native();
    let untouched: Vec<_> = core.document().sections[0]
        .paragraphs
        .iter()
        .skip(1)
        .map(|p| (p.authored_text_runs.clone(), p.para_text_terminal))
        .collect();
    let owner = core.document().sections[0].paragraphs[0]
        .leading_block_host_layout
        .as_ref()
        .unwrap()
        .control_index as u32;
    core.delete_table_control(0, 0, owner).unwrap();
    let edited = &core.document().sections[0].paragraphs[0];
    assert!(edited.authored_text_runs.is_none());
    assert!(edited.para_text_terminal.is_none());
    assert_eq!(
        core.document().sections[0]
            .paragraphs
            .iter()
            .skip(1)
            .map(|p| (p.authored_text_runs.clone(), p.para_text_terminal))
            .collect::<Vec<_>>(),
        untouched,
        "untouched paragraph source metadata remains exact"
    );
    let deleted_lines = full_lines(core.document());
    let deleted_tree = serde_json::to_value(tree(&core)).unwrap();
    let after = core.save_snapshot_native();
    check_persistence(&core);
    core.restore_snapshot_native(before).unwrap();
    assert_eq!(full_lines(core.document()), before_lines);
    assert_eq!(serde_json::to_value(tree(&core)).unwrap(), before_tree);
    assert!(core.document().sections[0].paragraphs[0]
        .authored_text_runs
        .is_some());
    check_persistence(&core);
    core.restore_snapshot_native(after).unwrap();
    assert_eq!(full_lines(core.document()), deleted_lines);
    assert_eq!(serde_json::to_value(tree(&core)).unwrap(), deleted_tree);
    assert!(core.document().sections[0].paragraphs[0]
        .authored_text_runs
        .is_none());
    check_persistence(&core);
}

#[test]
fn hwp_exports_rebase_the_host_for_the_uncertified_hwp_loading_contract() {
    let core = load();
    let original = all_lines(&core);
    let reserve = core.document().sections[0].paragraphs[0]
        .leading_block_host_layout
        .as_ref()
        .unwrap()
        .reserve_hu;
    let before_items = geometry(&core);
    for (name, bytes) in [
        ("adapter", core.export_hwp_with_adapter().unwrap()),
        ("raw", core.export_hwp_native().unwrap()),
    ] {
        let reopened =
            DocumentCore::from_bytes_with_font_metrics(&bytes, FontMetricsPolicy::HcrDeclared)
                .unwrap();
        let mut items = Vec::new();
        let page = reopened.build_page_render_tree(0).unwrap();
        body_items(&page.root, false, &mut items);
        assert!(reopened.document().sections[0].paragraphs[0]
            .leading_block_host_layout
            .is_none());
        assert_eq!(
            all_lines(&reopened)[0][0][1],
            original[0][0][1] - i64::from(reserve),
            "{name}: HWP cannot reload the HWPX certificate"
        );
        assert_eq!(items[0].1, before_items[0].1, "{name}: Table flow anchor");
        assert_eq!(items[1].1, before_items[1].1, "{name}: host text origin");
        assert_eq!(
            all_lines(&core),
            original,
            "read-only HWP export retains live source state"
        );
    }
}

fn legacy_source(core: &DocumentCore) -> rhwp::model::document::Document {
    let mut document = core.document().clone();
    for p in &mut document.sections[0].paragraphs {
        if let Some(layout) = p.leading_block_host_layout.take() {
            for line in &mut p.line_segs {
                line.vertical_pos -= layout.reserve_hu;
            }
        }
    }
    document
}

#[test]
fn unsupported_table_commands_rebase_before_composition_and_batched_save() {
    for kind in [
        "columns",
        "page_geometry",
        "section_context",
        "overlap",
        "offset",
        "delete",
        "moving_split",
        "empty_host",
    ] {
        let mut certified = load();
        let owner = certified.document().sections[0].paragraphs[0]
            .leading_block_host_layout
            .as_ref()
            .unwrap()
            .control_index as u32;
        let mut legacy = load();
        legacy.set_document(legacy_source(&certified));
        for core in [&mut certified, &mut legacy] {
            core.begin_batch_native().unwrap();
            match kind {
                "columns" => {
                    core.set_column_def_native(0, 2, 0, true, 0).unwrap();
                }
                "page_geometry" => {
                    let margin = core.document().sections[0].section_def.page_def.margin_left;
                    core.set_page_def_native(0, &json!({"marginLeft": margin + 100}).to_string())
                        .unwrap();
                }
                "section_context" => {
                    core.set_section_def_native(0, r#"{"defaultTabSpacing":7000}"#)
                        .unwrap();
                }
                "overlap" => {
                    core.set_table_properties(0, 0, owner, r#"{"allowOverlap":true}"#)
                        .unwrap();
                }
                "offset" => {
                    core.move_table_offset(0, 0, owner, 0, 100).unwrap();
                }
                "delete" => {
                    core.delete_table_control(0, 0, owner).unwrap();
                }
                "moving_split" => {
                    core.split_paragraph_native(0, 0, 0, None).unwrap();
                }
                "empty_host" => {
                    let count = core.document().sections[0].paragraphs[0]
                        .text
                        .chars()
                        .count();
                    core.delete_text_native(0, 0, 0, count).unwrap();
                }
                _ => unreachable!(),
            }
        }
        assert!(
            certified.document().sections[0]
                .paragraphs
                .iter()
                .all(|p| p.leading_block_host_layout.is_none()),
            "{kind}"
        );
        assert_eq!(
            all_lines(&certified),
            all_lines(&legacy),
            "{kind}: existing fallback saved coordinates"
        );
        // Export while pagination is deferred; then settle the real command path.
        let saved = certified
            .export_hwpx_native()
            .unwrap_or_else(|error| panic!("{kind}: {error}"));
        let parsed = rhwp::parser::parse_document(&saved).unwrap();
        assert_saved_root_contract(&certified, &parsed, &format!("{kind}: batched export"));
        certified.end_batch_native().unwrap();
        legacy.end_batch_native().unwrap();
        assert_eq!(
            geometry(&certified),
            geometry(&legacy),
            "{kind}: legacy fallback layout"
        );
        check_persistence(&certified);
    }
}

#[test]
fn export_rolls_back_changed_inputs_and_ambiguous_control_slots_atomically() {
    for change in [
        "geometry",
        "content",
        "style",
        "page_context",
        "section_context",
        "other_column_context",
        "missing_leading_slot",
        "unexplained_internal_gap",
        "orphan_field_end",
        "compound_field",
    ] {
        let mut core = load();
        let first = &core.document().sections[0].paragraphs[0];
        let original = first.line_segs.iter().map(fields).collect::<Vec<_>>();
        let reserve = first.leading_block_host_layout.as_ref().unwrap().reserve_hu;
        let owner = first
            .leading_block_host_layout
            .as_ref()
            .unwrap()
            .control_index;
        let Control::Table(table) =
            &mut core.document_mut().sections[0].paragraphs[0].controls[owner]
        else {
            unreachable!()
        };
        let para_shape_id = table.cells[0].paragraphs[0].para_shape_id;
        match change {
            "content" => table.cells[0].paragraphs[0].text.push('X'),
            "geometry" => table.common.height += 100,
            "style" => {
                core.document_mut().doc_info.para_shapes[para_shape_id as usize].spacing_before +=
                    100
            }
            "page_context" => {
                core.document_mut().sections[0]
                    .section_def
                    .page_def
                    .margin_left += 100;
            }
            "section_context" => {
                core.document_mut().sections[0].section_def.line_grid += 1;
            }
            "other_column_context" => {
                core.document_mut().sections[0].paragraphs[1]
                    .controls
                    .push(Control::ColumnDef(rhwp::model::page::ColumnDef {
                        column_count: 2,
                        ..Default::default()
                    }));
            }
            "missing_leading_slot" => {
                core.document_mut().sections[0].paragraphs[0].char_offsets[0] -= 8;
            }
            "unexplained_internal_gap" => {
                let p = &mut core.document_mut().sections[0].paragraphs[0];
                for offset in &mut p.char_offsets[1..] {
                    *offset += 8;
                }
                p.char_count += 8;
            }
            "orphan_field_end" => {
                core.document_mut().sections[0].paragraphs[0]
                    .orphan_field_ends
                    .push(Default::default());
            }
            "compound_field" => {
                let p = &mut core.document_mut().sections[0].paragraphs[0];
                let field_index = p
                    .controls
                    .iter()
                    .position(|c| matches!(c, Control::Field(_)))
                    .unwrap();
                let field = p.controls[field_index].clone();
                let new_index = p.controls.len();
                p.controls.push(field);
                p.field_ranges.push(rhwp::model::paragraph::FieldRange {
                    control_idx: new_index,
                    start_char_idx: 0,
                    end_char_idx: 1,
                    end_field_id: 0,
                });
            }
            _ => unreachable!(),
        }
        if change == "compound_field" {
            let before: Vec<_> = core
                .document()
                .sections
                .iter()
                .map(|s| format!("{:#?}", s.paragraphs))
                .collect();
            let error = core.export_hwpx_native().unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("작성된 빈 hp:t의 자식 구조를 복원할 수 없습니다"),
                "specific malformed authored-run guard: {error}"
            );
            let after: Vec<_> = core
                .document()
                .sections
                .iter()
                .map(|s| format!("{:#?}", s.paragraphs))
                .collect();
            assert_eq!(
                after, before,
                "rejected direct field graph leaves live IR unchanged"
            );
            continue;
        }
        let saved = core
            .export_hwpx_native()
            .unwrap_or_else(|error| panic!("{change}: {error}"));
        let document = rhwp::parser::parse_document(&saved).unwrap();
        let result = document.sections[0].paragraphs[0]
            .line_segs
            .iter()
            .map(fields)
            .collect::<Vec<_>>();
        for (old, new) in original.iter().zip(&result) {
            assert_eq!(new[1], old[1] - i64::from(reserve));
            for field in [0, 2, 3, 4, 5, 6, 7, 8] {
                assert_eq!(new[field], old[field]);
            }
        }
        assert_eq!(
            all_lines(&core)[0],
            original,
            "read-only export normalizes a clone"
        );
    }
}

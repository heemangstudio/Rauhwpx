//! 빈 run과 실제 빈 텍스트 fragment의 저장 계약.
use rhwp::model::document::{Document, Section};
use rhwp::model::paragraph::{CharShapeRef, Paragraph};
use rhwp::parser::hwpx::section::parse_hwpx_section;
use rhwp::serializer::hwpx::{context::SerializeContext, section::write_section};

fn runs(xml: &str) -> Paragraph {
    let section = parse_hwpx_section(&format!(
        "<hs:sec xmlns:hs=\"urn:hs\" xmlns:hp=\"urn:hp\"><hp:p>{xml}</hp:p></hs:sec>"
    ))
    .unwrap();
    section.paragraphs.into_iter().next().unwrap()
}

fn save(para: Paragraph) -> String {
    let section = Section {
        paragraphs: vec![Paragraph::default(), para],
        ..Default::default()
    };
    let doc = Document::default();
    String::from_utf8(write_section(&section, &doc, 0, &mut SerializeContext::default()).unwrap())
        .unwrap()
}

fn target(xml: &str) -> Paragraph {
    parse_hwpx_section(xml)
        .unwrap()
        .paragraphs
        .into_iter()
        .nth(1)
        .unwrap()
}

#[test]
fn empty_text_fragment_bare_and_terminal_only_runs_keep_style_without_child() {
    for terminal in [None, Some(0)] {
        let para = Paragraph {
            char_count: 1,
            has_para_text: terminal.is_some(),
            para_text_terminal: terminal,
            char_shapes: vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: 7,
            }],
            ..Default::default()
        };
        let xml = save(para);
        assert!(xml.contains("<hp:run charPrIDRef=\"7\"></hp:run>"));
        assert!(!xml.contains("<hp:t></hp:t>"));
        assert_eq!(target(&xml).char_shapes[0].char_shape_id, 7);
    }
}

#[test]
fn empty_text_fragment_control_residual_is_terminal_not_per_control() {
    let mut para = runs("<hp:run charPrIDRef=\"3\"><hp:equation/><hp:equation/></hp:run>");
    para.authored_text_runs = None;
    para.para_text_terminal = Some(16);
    para.control_mask = 1 << 11;
    let xml = save(para.clone());
    assert_eq!(xml.matches("<hp:t></hp:t>").count(), 1);
    assert!(xml.contains("</hp:equation><hp:t></hp:t></hp:run>"));
    para.char_shapes.push(CharShapeRef {
        start_pos: 16,
        char_shape_id: 9,
    });
    let styled = save(para);
    assert!(styled.contains("<hp:run charPrIDRef=\"9\"><hp:t></hp:t></hp:run>"));
    assert_eq!(styled.matches("<hp:t></hp:t>").count(), 1);
}

#[test]
fn empty_text_fragment_authored_order_and_same_style_runs_survive_reopen() {
    let para = runs("<hp:run charPrIDRef=\"3\"><hp:t/><hp:t>😀</hp:t><hp:t></hp:t><hp:equation/><hp:t/></hp:run><hp:run charPrIDRef=\"3\"><hp:t/></hp:run>");
    let original = para.authored_text_runs.clone().unwrap();
    assert_eq!(
        original[0]
            .empty_children
            .iter()
            .map(|child| child.utf16_pos)
            .collect::<Vec<_>>(),
        vec![0, 2, 10]
    );
    assert_eq!(original[1].start_pos, 10);
    let saved = save(para);
    let reopened = target(&saved);
    assert_eq!(reopened.authored_text_runs.as_ref(), Some(&original));
    let saved_again = save(reopened);
    assert_eq!(
        target(&saved_again).authored_text_runs.as_ref(),
        Some(&original)
    );
}

#[test]
fn empty_text_fragment_authored_empty_between_text_fragments_survives() {
    let para = runs("<hp:run charPrIDRef=\"2\"><hp:t>A</hp:t><hp:t/><hp:t>B</hp:t></hp:run>");
    let saved = save(para);
    assert!(saved.contains("<hp:t>A</hp:t><hp:t></hp:t><hp:t>B</hp:t>"));
    assert_eq!(target(&saved).text, "AB");
}

#[test]
fn empty_text_fragment_split_and_empty_merge_preserve_provenance_scope() {
    let mut host = runs("<hp:run charPrIDRef=\"2\"><hp:t>AB</hp:t><hp:t/></hp:run>");
    let empty = runs("<hp:run charPrIDRef=\"8\"><hp:t/><hp:t/></hp:run>");
    let meta = empty.capture_meta();
    assert_eq!(meta.empty_char_shapes, Some(vec![(0, 8)]));
    assert_eq!(meta.empty_authored_text_runs, empty.authored_text_runs);
    let before = host.authored_text_runs.clone();
    assert_eq!(host.merge_from(&empty), 2);
    assert_eq!(host.authored_text_runs, before); // no-op merge must not erase the host
    let mut tail = host.split_at(2);
    assert!(host.authored_text_runs.is_none());
    assert!(tail.authored_text_runs.is_none());
    tail.apply_meta(meta);
    assert_eq!(
        tail.char_shapes
            .iter()
            .map(|shape| (shape.start_pos, shape.char_shape_id))
            .collect::<Vec<_>>(),
        vec![(0, 8)]
    );
    assert_eq!(tail.authored_text_runs, empty.authored_text_runs);
    assert_eq!(
        target(&save(tail)).authored_text_runs,
        empty.authored_text_runs
    );
}

#[test]
fn empty_text_fragment_content_edit_invalidates_authored_coordinates_not_noop() {
    let mut para = runs("<hp:run charPrIDRef=\"2\"><hp:t>A</hp:t><hp:t/></hp:run>");
    let original = para.authored_text_runs.clone();
    para.insert_text_at(0, "");
    para.delete_text_at(0, 0);
    assert_eq!(para.authored_text_runs, original);
    para.insert_text_at(0, "B");
    assert!(para.authored_text_runs.is_none());
    assert_eq!(target(&save(para)).text, "BA");
}

#[test]
fn empty_text_fragment_terminal_only_scan_uses_paragraph_mask() {
    let para = Paragraph {
        char_count: 1,
        has_para_text: true,
        para_text_terminal: Some(0),
        control_mask: 1 << 11,
        char_shapes: vec![CharShapeRef {
            start_pos: 0,
            char_shape_id: 7,
        }],
        ..Default::default()
    };
    assert!(save(para).contains("<hp:run charPrIDRef=\"7\"><hp:t></hp:t></hp:run>"));
}

fn first_run_topology(xml: &str) -> Vec<(u32, Vec<String>)> {
    use quick_xml::{events::Event, Reader};
    let mut reader = Reader::from_str(xml);
    let mut depth = 0usize;
    let mut in_para = false;
    let mut in_run = false;
    let mut runs: Vec<(u32, Vec<String>)> = Vec::new();
    loop {
        match reader.read_event().unwrap() {
            Event::Start(e) => {
                let name = String::from_utf8(e.name().as_ref().to_vec()).unwrap();
                let local = name.rsplit(':').next().unwrap();
                if !in_para && local == "p" {
                    in_para = true;
                    depth = 1;
                    continue;
                }
                if in_para {
                    if depth == 1 && local == "run" {
                        let id = e
                            .attributes()
                            .flatten()
                            .find(|a| a.key.as_ref() == b"charPrIDRef")
                            .map(|a| std::str::from_utf8(&a.value).unwrap().parse().unwrap())
                            .unwrap();
                        runs.push((id, Vec::new()));
                        in_run = true;
                    } else if depth == 2 && in_run {
                        runs.last_mut().unwrap().1.push(local.to_owned());
                    }
                    depth += 1;
                }
            }
            Event::Empty(e) if in_para => {
                let name = String::from_utf8(e.name().as_ref().to_vec()).unwrap();
                let local = name.rsplit(':').next().unwrap();
                if depth == 1 && local == "run" {
                    let id = e
                        .attributes()
                        .flatten()
                        .find(|a| a.key.as_ref() == b"charPrIDRef")
                        .map(|a| std::str::from_utf8(&a.value).unwrap().parse().unwrap())
                        .unwrap();
                    runs.push((id, Vec::new()));
                } else if depth == 2 && in_run {
                    runs.last_mut().unwrap().1.push(local.to_owned());
                }
            }
            Event::End(_) if in_para => {
                if depth == 2 {
                    in_run = false;
                }
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    runs
}

fn prefix_roundtrips(input: &str, expected: Vec<(u32, Vec<String>)>) {
    let mut xml =
        format!("<hs:sec xmlns:hs=\"urn:hs\" xmlns:hp=\"urn:hp\"><hp:p>{input}</hp:p></hs:sec>");
    assert_eq!(first_run_topology(&xml), expected);
    for _ in 0..3 {
        let section = parse_hwpx_section(&xml).unwrap();
        xml = String::from_utf8(
            write_section(
                &section,
                &Document::default(),
                0,
                &mut SerializeContext::default(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            first_run_topology(&xml),
            expected,
            "prefix/run topology must not grow on resave"
        );
    }
}

fn tags(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| (*name).to_owned()).collect()
}

#[test]
fn empty_text_fragment_section_prefix_relocation_preserves_later_child_order() {
    // Authentic English has equal style15 prefix/content runs at UTF16 0/16.
    // Six equation controls exercise the same ordered six-child topology without corpus geometry.
    prefix_roundtrips(
        "<hp:run charPrIDRef=\"15\"><hp:secPr></hp:secPr><hp:ctrl><hp:colPr colCount=\"1\"/></hp:ctrl></hp:run><hp:run charPrIDRef=\"15\"><hp:equation/><hp:equation/><hp:equation/><hp:equation/><hp:equation/><hp:equation/><hp:t/></hp:run>",
        vec![(15, tags(&["secPr", "ctrl"])), (15, tags(&["equation", "equation", "equation", "equation", "equation", "equation", "t"]))],
    );
}

#[test]
fn empty_text_fragment_same_prefix_run_and_prefix_only_keep_complete_topology() {
    for tail in ["", "<hp:t/>", "<hp:t/><hp:equation/><hp:t/>"] {
        let input = format!("<hp:run charPrIDRef=\"7\"><hp:secPr></hp:secPr><hp:ctrl><hp:colPr colCount=\"1\"/></hp:ctrl>{tail}</hp:run>");
        let mut children = tags(&["secPr", "ctrl"]);
        if tail == "<hp:t/>" {
            children.push("t".into());
        } else if !tail.is_empty() {
            children.extend(tags(&["t", "equation", "t"]));
        }
        prefix_roundtrips(&input, vec![(7, children)]);
    }
}

#[test]
fn empty_text_fragment_later_column_change_is_not_template_prefix() {
    prefix_roundtrips(
        "<hp:run charPrIDRef=\"7\"><hp:secPr></hp:secPr><hp:ctrl><hp:colPr colCount=\"1\"/></hp:ctrl><hp:t/><hp:equation/><hp:ctrl><hp:colPr colCount=\"2\"/></hp:ctrl><hp:t/></hp:run>",
        vec![(7, tags(&["secPr", "ctrl", "t", "equation", "ctrl", "t"]))],
    );
    prefix_roundtrips(
        "<hp:run charPrIDRef=\"7\"><hp:secPr><hp:colPr colCount=\"1\"/></hp:secPr><hp:t/><hp:equation/><hp:ctrl><hp:colPr colCount=\"2\"/></hp:ctrl><hp:t/></hp:run>",
        vec![(7, tags(&["secPr", "t", "equation", "ctrl", "t"]))],
    );
}

#[test]
fn authored_style_mutations_preserve_noops_and_discard_changed_signatures() {
    for operation in 0..3 {
        let mut para = runs("<hp:run charPrIDRef=\"0\"><hp:t>AB</hp:t><hp:t/></hp:run>");
        let before = para.authored_text_runs.clone();
        match operation {
            0 => para.apply_char_shape_range(0, 2, 0),
            1 => para.set_single_char_shape(0),
            _ => para.replace_style_char_shape_preserving_overrides(0, 0),
        }
        assert_eq!(para.authored_text_runs, before);
        match operation {
            0 => para.apply_char_shape_range(0, 1, 1),
            1 => para.set_single_char_shape(1),
            _ => para.replace_style_char_shape_preserving_overrides(0, 1),
        }
        assert!(para.authored_text_runs.is_none());
        assert_eq!(target(&save(para)).text, "AB");
    }
}

fn native_authored_document() -> Document {
    use std::io::Read;
    let bytes = include_bytes!("../../samples/hwpx/ref/ref_empty.hwpx");
    let mut source = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut xml = String::new();
    source
        .by_name("Contents/section0.xml")
        .unwrap()
        .read_to_string(&mut xml)
        .unwrap();
    assert_eq!(xml.matches("<hp:t/>").count(), 1);
    xml = xml.replace("<hp:t/>", "<hp:t>AB</hp:t><hp:t/>");
    let mut doc = rhwp::parser::hwpx::parse_hwpx(bytes).unwrap();
    doc.sections[0] = parse_hwpx_section(&xml).unwrap();
    assert!(doc.sections[0].paragraphs[0]
        .authored_text_runs
        .as_ref()
        .unwrap()
        .iter()
        .any(|run| !run.prefix_children.is_empty()));
    doc
}

fn with_cell(doc: &mut Document, paragraph: Paragraph) {
    use rhwp::model::{
        control::Control,
        table::{Cell, Table},
    };
    doc.sections[0].paragraphs.push(Paragraph {
        char_count: 9,
        controls: vec![Control::Table(Box::new(Table {
            row_count: 1,
            col_count: 1,
            cells: vec![Cell {
                row_span: 1,
                col_span: 1,
                width: 10000,
                height: 2000,
                paragraphs: vec![paragraph],
                ..Default::default()
            }],
            ..Default::default()
        }))],
        char_shapes: vec![CharShapeRef::default()],
        ..Default::default()
    });
}

#[test]
fn public_body_and_cell_formatting_save_twice_and_reopen_with_effective_styles() {
    use rhwp::document_core::DocumentCore;
    use rhwp::serializer::hwpx::serialize_hwpx;
    use serde_json::Value;
    let mut doc = native_authored_document();
    with_cell(
        &mut doc,
        runs("<hp:run charPrIDRef=\"0\"><hp:t>CD</hp:t><hp:t/></hp:run>"),
    );
    let mut italic = doc.doc_info.char_shapes[0].clone();
    italic.italic = true;
    let char_id = doc.doc_info.char_shapes.len();
    doc.doc_info.char_shapes.push(italic);
    let mut style = doc.doc_info.styles[0].clone();
    style.local_name = "Authored paragraph style".into();
    style.english_name = style.local_name.clone();
    style.raw_data = None;
    style.style_type = 0;
    style.char_shape_id = char_id as u16;
    let style_id = doc.doc_info.styles.len();
    doc.doc_info.styles.push(style);
    let mut core = DocumentCore::from_bytes(&serialize_hwpx(&doc).unwrap()).unwrap();
    core.apply_char_format_native(0, 0, 0, 1, r#"{"bold":true}"#)
        .unwrap();
    core.apply_style_native(0, 0, style_id).unwrap();
    core.apply_char_format_in_cell_native(0, 1, 0, 0, 0, 0, 1, r#"{"bold":true}"#)
        .unwrap();
    core.apply_cell_style_native(0, 1, 0, 0, 0, style_id)
        .unwrap();
    let check = |core: &DocumentCore| {
        assert_eq!(core.document().sections[0].paragraphs[0].text, "AB");
        let rhwp::model::control::Control::Table(table) =
            &core.document().sections[0].paragraphs[1].controls[0]
        else {
            panic!("table");
        };
        assert_eq!(table.cells[0].paragraphs[0].text, "CD");
        for (offset, key) in [(0, "bold"), (1, "italic")] {
            let body: Value =
                serde_json::from_str(&core.get_char_properties_at_native(0, 0, offset).unwrap())
                    .unwrap();
            let cell: Value = serde_json::from_str(
                &core
                    .get_cell_char_properties_at_native(0, 1, 0, 0, 0, offset)
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(body[key], true);
            assert_eq!(cell[key], true);
        }
        assert_eq!(
            core.document().sections[0].paragraphs[0].style_id as usize,
            style_id
        );
        assert_eq!(table.cells[0].paragraphs[0].style_id as usize, style_id);
    };
    check(&core);
    for bytes in [
        core.export_hwpx_native().unwrap(),
        core.export_hwpx_native().unwrap(),
    ] {
        let reopened = DocumentCore::from_bytes(&bytes).unwrap();
        check(&reopened);
        check(&DocumentCore::from_bytes(&reopened.export_hwpx_native().unwrap()).unwrap());
    }
}

#[test]
fn clickhere_loader_normalization_discards_changed_authored_topology_in_body_and_cell() {
    use rhwp::document_core::DocumentCore;
    use rhwp::serializer::hwpx::serialize_hwpx;
    let guide = runs(
        r#"<hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin id="7" type="CLICK_HERE"><hp:parameters cnt="1" name=""><hp:stringParam name="Command">Clickhere:set:48:Direction:wstring:6:여기에 입력 HelpState:wstring:0:  </hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl><hp:t>여기에 입력</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="7"/></hp:ctrl><hp:t>Z</hp:t><hp:t/></hp:run>"#,
    );
    assert!(guide.authored_text_runs.is_some());
    for cell in [false, true] {
        let mut doc = native_authored_document();
        if cell {
            with_cell(&mut doc, guide.clone());
        } else {
            doc.sections[0].paragraphs.push(guide.clone());
        }
        let core = DocumentCore::from_bytes(&serialize_hwpx(&doc).unwrap()).unwrap();
        let check = |core: &DocumentCore| {
            let para = &core.document().sections[0].paragraphs[1];
            let para = if cell {
                let rhwp::model::control::Control::Table(table) = &para.controls[0] else {
                    panic!("table");
                };
                &table.cells[0].paragraphs[0]
            } else {
                para
            };
            assert_eq!(para.text, "Z");
            assert_eq!(
                para.field_ranges[0].start_char_idx,
                para.field_ranges[0].end_char_idx
            );
        };
        check(&core);
        for bytes in [
            core.export_hwpx_native().unwrap(),
            core.export_hwpx_native().unwrap(),
        ] {
            let reopened = DocumentCore::from_bytes(&bytes).unwrap();
            check(&reopened);
            check(&DocumentCore::from_bytes(&reopened.export_hwpx_native().unwrap()).unwrap());
        }
    }
}

#[test]
fn equal_nonzero_style_ids_repair_missing_character_shape_refs() {
    let mut para = Paragraph {
        text: "A".into(),
        char_count: 2,
        char_offsets: vec![0],
        ..Default::default()
    };
    assert_eq!(para.char_shape_id_at(0), None);
    para.replace_style_char_shape_preserving_overrides(7, 7);
    assert_eq!(para.char_shape_id_at(0), Some(7));
}

#[test]
fn public_body_and_cell_equal_style_ids_repair_missing_refs_through_save_reopen() {
    use rhwp::document_core::DocumentCore;
    use rhwp::model::control::Control;
    use serde_json::Value;

    // 같은 스타일 재적용과 같은 글자 모양을 공유하는 다른 문단 스타일을 모두 확인한다.
    for reapply in [true, false] {
        let mut doc = native_authored_document();
        with_cell(
            &mut doc,
            runs("<hp:run charPrIDRef=\"0\"><hp:t>CD</hp:t><hp:t/></hp:run>"),
        );
        let base_shape = doc.doc_info.char_shapes[0].clone();
        doc.doc_info.char_shapes.resize(8, base_shape.clone());
        doc.doc_info.char_shapes[0].bold = false;
        doc.doc_info.char_shapes[0].italic = false;
        let mut styled = base_shape;
        styled.bold = true;
        styled.italic = true;
        styled.raw_data = None;
        doc.doc_info.char_shapes[7] = styled;
        doc.doc_info.styles[0].char_shape_id = 7;
        doc.doc_info.styles[0].style_type = 0;
        doc.doc_info.styles[0].raw_data = None;
        let mut other_style = doc.doc_info.styles[0].clone();
        other_style.local_name = "Shared nonzero character style".into();
        other_style.english_name = other_style.local_name.clone();
        let other_style_id = doc.doc_info.styles.len();
        doc.doc_info.styles.push(other_style);
        let target_style = if reapply { 0 } else { other_style_id };
        let body = &mut doc.sections[0].paragraphs[0];
        body.style_id = 0;
        body.char_shapes.clear();
        body.authored_text_runs = None;
        let Control::Table(table) = &mut doc.sections[0].paragraphs[1].controls[0] else {
            panic!("table");
        };
        let cell = &mut table.cells[0].paragraphs[0];
        cell.style_id = 0;
        cell.char_shapes.clear();
        cell.authored_text_runs = None;

        // HWP의 PARA_CHAR_SHAPE 부재와 같은 모델을 공개 진입점으로 설치한다.
        // XML 재로딩은 빈 참조를 0번으로 정규화하므로 이 경계의 대체 입력이 될 수 없다.
        let mut core = DocumentCore::new_empty();
        core.set_document(doc);
        assert!(core.document().sections[0].paragraphs[0]
            .char_shapes
            .is_empty());
        let Control::Table(table) = &core.document().sections[0].paragraphs[1].controls[0] else {
            panic!("table");
        };
        assert!(table.cells[0].paragraphs[0].char_shapes.is_empty());
        core.apply_style_native(0, 0, target_style).unwrap();
        core.apply_cell_style_native(0, 1, 0, 0, 0, target_style)
            .unwrap();
        let check = |core: &DocumentCore| {
            let body = &core.document().sections[0].paragraphs[0];
            let Control::Table(table) = &core.document().sections[0].paragraphs[1].controls[0]
            else {
                panic!("table");
            };
            let cell = &table.cells[0].paragraphs[0];
            assert_eq!(body.text, "AB");
            assert_eq!(cell.text, "CD");
            assert_eq!(body.char_shape_id_at(0), Some(7));
            assert_eq!(cell.char_shape_id_at(0), Some(7));
            assert_eq!(body.style_id as usize, target_style);
            assert_eq!(cell.style_id as usize, target_style);
            for raw in [
                core.get_char_properties_at_native(0, 0, 0).unwrap(),
                core.get_cell_char_properties_at_native(0, 1, 0, 0, 0, 0)
                    .unwrap(),
            ] {
                let properties: Value = serde_json::from_str(&raw).unwrap();
                assert_eq!(properties["bold"], true);
                assert_eq!(properties["italic"], true);
            }
        };
        check(&core);
        for bytes in [
            core.export_hwpx_native().unwrap(),
            core.export_hwpx_native().unwrap(),
        ] {
            let reopened = DocumentCore::from_bytes(&bytes).unwrap();
            check(&reopened);
            check(&DocumentCore::from_bytes(&reopened.export_hwpx_native().unwrap()).unwrap());
        }
    }
}

#[test]
fn authored_empty_children_project_only_explicitly_collapsed_page_number_slots() {
    use rhwp::model::paragraph::LineSeg;
    for tail in [
        "",
        "<hp:run charPrIDRef=\"7\"><hp:t>Z</hp:t><hp:t/></hp:run>",
    ] {
        let mut para = runs(&format!(
            "<hp:run charPrIDRef=\"16\"><hp:ctrl><hp:pageNum/></hp:ctrl></hp:run><hp:run charPrIDRef=\"153\"><hp:ctrl><hp:pageNum/></hp:ctrl><hp:t/></hp:run>{tail}"
        ));
        assert_eq!(para.char_count, 17 + u32::from(!tail.is_empty()));
        para.line_segs = vec![LineSeg {
            text_start: 16,
            line_height: 1000,
            text_height: 1000,
            ..Default::default()
        }];
        let xml = save(para);
        assert_eq!(xml.matches("<hp:pageNum").count(), 1);
        assert!(xml.contains("<hp:run charPrIDRef=\"153\"><hp:t></hp:t></hp:run>"));
        let reopened = target(&xml);
        assert_eq!(reopened.char_count, 9 + u32::from(!tail.is_empty()));
        assert_eq!(reopened.line_segs[0].text_start, 8);
        let topology = reopened.authored_text_runs.clone().unwrap();
        assert_eq!((topology[1].start_pos, topology[1].end_pos), (8, 8));
        assert_eq!(topology[1].child_count, 1);
        assert_eq!(topology[1].empty_children[0].child_index, 0);
        assert_eq!(topology[1].empty_children[0].utf16_pos, 8);
        if !tail.is_empty() {
            assert_eq!(reopened.text, "Z");
            assert_eq!(reopened.char_offsets, vec![8]);
            assert_eq!(topology[2].text_starts, vec![8]);
            assert_eq!(topology[2].empty_children[0].utf16_pos, 9);
        }
        let second = save(reopened);
        assert_eq!(second.matches("<hp:pageNum").count(), 1);
        assert_eq!(target(&second).authored_text_runs, Some(topology));
    }
}

#[test]
fn authored_empty_child_restore_rejects_unaccounted_topology_change() {
    let mut para = runs("<hp:run charPrIDRef=\"2\"><hp:t>A</hp:t><hp:t/></hp:run>");
    para.authored_text_runs.as_mut().unwrap()[0].child_count += 1;
    let section = Section {
        paragraphs: vec![Paragraph::default(), para],
        ..Default::default()
    };
    let error = write_section(
        &section,
        &Document::default(),
        0,
        &mut SerializeContext::default(),
    )
    .unwrap_err();
    assert!(error.to_string().contains("자식 구조"), "{error}");
}

#[test]
fn grouped_page_number_controls_keep_body_and_nested_cell_utf16_axes_on_resave() {
    use rhwp::model::control::Control;
    // Earlier empty hp:t retains every run. The grouped ctrl has no standalone
    // pageNum child mapping, with or without an empty child in its own run.
    for empty in ["", "<hp:t/>"] {
        let input = format!(concat!(
        "<hp:run charPrIDRef=\"0\"><hp:ctrl><hp:pageNum/></hp:ctrl><hp:t/></hp:run>",
        "<hp:run charPrIDRef=\"1\"><hp:ctrl><hp:pageNum/><hp:newNum num=\"7\" numType=\"PAGE\"/></hp:ctrl>{}</hp:run>",
        "<hp:run charPrIDRef=\"2\"><hp:t>😀Z</hp:t><hp:t/></hp:run>",
        "<hp:linesegarray><hp:lineseg textpos=\"0\" vertsize=\"1000\" textheight=\"1000\"/><hp:lineseg textpos=\"24\" vertsize=\"1000\" textheight=\"1000\"/><hp:lineseg textpos=\"26\" vertsize=\"1000\" textheight=\"1000\"/></hp:linesegarray>"
    ), empty);
        let original = runs(&input);
        let original_runs = original.authored_text_runs.as_ref().unwrap();
        assert_eq!(
            (original_runs[1].start_pos, original_runs[1].end_pos),
            (8, 24)
        );
        assert_eq!(
            original_runs[1].child_count,
            1 + usize::from(!empty.is_empty())
        );
        assert!(original_runs[1].page_number_children.is_empty());
        assert_eq!(
            original_runs[1].empty_children.len(),
            usize::from(!empty.is_empty())
        );
        assert!(original_runs[1].prefix_children.is_empty());
        assert_eq!(original.char_offsets, vec![24, 26]);

        for depth in [0, 2] {
            let mut input = input.to_owned();
            for _ in 0..depth {
                // Parent controls bracket the nested table, so leaking a child's
                // dedup state or collapsed axis changes this paragraph too.
                input = format!(
                    r#"<hp:run charPrIDRef="0"><hp:ctrl><hp:pageNum/></hp:ctrl><hp:tbl rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:subList><hp:p>{input}</hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="10000" height="2000"/></hp:tc></hp:tr></hp:tbl><hp:ctrl><hp:pageNum/></hp:ctrl><hp:t>P</hp:t><hp:t/></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertsize="1000" textheight="1000"/><hp:lineseg textpos="24" vertsize="1000" textheight="1000"/></hp:linesegarray>"#
                );
            }
            let mut xml = save(runs(&input));
            let mut first_topology = None;
            for round in 0..2 {
                assert_eq!(xml.matches("<hp:pageNum").count(), depth + 1);
                assert_eq!(xml.matches("<hp:newNum").count(), 1);
                let root = target(&xml);
                let mut paragraph = &root;
                let mut topology = Vec::new();
                for _ in 0..depth {
                    assert_eq!(paragraph.controls.len(), 2);
                    assert!(matches!(paragraph.controls[0], Control::PageNumberPos(_)));
                    assert_eq!(paragraph.text, "P");
                    assert_eq!(paragraph.char_offsets, vec![16]);
                    assert_eq!(paragraph.char_count, 18);
                    assert_eq!(
                        paragraph
                            .line_segs
                            .iter()
                            .map(|line| line.text_start)
                            .collect::<Vec<_>>(),
                        vec![0, 16]
                    );
                    topology.push(paragraph.authored_text_runs.clone());
                    let Control::Table(table) = &paragraph.controls[1] else {
                        panic!("nested table");
                    };
                    assert_eq!(table.cells.len(), 1);
                    assert_eq!(table.cells[0].paragraphs.len(), 1);
                    paragraph = &table.cells[0].paragraphs[0];
                }
                assert_eq!(paragraph.controls.len(), 2);
                assert!(matches!(paragraph.controls[0], Control::PageNumberPos(_)));
                let Control::NewNumber(number) = &paragraph.controls[1] else {
                    panic!("retained newNum");
                };
                assert_eq!(number.number, 7);
                assert_eq!(paragraph.text, "😀Z");
                assert_eq!(paragraph.char_offsets, vec![16, 18]);
                assert_eq!(paragraph.char_count, 20);
                assert_eq!(
                    paragraph
                        .line_segs
                        .iter()
                        .map(|line| line.text_start)
                        .collect::<Vec<_>>(),
                    vec![0, 16, 18]
                );
                let authored = paragraph.authored_text_runs.as_ref().unwrap();
                assert_eq!(
                    authored
                        .iter()
                        .map(|run| (run.start_pos, run.end_pos, run.char_shape_id))
                        .collect::<Vec<_>>(),
                    vec![(0, 8, 0), (8, 16, 1), (16, 19, 2)]
                );
                assert_eq!(authored[0].empty_children.len(), 1);
                assert_eq!(
                    (
                        authored[0].empty_children[0].utf16_pos,
                        authored[0].empty_children[0].child_index
                    ),
                    (8, 1)
                );
                assert_eq!(authored[1].child_count, 1 + usize::from(!empty.is_empty()));
                assert_eq!(
                    authored[1].empty_children.len(),
                    usize::from(!empty.is_empty())
                );
                if !empty.is_empty() {
                    assert_eq!(
                        (
                            authored[1].empty_children[0].utf16_pos,
                            authored[1].empty_children[0].child_index
                        ),
                        (16, 1)
                    );
                }
                assert_eq!(authored[2].text_starts, vec![16]);
                assert_eq!(
                    (
                        authored[2].empty_children[0].utf16_pos,
                        authored[2].empty_children[0].child_index
                    ),
                    (19, 1)
                );
                topology.push(paragraph.authored_text_runs.clone());
                if let Some(first) = &first_topology {
                    assert_eq!(&topology, first);
                } else {
                    first_topology = Some(topology);
                }
                if round == 0 {
                    xml = save(root);
                }
            }
        }
    }
}

#[test]
fn authored_restoration_rejects_missing_whole_child_collapse_mapping() {
    let mut para = runs(concat!(
        "<hp:run charPrIDRef=\"0\"><hp:ctrl><hp:pageNum/></hp:ctrl></hp:run>",
        "<hp:run charPrIDRef=\"1\"><hp:ctrl><hp:pageNum/></hp:ctrl><hp:t/></hp:run>"
    ));
    para.authored_text_runs.as_mut().unwrap()[1]
        .page_number_children
        .clear();
    let section = Section {
        paragraphs: vec![Paragraph::default(), para],
        ..Default::default()
    };
    let error = write_section(
        &section,
        &Document::default(),
        0,
        &mut SerializeContext::default(),
    )
    .unwrap_err();
    assert!(error.to_string().contains("자식 구조"), "{error}");
}

#[test]
fn untemplated_section_prefix_normalization_keeps_body_and_cell_styles_on_resave() {
    use rhwp::{
        model::control::Control, parser::hwpx::parse_hwpx, serializer::hwpx::serialize_hwpx,
    };
    for embedded_column in [false, true] {
        for prefix_empty in ["", "<hp:t/>"] {
            let column = "<hp:colPr colCount=\"2\" sameSz=\"1\" sameGap=\"42\"/>";
            let prefix = if embedded_column {
                format!("<hp:secPr>{column}</hp:secPr>")
            } else {
                format!("<hp:secPr></hp:secPr><hp:ctrl>{column}</hp:ctrl>")
            };
            let source = runs(&format!(
                "<hp:run charPrIDRef=\"0\">{prefix}{prefix_empty}</hp:run><hp:run charPrIDRef=\"1\"><hp:t>X😀</hp:t><hp:t/></hp:run>"
            ));
            assert_eq!(source.char_offsets, vec![16, 17]);
            assert_eq!(
                source.authored_text_runs.as_ref().unwrap()[0]
                    .prefix_children
                    .len(),
                if embedded_column { 1 } else { 2 }
            );
            let mut document =
                parse_hwpx(include_bytes!("../../samples/hwpx/ref/ref_empty.hwpx")).unwrap();
            let shape = document.doc_info.char_shapes[0].clone();
            if document.doc_info.char_shapes.len() < 2 {
                document.doc_info.char_shapes.push(shape);
            }
            document.sections[0].paragraphs.truncate(1);
            document.sections[0].paragraphs.push(source.clone());
            with_cell(&mut document, source);
            let mut previous = None;
            for _ in 0..2 {
                let bytes = serialize_hwpx(&document).unwrap();
                document = parse_hwpx(&bytes).unwrap();
                let body = &document.sections[0].paragraphs[1];
                let Control::Table(table) = &document.sections[0].paragraphs[2].controls[0] else {
                    panic!("table");
                };
                let cell = &table.cells[0].paragraphs[0];
                let mut topology = Vec::new();
                for paragraph in [body, cell] {
                    assert_eq!(paragraph.controls.len(), 1);
                    let Control::ColumnDef(column) = &paragraph.controls[0] else {
                        panic!("surviving colPr");
                    };
                    assert_eq!(column.column_count, 2);
                    assert_eq!(paragraph.text, "X😀");
                    assert_eq!(paragraph.char_offsets, vec![8, 9]);
                    assert_eq!(paragraph.char_count, 12);
                    assert_eq!(
                        paragraph
                            .char_shapes
                            .iter()
                            .map(|shape| (shape.start_pos, shape.char_shape_id))
                            .collect::<Vec<_>>(),
                        vec![(0, 0), (8, 1)]
                    );
                    let runs = paragraph.authored_text_runs.as_ref().unwrap();
                    assert!(runs.iter().all(|run| run.prefix_children.is_empty()));
                    assert_eq!(
                        runs[0].child_count,
                        1 + usize::from(!prefix_empty.is_empty())
                    );
                    assert_eq!(
                        runs[0].empty_children.len(),
                        usize::from(!prefix_empty.is_empty())
                    );
                    assert_eq!(runs[1].child_count, 2);
                    assert_eq!(
                        (
                            runs[1].empty_children[0].utf16_pos,
                            runs[1].empty_children[0].child_index
                        ),
                        (11, 1)
                    );
                    topology.push(paragraph.authored_text_runs.clone());
                }
                if let Some(previous) = &previous {
                    assert_eq!(&topology, previous);
                }
                previous = Some(topology);
            }
        }
    }
}

#[test]
fn untemplated_prefix_restore_still_rejects_an_unaccounted_missing_column_child() {
    use rhwp::model::control::Control;
    let mut paragraph = runs("<hp:run charPrIDRef=\"0\"><hp:secPr></hp:secPr><hp:ctrl><hp:colPr colCount=\"1\"/></hp:ctrl><hp:t/></hp:run>");
    paragraph
        .controls
        .retain(|control| !matches!(control, Control::ColumnDef(_)));
    let section = Section {
        paragraphs: vec![Paragraph::default(), paragraph],
        ..Default::default()
    };
    let error = write_section(
        &section,
        &Document::default(),
        0,
        &mut SerializeContext::default(),
    )
    .unwrap_err();
    assert!(error.to_string().contains("자식 구조"), "{error}");
}

//! 빈칸 Unicode가 같아도 원본 control/literal 출처는 편집과 저장에서 보존한다.
use rhwp::model::control::{Control, Equation};
use rhwp::model::document::Section;
use rhwp::model::footnote::{Endnote, Footnote};
use rhwp::model::header_footer::{Footer, Header, MasterPage};
use rhwp::model::paragraph::{
    CharShapeRef, Paragraph, SpecialSpaceOrigin, SpecialSpaceOriginKind as Kind, TextContent,
};
use rhwp::model::shape::{ShapeObject, TextBox};
use rhwp::model::table::{Cell, Table};
use rhwp::wasm_api::HwpDocument;
use serde_json::Value;

fn record(char_idx: usize, origin: Kind) -> SpecialSpaceOrigin {
    SpecialSpaceOrigin { char_idx, origin }
}
fn control_content() -> TextContent {
    TextContent {
        text: "\u{a0}\u{2007}".into(),
        special_space_origins: vec![record(0, Kind::NbSpace), record(1, Kind::FwSpace)],
    }
}
fn paragraph(content: &TextContent) -> Paragraph {
    let mut p = Paragraph {
        char_count: 1,
        char_shapes: vec![CharShapeRef::default()],
        ..Default::default()
    };
    p.insert_text_content_at(0, content).unwrap();
    p
}
fn empty() -> HwpDocument {
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native().unwrap();
    doc
}
fn root(doc: &HwpDocument) -> &Paragraph {
    &doc.document().sections[0].paragraphs[0]
}
fn removed(raw: &str) -> TextContent {
    serde_json::from_value(serde_json::from_str::<Value>(raw).unwrap()["removedContent"].clone())
        .unwrap()
}
fn origins(doc: &HwpDocument) -> Vec<SpecialSpaceOrigin> {
    root(doc).special_space_origins.clone()
}

#[test]
fn hwp_import_distinguishes_same_unicode_literal_and_controls() {
    let content = control_content();
    let literal = TextContent::literal(&content.text);
    let section = Section {
        paragraphs: vec![paragraph(&content), paragraph(&literal)],
        ..Default::default()
    };
    let bytes = rhwp::serializer::body_text::serialize_section(&section);
    let reopened = rhwp::parser::body_text::parse_body_text_section(&bytes).unwrap();
    assert_eq!(reopened.paragraphs[0].text, reopened.paragraphs[1].text);
    assert_eq!(
        reopened.paragraphs[0].special_space_origins,
        content.special_space_origins
    );
    assert_eq!(
        reopened.paragraphs[1].special_space_origins,
        literal.special_space_origins
    );
    assert_eq!(reopened.paragraphs[0].control_mask & 0xc0000000, 0xc0000000);
    assert_eq!(reopened.paragraphs[1].control_mask & 0xc0000000, 0);
}

#[test]
fn xml_controls_literal_references_and_child_tails_use_scalar_indices() {
    let xml = "<hs:sec xmlns:hs='x' xmlns:hp='y'><hp:p><hp:run><hp:t>😀<hp:nbSpace/>x&#160;<hp:fwSpace></hp:fwSpace>y&#8199;</hp:t></hp:run></hp:p></hs:sec>";
    let section = rhwp::parser::hwpx::section::parse_hwpx_section(xml).unwrap();
    let p = &section.paragraphs[0];
    assert_eq!(p.text, "😀\u{a0}x\u{a0}\u{2007}y\u{2007}");
    assert_eq!(
        p.special_space_origins,
        vec![
            record(1, Kind::NbSpace),
            record(3, Kind::Literal),
            record(4, Kind::FwSpace),
            record(6, Kind::Literal)
        ]
    );
}

#[test]
fn scalar_edits_split_join_and_unknown_restoration_do_not_use_utf16_or_tab_width() {
    let mut p = paragraph(&TextContent {
        text: "A😀\t\u{a0}\u{2007}Z".into(),
        special_space_origins: vec![record(3, Kind::NbSpace), record(4, Kind::FwSpace)],
    });
    // 원본 HWP 탭은 8유닛이며 😀는 2유닛이다. 출처 인덱스는 3/4다.
    p.char_offsets = vec![0, 1, 3, 11, 12, 13];
    p.char_count = 15;
    let saved = p.capture_text_content(2, 3);
    assert_eq!(
        saved.special_space_origins,
        vec![record(1, Kind::NbSpace), record(2, Kind::FwSpace)]
    );
    assert_eq!(p.delete_text_at(2, 99), 4);
    assert!(p.special_space_origins.is_empty());
    p.insert_text_content_at(99, &saved).unwrap();
    assert_eq!(
        p.special_space_origins,
        vec![record(3, Kind::NbSpace), record(4, Kind::FwSpace)]
    );
    let original = p.capture_text_content(0, usize::MAX);
    let rhs = p.split_at(4);
    assert_eq!(rhs.special_space_origins, vec![record(0, Kind::FwSpace)]);
    p.merge_from(&rhs);
    assert_eq!(p.capture_text_content(0, usize::MAX), original);
    let unknown: TextContent = serde_json::from_str("{\"text\":\"  \"}").unwrap();
    p.insert_text_content_at(0, &unknown).unwrap();
    assert_eq!(p.space_origin_at(0), None);
    assert_eq!(p.space_origin_at(1), None);
    p.insert_text_at(0, &unknown.text);
    assert_eq!(p.space_origin_at(0), Some(Kind::Literal));
    assert_eq!(p.space_origin_at(1), Some(Kind::Literal));
}

#[test]
fn public_rich_insert_after_object_uses_actual_scalar_and_preserves_stream_gap() {
    let mut doc = empty();
    let mut p = paragraph(&control_content());
    p.text = "A😀\t\u{a0}\u{2007}Z".into();
    p.special_space_origins = vec![record(3, Kind::NbSpace), record(4, Kind::FwSpace)];
    p.char_offsets = vec![0, 1, 3, 19, 20, 21];
    p.char_count = 23;
    let mut equation = Equation::default();
    equation.common.treat_as_char = true;
    p.controls.push(Control::Equation(Box::new(equation)));
    doc.document_mut().sections[0].paragraphs[0] = p;
    let payload = serde_json::to_string(&TextContent::literal("\u{a0}")).unwrap();
    let result: Value = serde_json::from_str(
        &doc.insert_text_content(0, 0, 4, &payload, Some(true))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(result["charOffset"], 4);
    assert_eq!(
        root(&doc).special_space_origins,
        vec![
            record(3, Kind::Literal),
            record(4, Kind::NbSpace),
            record(5, Kind::FwSpace)
        ]
    );
    assert_eq!(root(&doc).char_offsets[3], 19);
    let removal = removed(&doc.delete_text(0, 0, 5, 1, Some(true)).unwrap());
    assert_eq!(
        removal,
        TextContent {
            text: "\u{a0}".into(),
            special_space_origins: vec![record(0, Kind::NbSpace)]
        }
    );
}

#[test]
fn native_replace_deletion_and_undo_capture_actual_content_and_clamped_end() {
    let mut doc = empty();
    doc.insert_text_content_native(0, 0, 0, &control_content())
        .unwrap();
    let raw = doc
        .replace_body_text_local_native(0, 0, 0, 1, "\u{a0}")
        .unwrap();
    let inverse = removed(&raw);
    assert_eq!(
        inverse.special_space_origins,
        vec![record(0, Kind::NbSpace)]
    );
    assert_eq!(root(&doc).space_origin_at(0), Some(Kind::Literal));
    doc.delete_text_native(0, 0, 0, 1).unwrap();
    doc.insert_text_content_native(0, 0, 0, &inverse).unwrap();
    assert_eq!(origins(&doc), control_content().special_space_origins);
    let result: Value =
        serde_json::from_str(&doc.delete_text_native(0, 0, 99, 99).unwrap()).unwrap();
    assert_eq!(result["removedStart"], 2);
    assert_eq!(result["removedCount"], 0);
    assert_eq!(result["removedContent"]["text"], "");
}

#[test]
fn clipboard_snapshots_and_capture_digest_keep_same_unicode_origin_identity() {
    let mut doc = empty();
    doc.insert_text_content_native(0, 0, 0, &control_content())
        .unwrap();
    let digest = doc.paragraph_content_digest_native(0, 0).unwrap();
    let snapshot = doc.save_snapshot_native();
    let shared = doc.share_snapshot_native(snapshot).unwrap();
    let capture = doc.capture_paragraph_native(0, 0).unwrap();
    doc.copy_selection_native(0, 0, 0, 0, 2).unwrap();
    doc.paste_internal_native(0, 0, 2).unwrap();
    assert_eq!(
        origins(&doc),
        vec![
            record(0, Kind::NbSpace),
            record(1, Kind::FwSpace),
            record(2, Kind::NbSpace),
            record(3, Kind::FwSpace)
        ]
    );
    doc.restore_snapshot_native(shared).unwrap();
    assert_eq!(origins(&doc), control_content().special_space_origins);
    doc.delete_text_native(0, 0, 0, 2).unwrap();
    doc.insert_text_native(0, 0, 0, &control_content().text)
        .unwrap();
    assert_eq!(root(&doc).text, control_content().text);
    assert_ne!(doc.paragraph_content_digest_native(0, 0).unwrap(), digest);
    doc.restore_captured_paragraph_native(capture, 0, 0)
        .unwrap();
    assert_eq!(doc.paragraph_content_digest_native(0, 0).unwrap(), digest);
    let bytes = doc.export_hwpx_native().unwrap();
    let reopened = HwpDocument::from_local_file_bytes(&bytes).unwrap();
    assert_eq!(origins(&reopened), origins(&doc));
    let mut separate = empty();
    separate.set_document(doc.document().clone());
    assert_eq!(origins(&separate), origins(&doc)); // 모델 clone 확인이며 전체 cold-cache 증명은 아니다.
}

fn visit(paragraphs: &[Paragraph], out: &mut Vec<SpecialSpaceOrigin>) {
    for p in paragraphs {
        p.validate_special_spaces().unwrap();
        out.extend(p.special_space_origins.iter().cloned());
        for c in &p.controls {
            match c {
                Control::Table(t) => {
                    for cell in &t.cells {
                        visit(&cell.paragraphs, out);
                    }
                    if let Some(cap) = &t.caption {
                        visit(&cap.paragraphs, out);
                    }
                }
                Control::Header(h) => visit(&h.paragraphs, out),
                Control::Footer(h) => visit(&h.paragraphs, out),
                Control::Footnote(n) => visit(&n.paragraphs, out),
                Control::Endnote(n) => visit(&n.paragraphs, out),
                Control::HiddenComment(h) => visit(&h.paragraphs, out),
                Control::Field(f) => visit(&f.memo_paragraphs, out),
                Control::Shape(s) => visit_shape(s, out),
                Control::Picture(p) => {
                    if let Some(c) = &p.caption {
                        visit(&c.paragraphs, out);
                    }
                }
                _ => {}
            }
        }
    }
}
fn visit_shape(s: &ShapeObject, out: &mut Vec<SpecialSpaceOrigin>) {
    if let Some(d) = s.drawing() {
        if let Some(t) = &d.text_box {
            visit(&t.paragraphs, out);
        }
        if let Some(c) = &d.caption {
            visit(&c.paragraphs, out);
        }
    }
    match s {
        ShapeObject::Group(g) => {
            for s in &g.children {
                visit_shape(s, out);
            }
        }
        ShapeObject::Picture(p) => {
            if let Some(c) = &p.caption {
                visit(&c.paragraphs, out);
            }
        }
        _ => {}
    }
}
fn all_origins(doc: &HwpDocument) -> Vec<SpecialSpaceOrigin> {
    let mut out = Vec::new();
    for s in &doc.document().sections {
        visit(&s.paragraphs, &mut out);
        for m in &s.section_def.master_pages {
            visit(&m.paragraphs, &mut out);
        }
    }
    out
}

#[test]
fn authentic_english_import_and_hwpx_reopen_preserve_600_nb_and_129_fw_controls() {
    let doc =
        HwpDocument::from_local_file_bytes(include_bytes!("../../samples/exam_eng.hwp")).unwrap();
    let before = all_origins(&doc);
    assert_eq!(
        before.iter().filter(|r| r.origin == Kind::NbSpace).count(),
        600
    );
    assert_eq!(
        before.iter().filter(|r| r.origin == Kind::FwSpace).count(),
        129
    );
    assert_eq!(
        before.iter().filter(|r| r.origin == Kind::Literal).count(),
        0
    );
    let p = &doc.document().sections[0].paragraphs[23];
    assert_eq!(p.space_origin_at(2), Some(Kind::NbSpace));
    assert_eq!(p.space_origin_at(3), Some(Kind::FwSpace));
    let reopened = HwpDocument::from_local_file_bytes(&doc.export_hwpx_native().unwrap()).unwrap();
    assert_eq!(all_origins(&reopened), before);
}

// 이 fixture의 8개 writer scope를 따로 비교해 누락된 출처의 경로를 드러낸다.
fn writer_context_origins(
    doc: &HwpDocument,
) -> std::collections::BTreeMap<&'static str, Vec<SpecialSpaceOrigin>> {
    let mut scopes = std::collections::BTreeMap::from([
        ("body", Vec::new()),
        ("header", Vec::new()),
        ("footer", Vec::new()),
        ("footnote", Vec::new()),
        ("endnote", Vec::new()),
        ("shape", Vec::new()),
        ("nested_cell", Vec::new()),
        ("master", Vec::new()),
    ]);
    for section in &doc.document().sections {
        for p in &section.paragraphs {
            scopes
                .get_mut("body")
                .unwrap()
                .extend(p.special_space_origins.iter().cloned());
            for control in &p.controls {
                match control {
                    Control::Header(h) => visit(&h.paragraphs, scopes.get_mut("header").unwrap()),
                    Control::Footer(h) => visit(&h.paragraphs, scopes.get_mut("footer").unwrap()),
                    Control::Footnote(n) => {
                        visit(&n.paragraphs, scopes.get_mut("footnote").unwrap())
                    }
                    Control::Endnote(n) => visit(&n.paragraphs, scopes.get_mut("endnote").unwrap()),
                    Control::Shape(shape) => visit_shape(shape, scopes.get_mut("shape").unwrap()),
                    Control::Table(table) => {
                        for cell in &table.cells {
                            visit(&cell.paragraphs, scopes.get_mut("nested_cell").unwrap());
                        }
                    }
                    _ => {}
                }
            }
        }
        for master in &section.section_def.master_pages {
            visit(&master.paragraphs, scopes.get_mut("master").unwrap());
        }
    }
    scopes
}

#[test]
fn shared_writers_preserve_fragmented_cell_header_footer_note_and_master_controls() {
    let mut doc = empty();
    let mut p = paragraph(&control_content());
    // 서로 다른 유효 shape ID의 두 run에서 fragment 로컬 좌표를 확인한다.
    let shape = doc.document().doc_info.char_shapes[0].clone();
    doc.document_mut().doc_info.char_shapes.push(shape);
    let second_shape = (doc.document().doc_info.char_shapes.len() - 1) as u32;
    p.char_shapes.push(CharShapeRef {
        start_pos: 1,
        char_shape_id: second_shape,
    });
    let table = Table {
        row_count: 1,
        col_count: 1,
        cells: vec![Cell {
            paragraphs: vec![p.clone()],
            ..Default::default()
        }],
        ..Default::default()
    };
    let nested = Paragraph {
        controls: vec![Control::Table(Box::new(table))],
        char_count: 9,
        ..Default::default()
    };
    let mut shape = ShapeObject::Rectangle(Default::default());
    shape.drawing_mut().unwrap().text_box = Some(TextBox {
        paragraphs: vec![p.clone()],
        ..Default::default()
    });
    let section = &mut doc.document_mut().sections[0];
    section.raw_stream = None;
    section.paragraphs = vec![
        p.clone(),
        Paragraph {
            controls: vec![
                Control::Header(Box::new(Header {
                    paragraphs: vec![p.clone()],
                    ..Default::default()
                })),
                Control::Footer(Box::new(Footer {
                    paragraphs: vec![p.clone()],
                    ..Default::default()
                })),
                Control::Footnote(Box::new(Footnote {
                    paragraphs: vec![p.clone()],
                    ..Default::default()
                })),
                Control::Endnote(Box::new(Endnote {
                    paragraphs: vec![p.clone()],
                    ..Default::default()
                })),
                Control::Shape(Box::new(shape)),
                Control::Table(Box::new(Table {
                    row_count: 1,
                    col_count: 1,
                    cells: vec![Cell {
                        paragraphs: vec![nested],
                        ..Default::default()
                    }],
                    ..Default::default()
                })),
            ],
            char_count: 49,
            ..Default::default()
        },
    ];
    let page_def = &section.section_def.page_def;
    assert!(page_def.width > 0 && page_def.height > 0);
    let body_area = rhwp::model::page::PageAreas::from_page_def(page_def).body_area;
    let text_width = u32::try_from(body_area.width()).expect("fixture body width fits HWPUNIT");
    let text_height = u32::try_from(body_area.height()).expect("fixture body height fits HWPUNIT");
    assert!(text_width > 0 && text_height > 0);
    section.section_def.master_pages.push(MasterPage {
        paragraphs: vec![p],
        text_width,
        text_height,
        ..Default::default()
    });
    let expected = all_origins(&doc);
    assert_eq!(expected.len(), 16);
    let contexts = writer_context_origins(&doc);
    for (scope, records) in &contexts {
        assert_eq!(
            records,
            &control_content().special_space_origins,
            "source scope {scope}"
        );
    }
    let hwpx = doc.export_hwpx_native().unwrap();
    let reopened = HwpDocument::from_local_file_bytes(&hwpx).unwrap();
    assert_eq!(
        writer_context_origins(&reopened),
        contexts,
        "HWPX writer contexts"
    );
    assert_eq!(all_origins(&reopened), expected);
    let hwp = doc.export_hwp_native().unwrap();
    let reopened = HwpDocument::from_local_file_bytes(&hwp).unwrap();
    assert_eq!(
        writer_context_origins(&reopened),
        contexts,
        "HWP writer contexts"
    );
    assert_eq!(all_origins(&reopened), expected);
}

#[test]
fn malformed_payload_rejects_atomically_and_invalid_ir_rejects_before_export() {
    let mut doc = empty();
    doc.insert_text_native(0, 0, 0, "A").unwrap();
    let before = doc.export_hwpx_native().unwrap();
    for records in [
        vec![record(0, Kind::FwSpace)],
        vec![record(0, Kind::NbSpace), record(0, Kind::NbSpace)],
        vec![record(9, Kind::NbSpace)],
    ] {
        let invalid = TextContent {
            text: "\u{a0}".into(),
            special_space_origins: records,
        };
        assert!(doc.insert_text_content_native(0, 0, 0, &invalid).is_err());
        assert_eq!(doc.export_hwpx_native().unwrap(), before);
    }
    doc.document_mut().sections[0].paragraphs[0].special_space_origins =
        vec![record(0, Kind::NbSpace)];
    assert!(doc.export_hwpx_native().is_err());
    assert!(doc.export_hwp_native().is_err());
    assert!(doc.export_hwp_with_adapter().is_err());
}

#[test]
fn rich_cell_path_header_footer_and_note_inverse_routes_preserve_actual_origins() {
    let content = control_content();
    let mut doc = empty();
    doc.create_table_native(0, 0, 0, 1, 1).unwrap();
    let (parent, control) = doc.document().sections[0]
        .paragraphs
        .iter()
        .enumerate()
        .find_map(|(p, para)| {
            para.controls
                .iter()
                .position(|c| matches!(c, Control::Table(_)))
                .map(|c| (p, c))
        })
        .unwrap();
    doc.insert_text_content_in_cell_native_deferred_pagination(
        0, parent, control, 0, 0, 0, &content,
    )
    .unwrap();
    let inverse = removed(
        &doc.delete_text_in_cell_native_deferred_pagination(0, parent, control, 0, 0, 0, 2)
            .unwrap(),
    );
    assert_eq!(inverse, content);
    doc.insert_text_content_in_cell_by_path(0, parent, &[(control, 0, 0)], 99, &inverse)
        .unwrap();
    let Control::Table(outer) =
        &mut doc.document_mut().sections[0].paragraphs[parent].controls[control]
    else {
        unreachable!()
    };
    assert_eq!(
        outer.cells[0].paragraphs[0].special_space_origins,
        content.special_space_origins
    );
    let mut inner = outer.as_ref().clone();
    inner.cells[0].paragraphs = vec![Paragraph::new_empty()];
    outer.cells[0].paragraphs = vec![Paragraph {
        char_count: 9,
        controls: vec![Control::Table(Box::new(inner))],
        ..Default::default()
    }];
    outer.dirty = true;
    let path = [(control, 0, 0), (0, 0, 0)];
    doc.insert_text_content_in_cell_by_path(0, parent, &path, 0, &content)
        .unwrap();
    assert_eq!(
        removed(
            &doc.delete_text_in_cell_by_path(0, parent, &path, 0, 2)
                .unwrap()
        ),
        content
    );
    for is_header in [true, false] {
        let mut doc = empty();
        doc.create_header_footer_native(0, is_header, 0).unwrap();
        doc.insert_text_content_in_header_footer_native(0, is_header, 0, 0, 99, &content)
            .unwrap();
        let inverse = removed(
            &doc.delete_text_in_header_footer_native(0, is_header, 0, 0, 0, 99)
                .unwrap(),
        );
        assert_eq!(inverse, content);
        doc.insert_text_content_in_header_footer_native(0, is_header, 0, 0, 0, &inverse)
            .unwrap();
        assert_eq!(all_origins(&doc), content.special_space_origins);
    }
    let mut doc = empty();
    doc.insert_footnote_native(0, 0, 0).unwrap();
    let control = root(&doc)
        .controls
        .iter()
        .position(|c| matches!(c, Control::Footnote(_)))
        .unwrap();
    let Control::Footnote(note) = &root(&doc).controls[control] else {
        unreachable!()
    };
    // insert_footnote_native의 번호 placeholder는 사용자 본문보다 앞에 이미 있다.
    assert_eq!(note.paragraphs[0].text, "  ");
    assert_eq!(note.paragraphs[0].char_offsets, vec![0, 8]);
    let heading_len = note.paragraphs[0].text.chars().count();
    let result: Value = serde_json::from_str(
        &doc.insert_text_content_in_footnote_native(0, 0, control, 0, 99, &content)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        result["charOffset"],
        heading_len + content.text.chars().count()
    );
    let inverse = removed(
        &doc.delete_text_in_footnote_native(0, 0, control, 0, heading_len, 99)
            .unwrap(),
    );
    assert_eq!(inverse, content);
    let Control::Footnote(note) = &root(&doc).controls[control] else {
        unreachable!()
    };
    assert_eq!(note.paragraphs[0].text, "  ");
    assert_eq!(note.paragraphs[0].char_offsets, vec![0, 8]);
    assert!(matches!(
        note.paragraphs[0].controls[0],
        Control::AutoNumber(_)
    ));
    doc.insert_text_content_in_footnote_native(0, 0, control, 0, heading_len, &inverse)
        .unwrap();
    let expected: Vec<_> = content
        .special_space_origins
        .iter()
        .map(|r| record(r.char_idx + heading_len, r.origin))
        .collect();
    assert_eq!(all_origins(&doc), expected);
}

#[test]
fn diagnostic_sweep_reports_same_text_origin_divergence() {
    let mut control = empty().document().clone();
    control.sections[0].paragraphs = vec![paragraph(&control_content())];
    let mut literal = control.clone();
    literal.sections[0].paragraphs[0].special_space_origins =
        TextContent::literal(&literal.sections[0].paragraphs[0].text).special_space_origins;
    assert_eq!(
        control.sections[0].paragraphs[0].text,
        literal.sections[0].paragraphs[0].text
    );

    let report = rhwp::diagnostics::ir_field_sweep::sweep_documents(&control, &literal);
    assert_eq!(report.total(), 2);
    assert!(!report.details_truncated);
    assert_eq!(
        report.tallies["sections[].paragraphs[].special_space_origins[].origin"],
        2
    );
    for (index, expected) in ["NbSpace", "FwSpace"].iter().enumerate() {
        let divergence = &report.details[index];
        assert_eq!(
            divergence.path,
            format!("sections[0].paragraphs[0].special_space_origins[{index}].origin")
        );
        assert_eq!(divergence.left, *expected);
        assert_eq!(divergence.right, "Literal");
    }
    assert!(rhwp::diagnostics::ir_field_sweep::sweep_documents(&control, &control).is_empty());
}

#[test]
fn imported_initial_field_guide_removal_rebases_origins_and_preserves_stream_gaps() {
    use rhwp::model::control::{Field, FieldType};
    use rhwp::model::paragraph::FieldRange;

    let mut doc = empty();
    let mut p = paragraph(&TextContent {
        text: "\u{a0}😀G\u{a0}\u{2007}HX\u{a0}\u{2007}\u{a0}".into(),
        special_space_origins: vec![
            record(0, Kind::Literal),
            record(3, Kind::NbSpace),
            record(4, Kind::FwSpace),
            record(7, Kind::Literal),
            record(8, Kind::FwSpace),
            record(9, Kind::Literal),
        ],
    });
    // 😀(2 cu)와 fieldBegin/fieldEnd(각 8 cu)는 scalar 출처 좌표와 별개다.
    p.char_offsets = vec![0, 1, 11, 12, 13, 14, 23, 24, 25, 26];
    p.char_count = 28;
    p.controls.push(Control::Field(Field {
        field_type: FieldType::ClickHere,
        field_id: 7,
        properties: 0,
        command: "Clickhere:set:48:Direction:wstring:4:G\u{a0}\u{2007}H HelpState:wstring:0:  "
            .into(),
        ..Default::default()
    }));
    p.field_ranges.push(FieldRange {
        start_char_idx: 2,
        end_char_idx: 6,
        control_idx: 0,
        ..Default::default()
    });
    let section = &mut doc.document_mut().sections[0];
    section.raw_stream = None;
    section.paragraphs = vec![p];
    let input = doc.export_hwpx_native().unwrap();
    let normalized = HwpDocument::from_local_file_bytes(&input).unwrap();
    let p = root(&normalized);
    assert_eq!(p.text, "\u{a0}😀X\u{a0}\u{2007}\u{a0}");
    assert_eq!(
        p.special_space_origins,
        vec![
            record(0, Kind::Literal),
            record(3, Kind::Literal),
            record(4, Kind::FwSpace),
            record(5, Kind::Literal),
        ]
    );
    assert_eq!(p.field_ranges[0].start_char_idx, 2);
    assert_eq!(p.field_ranges[0].end_char_idx, 2);
    let stream_offsets = p.char_offsets.clone();
    assert_eq!(stream_offsets[3] - stream_offsets[2], 1);
    assert_eq!(stream_offsets[2] - stream_offsets[1], 18);
    let saved = normalized.export_hwpx_native().unwrap();
    let reopened = HwpDocument::from_local_file_bytes(&saved).unwrap();
    assert_eq!(
        root(&reopened).capture_text_content(0, usize::MAX),
        p.capture_text_content(0, usize::MAX)
    );
    assert_eq!(root(&reopened).char_offsets, stream_offsets);
}

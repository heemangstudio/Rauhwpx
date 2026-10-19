//! 원본 미주 사다리의 양수 pitch를 fit/render 사본 모두 보존한다.
//! 외부 문서·폰트 없이 raw HWP 레코드 → 공개 조판/렌더 API를 검사한다.
use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::footnote::Endnote;
use rhwp::model::page::ColumnDef;
use rhwp::model::paragraph::LineSeg;
use rhwp::model::provenance::SourceFormat;
use rhwp::parser::{body_text::parse_body_text_section, tags};
use rhwp::renderer::composer::compose_section_with_styles;
use rhwp::renderer::pagination::{EndnoteDeferral, PaginationResult};
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};
use rhwp::renderer::style_resolver::resolve_styles;
use rhwp::renderer::typeset::TypesetEngine;

const DPI: f64 = 96.0;
const TEXT_H: i32 = 1000;
const GAP: i32 = 500;
const PICTURE_H: i32 = 3000;

fn record(out: &mut Vec<u8>, tag: u16, level: u16, data: &[u8]) {
    let header = u32::from(tag) | (u32::from(level) << 10) | ((data.len() as u32) << 20);
    out.extend(header.to_le_bytes());
    out.extend(data);
}

fn line(start: u32, y: i32, height: i32) -> LineSeg {
    LineSeg {
        text_start: start,
        vertical_pos: y,
        line_height: height,
        text_height: height,
        baseline_distance: height * 85 / 100,
        line_spacing: GAP,
        segment_width: 30000,
        tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
        ..Default::default()
    }
}

fn paragraph(text: &[u16], lines: &[LineSeg], children: &[u8], level: u16) -> Vec<u8> {
    let mut header = vec![0; 22];
    header[..4].copy_from_slice(&(text.len() as u32 + 1).to_le_bytes());
    header[12..14].copy_from_slice(&1u16.to_le_bytes());
    header[16..18].copy_from_slice(&(lines.len() as u16).to_le_bytes());
    let mut out = Vec::new();
    record(&mut out, tags::HWPTAG_PARA_HEADER, level, &header);
    let raw: Vec<_> = text
        .iter()
        .copied()
        .chain(std::iter::once(13))
        .flat_map(u16::to_le_bytes)
        .collect();
    record(&mut out, tags::HWPTAG_PARA_TEXT, level + 1, &raw);
    record(&mut out, tags::HWPTAG_PARA_CHAR_SHAPE, level + 1, &[0; 8]);
    if !lines.is_empty() {
        let mut raw = Vec::new();
        for l in lines {
            for value in [
                l.text_start as i32,
                l.vertical_pos,
                l.line_height,
                l.text_height,
                l.baseline_distance,
                l.line_spacing,
                l.column_start,
                l.segment_width,
                l.tag as i32,
            ] {
                raw.extend(value.to_le_bytes());
            }
        }
        record(&mut out, tags::HWPTAG_PARA_LINE_SEG, level + 1, &raw);
    }
    out.extend(children);
    out
}

fn slot(code: u16, id: u32) -> Vec<u16> {
    let bytes = id.to_le_bytes();
    vec![
        code,
        u16::from_le_bytes([bytes[0], bytes[1]]),
        u16::from_le_bytes([bytes[2], bytes[3]]),
        0,
        0,
        0,
        0,
        code,
    ]
}

fn picture(y: i32) -> Vec<u8> {
    let mut children = Vec::new();
    let mut common = vec![0; 44];
    common[..4].copy_from_slice(&tags::CTRL_GEN_SHAPE.to_le_bytes());
    // TAC, 문단 상대, 절대 폭/높이, TopAndBottom. 바깥 여백은0.
    let attr = 1u32 | (2 << 3) | (2 << 8) | (4 << 15) | (2 << 18) | (1 << 21);
    common[4..8].copy_from_slice(&attr.to_le_bytes());
    common[16..20].copy_from_slice(&4000u32.to_le_bytes());
    common[20..24].copy_from_slice(&(PICTURE_H as u32).to_le_bytes());
    record(&mut children, tags::HWPTAG_CTRL_HEADER, 3, &common);
    let mut component = vec![0; 52];
    component[..4].copy_from_slice(b"cip$");
    component[4..8].copy_from_slice(b"cip$");
    for offset in [20, 28] {
        component[offset..offset + 4].copy_from_slice(&4000u32.to_le_bytes());
    }
    for offset in [24, 32] {
        component[offset..offset + 4].copy_from_slice(&(PICTURE_H as u32).to_le_bytes());
    }
    for value in [1.0f64, 0.0, 0.0, 0.0, 1.0, 0.0] {
        component.extend(value.to_le_bytes());
    }
    record(&mut children, tags::HWPTAG_SHAPE_COMPONENT, 4, &component);
    record(
        &mut children,
        tags::HWPTAG_SHAPE_COMPONENT_PICTURE,
        5,
        &[0; 73],
    );
    paragraph(
        &slot(11, tags::CTRL_GEN_SHAPE),
        &[line(0, y, PICTURE_H)],
        &children,
        2,
    )
}

fn fixture(reset: bool) -> DocumentCore {
    let mut notes = Vec::new();
    notes.extend(paragraph(
        &"HEAD".encode_utf16().collect::<Vec<_>>(),
        &[line(0, 0, TEXT_H)],
        &[],
        2,
    ));
    notes.extend(paragraph(
        &"ALPHA\nBETA".encode_utf16().collect::<Vec<_>>(),
        &[
            line(0, TEXT_H + GAP, TEXT_H),
            line(6, 2 * (TEXT_H + GAP), TEXT_H),
        ],
        &[],
        2,
    ));
    let picture_y = 3 * (TEXT_H + GAP);
    notes.extend(picture(picture_y));
    notes.extend(paragraph(
        &"AFTER".encode_utf16().collect::<Vec<_>>(),
        &[line(0, picture_y + PICTURE_H + GAP, TEXT_H)],
        &[],
        2,
    ));
    if reset {
        for (text, y) in [("RESET", 0), ("NEXT", TEXT_H + GAP)] {
            notes.extend(paragraph(
                &text.encode_utf16().collect::<Vec<_>>(),
                &[line(0, y, TEXT_H)],
                &[],
                2,
            ));
        }
    }
    let mut children = Vec::new();
    let mut note = tags::CTRL_ENDNOTE.to_le_bytes().to_vec();
    note.extend(1u32.to_le_bytes());
    note.extend(0u16.to_le_bytes());
    note.extend((')' as u16).to_le_bytes());
    note.extend(0u32.to_le_bytes());
    record(&mut children, tags::HWPTAG_CTRL_HEADER, 1, &note);
    let mut list = vec![0; 16];
    list[..4].copy_from_slice(&(if reset { 6u32 } else { 4 }).to_le_bytes());
    record(&mut children, tags::HWPTAG_LIST_HEADER, 2, &list);
    children.extend(notes);
    let mut body = "BODY".encode_utf16().collect::<Vec<_>>();
    body.extend(slot(17, tags::CTRL_ENDNOTE));
    let raw = paragraph(&body, &[line(0, 0, TEXT_H)], &children, 0);
    let parsed = parse_body_text_section(&raw).unwrap();
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().unwrap();
    let doc = core.document_mut();
    doc.provenance = Default::default();
    let cs = &mut doc.doc_info.char_shapes[0];
    cs.base_size = TEXT_H;
    cs.ratios = [100; 7];
    cs.relative_sizes = [100; 7];
    let ps = &mut doc.doc_info.para_shapes[0];
    ps.spacing_before = 0;
    ps.spacing_after = 0;
    let section = &mut doc.sections[0];
    section.paragraphs = parsed.paragraphs;
    section.raw_stream = Some(raw);
    section.raw_provenance = Some(());
    section.section_def.page_def.width = 40000;
    section.section_def.page_def.height = 30000;
    section.section_def.page_def.margin_left = 0;
    section.section_def.page_def.margin_right = 0;
    section.section_def.page_def.margin_top = 0;
    section.section_def.page_def.margin_bottom = 0;
    section.section_def.page_def.margin_header = 0;
    section.section_def.page_def.margin_footer = 0;
    let shape = &mut section.section_def.endnote_shape;
    shape.separator_line_type = 0;
    shape.separator_line_width = 1;
    shape.separator_margin_top = 0;
    shape.separator_margin_bottom = 864;
    shape.note_spacing = 576;
    shape.raw_unknown = 0;
    core
}

fn note(core: &DocumentCore) -> &Endnote {
    let Control::Endnote(note) = &core.document().sections[0].paragraphs[0].controls[0] else {
        panic!("raw endnote");
    };
    note
}

fn note_mut(core: &mut DocumentCore) -> &mut Endnote {
    let Control::Endnote(note) = &mut core.document_mut().sections[0].paragraphs[0].controls[0]
    else {
        panic!("raw endnote");
    };
    note
}

fn paginate(core: &DocumentCore) -> PaginationResult {
    paginate_with_columns(core, &ColumnDef::default())
}

fn paginate_with_columns(core: &DocumentCore, columns: &ColumnDef) -> PaginationResult {
    let doc = core.document();
    let sec = &doc.sections[0];
    let styles = resolve_styles(&doc.doc_info, DPI);
    let composed = compose_section_with_styles(sec, &styles);
    TypesetEngine::new(DPI).typeset_section_with_variant(
        &sec.paragraphs,
        &composed,
        &styles,
        &sec.section_def.page_def,
        columns,
        0,
        &[],
        false,
        doc.layout_profile(),
        false,
        false,
        Some(&sec.section_def.footnote_shape),
        Some(&sec.section_def.endnote_shape),
        &Default::default(),
        EndnoteDeferral::None,
    )
}

fn boundary_fixture(columns: u16, page_height: u32) -> DocumentCore {
    boundary_fixture_with_reset(columns, page_height, false)
}

fn boundary_fixture_with_reset(columns: u16, page_height: u32, reset_second: bool) -> DocumentCore {
    let mut children = Vec::new();
    let mut column = tags::CTRL_COLUMN_DEF.to_le_bytes().to_vec();
    column.extend(((columns << 2) | (1 << 12)).to_le_bytes());
    column.extend(4000i16.to_le_bytes());
    column.extend(0u16.to_le_bytes());
    record(&mut children, tags::HWPTAG_CTRL_HEADER, 1, &column);
    let mut body = slot(2, tags::CTRL_COLUMN_DEF);
    body.extend("BODY".encode_utf16());
    for number in 1..=3u32 {
        let mut control = tags::CTRL_ENDNOTE.to_le_bytes().to_vec();
        control.extend(number.to_le_bytes());
        control.extend(0u16.to_le_bytes());
        control.extend((')' as u16).to_le_bytes());
        control.extend(0u32.to_le_bytes());
        record(&mut children, tags::HWPTAG_CTRL_HEADER, 1, &control);
        let mut list = vec![0; 16];
        list[..4]
            .copy_from_slice(&(if reset_second && number == 2 { 7u32 } else { 5 }).to_le_bytes());
        record(&mut children, tags::HWPTAG_LIST_HEADER, 2, &list);
        children.extend(paragraph(
            &format!("HEAD{number}").encode_utf16().collect::<Vec<_>>(),
            &[line(0, 0, TEXT_H)],
            &[],
            2,
        ));
        let alpha = format!("ALPHA{number}");
        children.extend(paragraph(
            &format!("{alpha}\nBETA{number}")
                .encode_utf16()
                .collect::<Vec<_>>(),
            &[
                line(0, TEXT_H + GAP, TEXT_H),
                line(
                    alpha.encode_utf16().count() as u32 + 1,
                    2 * (TEXT_H + GAP),
                    TEXT_H,
                ),
            ],
            &[],
            2,
        ));
        let picture_y = 3 * (TEXT_H + GAP);
        children.extend(picture(picture_y));
        let after_y = picture_y + PICTURE_H + GAP;
        children.extend(paragraph(
            &format!("AFTER{number}").encode_utf16().collect::<Vec<_>>(),
            &[line(0, after_y, TEXT_H)],
            &[],
            2,
        ));
        let blank_y = if reset_second && number == 2 {
            for (text, y) in [("RESET2", 0), ("NEXT2", TEXT_H + GAP)] {
                children.extend(paragraph(
                    &text.encode_utf16().collect::<Vec<_>>(),
                    &[line(0, y, TEXT_H)],
                    &[],
                    2,
                ));
            }
            2 * (TEXT_H + GAP)
        } else {
            after_y + TEXT_H + GAP
        };
        children.extend(paragraph(&[], &[line(0, blank_y, TEXT_H)], &[], 2));
        body.extend(slot(17, tags::CTRL_ENDNOTE));
    }
    let raw = paragraph(&body, &[line(0, 0, TEXT_H)], &children, 0);
    let parsed = parse_body_text_section(&raw).unwrap();
    let mut core = fixture(false);
    // 본문 trailing GAP을 같은 높이의 구분선 여백으로 대체해야 첫 제목도
    // 원본 vpos 원점과 일치한다. 경계 간격 검사에 별도 body-origin 오차를 섞지 않는다.
    let shape = &mut core.document_mut().sections[0].section_def.endnote_shape;
    shape.separator_margin_bottom = GAP as i16;
    shape.note_spacing = 0;
    let section = &mut core.document_mut().sections[0];
    section.paragraphs = parsed.paragraphs;
    section.raw_stream = Some(raw);
    section.section_def.page_def.width = if columns == 2 { 64000 } else { 40000 };
    section.section_def.page_def.height = page_height;
    core
}

fn boundary_columns(count: u16) -> ColumnDef {
    ColumnDef {
        column_count: count,
        same_width: true,
        spacing: 4000,
        ..Default::default()
    }
}

fn nodes(node: &RenderNode) -> Vec<&RenderNode> {
    let mut all = vec![node];
    for child in &node.children {
        all.extend(nodes(child));
    }
    all
}

fn line_y(root: &RenderNode, text: &str) -> f64 {
    nodes(root)
        .into_iter()
        .find(|n| matches!(n.node_type, RenderNodeType::TextLine(_)) && nodes(n).iter().any(|child| matches!(&child.node_type, RenderNodeType::TextRun(run) if run.text.contains(text))))
        .unwrap_or_else(|| panic!("missing text line {text}"))
        .bbox
        .y
}

fn close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.1,
        "actual={actual}, expected={expected}"
    );
}

fn unchanged(core: &DocumentCore, before: &str) {
    assert_eq!(format!("{:?}", core.document().sections), before);
}

#[test]
fn positive_authored_pitch_reaches_both_fit_and_picture_placement() {
    let mut core = fixture(false);
    let before = format!("{:?}", core.document().sections);
    let pagination = paginate(&core);
    assert_eq!(pagination.endnote_paragraphs.len(), 4);
    for p in &pagination.endnote_paragraphs {
        for l in &p.line_segs {
            assert_eq!(l.line_spacing, GAP, "emitted source pitch");
        }
    }
    unchanged(&core, &before);
    core.refresh_layout_native();
    let tree = core.build_page_render_tree(0).unwrap();
    let first = line_y(&tree.root, "ALPHA");
    let second = line_y(&tree.root, "BETA");
    close(second - first, f64::from(TEXT_H + GAP) * DPI / 7200.0);
    let image = nodes(&tree.root)
        .into_iter()
        .find(|n| matches!(n.node_type, RenderNodeType::Image(_)))
        .expect("TAC source picture");
    close(
        image.bbox.y - first,
        f64::from(2 * (TEXT_H + GAP)) * DPI / 7200.0,
    );
    close(
        line_y(&tree.root, "AFTER") - image.bbox.y,
        f64::from(PICTURE_H + GAP) * DPI / 7200.0,
    );
    close(image.bbox.height, f64::from(PICTURE_H) * DPI / 7200.0);
    unchanged(&core, &before);
}

#[test]
fn source_reset_starts_a_new_certificate_fragment_without_rewriting_vpos() {
    let mut core = fixture(true);
    let before = format!("{:?}", core.document().sections);
    let source: Vec<_> = note(&core)
        .paragraphs
        .iter()
        .flat_map(|p| p.line_segs.iter().cloned())
        .collect();
    let pagination = paginate(&core);
    let emitted: Vec<_> = pagination
        .endnote_paragraphs
        .iter()
        .flat_map(|p| &p.line_segs)
        .collect();
    assert_eq!(source.len(), emitted.len());
    let origin = emitted[0].vertical_pos - source[0].vertical_pos;
    for (a, b) in source.iter().zip(emitted) {
        assert_eq!(b.line_spacing, a.line_spacing);
        assert_eq!(
            b.vertical_pos - a.vertical_pos,
            origin,
            "source reset remains a reset"
        );
    }
    assert_eq!(source[5].vertical_pos, 0);
    assert_eq!(source[6].vertical_pos, TEXT_H + GAP);
    core.refresh_layout_native();
    let mut saw_reset_fragment = false;
    for page in 0..core.page_count() {
        let tree = core.build_page_render_tree(page).unwrap();
        if nodes(&tree.root).iter().any(|node| {
            matches!(&node.node_type, RenderNodeType::TextRun(run) if run.text.contains("RESET"))
        }) {
            close(
                line_y(&tree.root, "NEXT") - line_y(&tree.root, "RESET"),
                f64::from(TEXT_H + GAP) * DPI / 7200.0,
            );
            saw_reset_fragment = true;
        }
    }
    assert!(
        saw_reset_fragment,
        "reset fragment remains visible after layout"
    );
    unchanged(&core, &before);
}

#[test]
fn incomplete_generated_edited_and_discontinuous_caches_keep_compact_fallback() {
    for case in 0..8 {
        let mut core = fixture(false);
        match case {
            0 => {
                note_mut(&mut core).paragraphs[1].line_segs[0].tag |=
                    LineSeg::TAG_IMPLEMENTATION_PROPERTY
            }
            1 => note_mut(&mut core).paragraphs[1].line_segs.clear(),
            2 => note_mut(&mut core).paragraphs[1].line_segs[0].baseline_distance = TEXT_H + 1,
            3 => note_mut(&mut core).paragraphs[1].line_segs[1].vertical_pos += 1,
            4 => core.document_mut().sections[0].raw_stream = None,
            5 => note_mut(&mut core).paragraphs[1].raw_header_extra[4..6]
                .copy_from_slice(&1u16.to_le_bytes()),
            6 => {
                for p in &mut note_mut(&mut core).paragraphs {
                    for l in &mut p.line_segs {
                        l.line_spacing = -200;
                    }
                }
            }
            7 => core.document_mut().provenance.own_line_layout = true,
            _ => unreachable!(),
        }
        let before = format!("{:?}", core.document().sections);
        let pagination = paginate(&core);
        let first = &pagination.endnote_paragraphs[0].line_segs[0];
        assert_eq!(
            first.line_spacing,
            -(first.line_height / 10),
            "fallback case {case}"
        );
        unchanged(&core, &before);
    }
}

#[test]
fn separator_between_notes_and_all_zero_profiles_keep_existing_routes() {
    for case in 0..3 {
        let mut core = fixture(false);
        let shape = &mut core.document_mut().sections[0].section_def.endnote_shape;
        match case {
            0 => shape.separator_line_type = 1,
            1 => shape.raw_unknown = 284,
            2 => {
                shape.separator_margin_bottom = 0;
                shape.note_spacing = 0;
            }
            _ => unreachable!(),
        }
        let before = format!("{:?}", core.document().sections);
        let pagination = paginate(&core);
        let first = &pagination.endnote_paragraphs[0].line_segs[0];
        assert_eq!(
            first.line_spacing,
            if case == 2 {
                -(first.line_height / 10)
            } else {
                GAP
            }
        );
        unchanged(&core, &before);
    }
}

#[test]
fn hwp5_lineage_is_not_a_spacing_policy_and_actual_hwp3_is_not_admitted() {
    for native_hwp3 in [false, true] {
        let mut core = fixture(false);
        core.document_mut().provenance.hwp3_lineage = true;
        if native_hwp3 {
            core.document_mut().provenance.format = SourceFormat::Hwp3;
        }
        let before = format!("{:?}", core.document().sections);
        let pagination = paginate(&core);
        let first = &pagination.endnote_paragraphs[0].line_segs[0];
        assert_eq!(
            first.line_spacing,
            if native_hwp3 {
                -(first.line_height / 10)
            } else {
                GAP
            }
        );
        unchanged(&core, &before);
    }
}

#[test]
fn three_authored_notes_replace_only_terminal_blank_spacing_at_real_boundaries() {
    let mut core = boundary_fixture(1, 60000);
    let before = format!("{:?}", core.document().sections);
    let source_notes: Vec<_> = core.document().sections[0].paragraphs[0]
        .controls
        .iter()
        .filter_map(|control| {
            if let Control::Endnote(note) = control {
                Some(note)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(source_notes.len(), 3);
    let first = source_notes[0].paragraphs[0].line_segs[0].vertical_pos;
    let last = source_notes[0]
        .paragraphs
        .last()
        .unwrap()
        .line_segs
        .last()
        .unwrap();
    let span = last.vertical_pos + last.line_height - first;
    let result = paginate_with_columns(&core, &boundary_columns(1));
    assert_eq!(result.pages.len(), 1);
    assert_eq!(result.endnote_paragraphs.len(), 15);
    for (index, para) in result.endnote_paragraphs.iter().enumerate() {
        for line in &para.line_segs {
            let boundary_tail = index == 4 || index == 9;
            assert_eq!(
                line.line_spacing,
                if boundary_tail { 0 } else { GAP },
                "only the first two final blank rows end at a note boundary"
            );
        }
    }
    unchanged(&core, &before);
    core.refresh_layout_native();
    assert_eq!(core.page_count(), 1);
    let tree = core.build_page_render_tree(0).unwrap();
    for number in 1..=2 {
        close(
            line_y(&tree.root, &format!("HEAD{}", number + 1))
                - line_y(&tree.root, &format!("HEAD{number}")),
            f64::from(span) * DPI / 7200.0,
        );
    }
    for number in 1..=3 {
        close(
            line_y(&tree.root, &format!("BETA{number}"))
                - line_y(&tree.root, &format!("ALPHA{number}")),
            f64::from(TEXT_H + GAP) * DPI / 7200.0,
        );
        let picture_para = 3 + (number - 1) * 5;
        let image = nodes(&tree.root).into_iter().find(|node| matches!(&node.node_type, RenderNodeType::Image(image) if image.para_index == Some(picture_para))).unwrap();
        close(
            line_y(&tree.root, &format!("AFTER{number}")) - image.bbox.y,
            f64::from(PICTURE_H + GAP) * DPI / 7200.0,
        );
    }
    unchanged(&core, &before);
}

#[test]
fn a_split_note_carries_the_same_zero_boundary_into_the_next_column() {
    // 20000HU에는 둘째 그림의 하단까지 들어간다. 18000HU는 앞의 텍스트는
    // 남기고 그림을 이월하며, 오른쪽 단에는 둘째 꼬리와 셋째 미주가 들어간다.
    let mut core = boundary_fixture(2, 18000);
    let before = format!("{:?}", core.document().sections);
    let result = paginate_with_columns(&core, &boundary_columns(2));
    assert_eq!(
        result.pages.len(),
        1,
        "the source-derived note budget fits two columns"
    );
    assert_eq!(result.endnote_paragraphs[4].line_segs[0].line_spacing, 0);
    assert_eq!(result.endnote_paragraphs[9].line_segs[0].line_spacing, 0);
    assert_eq!(
        result.endnote_paragraphs[14].line_segs[0].line_spacing, GAP,
        "document end is not a note boundary"
    );
    core.refresh_layout_native();
    assert_eq!(core.page_count(), 1);
    let tree = core.build_page_render_tree(0).unwrap();
    let picture = nodes(&tree.root).into_iter().find(|node| matches!(&node.node_type, RenderNodeType::Image(image) if image.para_index == Some(8))).expect("second note picture");
    assert!(
        picture.bbox.x > tree.root.bbox.width / 2.0,
        "the second note's picture must actually cross into the right column"
    );
    close(
        line_y(&tree.root, "HEAD3") - picture.bbox.y,
        f64::from(PICTURE_H + 2 * TEXT_H + 2 * GAP) * DPI / 7200.0,
    );
    for text in ["HEAD1", "HEAD2", "HEAD3", "AFTER3"] {
        assert!(nodes(&tree.root).iter().any(|node| matches!(&node.node_type, RenderNodeType::TextRun(run) if run.text.contains(text))), "all authored notes remain visible: {text}");
    }
    unchanged(&core, &before);
}

#[test]
fn zero_boundary_projection_does_not_replace_unsupported_profile_tail_spacing() {
    for case in 0..5 {
        let mut core = boundary_fixture(1, 60000);
        match case {
            0 => {
                core.document_mut().sections[0]
                    .section_def
                    .endnote_shape
                    .separator_line_type = 1
            }
            1 => {
                core.document_mut().sections[0]
                    .section_def
                    .endnote_shape
                    .raw_unknown = 284
            }
            2 => {
                let shape = &mut core.document_mut().sections[0].section_def.endnote_shape;
                shape.separator_margin_bottom = 0;
                shape.note_spacing = 0;
            }
            3 => {
                let Control::Endnote(note) =
                    &mut core.document_mut().sections[0].paragraphs[0].controls[1]
                else {
                    panic!()
                };
                note.paragraphs[1].line_segs[0].tag |= LineSeg::TAG_IMPLEMENTATION_PROPERTY;
            }
            4 => core.document_mut().sections[0].raw_stream = None,
            _ => unreachable!(),
        }
        let before = format!("{:?}", core.document().sections);
        let result = paginate_with_columns(&core, &boundary_columns(1));
        let last = result.endnote_paragraphs[4].line_segs.last().unwrap();
        assert_eq!(
            last.line_spacing,
            if case <= 1 {
                GAP
            } else {
                -(last.line_height / 10)
            },
            "unsupported case {case} keeps its old route"
        );
        unchanged(&core, &before);
    }
}

#[test]
fn terminal_boundary_projection_preserves_a_genuine_middle_note_reset() {
    let mut core = boundary_fixture_with_reset(1, 60000, true);
    let before = format!("{:?}", core.document().sections);
    let source: Vec<_> = core.document().sections[0].paragraphs[0]
        .controls
        .iter()
        .filter_map(|control| {
            if let Control::Endnote(note) = control {
                Some(note.clone())
            } else {
                None
            }
        })
        .collect();
    let result = paginate_with_columns(&core, &boundary_columns(1));
    let mut cursor = 0;
    for (note_index, note) in source.iter().enumerate() {
        let origin = result.endnote_paragraphs[cursor].line_segs[0].vertical_pos
            - note.paragraphs[0].line_segs[0].vertical_pos;
        for (para_index, para) in note.paragraphs.iter().enumerate() {
            for (a, b) in para
                .line_segs
                .iter()
                .zip(&result.endnote_paragraphs[cursor + para_index].line_segs)
            {
                assert_eq!(
                    b.vertical_pos - a.vertical_pos,
                    origin,
                    "reset coordinates remain source-derived"
                );
                let boundary_tail = note_index < 2 && para_index + 1 == note.paragraphs.len();
                assert_eq!(
                    b.line_spacing,
                    if boundary_tail { 0 } else { a.line_spacing }
                );
            }
        }
        cursor += note.paragraphs.len();
    }
    assert_eq!(source[1].paragraphs[4].line_segs[0].vertical_pos, 0);
    core.refresh_layout_native();
    let mut seen = false;
    for page in 0..core.page_count() {
        let tree = core.build_page_render_tree(page).unwrap();
        if nodes(&tree.root).iter().any(|node| matches!(&node.node_type, RenderNodeType::TextRun(run) if run.text.contains("RESET2"))) {
            close(line_y(&tree.root, "NEXT2") - line_y(&tree.root, "RESET2"), f64::from(TEXT_H + GAP) * DPI / 7200.0);
            seen = true;
        }
    }
    assert!(seen, "the reset fragment remains visible");
    unchanged(&core, &before);
}

// raw LINE_SEG의 H/textH 차이만 만든다. 문서 모델을 고친 뒤 원본으로 가장하지 않는다.
fn mixed_height_fixture(reset: bool, full_height: i32) -> DocumentCore {
    mixed_height_fixture_with_cross_para(reset, full_height, false)
}

fn mixed_height_fixture_with_cross_para(
    reset: bool,
    full_height: i32,
    cross_para: bool,
) -> DocumentCore {
    let mut children = Vec::new();
    let mut body = "BODY".encode_utf16().collect::<Vec<_>>();
    for number in 1..=2u32 {
        let mut control = tags::CTRL_ENDNOTE.to_le_bytes().to_vec();
        control.extend(number.to_le_bytes());
        control.extend(0u16.to_le_bytes());
        control.extend((')' as u16).to_le_bytes());
        control.extend(0u32.to_le_bytes());
        record(&mut children, tags::HWPTAG_CTRL_HEADER, 1, &control);
        let mut list = vec![0; 16];
        list[..4].copy_from_slice(&(if reset && number == 1 { 7u32 } else { 5 }).to_le_bytes());
        record(&mut children, tags::HWPTAG_LIST_HEADER, 2, &list);
        children.extend(paragraph(
            &format!("MHEAD{number}").encode_utf16().collect::<Vec<_>>(),
            &[line(0, 0, TEXT_H)],
            &[],
            2,
        ));
        let first = format!("MALPHA{number}");
        let mut mixed = line(0, TEXT_H + GAP, full_height);
        mixed.text_height = 1125;
        mixed.baseline_distance = 956;
        let next_y = TEXT_H + GAP + 1125 + GAP;
        let mut successor = line(first.encode_utf16().count() as u32 + 1, next_y, TEXT_H);
        if cross_para {
            successor.line_height = 1700;
            successor.text_height = 1125;
            successor.baseline_distance = 956;
            successor.line_spacing = 375;
        }
        children.extend(paragraph(
            &format!("{first}\nMBETA{number}")
                .encode_utf16()
                .collect::<Vec<_>>(),
            &[mixed, successor],
            &[],
            2,
        ));
        let picture_y = next_y + TEXT_H + GAP;
        children.extend(picture(picture_y));
        let after_y = picture_y + PICTURE_H + GAP;
        children.extend(paragraph(
            &format!("MAFTER{number}").encode_utf16().collect::<Vec<_>>(),
            &[line(0, after_y, TEXT_H)],
            &[],
            2,
        ));
        let blank_y = if reset && number == 1 {
            for (text, y) in [("MRESET", 0), ("MNEXT", TEXT_H + GAP)] {
                children.extend(paragraph(
                    &text.encode_utf16().collect::<Vec<_>>(),
                    &[line(0, y, TEXT_H)],
                    &[],
                    2,
                ));
            }
            2 * (TEXT_H + GAP)
        } else {
            after_y + TEXT_H + GAP
        };
        children.extend(paragraph(&[], &[line(0, blank_y, TEXT_H)], &[], 2));
        body.extend(slot(17, tags::CTRL_ENDNOTE));
    }
    let raw = paragraph(&body, &[line(0, 0, TEXT_H)], &children, 0);
    let parsed = parse_body_text_section(&raw).unwrap();
    let mut core = fixture(false);
    let section = &mut core.document_mut().sections[0];
    section.paragraphs = parsed.paragraphs;
    section.raw_stream = Some(raw);
    section.section_def.page_def.height = 60000;
    section.section_def.endnote_shape.separator_margin_bottom = GAP as i16;
    section.section_def.endnote_shape.note_spacing = 0;
    core
}

fn text_line<'a>(root: &'a RenderNode, text: &str) -> &'a RenderNode {
    nodes(root)
        .into_iter()
        .find(|node| {
            matches!(node.node_type, RenderNodeType::TextLine(_))
                && nodes(node).iter().any(|child| {
                    matches!(&child.node_type,
            RenderNodeType::TextRun(run) if run.text.contains(text))
                })
        })
        .unwrap_or_else(|| panic!("missing line {text}"))
}

#[test]
fn mixed_height_uses_certified_text_advance_and_keeps_full_line_and_picture_bounds() {
    let mut core = mixed_height_fixture(false, 1337);
    let before = format!("{:?}", core.document().sections);
    let result = paginate(&core);
    assert_eq!(result.pages.len(), 1);
    // Render metadata carries integers in HU, not pixels or synthetic negative spacing.
    assert_eq!(
        result.endnote_para_sources[1]
            .certified_line_advances_hu
            .as_deref(),
        Some(&[1625, 1500][..])
    );
    assert_eq!(result.endnote_paragraphs[1].line_segs[0].line_height, 1337);
    assert_eq!(result.endnote_paragraphs[1].line_segs[0].line_spacing, GAP);
    assert_eq!(result.endnote_paragraphs[4].line_segs[0].line_spacing, 0);
    assert_eq!(result.endnote_paragraphs[9].line_segs[0].line_spacing, GAP);
    core.refresh_layout_native();
    assert_eq!(core.page_count(), 1);
    let tree = core.build_page_render_tree(0).unwrap();
    for number in 1..=2 {
        let alpha = text_line(&tree.root, &format!("MALPHA{number}"));
        close(
            line_y(&tree.root, &format!("MBETA{number}")) - alpha.bbox.y,
            1625.0 * DPI / 7200.0,
        );
        close(alpha.bbox.height, 1337.0 * DPI / 7200.0);
        let picture_para = 3 + (number - 1) * 5;
        let image = nodes(&tree.root)
            .into_iter()
            .find(|node| {
                matches!(&node.node_type,
            RenderNodeType::Image(image) if image.para_index == Some(picture_para))
            })
            .unwrap();
        close(image.bbox.height, f64::from(PICTURE_H) * DPI / 7200.0);
        close(
            line_y(&tree.root, &format!("MAFTER{number}")) - image.bbox.y,
            f64::from(PICTURE_H + GAP) * DPI / 7200.0,
        );
    }
    // Title-to-title span retains the last blank H, omits only its trailing GAP.
    let span = 2 * (TEXT_H + GAP) + 1625 + PICTURE_H + GAP + TEXT_H + GAP + TEXT_H;
    close(
        line_y(&tree.root, "MHEAD2") - line_y(&tree.root, "MHEAD1"),
        f64::from(span) * DPI / 7200.0,
    );
    unchanged(&core, &before);
}

#[test]
fn mixed_height_successor_can_be_in_the_next_paragraph_without_losing_full_bounds() {
    // 두 번째 mixed 줄의 1125+375=1500HU를 다음 그림 문단이 인증한다.
    let mut core = mixed_height_fixture_with_cross_para(false, 1337, true);
    let before = format!("{:?}", core.document().sections);
    let result = paginate(&core);
    assert_eq!(result.endnote_paragraphs[1].line_segs[1].line_spacing, 375);
    core.refresh_layout_native();
    let tree = core.build_page_render_tree(0).unwrap();
    let beta = text_line(&tree.root, "MBETA1");
    let image = nodes(&tree.root)
        .into_iter()
        .find(|node| {
            matches!(&node.node_type,
        RenderNodeType::Image(image) if image.para_index == Some(3))
        })
        .unwrap();
    close(image.bbox.y - beta.bbox.y, 1500.0 * DPI / 7200.0);
    close(beta.bbox.height, 1700.0 * DPI / 7200.0);
    unchanged(&core, &before);
}

#[test]
fn mixed_height_certificate_keeps_genuine_reset_fragments_and_adjacent_blank_boundary() {
    let mut core = mixed_height_fixture(true, 1337);
    let before = format!("{:?}", core.document().sections);
    let result = paginate(&core);
    let source = note(&core);
    let origin = result.endnote_paragraphs[0].line_segs[0].vertical_pos;
    for (source, emitted) in source.paragraphs.iter().zip(&result.endnote_paragraphs) {
        for (a, b) in source.line_segs.iter().zip(&emitted.line_segs) {
            assert_eq!(b.vertical_pos - a.vertical_pos, origin);
        }
    }
    assert_eq!(source.paragraphs[4].line_segs[0].vertical_pos, 0);
    assert_eq!(result.endnote_paragraphs[6].line_segs[0].line_spacing, 0);
    core.refresh_layout_native();
    let mut found = false;
    for page in 0..core.page_count() {
        let tree = core.build_page_render_tree(page).unwrap();
        if nodes(&tree.root).iter().any(|node| {
            matches!(&node.node_type,
            RenderNodeType::TextRun(run) if run.text.contains("MRESET"))
        }) {
            close(
                line_y(&tree.root, "MNEXT") - line_y(&tree.root, "MRESET"),
                f64::from(TEXT_H + GAP) * DPI / 7200.0,
            );
            found = true;
        }
    }
    assert!(found);
    unchanged(&core, &before);
}

#[test]
fn mixed_height_negative_guards_reject_uncertified_rows_without_rewriting_sources() {
    for case in 0..14 {
        let mut core = mixed_height_fixture(false, 1337);
        match case {
            0 => note_mut(&mut core).paragraphs[1].line_segs[1].vertical_pos += 1,
            1 => note_mut(&mut core).paragraphs[1].line_segs[0].text_height = 0,
            2 => note_mut(&mut core).paragraphs[1].line_segs[0].text_height = 1338,
            3 => {
                note_mut(&mut core).paragraphs[1].line_segs[0].tag |=
                    LineSeg::TAG_IMPLEMENTATION_PROPERTY
            }
            4 => note_mut(&mut core).paragraphs[1].line_segs.clear(),
            5 => note_mut(&mut core).paragraphs[1].raw_header_extra.clear(),
            6 => note_mut(&mut core).paragraphs[1].para_text_terminal = None,
            7 => note_mut(&mut core).paragraphs[1].line_segs[0].vertical_pos = -1,
            8 => core.document_mut().sections[0].raw_stream = None,
            9 => core.document_mut().provenance.own_line_layout = true,
            10 => core.document_mut().provenance.format = SourceFormat::Hwp3,
            11 => {
                let Control::Picture(pic) = &mut note_mut(&mut core).paragraphs[2].controls[0]
                else {
                    panic!()
                };
                pic.common.treat_as_char = false;
            }
            12 => note_mut(&mut core).paragraphs[4].line_segs[0].line_height += 100,
            13 => {
                let paragraph = &mut note_mut(&mut core).paragraphs[1];
                paragraph.line_segs[1].vertical_pos = 0;
            }
            _ => unreachable!(),
        }
        let before = format!("{:?}", core.document().sections);
        let result = paginate(&core);
        assert!(
            result.endnote_para_sources[0]
                .certified_line_advances_hu
                .is_none(),
            "case {case}"
        );
        let first = &result.endnote_paragraphs[0].line_segs[0];
        assert_eq!(first.line_spacing, -(first.line_height / 10), "case {case}");
        unchanged(&core, &before);
    }
}

#[test]
fn mixed_height_separator_profiles_keep_existing_fallback_policy() {
    for case in 0..3 {
        let mut core = mixed_height_fixture(false, 1337);
        let shape = &mut core.document_mut().sections[0].section_def.endnote_shape;
        match case {
            0 => shape.separator_line_type = 1,
            1 => shape.raw_unknown = 284,
            2 => {
                shape.separator_margin_bottom = 0;
                shape.note_spacing = 0;
            }
            _ => unreachable!(),
        }
        let before = format!("{:?}", core.document().sections);
        let result = paginate(&core);
        assert!(result.endnote_para_sources[0]
            .certified_line_advances_hu
            .is_none());
        let first = &result.endnote_paragraphs[0].line_segs[0];
        assert_eq!(
            first.line_spacing,
            if case == 2 {
                -(first.line_height / 10)
            } else {
                GAP
            }
        );
        unchanged(&core, &before);
    }
}

#[test]
fn certified_full_height_still_controls_fit_at_a_column_edge() {
    let mut core = mixed_height_fixture(false, 7000);
    core.document_mut().sections[0].section_def.page_def.height = 9000;
    let before = format!("{:?}", core.document().sections);
    let result = paginate_with_columns(&core, &boundary_columns(2));
    // Source flow would fit on the left, but the 7000-HU full box would cross its bottom.
    let column_for_alpha = result
        .pages
        .iter()
        .flat_map(|page| page.column_contents.iter())
        .enumerate()
        .find_map(|(index, column)| {
            column
                .items
                .iter()
                .any(|item| match item {
                    rhwp::renderer::pagination::PageItem::FullParagraph { para_index } => {
                        *para_index == 2
                    }
                    rhwp::renderer::pagination::PageItem::PartialParagraph {
                        para_index,
                        start_line,
                        ..
                    } => *para_index == 2 && *start_line == 0,
                    _ => false,
                })
                .then_some(index)
        })
        .expect("mixed row remains in pagination");
    assert_eq!(
        column_for_alpha, 1,
        "full-H moves the row to the right column"
    );
    assert_eq!(result.endnote_paragraphs[1].line_segs[0].line_height, 7000);
    assert_eq!(result.endnote_paragraphs[1].line_segs[0].line_spacing, GAP);
    unchanged(&core, &before);
}

// 첫 행의 shallow 비영향 수식은 종전 textH-em 압축(225HU)의 실제 양수 조건이다.
// raw EQEDIT와 LINE_SEG로 만든 원본이므로 인증 경로의 진행 증거도 함께 검사한다.
fn shallow_equation_note_fixture() -> DocumentCore {
    let mut eq_children = Vec::new();
    let mut common = vec![0; 44];
    common[..4].copy_from_slice(&tags::CTRL_EQUATION.to_le_bytes());
    let attr = 1u32 | (2 << 3) | (2 << 8) | (4 << 15) | (2 << 18) | (1 << 21);
    common[4..8].copy_from_slice(&attr.to_le_bytes());
    common[16..20].copy_from_slice(&1000u32.to_le_bytes());
    common[20..24].copy_from_slice(&1125u32.to_le_bytes());
    record(&mut eq_children, tags::HWPTAG_CTRL_HEADER, 3, &common);
    let mut eq = 0u32.to_le_bytes().to_vec();
    eq.extend(1u16.to_le_bytes());
    eq.extend(('1' as u16).to_le_bytes());
    eq.extend(900u32.to_le_bytes());
    eq.extend(0u32.to_le_bytes());
    eq.extend(85i16.to_le_bytes());
    eq.extend(0u16.to_le_bytes());
    for value in ["Equation Version 60", "HYhwpEQ"] {
        let units: Vec<_> = value.encode_utf16().collect();
        eq.extend((units.len() as u16).to_le_bytes());
        eq.extend(units.into_iter().flat_map(u16::to_le_bytes));
    }
    record(&mut eq_children, tags::HWPTAG_EQEDIT, 4, &eq);
    let mut eq_text = slot(11, tags::CTRL_EQUATION);
    eq_text.extend(" \nEQNEXT".encode_utf16());
    let mut first = line(0, TEXT_H + GAP, 2070);
    first.text_height = 1125;
    first.baseline_distance = 956;
    first.line_spacing = 452;
    let mut second = line(10, TEXT_H + GAP + 1577, 1125);
    second.baseline_distance = 956;
    second.line_spacing = 452;
    let mut notes = paragraph(
        &"EQHEAD".encode_utf16().collect::<Vec<_>>(),
        &[line(0, 0, TEXT_H)],
        &[],
        2,
    );
    notes.extend(paragraph(&eq_text, &[first, second], &eq_children, 2));
    notes.extend(paragraph(
        &[],
        &[line(0, TEXT_H + GAP + 2 * 1577, TEXT_H)],
        &[],
        2,
    ));
    let mut control = tags::CTRL_ENDNOTE.to_le_bytes().to_vec();
    control.extend(1u32.to_le_bytes());
    control.extend(0u16.to_le_bytes());
    control.extend((')' as u16).to_le_bytes());
    control.extend(0u32.to_le_bytes());
    let mut children = Vec::new();
    record(&mut children, tags::HWPTAG_CTRL_HEADER, 1, &control);
    let mut list = vec![0; 16];
    list[..4].copy_from_slice(&3u32.to_le_bytes());
    record(&mut children, tags::HWPTAG_LIST_HEADER, 2, &list);
    children.extend(notes);
    let mut body = "BODY".encode_utf16().collect::<Vec<_>>();
    body.extend(slot(17, tags::CTRL_ENDNOTE));
    let raw = paragraph(&body, &[line(0, 0, TEXT_H)], &children, 0);
    let parsed = parse_body_text_section(&raw).expect("raw shallow-equation note");
    let mut core = fixture(false);
    let section = &mut core.document_mut().sections[0];
    section.paragraphs = parsed.paragraphs;
    section.raw_stream = Some(raw);
    section.section_def.endnote_shape.separator_margin_bottom = GAP as i16;
    section.section_def.endnote_shape.note_spacing = 0;
    core
}

fn shallow_equation_line(root: &RenderNode) -> &RenderNode {
    nodes(root)
        .into_iter()
        .find(|node| {
            matches!(&node.node_type, RenderNodeType::TextLine(_))
                && nodes(node)
                    .iter()
                    .any(|child| matches!(&child.node_type, RenderNodeType::Equation(_)))
        })
        .expect("shallow source equation row")
}

#[test]
fn certified_shallow_equation_note_keeps_exact_successor_origin_without_legacy_compaction() {
    let mut core = shallow_equation_note_fixture();
    let source = &note(&core).paragraphs[1];
    let Control::Equation(eq) = &source.controls[0] else {
        panic!("parsed EQEDIT")
    };
    assert!(eq.common.treat_as_char && !eq.common.affect_line_spacing);
    assert_eq!((eq.font_size, eq.common.height), (900, 1125));
    assert_eq!(eq.version_info, "Equation Version 60");
    assert_eq!(
        source.line_segs[1].vertical_pos - source.line_segs[0].vertical_pos,
        1577
    );
    let before = format!("{:?}", core.document().sections);
    let result = paginate(&core);
    assert_eq!(
        result.endnote_para_sources[1]
            .certified_line_advances_hu
            .as_deref(),
        Some(&[1577, 1577][..])
    );
    core.refresh_layout_native();
    let tree = core.build_page_render_tree(0).unwrap();
    let first = shallow_equation_line(&tree.root);
    close(
        line_y(&tree.root, "EQNEXT") - first.bbox.y,
        1577.0 * DPI / 7200.0,
    );
    close(first.bbox.height, 2070.0 * DPI / 7200.0);
    unchanged(&core, &before);
}

#[test]
fn fallback_shallow_equation_note_retains_legacy_origin_compaction() {
    let mut core = shallow_equation_note_fixture();
    // 보이는 구분선은 인증의 지원 범위 밖이다. 기존 미주 처리를 그대로 검사한다.
    core.document_mut().sections[0]
        .section_def
        .endnote_shape
        .separator_line_type = 1;
    let before = format!("{:?}", core.document().sections);
    let result = paginate(&core);
    assert!(result
        .endnote_para_sources
        .iter()
        .all(|source| source.certified_line_advances_hu.is_none()));
    core.refresh_layout_native();
    let tree = core.build_page_render_tree(0).unwrap();
    let first = shallow_equation_line(&tree.root);
    close(
        line_y(&tree.root, "EQNEXT") - first.bbox.y,
        (1577.0 - 225.0) * DPI / 7200.0,
    );
    unchanged(&core, &before);
}

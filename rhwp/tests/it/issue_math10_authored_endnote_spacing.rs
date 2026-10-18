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
    let doc = core.document();
    let sec = &doc.sections[0];
    let styles = resolve_styles(&doc.doc_info, DPI);
    let composed = compose_section_with_styles(sec, &styles);
    TypesetEngine::new(DPI).typeset_section_with_variant(
        &sec.paragraphs,
        &composed,
        &styles,
        &sec.section_def.page_def,
        &ColumnDef::default(),
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

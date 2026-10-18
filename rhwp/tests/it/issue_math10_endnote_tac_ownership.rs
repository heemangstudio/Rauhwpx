//! 접힌 가시 경계에서도 raw HWP5 미주 수식의 원본 줄 소속을 잃지 않는다.
//! 합성 CFB → 공개 DocumentCore 로드/편집/저장/렌더 경로만 사용한다.
use std::io::{Cursor, Write};

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::paragraph::{LineSeg, Paragraph};
use rhwp::model::provenance::FontMetricsPolicy;
use rhwp::parser::tags;
use rhwp::renderer::render_tree::{BoundingBox, RenderNode, RenderNodeType};

// 직접 작성한 짧은 식이다. 원본 시험지/서체 파일은 테스트에 포함하지 않는다.
const SCRIPTS: [&str; 4] = [" a+b=c ", "=d over e", " f^{2}+g^{2}=1 ", "{h-1} over h=2"];
const RAW_MARKERS: [u32; 4] = [0, 8, 16, 28];
const TARGET: usize = 2;

fn record(out: &mut Vec<u8>, tag: u16, level: u16, data: &[u8]) {
    out.extend(rhwp::serializer::record_writer::write_record(
        tag, level, data,
    ));
}

fn slot(code: u16, id: u32) -> Vec<u16> {
    let id = id.to_le_bytes();
    vec![
        code,
        u16::from_le_bytes([id[0], id[1]]),
        u16::from_le_bytes([id[2], id[3]]),
        0,
        0,
        0,
        0,
        code,
    ]
}

fn paragraph(text: &[u16], starts: &[u32], y: i32, children: &[u8], level: u16) -> Vec<u8> {
    let mut header = vec![0; 22];
    header[..4].copy_from_slice(&(text.len() as u32 + 1).to_le_bytes());
    header[12..14].copy_from_slice(&1u16.to_le_bytes());
    header[16..18].copy_from_slice(&(starts.len() as u16).to_le_bytes());
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
    let mut rows = Vec::new();
    for (index, start) in starts.iter().enumerate() {
        for value in [
            *start as i32,
            y + index as i32 * 3268,
            2768,
            2768,
            2214,
            500,
            0,
            38000,
            LineSeg::TAG_SINGLE_SEGMENT_LINE as i32,
        ] {
            rows.extend(value.to_le_bytes());
        }
    }
    record(&mut out, tags::HWPTAG_PARA_LINE_SEG, level + 1, &rows);
    out.extend(children);
    out
}

fn equation(script: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let mut common = tags::CTRL_EQUATION.to_le_bytes().to_vec();
    // TAC, y/x, 선언 폭/높이, z, 여백. 설치 폰트 없이도 네 식이 충분히 들어간다.
    for value in [1u32, 0, 0, 5000, 1600, 0, 0, 0, 0] {
        common.extend(value.to_le_bytes());
    }
    record(&mut out, tags::HWPTAG_CTRL_HEADER, 3, &common);
    let units: Vec<_> = script.encode_utf16().collect();
    let mut eq = 0u32.to_le_bytes().to_vec();
    eq.extend((units.len() as u16).to_le_bytes());
    eq.extend(units.into_iter().flat_map(u16::to_le_bytes));
    eq.extend(1000u32.to_le_bytes());
    eq.extend(0u32.to_le_bytes());
    eq.extend(80i16.to_le_bytes());
    eq.extend([0; 6]);
    record(&mut out, tags::HWPTAG_EQEDIT, 4, &eq);
    out
}

fn fixture_bytes() -> Vec<u8> {
    let mut blank = DocumentCore::new_empty();
    blank.create_blank_document_native().unwrap();
    let doc = blank.document_mut();
    let cs = &mut doc.doc_info.char_shapes[0];
    cs.raw_data = None;
    cs.base_size = 1000;
    cs.ratios = [100; 7];
    cs.relative_sizes = [100; 7];
    cs.spacings = [0; 7];
    let ps = &mut doc.doc_info.para_shapes[0];
    ps.raw_data = None;
    ps.spacing_before = 0;
    ps.spacing_after = 0;
    let mut sd = doc.sections[0].section_def.clone();
    sd.page_def.width = 40000;
    sd.page_def.height = 30000;
    sd.page_def.margin_left = 1000;
    sd.page_def.margin_right = 1000;
    sd.page_def.margin_top = 1000;
    sd.page_def.margin_bottom = 1000;
    sd.page_def.margin_header = 0;
    sd.page_def.margin_footer = 0;
    // 가시 구분선은 whole-note 간격 인증의 지원 밖이다. 줄 소속과 분리한다.
    sd.endnote_shape.separator_line_type = 1;
    sd.endnote_shape.separator_line_width = 1;
    sd.endnote_shape.separator_length = 4000;
    sd.endnote_shape.separator_margin_top = 0;
    sd.endnote_shape.separator_margin_bottom = 864;
    sd.endnote_shape.note_spacing = 576;
    sd.endnote_shape.raw_unknown = 0;
    let mut records = Vec::new();
    rhwp::serializer::control::serialize_control(
        &Control::SectionDef(Box::new(sd)),
        1,
        None,
        &mut records,
    );
    let section_controls = rhwp::serializer::record_writer::write_records(&records);
    let mut section = paragraph(
        &slot(2, tags::CTRL_SECTION_DEF),
        &[0],
        0,
        &section_controls,
        0,
    );

    let mut note = Vec::new();
    for (text, y) in [("HEAD", 0), ("CONTEXT", 3268)] {
        note.extend(paragraph(
            &text.encode_utf16().collect::<Vec<_>>(),
            &[0],
            y,
            &[],
            2,
        ));
    }
    let mut mixed = Vec::new();
    let mut controls = Vec::new();
    for (index, script) in SCRIPTS.iter().enumerate() {
        if index == 3 {
            mixed.extend("이므로 ".encode_utf16());
        }
        assert_eq!(mixed.len() as u32, RAW_MARKERS[index]);
        mixed.extend(slot(11, tags::CTRL_EQUATION));
        controls.extend(equation(script));
    }
    mixed.extend(" ".encode_utf16());
    note.extend(paragraph(&mixed, &[0, 16], 6536, &controls, 2));
    note.extend(paragraph(
        &"AFTER".encode_utf16().collect::<Vec<_>>(),
        &[0],
        13072,
        &[],
        2,
    ));

    let mut children = Vec::new();
    let mut endnote = tags::CTRL_ENDNOTE.to_le_bytes().to_vec();
    endnote.extend(1u32.to_le_bytes());
    endnote.extend(0u16.to_le_bytes());
    endnote.extend((')' as u16).to_le_bytes());
    endnote.extend(0u32.to_le_bytes());
    record(&mut children, tags::HWPTAG_CTRL_HEADER, 1, &endnote);
    let mut list = vec![0; 16];
    list[..4].copy_from_slice(&4u32.to_le_bytes());
    record(&mut children, tags::HWPTAG_LIST_HEADER, 2, &list);
    children.extend(note);
    let mut body = "BODY".encode_utf16().collect::<Vec<_>>();
    body.extend(slot(17, tags::CTRL_ENDNOTE));
    section.extend(paragraph(&body, &[0], 3268, &children, 0));

    let mut header = vec![0; 256];
    header[..17].copy_from_slice(b"HWP Document File");
    header[32..36].copy_from_slice(&[0, 0, 0, 5]);
    let info = rhwp::serializer::doc_info::serialize_doc_info(&doc.doc_info, &doc.doc_properties);
    let mut cfb =
        cfb::CompoundFile::create_with_version(cfb::Version::V3, Cursor::new(Vec::new())).unwrap();
    cfb.create_storage_all("/BodyText").unwrap();
    for (path, bytes) in [
        ("/FileHeader", header),
        ("/DocInfo", info),
        ("/BodyText/Section0", section),
    ] {
        cfb.create_stream(path).unwrap().write_all(&bytes).unwrap();
    }
    cfb.into_inner().into_inner()
}

fn load(policy: FontMetricsPolicy) -> DocumentCore {
    DocumentCore::from_bytes_with_font_metrics(&fixture_bytes(), policy).unwrap()
}

fn host(core: &DocumentCore) -> (usize, usize, &Paragraph) {
    for (pi, para) in core.document().sections[0].paragraphs.iter().enumerate() {
        for (ci, control) in para.controls.iter().enumerate() {
            if let Control::Endnote(note) = control {
                return (pi, ci, &note.paragraphs[TARGET]);
            }
        }
    }
    panic!("합성 raw 미주 없음")
}

fn scripts(core: &DocumentCore) -> Vec<Vec<u8>> {
    host(core)
        .2
        .controls
        .iter()
        .map(|control| match control {
            Control::Equation(eq) => eq.script.as_bytes().to_vec(),
            _ => panic!("수식 이외 제어"),
        })
        .collect()
}

#[derive(Debug)]
enum Content {
    Equation(usize),
    Text(String),
}

#[derive(Debug)]
struct Coverage {
    equations: Vec<(usize, u32, BoundingBox)>,
    content: Vec<(u32, Content)>,
}

fn coverage(core: &DocumentCore) -> Coverage {
    fn walk(node: &RenderNode, row: Option<u32>, owner: (usize, usize), out: &mut Coverage) {
        let row = match &node.node_type {
            RenderNodeType::TextLine(line) => line.line_index,
            _ => row,
        };
        match &node.node_type {
            RenderNodeType::Equation(eq) => {
                let source = eq.note_ref.as_ref().expect("미주 수식 원본 주소");
                assert_eq!(source.kind, "endnote");
                assert_eq!(source.section_index, 0);
                assert_eq!((source.para_index, source.control_index), owner);
                assert_eq!(source.note_para_index, TARGET);
                assert!(node.visible && node.bbox.width > 0.0 && node.bbox.height > 0.0);
                assert!(!eq.svg_content.is_empty());
                let row = row.expect("수식의 실제 TextLine 소속");
                out.equations
                    .push((source.inner_control_index, row, node.bbox));
                out.content
                    .push((row, Content::Equation(source.inner_control_index)));
            }
            RenderNodeType::TextRun(run) if !run.text.is_empty() => {
                out.content
                    .push((row.unwrap_or(u32::MAX), Content::Text(run.text.clone())));
            }
            _ => {}
        }
        for child in &node.children {
            walk(child, row, owner, out);
        }
    }
    let (pi, ci, _) = host(core);
    let mut out = Coverage {
        equations: Vec::new(),
        content: Vec::new(),
    };
    for page in 0..core.page_count() {
        let tree = core.build_page_render_tree(page).unwrap();
        walk(&tree.root, None, (pi, ci), &mut out);
    }
    assert_eq!(
        out.equations
            .iter()
            .map(|(ci, _, _)| *ci)
            .collect::<Vec<_>>(),
        vec![0, 1, 2, 3],
        "모든 쪽에서 각 원본 제어를 한 번만 그린다: {out:?}"
    );
    out
}

fn assert_authored(core: &DocumentCore) {
    let before = format!("{:?}", core.document().sections);
    let para = host(core).2;
    assert_eq!(para.char_count, 38);
    assert_eq!(para.text, "이므로  ");
    assert_eq!(para.char_offsets, vec![24, 25, 26, 27, 36]);
    assert_eq!(
        para.line_segs
            .iter()
            .map(|row| row.text_start)
            .collect::<Vec<_>>(),
        vec![0, 16]
    );
    assert_eq!(
        scripts(core),
        SCRIPTS.map(|script| script.as_bytes().to_vec())
    );
    let out = coverage(core);
    assert_eq!(
        out.equations
            .iter()
            .map(|(_, row, _)| *row)
            .collect::<Vec<_>>(),
        vec![0, 0, 1, 1]
    );
    assert!(out.equations[0].2.x < out.equations[1].2.x);
    assert!(out.equations[2].2.x < out.equations[3].2.x);
    let e2 = out
        .content
        .iter()
        .position(|(_, item)| matches!(item, Content::Equation(2)))
        .unwrap();
    let e3 = out
        .content
        .iter()
        .position(|(_, item)| matches!(item, Content::Equation(3)))
        .unwrap();
    let prose: String = out.content[e2 + 1..e3]
        .iter()
        .filter_map(|(_, item)| match item {
            Content::Text(text) => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(prose, "이므로 ");
    assert_eq!(
        format!("{:?}", core.document().sections),
        before,
        "그리기는 원본을 변경하지 않는다"
    );
}

#[test]
fn windows_raw_endnote_equations_keep_distinct_source_rows() {
    assert_authored(&load(FontMetricsPolicy::HancomWindows));
}

#[test]
fn hcr_raw_endnote_uses_the_same_ownership_without_windows_metrics() {
    assert_authored(&load(FontMetricsPolicy::HcrDeclared));
}

#[test]
fn hwpx_reopen_keeps_scripts_and_every_equation_visible() {
    let core = load(FontMetricsPolicy::HancomWindows);
    let before = scripts(&core);
    let text = host(&core).2.text.clone();
    let bytes = core.export_hwpx_native().unwrap();
    let reopened =
        DocumentCore::from_bytes_with_font_metrics(&bytes, FontMetricsPolicy::HancomWindows)
            .unwrap();
    assert_eq!(scripts(&reopened), before);
    assert_eq!(host(&reopened).2.text, text);
    coverage(&reopened);
}

#[test]
fn edited_note_follows_current_reflow_rows_instead_of_stale_authored_owners() {
    fn assert_edited_content(out: &Coverage, prefix: &str) {
        let equation_pos = |ci| {
            out.content
                .iter()
                .position(|(_, item)| matches!(item, Content::Equation(index) if *index == ci))
                .unwrap()
        };
        let text_between = |start, end| {
            out.content[start..end]
                .iter()
                .filter_map(|(_, item)| match item {
                    Content::Text(text) => Some(text.as_str()),
                    _ => None,
                })
                .collect::<String>()
        };
        assert!(
            text_between(0, equation_pos(0)).ends_with(prefix),
            "편집한 접두 텍스트 전체가 첫 수식 앞에 그려진다: {out:?}"
        );
        assert_eq!(
            text_between(equation_pos(2) + 1, equation_pos(3)),
            "이므로 "
        );
    }

    let mut core = load(FontMetricsPolicy::HancomWindows);
    let before = scripts(&core);
    let original_text = host(&core).2.text.clone();
    let original_offsets = host(&core).2.char_offsets.clone();
    let original_count = host(&core).2.char_count;
    let original_controls = format!("{:?}", host(&core).2.controls);
    assert_current_target_coverage(&core);
    // 기존 렌더 캐시를 채운 뒤 같은 공개 문서를 편집한다.
    for page in 0..core.page_count() {
        core.build_page_layer_tree(page).unwrap();
    }
    let (pi, ci, _) = host(&core);
    let prefix = "EDITED ".repeat(100);
    let expected_text = format!("{prefix}{original_text}");
    core.insert_text_in_footnote_native(0, pi, ci, TARGET, 0, &prefix)
        .unwrap();
    // refresh가 편집 API의 캐시 무효화 누락을 가리지 않도록 직후에도 그린다.
    for refresh in [false, true] {
        if refresh {
            core.refresh_layout_native();
        }
        assert_eq!(scripts(&core), before);
        let para = host(&core).2;
        assert_eq!(para.text, expected_text);
        assert!(core.document().sections[0].raw_stream.is_none());
        // reflow는 기존 첫 줄의 tag를 보존한다. 실제 새 줄과 방출 소속으로 검증한다.
        assert!(para.line_segs.len() > 2, "긴 접두 텍스트가 새 줄을 만든다");
        assert_eq!(para.line_segs[0].text_start, 0);
        assert!(para
            .line_segs
            .windows(2)
            .all(|rows| rows[0].text_start < rows[1].text_start));
        // 공개 편집 API는 선두 제어 앞에 삽입한다. 8-unit 슬롯 자체도 함께 밀린다.
        let delta = prefix.encode_utf16().count() as u32;
        assert_eq!(target_raw_markers(para), RAW_MARKERS.map(|raw| raw + delta));
        let expected: Vec<_> = RAW_MARKERS
            .iter()
            .map(|raw| {
                para.line_segs
                    .partition_point(|row| row.text_start <= raw + delta)
                    .saturating_sub(1) as u32
            })
            .collect();
        assert!(expected[0] > 1, "첫 수식도 원본 두 줄보다 뒤로 이동한다");
        assert_ne!(expected, vec![0, 0, 1, 1], "저장 소속 재사용을 구별한다");
        // 캐시를 쓰는 실제 layer 경로도 새 접두 텍스트 전체를 반환해야 한다.
        let cached_text: String = (0..core.page_count())
            .flat_map(|page| {
                core.build_page_layer_tree(page)
                    .unwrap()
                    .text_sources
                    .entries
            })
            .map(|entry| entry.text)
            .collect();
        assert!(
            cached_text.contains(prefix.as_str()),
            "편집 전 페이지 캐시를 버린다"
        );
        let out = coverage(&core);
        assert_eq!(
            out.equations
                .iter()
                .map(|(_, row, _)| *row)
                .collect::<Vec<_>>(),
            expected
        );
        assert_edited_content(&out, &prefix);
    }
    let bytes = core.export_hwpx_native().unwrap();
    let reopened =
        DocumentCore::from_bytes_with_font_metrics(&bytes, FontMetricsPolicy::HancomWindows)
            .unwrap();
    assert_eq!(scripts(&reopened), before);
    assert_eq!(host(&reopened).2.text, expected_text);
    assert_edited_content(&coverage(&reopened), &prefix);
    assert_current_target_coverage(&reopened);

    // Studio 삽입 커맨드의 undo/redo와 같은 공개 삭제/재삽입이다. 스냅샷은 쓰지 않는다.
    core.delete_text_in_footnote_native(0, pi, ci, TARGET, 0, prefix.chars().count())
        .unwrap();
    for refresh in [false, true] {
        if refresh {
            core.refresh_layout_native();
        }
        let para = host(&core).2;
        assert_eq!(para.text, original_text);
        assert_eq!(para.char_offsets, original_offsets);
        assert_eq!(para.char_count, original_count);
        assert_eq!(format!("{:?}", para.controls), original_controls);
        assert_eq!(scripts(&core), before);
        assert!(core.document().sections[0].raw_stream.is_none());
        assert_eq!(target_raw_markers(para), RAW_MARKERS);
        assert!(!cached_page_text(&core).contains(prefix.as_str()));
        // 역 reflow의 현재 줄로 판단한다. 원본 [0,0,1,1]이나 저장 기하는 요구하지 않는다.
        let out = assert_current_target_coverage(&core);
        assert_edited_content(&out, "");
        let text: String = out
            .content
            .iter()
            .filter_map(|(_, item)| match item {
                Content::Text(text) => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(
            !text.contains(prefix.as_str()),
            "undo한 접두 텍스트가 남지 않는다"
        );
    }
    let undone_bytes = core.export_hwpx_native().unwrap();
    let undone_reopened =
        DocumentCore::from_bytes_with_font_metrics(&undone_bytes, FontMetricsPolicy::HancomWindows)
            .unwrap();
    assert_eq!(host(&undone_reopened).2.text, original_text);
    assert_eq!(scripts(&undone_reopened), before);
    // HWPX에서 다시 읽은 raw 위치와 줄을 사용한다. 저장 전 줄 번호를 강제하지 않는다.
    assert_edited_content(&assert_current_target_coverage(&undone_reopened), "");

    core.insert_text_in_footnote_native(0, pi, ci, TARGET, 0, &prefix)
        .unwrap();
    for refresh in [false, true] {
        if refresh {
            core.refresh_layout_native();
        }
        let para = host(&core).2;
        assert_eq!(para.text, expected_text);
        assert_eq!(scripts(&core), before);
        assert_eq!(format!("{:?}", para.controls), original_controls);
        assert!(core.document().sections[0].raw_stream.is_none());
        assert_eq!(
            target_raw_markers(para),
            RAW_MARKERS.map(|raw| raw + prefix.encode_utf16().count() as u32)
        );
        assert!(cached_page_text(&core).contains(prefix.as_str()));
        assert_edited_content(&assert_current_target_coverage(&core), &prefix);
    }
}

// 원본 fixture는 그대로 두고, 파서의 실제 HWP3 계보 입력만 CFB에 추가한다.
fn hwp3_lineage_fixture_bytes() -> Vec<u8> {
    use std::io::{Seek, SeekFrom};

    let mut cfb = cfb::OpenOptions::new()
        .open_with(Cursor::new(fixture_bytes()))
        .unwrap();
    {
        let mut section = cfb.open_stream("/BodyText/Section0").unwrap();
        section.seek(SeekFrom::End(0)).unwrap();
        for _ in 0..128 {
            section.write_all(&paragraph(&[], &[0], 0, &[], 0)).unwrap();
        }
    }

    // OLE SummaryInformation: UTF-16 코드페이지와 직접 작성한 제목 "2001년".
    // 현재 detect_hwp3_variant는 스트림 전체의 UTF-16 연도를 검색한다.
    let mut summary = vec![0u8; 48];
    summary[..2].copy_from_slice(&0xfffeu16.to_le_bytes());
    summary[24..28].copy_from_slice(&1u32.to_le_bytes());
    summary[28..44].copy_from_slice(&[
        0xe0, 0x85, 0x9f, 0xf2, 0xf9, 0x4f, 0x68, 0x10, 0xab, 0x91, 0x08, 0x00, 0x2b, 0x27, 0xb3,
        0xd9,
    ]);
    summary[44..48].copy_from_slice(&48u32.to_le_bytes());
    // section size, property count, (property id, section-relative offset).
    for value in [52u32, 2, 1, 24, 2, 32] {
        summary.extend(value.to_le_bytes());
    }
    summary.extend(2u32.to_le_bytes()); // VT_I2
    summary.extend(1200u16.to_le_bytes());
    summary.extend([0; 2]);
    summary.extend(31u32.to_le_bytes()); // VT_LPWSTR
    summary.extend(6u32.to_le_bytes()); // 종단 NUL 포함 UTF-16 unit 수
    summary.extend("2001년\0".encode_utf16().flat_map(u16::to_le_bytes));
    cfb.create_stream("/\u{0005}HwpSummaryInformation")
        .unwrap()
        .write_all(&summary)
        .unwrap();
    cfb.into_inner().into_inner()
}

#[test]
fn raw_hwp5_with_hwp3_lineage_keeps_authored_endnote_owners_under_both_policies() {
    use rhwp::model::provenance::SourceFormat;

    let bytes = hwp3_lineage_fixture_bytes();
    for policy in [
        FontMetricsPolicy::HancomWindows,
        FontMetricsPolicy::HcrDeclared,
    ] {
        let core = DocumentCore::from_bytes_with_font_metrics(&bytes, policy).unwrap();
        let doc = core.document();
        assert_eq!(doc.provenance.format, SourceFormat::Hwp5, "{policy:?}");
        assert_eq!(doc.header.version.major, 5, "{policy:?}");
        let body_count: usize = doc
            .sections
            .iter()
            .map(|section| section.paragraphs.len())
            .sum();
        assert!(body_count > 50, "{policy:?}: {body_count}");
        assert!((doc.doc_info.para_shapes.len() as f64 / body_count as f64) < 0.20);
        assert!((doc.doc_info.char_shapes.len() as f64 / body_count as f64) < 0.20);
        assert!(doc.is_hwp3_variant, "{policy:?}");
        assert!(doc.provenance.hwp3_lineage, "{policy:?}");
        assert!(!doc.provenance.hwpx_lineage, "{policy:?}");
        let profile = doc.layout_profile();
        assert!(!profile.native_hwp5_layout(), "{policy:?}");
        assert!(!profile.hwp5_origin_hwpx(), "{policy:?}");
        assert!(!profile.own_line_layout(), "{policy:?}");
        assert!(!profile.session_edited(), "{policy:?}");
        assert!(doc.sections[0].raw_provenance.is_some(), "{policy:?}");
        assert!(
            doc.sections[0]
                .raw_stream
                .as_ref()
                .is_some_and(|raw| !raw.is_empty()),
            "{policy:?}"
        );
        // 기존 공개 전 쪽 그리기·SourceRef·가시 경계·0,0,1,1 검증을 그대로 사용한다.
        assert_authored(&core);
    }
}

// 이 fixture의 제어는 모두 8-unit 수식 슬롯이다. 현재 문자 사이의 빈 raw 구간에서
// 직접 읽어 렌더러의 소속/인증 helper와 독립된 기준을 만든다. 저장 후에도 다시 읽는다.
fn target_raw_markers(para: &Paragraph) -> Vec<u32> {
    assert_eq!(para.controls.len(), SCRIPTS.len());
    assert!(para
        .controls
        .iter()
        .all(|c| matches!(c, Control::Equation(_))));
    assert_eq!(para.text.chars().count(), para.char_offsets.len());
    let mut markers = Vec::new();
    let mut cursor = 0;
    for (ch, &offset) in para.text.chars().zip(&para.char_offsets) {
        assert!(offset >= cursor, "문자 raw 위치가 역전되지 않는다");
        assert_eq!((offset - cursor) % 8, 0, "완전한 수식 슬롯만 허용한다");
        markers.extend((cursor..offset).step_by(8));
        cursor = offset + ch.len_utf16() as u32;
    }
    let terminal = para.char_count.checked_sub(1).expect("문단 끝 마커");
    assert!(terminal >= cursor);
    assert_eq!((terminal - cursor) % 8, 0);
    markers.extend((cursor..terminal).step_by(8));
    assert_eq!(markers.len(), para.controls.len());
    markers
}

fn assert_current_target_coverage(core: &DocumentCore) -> Coverage {
    let para = host(core).2;
    assert!(!para.line_segs.is_empty());
    assert_eq!(para.line_segs[0].text_start, 0);
    assert!(para
        .line_segs
        .windows(2)
        .all(|rows| rows[0].text_start < rows[1].text_start));
    let expected: Vec<_> = target_raw_markers(para)
        .iter()
        .map(|raw| {
            assert!(*raw < para.char_count - 1);
            (para.line_segs.partition_point(|row| row.text_start <= *raw) - 1) as u32
        })
        .collect();
    let out = coverage(core);
    assert_eq!(
        out.equations
            .iter()
            .map(|(_, row, _)| *row)
            .collect::<Vec<_>>(),
        expected,
        "방출 소속은 현재 raw 위치와 현재 줄 경계를 따른다"
    );
    for (_, _, bbox) in &out.equations {
        assert!([bbox.x, bbox.y, bbox.width, bbox.height]
            .iter()
            .all(|v| v.is_finite()));
    }
    out
}

fn cached_page_text(core: &DocumentCore) -> String {
    (0..core.page_count())
        .flat_map(|page| {
            core.build_page_layer_tree(page)
                .unwrap()
                .text_sources
                .entries
        })
        .map(|entry| entry.text)
        .collect()
}

#[test]
fn unrelated_body_edit_keeps_untouched_endnote_equations_visible_on_current_rows() {
    use std::io::{Seek, SeekFrom};

    // 원본 세 unedited 회귀와 계보 fixture는 바꾸지 않고 별도 BODY 문단을 덧붙인다.
    let mut cfb = cfb::OpenOptions::new()
        .open_with(Cursor::new(fixture_bytes()))
        .unwrap();
    {
        let mut section = cfb.open_stream("/BodyText/Section0").unwrap();
        section.seek(SeekFrom::End(0)).unwrap();
        section
            .write_all(&paragraph(
                &"OTHER BODY".encode_utf16().collect::<Vec<_>>(),
                &[0],
                6536,
                &[],
                0,
            ))
            .unwrap();
    }
    let bytes = cfb.into_inner().into_inner();
    let mut core =
        DocumentCore::from_bytes_with_font_metrics(&bytes, FontMetricsPolicy::HancomWindows)
            .unwrap();
    let (pi, ci, para) = host(&core);
    let original_text = para.text.clone();
    let original_offsets = para.char_offsets.clone();
    let original_count = para.char_count;
    let original_controls = format!("{:?}", para.controls);
    let before = scripts(&core);
    let other_pi = core.document().sections[0]
        .paragraphs
        .iter()
        .position(|para| para.text == "OTHER BODY" && para.controls.is_empty())
        .expect("미주 host와 다른 BODY 문단");
    assert_ne!(other_pi, pi);
    assert!(!core.document().layout_profile().session_edited());
    assert_current_target_coverage(&core);
    assert!(cached_page_text(&core).contains("OTHER BODY"));

    let prefix = "BODY EDIT ";
    let expected_body_text = format!("{prefix}OTHER BODY");
    core.insert_text_native(0, other_pi, 0, prefix).unwrap();
    for refresh in [false, true] {
        if refresh {
            core.refresh_layout_native();
        }
        assert_eq!(
            core.document().sections[0].paragraphs[other_pi].text,
            expected_body_text
        );
        assert!(core.document().sections[0].raw_stream.is_none());
        assert!(core.document().layout_profile().session_edited());
        let (current_pi, current_ci, para) = host(&core);
        assert_eq!((current_pi, current_ci), (pi, ci));
        assert_eq!(para.text, original_text);
        assert_eq!(para.char_offsets, original_offsets);
        assert_eq!(para.char_count, original_count);
        assert_eq!(format!("{:?}", para.controls), original_controls);
        assert_eq!(scripts(&core), before);
        assert_eq!(target_raw_markers(para), RAW_MARKERS);
        // 먼저 warmed cache 경로를 읽고, 그 뒤 모든 쪽의 실제 수식/현재 소속을 검증한다.
        assert!(cached_page_text(&core).contains(expected_body_text.as_str()));
        assert_current_target_coverage(&core);
    }
}

// 아래는 별도 v3 확장이다. 위 여섯 원본 테스트/도우미의 assertion은 그대로 둔다.
fn repair_body_fixture(lineage: bool, location: usize) -> (Vec<u8>, usize) {
    use std::io::Read;
    let bytes = if lineage {
        hwp3_lineage_fixture_bytes()
    } else {
        fixture_bytes()
    };
    let mut file = cfb::OpenOptions::new()
        .open_with(Cursor::new(bytes))
        .unwrap();
    let mut section = Vec::new();
    file.open_stream("/BodyText/Section0")
        .unwrap()
        .read_to_end(&mut section)
        .unwrap();
    let body = paragraph(
        &"OTHER BODY".encode_utf16().collect::<Vec<_>>(),
        &[0],
        16340,
        &[],
        0,
    );
    // 레코드 헤더만 읽어 두 번째 root 문단 앞에 삽입한다. 원본은 직접 만든 CFB다.
    let mut offset = 0;
    let mut roots = Vec::new();
    while offset < section.len() {
        let word = u32::from_le_bytes(section[offset..offset + 4].try_into().unwrap());
        let tag = word & 0x3ff;
        let level = (word >> 10) & 0x3ff;
        let mut size = (word >> 20) as usize;
        let mut header = 4;
        if size == 0xfff {
            size = u32::from_le_bytes(section[offset + 4..offset + 8].try_into().unwrap()) as usize;
            header = 8;
        }
        if tag == u32::from(tags::HWPTAG_PARA_HEADER) && level == 0 {
            roots.push(offset);
        }
        offset += header + size;
    }
    assert_eq!(offset, section.len());
    if location < 2 {
        let at = if location == 0 {
            roots[1]
        } else {
            section.len()
        };
        section.splice(at..at, body);
        file.create_stream("/BodyText/Section0")
            .unwrap()
            .write_all(&section)
            .unwrap();
    } else {
        let original = if lineage {
            hwp3_lineage_fixture_bytes()
        } else {
            fixture_bytes()
        };
        let parsed = DocumentCore::from_bytes(&original).unwrap();
        let definition = parsed.document().sections[0].section_def.clone();
        let mut records = Vec::new();
        rhwp::serializer::control::serialize_control(
            &Control::SectionDef(Box::new(definition)),
            1,
            None,
            &mut records,
        );
        let mut second = paragraph(
            &slot(2, tags::CTRL_SECTION_DEF),
            &[0],
            0,
            &rhwp::serializer::record_writer::write_records(&records),
            0,
        );
        second.extend(body);
        file.create_stream("/BodyText/Section1")
            .unwrap()
            .write_all(&second)
            .unwrap();
    }
    (
        file.into_inner().into_inner(),
        if location == 2 { 1 } else { 0 },
    )
}

fn repair_edited_content(out: &Coverage, prefix: &str) {
    let eq = |ci| {
        out.content
            .iter()
            .position(|(_, item)| matches!(item,Content::Equation(index) if *index==ci))
            .unwrap()
    };
    let text = |start, end| {
        out.content[start..end]
            .iter()
            .filter_map(|(_, v)| match v {
                Content::Text(s) => Some(s.as_str()),
                _ => None,
            })
            .collect::<String>()
    };
    assert!(
        text(0, eq(0)).ends_with(prefix),
        "complete prefix precedes first equation: {out:?}"
    );
    assert_eq!(text(eq(2) + 1, eq(3)), "이므로 ");
}

fn repair_content(core: &DocumentCore, phase: &str) {
    eprintln!("BODY REPAIR phase={phase}");
    let out = assert_current_target_coverage(core);
    repair_edited_content(&out, "");
    let e2 = out
        .content
        .iter()
        .position(|(_, v)| matches!(v, Content::Equation(2)))
        .unwrap();
    let e3 = out
        .content
        .iter()
        .position(|(_, v)| matches!(v, Content::Equation(3)))
        .unwrap();
    let prose: String = out.content[e2 + 1..e3]
        .iter()
        .filter_map(|(_, v)| match v {
            Content::Text(s) => Some(s.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(prose, "이므로 ", "{phase}");
}

#[test]
fn body_edits_before_after_and_other_section_preserve_notes_under_both_policies_and_lineages() {
    for policy in [
        FontMetricsPolicy::HancomWindows,
        FontMetricsPolicy::HcrDeclared,
    ] {
        for lineage in [false, true] {
            for location in 0..3 {
                let (bytes, section) = repair_body_fixture(lineage, location);
                let mut core = DocumentCore::from_bytes_with_font_metrics(&bytes, policy).unwrap();
                let before_profile = (
                    core.document().layout_profile().native_hwp5_layout(),
                    core.document().layout_profile().hwp3_layout(),
                );
                repair_content(&core, "before body edit");
                let original = host(&core)
                    .2
                    .line_segs
                    .iter()
                    .map(|s| s.text_start)
                    .collect::<Vec<_>>();
                assert_eq!(original, vec![0, 16]);
                let original_scripts = scripts(&core);
                assert!(cached_page_text(&core).contains("OTHER BODY"));
                let pi = core.document().sections[section]
                    .paragraphs
                    .iter()
                    .position(|p| p.text == "OTHER BODY")
                    .unwrap();
                core.insert_text_native(section, pi, 0, "BODY EDIT ")
                    .unwrap();
                for refresh in [false, true] {
                    let phase = format!(
                        "policy={policy:?} lineage={lineage} location={location} refresh={refresh}"
                    );
                    eprintln!("BODY REPAIR {phase}");
                    if refresh {
                        core.refresh_layout_native();
                    }
                    assert_eq!(
                        core.document().sections[section].paragraphs[pi].text,
                        "BODY EDIT OTHER BODY"
                    );
                    assert!(core.document().sections[section].raw_stream.is_none());
                    assert!(core.document().layout_profile().session_edited());
                    assert_eq!(
                        (
                            core.document().layout_profile().native_hwp5_layout(),
                            core.document().layout_profile().hwp3_layout()
                        ),
                        before_profile
                    );
                    assert_eq!(scripts(&core), original_scripts);
                    assert_eq!(target_raw_markers(host(&core).2), RAW_MARKERS);
                    assert_eq!(
                        host(&core)
                            .2
                            .line_segs
                            .iter()
                            .map(|s| s.text_start)
                            .collect::<Vec<_>>(),
                        original,
                        "untouched note retains its validated load cuts: {phase}"
                    );
                    assert!(cached_page_text(&core).contains("BODY EDIT OTHER BODY"));
                    repair_content(&core, &phase);
                }
                let bytes = core.export_hwpx_native().unwrap();
                let reopened = DocumentCore::from_bytes_with_font_metrics(&bytes, policy).unwrap();
                assert!(reopened
                    .document()
                    .sections
                    .iter()
                    .flat_map(|s| &s.paragraphs)
                    .any(|p| p.text == "BODY EDIT OTHER BODY"));
                assert_eq!(scripts(&reopened), original_scripts);
                repair_content(&reopened, "HWPX body edit reopen");
            }
        }
    }
}

#[test]
fn body_edit_then_note_edit_inverse_and_reinsert_use_new_rows_and_reopen() {
    for policy in [
        FontMetricsPolicy::HancomWindows,
        FontMetricsPolicy::HcrDeclared,
    ] {
        let (bytes, section) = repair_body_fixture(false, 1);
        let mut core = DocumentCore::from_bytes_with_font_metrics(&bytes, policy).unwrap();
        let pi = core.document().sections[section]
            .paragraphs
            .iter()
            .position(|p| p.text == "OTHER BODY")
            .unwrap();
        core.insert_text_native(section, pi, 0, "BODY EDIT ")
            .unwrap();
        let (host_pi, ci, p) = host(&core);
        let original = p.text.clone();
        let original_scripts = scripts(&core);
        let prefix = "LOCAL NOTE ".repeat(70);
        core.insert_text_in_footnote_native(0, host_pi, ci, TARGET, 0, &prefix)
            .unwrap();
        let inserted_rows = host(&core)
            .2
            .line_segs
            .iter()
            .map(|r| r.text_start)
            .collect::<Vec<_>>();
        assert!(inserted_rows.len() > 2);
        assert_ne!(inserted_rows, vec![0, 16]);
        for refresh in [false, true] {
            eprintln!("BODY REPAIR local insertion refresh={refresh}");
            if refresh {
                core.refresh_layout_native();
            }
            assert_eq!(host(&core).2.text, format!("{prefix}{original}"));
            assert!(cached_page_text(&core).contains(prefix.as_str()));
            assert_eq!(scripts(&core), original_scripts);
            repair_edited_content(&assert_current_target_coverage(&core), &prefix);
        }
        core.delete_text_in_footnote_native(0, host_pi, ci, TARGET, 0, prefix.chars().count())
            .unwrap();
        for refresh in [false, true] {
            eprintln!("BODY REPAIR local inverse refresh={refresh}");
            if refresh {
                core.refresh_layout_native();
            }
            assert_eq!(host(&core).2.text, original);
            assert!(!cached_page_text(&core).contains(prefix.as_str()));
            assert_eq!(scripts(&core), original_scripts);
            repair_content(&core, "local inverse");
        }
        core.insert_text_in_footnote_native(0, host_pi, ci, TARGET, 0, &prefix)
            .unwrap();
        repair_edited_content(&assert_current_target_coverage(&core), &prefix);
        let reopened =
            DocumentCore::from_bytes_with_font_metrics(&core.export_hwpx_native().unwrap(), policy)
                .unwrap();
        assert_eq!(host(&reopened).2.text, format!("{prefix}{original}"));
        assert_eq!(scripts(&reopened), original_scripts);
        repair_edited_content(&assert_current_target_coverage(&reopened), &prefix);
    }
}

#[test]
fn same_id_style_value_changes_reflow_without_losing_equations() {
    for policy in [
        FontMetricsPolicy::HancomWindows,
        FontMetricsPolicy::HcrDeclared,
    ] {
        let mut core = load(policy);
        let ids = (
            host(&core).2.para_shape_id,
            host(&core)
                .2
                .char_shapes
                .iter()
                .map(|s| s.char_shape_id)
                .collect::<Vec<_>>(),
        );
        let original_scripts = scripts(&core);
        let original = host(&core).2.text.clone();
        core.document_mut().doc_info.char_shapes[0].base_size = 3000;
        core.document_mut().doc_info.char_shapes[0].raw_data = None;
        core.document_mut().doc_info.para_shapes[0].margin_left = 12000;
        core.document_mut().doc_info.para_shapes[0].margin_right = 12000;
        core.document_mut().doc_info.para_shapes[0].raw_data = None;
        core.refresh_layout_native();
        assert_eq!(
            (
                host(&core).2.para_shape_id,
                host(&core)
                    .2
                    .char_shapes
                    .iter()
                    .map(|s| s.char_shape_id)
                    .collect::<Vec<_>>()
            ),
            ids
        );
        assert_eq!(host(&core).2.text, original);
        assert_ne!(
            host(&core)
                .2
                .line_segs
                .iter()
                .map(|s| s.text_start)
                .collect::<Vec<_>>(),
            vec![0, 16],
            "style values change row cuts without changing IDs"
        );
        assert_eq!(scripts(&core), original_scripts);
        repair_content(&core, "same IDs changed styles");
        core.refresh_layout_native();
        repair_content(&core, "same IDs changed styles repeated refresh");
        let reopened =
            DocumentCore::from_bytes_with_font_metrics(&core.export_hwpx_native().unwrap(), policy)
                .unwrap();
        assert_eq!(scripts(&reopened), original_scripts);
        repair_content(&reopened, "changed styles HWPX reopen");
    }
}

#[test]
fn narrower_page_and_columns_reflow_current_rows_and_keep_all_equations() {
    for policy in [
        FontMetricsPolicy::HancomWindows,
        FontMetricsPolicy::HcrDeclared,
    ] {
        for columns in [false, true] {
            let mut core = load(policy);
            let original_scripts = scripts(&core);
            if columns {
                let doc = core.document_mut();
                let mut column = rhwp::model::page::ColumnDef::default();
                column.column_count = 2;
                column.same_width = true;
                column.spacing = 1200;
                doc.sections[0].paragraphs[0]
                    .controls
                    .push(Control::ColumnDef(column));
                doc.sections[0].raw_stream = None;
                core.refresh_layout_native();
            } else {
                core.set_page_def_native(0, r#"{"width":14000}"#).unwrap();
            }
            assert_ne!(
                host(&core)
                    .2
                    .line_segs
                    .iter()
                    .map(|s| s.text_start)
                    .collect::<Vec<_>>(),
                vec![0, 16]
            );
            assert_eq!(scripts(&core), original_scripts);
            repair_content(&core, "new width/columns");
            core.refresh_layout_native();
            repair_content(&core, "new width/columns refreshed");
            let reopened = DocumentCore::from_bytes_with_font_metrics(
                &core.export_hwpx_native().unwrap(),
                policy,
            )
            .unwrap();
            assert_eq!(scripts(&reopened), original_scripts);
            repair_content(&reopened, "new width/columns HWPX reopen");
        }
    }
}

#[test]
fn moved_note_host_reflows_and_snapshot_restore_preserves_visible_identity() {
    let (bytes, section) = repair_body_fixture(false, 0);
    let mut core = DocumentCore::from_bytes(&bytes).unwrap();
    let snapshot = core.save_snapshot_native();
    core.restore_snapshot_native(snapshot).unwrap();
    repair_content(&core, "unchanged snapshot restore");
    let original = scripts(&core);
    let old_host = host(&core).0;
    // 문서 IR을 명시적으로 바꾸는 공개 진입점이다. 새 위치를 출처로 self-certify하지 않는다.
    core.document_mut().sections[section]
        .paragraphs
        .swap(old_host, old_host - 1);
    core.refresh_layout_native();
    assert_eq!(host(&core).0, old_host - 1);
    assert_eq!(scripts(&core), original);
    repair_content(&core, "moved host");
    core.restore_snapshot_native(snapshot).unwrap();
    assert_eq!(host(&core).0, old_host);
    assert_eq!(scripts(&core), original);
    repair_content(&core, "snapshot restore");
}

#[test]
fn two_equation_paragraphs_in_one_note_keep_complete_current_owners_after_local_edit() {
    fn check(core: &DocumentCore) {
        fn walk(
            node: &RenderNode,
            row: Option<u32>,
            owner: (usize, usize),
            out: &mut Vec<(usize, usize, u32)>,
        ) {
            let row = match &node.node_type {
                RenderNodeType::TextLine(line) => line.line_index,
                _ => row,
            };
            if let RenderNodeType::Equation(eq) = &node.node_type {
                let source = eq.note_ref.as_ref().unwrap();
                assert_eq!(source.kind, "endnote");
                assert_eq!(source.section_index, 0);
                assert_eq!((source.para_index, source.control_index), owner);
                assert!(node.visible && node.bbox.width > 0.0 && node.bbox.height > 0.0);
                assert!(
                    [node.bbox.x, node.bbox.y, node.bbox.width, node.bbox.height]
                        .iter()
                        .all(|v| v.is_finite())
                );
                assert!(!eq.svg_content.is_empty());
                out.push((
                    source.note_para_index,
                    source.inner_control_index,
                    row.unwrap(),
                ));
            }
            for child in &node.children {
                walk(child, row, owner, out);
            }
        }
        let (pi, ci, _) = host(core);
        let Control::Endnote(note) = &core.document().sections[0].paragraphs[pi].controls[ci]
        else {
            panic!("note")
        };
        let expected: Vec<_> = [TARGET, TARGET + 1]
            .into_iter()
            .flat_map(|ep| {
                let para = &note.paragraphs[ep];
                target_raw_markers(para)
                    .into_iter()
                    .enumerate()
                    .map(move |(ci, raw)| {
                        (
                            ep,
                            ci,
                            (para.line_segs.partition_point(|row| row.text_start <= raw) - 1)
                                as u32,
                        )
                    })
            })
            .collect();
        let mut actual = Vec::new();
        for page in 0..core.page_count() {
            walk(
                &core.build_page_render_tree(page).unwrap().root,
                None,
                (pi, ci),
                &mut actual,
            );
        }
        assert_eq!(
            actual, expected,
            "both paragraphs retain ordered all-page source identity"
        );
    }
    let mut core = load(FontMetricsPolicy::HancomWindows);
    let (pi, ci, para) = host(&core);
    let duplicate = para.clone();
    let Control::Endnote(note) = &mut core.document_mut().sections[0].paragraphs[pi].controls[ci]
    else {
        panic!("note")
    };
    note.paragraphs.insert(TARGET + 1, duplicate);
    core.refresh_layout_native();
    check(&core);
    core.insert_text_in_footnote_native(0, pi, ci, TARGET, 0, &"LOCAL ".repeat(100))
        .unwrap();
    check(&core);
    core.refresh_layout_native();
    check(&core);
    let reopened = DocumentCore::from_bytes(&core.export_hwpx_native().unwrap()).unwrap();
    check(&reopened);
}

#[test]
fn unrelated_body_edit_keeps_control_owners_when_note_spacing_is_projected() {
    for policy in [
        FontMetricsPolicy::HancomWindows,
        FontMetricsPolicy::HcrDeclared,
    ] {
        let (bytes, section) = repair_body_fixture(false, 1);
        let mut fixture = DocumentCore::from_bytes_with_font_metrics(&bytes, policy).unwrap();
        {
            let doc = fixture.document_mut();
            let sd = &mut doc.sections[0].section_def;
            sd.endnote_shape.separator_line_type = 0;
            sd.endnote_shape.separator_line_width = 0;
            sd.endnote_shape.separator_length = 0;
            sd.endnote_shape.note_spacing = 0;
            sd.endnote_shape.raw_unknown = 0;
            let updated = sd.clone();
            for para in &mut doc.sections[0].paragraphs {
                for control in &mut para.controls {
                    if let Control::SectionDef(sd) = control {
                        **sd = updated.clone();
                    }
                }
            }
            // fixture 자체를 직렬화한다. 편집 세션의 passthrough를 되살리지 않는다.
            doc.sections[0].raw_stream = None;
        }
        let owned_cfb = fixture.export_hwp_native().unwrap();
        let mut core = DocumentCore::from_bytes_with_font_metrics(&owned_cfb, policy).unwrap();
        repair_content(&core, "separator-free loaded note");
        let expected = scripts(&core);
        let pi = core.document().sections[section]
            .paragraphs
            .iter()
            .position(|p| p.text == "OTHER BODY")
            .unwrap();
        core.insert_text_native(section, pi, 0, "BODY EDIT ")
            .unwrap();
        for refresh in [false, true] {
            eprintln!("BODY REPAIR separator-free refresh={refresh}");
            if refresh {
                core.refresh_layout_native();
            }
            assert_eq!(scripts(&core), expected);
            assert!(cached_page_text(&core).contains("BODY EDIT OTHER BODY"));
            repair_content(&core, "spacing projection after body edit");
        }
    }
}

// v2: 실제 24000/14000 HU 단의 넓은 쪽과 좁은 쪽을 각각 통과한다.
// 파서 IR로 fixture를 작성하고 CFB로 내보낸 뒤 새 core에서만 출처를 얻는다.
fn unequal_column_fixture(narrow: bool) -> Vec<u8> {
    use rhwp::model::paragraph::ColumnBreakType;

    let (bytes, _) = repair_body_fixture(false, 1);
    let mut doc = rhwp::parser::parse_hwp(&bytes).unwrap();
    for ps in &mut doc.doc_info.para_shapes {
        ps.raw_data = None;
        ps.margin_left = 0;
        ps.margin_right = 0;
        ps.indent = 0;
    }
    let section = &mut doc.sections[0];
    let pd = &mut section.section_def.page_def;
    pd.width = 39200;
    pd.height = 90000;
    pd.landscape = false;
    pd.margin_left = 0;
    pd.margin_right = 0;
    pd.margin_top = 0;
    pd.margin_bottom = 0;
    pd.margin_header = 0;
    pd.margin_footer = 0;
    let definition = section.section_def.clone();
    assert_eq!(definition.endnote_shape.separator_line_type, 1);
    assert_eq!(definition.endnote_shape.separator_line_width, 1);
    assert_eq!(definition.endnote_shape.separator_length, 4000);
    let chosen_width = if narrow { 14000 } else { 24000 };
    for (pi, para) in section.paragraphs.iter_mut().enumerate() {
        let has_note = para
            .controls
            .iter()
            .any(|c| matches!(c, Control::Endnote(_)));
        if has_note && narrow {
            para.column_type = ColumnBreakType::Column;
            para.raw_break_type = 0;
        }
        for seg in &mut para.line_segs {
            seg.segment_width = if pi == 0 { 24000 } else { chosen_width };
            // 단 머리의 본문 좌표. 미주 자체의 원래 누적 좌표는 아래에서 보존한다.
            if has_note {
                seg.vertical_pos = 0;
            }
        }
        for control in &mut para.controls {
            match control {
                Control::SectionDef(sd) => **sd = definition.clone(),
                Control::Endnote(note) => {
                    for (ep, p) in note.paragraphs.iter_mut().enumerate() {
                        for seg in &mut p.line_segs {
                            seg.segment_width = if ep == TARGET { 24000 } else { chosen_width };
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let mut columns = rhwp::model::page::ColumnDef::default();
    columns.column_count = 2;
    columns.same_width = false;
    // 합계가 용지 폭과 같아서 CFB의 비례값도 정확히 이 HU 너비가 된다.
    columns.widths = vec![24000, 14000];
    columns.gaps = vec![1200, 0];
    columns.spacing = 1200;
    section.paragraphs[0]
        .controls
        .push(Control::ColumnDef(columns));
    section.raw_stream = None;
    rhwp::serializer::serialize_hwp(&doc).unwrap()
}

fn unequal_column_shape(doc: &rhwp::model::document::Document) -> [f64; 2] {
    let section = &doc.sections[0];
    let columns: Vec<_> = section
        .paragraphs
        .iter()
        .flat_map(|p| &p.controls)
        .filter_map(|c| {
            if let Control::ColumnDef(cd) = c {
                Some(cd)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(
        columns.len(),
        1,
        "fixture has one effective column definition"
    );
    let cd = columns[0];
    assert_eq!(cd.column_count, 2);
    assert!(
        !cd.same_width,
        "equal columns cannot exercise the stored-width filter"
    );
    assert_eq!(cd.widths, vec![24000, 14000]);
    assert_eq!(cd.gaps, vec![1200, 0]);
    let layout = rhwp::renderer::page_layout::PageLayoutInfo::from_page_def(
        &section.section_def.page_def,
        cd,
        rhwp::renderer::DEFAULT_DPI,
    );
    assert_eq!(layout.column_areas.len(), 2);
    let widths = [layout.column_areas[0].width, layout.column_areas[1].width];
    for (actual, hu) in widths.iter().zip([24000, 14000]) {
        assert!((actual * 7200.0 / layout.dpi - hu as f64).abs() < 1e-6);
    }
    assert!((widths[0] - widths[1]) * 7200.0 / layout.dpi > 1000.0);
    for ps in &doc.doc_info.para_shapes {
        assert_eq!((ps.margin_left, ps.margin_right, ps.indent), (0, 0, 0));
    }
    widths
}

fn unequal_column_paint(core: &DocumentCore, narrow: bool, phase: &str, prefix: &str) {
    eprintln!("UNEQUAL COLUMN narrow={narrow} phase={phase}");
    let widths = unequal_column_shape(core.document());
    let selected = usize::from(narrow);
    let expected_width = widths[selected];
    let p = host(core).2;
    // 현재 줄의 너비와 실제 넓은 단의 너비 차이가 기존 skip 분기를 선택해야 한다.
    assert!(p.line_segs.iter().all(|s| s.segment_width == 14000));
    if !narrow {
        assert!((expected_width * 7200.0 / rhwp::renderer::DEFAULT_DPI - 14000.0).abs() > 200.0);
    }
    let out = assert_current_target_coverage(core);
    repair_edited_content(&out, prefix);
    assert_eq!(scripts(core), SCRIPTS.map(|s| s.as_bytes().to_vec()));

    struct Placement {
        equations: Vec<(usize, usize)>,
        note_text: Vec<(usize, usize)>,
        labels: [bool; 3],
    }
    fn walk(
        node: &RenderNode,
        column: Option<(u16, BoundingBox)>,
        page: usize,
        owner: (usize, usize),
        selected: usize,
        width: f64,
        out: &mut Placement,
    ) {
        let column = match &node.node_type {
            RenderNodeType::Column(index) => Some((*index, node.bbox)),
            _ => column,
        };
        let is_target = if let RenderNodeType::Equation(eq) = &node.node_type {
            let source = eq.note_ref.as_ref().expect("actual painted note source");
            assert_eq!(source.kind, "endnote");
            assert_eq!(source.section_index, 0);
            assert_eq!((source.para_index, source.control_index), owner);
            assert_eq!(source.note_para_index, TARGET);
            out.equations.push((source.inner_control_index, page));
            true
        } else if let RenderNodeType::TextRun(run) = &node.node_type {
            let mut found = false;
            for (i, label) in ["HEAD", "CONTEXT", "AFTER"].iter().enumerate() {
                if run.text.contains(label) {
                    out.labels[i] = true;
                    out.note_text.push((i, page));
                    found = true;
                }
            }
            found
        } else {
            false
        };
        if is_target {
            let (index, frame) = column.expect("painted note must have an actual Column ancestor");
            assert_eq!(index as usize, selected, "selected column placement guard");
            assert!(
                (frame.width - width).abs() < 1e-6,
                "actual column frame width"
            );
            assert!(node.visible && node.bbox.width > 0.0 && node.bbox.height > 0.0);
            assert!(
                [node.bbox.x, node.bbox.y, node.bbox.width, node.bbox.height]
                    .iter()
                    .all(|v| v.is_finite())
            );
            assert!(node.bbox.x >= frame.x - 1e-6);
            assert!(node.bbox.x + node.bbox.width <= frame.x + frame.width + 1e-6);
            assert!(node.bbox.y >= frame.y - 1e-6);
            assert!(node.bbox.y + node.bbox.height <= frame.y + frame.height + 1e-6);
        }
        for child in &node.children {
            walk(child, column, page, owner, selected, width, out);
        }
    }
    let mut placement = Placement {
        equations: Vec::new(),
        note_text: Vec::new(),
        labels: [false; 3],
    };
    let (pi, ci, _) = host(core);
    for page in 0..core.page_count() {
        walk(
            &core.build_page_render_tree(page).unwrap().root,
            None,
            page,
            (pi, ci),
            selected,
            expected_width,
            &mut placement,
        );
    }
    assert_eq!(
        placement
            .equations
            .iter()
            .map(|(ci, _)| *ci)
            .collect::<Vec<_>>(),
        vec![0, 1, 2, 3]
    );
    assert_eq!(
        placement.labels, [true; 3],
        "the whole short note is painted"
    );
    let page = placement.equations[0].1;
    assert!(placement.equations.iter().all(|(_, p)| *p == page));
    assert!(placement.note_text.iter().all(|(_, p)| *p == page));
}

#[test]
fn unequal_columns_keep_current_note_rows_in_wide_and_narrow_frames_after_edits_and_reopen() {
    for policy in [
        FontMetricsPolicy::HancomWindows,
        FontMetricsPolicy::HcrDeclared,
    ] {
        for narrow in [false, true] {
            let bytes = unequal_column_fixture(narrow);
            // core 준비 전 실제 저장 줄과 비대칭 다단 CFB를 따로 파싱한다.
            let parsed = rhwp::parser::parse_hwp(&bytes).unwrap();
            unequal_column_shape(&parsed);
            let source = parsed.sections[0]
                .paragraphs
                .iter()
                .flat_map(|p| &p.controls)
                .find_map(|c| {
                    if let Control::Endnote(note) = c {
                        Some(&note.paragraphs[TARGET])
                    } else {
                        None
                    }
                })
                .unwrap();
            assert_eq!(
                source
                    .line_segs
                    .iter()
                    .map(|s| s.text_start)
                    .collect::<Vec<_>>(),
                vec![0, 16]
            );
            assert!(source.line_segs.iter().all(|s| s.segment_width == 24000));
            assert_eq!(target_raw_markers(source), RAW_MARKERS);
            let sd = &parsed.sections[0].section_def.endnote_shape;
            assert_eq!(
                (
                    sd.separator_line_type,
                    sd.separator_line_width,
                    sd.separator_length
                ),
                (1, 1, 4000)
            );

            let mut core = DocumentCore::from_bytes_with_font_metrics(&bytes, policy).unwrap();
            unequal_column_paint(&core, narrow, "initial load", "");
            let other = core.document().sections[0]
                .paragraphs
                .iter()
                .position(|p| p.text == "OTHER BODY")
                .unwrap();
            assert!(cached_page_text(&core).contains("OTHER BODY"));
            core.insert_text_native(0, other, 0, "BODY EDIT ").unwrap();
            for refresh in [false, true] {
                if refresh {
                    core.refresh_layout_native();
                }
                assert_eq!(
                    core.document().sections[0].paragraphs[other].text,
                    "BODY EDIT OTHER BODY"
                );
                assert!(cached_page_text(&core).contains("BODY EDIT OTHER BODY"));
                unequal_column_paint(&core, narrow, "unrelated BODY edit / refresh", "");
            }
            let reopened = DocumentCore::from_bytes_with_font_metrics(
                &core.export_hwpx_native().unwrap(),
                policy,
            )
            .unwrap();
            unequal_column_paint(&reopened, narrow, "BODY edit HWPX reopen", "");

            let (pi, ci, _) = host(&core);
            let prefix = "LOCAL NOTE ".repeat(4);
            core.insert_text_in_footnote_native(0, pi, ci, TARGET, 0, &prefix)
                .unwrap();
            assert_eq!(
                target_raw_markers(host(&core).2),
                RAW_MARKERS.map(|r| r + prefix.encode_utf16().count() as u32)
            );
            for refresh in [false, true] {
                if refresh {
                    core.refresh_layout_native();
                }
                assert!(cached_page_text(&core).contains(prefix.as_str()));
                unequal_column_paint(&core, narrow, "local note edit / refresh", &prefix);
            }
            let reopened = DocumentCore::from_bytes_with_font_metrics(
                &core.export_hwpx_native().unwrap(),
                policy,
            )
            .unwrap();
            assert_eq!(host(&reopened).2.text, host(&core).2.text);
            unequal_column_paint(&reopened, narrow, "local note HWPX reopen", &prefix);
        }
    }
}

//! 편집 명령 정합성 회귀 테스트.
//!
//! HWPX 컨트롤 삽입 panic, 스냅샷 복원의 문단 재사용 오판, 인라인 개체 삭제 뒤 글자
//! 모양 어긋남, HWP3 변형 보정 누락, 글자 모양 undo 의 vpos 잔류, 셀·구역 범위 삭제의
//! 끝점 검증을 고정한다.

use crate::document_core::DocumentCore;
use crate::model::control::Control;

/// 1x1 투명 PNG.
const TINY_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x62, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

fn load(rel: &str) -> DocumentCore {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    DocumentCore::from_bytes(&bytes).unwrap_or_else(|e| panic!("load {rel}: {e:?}"))
}

fn blank_with(texts: &[&str]) -> DocumentCore {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().unwrap();
    for (i, text) in texts.iter().enumerate() {
        if i > 0 {
            let prev_len = texts[i - 1].chars().count();
            core.split_paragraph_native(0, i - 1, prev_len, None)
                .unwrap();
        }
        core.insert_text_native(0, i, 0, text).unwrap();
    }
    core
}

fn texts(core: &DocumentCore) -> Vec<String> {
    core.document.sections[0]
        .paragraphs
        .iter()
        .map(|p| p.text.clone())
        .collect()
}

fn insert_inline_picture(core: &mut DocumentCore, para: usize, offset: usize) -> usize {
    let json = core
        .insert_picture_with_placement_native(
            0,
            para,
            offset,
            &[],
            TINY_PNG,
            3000,
            3000,
            1,
            1,
            "png",
            "",
            None,
            None,
            true,
        )
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    value["controlIdx"].as_u64().unwrap() as usize
}

fn picture_paragraphs(core: &DocumentCore) -> Vec<usize> {
    core.document.sections[0]
        .paragraphs
        .iter()
        .enumerate()
        .flat_map(|(i, p)| {
            p.controls
                .iter()
                .filter(|c| matches!(c, Control::Picture(_)))
                .map(move |_| i)
        })
        .collect()
}

fn shape_runs(para: &crate::model::paragraph::Paragraph) -> Vec<(u32, u32)> {
    para.char_shapes
        .iter()
        .map(|cs| (cs.start_pos, cs.char_shape_id))
        .collect()
}

fn section_vpos(core: &DocumentCore) -> Vec<Vec<i32>> {
    core.document.sections[0]
        .paragraphs
        .iter()
        .map(|p| p.line_segs.iter().map(|seg| seg.vertical_pos).collect())
        .collect()
}

/// HWPX 파서는 ctrl_data_records 를 채우지 않는다. 구역 정의가 있는 첫 문단에 개체를
/// 넣어도 panic 없이 controls 와 같은 길이로 맞춰야 한다.
#[test]
fn inserting_controls_into_hwpx_paragraph_keeps_ctrl_data_records_aligned() {
    let mut core = load("saved/blank_hwpx.hwpx");
    let para = &core.document.sections[0].paragraphs[0];
    assert!(para.controls.len() > para.ctrl_data_records.len());
    let end = para.text.chars().count();

    core.insert_footnote_native(0, 0, end).unwrap();
    core.insert_endnote_native(0, 0, end).unwrap();
    core.insert_new_number_native(0, 0, end, 1).unwrap();
    core.create_shape_control_native(
        0,
        0,
        end,
        3000,
        3000,
        0,
        0,
        true,
        "Square",
        "rectangle",
        false,
        false,
        &[],
    )
    .unwrap();

    let para = &core.document.sections[0].paragraphs[0];
    assert_eq!(para.ctrl_data_records.len(), para.controls.len());
}

/// 문단 수를 바꾸는 여러 문단 삭제가 순서 revision 을 올리지 않으면, 스냅샷 캡처가
/// 밀린 인덱스의 이전 스냅샷 문단을 공유해 복원 시 다른 문단이 들어온다.
#[test]
fn snapshot_restore_after_multi_paragraph_delete_keeps_paragraph_identity() {
    let mut core = blank_with(&["AAA", "BBB", "CCC", "DDD", "EEE"]);
    let s0 = core.save_snapshot_native();
    core.delete_range_native(0, 1, 3, 2, 0, None).unwrap();
    core.save_snapshot_native();
    core.restore_snapshot_native(s0).unwrap();
    core.delete_range_native(0, 3, 3, 4, 0, None).unwrap();
    let s_q = core.save_snapshot_native();
    core.restore_snapshot_native(s0).unwrap();
    core.restore_snapshot_native(s_q).unwrap();
    assert_eq!(texts(&core), ["AAA", "BBB", "CCC", "DDDEEE"]);
}

/// 표 삽입(문단 +3)과 여러 문단 삭제(-3)로 문단 수가 같아져도 원래 문단으로 복원해야 한다.
#[test]
fn snapshot_restore_after_table_insert_and_delete_restores_original_paragraphs() {
    let original = ["P0", "P1", "P2", "P3", "P4", "P5", "P6"];
    let mut core = blank_with(&original);
    let s0 = core.save_snapshot_native();
    core.create_table_native(0, 1, 1, 1, 1).unwrap();
    assert_eq!(core.document.sections[0].paragraphs.len(), 10);
    core.delete_range_native(0, 5, 0, 8, 0, None).unwrap();
    assert_eq!(core.document.sections[0].paragraphs.len(), 7);
    core.restore_snapshot_native(s0).unwrap();
    assert_eq!(texts(&core), original);
}

/// 다른 문단으로 옮긴 그림은 복원 뒤 원래 문단에 한 개만 있어야 한다.
#[test]
fn snapshot_restore_after_picture_move_keeps_the_picture() {
    let mut core = blank_with(&["AAAA", "BBBB", "CCCC"]);
    let ci = insert_inline_picture(&mut core, 1, 2);
    let s0 = core.save_snapshot_native();
    core.move_picture_control_native(0, 1, ci, 2, 0).unwrap();
    assert_eq!(picture_paragraphs(&core), [2]);
    core.restore_snapshot_native(s0).unwrap();
    assert_eq!(picture_paragraphs(&core), [1]);
}

/// 이벤트를 쌓지 않는 문단 IR 편집(감추기·다단)도 스냅샷 복원으로 되돌아가야 한다.
#[test]
fn snapshot_restore_reverts_page_hide_and_column_def() {
    let mut core = blank_with(&["AAAA"]);
    let columns_before =
        DocumentCore::find_initial_column_def(&core.document.sections[0].paragraphs).column_count;
    let s0 = core.save_snapshot_native();
    core.set_page_hide_native(0, 0, false, false, false, false, false, true)
        .unwrap();
    core.set_column_def_native(0, 2, 0, true, 0).unwrap();
    core.restore_snapshot_native(s0).unwrap();

    assert!(core
        .get_page_hide_native(0, 0)
        .unwrap()
        .contains("\"exists\":false"));
    let columns_after =
        DocumentCore::find_initial_column_def(&core.document.sections[0].paragraphs).column_count;
    assert_eq!(columns_after, columns_before);
}

/// 인라인 개체를 넣었다 지우면 글자 모양 구간도 넣기 전 위치로 돌아와야 한다.
#[test]
fn deleting_inline_objects_shifts_char_shapes_back() {
    let mut core = blank_with(&["ABCDEFGH"]);
    core.apply_char_format_native(0, 0, 4, 8, r#"{"bold":true}"#)
        .unwrap();
    let before = core.document.sections[0].paragraphs[0].clone();

    let ci = insert_inline_picture(&mut core, 0, 2);
    core.delete_picture_control_native(0, 0, ci).unwrap();
    let para = &core.document.sections[0].paragraphs[0];
    assert_eq!(para.char_offsets, before.char_offsets);
    assert_eq!(shape_runs(para), shape_runs(&before));

    let json = core
        .create_shape_control_native(
            0,
            0,
            2,
            3000,
            3000,
            0,
            0,
            true,
            "Square",
            "rectangle",
            false,
            false,
            &[],
        )
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    let ci = value["controlIdx"].as_u64().unwrap() as usize;
    core.delete_shape_control_native(0, 0, ci).unwrap();
    let para = &core.document.sections[0].paragraphs[0];
    assert_eq!(para.char_offsets, before.char_offsets);
    assert_eq!(shape_runs(para), shape_runs(&before));
}

/// 편집 뒤 스타일 재해소가 HWP3 변형 보정을 잃으면 글자 하나 굵게로 쪽 수가 바뀐다.
#[test]
fn hwp3_variant_page_count_survives_char_format_round_trip() {
    let mut core = load("samples/hwp3-sample16-hwp5.hwp");
    assert!(core.document.layout_profile().hwp3_layout());
    let pages = core.page_count();
    let para = core.document.sections[0]
        .paragraphs
        .iter()
        .position(|p| !p.text.is_empty())
        .unwrap();

    core.apply_char_format_native(0, para, 0, 1, r#"{"bold":true}"#)
        .unwrap();
    assert_eq!(core.page_count(), pages);
    core.apply_char_format_native(0, para, 0, 1, r#"{"bold":false}"#)
        .unwrap();
    assert_eq!(core.page_count(), pages);
}

/// 글자 모양 undo(구간 복원·ID 복원)는 정방향과 같은 흐름 재계산을 거쳐 뒤 문단 vpos 까지
/// 편집 전으로 돌려야 한다.
#[test]
fn char_shape_undo_restores_following_paragraph_positions() {
    let long = "가나다라마바사아자차카타파하 ".repeat(12);
    let mut core = blank_with(&[&long, &long, &long, &long]);
    let len = long.chars().count();
    let original = section_vpos(&core);
    let runs = core.get_char_shape_runs_native(0, 1, 0, len).unwrap();
    let shape_id = core.document.sections[0].paragraphs[1].char_shapes[0].char_shape_id;

    core.apply_char_format_native(0, 1, 0, len, r#"{"fontSize":2000}"#)
        .unwrap();
    assert_ne!(section_vpos(&core), original);
    core.set_char_shape_runs_native(0, 1, 0, len, &runs)
        .unwrap();
    assert_eq!(section_vpos(&core), original);

    core.apply_char_format_native(0, 1, 0, len, r#"{"fontSize":2000}"#)
        .unwrap();
    core.set_char_shape_id_native(0, 1, 0, len, shape_id)
        .unwrap();
    assert_eq!(section_vpos(&core), original);
}

/// 셀·구역 범위 삭제는 끝점이 틀리면 아무것도 바꾸지 않고 Err 를 낸다.
#[test]
fn range_deletes_reject_bad_endpoints_without_mutating() {
    let mut core = blank_with(&["AB"]);
    // 빈 범위 + 없는 부모 문단: 셀을 해석하지 않던 경로의 panic.
    assert!(core
        .delete_range_native(0, 0, 0, 0, 0, Some((99, 0, 0)))
        .is_err());

    core.create_table_native(0, 0, 2, 1, 1).unwrap();
    let (host, ctrl) = core.document.sections[0]
        .paragraphs
        .iter()
        .enumerate()
        .find_map(|(pi, p)| {
            p.controls
                .iter()
                .position(|c| matches!(c, Control::Table(_)))
                .map(|ci| (pi, ci))
        })
        .unwrap();
    let path = [(ctrl, 0, 0)];
    {
        let paras = core
            .get_cell_paragraphs_mut_by_path(0, host, &path)
            .unwrap();
        let template = paras[0].clone();
        paras.clear();
        for text in ["P0", "P1", "P2", "P3"] {
            let mut para = template.clone();
            para.text = text.to_string();
            para.char_offsets = (0..text.len() as u32).collect();
            para.char_count = text.len() as u32 + 1;
            paras.push(para);
        }
    }
    let cell_texts = |core: &mut DocumentCore| -> Vec<String> {
        core.get_cell_paragraphs_mut_by_path(0, host, &path)
            .unwrap()
            .iter()
            .map(|p| p.text.clone())
            .collect()
    };
    let before = cell_texts(&mut core);
    assert!(core
        .delete_range_in_cell_by_path(0, host, &path, 2, 1, 0, 1)
        .is_err());
    assert!(core
        .delete_range_in_cell_by_path(0, host, &path, 0, 1, 99, 0)
        .is_err());
    assert!(core
        .delete_range_native(0, 0, 1, 99, 0, Some((host, ctrl, 0)))
        .is_err());
    assert_eq!(cell_texts(&mut core), before);

    // 구역을 넘는 캐럿 삭제: 끝 구역이 없으면 시작 문단의 그림을 지우기 전에 거절한다.
    let mut core = blank_with(&["AB"]);
    insert_inline_picture(&mut core, 0, 1);
    assert!(core
        .delete_caret_range_across_sections_native(0, 0, 0, 1, 0, 0)
        .is_err());
    assert_eq!(picture_paragraphs(&core), [0]);
}

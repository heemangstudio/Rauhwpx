//! 편집 명령 정합성 회귀 테스트.
//!
//! HWPX 컨트롤 삽입 panic, 스냅샷 복원의 문단 재사용 오판, 인라인 개체 삭제 뒤 글자
//! 모양 어긋남, HWP3 변형 보정 누락, 글자 모양 undo 의 vpos 잔류, 셀·구역 범위 삭제의
//! 끝점 검증, 캡션·글상자 셀 컨테이너 편집, 이벤트 없는 편집의 revision 표시, 병합 표
//! 계산식, 문단 머리 컨트롤의 텍스트 자리, 미주 모양 저장을 고정한다.

use crate::document_core::DocumentCore;
use crate::model::control::{Control, FormObject};
use crate::model::paragraph::Paragraph;
use crate::model::shape::Caption;

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

// ─── 셀 컨테이너·치환·필드·계산식·문단 머리 컨트롤·미주 모양 ─────────────

/// 표 캡션을 가리키는 셀 센티널 (Studio 캡션 편집과 같은 값).
const CAPTION: usize = 65534;

fn find_control(core: &DocumentCore, pred: impl Fn(&Control) -> bool) -> (usize, usize) {
    core.document.sections[0]
        .paragraphs
        .iter()
        .enumerate()
        .find_map(|(pi, p)| p.controls.iter().position(&pred).map(|ci| (pi, ci)))
        .unwrap()
}

fn insert_table(core: &mut DocumentCore, rows: u16, cols: u16) -> (usize, usize) {
    core.create_table_native(0, 0, 2, rows, cols).unwrap();
    find_control(core, |c| matches!(c, Control::Table(_)))
}

/// 템플릿 문단의 서식으로 텍스트만 담은 문단들을 만든다.
fn text_paragraphs(template: &Paragraph, texts: &[&str]) -> Vec<Paragraph> {
    texts
        .iter()
        .map(|text| {
            let mut para = template.clone();
            para.controls.clear();
            para.ctrl_data_records.clear();
            para.field_ranges.clear();
            para.text = text.to_string();
            para.char_offsets = (0..text.chars().count() as u32).collect();
            para.char_count = text.chars().count() as u32 + 1;
            para
        })
        .collect()
}

fn cell_template(core: &mut DocumentCore, host: usize, ctrl: usize) -> Paragraph {
    core.cell_container_paragraphs_mut(0, host, ctrl, 0)
        .unwrap()[0]
        .clone()
}

fn container_texts(core: &mut DocumentCore, host: usize, ctrl: usize, cell: usize) -> Vec<String> {
    core.cell_container_paragraphs_mut(0, host, ctrl, cell)
        .unwrap()
        .iter()
        .map(|p| p.text.clone())
        .collect()
}

fn add_table_caption(core: &mut DocumentCore, host: usize, ctrl: usize, texts: &[&str]) {
    let paragraphs = text_paragraphs(&cell_template(core, host, ctrl), texts);
    match &mut core.document.sections[0].paragraphs[host].controls[ctrl] {
        Control::Table(table) => {
            table.caption = Some(Caption {
                width: 20000,
                max_width: 20000,
                paragraphs,
                ..Default::default()
            });
        }
        _ => unreachable!(),
    }
}

/// 표 캡션(셀 65534)에서 Enter·Backspace 는 캡션 문단을 나누고 합친다. 표 셀만 아는
/// 경로가 `cells[65534]` 를 읽으면 panic 이고, wasm 에서는 문서 인스턴스가 멈춘다.
#[test]
fn table_caption_split_and_merge_keep_text() {
    let mut core = blank_with(&["AB"]);
    let (host, ctrl) = insert_table(&mut core, 1, 1);
    add_table_caption(&mut core, host, ctrl, &["CAPTION"]);

    core.split_paragraph_in_cell_native(0, host, ctrl, CAPTION, 0, 3, None)
        .unwrap();
    assert_eq!(
        container_texts(&mut core, host, ctrl, CAPTION),
        ["CAP", "TION"]
    );

    core.merge_paragraph_in_cell_native(0, host, ctrl, CAPTION, 1)
        .unwrap();
    assert_eq!(container_texts(&mut core, host, ctrl, CAPTION), ["CAPTION"]);
}

/// 표 캡션·글상자·그림 캡션의 여러 문단 삭제는 양 끝 문단을 합친다. 중간 단계가 표
/// 셀 전용 접근자로 Err 를 내면 양 끝만 잘린 채 합쳐지지 않고 남는다.
#[test]
fn multi_paragraph_delete_merges_endpoints_in_every_cell_container() {
    // 표 캡션: 가운데 문단까지 지운다. 끝점이 틀리면 아무것도 바꾸지 않는다.
    let mut core = blank_with(&["AB"]);
    let (host, ctrl) = insert_table(&mut core, 1, 1);
    add_table_caption(&mut core, host, ctrl, &["CAP0", "MID", "CAP1"]);
    let before = container_texts(&mut core, host, ctrl, CAPTION);
    assert!(core
        .delete_range_native(0, 0, 1, 9, 0, Some((host, ctrl, CAPTION)))
        .is_err());
    assert_eq!(container_texts(&mut core, host, ctrl, CAPTION), before);
    core.delete_range_native(0, 0, 2, 2, 2, Some((host, ctrl, CAPTION)))
        .unwrap();
    assert_eq!(container_texts(&mut core, host, ctrl, CAPTION), ["CAP1"]);

    // 글상자 (셀 0).
    let mut core = blank_with(&["AB"]);
    let (host, ctrl) = insert_table(&mut core, 1, 1);
    let template = cell_template(&mut core, host, ctrl);
    let json = core
        .create_shape_control_native(
            0,
            0,
            0,
            12000,
            6000,
            0,
            0,
            false,
            "Square",
            "textbox",
            false,
            false,
            &[],
        )
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    let tb_para = value["paraIdx"].as_u64().unwrap() as usize;
    let tb_ctrl = value["controlIdx"].as_u64().unwrap() as usize;
    *core
        .cell_container_paragraphs_mut(0, tb_para, tb_ctrl, 0)
        .unwrap() = text_paragraphs(&template, &["TB0", "TB1"]);
    core.delete_range_native(0, 0, 2, 1, 2, Some((tb_para, tb_ctrl, 0)))
        .unwrap();
    assert_eq!(container_texts(&mut core, tb_para, tb_ctrl, 0), ["TB1"]);

    // 그림 캡션.
    let mut core = blank_with(&["AB"]);
    let (host, ctrl) = insert_table(&mut core, 1, 1);
    let template = cell_template(&mut core, host, ctrl);
    let (pic_para, pic_ctrl) = {
        insert_inline_picture(&mut core, 0, 1);
        find_control(&core, |c| matches!(c, Control::Picture(_)))
    };
    match &mut core.document.sections[0].paragraphs[pic_para].controls[pic_ctrl] {
        Control::Picture(pic) => {
            pic.caption = Some(Caption {
                paragraphs: text_paragraphs(&template, &["PIC0", "PIC1"]),
                ..Default::default()
            });
        }
        _ => unreachable!(),
    }
    core.delete_range_native(0, 0, 2, 1, 2, Some((pic_para, pic_ctrl, 0)))
        .unwrap();
    assert_eq!(container_texts(&mut core, pic_para, pic_ctrl, 0), ["PIC1"]);
}

/// 모두 바꾸기는 문단 revision 을 올려야 스냅샷 복원(undo)으로 되돌아간다.
#[test]
fn replace_all_reverts_through_snapshot_restore() {
    let mut core = blank_with(&["hello world", "say hello"]);
    let s0 = core.save_snapshot_native();
    let result = core.replace_all_native("hello", "bye", true).unwrap();
    assert!(result.contains("\"count\":2"), "{result}");
    assert_eq!(texts(&core), ["bye world", "say bye"]);
    core.restore_snapshot_native(s0).unwrap();
    assert_eq!(texts(&core), ["hello world", "say hello"]);

    let mut core = blank_with(&["AB"]);
    let (host, ctrl) = insert_table(&mut core, 1, 1);
    core.insert_text_in_cell_native(0, host, ctrl, 0, 0, 0, "hello cell")
        .unwrap();
    let s0 = core.save_snapshot_native();
    core.replace_all_native("hello", "bye", true).unwrap();
    assert_eq!(container_texts(&mut core, host, ctrl, 0), ["bye cell"]);
    core.restore_snapshot_native(s0).unwrap();
    assert_eq!(container_texts(&mut core, host, ctrl, 0), ["hello cell"]);
}

/// 겹치는 매치("aaa" 의 "aa" 두 개)를 둘 다 바꾸면 원문 글자가 하나 더 사라진다.
#[test]
fn replace_all_skips_overlapping_matches() {
    let mut core = blank_with(&["aaa", "aaaa"]);
    let result = core.replace_all_native("aa", "b", true).unwrap();
    assert!(result.contains("\"count\":3"), "{result}");
    assert_eq!(texts(&core), ["ba", "bb"]);
}

/// 모두 바꾸기로 길어진 셀 문단은 셀 폭으로 다시 줄을 나눈다.
#[test]
fn replace_all_reflows_cell_paragraphs() {
    let mut core = blank_with(&["AB"]);
    let (host, ctrl) = insert_table(&mut core, 1, 8);
    core.insert_text_in_cell_native(0, host, ctrl, 0, 0, 0, "x")
        .unwrap();
    let long = "가나다라마바사아자차카타파하".repeat(3);
    core.replace_all_native("x", &long, true).unwrap();
    let paras = core
        .cell_container_paragraphs_mut(0, host, ctrl, 0)
        .unwrap();
    assert_eq!(paras[0].text, long);
    assert!(paras[0].line_segs.len() > 1, "{:?}", paras[0].line_segs);
}

/// 누름틀 값 설정·제거와 양식 값 설정은 이벤트를 쌓지 않는다. 문단 revision 을 올리지
/// 않으면 undo·에이전트 롤백이 바뀐 값을 그대로 남긴다.
#[test]
fn field_and_form_edits_revert_through_snapshot_restore() {
    let mut core = blank_with(&["AB"]);
    core.insert_click_here_field_at(0, 0, 1, "안내", "", "body", true)
        .unwrap();
    core.set_field_value_by_name("body", "old").unwrap();
    let s0 = core.save_snapshot_native();
    core.set_field_value_by_name("body", "new").unwrap();
    core.restore_snapshot_native(s0).unwrap();
    assert!(core
        .get_field_value_by_name("body")
        .unwrap()
        .contains("\"value\":\"old\""));

    core.remove_field_at(0, 0, 2).unwrap();
    assert!(core.collect_all_fields().is_empty());
    core.restore_snapshot_native(s0).unwrap();
    assert_eq!(core.collect_all_fields().len(), 1);

    let mut core = blank_with(&["AB"]);
    let (host, ctrl) = insert_table(&mut core, 1, 1);
    core.insert_click_here_field_at_in_cell(
        0, host, ctrl, 0, 0, 0, false, "안내", "", "cell", true,
    )
    .unwrap();
    core.set_field_value_by_name("cell", "old").unwrap();
    let s0 = core.save_snapshot_native();
    core.set_field_value_by_name("cell", "new").unwrap();
    core.restore_snapshot_native(s0).unwrap();
    assert!(core
        .get_field_value_by_name("cell")
        .unwrap()
        .contains("\"value\":\"old\""));

    let mut core = blank_with(&["AB"]);
    let form_ctrl = {
        let para = &mut core.document.sections[0].paragraphs[0];
        para.controls.push(Control::Form(Box::new(FormObject {
            name: "form".into(),
            text: "old".into(),
            ..Default::default()
        })));
        para.ctrl_data_records.resize(para.controls.len(), None);
        para.controls.len() - 1
    };
    let s0 = core.save_snapshot_native();
    core.set_form_value_native(0, 0, form_ctrl, r#"{"text":"new"}"#)
        .unwrap();
    core.restore_snapshot_native(s0).unwrap();
    match &core.document.sections[0].paragraphs[0].controls[form_ctrl] {
        Control::Form(form) => assert_eq!(form.text, "old"),
        _ => unreachable!(),
    }
}

fn cell_index_at(core: &DocumentCore, host: usize, ctrl: usize, row: u16, col: u16) -> usize {
    match &core.document.sections[0].paragraphs[host].controls[ctrl] {
        Control::Table(table) => table
            .cells
            .iter()
            .position(|c| c.row == row && c.col == col)
            .unwrap(),
        _ => unreachable!(),
    }
}

/// 병합 셀이 있으면 셀 목록은 앵커만 들고 있다. 계산식은 격자 좌표로 셀을 찾아야 하고,
/// 결과 기록은 일반 셀 편집처럼 undo 가능해야 한다.
#[test]
fn table_formula_addresses_merged_grid_and_reverts() {
    let mut core = blank_with(&["AB"]);
    let (host, ctrl) = insert_table(&mut core, 3, 3);
    core.merge_table_cells_native(0, host, ctrl, 0, 0, 0, 2)
        .unwrap();
    let r1c2 = cell_index_at(&core, host, ctrl, 1, 2);
    let r2c1 = cell_index_at(&core, host, ctrl, 2, 1);
    core.insert_text_in_cell_native(0, host, ctrl, r1c2, 0, 0, "7")
        .unwrap();
    core.insert_text_in_cell_native(0, host, ctrl, r2c1, 0, 0, "keep")
        .unwrap();

    // 피연산자: C2 는 1행 2열(0-based) 셀이다.
    let json = core
        .evaluate_table_formula(0, host, ctrl, 2, 2, "=C2*10", false)
        .unwrap();
    assert!(json.contains("\"result\":70"), "{json}");

    // 기록: (1,2) 셀에 쓰이고 (2,1) 셀은 그대로다. 스냅샷 복원으로 되돌아간다.
    let s0 = core.save_snapshot_native();
    core.evaluate_table_formula(0, host, ctrl, 1, 2, "=1+1", true)
        .unwrap();
    assert_eq!(container_texts(&mut core, host, ctrl, r1c2), ["2"]);
    assert_eq!(container_texts(&mut core, host, ctrl, r2c1), ["keep"]);
    {
        let para = &core
            .cell_container_paragraphs_mut(0, host, ctrl, r1c2)
            .unwrap()[0];
        assert_eq!(para.char_offsets.len(), para.text.chars().count());
        assert_eq!(para.char_count as usize, para.text.chars().count() + 1);
    }
    core.restore_snapshot_native(s0).unwrap();
    assert_eq!(container_texts(&mut core, host, ctrl, r1c2), ["7"]);

    // 표 밖 대상은 거절한다.
    assert!(core
        .evaluate_table_formula(0, host, ctrl, 2, 5, "=1+1", true)
        .is_err());
    // 결과가 숫자가 아니면 기록하지 않는다.
    assert!(core
        .evaluate_table_formula(0, host, ctrl, 1, 2, "=SQRT(-1)", true)
        .is_err());
    assert_eq!(container_texts(&mut core, host, ctrl, r1c2), ["7"]);
}

fn new_number_position(core: &DocumentCore) -> usize {
    let para = &core.document.sections[0].paragraphs[0];
    let ci = para
        .controls
        .iter()
        .position(|c| matches!(c, Control::NewNumber(_)))
        .unwrap();
    para.control_text_positions()[ci]
}

/// 감추기·단 정의는 문단 머리(텍스트 위치 0) 컨트롤이다. PARA_TEXT 자리 없이 넣고 빼면
/// 뒤 인라인 컨트롤들이 앞 컨트롤의 자리로 밀려 저장 뒤 다른 글자 위치로 옮겨진다.
#[test]
fn page_hide_and_column_def_keep_inline_control_positions() {
    let mut core = blank_with(&["abcdef"]);
    core.insert_new_number_native(0, 0, 3, 1).unwrap();
    let original = core.document.sections[0].paragraphs[0].clone();
    assert_eq!(new_number_position(&core), 3);

    core.set_page_hide_native(0, 0, true, false, false, false, false, false)
        .unwrap();
    {
        let para = &core.document.sections[0].paragraphs[0];
        let hide = para
            .controls
            .iter()
            .position(|c| matches!(c, Control::PageHide(_)))
            .unwrap();
        assert_eq!(para.control_text_positions()[hide], 0);
        assert_eq!(para.char_count, original.char_count + 8);
        assert!(matches!(para.controls[0], Control::SectionDef(_)));
    }
    assert_eq!(new_number_position(&core), 3);

    let bytes = core.export_hwp_native().unwrap();
    let reloaded = DocumentCore::from_bytes(&bytes).unwrap();
    assert_eq!(new_number_position(&reloaded), 3);
    assert!(reloaded.document.sections[0].paragraphs[0]
        .controls
        .iter()
        .any(|c| matches!(c, Control::PageHide(_))));

    core.set_page_hide_native(0, 0, false, false, false, false, false, false)
        .unwrap();
    let para = &core.document.sections[0].paragraphs[0];
    assert_eq!(para.char_offsets, original.char_offsets);
    assert_eq!(para.char_count, original.char_count);

    // 단 정의가 없는 구역에 새로 넣는 경로.
    {
        let para = &mut core.document.sections[0].paragraphs[0];
        let column = para
            .controls
            .iter()
            .position(|c| matches!(c, Control::ColumnDef(_)))
            .unwrap();
        DocumentCore::remove_inline_control_with_metadata(para, column);
    }
    let without_column = core.document.sections[0].paragraphs[0].clone();
    core.set_column_def_native(0, 2, 0, true, 0).unwrap();
    let para = &core.document.sections[0].paragraphs[0];
    let column = para
        .controls
        .iter()
        .position(|c| matches!(c, Control::ColumnDef(_)))
        .unwrap();
    assert_eq!(para.control_text_positions()[column], 0);
    assert_eq!(para.char_count, without_column.char_count + 8);
    assert_eq!(new_number_position(&core), 3);
}

fn endnote_numbers(core: &DocumentCore) -> Vec<u16> {
    core.document.sections[0]
        .paragraphs
        .iter()
        .flat_map(|p| p.controls.iter())
        .filter_map(|c| match c {
            Control::Endnote(note) => Some(note.number),
            _ => None,
        })
        .collect()
}

/// 미주 모양은 HWP 저장 시 구역 첫 문단의 SectionDef 컨트롤에서 나간다. 번호를 다시 매긴
/// 문단은 revision 을 올려야 undo 가 옛 번호로 돌아간다.
#[test]
fn endnote_shape_reaches_hwp_save_and_renumbering_reverts() {
    let mut core = blank_with(&["AB", "CD"]);
    core.insert_endnote_native(0, 0, 1).unwrap();
    core.insert_endnote_native(0, 1, 1).unwrap();
    assert_eq!(endnote_numbers(&core), [1, 2]);

    let s0 = core.save_snapshot_native();
    core.apply_endnote_shape_native(0, r#"{"startNumber":5}"#)
        .unwrap();
    assert_eq!(endnote_numbers(&core), [5, 6]);
    core.restore_snapshot_native(s0).unwrap();
    assert_eq!(endnote_numbers(&core), [1, 2]);

    core.apply_endnote_shape_native(0, r#"{"startNumber":7}"#)
        .unwrap();
    let bytes = core.export_hwp_native().unwrap();
    let reloaded = DocumentCore::from_bytes(&bytes).unwrap();
    assert_eq!(
        reloaded.document.sections[0]
            .section_def
            .endnote_shape
            .start_number,
        7
    );
}

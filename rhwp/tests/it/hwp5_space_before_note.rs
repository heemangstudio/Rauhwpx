//! HWP5 저장이 각주·미주 바로 앞의 진짜 공백을 지우지 않는다.
//!
//! 직렬화는 자동번호(0x0012) 앞의 placeholder 공백을 컨트롤로 바꿔 쓴다. 각주·미주(0x0011)까지
//! placeholder 로 보면 사용자가 친 공백이 저장할 때마다 하나씩 사라졌다.

use rhwp::document_core::DocumentCore;

fn first_paragraph_text(core: &DocumentCore) -> String {
    core.document().sections[0].paragraphs[0].text.clone()
}

fn save_and_reload(core: &DocumentCore) -> DocumentCore {
    let bytes = core.export_hwp_native().expect("export hwp");
    DocumentCore::from_bytes(&bytes).expect("reload hwp")
}

fn document_with_note(endnote: bool) -> DocumentCore {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().expect("blank document");
    core.insert_text_native(0, 0, 0, "가나 다라")
        .expect("insert text");
    // 공백 바로 뒤, '다' 앞에 각주를 단다.
    if endnote {
        core.insert_endnote_native(0, 0, 3).expect("insert endnote");
    } else {
        core.insert_footnote_native(0, 0, 3)
            .expect("insert footnote");
    }
    core
}

#[test]
fn space_before_footnote_survives_repeated_hwp5_saves() {
    let core = document_with_note(false);
    assert_eq!(first_paragraph_text(&core), "가나 다라");
    let once = save_and_reload(&core);
    assert_eq!(first_paragraph_text(&once), "가나 다라");
    let twice = save_and_reload(&once);
    assert_eq!(first_paragraph_text(&twice), "가나 다라");
}

#[test]
fn space_before_endnote_survives_hwp5_save() {
    let core = document_with_note(true);
    assert_eq!(first_paragraph_text(&save_and_reload(&core)), "가나 다라");
}

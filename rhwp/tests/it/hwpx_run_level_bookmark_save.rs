//! `<hp:ctrl>` 로 감싸지 않은 run 직속 책갈피가 든 HWPX 도 저장된다.
//!
//! 파서는 run 의 직접 자식 수를 세어 저장 때 같은 구조를 되살린다. 감싸지 않은 책갈피는
//! 자식으로 세면서 모델에는 넣지 않아, 저장이 되살릴 수 없는 자식을 기다리다 "작성된 빈
//! hp:t의 자식 구조를 복원할 수 없습니다" 로 문서 전체 저장을 거부했다.

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;

fn bookmark_names(core: &DocumentCore) -> Vec<String> {
    core.document()
        .sections
        .iter()
        .flat_map(|section| section.paragraphs.iter())
        .flat_map(|para| para.controls.iter())
        .filter_map(|control| match control {
            Control::Bookmark(bookmark) => Some(bookmark.name.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn hwpx_with_a_bare_run_bookmark_saves_and_keeps_the_bookmark() {
    for sample in [
        "samples/tac-host-spacing.hwpx",
        "samples/issue2527_empty_linesegs.hwpx",
        "samples/task2169/anchor_ladder.hwpx",
    ] {
        let bytes = std::fs::read(sample).expect("sample");
        let core = DocumentCore::from_bytes(&bytes).expect("open");
        let names = bookmark_names(&core);
        assert!(!names.is_empty(), "{sample}: bookmark must be parsed");

        let saved = core
            .export_hwpx_native()
            .unwrap_or_else(|e| panic!("{sample}: save failed: {e:?}"));
        let reopened = DocumentCore::from_bytes(&saved).expect("reopen");
        assert_eq!(bookmark_names(&reopened), names, "{sample}");
        assert_eq!(
            reopened.document().sections[0].paragraphs.len(),
            core.document().sections[0].paragraphs.len(),
            "{sample}",
        );
    }
}

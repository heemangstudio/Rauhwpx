//! 저장 LINE_SEG 가 없는 미주 문단의 조판 회귀.
//!
//! 미주 본문은 로드 시 LINE_SEG 합성 대상이 아니라, linesegarray 없는 파일(또는 저장
//! lineseg 를 버린 경로)에서 줄 0개로 조판에 들어와 `typeset_endnote_paragraphs` 의
//! 줄 인덱스 접근에서 패닉했다. 미주를 단 폭으로 재조판해 정상 배치해야 한다.

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;

const SAMPLE: &str = "samples/3-11월_실전_통합_2022.hwpx";

fn strip_endnote_line_segs(core: &mut DocumentCore) -> usize {
    let mut stripped = 0;
    for section in &mut core.document_mut().sections {
        for para in &mut section.paragraphs {
            for ctrl in &mut para.controls {
                if let Control::Endnote(note) = ctrl {
                    for note_para in &mut note.paragraphs {
                        if !note_para.line_segs.is_empty() {
                            note_para.line_segs.clear();
                            stripped += 1;
                        }
                    }
                }
            }
        }
    }
    stripped
}

#[test]
fn lineseg_free_endnotes_typeset_and_render() {
    let bytes = std::fs::read(SAMPLE).expect("sample");
    let mut core = DocumentCore::from_bytes(&bytes).expect("parse");
    let stored_pages = core.page_count();

    assert!(
        strip_endnote_line_segs(&mut core) > 0,
        "샘플에 미주 문단이 있어야 한다"
    );
    core.refresh_layout_native();

    let pages = core.page_count();
    assert!(pages > 0);
    // 재조판한 미주도 저장 배치와 같은 규모로 흘러야 한다(줄 0개 붕괴·폭주 없음).
    assert!(
        pages + 2 >= stored_pages && pages <= stored_pages + 2,
        "pages {pages} vs stored {stored_pages}"
    );
    for page in 0..pages {
        core.render_page_svg_native(page).expect("render");
    }
}

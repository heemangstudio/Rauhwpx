//! 구역·단 정의와 인라인 표만 든 첫 문단에 글자를 치고 HWPX 로 저장해도 글자가 남는다.
//!
//! 공문서 HWPX 는 첫 문단이 secPr·colPr 와 글자처럼 취급한 표만 담는 일이 흔하다. 글자를
//! 넣으면 UTF-16 위치 0, 곧 구역·단 정의 앞에 들어갔고, 저장한 줄 위치(textpos)가 컨트롤
//! 안을 가리켜 다시 연 문서에서 친 글자가 보이지 않았다.

use rhwp::document_core::DocumentCore;

const SAMPLE: &str = "samples/hwpx/table-text.hwpx";

fn rendered_text(core: &DocumentCore) -> String {
    let svg = core.render_page_svg_native(0).expect("render page 1");
    let mut text = String::new();
    let mut rest = svg.as_str();
    while let Some(start) = rest.find("<text") {
        rest = &rest[start..];
        let Some(open_end) = rest.find('>') else {
            break;
        };
        let Some(close) = rest.find("</text>") else {
            break;
        };
        text.push_str(&rest[open_end + 1..close]);
        rest = &rest[close + "</text>".len()..];
    }
    text
}

#[test]
fn text_typed_before_an_inline_table_survives_hwpx_save() {
    let bytes = std::fs::read(SAMPLE).expect("sample");
    let mut core = DocumentCore::from_bytes(&bytes).expect("open");
    let first = &core.document().sections[0].paragraphs[0];
    assert!(
        first.text.is_empty() && first.controls.len() >= 3,
        "fixture: secPr, colPr, inline table"
    );

    core.insert_text_native(0, 0, 0, "스트레스").expect("type");
    assert!(rendered_text(&core).contains("스트레스"));

    let saved = core.export_hwpx_native().expect("save hwpx");
    let reopened = DocumentCore::from_bytes(&saved).expect("reopen");
    assert_eq!(
        reopened.document().sections[0].paragraphs[0].text,
        "스트레스"
    );
    assert!(
        rendered_text(&reopened).contains("스트레스"),
        "typed text vanished after save"
    );

    // 편집 직후와 다시 연 문서가 같은 줄 나눔을 가진다.
    let starts = |core: &DocumentCore| {
        core.document().sections[0].paragraphs[0]
            .line_segs
            .iter()
            .map(|seg| seg.text_start)
            .collect::<Vec<_>>()
    };
    assert_eq!(starts(&reopened), starts(&core));
}

//! 에이전트 읽기 경로의 엔진 계약.
//!
//! - `getPositionOfPage` 의 `continued` 는 그 쪽이 앞 쪽에서 시작한 문단(또는 표 행) 중간에서
//!   시작할 때만 참이다. get_structure 의 "-- page N (pX continues) --" 표시와 pages 범위의
//!   끝 문단 판정이 이 값에 기댄다.
//! - 본문 선택 rect 는 공유 페이지 트리 캐시를 쓴다. 편집 뒤에도 캐시를 거친 결과가 캐시 없이
//!   새로 연 문서의 결과와 같아야 한다 (스테이징 오버레이가 op 마다 이 조회를 되풀이한다).

use std::path::Path;

use rhwp::wasm_api::HwpDocument;
use serde_json::Value;

fn load_sample(file_name: &str) -> HwpDocument {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("samples")
        .join(file_name);
    let bytes =
        std::fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    HwpDocument::from_bytes(&bytes)
        .unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn json(text: &str) -> Value {
    serde_json::from_str(text).expect("JSON")
}

#[test]
fn page_start_continued_means_the_paragraph_began_on_an_earlier_page() {
    let mut continued_pages = 0;
    for sample in ["biz_plan.hwp", "2022년 국립국어원 업무계획.hwp"] {
        let doc = load_sample(sample);
        for page in 0..doc.page_count() {
            let start = json(&doc.get_position_of_page(page).expect("page start"));
            let continued = start["continued"]
                .as_bool()
                .unwrap_or_else(|| panic!("{sample} page {page}: no continued flag in {start}"));
            if !continued {
                continue;
            }
            continued_pages += 1;
            assert!(
                page > 0,
                "{sample}: the first page cannot continue a paragraph"
            );
            let sec = start["sec"].as_u64().unwrap() as u32;
            let para = start["para"].as_u64().unwrap() as u32;
            let first = json(
                &doc.get_page_of_position(sec, para)
                    .expect("page of paragraph"),
            );
            assert!(
                first["page"].as_u64().unwrap() < page as u64,
                "{sample}: page {page} continues s{sec} p{para}, which must start on an earlier page"
            );
        }
    }
    assert!(
        continued_pages > 0,
        "the samples should include a page that starts mid-paragraph"
    );
}

#[test]
fn body_selection_rects_through_the_page_tree_cache_match_a_fresh_document() {
    let rects = |doc: &HwpDocument| {
        doc.get_selection_rects(0, 1, 0, 3, 2)
            .expect("body selection rects")
    };
    let mut warm = load_sample("biz_plan.hwp");
    let mut cold = load_sample("biz_plan.hwp");
    // 캐시를 데운 뒤 레이아웃을 바꾸는 편집 — 캐시가 무효화되지 않으면 옛 줄 좌표가 나온다.
    let before = rects(&warm);
    let _ = rects(&warm);
    let insert = "선택 영역 캐시 확인용 문장을 길게 넣어 줄바꿈 위치를 바꾼다. ".repeat(4);
    warm.insert_text(0, 1, 0, &insert, None)
        .expect("insert warm");
    cold.insert_text(0, 1, 0, &insert, None)
        .expect("insert cold");
    let after_warm_first = rects(&warm);
    let after_warm_hit = rects(&warm);
    let after_cold = rects(&cold);
    assert_ne!(
        before, after_warm_first,
        "the edit should move the selection geometry"
    );
    assert_eq!(after_warm_first, after_cold);
    assert_eq!(after_warm_hit, after_cold);
}

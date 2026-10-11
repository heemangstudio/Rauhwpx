//! 수백 번의 문단 편집으로 줄간격과 쪽 경계를 확인하는 느린 편집 회귀
//! (`document_core::commands::text_editing` 단위 테스트에서 옮김).

use rhwp::document_core::DocumentCore;

/// 줄간격 100%에서 200%보다 더 많은 문단이 한 페이지에 들어가는지 확인
/// (비교 대상이 160%면 height_for_fit 모델의 trail_ls 절약 효과로 1페이지 역전 가능 → 200% 사용)
#[test]
fn test_page_break_with_tight_line_spacing() {
    // 100% 줄간격 문서
    let mut core100 = DocumentCore::new_empty();
    core100.create_blank_document_native().unwrap();
    let text = "Tight spacing test line.";
    // 첫 문단에 줄간격 100% 적용
    core100
        .apply_para_format_native(0, 0, r#"{"lineSpacing":100}"#)
        .unwrap();
    for i in 0..500 {
        let para_count = core100.document().sections[0].paragraphs.len();
        let last = para_count - 1;
        core100.insert_text_native(0, last, 0, text).unwrap();
        core100
            .split_paragraph_native(0, last, text.len(), None)
            .unwrap();
        // 새 문단에도 100% 적용
        let new_last = core100.document().sections[0].paragraphs.len() - 1;
        core100
            .apply_para_format_native(0, new_last, r#"{"lineSpacing":100}"#)
            .unwrap();
    }
    let pages_100 = core100.page_count();

    // 200% 줄간격 문서 (비교 기준)
    let mut core200 = DocumentCore::new_empty();
    core200.create_blank_document_native().unwrap();
    core200
        .apply_para_format_native(0, 0, r#"{"lineSpacing":200}"#)
        .unwrap();
    for i in 0..500 {
        let para_count = core200.document().sections[0].paragraphs.len();
        let last = para_count - 1;
        core200.insert_text_native(0, last, 0, text).unwrap();
        core200
            .split_paragraph_native(0, last, text.len(), None)
            .unwrap();
        let new_last = core200.document().sections[0].paragraphs.len() - 1;
        core200
            .apply_para_format_native(0, new_last, r#"{"lineSpacing":200}"#)
            .unwrap();
    }
    let pages_200 = core200.page_count();

    eprintln!(
        "100% → {}페이지, 200% → {}페이지 (문단 501개)",
        pages_100, pages_200
    );
    // 100%는 200%보다 같거나 적은 페이지 수
    assert!(
        pages_100 <= pages_200,
        "100% 줄간격({})이 200%({})보다 적은/같은 페이지 수여야 함",
        pages_100,
        pages_200
    );
}

/// 기존 문서 중간 문단의 줄간격을 10%씩 증가시키면 페이지 경계를 정확히 돌파하는지 검증
#[test]
fn test_page_boundary_with_incremental_spacing_increase() {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().unwrap();

    // 160% 줄간격으로 30개의 multi-line 문단 생성 (1페이지에 거의 맞도록)
    // height_for_fit 모델에서 trailing line_spacing은 제외되므로,
    // single-line 문단으로는 spacing 증가 효과가 약화됨 → multi-line text 사용
    let text = "Test paragraph for spacing. ".repeat(20);
    let text = text.as_str();
    for _ in 0..29 {
        let last = core.document().sections[0].paragraphs.len() - 1;
        core.insert_text_native(0, last, 0, text).unwrap();
        core.split_paragraph_native(0, last, text.len(), None)
            .unwrap();
    }
    // 마지막 문단에도 텍스트
    let last = core.document().sections[0].paragraphs.len() - 1;
    core.insert_text_native(0, last, 0, text).unwrap();

    let initial_pages = core.page_count();
    eprintln!(
        "초기 페이지 수: {} (30 multi-line 문단 160%)",
        initial_pages
    );

    // 문단 15~25의 줄간격을 10%씩 증가 (170%, 180%, ..., 270%)
    let mut prev_pages = initial_pages;
    let mut boundary_crossed_at = 0;
    for step in 0..20 {
        let spacing = 170 + step * 10; // 170% → 360%
        for para_idx in 5..30 {
            if para_idx < core.document().sections[0].paragraphs.len() {
                let json = format!(r#"{{"lineSpacing":{}}}"#, spacing);
                core.apply_para_format_native(0, para_idx, &json).unwrap();
            }
        }
        let pages = core.page_count();
        if pages > prev_pages && boundary_crossed_at == 0 {
            boundary_crossed_at = spacing;
            eprintln!(
                "  페이지 경계 돌파: {}% 줄간격에서 {}→{}페이지",
                spacing, prev_pages, pages
            );
        }
        prev_pages = pages;
    }

    eprintln!("최종 페이지 수: {} (줄간격 360%)", prev_pages);
    assert!(
        prev_pages > initial_pages,
        "줄간격 증가로 페이지 수 증가 필요: {} → {}",
        initial_pages,
        prev_pages
    );
    assert!(
        boundary_crossed_at > 0,
        "페이지 경계 돌파 시점이 감지되어야 함"
    );

    // 모든 페이지 렌더 트리 정상 빌드 확인
    for p in 0..prev_pages {
        let tree = core.build_page_render_tree(p as u32);
        assert!(
            tree.is_ok(),
            "페이지 {} 렌더 트리 빌드 실패: {:?}",
            p,
            tree.err()
        );
    }
}

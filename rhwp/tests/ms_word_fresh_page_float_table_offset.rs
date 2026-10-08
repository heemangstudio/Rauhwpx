#![cfg(not(target_arch = "wasm32"))]
//! MS Word 호환 HWPX 의 연속 자리차지 표 — 새 쪽으로 밀린 표의 세로 오프셋.
//!
//! 재현체(samples/ms_word_fresh_page_float_table_offset.hwpx): 학교 보고서 양식의
//! 1구역만 남기고 본문 한글 음절을 같은 폭 자리표시로 바꾼 파일이다. 빈 문단 두 개에
//! 각각 쪽보다 큰 자리차지 표(vert=문단, flowWithText)가 앵커된다. 둘째 표
//! (pi=3, vertOffset 28627HU ≈ 381.7px)는 첫 표가 끝난 3쪽에 들어가지 않아 4쪽에서
//! 시작한다.
//!
//! 한컴 macOS PDF(원본 7쪽): 둘째 표는 4쪽 본문 상단(89px)에서 시작하고 6쪽에서
//! 끝난다. 문단 기준 오프셋은 앵커 쪽에서만 적용된다. 수정 전 rhwp 는 새 쪽에서
//! 오프셋을 다시 더해 4쪽 위 절반을 비웠고, 이 구역이 6쪽에서 7쪽으로 늘었다.
//!
//! 이 문서는 `applyNextspacingOfLastPara` 호환 설정을 가진다. 한컴은 셀 마지막
//! 문단의 줄 간격(604HU)과 문단 아래 간격(150HU)을 셀 높이에 남긴다: 둘째 표의
//! '탐구 데이터 정리' 행은 197px, '목표(가설) 검증' 행은 543px 이고, 5쪽은
//! '새롭게 발견한 점' 행의 마지막 줄 앞에서 끝난다.

use rhwp::document_core::DocumentCore;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

const SAMPLE: &str = "samples/ms_word_fresh_page_float_table_offset.hwpx";
const SECOND_TABLE_PARA: usize = 3;

fn load() -> DocumentCore {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(SAMPLE);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("재현체 {}: {e}", path.display()));
    DocumentCore::from_bytes(&bytes).unwrap_or_else(|e| panic!("로드 {SAMPLE}: {e}"))
}

fn body_top(node: &RenderNode) -> Option<f64> {
    if matches!(node.node_type, RenderNodeType::Body { .. }) {
        return Some(node.bbox.y);
    }
    node.children.iter().find_map(body_top)
}

fn table_top(node: &RenderNode, para_index: usize, out: &mut Option<f64>) {
    if !node.visible || node.editor_only {
        return;
    }
    if let RenderNodeType::Table(meta) = &node.node_type {
        if meta.para_index == Some(para_index) {
            let top = node.bbox.y;
            if out.is_none_or(|cur| top < cur) {
                *out = Some(top);
            }
            return;
        }
    }
    for child in &node.children {
        table_top(child, para_index, out);
    }
}

/// 둘째 표에서 `row` 행 셀들의 (상단, 하단) — 같은 행 셀 중 가장 큰 상자.
fn second_table_row_span(
    node: &RenderNode,
    row: u16,
    in_table: bool,
    out: &mut Option<(f64, f64)>,
) {
    if !node.visible || node.editor_only {
        return;
    }
    let in_table = match &node.node_type {
        RenderNodeType::Table(meta) => meta.para_index == Some(SECOND_TABLE_PARA),
        _ => in_table,
    };
    if let RenderNodeType::TableCell(cell) = &node.node_type {
        if in_table && cell.row == row && cell.row_span == 1 {
            let (top, bottom) = (node.bbox.y, node.bbox.y + node.bbox.height);
            *out = Some(out.map_or((top, bottom), |(t, b)| (t.min(top), b.max(bottom))));
        }
        return;
    }
    for child in &node.children {
        second_table_row_span(child, row, in_table, out);
    }
}

fn row_span_on(core: &DocumentCore, page: u32, row: u16) -> Option<(f64, f64)> {
    let root = core
        .build_page_render_tree(page)
        .unwrap_or_else(|e| panic!("{}쪽 렌더: {e}", page + 1))
        .root;
    let mut span = None;
    second_table_row_span(&root, row, false, &mut span);
    span
}

fn second_table_top(core: &DocumentCore, page: u32) -> Option<f64> {
    let root = core
        .build_page_render_tree(page)
        .unwrap_or_else(|e| panic!("{}쪽 렌더: {e}", page + 1))
        .root;
    let mut top = None;
    table_top(&root, SECOND_TABLE_PARA, &mut top);
    top
}

#[test]
fn pushed_float_table_starts_at_the_fresh_page_body_top() {
    let core = load();
    assert_eq!(
        core.page_count(),
        6,
        "둘째 표는 4~6쪽에 걸쳐야 합니다 (한컴: 1구역 6쪽)"
    );
    assert!(
        second_table_top(&core, 2).is_none(),
        "둘째 표는 첫 표가 끝난 3쪽이 아니라 4쪽에서 시작해야 합니다"
    );

    let root = core.build_page_render_tree(3).expect("4쪽 렌더").root;
    let body = body_top(&root).expect("4쪽 본문 영역");
    let top = second_table_top(&core, 3).expect("4쪽에 둘째 표가 없습니다");
    assert!(
        (top - body).abs() <= 1.0,
        "새 쪽으로 밀린 표는 본문 상단에서 시작해야 합니다 — 본문 상단 {body:.1} · 표 상단 \
         {top:.1} (vertOffset 381.7px 를 다시 적용하면 안 됨)"
    );
}

#[test]
fn cell_rows_keep_the_last_paragraph_spacing() {
    let core = load();
    // 한컴 macOS PDF 96dpi 괘선: 4쪽 111→308px, 5쪽 269→812px.
    let (top, bottom) = row_span_on(&core, 3, 1).expect("4쪽 '탐구 데이터 정리' 행");
    assert!(
        (bottom - top - 197.0).abs() <= 1.5,
        "'탐구 데이터 정리' 행 높이 {:.1}px — 한컴 197px (마지막 줄 간격 + 문단 아래 간격 포함)",
        bottom - top
    );
    let (top, bottom) = row_span_on(&core, 4, 3).expect("5쪽 '목표(가설) 검증' 행");
    assert!(
        (bottom - top - 543.0).abs() <= 1.5,
        "'목표(가설) 검증' 행 높이 {:.1}px — 한컴 543px",
        bottom - top
    );
    // 한컴은 '새롭게 발견한 점' 행(5)의 마지막 줄을 6쪽으로 넘긴다.
    assert!(
        row_span_on(&core, 5, 5).is_some(),
        "'새롭게 발견한 점' 행의 마지막 줄은 6쪽에서 이어져야 합니다"
    );
}

fn celsius_runs(node: &RenderNode, out: &mut Vec<(f64, f64)>) {
    if let RenderNodeType::TextRun(run) = &node.node_type {
        if run.text == "℃" {
            out.push((node.bbox.width, run.style.font_size));
        }
    }
    for child in &node.children {
        celsius_runs(child, out);
    }
}

#[test]
fn celsius_missing_from_times_new_roman_uses_hcr_dotum_advance() {
    // 기호 글꼴 Times New Roman 에는 ℃ 가 없다. 한컴은 함초롬돋움(0.97em)으로 그리고,
    // 다음 글자도 그만큼 뒤에 둔다 (한컴 PDF `23.16℃로` 42.24pt). 0.5em 으로 재면
    // ℃ 가 다음 글자와 겹친다.
    let core = load();
    let root = core.build_page_render_tree(3).expect("4쪽 렌더").root;
    let mut runs = Vec::new();
    celsius_runs(&root, &mut runs);
    assert!(!runs.is_empty(), "4쪽에 ℃ 글자 run 이 없습니다");
    for (width, font_size) in runs {
        let em = width / font_size;
        assert!(
            (0.95..=1.0).contains(&em),
            "℃ 진행폭 {em:.3}em — 한컴 함초롬돋움 0.97em"
        );
    }
}

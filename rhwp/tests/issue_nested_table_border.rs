//! Nested table 외부 1x1 표 외곽 테두리 (exam_social.hwp p1 4번).
//!
//! 외부 1x1 표는 내부 표만 그리는 래퍼로 풀지 않고 선언 크기 그대로 그린다 —
//! padding 850 안쪽에 내부 6x3 대화체 표가 놓인다. 한컴 macOS PDF 의 4번 자료 박스는
//! x 145.46–254.55mm, 높이 98.0mm 로 외부 표 선언 크기(30894×27774 HU)와 같다.
//!
//! 권위 자료: pi=15 4번 자료 박스 (외부 1x1 padding=850 + 내부 6x3 대화체).

use std::fs;
use std::path::Path;

#[test]
fn nested_table_border_exam_social_p1_q4_outline_present() {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let hwp_path = Path::new(repo_root).join("samples/exam_social.hwp");
    let bytes = fs::read(&hwp_path).expect("read exam_social.hwp");
    let doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes).expect("parse exam_social.hwp");

    // 4 페이지 (PDF 정합)
    assert_eq!(doc.page_count(), 4, "exam_social.hwp 는 4 페이지");

    // 페이지 1 SVG 출력
    let svg = doc.render_page_svg(0).expect("render_page_svg");

    // 4번 자료 박스 외곽 4개 라인이 SVG 에 존재해야 한다.
    // 박스 width: 외부 표 선언 폭 30894 HU = 411.92px.
    // x 좌표: 549.88 (좌) ~ 961.80 (우) — 한컴 PDF 145.46–254.55mm 와 일치.
    // y 좌표: 다른 PR 영역의 페이지네이션 변경에 따라 시프트 가능 영역으로 영역
    // 배치에 따라 바뀌는 절대 좌표 대신 x 좌표 관계와 선 속성을 검증한다.
    let lx = "549.8800000000001";
    let rx = "961.8000000000002";

    // 좌측선: x1==x2==lx (수직선)
    let has_left_line = svg.contains(&format!("<line x1=\"{lx}\" y1="))
        && svg
            .matches(&format!("x1=\"{lx}\" y1=\""))
            .filter(|_| true)
            .count()
            >= 1
        && svg.contains(&format!("x2=\"{lx}\""));
    // 우측선: x1==x2==rx (수직선)
    let has_right_line =
        svg.contains(&format!("<line x1=\"{rx}\" y1=")) && svg.contains(&format!("x2=\"{rx}\""));
    // 상/하: x1==lx, x2==rx (수평선)
    let has_horizontal_line =
        svg.contains(&format!("x1=\"{lx}\" y1=")) && svg.contains(&format!("x2=\"{rx}\""));

    assert!(has_left_line, "4번 박스 좌측 외곽선 누락 (x={lx})");
    assert!(has_right_line, "4번 박스 우측 외곽선 누락 (x={rx})");
    assert!(
        has_horizontal_line,
        "4번 박스 수평 외곽선 누락 (x={lx}~{rx})"
    );

    // 외곽선 stroke=#000000 width=0.75 (3 조건 AND 가드 영역 발동 영역의 본 PR 영역의 본질 영역)
    let outline_pattern = format!("x1=\"{lx}\"");
    let outline_count = svg.matches(&outline_pattern).count();
    assert!(
        outline_count >= 2,
        "4번 박스 좌측+상단 라인 영역의 lx 좌표 ≥ 2건 영역 필요 영역 (실제: {outline_count})"
    );
}

/// SVG 문자열에서 `<line>` 요소의 좌표와 점선 여부를 추출한다.
/// 반환: `(x1, y1, x2, y2, dashed)` — `dashed` 는 `stroke-dasharray` 보유 여부.
fn parse_lines(svg: &str) -> Vec<(f64, f64, f64, f64, bool)> {
    let mut out = Vec::new();
    for seg in svg.split("<line ").skip(1) {
        let head = &seg[..seg.find('>').unwrap_or(seg.len())];
        let get = |k: &str| -> Option<f64> {
            let p = head.find(&format!("{k}=\""))? + k.len() + 2;
            let rest = &head[p..];
            rest[..rest.find('"')?].parse().ok()
        };
        if let (Some(x1), Some(y1), Some(x2), Some(y2)) =
            (get("x1"), get("y1"), get("x2"), get("y2"))
        {
            let dashed = head.contains("stroke-dasharray");
            out.push((x1, y1, x2, y2, dashed));
        }
    }
    out
}

/// #1043 회귀 가드: 중첩 표(1×1 wrapper) 외곽 테두리 누락 정정 (HWP5 케이스).
///
/// `samples/k-water-rfp.hwp` 안에는 외곽 1×1 wrapper 표 안에 내부 표가 든 자료 박스
/// 구조가 있다. 내부 표의 외곽 격자는 점선(`stroke-dasharray`)으로, wrapper 외곽
/// 테두리는 실선으로 그려진다. off-by-one lookup 버그에서는 wrapper 외곽 borderFill 을
/// 한 칸 어긋나게 읽어(NONE) 실선 외곽선이 통째로 누락되고 내부 표 점선만 남았다.
///
/// wrapper 는 선언 크기 그대로 그려지므로 실선 외곽은 셀 안여백만큼 점선 외곽을
/// 바깥에서 감싼다 (한컴 macOS PDF k-water-rfp p17: 실선 박스 안쪽에 점선 표).
/// 가드: 전폭(>500px) 점선 수평선이 있는 쪽에서, 그 위(≤ 최상단 점선)와 아래
/// (≥ 최하단 점선)에 점선 구간을 덮는 전폭 실선이 각각 존재하는지 확인한다.
#[test]
fn nested_table_border_kwater_rfp_outer_outline_present() {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let path = Path::new(repo_root).join("samples/k-water-rfp.hwp");
    let bytes = fs::read(&path).expect("read k-water-rfp.hwp");
    let doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes).expect("parse k-water-rfp.hwp");

    let mut matched_pages = Vec::new();
    for page_idx in 0..doc.page_count() {
        let svg = doc
            .render_page_svg(page_idx)
            .unwrap_or_else(|e| panic!("render_page_svg page {}: {e:?}", page_idx + 1));
        let lines = parse_lines(&svg);
        let is_wide_horiz =
            |x1: f64, y1: f64, x2: f64, y2: f64| (y1 - y2).abs() < 0.01 && (x2 - x1).abs() > 500.0;
        let dashed: Vec<(f64, f64, f64)> = lines
            .iter()
            .filter(|(x1, y1, x2, y2, d)| *d && is_wide_horiz(*x1, *y1, *x2, *y2))
            .map(|(x1, y1, x2, ..)| (x1.min(*x2), x1.max(*x2), *y1))
            .collect();
        if dashed.is_empty() {
            continue;
        }
        let top = dashed.iter().map(|d| d.2).fold(f64::MAX, f64::min);
        let bottom = dashed.iter().map(|d| d.2).fold(f64::MIN, f64::max);
        let left = dashed.iter().map(|d| d.0).fold(f64::MAX, f64::min);
        let right = dashed.iter().map(|d| d.1).fold(f64::MIN, f64::max);
        let solid_covers = |pick: &dyn Fn(f64) -> bool| {
            lines.iter().any(|(x1, y1, x2, y2, d)| {
                !*d && is_wide_horiz(*x1, *y1, *x2, *y2)
                    && pick(*y1)
                    && x1.min(*x2) <= left + 1.0
                    && x1.max(*x2) >= right - 1.0
            })
        };
        if solid_covers(&|y| y <= top + 1.0) && solid_covers(&|y| y >= bottom - 1.0) {
            matched_pages.push(page_idx + 1);
        }
    }

    assert!(
        !matched_pages.is_empty(),
        "wrapper 외곽 실선 테두리 누락 (내부 표 점선 외곽을 감싸는 전폭 실선 없음)"
    );
}

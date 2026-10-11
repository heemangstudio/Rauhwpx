//! Issue #2020: 첨부 문서 렌더링 차이 회귀 게이트.
//!
//! 첨부/참조 문서는 하나의 이슈 범위에서 다룬다. 이 테스트는 자동 판정 가능한
//! 페이지 수와 FSC HWP/HWPX 흐름 동기화를 먼저 고정한다.

use crate::common::load_doc;
use rhwp::renderer::render_tree::{BoundingBox, RenderNode, RenderNodeType};
use std::collections::BTreeMap;

fn has_table(root: &RenderNode, para_index: usize, control_index: usize) -> bool {
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if let RenderNodeType::Table(table) = &node.node_type {
            if table.para_index == Some(para_index) && table.control_index == Some(control_index) {
                return true;
            }
        }
        for child in &node.children {
            stack.push(child);
        }
    }
    false
}

fn find_table_bbox(
    root: &RenderNode,
    para_index: usize,
    control_index: usize,
) -> Option<BoundingBox> {
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if let RenderNodeType::Table(table) = &node.node_type {
            if table.para_index == Some(para_index) && table.control_index == Some(control_index) {
                return Some(node.bbox);
            }
        }
        for child in &node.children {
            stack.push(child);
        }
    }
    None
}

fn find_text_bbox(root: &RenderNode, needle: &str) -> Option<BoundingBox> {
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if let RenderNodeType::TextRun(run) = &node.node_type {
            if run.text.contains(needle) {
                return Some(node.bbox);
            }
        }
        for child in &node.children {
            stack.push(child);
        }
    }
    None
}

fn find_receipt_seal_line_bbox(root: &RenderNode) -> Option<BoundingBox> {
    if matches!(root.node_type, RenderNodeType::TextLine(_)) {
        let has = |needle| {
            root.children.iter().any(|child| {
            matches!(&child.node_type, RenderNodeType::TextRun(run) if run.text.contains(needle))
        })
        };
        if has('\u{F081C}') && has('\u{F012B}') {
            return Some(root.bbox);
        }
    }
    root.children.iter().find_map(find_receipt_seal_line_bbox)
}

fn find_first_ellipse_bbox(root: &RenderNode) -> Option<BoundingBox> {
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if matches!(node.node_type, RenderNodeType::Ellipse(_)) {
            return Some(node.bbox);
        }
        for child in &node.children {
            stack.push(child);
        }
    }
    None
}

fn find_filler_glyphs_near(
    root: &RenderNode,
    x_range: (f64, f64),
    baseline_range: (f64, f64),
) -> Vec<BoundingBox> {
    let mut stack = vec![root];
    let mut glyphs = Vec::new();
    while let Some(node) = stack.pop() {
        if let RenderNodeType::TextRun(run) = &node.node_type {
            if run.text == "\u{F081C}"
                && run.display_text.as_deref() == Some("\u{F081C}")
                && (x_range.0..=x_range.1).contains(&node.bbox.x)
                && (baseline_range.0..=baseline_range.1).contains(&(node.bbox.y + run.baseline))
            {
                glyphs.push(node.bbox);
            }
        }
        stack.extend(&node.children);
    }
    glyphs.sort_by(|a, b| a.x.total_cmp(&b.x));
    glyphs
}

fn parse_svg_attr(attrs: &str, key: &str) -> Option<f64> {
    let p = attrs.find(&format!("{key}=\""))?;
    let s = p + key.len() + 2;
    let e = attrs[s..].find('"')? + s;
    attrs[s..e].parse::<f64>().ok()
}

fn svg_line_with_text(svg: &str, needle: &str) -> Option<(String, Vec<(f64, String)>)> {
    let mut by_y: BTreeMap<i32, Vec<(f64, String)>> = BTreeMap::new();
    let mut i = 0;
    while i < svg.len() {
        let Some(rel) = svg[i..].find("<text ") else {
            break;
        };
        let abs = i + rel;
        let after = &svg[abs + 6..];
        let Some(close) = after.find('>') else {
            i = abs + 6;
            continue;
        };
        let attrs = &after[..close];
        let content_start = abs + 6 + close + 1;
        let Some(end_rel) = svg[content_start..].find("</text>") else {
            i = abs + 6;
            continue;
        };
        let content = &svg[content_start..content_start + end_rel];
        if let (Some(x), Some(y)) = (parse_svg_attr(attrs, "x"), parse_svg_attr(attrs, "y")) {
            let y_key = (y * 10.0).round() as i32;
            by_y.entry(y_key)
                .or_default()
                .push((x, content.to_string()));
        }
        i = content_start + end_rel + 7;
    }

    for (_y, mut chars) in by_y {
        chars.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let full: String = chars.iter().map(|(_, s)| s.as_str()).collect();
        if full.contains(needle) {
            return Some((full, chars));
        }
    }
    None
}

#[test]
fn issue_2020_reference_documents_keep_expected_page_counts() {
    assert_eq!(
        load_doc("samples/issue2020/passport_application_lawgo.hwp").page_count(),
        2
    );
    assert_eq!(
        load_doc("samples/issue2020/(250813) (보도자료) 2025년 7월중 가계대출 동향.hwp")
            .page_count(),
        5
    );
    assert_eq!(
        load_doc("samples/issue2020/(250813) (보도자료) 2025년 7월중 가계대출 동향.hwpx")
            .page_count(),
        5
    );
    assert_eq!(load_doc("samples/복학원서.hwp").page_count(), 1);
    assert_eq!(
        load_doc("samples/2022년 국립국어원 업무계획.hwp").page_count(),
        35
    );
}

#[test]
fn issue_2020_passport_corner_quote_does_not_leave_extra_gap() {
    let doc = load_doc("samples/issue2020/passport_application_lawgo.hwp");
    let svg = doc
        .render_page_svg_native(0)
        .expect("render passport application page 1 SVG");
    let (line_text, chars) = svg_line_with_text(&svg, "2.「여권법」제9조")
        .expect("여권신청서 1쪽 동의 문구 줄을 찾아야 함");

    assert!(
        !line_text.contains("「 "),
        "원문에 없는 낫표 뒤 공백이 SVG 텍스트에 생기면 안 됨: {line_text}"
    );

    let open_idx = chars
        .iter()
        .position(|(_, text)| text == "「")
        .expect("opening corner quote");
    let yeo_idx = chars[open_idx + 1..]
        .iter()
        .position(|(_, text)| text == "여")
        .map(|idx| idx + open_idx + 1)
        .expect("Hangul after opening corner quote");
    let close_idx = chars
        .iter()
        .position(|(_, text)| text == "」")
        .expect("closing corner quote");
    let je_idx = chars[close_idx + 1..]
        .iter()
        .position(|(_, text)| text == "제")
        .map(|idx| idx + close_idx + 1)
        .expect("Hangul after closing corner quote");

    // 낫표 「」 칸은 전각이다 — 한컴(macOS)은 선언 face 의 기록 전각 폭으로
    // 조판한다. 기대 렌더의 「/」 칸이 본문 한글과 같은 피치이고, 코퍼스 공식
    // PDF 도 「 0.82–1.00em 실측 (35-voucher '「곡성군' 「=10.6pt@11.04pt,
    // 38-cheongyang '「전자정부법」' 「=」=9.0pt@9.0pt). glyph 원점 → 다음
    // 글자 간격은 양쪽 다 1em 이다.
    let open_gap = chars[yeo_idx].0 - chars[open_idx].0;
    let close_gap = chars[je_idx].0 - chars[close_idx].0;
    assert!(
        open_gap >= 12.5 && (open_gap - close_gap).abs() <= 0.5,
        "낫표 「」 칸은 전각, 「·」 glyph 원점에서 다음 글자까지 1em: \
         open_gap={open_gap:.2}, close_gap={close_gap:.2}, line={line_text}"
    );
}

#[test]
fn issue_2020_fsc_hwp_keeps_tail_table_on_page_two() {
    let doc = load_doc("samples/issue2020/(250813) (보도자료) 2025년 7월중 가계대출 동향.hwp");
    let tree = doc
        .build_page_render_tree(1)
        .expect("render FSC HWP page 2");

    assert!(
        has_table(&tree.root, 24, 0),
        "FSC HWP pi=24 14x15 표는 HWPX/한컴 기준처럼 2쪽 하단에 남아야 한다"
    );
}

#[test]
fn issue_2020_bokhak_receipt_seal_line_and_stamp_align() {
    let doc = load_doc("samples/복학원서.hwp");
    let tree = doc
        .build_page_render_tree(0)
        .expect("render bokhak receipt page");
    let svg = doc
        .render_page_svg_native(0)
        .expect("render bokhak receipt SVG");

    assert!(
        svg_line_with_text(&svg, "\u{F012B}").is_some(),
        "날인선은 함초롬바탕의 원형 인 글리프를 유지해야 함"
    );

    let seal_line = find_receipt_seal_line_bbox(&tree.root).expect("원문 PUA 날인선 TextLine");
    let receipt_table = find_table_bbox(&tree.root, 16, 0).expect("pi=16 receipt table");
    assert!(
        seal_line.y < receipt_table.y && seal_line.width > 600.0,
        "날인선은 접수증 표 위 본문 폭에 가깝게 놓여야 함: line={seal_line:?}, table={receipt_table:?}"
    );
    assert!(
        (790.0..=800.0).contains(&receipt_table.y),
        "접수증 TAC 표는 filler line 다음 line-seg 위치에 배치되어야 함: y={:.1}",
        receipt_table.y
    );

    let stamp_text = find_text_bbox(&tree.root, "㊞").expect("receipt stamp text");
    let stamp_circle = find_first_ellipse_bbox(&tree.root).expect("receipt stamp circle");
    let text_cx = stamp_text.x + stamp_text.width / 2.0;
    let text_cy = stamp_text.y + stamp_text.height / 2.0;
    let circle_cx = stamp_circle.x + stamp_circle.width / 2.0;
    let circle_cy = stamp_circle.y + stamp_circle.height / 2.0;
    assert!(
        (609.0..=616.0).contains(&stamp_circle.x)
            && (948.0..=954.0).contains(&stamp_circle.y)
            && (87.0..=92.0).contains(&stamp_circle.width)
            && (82.0..=88.0).contains(&stamp_circle.height),
        "빨간 도장 원은 한컴 PDF 기준 위치/크기를 따라야 함: circle={stamp_circle:?}"
    );
    // [#2509 복원] receipt_date_stamp_shift_px(도장 −21px 핵) 제거 + #2430 메트릭
    // 교정으로 ㊞ 가 오라클 정위치(text x=635.56, Δcx=20.6px)로 복귀 — 한컴 Δcx
    // 20.9px 와 정합. #2510 로 인해 임시 완화했던 상한 40 을 원래 28 로 복원한다
    // (#2509 종결). 20.6px 은 "원 내부 왼쪽" [15,28] 정중앙.
    assert!(
        (15.0..=28.0).contains(&(circle_cx - text_cx)) && (text_cy - circle_cy).abs() <= 8.0,
        "날짜 옆 `㊞`은 빨간 도장 원 중심이 아니라 한컴처럼 원 내부 왼쪽에 놓여야 함: text=({text_cx:.1},{text_cy:.1}) circle=({circle_cx:.1},{circle_cy:.1})"
    );

    let markers = find_filler_glyphs_near(&tree.root, (695.0, 717.0), (1028.0, 1038.0));
    assert_eq!(markers.len(), 2, "표 뒤 두 PUA 점선 글리프가 남아야 함");
    let marker_width = markers[1].x + markers[1].width - markers[0].x;
    assert!(
        (8.0..=16.0).contains(&marker_width)
            && (markers[0].x + markers[0].width - markers[1].x).abs() < 0.01,
        "도장 오른쪽 아래 PUA 점선은 실제 글리프 진행폭으로 이어져야 함: {markers:?}"
    );
}

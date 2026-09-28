//! Issue #1100: HWPX 머리말 안 글상자의 음수 `문단내 위` 위치 보정 회귀 가드.
//!
//! 재현 문서: `samples/hwpx/exam_social.hwpx`.
//! 한컴 편집기는 머리말 문맥에서 `vertRelTo=PARA`, `vertAlign=TOP`, `vertOffset=-13.00mm`
//! 글상자를 위로 올리지 않고 0 offset처럼 배치한다.

use std::fs;
use std::path::Path;

fn load_doc(rel: &str) -> rhwp::wasm_api::HwpDocument {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {}: {}", rel, e));
    rhwp::wasm_api::HwpDocument::from_bytes(&bytes).expect("parse")
}

fn attr_value<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("{name}=\"");
    let start = tag.find(&needle)? + needle.len();
    let rest = &tag[start..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

fn attr_f64(tag: &str, name: &str) -> Option<f64> {
    attr_value(tag, name)?.parse().ok()
}

fn parse_translate(transform: &str) -> Option<(f64, f64)> {
    let start = transform.find("translate(")? + "translate(".len();
    let rest = &transform[start..];
    let end = rest.find(')')?;
    let coords = &rest[..end];
    let mut parts = coords.split(',');
    let x = parts.next()?.trim().parse().ok()?;
    let y = parts.next()?.trim().parse().ok()?;
    Some((x, y))
}

fn has_text_node_at(svg: &str, x: f64, y: f64, text: &str) -> bool {
    svg.split("<text ").skip(1).any(|chunk| {
        let Some(tag_end) = chunk.find('>') else {
            return false;
        };
        let tag = &chunk[..tag_end];
        let Some(transform) = attr_value(tag, "transform") else {
            return false;
        };
        let Some((tx, ty)) = parse_translate(transform) else {
            return false;
        };
        if (tx - x).abs() > 0.01 || (ty - y).abs() > 0.01 {
            return false;
        }

        let rest = &chunk[tag_end + 1..];
        let Some(end) = rest.find("</text>") else {
            return false;
        };
        &rest[..end] == text
    })
}

#[test]
fn issue_1100_hwpx_header_negative_para_offset_clamped_to_header_origin() {
    let doc = load_doc("samples/hwpx/exam_social.hwpx");
    assert_eq!(doc.page_count(), 4, "exam_social.hwpx page count");

    let svg = doc.render_page_svg_native(1).expect("render page 2");
    // Hancom exam_social-2022.pdf p2의 머리말 외곽은 x=56.458pt,
    // 폭=709.744pt다. 레이아웃 폭 888.2px로 정규화하면 번호 원점은
    // (70.744, 120.576)px로, hasMargin=0인 셀의 510/141hu 여백을
    // 더하지 않은 (70.667, 120.547)px와 일치한다. 종전 좌표는 저장된
    // 비활성 cellMargin을 적용해 오른쪽 6.8px, 아래 1.88px로 밀렸다.
    let target_y = svg
        .split("<rect ")
        .skip(1)
        .find_map(|chunk| {
            let end = chunk.find('>')?;
            let tag = &chunk[..end];
            let x = attr_f64(tag, "x")?;
            let width = attr_f64(tag, "width")?;
            let height = attr_f64(tag, "height")?;
            if (x - 70.66666666666667).abs() < 0.01
                && (width - 212.54666666666665).abs() < 0.01
                && (height - 49.13333333333333).abs() < 0.01
            {
                attr_f64(tag, "y")
            } else {
                None
            }
        })
        .expect("page 2 header subject textbox rect");

    assert!(
        (83.0..=87.0).contains(&target_y),
        "header textbox y must be clamped into the header area, got {target_y}"
    );
}

#[test]
fn issue_1100_hwpx_even_header_page_auto_number_replaces_one_placeholder_only() {
    let doc = load_doc("samples/hwpx/exam_social.hwpx");
    assert_eq!(doc.page_count(), 4, "exam_social.hwpx page count");

    let svg = doc.render_page_svg_native(1).expect("render page 2");

    assert!(
        has_text_node_at(&svg, 70.66666666666667, 120.54666666666668, "2"),
        "page auto number must render once at the first placeholder"
    );
    // fwSpace는 번호 원점 + 26.364px다. 비활성 셀 패딩을 제거해도
    // [#1382]의 offsets 축(9) 경계와 charPrIDRef 63 스타일은 유지한다.
    // 번호는 한 번만 치환하고 뒤 fwSpace는 그대로 남아야 한다.
    assert!(
        has_text_node_at(&svg, 97.03066666666668, 120.54666666666668, "\u{2007}"),
        "the full-width space after the page auto number must remain a space"
    );
    assert!(
        !has_text_node_at(&svg, 97.03066666666668, 120.54666666666668, "2"),
        "the full-width space after the page auto number must not be replaced by a second page number"
    );
}

#[test]
fn issue_1100_hwpx_master_page_footer_page_number_is_preserved() {
    let doc = load_doc("samples/hwpx/exam_social.hwpx");
    assert_eq!(doc.page_count(), 4, "exam_social.hwpx page count");

    let svg = doc.render_page_svg_native(1).expect("render page 2");

    // [#2195] x 486.8 → 483.77: 마스터 꼬리말 글상자(표 inMargin 283,283,0,0 +
    // aim=false)의 실효 좌 pad 가 셀 510(#1785) → 표 기본 283(pad 사다리 규칙)으로
    // 정정. 한글 PDF(exam_social-2022 p2) affine 대조: 483.77 예측오차 2.5px <
    // 종전 핀 486.8 오차 5.8px.
    assert!(
        has_text_node_at(&svg, 483.7733333333333, 1406.7600000000002, "2"),
        "master-page footer auto number must remain visible on page 2"
    );
}

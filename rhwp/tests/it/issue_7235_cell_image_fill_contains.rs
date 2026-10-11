//! 칸 배경 그림 채우기 `None`(이진 유형 15)은 정수 퍼센트 Zoom으로 가운데 놓는다 (#7235).
//! Mac 한글 PDF의 1628×563 로고는 11% 배율로 배치한 뒤 칸에 잘린다.

#![cfg(not(target_arch = "wasm32"))]

use std::path::PathBuf;

use rhwp::document_core::DocumentCore;

/// 칸 상자 — 수정 전후 불변이며 render tree Image bbox와 같다.
const CELL_X: f64 = 466.613;
const CELL_Y: f64 = 100.267;
const CELL_W: f64 = 253.373;
const CELL_H: f64 = 57.107;

const IMG_W: f64 = 1628.0;
const IMG_H: f64 = 563.0;

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("samples/issue7235/156467175_press_release_header_logo_p1.hwp")
}

fn page_svg() -> String {
    let bytes = std::fs::read(fixture_path()).expect("fixture 읽기 실패");
    let doc = DocumentCore::from_bytes(&bytes).expect("문서 로드 실패");
    doc.render_page_svg_native(0).expect("1쪽 SVG 렌더 실패")
}

fn image_tags(svg: &str) -> Vec<(f64, f64, f64, f64, String)> {
    let mut out = Vec::new();
    for tag in svg.split("<image ").skip(1) {
        let head = &tag[..tag.find('>').unwrap_or(tag.len())];
        let attr = |name: &str| -> Option<f64> {
            let key = format!("{name}=\"");
            let rest = head.split(&key).nth(1)?;
            rest[..rest.find('"')?].parse::<f64>().ok()
        };
        let par = head
            .split("preserveAspectRatio=\"")
            .nth(1)
            .and_then(|r| r.find('"').map(|e| r[..e].to_string()))
            .unwrap_or_default();
        if let (Some(x), Some(y), Some(w), Some(h)) =
            (attr("x"), attr("y"), attr("width"), attr("height"))
        {
            out.push((x, y, w, h, par));
        }
    }
    out
}

fn cell_fill_image(svg: &str) -> ((f64, f64, f64, f64), (f64, f64, f64, f64), String) {
    let attr = |tag: &str, name: &str| -> Option<f64> {
        let key = format!("{name}=\"");
        let rest = tag.split(&key).nth(1)?;
        rest[..rest.find('"')?].parse().ok()
    };
    for fragment in svg.split("<svg ").skip(1) {
        let Some((viewport, body)) = fragment.split_once('>') else {
            continue;
        };
        let outer = (
            attr(viewport, "x"),
            attr(viewport, "y"),
            attr(viewport, "width"),
            attr(viewport, "height"),
        );
        let (Some(x), Some(y), Some(w), Some(h)) = outer else {
            continue;
        };
        if (x - CELL_X).abs() >= 1.0 || (y - CELL_Y).abs() >= 1.0 {
            continue;
        }
        let image = body
            .split("</svg>")
            .next()
            .and_then(|inner| inner.split("<image ").nth(1))
            .expect("칸 viewport 안에 그림이 있어야 한다");
        let head = image.split('>').next().unwrap_or(image);
        let painted = (
            x + attr(head, "x").unwrap(),
            y + attr(head, "y").unwrap(),
            attr(head, "width").unwrap(),
            attr(head, "height").unwrap(),
        );
        let par = head
            .split("preserveAspectRatio=\"")
            .nth(1)
            .and_then(|s| s.split('"').next())
            .unwrap_or_default()
            .to_string();
        return ((x, y, w, h), painted, par);
    }
    panic!("칸 원점({CELL_X}, {CELL_Y})의 그림 viewport가 없다");
}

#[test]
fn issue_7235_cell_image_fill_none_is_not_drawn_at_original_size() {
    let svg = page_svg();
    let (_, (_, _, w, h), _) = cell_fill_image(&svg);
    assert!(
        (w - IMG_W).abs() > 1.0 && (h - IMG_H).abs() > 1.0,
        "칸 채우기 그림이 원본 픽셀 크기로 그려졌다: {w} x {h}"
    );
    assert!(
        !svg.contains("fill-clip"),
        "칸 채우기가 여전히 배치 모드(fill-clip)로 그려진다"
    );
}

#[test]
fn issue_7235_cell_image_fill_none_uses_percent_zoom_and_cell_viewport() {
    let svg = page_svg();
    let ((x, y, w, h), (paint_x, paint_y, paint_w, paint_h), par) = cell_fill_image(&svg);
    assert_eq!(par, "none");
    assert!((x - CELL_X).abs() < 0.01, "x={x}");
    assert!((y - CELL_Y).abs() < 0.01, "y={y}");
    assert!((w - CELL_W).abs() < 0.01, "width={w}");
    assert!((h - CELL_H).abs() < 0.01, "height={h}");
    let scale = ((w / IMG_W).min(h / IMG_H) * 100.0).ceil() / 100.0;
    assert!((scale - 0.11).abs() < 1e-9);
    assert!((paint_w - IMG_W * scale).abs() < 0.01);
    assert!((paint_h - IMG_H * scale).abs() < 0.01);
    assert!((paint_x - (x + (w - paint_w) / 2.0)).abs() < 0.01);
    assert!((paint_y - y).abs() < 0.01);
}

#[test]
fn issue_7235_drawn_logo_matches_hancom_geometry() {
    let svg = page_svg();
    let (_, (x, y, w, h), _) = cell_fill_image(&svg);
    // Fresh Mac Hancom PDF: xref 18 is at (377.76, 75.12)–(512.16, 121.68) pt.
    // SVG uses 96 dpi CSS coordinates, so the four edges below are ×4/3.
    for (actual, expected) in [(x, 503.68), (y, 100.16), (x + w, 682.88), (y + h, 162.24)] {
        assert!(
            (actual - expected).abs() < 0.2,
            "{actual} vs Mac {expected}"
        );
    }
}

#[test]
fn issue_7235_other_images_on_the_page_are_untouched() {
    let svg = page_svg();
    let others: Vec<_> = image_tags(&svg)
        .into_iter()
        .filter(|(x, y, _, _, _)| (x - 77.467).abs() < 1.0 && (y - 105.46).abs() < 1.0)
        .collect();
    assert_eq!(others.len(), 1, "대조군 그림이 사라졌다");
    for (x, y, w, h, par) in others {
        assert_eq!(
            par, "none",
            "대조군 그림의 채우기 방식이 바뀌었다: ({x}, {y}) {w}x{h} par={par}"
        );
    }
}

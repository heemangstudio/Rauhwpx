//! PR #1019: PageBackground fill mode + RealPic color watermark SVG path guards.
//!
//! 한컴 Mac PDF 실측: 밝기 70·대비 -50 워터마크는 채널마다 `floor(0.5·v + 197)` 로 구운
//! 픽셀을 반투명 없이 그린다. 그래서 구운 PNG 의 불투명 픽셀은 모두 197 이상이다.

use std::path::Path;

use base64::Engine;
use rhwp::wasm_api::HwpDocument;

fn load_doc(rel_path: &str) -> HwpDocument {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(rel_path);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    HwpDocument::from_bytes(&bytes).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

fn svg_png_images(svg: &str) -> Vec<image::RgbaImage> {
    let mut images = Vec::new();
    let mut rest = svg;
    while let Some(found) = rest.find("data:image/png;base64,") {
        let start = found + "data:image/png;base64,".len();
        let end = rest[start..].find('"').map_or(rest.len(), |e| start + e);
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&rest[start..end]) {
            if let Ok(img) = image::load_from_memory(&bytes) {
                images.push(img.to_rgba8());
            }
        }
        rest = &rest[end..];
    }
    images
}

fn assert_realpic_watermark_svg_path(svg: &str, label: &str) {
    assert!(
        !svg.contains("rhwp-img-bc-"),
        "{label}: baked watermark must not add a brightness/contrast SVG filter"
    );
    assert!(
        !svg.contains("data:application/octet-stream"),
        "{label}: image resolver must not fall back to octet-stream"
    );
    assert!(
        !svg.contains("<g opacity=\"0."),
        "{label}: Hancom draws the baked watermark opaque"
    );
    let baked = svg_png_images(svg).into_iter().any(|img| {
        let mut opaque = img.pixels().filter(|px| px.0[3] == 255).peekable();
        opaque.peek().is_some() && opaque.all(|px| px.0[..3].iter().all(|&c| c >= 197))
    });
    assert!(
        baked,
        "{label}: RealPic 70/-50 watermark should be emitted as a Hancom-baked PNG"
    );
}

#[test]
fn issue_1019_143_realpic_page_background_svg_path() {
    let doc = load_doc("samples/143E433F503322BD33.hwp");
    assert!(
        doc.page_count() >= 1,
        "fixture should have at least one page"
    );

    let svg = doc
        .render_page_svg_native(0)
        .expect("render 143E433F503322BD33.hwp page 1");
    assert_realpic_watermark_svg_path(&svg, "143E433F503322BD33 page 1");
}

#[test]
fn issue_1019_253_empty_realpic_svg_path_pages_1_and_2() {
    let doc = load_doc("samples/253E164F57A1BC6934-empty.hwp");
    assert!(
        doc.page_count() >= 2,
        "fixture should have at least two pages"
    );

    for page in 0..2 {
        let svg = doc.render_page_svg_native(page).unwrap_or_else(|e| {
            panic!("render 253E164F57A1BC6934-empty.hwp page {}: {e}", page + 1)
        });
        assert_realpic_watermark_svg_path(
            &svg,
            &format!("253E164F57A1BC6934-empty page {}", page + 1),
        );
    }
}

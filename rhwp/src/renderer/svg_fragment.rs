//! SVG 조각 파서 유틸리티 (Task #275)
//!
//! RenderNodeType::RawSvg 에 담긴 SVG 조각 (shape_layout.rs 가 생성) 을
//! 파싱·디코드하기 위한 문자열 유틸. 네이티브/WASM 양쪽에서 사용 가능.

/// SVG 조각에서 `attr="..."` 값을 추출한다.
///
/// 간단한 속성 추출기 — 따옴표 이스케이프는 지원하지 않으나,
/// rhwp 가 만드는 OLE/EMF/OOXML SVG 조각은 모두 단순 따옴표 속성만 사용한다.
///
/// 단어 경계 보장: 속성명 앞에 공백/탭/개행이 있거나 문자열 선두에 위치할 때만 매칭.
/// (예: `href` 검색 시 `xlink:href` 를 잘못 매칭하지 않도록)
pub(crate) fn find_svg_attr_value<'a>(s: &'a str, attr: &str) -> Option<&'a str> {
    let needle = format!("{}=\"", attr);
    let mut search_from = 0;
    while let Some(idx) = s[search_from..].find(&needle) {
        let pos = search_from + idx;
        let is_boundary = if pos == 0 {
            false
        } else {
            let prev = s.as_bytes()[pos - 1];
            prev == b' ' || prev == b'\t' || prev == b'\n' || prev == b'\r'
        };
        if !is_boundary {
            search_from = pos + needle.len();
            continue;
        }
        let value_start = pos + needle.len();
        let end = s[value_start..].find('"')?;
        return Some(&s[value_start..value_start + end]);
    }
    None
}

/// `<image ... href="data:..." .../>` 단일 요소 조각에서 data URL 추출.
///
/// 조건:
/// - 조각이 `<image` 로 시작하고 `/>` 로 끝남 (trim 후)
/// - 여는 태그 개수 (`<`) 가 정확히 1 (복합 SVG 차단)
/// - `xlink:href` 또는 `href` 속성이 `data:` 스킴
///
/// `xlink:href` 우선 (OLE native_image 경로는 둘 다 동일 값을 넣으므로 무관).
pub(crate) fn try_parse_single_image_data_url(svg: &str) -> Option<&str> {
    let s = svg.trim();
    if !s.starts_with("<image") || !s.ends_with("/>") {
        return None;
    }
    if s.matches('<').count() != 1 {
        return None;
    }
    let href = find_svg_attr_value(s, "xlink:href").or_else(|| find_svg_attr_value(s, "href"))?;
    if !href.starts_with("data:") {
        return None;
    }
    Some(href)
}

/// SVG 프리픽스 감지 — 선행 공백/XML 선언 이후 `<svg` 로 시작하는지.
///
/// RenderNodeType::RawSvg 래퍼 경로에서 생성된 SVG 문서 바이트의 MIME 감지에 사용.
/// (detect_image_mime_type 확장 — Task #275)
pub(crate) fn is_svg_prefix(data: &[u8]) -> bool {
    // 선행 공백 스킵 (최대 64바이트까지만)
    let mut i = 0;
    while i < data.len().min(64) && matches!(data[i], b' ' | b'\t' | b'\n' | b'\r') {
        i += 1;
    }
    if data.len().saturating_sub(i) < 4 {
        return false;
    }
    // `<svg` 직접 시작
    if data[i..].starts_with(b"<svg") {
        return true;
    }
    // `<?xml ... ?>` 선언 후 `<svg`
    if data[i..].starts_with(b"<?xml") {
        // 첫 256바이트 내에 `<svg` 등장하면 SVG 간주
        let search_end = data.len().min(i + 256);
        return data[i..search_end].windows(4).any(|w| w == b"<svg");
    }
    false
}

/// SVG 조각을 완전한 `<svg>` 루트 문서로 래핑한다.
///
/// RenderNodeType::RawSvg 의 조각 (EMF/OOXML 등) 은 좌표계가 **페이지 절대좌표**
/// 이므로, 외부 `<svg>` 의 viewBox 를 bbox 에 맞추고 width/height 도 bbox 크기로
/// 설정하면, 나중에 canvas `drawImage(img, bbox.x, bbox.y, bbox.w, bbox.h)` 로
/// 그릴 때 정확히 원본 좌표 위치에 렌더된다.
pub(crate) fn wrap_svg_fragment(fragment: &str, x: f64, y: f64, w: f64, h: f64) -> String {
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" \
         width=\"{w:.3}\" height=\"{h:.3}\" viewBox=\"{x:.3} {y:.3} {w:.3} {h:.3}\">\n{fragment}\n</svg>"
    )
}

/// `data:MIME;base64,BASE64` 형식 data URL 을 디코드하여 (mime, bytes) 반환.
///
/// 비-base64 data URL (text/plain 등 percent-encoded) 은 지원하지 않고 None 반환.
pub(crate) fn decode_base64_data_url(data_url: &str) -> Option<(String, Vec<u8>)> {
    use base64::Engine;
    let rest = data_url.strip_prefix("data:")?;
    let comma = rest.find(',')?;
    let header = &rest[..comma];
    let payload = &rest[comma + 1..];
    let (mime, is_base64) = if let Some(m) = header.strip_suffix(";base64") {
        (m, true)
    } else {
        (header, false)
    };
    if !is_base64 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()?;
    Some((mime.to_string(), bytes))
}


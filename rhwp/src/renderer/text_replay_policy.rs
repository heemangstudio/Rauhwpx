use super::{contains_old_hangul_jamo, TextStyle};

/// 수학/기하 기호는 대체 글꼴의 넓은 advance에 맞춰 가로로 압축하지 않는다.
/// 결합 문자와 이모지 시퀀스는 브라우저의 클러스터 조형을 유지한다.
pub(crate) fn preserves_symbol_ink_shape(cluster: &str) -> bool {
    let mut chars = cluster.chars();
    let Some(ch) = chars.next() else { return false };
    chars.next().is_none()
        && matches!(ch,
            '\u{2200}'..='\u{22FF}'
            | '\u{25A0}'..='\u{25FF}'
            | '\u{27C0}'..='\u{27EF}'
            | '\u{2980}'..='\u{29FF}'
            | '\u{2A00}'..='\u{2AFF}'
        )
}

/// Canvas 폰트의 실측 폭을 레이아웃 advance에 맞출 때 적용할 배율을 계산한다.
///
/// 음수 자간은 다음 글자의 시작 위치만 당기는 속성이다. 이를 글자 자체의 폭 제한으로
/// 사용하면 한글 glyph가 가로로 눌리므로, 음수 자간에서는 폭 맞춤을 적용하지 않는다.
///
/// 배율은 축소만 한다. 대체 글꼴의 좁은 글자(예: Pretendard의 '1')를 원본 글꼴
/// advance까지 늘리면 획이 그만큼 굵어져 옆 글자와 굵기가 달라 보인다. 남는 폭은
/// 호출부가 슬롯 안에서 가운데 정렬로 처리한다.
pub(crate) fn canvas_cluster_fit_scale(
    cluster_advance: f64,
    visual_width: f64,
    letter_spacing: f64,
    pin_ascii_advance: bool,
) -> Option<f64> {
    if cluster_advance <= 0.0 || visual_width <= 0.0 || letter_spacing < 0.0 {
        return None;
    }
    if pin_ascii_advance {
        return (visual_width > cluster_advance)
            .then(|| (cluster_advance / visual_width).clamp(0.1, 1.0));
    }
    if visual_width > cluster_advance + 0.25 {
        return Some((cluster_advance / visual_width).clamp(0.1, 1.0));
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct CanvasClusterTransform {
    pub(crate) scale_x: f64,
    pub(crate) scale_y: f64,
    pub(crate) offset_x: f64,
    pub(crate) offset_y: f64,
}

/// 대체 글꼴의 좌우 여백 때문에 advance가 커졌다면 실제 잉크를 원래 슬롯 중앙에
/// 놓는다. 잉크 자체가 넘칠 때만 균등 축소하고, 문서 장평은 가로축에 별도로 적용한다.
pub(crate) fn canvas_symbol_fit_transform(
    cluster_advance: f64,
    measured_advance: f64,
    ink_bounds: (f64, f64, f64, f64),
    ratio: f64,
    letter_spacing: f64,
) -> Option<CanvasClusterTransform> {
    let (left, right, ascent, descent) = ink_bounds;
    let ink_width = left + right;
    if ![
        cluster_advance,
        measured_advance,
        left,
        right,
        ascent,
        descent,
        ratio,
    ]
    .iter()
    .all(|v| v.is_finite())
        || ratio <= 0.0
        || ink_width <= 0.0
        || ascent + descent <= 0.0
    {
        return None;
    }
    canvas_cluster_fit_scale(
        cluster_advance,
        measured_advance * ratio,
        letter_spacing,
        false,
    )?;
    let scale = (cluster_advance / (ratio * ink_width)).min(1.0);
    let center_x = (right - left) / 2.0;
    let center_y = (descent - ascent) / 2.0;
    Some(CanvasClusterTransform {
        scale_x: ratio * scale,
        scale_y: scale,
        offset_x: cluster_advance / 2.0 - ratio * scale * center_x,
        offset_y: (1.0 - scale) * center_y,
    })
}

/// Canvas 2D cannot paint a Rust-shaped glyph-id stream. Keep its text fallback
/// as one browser-shaped run when that preserves the same kerning and ligature
/// boundaries. Runs that need per-character placement stay on the legacy path.
pub(crate) fn canvas_uses_native_run_shaping(
    has_positioned_glyph_sidecar: bool,
    text: &str,
    style: &TextStyle,
) -> bool {
    has_positioned_glyph_sidecar
        && style.kerning
        && style.letter_spacing.abs() <= f64::EPSILON
        && style.extra_char_spacing.abs() <= f64::EPSILON
        && style.extra_word_spacing.abs() <= f64::EPSILON
        && style.extra_dash_advance.abs() <= f64::EPSILON
        && !contains_old_hangul_jamo(text)
        && !super::layout::split_into_clusters(text)
            .iter()
            .any(|(_, cluster)| preserves_symbol_ink_shape(cluster))
        && !text.chars().any(|ch| {
            matches!(
                ch,
                '\t' | '\u{2007}' | '\u{20A9}' | '\u{20AC}' | '\u{00A3}' | '\u{00A5}' | '\u{2018}'
                    ..='\u{2027}' | '\u{00B7}' | '\u{300C}' | '\u{300D}'
            ) || (ch < '\u{0020}' && !matches!(ch, '\n' | '\r'))
        })
}

/// Canvas 2D exposes Unicode shaping through `fillText`, but has no API for
/// painting the glyph ids and offsets carried by a positioned glyph sidecar.
pub(crate) const fn web_canvas_supports_positioned_glyph_replay() -> bool {
    false
}


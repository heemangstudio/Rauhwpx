//! 한컴 수식 스크립트 파싱 및 렌더링
//!
//! 수식 스크립트(버전 6.0)를 토큰화하고 AST로 변환한 뒤 SVG로 렌더링한다.
//! 참조: openhwp/docs/hwpx/appendix-i-formula.md

pub mod ast;
pub mod canonical;
#[cfg(target_arch = "wasm32")]
pub mod canvas_render;
pub(crate) mod font;
pub mod layout;
pub(crate) mod legacy_hwpeq;
pub(crate) mod measure;
pub mod parser;
pub mod svg_render;
pub mod symbols;
pub mod tokenizer;

/// 개체 공통 너비는 바깥 여백을 제외한 값이다. 인라인 슬롯에 양쪽 여백을 예약한다.
pub(crate) fn occupied_width_hwp(eq: &crate::model::control::Equation) -> i32 {
    (i64::from(eq.common.width)
        + i64::from(eq.common.margin.left)
        + i64::from(eq.common.margin.right))
    .clamp(0, i64::from(i32::MAX)) as i32
}

/// EQEDIT baseLine은 저장된 개체 높이의 백분율이다. 없는 값만 자연 기준선으로 보완한다.
pub(crate) fn control_baseline_hwp(eq: &crate::model::control::Equation, natural: f64) -> f64 {
    if eq.common.height > 0 && (1..=100).contains(&eq.baseline) {
        f64::from(eq.common.height) * f64::from(eq.baseline) / 100.0
    } else {
        natural
    }
}

/// The equation's ink box may extend below its line box. When `affectLSpacing` is
/// false, its lower script overhang does not enlarge the line; a superscript
/// above EqLayout's ordinary 0.8em ascent still needs room. The authored object
/// height is combined with this result by the caller.
pub(crate) fn line_flow_height(
    natural_height: f64,
    natural_baseline: f64,
    em: f64,
    affect_line_spacing: bool,
) -> f64 {
    if affect_line_spacing || em <= 0.0 {
        natural_height
    } else {
        em + (natural_baseline - em * 0.8).max(0.0)
    }
}

/// Older HFT controls retain their established full natural box. The reduced
/// lower overhang belongs to modern EQEDIT layout.
pub(crate) fn control_line_flow_height(
    eq: &crate::model::control::Equation,
    natural_height: f64,
    natural_baseline: f64,
    em: f64,
) -> f64 {
    let modern_hy_face = eq.version_info == "Equation Version 60"
        && font::is_legacy_equation_font(&eq.font_name)
        && (crate::renderer::runtime_font_metrics::line_height_ratio(&eq.font_name, false, false)
            .is_some()
            || {
                #[cfg(not(target_arch = "wasm32"))]
                {
                    crate::renderer::font_paths::custom_face_line_height_ratio(
                        &eq.font_name,
                        false,
                        false,
                    )
                    .is_some()
                }
                #[cfg(target_arch = "wasm32")]
                {
                    false
                }
            });
    if !modern_hy_face {
        natural_height
    } else {
        line_flow_height(
            natural_height,
            natural_baseline,
            em,
            eq.common.affect_line_spacing,
        )
    }
}

/// Occupied ascent and descent of one inline equation at its source anchor.
pub(crate) fn control_flow_ascent_descent_px(
    eq: &crate::model::control::Equation,
    dpi: f64,
) -> (f64, f64) {
    let metrics = intrinsic_metrics_px_with_version(
        &eq.script,
        eq.font_size,
        dpi,
        &eq.font_name,
        &eq.version_info,
    );
    let stored_height = crate::renderer::hwpunit_to_px(eq.common.height as i32, dpi);
    let flow_height = control_line_flow_height(
        eq,
        metrics.height,
        metrics.baseline,
        crate::renderer::hwpunit_to_px(eq.font_size as i32, dpi),
    );
    let anchor = control_baseline_hwp(eq, metrics.baseline * 7200.0 / dpi) * dpi / 7200.0;
    (
        anchor + crate::renderer::hwpunit_to_px(eq.common.margin.top as i32, dpi),
        stored_height.max(flow_height) - anchor
            + crate::renderer::hwpunit_to_px(eq.common.margin.bottom as i32, dpi),
    )
}

/// Occupied ascent and descent for equations attached to one composed line.
/// Table measurement must use the same box that paragraph paint uses; the
/// generated LineSeg can still contain its pre-import em height.
pub(crate) fn composed_line_flow_height_px(
    para: &crate::model::paragraph::Paragraph,
    composed: &crate::renderer::composer::ComposedParagraph,
    line_index: usize,
    dpi: f64,
) -> Option<f64> {
    use crate::model::control::Control;
    use crate::model::paragraph::LineSeg;
    // Authored line boxes already incorporate their equation occupancy. Paint
    // trusts those metrics, whereas implementation-property LineSegs are
    // regenerated from the currently available equation face.
    if para.line_segs.is_empty()
        || !para.text.trim().is_empty()
        || para.controls.len() != 1
        || para
            .line_segs
            .iter()
            .any(|line| line.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY == 0)
    {
        return None;
    }
    let mut max_ascent = 0.0f64;
    let mut max_descent = 0.0f64;
    let mut found = false;
    for control in composed
        .inline_controls
        .iter()
        .filter(|control| control.line_index == line_index)
    {
        let Some(Control::Equation(eq)) = para.controls.get(control.control_index) else {
            continue;
        };
        if !eq.common.treat_as_char {
            continue;
        }
        let (ascent, descent) = control_flow_ascent_descent_px(eq, dpi);
        max_ascent = max_ascent.max(ascent);
        max_descent = max_descent.max(descent);
        found = true;
    }
    found.then_some(max_ascent + max_descent)
}

/// Natural equation box metrics in the renderer's pixel coordinate system.
///
/// Inline layout must use the same ascent/descent as the painter.  Deriving a
/// baseline from an arbitrary fraction of object height moves tall operators.
/// An authored EQEDIT baseline remains a separate placement contract.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IntrinsicMetrics {
    pub width: f64,
    pub height: f64,
    pub baseline: f64,
}

/// Measure an EqEdit script with the exact parser/layout path used for paint.
pub fn intrinsic_metrics_px(script: &str, font_size: u32, dpi: f64) -> IntrinsicMetrics {
    intrinsic_metrics_px_with_font(script, font_size, dpi, "")
}

pub fn intrinsic_metrics_px_with_font(
    script: &str,
    font_size: u32,
    dpi: f64,
    font_name: &str,
) -> IntrinsicMetrics {
    intrinsic_metrics_px_with_version(script, font_size, dpi, font_name, "Equation Version 60")
}

pub fn intrinsic_metrics_px_with_version(
    script: &str,
    font_size: u32,
    dpi: f64,
    font_name: &str,
    version_info: &str,
) -> IntrinsicMetrics {
    let font_size_px = super::hwpunit_to_px(font_size.max(1) as i32, dpi);
    let tokens = tokenizer::tokenize(script);
    let ast = parser::EqParser::new(tokens).parse();
    let layout = layout::EqLayout::with_font(font_size_px, font_name)
        .with_version(version_info)
        .layout(&ast);
    IntrinsicMetrics {
        width: layout.width,
        height: layout.height,
        baseline: layout.baseline,
    }
}

/// The fraction box includes a trailing rule clearance for paint. A generated
/// inline equation with `affectLSpacing=0` can let that clearance overhang its
/// occupied line. Other nuclei in the same row still determine the line bottom.
fn fraction_occupied_bottom(box_: &layout::LayoutBox, pad: f64) -> Option<f64> {
    use layout::LayoutKind;

    match &box_.kind {
        LayoutKind::Fraction { .. } => Some((box_.height - pad).max(0.0)),
        LayoutKind::Row(children) => {
            let mut contains_fraction = false;
            let bottom = children.iter().fold(0.0_f64, |bottom, child| {
                let flow = fraction_occupied_bottom(child, pad);
                contains_fraction |= flow.is_some();
                bottom.max(child.y + flow.unwrap_or(child.height))
            });
            contains_fraction.then_some(bottom)
        }
        LayoutKind::Paren { body, .. }
        | LayoutKind::FontStyle { body, .. }
        | LayoutKind::Decoration { body, .. } => {
            let body_bottom = fraction_occupied_bottom(body, pad)? + body.y;
            let own_bottom = (box_.height > body.y + body.height + 0.01)
                .then_some(box_.height)
                .unwrap_or(0.0);
            Some(body_bottom.max(own_bottom))
        }
        _ => None,
    }
}

pub(crate) fn generated_fraction_flow_height_px(
    script: &str,
    font_size: u32,
    dpi: f64,
    font_name: &str,
    version_info: &str,
) -> Option<f64> {
    let em = super::hwpunit_to_px(font_size.max(1) as i32, dpi);
    let ast = parser::EqParser::new(tokenizer::tokenize(script)).parse();
    let box_ = layout::EqLayout::with_font(em, font_name)
        .with_version(version_info)
        .layout(&ast);
    fraction_occupied_bottom(&box_, em * layout::FRAC_LINE_PAD)
}

/// 저장 개체 폭 안에 배치한 수식의 실제 paint 폭(HWPUNIT).
///
/// painter는 `layout_in_control_width`로 원자 간격을 줄여 저장 폭에 맞춘다. 최소 간격으로도
/// 넘칠 때만 자연 폭이 저장 폭보다 커지며, 줄 advance는 그 초과분만 더해야 한다.
pub fn fitted_width_hwp(eq: &crate::model::control::Equation) -> u32 {
    let font_size_px = super::hwpunit_to_px(eq.font_size.max(1) as i32, super::DEFAULT_DPI);
    let ast = parser::EqParser::new(tokenizer::tokenize(&eq.script)).parse();
    let stored = super::hwpunit_to_px(eq.common.width as i32, super::DEFAULT_DPI);
    let layout = layout::EqLayout::with_font(font_size_px, &eq.font_name)
        .with_version(&eq.version_info)
        .layout_in_control_width(&ast, stored);
    super::px_to_hwpunit(layout.width, super::DEFAULT_DPI).max(1) as u32
}

/// Natural equation box metrics in HWPUNIT, used by line composition.
pub fn intrinsic_metrics_hwp(script: &str, font_size: u32) -> (u32, u32, u32) {
    intrinsic_metrics_hwp_with_font(script, font_size, "")
}

pub fn intrinsic_metrics_hwp_with_font(
    script: &str,
    font_size: u32,
    font_name: &str,
) -> (u32, u32, u32) {
    intrinsic_metrics_hwp_with_version(script, font_size, font_name, "Equation Version 60")
}

pub fn intrinsic_metrics_hwp_with_version(
    script: &str,
    font_size: u32,
    font_name: &str,
    version_info: &str,
) -> (u32, u32, u32) {
    let metrics = intrinsic_metrics_px_with_version(
        script,
        font_size,
        super::DEFAULT_DPI,
        font_name,
        version_info,
    );
    let height = super::px_to_hwpunit(metrics.height, super::DEFAULT_DPI).max(1) as u32;
    let baseline =
        super::px_to_hwpunit(metrics.baseline, super::DEFAULT_DPI).clamp(0, height as i32) as u32;
    (
        super::px_to_hwpunit(metrics.width, super::DEFAULT_DPI).max(1) as u32,
        height,
        baseline,
    )
}

/// 수식 스크립트와 BaseUnit에서 레이아웃이 소비할 intrinsic HWPUNIT 크기를 계산한다.
pub fn intrinsic_size_hwp(script: &str, font_size: u32) -> (u32, u32) {
    let (width, height, _) = intrinsic_metrics_hwp(script, font_size);
    (width, height)
}

pub fn intrinsic_size_hwp_with_font(script: &str, font_size: u32, font_name: &str) -> (u32, u32) {
    let (width, height, _) = intrinsic_metrics_hwp_with_font(script, font_size, font_name);
    (width, height)
}

#[cfg(test)]
mod metric_tests {
    use super::*;

    #[test]
    fn fraction_clearance_does_not_shrink_a_neighboring_nucleus() {
        use layout::{LayoutBox, LayoutKind};

        let leaf = |height| LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height,
            baseline: height * 0.8,
            kind: LayoutKind::Text("x".to_string()),
        };
        let fraction = LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 24.4,
            baseline: 14.7,
            kind: LayoutKind::Fraction {
                numer: Box::new(leaf(10.0)),
                denom: Box::new(leaf(10.0)),
                bar_inset: 0.0,
            },
        };
        let row = LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: 20.0,
            height: 24.4,
            baseline: 14.7,
            kind: LayoutKind::Row(vec![fraction, leaf(23.4)]),
        };
        assert_eq!(fraction_occupied_bottom(&row, 2.0), Some(23.4));
    }

    #[test]
    fn source_control_metrics_keep_margins_baseline_and_natural_glyph_size_separate() {
        use crate::model::{control::Equation, Padding};
        let mut eq = Equation::default();
        eq.common.width = 3000;
        eq.common.height = 2400;
        eq.common.margin = Padding {
            left: 75,
            right: 150,
            top: 100,
            bottom: 200,
        };
        eq.baseline = 65;
        assert_eq!(occupied_width_hwp(&eq), 3225);
        assert_eq!(control_baseline_hwp(&eq, 1700.0), 1560.0);
        eq.baseline = 0;
        assert_eq!(control_baseline_hwp(&eq, 1700.0), 1700.0);
        eq.baseline = 101;
        assert_eq!(control_baseline_hwp(&eq, 1700.0), 1700.0);
        let ast = parser::EqParser::new(tokenizer::tokenize("x over L")).parse();
        for version in ["", "Equation Version 60"] {
            let engine = layout::EqLayout::with_font(16.0, "HYhwpEQ").with_version(version);
            let natural = engine.layout(&ast);
            let placed = engine.layout_in_control_width(&ast, natural.width + 12.0);
            // 한컴은 저장 폭보다 짧은 수식을 가운데 정렬하지 않고 좌측에 둔다
            // (eq-002 실측).
            assert_eq!(placed.x, 0.0);
            assert_eq!(placed.width, natural.width);
            assert_eq!(placed.height, natural.height);
            assert_eq!(placed.baseline, natural.baseline);
            assert_eq!(
                engine.layout_in_control_width(&ast, natural.width - 2.0).x,
                0.0
            );
        }
    }

    #[test]
    fn big_operator_exposes_its_real_baseline() {
        let (_, height, baseline) = intrinsic_metrics_hwp("W = sum_{i=1}^{n} u_i", 1000);

        assert!(baseline > 0 && baseline < height);
        assert!(
            baseline < (height as f64 * 0.85).round() as u32,
            "a summation baseline must not be synthesized from 85% of its total height"
        );
    }

    #[test]
    fn lower_ink_overhang_changes_flow_only_when_requested() {
        let em = 10.0;
        let ascent_with_superscript = 9.8;
        assert_eq!(
            line_flow_height(11.8, ascent_with_superscript, em, false),
            11.8
        );
        assert_eq!(
            line_flow_height(13.6, ascent_with_superscript, em, false),
            11.8
        );
        assert_eq!(
            line_flow_height(13.6, ascent_with_superscript, em, true),
            13.6
        );
    }
    #[test]
    fn reduced_flow_requires_a_loaded_modern_hy_face() {
        struct ClearFontMetrics;
        impl Drop for ClearFontMetrics {
            fn drop(&mut self) {
                crate::renderer::runtime_font_metrics::clear();
            }
        }
        let _clear_font_metrics = ClearFontMetrics;
        let mut eq = crate::model::control::Equation::default();
        eq.common.affect_line_spacing = false;
        eq.font_name = "UnloadedEquationFace".to_string();
        assert_eq!(control_line_flow_height(&eq, 13.6, 9.8, 10.0), 13.6);
        crate::renderer::runtime_font_metrics::register(
            include_bytes!("../../../tests/fixtures/fonts/RHWPShapingFixture.ttf"),
            &["HYhwpEQ".to_string()],
            false,
            false,
        )
        .expect("register equation face metrics");
        eq.font_name = "HYhwpEQ".to_string();
        assert_eq!(control_line_flow_height(&eq, 13.6, 9.8, 10.0), 11.8);
        eq.version_info.clear();
        assert_eq!(control_line_flow_height(&eq, 13.6, 9.8, 10.0), 13.6);
        eq.version_info = "Equation Version 60".to_string();
        eq.font_name = "OtherEquationFace".to_string();
        assert_eq!(control_line_flow_height(&eq, 13.6, 9.8, 10.0), 13.6);
    }
}

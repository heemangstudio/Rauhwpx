//! 수식 SVG 렌더러
//!
//! LayoutBox를 SVG 요소로 변환한다.
//! 생성된 SVG 조각은 `<g>` 요소 내부에 포함된다.

use super::ast::MatrixStyle;
use super::layout::*;
use super::symbols::{DecoKind, FontStyleKind};

/// 수식 전용 font-family
/// 순서: Latin Modern Math (LaTeX 설치 시) → STIX Two Text (Mac/STIX 설치 시) → STIX Two Math → Times New Roman (Windows 기본) → serif
/// Cambria Math 는 Windows 에서 "볼드 인상" 을 유발해 제외. Pretendard 는 산세리프라 수식 부적합으로 제외. (Task #280)
pub const DEFAULT_EQUATION_FONT_FAMILY_ATTR: &str =
    "font-family=\"'Latin Modern Math', 'STIX Two Text', 'STIX Two Math', 'Times New Roman', 'Times', serif\"";
const EQ_FONT_FAMILY: &str = "";
const TRACKING: f64 = super::font::EQUATION_GLYPH_TRACKING;

/// 수식을 SVG 조각 문자열로 렌더링
///
/// 진입점 default: italic=true (hwpeq 변수 기본 스타일). FontStyle::Roman(`rm`)
/// 적용 영역에서는 자식 렌더링 시 italic=false 로 전환된다.
pub fn render_equation_svg(layout: &LayoutBox, color: &str, base_font_size: f64) -> String {
    render_equation_svg_with_font(layout, color, base_font_size, None)
}

pub fn render_equation_svg_with_font(
    layout: &LayoutBox,
    color: &str,
    base_font_size: f64,
    font_name: Option<&str>,
) -> String {
    render_equation_svg_with_font_and_version(layout, color, base_font_size, font_name, "")
}

struct EquationSvgFont<'a> {
    /// 등록된 HYhwpEQ face — 있으면 네이티브 painter와 같은 HY 글립으로 칠한다.
    pua_font: Option<&'a str>,
    modern: bool,
    modern_hy: bool,
    stix_integral: bool,
    /// Unicode fallback font-family 체인 (escape된 속성 값).
    css_family: String,
}

fn stix_integral_available() -> bool {
    crate::renderer::runtime_font_metrics::char_em_advance("STIXGeneral", false, false, '∫')
        .or_else(|| {
            #[cfg(not(target_arch = "wasm32"))]
            {
                crate::renderer::font_paths::custom_face_char_em_advance(
                    "STIXGeneral",
                    false,
                    false,
                    '∫',
                )
            }
            #[cfg(target_arch = "wasm32")]
            {
                None
            }
        })
        .is_some_and(|advance| advance > 0.0)
}

/// 등록된 원본 수식 서체(HYhwpEQ)의 글립 advance(em). cmap에 없으면 None.
fn legacy_glyph_em_advance(name: &str, ch: char) -> Option<f64> {
    crate::renderer::runtime_font_metrics::char_em_advance(name, false, false, ch)
        .or_else(|| {
            #[cfg(not(target_arch = "wasm32"))]
            {
                crate::renderer::font_paths::custom_face_char_em_advance(name, false, false, ch)
            }
            #[cfg(target_arch = "wasm32")]
            {
                None
            }
        })
        .filter(|advance| advance.is_finite() && *advance > 0.0)
}

fn sqrt_pua_font(font_name: Option<&str>) -> Option<&str> {
    let name = font_name.filter(|name| super::font::is_legacy_equation_font(name))?;
    let available = |ch| legacy_glyph_em_advance(name, ch).is_some();
    // SVG 글꼴 조회도 실제 TTF의 family 이름 대소문자와 일치시킨다.
    (available('\u{e05c}') && available('\u{e06d}')).then_some("HyhwpEQ")
}

/// skia `set_skew_x(-0.2)`와 같은 합성 기울임 (x' = x − 0.2·y).
const PUA_SYNTHETIC_SKEW: f64 = -0.2;

/// skia 합성 굵기(`set_embolden`)의 윤곽 확장 비율 — 9pt 이하 1/24, 36pt 이상 1/32.
fn fake_bold_stroke_width(size: f64) -> f64 {
    let t = ((size - 9.0) / (36.0 - 9.0)).clamp(0.0, 1.0);
    size * (1.0 / 24.0 + (1.0 / 32.0 - 1.0 / 24.0) * t)
}

fn pua_paint_attrs(color: &str, bold: bool, size: f64) -> String {
    if bold {
        format!(
            "fill=\"{color}\" stroke=\"{color}\" stroke-width=\"{:.4}\"",
            fake_bold_stroke_width(size)
        )
    } else {
        format!("fill=\"{color}\"")
    }
}

/// 네이티브 painter(`skia::equation_conv::draw_text_tracked`)와 같은 HY 글립 경로.
///
/// 한컴은 수식 글립을 모두 HYhwpEQ로 칠한다 — 숫자·연산자·이탤릭 변수는 PUA cmap,
/// 로만 글자는 본문 ASCII cmap. 서체가 등록되어 있고 모든 글립을 덮을 때만 칠하며,
/// 진행폭은 원본 advance × `tracking`, 현대 수식 글립은 원점 기준선 이동을 함께 적용한다.
/// 칠하지 못하면 false — 호출자가 Unicode fallback으로 돌아간다.
#[allow(clippy::too_many_arguments)]
fn push_pua_text(
    svg: &mut String,
    font: &EquationSvgFont<'_>,
    text: &str,
    x: f64,
    baseline_y: f64,
    size: f64,
    italic: bool,
    bold: bool,
    color: &str,
    centered: bool,
    tracking: f64,
) -> bool {
    let Some(family) = font.pua_font else {
        return false;
    };
    if text.is_empty() {
        return false;
    }
    let mut glyphs: Vec<(char, bool, f64, f64)> = Vec::with_capacity(text.len());
    for c in text.chars() {
        let (glyph, skew) = super::font::legacy_equation_glyph(c, italic, font.modern);
        let advance = match legacy_glyph_em_advance(family, glyph) {
            Some(advance) => advance,
            None if glyph.is_whitespace() => 0.25,
            None => return false,
        };
        let shift = if font.modern {
            super::font::modern_glyph_baseline_em(c, italic)
        } else {
            0.0
        };
        glyphs.push((glyph, skew, shift, advance * size * tracking));
    }
    let width: f64 = glyphs.iter().map(|g| g.3).sum();
    let mut pen = x - if centered { width / 2.0 } else { 0.0 };
    let paint = pua_paint_attrs(color, bold, size);
    let mut start = 0;
    while start < glyphs.len() {
        let (_, skew, shift, _) = glyphs[start];
        let end = glyphs[start..]
            .iter()
            .position(|g| g.1 != skew || g.2 != shift)
            .map_or(glyphs.len(), |offset| start + offset);
        let run = &glyphs[start..end];
        let origin_y = baseline_y + shift * size;
        let mut offsets = Vec::with_capacity(run.len());
        let mut dx = 0.0;
        for glyph in run {
            offsets.push(format!("{dx:.4}"));
            dx += glyph.3;
        }
        let content: String = run.iter().map(|g| g.0).collect();
        svg.push_str(&format!(
            "<text transform=\"matrix(1 0 {:.4} 1 {:.4} {:.4})\" x=\"{}\" y=\"0\" font-family=\"{}\" font-size=\"{:.4}\" font-style=\"normal\" font-weight=\"normal\" {}>{}</text>\n",
            if skew { PUA_SYNTHETIC_SKEW } else { 0.0 },
            pen,
            origin_y,
            offsets.join(" "),
            escape_xml(family),
            size,
            paint,
            escape_xml(&content),
        ));
        pen += dx;
        start = end;
    }
    true
}

/// HY 글립 하나를 칠하고, `advance_w`가 자연 폭과 2% 넘게 다르면 가로로만 늘린다
/// (네이티브 `draw_legacy_pua_glyph`).
#[allow(clippy::too_many_arguments)]
fn push_pua_glyph(
    svg: &mut String,
    font: &EquationSvgFont<'_>,
    glyph: char,
    x: f64,
    baseline_y: f64,
    size: f64,
    advance_w: Option<f64>,
    color: &str,
) -> bool {
    let Some(family) = font.pua_font else {
        return false;
    };
    let Some(advance) = legacy_glyph_em_advance(family, glyph) else {
        return false;
    };
    let natural = advance * size;
    let scale_x = match advance_w {
        Some(width) if (width - natural).abs() / natural > 0.02 => width / natural,
        _ => 1.0,
    };
    svg.push_str(&format!(
        "<text transform=\"matrix({:.4} 0 0 1 {:.4} {:.4})\" x=\"0\" y=\"0\" font-family=\"{}\" font-size=\"{:.4}\" font-style=\"normal\" font-weight=\"normal\" fill=\"{}\">{}</text>\n",
        scale_x, x, baseline_y, escape_xml(family), size, color, glyph,
    ));
    true
}

/// HY 글립을 잉크 사각형(`target` = x, 위 y, 폭, 높이)에 맞춰 칠한다. 세로는 잉크가
/// 높이를 덮도록, 가로는 폭에 맞춰 늘린다 (네이티브 `draw_legacy_pua_glyph_scaled`).
fn push_pua_glyph_scaled(
    svg: &mut String,
    font: &EquationSvgFont<'_>,
    glyph: char,
    ink_em: (f64, f64, f64, f64),
    target: (f64, f64, f64, f64),
    color: &str,
) -> bool {
    let Some(family) = font.pua_font else {
        return false;
    };
    if legacy_glyph_em_advance(family, glyph).is_none() {
        return false;
    }
    let (x0, y0, x1, y1) = ink_em;
    let (tx, ty, tw, th) = target;
    let (ink_w, ink_h) = (x1 - x0, y1 - y0);
    if ink_w <= 0.0 || ink_h <= 0.0 || tw <= 0.0 || th <= 0.0 {
        return false;
    }
    let s = th / ink_h;
    let xs = tw / (ink_w * s);
    svg.push_str(&format!(
        "<text transform=\"matrix({:.4} 0 0 1 {:.4} {:.4})\" x=\"0\" y=\"0\" font-family=\"{}\" font-size=\"{:.4}\" font-style=\"normal\" font-weight=\"normal\" fill=\"{}\">{}</text>\n",
        xs,
        tx - xs * x0 * s,
        ty + y1 * s,
        escape_xml(family),
        s,
        color,
        glyph,
    ));
    true
}

/// HY 큰 대괄호: e100/e101/e103(좌)·e102/e105/e104(우) 파트 쌓기
/// (네이티브 `draw_legacy_square_bracket`, 02-eq-01 실측).
#[allow(clippy::too_many_arguments)]
fn push_pua_square_bracket(
    svg: &mut String,
    font: &EquationSvgFont<'_>,
    left: bool,
    x: f64,
    ty: f64,
    th: f64,
    fs: f64,
    color: &str,
) -> bool {
    let (top_g, mid_g, bot_g) = if left {
        ('\u{e100}', '\u{e101}', '\u{e103}')
    } else {
        ('\u{e102}', '\u{e105}', '\u{e104}')
    };
    let Some(family) = font.pua_font else {
        return false;
    };
    if th <= 0.0
        || [top_g, mid_g, bot_g]
            .iter()
            .any(|g| legacy_glyph_em_advance(family, *g).is_none())
    {
        return false;
    }
    let s = fs;
    push_pua_glyph(svg, font, top_g, x, ty + 0.733 * s, s, None, color);
    push_pua_glyph(svg, font, bot_g, x, ty + th - 0.152 * s, s, None, color);
    let top_ink_bottom = ty + 0.941 * s;
    let bot_ink_top = ty + th - 0.944 * s;
    let span = (bot_ink_top - top_ink_bottom).max(0.0);
    let n = ((span + s * 0.2) / (s * 0.7)).ceil().max(1.0) as i32;
    for i in 0..n {
        let center = top_ink_bottom + span * (f64::from(i) + 0.5) / f64::from(n);
        push_pua_glyph(svg, font, mid_g, x, center + 0.292 * s, s, None, color);
    }
    true
}

/// e044 '(' / e045 ')' 의 잉크 경계(em). HyhwpEQ 실측값.
fn paren_glyph_ink(bracket: &str) -> ((f64, f64, f64, f64), char) {
    if bracket == "(" {
        ((0.0996, -0.2021, 0.3369, 0.8066), '\u{e044}')
    } else {
        ((0.0508, -0.2031, 0.2881, 0.8066), '\u{e045}')
    }
}

/// e04b '{' / e04c '}' 의 잉크 경계(em, 1024 단위 실측).
const BRACE_INK_EM: (f64, f64, f64, f64) = (
    113.0 / 1024.0,
    -203.0 / 1024.0,
    446.0 / 1024.0,
    821.0 / 1024.0,
);

/// 현대 HY 일반 중괄호 묶음은 e04b/e04c의 가로 잉크 폭을 기본 글자 크기로 유지하고
/// 세로만 본문 높이로 늘린다 (네이티브 `brace_glyph`).
#[allow(clippy::too_many_arguments)]
fn push_pua_brace(
    svg: &mut String,
    font: &EquationSvgFont<'_>,
    glyph: char,
    gx: f64,
    y: f64,
    lb: &LayoutBox,
    body: &LayoutBox,
    fs: f64,
    color: &str,
) -> bool {
    let layout_height = lb.height.max(fs);
    let ink_height = super::layout::content_bottom(body)
        .max(fs)
        .min(layout_height);
    let baseline = y + lb.height / 2.0 + layout_height * 0.309;
    push_pua_glyph_scaled(
        svg,
        font,
        glyph,
        BRACE_INK_EM,
        (
            gx + fs * 113.0 / 1024.0,
            baseline - layout_height * 821.0 / 1024.0,
            fs * 333.0 / 1024.0,
            ink_height,
        ),
        color,
    )
}

/// `push_pua_text`가 이 글자들을 HY 글립으로 칠하는지.
fn pua_covers(font: &EquationSvgFont<'_>, text: &str, italic: bool) -> bool {
    font.pua_font.is_some_and(|family| {
        text.chars().all(|c| {
            let glyph = super::font::legacy_equation_glyph(c, italic, font.modern).0;
            glyph.is_whitespace() || legacy_glyph_em_advance(family, glyph).is_some()
        })
    })
}

/// HY 경로를 먼저 시도하고, 못 칠하면 Unicode 글자로 칠한다.
#[allow(clippy::too_many_arguments)]
fn push_text(
    svg: &mut String,
    font: &EquationSvgFont<'_>,
    text: &str,
    x: f64,
    baseline_y: f64,
    size: f64,
    italic: bool,
    bold: bool,
    color: &str,
) {
    if push_pua_text(
        svg,
        font,
        text,
        x,
        baseline_y,
        size,
        italic,
        bold,
        color,
        false,
        super::font::EQUATION_GLYPH_TRACKING,
    ) {
        return;
    }
    let style = if italic { " font-style=\"italic\"" } else { "" };
    let weight = if bold { " font-weight=\"bold\"" } else { "" };
    svg.push_str(&format!(
        "<text x=\"{:.2}\" y=\"{:.2}\" font-size=\"{:.2}\" fill=\"{}\"{}{}>{}</text>\n",
        x,
        baseline_y,
        size,
        color,
        style,
        weight,
        escape_xml(text),
    ));
}

pub fn render_equation_svg_with_font_and_version(
    layout: &LayoutBox,
    color: &str,
    base_font_size: f64,
    font_name: Option<&str>,
    version_info: &str,
) -> String {
    let modern_hy =
        !version_info.is_empty() && font_name.is_some_and(super::font::is_legacy_equation_font);
    let family = escape_xml(&super::font::equation_css_font_family(font_name));
    let font = EquationSvgFont {
        pua_font: sqrt_pua_font(font_name),
        modern: !version_info.is_empty(),
        modern_hy,
        stix_integral: modern_hy && stix_integral_available(),
        css_family: family.clone(),
    };
    let mut svg = String::new();
    svg.push_str(&format!(
        "<g font-family=\"{}\" xml:space=\"preserve\">",
        family
    ));
    render_box(
        &mut svg,
        layout,
        0.0,
        0.0,
        color,
        base_font_size,
        true,
        false,
        &font,
    );
    svg.push_str("</g>");
    svg
}

fn render_box(
    svg: &mut String,
    lb: &LayoutBox,
    parent_x: f64,
    parent_y: f64,
    color: &str,
    fs: f64,
    italic: bool,
    bold: bool,
    font: &EquationSvgFont<'_>,
) {
    let x = parent_x + lb.x;
    let y = parent_y + lb.y;
    if let Some(glyphs) = lb.positioned_glyphs() {
        for mut glyph in glyphs {
            let (text, glyph_italic) = match &glyph.kind {
                LayoutKind::Text(s) => (s, italic),
                LayoutKind::MathSymbol(s) => (s, italic && super::font::is_greek_variable(s)),
                LayoutKind::Number(s) | LayoutKind::Function(s) => (s, false),
                _ => unreachable!(),
            };
            // HY 글립 경로는 원점 기준선 이동을 글립과 함께 적용한다.
            if !pua_covers(font, text, glyph_italic) {
                glyph.y += super::font::modern_glyph_baseline_em(
                    text.chars().next().unwrap(),
                    glyph_italic,
                ) * leaf_font_size(&glyph, fs);
            }
            render_box(svg, &glyph, x, y, color, fs, italic, bold, font);
        }
        return;
    }

    match &lb.kind {
        LayoutKind::Row(children) => {
            for child in children {
                render_box(svg, child, x, y, color, fs, italic, bold, font);
            }
        }
        LayoutKind::Text(text) => {
            let text_x = x;
            let text_y = y + lb.baseline;
            let esc = escape_xml(text);
            let fi = leaf_font_size(lb, fs);
            // CJK/한글 텍스트는 이탤릭 없이 렌더링 (수학 변수명만 이탤릭).
            // FontStyle::Roman(`rm` 적용)으로 italic=false 가 전달된 경우에도 이탤릭을 적용하지 않는다.
            let has_cjk = text.chars().any(|c| {
                matches!(c,
                    '\u{3000}'..='\u{9FFF}' | '\u{F900}'..='\u{FAFF}' | '\u{AC00}'..='\u{D7AF}'
                )
            });
            let hancom_symbol = font.modern_hy
                && super::font::modern_hancom_fallback_run_advance_em(text).is_some();
            let text_italic = !has_cjk && !hancom_symbol && italic;
            if push_pua_text(
                svg,
                font,
                text,
                text_x,
                text_y,
                fi,
                text_italic,
                bold,
                color,
                false,
                TRACKING,
            ) {
                return;
            }
            let italic_attr = if text_italic {
                " font-style=\"italic\""
            } else {
                ""
            };
            let weight_attr = if bold { " font-weight=\"bold\"" } else { "" };
            // 현대 HY 수식의 한글은 한컴처럼 Haansoft Batang으로 칠한다 (HYhwpEQ 미포함).
            let family_attr = if (has_cjk || hancom_symbol) && font.modern_hy {
                format!(
                    " font-family=\"&apos;Haansoft Batang&apos;, {}\"",
                    font.css_family
                )
            } else {
                String::new()
            };
            svg.push_str(&format!(
                "<text x=\"{:.2}\" y=\"{:.2}\" font-size=\"{:.2}\" fill=\"{}\"{}{}{}>{}</text>\n",
                text_x, text_y, fi, color, italic_attr, weight_attr, family_attr, esc,
            ));
        }
        LayoutKind::Number(text) => {
            let text_x = x;
            let text_y = y + lb.baseline;
            let esc = escape_xml(text);
            let fi = leaf_font_size(lb, fs);
            if push_pua_text(
                svg, font, text, text_x, text_y, fi, false, bold, color, false, TRACKING,
            ) {
                return;
            }
            let style_attr = if bold { " font-weight=\"bold\"" } else { "" };
            svg.push_str(&format!(
                "<text x=\"{:.2}\" y=\"{:.2}\" font-size=\"{:.2}\" fill=\"{}\"{}{}>{}</text>\n",
                text_x, text_y, fi, color, style_attr, EQ_FONT_FAMILY, esc,
            ));
        }
        LayoutKind::Symbol(text) => {
            let text_x = x + lb.width / 2.0;
            let text_y = y + lb.baseline;
            let esc = escape_xml(text);
            let fi = leaf_font_size(lb, fs);
            if push_pua_text(
                svg, font, text, text_x, text_y, fi, false, false, color, true, TRACKING,
            ) {
                return;
            }
            svg.push_str(&format!(
                "<text x=\"{:.2}\" y=\"{:.2}\" font-size=\"{:.2}\" fill=\"{}\" text-anchor=\"middle\"{}>{}</text>\n",
                text_x, text_y, fi, color, EQ_FONT_FAMILY, esc,
            ));
        }
        LayoutKind::MathSymbol(text) => {
            // 현대 HY 적분은 굽은 글리프를 우선하고, 나머지는 stroke path 를 쓴다.
            if super::layout::is_integral_symbol(text) {
                svg.push_str(&integral_path(
                    x,
                    y,
                    fs,
                    color,
                    font.modern_hy,
                    font.stix_integral,
                ));
            } else {
                let text_x = x;
                let text_y = y + lb.baseline;
                let esc = escape_xml(text);
                // canvas painter·layout 측정과 같이 그리스 변수만 이탤릭.
                let greek_italic = italic && super::font::is_greek_variable(text);
                let fi = leaf_font_size(lb, fs);
                if push_pua_text(
                    svg,
                    font,
                    text,
                    text_x,
                    text_y,
                    fi,
                    greek_italic,
                    false,
                    color,
                    false,
                    TRACKING,
                ) {
                    return;
                }
                let italic_attr = if greek_italic {
                    " font-style=\"italic\""
                } else {
                    ""
                };
                let family_attr = if font.modern_hy
                    && super::font::modern_hancom_fallback_run_advance_em(text).is_some()
                {
                    " font-family=\"&apos;Haansoft Batang&apos;\""
                } else {
                    EQ_FONT_FAMILY
                };
                svg.push_str(&format!(
                    "<text x=\"{:.2}\" y=\"{:.2}\" font-size=\"{:.2}\" fill=\"{}\"{}{}>{}</text>\n",
                    text_x, text_y, fi, color, italic_attr, family_attr, esc,
                ));
            }
        }
        LayoutKind::Function(name) => {
            let text_x = x;
            let text_y = y + lb.baseline;
            let esc = escape_xml(name);
            let fi = leaf_font_size(lb, fs);
            if push_pua_text(
                svg, font, name, text_x, text_y, fi, false, false, color, false, TRACKING,
            ) {
                return;
            }
            svg.push_str(&format!(
                "<text x=\"{:.2}\" y=\"{:.2}\" font-size=\"{:.2}\" fill=\"{}\"{}>{}</text>\n",
                text_x, text_y, fi, color, EQ_FONT_FAMILY, esc,
            ));
        }
        LayoutKind::Fraction {
            numer,
            denom,
            bar_inset,
        } => {
            // 분자
            render_box(svg, numer, x, y, color, fs, italic, bold, font);
            // HY 분수선은 e06d 막대를 상자 폭으로 늘려 칠한다. 현대 수식의 세로 크기는
            // 본문 em과 같고, 구형만 1.256배다 (네이티브 painter와 같은 기하).
            let bar_painted = push_pua_glyph(
                svg,
                font,
                '\u{e06d}',
                x + bar_inset,
                y + lb.baseline + fs * if font.modern { 0.3 } else { 0.46 },
                fs * if font.modern { 1.0 } else { 1.256 },
                Some(lb.width - bar_inset * 2.0),
                color,
            );
            if !bar_painted {
                // 분수선 — baseline에서 axis_height 위에 배치
                let line_y = y + super::layout::fraction_line_y(numer, fs);
                let line_thick = fs * 0.04;
                svg.push_str(&format!(
                    "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" stroke=\"{}\" stroke-width=\"{:.2}\"/>\n",
                    x + bar_inset, line_y,
                    x + lb.width - bar_inset, line_y,
                    color, line_thick,
                ));
            }
            // 분모
            render_box(svg, denom, x, y, color, fs, italic, bold, font);
        }
        LayoutKind::Atop { top, bottom } => {
            render_box(svg, top, x, y, color, fs, italic, bold, font);
            render_box(svg, bottom, x, y, color, fs, italic, bold, font);
        }
        LayoutKind::Sqrt { index, body } => {
            let sign_x = x;
            if let Some(family) = font.pua_font {
                let geom = sqrt_pua_geometry(body, lb.baseline, lb.width, fs, font.modern);
                for (glyph, glyph_x, baseline, size, advance) in [
                    (
                        '\u{e05c}',
                        x + body.x - fs,
                        geom.sign_baseline,
                        geom.sign_size,
                        fs,
                    ),
                    (
                        '\u{e06d}',
                        x + body.x - fs * 0.03,
                        geom.bar_baseline,
                        geom.bar_size,
                        geom.bar_advance,
                    ),
                ] {
                    svg.push_str(&format!(
                        "<text x=\"{:.4}\" y=\"{:.4}\" font-family=\"{}\" font-size=\"{:.4}\" font-style=\"normal\" font-weight=\"normal\" textLength=\"{:.4}\" lengthAdjust=\"spacingAndGlyphs\" fill=\"{}\">{}</text>\n",
                        glyph_x, y + baseline, escape_xml(family), size, advance, color, glyph,
                    ));
                }
            } else {
                // √ 기호
                let sign_h = lb.height;
                let body_left = x + body.x - fs * 0.1;
                // V 모양 경로
                let v_top = y;
                let v_mid_x = body_left - fs * 0.15;
                let v_mid_y = y + sign_h;
                let v_start_x = v_mid_x - fs * 0.3;
                let v_start_y = y + sign_h * 0.6;
                let tick_x = v_start_x - fs * 0.1;
                let tick_y = v_start_y - fs * 0.05;

                svg.push_str(&format!(
                "<path d=\"M{:.2},{:.2} L{:.2},{:.2} L{:.2},{:.2} L{:.2},{:.2} L{:.2},{:.2}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{:.2}\"/>\n",
                tick_x, tick_y,
                v_start_x, v_start_y,
                v_mid_x, v_mid_y,
                body_left, v_top,
                x + lb.width, v_top,
                color, fs * 0.04,
            ));
            }

            // 인덱스 (있으면)
            if let Some(idx) = index {
                render_box(
                    svg,
                    idx,
                    sign_x,
                    y,
                    color,
                    fs * super::layout::SCRIPT_SCALE,
                    false,
                    false,
                    font,
                );
            }

            // 본체
            render_box(svg, body, x, y, color, fs, italic, bold, font);
        }
        LayoutKind::Superscript { base, sup } => {
            render_box(svg, base, x, y, color, fs, italic, bold, font);
            render_box(
                svg,
                sup,
                x,
                y,
                color,
                fs * super::layout::SCRIPT_SCALE,
                italic,
                bold,
                font,
            );
        }
        LayoutKind::Subscript { base, sub } => {
            render_box(svg, base, x, y, color, fs, italic, bold, font);
            render_box(
                svg,
                sub,
                x,
                y,
                color,
                fs * super::layout::SCRIPT_SCALE,
                italic,
                bold,
                font,
            );
        }
        LayoutKind::SubSup { base, sub, sup } => {
            render_box(svg, base, x, y, color, fs, italic, bold, font);
            render_box(
                svg,
                sub,
                x,
                y,
                color,
                fs * super::layout::SCRIPT_SCALE,
                italic,
                bold,
                font,
            );
            render_box(
                svg,
                sup,
                x,
                y,
                color,
                fs * super::layout::SCRIPT_SCALE,
                italic,
                bold,
                font,
            );
        }
        LayoutKind::BigOp { symbol, sub, sup } => {
            let is_integral = super::layout::is_integral_symbol(symbol);
            let modern_hy_sum = symbol == "∑" && font.modern_hy;
            // Task #1313: 적분은 전용 스케일(INTEGRAL_SCALE), ∑/∏ 등은 BIG_OP_SCALE.
            let op_fs = fs
                * if is_integral {
                    super::layout::INTEGRAL_SCALE
                } else if modern_hy_sum {
                    super::layout::MODERN_HY_SUM_SCALE
                } else {
                    super::layout::BIG_OP_SCALE
                };
            let (paint_symbol, op_font) = match (symbol.as_str(), font.pua_font) {
                ("∑", Some(family)) => ("\u{e067}", format!(" font-family=\"{family}\"")),
                _ => (symbol.as_str(), String::new()),
            };
            let esc = escape_xml(paint_symbol);

            if is_integral {
                // 적분: 기호는 왼쪽, 첨자는 오른쪽 위/아래 (nolimits).
                svg.push_str(&integral_path(
                    x,
                    y,
                    fs,
                    color,
                    font.modern_hy,
                    font.stix_integral,
                ));
            } else {
                // ∑, ∏ 등: 기호는 중앙, 첨자는 위/아래 (limits)
                let sup_h = sup.as_ref().map(|b| b.height + fs * 0.05).unwrap_or(0.0);
                // Task #1233: 연산자는 max_w(= lb.width - trailing pad)에 중앙정렬 →
                // pad 전체가 순수 trailing 간격이 되고 첨자(max_w 중앙정렬)와 정렬된다.
                // #1304: 연산자 폭은 layout 의 estimate_text_width 와 동일 기준을 써야
                // 첨자(레이아웃이 estimate_text_width 로 max_w 중앙정렬)와 가로 중심이 맞는다.
                // (기존 estimate_op_width 의 0.6 과소추정 → ∑가 우측으로, 첨자가 좌측으로 보임)
                let pad = if modern_hy_sum {
                    super::layout::MODERN_HY_SUM_TRAIL_PAD
                } else {
                    super::layout::BIG_OP_TRAIL_PAD
                };
                let center_w = lb.width - fs * pad;
                let op_width = if modern_hy_sum {
                    op_fs * super::layout::MODERN_HY_SUM_ADVANCE_EM
                } else {
                    super::layout::estimate_text_width(symbol, op_fs, false)
                };
                let op_x = x + (center_w - op_width) / 2.0;
                let op_y = y
                    + sup_h
                    + op_fs
                        * if modern_hy_sum {
                            super::layout::MODERN_HY_SUM_BASELINE
                        } else {
                            0.8
                        };
                if !push_pua_text(
                    svg, font, symbol, op_x, op_y, op_fs, false, false, color, false, TRACKING,
                ) {
                    svg.push_str(&format!(
                        "<text x=\"{:.2}\" y=\"{:.2}\" font-size=\"{:.2}\" fill=\"{}\"{}>{}</text>\n",
                        op_x, op_y, op_fs, color, op_font, esc,
                    ));
                }
            }
            // 위/아래 첨자: LayoutBox의 자식 좌표로 배치
            if let Some(sup_box) = sup {
                render_box(
                    svg,
                    sup_box,
                    x,
                    y,
                    color,
                    fs * super::layout::SCRIPT_SCALE,
                    modern_hy_sum && italic,
                    false,
                    font,
                );
            }
            if let Some(sub_box) = sub {
                render_box(
                    svg,
                    sub_box,
                    x,
                    y,
                    color,
                    fs * super::layout::SCRIPT_SCALE,
                    modern_hy_sum && italic,
                    false,
                    font,
                );
            }
        }
        LayoutKind::Limit {
            is_upper,
            sub,
            name_x,
            name_y,
        } => {
            let name = if *is_upper { "Lim" } else { "lim" };
            // 이름 크기는 상자 기준선(0.8×이름 크기)에서 얻는다 (현대 HY 1.2배).
            let fi = lb.baseline / 0.8;
            // 현대 HY 이름은 자연 advance로 칠한다(포개기 없음) — 네이티브와 같다.
            let name_tracking = if font.modern { 1.0 } else { TRACKING };
            if !push_pua_text(
                svg,
                font,
                name,
                x + name_x,
                y + lb.baseline + name_y,
                fi,
                false,
                false,
                color,
                false,
                name_tracking,
            ) {
                svg.push_str(&format!(
                    "<text x=\"{:.2}\" y=\"{:.2}\" font-size=\"{:.2}\" fill=\"{}\"{}>{}</text>\n",
                    x + name_x,
                    y + lb.baseline + name_y,
                    fi,
                    color,
                    EQ_FONT_FAMILY,
                    name,
                ));
            }
            if let Some(sub_box) = sub {
                render_box(
                    svg,
                    sub_box,
                    x,
                    y,
                    color,
                    fs * super::layout::SCRIPT_SCALE,
                    italic,
                    false,
                    font,
                );
            }
        }
        LayoutKind::Matrix { cells, style } => {
            // 괄호
            let bracket_chars = match style {
                MatrixStyle::Paren => ("(", ")"),
                MatrixStyle::Bracket => ("[", "]"),
                MatrixStyle::Vert => ("|", "|"),
                MatrixStyle::Plain => ("", ""),
            };
            if !bracket_chars.0.is_empty() {
                draw_stretch_bracket(svg, bracket_chars.0, x, y, fs * 0.3, lb.height, color, fs);
                draw_stretch_bracket(
                    svg,
                    bracket_chars.1,
                    x + lb.width - fs * 0.3,
                    y,
                    fs * 0.3,
                    lb.height,
                    color,
                    fs,
                );
            }
            // 셀 내용
            for row in cells {
                for cell in row {
                    render_box(svg, cell, x, y, color, fs, italic, bold, font);
                }
            }
        }
        LayoutKind::Rel { arrow, over, under } => {
            render_box(svg, over, x, y, color, fs, italic, bold, font);
            render_box(svg, arrow, x, y, color, fs, italic, bold, font);
            if let Some(u) = under {
                render_box(svg, u, x, y, color, fs, italic, bold, font);
            }
        }
        LayoutKind::EqAlign { rows } => {
            for (left, right) in rows {
                render_box(svg, left, x, y, color, fs, italic, bold, font);
                render_box(svg, right, x, y, color, fs, italic, bold, font);
            }
        }
        LayoutKind::Paren {
            left,
            right,
            body,
            modern_extent,
        } if font.pua_font.is_some() => {
            render_hy_paren(
                svg,
                lb,
                (left.as_str(), right.as_str(), body, *modern_extent),
                x,
                y,
                color,
                fs,
                italic,
                bold,
                font,
            );
        }
        LayoutKind::Paren {
            left,
            right,
            body,
            modern_extent,
        } => {
            // 텍스트 높이 파렌(`(`, `)`)은 폰트 글리프로 렌더, 그 외는 path. (Task #283)
            let use_glyph = lb.height <= fs * 1.2;
            let (paint_top, paint_height) = modern_extent.unwrap_or((0.0, lb.height));
            let paren_w = if use_glyph { fs * 0.333 } else { fs * 0.27 };
            let paren_w = super::layout::paren_bar_slot(lb, body, left, right, fs, paren_w);
            // 왼쪽 괄호
            if !left.is_empty() {
                if use_glyph && (left == "(" || left == ")") {
                    svg.push_str(&format!(
                        "<text x=\"{:.2}\" y=\"{:.2}\" font-size=\"{:.2}\" fill=\"{}\"{}>{}</text>\n",
                        x, y + lb.baseline, fs, color, EQ_FONT_FAMILY, escape_xml(left),
                    ));
                } else {
                    draw_stretch_bracket(
                        svg,
                        left,
                        x,
                        y + paint_top,
                        paren_w,
                        paint_height,
                        color,
                        fs,
                    );
                }
            }
            // 본체
            render_box(svg, body, x, y, color, fs, italic, bold, font);
            // 오른쪽 괄호
            if !right.is_empty() {
                let right_x = x + lb.width
                    - super::layout::paren_right_slot(lb, body, left, right, fs, paren_w);
                if use_glyph && (right == "(" || right == ")") {
                    svg.push_str(&format!(
                        "<text x=\"{:.2}\" y=\"{:.2}\" font-size=\"{:.2}\" fill=\"{}\"{}>{}</text>\n",
                        right_x, y + lb.baseline, fs, color, EQ_FONT_FAMILY, escape_xml(right),
                    ));
                } else {
                    draw_stretch_bracket(
                        svg,
                        right,
                        right_x,
                        y + paint_top,
                        paren_w,
                        paint_height,
                        color,
                        fs,
                    );
                }
            }
        }
        LayoutKind::Decoration { kind, body } => {
            render_box(svg, body, x, y, color, fs, italic, bold, font);
            let deco_y = y + fs * 0.05;
            let mid_x = x + body.x + body.width / 2.0;
            draw_decoration(svg, *kind, mid_x, deco_y, body.width, color, fs);
        }
        LayoutKind::FontStyle { style, body } => {
            let (new_italic, new_bold) = match style {
                FontStyleKind::Roman | FontStyleKind::SansSerif | FontStyleKind::Monospace => {
                    (false, false)
                }
                FontStyleKind::Italic => (true, bold),
                FontStyleKind::Bold => (italic, true),
                FontStyleKind::Blackboard => (false, true),
                FontStyleKind::Calligraphy | FontStyleKind::Fraktur => (false, false),
            };
            render_box(svg, body, x, y, color, fs, new_italic, new_bold, font);
        }
        LayoutKind::Space(_) | LayoutKind::Newline | LayoutKind::Empty => {}
    }
}

/// HY 괄호 묶음 — 네이티브 painter(`skia::equation_conv` Paren)와 같은 글립·기하.
///
/// 글자 높이 괄호는 HY 글립 그대로, 큰 괄호는 e044/e045를 늘려, 큰 대괄호는 e100..e105
/// 파트를 쌓아, 현대 중괄호(cases·`{a_n}`)는 e04b/e04c를 세로로 늘려 칠한다.
/// 글립을 칠하지 못한 쪽만 path 로 돌아간다.
#[allow(clippy::too_many_arguments)]
fn render_hy_paren(
    svg: &mut String,
    lb: &LayoutBox,
    (left, right, body, modern_extent): (&str, &str, &LayoutBox, Option<(f64, f64)>),
    x: f64,
    y: f64,
    color: &str,
    fs: f64,
    italic: bool,
    bold: bool,
    font: &EquationSvgFont<'_>,
) {
    let paren_w = super::layout::paren_bar_slot(lb, body, left, right, fs, fs * 0.333);
    let use_glyph = lb.height <= fs * 1.2;
    let (paint_top, paint_height) = modern_extent.unwrap_or((0.0, lb.height));
    let left_stretch = !use_glyph && matches!(left, "(" | ")");
    let left_square = !use_glyph && left == "[";
    // 현대 HY 중괄호(cases)는 e04b 글립을 줄 범위 높이로 세로만 늘려 칠한다.
    let brace_painted = left == "{"
        && modern_extent.is_some_and(|(top, height)| {
            push_pua_glyph_scaled(
                svg,
                font,
                '\u{e04b}',
                BRACE_INK_EM,
                (
                    x + fs * 113.0 / 1024.0,
                    y + top,
                    fs * 333.0 / 1024.0,
                    height,
                ),
                color,
            )
        });
    let brace_painted = brace_painted
        || (font.modern
            && left == "{"
            && modern_extent.is_none()
            && push_pua_brace(svg, font, '\u{e04b}', x, y, lb, body, fs, color));
    if !left.is_empty() && !brace_painted {
        let legacy_painted = (left_stretch && {
            let (ink, glyph) = paren_glyph_ink(left);
            let target = if let Some((top, height)) = modern_extent {
                (x + ink.0 * fs, y + top, (ink.2 - ink.0) * fs, height)
            } else {
                (
                    x - fs * 0.03,
                    y + lb.height * 0.03,
                    fs * 0.45,
                    lb.height * 0.94,
                )
            };
            push_pua_glyph_scaled(svg, font, glyph, ink, target, color)
        }) || (left_square
            && push_pua_square_bracket(
                svg,
                font,
                true,
                x,
                y + lb.height * 0.03,
                lb.height * 0.94,
                fs,
                color,
            ));
        if legacy_painted {
        } else if use_glyph && matches!(left, "(" | ")" | "[" | "]") {
            let left_x = x + super::layout::paren_left_square_ink_offset(lb, body, left, right, fs);
            push_text(
                svg,
                font,
                left,
                left_x,
                y + lb.baseline,
                fs,
                false,
                false,
                color,
            );
        } else {
            draw_stretch_bracket(
                svg,
                left,
                x,
                y + paint_top,
                paren_w,
                paint_height,
                color,
                fs,
            );
        }
    }
    render_box(svg, body, x, y, color, fs, italic, bold, font);
    let right_stretch = !use_glyph && matches!(right, "(" | ")");
    let right_square = !use_glyph && right == "]";
    let right_slot = super::layout::paren_right_slot(lb, body, left, right, fs, paren_w);
    let right_brace_painted = font.modern
        && right == "}"
        && push_pua_brace(
            svg,
            font,
            '\u{e04c}',
            x + lb.width - right_slot,
            y,
            lb,
            body,
            fs,
            color,
        );
    if !right.is_empty() && !right_brace_painted {
        let right_x = x + lb.width - right_slot;
        let legacy_painted = (right_stretch && {
            let (ink, glyph) = paren_glyph_ink(right);
            let target = if let Some((top, height)) = modern_extent {
                (
                    x + lb.width - fs * 0.39 + ink.0 * fs,
                    y + top,
                    (ink.2 - ink.0) * fs,
                    height,
                )
            } else {
                (
                    x + lb.width - fs * 0.42,
                    y + lb.height * 0.03,
                    fs * 0.45,
                    lb.height * 0.94,
                )
            };
            push_pua_glyph_scaled(svg, font, glyph, ink, target, color)
        }) || (right_square
            && push_pua_square_bracket(
                svg,
                font,
                false,
                x + lb.width - fs * 0.494,
                y + lb.height * 0.03,
                lb.height * 0.94,
                fs,
                color,
            ));
        if legacy_painted {
        } else if use_glyph && matches!(right, "(" | ")" | "[" | "]") {
            push_text(
                svg,
                font,
                right,
                right_x,
                y + lb.baseline,
                fs,
                false,
                false,
                color,
            );
        } else {
            draw_stretch_bracket(
                svg,
                right,
                right_x,
                y + paint_top,
                paren_w,
                paint_height,
                color,
                fs,
            );
        }
    }
}

/// 현대 HY 적분은 굽은 글리프를 칠하고, 다른 적분은 기존 stroke path 를 사용한다.
///
/// 대체 path 는 글리프 박스 좌상단 `(x, y)` 기준으로 `integral_geom` 의 가로
/// 기하를 사용해 S-곡선을 그린다. 현대 HY의 세로 잉크 범위만 실제 글리프에
/// 맞춰 2em 으로 줄이고, 기존 상·하한 배치 박스는 유지한다.
fn integral_path(
    x: f64,
    y: f64,
    fs: f64,
    color: &str,
    modern_hy: bool,
    stix_integral: bool,
) -> String {
    if modern_hy && stix_integral {
        return format!(
            "<text x=\"{:.2}\" y=\"{:.2}\" font-family=\"STIXGeneral, serif\" font-size=\"{:.2}\" fill=\"{}\">∫</text>\n",
            x + fs * 0.042,
            y + fs * 1.94,
            fs * 1.748,
            color,
        );
    }
    let g = integral_geom(fs);
    let top_y = integral_fallback_top_y(g, fs, modern_hy);
    let h = g.bottom_y - top_y;
    // 하단 갈고리 끝(좌하) → 상단 갈고리 끝(우상). 하부는 우측, 상부는 좌측으로
    // 휘어 적분기호 특유의 기운 S 형태를 만든다(round cap 으로 갈고리 표현).
    let p0x = x + g.bottom_hook_x;
    let p0y = y + g.bottom_y;
    let p3x = x + g.top_hook_x;
    let p3y = y + top_y;
    let c1x = x + g.width * 1.02;
    let c1y = y + g.bottom_y - h * 0.30;
    let c2x = x - g.width * 0.10;
    let c2y = y + top_y + h * 0.30;
    format!(
        "<path d=\"M{:.2},{:.2} C{:.2},{:.2} {:.2},{:.2} {:.2},{:.2}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{:.2}\" stroke-linecap=\"round\"/>\n",
        p0x, p0y, c1x, c1y, c2x, c2y, p3x, p3y, color, g.stroke_w,
    )
}

fn font_size_from_box(lb: &LayoutBox, base_fs: f64) -> f64 {
    // 박스 높이에서 폰트 크기 추정 (baseline 비율로)
    if lb.height > 0.0 {
        lb.height
    } else {
        base_fs
    }
}

/// 늘림 괄호 렌더링
fn draw_stretch_bracket(
    svg: &mut String,
    bracket: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    color: &str,
    fs: f64,
) {
    let mid_x = x + w / 2.0;
    let stroke_w = if matches!(bracket, "(" | ")") {
        (fs * 0.042).max(0.48)
    } else {
        fs * 0.04
    };

    match bracket {
        "(" => {
            svg.push_str(&format!(
                "<path d=\"M{:.2},{:.2} C{:.2},{:.2} {:.2},{:.2} {:.2},{:.2}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{:.2}\" stroke-linecap=\"round\"/>\n",
                x + w * 0.9, y,
                x + w * 0.05, y + h * 0.18,
                x + w * 0.05, y + h * 0.82,
                x + w * 0.9, y + h,
                color, stroke_w,
            ));
        }
        ")" => {
            svg.push_str(&format!(
                "<path d=\"M{:.2},{:.2} C{:.2},{:.2} {:.2},{:.2} {:.2},{:.2}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{:.2}\" stroke-linecap=\"round\"/>\n",
                x + w * 0.1, y,
                x + w * 0.95, y + h * 0.18,
                x + w * 0.95, y + h * 0.82,
                x + w * 0.1, y + h,
                color, stroke_w,
            ));
        }
        "[" => {
            svg.push_str(&format!(
                "<path d=\"M{:.2},{:.2} L{:.2},{:.2} L{:.2},{:.2} L{:.2},{:.2}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{:.2}\"/>\n",
                mid_x + w * 0.2, y,
                mid_x - w * 0.2, y,
                mid_x - w * 0.2, y + h,
                mid_x + w * 0.2, y + h,
                color, stroke_w,
            ));
        }
        "]" => {
            svg.push_str(&format!(
                "<path d=\"M{:.2},{:.2} L{:.2},{:.2} L{:.2},{:.2} L{:.2},{:.2}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{:.2}\"/>\n",
                mid_x - w * 0.2, y,
                mid_x + w * 0.2, y,
                mid_x + w * 0.2, y + h,
                mid_x - w * 0.2, y + h,
                color, stroke_w,
            ));
        }
        "{" => {
            let qh = h / 4.0;
            svg.push_str(&format!(
                "<path d=\"M{:.2},{:.2} Q{:.2},{:.2} {:.2},{:.2} Q{:.2},{:.2} {:.2},{:.2} Q{:.2},{:.2} {:.2},{:.2} Q{:.2},{:.2} {:.2},{:.2}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{:.2}\"/>\n",
                mid_x + w * 0.2, y,
                mid_x - w * 0.1, y,
                mid_x - w * 0.1, y + qh,
                mid_x - w * 0.1, y + qh * 2.0,
                mid_x - w * 0.3, y + qh * 2.0,
                mid_x - w * 0.1, y + qh * 2.0,
                mid_x - w * 0.1, y + qh * 3.0,
                mid_x - w * 0.1, y + h,
                mid_x + w * 0.2, y + h,
                color, stroke_w,
            ));
        }
        "}" => {
            let qh = h / 4.0;
            svg.push_str(&format!(
                "<path d=\"M{:.2},{:.2} Q{:.2},{:.2} {:.2},{:.2} Q{:.2},{:.2} {:.2},{:.2} Q{:.2},{:.2} {:.2},{:.2} Q{:.2},{:.2} {:.2},{:.2}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{:.2}\"/>\n",
                mid_x - w * 0.2, y,
                mid_x + w * 0.1, y,
                mid_x + w * 0.1, y + qh,
                mid_x + w * 0.1, y + qh * 2.0,
                mid_x + w * 0.3, y + qh * 2.0,
                mid_x + w * 0.1, y + qh * 2.0,
                mid_x + w * 0.1, y + qh * 3.0,
                mid_x + w * 0.1, y + h,
                mid_x - w * 0.2, y + h,
                color, stroke_w,
            ));
        }
        "|" => {
            svg.push_str(&format!(
                "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" stroke=\"{}\" stroke-width=\"{:.2}\"/>\n",
                mid_x, y, mid_x, y + h, color, stroke_w,
            ));
        }
        _ => {
            // 기타 문자 (⌈, ⌉, ⌊, ⌋ 등)은 텍스트로 렌더링
            let esc = escape_xml(bracket);
            svg.push_str(&format!(
                "<text x=\"{:.2}\" y=\"{:.2}\" font-size=\"{:.2}\" fill=\"{}\" text-anchor=\"middle\"{}>{}</text>\n",
                mid_x, y + h * 0.7, h, color, EQ_FONT_FAMILY, esc,
            ));
        }
    }
}

/// 장식 렌더링
fn draw_decoration(
    svg: &mut String,
    kind: DecoKind,
    mid_x: f64,
    y: f64,
    width: f64,
    color: &str,
    fs: f64,
) {
    let stroke_w = fs * 0.03;
    let half_w = width / 2.0;

    match kind {
        DecoKind::Hat => {
            svg.push_str(&format!(
                "<path d=\"M{:.2},{:.2} L{:.2},{:.2} L{:.2},{:.2}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{:.2}\"/>\n",
                mid_x - half_w * 0.6, y + fs * 0.15,
                mid_x, y,
                mid_x + half_w * 0.6, y + fs * 0.15,
                color, stroke_w,
            ));
        }
        DecoKind::Bar | DecoKind::Overline => {
            svg.push_str(&format!(
                "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" stroke=\"{}\" stroke-width=\"{:.2}\"/>\n",
                mid_x - half_w, y + fs * 0.05,
                mid_x + half_w, y + fs * 0.05,
                color, stroke_w,
            ));
        }
        DecoKind::Vec => {
            // 오른쪽 화살표
            let arrow_y = y + fs * 0.05;
            svg.push_str(&format!(
                "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" stroke=\"{}\" stroke-width=\"{:.2}\"/>\n",
                mid_x - half_w, arrow_y,
                mid_x + half_w, arrow_y,
                color, stroke_w,
            ));
            svg.push_str(&format!(
                "<path d=\"M{:.2},{:.2} L{:.2},{:.2} L{:.2},{:.2}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{:.2}\"/>\n",
                mid_x + half_w - fs * 0.1, arrow_y - fs * 0.06,
                mid_x + half_w, arrow_y,
                mid_x + half_w - fs * 0.1, arrow_y + fs * 0.06,
                color, stroke_w,
            ));
        }
        DecoKind::Tilde => {
            let ty = y + fs * 0.08;
            svg.push_str(&format!(
                "<path d=\"M{:.2},{:.2} Q{:.2},{:.2} {:.2},{:.2} Q{:.2},{:.2} {:.2},{:.2}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{:.2}\"/>\n",
                mid_x - half_w * 0.6, ty,
                mid_x - half_w * 0.2, ty - fs * 0.08,
                mid_x, ty,
                mid_x + half_w * 0.2, ty + fs * 0.08,
                mid_x + half_w * 0.6, ty,
                color, stroke_w,
            ));
        }
        DecoKind::Dot => {
            svg.push_str(&format!(
                "<circle cx=\"{:.2}\" cy=\"{:.2}\" r=\"{:.2}\" fill=\"{}\"/>\n",
                mid_x,
                y + fs * 0.06,
                fs * 0.03,
                color,
            ));
        }
        DecoKind::DDot => {
            let gap = fs * 0.1;
            svg.push_str(&format!(
                "<circle cx=\"{:.2}\" cy=\"{:.2}\" r=\"{:.2}\" fill=\"{}\"/>\n",
                mid_x - gap,
                y + fs * 0.06,
                fs * 0.03,
                color,
            ));
            svg.push_str(&format!(
                "<circle cx=\"{:.2}\" cy=\"{:.2}\" r=\"{:.2}\" fill=\"{}\"/>\n",
                mid_x + gap,
                y + fs * 0.06,
                fs * 0.03,
                color,
            ));
        }
        DecoKind::Underline | DecoKind::Under => {
            // 아래선은 y 위치를 body 아래로 옮김 (여기서는 위치만 표시)
            // 실제로는 body 높이를 알아야 하지만, 여기서는 근사치 사용
            let uy = y + fs * 1.1;
            svg.push_str(&format!(
                "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" stroke=\"{}\" stroke-width=\"{:.2}\"/>\n",
                mid_x - half_w, uy, mid_x + half_w, uy, color, stroke_w,
            ));
        }
        DecoKind::StrikeThrough => {
            svg.push_str(&format!(
                "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" stroke=\"{}\" stroke-width=\"{:.2}\"/>\n",
                mid_x - half_w,
                y + fs * 1.14,
                mid_x + half_w,
                y + fs * 0.14,
                color,
                stroke_w,
            ));
        }
        _ => {
            // Check, Acute, Grave, Dyad, Arch 등 간략 처리
            svg.push_str(&format!(
                "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" stroke=\"{}\" stroke-width=\"{:.2}\"/>\n",
                mid_x - half_w * 0.5, y + fs * 0.1,
                mid_x + half_w * 0.5, y + fs * 0.1,
                color, stroke_w,
            ));
        }
    }
}

/// XML 특수문자 이스케이프
fn escape_xml(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => result.push_str("&amp;"),
            '<' => result.push_str("&lt;"),
            '>' => result.push_str("&gt;"),
            '"' => result.push_str("&quot;"),
            '\'' => result.push_str("&apos;"),
            _ => result.push(ch),
        }
    }
    result
}

/// 수식 color(0x00BBGGRR)를 SVG 색상 문자열(#rrggbb)로 변환
pub fn eq_color_to_svg(color: u32) -> String {
    let r = color & 0xFF;
    let g = (color >> 8) & 0xFF;
    let b = (color >> 16) & 0xFF;
    format!("#{:02x}{:02x}{:02x}", r, g, b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer::equation::layout::EqLayout;
    use crate::renderer::equation::parser::EqParser;
    use crate::renderer::equation::tokenizer::tokenize;

    fn render_eq(script: &str) -> String {
        let tokens = tokenize(script);
        let ast = EqParser::new(tokens).parse();
        let layout = EqLayout::new(20.0).layout(&ast);
        render_equation_svg(&layout, "#000000", 20.0)
    }

    #[test]
    fn integral_svg_dispatches_font_and_shared_fallback_curve() {
        use super::super::parser::parse;
        for fs in [6.0, 9.0, 12.0] {
            let layout = EqLayout::with_font(fs, "HYhwpEQ")
                .with_version("Equation Version 60")
                .layout(&parse("int"));
            let render = |stix_integral| {
                let mut svg = String::new();
                render_box(
                    &mut svg,
                    &layout,
                    0.0,
                    0.0,
                    "black",
                    fs,
                    true,
                    false,
                    &EquationSvgFont {
                        pua_font: Some("HYhwpEQ"),
                        modern: true,
                        modern_hy: true,
                        stix_integral,
                        css_family: String::new(),
                    },
                );
                svg
            };
            let fallback = render(false);
            let g = integral_geom(fs);
            assert!(fallback.contains("<path d=\"M"), "{fallback}");
            assert!(fallback.contains(&format!(
                "{:.2},{:.2}",
                g.top_hook_x,
                integral_fallback_top_y(g, fs, true)
            )));
            let stix = render(true);
            assert!(stix.contains("<text") && stix.contains("∫"), "{stix}");
            assert!(!stix.contains("<path"), "{stix}");
        }
    }

    #[test]
    fn modern_tall_sqrt_uses_the_registered_pair_with_a_body_sized_rule() {
        use super::super::parser::parse;
        let fs = 20.0;
        let root = EqLayout::with_font(fs, "HYhwpEQ")
            .with_version("Equation Version 60")
            .layout(&parse("sqrt {{1} over {2}}"));
        let LayoutKind::Sqrt { body, .. } = &root.kind else {
            panic!("expected radical");
        };
        assert!(body.height > fs * 1.05);
        let geom = sqrt_pua_geometry(body, root.baseline, root.width, fs, true);
        let mut svg = String::new();
        super::render_box(
            &mut svg,
            &root,
            0.0,
            0.0,
            "black",
            fs,
            true,
            false,
            &super::EquationSvgFont {
                pua_font: Some("HYhwpEQ"),
                modern: true,
                modern_hy: true,
                stix_integral: false,
                css_family: String::new(),
            },
        );
        let rule = svg.lines().find(|line| line.contains('\u{e06d}')).unwrap();
        assert!(rule.contains("font-size=\"20.0000\""), "{svg}");
        assert!(
            rule.contains(&format!("textLength=\"{:.4}\"", geom.bar_advance)),
            "{svg}"
        );
        let painted_right = body.x - fs * 0.03 + geom.bar_advance;
        assert!((painted_right - root.width - fs * 0.02).abs() < 1e-9);
        assert!(rule.contains("font-style=\"normal\""), "{svg}");
        assert!(svg.contains('\u{e05c}'));
        assert!(!svg.contains("<path"));
    }

    #[test]
    fn leaf_font_size_matches_measured_scripts_without_scaling_limit_name() {
        use super::super::{layout::EqLayout, parser::parse};
        let engine = EqLayout::with_font(10.0, "HYhwpEQ");
        let svg = render_equation_svg_with_font(
            &engine.layout(&parse("x_i")),
            "black",
            10.0,
            Some("HYhwpEQ"),
        );
        assert!(svg.contains("font-size=\"6.80\""), "{svg}");
        let limit = render_equation_svg_with_font(
            &engine.layout(&parse("lim_x")),
            "black",
            10.0,
            Some("HYhwpEQ"),
        );
        let name = limit
            .lines()
            .find(|line| line.contains(">lim</text>"))
            .expect("limit name");
        assert!(name.contains("font-size=\"10.00\""), "{limit}");
    }

    #[test]
    fn measured_glyph_positions_preserve_unicode_text_and_spaces() {
        let layout = LayoutBox {
            glyph_advances: Some(vec![6.3, 2.0, 7.0]),
            x: 0.0,
            y: 0.0,
            width: 15.3,
            height: 10.0,
            baseline: 8.0,
            kind: LayoutKind::Text("1 α".into()),
        };
        let svg = render_equation_svg(&layout, "black", 10.0);
        assert!(svg.contains("xml:space=\"preserve\""));
        assert!(svg.contains("x=\"0.00\""));
        assert!(svg.contains("x=\"6.30\""));
        assert!(svg.contains("x=\"8.30\""));
        assert!(svg.contains("> </text>"));
        assert!(svg.contains(">α</text>"));
        assert!(matches!(&layout.kind, LayoutKind::Text(text) if text == "1 α"));

        let mut fallback = layout.clone();
        fallback.glyph_advances = None;
        let fallback_svg = render_equation_svg(&fallback, "black", 10.0);
        assert!(fallback_svg.contains(">1 α</text>"));
        assert_eq!(fallback_svg.matches("<text ").count(), 1);
    }

    #[test]
    fn registered_source_face_paints_every_glyph_like_the_native_painter() {
        const CHILD: &str = "RHWP_SVG_SOURCE_FACE_CHILD";
        if std::env::var_os(CHILD).is_none() {
            // 서체 등록은 프로세스 전역이다 — 다른 SVG 테스트의 fallback 상태를 지키려고 격리한다.
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .arg("registered_source_face_paints_every_glyph_like_the_native_painter")
                .arg("--nocapture")
                .env(CHILD, "1")
                .output()
                .expect("run isolated source-face svg test");
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(
                output.status.success() && stdout.contains("1 passed"),
                "{stdout}\n{}",
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/fonts/HYhwpEQSourceFixture.ttf");
        crate::renderer::font_paths::register_font_face_availability(&[fixture]);
        let version = "Equation Version 60";
        let render = |script: &str| {
            let layout = EqLayout::with_font(12.0, "HYhwpEQ")
                .with_version(version)
                .layout(&EqParser::new(tokenize(script)).parse());
            render_equation_svg_with_font_and_version(
                &layout,
                "#000000",
                12.0,
                Some("HYhwpEQ"),
                version,
            )
        };

        // 숫자·연산자·이탤릭 변수 모두 HY PUA 글립 — Unicode 대체 서체를 쓰지 않는다.
        let svg = render("a+2=b");
        for glyph in ['\u{e0e5}', '\u{e048}', '\u{e035}', '\u{e047}', '\u{e0e6}'] {
            assert!(svg.contains(glyph), "{glyph:?} missing: {svg}");
        }
        assert!(!svg.contains("font-style=\"italic\""), "{svg}");
        assert!(svg
            .lines()
            .filter(|line| line.starts_with("<text"))
            .all(|line| line.contains("font-family=\"HyhwpEQ\"")));

        // 분수선은 e06d 막대, 중괄호 묶음은 e04b/e04c를 늘려 칠한다.
        let svg = render("{1} over {2} + left { a_n right }");
        assert!(svg.contains('\u{e06d}'), "{svg}");
        assert!(!svg.contains("<line"), "{svg}");
        assert!(
            svg.contains('\u{e04b}') && svg.contains('\u{e04c}'),
            "{svg}"
        );
        assert!(!svg.contains("<path"), "{svg}");
    }

    #[test]
    fn test_simple_text_svg() {
        let svg = render_eq("abc");
        assert!(svg.contains("<text"));
        assert!(svg.contains("abc"));
    }

    #[test]
    fn test_fraction_svg() {
        let svg = render_eq("a over b");
        assert!(svg.contains("<text")); // 분자/분모 텍스트
        assert!(svg.contains("<line")); // 분수선
    }

    #[test]
    fn test_atop_svg_has_no_fraction_line() {
        let svg = render_eq("a atop b");
        assert!(svg.contains("<text"));
        assert!(!svg.contains("<line"));
        let y_values: Vec<&str> = svg
            .lines()
            .filter_map(|line| line.split(" y=\"").nth(1))
            .filter_map(|rest| rest.split('"').next())
            .collect();
        assert_eq!(
            y_values.len(),
            2,
            "ATOP은 위/아래 텍스트 2개를 렌더링해야 함: {}",
            svg
        );
        assert_ne!(
            y_values[0], y_values[1],
            "ATOP은 두 항을 세로로 배치해야 함: {}",
            svg
        );
    }

    #[test]
    fn test_paren_svg() {
        // 텍스트 높이 파렌은 글리프로 렌더 (Task #283)
        let svg = render_eq("LEFT ( a RIGHT )");
        assert!(svg.contains("<text")); // 내용 + 글리프 파렌
        assert!(!svg.contains("<path")); // path 파렌 아님
    }

    #[test]
    fn test_paren_stretch_svg() {
        // 스트레치 파렌(분수 감쌈)은 path 유지 (Task #283)
        let svg = render_eq("LEFT ( a over b RIGHT )");
        assert!(svg.contains("<path")); // 스트레치 괄호
        assert!(svg.contains(" C")); // 둥근 괄호는 완만한 cubic 곡선으로 렌더
        assert!(svg.contains("stroke-linecap=\"round\""));
        assert!(svg.contains("<line")); // 분수선
    }

    #[test]
    fn test_issue_1139_integral_left_right_parens_are_curved() {
        let svg = render_eq(" int _{0} ^{pi } {} x`cos LEFT ( {pi } over {2} -x RIGHT ) dx");
        // Task #1317: 적분 기호는 폰트 text(∫) 가 아닌 stroke path 로 렌더된다.
        assert!(
            !svg.contains(">∫<"),
            "적분 기호는 path 로 렌더되어야 함(text ∫ 아님): {}",
            svg
        );
        assert!(
            svg.contains("<path"),
            "적분 기호가 path 로 렌더되어야 함: {}",
            svg
        );
        assert!(svg.contains(">cos<"), "cos 함수가 렌더링되어야 함: {}", svg);
        assert!(
            svg.contains(">π<"),
            "pi 명령은 문자 π로 렌더링되어야 함: {}",
            svg
        );
        assert!(
            svg.contains(" C"),
            "큰 둥근 괄호는 cubic path여야 함: {}",
            svg
        );
        assert!(
            !svg.contains(">LEFT<"),
            "LEFT 명령이 문자로 새면 안 됨: {}",
            svg
        );
        assert!(
            !svg.contains(">RIGHT<"),
            "RIGHT 명령이 문자로 새면 안 됨: {}",
            svg
        );
    }

    #[test]
    fn test_eq01_svg() {
        let svg = render_eq(
            "평점=입찰가격평가~배점한도 TIMES LEFT ( {최저입찰가격} over {해당입찰가격} RIGHT )",
        );
        assert!(svg.contains("평점"));
        assert!(svg.contains("×")); // TIMES → ×
        assert!(svg.contains("<line")); // 분수선
        assert!(svg.contains("<path")); // 괄호
    }

    // Task #488: rm/it 폰트 스타일 적용 검증

    #[test]
    fn test_default_text_is_italic() {
        // hwpeq 기본: 라틴 변수는 italic
        let svg = render_eq("K");
        assert!(
            svg.contains("font-style=\"italic\""),
            "기본 변수는 italic: {}",
            svg
        );
    }

    #[test]
    fn test_rm_disables_italic() {
        // rm K (직립체): italic 미적용
        let svg = render_eq("rm K");
        assert!(
            !svg.contains("font-style=\"italic\""),
            "rm 적용 시 italic 없음: {}",
            svg
        );
        assert!(svg.contains(">K<"));
    }

    #[test]
    fn test_rm_prefix_form_disables_italic() {
        // rmK (공백 없는 prefix 형태): italic 미적용
        let svg = render_eq("rmK");
        assert!(
            !svg.contains("font-style=\"italic\""),
            "rmK 적용 시 italic 없음: {}",
            svg
        );
        assert!(svg.contains(">K<"));
        // rm prefix 자체가 토큰으로 분리되었으므로 raw "rmK" 가 SVG 텍스트로 남지 않아야 함
        assert!(!svg.contains(">rmK<"));
    }

    #[test]
    fn test_rm_compound_chemical_symbol() {
        // rmCa: 두 글자 화학 기호도 한 토큰으로 묶여 italic 미적용
        let svg = render_eq("rmCa");
        assert!(!svg.contains("font-style=\"italic\""));
        assert!(svg.contains(">Ca<"));
    }

    #[test]
    fn test_it_keeps_italic() {
        // it K (이탤릭 명시): italic 적용
        let svg = render_eq("it K");
        assert!(svg.contains("font-style=\"italic\""));
        assert!(svg.contains(">K<"));
    }

    #[test]
    fn test_cjk_never_italic() {
        // 한글은 default italic=true 영역에서도 italic 미적용
        let svg = render_eq("평점");
        assert!(
            !svg.contains("font-style=\"italic\""),
            "CJK는 italic 미적용: {}",
            svg
        );
        assert!(svg.contains("평점"));
    }
}

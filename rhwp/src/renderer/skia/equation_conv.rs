use skia_safe::{
    font, paint, Canvas, Color, Font, FontMgr, FontStyle, Paint, PathBuilder, Typeface,
};

use super::font_lookup::{
    legacy_typeface_for_style, match_system_family_style, SystemFontFamilies,
};
use super::renderer::{typeface_for_style, TypefaceCatalog};
use super::text_replay::{draw_text_run, draw_text_run_tracked};

use crate::renderer::equation::ast::MatrixStyle;
use crate::renderer::equation::layout::{
    integral_fallback_top_y, integral_geom, is_integral_symbol, leaf_font_size, sqrt_pua_geometry,
    LayoutBox, LayoutKind, BIG_OP_SCALE, INTEGRAL_SCALE, MODERN_HY_SUM_ADVANCE_EM,
    MODERN_HY_SUM_BASELINE, MODERN_HY_SUM_SCALE, MODERN_HY_SUM_TRAIL_PAD, SCRIPT_SCALE,
};
use crate::renderer::equation::symbols::{DecoKind, FontStyleKind};

/// 수식 페인트의 face 해석 묶음 — 본문(text_replay)과 같은 조달 순서
/// (custom --font-path → 시스템 → 번들 최후-폴백)로 family 를 찾는다.
struct EqFonts<'a> {
    mgr: &'a FontMgr,
    custom: &'a TypefaceCatalog,
    bundled: &'a TypefaceCatalog,
    system: &'a SystemFontFamilies,
    modern: bool,
}

impl EqFonts<'_> {
    fn resolve(&self, family: &str, style: FontStyle) -> Option<Typeface> {
        typeface_for_style(self.custom, family, style)
            .or_else(|| match_system_family_style(self.mgr, self.system, family, style))
            .or_else(|| typeface_for_style(self.bundled, family, style))
    }
}

pub fn render_equation(
    canvas: &Canvas,
    font_mgr: &FontMgr,
    custom_typefaces: &TypefaceCatalog,
    bundled_typefaces: &TypefaceCatalog,
    system_families: &SystemFontFamilies,
    layout: &LayoutBox,
    origin_x: f64,
    origin_y: f64,
    color: u32,
    base_font_size: f64,
    font_name: &str,
    version_info: &str,
) {
    let font_families = crate::renderer::equation::font::equation_font_families(Some(font_name));
    let fonts = EqFonts {
        mgr: font_mgr,
        custom: custom_typefaces,
        bundled: bundled_typefaces,
        system: system_families,
        // 레이아웃의 is_modern_hy 와 같은 판정 — 버전60 수식은 크기와 무관하게 현대다.
        modern: !version_info.is_empty(),
    };
    render_box(
        canvas,
        &fonts,
        &font_families,
        layout,
        origin_x,
        origin_y,
        colorref_to_skia(color, 1.0),
        base_font_size,
        true,
        false,
    );
}

fn render_box(
    canvas: &Canvas,
    fonts: &EqFonts<'_>,
    font_families: &[&str],
    lb: &LayoutBox,
    parent_x: f64,
    parent_y: f64,
    color: Color,
    fs: f64,
    italic: bool,
    bold: bool,
) {
    let x = parent_x + lb.x;
    let y = parent_y + lb.y;
    if let Some(glyphs) = lb.positioned_glyphs() {
        for glyph in glyphs {
            render_box(
                canvas,
                fonts,
                font_families,
                &glyph,
                x,
                y,
                color,
                fs,
                italic,
                bold,
            );
        }
        return;
    }

    match &lb.kind {
        LayoutKind::Row(children) => {
            for child in children {
                render_box(
                    canvas,
                    fonts,
                    font_families,
                    child,
                    x,
                    y,
                    color,
                    fs,
                    italic,
                    bold,
                );
            }
        }
        LayoutKind::Text(text) => {
            draw_text(
                canvas,
                fonts,
                font_families,
                text,
                x,
                y + lb.baseline,
                leaf_font_size(lb, fs),
                italic
                    && !text
                        .chars()
                        .any(crate::renderer::equation::layout::is_cjk_char)
                    && !(fonts.modern
                        && crate::renderer::equation::font::modern_hancom_fallback_run_advance_em(
                            text,
                        )
                        .is_some()),
                bold,
                color,
                false,
            );
        }
        LayoutKind::Number(text) => {
            draw_text(
                canvas,
                fonts,
                font_families,
                text,
                x,
                y + lb.baseline,
                leaf_font_size(lb, fs),
                false,
                bold,
                color,
                false,
            );
        }
        LayoutKind::Symbol(text) => {
            draw_text(
                canvas,
                fonts,
                font_families,
                text,
                x + lb.width / 2.0,
                y + lb.baseline,
                leaf_font_size(lb, fs),
                false,
                false,
                color,
                true,
            );
        }
        LayoutKind::MathSymbol(text) => {
            // 적분은 현대 HY의 굽은 글리프를 우선하고, 나머지는 stroke path 를 쓴다.
            if is_integral_symbol(text) {
                draw_integral(canvas, fonts, font_families, x, y, fs, color);
            } else {
                draw_text(
                    canvas,
                    fonts,
                    font_families,
                    text,
                    x,
                    y + lb.baseline,
                    leaf_font_size(lb, fs),
                    italic && crate::renderer::equation::font::is_greek_variable(text),
                    false,
                    color,
                    false,
                );
            }
        }
        LayoutKind::Function(name) => {
            draw_text(
                canvas,
                fonts,
                font_families,
                name,
                x,
                y + lb.baseline,
                leaf_font_size(lb, fs),
                false,
                false,
                color,
                false,
            );
        }
        LayoutKind::Fraction {
            numer,
            denom,
            bar_inset,
        } => {
            render_box(
                canvas,
                fonts,
                font_families,
                numer,
                x,
                y,
                color,
                fs,
                italic,
                bold,
            );
            // HY 분수선은 e06d 막대를 상자 폭으로 늘려 칠한다. 현대 수식의
            // 세로 크기는 본문 em과 같고, 구형 HFT만 기존 1.256배를 사용한다.
            // legacy 분수선의 잉크 중심은 기준선 아래 ~0.30em(수학 축)에 놓인다 —
            // e06d 잉크 중심이 org 위 0.604em이므로 org = baseline + 0.46em
            // (02-eq-01 실측: 막대 잉크 y = 본문 기준선−0.27~0.34em).
            let bar_painted = draw_legacy_pua_glyph(
                canvas,
                fonts,
                font_families,
                '\u{e06d}',
                x + *bar_inset,
                y + lb.baseline + fs * if fonts.modern { 0.3 } else { 0.46 },
                fs * if fonts.modern { 1.0 } else { 1.256 },
                Some(lb.width - *bar_inset * 2.0),
                color,
            );
            if !bar_painted {
                let line_y = y + crate::renderer::equation::layout::fraction_line_y(numer, fs);
                canvas.draw_line(
                    ((x + bar_inset) as f32, line_y as f32),
                    ((x + lb.width - bar_inset) as f32, line_y as f32),
                    &stroke_paint(color, fs * 0.04),
                );
            }
            render_box(
                canvas,
                fonts,
                font_families,
                denom,
                x,
                y,
                color,
                fs,
                italic,
                bold,
            );
        }
        LayoutKind::Atop { top, bottom } => {
            render_box(
                canvas,
                fonts,
                font_families,
                top,
                x,
                y,
                color,
                fs,
                italic,
                bold,
            );
            render_box(
                canvas,
                fonts,
                font_families,
                bottom,
                x,
                y,
                color,
                fs,
                italic,
                bold,
            );
        }
        LayoutKind::Sqrt { index, body } => {
            let sign_x = x;
            let geom = sqrt_pua_geometry(body, lb.baseline, lb.width, fs, fonts.modern);
            let sign_painted = draw_legacy_pua_glyph(
                canvas,
                fonts,
                font_families,
                '\u{e05c}',
                x + body.x - fs,
                y + geom.sign_baseline,
                geom.sign_size,
                Some(fs),
                color,
            );
            if sign_painted {
                draw_legacy_pua_glyph(
                    canvas,
                    fonts,
                    font_families,
                    '\u{e06d}',
                    x + body.x - fs * 0.03,
                    y + geom.bar_baseline,
                    geom.bar_size,
                    Some(geom.bar_advance),
                    color,
                );
            }
            if !sign_painted {
                let sign_h = lb.height;
                let body_left = x + body.x - fs * 0.1;
                let v_top = y;
                let v_mid_x = body_left - fs * 0.15;
                let v_mid_y = y + sign_h;
                let v_start_x = v_mid_x - fs * 0.3;
                let v_start_y = y + sign_h * 0.6;
                let tick_x = v_start_x - fs * 0.1;
                let tick_y = v_start_y - fs * 0.05;

                let mut path = PathBuilder::new();
                path.move_to((tick_x as f32, tick_y as f32));
                path.line_to((v_start_x as f32, v_start_y as f32));
                path.line_to((v_mid_x as f32, v_mid_y as f32));
                path.line_to((body_left as f32, v_top as f32));
                path.line_to(((x + lb.width) as f32, v_top as f32));
                canvas.draw_path(&path.detach(), &stroke_paint(color, fs * 0.04));
            }

            if let Some(index) = index {
                render_box(
                    canvas,
                    fonts,
                    font_families,
                    index,
                    sign_x,
                    y,
                    color,
                    fs * SCRIPT_SCALE,
                    false,
                    false,
                );
            }
            render_box(
                canvas,
                fonts,
                font_families,
                body,
                x,
                y,
                color,
                fs,
                italic,
                bold,
            );
        }
        LayoutKind::Superscript { base, sup } => {
            render_box(
                canvas,
                fonts,
                font_families,
                base,
                x,
                y,
                color,
                fs,
                italic,
                bold,
            );
            render_box(
                canvas,
                fonts,
                font_families,
                sup,
                x,
                y,
                color,
                fs * SCRIPT_SCALE,
                italic,
                bold,
            );
        }
        LayoutKind::Subscript { base, sub } => {
            render_box(
                canvas,
                fonts,
                font_families,
                base,
                x,
                y,
                color,
                fs,
                italic,
                bold,
            );
            render_box(
                canvas,
                fonts,
                font_families,
                sub,
                x,
                y,
                color,
                fs * SCRIPT_SCALE,
                italic,
                bold,
            );
        }
        LayoutKind::SubSup { base, sub, sup } => {
            render_box(
                canvas,
                fonts,
                font_families,
                base,
                x,
                y,
                color,
                fs,
                italic,
                bold,
            );
            render_box(
                canvas,
                fonts,
                font_families,
                sub,
                x,
                y,
                color,
                fs * SCRIPT_SCALE,
                italic,
                bold,
            );
            render_box(
                canvas,
                fonts,
                font_families,
                sup,
                x,
                y,
                color,
                fs * SCRIPT_SCALE,
                italic,
                bold,
            );
        }
        LayoutKind::BigOp { symbol, sub, sup } => {
            let is_integral = is_integral_symbol(symbol);
            let modern_hy_sum = symbol == "∑"
                && fonts.modern
                && font_families.first().is_some_and(|name| {
                    crate::renderer::equation::font::is_legacy_equation_font(name)
                });
            // Task #1313: 적분은 전용 스케일(INTEGRAL_SCALE), ∑/∏ 등은 BIG_OP_SCALE.
            let op_fs = fs
                * if is_integral {
                    INTEGRAL_SCALE
                } else if modern_hy_sum {
                    MODERN_HY_SUM_SCALE
                } else {
                    BIG_OP_SCALE
                };
            if is_integral {
                // 현대 HY는 글리프를 우선하고, 나머지는 stroke path 를 쓴다.
                draw_integral(canvas, fonts, font_families, x, y, fs, color);
            } else {
                let sup_h = sup.as_ref().map(|b| b.height + fs * 0.05).unwrap_or(0.0);
                let op_x = if modern_hy_sum {
                    x + (lb.width - fs * MODERN_HY_SUM_TRAIL_PAD - op_fs * MODERN_HY_SUM_ADVANCE_EM)
                        / 2.0
                } else {
                    x + (lb.width - estimate_op_width(symbol, op_fs)) / 2.0
                };
                let op_y = y
                    + sup_h
                    + op_fs
                        * if modern_hy_sum {
                            MODERN_HY_SUM_BASELINE
                        } else {
                            0.8
                        };
                draw_text(
                    canvas,
                    fonts,
                    font_families,
                    symbol,
                    op_x,
                    op_y,
                    op_fs,
                    false,
                    false,
                    color,
                    false,
                );
            }
            if let Some(sup) = sup {
                render_box(
                    canvas,
                    fonts,
                    font_families,
                    sup,
                    x,
                    y,
                    color,
                    fs * SCRIPT_SCALE,
                    modern_hy_sum && italic,
                    false,
                );
            }
            if let Some(sub) = sub {
                render_box(
                    canvas,
                    fonts,
                    font_families,
                    sub,
                    x,
                    y,
                    color,
                    fs * SCRIPT_SCALE,
                    modern_hy_sum && italic,
                    false,
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
            // 이름 크기는 상자 기준선(0.8×이름 크기)에서 얻는다 — 현대 HY는 1.2배이고
            // 자연 advance로 칠한다(포개기 없음).
            let name_fs = lb.baseline / 0.8;
            draw_text_tracked(
                canvas,
                fonts,
                font_families,
                name,
                x + name_x,
                y + lb.baseline + name_y,
                name_fs,
                false,
                false,
                color,
                false,
                if fonts.modern {
                    1.0
                } else {
                    crate::renderer::equation::font::EQUATION_GLYPH_TRACKING
                },
            );
            if let Some(sub) = sub {
                render_box(
                    canvas,
                    fonts,
                    font_families,
                    sub,
                    x,
                    y,
                    color,
                    fs * SCRIPT_SCALE,
                    italic,
                    false,
                );
            }
        }
        LayoutKind::Matrix { cells, style } => {
            let bracket_chars = match style {
                MatrixStyle::Paren => ("(", ")"),
                MatrixStyle::Bracket => ("[", "]"),
                MatrixStyle::Vert => ("|", "|"),
                MatrixStyle::Plain => ("", ""),
            };
            if !bracket_chars.0.is_empty() {
                draw_stretch_bracket(
                    canvas,
                    fonts,
                    font_families,
                    bracket_chars.0,
                    x,
                    y,
                    fs * 0.3,
                    lb.height,
                    color,
                    fs,
                );
                draw_stretch_bracket(
                    canvas,
                    fonts,
                    font_families,
                    bracket_chars.1,
                    x + lb.width - fs * 0.3,
                    y,
                    fs * 0.3,
                    lb.height,
                    color,
                    fs,
                );
            }
            for row in cells {
                for cell in row {
                    render_box(
                        canvas,
                        fonts,
                        font_families,
                        cell,
                        x,
                        y,
                        color,
                        fs,
                        italic,
                        bold,
                    );
                }
            }
        }
        LayoutKind::Rel { arrow, over, under } => {
            render_box(
                canvas,
                fonts,
                font_families,
                over,
                x,
                y,
                color,
                fs,
                italic,
                bold,
            );
            render_box(
                canvas,
                fonts,
                font_families,
                arrow,
                x,
                y,
                color,
                fs,
                italic,
                bold,
            );
            if let Some(under) = under {
                render_box(
                    canvas,
                    fonts,
                    font_families,
                    under,
                    x,
                    y,
                    color,
                    fs,
                    italic,
                    bold,
                );
            }
        }
        LayoutKind::EqAlign { rows } => {
            for (left, right) in rows {
                render_box(
                    canvas,
                    fonts,
                    font_families,
                    left,
                    x,
                    y,
                    color,
                    fs,
                    italic,
                    bold,
                );
                render_box(
                    canvas,
                    fonts,
                    font_families,
                    right,
                    x,
                    y,
                    color,
                    fs,
                    italic,
                    bold,
                );
            }
        }
        LayoutKind::Paren {
            left,
            right,
            body,
            modern_extent,
        } => {
            let paren_w = fs * 0.333;
            let paren_w = crate::renderer::equation::layout::paren_bar_slot(
                lb, body, left, right, fs, paren_w,
            );
            let use_glyph = lb.height <= fs * 1.2;
            // legacy는 큰 괄호도 e044/e045 글립을 slot 폭으로 늘려 칠고, 세로는
            // 본문 상자 높이의 ~0.94배를 덮는다 (02-eq-01 실측: 본문 29.3pt →
            // 괄호 잉크 27.6pt, 위쪽 0.03h 여백).
            let left_stretch = !use_glyph && matches!(left.as_str(), "(" | ")");
            let left_square = !use_glyph && left == "[";
            // 현대 HY 중괄호(cases)는 e04b 글립을 줄 범위 높이로 세로만 늘려 칠한다.
            let brace_painted = left == "{"
                && modern_extent.is_some_and(|(top, height)| {
                    draw_legacy_pua_glyph_scaled(
                        canvas,
                        fonts,
                        font_families,
                        '\u{e04b}',
                        (
                            113.0 / 1024.0,
                            -203.0 / 1024.0,
                            446.0 / 1024.0,
                            821.0 / 1024.0,
                        ),
                        (
                            x + fs * 113.0 / 1024.0,
                            y + top,
                            fs * 333.0 / 1024.0,
                            height,
                        ),
                        color,
                    )
                });
            // 현대 HY 일반 중괄호 묶음은 e04b/e04c의 가로 잉크 폭을
            // 기본 글자 크기로 유지하고 세로만 본문 높이로 늘린다.
            let brace_glyph = |glyph: char, gx: f64| {
                let layout_height = lb.height.max(fs);
                let ink_height = crate::renderer::equation::layout::content_bottom(body)
                    .max(fs)
                    .min(layout_height);
                let baseline = y + lb.height / 2.0 + layout_height * 0.309;
                draw_legacy_pua_glyph_scaled(
                    canvas,
                    fonts,
                    font_families,
                    glyph,
                    (
                        113.0 / 1024.0,
                        -203.0 / 1024.0,
                        446.0 / 1024.0,
                        821.0 / 1024.0,
                    ),
                    (
                        gx + fs * 113.0 / 1024.0,
                        baseline - layout_height * 821.0 / 1024.0,
                        fs * 333.0 / 1024.0,
                        ink_height,
                    ),
                    color,
                )
            };
            let brace_painted = brace_painted
                || (fonts.modern
                    && left == "{"
                    && modern_extent.is_none()
                    && brace_glyph('\u{e04b}', x));
            if !left.is_empty() && !brace_painted {
                let legacy_painted = (left_stretch && {
                    let (ink, g) = paren_glyph_ink(left);
                    // 괄호 잉크는 ~0.45em 폭으로 slot(0.39em) 안에 가운데 놓인다
                    // (02-eq-01 eq37/eq40 실측 잉크 폭 ~5.4pt@fs12-13).
                    draw_legacy_pua_glyph_scaled(
                        canvas,
                        fonts,
                        font_families,
                        g,
                        ink,
                        if let Some((top, height)) = *modern_extent {
                            (x + ink.0 * fs, y + top, (ink.2 - ink.0) * fs, height)
                        } else {
                            (
                                x - fs * 0.03,
                                y + lb.height * 0.03,
                                fs * 0.45,
                                lb.height * 0.94,
                            )
                        },
                        color,
                    )
                }) || (left_square
                    && draw_legacy_square_bracket(
                        canvas,
                        fonts,
                        font_families,
                        true,
                        x,
                        y + lb.height * 0.03,
                        lb.height * 0.94,
                        fs,
                        color,
                    ));
                if legacy_painted {
                } else if use_glyph && matches!(left.as_str(), "(" | ")" | "[" | "]") {
                    draw_text(
                        canvas,
                        fonts,
                        font_families,
                        left,
                        x + crate::renderer::equation::layout::paren_left_square_ink_offset(
                            lb, body, left, right, fs,
                        ),
                        y + lb.baseline,
                        fs,
                        false,
                        false,
                        color,
                        false,
                    );
                } else {
                    draw_stretch_bracket(
                        canvas,
                        fonts,
                        font_families,
                        left,
                        x,
                        y,
                        paren_w,
                        lb.height,
                        color,
                        fs,
                    );
                }
            }
            render_box(
                canvas,
                fonts,
                font_families,
                body,
                x,
                y,
                color,
                fs,
                italic,
                bold,
            );
            let right_stretch = !use_glyph && matches!(right.as_str(), "(" | ")");
            let right_square = !use_glyph && right == "]";
            let right_slot = crate::renderer::equation::layout::paren_right_slot(
                lb, body, left, right, fs, paren_w,
            );
            let right_brace_painted =
                fonts.modern && right == "}" && brace_glyph('\u{e04c}', x + lb.width - right_slot);
            if !right.is_empty() && !right_brace_painted {
                let right_x = x + lb.width - right_slot;
                let legacy_painted = (right_stretch && {
                    let (ink, g) = paren_glyph_ink(right);
                    draw_legacy_pua_glyph_scaled(
                        canvas,
                        fonts,
                        font_families,
                        g,
                        ink,
                        if let Some((top, height)) = *modern_extent {
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
                        },
                        color,
                    )
                }) || (right_square
                    && draw_legacy_square_bracket(
                        canvas,
                        fonts,
                        font_families,
                        false,
                        x + lb.width - fs * 0.494,
                        y + lb.height * 0.03,
                        lb.height * 0.94,
                        fs,
                        color,
                    ));
                if legacy_painted {
                } else if use_glyph && matches!(right.as_str(), "(" | ")" | "[" | "]") {
                    draw_text(
                        canvas,
                        fonts,
                        font_families,
                        right,
                        right_x,
                        y + lb.baseline,
                        fs,
                        false,
                        false,
                        color,
                        false,
                    );
                } else {
                    draw_stretch_bracket(
                        canvas,
                        fonts,
                        font_families,
                        right,
                        right_x,
                        y,
                        paren_w,
                        lb.height,
                        color,
                        fs,
                    );
                }
            }
        }
        LayoutKind::Decoration { kind, body } => {
            render_box(
                canvas,
                fonts,
                font_families,
                body,
                x,
                y,
                color,
                fs,
                italic,
                bold,
            );
            let deco_y = y + fs * 0.05;
            let mid_x = x + body.x + body.width / 2.0;
            draw_decoration(canvas, *kind, mid_x, deco_y, body.width, color, fs);
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
            render_box(
                canvas,
                fonts,
                font_families,
                body,
                x,
                y,
                color,
                fs,
                new_italic,
                new_bold,
            );
        }
        LayoutKind::Space(_) | LayoutKind::Newline | LayoutKind::Empty => {}
    }
}

fn draw_text(
    canvas: &Canvas,
    fonts: &EqFonts<'_>,
    font_families: &[&str],
    text: &str,
    x: f64,
    baseline_y: f64,
    font_size: f64,
    italic: bool,
    bold: bool,
    color: Color,
    centered: bool,
) {
    draw_text_tracked(
        canvas,
        fonts,
        font_families,
        text,
        x,
        baseline_y,
        font_size,
        italic,
        bold,
        color,
        centered,
        crate::renderer::equation::font::EQUATION_GLYPH_TRACKING,
    );
}

#[allow(clippy::too_many_arguments)]
fn draw_text_tracked(
    canvas: &Canvas,
    fonts: &EqFonts<'_>,
    font_families: &[&str],
    text: &str,
    x: f64,
    baseline_y: f64,
    font_size: f64,
    italic: bool,
    bold: bool,
    color: Color,
    centered: bool,
    legacy_tracking: f64,
) {
    if text.is_empty() {
        return;
    }
    // 해당 legacy face와 cmap이 모두 있을 때만 PUA로 바꾼다.
    if let Some(family) = font_families
        .first()
        .filter(|name| crate::renderer::equation::font::is_legacy_equation_font(name))
    {
        if let Some(typeface) = fonts.resolve(family, FontStyle::normal()) {
            let mapped: Vec<_> = text
                .chars()
                .map(|c| {
                    let (glyph, skew) = crate::renderer::equation::font::legacy_equation_glyph(
                        c,
                        italic,
                        fonts.modern,
                    );
                    let shift = if fonts.modern {
                        crate::renderer::equation::font::modern_glyph_baseline_em(c, italic)
                    } else {
                        0.0
                    };
                    (glyph, skew, shift)
                })
                .collect();
            let glyphs: String = mapped.iter().map(|(c, _, _)| *c).collect();
            if typeface_covers_text(&typeface, &glyphs) {
                let mut runs: Vec<(String, bool, f64)> = Vec::new();
                for (character, skew, shift) in mapped {
                    if let Some(run) = runs
                        .last_mut()
                        .filter(|run| run.1 == skew && run.2 == shift)
                    {
                        run.0.push(character);
                    } else {
                        runs.push((character.to_string(), skew, shift));
                    }
                }
                let mut font = Font::new(typeface, font_size as f32);
                font.set_edging(font::Edging::AntiAlias);
                font.set_embolden(bold);
                let mut paint = Paint::default();
                paint.set_anti_alias(true);
                paint.set_color(color);
                // 한컴 수식기는 run 안 글립의 진행폭을 자연폭×0.9로 포갠다 —
                // layout(measure_legacy_run_native)과 같은 비율로 스텝을 좁힌다.
                let tracking = legacy_tracking;
                let width = font.measure_str(&glyphs, Some(&paint)).0 as f64 * tracking;
                let mut pen = x - if centered { width / 2.0 } else { 0.0 };
                for (run, skew, shift) in runs {
                    font.set_skew_x(if skew { -0.2 } else { 0.0 });
                    draw_text_run_tracked(
                        canvas,
                        &run,
                        (pen as f32, (baseline_y + shift * font_size) as f32),
                        &font,
                        &paint,
                        tracking,
                    );
                    pen += font.measure_str(&run, Some(&paint)).0 as f64 * tracking;
                }
                return;
            }
        }
    }
    let font_style = match (bold, italic) {
        (true, true) => FontStyle::bold_italic(),
        (true, false) => FontStyle::bold(),
        (false, true) => FontStyle::italic(),
        (false, false) => FontStyle::normal(),
    };
    let typeface = equation_typeface_for_text_in_families(font_families, fonts, font_style, text);
    let mut font = if let Some(typeface) = typeface {
        Font::new(typeface, font_size as f32)
    } else {
        let mut font = Font::default();
        font.set_size(font_size as f32);
        font
    };
    font.set_edging(font::Edging::AntiAlias);

    let mut paint = Paint::default();
    paint.set_anti_alias(true);
    paint.set_style(paint::Style::Fill);
    paint.set_color(color);

    // legacy 수식 서체는 커버 못 하는 문자(한글 등)도 fallback 서체로
    // 칠하면서 진행폭을 0.9배로 포갠다 — 위 PUA 경로와 같은 추적값.
    let tracking = if font_families
        .first()
        .is_some_and(|name| crate::renderer::equation::font::is_legacy_equation_font(name))
    {
        legacy_tracking
    } else {
        1.0
    };
    let draw_x = if centered {
        let (width, _) = font.measure_str(text, Some(&paint));
        x - f64::from(width) * tracking / 2.0
    } else {
        x
    };
    draw_text_run_tracked(
        canvas,
        text,
        (draw_x as f32, baseline_y as f32),
        &font,
        &paint,
        tracking,
    );
}

// 한컴 legacy 수식 서체의 PUA 글립(√ 기호 e05c, 막대 e06d 등)을 직접 칠한다.
// advance_w를 주면 글립 자연폭에 맞춰 가로로만 늘린다. 서체나 글립이 없으면
// false를 반환해 호출자가 path 대체 그리기로 돌아간다.
fn draw_legacy_pua_glyph(
    canvas: &Canvas,
    fonts: &EqFonts<'_>,
    font_families: &[&str],
    glyph: char,
    x: f64,
    baseline_y: f64,
    font_size: f64,
    advance_w: Option<f64>,
    color: Color,
) -> bool {
    let Some(family) = font_families
        .iter()
        .copied()
        .find(|name| crate::renderer::equation::font::is_legacy_equation_font(name))
    else {
        return false;
    };
    let Some(typeface) = fonts.resolve(family, FontStyle::normal()) else {
        return false;
    };
    let text = glyph.to_string();
    if !typeface_covers_text(&typeface, &text) {
        return false;
    }
    let mut font = Font::new(typeface, font_size as f32);
    font.set_edging(font::Edging::AntiAlias);
    let mut paint = Paint::default();
    paint.set_anti_alias(true);
    paint.set_color(color);
    let natural = font.measure_str(&text, Some(&paint)).0 as f64;
    if let Some(w) = advance_w {
        if natural > 0.0 && (w - natural).abs() / natural > 0.02 {
            canvas.save();
            canvas.translate((x as f32, 0.0));
            canvas.scale(((w / natural) as f32, 1.0));
            canvas.translate((-x as f32, 0.0));
            draw_text_run(canvas, &text, (x as f32, baseline_y as f32), &font, &paint);
            canvas.restore();
            return true;
        }
    }
    draw_text_run(canvas, &text, (x as f32, baseline_y as f32), &font, &paint);
    true
}

// e044 '(' / e045 ')' 의 잉크 경계(em). HyhwpEQ 실측값.
fn paren_glyph_ink(bracket: &str) -> ((f64, f64, f64, f64), char) {
    if bracket == "(" {
        ((0.0996, -0.2021, 0.3369, 0.8066), '\u{e044}')
    } else {
        ((0.0508, -0.2031, 0.2881, 0.8066), '\u{e045}')
    }
}

// legacy PUA 글립을 주어진 잉크 사각형에 맞춰 가로로 늘려 칠한다.
// ink_em = 글립 잉크 경계(em 단위, y1은 baseline 위 잉크 상단).
// 세로 크기는 잉크가 target 높이를 덮도록 정하고 가로만 늘린다.
fn draw_legacy_pua_glyph_scaled(
    canvas: &Canvas,
    fonts: &EqFonts<'_>,
    font_families: &[&str],
    glyph: char,
    ink_em: (f64, f64, f64, f64),
    target: (f64, f64, f64, f64),
    color: Color,
) -> bool {
    let Some(family) = font_families
        .iter()
        .copied()
        .find(|name| crate::renderer::equation::font::is_legacy_equation_font(name))
    else {
        return false;
    };
    let Some(typeface) = fonts.resolve(family, FontStyle::normal()) else {
        return false;
    };
    let text = glyph.to_string();
    if !typeface_covers_text(&typeface, &text) {
        return false;
    }
    let (x0, y0, x1, y1) = ink_em;
    let (tx, ty, tw, th) = target;
    let ink_w = x1 - x0;
    let ink_h = y1 - y0;
    if ink_w <= 0.0 || ink_h <= 0.0 || tw <= 0.0 || th <= 0.0 {
        return false;
    }
    let s = th / ink_h;
    let xs = tw / (ink_w * s);
    let mut font = Font::new(typeface, s as f32);
    font.set_edging(font::Edging::AntiAlias);
    let mut paint = Paint::default();
    paint.set_anti_alias(true);
    paint.set_color(color);
    canvas.save();
    canvas.translate(((tx - xs * x0 * s) as f32, (ty + y1 * s) as f32));
    canvas.scale((xs as f32, 1.0));
    draw_text_run(canvas, &text, (0.0, 0.0), &font, &paint);
    canvas.restore();
    true
}

// legacy 큰 대괄호는 e100/e101/e103(좌)·e102/e105/e104(우) 세 파트를 각각
// ~1em 크기로 쌓아 칠한다 (02-eq-01 실측). 위·아래 파트는 잉크 끝단에 붙이고
// 가운데 연장 파트(e101/e105, 세로 막대)는 남은 구간에 균등 배치한다.
// 글립 잉크 경계(em): 위/아래 파트 −0.208..0.733 / −0.152..0.792,
// 가운데 파트 −0.208..0.792.
fn draw_legacy_square_bracket(
    canvas: &Canvas,
    fonts: &EqFonts<'_>,
    font_families: &[&str],
    left: bool,
    x: f64,
    ty: f64,
    th: f64,
    fs: f64,
    color: Color,
) -> bool {
    let (top_g, mid_g, bot_g) = if left {
        ('\u{e100}', '\u{e101}', '\u{e103}')
    } else {
        ('\u{e102}', '\u{e105}', '\u{e104}')
    };
    if th <= 0.0 {
        return false;
    }
    let s = fs;
    let top_org = ty + 0.733 * s;
    let bot_org = ty + th - 0.152 * s;
    if !draw_legacy_pua_glyph(
        canvas,
        fonts,
        font_families,
        top_g,
        x,
        top_org,
        s,
        None,
        color,
    ) || !draw_legacy_pua_glyph(
        canvas,
        fonts,
        font_families,
        bot_g,
        x,
        bot_org,
        s,
        None,
        color,
    ) {
        return false;
    }
    let top_ink_bottom = ty + 0.941 * s;
    let bot_ink_top = ty + th - 0.944 * s;
    let span = (bot_ink_top - top_ink_bottom).max(0.0);
    let mid_h = s;
    let n = ((span + mid_h * 0.2) / (mid_h * 0.7)).ceil().max(1.0) as i32;
    for i in 0..n {
        let center = top_ink_bottom + span * (i as f64 + 0.5) / f64::from(n);
        let org = center + 0.292 * s;
        if !draw_legacy_pua_glyph(canvas, fonts, font_families, mid_g, x, org, s, None, color) {
            return false;
        }
    }
    true
}

fn equation_typeface_for_text_in_families(
    families: &[&str],
    fonts: &EqFonts<'_>,
    font_style: FontStyle,
    text: &str,
) -> Option<Typeface> {
    if fonts.modern
        && families
            .first()
            .is_some_and(|family| crate::renderer::equation::font::is_legacy_equation_font(family))
        && crate::renderer::equation::font::modern_hancom_fallback_run_advance_em(text).is_some()
    {
        if let Some(typeface) = fonts
            .resolve("Haansoft Batang", font_style)
            .filter(|typeface| typeface_covers_text(typeface, text))
        {
            return Some(typeface);
        }
    }
    let resolved: Vec<Typeface> = families
        .iter()
        .copied()
        .filter(|family| !crate::renderer::equation::font::is_legacy_equation_font(family))
        .filter_map(|family| fonts.resolve(family, font_style))
        .collect();
    if let Some(typeface) = resolved
        .iter()
        .find(|typeface| typeface_covers_text(typeface, text))
    {
        return Some(typeface.clone());
    }
    // macOS 한컴의 현대 HY 수식은 HYhwpEQ가 커버하지 않는 한글을
    // Haansoft Batang으로 칠한다. 번들 서체가 등록된 경우 같은 원본
    // 글립을 우선하고, 없는 환경에서는 기존 serif fallback을 유지한다.
    if fonts.modern
        && families
            .first()
            .is_some_and(|family| crate::renderer::equation::font::is_legacy_equation_font(family))
        && text
            .chars()
            .any(crate::renderer::equation::layout::is_cjk_char)
    {
        if let Some(typeface) = fonts
            .resolve("Haansoft Batang", font_style)
            .filter(|typeface| typeface_covers_text(typeface, text))
        {
            return Some(typeface);
        }
    }
    // 수식 서체 체인이 커버하지 못하는 문자(수식 안 한글 등): 본문 텍스트
    // 경로(text_replay::typeface_for_character)와 동일하게 커버 서체를 찾는다.
    // serif 계열 CJK fallback 후보 → 시스템 문자 fallback 순. 바로 legacy
    // 서체로 떨어지면 한글이 .notdef(tofu)로 그려진다.
    let uncovered = text.chars().find(|character| {
        !character.is_whitespace()
            && resolved
                .iter()
                .all(|typeface| typeface.unichar_to_glyph(*character as i32) == 0)
    });
    if uncovered.is_some() {
        if let Some(typeface) = super::text_replay::SERIF_CJK_FALLBACK_FAMILIES
            .iter()
            .filter_map(|family| fonts.resolve(family, font_style))
            .find(|typeface| typeface_covers_text(typeface, text))
        {
            return Some(typeface);
        }
        if let Some(typeface) = uncovered.and_then(|character| {
            fonts
                .mgr
                .match_family_style_character("", font_style, &[], character as i32)
                .filter(|typeface| typeface.unichar_to_glyph(character as i32) != 0)
        }) {
            return Some(typeface);
        }
    }
    legacy_typeface_for_style(fonts.mgr, font_style)
}

fn typeface_covers_text(typeface: &Typeface, text: &str) -> bool {
    text.chars()
        .filter(|character| !character.is_whitespace())
        .all(|character| typeface.unichar_to_glyph(character as i32) != 0)
}

fn draw_stretch_bracket(
    canvas: &Canvas,
    fonts: &EqFonts<'_>,
    font_families: &[&str],
    bracket: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    color: Color,
    fs: f64,
) {
    let mid_x = x + w / 2.0;
    let paint = stroke_paint(color, fs * 0.04);

    match bracket {
        "(" => {
            let mut path = PathBuilder::new();
            path.move_to(((mid_x + w * 0.2) as f32, y as f32));
            path.quad_to(
                (x as f32, (y + h / 2.0) as f32),
                ((mid_x + w * 0.2) as f32, (y + h) as f32),
            );
            canvas.draw_path(&path.detach(), &paint);
        }
        ")" => {
            let mut path = PathBuilder::new();
            path.move_to(((mid_x - w * 0.2) as f32, y as f32));
            path.quad_to(
                ((x + w) as f32, (y + h / 2.0) as f32),
                ((mid_x - w * 0.2) as f32, (y + h) as f32),
            );
            canvas.draw_path(&path.detach(), &paint);
        }
        "[" => {
            let mut path = PathBuilder::new();
            path.move_to(((mid_x + w * 0.2) as f32, y as f32));
            path.line_to(((mid_x - w * 0.2) as f32, y as f32));
            path.line_to(((mid_x - w * 0.2) as f32, (y + h) as f32));
            path.line_to(((mid_x + w * 0.2) as f32, (y + h) as f32));
            canvas.draw_path(&path.detach(), &paint);
        }
        "]" => {
            let mut path = PathBuilder::new();
            path.move_to(((mid_x - w * 0.2) as f32, y as f32));
            path.line_to(((mid_x + w * 0.2) as f32, y as f32));
            path.line_to(((mid_x + w * 0.2) as f32, (y + h) as f32));
            path.line_to(((mid_x - w * 0.2) as f32, (y + h) as f32));
            canvas.draw_path(&path.detach(), &paint);
        }
        "{" => {
            let qh = h / 4.0;
            let mut path = PathBuilder::new();
            path.move_to(((mid_x + w * 0.2) as f32, y as f32));
            path.quad_to(
                ((mid_x - w * 0.1) as f32, y as f32),
                ((mid_x - w * 0.1) as f32, (y + qh) as f32),
            );
            path.quad_to(
                ((mid_x - w * 0.1) as f32, (y + qh * 2.0) as f32),
                ((mid_x - w * 0.3) as f32, (y + qh * 2.0) as f32),
            );
            path.quad_to(
                ((mid_x - w * 0.1) as f32, (y + qh * 2.0) as f32),
                ((mid_x - w * 0.1) as f32, (y + qh * 3.0) as f32),
            );
            path.quad_to(
                ((mid_x - w * 0.1) as f32, (y + h) as f32),
                ((mid_x + w * 0.2) as f32, (y + h) as f32),
            );
            canvas.draw_path(&path.detach(), &paint);
        }
        "}" => {
            let qh = h / 4.0;
            let mut path = PathBuilder::new();
            path.move_to(((mid_x - w * 0.2) as f32, y as f32));
            path.quad_to(
                ((mid_x + w * 0.1) as f32, y as f32),
                ((mid_x + w * 0.1) as f32, (y + qh) as f32),
            );
            path.quad_to(
                ((mid_x + w * 0.1) as f32, (y + qh * 2.0) as f32),
                ((mid_x + w * 0.3) as f32, (y + qh * 2.0) as f32),
            );
            path.quad_to(
                ((mid_x + w * 0.1) as f32, (y + qh * 2.0) as f32),
                ((mid_x + w * 0.1) as f32, (y + qh * 3.0) as f32),
            );
            path.quad_to(
                ((mid_x + w * 0.1) as f32, (y + h) as f32),
                ((mid_x - w * 0.2) as f32, (y + h) as f32),
            );
            canvas.draw_path(&path.detach(), &paint);
        }
        "|" => {
            canvas.draw_line(
                (mid_x as f32, y as f32),
                (mid_x as f32, (y + h) as f32),
                &paint,
            );
        }
        _ => {
            draw_text(
                canvas,
                fonts,
                font_families,
                bracket,
                mid_x,
                y + h * 0.7,
                h,
                false,
                false,
                color,
                true,
            );
        }
    }
}

fn draw_decoration(
    canvas: &Canvas,
    kind: DecoKind,
    mid_x: f64,
    y: f64,
    width: f64,
    color: Color,
    fs: f64,
) {
    let half_w = width / 2.0;
    let paint = stroke_paint(color, fs * 0.03);

    match kind {
        DecoKind::Hat => {
            let mut path = PathBuilder::new();
            path.move_to(((mid_x - half_w * 0.6) as f32, (y + fs * 0.15) as f32));
            path.line_to((mid_x as f32, y as f32));
            path.line_to(((mid_x + half_w * 0.6) as f32, (y + fs * 0.15) as f32));
            canvas.draw_path(&path.detach(), &paint);
        }
        DecoKind::Bar | DecoKind::Overline => {
            canvas.draw_line(
                ((mid_x - half_w) as f32, (y + fs * 0.05) as f32),
                ((mid_x + half_w) as f32, (y + fs * 0.05) as f32),
                &paint,
            );
        }
        DecoKind::Vec => {
            let arrow_y = y + fs * 0.05;
            canvas.draw_line(
                ((mid_x - half_w) as f32, arrow_y as f32),
                ((mid_x + half_w) as f32, arrow_y as f32),
                &paint,
            );
            let mut head = PathBuilder::new();
            head.move_to((
                (mid_x + half_w - fs * 0.1) as f32,
                (arrow_y - fs * 0.06) as f32,
            ));
            head.line_to(((mid_x + half_w) as f32, arrow_y as f32));
            head.line_to((
                (mid_x + half_w - fs * 0.1) as f32,
                (arrow_y + fs * 0.06) as f32,
            ));
            canvas.draw_path(&head.detach(), &paint);
        }
        DecoKind::Tilde => {
            let ty = y + fs * 0.08;
            let mut path = PathBuilder::new();
            path.move_to(((mid_x - half_w * 0.6) as f32, ty as f32));
            path.quad_to(
                ((mid_x - half_w * 0.2) as f32, (ty - fs * 0.08) as f32),
                (mid_x as f32, ty as f32),
            );
            path.quad_to(
                ((mid_x + half_w * 0.2) as f32, (ty + fs * 0.08) as f32),
                ((mid_x + half_w * 0.6) as f32, ty as f32),
            );
            canvas.draw_path(&path.detach(), &paint);
        }
        DecoKind::Dot => {
            canvas.draw_circle(
                (mid_x as f32, (y + fs * 0.06) as f32),
                (fs * 0.03) as f32,
                &fill_paint(color),
            );
        }
        DecoKind::DDot => {
            let gap = fs * 0.1;
            let fill = fill_paint(color);
            canvas.draw_circle(
                ((mid_x - gap) as f32, (y + fs * 0.06) as f32),
                (fs * 0.03) as f32,
                &fill,
            );
            canvas.draw_circle(
                ((mid_x + gap) as f32, (y + fs * 0.06) as f32),
                (fs * 0.03) as f32,
                &fill,
            );
        }
        DecoKind::Underline | DecoKind::Under => {
            let underline_y = y + fs * 1.1;
            canvas.draw_line(
                ((mid_x - half_w) as f32, underline_y as f32),
                ((mid_x + half_w) as f32, underline_y as f32),
                &paint,
            );
        }
        DecoKind::StrikeThrough => {
            canvas.draw_line(
                ((mid_x - half_w) as f32, (y + fs * 1.14) as f32),
                ((mid_x + half_w) as f32, (y + fs * 0.14) as f32),
                &paint,
            );
        }
        _ => {
            canvas.draw_line(
                ((mid_x - half_w * 0.5) as f32, (y + fs * 0.1) as f32),
                ((mid_x + half_w * 0.5) as f32, (y + fs * 0.1) as f32),
                &paint,
            );
        }
    }
}

fn estimate_op_width(text: &str, fs: f64) -> f64 {
    text.chars().count() as f64 * fs * 0.6
}

/// 현대 HY 적분은 굽은 글리프를 칠하고, 다른 적분은 기존 stroke path 를 사용한다.
///
/// 대체 stroke path 는 SVG/Canvas 와 같은 적분 잉크 범위를 사용한다.
fn draw_integral(
    canvas: &Canvas,
    fonts: &EqFonts<'_>,
    font_families: &[&str],
    x: f64,
    y: f64,
    fs: f64,
    color: Color,
) {
    let modern_hy = fonts.modern
        && font_families
            .first()
            .is_some_and(|name| crate::renderer::equation::font::is_legacy_equation_font(name));
    if modern_hy {
        // STIXGeneral ∫의 잉크 높이(1.144em)를 현대 HY의 약 2em에 맞춘다.
        let mgr = FontMgr::default();
        if let Some(face) = mgr.match_family_style("STIXGeneral", FontStyle::normal()) {
            if typeface_covers_text(&face, "∫") {
                let mut font = Font::new(face, (fs * 1.748) as f32);
                font.set_edging(font::Edging::AntiAlias);
                let mut paint = Paint::default();
                paint.set_anti_alias(true);
                paint.set_color(color);
                draw_text_run(
                    canvas,
                    "∫",
                    ((x + fs * 0.042) as f32, (y + fs * 1.94) as f32),
                    &font,
                    &paint,
                );
                return;
            }
        }
    }
    let g = integral_geom(fs);
    let top_y = integral_fallback_top_y(g, fs, modern_hy);
    let h = g.bottom_y - top_y;
    let p0x = x + g.bottom_hook_x;
    let p0y = y + g.bottom_y;
    let p3x = x + g.top_hook_x;
    let p3y = y + top_y;
    let c1x = x + g.width * 1.02;
    let c1y = y + g.bottom_y - h * 0.30;
    let c2x = x - g.width * 0.10;
    let c2y = y + top_y + h * 0.30;
    let mut paint = stroke_paint(color, g.stroke_w);
    paint.set_stroke_cap(paint::Cap::Round);
    let mut path = PathBuilder::new();
    path.move_to((p0x as f32, p0y as f32));
    path.cubic_to(
        (c1x as f32, c1y as f32),
        (c2x as f32, c2y as f32),
        (p3x as f32, p3y as f32),
    );
    canvas.draw_path(&path.detach(), &paint);
}

fn fill_paint(color: Color) -> Paint {
    let mut paint = Paint::default();
    paint.set_anti_alias(true);
    paint.set_style(paint::Style::Fill);
    paint.set_color(color);
    paint
}

fn stroke_paint(color: Color, width: f64) -> Paint {
    let mut paint = Paint::default();
    paint.set_anti_alias(true);
    paint.set_style(paint::Style::Stroke);
    paint.set_stroke_width(width.max(0.5) as f32);
    paint.set_color(color);
    paint
}

fn colorref_to_skia(color: u32, alpha_scale: f32) -> Color {
    let b = ((color >> 16) & 0xFF) as u8;
    let g = ((color >> 8) & 0xFF) as u8;
    let r = (color & 0xFF) as u8;
    let a = (255.0 * alpha_scale.clamp(0.0, 1.0)).round() as u8;
    Color::from_argb(a, r, g, b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer::skia::font_lookup::collect_system_families;

    #[test]
    fn installed_stix_text_italic_precedes_regular_only_math_face() {
        let font_mgr = FontMgr::default();
        let system_families = collect_system_families(&font_mgr);
        if !system_families.contains("STIX Two Text") || !system_families.contains("STIX Two Math")
        {
            return;
        }
        let custom = TypefaceCatalog::new();
        let bundled = TypefaceCatalog::new();
        let fonts = EqFonts {
            mgr: &font_mgr,
            custom: &custom,
            bundled: &bundled,
            system: &system_families,
            modern: true,
        };

        let selected = equation_typeface_for_text_in_families(
            &["STIX Two Text", "STIX Two Math"],
            &fonts,
            FontStyle::italic(),
            "f",
        )
        .expect("a STIX equation face");

        assert_eq!(selected.family_name(), "STIX Two Text");
        assert_eq!(selected.font_style().slant(), FontStyle::italic().slant());
    }

    #[test]
    fn unsupported_text_symbol_falls_through_to_math_face() {
        let font_mgr = FontMgr::default();
        let system_families = collect_system_families(&font_mgr);
        if !system_families.contains("STIX Two Text") || !system_families.contains("STIX Two Math")
        {
            return;
        }

        let text_face = match_system_family_style(
            &font_mgr,
            &system_families,
            "STIX Two Text",
            FontStyle::normal(),
        )
        .expect("installed STIX Two Text face");
        let math_face = match_system_family_style(
            &font_mgr,
            &system_families,
            "STIX Two Math",
            FontStyle::normal(),
        )
        .expect("installed STIX Two Math face");
        if typeface_covers_text(&text_face, "→") || !typeface_covers_text(&math_face, "→") {
            return;
        }
        let custom = TypefaceCatalog::new();
        let bundled = TypefaceCatalog::new();
        let fonts = EqFonts {
            mgr: &font_mgr,
            custom: &custom,
            bundled: &bundled,
            system: &system_families,
            modern: true,
        };

        let selected = equation_typeface_for_text_in_families(
            &["STIX Two Text", "STIX Two Math"],
            &fonts,
            FontStyle::normal(),
            "→",
        )
        .expect("an equation face containing right arrow");

        assert_eq!(selected.family_name(), "STIX Two Math");
        assert!(typeface_covers_text(&selected, "→"));
    }
}

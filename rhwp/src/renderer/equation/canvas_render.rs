//! 수식 Canvas 렌더러
//!
//! LayoutBox를 HTML5 Canvas 2D API로 직접 렌더링한다.
//! WASM 환경에서만 컴파일된다.

use super::ast::MatrixStyle;
use super::layout::*;
use super::symbols::{DecoKind, FontStyleKind};
use wasm_bindgen::prelude::*;
use web_sys::CanvasRenderingContext2d;

struct EquationFont {
    source: String,
    family: String,
    hft: bool,
    modern_hy: bool,
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(catch, js_namespace = globalThis, js_name = resolveEquationFontFamily)]
    fn resolve_equation_font_family(source: &str, glyphs: &str) -> Result<Option<String>, JsValue>;
    #[wasm_bindgen(catch, js_namespace = globalThis, js_name = resolveEquationLiteralFont)]
    fn resolve_equation_literal_font(text: &str) -> Result<JsValue, JsValue>;
}

/// 수식을 Canvas에 렌더링
pub fn render_equation_canvas(
    ctx: &CanvasRenderingContext2d,
    layout: &LayoutBox,
    origin_x: f64,
    origin_y: f64,
    color: &str,
    base_font_size: f64,
    font_family: &str,
    version_info: &str,
) {
    let font_family = EquationFont {
        source: font_family.to_string(),
        family: super::font::equation_css_font_family(Some(font_family)),
        hft: version_info.is_empty() && super::font::is_legacy_equation_font(font_family),
        modern_hy: !version_info.is_empty() && super::font::is_legacy_equation_font(font_family),
    };
    // 진입점 default: italic=true (hwpeq 변수 기본 스타일).
    // FontStyle::Roman(`rm`) 적용 영역에서는 자식 렌더링 시 italic=false 로 전환된다.
    render_box(
        ctx,
        layout,
        origin_x,
        origin_y,
        color,
        base_font_size,
        true,
        false,
        &font_family,
    );
}

fn render_box(
    ctx: &CanvasRenderingContext2d,
    lb: &LayoutBox,
    parent_x: f64,
    parent_y: f64,
    color: &str,
    fs: f64,
    italic: bool,
    bold: bool,
    font_family: &EquationFont,
) {
    let x = parent_x + lb.x;
    let y = parent_y + lb.y;
    if let Some(glyphs) = lb.positioned_glyphs() {
        for glyph in glyphs {
            render_box(ctx, &glyph, x, y, color, fs, italic, bold, font_family);
        }
        return;
    }

    match &lb.kind {
        LayoutKind::Row(children) => {
            for child in children {
                render_box(ctx, child, x, y, color, fs, italic, bold, font_family);
            }
        }
        LayoutKind::Text(text) => {
            // 첨자 잎은 레이아웃의 실제 em(legacy 0.68)을 사용한다.
            let fi = leaf_font_size(lb, fs);
            // CJK 문자는 italic 미적용. FontStyle::Roman(`rm`)으로 italic=false 가
            // 전달된 경우에도 italic 미적용 (svg_render.rs Text arm 과 동일 정책).
            let has_cjk = text.chars().any(|c| {
                matches!(c,
                    '\u{3000}'..='\u{9FFF}' | '\u{F900}'..='\u{FAFF}' | '\u{AC00}'..='\u{D7AF}'
                )
            });
            ctx.set_fill_style_str(color);
            if font_family.hft && !text.is_ascii() {
                draw_legacy_literal(ctx, text, x, y + lb.baseline, fi, italic, bold, font_family);
                return;
            }
            draw_text(
                ctx,
                text,
                x,
                y + lb.baseline,
                fi,
                !has_cjk
                    && !(font_family.modern_hy
                        && super::font::modern_hancom_fallback_run_advance_em(text).is_some())
                    && italic,
                bold,
                font_family,
            );
        }
        LayoutKind::Number(text) => {
            let fi = leaf_font_size(lb, fs);
            ctx.set_fill_style_str(color);
            draw_text(ctx, text, x, y + lb.baseline, fi, false, bold, font_family);
        }
        LayoutKind::Symbol(text) => {
            let fi = leaf_font_size(lb, fs);
            ctx.set_fill_style_str(color);
            ctx.set_text_align("center");
            draw_text(
                ctx,
                text,
                x + lb.width / 2.0,
                y + lb.baseline,
                fi,
                false,
                false,
                font_family,
            );
            ctx.set_text_align("start");
        }
        LayoutKind::MathSymbol(text) => {
            // [Issue #900] svg_render.rs MathSymbol arm 과 동기화 (commit 292dbbef).
            // Task #1317: 적분 기호(∫)는 폰트 text 가 아닌 stroke path 로 렌더(geom SSOT,
            // svg_render.rs 와 동일). 그 외 MathSymbol 은 측정된 잎 크기로 렌더.
            if super::layout::is_integral_symbol(text) {
                draw_integral(ctx, x, y, fs, color, font_family.modern_hy);
            } else {
                ctx.set_fill_style_str(color);
                draw_text(
                    ctx,
                    text,
                    x,
                    y + lb.baseline,
                    leaf_font_size(lb, fs),
                    italic && super::font::is_greek_variable(text),
                    false,
                    font_family,
                );
            }
        }
        LayoutKind::Function(name) => {
            let fi = leaf_font_size(lb, fs);
            ctx.set_fill_style_str(color);
            draw_text(ctx, name, x, y + lb.baseline, fi, false, false, font_family);
        }
        LayoutKind::Fraction {
            numer,
            denom,
            bar_inset,
        } => {
            render_box(ctx, numer, x, y, color, fs, italic, bold, font_family);
            // 분수선 — baseline에서 axis_height 위에 배치 (SVG 경로와 동일)
            let line_y = y + super::layout::fraction_line_y(numer, fs);
            let line_thick = fs * 0.04;
            ctx.set_stroke_style_str(color);
            ctx.set_line_width(line_thick);
            ctx.begin_path();
            ctx.move_to(x + bar_inset, line_y);
            ctx.line_to(x + lb.width - bar_inset, line_y);
            ctx.stroke();
            render_box(ctx, denom, x, y, color, fs, italic, bold, font_family);
        }
        LayoutKind::Atop { top, bottom } => {
            render_box(ctx, top, x, y, color, fs, italic, bold, font_family);
            render_box(ctx, bottom, x, y, color, fs, italic, bold, font_family);
        }
        LayoutKind::Sqrt { index, body } => {
            let sign_x = x;
            // 네이티브와 같은 HyhwpEQ 근호/윗줄을 사용한다. 두 글립이 모두
            // 준비되지 않았으면 기존 기하 경로로 돌아간다.
            let pair_available = super::font::is_legacy_equation_font(&font_family.source)
                && matches!(
                    resolve_equation_font_family(&font_family.source, "\u{e05c}\u{e06d}"),
                    Ok(Some(_))
                );
            let geom = sqrt_pua_geometry(body, lb.baseline, lb.width, fs, !font_family.hft);
            let sign_painted = pair_available
                && draw_legacy_pua_glyph(
                    ctx,
                    font_family,
                    '\u{e05c}',
                    x + body.x - fs,
                    y + geom.sign_baseline,
                    geom.sign_size,
                    Some(fs),
                    color,
                );
            if sign_painted {
                let bar_painted = draw_legacy_pua_glyph(
                    ctx,
                    font_family,
                    '\u{e06d}',
                    x + body.x - fs * 0.03,
                    y + geom.bar_baseline,
                    geom.bar_size,
                    Some(geom.bar_advance),
                    color,
                );
                if !bar_painted {
                    ctx.set_stroke_style_str(color);
                    ctx.set_line_width(fs * 0.04);
                    ctx.begin_path();
                    ctx.move_to(x + body.x - fs * 0.03, y);
                    ctx.line_to(x + lb.width, y);
                    ctx.stroke();
                }
            } else {
                let body_left = x + body.x - fs * 0.1;
                let mid_x = body_left - fs * 0.15;
                let mid_y = y + lb.height;
                let start_x = mid_x - fs * 0.3;
                let start_y = y + lb.height * 0.6;
                let tick_x = start_x - fs * 0.1;
                let tick_y = start_y - fs * 0.05;
                ctx.set_stroke_style_str(color);
                ctx.set_line_width(fs * 0.04);
                ctx.begin_path();
                ctx.move_to(tick_x, tick_y);
                ctx.line_to(start_x, start_y);
                ctx.line_to(mid_x, mid_y);
                ctx.line_to(body_left, y);
                ctx.line_to(x + lb.width, y);
                ctx.stroke();
            }

            if let Some(idx) = index {
                render_box(
                    ctx,
                    idx,
                    sign_x,
                    y,
                    color,
                    fs * SCRIPT_SCALE,
                    false,
                    false,
                    font_family,
                );
            }
            render_box(ctx, body, x, y, color, fs, italic, bold, font_family);
        }
        LayoutKind::Superscript { base, sup } => {
            render_box(ctx, base, x, y, color, fs, italic, bold, font_family);
            render_box(
                ctx,
                sup,
                x,
                y,
                color,
                fs * SCRIPT_SCALE,
                italic,
                bold,
                font_family,
            );
        }
        LayoutKind::Subscript { base, sub } => {
            render_box(ctx, base, x, y, color, fs, italic, bold, font_family);
            render_box(
                ctx,
                sub,
                x,
                y,
                color,
                fs * SCRIPT_SCALE,
                italic,
                bold,
                font_family,
            );
        }
        LayoutKind::SubSup { base, sub, sup } => {
            render_box(ctx, base, x, y, color, fs, italic, bold, font_family);
            render_box(
                ctx,
                sub,
                x,
                y,
                color,
                fs * SCRIPT_SCALE,
                italic,
                bold,
                font_family,
            );
            render_box(
                ctx,
                sup,
                x,
                y,
                color,
                fs * SCRIPT_SCALE,
                italic,
                bold,
                font_family,
            );
        }
        LayoutKind::BigOp { symbol, sub, sup } => {
            // [Issue #900] svg_render.rs BigOp arm 과 동기화 (commit 292dbbef).
            // 적분 (∫, ∮ 등): 기호 좌측, 첨자 우상단/우하단 (nolimits)
            // 그 외 (∑, ∏ 등): 기호 중앙, 첨자 위/아래 (limits)
            let is_integral = super::layout::is_integral_symbol(symbol);
            let modern_hy_sum = symbol == "∑"
                && !font_family.hft
                && super::font::is_legacy_equation_font(&font_family.source);
            // Task #1313: 적분은 전용 스케일(INTEGRAL_SCALE), ∑/∏ 등은 BIG_OP_SCALE.
            let op_fs = fs
                * if is_integral {
                    INTEGRAL_SCALE
                } else if modern_hy_sum {
                    super::layout::MODERN_HY_SUM_SCALE
                } else {
                    BIG_OP_SCALE
                };
            ctx.set_fill_style_str(color);
            if is_integral {
                draw_integral(ctx, x, y, fs, color, font_family.modern_hy);
            } else {
                let sup_h = sup.as_ref().map(|b| b.height + fs * 0.05).unwrap_or(0.0);
                // Task #1233: 연산자는 max_w(= lb.width - trailing pad)에 중앙정렬 →
                // pad 전체가 순수 trailing 간격이 되고 첨자(max_w 중앙정렬)와 정렬된다.
                // #1304: 연산자 폭은 layout 의 estimate_text_width 와 동일 기준을 써야 첨자와
                // 가로 중심이 맞는다 (기존 estimate_op_width 의 0.6 과소추정 → ∑ 우측 치우침).
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
                draw_text(ctx, symbol, op_x, op_y, op_fs, false, false, font_family);
            }
            // 위/아래 첨자 — LayoutBox 자식 좌표 사용 (적분/일반 공통)
            if let Some(sup_box) = sup {
                render_box(
                    ctx,
                    sup_box,
                    x,
                    y,
                    color,
                    fs * SCRIPT_SCALE,
                    modern_hy_sum && italic,
                    false,
                    font_family,
                );
            }
            if let Some(sub_box) = sub {
                render_box(
                    ctx,
                    sub_box,
                    x,
                    y,
                    color,
                    fs * SCRIPT_SCALE,
                    modern_hy_sum && italic,
                    false,
                    font_family,
                );
            }
        }
        LayoutKind::Limit {
            is_upper,
            sub,
            name_x,
            name_y,
        } => {
            // [Task PR #396 후속] SVG 경로 (svg_render.rs::Limit) 와 동일하게 base font_size 사용.
            // font_size_from_box(lb, fs) 는 lb.height 를 사용하는데, Limit 의 lb 는 "lim + 첨자"
            // 전체 높이라 base 의 1.5~2 배가 되어 lim 글자가 비정상으로 커지는 정황.
            let name = if *is_upper { "Lim" } else { "lim" };
            // 이름 크기는 상자 기준선(0.8×이름 크기)에서 얻는다 (현대 HY 1.2배).
            let fi = lb.baseline / 0.8;
            ctx.set_fill_style_str(color);
            draw_text(
                ctx,
                name,
                x + name_x,
                y + lb.baseline + name_y,
                fi,
                false,
                false,
                font_family,
            );
            if let Some(sub_box) = sub {
                render_box(
                    ctx,
                    sub_box,
                    x,
                    y,
                    color,
                    fs * SCRIPT_SCALE,
                    italic,
                    false,
                    font_family,
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
                draw_stretch_bracket(ctx, bracket_chars.0, x, y, fs * 0.3, lb.height, color, fs);
                draw_stretch_bracket(
                    ctx,
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
                    render_box(ctx, cell, x, y, color, fs, italic, bold, font_family);
                }
            }
        }
        LayoutKind::Rel { arrow, over, under } => {
            render_box(ctx, over, x, y, color, fs, italic, bold, font_family);
            render_box(ctx, arrow, x, y, color, fs, italic, bold, font_family);
            if let Some(u) = under {
                render_box(ctx, u, x, y, color, fs, italic, bold, font_family);
            }
        }
        LayoutKind::EqAlign { rows } => {
            for (left, right) in rows {
                render_box(ctx, left, x, y, color, fs, italic, bold, font_family);
                render_box(ctx, right, x, y, color, fs, italic, bold, font_family);
            }
        }
        LayoutKind::Paren {
            left,
            right,
            body,
            modern_extent,
        } => {
            // 텍스트 높이 파렌(`(`, `)`)은 폰트 글리프로 렌더, 그 외는 path. (Task #283)
            // legacy는 큰 괄호·대괄호도 HyhwpEQ PUA 글립으로 칠한다 — 괄호는
            // 본문 상자 높이의 ~0.94배로 늘린 e044/e045, 대괄호는 e100..e105
            // 파트 쌓기 (02-eq-01 실측).
            let use_glyph = lb.height <= fs * 1.2;
            let (paint_top, paint_height) = modern_extent.unwrap_or((0.0, lb.height));
            let left_paren_stretch = !use_glyph && matches!(left.as_str(), "(" | ")");
            let right_paren_stretch = !use_glyph && matches!(right.as_str(), "(" | ")");
            let paren_w = if use_glyph {
                fs * 0.333
            } else if !use_glyph && matches!((left.as_str(), right.as_str()), ("[", "]")) {
                fs * 0.494
            } else {
                fs * 0.27
            };
            let paren_w = super::layout::paren_bar_slot(lb, body, left, right, fs, paren_w);
            if !left.is_empty() {
                let legacy_painted = (left_paren_stretch && {
                    let (ink, g) = paren_glyph_ink(left);
                    draw_legacy_pua_glyph_scaled(
                        ctx,
                        font_family,
                        g,
                        ink,
                        (
                            x - fs * 0.03,
                            y + lb.height * 0.03,
                            fs * 0.45,
                            lb.height * 0.94,
                        ),
                        color,
                    )
                }) || (!use_glyph
                    && left == "["
                    && draw_legacy_square_bracket(
                        ctx,
                        font_family,
                        true,
                        x,
                        y + lb.height * 0.03,
                        lb.height * 0.94,
                        fs,
                        color,
                    ));
                if !legacy_painted {
                    if !use_glyph
                        && draw_modern_round_paren(
                            ctx,
                            left,
                            x,
                            y,
                            lb,
                            body,
                            fs,
                            color,
                            font_family,
                        )
                    {
                    } else if use_glyph && matches!(left.as_str(), "(" | ")" | "[" | "]") {
                        ctx.set_fill_style_str(color);
                        let left_x = x + super::layout::paren_left_square_ink_offset(
                            lb, body, left, right, fs,
                        );
                        draw_text(
                            ctx,
                            left,
                            left_x,
                            y + lb.baseline,
                            fs,
                            false,
                            false,
                            font_family,
                        );
                    } else {
                        draw_stretch_bracket(
                            ctx,
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
            }
            render_box(ctx, body, x, y, color, fs, italic, bold, font_family);
            if !right.is_empty() {
                let right_x = x + lb.width
                    - super::layout::paren_right_slot(lb, body, left, right, fs, paren_w);
                let legacy_painted = (right_paren_stretch && {
                    let (ink, g) = paren_glyph_ink(right);
                    draw_legacy_pua_glyph_scaled(
                        ctx,
                        font_family,
                        g,
                        ink,
                        (
                            x + lb.width - fs * 0.42,
                            y + lb.height * 0.03,
                            fs * 0.45,
                            lb.height * 0.94,
                        ),
                        color,
                    )
                }) || (!use_glyph
                    && right == "]"
                    && draw_legacy_square_bracket(
                        ctx,
                        font_family,
                        false,
                        x + lb.width - fs * 0.494,
                        y + lb.height * 0.03,
                        lb.height * 0.94,
                        fs,
                        color,
                    ));
                if !legacy_painted {
                    if !use_glyph
                        && draw_modern_round_paren(
                            ctx,
                            right,
                            x + lb.width - fs * 0.39,
                            y,
                            lb,
                            body,
                            fs,
                            color,
                            font_family,
                        )
                    {
                    } else if use_glyph && matches!(right.as_str(), "(" | ")" | "[" | "]") {
                        ctx.set_fill_style_str(color);
                        draw_text(
                            ctx,
                            right,
                            right_x,
                            y + lb.baseline,
                            fs,
                            false,
                            false,
                            font_family,
                        );
                    } else {
                        draw_stretch_bracket(
                            ctx,
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
        }
        LayoutKind::Decoration { kind, body } => {
            render_box(ctx, body, x, y, color, fs, italic, bold, font_family);
            let deco_y = y + fs * 0.05;
            let mid_x = x + body.x + body.width / 2.0;
            draw_decoration(ctx, *kind, mid_x, deco_y, body.width, color, fs);
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
                ctx,
                body,
                x,
                y,
                color,
                fs,
                new_italic,
                new_bold,
                font_family,
            );
        }
        LayoutKind::Space(_) | LayoutKind::Newline | LayoutKind::Empty => {}
    }
}

// e044 '(' / e045 ')' 의 잉크 경계(em). HyhwpEQ 실측값.
fn paren_glyph_ink(bracket: &str) -> ((f64, f64, f64, f64), char) {
    if bracket == "(" {
        ((0.0996, -0.2021, 0.3369, 0.8066), '\u{e044}')
    } else {
        ((0.0508, -0.2031, 0.2881, 0.8066), '\u{e045}')
    }
}

/// legacy PUA 글립을 주어진 잉크 사각형에 맞춰 가로로 늘려 칠한다.
/// ink_em = 글립 잉크 경계(em 단위, y1은 baseline 위 잉크 상단).
fn draw_legacy_pua_glyph_scaled(
    ctx: &CanvasRenderingContext2d,
    font: &EquationFont,
    glyph: char,
    ink_em: (f64, f64, f64, f64),
    target: (f64, f64, f64, f64),
    color: &str,
) -> bool {
    if !super::font::is_legacy_equation_font(&font.source) {
        return false;
    }
    let text = glyph.to_string();
    let Ok(Some(family)) = resolve_equation_font_family(&font.source, &text) else {
        return false;
    };
    let (x0, y0, x1, y1) = ink_em;
    let (tx, ty, tw, th) = target;
    let (ink_w, ink_h) = (x1 - x0, y1 - y0);
    if ink_w <= 0.0 || ink_h <= 0.0 || tw <= 0.0 || th <= 0.0 {
        return false;
    }
    let s = th / ink_h;
    let xs = tw / (ink_w * s);
    let family = format!("'{}'", family.replace('\\', "\\\\").replace('\'', "\\'"));
    ctx.save();
    ctx.set_fill_style_str(color);
    set_font(ctx, s, false, false, &family);
    let _ = ctx.translate(tx - xs * x0 * s, ty + y1 * s);
    let _ = ctx.scale(xs, 1.0);
    let _ = ctx.fill_text(&text, 0.0, 0.0);
    ctx.restore();
    true
}

/// legacy 큰 대괄호: e100/e101/e103(좌)·e102/e105/e104(우) 파트 쌓기
/// (02-eq-01 실측). 잉크 끝단 파트 + 가운데 연장 파트 균등 배치.
fn draw_legacy_square_bracket(
    ctx: &CanvasRenderingContext2d,
    font: &EquationFont,
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
    if th <= 0.0 {
        return false;
    }
    let s = fs;
    if !draw_legacy_pua_glyph(ctx, font, top_g, x, ty + 0.733 * s, s, None, color)
        || !draw_legacy_pua_glyph(ctx, font, bot_g, x, ty + th - 0.152 * s, s, None, color)
    {
        return false;
    }
    let top_ink_bottom = ty + 0.941 * s;
    let bot_ink_top = ty + th - 0.944 * s;
    let span = (bot_ink_top - top_ink_bottom).max(0.0);
    let n = ((span + s * 0.2) / (s * 0.7)).ceil().max(1.0) as i32;
    for i in 0..n {
        let center = top_ink_bottom + span * (i as f64 + 0.5) / f64::from(n);
        if !draw_legacy_pua_glyph(ctx, font, mid_g, x, center + 0.292 * s, s, None, color) {
            return false;
        }
    }
    true
}

/// 검증된 구형 수식 글립 하나를 칠하고 필요한 경우 가로 폭만 늘린다.
fn draw_legacy_pua_glyph(
    ctx: &CanvasRenderingContext2d,
    font: &EquationFont,
    glyph: char,
    x: f64,
    baseline_y: f64,
    size: f64,
    advance_w: Option<f64>,
    color: &str,
) -> bool {
    if !super::font::is_legacy_equation_font(&font.source) {
        return false;
    }
    let text = glyph.to_string();
    let Ok(Some(family)) = resolve_equation_font_family(&font.source, &text) else {
        return false;
    };
    let family = format!("'{}'", family.replace('\\', "\\\\").replace('\'', "\\'"));
    ctx.save();
    ctx.set_fill_style_str(color);
    ctx.set_text_align("start");
    set_font(ctx, size, false, false, &family);
    let natural = ctx.measure_text(&text).map(|m| m.width()).unwrap_or(0.0);
    if let Some(width) = advance_w.filter(|_| natural > 0.0) {
        if (width - natural).abs() / natural > 0.02 {
            let _ = ctx.translate(x, 0.0);
            let _ = ctx.scale(width / natural, 1.0);
            let _ = ctx.fill_text(&text, 0.0, baseline_y);
            ctx.restore();
            return true;
        }
    }
    let _ = ctx.fill_text(&text, x, baseline_y);
    ctx.restore();
    true
}

/// PUA는 로드와 cmap이 확인된 세션 서체에만 전달한다. 누락 시 원래 Unicode로 fallback한다.
fn draw_modern_round_paren(
    ctx: &CanvasRenderingContext2d,
    bracket: &str,
    x: f64,
    y: f64,
    lb: &LayoutBox,
    _body: &LayoutBox,
    fs: f64,
    color: &str,
    font: &EquationFont,
) -> bool {
    if font.hft || !super::font::is_legacy_equation_font(&font.source) {
        return false;
    }
    let (glyph, bottom, top) = match bracket {
        "(" => ('\u{e044}', -207.0 / 1024.0, 826.0 / 1024.0),
        ")" => ('\u{e045}', -208.0 / 1024.0, 826.0 / 1024.0),
        _ => return false,
    };
    if !matches!(
        resolve_equation_font_family(&font.source, &glyph.to_string()),
        Ok(Some(_))
    ) {
        return false;
    }
    let LayoutKind::Paren {
        modern_extent: Some((target_top, height)),
        ..
    } = &lb.kind
    else {
        return false;
    };
    let (target_top, height) = (*target_top, *height);
    let scale_y = height / ((top - bottom) * fs);
    ctx.save();
    let _ = ctx.translate(x, y + target_top + top * fs * scale_y);
    let _ = ctx.scale(1.0, scale_y);
    ctx.set_fill_style_str(color);
    draw_text(ctx, bracket, 0.0, 0.0, fs, false, false, font);
    ctx.restore();
    true
}

fn draw_text(
    ctx: &CanvasRenderingContext2d,
    text: &str,
    x: f64,
    y: f64,
    size: f64,
    italic: bool,
    bold: bool,
    font: &EquationFont,
) {
    if font.hft && draw_hft_text(ctx, text, x, y, size, italic, bold) {
        return;
    }
    if super::font::is_legacy_equation_font(&font.source) {
        let mapped: Vec<(char, bool, f64)> = text
            .chars()
            .map(|c| {
                let (glyph, skew) = super::font::legacy_equation_glyph(c, italic, !font.hft);
                let shift = if font.hft {
                    0.0
                } else {
                    super::font::modern_glyph_baseline_em(c, italic)
                };
                (glyph, skew, shift)
            })
            .collect();
        let glyphs: String = mapped.iter().map(|(c, _, _)| *c).collect();
        if let Ok(Some(family)) = resolve_equation_font_family(&font.source, &glyphs) {
            let family = format!("'{}'", family.replace('\\', "\\\\").replace('\'', "\\'"));
            let alignment = ctx.text_align();
            let mut runs: Vec<(String, bool, f64, f64)> = Vec::new();
            for (character, skew, shift) in mapped {
                if let Some(run) = runs
                    .last_mut()
                    .filter(|run| run.1 == skew && run.3 == shift)
                {
                    run.0.push(character);
                } else {
                    runs.push((character.to_string(), skew, 0.0, shift));
                }
            }
            let mut width = 0.0;
            for (text, skew, advance, _) in &mut runs {
                set_font(ctx, size, *skew, bold, &family);
                *advance = ctx.measure_text(text).map(|m| m.width()).unwrap_or(0.0);
                width += *advance;
            }
            let mut pen = x - if alignment == "center" {
                width / 2.0
            } else {
                0.0
            };
            ctx.set_text_align("start");
            for (text, skew, advance, shift) in runs {
                set_font(ctx, size, skew, bold, &family);
                let _ = ctx.fill_text(&text, pen, y + size * shift);
                pen += advance;
            }
            ctx.set_text_align(&alignment);
            return;
        }
    }
    if !font.hft
        && super::font::is_legacy_equation_font(&font.source)
        && super::font::modern_hancom_fallback_run_advance_em(text).is_some()
    {
        set_font(ctx, size, false, bold, "'Haansoft Batang'");
    } else {
        set_font(ctx, size, italic, bold, &font.family);
    }
    let _ = ctx.fill_text(text, x, y);
}

fn draw_legacy_literal(
    ctx: &CanvasRenderingContext2d,
    text: &str,
    x: f64,
    y: f64,
    size: f64,
    italic: bool,
    bold: bool,
    font: &EquationFont,
) {
    let mut pen = x;
    for character in text.chars() {
        let glyph = character.to_string();
        if character.is_ascii() {
            if !draw_hft_text(ctx, &glyph, pen, y, size, italic, bold) {
                set_font(ctx, size, italic, bold, &font.family);
                let _ = ctx.fill_text(&glyph, pen, y);
            }
        } else {
            let resolved = resolve_equation_literal_font(&glyph)
                .ok()
                .and_then(|value| {
                    let family = super::measure::js_property(&value, "family")?.as_string()?;
                    let scale = super::measure::js_property(&value, "emScale")?.as_f64()?;
                    (scale.is_finite() && scale > 0.0 && scale <= 1.0).then_some((family, scale))
                });
            if let Some((family, scale)) = resolved {
                let family = format!("'{}'", family.replace('\\', "\\\\").replace('\'', "\\'"));
                set_font(ctx, size * scale, false, bold, &family);
            } else {
                // literal을 수식 bank의 다른 자형으로 바꾸지 않는다.
                set_font(ctx, size, false, bold, &font.family);
            }
            let _ = ctx.fill_text(&glyph, pen, y);
        }
        pen += ctx.measure_text(&glyph).map(|m| m.width()).unwrap_or(0.0);
    }
}

fn draw_hft_text(
    ctx: &CanvasRenderingContext2d,
    text: &str,
    x: f64,
    y: f64,
    size: f64,
    italic: bool,
    bold: bool,
) -> bool {
    let latin = if italic { "HSUSRI" } else { "HSUSR" };
    let mut runs: Vec<(String, String, f64)> = Vec::new();
    for character in text.chars() {
        let glyph = character.to_string();
        let banks = if italic {
            vec![latin, "HSUSFL", "HSUSSP"]
        } else {
            vec![latin, "HSUSSP"]
        };
        let family = banks
            .into_iter()
            .find_map(|bank| resolve_equation_font_family(bank, &glyph).ok().flatten());
        let Some(family) = family else {
            return false;
        };
        if let Some(run) = runs.last_mut().filter(|run| run.0 == family) {
            run.1.push(character);
        } else {
            runs.push((family, glyph, 0.0));
        }
    }
    let alignment = ctx.text_align();
    let mut width = 0.0;
    for (family, text, advance) in &mut runs {
        *family = format!("'{}'", family.replace('\\', "\\\\").replace('\'', "\\'"));
        // HFT italic bank의 곡선 자체가 기울어져 있다.
        set_font(ctx, size, false, bold, family);
        *advance = ctx.measure_text(text).map(|m| m.width()).unwrap_or(0.0);
        width += *advance;
    }
    let mut pen = x - if alignment == "center" {
        width / 2.0
    } else {
        0.0
    };
    ctx.set_text_align("start");
    for (family, text, advance) in runs {
        set_font(ctx, size, false, bold, &family);
        let _ = ctx.fill_text(&text, pen, y);
        pen += advance;
    }
    ctx.set_text_align(&alignment);
    true
}

fn set_font(
    ctx: &CanvasRenderingContext2d,
    size: f64,
    italic: bool,
    bold: bool,
    font_family: &str,
) {
    // layout 측정(measure::measure_css_run)과 같은 font 문자열이어야 advance가 일치한다.
    ctx.set_font(&super::measure::css_font(size, italic, bold, font_family));
}

/// 현대 HY 적분은 굽은 글리프를 칠하고, 다른 적분은 기존 stroke path 를 사용한다.
///
/// 대체 path 는 SVG 와 같은 가로 기하 및 세로 잉크 범위를 사용한다.
fn draw_integral(
    ctx: &CanvasRenderingContext2d,
    x: f64,
    y: f64,
    fs: f64,
    color: &str,
    modern_hy: bool,
) {
    if modern_hy
        && resolve_equation_font_family("STIXGeneral", "∫")
            .ok()
            .flatten()
            .is_some()
    {
        let previous_font = ctx.font();
        let previous_align = ctx.text_align();
        ctx.set_fill_style_str(color);
        ctx.set_text_align("start");
        set_font(ctx, fs * 1.748, false, false, "'STIXGeneral'");
        let _ = ctx.fill_text("∫", x + fs * 0.042, y + fs * 1.94);
        ctx.set_font(&previous_font);
        ctx.set_text_align(&previous_align);
        return;
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
    ctx.set_stroke_style_str(color);
    ctx.set_line_width(g.stroke_w);
    ctx.set_line_cap("round");
    ctx.begin_path();
    ctx.move_to(p0x, p0y);
    ctx.bezier_curve_to(c1x, c1y, c2x, c2y, p3x, p3y);
    ctx.stroke();
    ctx.set_line_cap("butt");
}

/// 늘림 괄호 렌더링
fn draw_stretch_bracket(
    ctx: &CanvasRenderingContext2d,
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
    ctx.set_stroke_style_str(color);
    ctx.set_line_width(stroke_w);

    match bracket {
        "(" => {
            ctx.begin_path();
            ctx.set_line_cap("round");
            ctx.move_to(x + w * 0.9, y);
            let _ = ctx.bezier_curve_to(
                x + w * 0.05,
                y + h * 0.18,
                x + w * 0.05,
                y + h * 0.82,
                x + w * 0.9,
                y + h,
            );
            ctx.stroke();
            ctx.set_line_cap("butt");
        }
        ")" => {
            ctx.begin_path();
            ctx.set_line_cap("round");
            ctx.move_to(x + w * 0.1, y);
            let _ = ctx.bezier_curve_to(
                x + w * 0.95,
                y + h * 0.18,
                x + w * 0.95,
                y + h * 0.82,
                x + w * 0.1,
                y + h,
            );
            ctx.stroke();
            ctx.set_line_cap("butt");
        }
        "[" => {
            ctx.begin_path();
            ctx.move_to(mid_x + w * 0.2, y);
            ctx.line_to(mid_x - w * 0.2, y);
            ctx.line_to(mid_x - w * 0.2, y + h);
            ctx.line_to(mid_x + w * 0.2, y + h);
            ctx.stroke();
        }
        "]" => {
            ctx.begin_path();
            ctx.move_to(mid_x - w * 0.2, y);
            ctx.line_to(mid_x + w * 0.2, y);
            ctx.line_to(mid_x + w * 0.2, y + h);
            ctx.line_to(mid_x - w * 0.2, y + h);
            ctx.stroke();
        }
        "{" => {
            let qh = h / 4.0;
            ctx.begin_path();
            ctx.move_to(mid_x + w * 0.2, y);
            let _ = ctx.quadratic_curve_to(mid_x - w * 0.1, y, mid_x - w * 0.1, y + qh);
            let _ = ctx.quadratic_curve_to(
                mid_x - w * 0.1,
                y + qh * 2.0,
                mid_x - w * 0.3,
                y + qh * 2.0,
            );
            let _ = ctx.quadratic_curve_to(
                mid_x - w * 0.1,
                y + qh * 2.0,
                mid_x - w * 0.1,
                y + qh * 3.0,
            );
            let _ = ctx.quadratic_curve_to(mid_x - w * 0.1, y + h, mid_x + w * 0.2, y + h);
            ctx.stroke();
        }
        "}" => {
            let qh = h / 4.0;
            ctx.begin_path();
            ctx.move_to(mid_x - w * 0.2, y);
            let _ = ctx.quadratic_curve_to(mid_x + w * 0.1, y, mid_x + w * 0.1, y + qh);
            let _ = ctx.quadratic_curve_to(
                mid_x + w * 0.1,
                y + qh * 2.0,
                mid_x + w * 0.3,
                y + qh * 2.0,
            );
            let _ = ctx.quadratic_curve_to(
                mid_x + w * 0.1,
                y + qh * 2.0,
                mid_x + w * 0.1,
                y + qh * 3.0,
            );
            let _ = ctx.quadratic_curve_to(mid_x + w * 0.1, y + h, mid_x - w * 0.2, y + h);
            ctx.stroke();
        }
        "|" => {
            ctx.begin_path();
            ctx.move_to(mid_x, y);
            ctx.line_to(mid_x, y + h);
            ctx.stroke();
        }
        _ => {
            // 기타 괄호: 텍스트로 렌더링
            set_font(ctx, h, false, false, "serif");
            ctx.set_fill_style_str(color);
            ctx.set_text_align("center");
            let _ = ctx.fill_text(bracket, mid_x, y + h * 0.7);
            ctx.set_text_align("start");
        }
    }
}

/// 장식 렌더링
fn draw_decoration(
    ctx: &CanvasRenderingContext2d,
    kind: DecoKind,
    mid_x: f64,
    y: f64,
    width: f64,
    color: &str,
    fs: f64,
) {
    let stroke_w = fs * 0.03;
    let half_w = width / 2.0;
    ctx.set_stroke_style_str(color);
    ctx.set_line_width(stroke_w);

    match kind {
        DecoKind::Hat => {
            ctx.begin_path();
            ctx.move_to(mid_x - half_w * 0.6, y + fs * 0.15);
            ctx.line_to(mid_x, y);
            ctx.line_to(mid_x + half_w * 0.6, y + fs * 0.15);
            ctx.stroke();
        }
        DecoKind::Bar | DecoKind::Overline => {
            ctx.begin_path();
            ctx.move_to(mid_x - half_w, y + fs * 0.05);
            ctx.line_to(mid_x + half_w, y + fs * 0.05);
            ctx.stroke();
        }
        DecoKind::Vec => {
            let arrow_y = y + fs * 0.05;
            ctx.begin_path();
            ctx.move_to(mid_x - half_w, arrow_y);
            ctx.line_to(mid_x + half_w, arrow_y);
            ctx.stroke();
            ctx.begin_path();
            ctx.move_to(mid_x + half_w - fs * 0.1, arrow_y - fs * 0.06);
            ctx.line_to(mid_x + half_w, arrow_y);
            ctx.line_to(mid_x + half_w - fs * 0.1, arrow_y + fs * 0.06);
            ctx.stroke();
        }
        DecoKind::Tilde => {
            let ty = y + fs * 0.08;
            ctx.begin_path();
            ctx.move_to(mid_x - half_w * 0.6, ty);
            let _ = ctx.quadratic_curve_to(mid_x - half_w * 0.2, ty - fs * 0.08, mid_x, ty);
            let _ = ctx.quadratic_curve_to(
                mid_x + half_w * 0.2,
                ty + fs * 0.08,
                mid_x + half_w * 0.6,
                ty,
            );
            ctx.stroke();
        }
        DecoKind::Dot => {
            ctx.set_fill_style_str(color);
            ctx.begin_path();
            let _ = ctx.arc(mid_x, y + fs * 0.06, fs * 0.03, 0.0, std::f64::consts::TAU);
            ctx.fill();
        }
        DecoKind::DDot => {
            let gap = fs * 0.1;
            ctx.set_fill_style_str(color);
            ctx.begin_path();
            let _ = ctx.arc(
                mid_x - gap,
                y + fs * 0.06,
                fs * 0.03,
                0.0,
                std::f64::consts::TAU,
            );
            ctx.fill();
            ctx.begin_path();
            let _ = ctx.arc(
                mid_x + gap,
                y + fs * 0.06,
                fs * 0.03,
                0.0,
                std::f64::consts::TAU,
            );
            ctx.fill();
        }
        DecoKind::Underline | DecoKind::Under => {
            let uy = y + fs * 1.1;
            ctx.begin_path();
            ctx.move_to(mid_x - half_w, uy);
            ctx.line_to(mid_x + half_w, uy);
            ctx.stroke();
        }
        DecoKind::StrikeThrough => {
            ctx.begin_path();
            ctx.move_to(mid_x - half_w, y + fs * 1.14);
            ctx.line_to(mid_x + half_w, y + fs * 0.14);
            ctx.stroke();
        }
        _ => {
            ctx.begin_path();
            ctx.move_to(mid_x - half_w * 0.5, y + fs * 0.1);
            ctx.line_to(mid_x + half_w * 0.5, y + fs * 0.1);
            ctx.stroke();
        }
    }
}

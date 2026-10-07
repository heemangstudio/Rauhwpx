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
    (i64::from(content_width_hwp(eq))
        + i64::from(eq.common.margin.left)
        + i64::from(eq.common.margin.right))
    .clamp(0, i64::from(i32::MAX)) as i32
}

/// 수식 개체의 내용 폭(HWPUNIT, 바깥 여백 제외).
///
/// 한컴은 문서를 열 때 수식 개체 크기를 스크립트로 다시 계산하고 저장 폭은 쓰지
/// 않는다 (probe: 저장 폭 3000/525/100HU 인 `1` 모두 다음 개체까지 4.725pt,
/// math-001 `…+7` 뒤 본문이 저장 폭이 아니라 내용 끝에 붙음). 원본 수식 서체
/// 메트릭으로 배치할 때만 자연 폭이 그 재계산과 같으므로, 서체가 없으면 저장 폭을 쓴다.
pub(crate) fn content_width_hwp(eq: &crate::model::control::Equation) -> i32 {
    natural_width_hwp(eq).unwrap_or(eq.common.width as i32)
}

/// 원본 수식 서체로 잰 자연 폭(HWPUNIT). 서체 메트릭이 없으면 None.
pub(crate) fn natural_width_hwp(eq: &crate::model::control::Equation) -> Option<i32> {
    use std::cell::RefCell;
    use std::collections::HashMap;
    // An empty EQEDIT can be an authored inline spacer. Hancom keeps its saved
    // width; measuring an empty AST would collapse it to zero.
    if eq.script.is_empty() {
        return None;
    }
    thread_local! {
        // 서체 미해소(None)는 저장하지 않는다 — 원본 서체는 렌더 진입 때 등록될 수 있다.
        static CACHE: RefCell<HashMap<(String, u32, String, String), i32>> =
            RefCell::new(HashMap::new());
    }
    if !font::is_legacy_equation_font(&eq.font_name) || eq.version_info.is_empty() {
        return None;
    }
    let key = (
        eq.script.clone(),
        eq.font_size,
        eq.font_name.clone(),
        eq.version_info.clone(),
    );
    if let Some(hit) = CACHE.with(|cache| cache.borrow().get(&key).copied()) {
        return Some(hit);
    }
    let font_size_px = super::hwpunit_to_px(eq.font_size.max(1) as i32, super::DEFAULT_DPI);
    let engine = layout::EqLayout::with_font(font_size_px, &eq.font_name)
        .with_version(&eq.version_info)
        .with_base_pt(eq.font_size as f64 / 100.0);
    if !engine.has_source_face_metrics() {
        return None;
    }
    let ast = parser::EqParser::new(tokenizer::tokenize(&eq.script)).parse();
    let width = super::px_to_hwpunit_round(engine.layout(&ast).width, super::DEFAULT_DPI).max(0);
    CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() >= 8192 {
            cache.clear();
        }
        cache.insert(key, width);
    });
    Some(width)
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
    // 레이아웃의 is_modern_hy 와 같은 판정 — 버전60 HY 수식은 크기와 무관하게 현대다.
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

fn flat_script_shape(node: &ast::EqNode, sup: &mut bool, sub: &mut bool) -> bool {
    fn atom(node: &ast::EqNode) -> bool {
        matches!(
            node,
            ast::EqNode::Text(_)
                | ast::EqNode::Number(_)
                | ast::EqNode::Symbol(_)
                | ast::EqNode::MathSymbol(_)
                | ast::EqNode::Function(_)
                | ast::EqNode::Space(_)
                | ast::EqNode::Quoted(_)
                | ast::EqNode::Empty
        )
    }
    match node {
        ast::EqNode::Row(children) => children
            .iter()
            .all(|child| flat_script_shape(child, sup, sub)),
        ast::EqNode::Superscript { base, sup: script } => {
            *sup = true;
            atom(base) && atom(script)
        }
        ast::EqNode::Subscript { base, sub: script } => {
            *sub = true;
            atom(base) && atom(script)
        }
        ast::EqNode::SubSup {
            base,
            sub: lower,
            sup: upper,
        } => {
            *sup = true;
            *sub = true;
            atom(base) && atom(lower) && atom(upper)
        }
        other => atom(other),
    }
}

/// Some saved short EQEDIT lines use the object's taller ink box as
/// `textheight`, although `affectLSpacing=0` leaves the surrounding text on
/// its ordinary line. The cached class includes primes and geometric labels;
/// a prime beside a superscript retains its measured upper-script ascent.
/// Keep the source LineSeg intact for roundtrip.
pub(crate) fn stored_unaffected_upper_line_metrics_hu(
    para: &crate::model::paragraph::Paragraph,
    composed: &crate::renderer::composer::ComposedParagraph,
    line_index: usize,
) -> Option<(i32, i32)> {
    use crate::model::control::Control;
    use crate::model::paragraph::LineSeg;

    if composed.lines.len() != para.line_segs.len() {
        return None;
    }
    let seg = para.line_segs.get(line_index)?;
    let line = composed.lines.get(line_index)?;
    if seg.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY != 0
        || line.line_height != seg.line_height
        || line.char_start
            != para
                .char_offsets
                .partition_point(|&offset| offset < seg.text_start)
        || seg.line_height != seg.text_height
    {
        return None;
    }

    let mut result = None;
    for (position, _, control_index) in &composed.tac_controls {
        let owner = composed
            .lines
            .iter()
            .rposition(|candidate| candidate.char_start <= *position);
        if owner != Some(line_index) {
            continue;
        }
        let Some(Control::Equation(eq)) = para.controls.get(*control_index) else {
            continue;
        };
        let (Ok(em), Ok(object_height)) =
            (i32::try_from(eq.font_size), i32::try_from(eq.common.height))
        else {
            continue;
        };
        let object_height_i64 = i64::from(object_height);
        let em_i64 = i64::from(em);
        let saved_shallow_upper_box = (75..=82).contains(&eq.baseline)
            && object_height_i64 >= em_i64 * 6 / 5
            && object_height_i64 <= em_i64 * 13 / 10;
        let bar_prime = (80..=82).contains(&eq.baseline)
            && object_height_i64 >= em_i64 * 7 / 5
            && object_height_i64 <= em_i64 * 3 / 2
            && eq.script.contains("bar")
            && (eq.script.contains("prime") || eq.script.contains('\''));
        if !eq.common.treat_as_char
            || eq.common.affect_line_spacing
            || eq.version_info != "Equation Version 60"
            || !font::is_legacy_equation_font(&eq.font_name)
            || em <= 0
            || object_height != seg.line_height
            || (i64::from(object_height) * i64::from(eq.baseline) / 100
                - i64::from(seg.baseline_distance))
            .abs()
                > 25
        {
            continue;
        }
        if eq.script.contains('_') && !eq.script.contains('^') {
            let em_px = super::hwpunit_to_px(em, super::DEFAULT_DPI);
            let engine = layout::EqLayout::with_font(em_px, &eq.font_name)
                .with_version(&eq.version_info)
                .with_base_pt(f64::from(eq.font_size) / 100.0);
            if engine.has_source_face_metrics() {
                let ast = parser::EqParser::new(tokenizer::tokenize(&eq.script)).parse();
                let (mut sup, mut sub) = (false, false);
                if flat_script_shape(&ast, &mut sup, &mut sub) && sub && !sup {
                    let natural = engine.layout(&ast);
                    let natural_baseline_hu =
                        super::px_to_hwpunit_round(natural.baseline, super::DEFAULT_DPI);
                    let baseline = i64::from(natural_baseline_hu) + i64::from(em) * 6 / 100;
                    if baseline > 0 && baseline < i64::from(seg.line_height) {
                        let Ok(baseline) = i32::try_from(baseline) else {
                            continue;
                        };
                        result = Some((seg.line_height, baseline));
                        continue;
                    }
                }
            }
        }
        if !(saved_shallow_upper_box || bar_prime) {
            continue;
        }
        let (flow_height, baseline) = if eq.script.contains('^') {
            if !saved_shallow_upper_box
                || !(eq.script.contains("prime") || eq.script.contains('\''))
            {
                continue;
            }
            let em_px = super::hwpunit_to_px(em, super::DEFAULT_DPI);
            let engine = layout::EqLayout::with_font(em_px, &eq.font_name)
                .with_version(&eq.version_info)
                .with_base_pt(f64::from(eq.font_size) / 100.0);
            if !engine.has_source_face_metrics() {
                continue;
            }
            let ast = parser::EqParser::new(tokenizer::tokenize(&eq.script)).parse();
            let natural = engine.layout(&ast);
            let height = super::px_to_hwpunit_round(
                line_flow_height(natural.height, natural.baseline, em_px, false),
                super::DEFAULT_DPI,
            )
            .max(em);
            if height >= object_height {
                continue;
            }
            let Ok(baseline) = i32::try_from(em_i64 * 86 / 100 + i64::from(height) - em_i64) else {
                continue;
            };
            (height, baseline)
        } else if bar_prime {
            let Ok(height) = i32::try_from(em_i64 * 6 / 5) else {
                continue;
            };
            let Ok(baseline) = i32::try_from(i64::from(height) * 88 / 100) else {
                continue;
            };
            (height, baseline)
        } else {
            let Ok(baseline) = i32::try_from(em_i64 * 86 / 100) else {
                continue;
            };
            (em, baseline)
        };
        result = Some((flow_height, baseline));
    }
    result
}

pub(crate) fn stored_unaffected_upper_compaction_hu(
    para: &crate::model::paragraph::Paragraph,
) -> i32 {
    if !para
        .controls
        .iter()
        .any(|ctrl| matches!(ctrl, crate::model::control::Control::Equation(_)))
    {
        return 0;
    }
    let composed = crate::renderer::composer::compose_paragraph(para);
    para.line_segs
        .iter()
        .enumerate()
        .filter_map(|(i, seg)| {
            stored_unaffected_upper_line_metrics_hu(para, &composed, i)
                .map(|(height, _)| (seg.line_height - height).max(0))
        })
        .sum()
}

/// An equation-only endnote line can store the height of a non-affecting inline
/// equation as `textheight`. Hancom advances subsequent lines by the ordinary
/// font em instead; the saved LINE_SEG vpos ladder needs this one-line reduction.
pub(crate) fn endnote_unaffected_equation_textheight_compaction_hu(
    para: &crate::model::paragraph::Paragraph,
    composed: &crate::renderer::composer::ComposedParagraph,
    line_index: usize,
) -> i32 {
    use crate::model::control::Control;

    let (Some(seg), Some(next), Some(line)) = (
        para.line_segs.get(line_index),
        para.line_segs.get(line_index + 1),
        composed.lines.get(line_index),
    ) else {
        return 0;
    };
    if !line.runs.iter().all(|run| run.text.trim().is_empty())
        || seg.line_height <= seg.text_height
        || (next.vertical_pos - seg.vertical_pos - seg.text_height - seg.line_spacing).abs() > 1
    {
        return 0;
    }
    let mut max_font = 0;
    let mut max_object_height = 0;
    for (position, _, control_index) in &composed.tac_controls {
        let owner = composed
            .lines
            .iter()
            .rposition(|candidate| candidate.char_start <= *position);
        if owner != Some(line_index) {
            continue;
        }
        let Some(Control::Equation(eq)) = para.controls.get(*control_index) else {
            return 0;
        };
        if !eq.common.treat_as_char
            || eq.common.affect_line_spacing
            || eq.version_info != "Equation Version 60"
            || !font::is_legacy_equation_font(&eq.font_name)
        {
            return 0;
        }
        max_font = max_font.max(eq.font_size as i32);
        max_object_height = max_object_height.max(eq.common.height as i32);
    }
    // The shallow □/△ equation in the Hancom Q28 endnote is 1125HU at 900HU
    // font size; its saved textheight does not extend the text line. An integral
    // with limits in Q29 is 2310HU at the same font size and retains its full
    // line box. Limit this correction to the shallow (at most 1.25em) class.
    if max_font == 0 || max_object_height != seg.text_height || max_object_height > max_font * 5 / 4
    {
        return 0;
    }
    (seg.text_height - max_font).max(0)
}

pub(crate) fn endnote_unaffected_equation_textheight_compaction_total_hu(
    para: &crate::model::paragraph::Paragraph,
) -> i32 {
    let composed = crate::renderer::composer::compose_paragraph(para);
    (0..para.line_segs.len())
        .map(|line| endnote_unaffected_equation_textheight_compaction_hu(para, &composed, line))
        .sum()
}

pub(crate) fn saved_endnote_vpos_continuous(
    previous: &crate::model::paragraph::Paragraph,
    current: &crate::model::paragraph::Paragraph,
) -> bool {
    previous.line_segs.last().is_some_and(|last| {
        current.line_segs.first().is_some_and(|first| {
            last.vertical_pos
                .checked_add(last.line_height)
                .and_then(|end| end.checked_add(last.line_spacing))
                == Some(first.vertical_pos)
        })
    })
}

/// A flat raised-script EQEDIT in an endnote can have a cached line height
/// different from its live box. Return the signed renderer-only advance
/// correction without changing the source LineSeg.
pub(crate) fn endnote_trailing_flat_script_flow_delta_hu(
    para: &crate::model::paragraph::Paragraph,
) -> i32 {
    use crate::model::control::Control;
    use crate::model::paragraph::LineSeg;

    let Some(seg) = para.line_segs.last() else {
        return 0;
    };
    if seg.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY != 0 || seg.line_height != seg.text_height {
        return 0;
    }
    let composed = crate::renderer::composer::compose_paragraph(para);
    if composed.lines.len() != para.line_segs.len() {
        return 0;
    }
    let last = composed.lines.len() - 1;
    if !composed.lines[last]
        .runs
        .iter()
        .any(|run| !run.text.trim().is_empty())
    {
        return 0;
    }
    let source_upper_metrics = stored_unaffected_upper_line_metrics_hu(para, &composed, last);
    let mut measured = 0;
    let mut found = false;
    for (position, _, control_index) in &composed.tac_controls {
        if composed
            .lines
            .iter()
            .rposition(|line| line.char_start <= *position)
            != Some(last)
        {
            continue;
        }
        let Some(Control::Equation(eq)) = para.controls.get(*control_index) else {
            return 0;
        };
        let (Ok(em), Ok(object_height)) =
            (i32::try_from(eq.font_size), i32::try_from(eq.common.height))
        else {
            return 0;
        };
        if !eq.common.treat_as_char
            || eq.common.affect_line_spacing
            || eq.version_info != "Equation Version 60"
            || !font::is_legacy_equation_font(&eq.font_name)
            || em <= 0
            || object_height != seg.line_height
            || (i64::from(object_height) * i64::from(eq.baseline) / 100
                - i64::from(seg.baseline_distance))
            .abs()
                > 25
        {
            return 0;
        }
        if found {
            return 0;
        }
        let em_px = super::hwpunit_to_px(em, super::DEFAULT_DPI);
        let engine = layout::EqLayout::with_font(em_px, &eq.font_name)
            .with_version(&eq.version_info)
            .with_base_pt(f64::from(eq.font_size) / 100.0);
        if !engine.has_source_face_metrics() {
            return 0;
        }
        let ast = parser::EqParser::new(tokenizer::tokenize(&eq.script)).parse();
        let (mut sup, mut sub) = (false, false);
        if !flat_script_shape(&ast, &mut sup, &mut sub) || !(sup || sub) {
            return 0;
        }
        if source_upper_metrics.is_some() && !(sub && !sup) {
            return 0;
        }
        let natural = engine.layout(&ast);
        let natural_hu = super::px_to_hwpunit_round(natural.height, super::DEFAULT_DPI).max(em);
        if sub && !sup {
            let Ok(delta) = i32::try_from(i64::from(natural_hu) - i64::from(seg.line_height))
            else {
                return 0;
            };
            measured = delta;
            found = true;
            continue;
        }
        let flow_hu = super::px_to_hwpunit_round(
            line_flow_height(natural.height, natural.baseline, em_px, false),
            super::DEFAULT_DPI,
        )
        .max(em);
        let delta = i64::from(natural_hu) - i64::from(seg.line_height)
            + (i64::from(natural_hu) - i64::from(flow_hu)).max(0);
        let Ok(delta) = i32::try_from(delta) else {
            return 0;
        };
        measured = delta;
        found = true;
    }
    if found {
        measured
    } else {
        0
    }
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
        .with_base_pt(font_size as f64 / 100.0)
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
    generated_fraction_flow_height_with_clearance_px(
        script,
        font_size,
        dpi,
        font_name,
        version_info,
        layout::FRAC_LINE_PAD,
        false,
    )
}

/// drawText uses the fraction's live occupied height. The shape's body line
/// includes 0.14em less than EqLayout's trailing paint clearance; ordinary
/// paragraphs keep the existing 0.20em flow rule above.
pub(crate) fn generated_draw_text_fraction_flow_height_px(
    script: &str,
    font_size: u32,
    dpi: f64,
    font_name: &str,
    version_info: &str,
) -> Option<f64> {
    generated_fraction_flow_height_with_clearance_px(
        script,
        font_size,
        dpi,
        font_name,
        version_info,
        0.14,
        true,
    )
}

/// Occupied vector metrics for a drawText line. The painted equation keeps its
/// normal upper clearance; the line box follows Hancom's shorter vector occupancy.
pub(crate) fn generated_draw_text_vector_flow_metrics_px(
    script: &str,
    font_size: u32,
    dpi: f64,
    font_name: &str,
    version_info: &str,
) -> Option<IntrinsicMetrics> {
    let em = super::hwpunit_to_px(font_size.max(1) as i32, dpi);
    let ast = parser::EqParser::new(tokenizer::tokenize(script)).parse();
    let layout = layout::EqLayout::with_font(em, font_name)
        .with_version(version_info)
        .with_base_pt(font_size as f64 / 100.0);
    let painted = layout.layout(&ast);
    let occupied = layout.for_draw_text_vector_occupancy().layout(&ast);
    (occupied.height + 0.01 < painted.height).then_some(IntrinsicMetrics {
        width: occupied.width,
        height: occupied.height,
        baseline: occupied.baseline,
    })
}

fn generated_fraction_flow_height_with_clearance_px(
    script: &str,
    font_size: u32,
    dpi: f64,
    font_name: &str,
    version_info: &str,
    clearance_em: f64,
    draw_text_vector_occupancy: bool,
) -> Option<f64> {
    let em = super::hwpunit_to_px(font_size.max(1) as i32, dpi);
    let ast = parser::EqParser::new(tokenizer::tokenize(script)).parse();
    let layout = layout::EqLayout::with_font(em, font_name)
        .with_version(version_info)
        .with_base_pt(font_size as f64 / 100.0);
    let layout = if draw_text_vector_occupancy {
        layout.for_draw_text_vector_occupancy()
    } else {
        layout
    };
    let box_ = layout.layout(&ast);
    fraction_occupied_bottom(&box_, em * clearance_em)
}

/// 저장 개체 폭 안에 배치한 수식의 실제 paint 폭(HWPUNIT).
///
/// painter는 `layout_in_control_width`로 원자 간격을 줄여 저장 폭에 맞춘다. 최소 간격으로도
/// 넘칠 때만 자연 폭이 저장 폭보다 커지며, 줄 advance는 그 초과분만 더해야 한다.
pub fn fitted_width_hwp(eq: &crate::model::control::Equation) -> u32 {
    let font_size_px = super::hwpunit_to_px(eq.font_size.max(1) as i32, super::DEFAULT_DPI);
    let ast = parser::EqParser::new(tokenizer::tokenize(&eq.script)).parse();
    let stored = super::hwpunit_to_px(content_width_hwp(eq), super::DEFAULT_DPI);
    let layout = layout::EqLayout::with_font(font_size_px, &eq.font_name)
        .with_version(&eq.version_info)
        .with_base_pt(eq.font_size as f64 / 100.0)
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
    fn flat_subscript_uses_live_source_face_without_mutating_saved_endnote_lines() {
        use crate::model::{
            control::{Control, Equation},
            paragraph::{LineSeg, Paragraph},
        };
        const CHILD: &str = "RHWP_FLAT_SUBSCRIPT_SOURCE_CHILD";
        if std::env::var_os(CHILD).is_none() {
            // Font availability is process-global; isolate this source-face
            // fixture so unrelated layout tests retain their own font state.
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .arg("flat_subscript_uses_live_source_face_without_mutating_saved_endnote_lines")
                .arg("--nocapture")
                .env(CHILD, "1")
                .output()
                .expect("run isolated source-face test");
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/fonts/HYhwpEQSourceFixture.ttf");
        crate::renderer::font_paths::register_font_face_availability(&[fixture]);
        let source_engine =
            layout::EqLayout::with_font(12.0, "HYhwpEQ").with_version("Equation Version 60");
        assert!(source_engine.has_source_face_metrics());
        let mut spacer = Equation::default();
        spacer.font_name = "HYhwpEQ".into();
        spacer.common.width = 450;
        spacer.common.margin.left = 56;
        spacer.common.margin.right = 56;
        assert_eq!(natural_width_hwp(&spacer), None);
        assert_eq!(content_width_hwp(&spacer), 450);
        assert_eq!(occupied_width_hwp(&spacer), 562);

        let mut eq = Equation::default();
        eq.script = "a_2 = 4b_2".into();
        eq.font_name = "HYhwpEQ".into();
        eq.font_size = 900;
        eq.baseline = 79;
        eq.common.height = 1163;
        eq.common.treat_as_char = true;
        let mut para = Paragraph {
            text: "note".into(),
            char_offsets: vec![0, 1, 2, 3],
            char_count: 5,
            controls: vec![Control::Equation(Box::new(eq))],
            line_segs: vec![LineSeg {
                vertical_pos: 2822,
                line_height: 1163,
                text_height: 1163,
                baseline_distance: 919,
                line_spacing: 452,
                ..Default::default()
            }],
            ..Default::default()
        };
        let saved = (
            para.line_segs[0].vertical_pos,
            para.line_segs[0].line_height,
            para.line_segs[0].text_height,
            para.line_segs[0].baseline_distance,
            para.line_segs[0].line_spacing,
        );
        let composed = crate::renderer::composer::compose_paragraph(&para);
        assert_eq!(composed.tac_controls.len(), 1);
        let (height, baseline) =
            stored_unaffected_upper_line_metrics_hu(&para, &composed, 0).expect("flat subscript");
        assert_eq!(height, 1163);
        assert!(baseline > 0 && baseline < 919);
        assert_ne!(endnote_trailing_flat_script_flow_delta_hu(&para), 0);
        assert_eq!(
            (
                para.line_segs[0].vertical_pos,
                para.line_segs[0].line_height,
                para.line_segs[0].text_height,
                para.line_segs[0].baseline_distance,
                para.line_segs[0].line_spacing,
            ),
            saved
        );

        if let Control::Equation(eq) = &mut para.controls[0] {
            eq.common.affect_line_spacing = true;
        }
        assert_eq!(endnote_trailing_flat_script_flow_delta_hu(&para), 0);
        if let Control::Equation(eq) = &mut para.controls[0] {
            eq.common.affect_line_spacing = false;
            eq.font_name = "UnloadedEquationFace".into();
        }
        assert_eq!(endnote_trailing_flat_script_flow_delta_hu(&para), 0);
    }

    #[test]
    fn endnote_flow_requires_continuous_saved_positions_without_overflow() {
        use crate::model::paragraph::{LineSeg, Paragraph};
        let mut previous = Paragraph {
            line_segs: vec![LineSeg {
                vertical_pos: 2822,
                line_height: 1163,
                line_spacing: 452,
                ..Default::default()
            }],
            ..Default::default()
        };
        let mut current = Paragraph {
            line_segs: vec![LineSeg {
                vertical_pos: 4437,
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(saved_endnote_vpos_continuous(&previous, &current));
        current.line_segs[0].vertical_pos += 1;
        assert!(!saved_endnote_vpos_continuous(&previous, &current));
        previous.line_segs[0].vertical_pos = i32::MAX;
        assert!(!saved_endnote_vpos_continuous(&previous, &current));
    }

    #[test]
    fn unaffected_endnote_equations_advance_by_text_em_only_for_short_objects() {
        use crate::model::{
            control::Control,
            paragraph::{LineSeg, Paragraph},
        };
        use crate::renderer::composer::{ComposedLine, ComposedParagraph};

        let mut short = crate::model::control::Equation::default();
        short.font_size = 900;
        short.common.height = 900;
        short.common.treat_as_char = true;
        let mut raised = short.clone();
        raised.common.height = 1125;
        let mut para = Paragraph {
            controls: vec![
                Control::Equation(Box::new(short)),
                Control::Equation(Box::new(raised)),
            ],
            line_segs: vec![
                LineSeg {
                    vertical_pos: 0,
                    line_height: 2070,
                    text_height: 1125,
                    line_spacing: 452,
                    ..Default::default()
                },
                LineSeg {
                    vertical_pos: 1577,
                    line_height: 2070,
                    text_height: 2070,
                    line_spacing: 452,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let line = |char_start| ComposedLine {
            runs: vec![],
            line_height: 2070,
            baseline_distance: 0,
            segment_width: 0,
            column_start: 0,
            line_spacing: 452,
            has_line_break: false,
            char_start,
        };
        let composed = ComposedParagraph {
            lines: vec![line(0), line(2)],
            para_style_id: 0,
            inline_controls: vec![],
            numbering_text: None,
            numbering_head: None,
            tac_controls: vec![(0, 0, 0), (1, 0, 1)],
            footnote_positions: vec![],
            tab_extended: vec![],
        };
        assert_eq!(
            endnote_unaffected_equation_textheight_compaction_hu(&para, &composed, 0),
            225
        );
        if let Control::Equation(eq) = &mut para.controls[1] {
            eq.common.affect_line_spacing = true;
        }
        assert_eq!(
            endnote_unaffected_equation_textheight_compaction_hu(&para, &composed, 0),
            0
        );
        if let Control::Equation(eq) = &mut para.controls[1] {
            eq.common.affect_line_spacing = false;
            eq.common.height = 2310;
        }
        para.line_segs[0].text_height = 2310;
        para.line_segs[1].vertical_pos = 2762;
        assert_eq!(
            endnote_unaffected_equation_textheight_compaction_hu(&para, &composed, 0),
            0
        );
    }

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
    fn draw_text_fraction_retains_vector_occupancy_in_its_numerator() {
        let script = "{vec {AB}} over {2}";
        let em = super::super::hwpunit_to_px(900, super::super::DEFAULT_DPI);
        let ast = parser::EqParser::new(tokenizer::tokenize(script)).parse();
        let layout = layout::EqLayout::with_font(em, "HYhwpEQ")
            .with_version("Equation Version 60")
            .with_base_pt(9.0);
        let painted = layout.layout(&ast);
        let occupied = layout.for_draw_text_vector_occupancy().layout(&ast);
        let painted_flow = fraction_occupied_bottom(&painted, em * 0.14).unwrap();
        let occupied_flow = fraction_occupied_bottom(&occupied, em * 0.14).unwrap();
        assert!(occupied_flow < painted_flow);
        assert_eq!(
            generated_draw_text_fraction_flow_height_px(
                script,
                900,
                super::super::DEFAULT_DPI,
                "HYhwpEQ",
                "Equation Version 60"
            ),
            Some(occupied_flow)
        );
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

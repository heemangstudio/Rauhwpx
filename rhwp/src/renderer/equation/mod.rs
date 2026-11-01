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

static MEASUREMENT_GENERATION: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

thread_local! {
    static OBSERVED_MEASUREMENT_GENERATION: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    // 서체 미해소(None)는 저장하지 않는다 — 원본 서체는 렌더 진입 때 등록될 수 있다.
    static NATURAL_WIDTH_CACHE: std::cell::RefCell<
        std::collections::HashMap<(String, u32, String, String), i32>
    > = std::cell::RefCell::new(std::collections::HashMap::new());
}

/// 원본 서체 등록/명시적 새로고침 이후의 측정 세대. 준비한 조판의 설치 전에도 확인한다.
pub(crate) fn measurement_generation() -> usize {
    MEASUREMENT_GENERATION.load(std::sync::atomic::Ordering::Acquire)
}

/// 서체 조달 캐시를 먼저 비우고 모든 측정 스레드에 새 세대를 공개한다.
/// 동일 경로의 파일 교체는 이 명시적 경계 뒤 첫 측정에서 다시 읽는다.
pub(crate) fn invalidate_measurement_caches() {
    #[cfg(not(target_arch = "wasm32"))]
    super::font_paths::invalidate_equation_face_metrics();
    MEASUREMENT_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Release);
}

pub(crate) fn sync_measurement_caches() -> usize {
    let generation = measurement_generation();
    OBSERVED_MEASUREMENT_GENERATION.with(|observed| {
        if observed.replace(generation) != generation {
            // 캐시를 빌리는 측정에 들어가기 전에 동기화한다. 재진입도 같은 세대를 본다.
            NATURAL_WIDTH_CACHE.with(|cache| cache.borrow_mut().clear());
            measure::clear_measurement_caches();
        }
    });
    generation
}

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
    // An empty EQEDIT can be an authored inline spacer. Hancom keeps its saved
    // width; measuring an empty AST would collapse it to zero.
    if eq.script.is_empty() {
        return None;
    }
    if !font::is_legacy_equation_font(&eq.font_name) || eq.version_info.is_empty() {
        return None;
    }
    let generation = sync_measurement_caches();
    let key = (
        eq.script.clone(),
        eq.font_size,
        eq.font_name.clone(),
        eq.version_info.clone(),
    );
    if let Some(hit) = NATURAL_WIDTH_CACHE.with(|cache| cache.borrow().get(&key).copied()) {
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
    if measurement_generation() != generation {
        return None;
    }
    NATURAL_WIDTH_CACHE.with(|cache| {
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



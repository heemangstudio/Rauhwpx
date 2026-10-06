//! 덧말의 본문 전진과 주석 장평을 공유하는 인라인 조판 정책.
use super::composer::{split_runs_by_lang, ComposedTextRun};
use super::layout::{estimate_text_width, resolved_to_text_style, CellContext};
use super::render_tree::*;
use super::style_resolver::ResolvedStyleSet;
use super::{hwpunit_to_px, px_to_hwpunit_round, TextStyle};
use crate::model::control::Control;
use crate::model::paragraph::Paragraph;

pub(crate) struct RubyLayout {
    pub main_width: f64,
    pub height_hu: i32,
    pub baseline_hu: i32,
    style_id: u32,
    main: Vec<(String, TextStyle)>,
    sub: Vec<(String, TextStyle)>,
    sub_x: f64,
    sub_baseline_delta: f64,
    sub_descent_shifts: Vec<f64>,
}

fn styled_runs(text: &str, id: u32, styles: &ResolvedStyleSet) -> Vec<(String, TextStyle)> {
    split_runs_by_lang(vec![ComposedTextRun {
        text: text.into(),
        char_style_id: id,
        ..Default::default()
    }])
    .into_iter()
    .map(|r| (r.text, resolved_to_text_style(styles, id, r.lang_index)))
    .collect()
}
fn width(runs: &[(String, TextStyle)]) -> f64 {
    runs.iter()
        .map(|(text, style)| estimate_text_width(text, style))
        .sum()
}

fn consumes_extended_slot(control: &Control) -> bool {
    !matches!(control, Control::Bookmark(_) | Control::HiddenComment(_))
}
fn extended_positions(para: &Paragraph) -> Vec<usize> {
    if para.controls.iter().all(consumes_extended_slot) {
        return para.control_text_positions();
    }
    let mut projected = para.clone();
    projected.controls.retain(consumes_extended_slot);
    let positions = projected.control_text_positions();
    let mut slot = 0;
    para.controls
        .iter()
        .map(|control| {
            if consumes_extended_slot(control) {
                let position = positions[slot];
                slot += 1;
                position
            } else {
                0
            }
        })
        .collect()
}
/// 원본 제어 인덱스는 유지하며, 덧말만 메타데이터를 제외한 갭 축으로 투영한다.
/// 빈 문단의 기존 인라인 순번 패킹은 바꾸지 않는다.
pub(crate) fn project_control_positions(para: &Paragraph, positions: &mut [usize]) {
    if para.text.is_empty() || !para.controls.iter().any(|c| !consumes_extended_slot(c)) {
        return;
    }
    let extended = extended_positions(para);
    for (ci, control) in para.controls.iter().enumerate() {
        if matches!(control, Control::Ruby(r) if r.option == 0) {
            positions[ci] = extended[ci];
        }
    }
}
/// 같은 텍스트 위치의 실제 확장 제어만 원래 8단위 앵커로 돌린다.
fn anchor_style(para: &Paragraph, ci: usize) -> Option<u32> {
    let raw = if para.text.is_empty() {
        para.controls
            .iter()
            .take(ci)
            .filter(|c| consumes_extended_slot(c))
            .count() as u32
            * 8
    } else {
        let positions = extended_positions(para);
        let pos = *positions.get(ci)?;
        let after = para.char_offsets.get(pos).copied().unwrap_or_else(|| {
            para.char_offsets.last().copied().unwrap_or(0)
                + para
                    .text
                    .chars()
                    .last()
                    .map(|c| c.len_utf16() as u32)
                    .unwrap_or(0)
                + positions
                    .iter()
                    .enumerate()
                    .filter(|(i, p)| **p == pos && consumes_extended_slot(&para.controls[*i]))
                    .count() as u32
                    * 8
        });
        let remaining = positions
            .iter()
            .enumerate()
            .filter(|(i, p)| *i >= ci && **p == pos && consumes_extended_slot(&para.controls[*i]))
            .count();
        after.saturating_sub(remaining as u32 * 8)
    };
    para.char_shapes
        .iter()
        .rev()
        .find(|r| r.start_pos <= raw)
        .map(|r| r.char_shape_id)
}

#[derive(Clone, Copy)]
struct PublicMetrics {
    ascent: f64,
    total: f64,
}
impl PublicMetrics {
    fn from_ratios(ascent: f64, height: f64, gap: f64) -> Option<Self> {
        let total = height - gap;
        (ascent.is_finite()
            && total.is_finite()
            && gap.is_finite()
            && ascent > 0.0
            && total >= ascent)
            .then_some(Self { ascent, total })
    }
    fn descent(self) -> f64 {
        self.total - self.ascent
    }
}
fn public_metrics(face: &str, bold: bool, italic: bool) -> Option<PublicMetrics> {
    #[cfg(not(target_arch = "wasm32"))]
    let native = {
        let a = super::font_paths::custom_face_ascender_ratio(face, bold, italic);
        let h = super::font_paths::custom_face_line_height_ratio(face, bold, italic);
        let g = super::font_paths::custom_face_line_gap_ratio(face, bold, italic);
        match (a, h, g) {
            (Some(a), Some(h), Some(g)) => PublicMetrics::from_ratios(a, h, g),
            _ => None,
        }
    };
    #[cfg(target_arch = "wasm32")]
    let native = None;
    native.or_else(|| {
        PublicMetrics::from_ratios(
            super::runtime_font_metrics::ascender_ratio(face, bold, italic)?,
            super::runtime_font_metrics::line_height_ratio(face, bold, italic)?,
            super::runtime_font_metrics::line_gap_ratio(face, bold, italic)?,
        )
    })
}
fn main_metric_hu(height: i32, metrics: &[Option<PublicMetrics>]) -> i32 {
    metrics
        .iter()
        .map(|m| (f64::from(height) * m.map(|m| m.ascent / m.total).unwrap_or(0.85)).round() as i32)
        .max()
        .unwrap_or(0)
}
/// 100HU/pt를 현재 Mac 출력의 600dpi 격자로 변환한다. 없는 메트릭은 기존 정책을 쓴다.
fn mac_baseline_offsets(
    main_hu: i32,
    sub_hu: i32,
    main: &[Option<PublicMetrics>],
    sub: &[Option<PublicMetrics>],
    dpi: f64,
) -> Option<(f64, Vec<f64>)> {
    if main_hu <= 0
        || sub_hu <= 0
        || !dpi.is_finite()
        || dpi <= 0.0
        || main.is_empty()
        || main.iter().any(Option::is_none)
        || sub.iter().any(Option::is_none)
    {
        return None;
    }
    let gap = f64::from(main_metric_hu(main_hu, main) / 12) * dpi / 600.0;
    let em = f64::from(sub_hu / 12);
    let shifts = sub
        .iter()
        .map(|m| (em * m.unwrap().descent()).round() * dpi / 600.0)
        .collect();
    Some((gap, shifts))
}

pub(crate) fn prepare(
    para: &Paragraph,
    ci: usize,
    styles: &ResolvedStyleSet,
    dpi: f64,
) -> Option<RubyLayout> {
    let Control::Ruby(ruby) = para.controls.get(ci)? else {
        return None;
    };
    // option의 네이티브 스타일 변환은 미확인이다. 원본 IR을 유지한다.
    if ruby.option != 0 || ruby.main_text.is_empty() {
        return None;
    }
    let id = anchor_style(para, ci)?;
    let original = styles.char_styles.get(id as usize)?;
    let main = styled_runs(&ruby.main_text, id, styles);
    let main_width = width(&main);
    let r = if ruby.sz_ratio == 0 {
        50
    } else {
        i32::from(ruby.sz_ratio)
    };
    let main_hu = px_to_hwpunit_round(original.font_size, dpi);
    let sub_hu = ((i64::from(main_hu) * i64::from(r) + 50) / 100) as i32;
    let sub_size = hwpunit_to_px(sub_hu, dpi);
    let mut sub = styled_runs(&ruby.ruby_text, id, styles);
    for (_, ts) in &mut sub {
        ts.font_size = sub_size;
        ts.ratio = 1.0;
        ts.letter_spacing = 0.0;
    }
    let mut ratio = 100;
    while main_width < width(&sub) && ratio > 50 {
        ratio -= 1;
        for (_, ts) in &mut sub {
            ts.ratio = f64::from(ratio) / 100.0;
        }
    }
    let mut spacing = 0;
    while main_width < width(&sub) && spacing > -50 {
        spacing -= 1;
        for (_, ts) in &mut sub {
            ts.letter_spacing = sub_size * f64::from(spacing) / 100.0;
        }
    }
    let slack = (main_width - width(&sub)).max(0.0);
    let sub_x = match ruby.align {
        1 => slack,
        2 => slack / 2.0,
        _ => 0.0,
    };
    // native4c993c: 본문 7개 글꼴의 ascent/(ascent+descent) 최댓값.
    let metrics: Vec<_> = (0..7)
        .map(|lang| {
            public_metrics(
                original.font_family_for_lang(lang),
                original.bold,
                original.italic,
            )
        })
        .collect();
    let metric_hu = main_metric_hu(main_hu, &metrics);
    let metric = hwpunit_to_px(metric_hu, dpi);
    let align = styles
        .para_styles
        .get(para.para_shape_id as usize)
        .map(|p| p.vertical_align)
        .unwrap_or(0);
    let adjustment = match align {
        1 => 0.0,
        2 => original.font_size / 2.0,
        3 => original.font_size,
        _ => metric,
    };
    let mut sub_baseline_delta = -adjustment
        + if ruby.pos_type == 1 {
            original.font_size + sub_size
        } else {
            0.0
        };
    let mut sub_descent_shifts = vec![0.0; sub.len()];
    // 정상 GUI의 3개 글꼴/크기 대조로 확인한 현재 Mac 출력 격자다.
    // Quartz 내부 제공자 복원이나 다른 문단 수직 모드의 동등성을 뜻하지 않는다.
    if align == 0
        && ruby.pos_type == 0
        && original.font_metrics_policy == crate::model::provenance::FontMetricsPolicy::HcrDeclared
    {
        let sub_metrics: Vec<_> = sub
            .iter()
            .map(|(_, ts)| public_metrics(&ts.font_family, ts.bold, ts.italic))
            .collect();
        if let Some((gap, shifts)) =
            mac_baseline_offsets(main_hu, sub_hu, &metrics, &sub_metrics, dpi)
        {
            sub_baseline_delta = -gap;
            sub_descent_shifts = shifts;
        }
    }
    let quarter = main_hu / 4;
    let base = if ruby.pos_type == 0 {
        quarter
    } else {
        quarter * 91 / 100
    };
    let height_hu = (base + r * quarter / 100) * 4;
    let baseline_ratio = (85 + if ruby.pos_type == 0 { r } else { 0 }) * 100 / (100 + r);
    let baseline_hu = (height_hu * baseline_ratio + 50) / 100;
    Some(RubyLayout {
        main_width,
        height_hu,
        baseline_hu,
        style_id: id,
        main,
        sub,
        sub_x,
        sub_baseline_delta,
        sub_descent_shifts,
    })
}

pub(crate) fn append_nodes(
    layout: RubyLayout,
    tree: &mut PageRenderTree,
    nodes: &mut Vec<RenderNode>,
    x: f64,
    baseline_y: f64,
    section: usize,
    para: usize,
    cell: &Option<CellContext>,
) {
    let groups = [
        (layout.main, x, baseline_y, true),
        (
            layout.sub,
            x + layout.sub_x,
            baseline_y + layout.sub_baseline_delta,
            false,
        ),
    ];
    for (runs, mut pen, baseline, main) in groups {
        for (index, (text, style)) in runs.into_iter().enumerate() {
            let baseline = baseline
                - if main {
                    0.0
                } else {
                    layout.sub_descent_shifts[index]
                };
            let w = estimate_text_width(&text, &style);
            let height = style.font_size;
            let node = TextRunNode {
                text,
                style,
                char_shape_id: main.then_some(layout.style_id),
                para_shape_id: None,
                section_index: Some(section),
                para_index: Some(para),
                char_start: None,
                cell_context: cell.clone(),
                is_para_end: false,
                is_line_break_end: false,
                rotation: 0.0,
                is_vertical: false,
                char_overlap: None,
                border_fill_id: 0,
                baseline: height,
                field_marker: FieldMarkerType::None,
                display_text: None,
            };
            nodes.push(RenderNode::new(
                tree.next_id(),
                RenderNodeType::TextRun(node),
                BoundingBox::new(pen, baseline - height, w, height),
            ));
            pen += w;
        }
    }
}

#[cfg(test)]
mod metric_tests {
    use super::*;
    fn metric(a: f64, d: f64, gap: f64) -> Option<PublicMetrics> {
        PublicMetrics::from_ratios(a, a + d + gap, gap)
    }
    #[test]
    fn ruby_metric_slots_and_script_descent_are_independent() {
        let a = metric(0.8, 0.2, 0.3);
        let b = metric(0.9, 0.1, 0.7);
        let (gap, shifts) = mac_baseline_offsets(1200, 600, &[a, b], &[a, b], 96.0).unwrap();
        assert_eq!(gap, 14.4);
        assert!((shifts[0] - 1.6).abs() < 1e-9);
        assert!((shifts[1] - 0.8).abs() < 1e-9);
        let (_, smaller) = mac_baseline_offsets(1200, 300, &[a, b], &[a, b], 96.0).unwrap();
        assert!(smaller[0] < shifts[0]);
    }
    #[test]
    fn ruby_invalid_or_missing_metrics_preserve_fallback() {
        for (a, h, g) in [
            (f64::NAN, 1.0, 0.0),
            (0.8, f64::INFINITY, 0.0),
            (0.0, 1.0, 0.0),
            (0.8, 0.7, 0.0),
            (0.8, 1.0, f64::NAN),
        ] {
            assert!(PublicMetrics::from_ratios(a, h, g).is_none());
        }
        let good = metric(0.8, 0.2, 0.0);
        assert!(mac_baseline_offsets(1200, 600, &[good, None], &[good], 96.0).is_none());
        assert!(mac_baseline_offsets(1200, 600, &[good], &[None], 96.0).is_none());
        assert!(mac_baseline_offsets(1200, 600, &[good], &[good], f64::NAN).is_none());
        assert_eq!(main_metric_hu(1200, &[good, None]), 1020);
    }
}

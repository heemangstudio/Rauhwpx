use crate::model::control::Control;
use crate::model::paragraph::Paragraph;
use crate::renderer::composer::ComposedParagraph;

#[derive(Debug, Clone)]
pub(crate) struct EquationTacLineFlow {
    tac_rows: Vec<(usize, usize)>,
    pub extra_rows: usize,
    visual_row_base: usize,
}

impl EquationTacLineFlow {
    pub(crate) fn row_for_tac(&self, tac_index: usize) -> Option<usize> {
        self.tac_rows
            .iter()
            .find_map(|(idx, row)| (*idx == tac_index).then_some(*row))
    }

    pub(crate) fn visual_line_idx_for_row(&self, row: usize) -> usize {
        self.visual_row_base + row
    }

    /// A wrapped equation-only line may contain controls of different heights.
    /// The composed line stores the tallest control's height, but Hancom advances
    /// each physical row by the height of the controls actually placed on it.
    fn physical_row_heights_px(
        &self,
        para: &Paragraph,
        tac_offsets_px: &[(usize, f64, usize)],
        line_height: f64,
        dpi: f64,
    ) -> Option<Vec<f64>> {
        if self.extra_rows == 0 {
            return None;
        }
        let mut heights = vec![0.0f64; self.extra_rows + 1];
        for &(tac_index, row) in &self.tac_rows {
            let &(_, _, control_index) = tac_offsets_px.get(tac_index)?;
            let Some(Control::Equation(eq)) = para.controls.get(control_index) else {
                return None;
            };
            let occupied_hu = eq.common.height as i32
                + eq.common.margin.top as i32
                + eq.common.margin.bottom as i32;
            heights[row] = heights[row].max(crate::renderer::hwpunit_to_px(occupied_hu, dpi));
        }
        let tallest = heights.iter().copied().fold(0.0f64, f64::max);
        // A saved line can intentionally suppress the equation's ink overhang.
        // Its explicit height remains authoritative in that case.
        if heights.iter().any(|h| *h <= 0.0) || tallest > line_height + 0.01 {
            return None;
        }
        let shared_clearance = (line_height - tallest).max(0.0);
        for height in &mut heights {
            *height += shared_clearance;
        }
        Some(heights)
    }

    pub(crate) fn row_offset_px(
        &self,
        row: usize,
        para: &Paragraph,
        tac_offsets_px: &[(usize, f64, usize)],
        line_height: f64,
        line_spacing: f64,
        dpi: f64,
    ) -> f64 {
        let row = row.min(self.extra_rows);
        let heights = self.physical_row_heights_px(para, tac_offsets_px, line_height, dpi);
        (0..row)
            .map(|index| {
                heights
                    .as_ref()
                    .map(|heights| heights[index])
                    .unwrap_or(line_height)
                    + line_spacing
            })
            .sum()
    }

    pub(crate) fn flow_height_px(
        &self,
        para: &Paragraph,
        tac_offsets_px: &[(usize, f64, usize)],
        line_height: f64,
        line_spacing: f64,
        dpi: f64,
    ) -> f64 {
        let heights = self.physical_row_heights_px(para, tac_offsets_px, line_height, dpi);
        heights
            .as_ref()
            .map(|heights| heights.iter().sum::<f64>())
            .unwrap_or(line_height * (self.extra_rows + 1) as f64)
            + line_spacing * self.extra_rows as f64
    }
}

pub(crate) fn compute_equation_only_tac_line_flow(
    para: Option<&Paragraph>,
    composed: &ComposedParagraph,
    tac_offsets_px: &[(usize, f64, usize)],
    line_idx: usize,
    available_width: f64,
    continuation_available_width: f64,
) -> Option<EquationTacLineFlow> {
    let para = para?;
    if tac_offsets_px.is_empty()
        || composed.lines.is_empty()
        || line_idx >= composed.lines.len()
        || available_width.is_nan()
        || available_width <= 0.0
    {
        return None;
    }
    if !composed.lines.iter().all(|line| line.runs.is_empty()) {
        return None;
    }
    if !tac_offsets_px.iter().all(|(_, _, control_index)| {
        matches!(
            para.controls.get(*control_index),
            Some(Control::Equation(_))
        )
    }) {
        return None;
    }

    let wrap_width = if available_width.is_finite() {
        available_width
    } else {
        f64::INFINITY
    };
    let continuation_wrap_width =
        if continuation_available_width.is_finite() && continuation_available_width > 0.0 {
            continuation_available_width
        } else {
            wrap_width
        };

    let assignments = equation_only_tac_line_assignment(para, composed, tac_offsets_px);
    let mut assigned_lines: Vec<usize> = assignments
        .iter()
        .copied()
        .filter(|assigned_line| *assigned_line <= line_idx)
        .collect();
    assigned_lines.sort_unstable();
    assigned_lines.dedup();

    let mut visual_row_base = 0usize;
    for assigned_line in assigned_lines
        .iter()
        .copied()
        .filter(|assigned_line| *assigned_line < line_idx)
    {
        let tacs = tacs_for_assigned_line(&assignments, tac_offsets_px, assigned_line);
        let first_width = if visual_row_base == 0 {
            wrap_width
        } else {
            continuation_wrap_width
        };
        let (_, visual_rows) = pack_equation_tac_rows(tacs, first_width, continuation_wrap_width);
        visual_row_base += visual_rows;
    }

    let current_line_tacs = tacs_for_assigned_line(&assignments, tac_offsets_px, line_idx);
    let first_width = if visual_row_base == 0 {
        wrap_width
    } else {
        continuation_wrap_width
    };
    let (tac_rows, visual_rows) =
        pack_equation_tac_rows(current_line_tacs, first_width, continuation_wrap_width);

    Some(EquationTacLineFlow {
        tac_rows,
        extra_rows: visual_rows.saturating_sub(1),
        visual_row_base,
    })
}

fn tacs_for_assigned_line(
    assignments: &[usize],
    tac_offsets_px: &[(usize, f64, usize)],
    line_idx: usize,
) -> Vec<(usize, f64)> {
    assignments
        .iter()
        .enumerate()
        .filter_map(|(tac_index, assigned_line)| {
            (*assigned_line == line_idx)
                .then_some((tac_index, tac_offsets_px[tac_index].1.max(0.0)))
        })
        .collect()
}

fn pack_equation_tac_rows(
    tacs: Vec<(usize, f64)>,
    first_wrap_width: f64,
    continuation_wrap_width: f64,
) -> (Vec<(usize, usize)>, usize) {
    if tacs.is_empty() {
        return (Vec::new(), 0);
    }

    let mut row = 0usize;
    let mut row_width = 0.0f64;
    let mut current_wrap_width = first_wrap_width;
    let mut tac_rows = Vec::with_capacity(tacs.len());
    for (tac_index, tac_width) in tacs {
        if row_width > 0.0 && row_width + tac_width > current_wrap_width + 0.5 {
            row += 1;
            row_width = 0.0;
            current_wrap_width = continuation_wrap_width;
        }
        tac_rows.push((tac_index, row));
        row_width += tac_width;
    }

    (tac_rows, row + 1)
}

pub(crate) fn paragraph_line_indent(indent: f64, visual_line_idx: usize) -> f64 {
    paragraph_line_indent_with_scale(indent, visual_line_idx, 1.0)
}

pub(crate) fn paragraph_line_indent_with_scale(
    indent: f64,
    visual_line_idx: usize,
    indent_scale: f64,
) -> f64 {
    let scaled_indent = indent * indent_scale;
    if indent > 0.0 {
        if visual_line_idx == 0 {
            scaled_indent
        } else {
            0.0
        }
    } else if indent < 0.0 {
        if visual_line_idx == 0 {
            0.0
        } else {
            scaled_indent.abs()
        }
    } else {
        0.0
    }
}

pub(crate) fn paragraph_effective_margin_left(
    margin_left: f64,
    indent: f64,
    visual_line_idx: usize,
) -> f64 {
    margin_left + paragraph_line_indent(indent, visual_line_idx)
}

pub(crate) fn paragraph_effective_margin_left_with_indent_scale(
    margin_left: f64,
    indent: f64,
    visual_line_idx: usize,
    indent_scale: f64,
) -> f64 {
    margin_left + paragraph_line_indent_with_scale(indent, visual_line_idx, indent_scale)
}

/// TAC-only 수식 행도 일반 TextLine 과 같은 문단 들여쓰기를 쓴다.
/// 기존 HWP3 셀/비수식 TAC 의 절반 배율만 보존한다.
pub(crate) fn tac_indent_scale(hwp3_layout: bool, in_cell: bool, equation_only: bool) -> f64 {
    if hwp3_layout && (in_cell || !equation_only) {
        0.5
    } else {
        1.0
    }
}

#[cfg(test)]
mod indent_tests {
    use super::{paragraph_effective_margin_left_with_indent_scale, tac_indent_scale};

    #[test]
    fn equation_tac_continuation_uses_one_authored_indent() {
        let margin = 20.0;
        let hanging = -6.37;
        for (hwp3, in_cell, equation_only, expected) in [
            (false, false, true, 26.37),
            (false, true, true, 26.37),
            (true, false, true, 26.37),
            (true, true, true, 23.185),
            (true, false, false, 23.185),
        ] {
            let scale = tac_indent_scale(hwp3, in_cell, equation_only);
            let x = paragraph_effective_margin_left_with_indent_scale(margin, hanging, 1, scale);
            assert!(
                (x - expected).abs() < 0.0001,
                "hwp3={hwp3} in_cell={in_cell} equation_only={equation_only}: {x}"
            );
        }
    }
}

#[cfg(test)]
mod row_height_tests {
    use super::EquationTacLineFlow;
    use crate::model::control::{Control, Equation};
    use crate::model::paragraph::Paragraph;

    fn equation(height: u32) -> Control {
        let mut eq = Equation::default();
        eq.common.height = height;
        Control::Equation(Box::new(eq))
    }

    #[test]
    fn wrapped_equation_rows_use_their_own_control_heights() {
        let mut para = Paragraph {
            controls: vec![equation(2298), equation(2395)],
            ..Default::default()
        };
        let flow = EquationTacLineFlow {
            tac_rows: vec![(0, 0), (1, 1)],
            extra_rows: 1,
            visual_row_base: 0,
        };
        let tacs = [(0, 1.0, 0), (1, 1.0, 1)];
        let dpi = 96.0;
        let tall = crate::renderer::hwpunit_to_px(2395, dpi);
        let short = crate::renderer::hwpunit_to_px(2298, dpi);
        let spacing = 6.0;
        let offset = flow.row_offset_px(1, &para, &tacs, tall, spacing, dpi);
        assert!((offset - short - spacing).abs() < 0.001);
        assert!(
            (flow.flow_height_px(&para, &tacs, tall, spacing, dpi) - short - tall - spacing).abs()
                < 0.001
        );

        para.controls.swap(0, 1);
        let offset = flow.row_offset_px(1, &para, &tacs, tall, spacing, dpi);
        assert!((offset - tall - spacing).abs() < 0.001);
        assert!(
            (flow.flow_height_px(&para, &tacs, tall, spacing, dpi) - short - tall - spacing).abs()
                < 0.001
        );

        para.controls[1] = equation(2395);
        assert!(
            (flow.flow_height_px(&para, &tacs, tall, spacing, dpi) - 2.0 * tall - spacing).abs()
                < 0.001
        );
    }

    #[test]
    fn saved_short_line_and_explicit_single_row_keep_their_height() {
        let para = Paragraph {
            controls: vec![equation(2298), equation(2395)],
            ..Default::default()
        };
        let tacs = [(0, 1.0, 0), (1, 1.0, 1)];
        let mut flow = EquationTacLineFlow {
            tac_rows: vec![(0, 0), (1, 1)],
            extra_rows: 1,
            visual_row_base: 0,
        };
        let line_height = 12.0;
        let spacing = 6.0;
        assert_eq!(
            flow.flow_height_px(&para, &tacs, line_height, spacing, 96.0),
            30.0
        );
        flow.tac_rows = vec![(0, 0)];
        flow.extra_rows = 0;
        assert_eq!(
            flow.flow_height_px(&para, &tacs, line_height, spacing, 96.0),
            line_height
        );
    }
}

fn equation_only_tac_line_assignment(
    para: &Paragraph,
    composed: &ComposedParagraph,
    tac_offsets_px: &[(usize, f64, usize)],
) -> Vec<usize> {
    let n_lines = composed.lines.len();
    if n_lines == 0 {
        return Vec::new();
    }

    let degenerate = n_lines > 1
        && composed
            .lines
            .windows(2)
            .any(|window| window[1].char_start <= window[0].char_start);

    if !degenerate {
        return tac_offsets_px
            .iter()
            .map(|(pos, _, _)| {
                (0..n_lines)
                    .find(|&line_idx| {
                        let line_start = composed.lines[line_idx].char_start;
                        let line_end = composed_line_char_end(composed, line_idx);
                        char_pos_in_line(*pos, line_start, line_end)
                    })
                    .unwrap_or(n_lines - 1)
            })
            .collect();
    }

    let mut assignments = vec![0usize; tac_offsets_px.len()];
    let mut tac_idx = 0usize;
    let mut line_start = 0usize;
    while tac_idx < tac_offsets_px.len() {
        let pos = tac_offsets_px[tac_idx].0;
        let group_start = tac_idx;
        while tac_idx < tac_offsets_px.len() && tac_offsets_px[tac_idx].0 == pos {
            tac_idx += 1;
        }
        let group_end = tac_idx;

        let group_len = group_end - group_start;
        let all_line_targets: Vec<usize> = (line_start..n_lines)
            .filter(|&li| composed.lines[li].char_start == pos)
            .collect();
        let filtered_line_targets: Vec<usize> = all_line_targets
            .iter()
            .copied()
            .filter(|&li| {
                !line_is_leading_empty_equation_tac_guide(para, composed, tac_offsets_px, li)
            })
            .collect();
        let mut line_targets = if group_len > 1 && all_line_targets.len() >= group_len {
            // 같은 char_start에 여러 TAC 수식이 있고 저장 LINE_SEG도 같은 수만큼 있으면
            // 선행 빈 guide 줄도 한컴의 물리 수식 줄로 보존한다.
            all_line_targets
        } else {
            filtered_line_targets
        };

        if line_targets.is_empty() {
            let fallback = (line_start..n_lines)
                .find(|&li| {
                    let line_start_char = composed.lines[li].char_start;
                    let line_end_char = composed_line_char_end(composed, li);
                    char_pos_in_line(pos, line_start_char, line_end_char)
                })
                .unwrap_or_else(|| line_start.min(n_lines - 1));
            line_targets.push(fallback);
        }

        for (group_offset, idx) in (group_start..group_end).enumerate() {
            let target = line_targets
                .get(group_offset)
                .copied()
                .unwrap_or_else(|| *line_targets.last().unwrap());
            assignments[idx] = target;
        }

        line_start = line_targets.last().copied().unwrap_or(line_start) + 1;
    }

    assignments
}

fn composed_line_char_end(composed: &ComposedParagraph, line_idx: usize) -> usize {
    composed
        .lines
        .get(line_idx + 1)
        .map(|line| line.char_start)
        .unwrap_or(usize::MAX)
}

fn char_pos_in_line(pos: usize, line_start: usize, line_end: usize) -> bool {
    if line_end == usize::MAX {
        pos >= line_start
    } else if line_end <= line_start {
        pos == line_start
    } else {
        pos >= line_start && pos < line_end
    }
}

fn line_is_leading_empty_equation_tac_guide(
    para: &Paragraph,
    composed: &ComposedParagraph,
    tac_offsets_px: &[(usize, f64, usize)],
    line_idx: usize,
) -> bool {
    if line_idx + 1 >= composed.lines.len() {
        return false;
    }
    let line = &composed.lines[line_idx];
    let next = &composed.lines[line_idx + 1];
    if line.char_start != next.char_start {
        return false;
    }
    !line_has_strict_tac_control(composed, tac_offsets_px, line_idx)
        && line_has_strict_equation_tac_control(para, composed, tac_offsets_px, line_idx + 1)
}

fn line_has_strict_tac_control(
    composed: &ComposedParagraph,
    tac_offsets_px: &[(usize, f64, usize)],
    line_idx: usize,
) -> bool {
    let line_start = composed.lines[line_idx].char_start;
    let line_end = composed_line_char_end(composed, line_idx);
    tac_offsets_px
        .iter()
        .any(|(pos, _, _)| pos >= &line_start && *pos < line_end)
}

fn line_has_strict_equation_tac_control(
    para: &Paragraph,
    composed: &ComposedParagraph,
    tac_offsets_px: &[(usize, f64, usize)],
    line_idx: usize,
) -> bool {
    let line_start = composed.lines[line_idx].char_start;
    let line_end = composed_line_char_end(composed, line_idx);
    tac_offsets_px.iter().any(|(pos, _, control_index)| {
        pos >= &line_start
            && *pos < line_end
            && matches!(
                para.controls.get(*control_index),
                Some(Control::Equation(_))
            )
    })
}

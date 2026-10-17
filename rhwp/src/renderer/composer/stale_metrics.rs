//! Recognize saved wrapping produced by a previous font-metric policy.
//! This is not a general permission to discard stored line or page breaks.

use super::{reflow_line_segs, LineSeg, Paragraph, ResolvedStyleSet};
use crate::model::control::Control;

pub(crate) fn repair_metric_stale_cell_lines(
    paragraphs: &mut [Paragraph],
    previous_styles: &ResolvedStyleSet,
    current_styles: &ResolvedStyleSet,
    dpi: f64,
) -> bool {
    let mut changed = false;
    for paragraph in paragraphs {
        for control in &mut paragraph.controls {
            let Control::Table(table) = control else {
                continue;
            };
            for cell in &mut table.cells {
                if cell.text_direction != 0 || cell.width >= 0x8000_0000 {
                    continue;
                }
                let pad = cell.effective_padding(&table.padding);
                // 한컴은 셀 안쪽 폭을 4 HWPUNIT(1/1800인치) 격자로 내려 줄 폭으로 쓴다.
                let inner_hu = cell.width as i32 - pad.left as i32 - pad.right as i32;
                let inner_width =
                    crate::renderer::hwpunit_to_px(inner_hu - inner_hu.rem_euclid(4), dpi);
                for para in &mut cell.paragraphs {
                    let style = current_styles.para_styles.get(para.para_shape_id as usize);
                    let width = inner_width - style.map_or(0.0, |s| s.margin_left + s.margin_right);
                    if let Some(lines) = cell_lines_from_previous_font_metrics(
                        para,
                        width,
                        previous_styles,
                        current_styles,
                        dpi,
                    ) {
                        para.line_segs = lines;
                        changed = true;
                    }
                }
                changed |= repair_metric_stale_cell_lines(
                    &mut cell.paragraphs,
                    previous_styles,
                    current_styles,
                    dpi,
                );
            }
        }
    }
    changed
}

fn geometry(seg: &LineSeg) -> [i32; 7] {
    [
        seg.vertical_pos,
        seg.line_height,
        seg.text_height,
        seg.baseline_distance,
        seg.line_spacing,
        seg.column_start,
        seg.segment_width,
    ]
}

/// 이전 exporter는 그림 줄 시작을 제어 슬롯 뒤 첫 글자 위치로 저장했다.
/// 현재 reflow의 슬롯 시작 좌표를 그 wire 규칙으로 바꾼 뒤 전체 줄을 비교한다.
/// 첫 줄 원점과 모호한 다중 제어 갭은 그대로 둔다.
fn restore_previous_picture_line_starts(para: &Paragraph, lines: &mut [LineSeg]) {
    let positions = para.control_text_positions();
    let chars: Vec<_> = para.text.chars().collect();
    for &position in &positions {
        let Some(&after) = para.char_offsets.get(position) else {
            continue;
        };
        let before = position
            .checked_sub(1)
            .and_then(|index| para.char_offsets.get(index).zip(chars.get(index)))
            .map_or(0, |(offset, ch)| offset + ch.len_utf16() as u32);
        if before.checked_add(8) != Some(after)
            || positions.iter().filter(|&&other| other == position).count() != 1
        {
            continue;
        }
        if let Some(line) = lines
            .iter_mut()
            .skip(1)
            .find(|line| line.text_start == before)
        {
            line.text_start = after;
        }
    }
}

/// Return replacement boundaries only when the entire saved layout is exactly
/// reproducible with the old policy, and the new policy changes no line geometry.
/// Callers must independently establish the document's exporter lineage and
/// active font policy. Apply the result to a render copy, never the source IR.
pub(crate) fn cell_lines_from_previous_font_metrics(
    para: &Paragraph,
    width_px: f64,
    previous_styles: &ResolvedStyleSet,
    current_styles: &ResolvedStyleSet,
    dpi: f64,
) -> Option<Vec<LineSeg>> {
    if para.line_segs.len() < 2
        || width_px <= 0.0
        || para.text.contains(['\n', '\r', '\t'])
        || para.controls.is_empty()
        || !para
            .controls
            .iter()
            .all(|ctrl| matches!(ctrl, Control::Picture(pic) if pic.common.treat_as_char))
        || para
            .line_segs
            .iter()
            .any(|seg| seg.tag != LineSeg::TAG_SINGLE_SEGMENT_LINE)
        || para
            .line_segs
            .windows(2)
            .any(|pair| pair[1].vertical_pos <= pair[0].vertical_pos)
    {
        return None;
    }
    let mut previous = para.clone();
    reflow_line_segs(&mut previous, width_px, previous_styles, dpi);
    restore_previous_picture_line_starts(para, &mut previous.line_segs);
    if previous.line_segs.len() != para.line_segs.len()
        || !previous
            .line_segs
            .iter()
            .zip(&para.line_segs)
            .all(|(a, b)| {
                a.text_start == b.text_start && a.tag == b.tag && geometry(a) == geometry(b)
            })
    {
        return None;
    }
    let mut current = para.clone();
    reflow_line_segs(&mut current, width_px, current_styles, dpi);
    restore_previous_picture_line_starts(para, &mut current.line_segs);
    if current.line_segs.len() != para.line_segs.len()
        || !current
            .line_segs
            .iter()
            .zip(&para.line_segs)
            .all(|(a, b)| a.tag == b.tag && geometry(a) == geometry(b))
        || current
            .line_segs
            .iter()
            .zip(&para.line_segs)
            .all(|(a, b)| a.text_start == b.text_start)
    {
        return None;
    }
    Some(current.line_segs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::provenance::FontMetricsPolicy;
    use crate::renderer::{hwpunit_to_px, style_resolver::resolve_styles};

    #[test]
    fn captured_legacy_cell_wraps_are_exactly_reproduced_by_previous_metrics() {
        for id in [
            "cell-mixed-text",
            "cell-fit-width",
            "cell-paragraph-spacing",
        ] {
            let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/editing_parity");
            let doc = crate::parser::parse_document(
                &std::fs::read(root.join("mac-hancom-12.30.0").join(id).join("edited.hwpx"))
                    .unwrap(),
            )
            .unwrap();
            let mut info = doc.doc_info.clone();
            info.font_metrics_policy = FontMetricsPolicy::HancomWindows;
            let previous = resolve_styles(&info, 96.0);
            info.font_metrics_policy = FontMetricsPolicy::HcrDeclared;
            let current = resolve_styles(&info, 96.0);
            let table = doc.sections[0].paragraphs[0]
                .controls
                .iter()
                .find_map(|c| {
                    if let Control::Table(t) = c {
                        Some(t)
                    } else {
                        None
                    }
                })
                .unwrap();
            let cell = &table.cells[0];
            let pad = cell.effective_padding(&table.padding);
            let para = &cell.paragraphs[0];
            let style = &current.para_styles[para.para_shape_id as usize];
            let inner_hu = cell.width as i32 - pad.left as i32 - pad.right as i32;
            let width = hwpunit_to_px(inner_hu - inner_hu.rem_euclid(4), 96.0)
                - style.margin_left
                - style.margin_right;
            let result =
                cell_lines_from_previous_font_metrics(para, width, &previous, &current, 96.0)
                    .unwrap_or_else(|| {
                        let mut reproduced = para.clone();
                        reflow_line_segs(&mut reproduced, width, &previous, 96.0);
                        restore_previous_picture_line_starts(para, &mut reproduced.line_segs);
                        panic!(
                            "{id}: not an exact old-policy layout\nsaved={:?}\nprevious={:?}",
                            para.line_segs, reproduced.line_segs,
                        )
                    });
            assert_eq!(
                result.iter().map(geometry).collect::<Vec<_>>(),
                para.line_segs.iter().map(geometry).collect::<Vec<_>>(),
                "{id}: font-policy repair must retain every saved line dimension",
            );
            if id == "cell-mixed-text" {
                // 실제 편집 reflow의 새 슬롯 원점을 예전 exporter 출력으로 오인하지 않는다.
                let mut canonical = para.clone();
                let mut slot_layout = para.clone();
                reflow_line_segs(&mut slot_layout, width, &previous, 96.0);
                assert_eq!(slot_layout.line_segs[1].text_start, 10);
                assert_eq!(para.line_segs[1].text_start, 18);
                assert_eq!(result[1].text_start, 18);
                canonical.line_segs[1].text_start = slot_layout.line_segs[1].text_start;
                assert!(cell_lines_from_previous_font_metrics(
                    &canonical, width, &previous, &current, 96.0,
                )
                .is_none());
            }
            let mut already_current = para.clone();
            already_current.line_segs = result.clone();
            assert!(cell_lines_from_previous_font_metrics(
                &already_current,
                width,
                &previous,
                &current,
                96.0,
            )
            .is_none());
            let corrected = crate::parser::parse_document(
                &std::fs::read(
                    root.join("mac-hancom-12.30.0-xml14")
                        .join(id)
                        .join("edited.hwpx"),
                )
                .unwrap(),
            )
            .unwrap();
            let corrected_table = corrected.sections[0].paragraphs[0]
                .controls
                .iter()
                .find_map(|c| {
                    if let Control::Table(t) = c {
                        Some(t)
                    } else {
                        None
                    }
                })
                .unwrap();
            assert_eq!(
                result.iter().map(|s| s.text_start).collect::<Vec<_>>(),
                corrected_table.cells[0].paragraphs[0]
                    .line_segs
                    .iter()
                    .map(|s| s.text_start)
                    .collect::<Vec<_>>(),
                "{id}"
            );
            let mut intentional = para.clone();
            intentional.line_segs[1].vertical_pos += 1;
            assert!(cell_lines_from_previous_font_metrics(
                &intentional,
                width,
                &previous,
                &current,
                96.0
            )
            .is_none());
            intentional = para.clone();
            intentional.line_segs[1].tag |= LineSeg::TAG_FIRST_LINE_OF_PAGE;
            assert!(cell_lines_from_previous_font_metrics(
                &intentional,
                width,
                &previous,
                &current,
                96.0
            )
            .is_none());
            for alteration in 0..4 {
                let mut intentional = para.clone();
                match alteration {
                    0 => intentional.line_segs[1].text_start += 1,
                    1 => intentional.line_segs[1].vertical_pos = 0,
                    2 => intentional.text.push('\n'),
                    _ => intentional.line_segs[1].column_start += 10,
                }
                assert!(
                    cell_lines_from_previous_font_metrics(
                        &intentional,
                        width,
                        &previous,
                        &current,
                        96.0,
                    )
                    .is_none(),
                    "{id}: alteration {alteration} must retain stored layout"
                );
            }
        }
    }
}

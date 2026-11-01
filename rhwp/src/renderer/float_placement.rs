//! Flow reservation helpers for non-inline floating objects.

use crate::model::control::Control;
use crate::model::paragraph::{LineSeg, Paragraph};
use crate::model::shape::{
    CommonObjAttr, HorzAlign, HorzRelTo, TextFlow, TextWrap, VertAlign, VertRelTo,
};
use crate::model::table::{Table, TablePageBreak};
use crate::model::HwpUnit;

use super::hwpunit_to_px;
use super::page_layout::LayoutRect;

/// 원본 사다리 인증을 받은 host의 개체 anchor. 인증 전/해제 후에는 종전 첫 줄 축이다.
pub(crate) fn paragraph_flow_anchor(para: &Paragraph) -> Option<i32> {
    let first = para.line_segs.first()?.vertical_pos;
    Some(first.saturating_sub(leading_host_reserve(para)))
}

pub(crate) fn leading_host_reserve(para: &Paragraph) -> i32 {
    para.leading_block_host_layout
        .as_ref()
        .filter(|layout| leading_host_inputs_match(para, layout, None))
        .map_or(0, |layout| layout.reserve_hu)
}

fn padding_inputs(p: &crate::model::Padding) -> [i16; 4] {
    [p.left, p.right, p.top, p.bottom]
}

fn object_inputs(c: &CommonObjAttr) -> crate::model::paragraph::LeadingObjectInputs {
    use crate::model::paragraph::LeadingObjectInputs;
    LeadingObjectInputs {
        attr: c.attr,
        offset: [c.horizontal_offset, c.vertical_offset],
        size: [c.width, c.height],
        margin: padding_inputs(&c.margin),
        z_order: c.z_order,
        prevent_page_break: c.prevent_page_break,
        positioning: [
            c.vert_rel_to as u8,
            c.vert_align as u8,
            c.horz_rel_to as u8,
            c.horz_align as u8,
            c.text_wrap as u8,
            c.text_flow as u8,
            c.width_criterion as u8,
            c.height_criterion as u8,
        ],
        flow: [
            c.treat_as_char,
            c.flow_with_text,
            c.allow_overlap,
            c.affect_line_spacing,
            c.size_protect,
        ],
    }
}

fn leading_table_inputs(table: &Table) -> Option<crate::model::paragraph::LeadingTableInputs> {
    use crate::model::paragraph::{
        LeadingCellInputs, LeadingCellParagraphInputs, LeadingPictureInputs, LeadingTableInputs,
    };
    if !is_para_topbottom_float(&table.common)
        || !matches!(table.common.vert_align, VertAlign::Top)
        || !matches!(table.common.horz_rel_to, HorzRelTo::Para)
        || !matches!(table.common.horz_align, HorzAlign::Left)
        || !table.common.flow_with_text
        || table.common.allow_overlap
        || !matches!(table.page_break, TablePageBreak::None)
        || table.caption.is_some()
        || table.common.height == 0
        || !table.raw_ctrl_data.is_empty()
    {
        return None;
    }
    let cells: Option<Vec<_>> = table
        .cells
        .iter()
        .map(|cell| {
            let paragraphs: Option<Vec<_>> = cell
                .paragraphs
                .iter()
                .map(|p| {
                    // 이 범위의 셀 내부 개체는 배치가 고정된 그림만 인증한다.
                    let pictures: Option<Vec<_>> = p
                        .controls
                        .iter()
                        .map(|c| {
                            let Control::Picture(pic) = c else {
                                return None;
                            };
                            if pic.caption.is_some() {
                                return None;
                            }
                            let a = &pic.shape_attr;
                            Some(LeadingPictureInputs {
                                placement: object_inputs(&pic.common),
                                border_width: pic.border_width,
                                border_x: pic.border_x,
                                border_y: pic.border_y,
                                crop: [
                                    pic.crop.left,
                                    pic.crop.top,
                                    pic.crop.right,
                                    pic.crop.bottom,
                                ],
                                padding: padding_inputs(&pic.padding),
                                bin_data_id: pic.image_attr.bin_data_id,
                                img_dim: pic.img_dim,
                                transform: [
                                    a.render_sx,
                                    a.render_b,
                                    a.render_tx,
                                    a.render_c,
                                    a.render_sy,
                                    a.render_ty,
                                ],
                                shape_size: [
                                    a.original_width,
                                    a.original_height,
                                    a.current_width,
                                    a.current_height,
                                ],
                                rotation: (
                                    a.rotation_angle,
                                    a.rotation_center.x,
                                    a.rotation_center.y,
                                ),
                            })
                        })
                        .collect();
                    Some(LeadingCellParagraphInputs {
                        text: p.text.clone(),
                        char_offsets: p.char_offsets.clone(),
                        char_shapes: p
                            .char_shapes
                            .iter()
                            .map(|r| (r.start_pos, r.char_shape_id))
                            .collect(),
                        para_shape_id: p.para_shape_id,
                        style_id: p.style_id,
                        column_type: p.column_type,
                        lines: p
                            .line_segs
                            .iter()
                            .map(|l| {
                                (
                                    l.text_start,
                                    l.vertical_pos,
                                    l.line_height,
                                    l.text_height,
                                    l.baseline_distance,
                                    l.line_spacing,
                                    l.column_start,
                                    l.segment_width,
                                    l.tag,
                                )
                            })
                            .collect(),
                        pictures: pictures?,
                        tab_extended: p.tab_extended.clone(),
                    })
                })
                .collect();
            Some(LeadingCellInputs {
                address: [cell.row, cell.col, cell.row_span, cell.col_span],
                size: [cell.width, cell.height],
                padding: padding_inputs(&cell.padding),
                border_fill_id: cell.border_fill_id,
                text_direction: cell.text_direction,
                vertical_align: cell.vertical_align as u8,
                line_wrap: cell.line_wrap as u8,
                apply_inner_margin: cell.apply_inner_margin,
                paragraphs: paragraphs?,
            })
        })
        .collect();
    Some(LeadingTableInputs {
        placement: object_inputs(&table.common),
        attr: table.attr,
        rows: table.row_count,
        cols: table.col_count,
        cell_spacing: table.cell_spacing,
        padding: padding_inputs(&table.padding),
        row_sizes: table.row_sizes.clone(),
        border_fill_id: table.border_fill_id,
        repeat_header: table.repeat_header,
        outer_margin: [
            table.outer_margin_left,
            table.outer_margin_right,
            table.outer_margin_top,
            table.outer_margin_bottom,
        ],
        zones: table
            .zones
            .iter()
            .map(|z| {
                (
                    z.start_col,
                    z.start_row,
                    z.end_col,
                    z.end_row,
                    z.border_fill_id,
                )
            })
            .collect(),
        cells: cells?,
        local_rows: table.local_resize_rows.clone(),
        local_cols: table.local_resize_cols.clone(),
        local_widths: table.local_resize_cell_widths.clone(),
        local_heights: table.local_resize_cell_heights.clone(),
    })
}

fn para_style_inputs(
    s: &super::style_resolver::ResolvedParaStyle,
) -> crate::model::paragraph::LeadingParaStyleInputs {
    use crate::model::paragraph::LeadingParaStyleInputs;
    LeadingParaStyleInputs {
        alignment: s.alignment as u8,
        line_spacing_type: s.line_spacing_type as u8,
        line_spacing: s.line_spacing,
        margins: [s.margin_left, s.margin_right, s.indent],
        spacing: [s.spacing_before, s.spacing_after],
        head: (s.head_type as u8, s.para_level, s.numbering_id),
        border_fill_id: s.border_fill_id,
        border_spacing: s.border_spacing,
        border_ignore_margin: s.border_ignore_margin,
        default_tab_width: s.default_tab_width,
        tabs: s
            .tab_stops
            .iter()
            .map(|t| (t.position, t.tab_type, t.fill_type))
            .collect(),
        condense_min_space: s.condense_min_space,
        english_break_unit: s.english_break_unit,
        korean_break_unit: s.korean_break_unit,
        vertical_align: s.vertical_align,
        layout_flags: [
            s.auto_tab_right,
            s.line_wrap_squeeze,
            s.widow_orphan,
            s.keep_with_next,
            s.keep_lines,
            s.page_break_before,
            s.font_line_height,
            s.auto_spacing_eng,
            s.auto_spacing_num,
            s.border_ignore_margin,
        ],
    }
}

fn char_style_inputs(
    s: &super::style_resolver::ResolvedCharStyle,
) -> crate::model::paragraph::LeadingCharStyleInputs {
    use crate::model::paragraph::LeadingCharStyleInputs;
    LeadingCharStyleInputs {
        metrics_policy: s.font_metrics_policy as u8,
        families: s.font_families.clone(),
        subst_families: s.subst_families.clone(),
        hft_families: s.hft_families.clone(),
        font_size: s.font_size,
        font_family: s.font_family.clone(),
        letter_spacing: s.letter_spacing,
        ratio: s.ratio,
        char_offsets: s.char_offsets.clone(),
        relative_sizes: s.relative_sizes.clone(),
        letter_spacings: s.letter_spacings.clone(),
        ratios: s.ratios.clone(),
        geometry_flags: [
            s.latin_font_space,
            s.has_nondefault_glyph_geometry,
            s.use_font_space,
            s.bold,
            s.italic,
            s.superscript,
            s.subscript,
            s.kerning,
            s.emboss,
        ],
        border_fill_id: s.border_fill_id,
    }
}

fn has_host_text(p: &Paragraph) -> bool {
    p.text
        .chars()
        .any(|c| c > '\u{001f}' && c != '\u{fffc}' && !c.is_whitespace())
}

fn section_geometry_inputs(
    s: &crate::model::document::SectionDef,
) -> crate::model::paragraph::LeadingSectionGeometryInputs {
    use crate::model::paragraph::LeadingSectionGeometryInputs;
    let p = &s.page_def;
    LeadingSectionGeometryInputs {
        page_size: [p.width, p.height],
        page_margins: [
            p.margin_left,
            p.margin_right,
            p.margin_top,
            p.margin_bottom,
            p.margin_header,
            p.margin_footer,
            p.margin_gutter,
        ],
        pagination_bottom_tolerance: p.pagination_bottom_tolerance,
        page_attr: p.attr,
        landscape: p.landscape,
        binding: p.binding as u8,
        section_flags: s.flags,
        grid_and_column_spacing: [s.line_grid, s.char_grid, s.column_spacing],
        default_tab_spacing: s.default_tab_spacing,
        page_number: s.page_num,
        page_number_type: s.page_num_type,
        text_direction: s.text_direction,
        hide: [
            s.hide_header,
            s.hide_footer,
            s.hide_master_page,
            s.hide_border,
            s.hide_fill,
            s.hide_empty_line,
        ],
    }
}

fn column_inputs(
    c: &crate::model::page::ColumnDef,
) -> crate::model::paragraph::LeadingColumnInputs {
    use crate::model::paragraph::LeadingColumnInputs;
    LeadingColumnInputs {
        column_count: c.column_count,
        column_type: c.column_type as u8,
        direction: c.direction as u8,
        same_width: c.same_width,
        spacing: c.spacing,
        widths: c.widths.clone(),
        gaps: c.gaps.clone(),
        proportional_widths: c.proportional_widths,
        raw_attr: c.raw_attr,
    }
}

fn structural_inputs(p: &Paragraph) -> Vec<crate::model::paragraph::LeadingStructuralInputs> {
    use crate::model::paragraph::LeadingStructuralInputs;
    p.controls
        .iter()
        .filter_map(|c| match c {
            Control::SectionDef(s) => {
                Some(LeadingStructuralInputs::Section(section_geometry_inputs(s)))
            }
            Control::ColumnDef(c) => Some(LeadingStructuralInputs::Column(column_inputs(c))),
            _ => None,
        })
        .collect()
}

pub(crate) fn leading_section_inputs(
    section: &crate::model::document::Section,
) -> Option<crate::model::paragraph::LeadingSectionInputs> {
    use crate::model::paragraph::LeadingSectionInputs;
    let columns: Vec<_> = section
        .paragraphs
        .iter()
        .flat_map(|p| &p.controls)
        .filter_map(|c| match c {
            Control::ColumnDef(column) => Some(column_inputs(column)),
            _ => None,
        })
        .collect();
    if columns.iter().any(|c| c.column_count > 1) {
        return None;
    }
    Some(LeadingSectionInputs {
        geometry: section_geometry_inputs(&section.section_def),
        columns,
    })
}

fn host_control_order(p: &Paragraph) -> Option<Vec<u8>> {
    p.controls
        .iter()
        .map(|c| {
            Some(match c {
                Control::SectionDef(_) => 0,
                Control::ColumnDef(_) => 1,
                Control::Table(_) => 2,
                Control::Field(field) => 3 + field.field_type as u8,
                _ => return None,
            })
        })
        .collect()
}

fn leading_owner(p: &Paragraph) -> Option<usize> {
    let chars: Vec<char> = p.text.chars().collect();
    if !has_host_text(p)
        || p.char_offsets.len() != chars.len()
        || p.char_offsets.is_empty()
        || chars.iter().any(|c| *c <= '\u{001f}' || *c == '\u{fffc}')
        || !p.orphan_field_ends.is_empty()
        || p.controls
            .iter()
            .filter(|c| matches!(c, Control::Table(_)))
            .count()
            != 1
    {
        return None;
    }
    host_control_order(p)?;
    let index = p
        .controls
        .iter()
        .position(|c| matches!(c, Control::Table(_)))?;
    // 추정 위치 대신 원본 UTF-16 stream 전체를 확인한다. 모든 begin 제어가
    // 첫 글자 앞의 8-unit 슬롯에 있고, 내부/끝 gap은 단일 paired fieldEnd만
    // 설명할 수 있어야 한다. end가 없는 leading begin은 gap도 없어야 한다.
    // 복합 필드와 고아 end는 기존 경로를 유지한다.
    let field_index = p
        .controls
        .iter()
        .enumerate()
        .filter_map(|(i, c)| matches!(c, Control::Field(_)).then_some(i))
        .collect::<Vec<_>>();
    let field_end = match (field_index.as_slice(), p.field_ranges.as_slice()) {
        ([], []) | ([_], []) => None,
        ([control_index], [range])
            if range.control_idx == *control_index
                && range.start_char_idx == 0
                && range.end_char_idx > 0
                && range.end_char_idx <= chars.len() =>
        {
            Some(range.end_char_idx)
        }
        _ => return None,
    };
    let leading_units = u32::try_from(p.controls.len()).ok()?.checked_mul(8)?;
    if p.char_offsets[0] != leading_units {
        return None;
    }
    let mut stream_end = leading_units;
    for (i, c) in chars.iter().enumerate() {
        if p.char_offsets[i] != stream_end {
            return None;
        }
        stream_end = stream_end.checked_add(Paragraph::char_utf16_len(*c))?;
        if field_end == Some(i + 1) {
            stream_end = stream_end.checked_add(8)?;
        }
    }
    if stream_end.checked_add(1)? != p.char_count {
        return None;
    }
    Some(index)
}

pub(crate) fn leading_host_inputs_match(
    p: &Paragraph,
    layout: &crate::model::paragraph::LeadingBlockHostLayout,
    styles: Option<&super::style_resolver::ResolvedStyleSet>,
) -> bool {
    if leading_owner(p) != Some(layout.control_index)
        || p.para_shape_id != layout.host_para_shape_id
        || p.style_id != layout.host_style_id
        || host_control_order(p).as_ref() != Some(&layout.control_order)
        || structural_inputs(p) != layout.structural_controls
    {
        return false;
    }
    let Some(Control::Table(table)) = p.controls.get(layout.control_index) else {
        return false;
    };
    if leading_table_inputs(table).as_ref() != Some(&layout.table) {
        return false;
    }
    if let Some(styles) = styles {
        if layout.border_widths.iter().any(|(id, widths)| {
            styles
                .border_styles
                .get(usize::from(*id).saturating_sub(1))
                .map(|s| {
                    s.borders
                        .each_ref()
                        .map(|line| (line.line_type as u8, line.width))
                })
                .as_ref()
                != Some(widths)
        }) {
            return false;
        }
        if layout.para_styles.iter().any(|(id, proof)| {
            styles
                .para_styles
                .get(*id as usize)
                .map(para_style_inputs)
                .as_ref()
                != Some(proof)
        }) || layout.char_styles.iter().any(|(id, proof)| {
            styles
                .char_styles
                .get(*id as usize)
                .map(char_style_inputs)
                .as_ref()
                != Some(proof)
        }) || p.char_shapes.iter().any(|r| {
            !layout
                .char_styles
                .iter()
                .any(|(id, _)| *id == r.char_shape_id)
        }) {
            return false;
        }
    }
    true
}

/// Returns the old reserve only when rollback was committed. Callers holding a pre-mutation
/// native reset bound must subtract this value once from that bound as well.
pub(crate) fn normalize_leading_host_layout(
    p: &mut Paragraph,
    styles: &super::style_resolver::ResolvedStyleSet,
) -> Option<i32> {
    let invalid = p
        .leading_block_host_layout
        .as_ref()
        .is_some_and(|layout| !leading_host_inputs_match(p, layout, Some(styles)));
    if invalid {
        p.rollback_leading_block_host_layout()
    } else {
        None
    }
}

/// Capture uses the eventual legacy text coordinate even before a mutable invalidation gate.
pub(crate) fn effective_host_text_end(p: &Paragraph) -> Option<i32> {
    let l = p.line_segs.last()?;
    let height = if l.text_height > 0 {
        l.text_height
    } else {
        l.line_height
    };
    let end = l
        .vertical_pos
        .saturating_add(height.saturating_add(l.line_spacing));
    let rollback = p
        .leading_block_host_layout
        .as_ref()
        .filter(|layout| !leading_host_inputs_match(p, layout, None))
        .map_or(0, |layout| layout.reserve_hu);
    Some(end.saturating_sub(rollback))
}

/// Import-only source proof, before any line synthesis or normalization. Authentic successor
/// evidence closes the separate host pitch; neither source order nor a tolerance can replace it.
pub(crate) fn certify_leading_table_hosts(
    paragraphs: &mut [Paragraph],
    styles: &super::style_resolver::ResolvedStyleSet,
    dpi: f64,
    column_width_hu: i32,
    section: &crate::model::paragraph::LeadingSectionInputs,
) {
    use crate::model::paragraph::LeadingBlockHostLayout;
    let stored = |p: &Paragraph| {
        !p.line_segs.is_empty()
            && p.line_segs.iter().all(|l| {
                l.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY == 0
                    && l.line_height > 0
                    && l.text_height > 0
            })
            && p.line_segs
                .windows(2)
                .all(|w| w[1].vertical_pos >= w[0].vertical_pos)
    };
    let certificates: Vec<_> = paragraphs
        .iter()
        .enumerate()
        .map(|(index, p)| {
            let owner = leading_owner(p)?;
            let Control::Table(t) = &p.controls[owner] else {
                return None;
            };
            let table = leading_table_inputs(t)?;
            let style = styles.para_styles.get(p.para_shape_id as usize)?;
            if !stored(p)
                || p.line_segs.iter().any(|l| l.line_height != l.text_height)
                || style.page_break_before
                || matches!(
                    p.column_type,
                    crate::model::paragraph::ColumnBreakType::Page
                        | crate::model::paragraph::ColumnBreakType::Column
                )
                || (index > 0 && p.column_type != crate::model::paragraph::ColumnBreakType::None)
            {
                return None;
            }
            // 수평 여백 상자가 본문 단과 실제로 겹쳐야 흐름 reserve를 귀속할 수 있다.
            let left = i64::from(signed_hwpunit(t.common.horizontal_offset))
                - i64::from(t.outer_margin_left);
            let right = left
                + i64::from(t.common.width)
                + i64::from(t.outer_margin_left)
                + i64::from(t.outer_margin_right);
            if right <= 0 || left >= i64::from(column_width_hu) {
                return None;
            }
            let reserve = i32::try_from(
                i64::from(t.common.height)
                    + i64::from(signed_hwpunit(t.common.vertical_offset).max(0))
                    + i64::from(t.outer_margin_top)
                    + i64::from(t.outer_margin_bottom),
            )
            .ok()?;
            if reserve <= 0 {
                return None;
            }
            let gap = |a: f64, b: f64| super::px_to_hwpunit_round(a + b, dpi);
            let anchor = if index == 0 {
                gap(0.0, style.spacing_before)
            } else {
                let prev = &paragraphs[index - 1];
                if !stored(prev) || !prev.controls.is_empty() {
                    return None;
                }
                effective_host_text_end(prev)?.checked_add(gap(
                    styles
                        .para_styles
                        .get(prev.para_shape_id as usize)?
                        .spacing_after,
                    style.spacing_before,
                ))?
            };
            let next = paragraphs.get(index + 1)?;
            if !stored(next) || !next.controls.is_empty() {
                return None;
            }
            if p.line_segs.first()?.vertical_pos != anchor.checked_add(reserve)?
                || next.line_segs.first()?.vertical_pos
                    != effective_host_text_end(p)?.checked_add(gap(
                        style.spacing_after,
                        styles
                            .para_styles
                            .get(next.para_shape_id as usize)?
                            .spacing_before,
                    ))?
            {
                return None;
            }
            // rollback이 항상 표현 가능하도록 원본 좌표 전체를 먼저 확인한다.
            if p.line_segs
                .iter()
                .any(|l| i32::try_from(i64::from(l.vertical_pos) - i64::from(reserve)).is_err())
            {
                return None;
            }
            let mut para_ids = vec![p.para_shape_id];
            let mut char_ids: Vec<_> = p.char_shapes.iter().map(|r| r.char_shape_id).collect();
            for cell in &table.cells {
                for cell_p in &cell.paragraphs {
                    para_ids.push(cell_p.para_shape_id);
                    char_ids.extend(cell_p.char_shapes.iter().map(|r| r.1));
                }
            }
            para_ids.sort_unstable();
            para_ids.dedup();
            char_ids.sort_unstable();
            char_ids.dedup();
            let mut border_ids = vec![table.border_fill_id];
            border_ids.extend(table.cells.iter().map(|cell| cell.border_fill_id));
            border_ids.extend(table.zones.iter().map(|zone| zone.4));
            border_ids.extend(para_ids.iter().filter_map(|id| {
                styles
                    .para_styles
                    .get(*id as usize)
                    .map(|s| s.border_fill_id)
            }));
            border_ids.extend(char_ids.iter().filter_map(|id| {
                styles
                    .char_styles
                    .get(*id as usize)
                    .map(|s| s.border_fill_id)
            }));
            border_ids.retain(|id| *id > 0);
            border_ids.sort_unstable();
            border_ids.dedup();
            let border_widths = border_ids
                .into_iter()
                .filter_map(|id| {
                    styles
                        .border_styles
                        .get(usize::from(id).saturating_sub(1))
                        .map(|style| {
                            (
                                id,
                                style
                                    .borders
                                    .each_ref()
                                    .map(|line| (line.line_type as u8, line.width)),
                            )
                        })
                })
                .collect();
            let para_styles: Option<Vec<_>> = para_ids
                .into_iter()
                .map(|id| Some((id, para_style_inputs(styles.para_styles.get(id as usize)?))))
                .collect();
            let char_styles: Option<Vec<_>> = char_ids
                .into_iter()
                .map(|id| Some((id, char_style_inputs(styles.char_styles.get(id as usize)?))))
                .collect();
            Some(LeadingBlockHostLayout {
                control_index: owner,
                reserve_hu: reserve,
                host_para_shape_id: p.para_shape_id,
                host_style_id: p.style_id,
                control_order: host_control_order(p)?,
                structural_controls: structural_inputs(p),
                section: section.clone(),
                table,
                para_styles: para_styles?,
                char_styles: char_styles?,
                border_widths,
            })
        })
        .collect();
    for (p, certificate) in paragraphs.iter_mut().zip(certificates) {
        p.leading_block_host_layout = certificate;
    }
}

/// Loader synthesis can refresh a table's missing cell lines without changing authored geometry.
/// Seal that model representation after import, retaining the previously proven source relation.
pub(crate) fn seal_imported_leading_host_inputs(paragraphs: &mut [Paragraph]) {
    for p in paragraphs {
        let Some(layout) = p.leading_block_host_layout.as_ref() else {
            continue;
        };
        let Some(Control::Table(t)) = p.controls.get(layout.control_index) else {
            p.rollback_leading_block_host_layout();
            continue;
        };
        let Some(current) = leading_table_inputs(t) else {
            p.rollback_leading_block_host_layout();
            continue;
        };
        let mut source = layout.table.clone();
        let mut allowed = source.cells.len() == current.cells.len();
        for (old_cell, new_cell) in source.cells.iter_mut().zip(&current.cells) {
            if old_cell.paragraphs.len() != new_cell.paragraphs.len() {
                allowed = false;
                break;
            }
            for (old, new) in old_cell.paragraphs.iter_mut().zip(&new_cell.paragraphs) {
                if old.lines == new.lines {
                    continue;
                }
                // 9-field cache만, 원본 부재에서 loader 합성으로 바뀐 경우 허용한다.
                let absent = old.lines.is_empty() || old.lines.iter().all(|l| l.2 == 0 && l.3 == 0);
                let synthesized = !new.lines.is_empty()
                    && new.lines.iter().all(|l| {
                        l.2 > 0 && l.3 > 0 && l.8 & LineSeg::TAG_IMPLEMENTATION_PROPERTY != 0
                    });
                if absent && synthesized {
                    old.lines = new.lines.clone();
                } else {
                    allowed = false;
                }
            }
        }
        // placement, dimensions, allocation, content, style refs and pictures remain exact.
        if allowed && source == current {
            p.leading_block_host_layout.as_mut().unwrap().table = current;
        } else {
            p.rollback_leading_block_host_layout();
        }
    }
}

pub(crate) fn tac_line_fields(l: &LineSeg) -> [i64; 9] {
    [
        i64::from(l.text_start),
        i64::from(l.vertical_pos),
        i64::from(l.line_height),
        i64::from(l.text_height),
        i64::from(l.baseline_distance),
        i64::from(l.line_spacing),
        i64::from(l.column_start),
        i64::from(l.segment_width),
        i64::from(l.tag),
    ]
}

/// 원본 stream과 선언 geometry만 투영한다. cache revision/dirty는 출처가 아니다.
pub(crate) fn tac_paragraph_source(
    p: &Paragraph,
) -> Option<crate::model::paragraph::TacParagraphSource> {
    use crate::model::paragraph::{TacControlSource, TacParagraphSource};
    if !p.field_ranges.is_empty()
        || !p.range_tags.is_empty()
        || !p.markpen_marks.is_empty()
        || !p.special_space_origins.is_empty()
        || !p.ctrl_data_records.iter().all(Option::is_none)
    {
        return None;
    }
    let controls: Option<Vec<_>> = p
        .controls
        .iter()
        .map(|c| match c {
            Control::Table(t) => Some(TacControlSource::Table(Box::new(tac_table_source(t)?))),
            Control::ColumnDef(c) if c.column_count == 1 => {
                Some(TacControlSource::Column(column_inputs(c)))
            }
            _ => None,
        })
        .collect();
    let source = TacParagraphSource {
        text: p.text.clone(),
        char_count: p.char_count,
        char_offsets: p.char_offsets.clone(),
        char_shapes: p
            .char_shapes
            .iter()
            .map(|r| (r.start_pos, r.char_shape_id))
            .collect(),
        para_shape_id: p.para_shape_id,
        style_id: p.style_id,
        column_type: p.column_type,
        raw_break_type: p.raw_break_type,
        tab_extended: p.tab_extended.clone(),
        orphan_ends: p
            .orphan_field_ends
            .iter()
            .map(|r| (r.char_idx, r.begin_id_ref, r.field_id, r.begin_ctrl_id))
            .collect(),
        controls: controls?,
        lines: p.line_segs.iter().map(tac_line_fields).collect(),
    };
    tac_stream_complete(&source).then_some(source)
}

fn tac_stream_complete(p: &crate::model::paragraph::TacParagraphSource) -> bool {
    let chars: Vec<_> = p.text.chars().collect();
    if chars.len() != p.char_offsets.len() || chars.iter().any(|c| *c == '\u{fffc}') {
        return false;
    }
    let mut end = 0u32;
    let mut control_units = 0u32;
    for (i, c) in chars.iter().enumerate() {
        let orphan_units = p.orphan_ends.iter().filter(|r| r.0 == i).count() as u32 * 8;
        let Some(gap) = p.char_offsets[i]
            .checked_sub(end)
            .and_then(|g| g.checked_sub(orphan_units))
        else {
            return false;
        };
        if gap % 8 != 0 {
            return false;
        }
        control_units = control_units.saturating_add(gap);
        let Some(next) = p.char_offsets[i].checked_add(Paragraph::char_utf16_len(*c)) else {
            return false;
        };
        end = next;
    }
    if p.orphan_ends.iter().any(|r| r.0 > chars.len()) {
        return false;
    }
    let orphan_units = p.orphan_ends.iter().filter(|r| r.0 == chars.len()).count() as u32 * 8;
    let Some(gap) = p
        .char_count
        .checked_sub(1)
        .and_then(|e| e.checked_sub(end))
        .and_then(|g| g.checked_sub(orphan_units))
    else {
        return false;
    };
    gap % 8 == 0
        && control_units.checked_add(gap)
            == u32::try_from(p.controls.len())
                .ok()
                .and_then(|n| n.checked_mul(8))
}

fn tac_table_source(t: &Table) -> Option<crate::model::paragraph::TacTableSource> {
    use crate::model::paragraph::{LeadingCellInputs, LeadingTableInputs, TacTableSource};
    if t.caption.is_some() || !t.raw_ctrl_data.is_empty() || !t.raw_table_record_extra.is_empty() {
        return None;
    }
    let paragraphs: Option<Vec<_>> = t
        .cells
        .iter()
        .map(|c| {
            if !c.raw_list_extra.is_empty() {
                return None;
            }
            c.paragraphs
                .iter()
                .map(tac_paragraph_source)
                .collect::<Option<Vec<_>>>()
        })
        .collect();
    let inputs = LeadingTableInputs {
        placement: object_inputs(&t.common),
        attr: t.attr,
        rows: t.row_count,
        cols: t.col_count,
        cell_spacing: t.cell_spacing,
        padding: padding_inputs(&t.padding),
        row_sizes: t.row_sizes.clone(),
        border_fill_id: t.border_fill_id,
        repeat_header: t.repeat_header,
        outer_margin: [
            t.outer_margin_left,
            t.outer_margin_right,
            t.outer_margin_top,
            t.outer_margin_bottom,
        ],
        zones: t
            .zones
            .iter()
            .map(|z| {
                (
                    z.start_col,
                    z.start_row,
                    z.end_col,
                    z.end_row,
                    z.border_fill_id,
                )
            })
            .collect(),
        cells: t
            .cells
            .iter()
            .map(|c| LeadingCellInputs {
                address: [c.row, c.col, c.row_span, c.col_span],
                size: [c.width, c.height],
                padding: padding_inputs(&c.padding),
                border_fill_id: c.border_fill_id,
                text_direction: c.text_direction,
                vertical_align: c.vertical_align as u8,
                line_wrap: c.line_wrap as u8,
                apply_inner_margin: c.apply_inner_margin,
                paragraphs: Vec::new(),
            })
            .collect(),
        local_rows: t.local_resize_rows.clone(),
        local_cols: t.local_resize_cols.clone(),
        local_widths: t.local_resize_cell_widths.clone(),
        local_heights: t.local_resize_cell_heights.clone(),
    };
    Some(TacTableSource {
        inputs,
        cell_headers: t.cells.iter().map(|c| c.is_header).collect(),
        cell_fields: t.cells.iter().map(|c| c.field_name.clone()).collect(),
        page_break: t.page_break as u8,
        paragraphs: paragraphs?,
    })
}

fn tac_root_table(p: &Paragraph) -> Option<&Table> {
    let [Control::Table(t)] = p.controls.as_slice() else {
        return None;
    };
    let c = &t.common;
    (p.text.is_empty()
        && p.orphan_field_ends.is_empty()
        && c.treat_as_char
        && c.flow_with_text
        && !c.allow_overlap
        && c.width > 0
        && c.height > 0
        && c.horizontal_offset == 0
        && c.vertical_offset == 0
        && padding_inputs(&c.margin) == [0; 4]
        && [
            t.outer_margin_left,
            t.outer_margin_right,
            t.outer_margin_top,
            t.outer_margin_bottom,
        ] == [0; 4]
        && matches!(c.vert_rel_to, VertRelTo::Para)
        && matches!(c.vert_align, VertAlign::Top)
        && matches!(c.horz_rel_to, HorzRelTo::Para)
        && matches!(c.horz_align, HorzAlign::Left)
        && matches!(c.text_wrap, TextWrap::TopAndBottom)
        && matches!(c.text_flow, TextFlow::BothSides)
        && t.cell_spacing == 0
        // HWPX CELL은 parser/serializer의 RowBreak projection이다.
        && matches!(t.page_break, TablePageBreak::RowBreak))
    .then_some(t.as_ref())
}

fn ordinary_source_lines(lines: &[[i64; 9]]) -> bool {
    !lines.is_empty()
        && lines.iter().all(|l| {
            l[2] > 0 && l[3] > 0 && l[8] as u32 & LineSeg::TAG_IMPLEMENTATION_PROPERTY == 0
        })
}

fn absent_tail(p: &crate::model::paragraph::TacParagraphSource) -> bool {
    p.lines.is_empty()
        && p.controls.is_empty()
        && p.orphan_ends.is_empty()
        && p.tab_extended.is_empty()
        && !p.text.is_empty()
        && p.text.chars().all(|c| c > '\u{001f}' && c != '\u{fffc}')
}

/// loader와 자기 wire가 같은 제한된 원본 부재 map을 검사한다.
pub(crate) fn tac_source_absence_map_valid(
    source: &[crate::model::paragraph::TacParagraphSource],
) -> bool {
    use crate::model::paragraph::TacControlSource;
    if source.len() != 3
        || !source[1].text.is_empty()
        || !source[1].lines.is_empty()
        || !source.iter().all(tac_stream_complete)
        || !ordinary_source_lines(&source[0].lines)
        || !ordinary_source_lines(&source[2].lines)
    {
        return false;
    }
    let [TacControlSource::Table(table)] = source[1].controls.as_slice() else {
        return false;
    };
    let inputs = &table.inputs;
    let c = &inputs.placement;
    if inputs.cells.len() != table.paragraphs.len()
        || table.cell_headers.len() != table.paragraphs.len()
        || table.cell_fields.len() != table.paragraphs.len()
        || table.cell_fields.iter().any(Option::is_some)
        || !c.flow[0]
        || !c.flow[1]
        || c.flow[2]
        || c.size.iter().any(|n| *n == 0)
        || c.offset != [0; 2]
        || c.margin != [0; 4]
        || c.positioning[..6]
            != [
                VertRelTo::Para as u8,
                VertAlign::Top as u8,
                HorzRelTo::Para as u8,
                HorzAlign::Left as u8,
                TextWrap::TopAndBottom as u8,
                TextFlow::BothSides as u8,
            ]
        || inputs.outer_margin != [0; 4]
        || inputs.cell_spacing != 0
        || table.page_break != TablePageBreak::RowBreak as u8
    {
        return false;
    }
    let mut missing = false;
    for cell in &table.paragraphs {
        let mut tail = false;
        for (pi, p) in cell.iter().enumerate() {
            if !tac_stream_complete(p)
                || p.controls
                    .iter()
                    .any(|c| !matches!(c, TacControlSource::Column(c) if c.column_count == 1))
            {
                return false;
            }
            if p.lines.is_empty() {
                if pi == 0 || !absent_tail(p) {
                    return false;
                }
                tail = true;
                missing = true;
            } else if tail || !ordinary_source_lines(&p.lines) {
                return false;
            }
        }
    }
    missing
}

fn tac_style_inputs(
    source: &[crate::model::paragraph::TacParagraphSource],
    styles: &super::style_resolver::ResolvedStyleSet,
) -> Option<(
    Vec<(u16, crate::model::paragraph::LeadingParaStyleInputs)>,
    Vec<(u32, crate::model::paragraph::LeadingCharStyleInputs)>,
    Vec<(u16, [(u8, u8); 4])>,
)> {
    use crate::model::paragraph::TacControlSource;
    fn visit(
        p: &crate::model::paragraph::TacParagraphSource,
        paras: &mut Vec<u16>,
        chars: &mut Vec<u32>,
        borders: &mut Vec<u16>,
    ) {
        paras.push(p.para_shape_id);
        chars.extend(p.char_shapes.iter().map(|r| r.1));
        for c in &p.controls {
            if let TacControlSource::Table(t) = c {
                borders.push(t.inputs.border_fill_id);
                borders.extend(t.inputs.cells.iter().map(|c| c.border_fill_id));
                borders.extend(t.inputs.zones.iter().map(|z| z.4));
                for cell in &t.paragraphs {
                    for p in cell {
                        visit(p, paras, chars, borders);
                    }
                }
            }
        }
    }
    let (mut paras, mut chars, mut borders) = (Vec::new(), Vec::new(), Vec::new());
    for p in source {
        visit(p, &mut paras, &mut chars, &mut borders);
    }
    paras.sort_unstable();
    paras.dedup();
    chars.sort_unstable();
    chars.dedup();
    let paras: Option<Vec<_>> = paras
        .into_iter()
        .map(|id| Some((id, para_style_inputs(styles.para_styles.get(id as usize)?))))
        .collect();
    let chars: Option<Vec<_>> = chars
        .into_iter()
        .map(|id| Some((id, char_style_inputs(styles.char_styles.get(id as usize)?))))
        .collect();
    let (paras, chars) = (paras?, chars?);
    borders.extend(paras.iter().map(|r| r.1.border_fill_id));
    borders.extend(chars.iter().map(|r| r.1.border_fill_id));
    borders.retain(|id| *id > 0);
    borders.sort_unstable();
    borders.dedup();
    let borders: Option<Vec<_>> = borders
        .into_iter()
        .map(|id| {
            Some((
                id,
                styles
                    .border_styles
                    .get(id as usize - 1)?
                    .borders
                    .each_ref()
                    .map(|l| (l.line_type as u8, l.width)),
            ))
        })
        .collect();
    Some((paras, chars, borders?))
}

/// 실제 부재를 loader 합성 전에 묶는다. 작성된 tag는 출처 판별에 쓰지 않는다.
pub(crate) fn capture_tac_line_origins(
    section: &mut crate::model::document::Section,
    styles: &super::style_resolver::ResolvedStyleSet,
    xml_presence: &[Vec<bool>],
) {
    use crate::model::paragraph::{TacControlSource, TacLineOrigin, TacTableLineOrigin};
    let Some(context) = leading_section_inputs(section) else {
        return;
    };
    for i in 1..section.paragraphs.len().saturating_sub(1) {
        if section.paragraphs[i].tac_line_origin.is_some()
            || !section.paragraphs[i].line_segs.is_empty()
            || tac_root_table(&section.paragraphs[i]).is_none()
        {
            continue;
        }
        let source: Option<Vec<_>> = section.paragraphs[i - 1..=i + 1]
            .iter()
            .map(tac_paragraph_source)
            .collect();
        let Some(source) = source else {
            continue;
        };
        if !tac_source_absence_map_valid(&source) {
            continue;
        }
        let [TacControlSource::Table(table)] = source[1].controls.as_slice() else {
            continue;
        };
        let leaves: Vec<_> = table
            .paragraphs
            .iter()
            .enumerate()
            .flat_map(|(ci, cell)| {
                cell.iter()
                    .enumerate()
                    .filter(|(_, p)| p.lines.is_empty())
                    .map(move |(pi, p)| (ci, pi, p.clone()))
            })
            .collect();
        let Some(presence) = xml_presence.get(i) else {
            continue;
        };
        let originals = std::iter::once(&source[1]).chain(table.paragraphs.iter().flatten());
        if presence.len() != 1 + table.paragraphs.iter().map(Vec::len).sum::<usize>()
            || originals
                .zip(presence)
                .any(|(p, present)| p.lines.is_empty() && *present)
        {
            continue;
        }
        let Some((para_styles, char_styles, border_widths)) = tac_style_inputs(&source, styles)
        else {
            continue;
        };
        section.paragraphs[i].tac_line_origin =
            Some(TacLineOrigin::Owner(Box::new(TacTableLineOrigin {
                section: context.clone(),
                source,
                para_styles,
                char_styles,
                border_widths,
            })));
        if let Control::Table(t) = &mut section.paragraphs[i].controls[0] {
            for (ci, pi, p) in leaves {
                t.cells[ci].paragraphs[pi].tac_line_origin = Some(TacLineOrigin::Leaf(Box::new(p)));
            }
        }
    }
}

/// 전체 입력을 다시 검사하고 runtime tag/cache는 보존한다.
pub(crate) fn tac_group_inputs_match(
    section: &crate::model::document::Section,
    i: usize,
    proof: &crate::model::paragraph::TacTableLineOrigin,
    styles: &super::style_resolver::ResolvedStyleSet,
) -> bool {
    use crate::model::paragraph::{TacControlSource, TacLineOrigin};
    if i == 0
        || i + 1 >= section.paragraphs.len()
        || proof.source.len() != 3
        || leading_section_inputs(section).as_ref() != Some(&proof.section)
        || tac_root_table(&section.paragraphs[i]).is_none()
    {
        return false;
    }
    let Some((ps, cs, bs)) = tac_style_inputs(&proof.source, styles) else {
        return false;
    };
    if ps != proof.para_styles || cs != proof.char_styles || bs != proof.border_widths {
        return false;
    }
    let current: Option<Vec<_>> = section.paragraphs[i - 1..=i + 1]
        .iter()
        .map(tac_paragraph_source)
        .collect();
    let Some(mut current) = current else {
        return false;
    };
    let Some(first) = current[0].lines.first().zip(proof.source[0].lines.first()) else {
        return false;
    };
    let delta = first.0[1] - first.1[1];
    for index in [0, 2] {
        for l in &mut current[index].lines {
            l[1] -= delta;
        }
    }
    if current[1].lines.len() != 1
        || current[1].lines[0][8] as u32
            != LineSeg::TAG_SINGLE_SEGMENT_LINE | LineSeg::TAG_IMPLEMENTATION_PROPERTY
    {
        return false;
    }
    current[1].lines.clear();
    let [TacControlSource::Table(old)] = proof.source[1].controls.as_slice() else {
        return false;
    };
    let [TacControlSource::Table(now)] = current[1].controls.as_mut_slice() else {
        return false;
    };
    let Control::Table(live) = &section.paragraphs[i].controls[0] else {
        return false;
    };
    if now.paragraphs.len() != old.paragraphs.len() {
        return false;
    }
    for (ci, (nc, oc)) in now.paragraphs.iter_mut().zip(&old.paragraphs).enumerate() {
        if nc.len() != oc.len() {
            return false;
        }
        for (pi, (np, op)) in nc.iter_mut().zip(oc).enumerate() {
            if op.lines.is_empty() {
                if live
                    .cells
                    .get(ci)
                    .and_then(|c| c.paragraphs.get(pi))
                    .and_then(|p| p.tac_line_origin.as_ref())
                    != Some(&TacLineOrigin::Leaf(Box::new(op.clone())))
                    || np.lines.len() != 1
                    || np.lines[0][8] as u32
                        != LineSeg::TAG_SINGLE_SEGMENT_LINE | LineSeg::TAG_IMPLEMENTATION_PROPERTY
                {
                    return false;
                }
                np.lines.clear();
            }
        }
    }
    current == proof.source
}

pub(crate) fn has_tac_line_origin(p: &Paragraph) -> bool {
    p.tac_line_origin.is_some()
        || p.controls.iter().any(|c| match c {
            Control::Table(t) => t
                .cells
                .iter()
                .any(|c| c.paragraphs.iter().any(has_tac_line_origin)),
            _ => false,
        })
}

pub(crate) fn tac_snapshot_inputs_match(a: &Paragraph, b: &Paragraph) -> bool {
    let (Some(sa), Some(sb)) = (tac_paragraph_source(a), tac_paragraph_source(b)) else {
        return false;
    };
    if a.tac_line_origin != b.tac_line_origin || sa != sb {
        return false;
    }
    a.controls
        .iter()
        .zip(&b.controls)
        .all(|(a, b)| match (a, b) {
            (Control::Table(a), Control::Table(b)) => a.cells.iter().zip(&b.cells).all(|(a, b)| {
                a.paragraphs
                    .iter()
                    .zip(&b.paragraphs)
                    .all(|(a, b)| tac_snapshot_inputs_match(a, b))
            }),
            _ => true,
        })
}

/// Interpret an HWPUNIT value that may have been stored through a signed field.
pub(crate) fn signed_hwpunit(value: HwpUnit) -> i32 {
    value as i32
}

/// 그림 host는 전체 폭이고 다음 문단부터 어울림이 시작되는 저장 밴드.
pub(crate) fn following_fixed_picture_wrap_band(
    para: &Paragraph,
    next: Option<&Paragraph>,
    page: &crate::model::page::PageDef,
    column_width_hu: i32,
) -> Option<(i32, i32)> {
    let body_width = page.width as i32 - page.margin_left as i32 - page.margin_right as i32;
    if (body_width - column_width_hu).abs() > 1 {
        return None;
    }
    let line = next?.line_segs.first()?;
    if line.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY != 0
        || line.segment_width <= 0
        || line.segment_width >= body_width - 200
    {
        return None;
    }
    let body_top = page.margin_top as i32 + page.margin_header as i32;
    para.controls.iter().find_map(|control| {
        let common = match control {
            Control::Picture(picture) => &picture.common,
            Control::Shape(shape)
                if matches!(shape.as_ref(), crate::model::shape::ShapeObject::Picture(_)) =>
            {
                shape.common()
            }
            _ => return None,
        };
        if common.treat_as_char
            || !matches!(common.text_wrap, TextWrap::Square)
            || !matches!(common.horz_align, HorzAlign::Left)
            || !matches!(common.vert_align, VertAlign::Top)
        {
            return None;
        }
        let left = signed_hwpunit(common.horizontal_offset)
            - match common.horz_rel_to {
                HorzRelTo::Paper => page.margin_left as i32,
                HorzRelTo::Page => 0,
                _ => return None,
            };
        let top = signed_hwpunit(common.vertical_offset)
            - match common.vert_rel_to {
                VertRelTo::Paper => body_top,
                VertRelTo::Page => 0,
                _ => return None,
            };
        let right = left + common.width as i32 + common.margin.right as i32;
        let left = left - common.margin.left as i32;
        let bottom = top + common.height as i32 + common.margin.bottom as i32;
        let top = top - common.margin.top as i32;
        let beside = (line.column_start == 0 && (line.segment_width - left).abs() <= 200)
            || ((line.column_start - right).abs() <= 200
                && (line.column_start + line.segment_width - body_width).abs() <= 200);
        (beside && line.vertical_pos < bottom && line.vertical_pos + line.line_height > top)
            .then_some((line.column_start, line.segment_width))
    })
}

/// A non-TAC `TopAndBottom` object positioned from its host paragraph.
/// 저장 LINE_SEG 없는 문단이 섞인 셀. 한컴은 이런 셀 내용을 저장 줄 위치 없이 새로
/// 조판하므로, 저장 vpos 에 기댄 호환 규칙(빈 문단 겹침, 저장 쪽 경계)을 적용하지 않는다.
pub(crate) fn cell_is_reflowed(cell: &crate::model::table::Cell) -> bool {
    cell.paragraphs.iter().any(|p| p.line_segs.is_empty())
}

/// 문단 기준 자리차지 RowBreak 표가 새로 조판되는 셀을 가지면 한컴은 쪽마다 조각을
/// 바깥 여백 상자로 닫는다: 조각마다 위 여백을 다시 열고 아래 여백을 쪽 예산에서 뺀다
/// (86712 법령 인용 표: 연속 쪽 표 상단 = 본문 상단 + 283HU, 첫 조각 34줄).
pub(crate) fn reflowed_rowbreak_fragment_repeats_outer_margin(table: &Table) -> bool {
    is_para_topbottom_float(&table.common)
        && matches!(table.page_break, TablePageBreak::RowBreak)
        && table.cells.iter().any(cell_is_reflowed)
}

/// 저장 레이아웃 문서(HWPX 원본/hwp5 기원 HWPX)의 문단 기준 자리차지 분할 표(RowBreak·
/// CellBreak — aift p10~p13 의 pageBreak="TABLE" 표도 조각마다 +141HU) —
/// 한컴은 분할 조각마다 표의 바깥 여백 상자를 반복한다: 조각 상단에 outer_margin_top
/// 을 다시 열고 쪽 하단 예산에서 outer_margin_bottom 을 뺀다 (10-inner-table-01:
/// outMargin top/bottom=141HU — 양쪽 페이지에서 표 상단 = 본문 상단 +141HU, 첫 조각
/// 하단도 같은 값만큼 얕다). 저장 LINE_SEG 기반 배치라 `cell_is_reflowed` 조건 없이
/// 적용한다.
pub(crate) fn stored_layout_rowbreak_repeats_outer_margin(
    stored_layout: bool,
    table: &Table,
) -> bool {
    stored_layout
        && is_para_topbottom_float(&table.common)
        && matches!(
            table.page_break,
            TablePageBreak::RowBreak | TablePageBreak::CellBreak
        )
        && (table.outer_margin_top > 0 || table.outer_margin_bottom > 0)
}

pub(crate) fn is_para_topbottom_float(common: &CommonObjAttr) -> bool {
    !common.treat_as_char
        && matches!(common.text_wrap, TextWrap::TopAndBottom)
        && matches!(common.vert_rel_to, VertRelTo::Para)
}

/// First-fragment top inset for a paragraph-relative wrap-around RowBreak table.
///
/// Hancom positions the visible table box after the object's positive paragraph offset and its
/// outer top margin. Full-table placement has other float paths, but split tables bypass them and
/// need this value in both pagination and paint layout so their page cut stays in sync.
pub(crate) fn para_square_rowbreak_first_fragment_top_offset_px(table: &Table, dpi: f64) -> f64 {
    let vertical_offset = signed_hwpunit(table.common.vertical_offset);
    if table.common.treat_as_char
        || !matches!(table.page_break, TablePageBreak::RowBreak)
        || !matches!(table.common.text_wrap, TextWrap::Square)
        || !matches!(table.common.vert_rel_to, VertRelTo::Para)
        || !matches!(table.common.vert_align, VertAlign::Top | VertAlign::Inside)
        || vertical_offset <= 0
    {
        return 0.0;
    }

    hwpunit_to_px(
        vertical_offset.saturating_add(i32::from(table.outer_margin_top)),
        dpi,
    )
    .max(0.0)
}

/// 원본 다중 셀 빈 호스트가 표 바깥 여백 상자를 저장한 경우의 위쪽 inset.
/// 실제 LINE_SEG와 현재 발행된 개체 높이만 쓰며 측정 baseline/dirty 이력은 쓰지 않는다.
pub(crate) fn native_empty_host_margin_box_outer_top_hu(
    native_hwp5_layout: bool,
    para: &Paragraph,
    table: &Table,
    next_para: Option<&Paragraph>,
    styles: &super::style_resolver::ResolvedStyleSet,
) -> Option<i32> {
    if !native_hwp5_layout
        || !is_para_topbottom_float(&table.common)
        || !matches!(table.common.vert_align, VertAlign::Top)
        || signed_hwpunit(table.common.vertical_offset) != 0
        || !matches!(table.page_break, TablePageBreak::RowBreak)
        || table.cells.len() <= 1
        || table.caption.is_some()
        || para.controls.len() != 1
        || para.leading_block_host_layout.is_some()
        || para
            .text
            .chars()
            .any(|ch| ch > '\u{001F}' && ch != '\u{FFFC}' && !ch.is_whitespace())
        || table.outer_margin_top <= 0
        || table.outer_margin_bottom < 0
        || table.common.height == 0
    {
        return None;
    }
    let next = next_para.filter(|next| {
        next.controls.is_empty()
            && next.leading_block_host_layout.is_none()
            && matches!(
                next.column_type,
                crate::model::paragraph::ColumnBreakType::None
            )
    })?;
    // 정확히 표+여백만 담은 저장 사다리다. 문단 경계 간격을 포함한 출처는 별도 계약이다.
    if styles
        .para_styles
        .get(para.para_shape_id as usize)?
        .spacing_after
        != 0.0
        || styles
            .para_styles
            .get(next.para_shape_id as usize)?
            .spacing_before
            != 0.0
        || styles
            .para_styles
            .get(next.para_shape_id as usize)?
            .page_break_before
    {
        return None;
    }
    let ([host], [following]) = (para.line_segs.as_slice(), next.line_segs.as_slice()) else {
        return None;
    };
    if [host, following]
        .iter()
        .any(|seg| seg.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY != 0 || seg.line_height <= 0)
        || host.vertical_pos <= 0
    {
        return None;
    }
    let delta = i64::from(following.vertical_pos) - i64::from(host.vertical_pos);
    // 기존 folded-line witness와 body 재계산의 line end보다 표 상자가 커야 한다.
    let host_advance =
        i64::from(host.line_height.max(host.text_height)) + i64::from(host.line_spacing.max(0));
    let margin_box = i64::from(table.common.height)
        + i64::from(table.outer_margin_top)
        + i64::from(table.outer_margin_bottom);
    (delta > host_advance && delta == margin_box).then_some(i32::from(table.outer_margin_top))
}

/// Stored host-line evidence for the narrow native-HWP RowBreak flow contract (#2439).
///
/// The returned value is the non-synthetic stored line advance in HWPUNIT.  Callers may combine
/// it with the positive object offset for pagination, or with the painted lane bottom and outer
/// bottom for layout.  Keeping the structural predicate here prevents typeset/full/partial layout
/// from drifting apart.  A broad empty-host outer-margin rule is disproven by #2097.
pub(crate) fn native_empty_host_rowbreak_line_advance_hu(
    native_hwp5_layout: bool,
    para: &Paragraph,
    table: &Table,
    next_para: Option<&Paragraph>,
) -> Option<i32> {
    let has_non_whitespace_text = |paragraph: &Paragraph| {
        paragraph
            .text
            .chars()
            .any(|ch| ch > '\u{001F}' && ch != '\u{FFFC}' && !ch.is_whitespace())
    };
    if !native_hwp5_layout
        || table.common.treat_as_char
        || !is_para_topbottom_float(&table.common)
        || has_non_whitespace_text(para)
        || !matches!(table.common.vert_rel_to, VertRelTo::Para)
        || !matches!(table.page_break, TablePageBreak::RowBreak)
        || signed_hwpunit(table.common.vertical_offset) <= 0
        || para
            .controls
            .iter()
            .filter(|control| matches!(control, Control::Table(_)))
            .count()
            != 1
        || para
            .controls
            .iter()
            .filter(|control| {
                matches!(control, Control::Table(candidate)
                    if is_para_topbottom_float(&candidate.common))
            })
            .count()
            != 1
        || !next_para.is_some_and(|next| has_non_whitespace_text(next) && next.controls.is_empty())
    {
        return None;
    }

    let host_seg = para
        .line_segs
        .iter()
        .find(|seg| seg.tag & 0x80000000 == 0 && seg.line_height > 0)?;
    let advance = host_seg.line_height + host_seg.line_spacing.max(0);
    if advance <= 0 {
        return None;
    }
    // [#2808] 저장 vpos ladder 로 한컴이 host 줄 advance 를 실제 흐름에 계상했는지
    // 검증한다. #2439 재현 문서(기계 반복 양식)는 ladder 가 표 높이를 접고
    // `next.vpos - host.vpos == advance` 로 저장되는 반면(= advance 가 실 흐름 증거),
    // 일반 물리 ladder 문서는 델타가 표 높이+offset 을 이미 포함하므로 advance 를
    // 다시 더하면 이중 계상되어 쪽 경계 한 줄이 +1 로 밀린다 (10k r19 회귀 4건).
    let next_vpos = next_para
        .and_then(|next| {
            next.line_segs
                .iter()
                .find(|seg| seg.tag & 0x80000000 == 0 && seg.line_height > 0)
        })
        .map(|seg| seg.vertical_pos)?;
    if (next_vpos - host_seg.vertical_pos - advance).abs() > 1 {
        return None;
    }
    Some(advance)
}

/// 저장 vpos 사다리가 빈 호스트 TopAndBottom 표의 배타 영역을 계상하는지 검증한다.
///
/// 한컴은 빈(공백만 있는 것도 포함) 호스트 문단 + 문단 기준 TopAndBottom 표를 두
/// 가지 방식으로 기록한다:
///
/// 1. 배타-인코딩: host 줄이 배타 상자보다 위에 남고, 다음 문단 vpos =
///    host vpos + 배타 span(vertical_offset + outer margin + 표 높이). 흐름
///    재개점은 margin box 하단(페인트 하단 + outer_margin_bottom).
/// 2. 밀림-인코딩: host 줄 자체가 배타 하단에 저장된다(host 줄 상자가 배타
///    상자와 겹치면 아래로 밀림). 다음 문단은 배타 하단 + host 줄 advance 뒤.
///    host 줄에 글자처럼 취급 개체가 있으면 그 줄은 자기 항목이 배타 하단에서
///    직접 조판·전진하므로 흐름은 배타 하단에서 재개한다(줄 advance 이중 적용 방지).
///
/// 기계 생성 양식(#2439 계열)은 사다리가 host 줄 advance 만 담아 배타 영역을
/// 접는다 — 둘 다 아니면 None 을 돌려줘 기존 `global + reserved` 계약을 유지한다.
pub(crate) fn empty_host_topbottom_exclusion_flow_bottom(
    para: &Paragraph,
    table: &Table,
    next_para: Option<&Paragraph>,
    next_spacing_before_px: f64,
    col_top_px: f64,
    lane_top_px: f64,
    painted_height_px: f64,
    host_line_has_inline_items: bool,
    dpi: f64,
) -> Option<f64> {
    // 비문자 TopAndBottom 표가 둘 이상이면 사다리 델타를 이 표 하나에 귀속할 수 없다.
    let para_topbottom_tables = para
        .controls
        .iter()
        .filter(
            |control| matches!(control, Control::Table(t) if is_para_topbottom_float(&t.common)),
        )
        .count();
    if para_topbottom_tables != 1 {
        return None;
    }
    let host_seg = para
        .line_segs
        .iter()
        .find(|seg| seg.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY == 0 && seg.line_height > 0)?;
    let exclusion_bottom_px =
        lane_top_px + painted_height_px + hwpunit_to_px(i32::from(table.outer_margin_bottom), dpi);
    // px↔HU 왕복과 표 높이 측정 오차용 허용치. 접힘 인코딩과 배타 인코딩의 델타
    // 차이는 통상 수천 HWPUNIT 이므로 판별에는 충분히 좁다.
    const LADDER_TOL_HU: i64 = 400;
    let tol_px = hwpunit_to_px(LADDER_TOL_HU as i32, dpi);
    // 밀림 인코딩: 호스트 줄 저장 vpos 가 배타 하단과 일치하면 호스트 줄이
    // 배타 상자 아래로 밀린 것이다.
    let host_abs_px = col_top_px + hwpunit_to_px(host_seg.vertical_pos, dpi);
    if (host_abs_px - exclusion_bottom_px).abs() <= tol_px {
        if host_line_has_inline_items {
            return Some(exclusion_bottom_px);
        }
        let host_advance = host_seg.line_height + host_seg.line_spacing.max(0);
        return Some(exclusion_bottom_px + hwpunit_to_px(host_advance, dpi));
    }
    let next_vpos = next_para
        .and_then(|next| {
            next.line_segs.iter().find(|seg| {
                seg.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY == 0 && seg.line_height > 0
            })
        })?
        .vertical_pos;
    let exclusion_hu = i64::from(signed_hwpunit(table.common.vertical_offset).max(0))
        + i64::from(table.outer_margin_top)
        + i64::from(super::px_to_hwpunit_round(painted_height_px, dpi))
        + i64::from(table.outer_margin_bottom);
    let ladder_delta = i64::from(next_vpos) - i64::from(host_seg.vertical_pos);
    let over = ladder_delta - exclusion_hu;
    let next_spacing_before_hu = i64::from(super::px_to_hwpunit_round(
        next_spacing_before_px.max(0.0),
        dpi,
    ));
    // 다음 문단 spacing_before 를 사다리 안에 접는 저장본과 밖에 두는 저장본을 모두
    // 인정한다.
    let encodes_exclusion =
        over.abs() <= LADDER_TOL_HU || (over - next_spacing_before_hu).abs() <= LADDER_TOL_HU;
    encodes_exclusion.then_some(exclusion_bottom_px)
}

/// Stored page-reset evidence for the native-HWP single-cell RowBreak blank-band contract.
///
/// Some Hancom documents serialize a one-row table with a cell taller than the table object's
/// declared height. When the following paragraph restarts at exactly
/// `cell_height - object_height + outer_top + outer_bottom`, Hancom paints the declared-height
/// portion at the bottom of the current page and preserves the residual as an empty continuation
/// band on the next page. This deliberately strict predicate keeps that compatibility behavior
/// away from ordinary RowBreak tables and from the global row-splitting tolerances.
pub(crate) fn native_single_cell_rowbreak_saved_residual_split_hu(
    native_hwp5_layout: bool,
    para: &Paragraph,
    table: &Table,
    next_para: Option<&Paragraph>,
) -> Option<(i32, i32)> {
    let has_non_whitespace_text = |paragraph: &Paragraph| {
        paragraph
            .text
            .chars()
            .any(|ch| ch > '\u{001F}' && ch != '\u{FFFC}' && !ch.is_whitespace())
    };
    fn only_real_line(paragraph: &Paragraph) -> Option<&LineSeg> {
        let mut lines = paragraph
            .line_segs
            .iter()
            .filter(|seg| seg.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY == 0);
        let line = lines.next()?;
        lines.next().is_none().then_some(line)
    }
    fn first_real_line(paragraph: &Paragraph) -> Option<&LineSeg> {
        paragraph
            .line_segs
            .iter()
            .find(|seg| seg.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY == 0)
    }

    if !native_hwp5_layout
        || para.controls.len() != 1
        || !matches!(para.controls.first(), Some(Control::Table(_)))
        || has_non_whitespace_text(para)
        || table.common.treat_as_char
        || !is_para_topbottom_float(&table.common)
        || !matches!(table.common.vert_align, VertAlign::Top)
        || signed_hwpunit(table.common.vertical_offset) != 0
        || !matches!(table.page_break, TablePageBreak::RowBreak)
        || table.row_count != 1
        || table.col_count != 1
        || table.cells.len() != 1
        || table.outer_margin_top <= 0
        || table.outer_margin_bottom <= 0
    {
        return None;
    }

    let cell = &table.cells[0];
    if cell.row != 0
        || cell.col != 0
        || cell.row_span != 1
        || cell.col_span != 1
        || !matches!(
            cell.vertical_align,
            crate::model::table::VerticalAlign::Center
        )
        || cell.paragraphs.len() != 1
        || !cell.paragraphs[0].controls.is_empty()
        || !has_non_whitespace_text(&cell.paragraphs[0])
        || only_real_line(&cell.paragraphs[0]).is_none()
    {
        return None;
    }

    let object_height = signed_hwpunit(table.common.height);
    let cell_height = signed_hwpunit(cell.height);
    let residual = cell_height.checked_sub(object_height)?;
    if object_height <= 0 || residual <= 0 {
        return None;
    }

    let host_vpos = only_real_line(para)?.vertical_pos;
    let next = next_para?;
    if !next.controls.is_empty() || !has_non_whitespace_text(next) {
        return None;
    }
    let next_vpos = first_real_line(next)?.vertical_pos;
    let saved_advance = residual
        .saturating_add(i32::from(table.outer_margin_top))
        .saturating_add(i32::from(table.outer_margin_bottom));
    if next_vpos <= 0 || host_vpos <= next_vpos || (next_vpos - saved_advance).abs() > 1 {
        return None;
    }

    Some((object_height, residual))
}

/// Per-fragment flow inset for a native-HWP CellBreak table whose leading body style carries a
/// stable stored trailing line gap.
///
/// Hancom repeats the visible outer-top inset on every continuation and keeps the stored cell
/// line gap clear at the fragment bottom.  The latter is a fragment boundary gap, not part of
/// every row: adding it to each cell line would inflate large tables catastrophically.  Require a
/// stable positive witness across the first body rows so ordinary/mixed CellBreak tables retain
/// their existing layout. Later rows may legitimately switch paragraph styles; Hancom keeps the
/// fragment boundary contract established by the leading body band. The returned pair is
/// `(top, trailing)` and its sum is the larger of the stored line gap and the two visible outer
/// margins.
pub(crate) fn native_uniform_cellbreak_fragment_spacing_hu(
    native_hwp5_layout: bool,
    para: &Paragraph,
    table: &Table,
) -> Option<(i32, i32)> {
    let has_non_whitespace_text = para
        .text
        .chars()
        .any(|ch| ch > '\u{001F}' && ch != '\u{FFFC}' && !ch.is_whitespace());
    if !native_hwp5_layout
        || has_non_whitespace_text
        || table.common.treat_as_char
        || !is_para_topbottom_float(&table.common)
        || !matches!(table.common.vert_align, VertAlign::Top | VertAlign::Inside)
        || !matches!(table.page_break, TablePageBreak::CellBreak)
        || !table.repeat_header
        || signed_hwpunit(table.common.vertical_offset) <= 0
        || table.outer_margin_top <= 0
        || table.outer_margin_bottom < 0
        || para.controls.len() != 1
        || !matches!(para.controls.first(), Some(Control::Table(_)))
    {
        return None;
    }

    let header_rows = table.leading_header_rows();
    let first_body_row = header_rows.len();
    let row_count = table.row_count as usize;
    if first_body_row == 0 || first_body_row >= row_count {
        return None;
    }

    const LEADING_BODY_GAP_WITNESS_ROWS: usize = 8;
    let witness_end = (first_body_row + LEADING_BODY_GAP_WITNESS_ROWS).min(row_count);
    let mut row_gaps = vec![0i32; witness_end - first_body_row];
    for cell in &table.cells {
        let row = cell.row as usize;
        if row < first_body_row || row >= witness_end || cell.row_span != 1 {
            continue;
        }
        let gap = cell
            .paragraphs
            .last()
            .and_then(|paragraph| {
                paragraph.line_segs.iter().rev().find(|seg| {
                    seg.tag & crate::model::paragraph::LineSeg::TAG_IMPLEMENTATION_PROPERTY == 0
                })
            })
            .map(|seg| seg.line_spacing)
            .unwrap_or(0);
        if gap > 0 {
            row_gaps[row - first_body_row] = row_gaps[row - first_body_row].max(gap);
        }
    }

    let stored_gap = *row_gaps.first()?;
    if stored_gap <= 0 || row_gaps.iter().any(|gap| *gap != stored_gap) {
        return None;
    }

    let outer_top = i32::from(table.outer_margin_top);
    let outer_bottom = i32::from(table.outer_margin_bottom).max(0);
    let total = stored_gap.max(outer_top.saturating_add(outer_bottom));
    Some((outer_top, total.saturating_sub(outer_top)))
}

/// [Task #1658 v3] 페이지 하단 고정(vert=쪽·valign=Bottom) 자리차지 개체 (결재/서명 틀).
/// 한글은 이를 본문 하단에 절대배치(겹침 허용)하고 본문 텍스트를 그 위까지만 흐르게
/// 한다(하단 배타 영역) — 문서순 flow 소비 대상이 아니다. #1653 RCA 패턴 B.
pub(crate) fn is_page_bottom_fixed_float(common: &CommonObjAttr) -> bool {
    !common.treat_as_char
        && matches!(common.text_wrap, TextWrap::TopAndBottom)
        && matches!(common.vert_rel_to, VertRelTo::Page)
        && matches!(common.vert_align, VertAlign::Bottom)
}

/// Horizontal reference data used by float placement and table layout.
#[derive(Debug, Clone, Copy)]
pub(crate) struct FloatPlacementContext {
    pub col_area: LayoutRect,
    pub body_area: Option<LayoutRect>,
    pub paper_width: Option<f64>,
    pub host_margin_left: f64,
    pub host_margin_right: f64,
}

impl FloatPlacementContext {
    pub(crate) fn new(col_area: LayoutRect) -> Self {
        Self {
            col_area,
            body_area: None,
            paper_width: None,
            host_margin_left: 0.0,
            host_margin_right: 0.0,
        }
    }

    pub(crate) fn with_body_area(mut self, body_area: LayoutRect) -> Self {
        self.body_area = Some(body_area);
        self
    }

    pub(crate) fn with_paper_width(mut self, paper_width: f64) -> Self {
        self.paper_width = Some(paper_width);
        self
    }

    pub(crate) fn with_host_margins(mut self, left: f64, right: f64) -> Self {
        self.host_margin_left = left;
        self.host_margin_right = right;
        self
    }
}

/// Complete reference boxes used to position a floating object.
///
/// `paragraph` is the paragraph's usable horizontal box. `line_y` is the current
/// anchor-line top; HWP's paragraph-relative vertical coordinate moves with this
/// value when the paragraph is repaginated or moved to another column.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ObjectPlacementContext {
    pub paper: LayoutRect,
    pub page: LayoutRect,
    pub column: LayoutRect,
    pub paragraph: LayoutRect,
    pub line_y: f64,
}

/// Resolve a non-inline object's visual frame from the common object attributes.
/// Offsets are deliberately interpreted as signed HWPUNIT values.
pub(crate) fn object_frame(
    common: &CommonObjAttr,
    width: f64,
    height: f64,
    ctx: ObjectPlacementContext,
    dpi: f64,
) -> LayoutRect {
    let h_offset = hwpunit_to_px(signed_hwpunit(common.horizontal_offset), dpi);
    let v_offset = hwpunit_to_px(signed_hwpunit(common.vertical_offset), dpi);
    let (ref_x, ref_w) = match common.horz_rel_to {
        HorzRelTo::Paper => (ctx.paper.x, ctx.paper.width),
        HorzRelTo::Page => (ctx.page.x, ctx.page.width),
        HorzRelTo::Column => (ctx.column.x, ctx.column.width),
        HorzRelTo::Para => (ctx.paragraph.x, ctx.paragraph.width),
    };
    let x = match common.horz_align {
        HorzAlign::Left | HorzAlign::Inside => ref_x + h_offset,
        HorzAlign::Center => ref_x + (ref_w - width) / 2.0 + h_offset,
        HorzAlign::Right | HorzAlign::Outside => ref_x + ref_w - width - h_offset,
    };

    let (ref_y, ref_h) = match common.vert_rel_to {
        VertRelTo::Paper => (ctx.paper.y, ctx.paper.height),
        VertRelTo::Page => (ctx.page.y, ctx.page.height),
        // Paragraph-relative placement is anchored to the current line, while the
        // remaining paragraph/column extent supplies center and bottom alignment.
        VertRelTo::Para => (
            ctx.line_y,
            (ctx.paragraph.y + ctx.paragraph.height - ctx.line_y).max(0.0),
        ),
    };
    let y = match common.vert_align {
        VertAlign::Top | VertAlign::Inside => ref_y + v_offset,
        VertAlign::Center => ref_y + (ref_h - height) / 2.0 + v_offset,
        VertAlign::Bottom | VertAlign::Outside => ref_y + ref_h - height - v_offset,
    };

    LayoutRect {
        x,
        y,
        width: width.max(0.0),
        height: height.max(0.0),
    }
}

/// 위치 오프셋이 바깥 여백 상자를 가리킬 때 개체 본체가 그 상자 안쪽으로 들어가는 양(px).
/// 정렬 방향의 여백만 작용한다: 왼쪽/위 정렬은 왼쪽/위 여백만큼, 오른쪽/아래 정렬은
/// 오른쪽/아래 여백만큼 안쪽으로, 가운데 정렬은 양쪽 여백 차이의 절반만큼 옮긴다.
pub(crate) fn outer_margin_box_inset_px(common: &CommonObjAttr, dpi: f64) -> (f64, f64) {
    let left = hwpunit_to_px(common.margin.left as i32, dpi);
    let right = hwpunit_to_px(common.margin.right as i32, dpi);
    let top = hwpunit_to_px(common.margin.top as i32, dpi);
    let bottom = hwpunit_to_px(common.margin.bottom as i32, dpi);
    let dx = match common.horz_align {
        HorzAlign::Left | HorzAlign::Inside => left,
        HorzAlign::Center => (left - right) / 2.0,
        HorzAlign::Right | HorzAlign::Outside => -right,
    };
    let dy = match common.vert_align {
        VertAlign::Top | VertAlign::Inside => top,
        VertAlign::Center => (top - bottom) / 2.0,
        VertAlign::Bottom | VertAlign::Outside => -bottom,
    };
    (dx, dy)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum WrapGeometry {
    /// Rectangular contour fallback. Tight/Through use this until native contours
    /// are available in the IR.
    Side(TextFlow),
    TopAndBottom,
}

/// Text-exclusion rectangle, kept separate from paint order. Callers may sort
/// render nodes by z-order without changing this geometry.
#[derive(Debug, Clone, Copy)]
pub(crate) struct FloatExclusion {
    pub rect: LayoutRect,
    pub geometry: WrapGeometry,
}

pub(crate) fn float_exclusion(
    common: &CommonObjAttr,
    frame: LayoutRect,
    dpi: f64,
) -> Option<FloatExclusion> {
    if common.treat_as_char {
        return None;
    }
    let geometry = match common.text_wrap {
        TextWrap::Square | TextWrap::Tight | TextWrap::Through => {
            WrapGeometry::Side(common.text_flow)
        }
        TextWrap::TopAndBottom => WrapGeometry::TopAndBottom,
        TextWrap::BehindText | TextWrap::InFrontOfText => return None,
    };
    let left = hwpunit_to_px(common.margin.left as i32, dpi);
    let right = hwpunit_to_px(common.margin.right as i32, dpi);
    let top = hwpunit_to_px(common.margin.top as i32, dpi);
    let bottom = hwpunit_to_px(common.margin.bottom as i32, dpi);
    Some(FloatExclusion {
        rect: LayoutRect {
            x: frame.x - left,
            y: frame.y - top,
            width: frame.width + left + right,
            height: frame.height + top + bottom,
        },
        geometry,
    })
}

fn rect_intersects_band(rect: LayoutRect, top: f64, bottom: f64) -> bool {
    rect.y < bottom && top < rect.y + rect.height
}

/// Return the horizontal text intervals available in a line band after applying
/// every active float exclusion. Input order is ignored, so z-order cannot affect
/// line geometry.
pub(crate) fn available_text_intervals(
    column: LayoutRect,
    line_top: f64,
    line_bottom: f64,
    exclusions: &[FloatExclusion],
) -> Vec<(f64, f64)> {
    let column_right = column.x + column.width;
    let mut intervals = vec![(column.x, column_right)];

    let mut active: Vec<_> = exclusions
        .iter()
        .copied()
        .filter(|exclusion| rect_intersects_band(exclusion.rect, line_top, line_bottom))
        .collect();
    active.sort_by(|a, b| {
        a.rect
            .x
            .total_cmp(&b.rect.x)
            .then_with(|| a.rect.width.total_cmp(&b.rect.width))
    });

    for exclusion in active {
        if matches!(exclusion.geometry, WrapGeometry::TopAndBottom)
            && exclusion.rect.x < column_right
            && exclusion.rect.x + exclusion.rect.width > column.x
        {
            return Vec::new();
        }

        let (cut_left, cut_right) = match exclusion.geometry {
            WrapGeometry::TopAndBottom => continue,
            WrapGeometry::Side(TextFlow::BothSides) => {
                (exclusion.rect.x, exclusion.rect.x + exclusion.rect.width)
            }
            WrapGeometry::Side(TextFlow::LeftOnly) => (exclusion.rect.x, column_right),
            WrapGeometry::Side(TextFlow::RightOnly) => {
                (column.x, exclusion.rect.x + exclusion.rect.width)
            }
            WrapGeometry::Side(TextFlow::LargestOnly) => {
                let left_width = (exclusion.rect.x - column.x).max(0.0);
                let right_width =
                    (column_right - (exclusion.rect.x + exclusion.rect.width)).max(0.0);
                if left_width >= right_width {
                    (exclusion.rect.x, column_right)
                } else {
                    (column.x, exclusion.rect.x + exclusion.rect.width)
                }
            }
        };
        let cut_left = cut_left.max(column.x);
        let cut_right = cut_right.min(column_right);
        if cut_left >= cut_right {
            continue;
        }
        let mut next = Vec::new();
        for (start, end) in intervals {
            if end <= cut_left || start >= cut_right {
                next.push((start, end));
            } else {
                if start < cut_left {
                    next.push((start, cut_left));
                }
                if cut_right < end {
                    next.push((cut_right, end));
                }
            }
        }
        intervals = next;
    }
    intervals
}

/// Advance the flow cursor for a placed paragraph-relative TopAndBottom object.
/// Side wraps and overlay planes never consume the object's full height.
pub(crate) fn flow_cursor_after_float(
    common: &CommonObjAttr,
    frame: LayoutRect,
    column: LayoutRect,
    current_y: f64,
    dpi: f64,
) -> f64 {
    if !matches!(common.vert_rel_to, VertRelTo::Para)
        || !matches!(common.text_wrap, TextWrap::TopAndBottom)
    {
        return current_y;
    }
    let Some(exclusion) = float_exclusion(common, frame, dpi) else {
        return current_y;
    };
    let exclusion_right = exclusion.rect.x + exclusion.rect.width;
    let column_right = column.x + column.width;
    if exclusion_right <= column.x || exclusion.rect.x >= column_right {
        return current_y;
    }
    current_y.max(exclusion.rect.y + exclusion.rect.height)
}

/// Compute the same depth-0 horizontal range used by table layout.
pub(crate) fn horizontal_range(
    common: &CommonObjAttr,
    width_px: f64,
    ctx: FloatPlacementContext,
    dpi: f64,
) -> (f64, f64) {
    let h_offset = hwpunit_to_px(signed_hwpunit(common.horizontal_offset), dpi);
    let col_area = ctx.col_area;
    let (ref_x, ref_w) = match common.horz_rel_to {
        HorzRelTo::Paper => {
            let fallback_paper_w = if width_px > col_area.width {
                col_area.x * 2.0 + width_px
            } else {
                col_area.x * 2.0 + col_area.width
            };
            let paper_w = ctx.paper_width.unwrap_or(fallback_paper_w);
            (0.0, paper_w)
        }
        HorzRelTo::Page => ctx
            .body_area
            .filter(|body| body.width > 0.0)
            .map(|body| (body.x, body.width))
            .unwrap_or((col_area.x, col_area.width)),
        HorzRelTo::Para => (
            col_area.x + ctx.host_margin_left,
            (col_area.width - ctx.host_margin_left - ctx.host_margin_right).max(0.0),
        ),
        HorzRelTo::Column => (col_area.x, col_area.width),
    };

    let x = match common.horz_align {
        HorzAlign::Left | HorzAlign::Inside => ref_x + h_offset,
        HorzAlign::Center => ref_x + (ref_w - width_px).max(0.0) / 2.0 + h_offset,
        HorzAlign::Right | HorzAlign::Outside => ref_x + (ref_w - width_px).max(0.0) - h_offset,
    };
    (x, x + width_px.max(0.0))
}

/// A placed float lane in page/column-relative coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct FloatLane {
    pub x_start: f64,
    pub x_end: f64,
    pub top: f64,
    pub bottom: f64,
}

impl FloatLane {
    fn overlaps_x(&self, x_start: f64, x_end: f64) -> bool {
        ranges_overlap(self.x_start, self.x_end, x_start, x_end)
    }
}

/// Tracks bottom reservations for horizontally independent float lanes.
#[derive(Debug, Default, Clone)]
pub(crate) struct FloatLaneSet {
    lanes: Vec<FloatLane>,
}

impl FloatLaneSet {
    pub(crate) fn new() -> Self {
        Self { lanes: Vec::new() }
    }

    pub(crate) fn clear(&mut self) {
        self.lanes.clear();
    }

    pub(crate) fn lanes(&self) -> &[FloatLane] {
        &self.lanes
    }

    pub(crate) fn pushed_top(&self, x_start: f64, x_end: f64, raw_top: f64) -> f64 {
        self.lanes
            .iter()
            .filter(|lane| lane.overlaps_x(x_start, x_end))
            .fold(raw_top, |top, lane| top.max(lane.bottom))
    }

    pub(crate) fn place(
        &mut self,
        x_start: f64,
        x_end: f64,
        raw_top: f64,
        height: f64,
    ) -> FloatLane {
        let top = self.pushed_top(x_start, x_end, raw_top);
        let lane = FloatLane {
            x_start,
            x_end,
            top,
            bottom: top + height.max(0.0),
        };
        self.lanes.push(lane);
        lane
    }

    /// Place a float according to HWP's allowOverlap contract. Overlap-enabled
    /// objects retain their requested top but are still recorded so a later
    /// overlap-disabled object can avoid them.
    pub(crate) fn place_with_policy(
        &mut self,
        x_start: f64,
        x_end: f64,
        raw_top: f64,
        height: f64,
        allow_overlap: bool,
    ) -> FloatLane {
        let top = if allow_overlap {
            raw_top
        } else {
            self.pushed_top(x_start, x_end, raw_top)
        };
        let lane = FloatLane {
            x_start,
            x_end,
            top,
            bottom: top + height.max(0.0),
        };
        self.lanes.push(lane);
        lane
    }

    pub(crate) fn max_bottom(&self) -> f64 {
        self.lanes
            .iter()
            .map(|lane| lane.bottom)
            .fold(0.0, f64::max)
    }
}

pub(crate) fn ranges_overlap(a_start: f64, a_end: f64, b_start: f64, b_end: f64) -> bool {
    let a0 = a_start.min(a_end);
    let a1 = a_start.max(a_end);
    let b0 = b_start.min(b_end);
    let b1 = b_start.max(b_end);
    a0 < b1 && b0 < a1
}


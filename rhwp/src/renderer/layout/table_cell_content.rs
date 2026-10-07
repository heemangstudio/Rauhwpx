//! 표 셀 내용 레이아웃 (세로쓰기, 셀 도형, 내장 표)

use super::super::composer::{compose_paragraph, ComposedParagraph};
use super::super::page_layout::LayoutRect;
use super::super::render_tree::*;
use super::super::style_resolver::ResolvedStyleSet;
use super::super::{hwpunit_to_px, ShapeStyle, TextStyle};
use super::border_rendering::{
    build_row_col_x, collect_cell_borders, collect_zone_borders, render_cell_diagonal,
    render_transparent_borders,
};
use super::text_measurement::{
    hft_vertical_advance, is_cjk_char, is_vertical_rotate_char, resolved_to_text_style,
    vertical_substitute_char,
};
use super::utils::{extract_shape_transform, find_bin_data};
use super::{CellContext, CellPathEntry, LayoutEngine};
use crate::model::bin_data::BinDataContent;
use crate::model::control::Control;
use crate::model::paragraph::Paragraph;
use crate::model::style::Alignment;
use crate::model::table::VerticalAlign;

impl LayoutEngine {
    /// 셀의 개체 배치 순서는 유지하고 방출된 노드에 페인트 순서만 기록한다.
    pub(super) fn layer_cell_control_children(
        node: &mut RenderNode,
        start: usize,
        control: &Control,
        para_index: usize,
        control_index: usize,
    ) {
        let common = match control {
            Control::Picture(picture) => &picture.common,
            Control::Shape(shape) => shape.common(),
            Control::Table(table) => &table.common,
            Control::Equation(equation) => &equation.common,
            _ => return,
        };
        let mut layer =
            Self::render_layer_from_common(common, para_index, control_index).for_parent();
        if common.treat_as_char {
            layer.text_wrap = None;
        }
        for child in &mut node.children[start..] {
            child.set_layer(layer);
        }
    }

    pub(super) fn sort_cell_paint_children(node: &mut RenderNode, start: usize) {
        use crate::model::shape::TextWrap;
        // native 497b0c: TAC/일반 개체는 중간, 뒤/앞 개체는 별도 면에 놓는다.
        // 같은 면과 zOrder는 원래 순서를 유지한다.
        node.children[start..].sort_by_key(|child| {
            let plane = match child.layer.and_then(|layer| layer.text_wrap) {
                Some(TextWrap::BehindText) => -1_i8,
                Some(TextWrap::InFrontOfText) => 1,
                _ => 0,
            };
            (plane, child.layer.map(|layer| layer.z_order).unwrap_or(0))
        });
    }
    /// 세로쓰기 셀의 텍스트를 수직 방향으로 배치한다.
    ///
    /// HWP 세로쓰기 규칙:
    /// - 텍스트 방향: 위→아래, 열(column)은 오른쪽→왼쪽
    /// - text_direction: 1=영문 눕힘(회전), 2=영문 세움(직립)
    /// - 정렬 매핑: Top→오른쪽(첫 열), Center→중앙, Bottom→왼쪽
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn layout_vertical_cell_text(
        &self,
        tree: &mut PageRenderTree,
        cell_node: &mut RenderNode,
        composed_paras: &[ComposedParagraph],
        paragraphs: &[Paragraph],
        styles: &ResolvedStyleSet,
        inner_area: &LayoutRect,
        vertical_align: VerticalAlign,
        text_direction: u8,
        section_index: usize,
        table_meta: Option<(usize, usize)>,
        cell_idx: usize,
        enclosing_cell_ctx: Option<CellContext>,
    ) {
        // 1. line_seg 기반으로 composed lines를 열(column)로 변환
        //    세로쓰기에서 각 composed line = 하나의 열
        //    line_seg.line_height = 열 폭, line_seg.line_spacing = 열 간격
        struct CharInfo {
            ch: char,
            style: TextStyle,
            char_style_id: u32,
            para_style_id: u16,
            cell_para_index: usize,
            char_offset: usize,
            is_para_end: bool,
            advance: f64,
            hft_vertical: bool,
        }

        struct ColumnInfo {
            start_idx: usize,
            end_idx: usize,   // exclusive
            col_width: f64,   // line_height + line_spacing (px), 마지막 칼럼은 line_height만
            col_spacing: f64, // 항상 0 (line_spacing이 col_width에 흡수됨)
            total_height: f64,
            alignment: Alignment,
            absorbed_spacing: f64, // 흡수된 line_spacing (px) — 마지막 칼럼 후처리용
        }

        let get_alignment = |para_style_id: u16| -> Alignment {
            styles
                .para_styles
                .get(para_style_id as usize)
                .map(|s| s.alignment)
                .unwrap_or(Alignment::Left)
        };

        let mut chars: Vec<CharInfo> = Vec::new();
        let mut columns: Vec<ColumnInfo> = Vec::new();

        for (cp_idx, composed) in composed_paras.iter().enumerate() {
            let para = paragraphs.get(cp_idx);
            let alignment = get_alignment(composed.para_style_id);

            if composed.lines.is_empty() {
                // 빈 문단: 빈 열 추가 (개행)
                // 칼럼 너비 = line_height + line_spacing (전체 피치를 칼럼에 흡수)
                let ls = para.and_then(|p| p.line_segs.first());
                let spacing = ls
                    .map(|l| hwpunit_to_px(l.line_spacing, self.dpi))
                    .unwrap_or(0.0);
                columns.push(ColumnInfo {
                    start_idx: chars.len(),
                    end_idx: chars.len(),
                    col_width: ls
                        .map(|l| hwpunit_to_px(l.line_height + l.line_spacing, self.dpi))
                        .unwrap_or(13.0),
                    col_spacing: 0.0,
                    total_height: 0.0,
                    alignment,
                    absorbed_spacing: spacing,
                });
                continue;
            }

            let mut char_offset = 0usize;
            for (line_idx, line) in composed.lines.iter().enumerate() {
                let ls = para.and_then(|p| p.line_segs.get(line_idx));
                // 칼럼 너비 = line_height + line_spacing (전체 피치 흡수)
                // 마지막 칼럼은 후처리로 line_spacing분 제거
                let col_width = ls
                    .map(|l| hwpunit_to_px(l.line_height + l.line_spacing, self.dpi))
                    .unwrap_or(13.0);
                let col_spacing = 0.0;
                let absorbed_spacing = ls
                    .map(|l| hwpunit_to_px(l.line_spacing, self.dpi))
                    .unwrap_or(0.0);

                let col_start = chars.len();
                let mut col_height = 0.0;

                for run in &line.runs {
                    let text_style =
                        resolved_to_text_style(styles, run.char_style_id, run.lang_index);
                    for ch in run.text.chars() {
                        if ch == '\n' || ch == '\r' {
                            char_offset += 1;
                            continue;
                        }
                        let is_rotate = is_vertical_rotate_char(ch);
                        let needs_rotation = is_rotate || (text_direction == 1 && !is_cjk_char(ch));
                        // 세로쓰기에서 구두점/기호만 반칸 advance (영문/숫자는 캐릭터 높이)
                        let half_advance =
                            needs_rotation || (!is_cjk_char(ch) && !ch.is_ascii_alphanumeric());
                        let hft_advance = hft_vertical_advance(&text_style, ch);
                        let advance = hft_advance.unwrap_or_else(|| {
                            if half_advance {
                                text_style.font_size * 0.5
                            } else {
                                text_style.font_size
                            }
                        });
                        chars.push(CharInfo {
                            ch,
                            style: text_style.clone(),
                            char_style_id: run.char_style_id,
                            para_style_id: composed.para_style_id,
                            cell_para_index: cp_idx,
                            char_offset,
                            is_para_end: false,
                            advance,
                            hft_vertical: hft_advance.is_some(),
                        });
                        col_height += advance;
                        char_offset += 1;
                    }
                }

                // 문단의 마지막 줄이면 마지막 글자에 is_para_end 표시
                if line_idx == composed.lines.len() - 1 {
                    if let Some(last) = chars.last_mut() {
                        if last.cell_para_index == cp_idx {
                            last.is_para_end = true;
                        }
                    }
                }

                columns.push(ColumnInfo {
                    start_idx: col_start,
                    end_idx: chars.len(),
                    col_width,
                    col_spacing,
                    total_height: col_height,
                    alignment,
                    absorbed_spacing,
                });
            }
        }

        if chars.is_empty() && columns.iter().all(|c| c.start_idx == c.end_idx) {
            return;
        }

        // 마지막 칼럼은 뒤에 간격이 불필요하므로 흡수된 line_spacing분 제거
        if let Some(last_col) = columns.last_mut() {
            last_col.col_width -= last_col.absorbed_spacing;
        }

        // 2. 열 배치 x좌표 계산 (오른쪽→왼쪽)
        //    total = col[0].w + col[0].s + col[1].w + col[1].s + ... + col[n-1].w
        let total_cols_width: f64 = if columns.is_empty() {
            0.0
        } else {
            columns.iter().map(|c| c.col_width).sum::<f64>()
                + columns[..columns.len() - 1]
                    .iter()
                    .map(|c| c.col_spacing)
                    .sum::<f64>()
        };

        // 열이 셀보다 넓으면 첫 열이 오른쪽 가장자리에서 시작하도록 클램핑
        let right_aligned = inner_area.x + inner_area.width - total_cols_width;
        let cols_x_start = match vertical_align {
            VerticalAlign::Top => right_aligned,
            VerticalAlign::Center => {
                let centered = inner_area.x + (inner_area.width - total_cols_width) / 2.0;
                centered.min(right_aligned)
            }
            VerticalAlign::Bottom => inner_area.x.min(right_aligned),
        };

        // 3. 각 글자를 TextLine + TextRun 노드로 생성
        let mut col_x = cols_x_start + total_cols_width;

        for (col_idx, col) in columns.iter().enumerate() {
            col_x -= col.col_width;
            let hft_vertical = chars[col.start_idx..col.end_idx]
                .iter()
                .all(|ci| ci.hft_vertical);

            // HFT의 세로 기준점은 실제 글자 전진의 합으로 중앙에 놓인다.
            // 일반 글꼴은 저장 줄 상자(글자 높이+줄간격)를 사용한다.
            let n_chars = col.end_idx.saturating_sub(col.start_idx) as f64;
            let valign_height = if hft_vertical {
                col.total_height
            } else {
                col.total_height + n_chars * col.absorbed_spacing
            };
            let free_space = (inner_area.height - valign_height).max(0.0);
            let y_start = inner_area.y
                + match col.alignment {
                    Alignment::Center | Alignment::Distribute => free_space / 2.0,
                    Alignment::Right => free_space,
                    _ => 0.0,
                };
            let mut char_y = y_start;
            let col_bottom = inner_area.y + inner_area.height;

            for i in col.start_idx..col.end_idx {
                let ci = &chars[i];
                let is_rotate = is_vertical_rotate_char(ci.ch);
                let needs_rotation = is_rotate || (text_direction == 1 && !is_cjk_char(ci.ch));
                // 세로쓰기에서 구두점/기호만 반칸 advance (영문/숫자는 캐릭터 높이)
                let advance = ci.advance;
                let baseline = if hft_vertical {
                    advance
                } else {
                    advance * 0.85
                };
                let char_top = if hft_vertical {
                    char_y - advance
                } else {
                    char_y
                };

                // 열 높이 초과 시 렌더링 중단
                if char_y + advance > col_bottom + 0.5 {
                    break;
                }

                // 칼럼 피치에 흡수된 줄간격은 다음 칼럼 쪽(왼쪽)에 둔다.
                // 글자를 피치 전체의 중앙에 놓으면 여러 칼럼에서 오른쪽
                // 글자까지 줄간격의 절반만큼 왼쪽으로 밀린다.
                let char_width = ci.style.font_size;
                let leading_spacing = if col_idx + 1 == columns.len() {
                    0.0
                } else {
                    col.absorbed_spacing
                };
                let visual_width = col.col_width - leading_spacing;
                let mut char_x = col_x + leading_spacing + (visual_width - char_width) / 2.0;
                if hft_vertical {
                    // HFT 라틴 기준점은 em 하단의 0.15em 위에 있다. 한글은
                    // 0.05em 합성 굵게의 추가 폭까지 포함해 열 중앙에 둔다.
                    char_x += ci.style.font_size * if is_cjk_char(ci.ch) { -0.025 } else { 0.15 };
                }
                // 기호 대체: 세로 형태 Unicode가 있으면 대체 문자를 사용 (회전 불필요)
                let (render_ch, rotation) = if hft_vertical {
                    (ci.ch, 0.0)
                } else if needs_rotation {
                    if let Some(sub) = vertical_substitute_char(ci.ch) {
                        (sub, 0.0)
                    } else {
                        (ci.ch, 90.0)
                    }
                } else {
                    (ci.ch, 0.0)
                };

                let line_id = tree.next_id();
                let mut line_node = RenderNode::new(
                    line_id,
                    RenderNodeType::TextLine(TextLineNode::new(advance, baseline)),
                    BoundingBox::new(char_x, char_top, char_width, advance),
                );

                let run_id = tree.next_id();
                let run_node = RenderNode::new(
                    run_id,
                    RenderNodeType::TextRun(TextRunNode {
                        text: render_ch.to_string(),
                        style: ci.style.clone(),
                        char_shape_id: Some(ci.char_style_id),
                        para_shape_id: Some(ci.para_style_id),
                        section_index: Some(section_index),
                        para_index: Some(ci.cell_para_index),
                        char_start: Some(ci.char_offset),
                        cell_context: if let Some(ref ctx) = enclosing_cell_ctx {
                            let mut new_ctx = ctx.clone();
                            if let Some(last) = new_ctx.path.last_mut() {
                                last.cell_index = cell_idx;
                                last.cell_para_index = ci.cell_para_index;
                            }
                            Some(new_ctx)
                        } else {
                            table_meta.map(|(pi, ctrl_ci)| CellContext {
                                parent_para_index: pi,
                                path: vec![CellPathEntry {
                                    control_index: ctrl_ci,
                                    cell_index: cell_idx,
                                    cell_para_index: ci.cell_para_index,
                                    text_direction: 0,
                                    line_wrap_squeeze: false,
                                    row_span: 1,
                                }],
                            })
                        },
                        is_para_end: ci.is_para_end,
                        is_line_break_end: false,
                        rotation,
                        is_vertical: true,
                        char_overlap: None,
                        border_fill_id: styles
                            .char_styles
                            .get(ci.char_style_id as usize)
                            .map(|cs| cs.border_fill_id)
                            .unwrap_or(0),
                        baseline,
                        field_marker: FieldMarkerType::None,
                        display_text: None,
                    }),
                    BoundingBox::new(char_x, char_top, char_width, advance),
                );

                line_node.children.push(run_node);
                cell_node.children.push(line_node);

                char_y += advance;
            }

            col_x -= col.col_spacing;
        }
    }

    /// 테이블 셀 내 도형(Shape) 컨트롤을 레이아웃한다.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn layout_cell_shape(
        &self,
        tree: &mut PageRenderTree,
        cell_node: &mut RenderNode,
        shape: &crate::model::shape::ShapeObject,
        inner_area: &LayoutRect,
        para_y: f64,
        para_alignment: Alignment,
        styles: &ResolvedStyleSet,
        bin_data_content: &[BinDataContent],
        clamp_header_negative_para_offset: bool,
        // [Task #1138] 표 셀 컨텍스트: (section_idx, outer_para_idx, outer_table_ctrl_idx, cell_idx, cell_para_idx, inner_control_idx)
        table_cell_ctx: Option<(usize, usize, usize, usize, usize, usize)>,
        cell_context: Option<&CellContext>,
    ) {
        let child_common = shape.common();

        let child_w = hwpunit_to_px(child_common.width as i32, self.dpi);
        let child_h = hwpunit_to_px(child_common.height as i32, self.dpi);

        let (child_x, child_y) = if child_common.treat_as_char {
            // 인라인: 문단 정렬에 따라 배치
            let x = match para_alignment {
                Alignment::Center | Alignment::Distribute => {
                    inner_area.x + (inner_area.width - child_w).max(0.0) / 2.0
                }
                Alignment::Right => inner_area.x + (inner_area.width - child_w).max(0.0),
                _ => inner_area.x,
            };
            (x, para_y)
        } else {
            // 셀 내 비-TAC 도형: horz_align/vert_align 속성 기반 배치
            use crate::model::shape::{HorzAlign, VertAlign, VertRelTo};
            let h_offset = hwpunit_to_px(child_common.horizontal_offset as i32, self.dpi);
            let mut vertical_offset = child_common.vertical_offset as i32;
            // 한컴은 머리말 안의 문단 기준 글상자에서 음수 `문단 내 위`를 0처럼 배치한다.
            if clamp_header_negative_para_offset
                && matches!(child_common.vert_rel_to, VertRelTo::Para)
                && matches!(child_common.vert_align, VertAlign::Top | VertAlign::Inside)
                && vertical_offset < 0
            {
                vertical_offset = 0;
            }
            let v_offset = hwpunit_to_px(vertical_offset, self.dpi);
            let x = match child_common.horz_align {
                HorzAlign::Right | HorzAlign::Outside => {
                    inner_area.x + inner_area.width - child_w - h_offset
                }
                HorzAlign::Center => inner_area.x + (inner_area.width - child_w) / 2.0 + h_offset,
                _ => inner_area.x + h_offset,
            };
            let (ref_y, ref_h) = if matches!(child_common.vert_rel_to, VertRelTo::Para) {
                (para_y, (inner_area.y + inner_area.height - para_y).max(0.0))
            } else {
                (inner_area.y, inner_area.height)
            };
            let y = match child_common.vert_align {
                VertAlign::Bottom | VertAlign::Outside => ref_y + ref_h - child_h - v_offset,
                VertAlign::Center => ref_y + (ref_h - child_h) / 2.0 + v_offset,
                _ => ref_y + v_offset,
            };
            (x, y)
        };

        let empty_map = std::collections::HashMap::new();
        // [Task #1138] table_cell_ctx 가 Some 일 때 layout_shape_object 에
        // section_index/outer_para_idx/inner_control_idx 를 셀 컨텍스트에서 추출하여 전달.
        let (sec_idx, outer_para_idx, inner_ctrl_idx, shape_table_cell_ref) = match table_cell_ctx {
            Some((sec, outer_para, outer_table_ci, cell_i, cell_para_i, inner_ci)) => (
                sec,
                outer_para,
                inner_ci,
                Some((cell_i, cell_para_i, outer_table_ci)),
            ),
            None => (0, 0, 0, None),
        };
        // 셀 개체의 글상자에도 바깥 표 경로를 전달한다.
        let parent_cell_path = cell_context
            .map(|context| context.path.as_slice())
            .unwrap_or(&[]);
        let children_start = cell_node.children.len();
        self.layout_shape_object(
            tree,
            cell_node,
            shape,
            child_x,
            child_y,
            child_w,
            child_h,
            sec_idx,
            cell_context
                .map(|context| context.parent_para_index)
                .unwrap_or(outer_para_idx),
            inner_ctrl_idx,
            styles,
            bin_data_content,
            &empty_map,
            parent_cell_path,
            shape_table_cell_ref,
            false,
        );
        // 셀 안 비인라인(글앞으로/글뒤로 등) 도형에도 본문과 같은 렌더 레이어
        // (text_wrap 페인트 평면 + z_order)를 부여한다. 레이어가 없으면 도형이
        // 플로우 컨텐츠와 문서 순서로 칠해져, 컨트롤 순서가 뒤인 셀 인라인 그림이
        // 글앞으로 도형 위를 덮는다 (본문 경로 layout.rs 의 set_layer 후처리와 동일).
        if !child_common.treat_as_char {
            let layer =
                Self::render_layer_from_common(child_common, outer_para_idx, inner_ctrl_idx);
            for child in &mut cell_node.children[children_start..] {
                child.set_layer(layer);
            }
        }
    }

    /// TextBox 내부에 포함된 표를 레이아웃한다.
    /// enclosing_ctx: (section_index, body_para_index, 상위 경로, 표의 컨트롤 인덱스)
    pub(crate) fn layout_embedded_table(
        &self,
        tree: &mut PageRenderTree,
        parent: &mut RenderNode,
        table: &crate::model::table::Table,
        styles: &ResolvedStyleSet,
        container: &LayoutRect,
        y_start: f64,
        enclosing_ctx: Option<(usize, usize, &[CellPathEntry], usize)>,
        bin_data_content: &[BinDataContent],
        host_alignment: Alignment,
    ) -> f64 {
        if table.cells.is_empty() {
            return y_start;
        }

        let col_count = table.col_count as usize;
        let row_count = table.row_count as usize;
        let cell_spacing = hwpunit_to_px(table.cell_spacing as i32, self.dpi);

        // 글상자 안에서도 일반 표와 같은 병합 셀 제약을 사용한다. 미지 열을
        // container 균등폭으로 채우면 반복 본문 행의 저장 폭보다 머리 행이 우선되어
        // 모든 내부 세로선이 이동한다.
        let mut col_widths = self.resolve_column_widths(table, col_count);

        // 글상자 내부 표: 셀 너비 합이 컨테이너 폭을 초과하면 비례 축소
        let col_sum: f64 = col_widths.iter().sum();
        let max_w = {
            let common_w = hwpunit_to_px(table.common.width as i32, self.dpi);
            if common_w > 0.0 && common_w < container.width {
                common_w
            } else {
                container.width
            }
        };
        if col_sum > max_w + 1.0 {
            let scale = max_w / col_sum;
            for w in &mut col_widths {
                *w *= scale;
            }
        }

        // 행 높이 계산 (layout_table과 동일한 resolve_row_heights 사용)
        let row_heights = self.resolve_row_heights(table, col_count, row_count, None, styles, true);

        // 누적 위치 계산
        let mut col_x = vec![0.0f64; col_count + 1];
        for i in 0..col_count {
            col_x[i + 1] =
                col_x[i] + col_widths[i] + if i + 1 < col_count { cell_spacing } else { 0.0 };
        }
        let mut row_y = vec![0.0f64; row_count + 1];
        for i in 0..row_count {
            row_y[i + 1] =
                row_y[i] + row_heights[i] + if i + 1 < row_count { cell_spacing } else { 0.0 };
        }

        // 행별 열 위치 계산 (셀별 독립 너비 지원)
        let row_col_x = build_row_col_x(
            table,
            &col_widths,
            col_count,
            row_count,
            cell_spacing,
            self.dpi,
            self.render_table_width_scale(table),
        );

        let table_width = row_col_x
            .iter()
            .map(|rx| rx.last().copied().unwrap_or(0.0))
            .fold(col_x.last().copied().unwrap_or(0.0), f64::max);
        let table_height = row_y.last().copied().unwrap_or(0.0);
        // TAC 표: 호스트 문단 정렬에 따라 배치
        let table_x = match host_alignment {
            Alignment::Center | Alignment::Distribute => {
                container.x + (container.width - table_width).max(0.0) / 2.0
            }
            Alignment::Right => container.x + (container.width - table_width).max(0.0),
            _ => container.x, // 왼쪽 정렬 (기본)
        };
        let table_y = y_start;

        // 엣지 기반 테두리 수집을 위한 그리드 생성
        use crate::model::style::BorderLine;
        let mut h_edges: Vec<Vec<Option<BorderLine>>> = vec![vec![None; col_count]; row_count + 1];
        let mut v_edges: Vec<Vec<Option<BorderLine>>> = vec![vec![None; row_count]; col_count + 1];

        // 표 노드 생성
        let table_id = tree.next_id();
        let mut table_node = RenderNode::new(
            table_id,
            RenderNodeType::Table(TableNode {
                row_count: table.row_count,
                col_count: table.col_count,
                border_fill_id: table.border_fill_id,
                section_index: None,
                para_index: None,
                control_index: None,
            }),
            BoundingBox::new(table_x, table_y, table_width, table_height),
        );

        // 표 배경 렌더링 (표 > 배경 > 색 > 면색)
        if table.border_fill_id > 0 {
            let tbl_idx = (table.border_fill_id as usize).saturating_sub(1);
            if let Some(tbl_bs) = styles.border_styles.get(tbl_idx) {
                self.render_cell_background(
                    tree,
                    &mut table_node,
                    Some(tbl_bs),
                    table_x,
                    table_y,
                    table_width,
                    table_height,
                    bin_data_content,
                );
            }
        }

        // 각 셀 레이아웃
        for (cell_enum_idx, cell) in table.cells.iter().enumerate() {
            let c = cell.col as usize;
            let r = cell.row as usize;
            if c >= col_count || r >= row_count {
                continue;
            }

            let rcx = &row_col_x[r];
            let cell_x = table_x + rcx[c];
            let cell_y = table_y + row_y[r];
            let end_col = (c + cell.col_span as usize).min(col_count);
            let end_row = (r + cell.row_span as usize).min(row_count);
            let cell_w = rcx[end_col] - rcx[c];
            let cell_h = row_y[end_row] - row_y[r];

            let cell_id = tree.next_id();
            let mut cell_node = RenderNode::new(
                cell_id,
                RenderNodeType::TableCell(TableCellNode {
                    col: cell.col,
                    row: cell.row,
                    col_span: cell.col_span,
                    row_span: cell.row_span,
                    border_fill_id: cell.border_fill_id,
                    text_direction: cell.text_direction,
                    clip: false,
                    model_cell_index: Some(cell_enum_idx as u32),
                }),
                BoundingBox::new(cell_x, cell_y, cell_w, cell_h),
            );

            // 셀 BorderFill
            let border_style = if cell.border_fill_id > 0 {
                let idx = (cell.border_fill_id as usize).saturating_sub(1);
                styles.border_styles.get(idx)
            } else {
                None
            };

            // 셀 배경
            let fill_color = border_style.and_then(|bs| bs.fill_color);
            let gradient = border_style.and_then(|bs| bs.gradient.clone());
            if fill_color.is_some() || gradient.is_some() {
                let rect_id = tree.next_id();
                let rect_node = RenderNode::new(
                    rect_id,
                    RenderNodeType::Rectangle(RectangleNode::new(
                        0.0,
                        ShapeStyle {
                            fill_color,
                            stroke_color: None,
                            stroke_width: 0.0,
                            ..Default::default()
                        },
                        gradient,
                    )),
                    BoundingBox::new(cell_x, cell_y, cell_w, cell_h),
                );
                cell_node.children.push(rect_node);
            }

            // 셀 테두리를 엣지 그리드에 수집
            if let Some(bs) = border_style {
                collect_cell_borders(
                    &mut h_edges,
                    &mut v_edges,
                    c,
                    r,
                    cell.col_span as usize,
                    cell.row_span as usize,
                    &bs.borders,
                );
            }

            // 셀 패딩 (apply_inner_margin 고려)
            let (mut pad_left, mut pad_right, pad_top, pad_bottom) =
                self.resolve_cell_padding(cell, table);

            // 셀 내 문단 레이아웃
            let composed_paras: Vec<_> = cell
                .paragraphs
                .iter()
                .map(|p| compose_paragraph(p))
                .collect();

            // 텍스트 오버플로우 시 좌우 패딩 축소
            // SQUEEZE 셀은 좌우 여백을 1mm(284hu)까지만 줄인다 (압축 존 확보).
            let min_pad = if cell.line_wrap == crate::model::table::CellLineWrap::Squeeze {
                hwpunit_to_px(284, self.dpi)
            } else {
                1.0
            };
            let (new_pl, new_pr) = self.shrink_cell_padding_for_overflow(
                pad_left,
                pad_right,
                cell_w,
                &composed_paras,
                &cell.paragraphs,
                styles,
                cell.apply_inner_margin,
                min_pad,
            );
            pad_left = new_pl;
            pad_right = new_pr;

            let inner_x = cell_x + pad_left;
            let inner_width = (cell_w - pad_left - pad_right).max(0.0);
            let inner_height = (cell_h - pad_top - pad_bottom).max(0.0);
            let has_nested = cell
                .paragraphs
                .iter()
                .any(|p| p.controls.iter().any(|c| matches!(c, Control::Table(_))));
            let total_content_height = if has_nested {
                let last_seg_end: i32 = cell
                    .paragraphs
                    .iter()
                    .flat_map(|p| p.line_segs.last())
                    .map(|s| s.vertical_pos + s.line_height)
                    .max()
                    .unwrap_or(0);
                hwpunit_to_px(last_seg_end, self.dpi)
                    .max(self.calc_composed_paras_content_height(
                        &composed_paras,
                        &cell.paragraphs,
                        styles,
                    ))
                    .max(
                        self.calc_nested_controls_bottom_height(
                            &cell.paragraphs,
                            styles,
                            (self.profile.get().native_hwpx_cell_margin()
                                && cell.text_direction == 0
                                && cell.line_wrap == crate::model::table::CellLineWrap::Break)
                                .then_some(inner_width),
                        ),
                    )
            } else {
                self.calc_composed_paras_content_height(&composed_paras, &cell.paragraphs, styles)
            };
            let text_y_start = cell_y
                + super::table_layout::cell_valign_top_offset(
                    cell.vertical_align,
                    cell_h,
                    pad_top,
                    pad_bottom,
                    total_content_height,
                );
            let inner_area = LayoutRect {
                x: inner_x,
                y: text_y_start,
                width: inner_width,
                height: inner_height,
            };

            let mut para_y = text_y_start;
            let para_count = composed_paras.len();
            let cell_idx = cell_enum_idx;
            for (pidx, (composed, para)) in composed_paras
                .iter()
                .zip(cell.paragraphs.iter())
                .enumerate()
            {
                // enclosing context가 있으면 글상자 경로 + 표 셀 경로를 합성
                let cell_ctx = enclosing_ctx.map(|(sec_idx, para_idx, parent_path, table_ci)| {
                    let mut path = parent_path.to_vec();
                    path.push(CellPathEntry {
                        control_index: table_ci,
                        cell_index: cell_idx,
                        cell_para_index: pidx,
                        text_direction: cell.text_direction,
                        line_wrap_squeeze: cell.line_wrap
                            == crate::model::table::CellLineWrap::Squeeze,
                        row_span: cell.row_span,
                    });
                    (
                        sec_idx,
                        para_idx,
                        CellContext {
                            parent_para_index: para_idx,
                            path,
                        },
                    )
                });
                let (sec_for_layout, para_for_layout, ctx) = match cell_ctx {
                    Some((s, p, c)) => (s, pidx, Some(c)),
                    None => (0, 0, None),
                };
                let numbered_comp = self.apply_paragraph_numbering(Some(composed), para, styles, 0);
                let composed_for_layout = numbered_comp.as_ref().unwrap_or(composed);
                para_y = self.layout_composed_paragraph(
                    tree,
                    &mut cell_node,
                    composed_for_layout,
                    styles,
                    &inner_area,
                    para_y,
                    0,
                    composed.lines.len(),
                    sec_for_layout,
                    para_for_layout,
                    ctx,
                    !matches!(cell.vertical_align, VerticalAlign::Top),
                    pidx + 1 == para_count,
                    0.0,
                    None,
                    Some(para),
                    None,
                    None, // 셀 컨텍스트 — wrap zone 무관
                );

                // 셀 내 그림/도형 컨트롤 렌더링
                for (ctrl_idx, ctrl) in para.controls.iter().enumerate() {
                    match ctrl {
                        Control::Picture(pic) => {
                            let pic_w = hwpunit_to_px(pic.common.width as i32, self.dpi);
                            let pic_h = hwpunit_to_px(pic.common.height as i32, self.dpi);
                            let (margin_left, margin_right, margin_top) =
                                if pic.common.treat_as_char {
                                    (
                                        hwpunit_to_px(pic.common.margin.left as i32, self.dpi),
                                        hwpunit_to_px(pic.common.margin.right as i32, self.dpi),
                                        hwpunit_to_px(pic.common.margin.top as i32, self.dpi),
                                    )
                                } else {
                                    (0.0, 0.0, 0.0)
                                };
                            // 셀보다 넓은 그림도 원래 크기로 넘겨 그린다 (table_layout 과
                            // 같은 한컴 규칙).
                            let (fit_w, fit_h) = (pic_w, pic_h);
                            // TAC: 문단 시작 위치 (표의 왼쪽 상단)
                            let pic_x = inner_x + margin_left;
                            // vpos 기반 y 위치: LINE_SEG의 vertical_pos 사용
                            let pic_y = if let Some(first_ls) = para.line_segs.first() {
                                cell_y + pad_top + hwpunit_to_px(first_ls.vertical_pos, self.dpi)
                            } else {
                                para_y - fit_h
                            } + margin_top;

                            let bin_id = pic.image_attr.bin_data_id;
                            let img_data = find_bin_data(bin_data_content, bin_id)
                                .map(|bd| bd.data.load_shared());
                            let img_node_id = tree.next_id();
                            // [Task #1151 v4] 셀 안 inline picture 의 cell context + outer
                            // 정보 보존. rendering.rs:1495 의 Image JSON 직렬화 에 cellIdx/
                            // cellParaIdx 노출 → studio findPictureAtClick / cursor_rect hit-test
                            // 가 인식. enclosing_ctx 에서 section / outer paragraph / outer table
                            // control 인덱스 추출. ctrl_idx 는 셀 paragraph 안의 picture 인덱스.
                            // [Task #1161] 전체 다단계 경로(중첩 표 포함)를 먼저 구성해
                            // ImageNode.cell_context 와 inline_shape_position 등록에 공유.
                            // 단일 레벨 스칼라(cell_index/cell_para_index/outer_table_control_index)
                            // 는 이 경로의 innermost 투영으로 유지(하위호환).
                            let cell_ctx =
                                enclosing_ctx.map(|(_, outer_pi, parent_path, table_ci)| {
                                    let mut path = parent_path.to_vec();
                                    path.push(CellPathEntry {
                                        control_index: table_ci,
                                        cell_index: cell_idx,
                                        cell_para_index: pidx,
                                        text_direction: cell.text_direction,
                                        line_wrap_squeeze: cell.line_wrap
                                            == crate::model::table::CellLineWrap::Squeeze,
                                        row_span: cell.row_span,
                                    });
                                    CellContext {
                                        parent_para_index: outer_pi,
                                        path,
                                    }
                                });
                            let img_node = RenderNode::new(
                                img_node_id,
                                RenderNodeType::Image(ImageNode {
                                    bin_data_id: bin_id,
                                    data: img_data,
                                    section_index: enclosing_ctx.map(|(s, _, _, _)| s),
                                    para_index: enclosing_ctx.map(|(_, p, _, _)| p),
                                    control_index: Some(ctrl_idx),
                                    fill_mode: None,
                                    original_size: None,
                                    transform: extract_shape_transform(&pic.shape_attr),
                                    crop: None,
                                    original_size_hu: None,
                                    effect: pic.image_attr.effect,
                                    brightness: pic.image_attr.brightness,
                                    contrast: pic.image_attr.contrast,
                                    opacity: pic.image_attr.opacity(),
                                    shadow: crate::renderer::render_tree::ImageShadow::from_picture(
                                        pic, self.dpi,
                                    ),
                                    text_wrap: None,
                                    external_path: pic.image_attr.external_path.clone(),
                                    header_footer_ref: None,
                                    cell_index: Some(cell_idx),
                                    cell_para_index: Some(pidx),
                                    outer_table_control_index: enclosing_ctx
                                        .map(|(_, _, _, table_ci)| table_ci),
                                    cell_context: cell_ctx.clone(),
                                }),
                                BoundingBox::new(pic_x, pic_y, fit_w, fit_h),
                            );
                            cell_node.children.push(img_node);
                            // [Task #1151 v4] 셀 안 inline picture 의 위치를 inline_shape_positions
                            // 에 등록. cursor_rect.rs 의 hit-test 루프가 이 등록 없이는 picture 클릭을
                            // 인식하지 못해 (키보드 입력으로 paragraph_layout 의 다른 path 가 등록할
                            // 때까지) 첫 클릭 무반응. enclosing_ctx 가 Some 인 경우만 (셀 컨텍스트 있음).
                            if let (Some((sec_idx, outer_pi, _, _)), Some(cell_ctx)) =
                                (enclosing_ctx, cell_ctx.as_ref())
                            {
                                tree.set_inline_shape_position(
                                    sec_idx,
                                    outer_pi,
                                    ctrl_idx,
                                    Some(cell_ctx),
                                    pic_x,
                                    pic_y,
                                );
                            }
                        }
                        _ => {}
                    }
                }
            }

            cell_node.children.sort_by_key(Self::paper_node_sort_key);
            table_node.children.push(cell_node);
            if let Some(bs) = border_style {
                table_node.children.extend(render_cell_diagonal(
                    tree, bs, cell_x, cell_y, cell_w, cell_h,
                ));
            }
        }

        collect_zone_borders(
            &mut h_edges,
            &mut v_edges,
            table,
            &styles.border_styles,
            None,
            None,
        );

        // 엣지 기반 테두리 렌더링
        table_node
            .children
            .extend(super::border_rendering::render_edge_borders_with_policy(
                tree,
                &h_edges,
                &v_edges,
                &row_col_x,
                &row_y,
                table_x,
                table_y,
                super::border_rendering::mac_print_double_policy(
                    table,
                    styles,
                    self.profile.get().native_hwpx_cell_margin(),
                    self.dpi,
                    true,
                ),
            ));
        if self.show_transparent_borders.get() {
            table_node.children.extend(render_transparent_borders(
                tree, &h_edges, &v_edges, &row_col_x, &row_y, table_x, table_y,
            ));
        }

        parent.children.push(table_node);
        table_y + table_height
    }
}

#[cfg(test)]
mod cell_paint_order_tests {
    use super::*;
    use crate::model::shape::{CommonObjAttr, RectangleShape, ShapeObject, TextWrap};
    use crate::model::table::{Cell, Table, TablePageBreak};

    #[test]
    fn cell_alignment_includes_para_flow_holders_in_both_paint_planes() {
        use crate::model::paragraph::LineSeg;
        use crate::model::shape::VertRelTo;
        use crate::model::table::VerticalAlign;
        fn anchor(node: &RenderNode) -> Option<BoundingBox> {
            if let RenderNodeType::TextRun(run) = &node.node_type {
                if run.text == "anchor" {
                    return Some(node.bbox);
                }
            }
            node.children.iter().find_map(anchor)
        }
        let engine = LayoutEngine::new(96.0);
        let styles = ResolvedStyleSet {
            char_styles: vec![crate::renderer::style_resolver::ResolvedCharStyle {
                font_size: 16.0,
                ..Default::default()
            }],
            para_styles: vec![crate::renderer::style_resolver::ResolvedParaStyle {
                line_spacing: 100.0,
                ..Default::default()
            }],
            ..Default::default()
        };
        let area = LayoutRect {
            x: 0.0,
            y: 0.0,
            width: 500.0,
            height: 800.0,
        };
        for partial in [false, true] {
            for (authored, later_paragraph) in [(false, false), (true, false), (false, true)] {
                for text_wrap in [TextWrap::InFrontOfText, TextWrap::BehindText] {
                    for (flow_with_text, vert_rel_to, eligible) in [
                        (true, VertRelTo::Para, true),
                        (false, VertRelTo::Para, false),
                        (true, VertRelTo::Page, false),
                    ] {
                        let mut positions = Vec::new();
                        for vertical_align in [
                            VerticalAlign::Top,
                            VerticalAlign::Center,
                            VerticalAlign::Bottom,
                        ] {
                            let control =
                                Control::Shape(Box::new(ShapeObject::Rectangle(RectangleShape {
                                    common: CommonObjAttr {
                                        width: 750,
                                        height: 3_000,
                                        vertical_offset: 1_500,
                                        flow_with_text,
                                        vert_rel_to,
                                        text_wrap,
                                        allow_overlap: true,
                                        ..Default::default()
                                    },
                                    ..Default::default()
                                })));
                            let mut table = Table {
                                row_count: 1,
                                col_count: 1,
                                page_break: TablePageBreak::RowBreak,
                                common: CommonObjAttr {
                                    width: 15_000,
                                    height: 7_500,
                                    treat_as_char: true,
                                    ..Default::default()
                                },
                                cells: vec![Cell {
                                    row_span: 1,
                                    col_span: 1,
                                    width: 15_000,
                                    height: 7_500,
                                    vertical_align,
                                    paragraphs: vec![Paragraph {
                                        text: "anchor".into(),
                                        controls: vec![control],
                                        line_segs: if authored {
                                            vec![LineSeg {
                                                line_height: 1_200,
                                                text_height: 1_200,
                                                baseline_distance: 1_020,
                                                segment_width: 15_000,
                                                ..Default::default()
                                            }]
                                        } else {
                                            vec![]
                                        },
                                        ..Default::default()
                                    }],
                                    ..Default::default()
                                }],
                                ..Default::default()
                            };
                            if later_paragraph {
                                table.cells[0].paragraphs.insert(
                                    0,
                                    Paragraph {
                                        text: "lead".into(),
                                        ..Default::default()
                                    },
                                );
                            }
                            let mut tree = PageRenderTree::new(0, 800.0, 1100.0);
                            let mut parent = RenderNode::new(
                                tree.next_id(),
                                RenderNodeType::Column(0),
                                BoundingBox::new(0.0, 0.0, 500.0, 800.0),
                            );
                            if partial {
                                let paragraphs = vec![Paragraph {
                                    controls: vec![Control::Table(Box::new(table))],
                                    ..Default::default()
                                }];
                                engine.layout_partial_table(
                                    &mut tree,
                                    &mut parent,
                                    &paragraphs,
                                    0,
                                    0,
                                    0,
                                    &styles,
                                    0,
                                    &area,
                                    0.0,
                                    &[],
                                    0,
                                    1,
                                    false,
                                    &[],
                                    &[],
                                    false,
                                    0.0,
                                    0.0,
                                    None,
                                    false,
                                    None,
                                    &[],
                                );
                            } else {
                                engine.layout_table(
                                    &mut tree,
                                    &mut parent,
                                    &table,
                                    0,
                                    &styles,
                                    0,
                                    &area,
                                    0.0,
                                    &[],
                                    None,
                                    0,
                                    Some((0, 0)),
                                    Alignment::Left,
                                    None,
                                    0.0,
                                    0.0,
                                    None,
                                    None,
                                    None,
                                    false,
                                    false,
                                    false,
                                );
                            }
                            positions.push(anchor(&parent).expect("cell anchor"));
                        }
                        let used_height = if later_paragraph {
                            32.0
                        } else if eligible {
                            60.0
                        } else {
                            16.0
                        };
                        for (index, factor) in [(1, 0.5), (2, 1.0)] {
                            let expected = (100.0 - used_height) * factor;
                            assert!((positions[index].y - positions[0].y - expected).abs() < 0.5,
                                "partial={partial}, authored={authored}, later={later_paragraph}, wrap={text_wrap:?}, flow={flow_with_text}, rel={vert_rel_to:?}, positions={positions:?}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn fresh_cell_textboxes_wrap_at_inner_width_and_align_the_whole_list() {
        use crate::model::table::VerticalAlign;
        fn text_lines(node: &RenderNode, in_textbox: bool, result: &mut Vec<BoundingBox>) {
            let in_textbox = in_textbox || matches!(node.node_type, RenderNodeType::TextBox);
            if in_textbox && matches!(node.node_type, RenderNodeType::TextLine(_)) {
                result.push(node.bbox);
            }
            for child in &node.children {
                text_lines(child, in_textbox, result);
            }
        }
        fn check_visible_bold_runs(node: &RenderNode, in_textbox: bool) {
            let in_textbox = in_textbox || matches!(node.node_type, RenderNodeType::TextBox);
            if let RenderNodeType::TextRun(run) = &node.node_type {
                if in_textbox && !run.text.trim().is_empty() {
                    assert!(run.style.bold, "{}", run.text);
                }
            }
            for child in &node.children {
                check_visible_bold_runs(child, in_textbox);
            }
        }
        let styles = ResolvedStyleSet {
            char_styles: vec![
                crate::renderer::style_resolver::ResolvedCharStyle {
                    font_size: 12.0,
                    ..Default::default()
                },
                crate::renderer::style_resolver::ResolvedCharStyle {
                    font_size: 12.0,
                    bold: true,
                    ..Default::default()
                },
            ],
            para_styles: vec![crate::renderer::style_resolver::ResolvedParaStyle {
                line_spacing: 125.0,
                ..Default::default()
            }],
            ..Default::default()
        };
        let engine = LayoutEngine::new(96.0);
        let area = LayoutRect {
            x: 0.0,
            y: 0.0,
            width: 500.0,
            height: 800.0,
        };
        for partial in [false, true] {
            for (explicit_break, grouped) in [(false, false), (true, false), (false, true)] {
                let mut positions = Vec::new();
                for vertical_align in [
                    VerticalAlign::Top,
                    VerticalAlign::Center,
                    VerticalAlign::Bottom,
                ] {
                    let shape = ShapeObject::Rectangle(RectangleShape {
                        common: CommonObjAttr {
                            width: 6_000,
                            height: 7_500,
                            ..Default::default()
                        },
                        drawing: crate::model::shape::DrawingObjAttr {
                            shape_attr: crate::model::shape::ShapeComponentAttr {
                                group_level: if grouped { 1 } else { 0 },
                                original_width: 6_000,
                                original_height: 7_500,
                                ..Default::default()
                            },
                            text_box: Some(crate::model::shape::TextBox {
                                vertical_align,
                                paragraphs: if grouped {
                                    vec!["  first", "  second", "  third"]
                                } else {
                                    vec![
                                        "가나다라마바사아자차카타",
                                        if explicit_break { "끝\n말" } else { "끝" },
                                    ]
                                }
                                .into_iter()
                                .map(|text| Paragraph {
                                    text: text.into(),
                                    char_shapes: if grouped {
                                        vec![
                                            crate::model::paragraph::CharShapeRef::default(),
                                            crate::model::paragraph::CharShapeRef {
                                                start_pos: 2,
                                                char_shape_id: 1,
                                            },
                                        ]
                                    } else {
                                        vec![]
                                    },
                                    ..Default::default()
                                })
                                .collect(),
                                ..Default::default()
                            }),
                            ..Default::default()
                        },
                        ..Default::default()
                    });
                    let shape = if grouped {
                        ShapeObject::Group(crate::model::shape::GroupShape {
                            common: CommonObjAttr {
                                width: 6_000,
                                height: 7_500,
                                ..Default::default()
                            },
                            children: vec![shape],
                            ..Default::default()
                        })
                    } else {
                        shape
                    };
                    let table = Table {
                        row_count: 1,
                        col_count: 1,
                        page_break: TablePageBreak::RowBreak,
                        common: CommonObjAttr {
                            width: 15_000,
                            height: 15_000,
                            treat_as_char: true,
                            ..Default::default()
                        },
                        cells: vec![Cell {
                            row_span: 1,
                            col_span: 1,
                            width: 15_000,
                            height: 15_000,
                            paragraphs: vec![Paragraph {
                                text: "anchor".into(),
                                controls: vec![Control::Shape(Box::new(shape))],
                                ..Default::default()
                            }],
                            ..Default::default()
                        }],
                        ..Default::default()
                    };
                    let mut tree = PageRenderTree::new(0, 800.0, 1100.0);
                    let mut parent = RenderNode::new(
                        tree.next_id(),
                        RenderNodeType::Column(0),
                        BoundingBox::new(0.0, 0.0, 500.0, 800.0),
                    );
                    if partial {
                        let paragraphs = vec![Paragraph {
                            controls: vec![Control::Table(Box::new(table))],
                            ..Default::default()
                        }];
                        engine.layout_partial_table(
                            &mut tree,
                            &mut parent,
                            &paragraphs,
                            0,
                            0,
                            0,
                            &styles,
                            0,
                            &area,
                            0.0,
                            &[],
                            0,
                            1,
                            false,
                            &[],
                            &[],
                            false,
                            0.0,
                            0.0,
                            None,
                            false,
                            None,
                            &[],
                        );
                    } else {
                        engine.layout_table(
                            &mut tree,
                            &mut parent,
                            &table,
                            0,
                            &styles,
                            0,
                            &area,
                            0.0,
                            &[],
                            None,
                            0,
                            Some((0, 0)),
                            Alignment::Left,
                            None,
                            0.0,
                            0.0,
                            None,
                            None,
                            None,
                            false,
                            false,
                            false,
                        );
                    }
                    let mut lines = Vec::new();
                    text_lines(&parent, false, &mut lines);
                    if grouped {
                        check_visible_bold_runs(&parent, false);
                    }
                    assert_eq!(
                        lines.len(),
                        if explicit_break { 4 } else { 3 },
                        "partial={partial}"
                    );
                    assert!(lines.iter().all(|line| line.width <= 80.0 + 0.01));
                    positions.push(lines);
                }
                let extent = positions[0].last().unwrap().y + positions[0].last().unwrap().height
                    - positions[0][0].y;
                let slack = 100.0 - extent;
                for (index, expected) in [(1, slack / 2.0), (2, slack)] {
                    for line in 0..positions[0].len() {
                        assert!((positions[index][line].y - positions[0][line].y - expected).abs() < 0.5,
                            "partial={partial}, LF={explicit_break}, alignment={index}, positions={positions:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn fresh_multiple_paragraphs_align_as_a_complete_cell_in_full_and_partial_layout() {
        use crate::model::paragraph::LineSeg;
        use crate::model::table::VerticalAlign;
        fn lines(node: &RenderNode, result: &mut Vec<BoundingBox>) {
            if matches!(node.node_type, RenderNodeType::TextLine(_)) {
                result.push(node.bbox);
            }
            for child in &node.children {
                lines(child, result);
            }
        }
        let engine = LayoutEngine::new(96.0);
        let styles = ResolvedStyleSet {
            char_styles: vec![crate::renderer::style_resolver::ResolvedCharStyle {
                font_size: 16.0,
                ..Default::default()
            }],
            para_styles: vec![crate::renderer::style_resolver::ResolvedParaStyle {
                line_spacing: 125.0,
                ..Default::default()
            }],
            ..Default::default()
        };
        let area = LayoutRect {
            x: 0.0,
            y: 0.0,
            width: 500.0,
            height: 800.0,
        };
        for partial in [false, true] {
            let mut positions = Vec::new();
            for vertical_align in [
                VerticalAlign::Top,
                VerticalAlign::Center,
                VerticalAlign::Bottom,
            ] {
                let table = Table {
                    row_count: 1,
                    col_count: 1,
                    page_break: TablePageBreak::RowBreak,
                    common: CommonObjAttr {
                        width: 15_000,
                        height: 6_000,
                        treat_as_char: true,
                        ..Default::default()
                    },
                    cells: vec![Cell {
                        row_span: 1,
                        col_span: 1,
                        width: 15_000,
                        height: 6_000,
                        vertical_align,
                        paragraphs: ["first", "second"]
                            .into_iter()
                            .map(|text| Paragraph {
                                text: text.into(),
                                line_segs: vec![LineSeg {
                                    line_height: 1_200,
                                    text_height: 1_200,
                                    baseline_distance: 1_020,
                                    line_spacing: 300,
                                    segment_width: 15_000,
                                    tag: LineSeg::TAG_IMPLEMENTATION_PROPERTY,
                                    ..Default::default()
                                }],
                                ..Default::default()
                            })
                            .collect(),
                        ..Default::default()
                    }],
                    ..Default::default()
                };
                let mut tree = PageRenderTree::new(0, 800.0, 1100.0);
                let mut parent = RenderNode::new(
                    tree.next_id(),
                    RenderNodeType::Column(0),
                    BoundingBox::new(0.0, 0.0, 500.0, 800.0),
                );
                if partial {
                    let paragraphs = vec![Paragraph {
                        controls: vec![Control::Table(Box::new(table))],
                        ..Default::default()
                    }];
                    engine.layout_partial_table(
                        &mut tree,
                        &mut parent,
                        &paragraphs,
                        0,
                        0,
                        0,
                        &styles,
                        0,
                        &area,
                        0.0,
                        &[],
                        0,
                        1,
                        false,
                        &[],
                        &[],
                        false,
                        0.0,
                        0.0,
                        None,
                        false,
                        None,
                        &[],
                    );
                } else {
                    engine.layout_table(
                        &mut tree,
                        &mut parent,
                        &table,
                        0,
                        &styles,
                        0,
                        &area,
                        0.0,
                        &[],
                        None,
                        0,
                        Some((0, 0)),
                        Alignment::Left,
                        None,
                        0.0,
                        0.0,
                        None,
                        None,
                        None,
                        false,
                        false,
                        false,
                    );
                }
                let mut text_lines = Vec::new();
                lines(&parent, &mut text_lines);
                assert_eq!(text_lines.len(), 2);
                positions.push(text_lines);
            }
            let extent = positions[0][1].y + positions[0][1].height - positions[0][0].y;
            let slack = 80.0 - extent;
            for (index, expected) in [(1, slack / 2.0), (2, slack)] {
                for line in 0..2 {
                    assert!((positions[index][line].y - positions[0][line].y - expected).abs() < 0.5,
                        "partial={partial}, alignment={index}, line={line}, positions={positions:?}");
                }
            }
        }
    }

    #[test]
    fn floating_cell_controls_use_stable_planes_and_z_order_in_full_and_partial_tables() {
        let controls = [
            (TextWrap::InFrontOfText, 9),
            (TextWrap::BehindText, 99),
            (TextWrap::InFrontOfText, 8),
            (TextWrap::TopAndBottom, -5),
            (TextWrap::InFrontOfText, 9),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (text_wrap, z_order))| {
            Control::Shape(Box::new(ShapeObject::Rectangle(RectangleShape {
                common: CommonObjAttr {
                    text_wrap,
                    z_order,
                    width: 1_000,
                    height: 1_000,
                    horizontal_offset: index as u32 * 1_000,
                    vertical_offset: 4_000,
                    ..Default::default()
                },
                drawing: crate::model::shape::DrawingObjAttr {
                    shape_attr: if index == 4 {
                        crate::model::shape::ShapeComponentAttr {
                            original_width: 1_000,
                            original_height: 1_000,
                            current_width: 4_000,
                            current_height: 4_000,
                            ..Default::default()
                        }
                    } else {
                        Default::default()
                    },
                    text_box: (index == 4).then(|| crate::model::shape::TextBox {
                        paragraphs: vec![Paragraph {
                            text: "label".into(),
                            ..Default::default()
                        }],
                        ..Default::default()
                    }),
                    fill: crate::model::style::Fill {
                        fill_type: crate::model::style::FillType::Solid,
                        solid: Some(crate::model::style::SolidFill {
                            background_color: 0x000000ff,
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                    ..Default::default()
                },
                ..Default::default()
            })))
        })
        .collect();
        let table = Table {
            row_count: 1,
            col_count: 1,
            page_break: TablePageBreak::RowBreak,
            common: CommonObjAttr {
                width: 10_000,
                height: 10_000,
                ..Default::default()
            },
            cells: vec![Cell {
                row_span: 1,
                col_span: 1,
                width: 10_000,
                height: 10_000,
                border_fill_id: 1,
                paragraphs: vec![Paragraph {
                    text: "anchor".into(),
                    controls,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let styles = ResolvedStyleSet {
            char_styles: vec![crate::renderer::style_resolver::ResolvedCharStyle {
                font_size: 12.0,
                ..Default::default()
            }],
            border_styles: vec![crate::renderer::style_resolver::ResolvedBorderStyle {
                fill_color: Some(0x00ffffff),
                ..Default::default()
            }],
            ..Default::default()
        };
        let engine = LayoutEngine::new(96.0);
        let area = LayoutRect {
            x: 0.0,
            y: 0.0,
            width: 500.0,
            height: 800.0,
        };
        for partial in [false, true] {
            let mut tree = PageRenderTree::new(0, 800.0, 1100.0);
            let mut parent = RenderNode::new(
                tree.next_id(),
                RenderNodeType::Column(0),
                BoundingBox::new(0.0, 0.0, 500.0, 800.0),
            );
            if partial {
                let paragraphs = vec![Paragraph {
                    controls: vec![Control::Table(Box::new(table.clone()))],
                    ..Default::default()
                }];
                engine.layout_partial_table(
                    &mut tree,
                    &mut parent,
                    &paragraphs,
                    0,
                    0,
                    0,
                    &styles,
                    0,
                    &area,
                    0.0,
                    &[],
                    0,
                    1,
                    false,
                    &[],
                    &[],
                    false,
                    0.0,
                    0.0,
                    None,
                    false,
                    None,
                    &[],
                );
            } else {
                engine.layout_table(
                    &mut tree,
                    &mut parent,
                    &table,
                    0,
                    &styles,
                    0,
                    &area,
                    0.0,
                    &[],
                    None,
                    0,
                    Some((0, 0)),
                    Alignment::Left,
                    Some(CellContext {
                        parent_para_index: 7,
                        path: vec![
                            CellPathEntry {
                                control_index: 5,
                                cell_index: 2,
                                cell_para_index: 1,
                                text_direction: 1,
                                line_wrap_squeeze: true,
                                row_span: 1,
                            },
                            CellPathEntry {
                                control_index: 0,
                                cell_index: 0,
                                cell_para_index: 0,
                                text_direction: 0,
                                line_wrap_squeeze: false,
                                row_span: 1,
                            },
                        ],
                    }),
                    0.0,
                    0.0,
                    None,
                    None,
                    None,
                    false,
                    false,
                    false,
                );
            }
            let table_node = parent
                .children
                .iter()
                .find(|node| matches!(node.node_type, RenderNodeType::Table(_)))
                .unwrap();
            let cell_node = table_node
                .children
                .iter()
                .find(|node| matches!(node.node_type, RenderNodeType::TableCell(_)))
                .unwrap();
            fn label_sizes(
                node: &RenderNode,
                sizes: &mut Vec<f64>,
                text: &mut String,
                partial: bool,
            ) {
                if let RenderNodeType::TextRun(run) = &node.node_type {
                    if run.cell_context.as_ref().is_some_and(|context| {
                        context
                            .path
                            .last()
                            .is_some_and(|entry| entry.control_index == 4)
                    }) {
                        sizes.push(run.style.font_size);
                        text.push_str(&run.text);
                        let context = run.cell_context.as_ref().unwrap();
                        assert_eq!(context.path.len(), if partial { 2 } else { 3 });
                        assert_eq!(context.path.last().unwrap().control_index, 4);
                        if !partial {
                            assert_eq!(context.parent_para_index, 7);
                            assert_eq!(context.path[0].control_index, 5);
                            assert_eq!(context.path[0].text_direction, 1);
                            assert!(context.path[0].line_wrap_squeeze);
                        }
                    }
                }
                for child in &node.children {
                    label_sizes(child, sizes, text, partial);
                }
            }
            let mut sizes = Vec::new();
            let mut label = String::new();
            label_sizes(cell_node, &mut sizes, &mut label, partial);
            assert_eq!(label, "label");
            assert!(
                !sizes.is_empty() && sizes.iter().all(|size| *size == 12.0),
                "wrapped cell textbox must retain authored font size: {sizes:?}"
            );
            assert!(cell_node.children[0].layer.is_none());
            assert!(
                matches!(
                    cell_node.children[0].node_type,
                    RenderNodeType::Rectangle(_)
                ),
                "cell background must precede even BehindText objects"
            );
            let painted: Vec<_> = cell_node
                .children
                .iter()
                .filter_map(|node| node.layer.map(|layer| (layer.stable_index, layer.z_order)))
                .collect();
            assert_eq!(
                painted,
                vec![(1, 99), (3, -5), (2, 8), (0, 9), (4, 9)],
                "partial={partial}"
            );
            assert!(cell_node
                .children
                .iter()
                .filter_map(|node| node.layer)
                .all(|layer| layer.local_to_parent));
            let behind_bbox = cell_node
                .children
                .iter()
                .find(|node| node.layer.is_some_and(|layer| layer.stable_index == 1))
                .unwrap()
                .bbox;
            for outer_wrap in [None, Some(TextWrap::InFrontOfText)] {
                parent.layer = outer_wrap.map(|wrap| RenderLayerInfo::new(Some(wrap), 1, 0));
                tree.root.children = vec![parent.clone()];
                let mut svg = crate::renderer::svg::SvgRenderer::new();
                svg.render_tree(&tree);
                let output = svg.output().to_uppercase();
                assert!(
                    output.find("#FFFFFF").unwrap() < output.find("#FF0000").unwrap(),
                    "SVG must paint the opaque cell background before its BehindText object"
                );

                #[cfg(feature = "native-skia")]
                {
                    let layers =
                        crate::paint::LayerBuilder::new(crate::paint::RenderProfile::Print)
                            .build(&tree);
                    let output = crate::renderer::skia::SkiaLayerRenderer::new()
                        .render_raster_with_options(
                            &layers,
                            crate::renderer::layer_renderer::RasterRenderOptions::default(),
                        )
                        .unwrap();
                    let pixels = image::load_from_memory(&output.bytes).unwrap().to_rgba8();
                    let pixel = pixels.get_pixel(
                        (behind_bbox.x + behind_bbox.width / 2.0) as u32,
                        (behind_bbox.y + behind_bbox.height / 2.0) as u32,
                    );
                    assert_eq!(pixel.0, [255, 0, 0, 255],
                        "BehindText object must stay visible above its cell background: partial={partial}, outer={outer_wrap:?}");
                }
            }
        }
    }
}

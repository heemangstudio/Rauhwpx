//! 표 셀 내용 레이아웃 (세로쓰기, 셀 도형, 내장 표)

use super::super::composer::ComposedParagraph;
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

    /// 배치와 부분 셀 정규화가 같은 원본 Paper 자격을 사용한다.
    pub(super) fn cell_shape_paper_reference(
        &self,
        shape: &crate::model::shape::ShapeObject,
    ) -> Option<LayoutRect> {
        let paper = self.nested_shape_paper.get()?;
        let common = shape.common();
        let attr = shape.shape_attr();
        (!common.treat_as_char
            && matches!(common.horz_rel_to, crate::model::shape::HorzRelTo::Paper)
            && matches!(common.vert_rel_to, crate::model::shape::VertRelTo::Paper)
            && !matches!(shape, crate::model::shape::ShapeObject::Group(_))
            && attr.group_level == 0
            && !extract_shape_transform(attr).has_transform()
            && attr.render_b == 0.0
            && attr.render_c == 0.0)
            .then_some(paper)
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
        } else if let Some(paper) = self.cell_shape_paper_reference(shape) {
            // Paper/Paper 는 셀 이동과 무관한 실제 용지 틀이다. 일반 크기 정규화는
            // 유지하고, 혼합 축·묶음·회전 및 머리말/꼬리말 소유자 예외는 기존 경로로 둔다.
            let frame = crate::renderer::float_placement::object_frame(
                child_common,
                child_w,
                child_h,
                crate::renderer::float_placement::ObjectPlacementContext {
                    paper,
                    page: paper, // 두 축 모두 Paper 인 위 가드 아래에서는 사용하지 않는다.
                    column: *inner_area,
                    paragraph: *inner_area,
                    line_y: para_y,
                },
                self.dpi,
            );
            (frame.x, frame.y)
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
        if self.cell_shape_paper_reference(shape).is_some()
            && shape
                .drawing()
                .is_some_and(|drawing| drawing.text_box.is_some())
        {
            // 자체 글상자 클립과 원본 경로를 유지하고 셀의 로컬 레이어 적용 전에 옮긴다.
            tree.root
                .children
                .extend(cell_node.children.drain(children_start..));
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
                .map(|p| crate::renderer::composer::compose_paragraph_with_styles(p, &styles))
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

#[cfg(test)]
mod nested_paper_reference_tests {
    use super::*;
    use crate::model::shape::{
        HorzAlign, HorzRelTo, RectangleShape, ShapeObject, VertAlign, VertRelTo,
    };

    fn shape() -> ShapeObject {
        let mut rect = RectangleShape::default();
        rect.common.width = 40;
        rect.common.height = 30;
        rect.common.treat_as_char = false;
        rect.common.horz_rel_to = HorzRelTo::Paper;
        rect.common.vert_rel_to = VertRelTo::Paper;
        rect.common.horz_align = HorzAlign::Right;
        rect.common.vert_align = VertAlign::Top;
        rect.common.horizontal_offset = 7;
        rect.common.vertical_offset = 11;
        ShapeObject::Rectangle(rect)
    }

    fn frame(
        shape: &ShapeObject,
        paper: Option<LayoutRect>,
        cell: LayoutRect,
        clamp_header: bool,
    ) -> BoundingBox {
        let engine = LayoutEngine::new(7200.0);
        engine.nested_shape_paper.set(paper);
        let mut tree = PageRenderTree::new(0, 400.0, 700.0);
        let mut parent = RenderNode::new(
            tree.next_id(),
            RenderNodeType::Body { clip_rect: None },
            BoundingBox::new(cell.x, cell.y, cell.width, cell.height),
        );
        engine.layout_cell_shape(
            &mut tree,
            &mut parent,
            shape,
            &cell,
            cell.y + 3.0,
            Alignment::Left,
            &ResolvedStyleSet::default(),
            &[],
            clamp_header,
            None,
            None,
        );
        parent
            .children
            .into_iter()
            .find_map(|node| {
                matches!(node.node_type, RenderNodeType::Rectangle(_)).then_some(node.bbox)
            })
            .expect("rectangle emitted by the production cell-shape renderer")
    }

    fn paper() -> LayoutRect {
        LayoutRect {
            x: 0.0,
            y: 0.0,
            width: 400.0,
            height: 700.0,
        }
    }

    fn cell() -> LayoutRect {
        LayoutRect {
            x: 100.0,
            y: 200.0,
            width: 160.0,
            height: 90.0,
        }
    }

    #[test]
    fn nested_paper_shape_uses_physical_extent_and_ignores_ancestor_translation() {
        let shape = shape();
        let first = frame(&shape, Some(paper()), cell(), false);
        let mut moved_cell = cell();
        moved_cell.x += 300.0;
        moved_cell.y += 500.0;
        let moved = frame(&shape, Some(paper()), moved_cell, false);
        assert_eq!((first.x, first.y), (353.0, 11.0));
        assert_eq!((moved.x, moved.y), (first.x, first.y));
        let mut larger = paper();
        larger.width += 120.0;
        let resized = frame(&shape, Some(larger), cell(), false);
        assert_eq!((resized.x, resized.y), (473.0, 11.0));
    }

    #[test]
    fn nested_paper_shape_preserves_signed_offsets_and_normal_size_normalization() {
        let mut shape = shape();
        let common = shape.common_mut();
        common.horizontal_offset = (-5_i32) as u32;
        common.vertical_offset = (-7_i32) as u32;
        common.horz_align = HorzAlign::Center;
        common.vert_align = VertAlign::Bottom;
        let attr = &mut shape.drawing_mut().unwrap().shape_attr;
        attr.render_sx = 0.7;
        attr.render_sy = 1.2;
        attr.render_tx = -282.0;
        let got = frame(&shape, Some(paper()), cell(), false);
        assert_eq!((got.x, got.y), (175.0, 677.0));
    }

    #[test]
    fn nested_paper_shape_keeps_unknown_owner_para_tac_mixed_and_transform_routes() {
        // None is supplied outside the ordinary body scope, including header/footer owners.
        for clamp_header in [false, true] {
            let got = frame(&shape(), None, cell(), clamp_header);
            assert_eq!((got.x, got.y), (213.0, 211.0));
        }
        let mut para = shape();
        para.common_mut().horz_rel_to = HorzRelTo::Para;
        para.common_mut().vert_rel_to = VertRelTo::Para;
        let got = frame(&para, Some(paper()), cell(), false);
        assert_eq!((got.x, got.y), (213.0, 214.0));
        let mut mixed = shape();
        mixed.common_mut().vert_rel_to = VertRelTo::Para;
        let got = frame(&mixed, Some(paper()), cell(), false);
        assert_eq!((got.x, got.y), (213.0, 214.0));
        let mut inline = shape();
        inline.common_mut().treat_as_char = true;
        let got = frame(&inline, Some(paper()), cell(), false);
        assert_eq!((got.x, got.y), (100.0, 203.0));
        for transform in 0..4 {
            let mut protected = shape();
            let attr = &mut protected.drawing_mut().unwrap().shape_attr;
            match transform {
                0 => attr.group_level = 1,
                1 => attr.rotation_angle = 30,
                2 => attr.horz_flip = true,
                _ => attr.render_b = 0.2,
            }
            let got = frame(&protected, Some(paper()), cell(), false);
            assert_eq!((got.x, got.y), (213.0, 211.0));
        }
    }

    fn ancestor_with_embedded_picture() -> ShapeObject {
        use crate::model::shape::TextBox;
        use crate::model::table::{Cell, Table};
        // Embedded-table cell shapes are an existing unsupported renderer route.
        // Use its supported picture payload to exercise real ancestor rendering.
        let mut picture = crate::model::image::Picture::default();
        picture.common.width = 32;
        picture.common.height = 24;
        picture.common.treat_as_char = true;
        let child_para = Paragraph {
            controls: vec![Control::Picture(Box::new(picture))],
            char_count: 9,
            ..Default::default()
        };
        let cell = Cell {
            width: 200,
            height: 80,
            row_span: 1,
            col_span: 1,
            paragraphs: vec![child_para],
            ..Default::default()
        };
        let mut table = Table {
            row_count: 1,
            col_count: 1,
            cells: vec![cell],
            cell_grid: vec![Some(0)],
            ..Default::default()
        };
        table.common.width = 200;
        table.common.height = 80;
        table.common.treat_as_char = true;
        let table_para = Paragraph {
            controls: vec![Control::Table(Box::new(table))],
            char_count: 9,
            ..Default::default()
        };
        let mut outer = RectangleShape::default();
        outer.common.width = 200;
        outer.common.height = 150;
        outer.drawing.text_box = Some(TextBox {
            paragraphs: vec![table_para],
            ..Default::default()
        });
        ShapeObject::Rectangle(outer)
    }

    fn ancestor_picture_and_following_frame(
        ancestor: &ShapeObject,
        paper: Option<LayoutRect>,
    ) -> (BoundingBox, BoundingBox) {
        let engine = LayoutEngine::new(7200.0);
        engine.nested_shape_paper.set(paper);
        let mut tree = PageRenderTree::new(0, 400.0, 700.0);
        let mut parent = RenderNode::new(
            tree.next_id(),
            RenderNodeType::Body { clip_rect: None },
            BoundingBox::new(0.0, 0.0, 400.0, 700.0),
        );
        engine.layout_shape_object(
            &mut tree,
            &mut parent,
            ancestor,
            100.0,
            200.0,
            200.0,
            150.0,
            0,
            0,
            0,
            &ResolvedStyleSet::default(),
            &[],
            &std::collections::HashMap::new(),
            &[],
            None,
            false,
        );
        fn find_picture(node: &RenderNode) -> Option<BoundingBox> {
            if matches!(node.node_type, RenderNodeType::Image(_))
                && node.bbox.width == 32.0
                && node.bbox.height == 24.0
            {
                return Some(node.bbox.clone());
            }
            node.children.iter().find_map(find_picture)
        }
        fn has_textbox(node: &RenderNode) -> bool {
            matches!(node.node_type, RenderNodeType::TextBox)
                || node.children.iter().any(has_textbox)
        }
        let picture = find_picture(&parent).expect("actual embedded-table picture rendered");
        assert!(
            has_textbox(&parent),
            "actual ancestor textbox path rendered"
        );
        engine.layout_cell_shape(
            &mut tree,
            &mut parent,
            &shape(),
            &cell(),
            203.0,
            Alignment::Left,
            &ResolvedStyleSet::default(),
            &[],
            false,
            None,
            None,
        );
        let following = parent
            .children
            .iter()
            .rev()
            .find(|node| {
                matches!(node.node_type, RenderNodeType::Rectangle(_))
                    && node.bbox.width == 40.0
                    && node.bbox.height == 30.0
            })
            .expect("following ordinary Paper shape rendered")
            .bbox
            .clone();
        (picture, following)
    }

    #[test]
    fn nested_paper_scope_is_restored_after_textboxes_with_supported_embedded_pictures() {
        let mut ordinary = ancestor_with_embedded_picture();
        ordinary.drawing_mut().unwrap().shape_attr.render_sx = 0.7;
        ordinary.drawing_mut().unwrap().shape_attr.render_sy = 1.2;
        let (_, following) = ancestor_picture_and_following_frame(&ordinary, Some(paper()));
        assert_eq!((following.x, following.y), (353.0, 11.0));
        for protected in 0..4 {
            let mut outer = ancestor_with_embedded_picture();
            match protected {
                0 => outer.drawing_mut().unwrap().shape_attr.rotation_angle = 30,
                1 => outer.drawing_mut().unwrap().shape_attr.horz_flip = true,
                2 => outer.drawing_mut().unwrap().shape_attr.render_c = 0.2,
                _ => outer.drawing_mut().unwrap().shape_attr.group_level = 1,
            }
            let (without, legacy_following) = ancestor_picture_and_following_frame(&outer, None);
            let (with, following) = ancestor_picture_and_following_frame(&outer, Some(paper()));
            assert_eq!((with.x, with.y), (without.x, without.y));
            assert_eq!((following.x, following.y), (353.0, 11.0));
            assert_eq!((legacy_following.x, legacy_following.y), (213.0, 211.0));
        }
    }

    fn tree_host(child: ShapeObject, known_body: bool) -> Paragraph {
        use crate::model::paragraph::LineSeg;
        use crate::model::table::{Cell, Table};
        let mut table = Table {
            row_count: 1,
            col_count: 1,
            cells: vec![Cell {
                width: 200,
                height: 180,
                row_span: 1,
                col_span: 1,
                paragraphs: vec![Paragraph {
                    char_count: 9,
                    controls: vec![Control::Shape(Box::new(child))],
                    line_segs: vec![LineSeg {
                        line_height: 10,
                        text_height: 10,
                        baseline_distance: 8,
                        segment_width: 200,
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            cell_grid: vec![Some(0)],
            ..Default::default()
        };
        table.common.width = 200;
        table.common.height = 180;
        table.common.horz_rel_to = HorzRelTo::Column;
        table.common.vert_rel_to = VertRelTo::Para;
        table.common.text_wrap = crate::model::shape::TextWrap::TopAndBottom;
        let mut controls = vec![Control::Table(Box::new(table))];
        if known_body {
            controls.push(Control::SectionDef(Box::default()));
        }
        Paragraph {
            char_count: if known_body { 17 } else { 9 },
            controls,
            ..Default::default()
        }
    }

    fn page(width: f64, areas: Vec<LayoutRect>) -> crate::renderer::pagination::PageContent {
        use crate::renderer::page_layout::PageLayoutInfo;
        use crate::renderer::pagination::{ColumnContent, PageContent, PageItem};
        let body = LayoutRect {
            x: 70.0,
            y: 100.0,
            width: width - 110.0,
            height: 500.0,
        };
        let layout = PageLayoutInfo {
            page_width: width,
            page_height: 700.0,
            header_area: LayoutRect {
                x: 70.0,
                y: 30.0,
                width: body.width,
                height: 60.0,
            },
            body_area: body,
            column_areas: areas.clone(),
            footnote_area: body,
            footer_area: LayoutRect {
                x: 70.0,
                y: 620.0,
                width: body.width,
                height: 60.0,
            },
            dpi: 7200.0,
            separator_type: 0,
            separator_width: 0,
            separator_color: 0,
            pagination_tolerance_px: 0.0,
        };
        PageContent {
            page_index: 0,
            page_number: 1,
            section_index: 0,
            layout,
            column_contents: areas
                .iter()
                .enumerate()
                .map(|(i, _)| ColumnContent {
                    column_index: i as u16,
                    start_height: 0.0,
                    endnote_flow: false,
                    items: vec![PageItem::Table {
                        para_index: i,
                        control_index: 0,
                    }],
                    zone_layout: None,
                    zone_y_offset: 0.0,
                    wrap_around_paras: vec![],
                    used_height: 0.0,
                    wrap_anchors: std::collections::HashMap::new(),
                })
                .collect(),
            active_header: None,
            active_footer: None,
            page_number_pos: None,
            page_hide: None,
            footnotes: vec![],
            active_master_page: None,
            extra_master_pages: vec![],
        }
    }

    fn whole_tree(
        engine: &LayoutEngine,
        page: &crate::renderer::pagination::PageContent,
        paragraphs: &[Paragraph],
        header: &[Paragraph],
        footer: &[Paragraph],
        master: Option<&crate::model::header_footer::MasterPage>,
    ) -> PageRenderTree {
        let styles = ResolvedStyleSet::default();
        let composed: Vec<_> = paragraphs
            .iter()
            .map(|para| crate::renderer::composer::compose_paragraph_with_styles(para, &styles))
            .collect();
        engine.build_render_tree(
            page,
            paragraphs,
            header,
            footer,
            &composed,
            &styles,
            &crate::model::footnote::FootnoteShape::default(),
            &[],
            master,
            &[],
            None,
            0,
            &[],
        )
    }

    fn rectangles(node: &RenderNode) -> Vec<(f64, f64)> {
        let mut out = Vec::new();
        if matches!(node.node_type, RenderNodeType::Rectangle(_))
            && node.bbox.width == 40.0
            && node.bbox.height == 30.0
        {
            out.push((node.bbox.x, node.bbox.y));
        }
        for child in &node.children {
            out.extend(rectangles(child));
        }
        out
    }

    fn one_area() -> Vec<LayoutRect> {
        vec![LayoutRect {
            x: 70.0,
            y: 100.0,
            width: 290.0,
            height: 500.0,
        }]
    }

    #[test]
    fn whole_tree_body_scope_uses_each_actual_page_and_column_extent() {
        let engine = LayoutEngine::new(7200.0);
        for width in [400.0, 520.0] {
            let areas = vec![
                LayoutRect {
                    x: 40.0,
                    y: 100.0,
                    width: 140.0,
                    height: 500.0,
                },
                LayoutRect {
                    x: 220.0,
                    y: 180.0,
                    width: 140.0,
                    height: 420.0,
                },
            ];
            let page = page(width, areas);
            let tree = whole_tree(
                &engine,
                &page,
                &[tree_host(shape(), true), tree_host(shape(), true)],
                &[],
                &[],
                None,
            );
            let body = tree
                .root
                .children
                .iter()
                .find(|n| matches!(n.node_type, RenderNodeType::Body { .. }))
                .unwrap();
            assert_eq!(
                body.children
                    .iter()
                    .filter(|n| matches!(n.node_type, RenderNodeType::Column(_)))
                    .count(),
                2
            );
            assert_eq!(rectangles(body), vec![(width - 47.0, 11.0); 2]);
        }
        // Reusing the same engine for an unknown section must use the unchanged owner fallback.
        let page = page(400.0, one_area());
        let unknown = [tree_host(shape(), false)];
        let reused = whole_tree(&engine, &page, &unknown, &[], &[], None);
        let fresh = whole_tree(&LayoutEngine::new(7200.0), &page, &unknown, &[], &[], None);
        assert_eq!(rectangles(&reused.root), rectangles(&fresh.root));
        assert_eq!(rectangles(&reused.root).len(), 1);
        assert_ne!(rectangles(&reused.root)[0], (353.0, 11.0));
    }

    #[test]
    fn whole_tree_body_scope_does_not_leak_to_reused_header_footer_or_master() {
        use crate::model::header_footer::{Footer, Header, MasterPage};
        use crate::renderer::pagination::HeaderFooterRef;
        let engine = LayoutEngine::new(7200.0);
        let mut page = page(400.0, one_area());
        let first = whole_tree(&engine, &page, &[tree_host(shape(), true)], &[], &[], None);
        assert_eq!(rectangles(&first.root), vec![(353.0, 11.0)]);
        let nested = vec![tree_host(shape(), false)];
        let header = [Paragraph {
            controls: vec![Control::Header(Box::new(Header {
                paragraphs: nested.clone(),
                ..Default::default()
            }))],
            ..Default::default()
        }];
        let footer = [Paragraph {
            controls: vec![Control::Footer(Box::new(Footer {
                paragraphs: nested.clone(),
                ..Default::default()
            }))],
            ..Default::default()
        }];
        let master = MasterPage {
            paragraphs: nested,
            text_width: 400,
            text_height: 700,
            ..Default::default()
        };
        page.active_header = Some(HeaderFooterRef::default());
        page.active_footer = Some(HeaderFooterRef::default());
        let body = [tree_host(shape(), true)];
        let reused = whole_tree(&engine, &page, &body, &header, &footer, Some(&master));
        let fresh = whole_tree(
            &LayoutEngine::new(7200.0),
            &page,
            &body,
            &header,
            &footer,
            Some(&master),
        );
        for kind in 0..3 {
            let select = |tree: &PageRenderTree| -> Vec<(f64, f64)> {
                let owner = tree
                    .root
                    .children
                    .iter()
                    .find(|n| match kind {
                        0 => matches!(n.node_type, RenderNodeType::Header),
                        1 => matches!(n.node_type, RenderNodeType::Footer),
                        _ => matches!(n.node_type, RenderNodeType::MasterPage),
                    })
                    .expect("the actual owner renderer emitted its subtree");
                rectangles(owner)
            };
            let got = select(&reused);
            assert_eq!(
                got.len(),
                1,
                "the real owner path rendered the nested source shape"
            );
            assert_eq!(got, select(&fresh));
            assert_ne!(
                got[0],
                (353.0, 11.0),
                "owner must retain the legacy cell reference"
            );
        }
        let body = reused
            .root
            .children
            .iter()
            .find(|n| matches!(n.node_type, RenderNodeType::Body { .. }))
            .unwrap();
        assert_eq!(rectangles(body), vec![(353.0, 11.0)]);
    }

    #[test]
    fn whole_tree_virtual_endnote_then_body_restores_real_page_reference() {
        use crate::renderer::pagination::PageItem;
        let engine = LayoutEngine::new(7200.0);
        let paragraphs = [tree_host(shape(), true)];
        let page = page(520.0, one_area());
        let before = whole_tree(&engine, &page, &paragraphs, &[], &[], None);
        assert_eq!(rectangles(&before.root), vec![(473.0, 11.0)]);
        let virtual_area = LayoutRect {
            x: 0.0,
            y: 0.0,
            width: 190.0,
            height: 300.0,
        };
        let styles = ResolvedStyleSet::default();
        let composed: Vec<_> = paragraphs
            .iter()
            .map(|para| crate::renderer::composer::compose_paragraph_with_styles(para, &styles))
            .collect();
        let bottom = engine.measure_endnote_column_bottom(
            vec![PageItem::Table {
                para_index: 0,
                control_index: 0,
            }],
            &paragraphs,
            &composed,
            &styles,
            &virtual_area,
            0.0,
            0,
            0,
        );
        assert!(bottom.is_finite());
        let after = whole_tree(&engine, &page, &paragraphs, &[], &[], None);
        assert_eq!(rectangles(&after.root), vec![(473.0, 11.0)]);
        let mut endnote_page = page.clone();
        endnote_page.column_contents[0].endnote_flow = true;
        let endnote = whole_tree(&engine, &endnote_page, &paragraphs, &[], &[], None);
        assert_eq!(rectangles(&endnote.root).len(), 1);
        assert_ne!(rectangles(&endnote.root)[0], (473.0, 11.0));
        let final_body = whole_tree(&engine, &page, &paragraphs, &[], &[], None);
        assert_eq!(rectangles(&final_body.root), vec![(473.0, 11.0)]);
    }

    #[test]
    fn whole_tree_affine_group_embedded_picture_preserves_legacy_and_restores_following_body() {
        use crate::model::shape::GroupShape;
        let mut child = ancestor_with_embedded_picture();
        let attr = &mut child.drawing_mut().unwrap().shape_attr;
        attr.original_width = 200;
        attr.original_height = 150;
        attr.render_b = 0.2; // actual Group dispatch selects layout_group_child_affine.
        let mut group = GroupShape {
            children: vec![child],
            ..Default::default()
        };
        group.common.width = 200;
        group.common.height = 180;
        let grouped = ShapeObject::Group(group);
        let engine = LayoutEngine::new(7200.0);
        let mut page = page(400.0, one_area());
        page.column_contents[0]
            .items
            .push(crate::renderer::pagination::PageItem::Table {
                para_index: 1,
                control_index: 0,
            });
        let unknown = [tree_host(grouped.clone(), false), tree_host(shape(), false)];
        let legacy = whole_tree(&LayoutEngine::new(7200.0), &page, &unknown, &[], &[], None);
        let body = [tree_host(grouped, true), tree_host(shape(), true)];
        let scoped = whole_tree(&engine, &page, &body, &[], &[], None);
        fn pictures(node: &RenderNode) -> Vec<(f64, f64)> {
            let mut out = Vec::new();
            if matches!(node.node_type, RenderNodeType::Image(_))
                && node.bbox.width == 32.0
                && node.bbox.height == 24.0
            {
                out.push((node.bbox.x, node.bbox.y));
            }
            for child in &node.children {
                out.extend(pictures(child));
            }
            out
        }
        assert_eq!(
            pictures(&scoped.root).len(),
            1,
            "actual affine textbox and embedded table picture rendered"
        );
        assert_eq!(pictures(&scoped.root), pictures(&legacy.root));
        assert_eq!(
            rectangles(&scoped.root),
            vec![(353.0, 11.0)],
            "following ordinary Paper shape restored"
        );
        fn has_group(node: &RenderNode) -> bool {
            matches!(node.node_type, RenderNodeType::Group(_))
                || node.children.iter().any(has_group)
        }
        assert!(
            has_group(&scoped.root),
            "actual group rendering path was used"
        );
        fn has_affine_textbox(node: &RenderNode) -> bool {
            (matches!(node.node_type, RenderNodeType::Path(_))
                && node.bbox.width == 230.0
                && node.bbox.height == 150.0
                && pictures(node).len() == 1)
                || node.children.iter().any(has_affine_textbox)
        }
        assert!(
            has_affine_textbox(&scoped.root),
            "actual affine child emitted a path and its embedded picture table"
        );
    }

    fn paper_text_shape(text: &str) -> ShapeObject {
        use crate::model::paragraph::{CharShapeRef, LineSeg};
        use crate::model::shape::{TextBox, TextWrap};
        let mut object = shape();
        object.common_mut().text_wrap = TextWrap::Square;
        object.drawing_mut().unwrap().text_box = Some(TextBox {
            paragraphs: vec![Paragraph {
                text: text.into(),
                char_count: text.encode_utf16().count() as u32 + 1,
                char_offsets: (0..text.chars().count()).map(|i| i as u32).collect(),
                char_shapes: vec![CharShapeRef::default()],
                line_segs: vec![LineSeg {
                    line_height: 20,
                    text_height: 20,
                    baseline_distance: 15,
                    segment_width: 40,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        });
        object
    }

    // The source control prefix makes the nested shape's stable key (0, 1),
    // which can genuinely collide with an outer paragraph's control 1.
    fn paper_paint_host(text: &str, ordinary: bool) -> Paragraph {
        let mut target = paper_text_shape(text);
        if ordinary {
            target.common_mut().horz_rel_to = HorzRelTo::Para;
            target.common_mut().vert_rel_to = VertRelTo::Para;
            target.common_mut().vertical_offset = (-40_i32) as u32;
        }
        let mut host = tree_host(target, true);
        let Control::Table(table) = &mut host.controls[0] else {
            unreachable!()
        };
        let mut prefix = shape();
        prefix.common_mut().horz_rel_to = HorzRelTo::Para;
        prefix.common_mut().vert_rel_to = VertRelTo::Para;
        prefix.common_mut().width = 1;
        prefix.common_mut().height = 1;
        table.cells[0].paragraphs[0]
            .controls
            .insert(0, Control::Shape(Box::new(prefix)));
        table.cells[0].paragraphs[0].char_count = 17;
        host
    }

    fn paint_styles() -> ResolvedStyleSet {
        use crate::model::provenance::FontMetricsPolicy;
        use crate::renderer::style_resolver::{ResolvedCharStyle, ResolvedParaStyle};
        ResolvedStyleSet {
            font_metrics_policy: FontMetricsPolicy::HcrDeclared,
            char_styles: vec![ResolvedCharStyle {
                font_metrics_policy: FontMetricsPolicy::HcrDeclared,
                font_family: "Arial".into(),
                font_size: 12.0,
                ..Default::default()
            }],
            para_styles: vec![ResolvedParaStyle {
                alignment: Alignment::Left,
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    // Seed source IR and explicit page-item input, never a prebuilt render tree.
    // All geometry, clips and query caches are produced by the real renderer.
    fn paint_core(
        paragraphs: Vec<Paragraph>,
        page: crate::renderer::pagination::PageContent,
    ) -> crate::document_core::DocumentCore {
        use crate::model::document::Section;
        use crate::renderer::pagination::PaginationResult;
        let mut core = crate::document_core::DocumentCore::new_empty();
        core.dpi = 7200.0;
        core.layout_engine = LayoutEngine::new(core.dpi);
        core.styles = paint_styles();
        core.composed = vec![paragraphs
            .iter()
            .map(|para| {
                crate::renderer::composer::compose_paragraph_with_styles(para, &core.styles)
            })
            .collect()];
        core.para_column_map = vec![vec![0; paragraphs.len()]];
        core.document.sections = vec![Section {
            paragraphs,
            ..Default::default()
        }];
        core.pagination = vec![PaginationResult {
            committed_line_origins: vec![],
            pages: vec![page],
            wrap_around_paras: vec![],
            hidden_empty_paras: Default::default(),
            pre_emitted_host_paras: Default::default(),
            pre_emitted_host_heights: Default::default(),
            fresh_page_float_tables: Default::default(),
            endnotes: vec![],
            endnote_paragraphs: vec![],
            endnote_para_sources: vec![],
            endnote_between_notes_hu: 0,
            endnote_separator_above_hu: 0,
            endnote_separator_below_hu: 0,
        }];
        core.measured_tables = vec![vec![]];
        core.dirty_sections = vec![false];
        core.dirty_paragraphs = vec![None];
        core
    }

    fn paint_page(
        host: &Paragraph,
        partial: bool,
        include_object: bool,
    ) -> crate::renderer::pagination::PageContent {
        paint_page_for_source_paragraph(host, partial, include_object, 0)
    }

    fn paint_page_for_source_paragraph(
        host: &Paragraph,
        partial: bool,
        include_object: bool,
        source_para: usize,
    ) -> crate::renderer::pagination::PageContent {
        use crate::renderer::pagination::PageItem;
        let mut result = page(400.0, one_area());
        if partial {
            let Control::Table(table) = &host.controls[0] else {
                unreachable!()
            };
            let engine = LayoutEngine::new(7200.0);
            let styles = paint_styles();
            let count = engine.cell_units(&table.cells[0], table, &styles).len();
            assert!(count > 0);
            assert!(
                engine.cell_cut_contains_non_inline_control_units(
                    &table.cells[0],
                    table,
                    &styles,
                    0,
                    count,
                    source_para,
                ),
                "the real partial-table control-unit branch must be reachable"
            );
            result.column_contents[0].items = vec![PageItem::PartialTable {
                para_index: 0,
                control_index: 0,
                start_row: 0,
                end_row: 1,
                is_continuation: true,
                start_cut: vec![0],
                end_cut: vec![if include_object { count } else { 0 }],
                is_block_split: false,
                allocated_row_heights: vec![],
            }];
        }
        result
    }

    fn text_node<'a>(node: &'a RenderNode, text: &str) -> Option<&'a RenderNode> {
        if matches!(&node.node_type, RenderNodeType::TextRun(run) if run.text == text) {
            return Some(node);
        }
        node.children
            .iter()
            .find_map(|child| text_node(child, text))
    }

    fn ancestors<'a>(node: &'a RenderNode, target: u32, out: &mut Vec<&'a RenderNode>) -> bool {
        if node.id == target {
            return true;
        }
        for child in &node.children {
            if ancestors(child, target, out) {
                out.push(node);
                return true;
            }
        }
        false
    }

    fn assert_unique_ids(node: &RenderNode, ids: &mut std::collections::HashSet<u32>) {
        assert!(
            ids.insert(node.id),
            "node IDs must survive a move without duplication"
        );
        for child in &node.children {
            assert_unique_ids(child, ids);
        }
    }

    fn one_decimal(value: f64) -> f64 {
        format!("{value:.1}").parse().unwrap()
    }

    #[test]
    fn paper_textbox_full_and_partial_pages_keep_paint_scope_and_public_paths() {
        let path = serde_json::json!([
            {"controlIndex":0,"cellIndex":0,"cellParaIndex":0},
            {"controlIndex":1,"cellIndex":0,"cellParaIndex":0},
        ]);
        for partial in [false, true] {
            let host = paper_paint_host("AB", false);
            let core = paint_core(vec![host.clone()], paint_page(&host, partial, true));
            let tree = core.build_page_render_tree(0).unwrap();
            let text = text_node(&tree.root, "AB").expect("real textbox glyph run emitted");
            let RenderNodeType::TextRun(run) = &text.node_type else {
                unreachable!()
            };
            let mut chain = vec![];
            assert!(ancestors(&tree.root, text.id, &mut chain));
            assert!(chain
                .iter()
                .any(|n| matches!(n.node_type, RenderNodeType::TextBox)));
            assert!(!chain.iter().any(|n| matches!(
                n.node_type,
                RenderNodeType::TableCell(_) | RenderNodeType::Body { .. }
            )));
            let source = run
                .cell_context
                .as_ref()
                .expect("explicit source path retained");
            assert_eq!(source.parent_para_index, 0);
            assert_eq!(source.path.len(), 2);
            assert_eq!(source.path[0].control_index, 0);
            assert_eq!(source.path[1].control_index, 1);
            let paper_nodes: Vec<_> = tree
                .root
                .children
                .iter()
                .filter(|n| {
                    matches!(n.node_type, RenderNodeType::Rectangle(_))
                        && n.bbox.width == 40.0
                        && n.bbox.height == 30.0
                })
                .collect();
            assert_eq!(paper_nodes.len(), 1);
            assert_eq!(
                (paper_nodes[0].bbox.x, paper_nodes[0].bbox.y),
                (353.0, 11.0)
            );
            assert!(!paper_nodes[0].layer.unwrap().local_to_parent);
            let RenderNodeType::Rectangle(rect) = &paper_nodes[0].node_type else {
                unreachable!()
            };
            assert_eq!(
                (rect.section_index, rect.para_index, rect.control_index),
                (Some(0), Some(0), Some(1))
            );
            assert_eq!(
                (
                    rect.cell_index,
                    rect.cell_para_index,
                    rect.outer_table_control_index
                ),
                (Some(0), Some(0), Some(0))
            );
            assert_unique_ids(&tree.root, &mut Default::default());
            let positions = crate::renderer::layout::compute_char_positions(&run.text, &run.style);
            assert!(positions.len() >= 3 && positions[1] > 0.0);
            for offset in [0, 1] {
                let caret: serde_json::Value = serde_json::from_str(
                    &core
                        .get_cursor_rect_by_path_native(0, 0, &path.to_string(), offset)
                        .unwrap(),
                )
                .unwrap();
                assert_eq!(caret["x"], one_decimal(text.bbox.x + positions[offset]));
                assert_eq!(caret["y"], one_decimal(text.bbox.y));
                assert!(caret.get("cellBounds").is_none());
                assert!(caret.get("cellOverflowed").is_none());
            }
            let hit: serde_json::Value = serde_json::from_str(
                &core
                    .hit_test_native(
                        0,
                        text.bbox.x + positions[1] * 0.25,
                        text.bbox.y + text.bbox.height * 0.5,
                    )
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(hit["cellPath"], path);
            assert_eq!(hit["charOffset"], 0);
            assert_eq!(hit["parentParaIndex"], 0);
            let query: serde_json::Value =
                serde_json::from_str(&core.get_page_control_layout_native(0).unwrap()).unwrap();
            assert!(
                query["controls"].as_array().unwrap().iter().any(|control| {
                    control["controlIdx"] == 1
                        && control["cellIdx"] == 0
                        && control["outerTableControlIdx"] == 0
                        && control["x"] == 353.0
                }),
                "hoisting must retain the existing public control identity"
            );
            let cells: serde_json::Value =
                serde_json::from_str(&core.get_table_cell_bboxes_native(0, 0, 0).unwrap()).unwrap();
            assert!(!cells.as_array().unwrap().is_empty());
            assert!(text.bbox.y < cells[0]["y"].as_f64().unwrap());
            let mut svg = crate::renderer::svg::SvgRenderer::new();
            svg.render_tree(&tree);
            let own_textbox = chain
                .iter()
                .find(|n| matches!(n.node_type, RenderNodeType::TextBox))
                .unwrap();
            assert!(svg
                .output()
                .contains(&format!("textbox-clip-{}", own_textbox.id)));
            #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
            {
                let blank_host = paper_paint_host("", false);
                let blank = paint_core(
                    vec![blank_host.clone()],
                    paint_page(&blank_host, partial, true),
                );
                let painted = image::load_from_memory(&core.render_page_png_native(0).unwrap())
                    .unwrap()
                    .to_rgb8();
                let empty = image::load_from_memory(&blank.render_page_png_native(0).unwrap())
                    .unwrap()
                    .to_rgb8();
                assert_eq!(painted.dimensions(), empty.dimensions());
                let ink_changes = (text.bbox.y.max(0.0).floor() as u32
                    ..(text.bbox.y + text.bbox.height).ceil() as u32)
                    .flat_map(|y| {
                        (text.bbox.x.max(0.0).floor() as u32
                            ..(text.bbox.x + text.bbox.width).ceil() as u32)
                            .map(move |x| (x, y))
                    })
                    .any(|(x, y)| painted.get_pixel(x, y) != empty.get_pixel(x, y));
                assert!(
                    ink_changes,
                    "real public PNG path must paint glyphs outside the cell"
                );
            }
        }
    }

    #[test]
    fn paper_textbox_partial_cut_does_not_repeat_excluded_controls() {
        let host = paper_paint_host("AB", false);
        let core = paint_core(vec![host.clone()], paint_page(&host, true, false));
        let tree = core.build_page_render_tree(0).unwrap();
        assert!(text_node(&tree.root, "AB").is_none());
        assert!(tree
            .root
            .children
            .iter()
            .all(|n| !matches!(n.node_type, RenderNodeType::Rectangle(_)) || n.bbox.y != 11.0));
    }

    #[test]
    fn ordinary_cell_textbox_keeps_ancestral_clip_and_path_caret_clamp() {
        let path = r#"[{"controlIndex":0,"cellIndex":0,"cellParaIndex":0},{"controlIndex":1,"cellIndex":0,"cellParaIndex":0}]"#;
        for partial in [false, true] {
            let host = paper_paint_host("AB", true);
            let core = paint_core(vec![host.clone()], paint_page(&host, partial, true));
            let tree = core.build_page_render_tree(0).unwrap();
            let text = text_node(&tree.root, "AB").expect("ordinary textbox still emitted");
            let mut chain = vec![];
            assert!(ancestors(&tree.root, text.id, &mut chain));
            let cell = chain
                .iter()
                .find(|n| matches!(n.node_type, RenderNodeType::TableCell(_)))
                .expect("ordinary textbox stays inside its real cell");
            assert!(matches!(&cell.node_type, RenderNodeType::TableCell(c) if c.clip));
            assert!(chain
                .iter()
                .any(|n| n.layer.is_some_and(|layer| layer.local_to_parent)));
            assert!(text.bbox.y + text.bbox.height < cell.bbox.y);
            let caret: serde_json::Value =
                serde_json::from_str(&core.get_cursor_rect_by_path_native(0, 0, path, 0).unwrap())
                    .unwrap();
            assert_eq!(caret["cellOverflowed"], true);
            assert_eq!(caret["cellBounds"]["y"], one_decimal(cell.bbox.y));
            #[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
            {
                let blank_host = paper_paint_host("", true);
                let blank = paint_core(
                    vec![blank_host.clone()],
                    paint_page(&blank_host, partial, true),
                );
                let painted = image::load_from_memory(&core.render_page_png_native(0).unwrap())
                    .unwrap()
                    .to_rgb8();
                let empty = image::load_from_memory(&blank.render_page_png_native(0).unwrap())
                    .unwrap()
                    .to_rgb8();
                assert_eq!(
                    painted, empty,
                    "ordinary cell clipping must still hide outside glyphs"
                );
            }
        }
    }

    fn root_labels(tree: &PageRenderTree) -> Vec<String> {
        tree.root
            .children
            .iter()
            .filter_map(|node| {
                fn label(node: &RenderNode, out: &mut String) {
                    if let RenderNodeType::TextRun(run) = &node.node_type {
                        out.push_str(&run.text);
                    }
                    for child in &node.children {
                        label(child, out);
                    }
                }
                let mut text = String::new();
                label(node, &mut text);
                (!text.is_empty()).then_some(text)
            })
            .collect()
    }

    #[test]
    fn paper_textbox_equal_key_order_precedes_later_root_shape() {
        use crate::renderer::pagination::PageItem;
        let mut host = paper_paint_host("A", false);
        host.controls
            .insert(1, Control::Shape(Box::new(paper_text_shape("B"))));
        host.char_count += 8;
        let mut page = paint_page(&host, false, true);
        page.column_contents[0].items.push(PageItem::Shape {
            para_index: 0,
            control_index: 1,
        });
        let core = paint_core(vec![host], page);
        let tree = core.build_page_render_tree(0).unwrap();
        assert_eq!(root_labels(&tree), vec!["A", "B"]);
        let shapes: Vec<_> = tree
            .root
            .children
            .iter()
            .filter(|n| matches!(n.node_type, RenderNodeType::Rectangle(_)) && n.bbox.width == 40.0)
            .collect();
        assert_eq!(shapes.len(), 2);
        assert_eq!(
            LayoutEngine::paper_node_sort_key(shapes[0]),
            LayoutEngine::paper_node_sort_key(shapes[1])
        );
        assert_eq!(
            (shapes[0].bbox.x, shapes[0].bbox.y),
            (shapes[1].bbox.x, shapes[1].bbox.y)
        );
    }

    #[test]
    fn paper_textbox_equal_key_order_precedes_later_first_pass_picture() {
        use crate::renderer::pagination::PageItem;
        let mut host = paper_paint_host("A", false);
        let mut picture = crate::model::image::Picture::default();
        picture.common = paper_text_shape("B").common().clone();
        host.controls.insert(1, Control::Picture(Box::new(picture)));
        host.char_count += 8;
        let mut page = paint_page(&host, false, true);
        page.column_contents[0].items.push(PageItem::Shape {
            para_index: 0,
            control_index: 1,
        });
        let core = paint_core(vec![host], page);
        let tree = core.build_page_render_tree(0).unwrap();
        let shape_index = tree
            .root
            .children
            .iter()
            .position(|n| text_node(n, "A").is_some())
            .unwrap();
        let picture_index = tree
            .root
            .children
            .iter()
            .position(|n| {
                matches!(
                    n.node_type,
                    RenderNodeType::Image(_) | RenderNodeType::Placeholder(_)
                )
            })
            .expect("actual first-pass picture emitted");
        assert!(shape_index < picture_index);
        let first = &tree.root.children[shape_index];
        let second = &tree.root.children[picture_index];
        assert_eq!(
            LayoutEngine::paper_node_sort_key(first),
            LayoutEngine::paper_node_sort_key(second)
        );
    }

    #[test]
    fn paper_parent_then_nested_child_keeps_same_iteration_and_next_shape_order() {
        use crate::model::shape::TextWrap;
        use crate::renderer::pagination::PageItem;
        for parent_tie in [false, true] {
            let mut host = paper_paint_host("A", false);
            let Control::Table(table) = &mut host.controls[0] else {
                unreachable!()
            };
            if parent_tie {
                table.cells[0].paragraphs[0].controls.remove(0);
                table.cells[0].paragraphs[0].char_count = 9;
            }
            // Outer table and the following shape are both collected in shapes pass.
            table.common.horz_rel_to = HorzRelTo::Paper;
            table.common.vert_rel_to = VertRelTo::Paper;
            table.common.text_wrap = TextWrap::InFrontOfText;
            host.controls
                .insert(1, Control::Shape(Box::new(paper_text_shape("B"))));
            if let Control::Table(table) = &mut host.controls[0] {
                let target = if parent_tie { 0 } else { 1 };
                if let Control::Shape(shape) = &mut table.cells[0].paragraphs[0].controls[target] {
                    shape.common_mut().text_wrap = TextWrap::InFrontOfText;
                }
            }
            if let Control::Shape(shape) = &mut host.controls[1] {
                shape.common_mut().text_wrap = TextWrap::InFrontOfText;
            }
            host.char_count += 8;
            let mut page = paint_page(&host, false, true);
            page.column_contents[0].items = vec![
                PageItem::Shape {
                    para_index: 0,
                    control_index: 0,
                },
                PageItem::Shape {
                    para_index: 0,
                    control_index: 1,
                },
            ];
            let core = paint_core(vec![host], page);
            let tree = core.build_page_render_tree(0).unwrap();
            let parent_index = tree
                .root
                .children
                .iter()
                .position(|n| matches!(n.node_type, RenderNodeType::Table(_)))
                .expect("real Paper parent table emitted");
            let child_index = tree
                .root
                .children
                .iter()
                .position(|n| text_node(n, "A").is_some())
                .unwrap();
            let later_index = tree
                .root
                .children
                .iter()
                .position(|n| text_node(n, "B").is_some())
                .unwrap();
            assert!(parent_index < child_index && child_index < later_index);
            let tied_first = if parent_tie {
                parent_index
            } else {
                child_index
            };
            let tied_second = if parent_tie { child_index } else { later_index };
            assert_eq!(
                LayoutEngine::paper_node_sort_key(&tree.root.children[tied_first]),
                LayoutEngine::paper_node_sort_key(&tree.root.children[tied_second])
            );
        }
    }

    #[test]
    fn paper_rectangle_without_textbox_keeps_its_existing_cell_paint_scope() {
        let host = tree_host(shape(), true);
        let core = paint_core(vec![host.clone()], paint_page(&host, false, true));
        let tree = core.build_page_render_tree(0).unwrap();
        fn target(node: &RenderNode) -> Option<&RenderNode> {
            if matches!(node.node_type, RenderNodeType::Rectangle(_))
                && node.bbox.width == 40.0
                && node.bbox.height == 30.0
            {
                return Some(node);
            }
            node.children.iter().find_map(target)
        }
        let node = target(&tree.root).unwrap();
        assert_eq!((node.bbox.x, node.bbox.y), (353.0, 11.0));
        let mut chain = vec![];
        assert!(ancestors(&tree.root, node.id, &mut chain));
        assert!(chain
            .iter()
            .any(|n| matches!(n.node_type, RenderNodeType::TableCell(_))));
        assert!(node.layer.unwrap().local_to_parent);
    }

    #[test]
    fn paper_textboxes_keep_existing_planes_with_overlapping_frames() {
        use crate::model::shape::TextWrap;
        use crate::renderer::pagination::PageItem;
        let mut host = paper_paint_host("A", false);
        for (text, wrap) in [("B", TextWrap::InFrontOfText), ("C", TextWrap::BehindText)] {
            let mut object = paper_text_shape(text);
            object.common_mut().text_wrap = wrap;
            host.controls.push(Control::Shape(Box::new(object)));
            host.char_count += 8;
        }
        let mut page = paint_page(&host, false, true);
        page.column_contents[0].items.extend([
            PageItem::Shape {
                para_index: 0,
                control_index: 2,
            },
            PageItem::Shape {
                para_index: 0,
                control_index: 3,
            },
        ]);
        let core = paint_core(vec![host], page);
        let tree = core.build_page_render_tree(0).unwrap();
        assert!(tree
            .root
            .children
            .iter()
            .any(|n| matches!(n.node_type, RenderNodeType::Body { .. })));
        assert_eq!(root_labels(&tree), vec!["C", "A", "B"]);
        let objects: Vec<_> = tree
            .root
            .children
            .iter()
            .filter(|n| {
                ["A", "B", "C"]
                    .iter()
                    .any(|text| text_node(n, text).is_some())
            })
            .collect();
        assert_eq!(
            objects
                .iter()
                .map(|n| LayoutEngine::paper_node_sort_key(n).0)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        for object in objects {
            assert_eq!(
                (
                    object.bbox.x,
                    object.bbox.y,
                    object.bbox.width,
                    object.bbox.height
                ),
                (353.0, 11.0, 40.0, 30.0)
            );
            assert!(!object.layer.unwrap().local_to_parent);
        }
    }

    fn blank_query_host() -> Paragraph {
        let mut host = paper_paint_host("1", false);
        let Control::Table(table) = &mut host.controls[0] else {
            unreachable!()
        };
        let Control::Shape(target) = &mut table.cells[0].paragraphs[0].controls[1] else {
            unreachable!()
        };
        target.common_mut().horz_align = HorzAlign::Left;
        target.common_mut().horizontal_offset = 200;
        target.common_mut().vertical_offset = 90;
        target
            .drawing_mut()
            .unwrap()
            .text_box
            .as_mut()
            .unwrap()
            .paragraphs[0]
            .para_shape_id = 1;
        host
    }

    fn add_right_textbox_style(core: &mut crate::document_core::DocumentCore) {
        core.styles
            .para_styles
            .push(crate::renderer::style_resolver::ResolvedParaStyle {
                alignment: Alignment::Right,
                ..Default::default()
            });
    }

    fn source_text_paragraph(text: &str) -> Paragraph {
        paper_text_shape(text)
            .drawing()
            .unwrap()
            .text_box
            .as_ref()
            .unwrap()
            .paragraphs[0]
            .clone()
    }

    #[test]
    fn detached_textbox_blank_queries_keep_full_owner_inside_and_outside_parent_cell() {
        for (partial, host_para) in [(false, 0), (true, 0), (false, 2), (true, 2)] {
            let expected = serde_json::json!([
                {"controlIndex":0,"cellIndex":0,"cellParaIndex":host_para},
                {"controlIndex":1,"cellIndex":0,"cellParaIndex":0},
            ]);
            let mut host = blank_query_host();
            if host_para == 2 {
                let Control::Table(table) = &mut host.controls[0] else {
                    unreachable!()
                };
                let target = table.cells[0].paragraphs[0].clone();
                let mut prefix = target.clone();
                prefix.controls.truncate(1);
                prefix.char_count = 9;
                // Keep two preceding source paragraphs while the target remains
                // owned by paragraph2.
                table.cells[0].paragraphs = vec![prefix, source_text_paragraph("middle"), target];
            }
            let mut page = paint_page_for_source_paragraph(&host, partial, true, host_para);
            if let crate::renderer::pagination::PageItem::PartialTable {
                allocated_row_heights,
                ..
            } = &mut page.column_contents[0].items[0]
            {
                *allocated_row_heights = vec![(0, 180.0)];
            }
            let mut core = paint_core(vec![host.clone()], page);
            add_right_textbox_style(&mut core);
            let tree = core.build_page_render_tree(0).unwrap();
            let run = text_node(&tree.root, "1").unwrap();
            let mut chain = vec![];
            assert!(ancestors(&tree.root, run.id, &mut chain));
            let own = chain
                .iter()
                .find(|n| matches!(n.node_type, RenderNodeType::TextBox))
                .unwrap();
            let cells: serde_json::Value =
                serde_json::from_str(&core.get_table_cell_bboxes_native(0, 0, 0).unwrap()).unwrap();
            let cy = cells[0]["y"].as_f64().unwrap();
            let points = [
                (own.bbox.x + 1.0, own.bbox.y + 1.0, 0, false),
                (
                    own.bbox.x + 1.0,
                    own.bbox.y + own.bbox.height * 0.5,
                    0,
                    true,
                ),
                (
                    run.bbox.x + run.bbox.width * 0.9,
                    own.bbox.y + own.bbox.height * 0.99,
                    1,
                    true,
                ),
            ];
            for (x, y, offset, inside_cell) in points {
                assert!(
                    x >= own.bbox.x
                        && x <= own.bbox.x + own.bbox.width
                        && y >= own.bbox.y
                        && y <= own.bbox.y + own.bbox.height
                );
                assert!(
                    !(x >= run.bbox.x
                        && x <= run.bbox.x + run.bbox.width
                        && y >= run.bbox.y
                        && y <= run.bbox.y + run.bbox.height)
                );
                assert_eq!(y >= cy, inside_cell);
                let hit: serde_json::Value =
                    serde_json::from_str(&core.hit_test_native(0, x, y).unwrap()).unwrap();
                assert_eq!(
                    hit["cellPath"], expected,
                    "partial={partial}, point=({x},{y})"
                );
                assert_eq!(hit["charOffset"], offset);
            }
            let outside: serde_json::Value = serde_json::from_str(
                &core
                    .hit_test_native(0, own.bbox.x + 1.0, cy + 170.0)
                    .unwrap(),
            )
            .unwrap();
            assert_ne!(
                outside["cellPath"], expected,
                "detached text must not become global nearest cell text"
            );
            if partial {
                // A repeated source fragment on another page must not fabricate a table ID
                // or retain a textbox whose control unit was excluded on that page.
                let mut second = paint_page_for_source_paragraph(&host, true, false, host_para);
                second.page_index = 1;
                second.page_number = 2;
                if let crate::renderer::pagination::PageItem::PartialTable {
                    allocated_row_heights,
                    ..
                } = &mut second.column_contents[0].items[0]
                {
                    *allocated_row_heights = vec![(0, 180.0)];
                }
                core.pagination[0].pages.push(second);
                let other = core.build_page_render_tree(1).unwrap();
                assert!(text_node(&other.root, "1").is_none());
                let hit: serde_json::Value = serde_json::from_str(
                    &core.hit_test_native(1, points[2].0, points[2].1).unwrap(),
                )
                .unwrap();
                assert_ne!(hit["cellPath"], expected);
            }
        }
    }

    #[test]
    fn detached_textbox_blank_queries_do_not_alias_a_sibling_cell_index_zero() {
        let mut host = blank_query_host();
        let Control::Table(table) = &mut host.controls[0] else {
            unreachable!()
        };
        let mut target_cell = table.cells[0].clone();
        target_cell.width = 100;
        target_cell.col = 1;
        let Control::Shape(target) = &mut target_cell.paragraphs[0].controls[1] else {
            unreachable!()
        };
        target.common_mut().horizontal_offset = 110;
        let first = crate::model::table::Cell {
            width: 100,
            height: 180,
            row_span: 1,
            col_span: 1,
            paragraphs: vec![source_text_paragraph("Z")],
            ..Default::default()
        };
        table.col_count = 2;
        table.cells = vec![first, target_cell];
        table.cell_grid = vec![Some(0), Some(1)];
        let mut core = paint_core(vec![host.clone()], paint_page(&host, false, true));
        add_right_textbox_style(&mut core);
        let tree = core.build_page_render_tree(0).unwrap();
        let target = text_node(&tree.root, "1").unwrap();
        let mut chain = vec![];
        assert!(ancestors(&tree.root, target.id, &mut chain));
        let own = chain
            .iter()
            .find(|n| matches!(n.node_type, RenderNodeType::TextBox))
            .unwrap();
        let hit: serde_json::Value = serde_json::from_str(
            &core
                .hit_test_native(
                    0,
                    target.bbox.x + target.bbox.width * 0.9,
                    own.bbox.y + own.bbox.height * 0.99,
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            hit["cellPath"],
            serde_json::json!([{"controlIndex":0,"cellIndex":0,"cellParaIndex":0}])
        );
        assert_eq!(
            hit["cellPath"].as_array().unwrap().len(),
            1,
            "the other cell's textbox sentinel cellIndex0 is not this real cell"
        );
    }

    #[test]
    fn detached_textbox_blank_queries_preserve_real_inner_table_cell_priority() {
        use crate::model::shape::TextBox;
        use crate::model::table::{Cell, Table};
        let mut inner = Table {
            row_count: 1,
            col_count: 1,
            cells: vec![Cell {
                width: 80,
                height: 40,
                row_span: 1,
                col_span: 1,
                paragraphs: vec![source_text_paragraph("X")],
                ..Default::default()
            }],
            cell_grid: vec![Some(0)],
            ..Default::default()
        };
        inner.common.width = 80;
        inner.common.height = 40;
        inner.common.treat_as_char = true;
        let mut shape = paper_text_shape("1");
        shape.common_mut().width = 200;
        shape.common_mut().height = 150;
        shape.common_mut().horz_align = HorzAlign::Left;
        shape.common_mut().horizontal_offset = 150;
        shape.common_mut().vertical_offset = 90;
        shape.drawing_mut().unwrap().text_box = Some(TextBox {
            paragraphs: vec![
                source_text_paragraph("1"),
                Paragraph {
                    char_count: 9,
                    controls: vec![Control::Table(Box::new(inner))],
                    ..Default::default()
                },
            ],
            ..Default::default()
        });
        let mut host = paper_paint_host("1", false);
        let Control::Table(table) = &mut host.controls[0] else {
            unreachable!()
        };
        table.cells[0].paragraphs[0].controls[1] = Control::Shape(Box::new(shape));
        let core = paint_core(vec![host.clone()], paint_page(&host, false, true));
        let tree = core.build_page_render_tree(0).unwrap();
        let text = text_node(&tree.root, "X").expect("actual embedded-table text must render");
        let mut chain = vec![];
        assert!(ancestors(&tree.root, text.id, &mut chain));
        let cell = chain
            .iter()
            .find(|n| matches!(n.node_type, RenderNodeType::TableCell(_)))
            .unwrap();
        let hit: serde_json::Value = serde_json::from_str(
            &core
                .hit_test_native(
                    0,
                    cell.bbox.x + cell.bbox.width * 0.9,
                    cell.bbox.y + cell.bbox.height * 0.9,
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            hit["cellPath"],
            serde_json::json!([
                {"controlIndex":0,"cellIndex":0,"cellParaIndex":0},
                {"controlIndex":1,"cellIndex":0,"cellParaIndex":1},
                {"controlIndex":0,"cellIndex":0,"cellParaIndex":0},
            ])
        );
        assert_eq!(hit["charOffset"], 1);
    }

    #[test]
    fn ordinary_root_textbox_blank_entry_keeps_its_existing_single_path_policy() {
        use crate::renderer::pagination::PageItem;
        let mut object = paper_text_shape("1");
        object.common_mut().horz_align = HorzAlign::Left;
        object.common_mut().horizontal_offset = 200;
        object.common_mut().vertical_offset = 90;
        object
            .drawing_mut()
            .unwrap()
            .text_box
            .as_mut()
            .unwrap()
            .paragraphs[0]
            .para_shape_id = 1;
        let source = Paragraph {
            char_count: 17,
            controls: vec![
                Control::Shape(Box::new(object)),
                Control::SectionDef(Box::default()),
            ],
            ..Default::default()
        };
        let mut page = page(400.0, one_area());
        page.column_contents[0].items = vec![PageItem::Shape {
            para_index: 0,
            control_index: 0,
        }];
        let mut core = paint_core(vec![source], page);
        add_right_textbox_style(&mut core);
        let tree = core.build_page_render_tree(0).unwrap();
        let run = text_node(&tree.root, "1").unwrap();
        let mut chain = vec![];
        assert!(ancestors(&tree.root, run.id, &mut chain));
        let own = chain
            .iter()
            .find(|n| matches!(n.node_type, RenderNodeType::TextBox))
            .unwrap();
        let hit: serde_json::Value = serde_json::from_str(
            &core
                .hit_test_native(
                    0,
                    run.bbox.x + run.bbox.width * 0.9,
                    own.bbox.y + own.bbox.height * 0.99,
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            hit["cellPath"],
            serde_json::json!([{"controlIndex":0,"cellIndex":0,"cellParaIndex":0}])
        );
        assert_eq!(
            hit["charOffset"], 0,
            "existing top-level textbox blank entry begins at the first paragraph"
        );
    }

    #[test]
    fn empty_detached_textbox_blank_queries_preserve_supported_full_path() {
        for partial in [false, true] {
            let mut host = paper_paint_host("", false);
            let Control::Table(table) = &mut host.controls[0] else {
                unreachable!()
            };
            let Control::Shape(target) = &mut table.cells[0].paragraphs[0].controls[1] else {
                unreachable!()
            };
            target.common_mut().horz_align = HorzAlign::Left;
            target.common_mut().horizontal_offset = 200;
            target.common_mut().vertical_offset = 140;
            let mut page = paint_page(&host, partial, true);
            if let crate::renderer::pagination::PageItem::PartialTable {
                allocated_row_heights,
                ..
            } = &mut page.column_contents[0].items[0]
            {
                *allocated_row_heights = vec![(0, 180.0)];
            }
            let core = paint_core(vec![host], page);
            let tree = core.build_page_render_tree(0).unwrap();
            fn empty_box(node: &RenderNode) -> Option<&RenderNode> {
                if matches!(node.node_type, RenderNodeType::TextBox) {
                    return Some(node);
                }
                node.children.iter().find_map(empty_box)
            }
            let own = empty_box(&tree.root).expect("actual empty textbox emitted");
            let empty = text_node(own, "").expect("actual empty caret TextRun emitted");
            assert!(
                matches!(&empty.node_type, RenderNodeType::TextRun(run) if run.char_start == Some(0))
            );
            let x = own.bbox.x + own.bbox.width * 0.9;
            let y = own.bbox.y + own.bbox.height * 0.9;
            assert!(
                y > empty.bbox.y + empty.bbox.height,
                "point is lower blank, not an exact empty-run hit"
            );
            let hit: serde_json::Value =
                serde_json::from_str(&core.hit_test_native(0, x, y).unwrap()).unwrap();
            // The same fixture returned this full path before paint detachment.
            assert_eq!(hit["charOffset"], 0);
            assert_eq!(
                hit["cellPath"],
                serde_json::json!([
                    {"controlIndex":0,"cellIndex":0,"cellParaIndex":0},
                    {"controlIndex":1,"cellIndex":0,"cellParaIndex":0}
                ])
            );
        }
    }

    #[test]
    fn detached_textbox_blank_queries_only_precede_strict_ancestor_glyph_hits() {
        let mut host = blank_query_host();
        let Control::Table(table) = &mut host.controls[0] else {
            unreachable!()
        };
        let target = table.cells[0].paragraphs[0].clone();
        let heading = "WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW";
        table.cells[0].paragraphs = vec![source_text_paragraph(heading), target];
        let mut core = paint_core(vec![host.clone()], paint_page(&host, false, true));
        add_right_textbox_style(&mut core);
        let tree = core.build_page_render_tree(0).unwrap();
        let target_run = text_node(&tree.root, "1").unwrap();
        let ancestor_run = text_node(&tree.root, heading).unwrap();
        let mut chain = vec![];
        assert!(ancestors(&tree.root, target_run.id, &mut chain));
        let own = chain
            .iter()
            .find(|n| matches!(n.node_type, RenderNodeType::TextBox))
            .unwrap();
        let x = (own.bbox.x + 1.0).max(ancestor_run.bbox.x + 1.0);
        let y = (own.bbox.y + 1.0).max(ancestor_run.bbox.y + ancestor_run.bbox.height * 0.5);
        assert!(x < ancestor_run.bbox.x + ancestor_run.bbox.width);
        assert!(y < ancestor_run.bbox.y + ancestor_run.bbox.height);
        assert!(x < own.bbox.x + own.bbox.width && y < own.bbox.y + own.bbox.height);
        assert!(
            x < target_run.bbox.x,
            "point is blank in the containing textbox"
        );
        let hit: serde_json::Value =
            serde_json::from_str(&core.hit_test_native(0, x, y).unwrap()).unwrap();
        assert_eq!(
            hit["cellPath"],
            serde_json::json!([
                {"controlIndex":0,"cellIndex":0,"cellParaIndex":1},
                {"controlIndex":1,"cellIndex":0,"cellParaIndex":0}
            ])
        );
        assert_eq!(hit["charOffset"], 0);

        // A real glyph from a different overlapping textbox is not an ancestor.
        // It retains exact-hit priority even inside the first textbox's blank area.
        let mut host = blank_query_host();
        let Control::Table(table) = &mut host.controls[0] else {
            unreachable!()
        };
        let mut other = paper_text_shape("W");
        other.common_mut().horz_align = HorzAlign::Left;
        other.common_mut().horizontal_offset = 201;
        other.common_mut().vertical_offset = 100;
        table.cells[0].paragraphs[0]
            .controls
            .push(Control::Shape(Box::new(other)));
        table.cells[0].paragraphs[0].char_count += 8;
        let mut core = paint_core(vec![host.clone()], paint_page(&host, false, true));
        add_right_textbox_style(&mut core);
        let tree = core.build_page_render_tree(0).unwrap();
        let other_run = text_node(&tree.root, "W").unwrap();
        let target_run = text_node(&tree.root, "1").unwrap();
        let x = other_run.bbox.x + other_run.bbox.width * 0.5;
        let y = other_run.bbox.y + other_run.bbox.height * 0.5;
        let mut chain = vec![];
        assert!(ancestors(&tree.root, target_run.id, &mut chain));
        let own = chain
            .iter()
            .find(|n| matches!(n.node_type, RenderNodeType::TextBox))
            .unwrap();
        assert!(x >= own.bbox.x && x <= own.bbox.x + own.bbox.width);
        assert!(y >= own.bbox.y && y <= own.bbox.y + own.bbox.height);
        assert!(x < target_run.bbox.x);
        let hit: serde_json::Value =
            serde_json::from_str(&core.hit_test_native(0, x, y).unwrap()).unwrap();
        assert_eq!(
            hit["cellPath"],
            serde_json::json!([
                {"controlIndex":0,"cellIndex":0,"cellParaIndex":0},
                {"controlIndex":2,"cellIndex":0,"cellParaIndex":0}
            ])
        );
    }
}

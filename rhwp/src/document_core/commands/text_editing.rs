//! 텍스트 삽입/삭제/문단 분리·병합/범위 삭제/문단 쿼리 관련 native 메서드

use super::super::helpers::get_textbox_from_shape;
use super::super::queries::field_query::rebuild_char_offsets;
use crate::document_core::{
    ActiveFieldInfo, DeferredPaginationDescriptor, DeferredPaginationTargetStatus, DocumentCore,
};
use crate::error::HwpError;
use crate::model::control::{Control, FieldType};
use crate::model::event::DocumentEvent;
use crate::model::page::ColumnDef;
use crate::model::paragraph::{ParaMeta, Paragraph};
use crate::model::shape::{ShapeObject, TextWrap, VertRelTo};
use crate::model::style::ParaShapeMods;
use crate::renderer::composer::{
    compose_paragraph, reflow_line_segs, reflow_line_segs_with_squeeze, ComposedParagraph,
};
use crate::renderer::page_layout::PageLayoutInfo;
use crate::renderer::pagination::PageItem;
use crate::renderer::style_resolver::ResolvedStyleSet;

/// 셀·글상자·캡션 문단 줄 폭 하한(HWPUNIT, 0.2인치). 한컴은 이보다 좁은 안 영역에서도
/// 줄 폭을 1440 으로 저장하고 그 폭으로 줄을 나눈다 (코퍼스 2.1만 문단 실측).
pub(crate) const MIN_CONTAINER_LINE_WIDTH_HU: i64 = 1440;

/// 표 셀의 `줄 넘침: 글자 줄임`(Squeeze) 여부.
pub(crate) fn cell_squeezes(control: &Control, cell_idx: usize) -> bool {
    matches!(control, Control::Table(t)
    if t.cells.get(cell_idx).is_some_and(|c| {
        c.line_wrap == crate::model::table::CellLineWrap::Squeeze
    }))
}

/// 셀 문단 줄 합성. 셀이 `글자 줄임`(Squeeze)이면 한컴은 자동 줄바꿈 없이 강제 줄바꿈
/// 에서만 줄을 나누고 글자를 줄여 넣는다 (mel-001 p147 저장 줄: 셀 폭 10884 HU 보다 긴
/// 줄 3개가 줄바꿈 문자 위치에서만 갈린다). 줄 폭(segment_width)은 셀 줄 폭 그대로다.
pub(crate) fn reflow_cell_line_segs(
    para: &mut Paragraph,
    width_px: f64,
    squeeze: bool,
    known_horizontal: bool,
    styles: &ResolvedStyleSet,
    dpi: f64,
) {
    reflow_line_segs_with_squeeze(para, width_px, styles, dpi, squeeze, known_horizontal);
}

#[derive(Debug, Clone)]
enum ParagraphSplitIntent {
    UserEnter,
    LogicalContinuation,
    RestoreMetadata(ParaMeta),
}

pub(super) fn recalculate_cell_paragraph_vpos(
    paragraphs: &mut [Paragraph],
    start_para: usize,
    ignore_reset_at: Option<usize>,
    styles: &ResolvedStyleSet,
    dpi: f64,
    is_hwp3_variant: bool,
) {
    if paragraphs.is_empty() || start_para >= paragraphs.len() {
        return;
    }

    // RowBreak 거대 셀은 후속 문단 vpos를 뒤로 되돌려 다음 조각의 로컬 원점을
    // 표현하기도 한다. 그 경계까지 선형 편집 결과를 연결하되, 경계 이후 저장
    // 좌표는 페이지 분할 신호이므로 이동하지 않는다.
    // [Task #2299] 합성 seg(TAG_IMPLEMENTATION_PROPERTY, #1811)의 vpos=0 은 배치 전
    // placeholder 이지 분할 신호가 아니다 — 섹션 recalc 와 동일하게 정지 대상에서
    // 제외한다 (로드가 합성한 중간-셀 문단에서 가짜 정지 → 꼬리 미갱신 방지).
    let stop_para = paragraphs
        .windows(2)
        .enumerate()
        .skip(start_para)
        .find_map(|(idx, pair)| {
            let previous_seg = pair[0].line_segs.first()?;
            let previous = previous_seg.vertical_pos;
            let current_seg = pair[1].line_segs.first()?;
            let current = current_seg.vertical_pos;
            // 되감김의 양쪽 모두 저장 레이아웃 증거(비합성 seg)여야 분할 신호다 —
            // 한쪽이라도 배치 전 placeholder 면 저장 좌표 비교가 성립하지 않는다.
            let synthetic = crate::model::paragraph::LineSeg::TAG_IMPLEMENTATION_PROPERTY;
            let is_synthetic =
                (current_seg.tag & synthetic != 0) || (previous_seg.tag & synthetic != 0);
            let reset_para = idx + 1;
            let is_inserted_paragraph = ignore_reset_at == Some(reset_para);
            (current < previous && !is_inserted_paragraph && !is_synthetic).then_some(reset_para)
        })
        .unwrap_or(paragraphs.len());

    let boundary_gaps: Vec<i32> = paragraphs
        .windows(2)
        .map(|pair| {
            let spacing_after = styles
                .para_styles
                .get(pair[0].para_shape_id as usize)
                .map(|style| style.spacing_after)
                .unwrap_or(0.0);
            let spacing_before = styles
                .para_styles
                .get(pair[1].para_shape_id as usize)
                .map(|style| style.spacing_before)
                .unwrap_or(0.0);
            let spacing_before =
                crate::renderer::hwp3_variant_flow_spacing_before(spacing_before, is_hwp3_variant);
            // 한컴 저장 경계 간격은 정확한 HU 합 — px 왕복 절단(−1)을 피해 반올림한다.
            crate::renderer::px_to_hwpunit_round(spacing_after + spacing_before, dpi)
        })
        .collect();

    let mut next_vpos = if start_para > 0 {
        let previous = &paragraphs[start_para - 1];
        previous
            .line_segs
            .last()
            .map(|seg| {
                seg.vertical_pos
                    + seg.line_height.max(seg.text_height)
                    + seg.line_spacing
                    + boundary_gaps[start_para - 1]
            })
            .unwrap_or(0)
    } else {
        paragraphs[0]
            .line_segs
            .first()
            .map(|seg| seg.vertical_pos)
            .unwrap_or(0)
    };

    for para_idx in start_para..stop_para {
        let para = &mut paragraphs[para_idx];
        if let Some(first_vpos) = para.line_segs.first().map(|seg| seg.vertical_pos) {
            let delta = next_vpos - first_vpos;
            for seg in &mut para.line_segs {
                seg.vertical_pos += delta;
            }
            if let Some(last) = para.line_segs.last() {
                // 테두리 위쪽 확장은 text_height에만 있다. 개체가 더 큰 줄은
                // line_height 점유를 유지하면서 두 높이 중 큰 값으로 진행한다.
                next_vpos =
                    last.vertical_pos + last.line_height.max(last.text_height) + last.line_spacing;
            }
        }
        if let Some(gap) = boundary_gaps.get(para_idx) {
            next_vpos += gap;
        }
    }
}

fn shift_paragraph_vpos_origin(para: &mut Paragraph, target_vpos: i32) {
    let Some(current_vpos) = para.line_segs.first().map(|seg| seg.vertical_pos) else {
        return;
    };
    let delta = target_vpos - current_vpos;
    for seg in &mut para.line_segs {
        seg.vertical_pos += delta;
    }
}

/// [Issue #2214] 문단 첫 줄을 원점으로 한 상대 flow advance.
/// line count가 아니라 후속 문단의 배치 위치를 실제로 바꾸는 높이 신호다.
fn relative_paragraph_flow_advance(paragraph: &Paragraph) -> Option<i64> {
    let first = paragraph.line_segs.first()?;
    let last = paragraph.line_segs.last()?;
    Some(
        i64::from(last.vertical_pos)
            + i64::from(last.line_height.max(last.text_height))
            + i64::from(last.line_spacing)
            - i64::from(first.vertical_pos),
    )
}

fn cell_flow_signature(paragraphs: &[Paragraph]) -> Vec<(usize, Option<i64>, usize)> {
    paragraphs
        .iter()
        .map(|paragraph| {
            (
                paragraph.line_segs.len(),
                relative_paragraph_flow_advance(paragraph),
                paragraph.controls.len(),
            )
        })
        .collect()
}

fn mix_structure_fingerprint(hash: &mut u64, value: usize) {
    for byte in value.to_le_bytes() {
        *hash ^= u64::from(byte);
        *hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
}

fn control_structure_tag(control: &Control) -> usize {
    match control {
        Control::SectionDef(_) => 1,
        Control::ColumnDef(_) => 2,
        Control::Table(_) => 3,
        Control::Shape(_) => 4,
        Control::Picture(_) => 5,
        Control::Header(_) => 6,
        Control::Footer(_) => 7,
        Control::Footnote(_) => 8,
        Control::Endnote(_) => 9,
        Control::AutoNumber(_) => 10,
        Control::NewNumber(_) => 11,
        Control::PageNumberPos(_) => 12,
        Control::Bookmark(_) => 13,
        Control::Hyperlink(_) => 14,
        Control::Ruby(_) => 15,
        Control::CharOverlap(_) => 16,
        Control::PageHide(_) => 17,
        Control::HiddenComment(_) => 18,
        Control::Equation(_) => 19,
        Control::Field(_) => 20,
        Control::Form(_) => 21,
        Control::Unknown(_) => 22,
    }
}

fn mix_table_structure_fingerprint(hash: &mut u64, table: &crate::model::table::Table) {
    mix_structure_fingerprint(hash, table.row_count as usize);
    mix_structure_fingerprint(hash, table.col_count as usize);
    mix_structure_fingerprint(hash, table.cells.len());
    for cell in &table.cells {
        mix_structure_fingerprint(hash, cell.row as usize);
        mix_structure_fingerprint(hash, cell.col as usize);
        mix_structure_fingerprint(hash, cell.row_span as usize);
        mix_structure_fingerprint(hash, cell.col_span as usize);
        mix_structure_fingerprint(hash, cell.paragraphs.len());
        for paragraph in &cell.paragraphs {
            mix_structure_fingerprint(hash, paragraph.controls.len());
            for control in &paragraph.controls {
                mix_structure_fingerprint(hash, control_structure_tag(control));
                if let Control::Table(nested) = control {
                    mix_table_structure_fingerprint(hash, nested);
                }
            }
        }
    }
}

fn table_structure_fingerprint(table: &crate::model::table::Table) -> u64 {
    // 고정 FNV-1a 조합으로 row/column/span뿐 아니라 셀 문단과 control 구조도 묶는다.
    // Stage B fast path는 text-only edit만 허용하므로 구조가 달라지면 반드시 fallback한다.
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    mix_table_structure_fingerprint(&mut hash, table);
    hash
}

fn target_table_first_global_page(
    core: &DocumentCore,
    section_index: usize,
    para_index: usize,
    control_index: usize,
) -> Option<u32> {
    let mut global_page = 0_u32;
    for (result_section, result) in core.pagination.iter().enumerate() {
        for page in &result.pages {
            if result_section == section_index
                && page.column_contents.iter().any(|column| {
                    column.items.iter().any(|item| {
                        matches!(
                            item,
                            PageItem::Table {
                                para_index: item_para,
                                control_index: item_control,
                            }
                                | PageItem::PartialTable {
                                    para_index: item_para,
                                    control_index: item_control,
                                    ..
                            } if *item_para == para_index && *item_control == control_index
                        )
                    })
                })
            {
                return Some(global_page);
            }
            global_page = global_page.saturating_add(1);
        }
    }
    None
}

impl DocumentCore {
    /// [#2424] resumable step 시작 전에 descriptor가 여전히 같은 text-only table edit을
    /// 가리키는지 좌표로 다시 조회한다. 불일치하면 shadow state를 commit하지 않고 기존
    /// full pagination으로 fallback해야 한다.
    pub(crate) fn deferred_pagination_target_status(
        &self,
        descriptor: &DeferredPaginationDescriptor,
    ) -> DeferredPaginationTargetStatus {
        if descriptor.revision != self.deferred_pagination_revision
            || self.deferred_pagination_descriptor.as_ref() != Some(descriptor)
        {
            return DeferredPaginationTargetStatus::Superseded;
        }

        let Some(section) = self.document.sections.get(descriptor.section_index) else {
            return DeferredPaginationTargetStatus::TargetMissing;
        };
        let Some(paragraph) = section.paragraphs.get(descriptor.para_index) else {
            return DeferredPaginationTargetStatus::TargetMissing;
        };
        let Some(Control::Table(table)) = paragraph.controls.get(descriptor.control_index) else {
            return DeferredPaginationTargetStatus::TargetMissing;
        };
        if table
            .cells
            .get(descriptor.cell_index)
            .and_then(|cell| cell.paragraphs.get(descriptor.cell_para_index))
            .is_none()
        {
            return DeferredPaginationTargetStatus::TargetMissing;
        }
        if table_structure_fingerprint(table) != descriptor.table_structure_fingerprint {
            return DeferredPaginationTargetStatus::StructureChanged;
        }
        DeferredPaginationTargetStatus::Current
    }
}

fn body_paragraph_flow_signature(paragraph: &Paragraph) -> (usize, Option<i64>) {
    (
        paragraph.line_segs.len(),
        relative_paragraph_flow_advance(paragraph),
    )
}

#[derive(Clone, Copy)]
struct FieldEndInsertion {
    control_idx: usize,
    start_char_idx: usize,
    end_char_idx: usize,
}

#[derive(Clone, Copy)]
struct FieldStartInsertion {
    control_idx: usize,
    start_char_idx: usize,
    end_char_idx: usize,
}

#[derive(Clone, Copy)]
struct SquareOleWrapChainForEnter {
    bottom_vpos: i32,
    column_start: i32,
    segment_width: i32,
}

fn active_field_matches(
    active_field: Option<&ActiveFieldInfo>,
    section_idx: usize,
    para_idx: usize,
    cell_path: Option<&[(usize, usize, usize)]>,
    control_idx: usize,
) -> bool {
    active_field.is_some_and(|af| {
        af.section_idx == section_idx
            && af.para_idx == para_idx
            && af.control_idx == control_idx
            && match (&af.cell_path, cell_path) {
                (None, None) => true,
                (Some(a), Some(b)) => a.as_slice() == b,
                _ => false,
            }
    })
}

fn inactive_field_end_insertions(
    para: &Paragraph,
    active_field: Option<&ActiveFieldInfo>,
    section_idx: usize,
    para_idx: usize,
    cell_path: Option<&[(usize, usize, usize)]>,
    char_offset: usize,
) -> Vec<FieldEndInsertion> {
    para.field_ranges
        .iter()
        .filter_map(|fr| {
            match para.controls.get(fr.control_idx) {
                Some(Control::Field(field))
                    if matches!(
                        field.field_type,
                        FieldType::ClickHere | FieldType::Hyperlink
                    ) => {}
                _ => return None,
            }
            // 빈 누름틀은 active 상태가 아직 반영되기 전 첫 입력도 값으로 받아야 한다.
            if fr.start_char_idx == fr.end_char_idx || fr.end_char_idx != char_offset {
                return None;
            }
            if active_field_matches(
                active_field,
                section_idx,
                para_idx,
                cell_path,
                fr.control_idx,
            ) {
                return None;
            }
            Some(FieldEndInsertion {
                control_idx: fr.control_idx,
                start_char_idx: fr.start_char_idx,
                end_char_idx: fr.end_char_idx,
            })
        })
        .collect()
}

fn para_has_visible_text_for_enter(para: &Paragraph) -> bool {
    para.text.chars().any(|c| c > '\u{001F}' && c != '\u{FFFC}')
}

fn is_empty_topbottom_table_anchor_for_enter(para: &Paragraph) -> bool {
    !para_has_visible_text_for_enter(para)
        && para.controls.iter().any(|ctrl| {
            matches!(
                ctrl,
                Control::Table(table)
                    if !table.common.treat_as_char
                        && matches!(table.common.text_wrap, TextWrap::TopAndBottom)
                        && matches!(table.common.vert_rel_to, VertRelTo::Para)
            )
        })
}

fn square_ole_anchor_wrap_chain_for_enter(para: &Paragraph) -> Option<SquareOleWrapChainForEnter> {
    if para_has_visible_text_for_enter(para) || !para.char_offsets.is_empty() {
        return None;
    }
    let line_seg = para.line_segs.first()?;
    if line_seg.column_start <= 0 || line_seg.segment_width <= 0 {
        return None;
    }

    para.controls.iter().find_map(|ctrl| {
        let Control::Shape(shape) = ctrl else {
            return None;
        };
        if !matches!(shape.as_ref(), ShapeObject::Ole(_))
            || shape.common().treat_as_char
            || !matches!(shape.common().text_wrap, TextWrap::Square)
        {
            return None;
        }

        let height = shape.common().height.min(i32::MAX as u32) as i32;
        if height <= 0 {
            return None;
        }
        Some(SquareOleWrapChainForEnter {
            bottom_vpos: line_seg.vertical_pos.saturating_add(height),
            column_start: line_seg.column_start,
            segment_width: line_seg.segment_width,
        })
    })
}

fn is_empty_stored_square_wrap_line_for_enter(para: &Paragraph) -> bool {
    !para_has_visible_text_for_enter(para)
        && para.char_offsets.is_empty()
        && para.controls.is_empty()
        && para
            .line_segs
            .first()
            .is_some_and(|seg| seg.column_start > 0 && seg.segment_width > 0)
}

fn is_contentless_empty_paragraph_for_merge(para: &Paragraph) -> bool {
    para.text.is_empty() && para.char_offsets.is_empty() && para.controls.is_empty()
}

fn has_same_stored_wrap_line(lhs: &Paragraph, rhs: &Paragraph) -> bool {
    match (lhs.line_segs.first(), rhs.line_segs.first()) {
        (Some(a), Some(b)) => {
            a.column_start == b.column_start && a.segment_width == b.segment_width
        }
        _ => false,
    }
}

fn square_ole_wrap_chain_for_enter(
    paragraphs: &[Paragraph],
    para_idx: usize,
) -> Option<SquareOleWrapChainForEnter> {
    let anchor = paragraphs.get(para_idx)?;
    if let Some(chain) = square_ole_anchor_wrap_chain_for_enter(anchor) {
        return Some(chain);
    }
    if !is_empty_stored_square_wrap_line_for_enter(anchor) {
        return None;
    }

    let mut idx = para_idx;
    while idx > 0 {
        idx -= 1;
        let prev = paragraphs.get(idx)?;
        if let Some(chain) = square_ole_anchor_wrap_chain_for_enter(prev) {
            return (chain.column_start == anchor.line_segs[0].column_start
                && chain.segment_width == anchor.line_segs[0].segment_width)
                .then_some(chain);
        }
        if is_empty_stored_square_wrap_line_for_enter(prev)
            && has_same_stored_wrap_line(prev, anchor)
        {
            continue;
        }
        return None;
    }
    None
}

fn next_line_vpos_after_para_for_enter(para: &Paragraph) -> i32 {
    para.line_segs
        .last()
        .map(|seg| {
            seg.vertical_pos
                .saturating_add(seg.line_height)
                .saturating_add(seg.line_spacing)
        })
        .unwrap_or(0)
}

fn empty_paragraph_after_normal_flow(anchor: &Paragraph) -> Paragraph {
    let mut para = empty_paragraph_after_table_anchor(anchor);
    if let Some(seg) = para.line_segs.first_mut() {
        seg.column_start = 0;
        seg.segment_width = 0;
        seg.vertical_pos = 0;
    }
    para
}

fn empty_paragraph_after_table_anchor(anchor: &Paragraph) -> Paragraph {
    let mut para = Paragraph::new_empty_like(anchor);
    if let Some(seg) = para.line_segs.first_mut() {
        if let Some(anchor_seg) = anchor.line_segs.first() {
            seg.segment_width = anchor_seg.segment_width;
        }
    }
    let mut raw_header_extra = vec![0u8; 10];
    raw_header_extra[0..2].copy_from_slice(&1u16.to_le_bytes());
    raw_header_extra[4..6].copy_from_slice(&1u16.to_le_bytes());
    para.raw_header_extra = raw_header_extra;
    para.has_para_text = false;
    para
}

fn empty_paragraph_after_square_wrap_anchor(anchor: &Paragraph) -> Paragraph {
    let mut para = empty_paragraph_after_table_anchor(anchor);
    if let (Some(seg), Some(anchor_seg)) = (para.line_segs.first_mut(), anchor.line_segs.first()) {
        *seg = anchor_seg.clone();
        seg.text_start = 0;
        seg.vertical_pos = 0;
    }
    para
}

fn inactive_field_start_insertions(
    para: &Paragraph,
    active_field: Option<&ActiveFieldInfo>,
    section_idx: usize,
    para_idx: usize,
    cell_path: Option<&[(usize, usize, usize)]>,
    char_offset: usize,
) -> Vec<FieldStartInsertion> {
    para.field_ranges
        .iter()
        .filter_map(|fr| {
            match para.controls.get(fr.control_idx) {
                Some(Control::Field(field))
                    if matches!(
                        field.field_type,
                        FieldType::ClickHere | FieldType::Hyperlink
                    ) => {}
                _ => return None,
            }
            // 빈 누름틀은 시작/끝 경계가 없고 첫 입력이 필드 값이어야 한다.
            if fr.start_char_idx == fr.end_char_idx || fr.start_char_idx != char_offset {
                return None;
            }
            if active_field_matches(
                active_field,
                section_idx,
                para_idx,
                cell_path,
                fr.control_idx,
            ) {
                return None;
            }
            Some(FieldStartInsertion {
                control_idx: fr.control_idx,
                start_char_idx: fr.start_char_idx,
                end_char_idx: fr.end_char_idx,
            })
        })
        .collect()
}

fn keep_inactive_field_end_outside(
    para: &mut Paragraph,
    insertions: &[FieldEndInsertion],
    inserted_len: usize,
) {
    if inserted_len == 0 || insertions.is_empty() {
        return;
    }
    for target in insertions {
        if let Some(fr) = para.field_ranges.iter_mut().find(|fr| {
            fr.control_idx == target.control_idx
                && fr.start_char_idx == target.start_char_idx
                && fr.end_char_idx == target.end_char_idx + inserted_len
        }) {
            fr.end_char_idx = target.end_char_idx;
        }
    }
}

fn keep_inactive_field_start_outside(
    para: &mut Paragraph,
    insertions: &[FieldStartInsertion],
    inserted_len: usize,
) {
    if inserted_len == 0 || insertions.is_empty() {
        return;
    }
    for target in insertions {
        if let Some(fr) = para.field_ranges.iter_mut().find(|fr| {
            fr.control_idx == target.control_idx
                && fr.start_char_idx == target.start_char_idx
                && fr.end_char_idx == target.end_char_idx + inserted_len
        }) {
            fr.start_char_idx = target.start_char_idx + inserted_len;
        }
    }
}

fn has_clickhere_field_range(para: &Paragraph) -> bool {
    para.field_ranges.iter().any(|fr| {
        matches!(
            para.controls.get(fr.control_idx),
            Some(Control::Field(field))
                if matches!(
                    field.field_type,
                    FieldType::ClickHere | FieldType::Hyperlink
                )
        )
    })
}

impl DocumentCore {
    /// 캐럿 삽입. 캐럿이 인라인 개체 바로 뒤이면 그 개체 갭 끝에 넣어 개체 앞으로 끼어들지 않게 한다.
    fn insert_text_for_caret(
        para: &mut Paragraph,
        char_offset: usize,
        text: &str,
        after_control: Option<usize>,
        content: Option<&crate::model::paragraph::TextContent>,
    ) -> usize {
        let inserted_at = match after_control {
            Some(ci) if ci < para.controls.len() => {
                let pos = Self::find_inline_control_gap_start(para, ci) + 8;
                para.insert_text_at_utf16(char_offset, pos, text)
            }
            _ => para.insert_text_at(char_offset, text),
        };
        if let Some(content) = content {
            para.restore_inserted_origins(inserted_at, content);
        }
        inserted_at
    }

    pub fn replace_body_text_local_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
        delete_count: usize,
        text: &str,
    ) -> Result<String, HwpError> {
        let after_control = self.caret_insert_after_control.take();
        if section_idx >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!(
                "구역 인덱스 {} 범위 초과 (총 {}개)",
                section_idx,
                self.document.sections.len()
            )));
        }
        let section = &self.document.sections[section_idx];
        if para_idx >= section.paragraphs.len() {
            return Err(HwpError::RenderError(format!(
                "문단 인덱스 {} 범위 초과 (총 {}개)",
                para_idx,
                section.paragraphs.len()
            )));
        }
        let new_chars_count = text.chars().count();
        if delete_count > 8
            || new_chars_count > 8
            || text.chars().any(|ch| matches!(ch, '\r' | '\n' | '\t'))
        {
            return Err(HwpError::RenderError(
                "local 본문 편집은 줄바꿈·탭 없는 최대 8자만 지원합니다".to_string(),
            ));
        }

        let flow_before = body_paragraph_flow_signature(
            &self.document.sections[section_idx].paragraphs[para_idx],
        );
        let old_col = self
            .para_column_map
            .get(section_idx)
            .and_then(|map| map.get(para_idx))
            .copied()
            .unwrap_or(0);
        let stored_end_for_reset = crate::renderer::composer::paragraph_flow_end(
            &self.document.sections[section_idx].paragraphs[para_idx],
        );
        let removed_start = char_offset.min(
            self.document.sections[section_idx].paragraphs[para_idx]
                .text
                .chars()
                .count(),
        );
        let removed_content = self.document.sections[section_idx].paragraphs[para_idx]
            .capture_text_content(removed_start, delete_count);
        self.document.sections[section_idx].raw_stream = None;

        let deleted_count = if delete_count > 0 {
            self.document.sections[section_idx].paragraphs[para_idx]
                .delete_text_at(char_offset, delete_count)
        } else {
            0
        };

        if new_chars_count > 0 {
            let active_field = self.active_field.clone();
            let outside_insertions = inactive_field_end_insertions(
                &self.document.sections[section_idx].paragraphs[para_idx],
                active_field.as_ref(),
                section_idx,
                para_idx,
                None,
                char_offset,
            );
            let before_insertions = inactive_field_start_insertions(
                &self.document.sections[section_idx].paragraphs[para_idx],
                active_field.as_ref(),
                section_idx,
                para_idx,
                None,
                char_offset,
            );
            let para = &mut self.document.sections[section_idx].paragraphs[para_idx];
            Self::insert_text_for_caret(para, char_offset, text, after_control, None);
            keep_inactive_field_start_outside(para, &before_insertions, new_chars_count);
            keep_inactive_field_end_outside(para, &outside_insertions, new_chars_count);
            if has_clickhere_field_range(para) {
                rebuild_char_offsets(para);
            }
        }

        self.reflow_paragraph(section_idx, para_idx);
        let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
        self.recalculate_body_section_vpos(
            section_idx,
            para_idx,
            None,
            stored_end_for_reset,
            doc_hwp3_layout,
        );
        self.recompose_paragraph(section_idx, para_idx);

        let flow_after = body_paragraph_flow_signature(
            &self.document.sections[section_idx].paragraphs[para_idx],
        );
        let flow_changed = flow_before != flow_after;
        if flow_changed {
            self.paginate();
            for _ in 0..2 {
                let new_col = self
                    .para_column_map
                    .get(section_idx)
                    .and_then(|map| map.get(para_idx))
                    .copied()
                    .unwrap_or(0);
                if new_col == old_col {
                    break;
                }
                let stored_end_for_reset = crate::renderer::composer::paragraph_flow_end(
                    &self.document.sections[section_idx].paragraphs[para_idx],
                );
                self.reflow_paragraph(section_idx, para_idx);
                let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
                self.recalculate_body_section_vpos(
                    section_idx,
                    para_idx,
                    None,
                    stored_end_for_reset,
                    doc_hwp3_layout,
                );
                self.recompose_paragraph(section_idx, para_idx);
                self.paginate();
            }
        } else if self
            .render_normalization
            .sections
            .get(section_idx)
            .is_some_and(|section| section.is_some())
        {
            // 렌더 투영이 없는 구역(대부분의 문서)에서는 갱신이 아무 일도 하지 않는다.
            // 그런데도 함수는 투영 확인 전에 문단·조판 결과(경우에 따라 스타일 세트 전체)를
            // 복제하므로, 키 입력마다 버려질 복제를 여기서 막는다.
            self.refresh_render_normalized_body_paragraph_after_edit(section_idx, para_idx);
        }

        let new_offset = removed_start + new_chars_count;
        let para = &self.document.sections[section_idx].paragraphs[para_idx];
        let caret_utf16_pos = if new_offset < para.char_offsets.len() {
            para.char_offsets[new_offset]
        } else if !para.char_offsets.is_empty() {
            let last = para.char_offsets.len() - 1;
            let last_char = para.text.chars().nth(last);
            para.char_offsets[last]
                + last_char
                    .map(|ch| if (ch as u32) > 0xFFFF { 2 } else { 1 })
                    .unwrap_or(1)
        } else {
            (para.controls.len() as u32) * 8
        };
        self.document.doc_properties.caret_list_id = section_idx as u32;
        self.document.doc_properties.caret_para_id = para_idx as u32;
        self.document.doc_properties.caret_char_pos = caret_utf16_pos;
        if let Some(ref mut raw) = self.document.doc_info.raw_stream {
            let _ = crate::serializer::doc_info::surgical_update_caret(
                raw,
                section_idx as u32,
                para_idx as u32,
                caret_utf16_pos,
            );
        }

        if deleted_count > 0 {
            self.event_log.push(DocumentEvent::TextDeleted {
                section: section_idx,
                para: para_idx,
                offset: char_offset,
                count: deleted_count,
            });
        }
        if new_chars_count > 0 {
            self.event_log.push(DocumentEvent::TextInserted {
                section: section_idx,
                para: para_idx,
                offset: char_offset,
                len: new_chars_count,
            });
        }

        Ok(super::super::helpers::json_ok_with(&format!(
            "\"charOffset\":{},\"documentPaginationPending\":{},\"flowChanged\":{},{}",
            new_offset,
            !flow_changed,
            flow_changed,
            super::super::helpers::removed_content_fields(removed_start, &removed_content)
        )))
    }

    pub fn insert_text_content_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
        content: &crate::model::paragraph::TextContent,
    ) -> Result<String, HwpError> {
        content
            .validate()
            .map_err(|e| HwpError::RenderError(e.to_string()))?;
        self.insert_text_native_impl(
            section_idx,
            para_idx,
            char_offset,
            &content.text,
            Some(content),
        )
    }

    pub fn insert_text_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
        text: &str,
    ) -> Result<String, HwpError> {
        self.insert_text_native_impl(section_idx, para_idx, char_offset, text, None)
    }

    fn insert_text_native_impl(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
        text: &str,
        content: Option<&crate::model::paragraph::TextContent>,
    ) -> Result<String, HwpError> {
        let after_control = self.caret_insert_after_control.take();
        // 인덱스 범위 검증
        if section_idx >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!(
                "구역 인덱스 {} 범위 초과 (총 {}개)",
                section_idx,
                self.document.sections.len()
            )));
        }
        let section = &self.document.sections[section_idx];
        if para_idx >= section.paragraphs.len() {
            return Err(HwpError::RenderError(format!(
                "문단 인덱스 {} 범위 초과 (총 {}개)",
                para_idx,
                section.paragraphs.len()
            )));
        }

        // 편집 시 raw 스트림 무효화 (재직렬화 유도)
        self.document.sections[section_idx].raw_stream = None;

        // 텍스트 삽입
        let new_chars_count = text.chars().count();
        let active_field = self.active_field.clone();
        let outside_insertions = inactive_field_end_insertions(
            &self.document.sections[section_idx].paragraphs[para_idx],
            active_field.as_ref(),
            section_idx,
            para_idx,
            None,
            char_offset,
        );
        let before_insertions = inactive_field_start_insertions(
            &self.document.sections[section_idx].paragraphs[para_idx],
            active_field.as_ref(),
            section_idx,
            para_idx,
            None,
            char_offset,
        );
        let inserted_at = {
            let para = &mut self.document.sections[section_idx].paragraphs[para_idx];
            let inserted_at =
                Self::insert_text_for_caret(para, char_offset, text, after_control, content);
            keep_inactive_field_start_outside(para, &before_insertions, new_chars_count);
            keep_inactive_field_end_outside(para, &outside_insertions, new_chars_count);
            if has_clickhere_field_range(para) {
                rebuild_char_offsets(para);
            }
            inserted_at
        };

        // line_segs 재계산 (리플로우) → vpos 재계산 → 재구성 → 재페이지네이션
        // 다단 문서에서 편집 후 문단이 다른 단으로 재배치될 수 있으므로
        // para_column_map 변경 감지 + 재reflow 수렴 루프 (최대 3회)
        let old_col = self
            .para_column_map
            .get(section_idx)
            .and_then(|m| m.get(para_idx))
            .copied()
            .unwrap_or(0);
        // [Task #2299] 리셋 판별용 — reflow 이전 저장 흐름 end 캡처.
        let stored_end_for_reset = crate::renderer::composer::paragraph_flow_end(
            &self.document.sections[section_idx].paragraphs[para_idx],
        );
        self.reflow_paragraph(section_idx, para_idx);
        let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
        self.recalculate_body_section_vpos(
            section_idx,
            para_idx,
            None,
            stored_end_for_reset,
            doc_hwp3_layout,
        );
        self.recompose_paragraph(section_idx, para_idx);
        self.paginate_if_needed();

        for _ in 0..2 {
            let new_col = self
                .para_column_map
                .get(section_idx)
                .and_then(|m| m.get(para_idx))
                .copied()
                .unwrap_or(0);
            if new_col == old_col {
                break;
            }
            // [Task #2299] 리셋 판별용 — reflow 이전 저장 흐름 end 캡처.
            let stored_end_for_reset = crate::renderer::composer::paragraph_flow_end(
                &self.document.sections[section_idx].paragraphs[para_idx],
            );
            self.reflow_paragraph(section_idx, para_idx);
            let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
            self.recalculate_body_section_vpos(
                section_idx,
                para_idx,
                None,
                stored_end_for_reset,
                doc_hwp3_layout,
            );
            self.recompose_paragraph(section_idx, para_idx);
            self.paginate_if_needed();
        }

        let new_offset = inserted_at + new_chars_count;

        // 캐럿 위치 갱신 (DocProperties)
        // caret_char_pos는 UTF-16 코드 유닛 기준
        let para = &self.document.sections[section_idx].paragraphs[para_idx];
        let caret_utf16_pos = if new_offset < para.char_offsets.len() {
            para.char_offsets[new_offset]
        } else if !para.char_offsets.is_empty() {
            let last = para.char_offsets.len() - 1;
            let last_char = para.text.chars().nth(last);
            para.char_offsets[last]
                + last_char
                    .map(|c| if (c as u32) > 0xFFFF { 2 } else { 1 })
                    .unwrap_or(1)
        } else {
            // 텍스트 없이 컨트롤만 있는 경우
            (para.controls.len() as u32) * 8
        };
        self.document.doc_properties.caret_list_id = section_idx as u32;
        self.document.doc_properties.caret_para_id = para_idx as u32;
        self.document.doc_properties.caret_char_pos = caret_utf16_pos;

        // DocInfo raw_stream 내 캐럿 위치만 surgical update (전체 재직렬화 방지)
        if let Some(ref mut raw) = self.document.doc_info.raw_stream {
            let _ = crate::serializer::doc_info::surgical_update_caret(
                raw,
                section_idx as u32,
                para_idx as u32,
                caret_utf16_pos,
            );
        }

        self.event_log.push(DocumentEvent::TextInserted {
            section: section_idx,
            para: para_idx,
            offset: char_offset,
            len: new_chars_count,
        });
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"charOffset\":{}",
            new_offset
        )))
    }

    /// 텍스트 삭제 (네이티브 에러 타입)
    pub fn delete_text_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
        count: usize,
    ) -> Result<String, HwpError> {
        // 인덱스 범위 검증
        if section_idx >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!(
                "구역 인덱스 {} 범위 초과 (총 {}개)",
                section_idx,
                self.document.sections.len()
            )));
        }
        let section = &self.document.sections[section_idx];
        if para_idx >= section.paragraphs.len() {
            return Err(HwpError::RenderError(format!(
                "문단 인덱스 {} 범위 초과 (총 {}개)",
                para_idx,
                section.paragraphs.len()
            )));
        }

        // 편집 시 raw 스트림 무효화 (재직렬화 유도)
        let removed_start = char_offset.min(
            self.document.sections[section_idx].paragraphs[para_idx]
                .text
                .chars()
                .count(),
        );
        let removed_content = self.document.sections[section_idx].paragraphs[para_idx]
            .capture_text_content(removed_start, count);
        self.document.sections[section_idx].raw_stream = None;

        // 텍스트 삭제
        self.document.sections[section_idx].paragraphs[para_idx].delete_text_at(char_offset, count);

        // line_segs 재계산 (리플로우) → 재구성 → 재페이지네이션
        // 다단 수렴 루프 (최대 3회)
        let old_col = self
            .para_column_map
            .get(section_idx)
            .and_then(|m| m.get(para_idx))
            .copied()
            .unwrap_or(0);
        // [Task #2299] 리셋 판별용 — reflow 이전 저장 흐름 end 캡처.
        let stored_end_for_reset = crate::renderer::composer::paragraph_flow_end(
            &self.document.sections[section_idx].paragraphs[para_idx],
        );
        self.reflow_paragraph(section_idx, para_idx);
        let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
        self.recalculate_body_section_vpos(
            section_idx,
            para_idx,
            None,
            stored_end_for_reset,
            doc_hwp3_layout,
        );
        self.recompose_paragraph(section_idx, para_idx);
        self.paginate_if_needed();

        for _ in 0..2 {
            let new_col = self
                .para_column_map
                .get(section_idx)
                .and_then(|m| m.get(para_idx))
                .copied()
                .unwrap_or(0);
            if new_col == old_col {
                break;
            }
            // [Task #2299] 리셋 판별용 — reflow 이전 저장 흐름 end 캡처.
            let stored_end_for_reset = crate::renderer::composer::paragraph_flow_end(
                &self.document.sections[section_idx].paragraphs[para_idx],
            );
            self.reflow_paragraph(section_idx, para_idx);
            let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
            self.recalculate_body_section_vpos(
                section_idx,
                para_idx,
                None,
                stored_end_for_reset,
                doc_hwp3_layout,
            );
            self.recompose_paragraph(section_idx, para_idx);
            self.paginate_if_needed();
        }

        // 캐럿 위치 갱신 (DocProperties)
        let para = &self.document.sections[section_idx].paragraphs[para_idx];
        let caret_utf16_pos = if char_offset < para.char_offsets.len() {
            para.char_offsets[char_offset]
        } else if !para.char_offsets.is_empty() {
            let last = para.char_offsets.len() - 1;
            let last_char = para.text.chars().nth(last);
            para.char_offsets[last]
                + last_char
                    .map(|c| if (c as u32) > 0xFFFF { 2 } else { 1 })
                    .unwrap_or(1)
        } else {
            (para.controls.len() as u32) * 8
        };
        self.document.doc_properties.caret_list_id = section_idx as u32;
        self.document.doc_properties.caret_para_id = para_idx as u32;
        self.document.doc_properties.caret_char_pos = caret_utf16_pos;

        // DocInfo raw_stream 내 캐럿 위치만 surgical update (전체 재직렬화 방지)
        if let Some(ref mut raw) = self.document.doc_info.raw_stream {
            let _ = crate::serializer::doc_info::surgical_update_caret(
                raw,
                section_idx as u32,
                para_idx as u32,
                caret_utf16_pos,
            );
        }

        self.event_log.push(DocumentEvent::TextDeleted {
            section: section_idx,
            para: para_idx,
            offset: char_offset,
            count,
        });
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"charOffset\":{},{}",
            removed_start,
            super::super::helpers::removed_content_fields(removed_start, &removed_content)
        )))
    }

    /// 본문 편집의 좌표 갱신은 실제 조판과 같은 출처/프로필 조건을 사용한다.
    pub(crate) fn recalculate_body_section_vpos(
        &mut self,
        section_idx: usize,
        start_para: usize,
        ignore_reset_range: Option<std::ops::Range<usize>>,
        start_stored_end: Option<i32>,
        is_hwp3_variant: bool,
    ) {
        let profile = self.document.layout_profile();
        let section = &self.document.sections[section_idx];
        let words = self
            .natural_flow_source_words()
            .filter(|_| !self.document.doc_info.apply_next_spacing_of_last_para);
        let rejoin = crate::renderer::typeset::TypesetEngine::new(self.dpi)
            .with_native_natural_flow_source(
                words,
                &section.section_def,
                self.natural_flow_capacity_flags(section_idx),
            )
            .native_natural_flow_section_capacity(profile, &section.paragraphs)
            .is_some();
        crate::renderer::composer::recalculate_section_vpos_for_body(
            &mut self.document.sections[section_idx].paragraphs,
            start_para,
            ignore_reset_range,
            start_stored_end,
            &self.styles,
            self.dpi,
            is_hwp3_variant,
            rejoin,
        );
    }

    /// 지정된 문단의 line_segs를 컬럼 너비 기반으로 재계산한다.
    pub(crate) fn reflow_paragraph(&mut self, section_idx: usize, para_idx: usize) {
        let available_width = self.body_reflow_width(section_idx, para_idx);
        let heads =
            crate::renderer::layout::resolve_body_paragraph_heads(&self.document, &self.styles);
        let para = &mut self.document.sections[section_idx].paragraphs[para_idx];
        let reserve = crate::renderer::layout::resolved_head_reserve_px(
            &self.styles,
            para,
            heads[section_idx][para_idx].as_ref(),
            self.dpi,
        );
        crate::renderer::composer::reflow_line_segs_with_head(
            para,
            available_width,
            &self.styles,
            self.dpi,
            reserve,
        );
    }

    /// 본문 문단 재래핑 폭(px) — 소속 단 폭에서 문단 좌우 여백을 뺀다.
    /// 편집 reflow 와 lineseg 오라클(`diagnostics::lineseg_oracle`)이 공유한다.
    pub(crate) fn body_reflow_width(&self, section_idx: usize, para_idx: usize) -> f64 {
        let section = &self.document.sections[section_idx];
        let page_def = &section.section_def.page_def;
        // 해당 문단에 적용되는 ColumnDef를 찾음 (구역 내 다단↔단일단 전환 지원)
        let column_def = Self::find_column_def_for_paragraph(&section.paragraphs, para_idx);
        let layout = PageLayoutInfo::from_page_def(page_def, &column_def, self.dpi);

        // 페이지네이션 매핑에서 문단의 소속 단 인덱스 조회
        let col_idx = self
            .para_column_map
            .get(section_idx)
            .and_then(|m| m.get(para_idx))
            .copied()
            .unwrap_or(0) as usize;
        let col_area = layout
            .column_areas
            .get(col_idx)
            .unwrap_or(&layout.column_areas[0]);

        let para = &section.paragraphs[para_idx];
        Self::column_line_width_px(col_area.width, para.para_shape_id, &self.styles, self.dpi)
    }

    /// 본문(단)·머리말/꼬리말 줄 폭(px): 영역 폭을 4 HWPUNIT 격자로 내리고 문단 여백을
    /// 뺀다 (한컴 저장 줄 폭 규칙). 편집 reflow·로드 합성·오라클이 공유한다.
    pub(crate) fn column_line_width_px(
        area_width_px: f64,
        para_shape_id: u16,
        styles: &ResolvedStyleSet,
        dpi: f64,
    ) -> f64 {
        let area_hu = i64::from(crate::renderer::px_to_hwpunit_round(area_width_px, dpi));
        Self::hancom_line_width_px(area_hu, para_shape_id, styles, dpi, 0)
    }

    /// [`reflow_cell_line_segs`] 의 모듈 밖 진입점 (lineseg 오라클).
    pub(crate) fn reflow_cell_lines(
        para: &mut Paragraph,
        width_px: f64,
        squeeze: bool,
        styles: &ResolvedStyleSet,
        dpi: f64,
    ) {
        reflow_cell_line_segs(para, width_px, squeeze, false, styles, dpi);
    }

    /// 머리말/꼬리말 줄 폭(px): 쪽 본문 폭(가로 용지·제본 여백 반영)에 본문과 같은
    /// 4 HU 격자·문단 여백 규칙. 편집 reflow·로드 합성·오라클이 공유한다.
    pub(crate) fn page_text_line_width_px(
        page_def: &crate::model::page::PageDef,
        para_shape_id: u16,
        styles: &ResolvedStyleSet,
        dpi: f64,
    ) -> f64 {
        let layout = PageLayoutInfo::from_page_def(page_def, &ColumnDef::default(), dpi);
        Self::column_line_width_px(layout.body_area.width, para_shape_id, styles, dpi)
    }

    /// 표 모든 셀의 (글 영역 폭, 좌 패딩, 우 패딩) HWPUNIT — 한컴 셀 줄 폭 모델
    /// (`table_cell_text_widths_hu` + `table_cell_metrics`). 문단 줄 폭은
    /// `reflow_width_from_cell_metrics`. 편집 reflow·로드 합성·오라클이 공유한다.
    pub(crate) fn table_cells_line_metrics(
        table: &crate::model::table::Table,
    ) -> Vec<Option<(u32, i16, i16)>> {
        let widths = crate::renderer::layout::LayoutEngine::table_cell_text_widths_hu(table);
        (0..table.cells.len())
            .map(|i| Self::table_cell_metrics(table, i, widths.get(i).copied().flatten()))
            .collect()
    }

    /// 떠 있는 개체가 표 행 높이에 관여하는 세로 셀은 기존 셀 폭 조판을 유지한다.
    /// 세로 텍스트만의 행 높이로 먼저 재조판하면 개체의 흐름 높이가 다시 행을
    /// 늘려 뒤따르는 셀 전체의 위치가 달라진다.
    pub(crate) fn cell_uses_vertical_reflow(cell: &crate::model::table::Cell) -> bool {
        if cell.text_direction == 0 {
            return false;
        }
        !cell
            .paragraphs
            .iter()
            .flat_map(|p| &p.controls)
            .any(|ctrl| {
                let common = match ctrl {
                    Control::Picture(pic) => Some(&pic.common),
                    Control::Shape(shape) => Some(shape.common()),
                    _ => None,
                };
                common.is_some_and(|obj| {
                    !obj.treat_as_char
                        && matches!(obj.text_wrap, crate::model::shape::TextWrap::TopAndBottom)
                        && obj.flow_with_text
                })
            })
    }

    /// 세로쓰기 셀은 실제 행 그리드의 걸침 높이를 줄 길이로 쓴다. 셀 선언 높이는
    /// 다른 열의 내용으로 행이 자란 뒤의 높이보다 작을 수 있다.
    pub(crate) fn table_cells_reflow_metrics(
        table: &crate::model::table::Table,
        styles: &ResolvedStyleSet,
        dpi: f64,
        layout_profile: crate::model::provenance::LayoutCompatibilityProfile,
    ) -> Vec<Option<(u32, i16, i16)>> {
        let mut metrics = Self::table_cells_line_metrics(table);
        if !table.cells.iter().any(Self::cell_uses_vertical_reflow) {
            return metrics;
        }
        // 세로 셀 자신의 아직 조판되지 않은 텍스트를 행 성장에 되먹이면,
        // 여러 열로 나뉘어야 할 텍스트가 한 열 높이로 행 전체를 늘린다.
        let mut row_measure_table = table.clone();
        for cell in &mut row_measure_table.cells {
            if cell.text_direction != 0 {
                for para in &mut cell.paragraphs {
                    para.text.clear();
                    para.special_space_origins.clear();
                    para.char_offsets.clear();
                    para.char_count = 0;
                    para.line_segs.clear();
                }
            }
        }
        let engine = crate::renderer::layout::LayoutEngine::new(dpi);
        engine.set_layout_profile(layout_profile);
        let heights = engine.resolve_row_heights(
            &row_measure_table,
            table.col_count as usize,
            table.row_count as usize,
            None,
            styles,
            true,
        );
        for (cell, metric) in table.cells.iter().zip(&mut metrics) {
            if !Self::cell_uses_vertical_reflow(cell) {
                continue;
            }
            let start = cell.row as usize;
            let end = (start + cell.row_span.max(1) as usize).min(heights.len());
            if start >= end {
                continue;
            }
            let height_px: f64 = heights[start..end].iter().sum::<f64>()
                + crate::renderer::hwpunit_to_px(
                    i32::from(table.cell_spacing.max(0)) * (end - start - 1) as i32,
                    dpi,
                );
            if let Ok(height) = u32::try_from(crate::renderer::px_to_hwpunit_round(height_px, dpi))
            {
                let padding = if cell.apply_inner_margin {
                    &cell.padding
                } else {
                    &table.padding
                };
                *metric = Some((height, padding.top, padding.bottom));
            }
        }
        metrics
    }

    /// 표 셀 내부 문단에 텍스트 삽입 (네이티브)
    pub fn insert_text_content_in_cell_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        char_offset: usize,
        content: &crate::model::paragraph::TextContent,
    ) -> Result<String, HwpError> {
        content
            .validate()
            .map_err(|e| HwpError::RenderError(e.to_string()))?;
        self.replace_text_in_cell_with_content_impl(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
            char_offset,
            0,
            &content.text,
            true,
            Some(content),
        )
    }

    pub fn insert_text_content_in_cell_native_deferred_pagination(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        char_offset: usize,
        content: &crate::model::paragraph::TextContent,
    ) -> Result<String, HwpError> {
        content
            .validate()
            .map_err(|e| HwpError::RenderError(e.to_string()))?;
        self.replace_text_in_cell_with_content_impl(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
            char_offset,
            0,
            &content.text,
            false,
            Some(content),
        )
    }

    pub fn insert_text_in_cell_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        char_offset: usize,
        text: &str,
    ) -> Result<String, HwpError> {
        self.replace_text_in_cell_native_impl(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
            char_offset,
            0,
            text,
            true,
        )
    }

    /// 표 셀 내부 단일 텍스트 삽입 후 전체 페이지네이션을 호출자가 지연한다.
    /// 결과 JSON의 `cellFlowChanged`는 상대 line advance 변화 여부다.
    pub fn insert_text_in_cell_native_deferred_pagination(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        char_offset: usize,
        text: &str,
    ) -> Result<String, HwpError> {
        self.replace_text_in_cell_native_impl(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
            char_offset,
            0,
            text,
            false,
        )
    }

    /// 표 셀 내부의 짧은 IME 조합 문자열을 원자적으로 교체하고 전체 페이지네이션은 지연한다.
    pub fn replace_text_in_cell_native_deferred_pagination(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        char_offset: usize,
        delete_count: usize,
        text: &str,
    ) -> Result<String, HwpError> {
        let new_chars_count = text.chars().count();
        if delete_count == 0
            || delete_count > 8
            || new_chars_count == 0
            || new_chars_count > 8
            || text.chars().any(|ch| matches!(ch, '\r' | '\n' | '\t'))
        {
            return Err(HwpError::RenderError(
                "deferred 셀 replace는 줄바꿈·탭 없는 1~8자 교체만 지원합니다".to_string(),
            ));
        }

        let text_len = self
            .get_cell_paragraph_ref(
                section_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
            )
            .ok_or_else(|| HwpError::RenderError("교체할 셀 문단을 찾을 수 없습니다".to_string()))?
            .text
            .chars()
            .count();
        if char_offset > text_len || delete_count > text_len.saturating_sub(char_offset) {
            return Err(HwpError::RenderError(
                "deferred 셀 replace 범위가 문단 텍스트를 벗어났습니다".to_string(),
            ));
        }

        self.replace_text_in_cell_native_impl(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
            char_offset,
            delete_count,
            text,
            false,
        )
    }

    pub(crate) fn replace_text_in_cell_native_impl(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        char_offset: usize,
        delete_count: usize,
        text: &str,
        paginate_immediately: bool,
    ) -> Result<String, HwpError> {
        self.replace_text_in_cell_with_content_impl(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
            char_offset,
            delete_count,
            text,
            paginate_immediately,
            None,
        )
    }

    fn replace_text_in_cell_with_content_impl(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        char_offset: usize,
        delete_count: usize,
        text: &str,
        paginate_immediately: bool,
        content: Option<&crate::model::paragraph::TextContent>,
    ) -> Result<String, HwpError> {
        let after_control = self.caret_insert_after_control.take();
        // 셀 문단 접근 검증 및 텍스트 교체
        let active_field = self.active_field.clone();
        let cell_path = [(control_idx, cell_idx, cell_para_idx)];
        let cell_para = self.get_cell_paragraph_mut(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
        )?;
        let removed_start = char_offset.min(cell_para.text.chars().count());
        let removed_content = cell_para.capture_text_content(removed_start, delete_count);
        let flow_advance_before = relative_paragraph_flow_advance(cell_para);
        let local_contribution_before =
            crate::renderer::layout::LayoutEngine::paragraph_contributes_to_table_nested_text_flag(
                cell_para,
            );
        let deleted_count = if delete_count > 0 {
            cell_para.delete_text_at(char_offset, delete_count)
        } else {
            0
        };
        let new_chars_count = text.chars().count();
        let outside_insertions = inactive_field_end_insertions(
            cell_para,
            active_field.as_ref(),
            section_idx,
            cell_para_idx,
            Some(&cell_path),
            char_offset,
        );
        let before_insertions = inactive_field_start_insertions(
            cell_para,
            active_field.as_ref(),
            section_idx,
            cell_para_idx,
            Some(&cell_path),
            char_offset,
        );
        let inserted_at = if new_chars_count > 0 {
            let inserted_at =
                Self::insert_text_for_caret(cell_para, char_offset, text, after_control, content);
            keep_inactive_field_start_outside(cell_para, &before_insertions, new_chars_count);
            keep_inactive_field_end_outside(cell_para, &outside_insertions, new_chars_count);
            if has_clickhere_field_range(cell_para) {
                rebuild_char_offsets(cell_para);
            }
            inserted_at
        } else {
            removed_start
        };
        debug_assert_eq!(deleted_count, removed_content.text.chars().count());

        // 부모 컨트롤 dirty 마킹 (표 또는 글상자)
        self.mark_cell_control_dirty(section_idx, parent_para_idx, control_idx);

        // 셀 폭 기반 리플로우
        self.reflow_cell_paragraph(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
        );
        self.recalculate_cell_paragraph_vpos_native(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
            None,
        );

        let (flow_advance_after, local_contribution_after) = {
            let cell_para_after = self
                .get_cell_paragraph_ref(
                    section_idx,
                    parent_para_idx,
                    control_idx,
                    cell_idx,
                    cell_para_idx,
                )
                .ok_or_else(|| {
                    HwpError::RenderError("편집 뒤 셀 문단을 다시 찾을 수 없습니다".to_string())
                })?;
            (
                relative_paragraph_flow_advance(cell_para_after),
                crate::renderer::layout::LayoutEngine::paragraph_contributes_to_table_nested_text_flag(
                    cell_para_after,
                ),
            )
        };
        let cell_flow_changed = flow_advance_before != flow_advance_after;
        // Persist the edited cell's stale geometry in HWPX. The table's transient dirty bit
        // disappears on reopen, while the cell's dirty attribute survives serialization.
        // A same-height replacement must not change the saved row split.
        if flow_advance_after.unwrap_or(0) > flow_advance_before.unwrap_or(0)
            && (flow_advance_before.is_some() || new_chars_count > deleted_count)
        {
            if let Control::Table(table) = &mut self.document.sections[section_idx].paragraphs
                [parent_para_idx]
                .controls[control_idx]
            {
                if let Some(cell) = table.cells.get_mut(cell_idx) {
                    cell.dirty_flag = true;
                }
            }
        }

        // Table의 일반 cell만 pointer-key layout cache의 owner다. 표 캡션 sentinel과
        // Shape/Picture 텍스트 경로에는 cell_units cache가 없으므로 적용하지 않는다.
        if cell_idx != super::super::TABLE_CAPTION_CELL_SENTINEL {
            let control = &self.document.sections[section_idx].paragraphs[parent_para_idx].controls
                [control_idx];
            if let Control::Table(table) = control {
                if let Some(edited_cell) = table.cells.get(cell_idx) {
                    self.layout_engine.invalidate_cell_units_after_text_edit(
                        edited_cell,
                        table,
                        local_contribution_before,
                        local_contribution_after,
                    );
                }
            }
        }

        // [#2308] editable IR이 단일 권위 상태다. clone paragraph를 mirror하지 않고
        // 명시적 logical path revision만 갱신한다. #2004 호환 projection이 있는
        // 섹션은 transient render 전에 해당 revision으로 재파생한다.
        self.commit_cell_edit_geometry(
            section_idx,
            parent_para_idx,
            &[(control_idx, cell_idx, cell_para_idx)],
            cell_flow_changed,
        )?;
        let has_compat_projection = self
            .render_normalization
            .sections
            .get(section_idx)
            .is_some_and(|section| section.is_some());
        self.mark_render_normalization_path_dirty(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
        )?;
        if !paginate_immediately {
            let target_first_page =
                target_table_first_global_page(self, section_idx, parent_para_idx, control_idx);
            let table_structure_fingerprint = match &self.document.sections[section_idx].paragraphs
                [parent_para_idx]
                .controls[control_idx]
            {
                Control::Table(table) => table_structure_fingerprint(table),
                _ => 0,
            };
            let pending_flow_changed =
                self.deferred_pagination_descriptor
                    .as_ref()
                    .is_some_and(|pending| {
                        pending.section_index == section_idx
                            && pending.para_index == parent_para_idx
                            && pending.control_index == control_idx
                            && pending.cell_index == cell_idx
                            && pending.cell_para_index == cell_para_idx
                            && pending.cell_flow_changed
                    });
            self.deferred_pagination_revision =
                self.deferred_pagination_revision.wrapping_add(1).max(1);
            self.deferred_pagination_descriptor = Some(DeferredPaginationDescriptor {
                revision: self.deferred_pagination_revision,
                section_index: section_idx,
                para_index: parent_para_idx,
                control_index: control_idx,
                cell_index: cell_idx,
                cell_para_index: cell_para_idx,
                // 같은 target의 여러 deferred input 사이에서 한번 관측한 flow boundary는
                // full pagination이 소비할 때까지 유지한다.
                cell_flow_changed: pending_flow_changed || cell_flow_changed,
                target_first_page,
                table_structure_fingerprint,
            });
        }
        // raw 스트림 무효화, 재페이지네이션 (셀 편집 → composed 불변, section dirty만 설정)
        self.document.sections[section_idx].raw_stream = None;
        if has_compat_projection {
            self.invalidate_render_normalization_section(section_idx);
        }
        if has_compat_projection && !paginate_immediately {
            self.compute_render_normalized();
        }
        self.mark_section_pagination_dirty(section_idx);
        self.invalidate_page_tree_cache_from_section(section_idx);
        if paginate_immediately {
            self.paginate_if_needed();
        }

        let new_offset = inserted_at + new_chars_count;
        self.event_log.push(DocumentEvent::CellTextChanged {
            section: section_idx,
            para: parent_para_idx,
            ctrl: control_idx,
            cell: cell_idx,
        });
        let result_fields = if paginate_immediately {
            format!("\"charOffset\":{}", new_offset)
        } else {
            format!(
                "\"charOffset\":{},\"cellFlowChanged\":{}",
                new_offset, cell_flow_changed
            )
        };
        Ok(super::super::helpers::json_ok_with(&format!(
            "{},{}",
            result_fields,
            super::super::helpers::removed_content_fields(removed_start, &removed_content)
        )))
    }

    /// 표 셀 내부 문단에서 텍스트 삭제 (네이티브)
    pub fn delete_text_in_cell_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        char_offset: usize,
        count: usize,
    ) -> Result<String, HwpError> {
        self.delete_text_in_cell_native_impl(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
            char_offset,
            count,
            true,
        )
    }

    /// 표 셀 내부 단일 텍스트 삭제 후 전체 페이지네이션을 호출자가 지연한다.
    /// 결과 JSON의 `cellFlowChanged`는 상대 line advance 변화 여부다.
    pub fn delete_text_in_cell_native_deferred_pagination(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        char_offset: usize,
        count: usize,
    ) -> Result<String, HwpError> {
        self.delete_text_in_cell_native_impl(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
            char_offset,
            count,
            false,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn delete_text_in_cell_native_impl(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        char_offset: usize,
        count: usize,
        paginate_immediately: bool,
    ) -> Result<String, HwpError> {
        // 셀 문단 접근 검증 및 텍스트 삭제
        let cell_para = self.get_cell_paragraph_mut(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
        )?;
        let removed_start = char_offset.min(cell_para.text.chars().count());
        let removed_content = cell_para.capture_text_content(removed_start, count);
        let flow_advance_before = relative_paragraph_flow_advance(cell_para);
        let local_contribution_before =
            crate::renderer::layout::LayoutEngine::paragraph_contributes_to_table_nested_text_flag(
                cell_para,
            );
        cell_para.delete_text_at(char_offset, count);

        // 부모 컨트롤 dirty 마킹 (표 또는 글상자)
        self.mark_cell_control_dirty(section_idx, parent_para_idx, control_idx);

        // 셀 폭 기반 리플로우
        self.reflow_cell_paragraph(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
        );
        self.recalculate_cell_paragraph_vpos_native(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
            None,
        );

        let (flow_advance_after, local_contribution_after) = {
            let cell_para_after = self
                .get_cell_paragraph_ref(
                    section_idx,
                    parent_para_idx,
                    control_idx,
                    cell_idx,
                    cell_para_idx,
                )
                .ok_or_else(|| {
                    HwpError::RenderError("삭제 뒤 셀 문단을 다시 찾을 수 없습니다".to_string())
                })?;
            (
                relative_paragraph_flow_advance(cell_para_after),
                crate::renderer::layout::LayoutEngine::paragraph_contributes_to_table_nested_text_flag(
                    cell_para_after,
                ),
            )
        };
        let cell_flow_changed = flow_advance_before != flow_advance_after;

        // Table의 일반 cell만 pointer-key layout cache의 owner다.
        if cell_idx != 65534 {
            let control = &self.document.sections[section_idx].paragraphs[parent_para_idx].controls
                [control_idx];
            if let Control::Table(table) = control {
                if let Some(edited_cell) = table.cells.get(cell_idx) {
                    self.layout_engine.invalidate_cell_units_after_text_edit(
                        edited_cell,
                        table,
                        local_contribution_before,
                        local_contribution_after,
                    );
                }
            }
        }

        self.commit_cell_edit_geometry(
            section_idx,
            parent_para_idx,
            &[(control_idx, cell_idx, cell_para_idx)],
            cell_flow_changed,
        )?;
        let refresh_compat_projection = !paginate_immediately
            && self
                .render_normalization
                .sections
                .get(section_idx)
                .is_some_and(|section| section.is_some());
        self.mark_render_normalization_path_dirty(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
        )?;
        if !paginate_immediately {
            let target_first_page =
                target_table_first_global_page(self, section_idx, parent_para_idx, control_idx);
            let table_structure_fingerprint = match &self.document.sections[section_idx].paragraphs
                [parent_para_idx]
                .controls[control_idx]
            {
                Control::Table(table) => table_structure_fingerprint(table),
                _ => 0,
            };
            let pending_flow_changed =
                self.deferred_pagination_descriptor
                    .as_ref()
                    .is_some_and(|pending| {
                        pending.section_index == section_idx
                            && pending.para_index == parent_para_idx
                            && pending.control_index == control_idx
                            && pending.cell_index == cell_idx
                            && pending.cell_para_index == cell_para_idx
                            && pending.cell_flow_changed
                    });
            self.deferred_pagination_revision =
                self.deferred_pagination_revision.wrapping_add(1).max(1);
            self.deferred_pagination_descriptor = Some(DeferredPaginationDescriptor {
                revision: self.deferred_pagination_revision,
                section_index: section_idx,
                para_index: parent_para_idx,
                control_index: control_idx,
                cell_index: cell_idx,
                cell_para_index: cell_para_idx,
                cell_flow_changed: pending_flow_changed || cell_flow_changed,
                target_first_page,
                table_structure_fingerprint,
            });
        }

        // raw 스트림 무효화, 재페이지네이션 (셀 편집 → composed 불변)
        self.document.sections[section_idx].raw_stream = None;
        if refresh_compat_projection {
            self.invalidate_render_normalization_section(section_idx);
            self.compute_render_normalized();
        }
        self.mark_section_pagination_dirty(section_idx);
        self.invalidate_page_tree_cache_from_section(section_idx);
        if paginate_immediately {
            self.paginate_if_needed();
        }

        self.event_log.push(DocumentEvent::CellTextChanged {
            section: section_idx,
            para: parent_para_idx,
            ctrl: control_idx,
            cell: cell_idx,
        });
        let result_fields = if paginate_immediately {
            format!("\"charOffset\":{}", char_offset)
        } else {
            format!(
                "\"charOffset\":{},\"cellFlowChanged\":{}",
                char_offset, cell_flow_changed
            )
        };
        Ok(super::super::helpers::json_ok_with(&format!(
            "{},{}",
            result_fields,
            super::super::helpers::removed_content_fields(removed_start, &removed_content)
        )))
    }

    /// 평면 셀 좌표가 가리키는 문단 목록(표 셀, 표 캡션 `cell_idx == 65534`, 글상자,
    /// 그림 캡션)에 대한 가변 참조를 얻는다.
    ///
    /// 분할·병합·범위 삭제가 모두 이 해석기 하나로 컨테이너를 찾는다. 컨트롤 종류별 분기를
    /// 따로 두면 표 셀만 아는 경로가 캡션에서 `cells[65534]` 로 panic 하거나, 문단을 자른
    /// 뒤에야 Err 를 내 반쯤 적용된 편집을 남긴다.
    pub(crate) fn cell_container_paragraphs_mut(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
    ) -> Result<&mut Vec<Paragraph>, HwpError> {
        let section = self.document.sections.get_mut(section_idx).ok_or_else(|| {
            HwpError::RenderError(format!("구역 인덱스 {} 범위 초과", section_idx))
        })?;
        let para = section.paragraphs.get_mut(parent_para_idx).ok_or_else(|| {
            HwpError::RenderError(format!("부모 문단 인덱스 {} 범위 초과", parent_para_idx))
        })?;
        let control = para.controls.get_mut(control_idx).ok_or_else(|| {
            HwpError::RenderError(format!("컨트롤 인덱스 {} 범위 초과", control_idx))
        })?;
        match control {
            Control::Table(t) => {
                // cell_idx == 65534: 표 캡션 접근 (TypeScript에서 표 캡션 편집 시 사용)
                if cell_idx == 65534 {
                    return t
                        .caption
                        .as_mut()
                        .map(|cap| &mut cap.paragraphs)
                        .ok_or_else(|| {
                            HwpError::RenderError("지정된 표 컨트롤에 캡션이 없습니다".to_string())
                        });
                }
                let cell_count = t.cells.len();
                t.cells
                    .get_mut(cell_idx)
                    .map(|cell| &mut cell.paragraphs)
                    .ok_or_else(|| {
                        HwpError::RenderError(format!(
                            "셀 인덱스 {} 범위 초과 (총 {}개)",
                            cell_idx, cell_count
                        ))
                    })
            }
            Control::Shape(shape) => {
                if cell_idx != 0 {
                    return Err(HwpError::RenderError(format!(
                        "글상자 셀 인덱스는 0이어야 합니다 (요청: {})",
                        cell_idx
                    )));
                }
                super::super::helpers::get_textbox_from_shape_mut(shape)
                    .map(|tb| &mut tb.paragraphs)
                    .ok_or_else(|| {
                        HwpError::RenderError(
                            "지정된 Shape 컨트롤에 텍스트 박스가 없습니다".to_string(),
                        )
                    })
            }
            Control::Picture(pic) => pic
                .caption
                .as_mut()
                .map(|cap| &mut cap.paragraphs)
                .ok_or_else(|| {
                    HwpError::RenderError("지정된 그림 컨트롤에 캡션이 없습니다".to_string())
                }),
            _ => Err(HwpError::RenderError(
                "지정된 컨트롤이 표, 글상자 또는 그림이 아닙니다".to_string(),
            )),
        }
    }

    /// 표 셀·표 캡션·글상자·그림 캡션 내부 문단에 대한 가변 참조를 얻는다.
    pub(crate) fn get_cell_paragraph_mut(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
    ) -> Result<&mut crate::model::paragraph::Paragraph, HwpError> {
        let paragraphs = self.cell_container_paragraphs_mut(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
        )?;
        let total = paragraphs.len();
        paragraphs.get_mut(cell_para_idx).ok_or_else(|| {
            HwpError::RenderError(format!(
                "셀 문단 인덱스 {} 범위 초과 (총 {}개)",
                cell_para_idx, total
            ))
        })
    }

    /// 부모 컨트롤(표 또는 글상자)의 dirty를 마킹한다.
    pub(crate) fn mark_cell_control_dirty(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
    ) {
        if let Some(ctrl) = self.document.sections[section_idx].paragraphs[parent_para_idx]
            .controls
            .get_mut(control_idx)
        {
            match ctrl {
                Control::Table(t) => {
                    t.dirty = true;
                }
                // Shape는 별도 dirty 필드가 없으므로 section dirty만으로 충분
                _ => {}
            }
        }
    }

    /// 최내곽 표부터 현재 높이와 개체 줄을 확정한 뒤 상위 셀을 다시 측정한다.
    /// 선언 cell.height는 보존하고 HWP CTRL_HEADER와 본문 조판도 같은 결과를 본다.
    fn commit_cell_edit_geometry(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        flow_changed: bool,
    ) -> Result<(), HwpError> {
        use crate::renderer::composer::refresh_inline_table_host_metrics;
        use crate::renderer::height_measurer::HeightMeasurer;

        if !flow_changed {
            return Ok(());
        }
        let _font_scope = crate::renderer::layout::enter_resolved_shaping_fonts(
            self.collect_resolved_shaping_fonts(),
        );
        // 로컬 크기 조정의 독립 셀 배분은 기존 renderer 경로가 소유한다.
        for level in 0..path.len() {
            let owner = if level == 0 {
                &self.document.sections[section_idx].paragraphs[parent_para_idx]
            } else {
                self.resolve_paragraph_by_path(section_idx, parent_para_idx, &path[..level])?
            };
            if let Some(Control::Table(table)) = owner.controls.get(path[level].0) {
                // 필드/미지원 제어 슬롯의 저장 줄 귀속이 모호하면 기존 재측정 경로를
                // 유지한다. 하위 표의 새 높이만 먼저 발행해 부모 줄을 남겨두지 않는다.
                if table.common.treat_as_char
                    && path[level].1 != super::super::TABLE_CAPTION_CELL_SENTINEL
                    && crate::renderer::composer::inline_table_host_line_index(owner, path[level].0)
                        .and_then(|index| owner.line_segs.get(index))
                        .is_none()
                {
                    return Ok(());
                }
                if !table.local_resize_rows.is_empty()
                    || !table.local_resize_cols.is_empty()
                    || !table.local_resize_cell_widths.is_empty()
                    || !table.local_resize_cell_heights.is_empty()
                {
                    return Ok(());
                }
            }
        }
        self.document.sections[section_idx].raw_stream = None;
        let profile = self.document.layout_profile();
        let dpi = self.dpi;
        let styles = self.resolve_document_styles();
        let measurer = HeightMeasurer::new(dpi)
            .with_own_line_layout(profile.own_line_layout())
            .with_hwp3_variant(profile.hwp3_layout())
            .with_hwpx_cell_spacing(profile.hwpx_stored_layout() && !profile.hwp5_origin_hwpx())
            .with_native_hwpx_cell_margin(profile.native_hwpx_cell_margin())
            .with_native_hwp5_cell_spacing(
                profile.native_hwp5_layout() || profile.hwp5_origin_hwpx(),
            )
            .with_session_edited(profile.session_edited())
            .with_render_normalization(std::sync::Arc::clone(&self.render_normalization.overlay));
        let mut changed = false;
        let mut root_margin_box_stored_end = None;
        for level in (0..path.len()).rev() {
            let control_index = path[level].0;
            let owner = if level == 0 {
                &mut self.document.sections[section_idx].paragraphs[parent_para_idx]
            } else {
                self.get_cell_paragraph_mut_by_path(section_idx, parent_para_idx, &path[..level])?
            };
            if let Some(Control::Table(table)) = owner.controls.get_mut(control_index) {
                if let Some(cell) = table.cells.get_mut(path[level].1) {
                    cell.dirty_flag = true;
                }
            }
            let owner = if level == 0 {
                &self.document.sections[section_idx].paragraphs[parent_para_idx]
            } else {
                self.resolve_paragraph_by_path(section_idx, parent_para_idx, &path[..level])?
            };
            let Some(Control::Table(table)) = owner.controls.get(control_index) else {
                continue;
            };
            // 본문 paper-overlay의 common.height는 인접 배치와 쪽번호 여유를
            // 판정하는 원래 할당이다. 실측 성장은 기존 renderer가 소유한다.
            // 하위 TAC 표와 그 개체 줄은 먼저 확정하고 이 루트 할당만 보존한다.
            if level == 0
                && !table.common.treat_as_char
                && table.common.vert_rel_to == crate::model::shape::VertRelTo::Paper
                && table.common.horz_rel_to == crate::model::shape::HorzRelTo::Paper
                && matches!(
                    table.common.vert_align,
                    crate::model::shape::VertAlign::Top | crate::model::shape::VertAlign::Inside
                )
                && matches!(
                    table.common.text_wrap,
                    crate::model::shape::TextWrap::InFrontOfText
                        | crate::model::shape::TextWrap::BehindText
                )
                && table.caption.is_none()
            {
                continue;
            }
            // 캡션은 셀 행과 별도 프레임이다.
            if path[level].1 == super::super::TABLE_CAPTION_CELL_SENTINEL {
                continue;
            }
            let previous = (level == 0)
                .then(|| {
                    self.measured_sections.get(section_idx).and_then(|section| {
                        section.get_measured_table(parent_para_idx, control_index)
                    })
                })
                .flatten();
            let measured = measurer.measure_table_after_edit(
                table,
                parent_para_idx,
                control_index,
                &styles,
                level,
                path[level].1,
                previous,
            );
            let height = crate::renderer::px_to_hwpunit_round(
                measured.cumulative_heights.last().copied().unwrap_or(0.0),
                dpi,
            )
            .max(0) as u32;
            if height == 0 || height == table.common.height {
                continue;
            }
            // 개체 높이를 덮기 전에 원본 배타 상자 끝을 인증한다. 측정 baseline은
            // 정규화된 행 배분이므로 원본 common.height의 대용물이 아니다.
            if level == 0 {
                let paragraphs = &self.document.sections[section_idx].paragraphs;
                if crate::renderer::float_placement::native_empty_host_margin_box_outer_top_hu(
                    profile.native_hwp5_layout(),
                    owner,
                    table,
                    paragraphs.get(parent_para_idx + 1),
                    &styles,
                )
                .is_some()
                {
                    root_margin_box_stored_end = paragraphs
                        .get(parent_para_idx + 1)
                        .and_then(|next| next.line_segs.first())
                        .map(|line| line.vertical_pos);
                }
            }
            let owner = if level == 0 {
                &mut self.document.sections[section_idx].paragraphs[parent_para_idx]
            } else {
                self.get_cell_paragraph_mut_by_path(section_idx, parent_para_idx, &path[..level])?
            };
            let Some(Control::Table(table)) = owner.controls.get_mut(control_index) else {
                continue;
            };
            table.sync_ctrl_height(height);
            table.dirty = true;
            let host_changed =
                refresh_inline_table_host_metrics(owner, control_index, &styles, dpi);
            if host_changed && level > 0 {
                let parent_path = &path[..level];
                self.recalculate_cell_paragraph_vpos_by_path(
                    section_idx,
                    parent_para_idx,
                    parent_path,
                    parent_path[level - 1].2,
                    None,
                );
            }
            changed = true;
        }
        if let Some(stored_end) = root_margin_box_stored_end {
            // 호스트 원점은 유지하고 현재 높이로 다음 본문 사다리만 다시 잇는다.
            // 이전 끝을 전달해야 성장이 쪽/단 리셋으로 오인되지 않는다.
            // 양수 원점인 명시적 쪽/단 경계도 앞 프레임의 delta를 받지 않는다.
            // 전역 재계산기의 implicit reset 계약은 이 연속 창 안에서 그대로 쓴다.
            let paragraphs = &self.document.sections[section_idx].paragraphs;
            let frame_end = paragraphs
                .iter()
                .enumerate()
                .skip(parent_para_idx + 1)
                .find_map(|(index, para)| {
                    (!matches!(
                        para.column_type,
                        crate::model::paragraph::ColumnBreakType::None
                    ) || styles
                        .para_styles
                        .get(para.para_shape_id as usize)
                        .is_some_and(|style| style.page_break_before))
                    .then_some(index)
                })
                .unwrap_or(paragraphs.len());
            let before: Vec<Vec<i32>> = self.document.sections[section_idx].paragraphs
                [parent_para_idx..frame_end]
                .iter()
                .map(|para| {
                    para.line_segs
                        .iter()
                        .map(|line| line.vertical_pos)
                        .collect()
                })
                .collect();
            crate::renderer::composer::recalculate_section_vpos_for_body(
                &mut self.document.sections[section_idx].paragraphs[parent_para_idx..frame_end],
                0,
                None,
                Some(stored_end),
                &styles,
                dpi,
                false,
                false,
            );
            let shifted: Vec<usize> = self.document.sections[section_idx].paragraphs
                [parent_para_idx..frame_end]
                .iter()
                .zip(&before)
                .enumerate()
                .filter_map(|(index, (para, before))| {
                    (!para
                        .line_segs
                        .iter()
                        .map(|line| line.vertical_pos)
                        .eq(before.iter().copied()))
                    .then_some(parent_para_idx + index)
                })
                .collect();
            if !shifted.is_empty() {
                for para_index in shifted {
                    let mut composed = crate::renderer::composer::compose_paragraph_with_styles(
                        &self.document.sections[section_idx].paragraphs[para_index],
                        &styles,
                    );
                    if let Some(slot) = self
                        .composed
                        .get_mut(section_idx)
                        .and_then(|section| section.get_mut(para_index))
                    {
                        composed.copy_numbering_from(slot);
                        *slot = composed;
                    }
                    self.event_log
                        .mark_paragraph_changed(section_idx, para_index);
                    self.mark_paragraph_dirty(section_idx, para_index);
                }
                // LS 원점은 직렬화/Snapshot의 실제 IR이다. normalization과 페이지
                // cache도 같은 구역 revision을 보고 다시 만든다.
                self.mark_section_dirty(section_idx);
            }
        }
        if changed {
            let composed = crate::renderer::composer::compose_paragraph_with_styles(
                &self.document.sections[section_idx].paragraphs[parent_para_idx],
                &styles,
            );
            if let Some(slot) = self
                .composed
                .get_mut(section_idx)
                .and_then(|section| section.get_mut(parent_para_idx))
            {
                let mut composed = composed;
                composed.copy_numbering_from(slot);
                *slot = composed;
            }
            self.mark_paragraph_dirty(section_idx, parent_para_idx);
            self.invalidate_page_tree_cache_from_section(section_idx);
        }
        Ok(())
    }

    pub(crate) fn reflow_cell_paragraph(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
    ) {
        use crate::renderer::hwpunit_to_px;

        // 셀/글상자 폭과 패딩 읽기 (불변 참조) — path 변형과 공유하는 helper 사용.
        let (cell_width, pad_left, pad_right) = match self.document.sections[section_idx].paragraphs
            [parent_para_idx]
            .controls
            .get(control_idx)
            .and_then(|control| self.cell_metrics_for_control(control, cell_idx))
        {
            Some(metrics) => metrics,
            None => return,
        };

        let styles = self.resolve_document_styles();

        // 문단 여백 계산
        let para_shape_id = {
            let cell_para = self.get_cell_paragraph_ref(
                section_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
            );
            match cell_para {
                Some(p) => p.para_shape_id,
                None => return,
            }
        };
        // 로드 합성·path 리플로우와 같은 한컴 셀 줄 폭 모델.
        let final_width = Self::reflow_width_from_cell_metrics(
            (cell_width, pad_left, pad_right),
            para_shape_id,
            &styles,
            self.dpi,
        );

        // 가변 참조로 리플로우 실행
        match self.document.sections[section_idx].paragraphs[parent_para_idx]
            .controls
            .get_mut(control_idx)
        {
            Some(Control::Table(table)) => {
                let squeeze = cell_idx != 65534
                    && table
                        .cells
                        .get(cell_idx)
                        .is_some_and(|c| c.line_wrap == crate::model::table::CellLineWrap::Squeeze);
                let known_horizontal = table
                    .cells
                    .get(cell_idx)
                    .is_some_and(|cell| cell.text_direction == 0);
                let cell_para = if cell_idx == 65534 {
                    table
                        .caption
                        .as_mut()
                        .and_then(|caption| caption.paragraphs.get_mut(cell_para_idx))
                } else {
                    table
                        .cells
                        .get_mut(cell_idx)
                        .and_then(|cell| cell.paragraphs.get_mut(cell_para_idx))
                };
                if let Some(cell_para) = cell_para {
                    reflow_cell_line_segs(
                        cell_para,
                        final_width,
                        squeeze,
                        known_horizontal,
                        &styles,
                        self.dpi,
                    );
                }
            }
            Some(Control::Shape(shape)) => {
                if let Some(tb) = super::super::helpers::get_textbox_from_shape_mut(shape) {
                    if let Some(cell_para) = tb.paragraphs.get_mut(cell_para_idx) {
                        reflow_line_segs(cell_para, final_width, &styles, self.dpi);
                    }
                }
            }
            Some(Control::Picture(pic)) => {
                if let Some(ref mut cap) = pic.caption {
                    if let Some(cell_para) = cap.paragraphs.get_mut(cell_para_idx) {
                        reflow_line_segs(cell_para, final_width, &styles, self.dpi);
                    }
                }
            }
            _ => {}
        }
    }

    pub(crate) fn recalculate_cell_paragraph_vpos_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        start_para: usize,
        ignore_reset_at: Option<usize>,
    ) {
        let styles = &self.styles;
        let dpi = self.dpi;
        let is_hwp3_variant = self.document.layout_profile().hwp3_layout();
        let Some(control) = self.document.sections[section_idx].paragraphs[parent_para_idx]
            .controls
            .get_mut(control_idx)
        else {
            return;
        };
        let paragraphs = match control {
            Control::Table(table) if cell_idx == 65534 => {
                let Some(caption) = table.caption.as_mut() else {
                    return;
                };
                &mut caption.paragraphs
            }
            Control::Table(table) => {
                let Some(cell) = table.cells.get_mut(cell_idx) else {
                    return;
                };
                &mut cell.paragraphs
            }
            Control::Shape(shape) => {
                let Some(textbox) = super::super::helpers::get_textbox_from_shape_mut(shape) else {
                    return;
                };
                &mut textbox.paragraphs
            }
            Control::Picture(picture) => {
                let Some(caption) = picture.caption.as_mut() else {
                    return;
                };
                &mut caption.paragraphs
            }
            _ => return,
        };
        recalculate_cell_paragraph_vpos(
            paragraphs,
            start_para,
            ignore_reset_at,
            styles,
            dpi,
            is_hwp3_variant,
        );
    }

    /// [#2755] 컨트롤+cell_idx 로부터 셀 폭·좌우 패딩(HWPUNIT)을 해석한다.
    ///
    /// `reflow_cell_paragraph`(flat)와 `reflow_cell_paragraph_by_path`(중첩)가 공유한다.
    /// `None` = 표/글상자/그림 캡션이 아니거나 대상 셀/텍스트박스가 없음.
    ///
    /// 표 셀 폭은 `cell.width` 가 아니라 레이아웃이 실제로 그리는 그리드 폭이다. 두 값이
    /// 어긋난 표에서 `cell.width` 로 줄을 나누면 그려진 셀보다 좁게 끊긴 줄이 양쪽 정렬로
    /// 크게 벌어진다.
    fn cell_metrics_for_control(
        &self,
        control: &Control,
        cell_idx: usize,
    ) -> Option<(u32, i16, i16)> {
        match control {
            Control::Table(table) => {
                if cell_idx == 65534 {
                    // 표 캡션: Top/Bottom 은 max_width, Left/Right 는 width.
                    let cap = table.caption.as_ref()?;
                    use crate::model::shape::CaptionDirection;
                    let w = match cap.direction {
                        CaptionDirection::Left | CaptionDirection::Right => cap.width,
                        _ => cap.max_width,
                    };
                    Some((w, 0, 0))
                } else {
                    if table
                        .cells
                        .get(cell_idx)
                        .is_some_and(Self::cell_uses_vertical_reflow)
                    {
                        let styles = self.resolve_document_styles();
                        return Self::table_cells_reflow_metrics(
                            table,
                            &styles,
                            self.dpi,
                            self.document.layout_profile(),
                        )
                        .get(cell_idx)
                        .copied()
                        .flatten();
                    }
                    let text_width =
                        crate::renderer::layout::LayoutEngine::table_cell_text_width_hu(
                            table, cell_idx,
                        );
                    Self::table_cell_metrics(table, cell_idx, text_width)
                }
            }
            Control::Shape(shape) => {
                let tb = super::super::helpers::get_textbox_from_shape(shape)?;
                let common = shape.common();
                Some((common.width as u32, tb.margin_left, tb.margin_right))
            }
            Control::Picture(pic) => Some((pic.common.width as u32, 0, 0)),
            _ => None,
        }
    }

    /// 표 셀의 (논리적 줄 길이, 시작/끝 패딩) HWPUNIT. 가로쓰기는 셀 글 영역 폭과
    /// 좌우 안 여백, 세로쓰기는 셀 높이와 위아래 안 여백을 사용한다. 편집 reflow 와
    /// lineseg 오라클(일괄 폭 조회)이 공유한다.
    ///
    /// 안 여백은 `셀 안 여백 지정`(apply_inner_margin)이면 셀 값, 아니면 표 기본 값이다.
    /// 표 기본 좌우가 0 이어도 셀 저장 값으로 바꾸지 않는다 — 한컴 저장 줄 폭 실측
    /// (aim=false·표 기본 좌우 0 셀 4.7천 문단: 표 0 일치, 셀 값 일치 0).
    pub(crate) fn table_cell_metrics(
        table: &crate::model::table::Table,
        cell_idx: usize,
        text_width: Option<u32>,
    ) -> Option<(u32, i16, i16)> {
        let cell = table.cells.get(cell_idx)?;
        let padding = if cell.apply_inner_margin {
            &cell.padding
        } else {
            &table.padding
        };
        if Self::cell_uses_vertical_reflow(cell) {
            Some((cell.height, padding.top, padding.bottom))
        } else {
            Some((
                text_width.unwrap_or(cell.width),
                padding.left,
                padding.right,
            ))
        }
    }

    /// 셀·글상자·캡션 (폭, 좌 패딩, 우 패딩) HWPUNIT 에서 문단 재래핑 폭(px).
    ///
    /// 한컴 규칙(저장 LINE_SEG 실측): 내폭 = 폭 − 좌우 안 여백을 4 HWPUNIT(1/1800인치)
    /// 격자로 내리고, 문단 좌우 여백을 뺀 줄 폭은 1440 HWPUNIT(0.2인치) 아래로 내려가지
    /// 않는다 (좁은 셀·글상자도 줄 폭 1440).
    pub(crate) fn reflow_width_from_cell_metrics(
        (cell_width, pad_left, pad_right): (u32, i16, i16),
        para_shape_id: u16,
        styles: &ResolvedStyleSet,
        dpi: f64,
    ) -> f64 {
        let inner = i64::from(cell_width) - i64::from(pad_left) - i64::from(pad_right);
        Self::hancom_line_width_px(
            inner,
            para_shape_id,
            styles,
            dpi,
            MIN_CONTAINER_LINE_WIDTH_HU,
        )
    }

    /// 글 영역 폭(HWPUNIT)에서 한컴 줄 폭(px): 4 HWPUNIT 격자로 내린 뒤 문단 좌우 여백을
    /// 빼고 `min_hu` 로 하한을 둔다. 본문 단·셀·글상자·각주가 공유한다.
    pub(crate) fn hancom_line_width_px(
        area_hu: i64,
        para_shape_id: u16,
        styles: &ResolvedStyleSet,
        dpi: f64,
        min_hu: i64,
    ) -> f64 {
        use crate::renderer::{hwpunit_to_px, px_to_hwpunit_round};
        let para_style = styles.para_styles.get(para_shape_id as usize);
        let margin_hu = |px: Option<f64>| i64::from(px_to_hwpunit_round(px.unwrap_or(0.0), dpi));
        let margins = margin_hu(para_style.map(|s| s.margin_left))
            + margin_hu(para_style.map(|s| s.margin_right));
        let line = (area_hu.max(0).div_euclid(4) * 4 - margins)
            .max(min_hu)
            .max(0);
        hwpunit_to_px(line as i32, dpi)
    }

    /// [#2755] path 의 CellPathEntry 사슬을 따라 **최내곽** 셀의 폭·좌우 패딩(HWPUNIT)을
    /// 해석한다. 마지막 엔트리를 제외한 각 엔트리에서 다음 중첩 컨트롤을 담은 컨테이너
    /// 문단(`cell_para_idx`)으로 하강한다 — `get_cell_paragraphs_mut_by_path` 의 불변 짝이다.
    pub(crate) fn resolve_innermost_cell_metrics(
        &self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
    ) -> Option<(u32, i16, i16)> {
        let (control, cell_idx) =
            self.innermost_cell_control(section_idx, parent_para_idx, path)?;
        self.cell_metrics_for_control(control, cell_idx)
    }

    /// path 최내곽 셀이 `줄 넘침: 글자 줄임`(Squeeze) 표 셀인지.
    pub(crate) fn innermost_cell_squeezes(
        &self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
    ) -> bool {
        self.innermost_cell_control(section_idx, parent_para_idx, path)
            .is_some_and(|(control, cell_idx)| cell_squeezes(control, cell_idx))
    }

    /// path 사슬을 따라 최내곽 (컨트롤, 셀 인덱스)를 찾는다.
    fn innermost_cell_control(
        &self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
    ) -> Option<(&Control, usize)> {
        let mut para = self
            .document
            .sections
            .get(section_idx)?
            .paragraphs
            .get(parent_para_idx)?;
        for (i, &(ctrl_idx, cell_idx, cell_para_idx)) in path.iter().enumerate() {
            let control = para.controls.get(ctrl_idx)?;
            if i + 1 == path.len() {
                return Some((control, cell_idx));
            }
            para = match control {
                Control::Table(t) => t.cells.get(cell_idx)?.paragraphs.get(cell_para_idx)?,
                Control::Shape(s) => super::super::helpers::get_textbox_from_shape(s)?
                    .paragraphs
                    .get(cell_para_idx)?,
                Control::Picture(p) => p.caption.as_ref()?.paragraphs.get(cell_para_idx)?,
                _ => return None,
            };
        }
        None
    }

    /// [#2755] path 기반 셀 리플로우 (깊이 ≥ 2 중첩 표 지원).
    ///
    /// `reflow_cell_paragraph`(flat)는 최외곽 표만 리플로우한다. 이 변형은 path 의
    /// CellPathEntry 사슬로 **최내곽** 셀의 폭을 해석하고, 그 폭으로 최내곽 셀의
    /// `cell_para_idx` 문단을 재래핑한다. 깊이 1 에서는 flat 형제와 동일한 결과를 낸다.
    pub(crate) fn reflow_cell_paragraph_by_path(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        cell_para_idx: usize,
    ) {
        let styles = self.resolve_document_styles();
        let dpi = self.dpi;
        let Some(para_shape_id) = self
            .get_cell_paragraphs_mut_by_path(section_idx, parent_para_idx, path)
            .ok()
            .and_then(|paras| paras.get(cell_para_idx))
            .map(|para| para.para_shape_id)
        else {
            return;
        };
        let Some(final_width) = self.cell_reflow_width_by_path(
            section_idx,
            parent_para_idx,
            path,
            para_shape_id,
            &styles,
        ) else {
            return;
        };
        let squeeze = self.innermost_cell_squeezes(section_idx, parent_para_idx, path);
        let known_horizontal = self
            .innermost_cell_control(section_idx, parent_para_idx, path)
            .is_some_and(|(control, cell_idx)| {
                matches!(control, Control::Table(table)
                if table.cells.get(cell_idx).is_some_and(|cell| cell.text_direction == 0))
            });
        let Ok(paras) = self.get_cell_paragraphs_mut_by_path(section_idx, parent_para_idx, path)
        else {
            return;
        };
        if let Some(cell_para) = paras.get_mut(cell_para_idx) {
            reflow_cell_line_segs(
                cell_para,
                final_width,
                squeeze,
                known_horizontal,
                &styles,
                dpi,
            );
        }
    }

    /// path 최내곽 셀·글상자·캡션 문단의 재래핑 폭(px) — 셀 내폭에서 문단 좌우 여백을
    /// 뺀다. path 리플로우와 lineseg 오라클(`diagnostics::lineseg_oracle`)이 공유한다.
    pub(crate) fn cell_reflow_width_by_path(
        &self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        para_shape_id: u16,
        styles: &ResolvedStyleSet,
    ) -> Option<f64> {
        let metrics = self.resolve_innermost_cell_metrics(section_idx, parent_para_idx, path)?;
        Some(Self::reflow_width_from_cell_metrics(
            metrics,
            para_shape_id,
            styles,
            self.dpi,
        ))
    }

    /// [#2755] path 기반 셀 문단 vpos 재계산 (깊이 ≥ 2 중첩 표 지원).
    /// `recalculate_cell_paragraph_vpos_native` 의 path 변형.
    pub(crate) fn recalculate_cell_paragraph_vpos_by_path(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        start_para: usize,
        ignore_reset_at: Option<usize>,
    ) {
        let styles = self.resolve_document_styles();
        let dpi = self.dpi;
        let is_hwp3_variant = self.document.layout_profile().hwp3_layout();
        if let Ok(paras) = self.get_cell_paragraphs_mut_by_path(section_idx, parent_para_idx, path)
        {
            recalculate_cell_paragraph_vpos(
                paras,
                start_para,
                ignore_reset_at,
                &styles,
                dpi,
                is_hwp3_variant,
            );
        }
    }

    // ─── Phase 3 네이티브 구현: 커서 이동 API ─────────────────

    pub(crate) fn delete_range_native(
        &mut self,
        section_idx: usize,
        start_para: usize,
        start_offset: usize,
        end_para: usize,
        end_offset: usize,
        cell_ctx: Option<(usize, usize, usize)>,
    ) -> Result<String, HwpError> {
        // 인덱스/범위 검증 — section_idx 범위, start/end para 범위, 뒤집힌 오프셋(start > end)
        if section_idx >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!(
                "구역 인덱스 {} 범위 초과 (총 {}개)",
                section_idx,
                self.document.sections.len()
            )));
        }
        if start_para > end_para {
            return Err(HwpError::RenderError(format!(
                "시작 문단 {} 이 끝 문단 {} 보다 뒤에 있습니다",
                start_para, end_para
            )));
        }
        if start_para == end_para && start_offset > end_offset {
            return Err(HwpError::RenderError(format!(
                "시작 오프셋 {} 이 끝 오프셋 {} 보다 뒤에 있습니다",
                start_offset, end_offset
            )));
        }
        if let Some((ppi, ci, cei)) = cell_ctx {
            // 셀 양 끝 문단이 실제로 있는지 변형 전에 확인한다. 같은 문단·빈 범위는 셀을
            // 해석하지 않고 mark_cell_control_dirty 로 가므로, 거르지 않으면 범위 밖 부모
            // 문단 인덱싱이 panic 한다(wasm 에서는 인스턴스 전체가 멈춘다).
            for cell_para in [start_para, end_para] {
                if self
                    .get_cell_paragraph_ref(section_idx, ppi, ci, cei, cell_para)
                    .is_none()
                {
                    return Err(HwpError::RenderError(format!(
                        "셀 문단을 찾을 수 없음 (문단 {}, 컨트롤 {}, 셀 {}, 셀 문단 {})",
                        ppi, ci, cei, cell_para
                    )));
                }
            }
        } else {
            let para_count = self.document.sections[section_idx].paragraphs.len();
            if start_para >= para_count || end_para >= para_count {
                return Err(HwpError::RenderError(format!(
                    "문단 인덱스 범위 초과 (start={}, end={}, 총 {}개)",
                    start_para, end_para, para_count
                )));
            }
        }

        // Section raw 스트림 무효화 (재직렬화 유도)
        self.document.sections[section_idx].raw_stream = None;
        // DocInfo raw_stream은 유지 (전체 재직렬화 시 FIX-4 문제 발생)

        if let Some((ppi, ci, cei)) = cell_ctx {
            let flow_before = cell_flow_signature(self.cell_container_paragraphs_mut(
                section_idx,
                ppi,
                ci,
                cei,
            )?);
            // ─── 셀 내 deleteRange ───
            if start_para == end_para {
                // 같은 문단 내 삭제
                let count = end_offset - start_offset;
                if count > 0 {
                    let cell_para =
                        self.get_cell_paragraph_mut(section_idx, ppi, ci, cei, start_para)?;
                    cell_para.delete_text_at(start_offset, count);
                    self.reflow_cell_paragraph(section_idx, ppi, ci, cei, start_para);
                    // 줄 수가 줄면 뒤 문단도 올라와야 한다 (셀 삭제 단일 경로와 같다).
                    self.recalculate_cell_paragraph_vpos_native(
                        section_idx,
                        ppi,
                        ci,
                        cei,
                        start_para,
                        None,
                    );
                }
            } else {
                // 다중 문단 셀 내 삭제 — 표 셀·표 캡션·글상자·그림 캡션을 같은 컨테이너
                // 해석기로 한 번만 찾고, 변형 전에 끝점을 그 목록에 대해 다시 확인한다.
                // 표 셀만 아는 경로로 중간 단계에서 Err 가 나면 양 끝 문단만 잘린 채 남는다.
                let original_vpos = {
                    let paragraphs =
                        self.cell_container_paragraphs_mut(section_idx, ppi, ci, cei)?;
                    if end_para >= paragraphs.len() {
                        return Err(HwpError::RenderError(format!(
                            "셀 문단 인덱스 {} 범위 초과 (총 {}개)",
                            end_para,
                            paragraphs.len()
                        )));
                    }
                    let original_vpos = paragraphs[start_para]
                        .line_segs
                        .first()
                        .map(|seg| seg.vertical_pos);
                    // 1) 마지막 문단 앞부분 삭제
                    if end_offset > 0 {
                        paragraphs[end_para].delete_text_at(0, end_offset);
                    }
                    // 2) 중간 문단 역순 제거
                    paragraphs.drain(start_para + 1..end_para);
                    // 3) 첫 문단 뒷부분 삭제
                    let para_len = paragraphs[start_para].text.chars().count();
                    if start_offset < para_len {
                        paragraphs[start_para]
                            .delete_text_at(start_offset, para_len - start_offset);
                    }
                    // 4) 첫-마지막 문단 병합 (마지막 문단이 이제 start_para+1에 위치)
                    let next_para = paragraphs.remove(start_para + 1);
                    paragraphs[start_para].merge_from(&next_para);
                    original_vpos
                };
                self.reflow_cell_paragraph(section_idx, ppi, ci, cei, start_para);
                if let Some(vpos) = original_vpos {
                    let cell_para =
                        self.get_cell_paragraph_mut(section_idx, ppi, ci, cei, start_para)?;
                    shift_paragraph_vpos_origin(cell_para, vpos);
                }
                self.recalculate_cell_paragraph_vpos_native(
                    section_idx,
                    ppi,
                    ci,
                    cei,
                    start_para,
                    None,
                );
            }

            // 부모 컨트롤 dirty 마킹 + 재페이지네이션
            let flow_changed = flow_before
                != cell_flow_signature(self.cell_container_paragraphs_mut(
                    section_idx,
                    ppi,
                    ci,
                    cei,
                )?);
            self.commit_cell_edit_geometry(
                section_idx,
                ppi,
                &[(ci, cei, start_para)],
                flow_changed,
            )?;
            self.mark_cell_control_dirty(section_idx, ppi, ci);
            self.mark_section_dirty(section_idx);
            self.paginate_if_needed();
            self.event_log.push(DocumentEvent::CellTextChanged {
                section: section_idx,
                para: ppi,
                ctrl: ci,
                cell: cei,
            });
            Ok(super::super::helpers::json_ok_with(&format!(
                "\"paraIdx\":{},\"charOffset\":{}",
                start_para, start_offset
            )))
        } else {
            // ─── 본문 deleteRange ───
            if start_para == end_para {
                // 같은 문단 내 삭제
                let count = end_offset - start_offset;
                if count > 0 {
                    self.document.sections[section_idx].paragraphs[start_para]
                        .delete_text_at(start_offset, count);
                    // [Task #2299] 리셋 판별용 — reflow 이전 저장 흐름 end 캡처.
                    let stored_end_for_reset = crate::renderer::composer::paragraph_flow_end(
                        &self.document.sections[section_idx].paragraphs[start_para],
                    );
                    self.reflow_paragraph(section_idx, start_para);
                    let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
                    self.recalculate_body_section_vpos(
                        section_idx,
                        start_para,
                        None,
                        stored_end_for_reset,
                        doc_hwp3_layout,
                    );
                }
                // 변경 문단만 재구성
                self.recompose_paragraph(section_idx, start_para);
            } else {
                // 1) 마지막 문단 앞부분 삭제
                if end_offset > 0 {
                    self.document.sections[section_idx].paragraphs[end_para]
                        .delete_text_at(0, end_offset);
                }
                // 2) 중간 문단 역순 제거 (composed도 동기)
                for mid_para in (start_para + 1..end_para).rev() {
                    self.document.sections[section_idx]
                        .paragraphs
                        .remove(mid_para);
                    self.remove_composed_paragraph(section_idx, mid_para);
                }
                // 3) 첫 문단 뒷부분 삭제
                {
                    let para_len = self.document.sections[section_idx].paragraphs[start_para]
                        .text
                        .chars()
                        .count();
                    if start_offset < para_len {
                        self.document.sections[section_idx].paragraphs[start_para]
                            .delete_text_at(start_offset, para_len - start_offset);
                    }
                }
                // 4) 첫-마지막 문단 병합 (마지막 문단이 이제 start_para+1에 위치)
                if start_para + 1 < self.document.sections[section_idx].paragraphs.len() {
                    let next = self.document.sections[section_idx]
                        .paragraphs
                        .remove(start_para + 1);
                    self.remove_composed_paragraph(section_idx, start_para + 1);
                    self.document.sections[section_idx].paragraphs[start_para].merge_from(&next);
                }
                // 문단 수가 줄었다. 아래 TextDeleted 는 순서 변경 이벤트가 아니므로
                // 순서 revision 을 따로 올린다 (스냅샷이 밀린 인덱스의 문단을 공유하지 않게).
                self.event_log.mark_paragraph_sequence_changed(section_idx);
                // [Task #2299] 리셋 판별용 — reflow 이전 저장 흐름 end 캡처.
                let stored_end_for_reset = crate::renderer::composer::paragraph_flow_end(
                    &self.document.sections[section_idx].paragraphs[start_para],
                );
                self.reflow_paragraph(section_idx, start_para);
                let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
                self.recalculate_body_section_vpos(
                    section_idx,
                    start_para,
                    None,
                    stored_end_for_reset,
                    doc_hwp3_layout,
                );
                // 병합된 문단 재구성
                self.recompose_paragraph(section_idx, start_para);
            }

            // 재페이지네이션
            self.paginate_if_needed();

            // 캐럿 위치 갱신
            self.document.doc_properties.caret_list_id = section_idx as u32;
            self.document.doc_properties.caret_para_id = start_para as u32;

            self.event_log.push(DocumentEvent::TextDeleted {
                section: section_idx,
                para: start_para,
                offset: start_offset,
                count: 0,
            });
            Ok(super::super::helpers::json_ok_with(&format!(
                "\"paraIdx\":{},\"charOffset\":{}",
                start_para, start_offset
            )))
        }
    }

    /// 여러 구역에 걸친 본문 선택을 정확한 구역별 조각으로 삭제한다.
    ///
    /// 구역 나눔 자체는 문서 구조이므로 유지하고, 각 구역에서 선택된 본문만 삭제한다.
    /// 역순 실행은 뒤 구역의 문단 축약이 앞 구역 endpoint 계산에 영향을 주지 않게 한다.
    pub fn delete_range_across_sections_native(
        &mut self,
        start_section_idx: usize,
        start_para_idx: usize,
        start_char_offset: usize,
        end_section_idx: usize,
        end_para_idx: usize,
        end_char_offset: usize,
    ) -> Result<String, HwpError> {
        if start_section_idx > end_section_idx {
            return Err(HwpError::RenderError(
                "시작 구역이 끝 구역보다 뒤에 있음".to_string(),
            ));
        }
        if start_section_idx == end_section_idx {
            return self.delete_range_native(
                start_section_idx,
                start_para_idx,
                start_char_offset,
                end_para_idx,
                end_char_offset,
                None,
            );
        }

        let mut ranges = Vec::new();
        for section_idx in start_section_idx..=end_section_idx {
            let section = self.document.sections.get(section_idx).ok_or_else(|| {
                HwpError::RenderError(format!("구역 인덱스 {} 범위 초과", section_idx))
            })?;
            if section.paragraphs.is_empty() {
                continue;
            }
            let range_start_para = if section_idx == start_section_idx {
                start_para_idx
            } else {
                0
            };
            let range_end_para = if section_idx == end_section_idx {
                end_para_idx
            } else {
                section.paragraphs.len() - 1
            };
            if range_start_para > range_end_para || range_end_para >= section.paragraphs.len() {
                return Err(HwpError::RenderError(format!(
                    "구역 {} 문단 범위 초과",
                    section_idx
                )));
            }
            let range_start_offset = if section_idx == start_section_idx {
                start_char_offset
            } else {
                0
            };
            let range_end_offset = if section_idx == end_section_idx {
                end_char_offset
            } else {
                section.paragraphs[range_end_para].text.chars().count()
            };
            ranges.push((
                section_idx,
                range_start_para,
                range_start_offset,
                range_end_para,
                range_end_offset,
            ));
        }

        for (section_idx, range_start_para, range_start_offset, range_end_para, range_end_offset) in
            ranges.into_iter().rev()
        {
            self.delete_range_native(
                section_idx,
                range_start_para,
                range_start_offset,
                range_end_para,
                range_end_offset,
                None,
            )?;
        }

        self.document.doc_properties.caret_list_id = start_section_idx as u32;
        self.document.doc_properties.caret_para_id = start_para_idx as u32;
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"sectionIdx\":{},\"paraIdx\":{},\"charOffset\":{}",
            start_section_idx, start_para_idx, start_char_offset
        )))
    }

    // ─── Phase 4 네이티브 끝 ────────────────────────────────

    // ─── Phase 3 네이티브 끝 ─────────────────────────────────

    /// 표 셀 내부 문단에 대한 불변 참조를 얻는다.
    pub(crate) fn get_cell_paragraph_ref(
        &self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
    ) -> Option<&crate::model::paragraph::Paragraph> {
        let para = self
            .document
            .sections
            .get(section_idx)?
            .paragraphs
            .get(parent_para_idx)?;
        match para.controls.get(control_idx)? {
            Control::Table(table) => {
                if cell_idx == 65534 {
                    return table.caption.as_ref()?.paragraphs.get(cell_para_idx);
                }
                table.cells.get(cell_idx)?.paragraphs.get(cell_para_idx)
            }
            Control::Shape(shape) => {
                if cell_idx != 0 {
                    return None;
                }
                get_textbox_from_shape(shape)?.paragraphs.get(cell_para_idx)
            }
            Control::Picture(pic) => pic.caption.as_ref()?.paragraphs.get(cell_para_idx),
            _ => None,
        }
    }

    fn apply_paragraph_split_intent(
        &mut self,
        paragraph: &mut Paragraph,
        intent: &ParagraphSplitIntent,
    ) {
        match intent {
            ParagraphSplitIntent::UserEnter => {}
            ParagraphSplitIntent::LogicalContinuation => {
                let mods = ParaShapeMods {
                    page_break_before: Some(false),
                    ..Default::default()
                };
                paragraph.para_shape_id = self
                    .document
                    .find_or_create_para_shape(paragraph.para_shape_id, &mods);
                paragraph.column_type = crate::model::paragraph::ColumnBreakType::None;
                paragraph.raw_break_type = 0;
            }
            ParagraphSplitIntent::RestoreMetadata(meta) => {
                paragraph.apply_meta(meta.clone());
            }
        }
    }

    /// 컨트롤 없는 본문 끝 Enter에서 적용할 다음 문단 스타일의 전체 정의.
    /// 캐럿(논리 글자 수)과 원본 UTF-16 스트림을 모두 확인한 뒤 분할 전에 결정한다.
    fn body_end_enter_next_style(
        &self,
        paragraph: &Paragraph,
        char_offset: usize,
        split_offset: usize,
    ) -> Option<(u8, u16, u32)> {
        if !paragraph.controls.is_empty()
            || !paragraph.field_ranges.is_empty()
            || !paragraph.orphan_field_ends.is_empty()
            || char_offset != super::super::helpers::logical_paragraph_length(paragraph)
            || split_offset != paragraph.text.chars().count()
        {
            return None;
        }

        let mut chars = paragraph.text.chars();
        let mut stream_end = 0u32;
        for &offset in &paragraph.char_offsets {
            let ch = chars.next()?;
            if ch.is_control() || ch == '\u{fffc}' || offset != stream_end {
                return None;
            }
            stream_end = stream_end.checked_add(ch.len_utf16() as u32)?;
        }
        // HWP char_count는 UTF-16 본문과 끝 마커 한 유닛이다. 결손·제어 슬롯은 상속 유지.
        if chars.next().is_some() || paragraph.char_count != stream_end.checked_add(1)? {
            return None;
        }

        let current = self
            .document
            .doc_info
            .styles
            .get(paragraph.style_id as usize)?;
        let next_id = current.next_style_id;
        if current.style_type != 0 || next_id == paragraph.style_id {
            return None;
        }
        let next = self.document.doc_info.styles.get(next_id as usize)?;
        if next.style_type != 0 {
            return None;
        }
        self.document
            .doc_info
            .para_shapes
            .get(next.para_shape_id as usize)?;
        self.document
            .doc_info
            .char_shapes
            .get(next.char_shape_id as usize)?;
        Some((next_id, next.para_shape_id, u32::from(next.char_shape_id)))
    }

    /// 문단을 사용자 Enter 의미로 분할한다.
    ///
    /// `restore_meta` 는 병합 undo 전용이다 — 병합으로 사라졌던 문단의 스코프
    /// 메타데이터를 새 문단에 되돌린다. 일반 Enter 분할은 `None` 으로 앞 문단의
    /// 서식을 잇되 일반 본문 끝에서는 유효한 다음 문단 스타일을 적용한다 (Task #2342).
    pub fn split_paragraph_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
        restore_meta: Option<ParaMeta>,
    ) -> Result<String, HwpError> {
        let intent = restore_meta
            .map(ParagraphSplitIntent::RestoreMetadata)
            .unwrap_or(ParagraphSplitIntent::UserEnter);
        self.split_paragraph_with_intent_native(section_idx, para_idx, char_offset, intent)
    }

    /// 한 논리 삽입 안의 줄 경계를 만든다.
    ///
    /// 글꼴·목록·문단 여백은 이어받되 새 continuation에 강제 쪽/단 경계는 만들지 않는다.
    pub fn split_paragraph_logical_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
    ) -> Result<String, HwpError> {
        self.split_paragraph_with_intent_native(
            section_idx,
            para_idx,
            char_offset,
            ParagraphSplitIntent::LogicalContinuation,
        )
    }

    fn split_paragraph_with_intent_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
        intent: ParagraphSplitIntent,
    ) -> Result<String, HwpError> {
        if section_idx >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!(
                "구역 인덱스 {} 범위 초과 (총 {}개)",
                section_idx,
                self.document.sections.len()
            )));
        }
        let section = &self.document.sections[section_idx];
        if para_idx >= section.paragraphs.len() {
            return Err(HwpError::RenderError(format!(
                "문단 인덱스 {} 범위 초과 (총 {}개)",
                para_idx,
                section.paragraphs.len()
            )));
        }

        if char_offset == 0
            && is_empty_topbottom_table_anchor_for_enter(
                &self.document.sections[section_idx].paragraphs[para_idx],
            )
        {
            self.document.sections[section_idx].raw_stream = None;
            let new_para_idx = para_idx + 1;
            let mut new_para = empty_paragraph_after_table_anchor(
                &self.document.sections[section_idx].paragraphs[para_idx],
            );
            self.apply_paragraph_split_intent(&mut new_para, &intent);
            self.document.sections[section_idx]
                .paragraphs
                .insert(new_para_idx, new_para);

            let old_col = self
                .para_column_map
                .get(section_idx)
                .and_then(|m| m.get(para_idx))
                .copied()
                .unwrap_or(0);
            self.reflow_paragraph(section_idx, new_para_idx);
            let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
            self.recalculate_body_section_vpos(
                section_idx,
                para_idx,
                Some(new_para_idx..new_para_idx + 1),
                None,
                doc_hwp3_layout,
            );
            self.insert_composed_paragraph(section_idx, new_para_idx);
            self.paginate_if_needed();

            for _ in 0..2 {
                let new_col = self
                    .para_column_map
                    .get(section_idx)
                    .and_then(|m| m.get(para_idx))
                    .copied()
                    .unwrap_or(0);
                if new_col == old_col {
                    break;
                }
                self.reflow_paragraph(section_idx, new_para_idx);
                let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
                self.recalculate_body_section_vpos(
                    section_idx,
                    para_idx,
                    Some(new_para_idx..new_para_idx + 1),
                    None,
                    doc_hwp3_layout,
                );
                self.recompose_paragraph(section_idx, new_para_idx);
                self.paginate_if_needed();
            }

            self.event_log.push(DocumentEvent::ParagraphSplit {
                section: section_idx,
                para: para_idx,
                offset: char_offset,
            });
            return Ok(super::super::helpers::json_ok_with(&format!(
                "\"paraIdx\":{},\"charOffset\":0",
                new_para_idx
            )));
        }

        let square_ole_enter_chain = {
            let paragraphs = &self.document.sections[section_idx].paragraphs;
            (char_offset == 0)
                .then(|| square_ole_wrap_chain_for_enter(paragraphs, para_idx))
                .flatten()
        };
        if let Some(chain) = square_ole_enter_chain {
            self.document.sections[section_idx].raw_stream = None;
            let new_para_idx = para_idx + 1;
            // [Task #2299] 판정 기준을 실제 배치 기준과 일치시킨다: vpos 재계산이
            // 신규 문단을 anchor end + 문단 여백 gap 에 배치하므로, gap 을 빼고
            // 판정하면 wrap 영역 바깥(bottom_vpos 이하)에 wrap-줄 폭 문단이 놓인다.
            let anchor = &self.document.sections[section_idx].paragraphs[para_idx];
            // 신규 문단은 anchor 서식을 상속하므로(gap = anchor.after + anchor.before)
            // hwp3 변환은 spacing_before 성분에만 적용한다 — recalc 의 boundary_gap
            // 과 동일 산식.
            let enter_gap = {
                let (after, before) = self
                    .styles
                    .para_styles
                    .get(anchor.para_shape_id as usize)
                    .map(|style| (style.spacing_after, style.spacing_before))
                    .unwrap_or((0.0, 0.0));
                let before = crate::renderer::hwp3_variant_flow_spacing_before(
                    before,
                    self.document.layout_profile().hwp3_layout(),
                );
                crate::renderer::px_to_hwpunit(after + before, self.dpi)
            };
            let next_vpos = next_line_vpos_after_para_for_enter(anchor).saturating_add(enter_gap);
            let keep_wrap_zone = next_vpos < chain.bottom_vpos;
            let mut new_para = if keep_wrap_zone {
                empty_paragraph_after_square_wrap_anchor(
                    &self.document.sections[section_idx].paragraphs[para_idx],
                )
            } else {
                empty_paragraph_after_normal_flow(
                    &self.document.sections[section_idx].paragraphs[para_idx],
                )
            };
            // square-OLE wrap도 merge의 역연산으로 문단을 되살리는 경로다. Enter의
            // 기본 상속은 유지하되, merge undo가 준 원래 문단 메타는 모든 생성 분기에서
            // 동일하게 적용해야 한다 (Task #2342 review).
            self.apply_paragraph_split_intent(&mut new_para, &intent);
            self.document.sections[section_idx]
                .paragraphs
                .insert(new_para_idx, new_para);

            if !keep_wrap_zone {
                self.reflow_paragraph(section_idx, new_para_idx);
            }
            let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
            self.recalculate_body_section_vpos(
                section_idx,
                para_idx,
                Some(new_para_idx..new_para_idx + 1),
                None,
                doc_hwp3_layout,
            );
            self.insert_composed_paragraph(section_idx, new_para_idx);
            self.paginate_if_needed();

            self.event_log.push(DocumentEvent::ParagraphSplit {
                section: section_idx,
                para: para_idx,
                offset: char_offset,
            });
            return Ok(super::super::helpers::json_ok_with(&format!(
                "\"paraIdx\":{},\"charOffset\":0",
                new_para_idx
            )));
        }

        // 편집 시 raw 스트림 무효화 (재직렬화 유도)
        self.document.sections[section_idx].raw_stream = None;

        // 캐럿은 TAC 개체만 세지만 모델 분할은 떠 있는 개체도 슬롯으로 센다.
        // 클립보드와 같은 변환을 쓰되 이벤트/Enter 특례는 원래 캐럿 위치를 유지한다.
        let split_offset = super::clipboard::clipboard_split_offset(
            &self.document.sections[section_idx].paragraphs[para_idx],
            char_offset,
        );
        let next_style = if matches!(&intent, ParagraphSplitIntent::UserEnter) {
            self.body_end_enter_next_style(
                &self.document.sections[section_idx].paragraphs[para_idx],
                char_offset,
                split_offset,
            )
        } else {
            None
        };
        let mut new_para =
            self.document.sections[section_idx].paragraphs[para_idx].split_at(split_offset);
        self.apply_paragraph_split_intent(&mut new_para, &intent);
        if let Some((style_id, para_shape_id, char_shape_id)) = next_style {
            new_para.style_id = style_id;
            new_para.para_shape_id = para_shape_id;
            new_para.set_single_char_shape(char_shape_id);
        }

        // 새 문단을 현재 문단 뒤에 삽입
        let new_para_idx = para_idx + 1;
        self.document.sections[section_idx]
            .paragraphs
            .insert(new_para_idx, new_para);
        for i in para_idx..=new_para_idx {
            if !self.document.sections[section_idx].paragraphs[i]
                .field_ranges
                .is_empty()
                || !self.document.sections[section_idx].paragraphs[i]
                    .orphan_field_ends
                    .is_empty()
            {
                rebuild_char_offsets(&mut self.document.sections[section_idx].paragraphs[i]);
            }
        }

        // 양쪽 문단 리플로우 → vpos 재계산 → 재구성 → 재페이지네이션 + 다단 수렴 루프
        let old_col1 = self
            .para_column_map
            .get(section_idx)
            .and_then(|m| m.get(para_idx))
            .copied()
            .unwrap_or(0);
        // [Task #2299] 리셋 판별용 — reflow 이전 저장 흐름 end 캡처.
        let stored_end_for_reset = crate::renderer::composer::paragraph_flow_end(
            &self.document.sections[section_idx].paragraphs[para_idx],
        );
        self.reflow_paragraph(section_idx, para_idx);
        self.reflow_paragraph(section_idx, new_para_idx);
        let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
        self.recalculate_body_section_vpos(
            section_idx,
            para_idx,
            Some(new_para_idx..new_para_idx + 1),
            stored_end_for_reset,
            doc_hwp3_layout,
        );
        self.recompose_paragraph(section_idx, para_idx);
        self.insert_composed_paragraph(section_idx, new_para_idx);
        self.paginate_if_needed();

        for _ in 0..2 {
            let new_col1 = self
                .para_column_map
                .get(section_idx)
                .and_then(|m| m.get(para_idx))
                .copied()
                .unwrap_or(0);
            if new_col1 == old_col1 {
                break;
            }
            // [Task #2299] 리셋 판별용 — reflow 이전 저장 흐름 end 캡처.
            let stored_end_for_reset = crate::renderer::composer::paragraph_flow_end(
                &self.document.sections[section_idx].paragraphs[para_idx],
            );
            self.reflow_paragraph(section_idx, para_idx);
            self.reflow_paragraph(section_idx, new_para_idx);
            let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
            self.recalculate_body_section_vpos(
                section_idx,
                para_idx,
                Some(new_para_idx..new_para_idx + 1),
                stored_end_for_reset,
                doc_hwp3_layout,
            );
            self.recompose_paragraph(section_idx, para_idx);
            self.recompose_paragraph(section_idx, new_para_idx);
            self.paginate_if_needed();
        }

        self.event_log.push(DocumentEvent::ParagraphSplit {
            section: section_idx,
            para: para_idx,
            offset: char_offset,
        });
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"paraIdx\":{},\"charOffset\":0",
            new_para_idx
        )))
    }

    /// 강제 쪽 나누기 삽입 (Ctrl+Enter)
    /// 커서 위치에서 문단을 분할하고, 새 문단에 ColumnBreakType::Page를 설정한다.
    pub fn insert_page_break_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
    ) -> Result<String, HwpError> {
        use crate::model::paragraph::ColumnBreakType;

        if section_idx >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!(
                "구역 인덱스 {} 범위 초과",
                section_idx
            )));
        }
        if para_idx >= self.document.sections[section_idx].paragraphs.len() {
            return Err(HwpError::RenderError(format!(
                "문단 인덱스 {} 범위 초과",
                para_idx
            )));
        }

        self.document.sections[section_idx].raw_stream = None;

        // 문단 분리
        let new_para =
            self.document.sections[section_idx].paragraphs[para_idx].split_at(char_offset);
        let new_para_idx = para_idx + 1;
        self.document.sections[section_idx]
            .paragraphs
            .insert(new_para_idx, new_para);
        for i in para_idx..=new_para_idx {
            if !self.document.sections[section_idx].paragraphs[i]
                .field_ranges
                .is_empty()
            {
                rebuild_char_offsets(&mut self.document.sections[section_idx].paragraphs[i]);
            }
        }

        // 새 문단에 쪽 나누기 설정
        self.document.sections[section_idx].paragraphs[new_para_idx].column_type =
            ColumnBreakType::Page;
        self.document.sections[section_idx].paragraphs[new_para_idx].raw_break_type = 0x04;

        // 분할된 두 문단 리플로우
        self.reflow_paragraph(section_idx, para_idx);
        // [Task #2299] 리셋 판별용 — reflow 이전 저장 흐름 end 캡처.
        let stored_end_for_reset = crate::renderer::composer::paragraph_flow_end(
            &self.document.sections[section_idx].paragraphs[new_para_idx],
        );
        self.reflow_paragraph(section_idx, new_para_idx);

        // 삽입 지점부터 구역 끝까지 vpos 재계산 (페이지 재배치에 필요)
        let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
        self.recalculate_body_section_vpos(
            section_idx,
            new_para_idx,
            Some(new_para_idx..new_para_idx + 1),
            stored_end_for_reset,
            doc_hwp3_layout,
        );

        // 문단 삽입에 맞춰 측정 캐시 인덱스를 먼저 밀어야 한다. recompose_section 은
        // composed 만 다시 만들 뿐 measured_sections 의 표 측정값은 (para_index,
        // control_index) 키 그대로 남아, 밀리지 않으면 삽입점 뒤의 표가 이웃 표의
        // 측정 geometry 를 그대로 재사용해 쪽 나눔이 무너진다 (쪽수 감소·표 통짜 배치).
        self.insert_composed_paragraph(section_idx, new_para_idx);
        // 전체 구역 재구성 + 재페이지네이션
        self.recompose_section(section_idx);
        self.paginate_if_needed();
        self.invalidate_page_tree_cache();

        self.event_log.push(DocumentEvent::ParagraphSplit {
            section: section_idx,
            para: para_idx,
            offset: char_offset,
        });
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"paraIdx\":{},\"charOffset\":0",
            new_para_idx
        )))
    }

    /// 단 나누기 삽입 (Ctrl+Shift+Enter)
    /// 커서 위치에서 문단을 분리하고 새 문단에 단 나누기 설정.
    /// 1단 문서에서는 쪽 나누기와 동일하게 동작.
    pub fn insert_column_break_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
    ) -> Result<String, HwpError> {
        use crate::model::paragraph::ColumnBreakType;

        if section_idx >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!(
                "구역 인덱스 {} 범위 초과",
                section_idx
            )));
        }
        if para_idx >= self.document.sections[section_idx].paragraphs.len() {
            return Err(HwpError::RenderError(format!(
                "문단 인덱스 {} 범위 초과",
                para_idx
            )));
        }

        self.document.sections[section_idx].raw_stream = None;

        // 문단 분리
        let new_para =
            self.document.sections[section_idx].paragraphs[para_idx].split_at(char_offset);
        let new_para_idx = para_idx + 1;
        self.document.sections[section_idx]
            .paragraphs
            .insert(new_para_idx, new_para);

        // 새 문단에 단 나누기 설정
        self.document.sections[section_idx].paragraphs[new_para_idx].column_type =
            ColumnBreakType::Column;
        self.document.sections[section_idx].paragraphs[new_para_idx].raw_break_type = 0x08;

        // 분할된 두 문단 리플로우
        self.reflow_paragraph(section_idx, para_idx);
        // [Task #2299] 리셋 판별용 — reflow 이전 저장 흐름 end 캡처.
        let stored_end_for_reset = crate::renderer::composer::paragraph_flow_end(
            &self.document.sections[section_idx].paragraphs[new_para_idx],
        );
        self.reflow_paragraph(section_idx, new_para_idx);

        let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
        self.recalculate_body_section_vpos(
            section_idx,
            new_para_idx,
            Some(new_para_idx..new_para_idx + 1),
            stored_end_for_reset,
            doc_hwp3_layout,
        );

        // 쪽 나눔과 동일 — 문단 삽입 후 측정 캐시 인덱스를 밀지 않으면
        // 삽입점 뒤의 표가 이웃 표의 측정 geometry 를 재사용한다.
        self.insert_composed_paragraph(section_idx, new_para_idx);
        self.recompose_section(section_idx);
        self.paginate_if_needed();
        self.invalidate_page_tree_cache();

        self.event_log.push(DocumentEvent::ParagraphSplit {
            section: section_idx,
            para: para_idx,
            offset: char_offset,
        });
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"paraIdx\":{},\"charOffset\":0",
            new_para_idx
        )))
    }

    /// 다단 설정 변경
    ///
    /// 구역의 초기 ColumnDef 컨트롤을 찾아 수정한다.
    /// 없으면 첫 문단에 새 ColumnDef를 삽입한다.
    ///
    /// ColumnDef는 문단 컨트롤로 저장되며, SectionDef와 독립적이다.
    /// 수정 후 recompose + repaginate로 조판을 갱신한다.
    pub fn set_column_def_native(
        &mut self,
        section_idx: usize,
        column_count: u16,
        column_type: u8, // 0=일반(Normal), 1=배분(Distribute), 2=평행(Parallel)
        same_width: bool,
        spacing_hu: i16, // 단 간격 (HWPUNIT)
    ) -> Result<String, HwpError> {
        use crate::model::page::{ColumnDirection, ColumnType};

        if section_idx >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!(
                "구역 인덱스 {} 범위 초과",
                section_idx
            )));
        }

        let col_type = match column_type {
            1 => ColumnType::Distribute,
            2 => ColumnType::Parallel,
            _ => ColumnType::Normal,
        };

        // 구역의 초기 ColumnDef 찾기 (find_initial_column_def와 동일 로직)
        let mut found: Option<usize> = None;
        let paragraphs = &mut self.document.sections[section_idx].paragraphs;
        for (para_idx, para) in paragraphs.iter_mut().enumerate() {
            for ctrl in para.controls.iter_mut() {
                if let Control::ColumnDef(ref mut cd) = ctrl {
                    cd.column_count = column_count;
                    cd.column_type = col_type;
                    cd.same_width = same_width;
                    cd.spacing = spacing_hu;
                    if same_width {
                        cd.widths.clear();
                        cd.gaps.clear();
                    }
                    found = Some(para_idx);
                    break;
                }
            }
            if found.is_some() {
                break;
            }
        }

        // 기존 ColumnDef가 없으면 첫 문단에 삽입
        if found.is_none() {
            let cd = ColumnDef {
                column_count,
                column_type: col_type,
                same_width,
                spacing: spacing_hu,
                direction: ColumnDirection::LeftToRight,
                ..Default::default()
            };
            // 단 정의는 문단 맨 앞(텍스트 위치 0) 컨트롤이다. 컨트롤 목록 끝에 붙이면
            // PARA_TEXT 자리 없이 들어가 뒤 인라인 개체들이 한 자리씩 밀린다.
            if let Some(para) = self.document.sections[section_idx].paragraphs.first_mut() {
                let insert_idx = Self::leading_structural_control_end(para);
                Self::insert_control_with_data_slot(para, insert_idx, Control::ColumnDef(cd));
                para.shift_for_inline_control_insert(0);
                para.char_count += 8;
                para.has_para_text = true;
                found = Some(0);
            }
        }

        // 이벤트를 쌓지 않으므로 ColumnDef 를 담은 문단의 revision 을 올린다.
        // 빠뜨리면 스냅샷 복원이 바뀐 문단을 재사용해 다단 undo 가 무시된다.
        if let Some(para_idx) = found {
            self.event_log.mark_paragraph_changed(section_idx, para_idx);
        }

        // 조판 갱신
        self.document.sections[section_idx].raw_stream = None;
        self.rebuild_section(section_idx);

        Ok("{\"ok\":true}".to_string())
    }

    /// 문단 병합 (네이티브 에러 타입)
    pub fn merge_paragraph_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
    ) -> Result<String, HwpError> {
        if section_idx >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!(
                "구역 인덱스 {} 범위 초과 (총 {}개)",
                section_idx,
                self.document.sections.len()
            )));
        }
        let section = &self.document.sections[section_idx];
        if para_idx == 0 {
            return Err(HwpError::RenderError(
                "첫 번째 문단은 병합할 수 없습니다".to_string(),
            ));
        }
        if para_idx >= section.paragraphs.len() {
            return Err(HwpError::RenderError(format!(
                "문단 인덱스 {} 범위 초과 (총 {}개)",
                para_idx,
                section.paragraphs.len()
            )));
        }

        // 편집 시 raw 스트림 무효화 (재직렬화 유도)
        self.document.sections[section_idx].raw_stream = None;

        let preserve_square_ole_wrap_line = {
            let paragraphs = &self.document.sections[section_idx].paragraphs;
            let prev_idx = para_idx - 1;
            is_contentless_empty_paragraph_for_merge(&paragraphs[para_idx])
                && square_ole_wrap_chain_for_enter(paragraphs, prev_idx).is_some()
        };

        // 현재 문단을 이전 문단에 병합
        let current_para = self.document.sections[section_idx]
            .paragraphs
            .remove(para_idx);
        let prev_idx = para_idx - 1;
        let removed_meta =
            super::super::helpers::removed_para_meta_field(&current_para.capture_merge_meta());
        let merge_point =
            self.document.sections[section_idx].paragraphs[prev_idx].merge_from(&current_para);

        if preserve_square_ole_wrap_line {
            let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
            self.recalculate_body_section_vpos(section_idx, prev_idx, None, None, doc_hwp3_layout);
            self.remove_composed_paragraph(section_idx, para_idx);
            self.recompose_paragraph(section_idx, prev_idx);
            self.paginate_if_needed();

            self.event_log.push(DocumentEvent::ParagraphMerged {
                section: section_idx,
                para: para_idx,
            });
            return Ok(super::super::helpers::json_ok_with(&format!(
                "\"paraIdx\":{},\"charOffset\":{}{}",
                prev_idx, merge_point, removed_meta
            )));
        }

        // 병합된 문단 리플로우 → vpos 재계산 → 재구성 → 재페이지네이션 + 다단 수렴 루프
        let old_col = self
            .para_column_map
            .get(section_idx)
            .and_then(|m| m.get(prev_idx))
            .copied()
            .unwrap_or(0);
        // [Task #2299] 리셋 판별용 — reflow 이전 저장 흐름 end 캡처.
        let stored_end_for_reset = crate::renderer::composer::paragraph_flow_end(
            &self.document.sections[section_idx].paragraphs[prev_idx],
        );
        self.reflow_paragraph(section_idx, prev_idx);
        let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
        self.recalculate_body_section_vpos(
            section_idx,
            prev_idx,
            None,
            stored_end_for_reset,
            doc_hwp3_layout,
        );
        self.remove_composed_paragraph(section_idx, para_idx);
        self.recompose_paragraph(section_idx, prev_idx);
        self.paginate_if_needed();

        for _ in 0..2 {
            let new_col = self
                .para_column_map
                .get(section_idx)
                .and_then(|m| m.get(prev_idx))
                .copied()
                .unwrap_or(0);
            if new_col == old_col {
                break;
            }
            // [Task #2299] 리셋 판별용 — reflow 이전 저장 흐름 end 캡처.
            let stored_end_for_reset = crate::renderer::composer::paragraph_flow_end(
                &self.document.sections[section_idx].paragraphs[prev_idx],
            );
            self.reflow_paragraph(section_idx, prev_idx);
            let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
            self.recalculate_body_section_vpos(
                section_idx,
                prev_idx,
                None,
                stored_end_for_reset,
                doc_hwp3_layout,
            );
            self.recompose_paragraph(section_idx, prev_idx);
            self.paginate_if_needed();
        }

        self.event_log.push(DocumentEvent::ParagraphMerged {
            section: section_idx,
            para: para_idx,
        });
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"paraIdx\":{},\"charOffset\":{}{}",
            prev_idx, merge_point, removed_meta
        )))
    }

    /// 문단 삭제 (네이티브 에러 타입)
    pub fn delete_paragraph_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
    ) -> Result<String, HwpError> {
        if section_idx >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!(
                "구역 인덱스 {} 범위 초과 (총 {}개)",
                section_idx,
                self.document.sections.len()
            )));
        }
        let section = &self.document.sections[section_idx];
        if section.paragraphs.len() <= 1 {
            return Err(HwpError::RenderError(
                "구역의 마지막 문단은 삭제할 수 없습니다".to_string(),
            ));
        }
        if para_idx >= section.paragraphs.len() {
            return Err(HwpError::RenderError(format!(
                "문단 인덱스 {} 범위 초과 (총 {}개)",
                para_idx,
                section.paragraphs.len()
            )));
        }

        let removed_char_count = self.document.sections[section_idx].paragraphs[para_idx]
            .text
            .chars()
            .count();
        self.document.sections[section_idx].raw_stream = None;
        self.document.sections[section_idx]
            .paragraphs
            .remove(para_idx);

        let reflow_idx = if para_idx > 0 { para_idx - 1 } else { 0 };
        let old_col = self
            .para_column_map
            .get(section_idx)
            .and_then(|m| m.get(reflow_idx))
            .copied()
            .unwrap_or(0);
        self.remove_composed_paragraph(section_idx, para_idx);
        // [Task #2299] 리셋 판별용 — reflow 이전 저장 흐름 end 캡처.
        let stored_end_for_reset = self.document.sections[section_idx]
            .paragraphs
            .get(reflow_idx)
            .and_then(crate::renderer::composer::paragraph_flow_end);
        if reflow_idx < self.document.sections[section_idx].paragraphs.len() {
            self.reflow_paragraph(section_idx, reflow_idx);
        }
        let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
        self.recalculate_body_section_vpos(
            section_idx,
            reflow_idx,
            None,
            stored_end_for_reset,
            doc_hwp3_layout,
        );
        if reflow_idx < self.document.sections[section_idx].paragraphs.len() {
            self.recompose_paragraph(section_idx, reflow_idx);
        }
        self.paginate_if_needed();

        for _ in 0..2 {
            let new_col = self
                .para_column_map
                .get(section_idx)
                .and_then(|m| m.get(reflow_idx))
                .copied()
                .unwrap_or(0);
            if new_col == old_col {
                break;
            }
            // [Task #2299] 리셋 판별용 — reflow 이전 저장 흐름 end 캡처.
            let stored_end_for_reset = self.document.sections[section_idx]
                .paragraphs
                .get(reflow_idx)
                .and_then(crate::renderer::composer::paragraph_flow_end);
            if reflow_idx < self.document.sections[section_idx].paragraphs.len() {
                self.reflow_paragraph(section_idx, reflow_idx);
            }
            let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
            self.recalculate_body_section_vpos(
                section_idx,
                reflow_idx,
                None,
                stored_end_for_reset,
                doc_hwp3_layout,
            );
            if reflow_idx < self.document.sections[section_idx].paragraphs.len() {
                self.recompose_paragraph(section_idx, reflow_idx);
            }
            self.paginate_if_needed();
        }

        let new_count = self.document.sections[section_idx].paragraphs.len();
        self.event_log.push(DocumentEvent::ParagraphDeleted {
            section: section_idx,
            para: para_idx,
        });
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"removedCharCount\":{},\"newParagraphCount\":{}",
            removed_char_count, new_count
        )))
    }

    /// 빈 문단 삽입 (네이티브 에러 타입)
    ///
    /// `para_idx == paragraphs.len()` 이면 구역 끝에 추가(append).
    pub fn insert_paragraph_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
    ) -> Result<String, HwpError> {
        if section_idx >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!(
                "구역 인덱스 {} 범위 초과 (총 {}개)",
                section_idx,
                self.document.sections.len()
            )));
        }
        let para_count = self.document.sections[section_idx].paragraphs.len();
        if para_idx > para_count {
            return Err(HwpError::RenderError(format!(
                "문단 인덱스 {} 범위 초과 (총 {}개, 최대 {})",
                para_idx, para_count, para_count
            )));
        }

        self.document.sections[section_idx].raw_stream = None;

        // 새 문단은 앞 문단의 서식을 상속한다 (한글에서 문단 끝에 Enter 를 친 것과 같은 결과).
        // para_idx == 0 이면 앞 문단이 없으므로 뒤로 밀려날 현재 0번 문단을 상속원으로 쓴다.
        // 두 경우 모두 없을 때(빈 구역)만 상속원이 존재하지 않는다.
        let template_idx = para_idx.saturating_sub(1);
        let paragraphs = &mut self.document.sections[section_idx].paragraphs;
        let new_para = paragraphs
            .get(template_idx)
            .map_or_else(Paragraph::new_empty, Paragraph::new_empty_like);
        paragraphs.insert(para_idx, new_para);

        // 구역의 첫 문단은 "여기서 구역이 시작한다"는 나누기 표식을 지닌다. 이 표식은 문단
        // 내용이 아니라 **자리**에 딸린 속성이므로, 그 앞에 문단을 끼우면 새 첫 문단으로
        // 옮겨야 한다. 그대로 두면 밀려난 문단이 1번에서 계속 구역 시작을 주장해 거기서
        // 쪽이 끊기고, 새 문단만 홀로 남은 빈 쪽이 생긴다.
        //
        // 0번이 아닌 자리는 옮기지 않는다 — 그쪽 표식은 사용자가 그 문단에 직접 넣은
        // 쪽/단 나누기이므로 문단을 따라가는 게 맞다.
        if para_idx == 0 {
            if let [new_first, displaced, ..] = &mut paragraphs[..] {
                new_first.column_type = std::mem::take(&mut displaced.column_type);
                new_first.raw_break_type = std::mem::take(&mut displaced.raw_break_type);
            }
        }

        let reflow_target = if para_idx > 0 { para_idx - 1 } else { para_idx };
        let old_col = self
            .para_column_map
            .get(section_idx)
            .and_then(|m| m.get(reflow_target))
            .copied()
            .unwrap_or(0);
        self.reflow_paragraph(section_idx, para_idx);
        let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
        self.recalculate_body_section_vpos(
            section_idx,
            reflow_target,
            Some(para_idx..para_idx + 1),
            None,
            doc_hwp3_layout,
        );
        self.insert_composed_paragraph(section_idx, para_idx);
        self.paginate_if_needed();

        for _ in 0..2 {
            let new_col = self
                .para_column_map
                .get(section_idx)
                .and_then(|m| m.get(reflow_target))
                .copied()
                .unwrap_or(0);
            if new_col == old_col {
                break;
            }
            self.reflow_paragraph(section_idx, para_idx);
            let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
            self.recalculate_body_section_vpos(
                section_idx,
                reflow_target,
                Some(para_idx..para_idx + 1),
                None,
                doc_hwp3_layout,
            );
            self.recompose_paragraph(section_idx, para_idx);
            self.paginate_if_needed();
        }

        let new_count = self.document.sections[section_idx].paragraphs.len();
        self.event_log.push(DocumentEvent::ParagraphInserted {
            section: section_idx,
            para: para_idx,
        });
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"paraIdx\":{},\"newParagraphCount\":{}",
            para_idx, new_count
        )))
    }

    /// 셀 내부 문단 분할 (네이티브 에러 타입)
    ///
    /// `restore_meta` 는 병합 undo 전용이다 — 병합으로 사라졌던 문단의 스코프 메타를
    /// 되돌린다. `None` 이면 기존 Enter 분할 시맨틱 그대로다 (Task #2342).
    pub fn split_paragraph_in_cell_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        char_offset: usize,
        restore_meta: Option<ParaMeta>,
    ) -> Result<String, HwpError> {
        let intent = restore_meta
            .map(ParagraphSplitIntent::RestoreMetadata)
            .unwrap_or(ParagraphSplitIntent::UserEnter);
        self.split_paragraph_in_cell_with_intent_native(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
            char_offset,
            intent,
        )
    }

    pub fn split_paragraph_in_cell_logical_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        char_offset: usize,
    ) -> Result<String, HwpError> {
        self.split_paragraph_in_cell_with_intent_native(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
            char_offset,
            ParagraphSplitIntent::LogicalContinuation,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn split_paragraph_in_cell_with_intent_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        char_offset: usize,
        intent: ParagraphSplitIntent,
    ) -> Result<String, HwpError> {
        // 셀 문단 검증 및 분할. 컨테이너(표 셀·표 캡션·글상자·그림 캡션)를 먼저 해석해
        // 자른 뒷부분을 같은 목록에 넣는다 — 자른 뒤에 컨테이너를 다시 찾다 실패하면
        // 문단 뒷부분이 사라진다.
        let new_cell_para_idx = cell_para_idx + 1;
        let (original_vpos, mut new_para) = {
            let paragraphs = self.cell_container_paragraphs_mut(
                section_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
            )?;
            let total = paragraphs.len();
            let cell_para = paragraphs.get_mut(cell_para_idx).ok_or_else(|| {
                HwpError::RenderError(format!(
                    "셀 문단 인덱스 {} 범위 초과 (총 {}개)",
                    cell_para_idx, total
                ))
            })?;
            let original_vpos = cell_para.line_segs.first().map(|seg| seg.vertical_pos);
            (original_vpos, cell_para.split_at(char_offset))
        };
        self.apply_paragraph_split_intent(&mut new_para, &intent);

        // 새 문단을 같은 컨테이너에 삽입 (위에서 해석에 성공했으므로 다시 실패하지 않는다)
        self.cell_container_paragraphs_mut(section_idx, parent_para_idx, control_idx, cell_idx)?
            .insert(new_cell_para_idx, new_para);
        // 양쪽 문단 리플로우
        self.reflow_cell_paragraph(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
        );
        self.reflow_cell_paragraph(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            new_cell_para_idx,
        );
        if let Some(vpos) = original_vpos {
            let cell_para = self.get_cell_paragraph_mut(
                section_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
            )?;
            shift_paragraph_vpos_origin(cell_para, vpos);
        }
        self.recalculate_cell_paragraph_vpos_native(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
            Some(new_cell_para_idx),
        );

        // raw 스트림 무효화, section dirty, 재페이지네이션.
        // dirty 전파는 by_path 변형과 동형 — 셀 문단 분할/병합은 행 높이를
        // 바꾸므로 최외곽 host 문단의 측정 캐시를 무효화해야 한다.
        self.commit_cell_edit_geometry(
            section_idx,
            parent_para_idx,
            &[(control_idx, cell_idx, cell_para_idx)],
            true,
        )?;
        self.mark_cell_control_dirty(section_idx, parent_para_idx, control_idx);
        self.document.sections[section_idx].raw_stream = None;
        self.mark_section_dirty(section_idx);
        self.paginate_if_needed();

        self.event_log.push(DocumentEvent::CellTextChanged {
            section: section_idx,
            para: parent_para_idx,
            ctrl: control_idx,
            cell: cell_idx,
        });
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"cellParaIndex\":{},\"charOffset\":0",
            new_cell_para_idx
        )))
    }

    /// 셀 내부 문단 병합 (네이티브 에러 타입)
    ///
    /// cell_para_idx 문단을 이전 문단(cell_para_idx - 1)에 병합한다.
    pub fn merge_paragraph_in_cell_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
    ) -> Result<String, HwpError> {
        if cell_para_idx == 0 {
            return Err(HwpError::RenderError(
                "셀 첫 번째 문단은 병합할 수 없습니다".to_string(),
            ));
        }

        // 문단 제거 및 이전 문단에 병합. 표 셀·표 캡션·글상자·그림 캡션을 같은 해석기로
        // 찾고, 문단 인덱스를 확인한 뒤에만 변형한다.
        let prev_idx = cell_para_idx - 1;
        // 사라지는 문단의 스코프 메타를 캡처해 결과에 실어 보낸다 — undo(split)가 이걸
        // 되돌려주지 않으면 되살아난 문단이 앞 문단 서식을 뒤집어쓴다 (Task #2342).
        let (original_vpos, merge_point, removed_meta) = {
            let paragraphs = self.cell_container_paragraphs_mut(
                section_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
            )?;
            if cell_para_idx >= paragraphs.len() {
                return Err(HwpError::RenderError(format!(
                    "셀 문단 인덱스 {} 범위 초과 (총 {}개)",
                    cell_para_idx,
                    paragraphs.len()
                )));
            }
            let original_vpos = paragraphs[prev_idx]
                .line_segs
                .first()
                .map(|seg| seg.vertical_pos);
            let removed = paragraphs.remove(cell_para_idx);
            let removed_meta = removed.capture_meta();
            let merge_point = paragraphs[prev_idx].merge_from(&removed);
            (original_vpos, merge_point, removed_meta)
        };
        // 병합된 문단 리플로우
        self.reflow_cell_paragraph(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            prev_idx,
        );
        if let Some(vpos) = original_vpos {
            let cell_para = self.get_cell_paragraph_mut(
                section_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                prev_idx,
            )?;
            shift_paragraph_vpos_origin(cell_para, vpos);
        }
        self.recalculate_cell_paragraph_vpos_native(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            prev_idx,
            None,
        );

        // raw 스트림 무효화, section dirty, 재페이지네이션.
        // dirty 전파는 by_path 변형과 동형 — 셀 문단 분할/병합은 행 높이를
        // 바꾸므로 최외곽 host 문단의 측정 캐시를 무효화해야 한다.
        self.commit_cell_edit_geometry(
            section_idx,
            parent_para_idx,
            &[(control_idx, cell_idx, cell_para_idx)],
            true,
        )?;
        self.mark_cell_control_dirty(section_idx, parent_para_idx, control_idx);
        self.document.sections[section_idx].raw_stream = None;
        self.mark_section_dirty(section_idx);
        self.paginate_if_needed();

        self.event_log.push(DocumentEvent::CellTextChanged {
            section: section_idx,
            para: parent_para_idx,
            ctrl: control_idx,
            cell: cell_idx,
        });
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"cellParaIndex\":{},\"charOffset\":{}{}",
            prev_idx,
            merge_point,
            super::super::helpers::removed_para_meta_field(&removed_meta)
        )))
    }

    // ─── Phase 1 Native: 기본 편집 보조 API ────────────────────

    /// 구역 내 문단 수 (네이티브)
    pub fn get_paragraph_count_native(&self, section_idx: usize) -> Result<usize, HwpError> {
        let section = self.document.sections.get(section_idx).ok_or_else(|| {
            HwpError::RenderError(format!(
                "구역 인덱스 {} 범위 초과 (총 {}개)",
                section_idx,
                self.document.sections.len()
            ))
        })?;
        Ok(section.paragraphs.len())
    }

    /// 문단 글자 수 (네이티브)
    pub fn get_paragraph_length_native(
        &self,
        section_idx: usize,
        para_idx: usize,
    ) -> Result<usize, HwpError> {
        let section = self.document.sections.get(section_idx).ok_or_else(|| {
            HwpError::RenderError(format!(
                "구역 인덱스 {} 범위 초과 (총 {}개)",
                section_idx,
                self.document.sections.len()
            ))
        })?;
        let para = section.paragraphs.get(para_idx).ok_or_else(|| {
            HwpError::RenderError(format!(
                "문단 인덱스 {} 범위 초과 (총 {}개)",
                para_idx,
                section.paragraphs.len()
            ))
        })?;
        Ok(para.text.chars().count())
    }

    /// 문단에 텍스트박스가 있는 Shape 컨트롤의 인덱스를 반환 (네이티브)
    /// 없으면 -1 반환
    pub fn get_textbox_control_index_native(&self, section_idx: usize, para_idx: usize) -> i32 {
        let section = match self.document.sections.get(section_idx) {
            Some(s) => s,
            None => return -1,
        };
        let para = match section.paragraphs.get(para_idx) {
            Some(p) => p,
            None => return -1,
        };
        for (ci, ctrl) in para.controls.iter().enumerate() {
            if let Control::Shape(shape) = ctrl {
                if get_textbox_from_shape(shape.as_ref()).is_some() {
                    return ci as i32;
                }
            }
        }
        -1
    }

    /// 문서 트리에서 다음 편집 가능한 컨트롤/본문을 찾는다.
    /// `(sec, para, ctrl_idx)`에서 시작, delta=+1(앞), delta=-1(뒤) 방향으로 탐색.
    /// ctrl_idx가 -1이면 해당 문단의 본문 텍스트에서 출발한 것으로 간주.
    ///
    /// 반환 JSON:
    ///   `{"type":"textbox","sec":N,"para":N,"ci":N}`
    ///   `{"type":"table","sec":N,"para":N,"ci":N}`
    ///   `{"type":"body","sec":N,"para":N}`
    ///   `{"type":"none"}`
    pub fn find_next_editable_control_native(
        &self,
        section_idx: usize,
        para_idx: usize,
        ctrl_idx: i32,
        delta: i32,
    ) -> String {
        let sections = &self.document.sections;

        // 헬퍼: 문단 내 편집 가능한 컨트롤을 방향에 따라 검색
        fn find_in_para(
            sections: &[crate::model::document::Section],
            sec: usize,
            para: usize,
            start_ci: i32,
            forward: bool,
        ) -> Option<(usize, &'static str)> {
            let section = sections.get(sec)?;
            let p = section.paragraphs.get(para)?;
            let controls = &p.controls;
            if forward {
                let from = if start_ci < 0 {
                    0usize
                } else {
                    (start_ci as usize).saturating_add(1)
                };
                for ci in from..controls.len() {
                    match &controls[ci] {
                        Control::Shape(shape) => {
                            if get_textbox_from_shape(shape.as_ref()).is_some() {
                                return Some((ci, "textbox"));
                            }
                        }
                        Control::Table(_) => {
                            return Some((ci, "table"));
                        }
                        _ => {}
                    }
                }
            } else {
                // 범위 밖 컨트롤 번호는 문단 끝에서 출발한 것으로 본다.
                let until = if start_ci < 0 {
                    controls.len()
                } else {
                    (start_ci as usize).min(controls.len())
                };
                for ci in (0..until).rev() {
                    match &controls[ci] {
                        Control::Shape(shape) => {
                            if get_textbox_from_shape(shape.as_ref()).is_some() {
                                return Some((ci, "textbox"));
                            }
                        }
                        Control::Table(_) => {
                            return Some((ci, "table"));
                        }
                        _ => {}
                    }
                }
            }
            None
        }

        // 헬퍼: 문단이 편집 가능한 컨트롤을 하나라도 갖고 있는지
        fn has_navigable_control(
            sections: &[crate::model::document::Section],
            sec: usize,
            para: usize,
        ) -> bool {
            sections.get(sec)
                .and_then(|s| s.paragraphs.get(para))
                .map(|p| p.controls.iter().any(|c| {
                    matches!(c, Control::Table(_))
                    || matches!(c, Control::Shape(s) if get_textbox_from_shape(s.as_ref()).is_some())
                }))
                .unwrap_or(false)
        }

        let forward = delta > 0;

        // 1) 같은 문단에서 탐색
        if let Some((ci, ty)) = find_in_para(sections, section_idx, para_idx, ctrl_idx, forward) {
            return format!(
                "{{\"type\":\"{}\",\"sec\":{},\"para\":{},\"ci\":{}}}",
                ty, section_idx, para_idx, ci
            );
        }

        // 2) 같은 섹션의 다른 문단 탐색
        if let Some(section) = sections.get(section_idx) {
            let para_count = section.paragraphs.len();
            // 범위 밖 문단 번호가 들어와도 인덱싱 panic 이나 긴 헛돌기가 없게 자른다.
            let para_range: Box<dyn Iterator<Item = usize>> = if forward {
                Box::new(para_idx.saturating_add(1)..para_count)
            } else if para_idx > 0 {
                Box::new((0..para_idx.min(para_count)).rev())
            } else {
                Box::new(std::iter::empty())
            };
            for pi in para_range {
                let search_start = if forward {
                    -1
                } else {
                    section.paragraphs.get(pi).map_or(0, |p| p.controls.len()) as i32
                };
                if let Some((ci, ty)) =
                    find_in_para(sections, section_idx, pi, search_start, forward)
                {
                    return format!(
                        "{{\"type\":\"{}\",\"sec\":{},\"para\":{},\"ci\":{}}}",
                        ty, section_idx, pi, ci
                    );
                }
                // 네비게이션 가능한 컨트롤이 없는 문단 → body
                if !has_navigable_control(sections, section_idx, pi) {
                    return format!(
                        "{{\"type\":\"body\",\"sec\":{},\"para\":{}}}",
                        section_idx, pi
                    );
                }
            }
        }

        // 3) 다른 섹션 탐색
        let sec_range: Box<dyn Iterator<Item = usize>> = if forward {
            Box::new(section_idx.saturating_add(1)..sections.len())
        } else if section_idx > 0 {
            Box::new((0..section_idx.min(sections.len())).rev())
        } else {
            Box::new(std::iter::empty())
        };
        for si in sec_range {
            if let Some(section) = sections.get(si) {
                let para_range: Box<dyn Iterator<Item = usize>> = if forward {
                    Box::new(0..section.paragraphs.len())
                } else {
                    Box::new((0..section.paragraphs.len()).rev())
                };
                for pi in para_range {
                    let search_start = if forward {
                        -1
                    } else {
                        section.paragraphs.get(pi).map_or(0, |p| p.controls.len()) as i32
                    };
                    if let Some((ci, ty)) = find_in_para(sections, si, pi, search_start, forward) {
                        return format!(
                            "{{\"type\":\"{}\",\"sec\":{},\"para\":{},\"ci\":{}}}",
                            ty, si, pi, ci
                        );
                    }
                    if !has_navigable_control(sections, si, pi) {
                        return format!("{{\"type\":\"body\",\"sec\":{},\"para\":{}}}", si, pi);
                    }
                }
            }
        }

        // 4) 문서 경계
        "{\"type\":\"none\"}".to_string()
    }

    /// 커서에서 이전 방향으로 가장 가까운 선택 가능 컨트롤을 찾는다.
    /// F11 키 기능: 표, 그림, 글상자, 수식, 누름틀 등을 객체 선택.
    ///
    /// 반환 JSON:
    ///   `{"type":"table"|"shape"|"picture"|"equation"|"field","sec":N,"para":N,"ci":N}`
    ///   `{"type":"none"}`
    pub fn find_nearest_control_backward_native(
        &self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
    ) -> String {
        let sections = &self.document.sections;

        // 컨트롤 타입 분류 (선택 가능한 것만)
        fn classify_control(ctrl: &Control) -> Option<&'static str> {
            match ctrl {
                Control::Table(_) => Some("table"),
                Control::Picture(_) => Some("picture"),
                Control::Shape(_) => Some("shape"),
                Control::Equation(_) => Some("equation"),
                Control::Field(_) => Some("field"),
                Control::Bookmark(_) => Some("bookmark"),
                _ => None,
            }
        }

        // 문단 내에서 char_offset 이전의 컨트롤을 역순으로 탐색
        fn find_in_para_before(
            para: &crate::model::paragraph::Paragraph,
            char_offset: usize,
        ) -> Option<(usize, usize, &'static str)> {
            let positions = crate::document_core::find_control_text_positions(para);
            for ci in (0..para.controls.len()).rev() {
                if let Some(&pos) = positions.get(ci) {
                    if pos < char_offset {
                        if let Some(ty) = classify_control(&para.controls[ci]) {
                            return Some((ci, pos, ty));
                        }
                    }
                }
            }
            None
        }

        // 문단 전체에서 마지막 선택 가능 컨트롤 찾기
        fn find_last_in_para(
            para: &crate::model::paragraph::Paragraph,
        ) -> Option<(usize, usize, &'static str)> {
            let positions = crate::document_core::find_control_text_positions(para);
            for ci in (0..para.controls.len()).rev() {
                if let Some(ty) = classify_control(&para.controls[ci]) {
                    let pos = positions.get(ci).copied().unwrap_or(0);
                    return Some((ci, pos, ty));
                }
            }
            None
        }

        fn fmt_result(ty: &str, sec: usize, para: usize, ci: usize, char_pos: usize) -> String {
            format!(
                "{{\"type\":\"{}\",\"sec\":{},\"para\":{},\"ci\":{},\"charPos\":{}}}",
                ty, sec, para, ci, char_pos
            )
        }

        // 1) 같은 문단에서 char_offset 이전 탐색
        if let Some(section) = sections.get(section_idx) {
            if let Some(para) = section.paragraphs.get(para_idx) {
                if let Some((ci, cp, ty)) = find_in_para_before(para, char_offset) {
                    return fmt_result(ty, section_idx, para_idx, ci, cp);
                }
            }
        }

        // 2) 이전 문단들 역순 탐색 (같은 섹션)
        // 범위 밖 문단·구역 번호는 잘라서 인덱싱 panic 과 수십억 번 헛돌기를 막는다.
        if let Some(section) = sections.get(section_idx) {
            for pi in (0..para_idx.min(section.paragraphs.len())).rev() {
                if let Some((ci, cp, ty)) = find_last_in_para(&section.paragraphs[pi]) {
                    return fmt_result(ty, section_idx, pi, ci, cp);
                }
            }
        }

        // 3) 이전 섹션 역순 탐색
        for si in (0..section_idx.min(sections.len())).rev() {
            if let Some(section) = sections.get(si) {
                for pi in (0..section.paragraphs.len()).rev() {
                    if let Some((ci, cp, ty)) = find_last_in_para(&section.paragraphs[pi]) {
                        return fmt_result(ty, si, pi, ci, cp);
                    }
                }
            }
        }

        "{\"type\":\"none\"}".to_string()
    }

    /// 현재 위치 이후의 가장 가까운 선택 가능 컨트롤을 찾는다 (Shift+F11).
    pub fn find_nearest_control_forward_native(
        &self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
    ) -> String {
        let sections = &self.document.sections;

        fn classify_control(ctrl: &Control) -> Option<&'static str> {
            match ctrl {
                Control::Table(_) => Some("table"),
                Control::Picture(_) => Some("picture"),
                Control::Shape(_) => Some("shape"),
                Control::Equation(_) => Some("equation"),
                Control::Field(_) => Some("field"),
                Control::Bookmark(_) => Some("bookmark"),
                _ => None,
            }
        }

        fn find_in_para_after(
            para: &crate::model::paragraph::Paragraph,
            char_offset: usize,
        ) -> Option<(usize, usize, &'static str)> {
            let positions = crate::document_core::find_control_text_positions(para);
            for ci in 0..para.controls.len() {
                if let Some(&pos) = positions.get(ci) {
                    if pos > char_offset {
                        if let Some(ty) = classify_control(&para.controls[ci]) {
                            return Some((ci, pos, ty));
                        }
                    }
                }
            }
            None
        }

        fn find_first_in_para(
            para: &crate::model::paragraph::Paragraph,
        ) -> Option<(usize, usize, &'static str)> {
            let positions = crate::document_core::find_control_text_positions(para);
            for ci in 0..para.controls.len() {
                if let Some(ty) = classify_control(&para.controls[ci]) {
                    let pos = positions.get(ci).copied().unwrap_or(0);
                    return Some((ci, pos, ty));
                }
            }
            None
        }

        fn fmt_result(ty: &str, sec: usize, para: usize, ci: usize, char_pos: usize) -> String {
            format!(
                "{{\"type\":\"{}\",\"sec\":{},\"para\":{},\"ci\":{},\"charPos\":{}}}",
                ty, sec, para, ci, char_pos
            )
        }

        // 1) 같은 문단에서 char_offset 이후 탐색
        if let Some(section) = sections.get(section_idx) {
            if let Some(para) = section.paragraphs.get(para_idx) {
                if let Some((ci, cp, ty)) = find_in_para_after(para, char_offset) {
                    return fmt_result(ty, section_idx, para_idx, ci, cp);
                }
            }
        }

        // 2) 이후 문단 정순 탐색 (같은 섹션)
        if let Some(section) = sections.get(section_idx) {
            for pi in para_idx.saturating_add(1)..section.paragraphs.len() {
                if let Some((ci, cp, ty)) = find_first_in_para(&section.paragraphs[pi]) {
                    return fmt_result(ty, section_idx, pi, ci, cp);
                }
            }
        }

        // 3) 이후 섹션 정순 탐색
        for si in section_idx.saturating_add(1)..sections.len() {
            if let Some(section) = sections.get(si) {
                for pi in 0..section.paragraphs.len() {
                    if let Some((ci, cp, ty)) = find_first_in_para(&section.paragraphs[pi]) {
                        return fmt_result(ty, si, pi, ci, cp);
                    }
                }
            }
        }

        "{\"type\":\"none\"}".to_string()
    }

    /// 문단 텍스트 부분 추출 (네이티브)
    pub fn get_text_range_native(
        &self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
        count: usize,
    ) -> Result<String, HwpError> {
        let section = self.document.sections.get(section_idx).ok_or_else(|| {
            HwpError::RenderError(format!(
                "구역 인덱스 {} 범위 초과 (총 {}개)",
                section_idx,
                self.document.sections.len()
            ))
        })?;
        let para = section.paragraphs.get(para_idx).ok_or_else(|| {
            HwpError::RenderError(format!(
                "문단 인덱스 {} 범위 초과 (총 {}개)",
                para_idx,
                section.paragraphs.len()
            ))
        })?;
        let text_chars: Vec<char> = para.text.chars().collect();
        let total = text_chars.len();
        if char_offset > total {
            return Err(HwpError::RenderError(format!(
                "char_offset {} 범위 초과 (문단 길이 {})",
                char_offset, total
            )));
        }
        let end = (char_offset + count).min(total);
        let result: String = text_chars[char_offset..end].iter().collect();
        Ok(result)
    }

    /// 셀 내 문단 수 (네이티브)
    pub fn get_cell_paragraph_count_native(
        &self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
    ) -> Result<usize, HwpError> {
        let para = self
            .document
            .sections
            .get(section_idx)
            .ok_or_else(|| HwpError::RenderError(format!("구역 인덱스 {} 범위 초과", section_idx)))?
            .paragraphs
            .get(parent_para_idx)
            .ok_or_else(|| {
                HwpError::RenderError(format!("문단 인덱스 {} 범위 초과", parent_para_idx))
            })?;
        match para.controls.get(control_idx) {
            Some(Control::Table(table)) => {
                if cell_idx == 65534 {
                    let cap = table
                        .caption
                        .as_ref()
                        .ok_or_else(|| HwpError::RenderError("표에 캡션이 없습니다".to_string()))?;
                    return Ok(cap.paragraphs.len());
                }
                let cell = table.cells.get(cell_idx).ok_or_else(|| {
                    HwpError::RenderError(format!(
                        "셀 인덱스 {} 범위 초과 (총 {}개)",
                        cell_idx,
                        table.cells.len()
                    ))
                })?;
                Ok(cell.paragraphs.len())
            }
            Some(Control::Shape(shape)) => {
                let text_box = get_textbox_from_shape(shape)
                    .ok_or_else(|| HwpError::RenderError("도형에 글상자가 없습니다".to_string()))?;
                Ok(text_box.paragraphs.len())
            }
            Some(Control::Picture(pic)) => {
                let caption = pic
                    .caption
                    .as_ref()
                    .ok_or_else(|| HwpError::RenderError("그림에 캡션이 없습니다".to_string()))?;
                Ok(caption.paragraphs.len())
            }
            _ => Err(HwpError::RenderError(format!(
                "컨트롤 인덱스 {}가 표/글상자가 아닙니다",
                control_idx
            ))),
        }
    }

    /// 셀 내 문단 글자 수 (네이티브)
    pub fn get_cell_paragraph_length_native(
        &self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
    ) -> Result<usize, HwpError> {
        let cell_para = self
            .get_cell_paragraph_ref(
                section_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
            )
            .ok_or_else(|| {
                HwpError::RenderError(format!(
                    "셀 문단 접근 실패: sec={}, para={}, ctrl={}, cell={}, cellPara={}",
                    section_idx, parent_para_idx, control_idx, cell_idx, cell_para_idx
                ))
            })?;
        Ok(cell_para.text.chars().count())
    }

    /// 셀 내 텍스트 부분 추출 (네이티브)
    pub fn get_text_in_cell_native(
        &self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        char_offset: usize,
        count: usize,
    ) -> Result<String, HwpError> {
        let cell_para = self
            .get_cell_paragraph_ref(
                section_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
            )
            .ok_or_else(|| {
                HwpError::RenderError(format!(
                    "셀 문단 접근 실패: sec={}, para={}, ctrl={}, cell={}, cellPara={}",
                    section_idx, parent_para_idx, control_idx, cell_idx, cell_para_idx
                ))
            })?;
        let text_chars: Vec<char> = cell_para.text.chars().collect();
        let total = text_chars.len();
        if char_offset > total {
            return Err(HwpError::RenderError(format!(
                "char_offset {} 범위 초과 (셀 문단 길이 {})",
                char_offset, total
            )));
        }
        let end = (char_offset + count).min(total);
        let result: String = text_chars[char_offset..end].iter().collect();
        Ok(result)
    }

    // ─── Phase 1 Native 끝 ──────────────────────────────────

    // ─── Phase 2 Native: 커서/히트 테스트 API ────────────────────

    /// 문단이 포함된 글로벌 페이지 번호 목록을 반환한다.
    pub(crate) fn find_pages_for_paragraph(
        &self,
        section_idx: usize,
        para_idx: usize,
    ) -> Result<Vec<u32>, HwpError> {
        if section_idx >= self.pagination.len() {
            return Err(HwpError::RenderError(format!(
                "구역 인덱스 {} 범위 초과 (총 {}개)",
                section_idx,
                self.pagination.len()
            )));
        }
        let mut global_offset = 0u32;
        for (sec_i, pr) in self.pagination.iter().enumerate() {
            if sec_i == section_idx {
                let mut result = Vec::new();
                for (local_i, page) in pr.pages.iter().enumerate() {
                    let global_page = global_offset + local_i as u32;
                    for col in &page.column_contents {
                        for item in &col.items {
                            let pi = match item {
                                crate::renderer::pagination::PageItem::FullParagraph {
                                    para_index,
                                } => Some(*para_index),
                                crate::renderer::pagination::PageItem::PartialParagraph {
                                    para_index,
                                    ..
                                } => Some(*para_index),
                                crate::renderer::pagination::PageItem::Table {
                                    para_index, ..
                                } => Some(*para_index),
                                crate::renderer::pagination::PageItem::PartialTable {
                                    para_index,
                                    ..
                                } => Some(*para_index),
                                crate::renderer::pagination::PageItem::Shape {
                                    para_index, ..
                                } => Some(*para_index),
                                crate::renderer::pagination::PageItem::EndnoteSeparator {
                                    ..
                                } => None,
                            };
                            if pi == Some(para_idx) {
                                if result.last() != Some(&global_page) {
                                    result.push(global_page);
                                }
                            }
                        }
                        // 어울림 문단도 페이지 탐색 대상에 포함
                        for wp in &col.wrap_around_paras {
                            if wp.para_index == para_idx || wp.table_para_index == para_idx {
                                if result.last() != Some(&global_page) {
                                    result.push(global_page);
                                }
                            }
                        }
                    }
                }
                // 전역 wrap_around_paras에서도 확인
                if result.is_empty() {
                    for wp in &pr.wrap_around_paras {
                        if wp.para_index == para_idx {
                            // 표 호스트 문단의 페이지에서 렌더링됨
                            if let Ok(table_pages) =
                                self.find_pages_for_paragraph(section_idx, wp.table_para_index)
                            {
                                return Ok(table_pages);
                            }
                        }
                    }
                }
                return if result.is_empty() {
                    Err(HwpError::RenderError(format!(
                        "문단 (sec={}, para={})이 페이지에 없습니다",
                        section_idx, para_idx
                    )))
                } else {
                    Ok(result)
                };
            }
            global_offset += pr.pages.len() as u32;
        }
        Err(HwpError::RenderError(format!(
            "구역 인덱스 {} 범위 초과",
            section_idx
        )))
    }
}

fn find_text_y(node: &crate::renderer::render_tree::RenderNode, text: &str) -> Option<f64> {
    use crate::renderer::render_tree::RenderNodeType;
    if let RenderNodeType::TextRun(run) = &node.node_type {
        if run.text.contains(text) {
            return Some(node.bbox.y);
        }
    }
    for child in &node.children {
        if let Some(y) = find_text_y(child, text) {
            return Some(y);
        }
    }
    None
}

// ─── 중첩 표 path 기반 편집 API ──────────────────────────────────

impl DocumentCore {
    /// cellPath를 따라가서 최종 셀의 문단 목록에 대한 가변 참조를 얻는다.
    /// path: [(control_index, cell_index, cell_para_index), ...]
    pub(crate) fn get_cell_paragraphs_mut_by_path(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
    ) -> Result<&mut Vec<Paragraph>, HwpError> {
        if path.is_empty() {
            return Err(HwpError::RenderError("경로가 비어있습니다".to_string()));
        }
        let section = self
            .document
            .sections
            .get_mut(section_idx)
            .ok_or_else(|| HwpError::RenderError(format!("구역 {} 범위 초과", section_idx)))?;
        let mut para: &mut Paragraph = section
            .paragraphs
            .get_mut(parent_para_idx)
            .ok_or_else(|| HwpError::RenderError(format!("문단 {} 범위 초과", parent_para_idx)))?;

        for (i, &(ctrl_idx, cell_idx, cell_para_idx)) in path.iter().enumerate() {
            let is_last = i == path.len() - 1;
            let paragraphs = match para.controls.get_mut(ctrl_idx) {
                Some(Control::Table(t)) => {
                    let cell = t.cells.get_mut(cell_idx).ok_or_else(|| {
                        HwpError::RenderError(format!("경로[{}]: 셀 {} 범위 초과", i, cell_idx))
                    })?;
                    &mut cell.paragraphs
                }
                Some(Control::Shape(shape)) => {
                    if cell_idx != 0 {
                        return Err(HwpError::RenderError(format!(
                            "경로[{}]: 글상자의 cell_index는 0이어야 합니다 ({})",
                            i, cell_idx
                        )));
                    }
                    let text_box = super::super::helpers::get_textbox_from_shape_mut(shape)
                        .ok_or_else(|| {
                            HwpError::RenderError(format!(
                                "경로[{}]: controls[{}]가 텍스트 글상자가 아닙니다",
                                i, ctrl_idx
                            ))
                        })?;
                    &mut text_box.paragraphs
                }
                Some(Control::Picture(pic)) => {
                    if cell_idx != 0 {
                        return Err(HwpError::RenderError(format!(
                            "경로[{}]: 그림 캡션의 cell_index는 0이어야 합니다 ({})",
                            i, cell_idx
                        )));
                    }
                    let caption = pic.caption.as_mut().ok_or_else(|| {
                        HwpError::RenderError(format!(
                            "경로[{}]: controls[{}] 그림에 캡션이 없습니다",
                            i, ctrl_idx
                        ))
                    })?;
                    &mut caption.paragraphs
                }
                _ => {
                    return Err(HwpError::RenderError(format!(
                        "경로[{}]: controls[{}]가 표/글상자/그림 캡션이 아닙니다",
                        i, ctrl_idx
                    )))
                }
            };
            if is_last {
                return Ok(paragraphs);
            }
            para = paragraphs.get_mut(cell_para_idx).ok_or_else(|| {
                HwpError::RenderError(format!(
                    "경로[{}]: 컨테이너 문단 {} 범위 초과",
                    i, cell_para_idx
                ))
            })?;
        }
        unreachable!()
    }

    /// cellPath를 따라가서 최종 셀의 문단에 대한 가변 참조를 얻는다.
    /// path: [(control_index, cell_index, cell_para_index), ...]
    pub(crate) fn get_cell_paragraph_mut_by_path(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
    ) -> Result<&mut Paragraph, HwpError> {
        if path.is_empty() {
            return Err(HwpError::RenderError("경로가 비어있습니다".to_string()));
        }
        let last_path_index = path.len() - 1;
        let cell_para_idx = path[last_path_index].2;
        let cell_paragraphs =
            self.get_cell_paragraphs_mut_by_path(section_idx, parent_para_idx, path)?;
        cell_paragraphs.get_mut(cell_para_idx).ok_or_else(|| {
            HwpError::RenderError(format!(
                "경로[{}]: 셀문단 {} 범위 초과",
                last_path_index, cell_para_idx
            ))
        })
    }

    /// path 기반 셀 텍스트 삽입 (중첩 표 지원)
    pub fn insert_text_content_in_cell_by_path(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        char_offset: usize,
        content: &crate::model::paragraph::TextContent,
    ) -> Result<String, HwpError> {
        content
            .validate()
            .map_err(|e| HwpError::RenderError(e.to_string()))?;
        self.insert_text_in_cell_by_path_impl(
            section_idx,
            parent_para_idx,
            path,
            char_offset,
            &content.text,
            Some(content),
        )
    }

    pub fn insert_text_in_cell_by_path(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        char_offset: usize,
        text: &str,
    ) -> Result<String, HwpError> {
        self.insert_text_in_cell_by_path_impl(
            section_idx,
            parent_para_idx,
            path,
            char_offset,
            text,
            None,
        )
    }

    fn insert_text_in_cell_by_path_impl(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        char_offset: usize,
        text: &str,
        content: Option<&crate::model::paragraph::TextContent>,
    ) -> Result<String, HwpError> {
        // 깊이 1 표는 일반 셀 삽입 경로가 셀 폭 리플로우와 vpos 재계산을 이미 담당한다.
        // IME가 cellPath를 항상 전달하더라도 같은 편집 계약을 사용해야 한다.
        if path.len() == 1 {
            let (control_idx, cell_idx, cell_para_idx) = path[0];
            if let Some(content) = content {
                return self.insert_text_content_in_cell_native(
                    section_idx,
                    parent_para_idx,
                    control_idx,
                    cell_idx,
                    cell_para_idx,
                    char_offset,
                    content,
                );
            }
            return self.insert_text_in_cell_native(
                section_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
                char_offset,
                text,
            );
        }

        let after_control = self.caret_insert_after_control.take();
        let new_chars_count = text.chars().count();
        let active_field = self.active_field.clone();
        let cell_para = self.get_cell_paragraph_mut_by_path(section_idx, parent_para_idx, path)?;
        let flow_advance_before = relative_paragraph_flow_advance(cell_para);
        let cell_para_idx = path.last().map(|entry| entry.2).unwrap_or(0);
        let outside_insertions = inactive_field_end_insertions(
            cell_para,
            active_field.as_ref(),
            section_idx,
            cell_para_idx,
            Some(path),
            char_offset,
        );
        let before_insertions = inactive_field_start_insertions(
            cell_para,
            active_field.as_ref(),
            section_idx,
            cell_para_idx,
            Some(path),
            char_offset,
        );
        let inserted_at =
            Self::insert_text_for_caret(cell_para, char_offset, text, after_control, content);
        keep_inactive_field_start_outside(cell_para, &before_insertions, new_chars_count);
        keep_inactive_field_end_outside(cell_para, &outside_insertions, new_chars_count);
        if has_clickhere_field_range(cell_para) {
            rebuild_char_offsets(cell_para);
        }

        self.reflow_cell_paragraph_by_path(section_idx, parent_para_idx, path, cell_para_idx);
        self.recalculate_cell_paragraph_vpos_by_path(
            section_idx,
            parent_para_idx,
            path,
            cell_para_idx,
            None,
        );

        let flow_advance_after = relative_paragraph_flow_advance(
            self.get_cell_paragraph_mut_by_path(section_idx, parent_para_idx, path)?,
        );
        // flat 셀 편집과 같은 저장 계약: 내용이 커졌지만 선언 형상을 아직 갱신하지
        // 않은 셀만 dirty로 보존한다. 경로의 상위 셀도 같은 중첩 내용에 의존한다.
        if flow_advance_after.unwrap_or(0) > flow_advance_before.unwrap_or(0)
            && (flow_advance_before.is_some() || new_chars_count > 0)
        {
            for i in 0..path.len() {
                let parent = if i == 0 {
                    &mut self.document.sections[section_idx].paragraphs[parent_para_idx]
                } else {
                    self.get_cell_paragraph_mut_by_path(section_idx, parent_para_idx, &path[..i])?
                };
                let (control_idx, cell_idx, _) = path[i];
                if let Some(Control::Table(table)) = parent.controls.get_mut(control_idx) {
                    if let Some(cell) = table.cells.get_mut(cell_idx) {
                        cell.dirty_flag = true;
                    }
                }
            }
        }

        // 최외곽 표 dirty 마킹
        let outer_ctrl = path[0].0;
        self.commit_cell_edit_geometry(
            section_idx,
            parent_para_idx,
            path,
            flow_advance_before != flow_advance_after,
        )?;
        self.mark_cell_control_dirty(section_idx, parent_para_idx, outer_ctrl);

        // Invalidate pagination after reflowing the innermost cell.
        self.document.sections[section_idx].raw_stream = None;
        self.mark_section_dirty(section_idx);
        self.paginate_if_needed();

        let new_offset = inserted_at + new_chars_count;
        self.event_log.push(DocumentEvent::CellTextChanged {
            section: section_idx,
            para: parent_para_idx,
            ctrl: outer_ctrl,
            cell: path[0].1,
        });
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"charOffset\":{}",
            new_offset
        )))
    }

    /// path 기반 셀 텍스트 삭제 (중첩 표 지원)
    pub fn delete_text_in_cell_by_path(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        char_offset: usize,
        count: usize,
    ) -> Result<String, HwpError> {
        // [#2755] 깊이 1 표/글상자/캡션은 flat 셀 삭제 경로가 셀 폭 리플로우와 vpos 재계산을
        // 이미 담당한다. `insert_text_in_cell_by_path`(:3389)의 깊이 1 위임 가드와 동형이며,
        // flat `delete_text_in_cell_native`(:955)는 모든 컨테이너 종류를 처리한다.
        if path.len() == 1 {
            let (control_idx, cell_idx, cell_para_idx) = path[0];
            return self.delete_text_in_cell_native(
                section_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
                char_offset,
                count,
            );
        }

        let cell_para = self.get_cell_paragraph_mut_by_path(section_idx, parent_para_idx, path)?;
        let flow_advance_before = relative_paragraph_flow_advance(cell_para);
        let removed_start = char_offset.min(cell_para.text.chars().count());
        let removed_content = cell_para.capture_text_content(removed_start, count);
        cell_para.delete_text_at(char_offset, count);

        // [#2755] 깊이 ≥ 2 중첩 셀도 flat `delete_text_in_cell_native` 처럼 최내곽 셀 폭으로
        // 재래핑하고 vpos 를 재계산한다(깊이 1 은 위 위임 가드가 flat 경로로 처리).
        let inner_cell_para_idx = path.last().map(|e| e.2).unwrap_or(0);
        self.reflow_cell_paragraph_by_path(section_idx, parent_para_idx, path, inner_cell_para_idx);
        self.recalculate_cell_paragraph_vpos_by_path(
            section_idx,
            parent_para_idx,
            path,
            inner_cell_para_idx,
            None,
        );

        let outer_ctrl = path[0].0;
        let flow_advance_after = relative_paragraph_flow_advance(
            self.get_cell_paragraph_mut_by_path(section_idx, parent_para_idx, path)?,
        );
        self.commit_cell_edit_geometry(
            section_idx,
            parent_para_idx,
            path,
            flow_advance_before != flow_advance_after,
        )?;
        self.mark_cell_control_dirty(section_idx, parent_para_idx, outer_ctrl);
        self.document.sections[section_idx].raw_stream = None;
        self.mark_section_dirty(section_idx);
        self.paginate_if_needed();

        self.event_log.push(DocumentEvent::CellTextChanged {
            section: section_idx,
            para: parent_para_idx,
            ctrl: outer_ctrl,
            cell: path[0].1,
        });
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"charOffset\":{},{}",
            removed_start,
            super::super::helpers::removed_content_fields(removed_start, &removed_content)
        )))
    }

    /// path 기반 셀 내 범위 삭제 (중첩 표 지원). `deleteRangeInCell`(flat)의 cellPath 변형.
    ///
    /// flat deleteRangeInCell 은 controlIndex/cellIndex 를 최외곽(cellPath[0]) 축으로 받아
    /// 중첩 셀에서 바깥 셀을 삭제한다. 이 변형은 path 로 최내곽 셀을 해석해 그 셀의
    /// 문단 목록에 직접 범위 삭제를 적용한다. start_para/end_para 는 최내곽 셀 내부 인덱스다.
    #[allow(clippy::too_many_arguments)]
    pub fn delete_range_in_cell_by_path(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        start_para: usize,
        start_offset: usize,
        end_para: usize,
        end_offset: usize,
    ) -> Result<String, HwpError> {
        let flow_before = cell_flow_signature(self.get_cell_paragraphs_mut_by_path(
            section_idx,
            parent_para_idx,
            path,
        )?);
        {
            let paras = self.get_cell_paragraphs_mut_by_path(section_idx, parent_para_idx, path)?;
            // 변형 전에 끝점을 검증한다. 뒤집히거나 범위 밖인 끝 문단을 그대로 두면 아래
            // 역순 제거·병합이 엉뚱한 문단을 합치거나 셀 문단을 통째로 지운 뒤 ok 를 낸다.
            if start_para > end_para || end_para >= paras.len() {
                return Err(HwpError::RenderError(format!(
                    "셀 문단 범위 오류 (start={}, end={}, 총 {}개)",
                    start_para,
                    end_para,
                    paras.len()
                )));
            }
            if start_para == end_para {
                let count = end_offset.saturating_sub(start_offset);
                if count > 0 {
                    if let Some(p) = paras.get_mut(start_para) {
                        p.delete_text_at(start_offset, count);
                    }
                }
            } else {
                // 1) 마지막 문단 앞부분 삭제
                if end_offset > 0 {
                    if let Some(p) = paras.get_mut(end_para) {
                        p.delete_text_at(0, end_offset);
                    }
                }
                // 2) 중간 문단 역순 제거
                for mid in (start_para + 1..end_para).rev() {
                    if mid < paras.len() {
                        paras.remove(mid);
                    }
                }
                // 3) 첫 문단 뒷부분 삭제
                if let Some(p) = paras.get_mut(start_para) {
                    let para_len = p.text.chars().count();
                    if start_offset < para_len {
                        p.delete_text_at(start_offset, para_len - start_offset);
                    }
                }
                // 4) 첫-마지막 문단 병합 (마지막이 이제 start_para+1)
                if start_para + 1 < paras.len() {
                    let next = paras.remove(start_para + 1);
                    paras[start_para].merge_from(&next);
                }
            }
        }

        // [#2755] flat `delete_range_native` 셀 분기와 동일하게 병합 생존 문단(start_para)을
        // 셀 폭 기준으로 재래핑한다. by_path 리플로우는 최내곽 셀 폭을 해석하므로 깊이 1·2+ 를
        // 모두 처리하고, by_path 본문이 표/글상자/그림 캡션의 다중 문단까지 처리하는 것과도
        // 정합한다(flat delete_range 는 vpos 재계산을 하지 않으므로 여기서도 리플로우만 한다).
        self.reflow_cell_paragraph_by_path(section_idx, parent_para_idx, path, start_para);

        // dirty/이벤트는 delete_text_in_cell_by_path 와 동형(최외곽 컨트롤 기준).
        let outer_ctrl = path[0].0;
        let flow_changed = flow_before
            != cell_flow_signature(self.get_cell_paragraphs_mut_by_path(
                section_idx,
                parent_para_idx,
                path,
            )?);
        self.commit_cell_edit_geometry(section_idx, parent_para_idx, path, flow_changed)?;
        self.mark_cell_control_dirty(section_idx, parent_para_idx, outer_ctrl);
        self.document.sections[section_idx].raw_stream = None;
        self.mark_section_dirty(section_idx);
        self.paginate_if_needed();
        self.event_log.push(DocumentEvent::CellTextChanged {
            section: section_idx,
            para: parent_para_idx,
            ctrl: outer_ctrl,
            cell: path[0].1,
        });
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"paraIdx\":{},\"charOffset\":{}",
            start_para, start_offset
        )))
    }

    /// path 기반 셀 문단 분할 (중첩 표 지원)
    ///
    /// `restore_meta` 는 병합 undo 전용이다 — 평면 형제와 같은 규약이다 (Task #2342).
    pub fn split_paragraph_in_cell_by_path(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        char_offset: usize,
        restore_meta: Option<ParaMeta>,
    ) -> Result<String, HwpError> {
        // [#2755] 빈 경로는 패닉이 아니라 Err 로 거절한다. `parse_cell_path` 가 "[]" 에
        // Ok(Vec::new()) 를 반환하므로 빈 경로가 여기 도달할 수 있고, wasm 에서 Rust 패닉은
        // HwpDocument 인스턴스 전체를 무효화한다. get_cell_paragraph(s)_mut_by_path 형제와 동형.
        let last = path
            .last()
            .ok_or_else(|| HwpError::RenderError("경로가 비어있습니다".to_string()))?;
        let cell_para_idx = last.2;
        // [#2755] 리플로우 후 재적용할 원본 vpos(분할 대상 문단 첫 seg).
        let mut split_origin_vpos: Option<i32> = None;

        // 공통 path resolver는 표뿐 아니라 글상자/캡션을 거쳐 하강하는 경로도 처리한다.
        {
            let paragraphs =
                self.get_cell_paragraphs_mut_by_path(section_idx, parent_para_idx, path)?;
            if cell_para_idx >= paragraphs.len() {
                return Err(HwpError::RenderError("셀문단 범위 초과".to_string()));
            }
            split_origin_vpos = paragraphs[cell_para_idx]
                .line_segs
                .first()
                .map(|seg| seg.vertical_pos);
            let mut new_para = paragraphs[cell_para_idx].split_at(char_offset);
            if let Some(meta) = restore_meta {
                new_para.apply_meta(meta);
            }
            paragraphs.insert(cell_para_idx + 1, new_para);
        }

        // [#2755] flat split 형제(:2387)와 동일하게 분할된 두 문단을 셀 폭으로 재래핑한 뒤
        // vpos 를 재계산한다(리플로우가 line_segs 를 재작성하므로 shift/recalc 를 그 뒤에 둔다).
        self.reflow_cell_paragraph_by_path(section_idx, parent_para_idx, path, cell_para_idx);
        self.reflow_cell_paragraph_by_path(section_idx, parent_para_idx, path, cell_para_idx + 1);
        if let Some(vpos) = split_origin_vpos {
            if let Ok(paras) =
                self.get_cell_paragraphs_mut_by_path(section_idx, parent_para_idx, path)
            {
                if let Some(p) = paras.get_mut(cell_para_idx) {
                    shift_paragraph_vpos_origin(p, vpos);
                }
            }
        }
        self.recalculate_cell_paragraph_vpos_by_path(
            section_idx,
            parent_para_idx,
            path,
            cell_para_idx,
            Some(cell_para_idx + 1),
        );

        let outer_ctrl = path[0].0;
        self.commit_cell_edit_geometry(section_idx, parent_para_idx, path, true)?;
        self.mark_cell_control_dirty(section_idx, parent_para_idx, outer_ctrl);
        self.document.sections[section_idx].raw_stream = None;
        self.mark_section_dirty(section_idx);
        self.paginate_if_needed();

        self.event_log.push(DocumentEvent::CellTextChanged {
            section: section_idx,
            para: parent_para_idx,
            ctrl: outer_ctrl,
            cell: path[0].1,
        });
        let new_cpi = cell_para_idx + 1;
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"cellParaIndex\":{},\"charOffset\":0",
            new_cpi
        )))
    }

    /// path 기반 셀 문단 병합 (중첩 표 지원)
    pub fn merge_paragraph_in_cell_by_path(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
    ) -> Result<String, HwpError> {
        // [#2755] 빈 경로는 패닉이 아니라 Err 로 거절한다(split_paragraph_in_cell_by_path 동형).
        let last = path
            .last()
            .ok_or_else(|| HwpError::RenderError("경로가 비어있습니다".to_string()))?;
        let cell_para_idx = last.2;
        if cell_para_idx == 0 {
            return Err(HwpError::RenderError(
                "첫 문단은 병합할 수 없습니다".to_string(),
            ));
        }
        let prev_idx = cell_para_idx - 1;
        // [#2755] 리플로우 후 재적용할 원본 vpos(병합 생존 문단 첫 seg).
        let mut merge_origin_vpos: Option<i32> = None;

        let mut merge_point = 0usize;
        // 사라지는 문단의 스코프 메타 — undo(split)가 되돌릴 값이다 (Task #2342).
        let mut removed_meta: Option<ParaMeta> = None;
        {
            let paragraphs =
                self.get_cell_paragraphs_mut_by_path(section_idx, parent_para_idx, path)?;
            if cell_para_idx >= paragraphs.len() {
                return Err(HwpError::RenderError("셀문단 범위 초과".to_string()));
            }
            merge_origin_vpos = paragraphs[prev_idx]
                .line_segs
                .first()
                .map(|seg| seg.vertical_pos);
            let removed = paragraphs.remove(cell_para_idx);
            removed_meta = Some(removed.capture_meta());
            let prev = &mut paragraphs[prev_idx];
            merge_point = prev.text.chars().count();
            prev.merge_from(&removed);
        }

        // [#2755] flat merge 형제(:2486)와 동일하게 병합 생존 문단을 셀 폭으로 재래핑한 뒤
        // vpos 를 재계산한다(리플로우가 line_segs 를 재작성하므로 shift/recalc 를 그 뒤에 둔다).
        self.reflow_cell_paragraph_by_path(section_idx, parent_para_idx, path, prev_idx);
        if let Some(vpos) = merge_origin_vpos {
            if let Ok(paras) =
                self.get_cell_paragraphs_mut_by_path(section_idx, parent_para_idx, path)
            {
                if let Some(p) = paras.get_mut(prev_idx) {
                    shift_paragraph_vpos_origin(p, vpos);
                }
            }
        }
        self.recalculate_cell_paragraph_vpos_by_path(
            section_idx,
            parent_para_idx,
            path,
            prev_idx,
            None,
        );

        let outer_ctrl = path[0].0;
        self.commit_cell_edit_geometry(section_idx, parent_para_idx, path, true)?;
        self.mark_cell_control_dirty(section_idx, parent_para_idx, outer_ctrl);
        self.document.sections[section_idx].raw_stream = None;
        self.mark_section_dirty(section_idx);
        self.paginate_if_needed();

        self.event_log.push(DocumentEvent::CellTextChanged {
            section: section_idx,
            para: parent_para_idx,
            ctrl: outer_ctrl,
            cell: path[0].1,
        });
        let prev_cpi = cell_para_idx - 1;
        let removed_meta = removed_meta
            .as_ref()
            .map(super::super::helpers::removed_para_meta_field)
            .unwrap_or_default();
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"cellParaIndex\":{},\"charOffset\":{}{}",
            prev_cpi, merge_point, removed_meta
        )))
    }

    /// path 기반 셀 텍스트 조회 (중첩 표 지원)
    pub fn get_text_in_cell_by_path(
        &self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        char_offset: usize,
        count: usize,
    ) -> Result<String, HwpError> {
        let para = self.resolve_paragraph_by_path(section_idx, parent_para_idx, path)?;
        let text_chars: Vec<char> = para.text.chars().collect();
        let total = text_chars.len();
        if char_offset > total {
            return Err(HwpError::RenderError(format!(
                "char_offset {} 범위 초과 (셀 문단 길이 {})",
                char_offset, total
            )));
        }
        let end = (char_offset + count).min(total);
        Ok(text_chars[char_offset..end].iter().collect())
    }
}


//! 내부 클립보드 + HTML 내보내기 관련 native 메서드

use super::super::helpers::{
    border_line_type_to_u8_val, clipboard_color_to_css, clipboard_escape_html, color_ref_to_css,
    detect_clipboard_image_mime, get_textbox_from_shape, get_textbox_from_shape_mut,
    has_block_table, is_block_table_control, utf16_pos_to_char_idx,
};
use super::super::queries::field_query::rebuild_char_offsets;
use crate::document_core::{ClipboardData, DocumentCore};
use crate::error::HwpError;
use crate::model::control::Control;
use crate::model::event::DocumentEvent;
use crate::model::paragraph::{FieldRange, LineSeg, Paragraph};

/// [Task #1161] 떠 있는 개체 반복 붙여넣기 cascade 1 회당 위치 오프셋(HWPUNIT).
/// 약 2mm (1mm = 7200/25.4 ≈ 283.46 HWPUNIT). 한컴 정합은 작업지시자 시각 대조로 미세조정.
const PASTE_CASCADE_STEP_HU: u32 = 567;

/// 커서는 인라인 개체만 세지만 split_at은 떠 있는 개체도 한 슬롯으로 센다.
pub(super) fn clipboard_split_offset(paragraph: &Paragraph, logical_offset: usize) -> usize {
    let (text_offset, _) = super::super::helpers::logical_to_text_offset(paragraph, logical_offset);
    let positions = super::super::helpers::find_logical_control_positions(paragraph);
    text_offset
        + paragraph
            .controls
            .iter()
            .enumerate()
            .filter(|(index, control)| {
                Paragraph::is_split_movable_control(control)
                    && positions
                        .get(*index)
                        .is_some_and(|position| *position < logical_offset)
            })
            .count()
}

fn clipboard_paragraphs_contain_field(paragraphs: &[Paragraph]) -> bool {
    paragraphs.iter().any(|para| !para.field_ranges.is_empty())
}

fn clipboard_control_char_code(ctrl: &Control) -> u16 {
    match ctrl {
        Control::SectionDef(_) | Control::ColumnDef(_) => 0x0002,
        Control::Field(_) => 0x0003,
        Control::Table(_)
        | Control::Shape(_)
        | Control::Picture(_)
        | Control::Hyperlink(_)
        | Control::Ruby(_)
        | Control::Equation(_)
        | Control::Form(_)
        | Control::Unknown(_) => 0x000B,
        Control::HiddenComment(_) => 0x000F,
        Control::Header(_) | Control::Footer(_) => 0x0010,
        Control::Footnote(_) | Control::Endnote(_) => 0x0011,
        Control::AutoNumber(_) | Control::NewNumber(_) => 0x0012,
        Control::PageNumberPos(_) | Control::PageHide(_) => 0x0015,
        Control::Bookmark(_) => 0x0016,
        Control::CharOverlap(_) => 0x0017,
    }
}

fn recompute_clipboard_control_mask(para: &Paragraph) -> u32 {
    let mut mask = 0u32;
    for ctrl in &para.controls {
        mask |= 1u32 << clipboard_control_char_code(ctrl);
    }
    if !para.field_ranges.is_empty() {
        mask |= 1u32 << 0x0004;
    }
    if para.text.contains('\t') {
        mask |= 1u32 << 0x0009;
    }
    if para.text.contains('\n') {
        mask |= 1u32 << 0x000A;
    }
    // 미상 하이픈(코드 24)은 기존 마스크를 잇고, 빈칸은 각 문자의 명시적 출처를 우선한다.
    for (bit, ch) in [(0x0018, '\u{00AD}')] {
        if para.control_mask & (1u32 << bit) != 0 && para.text.contains(ch) {
            mask |= 1u32 << bit;
        }
    }
    for (i, ch) in para.text.chars().enumerate() {
        match para.space_origin_at(i) {
            Some(crate::model::paragraph::SpecialSpaceOriginKind::NbSpace) => mask |= 1u32 << 0x1e,
            Some(crate::model::paragraph::SpecialSpaceOriginKind::FwSpace) => mask |= 1u32 << 0x1f,
            None if ch == '\u{2007}' && para.control_mask & (1u32 << 0x1f) != 0 => {
                mask |= 1u32 << 0x1f
            }
            _ => {}
        }
    }
    mask
}

pub(super) fn strip_structural_controls_for_text_clipboard(para: &mut Paragraph) {
    let old_controls = std::mem::take(&mut para.controls);
    let old_records = std::mem::take(&mut para.ctrl_data_records);
    let mut index_map = vec![None; old_controls.len()];
    let mut new_controls = Vec::new();
    let mut new_records = Vec::new();

    for (old_idx, ctrl) in old_controls.into_iter().enumerate() {
        if matches!(ctrl, Control::SectionDef(_) | Control::ColumnDef(_)) {
            para.authored_text_runs = None;
            para.para_text_terminal = None;
            continue;
        }
        index_map[old_idx] = Some(new_controls.len());
        new_records.push(old_records.get(old_idx).cloned().flatten());
        new_controls.push(ctrl);
    }

    para.field_ranges = para
        .field_ranges
        .drain(..)
        .filter_map(|mut fr| {
            let new_idx = index_map.get(fr.control_idx).and_then(|idx| *idx)?;
            fr.control_idx = new_idx;
            Some(fr)
        })
        .collect();
    para.controls = new_controls;
    para.ctrl_data_records = new_records;
    para.control_mask = recompute_clipboard_control_mask(para);
    if !para.field_ranges.is_empty() {
        rebuild_char_offsets(para);
    }
}

pub(super) fn text_to_split_logical_offset(para: &Paragraph, text_offset: usize) -> usize {
    let control_positions = para.control_text_positions();
    if control_positions.is_empty() {
        return text_offset;
    }

    // 클립보드 range trimming 은 곧바로 Paragraph::split_at()을 호출한다.
    // 따라서 커서 탐색용 논리 offset이 아니라 split_at()과 같은 movable control
    // 기준으로 변환해야 non-TAC 그림이 텍스트 앞에 있어도 첫 글자를 잃지 않는다.
    let before_count = para
        .controls
        .iter()
        .enumerate()
        .filter(|(_, ctrl)| Paragraph::is_split_movable_control(ctrl))
        .filter_map(|(ci, _)| control_positions.get(ci))
        .filter(|&&pos| pos < text_offset)
        .count();
    text_offset + before_count
}

pub(super) fn clip_paragraph_text_range_for_clipboard(
    source: &Paragraph,
    start_char_offset: usize,
    end_char_offset: usize,
) -> Paragraph {
    let text_len = source.text.chars().count();
    let start = start_char_offset.min(text_len);
    let end = end_char_offset.min(text_len).max(start);

    let mut clipped = source.clone();
    if end < text_len {
        let end_logical = text_to_split_logical_offset(&clipped, end);
        let _ = clipped.split_at(end_logical);
    }
    if start == 0 {
        return clipped;
    }

    let control_positions = clipped.control_text_positions();
    let old_controls = clipped.controls.clone();
    let old_records = clipped.ctrl_data_records.clone();
    let old_ranges = clipped.field_ranges.clone();

    let start_logical = text_to_split_logical_offset(&clipped, start);
    let mut suffix = clipped.split_at(start_logical);
    let mut keep_control = vec![false; old_controls.len()];

    for range in &old_ranges {
        if range.start_char_idx >= start
            && range.end_char_idx <= end
            && range.control_idx < keep_control.len()
        {
            keep_control[range.control_idx] = true;
        }
    }

    for (idx, ctrl) in old_controls.iter().enumerate() {
        if matches!(
            ctrl,
            Control::SectionDef(_) | Control::ColumnDef(_) | Control::Field(_)
        ) {
            continue;
        }
        let pos = control_positions.get(idx).copied().unwrap_or(text_len);
        if pos >= start && pos <= end {
            keep_control[idx] = true;
        }
    }

    let mut index_map = vec![None; old_controls.len()];
    let mut new_controls = Vec::new();
    let mut new_records = Vec::new();
    for (old_idx, ctrl) in old_controls.into_iter().enumerate() {
        if !keep_control.get(old_idx).copied().unwrap_or(false) {
            continue;
        }
        index_map[old_idx] = Some(new_controls.len());
        new_records.push(old_records.get(old_idx).cloned().flatten());
        new_controls.push(ctrl);
    }

    let new_field_ranges: Vec<FieldRange> = old_ranges
        .into_iter()
        .filter_map(|mut range| {
            if range.start_char_idx < start || range.end_char_idx > end {
                return None;
            }
            let new_control_idx = index_map.get(range.control_idx).and_then(|idx| *idx)?;
            range.start_char_idx -= start;
            range.end_char_idx -= start;
            range.control_idx = new_control_idx;
            Some(range)
        })
        .collect();

    suffix.controls = new_controls;
    suffix.ctrl_data_records = new_records;
    suffix.field_ranges = new_field_ranges;
    suffix.control_mask = recompute_clipboard_control_mask(&suffix);
    if !suffix.field_ranges.is_empty() {
        rebuild_char_offsets(&mut suffix);
    }
    suffix
}

/// 클립보드 플레인 텍스트용 문단 텍스트. 문단에 붙은 표는 행을 줄바꿈, 셀을 탭으로 잇는다.
pub(super) fn paragraph_plain_text(para: &Paragraph) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !para.text.is_empty() {
        parts.push(para.text.clone());
    }
    for ctrl in &para.controls {
        if let Control::Table(table) = ctrl {
            let mut cells: Vec<&crate::model::table::Cell> = table.cells.iter().collect();
            cells.sort_by_key(|cell| (cell.row, cell.col));
            let mut rows: Vec<String> = Vec::new();
            let mut current_row: Option<u16> = None;
            let mut row_cells: Vec<String> = Vec::new();
            for cell in cells {
                if current_row.is_some_and(|row| row != cell.row) {
                    rows.push(row_cells.join("\t"));
                    row_cells.clear();
                }
                current_row = Some(cell.row);
                row_cells.push(
                    cell.paragraphs
                        .iter()
                        .map(paragraph_plain_text)
                        .collect::<Vec<_>>()
                        .join(" "),
                );
            }
            if current_row.is_some() {
                rows.push(row_cells.join("\t"));
            }
            parts.push(rows.join("\n"));
        }
    }
    parts.join("\n")
}

/// 여러 문단에 걸친 선택의 한 문단을 자른다. 범위가 문단을 통째로 덮으면 문단에 붙은
/// 블록 표·개체까지 그대로 복사한다 — 논리 길이에 잡히지 않는 블록 표가 빠지지 않도록.
/// 끝 문단(`is_last`)은 처음 자리(오프셋 0)에서 끝나면 문단을 지나가지 않은 것으로 본다.
fn clip_multi_paragraph_endpoint(
    source: &Paragraph,
    start: usize,
    end: usize,
    is_last: bool,
) -> Paragraph {
    let length = super::super::helpers::logical_paragraph_length(source);
    let covers = start == 0 && end >= length && !(is_last && end == 0);
    if covers && has_block_table(source) {
        return source.clone();
    }
    clip_paragraph_logical_range_for_clipboard(source, start, end)
}

/// 논리 범위로 선택되지 않은 문단 부착 블록 표를 잘라낸다. 표 자체를 넘는 선택은
/// 끝 가상 오프셋이나 전체 문단 경로에서 별도로 원본 문단을 보존한다.
fn strip_unselected_block_tables(para: &mut Paragraph) {
    if !has_block_table(para) {
        return;
    }
    for index in (0..para.controls.len()).rev() {
        if is_block_table_control(&para.controls[index]) {
            DocumentCore::remove_inline_control_with_metadata(para, index);
        }
    }
    para.control_mask = recompute_clipboard_control_mask(para);
}

/// 텍스트 전용 필드 범위의 기존 의미를 유지하면서 인라인 개체 커서 슬롯을 처리한다.
fn clip_paragraph_logical_range_for_clipboard(
    source: &Paragraph,
    start_offset: usize,
    end_offset: usize,
) -> Paragraph {
    let length = super::super::helpers::logical_paragraph_length(source);
    let start = start_offset.min(length);
    if end_offset == length + 1 && has_block_table(source) {
        if start == 0 {
            return source.clone();
        }
        let mut paragraph = source.clone();
        let offset = clipboard_split_offset(&paragraph, start);
        return paragraph.split_at(offset);
    }
    let end = end_offset.min(length).max(start);
    let (text_start, _) = super::super::helpers::logical_to_text_offset(source, start);
    let (text_end, _) = super::super::helpers::logical_to_text_offset(source, end);
    if start == text_start && end == text_end && end > 0 {
        let mut paragraph = clip_paragraph_text_range_for_clipboard(source, text_start, text_end);
        strip_unselected_block_tables(&mut paragraph);
        return paragraph;
    }
    let mut paragraph = source.clone();
    if end < length || end == 0 {
        let offset = clipboard_split_offset(&paragraph, end);
        paragraph.split_at(offset);
    }
    if start > 0 {
        let offset = clipboard_split_offset(&paragraph, start);
        paragraph = paragraph.split_at(offset);
    }
    strip_unselected_block_tables(&mut paragraph);
    paragraph
}


fn collect_max_clipboard_field_id(para: &Paragraph, max_id: &mut u32) {
    for ctrl in &para.controls {
        match ctrl {
            Control::Field(field) => {
                *max_id = (*max_id).max(field.field_id);
            }
            Control::Table(table) => {
                for cell in &table.cells {
                    for cell_para in &cell.paragraphs {
                        collect_max_clipboard_field_id(cell_para, max_id);
                    }
                }
                if let Some(caption) = &table.caption {
                    for cap_para in &caption.paragraphs {
                        collect_max_clipboard_field_id(cap_para, max_id);
                    }
                }
            }
            Control::Shape(shape) => {
                if let Some(text_box) = get_textbox_from_shape(shape) {
                    for tb_para in &text_box.paragraphs {
                        collect_max_clipboard_field_id(tb_para, max_id);
                    }
                }
            }
            Control::Picture(pic) => {
                if let Some(caption) = &pic.caption {
                    for cap_para in &caption.paragraphs {
                        collect_max_clipboard_field_id(cap_para, max_id);
                    }
                }
            }
            _ => {}
        }
    }
}

fn assign_new_clipboard_field_ids(para: &mut Paragraph, next_id: &mut u32) {
    for ctrl in &mut para.controls {
        match ctrl {
            Control::Field(field) => {
                field.field_id = (*next_id).max(1);
                *next_id = next_id.saturating_add(1).max(1);
            }
            Control::Table(table) => {
                for cell in &mut table.cells {
                    for cell_para in &mut cell.paragraphs {
                        assign_new_clipboard_field_ids(cell_para, next_id);
                    }
                }
                if let Some(caption) = &mut table.caption {
                    for cap_para in &mut caption.paragraphs {
                        assign_new_clipboard_field_ids(cap_para, next_id);
                    }
                }
            }
            Control::Shape(shape) => {
                if let Some(text_box) = get_textbox_from_shape_mut(shape) {
                    for tb_para in &mut text_box.paragraphs {
                        assign_new_clipboard_field_ids(tb_para, next_id);
                    }
                }
            }
            Control::Picture(pic) => {
                if let Some(caption) = &mut pic.caption {
                    for cap_para in &mut caption.paragraphs {
                        assign_new_clipboard_field_ids(cap_para, next_id);
                    }
                }
            }
            _ => {}
        }
    }
}

impl DocumentCore {
    pub fn has_internal_clipboard_native(&self) -> bool {
        self.clipboard.is_some()
    }

    /// 내부 클립보드의 플레인 텍스트를 반환한다.
    pub fn get_clipboard_text_native(&self) -> String {
        self.clipboard
            .as_ref()
            .map(|c| c.plain_text.clone())
            .unwrap_or_default()
    }

    /// 내부 클립보드를 초기화한다.
    pub fn clear_clipboard_native(&mut self) {
        self.clipboard = None;
    }

    pub(super) fn renumber_pasted_field_ids(&self, clip_paras: &mut [Paragraph]) {
        let mut max_id = 0u32;
        for section in &self.document.sections {
            for para in &section.paragraphs {
                collect_max_clipboard_field_id(para, &mut max_id);
            }
        }
        let mut next_id = max_id.saturating_add(1).max(1);
        for para in clip_paras {
            assign_new_clipboard_field_ids(para, &mut next_id);
        }
    }

    fn append_body_range_to_clipboard(
        &self,
        clip_paragraphs: &mut Vec<Paragraph>,
        section_idx: usize,
        start_para_idx: usize,
        start_char_offset: usize,
        end_para_idx: usize,
        end_char_offset: usize,
    ) -> Result<(), HwpError> {
        let section = self.document.sections.get(section_idx).ok_or_else(|| {
            HwpError::RenderError(format!("구역 인덱스 {} 범위 초과", section_idx))
        })?;
        if start_para_idx >= section.paragraphs.len() || end_para_idx >= section.paragraphs.len() {
            return Err(HwpError::RenderError(format!(
                "문단 인덱스 범위 초과 (start={}, end={}, total={})",
                start_para_idx,
                end_para_idx,
                section.paragraphs.len()
            )));
        }
        if start_para_idx > end_para_idx
            || (start_para_idx == end_para_idx && start_char_offset > end_char_offset)
        {
            return Err(HwpError::RenderError(
                "시작 위치가 끝 위치보다 뒤에 있음".to_string(),
            ));
        }

        if start_para_idx == end_para_idx {
            clip_paragraphs.push(clip_paragraph_logical_range_for_clipboard(
                &section.paragraphs[start_para_idx],
                start_char_offset,
                end_char_offset,
            ));
            return Ok(());
        }

        let first_text_len =
            super::super::helpers::logical_paragraph_length(&section.paragraphs[start_para_idx]);
        clip_paragraphs.push(clip_multi_paragraph_endpoint(
            &section.paragraphs[start_para_idx],
            start_char_offset,
            first_text_len,
            false,
        ));
        for para_idx in (start_para_idx + 1)..end_para_idx {
            clip_paragraphs.push(section.paragraphs[para_idx].clone());
        }
        clip_paragraphs.push(clip_multi_paragraph_endpoint(
            &section.paragraphs[end_para_idx],
            0,
            end_char_offset,
            true,
        ));
        Ok(())
    }

    fn store_body_clipboard(&mut self, mut clip_paragraphs: Vec<Paragraph>) -> String {
        // SectionDef/ColumnDef are section structure, not selected text.
        for para in &mut clip_paragraphs {
            strip_structural_controls_for_text_clipboard(para);
        }
        let plain_text = clip_paragraphs
            .iter()
            .map(paragraph_plain_text)
            .collect::<Vec<_>>()
            .join("\n");
        let escaped = super::super::helpers::json_escape(&plain_text);
        self.clipboard = Some(ClipboardData {
            paragraphs: clip_paragraphs,
            plain_text,
        });
        super::super::helpers::json_ok_with(&format!("\"text\":\"{}\"", escaped))
    }

    /// 선택 영역을 내부 클립보드에 복사한다.
    ///
    /// 같은 구역 내 start ~ end 범위의 문단을 클립보드에 저장.
    /// 반환값: JSON `{"ok":true,"text":"<plain_text>"}`
    pub fn copy_selection_native(
        &mut self,
        section_idx: usize,
        start_para_idx: usize,
        start_char_offset: usize,
        end_para_idx: usize,
        end_char_offset: usize,
    ) -> Result<String, HwpError> {
        let mut clip_paragraphs = Vec::new();
        self.append_body_range_to_clipboard(
            &mut clip_paragraphs,
            section_idx,
            start_para_idx,
            start_char_offset,
            end_para_idx,
            end_char_offset,
        )?;
        Ok(self.store_body_clipboard(clip_paragraphs))
    }

    /// 여러 구역에 걸친 본문 선택을 문서 순서대로 내부 클립보드에 복사한다.
    pub fn copy_selection_across_sections_native(
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

        let mut clip_paragraphs = Vec::new();
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
            let range_start_offset = if section_idx == start_section_idx {
                start_char_offset
            } else {
                0
            };
            let range_end_offset = if section_idx == end_section_idx {
                end_char_offset
            } else {
                super::super::helpers::logical_paragraph_length(&section.paragraphs[range_end_para])
            };
            self.append_body_range_to_clipboard(
                &mut clip_paragraphs,
                section_idx,
                range_start_para,
                range_start_offset,
                range_end_para,
                range_end_offset,
            )?;
        }

        Ok(self.store_body_clipboard(clip_paragraphs))
    }

    /// 표 셀 내부 선택 영역을 내부 클립보드에 복사한다.
    pub fn copy_selection_in_cell_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        start_cell_para_idx: usize,
        start_char_offset: usize,
        end_cell_para_idx: usize,
        end_char_offset: usize,
    ) -> Result<String, HwpError> {
        self.copy_selection_in_cell_by_path_native(
            section_idx,
            parent_para_idx,
            &[(control_idx, cell_idx, start_cell_para_idx)],
            start_cell_para_idx,
            start_char_offset,
            end_cell_para_idx,
            end_char_offset,
        )
    }

    fn cell_selection_paragraphs(
        &self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        start_para_idx: usize,
        start_offset: usize,
        end_para_idx: usize,
        end_offset: usize,
    ) -> Result<Vec<Paragraph>, HwpError> {
        if path.is_empty()
            || start_para_idx > end_para_idx
            || (start_para_idx == end_para_idx && start_offset > end_offset)
        {
            return Err(HwpError::RenderError(
                "셀 선택 범위가 올바르지 않습니다".into(),
            ));
        }
        let mut selection_path = path.to_vec();
        let last = selection_path.len() - 1;
        let mut paragraphs = Vec::new();
        for index in start_para_idx..=end_para_idx {
            selection_path[last].2 = index;
            let source =
                self.resolve_control_para(section_idx, parent_para_idx, &selection_path)?;
            let length = super::super::helpers::logical_paragraph_length(source);
            let start = if index == start_para_idx {
                start_offset.min(length)
            } else {
                0
            };
            let end = if index == end_para_idx {
                if end_offset == length + 1 && has_block_table(source) {
                    end_offset
                } else {
                    end_offset.min(length)
                }
            } else {
                length
            };
            let mut paragraph = if start_para_idx == end_para_idx {
                clip_paragraph_logical_range_for_clipboard(source, start, end)
            } else {
                clip_multi_paragraph_endpoint(source, start, end, index == end_para_idx)
            };
            strip_structural_controls_for_text_clipboard(&mut paragraph);
            paragraphs.push(paragraph);
        }
        Ok(paragraphs)
    }

    /// 중첩 셀 선택을 논리적 커서 오프셋으로 복사한다.
    pub fn copy_selection_in_cell_by_path_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        start_para_idx: usize,
        start_offset: usize,
        end_para_idx: usize,
        end_offset: usize,
    ) -> Result<String, HwpError> {
        let paragraphs = self.cell_selection_paragraphs(
            section_idx,
            parent_para_idx,
            path,
            start_para_idx,
            start_offset,
            end_para_idx,
            end_offset,
        )?;
        Ok(self.store_body_clipboard(paragraphs))
    }

    /// 컨트롤 객체(표, 이미지, 도형)를 내부 클립보드에 복사한다.
    pub fn copy_control_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        cell_path: &[(usize, usize, usize)],
        control_idx: usize,
    ) -> Result<String, HwpError> {
        // [Task #1161] cell_path 가 비면 본문, 아니면 셀/글상자 안 문단.
        let para = self.resolve_control_para(section_idx, para_idx, cell_path)?;
        let control = para
            .controls
            .get(control_idx)
            .ok_or_else(|| HwpError::RenderError(format!("컨트롤 {} 범위 초과", control_idx)))?;

        // 컨트롤을 포함하는 단일 문단 생성
        // text는 비워둠 (serialize_para_text가 controls에서 확장 제어문자를 생성)
        // control_mask: 1 << ctrl_char_code (Table/Shape=0x000B→bit11=0x800 등)
        let ctrl_char_code = match control {
            Control::Table(_) | Control::Shape(_) | Control::Picture(_) => 0x000Bu16,
            Control::SectionDef(_) | Control::ColumnDef(_) => 0x0002u16,
            Control::Footnote(_) | Control::Endnote(_) => 0x0011u16,
            Control::Header(_) | Control::Footer(_) => 0x0010u16,
            Control::AutoNumber(_) | Control::NewNumber(_) => 0x0012u16,
            _ => 0x000Bu16,
        };
        // 컨트롤 치수에 맞는 line_segs 생성 (insert_picture_native 패턴)
        let ctrl_line_seg = {
            let ctrl_height = match control {
                Control::Picture(pic) => pic.common.height as i32,
                Control::Shape(shape) => shape.common().height as i32,
                _ => 0,
            };
            if ctrl_height > 0 {
                LineSeg {
                    text_start: 0,
                    line_height: ctrl_height,
                    text_height: ctrl_height,
                    baseline_distance: (ctrl_height * 850) / 1000,
                    line_spacing: 600,
                    tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
                    ..Default::default()
                }
            } else {
                LineSeg {
                    text_start: 0,
                    line_height: 400,
                    text_height: 400,
                    baseline_distance: 320,
                    tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
                    ..Default::default()
                }
            }
        };

        let clip_para = Paragraph {
            text: String::new(),
            char_count: 9, // 확장 제어문자(8 code units) + 문단끝(1)
            control_mask: 1u32 << ctrl_char_code,
            char_offsets: vec![],
            char_shapes: vec![crate::model::paragraph::CharShapeRef {
                start_pos: 0,
                // 원본 문단 첫 글자가 아니라 컨트롤 앵커 위치의 글자모양을 복사한다.
                char_shape_id: para
                    .char_shape_id_at(
                        para.control_text_positions()
                            .get(control_idx)
                            .copied()
                            .unwrap_or(0),
                    )
                    .unwrap_or(0),
            }],
            line_segs: vec![ctrl_line_seg],
            para_shape_id: para.para_shape_id,
            style_id: para.style_id,
            controls: vec![control.clone()],
            ctrl_data_records: vec![para.ctrl_data_records.get(control_idx).cloned().flatten()],
            has_para_text: true,
            ..Default::default()
        };

        let plain_text = match control {
            Control::Table(_) => "[표]".to_string(),
            Control::Picture(_) => "[그림]".to_string(),
            Control::Shape(_) => "[도형]".to_string(),
            _ => "[컨트롤]".to_string(),
        };

        self.clipboard = Some(ClipboardData {
            paragraphs: vec![clip_para],
            plain_text: plain_text.clone(),
        });
        // [Task #1161] 새 컨트롤 복사 → cascade 리셋(다음 첫 붙여넣기부터 누적 시작).
        self.paste_cascade_count = 0;

        Ok(super::super::helpers::json_ok_with(&format!(
            "\"text\":\"{}\"",
            plain_text
        )))
    }

    /// 내부 클립보드의 내용을 캐럿 위치에 붙여넣는다 (본문 문단).
    pub fn paste_internal_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
    ) -> Result<String, HwpError> {
        let mut clip_paras = match &self.clipboard {
            Some(c) if !c.paragraphs.is_empty() => c.paragraphs.clone(),
            _ => return Ok("{\"ok\":false,\"error\":\"clipboard empty\"}".to_string()),
        };
        let contains_field = clipboard_paragraphs_contain_field(&clip_paras);

        // 인덱스 검증
        if section_idx >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!(
                "구역 {} 범위 초과",
                section_idx
            )));
        }
        if para_idx >= self.document.sections[section_idx].paragraphs.len() {
            return Err(HwpError::RenderError(format!(
                "문단 {} 범위 초과",
                para_idx
            )));
        }

        self.document.sections[section_idx].raw_stream = None;
        self.renumber_pasted_field_ids(&mut clip_paras);

        let clip_count = clip_paras.len();

        if clip_count == 1
            && clip_paras[0].controls.is_empty()
            && clip_paras[0].range_tags.is_empty()
            && clip_paras[0].tab_extended.is_empty()
            && clip_paras[0].orphan_field_ends.is_empty()
            && clip_paras[0].markpen_marks.is_empty()
            && !self.document.sections[section_idx].paragraphs[para_idx]
                .controls
                .iter()
                .any(Paragraph::is_split_movable_control)
        {
            // 단일 문단 텍스트 붙여넣기 (컨트롤 없음)
            let clip_text = clip_paras[0].text.clone();
            let clip_content = clip_paras[0].capture_text_content(0, clip_text.chars().count());
            let clip_char_shapes = clip_paras[0].char_shapes.clone();
            let clip_char_offsets = clip_paras[0].char_offsets.clone();
            let new_chars = clip_text.chars().count();
            let (text_offset, _) = super::super::helpers::logical_to_text_offset(
                &self.document.sections[section_idx].paragraphs[para_idx],
                char_offset,
            );

            // 텍스트 삽입
            self.document.sections[section_idx].paragraphs[para_idx]
                .insert_text_content_at(text_offset, &clip_content)
                .map_err(|e| HwpError::RenderError(e.to_string()))?;

            // 클립보드의 글자 모양 적용
            self.apply_clipboard_char_shapes(
                section_idx,
                para_idx,
                text_offset,
                &clip_char_shapes,
                &clip_char_offsets,
                new_chars,
            );

            // [Task #2299] 리셋 판별용 — reflow 이전 저장 흐름 end 캡처.
            let stored_end_for_reset = crate::renderer::composer::paragraph_flow_end(
                &self.document.sections[section_idx].paragraphs[para_idx],
            );
            self.reflow_paragraph(section_idx, para_idx);
            // [Task #2299] 붙여넣기로 문단 높이가 변했으므로 하류 vpos 를 재연결한다.
            // 생략하면 후속 문단 first < 커진 end 세임이 저장돼 이후 편집의 리셋
            // 보존이 이를 단/쪽 경계로 오인한다.
            let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
            crate::renderer::composer::recalculate_section_vpos(
                &mut self.document.sections[section_idx].paragraphs,
                para_idx,
                None,
                stored_end_for_reset,
                &self.styles,
                self.dpi,
                doc_hwp3_layout,
            );
            self.recompose_paragraph(section_idx, para_idx);
            self.paginate_if_needed();

            let new_offset = char_offset + new_chars;
            self.event_log.push(DocumentEvent::ContentPasted {
                section: section_idx,
                para: para_idx,
            });
            return Ok(super::super::helpers::json_ok_with(&format!(
                "\"paraIdx\":{},\"charOffset\":{},\"containsField\":{}",
                para_idx, new_offset, contains_field
            )));
        }

        // 다중 문단 또는 컨트롤 포함 붙여넣기
        // 1. 현재 문단을 캐럿 위치에서 분할
        let split_offset = clipboard_split_offset(
            &self.document.sections[section_idx].paragraphs[para_idx],
            char_offset,
        );
        let right_half =
            self.document.sections[section_idx].paragraphs[para_idx].split_at(split_offset);

        // 2. 왼쪽 절반에 첫 번째 클립보드 문단 병합
        self.document.sections[section_idx].paragraphs[para_idx].merge_from(&clip_paras[0]);

        // 3. 나머지 클립보드 문단 삽입
        let mut insert_idx = para_idx + 1;
        for i in 1..clip_count {
            self.document.sections[section_idx]
                .paragraphs
                .insert(insert_idx, clip_paras[i].clone());
            insert_idx += 1;
        }

        // 4. 마지막 삽입된 문단에 오른쪽 절반 병합
        let last_para_idx = insert_idx - 1;
        let merge_point = super::super::helpers::logical_paragraph_length(
            &self.document.sections[section_idx].paragraphs[last_para_idx],
        );
        self.document.sections[section_idx].paragraphs[last_para_idx].merge_from(&right_half);

        for i in para_idx..=last_para_idx {
            if !self.document.sections[section_idx].paragraphs[i]
                .field_ranges
                .is_empty()
            {
                rebuild_char_offsets(&mut self.document.sections[section_idx].paragraphs[i]);
            }
        }

        // 5. 영향받는 모든 문단 리플로우
        for i in para_idx..=last_para_idx {
            self.reflow_paragraph(section_idx, i);
        }

        // [Task #2299] 삽입 문단들의 vpos 를 흐름에 연결한다. 클립보드 클론의
        // 원본 좌표/placeholder 를 방치하면 이후 편집의 vpos 재계산이 이를 저장
        // 단/쪽 리셋으로 오인해 영구 고착시킨다 — 신규 구간은 리셋 보존에서 제외.
        let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
        crate::renderer::composer::recalculate_section_vpos(
            &mut self.document.sections[section_idx].paragraphs,
            para_idx,
            Some(para_idx + 1..last_para_idx + 1),
            None,
            &self.styles,
            self.dpi,
            doc_hwp3_layout,
        );

        // 6. 선택적 재구성: 삽입된 문단 composed 추가 + 영향 문단 재구성
        self.recompose_paragraph(section_idx, para_idx);
        for i in para_idx + 1..=last_para_idx {
            self.insert_composed_paragraph(section_idx, i);
        }
        self.paginate_if_needed();

        self.event_log.push(DocumentEvent::ContentPasted {
            section: section_idx,
            para: para_idx,
        });
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"paraIdx\":{},\"charOffset\":{},\"containsField\":{}",
            last_para_idx, merge_point, contains_field
        )))
    }

    fn paste_paragraphs_into_cell_paragraphs(
        cell_paras: &mut Vec<Paragraph>,
        cell_para_idx: usize,
        char_offset: usize,
        clip_paras: &[Paragraph],
    ) -> Result<(usize, usize), HwpError> {
        if cell_para_idx >= cell_paras.len() {
            return Err(HwpError::RenderError(format!(
                "셀 문단 {} 범위 초과",
                cell_para_idx
            )));
        }

        let split_offset = clipboard_split_offset(&cell_paras[cell_para_idx], char_offset);
        let right_half = cell_paras[cell_para_idx].split_at(split_offset);
        // 표만 복사한 경우 셀 본문 앞뒤와 같은 문단으로 합치지 않는다.
        // 별도 흐름 단위를 유지해야 표 높이가 확보되고 기존 글이 표와 겹치지 않는다.
        let standalone_table = matches!(clip_paras, [paragraph]
            if paragraph.text.is_empty() && matches!(paragraph.controls.as_slice(), [Control::Table(_)]));
        if standalone_table {
            let left = &cell_paras[cell_para_idx];
            let table_index = if left.text.is_empty() && left.controls.is_empty() {
                cell_paras[cell_para_idx] = clip_paras[0].clone();
                cell_para_idx
            } else {
                cell_paras.insert(cell_para_idx + 1, clip_paras[0].clone());
                cell_para_idx + 1
            };
            cell_paras.insert(table_index + 1, right_half);
            return Ok((table_index + 1, 0));
        }
        cell_paras[cell_para_idx].merge_from(&clip_paras[0]);

        let mut insert_idx = cell_para_idx + 1;
        for clip_para in clip_paras.iter().skip(1) {
            cell_paras.insert(insert_idx, clip_para.clone());
            insert_idx += 1;
        }

        let last_para_idx = insert_idx - 1;
        let merge_point =
            super::super::helpers::logical_paragraph_length(&cell_paras[last_para_idx]);
        cell_paras[last_para_idx].merge_from(&right_half);
        // 복사 위치의 vpos가 셀의 저장된 쪽 경계로 해석되지 않도록 삽입 원점에 맞춘다.
        let origin = cell_paras[cell_para_idx]
            .line_segs
            .first()
            .map_or(0, |seg| seg.vertical_pos);
        for paragraph in &mut cell_paras[cell_para_idx + 1..=last_para_idx] {
            let delta = origin
                - paragraph
                    .line_segs
                    .first()
                    .map_or(0, |seg| seg.vertical_pos);
            for segment in &mut paragraph.line_segs {
                segment.vertical_pos += delta;
            }
        }
        for para in &mut cell_paras[cell_para_idx..=last_para_idx] {
            if !para.field_ranges.is_empty() {
                rebuild_char_offsets(para);
            }
        }
        Ok((last_para_idx, merge_point))
    }

    /// 내부 클립보드의 내용을 표 셀 내부에 붙여넣는다.
    pub fn paste_internal_in_cell_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        char_offset: usize,
    ) -> Result<String, HwpError> {
        self.paste_internal_in_cell_by_path_native(
            section_idx,
            parent_para_idx,
            &[(control_idx, cell_idx, cell_para_idx)],
            char_offset,
        )
    }

    /// 내부 클립보드의 내용을 cellPath가 가리키는 중첩 표 셀에 붙여넣는다.
    pub fn paste_internal_in_cell_by_path_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        char_offset: usize,
    ) -> Result<String, HwpError> {
        let mut clip_paras = match &self.clipboard {
            Some(c) if !c.paragraphs.is_empty() => c.paragraphs.clone(),
            _ => return Ok("{\"ok\":false,\"error\":\"clipboard empty\"}".to_string()),
        };
        let contains_field = clipboard_paragraphs_contain_field(&clip_paras);
        self.renumber_pasted_field_ids(&mut clip_paras);
        if path.is_empty() {
            return Err(HwpError::RenderError("경로가 비어있습니다".to_string()));
        }

        if let Some((width, left, right)) =
            self.resolve_innermost_cell_metrics(section_idx, parent_para_idx, path)
        {
            let padding = (i32::from(left) + i32::from(right)).max(0) as u32;
            self.prepare_pasted_tables_for_cell(&mut clip_paras, width.saturating_sub(padding));
        }

        let cell_para_idx = path[path.len() - 1].2;
        let (last_para_idx, merge_point) = {
            let cell_paras =
                self.get_cell_paragraphs_mut_by_path(section_idx, parent_para_idx, path)?;
            Self::paste_paragraphs_into_cell_paragraphs(
                cell_paras,
                cell_para_idx,
                char_offset,
                &clip_paras,
            )?
        };

        // [#2825] flat 형제 paste_internal_in_cell_native 는 붙여넣기 직후
        // reflow_cell_paragraph 로 셀 폭 기준 재래핑을 하지만, path 버전은 이 호출이
        // 없어 깊이 ≥2 중첩 셀에 붙여넣은 문단이 이전 line_segs 를 그대로 유지했다.
        // #2755 가 delete/split/merge by_path 에 도입한 reflow_cell_paragraph_by_path
        // 를 붙여넣기 경로에도 동일하게 적용한다.
        for i in cell_para_idx..=last_para_idx {
            self.reflow_cell_paragraph_by_path(section_idx, parent_para_idx, path, i);
        }

        self.recalculate_cell_paragraph_vpos_by_path(
            section_idx,
            parent_para_idx,
            path,
            cell_para_idx,
            Some(cell_para_idx + 1),
        );

        let outer_ctrl = path[0].0;
        self.mark_cell_control_dirty(section_idx, parent_para_idx, outer_ctrl);
        self.document.sections[section_idx].raw_stream = None;
        // 문단 삽입 후 기존 셀 포인터의 줄/문단 인덱스 캐시는 재사용할 수 없다.
        self.layout_engine.clear_layout_caches();
        self.mark_section_dirty(section_idx);
        self.paginate_if_needed();

        self.event_log.push(DocumentEvent::ContentPasted {
            section: section_idx,
            para: parent_para_idx,
        });
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"cellParaIdx\":{},\"charOffset\":{},\"containsField\":{}",
            last_para_idx, merge_point, contains_field
        )))
    }

    /// 클립보드의 글자 모양(CharShape)을 삽입된 텍스트 범위에 적용한다.
    pub(crate) fn apply_clipboard_char_shapes(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        insert_offset: usize,
        clip_char_shapes: &[crate::model::paragraph::CharShapeRef],
        clip_char_offsets: &[u32],
        inserted_chars: usize,
    ) {
        Self::apply_clipboard_char_shapes_to_para(
            &mut self.document.sections[section_idx].paragraphs[para_idx],
            insert_offset,
            clip_char_shapes,
            clip_char_offsets,
            inserted_chars,
        );
    }

    /// 클립보드의 글자 모양을 특정 문단에 적용한다 (정적 메서드).
    pub(crate) fn apply_clipboard_char_shapes_to_para(
        para: &mut Paragraph,
        insert_offset: usize,
        clip_char_shapes: &[crate::model::paragraph::CharShapeRef],
        clip_char_offsets: &[u32],
        inserted_chars: usize,
    ) {
        if clip_char_shapes.is_empty() {
            return;
        }

        for i in 0..clip_char_shapes.len() {
            let cs = &clip_char_shapes[i];

            // UTF-16 위치를 char 인덱스로 변환
            let start_char_idx = clip_char_offsets
                .iter()
                .position(|&off| off >= cs.start_pos)
                .unwrap_or(0);

            let end_char_idx = if i + 1 < clip_char_shapes.len() {
                clip_char_offsets
                    .iter()
                    .position(|&off| off >= clip_char_shapes[i + 1].start_pos)
                    .unwrap_or(inserted_chars)
            } else {
                inserted_chars
            };

            if start_char_idx < end_char_idx && end_char_idx <= inserted_chars {
                para.apply_char_shape_range(
                    insert_offset + start_char_idx,
                    insert_offset + end_char_idx,
                    cs.char_shape_id,
                );
            }
        }
    }

    /// 내부 클립보드에 붙여넣기 가능한 개체 컨트롤(표/그림/도형)이 포함되어 있는지 확인한다.
    /// SectionDef, ColumnDef 등 구조적 컨트롤은 개체가 아니므로 제외한다.
    pub fn clipboard_has_control_native(&self) -> bool {
        self.clipboard
            .as_ref()
            .map(|c| {
                c.paragraphs
                    .first()
                    .map(|p| {
                        p.controls.iter().any(|ctrl| {
                            matches!(
                                ctrl,
                                Control::Table(_) | Control::Picture(_) | Control::Shape(_)
                            )
                        })
                    })
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    /// 단독 표/그림/도형의 개체 전용 붙여넣기가 가능한지 확인한다.
    pub fn clipboard_is_single_control_native(&self) -> bool {
        self.clipboard.as_ref().is_some_and(|clipboard| {
            clipboard.paragraphs.len() == 1
                && clipboard.paragraphs[0].text.is_empty()
                && clipboard.paragraphs[0].controls.len() == 1
                && matches!(
                    clipboard.paragraphs[0].controls[0],
                    Control::Table(_) | Control::Picture(_) | Control::Shape(_)
                )
        })
    }

    /// 내부 클립보드의 컨트롤 객체를 캐럿 위치에 붙여넣는다 (본문).
    ///
    /// 클립보드에 컨트롤이 없으면 `{"ok":false}` 반환.
    /// 반환값: JSON `{"ok":true,"paraIdx":<idx>,"controlIdx":0}`
    pub fn paste_control_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
    ) -> Result<String, HwpError> {
        // 클립보드에서 컨트롤 문단 확인
        let mut clip_para = match &self.clipboard {
            Some(c) => match c.paragraphs.first() {
                Some(p) if !p.controls.is_empty() => p.clone(),
                _ => return Ok("{\"ok\":false,\"error\":\"no control in clipboard\"}".to_string()),
            },
            None => return Ok("{\"ok\":false,\"error\":\"clipboard empty\"}".to_string()),
        };

        // [Task #1161] 떠 있는 개체(treat_as_char=false) 반복 붙여넣기 시 한컴처럼
        // cascade 오프셋을 누적해 동일 위치 겹침을 방지한다. inline(글자처럼 취급)은
        // 텍스트 흐름이 위치를 정하므로 제외(첫 붙여넣기부터 +1*step).
        {
            let cascade = self.paste_cascade_count.saturating_add(1);
            let common = match clip_para.controls.first_mut() {
                Some(Control::Picture(p)) if !p.common.treat_as_char => Some(&mut p.common),
                Some(Control::Shape(s)) if !s.common().treat_as_char => Some(s.common_mut()),
                _ => None,
            };
            if let Some(common) = common {
                let off = cascade.saturating_mul(PASTE_CASCADE_STEP_HU);
                common.vertical_offset = common.vertical_offset.saturating_add(off);
                common.horizontal_offset = common.horizontal_offset.saturating_add(off);
                self.paste_cascade_count = cascade;
            }
        }

        // 인덱스 검증
        if section_idx >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!(
                "구역 {} 범위 초과",
                section_idx
            )));
        }
        if para_idx >= self.document.sections[section_idx].paragraphs.len() {
            return Err(HwpError::RenderError(format!(
                "문단 {} 범위 초과",
                para_idx
            )));
        }

        self.document.sections[section_idx].raw_stream = None;

        // 커서 위치 문단의 속성 상속 (빈 문단 생성용) — 커서 offset 의 글자모양 기준.
        let current_para = &self.document.sections[section_idx].paragraphs[para_idx];
        let default_char_shape_id: u32 = current_para.char_shape_id_at(char_offset).unwrap_or(0);
        let default_para_shape_id: u16 = current_para.para_shape_id;

        // 편집 영역 폭
        let pd = &self.document.sections[section_idx].section_def.page_def;
        let content_width =
            (pd.width as i32 - pd.margin_left as i32 - pd.margin_right as i32).max(7200) as u32;

        // 삽입 위치 결정 (create_shape_control_native 패턴)
        let para = &self.document.sections[section_idx].paragraphs[para_idx];
        let is_empty_para = para.text.is_empty() && para.controls.is_empty();

        let insert_para_idx;
        // [Task #2299] 분할 삽입이면 우측 절반까지 신규 구간에 포함해야 한다.
        let mut did_split_for_control = false;
        if is_empty_para && char_offset == 0 {
            self.document.sections[section_idx].paragraphs[para_idx] = clip_para;
            insert_para_idx = para_idx;
        } else if char_offset == 0 && para.controls.is_empty() {
            self.document.sections[section_idx]
                .paragraphs
                .insert(para_idx, clip_para);
            self.insert_composed_paragraph(section_idx, para_idx);
            insert_para_idx = para_idx;
        } else {
            if char_offset > 0 && !para.text.is_empty() {
                did_split_for_control = true;
                let new_para =
                    self.document.sections[section_idx].paragraphs[para_idx].split_at(char_offset);
                self.document.sections[section_idx]
                    .paragraphs
                    .insert(para_idx + 1, new_para);
                self.insert_composed_paragraph(section_idx, para_idx + 1);
                self.document.sections[section_idx]
                    .paragraphs
                    .insert(para_idx + 1, clip_para);
                self.insert_composed_paragraph(section_idx, para_idx + 1);
                insert_para_idx = para_idx + 1;
            } else {
                self.document.sections[section_idx]
                    .paragraphs
                    .insert(para_idx + 1, clip_para);
                self.insert_composed_paragraph(section_idx, para_idx + 1);
                insert_para_idx = para_idx + 1;
            }
        }

        // 삽입된 문단의 line_segs 보정: 컨트롤 치수 반영
        // copy_control_native()에서 line_segs가 기본값(line_height:400, segment_width:0)으로
        // 하드코딩되므로, 실제 컨트롤 크기에 맞게 재설정한다.
        // (insert_picture_native 패턴: line_height=pic.height, segment_width=content_width)
        {
            let inserted = &mut self.document.sections[section_idx].paragraphs[insert_para_idx];
            let ctrl_height = inserted
                .controls
                .first()
                .map(|ctrl| match ctrl {
                    Control::Picture(pic) => pic.common.height as i32,
                    Control::Shape(shape) => shape.common().height as i32,
                    _ => 0,
                })
                .unwrap_or(0);
            if let Some(ls) = inserted.line_segs.first_mut() {
                ls.segment_width = content_width as i32;
                if ctrl_height > 0 {
                    ls.line_height = ctrl_height;
                    ls.text_height = ctrl_height;
                    ls.baseline_distance = (ctrl_height * 850) / 1000;
                    ls.line_spacing = 600;
                }
            }
        }

        // 컨트롤 아래에 빈 문단 추가 (HWP 표준)
        let mut empty_raw = vec![0u8; 10];
        empty_raw[0..2].copy_from_slice(&1u16.to_le_bytes());
        empty_raw[4..6].copy_from_slice(&1u16.to_le_bytes());
        let empty_para = Paragraph {
            text: String::new(),
            char_count: 1,
            char_count_msb: false,
            control_mask: 0,
            para_shape_id: default_para_shape_id,
            style_id: 0,
            char_shapes: vec![crate::model::paragraph::CharShapeRef {
                start_pos: 0,
                char_shape_id: default_char_shape_id,
            }],
            line_segs: vec![LineSeg {
                text_start: 0,
                line_height: 1000,
                text_height: 1000,
                baseline_distance: 850,
                line_spacing: 600,
                segment_width: content_width as i32,
                tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
                ..Default::default()
            }],
            has_para_text: false,
            raw_header_extra: empty_raw,
            ..Default::default()
        };
        self.document.sections[section_idx]
            .paragraphs
            .insert(insert_para_idx + 1, empty_para);
        self.insert_composed_paragraph(section_idx, insert_para_idx + 1);

        // [Task #2299] 신규 문단들(컨트롤 host·이웃 빈 문단·분할 우측)의 placeholder
        // vpos 를 흐름에 연결한다 — 방치하면 이후 편집의 vpos 재계산이 저장 단/쪽
        // 리셋으로 오인해 영구 고착시킨다. 분할 좌측은 높이가 바뀌어 reflow 한다.
        let fresh_end = insert_para_idx + 2 + usize::from(did_split_for_control);
        if did_split_for_control {
            // [Task #2299] 리셋 판별용 — reflow 이전 저장 흐름 end 캡처.
            let stored_end_for_reset = crate::renderer::composer::paragraph_flow_end(
                &self.document.sections[section_idx].paragraphs[para_idx],
            );
            self.reflow_paragraph(section_idx, para_idx);
        }
        let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
        crate::renderer::composer::recalculate_section_vpos(
            &mut self.document.sections[section_idx].paragraphs,
            para_idx,
            Some(insert_para_idx..fresh_end),
            None,
            &self.styles,
            self.dpi,
            doc_hwp3_layout,
        );

        // 리플로우 + 페이지네이션
        self.recompose_section(section_idx);
        self.paginate_if_needed();

        self.event_log.push(DocumentEvent::ContentPasted {
            section: section_idx,
            para: insert_para_idx,
        });
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"paraIdx\":{},\"controlIdx\":0",
            insert_para_idx
        )))
    }

    // === 클립보드 HTML 생성 ===

    /// 선택 영역을 HTML 문자열로 변환한다 (본문).
    pub fn export_selection_html_native(
        &self,
        section_idx: usize,
        start_para_idx: usize,
        start_char_offset: usize,
        end_para_idx: usize,
        end_char_offset: usize,
    ) -> Result<String, HwpError> {
        let mut paragraphs = Vec::new();
        self.append_body_range_to_clipboard(
            &mut paragraphs,
            section_idx,
            start_para_idx,
            start_char_offset,
            end_para_idx,
            end_char_offset,
        )?;
        Ok(self.clipboard_paragraphs_to_html(&paragraphs))
    }

    /// 여러 구역의 본문 선택을 하나의 HTML fragment로 문서 순서대로 내보낸다.
    pub fn export_selection_across_sections_html_native(
        &self,
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

        let mut paragraphs = Vec::new();
        for section_idx in start_section_idx..=end_section_idx {
            let section =
                self.document.sections.get(section_idx).ok_or_else(|| {
                    HwpError::RenderError(format!("구역 {} 범위 초과", section_idx))
                })?;
            if section.paragraphs.is_empty() {
                continue;
            }
            let range_start = if section_idx == start_section_idx {
                start_para_idx
            } else {
                0
            };
            let range_end = if section_idx == end_section_idx {
                end_para_idx
            } else {
                section.paragraphs.len() - 1
            };
            if range_start > range_end || range_end >= section.paragraphs.len() {
                return Err(HwpError::RenderError(format!(
                    "구역 {} 문단 범위 초과",
                    section_idx
                )));
            }
            let start = if section_idx == start_section_idx {
                start_char_offset
            } else {
                0
            };
            let end = if section_idx == end_section_idx {
                end_char_offset
            } else {
                super::super::helpers::logical_paragraph_length(&section.paragraphs[range_end])
            };
            self.append_body_range_to_clipboard(
                &mut paragraphs,
                section_idx,
                range_start,
                start,
                range_end,
                end,
            )?;
        }
        Ok(self.clipboard_paragraphs_to_html(&paragraphs))
    }

    /// 선택 영역을 HTML 문자열로 변환한다 (셀 내부).
    pub fn export_selection_in_cell_html_native(
        &self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        start_cell_para_idx: usize,
        start_char_offset: usize,
        end_cell_para_idx: usize,
        end_char_offset: usize,
    ) -> Result<String, HwpError> {
        self.export_selection_in_cell_by_path_html_native(
            section_idx,
            parent_para_idx,
            &[(control_idx, cell_idx, start_cell_para_idx)],
            start_cell_para_idx,
            start_char_offset,
            end_cell_para_idx,
            end_char_offset,
        )
    }

    /// 중첩 셀 선택의 텍스트와 개체를 HTML로 내보낸다.
    pub fn export_selection_in_cell_by_path_html_native(
        &self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        start_para_idx: usize,
        start_offset: usize,
        end_para_idx: usize,
        end_offset: usize,
    ) -> Result<String, HwpError> {
        let paragraphs = self.cell_selection_paragraphs(
            section_idx,
            parent_para_idx,
            path,
            start_para_idx,
            start_offset,
            end_para_idx,
            end_offset,
        )?;
        Ok(self.clipboard_paragraphs_to_html(&paragraphs))
    }

    fn clipboard_paragraphs_to_html(&self, paragraphs: &[Paragraph]) -> String {
        let mut html = String::from("<html><body>\n<!--StartFragment-->\n");
        for paragraph in paragraphs {
            html.push_str(&self.paragraph_to_html(paragraph, None, None));
            for control in &paragraph.controls {
                html.push_str(&self.control_to_html(control));
            }
            if paragraph.text.is_empty() && paragraph.controls.is_empty() {
                html.push_str("<p><br></p>\n");
            }
        }
        html.push_str("<!--EndFragment-->\n</body></html>");
        html
    }

    /// 컨트롤 객체를 HTML 문자열로 변환한다.
    pub fn export_control_html_native(
        &self,
        section_idx: usize,
        para_idx: usize,
        cell_path: &[(usize, usize, usize)],
        control_idx: usize,
    ) -> Result<String, HwpError> {
        // [Task #1161] cell_path 가 비면 본문, 아니면 셀/글상자 안 문단.
        let para = self.resolve_control_para(section_idx, para_idx, cell_path)?;
        let control = para
            .controls
            .get(control_idx)
            .ok_or_else(|| HwpError::RenderError(format!("컨트롤 {} 범위 초과", control_idx)))?;

        let mut html = String::from("<html><body>\n<!--StartFragment-->\n");
        html.push_str(&self.control_to_html(control));
        html.push_str("<!--EndFragment-->\n</body></html>");
        Ok(html)
    }

    /// 단일 문단을 HTML로 변환한다 (선택적 범위 지정).
    pub(crate) fn paragraph_to_html(
        &self,
        para: &Paragraph,
        start_offset: Option<usize>,
        end_offset: Option<usize>,
    ) -> String {
        let chars: Vec<char> = para.text.chars().collect();
        let start_idx = start_offset.unwrap_or(0).min(chars.len());
        let end_idx = end_offset.unwrap_or(chars.len()).min(chars.len());
        if start_idx >= end_idx {
            return String::new();
        }

        // 문단 스타일 CSS
        let para_css = self.para_style_to_css(para.para_shape_id);
        let mut html = format!("<p style=\"margin:0;{}\">\n", para_css);

        // CharShapeRef 경계에서 스타일이 바뀌는 지점을 찾아 span 분할
        let style_ranges = self.get_char_style_ranges(para, start_idx, end_idx);

        for (range_start, range_end, char_shape_id) in &style_ranges {
            let segment: String = chars[*range_start..*range_end]
                .iter()
                .filter(|c| !c.is_control() || **c == '\t')
                .collect();

            if segment.is_empty() {
                continue;
            }

            let css = self.char_style_to_css(*char_shape_id);
            html.push_str(&format!(
                "<span style=\"{}\">{}</span>",
                css,
                clipboard_escape_html(&segment)
            ));
        }

        html.push_str("</p>\n");
        html
    }

    /// 문단 내 char 인덱스 범위에서 CharShapeRef 경계를 기준으로 (start, end, char_shape_id) 목록을 반환한다.
    pub(crate) fn get_char_style_ranges(
        &self,
        para: &Paragraph,
        start_idx: usize,
        end_idx: usize,
    ) -> Vec<(usize, usize, u32)> {
        if para.char_shapes.is_empty() {
            return vec![(start_idx, end_idx, 0)];
        }

        // CharShapeRef의 start_pos (UTF-16) → char index 변환
        let mut boundaries: Vec<(usize, u32)> = Vec::new();
        for cs in &para.char_shapes {
            let char_idx = utf16_pos_to_char_idx(&para.char_offsets, cs.start_pos);
            boundaries.push((char_idx, cs.char_shape_id));
        }

        let mut ranges = Vec::new();
        for i in 0..boundaries.len() {
            let (bound_start, shape_id) = boundaries[i];
            let bound_end = if i + 1 < boundaries.len() {
                boundaries[i + 1].0
            } else {
                end_idx
            };

            // 범위와 교차하는 부분만 포함
            let rs = bound_start.max(start_idx);
            let re = bound_end.min(end_idx);
            if rs < re {
                ranges.push((rs, re, shape_id));
            }
        }

        // 시작점 이전에 스타일이 없으면 첫 CharShapeRef의 스타일 사용
        if ranges.is_empty() && !boundaries.is_empty() {
            let last_before = boundaries
                .iter()
                .rev()
                .find(|(idx, _)| *idx <= start_idx)
                .map(|(_, id)| *id)
                .unwrap_or(boundaries[0].1);
            ranges.push((start_idx, end_idx, last_before));
        }

        ranges
    }

    /// CharShape ID → CSS 인라인 스타일 문자열 변환.
    pub(crate) fn char_style_to_css(&self, char_shape_id: u32) -> String {
        let cs = match self.styles.char_styles.get(char_shape_id as usize) {
            Some(s) => s,
            None => return String::new(),
        };

        let mut css = String::new();

        // font-family (한국어 + 영어 폰트 목록)
        let mut fonts: Vec<&str> = Vec::new();
        if !cs.font_family.is_empty() {
            fonts.push(&cs.font_family);
        }
        if cs.font_families.len() > 1
            && !cs.font_families[1].is_empty()
            && cs.font_families[1] != cs.font_family
        {
            fonts.push(&cs.font_families[1]);
        }
        if !fonts.is_empty() {
            let font_list: Vec<String> = fonts
                .iter()
                .map(|f| format!("'{}'", clipboard_escape_html(f)))
                .collect();
            css.push_str(&format!("font-family:{};", font_list.join(",")));
        }

        // font-size (px → pt 변환: pt = px * 72 / 96)
        if cs.font_size > 0.0 {
            let pt = cs.font_size * 72.0 / self.dpi;
            css.push_str(&format!("font-size:{:.1}pt;", pt));
        }

        // font-weight / font-style
        if cs.bold {
            css.push_str("font-weight:bold;");
        }
        if cs.italic {
            css.push_str("font-style:italic;");
        }

        // color
        let color = clipboard_color_to_css(cs.text_color);
        css.push_str(&format!("color:{};", color));

        // text-decoration
        let has_underline = !matches!(cs.underline, crate::model::style::UnderlineType::None);
        if has_underline && cs.strikethrough {
            css.push_str("text-decoration:underline line-through;");
        } else if has_underline {
            css.push_str("text-decoration:underline;");
        } else if cs.strikethrough {
            css.push_str("text-decoration:line-through;");
        }

        // letter-spacing (0이 아닌 경우만)
        if cs.letter_spacing.abs() > 0.1 {
            css.push_str(&format!("letter-spacing:{:.1}px;", cs.letter_spacing));
        }

        css
    }

    /// ParaShape ID → CSS 인라인 스타일 문자열 변환.
    pub(crate) fn para_style_to_css(&self, para_shape_id: u16) -> String {
        let ps = match self.styles.para_styles.get(para_shape_id as usize) {
            Some(s) => s,
            None => return String::new(),
        };

        let mut css = String::new();

        // text-align
        let align = match ps.alignment {
            crate::model::style::Alignment::Left => "left",
            crate::model::style::Alignment::Right => "right",
            crate::model::style::Alignment::Center => "center",
            crate::model::style::Alignment::Justify => "justify",
            crate::model::style::Alignment::Distribute => "justify",
            crate::model::style::Alignment::Split => "justify",
        };
        css.push_str(&format!("text-align:{};", align));

        // margin-left / margin-right (px)
        if ps.margin_left > 0.1 {
            css.push_str(&format!("margin-left:{:.1}px;", ps.margin_left));
        }
        if ps.margin_right > 0.1 {
            css.push_str(&format!("margin-right:{:.1}px;", ps.margin_right));
        }

        // text-indent
        if ps.indent.abs() > 0.1 {
            css.push_str(&format!("text-indent:{:.1}px;", ps.indent));
        }

        // line-height
        match ps.line_spacing_type {
            crate::model::style::LineSpacingType::Percent => {
                css.push_str(&format!("line-height:{:.0}%;", ps.line_spacing));
            }
            crate::model::style::LineSpacingType::Fixed => {
                css.push_str(&format!("line-height:{:.1}px;", ps.line_spacing));
            }
            _ => {}
        }

        css
    }

    /// Control 객체를 HTML로 변환한다.
    pub(crate) fn control_to_html(&self, control: &Control) -> String {
        match control {
            Control::Table(table) => self.table_to_html(table),
            Control::Picture(pic) => self.picture_to_html(pic),
            _ => String::new(),
        }
    }

    /// Table 컨트롤을 HTML <table>로 변환한다.
    pub(crate) fn table_to_html(&self, table: &crate::model::table::Table) -> String {
        use crate::renderer::style_resolver::ResolvedBorderStyle;

        let mut html = String::from(
            "<table style=\"border-collapse:collapse;\" cellpadding=\"0\" cellspacing=\"0\">\n",
        );

        // 행별로 그룹화
        let max_row = table.cells.iter().map(|c| c.row).max().unwrap_or(0);
        for row in 0..=max_row {
            html.push_str("<tr>\n");
            let mut row_cells: Vec<&crate::model::table::Cell> =
                table.cells.iter().filter(|c| c.row == row).collect();
            row_cells.sort_by_key(|c| c.col);

            for cell in &row_cells {
                // 병합된 셀은 첫 번째 셀만 출력 (rowspan/colspan 은 merge 된 셀 정보)
                let mut td_style = String::new();

                // 셀 배경/테두리 (BorderFill)
                if cell.border_fill_id > 0 {
                    if let Some(bs) = self.styles.border_styles.get(cell.border_fill_id as usize) {
                        self.apply_border_fill_css(&mut td_style, bs);
                    }
                }

                // 셀 패딩
                td_style.push_str("padding:1px 5px;");

                // vertical-align
                td_style.push_str("vertical-align:top;");

                let mut td_attrs = format!("style=\"{}\"", td_style);
                if cell.col_span > 1 {
                    td_attrs.push_str(&format!(" colspan=\"{}\"", cell.col_span));
                }
                if cell.row_span > 1 {
                    td_attrs.push_str(&format!(" rowspan=\"{}\"", cell.row_span));
                }

                html.push_str(&format!("<td {}>\n", td_attrs));

                // 셀 내부 문단들
                for cpara in &cell.paragraphs {
                    html.push_str(&self.paragraph_to_html(cpara, None, None));
                    for control in &cpara.controls {
                        html.push_str(&self.control_to_html(control));
                    }
                }

                html.push_str("</td>\n");
            }
            html.push_str("</tr>\n");
        }

        html.push_str("</table>\n");
        html
    }

    /// BorderFill 스타일을 CSS로 변환하여 추가한다.
    pub(crate) fn apply_border_fill_css(
        &self,
        css: &mut String,
        bs: &crate::renderer::style_resolver::ResolvedBorderStyle,
    ) {
        // 배경색
        if let Some(fill_color) = bs.fill_color {
            if fill_color != 0xFFFFFF && fill_color != 0 {
                css.push_str(&format!(
                    "background-color:{};",
                    clipboard_color_to_css(fill_color)
                ));
            }
        }

        // 테두리 (좌, 우, 상, 하)
        let sides = ["left", "right", "top", "bottom"];
        for (i, side) in sides.iter().enumerate() {
            let bl = &bs.borders[i];
            if bl.width > 0 {
                let color = clipboard_color_to_css(bl.color);
                let px = (bl.width as f64).max(1.0);
                css.push_str(&format!("border-{}:{:.1}px solid {};", side, px, color));
            }
        }
    }

    /// Picture 컨트롤을 HTML <img>로 변환한다.
    pub(crate) fn picture_to_html(&self, pic: &crate::model::image::Picture) -> String {
        use base64::Engine;

        let bin_data_id = pic.image_attr.bin_data_id;
        if bin_data_id == 0 {
            return String::new();
        }

        // 이미지 데이터 찾기 (bin_data_id는 1-indexed 순번)
        let image_data = if bin_data_id > 0 {
            self.document
                .bin_data_content
                .get((bin_data_id - 1) as usize)
        } else {
            None
        };

        if let Some(bdc) = image_data {
            let bytes = bdc.data.load();
            let base64_data = base64::engine::general_purpose::STANDARD.encode(&bytes);
            let mime_type = detect_clipboard_image_mime(&bytes);

            // 크기 계산 (HWPUNIT → px)
            let w = crate::renderer::hwpunit_to_px(pic.common.width as i32, self.dpi);
            let h = crate::renderer::hwpunit_to_px(pic.common.height as i32, self.dpi);

            format!(
                "<img src=\"data:{};base64,{}\" width=\"{:.0}\" height=\"{:.0}\" />\n",
                mime_type, base64_data, w, h
            )
        } else {
            String::new()
        }
    }

    /// 컨트롤의 이미지 바이너리 데이터를 반환한다.
    /// Picture 컨트롤만 지원하며, 다른 타입은 에러를 반환한다.
    pub fn get_control_image_data_native(
        &self,
        section_idx: usize,
        para_idx: usize,
        cell_path: &[(usize, usize, usize)],
        control_idx: usize,
    ) -> Result<Vec<u8>, HwpError> {
        // [Task #1161] cell_path 가 비면 본문, 아니면 셀/글상자 안 문단.
        let para = self.resolve_control_para(section_idx, para_idx, cell_path)?;
        let control = para
            .controls
            .get(control_idx)
            .ok_or_else(|| HwpError::RenderError(format!("컨트롤 {} 범위 초과", control_idx)))?;

        let pic = match control {
            Control::Picture(p) => p,
            _ => {
                return Err(HwpError::RenderError(
                    "Picture 컨트롤이 아닙니다".to_string(),
                ))
            }
        };

        let bin_data_id = pic.image_attr.bin_data_id;
        if bin_data_id == 0 {
            return Err(HwpError::RenderError(
                "이미지 데이터 없음 (bin_data_id=0)".to_string(),
            ));
        }

        let bdc = self
            .document
            .bin_data_content
            .get((bin_data_id - 1) as usize)
            .ok_or_else(|| {
                HwpError::RenderError(format!("바이너리 데이터 {} 범위 초과", bin_data_id))
            })?;

        Ok(bdc.data.load())
    }

    /// 컨트롤의 이미지 MIME 타입을 반환한다.
    pub fn get_control_image_mime_native(
        &self,
        section_idx: usize,
        para_idx: usize,
        cell_path: &[(usize, usize, usize)],
        control_idx: usize,
    ) -> Result<String, HwpError> {
        // [Task #1161] cell_path 가 비면 본문, 아니면 셀/글상자 안 문단.
        let para = self.resolve_control_para(section_idx, para_idx, cell_path)?;
        let control = para
            .controls
            .get(control_idx)
            .ok_or_else(|| HwpError::RenderError(format!("컨트롤 {} 범위 초과", control_idx)))?;

        let pic = match control {
            Control::Picture(p) => p,
            _ => {
                return Err(HwpError::RenderError(
                    "Picture 컨트롤이 아닙니다".to_string(),
                ))
            }
        };

        let bin_data_id = pic.image_attr.bin_data_id;
        if bin_data_id == 0 {
            return Err(HwpError::RenderError(
                "이미지 데이터 없음 (bin_data_id=0)".to_string(),
            ));
        }

        let bdc = self
            .document
            .bin_data_content
            .get((bin_data_id - 1) as usize)
            .ok_or_else(|| {
                HwpError::RenderError(format!("바이너리 데이터 {} 범위 초과", bin_data_id))
            })?;

        Ok(detect_clipboard_image_mime(&bdc.data.load()).to_string())
    }

    /// BinData ID(1-based)로 이미지 바이너리 데이터를 반환한다.
    pub fn get_bin_data_image_data_native(&self, bin_data_id: u16) -> Result<Vec<u8>, HwpError> {
        if bin_data_id == 0 {
            return Err(HwpError::RenderError(
                "이미지 데이터 없음 (bin_data_id=0)".to_string(),
            ));
        }
        let bdc = self
            .document
            .bin_data_content
            .get((bin_data_id - 1) as usize)
            .ok_or_else(|| {
                HwpError::RenderError(format!("바이너리 데이터 {} 범위 초과", bin_data_id))
            })?;
        Ok(bdc.data.load())
    }

    /// BinData ID(1-based)로 이미지 MIME 타입을 반환한다.
    pub fn get_bin_data_image_mime_native(&self, bin_data_id: u16) -> Result<String, HwpError> {
        if bin_data_id == 0 {
            return Err(HwpError::RenderError(
                "이미지 데이터 없음 (bin_data_id=0)".to_string(),
            ));
        }
        let bdc = self
            .document
            .bin_data_content
            .get((bin_data_id - 1) as usize)
            .ok_or_else(|| {
                HwpError::RenderError(format!("바이너리 데이터 {} 범위 초과", bin_data_id))
            })?;
        Ok(detect_clipboard_image_mime(&bdc.data.load()).to_string())
    }

    // === 클립보드 HTML 붙여넣기 ===
}



//! 각주 내용 편집 관련 native 메서드

use super::super::helpers::{
    build_tab_def_from_json, json_has_border_keys, json_has_tab_keys, parse_char_shape_mods,
    parse_json_i16_array, parse_para_shape_mods,
};
use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::control::Control;
use crate::model::event::DocumentEvent;
use crate::model::paragraph::{ParaMeta, Paragraph};
use crate::renderer::composer::reflow_line_segs;

impl DocumentCore {
    /// 각주/미주 내부 문단의 글자 속성을 조회한다.
    pub fn get_char_properties_in_footnote_native(
        &self,
        section_idx: usize,
        para_idx: usize,
        control_idx: usize,
        fn_para_idx: usize,
        char_offset: usize,
    ) -> Result<String, HwpError> {
        let para = self
            .get_footnote_paragraph_ref(section_idx, para_idx, control_idx, fn_para_idx)
            .ok_or_else(|| HwpError::RenderError("각주/미주 문단을 찾을 수 없음".into()))?;
        Ok(self.build_char_properties_json(para, char_offset))
    }

    /// 각주/미주 문단에 run 보존 글자 서식을 적용한다.
    pub fn apply_char_format_in_footnote_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        control_idx: usize,
        fn_para_idx: usize,
        start_offset: usize,
        end_offset: usize,
        props_json: &str,
    ) -> Result<String, HwpError> {
        let mut mods = parse_char_shape_mods(props_json);
        if json_has_border_keys(props_json) {
            mods.border_fill_id = Some(self.create_border_fill_from_json(props_json));
        }
        let runs = self
            .get_footnote_paragraph_ref(section_idx, para_idx, control_idx, fn_para_idx)
            .ok_or_else(|| HwpError::RenderError("각주/미주 문단을 찾을 수 없음".into()))?
            .char_shape_runs_in_range(start_offset, end_offset);
        let applications = self.derive_char_shape_applications(runs, &mods);
        for (start, end, shape_id) in applications {
            self.get_footnote_paragraph_mut(section_idx, para_idx, control_idx, fn_para_idx)?
                .apply_char_shape_range(start, end, shape_id);
        }
        if super::formatting::char_shape_mods_affect_text_flow(&mods) {
            self.reflow_footnote_paragraph(section_idx, para_idx, control_idx, fn_para_idx);
        }
        self.document.sections[section_idx].raw_stream = None;
        // Newly-derived shapes are immediately addressable from doc_info, but
        // property queries and rendering resolve them through `styles`.
        // Rebuild just like body/cell/header formatting so the shape is visible
        // within the same command turn.
        self.rebuild_section(section_idx);
        self.event_log.push(DocumentEvent::CharFormatChanged {
            section: section_idx,
            para: para_idx,
            start: start_offset,
            end: end_offset,
        });
        Ok("{\"ok\":true}".to_string())
    }

    /// 각주/미주 글자 서식 undo/redo용 ID 직접 복원.
    pub fn set_char_shape_id_in_footnote_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        control_idx: usize,
        fn_para_idx: usize,
        start_offset: usize,
        end_offset: usize,
        char_shape_id: u32,
    ) -> Result<String, HwpError> {
        if char_shape_id as usize >= self.document.doc_info.char_shapes.len() {
            return Err(HwpError::RenderError("글자 모양 ID 범위 초과".into()));
        }
        self.get_footnote_paragraph_mut(section_idx, para_idx, control_idx, fn_para_idx)?
            .apply_char_shape_range(start_offset, end_offset, char_shape_id);
        self.reflow_footnote_paragraph(section_idx, para_idx, control_idx, fn_para_idx);
        self.document.sections[section_idx].raw_stream = None;
        self.rebuild_section(section_idx);
        self.event_log.push(DocumentEvent::CharFormatChanged {
            section: section_idx,
            para: para_idx,
            start: start_offset,
            end: end_offset,
        });
        Ok("{\"ok\":true}".to_string())
    }

    /// 각주/미주 문단 모양 undo/redo용 ID 직접 복원.
    pub fn set_para_shape_id_in_footnote_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        control_idx: usize,
        fn_para_idx: usize,
        para_shape_id: u16,
    ) -> Result<String, HwpError> {
        if para_shape_id as usize >= self.document.doc_info.para_shapes.len() {
            return Err(HwpError::RenderError("문단 모양 ID 범위 초과".into()));
        }
        self.get_footnote_paragraph_mut(section_idx, para_idx, control_idx, fn_para_idx)?
            .para_shape_id = para_shape_id;
        self.reflow_footnote_paragraph(section_idx, para_idx, control_idx, fn_para_idx);
        self.document.sections[section_idx].raw_stream = None;
        self.mark_section_dirty(section_idx);
        self.paginate_if_needed();
        self.event_log.push(DocumentEvent::ParaFormatChanged {
            section: section_idx,
            para: para_idx,
        });
        Ok("{\"ok\":true}".to_string())
    }

    fn renumber_footnotes_in_section(&mut self, section_idx: usize) {
        let mut number = 1u16;
        for para in &mut self.document.sections[section_idx].paragraphs {
            for ctrl in &mut para.controls {
                match ctrl {
                    Control::Footnote(footnote) => {
                        footnote.number = number;
                        number += 1;
                    }
                    Control::Endnote(endnote) => {
                        endnote.number = number;
                        number += 1;
                    }
                    Control::Table(table) => {
                        for cell in &mut table.cells {
                            for cell_para in &mut cell.paragraphs {
                                for cell_ctrl in &mut cell_para.controls {
                                    match cell_ctrl {
                                        Control::Footnote(footnote) => {
                                            footnote.number = number;
                                            number += 1;
                                        }
                                        Control::Endnote(endnote) => {
                                            endnote.number = number;
                                            number += 1;
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                    }
                    Control::Shape(shape) => {
                        if let Some(text_box) =
                            shape.drawing_mut().and_then(|d| d.text_box.as_mut())
                        {
                            for text_para in &mut text_box.paragraphs {
                                for text_ctrl in &mut text_para.controls {
                                    match text_ctrl {
                                        Control::Footnote(footnote) => {
                                            footnote.number = number;
                                            number += 1;
                                        }
                                        Control::Endnote(endnote) => {
                                            endnote.number = number;
                                            number += 1;
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    /// 본문 커서 위치의 각주 마커를 조회한다.
    ///
    /// direction:
    /// - "backward": 커서 바로 앞 마커(Backspace)
    /// - "forward": 커서 바로 뒤 마커(Delete)
    pub fn get_footnote_at_cursor_native(
        &self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
        direction: &str,
    ) -> Result<String, HwpError> {
        if direction != "backward" && direction != "forward" {
            return Err(HwpError::RenderError(format!(
                "지원하지 않는 각주 조회 방향입니다: {}",
                direction
            )));
        }

        let section = self.document.sections.get(section_idx).ok_or_else(|| {
            HwpError::RenderError(format!("구역 인덱스 {} 범위 초과", section_idx))
        })?;
        let para = section
            .paragraphs
            .get(para_idx)
            .ok_or_else(|| HwpError::RenderError(format!("문단 인덱스 {} 범위 초과", para_idx)))?;

        let positions = crate::document_core::helpers::find_control_text_positions(para);
        for (control_idx, ctrl) in para.controls.iter().enumerate() {
            let number = match ctrl {
                Control::Footnote(footnote) => footnote.number,
                Control::Endnote(endnote) => endnote.number,
                _ => continue,
            };
            let Some(marker_pos) = positions.get(control_idx).copied() else {
                continue;
            };
            let matches_cursor = match direction {
                "backward" => char_offset == marker_pos + 1,
                "forward" => char_offset == marker_pos,
                _ => false,
            };
            if matches_cursor {
                return Ok(format!(
                    "{{\"hit\":true,\"sectionIndex\":{},\"paragraphIndex\":{},\"controlIndex\":{},\"charOffset\":{},\"footnoteNumber\":{}}}",
                    section_idx,
                    para_idx,
                    control_idx,
                    marker_pos,
                    number,
                ));
            }
        }

        Ok("{\"hit\":false}".to_string())
    }

    /// 본문 각주 컨트롤을 삭제한다.
    ///
    /// 각주 내부 내용과 본문 마커를 함께 제거하고, 남은 각주 번호를 문서 순서대로 재계산한다.
    pub fn delete_footnote_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        control_idx: usize,
    ) -> Result<String, HwpError> {
        let (marker_pos, deleted_number) = {
            let section = self.document.sections.get(section_idx).ok_or_else(|| {
                HwpError::RenderError(format!("구역 인덱스 {} 범위 초과", section_idx))
            })?;
            let para = section.paragraphs.get(para_idx).ok_or_else(|| {
                HwpError::RenderError(format!("문단 인덱스 {} 범위 초과", para_idx))
            })?;
            let ctrl = para.controls.get(control_idx).ok_or_else(|| {
                HwpError::RenderError(format!("컨트롤 인덱스 {} 범위 초과", control_idx))
            })?;
            let number = match ctrl {
                Control::Footnote(footnote) => footnote.number,
                Control::Endnote(endnote) => endnote.number,
                _ => {
                    return Err(HwpError::RenderError(format!(
                        "컨트롤 {}은 각주/미주가 아닙니다",
                        control_idx
                    )));
                }
            };
            let positions = crate::document_core::helpers::find_control_text_positions(para);
            let marker_pos = positions.get(control_idx).copied().ok_or_else(|| {
                HwpError::RenderError(format!(
                    "각주 컨트롤 {}의 본문 위치를 찾을 수 없습니다",
                    control_idx
                ))
            })?;
            (marker_pos, number)
        };

        {
            let section = &mut self.document.sections[section_idx];
            let para = &mut section.paragraphs[para_idx];

            para.authored_text_runs = None;
            para.para_text_terminal = None;
            let marker_utf16_pos = para.char_offsets.get(marker_pos).copied().unwrap_or(0);
            for offset in para.char_offsets.iter_mut().skip(marker_pos) {
                if *offset >= 8 {
                    *offset -= 8;
                }
            }
            // char_shapes/range_tags 도 char_offsets 와 함께 되돌린다 — 삽입 경로
            // (shift_for_inline_control_insert)와 대칭되는 삭제측 시프트가 없으면
            // 삭제 지점 이후 글자모양 run·range_tag 경계가 텍스트와 어긋난다.
            for cs in &mut para.char_shapes {
                if cs.start_pos > marker_utf16_pos {
                    cs.start_pos = cs.start_pos.saturating_sub(8);
                }
            }
            for rt in &mut para.range_tags {
                if rt.start >= marker_utf16_pos {
                    rt.start = rt.start.saturating_sub(8);
                }
                if rt.end >= marker_utf16_pos {
                    rt.end = rt.end.saturating_sub(8);
                }
            }

            para.controls.remove(control_idx);
            if control_idx < para.ctrl_data_records.len() {
                para.ctrl_data_records.remove(control_idx);
            }
            for range in &mut para.field_ranges {
                if range.control_idx > control_idx {
                    range.control_idx -= 1;
                }
            }
            if para.char_count >= 8 {
                para.char_count -= 8;
            }
            if !para
                .controls
                .iter()
                .any(|c| matches!(c, Control::Footnote(_) | Control::Endnote(_)))
            {
                para.control_mask &= !(1u32 << 0x0011);
            }

            Self::reflow_paragraph_line_segs_after_control_delete(para, &self.styles, self.dpi);
            section.raw_stream = None;
        }

        self.renumber_footnotes_in_section(section_idx);
        self.mark_section_dirty(section_idx);
        self.recompose_section(section_idx);
        self.paginate_if_needed();
        self.invalidate_page_tree_cache();

        self.event_log.push(DocumentEvent::FootnoteDeleted {
            section: section_idx,
            para: para_idx,
            ctrl: control_idx,
        });

        Ok(format!(
            "{{\"ok\":true,\"sectionIndex\":{},\"paragraphIndex\":{},\"controlIndex\":{},\"charOffset\":{},\"deletedNumber\":{}}}",
            section_idx,
            para_idx,
            control_idx,
            marker_pos,
            deleted_number,
        ))
    }

    /// 각주 컨트롤 내부 문단의 가변 참조를 얻는다.
    fn get_footnote_paragraph_mut(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        control_idx: usize,
        fn_para_idx: usize,
    ) -> Result<&mut Paragraph, HwpError> {
        let section = self.document.sections.get_mut(section_idx).ok_or_else(|| {
            HwpError::RenderError(format!("구역 인덱스 {} 범위 초과", section_idx))
        })?;
        let para = section
            .paragraphs
            .get_mut(para_idx)
            .ok_or_else(|| HwpError::RenderError(format!("문단 인덱스 {} 범위 초과", para_idx)))?;
        let ctrl = para.controls.get_mut(control_idx).ok_or_else(|| {
            HwpError::RenderError(format!("컨트롤 인덱스 {} 범위 초과", control_idx))
        })?;
        match ctrl {
            Control::Footnote(f) => {
                let len = f.paragraphs.len();
                if fn_para_idx >= len {
                    return Err(HwpError::RenderError(format!(
                        "각주 문단 인덱스 {} 범위 초과 (총 {}개)",
                        fn_para_idx, len
                    )));
                }
                Ok(&mut f.paragraphs[fn_para_idx])
            }
            Control::Endnote(e) => {
                let len = e.paragraphs.len();
                if fn_para_idx >= len {
                    return Err(HwpError::RenderError(format!(
                        "미주 문단 인덱스 {} 범위 초과 (총 {}개)",
                        fn_para_idx, len
                    )));
                }
                Ok(&mut e.paragraphs[fn_para_idx])
            }
            _ => Err(HwpError::RenderError(format!(
                "컨트롤 {}은 각주/미주가 아닙니다",
                control_idx
            ))),
        }
    }

    /// 각주 컨트롤 내부 문단의 불변 참조를 얻는다.
    fn get_footnote_paragraph_ref(
        &self,
        section_idx: usize,
        para_idx: usize,
        control_idx: usize,
        fn_para_idx: usize,
    ) -> Option<&Paragraph> {
        let section = self.document.sections.get(section_idx)?;
        let para = section.paragraphs.get(para_idx)?;
        let ctrl = para.controls.get(control_idx)?;
        match ctrl {
            Control::Footnote(f) => f.paragraphs.get(fn_para_idx),
            Control::Endnote(e) => e.paragraphs.get(fn_para_idx),
            _ => None,
        }
    }

    /// 각주/미주 문단 재래핑 폭(px). 편집 reflow 와 lineseg 오라클이 공유한다.
    ///
    /// 한컴은 주석을 단 폭으로 조판한다 (2단 시험지 미주: 쪽 본문 54426 이 아니라 단 폭
    /// 26788 로 저장). 각주 `통단으로 배열` 만 본문 전체 폭을 쓴다. 단 폭은 본문 문단과
    /// 같이 4 HWPUNIT 격자로 내리고 문단 좌우 여백을 뺀다. 단은 주석이 달린 본문 문단의
    /// 단(다단 정의·페이지네이션 단 번호)이다.
    pub(crate) fn note_reflow_width(
        &self,
        section_idx: usize,
        para_idx: usize,
        is_footnote: bool,
        para_shape_id: u16,
    ) -> f64 {
        let section = &self.document.sections[section_idx];
        let column_def = Self::find_column_def_for_paragraph(&section.paragraphs, para_idx);
        let col_idx = self
            .para_column_map
            .get(section_idx)
            .and_then(|m| m.get(para_idx))
            .copied()
            .unwrap_or(0) as usize;
        Self::note_line_width_px(
            &section.section_def,
            &column_def,
            col_idx,
            is_footnote,
            para_shape_id,
            &self.styles,
            self.dpi,
        )
    }

    /// [`Self::note_reflow_width`] 의 엔진 상태 없는 본체 — 로드 합성도 쓴다 (단 번호를
    /// 아직 모르는 로드 시점은 첫 단).
    pub(crate) fn note_line_width_px(
        section_def: &crate::model::document::SectionDef,
        column_def: &crate::model::page::ColumnDef,
        col_idx: usize,
        is_footnote: bool,
        para_shape_id: u16,
        styles: &crate::renderer::style_resolver::ResolvedStyleSet,
        dpi: f64,
    ) -> f64 {
        use crate::model::footnote::FootnotePlacement;
        use crate::renderer::page_layout::PageLayoutInfo;
        let layout = PageLayoutInfo::from_page_def(&section_def.page_def, column_def, dpi);
        let across =
            is_footnote && section_def.footnote_shape.placement == FootnotePlacement::BelowText;
        let area_px = if across {
            layout.body_area.width
        } else {
            layout
                .column_areas
                .get(col_idx)
                .or(layout.column_areas.first())
                .map_or(layout.body_area.width, |a| a.width)
        };
        Self::column_line_width_px(area_px, para_shape_id, styles, dpi)
    }

    /// 각주 문단 리플로우
    pub(crate) fn reflow_footnote_paragraph(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        control_idx: usize,
        fn_para_idx: usize,
    ) {
        let Some(para_shape_id) = self
            .get_footnote_paragraph_ref(section_idx, para_idx, control_idx, fn_para_idx)
            .map(|p| p.para_shape_id)
        else {
            return;
        };
        let is_footnote = matches!(
            self.document.sections[section_idx].paragraphs[para_idx].controls[control_idx],
            Control::Footnote(_)
        );
        let final_width = self.note_reflow_width(section_idx, para_idx, is_footnote, para_shape_id);

        // 가변 참조로 리플로우 실행
        let section = &mut self.document.sections[section_idx];
        let ctrl = &mut section.paragraphs[para_idx].controls[control_idx];
        match ctrl {
            Control::Footnote(f) => {
                if let Some(para) = f.paragraphs.get_mut(fn_para_idx) {
                    reflow_line_segs(para, final_width, &self.styles, self.dpi);
                }
            }
            Control::Endnote(e) => {
                if let Some(para) = e.paragraphs.get_mut(fn_para_idx) {
                    reflow_line_segs(para, final_width, &self.styles, self.dpi);
                }
            }
            _ => {}
        }
    }

    /// 각주/미주 내부 문단 속성 조회.
    pub fn get_para_properties_in_footnote_native(
        &self,
        section_idx: usize,
        para_idx: usize,
        control_idx: usize,
        fn_para_idx: usize,
    ) -> Result<String, HwpError> {
        let para = self
            .get_footnote_paragraph_ref(section_idx, para_idx, control_idx, fn_para_idx)
            .ok_or_else(|| {
                HwpError::RenderError(format!(
                    "각주/미주 문단을 찾을 수 없습니다: sec={} para={} ctrl={} fn_para={}",
                    section_idx, para_idx, control_idx, fn_para_idx
                ))
            })?;
        Ok(self.build_para_properties_json(para.para_shape_id, section_idx))
    }

    /// 각주/미주 내부 문단 속성 적용.
    pub fn apply_para_format_in_footnote_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        control_idx: usize,
        fn_para_idx: usize,
        props_json: &str,
    ) -> Result<String, HwpError> {
        let mut mods = parse_para_shape_mods(props_json);

        if json_has_tab_keys(props_json) {
            let para = self
                .get_footnote_paragraph_ref(section_idx, para_idx, control_idx, fn_para_idx)
                .ok_or_else(|| {
                    HwpError::RenderError("각주/미주 문단을 찾을 수 없음".to_string())
                })?;
            let base_tab_def_id = self
                .document
                .doc_info
                .para_shapes
                .get(para.para_shape_id as usize)
                .map(|ps| ps.tab_def_id)
                .unwrap_or(0);
            let new_td = build_tab_def_from_json(
                props_json,
                base_tab_def_id,
                &self.document.doc_info.tab_defs,
            );
            let new_tab_id = self.document.find_or_create_tab_def(new_td);
            mods.tab_def_id = Some(new_tab_id);
        }

        if json_has_border_keys(props_json) {
            let bf_id = self.create_border_fill_from_json(props_json);
            mods.border_fill_id = Some(bf_id);
        }
        if let Some(arr) = parse_json_i16_array(props_json, "borderSpacing", 4) {
            mods.border_spacing = Some([arr[0], arr[1], arr[2], arr[3]]);
        }

        let base_id = self
            .get_footnote_paragraph_ref(section_idx, para_idx, control_idx, fn_para_idx)
            .ok_or_else(|| HwpError::RenderError("각주/미주 문단을 찾을 수 없음".to_string()))?
            .para_shape_id;
        let new_id = self.document.find_or_create_para_shape(base_id, &mods);
        {
            let fn_para =
                self.get_footnote_paragraph_mut(section_idx, para_idx, control_idx, fn_para_idx)?;
            fn_para.para_shape_id = new_id;
        }

        self.reflow_footnote_paragraph(section_idx, para_idx, control_idx, fn_para_idx);

        self.document.sections[section_idx].raw_stream = None;
        self.rebuild_section(section_idx);
        self.event_log.push(DocumentEvent::ParaFormatChanged {
            section: section_idx,
            para: para_idx,
        });
        Ok("{\"ok\":true}".to_string())
    }

    /// 각주 문단 정보를 반환한다.
    /// JSON: `{"ok":true,"paraCount":N,"textLen":N,"text":"..."}`
    pub fn get_footnote_info_native(
        &self,
        section_idx: usize,
        para_idx: usize,
        control_idx: usize,
    ) -> Result<String, HwpError> {
        let section = self.document.sections.get(section_idx).ok_or_else(|| {
            HwpError::RenderError(format!("구역 인덱스 {} 범위 초과", section_idx))
        })?;
        let para = section
            .paragraphs
            .get(para_idx)
            .ok_or_else(|| HwpError::RenderError(format!("문단 인덱스 {} 범위 초과", para_idx)))?;
        let ctrl = para.controls.get(control_idx).ok_or_else(|| {
            HwpError::RenderError(format!("컨트롤 인덱스 {} 범위 초과", control_idx))
        })?;
        match ctrl {
            Control::Footnote(f) => {
                let para_count = f.paragraphs.len();
                let texts: Vec<String> = f
                    .paragraphs
                    .iter()
                    .map(|p| p.text.replace('\\', "\\\\").replace('"', "\\\""))
                    .collect();
                let total_len: usize = f.paragraphs.iter().map(|p| p.text.chars().count()).sum();
                Ok(format!(
                    "{{\"ok\":true,\"paraCount\":{},\"totalTextLen\":{},\"number\":{},\"texts\":[{}]}}",
                    para_count,
                    total_len,
                    f.number,
                    texts.iter().map(|t| format!("\"{}\"", t)).collect::<Vec<_>>().join(","),
                ))
            }
            Control::Endnote(e) => {
                let para_count = e.paragraphs.len();
                let texts: Vec<String> = e
                    .paragraphs
                    .iter()
                    .map(|p| p.text.replace('\\', "\\\\").replace('"', "\\\""))
                    .collect();
                let total_len: usize = e.paragraphs.iter().map(|p| p.text.chars().count()).sum();
                Ok(format!(
                    "{{\"ok\":true,\"paraCount\":{},\"totalTextLen\":{},\"number\":{},\"texts\":[{}]}}",
                    para_count,
                    total_len,
                    e.number,
                    texts.iter().map(|t| format!("\"{}\"", t)).collect::<Vec<_>>().join(","),
                ))
            }
            _ => Err(HwpError::RenderError(format!(
                "컨트롤 {}은 각주/미주가 아닙니다",
                control_idx
            ))),
        }
    }

    /// 각주 내 텍스트 삽입
    pub fn insert_text_in_footnote_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        control_idx: usize,
        fn_para_idx: usize,
        char_offset: usize,
        text: &str,
    ) -> Result<String, HwpError> {
        self.insert_text_in_footnote_with_content_impl(
            section_idx,
            para_idx,
            control_idx,
            fn_para_idx,
            char_offset,
            text,
            None,
        )
    }

    pub fn insert_text_content_in_footnote_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        control_idx: usize,
        fn_para_idx: usize,
        char_offset: usize,
        content: &crate::model::paragraph::TextContent,
    ) -> Result<String, HwpError> {
        content
            .validate()
            .map_err(|error| HwpError::RenderError(error.to_string()))?;
        self.insert_text_in_footnote_with_content_impl(
            section_idx,
            para_idx,
            control_idx,
            fn_para_idx,
            char_offset,
            &content.text,
            Some(content),
        )
    }

    fn insert_text_in_footnote_with_content_impl(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        control_idx: usize,
        fn_para_idx: usize,
        char_offset: usize,
        text: &str,
        content: Option<&crate::model::paragraph::TextContent>,
    ) -> Result<String, HwpError> {
        let new_chars_count = text.chars().count();
        let fn_para =
            self.get_footnote_paragraph_mut(section_idx, para_idx, control_idx, fn_para_idx)?;
        let inserted_at = fn_para.insert_text_at(char_offset, text);
        if let Some(content) = content {
            fn_para.restore_inserted_origins(inserted_at, content);
        }

        self.reflow_footnote_paragraph(section_idx, para_idx, control_idx, fn_para_idx);

        self.document.sections[section_idx].raw_stream = None;
        self.mark_section_dirty(section_idx);
        self.paginate_if_needed();

        let new_offset = inserted_at + new_chars_count;
        self.event_log.push(DocumentEvent::TextInserted {
            section: section_idx,
            para: para_idx,
            offset: inserted_at,
            len: new_chars_count,
        });
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"charOffset\":{}",
            new_offset
        )))
    }

    /// 각주 내 텍스트 삭제
    pub fn delete_text_in_footnote_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        control_idx: usize,
        fn_para_idx: usize,
        char_offset: usize,
        count: usize,
    ) -> Result<String, HwpError> {
        let fn_para =
            self.get_footnote_paragraph_mut(section_idx, para_idx, control_idx, fn_para_idx)?;
        // [Task #2337] undo 재삽입용 삭제 텍스트 확보 (HF 와 동일 방식 — char 슬라이스로
        // delete_text_at 클램핑과 동일 범위). 역연산 삭제 커맨드가 사용한다.
        let actual_offset = char_offset.min(fn_para.text.chars().count());
        let removed_content = fn_para.capture_text_content(actual_offset, count);
        let deleted_text = removed_content.text.clone();
        fn_para.delete_text_at(actual_offset, count);

        self.reflow_footnote_paragraph(section_idx, para_idx, control_idx, fn_para_idx);

        self.document.sections[section_idx].raw_stream = None;
        self.mark_section_dirty(section_idx);
        self.paginate_if_needed();

        self.event_log.push(DocumentEvent::TextDeleted {
            section: section_idx,
            para: para_idx,
            offset: actual_offset,
            count: deleted_text.chars().count(),
        });
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"charOffset\":{},\"deletedText\":\"{}\",{}",
            actual_offset,
            super::super::helpers::json_escape(&deleted_text),
            super::super::helpers::removed_content_fields(actual_offset, &removed_content)
        )))
    }

    /// 각주 내 문단 분할 (Enter 키)
    pub fn split_paragraph_in_footnote_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        control_idx: usize,
        fn_para_idx: usize,
        char_offset: usize,
        restore_meta: Option<ParaMeta>,
    ) -> Result<String, HwpError> {
        // 문단 분할
        let mut new_para = {
            let section = self.document.sections.get_mut(section_idx).ok_or_else(|| {
                HwpError::RenderError(format!("구역 인덱스 {} 범위 초과", section_idx))
            })?;
            let para = section.paragraphs.get_mut(para_idx).ok_or_else(|| {
                HwpError::RenderError(format!("문단 인덱스 {} 범위 초과", para_idx))
            })?;
            let ctrl = para.controls.get_mut(control_idx).ok_or_else(|| {
                HwpError::RenderError(format!("컨트롤 인덱스 {} 범위 초과", control_idx))
            })?;
            match ctrl {
                Control::Footnote(f) => {
                    if fn_para_idx >= f.paragraphs.len() {
                        return Err(HwpError::RenderError(format!(
                            "각주 문단 인덱스 {} 범위 초과",
                            fn_para_idx
                        )));
                    }
                    f.paragraphs[fn_para_idx].split_at(char_offset)
                }
                Control::Endnote(e) => {
                    if fn_para_idx >= e.paragraphs.len() {
                        return Err(HwpError::RenderError(format!(
                            "미주 문단 인덱스 {} 범위 초과",
                            fn_para_idx
                        )));
                    }
                    e.paragraphs[fn_para_idx].split_at(char_offset)
                }
                _ => {
                    return Err(HwpError::RenderError(
                        "컨트롤이 각주/미주가 아닙니다".to_string(),
                    ))
                }
            }
        };
        if let Some(meta) = restore_meta {
            new_para.apply_meta(meta);
        }

        // 새 문단 삽입
        let new_para_idx = fn_para_idx + 1;
        {
            let ctrl =
                &mut self.document.sections[section_idx].paragraphs[para_idx].controls[control_idx];
            match ctrl {
                Control::Footnote(f) => f.paragraphs.insert(new_para_idx, new_para),
                Control::Endnote(e) => e.paragraphs.insert(new_para_idx, new_para),
                _ => {}
            }
        }

        // 리플로우
        self.reflow_footnote_paragraph(section_idx, para_idx, control_idx, fn_para_idx);
        self.reflow_footnote_paragraph(section_idx, para_idx, control_idx, new_para_idx);

        self.document.sections[section_idx].raw_stream = None;
        self.mark_section_dirty(section_idx);
        self.paginate_if_needed();

        self.event_log.push(DocumentEvent::ParagraphSplit {
            section: section_idx,
            para: para_idx,
            offset: char_offset,
        });
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"fnParaIndex\":{},\"charOffset\":0",
            new_para_idx
        )))
    }

    /// 각주 내 문단 병합 (Backspace at start)
    pub fn merge_paragraph_in_footnote_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        control_idx: usize,
        fn_para_idx: usize,
    ) -> Result<String, HwpError> {
        if fn_para_idx == 0 {
            return Err(HwpError::RenderError(
                "첫 번째 문단은 이전 문단과 병합할 수 없습니다".to_string(),
            ));
        }

        let merge_offset;
        let removed_meta;
        {
            let section = self.document.sections.get_mut(section_idx).ok_or_else(|| {
                HwpError::RenderError(format!("구역 인덱스 {} 범위 초과", section_idx))
            })?;
            let para = section.paragraphs.get_mut(para_idx).ok_or_else(|| {
                HwpError::RenderError(format!("문단 인덱스 {} 범위 초과", para_idx))
            })?;
            let ctrl = para.controls.get_mut(control_idx).ok_or_else(|| {
                HwpError::RenderError(format!("컨트롤 인덱스 {} 범위 초과", control_idx))
            })?;
            match ctrl {
                Control::Footnote(f) => {
                    if fn_para_idx >= f.paragraphs.len() {
                        return Err(HwpError::RenderError(format!(
                            "각주 문단 인덱스 {} 범위 초과",
                            fn_para_idx
                        )));
                    }
                    merge_offset = f.paragraphs[fn_para_idx - 1].text.chars().count();
                    let removed = f.paragraphs.remove(fn_para_idx);
                    removed_meta =
                        super::super::helpers::removed_para_meta_field(&removed.capture_meta());
                    f.paragraphs[fn_para_idx - 1].merge_from(&removed);
                }
                Control::Endnote(e) => {
                    if fn_para_idx >= e.paragraphs.len() {
                        return Err(HwpError::RenderError(format!(
                            "미주 문단 인덱스 {} 범위 초과",
                            fn_para_idx
                        )));
                    }
                    merge_offset = e.paragraphs[fn_para_idx - 1].text.chars().count();
                    let removed = e.paragraphs.remove(fn_para_idx);
                    removed_meta =
                        super::super::helpers::removed_para_meta_field(&removed.capture_meta());
                    e.paragraphs[fn_para_idx - 1].merge_from(&removed);
                }
                _ => {
                    return Err(HwpError::RenderError(
                        "컨트롤이 각주/미주가 아닙니다".to_string(),
                    ))
                }
            }
        }

        let prev_idx = fn_para_idx - 1;
        self.reflow_footnote_paragraph(section_idx, para_idx, control_idx, prev_idx);

        self.document.sections[section_idx].raw_stream = None;
        self.mark_section_dirty(section_idx);
        self.paginate_if_needed();

        self.event_log.push(DocumentEvent::ParagraphMerged {
            section: section_idx,
            para: para_idx,
        });
        Ok(super::super::helpers::json_ok_with(&format!(
            "\"fnParaIndex\":{},\"charOffset\":{}{}",
            prev_idx, merge_offset, removed_meta
        )))
    }
}



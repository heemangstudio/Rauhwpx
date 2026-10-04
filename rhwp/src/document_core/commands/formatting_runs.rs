//! #6788: 문자 단위 모양 구간 조회와 원자적 문단 복원.

use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::event::DocumentEvent;
use crate::model::paragraph::{CharShapeRun, Paragraph};

fn range_error(detail: impl std::fmt::Display) -> HwpError {
    HwpError::RenderError(format!("글자 모양 구간: {detail}"))
}

fn para_char_len(para: &Paragraph) -> usize {
    para.char_offsets.len()
}

fn validate_range(para: &Paragraph, start: usize, end: usize) -> Result<(), HwpError> {
    if start > end || end > para_char_len(para) {
        return Err(range_error(format!(
            "범위 {start}..{end}, 문단 길이 {}",
            para_char_len(para)
        )));
    }
    Ok(())
}

fn validate_runs(
    para: &Paragraph,
    start: usize,
    end: usize,
    runs: &[CharShapeRun],
    count: usize,
) -> Result<(), HwpError> {
    validate_range(para, start, end)?;
    let mut next = start;
    for run in runs {
        if run.start_offset != next
            || run.end_offset <= next
            || run.end_offset > end
            || run.char_shape_id as usize >= count
        {
            return Err(range_error(format!(
                "구간 {}..{}, 기대 시작 {next}, 범위 끝 {end}, ID {} (모양 수 {count})",
                run.start_offset, run.end_offset, run.char_shape_id
            )));
        }
        next = run.end_offset;
    }
    if next != end {
        return Err(range_error(format!(
            "구간 끝 {next}가 요청 끝 {end}와 다릅니다"
        )));
    }
    Ok(())
}

impl DocumentCore {
    pub fn get_char_shape_runs_native(
        &self,
        sec: usize,
        para: usize,
        start: usize,
        end: usize,
    ) -> Result<String, HwpError> {
        let paragraph = self
            .document
            .sections
            .get(sec)
            .and_then(|s| s.paragraphs.get(para))
            .ok_or_else(|| range_error(format!("구역 {sec} / 문단 {para} 없음")))?;
        validate_range(paragraph, start, end)?;
        serde_json::to_string(&paragraph.char_shape_runs(start, end))
            .map_err(|error| range_error(format!("JSON 인코딩 실패: {error}")))
    }

    pub fn get_char_shape_runs_in_cell_by_path_native(
        &mut self,
        sec: usize,
        para: usize,
        path: &[(usize, usize, usize)],
        start: usize,
        end: usize,
    ) -> Result<String, HwpError> {
        let paragraph = self.get_cell_paragraph_mut_by_path(sec, para, path)?;
        validate_range(paragraph, start, end)?;
        serde_json::to_string(&paragraph.char_shape_runs(start, end))
            .map_err(|error| range_error(format!("JSON 인코딩 실패: {error}")))
    }

    pub fn set_char_shape_runs_native(
        &mut self,
        sec: usize,
        para: usize,
        start: usize,
        end: usize,
        json: &str,
    ) -> Result<String, HwpError> {
        let runs: Vec<CharShapeRun> = serde_json::from_str(json)
            .map_err(|error| range_error(format!("JSON 디코딩 실패: {error}")))?;
        {
            let paragraph = self
                .document
                .sections
                .get(sec)
                .and_then(|s| s.paragraphs.get(para))
                .ok_or_else(|| range_error(format!("구역 {sec} / 문단 {para} 없음")))?;
            validate_runs(
                paragraph,
                start,
                end,
                &runs,
                self.document.doc_info.char_shapes.len(),
            )?;
        }
        if start == end {
            return Ok("{\"ok\":true}".into());
        }
        self.document.sections[sec].paragraphs[para].restore_char_shape_runs(&runs);
        // 정방향 글자 서식과 같은 리플로우 수명주기(소속 단 폭 + vpos 재계산)를 쓴다.
        // 첫 단 폭으로 줄만 다시 나누면 뒤 문단 vpos 가 편집 뒤 위치에 남는다.
        self.reflow_body_para_and_recalc_flow(sec, para);
        self.document.sections[sec].raw_stream = None;
        self.rebuild_section(sec);
        self.event_log.push(DocumentEvent::CharFormatChanged {
            section: sec,
            para,
            start,
            end,
        });
        Ok("{\"ok\":true}".into())
    }

    pub fn set_char_shape_runs_in_cell_by_path_native(
        &mut self,
        sec: usize,
        para: usize,
        path: &[(usize, usize, usize)],
        start: usize,
        end: usize,
        json: &str,
    ) -> Result<String, HwpError> {
        let runs: Vec<CharShapeRun> = serde_json::from_str(json)
            .map_err(|error| range_error(format!("JSON 디코딩 실패: {error}")))?;
        let count = self.document.doc_info.char_shapes.len();
        let paragraph = self.get_cell_paragraph_mut_by_path(sec, para, path)?;
        validate_runs(paragraph, start, end, &runs, count)?;
        if start == end {
            return Ok("{\"ok\":true}".into());
        }
        paragraph.restore_char_shape_runs(&runs);
        let &(control, cell, cell_para) = path.last().ok_or_else(|| range_error("빈 셀 경로"))?;
        if path.len() == 1 {
            self.reflow_cell_paragraph(sec, para, control, cell, cell_para);
        } else {
            self.reflow_cell_paragraph_by_path(sec, para, path, cell_para);
        }
        self.mark_cell_control_dirty(sec, para, path[0].0);
        self.document.sections[sec].raw_stream = None;
        self.rebuild_section(sec);
        self.event_log.push(DocumentEvent::CharFormatChanged {
            section: sec,
            para,
            start,
            end,
        });
        Ok("{\"ok\":true}".into())
    }
}

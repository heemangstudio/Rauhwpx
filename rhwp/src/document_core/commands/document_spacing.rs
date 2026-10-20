//! 문서 전체 문단 간격 프리셋 (서식 › 문단 간격).
//!
//! 본문 문단 중 줄 간격이 "글자에 따라"(%)인 문단의 줄 간격과 문단 위/아래 간격만
//! 바꾼다. 고정·최소·여백만 줄 간격 문단, 표를 품은 문단, 표 셀·글상자·머리말/꼬리말·
//! 각주 문단은 그대로 둔다(서식 문서의 촘촘한 표 배치를 지키기 위해서다).
//! 정렬·여백·들여쓰기 같은 나머지 문단 속성은 문단마다 그대로 남는다.

use std::collections::{BTreeMap, HashMap};

use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::control::Control;
use crate::model::paragraph::Paragraph;
use crate::model::style::{LineSpacingType, ParaShape, ParaShapeMods};

/// 문단 간격 프리셋 값. 단위는 문단 모양 원시값이다
/// (줄 간격 = %, 문단 위/아래 = HWPUNIT 의 2배 — `parse_para_shape_mods` 와 같다).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocumentParaSpacing {
    pub line_spacing: i32,
    pub spacing_before: i32,
    pub spacing_after: i32,
}

impl DocumentParaSpacing {
    fn mods(&self) -> ParaShapeMods {
        ParaShapeMods {
            line_spacing: Some(self.line_spacing),
            spacing_before: Some(self.spacing_before),
            spacing_after: Some(self.spacing_after),
            ..Default::default()
        }
    }
}

fn is_percent_shape(shapes: &[ParaShape], id: u16) -> bool {
    shapes
        .get(id as usize)
        .is_some_and(|ps| ps.line_spacing_type == LineSpacingType::Percent)
}

/// 프리셋 대상 본문 문단인가 — "글자에 따라" 줄 간격이고 표를 품지 않은 문단.
fn is_spacing_target(para: &Paragraph, shapes: &[ParaShape]) -> bool {
    is_percent_shape(shapes, para.para_shape_id)
        && !para
            .controls
            .iter()
            .any(|ctrl| matches!(ctrl, Control::Table(_)))
}

/// 새로 입력하는 글이 따르는 기본 문단 스타일(바탕글·본문)인가.
fn is_base_body_style(style: &crate::model::style::Style) -> bool {
    style.style_type == 0
        && matches!(
            (style.local_name.as_str(), style.english_name.as_str()),
            ("바탕글", _) | ("본문", _) | (_, "Normal") | (_, "Body")
        )
}

impl DocumentCore {
    /// 프리셋 대상 문단들의 줄 간격·문단 위/아래 값이 모두 같으면 그 값을 돌려준다.
    /// 값이 섞였으면 해당 키는 null 이다. 메뉴 체크 표시용이라 문단 수에 비례하는
    /// 읽기만 한다.
    pub fn get_document_para_spacing_native(&self) -> String {
        let shapes = &self.document.doc_info.para_shapes;
        let mut count = 0usize;
        let mut line: Option<Option<i32>> = None;
        let mut before: Option<Option<i32>> = None;
        let mut after: Option<Option<i32>> = None;
        let merge = |slot: &mut Option<Option<i32>>, value: i32| {
            *slot = match *slot {
                None => Some(Some(value)),
                Some(Some(v)) if v == value => Some(Some(v)),
                _ => Some(None),
            };
        };
        for section in &self.document.sections {
            for para in &section.paragraphs {
                if !is_spacing_target(para, shapes) {
                    continue;
                }
                let ps = &shapes[para.para_shape_id as usize];
                count += 1;
                merge(&mut line, ps.line_spacing);
                merge(&mut before, ps.spacing_before);
                merge(&mut after, ps.spacing_after);
            }
        }
        let value = |slot: Option<Option<i32>>| match slot.flatten() {
            Some(v) => v.to_string(),
            None => "null".to_string(),
        };
        format!(
            "{{\"count\":{},\"lineSpacing\":{},\"spacingBefore\":{},\"spacingAfter\":{}}}",
            count,
            value(line),
            value(before),
            value(after)
        )
    }

    /// 문서 전체 문단 간격 프리셋을 적용한다.
    ///
    /// 문단 모양은 원래 ID 별로 한 번만 변형(`find_or_create_para_shape`)해 같은 모양을
    /// 쓰던 표 셀 문단은 옛 ID 를 그대로 쓴다. 바탕글·본문 스타일의 문단 모양도 같은
    /// 대응표로 옮겨 새로 입력하는 글이 프리셋을 따른다. 값을 덮어쓰는 방식이라 여러 번
    /// 적용해도 누적되지 않는다.
    ///
    /// 리플로우는 문단마다 하되 스타일 해소·문단 머리 해소·재조판은 한 번씩만 한다.
    pub fn apply_document_para_spacing_native(
        &mut self,
        spacing: DocumentParaSpacing,
    ) -> Result<String, HwpError> {
        if !(1..=1000).contains(&spacing.line_spacing)
            || spacing.spacing_before < 0
            || spacing.spacing_after < 0
        {
            return Err(HwpError::RenderError(
                "문단 간격 값이 범위를 벗어났습니다".to_string(),
            ));
        }
        let mods = spacing.mods();
        let mut remap: HashMap<u16, u16> = HashMap::new();
        let mut map_id = |core: &mut DocumentCore, old: u16| -> u16 {
            *remap
                .entry(old)
                .or_insert_with(|| core.document.find_or_create_para_shape(old, &mods))
        };

        // 1) 대상 문단의 문단 모양 ID 교체
        let mut changed: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
        for sec_idx in 0..self.document.sections.len() {
            for para_idx in 0..self.document.sections[sec_idx].paragraphs.len() {
                let para = &self.document.sections[sec_idx].paragraphs[para_idx];
                if !is_spacing_target(para, &self.document.doc_info.para_shapes) {
                    continue;
                }
                let old = para.para_shape_id;
                let new = map_id(self, old);
                if new != old {
                    self.document.sections[sec_idx].paragraphs[para_idx].para_shape_id = new;
                    changed.entry(sec_idx).or_default().push(para_idx);
                }
            }
        }

        // 2) 바탕글·본문 스타일 — 새로 입력하는 문단이 프리셋을 따르게 한다
        let mut styles_changed = false;
        for style_idx in 0..self.document.doc_info.styles.len() {
            let style = &self.document.doc_info.styles[style_idx];
            if !is_base_body_style(style)
                || !is_percent_shape(&self.document.doc_info.para_shapes, style.para_shape_id)
            {
                continue;
            }
            let old = style.para_shape_id;
            let new = map_id(self, old);
            if new != old {
                let style = &mut self.document.doc_info.styles[style_idx];
                style.para_shape_id = new;
                style.raw_data = None;
                styles_changed = true;
            }
        }
        if styles_changed {
            self.document.doc_info.raw_stream_dirty = true;
        }

        let paragraphs: usize = changed.values().map(Vec::len).sum();
        if paragraphs == 0 && !styles_changed {
            return Ok(format!(
                "{{\"ok\":true,\"changed\":0,\"pageCount\":{}}}",
                self.page_count()
            ));
        }

        // 3) 리플로우 + vpos 재계산. 단일 문단 서식 편집과 같은 순서(저장 end 캡처 →
        //    리플로우 → 아래 문단 vpos 재연결)를 앞 문단부터 적용한다.
        self.styles = self.resolve_document_styles();
        let heads =
            crate::renderer::layout::resolve_body_paragraph_heads(&self.document, &self.styles);
        let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
        for (&sec_idx, para_indices) in &changed {
            for &para_idx in para_indices {
                let stored_end = crate::renderer::composer::paragraph_flow_end(
                    &self.document.sections[sec_idx].paragraphs[para_idx],
                );
                let width = self.body_reflow_width(sec_idx, para_idx);
                let para = &mut self.document.sections[sec_idx].paragraphs[para_idx];
                let reserve = crate::renderer::layout::resolved_head_reserve_px(
                    &self.styles,
                    para,
                    heads[sec_idx][para_idx].as_ref(),
                    self.dpi,
                );
                crate::renderer::composer::reflow_line_segs_with_head(
                    para,
                    width,
                    &self.styles,
                    self.dpi,
                    reserve,
                );
                crate::renderer::composer::recalculate_section_vpos(
                    &mut self.document.sections[sec_idx].paragraphs,
                    para_idx,
                    None,
                    stored_end,
                    &self.styles,
                    self.dpi,
                    doc_hwp3_layout,
                );
            }
        }

        // 4) 구역당 한 번 재조판. vpos 가 옮겨진 문단도 많으므로 스냅샷이 문단을
        //    재사용하지 않도록 구역 단위 revision 을 올린다.
        for &sec_idx in changed.keys() {
            self.document.sections[sec_idx].raw_stream = None;
            self.recompose_section(sec_idx);
            self.event_log.mark_paragraph_sequence_changed(sec_idx);
        }
        self.paginate_if_needed();

        Ok(format!(
            "{{\"ok\":true,\"changed\":{},\"pageCount\":{}}}",
            paragraphs,
            self.page_count()
        ))
    }
}

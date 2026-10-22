//! 메모(한컴 "메모", 풍선 주석) 조회·편집 API.
//!
//! 메모는 `Control::Field` + `FieldType::Memo` 다. API 의 메모 식별자는 문서 안에서
//! 유일한 `fieldId` 이고, `memo_index` 는 저장기가 관리하는 파일 형식 세부값이다.
//! 이름에 `memo_note` 를 쓰는 이유: 누름틀 도움말(ClickHere HelpState)도 "memo" 라
//! 부르기 때문이다.
//!
//! 쓰기 API 는 모두 HWPX 파라미터 원문(`raw_parameters_xml`)을 버리고, 앵커 구역과
//! 마지막 구역(HWP 메모 꼬리)의 원본 스트림을 무효화하며, `MemoChanged` 이벤트를 쌓는다.

use serde::{Deserialize, Serialize};

use crate::document_core::hyperlink::{
    raw_boundary, rebuild_hyperlink_char_offsets, shift_axis, HyperlinkTarget,
};
use crate::document_core::queries::field_query::{field_range_bounds, NestedEntry};
use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::control::{Control, Field, FieldType};
use crate::model::event::DocumentEvent;
use crate::model::memo::{
    for_each_field, for_each_section_field, for_each_section_field_mut, MemoCommand, MemoShape,
};
use crate::model::paragraph::{CharShapeRef, FieldRange, Paragraph};
use crate::parser::tags;

/// 메모 앵커 문단 주소 (JSON). 본문이면 `cellPath` 를 생략하거나 빈 배열로 둔다.
///
/// `{"sectionIdx":0,"paraIdx":3,"cellPath":[{"controlIndex":1,"cellIndex":2,"cellParaIndex":0}]}`
/// — 셀/글상자 안이면 `paraIdx` 는 표를 품은 본문 문단, 마지막 `cellParaIndex` 가 대상 문단.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoNotePath {
    pub section_idx: usize,
    pub para_idx: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cell_path: Option<Vec<MemoCellPathEntry>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoCellPathEntry {
    pub control_index: usize,
    #[serde(default)]
    pub cell_index: usize,
    pub cell_para_index: usize,
}

impl MemoNotePath {
    pub fn parse(json: &str) -> Result<Self, HwpError> {
        serde_json::from_str(json)
            .map_err(|e| HwpError::InvalidField(format!("메모 위치 JSON 오류: {e}")))
    }

    fn target(&self) -> HyperlinkTarget {
        HyperlinkTarget {
            section: self.section_idx,
            para: self.para_idx,
            cell_path: self
                .cell_path
                .iter()
                .flatten()
                .map(|e| (e.control_index, e.cell_index, e.cell_para_index))
                .collect(),
        }
    }

    fn from_target(target: &HyperlinkTarget) -> Self {
        Self {
            section_idx: target.section,
            para_idx: target.para,
            cell_path: (!target.cell_path.is_empty()).then(|| {
                target
                    .cell_path
                    .iter()
                    .map(
                        |&(control_index, cell_index, cell_para_index)| MemoCellPathEntry {
                            control_index,
                            cell_index,
                            cell_para_index,
                        },
                    )
                    .collect()
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoNoteAnchor {
    pub section_idx: usize,
    pub para_idx: usize,
    pub start_char_idx: usize,
    pub end_char_idx: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell_path: Option<Vec<MemoCellPathEntry>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoNoteShape {
    /// `#RRGGBB`
    pub fill_color: String,
    pub line_color: String,
    pub width: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoNoteInfo {
    pub field_id: u32,
    pub memo_index: u32,
    pub author: String,
    pub created_at: Option<String>,
    pub text: String,
    pub para_count: usize,
    /// 본문·표 셀·글상자 안의 메모만 앵커 주소가 있다 (머리말·각주 등은 `null`).
    pub anchor: Option<MemoNoteAnchor>,
    /// 앵커 범위의 본문 글자. 앵커 글자를 모두 지웠으면 빈 문자열.
    pub anchor_text: String,
    pub shape: MemoNoteShape,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoNoteRect {
    pub page_index: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

fn invalid(message: impl Into<String>) -> HwpError {
    HwpError::InvalidField(message.into())
}

fn memo_shape_info(shapes: &[MemoShape], field: &Field) -> MemoNoteShape {
    let reference = MemoCommand::parse(&field.command)
        .and_then(|c| c.shape_ref.parse::<usize>().ok())
        .filter(|&i| i < shapes.len());
    let shape = reference
        .and_then(|i| shapes.get(i))
        .or_else(|| shapes.first())
        .cloned()
        .unwrap_or_else(MemoShape::hancom_default);
    MemoNoteShape {
        fill_color: crate::model::memo::colorref_to_hex(shape.fill_color),
        line_color: crate::model::memo::colorref_to_hex(shape.line_color),
        width: shape.width,
    }
}

fn target_from_nested(section: usize, para: usize, nested: &[NestedEntry]) -> HyperlinkTarget {
    HyperlinkTarget {
        section,
        para,
        cell_path: nested
            .iter()
            .map(|entry| match entry {
                NestedEntry::TableCell {
                    control_index,
                    cell_index,
                    para_index,
                } => (*control_index, *cell_index, *para_index),
                NestedEntry::TextBox {
                    control_index,
                    para_index,
                } => (*control_index, 0, *para_index),
            })
            .collect(),
    }
}

/// 한 줄씩 평문 메모 본문 문단을 만든다. 빈 텍스트도 빈 문단 하나를 둔다.
fn plain_memo_paragraphs(text: &str, template: &Paragraph) -> Vec<Paragraph> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    normalized
        .split('\n')
        .map(|line| {
            let mut para = Paragraph {
                para_shape_id: template.para_shape_id,
                style_id: template.style_id,
                char_shapes: vec![CharShapeRef {
                    start_pos: 0,
                    char_shape_id: template
                        .char_shapes
                        .first()
                        .map_or(0, |cs| cs.char_shape_id),
                }],
                raw_header_extra: vec![0; 12],
                ..Paragraph::new_empty()
            };
            let clean: String = line
                .chars()
                .filter(|c| !c.is_control() || *c == '\t')
                .collect();
            if !clean.is_empty() {
                para.insert_text_at(0, &clean);
            }
            // 한컴 메모 본문에는 줄 정보(LINE_SEG/linesegarray)가 없다.
            para.line_segs.clear();
            para
        })
        .collect()
}

impl DocumentCore {
    /// 문서의 모든 메모 (문서 순서).
    pub fn memo_note_list(&self) -> Vec<MemoNoteInfo> {
        let shapes = self.document.memo_shapes();
        let mut out = Vec::new();
        let mut anchored = std::collections::HashSet::new();
        for info in self.collect_all_fields() {
            if info.field.field_type != FieldType::Memo {
                continue;
            }
            let target = target_from_nested(
                info.location.section_index,
                info.location.para_index,
                &info.location.nested_path,
            );
            let (start, end) = field_range_bounds(self, &info).unwrap_or((0, 0));
            anchored.insert(info.field.field_id);
            out.push(self.memo_info(
                &info.field,
                Some(MemoNoteAnchor {
                    section_idx: target.section,
                    para_idx: target.para,
                    start_char_idx: start,
                    end_char_idx: end,
                    cell_path: MemoNotePath::from_target(&target).cell_path,
                }),
                info.value.clone(),
                &shapes,
            ));
        }
        // 머리말·꼬리말·각주·메모 본문 등 앵커 주소가 없는 메모.
        for section in &self.document.sections {
            for_each_section_field(section, &mut |field| {
                if field.field_type == FieldType::Memo && !anchored.contains(&field.field_id) {
                    anchored.insert(field.field_id);
                    out.push(self.memo_info(field, None, String::new(), &shapes));
                }
            });
        }
        out
    }

    fn memo_info(
        &self,
        field: &Field,
        anchor: Option<MemoNoteAnchor>,
        anchor_text: String,
        shapes: &[MemoShape],
    ) -> MemoNoteInfo {
        let meta = field.memo_meta();
        MemoNoteInfo {
            field_id: field.field_id,
            memo_index: field.memo_index,
            author: meta.as_ref().map(|m| m.author.clone()).unwrap_or_default(),
            created_at: meta.and_then(|m| m.created_at),
            text: field.memo_body_text(),
            para_count: field.memo_paragraphs.len(),
            anchor,
            anchor_text,
            shape: memo_shape_info(shapes, field),
        }
    }

    /// `getMemoNoteList` JSON.
    pub fn memo_note_list_json(&self) -> String {
        serde_json::to_string(&self.memo_note_list()).unwrap_or_else(|_| "[]".into())
    }

    /// 문단 위치의 메모 fieldId (앵커 범위 hit-test). 겹치면 가장 짧은 범위를 고른다.
    pub fn memo_note_at(&self, path: &MemoNotePath, char_offset: usize) -> Option<u32> {
        let para = self.hyperlink_paragraph(&path.target()).ok()?;
        para.field_ranges
            .iter()
            .filter_map(|range| match para.controls.get(range.control_idx) {
                Some(Control::Field(field))
                    if field.field_type == FieldType::Memo
                        && range.start_char_idx <= char_offset
                        && char_offset <= range.end_char_idx =>
                {
                    Some((range.end_char_idx - range.start_char_idx, field.field_id))
                }
                _ => None,
            })
            .min_by_key(|(len, _)| *len)
            .map(|(_, id)| id)
    }

    /// 메모 앵커 글자의 화면 사각형 (쪽 좌표). 앵커 글자가 없으면 캐럿 위치의 폭 0 사각형.
    pub fn memo_note_anchor_rects(&self, field_id: u32) -> Result<Vec<MemoNoteRect>, HwpError> {
        let memo = self
            .memo_note_list()
            .into_iter()
            .find(|m| m.field_id == field_id)
            .ok_or_else(|| invalid("메모를 찾을 수 없습니다"))?;
        let Some(anchor) = memo.anchor else {
            return Ok(Vec::new());
        };
        let path: Vec<(usize, usize, usize)> = anchor
            .cell_path
            .iter()
            .flatten()
            .map(|e| (e.control_index, e.cell_index, e.cell_para_index))
            .collect();
        let json = if anchor.start_char_idx < anchor.end_char_idx {
            let (start_para, cell_ctx) = match path.last() {
                None => (anchor.para_idx, None),
                Some(&(_, _, cell_para)) => (
                    cell_para,
                    Some(crate::document_core::queries::SelCellAddr::Path(
                        anchor.para_idx,
                        path.clone(),
                    )),
                ),
            };
            self.get_selection_rects_native(
                anchor.section_idx,
                start_para,
                anchor.start_char_idx,
                start_para,
                anchor.end_char_idx,
                cell_ctx,
                None,
                false,
            )?
        } else {
            let caret = if path.is_empty() {
                self.get_cursor_rect_native(
                    anchor.section_idx,
                    anchor.para_idx,
                    anchor.start_char_idx,
                )?
            } else {
                let path_json = serde_json::to_string(&anchor.cell_path).unwrap_or_default();
                self.get_cursor_rect_by_path_native(
                    anchor.section_idx,
                    anchor.para_idx,
                    &path_json,
                    anchor.start_char_idx,
                )?
            };
            format!("[{caret}]")
        };
        let values: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap_or_default();
        Ok(values
            .iter()
            .filter_map(|v| {
                Some(MemoNoteRect {
                    page_index: v.get("pageIndex")?.as_u64()? as u32,
                    x: v.get("x")?.as_f64()?,
                    y: v.get("y")?.as_f64()?,
                    w: v.get("width").and_then(|w| w.as_f64()).unwrap_or(0.0),
                    h: v.get("height")?.as_f64()?,
                })
            })
            .collect())
    }

    fn next_memo_index(&self) -> u32 {
        let mut max = self
            .document
            .orphan_memo_lists
            .iter()
            .map(|l| l.index)
            .max()
            .unwrap_or(0);
        for section in &self.document.sections {
            for_each_section_field(section, &mut |field| {
                if field.field_type == FieldType::Memo {
                    max = max.max(field.memo_index);
                    if let Some(command) = MemoCommand::parse(&field.command) {
                        max = max.max(command.number);
                    }
                }
            });
        }
        max.saturating_add(1)
    }

    fn next_field_id(&self) -> Result<u32, HwpError> {
        let mut max_id = 0;
        for section in &self.document.sections {
            for para in &section.paragraphs {
                super::field_query::collect_max_field_id(para, &mut max_id);
            }
            for_each_section_field(section, &mut |field| max_id = max_id.max(field.field_id));
        }
        max_id
            .checked_add(1)
            .ok_or_else(|| invalid("필드 ID 공간이 소진되었습니다"))
    }

    /// 새 메모 본문 문단의 서식 원본: `메모` 스타일, 없으면 0번 스타일.
    fn memo_body_template(&self) -> Paragraph {
        let styles = &self.document.doc_info.styles;
        let (style_id, style) = styles
            .iter()
            .enumerate()
            .find(|(_, s)| s.local_name == "메모")
            .or_else(|| styles.iter().enumerate().next())
            .map(|(i, s)| (i, Some(s)))
            .unwrap_or((0, None));
        Paragraph {
            style_id: style_id.min(u8::MAX as usize) as u8,
            para_shape_id: style.map_or(0, |s| s.para_shape_id),
            char_shapes: vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: style.map_or(0, |s| u32::from(s.char_shape_id)),
            }],
            ..Default::default()
        }
    }

    fn invalidate_memo_streams(&mut self, section_idx: usize) {
        if let Some(section) = self.document.sections.get_mut(section_idx) {
            section.raw_stream = None;
        }
        // 문서의 모든 메모 본문은 HWP 마지막 구역 끝에 있다.
        if let Some(last) = self.document.sections.last_mut() {
            last.raw_stream = None;
        }
    }

    /// 범위 `[start, end)` 에 새 메모를 달 수 있는지 미리 본다 (문서는 바꾸지 않는다).
    /// 편집기가 새 메모 풍선을 열기 전에 불러, 확정할 때에야 실패해 입력이 버려지지 않게 한다.
    pub fn check_memo_note_range(
        &self,
        path: &MemoNotePath,
        start: usize,
        end: usize,
    ) -> Result<(), HwpError> {
        let target = path.target();
        self.validate_hyperlink_paragraph(&target)?;
        let para = self.hyperlink_paragraph(&target)?;
        let len = para.text.chars().count();
        if start >= end || end > len {
            return Err(invalid("메모는 문단 안의 비어 있지 않은 범위가 필요합니다"));
        }
        if para.field_ranges.iter().any(|r| {
            (start < r.end_char_idx && r.start_char_idx < end)
                || (r.start_char_idx == r.end_char_idx
                    && start <= r.start_char_idx
                    && r.start_char_idx < end)
        }) {
            return Err(invalid("기존 필드와 겹치는 범위에는 메모를 달 수 없습니다"));
        }
        Ok(())
    }

    /// 범위 `[start, end)` 에 메모를 단다. 새 메모의 fieldId 를 돌려준다.
    pub fn insert_memo_note(
        &mut self,
        path: &MemoNotePath,
        start: usize,
        end: usize,
        text: &str,
        author: Option<&str>,
    ) -> Result<u32, HwpError> {
        self.check_memo_note_range(path, start, end)?;
        let target = path.target();
        let mut candidate = self.hyperlink_paragraph(&target)?.clone();
        let field_id = self.next_field_id()?;
        let memo_index = self.next_memo_index();
        let command = MemoCommand::new(
            author.unwrap_or(""),
            memo_index,
            crate::model::memo::now_unix_ms(),
        );
        let template = self.memo_body_template();
        let field = Field {
            field_type: FieldType::Memo,
            command: command.to_string(),
            // 한컴 HWP 메모 필드와 같은 표지 (`%unk` + 0x8000, 편집 가능 비트).
            properties: 0x8001,
            ctrl_id: tags::FIELD_UNKNOWN,
            field_id,
            memo_index,
            memo_paragraphs: plain_memo_paragraphs(text, &template),
            ..Default::default()
        };

        let positions = candidate.control_text_positions();
        let insert_idx = candidate
            .controls
            .iter()
            .enumerate()
            .position(|(idx, _)| {
                candidate
                    .field_ranges
                    .iter()
                    .find(|r| r.control_idx == idx)
                    .map_or(positions[idx], |r| r.start_char_idx)
                    > start
            })
            .unwrap_or(candidate.controls.len());
        let end_raw = raw_boundary(&candidate, end);
        let start_raw = raw_boundary(&candidate, start);
        shift_axis(&mut candidate, end_raw, 8)?;
        shift_axis(&mut candidate, start_raw, 8)?;
        for r in &mut candidate.field_ranges {
            if r.control_idx >= insert_idx {
                r.control_idx += 1;
            }
        }
        candidate.controls.insert(insert_idx, Control::Field(field));
        candidate
            .ctrl_data_records
            .resize(candidate.controls.len() - 1, None);
        candidate.ctrl_data_records.insert(insert_idx, None);
        candidate.field_ranges.push(FieldRange {
            start_char_idx: start,
            end_char_idx: end,
            control_idx: insert_idx,
            ..Default::default()
        });
        candidate
            .field_ranges
            .sort_by_key(|r| (r.start_char_idx, r.control_idx));
        rebuild_hyperlink_char_offsets(&mut candidate);

        if self.document.doc_info.ensure_default_memo_shape() {
            self.document.doc_info.raw_stream = None;
        }
        self.commit_memo_paragraph(&target, candidate, field_id)?;
        Ok(field_id)
    }

    fn commit_memo_paragraph(
        &mut self,
        target: &HyperlinkTarget,
        candidate: Paragraph,
        field_id: u32,
    ) -> Result<(), HwpError> {
        let section = target.section;
        let para = target.para;
        if target.cell_path.is_empty() {
            let stored_end = crate::renderer::composer::paragraph_flow_end(
                &self.document.sections[section].paragraphs[para],
            );
            self.document.sections[section].paragraphs[para] = candidate;
            self.reflow_paragraph(section, para);
            let hwp3_layout = self.document.layout_profile().hwp3_layout();
            crate::renderer::composer::recalculate_section_vpos(
                &mut self.document.sections[section].paragraphs,
                para,
                None,
                stored_end,
                &self.styles,
                self.dpi,
                hwp3_layout,
            );
            self.recompose_paragraph(section, para);
        } else {
            *self.get_cell_paragraph_mut_by_path(section, para, &target.cell_path)? = candidate;
            let path = &target.cell_path;
            let inner_para = path.last().map_or(0, |p| p.2);
            self.reflow_cell_paragraph_by_path(section, para, path, inner_para);
            self.recalculate_cell_paragraph_vpos_by_path(section, para, path, inner_para, None);
            self.mark_cell_control_dirty(section, para, path[0].0);
        }
        self.invalidate_memo_streams(section);
        self.mark_section_dirty(section);
        self.paginate_if_needed();
        self.invalidate_page_tree_cache();
        self.event_log.push(DocumentEvent::MemoChanged {
            section,
            para,
            cell_path: target.cell_path.clone(),
            field_id,
        });
        Ok(())
    }

    /// 메모 필드가 있는 구역과 본문 최상위 문단 (이벤트 주소용).
    fn memo_owner(&self, field_id: u32) -> Option<(usize, usize)> {
        for (si, section) in self.document.sections.iter().enumerate() {
            for (pi, para) in section.paragraphs.iter().enumerate() {
                let mut found = false;
                for_each_field(std::slice::from_ref(para), &mut |f| {
                    found |= f.field_type == FieldType::Memo && f.field_id == field_id;
                });
                if found {
                    return Some((si, pi));
                }
            }
            let mut found = false;
            for_each_section_field(section, &mut |f| {
                found |= f.field_type == FieldType::Memo && f.field_id == field_id;
            });
            if found {
                return Some((si, 0));
            }
        }
        None
    }

    /// 메모 본문을 평문 문단(줄마다 한 문단)으로 바꾼다. 같은 글이면 아무것도 바꾸지 않고
    /// `false` 를 돌려준다 (서식 보존). 첫 문단의 문단/글자 모양을 이어 쓴다.
    pub fn set_memo_note_text(&mut self, field_id: u32, text: &str) -> Result<bool, HwpError> {
        let (section_idx, para_idx) = self
            .memo_owner(field_id)
            .ok_or_else(|| invalid("메모를 찾을 수 없습니다"))?;
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        let fallback = self.memo_body_template();
        let mut changed = false;
        let section = &mut self.document.sections[section_idx];
        for_each_section_field_mut(section, &mut |field| {
            if changed || field.field_type != FieldType::Memo || field.field_id != field_id {
                return;
            }
            if field.memo_body_text() == normalized {
                return;
            }
            let template = field
                .memo_paragraphs
                .first()
                .cloned()
                .unwrap_or_else(|| fallback.clone());
            field.memo_paragraphs = plain_memo_paragraphs(&normalized, &template);
            field.raw_parameters_xml = None;
            changed = true;
        });
        if !changed {
            return Ok(false);
        }
        self.invalidate_memo_streams(section_idx);
        self.event_log.mark_paragraph_changed(section_idx, para_idx);
        self.event_log.push(DocumentEvent::MemoChanged {
            section: section_idx,
            para: para_idx,
            cell_path: Vec::new(),
            field_id,
        });
        Ok(true)
    }

    /// 메모를 지운다 (필드 표지만 지우고 앵커 글자는 남긴다).
    pub fn delete_memo_note(&mut self, field_id: u32) -> Result<(), HwpError> {
        let anchored = self.collect_all_fields().into_iter().find(|info| {
            info.field.field_type == FieldType::Memo && info.field.field_id == field_id
        });
        if let Some(info) = anchored {
            let target = target_from_nested(
                info.location.section_index,
                info.location.para_index,
                &info.location.nested_path,
            );
            let mut candidate = self.hyperlink_paragraph(&target)?.clone();
            remove_memo_markers(&mut candidate, field_id)?;
            return self.commit_memo_paragraph(&target, candidate, field_id);
        }
        // 앵커 주소가 없는 위치(머리말·각주·메모 본문 등): 표지만 지우고 구역을 다시 조판한다.
        let (section_idx, para_idx) = self
            .memo_owner(field_id)
            .ok_or_else(|| invalid("메모를 찾을 수 없습니다"))?;
        let mut result = Err(invalid("메모를 찾을 수 없습니다"));
        let section = &mut self.document.sections[section_idx];
        let mut visit = |para: &mut Paragraph| {
            if result.is_ok() {
                return;
            }
            let owns = para.controls.iter().any(|c| {
                matches!(c, Control::Field(f) if f.field_type == FieldType::Memo && f.field_id == field_id)
            });
            if owns {
                result = remove_memo_markers(para, field_id);
            }
        };
        crate::document_core::commands::visit_paragraphs_mut(&mut section.paragraphs, &mut visit);
        for master in &mut section.section_def.master_pages {
            crate::document_core::commands::visit_paragraphs_mut(
                &mut master.paragraphs,
                &mut visit,
            );
        }
        result?;
        self.invalidate_memo_streams(section_idx);
        self.event_log.mark_paragraph_changed(section_idx, para_idx);
        self.rebuild_section(section_idx);
        self.event_log.push(DocumentEvent::MemoChanged {
            section: section_idx,
            para: para_idx,
            cell_path: Vec::new(),
            field_id,
        });
        Ok(())
    }

    /// 모든 메모(앵커 없는 메모 본문 포함)를 지운다. 지운 메모 수를 돌려준다.
    pub fn delete_all_memo_notes(&mut self) -> Result<usize, HwpError> {
        let ids: Vec<u32> = self.memo_note_list().iter().map(|m| m.field_id).collect();
        let orphans = self.document.orphan_memo_lists.len();
        for id in &ids {
            self.delete_memo_note(*id)?;
        }
        if orphans > 0 {
            self.document.orphan_memo_lists.clear();
            if let Some(last) = self.document.sections.last_mut() {
                last.raw_stream = None;
            }
        }
        Ok(ids.len() + orphans)
    }
}

/// 문단에서 메모 필드의 시작/끝 표지(각 8 유닛)와 컨트롤을 지운다. 표시 글자는 남는다.
fn remove_memo_markers(para: &mut Paragraph, field_id: u32) -> Result<(), HwpError> {
    let (range_idx, ctrl_idx) = para
        .field_ranges
        .iter()
        .enumerate()
        .find_map(|(i, r)| match para.controls.get(r.control_idx) {
            Some(Control::Field(f))
                if f.field_type == FieldType::Memo && f.field_id == field_id =>
            {
                Some((i, r.control_idx))
            }
            _ => None,
        })
        .ok_or_else(|| invalid("메모 필드 범위를 찾을 수 없습니다"))?;
    let range = para.field_ranges[range_idx].clone();
    let end_raw = raw_boundary(para, range.end_char_idx);
    let start_raw = if range.start_char_idx == range.end_char_idx {
        end_raw
            .checked_sub(8)
            .ok_or_else(|| invalid("빈 메모 표지 좌표 오류"))?
    } else {
        raw_boundary(para, range.start_char_idx)
    };
    if start_raw < 8 || end_raw.saturating_sub(start_raw) < 8 {
        return Err(invalid("메모 표지 좌표가 올바르지 않습니다"));
    }
    shift_axis(para, end_raw, -8)?;
    shift_axis(para, start_raw, -8)?;
    para.field_ranges.remove(range_idx);
    para.controls.remove(ctrl_idx);
    if ctrl_idx < para.ctrl_data_records.len() {
        para.ctrl_data_records.remove(ctrl_idx);
    }
    for r in &mut para.field_ranges {
        if r.control_idx > ctrl_idx {
            r.control_idx -= 1;
        }
    }
    Ok(())
}

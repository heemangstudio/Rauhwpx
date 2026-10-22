//! 저장 직전 메모 번호 계획 (HWP·HWPX 공용).
//!
//! 메모 필드와 메모 본문은 `memo_index` 로 짝지어진다 (HWP: CTRL_HEADER 끝 u32,
//! FIELD_END 표지, `MEMO_LIST`; HWPX: `Number` 파라미터). 복사·붙여넣기나 `Number` 없는
//! HWPX 처럼 번호가 0 이거나 겹치면 저장본에서 메모가 엉뚱한 본문에 붙는다. 저장마다
//! 문서 순서로 한 번 계획해, 0 이 아니고 아직 안 쓴 번호는 그대로 두고 나머지는 `max+1`
//! 부터 새 번호를 준다 (명령의 번호도 함께 고친다).

use std::borrow::Cow;
use std::collections::{BTreeSet, HashSet};

use crate::model::control::FieldType;
use crate::model::document::Document;
use crate::model::memo::{for_each_section_field, for_each_section_field_mut, MemoCommand};

/// 문서 순서 메모 번호 계획.
#[derive(Debug, Default)]
pub(crate) struct MemoIndexPlan {
    /// 문서 순서 메모 필드마다: 새 번호가 필요하면 `Some(new)`.
    fields: Vec<Option<u32>>,
    /// 앵커 없는 메모 본문마다: 새 번호가 필요하면 `Some(new)`.
    orphans: Vec<Option<u32>>,
    /// 번호가 바뀐 메모 필드가 있는 구역.
    renumbered_sections: BTreeSet<usize>,
}

impl MemoIndexPlan {
    pub(crate) fn is_noop(&self) -> bool {
        self.fields.iter().all(Option::is_none) && self.orphans.iter().all(Option::is_none)
    }
}

pub(crate) fn plan_memo_indexes(doc: &Document) -> MemoIndexPlan {
    let mut current: Vec<(usize, u32)> = Vec::new();
    for (section_idx, section) in doc.sections.iter().enumerate() {
        for_each_section_field(section, &mut |field| {
            if field.field_type == FieldType::Memo {
                current.push((section_idx, field.memo_index));
            }
        });
    }
    let mut max = current
        .iter()
        .map(|(_, index)| *index)
        .chain(doc.orphan_memo_lists.iter().map(|list| list.index))
        .max()
        .unwrap_or(0);
    let mut taken = HashSet::new();
    let mut plan = MemoIndexPlan::default();
    let mut assign = |index: u32, max: &mut u32| -> Option<u32> {
        if index != 0 && taken.insert(index) {
            None
        } else {
            *max = max.saturating_add(1);
            taken.insert(*max);
            Some(*max)
        }
    };
    for (section_idx, index) in current {
        let new = assign(index, &mut max);
        if new.is_some() {
            plan.renumbered_sections.insert(section_idx);
        }
        plan.fields.push(new);
    }
    for list in &doc.orphan_memo_lists {
        let new = assign(list.index, &mut max);
        plan.orphans.push(new);
    }
    plan
}

/// 계획을 문서에 적용한다. 번호가 바뀐 필드는 명령 번호를 고치고 HWPX 파라미터 원문을
/// 버리며(새 번호로 다시 만든다), 그 구역의 원본 스트림을 무효화한다.
pub(crate) fn apply_memo_index_plan(doc: &mut Document, plan: &MemoIndexPlan) {
    let mut ordinal = 0usize;
    for section in doc.sections.iter_mut() {
        let mut changed = false;
        for_each_section_field_mut(section, &mut |field| {
            if field.field_type != FieldType::Memo {
                return;
            }
            if let Some(Some(new)) = plan.fields.get(ordinal) {
                field.memo_index = *new;
                if let Some(mut command) = MemoCommand::parse(&field.command) {
                    command.number = *new;
                    field.command = command.to_string();
                }
                field.raw_parameters_xml = None;
                changed = true;
            }
            ordinal += 1;
        });
        if changed {
            section.raw_stream = None;
        }
    }
    for (list, new) in doc.orphan_memo_lists.iter_mut().zip(&plan.orphans) {
        if let Some(new) = new {
            list.index = *new;
        }
    }
}

/// 번호 계획이 필요하면 고친 사본을, 아니면 원본을 돌려준다.
pub(crate) fn normalize_memo_indexes(doc: &Document) -> Cow<'_, Document> {
    let plan = plan_memo_indexes(doc);
    if plan.is_noop() {
        return Cow::Borrowed(doc);
    }
    let mut owned = doc.clone();
    apply_memo_index_plan(&mut owned, &plan);
    if let Some(last) = owned.sections.last_mut() {
        last.raw_stream = None;
    }
    Cow::Owned(owned)
}

/// HWP 저장: 마지막 구역의 원본 스트림(그 안의 메모 꼬리)을 다시 써야 하는지.
///
/// 메모가 있는 문서에서 어느 구역이든 IR 로 다시 쓰이면 메모 필드·본문이 바뀌었을 수
/// 있으므로, 문서 전체 메모를 담는 마지막 구역도 IR 에서 다시 쓴다.
pub(crate) fn hwp_must_rewrite_last_section(doc: &Document) -> bool {
    let Some(last) = doc.sections.last() else {
        return false;
    };
    last.raw_stream.is_some()
        && doc
            .sections
            .iter()
            .any(|section| section.raw_stream.is_none())
        && crate::model::memo::document_has_memos(doc)
}

/// HWP 마지막 구역 끝에 쓸 메모 묶음: 문서 순서 메모 필드 본문 + 앵커 없는 메모 본문.
pub(crate) fn collect_document_memo_tail(
    doc: &Document,
) -> Vec<(u32, &[crate::model::paragraph::Paragraph])> {
    let mut lists = Vec::new();
    for section in &doc.sections {
        lists.extend(crate::serializer::body_text::collect_memo_lists(section));
    }
    lists.extend(
        doc.orphan_memo_lists
            .iter()
            .map(|list| (list.index, list.paragraphs.as_slice())),
    );
    lists
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::control::{Control, Field};
    use crate::model::document::{OrphanMemoList, Section};
    use crate::model::paragraph::Paragraph;

    fn memo(index: u32) -> Control {
        Control::Field(Field {
            field_type: FieldType::Memo,
            memo_index: index,
            command: format!("MEMO/65535/{index}/1/2/me/\\;;"),
            raw_parameters_xml: Some("<hp:parameters/>".into()),
            memo_paragraphs: vec![Paragraph::default()],
            ..Default::default()
        })
    }

    fn doc_with(indexes: &[u32]) -> Document {
        let paragraph = Paragraph {
            controls: indexes.iter().map(|&i| memo(i)).collect(),
            ..Default::default()
        };
        Document {
            sections: vec![
                Section {
                    paragraphs: vec![paragraph],
                    raw_stream: Some(vec![1]),
                    ..Default::default()
                },
                Section {
                    paragraphs: vec![Paragraph::default()],
                    raw_stream: Some(vec![2]),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }
    }

    fn indexes(doc: &Document) -> Vec<(u32, String)> {
        let mut out = Vec::new();
        for section in &doc.sections {
            for_each_section_field(section, &mut |field| {
                out.push((field.memo_index, field.command.clone()));
            });
        }
        out
    }

    #[test]
    fn unique_indexes_are_kept_and_original_is_borrowed() {
        let doc = doc_with(&[3, 1]);
        assert!(matches!(normalize_memo_indexes(&doc), Cow::Borrowed(_)));
    }

    #[test]
    fn duplicate_and_zero_indexes_get_fresh_numbers() {
        let mut doc = doc_with(&[2, 2, 0]);
        doc.orphan_memo_lists.push(OrphanMemoList {
            index: 2,
            paragraphs: vec![Paragraph::default()],
        });
        let normalized = normalize_memo_indexes(&doc);
        let got = indexes(&normalized);
        assert_eq!(
            got.iter().map(|(i, _)| *i).collect::<Vec<_>>(),
            vec![2, 3, 4]
        );
        assert_eq!(got[1].1, "MEMO/65535/3/1/2/me/\\;;");
        assert_eq!(normalized.orphan_memo_lists[0].index, 5);
        assert!(normalized.sections[0].raw_stream.is_none());
        assert!(
            normalized.sections[1].raw_stream.is_none(),
            "last section rewritten"
        );
        let Control::Field(field) = &normalized.sections[0].paragraphs[0].controls[1] else {
            unreachable!()
        };
        assert!(field.raw_parameters_xml.is_none());
        let Control::Field(field) = &normalized.sections[0].paragraphs[0].controls[0] else {
            unreachable!()
        };
        assert!(
            field.raw_parameters_xml.is_some(),
            "untouched memo keeps params"
        );
    }

    #[test]
    fn last_section_rewrite_requires_memos_and_an_edited_section() {
        let mut doc = doc_with(&[1]);
        assert!(!hwp_must_rewrite_last_section(&doc));
        doc.sections[0].raw_stream = None;
        assert!(hwp_must_rewrite_last_section(&doc));
        let mut plain = doc_with(&[]);
        plain.sections[0].raw_stream = None;
        assert!(!hwp_must_rewrite_last_section(&plain));
    }
}

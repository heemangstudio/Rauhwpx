//! 쪽번호 할당 (Issue #353)
//!
//! NewNumber 컨트롤은 그 컨트롤의 소유 문단이 페이지에서 **처음 등장**할 때
//! 1회만 page_number 를 갱신해야 한다. 그 외 페이지는 직전 page_number + 1.
//!
//! "처음 등장" 판정 — PartialParagraph/PartialTable 의 분할은 첫 분할만 인정:
//! - FullParagraph                                : 항상 인정
//! - PartialParagraph { start_line == 0 }         : 첫 분할
//! - Table                                        : 항상 인정
//! - PartialTable    { is_continuation == false } : 첫 분할
//! - Shape                                        : 항상 인정

use std::collections::HashSet;

use crate::renderer::pagination::{PageContent, PageItem};

/// 본문과 표의 첫 셀 첫 문단에 붙은 쪽 번호 재시작을 소유 문단 순서로 수집한다.
/// 표 안의 뒤쪽 문단은 분할 페이지가 달라질 수 있으므로 표 시작에 당겨 적용하지 않는다.
pub(crate) fn collect_page_number_resets(
    paragraphs: &[crate::model::paragraph::Paragraph],
    hwpx_container: bool,
) -> Vec<(usize, u16)> {
    use crate::model::control::{AutoNumberType, Control};
    fn collect(
        paragraph: &crate::model::paragraph::Paragraph,
        host_index: usize,
        hwpx: bool,
        resets: &mut Vec<(usize, u16)>,
    ) {
        let marker_only = paragraph.text.chars().all(|c| {
            matches!(c, '\u{0000}'..='\u{0008}' | '\u{000B}' | '\u{000C}'
                | '\u{000E}'..='\u{001F}' | '\u{FFFC}')
        });
        let object_container = marker_only
            && paragraph.controls.iter().any(|control| {
                matches!(
                    control,
                    Control::Table(_) | Control::Picture(_) | Control::Shape(_)
                )
            });
        for control in &paragraph.controls {
            match control {
                Control::NewNumber(number)
                    if number.number_type == AutoNumberType::Page
                        && (hwpx || !object_container) =>
                {
                    resets.push((host_index, number.number));
                }
                Control::Table(table) if hwpx => {
                    if let Some(first) = table
                        .cells
                        .iter()
                        .find(|cell| cell.row == 0 && cell.col == 0)
                        .and_then(|cell| cell.paragraphs.first())
                    {
                        collect(first, host_index, hwpx, resets);
                    }
                }
                _ => {}
            }
        }
    }
    let mut resets = Vec::new();
    for (index, paragraph) in paragraphs.iter().enumerate() {
        collect(paragraph, index, hwpx_container, &mut resets);
    }
    resets
}

/// 쪽번호를 1회성 NewNumber 적용 + 단조 증가로 계산하는 어시스턴트.
pub(crate) struct PageNumberAssigner<'a> {
    new_page_numbers: &'a [(usize, u16)],
    consumed: HashSet<usize>,
    counter: u32,
    /// NewNumber 컨트롤이 1건 이상 소비되었는지 여부.
    /// 한컴 호환: NewNumber가 존재하면 첫 발화 전 페이지에는 쪽번호 미표시.
    numbering_started: bool,
}

impl<'a> PageNumberAssigner<'a> {
    /// `initial`: 페이지 카운터 시작값 (보통 1; 구역 carry 시 이전 구역 마지막 +1).
    pub fn new(new_page_numbers: &'a [(usize, u16)], initial: u32) -> Self {
        Self {
            new_page_numbers,
            consumed: HashSet::new(),
            counter: initial,
            numbering_started: false,
        }
    }

    /// 페이지에 쪽번호를 할당하고, 다음 페이지를 위해 카운터를 1 증가시킨다.
    ///
    /// 한 페이지에 적용 가능한 NewNumber 가 여러 개 있어도 **마지막 1개만** 적용한다
    /// (소유 문단 인덱스 오름차순 — Vec 순서대로 평가하면 자연히 마지막이 우선).
    pub fn assign(&mut self, page: &PageContent) -> u32 {
        for (idx, &(nn_pi, nn_num)) in self.new_page_numbers.iter().enumerate() {
            if self.consumed.contains(&idx) {
                continue;
            }
            if Self::para_first_appears(page, nn_pi) {
                self.counter = nn_num as u32;
                self.consumed.insert(idx);
                self.numbering_started = true;
            }
        }
        let assigned = self.counter;
        self.counter += 1;
        assigned
    }

    /// 다음 페이지에 적용될 카운터 값 (구역 carry 용).
    pub fn next_counter(&self) -> u32 {
        self.counter
    }

    /// NewNumber가 존재하지만 아직 발화되지 않은 상태인지 판별한다.
    /// true이면 이 페이지에 쪽번호를 표시하지 않아야 한다 (한컴 호환).
    pub fn should_hide_page_number(&self) -> bool {
        !self.new_page_numbers.is_empty() && !self.numbering_started
    }

    fn para_first_appears(page: &PageContent, target_pi: usize) -> bool {
        page.column_contents.iter().any(|col| {
            col.items.iter().any(|item| match item {
                PageItem::FullParagraph { para_index } => *para_index == target_pi,
                PageItem::PartialParagraph {
                    para_index,
                    start_line,
                    ..
                } => *para_index == target_pi && *start_line == 0,
                PageItem::Table { para_index, .. } => *para_index == target_pi,
                PageItem::PartialTable {
                    para_index,
                    is_continuation,
                    ..
                } => *para_index == target_pi && !*is_continuation,
                PageItem::Shape { para_index, .. } => *para_index == target_pi,
                PageItem::EndnoteSeparator { .. } => false,
            })
        })
    }
}


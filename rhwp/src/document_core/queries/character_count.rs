//! Read-only character counts from the document model, independent of pagination.
//!
//! The rules follow Hancom's status bar count: every character of the text stream counts,
//! spaces and tabs included, one per code point. Line breaks, auto numbers, objects and
//! master pages do not count. Each field adds its end marker, and an empty click-here field
//! adds the guide text it shows.

use super::super::DocumentCore;
use crate::document_core::helpers::{
    find_logical_control_positions, get_textbox_from_shape, logical_paragraph_length,
    logical_to_text_offset,
};
use crate::error::HwpError;
use crate::model::control::{Control, Field};
use crate::model::paragraph::{FieldRange, Paragraph};
use crate::model::shape::ShapeObject;
use std::ops::RangeBounds;

/// Line breaks and object markers (`U+FFFC`) are layout, not characters.
fn is_counted(ch: char) -> bool {
    ch == '\t' || !(ch.is_control() || ch == '\u{fffc}')
}

/// Text indices of the placeholder spaces auto numbers keep in the text, one per number.
///
/// A parsed placeholder spans a whole control slot (8 UTF-16 units) in `char_offsets`. HWP3
/// files and edits can leave other spans, so any numbers left over take the earliest spaces.
fn number_placeholders(paragraph: &Paragraph) -> Vec<usize> {
    let numbers = paragraph
        .controls
        .iter()
        .filter(|control| matches!(control, Control::AutoNumber(_)))
        .count();
    if numbers == 0 {
        return Vec::new();
    }
    let offsets = &paragraph.char_offsets;
    let text_end = paragraph.char_count.saturating_sub(1);
    let spans_slot = |index: usize| {
        offsets.get(index).is_some_and(|&start| {
            let next = offsets.get(index + 1).copied().unwrap_or(text_end);
            let span = next.saturating_sub(start);
            span >= 8 && span % 8 == 0
        })
    };
    let (mut placeholders, others): (Vec<usize>, Vec<usize>) = paragraph
        .text
        .chars()
        .enumerate()
        .filter(|&(_, ch)| ch == ' ')
        .map(|(index, _)| index)
        .partition(|&index| spans_slot(index));
    placeholders.truncate(numbers);
    let missing = numbers - placeholders.len();
    placeholders.extend(others.into_iter().take(missing));
    placeholders
}

/// Counts the paragraph text in `range` (char indices).
fn count_text(paragraph: &Paragraph, range: impl RangeBounds<usize>) -> usize {
    let placeholders = number_placeholders(paragraph);
    paragraph
        .text
        .chars()
        .enumerate()
        .filter(|&(index, ch)| {
            range.contains(&index) && is_counted(ch) && !placeholders.contains(&index)
        })
        .count()
}

fn field_range(paragraph: &Paragraph, control_index: usize) -> Option<&FieldRange> {
    paragraph
        .field_ranges
        .iter()
        .find(|range| range.control_idx == control_index)
}

fn count_field(paragraph: &Paragraph, control_index: usize, field: &Field) -> usize {
    let empty = field_range(paragraph, control_index)
        .is_some_and(|range| range.start_char_idx == range.end_char_idx);
    let guide = if empty {
        field.guide_text().map_or(0, |guide| guide.chars().count())
    } else {
        0
    };
    1 + guide
}

fn count_shape(shape: &ShapeObject) -> usize {
    let mut count = 0;
    if let Some(text_box) = get_textbox_from_shape(shape) {
        count += count_paragraphs(&text_box.paragraphs);
    }
    let specific_caption = match shape {
        ShapeObject::Group(group) => group.caption.as_ref(),
        ShapeObject::Picture(picture) => picture.caption.as_ref(),
        ShapeObject::Chart(chart) => chart.caption.as_ref(),
        ShapeObject::Ole(ole) => ole.caption.as_ref(),
        _ => None,
    };
    if let Some(caption) =
        specific_caption.or_else(|| shape.drawing().and_then(|drawing| drawing.caption.as_ref()))
    {
        count += count_paragraphs(&caption.paragraphs);
    }
    match shape {
        ShapeObject::Group(group) => {
            count += group.children.iter().map(count_shape).sum::<usize>();
        }
        _ => {}
    }
    count
}

fn count_control(paragraph: &Paragraph, control_index: usize, control: &Control) -> usize {
    match control {
        Control::Table(table) => {
            let cells: usize = table
                .cells
                .iter()
                .map(|cell| count_paragraphs(&cell.paragraphs))
                .sum();
            let caption = table
                .caption
                .as_ref()
                .map_or(0, |caption| count_paragraphs(&caption.paragraphs));
            cells + caption
        }
        Control::Shape(shape) => count_shape(shape),
        Control::Picture(picture) => picture
            .caption
            .as_ref()
            .map_or(0, |caption| count_paragraphs(&caption.paragraphs)),
        Control::Header(header) => count_paragraphs(&header.paragraphs),
        Control::Footer(footer) => count_paragraphs(&footer.paragraphs),
        Control::Footnote(note) => count_paragraphs(&note.paragraphs),
        Control::Endnote(note) => count_paragraphs(&note.paragraphs),
        Control::Field(field) => count_field(paragraph, control_index, field),
        // Hidden comments, equations, ruby and overlapped characters are not counted.
        _ => 0,
    }
}

fn count_paragraphs(paragraphs: &[Paragraph]) -> usize {
    paragraphs
        .iter()
        .map(|paragraph| {
            count_text(paragraph, ..)
                + paragraph
                    .controls
                    .iter()
                    .enumerate()
                    .map(|(index, control)| count_control(paragraph, index, control))
                    .sum::<usize>()
        })
        .sum()
}

fn count_paragraph_range(paragraph: &Paragraph, from: usize, to: usize) -> Result<usize, HwpError> {
    if from > to || to > logical_paragraph_length(paragraph) {
        return Err(HwpError::RenderError(
            "선택 문자 위치가 범위를 벗어났습니다".to_string(),
        ));
    }
    let text_start = logical_to_text_offset(paragraph, from).0;
    let text_end = logical_to_text_offset(paragraph, to).0;
    let mut count = count_text(paragraph, text_start..text_end);
    for (index, (control, logical_pos)) in paragraph
        .controls
        .iter()
        .zip(find_logical_control_positions(paragraph))
        .enumerate()
    {
        // A field's extra character is its end marker, so the selection has to reach it.
        let field_ends_after = matches!(control, Control::Field(_))
            && field_range(paragraph, index).is_some_and(|range| range.end_char_idx > text_end);
        if logical_pos >= from && logical_pos < to && !field_ends_after {
            count += count_control(paragraph, index, control);
        }
    }
    Ok(count)
}

impl DocumentCore {
    /// Every text scope Hancom counts, once each (nested tables included, master pages not).
    pub fn get_document_character_count(&self) -> usize {
        self.document
            .sections
            .iter()
            .map(|section| count_paragraphs(&section.paragraphs))
            .sum()
    }

    /// Count a body selection, including controls whose logical slots are selected.
    pub fn get_body_range_character_count(
        &self,
        start_section: usize,
        start_paragraph: usize,
        start_offset: usize,
        end_section: usize,
        end_paragraph: usize,
        end_offset: usize,
    ) -> Result<usize, HwpError> {
        if (start_section, start_paragraph, start_offset) > (end_section, end_paragraph, end_offset)
        {
            return Err(HwpError::RenderError(
                "선택 범위가 뒤집혔습니다".to_string(),
            ));
        }
        let mut count = 0;
        for section_index in start_section..=end_section {
            let section = self
                .document
                .sections
                .get(section_index)
                .ok_or_else(|| HwpError::RenderError("구역을 찾을 수 없습니다".to_string()))?;
            let first = if section_index == start_section {
                start_paragraph
            } else {
                0
            };
            let last = if section_index == end_section {
                end_paragraph
            } else {
                section.paragraphs.len().saturating_sub(1)
            };
            for paragraph_index in first..=last {
                let paragraph = section
                    .paragraphs
                    .get(paragraph_index)
                    .ok_or_else(|| HwpError::RenderError("문단을 찾을 수 없습니다".to_string()))?;
                let from = if section_index == start_section && paragraph_index == start_paragraph {
                    start_offset
                } else {
                    0
                };
                let to = if section_index == end_section && paragraph_index == end_paragraph {
                    end_offset
                } else {
                    logical_paragraph_length(paragraph)
                };
                count += count_paragraph_range(paragraph, from, to)?;
            }
        }
        Ok(count)
    }

    /// Count the entire innermost cell/text box addressed by a cursor path.
    fn container_paragraphs_by_path(
        &self,
        section: usize,
        parent_paragraph: usize,
        path: &[(usize, usize, usize)],
    ) -> Result<&[Paragraph], HwpError> {
        let Some((last, ancestors)) = path.split_last() else {
            return Err(HwpError::RenderError("경로가 비어있습니다".to_string()));
        };
        let paragraph = if ancestors.is_empty() {
            self.document
                .sections
                .get(section)
                .and_then(|section| section.paragraphs.get(parent_paragraph))
                .ok_or_else(|| HwpError::RenderError("본문 문단을 찾을 수 없습니다".to_string()))?
        } else {
            self.resolve_paragraph_by_path(section, parent_paragraph, ancestors)?
        };
        let paragraphs = match paragraph.controls.get(last.0) {
            Some(Control::Table(table)) => table
                .cells
                .get(last.1)
                .map(|cell| cell.paragraphs.as_slice()),
            Some(Control::Shape(shape)) if last.1 == 0 => {
                get_textbox_from_shape(shape).map(|box_| box_.paragraphs.as_slice())
            }
            Some(Control::Picture(picture)) if last.1 == 0 => picture
                .caption
                .as_ref()
                .map(|caption| caption.paragraphs.as_slice()),
            _ => None,
        }
        .ok_or_else(|| HwpError::RenderError("셀 또는 글상자를 찾을 수 없습니다".to_string()))?;
        Ok(paragraphs)
    }

    pub fn get_container_character_count_by_path(
        &self,
        section: usize,
        parent_paragraph: usize,
        path: &[(usize, usize, usize)],
    ) -> Result<usize, HwpError> {
        Ok(count_paragraphs(self.container_paragraphs_by_path(
            section,
            parent_paragraph,
            path,
        )?))
    }

    pub fn get_container_range_character_count_by_path(
        &self,
        section: usize,
        parent_paragraph: usize,
        path: &[(usize, usize, usize)],
        start_paragraph: usize,
        start_offset: usize,
        end_paragraph: usize,
        end_offset: usize,
    ) -> Result<usize, HwpError> {
        if (start_paragraph, start_offset) > (end_paragraph, end_offset) {
            return Err(HwpError::RenderError(
                "선택 범위가 뒤집혔습니다".to_string(),
            ));
        }
        let paragraphs = self.container_paragraphs_by_path(section, parent_paragraph, path)?;
        let mut count = 0;
        for index in start_paragraph..=end_paragraph {
            let paragraph = paragraphs
                .get(index)
                .ok_or_else(|| HwpError::RenderError("셀 문단을 찾을 수 없습니다".to_string()))?;
            let from = if index == start_paragraph {
                start_offset
            } else {
                0
            };
            let to = if index == end_paragraph {
                end_offset
            } else {
                logical_paragraph_length(paragraph)
            };
            count += count_paragraph_range(paragraph, from, to)?;
        }
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::control::FieldType;
    use crate::model::document::{Document, Section};
    use crate::model::shape::CommonObjAttr;
    use crate::model::table::{Cell, Table};

    #[test]
    fn counts_spaces_and_tabs_but_not_breaks_or_number_placeholders() {
        let body = Paragraph {
            text: "한글 한\t\u{1f469}\u{200d}\u{1f4bb}\n\u{fffc}".into(),
            ..Default::default()
        };
        assert_eq!(count_text(&body, ..), 8);
        // The auto number keeps the first space of a footnote paragraph as its slot.
        let note = Paragraph {
            text: "  각주".into(),
            char_offsets: vec![0, 8, 9, 10],
            char_count: 12,
            controls: vec![Control::AutoNumber(Default::default())],
            ..Default::default()
        };
        assert_eq!(count_text(&note, ..), 3);
        // HWP3 stores the same placeholder one unit wide.
        let hwp3_note = Paragraph {
            char_offsets: vec![0, 1, 2, 3],
            char_count: 5,
            ..note
        };
        assert_eq!(count_text(&hwp3_note, ..), 3);
    }

    #[test]
    fn fields_add_their_end_marker_and_empty_click_here_adds_its_guide() {
        let click_here = Field {
            field_type: FieldType::ClickHere,
            command: Field::build_clickhere_command("입력", ""),
            ..Default::default()
        };
        let hyperlink = Field {
            field_type: FieldType::Hyperlink,
            ..Default::default()
        };
        // "가", an empty click-here field, then a link over "나다".
        let paragraph = Paragraph {
            text: "가나다".into(),
            char_offsets: vec![0, 25, 26],
            char_count: 36,
            controls: vec![Control::Field(click_here), Control::Field(hyperlink)],
            field_ranges: vec![
                FieldRange {
                    start_char_idx: 1,
                    end_char_idx: 1,
                    control_idx: 0,
                    ..Default::default()
                },
                FieldRange {
                    start_char_idx: 1,
                    end_char_idx: 3,
                    control_idx: 1,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        assert_eq!(
            count_paragraphs(std::slice::from_ref(&paragraph)),
            3 + (1 + 2) + 1
        );
        // The link's end marker only counts once the selection reaches it.
        let length = logical_paragraph_length(&paragraph);
        assert_eq!(count_paragraph_range(&paragraph, 0, length).unwrap(), 7);
        assert_eq!(count_paragraph_range(&paragraph, 0, length - 1).unwrap(), 5);
    }

    #[test]
    fn counts_nested_tables_once_and_inner_cell() {
        let inner = Table {
            cells: vec![Cell {
                paragraphs: vec![Paragraph {
                    text: "안쪽".into(),
                    ..Default::default()
                }],
                ..Default::default()
            }],
            common: CommonObjAttr {
                treat_as_char: true,
                ..Default::default()
            },
            ..Default::default()
        };
        let outer = Table {
            cells: vec![Cell {
                paragraphs: vec![Paragraph {
                    text: "바깥".into(),
                    char_offsets: vec![0, 1],
                    controls: vec![Control::Table(Box::new(inner))],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            common: CommonObjAttr {
                treat_as_char: true,
                ..Default::default()
            },
            ..Default::default()
        };
        let document = Document {
            sections: vec![Section {
                paragraphs: vec![Paragraph {
                    text: "본문".into(),
                    char_offsets: vec![0, 1],
                    controls: vec![Control::Table(Box::new(outer))],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let mut core = DocumentCore::new_empty();
        core.document = document;
        assert_eq!(core.get_document_character_count(), 6);
        assert_eq!(
            core.get_container_character_count_by_path(0, 0, &[(0, 0, 0)])
                .unwrap(),
            4
        );
        assert_eq!(
            core.get_container_character_count_by_path(0, 0, &[(0, 0, 0), (0, 0, 0)])
                .unwrap(),
            2
        );
        assert_eq!(
            logical_paragraph_length(&core.document.sections[0].paragraphs[0]),
            3
        );
        let Control::Table(table) = &core.document.sections[0].paragraphs[0].controls[0] else {
            panic!("table")
        };
        assert_eq!(logical_paragraph_length(&table.cells[0].paragraphs[0]), 3);
        assert_eq!(
            core.get_body_range_character_count(0, 0, 0, 0, 0, 3)
                .unwrap(),
            6
        );
        assert_eq!(
            core.get_body_range_character_count(0, 0, 0, 0, 0, 2)
                .unwrap(),
            2
        );
        assert_eq!(
            core.get_container_range_character_count_by_path(0, 0, &[(0, 0, 0)], 0, 0, 0, 3)
                .unwrap(),
            4
        );
        assert_eq!(
            core.get_container_range_character_count_by_path(0, 0, &[(0, 0, 0)], 0, 0, 0, 2)
                .unwrap(),
            2
        );
    }
}

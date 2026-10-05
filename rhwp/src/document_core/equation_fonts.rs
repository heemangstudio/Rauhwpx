//! 본문과 중첩 컨트롤에서 수식 글꼴을 수집한다.

use crate::model::{
    control::Control,
    document::Document,
    paragraph::Paragraph,
    shape::{Caption, ShapeObject},
};
use std::collections::BTreeSet;

pub(super) fn collect(document: &Document, fonts: &mut BTreeSet<String>) {
    for section in &document.sections {
        collect_paragraphs(&section.paragraphs, fonts);
        for master in &section.section_def.master_pages {
            collect_paragraphs(&master.paragraphs, fonts);
        }
    }
}

fn collect_caption(caption: &Option<Caption>, fonts: &mut BTreeSet<String>) {
    if let Some(caption) = caption {
        collect_paragraphs(&caption.paragraphs, fonts);
    }
}

fn collect_shape(shape: &ShapeObject, fonts: &mut BTreeSet<String>) {
    if let Some(drawing) = shape.drawing() {
        if let Some(text_box) = &drawing.text_box {
            collect_paragraphs(&text_box.paragraphs, fonts);
        }
        collect_caption(&drawing.caption, fonts);
    }
    match shape {
        ShapeObject::Group(group) => {
            collect_caption(&group.caption, fonts);
            for child in &group.children {
                collect_shape(child, fonts);
            }
        }
        ShapeObject::Picture(picture) => collect_caption(&picture.caption, fonts),
        ShapeObject::Chart(chart) => collect_caption(&chart.caption, fonts),
        ShapeObject::Ole(ole) => collect_caption(&ole.caption, fonts),
        _ => {}
    }
}

fn collect_paragraphs(paragraphs: &[Paragraph], fonts: &mut BTreeSet<String>) {
    for para in paragraphs {
        for control in &para.controls {
            match control {
                Control::Equation(equation) => {
                    let name = equation.font_name.trim();
                    if !name.is_empty() {
                        fonts.insert(name.to_owned());
                    }
                }
                Control::Table(table) => {
                    for cell in &table.cells {
                        collect_paragraphs(&cell.paragraphs, fonts);
                    }
                    collect_caption(&table.caption, fonts);
                }
                Control::Shape(shape) => collect_shape(shape, fonts),
                Control::Picture(picture) => collect_caption(&picture.caption, fonts),
                Control::Header(header) => collect_paragraphs(&header.paragraphs, fonts),
                Control::Footer(footer) => collect_paragraphs(&footer.paragraphs, fonts),
                Control::Footnote(note) => collect_paragraphs(&note.paragraphs, fonts),
                Control::Endnote(note) => collect_paragraphs(&note.paragraphs, fonts),
                Control::HiddenComment(comment) => collect_paragraphs(&comment.paragraphs, fonts),
                Control::Field(field) => collect_paragraphs(&field.memo_paragraphs, fonts),
                Control::SectionDef(section_def) => {
                    for master in &section_def.master_pages {
                        collect_paragraphs(&master.paragraphs, fonts);
                    }
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        control::Equation,
        document::Section,
        header_footer::{Header, MasterPage},
        shape::{DrawingObjAttr, GroupShape, RectangleShape, TextBox},
        table::{Cell, Table},
    };

    fn equation(font: &str) -> Paragraph {
        Paragraph {
            controls: vec![Control::Equation(Box::new(Equation {
                font_name: font.to_owned(),
                ..Default::default()
            }))],
            ..Default::default()
        }
    }

    #[test]
    fn finds_equation_fonts_in_nested_content_without_doc_info_entries() {
        let drawing = ShapeObject::Rectangle(RectangleShape {
            drawing: DrawingObjAttr {
                text_box: Some(TextBox {
                    paragraphs: vec![equation("HYhwpEQ")],
                    ..Default::default()
                }),
                ..Default::default()
            },
            ..Default::default()
        });
        let group = ShapeObject::Group(GroupShape {
            children: vec![drawing],
            caption: Some(Caption {
                paragraphs: vec![equation("Caption Eq")],
                ..Default::default()
            }),
            ..Default::default()
        });
        let table = Table {
            cells: vec![Cell {
                paragraphs: vec![Paragraph {
                    controls: vec![Control::Shape(Box::new(group))],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let mut section = Section::default();
        section.paragraphs = vec![
            Paragraph {
                controls: vec![Control::Header(Box::new(Header {
                    paragraphs: vec![Paragraph {
                        controls: vec![Control::Table(Box::new(table))],
                        ..Default::default()
                    }],
                    ..Default::default()
                }))],
                ..Default::default()
            },
            equation("HYhwpEQ"),
            equation("   "),
        ];
        section.section_def.master_pages.push(MasterPage {
            paragraphs: vec![equation("Master Eq")],
            ..Default::default()
        });
        let document = Document {
            sections: vec![section],
            ..Default::default()
        };
        let mut fonts = BTreeSet::new();
        collect(&document, &mut fonts);
        assert_eq!(
            fonts.into_iter().collect::<Vec<_>>(),
            vec!["Caption Eq", "HYhwpEQ", "Master Eq"]
        );
    }
}

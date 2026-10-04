//! 문서 생성/로딩/저장/설정 관련 native 메서드

use crate::document_core::validation::{
    CellPath, ValidationReport, ValidationWarning, WarningKind,
};
use crate::document_core::{
    DocumentCore, DocumentEventLog, DocumentSnapshot, SnapshotParagraph, SnapshotSection,
    DEFAULT_FALLBACK_FONT,
};
use crate::error::HwpError;
use crate::model::control::Control;
use crate::model::document::{Document, Section};
use crate::model::paragraph::{LineSeg, Paragraph};
use crate::model::provenance::LayoutCompatibilityProfile;
use crate::model::shape::{Caption, DrawingObjAttr, ShapeObject};
use crate::renderer::composer::{
    compose_section, reflow_line_segs, reflow_line_segs_with_exclusions,
};
use crate::renderer::float_placement::FloatExclusion;
use crate::renderer::layout::LayoutEngine;
use crate::renderer::page_layout::PageLayoutInfo;
use crate::renderer::style_resolver::{resolve_styles, ResolvedStyleSet};
use crate::renderer::{px_to_hwpunit, DEFAULT_DPI};
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

/// HWP 내보내기 + 자기 재로드 검증 결과 (#178 Stage 6).
///
/// `serialize_hwp_with_verify` 의 반환값. 호출자가 페이지 회복 여부를 확인하고
/// 실패 시 사용자에게 경고하거나 다른 동작을 취할 수 있게 한다.
#[derive(Debug, Clone)]
pub struct HwpExportVerification {
    /// 직렬화된 HWP 바이트
    pub bytes: Vec<u8>,
    /// 바이트 길이 (편의)
    pub bytes_len: usize,
    /// 어댑터 적용 직전 페이지 수
    pub page_count_before: u32,
    /// 직렬화 → 재로드 후 페이지 수
    pub page_count_after: u32,
    /// 페이지 수 일치 여부
    pub page_count_matches: bool,
    /// 직렬화 입력의 구조 카운트
    pub structure_before: HwpStructureCounts,
    /// 직렬화 → 재로드 후 구조 카운트
    pub structure_after: HwpStructureCounts,
    /// text/control/object/opaque payload 카운트가 모두 일치하는지 여부
    pub structure_matches: bool,
    /// 직렬화 전 탐지되었거나 재로드 비교에서 확인된 손실 진단.
    /// 빈 배열이 아니면 `recovered` 는 false다.
    pub serialization_losses: Vec<String>,
    /// 페이지와 구조가 모두 일치하고 명시적 손실 진단도 없는 경우에만 true.
    pub recovered: bool,
}

#[cfg(test)]
mod caption_line_synthesis_tests {
    use super::*;
    use crate::model::document::Section;
    use crate::model::paragraph::{CharShapeRef, LineSeg};
    use crate::model::shape::{CaptionDirection, GroupShape, RectangleShape};
    use crate::renderer::style_resolver::{ResolvedCharStyle, ResolvedParaStyle};

    fn styles() -> ResolvedStyleSet {
        ResolvedStyleSet {
            char_styles: vec![ResolvedCharStyle {
                font_size: 700.0 / 75.0,
                ..Default::default()
            }],
            para_styles: vec![ResolvedParaStyle {
                line_spacing: 150.0,
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    fn caption_paragraph() -> Paragraph {
        Paragraph {
            text: "캡션".into(),
            char_offsets: vec![0, 1],
            char_shapes: vec![CharShapeRef::default()],
            ..Default::default()
        }
    }

    fn rectangle() -> RectangleShape {
        let mut shape = RectangleShape::default();
        shape.common.treat_as_char = true;
        shape.common.width = 12_000;
        shape.common.height = 5_000;
        shape.drawing.caption = Some(Caption {
            direction: CaptionDirection::Top,
            spacing: 141,
            max_width: 12_000,
            paragraphs: vec![caption_paragraph()],
            ..Default::default()
        });
        shape
    }

    #[test]
    fn note_float_wrap_expires_and_resets_without_changing_saved_lines() {
        use crate::model::footnote::{Endnote, Footnote};
        use crate::model::image::Picture;
        use crate::model::page::PageDef;
        use crate::model::shape::{CommonObjAttr, HorzRelTo, TextWrap, VertRelTo};

        fn paragraph(text: &str) -> Paragraph {
            Paragraph {
                text: text.into(),
                char_offsets: (0..text.chars().count() as u32).collect(),
                char_shapes: vec![CharShapeRef::default()],
                ..Default::default()
            }
        }
        fn note_paragraphs(control: &Control) -> &[Paragraph] {
            match control {
                Control::Footnote(note) => &note.paragraphs,
                Control::Endnote(note) => &note.paragraphs,
                _ => unreachable!(),
            }
        }
        let cache = |document: &Document| {
            document.sections[0].paragraphs[0]
                .controls
                .iter()
                .flat_map(note_paragraphs)
                .map(|para| {
                    para.line_segs
                        .iter()
                        .map(|s| {
                            (
                                s.text_start,
                                s.vertical_pos,
                                s.line_height,
                                s.text_height,
                                s.baseline_distance,
                                s.line_spacing,
                                s.column_start,
                                s.segment_width,
                                s.tag,
                            )
                        })
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>()
        };
        let mut styles = styles();
        styles.char_styles[0].font_size = 12.0;
        for footnote in [false, true] {
            // 짧은 그림은 다음 문단 전에 끝나고, 긴 그림도 다음 주석으로 넘어가지 않는다.
            for (height, following_width, tail_width) in [
                (900, 10_000, 10_000),
                (3_000, 5_000, 10_000),
                (30_000, 5_000, 5_000),
            ] {
                let make_note = |paragraphs| {
                    if footnote {
                        Control::Footnote(Box::new(Footnote {
                            paragraphs,
                            ..Default::default()
                        }))
                    } else {
                        Control::Endnote(Box::new(Endnote {
                            paragraphs,
                            ..Default::default()
                        }))
                    }
                };
                let mut anchor = paragraph("가");
                anchor.char_offsets[0] = 8;
                anchor.controls.push(Control::Picture(Box::new(Picture {
                    common: CommonObjAttr {
                        width: 5_000,
                        height,
                        horizontal_offset: 5_000,
                        flow_with_text: true,
                        text_wrap: TextWrap::Square,
                        vert_rel_to: VertRelTo::Para,
                        horz_rel_to: HorzRelTo::Para,
                        ..Default::default()
                    },
                    ..Default::default()
                })));
                let mut section = Section {
                    paragraphs: vec![Paragraph {
                        controls: vec![
                            make_note(vec![
                                anchor,
                                paragraph("가나다라마바사아"),
                                paragraph("가나다라마바사아"),
                            ]),
                            make_note(vec![paragraph("가나다라마바사아")]),
                        ],
                        ..Default::default()
                    }],
                    ..Default::default()
                };
                section.section_def.page_def = PageDef {
                    width: 10_000,
                    height: 60_000,
                    ..Default::default()
                };
                let mut doc = Document {
                    sections: vec![section],
                    ..Default::default()
                };
                DocumentCore::reflow_zero_height_paragraphs(
                    &mut doc, &styles, 96.0, true, false, true,
                );
                let controls = &doc.sections[0].paragraphs[0].controls;
                let first = note_paragraphs(&controls[0]);
                assert_eq!(first[1].line_segs[0].segment_width, following_width);
                assert_eq!(first[2].line_segs[0].segment_width, tail_width);
                assert_eq!(
                    first[1].line_segs.len(),
                    if following_width == 5_000 { 2 } else { 1 }
                );
                let next = note_paragraphs(&controls[1]);
                assert_eq!(next[0].line_segs.len(), 1);
                assert_eq!(next[0].line_segs[0].segment_width, 10_000);

                for control in &mut doc.sections[0].paragraphs[0].controls {
                    let paragraphs = match control {
                        Control::Footnote(note) => &mut note.paragraphs,
                        Control::Endnote(note) => &mut note.paragraphs,
                        _ => unreachable!(),
                    };
                    for para in paragraphs {
                        for line in &mut para.line_segs {
                            line.tag &= !LineSeg::TAG_IMPLEMENTATION_PROPERTY;
                            line.vertical_pos += 321;
                            line.segment_width += 76;
                        }
                    }
                }
                let saved = cache(&doc);
                DocumentCore::reflow_zero_height_paragraphs(
                    &mut doc, &styles, 96.0, true, false, false,
                );
                assert_eq!(cache(&doc), saved);
            }
        }
    }

    #[test]
    fn missing_shape_caption_is_composed_before_its_inline_host() {
        let mut doc = Document {
            sections: vec![Section {
                paragraphs: vec![Paragraph {
                    char_shapes: vec![CharShapeRef::default()],
                    controls: vec![Control::Shape(Box::new(
                        ShapeObject::Rectangle(rectangle()),
                    ))],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        DocumentCore::reflow_zero_height_paragraphs(&mut doc, &styles(), 96.0, true, false, true);
        let host = &doc.sections[0].paragraphs[0];
        assert_eq!(host.line_segs[0].line_height, 5_841);
        let Control::Shape(shape) = &host.controls[0] else {
            unreachable!()
        };
        let caption = shape.drawing().unwrap().caption.as_ref().unwrap();
        let line = &caption.paragraphs[0].line_segs[0];
        assert_eq!(line.line_height, 700);
        assert_ne!(line.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY, 0);
    }

    #[test]
    fn nested_caption_synthesis_preserves_saved_anchors_between_missing_paragraphs() {
        let mut shape = rectangle();
        let caption = shape.drawing.caption.as_mut().unwrap();
        let mut saved = caption_paragraph();
        saved.line_segs.push(LineSeg {
            vertical_pos: 5_000,
            line_height: 777,
            text_height: 777,
            baseline_distance: 660,
            line_spacing: 400,
            segment_width: 9_876,
            tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
            ..Default::default()
        });
        caption.paragraphs.extend([saved, caption_paragraph()]);
        let mut group = ShapeObject::Group(GroupShape {
            children: vec![ShapeObject::Rectangle(shape)],
            ..Default::default()
        });
        DocumentCore::synthesize_missing_shape_captions(
            &mut group,
            &styles(),
            96.0,
            false,
            LayoutCompatibilityProfile::default(),
        );
        let ShapeObject::Group(group) = group else {
            unreachable!()
        };
        let caption = group.children[0]
            .drawing()
            .unwrap()
            .caption
            .as_ref()
            .unwrap();
        let paras = &caption.paragraphs;
        let saved = &paras[1].line_segs[0];
        assert_eq!(
            (
                saved.vertical_pos,
                saved.line_height,
                saved.text_height,
                saved.baseline_distance,
                saved.line_spacing,
                saved.segment_width,
                saved.tag
            ),
            (
                5_000,
                777,
                777,
                660,
                400,
                9_876,
                LineSeg::TAG_SINGLE_SEGMENT_LINE
            ),
        );
        assert_eq!(paras[0].line_segs[0].line_height, 700);
        assert_eq!(paras[2].line_segs[0].vertical_pos, 6_177);
        assert_eq!(paras[2].line_segs[0].line_height, 700);
    }

    #[test]
    fn missing_masterpage_object_lines_match_body_objects_and_preserve_cached_lines() {
        use crate::model::header_footer::MasterPage;
        use crate::model::table::{Cell, Table};

        let host = Paragraph {
            char_shapes: vec![CharShapeRef::default()],
            controls: vec![Control::Shape(Box::new(
                ShapeObject::Rectangle(rectangle()),
            ))],
            ..Default::default()
        };
        let mut saved = caption_paragraph();
        saved.line_segs.push(LineSeg {
            vertical_pos: 321,
            line_height: 777,
            text_height: 765,
            baseline_distance: 660,
            line_spacing: 400,
            segment_width: 9_876,
            tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
            ..Default::default()
        });
        let table = Table {
            row_count: 1,
            col_count: 2,
            cells: vec![
                Cell {
                    width: 20_000,
                    paragraphs: vec![host, caption_paragraph()],
                    ..Default::default()
                },
                Cell {
                    col: 1,
                    width: 20_000,
                    paragraphs: vec![saved.clone()],
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let anchor = Paragraph {
            controls: vec![Control::Table(Box::new(table))],
            ..Default::default()
        };
        let mut section = Section {
            paragraphs: vec![anchor.clone()],
            ..Default::default()
        };
        section.section_def.master_pages.push(MasterPage {
            paragraphs: vec![anchor],
            ..Default::default()
        });
        let mut doc = Document {
            sections: vec![section],
            ..Default::default()
        };
        let mut mixed = doc.clone();
        DocumentCore::reflow_zero_height_paragraphs(
            &mut mixed,
            &styles(),
            96.0,
            true,
            false,
            false,
        );
        let Control::Table(master) =
            &mixed.sections[0].section_def.master_pages[0].paragraphs[0].controls[0]
        else {
            unreachable!()
        };
        assert!(master.cells[0].paragraphs[0].line_segs.is_empty());
        assert!(master.cells[0].paragraphs[1].line_segs.is_empty());

        DocumentCore::reflow_zero_height_paragraphs(&mut doc, &styles(), 96.0, true, false, true);
        let master_anchor = &doc.sections[0].section_def.master_pages[0].paragraphs[0];
        assert!(master_anchor.line_segs.is_empty());
        let Control::Table(body) = &doc.sections[0].paragraphs[0].controls[0] else {
            unreachable!()
        };
        let Control::Table(master) = &master_anchor.controls[0] else {
            unreachable!()
        };
        let metrics = |p: &Paragraph| {
            p.line_segs
                .iter()
                .map(|s| {
                    (
                        s.vertical_pos,
                        s.line_height,
                        s.text_height,
                        s.baseline_distance,
                        s.line_spacing,
                        s.segment_width,
                        s.tag,
                    )
                })
                .collect::<Vec<_>>()
        };
        for (actual, expected) in master.cells[0]
            .paragraphs
            .iter()
            .zip(&body.cells[0].paragraphs)
        {
            assert!(!actual.line_segs.is_empty());
            assert_eq!(metrics(actual), metrics(expected));
        }
        assert_eq!(
            master.cells[0].paragraphs[0].line_segs[0].line_height,
            5_841
        );
        assert_eq!(metrics(&master.cells[1].paragraphs[0]), metrics(&saved));

        let mut seed = DocumentCore::new_empty();
        seed.create_blank_document_native().unwrap();
        doc.doc_info = seed.document().doc_info.clone();
        let bytes = crate::serializer::hwpx::serialize_hwpx(&doc).unwrap();
        let core = DocumentCore::from_bytes_ignoring_stored_linesegs(&bytes).unwrap();
        assert!(core.document().provenance.own_line_layout);
        let section = &core.document().sections[0];
        let body = section.paragraphs[0]
            .controls
            .iter()
            .find_map(|control| match control {
                Control::Table(table) => Some(table),
                _ => None,
            })
            .unwrap();
        let Control::Table(master) = &section.section_def.master_pages[0].paragraphs[0].controls[0]
        else {
            unreachable!()
        };
        for (actual, expected) in master.cells.iter().zip(&body.cells) {
            for (actual, expected) in actual.paragraphs.iter().zip(&expected.paragraphs) {
                assert_eq!(metrics(actual), metrics(expected));
            }
        }
    }
}

#[cfg(test)]
mod generated_body_float_tests {
    use super::*;
    use crate::model::image::Picture;
    use crate::model::paragraph::{CharShapeRef, ColumnBreakType};
    use crate::model::shape::{HorzAlign, HorzRelTo, TextWrap, VertAlign, VertRelTo};
    use crate::renderer::style_resolver::{ResolvedCharStyle, ResolvedParaStyle};

    fn paragraph(text: &str) -> Paragraph {
        Paragraph {
            text: text.into(),
            char_offsets: (0..text.len() as u32).collect(),
            char_shapes: vec![CharShapeRef::default()],
            ..Default::default()
        }
    }

    fn fixture(left: bool) -> (Document, ResolvedStyleSet) {
        let styles = ResolvedStyleSet {
            char_styles: vec![ResolvedCharStyle {
                font_size: 16.0,
                ..Default::default()
            }],
            para_styles: vec![ResolvedParaStyle {
                line_spacing: 150.0,
                margin_left: 10.0,
                margin_right: 10.0,
                ..Default::default()
            }],
            ..Default::default()
        };
        let mut picture = Picture::default();
        picture.common.width = 15_000;
        picture.common.height = 7_200;
        picture.common.vertical_offset = 1_800;
        picture.common.flow_with_text = true;
        picture.common.text_wrap = TextWrap::Square;
        picture.common.vert_rel_to = VertRelTo::Para;
        picture.common.vert_align = VertAlign::Top;
        picture.common.horz_rel_to = HorzRelTo::Column;
        picture.common.horz_align = if left {
            HorzAlign::Left
        } else {
            HorzAlign::Right
        };
        picture.common.margin.right = if left { 600 } else { 0 };
        let mut host = paragraph("anchor");
        host.controls.push(Control::Picture(Box::new(picture)));
        let mut section = Section::default();
        section.section_def.page_def.width = 30_000;
        section.section_def.page_def.height = 60_000;
        section.section_def.page_def.margin_left = 0;
        section.section_def.page_def.margin_right = 0;
        section.section_def.page_def.margin_top = 0;
        section.section_def.page_def.margin_bottom = 0;
        section.section_def.page_def.margin_header = 0;
        section.section_def.page_def.margin_footer = 0;
        section.paragraphs = vec![
            host,
            paragraph("first\nsecond"),
            paragraph("third\nfourth"),
            paragraph("after"),
        ];
        (
            Document {
                sections: vec![section],
                ..Default::default()
            },
            styles,
        )
    }

    fn compose(document: &mut Document, styles: &ResolvedStyleSet, own: bool) {
        DocumentCore::reflow_zero_height_paragraphs(document, styles, 96.0, true, false, own);
    }

    fn widths(paragraph: &Paragraph) -> Vec<(u32, i32, i32)> {
        paragraph
            .line_segs
            .iter()
            .map(|s| (s.text_start, s.column_start, s.segment_width))
            .collect()
    }

    #[test]
    fn generated_body_float_carries_across_paragraphs_and_expires() {
        for left in [false, true] {
            let (mut document, styles) = fixture(left);
            compose(&mut document, &styles, true);
            let p = &document.sections[0].paragraphs;
            let full_width = p[3].line_segs[0].segment_width;
            for para in &p[1..3] {
                assert!(para.line_segs.iter().all(|s| s.segment_width < full_width));
                assert!(para
                    .line_segs
                    .iter()
                    .all(|s| s.column_start == if left { 15_600 } else { 750 }));
            }
            assert_eq!(p[3].line_segs[0].column_start, 750);
        }
    }

    #[test]
    fn generated_body_float_stays_with_resolvable_page_flow() {
        for mode in 0..8 {
            let (mut document, styles) = fixture(false);
            let p = &mut document.sections[0].paragraphs;
            match mode {
                0 => p[1].column_type = ColumnBreakType::Page,
                1 => p[1].column_type = ColumnBreakType::Column,
                2 => {
                    let Control::Picture(pic) = &mut p[0].controls[0] else {
                        unreachable!()
                    };
                    pic.common.height = 65_000;
                }
                3 => p[1] = paragraph(&vec!["line"; 40].join("\n")),
                4 | 5 => {
                    let Control::Picture(pic) = &mut p[0].controls[0] else {
                        unreachable!()
                    };
                    pic.common.text_wrap = if mode == 4 {
                        TextWrap::TopAndBottom
                    } else {
                        TextWrap::BehindText
                    };
                }
                6 => p[1].controls.push(Control::ColumnDef(Default::default())),
                7 => reflow_line_segs(&mut p[1], 380.0, &styles, 96.0),
                _ => unreachable!(),
            }
            let mut baseline = document.clone();
            compose(&mut baseline, &styles, false);
            compose(&mut document, &styles, true);
            for (actual, expected) in document.sections[0].paragraphs[1..]
                .iter()
                .zip(&baseline.sections[0].paragraphs[1..])
            {
                assert_eq!(widths(actual), widths(expected), "mode {mode}");
            }
        }
    }
}

#[cfg(test)]
mod synthetic_percent_line_spacing_tests {
    use super::*;
    use crate::model::paragraph::{CharShapeRef, LineSeg};
    use crate::model::table::{Cell, Table};
    use crate::renderer::style_resolver::{ResolvedCharStyle, ResolvedParaStyle};

    fn paragraph(tag: u32) -> Paragraph {
        Paragraph {
            text: "가".to_string(),
            char_shapes: vec![CharShapeRef::default()],
            line_segs: vec![LineSeg {
                line_height: 1_000,
                text_height: 1_000,
                line_spacing: 350,
                tag,
                ..LineSeg::default()
            }],
            ..Paragraph::default()
        }
    }

    #[test]
    fn projects_generated_percent_pitch_through_nested_tables_without_changing_source() {
        let synthetic = LineSeg::TAG_SINGLE_SEGMENT_LINE | LineSeg::TAG_IMPLEMENTATION_PROPERTY;
        let styles = ResolvedStyleSet {
            char_styles: vec![ResolvedCharStyle {
                font_family: "__rhwp_missing_font_for_pitch_test__".to_string(),
                font_size: crate::renderer::hwpunit_to_px(1_000, 96.0),
                ..ResolvedCharStyle::default()
            }],
            para_styles: vec![ResolvedParaStyle {
                line_spacing: 135.0,
                ..ResolvedParaStyle::default()
            }],
            ..ResolvedStyleSet::default()
        };
        let mut nested = Table::default();
        nested.cells.push(Cell {
            paragraphs: vec![paragraph(synthetic)],
            ..Cell::default()
        });
        let mut outer = Table::default();
        outer.cells.push(Cell {
            paragraphs: vec![Paragraph {
                controls: vec![Control::Table(Box::new(nested))],
                ..Paragraph::default()
            }],
            ..Cell::default()
        });
        let source = vec![
            paragraph(synthetic),
            paragraph(LineSeg::TAG_SINGLE_SEGMENT_LINE),
            Paragraph {
                controls: vec![Control::Table(Box::new(outer))],
                ..Paragraph::default()
            },
        ];
        let mut projected = source.clone();
        assert!(DocumentCore::project_synthetic_percent_line_spacing(
            &mut projected,
            &styles,
            96.0,
        ));

        let expected_pitch = 1_000.0 * 1.3 * 1.3 * 1.35;
        let projected_line = &projected[0].line_segs[0];
        assert_eq!(projected_line.line_height, 1_000);
        assert_eq!(
            projected_line.baseline_distance,
            source[0].line_segs[0].baseline_distance
        );
        assert!(
            (f64::from(projected_line.line_height + projected_line.line_spacing) - expected_pitch)
                .abs()
                <= 1.0
        );
        assert_eq!(projected[1].line_segs[0].line_spacing, 350);
        assert_eq!(source[0].line_segs[0].line_spacing, 350);

        let Control::Table(outer) = &projected[2].controls[0] else {
            panic!("outer table")
        };
        let Control::Table(nested) = &outer.cells[0].paragraphs[0].controls[0] else {
            panic!("nested table")
        };
        assert_eq!(
            nested.cells[0].paragraphs[0].line_segs[0].line_spacing,
            projected_line.line_spacing
        );

        let mut empty = paragraph(synthetic);
        empty.text.clear();
        let mut empty_projection = vec![empty];
        assert!(DocumentCore::project_synthetic_percent_line_spacing(
            &mut empty_projection,
            &styles,
            96.0,
        ));
        // A line with no glyphs uses the Latin face, even when the paragraph's
        // Hangul face would have a larger CJK line box.
        let empty_pitch = 1_000.0 * 1.3 * 1.35;
        assert!(
            (f64::from(
                empty_projection[0].line_segs[0].line_height
                    + empty_projection[0].line_segs[0].line_spacing
            ) - empty_pitch)
                .abs()
                <= 1.0
        );
    }

    #[test]
    fn projection_uses_font_registered_after_source_was_loaded() {
        const FONT: &[u8] = include_bytes!("../../../tests/fixtures/fonts/RHWPShapingFixture.ttf");
        let face = "__rhwp_late_pitch_fixture__";
        let styles = ResolvedStyleSet {
            char_styles: vec![ResolvedCharStyle {
                font_family: face.to_string(),
                font_size: crate::renderer::hwpunit_to_px(1_000, 96.0),
                ..ResolvedCharStyle::default()
            }],
            para_styles: vec![ResolvedParaStyle {
                line_spacing: 135.0,
                ..ResolvedParaStyle::default()
            }],
            ..ResolvedStyleSet::default()
        };
        let source = vec![paragraph(LineSeg::TAG_IMPLEMENTATION_PROPERTY)];
        let mut before = source.clone();
        assert!(DocumentCore::project_synthetic_percent_line_spacing(
            &mut before,
            &styles,
            96.0,
        ));
        crate::renderer::runtime_font_metrics::register(FONT, &[face.to_string()], false, false)
            .expect("register runtime font");
        let mut after = source.clone();
        assert!(DocumentCore::project_synthetic_percent_line_spacing(
            &mut after, &styles, 96.0,
        ));
        let mut latin = vec![Paragraph {
            text: "ABC".to_string(),
            ..paragraph(LineSeg::TAG_IMPLEMENTATION_PROPERTY)
        }];
        assert!(DocumentCore::project_synthetic_percent_line_spacing(
            &mut latin, &styles, 96.0,
        ));
        crate::renderer::runtime_font_metrics::clear();

        assert_eq!(source[0].line_segs[0].line_spacing, 350);
        assert_eq!(source[0].line_segs[0].baseline_distance, 0);
        assert!(after[0].line_segs[0].line_spacing < before[0].line_segs[0].line_spacing);
        assert_eq!(before[0].line_segs[0].baseline_distance, 0);
        assert_eq!(after[0].line_segs[0].baseline_distance, 950);
        assert_eq!(
            latin[0].line_segs[0].line_height + latin[0].line_segs[0].line_spacing,
            1_350
        );
        assert_eq!(latin[0].line_segs[0].baseline_distance, 800);
        assert!(
            (f64::from(after[0].line_segs[0].line_height + after[0].line_segs[0].line_spacing)
                - 1_000.0 * 1.0 * 1.3 * 1.35)
                .abs()
                <= 1.0
        );
    }

    #[test]
    fn generated_empty_line_uses_latin_face_when_script_faces_differ() {
        struct ClearFontMetrics;
        impl Drop for ClearFontMetrics {
            fn drop(&mut self) {
                crate::renderer::runtime_font_metrics::clear();
            }
        }
        let _clear_font_metrics = ClearFontMetrics;
        const FONT: &[u8] = include_bytes!("../../../tests/fixtures/fonts/RHWPShapingFixture.ttf");
        let latin_face = "__rhwp_empty_latin_fixture__";
        crate::renderer::runtime_font_metrics::register(
            FONT,
            &[latin_face.to_string()],
            false,
            false,
        )
        .expect("register Latin face");
        let styles = ResolvedStyleSet {
            char_styles: vec![ResolvedCharStyle {
                font_family: "__rhwp_missing_empty_hangul_face__".to_string(),
                font_families: vec![
                    "__rhwp_missing_empty_hangul_face__".to_string(),
                    latin_face.to_string(),
                ],
                font_size: crate::renderer::hwpunit_to_px(1_000, 96.0),
                ..ResolvedCharStyle::default()
            }],
            para_styles: vec![ResolvedParaStyle {
                line_spacing: 135.0,
                ..ResolvedParaStyle::default()
            }],
            ..ResolvedStyleSet::default()
        };
        let tag = LineSeg::TAG_IMPLEMENTATION_PROPERTY;
        let mut empty = paragraph(tag);
        empty.text.clear();
        let mut projected = vec![paragraph(tag), empty];
        assert!(DocumentCore::project_synthetic_percent_line_spacing(
            &mut projected,
            &styles,
            96.0,
        ));
        let visible_pitch =
            projected[0].line_segs[0].line_height + projected[0].line_segs[0].line_spacing;
        let empty_pitch =
            projected[1].line_segs[0].line_height + projected[1].line_segs[0].line_spacing;
        assert!((f64::from(visible_pitch) - 1_000.0 * 1.3 * 1.3 * 1.35).abs() <= 1.0);
        assert!((f64::from(empty_pitch) - 1_000.0 * 1.35).abs() <= 1.0);
    }

    #[test]
    fn generated_equation_width_uses_script_metrics_without_touching_authored_widths() {
        const FONT: &[u8] = include_bytes!("../../../tests/fixtures/fonts/RHWPShapingFixture.ttf");
        struct MetricsGuard;
        impl Drop for MetricsGuard {
            fn drop(&mut self) {
                crate::renderer::runtime_font_metrics::clear();
            }
        }
        let _metrics = MetricsGuard;
        let face = "__rhwp_generated_equation_width_fixture__";
        crate::renderer::runtime_font_metrics::register(FONT, &[face.to_string()], false, false)
            .unwrap();
        let mut eq = crate::model::control::Equation::default();
        eq.font_name = face.to_string();
        eq.font_size = 1_000;
        eq.script = "x + y".to_string();
        eq.common.treat_as_char = true;
        eq.common.width = 100;
        let narrow = Paragraph {
            controls: vec![Control::Equation(Box::new(eq.clone()))],
            line_segs: vec![LineSeg {
                line_height: 2_000,
                line_spacing: 500,
                tag: LineSeg::TAG_IMPLEMENTATION_PROPERTY,
                ..Default::default()
            }],
            ..Default::default()
        };
        let mut wide = narrow.clone();
        if let Control::Equation(eq) = &mut wide.controls[0] {
            eq.common.width = 90_000;
        }
        let mut authored = narrow.clone();
        authored.line_segs[0].tag = 0;
        let source = vec![narrow.clone(), wide.clone(), authored];
        let mut projected = source.clone();
        assert!(DocumentCore::project_synthetic_percent_line_spacing(
            &mut projected,
            &ResolvedStyleSet::default(),
            96.0
        ));
        let width = |p: &Paragraph| match &p.controls[0] {
            Control::Equation(eq) => eq.common.width,
            _ => unreachable!(),
        };
        assert_eq!(width(&projected[0]), width(&projected[1]));
        assert!(width(&projected[0]) > 100 && width(&projected[0]) < 90_000);
        assert_eq!(width(&projected[2]), 100);
        assert_eq!(width(&source[0]), 100);
        assert_eq!(width(&source[1]), 90_000);
        let pitch = |p: &Paragraph| {
            let seg = &p.line_segs[0];
            (
                seg.line_height,
                seg.line_spacing,
                seg.baseline_distance,
                seg.vertical_pos,
            )
        };
        assert_eq!(pitch(&projected[0]), pitch(&source[0]));
    }

    #[test]
    fn generated_fraction_reflows_independent_saved_heights() {
        struct ClearFontMetrics;
        impl Drop for ClearFontMetrics {
            fn drop(&mut self) {
                crate::renderer::runtime_font_metrics::clear();
            }
        }
        let _clear_font_metrics = ClearFontMetrics;
        crate::renderer::runtime_font_metrics::register(
            include_bytes!("../../../tests/fixtures/fonts/RHWPShapingFixture.ttf"),
            &["HYhwpEQ".to_string()],
            false,
            false,
        )
        .expect("register equation face metrics");
        let styles = ResolvedStyleSet {
            para_styles: vec![ResolvedParaStyle {
                line_spacing: 135.0,
                ..ResolvedParaStyle::default()
            }],
            ..ResolvedStyleSet::default()
        };
        let make = |script: &str, object_height: u32, line_height: i32, tag: u32| {
            let mut eq = crate::model::control::Equation::default();
            eq.script = script.to_string();
            eq.font_name = "HYhwpEQ".to_string();
            eq.version_info = "Equation Version 60".to_string();
            eq.common.treat_as_char = true;
            eq.common.height = object_height;
            Paragraph {
                controls: vec![Control::Equation(Box::new(eq))],
                line_segs: vec![LineSeg {
                    line_height,
                    text_height: line_height,
                    baseline_distance: line_height * 60 / 100,
                    line_spacing: 350,
                    tag,
                    ..LineSeg::default()
                }],
                ..Paragraph::default()
            }
        };
        let generated = LineSeg::TAG_IMPLEMENTATION_PROPERTY;
        let fraction = crate::renderer::equation::intrinsic_metrics_px_with_version(
            "1 over x",
            1000,
            96.0,
            "HYhwpEQ",
            "Equation Version 60",
        );
        let flow = crate::renderer::equation::generated_fraction_flow_height_px(
            "1 over x",
            1000,
            96.0,
            "HYhwpEQ",
            "Equation Version 60",
        )
        .expect("fraction occupies the equation box bottom");
        assert!((fraction.height - flow - crate::renderer::hwpunit_to_px(200, 96.0)).abs() < 0.01);
        let source = vec![
            make("1 over x", 2_440, 2_440, generated),
            make("1 over x", 4_880, 2_440, generated),
            make("1 over x", 2_440, 4_880, generated),
            make("C", 2_440, 2_440, generated),
            make("1 over x", 2_440, 2_440, 0),
        ];
        let mut projected = source.clone();
        assert!(DocumentCore::project_synthetic_percent_line_spacing(
            &mut projected,
            &styles,
            96.0,
        ));
        for para in &projected[1..3] {
            assert_eq!(
                para.line_segs[0].line_height,
                projected[0].line_segs[0].line_height
            );
            assert_eq!(
                para.line_segs[0].text_height,
                projected[0].line_segs[0].text_height
            );
            assert_eq!(
                para.line_segs[0].line_spacing,
                projected[0].line_segs[0].line_spacing
            );
        }
        assert!(projected[3].line_segs[0].line_height < projected[0].line_segs[0].line_height);
        let metrics = |para: &Paragraph| {
            let seg = &para.line_segs[0];
            (
                seg.line_height,
                seg.text_height,
                seg.line_spacing,
                seg.baseline_distance,
                seg.tag,
            )
        };
        assert_eq!(metrics(&projected[4]), metrics(&source[4]));
    }

    #[test]
    fn generated_short_equation_uses_font_pitch_and_intrinsic_overflow() {
        const FONT: &[u8] = include_bytes!("../../../tests/fixtures/fonts/RHWPShapingFixture.ttf");
        let face = "__rhwp_equation_pitch_fixture__";
        let styles = ResolvedStyleSet {
            para_styles: vec![ResolvedParaStyle {
                line_spacing: 135.0,
                ..ResolvedParaStyle::default()
            }],
            ..ResolvedStyleSet::default()
        };
        let mut eq = crate::model::control::Equation::default();
        eq.font_name = face.to_string();
        eq.font_size = 1_000;
        eq.script = "x^2".to_string();
        eq.common.height = 1_000;
        eq.common.treat_as_char = true;
        eq.common.affect_line_spacing = false;
        eq.baseline = 78;
        let short = Paragraph {
            controls: vec![Control::Equation(Box::new(eq.clone()))],
            line_segs: vec![LineSeg {
                line_height: 1_000,
                baseline_distance: 780,
                line_spacing: 350,
                tag: LineSeg::TAG_IMPLEMENTATION_PROPERTY,
                ..LineSeg::default()
            }],
            ..Paragraph::default()
        };
        let mut tall = short.clone();
        tall.line_segs[0].line_height = 2_440;
        if let Control::Equation(eq) = &mut tall.controls[0] {
            eq.common.height = 2_440;
        }
        let mut affects_spacing = short.clone();
        if let Control::Equation(eq) = &mut affects_spacing.controls[0] {
            eq.common.affect_line_spacing = true;
        }
        let source = vec![short, tall, affects_spacing];
        let mut before_font = source.clone();
        assert!(!DocumentCore::project_synthetic_percent_line_spacing(
            &mut before_font,
            &styles,
            96.0,
        ));
        crate::renderer::runtime_font_metrics::register(FONT, &[face.to_string()], false, false)
            .expect("register equation font");
        let mut projected = source.clone();
        assert!(DocumentCore::project_synthetic_percent_line_spacing(
            &mut projected,
            &styles,
            96.0,
        ));
        let intrinsic = crate::renderer::equation::intrinsic_metrics_px_with_version(
            "x^2",
            1_000,
            96.0,
            face,
            "Equation Version 60",
        );
        let em = crate::renderer::hwpunit_to_px(1_000, 96.0);
        let raw_height = crate::renderer::hwpunit_to_px(1_000, 96.0);
        let font_height =
            crate::renderer::runtime_font_metrics::line_height_ratio(face, false, false).unwrap();
        let expected_pitch = raw_height * font_height * 1.35 + (intrinsic.height - em).max(0.0);
        let actual_pitch = crate::renderer::hwpunit_to_px(
            projected[0].line_segs[0].line_height + projected[0].line_segs[0].line_spacing,
            96.0,
        ) + (intrinsic.height - raw_height).max(0.0);
        assert!((actual_pitch - expected_pitch).abs() < 0.02);
        assert_ne!(projected[0].line_segs[0].baseline_distance, 780);
        assert_eq!(
            projected[1].line_segs[0].line_spacing,
            source[1].line_segs[0].line_spacing
        );
        assert_eq!(
            projected[2].line_segs[0].line_spacing,
            source[2].line_segs[0].line_spacing
        );
        assert_eq!(source[0].line_segs[0].line_spacing, 350);
        crate::renderer::runtime_font_metrics::clear();

        #[cfg(not(target_arch = "wasm32"))]
        {
            let font_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/fonts/RHWPShapingFixture.ttf");
            crate::renderer::font_paths::register_font_face_availability(&[font_path]);
            let mut native_source = source;
            if let Control::Equation(eq) = &mut native_source[0].controls[0] {
                eq.font_name = "RHWP Shaping Fixture".to_string();
            }
            let mut native_projected = native_source.clone();
            assert!(DocumentCore::project_synthetic_percent_line_spacing(
                &mut native_projected,
                &styles,
                96.0,
            ));
            assert_ne!(native_projected[0].line_segs[0].baseline_distance, 780);
        }
    }
}

/// 저장 전후를 저비용으로 비교하는 실용적 구조 무결성 신호.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HwpStructureCounts {
    /// 본문/컨트롤에 담긴 표시 텍스트의 Unicode scalar 수
    pub text_count: u64,
    /// 중첩 문단까지 포함한 Control 수
    pub control_count: u64,
    /// 표/도형/그림/수식/양식 개체 수
    pub object_count: u64,
    /// opaque UnknownControl의 CTRL_HEADER payload + 자식 payload 바이트 수
    pub opaque_control_bytes: u64,
}

/// 종이/쪽 기준 비-TAC 위아래(자리차지) 개체의 본문 vpos 구간 [위, 아래) HU — 바깥
/// 위/아래 여백 포함. 문단 기준 개체나 다른 배치는 `None`.
fn page_anchored_block_span(ctrl: &Control, body_top_hu: i32) -> Option<(i32, i32)> {
    use crate::model::shape::{TextWrap, VertRelTo};
    let (common, om_top, om_bottom) = match ctrl {
        Control::Table(t) if t.raw_ctrl_data.is_empty() => (
            &t.common,
            i32::from(t.outer_margin_top),
            i32::from(t.outer_margin_bottom),
        ),
        Control::Picture(p) => (&p.common, 0, 0),
        Control::Shape(s) => {
            let c = s.common();
            (c, i32::from(c.margin.top), i32::from(c.margin.bottom))
        }
        _ => return None,
    };
    // 위 정렬만 오프셋이 위쪽 기준이다 (아래/가운데 정렬 틀은 쪽 하단 결재란 등).
    if common.treat_as_char
        || !matches!(common.text_wrap, TextWrap::TopAndBottom)
        || !matches!(common.vert_align, crate::model::shape::VertAlign::Top)
        || common.height == 0
    {
        return None;
    }
    let base = match common.vert_rel_to {
        VertRelTo::Paper => -body_top_hu,
        VertRelTo::Page => 0,
        _ => return None,
    };
    let top = base + common.vertical_offset as i32 - om_top;
    Some((top, top + om_top + common.height as i32 + om_bottom))
}

/// 단 기준 자리차지 개체가 가로로 단 글 영역 [0, 단 폭) 밖에만 놓이는가 (HU).
/// 단 밖 개체는 단 안 줄을 밀어내지 않는다. 단 기준이 아니면 판정하지 않는다.
fn object_clears_column_horizontally(ctrl: &Control, column_width_hu: i32) -> bool {
    use crate::model::shape::{HorzAlign, HorzRelTo};
    let common = match ctrl {
        Control::Table(t) => &t.common,
        Control::Picture(p) => &p.common,
        Control::Shape(s) => s.common(),
        _ => return false,
    };
    if !matches!(common.horz_rel_to, HorzRelTo::Column) || common.width == 0 {
        return false;
    }
    let width = i64::from(common.width.min(0x7FFF_FFFF));
    let col_w = i64::from(column_width_hu);
    let offset = i64::from(common.horizontal_offset as i32);
    let x = match common.horz_align {
        HorzAlign::Left | HorzAlign::Inside => offset,
        HorzAlign::Center => (col_w - width) / 2 + offset,
        HorzAlign::Right | HorzAlign::Outside => col_w - width - offset,
    };
    x >= col_w || x + width <= 0
}

fn clear_stored_line_segs(paragraphs: &mut [Paragraph]) {
    visit_paragraphs_mut(paragraphs, &mut |para| para.line_segs.clear());
}

/// [#2158] 구역의 저장 vpos 사다리가 한컴 흐름 조판 결과인가. 한컴은 문단 경계마다
/// 다음 첫 줄 = 앞 끝 줄 + lh + ls + 앞 sa + 뒤 sb 를 정확히 저장한다(2,879/2,880 경계).
/// 이웃한 저장 문단 경계(앞 문단에 자리차지 개체가 없고 쪽 되감김이 아닌 경계)가
/// 20개 이상이고 95% 이상 ±2 HU 로 맞으면 신뢰한다. 결재문서 생성기 사다리는 경계가
/// 적거나 간격을 누락해 떨어진다 (#2279: 36376848·36388853·issue1549).
fn stored_ladder_is_hancom_flow(
    paragraphs: &[Paragraph],
    orig_span: &[Option<(i32, i32)>],
    styles: &ResolvedStyleSet,
    dpi: f64,
) -> bool {
    let spacing = |p: &Paragraph| {
        styles
            .para_styles
            .get(p.para_shape_id as usize)
            .map_or((0.0, 0.0), |s| (s.spacing_before, s.spacing_after))
    };
    let (mut checked, mut exact) = (0usize, 0usize);
    for i in 1..paragraphs.len().min(orig_span.len()) {
        let (Some(prev), Some(next)) = (orig_span[i - 1], orig_span[i]) else {
            continue;
        };
        let prev_para = &paragraphs[i - 1];
        let has_block_object = prev_para.controls.iter().any(|c| match c {
            Control::Table(t) => !t.common.treat_as_char,
            Control::Picture(p) => !p.common.treat_as_char,
            Control::Shape(s) => !s.common().treat_as_char,
            _ => false,
        });
        if has_block_object || next.0 < prev.0 {
            continue;
        }
        let gap = crate::renderer::px_to_hwpunit_round(
            (spacing(prev_para).1 + spacing(&paragraphs[i]).0).max(0.0),
            dpi,
        );
        checked += 1;
        if (next.0 - (prev.1 + gap)).abs() <= 2 {
            exact += 1;
        }
    }
    checked >= 20 && exact * 100 >= checked * 95
}

/// 하위 목록과 바탕쪽을 포함해 저장 줄 정보가 하나라도 남아 있는가.
fn has_stored_line_segs(document: &mut Document) -> bool {
    let mut found = false;
    let mut inspect = |para: &mut Paragraph| {
        found |= para
            .line_segs
            .iter()
            .any(|seg| seg.line_height > 0 && !seg.is_missing_lineseg_placeholder());
    };
    for section in &mut document.sections {
        visit_paragraphs_mut(&mut section.paragraphs, &mut inspect);
        // 바탕쪽은 현재 로드 합성 대상이 아니어도 원본 저장 줄이다. 이 줄이 있으면
        // 문서 전체를 자체 조판으로 분류하지 않아 새로고침에서도 그대로 보존한다.
        for master in &mut section.section_def.master_pages {
            visit_paragraphs_mut(&mut master.paragraphs, &mut inspect);
        }
    }
    found
}

/// 문단 목록과 그 하위 목록(표 셀·캡션·글상자·묶음 자식·머리말/꼬리말·각주/미주)의 모든
/// 문단을 방문한다.
fn visit_paragraphs_mut(paragraphs: &mut [Paragraph], f: &mut dyn FnMut(&mut Paragraph)) {
    fn caption(caption: &mut Option<Caption>, f: &mut dyn FnMut(&mut Paragraph)) {
        if let Some(caption) = caption {
            visit_paragraphs_mut(&mut caption.paragraphs, f);
        }
    }
    fn shape_lists(shape: &mut ShapeObject, f: &mut dyn FnMut(&mut Paragraph)) {
        if let Some(drawing) = shape.drawing_mut() {
            if let Some(text_box) = &mut drawing.text_box {
                visit_paragraphs_mut(&mut text_box.paragraphs, f);
            }
            caption(&mut drawing.caption, f);
        }
        match shape {
            ShapeObject::Group(group) => {
                caption(&mut group.caption, f);
                for child in &mut group.children {
                    shape_lists(child, f);
                }
            }
            ShapeObject::Picture(picture) => caption(&mut picture.caption, f),
            ShapeObject::Chart(chart) => caption(&mut chart.caption, f),
            ShapeObject::Ole(ole) => caption(&mut ole.caption, f),
            _ => {}
        }
    }
    for para in paragraphs {
        f(para);
        for control in &mut para.controls {
            match control {
                Control::Table(table) => {
                    for cell in &mut table.cells {
                        visit_paragraphs_mut(&mut cell.paragraphs, f);
                    }
                    caption(&mut table.caption, f);
                }
                Control::Shape(s) => shape_lists(s, f),
                Control::Picture(picture) => caption(&mut picture.caption, f),
                Control::Header(header) => visit_paragraphs_mut(&mut header.paragraphs, f),
                Control::Footer(footer) => visit_paragraphs_mut(&mut footer.paragraphs, f),
                Control::Footnote(note) => visit_paragraphs_mut(&mut note.paragraphs, f),
                Control::Endnote(note) => visit_paragraphs_mut(&mut note.paragraphs, f),
                Control::HiddenComment(comment) => visit_paragraphs_mut(&mut comment.paragraphs, f),
                Control::Field(field) => visit_paragraphs_mut(&mut field.memo_paragraphs, f),
                Control::SectionDef(section_def) => {
                    for master in &mut section_def.master_pages {
                        visit_paragraphs_mut(&mut master.paragraphs, f);
                    }
                }
                _ => {}
            }
        }
    }
}

/// Visit the line caches refreshed after late font registration. Canonical master-page
/// paragraphs are generated at import only when the entire document has no stored lines.
fn visit_line_refresh_paragraphs_mut(
    document: &mut Document,
    fully_unstored: bool,
    f: &mut dyn FnMut(&mut Paragraph),
) {
    for section in &mut document.sections {
        visit_paragraphs_mut(&mut section.paragraphs, f);
        if fully_unstored {
            for master in &mut section.section_def.master_pages {
                visit_paragraphs_mut(&mut master.paragraphs, f);
            }
        }
    }
}

fn hwp_structure_counts(document: &Document) -> (HwpStructureCounts, Vec<String>) {
    let mut counts = HwpStructureCounts::default();
    let mut losses = Vec::new();
    for section in &document.sections {
        count_paragraphs(&section.paragraphs, &mut counts, &mut losses);
        for master_page in &section.section_def.master_pages {
            count_paragraphs(&master_page.paragraphs, &mut counts, &mut losses);
        }
    }
    (counts, losses)
}

fn document_for_hwp_export(
    document: &Document,
    source_format: crate::parser::FileFormat,
) -> Cow<'_, Document> {
    if !matches!(
        source_format,
        crate::parser::FileFormat::Hwpx | crate::parser::FileFormat::Hwp3
    ) {
        return Cow::Borrowed(document);
    }

    use crate::document_core::converters::hwpx_to_hwp::convert_if_hwpx_source;
    let mut export_document = document.clone();
    let _report = convert_if_hwpx_source(&mut export_document, source_format);
    Cow::Owned(export_document)
}

fn export_is_recovered(
    page_count_matches: bool,
    structure_before: HwpStructureCounts,
    structure_after: HwpStructureCounts,
    serialization_losses: &[String],
) -> bool {
    page_count_matches && structure_before == structure_after && serialization_losses.is_empty()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EquationFingerprint {
    path: String,
    script: String,
    attr: u32,
    font_size: u32,
    color: u32,
    baseline: i16,
    unknown: u16,
    version_info: String,
    font_name: String,
    layout: String,
}

/// 수식은 문단 text가 아니라 별도 EQEDIT/개체 레코드에 저장되므로 일반 텍스트·개체
/// 개수 검사만으로는 빈 script나 잘못 연결된 EQEDIT를 검출할 수 없다.
fn equation_fingerprints(document: &Document) -> Vec<EquationFingerprint> {
    let mut out = Vec::new();
    for (section_idx, section) in document.sections.iter().enumerate() {
        collect_equations_in_paragraphs(
            &section.paragraphs,
            &format!("section[{section_idx}]"),
            &mut out,
        );
        for (master_idx, master) in section.section_def.master_pages.iter().enumerate() {
            collect_equations_in_paragraphs(
                &master.paragraphs,
                &format!("section[{section_idx}].master[{master_idx}]"),
                &mut out,
            );
        }
    }
    out
}

fn collect_equations_in_paragraphs(
    paragraphs: &[Paragraph],
    path: &str,
    out: &mut Vec<EquationFingerprint>,
) {
    for (paragraph_idx, paragraph) in paragraphs.iter().enumerate() {
        let paragraph_path = format!("{path}.p[{paragraph_idx}]");
        for (control_idx, control) in paragraph.controls.iter().enumerate() {
            collect_equations_in_control(
                control,
                &format!("{paragraph_path}.ctrl[{control_idx}]"),
                out,
            );
        }
    }
}

fn collect_equations_in_control(control: &Control, path: &str, out: &mut Vec<EquationFingerprint>) {
    match control {
        Control::Equation(eq) => {
            let c = &eq.common;
            out.push(EquationFingerprint {
                path: path.to_string(),
                script: eq.script.clone(),
                attr: eq.attr,
                font_size: eq.font_size,
                color: eq.color,
                baseline: eq.baseline,
                unknown: eq.unknown,
                version_info: eq.version_info.clone(),
                font_name: eq.font_name.clone(),
                layout: format!(
                    "{}x{} {:?}/{:?} protect={} tac={} als={} flow={} overlap={} {:?}/{:?}/{:?}/{:?} offset={}/{} wrap={:?}/{:?} margin={:?}",
                    c.width,
                    c.height,
                    c.width_criterion,
                    c.height_criterion,
                    c.size_protect,
                    c.treat_as_char,
                    c.affect_line_spacing,
                    c.flow_with_text,
                    c.allow_overlap,
                    c.vert_rel_to,
                    c.horz_rel_to,
                    c.vert_align,
                    c.horz_align,
                    c.vertical_offset,
                    c.horizontal_offset,
                    c.text_wrap,
                    c.text_flow,
                    c.margin,
                ),
            });
        }
        Control::Table(table) => {
            for (cell_idx, cell) in table.cells.iter().enumerate() {
                collect_equations_in_paragraphs(
                    &cell.paragraphs,
                    &format!("{path}.table.cell[{cell_idx}]"),
                    out,
                );
            }
            if let Some(caption) = &table.caption {
                collect_equations_in_paragraphs(
                    &caption.paragraphs,
                    &format!("{path}.table.caption"),
                    out,
                );
            }
        }
        Control::Picture(picture) => {
            if let Some(caption) = &picture.caption {
                collect_equations_in_paragraphs(
                    &caption.paragraphs,
                    &format!("{path}.picture.caption"),
                    out,
                );
            }
        }
        Control::Shape(shape) => collect_equations_in_shape(shape, path, out),
        Control::Header(header) => {
            collect_equations_in_paragraphs(&header.paragraphs, &format!("{path}.header"), out)
        }
        Control::Footer(footer) => {
            collect_equations_in_paragraphs(&footer.paragraphs, &format!("{path}.footer"), out)
        }
        Control::Footnote(note) => {
            collect_equations_in_paragraphs(&note.paragraphs, &format!("{path}.footnote"), out)
        }
        Control::Endnote(note) => {
            collect_equations_in_paragraphs(&note.paragraphs, &format!("{path}.endnote"), out)
        }
        Control::HiddenComment(comment) => collect_equations_in_paragraphs(
            &comment.paragraphs,
            &format!("{path}.hidden_comment"),
            out,
        ),
        Control::Field(field) => collect_equations_in_paragraphs(
            &field.memo_paragraphs,
            &format!("{path}.field.memo"),
            out,
        ),
        _ => {}
    }
}

fn collect_equations_in_shape(shape: &ShapeObject, path: &str, out: &mut Vec<EquationFingerprint>) {
    if let Some(drawing) = shape.drawing() {
        if let Some(text_box) = &drawing.text_box {
            collect_equations_in_paragraphs(
                &text_box.paragraphs,
                &format!("{path}.shape.text_box"),
                out,
            );
        }
        if let Some(caption) = &drawing.caption {
            collect_equations_in_paragraphs(
                &caption.paragraphs,
                &format!("{path}.shape.caption"),
                out,
            );
        }
    }
    match shape {
        ShapeObject::Group(group) => {
            if let Some(caption) = &group.caption {
                collect_equations_in_paragraphs(
                    &caption.paragraphs,
                    &format!("{path}.group.caption"),
                    out,
                );
            }
            for (child_idx, child) in group.children.iter().enumerate() {
                collect_equations_in_shape(child, &format!("{path}.group[{child_idx}]"), out);
            }
        }
        ShapeObject::Picture(picture) => {
            if let Some(caption) = &picture.caption {
                collect_equations_in_paragraphs(
                    &caption.paragraphs,
                    &format!("{path}.shape_picture.caption"),
                    out,
                );
            }
        }
        ShapeObject::Chart(chart) => {
            if let Some(caption) = &chart.caption {
                collect_equations_in_paragraphs(
                    &caption.paragraphs,
                    &format!("{path}.chart.caption"),
                    out,
                );
            }
        }
        ShapeObject::Ole(ole) => {
            if let Some(caption) = &ole.caption {
                collect_equations_in_paragraphs(
                    &caption.paragraphs,
                    &format!("{path}.ole.caption"),
                    out,
                );
            }
        }
        _ => {}
    }
}

fn validate_equation_fingerprints(
    before: &Document,
    after: &Document,
    format: &str,
) -> Result<(), HwpError> {
    let expected = equation_fingerprints(before);
    let actual = equation_fingerprints(after);
    let matches = |a: &EquationFingerprint, b: &EquationFingerprint| {
        equation_container_path(&a.path) == equation_container_path(&b.path)
            && a.script == b.script
            && a.attr == b.attr
            && a.font_size == b.font_size
            && a.color == b.color
            && a.baseline == b.baseline
            && a.unknown == b.unknown
            && a.version_info == b.version_info
            && a.font_name == b.font_name
            && a.layout == b.layout
    };
    if expected.len() == actual.len() && expected.iter().zip(&actual).all(|(a, b)| matches(a, b)) {
        return Ok(());
    }
    if expected.len() != actual.len() {
        return Err(HwpError::RenderError(format!(
            "generated {format} equation count changed during validation: {} -> {}",
            expected.len(),
            actual.len()
        )));
    }
    let mismatch = expected
        .iter()
        .zip(&actual)
        .find(|(a, b)| !matches(a, b))
        .map(|(a, b)| format!("{} -> {}", a.path, b.path))
        .unwrap_or_else(|| "unknown equation".to_string());
    Err(HwpError::RenderError(format!(
        "generated {format} equation semantics changed during validation at {mismatch}"
    )))
}

/// HWP/HWPX 재파스는 SectionDef/ColumnDef 같은 합성 컨트롤을 문단 controls에 추가할 수
/// 있으므로 raw control index는 위치 의미가 아니다. 컨테이너 종류/셀·문단 인덱스만 비교한다.
fn equation_container_path(path: &str) -> String {
    let mut normalized = String::with_capacity(path.len());
    let mut rest = path;
    while let Some(start) = rest.find(".ctrl[") {
        normalized.push_str(&rest[..start]);
        let suffix = &rest[start + ".ctrl[".len()..];
        let Some(end) = suffix.find(']') else {
            normalized.push_str(&rest[start..]);
            return normalized;
        };
        rest = &suffix[end + 1..];
    }
    normalized.push_str(rest);
    normalized
}

/// Serialize and strictly reparse generated HWP bytes before they leave the engine.
///
/// This is intentionally narrower than the optional semantic verification below:
/// it blocks malformed CFB/required-stream/record output, while conversions with
/// known representational losses remain diagnosable through `serialize_hwp_with_verify`.
fn serialize_validated_hwp(document: &Document) -> Result<Vec<u8>, HwpError> {
    let bytes = crate::serializer::serialize_document(document)
        .map_err(|e| HwpError::RenderError(e.to_string()))?;
    let reparsed = crate::parser::parse_hwp_strict_regenerated(&bytes).map_err(|error| {
        HwpError::RenderError(format!(
            "generated HWP failed strict package validation: {error}"
        ))
    })?;
    if reparsed.sections.len() != document.sections.len() {
        return Err(HwpError::RenderError(format!(
            "generated HWP section count changed during validation: {} -> {}",
            document.sections.len(),
            reparsed.sections.len(),
        )));
    }
    validate_equation_fingerprints(document, &reparsed, "HWP")?;
    Ok(bytes)
}

/// Serialize, validate the OPC-style package graph, and reparse generated HWPX.
fn serialize_validated_hwpx(document: &Document) -> Result<Vec<u8>, HwpError> {
    let bytes = crate::serializer::serialize_hwpx(document)
        .map_err(|e| HwpError::RenderError(e.to_string()))?;
    let package_report = crate::serializer::hwpx::package_check::check_package(&bytes, document);
    if !package_report.is_ok() {
        return Err(HwpError::RenderError(format!(
            "generated HWPX failed package validation: {}",
            package_report.summary(),
        )));
    }
    crate::parser::limits::validate_input_size(
        bytes.len(),
        crate::parser::limits::InputPolicy::Regenerated,
    )
    .map_err(|error| HwpError::InvalidFile(error.to_string()))?;
    let reparsed = crate::parser::hwpx::parse_hwpx_validated(&bytes).map_err(|error| {
        HwpError::RenderError(format!("generated HWPX failed reparse validation: {error}"))
    })?;
    if reparsed.sections.len() != document.sections.len() {
        return Err(HwpError::RenderError(format!(
            "generated HWPX section count changed during validation: {} -> {}",
            document.sections.len(),
            reparsed.sections.len(),
        )));
    }
    validate_equation_fingerprints(document, &reparsed, "HWPX")?;
    Ok(bytes)
}

fn count_paragraphs(
    paragraphs: &[Paragraph],
    counts: &mut HwpStructureCounts,
    losses: &mut Vec<String>,
) {
    for paragraph in paragraphs {
        // U+FFFC is the parser's object replacement marker. The corresponding
        // control contributes its semantic text below where applicable.
        counts.text_count += paragraph
            .text
            .chars()
            .filter(|ch| *ch != '\u{fffc}')
            .count() as u64;
        for control in &paragraph.controls {
            count_control(control, counts, losses);
        }
    }
}

fn count_control(control: &Control, counts: &mut HwpStructureCounts, losses: &mut Vec<String>) {
    counts.control_count += 1;
    match control {
        Control::Table(table) => {
            counts.object_count += 1;
            if let Some(caption) = &table.caption {
                count_paragraphs(&caption.paragraphs, counts, losses);
            }
            for cell in &table.cells {
                count_paragraphs(&cell.paragraphs, counts, losses);
            }
        }
        Control::Shape(shape) => count_shape(shape, counts, losses),
        Control::Picture(picture) => {
            counts.object_count += 1;
            if let Some(caption) = &picture.caption {
                count_paragraphs(&caption.paragraphs, counts, losses);
            }
        }
        Control::Header(header) => count_paragraphs(&header.paragraphs, counts, losses),
        Control::Footer(footer) => count_paragraphs(&footer.paragraphs, counts, losses),
        Control::Footnote(note) => count_paragraphs(&note.paragraphs, counts, losses),
        Control::Endnote(note) => count_paragraphs(&note.paragraphs, counts, losses),
        Control::HiddenComment(comment) => count_paragraphs(&comment.paragraphs, counts, losses),
        Control::Equation(_) => counts.object_count += 1,
        Control::Form(form) => {
            counts.object_count += 1;
            counts.text_count += form.text.chars().count() as u64;
        }
        Control::Field(field) => count_paragraphs(&field.memo_paragraphs, counts, losses),
        Control::Hyperlink(link) => {
            counts.text_count += link.text.chars().count() as u64;
            losses.push(
                "legacy Hyperlink has no lossless HWP5 lowering; use HWPX export to preserve it"
                    .to_string(),
            );
        }
        Control::Ruby(ruby) => {
            counts.text_count +=
                (ruby.main_text.chars().count() + ruby.ruby_text.chars().count()) as u64;
            losses.push(
                "Ruby has no validated HWP5 lowering; native HWP opaque Ruby records are preserved"
                    .to_string(),
            );
        }
        Control::Unknown(unknown) => {
            counts.opaque_control_bytes += unknown.raw_ctrl_data.len() as u64;
            counts.opaque_control_bytes += unknown
                .raw_child_records
                .iter()
                .map(|record| record.data.len() as u64)
                .sum::<u64>();
        }
        _ => {}
    }
}

fn count_shape(shape: &ShapeObject, counts: &mut HwpStructureCounts, losses: &mut Vec<String>) {
    counts.object_count += 1;
    if let Some(drawing) = shape.drawing() {
        if let Some(text_box) = &drawing.text_box {
            count_paragraphs(&text_box.paragraphs, counts, losses);
        }
        if let Some(caption) = &drawing.caption {
            count_paragraphs(&caption.paragraphs, counts, losses);
        }
    }
    match shape {
        ShapeObject::Group(group) => {
            if let Some(caption) = &group.caption {
                count_paragraphs(&caption.paragraphs, counts, losses);
            }
            for child in &group.children {
                count_shape(child, counts, losses);
            }
        }
        ShapeObject::Picture(picture) => {
            if let Some(caption) = &picture.caption {
                count_paragraphs(&caption.paragraphs, counts, losses);
            }
        }
        ShapeObject::Chart(chart) => {
            if let Some(caption) = &chart.caption {
                count_paragraphs(&caption.paragraphs, counts, losses);
            }
        }
        ShapeObject::Ole(ole) => {
            if let Some(caption) = &ole.caption {
                count_paragraphs(&caption.paragraphs, counts, losses);
            }
        }
        _ => {}
    }
}

impl DocumentCore {
    /// `base_dir`에서 파일명이 일치하는 외부 그림을 읽고 페이지 캐시를 갱신한다.
    /// 원본 절대 경로를 사용할 수 없는 HWP3 문서도 같은 폴더의 그림을 표시할 수 있다.
    /// 반환값은 읽어 들인 그림 수다.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn populate_external_images_from_dir(&mut self, base_dir: &std::path::Path) -> usize {
        let loaded = self.document.populate_external_images_from_dir(base_dir);
        if loaded > 0 {
            self.invalidate_page_tree_cache();
        }
        loaded
    }

    pub fn from_bytes(data: &[u8]) -> Result<DocumentCore, HwpError> {
        Self::from_bytes_with_policy(data, crate::parser::limits::InputPolicy::Untrusted)
    }

    /// Choose metrics before import-time reconstruction of missing line data.
    pub fn from_bytes_with_font_metrics(
        data: &[u8],
        font_metrics: crate::model::provenance::FontMetricsPolicy,
    ) -> Result<DocumentCore, HwpError> {
        Self::from_bytes_with_policies(
            data,
            crate::parser::limits::InputPolicy::Untrusted,
            font_metrics,
        )
    }

    /// Open one exact local file approved for this attempt by a native picker.
    pub fn from_local_file_bytes(data: &[u8]) -> Result<DocumentCore, HwpError> {
        Self::from_bytes_with_policy(data, crate::parser::limits::InputPolicy::LocalFileOnce)
    }

    /// Same one-file contract as `from_local_file_bytes`, with explicit metrics.
    pub fn from_local_file_bytes_with_font_metrics(
        data: &[u8],
        font_metrics: crate::model::provenance::FontMetricsPolicy,
    ) -> Result<DocumentCore, HwpError> {
        Self::from_bytes_with_policies(
            data,
            crate::parser::limits::InputPolicy::LocalFileOnce,
            font_metrics,
        )
    }

    /// Reparse output created by this process's bounded serializers.
    pub(crate) fn from_regenerated_bytes(data: &[u8]) -> Result<DocumentCore, HwpError> {
        Self::from_bytes_with_policy(data, crate::parser::limits::InputPolicy::Regenerated)
    }

    pub(crate) fn from_bytes_with_policy(
        data: &[u8],
        policy: crate::parser::limits::InputPolicy,
    ) -> Result<DocumentCore, HwpError> {
        Self::from_bytes_with_policies(data, policy, Default::default())
    }

    pub(crate) fn from_bytes_with_policies(
        data: &[u8],
        policy: crate::parser::limits::InputPolicy,
        font_metrics: crate::model::provenance::FontMetricsPolicy,
    ) -> Result<DocumentCore, HwpError> {
        let ignore_stored = std::env::var_os(crate::document_core::IGNORE_STORED_LINESEGS_ENV)
            .is_some_and(|v| v == "1");
        Self::from_bytes_impl(data, policy, font_metrics, ignore_stored)
    }

    /// 저장 LINE_SEG 를 모든 문단에서 버리고 로드 경로(누락 합성)만으로 조판한 코어.
    /// lineseg 오라클 `--path load` 계측용 — `RHWP_IGNORE_STORED_LINESEGS=1` 과 같다.
    pub(crate) fn from_bytes_ignoring_stored_linesegs(
        data: &[u8],
    ) -> Result<DocumentCore, HwpError> {
        Self::from_bytes_impl(
            data,
            crate::parser::limits::InputPolicy::Untrusted,
            Default::default(),
            true,
        )
    }

    fn from_bytes_impl(
        data: &[u8],
        policy: crate::parser::limits::InputPolicy,
        font_metrics: crate::model::provenance::FontMetricsPolicy,
        ignore_stored_linesegs: bool,
    ) -> Result<DocumentCore, HwpError> {
        let source_format = crate::parser::detect_format(data);
        let parsed = crate::parser::parse_document_with_metadata_policy(data, policy)
            .map_err(|e| HwpError::InvalidFile(e.to_string()))?;
        let mut document = parsed.document;
        document.doc_info.font_metrics_policy = font_metrics;
        let hml_metadata = parsed.hml_metadata;

        // [#2279 실험 전용] 본문 저장 lineseg 전면 무시 → fresh 재계산.
        // 기계생성 결재문서의 부분-사다리 불신 실험 계측용 (기본 no-op).
        // 주의: 92셋 전수 실측(2026-07-18)에서 전면 fresh 는 88→76 광역 회귀 —
        // 부분 사다리의 정합을 fresh 가 아직 대체하지 못함. 판별-자동화 금지.
        if std::env::var("RHWP_EXP_BODY_FRESH").is_ok() {
            for sec in document.sections.iter_mut() {
                for para in sec.paragraphs.iter_mut() {
                    para.line_segs.clear();
                }
            }
        }

        // lineseg 오라클 계측 전용: 저장 LINE_SEG 를 모든 문단(본문·셀·글상자·캡션·
        // 머리말/꼬리말·각주/미주)에서 버려 누락 경로만으로 조판한다. 기본 no-op.
        if ignore_stored_linesegs {
            for sec in document.sections.iter_mut() {
                clear_stored_line_segs(&mut sec.paragraphs);
                for master in &mut sec.section_def.master_pages {
                    clear_stored_line_segs(&mut master.paragraphs);
                }
            }
        }

        // [Task #1001] HWP3 변환본의 ParaShape 단위 1/2 추가 보정
        let styles = crate::renderer::style_resolver::resolve_styles_with_variant(
            &document.doc_info,
            DEFAULT_DPI,
            document.layout_profile().hwp3_layout(),
        );

        let hwp5_origin_hwpx = matches!(source_format, crate::parser::FileFormat::Hwpx)
            && document
                .hwpx_aux_entry(crate::model::document::HWP5_ORIGIN_HWPX_MARKER_PATH)
                .is_some();
        let use_xml_import_semantics = matches!(
            source_format,
            crate::parser::FileFormat::Hwpx | crate::parser::FileFormat::Hml
        ) && !hwp5_origin_hwpx;

        // 비표준 lineseg 감지 — reflow 이전 시점에 IR을 그대로 검증.
        // 경고는 사용자에게 고지되며, 자동 reflow 는 `needs_line_seg_reflow` 조건에만 한정.
        // 사용자 명시 reflow 는 `reflow_linesegs_on_demand()` 를 통해서만 수행 (#177).
        // LinesegTextRunReflow는 HWPX textRun 전용 패턴. HWP3/HWP5/HML에는 확대 적용하지 않는다.
        let check_textrun_reflow =
            matches!(source_format, crate::parser::FileFormat::Hwpx) && !hwp5_origin_hwpx;
        let validation_report = Self::validate_linesegs(&document, check_textrun_reflow);

        // lineSegArray가 없는 문단에 대해 합성 LineSeg 생성.
        // XML 파서는 linesegarray 부재 문단의 line_segs 를 빈 채 보존하므로(#1380)
        // XML import 에서 빈 line_segs 를 합성 대상에 포함한다 — compose 전에 올바른
        // line_height/line_spacing 을 계산해야 줄바꿈·높이가 정상 동작한다.
        // HWP5/HWP3 의 빈 line_segs 는 종전대로 reflow 하지 않는다 (페이지 수 보존).
        let include_empty = use_xml_import_semantics;
        // [#2195] HWP5 native 확장은 **셀 내부의 컨트롤 없는 순수 빈 문단** 한정
        // (86712 1pt 빈 문단 오라클). 본문 문단 확장은 기각(stage68): 본문 빈
        // 문단은 typeset 의 em 폴백(#2070 축3)이 담당하고(80168 pi=424 오라클),
        // 본문 텍스트 문단 합성은 흐름 소비 팽창으로 sijang 밀도 핀 -5쪽(#2070v2).
        // HWP3 변환본은 #998 게이트(sample16-hwp5=64) 정합상 종전 유지.
        let include_cell_empty = !document.layout_profile().hwp3_layout();
        let fully_unstored = include_empty && !has_stored_line_segs(&mut document);
        Self::reflow_zero_height_paragraphs(
            &mut document,
            &styles,
            DEFAULT_DPI,
            include_empty,
            include_cell_empty,
            fully_unstored,
        );
        // [lso-load3] 저장 줄 정보가 전혀 없는 XML 문서(줄 정보 없는 생성기 출력·
        // RHWP_IGNORE_STORED_LINESEGS)는 모든 줄을 로드가 편집 경로와 같은 한컴 규칙(폭·
        // 줄높이·vpos 사다리)으로 계산했다 — 배치 전 placeholder 가 아니므로 구현 태그를
        // 지워 렌더러가 저장 줄처럼 신뢰하게 한다. 태그가 남으면 표 행 높이가 "줄 정보
        // 부재" 폴백(글자크기×줄간격)으로 재계산되어 개체(중첩 표) 줄이 부풀고 셀 세로
        // 가운데 정렬이 밀린다 (gov-fire 1쪽 +29.9pt). 저장 줄이 섞인 문서는 종전대로
        // 합성 줄을 태그로 구분한다 — 렌더러 보정이 그 혼합 사다리에 맞춰져 있다.
        if fully_unstored {
            document.provenance.own_line_layout = true;
            for section in &mut document.sections {
                visit_paragraphs_mut(&mut section.paragraphs, &mut |para| {
                    for seg in &mut para.line_segs {
                        seg.tag &= !LineSeg::TAG_IMPLEMENTATION_PROPERTY;
                    }
                });
                for master in &mut section.section_def.master_pages {
                    visit_paragraphs_mut(&mut master.paragraphs, &mut |para| {
                        for seg in &mut para.line_segs {
                            seg.tag &= !LineSeg::TAG_IMPLEMENTATION_PROPERTY;
                        }
                    });
                }
            }
        }
        Self::clear_missing_lineseg_placeholders(&mut document);

        // XML import → HWP 라운드트립 일관성 normalize (#314):
        // XML 파서가 채우지 않는 paragraph 필드를 HWP 직렬화/파싱 라운드트립 결과와 일치시킨다.
        // 1) char_shapes 빈 paragraph 에 default [(0,0)] 추가 (HWP 스펙상 최소 1개 요구)
        // 2) control_mask 를 controls 기반으로 재계산
        if use_xml_import_semantics {
            Self::normalize_xml_import_paragraphs(&mut document);
        }

        // 초기 상태(properties bit 15 == 0) 누름틀의 안내문 텍스트를 삭제하여 빈 필드로 정규화
        // (한컴에서 메모 추가 시 안내문 텍스트가 필드 값으로 삽입됨 — compose 전에 제거해야 정합성 유지)
        Self::clear_initial_field_texts(&mut document);

        let composed = document
            .sections
            .iter()
            .map(|s| compose_section(s))
            .collect();

        let sec_count = document.sections.len();
        let mut doc = DocumentCore {
            document,
            pagination: Vec::new(),
            styles,
            composed,
            render_normalization: super::super::RenderNormalizationState::default(),
            dpi: DEFAULT_DPI,
            fallback_font: DEFAULT_FALLBACK_FONT.to_string(),
            layout_engine: LayoutEngine::new(DEFAULT_DPI),
            clipboard: None,
            table_transpose_clipboard: None,
            paste_cascade_count: 0,
            show_paragraph_marks: false,
            show_control_codes: false,
            show_transparent_borders: false,
            clip_enabled: true,
            debug_overlay: false,
            respect_vpos_reset: false,
            measured_tables: Vec::new(),
            dirty_sections: vec![true; sec_count],
            measured_sections: Vec::new(),
            dirty_paragraphs: Vec::new(),
            para_column_map: Vec::new(),
            deferred_pagination_revision: 0,
            deferred_pagination_descriptor: None,
            pending_pagination_job: None,
            page_tree_cache: RefCell::new(Vec::new()),
            page_tree_cache_order: RefCell::new(VecDeque::new()),
            header_footer_preview_tree_cache: RefCell::new(None),
            layer_tree_json_cache: RefCell::new(Vec::new()),
            batch_mode: false,
            event_log: DocumentEventLog::default(),
            overflow_links_cache: RefCell::new(HashMap::new()),
            snapshot_store: Vec::new(),
            next_snapshot_id: 0,
            picture_transform_store: Vec::new(),
            next_picture_transform_id: 0,
            paragraph_capture_store: Vec::new(),
            next_paragraph_capture_id: 0,
            hidden_header_footer: std::collections::HashSet::new(),
            file_name: String::new(),
            active_field: None,
            caret_insert_after_control: None,
            para_offset: Vec::new(),
            source_format,
            hml_metadata,
            validation_report,
        };

        doc.paginate();
        Ok(doc)
    }

    /// 완전히 파싱한 다른 문서의 내용만 현재 문서에 적용한다.
    ///
    /// 파일 이름, 원본 형식, HML 저장 메타데이터, 보기 설정, 스냅샷 저장소는 현재
    /// 편집 세션의 정체성이므로 유지한다. 파싱과 편집 가능 변환을 임시 코어에서
    /// 끝낸 뒤 `Document`를 교체하므로 잘못된 바이트는 현재 상태를 바꾸지 않는다.
    pub fn replace_content_from_bytes_native(&mut self, data: &[u8]) -> Result<String, HwpError> {
        self.replace_content_from_bytes_with_policy(
            data,
            crate::parser::limits::InputPolicy::Untrusted,
        )
    }

    fn replace_content_from_bytes_with_policy(
        &mut self,
        data: &[u8],
        policy: crate::parser::limits::InputPolicy,
    ) -> Result<String, HwpError> {
        let mut replacement = DocumentCore::from_bytes_with_policies(
            data,
            policy,
            self.document.doc_info.font_metrics_policy,
        )?;
        replacement.convert_to_editable_native()?;

        self.document = replacement.document;
        self.deferred_pagination_revision = self.deferred_pagination_revision.wrapping_add(1);
        self.deferred_pagination_descriptor = None;
        self.pending_pagination_job = None;
        self.refresh_layout_native();

        Ok(self.get_document_info())
    }

    /// 비표준 lineseg 감지 (#177).
    ///
    /// `reflow_zero_height_paragraphs` 호출 **이전** 상태의 IR을 기준으로 검증한다.
    /// reflow 이후에 호출하면 이미 line_height 가 채워져 감지 불가.
    ///
    /// 감지 규칙:
    /// - 텍스트가 있는데 `line_segs` 가 비어있음 → `LinesegArrayEmpty`
    /// - `line_segs.len() == 1 && line_height == 0` → `LinesegUncomputed`
    /// - `check_textrun_reflow=true` 일 때만: 긴 텍스트 + lineseg 1개 → `LinesegTextRunReflow`
    ///   (HWPX 전용 패턴. HWP3/HWP5/HML에는 확대 적용하지 않음.)
    ///
    /// 표 셀 내부 문단도 재귀 검사한다.
    pub(crate) fn validate_linesegs(
        document: &Document,
        check_textrun_reflow: bool,
    ) -> ValidationReport {
        let mut report = ValidationReport::new();
        for (si, section) in document.sections.iter().enumerate() {
            for (pi, para) in section.paragraphs.iter().enumerate() {
                Self::check_paragraph_linesegs(
                    para,
                    si,
                    pi,
                    None,
                    check_textrun_reflow,
                    &mut report,
                );

                // 표 셀 내부 문단도 재귀 검사
                for (ci, ctrl) in para.controls.iter().enumerate() {
                    if let Control::Table(table) = ctrl {
                        for cell in &table.cells {
                            for (inner_pi, cell_para) in cell.paragraphs.iter().enumerate() {
                                let cell_path = CellPath {
                                    table_ctrl_idx: ci,
                                    row: cell.row,
                                    col: cell.col,
                                    inner_para_idx: inner_pi,
                                };
                                Self::check_paragraph_linesegs(
                                    cell_para,
                                    si,
                                    pi,
                                    Some(cell_path),
                                    check_textrun_reflow,
                                    &mut report,
                                );
                            }
                        }
                    }
                }
            }
        }
        report
    }

    fn check_paragraph_linesegs(
        para: &Paragraph,
        section_idx: usize,
        paragraph_idx: usize,
        cell_path: Option<CellPath>,
        check_textrun_reflow: bool,
        report: &mut ValidationReport,
    ) {
        // 규칙 1: 텍스트가 있는데 lineseg 배열이 비어있음
        if para.line_segs.is_empty() && !para.text.is_empty() {
            report.push(ValidationWarning {
                section_idx,
                paragraph_idx,
                cell_path,
                kind: WarningKind::LinesegArrayEmpty,
            });
            return; // 후속 규칙 건너뜀
        }
        // 규칙 2: 미계산 상태 (기존 needs_line_seg_reflow 와 동일 조건)
        if para.line_segs.len() == 1 && para.line_segs[0].line_height == 0 {
            report.push(ValidationWarning {
                section_idx,
                paragraph_idx,
                cell_path,
                kind: WarningKind::LinesegUncomputed,
            });
            return;
        }
        // 규칙 3: lineseg 1개인데 텍스트가 길고 '\n' 이 없음 — 한컴이 textRun reflow 에
        // 의존하는 패턴 (Discussion #188). HWPX 전용. HWP3/HWP5는 1 line_info → 1 lineseg가
        // 정상이므로 check_textrun_reflow=false 로 호출하면 건너뜀.
        //
        // 휴리스틱 threshold = 40자 (한글 한 줄 ~30자 안팎을 기준으로 보수적).
        const LONG_TEXT_THRESHOLD: usize = 40;
        if check_textrun_reflow
            && para.line_segs.len() == 1
            && !para.text.contains('\n')
            && para.text.chars().count() > LONG_TEXT_THRESHOLD
        {
            report.push(ValidationWarning {
                section_idx,
                paragraph_idx,
                cell_path,
                kind: WarningKind::LinesegTextRunReflow,
            });
        }
    }

    /// XML 생성기가 em 높이와 퍼센트 간격으로 적은 합성 줄의 진행량을
    /// 글꼴의 실제 수직 메트릭으로 다시 계산한다. 합성 줄의 표시 상자는 보존한다.
    pub(crate) fn project_synthetic_percent_line_spacing(
        paragraphs: &mut [Paragraph],
        styles: &ResolvedStyleSet,
        dpi: f64,
    ) -> bool {
        use crate::model::style::LineSpacingType;

        fn visit(paragraphs: &mut [Paragraph], styles: &ResolvedStyleSet, dpi: f64) -> bool {
            let mut changed = false;
            for para in paragraphs {
                let style = styles.para_styles.get(para.para_shape_id as usize);
                // 변환기가 쓴 합성 EQEDIT 폭은 script/font의 실제 폭과 다를 수 있다.
                // Hancom은 가져올 때 이를 다시 계산한다. 렌더 복제본에서만 갱신하여
                // composer의 가운데 정렬과 모든 paint 경로가 같은 자연 폭을 보게 한다.
                if para.line_segs.len() == 1
                    && para.line_segs[0].tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY != 0
                    && para
                        .text
                        .chars()
                        .all(|c| c.is_whitespace() || c == '\u{0002}' || c == '\u{fffc}')
                {
                    if let [Control::Equation(eq)] = para.controls.as_mut_slice() {
                        let available = crate::renderer::runtime_font_metrics::line_height_ratio(
                            &eq.font_name,
                            false,
                            false,
                        )
                        .is_some()
                            || {
                                #[cfg(not(target_arch = "wasm32"))]
                                {
                                    crate::renderer::font_paths::custom_face_line_height_ratio(
                                        &eq.font_name,
                                        false,
                                        false,
                                    )
                                    .is_some()
                                }
                                #[cfg(target_arch = "wasm32")]
                                {
                                    false
                                }
                            };
                        if eq.common.treat_as_char && available {
                            let metrics =
                                crate::renderer::equation::intrinsic_metrics_px_with_version(
                                    &eq.script,
                                    eq.font_size,
                                    dpi,
                                    &eq.font_name,
                                    &eq.version_info,
                                );
                            let width = crate::renderer::px_to_hwpunit_round(metrics.width, dpi)
                                .max(1) as u32;
                            if eq.common.width != width {
                                eq.common.width = width;
                                changed = true;
                            }
                        }
                    }
                }
                // A generated modern equation line stores an estimated object
                // box. Rebuild its occupied height from the equation nucleus;
                // a fraction's trailing rule clearance is paint-only when the
                // object does not affect line spacing.
                let tall_equation_projection = (|| {
                    let style = style?;
                    let [seg] = para.line_segs.as_slice() else {
                        return None;
                    };
                    let [Control::Equation(eq)] = para.controls.as_slice() else {
                        return None;
                    };
                    if style.line_spacing_type != LineSpacingType::Percent
                        || seg.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY == 0
                        || !para
                            .text
                            .chars()
                            .all(|c| c.is_whitespace() || c == '\u{0002}' || c == '\u{fffc}')
                        || !eq.common.treat_as_char
                        || eq.common.affect_line_spacing
                        || eq.version_info != "Equation Version 60"
                        || !crate::renderer::equation::font::is_legacy_equation_font(&eq.font_name)
                    {
                        return None;
                    }
                    let em = crate::renderer::hwpunit_to_px(eq.font_size as i32, dpi);
                    let font_height = crate::renderer::runtime_font_metrics::line_height_ratio(
                        &eq.font_name,
                        false,
                        false,
                    )
                    .or_else(|| {
                        #[cfg(not(target_arch = "wasm32"))]
                        {
                            crate::renderer::font_paths::custom_face_line_height_ratio(
                                &eq.font_name,
                                false,
                                false,
                            )
                        }
                        #[cfg(target_arch = "wasm32")]
                        {
                            None
                        }
                    })?;
                    if em <= 0.0 {
                        return None;
                    }
                    let fraction_flow =
                        crate::renderer::equation::generated_fraction_flow_height_px(
                            &eq.script,
                            eq.font_size,
                            dpi,
                            &eq.font_name,
                            &eq.version_info,
                        );
                    let raw_object_height =
                        crate::renderer::hwpunit_to_px(eq.common.height as i32, dpi);
                    let raw_line_height = crate::renderer::hwpunit_to_px(seg.line_height, dpi);
                    if fraction_flow.is_none()
                        && raw_object_height <= em * font_height
                        && raw_line_height <= em * font_height
                    {
                        return None;
                    }
                    let intrinsic = crate::renderer::equation::intrinsic_metrics_px_with_version(
                        &eq.script,
                        eq.font_size,
                        dpi,
                        &eq.font_name,
                        &eq.version_info,
                    );
                    let height = fraction_flow
                        .unwrap_or(intrinsic.height)
                        .max(em * font_height);
                    let spacing = em * font_height * (style.line_spacing - 100.0) / 100.0;
                    Some((
                        crate::renderer::px_to_hwpunit_round(height, dpi),
                        crate::renderer::px_to_hwpunit_round(intrinsic.baseline, dpi),
                        crate::renderer::px_to_hwpunit_round(spacing, dpi),
                    ))
                })();
                if let Some((height, baseline, spacing)) = tall_equation_projection {
                    let seg = &mut para.line_segs[0];
                    seg.line_height = height;
                    seg.text_height = height;
                    seg.baseline_distance = baseline;
                    seg.line_spacing = spacing;
                    if let Control::Equation(eq) = &mut para.controls[0] {
                        eq.common.height = height.max(1) as u32;
                        eq.baseline = 0;
                    }
                    changed = true;
                }
                // An EQEDIT-only generated line records the object's em-sized box, not
                // the Mac font line box. Keep the object's intrinsic overflow, then
                // derive the percent pitch and baseline from its actual equation face.
                let equation_projection = (|| {
                    if tall_equation_projection.is_some() {
                        return None;
                    }
                    let style = style?;
                    if style.line_spacing_type != LineSpacingType::Percent
                        || para.line_segs.len() != 1
                        || !para
                            .text
                            .chars()
                            .all(|c| c.is_whitespace() || c == '\u{0002}' || c == '\u{fffc}')
                    {
                        return None;
                    }
                    let [Control::Equation(eq)] = para.controls.as_slice() else {
                        return None;
                    };
                    let seg = &para.line_segs[0];
                    if !eq.common.treat_as_char
                        || eq.common.affect_line_spacing
                        || seg.tag & crate::model::paragraph::LineSeg::TAG_IMPLEMENTATION_PROPERTY
                            == 0
                        || seg.line_height != eq.common.height as i32
                    {
                        return None;
                    }
                    let em = crate::renderer::hwpunit_to_px(eq.font_size as i32, dpi);
                    let raw_height = crate::renderer::hwpunit_to_px(seg.line_height, dpi);
                    let raw_spacing = crate::renderer::hwpunit_to_px(seg.line_spacing, dpi);
                    if em <= 0.0
                        || (raw_spacing - em * (style.line_spacing - 100.0) / 100.0).abs() > 0.25
                    {
                        return None;
                    }
                    let font_height = crate::renderer::runtime_font_metrics::line_height_ratio(
                        &eq.font_name,
                        false,
                        false,
                    )
                    .or_else(|| {
                        #[cfg(not(target_arch = "wasm32"))]
                        {
                            crate::renderer::font_paths::custom_face_line_height_ratio(
                                &eq.font_name,
                                false,
                                false,
                            )
                        }
                        #[cfg(target_arch = "wasm32")]
                        {
                            None
                        }
                    })?;
                    let font_gap = crate::renderer::runtime_font_metrics::line_gap_ratio(
                        &eq.font_name,
                        false,
                        false,
                    )
                    .or_else(|| {
                        #[cfg(not(target_arch = "wasm32"))]
                        {
                            crate::renderer::font_paths::custom_face_line_gap_ratio(
                                &eq.font_name,
                                false,
                                false,
                            )
                        }
                        #[cfg(target_arch = "wasm32")]
                        {
                            None
                        }
                    })?;
                    // A genuinely tall equation already has its authored line box.
                    if raw_height > em * font_height {
                        return None;
                    }
                    let intrinsic = crate::renderer::equation::intrinsic_metrics_px_with_version(
                        &eq.script,
                        eq.font_size,
                        dpi,
                        &eq.font_name,
                        &eq.version_info,
                    );
                    let flow_height = crate::renderer::equation::control_line_flow_height(
                        eq,
                        intrinsic.height,
                        intrinsic.baseline,
                        em,
                    );
                    let pitch = raw_height * font_height * style.line_spacing / 100.0
                        + (flow_height - em).max(0.0);
                    let baseline = (crate::renderer::hwpunit_to_px(seg.baseline_distance, dpi)
                        + em * font_gap)
                        .max(intrinsic.baseline);
                    let baseline_percent = (baseline / raw_height * 100.0).round() as i16;
                    if !(1..=100).contains(&baseline_percent) {
                        return None;
                    }
                    let actual_baseline = raw_height * f64::from(baseline_percent) / 100.0;
                    let occupied_height = raw_height.max(flow_height);
                    Some((pitch - occupied_height, actual_baseline, baseline_percent))
                })();
                if let Some((spacing, baseline, baseline_percent)) = equation_projection {
                    para.line_segs[0].line_spacing =
                        crate::renderer::px_to_hwpunit_round(spacing, dpi);
                    para.line_segs[0].baseline_distance =
                        crate::renderer::px_to_hwpunit_round(baseline, dpi);
                    if let Control::Equation(eq) = &mut para.controls[0] {
                        eq.baseline = baseline_percent;
                    }
                    changed = true;
                }
                if let Some(style) = style.filter(|style| {
                    style.line_spacing_type == LineSpacingType::Percent
                        && para.controls.is_empty()
                        && !para.line_segs.is_empty()
                }) {
                    let composed = crate::renderer::composer::compose_paragraph(para);
                    let mut metrics = Vec::with_capacity(composed.lines.len());
                    if composed.lines.len() == para.line_segs.len() {
                        for (line, seg) in composed.lines.iter().zip(&para.line_segs) {
                            let fs =
                                crate::renderer::composed_line_max_font_size(line, para, styles);
                            let empty_style = line
                                .runs
                                .is_empty()
                                .then(|| {
                                    para.char_shape_id_at(line.char_start)
                                        .or_else(|| {
                                            para.char_shapes
                                                .first()
                                                .map(|shape| shape.char_shape_id)
                                        })
                                        .and_then(|id| styles.char_styles.get(id as usize))
                                })
                                .flatten();
                            let box_height = if let Some(style) = empty_style {
                                // Hancom composes an empty line with the Latin face. This
                                // matters when the run's Hangul and Latin faces differ.
                                crate::renderer::char_style_font_box_height(style, 1)
                            } else {
                                crate::renderer::composed_line_font_box_height(line, styles)
                            };
                            let baseline = if let Some(style) = empty_style {
                                crate::renderer::char_style_font_baseline_distance(style, 1)
                            } else {
                                crate::renderer::composed_line_font_baseline_distance(line, styles)
                            };
                            let raw_height = crate::renderer::hwpunit_to_px(seg.line_height, dpi);
                            let raw_spacing = crate::renderer::hwpunit_to_px(seg.line_spacing, dpi);
                            let em_spacing = fs * (style.line_spacing - 100.0) / 100.0;
                            if seg.tag
                                & crate::model::paragraph::LineSeg::TAG_IMPLEMENTATION_PROPERTY
                                == 0
                                || fs <= 0.0
                                || box_height <= 0.0
                                || (raw_height - fs).abs() > 0.25
                                || (raw_spacing - em_spacing).abs() > 0.25
                            {
                                metrics.clear();
                                break;
                            }
                            metrics.push((box_height * style.line_spacing / 100.0, baseline));
                        }
                        if metrics.len() == para.line_segs.len() {
                            let mut next_vpos = para.line_segs[0].vertical_pos;
                            for (seg, (pitch, baseline)) in para.line_segs.iter_mut().zip(metrics) {
                                seg.vertical_pos = next_vpos;
                                seg.line_spacing = crate::renderer::px_to_hwpunit_round(
                                    pitch - crate::renderer::hwpunit_to_px(seg.line_height, dpi),
                                    dpi,
                                );
                                if let Some(baseline) = baseline {
                                    seg.baseline_distance =
                                        crate::renderer::px_to_hwpunit_round(baseline, dpi);
                                }
                                next_vpos = next_vpos
                                    .saturating_add(seg.line_height)
                                    .saturating_add(seg.line_spacing);
                            }
                            changed = true;
                        }
                    }
                }
                for control in &mut para.controls {
                    if let Control::Table(table) = control {
                        for cell in &mut table.cells {
                            changed |= visit(&mut cell.paragraphs, styles, dpi);
                        }
                    }
                }
            }
            changed
        }
        visit(paragraphs, styles, dpi)
    }

    /// lineSegArray가 없는(line_height=0) 문단에 대해 합성 LineSeg를 생성한다.
    ///
    /// HWPX 파일에서 `<hp:lineSegArray>`가 누락된 문단은 모든 LineSeg 필드가 0으로
    /// 설정되어 줄바꿈·문단 높이 계산이 불가능하다. 이 함수는 문서 로드 직후
    /// CharPr/ParaPr 기반으로 올바른 line_height/line_spacing을 계산한다.
    /// 본문 문단뿐 아니라 표 셀 내부 문단도 처리한다.
    /// `include_empty`: 빈 `line_segs` 도 합성 대상으로 포함 (HWPX 전용 — #1380).
    /// `include_cell_empty`: [#2195] HWP5 native 확장 — 셀 내부의 **컨트롤 없는
    /// 순수 빈 문단**만 CharPr 크기 기반 줄박스 합성(86712 1pt 빈 문단 오라클).
    /// 본문 문단·셀 텍스트 문단·컨트롤 호스트 문단은 각각 em 폴백(#2070 축3)·
    /// composer recompose·typeset 표 줄 계산이 담당하므로 제외한다(stage68).
    fn reflow_zero_height_paragraphs(
        document: &mut Document,
        styles: &ResolvedStyleSet,
        dpi: f64,
        include_empty: bool,
        include_cell_empty: bool,
        own_line_layout: bool,
    ) {
        use crate::model::control::Control;

        let layout_profile = document.layout_profile();
        let is_hwp3_variant = layout_profile.hwp3_layout();
        for section in &mut document.sections {
            // 캡션 줄이 없으면 개체 높이 측정이 4pt 기본값을 쓴다. 부모 TAC 줄을
            // 만들기 전에 하위 캡션을 조판해야 캡션의 실제 글자 크기·간격이 예약된다.
            if include_empty {
                visit_paragraphs_mut(&mut section.paragraphs, &mut |para| {
                    Self::synthesize_missing_control_captions(
                        &mut para.controls,
                        styles,
                        dpi,
                        is_hwp3_variant,
                        layout_profile,
                    );
                });
                // 저장 줄이 없는 XML의 바탕쪽도 본문과 같은 개체 줄 높이를 쓴다.
                // 혼합 저장 문서는 기존 바탕쪽 배치를 유지한다.
                // 상위 문단은 개체 앵커이므로 흐름 줄을 새로 만들지 않는다.
                if own_line_layout {
                    for master in &mut section.section_def.master_pages {
                        visit_paragraphs_mut(&mut master.paragraphs, &mut |para| {
                            Self::synthesize_missing_control_captions(
                                &mut para.controls,
                                styles,
                                dpi,
                                is_hwp3_variant,
                                layout_profile,
                            );
                        });
                        for para in &mut master.paragraphs {
                            Self::synthesize_missing_control_lines(
                                &mut para.controls,
                                styles,
                                dpi,
                                is_hwp3_variant,
                                layout_profile,
                            );
                        }
                    }
                }
            }
            let page_def = section.section_def.page_def.clone();
            let mut column_def = Self::find_initial_column_def(&section.paragraphs);

            let mut body_line_seg_changed = false;
            // [Issue #1920] vpos 재계산(아래) 시 저장 vpos 의 새 쪽 시작 신호를 보존하기
            // 위해, 이번 패스에서 LINE_SEG 가 합성(reflow)된 문단 — 저장 vpos 신뢰 불가 —
            // 을 기록한다.
            let mut reflowed_paras: std::collections::HashSet<usize> =
                std::collections::HashSet::new();
            // 문단별 단 폭(HU) — 아래 vpos 재계산에서 단 밖 자리차지 개체를 가린다.
            let column_width_hu = |column_def: &crate::model::page::ColumnDef| {
                let layout = PageLayoutInfo::from_page_def(&page_def, column_def, dpi);
                let width = layout
                    .column_areas
                    .first()
                    .map_or(layout.body_area.width, |a| a.width);
                crate::renderer::px_to_hwpunit_round(width, dpi)
            };
            let mut current_col_width_hu = column_width_hu(&column_def);
            let mut para_col_width_hu: Vec<i32> = Vec::with_capacity(section.paragraphs.len());
            let mut preceding_exclusions: Vec<FloatExclusion> = Vec::new();
            // 명시적 쪽 시작부터 분할 없는 단일 단 본문만 추적한다. 자연 쪽나눔이나
            // 별도 배치 개체를 만나면 쪽 위치를 추정하지 않고 다음 명시적 경계까지 쉰다.
            let mut unbroken_body_end = Some(0.0_f64);
            let mut previous_spacing_after = 0.0_f64;
            for (pi, para) in section.paragraphs.iter_mut().enumerate() {
                // 본문 문단 reflow
                // [#2195 stage68] 본문 텍스트 NO_LS 확장(stage1)은 기각 — 후속 축
                // (전각 폴백·pad 규칙·스트레치·after_for_fit)이 게이트 정합을 대체했고,
                // 본문 합성 lineseg 는 흐름 소비를 문단당 ~2.7px 팽창시켜 sijang
                // 밀도 핀 -5쪽(302 vs 307, #2070v2)만 남기는 잉여 축으로 판정.
                // 본문 NO_LS 텍스트 문단의 실폭 래핑은 composer recompose 가 담당한다.
                // 이 문단부터 적용되는 단 정의 (구역 중간 다단↔단일단 전환).
                if let Some(cd) = para.controls.iter().rev().find_map(|c| match c {
                    Control::ColumnDef(cd) => Some(cd),
                    _ => None,
                }) {
                    column_def = cd.clone();
                    current_col_width_hu = column_width_hu(&column_def);
                    if pi > 0 {
                        preceding_exclusions.clear();
                        unbroken_body_end = None;
                    }
                }
                para_col_width_hu.push(current_col_width_hu);
                if Self::needs_line_seg_reflow(para, include_empty) {
                    // 편집 reflow 와 같은 한컴 폭 모델 (첫 단 폭, 4 HU 격자, 문단 여백).
                    let layout = PageLayoutInfo::from_page_def(&page_def, &column_def, dpi);
                    let col_width = layout
                        .column_areas
                        .first()
                        .map_or(layout.body_area.width, |a| a.width);
                    let available_width =
                        Self::column_line_width_px(col_width, para.para_shape_id, styles, dpi);
                    if own_line_layout {
                        use crate::model::paragraph::ColumnBreakType;
                        use crate::model::shape::{HorzRelTo, TextWrap, VertAlign, VertRelTo};

                        let style = styles.para_styles.get(para.para_shape_id as usize);
                        if matches!(
                            para.column_type,
                            ColumnBreakType::Page | ColumnBreakType::Section
                        ) || style.is_some_and(|s| s.page_break_before)
                        {
                            preceding_exclusions.clear();
                            unbroken_body_end = Some(0.0);
                            previous_spacing_after = 0.0;
                        }
                        let simple_picture = |p: &crate::model::image::Picture| {
                            p.caption.is_none()
                                && (p.common.treat_as_char
                                    || (p.common.flow_with_text
                                        && matches!(
                                            p.common.text_wrap,
                                            TextWrap::Square | TextWrap::Tight | TextWrap::Through
                                        )
                                        && matches!(p.common.vert_rel_to, VertRelTo::Para)
                                        && matches!(
                                            p.common.vert_align,
                                            VertAlign::Top | VertAlign::Inside
                                        )
                                        && matches!(
                                            p.common.horz_rel_to,
                                            HorzRelTo::Column | HorzRelTo::Para
                                        )))
                        };
                        let simple_flow = layout.column_areas.len() == 1
                            && !matches!(
                                para.column_type,
                                ColumnBreakType::Column | ColumnBreakType::MultiColumn
                            )
                            && !style.is_some_and(|s| {
                                s.keep_with_next || s.keep_lines || s.widow_orphan
                            })
                            && para.controls.iter().all(|c| match c {
                                Control::SectionDef(_) | Control::ColumnDef(_) => true,
                                Control::Picture(p) => simple_picture(p),
                                Control::Shape(s) => match s.as_ref() {
                                    ShapeObject::Picture(p) => simple_picture(p),
                                    _ => false,
                                },
                                _ => false,
                            });
                        if !simple_flow {
                            preceding_exclusions.clear();
                            unbroken_body_end = None;
                        }
                        let gap = (previous_spacing_after
                            + style.map_or(0.0, |s| s.spacing_before))
                        .max(0.0);
                        let body_start = unbroken_body_end.map(|end| end + gap);
                        for exclusion in &mut preceding_exclusions {
                            exclusion.rect.y -= gap;
                        }
                        let mut owned = reflow_line_segs_with_exclusions(
                            para,
                            available_width,
                            styles,
                            dpi,
                            &preceding_exclusions,
                        );
                        let flow_height = |p: &Paragraph| {
                            p.line_segs
                                .iter()
                                .map(|line| {
                                    crate::renderer::hwpunit_to_px(
                                        line.line_height
                                            .max(line.text_height)
                                            .saturating_add(line.line_spacing),
                                        dpi,
                                    )
                                })
                                .sum::<f64>()
                        };
                        let mut height = flow_height(para);
                        // 이 문단 자체가 다음 쪽으로 갈 수 있으면 외부 배제를 적용하지
                        // 않는다. 줄을 먼저 좁힌 채 페이지 넘김으로 넘겨 보내면 안 된다.
                        if !preceding_exclusions.is_empty()
                            && body_start
                                .is_none_or(|start| start + height > layout.body_area.height)
                        {
                            preceding_exclusions.clear();
                            owned = reflow_line_segs_with_exclusions(
                                para,
                                available_width,
                                styles,
                                dpi,
                                &[],
                            );
                            height = flow_height(para);
                        }
                        unbroken_body_end = body_start
                            .map(|start| start + height)
                            .filter(|end| end.is_finite() && *end <= layout.body_area.height);
                        if let (Some(start), Some(_)) = (body_start, unbroken_body_end) {
                            owned.retain(|exclusion| {
                                let top = start + exclusion.rect.y;
                                let bottom = start + exclusion.rect.y + exclusion.rect.height;
                                top >= 0.0
                                    && bottom.is_finite()
                                    && bottom <= layout.body_area.height
                            });
                            preceding_exclusions.extend(owned);
                            for exclusion in &mut preceding_exclusions {
                                exclusion.rect.y -= height;
                            }
                            preceding_exclusions
                                .retain(|exclusion| exclusion.rect.y + exclusion.rect.height > 0.0);
                        } else {
                            preceding_exclusions.clear();
                        }
                        previous_spacing_after = style.map_or(0.0, |s| s.spacing_after);
                    } else {
                        reflow_line_segs(para, available_width, styles, dpi);
                    }
                    Self::mark_synthesized_line_segs(para);
                    body_line_seg_changed = true;
                    reflowed_paras.insert(pi);
                } else if own_line_layout {
                    preceding_exclusions.clear();
                    unbroken_body_end = None;
                }

                // HWPX: TAC 표가 있는 문단의 LINE_SEG lh 보정
                // HWPX에서 linesegarray가 없으면 기본 lh=100이 생성되지만,
                // HWP에서는 TAC 표 높이가 lh에 포함됨 → HWPX에서도 동일하게 확대
                {
                    let mut max_tac_h: i32 = 0;
                    for ctrl in para.controls.iter() {
                        if let Control::Table(t) = ctrl {
                            if t.common.treat_as_char
                                && t.raw_ctrl_data.is_empty()
                                && t.common.height > 0
                            {
                                max_tac_h = max_tac_h.max(t.common.height as i32);
                            }
                        }
                    }
                    if max_tac_h > 0
                        && !matches!(
                            para.line_segs.as_slice(),
                            [seg] if seg.is_missing_lineseg_placeholder()
                        )
                    {
                        // [Task #1068] 이미 표 높이를 담은 LINE_SEG 가 있으면(한컴이
                        // 저장한 실제 linesegarray 보유 — 표 줄 seg 의 vertsize 가 표
                        // 높이) 보정 불필요. 무조건 first_mut() 을 확대하면 표가 두 번째
                        // 이후 줄에 있는 문단(제목줄 + 표줄)의 제목줄 lh 까지 표 높이로
                        // 오염되어, 렌더러의 lh 기반 표 줄 탐지(place_table_with_text)가
                        // 첫 줄을 오매칭 → 표 줄 이중 그리기 overflow (#1068 제안요청서
                        // para 567: 제목줄 vertsize=2200 → 63234 오염, 839px overflow).
                        // linesegarray 가 없어 기본 lh=100 단일 seg 만 있는 경우에만
                        // 첫 seg 를 표 높이로 확대한다.
                        // HWP5-origin HWPX export marker 는 "원본 LineSeg 부재"를 보존하기
                        // 위한 임시 표식이므로 여기서 표 높이로 오염시키면 안 된다.
                        // 이 marker 는 reflow gate 후 clear_missing_lineseg_placeholders 에서
                        // 제거되어 HWP5 원본과 같은 line_segs.is_empty() 경로를 타야 한다.
                        let already_covered =
                            para.line_segs.iter().any(|s| s.line_height >= max_tac_h);
                        if !already_covered {
                            if let Some(seg) = para.line_segs.first_mut() {
                                if seg.line_height < max_tac_h {
                                    seg.line_height = max_tac_h;
                                    body_line_seg_changed = true;
                                }
                            }
                        }
                    }
                }

                // 표 셀 내부 문단 reflow
                for ctrl in &mut para.controls {
                    if let Control::Table(ref mut table) = ctrl {
                        let is_rowbreak_table = matches!(
                            table.page_break,
                            crate::model::table::TablePageBreak::RowBreak
                        );
                        // [Task #671] 셀 줄 폭은 셀 안 영역 폭이다 (단 폭이면 셀 밖으로 줄이
                        // 채워진다). 편집 reflow 와 같은 한컴 셀 폭 모델 — 병합 셀 간격·행
                        // 끝 셀 표 폭 확장·안 여백(셀 지정/표 기본)·4 HU 격자·문단 여백·하한
                        // 1440 HU (`table_cells_line_metrics`).
                        // 가로 셀의 줄을 먼저 확정해야 실제 행 높이를 알 수 있다.
                        // 세로 셀의 논리적 줄 길이는 그 행 높이들의 걸침 합이다.
                        for vertical_pass in [false, true] {
                            let metrics = if vertical_pass {
                                Self::table_cells_reflow_metrics(table, styles, dpi, layout_profile)
                            } else {
                                Self::table_cells_line_metrics(table)
                            };
                            for (cell_idx, cell) in table.cells.iter_mut().enumerate() {
                                if Self::cell_uses_vertical_reflow(cell) != vertical_pass {
                                    continue;
                                }
                                let cell_metrics = metrics.get(cell_idx).copied().flatten();
                                // [#2195/#2146] 사선(대각선) 셀의 빈 문단은 코너 라벨의
                                // 짝 — 한글은 흐름 배치하지 않으므로 합성 제외 (21761835
                                // r0 라벨 셀 선언 52.4px 유지, 합성 시 +2.4 팽창).
                                let bf_has_diagonal = |bf_id: u16| {
                                    bf_id != 0
                                        && styles
                                            .border_styles
                                            .get((bf_id as usize).saturating_sub(1))
                                            .is_some_and(
                                                crate::renderer::layout::border_style_has_diagonal,
                                            )
                                };
                                let cell_diagonal = bf_has_diagonal(cell.border_fill_id)
                                    || table.zones.iter().any(|z| {
                                        z.start_row <= cell.row
                                            && cell.row <= z.end_row
                                            && z.start_col <= cell.col
                                            && cell.col <= z.end_col
                                            && bf_has_diagonal(z.border_fill_id)
                                    });
                                let squeeze =
                                    cell.line_wrap == crate::model::table::CellLineWrap::Squeeze;
                                let mut first_synth: Option<usize> = None;
                                for (cpi, cell_para) in cell.paragraphs.iter_mut().enumerate() {
                                    // [#2195] 셀 NO_LS 확장은 **컨트롤 없는 순수 빈 문단**
                                    // 한정 — CharPr 크기 기반 줄박스 합성(86712 1pt 빈
                                    // 문단 오라클). 텍스트 셀 문단은 렌더러 recompose,
                                    // 컨트롤(중첩 표 등) 호스트 문단은 typeset 표 줄
                                    // 계산이 담당한다 — 합성 시 중첩 표 높이와 이중
                                    // 계상(80168 pi=1243 행6 264→467px, 158 회귀).
                                    let inc = include_empty
                                        || (include_cell_empty
                                            && cell_para.text.is_empty()
                                            && cell_para.controls.is_empty()
                                            && !cell_diagonal);
                                    if let (true, Some(m)) =
                                        (Self::needs_line_seg_reflow(cell_para, inc), cell_metrics)
                                    {
                                        let width = Self::reflow_width_from_cell_metrics(
                                            m,
                                            cell_para.para_shape_id,
                                            styles,
                                            dpi,
                                        );
                                        super::text_editing::reflow_cell_line_segs(
                                            cell_para, width, squeeze, styles, dpi,
                                        );
                                        Self::mark_synthesized_line_segs(cell_para);
                                        first_synth.get_or_insert(cpi);
                                    }
                                }
                                // 합성 문단은 vpos 0 에서 시작한다 — 편집 경로처럼 앞 문단 끝 +
                                // 앞 sa + 뒤 sb 로 셀 안 사다리를 잇는다 (한컴 저장 셀 사다리).
                                if let Some(start) = first_synth {
                                    Self::seed_list_top_spacing(
                                        &mut cell.paragraphs,
                                        start,
                                        styles,
                                        dpi,
                                        is_hwp3_variant,
                                    );
                                    super::text_editing::recalculate_cell_paragraph_vpos(
                                        &mut cell.paragraphs,
                                        start,
                                        None,
                                        styles,
                                        dpi,
                                        is_hwp3_variant,
                                    );
                                }
                                // 저장 줄이 섞인 RowBreak 셀의 부족 줄 보강은 저장 anchor 높이에 맞춘
                                // 추정이다. 문서 전체를 직접 조판하면 줄은 이미 한컴 규칙대로이고
                                // 선언 셀 높이는 행 높이가 지킨다 — 보강하면 마지막 글자를 다음
                                // 줄로 잘라 외톨이 ")" 줄을 만든다 (gov-lecturer "(목|)" 등).
                                if include_empty && is_rowbreak_table && !own_line_layout {
                                    Self::fit_hwpx_rowbreak_synthetic_cell_lines(
                                        cell,
                                        styles,
                                        dpi,
                                        table.common.treat_as_char,
                                    );
                                }
                                if include_empty {
                                    for cell_para in &mut cell.paragraphs {
                                        Self::synthesize_missing_control_lines(
                                            &mut cell_para.controls,
                                            styles,
                                            dpi,
                                            is_hwp3_variant,
                                            layout_profile,
                                        );
                                    }
                                }
                            }
                        }
                        if include_empty {
                            if let Some(caption) = &mut table.caption {
                                let m = Self::caption_line_metrics(caption);
                                Self::synthesize_missing_list_lines(
                                    &mut caption.paragraphs,
                                    m,
                                    styles,
                                    dpi,
                                    is_hwp3_variant,
                                    layout_profile,
                                );
                            }
                        }
                    }
                }
                // [lso-load] XML 임포트: 본문 문단의 나머지 하위 목록(글상자·그림 캡션·
                // 각주/미주)도 편집 reflow 와 같은 한컴 폭 모델로 합성한다.
                // 비워 두면 렌더 시점 recompose 가 렌더 격자 폭으로 따로 줄을 나눠 편집
                // 경로·한컴과 어긋난다.
                if include_empty {
                    Self::synthesize_missing_page_lists(
                        para,
                        &section.section_def,
                        &column_def,
                        styles,
                        dpi,
                        is_hwp3_variant,
                        layout_profile,
                        own_line_layout,
                    );
                }
            }

            // HWPX: LINE_SEG를 실제로 합성/보정한 경우에만 문단 간 vpos를 재계산한다.
            //
            // 명시적인 lineSegArray가 이미 계산 완료 상태인 문서는 source의 vertpos를 보존해야 한다.
            // 비-TAC TopAndBottom 표/그림이 있다는 이유만으로 section vpos를 다시 계산하면, 한컴이
            // 저장한 HWPX의 vertpos까지 덮어써 page sequence가 어긋난다 (#949 Stage 32).
            // 본문 시작(종이 기준) HU — 종이 기준 개체 좌표를 본문 vpos 로 옮긴다.
            let body_top_hu = i32::try_from(
                section
                    .section_def
                    .page_def
                    .margin_header
                    .saturating_add(section.section_def.page_def.margin_top),
            )
            .unwrap_or(0);
            if body_line_seg_changed {
                let mut running_vpos: i32 = 0;
                // [Issue #1920] 직전까지 본 "원본(비합성) lineseg 보유 문단"의 마지막 저장
                // vpos. 결재문서류 생성기는 새 쪽 시작 문단(발신명의 틀 host)에 vpos=0 을
                // 저장하는데, 이 재계산이 연속 좌표로 덮어쓰면 typeset 의 vpos-reset 쪽나눔
                // (#321, paragraph_saved_vpos_reset_starts_new_page_after)이 무력화되어
                // 한글이 다음 쪽에 두는 틀이 이전 쪽에 흡수된다(36417450 pi8, 1쪽 vs 2쪽).
                // 원본 first vpos=0 + 직전 저장 vpos>5000(동일 임계) + 쪽 하단 고정 틀
                // (vert=쪽·valign=Bottom, 발신명의 서명란·직인 틀) host 문단에서만
                // running_vpos 를 0 으로 되돌려 리셋 신호를 재계산 좌표계에 보존한다.
                // 틀 host 한정인 이유: 일반 문단의 mid-doc vpos=0 은 생성기 노이즈일 수
                // 있어(task1749 pi2/47) 전면 보존 시 무관 문서의 배치가 흔들린다.
                // wrap 은 불문 — 자리차지(발신명의)와 글뒤로(직인 도장, 36408321 pi12)
                // 모두 같은 새 쪽 시그니처다.
                let mut prev_stored_last_vpos: i32 = 0;
                // [#2279 성분②] 원본(비합성) 문단의 저장 (first vpos, last end)
                // 스냅샷 — TopAndBottom 개체 host 의 저장 관례(개체-선행 vs
                // lh-포함)를 lead = host_first − prev_last_end 로 판별하기 위한
                // 사전 수집 (재구성 루프가 vpos 를 덮어쓰기 전).
                let orig_span: Vec<Option<(i32, i32)>> = section
                    .paragraphs
                    .iter()
                    .enumerate()
                    .map(|(i, p)| {
                        if reflowed_paras.contains(&i) {
                            return None;
                        }
                        let first = p.line_segs.first()?;
                        let last = p.line_segs.last()?;
                        let synthetic = |s: &crate::model::paragraph::LineSeg| {
                            s.tag & crate::model::paragraph::LineSeg::TAG_IMPLEMENTATION_PROPERTY
                                != 0
                        };
                        if synthetic(first) || synthetic(last) {
                            return None;
                        }
                        Some((
                            first.vertical_pos,
                            last.vertical_pos + last.line_height + last.line_spacing,
                        ))
                    })
                    .collect();
                let ladder_trusted =
                    stored_ladder_is_hancom_flow(&section.paragraphs, &orig_span, styles, dpi);
                // [lso-spacing] 직전 lineseg 보유 문단의 (합성 여부, spacing_after HU).
                let mut prev_boundary: Option<(bool, f64)> = None;
                for (pi, para) in section.paragraphs.iter_mut().enumerate() {
                    let was_reflowed = reflowed_paras.contains(&pi);
                    // [#2158] 한컴 흐름 사다리를 저장한 구역(합성 문단은 일부)은 저장 문단의
                    // 쪽-상대 vpos 를 그대로 둔다. 연속 좌표로 덮으면 저장 문단이 쪽 경계를
                    // 다시 맞추던 근거가 사라져 합성 문단 키 오차가 쪽을 넘긴다
                    // (hwp3-sample16 HWPX: HWP5·한글 64쪽인데 65쪽). 합성 문단은 앞 문단
                    // 끝에서 이어 붙인다.
                    let keep_stored =
                        ladder_trusted && orig_span.get(pi).copied().flatten().is_some();
                    if keep_stored {
                        running_vpos = para.line_segs[0].vertical_pos;
                    }
                    let reset_before = running_vpos;
                    let hosts_bottom_fixed_frame = para.controls.iter().any(|c| {
                        matches!(c, Control::Table(t)
                        if !t.common.treat_as_char
                            && matches!(
                                t.common.vert_rel_to,
                                crate::model::shape::VertRelTo::Page
                            )
                            && matches!(
                                t.common.vert_align,
                                crate::model::shape::VertAlign::Bottom
                            ))
                    });
                    if keep_stored {
                    } else if !was_reflowed
                        && hosts_bottom_fixed_frame
                        && prev_stored_last_vpos > 5000
                        && para.line_segs.first().map(|s| s.vertical_pos) == Some(0)
                    {
                        running_vpos = 0;
                    } else if let (false, Some(first)) =
                        (was_reflowed, para.line_segs.first().map(|s| s.vertical_pos))
                    {
                        // [#2158] #1920 예외의 일반화: 원본(비합성) lineseg 문단의 저장
                        // first vpos 가 직전 저장 vpos(한 쪽 분량 초과, #1921 near-top
                        // 임계 60000HU 동일) 대비 쪽 상단 좌표(<5000HU)로 급감하면
                        // 쪽-상대 리셋(쪽나눔 인코딩)으로 보고 재계산 좌표계에 보존한다.
                        // 미보존 시 typeset 의 vpos-reset 쪽나눔(#321/#1921)이 무력화되어
                        // HWPX 로딩만 쪽이 당겨진다 (hwp3-sample16-hwpx pi88: 저장 568이
                        // 208008 로 변조 → 3쪽부터 전면 당김, 63쪽 vs 한글 64쪽).
                        // first==0 은 제외 — mid-doc vpos=0 은 생성기 노이즈일 수 있어
                        // (task1749 pi2/27/47 실측, 흔들면 HWP 참조 컷 회귀) 쪽 하단
                        // 고정 틀 host 한정의 기존 #1920 규칙에만 맡긴다. 정당한 텍스트
                        // 쪽나눔 리셋은 sb 를 반영한 양수 쪽 상단 좌표(sample16
                        // pi88=568)로 저장된다. 소폭 감소·중간 좌표 리셋도 보존하지
                        // 않는다.
                        if prev_stored_last_vpos > 60000
                            && first > 0
                            && first < 5000
                            && first < prev_stored_last_vpos
                        {
                            running_vpos = first;
                        }
                    }
                    // [lso-spacing] 한컴 저장 ladder 는 문단 경계마다
                    // vpos(다음 첫 줄) = vpos(앞 끝 줄) + lh + ls + 앞 sa + 뒤 sb 를 정확히
                    // 인코딩한다(20문서 2,879 경계 HU 단위 일치). 합성 문단이 낀 경계는
                    // 저장 gap 이 없으므로 스타일에서 재유도한다 — 편집 경로
                    // recalculate_section_vpos 의 변조 인접 경계와 같은 산식.
                    if !keep_stored && running_vpos == reset_before && !para.line_segs.is_empty() {
                        if let Some((prev_reflowed, prev_sa)) = prev_boundary {
                            if was_reflowed || prev_reflowed {
                                let sb = styles
                                    .para_styles
                                    .get(para.para_shape_id as usize)
                                    .map(|s| s.spacing_before)
                                    .unwrap_or(0.0);
                                let sb = crate::renderer::hwp3_variant_flow_spacing_before(
                                    sb,
                                    is_hwp3_variant,
                                );
                                running_vpos += crate::renderer::px_to_hwpunit_round(
                                    (prev_sa + sb).max(0.0),
                                    dpi,
                                );
                            }
                        }
                    }
                    if !para.line_segs.is_empty() {
                        let sa = styles
                            .para_styles
                            .get(para.para_shape_id as usize)
                            .map(|s| s.spacing_after)
                            .unwrap_or(0.0);
                        prev_boundary = Some((was_reflowed, sa));
                    }
                    let original_last_vpos = if was_reflowed {
                        None
                    } else {
                        para.line_segs.last().map(|s| s.vertical_pos)
                    };
                    // 합성 줄은 테두리 위 여백까지 포함한 th로 진행한다. 저장 줄은
                    // 기존 TAC lh > th 보정만 유지한다.
                    let advance_of = |seg: &LineSeg| {
                        if seg.text_height > 0
                            && (was_reflowed || seg.line_height > seg.text_height)
                        {
                            // lh가 th보다 큼 = TAC 컨트롤 높이 포함 → th 기준 누적
                            seg.text_height + seg.line_spacing
                        } else {
                            seg.line_height + seg.line_spacing
                        }
                    };
                    // [lso-load3] 종이/쪽 기준 자리차지 개체(비-TAC 위아래)는 문단 흐름이 아니라
                    // 본문 좌표에 놓인다. 개체가 host 첫 줄 자리를 덮으면 한컴은 host 줄을
                    // 개체 아래(바깥 아래 여백 포함)로 내린다 — exam-kor/exam-social 머리 표:
                    // 종이 오프셋 5669 + 높이 13322 + 아래 1134 − 본문 시작 11196 = 첫 줄
                    // 8929 (저장값과 일치). 연속 좌표라 첫 쪽에서만 성립하지만 쪽 상단 머리
                    // 개체가 이 경우다.
                    if was_reflowed {
                        if let Some(first) = para.line_segs.first() {
                            let line_end = running_vpos + first.line_height;
                            for ctrl in para.controls.iter() {
                                let Some((top, bottom)) =
                                    page_anchored_block_span(ctrl, body_top_hu)
                                else {
                                    continue;
                                };
                                if top < line_end && bottom > running_vpos {
                                    running_vpos = bottom;
                                }
                            }
                        }
                    }
                    // 문단 LINE_SEG vpos 를 running_vpos 부터 문단 안 누적으로 갱신
                    let mut inner_vpos = running_vpos;
                    if keep_stored {
                        let last = &para.line_segs[para.line_segs.len() - 1];
                        inner_vpos = last.vertical_pos + advance_of(last);
                    } else {
                        for seg in para.line_segs.iter_mut() {
                            seg.vertical_pos = inner_vpos;
                            inner_vpos += advance_of(seg);
                        }
                    }
                    // 비-TAC TopAndBottom Picture/Table: 개체 높이를 vpos에 반영
                    for ctrl in para.controls.iter() {
                        // 종이/쪽 기준 개체는 위에서 host 줄을 내리는 규칙으로 처리했다.
                        if page_anchored_block_span(ctrl, body_top_hu).is_some() {
                            continue;
                        }
                        let (obj_height, obj_v_offset, obj_margin_top, obj_margin_bottom) =
                            match ctrl {
                                Control::Picture(p)
                                    if !p.common.treat_as_char
                                        && matches!(
                                            p.common.text_wrap,
                                            crate::model::shape::TextWrap::TopAndBottom
                                        )
                                        && p.common.height > 0 =>
                                {
                                    (
                                        p.common.height as i32,
                                        p.common.vertical_offset as i32,
                                        0,
                                        0,
                                    )
                                }
                                Control::Table(t)
                                    if !t.common.treat_as_char
                                        && matches!(
                                            t.common.text_wrap,
                                            crate::model::shape::TextWrap::TopAndBottom
                                        )
                                        && t.common.height > 0
                                        && t.raw_ctrl_data.is_empty() =>
                                {
                                    (
                                        t.common.height as i32,
                                        t.common.vertical_offset as i32,
                                        t.outer_margin_top as i32,
                                        t.outer_margin_bottom as i32,
                                    )
                                }
                                // 묶음/그리기 개체도 같은 자리차지 규칙이다 (편람 s1 p3 묶음
                                // h=6315+om 1417 → 다음 문단 7732).
                                Control::Shape(shape)
                                    if !shape.common().treat_as_char
                                        && matches!(
                                            shape.common().text_wrap,
                                            crate::model::shape::TextWrap::TopAndBottom
                                        )
                                        && matches!(
                                            shape.common().vert_rel_to,
                                            crate::model::shape::VertRelTo::Para
                                        )
                                        && shape.common().height > 0 =>
                                {
                                    let c = shape.common();
                                    (
                                        c.height as i32,
                                        c.vertical_offset as i32,
                                        c.margin.top as i32,
                                        c.margin.bottom as i32,
                                    )
                                }
                                _ => continue,
                            };
                        // 음수 세로 오프셋은 흐름을 되감지 않는다 — 한컴은 표를 host 줄
                        // 위로 올리지 않고 다음 문단을 host + 위 여백 + 높이 + 아래 여백에
                        // 둔다 (kedi 저장본: v_off −8083 표의 사다리 델타 18148 = 17582+566).
                        // 단 밖(가로로 단 글 영역과 겹치지 않는) 개체는 단 글을 밀지 않는다
                        // (mock 1쪽 오른쪽 단: 단 기준 가운데+22531 그림 → 한컴 사다리 lh+ls 만).
                        let col_w = para_col_width_hu.get(pi).copied().unwrap_or(i32::MAX);
                        if object_clears_column_horizontally(ctrl, col_w) {
                            continue;
                        }
                        let obj_total =
                            obj_height + obj_v_offset.max(0) + obj_margin_top + obj_margin_bottom;
                        let seg_lh_total: i32 = para
                            .line_segs
                            .iter()
                            .map(|s| s.line_height + s.line_spacing)
                            .sum();
                        // [#2279 성분②] 한글 저장 관례는 두 가지가 혼재한다
                        // (같은 문서 안에서도, 36372309 실측):
                        //   (a) 개체-선행: host_first = prev_end + obj_total,
                        //       host 줄박스는 개체 **아래** 별도 (결재 코호트:
                        //       host_v 17640 = 표+om, gap 1920 = lh+ls)
                        //   (b) lh-포함: host lh 가 개체를 포함 (TAC/#2243 앵커)
                        // 종전 max 모델(초과분만 가산)은 (a)의 host 줄박스를
                        // 흡수해 사다리를 -lh-ls 압축, 후속 vpos-snap 이 그만큼
                        // 과소 좌표로 고착됐다(footer 오차 성분②). 판별은
                        // lead = 저장 host_first − 직전 원본 문단의 저장 last_end:
                        // lead ≈ obj_total → (a) → obj_total 별도 가산 / 그 외
                        // (판별 불가·합성 이웃 포함) → 종전 max 모델(보수).
                        let lead = if !was_reflowed {
                            let host_first = orig_span.get(pi).copied().flatten().map(|s| s.0);
                            let prev_end = if pi == 0 {
                                Some(0)
                            } else {
                                orig_span.get(pi - 1).copied().flatten().map(|s| s.1)
                            };
                            match (host_first, prev_end) {
                                (Some(h), Some(p)) => Some(h - p),
                                _ => None,
                            }
                        } else {
                            None
                        };
                        let object_precedes_host_line =
                            lead.is_some_and(|l| (l - obj_total).abs() <= 60);
                        if object_precedes_host_line {
                            inner_vpos += obj_total;
                        } else if obj_total > seg_lh_total {
                            inner_vpos += obj_total - seg_lh_total;
                        }
                    }
                    running_vpos = inner_vpos;
                    if let Some(v) = original_last_vpos {
                        prev_stored_last_vpos = v;
                    }
                }
            }
        }
    }

    /// 하위 목록(셀·글상자·캡션) 첫 문단이 합성 줄이면 첫 줄 vpos 를 그 문단의 문단 위
    /// 간격으로 둔다. 한컴 저장 사다리는 목록 첫 줄도 문단 위 간격만큼 내려 시작한다
    /// (top20 저장본 하위 목록 177개 전부 vpos = sb, 0 인 경우 없음). 0 에서 시작하면
    /// 둘째 문단부터 sb 만큼 위로 붙는다 (kedi 표 셀 2pt).
    fn seed_list_top_spacing(
        paras: &mut [Paragraph],
        start: usize,
        styles: &ResolvedStyleSet,
        dpi: f64,
        is_hwp3_variant: bool,
    ) {
        if start != 0 {
            return;
        }
        let Some(first) = paras.first_mut() else {
            return;
        };
        let sb = styles
            .para_styles
            .get(first.para_shape_id as usize)
            .map(|style| style.spacing_before)
            .unwrap_or(0.0);
        let sb = crate::renderer::hwp3_variant_flow_spacing_before(sb, is_hwp3_variant);
        let Some(origin) = first.line_segs.first().map(|seg| seg.vertical_pos) else {
            return;
        };
        let delta = crate::renderer::px_to_hwpunit_round(sb, dpi) - origin;
        for seg in &mut first.line_segs {
            seg.vertical_pos += delta;
        }
    }

    /// 하위 문단 목록 하나에서 LINE_SEG 가 없는 문단을 `metrics`(폭, 좌·우 안 여백 HU)의
    /// 한컴 줄 폭으로 합성하고 목록 안 vpos 사다리를 잇는다. 하위 개체로 내려간다.
    fn synthesize_missing_list_lines(
        paras: &mut [Paragraph],
        metrics: (u32, i16, i16),
        styles: &ResolvedStyleSet,
        dpi: f64,
        is_hwp3_variant: bool,
        layout_profile: LayoutCompatibilityProfile,
    ) {
        Self::synthesize_cell_list_lines(
            paras,
            metrics,
            false,
            styles,
            dpi,
            is_hwp3_variant,
            layout_profile,
        );
    }

    fn synthesize_cell_list_lines(
        paras: &mut [Paragraph],
        metrics: (u32, i16, i16),
        squeeze: bool,
        styles: &ResolvedStyleSet,
        dpi: f64,
        is_hwp3_variant: bool,
        layout_profile: LayoutCompatibilityProfile,
    ) {
        let width = |psid: u16| Self::reflow_width_from_cell_metrics(metrics, psid, styles, dpi);
        Self::synthesize_list_with(
            paras,
            &width,
            squeeze,
            false,
            styles,
            dpi,
            is_hwp3_variant,
            layout_profile,
        );
    }

    fn synthesize_list_with(
        paras: &mut [Paragraph],
        width_of: &dyn Fn(u16) -> f64,
        squeeze: bool,
        carry_note_floats: bool,
        styles: &ResolvedStyleSet,
        dpi: f64,
        is_hwp3_variant: bool,
        layout_profile: LayoutCompatibilityProfile,
    ) {
        let mut first: Option<usize> = None;
        // 주석 안의 어울림 그림은 뒤 문단의 줄 폭에도 영향을 준다.
        // 합성 문단의 전진량만 이어 붙이고 저장 줄이나 다음 주석까지 넘기지 않는다.
        let mut preceding_exclusions: Vec<FloatExclusion> = Vec::new();
        let mut previous_spacing_after = 0.0;
        for (i, para) in paras.iter_mut().enumerate() {
            if Self::needs_line_seg_reflow(para, true) {
                let width = width_of(para.para_shape_id);
                if carry_note_floats {
                    let style = styles.para_styles.get(para.para_shape_id as usize);
                    let spacing_before = crate::renderer::hwp3_variant_flow_spacing_before(
                        style.map_or(0.0, |style| style.spacing_before),
                        is_hwp3_variant,
                    );
                    let gap = crate::renderer::hwpunit_to_px(
                        crate::renderer::px_to_hwpunit_round(
                            previous_spacing_after + spacing_before,
                            dpi,
                        ),
                        dpi,
                    );
                    for exclusion in &mut preceding_exclusions {
                        exclusion.rect.y -= gap;
                    }
                    let owned = reflow_line_segs_with_exclusions(
                        para,
                        width,
                        styles,
                        dpi,
                        &preceding_exclusions,
                    );
                    let height = para
                        .line_segs
                        .iter()
                        .map(|seg| {
                            crate::renderer::hwpunit_to_px(
                                seg.line_height
                                    .max(seg.text_height)
                                    .saturating_add(seg.line_spacing),
                                dpi,
                            )
                        })
                        .sum::<f64>();
                    preceding_exclusions.extend(owned);
                    for exclusion in &mut preceding_exclusions {
                        exclusion.rect.y -= height;
                    }
                    preceding_exclusions
                        .retain(|exclusion| exclusion.rect.y + exclusion.rect.height > 0.0);
                    previous_spacing_after = style.map_or(0.0, |style| style.spacing_after);
                } else {
                    super::text_editing::reflow_cell_line_segs(para, width, squeeze, styles, dpi);
                }
                Self::mark_synthesized_line_segs(para);
                first.get_or_insert(i);
            } else {
                preceding_exclusions.clear();
                previous_spacing_after = 0.0;
            }
        }
        if let Some(start) = first {
            Self::seed_list_top_spacing(paras, start, styles, dpi, is_hwp3_variant);
            super::text_editing::recalculate_cell_paragraph_vpos(
                paras,
                start,
                None,
                styles,
                dpi,
                is_hwp3_variant,
            );
        }
        for para in paras.iter_mut() {
            Self::synthesize_missing_control_lines(
                &mut para.controls,
                styles,
                dpi,
                is_hwp3_variant,
                layout_profile,
            );
        }
    }

    /// 누락/높이 0 캐시에서 합성한 줄의 출처를 유지한다. 혼합 문서의 글꼴 새로고침은
    /// 이 문단만 다시 조판하고 원본의 저장 줄 나눔은 보존한다.
    fn mark_synthesized_line_segs(para: &mut Paragraph) {
        for seg in &mut para.line_segs {
            seg.tag |= LineSeg::TAG_IMPLEMENTATION_PROPERTY;
        }
    }

    /// 표 캡션 줄 폭 지표 — 편집 경로(`cell_metrics_for_control`)와 같다: 좌/우 캡션은
    /// 캡션 폭, 위/아래 캡션은 최대 폭.
    fn caption_line_metrics(caption: &Caption) -> (u32, i16, i16) {
        use crate::model::shape::CaptionDirection;
        let w = match caption.direction {
            CaptionDirection::Left | CaptionDirection::Right => caption.width,
            _ => caption.max_width,
        };
        (w, 0, 0)
    }

    /// 캡션 안의 개체 캡션부터 조판한다. 저장 줄은 기존 합성 가드가 그대로 보존한다.
    fn synthesize_missing_caption_lines(
        caption: &mut Option<Caption>,
        fallback_width: u32,
        styles: &ResolvedStyleSet,
        dpi: f64,
        is_hwp3_variant: bool,
        layout_profile: LayoutCompatibilityProfile,
    ) {
        let Some(caption) = caption else { return };
        visit_paragraphs_mut(&mut caption.paragraphs, &mut |para| {
            Self::synthesize_missing_control_captions(
                &mut para.controls,
                styles,
                dpi,
                is_hwp3_variant,
                layout_profile,
            );
        });
        let mut metrics = Self::caption_line_metrics(caption);
        if metrics.0 == 0 {
            metrics.0 = fallback_width;
        }
        // 저장 문단을 경계로 끊어 합성한다. 뒤의 저장 vpos를 앞의 새 줄에 맞춰
        // 이동시키면 혼합 캐시의 원본 앵커까지 잃는다.
        let mut start = 0;
        while start < caption.paragraphs.len() {
            if !Self::needs_line_seg_reflow(&caption.paragraphs[start], true) {
                start += 1;
                continue;
            }
            let end = (start + 1..caption.paragraphs.len())
                .find(|&i| !Self::needs_line_seg_reflow(&caption.paragraphs[i], true))
                .unwrap_or(caption.paragraphs.len());
            Self::synthesize_missing_list_lines(
                &mut caption.paragraphs[start..end],
                metrics,
                styles,
                dpi,
                is_hwp3_variant,
                layout_profile,
            );
            if start > 0 {
                super::text_editing::recalculate_cell_paragraph_vpos(
                    &mut caption.paragraphs[..end],
                    start,
                    None,
                    styles,
                    dpi,
                    is_hwp3_variant,
                );
            }
            start = end;
        }
    }

    fn synthesize_missing_shape_captions(
        shape: &mut ShapeObject,
        styles: &ResolvedStyleSet,
        dpi: f64,
        is_hwp3_variant: bool,
        layout_profile: LayoutCompatibilityProfile,
    ) {
        let width = shape.common().width;
        let synthesize = |caption: &mut Option<Caption>| {
            Self::synthesize_missing_caption_lines(
                caption,
                width,
                styles,
                dpi,
                is_hwp3_variant,
                layout_profile,
            );
        };
        if let Some(drawing) = shape.drawing_mut() {
            synthesize(&mut drawing.caption);
        }
        match shape {
            ShapeObject::Group(group) => {
                synthesize(&mut group.caption);
                for child in &mut group.children {
                    Self::synthesize_missing_shape_captions(
                        child,
                        styles,
                        dpi,
                        is_hwp3_variant,
                        layout_profile,
                    );
                }
            }
            ShapeObject::Picture(picture) => synthesize(&mut picture.caption),
            ShapeObject::Chart(chart) => synthesize(&mut chart.caption),
            ShapeObject::Ole(ole) => synthesize(&mut ole.caption),
            _ => {}
        }
    }

    fn synthesize_missing_control_captions(
        controls: &mut [Control],
        styles: &ResolvedStyleSet,
        dpi: f64,
        is_hwp3_variant: bool,
        layout_profile: LayoutCompatibilityProfile,
    ) {
        for control in controls {
            match control {
                Control::Table(table) => Self::synthesize_missing_caption_lines(
                    &mut table.caption,
                    table.common.width,
                    styles,
                    dpi,
                    is_hwp3_variant,
                    layout_profile,
                ),
                Control::Picture(picture) => Self::synthesize_missing_caption_lines(
                    &mut picture.caption,
                    picture.common.width,
                    styles,
                    dpi,
                    is_hwp3_variant,
                    layout_profile,
                ),
                Control::Shape(shape) => {
                    Self::synthesize_missing_shape_captions(
                        shape,
                        styles,
                        dpi,
                        is_hwp3_variant,
                        layout_profile,
                    );
                }
                _ => {}
            }
        }
    }

    /// 개체 하위 목록(표 셀·캡션·글상자)을 재귀로 합성한다 (XML 임포트 전용).
    fn synthesize_missing_control_lines(
        controls: &mut [Control],
        styles: &ResolvedStyleSet,
        dpi: f64,
        is_hwp3_variant: bool,
        layout_profile: LayoutCompatibilityProfile,
    ) {
        for ctrl in controls {
            match ctrl {
                Control::Table(table) => {
                    for vertical_pass in [false, true] {
                        let metrics = if vertical_pass {
                            Self::table_cells_reflow_metrics(table, styles, dpi, layout_profile)
                        } else {
                            Self::table_cells_line_metrics(table)
                        };
                        for (cell, m) in table.cells.iter_mut().zip(metrics) {
                            if Self::cell_uses_vertical_reflow(cell) != vertical_pass {
                                continue;
                            }
                            if let Some(m) = m {
                                let squeeze =
                                    cell.line_wrap == crate::model::table::CellLineWrap::Squeeze;
                                Self::synthesize_cell_list_lines(
                                    &mut cell.paragraphs,
                                    m,
                                    squeeze,
                                    styles,
                                    dpi,
                                    is_hwp3_variant,
                                    layout_profile,
                                );
                            }
                        }
                    }
                    if let Some(caption) = &mut table.caption {
                        let m = Self::caption_line_metrics(caption);
                        Self::synthesize_missing_list_lines(
                            &mut caption.paragraphs,
                            m,
                            styles,
                            dpi,
                            is_hwp3_variant,
                            layout_profile,
                        );
                    }
                }
                Control::Shape(shape) => Self::synthesize_missing_shape_lines(
                    shape,
                    styles,
                    dpi,
                    is_hwp3_variant,
                    layout_profile,
                ),
                Control::Picture(pic) => {
                    let w = pic.common.width;
                    if let Some(caption) = &mut pic.caption {
                        Self::synthesize_missing_list_lines(
                            &mut caption.paragraphs,
                            (w, 0, 0),
                            styles,
                            dpi,
                            is_hwp3_variant,
                            layout_profile,
                        );
                    }
                }
                _ => {}
            }
        }
    }

    /// 글상자 줄 폭 = 개체 폭 − 글상자 안 여백 (편집 경로 `cell_metrics_for_control` 과 같다).
    /// 묶음 개체는 자식으로 내려간다.
    fn synthesize_missing_shape_lines(
        shape: &mut ShapeObject,
        styles: &ResolvedStyleSet,
        dpi: f64,
        is_hwp3_variant: bool,
        layout_profile: LayoutCompatibilityProfile,
    ) {
        if let ShapeObject::Group(group) = shape {
            for child in &mut group.children {
                Self::synthesize_missing_shape_lines(
                    child,
                    styles,
                    dpi,
                    is_hwp3_variant,
                    layout_profile,
                );
            }
            return;
        }
        let width = shape.common().width;
        if let Some(tb) = crate::document_core::helpers::get_textbox_from_shape_mut(shape) {
            let m = (width, tb.margin_left, tb.margin_right);
            Self::synthesize_missing_list_lines(
                &mut tb.paragraphs,
                m,
                styles,
                dpi,
                is_hwp3_variant,
                layout_profile,
            );
        }
    }

    /// 본문 문단의 각주/미주와 표 밖 개체 하위 목록을 합성한다. 주석 = 첫 단 폭 (편집
    /// 경로와 같은 함수). 머리말/꼬리말은 제외 — 바닥 정렬 꼬리말(쪽 번호)이 합성 줄
    /// 높이로 위로 밀린다 (gov-lecturer-review 4쪽 0.39→1.54%). 렌더 recompose 가 담당.
    fn synthesize_missing_page_lists(
        para: &mut Paragraph,
        section_def: &crate::model::document::SectionDef,
        column_def: &crate::model::page::ColumnDef,
        styles: &ResolvedStyleSet,
        dpi: f64,
        is_hwp3_variant: bool,
        layout_profile: LayoutCompatibilityProfile,
        own_line_layout: bool,
    ) {
        for ctrl in &mut para.controls {
            let (paras, is_footnote) = match ctrl {
                Control::Footnote(n) => (&mut n.paragraphs, true),
                Control::Endnote(n) => (&mut n.paragraphs, false),
                Control::Shape(_) | Control::Picture(_) => {
                    Self::synthesize_missing_control_lines(
                        std::slice::from_mut(ctrl),
                        styles,
                        dpi,
                        is_hwp3_variant,
                        layout_profile,
                    );
                    continue;
                }
                // 머리말/꼬리말 문단도 쪽 본문 폭(편집 경로와 같은 폭 모델)으로 합성하고,
                // 그 안의 표·글상자는 본문 개체와 같은 한컴 셀 폭·줄 규칙으로 합성한다
                // (donation 머리말 "대외주의" 표: recompose 줄높이로 세로 가운데가 −0.55pt).
                Control::Header(h) => {
                    let width_of = |psid: u16| {
                        Self::page_text_line_width_px(&section_def.page_def, psid, styles, dpi)
                    };
                    Self::synthesize_list_with(
                        &mut h.paragraphs,
                        &width_of,
                        false,
                        false,
                        styles,
                        dpi,
                        is_hwp3_variant,
                        layout_profile,
                    );
                    continue;
                }
                Control::Footer(f) => {
                    let width_of = |psid: u16| {
                        Self::page_text_line_width_px(&section_def.page_def, psid, styles, dpi)
                    };
                    Self::synthesize_list_with(
                        &mut f.paragraphs,
                        &width_of,
                        false,
                        false,
                        styles,
                        dpi,
                        is_hwp3_variant,
                        layout_profile,
                    );
                    continue;
                }
                _ => continue,
            };
            let width_of = |psid: u16| {
                Self::note_line_width_px(section_def, column_def, 0, is_footnote, psid, styles, dpi)
            };
            Self::synthesize_list_with(
                paras,
                &width_of,
                false,
                own_line_layout,
                styles,
                dpi,
                is_hwp3_variant,
                layout_profile,
            );
        }
    }

    /// 문단의 LineSeg가 합성(reflow)이 필요한지 판단한다.
    /// line_segs가 1개이고 line_height가 0이면 lineSegArray 누락 상태.
    ///
    /// `include_empty`: 빈 `line_segs` 도 누락으로 취급할지 여부. **HWPX 전용** —
    /// HWPX 파서는 linesegarray 부재 문단을 빈 채 보존하므로(#1380) 로드 시 합성이
    /// 필요하다. HWP5/HWP3 는 빈 line_segs 를 reflow 하지 않던 종전 동작을 유지한다
    /// (확장 시 sample16-hwp5 페이지 수 64→over-split 회귀 확인).
    fn needs_line_seg_reflow(
        para: &crate::model::paragraph::Paragraph,
        include_empty: bool,
    ) -> bool {
        if para.line_segs.len() == 1 && para.line_segs[0].is_missing_lineseg_placeholder() {
            return false;
        }
        (include_empty && para.line_segs.is_empty())
            || (para.line_segs.len() == 1 && para.line_segs[0].line_height == 0)
    }

    /// HWP5 -> HWPX export가 넣은 LineSeg 부재 marker는 reflow gate에서만 사용한다.
    /// 레이아웃은 HWP5 원본과 같은 `line_segs.is_empty()` 경로를 타야 하므로 로드 직후 제거한다.
    fn clear_missing_lineseg_placeholders(document: &mut Document) {
        for section in &mut document.sections {
            for para in &mut section.paragraphs {
                Self::clear_missing_lineseg_placeholder_in_paragraph(para);
            }
            for master_page in &mut section.section_def.master_pages {
                for para in &mut master_page.paragraphs {
                    Self::clear_missing_lineseg_placeholder_in_paragraph(para);
                }
            }
        }
    }

    fn clear_missing_lineseg_placeholder_in_paragraph(para: &mut Paragraph) {
        for ctrl in &mut para.controls {
            Self::clear_missing_lineseg_placeholders_in_control(ctrl);
        }
        if para.line_segs.len() == 1 && para.line_segs[0].is_missing_lineseg_placeholder() {
            para.line_segs.clear();
        }
    }

    fn clear_missing_lineseg_placeholders_in_control(ctrl: &mut Control) {
        match ctrl {
            Control::Table(table) => {
                for cell in &mut table.cells {
                    for para in &mut cell.paragraphs {
                        Self::clear_missing_lineseg_placeholder_in_paragraph(para);
                    }
                }
                if let Some(caption) = &mut table.caption {
                    Self::clear_missing_lineseg_placeholders_in_caption(caption);
                }
            }
            Control::Shape(shape) => Self::clear_missing_lineseg_placeholders_in_shape(shape),
            Control::Picture(picture) => {
                if let Some(caption) = &mut picture.caption {
                    Self::clear_missing_lineseg_placeholders_in_caption(caption);
                }
            }
            Control::Header(header) => {
                for para in &mut header.paragraphs {
                    Self::clear_missing_lineseg_placeholder_in_paragraph(para);
                }
            }
            Control::Footer(footer) => {
                for para in &mut footer.paragraphs {
                    Self::clear_missing_lineseg_placeholder_in_paragraph(para);
                }
            }
            Control::Footnote(footnote) => {
                for para in &mut footnote.paragraphs {
                    Self::clear_missing_lineseg_placeholder_in_paragraph(para);
                }
            }
            Control::Endnote(endnote) => {
                for para in &mut endnote.paragraphs {
                    Self::clear_missing_lineseg_placeholder_in_paragraph(para);
                }
            }
            Control::HiddenComment(comment) => {
                for para in &mut comment.paragraphs {
                    Self::clear_missing_lineseg_placeholder_in_paragraph(para);
                }
            }
            Control::Field(field) => {
                for para in &mut field.memo_paragraphs {
                    Self::clear_missing_lineseg_placeholder_in_paragraph(para);
                }
            }
            _ => {}
        }
    }

    fn clear_missing_lineseg_placeholders_in_shape(shape: &mut ShapeObject) {
        match shape {
            ShapeObject::Line(line) => {
                Self::clear_missing_lineseg_placeholders_in_drawing(&mut line.drawing)
            }
            ShapeObject::Rectangle(rect) => {
                Self::clear_missing_lineseg_placeholders_in_drawing(&mut rect.drawing)
            }
            ShapeObject::Ellipse(ellipse) => {
                Self::clear_missing_lineseg_placeholders_in_drawing(&mut ellipse.drawing)
            }
            ShapeObject::Arc(arc) => {
                Self::clear_missing_lineseg_placeholders_in_drawing(&mut arc.drawing)
            }
            ShapeObject::Polygon(polygon) => {
                Self::clear_missing_lineseg_placeholders_in_drawing(&mut polygon.drawing)
            }
            ShapeObject::Curve(curve) => {
                Self::clear_missing_lineseg_placeholders_in_drawing(&mut curve.drawing)
            }
            ShapeObject::Group(group) => {
                for child in &mut group.children {
                    Self::clear_missing_lineseg_placeholders_in_shape(child);
                }
                if let Some(caption) = &mut group.caption {
                    Self::clear_missing_lineseg_placeholders_in_caption(caption);
                }
            }
            ShapeObject::Picture(picture) => {
                if let Some(caption) = &mut picture.caption {
                    Self::clear_missing_lineseg_placeholders_in_caption(caption);
                }
            }
            ShapeObject::Chart(chart) => {
                Self::clear_missing_lineseg_placeholders_in_drawing(&mut chart.drawing);
                if let Some(caption) = &mut chart.caption {
                    Self::clear_missing_lineseg_placeholders_in_caption(caption);
                }
            }
            ShapeObject::Ole(ole) => {
                Self::clear_missing_lineseg_placeholders_in_drawing(&mut ole.drawing);
                if let Some(caption) = &mut ole.caption {
                    Self::clear_missing_lineseg_placeholders_in_caption(caption);
                }
            }
        }
    }

    fn clear_missing_lineseg_placeholders_in_drawing(drawing: &mut DrawingObjAttr) {
        if let Some(text_box) = &mut drawing.text_box {
            for para in &mut text_box.paragraphs {
                Self::clear_missing_lineseg_placeholder_in_paragraph(para);
            }
        }
        if let Some(caption) = &mut drawing.caption {
            Self::clear_missing_lineseg_placeholders_in_caption(caption);
        }
    }

    fn clear_missing_lineseg_placeholders_in_caption(caption: &mut Caption) {
        for para in &mut caption.paragraphs {
            Self::clear_missing_lineseg_placeholder_in_paragraph(para);
        }
    }

    /// HWPX RowBreak 표 셀의 합성 lineSeg를 셀에 저장된 세로 정보와 맞춘다.
    ///
    /// HWPX는 표 셀 안의 문단별 `<hp:linesegarray>`를 생략하면서도, 셀 높이와 마지막
    /// 빈 anchor 문단에는 한컴이 계산한 세로 기준선을 남기는 경우가 있다. 셀의 명시
    /// 높이에 비해 합성 lineSeg가 부족하면 쪽 나눔 후 다음 페이지 표 조각의 줄 수가
    /// 모자라므로, 다음 문서 속성만 근거로 부족한 줄을 보강한다.
    ///
    /// - RowBreak 표 셀의 `height`
    /// - 문단 `ParaShape.spacing_before`
    /// - 합성 lineSeg의 `line_height + line_spacing`
    /// - 셀 끝의 저장 anchor lineSeg (`vertical_pos > 0`, implementation tag 없음)
    fn fit_hwpx_rowbreak_synthetic_cell_lines(
        cell: &mut crate::model::table::Cell,
        styles: &ResolvedStyleSet,
        dpi: f64,
        allow_without_anchor: bool,
    ) {
        if cell.height == 0 || cell.paragraphs.len() < 2 {
            return;
        }

        let is_synthetic = |seg: &LineSeg| seg.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY != 0;
        let para_is_synthetic = |para: &Paragraph| {
            !para.text.is_empty()
                && !para.line_segs.is_empty()
                && para.line_segs.iter().all(is_synthetic)
        };
        let has_stored_anchor = cell.paragraphs.iter().any(|para| {
            para.text.is_empty()
                && para.controls.is_empty()
                && para.line_segs.len() == 1
                && !is_synthetic(&para.line_segs[0])
                && para.line_segs[0].vertical_pos > 0
                && para.line_segs[0].segment_width > 0
        });
        if !has_stored_anchor && !allow_without_anchor {
            return;
        }
        if !cell.paragraphs.iter().any(para_is_synthetic) {
            return;
        }

        let spacing_before_hu = |para: &Paragraph| -> i32 {
            styles
                .para_styles
                .get(para.para_shape_id as usize)
                .map(|ps| px_to_hwpunit(ps.spacing_before, dpi).max(0))
                .unwrap_or(0)
        };

        let paragraph_height = |para: &Paragraph| -> i32 {
            if para.line_segs.is_empty() {
                return 0;
            }
            let spacing_before = spacing_before_hu(para);
            if para.text.is_empty() && para.controls.is_empty() {
                return spacing_before + para.line_segs[0].line_height.max(0);
            }
            spacing_before
                + para
                    .line_segs
                    .iter()
                    .map(|seg| (seg.line_height + seg.line_spacing).max(0))
                    .sum::<i32>()
        };

        let mut current_height: i32 = cell.paragraphs.iter().map(paragraph_height).sum();
        let target_height = cell.height.min(i32::MAX as u32) as i32;
        if current_height >= target_height {
            return;
        }

        let nominal_advance = cell
            .paragraphs
            .iter()
            .filter(|para| para_is_synthetic(para))
            .flat_map(|para| para.line_segs.iter())
            .map(|seg| seg.line_height + seg.line_spacing)
            .filter(|advance| *advance > 0)
            .min()
            .unwrap_or(0);
        if nominal_advance <= 0 {
            return;
        }

        let capacity_hint = cell
            .paragraphs
            .iter()
            .filter(|para| para_is_synthetic(para) && para.line_segs.len() >= 2)
            .filter_map(|para| para.line_segs.get(1).map(|seg| seg.text_start))
            .filter(|text_start| *text_start > 0)
            .min();

        let mut candidates: Vec<usize> = cell
            .paragraphs
            .iter()
            .enumerate()
            .filter_map(|(idx, para)| {
                if para_is_synthetic(para) && para.line_segs.len() == 1 {
                    Some((idx, para.text.chars().count()))
                } else {
                    None
                }
            })
            .filter(|(_, text_len)| *text_len > 1)
            .collect::<Vec<_>>()
            .into_iter()
            .map(|(idx, _)| idx)
            .collect();
        candidates.sort_by(|a, b| {
            let len_a = cell.paragraphs[*a].text.chars().count();
            let len_b = cell.paragraphs[*b].text.chars().count();
            len_b.cmp(&len_a).then_with(|| a.cmp(b))
        });

        for para_idx in candidates {
            if current_height + nominal_advance > target_height {
                break;
            }
            if Self::append_synthetic_cell_line(&mut cell.paragraphs[para_idx], capacity_hint) {
                current_height += nominal_advance;
            }
        }
    }

    fn append_synthetic_cell_line(para: &mut Paragraph, capacity_hint: Option<u32>) -> bool {
        if para.line_segs.len() != 1 {
            return false;
        }
        let first = para.line_segs[0].clone();
        if first.line_height + first.line_spacing <= 0 {
            return false;
        }
        let text_unit_len = para.char_count.saturating_sub(1);
        if text_unit_len <= 1 {
            return false;
        }
        let split_start = capacity_hint
            .unwrap_or(text_unit_len.saturating_sub(1))
            .min(text_unit_len.saturating_sub(1))
            .max(1);
        if split_start <= first.text_start {
            return false;
        }
        let mut second = first.clone();
        second.text_start = split_start;
        second.vertical_pos = first.vertical_pos + first.line_height + first.line_spacing;
        para.line_segs.push(second);
        true
    }

    /// 사용자 명시 요청에 의한 더 넓은 reflow 판정 (#177).
    ///
    /// `needs_line_seg_reflow` (명백한 미계산) + 다음 케이스 포함:
    /// - 텍스트가 있는데 line_segs 가 비어있음 (LinesegArrayEmpty)
    ///
    /// 이 함수는 `reflow_linesegs_on_demand` 에서만 사용되며, 자동 파싱 경로에는 영향 없음.
    fn needs_reflow_broadly(para: &crate::model::paragraph::Paragraph) -> bool {
        if !para.text.is_empty() && para.line_segs.is_empty() {
            return true;
        }
        if Self::needs_line_seg_reflow(para, false) {
            return true;
        }
        false
    }

    /// 사용자 명시 요청에 의한 전체 lineseg reflow (#177).
    ///
    /// `validate_linesegs` 에 기록된 경고 대상 문단들 중 명백히 reflow 가능한 것을 처리한다.
    /// 기본 파싱 경로의 `reflow_zero_height_paragraphs` 와 달리 이 메서드는
    /// 사용자가 UI에서 "자동 보정" 을 명시적으로 선택했을 때만 호출되어야 한다.
    /// `LinesegTextRunReflow` 는 한컴이 계산한 1개 lineseg 를 강제로 다시 풀면
    /// 페이지 수가 바뀔 수 있으므로 경고만 남기고 자동 보정 대상에서 제외한다.
    ///
    /// 반환값: 실제로 reflow 된 문단 개수 (본문 + 셀 내부 합계).
    pub fn reflow_linesegs_on_demand(&mut self) -> usize {
        if self.validation_report.is_empty() {
            return 0;
        }

        // 스타일은 재해소해도 동일 결과이므로 재계산하여 borrow 충돌 회피.
        let styles = self.resolve_document_styles();
        let dpi = self.dpi;
        let mut reflowed = 0usize;
        let layout_profile = self.document.layout_profile();
        let doc_hwp3_layout = layout_profile.hwp3_layout();

        for section in &mut self.document.sections {
            let page_def = &section.section_def.page_def;
            let column_def = Self::find_initial_column_def(&section.paragraphs);
            let layout = PageLayoutInfo::from_page_def(page_def, &column_def, dpi);
            let col_width = layout
                .column_areas
                .first()
                .map(|a| a.width)
                .unwrap_or(layout.body_area.width);

            let mut min_reflowed_idx: Option<usize> = None;
            for (pi, para) in section.paragraphs.iter_mut().enumerate() {
                if Self::needs_reflow_broadly(para) {
                    let available_width =
                        Self::column_line_width_px(col_width, para.para_shape_id, &styles, dpi);
                    reflow_line_segs(para, available_width, &styles, dpi);
                    reflowed += 1;
                    if min_reflowed_idx.is_none() {
                        min_reflowed_idx = Some(pi);
                    }
                }
                // 표 셀 내부 문단도 동일 처리
                for ctrl in &mut para.controls {
                    if let Control::Table(ref mut table) = ctrl {
                        // 로드 합성·편집 reflow 와 같은 한컴 셀 폭 모델.
                        let metrics =
                            Self::table_cells_reflow_metrics(table, &styles, dpi, layout_profile);
                        for (cell, m) in table.cells.iter_mut().zip(metrics) {
                            let Some(m) = m else { continue };
                            for cell_para in &mut cell.paragraphs {
                                if Self::needs_reflow_broadly(cell_para) {
                                    let width = Self::reflow_width_from_cell_metrics(
                                        m,
                                        cell_para.para_shape_id,
                                        &styles,
                                        dpi,
                                    );
                                    reflow_line_segs(cell_para, width, &styles, dpi);
                                    reflowed += 1;
                                }
                            }
                        }
                    }
                }
            }

            // [Task #927] reflow 후 vpos 일관성 재계산 — 본문 paragraphs 만.
            // 빈 lineseg 였던 문단들은 reflow 시 vpos_start=0 으로 시작하여 후속 문단
            // 의 vpos 연속성이 깨짐. paginator 의 vpos_h 기반 current_height 조정이
            // 잘못된 값으로 적용되어 페이지가 과다 분할되는 회귀의 원인.
            if let Some(start) = min_reflowed_idx {
                crate::renderer::composer::recalculate_section_vpos(
                    &mut section.paragraphs,
                    start,
                    None,
                    None,
                    &self.styles,
                    self.dpi,
                    doc_hwp3_layout,
                );
            }
        }

        if reflowed > 0 {
            // 재구성 · 페이지네이션 재실행 필요
            self.styles = styles;
            self.composed = self
                .document
                .sections
                .iter()
                .map(|s| compose_section(s))
                .collect();
            let sec_count = self.document.sections.len();
            self.dirty_sections = vec![true; sec_count];
            self.paginate();
        }

        reflowed
    }

    /// 내장 템플릿에서 빈 문서 생성 (네이티브)
    pub fn create_blank_document_native(&mut self) -> Result<String, HwpError> {
        const BLANK_TEMPLATE: &[u8] = include_bytes!("../../../saved/blank2010.hwp");

        let document = crate::parser::parse_hwp(BLANK_TEMPLATE)
            .map_err(|e| HwpError::InvalidFile(e.to_string()))?;

        let styles = resolve_styles(&document.doc_info, self.dpi);
        let composed = document
            .sections
            .iter()
            .map(|s| compose_section(s))
            .collect();
        let sec_count = document.sections.len();

        self.document = document;
        self.styles = styles;
        self.composed = composed;
        self.clipboard = None;
        self.table_transpose_clipboard = None;
        self.dirty_sections = vec![true; sec_count];
        self.measured_tables = Vec::new();
        self.measured_sections = Vec::new();
        self.dirty_paragraphs = Vec::new();
        self.para_column_map = Vec::new();
        self.invalidate_page_tree_cache();
        self.snapshot_store.clear();
        self.next_snapshot_id = 0;
        self.paragraph_capture_store.clear();
        self.source_format = crate::parser::FileFormat::Hwp;
        self.validation_report = ValidationReport::new();

        self.convert_to_editable_native()?;
        self.paginate();

        Ok(self.get_document_info())
    }

    /// Document IR을 HWP 5.0 CFB 바이너리로 직렬화 (네이티브 에러 타입)
    pub fn export_hwp_native(&self) -> Result<Vec<u8>, HwpError> {
        serialize_validated_hwp(&self.document)
    }

    /// HWPX 출처 IR 을 HWP 호환 형태로 변환 후 HWP 5.0 CFB 바이너리로 직렬화한다 (#178).
    ///
    /// HWP 출처는 어댑터가 no-op 이므로 `export_hwp_native` 와 동일 결과.
    /// 사용자 시나리오: HWPX 로 연 문서를 편집 후 HWP 로 저장하는 모든 경로의 단일 진입점.
    ///
    /// 어댑터는 HWPX/HWP3 저장용 clone에만 적용한다. 라이브 IR을 변경하면 첫 저장 후
    /// 렌더/편집 시멘틱이 HWPX에서 HWP5로 바뀌고, 다음 저장이 다른 결과를 내는
    /// 파괴적 부작용이 생긴다.
    pub fn export_hwp_with_adapter(&self) -> Result<Vec<u8>, HwpError> {
        let export_document = document_for_hwp_export(&self.document, self.source_format);
        serialize_validated_hwp(&export_document)
    }

    /// 어댑터 적용 + 직렬화 + 자기 재로드 검증을 한 번에 수행한다 (#178 Stage 6).
    ///
    /// 명시 호출 전용. 운영 경로도 CFB 엄격 재파스와 수식 fingerprint는 항상
    /// 검증하지만, 페이지/전체 구조 비교까지 수행하는 본 정밀 진단은 진단·테스트·
    /// 사용자 경고가 필요한 경우에만 사용한다.
    ///
    /// ## 검증 항목
    ///
    /// - `page_count_before`: 어댑터 적용 직전 페이지 수
    /// - `page_count_after`: 직렬화 → 재로드 후 페이지 수
    /// - `bytes_len`: HWP 바이트 길이
    /// - `structure_before` / `structure_after`: text/control/object/opaque payload 카운트
    /// - `serialization_losses`: 미지원 lowering 또는 재로드 구조 손실 진단
    /// - `recovered`: 페이지와 구조가 모두 일치하고 손실 진단이 없을 때만 true
    ///
    /// ## 비용
    ///
    /// 1회 paginate + 1회 직렬화 + 1회 from_bytes (paginate 포함). 작은 문서 ~수 ms,
    /// 큰 문서 수백 ms 가능.
    pub fn serialize_hwp_with_verify(&mut self) -> Result<HwpExportVerification, HwpError> {
        let page_count_before = self.page_count();
        let export_document = document_for_hwp_export(&self.document, self.source_format);
        let (structure_before, mut serialization_losses) = hwp_structure_counts(&export_document);
        let bytes = serialize_validated_hwp(&export_document)?;
        let bytes_len = bytes.len();
        let reloaded = DocumentCore::from_regenerated_bytes(&bytes)?;
        let page_count_after = reloaded.page_count();
        let (structure_after, _) = hwp_structure_counts(reloaded.document());
        let page_count_matches = page_count_before == page_count_after;
        let structure_matches = structure_before == structure_after;

        if structure_before.text_count != structure_after.text_count {
            serialization_losses.push(format!(
                "text count changed during serialization: {} -> {}",
                structure_before.text_count, structure_after.text_count
            ));
        }
        if structure_before.control_count != structure_after.control_count {
            serialization_losses.push(format!(
                "control count changed during serialization: {} -> {}",
                structure_before.control_count, structure_after.control_count
            ));
        }
        if structure_before.object_count != structure_after.object_count {
            serialization_losses.push(format!(
                "object count changed during serialization: {} -> {}",
                structure_before.object_count, structure_after.object_count
            ));
        }
        if structure_before.opaque_control_bytes != structure_after.opaque_control_bytes {
            serialization_losses.push(format!(
                "opaque control payload bytes changed during serialization: {} -> {}",
                structure_before.opaque_control_bytes, structure_after.opaque_control_bytes
            ));
        }
        let recovered = export_is_recovered(
            page_count_matches,
            structure_before,
            structure_after,
            &serialization_losses,
        );

        Ok(HwpExportVerification {
            bytes,
            bytes_len,
            page_count_before,
            page_count_after,
            page_count_matches,
            structure_before,
            structure_after,
            structure_matches,
            serialization_losses,
            recovered,
        })
    }

    /// Document IR을 HWPX(ZIP+XML)로 직렬화 (네이티브 에러 타입)
    pub fn export_hwpx_native(&self) -> Result<Vec<u8>, HwpError> {
        if matches!(self.source_format, crate::parser::FileFormat::Hwp) {
            let mut doc = self.document.clone();
            if !doc
                .hwpx_aux_entries
                .iter()
                .any(|(path, _)| path == crate::model::document::HWP5_ORIGIN_HWPX_MARKER_PATH)
            {
                doc.hwpx_aux_entries.push((
                    crate::model::document::HWP5_ORIGIN_HWPX_MARKER_PATH.to_string(),
                    b"1".to_vec(),
                ));
            }
            Self::canonicalize_hwp5_bin_data_ids_for_hwpx_export(&mut doc);
            Self::materialize_hwp5_missing_linesegs_for_hwpx_export(&mut doc);
            serialize_validated_hwpx(&doc)
        } else {
            serialize_validated_hwpx(&self.document)
        }
    }

    /// HML 원본의 공통 IR을 HWPML 2.91 UTF-8 XML로 직렬화한다.
    pub fn export_hml_native(&self) -> Result<Vec<u8>, crate::serializer::hml::HmlExportError> {
        self.hml_export_preflight()?;
        let metadata = self
            .hml_metadata
            .as_ref()
            .ok_or_else(Self::hml_metadata_missing_error)?;
        crate::serializer::hml::serialize_hml(&self.document, metadata)
    }

    /// HML 저장 가능 여부를 직렬화 없이 검사하고 동일한 차단 진단을 반환한다.
    pub fn hml_export_preflight(&self) -> Result<(), crate::serializer::hml::HmlExportError> {
        use crate::serializer::hml::{HmlExportError, HmlSaveBlocker};

        if self.source_format != crate::parser::FileFormat::Hml {
            return Err(HmlExportError::UnsupportedSourceFormat {
                actual: self.source_format,
                blockers: vec![HmlSaveBlocker {
                    code: "HML_SOURCE_REQUIRED",
                    xml_path: "/HWPML".to_string(),
                    message: "HML 원본 문서만 HML로 저장할 수 있습니다".to_string(),
                }],
            });
        }
        let metadata = self
            .hml_metadata
            .as_ref()
            .ok_or_else(Self::hml_metadata_missing_error)?;
        let mut import_blockers = Self::hml_import_blockers(metadata);
        let ir_blockers = crate::serializer::hml::collect_blockers(&self.document, metadata);
        match (import_blockers.is_empty(), ir_blockers.is_empty()) {
            (false, false) => {
                import_blockers.extend(ir_blockers);
                Err(HmlExportError::LossyImportAndUnsupportedIr {
                    blockers: import_blockers,
                })
            }
            (false, true) => Err(HmlExportError::LossyImport {
                blockers: import_blockers,
            }),
            (true, false) => Err(HmlExportError::UnsupportedIr {
                blockers: ir_blockers,
            }),
            (true, true) => Ok(()),
        }
    }

    fn hml_metadata_missing_error() -> crate::serializer::hml::HmlExportError {
        crate::serializer::hml::HmlExportError::UnsupportedIr {
            blockers: vec![crate::serializer::hml::HmlSaveBlocker {
                code: "HML_METADATA_MISSING",
                xml_path: "/HWPML".to_string(),
                message: "HML 가져오기 메타데이터가 없습니다".to_string(),
            }],
        }
    }

    fn hml_import_blockers(
        metadata: &crate::parser::HmlImportMetadata,
    ) -> Vec<crate::serializer::hml::HmlSaveBlocker> {
        metadata
            .warnings
            .iter()
            .filter(|warning| !warning.preserved)
            .map(Self::hml_warning_blocker)
            .collect()
    }

    fn hml_warning_blocker(
        warning: &crate::parser::hml::HmlWarning,
    ) -> crate::serializer::hml::HmlSaveBlocker {
        use crate::parser::hml::HmlWarningCode;

        let code = match warning.code {
            HmlWarningCode::UnsupportedElement => "UNSUPPORTED_ELEMENT",
            HmlWarningCode::UnsupportedAttribute => "UNSUPPORTED_ATTRIBUTE",
            HmlWarningCode::UnsupportedEquationSemantics => "HML_UNSUPPORTED_EQUATION_SEMANTICS",
            HmlWarningCode::MissingResource => "MISSING_RESOURCE",
            HmlWarningCode::ExternalResourceBlocked => "EXTERNAL_RESOURCE_BLOCKED",
            HmlWarningCode::InvalidReference => "INVALID_REFERENCE",
            HmlWarningCode::LossyConversion => "LOSSY_CONVERSION",
        };
        crate::serializer::hml::HmlSaveBlocker {
            code,
            xml_path: warning.xml_path.clone(),
            message: warning.message.clone(),
        }
    }

    /// HWP5의 위치 기반 BinData 참조를 HWPX manifest ID로 정규화한다.
    fn canonicalize_hwp5_bin_data_ids_for_hwpx_export(document: &mut Document) {
        // HWP5 그림 참조는 DocInfo BinData의 1-based 위치이고, BinDataContent.id는
        // BINxxxx 스트림 번호다. HWPX는 manifest ID를 직접 참조하므로 위치 ID로
        // 재번호화하지 않으면 storage 번호에 구멍이 있는 문서에서 다른 그림을 연다.
        // Link는 content 배열에 없고 OLE는 storage id를 직접 참조하므로, 이 둘이
        // 섞인 문서는 별도 typed remap 없이는 안전하게 정규화할 수 없다.
        if document.doc_info.bin_data_list.is_empty()
            || document.doc_info.bin_data_list.iter().any(|bin_data| {
                bin_data.data_type != crate::model::bin_data::BinDataType::Embedding
            })
        {
            return;
        }

        let reference_id_by_storage: HashMap<u16, u16> = document
            .doc_info
            .bin_data_list
            .iter()
            .enumerate()
            .filter(|(_, bin_data)| bin_data.storage_id != 0)
            .map(|(index, bin_data)| (bin_data.storage_id, (index + 1) as u16))
            .collect();
        let regular_content_count = document
            .bin_data_content
            .iter()
            .filter(|content| !(content.extension == "ooxml_chart" && content.id > 60000))
            .count();
        let regular_content_ids: HashSet<u16> = document
            .bin_data_content
            .iter()
            .filter(|content| !(content.extension == "ooxml_chart" && content.id > 60000))
            .map(|content| content.id)
            .collect();
        if reference_id_by_storage.len() != document.doc_info.bin_data_list.len()
            || regular_content_count != document.doc_info.bin_data_list.len()
            || regular_content_ids.len() != regular_content_count
            || document.bin_data_content.iter().any(|content| {
                !(content.extension == "ooxml_chart" && content.id > 60000)
                    && !reference_id_by_storage.contains_key(&content.id)
            })
        {
            return;
        }

        for content in &mut document.bin_data_content {
            if content.extension == "ooxml_chart" && content.id > 60000 {
                continue;
            }
            content.id = reference_id_by_storage[&content.id];
        }
        for (index, bin_data) in document.doc_info.bin_data_list.iter_mut().enumerate() {
            bin_data.storage_id = (index + 1) as u16;
        }
    }

    /// HWP5 원본에서 LineSeg가 없던 문단을 HWPX 재파스에서도 일반 HWPX 누락 문단으로
    /// reflow하지 않도록 명시 LineSeg marker로 materialize한다.
    fn materialize_hwp5_missing_linesegs_for_hwpx_export(document: &mut Document) {
        for section in &mut document.sections {
            for para in &mut section.paragraphs {
                Self::materialize_missing_lineseg_paragraph(para);
            }
            for master_page in &mut section.section_def.master_pages {
                for para in &mut master_page.paragraphs {
                    Self::materialize_missing_lineseg_paragraph(para);
                }
            }
        }
    }

    fn materialize_missing_lineseg_paragraph(para: &mut Paragraph) {
        for ctrl in &mut para.controls {
            Self::materialize_missing_lineseg_paragraphs_in_control(ctrl);
        }

        if para.line_segs.is_empty() {
            para.line_segs.push(LineSeg::missing_lineseg_placeholder());
        }
    }

    fn materialize_missing_lineseg_paragraphs_in_control(ctrl: &mut Control) {
        match ctrl {
            Control::Table(table) => {
                for cell in &mut table.cells {
                    for para in &mut cell.paragraphs {
                        Self::materialize_missing_lineseg_paragraph(para);
                    }
                }
                if let Some(caption) = &mut table.caption {
                    Self::materialize_missing_lineseg_paragraphs_in_caption(caption);
                }
            }
            Control::Shape(shape) => {
                Self::materialize_missing_lineseg_paragraphs_in_shape(shape);
            }
            Control::Picture(picture) => {
                if let Some(caption) = &mut picture.caption {
                    Self::materialize_missing_lineseg_paragraphs_in_caption(caption);
                }
            }
            Control::Header(header) => {
                for para in &mut header.paragraphs {
                    Self::materialize_missing_lineseg_paragraph(para);
                }
            }
            Control::Footer(footer) => {
                for para in &mut footer.paragraphs {
                    Self::materialize_missing_lineseg_paragraph(para);
                }
            }
            Control::Footnote(footnote) => {
                for para in &mut footnote.paragraphs {
                    Self::materialize_missing_lineseg_paragraph(para);
                }
            }
            Control::Endnote(endnote) => {
                for para in &mut endnote.paragraphs {
                    Self::materialize_missing_lineseg_paragraph(para);
                }
            }
            Control::HiddenComment(comment) => {
                for para in &mut comment.paragraphs {
                    Self::materialize_missing_lineseg_paragraph(para);
                }
            }
            Control::Field(field) => {
                for para in &mut field.memo_paragraphs {
                    Self::materialize_missing_lineseg_paragraph(para);
                }
            }
            _ => {}
        }
    }

    fn materialize_missing_lineseg_paragraphs_in_shape(shape: &mut ShapeObject) {
        match shape {
            ShapeObject::Line(line) => {
                Self::materialize_missing_lineseg_paragraphs_in_drawing(&mut line.drawing)
            }
            ShapeObject::Rectangle(rect) => {
                Self::materialize_missing_lineseg_paragraphs_in_drawing(&mut rect.drawing)
            }
            ShapeObject::Ellipse(ellipse) => {
                Self::materialize_missing_lineseg_paragraphs_in_drawing(&mut ellipse.drawing)
            }
            ShapeObject::Arc(arc) => {
                Self::materialize_missing_lineseg_paragraphs_in_drawing(&mut arc.drawing)
            }
            ShapeObject::Polygon(polygon) => {
                Self::materialize_missing_lineseg_paragraphs_in_drawing(&mut polygon.drawing)
            }
            ShapeObject::Curve(curve) => {
                Self::materialize_missing_lineseg_paragraphs_in_drawing(&mut curve.drawing)
            }
            ShapeObject::Group(group) => {
                for child in &mut group.children {
                    Self::materialize_missing_lineseg_paragraphs_in_shape(child);
                }
                if let Some(caption) = &mut group.caption {
                    Self::materialize_missing_lineseg_paragraphs_in_caption(caption);
                }
            }
            ShapeObject::Picture(picture) => {
                if let Some(caption) = &mut picture.caption {
                    Self::materialize_missing_lineseg_paragraphs_in_caption(caption);
                }
            }
            ShapeObject::Chart(chart) => {
                Self::materialize_missing_lineseg_paragraphs_in_drawing(&mut chart.drawing);
                if let Some(caption) = &mut chart.caption {
                    Self::materialize_missing_lineseg_paragraphs_in_caption(caption);
                }
            }
            ShapeObject::Ole(ole) => {
                Self::materialize_missing_lineseg_paragraphs_in_drawing(&mut ole.drawing);
                if let Some(caption) = &mut ole.caption {
                    Self::materialize_missing_lineseg_paragraphs_in_caption(caption);
                }
            }
        }
    }

    fn materialize_missing_lineseg_paragraphs_in_drawing(drawing: &mut DrawingObjAttr) {
        if let Some(text_box) = &mut drawing.text_box {
            for para in &mut text_box.paragraphs {
                Self::materialize_missing_lineseg_paragraph(para);
            }
        }
        if let Some(caption) = &mut drawing.caption {
            Self::materialize_missing_lineseg_paragraphs_in_caption(caption);
        }
    }

    fn materialize_missing_lineseg_paragraphs_in_caption(caption: &mut Caption) {
        for para in &mut caption.paragraphs {
            Self::materialize_missing_lineseg_paragraph(para);
        }
    }

    /// 배포용(읽기전용) 문서를 편집 가능한 일반 문서로 변환한다 (네이티브 에러 타입).
    pub fn convert_to_editable_native(&mut self) -> Result<String, HwpError> {
        let converted = self.document.convert_to_editable();
        Ok(format!("{{\"ok\":true,\"converted\":{}}}", converted))
    }

    /// 문서의 IR 참조를 반환한다 (네이티브 전용).
    pub fn document(&self) -> &Document {
        &self.document
    }

    /// 문서 IR의 가변 참조를 반환한다. WASM 외부 그림 주입에서도 사용한다.
    pub fn document_mut(&mut self) -> &mut Document {
        &mut self.document
    }

    /// 문서 IR을 직접 설정한다 (테스트/네이티브 전용).
    pub fn set_document(&mut self, doc: Document) {
        self.document = doc;
        self.styles = self.resolve_document_styles();
        self.composed = self
            .document
            .sections
            .iter()
            .map(|s| compose_section(s))
            .collect();
        self.mark_all_sections_dirty();
        self.paginate();
    }

    /// 본문 여러 줄 삽입을 중간 페이지네이션 없이 처리할 수 있는 구역인지 확인한다.
    /// 다단의 줄 폭 수렴은 편집 중 페이지네이션 결과를 사용하므로 초기 설정뿐 아니라
    /// 구역 중간에 등장하는 모든 단 정의를 확인한다.
    pub fn can_batch_body_text_native(&self, section_idx: usize) -> bool {
        self.document
            .sections
            .get(section_idx)
            .is_some_and(|section| {
                section.paragraphs.iter().all(|paragraph| {
                    paragraph.controls.iter().all(|control| match control {
                        Control::ColumnDef(columns) => columns.column_count == 1,
                        _ => true,
                    })
                })
            })
    }

    /// Batch 모드를 시작한다. 이후 Command 호출 시 paginate()를 건너뛴다.
    pub fn begin_batch_native(&mut self) -> Result<String, HwpError> {
        self.batch_mode = true;
        self.event_log.begin_capture();
        Ok(super::super::helpers::json_ok())
    }

    /// Batch 모드를 종료하고 누적된 이벤트를 반환한다.
    /// 종료 시 paginate()를 1회 실행하여 모든 dirty 구역을 처리한다.
    pub fn end_batch_native(&mut self) -> Result<String, HwpError> {
        self.batch_mode = false;
        self.paginate();
        let result = self.serialize_event_log();
        self.event_log.clear();
        Ok(result)
    }

    // ─── Undo/Redo 스냅샷 API ──────────────────────────

    fn clone_document_shell(document: &Document) -> Document {
        let Document {
            header,
            doc_properties,
            doc_info,
            sections: _,
            preview,
            bin_data_content,
            extra_streams: _,
            hwpx_aux_entries: _,
            is_hwp3_variant,
            is_hwpx_variant,
            provenance,
        } = document;
        Document {
            header: header.clone(),
            doc_properties: doc_properties.clone(),
            doc_info: doc_info.clone(),
            sections: Vec::new(),
            preview: preview
                .as_ref()
                .map(|preview| crate::model::document::Preview {
                    text: preview.text.clone(),
                    image: preview.image.as_ref().map(|image| {
                        crate::model::document::PreviewImage {
                            format: image.format,
                            data: Vec::new(),
                        }
                    }),
                }),
            bin_data_content: bin_data_content.clone(),
            extra_streams: Vec::new(),
            hwpx_aux_entries: Vec::new(),
            is_hwp3_variant: *is_hwp3_variant,
            is_hwpx_variant: *is_hwpx_variant,
            provenance: provenance.clone(),
        }
    }

    fn clone_section_shell(section: &Section) -> Section {
        Section {
            section_def: section.section_def.clone(),
            paragraphs: Vec::new(),
            raw_stream: None,
            // 봉인은 세션 메타라 문단 셸과 같이 복원한다. raw_stream 은 아래
            // SnapshotSection.raw_stream 이 따로 들고, 복원 때 합친다.
            raw_provenance: section.raw_provenance,
        }
    }

    // 가변 Document API는 원시 바이트도 수정할 수 있으므로 revision이나 포인터만으로
    // 재사용하면 안 된다. 바이트 비교 비용은 남지만 동일한 값은 할당 없이 공유한다.
    fn share_snapshot_payload<T: Clone + PartialEq>(
        value: &T,
        baseline: Option<&Arc<T>>,
    ) -> Arc<T> {
        match baseline {
            Some(previous) if previous.as_ref() == value => Arc::clone(previous),
            _ => Arc::new(value.clone()),
        }
    }

    fn capture_snapshot(&self) -> DocumentSnapshot {
        let section_revisions = self
            .event_log
            .section_revisions(self.document.sections.len());
        let baseline = self
            .snapshot_store
            .last()
            .map(|(_, snapshot)| snapshot.as_ref());
        let sections = self
            .document
            .sections
            .iter()
            .enumerate()
            .map(|(section_idx, section)| {
                let revision = section_revisions[section_idx];
                let paragraph_sequence_revision =
                    self.event_log.paragraph_sequence_revision(section_idx);
                let paragraph_revisions = self
                    .event_log
                    .paragraph_revisions(section_idx, section.paragraphs.len());
                let baseline_section = baseline
                    .and_then(|snapshot| snapshot.sections.get(section_idx))
                    .filter(|snapshot_section| {
                        snapshot_section.paragraph_sequence_revision == paragraph_sequence_revision
                            && snapshot_section.paragraphs.len() == section.paragraphs.len()
                    });
                let paragraphs = section
                    .paragraphs
                    .iter()
                    .enumerate()
                    .map(|(paragraph_idx, paragraph)| {
                        let paragraph_revision = paragraph_revisions[paragraph_idx];
                        let shared = baseline_section
                            .and_then(|snapshot_section| {
                                snapshot_section.paragraphs.get(paragraph_idx)
                            })
                            .filter(|snapshot_paragraph| {
                                snapshot_paragraph.revision == paragraph_revision
                            })
                            .map(|snapshot_paragraph| Arc::clone(&snapshot_paragraph.paragraph));
                        SnapshotParagraph {
                            revision: paragraph_revision,
                            paragraph: shared.unwrap_or_else(|| Arc::new(paragraph.clone())),
                        }
                    })
                    .collect();
                SnapshotSection {
                    revision,
                    paragraph_sequence_revision,
                    section_shell: Self::clone_section_shell(section),
                    raw_stream: section.raw_stream.as_ref().map(|bytes| {
                        Self::share_snapshot_payload(
                            bytes,
                            baseline
                                .and_then(|snapshot| snapshot.sections.get(section_idx))
                                .and_then(|section| section.raw_stream.as_ref()),
                        )
                    }),
                    paragraphs,
                }
            })
            .collect();
        DocumentSnapshot {
            document_shell: Self::clone_document_shell(&self.document),
            extra_streams: Self::share_snapshot_payload(
                &self.document.extra_streams,
                baseline.map(|snapshot| &snapshot.extra_streams),
            ),
            hwpx_aux_entries: Self::share_snapshot_payload(
                &self.document.hwpx_aux_entries,
                baseline.map(|snapshot| &snapshot.hwpx_aux_entries),
            ),
            preview_image: self
                .document
                .preview
                .as_ref()
                .and_then(|preview| preview.image.as_ref())
                .map(|image| {
                    Self::share_snapshot_payload(
                        &image.data,
                        baseline.and_then(|snapshot| snapshot.preview_image.as_ref()),
                    )
                }),
            sections,
        }
    }

    fn store_snapshot(&mut self, snapshot: Arc<DocumentSnapshot>) -> u32 {
        let id = self.next_snapshot_id;
        self.next_snapshot_id += 1;
        self.snapshot_store.push((id, snapshot));
        // 최대 100개 제한 — 초과 시 가장 오래된 스냅샷 제거.
        // [Task #2328] studio 히스토리(rhwp-studio/src/engine/history.ts 의
        // WASM_MAX_SNAPSHOTS)와 양방향 결합. 이 값을 studio 예산(MAX-2)보다 낮추면
        // studio 가 참조 중인 오래된 undo 스냅샷이 무통보 축출돼 undo 예외가
        // 재발한다. 변경 시 반드시 studio 상수도 함께 갱신한다.
        const MAX_SNAPSHOTS: usize = 100;
        while self.snapshot_store.len() > MAX_SNAPSHOTS {
            self.snapshot_store.remove(0);
        }
        id
    }

    /// 현재 Document의 전역 상태와 변경 구역을 캡처하여 스냅샷 저장소에 보관한다.
    /// 반환값: 스냅샷 ID (u32)
    pub fn save_snapshot_native(&mut self) -> u32 {
        self.store_snapshot(Arc::new(self.capture_snapshot()))
    }

    /// 기존 스냅샷의 불변 Document 상태를 공유하는 새 ID를 만든다.
    ///
    /// 호출자가 현재 문서와 `source_id`가 같은 상태임을 보장하는 history 경계에서만 쓴다.
    pub fn share_snapshot_native(&mut self, source_id: u32) -> Result<u32, HwpError> {
        let snapshot = self
            .snapshot_store
            .iter()
            .find(|(id, _)| *id == source_id)
            .map(|(_, snapshot)| Arc::clone(snapshot))
            .ok_or_else(|| HwpError::RenderError(format!("스냅샷 {} 없음", source_id)))?;
        Ok(self.store_snapshot(snapshot))
    }

    /// Select session font metrics without rewriting stored document properties.
    pub fn set_font_metrics_policy_native(
        &mut self,
        policy: crate::model::provenance::FontMetricsPolicy,
    ) {
        if self.document.doc_info.font_metrics_policy != policy {
            self.document.doc_info.font_metrics_policy = policy;
            self.refresh_layout_native();
        }
    }

    /// 현재 Document IR은 건드리지 않고, 그로부터 파생된 모든 조판 캐시를 다시 만든다.
    ///
    /// 여러 저수준 편집을 연달아 수행하는 호출자는 각 단계의 증분 캐시를 최종 결과로
    /// 노출하면 안 된다. 특히 에이전트 미리보기처럼 split/delete/format을 한 논리
    /// 연산으로 묶는 경로는 이 메서드로 연산 경계에서 단 한 번 권위 조판을 확정한다.
    pub fn refresh_layout_native(&mut self) {
        // 폰트 등록 변화 후 새로고침이 캐시된 폭을 재사용하지 않도록 비운다.
        crate::renderer::layout::clear_measure_caches();
        self.render_normalization.sections.clear();
        self.styles = self.resolve_document_styles();
        // 로드 뒤 등록한 글꼴도 합성 줄의 나눔에 반영한다. 저장 줄이 섞인 문서는
        // 문단별 합성 태그를 따르고, 저장 줄이 전혀 없던 문서만 전체를 다시 계산한다.
        self.resynthesize_generated_line_layout();
        self.composed = self
            .document
            .sections
            .iter()
            .map(|s| compose_section(s))
            .collect();

        let section_count = self.document.sections.len();
        self.dirty_sections.resize(section_count, true);
        self.mark_all_sections_dirty();
        self.measured_tables.clear();
        // Recompute every measurement, while retaining each table's loaded row
        // allocation as the reference for edit growth. Dropping that reference
        // makes a refresh reinterpret saved font/object metric differences as
        // new content and resize untouched rows.
        if self.measured_sections.len() != section_count {
            self.measured_sections.clear();
        }
        for section in &mut self.document.sections {
            for paragraph in &mut section.paragraphs {
                for control in &mut paragraph.controls {
                    if let Control::Table(table) = control {
                        table.dirty = true;
                    }
                }
            }
        }
        self.dirty_paragraphs.clear();
        self.para_column_map.clear();
        self.para_offset = vec![0; section_count];
        self.invalidate_page_tree_cache();
        self.overflow_links_cache.borrow_mut().clear();
        self.paginate();
    }

    /// 로드에서 합성한 줄만 비우고 같은 폭/간격 규칙으로 다시 계산한다.
    fn resynthesize_generated_line_layout(&mut self) {
        let fully_unstored = self.document.provenance.own_line_layout;
        let generated = |para: &Paragraph| {
            fully_unstored
                || para.line_segs.iter().any(|seg| {
                    seg.line_height > 0 && seg.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY != 0
                })
        };
        let mut changed = false;
        visit_line_refresh_paragraphs_mut(&mut self.document, fully_unstored, &mut |para| {
            changed |= generated(para);
        });
        if !changed {
            return;
        }
        let mut stored_lines = Vec::new();
        visit_line_refresh_paragraphs_mut(&mut self.document, fully_unstored, &mut |para| {
            if generated(para) {
                stored_lines.push(None);
                para.line_segs.clear();
            } else {
                stored_lines.push(Some(para.line_segs.clone()));
            }
        });
        let include_cell_empty = !self.document.layout_profile().hwp3_layout();
        Self::reflow_zero_height_paragraphs(
            &mut self.document,
            &self.styles,
            DEFAULT_DPI,
            true,
            include_cell_empty,
            fully_unstored,
        );
        // 재계산은 목록 안의 뒤 문단 vpos도 잇는다. 저장 줄과 HWP의 원본 줄 부재는
        // 그대로 돌려놓고, 이번에 합성한 문단에만 새 글꼴의 폭과 높이를 적용한다.
        let mut stored_lines = stored_lines.into_iter();
        visit_line_refresh_paragraphs_mut(&mut self.document, fully_unstored, &mut |para| {
            if let Some(lines) = stored_lines.next().flatten() {
                para.line_segs = lines;
            } else if fully_unstored {
                for seg in &mut para.line_segs {
                    seg.tag &= !LineSeg::TAG_IMPLEMENTATION_PROPERTY;
                }
            }
        });
        Self::clear_missing_lineseg_placeholders(&mut self.document);
    }

    /// 지정 ID의 스냅샷으로 Document를 복원한다.
    /// 스타일 재해소 + 문단 구성 + 페이지네이션까지 수행.
    pub fn restore_snapshot_native(&mut self, id: u32) -> Result<String, HwpError> {
        let snapshot = self
            .snapshot_store
            .iter()
            .find(|(snapshot_id, _)| *snapshot_id == id)
            .map(|(_, snapshot)| Arc::clone(snapshot))
            .ok_or_else(|| HwpError::RenderError(format!("스냅샷 {} 없음", id)))?;
        let target_revisions: Vec<u64> = snapshot
            .sections
            .iter()
            .map(|section| section.revision)
            .collect();
        let target_paragraph_sequence_revisions: Vec<u64> = snapshot
            .sections
            .iter()
            .map(|section| section.paragraph_sequence_revision)
            .collect();
        let target_paragraph_revisions: Vec<Vec<u64>> = snapshot
            .sections
            .iter()
            .map(|section| {
                section
                    .paragraphs
                    .iter()
                    .map(|paragraph| paragraph.revision)
                    .collect()
            })
            .collect();
        let current_revisions = self
            .event_log
            .section_revisions(self.document.sections.len());
        let current_paragraph_sequence_revisions: Vec<u64> = self
            .document
            .sections
            .iter()
            .enumerate()
            .map(|(section_idx, _)| self.event_log.paragraph_sequence_revision(section_idx))
            .collect();
        let current_paragraph_revisions: Vec<Vec<u64>> = self
            .document
            .sections
            .iter()
            .enumerate()
            .map(|(section_idx, section)| {
                self.event_log
                    .paragraph_revisions(section_idx, section.paragraphs.len())
            })
            .collect();
        let same_section_count = self.document.sections.len() == snapshot.sections.len();
        let changed_sections: Vec<usize> = if same_section_count {
            snapshot
                .sections
                .iter()
                .enumerate()
                .filter_map(|(section_idx, snapshot_section)| {
                    (current_revisions[section_idx] != snapshot_section.revision)
                        .then_some(section_idx)
                })
                .collect()
        } else {
            (0..snapshot.sections.len()).collect()
        };
        let selectively_changed_paragraphs: Vec<Option<Vec<usize>>> = snapshot
            .sections
            .iter()
            .enumerate()
            .map(|(section_idx, snapshot_section)| {
                if !same_section_count
                    || current_paragraph_sequence_revisions[section_idx]
                        != snapshot_section.paragraph_sequence_revision
                    || current_paragraph_revisions[section_idx].len()
                        != snapshot_section.paragraphs.len()
                {
                    return None;
                }
                Some(
                    snapshot_section
                        .paragraphs
                        .iter()
                        .enumerate()
                        .filter_map(|(paragraph_idx, snapshot_paragraph)| {
                            (current_paragraph_revisions[section_idx][paragraph_idx]
                                != snapshot_paragraph.revision)
                                .then_some(paragraph_idx)
                        })
                        .collect(),
                )
            })
            .collect();
        let mut current_sections = std::mem::take(&mut self.document.sections);
        let mut restored = snapshot.document_shell.clone();
        restored.extra_streams = snapshot.extra_streams.as_ref().clone();
        restored.hwpx_aux_entries = snapshot.hwpx_aux_entries.as_ref().clone();
        if let Some(image) = restored
            .preview
            .as_mut()
            .and_then(|preview| preview.image.as_mut())
        {
            image.data = snapshot
                .preview_image
                .as_ref()
                .expect("snapshot preview image")
                .as_ref()
                .clone();
        }
        restored.doc_info.font_metrics_policy = self.document.doc_info.font_metrics_policy;
        restored.sections.reserve(snapshot.sections.len());
        for (section_idx, snapshot_section) in snapshot.sections.iter().enumerate() {
            if same_section_count && current_revisions[section_idx] == snapshot_section.revision {
                let mut section = std::mem::take(&mut current_sections[section_idx]);
                section.raw_stream = snapshot_section.raw_stream.as_deref().cloned();
                restored.sections.push(section);
            } else {
                let mut section = snapshot_section.section_shell.clone();
                section.raw_stream = snapshot_section.raw_stream.as_deref().cloned();
                let can_move_unchanged_paragraphs = same_section_count
                    && current_paragraph_sequence_revisions[section_idx]
                        == snapshot_section.paragraph_sequence_revision
                    && current_sections[section_idx].paragraphs.len()
                        == snapshot_section.paragraphs.len();
                if can_move_unchanged_paragraphs {
                    let current_paragraphs =
                        std::mem::take(&mut current_sections[section_idx].paragraphs);
                    section
                        .paragraphs
                        .reserve(snapshot_section.paragraphs.len());
                    for (paragraph_idx, (current_paragraph, snapshot_paragraph)) in
                        current_paragraphs
                            .into_iter()
                            .zip(&snapshot_section.paragraphs)
                            .enumerate()
                    {
                        if current_paragraph_revisions[section_idx][paragraph_idx]
                            == snapshot_paragraph.revision
                        {
                            section.paragraphs.push(current_paragraph);
                        } else {
                            section
                                .paragraphs
                                .push(snapshot_paragraph.paragraph.as_ref().clone());
                        }
                    }
                } else {
                    section.paragraphs = snapshot_section
                        .paragraphs
                        .iter()
                        .map(|paragraph| paragraph.paragraph.as_ref().clone())
                        .collect();
                }
                restored.sections.push(section);
            }
        }
        self.document = restored;
        if same_section_count {
            self.styles = self.resolve_document_styles();
            for &section_idx in &changed_sections {
                // Snapshot tables are usually clean, but the cached measurements
                // belong to the document we just replaced. Recomposition alone
                // does not invalidate those table entries. Keep unaffected
                // paragraphs reusable while remeasuring every restored owner.
                let changed = selectively_changed_paragraphs[section_idx].as_ref();
                for (paragraph_idx, para) in self.document.sections[section_idx]
                    .paragraphs
                    .iter_mut()
                    .enumerate()
                {
                    if changed.is_some_and(|indices| {
                        !indices.is_empty() && !indices.contains(&paragraph_idx)
                    }) {
                        continue;
                    }
                    for control in &mut para.controls {
                        if let Control::Table(table) = control {
                            table.dirty = true;
                        }
                    }
                }
                match &selectively_changed_paragraphs[section_idx] {
                    Some(paragraphs) if !paragraphs.is_empty() => {
                        for &paragraph_idx in paragraphs {
                            self.recompose_paragraph(section_idx, paragraph_idx);
                        }
                    }
                    _ => self.recompose_section(section_idx),
                }
            }
            if !changed_sections.is_empty() {
                self.paginate();
            }
        } else {
            self.refresh_layout_native();
        }
        self.event_log.restore_snapshot_revisions(
            &target_revisions,
            &target_paragraph_sequence_revisions,
            &target_paragraph_revisions,
        );
        Ok(super::super::helpers::json_ok())
    }

    /// 지정 ID의 스냅샷을 저장소에서 제거하여 메모리를 해제한다.
    pub fn discard_snapshot_native(&mut self, id: u32) {
        self.snapshot_store.retain(|(sid, _)| *sid != id);
    }

    /// 스냅샷 저장소의 구조 공유 점유량을 진단한다.
    pub fn snapshot_storage_stats_native(&self) -> String {
        let unique_snapshots: HashSet<usize> = self
            .snapshot_store
            .iter()
            .map(|(_, snapshot)| Arc::as_ptr(snapshot) as usize)
            .collect();
        let unique_paragraphs: HashSet<usize> = self
            .snapshot_store
            .iter()
            .flat_map(|(_, snapshot)| {
                snapshot.sections.iter().flat_map(|section| {
                    section
                        .paragraphs
                        .iter()
                        .map(|paragraph| Arc::as_ptr(&paragraph.paragraph) as usize)
                })
            })
            .collect();
        let section_references = self
            .snapshot_store
            .iter()
            .map(|(_, snapshot)| snapshot.sections.len())
            .sum::<usize>();
        let paragraph_references = self
            .snapshot_store
            .iter()
            .flat_map(|(_, snapshot)| &snapshot.sections)
            .map(|section| section.paragraphs.len())
            .sum::<usize>();
        format!(
            "{{\"snapshotIds\":{},\"uniqueSnapshots\":{},\"sectionReferences\":{},\"paragraphReferences\":{},\"uniqueParagraphs\":{}}}",
            self.snapshot_store.len(),
            unique_snapshots.len(),
            section_references,
            paragraph_references,
            unique_paragraphs.len()
        )
    }

    pub fn measure_width_diagnostic_native(
        &self,
        section_idx: usize,
        para_idx: usize,
    ) -> Result<String, HwpError> {
        use crate::renderer::composer::estimate_composed_line_width;
        use crate::renderer::hwpunit_to_px;

        let section =
            self.document.sections.get(section_idx).ok_or_else(|| {
                HwpError::InvalidFile(format!("section {} not found", section_idx))
            })?;
        let para = section
            .paragraphs
            .get(para_idx)
            .ok_or_else(|| HwpError::InvalidFile(format!("para {} not found", para_idx)))?;
        let composed = self
            .composed
            .get(section_idx)
            .and_then(|s| s.get(para_idx))
            .ok_or_else(|| HwpError::InvalidFile("composed paragraph not found".into()))?;

        let text_preview: String = para.text.chars().take(30).collect();

        let mut lines_json = Vec::new();

        for (line_idx, composed_line) in composed.lines.iter().enumerate() {
            let our_width_px = estimate_composed_line_width(composed_line, &self.styles);

            let stored_hwpunit = composed_line.segment_width;
            let stored_width_px = hwpunit_to_px(stored_hwpunit, self.dpi);

            let error_px = our_width_px - stored_width_px;
            let error_hwpunit = crate::renderer::px_to_hwpunit_round(error_px, self.dpi);

            // run별 상세
            let mut runs_json = Vec::new();
            for run in &composed_line.runs {
                let ts = crate::renderer::layout::resolved_to_text_style(
                    &self.styles,
                    run.char_style_id,
                    run.lang_index,
                );
                let run_width = crate::renderer::layout::estimate_text_width(&run.text, &ts);
                runs_json.push(format!(
                    r#"{{"text":"{}","lang":{},"font":"{}","width_px":{:.2}}}"#,
                    super::super::helpers::json_escape(&run.text),
                    run.lang_index,
                    super::super::helpers::json_escape(&ts.font_family),
                    run_width,
                ));
            }

            let line_text: String = composed_line.runs.iter().map(|r| r.text.as_str()).collect();

            lines_json.push(format!(
                r#"{{"line_index":{},"text":"{}","runs":[{}],"our_width_px":{:.2},"stored_segment_width_hwpunit":{},"stored_width_px":{:.2},"error_px":{:.2},"error_hwpunit":{}}}"#,
                line_idx,
                super::super::helpers::json_escape(&line_text),
                runs_json.join(","),
                our_width_px,
                stored_hwpunit,
                stored_width_px,
                error_px,
                error_hwpunit,
            ));
        }

        Ok(format!(
            r#"{{"paragraph":{{"section":{},"para":{},"text_preview":"{}"}},"lines":[{}]}}"#,
            section_idx,
            para_idx,
            super::super::helpers::json_escape(&text_preview),
            lines_json.join(","),
        ))
    }

    /// XML import → HWP 라운드트립 일관성 normalize.
    ///
    /// XML 파서가 채우지 않는 paragraph 필드를 HWP 직렬화/파싱 라운드트립 결과와 일치시킨다.
    /// - char_shapes 빈 paragraph 에 default `[(0, 0)]` 추가 (HWP 스펙: 최소 1개 PARA_CHAR_SHAPE 요구)
    /// - control_mask 를 controls + field_ranges + text 기반으로 재계산 (HWP 직렬화기와 동일 로직)
    fn normalize_xml_import_paragraphs(document: &mut Document) {
        use crate::model::control::Control;
        use crate::model::paragraph::{CharShapeRef, Paragraph};

        fn compute_mask(para: &Paragraph) -> u32 {
            let mut mask: u32 = 0;
            for ctrl in &para.controls {
                let bit = match ctrl {
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
                };
                mask |= 1u32 << bit;
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
            mask
        }

        fn process_para(para: &mut Paragraph) {
            if para.char_shapes.is_empty() {
                para.char_shapes.push(CharShapeRef {
                    start_pos: 0,
                    char_shape_id: 0,
                });
            }
            para.control_mask = compute_mask(para);
            // 셀 내부 paragraphs 도 재귀
            for ctrl in &mut para.controls {
                if let Control::Table(t) = ctrl {
                    for cell in &mut t.cells {
                        for cp in &mut cell.paragraphs {
                            process_para(cp);
                        }
                    }
                }
                // Shape의 text box paragraphs도 재귀해야 하나 정확한 API 미식별 → skip
                // (현재 회귀 케이스 hwpx-h-02 는 cell paragraphs로 충분)
            }
        }

        for section in &mut document.sections {
            for p in &mut section.paragraphs {
                process_para(p);
            }
        }
    }

    /// 초기 상태(properties bit 15 == 0) ClickHere 필드의 안내문 텍스트를 삭제한다.
    ///
    /// 한컴에서 메모 추가 등의 동작 시 안내문 텍스트가 필드 값으로 삽입되어,
    /// start_char_idx != end_char_idx 상태가 된다.
    /// compose 전에 이 텍스트를 제거하여 빈 필드(start==end)로 정규화한다.
    fn clear_initial_field_texts(document: &mut Document) {
        use crate::model::control::{Control, FieldType};
        use crate::model::paragraph::Paragraph;

        fn process_para(para: &mut Paragraph) {
            // 삭제 대상 field_range 인덱스와 삭제할 문자 범위 수집
            let mut removals: Vec<(usize, usize, usize)> = Vec::new(); // (fr_idx, start, end)
            for (fri, fr) in para.field_ranges.iter().enumerate() {
                if fr.start_char_idx >= fr.end_char_idx {
                    continue;
                }
                if let Some(Control::Field(f)) = para.controls.get(fr.control_idx) {
                    if f.field_type != FieldType::ClickHere {
                        continue;
                    }
                    if f.properties & (1 << 15) != 0 {
                        continue;
                    } // 이미 수정된 상태
                      // 필드 값이 안내문과 동일한지 확인
                    if let Some(guide) = f.guide_text() {
                        let chars: Vec<char> = para.text.chars().collect();
                        if fr.end_char_idx <= chars.len() {
                            let field_val: String =
                                chars[fr.start_char_idx..fr.end_char_idx].iter().collect();
                            // trailing 공백 제거 후 비교 (한컴이 안내문 뒤에 공백을 추가하는 경우)
                            if field_val.trim_end() == guide || field_val == guide {
                                removals.push((fri, fr.start_char_idx, fr.end_char_idx));
                            }
                        }
                    }
                }
            }
            // [Task #1893] 삭제 수술의 IR 불변성 완성용 스냅샷 — 삭제 전 char_offsets 는
            // 원본 문자 인덱스→utf16 위치 매핑의 유일한 근거다. removal 좌표는 전부
            // 수집-시점(원본) 인덱스이므로, 원본 스냅샷으로 utf16 범위를 구해
            // char_shapes 경계를 함께 시프트해야 직렬화→재파스가 고정점이 된다.
            // (종전엔 text/field_ranges 만 고쳐 char_offsets/char_count/char_shapes 가
            // stale — 그 불일치 IR 을 저장하면 재파스 정준형과 조판이 갈라져
            // 라운드트립 렌더 752px 분기·빈 줄 추가가 발생했다.)
            let orig_offsets: Vec<u32> = para.char_offsets.clone();
            let orig_chars: Vec<char> = para.text.chars().collect();
            let offsets_valid = orig_offsets.len() == orig_chars.len();
            fn utf16_width(c: char) -> u32 {
                if c == '\t' {
                    8
                } else if (c as u32) > 0xFFFF {
                    2
                } else {
                    1
                }
            }
            let mut any_removed = false;

            // 뒤에서부터 삭제 (인덱스 안정성 유지)
            for &(fri, start, end) in removals.iter().rev() {
                let chars: Vec<char> = para.text.chars().collect();
                // [Task #1620] 다중 removal 처리 중 앞선 removal 이 para.text 를 축소하면(특히
                // 같은 범위를 가리키는 중첩 field_range) 이후 removal 의 수집-시점 (start,end) 가
                // 현재 길이를 초과해 슬라이스 패닉(36396650). 현재 길이 기준 범위를 재검증해 skip.
                if start > end || end > chars.len() {
                    continue;
                }
                let removed_len = end - start;
                let new_text: String = chars[..start].iter().chain(chars[end..].iter()).collect();
                para.text = new_text;
                para.field_ranges[fri].end_char_idx = start;
                // 이후 field_ranges의 char_idx 조정
                for i in 0..para.field_ranges.len() {
                    if i == fri {
                        continue;
                    }
                    let other = &mut para.field_ranges[i];
                    if other.start_char_idx >= end {
                        other.start_char_idx -= removed_len;
                    }
                    if other.end_char_idx >= end {
                        other.end_char_idx -= removed_len;
                    }
                }
                any_removed = true;

                // [Task #1893] char_offsets/char_shapes/char_count 직접 수술 — 원본 utf16
                // 좌표 기준. 역순 처리라 오른쪽 removal 의 시프트가 왼쪽 utf16 좌표에 영향
                // 없고, 삭제 폭(u_end−u_start)은 원본 스냅샷 불변량이다. 컨트롤/필드 마커의
                // 8유닛 갭 구조는 기존 오프셋에 이미 올바르게 인코딩되어 있으므로 감산만으로
                // 보존된다 (rebuild_char_offsets 의 선행-컨트롤 휴리스틱은 문단 서두 0-length
                // 필드의 end 마커를 컨트롤로 오산해 begin 갭을 유실 — 필드쌍 교차 페어링 유발).
                if offsets_valid && start < end && end <= orig_offsets.len() {
                    let u_start = orig_offsets[start];
                    // 삭제 폭 = 삭제 문자들의 utf16 폭만. orig_offsets[end] 는 필드 end
                    // 마커의 8유닛 갭을 건너뛴 다음 문자 위치라 갭까지 폭에 포함되어
                    // 후속 오프셋에서 마커 갭이 소실된다(슬롯 방출 위치 붕괴).
                    let u_end = orig_offsets[end - 1] + utf16_width(orig_chars[end - 1]);
                    let width = u_end.saturating_sub(u_start);
                    // 삭제 구간의 오프셋 엔트리 제거 + 후속 엔트리 감산.
                    para.char_offsets.drain(start..end);
                    for off in para.char_offsets.iter_mut().skip(start) {
                        *off = off.saturating_sub(width);
                    }
                    para.char_count = para.char_count.saturating_sub(width);
                    for cs in &mut para.char_shapes {
                        if cs.start_pos >= u_end {
                            cs.start_pos -= width;
                        } else if cs.start_pos > u_start {
                            // 삭제 범위 내부 경계 → zero-width run 으로 시작점에 고정
                            // (한컴도 필드값 삭제 시 zero-width char run 을 남긴다 —
                            // 원본 서식의 자식 없는 <hp:run/> 33개와 동일 표현).
                            cs.start_pos = u_start;
                        }
                    }
                }
            }
            let _ = any_removed;
        }

        fn process_table(table: &mut crate::model::table::Table) {
            for cell in &mut table.cells {
                for cp in &mut cell.paragraphs {
                    process_para(cp);
                    // 중첩 표 재귀 탐색
                    for ctrl in &mut cp.controls {
                        if let Control::Table(nested) = ctrl {
                            process_table(nested);
                        }
                    }
                }
            }
        }

        for section in &mut document.sections {
            for para in &mut section.paragraphs {
                process_para(para);
                for ctrl in &mut para.controls {
                    if let Control::Table(table) = ctrl {
                        process_table(table);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod replace_content_tests {
    use super::*;

    const HML: &[u8] = include_bytes!("../../../samples/hml/formatting_table.hml");
    const HWP: &[u8] = include_bytes!("../../../saved/blank2010.hwp");
    const HWPX: &[u8] = include_bytes!("../../../saved/blank_hwpx.hwpx");

    #[test]
    fn font_refresh_preserves_nested_saved_lines_and_reflows_generated_lines() {
        use crate::model::{
            footnote::Footnote,
            header_footer::{Header, MasterPage},
            paragraph::CharShapeRef,
            provenance::FontMetricsPolicy,
            table::{Cell, Table},
        };
        let paragraph = |text: String| Paragraph {
            char_count: text.encode_utf16().count() as u32 + 1,
            char_offsets: (0..text.encode_utf16().count() as u32).collect(),
            text,
            char_shapes: vec![CharShapeRef::default()],
            ..Paragraph::default()
        };
        let line_metrics = |para: &Paragraph| {
            para.line_segs
                .iter()
                .map(|seg| {
                    (
                        seg.text_start,
                        seg.vertical_pos,
                        seg.line_height,
                        seg.text_height,
                        seg.baseline_distance,
                        seg.line_spacing,
                        seg.column_start,
                        seg.segment_width,
                        seg.tag,
                    )
                })
                .collect::<Vec<_>>()
        };
        for with_saved_lines in [true, false] {
            // 런타임 레지스트리는 thread-local이다. 각 경우에 고유 별칭을 써 다른
            // 테스트가 같은 작업 스레드에 등록한 글꼴을 지울 필요가 없게 한다.
            let face = if with_saved_lines {
                "__rhwp_mixed_cache_refresh__"
            } else {
                "__rhwp_unstored_cache_refresh__"
            };
            let mut seed = DocumentCore::new_empty();
            seed.create_blank_document_native().unwrap();
            let mut document = seed.document().clone();
            for fonts in &mut document.doc_info.font_faces {
                for font in fonts {
                    *font = crate::model::style::Font {
                        name: face.into(),
                        alt_type: 1,
                        ..crate::model::style::Font::default()
                    };
                }
            }
            document.doc_info.char_shapes[0].font_ids = [0; 7];
            document.doc_info.char_shapes[0].base_size = 1_000;
            document.doc_info.para_shapes[0].attr1 |= 2 << 5;
            document.doc_info.para_shapes[0].break_latin_word = Some("BREAK_WORD".into());
            let page = &mut document.sections[0].section_def.page_def;
            page.width = page.margin_left + page.margin_right + 7_200;
            let mut saved = paragraph("alpha beta".into());
            if with_saved_lines {
                let line = LineSeg {
                    line_height: 1_000,
                    text_height: 1_000,
                    baseline_distance: 850,
                    segment_width: 9_000,
                    tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
                    ..LineSeg::default()
                };
                saved.line_segs = vec![
                    line.clone(),
                    LineSeg {
                        text_start: 6,
                        vertical_pos: 1_600,
                        ..line
                    },
                ];
            }
            let table = Table {
                row_count: 1,
                col_count: 1,
                cells: vec![Cell {
                    width: 7_200,
                    height: 6_000,
                    paragraphs: vec![paragraph("iiii ".repeat(8)), saved.clone()],
                    ..Cell::default()
                }],
                ..Table::default()
            };
            document.sections[0]
                .section_def
                .master_pages
                .push(MasterPage {
                    paragraphs: vec![Paragraph {
                        controls: vec![Control::Table(Box::new(table.clone()))],
                        ..Paragraph::default()
                    }],
                    ..MasterPage::default()
                });
            document.sections[0].paragraphs = vec![
                paragraph("iiii ".repeat(24)),
                Paragraph {
                    controls: vec![
                        Control::Table(Box::new(table)),
                        Control::Header(Box::new(Header {
                            paragraphs: vec![saved.clone()],
                            ..Header::default()
                        })),
                        Control::Footnote(Box::new(Footnote {
                            paragraphs: vec![saved],
                            ..Footnote::default()
                        })),
                    ],
                    ..Paragraph::default()
                },
            ];
            let bytes = crate::serializer::hwpx::serialize_hwpx(&document).unwrap();
            let mut core =
                DocumentCore::from_bytes_with_font_metrics(&bytes, FontMetricsPolicy::HcrDeclared)
                    .unwrap();
            assert_eq!(core.styles.char_styles[0].font_family_for_lang(1), face);
            assert_eq!(
                core.document().provenance.own_line_layout,
                !with_saved_lines
            );
            let body_before = line_metrics(&core.document.sections[0].paragraphs[0]);
            let master_lines = |core: &DocumentCore| {
                let Control::Table(table) = &core.document.sections[0].section_def.master_pages[0]
                    .paragraphs[0]
                    .controls[0]
                else {
                    unreachable!()
                };
                table.cells[0]
                    .paragraphs
                    .iter()
                    .map(&line_metrics)
                    .collect::<Vec<_>>()
            };
            let master_before = master_lines(&core);
            let mut nested_before = Vec::new();
            visit_paragraphs_mut(&mut core.document.sections[0].paragraphs, &mut |para| {
                if para.text == "alpha beta" {
                    nested_before.push(line_metrics(para));
                }
            });
            assert_eq!(nested_before.len(), 3);
            crate::renderer::runtime_font_metrics::register(
                include_bytes!("../../../tests/fixtures/fonts/RHWPShapingFixture.ttf"),
                &[face.into()],
                false,
                false,
            )
            .unwrap();
            core.refresh_layout_native();
            let body_after = line_metrics(&core.document.sections[0].paragraphs[0]);
            assert_ne!(
                body_before, body_after,
                "generated body lines must use the late font"
            );
            let master_after = master_lines(&core);
            if with_saved_lines {
                assert_eq!(
                    master_before, master_after,
                    "saved master lines must survive refresh"
                );
            } else {
                assert_ne!(
                    master_before, master_after,
                    "generated master lines must use the late font"
                );
                let early = DocumentCore::from_bytes_with_font_metrics(
                    &bytes,
                    FontMetricsPolicy::HcrDeclared,
                )
                .unwrap();
                assert_eq!(master_after, master_lines(&early));
            }
            if with_saved_lines {
                let mut nested_after = Vec::new();
                visit_paragraphs_mut(&mut core.document.sections[0].paragraphs, &mut |para| {
                    if para.text == "alpha beta" {
                        nested_after.push(line_metrics(para));
                    }
                });
                assert_eq!(
                    nested_before, nested_after,
                    "saved table/header/note caches must survive refresh"
                );
            }
            core.refresh_layout_native();
            assert_eq!(
                body_after,
                line_metrics(&core.document.sections[0].paragraphs[0])
            );
        }
    }

    #[test]
    fn english_break_unit_edits_roundtrip_through_hwpx_and_hwp() {
        let shape = |core: &DocumentCore| {
            let id = core.document.sections[0].paragraphs[0].para_shape_id;
            core.document.doc_info.para_shapes[id as usize].clone()
        };
        let mut seed = DocumentCore::new_empty();
        seed.create_blank_document_native().unwrap();
        seed.document.doc_info.para_shapes[0].attr1 |= 2 << 5;
        seed.document.doc_info.para_shapes[0].break_latin_word = Some("BREAK_WORD".into());
        let mut core = DocumentCore::from_bytes(&seed.export_hwpx_native().unwrap()).unwrap();
        for (unit, name) in [(0, "KEEP_WORD"), (1, "HYPHENATION"), (2, "BREAK_WORD")] {
            core.apply_para_format_native(0, 0, &format!("{{\"englishBreakUnit\":{unit}}}"))
                .unwrap();
            assert_eq!(shape(&core).break_latin_word.as_deref(), Some(name));
            let hwpx = DocumentCore::from_bytes(&core.export_hwpx_native().unwrap()).unwrap();
            assert_eq!((shape(&hwpx).attr1 >> 5) & 3, unit);
            assert_eq!(shape(&hwpx).break_latin_word.as_deref(), Some(name));
            let hwp = DocumentCore::from_bytes(&core.export_hwp_native().unwrap()).unwrap();
            assert_eq!((shape(&hwp).attr1 >> 5) & 3, unit);
            assert_eq!(shape(&hwp).break_latin_word, None);
            let cross_format =
                DocumentCore::from_bytes(&hwp.export_hwpx_native().unwrap()).unwrap();
            assert_eq!((shape(&cross_format).attr1 >> 5) & 3, unit);
            assert_eq!(shape(&cross_format).break_latin_word.as_deref(), Some(name));
        }

        let mut original = seed.document().clone();
        original.doc_info.para_shapes[0].break_latin_word = Some("FUTURE_UNIT".into());
        let bytes = crate::serializer::hwpx::serialize_hwpx(&original).unwrap();
        let mut core = DocumentCore::from_bytes(&bytes).unwrap();
        core.apply_para_format_native(0, 0, r#"{"marginLeft":120}"#)
            .unwrap();
        let reopened = DocumentCore::from_bytes(&core.export_hwpx_native().unwrap()).unwrap();
        assert_eq!(
            shape(&reopened).break_latin_word.as_deref(),
            Some("FUTURE_UNIT")
        );
    }

    #[test]
    fn missing_cell_lines_use_selected_font_metrics_during_import_and_replacement() {
        use crate::model::provenance::FontMetricsPolicy;
        const SOURCE: &[u8] = include_bytes!(
            "../../../tests/fixtures/editing_parity/mac-hancom-12.30.0/cell-mixed-text/source.hwpx"
        );
        let mut document = crate::parser::hwpx::parse_hwpx(SOURCE).unwrap();
        document
            .hwpx_aux_entries
            .retain(|(path, _)| path != crate::model::document::HWP5_ORIGIN_HWPX_MARKER_PATH);
        let table = document.sections[0].paragraphs[0]
            .controls
            .iter_mut()
            .find_map(|control| {
                if let Control::Table(table) = control {
                    Some(table)
                } else {
                    None
                }
            })
            .unwrap();
        table.cells[0].paragraphs[0].line_segs.clear();
        let bytes = crate::serializer::hwpx::serialize_hwpx(&document).unwrap();
        let starts = |core: &DocumentCore| -> Vec<u32> {
            let table = core.document.sections[0].paragraphs[0]
                .controls
                .iter()
                .find_map(|control| {
                    if let Control::Table(table) = control {
                        Some(table)
                    } else {
                        None
                    }
                })
                .unwrap();
            table.cells[0].paragraphs[0]
                .line_segs
                .iter()
                .map(|line| line.text_start)
                .collect()
        };
        let selected =
            DocumentCore::from_bytes_with_font_metrics(&bytes, FontMetricsPolicy::HcrDeclared)
                .unwrap();
        let mut late =
            DocumentCore::from_bytes_with_font_metrics(&bytes, FontMetricsPolicy::HancomWindows)
                .unwrap();
        assert_ne!(
            starts(&selected),
            starts(&late),
            "fixture must distinguish the two fonts' wrapping"
        );
        late.set_font_metrics_policy_native(FontMetricsPolicy::HcrDeclared);
        assert_eq!(
            starts(&late),
            starts(&selected),
            "late font selection must reconstruct generated cell lines"
        );
        late.replace_content_from_bytes_native(&bytes).unwrap();
        assert_eq!(
            starts(&late),
            starts(&selected),
            "replacement must select metrics before reconstruction too"
        );
        assert_eq!(
            late.get_page_text_layout_native(0).unwrap(),
            selected.get_page_text_layout_native(0).unwrap()
        );
    }

    fn serialized_document(core: &DocumentCore) -> Vec<u8> {
        core.export_hwp_native().expect("document should serialize")
    }

    #[test]
    fn shared_snapshot_ids_retain_one_immutable_document_state() {
        let mut core = DocumentCore::from_bytes(HML).expect("HML source should open");
        let original = serialized_document(&core);
        let source_id = core.save_snapshot_native();
        let shared_id = core
            .share_snapshot_native(source_id)
            .expect("existing snapshot should be shareable");

        let source = core
            .snapshot_store
            .iter()
            .find(|(id, _)| *id == source_id)
            .map(|(_, document)| document)
            .expect("source snapshot");
        let shared = core
            .snapshot_store
            .iter()
            .find(|(id, _)| *id == shared_id)
            .map(|(_, document)| document)
            .expect("shared snapshot");
        assert!(Arc::ptr_eq(source, shared));

        core.document.doc_properties.page_start_num += 1;
        core.restore_snapshot_native(shared_id)
            .expect("shared ID should restore the original state");
        assert_eq!(serialized_document(&core), original);

        core.discard_snapshot_native(source_id);
        core.document.doc_properties.page_start_num += 2;
        core.restore_snapshot_native(shared_id)
            .expect("discarding one ID must not invalidate the shared ID");
        assert_eq!(serialized_document(&core), original);
    }

    fn add_snapshot_payloads(core: &mut DocumentCore, size: usize) {
        use crate::model::document::{Preview, PreviewImage, PreviewImageFormat};
        core.document.extra_streams = vec![("/Opaque".into(), vec![1; size])];
        core.document.hwpx_aux_entries = vec![("custom/opaque.bin".into(), vec![2; size])];
        core.document.preview = Some(Preview {
            image: Some(PreviewImage {
                format: PreviewImageFormat::Png,
                data: vec![3; size],
            }),
            text: Some("preview".into()),
        });
        core.document.sections[0].raw_stream = Some(vec![4; size]);
    }

    #[test]
    fn snapshots_share_opaque_payload_allocations() {
        let mut core = DocumentCore::from_bytes(HML).unwrap();
        add_snapshot_payloads(&mut core, 1024 * 1024);
        // 다른 구역을 편집하면 원본 스트림이 남은 구역도 매번 캡처된다.
        core.document
            .sections
            .push(core.document.sections[0].clone());
        core.document.sections[1].raw_stream = None;
        core.refresh_layout_native();
        let mut capture_elapsed = std::time::Duration::ZERO;
        for _ in 0..20 {
            core.insert_text_native(1, 0, 0, "X").unwrap();
            let started = std::time::Instant::now();
            core.save_snapshot_native();
            capture_elapsed += started.elapsed();
        }
        let first = &core.snapshot_store[0].1;
        for (_, snapshot) in &core.snapshot_store {
            assert!(Arc::ptr_eq(&first.extra_streams, &snapshot.extra_streams));
            assert!(Arc::ptr_eq(
                &first.hwpx_aux_entries,
                &snapshot.hwpx_aux_entries
            ));
            assert!(Arc::ptr_eq(
                first.preview_image.as_ref().unwrap(),
                snapshot.preview_image.as_ref().unwrap()
            ));
            assert!(Arc::ptr_eq(
                first.sections[0].raw_stream.as_ref().unwrap(),
                snapshot.sections[0].raw_stream.as_ref().unwrap()
            ));
            assert!(snapshot.document_shell.extra_streams.is_empty());
            assert!(snapshot.document_shell.hwpx_aux_entries.is_empty());
            assert!(snapshot
                .document_shell
                .preview
                .as_ref()
                .unwrap()
                .image
                .as_ref()
                .unwrap()
                .data
                .is_empty());
            assert!(snapshot.sections[0].section_shell.raw_stream.is_none());
        }
        eprintln!("snapshot opaque payloads: 20 captures, 4 MiB unique bytes vs 80 MiB deep copies; capture {:?}", capture_elapsed);
    }

    #[test]
    fn snapshot_opaque_payloads_preserve_untracked_mutations_and_restore_isolation() {
        let mut core = DocumentCore::from_bytes(HML).unwrap();
        add_snapshot_payloads(&mut core, 8);
        let before = core.save_snapshot_native();
        {
            let doc = core.document_mut();
            doc.extra_streams[0].1[0] = 11;
            doc.hwpx_aux_entries[0].1[0] = 12;
            doc.preview.as_mut().unwrap().image.as_mut().unwrap().data[0] = 13;
            doc.sections[0].raw_stream.as_mut().unwrap()[0] = 14;
        }
        let after = core.save_snapshot_native();
        let a = Arc::clone(&core.snapshot_store[0].1);
        let b = Arc::clone(&core.snapshot_store[1].1);
        assert!(!Arc::ptr_eq(&a.extra_streams, &b.extra_streams));
        assert!(!Arc::ptr_eq(&a.hwpx_aux_entries, &b.hwpx_aux_entries));
        assert!(!Arc::ptr_eq(
            a.preview_image.as_ref().unwrap(),
            b.preview_image.as_ref().unwrap()
        ));
        assert!(!Arc::ptr_eq(
            a.sections[0].raw_stream.as_ref().unwrap(),
            b.sections[0].raw_stream.as_ref().unwrap()
        ));
        for (id, delta) in [(before, 0), (after, 10), (before, 0)] {
            core.restore_snapshot_native(id).unwrap();
            let doc = core.document();
            assert_eq!(doc.extra_streams[0].1[0], 1 + delta);
            assert_eq!(doc.hwpx_aux_entries[0].1[0], 2 + delta);
            assert_eq!(
                doc.preview.as_ref().unwrap().image.as_ref().unwrap().data[0],
                3 + delta
            );
            assert_eq!(doc.sections[0].raw_stream.as_ref().unwrap()[0], 4 + delta);
        }
        core.document_mut().extra_streams[0].1[0] = 21;
        let edited = core.save_snapshot_native();
        assert_eq!(a.extra_streams[0].1[0], 1);
        assert_eq!(b.extra_streams[0].1[0], 11);
        core.restore_snapshot_native(after).unwrap();
        assert_eq!(core.document.extra_streams[0].1[0], 11);
        core.restore_snapshot_native(edited).unwrap();
        assert_eq!(core.document.extra_streams[0].1[0], 21);
        core.document_mut().sections[0].raw_stream = None;
        let without_raw = core.save_snapshot_native();
        core.restore_snapshot_native(before).unwrap();
        assert_eq!(core.document.sections[0].raw_stream.as_ref().unwrap()[0], 4);
        core.restore_snapshot_native(without_raw).unwrap();
        assert!(core.document.sections[0].raw_stream.is_none());
    }

    #[test]
    fn snapshot_opaque_payload_presence_and_serialization_survive_undo_redo() {
        let mut core = DocumentCore::from_bytes(HML).unwrap();
        let absent = core.save_snapshot_native();
        add_snapshot_payloads(&mut core, 8);
        // 임의의 바이트는 유효한 HWP 구역 레코드가 아니므로 저장 검증에서는 제외한다.
        core.document.sections[0].raw_stream = None;
        let present = core.save_snapshot_native();
        let expected_hwp = core.export_hwp_native().unwrap();
        let expected_hwpx = core.export_hwpx_native().unwrap();
        core.document_mut().extra_streams.clear();
        core.document_mut().hwpx_aux_entries.clear();
        core.document_mut().preview.as_mut().unwrap().image = None;
        let removed = core.save_snapshot_native();
        core.restore_snapshot_native(present).unwrap();
        assert_eq!(core.export_hwp_native().unwrap(), expected_hwp);
        assert_eq!(core.export_hwpx_native().unwrap(), expected_hwpx);
        core.restore_snapshot_native(removed).unwrap();
        assert!(core.document.extra_streams.is_empty());
        assert!(core.document.hwpx_aux_entries.is_empty());
        assert!(core.document.preview.as_ref().unwrap().image.is_none());
        core.restore_snapshot_native(absent).unwrap();
        assert!(core.document.extra_streams.is_empty());
        assert!(core.document.hwpx_aux_entries.is_empty());
        core.restore_snapshot_native(present).unwrap();
        assert_eq!(core.export_hwp_native().unwrap(), expected_hwp);
    }

    #[test]
    fn unique_snapshots_share_unchanged_sections_and_restore_each_state() {
        let mut core = DocumentCore::from_bytes(HML).expect("HML source should open");
        core.document
            .sections
            .push(core.document.sections[0].clone());
        core.refresh_layout_native();
        let before_text = core.document.sections[0].paragraphs[0].text.clone();
        let before_pages = core.page_count();
        let before_id = core.save_snapshot_native();

        core.insert_text_native(0, 0, 0, "X")
            .expect("section-local edit should succeed");
        let after_text = core.document.sections[0].paragraphs[0].text.clone();
        let after_pages = core.page_count();
        let after_id = core.save_snapshot_native();

        let before = &core
            .snapshot_store
            .iter()
            .find(|(id, _)| *id == before_id)
            .expect("before snapshot")
            .1;
        let after = &core
            .snapshot_store
            .iter()
            .find(|(id, _)| *id == after_id)
            .expect("after snapshot")
            .1;
        assert!(!Arc::ptr_eq(
            &before.sections[0].paragraphs[0].paragraph,
            &after.sections[0].paragraphs[0].paragraph
        ));
        for (before_paragraph, after_paragraph) in before.sections[0]
            .paragraphs
            .iter()
            .zip(&after.sections[0].paragraphs)
            .skip(1)
        {
            assert!(Arc::ptr_eq(
                &before_paragraph.paragraph,
                &after_paragraph.paragraph
            ));
        }
        for (before_paragraph, after_paragraph) in before.sections[1]
            .paragraphs
            .iter()
            .zip(&after.sections[1].paragraphs)
        {
            assert!(Arc::ptr_eq(
                &before_paragraph.paragraph,
                &after_paragraph.paragraph
            ));
        }

        core.restore_snapshot_native(before_id)
            .expect("before snapshot restore");
        assert_eq!(core.document.sections[0].paragraphs[0].text, before_text);
        assert_eq!(core.page_count(), before_pages);
        core.restore_snapshot_native(after_id)
            .expect("after snapshot restore");
        assert_eq!(core.document.sections[0].paragraphs[0].text, after_text);
        assert_eq!(core.page_count(), after_pages);
    }

    #[test]
    fn paragraph_sequence_changes_keep_snapshot_indices_independent() {
        let mut core = DocumentCore::new_empty();
        core.create_blank_document_native()
            .expect("blank document creation");
        core.insert_text_native(0, 0, 0, "앞뒤")
            .expect("seed paragraph");
        let before_id = core.save_snapshot_native();

        core.split_paragraph_native(0, 0, 1, None)
            .expect("split paragraph");
        let after_id = core.save_snapshot_native();
        let before = &core
            .snapshot_store
            .iter()
            .find(|(id, _)| *id == before_id)
            .expect("before snapshot")
            .1;
        let after = &core
            .snapshot_store
            .iter()
            .find(|(id, _)| *id == after_id)
            .expect("after snapshot")
            .1;
        assert_eq!(before.sections[0].paragraphs.len(), 1);
        assert_eq!(after.sections[0].paragraphs.len(), 2);
        assert!(!Arc::ptr_eq(
            &before.sections[0].paragraphs[0].paragraph,
            &after.sections[0].paragraphs[0].paragraph
        ));

        core.restore_snapshot_native(before_id)
            .expect("restore before split");
        assert_eq!(core.document.sections[0].paragraphs.len(), 1);
        assert_eq!(core.document.sections[0].paragraphs[0].text, "앞뒤");
        core.restore_snapshot_native(after_id)
            .expect("restore after split");
        assert_eq!(core.document.sections[0].paragraphs.len(), 2);
        assert_eq!(core.document.sections[0].paragraphs[0].text, "앞");
        assert_eq!(core.document.sections[0].paragraphs[1].text, "뒤");
    }

    #[test]
    fn replacement_preserves_live_identity_preferences_and_snapshots() {
        let mut core = DocumentCore::from_bytes(HML).expect("HML source should open");
        core.file_name = "kept-name.hml".to_string();
        core.set_dpi(144.0);
        core.fallback_font = "/kept/font.ttf".to_string();
        core.show_paragraph_marks = true;
        core.show_control_codes = true;
        core.show_transparent_borders = true;
        core.clip_enabled = false;
        core.debug_overlay = true;
        core.respect_vpos_reset = true;
        let original = serialized_document(&core);
        let original_hml_version = core
            .hml_metadata()
            .and_then(|metadata| metadata.hwpml_version.clone());
        let snapshot_id = core.save_snapshot_native();

        core.replace_content_from_bytes_native(HWP)
            .expect("HWP replacement should succeed");

        let mut expected = DocumentCore::from_bytes(HWP).expect("HWP target should open");
        expected
            .convert_to_editable_native()
            .expect("target should become editable");
        assert_eq!(serialized_document(&core), serialized_document(&expected));
        assert_eq!(core.file_name, "kept-name.hml");
        assert_eq!(core.source_format, crate::parser::FileFormat::Hml);
        assert_eq!(
            core.hml_metadata()
                .and_then(|metadata| metadata.hwpml_version.clone()),
            original_hml_version,
        );
        assert_eq!(core.dpi, 144.0);
        assert_eq!(core.fallback_font, "/kept/font.ttf");
        assert!(core.show_paragraph_marks);
        assert!(core.show_control_codes);
        assert!(core.show_transparent_borders);
        assert!(!core.clip_enabled);
        assert!(core.debug_overlay);
        assert!(core.respect_vpos_reset);
        assert_eq!(core.snapshot_store.len(), 1);

        core.restore_snapshot_native(snapshot_id)
            .expect("pre-replacement snapshot should remain valid");
        assert_eq!(serialized_document(&core), original);
    }

    #[test]
    fn replacement_accepts_each_supported_version_payload_without_changing_save_format() {
        let mut core = DocumentCore::from_bytes(HWP).expect("HWP source should open");
        core.file_name = "kept-name.hwp".to_string();
        let snapshot_id = core.save_snapshot_native();

        for bytes in [HWP, HWPX, HML] {
            let mut expected = DocumentCore::from_bytes(bytes).expect("target should parse");
            expected
                .convert_to_editable_native()
                .expect("target should become editable");
            core.replace_content_from_bytes_native(bytes)
                .expect("replacement should succeed");

            assert_eq!(serialized_document(&core), serialized_document(&expected));
            assert_eq!(core.source_format, crate::parser::FileFormat::Hwp);
            assert_eq!(core.file_name, "kept-name.hwp");
            assert!(core.snapshot_store.iter().any(|(id, _)| *id == snapshot_id));
        }
    }

    #[test]
    fn invalid_replacement_bytes_leave_the_live_core_untouched() {
        let mut core = DocumentCore::from_bytes(HML).expect("HML source should open");
        core.file_name = "untouched.hml".to_string();
        let snapshot_id = core.save_snapshot_native();
        let before = serialized_document(&core);
        let before_pages = core.page_count();

        assert!(core
            .replace_content_from_bytes_native(b"not a document")
            .is_err());
        assert_eq!(serialized_document(&core), before);
        assert_eq!(core.page_count(), before_pages);
        assert_eq!(core.file_name, "untouched.hml");
        assert_eq!(core.source_format, crate::parser::FileFormat::Hml);
        assert!(core.snapshot_store.iter().any(|(id, _)| *id == snapshot_id));
    }
}

#[cfg(test)]
mod validate_linesegs_tests {
    use super::*;
    use crate::model::document::{Document, Section};
    use crate::model::paragraph::{LineSeg, Paragraph};

    #[test]
    fn hwpx_image_id_canonicalization_skips_link_and_ole_documents() {
        use crate::model::bin_data::{BinData, BinDataContent, BinDataType};

        let mut linked = Document::default();
        linked.doc_info.bin_data_list = vec![
            BinData {
                data_type: BinDataType::Link,
                storage_id: 0,
                ..Default::default()
            },
            BinData {
                data_type: BinDataType::Embedding,
                storage_id: 7,
                ..Default::default()
            },
        ];
        linked.bin_data_content.push(BinDataContent {
            id: 7,
            data: vec![1].into(),
            extension: "png".to_string(),
        });
        DocumentCore::canonicalize_hwp5_bin_data_ids_for_hwpx_export(&mut linked);
        assert_eq!(linked.bin_data_content[0].id, 7);
        assert_eq!(linked.doc_info.bin_data_list[1].storage_id, 7);

        let mut ole = Document::default();
        ole.doc_info.bin_data_list.push(BinData {
            data_type: BinDataType::Storage,
            storage_id: 9,
            ..Default::default()
        });
        ole.bin_data_content.push(BinDataContent {
            id: 9,
            data: vec![2].into(),
            extension: "OLE".to_string(),
        });
        DocumentCore::canonicalize_hwp5_bin_data_ids_for_hwpx_export(&mut ole);
        assert_eq!(ole.bin_data_content[0].id, 9);
        assert_eq!(ole.doc_info.bin_data_list[0].storage_id, 9);
    }

    #[test]
    fn hwpx_image_id_canonicalization_skips_duplicate_content_ids() {
        use crate::model::bin_data::{BinData, BinDataContent, BinDataType};

        let mut document = Document::default();
        document.doc_info.bin_data_list = vec![
            BinData {
                data_type: BinDataType::Embedding,
                storage_id: 2,
                ..Default::default()
            },
            BinData {
                data_type: BinDataType::Embedding,
                storage_id: 3,
                ..Default::default()
            },
        ];
        document.bin_data_content = vec![
            BinDataContent {
                id: 2,
                data: vec![1].into(),
                extension: "png".to_string(),
            },
            BinDataContent {
                id: 2,
                data: vec![2].into(),
                extension: "png".to_string(),
            },
        ];

        DocumentCore::canonicalize_hwp5_bin_data_ids_for_hwpx_export(&mut document);
        assert_eq!(
            document
                .bin_data_content
                .iter()
                .map(|content| content.id)
                .collect::<Vec<_>>(),
            vec![2, 2]
        );
        assert_eq!(
            document
                .doc_info
                .bin_data_list
                .iter()
                .map(|bin_data| bin_data.storage_id)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
    }

    fn document_with_equation(script: &str) -> Document {
        let mut paragraph = Paragraph::default();
        paragraph.char_count = 9;
        paragraph.controls.push(Control::Equation(Box::new(
            crate::model::control::Equation {
                script: script.to_string(),
                ..Default::default()
            },
        )));
        Document {
            sections: vec![Section {
                paragraphs: vec![paragraph],
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn validated_exports_preserve_equation_semantics() {
        let document = document_with_equation("1 over 2");
        serialize_validated_hwp(&document).expect("HWP equation semantic gate");
        serialize_validated_hwpx(&document).expect("HWPX equation semantic gate");
    }

    #[test]
    fn equation_semantic_gate_rejects_nested_script_loss() {
        use crate::model::control::Field;

        let mut before = Document {
            sections: vec![Section::default()],
            ..Default::default()
        };
        let memo = document_with_equation("nested memo equation").sections[0].paragraphs[0].clone();
        before.sections[0].paragraphs.push(Paragraph {
            controls: vec![Control::Field(Field {
                memo_paragraphs: vec![memo],
                ..Default::default()
            })],
            ..Default::default()
        });
        let mut after = before.clone();
        let Control::Field(field) = &mut after.sections[0].paragraphs[0].controls[0] else {
            panic!("field expected");
        };
        let Control::Equation(eq) = &mut field.memo_paragraphs[0].controls[0] else {
            panic!("nested equation expected");
        };
        eq.script.clear();

        let error = validate_equation_fingerprints(&before, &after, "test").unwrap_err();
        assert!(error.to_string().contains("equation semantics changed"));
    }

    #[test]
    fn equation_fingerprints_visit_chart_and_ole_captions() {
        fn caption(script: &str) -> crate::model::shape::Caption {
            crate::model::shape::Caption {
                paragraphs: vec![document_with_equation(script).sections[0].paragraphs[0].clone()],
                ..Default::default()
            }
        }

        let document = Document {
            doc_info: crate::model::document::DocInfo {
                para_shapes: vec![Default::default()],
                styles: vec![Default::default()],
                ..Default::default()
            },
            sections: vec![Section {
                paragraphs: vec![Paragraph {
                    controls: vec![
                        Control::Shape(Box::new(ShapeObject::Chart(Box::new(
                            crate::model::shape::ChartShape {
                                caption: Some(caption("chart equation")),
                                ..Default::default()
                            },
                        )))),
                        Control::Shape(Box::new(ShapeObject::Ole(Box::new(
                            crate::model::shape::OleShape {
                                caption: Some(caption("ole equation")),
                                ..Default::default()
                            },
                        )))),
                    ],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };

        let fingerprints = equation_fingerprints(&document);
        assert_eq!(fingerprints.len(), 2);
        assert!(fingerprints[0].path.contains("chart.caption"));
        assert!(fingerprints[1].path.contains("ole.caption"));
    }

    #[test]
    fn validated_exports_preserve_chart_and_ole_caption_equations() {
        fn caption(script: &str) -> crate::model::shape::Caption {
            crate::model::shape::Caption {
                paragraphs: vec![document_with_equation(script).sections[0].paragraphs[0].clone()],
                ..Default::default()
            }
        }

        let document = Document {
            doc_info: crate::model::document::DocInfo {
                para_shapes: vec![Default::default()],
                styles: vec![Default::default()],
                ..Default::default()
            },
            sections: vec![Section {
                paragraphs: vec![Paragraph {
                    char_count: 17,
                    controls: vec![
                        Control::Shape(Box::new(ShapeObject::Chart(Box::new(
                            crate::model::shape::ChartShape {
                                caption: Some(caption("chart equation")),
                                ..Default::default()
                            },
                        )))),
                        Control::Shape(Box::new(ShapeObject::Ole(Box::new(
                            crate::model::shape::OleShape {
                                caption: Some(caption("ole equation")),
                                ..Default::default()
                            },
                        )))),
                    ],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };

        serialize_validated_hwp(&document).expect("HWP nested equation validation");

        // Native ChartShape has no HWPX chart-part reference and therefore
        // cannot be represented losslessly; the semantic gate must reject the
        // mixed export instead of silently dropping its caption equation.
        let error = serialize_validated_hwpx(&document).expect_err("chart loss must fail closed");
        assert!(error.to_string().contains("equation count changed"));

        // OLE captions are representable and should survive the same HWPX gate.
        let mut hwpx_document = document.clone();
        hwpx_document.sections[0].paragraphs[0].controls.remove(0);
        hwpx_document.sections[0].paragraphs[0].char_count = 9;
        serialize_validated_hwpx(&hwpx_document).expect("HWPX OLE equation validation");
    }

    #[test]
    fn generated_hwp_strict_validation_rejects_truncated_cfb() {
        let document = Document {
            sections: vec![Section::default()],
            ..Default::default()
        };
        let bytes = serialize_validated_hwp(&document).expect("minimal generated HWP validates");
        assert_eq!(
            crate::parser::parse_hwp_strict(&bytes)
                .expect("strict reparse")
                .sections
                .len(),
            1,
        );

        let truncated = &bytes[..bytes.len() - 1];
        assert!(
            crate::parser::parse_hwp_strict(truncated).is_err(),
            "strict save gate must reject a sector-truncated generated package",
        );
    }

    #[test]
    fn generated_hwpx_validation_rejects_truncated_zip() {
        let document = Document {
            sections: vec![Section::default()],
            ..Default::default()
        };
        let bytes = serialize_validated_hwpx(&document).expect("minimal generated HWPX validates");
        assert_eq!(
            crate::parser::hwpx::parse_hwpx(&bytes)
                .expect("HWPX reparse")
                .sections
                .len(),
            1,
        );

        let truncated = &bytes[..bytes.len() - 8];
        let report = crate::serializer::hwpx::package_check::check_package(truncated, &document);
        assert!(!report.is_ok(), "package gate must reject a truncated ZIP");
        assert!(crate::parser::hwpx::parse_hwpx(truncated).is_err());
    }

    #[test]
    fn from_bytes_retains_hml_import_metadata_outside_document_ir() {
        let core =
            DocumentCore::from_bytes(include_bytes!("../../../samples/hml/formatting_table.hml"))
                .expect("real HML fixture should open");
        let metadata = core
            .hml_metadata()
            .expect("HML metadata should survive document normalization");

        assert_eq!(metadata.hwpml_version.as_deref(), Some("2.91"));
        assert_eq!(metadata.resource_count, 0);
        assert!(!metadata.warnings.is_empty());
    }

    /// [Task #1620] `clear_initial_field_texts`: 같은 텍스트 범위를 가리키는 다중 ClickHere
    /// field_range 처리 시, 첫 removal 이 `para.text` 를 비우면 이후 removal 이 stale 인덱스로
    /// 슬라이스해 패닉(36396650, `document.rs:927` range out of range). 범위 가드 추가로
    /// 패닉 없이 정규화돼야 함.
    #[test]
    fn clear_initial_field_texts_no_panic_on_overlapping_removals() {
        use crate::model::control::{Control, Field, FieldType};
        use crate::model::paragraph::FieldRange;

        let field = Field {
            field_type: FieldType::ClickHere,
            command: "Clickhere:set:48:Direction:wstring:6:여기에 입력 HelpState:wstring:0:  "
                .to_string(),
            properties: 0, // bit15 == 0 (초기 상태 → 안내문 제거 대상)
            ..Default::default()
        };
        // 같은 텍스트 범위 [0,6) 를 가리키는 field_range 2개(중첩) → 다중 removal.
        let para = Paragraph {
            text: "여기에 입력".to_string(),
            controls: vec![Control::Field(field)],
            field_ranges: vec![
                FieldRange {
                    start_char_idx: 0,
                    end_char_idx: 6,
                    control_idx: 0,
                    ..Default::default()
                },
                FieldRange {
                    start_char_idx: 0,
                    end_char_idx: 6,
                    control_idx: 0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let mut doc = Document::default();
        let mut section = Section::default();
        section.paragraphs.push(para);
        doc.sections.push(section);

        // 수정 전: document.rs 제거 루프에서 stale 인덱스 슬라이스 패닉.
        // 수정 후: 패닉 없이 안내문 제거(빈 텍스트).
        DocumentCore::clear_initial_field_texts(&mut doc);
        assert!(
            doc.sections[0].paragraphs[0].text.is_empty(),
            "안내문이 제거돼 빈 텍스트여야 함"
        );
    }

    /// 텍스트는 있는데 line_segs 가 비어있는 문단 — LinesegArrayEmpty 감지
    #[test]
    fn validate_detects_empty_linesegs() {
        let mut doc = Document::default();
        let mut section = Section::default();
        let mut para = Paragraph::default();
        para.text = "hello".to_string();
        // line_segs 비워둠
        section.paragraphs.push(para);
        doc.sections.push(section);

        let report = DocumentCore::validate_linesegs(&doc, true);
        assert_eq!(report.len(), 1);
        assert_eq!(report.warnings[0].kind, WarningKind::LinesegArrayEmpty);
        assert_eq!(report.warnings[0].section_idx, 0);
        assert_eq!(report.warnings[0].paragraph_idx, 0);
        assert!(report.warnings[0].cell_path.is_none());
    }

    /// line_segs 가 1개, line_height=0 — LinesegUncomputed 감지
    #[test]
    fn validate_detects_uncomputed_lineseg() {
        let mut doc = Document::default();
        let mut section = Section::default();
        let mut para = Paragraph::default();
        para.text = "hello".to_string();
        para.line_segs.push(LineSeg::default()); // line_height=0 상태
        section.paragraphs.push(para);
        doc.sections.push(section);

        let report = DocumentCore::validate_linesegs(&doc, true);
        assert_eq!(report.len(), 1);
        assert_eq!(report.warnings[0].kind, WarningKind::LinesegUncomputed);
    }

    /// 정상 lineseg (line_height > 0) — 경고 없음
    #[test]
    fn validate_skips_healthy_lineseg() {
        let mut doc = Document::default();
        let mut section = Section::default();
        let mut para = Paragraph::default();
        para.text = "hello".to_string();
        let mut seg = LineSeg::default();
        seg.line_height = 1000;
        para.line_segs.push(seg);
        section.paragraphs.push(para);
        doc.sections.push(section);

        let report = DocumentCore::validate_linesegs(&doc, true);
        assert!(
            report.is_empty(),
            "healthy paragraph should not warn: {:?}",
            report.warnings
        );
    }

    /// 빈 문단 (텍스트도 line_segs 도 없음) — 경고 없음 (빈 문단은 허용)
    #[test]
    fn validate_skips_empty_paragraph() {
        let mut doc = Document::default();
        let mut section = Section::default();
        section.paragraphs.push(Paragraph::default());
        doc.sections.push(section);

        let report = DocumentCore::validate_linesegs(&doc, true);
        assert!(report.is_empty());
    }

    /// 표 셀 내부 문단도 검증 — cell_path 가 기록됨
    #[test]
    fn validate_recurses_into_table_cells() {
        use crate::model::table::{Cell, Table};

        let mut doc = Document::default();
        let mut section = Section::default();
        let mut outer_para = Paragraph::default();

        // 셀 내부에 문제가 있는 문단
        let mut cell_para = Paragraph::default();
        cell_para.text = "in-cell".to_string();
        // line_segs 비워둠 → LinesegArrayEmpty 감지 대상

        let mut cell = Cell::default();
        cell.row = 0;
        cell.col = 0;
        cell.paragraphs.push(cell_para);

        let mut table = Table::default();
        table.row_count = 1;
        table.col_count = 1;
        table.cells.push(cell);

        outer_para.controls.push(Control::Table(Box::new(table)));
        section.paragraphs.push(outer_para);
        doc.sections.push(section);

        let report = DocumentCore::validate_linesegs(&doc, true);
        assert_eq!(report.len(), 1);
        assert_eq!(report.warnings[0].kind, WarningKind::LinesegArrayEmpty);
        let cp = report.warnings[0]
            .cell_path
            .expect("cell_path should be set");
        assert_eq!(cp.table_ctrl_idx, 0);
        assert_eq!(cp.row, 0);
        assert_eq!(cp.col, 0);
        assert_eq!(cp.inner_para_idx, 0);
    }

    /// 다중 경고 — 각각 기록됨
    #[test]
    fn validate_records_multiple_warnings() {
        let mut doc = Document::default();
        let mut section = Section::default();

        let mut p1 = Paragraph::default();
        p1.text = "a".to_string();
        // line_segs 비움

        let mut p2 = Paragraph::default();
        p2.text = "b".to_string();
        p2.line_segs.push(LineSeg::default()); // line_height=0

        section.paragraphs.push(p1);
        section.paragraphs.push(p2);
        doc.sections.push(section);

        let report = DocumentCore::validate_linesegs(&doc, true);
        assert_eq!(report.len(), 2);
        let summary = report.summary();
        assert_eq!(summary.get("lineseg 배열이 비어있음").copied(), Some(1));
        assert_eq!(
            summary
                .get("lineseg 가 미계산 상태 (line_height=0)")
                .copied(),
            Some(1)
        );
    }

    /// needs_reflow_broadly: 빈 line_segs + text → true
    #[test]
    fn needs_reflow_broadly_covers_empty_linesegs() {
        let mut para = Paragraph::default();
        para.text = "hello".to_string();
        // line_segs 비움
        assert!(DocumentCore::needs_reflow_broadly(&para));
    }

    /// needs_reflow_broadly: 기존 조건 (line_segs=1, line_height=0) → true
    #[test]
    fn needs_reflow_broadly_covers_uncomputed_lineseg() {
        let mut para = Paragraph::default();
        para.text = "hello".to_string();
        para.line_segs.push(LineSeg::default());
        assert!(DocumentCore::needs_reflow_broadly(&para));
    }

    /// needs_reflow_broadly: 정상 line_segs → false
    #[test]
    fn needs_reflow_broadly_skips_healthy_paragraph() {
        let mut para = Paragraph::default();
        para.text = "hello".to_string();
        let mut seg = LineSeg::default();
        seg.line_height = 1000;
        para.line_segs.push(seg);
        assert!(!DocumentCore::needs_reflow_broadly(&para));
    }

    /// needs_reflow_broadly: 빈 문단 (text 없음) → false
    #[test]
    fn needs_reflow_broadly_skips_empty_paragraph() {
        let para = Paragraph::default();
        assert!(!DocumentCore::needs_reflow_broadly(&para));
    }

    // ---------- R3: LinesegTextRunReflow ----------

    #[test]
    fn validate_detects_textrun_reflow_pattern() {
        // 긴 텍스트(40자 초과) + lineseg 1개 + '\n' 없음 → R3 경고
        let mut doc = Document::default();
        let mut section = Section::default();
        let mut para = Paragraph::default();
        para.text = "이것은 충분히 길어서 한 줄로 표시하기 어려운 한국어 문장입니다. 한컴은 textRun으로 reflow하지만 rhwp는 그대로 그립니다.".to_string();
        let mut seg = LineSeg::default();
        seg.line_height = 1000; // line_height 는 0 아님 → R2 는 해당 안 됨
        para.line_segs.push(seg);
        section.paragraphs.push(para);
        doc.sections.push(section);

        let report = DocumentCore::validate_linesegs(&doc, true);
        assert_eq!(report.len(), 1);
        assert_eq!(report.warnings[0].kind, WarningKind::LinesegTextRunReflow);
    }

    #[test]
    fn validate_skips_textrun_reflow_for_short_text() {
        // 짧은 텍스트(40자 이하) → R3 해당 안 됨
        let mut doc = Document::default();
        let mut section = Section::default();
        let mut para = Paragraph::default();
        para.text = "짧은 문장입니다.".to_string();
        let mut seg = LineSeg::default();
        seg.line_height = 1000;
        para.line_segs.push(seg);
        section.paragraphs.push(para);
        doc.sections.push(section);

        let report = DocumentCore::validate_linesegs(&doc, true);
        assert!(report.is_empty(), "짧은 문장은 경고 대상이 아님");
    }

    #[test]
    fn validate_skips_textrun_reflow_when_has_newline() {
        // 긴 텍스트라도 '\n' 이 있으면 이미 분할된 것으로 간주 → R3 해당 안 됨
        let mut doc = Document::default();
        let mut section = Section::default();
        let mut para = Paragraph::default();
        para.text =
            "충분히 긴 텍스트이지만 줄바꿈이 있습니다.\n그래서 R3은 해당하지 않아야 합니다."
                .to_string();
        let mut seg = LineSeg::default();
        seg.line_height = 1000;
        para.line_segs.push(seg);
        section.paragraphs.push(para);
        doc.sections.push(section);

        let report = DocumentCore::validate_linesegs(&doc, true);
        assert!(report.is_empty(), "\\n 있는 문단은 R3 해당 안 됨");
    }

    #[test]
    fn needs_reflow_broadly_skips_textrun_reflow() {
        let mut para = Paragraph::default();
        para.text = "이것은 충분히 길어서 한 줄로 표시하기 어려운 한국어 문장입니다. 한컴은 textRun으로 reflow하지만 rhwp는 그대로 그립니다.".to_string();
        let mut seg = LineSeg::default();
        seg.line_height = 1000;
        para.line_segs.push(seg);
        assert!(!DocumentCore::needs_reflow_broadly(&para));
    }

    #[test]
    fn matching_page_count_cannot_hide_structural_loss() {
        let before = HwpStructureCounts {
            text_count: 20,
            control_count: 3,
            object_count: 1,
            opaque_control_bytes: 48,
        };
        let after = HwpStructureCounts {
            control_count: 2,
            opaque_control_bytes: 0,
            ..before
        };

        assert!(
            !export_is_recovered(true, before, after, &[]),
            "same page count must not report recovery after control/payload loss"
        );
    }

    #[test]
    fn structure_counts_include_nested_text_controls_objects_and_opaque_bytes() {
        use crate::model::control::{Control, UnknownControl};
        use crate::model::document::RawRecord;
        use crate::model::table::{Cell, Table};

        let nested = Paragraph {
            text: "cell".to_string(),
            controls: vec![Control::Unknown(UnknownControl {
                ctrl_id: 0x1234_5678,
                raw_ctrl_data: vec![1, 2, 3],
                raw_child_records: vec![RawRecord {
                    tag_id: 99,
                    level: 1,
                    data: vec![4, 5],
                }],
            })],
            ..Default::default()
        };
        let root = Paragraph {
            text: "body".to_string(),
            controls: vec![Control::Table(Box::new(Table {
                cells: vec![Cell {
                    paragraphs: vec![nested],
                    ..Default::default()
                }],
                ..Default::default()
            }))],
            ..Default::default()
        };
        let document = Document {
            sections: vec![Section {
                paragraphs: vec![root],
                ..Default::default()
            }],
            ..Default::default()
        };

        let (counts, losses) = hwp_structure_counts(&document);
        assert_eq!(counts.text_count, 8);
        assert_eq!(counts.control_count, 2);
        assert_eq!(counts.object_count, 1);
        assert_eq!(counts.opaque_control_bytes, 5);
        assert!(losses.is_empty());
    }
}

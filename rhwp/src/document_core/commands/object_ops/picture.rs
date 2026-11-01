//! 그림 삽입/속성/crop native 명령 (object_ops 분할, #1904).

use super::MIN_SHAPE_SIZE;
use crate::document_core::helpers::{get_textbox_from_shape, get_textbox_from_shape_mut};
use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::control::Control;
use crate::model::event::DocumentEvent;
use crate::model::paragraph::Paragraph;
use crate::model::shape::{common_obj_offsets, ShapeObject};

impl DocumentCore {
    fn resolve_picture_control_ref(
        &self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
    ) -> Result<&crate::model::image::Picture, HwpError> {
        let section = self.document.sections.get(section_idx).ok_or_else(|| {
            HwpError::RenderError(format!("구역 인덱스 {} 범위 초과", section_idx))
        })?;

        let body_len = section.paragraphs.len();
        let para = if parent_para_idx < body_len {
            section.paragraphs.get(parent_para_idx).ok_or_else(|| {
                HwpError::RenderError(format!("문단 인덱스 {} 범위 초과", parent_para_idx))
            })?
        } else {
            let mut virtual_idx = parent_para_idx - body_len;
            let mut found = None;
            'outer: for body_para in &section.paragraphs {
                for ctrl in &body_para.controls {
                    if let Control::Endnote(en) = ctrl {
                        if virtual_idx < en.paragraphs.len() {
                            found = en.paragraphs.get(virtual_idx);
                            break 'outer;
                        }
                        virtual_idx -= en.paragraphs.len();
                    }
                }
            }
            found.ok_or_else(|| {
                HwpError::RenderError(format!("문단 인덱스 {} 범위 초과", parent_para_idx))
            })?
        };

        let ctrl = para.controls.get(control_idx).ok_or_else(|| {
            HwpError::RenderError(format!("컨트롤 인덱스 {} 범위 초과", control_idx))
        })?;
        match ctrl {
            Control::Picture(p) => Ok(p),
            Control::Shape(shape) => match shape.as_ref() {
                ShapeObject::Picture(p) => Ok(p),
                _ => Err(HwpError::RenderError(
                    "지정된 Shape 컨트롤이 그림이 아닙니다".to_string(),
                )),
            },
            _ => Err(HwpError::RenderError(
                "지정된 컨트롤이 그림이 아닙니다".to_string(),
            )),
        }
    }
    pub(crate) fn resolve_picture_control_mut(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
    ) -> Result<&mut crate::model::image::Picture, HwpError> {
        let section = self.document.sections.get_mut(section_idx).ok_or_else(|| {
            HwpError::RenderError(format!("구역 인덱스 {} 범위 초과", section_idx))
        })?;

        let body_len = section.paragraphs.len();
        let para = if parent_para_idx < body_len {
            section.paragraphs.get_mut(parent_para_idx).ok_or_else(|| {
                HwpError::RenderError(format!("문단 인덱스 {} 범위 초과", parent_para_idx))
            })?
        } else {
            let mut virtual_idx = parent_para_idx - body_len;
            let mut found = None;
            'outer: for body_para in &mut section.paragraphs {
                for ctrl in &mut body_para.controls {
                    if let Control::Endnote(en) = ctrl {
                        if virtual_idx < en.paragraphs.len() {
                            found = en.paragraphs.get_mut(virtual_idx);
                            break 'outer;
                        }
                        virtual_idx -= en.paragraphs.len();
                    }
                }
            }
            found.ok_or_else(|| {
                HwpError::RenderError(format!("문단 인덱스 {} 범위 초과", parent_para_idx))
            })?
        };

        let ctrl = para.controls.get_mut(control_idx).ok_or_else(|| {
            HwpError::RenderError(format!("컨트롤 인덱스 {} 범위 초과", control_idx))
        })?;
        match ctrl {
            Control::Picture(p) => Ok(p),
            Control::Shape(shape) => match shape.as_mut() {
                ShapeObject::Picture(p) => Ok(p),
                _ => Err(HwpError::RenderError(
                    "지정된 Shape 컨트롤이 그림이 아닙니다".to_string(),
                )),
            },
            _ => Err(HwpError::RenderError(
                "지정된 컨트롤이 그림이 아닙니다".to_string(),
            )),
        }
    }
    pub fn get_picture_properties_native(
        &self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
    ) -> Result<String, HwpError> {
        let pic = self.resolve_picture_control_ref(section_idx, parent_para_idx, control_idx)?;
        Self::format_picture_properties_json(pic)
    }
    fn picture_crop_extent_hu(pic: &crate::model::image::Picture) -> (i32, i32) {
        let width = if pic.shape_attr.original_width > 0 {
            pic.shape_attr.original_width
        } else {
            pic.shape_attr.current_width
        };
        let height = if pic.shape_attr.original_height > 0 {
            pic.shape_attr.original_height
        } else {
            pic.shape_attr.current_height
        };
        (
            i32::try_from(width).unwrap_or(i32::MAX),
            i32::try_from(height).unwrap_or(i32::MAX),
        )
    }
    fn picture_crop_ui_amounts(pic: &crate::model::image::Picture) -> (i32, i32, i32, i32) {
        let (extent_w, extent_h) = Self::picture_crop_extent_hu(pic);
        let left = pic.crop.left.max(0);
        let top = pic.crop.top.max(0);
        let right = if extent_w > 0 && pic.crop.right > left {
            (extent_w - pic.crop.right).max(0)
        } else {
            0
        };
        let bottom = if extent_h > 0 && pic.crop.bottom > top {
            (extent_h - pic.crop.bottom).max(0)
        } else {
            0
        };
        (left, top, right, bottom)
    }
    fn set_picture_crop_from_ui_amounts(
        pic: &mut crate::model::image::Picture,
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    ) {
        let (extent_w, extent_h) = Self::picture_crop_extent_hu(pic);
        pic.crop.left = left.max(0);
        pic.crop.top = top.max(0);
        if extent_w > 0 {
            pic.crop.right = (extent_w - right.max(0)).max(pic.crop.left);
        } else {
            pic.crop.right = right.max(0);
        }
        if extent_h > 0 {
            pic.crop.bottom = (extent_h - bottom.max(0)).max(pic.crop.top);
        } else {
            pic.crop.bottom = bottom.max(0);
        }
    }
    /// 변환 파생 상태(`raw_rendering`·render_*)의 무효화 판정 근거 — 도형 경로와 공용.
    fn picture_transform_fingerprint(
        pic: &crate::model::image::Picture,
    ) -> (u32, u32, u32, u32, u32, u32, i16, bool, bool) {
        super::common::shape_transform_fingerprint(&pic.common, &pic.shape_attr)
    }
    pub(crate) fn picture_rotated_bounds(width: u32, height: u32, angle: i16) -> (u32, u32) {
        if width == 0 || height == 0 || angle.rem_euclid(360) == 0 {
            return (width, height);
        }

        let theta = (angle as f64).to_radians();
        let cos = theta.cos().abs();
        let sin = theta.sin().abs();
        let rotated_width = width as f64 * cos + height as f64 * sin;
        let rotated_height = width as f64 * sin + height as f64 * cos;
        (
            rotated_width.round().max(1.0) as u32,
            rotated_height.round().max(1.0) as u32,
        )
    }
    fn refresh_picture_rotation_layout_for_save(pic: &mut crate::model::image::Picture) {
        let cur_w = if pic.shape_attr.current_width > 0 {
            pic.shape_attr.current_width
        } else {
            pic.common.width
        };
        let cur_h = if pic.shape_attr.current_height > 0 {
            pic.shape_attr.current_height
        } else {
            pic.common.height
        };

        if cur_w == 0 || cur_h == 0 {
            return;
        }

        pic.shape_attr.current_width = cur_w;
        pic.shape_attr.current_height = cur_h;

        let old_center_x =
            pic.common.horizontal_offset as i32 as i64 + (pic.common.width as i64 / 2);
        let old_center_y =
            pic.common.vertical_offset as i32 as i64 + (pic.common.height as i64 / 2);
        let (bbox_w, bbox_h) =
            Self::picture_rotated_bounds(cur_w, cur_h, pic.shape_attr.rotation_angle);

        if pic.shape_attr.rotation_angle.rem_euclid(360) != 0 {
            pic.common.width = bbox_w;
            pic.common.height = bbox_h;
            pic.common.horizontal_offset = (old_center_x - (bbox_w as i64 / 2)) as i32 as u32;
            pic.common.vertical_offset = (old_center_y - (bbox_h as i64 / 2)) as i32 as u32;
        } else {
            pic.common.width = cur_w;
            pic.common.height = cur_h;
            pic.common.horizontal_offset = (old_center_x - (cur_w as i64 / 2)) as i32 as u32;
            pic.common.vertical_offset = (old_center_y - (cur_h as i64 / 2)) as i32 as u32;
        }

        pic.shape_attr.rotation_center.x = (pic.common.width / 2) as i32;
        pic.shape_attr.rotation_center.y = (pic.common.height / 2) as i32;
        pic.shape_attr.rotate_image = true;
        pic.shape_attr.flip |= 0x0008_0000;
    }
    fn apply_picture_display_width(pic: &mut crate::model::image::Picture, width: u32) {
        let old_common_width = pic.common.width;
        let old_current_width = pic.shape_attr.current_width;
        pic.common.width = width;
        if pic.shape_attr.rotation_angle.rem_euclid(360) != 0
            && old_common_width > 0
            && old_current_width > 0
        {
            pic.shape_attr.current_width =
                ((old_current_width as f64 * width as f64 / old_common_width as f64).round())
                    .max(1.0) as u32;
        } else {
            pic.shape_attr.current_width = width;
        }
    }
    fn apply_picture_display_height(pic: &mut crate::model::image::Picture, height: u32) {
        let old_common_height = pic.common.height;
        let old_current_height = pic.shape_attr.current_height;
        pic.common.height = height;
        if pic.shape_attr.rotation_angle.rem_euclid(360) != 0
            && old_common_height > 0
            && old_current_height > 0
        {
            pic.shape_attr.current_height =
                ((old_current_height as f64 * height as f64 / old_common_height as f64).round())
                    .max(1.0) as u32;
        } else {
            pic.shape_attr.current_height = height;
        }
    }
    /// [Task #825] 머리말/꼬리말 안 그림의 속성 조회.
    /// path: section[si].paragraphs[outer_para].controls[outer_ctrl] = Header/Footer
    ///       → .paragraphs[inner_para].controls[inner_ctrl] = Picture
    pub fn get_header_footer_picture_properties_native(
        &self,
        section_idx: usize,
        outer_para_idx: usize,
        outer_control_idx: usize,
        inner_para_idx: usize,
        inner_control_idx: usize,
    ) -> Result<String, HwpError> {
        let section = self.document.sections.get(section_idx).ok_or_else(|| {
            HwpError::RenderError(format!("구역 인덱스 {} 범위 초과", section_idx))
        })?;
        let outer_para = section.paragraphs.get(outer_para_idx).ok_or_else(|| {
            HwpError::RenderError(format!("외부 문단 인덱스 {} 범위 초과", outer_para_idx))
        })?;
        let outer_ctrl = outer_para.controls.get(outer_control_idx).ok_or_else(|| {
            HwpError::RenderError(format!(
                "외부 컨트롤 인덱스 {} 범위 초과",
                outer_control_idx
            ))
        })?;

        let inner_paras: &[crate::model::paragraph::Paragraph] = match outer_ctrl {
            crate::model::control::Control::Header(h) => &h.paragraphs,
            crate::model::control::Control::Footer(f) => &f.paragraphs,
            _ => {
                return Err(HwpError::RenderError(
                    "외부 컨트롤이 머리말/꼬리말이 아닙니다".to_string(),
                ))
            }
        };

        let inner_para = inner_paras.get(inner_para_idx).ok_or_else(|| {
            HwpError::RenderError(format!("내부 문단 인덱스 {} 범위 초과", inner_para_idx))
        })?;
        let inner_ctrl = inner_para.controls.get(inner_control_idx).ok_or_else(|| {
            HwpError::RenderError(format!(
                "내부 컨트롤 인덱스 {} 범위 초과",
                inner_control_idx
            ))
        })?;

        let pic = match inner_ctrl {
            crate::model::control::Control::Picture(p) => p,
            _ => {
                return Err(HwpError::RenderError(
                    "지정된 내부 컨트롤이 그림이 아닙니다".to_string(),
                ))
            }
        };
        Self::format_picture_properties_json(pic)
    }
    pub(crate) fn format_picture_properties_json(
        pic: &crate::model::image::Picture,
    ) -> Result<String, HwpError> {
        let c = &pic.common;
        let vert_rel = match c.vert_rel_to {
            crate::model::shape::VertRelTo::Paper => "Paper",
            crate::model::shape::VertRelTo::Page => "Page",
            crate::model::shape::VertRelTo::Para => "Para",
        };
        let vert_align = match c.vert_align {
            crate::model::shape::VertAlign::Top => "Top",
            crate::model::shape::VertAlign::Center => "Center",
            crate::model::shape::VertAlign::Bottom => "Bottom",
            crate::model::shape::VertAlign::Inside => "Inside",
            crate::model::shape::VertAlign::Outside => "Outside",
        };
        let horz_rel = match c.horz_rel_to {
            crate::model::shape::HorzRelTo::Paper => "Paper",
            crate::model::shape::HorzRelTo::Page => "Page",
            crate::model::shape::HorzRelTo::Column => "Column",
            crate::model::shape::HorzRelTo::Para => "Para",
        };
        let horz_align = match c.horz_align {
            crate::model::shape::HorzAlign::Left => "Left",
            crate::model::shape::HorzAlign::Center => "Center",
            crate::model::shape::HorzAlign::Right => "Right",
            crate::model::shape::HorzAlign::Inside => "Inside",
            crate::model::shape::HorzAlign::Outside => "Outside",
        };
        let text_wrap = match c.text_wrap {
            crate::model::shape::TextWrap::Square => "Square",
            crate::model::shape::TextWrap::Tight => "Tight",
            crate::model::shape::TextWrap::Through => "Through",
            crate::model::shape::TextWrap::TopAndBottom => "TopAndBottom",
            crate::model::shape::TextWrap::BehindText => "BehindText",
            crate::model::shape::TextWrap::InFrontOfText => "InFrontOfText",
        };
        let effect = match pic.image_attr.effect {
            crate::model::image::ImageEffect::RealPic => "RealPic",
            crate::model::image::ImageEffect::GrayScale => "GrayScale",
            crate::model::image::ImageEffect::BlackWhite => "BlackWhite",
            crate::model::image::ImageEffect::Pattern8x8 => "Pattern8x8",
        };
        // description 내 JSON 제어 문자 이스케이프
        let desc_escaped = crate::document_core::helpers::json_escape(&c.description);
        // 그림 대화상자에 HWP3 외부 그림 경로를 표시한다.
        let external_path_field = match &pic.image_attr.external_path {
            Some(p) => format!(
                ",\"externalPath\":\"{}\"",
                crate::document_core::helpers::json_escape(p)
            ),
            None => String::new(),
        };

        let sa = &pic.shape_attr;
        let (crop_left, crop_top, crop_right, crop_bottom) = Self::picture_crop_ui_amounts(pic);

        Ok(format!(
            concat!(
                "{{\"width\":{},\"height\":{},\"treatAsChar\":{},",
                "\"vertRelTo\":\"{}\",\"vertAlign\":\"{}\",",
                "\"horzRelTo\":\"{}\",\"horzAlign\":\"{}\",",
                "\"vertOffset\":{},\"horzOffset\":{},",
                "\"textWrap\":\"{}\",\"restrictInPage\":{},\"allowOverlap\":{},\"sizeProtect\":{},",
                "\"brightness\":{},\"contrast\":{},\"effect\":\"{}\",\"transparency\":{},",
                "\"description\":\"{}\",",
                // 회전/대칭
                "\"rotationAngle\":{},\"horzFlip\":{},\"vertFlip\":{},",
                // 원본 크기
                "\"originalWidth\":{},\"originalHeight\":{},",
                // 자르기
                "\"cropLeft\":{},\"cropTop\":{},\"cropRight\":{},\"cropBottom\":{},",
                // 안쪽 여백 (그림 여백)
                "\"paddingLeft\":{},\"paddingTop\":{},\"paddingRight\":{},\"paddingBottom\":{},",
                // 바깥 여백
                "\"outerMarginLeft\":{},\"outerMarginTop\":{},\"outerMarginRight\":{},\"outerMarginBottom\":{},",
                // 테두리
                "\"borderColor\":{},\"borderWidth\":{},",
                // 캡션
                "\"hasCaption\":{},\"captionDirection\":\"{}\",\"captionVertAlign\":\"{}\",",
                "\"captionWidth\":{},\"captionSpacing\":{},\"captionMaxWidth\":{},\"captionIncludeMargin\":{}{}}}"
            ),
            c.width, c.height, c.treat_as_char,
            vert_rel, vert_align,
            horz_rel, horz_align,
            c.vertical_offset as i32, c.horizontal_offset as i32,
            text_wrap, c.flow_with_text, c.allow_overlap, c.size_protect,
            pic.image_attr.brightness,
            pic.image_attr.contrast,
            effect,
            pic.image_attr.clamped_transparency(),
            desc_escaped,
            // 회전/대칭
            sa.rotation_angle, sa.horz_flip, sa.vert_flip,
            // 원본 크기
            sa.original_width, sa.original_height,
            // 자르기
            crop_left, crop_top, crop_right, crop_bottom,
            // 안쪽 여백
            pic.padding.left, pic.padding.top, pic.padding.right, pic.padding.bottom,
            // 바깥 여백
            c.margin.left, c.margin.top, c.margin.right, c.margin.bottom,
            // 테두리
            pic.border_color, pic.border_width,
            // 캡션
            pic.caption.is_some(),
            pic.caption.as_ref().map_or("Bottom", |cap| match cap.direction {
                crate::model::shape::CaptionDirection::Left => "Left",
                crate::model::shape::CaptionDirection::Right => "Right",
                crate::model::shape::CaptionDirection::Top => "Top",
                crate::model::shape::CaptionDirection::Bottom => "Bottom",
            }),
            pic.caption.as_ref().map_or("Top", |cap| match cap.vert_align {
                crate::model::shape::CaptionVertAlign::Top => "Top",
                crate::model::shape::CaptionVertAlign::Center => "Center",
                crate::model::shape::CaptionVertAlign::Bottom => "Bottom",
            }),
            pic.caption.as_ref().map_or(0u32, |cap| cap.width),
            pic.caption.as_ref().map_or(0i16, |cap| cap.spacing),
            pic.caption.as_ref().map_or(0u32, |cap| cap.max_width),
            pic.caption.as_ref().map_or(false, |cap| cap.include_margin),
            external_path_field,
        ))
    }
    /// 그림 컨트롤의 속성을 변경한다 (네이티브).
    pub fn set_picture_properties_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        props_json: &str,
    ) -> Result<String, HwpError> {
        // JSON 파싱 (serde_json 사용 대신 수동 파싱 — 기존 패턴)
        // [Task #825] 픽쳐 속성 mutation 은 helper 로 분리 (머리말/꼬리말 path 와 공유).
        let (
            caption_created,
            caption_removed,
            should_migrate_to_inline,
            should_migrate_to_floating,
        ) = {
            let pic =
                self.resolve_picture_control_mut(section_idx, parent_para_idx, control_idx)?;
            // [Task #1151 v2] tac false→true migration 검출용 snapshot.
            let was_tac = pic.common.treat_as_char;
            let had_caption = pic.caption.is_some();
            let caption_created = Self::apply_picture_props_inner(pic, props_json);
            let now_tac = pic.common.treat_as_char;
            (
                caption_created,
                had_caption && pic.caption.is_none(),
                !was_tac && now_tac,
                was_tac && !now_tac,
            )
        };

        // [Task #1151 v2] floating → inline migration (H1 정합, samples/tac-verify/).
        // 한컴 산출물 Scenario A~D 분석: tac false→true 시 picture 의 control 위치는
        // 불변이고, 4 필드만 갱신 (treat_as_char / h/v_rel_to=Para / h/v_offset=0 /
        // parent line_segs[0]). text/char_offsets/paragraph 수 변화 없음.
        let mut reflow_text_para_after_floating = false;
        if should_migrate_to_inline || should_migrate_to_floating {
            let section = self.document.sections.get_mut(section_idx).ok_or_else(|| {
                HwpError::RenderError(format!("구역 인덱스 {} 범위 초과", section_idx))
            })?;
            let body_len = section.paragraphs.len();
            let para = if parent_para_idx < body_len {
                section.paragraphs.get_mut(parent_para_idx).ok_or_else(|| {
                    HwpError::RenderError(format!("문단 인덱스 {} 범위 초과", parent_para_idx))
                })?
            } else {
                let mut virtual_idx = parent_para_idx - body_len;
                let mut found = None;
                'outer: for body_para in &mut section.paragraphs {
                    for ctrl in &mut body_para.controls {
                        if let Control::Endnote(en) = ctrl {
                            if virtual_idx < en.paragraphs.len() {
                                found = en.paragraphs.get_mut(virtual_idx);
                                break 'outer;
                            }
                            virtual_idx -= en.paragraphs.len();
                        }
                    }
                }
                found.ok_or_else(|| {
                    HwpError::RenderError(format!("문단 인덱스 {} 범위 초과", parent_para_idx))
                })?
            };
            if should_migrate_to_inline {
                let crate::model::paragraph::Paragraph {
                    line_segs,
                    controls,
                    ..
                } = &mut *para;
                match controls.get_mut(control_idx) {
                    Some(Control::Picture(pic_box)) => {
                        Self::migrate_picture_floating_to_inline(line_segs, pic_box.as_mut());
                    }
                    Some(Control::Shape(shape)) => {
                        if let ShapeObject::Picture(pic) = shape.as_mut() {
                            Self::migrate_picture_floating_to_inline(line_segs, pic);
                        }
                    }
                    _ => {}
                }
            } else if para.text.is_empty() && para.char_offsets.is_empty() {
                Self::migrate_empty_picture_para_inline_to_floating(para);
            } else if !para.text.is_empty() && parent_para_idx < body_len {
                // 텍스트가 있는 문단: false→true 마이그레이션이 line_segs[0] 를
                // 그림 높이로 키워 놓았으므로, 그림이 inline 흐름에서 빠지는 시점에
                // 남은 인라인 콘텐츠 기준으로 재계산해야 한다. 그림 삭제 경로
                // (reflow_paragraph_line_segs_after_control_delete) 와 동일한 원리.
                // paragraph &mut borrow 가 끝난 뒤 reflow_paragraph 로 수행.
                // 텍스트 없이 컨트롤 문자만 있는 문단(표 문단 등)은 기존 동작 유지.
                reflow_text_para_after_floating = true;
            }
        }
        if reflow_text_para_after_floating {
            // [Task #2299] 리셋 판별용 — reflow 이전 저장 흐름 end 캡처.
            let stored_end_for_reset = crate::renderer::composer::paragraph_flow_end(
                &self.document.sections[section_idx].paragraphs[parent_para_idx],
            );
            self.reflow_paragraph(section_idx, parent_para_idx);
            let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
            crate::renderer::composer::recalculate_section_vpos(
                &mut self.document.sections[section_idx].paragraphs,
                parent_para_idx,
                None,
                stored_end_for_reset,
                &self.styles,
                self.dpi,
                doc_hwp3_layout,
            );
        }
        // 캡션 생성/삭제 시 AutoNumber 재할당. 생성 path 는 문단 placeholder 도 보강한다.
        if caption_created || caption_removed {
            crate::parser::assign_auto_numbers(&mut self.document);
        }
        if caption_created {
            let pic_mut =
                self.resolve_picture_control_mut(section_idx, parent_para_idx, control_idx)?;
            let para = &mut pic_mut.caption.as_mut().unwrap().paragraphs[0];
            para.text = "그림  ".to_string();
            para.char_offsets = vec![0, 1, 2, 11];
            para.char_count = 13;
        }
        // 리플로우
        let section = &mut self.document.sections[section_idx];
        section.raw_stream = None;
        self.recompose_section(section_idx);
        self.paginate_if_needed();
        // [Task #1151 v5] page tree cache invalidate — 다른 picture/shape setter (셀 shape
        // by_path / 셀 picture by_path / header-footer picture / shape 등) 모두 호출하나
        // 본 본문 picture setter 만 누락되어 있어 studio 가 stale page tree 반환 → tac toggle
        // 후 시각 변화 없음 증상의 root cause.
        self.invalidate_page_tree_cache();
        self.event_log.push(DocumentEvent::PictureResized {
            section: section_idx,
            para: parent_para_idx,
            ctrl: control_idx,
        });
        if caption_created {
            let char_offset = self
                .resolve_picture_control_ref(section_idx, parent_para_idx, control_idx)?
                .caption
                .as_ref()
                .map_or(0, |c| {
                    c.paragraphs.first().map_or(0, |p| p.text.chars().count())
                });
            Ok(format!(
                "{{\"ok\":true,\"captionCharOffset\":{}}}",
                char_offset
            ))
        } else {
            Ok("{\"ok\":true}".to_string())
        }
    }
    /// [Task #825] 머리말/꼬리말 안 그림 속성 변경.
    /// path: section[si].paragraphs[outer_para].controls[outer_ctrl] = Header/Footer
    ///       → .paragraphs[inner_para].controls[inner_ctrl] = Picture
    /// 캡션 신규 생성은 본 함수에서 미지원 (현 dialog UI 가 머리말 picture 캡션
    /// 변경을 노출하지 않음). caption_created 검출 시 NotSupported 에러.
    pub fn set_header_footer_picture_properties_native(
        &mut self,
        section_idx: usize,
        outer_para_idx: usize,
        outer_control_idx: usize,
        inner_para_idx: usize,
        inner_control_idx: usize,
        props_json: &str,
    ) -> Result<String, HwpError> {
        let caption_created;
        {
            let section = self.document.sections.get_mut(section_idx).ok_or_else(|| {
                HwpError::RenderError(format!("구역 인덱스 {} 범위 초과", section_idx))
            })?;
            let outer_para = section.paragraphs.get_mut(outer_para_idx).ok_or_else(|| {
                HwpError::RenderError(format!("외부 문단 인덱스 {} 범위 초과", outer_para_idx))
            })?;
            let outer_ctrl = outer_para
                .controls
                .get_mut(outer_control_idx)
                .ok_or_else(|| {
                    HwpError::RenderError(format!(
                        "외부 컨트롤 인덱스 {} 범위 초과",
                        outer_control_idx
                    ))
                })?;
            let inner_paras: &mut Vec<crate::model::paragraph::Paragraph> = match outer_ctrl {
                crate::model::control::Control::Header(h) => &mut h.paragraphs,
                crate::model::control::Control::Footer(f) => &mut f.paragraphs,
                _ => {
                    return Err(HwpError::RenderError(
                        "외부 컨트롤이 머리말/꼬리말이 아닙니다".to_string(),
                    ))
                }
            };
            let inner_para = inner_paras.get_mut(inner_para_idx).ok_or_else(|| {
                HwpError::RenderError(format!("내부 문단 인덱스 {} 범위 초과", inner_para_idx))
            })?;
            let inner_ctrl = inner_para
                .controls
                .get_mut(inner_control_idx)
                .ok_or_else(|| {
                    HwpError::RenderError(format!(
                        "내부 컨트롤 인덱스 {} 범위 초과",
                        inner_control_idx
                    ))
                })?;
            let pic = match inner_ctrl {
                crate::model::control::Control::Picture(p) => p,
                _ => {
                    return Err(HwpError::RenderError(
                        "지정된 내부 컨트롤이 그림이 아닙니다".to_string(),
                    ))
                }
            };
            // [Task #1151 v2] 본문 picture setter(set_picture_properties_native) 와 동일하게,
            // treatAsChar false→true/true→false 전환 시 앵커 문단의 line_segs 도 갱신해야
            // 한다. 머리말/꼬리말 경로는 이 마이그레이션이 누락되어 있었음 — tac on 시
            // 그림 높이가 줄 높이에 반영되지 않아 렌더 시 그림이 겹치거나 잘림.
            let was_tac = pic.common.treat_as_char;
            caption_created = Self::apply_picture_props_inner(pic, props_json);
            let now_tac = pic.common.treat_as_char;
            if !was_tac && now_tac {
                if let crate::model::control::Control::Picture(pic_box) =
                    &mut inner_para.controls[inner_control_idx]
                {
                    Self::migrate_picture_floating_to_inline(
                        &mut inner_para.line_segs,
                        pic_box.as_mut(),
                    );
                }
            } else if was_tac && !now_tac {
                Self::migrate_empty_picture_para_inline_to_floating(inner_para);
            }
        }
        if caption_created {
            return Err(HwpError::RenderError(
                "머리말/꼬리말 그림에 캡션 신규 생성은 본 버전에서 지원하지 않습니다".to_string(),
            ));
        }
        let section = &mut self.document.sections[section_idx];
        section.raw_stream = None;
        self.recompose_section(section_idx);
        self.paginate_if_needed();
        self.event_log.push(DocumentEvent::PictureResized {
            section: section_idx,
            para: outer_para_idx,
            ctrl: outer_control_idx,
        });
        Ok("{\"ok\":true}".to_string())
    }
    /// [Task #1151 v2] Floating picture → inline 마이그레이션 (H1 정합).
    ///
    /// 한컴 2022 산출물 (`samples/tac-verify/scenario-{a,b,c,d}-after.hwp`) 분석
    /// 결과: floating picture 의 `treat_as_char` 가 false→true 로 토글될 때
    /// 한컴은 다음만 갱신한다.
    ///
    /// Picture 자체: `horz_rel_to = Para`, `vert_rel_to = Para`,
    /// `horizontal_offset = 0`, `vertical_offset = 0`. (`treat_as_char = true` 와 attr
    /// 비트는 `apply_picture_props_inner` 가 이미 처리.)
    ///
    /// Parent paragraph 의 `line_segs[0]`: `line_height = picture.common.height`,
    /// `text_height = picture.common.height`, `baseline_distance = round(line_height × 0.85)`.
    /// 비율 0.85 는 한컴 산출물 4 시나리오 (5331/16038/4847/19019) 모두 정확 관찰.
    /// `line_segs` 가 비어있으면 신설 (line_spacing=600 기본).
    ///
    /// 변경 없음: paragraph.text / char_offsets / char_shapes / paragraph 수, picture
    /// control 의 paragraph 위치 (sentinel char 추가하지 않음, 셀 안 이동 / 새 paragraph
    /// 분리 모두 없음 — H1 정합).
    pub(crate) fn migrate_picture_floating_to_inline(
        line_segs: &mut Vec<crate::model::paragraph::LineSeg>,
        pic: &mut crate::model::image::Picture,
    ) {
        use crate::model::shape::{HorzRelTo, VertRelTo};
        pic.common.horz_rel_to = HorzRelTo::Para;
        pic.common.vert_rel_to = VertRelTo::Para;
        pic.common.horizontal_offset = 0;
        pic.common.vertical_offset = 0;

        let picture_height_hu = pic.common.height as i32;
        let baseline = (picture_height_hu as f64 * 0.85).round() as i32;
        if let Some(seg) = line_segs.first_mut() {
            seg.line_height = picture_height_hu;
            seg.text_height = picture_height_hu;
            seg.baseline_distance = baseline;
        } else {
            line_segs.push(crate::model::paragraph::LineSeg {
                line_height: picture_height_hu,
                text_height: picture_height_hu,
                baseline_distance: baseline,
                line_spacing: 600,
                ..Default::default()
            });
        }
    }
    /// TAC 그림을 자리차지 개체로 되돌릴 때, 텍스트 없는 그림 전용 문단의
    /// LINE_SEG를 남은 TAC 개체 수에 맞춰 재구성한다.
    ///
    /// 기존 false→true 마이그레이션은 첫 LINE_SEG를 그림 높이로 키운다. 반대로
    /// true→false가 되면 그 그림은 더 이상 inline 글자 슬롯이 아니므로, 같은
    /// 문단의 남은 TAC 그림만 빈 줄에 1개씩 매핑되어야 한다. 한컴 저장본
    /// `투명도0-50-2nd그림글차처럼off.hwp`처럼 TopAndBottom 예약 높이는 첫 TAC
    /// 줄의 `vertical_pos`에 반영한다.
    pub(crate) fn migrate_empty_picture_para_inline_to_floating(
        para: &mut crate::model::paragraph::Paragraph,
    ) {
        if !para.text.is_empty() || !para.char_offsets.is_empty() {
            return;
        }

        let old_seg = para.line_segs.first().cloned().unwrap_or_default();
        let line_spacing = if old_seg.line_spacing > 0 {
            old_seg.line_spacing
        } else {
            600
        };
        let reserved_hu = Self::topbottom_reserved_height_for_empty_picture_para(&para.controls);
        let tac_heights = para
            .controls
            .iter()
            .filter_map(Self::tac_control_height_for_empty_picture_para)
            .collect::<Vec<_>>();

        if tac_heights.is_empty() {
            para.line_segs = vec![crate::model::paragraph::LineSeg {
                text_start: 0,
                vertical_pos: reserved_hu,
                line_height: 1000,
                text_height: 1000,
                baseline_distance: 850,
                line_spacing,
                segment_width: old_seg.segment_width,
                column_start: old_seg.column_start,
                tag: old_seg.tag,
            }];
            return;
        }

        let mut vpos = reserved_hu;
        let mut rebuilt = Vec::with_capacity(tac_heights.len());
        for (idx, height) in tac_heights.into_iter().enumerate() {
            let line_height = height.max(1);
            rebuilt.push(crate::model::paragraph::LineSeg {
                text_start: (idx as u32) * 8,
                vertical_pos: vpos,
                line_height,
                text_height: line_height,
                baseline_distance: (line_height as f64 * 0.85).round() as i32,
                line_spacing,
                segment_width: old_seg.segment_width,
                column_start: old_seg.column_start,
                tag: old_seg.tag,
            });
            vpos += line_height + line_spacing;
        }
        para.line_segs = rebuilt;
    }
    fn tac_control_height_for_empty_picture_para(ctrl: &Control) -> Option<i32> {
        match ctrl {
            Control::Picture(pic) if pic.common.treat_as_char => Some(pic.common.height as i32),
            Control::Shape(shape) if shape.common().treat_as_char => {
                let common_h = shape.common().height as i32;
                let current_h = shape.shape_attr().current_height as i32;
                Some(common_h.max(current_h))
            }
            Control::Table(table) if table.common.treat_as_char => Some(table.common.height as i32),
            Control::Equation(eq) if eq.common.treat_as_char => Some(eq.common.height as i32),
            _ => None,
        }
    }
    fn topbottom_reserved_height_for_empty_picture_para(controls: &[Control]) -> i32 {
        controls
            .iter()
            .map(|ctrl| match ctrl {
                Control::Picture(pic)
                    if !pic.common.treat_as_char
                        && matches!(
                            pic.common.text_wrap,
                            crate::model::shape::TextWrap::TopAndBottom
                        ) =>
                {
                    pic.common.height as i32
                        + pic.common.margin.top as i32
                        + pic.common.margin.bottom as i32
                }
                Control::Shape(shape)
                    if !shape.common().treat_as_char
                        && matches!(
                            shape.common().text_wrap,
                            crate::model::shape::TextWrap::TopAndBottom
                        ) =>
                {
                    let common = shape.common();
                    common.height as i32 + common.margin.top as i32 + common.margin.bottom as i32
                }
                Control::Table(table)
                    if !table.common.treat_as_char
                        && matches!(
                            table.common.text_wrap,
                            crate::model::shape::TextWrap::TopAndBottom
                        ) =>
                {
                    table.common.height as i32
                        + table.outer_margin_top as i32
                        + table.outer_margin_bottom as i32
                }
                _ => 0,
            })
            .sum()
    }
    pub(crate) fn take_place_picture_flow_offset(
        pic: &crate::model::image::Picture,
    ) -> Option<i32> {
        if pic.common.treat_as_char
            || !matches!(
                pic.common.text_wrap,
                crate::model::shape::TextWrap::TopAndBottom
            )
            || !matches!(pic.common.vert_rel_to, crate::model::shape::VertRelTo::Para)
        {
            return None;
        }

        let visual_height = if pic.shape_attr.rotation_angle.rem_euclid(360) != 0
            && pic.shape_attr.current_width > 0
            && pic.shape_attr.current_height > 0
        {
            pic.common.height
        } else {
            let (_, height) = Self::picture_rotated_bounds(
                pic.common.width,
                pic.common.height,
                pic.shape_attr.rotation_angle,
            );
            height
        };
        Some(
            (pic.common.vertical_offset as i32)
                .saturating_add(visual_height.min(i32::MAX as u32) as i32)
                .max(0),
        )
    }
    /// [Task #825] Picture 속성 JSON 적용 (mutation only). 후처리 (AutoNumber /
    /// recompose / paginate / event log) 는 호출자 책임.
    /// 반환: caption_created (true 면 호출자가 AutoNumber 후처리 필요).
    pub(crate) fn apply_picture_props_inner(
        pic: &mut crate::model::image::Picture,
        props_json: &str,
    ) -> bool {
        use crate::document_core::helpers::{json_bool, json_i16, json_i32, json_str, json_u32};

        let transform_before = Self::picture_transform_fingerprint(pic);
        let mut rotation_changed = false;

        // 크기 변경 — [#6806] 키가 있어도 값이 같으면 건드리지 않는다. 종전에는 게터가 낸
        // 봉지를 그대로 되먹여도 `current_*` 가 `common.*` 로 덮여(파싱값이 1 어긋난 문서가
        // corpus 에 69건) 지문이 흔들리고 한컴 원본 렌더링 행렬이 지워졌다.
        if let Some(w) = json_u32(props_json, "width") {
            if w != pic.common.width {
                Self::apply_picture_display_width(pic, w);
            }
        }
        if let Some(h) = json_u32(props_json, "height") {
            if h != pic.common.height {
                Self::apply_picture_display_height(pic, h);
            }
        }

        // 위치 속성
        if let Some(tac) = json_bool(props_json, "treatAsChar") {
            pic.common.treat_as_char = tac;
            // attr 비트 갱신
            if tac {
                pic.common.attr |= 0x01;
            } else {
                pic.common.attr &= !0x01;
            }
        }
        if let Some(v) = json_str(props_json, "vertRelTo") {
            pic.common.vert_rel_to = match v.as_str() {
                "Paper" => crate::model::shape::VertRelTo::Paper,
                "Page" => crate::model::shape::VertRelTo::Page,
                "Para" => crate::model::shape::VertRelTo::Para,
                _ => pic.common.vert_rel_to,
            };
        }
        if let Some(v) = json_str(props_json, "horzRelTo") {
            pic.common.horz_rel_to = match v.as_str() {
                "Paper" => crate::model::shape::HorzRelTo::Paper,
                "Page" => crate::model::shape::HorzRelTo::Page,
                "Column" => crate::model::shape::HorzRelTo::Column,
                "Para" => crate::model::shape::HorzRelTo::Para,
                _ => pic.common.horz_rel_to,
            };
        }
        if let Some(v) = json_str(props_json, "vertAlign") {
            pic.common.vert_align = match v.as_str() {
                "Top" => crate::model::shape::VertAlign::Top,
                "Center" => crate::model::shape::VertAlign::Center,
                "Bottom" => crate::model::shape::VertAlign::Bottom,
                _ => pic.common.vert_align,
            };
        }
        if let Some(v) = json_str(props_json, "horzAlign") {
            pic.common.horz_align = match v.as_str() {
                "Left" => crate::model::shape::HorzAlign::Left,
                "Center" => crate::model::shape::HorzAlign::Center,
                "Right" => crate::model::shape::HorzAlign::Right,
                _ => pic.common.horz_align,
            };
        }
        if let Some(v) = json_str(props_json, "textWrap") {
            pic.common.text_wrap = match v.as_str() {
                "Square" => crate::model::shape::TextWrap::Square,
                "Tight" => crate::model::shape::TextWrap::Tight,
                "Through" => crate::model::shape::TextWrap::Through,
                "TopAndBottom" => crate::model::shape::TextWrap::TopAndBottom,
                "BehindText" => crate::model::shape::TextWrap::BehindText,
                "InFrontOfText" => crate::model::shape::TextWrap::InFrontOfText,
                _ => pic.common.text_wrap,
            };
        }
        // [#6806] 「쪽 영역 안으로 제한」과 「서로 겹침 허용」은 독립이다 — common.rs 의
        // apply_common_obj_attr_from_json 과 같은 불변식(그림은 이 플래그를 여기서 직접 다룬다).
        if let Some(v) = json_bool(props_json, "restrictInPage") {
            pic.common.flow_with_text = v;
            if v {
                pic.common.attr |= 1 << 13;
            } else {
                pic.common.attr &= !(1 << 13);
            }
        }
        if let Some(v) = json_bool(props_json, "allowOverlap") {
            pic.common.allow_overlap = v;
            if v {
                pic.common.attr |= 1 << 14;
            } else {
                pic.common.attr &= !(1 << 14);
            }
        }
        if let Some(v) = json_bool(props_json, "sizeProtect") {
            pic.common.size_protect = v;
            if v {
                pic.common.attr |= 1 << 20;
            } else {
                pic.common.attr &= !(1 << 20);
            }
        }
        if let Some(v) = json_i32(props_json, "vertOffset") {
            pic.common.vertical_offset = v as u32;
        }
        if let Some(v) = json_i32(props_json, "horzOffset") {
            pic.common.horizontal_offset = v as u32;
        }
        Self::sync_common_obj_attr_known_bits(&mut pic.common);

        // 이미지 속성
        if let Some(v) = json_i32(props_json, "brightness") {
            pic.image_attr.brightness = v as i8;
        }
        if let Some(v) = json_i32(props_json, "contrast") {
            pic.image_attr.contrast = v as i8;
        }
        if let Some(v) = json_i32(props_json, "transparency") {
            pic.image_attr.transparency = v.clamp(0, 100) as u8;
        }
        if let Some(v) = json_str(props_json, "effect") {
            pic.image_attr.effect = match v.as_str() {
                "GrayScale" => crate::model::image::ImageEffect::GrayScale,
                "BlackWhite" => crate::model::image::ImageEffect::BlackWhite,
                "Pattern8x8" => crate::model::image::ImageEffect::Pattern8x8,
                _ => crate::model::image::ImageEffect::RealPic,
            };
        }

        // 회전/대칭 — [#6806] "키 존재" 가 아니라 "값 변화" 가 회전 변경이다. 게터는 이 키를
        // 항상 내보내므로, 종전에는 같은 각도를 되먹여도 `refresh_picture_rotation_layout_for_save`
        // 가 돌아 `common` 을 `current` 로 다시 세웠다.
        if let Some(v) = json_i16(props_json, "rotationAngle") {
            if v != pic.shape_attr.rotation_angle {
                pic.shape_attr.rotation_angle = v;
                rotation_changed = true;
            }
        }
        if let Some(v) = json_bool(props_json, "horzFlip") {
            pic.shape_attr.horz_flip = v;
            if v {
                pic.shape_attr.flip |= 0x01;
            } else {
                pic.shape_attr.flip &= !0x01;
            }
        }
        if let Some(v) = json_bool(props_json, "vertFlip") {
            pic.shape_attr.vert_flip = v;
            if v {
                pic.shape_attr.flip |= 0x02;
            } else {
                pic.shape_attr.flip &= !0x02;
            }
        }
        if rotation_changed {
            Self::refresh_picture_rotation_layout_for_save(pic);
        }
        // `refresh_picture_rotation_layout_for_save` 가 크기·위치를 다시 세우므로 그 뒤에
        // 지문을 비교한다. 변화가 없으면 한컴 원본 렌더링 행렬을 그대로 둔다(직렬화기는
        // `raw_rendering` 이 비어 있을 때만 행렬을 새로 만든다).
        if Self::picture_transform_fingerprint(pic) != transform_before {
            pic.shape_attr.raw_rendering.clear();
            pic.shape_attr.render_tx = pic.shape_attr.offset_x as f64;
            pic.shape_attr.render_ty = pic.shape_attr.offset_y as f64;
            pic.shape_attr.render_sx = 1.0;
            pic.shape_attr.render_sy = 1.0;
            pic.shape_attr.render_b = 0.0;
            pic.shape_attr.render_c = 0.0;
        }

        // 자르기: HWP 내부 crop은 원본 이미지의 source rect 좌표이고,
        // 속성 창 UI는 네 방향에서 잘라낸 양을 표시한다.
        let crop_left = json_i32(props_json, "cropLeft");
        let crop_top = json_i32(props_json, "cropTop");
        let crop_right = json_i32(props_json, "cropRight");
        let crop_bottom = json_i32(props_json, "cropBottom");
        if crop_left.is_some()
            || crop_top.is_some()
            || crop_right.is_some()
            || crop_bottom.is_some()
        {
            let (mut left, mut top, mut right, mut bottom) = Self::picture_crop_ui_amounts(pic);
            if let Some(v) = crop_left {
                left = v;
            }
            if let Some(v) = crop_top {
                top = v;
            }
            if let Some(v) = crop_right {
                right = v;
            }
            if let Some(v) = crop_bottom {
                bottom = v;
            }
            Self::set_picture_crop_from_ui_amounts(pic, left, top, right, bottom);
        }

        // 안쪽 여백 (그림 여백)
        if let Some(v) = json_i16(props_json, "paddingLeft") {
            pic.padding.left = v;
        }
        if let Some(v) = json_i16(props_json, "paddingTop") {
            pic.padding.top = v;
        }
        if let Some(v) = json_i16(props_json, "paddingRight") {
            pic.padding.right = v;
        }
        if let Some(v) = json_i16(props_json, "paddingBottom") {
            pic.padding.bottom = v;
        }

        // 바깥 여백
        if let Some(v) = json_i16(props_json, "outerMarginLeft") {
            pic.common.margin.left = v;
        }
        if let Some(v) = json_i16(props_json, "outerMarginTop") {
            pic.common.margin.top = v;
        }
        if let Some(v) = json_i16(props_json, "outerMarginRight") {
            pic.common.margin.right = v;
        }
        if let Some(v) = json_i16(props_json, "outerMarginBottom") {
            pic.common.margin.bottom = v;
        }

        // 테두리
        if let Some(v) = json_u32(props_json, "borderColor") {
            pic.border_color = v;
        }
        if let Some(v) = json_i32(props_json, "borderWidth") {
            pic.border_width = v;
        }

        // description
        if let Some(v) = json_str(props_json, "description") {
            pic.common.description = v;
        }

        let mut caption_created = false;

        // 캡션
        if let Some(has_cap) = json_bool(props_json, "hasCaption") {
            if has_cap {
                // 캡션이 없으면 새로 생성 (기본 문단 포함)
                if pic.caption.is_none() {
                    let mut cap = crate::model::shape::Caption::default();
                    // AutoNumber 컨트롤 생성 (번호 할당은 아래에서)
                    let an = crate::model::control::AutoNumber {
                        number_type: crate::model::control::AutoNumberType::Picture,
                        ..Default::default()
                    };
                    cap.paragraphs
                        .push(crate::model::paragraph::Paragraph::default());
                    // 캡션 텍스트 최대 폭 = 개체 폭
                    cap.max_width = pic.common.width;
                    pic.caption = Some(cap);
                    caption_created = true;
                    // 번호 할당을 위해 컨트롤을 임시로 캡션에 추가
                    pic.caption.as_mut().unwrap().paragraphs[0]
                        .controls
                        .push(crate::model::control::Control::AutoNumber(an));
                    // attr bit 29: 캡션 존재 플래그 (한컴 호환성)
                    pic.common.attr |= 1 << 29;
                }
                let cap = pic.caption.as_mut().unwrap();
                if let Some(v) = json_str(props_json, "captionDirection") {
                    cap.direction = match v.as_str() {
                        "Left" => crate::model::shape::CaptionDirection::Left,
                        "Right" => crate::model::shape::CaptionDirection::Right,
                        "Top" => crate::model::shape::CaptionDirection::Top,
                        _ => crate::model::shape::CaptionDirection::Bottom,
                    };
                }
                if let Some(v) = json_str(props_json, "captionVertAlign") {
                    cap.vert_align = match v.as_str() {
                        "Center" => crate::model::shape::CaptionVertAlign::Center,
                        "Bottom" => crate::model::shape::CaptionVertAlign::Bottom,
                        _ => crate::model::shape::CaptionVertAlign::Top,
                    };
                }
                if let Some(v) = json_u32(props_json, "captionWidth") {
                    cap.width = v;
                }
                if let Some(v) = json_i16(props_json, "captionSpacing") {
                    cap.spacing = v;
                }
                if let Some(v) = json_bool(props_json, "captionIncludeMargin") {
                    cap.include_margin = v;
                }
            } else {
                pic.caption = None;
                pic.common.attr &= !(1 << 29);
            }
        }

        caption_created
    }
    /// 그림 컨트롤을 문단에서 삭제한다 (네이티브).
    pub fn delete_picture_control_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
    ) -> Result<String, HwpError> {
        if section_idx >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!(
                "구역 인덱스 {} 범위 초과",
                section_idx
            )));
        }
        let section = &mut self.document.sections[section_idx];
        if parent_para_idx >= section.paragraphs.len() {
            return Err(HwpError::RenderError(format!(
                "부모 문단 인덱스 {} 범위 초과",
                parent_para_idx
            )));
        }
        let para = &mut section.paragraphs[parent_para_idx];
        if control_idx >= para.controls.len() {
            return Err(HwpError::RenderError(format!(
                "컨트롤 인덱스 {} 범위 초과",
                control_idx
            )));
        }
        // 그림 컨트롤인지 확인
        if !matches!(
            &para.controls[control_idx],
            crate::model::control::Control::Picture(_)
        ) {
            return Err(HwpError::RenderError(
                "지정된 컨트롤이 그림이 아닙니다".to_string(),
            ));
        }

        Self::remove_inline_control_with_metadata(para, control_idx);

        // line_segs 재계산: 그림 높이가 반영된 line_segs를 텍스트 기반으로 리셋
        Self::reflow_paragraph_line_segs_after_control_delete(para, &self.styles, self.dpi);

        section.raw_stream = None;
        self.recompose_section(section_idx);
        self.paginate_if_needed();

        self.event_log.push(DocumentEvent::PictureDeleted {
            section: section_idx,
            para: parent_para_idx,
            ctrl: control_idx,
        });
        Ok("{\"ok\":true}".to_string())
    }
    /// 글자처럼 취급(tac=true) 그림 컨트롤을 같은 구역 내 새 캐럿 위치로 이동한다.
    ///
    /// 어울림(tac=false) 그림은 위치 이동이 개체 오프셋 변경이므로 본 명령의
    /// 대상이 아니다. 삭제(delete_picture_control_native 의 삭제 절반) → 재삽입
    /// (insert_equation_native 의 인라인 삽입 패턴)으로 처리하며, 재조판/
    /// 페이지네이션은 이동 완료 후 한 번만 수행한다.
    ///
    /// 같은 문단 이동 시 대상 오프셋은 원본 컨트롤 제거(1글자)를 반영한 문단
    /// 논리 공간으로 보정한다. 계산된 삽입 슬롯이 원본 슬롯과 같으면 상태를
    /// 변경하지 않고 moved=false 로 종료한다.
    ///
    /// 반환: JSON `{"ok":true,"paraIdx":N,"controlIdx":N,"moved":bool}`
    pub fn move_picture_control_native(
        &mut self,
        section_idx: usize,
        from_para_idx: usize,
        from_control_idx: usize,
        to_para_idx: usize,
        to_char_offset: usize,
    ) -> Result<String, HwpError> {
        if section_idx >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!(
                "구역 인덱스 {} 범위 초과",
                section_idx
            )));
        }
        let same_para = from_para_idx == to_para_idx;
        let (pic, target_offset, insert_idx) = {
            let section = &mut self.document.sections[section_idx];
            if from_para_idx >= section.paragraphs.len() {
                return Err(HwpError::RenderError(format!(
                    "원본 문단 인덱스 {} 범위 초과",
                    from_para_idx
                )));
            }
            if to_para_idx >= section.paragraphs.len() {
                return Err(HwpError::RenderError(format!(
                    "대상 문단 인덱스 {} 범위 초과",
                    to_para_idx
                )));
            }
            let para = &mut section.paragraphs[from_para_idx];
            if from_control_idx >= para.controls.len() {
                return Err(HwpError::RenderError(format!(
                    "컨트롤 인덱스 {} 범위 초과",
                    from_control_idx
                )));
            }
            let pic = match &para.controls[from_control_idx] {
                Control::Picture(p) => {
                    if !p.common.treat_as_char {
                        return Err(HwpError::RenderError(
                            "글자처럼 취급 그림만 이동할 수 있습니다".to_string(),
                        ));
                    }
                    (**p).clone()
                }
                _ => {
                    return Err(HwpError::RenderError(
                        "지정된 컨트롤이 그림이 아닙니다".to_string(),
                    ));
                }
            };
            let src_logical = crate::document_core::helpers::find_logical_control_positions(para)
                .get(from_control_idx)
                .copied()
                .unwrap_or(0);
            // 삭제 후 상태의 컨트롤 text position 예측 (제거 항목 제외).
            let mut positions = crate::document_core::helpers::find_control_text_positions(para);
            positions.remove(from_control_idx);
            // insert_equation_native 규약: text position 이 대상 오프셋보다 큰
            // 첫 컨트롤 앞에 삽입. 같은 문단이면 원본 컨트롤 1글자 제거를 반영한
            // 문단 논리 공간으로 보정한다.
            let target_offset = if same_para && to_char_offset > src_logical {
                to_char_offset - 1
            } else {
                to_char_offset
            };
            let insert_idx = positions
                .iter()
                .position(|&pos| pos > target_offset)
                .unwrap_or(positions.len());
            // 자기 자리로의 이동(같은 슬롯 + 같은 갭 위치 복원)은 상태 변경 없이
            // 종료한다. 남은 컨트롤이 없으면 insert_idx 가 항상 0 으로 수렴하므로
            // 슬롯 비교만으로는 부족하고, 갭 위치(스트림 삽입 지점) 비교가 필요하다.
            let no_move = if same_para {
                let gs = Self::find_inline_control_gap_start(para, from_control_idx);
                let text_len_chars = para.text.chars().count();
                let safe = target_offset.min(text_len_chars);
                let t_pre: u32 = if safe < para.char_offsets.len() {
                    para.char_offsets[safe]
                } else {
                    let last_idx = para.char_offsets.len().saturating_sub(1);
                    let last_w = para
                        .text
                        .chars()
                        .nth(last_idx)
                        .map(|c| if (c as u32) > 0xFFFF { 2 } else { 1 })
                        .unwrap_or(1);
                    para.char_offsets.last().map_or(0, |&off| off + last_w)
                };
                // 갭 제거 시 당겨진 오프셋을 반영한 삭제 후 스트림 삽입 지점.
                let t = if t_pre >= gs + 8 { t_pre - 8 } else { t_pre };
                insert_idx == from_control_idx && t == gs
            } else {
                false
            };
            if no_move {
                return Ok(crate::document_core::helpers::json_ok_with(&format!(
                    "\"paraIdx\":{},\"controlIdx\":{},\"moved\":false",
                    to_para_idx, from_control_idx
                )));
            }
            (pic, target_offset, insert_idx)
        };

        // 1) 원본 문단에서 갭 시프트 삭제 (재조판·재구성은 이동 완료 후 한 번).
        let section = &mut self.document.sections[section_idx];
        section.raw_stream = None;
        {
            let para = &mut section.paragraphs[from_para_idx];
            Self::remove_inline_control_with_metadata(para, from_control_idx);
            Self::reflow_paragraph_line_segs_after_control_delete(para, &self.styles, self.dpi);
        }

        // 2) 대상 문단 삽입 (insert_equation_native 패턴).
        let new_ctrl_idx = {
            let para = &mut section.paragraphs[to_para_idx];
            let insert_idx = if same_para {
                insert_idx
            } else {
                let positions = crate::document_core::helpers::find_control_text_positions(para);
                positions
                    .iter()
                    .position(|&pos| pos > target_offset)
                    .unwrap_or(para.controls.len())
            };
            // HWPX 로드 문서는 ctrl_data_records 가 controls 보다 짧을 수 있다
            // (비동기 상태) — insert 전 길이를 맞춘다.
            if para.ctrl_data_records.len() < para.controls.len() {
                para.ctrl_data_records
                    .resize_with(para.controls.len(), || None);
            }
            para.controls
                .insert(insert_idx, Control::Picture(Box::new(pic)));
            para.ctrl_data_records.insert(insert_idx, None);
            para.shift_for_inline_control_insert(target_offset);
            para.char_count += 8;
            para.control_mask |= 0x00000800;
            para.has_para_text = true;
            insert_idx
        };

        // 대상 문단 리플로우 (insert_equation_native 폭 계산과 동일).
        {
            use crate::renderer::composer::reflow_line_segs;
            use crate::renderer::hwpunit_to_px;
            let page_def = &section.section_def.page_def;
            let text_width =
                page_def.width as i32 - page_def.margin_left as i32 - page_def.margin_right as i32;
            let available_width = hwpunit_to_px(text_width, self.dpi);
            let para_style = self
                .styles
                .para_styles
                .get(section.paragraphs[to_para_idx].para_shape_id as usize);
            let margin_left = para_style.map(|s| s.margin_left).unwrap_or(0.0);
            let margin_right = para_style.map(|s| s.margin_right).unwrap_or(0.0);
            let final_width = (available_width - margin_left - margin_right).max(0.0);
            reflow_line_segs(
                &mut section.paragraphs[to_para_idx],
                final_width,
                &self.styles,
                self.dpi,
            );
        }

        self.recompose_section(section_idx);
        self.paginate_if_needed();
        self.invalidate_page_tree_cache();

        // PictureMoved 는 대상 문단 revision 만 올린다. 그림이 빠진 원본 문단도 올려야
        // 스냅샷 복원이 현재(그림 없는) 원본 문단을 재사용하지 않는다.
        if !same_para {
            self.event_log
                .mark_paragraph_changed(section_idx, from_para_idx);
        }
        self.event_log.push(DocumentEvent::PictureMoved {
            section: section_idx,
            para: to_para_idx,
            ctrl: new_ctrl_idx,
        });
        Ok(crate::document_core::helpers::json_ok_with(&format!(
            "\"paraIdx\":{},\"controlIdx\":{},\"moved\":true",
            to_para_idx, new_ctrl_idx
        )))
    }
    /// 본문/중첩 표 셀 사이에서 인라인 그림을 이동한다. 오프셋은 논리 글자 단위다.
    /// 반환 cellPath는 컨트롤 삭제/삽입으로 바뀐 표 인덱스를 반영한다.
    pub fn move_picture_control_by_path_native(
        &mut self,
        section_idx: usize,
        from_para_idx: usize,
        from_path: &[(usize, usize, usize)],
        from_control_idx: usize,
        to_para_idx: usize,
        to_path: &[(usize, usize, usize)],
        to_char_offset: usize,
    ) -> Result<String, HwpError> {
        use crate::document_core::helpers::{
            find_logical_control_positions, is_treat_as_char_object_control,
            logical_paragraph_length,
        };
        let resolve = |parent: usize, path: &[(usize, usize, usize)]| {
            let mut para = self
                .document
                .sections
                .get(section_idx)
                .and_then(|section| section.paragraphs.get(parent))
                .ok_or_else(|| HwpError::RenderError("그림 이동 문단을 찾지 못했습니다".into()))?;
            for &(ctrl, cell, paragraph) in path {
                let Some(Control::Table(table)) = para.controls.get(ctrl) else {
                    return Err(HwpError::RenderError(
                        "그림 이동 경로는 표 셀이어야 합니다".into(),
                    ));
                };
                para = table
                    .cells
                    .get(cell)
                    .and_then(|cell| cell.paragraphs.get(paragraph))
                    .ok_or_else(|| {
                        HwpError::RenderError("그림 이동 셀 문단을 찾지 못했습니다".into())
                    })?;
            }
            Ok(para)
        };
        // 변경 전 양쪽 경로와 그림을 모두 검증한다.
        let source = resolve(from_para_idx, from_path)?;
        let target = resolve(to_para_idx, to_path)?;
        let picture = match source.controls.get(from_control_idx) {
            Some(Control::Picture(pic)) if pic.common.treat_as_char => pic.clone(),
            _ => {
                return Err(HwpError::RenderError(
                    "글자처럼 취급 그림만 이동할 수 있습니다".into(),
                ))
            }
        };
        let ctrl_data = source
            .ctrl_data_records
            .get(from_control_idx)
            .cloned()
            .flatten();
        let source_offset = find_logical_control_positions(source)[from_control_idx];
        let same_para = from_para_idx == to_para_idx && from_path == to_path;
        let requested = to_char_offset.min(logical_paragraph_length(target));
        let target_offset = requested - usize::from(same_para && requested > source_offset);
        let result =
            |moved: bool, control: usize, path: &[(usize, usize, usize)], offset: usize| {
                serde_json::json!({
                    "ok": true, "moved": moved, "paraIdx": to_para_idx,
                    "controlIdx": control, "charOffset": offset,
                    "cellPath": path.iter().map(|&(ctrl, cell, para)| serde_json::json!({
                        "controlIndex": ctrl, "cellIndex": cell, "cellParaIndex": para,
                    })).collect::<Vec<_>>(),
                })
                .to_string()
            };
        if same_para && target_offset == source_offset {
            return Ok(result(false, from_control_idx, to_path, source_offset));
        }

        let section = &mut self.document.sections[section_idx];
        let source = Self::resolve_cell_paragraph_mut(section, from_para_idx, from_path)?;
        Self::remove_inline_control_with_metadata(source, from_control_idx);
        let mut target_path = to_path.to_vec();
        if from_para_idx == to_para_idx
            && target_path.len() > from_path.len()
            && target_path.starts_with(from_path)
        {
            let ctrl = &mut target_path[from_path.len()].0;
            if *ctrl > from_control_idx {
                *ctrl -= 1;
            }
        }
        let target = Self::resolve_cell_paragraph_mut(section, to_para_idx, &target_path)?;
        let occupies_slot = |ctrl: &Control| {
            is_treat_as_char_object_control(ctrl)
                || matches!(ctrl, Control::Footnote(_) | Control::Endnote(_))
        };
        let positions = find_logical_control_positions(target);
        let insert_idx = target
            .controls
            .iter()
            .enumerate()
            .find(|(i, ctrl)| {
                positions[*i] > target_offset
                    || (positions[*i] == target_offset && occupies_slot(ctrl))
            })
            .map(|(i, _)| i)
            .unwrap_or(target.controls.len());
        let preceding = target.controls[..insert_idx]
            .iter()
            .filter(|ctrl| occupies_slot(ctrl))
            .count();
        let text_offset = target_offset
            .saturating_sub(preceding)
            .min(target.text.chars().count());
        // 같은 텍스트 위치의 여러 컨트롤 사이도 정확한 UTF-16 갭을 선택한다.
        let text_end = if text_offset == 0 {
            0
        } else {
            let ch = target.text.chars().nth(text_offset - 1).unwrap();
            target.char_offsets[text_offset - 1]
                + if ch == '\t' { 8 } else { ch.len_utf16() as u32 }
        };
        let control_end = if insert_idx == 0 {
            0
        } else {
            Self::find_inline_control_gap_start(target, insert_idx - 1) + 8
        };
        let insert_pos = text_end.max(control_end);
        target.authored_text_runs = None;
        target.para_text_terminal = None;
        for offset in &mut target.char_offsets {
            if *offset >= insert_pos {
                *offset += 8;
            }
        }
        for shape in &mut target.char_shapes {
            if shape.start_pos >= insert_pos && shape.start_pos > 0 {
                shape.start_pos += 8;
            }
        }
        for tag in &mut target.range_tags {
            if tag.start >= insert_pos {
                tag.start += 8;
            }
            if tag.end >= insert_pos {
                tag.end += 8;
            }
        }
        for field in &mut target.field_ranges {
            if field.control_idx >= insert_idx {
                field.control_idx += 1;
            }
        }
        target
            .ctrl_data_records
            .resize_with(target.controls.len(), || None);
        target
            .controls
            .insert(insert_idx, Control::Picture(picture));
        target.ctrl_data_records.insert(insert_idx, ctrl_data);
        target.char_count += 8;
        target.control_mask |= 1 << 11;
        target.has_para_text = true;
        let anchor = find_logical_control_positions(target)[insert_idx];
        section.raw_stream = None;

        let mut source_path = from_path.to_vec();
        if from_para_idx == to_para_idx
            && source_path.len() > target_path.len()
            && source_path.starts_with(&target_path)
        {
            let ctrl = &mut source_path[target_path.len()].0;
            if *ctrl >= insert_idx {
                *ctrl += 1;
            }
        }
        for (parent, path) in [(from_para_idx, &source_path), (to_para_idx, &target_path)] {
            if let Some(&(_, _, para)) = path.last() {
                self.reflow_cell_paragraph_by_path(section_idx, parent, path, para);
                self.recalculate_cell_paragraph_vpos_by_path(section_idx, parent, path, para, None);
                // 가장 안쪽 표부터 모든 조상 표의 높이를 다시 측정한다.
                for depth in (0..path.len()).rev() {
                    let ancestor = Self::resolve_cell_paragraph_mut(
                        &mut self.document.sections[section_idx],
                        parent,
                        &path[..depth],
                    )?;
                    if let Control::Table(table) = &mut ancestor.controls[path[depth].0] {
                        table.dirty = true;
                    }
                }
            } else {
                self.reflow_body_para_and_recalc_flow(section_idx, parent);
            }
        }
        self.mark_section_dirty(section_idx);
        self.recompose_section(section_idx);
        self.paginate_if_needed();
        self.invalidate_page_tree_cache();
        // 원본 본문 문단(셀 경로의 host 포함)이 대상과 다르면 따로 revision 을 올린다.
        if from_para_idx != to_para_idx {
            self.event_log
                .mark_paragraph_changed(section_idx, from_para_idx);
        }
        self.event_log.push(DocumentEvent::PictureMoved {
            section: section_idx,
            para: to_para_idx,
            ctrl: insert_idx,
        });
        Ok(result(true, insert_idx, &target_path, anchor))
    }

    /// [Task #2230] 임베디드 BinData 등록 (콘텐츠 + 메타데이터) — 반환값은
    /// bin_data_id(위치, 1-based 순번).
    ///
    /// bin_data_id 와 storage id(BIN%04X 스트림 이름)는 다른 의미다. 위치는
    /// 배열 순번으로 유지하고, storage id 는 기존 id 와 충돌하지 않게
    /// 최댓값+1 로 채번한다 — 순번 채번은 storage id 에 구멍이 있는 문서에서
    /// 기존 이미지와 스트림 이름이 충돌해 저장 시 이미지가 뒤바뀌거나
    /// 소실된다. (insert_picture_native 와 그림 지정이 규칙 공유.)
    pub(crate) fn register_embedded_bin_data(&mut self, image_data: &[u8], extension: &str) -> u16 {
        use crate::model::bin_data::{
            BinData, BinDataCompression, BinDataContent, BinDataStatus, BinDataType,
        };
        let position_id = self.document.bin_data_content.len() as u16 + 1;
        let storage_id = self.document.next_bin_data_storage_id();
        self.document.bin_data_content.push(BinDataContent {
            id: storage_id,
            data: image_data.to_vec().into(),
            extension: extension.to_string(),
        });
        // attr: bits 0-3=1(Embedding), bits 4-5=0(Default), bits 8-9=1(Success)
        let bin_attr: u16 = 0x0101;
        self.document.doc_info.bin_data_list.push(BinData {
            raw_data: None,
            attr: bin_attr,
            data_type: BinDataType::Embedding,
            compression: BinDataCompression::Default,
            status: BinDataStatus::Success,
            abs_path: None,
            rel_path: None,
            storage_id,
            extension: Some(extension.to_string()),
        });
        self.document.doc_info.raw_stream = None; // DocInfo 재직렬화
        position_id
    }

    /// [Task #2230] 기존 Picture 컨트롤에 이미지를 지정한다 — 그림 미지정
    /// placeholder(bin 참조 실패 + 외부 경로 없음)의 편집 뷰 그림 삽입.
    ///
    /// - BinData 등록 규칙은 insert_picture_native 와 공유
    ///   (register_embedded_bin_data).
    /// - 개체 틀 크기(common.width/height)와 배치 속성은 유지한다 — 한컴
    ///   placeholder 는 틀에 그림을 맞추므로 레이아웃 불변.
    /// - crop 은 insert_picture_native 와 동일하게 원본 전체
    ///   (natural px × 75 = HWPUNIT@96dpi) 로 설정한다.
    /// - `cell_path` 가 비어있으면 본문/각주 문단의 컨트롤, 있으면 셀/글상자
    ///   안 문단의 컨트롤을 대상으로 한다.
    pub fn assign_picture_image_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        cell_path: &[(usize, usize, usize)],
        control_idx: usize,
        image_data: &[u8],
        natural_width_px: u32,
        natural_height_px: u32,
        extension: &str,
    ) -> Result<String, HwpError> {
        if image_data.is_empty() {
            return Err(HwpError::RenderError(
                "이미지 데이터가 비어 있습니다".to_string(),
            ));
        }
        // 대상 존재 검증을 BinData 등록보다 먼저 수행 — 실패 시 문서 무변형.
        if cell_path.is_empty() {
            self.resolve_picture_control_ref(section_idx, parent_para_idx, control_idx)?;
        } else {
            let para = self.resolve_paragraph_by_path(section_idx, parent_para_idx, cell_path)?;
            let ctrl = para.controls.get(control_idx).ok_or_else(|| {
                HwpError::RenderError(format!("셀 내 컨트롤 {} 범위 초과", control_idx))
            })?;
            if !matches!(ctrl, Control::Picture(_)) {
                return Err(HwpError::RenderError(
                    "지정된 셀 내 컨트롤이 그림이 아닙니다".to_string(),
                ));
            }
        }

        let position_id = self.register_embedded_bin_data(image_data, extension);

        {
            let pic = if cell_path.is_empty() {
                self.resolve_picture_control_mut(section_idx, parent_para_idx, control_idx)?
            } else {
                let section = self.document.sections.get_mut(section_idx).ok_or_else(|| {
                    HwpError::RenderError(format!("구역 인덱스 {} 범위 초과", section_idx))
                })?;
                let para = Self::resolve_cell_paragraph_mut(section, parent_para_idx, cell_path)?;
                let ctrl = para.controls.get_mut(control_idx).ok_or_else(|| {
                    HwpError::RenderError(format!("셀 내 컨트롤 {} 범위 초과", control_idx))
                })?;
                match ctrl {
                    Control::Picture(p) => p,
                    _ => {
                        return Err(HwpError::RenderError(
                            "지정된 셀 내 컨트롤이 그림이 아닙니다".to_string(),
                        ))
                    }
                }
            };
            pic.image_attr.bin_data_id = position_id;
            pic.image_attr.external_path = None;
            pic.crop = crate::model::image::CropInfo {
                left: 0,
                top: 0,
                right: (natural_width_px * 75) as i32,
                bottom: (natural_height_px * 75) as i32,
            };
        }

        let section = &mut self.document.sections[section_idx];
        section.raw_stream = None;
        self.recompose_section(section_idx);
        self.paginate_if_needed();
        self.invalidate_page_tree_cache();
        self.event_log.push(DocumentEvent::PictureResized {
            section: section_idx,
            para: parent_para_idx,
            ctrl: control_idx,
        });
        Ok(format!("{{\"ok\":true,\"binDataId\":{}}}", position_id))
    }

    /// 커서 위치에 그림을 삽입한다 (네이티브).
    ///
    /// - 빈 `cell_path`는 본문 floating 삽입이다. Inline 삽입은 명시적 placement API를 쓴다.
    /// - `cell_path` 가 있으면 표 셀 영역에 floating picture (tac=false, wrap=Square,
    ///   Page-relative offset) 로 삽입한다. 셀 자체는 비어있는 채로 유지되어 cursor
    ///   클릭이 정상 동작 (#1151). 한컴 2022 의 셀 이미지 삽입 패턴과 동일
    ///   (incellpicture.hwp 검증).
    ///
    /// `paper_offset_x_hu / paper_offset_y_hu`: 셀 floating 분기에서 사용할 paper-relative
    /// 좌표 (HWPUNIT). `None` 이면 셀 좌상단 (`compute_cell_page_offset`) 을 default 로 사용
    /// — 기존 동작 + API caller 호환. studio drag 좌표 기반 호출은 `Some` 으로 전달.
    /// 본문 inline 분기 (cell_path 비어있음) 는 본 매개변수를 사용하지 않는다.
    #[allow(clippy::too_many_arguments)]
    pub fn insert_picture_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
        cell_path: &[(usize, usize, usize)],
        image_data: &[u8],
        width: u32,
        height: u32,
        natural_width_px: u32,
        natural_height_px: u32,
        extension: &str,
        description: &str,
        paper_offset_x_hu: Option<i32>,
        paper_offset_y_hu: Option<i32>,
    ) -> Result<String, HwpError> {
        self.insert_picture_with_placement_native(
            section_idx,
            para_idx,
            char_offset,
            cell_path,
            image_data,
            width,
            height,
            natural_width_px,
            natural_height_px,
            extension,
            description,
            paper_offset_x_hu,
            paper_offset_y_hu,
            false,
        )
    }

    /// Explicit inline insertion stores the picture in the addressed paragraph,
    /// including nested cells. The positional API retains its floating behavior.
    #[allow(clippy::too_many_arguments)]
    pub fn insert_picture_with_placement_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
        cell_path: &[(usize, usize, usize)],
        image_data: &[u8],
        mut width: u32,
        mut height: u32,
        natural_width_px: u32,
        natural_height_px: u32,
        extension: &str,
        description: &str,
        paper_offset_x_hu: Option<i32>,
        paper_offset_y_hu: Option<i32>,
        inline: bool,
    ) -> Result<String, HwpError> {
        use crate::model::image::{CropInfo, ImageAttr, ImageEffect, Picture};
        use crate::model::paragraph::{CharShapeRef, LineSeg};
        use crate::model::shape::{CommonObjAttr, HorzRelTo, ShapeComponentAttr, VertRelTo};
        // 유효성 검사
        if section_idx >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!(
                "구역 인덱스 {} 범위 초과 (총 {}개)",
                section_idx,
                self.document.sections.len()
            )));
        }
        if para_idx >= self.document.sections[section_idx].paragraphs.len() {
            return Err(HwpError::RenderError(format!(
                "문단 인덱스 {} 범위 초과",
                para_idx
            )));
        }
        if image_data.is_empty() {
            return Err(HwpError::RenderError(
                "이미지 데이터가 비어 있습니다".to_string(),
            ));
        }
        // cell_path 가 있으면 경로가 유효한지 사전 검증한다.
        //
        // 표 셀 picture 는 한컴 정합상 표 sibling floating 으로 삽입하지만,
        // 글상자(text_box) 내부 picture 는 글상자 문단의 control 로 들어가야 한다.
        // 기존 resolve_cell_by_path 는 마지막 엔트리가 표일 때만 성공하므로
        // 먼저 표/글상자를 구분한다.
        let cell_path_is_textbox = if !cell_path.is_empty() {
            let section = &self.document.sections[section_idx];
            let is_textbox = Self::cell_path_terminates_at_textbox(section, para_idx, cell_path)?;
            if !is_textbox {
                self.resolve_cell_by_path(section_idx, para_idx, cell_path)?;
            }
            is_textbox
        } else {
            false
        };

        // Validate the paragraph and size before allocating image resources.
        if inline {
            if width == 0 || height == 0 || natural_width_px == 0 || natural_height_px == 0 {
                return Err(HwpError::RenderError(
                    "그림 크기는 0보다 커야 합니다".into(),
                ));
            }
            let para = if cell_path.is_empty() {
                &self.document.sections[section_idx].paragraphs[para_idx]
            } else {
                self.resolve_paragraph_by_path(section_idx, para_idx, cell_path)?
            };
            if char_offset > crate::document_core::helpers::logical_paragraph_length(para) {
                return Err(HwpError::RenderError(
                    "그림 삽입 위치가 문단 범위를 벗어났습니다".into(),
                ));
            }
            if !cell_path.is_empty() {
                let (cell_width, left, right) = self
                    .resolve_innermost_cell_metrics(section_idx, para_idx, cell_path)
                    .ok_or_else(|| {
                        HwpError::RenderError("그림을 넣을 셀 폭을 찾지 못했습니다".into())
                    })?;
                let style = self.styles.para_styles.get(para.para_shape_id as usize);
                let margins_hu = style
                    .map(|s| (s.margin_left + s.margin_right) * 7200.0 / self.dpi)
                    .unwrap_or(0.0);
                let available = (cell_width as f64 - left as f64 - right as f64 - margins_hu)
                    .floor()
                    .max(1.0) as u32;
                if width > available {
                    height =
                        ((height as f64 * available as f64 / width as f64).round() as u32).max(1);
                    width = available;
                }
            }
        }

        // --- 1·2. BinData 등록 (콘텐츠 + 메타데이터) ---
        // [Task #2230] 그림 지정(assign_picture_image_native)과 규칙 공유를 위해
        // register_embedded_bin_data 로 추출.
        let position_id = self.register_embedded_bin_data(image_data, extension);

        // --- 공통 자원 ---
        let shape_attr = ShapeComponentAttr {
            original_width: width,
            original_height: height,
            current_width: width,
            current_height: height,
            local_file_version: 1,
            render_sx: 1.0,
            render_sy: 1.0,
            ..Default::default()
        };
        let bx = [0i32, 0, width as i32, 0];
        let by = [width as i32, height as i32, 0, height as i32];
        let crop = CropInfo {
            left: 0,
            top: 0,
            right: (natural_width_px * 75) as i32,
            bottom: (natural_height_px * 75) as i32,
        };
        let image_attr = ImageAttr {
            bin_data_id: position_id,
            brightness: 0,
            contrast: 0,
            effect: ImageEffect::RealPic,
            transparency: 0,
            external_path: None,
        };
        if inline {
            let pic = Picture {
                common: CommonObjAttr {
                    ctrl_id: 0x67736F20,
                    attr: 1 | (2 << 3) | (3 << 8) | (4 << 15) | (2 << 18),
                    treat_as_char: true,
                    vert_rel_to: VertRelTo::Para,
                    horz_rel_to: HorzRelTo::Para,
                    width,
                    height,
                    description: description.to_string(),
                    ..Default::default()
                },
                shape_attr,
                border_x: bx,
                border_y: by,
                crop,
                image_attr,
                ..Default::default()
            };
            let section = &mut self.document.sections[section_idx];
            section.raw_stream = None;
            let para = Self::resolve_cell_paragraph_mut(section, para_idx, cell_path)?;
            let positions = crate::document_core::helpers::find_logical_control_positions(para);
            let occupies_slot = |ctrl: &Control| {
                crate::document_core::helpers::is_treat_as_char_object_control(ctrl)
                    || matches!(ctrl, Control::Footnote(_) | Control::Endnote(_))
            };
            let preceding = para
                .controls
                .iter()
                .enumerate()
                .filter(|(i, ctrl)| occupies_slot(ctrl) && positions[*i] < char_offset)
                .count();
            let text_offset = char_offset - preceding;
            let insert_idx = para
                .controls
                .iter()
                .enumerate()
                .find(|(i, ctrl)| occupies_slot(ctrl) && positions[*i] >= char_offset)
                .map(|(i, _)| i)
                .unwrap_or(para.controls.len());
            para.shift_for_inline_control_insert(text_offset);
            para.ctrl_data_records
                .resize_with(para.controls.len(), || None);
            para.controls
                .insert(insert_idx, Control::Picture(Box::new(pic)));
            para.ctrl_data_records.insert(insert_idx, None);
            para.char_count += 8;
            para.control_mask |= 1 << 11;
            para.has_para_text = true;

            if let Some(&(outer_ctrl, _, _)) = cell_path.first() {
                self.reflow_cell_paragraph_by_path(
                    section_idx,
                    para_idx,
                    cell_path,
                    cell_path.last().unwrap().2,
                );
                self.recalculate_cell_paragraph_vpos_by_path(
                    section_idx,
                    para_idx,
                    cell_path,
                    cell_path.last().unwrap().2,
                    None,
                );
                self.mark_cell_control_dirty(section_idx, para_idx, outer_ctrl);
            } else {
                self.reflow_body_para_and_recalc_flow(section_idx, para_idx);
                self.recompose_section(section_idx);
            }
            self.mark_section_dirty(section_idx);
            self.paginate_if_needed();
            self.invalidate_page_tree_cache();
            self.event_log.push(DocumentEvent::PictureInserted {
                section: section_idx,
                para: para_idx,
            });
            let address_path: Vec<_> = cell_path.iter().map(|&(control, cell, para)| {
                serde_json::json!({ "controlIndex": control, "cellIndex": cell, "cellParaIndex": para })
            }).collect();
            return Ok(serde_json::json!({
                "ok": true, "sectionIdx": section_idx, "paraIdx": para_idx,
                "cellPath": address_path, "controlIdx": insert_idx,
                "logicalOffset": char_offset + 1,
            })
            .to_string());
        }
        if !cell_path.is_empty() {
            if cell_path_is_textbox {
                // === 글상자 내부 picture 분기 (#1322 maintainer fix) ===
                // hitTest 의 글상자 sentinel path (`cellIdx=0`) 가 넘어온 경우에는
                // Picture 를 body paragraph 의 sibling 으로 띄우지 않고, 실제 text_box
                // paragraph 안에 삽입한다. 글상자 내부 좌표계는 text_box content box
                // 기준이므로 caller 가 전달한 offset 은 Para-relative 로 해석한다.
                let (offset_x_hu, offset_y_hu) = match (paper_offset_x_hu, paper_offset_y_hu) {
                    (Some(x), Some(y)) => (x, y),
                    _ => (0, 0),
                };
                let new_z_order = {
                    let section = &mut self.document.sections[section_idx];
                    let target_para =
                        Self::resolve_cell_paragraph_mut(section, para_idx, cell_path)?;
                    // Nested controls have their own paint scope. A high body-layer z-order
                    // must not leak into a text box's local controls.
                    super::max_control_layer_z_order(&target_para.controls)
                        .max(0)
                        .saturating_add(1)
                };

                // CommonObjAttr (text_box 내부 floating):
                //   bits 3-4=vert_rel_to(2=Para), bits 8-10=horz_rel_to(3=Para),
                //   bits 15-17=width_criterion(4=Absolute),
                //   bits 18-20=height_criterion(2=Absolute),
                //   bits 21-23=text_wrap(0=Square)
                let common_attr: u32 = (2 << 3) | (3 << 8) | (4 << 15) | (2 << 18);
                let common = CommonObjAttr {
                    ctrl_id: 0x67736F20,
                    attr: common_attr,
                    treat_as_char: false,
                    vert_rel_to: VertRelTo::Para,
                    horz_rel_to: HorzRelTo::Para,
                    text_wrap: crate::model::shape::TextWrap::Square,
                    horizontal_offset: offset_x_hu.max(0) as u32,
                    vertical_offset: offset_y_hu.max(0) as u32,
                    width,
                    height,
                    z_order: new_z_order,
                    description: description.to_string(),
                    ..Default::default()
                };
                let pic = Picture {
                    common,
                    shape_attr,
                    border_x: bx,
                    border_y: by,
                    crop,
                    image_attr,
                    ..Default::default()
                };

                let (new_ctrl_idx, logical_after) = {
                    let section = &mut self.document.sections[section_idx];
                    section.raw_stream = None;
                    let target_para =
                        Self::resolve_cell_paragraph_mut(section, para_idx, cell_path)?;
                    let new_ctrl_idx = target_para.controls.len();
                    Self::insert_control_with_data_slot(
                        target_para,
                        new_ctrl_idx,
                        Control::Picture(Box::new(pic)),
                    );
                    target_para.control_mask |= 0x00000800;
                    let logical_positions =
                        crate::document_core::helpers::find_logical_control_positions(target_para);
                    let logical_after = logical_positions
                        .get(new_ctrl_idx)
                        .copied()
                        .unwrap_or_else(|| target_para.text.chars().count())
                        + 1;
                    (new_ctrl_idx, logical_after)
                };

                self.mark_section_dirty(section_idx);
                self.recompose_section(section_idx);
                self.paginate_if_needed();
                self.invalidate_page_tree_cache();

                self.event_log.push(DocumentEvent::PictureInserted {
                    section: section_idx,
                    para: para_idx,
                });
                return Ok(crate::document_core::helpers::json_ok_with(&format!(
                    "\"paraIdx\":{},\"controlIdx\":{},\"logicalOffset\":{}",
                    para_idx, new_ctrl_idx, logical_after
                )));
            }

            // === 셀 floating picture 분기 (#1151 v2 — 한컴 패턴 정합) ===
            // Picture 는 표가 들어있는 paragraph 의 sibling control 로 append 된다.
            // tac=false, wrap=Square (어울림), horz/vert_rel_to=Paper, offset 은 사용자 클릭/드래그 위치.
            // [Task #1151 v8] 결함 A fix: 한컴 native default 가 Paper (incellpicture.hwp dump
            // 확인 — horz_rel_to=Paper offset=11845, vert_rel_to=Paper offset=15595).
            // [Task #1151 v8] 결함 C fix: 사용자가 클릭/드래그한 좌표 (paper-relative HU) 사용 —
            // 한컴 native 동작 정합. caller (studio) 가 None 전달 시 셀 좌상단 default.
            let (offset_x_hu, offset_y_hu) = match (paper_offset_x_hu, paper_offset_y_hu) {
                (Some(x), Some(y)) => (x, y),
                _ => self.compute_cell_page_offset(section_idx, para_idx, cell_path),
            };

            // CommonObjAttr (floating):
            //   bits 3-4=vert_rel_to(0=Paper), bits 8-10=horz_rel_to(0=Paper),
            //   bits 15-17=width_criterion(4=Absolute), bits 18-20=height_criterion(2=Absolute),
            //   bits 21-23=text_wrap(0=Square)
            let common_attr: u32 = (4 << 15) | (2 << 18);
            let common = CommonObjAttr {
                ctrl_id: 0x67736F20,
                attr: common_attr,
                treat_as_char: false,
                vert_rel_to: VertRelTo::Paper,
                horz_rel_to: HorzRelTo::Paper,
                text_wrap: crate::model::shape::TextWrap::Square,
                horizontal_offset: offset_x_hu.max(0) as u32,
                vertical_offset: offset_y_hu.max(0) as u32,
                width,
                height,
                z_order: 1,
                description: description.to_string(),
                ..Default::default()
            };
            let pic = Picture {
                common,
                shape_attr,
                border_x: bx,
                border_y: by,
                crop,
                image_attr,
                ..Default::default()
            };

            // table 같은 paragraph 의 sibling control 로 append.
            self.document.sections[section_idx].raw_stream = None;
            let parent = &mut self.document.sections[section_idx].paragraphs[para_idx];
            let new_ctrl_idx = parent.controls.len();
            Self::insert_control_with_data_slot(
                parent,
                new_ctrl_idx,
                Control::Picture(Box::new(pic)),
            );
            let logical_positions =
                crate::document_core::helpers::find_logical_control_positions(parent);
            let logical_after = logical_positions
                .get(new_ctrl_idx)
                .copied()
                .unwrap_or_else(|| parent.text.chars().count())
                + 1;

            // outer table dirty 마킹 (재측정 유도)
            let outer_ctrl = cell_path[0].0;
            if let Some(Control::Table(t)) = self.document.sections[section_idx].paragraphs
                [para_idx]
                .controls
                .get_mut(outer_ctrl)
            {
                t.dirty = true;
            }
            self.mark_section_dirty(section_idx);
            self.paginate_if_needed();
            // [Task #1151 v9 결함 F] page tree cache invalidate — v5 와 동일 결함 (다른
            // setter 들은 모두 호출하나 본 insert path 의 셀 분기만 누락). 두 picture
            // 연속 insert + toggle 시 cache stale → studio 화면 불일치.
            self.invalidate_page_tree_cache();

            self.event_log.push(DocumentEvent::PictureInserted {
                section: section_idx,
                para: para_idx,
            });
            return Ok(crate::document_core::helpers::json_ok_with(&format!(
                "\"paraIdx\":{},\"controlIdx\":{},\"logicalOffset\":{}",
                para_idx, new_ctrl_idx, logical_after
            )));
        }

        // === 본문 floating picture 분기 (Task #1151 v9 결함 E — 셀 분기와 동일 패턴) ===
        //
        // 한컴 native 동작 (사용자 시연 2026-05-30): 본문 picture 신규 삽입 시
        // 글자처럼 취급 default = **미체크** (tac=false, floating). 셀 안 picture
        // 와 동일. 이전 rhwp 본문 path 는 새 paragraph 생성 + inline glyph (tac=true)
        // 로 만들어 한컴 default 와 불일치 — 재설계하여 셀 분기와 통합.
        let (offset_x_hu, offset_y_hu) = match (paper_offset_x_hu, paper_offset_y_hu) {
            (Some(x), Some(y)) => (x, y),
            _ => (0, 0),
        };

        // CommonObjAttr (floating, 셀 분기와 동일):
        //   bits 3-4=vert_rel_to(0=Paper), bits 8-10=horz_rel_to(0=Paper),
        //   bits 15-17=width_criterion(4=Absolute), bits 18-20=height_criterion(2=Absolute),
        //   bits 21-23=text_wrap(0=Square)
        let common_attr: u32 = (4 << 15) | (2 << 18);
        let new_z_order =
            super::max_layer_z_order(&self.document.sections[section_idx]).saturating_add(1);
        let common = CommonObjAttr {
            ctrl_id: 0x67736F20, // "gso " — GenShape
            attr: common_attr,
            treat_as_char: false,
            vert_rel_to: VertRelTo::Paper,
            horz_rel_to: HorzRelTo::Paper,
            text_wrap: crate::model::shape::TextWrap::Square,
            horizontal_offset: offset_x_hu.max(0) as u32,
            vertical_offset: offset_y_hu.max(0) as u32,
            width,
            height,
            z_order: new_z_order,
            description: description.to_string(),
            ..Default::default()
        };

        let pic = Picture {
            common,
            shape_attr,
            border_x: bx,
            border_y: by,
            crop,
            image_attr,
            ..Default::default()
        };

        // 현재 paragraph 의 sibling control 로 append (새 paragraph 생성 X).
        self.document.sections[section_idx].raw_stream = None;
        let parent = &mut self.document.sections[section_idx].paragraphs[para_idx];
        let new_ctrl_idx = parent.controls.len();
        Self::insert_control_with_data_slot(parent, new_ctrl_idx, Control::Picture(Box::new(pic)));
        let logical_positions =
            crate::document_core::helpers::find_logical_control_positions(parent);
        let logical_after = logical_positions
            .get(new_ctrl_idx)
            .copied()
            .unwrap_or_else(|| parent.text.chars().count())
            + 1;

        self.mark_section_dirty(section_idx);
        self.paginate_if_needed();
        // [Task #1151 v9 결함 F] page tree cache invalidate (v5 패턴).
        self.invalidate_page_tree_cache();

        self.event_log.push(DocumentEvent::PictureInserted {
            section: section_idx,
            para: para_idx,
        });
        Ok(crate::document_core::helpers::json_ok_with(&format!(
            "\"paraIdx\":{},\"controlIdx\":{},\"logicalOffset\":{}",
            para_idx, new_ctrl_idx, logical_after
        )))
    }
}





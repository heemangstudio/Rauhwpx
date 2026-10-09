use resvg::{tiny_skia, usvg};
use skia_safe::{
    canvas::SrcRectConstraint, color_filters, image::RequiredProperties, AlphaType, Color,
    ColorType, Data, FilterMode, IRect, Image, ImageInfo, Matrix, MipmapMode, Paint, Rect,
    SamplingOptions, TileMode,
};
use std::sync::{Arc, OnceLock};

use crate::model::image::ImageEffect;
use crate::model::style::ImageFillMode;
use crate::renderer::image_resample::{gridfit_affine_sample, smooth_hermite_downsample};
use crate::renderer::image_resolver::{detect_image_mime_type, grayscale_jpeg_bytes_to_png_bytes};

const MAX_SVG_FRAGMENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_SVG_RASTER_PIXELS: u64 = 67_108_864;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImageSampling {
    filter_mode: FilterMode,
    mipmap_mode: MipmapMode,
}

impl ImageSampling {
    pub fn linear() -> Self {
        Self {
            filter_mode: FilterMode::Linear,
            mipmap_mode: MipmapMode::None,
        }
    }

    fn options(self) -> SamplingOptions {
        SamplingOptions::new(self.filter_mode, self.mipmap_mode)
    }
}

pub fn draw_svg_fragment(
    canvas: &skia_safe::Canvas,
    svg_fragment: &str,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    sampling: ImageSampling,
    raster_scale: f32,
) -> bool {
    // [Issue #2292] RawSvg 조각은 페이지 절대 좌표로 방출된다(SVG 백엔드
    // 직접 삽입·web_canvas 와 동일 계약). viewBox 원점에 조각의 페이지
    // 위치(x, y)를 넘겨 bbox 창만 래스터한다 — (0,0) 가정 시 창 밖 콘텐츠
    // 전부 클리핑 + bbox 재배치 이중 오프셋으로 차트가 잘렸다.
    let Some(png) = rasterize_svg_fragment_to_png(svg_fragment, x, y, width, height, raster_scale)
    else {
        return false;
    };
    draw_image_bytes(
        canvas,
        &png,
        x,
        y,
        width,
        height,
        Some(ImageFillMode::FitToSize),
        None,
        None,
        None,
        ImageEffect::RealPic,
        sampling,
        false,
        false,
    )
}

pub fn draw_image_bytes(
    canvas: &skia_safe::Canvas,
    bytes: &[u8],
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    fill_mode: Option<ImageFillMode>,
    original_size: Option<(f64, f64)>,
    crop: Option<(i32, i32, i32, i32)>,
    crop_reference_size: Option<(u32, u32)>,
    effect: ImageEffect,
    sampling: ImageSampling,
    has_shadow: bool,
    is_picture: bool,
) -> bool {
    let is_valid_destination_rect = |x: f32, y: f32, width: f32, height: f32| {
        x.is_finite()
            && y.is_finite()
            && width.is_finite()
            && height.is_finite()
            && width > 0.0
            && height > 0.0
    };
    let is_valid_image_size = |width: f32, height: f32| {
        width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0
    };
    let grayscale_filter = |scale: f32, translate: f32| {
        let r = 0.299 * scale;
        let g = 0.587 * scale;
        let b = 0.114 * scale;
        color_filters::matrix_row_major(
            &[
                r, g, b, 0.0, translate, r, g, b, 0.0, translate, r, g, b, 0.0, translate, 0.0,
                0.0, 0.0, 1.0, 0.0,
            ],
            None,
        )
    };
    let image_effect_filter = |effect: ImageEffect| match effect {
        ImageEffect::RealPic => None,
        ImageEffect::GrayScale => Some(grayscale_filter(1.0, 0.0)),
        ImageEffect::BlackWhite => Some(grayscale_filter(255.0, -127.5)),
        ImageEffect::Pattern8x8 => Some(grayscale_filter(1.0, 0.0)),
    };
    let resolve_image_placement = |fill_mode: ImageFillMode,
                                   x: f32,
                                   y: f32,
                                   width: f32,
                                   height: f32,
                                   image_width: f32,
                                   image_height: f32| {
        match fill_mode {
            ImageFillMode::LeftTop => (x, y),
            ImageFillMode::CenterTop => (x + (width - image_width) / 2.0, y),
            ImageFillMode::RightTop => (x + width - image_width, y),
            ImageFillMode::LeftCenter => (x, y + (height - image_height) / 2.0),
            ImageFillMode::Center => (
                x + (width - image_width) / 2.0,
                y + (height - image_height) / 2.0,
            ),
            ImageFillMode::RightCenter => {
                (x + width - image_width, y + (height - image_height) / 2.0)
            }
            ImageFillMode::LeftBottom => (x, y + height - image_height),
            ImageFillMode::CenterBottom => {
                (x + (width - image_width) / 2.0, y + height - image_height)
            }
            ImageFillMode::RightBottom => (x + width - image_width, y + height - image_height),
            _ => (x, y),
        }
    };
    let draw_missing_image_placeholder = |x: f32, y: f32, width: f32, height: f32| {
        let rect = Rect::from_xywh(x, y, width, height);
        let mut fill = Paint::default();
        fill.set_anti_alias(true);
        fill.set_style(skia_safe::paint::Style::Fill);
        fill.set_color(Color::from_argb(48, 96, 96, 96));
        canvas.draw_rect(rect, &fill);

        let mut stroke = Paint::default();
        stroke.set_anti_alias(true);
        stroke.set_style(skia_safe::paint::Style::Stroke);
        stroke.set_stroke_width(1.0);
        stroke.set_color(Color::from_argb(160, 96, 96, 96));
        canvas.draw_rect(rect, &stroke);
    };

    if !is_valid_destination_rect(x, y, width, height) {
        return false;
    }
    let normalized_bytes = if detect_image_mime_type(bytes) == "image/jpeg" {
        grayscale_jpeg_bytes_to_png_bytes(bytes)
    } else {
        None
    };
    let encoded_bytes = normalized_bytes.as_deref().unwrap_or(bytes);

    // 한컴 PDF는 투명 PNG의 RGB와 마스크를 따로 보간한다. Unpremul 이미지로 그려야
    // 투명한 검정 픽셀과 흰 영역 사이의 회색 경계가 보존된다. 완전 불투명한 그림은
    // Unpremul 강제 시 그려지지 않으므로 기본 디코딩을 유지한다.
    let has_transparency = detect_image_mime_type(encoded_bytes) == "image/png"
        && image::load_from_memory(encoded_bytes)
            .map(|decoded| decoded.to_rgba8().pixels().any(|pixel| pixel[3] != 255))
            .unwrap_or(false);
    let Some(image) = (if has_transparency {
        Image::from_encoded_with_alpha_type(
            Data::new_copy(encoded_bytes),
            Some(AlphaType::Unpremul),
        )
    } else {
        Image::from_encoded(Data::new_copy(encoded_bytes))
    }) else {
        draw_missing_image_placeholder(x, y, width, height);
        return false;
    };

    let dst = Rect::from_xywh(x, y, width, height);
    let mut paint = Paint::default();
    paint.set_anti_alias(true);
    if let Some(color_filter) = image_effect_filter(effect) {
        paint.set_color_filter(color_filter);
    }

    let mode = fill_mode.unwrap_or(ImageFillMode::FitToSize);
    let decoded_width = image.width() as f32;
    let decoded_height = image.height() as f32;
    let crop_src = crop.and_then(|crop_rect| {
        if decoded_width <= 0.0 || decoded_height <= 0.0 {
            return None;
        }
        let (src_x, src_y, src_w, src_h) = crate::renderer::svg::compute_image_crop_src(
            crop_rect,
            crop_reference_size,
            decoded_width as f64,
            decoded_height as f64,
        );
        let (src_x, src_y, src_w, src_h) = (src_x as f32, src_y as f32, src_w as f32, src_h as f32);
        let is_cropped = src_x > 0.5
            || src_y > 0.5
            || (src_w - decoded_width).abs() > 1.0
            || (src_h - decoded_height).abs() > 1.0;
        if is_cropped && src_w > 0.0 && src_h > 0.0 {
            Some(Rect::from_xywh(src_x, src_y, src_w, src_h))
        } else {
            None
        }
    });

    let draw_image_rect = |src: Option<Rect>, dst: Rect| {
        let matrix = canvas.local_to_device_as_3x3();
        // 한컴 PDF는 그림 배치값을 600dpi 정수로 반올림한 뒤, 0.12pt를
        // 16.16 고정소수점(7864/65536)으로 변환한다. 레이아웃 bbox는 그대로 둔다.
        let dst = if is_picture && !has_shadow && matrix.is_scale_translate() {
            let quantize = |value: f32| {
                (((value as f64) * 600.0 / 96.0).round() * 7864.0 / 65536.0 * 96.0 / 72.0) as f32
            };
            Rect::from_xywh(
                quantize(dst.left),
                quantize(dst.top),
                quantize(dst.width()),
                quantize(dst.height()),
            )
        } else {
            dst
        };
        if is_picture
            && matches!(
                mode,
                ImageFillMode::FitToSize | ImageFillMode::Total | ImageFillMode::None
            )
            && matrix.is_scale_translate()
        {
            let (device, _) = matrix.map_rect(dst);
            let source = src.unwrap_or(Rect::from_xywh(0.0, 0.0, decoded_width, decoded_height));
            if device.width() > 0.0
                && device.height() > 0.0
                && device.width() < source.width()
                && device.height() < source.height()
            {
                let left = device.left.floor();
                let top = device.top.floor();
                let right = device.right.ceil();
                let bottom = device.bottom.ceil();
                if let Some(inverse) = matrix.invert() {
                    if let Some(pixels) = smooth_hermite_downsample(
                        encoded_bytes,
                        (source.left, source.top, source.right, source.bottom),
                        (right - left) as u32,
                        (bottom - top) as u32,
                    ) {
                        let raster_width = (right - left) as i32;
                        let raster_height = (bottom - top) as i32;
                        let info = ImageInfo::new(
                            (raster_width, raster_height),
                            ColorType::RGBA8888,
                            AlphaType::Unpremul,
                            None,
                        );
                        if let Some(resampled) = skia_safe::images::raster_from_data(
                            &info,
                            Data::new_copy(&pixels),
                            raster_width as usize * 4,
                        ) {
                            let snapped = inverse
                                .map_rect(Rect::from_xywh(left, top, right - left, bottom - top))
                                .0;
                            canvas.draw_image_rect_with_sampling_options(
                                &resampled,
                                None,
                                snapped,
                                SamplingOptions::new(FilterMode::Nearest, MipmapMode::None),
                                &paint,
                            );
                            return;
                        }
                    }
                }
            }
        }
        if is_picture
            && !has_shadow
            && matches!(
                mode,
                ImageFillMode::FitToSize | ImageFillMode::Total | ImageFillMode::None
            )
            && matrix.is_scale_translate()
        {
            let (device, _) = matrix.map_rect(dst);
            let source = src.unwrap_or(Rect::from_xywh(0.0, 0.0, decoded_width, decoded_height));
            if device.width() > source.width() || device.height() > source.height() {
                let left = device.left.floor();
                let top = device.top.floor();
                let right = device.right.ceil();
                let bottom = device.bottom.ceil();
                // PDF /Interpolate가 없는 두 배 초과 확대는 최근접 픽셀을 사용한다.
                let nearest = device.width() > source.width() * 2.0
                    || device.height() > source.height() * 2.0;
                if let Some(inverse) = matrix.invert() {
                    if let Some(pixels) = gridfit_affine_sample(
                        encoded_bytes,
                        (source.left, source.top, source.right, source.bottom),
                        (right - left) as u32,
                        (bottom - top) as u32,
                        nearest,
                    ) {
                        let raster_width = (right - left) as i32;
                        let raster_height = (bottom - top) as i32;
                        let info = ImageInfo::new(
                            (raster_width, raster_height),
                            ColorType::RGBA8888,
                            AlphaType::Unpremul,
                            None,
                        );
                        if let Some(resampled) = skia_safe::images::raster_from_data(
                            &info,
                            Data::new_copy(&pixels),
                            raster_width as usize * 4,
                        ) {
                            let snapped = inverse
                                .map_rect(Rect::from_xywh(left, top, right - left, bottom - top))
                                .0;
                            canvas.draw_image_rect_with_sampling_options(
                                &resampled,
                                None,
                                snapped,
                                SamplingOptions::new(FilterMode::Nearest, MipmapMode::None),
                                &paint,
                            );
                            return;
                        }
                    }
                }
            }
        }
        // MuPDF는 확대 이미지를 정수 디바이스 픽셀 경계까지 래스터한다.
        // 같은 범위를 사용해야 얇은 회색 선이 보간 중 사라지지 않는다.
        let dst = if matches!(
            mode,
            ImageFillMode::FitToSize | ImageFillMode::Total | ImageFillMode::None
        ) {
            let matrix = canvas.local_to_device_as_3x3();
            if matrix.is_scale_translate() {
                let (device, _) = matrix.map_rect(dst);
                let source_width = src.as_ref().map(Rect::width).unwrap_or(decoded_width);
                let source_height = src.as_ref().map(Rect::height).unwrap_or(decoded_height);
                if device.width() > source_width && device.height() > source_height {
                    if let Some(inverse) = matrix.invert() {
                        let snapped = Rect::from_xywh(
                            device.left.floor(),
                            device.top.floor(),
                            device.right.ceil() - device.left.floor(),
                            device.bottom.ceil() - device.top.floor(),
                        );
                        inverse.map_rect(snapped).0
                    } else {
                        dst
                    }
                } else {
                    dst
                }
            } else {
                dst
            }
        } else {
            dst
        };
        if let Some(src) = src.as_ref() {
            canvas.draw_image_rect_with_sampling_options(
                &image,
                Some((src, SrcRectConstraint::Strict)),
                dst,
                sampling.options(),
                &paint,
            );
        } else {
            canvas.draw_image_rect_with_sampling_options(
                &image,
                None,
                dst,
                sampling.options(),
                &paint,
            );
        }
    };

    if matches!(
        mode,
        ImageFillMode::FitToSize | ImageFillMode::Total | ImageFillMode::None
    ) {
        draw_image_rect(crop_src, dst);
        return true;
    }

    // 칸 채우기 None은 ImageNode 호출부가 Zoom으로 넘긴다. 쪽 배경 None은 위 늘려 채우기다.
    if mode == ImageFillMode::Zoom {
        if is_valid_image_size(decoded_width, decoded_height) {
            // 한컴은 ZOOM 채우기의 맞춤 배율을 정수 퍼센트로 올림한다.
            // 셀 경계를 넘는 부분은 원래 채우기 영역에서 잘린다.
            let scale =
                ((width / decoded_width).min(height / decoded_height) * 100.0).ceil() / 100.0;
            let fit_w = decoded_width * scale;
            let fit_h = decoded_height * scale;
            let fit = Rect::from_xywh(
                x + (width - fit_w).max(0.0) / 2.0,
                y + (height - fit_h).max(0.0) / 2.0,
                fit_w,
                fit_h,
            );
            canvas.save();
            canvas.clip_rect(dst, None, Some(true));
            draw_image_rect(crop_src, fit);
            canvas.restore();
        } else {
            draw_image_rect(crop_src, dst);
        }
        return true;
    }

    let image_width = original_size
        .map(|(width, _)| width as f32)
        .unwrap_or_else(|| image.width() as f32);
    let image_height = original_size
        .map(|(_, height)| height as f32)
        .unwrap_or_else(|| image.height() as f32);
    if !is_valid_image_size(image_width, image_height) {
        draw_missing_image_placeholder(x, y, width, height);
        return false;
    }

    canvas.save();
    canvas.clip_rect(dst, None, Some(true));

    if matches!(
        mode,
        ImageFillMode::TileAll
            | ImageFillMode::Total
            | ImageFillMode::TileHorzTop
            | ImageFillMode::TileHorzBottom
            | ImageFillMode::TileVertLeft
            | ImageFillMode::TileVertRight
    ) {
        let shader_image = crop_src
            .and_then(|src| {
                let left = src.left.floor().max(0.0) as i32;
                let top = src.top.floor().max(0.0) as i32;
                let right = src.right.ceil().min(decoded_width) as i32;
                let bottom = src.bottom.ceil().min(decoded_height) as i32;
                if right <= left || bottom <= top {
                    return None;
                }
                image.make_subset(
                    None,
                    IRect::from_xywh(left, top, right - left, bottom - top),
                    RequiredProperties::default(),
                )
            })
            .unwrap_or_else(|| image.clone());
        let shader_source_width = shader_image.width() as f32;
        let shader_source_height = shader_image.height() as f32;
        let draw_tiled_shader = |tile_rect: Rect, origin_x: f32, origin_y: f32| -> bool {
            if shader_source_width <= 0.0 || shader_source_height <= 0.0 {
                return false;
            }
            let scale_x = shader_source_width / image_width;
            let scale_y = shader_source_height / image_height;
            if !scale_x.is_finite() || !scale_y.is_finite() || scale_x <= 0.0 || scale_y <= 0.0 {
                return false;
            }
            let local_matrix = Matrix::scale_translate(
                (scale_x, scale_y),
                (-origin_x * scale_x, -origin_y * scale_y),
            );
            let Some(shader) = shader_image.to_shader(
                Some((TileMode::Repeat, TileMode::Repeat)),
                sampling.options(),
                Some(&local_matrix),
            ) else {
                return false;
            };
            let mut shader_paint = paint.clone();
            shader_paint.set_shader(shader);
            canvas.draw_rect(tile_rect, &shader_paint);
            true
        };

        if matches!(mode, ImageFillMode::TileAll | ImageFillMode::Total)
            && draw_tiled_shader(dst, x, y)
        {
            canvas.restore();
            return true;
        }
        if matches!(
            mode,
            ImageFillMode::TileHorzTop | ImageFillMode::TileHorzBottom
        ) {
            let tile_y = if matches!(mode, ImageFillMode::TileHorzTop) {
                y
            } else {
                y + height - image_height
            };
            if draw_tiled_shader(Rect::from_xywh(x, tile_y, width, image_height), x, tile_y) {
                canvas.restore();
                return true;
            }
        }
        if matches!(
            mode,
            ImageFillMode::TileVertLeft | ImageFillMode::TileVertRight
        ) {
            let tile_x = if matches!(mode, ImageFillMode::TileVertLeft) {
                x
            } else {
                x + width - image_width
            };
            if draw_tiled_shader(Rect::from_xywh(tile_x, y, image_width, height), tile_x, y) {
                canvas.restore();
                return true;
            }
        }
        canvas.restore();
        return false;
    } else {
        let (image_x, image_y) =
            resolve_image_placement(mode, x, y, width, height, image_width, image_height);
        draw_image_rect(
            crop_src,
            Rect::from_xywh(image_x, image_y, image_width, image_height),
        );
    }

    canvas.restore();
    true
}

fn rasterize_svg_fragment_to_png(
    svg_fragment: &str,
    src_x: f32,
    src_y: f32,
    width: f32,
    height: f32,
    raster_scale: f32,
) -> Option<Vec<u8>> {
    if svg_fragment.is_empty()
        || svg_fragment.len() > MAX_SVG_FRAGMENT_BYTES
        || !src_x.is_finite()
        || !src_y.is_finite()
        || !width.is_finite()
        || !height.is_finite()
        || !raster_scale.is_finite()
        || width <= 0.0
        || height <= 0.0
        || raster_scale <= 0.0
    {
        return None;
    }
    let output_width = width * raster_scale;
    let output_height = height * raster_scale;
    let raster_width = output_width.ceil() as u64;
    let raster_height = output_height.ceil() as u64;
    if raster_width
        .checked_mul(raster_height)
        .is_none_or(|pixels| pixels > MAX_SVG_RASTER_PIXELS)
    {
        return None;
    }

    // [Issue #2292] 조각은 페이지 절대 좌표 — viewBox 를 조각의 페이지 좌표
    // 창(src_x, src_y 원점)으로 지정해 bbox 영역만 (0,0) 래스터로 사상한다.
    let svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{output_width:.2}\" height=\"{output_height:.2}\" viewBox=\"{src_x:.2} {src_y:.2} {width:.2} {height:.2}\">{svg_fragment}</svg>"
    );
    let options = svg_parse_options();
    let tree = usvg::Tree::from_str(&svg, &options).ok()?;
    let size = tree.size().to_int_size();
    let pixels = u64::from(size.width()).checked_mul(u64::from(size.height()))?;
    if pixels == 0 || pixels > MAX_SVG_RASTER_PIXELS {
        return None;
    }

    let mut pixmap = tiny_skia::Pixmap::new(size.width(), size.height())?;
    resvg::render(&tree, tiny_skia::Transform::default(), &mut pixmap.as_mut());
    pixmap.encode_png().ok()
}

fn svg_parse_options() -> usvg::Options<'static> {
    let mut options = usvg::Options::default();
    options.resources_dir = None;
    options.image_href_resolver = usvg::ImageHrefResolver {
        resolve_data: usvg::ImageHrefResolver::default_data_resolver(),
        resolve_string: Box::new(|_, _| None),
    };
    options.fontdb = svg_fontdb();
    options
}

fn svg_fontdb() -> Arc<usvg::fontdb::Database> {
    static SVG_FONTDB: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();

    SVG_FONTDB
        .get_or_init(|| {
            // [Issue #2293] PDF 경로(renderer/pdf.rs::create_fontdb)와 동일
            // 규약: 시스템 폰트 + 프로젝트 ttfs/(재귀) + WSL 윈도우 폰트.
            // 종전에는 시스템 폰트만 로드하고 generic 폴백을 존재 확인 없이
            // 하드 고정("Noto Sans CJK KR")해, 해당 폰트가 없는 환경에서
            // resvg 가 조각의 텍스트를 통째로 드롭했다.
            let mut fontdb = usvg::fontdb::Database::new();
            fontdb.load_system_fonts();
            // [#2864] 조달 순서는 renderer::font_paths 가 단일 정의한다.
            // ttfs/opensource 번들이 최후 폴백으로 남아 한국어 드롭을 막는다(#2293).
            crate::renderer::font_paths::load_into_fontdb(&mut fontdb, &[]);

            // generic 폴백은 실존하는 첫 후보로 (매칭 실패 = 텍스트 드롭 방지).
            let sans = first_existing_family(
                &fontdb,
                &[
                    "Noto Sans CJK KR",
                    "Noto Sans KR",
                    "함초롬돋움",
                    "HCR Dotum",
                    "맑은 고딕",
                    "Malgun Gothic",
                    "NanumGothic",
                    "나눔고딕",
                    "DejaVu Sans",
                ],
            );
            // [작업지시자 권고] 폴백은 한국어 가용 폰트를 우선한다 — 스타일
            // (serif/mono) 정합보다 한글이 보이는 것이 우선이므로, 라틴 전용
            // 최후 폴백(DejaVu) 앞에 한국어 sans 를 둔다. 저장소 체크아웃에는
            // ttfs/opensource/NotoSansKR 이 항상 있어 한국어 폴백이 보장된다.
            let serif = first_existing_family(
                &fontdb,
                &[
                    "Noto Serif CJK KR",
                    "Noto Serif KR",
                    "함초롬바탕",
                    "HCR Batang",
                    "바탕",
                    "Batang",
                    "NanumMyeongjo",
                    "나눔명조",
                    "Noto Sans KR",
                    "DejaVu Serif",
                ],
            );
            let mono = first_existing_family(
                &fontdb,
                &[
                    "D2Coding",
                    "D2Coding ligature",
                    "Noto Sans KR",
                    "DejaVu Sans Mono",
                ],
            );
            if let Some(f) = sans {
                fontdb.set_sans_serif_family(f);
            }
            if let Some(f) = serif {
                fontdb.set_serif_family(f);
            }
            if let Some(f) = mono {
                fontdb.set_monospace_family(f);
            }
            Arc::new(fontdb)
        })
        .clone()
}

/// [Issue #2293] fontdb 에 실존하는 첫 패밀리 — 후보가 전부 없으면 None
/// (usvg 기본 generic 매핑 유지, 폴백 지정으로 오히려 드롭되는 것을 방지).
fn first_existing_family(fontdb: &usvg::fontdb::Database, candidates: &[&str]) -> Option<String> {
    let mut families = std::collections::HashSet::new();
    for face in fontdb.faces() {
        for (name, _) in &face.families {
            families.insert(name.clone());
        }
    }
    candidates
        .iter()
        .find(|c| families.contains(**c))
        .map(|c| c.to_string())
}

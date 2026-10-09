use std::cell::RefCell;
use std::io::Cursor;
use std::sync::Arc;

use crate::model::image::ImageEffect;
use crate::paint::{ResolvedImageKind, ResolvedImagePayload};
use crate::renderer::image_header::{
    canvaskit_encoded_image_header, CANVASKIT_MAX_IMAGE_DIMENSION, CANVASKIT_MAX_IMAGE_PIXELS,
};
use crate::renderer::render_tree::ImageNode;

// ── 변환 결과 메모 ──
//
// 편집 한 번에 레이어 트리가 여러 벌 만들어지고(본문 캔버스 / overlay / JSON),
// 그때마다 같은 그림이 다시 변환된다. JPEG 은 회색인지 알아내려고 **전체를 디코드**
// 하므로, 2MB 사진 한 장이 키 입력마다 수백 ms 를 먹었다 (#2520).
//
// 변환은 입력 바이트만으로 결과가 정해지는 순수 함수다. 그래서 내용 지문을 키로 쓰면
// 문서 쪽에서 무효화를 알려 줄 필요가 없다 — 바이트가 바뀌면 키가 바뀐다.
//
// 세 경로(paint/builder.rs, paint/json.rs, renderer/skia/image_conv.rs)와 svg·web_canvas·
// emf 경로는 모두 `&[u8]` 만 넘긴다. `bin_data_id` 로 키를 잡으려면 그 전부에 신원을
// 실어 날라야 하고, EMF 안에 박힌 BMP 처럼 애초에 BinData 가 아닌 그림도 있다.

/// 메모 상한(byte). 회색 JPEG 은 PNG 로 재인코딩한 결과를 들고 있어야 하므로 바이트로
/// 제한한다.
const MAX_MEMO_BYTES: usize = 16 * 1024 * 1024;

/// 항목 수 상한. 조회가 선형 탐색이라 항목 수도 묶는다. 긴 문서를 한 번 훑는 동안
/// 변환 결과(BMP·회색 JPEG 의 PNG)가 밀려나 원본 전체를 다시 디코드하지 않을 만큼은 둔다.
const MAX_MEMO_ENTRIES: usize = 256;

/// 변환하지 않는 그림(`None`) 키 상한. 색 사진은 회색 판정에 원본 전체를 디코드하므로
/// 한 번 본 사진을 다시 디코드하지 않게 결과 항목보다 훨씬 많이 기억한다 (키 8 byte).
const MAX_MEMO_MISSES: usize = 4096;

/// 변환 종류. 같은 바이트라도 어떤 변환을 거쳤느냐에 따라 결과가 다르다.
#[derive(Clone, Copy, Hash)]
enum Conversion {
    Bmp,
    Pcx,
    Tiff,
    GrayscaleJpeg,
    /// 한컴 밝기·대비·효과 굽기. 같은 바이트라도 값마다 결과가 다르다.
    HancomAdjust {
        effect: u8,
        brightness: i8,
        contrast: i8,
    },
}

#[derive(Default)]
struct ConversionMemo {
    /// (키, 결과) — 접근 순서대로, 최근 것이 뒤.
    entries: Vec<(u64, Arc<[u8]>)>,
    /// 지금 들고 있는 결과 바이트 합.
    bytes: usize,
    /// 결과가 `None` 인 키 — 들어온 순서대로.
    misses: std::collections::VecDeque<u64>,
    miss_set: std::collections::HashSet<u64>,
}

impl ConversionMemo {
    fn get(&mut self, key: u64) -> Option<Option<Arc<[u8]>>> {
        if self.miss_set.contains(&key) {
            return Some(None);
        }
        let idx = self.entries.iter().position(|(k, _)| *k == key)?;
        let entry = self.entries.remove(idx);
        let hit = entry.1.clone();
        self.entries.push(entry);
        Some(Some(hit))
    }

    fn insert(&mut self, key: u64, value: Option<Arc<[u8]>>) {
        let Some(value) = value else {
            if self.miss_set.insert(key) {
                self.misses.push_back(key);
                if self.misses.len() > MAX_MEMO_MISSES {
                    if let Some(oldest) = self.misses.pop_front() {
                        self.miss_set.remove(&oldest);
                    }
                }
            }
            return;
        };
        let size = value.len();
        if size > MAX_MEMO_BYTES {
            return;
        }
        while self.bytes + size > MAX_MEMO_BYTES || self.entries.len() >= MAX_MEMO_ENTRIES {
            let (_, evicted) = self.entries.remove(0);
            self.bytes -= evicted.len();
        }
        self.bytes += size;
        self.entries.push((key, value));
    }
}

thread_local! {
    /// WASM 은 단일 스레드라 `thread_local` + `RefCell` 로 충분하다
    /// (`layout::text_measurement` 의 측정 캐시와 같은 방식).
    static CONVERSION_MEMO: RefCell<ConversionMemo> = RefCell::new(ConversionMemo::default());
}

// 실제로 변환을 수행한 횟수 — 메모가 듣는지 보는 테스트용.
#[cfg(test)]
thread_local! {
    static CONVERSIONS_RUN: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn memoized_shared(
    conversion: Conversion,
    data: &[u8],
    convert: impl FnOnce() -> Option<Vec<u8>>,
) -> Option<Arc<[u8]>> {
    let key = conversion_key(conversion, data);
    if let Some(hit) = CONVERSION_MEMO.with(|memo| memo.borrow_mut().get(key)) {
        return hit;
    }

    let converted = convert().map(Arc::from);
    #[cfg(test)]
    CONVERSIONS_RUN.with(|runs| runs.set(runs.get() + 1));
    CONVERSION_MEMO.with(|memo| memo.borrow_mut().insert(key, converted.clone()));
    converted
}

/// 내용 지문 — 바이트 전체를 해싱한다.
///
/// 앞뒤 일부만 뽑는 표본 키는 쓰지 않는다. 무압축 BMP 는 같은 치수면 길이가 정확히
/// 같고 고정 헤더 뒤에 원시 픽셀이 이어지므로, 위아래 여백이 균일한 두 그림이 길이·앞·뒤
/// 표본까지 전부 같아진다 — 가운데만 다른 그림이 남의 변환 결과를 받는다.
///
/// 해싱은 바이트 수에 비례하지만 상수가 작다. 3.7MB 기준 1.35ms(릴리스)로, 이 메모가
/// 없앤 285ms 짜리 JPEG 전체 디코드에 비하면 무시할 만하다. `blake3`(2.90ms)도 재 봤지만
/// 이 키는 세션 안에서만 쓰고 밖으로 나가지 않으므로 싼 쪽을 쓴다.
fn conversion_key(conversion: Conversion, data: &[u8]) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    conversion.hash(&mut hasher);
    data.hash(&mut hasher);
    hasher.finish()
}

pub(crate) fn resolve_image_payload(image: &ImageNode) -> Option<ResolvedImagePayload> {
    let data = image.data.as_deref()?;
    let mime = detect_image_mime_type(data);

    if let Some(data) = hancom_adjusted_picture_png_bytes_shared(
        data,
        image.effect,
        image.brightness,
        image.contrast,
    ) {
        return Some(ResolvedImagePayload {
            data,
            mime: "image/png",
            kind: ResolvedImageKind::BakedWatermark,
            suppress_effects: true,
        });
    }

    match mime {
        "image/bmp" => bmp_bytes_to_png_bytes_shared(data).map(|data| ResolvedImagePayload {
            data,
            mime: "image/png",
            kind: ResolvedImageKind::FormatConverted,
            suppress_effects: false,
        }),
        "image/x-pcx" => pcx_bytes_to_png_bytes_shared(data).map(|data| ResolvedImagePayload {
            data,
            mime: "image/png",
            kind: ResolvedImageKind::FormatConverted,
            suppress_effects: false,
        }),
        "image/tiff" => tiff_bytes_to_png_bytes_shared(data).map(|data| ResolvedImagePayload {
            data,
            mime: "image/png",
            kind: ResolvedImageKind::FormatConverted,
            suppress_effects: false,
        }),
        "image/jpeg" => {
            grayscale_jpeg_bytes_to_png_bytes_shared(data).map(|data| ResolvedImagePayload {
                data,
                mime: "image/png",
                kind: ResolvedImageKind::FormatConverted,
                suppress_effects: false,
            })
        }
        _ => None,
    }
}

pub(crate) fn image_node_with_resolved_payload(
    image: &ImageNode,
    resolved: Option<&ResolvedImagePayload>,
) -> ImageNode {
    let mut image = image.clone();
    if let Some(payload) = resolved {
        image.data = Some(payload.data.clone());
        if payload.suppress_effects {
            image.effect = ImageEffect::RealPic;
            image.brightness = 0;
            image.contrast = 0;
        }
    }
    image
}

/// BMP 바이트를 PNG 바이트로 재인코딩한다. 실패 시 None 반환.
///
/// 브라우저는 SVG `<image>` 내부의 `data:image/bmp` URI를 표준 지원하지 않으므로,
/// SVG 임베딩 전에 PNG로 변환해 호환성을 확보한다.
pub(crate) fn bmp_bytes_to_png_bytes(data: &[u8]) -> Option<Vec<u8>> {
    bmp_bytes_to_png_bytes_shared(data).map(|payload| payload.as_ref().to_vec())
}

fn bmp_bytes_to_png_bytes_shared(data: &[u8]) -> Option<Arc<[u8]>> {
    memoized_shared(Conversion::Bmp, data, || {
        use image::ImageFormat;

        let img = decode_image_with_format_limited(data, ImageFormat::Bmp)?;
        let mut out = Vec::new();
        img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .ok()?;
        Some(out)
    })
}

/// TIFF 바이트를 PNG 바이트로 재인코딩한다. 실패 시 None 반환.
///
/// 브라우저와 rsvg는 SVG `<image>` 내부의 `data:image/tiff` URI를 안정적으로
/// 렌더링하지 못하므로, SVG/Canvas/HTML 임베딩 전에 PNG로 변환한다.
pub(crate) fn tiff_bytes_to_png_bytes(data: &[u8]) -> Option<Vec<u8>> {
    tiff_bytes_to_png_bytes_shared(data).map(|payload| payload.as_ref().to_vec())
}

fn tiff_bytes_to_png_bytes_shared(data: &[u8]) -> Option<Arc<[u8]>> {
    memoized_shared(Conversion::Tiff, data, || {
        use image::ImageFormat;

        let img = decode_image_with_format_limited(data, ImageFormat::Tiff)?;
        let mut out = Vec::new();
        img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .ok()?;
        Some(out)
    })
}

/// Browser SVG/Canvas decoders can expose stale color planes in old Photoshop
/// grayscale JPEGs. Re-encode only visually gray JPEGs to PNG so color photos
/// keep the compact JPEG path.
pub(crate) fn grayscale_jpeg_bytes_to_png_bytes(data: &[u8]) -> Option<Vec<u8>> {
    grayscale_jpeg_bytes_to_png_bytes_shared(data).map(|payload| payload.as_ref().to_vec())
}

fn grayscale_jpeg_bytes_to_png_bytes_shared(data: &[u8]) -> Option<Arc<[u8]>> {
    memoized_shared(Conversion::GrayscaleJpeg, data, || {
        grayscale_jpeg_bytes_to_png_bytes_uncached(data)
    })
}

fn grayscale_jpeg_bytes_to_png_bytes_uncached(data: &[u8]) -> Option<Vec<u8>> {
    use image::{DynamicImage, GrayImage, ImageFormat};

    if detect_image_mime_type(data) != "image/jpeg" {
        return None;
    }

    // 디코드한 채널 그대로 검사하고 인코딩한다. RGBA 로 넓히면 큰 사진 한 장이 디코드
    // 버퍼보다 큰 사본을 하나 더 잡고, WASM 선형 메모리는 그 최고점에서 줄지 않는다.
    let img = match decode_image_with_format_limited(data, ImageFormat::Jpeg)? {
        DynamicImage::ImageLuma8(gray) => DynamicImage::ImageLuma8(gray),
        decoded => {
            let rgb = decoded.into_rgb8();
            let has_photoshop_profile = data
                .windows(b"Adobe Photoshop".len())
                .any(|chunk| chunk == b"Adobe Photoshop")
                || data
                    .windows(b"Adobe_CM".len())
                    .any(|chunk| chunk == b"Adobe_CM");
            let is_gray = rgb.pixels().all(|px| {
                let [r, g, b] = px.0;
                let min = r.min(g).min(b);
                let max = r.max(g).max(b);
                max.saturating_sub(min) <= 2
            });
            let is_luma_plane_gray = has_photoshop_profile
                && rgb.pixels().all(|px| {
                    let [_, g, b] = px.0;
                    g.abs_diff(128) <= 2 && b.abs_diff(128) <= 2
                });
            if is_luma_plane_gray {
                let (width, height) = rgb.dimensions();
                let luma = rgb.pixels().map(|px| px.0[0]).collect();
                DynamicImage::ImageLuma8(GrayImage::from_raw(width, height, luma)?)
            } else if is_gray {
                DynamicImage::ImageRgb8(rgb)
            } else {
                return None;
            }
        }
    };
    if img.width() == 0 || img.height() == 0 {
        return None;
    }

    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .ok()?;
    Some(out)
}

/// PCX 바이트를 PNG 바이트로 재인코딩한다. 실패 시 None 반환.
///
/// 브라우저는 PCX 포맷을 native 렌더링하지 못하므로 (구형 ZSoft Paintbrush 포맷),
/// SVG 임베딩 전에 PNG로 변환해 호환성을 확보한다.
/// paletted PCX (8bpp) 와 RGB PCX (24bpp) 모두 지원.
///
/// **투명 처리**: PCX 자체는 알파 채널을 지원하지 않지만, HWP 의 PCX 임베드는
/// 보통 BehindText (글뒤로) 배경/로고 용도로 흰색 (255,255,255) 영역을 투명으로
/// 보여야 한다 (한컴 호환). 변환 시 흰색 픽셀을 투명 알파로 매핑한 RGBA PNG 를
/// 출력한다.
pub(crate) fn pcx_bytes_to_png_bytes(data: &[u8]) -> Option<Vec<u8>> {
    pcx_bytes_to_png_bytes_shared(data).map(|payload| payload.as_ref().to_vec())
}

fn pcx_bytes_to_png_bytes_shared(data: &[u8]) -> Option<Arc<[u8]>> {
    memoized_shared(Conversion::Pcx, data, || {
        pcx_bytes_to_png_bytes_uncached(data)
    })
}

fn pcx_bytes_to_png_bytes_uncached(data: &[u8]) -> Option<Vec<u8>> {
    use image::{ImageFormat, RgbaImage};

    let mut reader = pcx::Reader::new(Cursor::new(data)).ok()?;
    let width = reader.width() as u32;
    let height = reader.height() as u32;
    let pixels = u64::from(width).checked_mul(u64::from(height))?;
    if width == 0
        || height == 0
        || width > CANVASKIT_MAX_IMAGE_DIMENSION
        || height > CANVASKIT_MAX_IMAGE_DIMENSION
        || pixels > CANVASKIT_MAX_IMAGE_PIXELS
    {
        return None;
    }
    let pixel_count = usize::try_from(pixels).ok()?;
    let mut rgba = vec![0u8; pixel_count.checked_mul(4)?];
    if reader.is_paletted() {
        let row_bytes = width as usize;
        let mut indices = vec![0u8; row_bytes * height as usize];
        for y in 0..height as usize {
            reader
                .next_row_paletted(&mut indices[y * row_bytes..(y + 1) * row_bytes])
                .ok()?;
        }
        let mut palette = vec![0u8; 256 * 3];
        reader.read_palette(&mut palette).ok()?;
        for (dst, &idx) in rgba.chunks_exact_mut(4).zip(indices.iter()) {
            let p = idx as usize * 3;
            let r = palette[p];
            let g = palette[p + 1];
            let b = palette[p + 2];
            dst[0] = r;
            dst[1] = g;
            dst[2] = b;
            dst[3] = if r == 255 && g == 255 && b == 255 {
                0
            } else {
                255
            };
        }
    } else {
        let row_bytes_rgb = width as usize * 3;
        let mut rgb_row = vec![0u8; row_bytes_rgb];
        for y in 0..height as usize {
            reader.next_row_rgb(&mut rgb_row).ok()?;
            for (x, src) in rgb_row.chunks_exact(3).enumerate() {
                let dst = &mut rgba[(y * width as usize + x) * 4..(y * width as usize + x) * 4 + 4];
                dst[0] = src[0];
                dst[1] = src[1];
                dst[2] = src[2];
                dst[3] = if src[0] == 255 && src[1] == 255 && src[2] == 255 {
                    0
                } else {
                    255
                };
            }
        }
    }
    let img = RgbaImage::from_raw(width, height, rgba)?;
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .ok()?;
    Some(out)
}

/// 그림 밝기·대비·효과를 한컴 방식으로 픽셀에 굽어야 하는가.
///
/// 한컴은 밝기·대비가 하나라도 0 이 아니면 효과와 상관없이 보정한 픽셀을 그린다.
/// 그림 개체·쪽 배경·채우기 모두 같고, 워터마크라고 반투명을 더하지 않는다
/// (한컴 Mac PDF 실측: 그림 RealPic/회색조, 테두리 채우기 RealPic 70/-50).
pub(crate) fn needs_hancom_picture_adjustment(brightness: i8, contrast: i8) -> bool {
    brightness != 0 || contrast != 0
}

/// 밝기·대비·효과를 한컴 방식으로 적용한 PNG 를 만든다. 대상이 아니거나 디코드할 수
/// 없는 형식이면 None.
pub(crate) fn hancom_adjusted_picture_png_bytes(
    data: &[u8],
    effect: ImageEffect,
    brightness: i8,
    contrast: i8,
) -> Option<Vec<u8>> {
    hancom_adjusted_picture_png_bytes_shared(data, effect, brightness, contrast)
        .map(|payload| payload.as_ref().to_vec())
}

fn hancom_adjusted_picture_png_bytes_shared(
    data: &[u8],
    effect: ImageEffect,
    brightness: i8,
    contrast: i8,
) -> Option<Arc<[u8]>> {
    if !needs_hancom_picture_adjustment(brightness, contrast) {
        return None;
    }
    let conversion = Conversion::HancomAdjust {
        effect: effect as u8,
        brightness,
        contrast,
    };
    memoized_shared(conversion, data, || {
        hancom_adjusted_picture_png_bytes_uncached(data, effect, brightness, contrast)
    })
}

/// 한 채널에 한컴 밝기·대비를 적용한다.
///
/// 한컴 Mac PDF 가 굽는 그림 픽셀에서 실측한 식 (램프 그림 13조합, 오차 ±1):
/// `k = 1 + 대비/100`, `B = 밝기 × 255/100` 일 때 `floor(k·v + 128·(1−k) + s·B)`.
/// 대비가 음수면 밝기 몫이 `s = (1+k)/2` 로 줄고, 0 이상이면 `s = 1` 이다.
fn hancom_adjust_channel(value: u8, brightness: i8, contrast: i8) -> u8 {
    let brightness = f64::from(brightness.clamp(-100, 100));
    let contrast = f64::from(contrast.clamp(-100, 100));
    let k = (100.0 + contrast) / 100.0;
    let brightness_offset = brightness * 255.0 / 100.0;
    let brightness_share = if contrast < 0.0 { (1.0 + k) / 2.0 } else { 1.0 };
    let adjusted = k * f64::from(value) + 128.0 * (1.0 - k) + brightness_share * brightness_offset;
    (adjusted + 1e-6).floor().clamp(0.0, 255.0) as u8
}

fn hancom_adjusted_picture_png_bytes_uncached(
    data: &[u8],
    effect: ImageEffect,
    brightness: i8,
    contrast: i8,
) -> Option<Vec<u8>> {
    use image::ImageFormat;

    let format = match detect_image_mime_type(data) {
        "image/jpeg" => ImageFormat::Jpeg,
        "image/png" => ImageFormat::Png,
        "image/bmp" => ImageFormat::Bmp,
        "image/gif" => ImageFormat::Gif,
        "image/tiff" => ImageFormat::Tiff,
        "image/webp" => ImageFormat::WebP,
        _ => return None,
    };
    let mut img = decode_image_with_format_limited(data, format)?.to_rgba8();
    if img.width() == 0 || img.height() == 0 {
        return None;
    }

    let table: [u8; 256] =
        std::array::from_fn(|value| hancom_adjust_channel(value as u8, brightness, contrast));
    for px in img.pixels_mut() {
        let [r, g, b, a] = px.0;
        let [r, g, b] = [table[r as usize], table[g as usize], table[b as usize]];
        // 효과는 보정 뒤 채널에 적용한다. 회색조는 BT.601 가중치, 흑백은 회색 129 이상이 흰색.
        let gray = 0.299 * f64::from(r) + 0.587 * f64::from(g) + 0.114 * f64::from(b);
        px.0 = match effect {
            ImageEffect::RealPic => [r, g, b, a],
            ImageEffect::GrayScale | ImageEffect::Pattern8x8 => {
                let gray = (gray + 1e-6).floor() as u8;
                [gray, gray, gray, a]
            }
            ImageEffect::BlackWhite => {
                let bw = if gray >= 129.0 { 255 } else { 0 };
                [bw, bw, bw, a]
            }
        };
    }

    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .ok()?;
    Some(out)
}

/// 이미지 데이터에서 MIME 타입 감지
pub(crate) fn detect_image_mime_type(data: &[u8]) -> &'static str {
    if data.len() >= 8 {
        if data.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
            return "image/png";
        }
        if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
            return "image/jpeg";
        }
        if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
            return "image/gif";
        }
        if data.starts_with(&[0x42, 0x4D]) {
            return "image/bmp";
        }
        if data.starts_with(&[0xD7, 0xCD, 0xC6, 0x9A])
            || data.starts_with(&[0x01, 0x00, 0x09, 0x00])
        {
            return "image/x-wmf";
        }
        if data.starts_with(&[0x49, 0x49, 0x2A, 0x00])
            || data.starts_with(&[0x4D, 0x4D, 0x00, 0x2A])
        {
            return "image/tiff";
        }
    }
    if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        return "image/webp";
    }
    if data.len() >= 2 && data.starts_with(&[0x0A, 0x05]) {
        return "image/x-pcx";
    }
    "application/octet-stream"
}

fn decode_image_with_format_limited(
    data: &[u8],
    format: image::ImageFormat,
) -> Option<image::DynamicImage> {
    if matches!(
        format,
        image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::Bmp
    ) && !canvaskit_encoded_image_header(data).is_some_and(|header| {
        header.is_within_decode_limits()
            && matches!(
                (format, header.format),
                (
                    image::ImageFormat::Png,
                    crate::renderer::image_header::CanvasKitEncodedImageFormat::Png
                ) | (
                    image::ImageFormat::Jpeg,
                    crate::renderer::image_header::CanvasKitEncodedImageFormat::Jpeg
                ) | (
                    image::ImageFormat::Bmp,
                    crate::renderer::image_header::CanvasKitEncodedImageFormat::Bmp
                )
            )
    }) {
        return None;
    }

    let mut reader = image::ImageReader::with_format(Cursor::new(data), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(CANVASKIT_MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(CANVASKIT_MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(CANVASKIT_MAX_IMAGE_PIXELS.saturating_mul(4));
    reader.limits(limits);
    reader.decode().ok()
}

#[cfg(test)]
mod tests {
    use super::{
        bmp_bytes_to_png_bytes, grayscale_jpeg_bytes_to_png_bytes,
        hancom_adjusted_picture_png_bytes, resolve_image_payload, ConversionMemo, CONVERSIONS_RUN,
        MAX_MEMO_BYTES, MAX_MEMO_MISSES,
    };
    use crate::model::image::ImageEffect;
    use crate::paint::ResolvedImageKind;
    use crate::renderer::render_tree::ImageNode;
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
    use std::io::Cursor;

    fn jpeg_from_pixels(width: u32, height: u32, pixels: impl Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
        let mut img = RgbImage::new(width, height);
        for y in 0..height {
            for x in 0..width {
                img.put_pixel(x, y, Rgb(pixels(x, y)));
            }
        }

        let mut out = Vec::new();
        DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Jpeg)
            .expect("encode jpeg");
        out
    }

    /// 지금까지 실제로 수행된 변환 횟수.
    fn conversions_run() -> usize {
        CONVERSIONS_RUN.with(|runs| runs.get())
    }

    fn bmp_with_middle_band(mid: [u8; 3]) -> Vec<u8> {
        let mut img = RgbImage::new(64, 64);
        for y in 0..64u32 {
            for x in 0..64u32 {
                let px = if (24..40).contains(&y) {
                    Rgb(mid)
                } else {
                    Rgb([255, 255, 255])
                };
                img.put_pixel(x, y, px);
            }
        }

        let mut out = Vec::new();
        img.write_to(&mut Cursor::new(&mut out), ImageFormat::Bmp)
            .expect("encode bmp");
        out
    }

    /// 앞뒤 일부만 뽑는 표본 키는 다른 그림을 한 항목으로 묶는다.
    ///
    /// 무압축 BMP 는 같은 치수면 길이가 정확히 같고, 고정 헤더 뒤에 원시 픽셀이 아래에서
    /// 위로 이어진다. 위아래 여백이 같으면 길이·앞 4KiB·뒤 4KiB 가 전부 일치해, 가운데만
    /// 다른 두 그림이 남의 변환 결과를 받는다.
    #[test]
    fn images_sharing_length_and_edges_do_not_share_a_result() {
        let red = bmp_with_middle_band([200, 30, 30]);
        let blue = bmp_with_middle_band([30, 30, 200]);

        assert_ne!(red, blue);
        assert_eq!(red.len(), blue.len(), "같은 치수 무압축 BMP 는 길이가 같다");
        assert_eq!(&red[..4096], &blue[..4096], "앞 4KiB 가 같다");
        assert_eq!(
            &red[red.len() - 4096..],
            &blue[blue.len() - 4096..],
            "뒤 4KiB 가 같다"
        );

        let red_png = bmp_bytes_to_png_bytes(&red).expect("red bmp converts");
        let blue_png = bmp_bytes_to_png_bytes(&blue).expect("blue bmp converts");
        let decoded = image::load_from_memory(&blue_png)
            .expect("decode converted blue")
            .to_rgb8();

        assert_ne!(red_png, blue_png);
        assert_eq!(
            decoded.get_pixel(32, 32),
            &Rgb([30, 30, 200]),
            "파란 그림 자리에 빨간 그림이 나오면 안 된다"
        );
    }

    /// 같은 그림을 여러 번 해석해도 변환은 한 번만 한다 (#2520).
    ///
    /// 편집 한 번에 레이어 트리가 여러 벌 만들어져 같은 그림이 여러 번 들어온다.
    /// 색 사진은 결과가 `None` 이라 종전에는 **전체 디코드 결과를 매번 버렸다** —
    /// 2MB 사진 한 장에 키 입력당 수백 ms 가 들던 자리다.
    #[test]
    fn repeated_resolve_of_same_image_converts_once() {
        let jpeg = jpeg_from_pixels(24, 24, |x, y| [(x * 7) as u8, 40, (y * 9) as u8]);
        let image = ImageNode::new(1, Some(jpeg));

        let before = conversions_run();
        for _ in 0..3 {
            assert!(resolve_image_payload(&image).is_none());
        }
        assert_eq!(
            conversions_run() - before,
            1,
            "같은 그림은 한 번만 변환해야 한다"
        );
    }

    #[test]
    fn repeated_converted_image_payloads_share_the_cached_allocation() {
        let bmp = bmp_with_middle_band([80, 120, 160]);
        let image = ImageNode::new(1, Some(bmp));

        let first = resolve_image_payload(&image).expect("bmp should convert");
        let second = resolve_image_payload(&image).expect("bmp should hit memo");

        assert!(std::sync::Arc::ptr_eq(&first.data, &second.data));
        assert_eq!(first.data.len(), second.data.len());
    }

    /// 메모가 다른 그림의 결과를 흘리지 않는다.
    #[test]
    fn different_images_keep_their_own_results() {
        let gray = jpeg_from_pixels(2, 2, |x, y| {
            let g = 120 + (x + y) as u8;
            [g, g, g]
        });
        let color = jpeg_from_pixels(2, 2, |x, y| {
            if (x + y) % 2 == 0 {
                [210, 48, 48]
            } else {
                [48, 110, 210]
            }
        });

        assert!(grayscale_jpeg_bytes_to_png_bytes(&gray).is_some());
        assert!(grayscale_jpeg_bytes_to_png_bytes(&color).is_none());
        // 순서를 바꿔도 각자의 결과가 나온다 (둘 다 메모에 들어간 뒤).
        assert!(grayscale_jpeg_bytes_to_png_bytes(&color).is_none());
        assert!(grayscale_jpeg_bytes_to_png_bytes(&gray).is_some());
    }

    /// 같은 바이트라도 변환 종류가 다르면 결과가 다르므로 따로 센다.
    #[test]
    fn same_bytes_under_different_conversions_do_not_share_an_entry() {
        let jpeg = jpeg_from_pixels(12, 12, |x, y| {
            let g = 200 + ((x + y) % 8) as u8;
            [g, g, g]
        });

        let before = conversions_run();
        let _ = grayscale_jpeg_bytes_to_png_bytes(&jpeg);
        let _ = hancom_adjusted_picture_png_bytes(&jpeg, ImageEffect::GrayScale, 70, -50);
        assert_eq!(
            conversions_run() - before,
            2,
            "변환 종류가 다르면 메모 항목도 달라야 한다"
        );
    }

    /// 메모는 상한 안에서만 자란다 — 오래된 것부터 밀려난다.
    #[test]
    fn memo_stays_within_its_byte_budget() {
        let mut memo = ConversionMemo::default();
        let chunk = MAX_MEMO_BYTES / 4 + 1;
        for key in 0..8u64 {
            memo.insert(key, Some(vec![0u8; chunk].into()));
        }

        assert!(memo.bytes <= MAX_MEMO_BYTES);
        assert!(memo.get(0).is_none(), "가장 오래된 항목은 밀려나 있다");
        assert!(memo.get(7).is_some(), "가장 최근 항목은 남아 있다");
    }

    /// 결과가 `None` 인 키는 바이트를 차지하지 않으므로 키 수로 묶는다.
    #[test]
    fn memo_bounds_miss_count() {
        let mut memo = ConversionMemo::default();
        for key in 0..(MAX_MEMO_MISSES as u64 * 2) {
            memo.insert(key, None);
        }

        assert_eq!(memo.bytes, 0);
        assert_eq!(memo.misses.len(), MAX_MEMO_MISSES);
        assert_eq!(memo.miss_set.len(), MAX_MEMO_MISSES);
        assert!(memo.get(0).is_none(), "가장 오래된 키는 밀려나 있다");
        assert!(matches!(
            memo.get(MAX_MEMO_MISSES as u64 * 2 - 1),
            Some(None)
        ));
    }

    #[test]
    fn grayscale_jpeg_is_normalized_to_png() {
        let jpeg = jpeg_from_pixels(2, 2, |x, y| {
            let g = 180 + (x + y) as u8;
            [g, g, g]
        });

        let png = grayscale_jpeg_bytes_to_png_bytes(&jpeg).expect("gray jpeg should normalize");
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
    }

    #[test]
    fn color_jpeg_keeps_jpeg_path() {
        let jpeg = jpeg_from_pixels(2, 2, |x, y| {
            if (x + y) % 2 == 0 {
                [220, 64, 64]
            } else {
                [64, 120, 220]
            }
        });

        assert!(grayscale_jpeg_bytes_to_png_bytes(&jpeg).is_none());
    }

    #[test]
    fn tiff_image_payload_is_normalized_to_png() {
        let mut img = RgbImage::new(2, 2);
        for y in 0..2 {
            for x in 0..2 {
                img.put_pixel(x, y, Rgb([32 + x as u8, 96 + y as u8, 160]));
            }
        }
        let mut tiff = Vec::new();
        DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut tiff), ImageFormat::Tiff)
            .expect("encode tiff");

        let image = ImageNode::new(1, Some(tiff));
        let resolved = resolve_image_payload(&image).expect("tiff should resolve");

        assert_eq!(resolved.mime, "image/png");
        assert_eq!(resolved.kind, ResolvedImageKind::FormatConverted);
        assert!(resolved.data.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(!resolved.suppress_effects);
    }

    #[test]
    fn oversized_compact_bmp_is_rejected_before_layer_conversion() {
        let mut bmp = vec![0u8; 58];
        bmp[..2].copy_from_slice(b"BM");
        bmp[2..6].copy_from_slice(&58u32.to_le_bytes());
        bmp[10..14].copy_from_slice(&54u32.to_le_bytes());
        bmp[14..18].copy_from_slice(&40u32.to_le_bytes());
        bmp[18..22].copy_from_slice(&8193i32.to_le_bytes());
        bmp[22..26].copy_from_slice(&8193i32.to_le_bytes());
        bmp[26..28].copy_from_slice(&1u16.to_le_bytes());
        bmp[28..30].copy_from_slice(&8u16.to_le_bytes());
        bmp[30..34].copy_from_slice(&1u32.to_le_bytes());
        bmp[54..58].copy_from_slice(&[0, 1, 0, 1]);

        assert!(bmp_bytes_to_png_bytes(&bmp).is_none());
        assert!(resolve_image_payload(&ImageNode::new(1, Some(bmp))).is_none());
    }
}

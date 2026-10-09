//! Web Canvas 그림 캐시 (WASM 전용)
//!
//! 문서 그림을 브라우저가 디코드한 `ImageBitmap` 하나로 보관한다. 래스터는 `createImageBitmap`
//! 이 메인 스레드 밖에서 디코드하고, SVG(WMF 변환·RawSvg 포함)는 `<img>` 로 읽어 필요한
//! 크기로 래스터화한다. 크기는 화면 장치 픽셀에 맞춘 √2 단계로 받아 줌을 조금 바꿀 때마다
//! 다시 디코드하지 않는다. 예산은 디코드된 바이트(w×h×4)로 세고, 밀려난 비트맵은 바로 `close()` 한다.
//!
//! 디코드는 비동기라 첫 렌더는 그림 없이(또는 작은 단계로) 그려질 수 있다. 렌더러는 그런 그림
//! 수를 세어 돌려주고, 디코드가 끝나면 등록된 JS 리스너를 불러 Studio 가 해당 쪽을 다시 그린다.

use std::cell::RefCell;
use std::collections::HashMap;

use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    Blob, BlobPropertyBag, ColorSpaceConversion, HtmlImageElement, ImageBitmap, ImageBitmapOptions,
    OffscreenCanvas, OffscreenCanvasRenderingContext2d, ResizeQuality, Url,
};

/// 디코드된 그림 예산. 100%·dpr 2 에서 A4 한 쪽을 채우는 그림이 약 14 MiB 이므로, 보이는 쪽과
/// 이웃 쪽의 그림이 들어간다. 이전 두 캐시(래스터 67 MB + 상한 없는 `<img>` 비트맵)보다 작다.
const PICTURE_BUDGET_BYTES: usize = 64 * 1024 * 1024;
const PICTURE_MAX_ENTRIES: usize = 256;
/// 이 시간 안에 그린 그림은 예산을 넘어도 내보내지 않는다. 한 화면에 필요한 그림이 예산보다
/// 크면 디코드 → 내보냄 → 재요청이 끝없이 돌기 때문이다. 넘친 몫은 이 시간이 지난 뒤 정리한다.
const RECENT_USE_MS: f64 = 1000.0;
/// 디코드 폭탄 방어. 헤더가 이보다 큰 그림은 디코드하지 않는다.
const MAX_SOURCE_PIXELS: f64 = 100_000_000.0;
/// SVG 래스터 상한. 벡터라 원본 해상도 상한이 없으므로 따로 둔다.
const SVG_MAX_PIXELS: f64 = 16_777_216.0;
const SVG_MAX_SIDE: f64 = 8192.0;
const MIN_LEVEL: i32 = -40;
/// 실패한 단계가 없음을 뜻한다.
const NO_FAILURE: i32 = i32::MAX;

#[derive(Clone, Copy, PartialEq)]
enum SourceKind {
    /// 브라우저가 디코드하는 래스터. `raw_colors` 는 예전 image crate 디코드처럼 색 변환을 끈다.
    Raster {
        mime: &'static str,
        raw_colors: bool,
    },
    Pcx,
    /// 브라우저가 못 읽어 image crate 로 디코드한다.
    Tiff,
    Wmf,
    Svg,
}

/// 단계 L 은 기준 크기의 2^(L/2) 배다. 래스터의 기준은 원본 픽셀, SVG 의 기준은 처음 그린
/// 대상 크기(쪽 좌표)다.
fn level_size(base: (f64, f64), level: i32) -> (u32, u32) {
    let factor = 2f64.powf(level as f64 / 2.0);
    (
        (base.0 * factor).round().max(1.0) as u32,
        (base.1 * factor).round().max(1.0) as u32,
    )
}

fn level_for_scale(scale: f64) -> i32 {
    if !scale.is_finite() || scale <= 0.0 {
        return 0;
    }
    ((2.0 * scale.log2()) - 1e-6).ceil().max(MIN_LEVEL as f64) as i32
}

fn svg_max_level(base: (f64, f64)) -> i32 {
    let by_pixels = (SVG_MAX_PIXELS / (base.0 * base.1).max(1.0)).log2().floor();
    let by_side = (2.0 * (SVG_MAX_SIDE / base.0.max(base.1).max(1.0)).log2()).floor();
    by_pixels.min(by_side).max(MIN_LEVEL as f64) as i32
}

struct HeldBitmap {
    bitmap: ImageBitmap,
    level: i32,
    bytes: usize,
}

struct Entry {
    kind: SourceKind,
    base: Option<(f64, f64)>,
    held: Option<HeldBitmap>,
    /// 진행 중인 디코드 중 가장 높은 단계
    pending: Option<i32>,
    /// 이 단계 이상은 디코드에 실패했다.
    failed_from: i32,
    last_used: f64,
}

#[derive(Default)]
struct PictureCache {
    entries: HashMap<u64, Entry>,
    total_bytes: usize,
    in_flight: usize,
    trim_scheduled: bool,
}

impl PictureCache {
    fn release(&mut self, entry: &mut Entry) {
        if let Some(held) = entry.held.take() {
            held.bitmap.close();
            self.total_bytes = self.total_bytes.saturating_sub(held.bytes);
        }
    }

    /// 예산 안으로 줄인다. 최근에 그린 그림만 남아 줄일 수 없으면 true.
    fn trim(&mut self, now: f64) -> bool {
        loop {
            let over_bytes = self.total_bytes > PICTURE_BUDGET_BYTES;
            let over_entries = self.entries.len() > PICTURE_MAX_ENTRIES;
            if !over_bytes && !over_entries {
                return false;
            }
            let victim = self
                .entries
                .iter()
                .filter(|(_, entry)| {
                    entry.pending.is_none()
                        && now - entry.last_used >= RECENT_USE_MS
                        && (entry.held.is_some() || over_entries)
                })
                .min_by(|a, b| a.1.last_used.total_cmp(&b.1.last_used))
                .map(|(key, _)| *key);
            let Some(key) = victim else {
                return true;
            };
            if let Some(mut entry) = self.entries.remove(&key) {
                self.release(&mut entry);
                // 실패 표시와 기준 크기는 항목 수에 여유가 있으면 남긴다.
                if !over_entries && entry.failed_from != NO_FAILURE {
                    self.entries.insert(key, entry);
                }
            }
        }
    }
}

thread_local! {
    static CACHE: RefCell<PictureCache> = RefCell::new(PictureCache::default());
    static LISTENER: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
}

fn now_ms() -> f64 {
    js_sys::Date::now()
}

/// 그릴 그림. 비트맵 옆의 두 값은 기준 크기 1 당 비트맵 픽셀 수 (x, y)다.
pub(crate) struct PictureForDraw {
    pub bitmap: Option<(ImageBitmap, f64, f64)>,
    /// 더 나은 비트맵을 디코드하는 중이다. 끝나면 다시 그려야 한다.
    pub pending: bool,
}

/// 그림을 찾고, 없거나 화면보다 작으면 디코드를 건다.
///
/// `device` 는 대상 사각형의 장치 픽셀 크기, `dest` 는 쪽 좌표 크기, `src` 는 원본 픽셀 기준의
/// 잘라낼 크기(래스터만)다.
pub(crate) fn picture_for_draw(
    data: &[u8],
    device: (f64, f64),
    dest: (f64, f64),
    src: Option<(f64, f64)>,
) -> PictureForDraw {
    let key = hash_bytes(data);
    let now = now_ms();
    let request = CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        let entry = cache
            .entries
            .entry(key)
            .or_insert_with(|| new_entry(data, dest));
        entry.last_used = now;
        let need = needed_level(entry, device, src);
        let held_level = entry.held.as_ref().map(|held| held.level);
        let satisfied = held_level.is_some_and(|level| level >= need);
        let mut request = None;
        if !satisfied && entry.pending.is_none_or(|level| level < need) && need < entry.failed_from
        {
            entry.pending = Some(need);
            request = Some((entry.kind, entry.base, need));
        }
        let pending = !satisfied && entry.pending.is_some();
        let bitmap = match (&entry.held, entry.base) {
            (Some(held), Some(base)) => Some((
                held.bitmap.clone(),
                held.bitmap.width() as f64 / base.0,
                held.bitmap.height() as f64 / base.1,
            )),
            _ => None,
        };
        if request.is_some() {
            cache.in_flight += 1;
        }
        (request, PictureForDraw { bitmap, pending })
    });
    let (request, found) = request;
    if let Some((kind, base, level)) = request {
        start_decode(key, data, kind, base, level);
    }
    found
}

fn new_entry(data: &[u8], dest: (f64, f64)) -> Entry {
    let kind = source_kind(data);
    let base = match kind {
        SourceKind::Wmf | SourceKind::Svg => Some((dest.0.abs(), dest.1.abs())),
        SourceKind::Pcx => pcx_dimensions(data).map(|(w, h)| (w as f64, h as f64)),
        SourceKind::Tiff => image::ImageReader::new(std::io::Cursor::new(data))
            .with_guessed_format()
            .ok()
            .and_then(|reader| reader.into_dimensions().ok())
            .map(|(w, h)| (w as f64, h as f64)),
        SourceKind::Raster { .. } => super::web_canvas::parse_image_dimensions_canvas(data)
            .map(|(w, h)| (w as f64, h as f64)),
    }
    .map(|(w, h)| (w.max(1.0), h.max(1.0)));
    let too_large = matches!(
        kind,
        SourceKind::Raster { .. } | SourceKind::Pcx | SourceKind::Tiff
    ) && base.is_some_and(|(w, h)| w * h > MAX_SOURCE_PIXELS);
    Entry {
        kind,
        base,
        held: None,
        pending: None,
        failed_from: if too_large { MIN_LEVEL } else { NO_FAILURE },
        last_used: 0.0,
    }
}

fn needed_level(entry: &Entry, device: (f64, f64), src: Option<(f64, f64)>) -> i32 {
    // 원본 크기를 모르는 래스터는 원본 그대로 받아 기준 크기를 알아낸다.
    let Some(base) = entry.base else {
        return 0;
    };
    let (sw, sh) = match (entry.kind, src) {
        (SourceKind::Raster { .. } | SourceKind::Pcx | SourceKind::Tiff, Some(src)) => src,
        _ => base,
    };
    let scale = (device.0 / sw.max(1e-6)).max(device.1 / sh.max(1e-6));
    let level = level_for_scale(scale);
    match entry.kind {
        SourceKind::Wmf | SourceKind::Svg => level.min(svg_max_level(base)),
        // 래스터는 원본보다 크게 디코드하지 않는다.
        _ => level.min(0),
    }
}

fn source_kind(data: &[u8]) -> SourceKind {
    match detect_image_mime_type(data) {
        "image/x-wmf" => SourceKind::Wmf,
        "image/x-pcx" => SourceKind::Pcx,
        "image/tiff" => SourceKind::Tiff,
        "image/svg+xml" => SourceKind::Svg,
        mime @ ("image/png" | "image/jpeg" | "image/bmp") => SourceKind::Raster {
            mime,
            raw_colors: true,
        },
        mime => SourceKind::Raster {
            mime,
            raw_colors: false,
        },
    }
}

fn start_decode(key: u64, data: &[u8], kind: SourceKind, base: Option<(f64, f64)>, level: i32) {
    // 래스터 단계 0 은 원본 그대로 받는다.
    let target = base
        .filter(|_| level < 0 || matches!(kind, SourceKind::Wmf | SourceKind::Svg))
        .map(|base| level_size(base, level));
    let input = prepare_input(data, kind, target);
    wasm_bindgen_futures::spawn_local(async move {
        let result = match input {
            Ok(input) => decode(input).await,
            Err(error) => Err(error),
        };
        settle(key, level, result);
    });
}

enum DecodeInput {
    Raster {
        blob: Blob,
        options: ImageBitmapOptions,
    },
    Pixels {
        data: web_sys::ImageData,
        options: ImageBitmapOptions,
    },
    Svg {
        blob: Blob,
        size: (u32, u32),
    },
}

fn bitmap_options(target: Option<(u32, u32)>, raw_colors: bool) -> ImageBitmapOptions {
    let options = ImageBitmapOptions::new();
    if let Some((w, h)) = target {
        options.set_resize_width(w);
        options.set_resize_height(h);
        // 예전 경로(원본 비트맵을 canvas 기본 smoothing 으로 축소)와 같은 선명도를 낸다.
        // High 는 가는 선화(PCX 로고 등)를 회색으로 뭉갠다.
        options.set_resize_quality(ResizeQuality::Low);
    }
    if raw_colors {
        options.set_color_space_conversion(ColorSpaceConversion::None);
    }
    options
}

/// 원본 바이트를 JS Blob 으로 넘긴다. WASM 쪽에는 사본을 남기지 않는다.
fn blob_from_bytes(bytes: &[u8], mime: &str) -> Result<Blob, JsValue> {
    let bag = BlobPropertyBag::new();
    bag.set_type(mime);
    // view 는 WASM 메모리를 가리키므로 할당 없이 바로 Blob 생성자가 복사하게 한다.
    let view = unsafe { js_sys::Uint8Array::view(bytes) };
    let parts = js_sys::Array::of1(view.as_ref());
    Blob::new_with_u8_array_sequence_and_options(&parts, &bag)
}

fn prepare_input(
    data: &[u8],
    kind: SourceKind,
    target: Option<(u32, u32)>,
) -> Result<DecodeInput, JsValue> {
    match kind {
        SourceKind::Raster { mime, raw_colors } => {
            let blob = match jpeg_exif_orientation(data) {
                // 예전 image crate 디코드처럼 EXIF 방향을 무시한다. 자르기 좌표가 원본 축 기준이다.
                Some((offset, little)) => {
                    let mut patched = data.to_vec();
                    let one = if little { [1, 0] } else { [0, 1] };
                    patched[offset..offset + 2].copy_from_slice(&one);
                    blob_from_bytes(&patched, mime)?
                }
                None => blob_from_bytes(data, mime)?,
            };
            Ok(DecodeInput::Raster {
                blob,
                options: bitmap_options(target, raw_colors),
            })
        }
        SourceKind::Pcx => {
            let png = super::image_resolver::pcx_bytes_to_png_bytes(data)
                .ok_or_else(|| JsValue::from_str("PCX 변환 실패"))?;
            Ok(DecodeInput::Raster {
                blob: blob_from_bytes(&png, "image/png")?,
                options: bitmap_options(target, true),
            })
        }
        SourceKind::Tiff => {
            let rgba = image::load_from_memory(data)
                .map_err(|error| JsValue::from_str(&error.to_string()))?
                .into_rgba8();
            let (w, h) = (rgba.width(), rgba.height());
            let data = web_sys::ImageData::new_with_u8_clamped_array_and_sh(
                wasm_bindgen::Clamped(rgba.as_raw()),
                w,
                h,
            )?;
            Ok(DecodeInput::Pixels {
                data,
                options: bitmap_options(target, true),
            })
        }
        SourceKind::Wmf => {
            let svg = super::svg::convert_wmf_to_svg(data)
                .ok_or_else(|| JsValue::from_str("WMF 변환 실패"))?;
            Ok(DecodeInput::Svg {
                blob: blob_from_bytes(&svg, "image/svg+xml")?,
                size: target.unwrap_or((1, 1)),
            })
        }
        SourceKind::Svg => Ok(DecodeInput::Svg {
            blob: blob_from_bytes(data, "image/svg+xml")?,
            size: target.unwrap_or((1, 1)),
        }),
    }
}

async fn decode(input: DecodeInput) -> Result<ImageBitmap, JsValue> {
    let window = web_sys::window().ok_or_else(|| JsValue::from_str("window 없음"))?;
    match input {
        DecodeInput::Raster { blob, options } => {
            let promise =
                window.create_image_bitmap_with_blob_and_image_bitmap_options(&blob, &options)?;
            Ok(JsFuture::from(promise).await?.unchecked_into())
        }
        DecodeInput::Pixels { data, options } => {
            let promise = window
                .create_image_bitmap_with_image_data_and_image_bitmap_options(&data, &options)?;
            Ok(JsFuture::from(promise).await?.unchecked_into())
        }
        DecodeInput::Svg { blob, size } => {
            // Chrome 은 SVG Blob 을 createImageBitmap 으로 읽지 못한다. `<img>` 로 읽은 뒤 예전처럼
            // drawImage 로 대상 크기에 맞춰 래스터화한다.
            let url = Url::create_object_url_with_blob(&blob)?;
            let img = HtmlImageElement::new()?;
            img.set_src(&url);
            let loaded = JsFuture::from(img.decode()).await;
            Url::revoke_object_url(&url)?;
            loaded?;
            let canvas = OffscreenCanvas::new(size.0, size.1)?;
            let ctx: OffscreenCanvasRenderingContext2d = canvas
                .get_context("2d")?
                .ok_or_else(|| JsValue::from_str("2d context 없음"))?
                .unchecked_into();
            ctx.draw_image_with_html_image_element_and_dw_and_dh(
                &img,
                0.0,
                0.0,
                size.0 as f64,
                size.1 as f64,
            )?;
            img.set_src("");
            canvas.transfer_to_image_bitmap()
        }
    }
}

fn settle(key: u64, level: i32, result: Result<ImageBitmap, JsValue>) {
    let now = now_ms();
    let (pending, schedule_trim) = CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        cache.in_flight = cache.in_flight.saturating_sub(1);
        let Some(mut entry) = cache.entries.remove(&key) else {
            if let Ok(bitmap) = &result {
                bitmap.close();
            }
            return (cache.in_flight, false);
        };
        if entry.pending == Some(level) {
            entry.pending = None;
        }
        match result {
            Ok(bitmap) => {
                let better = entry.held.as_ref().is_none_or(|held| held.level < level);
                if better && bitmap.width() > 0 && bitmap.height() > 0 {
                    cache.release(&mut entry);
                    if entry.base.is_none() {
                        entry.base = Some((bitmap.width() as f64, bitmap.height() as f64));
                    }
                    let bytes = bitmap.width() as usize * bitmap.height() as usize * 4;
                    cache.total_bytes += bytes;
                    entry.held = Some(HeldBitmap {
                        bitmap,
                        level,
                        bytes,
                    });
                    // 기다리던 쪽이 다시 그릴 때까지 내보내지 않는다.
                    entry.last_used = now;
                } else {
                    bitmap.close();
                }
            }
            Err(_) => entry.failed_from = entry.failed_from.min(level),
        }
        cache.entries.insert(key, entry);
        let still_over = cache.trim(now);
        let schedule = still_over && !cache.trim_scheduled;
        if schedule {
            cache.trim_scheduled = true;
        }
        (cache.in_flight, schedule)
    });
    if schedule_trim {
        schedule_deferred_trim();
    }
    notify(pending);
}

fn schedule_deferred_trim() {
    let Some(window) = web_sys::window() else {
        return;
    };
    let callback = Closure::once_into_js(|| {
        let reschedule = CACHE.with(|cache| {
            let mut cache = cache.borrow_mut();
            cache.trim_scheduled = false;
            let still_over = cache.trim(now_ms());
            if still_over {
                cache.trim_scheduled = true;
            }
            still_over
        });
        if reschedule {
            schedule_deferred_trim();
        }
    });
    let _ = window.set_timeout_with_callback_and_timeout_and_arguments_0(
        callback.unchecked_ref(),
        RECENT_USE_MS as i32,
    );
}

fn notify(pending: usize) {
    let listener = LISTENER.with(|listener| listener.borrow().clone());
    if let Some(listener) = listener {
        let _ = listener.call1(&JsValue::NULL, &JsValue::from(pending as u32));
    }
}

/// 디코드가 끝날 때마다 부를 리스너를 등록한다. 인자는 아직 진행 중인 디코드 수다.
#[wasm_bindgen(js_name = setWebCanvasPictureListener)]
pub fn set_web_canvas_picture_listener(listener: Option<js_sys::Function>) {
    LISTENER.with(|slot| *slot.borrow_mut() = listener);
}

pub(crate) fn image_cache_stats_json() -> String {
    CACHE.with(|cache| {
        let cache = cache.borrow();
        let bitmaps = cache
            .entries
            .values()
            .filter(|entry| entry.held.is_some())
            .count();
        let failed = cache
            .entries
            .values()
            .filter(|entry| entry.held.is_none() && entry.failed_from != NO_FAILURE)
            .count();
        serde_json::json!({
            "pictureEntries": cache.entries.len(),
            "pictureBitmaps": bitmaps,
            "pictureBytes": cache.total_bytes,
            "pictureBudgetBytes": PICTURE_BUDGET_BYTES,
            "pendingDecodes": cache.in_flight,
            "failedPictures": failed,
        })
        .to_string()
    })
}

/// 빠른 해시 (FNV-1a 64비트)
fn hash_bytes(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn pcx_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 12 {
        return None;
    }
    let read = |at: usize| u16::from_le_bytes([data[at], data[at + 1]]) as u32;
    let (x_min, y_min, x_max, y_max) = (read(4), read(6), read(8), read(10));
    Some((x_max.checked_sub(x_min)? + 1, y_max.checked_sub(y_min)? + 1))
}

/// JPEG EXIF 방향 값이 1(그대로)이 아니면 그 값(SHORT)의 바이트 위치와 little-endian 여부를 돌려준다.
fn jpeg_exif_orientation(data: &[u8]) -> Option<(usize, bool)> {
    if !data.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    let mut at = 2;
    while at + 4 <= data.len() && data[at] == 0xFF {
        let marker = data[at + 1];
        if marker == 0xDA || marker == 0xD9 {
            return None;
        }
        let len = u16::from_be_bytes([data[at + 2], data[at + 3]]) as usize;
        let body = at + 4;
        if marker == 0xE1 && data.get(body..body + 6) == Some(b"Exif\0\0") {
            return exif_orientation_offset(data, body + 6, (at + 2 + len).min(data.len()));
        }
        at += 2 + len;
    }
    None
}

fn exif_orientation_offset(data: &[u8], tiff: usize, end: usize) -> Option<(usize, bool)> {
    let header = data.get(tiff..tiff + 8)?;
    let little = match &header[..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |at: usize| -> Option<u16> {
        let bytes = data.get(at..at + 2).filter(|_| at + 2 <= end)?;
        Some(if little {
            u16::from_le_bytes([bytes[0], bytes[1]])
        } else {
            u16::from_be_bytes([bytes[0], bytes[1]])
        })
    };
    let ifd_bytes = data.get(tiff + 4..tiff + 8)?;
    let ifd = if little {
        u32::from_le_bytes([ifd_bytes[0], ifd_bytes[1], ifd_bytes[2], ifd_bytes[3]])
    } else {
        u32::from_be_bytes([ifd_bytes[0], ifd_bytes[1], ifd_bytes[2], ifd_bytes[3]])
    } as usize;
    let ifd = tiff.checked_add(ifd)?;
    let count = u16_at(ifd)? as usize;
    for index in 0..count {
        let entry = ifd + 2 + index * 12;
        if u16_at(entry)? == 0x0112 {
            let value = entry + 8;
            return (u16_at(value)? != 1).then_some((value, little));
        }
    }
    None
}

/// 이미지 MIME 타입 감지
fn detect_image_mime_type(data: &[u8]) -> &'static str {
    if data.len() >= 8 && &data[0..8] == b"\x89PNG\r\n\x1a\n" {
        "image/png"
    } else if data.len() >= 2 && data[0] == 0xFF && data[1] == 0xD8 {
        "image/jpeg"
    } else if data.len() >= 6 && (&data[0..6] == b"GIF87a" || &data[0..6] == b"GIF89a") {
        "image/gif"
    } else if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        "image/webp"
    } else if data.len() >= 4 && &data[0..4] == b"\x00\x00\x01\x00" {
        "image/x-icon"
    } else if data.len() >= 2 && &data[0..2] == b"BM" {
        "image/bmp"
    } else if data.starts_with(b"II*\0") || data.starts_with(b"MM\0*") {
        "image/tiff"
    } else if data.len() >= 4
        && (data.starts_with(&[0xD7, 0xCD, 0xC6, 0x9A])
            || data.starts_with(&[0x01, 0x00, 0x09, 0x00]))
    {
        "image/x-wmf"
    } else if data.len() >= 2 && data.starts_with(&[0x0A, 0x05]) {
        // PCX: 0A 05 (ZSoft Paintbrush v3.0+, Task #514). 브라우저가 못 읽어 PNG 로 바꾼다.
        "image/x-pcx"
    } else if super::svg_fragment::is_svg_prefix(data) {
        // Task #275: RawSvg 래퍼 경로 — <svg 또는 <?xml + <svg
        "image/svg+xml"
    } else {
        ""
    }
}

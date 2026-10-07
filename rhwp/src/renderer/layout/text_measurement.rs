//! 텍스트 폭 측정, 문자 클러스터 분할, CJK 판별 관련 함수

use super::super::font_metrics_data;
use super::super::style_resolver::ResolvedStyleSet;
use super::super::{hwpunit_to_px, TabLeaderInfo, TabStop, TextStyle};
use crate::model::provenance::FontMetricsPolicy;
use crate::model::style::UnderlineType;
use unicode_segmentation::UnicodeSegmentation;

/// 고정폭 빈칸(HWP5 코드 31, HWPX `<hp:fwSpace/>`, 내부 표현 U+2007)의 폭 (em).
///
/// 한컴 PDF 실측: Windows `-<fwSpace><fwSpace>상`(바탕 12pt) 두 칸 = 6.0pt(칸당 0.25em),
/// macOS 맑은 고딕 22pt 줄끝 칸 ≈ 5.6pt, 함초롬바탕 15pt 글머리 앞 칸 ≈ 3.5pt
/// (장평 97%·자간 -3% 적용). 글꼴과 무관하게 글자 크기의 1/4 이다.
const FIXED_WIDTH_SPACE_EM: f64 = 0.25;
// 고정폭 빈칸에는 지정 자간을 적용하지만, 줄 넘침을 줄이는 자동 압축은 적용하지 않는다.

#[derive(Clone)]
pub(crate) struct ResolvedShapingFont {
    pub family: String,
    pub bytes: std::sync::Arc<[u8]>,
    pub face_index: u32,
}

thread_local! {
    static ACTIVE_SHAPING_FONTS: std::cell::RefCell<Vec<ResolvedShapingFont>> = const {
        std::cell::RefCell::new(Vec::new())
    };
    /// `measure_char_width_tracked` 의 (font_family, flags, char, size_bits) → 폭 캐시.
    /// 글자 한 번의 폭 결정이 이름 정규화·메트릭 테이블·대체 체인 수십 단계를 걸으므로
    /// 같은 입력의 반복 계산을 생략한다. 폰트 환경이 바뀌는 지점(런타임 폰트 등록/
    /// 해제, shaping·font-path scope 전환, HFT·커스텀 face 등록)에서 비운다.
    static MEASURE_WIDTH_CACHE: std::cell::RefCell<
        std::collections::HashMap<(String, u8, char, u64), Option<f64>>,
    > = std::cell::RefCell::new(std::collections::HashMap::new());
    /// enter/drop 으로 드러나는 shaping fonts 집합의 identity 스택 — 활성 집합이
    /// 바뀌면 측정 캐시를 비운다.
    static SHAPING_FONT_ID_STACK: std::cell::RefCell<Vec<u64>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// 캐시 상한 — 넘으면 통째로 비운다 (문서의 (font,char,size) 조합 수준에 한정됨).
const MEASURE_WIDTH_CACHE_MAX: usize = 65_536;

/// shaping fonts 집합의 identity — bytes 는 Arc 포인터로 비교해 같은 face 집합을
/// 충돌 없이 판별한다 (재진입 시 같은 Vec 이면 캐시를 유지한다).
fn shaping_fonts_fingerprint(fonts: &[ResolvedShapingFont]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for font in fonts {
        font.family.hash(&mut hasher);
        font.face_index.hash(&mut hasher);
        std::sync::Arc::as_ptr(&font.bytes).hash(&mut hasher);
    }
    hasher.finish()
}

/// 글자 폭 측정 결과 캐시를 비운다 — 측정 결과에 영향을 주는 폰트 환경 변경점에서 호출.
pub(crate) fn clear_measure_width_cache() {
    MEASURE_WIDTH_CACHE.with(|cache| cache.borrow_mut().clear());
}

pub(crate) struct ResolvedShapingFontScope(Vec<ResolvedShapingFont>);

impl Drop for ResolvedShapingFontScope {
    fn drop(&mut self) {
        ACTIVE_SHAPING_FONTS.with(|active| {
            active.replace(std::mem::take(&mut self.0));
        });
        SHAPING_FONT_ID_STACK.with(|stack| {
            let mut stack = stack.borrow_mut();
            let exited = stack.pop().unwrap_or(0);
            // 빠져나간 scope 와 새로 드러난 scope 가 다르면 측정 환경이 바뀐 것.
            if stack.last().copied().unwrap_or(0) != exited {
                clear_measure_width_cache();
            }
        });
    }
}

pub(crate) fn enter_resolved_shaping_fonts(
    fonts: Vec<ResolvedShapingFont>,
) -> ResolvedShapingFontScope {
    let fingerprint = shaping_fonts_fingerprint(&fonts);
    SHAPING_FONT_ID_STACK.with(|stack| {
        let mut stack = stack.borrow_mut();
        if stack.last().copied().unwrap_or(0) != fingerprint {
            clear_measure_width_cache();
        }
        stack.push(fingerprint);
    });
    let previous = ACTIVE_SHAPING_FONTS.with(|active| active.replace(fonts));
    ResolvedShapingFontScope(previous)
}

pub(crate) fn with_resolved_shaping_fonts<T>(
    fonts: Vec<ResolvedShapingFont>,
    action: impl FnOnce() -> T,
) -> T {
    let _scope = enter_resolved_shaping_fonts(fonts);
    action()
}

#[cfg(not(target_arch = "wasm32"))]
thread_local! {
    /// 네이티브 렌더 진입(`--font-path` 인자)이 노출한 추가 폰트 경로.
    /// substFont 대체 판정의 탐색 범위다.
    static MEASURE_FONT_PATHS: std::cell::RefCell<Vec<std::path::PathBuf>> =
        const { std::cell::RefCell::new(Vec::new()) };
    /// 패밀리명 → 설치 여부 캐시 (경로 스코프 진입/해제 시 비운다).
    static MEASURE_FONT_AVAIL: std::cell::RefCell<std::collections::HashMap<String, bool>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

#[cfg(target_arch = "wasm32")]
thread_local! {
    /// 선언 face 존재 여부는 브라우저에 질의하되 문서 재조판 전까지 재사용한다.
    static BROWSER_FONT_AVAIL: std::cell::RefCell<std::collections::HashMap<String, bool>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

#[cfg(not(target_arch = "wasm32"))]
thread_local! {
    /// font-paths scope 의 identity 스택 — 활성 경로 집합이 바뀌면 측정 캐시를 비운다.
    static MEASURE_PATH_ID_STACK: std::cell::RefCell<Vec<u64>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(not(target_arch = "wasm32"))]
fn measure_paths_fingerprint(paths: &[std::path::PathBuf]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    paths.hash(&mut hasher);
    hasher.finish()
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) struct MeasureFontPathsScope(Vec<std::path::PathBuf>);

#[cfg(not(target_arch = "wasm32"))]
impl Drop for MeasureFontPathsScope {
    fn drop(&mut self) {
        MEASURE_FONT_PATHS.with(|paths| {
            paths.replace(std::mem::take(&mut self.0));
        });
        MEASURE_FONT_AVAIL.with(|cache| cache.borrow_mut().clear());
        MEASURE_PATH_ID_STACK.with(|stack| {
            let mut stack = stack.borrow_mut();
            let exited = stack.pop().unwrap_or(0);
            if stack.last().copied().unwrap_or(0) != exited {
                clear_measure_width_cache();
            }
        });
    }
}

/// 렌더 진입점이 `--font-path` 목록을 측정 판정에도 노출한다.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn enter_measure_font_paths(paths: Vec<std::path::PathBuf>) -> MeasureFontPathsScope {
    let fingerprint = measure_paths_fingerprint(&paths);
    MEASURE_PATH_ID_STACK.with(|stack| {
        let mut stack = stack.borrow_mut();
        if stack.last().copied().unwrap_or(0) != fingerprint {
            clear_measure_width_cache();
        }
        stack.push(fingerprint);
    });
    let previous = MEASURE_FONT_PATHS.with(|slot| slot.replace(paths));
    MEASURE_FONT_AVAIL.with(|cache| cache.borrow_mut().clear());
    MeasureFontPathsScope(previous)
}

/// 문서 선언 글꼴이 현재 렌더 환경에 실재하는지 — substFont 대체 규칙의 근거.
///
/// 임베디드(BinData) face 는 shaping scope 에 등록돼 있으면 설치와 동일하게 본다.
/// wasm 은 Studio 가 Canvas 원본 setter 로 측정한 브라우저 face 존재 여부를 사용한다.
/// 다른 WASM 호스트가 그 훅을 제공하지 않으면 기존의 설치 가정으로 폴백한다.
fn declared_family_available(font_family: &str) -> bool {
    let primary = super::super::style_resolver::primary_font_name(font_family);
    if primary.is_empty() {
        return true;
    }
    if crate::renderer::runtime_font_metrics::face_available(primary)
        || ACTIVE_SHAPING_FONTS.with(|active| {
            active
                .borrow()
                .iter()
                .any(|font| font.family.eq_ignore_ascii_case(primary))
        })
    {
        return true;
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let key = primary.to_string();
        if let Some(hit) = MEASURE_FONT_AVAIL.with(|cache| cache.borrow().get(&key).copied()) {
            return hit;
        }
        let hit = MEASURE_FONT_PATHS.with(|paths| {
            crate::renderer::font_paths::font_family_available(primary, &paths.borrow())
        });
        MEASURE_FONT_AVAIL.with(|cache| cache.borrow_mut().insert(key, hit));
        hit
    }
    #[cfg(target_arch = "wasm32")]
    {
        browser_font_family_available(primary).unwrap_or(true)
    }
}

#[cfg(target_arch = "wasm32")]
fn browser_font_family_available(primary: &str) -> Option<bool> {
    use wasm_bindgen::{JsCast, JsValue};
    if let Some(hit) = BROWSER_FONT_AVAIL.with(|cache| cache.borrow().get(primary).copied()) {
        return Some(hit);
    }
    let global = js_sys::global();
    let available =
        js_sys::Reflect::get(&global, &JsValue::from_str("isDeclaredFontFamilyAvailable"))
            .ok()
            .and_then(|value| value.dyn_into::<js_sys::Function>().ok())
            .and_then(|probe| probe.call1(&global, &JsValue::from_str(primary)).ok())
            .and_then(|value| value.as_bool());
    if let Some(available) = available {
        BROWSER_FONT_AVAIL.with(|cache| {
            cache.borrow_mut().insert(primary.to_string(), available);
        });
    }
    available
}

/// 문서 선언 대체와 HFT 별칭 대체 글꼴의 측정 규칙.
///
/// 원본 글꼴이 렌더 환경에 없으면 한컴은 대체 글꼴로 조판한다 — 폭 산출도 같은
/// face 기준이어야 그려지는 위치와 일치한다. 반환은 측정 전용 복사본이라 노드에
/// 저장된 `font_family`/`font_subst`(emit 체인)는 바뀌지 않는다.
fn measure_style(style: &TextStyle) -> std::borrow::Cow<'_, TextStyle> {
    // 원본이 HFT 인 run 은 한컴처럼 HFT 폭 테이블로 잰다 (신명 신그래픽 `(` 0.5em —
    // 굴림 대체 폭이 아니다). 테이블에 없는 글자는 체인 뒤의 대체 서체 폭으로 넘어간다.
    // 대체 서체가 같은 디자인의 한양 TTF(HY견명조 등)면 한컴도 그 폭으로 조판하므로
    // 그대로 둔다 — exam-social 쪽번호의 신명 견명조 숫자는 HFT 0.68em 이 아니라
    // HY견명조 0.666em 간격으로 놓인다.
    if hft_width_swap(style) {
        let mut patched = style.clone();
        patched.font_family = format!("{},{}", style.hft_family.trim(), style.font_family);
        return std::borrow::Cow::Owned(patched);
    }
    let font_subst = crate::renderer::hancom_document_substitute(style.effective_font_subst());
    if font_subst.is_empty() || declared_family_available(&style.font_family) {
        return std::borrow::Cow::Borrowed(style);
    }
    let mut patched = style.clone();
    patched.font_family = font_subst.to_string();
    std::borrow::Cow::Owned(patched)
}

/// `measure_style` 이 HFT 폭 테이블을 체인 앞에 두는 run 인가.
fn hft_width_swap(style: &TextStyle) -> bool {
    let hft = style.hft_family.trim();
    let primary = style.font_family.split(',').next().unwrap_or("").trim();
    !hft.is_empty()
        && primary != hft
        && !primary.starts_with("HY")
        && crate::renderer::hft_metrics::find_metric(hft, false, false).is_some()
}

fn shaped_char_positions(text: &str, style: &TextStyle) -> Option<Vec<f64>> {
    // 문서 내장 글꼴의 실제 advance 는 플랫폼 정책과 무관하게 같다.
    if text.is_empty()
        || font_family_has_metrics(&style.font_family, style.bold, style.italic)
        || text.contains('\t')
        || text
            .chars()
            .any(|ch| matches!(ch, '\u{FFFC}' | '\u{F081C}' | '\u{00AD}'))
    {
        return None;
    }
    ACTIVE_SHAPING_FONTS.with(|active| {
        let active = active.borrow();
        let font = active
            .iter()
            .find(|font| font.family.eq_ignore_ascii_case(&style.font_family))?;
        let face = rustybuzz::Face::from_slice(&font.bytes, font.face_index)?;
        let units_per_em = f64::from(face.units_per_em());
        if units_per_em <= 0.0 {
            return None;
        }
        let mut buffer = rustybuzz::UnicodeBuffer::new();
        buffer.push_str(text);
        buffer.guess_segment_properties();
        let features = if style.kerning {
            Vec::new()
        } else {
            vec!["kern=0".parse().ok()?]
        };
        let glyphs = rustybuzz::shape(&face, &features, buffer);
        if glyphs.is_empty() || glyphs.glyph_infos().iter().any(|glyph| glyph.glyph_id == 0) {
            return None;
        }

        let scale = style.font_size.max(0.0) / units_per_em;
        let mut cluster_advances = std::collections::BTreeMap::<usize, f64>::new();
        for (info, position) in glyphs.glyph_infos().iter().zip(glyphs.glyph_positions()) {
            *cluster_advances.entry(info.cluster as usize).or_default() +=
                f64::from(position.x_advance) * scale * style.ratio.max(0.0);
        }
        let cluster_starts = cluster_advances.keys().copied().collect::<Vec<_>>();
        let char_boundaries = text
            .char_indices()
            .map(|(byte, _)| byte)
            .chain(std::iter::once(text.len()))
            .collect::<Vec<_>>();
        let mut positions = vec![0.0; char_boundaries.len()];
        let mut x = 0.0;
        for (cluster_index, byte_start) in cluster_starts.iter().copied().enumerate() {
            let byte_end = cluster_starts
                .get(cluster_index + 1)
                .copied()
                .unwrap_or(text.len());
            let boundary_indices = char_boundaries
                .iter()
                .enumerate()
                .filter_map(|(index, byte)| {
                    ((*byte > byte_start) && (*byte <= byte_end)).then_some(index)
                })
                .collect::<Vec<_>>();
            if boundary_indices.is_empty() {
                continue;
            }
            let cluster_text = &text[byte_start..byte_end];
            let mut advance = cluster_advances[&byte_start];
            advance += glyph_letter_spacing(
                style.letter_spacing,
                advance,
                style.font_size,
                style.font_metrics_policy,
            ) + style.extra_char_spacing;
            if cluster_text == " " {
                advance += style.extra_word_spacing;
            }
            let mut relative_end = 0usize;
            let grapheme_ends = cluster_text
                .graphemes(true)
                .map(|grapheme| {
                    relative_end += grapheme.len();
                    relative_end
                })
                .collect::<Vec<_>>();
            let grapheme_count = grapheme_ends.len().max(1) as f64;
            for boundary_index in boundary_indices {
                let relative_byte = char_boundaries[boundary_index] - byte_start;
                let completed = grapheme_ends
                    .iter()
                    .take_while(|end| **end <= relative_byte)
                    .count();
                positions[boundary_index] = x + advance * (completed as f64 / grapheme_count);
            }
            x += advance;
        }
        positions.last_mut().map(|last| *last = x);
        Some(positions)
    })
}

// ── TextMeasurer trait ──────────────────────────────────────────────

/// 텍스트 폭 측정 추상화 트레이트
///
/// 플랫폼별 텍스트 측정 구현체를 추상화한다.
/// - EmbeddedTextMeasurer: 내장 폰트 메트릭 기반 (모든 플랫폼)
/// - WasmTextMeasurer: JS Canvas 브릿지 + 내장 메트릭 (WASM 전용)
pub trait TextMeasurer {
    /// 텍스트 전체 폭 추정 (px)
    fn estimate_text_width(&self, text: &str, style: &TextStyle) -> f64;
    /// 글자별 X 위치 경계값 계산 (N글자 → N+1개 경계)
    fn compute_char_positions(&self, text: &str, style: &TextStyle) -> Vec<f64>;
}

// ── 공통 헬퍼 ───────────────────────────────────────────────────────

/// 자모 클러스터 길이 매핑 계산
///
/// 한글 자모 조합(초+중+종)을 1개 클러스터로 묶는다.
/// cluster_len[i] > 0: 클러스터 시작 (길이), 0: 클러스터 내부 (이전 문자와 동일 위치)
fn build_cluster_len(chars: &[char]) -> Vec<usize> {
    let char_count = chars.len();
    let mut cluster_len = vec![0usize; char_count];
    let text: String = chars.iter().collect();
    let mut ci = 0;
    for grapheme in text.graphemes(true) {
        let len = grapheme.chars().count();
        cluster_len[ci] = len;
        ci += len;
    }
    cluster_len
}

/// [#2279] 자간(%)의 픽셀 기여 — 한글은 자간을 **해당 글자의 진행폭 비례**로
/// 적용한다 (fs-비례 아님). 무신축 Justify 마지막 줄 실측(36392557 pi34,
/// 휴먼명조 '*' 14pt 자간 -9%/장평 96%: 0.44em = 0.5×0.96×0.91)으로 확정.
/// 전각(1.0em) 글자는 fs-비례와 동일하므로 CJK 자간 동작은 불변이고,
/// 반각/좁은 글자에서만 압축·확장이 글자폭에 비례해 정확해진다.
/// style.letter_spacing 은 fs×% 로 저장되어 있으므로 (base/fs) 로 환산한다.
#[inline]
fn glyph_letter_spacing(
    letter_spacing_px: f64,
    glyph_base_px: f64,
    font_size: f64,
    policy: FontMetricsPolicy,
) -> f64 {
    if font_size <= 0.0 {
        return letter_spacing_px;
    }
    let contribution = letter_spacing_px * (glyph_base_px / font_size);
    if letter_spacing_px == 0.0 || policy != FontMetricsPolicy::HcrDeclared {
        return contribution;
    }
    // macOS 한컴은 자간 적용 전후의 글리프 진행폭을 배치 단위(0.04pt) 격자로 양자화한다.
    let base = round_half_up(glyph_base_px / MAC_LAYOUT_UNIT_PX);
    let spaced =
        mac_letter_spaced_units(base, letter_spacing_percent(letter_spacing_px, font_size));
    spaced * MAC_LAYOUT_UNIT_PX - glyph_base_px
}

/// macOS 한컴의 배치 단위: 1/1800 inch (= 4 HWPUNIT = 0.04pt) 의 px 크기.
///
/// 합성(lineseg 없는) 스윕 1,513 문단의 PDF 단어 시작 위치가 이 격자의 정수 advance 로
/// PDF 양자화 잡음(rms 0.046–0.052pt, 편향 0)까지 맞는다.
const MAC_LAYOUT_UNIT_PX: f64 = 4.0 / 75.0;

/// 0.5 올림 반올림. 부동소수 오차로 정확한 .5 가 아래로 떨어지지 않게 여유를 둔다.
#[inline]
fn round_half_up(x: f64) -> f64 {
    (x + 0.5 + 1e-6).floor()
}

/// 글자 크기의 배치 단위 수 = floor(크기 HWPUNIT / 4) (10pt → 250, 9.5pt → 237).
#[inline]
fn mac_size_units(font_size_px: f64) -> f64 {
    (font_size_px * 75.0 / 4.0 + 1e-6).floor()
}

/// 저장 자간(px = 글자 크기 × %)을 정수 % 로 되돌린다. HWP 자간은 정수 % 다.
#[inline]
fn letter_spacing_percent(letter_spacing_px: f64, font_size: f64) -> f64 {
    if font_size <= 0.0 {
        return 0.0;
    }
    (letter_spacing_px / font_size * 100.0).round()
}

/// 자간 적용: advance + 반올림(advance × 자간%) — 증감분의 0.5 는 0 에서 먼 쪽으로.
/// 스윕(함초롬바탕 10pt 243단위): +50% → 365, −50% → 121, 휴먼명조 14pt 175단위 −2% → 171.
#[inline]
fn mac_letter_spaced_units(units: f64, spacing_percent: f64) -> f64 {
    if spacing_percent == 0.0 {
        return units;
    }
    let delta = units * spacing_percent / 100.0;
    units + delta.signum() * round_half_up(delta.abs())
}

/// macOS 한컴의 글자 advance (px): 배치 단위 정수로 장평·자간을 적용한다.
///
/// - 크기 단위 u = floor(크기HU / 4), 글리프 = round_half_up(hmtx/upm × u)
/// - 빈칸(em/2) = floor(u / 2) — 글꼴과 무관
/// - 문서 장평 r ≠ 100%: 글리프 = floor(hmtx/upm × u × r), 빈칸 = round_half_up(floor(u/2) × r)
///   (스윕 D_ratio 50–200% 전 구간: 0.97em 글자 121/145/169/194/218/230/254/266/291/363/485,
///   빈칸 63/75/88/100/113/119/131/138/150/188/250 단위 — 단어 위치 rms 0.044pt, 편향 0)
/// - 문서 장평은 글꼴·자간에 관계없이 유지한다. 글꼴 크기를 먼저 내리면
///   같은 크기의 글자도 hmtx/upm 에 따라 다른 방향으로 배치 단위가 어긋난다.
/// - 자간은 장평 적용 뒤의 정수 advance 에 `mac_letter_spaced_units` 로 더한다.
///
/// `base_px` 는 장평·자간 전 글리프 폭이며 em × 글자 크기를 양자화하지 않은 값이어야 한다
/// (`measure_glyph_base_px`).
fn mac_glyph_advance_px(
    base_px: f64,
    c: char,
    style: &TextStyle,
    font_size: f64,
    ratio: f64,
) -> f64 {
    if font_size <= 0.0 {
        return base_px * ratio;
    }
    let units = mac_size_units(font_size);
    let percent = ratio * 100.0;
    let document_ratio = (percent - percent.round()).abs() < 1e-6;
    // 첨자 run 의 빈칸은 원래 글자 크기의 em/2 다 (`latin_space_width`).
    let space_size = [font_size, style.script_base_size]
        .into_iter()
        .find(|size| *size > 0.0 && (base_px - size / 2.0).abs() < 0.5 / 75.0)
        .filter(|_| matches!(c, ' ' | '\u{00A0}'));
    let glyph = if !document_ratio {
        round_half_up(base_px * 75.0 / 4.0 * ratio)
    } else if let Some(space_size) = space_size {
        let space = (mac_size_units(space_size) / 2.0).floor();
        if (ratio - 1.0).abs() > 1e-9 {
            round_half_up(space * ratio)
        } else {
            space
        }
    } else {
        let scaled = base_px / font_size * units;
        if (ratio - 1.0).abs() > 1e-9 {
            (scaled * ratio + 1e-6).floor()
        } else {
            round_half_up(scaled)
        }
    };
    let spacing = letter_spacing_percent(style.letter_spacing, font_size);
    mac_letter_spaced_units(glyph, spacing) * MAC_LAYOUT_UNIT_PX
}

/// 장평·자간 전 글리프 폭에 장평과 자간을 적용한 advance (px, 정렬용 여분 제외).
/// 줄바꿈·배치·렌더러가 모두 이 함수로 글자 advance 를 만든다 (native·WASM 공통).
#[inline]
fn scaled_glyph_advance(
    base_px: f64,
    c: char,
    style: &TextStyle,
    font_size: f64,
    ratio: f64,
) -> f64 {
    if style.font_metrics_policy == FontMetricsPolicy::HcrDeclared {
        return mac_glyph_advance_px(base_px, c, style, font_size, ratio);
    }
    base_px * ratio
        + glyph_letter_spacing(
            style.letter_spacing,
            base_px * ratio,
            font_size,
            style.font_metrics_policy,
        )
}

/// 스타일에서 공통 파라미터 추출 (font_size, ratio, tab_w)
fn style_params(style: &TextStyle) -> (f64, f64, f64) {
    let font_size = if style.font_size > 0.0 {
        style.font_size
    } else {
        12.0
    };
    let ratio = if style.ratio > 0.0 { style.ratio } else { 1.0 };
    let tab_w = if style.default_tab_width > 0.0 {
        style.default_tab_width
    } else {
        font_size * 4.0
    };
    (font_size, ratio, tab_w)
}

/// inline_tabs ext[2] 에서 탭 종류를 추출.
///
/// HWP `tab_extended` 포맷 (PR #292 / Task #290 실증):
/// - high byte = 탭 종류 enum+1 (1=LEFT, 2=RIGHT, 3=CENTER, 4=DECIMAL)
/// - low  byte = fill_type (TabDef.fill 과 동일)
///
/// 기존 코드는 `ext[2]` 전체 u16 을 탭 종류로 해석하여 실제 HWP 값(최소 256)과
/// 매칭 실패. 이 헬퍼로 고바이트만 추출해 0~4 값으로 정규화.
#[inline]
pub(super) fn inline_tab_type(ext: &[u16; 7]) -> u8 {
    ((ext[2] >> 8) & 0xFF) as u8
}

/// HWPX 오른쪽 인라인 탭을 문단 탭 정의로 다시 해석해야 하는지.
///
/// HWPX `<hp:tab type>` 은 한컴이 저장 당시 해석한 결과다. 한컴은 열 때 문단 탭
/// 정의(TabDef)로 다시 조판한다: 현재 위치 뒤의 첫 탭 정지의 종류·위치를 따른다.
/// 저장된 RIGHT 탭이 줄바꿈으로 다음 줄 앞에 오면 그 줄의 첫 정지(LEFT)로 간다
/// (복지 협의요청서 `(기관명:\t)` 실측: 오른쪽 정지 30500 → 둘째 줄은 왼쪽 정지 13214).
/// HWP5 인라인 탭(ext[5] 표시 없음)과 가운데 탭(run 을 넘는 정렬 단위는 저장 폭
/// 경로가 맞춘다 — exam-social 머리말 `\t사회|탐구 영역`)은 종전 해석을 유지한다.
#[inline]
pub(crate) fn inline_tab_defers_to_tab_def(ext: &[u16; 7], style: &TextStyle) -> bool {
    ext[5] & 0x8000 != 0 && inline_tab_type(ext) == 2 && !style.tab_stops.is_empty()
}

/// 인라인 탭 ext[0] 의 width 는 '이동 거리'가 아니라 탭 정지 간격이다.
/// 한컴은 줄 시작 기준으로 width 의 정수배 중 현재 위치보다 큰 첫 위치로 이동한다
/// (그리드 정렬). 같은 간격의 탭이 연속으로 나오면 두 번째 탭은 다음 배수까지 간다.
///
/// `abs_x`: 줄 시작 기준 절대 위치 (line_x_offset + run 내 x). 반환도 동일 기준.
/// 한컴 eq-002.hwpx 실측: margin 85pt + tab(width=40pt) → 내용은 125.6pt 시작,
/// width=35.86pt/40pt 연속 탭 → 다음 내용은 205.7pt 에 정렬.
#[inline]
pub(super) fn inline_tab_next_stop(abs_x: f64, tab_width_px: f64) -> f64 {
    if tab_width_px <= 0.0 || !abs_x.is_finite() {
        return abs_x;
    }
    (abs_x / tab_width_px).floor() * tab_width_px + tab_width_px
}

/// 왼쪽/기본 인라인 탭의 다음 x (run 상대 좌표).
///
/// HWPX 파서 탭(ext[5] 상위 비트 마커)의 `width` 는 한컴이 저장 당시 계산해 둔
/// 이동량일 뿐이고, 실제 위치는 문단 탭 정의가 정한다. 현재 위치 뒤의 첫 왼쪽
/// 탭 정지로 가고, 정의된 탭을 모두 지나면 기본 탭 간격 그리드로 간다
/// (math-001 선택지 줄 실측: 탭 정의 72.56/133.79pt… 에 정렬, 저장 width 무관).
/// HWP5 인라인 탭은 ext[0] 에 해석된 이동 거리가 이미 들어 있어(Issue #630 Stage 4)
/// 종전 누적(`x + width`)을 유지한다.
#[inline]
/// HWPX 인라인 탭이 문단 탭 정의의 오른쪽 탭에 걸리면 그 탭 위치(쪽 오른쪽 끝이 아니다)에
/// 뒤 글자 끝을 맞춘다 — aift 목차: 오른쪽 탭 47831HU 에 "(페이지 표기)" 끝이 놓이고
/// 본문 오른쪽 끝(48188HU)보다 357HU 안쪽이다. 반환은 줄 기준 상대 탭 위치.
fn hwpx_inline_right_stop_rel(ext: &[u16; 7], x: f64, style: &TextStyle) -> Option<f64> {
    if ext[5] & 0x8000 == 0 || style.tab_stops.is_empty() {
        return None;
    }
    let abs_x = style.line_x_offset + x;
    let (pos, tab_type, _) =
        find_next_tab_stop(abs_x, &style.tab_stops, 0.0, false, style.available_width);
    (tab_type == 1 && pos > abs_x).then(|| pos - style.line_x_offset)
}

fn inline_tab_left_x(ext: &[u16; 7], x: f64, style: &TextStyle, tab_width_px: f64) -> f64 {
    if ext[5] & 0x8000 == 0 {
        return x + tab_width_px;
    }
    let abs_x = style.line_x_offset + x;
    let default_tab_width = if style.default_tab_width > 0.0 {
        style.default_tab_width
    } else {
        tab_width_px
    };
    let (pos, tab_type, _) = find_next_tab_stop(
        abs_x,
        &style.tab_stops,
        default_tab_width,
        false,
        style.available_width,
    );
    if tab_type == 0 {
        (pos - style.line_x_offset).max(x)
    } else {
        (inline_tab_next_stop(abs_x, tab_width_px) - style.line_x_offset).max(x)
    }
}

/// 현재 절대 위치에서 다음 탭 정지를 찾는다.
///
/// Returns (position, tab_type, fill_type).
/// 커스텀 탭이 없으면 기본 등간격 탭을 사용한다.
pub(crate) fn find_next_tab_stop(
    abs_x: f64,
    tab_stops: &[TabStop],
    default_tab_width: f64,
    auto_tab_right: bool,
    available_width: f64,
) -> (f64, u8, u8) {
    // 커스텀 탭 정지에서 현재 위치 뒤의 첫 번째 검색
    for ts in tab_stops {
        // type=1(오른쪽) 탭은 단 기준 절대 위치이므로 available_width 클램핑 제외.
        // 들여쓰기(left_margin)가 있는 문단에서도 오른쪽 탭이 동일 위치에 정렬되도록 한다.
        // type=0(왼쪽)/2(가운데) 탭은 종전대로 클램핑하여 텍스트 영역 밖으로 넘어가지 않게 한다.
        let pos = if ts.tab_type != 1 && ts.position > available_width && available_width > 0.0 {
            available_width
        } else {
            ts.position
        };
        if pos > abs_x + 0.5 {
            return (pos, ts.tab_type, ts.fill_type);
        }
    }
    // auto_tab_right: 커스텀 탭이 모두 지나갔으면 오른쪽 끝을 right 탭으로
    if auto_tab_right && available_width > abs_x + 0.5 {
        return (available_width, 1, 0); // type=1(오른쪽), fill=0(없음)
    }
    // 기본 등간격 탭
    let tab_w = if default_tab_width > 0.0 {
        default_tab_width
    } else {
        48.0
    };
    let next = ((abs_x / tab_w).floor() + 1.0) * tab_w;
    (next, 0, 0) // type=0(왼쪽), fill=0(없음)
}

/// 지정 인덱스부터 다음 탭(또는 문자열 끝)까지의 세그먼트 폭을 측정한다.
fn measure_segment_from(
    chars: &[char],
    cluster_len: &[usize],
    start: usize,
    char_width: &dyn Fn(usize) -> f64,
) -> f64 {
    let mut w = 0.0;
    for i in start..chars.len() {
        if chars[i] == '\t' {
            break;
        }
        if cluster_len[i] == 0 {
            continue;
        }
        w += char_width(i);
    }
    w
}

fn tab_suffix_is_ascii_page_number(chars: &[char], start: usize) -> bool {
    let mut seen_digit = false;
    for ch in chars.iter().skip(start) {
        if *ch == '\t' {
            return false;
        }
        if ch.is_whitespace() {
            continue;
        }
        if ch.is_ascii_digit() {
            seen_digit = true;
            continue;
        }
        return false;
    }
    seen_digit
}

fn right_leader_tab_target_rel(style: &TextStyle, font_size: f64) -> Option<f64> {
    style
        .tab_stops
        .iter()
        .rev()
        .find(|tab| tab.tab_type == 1 && tab.fill_type != 0)
        .map(|tab| tab.position - font_size * 0.25 - style.line_x_offset)
        .filter(|target| target.is_finite())
}

fn right_leader_tab_fill(style: &TextStyle) -> Option<u8> {
    style
        .tab_stops
        .iter()
        .rev()
        .find(|tab| tab.tab_type == 1 && tab.fill_type != 0)
        .map(|tab| tab.fill_type)
}

fn right_leader_body_target_rel(style: &TextStyle) -> Option<f64> {
    if style.available_width <= 0.0 || right_leader_tab_fill(style).is_none() {
        return None;
    }
    let target = style.text_start_offset + style.available_width - style.line_x_offset;
    if target.is_finite() {
        Some(target)
    } else {
        None
    }
}

/// 탭 문자의 위치로부터 탭 리더 정보를 추출한다.
pub fn extract_tab_leaders(text: &str, positions: &[f64], style: &TextStyle) -> Vec<TabLeaderInfo> {
    extract_tab_leaders_with_extended(text, positions, style, &[])
}

/// 탭 리더 추출 (tab_extended 지원)
/// tab_extended: HWPX 인라인 탭 또는 HWP 탭 확장 데이터 (ext[1] = leader/fill_type)
pub fn extract_tab_leaders_with_extended(
    text: &str,
    positions: &[f64],
    style: &TextStyle,
    tab_extended: &[[u16; 7]],
) -> Vec<TabLeaderInfo> {
    let patched = measure_style(style);
    let style = patched.as_ref();
    let chars: Vec<char> = text.chars().collect();
    let tab_w = if style.default_tab_width > 0.0 {
        style.default_tab_width
    } else {
        48.0
    };
    let mut leaders = Vec::new();
    let mut tab_idx = 0usize; // tab_extended 인덱스
    for (i, c) in text.chars().enumerate() {
        if c == '\t' && i + 1 < positions.len() {
            let before_x = positions[i];
            let after_x = positions[i + 1];
            let has_more_tabs_after = chars.iter().skip(i + 1).any(|ch| *ch == '\t');
            let tabdef_page_number_fill = if tab_extended.is_empty()
                && !has_more_tabs_after
                && tab_suffix_is_ascii_page_number(&chars, i + 1)
            {
                right_leader_tab_fill(style)
            } else {
                None
            };

            // 1. tab_extended에서 leader 가져오기 (HWPX 인라인 탭)
            let ext_fill = if tab_idx < tab_extended.len() {
                tab_extended[tab_idx][1] as u8 // ext[1] = leader/fill_type
            } else {
                0
            };

            // 2. TabDef에서 fill_type 가져오기 (HWP TabDef)
            let tabdef_fill = if let Some(fill) = tabdef_page_number_fill {
                fill
            } else if !style.tab_stops.is_empty() || style.auto_tab_right {
                let abs_before = style.line_x_offset + before_x;
                let (_, _, ft) = find_next_tab_stop(
                    abs_before,
                    &style.tab_stops,
                    tab_w,
                    style.auto_tab_right,
                    style.available_width,
                );
                ft
            } else {
                0
            };

            // 둘 중 하나라도 fill이 있으면 리더 추가
            // 오른쪽 정렬 텍스트 앞에 공백 1개 간격 확보
            let fill_type = if ext_fill > 0 { ext_fill } else { tabdef_fill };
            if fill_type > 0 && after_x > before_x + 1.0 {
                let space_gap = style.font_size * 0.25;
                let content_x = text.chars().enumerate().skip(i + 1).find_map(|(j, ch)| {
                    if ch != '\t' && !ch.is_whitespace() && j < positions.len() {
                        Some(positions[j])
                    } else {
                        None
                    }
                });
                let end_x = content_x
                    .map(|x| x - space_gap)
                    .unwrap_or(after_x - space_gap)
                    .min(after_x - space_gap);
                leaders.push(TabLeaderInfo {
                    start_x: before_x,
                    end_x: end_x.max(before_x),
                    fill_type,
                });
            }
            tab_idx += 1;
        }
    }
    if leaders.len() > 1 {
        let mut min_following_end = f64::INFINITY;
        for leader in leaders.iter_mut().rev() {
            if min_following_end.is_finite() && leader.end_x > min_following_end {
                leader.end_x = min_following_end.max(leader.start_x);
            }
            min_following_end = min_following_end.min(leader.end_x);
        }
    }
    leaders
}

// ── EmbeddedTextMeasurer ────────────────────────────────────────────

/// 내장 폰트 메트릭 기반 텍스트 측정기
///
/// font_metrics_data의 582개 폰트 메트릭을 사용하여 문자 폭을 측정한다.
/// 메트릭이 없는 폰트는 CJK=font_size, Latin=font_size×0.5 휴리스틱을 사용한다.
/// 모든 플랫폼에서 동일하게 동작한다 (WASM 포함).
/// 레이아웃은 설치 폰트나 현재 작업 디렉터리에 의존하지 않도록 이 메트릭만 사용한다.
/// 현재 DB에는 pair-kerning 값이 없으므로 `TextStyle::kerning`은 직렬화/페인팅에는
/// 보존되지만 폭 계산에는 적용하지 않는다. 공유 shaping 자산이 생기기 전까지 native와
/// WASM의 동일한 줄바꿈을 우선한다.
/// [#2132] 공용 글자-워크 — Embedded/Wasm measurer 의 compute_char_positions 중복 소거.
/// 폭 산출원(char_px_raw)과 인라인 탭 divergent 경로(inline_tab_x)만 measurer 별 훅.
/// 나머지(특수문자, 자간 클램프, 공백, 커스텀/기본 탭)는 1벌.
// macOS 조판은 음수 advance도 유지하고, Windows 경로는 기존 최소 폭을 유지한다.
fn character_advance(base: f64, c: char, style: &TextStyle, font_size: f64, ratio: f64) -> f64 {
    let authored = scaled_glyph_advance(base, c, style, font_size, ratio);
    let word = if c == ' ' {
        style.extra_word_spacing
    } else {
        0.0
    };
    let advance = authored + style.extra_char_spacing + word;
    if style.font_metrics_policy == FontMetricsPolicy::HcrDeclared
        || (style.native_negative_spacing
            && style.letter_spacing == 0.0
            && style.extra_char_spacing < 0.0
            && advance > 0.0)
    {
        advance
    } else if style.letter_spacing + style.extra_char_spacing < 0.0 {
        advance.max(base * ratio * 0.5)
    } else {
        advance
    }
}

fn compute_char_positions_walk(
    text: &str,
    style: &TextStyle,
    char_px_raw: &dyn Fn(usize, char, &[char], &[usize]) -> f64,
    inline_tab_x: &dyn Fn(usize, f64, &[u16; 7], &[char], &[usize], &dyn Fn(usize) -> f64) -> f64,
) -> Vec<f64> {
    let (font_size, ratio, tab_w) = style_params(style);
    let chars: Vec<char> = text.chars().collect();
    let char_count = chars.len();
    let mut positions = Vec::with_capacity(char_count + 1);
    let mut x = 0.0;
    positions.push(x);

    let cluster_len = build_cluster_len(&chars);
    let has_custom_tabs = !style.tab_stops.is_empty() || style.auto_tab_right;

    let char_width = |i: usize| -> f64 {
        let c = chars[i];
        if c == '\u{2007}' {
            return scaled_glyph_advance(
                font_size * FIXED_WIDTH_SPACE_EM,
                '\u{2007}',
                style,
                font_size,
                ratio,
            ) + style.extra_char_spacing.max(0.0);
        }
        // 인라인 객체 placeholder 는 실제 control node 가 따로 그리므로 텍스트 폭은 0.
        if c == '\u{FFFC}' {
            return 0.0;
        }
        // 하이픈(U+00AD, HWP 코드 24)은 한컴(macOS)이 글꼴의 '-' 글리프와 폭으로
        // 그린다 (hcar-001 p3 `- 법령…` 줄: 맑은 고딕 0.41em 전진).
        let c = if c == '\u{00AD}' { '-' } else { c };
        // [Issue #677] HWP PUA 채움 문자 (U+F081C) — 시각 폭 0 (한컴 PDF 정합).
        // 폭 없는 공백(U+200B)도 0 — 옛한글 PUA 뒤에 붙어 온다 (exam-kor p17 `‘말\u{EBD4}\u{200B}…’`).
        if c == '\u{F081C}' && style.font_metrics_policy == FontMetricsPolicy::HcrDeclared {
            return scaled_glyph_advance(
                hancom_cut_line_em() * font_size,
                c,
                style,
                font_size,
                ratio,
            ) + style.extra_char_spacing;
        }
        if c == '\u{F081C}' || c == '\u{200B}' {
            return 0.0;
        }
        let char_px = char_px_raw(i, c, &chars, &cluster_len);
        character_advance(char_px, c, style, font_size, ratio)
    };

    let mut tab_char_idx = 0usize; // inline_tabs 인덱스
    let mut pending_cluster: Option<(usize, f64)> = None;
    for i in 0..char_count {
        let c = chars[i];
        if cluster_len[i] == 0 {
            if let Some((end, advance)) = pending_cluster {
                if i == end {
                    x += advance;
                    pending_cluster = None;
                }
            }
            positions.push(x);
            continue;
        }
        if c == '\t' {
            if tab_char_idx < style.inline_tabs.len()
                && !inline_tab_defers_to_tab_def(&style.inline_tabs[tab_char_idx], style)
            {
                let ext = &style.inline_tabs[tab_char_idx];
                x = inline_tab_x(i, x, ext, &chars, &cluster_len, &char_width);
                tab_char_idx += 1;
            } else if has_custom_tabs {
                let has_more_tabs_after = chars[i + 1..].contains(&'\t');
                if !has_more_tabs_after && tab_suffix_is_ascii_page_number(&chars, i + 1) {
                    if let Some(target_rel) = right_leader_body_target_rel(style) {
                        let seg_w = measure_segment_from(&chars, &cluster_len, i + 1, &char_width);
                        x = (target_rel - seg_w).max(x);
                        tab_char_idx += 1;
                        positions.push(x);
                        continue;
                    }
                }
                let abs_x = style.line_x_offset + x;
                let (tab_pos, tab_type, fill_type) = find_next_tab_stop(
                    abs_x,
                    &style.tab_stops,
                    tab_w,
                    style.auto_tab_right,
                    style.available_width,
                );
                let rel_tab = tab_pos - style.line_x_offset;
                // [Task #874] auto_tab_right 탭만 col-relative 우측 끝 (리더 탭은 탭 위치)
                // (= text_start_offset + available_width) 까지 정렬.
                let effective_rel_tab =
                    if tab_type == 1 && style.available_width > 0.0 && style.auto_tab_right {
                        style.text_start_offset + style.available_width - style.line_x_offset
                    } else {
                        rel_tab
                    };
                match tab_type {
                    1 => {
                        // 오른쪽
                        let seg_start = if fill_type != 0 {
                            i + 1
                        } else {
                            let mut s = i + 1;
                            while s < chars.len() && chars[s] == ' ' && cluster_len[s] != 0 {
                                s += 1;
                            }
                            s
                        };
                        let seg_w =
                            measure_segment_from(&chars, &cluster_len, seg_start, &char_width);
                        x = (effective_rel_tab - seg_w).max(x);
                    }
                    2 => {
                        // 가운데
                        let seg_w = measure_segment_from(&chars, &cluster_len, i + 1, &char_width);
                        x = (rel_tab - seg_w / 2.0).max(x);
                    }
                    _ => {
                        // 왼쪽(0), 소수점(3)
                        x = rel_tab.max(x);
                    }
                }
                tab_char_idx += 1;
            } else {
                // 기본 등간격 탭: 라인 절대 위치(line_x_offset + x) 기준으로 계산.
                let abs_x = style.line_x_offset + x;
                let next_abs = ((abs_x / tab_w).floor() + 1.0) * tab_w;
                x = (next_abs - style.line_x_offset).max(x);
                tab_char_idx += 1;
            }
            positions.push(x);
            continue;
        }
        let advance = char_width(i);
        if cluster_len[i] > 1 {
            // A caret must not split an extended grapheme. Keep every internal
            // scalar boundary at the cluster start, then apply the advance at
            // the final scalar boundary. This is shared by native and WASM.
            pending_cluster = Some((i + cluster_len[i] - 1, advance));
        } else {
            x += advance;
        }
        positions.push(x);
    }

    positions
}

pub struct EmbeddedTextMeasurer;

impl TextMeasurer for EmbeddedTextMeasurer {
    fn estimate_text_width(&self, text: &str, style: &TextStyle) -> f64 {
        let (font_size, ratio, tab_w) = style_params(style);
        let chars: Vec<char> = text.chars().collect();
        let cluster_len = build_cluster_len(&chars);
        let char_count = chars.len();
        let has_custom_tabs = !style.tab_stops.is_empty() || style.auto_tab_right;

        let char_width = |i: usize| -> f64 {
            let c = chars[i];
            if c == '\u{2007}' {
                return scaled_glyph_advance(
                    font_size * FIXED_WIDTH_SPACE_EM,
                    '\u{2007}',
                    style,
                    font_size,
                    ratio,
                ) + style.extra_char_spacing.max(0.0);
            }
            // 인라인 객체 placeholder 는 실제 control node 가 따로 그리므로 텍스트 폭은 0.
            if c == '\u{FFFC}' {
                return 0.0;
            }
            // 하이픈(U+00AD, HWP 코드 24)은 한컴(macOS)이 글꼴의 '-' 글리프와 폭으로
            // 그린다 (hcar-001 p3 `- 법령…` 줄: 맑은 고딕 0.41em 전진).
            let c = if c == '\u{00AD}' { '-' } else { c };
            // [Issue #677] HWP PUA 채움 문자 (U+F081C) — 시각 폭 0
            // 한컴이 인라인 TAC 표/도형 앞에 삽입하는 placeholder 채움 문자.
            // 한컴 PDF 정합 — 폭 0 으로 라인 inline x 에 영향 없음. fillers 가
            // 표 너비만큼 (≈97 chars × 1 char width = table width) 채워져
            // 표가 fillers 영역 위에 시각적으로 겹쳐 column-left 출력 패턴.
            if c == '\u{F081C}' && style.font_metrics_policy == FontMetricsPolicy::HcrDeclared {
                return scaled_glyph_advance(
                    hancom_cut_line_em() * font_size,
                    c,
                    style,
                    font_size,
                    ratio,
                ) + style.extra_char_spacing;
            }
            if c == '\u{F081C}' || c == '\u{200B}' {
                return 0.0;
            }
            let base_w_raw = if c == '\u{00B7}'
                && crate::renderer::hft_uses_paired_middle_dot(style)
            {
                font_size
            } else if let Some(w) = latin_space_width(style, c, font_size) {
                w
            } else if let Some(w) = missing_hft_bold_char_width(style, c, font_size) {
                w
            } else if let Some(w) = (c == '\u{318D}')
                .then(|| {
                    area_dot_fallback_width(
                        &style.font_family,
                        font_size,
                        style.font_metrics_policy,
                    )
                })
                .flatten()
            {
                w
            } else if let Some(em) =
                hft_missing_pua_em(style, c).or_else(|| hft_ks_punct_em(style, c))
            {
                em * font_size
            } else if let Some(w) = measure_glyph_base_px(
                &style.font_family,
                style.bold,
                style.italic,
                c,
                font_size,
                style.font_metrics_policy,
            ) {
                w
            } else if cluster_len[i] > 1 || is_cjk_char(c) || is_fullwidth_symbol(c) {
                font_size
            } else if is_narrow_punctuation(c) || is_narrow_paren_for_font(&style.font_family, c) {
                // Task #257: 콤마·중점 등은 실제 글리프 폭이 반각보다 뚜렷이
                // 좁음. 폴백 경로에서 font_size * 0.5 를 쓰면 PDF 대비 뒤
                // 글자가 2~3px 우측으로 밀림. 0.3 으로 분기.
                font_size * 0.3
            } else {
                font_size * 0.5
            };
            let base_w = base_w_raw;
            character_advance(base_w, c, style, font_size, ratio)
        };

        let mut total = 0.0;
        let mut tab_char_idx = 0usize;
        for i in 0..char_count {
            let c = chars[i];
            if cluster_len[i] == 0 {
                continue;
            }
            if c == '\t' {
                // 인라인 탭 (HWP tab_extended / HWPX 인라인 탭)
                // NOTE: 네이티브 경로는 `tab_type = ext[2]` 전체 u16 해석을 유지.
                // 기존 golden SVG (issue-147, issue-267) 가 이 "우연한 LEFT 폴백" 동작에
                // 의존하고 있어, 이를 바꾸면 회귀 발생. WASM 경로만 inline_tab_type 사용.
                // [Issue #630 Stage 4 검증] HWP5 의 `ext[0]` 가 이미 right-tab 결과 위치
                // (= 우측 끝 - 한컴_seg_w) 로 저장되어 있어 LEFT fallback 이 인코딩 의도와
                // 정합. RIGHT 정확 매치 시 seg_w 이중 차감 → ≈seg_w (≈112px) 좌측 이탈
                // (aift p4 1-1 등 23/24 라인 모두 영향). 본 LEFT fallback 동작 유지.
                if tab_char_idx < style.inline_tabs.len()
                    && !inline_tab_defers_to_tab_def(&style.inline_tabs[tab_char_idx], style)
                {
                    let ext = &style.inline_tabs[tab_char_idx];
                    let tab_width_px = ext[0] as f64 * 96.0 / 7200.0;
                    let tab_type = ext[2];
                    let tab_target = total + tab_width_px;
                    // [Task #874] auto_tab_right 가 활성된 paragraph 에서 단일 tab 의
                    // 인라인 tab_extended 는 Hancom 의 right-tab 결과 위치(= 우측 끝 -
                    // 한컴_seg_w) 를 ext[0] 로 저장. 우리 폰트의 seg_w 와 다르면 좌측
                    // 이탈 발생 (shortcut.hwp pi=144 `Alt+Shift+C` 27 px 부족). auto_right
                    // 일 때는 우리 metric 기준 right-edge - our_seg_w 로 override.
                    let has_more_tabs_after = chars[i + 1..].contains(&'\t');
                    // [Task #874 #10] ext[2] high-byte 가 명시적 LEFT(1)/DECIMAL(4) 면
                    // auto_tab_right paragraph 라도 override 금지 — exam_math.hwp p7
                    // item 18 (Task #290) 의 inline LEFT tab 회귀 차단.
                    let inline_type_hi = ((tab_type >> 8) & 0xFF) as u8;
                    let inline_is_explicit_left = inline_type_hi == 1 || inline_type_hi == 4;
                    let override_to_right = style.auto_tab_right
                        && ext[5] & 0x4000 == 0
                        && !has_more_tabs_after
                        && style.available_width > 0.0
                        && !inline_is_explicit_left;
                    if override_to_right {
                        // [Task #874 #2] lang split 로 post-tab 콘텐츠가 후속 run 으로
                        // 쪼개진 경우 (예: "F3→Alt+I" → "F3"/"→"/"Alt+I"), 현재 run 내부
                        // 측정만으로는 seg_w 가 부족. paragraph_layout 이 미리 합산한
                        // block_w override 가 있으면 그것을 사용.
                        let seg_w = style.right_tab_block_width_override.unwrap_or_else(|| {
                            measure_segment_from(&chars, &cluster_len, i + 1, &char_width)
                        });
                        let right_edge_rel =
                            style.text_start_offset + style.available_width - style.line_x_offset;
                        total = (right_edge_rel - seg_w).max(total);
                    } else if inline_type_hi == 0
                        && !has_more_tabs_after
                        && tab_suffix_is_ascii_page_number(&chars, i + 1)
                    {
                        if let Some(target_rel) = right_leader_tab_target_rel(style, font_size) {
                            let seg_w =
                                measure_segment_from(&chars, &cluster_len, i + 1, &char_width);
                            total = (target_rel - seg_w).max(total);
                        } else {
                            total = inline_tab_left_x(ext, total, style, tab_width_px);
                        }
                    } else {
                        match tab_type {
                            1 => {
                                let seg_w =
                                    measure_segment_from(&chars, &cluster_len, i + 1, &char_width);
                                total = (tab_target - seg_w).max(total);
                            }
                            2 => {
                                let seg_w =
                                    measure_segment_from(&chars, &cluster_len, i + 1, &char_width);
                                total = (tab_target - seg_w / 2.0).max(total);
                            }
                            _ => {
                                if let Some(stop) = hwpx_inline_right_stop_rel(ext, total, style) {
                                    let seg_w = measure_segment_from(
                                        &chars,
                                        &cluster_len,
                                        i + 1,
                                        &char_width,
                                    );
                                    total = (stop - seg_w).max(total);
                                } else {
                                    total = inline_tab_left_x(ext, total, style, tab_width_px);
                                }
                            }
                        }
                    }
                    tab_char_idx += 1;
                } else if has_custom_tabs {
                    let has_more_tabs_after = chars[i + 1..].contains(&'\t');
                    if !has_more_tabs_after && tab_suffix_is_ascii_page_number(&chars, i + 1) {
                        if let Some(target_rel) = right_leader_body_target_rel(style) {
                            let seg_w =
                                measure_segment_from(&chars, &cluster_len, i + 1, &char_width);
                            total = (target_rel - seg_w).max(total);
                            tab_char_idx += 1;
                            continue;
                        }
                    }
                    let abs_x = style.line_x_offset + total;
                    let (tab_pos, tab_type, fill_type) = find_next_tab_stop(
                        abs_x,
                        &style.tab_stops,
                        tab_w,
                        style.auto_tab_right,
                        style.available_width,
                    );
                    let rel_tab = tab_pos - style.line_x_offset;
                    // [Task #874] auto_tab_right 의 tab_pos = available_width 는 텍스트
                    // 영역 시작 기준 상대값. col-relative 우측 끝 = text_start_offset +
                    // available_width. line_x_offset 도 col-relative 이므로 변환.
                    let effective_rel_tab =
                        if tab_type == 1 && style.available_width > 0.0 && style.auto_tab_right {
                            style.text_start_offset + style.available_width - style.line_x_offset
                        } else {
                            rel_tab
                        };
                    match tab_type {
                        1 => {
                            // 오른쪽
                            let seg_w =
                                measure_segment_from(&chars, &cluster_len, i + 1, &char_width);
                            total = (effective_rel_tab - seg_w).max(total);
                        }
                        2 => {
                            // 가운데
                            let seg_w =
                                measure_segment_from(&chars, &cluster_len, i + 1, &char_width);
                            total = (rel_tab - seg_w / 2.0).max(total);
                        }
                        _ => {
                            // 왼쪽(0), 소수점(3) → 왼쪽과 동일 처리
                            total = rel_tab.max(total);
                        }
                    }
                    tab_char_idx += 1;
                } else {
                    // 기본 등간격 탭: 라인 절대 위치(line_x_offset + total) 기준으로 계산
                    let abs_x = style.line_x_offset + total;
                    let next_abs = ((abs_x / tab_w).floor() + 1.0) * tab_w;
                    total = (next_abs - style.line_x_offset).max(total);
                    tab_char_idx += 1;
                }
                continue;
            }
            if cluster_len[i] == 0 {
                continue;
            }
            total += char_width(i);
        }
        // Keep Mac measurements at the same precision as glyph positions and
        // the WASM measurer. Rounding a run and its trailing space separately
        // changes justification slack and accumulates across word boundaries.
        // The default Windows reference corpus retains its historical rounding.
        if style.font_metrics_policy == FontMetricsPolicy::HcrDeclared {
            total
        } else {
            total.round()
        }
    }

    fn compute_char_positions(&self, text: &str, style: &TextStyle) -> Vec<f64> {
        let (font_size, _ratio, _tab_w) = style_params(style);
        // [#2132] 폭 산출원 훅 — embedded 메트릭 lookup + 폴백 사다리 (Task #257 포함).
        let char_px_raw = |_i: usize, c: char, _chars: &[char], cluster_len: &[usize]| -> f64 {
            let i = _i;
            if c == '\u{00B7}' && crate::renderer::hft_uses_paired_middle_dot(style) {
                font_size
            } else if let Some(w) = latin_space_width(style, c, font_size) {
                w
            } else if let Some(w) = missing_hft_bold_char_width(style, c, font_size) {
                w
            } else if let Some(w) = (c == '\u{318D}')
                .then(|| {
                    area_dot_fallback_width(
                        &style.font_family,
                        font_size,
                        style.font_metrics_policy,
                    )
                })
                .flatten()
            {
                w
            } else if let Some(em) =
                hft_missing_pua_em(style, c).or_else(|| hft_ks_punct_em(style, c))
            {
                em * font_size
            } else if let Some(w) = measure_glyph_base_px(
                &style.font_family,
                style.bold,
                style.italic,
                c,
                font_size,
                style.font_metrics_policy,
            ) {
                w
            } else if cluster_len[i] > 1 || is_cjk_char(c) || is_fullwidth_symbol(c) {
                font_size
            } else if is_narrow_punctuation(c) || is_narrow_paren_for_font(&style.font_family, c) {
                // Task #257: 콤마·중점 등 narrow glyph 폴백 폭 (0.5 → 0.3).
                font_size * 0.3
            } else {
                font_size * 0.5
            }
        };
        // [#2132] 인라인 탭 divergent 경로 훅 — HWP5 raw ext 인코딩 legacy 해석 유지
        // (Issue #630 Stage 4/6, Task #874 계열 — 원본 무변경 이동).
        let inline_tab_x = |i: usize,
                            x_in: f64,
                            ext: &[u16; 7],
                            chars: &[char],
                            cluster_len: &[usize],
                            char_width: &dyn Fn(usize) -> f64|
         -> f64 {
            let mut x = x_in;
            let tab_width_px = ext[0] as f64 * 96.0 / 7200.0;
            let tab_type_raw = ext[2];
            let tab_target = x + tab_width_px;
            // [Task #874] auto_tab_right paragraph + 단일 tab: ext[0] = Hancom의
            // right-tab 결과 위치 (= 우측 끝 - 한컴_seg_w). 우리 폰트의 seg_w 와 차이
            // 가 있으면 좌측 이탈. col-relative right edge - our_seg_w 로 override.
            let has_more_tabs_after = chars[i + 1..].contains(&'\t');
            // [Task #874 #10] ext[2] high-byte 가 명시적 LEFT(1)/DECIMAL(4) 면
            // auto_tab_right paragraph 라도 override 금지 — exam_math.hwp p7
            // item 18 (Task #290) 의 inline LEFT tab 회귀 차단.
            let inline_type_hi = ((tab_type_raw >> 8) & 0xFF) as u8;
            let inline_is_explicit_left = inline_type_hi == 1 || inline_type_hi == 4;
            let override_to_right = style.auto_tab_right
                && ext[5] & 0x4000 == 0
                && !has_more_tabs_after
                && style.available_width > 0.0
                && !inline_is_explicit_left;
            // [Issue #630 Stage 6] HWP5 inline tab `ext[2]` 인코딩 = `(enum+1)<<8 | fill`
            // 이므로 high-byte 추출이 정확. 단, RIGHT(high-byte=2) + leader(fill≠0)
            // 의 경우 한컴 ext[0] 가 이미 "(우측 끝 - 한컴_seg_w)" 까지의 거리로
            // 저장 (Stage 4 검증).
            let body_right_text_rel = if style.available_width > 0.0 {
                style.text_start_offset + style.available_width - style.line_x_offset
            } else {
                f64::INFINITY
            };
            let body_right_legacy = if style.available_width > 0.0 {
                style.available_width - style.line_x_offset
            } else {
                f64::INFINITY
            };
            if override_to_right {
                // [Task #874 #2] lang split 후속 run 합산 override.
                let seg_w = if let Some(w) = style.right_tab_block_width_override {
                    w
                } else {
                    let seg_start = {
                        let mut s = i + 1;
                        while s < chars.len() && chars[s] == ' ' && cluster_len[s] != 0 {
                            s += 1;
                        }
                        s
                    };
                    measure_segment_from(&chars, &cluster_len, seg_start, &char_width)
                };
                x = (body_right_text_rel - seg_w).max(x);
            } else if inline_type_hi == 0
                && !has_more_tabs_after
                && tab_suffix_is_ascii_page_number(&chars, i + 1)
            {
                if let Some(target_rel) = right_leader_tab_target_rel(style, font_size) {
                    let seg_w = measure_segment_from(&chars, &cluster_len, i + 1, &char_width);
                    x = (target_rel - seg_w).max(x);
                } else {
                    x = inline_tab_left_x(ext, x, style, tab_width_px);
                }
            } else {
                let high_byte = (tab_type_raw >> 8) & 0xFF;
                let fill_low = tab_type_raw & 0xFF;
                match (high_byte, tab_type_raw) {
                    (_, 1) => {
                        // 기존 raw 1 (LEFT 또는 잘못된 RIGHT 1) — 호환 유지
                        let seg_start = {
                            let mut s = i + 1;
                            while s < chars.len() && chars[s] == ' ' && cluster_len[s] != 0 {
                                s += 1;
                            }
                            s
                        };
                        let seg_w =
                            measure_segment_from(&chars, &cluster_len, seg_start, &char_width);
                        x = (tab_target - seg_w).max(x);
                    }
                    (_, 2) => {
                        // 기존 raw 2 — 호환 유지
                        let seg_w = measure_segment_from(&chars, &cluster_len, i + 1, &char_width);
                        x = (tab_target - seg_w / 2.0).max(x);
                    }
                    (2, _) if hwpx_inline_right_stop_rel(ext, x, style).is_some() => {
                        // HWPX 인라인 오른쪽 탭: 문단 탭 정의의 오른쪽 탭 위치에 뒤 글자 끝을
                        // 맞춘다 (본문 오른쪽 끝이 아니다 — aift 목차 357HU 안쪽).
                        let stop = hwpx_inline_right_stop_rel(ext, x, style).unwrap_or(x);
                        let seg_w = measure_segment_from(chars, cluster_len, i + 1, char_width);
                        x = (stop - seg_w).max(x);
                    }
                    (2, _) if fill_low != 0 => {
                        // [Task #874 후속] 단일-run RIGHT + leader (목차 페이지번호) —
                        // Task #874 는 cross-run RIGHT+leader 의 text_start_offset
                        // 미포함 본질을 fix (body_right_text_rel +
                        // right_tab_block_width_override). 단일-run 케이스는
                        // 여전히 body_right_legacy (= available_width - line_x_offset)
                        // 사용 → text_start_offset 미포함 으로 cell right inner
                        // (= text_start_offset + available_width) 미달. 또한 leading
                        // space skip 으로 seg_w 가 space 폭만큼 과소 → digit right
                        // edge 가 cell right inner 보다 좌측에 위치 (정렬 미달).
                        //
                        // Fix: \t 뒤 content 가 있는 단일-run 은 cell_right_run_rel
                        // (= text_start_offset + available_width - line_x_offset) 정렬
                        // + seg_w_full (i+1 부터, leading space 포함). content 없는
                        // trailing space / 끝 케이스 (= cross-run 직전) 는 원본 path
                        // 유지 (다음 run 의 pending_right_tab 분기가 처리).
                        let seg_start_skipped = {
                            let mut s = i + 1;
                            while s < chars.len() && chars[s] == ' ' && cluster_len[s] != 0 {
                                s += 1;
                            }
                            s
                        };
                        let has_content_after = seg_start_skipped < chars.len();
                        if has_content_after {
                            let seg_w_full =
                                measure_segment_from(&chars, &cluster_len, i + 1, &char_width);
                            let cell_right_run_rel = style.text_start_offset
                                + style.available_width
                                - style.line_x_offset;
                            x = (cell_right_run_rel - seg_w_full).max(x);
                        } else {
                            let seg_w = measure_segment_from(
                                &chars,
                                &cluster_len,
                                seg_start_skipped,
                                &char_width,
                            );
                            x = (body_right_legacy - seg_w).max(x);
                        }
                    }
                    (2, _) => {
                        // RIGHT 인라인 탭 (no leader): 한컴 metrics 차이 흡수.
                        let seg_start = {
                            let mut s = i + 1;
                            while s < chars.len() && chars[s] == ' ' && cluster_len[s] != 0 {
                                s += 1;
                            }
                            s
                        };
                        let seg_w =
                            measure_segment_from(&chars, &cluster_len, seg_start, &char_width);
                        x = (body_right_legacy - seg_w).max(x);
                    }
                    _ => {
                        x = inline_tab_left_x(ext, x, style, tab_width_px);
                    }
                }
            }
            x
        };
        compute_char_positions_walk(text, style, &char_px_raw, &inline_tab_x)
    }
}

// ── WASM 전용 내부 코드 ─────────────────────────────────────────────
//
// JS Canvas measureText 브릿지, LRU 캐시, HWP 단위 양자화 등
// WASM 빌드에서만 컴파일된다.

#[cfg(target_arch = "wasm32")]
mod wasm_internals {
    use std::cell::RefCell;
    use wasm_bindgen::prelude::*;

    // globalThis.measureTextWidth(font, text) → width in pixels
    // editor.html/index.html의 <head>에 정의된 글로벌 함수를 호출한다.
    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = globalThis, js_name = "measureTextWidth")]
        fn js_measure_text_width(font: &str, text: &str) -> f64;
    }

    // ── JS measureText 결과 LRU 캐시 ──
    //
    // js_measure_text_width()는 항상 1000px 고정 크기로 측정하므로
    // (measure_font, char) 쌍을 키로 캐싱하면 모든 font_size에서 재사용 가능하다.
    // WASM은 단일 스레드이므로 thread_local + RefCell로 충분하다.

    /// Vec 기반 LRU 캐시 (256 엔트리)
    ///
    /// 용량 ≤ 256이므로 선형 탐색(수 μs)이 JS 브릿지 호출(~50μs)보다 빠르다.
    /// 용량 초과 시 가장 오래된 25%를 제거한다 (webhwp 방식).
    struct MeasureCache {
        entries: Vec<(u64, f64)>, // (key_hash, raw_px) — 접근 순서 (최근이 뒤)
        capacity: usize,
    }

    impl MeasureCache {
        fn new(capacity: usize) -> Self {
            Self {
                entries: Vec::with_capacity(capacity),
                capacity,
            }
        }

        fn get(&mut self, key: u64) -> Option<f64> {
            if let Some(idx) = self.entries.iter().position(|(k, _)| *k == key) {
                let entry = self.entries.remove(idx);
                let val = entry.1;
                self.entries.push(entry); // MRU로 이동
                Some(val)
            } else {
                None
            }
        }

        fn insert(&mut self, key: u64, value: f64) {
            if self.entries.len() >= self.capacity {
                // 가장 오래된 25% 제거
                let remove_count = self.capacity / 4;
                self.entries.drain(0..remove_count);
            }
            self.entries.push((key, value));
        }
    }

    thread_local! {
        static JS_MEASURE_CACHE: RefCell<MeasureCache> = RefCell::new(MeasureCache::new(256));
    }

    /// 폰트 등록 변화·레이아웃 새로고침 시 JS 실측 캐시를 비운다.
    pub(super) fn clear_js_measure_cache() {
        JS_MEASURE_CACHE.with(|cache| cache.borrow_mut().entries.clear());
    }

    /// 캐시 키 생성: hash(measure_font + char)
    fn measure_cache_key(measure_font: &str, c: char) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut h = DefaultHasher::new();
        measure_font.hash(&mut h);
        c.hash(&mut h);
        h.finish()
    }

    /// JS measureText 캐싱 래퍼
    ///
    /// 캐시 히트 시 WASM↔JS 브릿지 호출 없이 즉시 반환.
    /// 미스 시 js_measure_text_width() 호출 후 결과를 캐시에 저장.
    fn cached_js_measure(measure_font: &str, c: char) -> f64 {
        let key = measure_cache_key(measure_font, c);
        JS_MEASURE_CACHE.with(|cache| {
            if let Some(val) = cache.borrow_mut().get(key) {
                return val;
            }
            let val = js_measure_text_width(measure_font, &c.to_string());
            cache.borrow_mut().insert(key, val);
            val
        })
    }

    /// 한컴 webhwp 방식 문자 폭 측정 (HWP 단위 양자화)
    ///
    /// 파이프라인: 내장 메트릭 → JS 1000px 측정 → font_size/1000 스케일링 → HWP 단위(×75) → 정수 반올림 → px
    pub(super) fn measure_char_width_hwp(
        font_family: &str,
        bold: bool,
        italic: bool,
        c: char,
        hangul_width_hwp: i32,
        font_size: f64,
        policy: super::FontMetricsPolicy,
    ) -> f64 {
        // 1차: 내장 메트릭 (JS 브릿지 호출 불필요)
        if let Some(w) =
            super::measure_glyph_base_px(font_family, bold, italic, c, font_size, policy)
        {
            return w;
        }

        // 2차: 한글 음절 → '가' 대리 측정값 재사용 (이미 HWP 단위)
        if c >= '\u{AC00}' && c <= '\u{D7A3}' {
            return hangul_width_hwp as f64 / 75.0;
        }

        // 좁은 구두점 폴백 — native EmbeddedTextMeasurer 와 동기화.
        // measure_char_width_embedded 의 is_narrow_punctuation 분기 (0.3 em) 가
        // 적용되지 못한 미등록 폰트 케이스 (예: 휴먼명조 U+2027) 에서 JS Canvas
        // 측정값 (~0.5 em) 이 그대로 들어가지 않도록 동일 폴백 적용.
        if super::is_narrow_punctuation(c) || super::is_narrow_paren_for_font(font_family, c) {
            return font_size * 0.3;
        }

        // [Task #977] 미등록 폰트 폴백을 native EmbeddedTextMeasurer 와 동기화한다.
        // 종전(PR #1026 이전)은 JS Canvas `measureText` 실측값을 사용했으나, 미등록
        // 폰트는 브라우저 fallback 폰트로 측정되어 폰트별로 폭이 달라(예: 나눔바른
        // 고딕 ≠ 맑은 고딕) 목차 페이지의 선두 공백 CharShape 가 인접 문단과 다를 때
        // 개요번호 시작 x 가 ~9~10px 어긋났다. native compute_char_positions 와 동일한
        // 휴리스틱(공백·일반 0.5em, CJK·fullwidth em, narrow_punct 0.3em)으로 폰트 무관
        // 통일한다. PR #1026 의 narrow_punct 분기는 위에서 이미 처리(보존).
        if super::is_cjk_char(c) || super::is_fullwidth_symbol(c) {
            return font_size;
        }
        font_size * 0.5
    }

    /// 한글 '가' 대리 측정값 (HWP 단위, 정수)
    /// 내장 메트릭이 있으면 JS 호출 없이 반환.
    ///
    /// [Task #977 v3] 미등록 폰트의 한글 폭은 native `EmbeddedTextMeasurer`
    /// 폴백(`font_size`, 1.0 em CJK 휴리스틱)과 동기화한다. 종전 JS `cached_js_measure('가')`
    /// 폴백은 브라우저의 폰트 대체 결과(폰트별 ≠ 한컴 metrics)를 폭으로 채택해
    /// 한컴 저장값(tab_extended[0] = "tab_pos - 한컴_선행텍스트폭")과 합산 시 오차가
    /// 누적, 목차 페이지번호의 디지트 x 좌표가 행별로 어긋났다.
    /// 미등록 한글 폰트(나눔바른고딕 등)에서도 native 와 일관된 폭으로 폴백한다.
    pub(super) fn measure_hangul_width_hwp(
        font_family: &str,
        bold: bool,
        italic: bool,
        font_size: f64,
    ) -> i32 {
        if let Some(w) =
            super::measure_char_width_embedded(font_family, bold, italic, '\u{AC00}', font_size)
        {
            return (w * 75.0).round() as i32;
        }
        // native EmbeddedTextMeasurer 동기화: 미등록 폰트의 한글(CJK)은 font_size (1.0 em).
        (font_size * 75.0).round() as i32
    }
}

/// 폰트명 기준 폭 캐시(JS 실측 LRU, 수식 canvas 실측)를 모두 비운다.
///
/// 런타임 폰트 메트릭 등록/해제와 `refresh_layout_native` 에서 호출해
/// 이후 레이아웃이 새 폭으로 다시 측정되게 한다.
pub(crate) fn clear_measure_caches() {
    clear_measure_width_cache();
    #[cfg(target_arch = "wasm32")]
    {
        wasm_internals::clear_js_measure_cache();
        BROWSER_FONT_AVAIL.with(|cache| cache.borrow_mut().clear());
    }
    crate::renderer::equation::measure::clear_css_run_cache();
}

// ── WasmTextMeasurer ────────────────────────────────────────────────

/// JS Canvas 브릿지 기반 텍스트 측정기 (WASM 전용)
///
/// 1000pt 측정 + HWP 단위 양자화로 한컴과 동일한 정밀도를 확보한다.
/// 내장 메트릭 우선, 미등록 폰트만 JS 브릿지 사용 (LRU 캐시 256 엔트리).
#[cfg(target_arch = "wasm32")]
pub struct WasmTextMeasurer;

#[cfg(target_arch = "wasm32")]
impl TextMeasurer for WasmTextMeasurer {
    fn estimate_text_width(&self, text: &str, style: &TextStyle) -> f64 {
        let (font_size, ratio, tab_w) = style_params(style);
        let hangul_hwp = wasm_internals::measure_hangul_width_hwp(
            &style.font_family,
            style.bold,
            style.italic,
            font_size,
        );

        let chars: Vec<char> = text.chars().collect();
        let cluster_len = build_cluster_len(&chars);
        let char_count = chars.len();
        let has_custom_tabs = !style.tab_stops.is_empty() || style.auto_tab_right;

        let char_width = |i: usize| -> f64 {
            let c = chars[i];
            if c == '\u{2007}' {
                return scaled_glyph_advance(
                    font_size * FIXED_WIDTH_SPACE_EM,
                    '\u{2007}',
                    style,
                    font_size,
                    ratio,
                ) + style.extra_char_spacing.max(0.0);
            }
            // 인라인 객체 placeholder 는 실제 control node 가 따로 그리므로 텍스트 폭은 0.
            if c == '\u{FFFC}' {
                return 0.0;
            }
            // 하이픈(U+00AD, HWP 코드 24)은 한컴(macOS)이 글꼴의 '-' 글리프와 폭으로
            // 그린다 (hcar-001 p3 `- 법령…` 줄: 맑은 고딕 0.41em 전진).
            let c = if c == '\u{00AD}' { '-' } else { c };
            // [Issue #677] HWP PUA 채움 문자 (U+F081C) — 시각 폭 0
            // 한컴이 인라인 TAC 표/도형 앞에 삽입하는 placeholder 채움 문자.
            // 한컴 PDF 정합 — 폭 0 으로 라인 inline x 에 영향 없음. fillers 가
            // 표 너비만큼 (≈97 chars × 1 char width = table width) 채워져
            // 표가 fillers 영역 위에 시각적으로 겹쳐 column-left 출력 패턴.
            if c == '\u{F081C}' && style.font_metrics_policy == FontMetricsPolicy::HcrDeclared {
                return scaled_glyph_advance(
                    hancom_cut_line_em() * font_size,
                    c,
                    style,
                    font_size,
                    ratio,
                ) + style.extra_char_spacing;
            }
            if c == '\u{F081C}' || c == '\u{200B}' {
                return 0.0;
            }
            let char_px_raw =
                if c == '\u{00B7}' && crate::renderer::hft_uses_paired_middle_dot(style) {
                    font_size
                } else if let Some(w) = latin_space_width(style, c, font_size) {
                    w
                } else if let Some(w) = missing_hft_bold_char_width(style, c, font_size) {
                    w
                } else if cluster_len[i] > 1 {
                    hangul_hwp as f64 / 75.0
                } else if let Some(em) =
                    hft_missing_pua_em(style, c).or_else(|| hft_ks_punct_em(style, c))
                {
                    em * font_size
                } else {
                    wasm_internals::measure_char_width_hwp(
                        &style.font_family,
                        style.bold,
                        style.italic,
                        c,
                        hangul_hwp,
                        font_size,
                        style.font_metrics_policy,
                    )
                };
            let char_px = char_px_raw;
            character_advance(char_px, c, style, font_size, ratio)
        };

        let mut total = 0.0;
        let mut tab_char_idx = 0usize; // [Task #296] inline_tabs 인덱스
        for i in 0..char_count {
            let c = chars[i];
            if cluster_len[i] == 0 {
                continue;
            }
            if c == '\t' {
                // [Task #296] 인라인 탭 (HWP tab_extended / HWPX 인라인 탭) 을
                // WASM Canvas 경로에서도 존중. 네이티브 EmbeddedTextMeasurer 와 동일 구조.
                if tab_char_idx < style.inline_tabs.len()
                    && !inline_tab_defers_to_tab_def(&style.inline_tabs[tab_char_idx], style)
                {
                    let ext = &style.inline_tabs[tab_char_idx];
                    let tab_width_px = ext[0] as f64 * 96.0 / 7200.0;
                    let tab_type = inline_tab_type(ext);
                    // [Task #874] auto_tab_right paragraph + 단일 tab: native 와 동일.
                    let has_more_tabs_after = chars[i + 1..].iter().any(|c| *c == '\t');
                    // [Issue #900] Task #874 #10 와 동일 — ext[2] high-byte 가 명시적
                    // LEFT(1)/DECIMAL(4) 면 auto_tab_right paragraph 라도 override 금지.
                    // exam_math.hwp pi=0 ("1.\t의 값은? [2점]") 의 inline LEFT tab 이
                    // WASM 에서 right-align 되어 equation/text 가 column 우측으로 밀리는
                    // 회귀 차단. EmbeddedTextMeasurer (native) 는 이미 가드 적용.
                    let inline_is_explicit_left = tab_type == 1 || tab_type == 4;
                    let override_to_right = style.auto_tab_right
                        && ext[5] & 0x4000 == 0
                        && !has_more_tabs_after
                        && style.available_width > 0.0
                        && !inline_is_explicit_left;
                    if override_to_right {
                        // [Task #874 #2] lang split 후속 run 합산 override (native 와 동일).
                        let seg_w = style.right_tab_block_width_override.unwrap_or_else(|| {
                            measure_segment_from(&chars, &cluster_len, i + 1, &char_width)
                        });
                        let right_edge_rel =
                            style.text_start_offset + style.available_width - style.line_x_offset;
                        total = (right_edge_rel - seg_w).max(total);
                    } else if tab_type == 0
                        && !has_more_tabs_after
                        && tab_suffix_is_ascii_page_number(&chars, i + 1)
                    {
                        if let Some(target_rel) = right_leader_tab_target_rel(style, font_size) {
                            let seg_w =
                                measure_segment_from(&chars, &cluster_len, i + 1, &char_width);
                            total = (target_rel - seg_w).max(total);
                        } else {
                            total = inline_tab_left_x(ext, total, style, tab_width_px);
                        }
                    } else {
                        match tab_type {
                            2 => {
                                // 저장된 RIGHT 탭 폭은 뒤 블록 폭을 뺀 이동량이다.
                                // native처럼 다시 빼지 않는다 (복지 서식의 오른쪽 괄호).
                                total = inline_tab_left_x(ext, total, style, tab_width_px);
                            }
                            3 => {
                                // 저장된 CENTER 탭 폭은 뒤 블록을 가운데 맞춘 뒤의 이동량이다.
                                total = inline_tab_left_x(ext, total, style, tab_width_px);
                            }
                            _ => {
                                // LEFT(0/1), DECIMAL(4), 기타 — HWPX 간격 탭은 그리드 정지
                                if let Some(stop) = hwpx_inline_right_stop_rel(ext, total, style) {
                                    let seg_w = measure_segment_from(
                                        &chars,
                                        &cluster_len,
                                        i + 1,
                                        &char_width,
                                    );
                                    total = (stop - seg_w).max(total);
                                } else {
                                    total = inline_tab_left_x(ext, total, style, tab_width_px);
                                }
                            }
                        }
                    }
                    tab_char_idx += 1;
                } else if has_custom_tabs {
                    let has_more_tabs_after = chars[i + 1..].iter().any(|c| *c == '\t');
                    if !has_more_tabs_after && tab_suffix_is_ascii_page_number(&chars, i + 1) {
                        if let Some(target_rel) = right_leader_body_target_rel(style) {
                            let seg_w =
                                measure_segment_from(&chars, &cluster_len, i + 1, &char_width);
                            total = (target_rel - seg_w).max(total);
                            tab_char_idx += 1;
                            continue;
                        }
                    }
                    let abs_x = style.line_x_offset + total;
                    let (tab_pos, tab_type, fill_type) = find_next_tab_stop(
                        abs_x,
                        &style.tab_stops,
                        tab_w,
                        style.auto_tab_right,
                        style.available_width,
                    );
                    let rel_tab = tab_pos - style.line_x_offset;
                    // [Task #874] auto_tab_right 탭만 col-relative 우측 끝 (리더 탭은 탭 위치)
                    // (= text_start_offset + available_width) 까지 정렬.
                    let effective_rel_tab =
                        if tab_type == 1 && style.available_width > 0.0 && style.auto_tab_right {
                            style.text_start_offset + style.available_width - style.line_x_offset
                        } else {
                            rel_tab
                        };
                    match tab_type {
                        1 => {
                            let seg_w =
                                measure_segment_from(&chars, &cluster_len, i + 1, &char_width);
                            total = (effective_rel_tab - seg_w).max(total);
                        }
                        2 => {
                            let seg_w =
                                measure_segment_from(&chars, &cluster_len, i + 1, &char_width);
                            total = (rel_tab - seg_w / 2.0).max(total);
                        }
                        _ => {
                            total = rel_tab.max(total);
                        }
                    }
                    tab_char_idx += 1;
                } else {
                    // 기본 등간격 탭: 라인 절대 위치(line_x_offset + total) 기준으로 계산
                    let abs_x = style.line_x_offset + total;
                    let next_abs = ((abs_x / tab_w).floor() + 1.0) * tab_w;
                    total = (next_abs - style.line_x_offset).max(total);
                    tab_char_idx += 1;
                }
                continue;
            }
            total += char_width(i);
        }
        total
    }

    fn compute_char_positions(&self, text: &str, style: &TextStyle) -> Vec<f64> {
        let (font_size, _ratio, _tab_w) = style_params(style);
        let hangul_hwp = wasm_internals::measure_hangul_width_hwp(
            &style.font_family,
            style.bold,
            style.italic,
            font_size,
        );
        // [#2132] 폭 산출원 훅 — wasm canvas 측정.
        let char_px_raw = |i: usize, c: char, _chars: &[char], cluster_len: &[usize]| -> f64 {
            if c == '\u{00B7}' && crate::renderer::hft_uses_paired_middle_dot(style) {
                font_size
            } else if let Some(w) = latin_space_width(style, c, font_size) {
                w
            } else if let Some(w) = missing_hft_bold_char_width(style, c, font_size) {
                w
            } else if cluster_len[i] > 1 {
                hangul_hwp as f64 / 75.0
            } else if let Some(em) =
                hft_missing_pua_em(style, c).or_else(|| hft_ks_punct_em(style, c))
            {
                em * font_size
            } else {
                wasm_internals::measure_char_width_hwp(
                    &style.font_family,
                    style.bold,
                    style.italic,
                    c,
                    hangul_hwp,
                    font_size,
                    style.font_metrics_policy,
                )
            }
        };
        // [#2132] 인라인 탭 divergent 경로 훅 — inline_tab_type 헬퍼 해석 (Task #296).
        let inline_tab_x = |i: usize,
                            x_in: f64,
                            ext: &[u16; 7],
                            chars: &[char],
                            cluster_len: &[usize],
                            char_width: &dyn Fn(usize) -> f64|
         -> f64 {
            let mut x = x_in;
            let tab_width_px = ext[0] as f64 * 96.0 / 7200.0;
            let tab_type = inline_tab_type(ext);
            let fill_low = (ext[2] & 0xFF) as u8;
            // [Task #874] auto_tab_right paragraph + 단일 tab: native 와 동일.
            let has_more_tabs_after = chars[i + 1..].iter().any(|c| *c == '\t');
            // [Issue #900] Task #874 #10 와 동일 가드 — 인라인 LEFT(1)/DECIMAL(4)
            // 탭은 auto_tab_right 라도 right-align 금지. estimate_text_width 와
            // 동일 처리 — pi=0 의 tab 위치 정합 (equation/text 가 column 우측으로
            // 밀리는 회귀 차단).
            let inline_is_explicit_left = tab_type == 1 || tab_type == 4;
            let override_to_right = style.auto_tab_right
                && ext[5] & 0x4000 == 0
                && !has_more_tabs_after
                && style.available_width > 0.0
                && !inline_is_explicit_left;
            // [Issue #630 Stage 6] RIGHT + leader (fill ≠ 0): ')' 끝이 본문
            // 우측 끝까지 정렬.
            let body_right_text_rel = if style.available_width > 0.0 {
                style.text_start_offset + style.available_width - style.line_x_offset
            } else {
                f64::INFINITY
            };
            let body_right_legacy = if style.available_width > 0.0 {
                style.available_width - style.line_x_offset
            } else {
                f64::INFINITY
            };
            if override_to_right {
                // [Task #874 #2] lang split 후속 run 합산 override (native 와 동일).
                let seg_w = if let Some(w) = style.right_tab_block_width_override {
                    w
                } else {
                    let seg_start = {
                        let mut s = i + 1;
                        while s < chars.len() && chars[s] == ' ' && cluster_len[s] != 0 {
                            s += 1;
                        }
                        s
                    };
                    measure_segment_from(&chars, &cluster_len, seg_start, &char_width)
                };
                x = (body_right_text_rel - seg_w).max(x);
            } else if tab_type == 0
                && !has_more_tabs_after
                && tab_suffix_is_ascii_page_number(&chars, i + 1)
            {
                if let Some(target_rel) = right_leader_tab_target_rel(style, font_size) {
                    let seg_w = measure_segment_from(&chars, &cluster_len, i + 1, &char_width);
                    x = (target_rel - seg_w).max(x);
                } else {
                    x = inline_tab_left_x(ext, x, style, tab_width_px);
                }
            } else {
                match tab_type {
                    2 if hwpx_inline_right_stop_rel(ext, x, style).is_some() => {
                        // HWPX 인라인 오른쪽 탭: 문단 탭 정의의 오른쪽 탭 위치에 뒤 글자 끝을
                        // 맞춘다 (본문 오른쪽 끝이 아니다 — aift 목차 357HU 안쪽).
                        let stop = hwpx_inline_right_stop_rel(ext, x, style).unwrap_or(x);
                        let seg_w = measure_segment_from(chars, cluster_len, i + 1, char_width);
                        x = (stop - seg_w).max(x);
                    }
                    2 if fill_low != 0 => {
                        // [Task #874 후속] 단일-run RIGHT + leader (목차 페이지번호).
                        // EmbeddedTextMeasurer 영역 정합 (text_measurement.rs 위쪽 동일
                        // 분기 본문 참조). \t 뒤 content 가 있는 단일-run 은
                        // cell_right_run_rel (= text_start_offset + available_width -
                        // line_x_offset) 정렬 + seg_w_full (leading space 포함).
                        // content 없는 trailing space / 끝 케이스는 원본 path 유지.
                        let seg_start_skipped = {
                            let mut s = i + 1;
                            while s < chars.len() && chars[s] == ' ' && cluster_len[s] != 0 {
                                s += 1;
                            }
                            s
                        };
                        let has_content_after = seg_start_skipped < chars.len();
                        if has_content_after {
                            let seg_w_full =
                                measure_segment_from(&chars, &cluster_len, i + 1, &char_width);
                            let cell_right_run_rel = style.text_start_offset
                                + style.available_width
                                - style.line_x_offset;
                            x = (cell_right_run_rel - seg_w_full).max(x);
                        } else {
                            let seg_w = measure_segment_from(
                                &chars,
                                &cluster_len,
                                seg_start_skipped,
                                &char_width,
                            );
                            x = (body_right_legacy - seg_w).max(x);
                        }
                    }
                    2 => {
                        // RIGHT 이동량에는 뒤 블록의 우측 정렬이 이미 반영되어 있다.
                        x = inline_tab_left_x(ext, x, style, tab_width_px);
                    }
                    3 => {
                        // native와 같이 저장된 CENTER 탭 이동량을 그대로 사용한다.
                        x = inline_tab_left_x(ext, x, style, tab_width_px);
                    }
                    _ => {
                        // LEFT(0/1), DECIMAL(4), 기타 — HWPX 간격 탭은 그리드 정지
                        x = inline_tab_left_x(ext, x, style, tab_width_px);
                    }
                }
            }
            x
        };
        compute_char_positions_walk(text, style, &char_px_raw, &inline_tab_x)
    }
}

// ── 플랫폼별 기본 측정기 선택 ───────────────────────────────────────

#[cfg(target_arch = "wasm32")]
fn default_measurer() -> WasmTextMeasurer {
    WasmTextMeasurer
}

#[cfg(not(target_arch = "wasm32"))]
fn default_measurer() -> EmbeddedTextMeasurer {
    EmbeddedTextMeasurer
}

// ── 스타일 변환 ─────────────────────────────────────────────────────

pub(crate) fn resolved_to_text_style(
    styles: &ResolvedStyleSet,
    char_style_id: u32,
    lang_index: usize,
) -> TextStyle {
    if let Some(cs) = styles.char_styles.get(char_style_id as usize) {
        let mut style = TextStyle {
            font_metrics_policy: cs.font_metrics_policy,
            latin_space: (cs.latin_font_space && lang_index == 1) || cs.use_font_space,
            script_base_size: 0.0,
            font_family: cs.font_family_for_lang(lang_index).to_string(),
            font_subst: cs.font_subst_for_lang(lang_index).to_string(),
            hft_family: cs.hft_family_for_lang(lang_index).to_string(),
            char_offset: cs.char_offset_for_lang(lang_index),
            font_size: cs.font_size_for_lang(lang_index),
            color: cs.text_color,
            bold: cs.bold,
            italic: cs.italic,
            underline: cs.underline,
            strikethrough: cs.strikethrough,
            letter_spacing: cs.letter_spacing_for_lang(lang_index),
            ratio: cs.ratio_for_lang(lang_index),
            kerning: cs.kerning,
            default_tab_width: 0.0,
            tab_stops: Vec::new(),
            auto_tab_right: false,
            available_width: 0.0,
            line_x_offset: 0.0,
            text_start_offset: 0.0,
            right_tab_block_width_override: None,
            tab_leaders: Vec::new(),
            inline_tabs: Vec::new(),
            extra_word_spacing: 0.0,
            extra_char_spacing: 0.0,
            native_negative_spacing: false,
            extra_dash_advance: 0.0,
            outline_type: cs.outline_type,
            shadow_type: cs.shadow_type,
            shadow_color: cs.shadow_color,
            shadow_offset_x: cs.font_size * cs.shadow_offset_x as f64 / 100.0,
            shadow_offset_y: cs.font_size * cs.shadow_offset_y as f64 / 100.0,
            emboss: cs.emboss,
            engrave: cs.engrave,
            superscript: cs.superscript,
            subscript: cs.subscript,
            emphasis_dot: cs.emphasis_dot,
            underline_shape: cs.underline_shape,
            strike_shape: cs.strike_shape,
            underline_color: cs.underline_color,
            strike_color: cs.strike_color,
            shade_color: cs.shade_color,
        };
        style.letter_spacing += hft_substitute_bold_tracking_px(&style);
        style
    } else {
        TextStyle::default()
    }
}

/// 한컴(macOS)이 HFT 서체 굵게를 합성할 때 빈칸이 아닌 글자마다 더하는 advance
/// (장평 적용 전 글자 크기 비율). 한컴 PDF 실측: 신명 신그래픽 20pt 장평 100% 에서
/// 글자당 1.00pt, exam-social 표제(40pt, 장평 90%) 1.79pt = 0.05 × 40 × 0.9.
/// 빈칸은 벌어지지 않는다.
pub(crate) const HFT_BOLD_ADVANCE_EM: f64 = 0.05;

/// 원본이 HFT 인데 측정은 대체 서체 이름으로 하는 굵은 run 의 자간 보정(px).
///
/// 한컴은 언제나 자기 HFT 로 그리므로 굵게 합성 advance 를 더한다. 대체 서체
/// (신명 신그래픽 → 굴림 등)가 번들 face 라 `synthetic_bold_tracking_px` 가 보정을
/// 생략하던 경우를 HFT 기준 값으로 채운다. 이미 더해지는 만큼은 빼서 중복을 막는다.
fn hft_substitute_bold_tracking_px(style: &TextStyle) -> f64 {
    let hft = style.hft_family.trim();
    // HFT 폭 테이블로 재는 run 은 글자별 측정(`hft_bold_tracking_px`)이 맡는다.
    if !style.bold
        || hft.is_empty()
        || hft_width_swap(style)
        || style.font_metrics_policy == FontMetricsPolicy::HancomWindows
    {
        return 0.0;
    }
    let primary = style.font_family.split(',').next().unwrap_or("").trim();
    if primary.is_empty() || primary == hft {
        return 0.0;
    }
    #[cfg(not(target_arch = "wasm32"))]
    if !crate::renderer::font_paths::custom_faces_loaded() {
        return 0.0;
    }
    let ratio = if style.ratio > 0.0 { style.ratio } else { 1.0 };
    let target = style.font_size
        * ratio
        * crate::renderer::hft_synthetic_bold_advance_em(hft).unwrap_or(HFT_BOLD_ADVANCE_EM);
    let existing = synthetic_bold_tracking_px(
        &style.font_family,
        true,
        style.italic,
        style.font_size,
        style.font_metrics_policy,
    );
    (target - existing).max(0.0)
}

/// Use Hancom's sans fallback only when the selected face cannot draw any
/// visible glyph in this run and the fallback covers all of them. Keeping the
/// decision at run granularity lets layout and painting use the same face.
pub(crate) fn apply_covered_hancom_fallback(style: &mut TextStyle, text: &str) {
    if style.font_metrics_policy == FontMetricsPolicy::HcrDeclared {
        // HFT 윤곽선과 문서 대체 서체는 자체 경로에서 해석한다. 여기서는
        // 원본 서체에 없는 글자로만 이루어진 일반 run의 실제 fallback을 고정한다.
        if !style.hft_family.is_empty() {
            return;
        }
        let primary = super::super::style_resolver::primary_font_name(&style.font_family);
        let mut visible = false;
        for ch in text
            .chars()
            .filter(|ch| !ch.is_whitespace() && !ch.is_control())
        {
            visible = true;
            if hancom_missing_glyph_em(primary, style.bold, style.italic, ch).is_none() {
                return;
            }
        }
        if visible {
            style.font_family = "함초롬돋움".into();
            style.font_subst.clear();
        }
        return;
    }
    if style.font_metrics_policy != FontMetricsPolicy::HancomWindows {
        return;
    }
    let requested_name = style.font_family.split(',').next().unwrap_or("").trim();
    const FALLBACK: &str = "함초롬돋움";
    if requested_name.is_empty() || requested_name == FALLBACK {
        return;
    }
    if !crate::renderer::generic_fallback(requested_name).ends_with("sans-serif") {
        return;
    }
    let (Some(requested), Some(fallback)) = (
        font_metrics_data::find_metric(requested_name, style.bold, style.italic),
        font_metrics_data::find_metric(FALLBACK, style.bold, style.italic),
    ) else {
        return;
    };
    let mut visible = false;
    for ch in text
        .chars()
        .filter(|ch| !ch.is_whitespace() && !ch.is_control())
    {
        visible = true;
        if !metric_has_source_range(requested.metric, ch)
            || requested.metric.get_width(ch).is_some()
            || fallback.metric.get_width(ch).is_none()
        {
            return;
        }
    }
    if visible {
        style.font_family = FALLBACK.to_string();
        // 선언 대체 글꼴은 원본 face 소유 — font_family 교체 시 함께 지운다.
        style.font_subst.clear();
        style.hft_family.clear();
    }
}

/// 원본 서체에 없는 글자를 그릴 함초롬돋움의 실제 진행폭. 내장 폭 표가 생략한
/// Unicode 범위도 설치/등록된 cmap으로 확인한다 (맑은 고딕 ➎ → HCRDotum 0.97em).
fn hancom_missing_glyph_em(primary: &str, bold: bool, italic: bool, ch: char) -> Option<f64> {
    let requested = font_metrics_data::find_metric(primary, bold, italic);
    if requested.is_none()
        && !custom_font_face_available(primary)
        && !crate::renderer::runtime_font_metrics::face_available(primary)
    {
        return None;
    }
    if requested
        .as_ref()
        .is_some_and(|m| m.metric.get_width(ch).is_some())
        || custom_face_char_em_advance(primary, bold, italic, ch).is_some()
        || crate::renderer::runtime_font_metrics::char_em_advance(primary, bold, italic, ch)
            .is_some()
        || crate::renderer::composer::pua_plain_text_display(ch).is_some()
    {
        return None;
    }
    const FALLBACK: &str = "함초롬돋움";
    custom_face_char_em_advance(FALLBACK, bold, italic, ch)
        .or_else(|| {
            crate::renderer::runtime_font_metrics::char_em_advance(FALLBACK, bold, italic, ch)
        })
        .or_else(|| {
            let metric = font_metrics_data::find_metric(FALLBACK, bold, italic)?.metric;
            Some(f64::from(metric.get_width(ch)?) / f64::from(metric.em_size))
        })
}

fn metric_has_source_range(metric: &font_metrics_data::FontMetric, ch: char) -> bool {
    let code = ch as u32;
    if (0xAC00..=0xD7A3).contains(&code) {
        return metric.hangul.is_some();
    }
    metric
        .latin_ranges
        .iter()
        .any(|range| (range.start..=range.end).contains(&code))
}

// ── 내장 폰트 메트릭 측정 ───────────────────────────────────────────

/// 폰트가 고정폭(monospace)인지 판정한다.
///
/// Basic Latin (U+0021~U+007E) 의 0 이 아닌 글자폭이 모두 동일하면 monospace.
/// 돋움체/바탕체/굴림체 등 한컴 고정폭 폰트는 `·` 를 포함한 모든 글리프가
/// em_size 폭을 가지므로, U+00B7 의 `.notdef` 위장값 가드에서 이들을 제외해
/// 전각 측정을 보존하기 위함이다 (Issue #630, aift 목차 right-tab 정합).
fn is_monospace_metric(metric: &font_metrics_data::FontMetric) -> bool {
    let mut common: Option<u16> = None;
    let mut count = 0u32;
    for range in metric.latin_ranges {
        if range.start > 0x007E || range.end < 0x0021 {
            continue;
        }
        for (i, &w) in range.widths.iter().enumerate() {
            let code = range.start + i as u32;
            if !(0x0021..=0x007E).contains(&code) || w == 0 {
                continue;
            }
            count += 1;
            match common {
                None => common = Some(w),
                Some(cw) if cw != w => return false,
                _ => {}
            }
        }
    }
    // 표본이 충분할 때만 monospace 로 판정 (Latin 글리프가 거의 없는 폰트 오판 방지).
    count >= 16
}

/// 요청 폰트의 내장 메트릭 DB 등록 여부.
///
/// `compute_char_positions` 의 advance 가 실제 글리프 폭(메트릭 DB)에서
/// 나온 값인지, 아니면 DB 미등록 폰트의 휴리스틱 폴백(`font_size * 0.5`
/// 등)인지 구분하는 데 쓴다. WASM 캔버스 렌더러는 메트릭이 없는(=브라우저
/// 대체 폰트로 치환되는) 폰트에 대해 글리프별 가로 스케일링(per-glyph
/// x-scale)을 적용하면 안 된다 — 치환 폰트의 실제 advance 와 어긋나
/// l/i/t 같은 좁은 글리프가 과도하게 늘어나기 때문이다 (한컴 바겐세일 M
/// → Pretendard 치환 시 Vocabulary 열 왜곡).
pub(crate) fn font_family_has_metrics(font_family: &str, bold: bool, italic: bool) -> bool {
    let primary_name = font_family.split(',').next().unwrap_or(font_family).trim();
    font_metrics_data::find_metric(primary_name, bold, italic).is_some()
        || crate::renderer::hancom_unresolved_face(primary_name)
}

/// 내장 폰트 메트릭으로 문자 폭 측정 (em 단위 → px 변환)
///
/// 내장 메트릭이 있으면 JS 브릿지 호출 없이 즉시 반환.
/// 없으면 None을 반환하여 폴백 경로를 사용하게 한다.
fn quantize_hwp_px(px: f64) -> f64 {
    let hwp = (px * 75.0) as i32;
    hwp as f64 / 75.0
}

/// `raw` 측정(macOS 배치 단위 모델의 입력)은 em × 크기를 그대로 둔다.
/// 그 밖의 소비자는 기존 HWPUNIT 절삭 폭을 받는다.
#[inline]
fn quantize_unless_raw(px: f64, raw: bool) -> f64 {
    if raw {
        px
    } else {
        quantize_hwp_px(px)
    }
}

/// KoPub 서체 판정 (돋움, 바탕). 글자마다 불리므로 서체명별로 캐시한다.
fn kopub_face_kind(primary_name: &str) -> (bool, bool) {
    thread_local! {
        static KOPUB_KIND_CACHE: std::cell::RefCell<std::collections::HashMap<String, (bool, bool)>> =
            std::cell::RefCell::new(std::collections::HashMap::new());
    }
    KOPUB_KIND_CACHE.with(|cache| {
        if let Some(kind) = cache.borrow().get(primary_name) {
            return *kind;
        }
        let lower = primary_name.to_lowercase();
        let kind = (
            primary_name.contains("KoPub돋움체") || lower.contains("kopub dotum"),
            primary_name.contains("KoPub바탕체") || lower.contains("kopub batang"),
        );
        cache.borrow_mut().insert(primary_name.to_string(), kind);
        kind
    })
}

fn kopub_char_width(primary_name: &str, c: char, font_size: f64) -> Option<f64> {
    let (is_dotum, is_batang) = kopub_face_kind(primary_name);
    if !is_dotum && !is_batang {
        return None;
    }

    if c == ' ' {
        return Some(font_size * 0.5);
    }
    if is_narrow_punctuation(c) {
        return Some(font_size * 0.3);
    }
    // [#2239] 괄호 — KoPub 경로는 86712 한컴 PDF 글리프 직독 실측(13px 문서
    // 괄호 4px ≈ 0.3em, #2195 stage23)으로 narrow 유지. is_narrow_punctuation
    // 의 괄호가 폰트 한정(is_narrow_paren_for_font)으로 빠지면서 여기서 보존.
    if matches!(c, '(' | ')') {
        return Some(font_size * 0.3);
    }
    if c.is_ascii() {
        return Some(font_size * 0.5);
    }
    if is_cjk_char(c) || is_fullwidth_symbol(c) {
        // [#2195 stage57] KoPub 미설치 환경에서 한글은 바탕으로 치환해 **전각
        // 1.0em** 렌더 — 86712 한컴 PDF 글리프 직독(Haansoft Batang, 12pt 한글
        // 16px) 실측. 종전 0.84 는 r27 근거설명 25문단을 -11줄 과소(래핑 조기
        // 종료)시키던 성분.
        let factor = if is_dotum { 1.0 } else { 0.94 };
        return Some(font_size * factor);
    }

    None
}

/// [#2156] Haansoft Batang(한컴바탕, HBATANG.TTF upm=1024) ASCII advance/em.
/// 한글은 함초롬바탕(HCR Batang) 문서의 비한글 문자(라틴·숫자·구두점·U+00B7)를
/// HCR hmtx 가 아닌 이 메트릭으로 렌더한다 — 문자폭 사다리 통제 프로브로
/// 전 판별 클래스 확정 (괄호 0.32→0.50em 등).
/// 공백(0x20)은 useFontSpace=0 고정 0.5em 경로(기존 em/2) 유지를 위해 제외.
/// Windows 한글 전용 치환이다. 기준 플랫폼인 macOS 한글은 HCR Batang 자체
/// hmtx 로 조판하므로 `FontMetricsPolicy::HancomWindows` 에서만 적용한다.
const HAANSOFT_BATANG_ASCII: [f64; 95] = [
    0.3330, 0.4160, 0.4160, 0.8330, 0.6250, 0.9160, 0.8330, 0.2500, // ` !"#$%&'`
    0.5000, 0.5000, 0.5000, 0.8330, 0.2910, 0.8330, 0.2910, 0.3330, // `()*+,-./`
    0.5830, 0.5830, 0.5830, 0.5830, 0.5830, 0.5830, 0.5830, 0.5830, // `01234567`
    0.5830, 0.5830, 0.3330, 0.3330, 0.8330, 0.8330, 0.8330, 0.5000, // `89:;<=>?`
    1.0000, 0.7500, 0.6660, 0.6660, 0.7080, 0.6660, 0.6250, 0.7080, // `@ABCDEFG`
    0.7500, 0.3750, 0.4580, 0.7500, 0.6250, 0.9160, 0.7500, 0.7080, // `HIJKLMNO`
    0.6250, 0.7080, 0.6660, 0.6250, 0.7500, 0.7500, 0.7080, 0.9580, // `PQRSTUVW`
    0.6660, 0.6660, 0.6250, 0.5000, 0.3330, 0.5000, 1.0000, 0.5000, // `XYZ[\]^_`
    0.5830, 0.5000, 0.5410, 0.5000, 0.5410, 0.5410, 0.3750, 0.5410, // '`abcdefg'
    0.5410, 0.2910, 0.2910, 0.5410, 0.2910, 0.8330, 0.5410, 0.5410, // `hijklmno`
    0.5410, 0.5410, 0.4160, 0.5000, 0.3750, 0.5410, 0.5410, 0.7910, // `pqrstuvw`
    0.5830, 0.5830, 0.4580, 0.5830, 0.5830, 0.5830, 0.7910, // `xyz{|}~`
];

/// [#2156] 검증된 함초롬바탕 별칭의 비한글 문자 폭 오버라이드 (advance/em 비율).
fn haansoft_latin_override(primary_name: &str, c: char) -> Option<f64> {
    // 함초롬돋움/HCR Dotum은 Haansoft Dotum 등 별도 대체 가능성이 남아 있다.
    // 바탕 문자폭 사다리로 검증된 정확한 별칭만 이 테이블을 사용한다.
    if !matches!(primary_name, "함초롬바탕" | "HCR Batang") {
        return None;
    }
    if c == '\u{00B7}' {
        return Some(0.3330);
    }
    let cp = c as u32;
    if (0x21..0x7F).contains(&cp) {
        return Some(HAANSOFT_BATANG_ASCII[(cp - 0x20) as usize]);
    }
    None
}

/// [#2070] ㆍ(U+318D) 폭. 한컴은 이 글자를 해당 글꼴 자체의 advance 로 그린다.
/// - 한양신명조 = 전각 (사다리 v3 실측).
/// - HY 계열 반각 강제는 **HancomWindows 정책 한정** 이다: Windows 한컴은 HFT
///   원본(명조 등)의 반각 글리프로 그렸다 (80168 개정안 '시ㆍ도조례' 오라클).
///   macOS 한컴은 대체 TTF 자체(HYmjrE·HYgtrE 모두 ㆍ=1.0em)로 그린다 —
///   28-agritech-review 제목 실측. HcrDeclared(mac)에서는 HY 에도 embedded
///   메트릭(전각)을 신뢰한다.
/// - 그 밖에 메트릭 DB 가 이 글자를 수록한 글꼴(함초롬·한컴 번들, 맑은 고딕 등 시스템
///   TTF)은 embedded 메트릭을 신뢰한다 (None 반환). 86712 법령 인용 셀의 맑은 고딕
///   ㆍ = 1.0em (한컴 PDF 실측) — 종전 반각 폭으로 줄이 덜 접혀 쪽 경계가 한 줄씩 밀렸다.
/// - 메트릭이 없는 글꼴은 종전대로 반각.
pub(crate) fn area_dot_fallback_width(
    font_family: &str,
    font_size: f64,
    policy: FontMetricsPolicy,
) -> Option<f64> {
    let fam = font_family.split(',').next().unwrap_or("").trim();
    if fam.contains("한양신명조") {
        return Some(font_size);
    }
    if policy == FontMetricsPolicy::HancomWindows && fam.starts_with("HY") {
        return Some(font_size * 0.5);
    }
    if measure_char_width_embedded(fam, false, false, '\u{318D}', font_size).is_some() {
        return None;
    }
    Some(font_size * 0.5)
}

fn measure_char_width_embedded(
    font_family: &str,
    bold: bool,
    italic: bool,
    c: char,
    font_size: f64,
) -> Option<f64> {
    measure_char_width_with_policy(
        font_family,
        bold,
        italic,
        c,
        font_size,
        FontMetricsPolicy::default(),
    )
}

pub(super) fn measure_known_font_run_width(
    font_family: &str,
    bold: bool,
    italic: bool,
    text: &str,
    font_size: f64,
) -> Option<f64> {
    // 수식은 자체 서체 체인을 순서대로 탐색한다. 없는 수식 face 를 본문
    // 기본 서체로 치환하면 이후 Times/Math 후보의 폭을 가로채게 된다.
    if crate::renderer::hancom_unresolved_face(font_family) {
        return None;
    }
    let shaped_style = TextStyle {
        font_family: font_family.to_string(),
        font_size,
        bold,
        italic,
        kerning: true,
        ..Default::default()
    };
    if let Some(positions) = shaped_char_positions(text, &shaped_style) {
        return positions.last().copied();
    }
    text.chars().try_fold(0.0, |width, ch| {
        measure_char_width_embedded(font_family, bold, italic, ch, font_size)
            .map(|advance| width + advance)
    })
}

/// [macOS 정합] 한컴 PUA 점선 문자(U+F081C)의 진행 폭 (em). 한컴(macOS)은 이 글자를
/// 함초롬바탕 글리프(485/1000em, 함초롬돋움도 같다)로 그리고 그 폭으로 줄을 나눈다 —
/// readmission(복학원서) 접수증 점선: 줄 정보 없는 한컴 조판에서 99개가 한 줄을 채우고
/// 뒤 인라인 표는 다음 줄로 넘어간다 (0폭이면 점선과 표가 한 줄에 겹친다).
#[inline]
fn hancom_cut_line_em() -> f64 {
    0.485
}

/// 한컴 반각/전각 보정을 적용한 글리프 폭 (폰트 단위).
///
/// 내장 메트릭과 런타임 폰트 메트릭이 같은 보정을 거쳐야 하위 경로(양자화,
/// 줄바꿈)에서 동일하게 동작한다. `is_monospace` 는 따옴표/가운뎃점에서만
/// 평가된다.
/// 함초롬 PUA 폭 테이블이 폭 0 으로 선언한 문자 — 한컴이 잉크 없는 빈 글리프
/// 마커로 취급한다 (예: U+F03FF — 공식 PDF 에서 advance 만 차지하고 흔적 없음).
/// 렌더러는 tofu 대신 이 판별로 잉크를 생략한다.
pub(crate) fn is_hancom_blank_pua_marker(c: char) -> bool {
    let cp = c as u32;
    if !(0xF0000..=0xF08FF).contains(&cp) {
        return false;
    }
    font_metrics_data::find_metric("함초롬돋움", false, false)
        .is_some_and(|m| metric_has_source_range(m.metric, c) && m.metric.get_width(c).is_none())
}

/// 한컴(macOS)이 HFT 서체 run 의 한컴 PUA 문자(옛한글·책괄호 등)를 그리는 서체.
///
/// HFT 은행에는 PUA 글리프가 없다. 한컴은 이 글자를 run 의 대체 TTF(HY신명조 등)나
/// 함초롬돋움이 아니라 함초롬바탕 글리프·advance 로 그린다 (exam-kor p17: 신명 중명조
/// run 의 U+F0854 `『` 0.485em, 옛한글 U+E38A 0.97em 이 모두 HCRBatang 으로 임베드되고,
/// 기호 슬롯 글꼴을 바꿔도 그대로다). 그 밖의 run 은 일반 누락 글리프 규칙대로
/// 함초롬돋움이 받는다 (skia `HANCOM_MISSING_GLYPH_FAMILIES`).
pub(crate) const HFT_MISSING_PUA_FAMILIES: &[&str] = &["HCR Batang", "함초롬바탕"];
const MISSING_PUA_FAMILIES: &[&str] = &["HCR Dotum", "함초롬돋움", "HCR Batang", "함초롬바탕"];

/// 표시 문자열로 확장하지 않고 한컴 PUA 글리프로 그릴 문자인지 판별한다. 표시 문자열로
/// 확장되는 의미 마커·TAC 채움 문자·빈 마커는 기존 규칙을 따른다.
fn is_hancom_glyph_pua(c: char) -> bool {
    matches!(c as u32, 0xE000..=0xF8FF | 0xF0000..=0xFFFFD)
        && c != '\u{F081C}'
        && crate::renderer::composer::pua_plain_text_display(c).is_none()
        && !is_hancom_blank_pua_marker(c)
}

/// 함초롬 계열 실폰트가 PUA 옛한글 글리프를 갖고 있는지. 있으면 한컴처럼 PUA 코드를
/// 그대로 그리고(자모 분해 없음), 없으면 KS X 1026 자모 시퀀스로 확장한다.
pub(crate) fn hancom_pua_face_has_glyph(c: char) -> bool {
    MISSING_PUA_FAMILIES
        .iter()
        .any(|family| custom_face_char_em_advance(family, false, false, c).is_some())
}

/// HFT run 에서 함초롬바탕이 그릴 한컴 PUA 문자인지 (paint 경로 공용).
pub(crate) fn is_hft_missing_pua(style: &TextStyle, c: char) -> bool {
    !style.hft_family.trim().is_empty()
        && style.font_metrics_policy == FontMetricsPolicy::HcrDeclared
        && is_hancom_glyph_pua(c)
}

/// 요청 서체에 없는 한컴 PUA 문자 폭 (em). HFT run 은 함초롬바탕, 그 밖은 함초롬돋움
/// 실폰트 → 내장 메트릭 순으로 찾는다. 요청 서체가 글리프를 가지면 None (기존 경로).
pub(crate) fn hft_missing_pua_em(style: &TextStyle, c: char) -> Option<f64> {
    if style.font_metrics_policy != FontMetricsPolicy::HcrDeclared || !is_hancom_glyph_pua(c) {
        return None;
    }
    let (bold, italic) = (style.bold, style.italic);
    let families = if style.hft_family.trim().is_empty() {
        let primary = style.font_family.split(',').next().unwrap_or("").trim();
        let primary_covers = custom_face_char_em_advance(primary, bold, italic, c).is_some()
            || font_metrics_data::find_metric(primary, bold, italic)
                .is_some_and(|m| m.metric.get_width(c).is_some());
        // 내장 메트릭 PUA 범위(F0000~)는 기존 측정 경로가 이미 함초롬 폭을 쓴다.
        if primary_covers || !(0xE000..=0xF8FF).contains(&(c as u32)) {
            return None;
        }
        MISSING_PUA_FAMILIES
    } else {
        HFT_MISSING_PUA_FAMILIES
    };
    families
        .iter()
        .find_map(|family| custom_face_char_em_advance(family, bold, italic, c))
        .or_else(|| {
            let name = if families == HFT_MISSING_PUA_FAMILIES {
                "HCR Batang"
            } else {
                "HCR Dotum"
            };
            let m = font_metrics_data::find_metric(name, bold, italic)?;
            Some(f64::from(m.metric.get_width(c)?) / f64::from(m.metric.em_size))
        })
}

/// HFT run 의 KS X 1001 일반 구두점(… ‥ · ― 등)은 HFT 기호 은행의 전각 글리프로
/// 그려진다 — advance 1em (exam-kor p5 `생성․변경`: 신명 중명조 U+2024 가 글자 칸 가운데
/// 점, p8 `당신……,`: 말줄임표 하나가 한글 한 칸). 대체 TTF(HY신명조)의 좁은 폭이 아니다.
/// 따옴표(‘ ’ “ ”)·`·` 는 영문 슬롯 글꼴 폭을 따르므로 제외한다. U+2024 는 한자 슬롯
/// (`detect_lang_category` = 2, k-water-rfp 실측)으로 가지만 한자 슬롯 HFT 도 같은 전각
/// 글리프를 그리므로 한글·한자 슬롯 모두 받는다.
fn hft_ks_punct_em(style: &TextStyle, c: char) -> Option<f64> {
    if style.hft_family.trim().is_empty()
        || style.font_metrics_policy != FontMetricsPolicy::HcrDeclared
        || !matches!(c as u32, 0x2010..=0x2017 | 0x2020..=0x206F)
        || !matches!(
            crate::renderer::style_resolver::detect_lang_category(c),
            0 | 2
        )
    {
        return None;
    }
    // 한컴은 U+2024(한 점 지시자)를 KS 가운뎃점(0xA1A4) 글리프로 그린다.
    let ks = if c == '\u{2024}' { '\u{00B7}' } else { c };
    let mut buf = [0u8; 4];
    let (bytes, _, had_errors) = encoding_rs::EUC_KR.encode(ks.encode_utf8(&mut buf));
    (!had_errors && bytes.len() == 2 && bytes[0] == 0xA1).then_some(1.0)
}

/// [macOS 정합] 말줄임표(U+2026)는 글꼴 hmtx 가 전각이면 전각으로 조판한다 —
/// 합성 스윕 G_fonts 의 굴림·HY견명조·궁서 '…' 10pt = 10.0pt (반각 강제 시 5pt 짧음).
/// 함초롬 계열처럼 hmtx 가 전각 미만인 글꼴은 원래 hmtx 그대로라 영향이 없다.
#[inline]
fn mac_keeps_fullwidth_punct(c: char, policy: FontMetricsPolicy) -> bool {
    c == '\u{2026}' && policy == FontMetricsPolicy::HcrDeclared
}

fn hancom_glyph_units(
    c: char,
    glyph_w: u16,
    em_size: u16,
    policy: FontMetricsPolicy,
    is_monospace: impl Fn() -> bool,
) -> u16 {
    // 한컴은 스마트 따옴표 등을 반각으로 처리.
    // 폰트 메트릭에서 전각(em_size)으로 기록되어 있어도 em/2로 강제.
    // [Issue #630] U+00B7 (가운뎃점) 은 본 분기에서 제외 — 한컴 저장본의
    // tab_extended 가 전각 측정 기반으로 산출되므로 반각 강제 시 right-tab
    // 정렬이 8.67px 좌측 이탈. 폰트 메트릭 그대로 사용 (전각).
    // [macOS 정합] 「」(U+300C/300D): 한컴(macOS)은 선언 face 의 기록
    // 전각 폭 그대로 조판한다 — 공식 PDF 실측 「→다음 글자 0.82–1.00em
    // (35-voucher '「곡성군' 10.6pt@11.04pt, 38-cheongyang '「전자정부법」'
    // 「=」=9.0pt@9.0pt, 36-apartment-form 「 셀, issue_2020 passport 기대
    // 렌더의 「/」 등폭 칸). 반각 강제는 HancomWindows 규약으로만 남긴다.
    let is_halfwidth_punct = (matches!(
        c,
        '\u{2018}'..='\u{2027}' // ''‚‛""„‟†‡•‣․‥…‧ 구두점/기호
    ) && !mac_keeps_fullwidth_punct(c, policy))
        || (is_halfwidth_cjk_quote(c) && policy == FontMetricsPolicy::HancomWindows);
    // 휴먼명조/HY중고딕/HY신명조/HY견명조 등 일부 폰트 DB 가 U+2018/U+2019/
    // U+2027 을 fullwidth (1.0 em) 로 잘못 기록한 케이스 정정. em/2 (0.5 em)
    // 강제 시 한컴 대비 약 4px (font-size 20px 기준, 0.5→0.3 em 차) 과대.
    // glyph_w 가 비정상 fullwidth (>= em_size) 일 때만 0.3 em 강제 — 함초롬
    // 바탕 (0.32) / Pretendard (0.22) 등 정상 DB 값은 조건 미충족으로 영향 없음.
    let quote_width_is_authentic = matches!(c, '\u{2018}' | '\u{2019}') && is_monospace();
    let is_narrow_unicode_punct =
        matches!(c, '\u{2018}' | '\u{2019}' | '\u{2027}') && !quote_width_is_authentic;
    // [U+00B7 .notdef 위장값 정정] 비례폰트(휴먼명조 등)가 `·` (가운뎃점)
    // 글리프를 갖지 않으면 cmap 이 .notdef(glyph 0) 로 매핑돼 advance 가
    // em_size(전각) 로 기록된다. 한컴은 이 경우 점 글리프를 가진 대체
    // 폰트(바탕 ≈0.33em 등)로 `·` 를 렌더하므로 전각 advance 는 PDF 대비
    // 과대 (시·군 점 좌우 공백 큼). 비례폰트에서 U+00B7 이 전각이면 위장값
    // 으로 보고 0.3em 으로 정정한다. 고정폭(monospace) 폰트(돋움체 등)는
    // 모든 글리프가 em_size 이므로 제외 — 해당 `·` 는 진짜 전각이다
    // (Issue #630, aift 목차 right-tab 정합 보존).
    let is_b7_notdef_artifact = c == '\u{00B7}' && glyph_w >= em_size && !is_monospace();
    if (is_narrow_unicode_punct && glyph_w >= em_size) || is_b7_notdef_artifact {
        (em_size as f64 * 0.3) as u16
    } else if is_halfwidth_punct && !quote_width_is_authentic && glyph_w >= em_size {
        // 「」도 위 판정에서 반각으로 좁힐 때만 여기 도달한다 (HancomWindows
        // 규약). macOS(HcrDeclared)는 전각 기록 폭 그대로다.
        em_size / 2
    } else {
        glyph_w
    }
}

/// 런타임 폰트 메트릭(사용자 설치 폰트)으로 문자 폭 측정.
/// 내장 메트릭과 같은 반각 보정 + HWPUNIT 절삭을 적용한다.
fn measure_char_width_runtime(
    primary_name: &str,
    bold: bool,
    italic: bool,
    c: char,
    font_size: f64,
    policy: FontMetricsPolicy,
    raw: bool,
) -> Option<f64> {
    let advance =
        crate::renderer::runtime_font_metrics::char_advance(primary_name, bold, italic, c)?;
    let w = if c == ' ' {
        advance.units
    } else {
        hancom_glyph_units(c, advance.units, advance.em_size, policy, || {
            advance.monospace
        })
    };
    Some(quantize_unless_raw(
        w as f64 * font_size / advance.em_size as f64,
        raw,
    ))
}

pub(crate) fn active_shaping_face_available(name: &str) -> bool {
    ACTIVE_SHAPING_FONTS.with(|active| {
        active
            .borrow()
            .iter()
            .any(|font| font.family.eq_ignore_ascii_case(name))
    })
}

fn embedded_face_char_em_advance(name: &str, bold: bool, italic: bool, c: char) -> Option<f64> {
    ACTIVE_SHAPING_FONTS.with(|active| {
        let active = active.borrow();
        let font = active
            .iter()
            .filter(|font| font.family.eq_ignore_ascii_case(name))
            .min_by_key(|font| {
                let Ok(face) = ttf_parser::Face::parse(&font.bytes, font.face_index) else {
                    return u16::MAX;
                };
                face.weight()
                    .to_number()
                    .abs_diff(if bold { 700 } else { 400 })
                    + 1000 * u16::from(face.is_italic() != italic)
            })?;
        let face = ttf_parser::Face::parse(&font.bytes, font.face_index).ok()?;
        let glyph = face.glyph_index(c)?;
        let advance = face.glyph_hor_advance(glyph)?;
        (face.units_per_em() > 0).then(|| f64::from(advance) / f64::from(face.units_per_em()))
    })
}

fn custom_font_face_available(name: &str) -> bool {
    if active_shaping_face_available(name)
        || crate::renderer::runtime_font_metrics::face_available(name)
    {
        return true;
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        crate::renderer::font_paths::custom_font_face_available(name)
    }
    #[cfg(target_arch = "wasm32")]
    {
        browser_font_family_available(name).unwrap_or(false)
    }
}

fn custom_face_char_em_advance(name: &str, bold: bool, italic: bool, c: char) -> Option<f64> {
    embedded_face_char_em_advance(name, bold, italic, c)
        .or_else(|| crate::renderer::runtime_font_metrics::char_em_advance(name, bold, italic, c))
        .or_else(|| {
            #[cfg(not(target_arch = "wasm32"))]
            {
                crate::renderer::font_paths::custom_face_char_em_advance(name, bold, italic, c)
            }
            #[cfg(target_arch = "wasm32")]
            None
        })
}

/// macOS 한컴은 라틴 문맥에서 폰트의 공백 advance를 사용한다.
/// 한글 문맥과 묶음 빈칸은 기존 반각 계약을 유지한다.
fn latin_space_width(style: &TextStyle, c: char, font_size: f64) -> Option<f64> {
    // [macOS 정합] 첨자 run 의 빈칸은 글리프와 달리 줄이지 않는다 — mel-001 p17
    // `[피할권리]<첨자 빈칸>노동자`(15pt, 첨자 9.6pt): 빈칸 7.44pt = 15pt 의 em/2.
    if c == ' '
        && style.script_base_size > 0.0
        && style.font_metrics_policy == FontMetricsPolicy::HcrDeclared
    {
        return Some(style.script_base_size / 2.0);
    }
    // 기호 슬롯 글꼴이 HFT(한양 계열)이면 한컴은 CJK 괄호를 HFT 원형 전각 글리프로
    // 그린다 — 대체 TTF 의 반각 괄호 폭이 아니다 (k-water-rfp 4쪽 한양신명조 `「…」`:
    // 1.0em, 11-table-in-tbox 같은 실측). 대체 서체 이름으로는 구분되지 않아
    // 원본 HFT 이름(`hft_family`)으로 판정한다.
    if matches!(c, '\u{3008}'..='\u{3011}' | '\u{3014}'..='\u{301B}')
        && !style.hft_family.trim().is_empty()
    {
        let mac = style.font_metrics_policy == FontMetricsPolicy::HcrDeclared;
        return Some(quantize_unless_raw(font_size, mac));
    }
    if c != ' ' || !style.latin_space || style.font_metrics_policy != FontMetricsPolicy::HcrDeclared
    {
        return None;
    }
    let family = style.font_family.split(',').next()?.trim();
    // 한컴이 기본 글꼴로 대체하는 face 는 그 글꼴의 빈칸 폭을 쓴다.
    let family = if crate::renderer::hancom_unresolved_face(family) {
        crate::renderer::HANCOM_DEFAULT_FACES[0]
    } else {
        family
    };
    let em = custom_face_char_em_advance(family, style.bold, style.italic, ' ').or_else(|| {
        let metric = font_metrics_data::find_metric(family, style.bold, style.italic)?.metric;
        Some(f64::from(metric.get_width(' ')?) / f64::from(metric.em_size))
    })?;
    // macOS 전용 경로 — 배치 단위 모델(`mac_glyph_advance_px`)이 양자화한다.
    Some(em * font_size)
}

/// Haansoft Batang 의 Wingdings PUA(U+F020..=U+F0FF) advance (1/1024em, hmtx 실측).
/// 글꼴 파일이 없는 환경(wasm 등)에서도 한컴 조판 폭을 재현하기 위한 표.
const HAANSOFT_BATANG_WINGDINGS_ADVANCE: [u16; 224] = [
    512, 1055, 1172, 1332, 1376, 916, 1246, 469, 1110, 913, 1159, 1159, 1199, 1199, 1475, 1478,
    1122, 1376, 716, 716, 913, 567, 616, 1097, 971, 1104, 962, 912, 913, 913, 912, 932, 932, 601,
    812, 690, 690, 964, 964, 562, 562, 913, 864, 864, 864, 1137, 676, 870, 1115, 910, 901, 666,
    833, 765, 765, 741, 710, 813, 906, 913, 917, 912, 1184, 1079, 987, 1116, 963, 956, 969, 1050,
    951, 1122, 1091, 799, 1075, 1301, 765, 976, 765, 912, 912, 912, 912, 469, 765, 1009, 912, 592,
    1085, 1085, 912, 913, 913, 543, 543, 512, 913, 913, 913, 913, 913, 913, 913, 913, 913, 913,
    913, 913, 913, 913, 913, 913, 913, 913, 913, 913, 913, 1024, 1024, 1024, 1024, 1024, 1024,
    1024, 1024, 321, 469, 321, 912, 912, 912, 912, 912, 976, 469, 912, 912, 912, 912, 912, 912,
    912, 912, 912, 912, 912, 912, 912, 912, 912, 912, 912, 912, 912, 912, 912, 912, 912, 912, 912,
    912, 912, 912, 912, 912, 912, 1073, 1073, 1073, 1073, 1024, 1024, 1024, 1024, 1024, 1024, 1024,
    1024, 1024, 1024, 1283, 1283, 813, 813, 912, 912, 912, 912, 912, 912, 1003, 1003, 912, 912,
    794, 794, 794, 794, 1092, 1092, 912, 912, 894, 894, 894, 894, 912, 912, 830, 830, 1085, 830,
    800, 800, 800, 800, 493, 394, 650, 805, 913, 913, 1060, 1055,
];

fn haansoft_batang_wingdings_em(c: char) -> f64 {
    let idx = (c as u32).saturating_sub(0xF020) as usize;
    HAANSOFT_BATANG_WINGDINGS_ADVANCE
        .get(idx)
        .map_or(1.0, |&w| f64::from(w) / 1024.0)
}

/// HFT 원본의 폭 테이블이 없어 대체 서체로 재더라도 굵게 advance 는
/// 원본 메트릭 규칙을 따른다. 공백에는 합성 굵게의 추가 폭을 붙이지 않는다.
fn missing_hft_bold_char_width(style: &TextStyle, c: char, font_size: f64) -> Option<f64> {
    let original = style.hft_family.trim();
    let primary = style.font_family.split(',').next()?.trim();
    if !style.bold
        || style.font_metrics_policy == FontMetricsPolicy::HancomWindows
        || original.is_empty()
        || primary != original
        || font_metrics_data::hancom_bundled_face(original)
        // 이 서체의 기존 보정은 HFT 실측에 따라 공백 advance도 포함한다.
        || crate::renderer::hft_synthetic_bold_advance_em(original).is_some()
    {
        return None;
    }
    // macOS 전용 경로 — 배치 단위 모델이 양자화하므로 em 폭 그대로 잰다.
    let width = measure_char_width_inner(
        &style.font_family,
        false,
        style.italic,
        c,
        font_size,
        style.font_metrics_policy,
        true,
    )?;
    let tracking = if c == ' ' {
        0.0
    } else {
        font_size
            * crate::renderer::hft_synthetic_bold_advance_em(original)
                .unwrap_or(HFT_BOLD_ADVANCE_EM)
    };
    Some(width + tracking)
}

/// HWPUNIT 절삭 글자 폭 (장평·자간 전). 수식 등 글자 advance 모델 밖의 소비자용.
fn measure_char_width_with_policy(
    font_family: &str,
    bold: bool,
    italic: bool,
    c: char,
    font_size: f64,
    policy: FontMetricsPolicy,
) -> Option<f64> {
    measure_char_width_tracked(font_family, bold, italic, c, font_size, policy, false)
}

/// 본문 글자 advance 의 입력 폭 (장평·자간 전, `scaled_glyph_advance` 로 넘긴다).
/// macOS 는 em × 크기를 양자화하지 않고 넘겨 배치 단위 반올림이 실제 hmtx 비율을
/// 보게 한다. Windows 는 기존 HWPUNIT 절삭 폭이다.
fn measure_glyph_base_px(
    font_family: &str,
    bold: bool,
    italic: bool,
    c: char,
    font_size: f64,
    policy: FontMetricsPolicy,
) -> Option<f64> {
    let raw = policy == FontMetricsPolicy::HcrDeclared;
    measure_char_width_tracked(font_family, bold, italic, c, font_size, policy, raw)
}

/// 측정 캐시 키용 플래그 패킹 — bold/italic/raw + policy (2 variants).
#[inline]
fn measure_width_flags(bold: bool, italic: bool, policy: FontMetricsPolicy, raw: bool) -> u8 {
    u8::from(bold) | (u8::from(italic) << 1) | ((policy as u8) << 2) | (u8::from(raw) << 4)
}

fn measure_char_width_tracked(
    font_family: &str,
    bold: bool,
    italic: bool,
    c: char,
    font_size: f64,
    policy: FontMetricsPolicy,
    raw: bool,
) -> Option<f64> {
    let key = (
        font_family.to_string(),
        measure_width_flags(bold, italic, policy, raw),
        c,
        font_size.to_bits(),
    );
    if let Some(hit) = MEASURE_WIDTH_CACHE.with(|cache| cache.borrow().get(&key).copied()) {
        return hit;
    }
    let computed =
        measure_char_width_tracked_uncached(font_family, bold, italic, c, font_size, policy, raw);
    MEASURE_WIDTH_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() >= MEASURE_WIDTH_CACHE_MAX {
            cache.clear();
        }
        cache.insert(key, computed);
    });
    computed
}

fn measure_char_width_tracked_uncached(
    font_family: &str,
    bold: bool,
    italic: bool,
    c: char,
    font_size: f64,
    policy: FontMetricsPolicy,
    raw: bool,
) -> Option<f64> {
    let width = measure_char_width_inner(font_family, bold, italic, c, font_size, policy, raw)?;
    // 합성 진하게 자간 보정은 최상위 호출에서 한 번만 적용한다 — 내부의 폴백
    // 재귀는 `_inner` 를 직접 불러 face 결정과 무관하게 폭만 낸다.
    if let Some(tracking) = hft_bold_tracking_px(font_family, bold, c, font_size, policy) {
        return Some(width + tracking);
    }
    Some(width + synthetic_bold_tracking_px(font_family, bold, italic, font_size, policy))
}

/// HFT 폭 테이블로 재는 서체(신명 계열)의 합성 굵게 advance — 빈칸은 0.
/// 해당 서체가 아니면 None (기존 합성 굵게 규칙을 따른다).
fn hft_bold_tracking_px(
    font_family: &str,
    bold: bool,
    c: char,
    font_size: f64,
    policy: FontMetricsPolicy,
) -> Option<f64> {
    let primary = font_family.split(',').next().unwrap_or(font_family).trim();
    let metric = crate::renderer::hft_metrics::find_metric(primary, bold, false)?;
    if !bold || !metric.bold_fallback || policy == FontMetricsPolicy::HancomWindows || c == ' ' {
        return Some(0.0);
    }
    #[cfg(not(target_arch = "wasm32"))]
    if !crate::renderer::font_paths::custom_faces_loaded() {
        return Some(0.0);
    }
    Some(
        font_size
            * crate::renderer::hft_synthetic_bold_advance_em(primary)
                .unwrap_or(HFT_BOLD_ADVANCE_EM),
    )
}

/// [macOS 정합] 한컴(macOS)은 Bold face 가 없는 서체를 합성 진하게
/// (fill+stroke, `2 Tr`)로 그릴 때 글자 advance 에도 획 두께를 더해 자간을
/// 벌린다 — 09-table-004 의 bold 한양중고딕 셀이 문자당 ~+0.025em 벌어져
/// 렌더된다 (행 단위 우측 정렬선까지 드리프트). 실제 Bold face 가 그려질 때
/// (함초롬돋움 → HCR Dotum Bold 등) 또는 시스템/generic 폴백 경로에서는
/// 판정 불가로 보정하지 않는다.
fn synthetic_bold_tracking_px(
    font_family: &str,
    bold: bool,
    italic: bool,
    font_size: f64,
    policy: FontMetricsPolicy,
) -> f64 {
    if !bold || policy == FontMetricsPolicy::HancomWindows {
        return 0.0;
    }
    let primary = font_family.split(',').next().unwrap_or(font_family).trim();
    // 실측된 HFT 합성 advance 는 호스트의 설치 폰트와 무관하다.
    // Native 에서만 더하면 WASM 의 가운데 정렬 영문 줄 폭이 좁아진다.
    if let Some(em) = crate::renderer::hft_synthetic_bold_advance_em(primary) {
        return font_size * em;
    }
    // 네이티브에서 custom face 가 하나도 등록되지 않았으면(--font-path 없는
    // 단위 테스트 등) face 판정 자체가 불가하다 — 미등록으로 보정하면
    // 모든 굵은 글자에 자간이 붙어 기존 폭과 엇갈린다. wasm 은 registry 가
    // 없으므로 이 판정을 건너뛴다.
    #[cfg(not(target_arch = "wasm32"))]
    if !crate::renderer::font_paths::custom_faces_loaded() {
        return 0.0;
    }
    // 맑은 고딕처럼 한컴 번들에 Regular 만 있는 서체의 합성 굵게는 획만 덧칠하고
    // advance 는 Regular 그대로다 (hcar-001·kedi-application·mel-001 PDF 의
    // `2 Tr` 맑은 고딕 런: 숫자/한글 진행비 = Regular hmtx, 자간 0).
    // 아래 번들 face 판정이 이 경우를 보정 없음으로 처리한다.
    // 표준 Windows 글꼴(바탕·돋움·굴림·궁서 → 한컴바탕/한컴돋움 번들 치환)도
    // 치환 face 의 advance 그대로 조판한다 (fdi-press 굵은 바탕 본문: 굵은 런과
    // 보통 런의 글자 간격이 같다).
    if !crate::renderer::hancom_substitute_faces(primary).is_empty() {
        return 0.0;
    }
    // [macOS 정합] 한컴은 번들에 없는 face(HFT 한양중고딕 등)를 치환 조판할
    // 때만 획 두께를 advance 에 더한다. 번들에 실재하는 face(굴림 등)는
    // Bold variant 유무와 무관하게 실폰트 advance 를 그대로 쓴다 —
    // 29-civil-petition 의 bold 굴림 표제는 자간 보정 없이 렌더되고,
    // 09-table-004 의 bold 한양중고딕(미등록 → 한컴돋움 치환)은 보정된다.
    // 런타임 레지스트리(사용자 설치 폰트)에 등록된 face 는 실폰트 hmtx 가
    // 쓰이므로 합성 자간 보정을 붙이지 않는다 — Regular 폴백 Bold 도 실폰트
    // advance 그대로다.
    if crate::renderer::runtime_font_metrics::bold_fallback(primary, italic).is_some() {
        return 0.0;
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        // [macOS 정합] 치환 조판 대상이 아니라 한컴 번들 자체 face
        // (휴먼명조→HMKMM.TTF, HCI Poppy→HMEPO*.HFT 등 PrivateFont_ko-KR.dat /
        // Shared/Fonts 에 실재)로 그려지는 Bold 런은 실폰트 advance 를 유지한다 —
        // 31-port-call: bold 휴먼명조(방도·입파도)·HCI Poppy(' WAJ-01(') 가
        // 한컴 PDF 와 동일 폭으로 렌더 (보정 시 글자당 ~+0.32pt 드리프트).
        if crate::renderer::font_paths::custom_face_resolves_bold(primary, bold, italic).is_none()
            && !font_metrics_data::hancom_bundled_face(primary)
        {
            let em = crate::renderer::hft_synthetic_bold_advance_em(primary)
                .unwrap_or(crate::renderer::FAUX_BOLD_STROKE_EM);
            return font_size * em;
        }
    }
    // 번들에 해석되는 face 는 보정하지 않는다. wasm 은 custom 폰트 registry 가
    // 없어 판정 불가 — 보정하지 않는다.
    #[cfg(target_arch = "wasm32")]
    let _ = italic;
    0.0
}

fn measure_char_width_inner(
    font_family: &str,
    bold: bool,
    italic: bool,
    c: char,
    font_size: f64,
    policy: FontMetricsPolicy,
    raw: bool,
) -> Option<f64> {
    // 하이픈(U+00AD)은 '-' 폭으로 조판한다 (위 측정기 경로와 같은 규칙).
    let c = if c == '\u{00AD}' { '-' } else { c };
    // 묶음 빈칸(U+00A0)은 한컴 조판상 일반 빈칸과 같은 em/2 폭이다. 실폰트 hmtx 의
    // NBSP 폭(함초롬바탕 0.3em 등)을 쓰면 `①<묶음 빈칸>` 선택지 뒤 본문이
    // 한컴(macOS) PDF 보다 ~0.18em 왼쪽으로 당겨진다.
    let c = if c == '\u{00A0}' { ' ' } else { c };
    // CSS font-family 체인에서 첫 번째 폰트명으로 메트릭 조회
    let primary_name = font_family.split(',').next().unwrap_or(font_family).trim();
    if crate::renderer::hft_hangul_fullwidth_char(primary_name, c) {
        return Some(quantize_unless_raw(font_size, raw));
    }
    // [macOS 정합] 한양 계열 HFT 영문은 HFT 폭 블록 그대로 조판한다 (Windows 래더 표와
    // 0.04pt 단위로 다르다 — `font_metrics_data::hanyang_hft_ascii`).
    // 한양신명조 영문 칸의 가운뎃점(U+00B7)은 HFT 영문 은행 밖이라 한컴(macOS)이 별도
    // 기호 글리프로 그린다 — 진행 0.384em (탐침: 10.5pt 101·95단위, 11.5pt 110·104단위,
    // 장평 100/95%; 한글 face 와 무관).
    if policy == FontMetricsPolicy::HcrDeclared && c == '\u{00B7}' && primary_name == "한양신명조"
    {
        return Some(quantize_unless_raw(0.384 * font_size, raw));
    }
    if policy == FontMetricsPolicy::HcrDeclared && ('\u{21}'..='\u{7E}').contains(&c) {
        if let Some((table, em)) = font_metrics_data::hanyang_hft_ascii(primary_name) {
            let w = table[(c as u32 - 0x20) as usize];
            if w > 0 {
                return Some(quantize_unless_raw(
                    f64::from(w) / f64::from(em) * font_size,
                    raw,
                ));
            }
        }
    }
    // 명시적 CSS 대체 체인은 미해석 face 의 기본 글꼴보다 먼저 해석한다.
    // 첫 이름만 보고 함초롬돋움으로 치환하면 `Missing, HCR Batang` 의
    // 선언된 바탕 서체까지 무시하게 된다.
    if policy == FontMetricsPolicy::HcrDeclared
        && crate::renderer::hancom_unresolved_face(primary_name)
    {
        if let Some((_, fallback_chain)) = font_family.split_once(',') {
            return measure_char_width_inner(
                fallback_chain,
                bold,
                italic,
                c,
                font_size,
                policy,
                raw,
            );
        }
    }
    // 고정폭 한글 서체(돋움체 등)의 수학 연산 기호는 한컴이 전각 글자로 조판한다 —
    // 실폰트가 U+2212 를 반각 하이픈 글리프에 매핑해도 진행 폭은 1em 이다 (aift 글머리표
    // '−' 12pt: 본문까지 18pt = 기호 12pt + 본문 거리 50%). 판정은 요청 face 의 내장
    // 메트릭(설치 여부·치환과 무관하게 같은 결과).
    if ('\u{2200}'..='\u{22FF}').contains(&c)
        && font_metrics_data::find_metric(primary_name, bold, italic)
            .is_some_and(|m| is_monospace_metric(m.metric))
    {
        return Some(quantize_unless_raw(font_size, raw));
    }
    // HcrDeclared(macOS): 표준 Windows 폰트(바탕·궁서·돋움·굴림 계열)는 macOS
    // 한컴에 없으면 번들 서체(한컴바탕=Haansoft Batang / 한컴돋움=Haansoft
    // Dotum)로 치환해 그린다 — 조판 폭도 치환 서체의 hmtx 를 쓴다 (괄호 0.50em,
    // 숫자 0.583em 등 PDF 실측과 일치; Windows Batang 은 괄호 0.377em).
    // 단 치환은 한컴 FontMap 규칙과 동일하게 "요청 face가 없을 때만" 발동한다 —
    // --font-path 로 실제 TTF(예: 돋움체)가 주어지면 페인트 경로는 실폰트를 쓰고
    // (text_replay) 측정도 실폰트 메트릭(돋움체=고정폭)이어야 양쪽이 일치한다.
    let face_available = custom_font_face_available(primary_name);
    // 치환 메트릭은 치환 서체가 실제로 설치돼 있을 때만(그 서체로 그려질 때) 쓴다.
    // 치환 서체도 없으면 페인트는 제네릭 폴백으로 내려가므로 요청 face의 베이크드
    // 정본 폭(돋움체 전각 구두점 등)이 더 가깝다.
    let metric_name = if policy == FontMetricsPolicy::HcrDeclared
        && !face_available
        && !crate::renderer::runtime_font_metrics::has_face(primary_name, bold, italic)
    {
        crate::renderer::hancom_substitute_faces(primary_name)
            .iter()
            .copied()
            .find(|s| {
                custom_font_face_available(s)
                    || crate::renderer::runtime_font_metrics::has_face(s, bold, italic)
            })
            .or_else(|| {
                (crate::renderer::hancom_substitute_faces(primary_name)
                    == crate::renderer::HANCOM_DEFAULT_FACES)
                    .then_some(crate::renderer::HANCOM_DEFAULT_FACES[0])
            })
            .unwrap_or(primary_name)
    } else {
        primary_name
    };
    // face 파일이 주어지면 한컴도 실제 hmtx 로 조판한다 — 베이크드 테이블은
    // 구버전 TTF 기준이라 실폰트와 엇갈린다 (HY헤드라인M '.' 0.208→0.242em 등).
    // 공백은 HWP em/2 문서 규약이 우선이고, cmap 에 없는 글자는 베이크드
    // 경로로 폴백한다.
    if policy == FontMetricsPolicy::HcrDeclared && c != ' ' {
        let actual_advance = face_available
            .then(|| custom_face_char_em_advance(primary_name, bold, italic, c))
            .flatten()
            .or_else(|| {
                // 직접 가져온 파일의 hmtx도 실제 요청 face의 메트릭이다.
                // 내장 테이블이 글자를 수록해도 구버전 폭으로 되돌리지 않는다.
                crate::renderer::runtime_font_metrics::char_advance(primary_name, bold, italic, c)
                    .map(|advance| f64::from(advance.units) / f64::from(advance.em_size))
            })
            .or_else(|| {
                // Canvas가 실제 가져온 한컴 대체 face를 선택한 경우 조판도 같은
                // 등록 advance를 사용한다. 원본 face의 없는 글자는 기존 폴백을 유지한다.
                (metric_name != primary_name
                    && !crate::renderer::runtime_font_metrics::has_face(primary_name, bold, italic))
                .then(|| {
                    crate::renderer::runtime_font_metrics::char_advance(
                        metric_name,
                        bold,
                        italic,
                        c,
                    )
                })
                .flatten()
                .map(|advance| f64::from(advance.units) / f64::from(advance.em_size))
            });
        if let Some(mut em_advance) = actual_advance {
            // 실제 face의 곡선 큰따옴표와 낫표 advance는 보존한다. 나머지 구두점의
            // 기존 반각 정책과 내장/미등록 face 경로는 그대로 유지한다.
            if !matches!(c, '\u{201c}' | '\u{201d}' | '\u{300c}' | '\u{300d}')
                && (matches!(c, '\u{2018}'..='\u{2027}') || is_halfwidth_cjk_quote(c))
                && !mac_keeps_fullwidth_punct(c, policy)
                && em_advance >= 1.0
            {
                em_advance = 0.5;
            }
            return Some(quantize_unless_raw(em_advance * font_size, raw));
        }
    }
    // [macOS 정합] Wingdings PUA(U+F020..=U+F0FF)는 run 서체에 글리프가 없으면
    // 한컴이 Haansoft Batang 의 PUA 글리프·advance 로 조판한다
    // (composer::is_wingdings_pua — mel-001 휴먼명조 run ❖ 0.8906em).
    if policy == FontMetricsPolicy::HcrDeclared && super::super::composer::is_wingdings_pua(c) {
        let em_advance = custom_face_char_em_advance("Haansoft Batang", bold, italic, c)
            .unwrap_or_else(|| haansoft_batang_wingdings_em(c));
        return Some(quantize_unless_raw(em_advance * font_size, raw));
    }
    // [#2156] 함초롬바탕 비한글 문자 — Haansoft Batang 메트릭 대체 (한글 동작).
    if policy == FontMetricsPolicy::HancomWindows {
        if let Some(r) = haansoft_latin_override(primary_name, c) {
            return Some(quantize_unless_raw(r * font_size, raw));
        }
    }
    if let Some(w) = kopub_char_width(primary_name, c, font_size) {
        return Some(quantize_unless_raw(w, raw));
    }
    // macOS 한컴이 Bold face 를 제공하지 않는 서체(맑은 고딕 등)는 참조 환경에서
    // 굵게를 Regular face + 합성 획으로 그리므로 Regular 메트릭으로 조판한다.
    let metric_bold =
        bold && crate::renderer::macos_synthetic_bold_em(metric_name, policy).is_none();
    let requested = font_metrics_data::find_metric(metric_name, metric_bold, italic);
    let requested_covers = requested
        .as_ref()
        .is_some_and(|metric| c == ' ' || metric.metric.get_width(c).is_some());
    let mm = if requested_covers {
        requested.expect("checked above")
    } else if policy == FontMetricsPolicy::HancomWindows
        && requested
            .as_ref()
            .is_some_and(|metric| metric_has_source_range(metric.metric, c))
        && primary_name != "함초롬돋움"
        && crate::renderer::generic_fallback(primary_name).ends_with("sans-serif")
    {
        if let Some(fallback) = font_metrics_data::find_metric("함초롬돋움", bold, italic)
            .filter(|metric| metric.metric.get_width(c).is_some())
        {
            fallback
        } else {
            let (_, fallback_chain) = font_family.split_once(',')?;
            return measure_char_width_inner(
                fallback_chain,
                bold,
                italic,
                c,
                font_size,
                policy,
                raw,
            );
        }
    } else if let Some((_, substitute_chain)) = font_family.split_once(',').filter(|_| {
        requested.is_some()
            && crate::renderer::hft_metrics::find_metric(primary_name, false, false).is_some()
            && crate::renderer::hft_metric_fallback(primary_name).is_none()
    }) {
        // `measure_style` 가 앞에 둔 HFT 폭 테이블 밖의 글자는 원래 대체 서체로 잰다.
        return measure_char_width_inner(substitute_chain, bold, italic, c, font_size, policy, raw);
    } else if let Some(fallback) = requested
        .is_some()
        .then(|| crate::renderer::hft_metric_fallback(primary_name))
        .flatten()
    {
        // HFT 폭 테이블 밖의 글자는 한컴이 대체 TTF 로 그린다.
        return measure_char_width_inner(fallback, bold, italic, c, font_size, policy, raw);
    } else if let Some(em) = (policy == FontMetricsPolicy::HcrDeclared)
        .then(|| hancom_missing_glyph_em(primary_name, metric_bold, italic, c))
        .flatten()
    {
        return Some(quantize_unless_raw(em * font_size, raw));
    } else {
        // 내장 메트릭이 없거나 추출 범위 밖의 문자 → 사용자 설치 폰트의 실제 폭.
        // 내장 메트릭이 해당 범위를 수록했는데 글리프가 없으면 실제 폰트에도
        // 없으므로 기존 폴백 체인을 유지한다.
        if requested
            .as_ref()
            .is_none_or(|metric| !metric_has_source_range(metric.metric, c))
        {
            if let Some(w) =
                measure_char_width_runtime(primary_name, bold, italic, c, font_size, policy, raw)
            {
                return Some(w);
            }
            // 체인이 더 이어지지 않는 단일 face 명의인데 선언 face 가 글리프를
            // 갖지 못하는 문자 — 페인트는 fontdb 가 generic 폴백 체인을 따라
            // 글리프 보유 face 로 굽는다. 측정도 같은 순서로 첫 실재 face 의
            // 실 hmtx 를 쓴다. 공백 제외 — 한컴은 빈칸을 항상 em/2 로 잰다.
            // PUA 전 구간 제외 — 문서 의미 마커(사각문자·도장형 등)는 한컴이
            // 문서 고유 폭으로 그리므로 실폰트 hmtx 를 대입하면 안 된다
            // (25-leave-request 의 U+F03FF 글머리 등).
            if c != ' '
                && font_family.split_once(',').is_none()
                && !matches!(c as u32, 0xE000..=0xF8FF | 0xF0000..=0xFFFFD | 0x100000..=0x10FFFD)
            {
                for name in crate::renderer::generic_fallback(font_family).split(',') {
                    let name = name.trim().trim_matches(|q| q == '\'' || q == '"');
                    if name.is_empty() || name.eq_ignore_ascii_case(primary_name) {
                        continue;
                    }
                    if let Some(em) = custom_face_char_em_advance(name, bold, italic, c) {
                        return Some(quantize_unless_raw(em * font_size, raw));
                    }
                }
            }
        }
        // [macOS 정합] paint 단계가 함초롬돋움 계열 글리프로 치환하는 한컴
        // PUA 문자(pua_missing_glyph_substitute 수록분)는 조판 폭도 그 face 의
        // 값으로 맞춘다 — text_replay 의 HANCOM_MISSING_GLYPH_FAMILIES 와 같은
        // 규칙 (28-agritech-review 선문자 가 0.5em 폴백 대신 함초롬돋움 실측
        // 0.485em; 29-civil-petition U+F09E 는 함초롬돋움 미수록이라 Haansoft
        // Batang 0.458em). 앞선 HFT 누락 PUA 경로와 여기의 치환 대상에 속하지
        // 않는 글자는 기존 폴백 체인/휴리스틱을 유지한다.
        if policy == FontMetricsPolicy::HcrDeclared
            && super::super::composer::pua_missing_glyph_substitute(c).is_some()
        {
            if primary_name != "함초롬돋움" {
                let hcr_covers = font_metrics_data::find_metric("함초롬돋움", bold, italic)
                    .is_some_and(|m| m.metric.get_width(c).is_some());
                if hcr_covers {
                    return measure_char_width_inner(
                        "함초롬돋움",
                        bold,
                        italic,
                        c,
                        font_size,
                        policy,
                        raw,
                    );
                }
            }
            for cand in [
                "Haansoft Batang",
                "함초롬바탕",
                "Haansoft Dotum",
                "함초롬돋움",
                "HCR Batang",
                "HCR Dotum",
            ] {
                if let Some(em_advance) = custom_face_char_em_advance(cand, bold, italic, c) {
                    return Some(quantize_unless_raw(em_advance * font_size, raw));
                }
            }
        }
        let (_, fallback_chain) = font_family.split_once(',')?;
        return measure_char_width_inner(fallback_chain, bold, italic, c, font_size, policy, raw);
    };
    // HWP 반각 처리: space 및 한컴이 반각으로 처리하는 구두점/기호
    let w = if c == ' ' {
        mm.metric.em_size / 2
    } else {
        let glyph_w = mm.metric.get_width(c)?;
        hancom_glyph_units(c, glyph_w, mm.metric.em_size, policy, || {
            is_monospace_metric(mm.metric)
        })
    };
    // em 단위 → px: w / em_size * font_size, 그 후 HWP 양자화
    let em = mm.metric.em_size as f64;
    let actual_px = w as f64 * font_size / em;

    // Mac Hancom's HCR Batang Hangul runs use integer 600-DPI advances.
    // The independent mixed-body PDF uses an 83-unit em for 10 pt and an
    // 81-unit syllable advance: 9.72 pt, not the nominal 9.70 pt. The same
    // advance occurs in the body-spacing and mixed-cell captures. Applying
    // HWPUNIT truncation alone accumulates visible drift within long words.
    // Keep this scoped to the observed font/script and Mac policy. Latin
    // shaping, spaces, other fonts and Windows measurements are unchanged.
    if !raw
        && policy == FontMetricsPolicy::HcrDeclared
        && mm.metric.name == "HCR Batang"
        && ('\u{AC00}'..='\u{D7A3}').contains(&c)
    {
        let device_em = (font_size * 600.0 / 96.0).round();
        return Some((w as f64 * device_em / em).round() * 96.0 / 600.0);
    }

    // Bold 폴백: Regular 메트릭으로 폴백된 경우
    // 한컴은 faux bold(합성 Bold) 시 렌더링만 획을 두껍게 하고,
    // 텍스트 메트릭(폭 계산)에는 Regular 폭을 그대로 사용한다.
    // bold_fallback 보정을 적용하면 Justify 정렬에서 공백이 축소됨.
    // (26글자 × 1.02px/글자 = 26.5px 과대 → 공백 소멸)

    // 한컴과 동일한 HWPUNIT 정수 변환: w * base_size / em (내림)
    // round가 아닌 truncate (as i32)로 처리하여 한컴 정수 나눗셈과 일치
    Some(quantize_unless_raw(actual_px, raw))
}

#[cfg(test)]
#[test]
fn measured_hft_bold_tracking_is_independent_of_installed_faces() {
    assert_eq!(
        synthetic_bold_tracking_px(
            "한양신명조",
            true,
            false,
            24.0,
            FontMetricsPolicy::HcrDeclared
        ),
        1.0,
    );
    for (family, bold, policy) in [
        ("한양신명조", false, FontMetricsPolicy::HcrDeclared),
        ("한양신명조", true, FontMetricsPolicy::HancomWindows),
        ("바탕", true, FontMetricsPolicy::HcrDeclared),
    ] {
        assert_eq!(
            synthetic_bold_tracking_px(family, bold, false, 24.0, policy),
            0.0
        );
    }
}

#[cfg(test)]
#[test]
fn hollyhock_real_bold_keeps_source_advances_without_synthetic_tracking() {
    assert_eq!(
        hft_bold_tracking_px(
            "HCI Hollyhock",
            true,
            'A',
            20.0,
            FontMetricsPolicy::HcrDeclared
        ),
        Some(0.0),
    );
}

#[cfg(test)]
#[test]
fn hci_poppy_uses_hft_widths_and_palatino_linotype_for_missing_chars() {
    let width = |c: char, bold: bool| {
        measure_char_width_with_policy(
            "HCI Poppy",
            bold,
            false,
            c,
            20.0,
            FontMetricsPolicy::default(),
        )
        .unwrap()
    };
    // HMEPO.HFT: `<` = 310/512em (Palatino Linotype 은 0.5em).
    assert_eq!(width('<', false), quantize_hwp_px(20.0 * 310.0 / 512.0));
    assert!(font_metrics_data::find_metric("HCI Poppy", true, false)
        .is_some_and(|metric| !metric.bold_fallback));
    // HFT 에 없는 `·` 는 한컴 FontMap 대체 글꼴(Palatino Linotype) 폭으로 잰다.
    assert_eq!(
        width('\u{00B7}', false),
        measure_char_width_embedded("Palatino Linotype", false, false, '\u{00B7}', 20.0).unwrap()
    );
}

#[cfg(test)]
#[test]
fn mac_missing_glyph_uses_registered_fallback_outside_baked_ranges() {
    const CHILD: &str = "RHWP_MISSING_GLYPH_SOURCE_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("renderer::layout::text_measurement::mac_missing_glyph_uses_registered_fallback_outside_baked_ranges")
            .arg("--exact")
            .arg("--nocapture")
            .env(CHILD, "1")
            .output()
            .expect("run isolated glyph fallback test");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains("1 passed"),
            "{stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    use crate::renderer::runtime_font_metrics;
    const SOURCE: &str = "RHWP Missing Glyph Source";
    const COVERED: &str = "RHWP Covered Glyph Source";
    const CH: char = '\u{E100}';
    let source = include_bytes!("../../../tests/fixtures/fonts/RHWPShapingFixture.ttf");
    let fallback = include_bytes!("../../../tests/fixtures/fonts/RHWPBitmapSvgGlyphSmoke.ttf");
    runtime_font_metrics::register(source, &[SOURCE.into()], false, false).unwrap();
    runtime_font_metrics::register(
        fallback,
        &["함초롬돋움".into(), COVERED.into()],
        false,
        false,
    )
    .unwrap();
    assert!(font_metrics_data::find_metric("함초롬돋움", false, false)
        .unwrap()
        .metric
        .get_width(CH)
        .is_none());
    let expected = runtime_font_metrics::char_em_advance("함초롬돋움", false, false, CH).unwrap();
    let mut style = TextStyle {
        font_metrics_policy: FontMetricsPolicy::HcrDeclared,
        font_family: SOURCE.into(),
        font_size: 20.0,
        ..Default::default()
    };
    assert_eq!(
        measure_char_width_with_policy(SOURCE, false, false, CH, 20.0, style.font_metrics_policy),
        Some(quantize_hwp_px(expected * 20.0))
    );
    apply_covered_hancom_fallback(&mut style, &format!(" {CH} "));
    assert_eq!(style.font_family, "함초롬돋움");
    for (family, text, policy) in [
        (SOURCE, format!("A{CH}"), FontMetricsPolicy::HcrDeclared),
        (COVERED, CH.to_string(), FontMetricsPolicy::HcrDeclared),
        (SOURCE, "🂠".into(), FontMetricsPolicy::HcrDeclared),
        (SOURCE, CH.to_string(), FontMetricsPolicy::HancomWindows),
    ] {
        style.font_family = family.into();
        style.font_metrics_policy = policy;
        apply_covered_hancom_fallback(&mut style, &text);
        assert_eq!(style.font_family, family, "{text:?} {policy:?}");
    }
}

#[cfg(test)]
#[test]
fn covering_hancom_fallback_changes_only_fully_missing_sans_runs() {
    let mut style = TextStyle {
        font_metrics_policy: FontMetricsPolicy::HancomWindows,
        font_family: "문체부 돋음체".to_string(),
        font_size: 20.0,
        bold: true,
        ..Default::default()
    };
    apply_covered_hancom_fallback(&mut style, "Performance Assessment");
    assert_eq!(style.font_family, "함초롬돋움");
    assert!(
        font_metrics_data::find_metric(&style.font_family, true, false)
            .is_some_and(|metric| !metric.bold_fallback)
    );
    assert_eq!(
        measure_char_width_with_policy(
            "문체부 돋음체",
            true,
            false,
            'P',
            20.0,
            FontMetricsPolicy::HancomWindows,
        ),
        measure_char_width_with_policy(
            "함초롬돋움",
            true,
            false,
            'P',
            20.0,
            FontMetricsPolicy::HancomWindows,
        ),
    );

    style.font_family = "문체부 돋음체".to_string();
    apply_covered_hancom_fallback(&mut style, "한글");
    assert_eq!(style.font_family, "문체부 돋음체");
    apply_covered_hancom_fallback(&mut style, "한글 Performance");
    assert_eq!(style.font_family, "문체부 돋음체");

    style.font_family = "맑은 고딕".to_string();
    style.bold = false;
    apply_covered_hancom_fallback(&mut style, " ◦ ");
    assert_eq!(style.font_family, "함초롬돋움");
    assert_eq!(
        measure_char_width_with_policy(
            "맑은 고딕",
            false,
            false,
            '◦',
            13.333,
            FontMetricsPolicy::HancomWindows,
        ),
        measure_char_width_with_policy(
            "함초롬돋움",
            false,
            false,
            '◦',
            13.333,
            FontMetricsPolicy::HancomWindows,
        ),
    );
    style.font_family = "맑은 고딕".to_string();
    apply_covered_hancom_fallback(&mut style, "●");
    assert_eq!(style.font_family, "맑은 고딕");
    apply_covered_hancom_fallback(&mut style, "😀");
    assert_eq!(style.font_family, "맑은 고딕");
}

// ── 호환 래퍼 (기존 호출부 변경 없음) ──────────────────────────────

/// 위/아래 첨자 run 의 측정 스타일.
///
/// 한컴(macOS)은 첨자 glyph 만 줄이지 않고 진행폭과 자간도 같은 비율로 줄인다.
/// PDF 실측(el-school-001 '장소*를', 함초롬바탕 15pt·장평 97%·자간 -3%):
/// '*' 진행폭 4.92pt = 0.55em × 9.6pt × 0.97 × 0.97 (원래 크기 기준이면 7.7pt).
/// 측정 진입점이 모두 이 스타일을 쓰므로 줄바꿈·배치·렌더러·캐럿 좌표가 같은
/// advance 를 공유한다. 기준선 이동은 렌더러(`script_glyph_size_and_shift`)가 맡는다.
fn script_measure_style(style: &TextStyle) -> Option<TextStyle> {
    if !(style.superscript || style.subscript) {
        return None;
    }
    let scale = crate::renderer::SCRIPT_GLYPH_SCALE;
    let (font_size, _, _) = style_params(style);
    let mut script = style.clone();
    script.superscript = false;
    script.subscript = false;
    script.font_size = font_size * scale;
    script.script_base_size = font_size;
    // 자간은 글자 크기 × % 로 저장되어 있으므로 글자 크기와 함께 줄인다.
    script.letter_spacing = style.letter_spacing * scale;
    Some(script)
}

/// 텍스트 폭 추정
///
/// 플랫폼별 기본 TextMeasurer를 자동 선택하여 위임한다.
/// WASM: WasmTextMeasurer (JS Canvas + HWP 양자화)
/// 네이티브: EmbeddedTextMeasurer (내장 메트릭 + 휴리스틱)
pub(crate) fn estimate_text_width(text: &str, style: &TextStyle) -> f64 {
    let patched = measure_style(style);
    let style = patched.as_ref();
    if let Some(script) = script_measure_style(style) {
        return estimate_text_width(text, &script);
    }
    if let Some(positions) = shaped_char_positions(text, style) {
        return positions.last().copied().unwrap_or(0.0).round();
    }
    default_measurer().estimate_text_width(text, style)
}

/// 텍스트 폭 추정 (round 없이 raw px 반환)
///
/// 줄바꿈 엔진 전용. 단일 문자 토큰의 반올림 누적 오차를 방지한다.
/// 한컴은 HWPUNIT 정수로 폭을 누적하므로, round 없이 px를 합산한 뒤
/// 줄바꿈 비교 시점에서 available_width와 비교하는 것이 더 정확하다.
pub(crate) fn estimate_text_width_unrounded(text: &str, style: &TextStyle) -> f64 {
    let patched = measure_style(style);
    let style = patched.as_ref();
    if let Some(script) = script_measure_style(style) {
        return estimate_text_width_unrounded(text, &script);
    }
    if let Some(positions) = shaped_char_positions(text, style) {
        return positions.last().copied().unwrap_or(0.0);
    }
    let (font_size, ratio, tab_w) = style_params(style);
    let chars: Vec<char> = text.chars().collect();
    let cluster_len = build_cluster_len(&chars);
    let char_count = chars.len();

    let char_width = |i: usize| -> f64 {
        let c = chars[i];
        if c == '\u{2007}' {
            return scaled_glyph_advance(
                font_size * FIXED_WIDTH_SPACE_EM,
                '\u{2007}',
                style,
                font_size,
                ratio,
            ) + style.extra_char_spacing.max(0.0);
        }
        // 인라인 객체 placeholder 는 실제 control node 가 따로 그리므로 텍스트 폭은 0.
        if c == '\u{FFFC}' {
            return 0.0;
        }
        // 하이픈(U+00AD, HWP 코드 24)은 한컴(macOS)이 글꼴의 '-' 글리프와 폭으로
        // 그린다 (hcar-001 p3 `- 법령…` 줄: 맑은 고딕 0.41em 전진).
        let c = if c == '\u{00AD}' { '-' } else { c };
        // [Issue #677] HWP PUA 채움 문자 (U+F081C) — 시각 폭 0
        if c == '\u{F081C}' && style.font_metrics_policy == FontMetricsPolicy::HcrDeclared {
            return scaled_glyph_advance(
                hancom_cut_line_em() * font_size,
                c,
                style,
                font_size,
                ratio,
            ) + style.extra_char_spacing;
        }
        if c == '\u{F081C}' || c == '\u{200B}' {
            return 0.0;
        }
        let base_w_raw = if c == '\u{00B7}' && crate::renderer::hft_uses_paired_middle_dot(style) {
            font_size
        } else if let Some(w) = latin_space_width(style, c, font_size) {
            w
        } else if let Some(w) = missing_hft_bold_char_width(style, c, font_size) {
            w
        } else if let Some(w) = (c == '\u{318D}')
            .then(|| {
                area_dot_fallback_width(&style.font_family, font_size, style.font_metrics_policy)
            })
            .flatten()
        {
            w
        } else if let Some(w) = measure_glyph_base_px(
            &style.font_family,
            style.bold,
            style.italic,
            c,
            font_size,
            style.font_metrics_policy,
        ) {
            w
        } else if cluster_len[i] > 1 || is_cjk_char(c) || is_fullwidth_symbol(c) {
            font_size
        } else if is_narrow_punctuation(c) || is_narrow_paren_for_font(&style.font_family, c) {
            // Task #257: 콤마·중점 등 narrow glyph 폴백 폭 (0.5 → 0.3).
            font_size * 0.3
        } else {
            font_size * 0.5
        };
        let base_w = base_w_raw;
        character_advance(base_w, c, style, font_size, ratio)
    };

    let mut total = 0.0;
    for i in 0..char_count {
        if cluster_len[i] == 0 {
            continue;
        }
        let c = chars[i];
        if c == '\t' {
            let abs_x = style.line_x_offset + total;
            let next_abs = ((abs_x / tab_w).floor() + 1.0) * tab_w;
            total = (next_abs - style.line_x_offset).max(total);
            continue;
        }
        total += char_width(i);
    }
    total // round 없이 반환
}

/// 글자별 X 위치 경계값 계산
///
/// N글자 → N+1개 경계값을 반환한다 (0번째는 0.0, N번째는 전체 폭).
/// run 내부 상대 좌표이며, 절대 좌표는 run.bbox.x + charX[i]로 계산한다.
pub(crate) fn compute_char_positions(text: &str, style: &TextStyle) -> Vec<f64> {
    let patched = measure_style(style);
    let style = patched.as_ref();
    if let Some(script) = script_measure_style(style) {
        return compute_char_positions(text, &script);
    }
    if let Some(positions) = shaped_char_positions(text, style) {
        return positions;
    }
    default_measurer().compute_char_positions(text, style)
}

/// Glyph ink fitting advances, excluding placement-only spacing.
///
/// Tracking and justification move the next glyph; they must not widen the
/// current glyph when Canvas/SVG fit browser text to the calibrated advance.
pub(crate) fn compute_glyph_positions(text: &str, style: &TextStyle) -> Vec<f64> {
    let patched = measure_style(style);
    let style = patched.as_ref();
    let mut glyph_style = style.clone();
    glyph_style.letter_spacing = 0.0;
    glyph_style.extra_char_spacing = 0.0;
    glyph_style.extra_word_spacing = 0.0;
    glyph_style.extra_dash_advance = 0.0;
    compute_char_positions(text, &glyph_style)
}

// ── 문자 분류 함수 ──────────────────────────────────────────────────

/// CJK 문자 여부 판별 (EmbeddedTextMeasurer의 히우리스틱 폭 계산에서 사용)
pub(crate) fn is_cjk_char(c: char) -> bool {
    ('\u{1100}'..='\u{11FF}').contains(&c)   // 한글 자모
    || ('\u{3130}'..='\u{318F}').contains(&c) // 한글 호환 자모 (ㆍ U+318D 포함)
    || ('\u{AC00}'..='\u{D7AF}').contains(&c) // 한글 음절
    || ('\u{A960}'..='\u{A97F}').contains(&c) // 한글 자모 확장-A (옛한글 초성)
    || ('\u{D7B0}'..='\u{D7FF}').contains(&c) // 한글 자모 확장-B (옛한글 중/종성)
    || ('\u{4E00}'..='\u{9FFF}').contains(&c) // CJK Unified Ideographs
    || ('\u{3400}'..='\u{4DBF}').contains(&c) // CJK Extension A
    || ('\u{F900}'..='\u{FAFF}').contains(&c) // CJK Compatibility
    || ('\u{3040}'..='\u{30FF}').contains(&c) // 히라가나/카타카나
    || ('\u{FF00}'..='\u{FFEF}').contains(&c) // 전각 문자
}

/// 실제 글리프 폭이 반각(em/2)보다 뚜렷이 좁은 구두점·기호.
/// 메트릭 DB 미등록 폰트의 폴백 폭 계산 시 `font_size * 0.5` 대신
/// `font_size * 0.3` 을 쓰도록 분기하는 기준 (Task #257).
///
/// General Punctuation 좁은 글리프 확장: 휴먼명조 U+2027 등 DB 미수록
/// 폰트의 폴백 `font_size * 0.5` 가 한컴 대비 ~10px 과대 (font-size 20px
/// 기준). 한컴은 약 0.25-0.3 em 으로 렌더하므로 동일 분기 적용.
fn is_narrow_punctuation(c: char) -> bool {
    matches!(
        c,
        ',' | '.' | ':' | ';' | '\'' | '"' | '`' |
        '\u{00B7}' |  // · MIDDLE DOT
        '\u{2018}' |  // ' LEFT SINGLE QUOTATION MARK
        '\u{2019}' |  // ' RIGHT SINGLE QUOTATION MARK
        // ․ ONE DOT LEADER — 휴먼명조 등 폰트 미보유 글리프. 한컴은 좁은 점
        // 대체 폰트로 ~0.29em 으로 렌더하므로 0.5em 기본 폴백은 과대
        // (footnote-01 p3 '불법․무단제조': +3.1pt 누적 오차가 양쪽정렬
        // space 신축폭을 좁힘).
        '\u{2024}' |  // ․ ONE DOT LEADER
        '\u{2027}' |  // ‧ HYPHENATION POINT
        // [Task #1735] 한글 방점. 렌더 경로에서 좁은 가운데 점(·)으로 치환되므로
        // 측정 폭도 narrow 로 맞춰 측정-렌더 폭 정합 유지(0.5em 기본 폴백 방지).
        '\u{302E}' |  // 〮 HANGUL SINGLE DOT TONE MARK (방점)
        '\u{302F}' // 〯 HANGUL DOUBLE DOT TONE MARK (쌍방점)
    )
}

/// [#2239] 괄호 '(' ')' narrow 폭(0.3em) — 사다리 실측 폰트 한정.
///
/// 통제 사다리 실측(#2195 stage30/31): 휴먼명조 '(' = 0.31em(embedded 정합),
/// 한양중고딕 '(' <= 317HU(0.29em) — fallback 0.5em 은 과대
/// (76076 표325 r0 '(정량)영향집단명' 11pt: 8800>8642 로 2줄, 한글 1줄).
/// 단 HY신명조·바탕 계열은 0.5em(#2156 ASCII 폭 표 정합)이므로 폰트 무관
/// `is_narrow_punctuation` 전역 분류는 금지 — 실측된 폰트에서만 좁힌다.
/// (KoPub 계열은 `kopub_char_width` 자체 분기에서 별도 실측 근거로 유지.)
fn is_narrow_paren_for_font(font_family: &str, c: char) -> bool {
    if !matches!(c, '(' | ')') {
        return false;
    }
    let primary = font_family.split(',').next().unwrap_or(font_family).trim();
    primary.contains("휴먼명조") || primary.contains("한양중고딕") || primary.contains("HY중고딕")
}

/// 「」 낫표 판별.
///
/// 주의: 폭 강제에 쓰지 않는다 — 베이크드 메트릭이 이미 폰트별 한컴 조판 폭을
/// 기록한다 (함초롬 계열 0.5em, HFT 계열 전각). 과거에는 전각 기록값을 em/2 로
/// 강제했으나 한컴 macOS 는 HFT 폰트의 `」` 를 전각으로 조판한다
/// (36-apartment-form 지원제외대상 표 실측: `」` 뒤 반쪽 여백).
pub(crate) fn is_halfwidth_cjk_quote(c: char) -> bool {
    matches!(c, '\u{300C}' | '\u{300D}')
}

/// glyph 배치 시 특수 오프셋이 필요한 구두점.
/// 측정이 줄인 전각 구두점(' ' ‥ 등)과 「」 낫표를 포함한다 — 「」는 폰트가
/// 전각을 기록해도 paint 서체가 반각 글리프를 제공할 수 있어(HY신명조 조판은
/// 전각, 그리기는 함초롬 계열 치환) 셀 안 정렬 보정이 필요하다.
pub(crate) fn is_halfwidth_forced_punct(c: char) -> bool {
    matches!(c, '\u{2018}'..='\u{2027}') || is_halfwidth_cjk_quote(c)
}

/// 등록 글꼴 메트릭에 기록된 원래 glyph advance (px, 장평 전). 첨자 run 은 첨자 크기 기준.
///
/// 레이아웃이 반각으로 줄인 전각 구두점을 렌더러가 찌그러뜨리지 않고 배치할 때 쓴다
/// (`renderer::halfwidth_punct_glyph_offset`). 글꼴이 DB 에 없으면 `None`.
pub(crate) fn registered_glyph_advance(c: char, style: &TextStyle) -> Option<f64> {
    let patched = measure_style(style);
    let style = patched.as_ref();
    if let Some(script) = script_measure_style(style) {
        return registered_glyph_advance(c, &script);
    }
    let (font_size, _, _) = style_params(style);
    let primary = super::super::style_resolver::primary_font_name(&style.font_family);
    let bold = style.bold
        && crate::renderer::macos_synthetic_bold_em(primary, style.font_metrics_policy).is_none();
    let metric = font_metrics_data::find_metric(primary, bold, style.italic)?.metric;
    let width = metric.get_width(c)?;
    Some(f64::from(width) * font_size / f64::from(metric.em_size))
}

/// 한컴이 전각으로 처리하는 기호 (메트릭 폴백 시 font_size 사용)
fn is_fullwidth_symbol(c: char) -> bool {
    matches!(c,
        '\u{20A9}' |                   // ₩ WON SIGN
        '\u{20AC}' |                   // € EURO SIGN
        '\u{00A3}' |                   // £ POUND SIGN
        '\u{00A5}'                     // ¥ YEN SIGN
    )
    || ('\u{2190}'..='\u{21FF}').contains(&c) // Arrows (→, ⇨, ⇒ 등)
    || ('\u{2460}'..='\u{24FF}').contains(&c) // Enclosed Alphanumerics (①②③ 등)
    || ('\u{25A0}'..='\u{25FF}').contains(&c) // Geometric Shapes (□■▲◆○ 등, 섹션 머리 기호)
    || ('\u{2600}'..='\u{26FF}').contains(&c) // Miscellaneous Symbols (☆★ 등)
    || ('\u{2700}'..='\u{27BF}').contains(&c) // Dingbats (✓✗ 등)
    || ('\u{3200}'..='\u{32FF}').contains(&c) // Enclosed CJK Letters (㉠㉡ 등)
    || ('\u{3300}'..='\u{33FF}').contains(&c) // CJK Compatibility (㎜㎝ 등)
    || ('\u{2160}'..='\u{217F}').contains(&c) // Roman Numerals (Ⅰ Ⅱ Ⅲ 등)
}

/// 한글 자모 초성 여부 (옛한글 포함)
fn is_hangul_choseong(c: char) -> bool {
    ('\u{1100}'..='\u{115F}').contains(&c) || ('\u{A960}'..='\u{A97F}').contains(&c)
}

/// 한글 자모 중성 여부 (옛한글 포함, ᆞ U+119E 포함)
fn is_hangul_jungseong(c: char) -> bool {
    ('\u{1160}'..='\u{11A7}').contains(&c) || ('\u{D7B0}'..='\u{D7C6}').contains(&c)
}

/// 한글 자모 종성 여부 (옛한글 포함)
fn is_hangul_jongseong(c: char) -> bool {
    ('\u{11A8}'..='\u{11FF}').contains(&c) || ('\u{D7CB}'..='\u{D7FB}').contains(&c)
}

/// 텍스트를 렌더링 클러스터 단위로 분할한다.
/// 한글 자모 조합 시퀀스(초+중+종)를 하나의 클러스터로 묶어
/// 옛한글(아래아 등)이 올바르게 합성될 수 있도록 한다.
/// 반환값: Vec<(시작_문자_인덱스, 클러스터_문자열)>
pub fn split_into_clusters(text: &str) -> Vec<(usize, String)> {
    let chars: Vec<char> = text.chars().collect();
    let mut clusters: Vec<(usize, String)> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        // 초성으로 시작하는 자모 조합 시퀀스 감지
        if is_hangul_choseong(chars[i]) {
            let start = i;
            let mut cluster = String::new();
            cluster.push(chars[i]);
            i += 1;
            // 중성 (필수)
            if i < chars.len() && is_hangul_jungseong(chars[i]) {
                cluster.push(chars[i]);
                i += 1;
                // 종성 (선택)
                if i < chars.len() && is_hangul_jongseong(chars[i]) {
                    cluster.push(chars[i]);
                    i += 1;
                }
            }
            clusters.push((start, cluster));
        } else {
            clusters.push((i, chars[i].to_string()));
            i += 1;
        }
    }
    clusters
}

/// 세로쓰기에서 CW 90° 회전해야 하는 문자 판별
///
/// text_direction과 무관하게 항상 회전되는 문자:
/// - 괄호류: ( ) [ ] { } < > 〈 〉 《 》 「 」 『 』 【 】
/// - 문장부호: . , _ - ~ … ― ─
pub(crate) fn is_vertical_rotate_char(c: char) -> bool {
    matches!(
        c,
        '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>'
        | '.' | ',' | '_' | '-' | '~'
        | '\u{2026}' // … (ellipsis)
        | '\u{2015}' // ― (horizontal bar)
        | '\u{2500}' // ─ (box drawing horizontal)
        | '\u{2014}' // — (em dash)
        | '\u{2013}' // – (en dash)
        | '\u{3008}' | '\u{3009}' // 〈 〉
        | '\u{300A}' | '\u{300B}' // 《 》
        | '\u{300C}' | '\u{300D}' // 「 」
        | '\u{300E}' | '\u{300F}' // 『 』
        | '\u{3010}' | '\u{3011}' // 【 】
        | '\u{FF08}' | '\u{FF09}' // （ ）
        | '\u{FF3B}' | '\u{FF3D}' // ［ ］
        | '\u{FF5B}' | '\u{FF5D}' // ｛ ｝
    )
}

/// 세로쓰기 기호 대체: 수평 형태 → 세로 형태 Unicode 변환
///
/// CJK Compatibility Forms (U+FE30-FE4F) 및 Vertical Forms 활용.
/// 대체 가능한 문자가 있으면 Some(세로형태)를 반환하고,
/// 없으면 None을 반환한다 (호출측에서 회전 처리).
/// macOS HFT 굵은 세로쓰기의 글자 전진. 한글은 전각, 회전 괄호는 원본 라틴 폭이다.
/// 합성 굵게의 폭은 라틴 전진에만 붙고, 열 기준선은 글자 상자의 위쪽에 놓인다.
pub(crate) fn hft_vertical_advance(style: &TextStyle, ch: char) -> Option<f64> {
    if style.font_metrics_policy != FontMetricsPolicy::HcrDeclared
        || !style.bold
        || style.italic
        || style.hft_family.is_empty()
    {
        return None;
    }
    if is_cjk_char(ch) {
        return Some(style.font_size);
    }
    if !matches!(ch, '(' | ')') {
        return None;
    }
    let advance = crate::renderer::hft_glyphs::hft_advance_em(&style.hft_family, ch)?;
    let bold = crate::renderer::hft_synthetic_bold_advance_em(&style.hft_family)
        .unwrap_or(HFT_BOLD_ADVANCE_EM);
    Some(style.font_size * (advance + bold))
}

pub(crate) fn vertical_substitute_char(c: char) -> Option<char> {
    match c {
        // 괄호류
        '(' | '\u{FF08}' => Some('\u{FE35}'), // ︵
        ')' | '\u{FF09}' => Some('\u{FE36}'), // ︶
        '{' | '\u{FF5B}' => Some('\u{FE37}'), // ︷
        '}' | '\u{FF5D}' => Some('\u{FE38}'), // ︸
        '[' | '\u{FF3B}' => Some('\u{FE39}'), // ︹
        ']' | '\u{FF3D}' => Some('\u{FE3A}'), // ︺
        '\u{3010}' => Some('\u{FE3B}'),       // 【 → ︻
        '\u{3011}' => Some('\u{FE3C}'),       // 】 → ︼
        '\u{3008}' => Some('\u{FE3F}'),       // 〈 → ︿
        '\u{3009}' => Some('\u{FE40}'),       // 〉 → ﹀
        '\u{300A}' => Some('\u{FE3D}'),       // 《 → ︽
        '\u{300B}' => Some('\u{FE3E}'),       // 》 → ︾
        '\u{300C}' => Some('\u{FE41}'),       // 「 → ﹁
        '\u{300D}' => Some('\u{FE42}'),       // 」 → ﹂
        '\u{300E}' => Some('\u{FE43}'),       // 『 → ﹃
        '\u{300F}' => Some('\u{FE44}'),       // 』 → ﹄
        // 대시/선
        '\u{2014}' => Some('\u{FE31}'), // — → ︱ (em dash)
        '\u{2013}' => Some('\u{FE32}'), // – → ︲ (en dash)
        '\u{2015}' => Some('\u{FE31}'), // ― → ︱ (horizontal bar)
        '\u{2500}' => Some('\u{2502}'), // ─ → │ (box drawing)
        // 말줄임
        '\u{2026}' => Some('\u{FE19}'), // … → ︙ (vertical ellipsis)
        // 물결표
        '~' => Some('\u{FE34}'), // ~ → ︴ (vertical wavy low line)
        // 밑줄
        '_' => Some('\u{FE33}'), // _ → ︳ (vertical low line)
        _ => None,
    }
}

// ── 테스트 ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    #[test]
    fn hft_vertical_advance_reads_source_width_and_preserves_other_profiles() {
        let mut bytes = vec![0u8; 526];
        let magic = b"Han Unified Font File 1.0\x1a";
        bytes[..magic.len()].copy_from_slice(magic);
        let family = "VerticalFixture";
        bytes[0x6c..0x6c + family.len()].copy_from_slice(family.as_bytes());
        bytes[0x1aa..0x1ae].copy_from_slice(&512u32.to_le_bytes());
        bytes[512..516].copy_from_slice(&14u32.to_le_bytes());
        bytes[516..518].copy_from_slice(&40u16.to_le_bytes());
        bytes[518..520].copy_from_slice(&41u16.to_le_bytes());
        bytes[520..522].copy_from_slice(&1u16.to_le_bytes());
        bytes[522..524].copy_from_slice(&300u16.to_le_bytes());
        bytes[524..526].copy_from_slice(&320u16.to_le_bytes());
        assert!(crate::renderer::hft_glyphs::register_hft_bytes(bytes));
        let mut style = TextStyle {
            font_size: 20.0,
            hft_family: family.to_string(),
            bold: true,
            font_metrics_policy: FontMetricsPolicy::HcrDeclared,
            ..TextStyle::default()
        };
        assert_eq!(hft_vertical_advance(&style, '한'), Some(20.0));
        assert_eq!(hft_vertical_advance(&style, '('), Some(7.0));
        assert_eq!(hft_vertical_advance(&style, ')'), Some(7.4));
        assert_eq!(hft_vertical_advance(&style, 'A'), None);
        style.bold = false;
        assert_eq!(hft_vertical_advance(&style, '('), None);
        style.bold = true;
        style.italic = true;
        assert_eq!(hft_vertical_advance(&style, '한'), None);
        style.italic = false;
        style.font_metrics_policy = FontMetricsPolicy::HancomWindows;
        assert_eq!(hft_vertical_advance(&style, '('), None);
        style.font_metrics_policy = FontMetricsPolicy::HcrDeclared;
        style.hft_family.clear();
        assert_eq!(hft_vertical_advance(&style, '한'), None);
    }

    #[test]
    fn hft_fallback_is_measured_without_becoming_an_authored_substitute() {
        let mut style = TextStyle {
            font_family: "HY신명조".into(),
            hft_family: "신명 중명조".into(),
            ..Default::default()
        };
        assert_eq!(style.effective_font_subst(), "한컴바탕");
        assert_eq!(measure_style(&style).font_family, "한컴바탕");
        assert!(style.font_subst.is_empty());

        // 실제 문서 선언 대체는 미설치 원본의 측정 서체도 바꾼다.
        style.font_family = "HY Unavailable authored HFT alias".into();
        style.font_subst = "함초롬바탕".into();
        assert_eq!(measure_style(&style).font_family, "함초롬바탕");
    }

    use super::*;

    /// 합성 스윕(한컴 macOS 12.30, lineseg 없는 문서)에서 확정한 배치 단위 advance.
    #[test]
    fn mac_glyph_advances_follow_hancom_layout_units() {
        let px = |pt: f64| pt * 96.0 / 72.0;
        let units = |text: &str, style: &TextStyle| {
            let positions = EmbeddedTextMeasurer.compute_char_positions(text, style);
            positions
                .windows(2)
                .map(|w| ((w[1] - w[0]) / MAC_LAYOUT_UNIT_PX).round() as i32)
                .collect::<Vec<_>>()
        };
        let style = |size_pt: f64, ratio: f64, spacing: f64| TextStyle {
            font_family: "함초롬바탕".into(),
            font_size: px(size_pt),
            ratio,
            letter_spacing: px(size_pt) * spacing / 100.0,
            font_metrics_policy: FontMetricsPolicy::HcrDeclared,
            ..Default::default()
        };
        // 크기: 한글 0.97em = round_half_up(0.97 × floor(크기HU/4)), 빈칸 = floor(u/2).
        for (size, hangul, space) in [(10.0, 243, 125), (9.5, 230, 118), (7.0, 170, 87)] {
            assert_eq!(
                units("가 ", &style(size, 1.0, 0.0)),
                [hangul, space],
                "{size}pt"
            );
        }
        // 장평: 글리프 floor(em × u × r), 빈칸 round_half_up(floor(u/2) × r).
        for (ratio, hangul, space) in [
            (0.5, 121, 63),
            (0.6, 145, 75),
            (0.7, 169, 88),
            (1.5, 363, 188),
        ] {
            assert_eq!(
                units("가 ", &style(10.0, ratio, 0.0)),
                [hangul, space],
                "{ratio}"
            );
        }
        // 자간: 증감분 반올림의 0.5 는 0 에서 먼 쪽 (+50% → 365, −50% → 121).
        assert_eq!(units("가", &style(10.0, 1.0, 50.0)), [365]);
        assert_eq!(units("가", &style(10.0, 1.0, -50.0)), [121]);
        assert_eq!(units("가", &style(10.0, 1.0, 20.0)), [292]);
    }

    /// 한컴 합성 탐침의 실폰트 hmtx/upm: 맑은 고딕, 함초롬바탕.
    #[test]
    fn tracked_glyphs_apply_document_ratio_before_advance_quantization() {
        for (size, ratio, glyph, em, negative, positive) in [
            (9.0, 0.95, ')', 624.0 / 2048.0, 60, 70),
            (11.0, 0.90, '1', 550.0 / 1000.0, 126, 146),
            (11.0, 0.95, 'A', 1348.0 / 2048.0, 159, 183),
            (9.0, 0.95, '가', 970.0 / 1000.0, 193, 221),
            (9.0, 0.95, ' ', 0.5, 99, 113),
            (11.0, 0.95, ' ', 0.5, 121, 139),
            (12.0, 0.95, ' ', 0.5, 133, 153),
        ] {
            for (spacing, expected) in [(-7.0, negative), (7.0, positive)] {
                let font_size = size * 96.0 / 72.0;
                let style = TextStyle {
                    font_size,
                    ratio,
                    letter_spacing: font_size * spacing / 100.0,
                    font_metrics_policy: FontMetricsPolicy::HcrDeclared,
                    ..Default::default()
                };
                let advance = mac_glyph_advance_px(font_size * em, glyph, &style, font_size, ratio);
                assert_eq!(
                    (advance / MAC_LAYOUT_UNIT_PX).round() as i32,
                    expected,
                    "{glyph} {size}pt ratio={ratio} spacing={spacing}"
                );
            }
        }
    }

    #[test]
    fn mac_ellipsis_keeps_a_fullwidth_hmtx_advance() {
        let style = |policy| TextStyle {
            font_family: "굴림".into(),
            font_size: 40.0 / 3.0,
            font_metrics_policy: policy,
            ..Default::default()
        };
        let mac = EmbeddedTextMeasurer
            .compute_char_positions("…", &style(FontMetricsPolicy::HcrDeclared));
        assert!((mac[1] - 40.0 / 3.0).abs() < 1e-9, "{mac:?}");
        let win = EmbeddedTextMeasurer
            .compute_char_positions("…", &style(FontMetricsPolicy::HancomWindows));
        assert!((win[1] - 20.0 / 3.0).abs() < 0.02, "{win:?}");
    }

    #[test]
    fn mac_character_spacing_quantizes_before_and_after_scaling() {
        // 한컴 PDF 무신축 마지막 줄 실측: 휴먼명조 14pt 및 한컴돋움 13pt.
        // 6.86pt 중간값과 7.57pt 원폭은 각각 후단/전단 양자화를 검증한다.
        for (base_pt, size_pt, spacing_percent, expected_pt) in [
            (7.0, 14.0, -1.0, 6.92),
            (7.0, 14.0, -2.0, 6.84),
            (7.0, 14.0, -3.0, 6.80),
            (7.0, 14.0, -5.0, 6.64),
            (7.0, 14.0, -7.0, 6.52),
            (7.57, 13.0, -4.0, 7.24),
        ] {
            let px_per_pt = 96.0 / 72.0;
            let base = base_pt * px_per_pt;
            let size = size_pt * px_per_pt;
            let spacing = size * spacing_percent / 100.0;
            let advance =
                base + glyph_letter_spacing(spacing, base, size, FontMetricsPolicy::HcrDeclared);
            assert!(
                (advance / px_per_pt - expected_pt).abs() < 1e-9,
                "base={base_pt}, spacing={spacing_percent}: {advance}"
            );
        }
    }

    #[test]
    fn spacing_grid_preserves_zero_spacing_and_windows_metrics() {
        let base = 7.57 * 96.0 / 72.0;
        let size = 13.0 * 96.0 / 72.0;
        assert_eq!(
            glyph_letter_spacing(0.0, base, size, FontMetricsPolicy::HcrDeclared),
            0.0
        );
        let spacing = size * -0.04;
        let contribution =
            glyph_letter_spacing(spacing, base, size, FontMetricsPolicy::HancomWindows);
        assert!((contribution - spacing * (base / size)).abs() < 1e-12);
    }

    /// 테스트용 고정 폭 텍스트 측정기
    ///
    /// 모든 문자를 동일한 폭으로 측정한다.
    /// 결정론적 테스트와 레이아웃 로직 검증에 사용한다.
    pub struct MockTextMeasurer {
        pub char_width: f64,
    }

    impl TextMeasurer for MockTextMeasurer {
        fn estimate_text_width(&self, text: &str, style: &TextStyle) -> f64 {
            let (font_size, ratio, tab_w) = style_params(style);
            let chars: Vec<char> = text.chars().collect();
            let cluster_len = build_cluster_len(&chars);
            let mut total = 0.0;
            for i in 0..chars.len() {
                if cluster_len[i] == 0 {
                    continue;
                }
                if chars[i] == '\t' {
                    total = ((total / tab_w).floor() + 1.0) * tab_w;
                    continue;
                }
                total += self.char_width * ratio + style.letter_spacing + style.extra_char_spacing;
                if chars[i] == ' ' {
                    total += style.extra_word_spacing;
                }
            }
            total
        }

        fn compute_char_positions(&self, text: &str, style: &TextStyle) -> Vec<f64> {
            let (font_size, ratio, tab_w) = style_params(style);
            let chars: Vec<char> = text.chars().collect();
            let cluster_len = build_cluster_len(&chars);
            let mut positions = Vec::with_capacity(chars.len() + 1);
            let mut x = 0.0;
            positions.push(x);
            for i in 0..chars.len() {
                if cluster_len[i] == 0 {
                    positions.push(x);
                    continue;
                }
                if chars[i] == '\t' {
                    x = ((x / tab_w).floor() + 1.0) * tab_w;
                    positions.push(x);
                    continue;
                }
                x += self.char_width * ratio + style.letter_spacing + style.extra_char_spacing;
                if chars[i] == ' ' {
                    x += style.extra_word_spacing;
                }
                positions.push(x);
            }
            positions
        }
    }

    // ── #2156 함초롬바탕 라틴 메트릭 대체 ──

    #[test]
    fn declared_hcr_metrics_do_not_use_windows_latin_substitution() {
        let style = TextStyle {
            font_family: "함초롬바탕".into(),
            font_size: 40.0 / 3.0,
            font_metrics_policy: FontMetricsPolicy::HcrDeclared,
            ..Default::default()
        };
        // HCRBatang in the captured Mac PDF uses P=0.603em, a=0.569em,
        // period=0.320em. The Windows substitute has different advances.
        // 10pt = 250 배치 단위: 151 + 142 + 80.
        let expected: f64 = [603.0, 569.0, 320.0]
            .into_iter()
            .map(|w| round_half_up(w * 250.0 / 1000.0) * MAC_LAYOUT_UNIT_PX)
            .sum();
        let positions = EmbeddedTextMeasurer.compute_char_positions("Pa.", &style);
        assert!(
            (positions.last().unwrap() - expected).abs() < 0.001,
            "positions={positions:?}; expected={expected}"
        );
        assert!((estimate_text_width_unrounded("Pa.", &style) - expected).abs() < 0.001);
        let windows = TextStyle {
            font_metrics_policy: FontMetricsPolicy::HancomWindows,
            ..style.clone()
        };
        assert!((estimate_text_width_unrounded("Pa.", &windows) - expected).abs() > 0.5);
    }

    #[test]
    fn mac_hcr_hangul_uses_captured_device_advances_in_all_measurement_paths() {
        for family in ["함초롬바탕", "HCR Batang", "Missing font, HCR Batang"] {
            let style = TextStyle {
                font_family: family.into(),
                font_size: 40.0 / 3.0,
                font_metrics_policy: FontMetricsPolicy::HcrDeclared,
                ..Default::default()
            };
            // Consecutive glyph origins in the immutable independent PDF:
            // 226.919998, 236.639969, 246.359924, 256.079895, 265.799866 pt.
            let positions = EmbeddedTextMeasurer.compute_char_positions("이어집니다", &style);
            for (index, x) in positions.iter().enumerate() {
                assert!((x * 0.75 - index as f64 * 9.72).abs() < 1e-9);
            }
            let expected = 5.0 * 9.72 / 0.75;
            assert!((estimate_text_width_unrounded("이어집니다", &style) - expected).abs() < 1e-9);
            assert!(
                (EmbeddedTextMeasurer.estimate_text_width("이어집니다", &style) - expected).abs()
                    < 1e-9
            );
            let windows = TextStyle {
                font_metrics_policy: FontMetricsPolicy::HancomWindows,
                ..style
            };
            let positions = EmbeddedTextMeasurer.compute_char_positions("이어집니다", &windows);
            assert!((positions[5] * 0.75 - 5.0 * 9.70).abs() < 1e-9);
        }
        for family in ["HCR Dotum", "Haansoft Batang", "Noto Serif KR"] {
            let style = TextStyle {
                font_family: family.into(),
                font_size: 40.0 / 3.0,
                font_metrics_policy: FontMetricsPolicy::HcrDeclared,
                ..Default::default()
            };
            let windows = TextStyle {
                font_metrics_policy: FontMetricsPolicy::HancomWindows,
                ..style.clone()
            };
            // 다른 글꼴도 같은 배치 단위 격자를 쓴다 — Windows 폭과 반 단위 안에서 다르다.
            let mac = EmbeddedTextMeasurer.compute_char_positions("이어집니다", &style);
            let win = EmbeddedTextMeasurer.compute_char_positions("이어집니다", &windows);
            for (m, w) in mac.windows(2).zip(win.windows(2)) {
                let advance = m[1] - m[0];
                let units = advance / MAC_LAYOUT_UNIT_PX;
                assert!((units - units.round()).abs() < 1e-6, "{family}: {mac:?}");
                assert!((advance - (w[1] - w[0])).abs() <= MAC_LAYOUT_UNIT_PX / 2.0 + 1.0 / 75.0);
            }
        }
    }

    #[test]
    fn hft_seal_keeps_single_hcr_glyph_advance() {
        let style = TextStyle {
            font_family: "한양신명조".into(),
            hft_family: "한양신명조".into(),
            font_size: 20.0,
            font_metrics_policy: FontMetricsPolicy::HcrDeclared,
            ..Default::default()
        };
        let text = "\u{F012B}";
        assert_eq!(
            crate::renderer::composer::expand_pua_display_text(text),
            text
        );
        assert!(is_hft_missing_pua(&style, '\u{F012B}'));
        let positions = EmbeddedTextMeasurer.compute_char_positions(text, &style);
        assert_eq!(positions.len(), 2);
        // 15pt = 375 배치 단위, 함초롬바탕 0.97em → 364 단위.
        let expected = 364.0 * MAC_LAYOUT_UNIT_PX;
        assert!((positions[1] - expected).abs() < 0.001, "{positions:?}");
        assert!((estimate_text_width_unrounded(text, &style) - expected).abs() < 0.001);
    }

    #[test]
    fn paired_hft_middle_dot_keeps_the_source_full_em_advance() {
        let style = TextStyle {
            font_family: "한양견고딕".into(),
            hft_family: "한양견고딕".into(),
            font_metrics_policy: FontMetricsPolicy::HcrDeclared,
            font_size: 20.0,
            ratio: 0.8,
            letter_spacing: -2.0,
            ..TextStyle::default()
        };
        let positions = EmbeddedTextMeasurer.compute_char_positions("가·나", &style);
        assert!((positions[2] - positions[1] - 14.4).abs() < 0.001);
        assert!((EmbeddedTextMeasurer.estimate_text_width("·", &style) - 14.4).abs() < 0.001);
    }

    #[test]
    fn missing_hft_bold_metrics_preserve_space_and_shared_character_positions() {
        let regular = TextStyle {
            font_family: "한양중고딕".into(),
            hft_family: "한양중고딕".into(),
            font_size: 20.0,
            font_metrics_policy: FontMetricsPolicy::HcrDeclared,
            ..Default::default()
        };
        let bold = TextStyle {
            bold: true,
            ..regular.clone()
        };
        let text = "가 나";
        let regular_positions = EmbeddedTextMeasurer.compute_char_positions(text, &regular);
        let bold_positions = EmbeddedTextMeasurer.compute_char_positions(text, &bold);
        // 획 두께 advance 는 글리프 폭과 함께 배치 단위로 반올림된다.
        for (i, extra) in [0.0, 1.0, 1.0, 2.0].into_iter().enumerate() {
            assert!(
                (bold_positions[i] - regular_positions[i] - extra).abs()
                    <= MAC_LAYOUT_UNIT_PX * extra.ceil() + 1e-9
            );
        }
        assert!(
            (EmbeddedTextMeasurer.estimate_text_width(text, &bold)
                - bold_positions.last().unwrap())
            .abs()
                < 0.001
        );
        let bundled = TextStyle {
            font_family: "HCI Poppy".into(),
            hft_family: "HCI Poppy".into(),
            ..bold.clone()
        };
        assert!(missing_hft_bold_char_width(&bundled, '1', 20.0).is_none());
        let windows = TextStyle {
            font_metrics_policy: FontMetricsPolicy::HancomWindows,
            ..bold
        };
        assert!(missing_hft_bold_char_width(&windows, '가', 20.0).is_none());
    }

    #[test]
    fn mac_run_width_preserves_fractional_advances_for_justification() {
        let style = TextStyle {
            font_family: "함초롬바탕".into(),
            font_size: 40.0 / 3.0,
            font_metrics_policy: FontMetricsPolicy::HcrDeclared,
            ..Default::default()
        };
        for text in [" ", "Picture and text share this paragraph. ", "paragraph."] {
            let positions = EmbeddedTextMeasurer.compute_char_positions(text, &style);
            let raw = *positions.last().unwrap();
            assert!((EmbeddedTextMeasurer.estimate_text_width(text, &style) - raw).abs() < 1e-9);
            let windows = TextStyle {
                font_metrics_policy: FontMetricsPolicy::HancomWindows,
                ..style.clone()
            };
            let win_positions = EmbeddedTextMeasurer.compute_char_positions(text, &windows);
            assert_eq!(
                EmbeddedTextMeasurer.estimate_text_width(text, &windows),
                win_positions.last().unwrap().round()
            );
        }
        let text = "Picture and text share this paragraph. ";
        let visible = text.trim_end();
        let full_width = EmbeddedTextMeasurer.estimate_text_width(text, &style);
        let trailing_width = EmbeddedTextMeasurer.estimate_text_width(" ", &style);
        let visible_width = EmbeddedTextMeasurer.estimate_text_width(visible, &style);
        assert!((full_width - trailing_width - visible_width).abs() < 1e-9);
        // The old two roundings lost enough width to fail the captured glyph gate.
        assert!((full_width.round() - trailing_width.round() - visible_width).abs() > 0.5);
    }

    /// Windows 한글은 함초롬바탕(HCR Batang) 문서의 비한글 문자(라틴·숫자·구두점·
    /// U+00B7)를 Haansoft Batang(한컴바탕) 메트릭으로 렌더한다 — 문자폭 사다리
    /// 통제 프로브로 전 판별 클래스 확정. 이 치환은 `HancomWindows` 정책
    /// 전용이며, 기본(macOS) 정책은 HCR Batang 자체 hmtx 를 쓴다.
    #[test]
    fn issue_2156_hcr_batang_latin_uses_haansoft_metrics_only_for_windows_policy() {
        let fs = 40.0 / 3.0; // 10pt = 13.333px
        let windows = |family: &str, c: char| {
            measure_char_width_with_policy(
                family,
                false,
                false,
                c,
                fs,
                FontMetricsPolicy::HancomWindows,
            )
            .unwrap_or_else(|| panic!("{family} 측정 실패: {c:?}"))
        };
        let w = |c: char| windows("함초롬바탕", c);
        let hcr_batang = |c: char| windows("HCR Batang", c);
        // macOS 한글 PDF 실측: '(' 0.32em, '-' 0.55em, 숫자 0.55em (HANBatang.ttf hmtx).
        for (c, em) in [('(', 0.320), ('-', 0.550), ('0', 0.550), ('.', 0.320)] {
            let mac = measure_char_width_embedded("함초롬바탕", false, false, c, fs).unwrap();
            assert!((mac - fs * em).abs() < 0.05, "mac {c:?} {mac} ≠ {em}em");
        }
        assert!(
            (w('(') - fs * 0.5000).abs() < 0.05,
            "'(' {} ≠ 0.500em",
            w('(')
        );
        assert!(
            (w(',') - fs * 0.2910).abs() < 0.05,
            "',' {} ≠ 0.291em",
            w(',')
        );
        assert!(
            (w('0') - fs * 0.5830).abs() < 0.05,
            "'0' {} ≠ 0.583em",
            w('0')
        );
        assert!(
            (w('A') - fs * 0.7500).abs() < 0.05,
            "'A' {} ≠ 0.750em",
            w('A')
        );
        assert!(
            (w('·') - fs * 0.3330).abs() < 0.05,
            "'·' {} ≠ 0.333em",
            w('·')
        );
        assert_eq!(
            w('('),
            hcr_batang('('),
            "HCR Batang 별칭도 함초롬바탕과 같은 Haansoft Batang 메트릭을 사용해야 함"
        );
        // 한글 음절·공백은 기존 경로(HCR hmtx / useFontSpace=0 em/2) 유지.
        // 검증하지 않은 돋움/확장 계열과 비함초롬 폰트는 오버라이드하지 않는다.
        assert!(haansoft_latin_override("함초롬바탕", '가').is_none());
        assert!(haansoft_latin_override("함초롬바탕", ' ').is_none());
        assert!(haansoft_latin_override("함초롬돋움", '(').is_none());
        assert!(haansoft_latin_override("HCR Dotum", '(').is_none());
        assert!(haansoft_latin_override("함초롬바탕 확장", '(').is_none());
        assert!(haansoft_latin_override("HCR Batang Ext", '(').is_none());
        assert!(haansoft_latin_override("바탕", '(').is_none());
    }

    // ── #2279 한컴돋움/한컴바탕 = Haansoft 실메트릭 ──

    /// 한컴돋움/한컴바탕의 실체는 Haansoft Dotum/Batang (HDOTUM.TTF/HBATANG.TTF
    /// name table 한국어명). 한글 PDF 실측(36398599 pi35 단일줄 무신축 '*' run:
    /// 0.583em, 한글 음절 1.0em)과 hmtx 가 일치 — HCR(함초롬) 메트릭('*' 0.498,
    /// 음절 0.97em)으로 회귀하면 '*' 마스킹 구분선·본문 래핑 줄수가 한글 대비
    /// ±1 이탈한다 (92 컨트롤셋 36398599/36399105 −1쪽 계열).
    #[test]
    fn issue_2279_hancom_dotum_batang_use_haansoft_metrics() {
        let fs = 20.0; // 15pt
        let w = |fam: &str, c: char| {
            measure_char_width_embedded(fam, false, false, c, fs)
                .unwrap_or_else(|| panic!("측정 실패: {fam} {c:?}"))
        };
        // 한컴돋움 = Haansoft Dotum
        assert!(
            (w("한컴돋움", '*') - fs * 0.583).abs() < 0.05,
            "'*' {}",
            w("한컴돋움", '*')
        );
        assert!(
            (w("한컴돋움", '0') - fs * 0.583).abs() < 0.05,
            "'0' {}",
            w("한컴돋움", '0')
        );
        assert!(
            (w("한컴돋움", '가') - fs * 1.0).abs() < 0.05,
            "'가' {}",
            w("한컴돋움", '가')
        );
        // 한컴바탕 = Haansoft Batang (음절 1.0em; ASCII 는 #2156 표와 동일)
        assert!(
            (w("한컴바탕", '가') - fs * 1.0).abs() < 0.05,
            "'가' {}",
            w("한컴바탕", '가')
        );
        assert!(
            (w("한컴바탕", '*') - fs * 0.5).abs() < 0.05,
            "'*' {}",
            w("한컴바탕", '*')
        );
        // 함초롬돋움은 종전대로 HCR Dotum 메트릭 유지 (한글 대체 여부 미실측)
        assert!(
            (w("함초롬돋움", '가') - fs * 0.97).abs() < 0.05,
            "HCR '가' {}",
            w("함초롬돋움", '가')
        );
        // ㆍ(U+318D): 한컴 계열은 area_dot 폴백 대신 embedded 메트릭(1.0em) 신뢰
        assert!(area_dot_fallback_width("한컴돋움", fs, FontMetricsPolicy::HcrDeclared).is_none());
        assert!(area_dot_fallback_width("한컴바탕", fs, FontMetricsPolicy::HcrDeclared).is_none());
    }

    // ── #2430 한양·휴먼 HFT 실측 메트릭의 native/WASM 정합 보장 ──

    /// 한양 4종·휴먼명조의 ASCII 전 구간(0x20..=0x7E)이 embedded 메트릭으로
    /// 해소됨을 고정한다. WasmTextMeasurer 는 embedded 메트릭을 Canvas
    /// measureText 보다 우선하므로, 이 커버리지가 성립하는 한 원본 글꼴이
    /// 없는 Studio 환경(HY 대체 글리프 표시)에서도 줄바꿈·캐럿·선택 좌표를
    /// 결정하는 문자폭은 native(EmbeddedTextMeasurer)와 동일하다 — hybrid
    /// (HFT 실측 메트릭 + HY 대체 표시) 정책의 레이아웃 정합 근거.
    /// 회귀 시(원명 미해소 → Canvas 폴백) 브라우저 폰트에 따라 셀 재래핑
    /// 줄수가 native 와 갈라진다 (#2430 재래핑 오발동의 재발 형태).
    #[test]
    fn issue_2430_hft_faces_ascii_embedded_coverage() {
        let fs = 40.0 / 3.0; // 10pt = 13.333px
        for fam in [
            "한양신명조",
            "한양중고딕",
            "한양견명조",
            "한양견고딕",
            "휴먼명조",
        ] {
            for code in 0x20..=0x7Eu32 {
                let c = char::from_u32(code).unwrap();
                let w =
                    measure_char_width_embedded(fam, false, false, c, fs).unwrap_or_else(|| {
                        panic!("{fam} {c:?}: embedded 메트릭 미해소 — Canvas 폴백 회귀")
                    });
                assert!(w > 0.0, "{fam} {c:?}: 비정상 폭 {w}");
            }
        }
        // 실측 스팟 체크 (tools/task2430/measured/ ladder 실측 = 커밋 테이블):
        // 명조·중고딕 계열 숫자 0.497em, 견 계열 0.565em.
        let w = |fam: &str, c: char| measure_char_width_embedded(fam, false, false, c, fs).unwrap();
        assert!(
            (w("한양신명조", '0') - fs * 0.497).abs() < 0.05,
            "신명조 '0' {}",
            w("한양신명조", '0')
        );
        assert!(
            (w("휴먼명조", '0') - fs * 0.497).abs() < 0.05,
            "휴먼명조 '0' {}",
            w("휴먼명조", '0')
        );
        assert!(
            (w("한양견명조", '0') - fs * 0.565).abs() < 0.05,
            "견명조 '0' {}",
            w("한양견명조", '0')
        );
        assert!(
            (w("한양견고딕", '0') - fs * 0.565).abs() < 0.05,
            "견고딕 '0' {}",
            w("한양견고딕", '0')
        );
    }

    // ── MockTextMeasurer 테스트 ──

    #[test]
    fn test_mock_measurer_fixed_width() {
        let m = MockTextMeasurer { char_width: 10.0 };
        let style = TextStyle {
            font_size: 16.0,
            ..Default::default()
        };
        let w = m.estimate_text_width("ABC", &style);
        assert!((w - 30.0).abs() < 0.01, "expected 30.0, got {}", w);
    }

    #[test]
    fn test_mock_measurer_positions() {
        let m = MockTextMeasurer { char_width: 10.0 };
        let style = TextStyle {
            font_size: 16.0,
            ..Default::default()
        };
        let pos = m.compute_char_positions("AB", &style);
        assert_eq!(pos.len(), 3);
        assert!((pos[0]).abs() < 0.01);
        assert!((pos[1] - 10.0).abs() < 0.01);
        assert!((pos[2] - 20.0).abs() < 0.01);
    }

    #[test]
    fn test_mock_measurer_ratio() {
        let m = MockTextMeasurer { char_width: 10.0 };
        let style = TextStyle {
            font_size: 16.0,
            ratio: 0.5,
            ..Default::default()
        };
        let w = m.estimate_text_width("AB", &style);
        assert!(
            (w - 10.0).abs() < 0.01,
            "expected 10.0 (2*10*0.5), got {}",
            w
        );
    }

    #[test]
    fn test_mock_measurer_letter_spacing() {
        let m = MockTextMeasurer { char_width: 10.0 };
        let style = TextStyle {
            font_size: 16.0,
            letter_spacing: 2.0,
            ..Default::default()
        };
        let w = m.estimate_text_width("AB", &style);
        assert!(
            (w - 24.0).abs() < 0.01,
            "expected 24.0 (2*(10+2)), got {}",
            w
        );
    }

    #[test]
    fn glyph_positions_exclude_tracking_and_justification_spacing() {
        let base = TextStyle {
            font_family: "Arial".to_string(),
            font_size: 16.0,
            ratio: 0.8,
            ..Default::default()
        };
        let spaced = TextStyle {
            letter_spacing: 3.0,
            extra_char_spacing: 2.0,
            extra_word_spacing: 4.0,
            ..base.clone()
        };

        let base_glyphs = compute_glyph_positions("AV i", &base);
        let spaced_glyphs = compute_glyph_positions("AV i", &spaced);
        assert_eq!(base_glyphs, spaced_glyphs);

        let placement = compute_char_positions("AV i", &spaced);
        assert!(placement.last().unwrap() > spaced_glyphs.last().unwrap());
    }

    #[test]
    fn literal_line_characters_keep_glyph_advances_across_run_boundaries() {
        let style = TextStyle {
            font_family: "Arial".to_string(),
            font_size: 16.0,
            extra_dash_advance: 100.0,
            ..Default::default()
        };
        for (whole_text, scalar) in [("---", "-"), ("_____", "_")] {
            let whole = compute_char_positions(whole_text, &style);
            let single = compute_char_positions(scalar, &style);

            assert_eq!(whole.len(), whole_text.chars().count() + 1);
            for index in 1..whole.len() {
                assert!((whole[index] - whole[index - 1] - single[1]).abs() < 0.001);
            }
        }
    }

    #[test]
    fn test_mock_measurer_extra_word_spacing() {
        let m = MockTextMeasurer { char_width: 10.0 };
        let style = TextStyle {
            font_size: 16.0,
            extra_word_spacing: 5.0,
            ..Default::default()
        };
        // "A B" = A(10) + space(10+5) + B(10) = 35
        let w = m.estimate_text_width("A B", &style);
        assert!((w - 35.0).abs() < 0.01, "expected 35.0, got {}", w);
    }

    #[test]
    fn test_unicode_arrow_uses_symbol_advance() {
        let style = TextStyle {
            font_family: "KoPub돋움체 Light".to_string(),
            font_size: 10.0,
            ..Default::default()
        };

        let arrow = estimate_text_width("⇒", &style);
        let ascii = estimate_text_width("A", &style);
        assert!(
            arrow > ascii,
            "arrow should use symbol advance, arrow={arrow}, ascii={ascii}"
        );
    }

    #[test]
    fn test_mock_measurer_tab() {
        let m = MockTextMeasurer { char_width: 10.0 };
        let style = TextStyle {
            font_size: 16.0,
            ..Default::default()
        };
        // tab_w = font_size * 4 = 64, "\tA" → tab snaps to 64, then A at 74
        let pos = m.compute_char_positions("\tA", &style);
        assert_eq!(pos.len(), 3);
        assert!(
            (pos[1] - 64.0).abs() < 0.01,
            "tab should snap to 64, got {}",
            pos[1]
        );
        assert!(
            (pos[2] - 74.0).abs() < 0.01,
            "A should be at 74, got {}",
            pos[2]
        );
    }

    // ── EmbeddedTextMeasurer 테스트 ──

    #[test]
    fn test_embedded_measurer_latin_heuristic() {
        let m = EmbeddedTextMeasurer;
        let style = TextStyle {
            font_size: 16.0,
            ..Default::default()
        };
        // 기본 폰트("")는 내장 메트릭 없음 → 휴리스틱: Latin = font_size * 0.5
        let w = m.estimate_text_width("AB", &style);
        assert!(
            (w - 16.0).abs() < 0.01,
            "expected 16.0 (2*8.0 heuristic), got {}",
            w
        );
    }

    #[test]
    fn test_embedded_measurer_cjk_heuristic() {
        let m = EmbeddedTextMeasurer;
        let style = TextStyle {
            font_size: 16.0,
            ..Default::default()
        };
        // 기본 폰트("")는 내장 메트릭 없음 → 휴리스틱: CJK = font_size
        let w = m.estimate_text_width("가나", &style);
        assert!(
            (w - 32.0).abs() < 0.01,
            "expected 32.0 (2*16.0 heuristic), got {}",
            w
        );
    }

    #[test]
    fn test_kopub_dotum_hangul_full_width_substitution() {
        let m = EmbeddedTextMeasurer;
        let style = TextStyle {
            font_family: "KoPub돋움체 Light".to_string(),
            font_size: 14.0,
            ..Default::default()
        };

        // [#2195 stage57] KoPub 미설치 환경에서 한글이 바탕으로 치환되어 전각
        // 1.0em 렌더 (86712 한컴 PDF 글리프 실측: 12pt 한글 16px). 종전 0.84
        // 핀은 r27 근거설명 25문단 -11줄 과소의 성분이었다.
        // 14px = 10.5pt → floor(1050/4) = 262 배치 단위.
        let w = m.estimate_text_width("가나", &style);
        assert!((w - 2.0 * 262.0 * MAC_LAYOUT_UNIT_PX).abs() < 1e-9, "{w}");
    }

    #[test]
    fn test_embedded_measurer_known_font() {
        let m = EmbeddedTextMeasurer;
        let style = TextStyle {
            font_family: "함초롬돋움".to_string(),
            font_size: 16.0,
            ..Default::default()
        };
        // 내장 메트릭이 있는 폰트: Latin 문자는 CJK보다 좁아야 함
        let w = m.estimate_text_width("A", &style);
        assert!(
            w > 0.0 && w < 16.0,
            "Latin 'A' should be narrower than CJK, got {}",
            w
        );
    }

    #[test]
    fn test_embedded_matches_free_fn() {
        // 자유 함수 래퍼가 EmbeddedTextMeasurer로 위임하는지 확인
        let style = TextStyle {
            font_size: 16.0,
            ..Default::default()
        };
        let free_fn_result = estimate_text_width("ABC가나다", &style);
        let trait_result = EmbeddedTextMeasurer.estimate_text_width("ABC가나다", &style);
        assert!(
            (free_fn_result - trait_result).abs() < 0.01,
            "free fn ({}) != trait ({})",
            free_fn_result,
            trait_result,
        );
    }

    #[test]
    fn test_embedded_positions_match_free_fn() {
        let style = TextStyle {
            font_size: 16.0,
            ..Default::default()
        };
        let free_fn_result = compute_char_positions("ABC", &style);
        let trait_result = EmbeddedTextMeasurer.compute_char_positions("ABC", &style);
        assert_eq!(free_fn_result.len(), trait_result.len());
        for (a, b) in free_fn_result.iter().zip(trait_result.iter()) {
            assert!((a - b).abs() < 0.01, "position mismatch: {} != {}", a, b);
        }
    }

    #[test]
    fn test_inline_object_placeholder_has_zero_advance() {
        let style = TextStyle {
            font_family: "Haansoft Dotum".to_string(),
            font_size: 12.0,
            ..Default::default()
        };

        assert_eq!(estimate_text_width("\u{FFFC}", &style), 0.0);
        assert_eq!(
            estimate_text_width("\u{FFFC}\u{FFFC}A", &style),
            estimate_text_width("A", &style),
            "U+FFFC placeholder 는 실제 TAC 노드가 따로 폭을 차지하므로 텍스트 폭에 더하면 안 됨"
        );

        let positions = compute_char_positions("\u{FFFC}A", &style);
        assert_eq!(positions[0], positions[1]);
        assert!(positions[2] > positions[1]);
    }

    #[test]
    fn hwp_hyphen_advances_like_a_hyphen_minus() {
        // 한컴(macOS)은 U+00AD(HWP 코드 24)를 글꼴의 '-' 글리프·폭으로 그린다.
        let style = TextStyle {
            font_family: "맑은 고딕".to_string(),
            font_size: 13.3,
            ..Default::default()
        };
        assert_eq!(
            estimate_text_width("A\u{00AD}B", &style),
            estimate_text_width("A-B", &style)
        );
    }

    // ── 오버플로우 압축 회귀 테스트 (Task #229) ──

    /// 오버플로우 압축(음수 extra_char_spacing)은 좁은 글자에도 그대로 빠진다.
    /// 한컴(macOS)은 `.` advance 가 음수가 되어도 클램프하지 않는다
    /// (fdi-press 압축 셀 `(△433.6)` 의 `.` 뒤 `6` 이 앞쪽에 놓임).
    #[test]
    fn test_overflow_compression_is_uniform_per_char() {
        let m = EmbeddedTextMeasurer;
        let natural = TextStyle {
            font_family: "맑은 고딕".to_string(),
            font_size: 12.0,
            ratio: 1.0,
            ..Default::default()
        };
        let squeezed = TextStyle {
            extra_char_spacing: -2.88,
            ..natural.clone()
        };
        let a = m.compute_char_positions("526.278", &natural);
        let b = m.compute_char_positions("526.278", &squeezed);
        for i in 1..a.len() {
            let shrink = (a[i] - a[i - 1]) - (b[i] - b[i - 1]);
            assert!((shrink - 2.88).abs() < 1e-6, "{i}: {a:?} vs {b:?}");
        }
    }

    #[test]
    fn fixed_width_spaces_keep_authored_tracking_under_overflow_compression() {
        let measurer = EmbeddedTextMeasurer;
        let natural = TextStyle {
            font_family: "맑은 고딕".into(),
            font_size: 16.0,
            ratio: 0.95,
            letter_spacing: -0.64,
            ..Default::default()
        };
        let compressed = TextStyle {
            extra_char_spacing: -2.0,
            ..natural.clone()
        };
        let text = "가\u{2007}나";
        let a = measurer.compute_char_positions(text, &natural);
        let b = measurer.compute_char_positions(text, &compressed);
        assert!(((a[1] - a[0]) - (b[1] - b[0]) - 2.0).abs() < 1e-6);
        assert!(((a[2] - a[1]) - (b[2] - b[1])).abs() < 1e-6);
        assert!(
            (measurer.estimate_text_width("\u{2007}", &compressed) - (a[2] - a[1])).abs() < 1e-6
        );
        assert!(
            (estimate_text_width_unrounded("\u{2007}", &compressed) - (a[2] - a[1])).abs() < 1e-6
        );
    }

    /// 실제 문서 재현 케이스: 압축은 CharShape 의 `letter_spacing` 을 통해 오며
    /// `extra_char_spacing` 은 0 일 수 있다. 가드 조건은 둘의 합이어야 한다.
    #[test]
    fn test_charshape_negative_letter_spacing_no_reverse() {
        let m = EmbeddedTextMeasurer;
        let style = TextStyle {
            font_family: "맑은 고딕".to_string(),
            font_size: 12.0,
            ratio: 1.0,
            letter_spacing: -2.88,
            extra_char_spacing: 0.0,
            ..Default::default()
        };
        let positions = m.compute_char_positions("65,063,026,600", &style);
        for win in positions.windows(2) {
            assert!(
                win[1] >= win[0] - 1e-6,
                "positions must be non-decreasing: {:?}",
                positions
            );
        }
    }

    /// extra_char_spacing == 0 (비-압축) 경로는 클램프의 영향을 받지 않아야 한다.
    /// 21a02ec 이후의 동작과 동일해야 함.
    #[test]
    fn test_non_compression_width_unchanged_by_fix() {
        let m = EmbeddedTextMeasurer;
        let style_a = TextStyle {
            font_family: "맑은 고딕".to_string(),
            font_size: 12.0,
            ratio: 1.0,
            ..Default::default()
        };
        let w = m.estimate_text_width("65,063,026,600", &style_a);
        assert!(
            w > 50.0 && w < 200.0,
            "sanity: non-compression width reasonable, got {}",
            w
        );
    }

    // ── build_cluster_len 테스트 ──

    #[test]
    fn test_build_cluster_len_basic() {
        let chars: Vec<char> = "ABC".chars().collect();
        let cl = build_cluster_len(&chars);
        assert_eq!(cl, vec![1, 1, 1]);
    }

    #[test]
    fn test_build_cluster_len_hangul_jamo() {
        // 초성(ㄱ U+1100) + 중성(ㅏ U+1161) + 종성(ㄴ U+11AB) = 3자 1클러스터
        let chars: Vec<char> = "\u{1100}\u{1161}\u{11AB}".chars().collect();
        let cl = build_cluster_len(&chars);
        assert_eq!(cl, vec![3, 0, 0]);
    }

    #[test]
    fn test_build_cluster_len_mixed() {
        // "A" + 초성+중성 + "B"
        let chars: Vec<char> = "A\u{1100}\u{1161}B".chars().collect();
        let cl = build_cluster_len(&chars);
        assert_eq!(cl, vec![1, 2, 0, 1]);
    }

    #[test]
    fn unicode_grapheme_positions_keep_combining_sequence_atomic() {
        let style = TextStyle {
            font_family: "Noto Sans KR".to_string(),
            font_size: 20.0,
            ..Default::default()
        };
        let positions = EmbeddedTextMeasurer.compute_char_positions("e\u{301}x", &style);
        assert_eq!(positions.len(), 4);
        assert_eq!(positions[0], positions[1]);
        assert!(positions[2] > positions[1]);
        assert!(positions[3] > positions[2]);
        assert_eq!(
            estimate_text_width_unrounded("e\u{301}x", &style),
            *positions.last().unwrap()
        );
    }

    #[test]
    fn mac_missing_serif_substitution_respects_available_and_requested_faces() {
        let bytes: std::sync::Arc<[u8]> = std::sync::Arc::from(
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/fonts/RHWPShapingFixture.ttf"
            ))
            .as_slice(),
        );
        let face = |family: &str| ResolvedShapingFont {
            family: family.to_string(),
            bytes: bytes.clone(),
            face_index: 0,
        };
        let width = |family: &str, policy| {
            measure_char_width_with_policy(family, false, false, '한', 20.0, policy).unwrap()
        };
        let mac = FontMetricsPolicy::HcrDeclared;
        let windows = FontMetricsPolicy::HancomWindows;
        let hcr = width("함초롬바탕", mac);
        let haansoft = width("한컴바탕", mac);
        let unavailable = width("HY신명조", mac);
        let legacy = width("HY신명조", windows);
        {
            let _scope = enter_resolved_shaping_fonts(vec![face("한컴바탕")]);
            assert_eq!(width("HY신명조", mac), haansoft);
        }
        {
            let _scope = enter_resolved_shaping_fonts(vec![face("함초롬바탕"), face("한컴바탕")]);
            for family in ["HY신명조", "한양신명조"] {
                assert_eq!(width(family, mac), hcr);
                assert_eq!(
                    measure_char_width_with_policy(family, false, false, ' ', 20.0, mac),
                    Some(10.0)
                );
            }
            assert_eq!(width("HY신명조", windows), legacy);
        }
        {
            let _scope = enter_resolved_shaping_fonts(vec![face("HY신명조"), face("함초롬바탕")]);
            let actual = quantize_hwp_px(
                custom_face_char_em_advance("HY신명조", false, false, '한').unwrap() * 20.0,
            );
            assert_eq!(width("HY신명조", mac), actual);
        }
        assert_eq!(width("HY신명조", mac), unavailable);
    }

    #[test]
    fn embedded_shaping_scope_uses_face_advances_and_restores_after_panic() {
        let bytes = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/fonts/RHWPShapingFixture.ttf"
        ));
        let font = ResolvedShapingFont {
            family: "RHWP Shaping Fixture".to_string(),
            bytes: std::sync::Arc::from(bytes.as_slice()),
            face_index: 0,
        };
        let style = TextStyle {
            font_family: font.family.clone(),
            font_size: 20.0,
            kerning: true,
            ..Default::default()
        };
        assert!(shaped_char_positions("AV", &style).is_none());

        let unwind = std::panic::catch_unwind(|| {
            let _scope = enter_resolved_shaping_fonts(vec![font]);
            let positions =
                shaped_char_positions("AV", &style).expect("embedded face should shape");
            assert_eq!(positions.len(), 3);
            assert!(positions[1] > positions[0]);
            assert!(positions[2] > positions[1]);
            let accent = shaped_char_positions("e\u{301}", &style).unwrap();
            assert_eq!(accent[0], accent[1]);
            assert!(accent[2] > accent[1]);
            let mixed = shaped_char_positions("A한V", &style).unwrap();
            assert!(mixed.windows(2).all(|pair| pair[1] > pair[0]));
            panic!("exercise scope restoration");
        });
        assert!(unwind.is_err());
        assert!(shaped_char_positions("AV", &style).is_none());
    }

    #[test]
    fn embedded_metrics_make_kerning_layout_neutral_on_all_targets() {
        let base = TextStyle {
            font_family: "Noto Sans KR".to_string(),
            font_size: 48.0,
            kerning: false,
            ..Default::default()
        };
        let kerned = TextStyle {
            kerning: true,
            ..base.clone()
        };
        let plain_width = estimate_text_width_unrounded("AV", &base);
        let kerned_width = estimate_text_width_unrounded("AV", &kerned);
        let kerned_positions = EmbeddedTextMeasurer.compute_char_positions("AV", &kerned);

        assert_eq!(kerned_width, plain_width);
        assert!((kerned_width - kerned_positions[2]).abs() < 1e-9);
        // 기본(macOS) 정책은 run 폭을 반올림하지 않는다.
        assert!(
            (kerned_width - EmbeddedTextMeasurer.estimate_text_width("AV", &kerned)).abs() < 1e-9
        );
    }

    #[test]
    fn calibrated_width_is_the_layout_authority() {
        let style = TextStyle {
            font_family: "Noto Sans KR".to_string(),
            font_size: 40.0 / 3.0,
            ..Default::default()
        };
        let expected: f64 = "Noto"
            .chars()
            .map(|c| {
                let base = measure_glyph_base_px(
                    &style.font_family,
                    style.bold,
                    style.italic,
                    c,
                    style.font_size,
                    style.font_metrics_policy,
                )
                .expect("Noto Sans KR ASCII must be calibrated");
                scaled_glyph_advance(base, c, &style, style.font_size, 1.0)
            })
            .sum();

        assert_eq!(estimate_text_width_unrounded("Noto", &style), expected);
        assert_eq!(
            *EmbeddedTextMeasurer
                .compute_char_positions("Noto", &style)
                .last()
                .unwrap(),
            expected
        );
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn ordinary_width_is_cwd_independent() {
        const PROBE_ENV: &str = "RHWP_TEXT_METRIC_CWD_PROBE";
        const PROBE_PREFIX: &str = "RHWP_TEXT_METRIC_WIDTH=";
        if std::env::var_os(PROBE_ENV).is_some() {
            let style = TextStyle {
                font_family: "Noto Sans KR".to_string(),
                font_size: 40.0 / 3.0,
                ..Default::default()
            };
            println!(
                "{PROBE_PREFIX}{:.17}",
                estimate_text_width_unrounded("Noto AV 가나다", &style)
            );
            return;
        }

        let test_exe = std::env::current_exe().expect("current test executable");
        let crate_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let repo_dir = crate_dir.parent().expect("repository root");
        let measure_from = |cwd: &std::path::Path| {
            let output = std::process::Command::new(&test_exe)
                .args([
                    "--exact",
                    "renderer::layout::text_measurement::tests::ordinary_width_is_cwd_independent",
                    "--nocapture",
                ])
                .current_dir(cwd)
                .env(PROBE_ENV, "1")
                .output()
                .unwrap_or_else(|error| panic!("run metric probe from {}: {error}", cwd.display()));
            assert!(
                output.status.success(),
                "metric probe failed from {}: {}",
                cwd.display(),
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .find_map(|line| line.strip_prefix(PROBE_PREFIX))
                .unwrap_or_else(|| panic!("metric probe output missing from {}", cwd.display()))
                .parse::<f64>()
                .expect("metric probe width")
        };

        assert_eq!(measure_from(repo_dir), measure_from(crate_dir));
    }

    #[test]
    fn calibrated_metrics_respect_sub_twelve_pixel_font_sizes() {
        let small = TextStyle {
            font_family: "Noto Sans KR".to_string(),
            font_size: 8.0,
            ..Default::default()
        };
        let large = TextStyle {
            font_size: 16.0,
            ..small.clone()
        };
        let small_width = estimate_text_width_unrounded("가", &small);
        let large_width = estimate_text_width_unrounded("가", &large);

        assert!(small_width < 12.0, "8px text was clamped: {small_width}");
        assert!(
            (small_width * 2.0 - large_width).abs() <= 1.0 / 75.0,
            "embedded advance must scale with the requested size: small={small_width}, large={large_width}"
        );
    }

    #[test]
    fn extended_grapheme_positions_are_atomic_without_native_fonts() {
        let style = TextStyle {
            font_family: UNREGISTERED_FONT.to_string(),
            font_metrics_policy: FontMetricsPolicy::HancomWindows,
            font_size: 20.0,
            ..Default::default()
        };
        let text = "\u{1F469}\u{200D}\u{1F4BB}x";
        let positions = EmbeddedTextMeasurer.compute_char_positions(text, &style);

        assert_eq!(positions.len(), text.chars().count() + 1);
        assert_eq!(&positions[..3], &[0.0, 0.0, 0.0]);
        assert!(positions[3] > positions[2]);
        assert!(positions[4] > positions[3]);
        assert_eq!(
            *positions.last().unwrap(),
            estimate_text_width_unrounded(text, &style)
        );
    }

    // ── narrow glyph advance 회귀 (Task #257) ──
    //
    // `is_narrow_punctuation` 폴백 분기 검증. 메트릭 DB 및 `resolve_metric_alias`
    // 양쪽 모두에 등록되지 않은 이름을 사용해야 폴백 경로가 실제로 실행된다.
    // (과거엔 "HY헤드라인M" 을 사용했으나 Task #259 에서 alias 등록되며 폴백이
    // 우회됨 → 임의의 미등록 이름으로 교체.)
    const UNREGISTERED_FONT: &str = "__rhwp_test_unregistered_font__";

    #[test]
    fn test_narrow_glyph_comma_base_width() {
        let m = EmbeddedTextMeasurer;
        let style = TextStyle {
            font_family: UNREGISTERED_FONT.to_string(),
            font_metrics_policy: FontMetricsPolicy::HancomWindows,
            font_size: 13.333,
            ratio: 1.0,
            ..Default::default()
        };
        // positions of "A,B": A at 0, , at A-advance, B at A-advance + ,-advance
        let positions = m.compute_char_positions("A,B", &style);
        let comma_advance = positions[2] - positions[1];
        assert!(
            comma_advance <= style.font_size * 0.35,
            "narrow comma advance should be ≤ font_size * 0.35 ({:.2}), got {:.2}",
            style.font_size * 0.35,
            comma_advance
        );
    }

    #[test]
    fn test_narrow_glyph_middle_dot_base_width() {
        let m = EmbeddedTextMeasurer;
        let style = TextStyle {
            font_family: UNREGISTERED_FONT.to_string(),
            font_metrics_policy: FontMetricsPolicy::HancomWindows,
            font_size: 16.667,
            ratio: 1.0,
            ..Default::default()
        };
        let positions = m.compute_char_positions("가\u{00B7}나", &style);
        let dot_advance = positions[2] - positions[1];
        assert!(
            dot_advance <= style.font_size * 0.35,
            "narrow middle-dot advance should be ≤ font_size * 0.35 ({:.2}), got {:.2}",
            style.font_size * 0.35,
            dot_advance
        );
    }

    /// [#2239] 괄호 narrow(0.3em)는 사다리 실측 폰트(휴먼명조/한양중고딕) 한정.
    /// 미실측(미등록) 폰트의 괄호는 0.5em 폴백 유지 — HY신명조·바탕 계열
    /// 0.5em(#2156 ASCII 폭 표) 회귀 방지.
    #[test]
    fn test_paren_narrow_is_font_conditioned() {
        let m = EmbeddedTextMeasurer;
        // 미등록·미실측 폰트: 괄호는 0.5em 폴백.
        let style = TextStyle {
            font_family: UNREGISTERED_FONT.to_string(),
            font_metrics_policy: FontMetricsPolicy::HancomWindows,
            font_size: 13.333,
            ratio: 1.0,
            ..Default::default()
        };
        let positions = m.compute_char_positions("A(B", &style);
        let advance = positions[2] - positions[1];
        assert!(
            (advance - style.font_size * 0.5).abs() < 0.5,
            "미실측 폰트 '(' 는 0.5em 폴백이어야 함, got {:.2}",
            advance
        );
        // 한양중고딕(사다리 실측 '(' <= 0.29em): narrow 0.3em.
        let style_hy = TextStyle {
            font_family: "한양중고딕".to_string(),
            font_size: 13.333,
            ratio: 1.0,
            ..Default::default()
        };
        let positions_hy = m.compute_char_positions("A(B", &style_hy);
        let advance_hy = positions_hy[2] - positions_hy[1];
        assert!(
            advance_hy <= style_hy.font_size * 0.45,
            "한양중고딕 '(' 는 narrow(≤0.45em)여야 함, got {:.2}",
            advance_hy
        );
    }

    /// [Task #1735] 방점 U+302E/U+302F 는 앞 음절의 combining mark다. 별도 caret이나
    /// advance를 만들지 않고 음절과 원자적으로 이동해야 한다.
    #[test]
    fn test_narrow_glyph_tone_marks() {
        let m = EmbeddedTextMeasurer;
        let style = TextStyle {
            font_family: UNREGISTERED_FONT.to_string(),
            font_metrics_policy: FontMetricsPolicy::HancomWindows,
            font_size: 16.667,
            ratio: 1.0,
            ..Default::default()
        };
        for text in &["가\u{302E}나", "가\u{302F}나"] {
            let positions = m.compute_char_positions(text, &style);
            assert_eq!(positions[0], positions[1], "caret split in {text:?}");
            assert!(positions[2] > positions[1]);
            assert_eq!(
                estimate_text_width_unrounded(text, &style),
                estimate_text_width_unrounded("가나", &style),
                "combining tone mark must not add layout width for {text:?}"
            );
        }
    }

    #[test]
    fn test_narrow_glyph_period_and_colon() {
        let m = EmbeddedTextMeasurer;
        let style = TextStyle {
            font_family: UNREGISTERED_FONT.to_string(),
            font_metrics_policy: FontMetricsPolicy::HancomWindows,
            font_size: 13.333,
            ratio: 1.0,
            ..Default::default()
        };
        for (ch, text) in &[('.', "A.B"), (':', "A:B")] {
            let positions = m.compute_char_positions(text, &style);
            let advance = positions[2] - positions[1];
            assert!(
                advance <= style.font_size * 0.35,
                "narrow '{}' advance should be ≤ font_size * 0.35 ({:.2}), got {:.2}",
                ch,
                style.font_size * 0.35,
                advance
            );
        }
    }

    #[test]
    fn test_non_narrow_char_unchanged() {
        // 회귀 방어: 영문 'A'·한글 '가' 는 narrow 분기에 해당하지 않아야 한다.
        let m = EmbeddedTextMeasurer;
        let style = TextStyle {
            font_family: UNREGISTERED_FONT.to_string(),
            font_metrics_policy: FontMetricsPolicy::HancomWindows,
            font_size: 13.333,
            ratio: 1.0,
            ..Default::default()
        };
        // 'A' = Latin 반각 = font_size * 0.5 ≈ 6.67 유지
        let pos_a = m.compute_char_positions("AA", &style);
        let a_advance = pos_a[1] - pos_a[0];
        assert!(
            (a_advance - style.font_size * 0.5).abs() < 0.1,
            "Latin 'A' advance should remain font_size * 0.5 ({:.2}), got {:.2}",
            style.font_size * 0.5,
            a_advance
        );
        // '가' = CJK 전각 = font_size 유지
        let pos_k = m.compute_char_positions("가가", &style);
        let k_advance = pos_k[1] - pos_k[0];
        assert!(
            (k_advance - style.font_size).abs() < 0.1,
            "CJK '가' advance should remain font_size ({:.2}), got {:.2}",
            style.font_size,
            k_advance
        );
    }

    /// Issue #630: 등록된 한글 폰트(돋움체)에서 `·`(U+00B7) 가 전각으로 측정되어야
    /// 한컴 저장본 의 tab_extended 와 정합. `is_halfwidth_punct` 의 강제 반각
    /// 처리는 한컴 측정값과 8.67px(반각 1자) 차이 유발.
    #[test]
    fn test_630_middle_dot_full_width_in_registered_font() {
        let m = EmbeddedTextMeasurer;
        let style = TextStyle {
            font_family: "돋움체".to_string(),
            font_size: 17.333,
            ratio: 1.0,
            ..Default::default()
        };
        let positions = m.compute_char_positions("가\u{00B7}나", &style);
        assert!(positions.len() >= 3, "positions should have ≥ 3 entries");
        let dot_advance = positions[2] - positions[1];

        // 전각 = font_size (≈17.33px). 정정 전: 반각 (≈8.67px).
        // HWPUNIT 양자화 + 폰트 메트릭 미세 차이 허용 ±1.5px.
        let expected = style.font_size;
        assert!(
            (dot_advance - expected).abs() < 1.5,
            "DotumChe 의 `·` (U+00B7) advance 가 전각 (={:.2}) 으로 측정되어야 함, got {:.2}\n\
             정정 전: 반각 (≈{:.2}). is_halfwidth_punct 가 U+00B7 강제 반각 처리 (Issue #630).",
            expected,
            dot_advance,
            expected / 2.0
        );
    }

    /// [macOS 정합] 한컴(macOS)은 「 를 선언 face 의 기록 전각 폭으로 조판한다 —
    /// 공식 PDF 실측 「→다음 글자 0.82–1.00em (35-voucher '「곡성군'
    /// 10.6pt@11.04pt, 38-cheongyang '「전자정부법」' 「=」=9.0pt@9.0pt,
    /// 모두 돋움체 계열 선언). 반각 강제는 HancomWindows 규약에만 적용된다.
    #[test]
    fn test_2020_corner_quote_fullwidth_in_registered_font() {
        let m = EmbeddedTextMeasurer;
        let style = TextStyle {
            font_family: "돋움체".to_string(),
            font_size: 13.333,
            ratio: 1.0,
            ..Default::default()
        };

        let positions = m.compute_char_positions("「여", &style);
        let quote_advance = positions[1] - positions[0];
        let hangul_advance = positions[2] - positions[1];

        assert!(
            quote_advance >= style.font_size * 0.9,
            "`「` 는 등록 폰트에서도 전각 advance 로 측정되어야 함. got {:.2}",
            quote_advance
        );
        assert!(
            hangul_advance >= style.font_size * 0.9,
            "뒤따르는 한글은 전각 advance 를 유지해야 함. got {:.2}",
            hangul_advance
        );
    }

    /// [U+00B7 .notdef 위장값 정정] 비례폰트(휴먼명조)에서 `·`(U+00B7) 글리프
    /// 부재로 cmap 이 .notdef(em_size) 로 위장 → 전각 측정되던 것을 narrow 로
    /// 정정한다. 한컴은 점 글리프를 가진 대체 폰트(바탕 ≈0.33em)로 `·` 를
    /// 렌더하므로 한컴 PDF 정합. 고정폭 폰트(돋움체)는 영향 없음 —
    /// test_630_middle_dot_full_width_in_registered_font 가 전각 보존을 가드.
    #[test]
    fn test_b7_notdef_artifact_narrow_in_proportional_font() {
        let m = EmbeddedTextMeasurer;
        let style = TextStyle {
            font_family: "휴먼명조".to_string(),
            font_size: 20.0,
            ratio: 1.0,
            ..Default::default()
        };
        let positions = m.compute_char_positions("가\u{00B7}나", &style);
        assert!(positions.len() >= 3, "positions should have ≥ 3 entries");
        let dot_advance = positions[2] - positions[1];
        // 비례폰트의 .notdef 위장 전각(≈20px) 이 아니라 narrow(0.3em ≈ 6px) 여야 함.
        assert!(
            dot_advance <= style.font_size * 0.4,
            "휴먼명조의 `·` (U+00B7) 는 .notdef 위장 전각이 아니라 narrow \
             (≤ font_size * 0.4 = {:.2}) 로 측정되어야 함, got {:.2}",
            style.font_size * 0.4,
            dot_advance
        );
    }

    fn quote_advances_em(font_family: &str, font_size: f64) -> (f64, f64) {
        let m = EmbeddedTextMeasurer;
        let style = TextStyle {
            font_family: font_family.to_string(),
            font_size,
            ratio: 1.0,
            ..Default::default()
        };
        let positions = m.compute_char_positions("\u{2018}가\u{2019}", &style);
        assert_eq!(
            positions.len(),
            4,
            "{font_family} 따옴표 클러스터 경계가 4개여야 함, got {:?}",
            positions
        );
        (
            (positions[1] - positions[0]) / font_size,
            (positions[3] - positions[2]) / font_size,
        )
    }

    #[test]
    fn test_7092_monospace_quotes_advance_full_width() {
        for family in ["굴림체", "돋움체", "바탕체"] {
            let (left, right) = quote_advances_em(family, 20.0);
            assert!(
                left >= 0.9 && right >= 0.9,
                "{family} 따옴표는 정본대로 전각이어야 한다(수정 전 0.300). \
                 ‘={left:.4}em ’={right:.4}em"
            );
        }
    }

    #[test]
    fn test_7092_proportional_quotes_keep_narrow_width() {
        let (left, right) = quote_advances_em("휴먼명조", 20.0);
        assert!(
            left <= 0.4 && right <= 0.4,
            "휴먼명조 따옴표는 이 변경의 범위 밖이라 종전 0.300 em 이어야 한다. \
             ‘={left:.4}em ’={right:.4}em"
        );
    }

    // ── 런타임 폰트 메트릭 (사용자 설치 폰트) ──

    #[test]
    fn registered_actual_face_replaces_covered_baked_width_only_in_mac_policy() {
        use crate::renderer::runtime_font_metrics as runtime;
        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/ttfs/opensource/NotoSansKR-Regular.ttf"
        ))
        .unwrap();
        let face = ttf_parser::Face::parse(&bytes, 0).unwrap();
        let family = "Noto Sans KR";
        assert!(face
            .names()
            .into_iter()
            .any(|name| { name.to_string().as_deref() == Some(family) }));
        let size = 24.0;
        let baked = font_metrics_data::find_metric(family, false, false).unwrap();
        let (character, actual) = ('!'..='~')
            .find_map(|character| {
                let glyph = face.glyph_index(character)?;
                let actual = quantize_hwp_px(
                    f64::from(face.glyph_hor_advance(glyph)?) * size
                        / f64::from(face.units_per_em()),
                );
                let old = quantize_hwp_px(
                    f64::from(baked.metric.get_width(character)?) * size
                        / f64::from(baked.metric.em_size),
                );
                ((actual - old).abs() > 0.02).then_some((character, actual))
            })
            .expect("가져온 face와 내장 face의 advance가 다른 글자");
        let measure = |policy, character| {
            measure_char_width_with_policy(family, false, false, character, size, policy)
        };
        runtime::clear();
        let old_mac = measure(FontMetricsPolicy::HcrDeclared, character);
        let old_windows = measure(FontMetricsPolicy::HancomWindows, character);
        runtime::register(&bytes, &[family.to_owned()], false, false).unwrap();
        assert_eq!(
            measure(FontMetricsPolicy::HcrDeclared, character),
            Some(actual)
        );
        assert_ne!(Some(actual), old_mac);
        assert_eq!(
            measure(FontMetricsPolicy::HancomWindows, character),
            old_windows
        );
        assert_eq!(
            measure(FontMetricsPolicy::HcrDeclared, ' '),
            Some(size / 2.0)
        );
        runtime::clear();
        assert_eq!(measure(FontMetricsPolicy::HcrDeclared, character), old_mac);
    }

    #[test]
    fn registered_substitute_metrics_preserve_requested_face_precedence() {
        use crate::renderer::runtime_font_metrics as runtime;
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/ttfs/opensource/");
        let regular = std::fs::read(format!("{dir}NotoSansKR-Regular.ttf")).unwrap();
        let light = std::fs::read(format!("{dir}NotoSansKR-ExtraLight.ttf")).unwrap();
        let size = 24.0;
        let actual = |bytes: &[u8], c: char| {
            let face = ttf_parser::Face::parse(bytes, 0).unwrap();
            let glyph = face.glyph_index(c).unwrap();
            quantize_hwp_px(
                f64::from(face.glyph_hor_advance(glyph).unwrap()) * size
                    / f64::from(face.units_per_em()),
            )
        };
        let measure =
            |policy, c| measure_char_width_with_policy("바탕", false, false, c, size, policy);
        runtime::clear();
        let legacy = measure(FontMetricsPolicy::HcrDeclared, 'W');
        let windows = measure(FontMetricsPolicy::HancomWindows, 'W');
        // 공개 fixture의 등록 별칭은 caller가 제공하는 정상 registry 입력이다.
        // 실제 한컴 face의 별칭/바이트는 별도 native/브라우저 비교로 검증한다.
        runtime::register(&regular, &["한컴바탕".to_owned()], false, false).unwrap();
        assert_eq!(
            measure(FontMetricsPolicy::HcrDeclared, 'W'),
            Some(actual(&regular, 'W'))
        );
        assert_ne!(legacy, Some(actual(&regular, 'W')));
        assert_eq!(measure(FontMetricsPolicy::HancomWindows, 'W'), windows);
        runtime::register(&light, &["바탕".to_owned()], false, false).unwrap();
        assert_ne!(actual(&regular, 'W'), actual(&light, 'W'));
        assert_eq!(
            measure(FontMetricsPolicy::HcrDeclared, 'W'),
            Some(actual(&light, 'W'))
        );
        // glyph 부재를 face 부재로 해석하지 않는다.
        assert!(runtime::has_face("바탕", false, false));
        assert!(runtime::char_advance("바탕", false, false, '\u{10ffff}').is_none());
        runtime::clear();
        runtime::register(&light, &["바탕".to_owned()], false, false).unwrap();
        assert!(runtime::char_advance("바탕", false, false, '™').is_none());
        assert_eq!(measure(FontMetricsPolicy::HcrDeclared, '™'), None);
        runtime::register(&regular, &["한컴바탕".to_owned()], false, false).unwrap();
        assert!(runtime::char_advance("한컴바탕", false, false, '™').is_some());
        assert_eq!(
            measure(FontMetricsPolicy::HcrDeclared, '™'),
            Some(actual(&regular, '™'))
        );
        // 누락 글자의 generic 폴백이 생겨도 원본에 있는 글자는 원본 face를 유지한다.
        assert_eq!(
            measure(FontMetricsPolicy::HcrDeclared, 'W'),
            Some(actual(&light, 'W'))
        );
        runtime::clear();
        assert_eq!(measure(FontMetricsPolicy::HcrDeclared, 'W'), legacy);
    }

    #[test]
    fn registered_quote_advances_follow_font_records() {
        use crate::renderer::runtime_font_metrics as runtime;
        let mut bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/ttfs/opensource/NotoSansKR-Regular.ttf"
        ))
        .unwrap();
        let face = ttf_parser::Face::parse(&bytes, 0).unwrap();
        let em = face.units_per_em();
        let glyphs = ['“', '”'].map(|c| face.glyph_index(c).unwrap().0);
        let metrics_count = face.tables().hhea.number_of_metrics;
        let table_count = u16::from_be_bytes(bytes[4..6].try_into().unwrap());
        let hmtx = (0..usize::from(table_count))
            .map(|index| 12 + 16 * index)
            .find(|&offset| &bytes[offset..offset + 4] == b"hmtx")
            .unwrap();
        let hmtx_offset = usize::try_from(u32::from_be_bytes(
            bytes[hmtx + 8..hmtx + 12].try_into().unwrap(),
        ))
        .unwrap();
        // 공개 fixture의 advance 레코드만 바꾸고 일반 face 등록으로 다시 읽는다.
        for glyph in glyphs {
            let offset = hmtx_offset + usize::from(glyph.min(metrics_count - 1)) * 4;
            bytes[offset..offset + 2].copy_from_slice(&em.to_be_bytes());
        }
        // 기존 quote glyph에 Unicode 낫표를 연결하는 작은 fixture cmap을 덧붙인다.
        // glyph 자체와 UPEM에서 유도한 hmtx 외의 폰트 데이터는 변경하지 않는다.
        let mappings = [
            ('‘', glyphs[0]),
            ('’', glyphs[1]),
            ('“', glyphs[0]),
            ('”', glyphs[1]),
            ('「', glyphs[0]),
            ('」', glyphs[1]),
        ];
        let cmap = (0..usize::from(table_count))
            .map(|index| 12 + 16 * index)
            .find(|&offset| &bytes[offset..offset + 4] == b"cmap")
            .unwrap();
        let mut replacement = Vec::new();
        for value in [0u16, 1, 0, 4] {
            replacement.extend_from_slice(&value.to_be_bytes());
        }
        replacement.extend_from_slice(&12u32.to_be_bytes());
        replacement.extend_from_slice(&12u16.to_be_bytes());
        replacement.extend_from_slice(&0u16.to_be_bytes());
        for value in [16 + 12 * mappings.len() as u32, 0, mappings.len() as u32] {
            replacement.extend_from_slice(&value.to_be_bytes());
        }
        for (character, glyph) in mappings {
            replacement.extend_from_slice(&u32::from(character).to_be_bytes());
            replacement.extend_from_slice(&u32::from(character).to_be_bytes());
            replacement.extend_from_slice(&u32::from(glyph).to_be_bytes());
        }
        let offset = u32::try_from(bytes.len()).unwrap();
        let length = u32::try_from(replacement.len()).unwrap();
        bytes[cmap + 8..cmap + 12].copy_from_slice(&offset.to_be_bytes());
        bytes[cmap + 12..cmap + 16].copy_from_slice(&length.to_be_bytes());
        bytes.extend_from_slice(&replacement);
        let family = "Noto Sans KR";
        let size = 24.0;
        let measure =
            |policy, c| measure_char_width_with_policy(family, false, false, c, size, policy);
        runtime::clear();
        let windows = ['“', '”'].map(|c| measure(FontMetricsPolicy::HancomWindows, c));
        let unregistered =
            ['“', '”', '「', '」'].map(|c| measure(FontMetricsPolicy::HcrDeclared, c));
        runtime::register(&bytes, &[family.to_owned()], false, false).unwrap();
        for (index, c) in ['“', '”', '「', '」'].into_iter().enumerate() {
            assert_eq!(measure(FontMetricsPolicy::HcrDeclared, c), Some(size));
            if index < windows.len() {
                assert_eq!(measure(FontMetricsPolicy::HancomWindows, c), windows[index]);
            }
        }
        for c in ['‘', '’'] {
            assert_eq!(measure(FontMetricsPolicy::HcrDeclared, c), Some(size / 2.0));
        }
        runtime::clear();
        for (index, c) in ['“', '”', '「', '」'].into_iter().enumerate() {
            assert_eq!(
                measure(FontMetricsPolicy::HcrDeclared, c),
                unregistered[index]
            );
        }
    }

    #[test]
    fn registered_full_em_double_quotes_preserve_face_advances_only_in_mac_policy() {
        use crate::renderer::runtime_font_metrics as runtime;
        let path = std::path::Path::new(
            "/Applications/Hancom Office HWP.app/Contents/Resources/Hnc/Shared/TTF/Hwp/HMKMM.TTF",
        );
        let Ok(bytes) = std::fs::read(path) else {
            // 선택적 한컴 폰트 설치를 요구하지 않는 환경은 기존 공개 face 테스트로 검증한다.
            return;
        };
        let face = ttf_parser::Face::parse(&bytes, 0).unwrap();
        let family = "휴먼명조";
        let size = 24.0;
        let measure =
            |policy, c| measure_char_width_with_policy(family, false, false, c, size, policy);
        runtime::clear();
        let characters = ['“', '”', '"', '‘', '’', '·'];
        let legacy_mac = characters.map(|c| measure(FontMetricsPolicy::HcrDeclared, c));
        let legacy_windows = characters.map(|c| measure(FontMetricsPolicy::HancomWindows, c));
        runtime::register(&bytes, &[family.to_owned()], false, false).unwrap();
        for c in ['“', '”', '"'] {
            let glyph = face.glyph_index(c).unwrap();
            let units = face.glyph_hor_advance(glyph).unwrap();
            let expected =
                quantize_hwp_px(f64::from(units) * size / f64::from(face.units_per_em()));
            if c != '"' {
                assert!(units >= face.units_per_em());
                assert!(expected > size / 2.0);
            }
            assert_eq!(measure(FontMetricsPolicy::HcrDeclared, c), Some(expected));
        }
        for (index, c) in characters.into_iter().enumerate() {
            assert_eq!(
                measure(FontMetricsPolicy::HancomWindows, c),
                legacy_windows[index]
            );
            if !matches!(c, '“' | '”' | '"') {
                let glyph = face.glyph_index(c).unwrap();
                let em = f64::from(face.glyph_hor_advance(glyph).unwrap())
                    / f64::from(face.units_per_em());
                let legacy_em = if matches!(c, '‘' | '’') && em >= 1.0 {
                    0.5
                } else {
                    em
                };
                assert_eq!(
                    measure(FontMetricsPolicy::HcrDeclared, c),
                    Some(quantize_hwp_px(legacy_em * size)),
                );
            }
        }
        runtime::clear();
        for (index, c) in characters.into_iter().enumerate() {
            assert_eq!(
                measure(FontMetricsPolicy::HcrDeclared, c),
                legacy_mac[index]
            );
        }
    }

    #[test]
    fn registered_corner_quotes_preserve_face_advances_only_in_mac_policy() {
        use crate::renderer::runtime_font_metrics as runtime;
        let Ok(bytes) = std::fs::read(
            "/Applications/Hancom Office HWP.app/Contents/Resources/Hnc/Shared/TTF/Install/GulimChe.TTF",
        ) else {
            // 선택적 설치 폰트가 없는 환경도 공개 fixture 등록 테스트를 수행한다.
            return;
        };
        let face = ttf_parser::Face::parse(&bytes, 0).unwrap();
        let family = "굴림체";
        let size = 16.0;
        let measure =
            |policy, c| measure_char_width_with_policy(family, false, false, c, size, policy);
        let characters = ['「', '」', '"', '‘', '’'];
        runtime::clear();
        let windows = characters.map(|c| measure(FontMetricsPolicy::HancomWindows, c));
        let unregistered = characters.map(|c| measure(FontMetricsPolicy::HcrDeclared, c));
        runtime::register(&bytes, &[family.to_owned()], false, false).unwrap();
        for c in ['「', '」', '"'] {
            let glyph = face.glyph_index(c).unwrap();
            let units = face.glyph_hor_advance(glyph).unwrap();
            let expected =
                quantize_hwp_px(f64::from(units) * size / f64::from(face.units_per_em()));
            if c != '"' {
                assert!(units >= face.units_per_em());
            }
            assert_eq!(measure(FontMetricsPolicy::HcrDeclared, c), Some(expected));
        }
        for (index, c) in characters.into_iter().enumerate() {
            assert_eq!(measure(FontMetricsPolicy::HancomWindows, c), windows[index]);
            if matches!(c, '‘' | '’') {
                let glyph = face.glyph_index(c).unwrap();
                let advance = f64::from(face.glyph_hor_advance(glyph).unwrap())
                    / f64::from(face.units_per_em());
                assert_eq!(
                    measure(FontMetricsPolicy::HcrDeclared, c),
                    Some(quantize_hwp_px(advance.min(0.5) * size))
                );
            }
        }
        runtime::clear();
        for (index, c) in characters.into_iter().enumerate() {
            assert_eq!(
                measure(FontMetricsPolicy::HcrDeclared, c),
                unregistered[index]
            );
        }
    }

    #[test]
    fn registered_faces_use_real_advances_for_hcr_layout_and_latin_spaces() {
        use crate::renderer::runtime_font_metrics as runtime;
        let bytes = include_bytes!("../../../ttfs/opensource/NotoSansKR-Regular.ttf");
        let face = ttf_parser::Face::parse(bytes, 0).unwrap();
        let em = |c| {
            f64::from(
                face.glyph_hor_advance(face.glyph_index(c).unwrap())
                    .unwrap(),
            ) / f64::from(face.units_per_em())
        };
        let family = "__runtime_face_contract__";
        runtime::register(bytes, &[family.into()], false, false).unwrap();
        assert!(custom_font_face_available(family));
        assert_eq!(
            custom_face_char_em_advance(family, false, false, 'W'),
            Some(em('W'))
        );
        assert_eq!(
            custom_face_char_em_advance(family, false, false, ' '),
            Some(em(' '))
        );
        assert_ne!(em(' '), 0.5);
        let style = TextStyle {
            font_family: family.into(),
            font_size: 20.0,
            latin_space: true,
            font_metrics_policy: FontMetricsPolicy::HcrDeclared,
            ..Default::default()
        };
        assert_eq!(
            latin_space_width(&style, ' ', 20.0),
            Some(quantize_hwp_px(em(' ') * 20.0))
        );
        assert_eq!(latin_space_width(&style, '\u{00A0}', 20.0), None);
        // 문서 반각 공백 API 는 기존 계약을 유지한다.
        let space = runtime::char_advance(family, false, false, ' ').unwrap();
        assert_eq!(space.units, space.em_size / 2);

        // 내장 메트릭이 있는 설치 face 도 HcrDeclared 에서는 실제 hmtx 를 쓴다.
        let baked = measure_char_width_inner(
            "굴림",
            false,
            false,
            'W',
            20.0,
            FontMetricsPolicy::HancomWindows,
            false,
        );
        runtime::register(bytes, &["굴림".into()], false, false).unwrap();
        assert_eq!(
            measure_char_width_inner(
                "굴림",
                false,
                false,
                'W',
                20.0,
                FontMetricsPolicy::HcrDeclared,
                false,
            ),
            Some(quantize_hwp_px(em('W') * 20.0))
        );
        assert_eq!(
            measure_char_width_inner(
                "굴림",
                false,
                false,
                'W',
                20.0,
                FontMetricsPolicy::HancomWindows,
                false,
            ),
            baked
        );
        runtime::clear();
        assert!(!custom_font_face_available(family));
        assert_eq!(custom_face_char_em_advance(family, false, false, 'W'), None);
    }

    #[test]
    fn runtime_font_metrics_replace_heuristic_widths_until_cleared() {
        use crate::renderer::runtime_font_metrics as runtime;
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/ttfs/opensource/");
        let regular = std::fs::read(format!("{dir}NotoSansKR-Regular.ttf")).unwrap();
        let light = std::fs::read(format!("{dir}NotoSansKR-ExtraLight.ttf")).unwrap();
        let advance_px = |bytes: &[u8], c: char, fs: f64| {
            let face = ttf_parser::Face::parse(bytes, 0).unwrap();
            let gid = face.glyph_index(c).unwrap();
            let adv = face.glyph_hor_advance(gid).unwrap() as f64;
            quantize_hwp_px(adv * fs / face.units_per_em() as f64)
        };
        let fs = 20.0;
        let w = |fam: &str, bold: bool, c: char| {
            measure_char_width_with_policy(
                fam,
                bold,
                false,
                c,
                fs,
                FontMetricsPolicy::HancomWindows,
            )
        };

        // 내장 메트릭 없는 별칭은 휴리스틱 경로(None)로 간다.
        assert_eq!(w("테스트글꼴", false, '가'), None);
        assert_eq!(w("테스트글꼴", false, 'i'), None);

        let aliases = vec!["테스트글꼴".to_string(), "Test Font".to_string()];
        let first = runtime::register(&regular, &aliases, false, false).unwrap();
        assert!(first.covers_hangul && first.covers_latin && !first.replaced);
        assert!(
            runtime::register(&regular, &aliases, false, false)
                .unwrap()
                .replaced
        );

        let hangul = advance_px(&regular, '가', fs);
        let latin_i = advance_px(&regular, 'i', fs);
        assert_eq!(w("테스트글꼴", false, '가'), Some(hangul));
        assert_eq!(w("테스트글꼴", false, 'i'), Some(latin_i));
        assert!(
            (latin_i - fs * 0.5).abs() > 1.0,
            "'i' 는 0.5em 휴리스틱과 달라야 한다"
        );
        // 이름 정규화(공백·대소문자·따옴표) 와 CSS 체인의 첫 폰트명 조회.
        assert_eq!(w("\"test   FONT\", sans-serif", false, 'i'), Some(latin_i));
        // 공백은 내장 메트릭과 같이 em/2.
        assert_eq!(w("테스트글꼴", false, ' '), Some(quantize_hwp_px(fs * 0.5)));
        // 레이아웃 경로 전체에서 사용된다.
        let style = TextStyle {
            font_family: "테스트글꼴".into(),
            font_size: fs,
            ..Default::default()
        };
        assert!((estimate_text_width_unrounded("가i", &style) - (hangul + latin_i)).abs() < 1e-9);

        // Bold 페이스가 없으면 Regular 폭 그대로 + 합성 Bold 획.
        let bold_style = TextStyle {
            bold: true,
            ..style.clone()
        };
        assert_eq!(w("테스트글꼴", true, 'i'), Some(latin_i));
        assert!(crate::renderer::faux_bold_stroke_width(&bold_style, fs).is_some());
        // Bold 페이스를 등록하면 그 폭을 쓰고 합성 획은 없다.
        runtime::register(&light, &aliases, true, false).unwrap();
        assert_eq!(
            w("테스트글꼴", true, 'W'),
            Some(advance_px(&light, 'W', fs))
        );
        assert_ne!(advance_px(&light, 'W', fs), advance_px(&regular, 'W', fs));
        assert_eq!(
            w("테스트글꼴", false, 'W'),
            Some(advance_px(&regular, 'W', fs))
        );
        assert!(crate::renderer::faux_bold_stroke_width(&bold_style, fs).is_none());

        // Windows는 내장 폭을 유지하고 macOS는 등록한 face의 실제 폭을 쓴다.
        let baked = w("함초롬돋움", false, 'i');
        runtime::register(&light, &["함초롬돋움".to_string()], false, false).unwrap();
        assert_eq!(w("함초롬돋움", false, 'i'), baked);
        assert_eq!(
            measure_char_width_with_policy(
                "함초롬돋움",
                false,
                false,
                'i',
                fs,
                FontMetricsPolicy::HcrDeclared,
            ),
            Some(advance_px(&light, 'i', fs))
        );

        assert!(runtime::report_json().contains("\"hits\":"));
        assert!(runtime::register(b"not a font", &aliases, false, false).is_err());

        runtime::clear();
        assert_eq!(w("테스트글꼴", false, '가'), None);
        assert!(crate::renderer::faux_bold_stroke_width(&bold_style, fs).is_none());
    }

    // Stage 4 검증으로 native tab_type 정정 (정정 2) 은 회귀 발견되어 철회.
    // HWP5 의 `tab_extended[0]` 가 이미 right-tab 결과 위치 (= 우측 끝 - 한컴_seg_w)
    // 로 저장되어 있어 LEFT fallback 이 인코딩 의도와 정합. 본 테스트는 합성 데이터
    // 기반의 잘못된 가정 (RIGHT 정확 매치) 을 검증하던 것이라 삭제.
    #[test]
    fn latin_space_uses_font_advance_without_changing_korean_or_nbsp() {
        let mut style = TextStyle {
            font_family: "HCR Batang".to_string(),
            font_size: 20.0,
            font_metrics_policy: FontMetricsPolicy::HcrDeclared,
            ..Default::default()
        };
        // 15pt = 375 배치 단위: 빈칸 floor(375/2) = 187, 글꼴 빈칸 0.3em → 113.
        let plain = 187.0 * MAC_LAYOUT_UNIT_PX;
        for (latin_space, expected) in [(false, plain), (true, 113.0 * MAC_LAYOUT_UNIT_PX)] {
            style.latin_space = latin_space;
            assert!((estimate_text_width(" ", &style) - expected).abs() < 1e-9);
            assert!((estimate_text_width_unrounded(" ", &style) - expected).abs() < 1e-9);
            assert!((compute_char_positions(" ", &style)[1] - expected).abs() < 1e-9);
            assert!((compute_char_positions("\u{00A0}", &style)[1] - plain).abs() < 1e-9);
        }
    }

    /// 한컴(macOS)이 해석하지 못하는 face 는 함초롬돋움 폭으로 잰다 — 이름의
    /// `바탕체`(고정폭 분류)·Light 와 무관하다. 글꼴 빈칸(useFontSpace)도 그 글꼴의
    /// 빈칸 폭(0.3em)이다.
    #[test]
    fn unresolved_face_measures_with_hancom_default_face() {
        let style = |family: &str, latin_space: bool| TextStyle {
            font_family: family.to_string(),
            font_size: 20.0,
            latin_space,
            font_metrics_policy: FontMetricsPolicy::HcrDeclared,
            ..Default::default()
        };
        let unknown = style("가상서체바탕체 Light", false);
        let hcr = style("함초롬돋움", false);
        for text in ["가나다라", "SF 영화", "(A)"] {
            assert!(
                (estimate_text_width(text, &unknown) - estimate_text_width(text, &hcr)).abs()
                    < 0.01,
                "{text}"
            );
        }
        assert!(
            (estimate_text_width(" ", &style("가상서체바탕체 Light", true))
                - 113.0 * MAC_LAYOUT_UNIT_PX)
                .abs()
                < 1e-9
        );
    }

    /// HFT 원본 run 은 대체 서체(굴림)가 아니라 HFT 폭 테이블로 잰다.
    /// 같은 디자인의 한양 TTF 대체(HY견명조)는 기존 폭을 유지한다.
    #[test]
    fn hft_runs_measure_with_hft_widths_unless_substitute_is_hanyang_twin() {
        let style = TextStyle {
            font_family: "굴림".to_string(),
            hft_family: "신명 신그래픽".to_string(),
            font_size: 20.0,
            ..Default::default()
        };
        // TESGREN.HFT `(` = 500/1000em
        assert!((estimate_text_width("(", &style) - 10.0).abs() < 0.05);
        let twin = TextStyle {
            font_family: "HY견명조".to_string(),
            hft_family: "신명 견명조".to_string(),
            ..style.clone()
        };
        let plain = TextStyle {
            hft_family: String::new(),
            ..twin.clone()
        };
        assert_eq!(
            estimate_text_width("32", &twin),
            estimate_text_width("32", &plain)
        );
    }
}

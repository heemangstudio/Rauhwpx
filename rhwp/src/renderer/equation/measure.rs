//! 수식 글립 측정.
//!
//! 배치 폭은 실제로 칠하는 서체에서 얻는다. 브라우저에서는 painter와 같은 CSS font
//! 문자열로 canvas를 측정하고, 네이티브에서는 같은 fallback 체인의 내장 메트릭을 쓴다.
//! 측정과 paint가 다른 서체를 보면 기호가 옆 원자와 겹친다(△x).

/// canvas painter와 측정이 공유하는 CSS font 문자열.
pub(crate) fn css_font(size: f64, italic: bool, bold: bool, family: &str) -> String {
    let style = if italic { "italic " } else { "" };
    let weight = if bold { "bold " } else { "" };
    format!("{}{}{:.3}px {}", style, weight, size, family)
}

/// 글립 run의 advance와 잉크 오른쪽 끝(시작점 기준, px).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct RunMetrics {
    pub advance: f64,
    pub ink_right: f64,
}

/// JS 측정기 결과 객체의 속성을 읽는다.
///
/// 측정기는 서체를 못 찾으면 null 을 돌려준다. null 에 `Reflect.get` 을 부르면 TypeError 가
/// 나는데, wasm-bindgen 의 catch 경로는 예외마다 externref 표 슬롯을 돌려받지 못한다. 수식이
/// 있는 문단을 다시 조판할 때마다 수십 번씩 쌓여 표가 V8 상한(1천만 칸)에 닿으면
/// `__externref_table_alloc` 이 trap 하고 엔진 인스턴스 전체가 멈춘다. 객체일 때만 읽는다.
#[cfg(target_arch = "wasm32")]
pub(crate) fn js_property(
    value: &wasm_bindgen::JsValue,
    key: &str,
) -> Option<wasm_bindgen::JsValue> {
    if !value.is_object() {
        return None;
    }
    js_sys::Reflect::get(value, &wasm_bindgen::JsValue::from_str(key)).ok()
}

impl RunMetrics {
    #[cfg(target_arch = "wasm32")]
    pub fn from_js(value: wasm_bindgen::JsValue) -> Option<Self> {
        let number = |key: &str| js_property(&value, key)?.as_f64();
        let metrics = Self {
            advance: number("advance")?,
            ink_right: number("inkRight")?,
        };
        metrics.is_valid().then_some(metrics)
    }

    fn is_valid(&self) -> bool {
        self.advance.is_finite() && self.advance >= 0.0 && self.ink_right.is_finite()
    }

    /// 이탤릭 보정: 잉크가 advance 밖으로 넘친 폭.
    pub fn overhang(&self) -> f64 {
        (self.ink_right - self.advance).max(0.0)
    }
}

#[cfg(target_arch = "wasm32")]
thread_local! {
    static CSS_RUN_CACHE: std::cell::RefCell<std::collections::HashMap<(String, String), RunMetrics>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

/// 폰트 등록 변화 후 canvas 실측 캐시를 비운다.
pub(crate) fn clear_css_run_cache() {
    #[cfg(target_arch = "wasm32")]
    CSS_RUN_CACHE.with(|cache| cache.borrow_mut().clear());
}

/// painter fallback 체인으로 run을 측정한다. 브라우저 canvas가 없으면 None.
#[cfg(target_arch = "wasm32")]
pub(crate) fn measure_css_run(font: &str, text: &str) -> Option<RunMetrics> {
    use std::cell::RefCell;
    use wasm_bindgen::JsCast;

    thread_local! {
        static CONTEXT: RefCell<Option<web_sys::CanvasRenderingContext2d>> = const { RefCell::new(None) };
    }

    CONTEXT.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            *slot = web_sys::window()
                .and_then(|window| window.document())
                .and_then(|document| document.create_element("canvas").ok())
                .and_then(|element| element.dyn_into::<web_sys::HtmlCanvasElement>().ok())
                .and_then(|canvas| canvas.get_context("2d").ok().flatten())
                .and_then(|context| context.dyn_into().ok());
        }
        let context = slot.as_ref()?;
        // painter와 같은 setter를 거쳐 문서 서체 치환도 동일하게 적용된다.
        context.set_font(font);
        // 세션 서체를 가져오면 같은 요청 font라도 실제 runtime family가 달라진다.
        let key = (context.font(), text.to_string());
        if let Some(hit) = CSS_RUN_CACHE.with(|cache| cache.borrow().get(&key).copied()) {
            return Some(hit);
        }
        let measured = context.measure_text(text).ok()?;
        let metrics = RunMetrics {
            advance: measured.width(),
            ink_right: measured.actual_bounding_box_right(),
        };
        if !metrics.is_valid() {
            return None;
        }
        CSS_RUN_CACHE.with(|cache| {
            let mut cache = cache.borrow_mut();
            if cache.len() >= 4096 {
                cache.clear();
            }
            cache.insert(key, metrics);
        });
        Some(metrics)
    })
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn measure_css_run(_font: &str, _text: &str) -> Option<RunMetrics> {
    None
}

/// legacy 수식 서체 run 실측치.
///
/// 한컴 수식기는 글립을 서체 advance가 아니라 잉크 가장자리끼리 포갠다
/// (eq-002 실측: `=`→`−` 원점 간격 6.0pt = `=` 잉크 폭 6.02, `(`→`n` 1.9pt).
/// 배치가 다음 원자 원점을 `앞 잉크 끝 − 이 원자 lsb + 간격`으로 놓으려면
/// hmtx 합이 아니라 첫/마지막 글립의 잉크 경계가 필요하다.
#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct LegacyRunMetrics {
    /// 서체 hmtx advance 총합(px) — painter가 run 내부 글립을 놓는 스텝.
    pub advance: f64,
    /// 마지막 잉크 글립의 오른쪽 끝(run 원점 기준, px).
    pub ink_right: f64,
    /// 첫 잉크 글립의 왼쪽 끝 = 좌측 베어링(lsb, px).
    pub ink_left: f64,
}

/// legacy 수식 서체의 glyf/hmtx 원표 — 글립 잉크 경계를 디자인 단위로 읽는다.
///
/// skia `get_widths_bounds` 는 스트라이크 패딩(+1px)과 정수 라운딩이 섞여
/// 소수 pt 정밀도가 필요한 잉크 포개기에는 쓸 수 없다 (eq-002: `=` 참값
/// [0.67,8.65]px 가 [−1,10] 으로 옴). 서체 표를 직접 파싱하면 결정적이다.
#[cfg(not(target_arch = "wasm32"))]
struct LegacyTables {
    units_per_em: f64,
    advances: Vec<u16>,
    loca: Vec<u32>,
    glyf: Vec<u8>,
    /// 유니코드(PUA 포함) → glyph id.
    cmap: std::collections::HashMap<u32, u16>,
}

#[cfg(not(target_arch = "wasm32"))]
impl LegacyTables {
    fn u16be(d: &[u8], off: usize) -> Option<u16> {
        d.get(off..off + 2)
            .map(|b| u16::from_be_bytes([b[0], b[1]]))
    }

    fn i16be(d: &[u8], off: usize) -> Option<i16> {
        Self::u16be(d, off).map(|v| v as i16)
    }

    /// 서체 파일 바이트에서 원표를 읽는다. skia 없이도(릴리스 CLI) 같은 값을 얻도록
    /// 표 해석은 서체 데이터만으로 한다.
    fn from_font_data(data: &[u8], index: u32) -> Option<Self> {
        let face = ttf_parser::Face::parse(data, index).ok()?;
        let raw = face.raw_face();
        let table = |tag: &[u8; 4]| raw.table(ttf_parser::Tag::from_bytes(tag));
        let head = table(b"head")?;
        let maxp = table(b"maxp")?;
        let hhea = table(b"hhea")?;
        let hmtx = table(b"hmtx")?;
        let loca_raw = table(b"loca")?;
        let glyf = table(b"glyf")?;
        let units_per_em = Self::u16be(head, 18)? as f64;
        let loca_long = Self::i16be(head, 50)? != 0;
        let num_glyphs = Self::u16be(maxp, 4)? as usize;
        let num_metrics = (Self::u16be(hhea, 34)? as usize).min(num_glyphs);
        if units_per_em <= 0.0 || num_metrics == 0 {
            return None;
        }
        // hmtx: num_metrics 개의 (advance,lsb) 쌍 뒤에 lsb 배열.
        let mut advances = Vec::with_capacity(num_glyphs);
        for g in 0..num_glyphs {
            let off = if g < num_metrics {
                g * 4
            } else {
                (num_metrics - 1) * 4
            };
            advances.push(Self::u16be(hmtx, off)?);
        }
        let mut loca = Vec::with_capacity(num_glyphs + 1);
        for g in 0..=num_glyphs {
            let v = if loca_long {
                u32::from_be_bytes([
                    *loca_raw.get(g * 4)?,
                    *loca_raw.get(g * 4 + 1)?,
                    *loca_raw.get(g * 4 + 2)?,
                    *loca_raw.get(g * 4 + 3)?,
                ])
            } else {
                u32::from(Self::u16be(loca_raw, g * 2)?) * 2
            };
            loca.push(v);
        }
        let mut cmap = std::collections::HashMap::new();
        if let Some(table) = face.tables().cmap {
            for subtable in table.subtables.into_iter().filter(|s| s.is_unicode()) {
                subtable.codepoints(|code| {
                    if let Some(gid) = subtable.glyph_index(code) {
                        cmap.entry(code).or_insert(gid.0);
                    }
                });
            }
        }
        Some(Self {
            units_per_em,
            advances,
            loca,
            glyf: glyf.to_vec(),
            cmap,
        })
    }

    /// 문자의 glyph id — cmap에 없으면 0(.notdef).
    fn glyph(&self, character: char) -> u16 {
        self.cmap.get(&(character as u32)).copied().unwrap_or(0)
    }

    fn advance(&self, gid: u16) -> f64 {
        self.advances.get(gid as usize).copied().unwrap_or(0) as f64 / self.units_per_em
    }

    /// 글립 잉크 상자(em) — 비어 있으면 None.
    fn ink(&self, gid: u16) -> Option<(f64, f64, f64, f64)> {
        let g = gid as usize;
        let (lo, hi) = (*self.loca.get(g)?, *self.loca.get(g + 1)?);
        if lo >= hi {
            return None;
        }
        let d = self.glyf.get(lo as usize..hi as usize)?;
        if d.len() < 10 {
            return None;
        }
        Some((
            Self::i16be(d, 2)? as f64 / self.units_per_em,
            Self::i16be(d, 4)? as f64 / self.units_per_em,
            Self::i16be(d, 6)? as f64 / self.units_per_em,
            Self::i16be(d, 8)? as f64 / self.units_per_em,
        ))
    }
}

/// 원본 수식 서체(HYhwpEQ)의 원표 — 본문 페인트와 같은 조달 순서로 custom(--font-path)
/// 등록 face 를 먼저, 없으면 (skia 빌드에서) 시스템 설치 face 를 읽는다.
#[cfg(not(target_arch = "wasm32"))]
fn resolve_legacy_tables() -> Option<LegacyTables> {
    if let Some(tables) =
        crate::renderer::font_paths::custom_face_source("HYhwpEQ").and_then(|(file, index)| {
            std::fs::read(file)
                .ok()
                .and_then(|bytes| LegacyTables::from_font_data(&bytes, index))
        })
    {
        return Some(tables);
    }
    #[cfg(feature = "native-skia")]
    {
        use skia_safe::{FontMgr, FontStyle};
        thread_local! {
            // 미해소 run 마다 CoreText 시스템 family 목록을 다시 만들면 폰트 서비스 IPC가
            // 반복된다. custom face 는 나중에 등록될 수 있으므로 그 조회만 매번 재시도한다.
            static SYSTEM_FONT_SOURCE: (FontMgr, bool) = {
                let font_mgr = FontMgr::default();
                let has_legacy_face = font_mgr
                    .family_names()
                    .any(|name| name.eq_ignore_ascii_case("HYhwpEQ"));
                (font_mgr, has_legacy_face)
            };
        }
        // skia::font_lookup 의 system_families 필터와 같은 이유 — 없는 family 를
        // CoreText 에 넘기면 downloadable font 조회가 대기할 수 있어 선차단한다.
        SYSTEM_FONT_SOURCE.with(|(font_mgr, has_legacy_face)| {
            let face = has_legacy_face
                .then(|| font_mgr.match_family_style("HYhwpEQ", FontStyle::normal()))
                .flatten()?;
            let (bytes, index) = face.to_font_data()?;
            LegacyTables::from_font_data(&bytes, index as u32)
        })
    }
    #[cfg(not(feature = "native-skia"))]
    {
        None
    }
}

/// 네이티브 painter(skia draw_text·SVG HY 경로)의 legacy 서체 경로로 run을 실측한다.
///
/// painter는 요청 서체가 HYhwpEQ 이고 실제 서체가 PUA cmap 을 가질 때 글자를
/// PUA 로 옮겨 칠한다(skia/equation_conv.rs). 네이티브에는 canvas 가 없으므로
/// 같은 typeface·같은 매핑으로 여기서 직접 잰다 — 다른 서체 폭으로 배치하면
/// 개체 advance 와 내부 간격이 paint 와 어긋난다. 서체가 없거나 글립이 빠지면
/// None — 호출자는 기존 내장 메트릭/추정 경로로 내려간다.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn measure_legacy_run_native(
    text: &str,
    font_size: f64,
    italic: bool,
    bold: bool,
    modern: bool,
) -> Option<LegacyRunMetrics> {
    use std::cell::RefCell;
    use std::collections::HashMap;

    thread_local! {
        // 해석 성공분만 캐시 — 미해소(None)는 저장하지 않아 재시도한다.
        static LEGACY_FACE: RefCell<Option<std::rc::Rc<LegacyTables>>> =
            const { RefCell::new(None) };
        static RUN_CACHE: RefCell<HashMap<(String, u64, bool, bool, bool), Option<LegacyRunMetrics>>> =
            RefCell::new(HashMap::new());
    }
    let key = (text.to_string(), font_size.to_bits(), italic, bold, modern);
    // The Haansoft fallback may be registered after the HY face. Keep its
    // metrics live so an earlier generic fallback cannot stay cached.
    let cacheable = !modern
        || !text
            .chars()
            .any(|character| matches!(character, '□' | '∆' | '′' | '″'));
    if cacheable {
        if let Some(hit) = RUN_CACHE.with(|cache| cache.borrow().get(&key).copied()) {
            return hit;
        }
    }
    let tables = match LEGACY_FACE.with(|slot| slot.borrow().clone()) {
        Some(tables) => tables,
        // 미해소 결과는 캐시하지 않는다 — custom face(--font-path)는 렌더 진입 시
        // 등록돼 첫 측정(페이지네이션) 때는 아직 없을 수 있다.
        None => {
            let resolved = std::rc::Rc::new(resolve_legacy_tables()?);
            LEGACY_FACE.with(|slot| *slot.borrow_mut() = Some(resolved.clone()));
            resolved
        }
    };
    // painter(equation_conv::draw_text)와 같은 문자→PUA 매핑을 글자 단위로
    // 적용한다. legacy face가 커버하지 못하는 문자(수식 안 한글)는 painter가
    // CJK fallback 서체로 자연 윤곽을 칠하되 현대식은 진행폭을 좁혀 잰다 —
    // 섞인 run을 통째로 거절하면 한글 토큰이 1.0em 격자로 측정돼 식이 커진다.
    //
    // 한컴 수식기는 run 안 글립의 자형을 그대로 두고 진행 스텝만
    // EQUATION_GLYPH_TRACKING(0.9)배로 포갠다 — painter도 같은 비율로 좁혀
    // 칠한다(02-eq-01 실측: 한글 pitch 0.9em, 숫자 0.45em, '%' 0.75em).
    let mut pen = 0.0f64;
    let mut ink_left = f64::NAN;
    let mut ink_right = 0.0f64;
    for ch in text.chars() {
        let mapped = super::font::legacy_equation_glyph(ch, italic, modern).0;
        let gid = tables.glyph(mapped);
        // 이 글자의 자연 진행폭·잉크 경계(em) — painter가 칠할 서체 기준.
        let (adv, ink) = if gid > 0 {
            let raw = tables.advance(gid as u16);
            // 현대 HY 글립은 힌팅된 advance로 연결한다.
            let adv = if modern {
                super::font::modern_glyph_advance(
                    raw * font_size,
                    font_size,
                    super::font::legacy_equation_glyph(ch, italic, true).1,
                ) / font_size
            } else {
                raw
            };
            (adv, tables.ink(gid as u16))
        } else if let Some(advance) = modern
            .then(|| super::font::modern_hancom_fallback_run_advance_em(text))
            .flatten()
        {
            // The actual Haansoft Batang face is registered and covers this
            // character. It has a full-em advance, which Hancom tracks at 0.9.
            (
                super::font::modern_glyph_advance(advance * font_size, font_size, false)
                    / font_size,
                Some((0.0, 0.0, advance, 0.0)),
            )
        } else if super::layout::is_cjk_char(ch) {
            // 현대 HY 식의 한글은 fallback face로 칠하더라도 0.9em pitch에 놓인다.
            // 글립 윤곽은 전각 그대로이고, 바로 아래 modern 경로가 advance를
            // 다시 줄이지 않으므로 여기서 원본 글립과 같은 힌팅/추적을 적용한다.
            let advance = if modern {
                super::font::modern_glyph_advance(font_size, font_size, false) / font_size
            } else {
                1.0
            };
            (advance, Some((0.0, 0.0, 1.0, 0.0)))
        } else if super::symbols::is_circled_number(ch) {
            (1.0, Some((0.0, 0.0, 1.0, 0.0)))
        } else {
            // 그 외 미커버 문자 — painter의 fallback 서체 자연폭 추정치.
            let adv = super::layout::estimate_text_width(&ch.to_string(), 1.0, italic);
            (adv, Some((0.0, 0.0, adv, 0.0)))
        };
        if let Some((x_min, _y_min, x_max, _y_max)) = ink {
            if ink_left.is_nan() {
                ink_left = pen + x_min;
            }
            ink_right = pen + x_max;
        }
        // 현대 HY advance(modern_glyph_advance)에는 0.9 포개기가 이미 들어 있다.
        pen += if modern {
            adv
        } else {
            adv * super::font::EQUATION_GLYPH_TRACKING
        };
    }
    let advance = pen * font_size;
    if ink_left.is_nan() {
        ink_left = 0.0;
        ink_right = pen;
    }
    let metrics = LegacyRunMetrics {
        advance,
        ink_right: ink_right * font_size,
        ink_left: ink_left * font_size,
    };
    let metrics = (metrics.ink_right.is_finite()
        && metrics.ink_left.is_finite()
        && metrics.advance.is_finite()
        && metrics.advance >= 0.0)
        .then_some(metrics);
    if cacheable {
        RUN_CACHE.with(|cache| {
            let mut cache = cache.borrow_mut();
            if cache.len() >= 4096 {
                cache.clear();
            }
            cache.insert(key, metrics);
        });
    }
    metrics
}

/// 원본 수식 서체의 힌팅·포개기 없는 자연 advance 합(px). 서체가 없으면 None.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn legacy_natural_width(text: &str, font_size: f64) -> Option<f64> {
    // modern=false 경로는 자연 advance×포개기 비율이므로 비율을 되돌린다.
    let metrics = measure_legacy_run_native(text, font_size, false, false, false)?;
    Some(metrics.advance / super::font::EQUATION_GLYPH_TRACKING)
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn legacy_natural_width(text: &str, font_size: f64) -> Option<f64> {
    // 네이티브와 같은 HYhwpEQ PUA cmap의 hmtx를 쓴다. 힌팅·tracking을 거치지
    // 않으며, 등록된 서체가 없거나 글리프를 지원하지 않으면 기존 폴백을 유지한다.
    let width_em = text.chars().try_fold(0.0, |width, ch| {
        let mapped = super::font::legacy_equation_glyph(ch, false, false).0;
        crate::renderer::runtime_font_metrics::char_em_advance("HYhwpEQ", false, false, mapped)
            .map(|advance| width + advance)
    })?;
    Some(width_em * font_size)
}

/// Times 계열 이탤릭 자형의 오른쪽 잉크 초과량(em, 천분율). canvas 잉크를 얻을 수
/// 없는 네이티브 경로의 이탤릭 보정값이며, 0.015em 미만은 생략한다.
pub(crate) fn italic_overhang_em(ch: char) -> f64 {
    let per_mille = match ch {
        'd' => 41,
        'f' => 193,
        'g' => 21,
        'k' => 44,
        'l' => 20,
        'r' => 16,
        't' => 21,
        'C' => 37,
        'E' => 21,
        'F' => 58,
        'H' => 89,
        'I' => 77,
        'J' => 103,
        'K' => 62,
        'M' => 91,
        'N' => 95,
        'S' => 42,
        'T' => 93,
        'U' => 92,
        'V' => 112,
        'W' => 111,
        'X' => 130,
        'Y' => 111,
        'Z' => 55,
        'ζ' => 125,
        'θ' => 16,
        'ξ' => 62,
        'π' => 31,
        'σ' => 34,
        'τ' => 32,
        'χ' => 29,
        'ψ' => 26,
        _ => 0,
    };
    f64::from(per_mille) / 1000.0
}

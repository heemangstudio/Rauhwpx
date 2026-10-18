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

#[cfg(not(target_arch = "wasm32"))]
thread_local! {
    // 해석 성공분만 캐시 — 미해소(None)는 저장하지 않아 재시도한다.
    static LEGACY_FACE: std::cell::RefCell<Option<std::rc::Rc<LegacyTables>>> =
        const { std::cell::RefCell::new(None) };
    static FALLBACK_FACES: std::cell::RefCell<std::collections::HashMap<
        (bool, bool), std::rc::Rc<LegacyTables>
    >> = std::cell::RefCell::new(std::collections::HashMap::new());
    static RUN_CACHE: std::cell::RefCell<std::collections::HashMap<
        (String, u64, bool, bool, bool, (&'static str, u64)), Option<LegacyRunMetrics>
    >> = std::cell::RefCell::new(std::collections::HashMap::new());
}

/// 새 측정 세대에서 현재 스레드의 서체/실측 캐시를 비운다.
pub(crate) fn clear_measurement_caches() {
    #[cfg(target_arch = "wasm32")]
    CSS_RUN_CACHE.with(|cache| cache.borrow_mut().clear());
    #[cfg(not(target_arch = "wasm32"))]
    {
        LEGACY_FACE.with(|slot| *slot.borrow_mut() = None);
        FALLBACK_FACES.with(|cache| cache.borrow_mut().clear());
        RUN_CACHE.with(|cache| cache.borrow_mut().clear());
    }
}

/// painter fallback 체인으로 run을 측정한다. 브라우저 canvas가 없으면 None.
#[cfg(target_arch = "wasm32")]
pub(crate) fn measure_css_run(font: &str, text: &str) -> Option<RunMetrics> {
    use std::cell::RefCell;
    use wasm_bindgen::JsCast;
    let generation = super::sync_measurement_caches();

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
        if super::measurement_generation() != generation {
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
    let (bytes, index) = crate::renderer::font_paths::equation_face_data("HYhwpEQ", false, false)?;
    LegacyTables::from_font_data(&bytes, index)
}

/// coverage 허용과 원표 실측은 별개다. regular hmtx만으로 실제 잉크를 만들지 않는다.
#[cfg(not(target_arch = "wasm32"))]
fn modern_fallback_metrics(
    ch: char,
    italic: bool,
    bold: bool,
) -> Option<(f64, (f64, f64, f64, f64))> {
    super::sync_measurement_caches();
    super::font::modern_hancom_fallback_advance_em(ch)?;
    let cached = FALLBACK_FACES.with(|cache| cache.borrow().get(&(italic, bold)).cloned());
    let tables = match cached {
        Some(tables) => tables,
        None => {
            let generation = super::measurement_generation();
            let (bytes, index) =
                crate::renderer::font_paths::equation_face_data("Haansoft Batang", bold, italic)?;
            let tables = std::rc::Rc::new(LegacyTables::from_font_data(&bytes, index)?);
            if super::measurement_generation() != generation {
                return None;
            }
            FALLBACK_FACES.with(|cache| cache.borrow_mut().insert((italic, bold), tables.clone()));
            tables
        }
    };
    let gid = tables.glyph(ch);
    (gid > 0)
        .then(|| (tables.advance(gid), tables.ink(gid)))
        .and_then(|(advance, ink)| Some((advance, ink?)))
}

/// production 혼합 text leaf는 각 positioned glyph와 같은 style로 잰다.
/// 단일 글립을 직접 재는 저수준 API의 명시적 italic 요청은 유지한다.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn measure_modern_text_run_native(
    text: &str,
    font_size: f64,
    italic: bool,
    bold: bool,
) -> Option<LegacyRunMetrics> {
    measure_modern_text_run_native_with_policy(text, font_size, italic, bold, Default::default())
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn measure_modern_text_run_native_with_policy(
    text: &str,
    font_size: f64,
    italic: bool,
    bold: bool,
    context: super::font::AdvanceContext,
) -> Option<LegacyRunMetrics> {
    if !text
        .chars()
        .any(|ch| super::font::modern_hancom_fallback_advance_em(ch).is_some())
    {
        return measure_legacy_run_native_with_policy(text, font_size, italic, bold, true, context);
    }
    let generation = super::sync_measurement_caches();
    let mut result = LegacyRunMetrics {
        advance: 0.0,
        ink_left: 0.0,
        ink_right: 0.0,
    };
    for (index, ch) in text.chars().enumerate() {
        let effective_italic =
            italic && super::font::modern_hancom_fallback_advance_em(ch).is_none();
        let measured = measure_legacy_run_native_with_policy(
            &ch.to_string(),
            font_size,
            effective_italic,
            bold,
            true,
            context,
        )?;
        if index == 0 {
            result.ink_left = measured.ink_left;
        }
        result.ink_right = result.ink_right.max(result.advance + measured.ink_right);
        result.advance += measured.advance;
    }
    (super::measurement_generation() == generation).then_some(result)
}

/// 잉크 원표가 없는 admitted fallback도 알고 있는 진행폭은 유지한다.
/// 실제 잉크를 반환하는 API와 분리하며 production literal의 upright 선택도 따른다.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn measure_modern_run_advance_native(
    text: &str,
    font_size: f64,
    italic: bool,
    bold: bool,
    literal: bool,
) -> Option<f64> {
    measure_modern_run_advance_native_with_policy(
        text,
        font_size,
        italic,
        bold,
        literal,
        Default::default(),
    )
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn measure_modern_run_advance_native_with_policy(
    text: &str,
    font_size: f64,
    italic: bool,
    bold: bool,
    literal: bool,
    context: super::font::AdvanceContext,
) -> Option<f64> {
    let generation = super::sync_measurement_caches();
    if !text
        .chars()
        .any(|ch| super::font::modern_hancom_fallback_advance_em(ch).is_some())
    {
        return None;
    }
    let advance = text.chars().try_fold(0.0, |advance, ch| {
        let admitted = super::font::modern_hancom_fallback_advance_em(ch);
        let effective_italic = italic && !(literal && admitted.is_some());
        if let Some(metrics) = measure_legacy_run_native_with_policy(
            &ch.to_string(),
            font_size,
            effective_italic,
            bold,
            true,
            context,
        ) {
            return Some(advance + metrics.advance);
        }
        let admitted = admitted?;
        // CFF/불완전 glyf도 선택된 face의 hmtx는 읽을 수 있다. 바이트가 없으면
        // 등록된 style 메트릭, 마지막으로 기존 admission 폭을 쓰되 잉크는 만들지 않는다.
        let selected = crate::renderer::font_paths::equation_face_data(
            "Haansoft Batang",
            bold,
            effective_italic,
        )
        .and_then(|(bytes, index)| {
            let face = ttf_parser::Face::parse(&bytes, index).ok()?;
            let gid = face.glyph_index(ch)?;
            Some(f64::from(face.glyph_hor_advance(gid)?) / f64::from(face.units_per_em()))
        });
        let raw = selected
            .or_else(|| {
                crate::renderer::runtime_font_metrics::char_em_advance(
                    "Haansoft Batang",
                    bold,
                    effective_italic,
                    ch,
                )
            })
            .unwrap_or(admitted);
        Some(advance + super::font::modern_glyph_advance(raw * font_size, font_size, false))
    })?;
    (advance.is_finite() && advance >= 0.0 && super::measurement_generation() == generation)
        .then_some(advance)
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
    measure_legacy_run_native_with_policy(text, font_size, italic, bold, modern, Default::default())
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn measure_legacy_run_native_with_policy(
    text: &str,
    font_size: f64,
    italic: bool,
    bold: bool,
    modern: bool,
    context: super::font::AdvanceContext,
) -> Option<LegacyRunMetrics> {
    let generation = super::sync_measurement_caches();
    let key = (
        text.to_string(),
        font_size.to_bits(),
        italic,
        bold,
        modern,
        context.cache_key(),
    );
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
                super::font::modern_source_glyph_advance(
                    raw * font_size,
                    font_size,
                    ch,
                    italic,
                    bold,
                    gid,
                    context,
                ) / font_size
            } else {
                raw
            };
            (adv, tables.ink(gid as u16))
        } else if let Some((advance, ink)) = modern
            .then(|| modern_fallback_metrics(ch, italic, bold))
            .flatten()
        {
            // 같은 selected face의 원래 advance와 자연 잉크. 진행폭에만
            // 현대 격자/0.9 추적을 한 번 적용하고 잉크는 축소하지 않는다.
            (
                super::font::modern_glyph_advance(advance * font_size, font_size, false)
                    / font_size,
                Some(ink),
            )
        } else if modern && super::font::modern_hancom_fallback_advance_em(ch).is_some() {
            // admission/hmtx는 잉크를 증명하지 않는다. 호출자가 width-only 경로를
            // 쓰도록 거절한다. 추정 잉크/폭으로 알려진 fallback advance를 덮지 않는다.
            return None;
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
    if super::measurement_generation() != generation {
        return None;
    }
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

#[cfg(all(test, not(target_arch = "wasm32")))]
mod fallback_ink_tests {
    use super::*;
    use crate::renderer::equation::{
        ast::EqNode,
        layout::{sqrt_pua_geometry, EqLayout, LayoutKind},
    };
    use std::{collections::BTreeMap, path::PathBuf};

    fn isolated(name: &str) -> bool {
        const CHILD: &str = "RHWP_FALLBACK_INK_CHILD";
        if std::env::var_os(CHILD).is_some() {
            return false;
        }
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .arg(format!(
                "renderer::equation::measure::fallback_ink_tests::{name}"
            ))
            .args(["--exact", "--nocapture"])
            .env(CHILD, "1")
            .env_remove(crate::renderer::font_paths::FONT_PATH_ENV);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success() && String::from_utf8_lossy(&output.stdout).contains("1 passed"),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        true
    }

    fn checksum(bytes: &[u8]) -> u32 {
        bytes.chunks(4).fold(0u32, |sum, chunk| {
            let mut word = [0; 4];
            word[..chunk.len()].copy_from_slice(chunk);
            sum.wrapping_add(u32::from_be_bytes(word))
        })
    }

    // Studio의 syntheticEquationFont와 같은 MIT fixture/GID/cmap/advance.
    // 이름과 체크섬도 재작성해 실제 네이티브 등록/Skia 선택을 통과한다.
    fn font(
        family: &str,
        chars: &str,
        gid: u16,
        advance: u16,
        italic: bool,
        bold: bool,
        ink: Option<(i16, i16)>,
    ) -> Vec<u8> {
        let original = include_bytes!("../../../tests/fixtures/fonts/RHWPShapingFixture.ttf");
        let face = ttf_parser::Face::parse(original, 0).unwrap();
        let mut tables = BTreeMap::<[u8; 4], Vec<u8>>::new();
        for record in face.raw_face().table_records {
            let tag = record.tag.to_bytes();
            tables.insert(tag, face.raw_face().table(record.tag).unwrap().to_vec());
        }
        let mut codes = chars.chars().map(|ch| ch as u32).collect::<Vec<_>>();
        codes.sort_unstable();
        codes.dedup();
        let mut cmap = vec![0; 28 + 12 * codes.len()];
        cmap[2..4].copy_from_slice(&1u16.to_be_bytes());
        cmap[4..6].copy_from_slice(&3u16.to_be_bytes());
        cmap[6..8].copy_from_slice(&10u16.to_be_bytes());
        cmap[8..12].copy_from_slice(&12u32.to_be_bytes());
        cmap[12..14].copy_from_slice(&12u16.to_be_bytes());
        let length = cmap.len() as u32 - 12;
        cmap[16..20].copy_from_slice(&length.to_be_bytes());
        cmap[24..28].copy_from_slice(&(codes.len() as u32).to_be_bytes());
        for (index, code) in codes.into_iter().enumerate() {
            let start = 28 + 12 * index;
            cmap[start..start + 4].copy_from_slice(&code.to_be_bytes());
            cmap[start + 4..start + 8].copy_from_slice(&code.to_be_bytes());
            cmap[start + 8..start + 12].copy_from_slice(&(gid as u32).to_be_bytes());
        }
        tables.insert(*b"cmap", cmap);
        let encoded = family
            .encode_utf16()
            .flat_map(u16::to_be_bytes)
            .collect::<Vec<_>>();
        let mut name = vec![0; 6 + 4 * 12];
        name[2..4].copy_from_slice(&4u16.to_be_bytes());
        name[4..6].copy_from_slice(&(54u16).to_be_bytes());
        for (index, id) in [1u16, 4, 6, 16].into_iter().enumerate() {
            let start = 6 + 12 * index;
            for (field, value) in [3, 1, 0x409, id, encoded.len() as u16, 0]
                .into_iter()
                .enumerate()
            {
                name[start + field * 2..start + field * 2 + 2]
                    .copy_from_slice(&value.to_be_bytes());
            }
        }
        name.extend(encoded);
        tables.insert(*b"name", name);
        let hmtx = tables.get_mut(b"hmtx").unwrap();
        hmtx[gid as usize * 4..gid as usize * 4 + 2].copy_from_slice(&advance.to_be_bytes());
        let os2 = tables.get_mut(b"OS/2").unwrap();
        os2[4..6].copy_from_slice(&(if bold { 700u16 } else { 400 }).to_be_bytes());
        os2[62..64].copy_from_slice(
            &(if italic {
                1u16
            } else if bold {
                32
            } else {
                64
            })
            .to_be_bytes(),
        );
        let head = tables.get_mut(b"head").unwrap();
        head[8..12].fill(0);
        head[44..46].copy_from_slice(&(u16::from(bold) + 2 * u16::from(italic)).to_be_bytes());
        if let Some((left, right)) = ink {
            // 새 사각 윤곽 자체를 만든다. bbox 헤더만 바꾼 가짜 잉크가 아니다.
            let mut rectangle = Vec::new();
            for value in [1i16, left, 0, right, 700, 3, 0] {
                rectangle.extend(value.to_be_bytes());
            }
            rectangle.extend([1u8; 4]);
            for value in [left, right - left, 0, left - right, 0, 0, 700, 0] {
                rectangle.extend(value.to_be_bytes());
            }
            let mut glyf = Vec::new();
            let mut loca = Vec::new();
            let source = &tables[b"glyf"];
            let offsets = &tables[b"loca"];
            let long = i16::from_be_bytes(tables[b"head"][50..52].try_into().unwrap()) != 0;
            let offset = |g: usize| {
                if long {
                    u32::from_be_bytes(offsets[g * 4..g * 4 + 4].try_into().unwrap()) as usize
                } else {
                    u16::from_be_bytes(offsets[g * 2..g * 2 + 2].try_into().unwrap()) as usize * 2
                }
            };
            for glyph in 0..face.number_of_glyphs() as usize {
                loca.extend((glyf.len() as u32).to_be_bytes());
                if glyph == gid as usize {
                    glyf.extend(&rectangle);
                } else {
                    glyf.extend(&source[offset(glyph)..offset(glyph + 1)]);
                }
            }
            loca.extend((glyf.len() as u32).to_be_bytes());
            tables.insert(*b"glyf", glyf);
            tables.insert(*b"loca", loca);
            tables.get_mut(b"head").unwrap()[50..52].copy_from_slice(&1u16.to_be_bytes());
        }
        encode_font(original, tables)
    }

    fn encode_font(original: &[u8], tables: BTreeMap<[u8; 4], Vec<u8>>) -> Vec<u8> {
        let count = tables.len();
        let mut bytes = vec![0; 12 + 16 * count];
        bytes[..12].copy_from_slice(&original[..12]);
        bytes[4..6].copy_from_slice(&(count as u16).to_be_bytes());
        let selector = (count as u16).ilog2() as u16;
        let search_range = 16 * (1u16 << selector);
        bytes[6..8].copy_from_slice(&search_range.to_be_bytes());
        bytes[8..10].copy_from_slice(&selector.to_be_bytes());
        bytes[10..12].copy_from_slice(&(count as u16 * 16 - search_range).to_be_bytes());
        let mut adjustment = 0;
        for (index, (tag, table)) in tables.into_iter().enumerate() {
            while bytes.len() % 4 != 0 {
                bytes.push(0);
            }
            let start = bytes.len();
            let record = 12 + 16 * index;
            bytes[record..record + 4].copy_from_slice(&tag);
            bytes[record + 4..record + 8].copy_from_slice(&checksum(&table).to_be_bytes());
            bytes[record + 8..record + 12].copy_from_slice(&(start as u32).to_be_bytes());
            bytes[record + 12..record + 16].copy_from_slice(&(table.len() as u32).to_be_bytes());
            if tag == *b"head" {
                adjustment = start + 8;
            }
            bytes.extend(table);
        }
        let value = 0xb1b0afbau32.wrapping_sub(checksum(&bytes));
        bytes[adjustment..adjustment + 4].copy_from_slice(&value.to_be_bytes());
        assert_eq!(checksum(&bytes), 0xb1b0afba);
        bytes
    }

    // None은 outline 없는 metrics-only SFNT, Some은 해당 GID만 빈 윤곽인 face.
    // 원본 fixture 파일은 수정하지 않는다.
    fn without_ink(bytes: &[u8], gid: Option<u16>) -> Vec<u8> {
        let face = ttf_parser::Face::parse(bytes, 0).unwrap();
        let mut tables = BTreeMap::<[u8; 4], Vec<u8>>::new();
        for record in face.raw_face().table_records {
            tables.insert(
                record.tag.to_bytes(),
                face.raw_face().table(record.tag).unwrap().to_vec(),
            );
        }
        if let Some(gid) = gid {
            let long = i16::from_be_bytes(tables[b"head"][50..52].try_into().unwrap()) != 0;
            let stride = if long { 4 } else { 2 };
            let start = gid as usize * stride;
            let loca = tables.get_mut(b"loca").unwrap();
            loca.copy_within(start + stride..start + 2 * stride, start);
        } else {
            tables.remove(b"glyf");
            tables.remove(b"loca");
        }
        tables.get_mut(b"head").unwrap()[8..12].fill(0);
        encode_font(bytes, tables)
    }

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("rhwp-fallback-ink-{}", std::process::id()));
            std::fs::create_dir(&dir).unwrap();
            Self(dir)
        }
        fn install(&self, filename: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(filename);
            std::fs::write(&path, bytes).unwrap();
            crate::renderer::font_paths::register_font_face_availability(&[path.clone()]);
            path
        }
        fn hy(&self, chars: &str) {
            self.install(
                "hy.ttf",
                &font("HYhwpEQ", chars, 1, 600, false, false, None),
            );
        }
        fn fallback(
            &self,
            name: &str,
            gid: u16,
            advance: u16,
            italic: bool,
            bold: bool,
            ink: Option<(i16, i16)>,
        ) -> PathBuf {
            self.install(
                name,
                &font("Haansoft Batang", "□∆′″", gid, advance, italic, bold, ink),
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn near(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1e-9,
            "actual {actual}, expected {expected}"
        );
    }
    fn engine() -> EqLayout {
        EqLayout::with_font(10.0, "HYhwpEQ").with_version("Equation Version 60")
    }

    // 500/1000 em reproduces the retained source digit's 512/1024 em advance.
    // All outlines here belong to the existing MIT shaping fixture.
    const POLICY_GLYPHS: &str =
        "\u{e03d}\u{e034}\u{e035}\u{e036}\u{e037}\u{e038}\u{e0fc}\u{e000}xA";

    fn policy_engine(policy: crate::model::provenance::FontMetricsPolicy, scale: f64) -> EqLayout {
        EqLayout::with_font(11.0 * 4.0 / 3.0 * scale, "HYhwpEQ")
            .with_version("Equation Version 60")
            .with_base_pt(11.0)
            .with_metrics_policy(policy)
    }

    #[test]
    fn windows_advance_policy_preserves_ink_paint_size_scripts_and_cache_identity() {
        if isolated("windows_advance_policy_preserves_ink_paint_size_scripts_and_cache_identity") {
            return;
        }
        use crate::model::provenance::FontMetricsPolicy::{HancomWindows, HcrDeclared};
        use crate::renderer::equation::symbols::FontStyleKind;
        use crate::renderer::equation::{font::AdvanceContext, natural_width_hwp_with_policy};
        let fixture = Fixture::new();
        fixture.install(
            "hy.ttf",
            &font(
                "HYhwpEQ",
                POLICY_GLYPHS,
                1,
                500,
                false,
                false,
                Some((50, 550)),
            ),
        );
        let generation = super::super::measurement_generation();
        let fs = 11.0 * 4.0 / 3.0;
        let mut equation = crate::model::control::Equation::default();
        equation.script = "45".into();
        equation.font_name = "HYhwpEQ".into();
        equation.version_info = "Equation Version 60".into();
        equation.font_size = 1100;
        let mac = policy_engine(HcrDeclared, 1.0);
        for policy in [HancomWindows, HcrDeclared, HancomWindows, HcrDeclared] {
            let engine = policy_engine(policy, 1.0);
            let windows = policy == HancomWindows;
            let step = if windows { 7.0 } else { 6.3 };
            let script_step = if windows { 5.0 } else { 4.5 };
            for digit in ["4", "5"] {
                let row = engine.layout(&EqNode::Row(vec![
                    EqNode::Number(digit.into()),
                    EqNode::Text("x".into()),
                ]));
                let LayoutKind::Row(children) = &row.kind else {
                    panic!("pair row");
                };
                near(children[1].x - children[0].x, step);
                near(
                    (children[1].x - children[0].x) * 0.75,
                    if windows { 5.25 } else { 4.725 },
                );
            }
            let number = engine.layout(&EqNode::Number("45".into()));
            let positioned = number.positioned_glyphs().unwrap();
            near(positioned[1].x, step);
            near(number.width, 2.0 * step);
            near(positioned[1].paint_font_size(fs), fs);
            let context = AdvanceContext { policy, scale: 1.0 };
            let leaf = measure_legacy_run_native_with_policy("4", fs, false, false, true, context)
                .unwrap();
            let old_leaf = measure_legacy_run_native("4", fs, false, false, true).unwrap();
            near(leaf.ink_left, old_leaf.ink_left);
            near(leaf.ink_right, old_leaf.ink_right);
            let script_node = EqNode::Superscript {
                base: Box::new(EqNode::Text("x".into())),
                sup: Box::new(EqNode::Number("23".into())),
            };
            let scripted = engine.layout(&script_node);
            let LayoutKind::Superscript { sup, .. } = &scripted.kind else {
                panic!("superscript");
            };
            near(sup.positioned_glyphs().unwrap()[1].x, script_step);
            near(sup.paint_font_size(fs), fs * 0.68);
            let old_scripted = mac.layout(&script_node);
            near(scripted.height, old_scripted.height);
            near(scripted.baseline, old_scripted.baseline);
            for node in [
                EqNode::Text("한".into()),
                EqNode::Text("A".into()),
                EqNode::FontStyle {
                    style: FontStyleKind::Roman,
                    body: Box::new(EqNode::Text("x".into())),
                },
                EqNode::FontStyle {
                    style: FontStyleKind::Bold,
                    body: Box::new(EqNode::Number("45".into())),
                },
            ] {
                near(engine.layout(&node).width, mac.layout(&node).width);
            }
            let legacy = engine
                .clone()
                .with_version("")
                .layout(&EqNode::Number("45".into()));
            near(
                legacy.width,
                mac.clone()
                    .with_version("")
                    .layout(&EqNode::Number("45".into()))
                    .width,
            );
            assert_eq!(
                natural_width_hwp_with_policy(&equation, policy),
                Some(if windows { 1050 } else { 945 })
            );
            let scaled =
                policy_engine(HancomWindows, 200.0 / 96.0).layout(&EqNode::Number("45".into()));
            near(
                scaled.positioned_glyphs().unwrap()[1].x / (200.0 / 96.0),
                7.0,
            );
        }
        assert_eq!(super::super::measurement_generation(), generation);
        // Legacy callers remain Mac even after a Windows run warms the same generation.
        near(
            EqLayout::with_font(fs, "HYhwpEQ")
                .layout(&EqNode::Number("45".into()))
                .width,
            12.6,
        );
    }

    #[test]
    fn windows_advance_policy_refreshes_both_policies_after_source_generation_change() {
        if isolated("windows_advance_policy_refreshes_both_policies_after_source_generation_change")
        {
            return;
        }
        use crate::model::provenance::FontMetricsPolicy::{HancomWindows, HcrDeclared};
        use crate::renderer::equation::{
            content_width_hwp_with_policy, natural_width_hwp_with_policy,
        };
        let fixture = Fixture::new();
        let bytes = font(
            "HYhwpEQ",
            POLICY_GLYPHS,
            1,
            500,
            false,
            false,
            Some((50, 550)),
        );
        let path = fixture.install("hy.ttf", &bytes);
        let mut equation = crate::model::control::Equation::default();
        equation.script = "45".into();
        equation.font_name = "HYhwpEQ".into();
        equation.version_info = "Equation Version 60".into();
        equation.font_size = 1100;
        equation.common.width = 1234;
        let before = [HcrDeclared, HancomWindows]
            .map(|p| natural_width_hwp_with_policy(&equation, p).unwrap());
        let generation = super::super::measurement_generation();
        fixture.install(
            "hy.ttf",
            &font(
                "HYhwpEQ",
                POLICY_GLYPHS,
                1,
                800,
                false,
                false,
                Some((50, 550)),
            ),
        );
        crate::renderer::layout::clear_measure_caches();
        assert!(super::super::measurement_generation() > generation);
        for (index, policy) in [HcrDeclared, HancomWindows].into_iter().enumerate() {
            assert!(natural_width_hwp_with_policy(&equation, policy).unwrap() > before[index]);
        }
        #[cfg(not(feature = "native-skia"))]
        {
            std::fs::remove_file(&path).unwrap();
            crate::renderer::font_paths::register_font_face_availability(&[path]);
            crate::renderer::layout::clear_measure_caches();
            for policy in [HancomWindows, HcrDeclared] {
                assert_eq!(natural_width_hwp_with_policy(&equation, policy), None);
                assert_eq!(content_width_hwp_with_policy(&equation, policy), 1234);
            }
            fixture.install("hy.ttf", &bytes);
            crate::renderer::layout::clear_measure_caches();
            assert_eq!(
                [HcrDeclared, HancomWindows]
                    .map(|p| natural_width_hwp_with_policy(&equation, p).unwrap()),
                before
            );
        }
        #[cfg(feature = "native-skia")]
        let _ = (path, content_width_hwp_with_policy(&equation, HcrDeclared));
    }

    #[test]
    fn windows_advance_policy_keeps_fallback_width_without_inventing_ink() {
        if isolated("windows_advance_policy_keeps_fallback_width_without_inventing_ink") {
            return;
        }
        use crate::model::provenance::FontMetricsPolicy::{HancomWindows, HcrDeclared};
        let fixture = Fixture::new();
        fixture.hy(POLICY_GLYPHS);
        let fallback = without_ink(
            &font("Haansoft Batang", "□∆′″", 3, 800, false, false, None),
            None,
        );
        fixture.install("fallback.ttf", &fallback);
        crate::renderer::layout::clear_measure_caches();
        for policy in [HancomWindows, HcrDeclared, HancomWindows] {
            let context = super::super::font::AdvanceContext { policy, scale: 1.0 };
            assert!(
                measure_legacy_run_native_with_policy("□", 10.0, false, false, true, context)
                    .is_none()
            );
            near(
                engine()
                    .with_metrics_policy(policy)
                    .layout(&EqNode::Text("□".into()))
                    .width,
                7.2,
            );
        }
    }

    fn assert_width_without_fallback_ink() {
        near(
            super::super::font::modern_hancom_fallback_advance_em('□').unwrap(),
            0.8,
        );
        assert!(modern_fallback_metrics('□', false, false).is_none());
        assert!(measure_legacy_run_native("□", 10.0, false, false, true).is_none());
        assert!(measure_modern_text_run_native("A□A", 10.0, true, false).is_none());
        for text in ["□", "A□", "A□A", "□A"] {
            for node in [EqNode::Text(text.into()), EqNode::Quoted(text.into())] {
                let layout = engine().layout(&node);
                let expected = match text {
                    "□" => 7.2,
                    "A□A" => 19.2,
                    _ => 13.2,
                };
                near(layout.width, expected);
                let advances = layout.glyph_advances.as_ref().unwrap();
                let glyphs = layout.positioned_glyphs().unwrap();
                let square = if text.starts_with('A') { 1 } else { 0 };
                near(advances[square], 7.2);
                near(glyphs[square].x, if square == 1 { 6.0 } else { 0.0 });
                if text.ends_with('A') {
                    near(
                        glyphs.last().unwrap().x,
                        if square == 1 { 13.2 } else { 7.2 },
                    );
                }
            }
        }
    }

    #[test]
    fn fallback_without_glyf_keeps_registered_advance_without_claiming_ink() {
        if isolated("fallback_without_glyf_keeps_registered_advance_without_claiming_ink") {
            return;
        }
        let fixture = Fixture::new();
        let regular = without_ink(
            &font("Haansoft Batang", "□∆′″", 3, 800, false, false, None),
            None,
        );
        let face = ttf_parser::Face::parse(&regular, 0).unwrap();
        assert!(face
            .raw_face()
            .table(ttf_parser::Tag::from_bytes(b"glyf"))
            .is_none());
        let path = fixture.install("metrics-only.ttf", &regular);
        // 진행폭만 등록한다. 선택된 custom source에는 outline 표가 없다.
        crate::renderer::runtime_font_metrics::register(
            &regular,
            &["Haansoft Batang".into()],
            false,
            false,
        )
        .unwrap();
        assert!(measure_legacy_run_native("□", 10.0, false, false, true).is_none());
        near(engine().layout(&EqNode::Text("□".into())).width, 7.2);
        fixture.hy("A\u{e000}\u{e034}\u{e03d}");
        assert_width_without_fallback_ink();
        // 파일 source까지 없어져도 이미 등록한 hmtx 폭은 여전히 쓸 수 있다.
        std::fs::remove_file(path).unwrap();
        crate::renderer::layout::clear_measure_caches();
        assert_width_without_fallback_ink();
    }

    #[test]
    fn fallback_without_one_glyph_ink_keeps_selected_style_advance_and_origins() {
        if isolated("fallback_without_one_glyph_ink_keeps_selected_style_advance_and_origins") {
            return;
        }
        let fixture = Fixture::new();
        fixture.hy("A\u{e000}\u{e034}\u{e03d}");
        let complete = font("Haansoft Batang", "□∆′″", 3, 800, false, false, None);
        fixture.install("regular-empty-square.ttf", &complete);
        let row = EqNode::Row(vec![EqNode::Text("□".into()), EqNode::Text("A".into())]);
        let complete_row = engine().layout(&row);
        let regular = without_ink(&complete, Some(3));
        let tables = LegacyTables::from_font_data(&regular, 0).unwrap();
        assert!(tables.ink(3).is_none());
        assert!(tables.ink(1).is_some());
        fixture.install("regular-empty-square.ttf", &regular);
        crate::renderer::layout::clear_measure_caches();
        let before_hft = measure_legacy_run_native("□한", 10.0, false, false, false).unwrap();
        assert_width_without_fallback_ink();
        let missing_ink_row = engine().layout(&row);
        let (LayoutKind::Row(complete_atoms), LayoutKind::Row(missing_ink_atoms)) =
            (&complete_row.kind, &missing_ink_row.kind)
        else {
            panic!("expected row");
        };
        near(missing_ink_atoms[1].x, complete_atoms[1].x);
        near(missing_ink_row.width, complete_row.width);
        fixture.install(
            "italic-empty-square.ttf",
            &without_ink(
                &font("Haansoft Batang", "□∆′″", 4, 1000, true, false, None),
                Some(4),
            ),
        );
        fixture.install(
            "bold-empty-square.ttf",
            &without_ink(
                &font("Haansoft Batang", "□∆′″", 4, 1200, false, true, None),
                Some(4),
            ),
        );
        assert!(modern_fallback_metrics('□', true, false).is_none());
        near(
            measure_modern_run_advance_native("□", 10.0, true, false, false).unwrap(),
            9.0,
        );
        near(
            measure_modern_run_advance_native("□", 10.0, true, false, true).unwrap(),
            7.2,
        );
        let bold = engine().layout(&EqNode::FontStyle {
            style: super::super::symbols::FontStyleKind::Bold,
            body: Box::new(EqNode::Text("A□A".into())),
        });
        near(bold.width, 22.8);
        let LayoutKind::FontStyle { body, .. } = &bold.kind else {
            panic!("expected bold leaf");
        };
        near(body.positioned_glyphs().unwrap()[2].x, 16.8);
        assert_width_without_fallback_ink();
        assert_eq!(
            before_hft,
            measure_legacy_run_native("□한", 10.0, false, false, false).unwrap()
        );
        fixture.hy("A□\u{e000}\u{e034}\u{e03d}");
        crate::renderer::layout::clear_measure_caches();
        assert!(super::super::font::modern_hancom_fallback_advance_em('□').is_none());
        near(engine().layout(&EqNode::Text("□".into())).width, 6.0);
        assert!(measure_modern_run_advance_native("□", 10.0, false, false, true).is_none());
    }

    #[test]
    fn fallback_natural_ink_controls_radical_geometry() {
        if isolated("fallback_natural_ink_controls_radical_geometry") {
            return;
        }
        let fixture = Fixture::new();
        fixture.hy("A\u{e000}\u{e034}\u{e03d}");
        fixture.fallback("regular.ttf", 3, 800, false, false, None);
        let metrics = measure_legacy_run_native("□", 10.0, false, false, true).unwrap();
        near(metrics.advance, 7.2);
        near(metrics.ink_left, 0.5);
        near(metrics.ink_right, 5.0);
        let mixed = measure_legacy_run_native("A□A", 10.0, false, false, true).unwrap();
        near(mixed.advance, 18.0);
        near(mixed.ink_right, 17.6);
        let ast = crate::renderer::equation::parser::EqParser::new(
            crate::renderer::equation::tokenizer::tokenize("sqrt {□}"),
        )
        .parse();
        let layout = engine().layout(&ast);
        fn root(lb: &super::super::layout::LayoutBox) -> &super::super::layout::LayoutBox {
            match &lb.kind {
                LayoutKind::Sqrt { .. } => lb,
                LayoutKind::Row(children) => root(&children[0]),
                _ => panic!("expected radical"),
            }
        }
        let radical = root(&layout);
        let LayoutKind::Sqrt { body, .. } = &radical.kind else {
            unreachable!()
        };
        near(radical.width, 18.2);
        near(body.width, 7.2);
        near(body.x, 10.5);
        let geometry = sqrt_pua_geometry(body, radical.baseline, radical.width, 10.0, true);
        near(geometry.bar_advance, 8.2);
        near(body.x - 0.3 + geometry.bar_advance, 18.4);
    }

    #[test]
    fn fallback_style_selection_matches_production_and_explicit_requests() {
        if isolated("fallback_style_selection_matches_production_and_explicit_requests") {
            return;
        }
        let fixture = Fixture::new();
        fixture.hy("A\u{e000}\u{e034}\u{e03d}");
        fixture.fallback("italic-first.ttf", 4, 1000, true, false, None);
        let regular = font("Haansoft Batang", "□∆′″", 3, 800, false, false, None);
        fixture.install("regular-second.ttf", &regular);
        fixture.fallback("bold.ttf", 4, 1200, false, true, None);
        let (selected, index) =
            crate::renderer::font_paths::equation_face_data("Haansoft Batang", false, false)
                .unwrap();
        assert_eq!(selected, regular);
        assert_eq!(index, 0);
        near(
            measure_legacy_run_native("□", 10.0, true, false, true)
                .unwrap()
                .advance,
            9.0,
        );
        near(engine().layout(&EqNode::Text("□".into())).width, 7.2);
        let bold = engine().layout(&EqNode::FontStyle {
            style: super::super::symbols::FontStyleKind::Bold,
            body: Box::new(EqNode::Text("□".into())),
        });
        near(bold.width, 10.8);
        for text in ["A□A", "A□"] {
            let metrics = measure_modern_text_run_native(text, 10.0, true, false).unwrap();
            let expected = if text == "A□A" { 19.2 } else { 13.2 };
            near(metrics.advance, expected);
            let layout = engine().layout(&EqNode::Text(text.into()));
            near(layout.width, expected);
            let advances = layout.glyph_advances.as_ref().unwrap();
            near(advances[0], 6.0);
            near(advances[1], 7.2);
            let glyphs = layout.positioned_glyphs().unwrap();
            near(glyphs[1].x, 6.0);
            if text == "A□A" {
                near(glyphs[2].x, 13.2);
            }
        }
    }

    #[test]
    fn fallback_negative_bearing_overhang_and_mixed_terminal_ink_are_natural() {
        if isolated("fallback_negative_bearing_overhang_and_mixed_terminal_ink_are_natural") {
            return;
        }
        let fixture = Fixture::new();
        fixture.hy("A\u{e000}\u{e034}\u{e03d}");
        fixture.fallback("regular.ttf", 3, 800, false, false, Some((-150, 1200)));
        let metrics = measure_legacy_run_native("□", 10.0, false, false, true).unwrap();
        near(metrics.advance, 7.2);
        near(metrics.ink_left, -1.5);
        near(metrics.ink_right, 12.0);
        let terminal = measure_modern_text_run_native("A□", 10.0, true, false).unwrap();
        near(terminal.advance, 13.2);
        near(terminal.ink_right, 18.0);
        let leading = measure_modern_text_run_native("□A", 10.0, true, false).unwrap();
        near(leading.ink_left, -1.5);
        near(leading.ink_right, 12.2);
        let root = engine().layout(&EqNode::Sqrt {
            index: None,
            body: Box::new(EqNode::Text("A□".into())),
        });
        near(root.width, 24.9);
    }

    #[test]
    fn fallback_registration_refresh_unload_and_coverage_keep_metric_identity() {
        if isolated("fallback_registration_refresh_unload_and_coverage_keep_metric_identity") {
            return;
        }
        let fixture = Fixture::new();
        fixture.hy("A\u{e000}\u{e034}\u{e03d}");
        assert!(modern_fallback_metrics('□', false, false).is_none());
        let before_hft = measure_legacy_run_native("□한", 10.0, false, false, false).unwrap();
        let before_cjk = measure_legacy_run_native("한", 10.0, false, false, true).unwrap();
        let path = fixture.fallback("regular.ttf", 3, 800, false, false, None);
        near(
            measure_legacy_run_native("□", 10.0, false, false, true)
                .unwrap()
                .ink_right,
            5.0,
        );
        near(
            measure_legacy_run_native("□", 10.0, true, false, true)
                .unwrap()
                .advance,
            7.2,
        );
        fixture.fallback("italic-late.ttf", 4, 1000, true, false, None);
        near(
            measure_legacy_run_native("□", 10.0, true, false, true)
                .unwrap()
                .advance,
            9.0,
        );
        near(engine().layout(&EqNode::Text("□".into())).width, 7.2);
        assert_eq!(
            before_hft,
            measure_legacy_run_native("□한", 10.0, false, false, false).unwrap()
        );
        assert_eq!(
            before_cjk,
            measure_legacy_run_native("한", 10.0, false, false, true).unwrap()
        );
        fixture.fallback("regular.ttf", 3, 1100, false, false, Some((-100, 1300)));
        // 같은 경로 교체는 기존 세대 동안 유지하고 명시적 refresh 후 다시 읽는다.
        near(
            measure_legacy_run_native("□", 10.0, false, false, true)
                .unwrap()
                .advance,
            7.2,
        );
        crate::renderer::layout::clear_measure_caches();
        let refreshed = measure_legacy_run_native("□", 10.0, false, false, true).unwrap();
        near(refreshed.advance, 9.9);
        near(refreshed.ink_left, -1.0);
        near(refreshed.ink_right, 13.0);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_file(fixture.0.join("italic-late.ttf")).unwrap();
        crate::renderer::layout::clear_measure_caches();
        assert!(modern_fallback_metrics('□', false, false).is_none());
        // 실제 source glyph가 생기면 fallback을 활성화하거나 upright으로 바꾸지 않는다.
        fixture.hy("A□\u{e000}\u{e034}\u{e03d}");
        crate::renderer::layout::clear_measure_caches();
        fixture.fallback("again.ttf", 3, 800, false, false, None);
        assert!(modern_fallback_metrics('□', false, false).is_none());
        near(
            measure_legacy_run_native("□", 10.0, true, false, true)
                .unwrap()
                .advance,
            6.0,
        );
    }
}

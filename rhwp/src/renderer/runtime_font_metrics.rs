//! 런타임 폰트 메트릭 레지스트리
//!
//! 사용자가 설치한 폰트(시스템 폰트, 한컴오피스 번들 폰트)의 실제 바이트를
//! 받아 advance 폭을 추출해 둔다. 내장 메트릭(`font_metrics_data`)에 없는
//! 폰트도 휴리스틱(라틴 0.5em / CJK 1em) 대신 실제 글리프 폭으로 조판한다.
//!
//! 조회 순서는 `text_measurement::measure_char_width_with_policy` 가 결정한다:
//! KoPub/Haansoft 오버라이드 → 내장 메트릭 → 런타임 레지스트리 → 휴리스틱.
//!
//! 폰트 바이트는 보관하지 않는다. 등록 시 cmap → glyph → hmtx advance 를
//! 256 코드포인트 단위 페이지 테이블(u16)로 펼쳐 두므로 한 페이스당 메모리는
//! 커버하는 페이지 수 × 512 바이트다 (한글+한자 CJK 폰트 ≈ 100~200KB).

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

const PAGE_BITS: u32 = 8;
const PAGE_SIZE: usize = 1 << PAGE_BITS;
const BMP_PAGES: usize = 0x10000 >> PAGE_BITS;

type Page = Box<[u16; PAGE_SIZE]>;

/// 코드포인트 → advance(폰트 단위) 테이블. 0 은 미매핑(또는 폭 0 글리프).
struct AdvanceTable {
    bmp: Vec<Option<Page>>,
    /// BMP 밖 페이지 (페이지 번호 오름차순)
    supplementary: Vec<(u32, Page)>,
    mapped: usize,
}

impl AdvanceTable {
    fn new() -> Self {
        Self {
            bmp: (0..BMP_PAGES).map(|_| None).collect(),
            supplementary: Vec::new(),
            mapped: 0,
        }
    }

    fn page_mut(&mut self, page: u32) -> &mut [u16; PAGE_SIZE] {
        if (page as usize) < BMP_PAGES {
            return self.bmp[page as usize].get_or_insert_with(|| Box::new([0; PAGE_SIZE]));
        }
        let idx = match self.supplementary.binary_search_by_key(&page, |(p, _)| *p) {
            Ok(idx) => idx,
            Err(idx) => {
                self.supplementary
                    .insert(idx, (page, Box::new([0; PAGE_SIZE])));
                idx
            }
        };
        &mut self.supplementary[idx].1
    }

    fn insert(&mut self, code: u32, advance: u16) {
        if advance == 0 {
            return;
        }
        let slot = &mut self.page_mut(code >> PAGE_BITS)[(code as usize) & (PAGE_SIZE - 1)];
        if *slot == 0 {
            *slot = advance;
            self.mapped += 1;
        }
    }

    fn get(&self, code: u32) -> Option<u16> {
        let page = code >> PAGE_BITS;
        let slot = (code as usize) & (PAGE_SIZE - 1);
        let w = if (page as usize) < BMP_PAGES {
            self.bmp[page as usize].as_ref()?[slot]
        } else {
            let idx = self
                .supplementary
                .binary_search_by_key(&page, |(p, _)| *p)
                .ok()?;
            self.supplementary[idx].1[slot]
        };
        (w > 0).then_some(w)
    }

    fn page_count(&self) -> usize {
        self.bmp.iter().filter(|page| page.is_some()).count() + self.supplementary.len()
    }
}

struct RuntimeFace {
    /// 등록 시 전달된 별칭 (보고용, 원문)
    aliases: Vec<String>,
    /// 정규화 + `resolve_metric_alias` 적용 키
    keys: Vec<String>,
    /// 원문 별칭의 정규화 키 (교체 판정용)
    raw_keys: Vec<String>,
    bold: bool,
    italic: bool,
    units_per_em: u16,
    advances: AdvanceTable,
    monospace: bool,
    covers_hangul: bool,
    hits: Cell<u64>,
}

#[derive(Default)]
struct Registry {
    faces: Vec<RuntimeFace>,
    /// 최근 조회한 원문 폰트명 → 후보 페이스 인덱스 (문자 단위 조회의 정규화 비용 회피)
    last_lookup: RefCell<Option<(String, Vec<usize>)>>,
}

thread_local! {
    static REGISTRY: RefCell<Registry> = RefCell::new(Registry::default());
}

/// 런타임 페이스에서 얻은 글리프 폭 (폰트 단위)
pub(crate) struct RuntimeAdvance {
    pub units: u16,
    pub em_size: u16,
    pub monospace: bool,
}

/// 등록 결과
pub(crate) struct RegisterOutcome {
    pub key: String,
    pub units_per_em: u16,
    pub mapped_chars: usize,
    pub covers_hangul: bool,
    pub covers_latin: bool,
    pub replaced: bool,
}

/// 폰트명 정규화: 앞뒤 공백·따옴표 제거, 연속 공백 1칸, ASCII 소문자.
fn collapse_name(name: &str) -> String {
    let trimmed = name.trim().trim_matches(|c| c == '"' || c == '\'').trim();
    trimmed.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn name_keys(name: &str) -> Vec<String> {
    let collapsed = collapse_name(name);
    if collapsed.is_empty() {
        return Vec::new();
    }
    let mut keys = vec![collapsed.to_ascii_lowercase()];
    let resolved = super::font_metrics_data::resolve_metric_alias(&collapsed).to_ascii_lowercase();
    if !keys.contains(&resolved) {
        keys.push(resolved);
    }
    keys
}

/// Basic Latin 폭이 모두 같으면 고정폭 (`text_measurement::is_monospace_metric` 과 동일 규칙).
fn is_monospace(advances: &AdvanceTable) -> bool {
    let mut common = None;
    let mut count = 0u32;
    for code in 0x21..=0x7Eu32 {
        let Some(w) = advances.get(code) else {
            continue;
        };
        count += 1;
        match common {
            None => common = Some(w),
            Some(cw) if cw != w => return false,
            _ => {}
        }
    }
    count >= 16
}

/// 컬렉션(TTC/OTC)이면 별칭과 이름이 맞는 페이스를 고른다. 없으면 0번.
fn select_face_index(bytes: &[u8], keys: &[String], bold: bool, italic: bool) -> u32 {
    let count = ttf_parser::fonts_in_collection(bytes).unwrap_or(1);
    if count <= 1 {
        return 0;
    }
    let mut name_match = None;
    for index in 0..count {
        let Ok(face) = ttf_parser::Face::parse(bytes, index) else {
            continue;
        };
        let matches_alias = face.names().into_iter().any(|name| {
            matches!(
                name.name_id,
                ttf_parser::name_id::FAMILY
                    | ttf_parser::name_id::FULL_NAME
                    | ttf_parser::name_id::TYPOGRAPHIC_FAMILY
            ) && name
                .to_string()
                .is_some_and(|value| name_keys(&value).iter().any(|key| keys.contains(key)))
        });
        if !matches_alias {
            continue;
        }
        if face.is_bold() == bold && face.is_italic() == italic {
            return index;
        }
        name_match.get_or_insert(index);
    }
    name_match.unwrap_or(0)
}

fn parse_face(
    bytes: &[u8],
    keys: &[String],
    bold: bool,
    italic: bool,
) -> Result<(u16, AdvanceTable), String> {
    if bytes.is_empty() {
        return Err("empty font data".to_string());
    }
    let index = select_face_index(bytes, keys, bold, italic);
    let face =
        ttf_parser::Face::parse(bytes, index).map_err(|err| format!("unparseable font: {err}"))?;
    let units_per_em = face.units_per_em();
    if units_per_em == 0 {
        return Err("font has no unitsPerEm".to_string());
    }
    let cmap = face
        .tables()
        .cmap
        .ok_or_else(|| "font has no cmap table".to_string())?;
    let mut advances = AdvanceTable::new();
    for subtable in cmap.subtables.into_iter().filter(|s| s.is_unicode()) {
        subtable.codepoints(|code| {
            if char::from_u32(code).is_none() {
                return;
            }
            if let Some(advance) = subtable
                .glyph_index(code)
                .filter(|glyph| glyph.0 != 0)
                .and_then(|glyph| face.glyph_hor_advance(glyph))
            {
                advances.insert(code, advance);
            }
        });
    }
    if advances.mapped == 0 {
        return Err("font has no mapped unicode glyphs".to_string());
    }
    Ok((units_per_em, advances))
}

/// 폰트 바이트에서 advance 테이블을 추출해 등록한다.
///
/// 같은 별칭 + bold + italic 조합이 이미 있으면 교체한다.
pub(crate) fn register(
    bytes: &[u8],
    aliases: &[String],
    bold: bool,
    italic: bool,
) -> Result<RegisterOutcome, String> {
    let aliases = aliases
        .iter()
        .map(|alias| collapse_name(alias))
        .filter(|alias| !alias.is_empty())
        .collect::<Vec<_>>();
    if aliases.is_empty() {
        return Err("no font alias".to_string());
    }
    let raw_keys =
        aliases
            .iter()
            .map(|alias| alias.to_ascii_lowercase())
            .fold(Vec::new(), |mut keys, key| {
                if !keys.contains(&key) {
                    keys.push(key);
                }
                keys
            });
    let mut keys = Vec::new();
    for alias in &aliases {
        for key in name_keys(alias) {
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
    }

    let (units_per_em, advances) = parse_face(bytes, &keys, bold, italic)?;
    let covers_hangul = ['가', '한', '힣']
        .into_iter()
        .all(|c| advances.get(c as u32).is_some());
    let covers_latin = ('A'..='Z')
        .chain('a'..='z')
        .all(|c| advances.get(c as u32).is_some());
    let face = RuntimeFace {
        monospace: is_monospace(&advances),
        aliases,
        keys,
        raw_keys,
        bold,
        italic,
        units_per_em,
        covers_hangul,
        hits: Cell::new(0),
        advances,
    };
    let outcome = RegisterOutcome {
        key: face.raw_keys[0].clone(),
        units_per_em,
        mapped_chars: face.advances.mapped,
        covers_hangul,
        covers_latin,
        replaced: false,
    };

    let replaced = REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        let same_slot = |existing: &RuntimeFace| {
            existing.bold == face.bold
                && existing.italic == face.italic
                && existing
                    .raw_keys
                    .iter()
                    .any(|key| face.raw_keys.contains(key))
        };
        let replaced = registry.faces.iter().any(|existing| same_slot(existing));
        registry.faces.retain(|existing| !same_slot(existing));
        registry.faces.push(face);
        registry.last_lookup.replace(None);
        replaced
    });
    super::layout::clear_measure_caches();
    Ok(RegisterOutcome {
        replaced,
        ..outcome
    })
}

/// 레지스트리를 비운다.
pub(crate) fn clear() {
    REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        registry.faces.clear();
        registry.last_lookup.replace(None);
    });
    super::layout::clear_measure_caches();
}

fn candidate_indices(registry: &Registry, primary_name: &str) -> Vec<usize> {
    if let Some((name, indices)) = registry.last_lookup.borrow().as_ref() {
        if name == primary_name {
            return indices.clone();
        }
    }
    let keys = name_keys(primary_name);
    let indices = registry
        .faces
        .iter()
        .enumerate()
        .filter(|(_, face)| face.keys.iter().any(|key| keys.contains(key)))
        .map(|(idx, _)| idx)
        .collect::<Vec<_>>();
    registry
        .last_lookup
        .replace(Some((primary_name.to_string(), indices.clone())));
    indices
}

/// `find_metric` 과 같은 선택 규칙: 정확 일치 → bold 일치(italic 무시, 비이탤릭)
/// → Regular 폴백. 반환값의 bool 은 bold_fallback.
fn select_face(
    registry: &Registry,
    primary_name: &str,
    bold: bool,
    italic: bool,
) -> Option<(usize, bool)> {
    if registry.faces.is_empty() {
        return None;
    }
    let candidates = candidate_indices(registry, primary_name);
    let faces = &registry.faces;
    let pick = candidates
        .iter()
        .copied()
        .find(|&idx| faces[idx].bold == bold && faces[idx].italic == italic)
        .or_else(|| {
            candidates
                .iter()
                .copied()
                .find(|&idx| faces[idx].bold == bold && !faces[idx].italic)
        })
        .or_else(|| {
            candidates
                .iter()
                .copied()
                .find(|&idx| !faces[idx].bold && !faces[idx].italic)
        })
        .or_else(|| candidates.first().copied())?;
    Some((pick, bold && !faces[pick].bold))
}

/// 런타임 페이스의 글리프 advance. 공백은 내장 메트릭과 같이 em/2 로 고정한다.
/// 페이스가 없거나 글리프가 없으면 None.
pub(crate) fn char_advance(
    primary_name: &str,
    bold: bool,
    italic: bool,
    c: char,
) -> Option<RuntimeAdvance> {
    REGISTRY.with(|registry| {
        let registry = registry.borrow();
        let (idx, _) = select_face(&registry, primary_name, bold, italic)?;
        let face = &registry.faces[idx];
        let units = if c == ' ' {
            face.units_per_em / 2
        } else {
            face.advances.get(c as u32)?
        };
        face.hits.set(face.hits.get() + 1);
        Some(RuntimeAdvance {
            units,
            em_size: face.units_per_em,
            monospace: face.monospace,
        })
    })
}

/// Bold 요청 시 런타임 레지스트리가 Regular 페이스로 폴백하는지 여부.
/// 등록된 페이스가 없으면 None.
pub(crate) fn bold_fallback(primary_name: &str, italic: bool) -> Option<bool> {
    REGISTRY.with(|registry| {
        select_face(&registry.borrow(), primary_name, true, italic).map(|(_, fallback)| fallback)
    })
}

/// 등록된 페이스 목록 JSON (진단용)
pub(crate) fn report_json() -> String {
    REGISTRY.with(|registry| {
        let registry = registry.borrow();
        let faces = registry
            .faces
            .iter()
            .map(|face| {
                serde_json::json!({
                    "aliases": face.aliases,
                    "bold": face.bold,
                    "italic": face.italic,
                    "unitsPerEm": face.units_per_em,
                    "mappedChars": face.advances.mapped,
                    "coversHangul": face.covers_hangul,
                    "pages": face.advances.page_count(),
                    "hits": face.hits.get(),
                })
            })
            .collect::<Vec<_>>();
        serde_json::Value::Array(faces).to_string()
    })
}

/// wasm `registerRuntimeFontMetrics` 본체: 별칭 JSON 파싱 + 등록 + 결과 JSON.
pub(crate) fn register_json(bytes: &[u8], aliases_json: &str, bold: bool, italic: bool) -> String {
    let result = serde_json::from_str::<Vec<String>>(aliases_json)
        .map_err(|err| format!("invalid aliases json: {err}"))
        .and_then(|aliases| register(bytes, &aliases, bold, italic));
    match result {
        Ok(outcome) => serde_json::json!({
            "registered": true,
            "key": outcome.key,
            "unitsPerEm": outcome.units_per_em,
            "mappedChars": outcome.mapped_chars,
            "coversHangul": outcome.covers_hangul,
            "coversLatin": outcome.covers_latin,
            "replaced": outcome.replaced,
        })
        .to_string(),
        Err(reason) => serde_json::json!({ "registered": false, "reason": reason }).to_string(),
    }
}

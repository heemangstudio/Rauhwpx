//! 사용자 PC 에 설치된 한컴 HFT 서체에서 글리프 윤곽선을 읽는다.
//!
//! 한컴은 HFT 서체(신명 신그래픽 등)를 자체 윤곽선으로 그린다. 레이아웃은 지금처럼
//! 측정 경로(대체 서체/HFT 폭 테이블)를 쓰고, 그리기 단계에서만 이 윤곽선으로
//! 글자 모양을 바꾼다. 서체 파일은 런타임에 읽기만 하고 저장소에 복사하지 않는다.
//!
//! # HFT 1.0 구조 (역분석, 리틀엔디언)
//!
//! - `0x00` 매직 `Han Unified Font File 1.0\x1a`, `0x6c` 조합형(Johab) family 이름,
//!   `0x1aa` 폭 테이블 주소, `0x1ae` 윤곽선 블록 주소.
//! - 윤곽선 블록 `+4` em 단위, `+8` 하위 테이블 수(라틴 1, 한글/한자 2),
//!   `+20/+22/+24` 시작 코드·끝 코드·글리프 수.
//! - 라틴 은행(하위 테이블 1개): `+34` 기준 `+36` 부터 u32 오프셋. 글리프 기록은
//!   `기준+오프셋+2` 에서 bbox 4×i16, u16 길이, 명령열.
//! - 한글(KS X 1001 완성형 2350자)·한자(4888자) 은행(하위 테이블 2개): `+38` 기준
//!   `+40` 부터 u32 오프셋. 글리프 기록은 `기준+오프셋+2` 에서 u16 길이, 명령열.
//!   글리프 순서는 KS X 1001 행열 순서다.
//! - 명령열은 Type 1 과 비슷한 상대 좌표 윤곽선이다. y 는 em 상자 바닥에서 위로
//!   잰다(첫 moveto 는 (왼쪽 여백, 200)). closepath 는 현재점을 그 윤곽 시작점으로
//!   되돌린다. 한컴은 em 상자 바닥을 기준선 아래 0.15em 에 둔다 (HWP 기준선 85%).
//!   `0x40..=0x43` 은 hint(무시), `0` 은 끝이다.
//!
//! 한양 계열은 명시된 flavor 의 순환 XOR 를 해제한 뒤 끝 명령까지 검증한다.
//! 연결된 벡터 레코드에서 ASCII·KS 한글·KS 한자 은행만 읽으며, 비트맵과
//! 별도 코드표가 필요한 확장 문자 은행은 건너뛴다.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, RwLock};

const MAGIC: &[u8] = b"Han Unified Font File 1.0\x1a";
const HANYANG_FLAVOR: &[u8] = b"Hanyang outline font for HWP 2.1";
/// em 상자 바닥에서 기준선까지 (em 비율). 한컴 PDF 실측: exam-social 의 신명
/// 신그래픽 40pt·중명조 11.5pt·디나루 21pt 글리프가 모두 이 기준선에 놓인다.
const HFT_BASELINE_EM: f32 = 0.15;

/// 윤곽선 명령 (em 단위, y 위쪽 양수, 원점 = 글자 기준점).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum HftPathCmd {
    MoveTo(f32, f32),
    LineTo(f32, f32),
    CubicTo(f32, f32, f32, f32, f32, f32),
    Close,
}

/// 한 글자의 윤곽선.
#[derive(Debug, Clone, PartialEq)]
pub struct HftGlyph {
    pub units_per_em: f32,
    pub commands: Vec<HftPathCmd>,
}

impl HftGlyph {
    /// 글자 크기·장평으로 변환한 명령열. y 는 화면 좌표(아래쪽 양수), 원점은 기준점.
    pub fn scaled(&self, font_size: f64, ratio: f64) -> impl Iterator<Item = HftPathCmd> + '_ {
        let sy = (font_size / f64::from(self.units_per_em)) as f32;
        let sx = sy * ratio as f32;
        self.commands.iter().map(move |cmd| match *cmd {
            HftPathCmd::MoveTo(x, y) => HftPathCmd::MoveTo(x * sx, -y * sy),
            HftPathCmd::LineTo(x, y) => HftPathCmd::LineTo(x * sx, -y * sy),
            HftPathCmd::CubicTo(x1, y1, x2, y2, x, y) => {
                HftPathCmd::CubicTo(x1 * sx, -y1 * sy, x2 * sx, -y2 * sy, x * sx, -y * sy)
            }
            HftPathCmd::Close => HftPathCmd::Close,
        })
    }

    /// SVG path `d` 문자열 (화면 좌표, 원점 = 기준점 + (ox, oy)).
    pub fn svg_path_data(&self, font_size: f64, ratio: f64, ox: f64, oy: f64) -> String {
        use std::fmt::Write;
        let (ox, oy) = (ox as f32, oy as f32);
        let mut d = String::new();
        for cmd in self.scaled(font_size, ratio) {
            let _ = match cmd {
                HftPathCmd::MoveTo(x, y) => write!(d, "M{:.2} {:.2}", ox + x, oy + y),
                HftPathCmd::LineTo(x, y) => write!(d, "L{:.2} {:.2}", ox + x, oy + y),
                HftPathCmd::CubicTo(x1, y1, x2, y2, x, y) => write!(
                    d,
                    "C{:.2} {:.2} {:.2} {:.2} {:.2} {:.2}",
                    ox + x1,
                    oy + y1,
                    ox + x2,
                    oy + y2,
                    ox + x,
                    oy + y
                ),
                HftPathCmd::Close => write!(d, "Z"),
            };
        }
        d
    }
}

/// 은행 종류: 글자 → 글리프 번호 대응 방식.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BankKind {
    /// 코드 = 유니코드 (ASCII 범위만 대응한다).
    Latin { first: u16 },
    /// KS X 1001 한글 2350자 (0xB0A1..)
    Hangul,
    /// KS X 1001 한자 4888자 (0xCAA1..)
    Hanja,
}

struct BankLayout {
    kind: BankKind,
    units: u16,
    /// 글리프 오프셋 표의 시작 주소이자 상대 오프셋의 기준 주소.
    table: usize,
    count: usize,
    end: usize,
    has_bbox: bool,
    hanyang: bool,
    /// 한글 은행 옆 요소의 낱자모 글리프 (조합형 코드 표 순서).
    jamo: Option<JamoTable>,
}

/// 조합 중 단독 자모(ㄱ..ㅎ, ㅏ..ㅣ)는 2350자 음절 표 밖의 별도 요소에 있다.
struct JamoTable {
    codes: Vec<u16>,
    table: usize,
    end: usize,
    has_bbox: bool,
}

struct Bank {
    data: Arc<[u8]>,
    layout: BankLayout,
}

/// 은행은 처음 쓰일 때 파일 전체를 읽는다 (한컴 Fonts 폴더는 180MB 가량).
enum Slot {
    #[cfg(not(target_arch = "wasm32"))]
    Pending(std::path::PathBuf),
    Ready(Bank),
    Rejected,
}

impl Slot {
    fn bank(&mut self) -> Option<&Bank> {
        #[cfg(not(target_arch = "wasm32"))]
        if let Slot::Pending(path) = self {
            *self = std::fs::read(&*path)
                .ok()
                .and_then(|bytes| Bank::parse(Arc::from(bytes)))
                .map_or(Slot::Rejected, |(_, bank)| Slot::Ready(bank));
        }
        match self {
            Slot::Ready(bank) => Some(bank),
            _ => None,
        }
    }
}

#[derive(Default)]
struct Family {
    latin: Option<Slot>,
    hangul: Option<Slot>,
    hanja: Option<Slot>,
}

impl Family {
    fn slot_mut(&mut self, kind: BankKind) -> &mut Option<Slot> {
        match kind {
            BankKind::Latin { .. } => &mut self.latin,
            BankKind::Hangul => &mut self.hangul,
            BankKind::Hanja => &mut self.hanja,
        }
    }
}

#[derive(Default)]
struct Registry {
    families: HashMap<String, Family>,
    glyphs: HashMap<(String, char), Option<Arc<HftGlyph>>>,
    rectangular_hyphens: HashMap<String, Arc<HftGlyph>>,
    latin_advances: HashMap<String, LatinAdvances>,
    #[cfg(not(target_arch = "wasm32"))]
    scanned: std::collections::BTreeSet<std::path::PathBuf>,
}

static REGISTRY: LazyLock<RwLock<Registry>> = LazyLock::new(|| RwLock::new(Registry::default()));

fn u16_at(data: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        data.get(at..at.checked_add(2)?)?.try_into().ok()?,
    ))
}

fn u32_at(data: &[u8], at: usize) -> Option<usize> {
    Some(u32::from_le_bytes(data.get(at..at.checked_add(4)?)?.try_into().ok()?) as usize)
}

/// 조합형 2바이트 한글 음절 → 유니코드. 채움 자모가 섞이면 None.
fn johab_syllable(code: u16) -> Option<char> {
    const JUNG: [u8; 21] = [
        3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 18, 19, 20, 21, 22, 23, 26, 27, 28, 29,
    ];
    let cho = ((code >> 10) & 0x1f) as u8;
    let jung = ((code >> 5) & 0x1f) as u8;
    let jong = (code & 0x1f) as u8;
    if !(2..=20).contains(&cho) {
        return None;
    }
    let jung = JUNG.iter().position(|&v| v == jung)? as u32;
    let jong = match jong {
        1 => 0,
        2..=17 => u32::from(jong) - 1,
        19..=29 => u32::from(jong) - 2,
        _ => return None,
    };
    char::from_u32(0xAC00 + ((u32::from(cho) - 2) * 21 + jung) * 28 + jong)
}

/// 0x6c 의 조합형 family 이름 (ASCII + 한글 음절).
fn family_name(data: &[u8]) -> Option<String> {
    let raw = data.get(0x6c..0x8c)?;
    let raw = &raw[..raw.iter().position(|&b| b == 0).unwrap_or(raw.len())];
    let mut name = String::new();
    let mut i = 0;
    while i < raw.len() {
        let b = raw[i];
        if b < 0x80 {
            name.push(b as char);
            i += 1;
        } else {
            let code = u16::from_be_bytes([b, *raw.get(i + 1)?]);
            name.push(johab_syllable(code)?);
            i += 2;
        }
    }
    let name = name.trim().to_string();
    (!name.is_empty()).then_some(name)
}

/// 명령열을 해석한다. 지원하지 않는 명령·범위 초과는 None.
fn decode_outline(bytes: &[u8], units: f32) -> Option<Vec<HftPathCmd>> {
    decode_outline_stream(bytes, units, false)
}

fn decode_outline_stream(bytes: &[u8], units: f32, hanyang: bool) -> Option<Vec<HftPathCmd>> {
    let mut at = 0usize;
    let mut read = || -> Option<u8> {
        let v = *bytes.get(at)?;
        at += 1;
        Some(v)
    };
    let mut out = Vec::new();
    let (mut x, mut y) = (0i32, 0i32);
    let mut start = (0i32, 0i32);
    let mut open = false;
    let mut terminated = false;
    let limit = (units as i32) * 8;
    loop {
        let Some(op) = read() else { break };
        // 숫자: -123..=123 은 1바이트, 0x7c..0x7f / 0x81..0x84 는 2바이트,
        // 0x80 은 i16 리틀엔디언 (hint 에서만 관찰된다).
        let mut number = |read: &mut dyn FnMut() -> Option<u8>| -> Option<i32> {
            let v = read()?;
            Some(match v {
                0x7c..=0x7f => i32::from(v - 0x7c) * 256 + 124 + i32::from(read()?),
                0x81..=0x84 => -(i32::from(0x84 - v) * 256 + 124 + i32::from(read()?)),
                0x80 => i32::from(i16::from_le_bytes([read()?, read()?])),
                _ => i32::from(v as i8),
            })
        };
        let point = |x: &mut i32, y: &mut i32, dx: i32, dy: i32| -> Option<(f32, f32)> {
            *x += dx;
            *y += dy;
            if x.abs() > limit || y.abs() > limit {
                return None;
            }
            Some((*x as f32, *y as f32 - units * HFT_BASELINE_EM))
        };
        match op {
            0 => {
                terminated = true;
                break;
            }
            1..=3 => {
                let dx = if op != 2 { number(&mut read)? } else { 0 };
                let dy = if op != 1 { number(&mut read)? } else { 0 };
                if open {
                    out.push(HftPathCmd::Close);
                }
                let (px, py) = point(&mut x, &mut y, dx, dy)?;
                start = (x, y);
                out.push(HftPathCmd::MoveTo(px, py));
                open = true;
            }
            4 => {
                if open {
                    if hanyang {
                        // 한양 인터프리터는 시작점으로 선을 긋고 같은 윤곽을 이어 그린다.
                        out.push(HftPathCmd::LineTo(
                            start.0 as f32,
                            start.1 as f32 - units * HFT_BASELINE_EM,
                        ));
                    } else {
                        out.push(HftPathCmd::Close);
                        open = false;
                    }
                }
                (x, y) = start;
            }
            5..=7 => {
                let dx = if op != 6 { number(&mut read)? } else { 0 };
                let dy = if op != 5 { number(&mut read)? } else { 0 };
                if !open {
                    return None;
                }
                let (px, py) = point(&mut x, &mut y, dx, dy)?;
                out.push(HftPathCmd::LineTo(px, py));
            }
            9..=11 => {
                if !open {
                    return None;
                }
                let a_dx = if op != 10 { number(&mut read)? } else { 0 };
                let a_dy = if op != 9 { number(&mut read)? } else { 0 };
                let a = point(&mut x, &mut y, a_dx, a_dy)?;
                let b_dx = number(&mut read)?;
                let b_dy = number(&mut read)?;
                let b = point(&mut x, &mut y, b_dx, b_dy)?;
                let c_dx = if op != 9 { number(&mut read)? } else { 0 };
                let c_dy = if op != 10 { number(&mut read)? } else { 0 };
                let c = point(&mut x, &mut y, c_dx, c_dy)?;
                out.push(HftPathCmd::CubicTo(a.0, a.1, b.0, b.1, c.0, c.1));
            }
            0x40..=0x43 => {
                for _ in 0..if op % 2 == 0 { 2 } else { 6 } {
                    number(&mut read)?;
                }
            }
            0x20 if hanyang => {
                let first = usize::from(read()?);
                for _ in 0..first * 2 + 1 {
                    read()?;
                }
                let second = usize::from(read()?);
                for _ in 0..second * 2 {
                    read()?;
                }
            }
            0x21 if hanyang => {
                let count = read()?;
                for _ in 0..count {
                    let length = read()?;
                    for _ in 0..length {
                        read()?;
                    }
                }
            }
            0x22 | 0x23 if hanyang => {
                read()?;
            }
            0x44 if hanyang => {}
            _ => return None,
        }
    }
    if hanyang && (!terminated || at != bytes.len()) {
        return None;
    }
    if open {
        out.push(HftPathCmd::Close);
    }
    Some(out)
}

/// 한양 드라이버의 순환 XOR. 상태는 암호문 바이트로 갱신한다.
fn decrypt_hanyang(bytes: &[u8]) -> Vec<u8> {
    let mut state = 0xe696u32;
    bytes
        .iter()
        .map(|&encrypted| {
            let plain = encrypted ^ (state >> 8) as u8;
            state = (u32::from(encrypted) + (state & 0xffff))
                .wrapping_mul(0xc73e)
                .wrapping_add(0xc863);
            plain
        })
        .collect()
}

/// 머리말(0..0x200)과 윤곽선 블록 머리(40바이트)만으로 은행 종류를 판별한다.
fn classify(head: &[u8], outline: &[u8]) -> Option<(String, BankKind, u16, usize)> {
    if !head.starts_with(MAGIC) || head.len() < 0x200 {
        return None;
    }
    let family = family_name(head)?;
    let units = u16_at(outline, 4)?;
    let subtables = u16_at(outline, 8)?;
    let first = u16_at(outline, 20)?;
    let last = u16_at(outline, 22)?;
    let count = usize::from(u16_at(outline, 24)?);
    if !(256..=4096).contains(&units) || count == 0 {
        return None;
    }
    let kind = match (subtables, first, last, count) {
        (1, 0x20, 0x7e..=0xff, _) if count == usize::from(last - first) + 1 => {
            BankKind::Latin { first }
        }
        (2, 0x8000, 0xffff, 2350) => BankKind::Hangul,
        (2, 0x4000, 0x5317, 4888) => BankKind::Hanja,
        _ => return None,
    };
    Some((family, kind, units, count))
}

fn read_at<const N: usize, R: std::io::Read + std::io::Seek>(
    reader: &mut R,
    at: usize,
) -> Option<[u8; N]> {
    reader.seek(std::io::SeekFrom::Start(at as u64)).ok()?;
    let mut bytes = [0u8; N];
    reader.read_exact(&mut bytes).ok()?;
    Some(bytes)
}

/// 파일 검색과 바이트 가져오기가 같은 은행 선택·경계 검사를 공유한다.
fn bank_layout<R: std::io::Read + std::io::Seek>(reader: &mut R) -> Option<(String, BankLayout)> {
    let file_end = usize::try_from(reader.seek(std::io::SeekFrom::End(0)).ok()?).ok()?;
    let head = read_at::<512, _>(reader, 0)?;
    if !head.starts_with(MAGIC) {
        return None;
    }
    let family = family_name(&head)?;
    let mut at = u32_at(&head, 0x1ae)?;
    let flavor = &head[0x134..0x154];
    let flavor = &flavor[..flavor.iter().position(|&b| b == 0).unwrap_or(flavor.len())];
    if flavor != HANYANG_FLAVOR {
        // 기존 평문 은행의 선택과 좌표는 바꾸지 않는다.
        let outline = read_at::<40, _>(reader, at)?;
        let (_, kind, units, count) = classify(&head, &outline)?;
        let jamo = if kind == BankKind::Hangul {
            let distance = u32_at(&outline, 0)?;
            let record_end = if distance == 0 {
                file_end
            } else {
                at.checked_add(distance)?.min(file_end)
            };
            jamo_table(
                reader,
                at.checked_add(usize::from(u16_at(&outline, 10)?))?,
                usize::from(u16_at(&outline, 8)?),
                record_end,
            )
        } else {
            None
        };
        let table = at.checked_add(if matches!(kind, BankKind::Latin { .. }) {
            36
        } else {
            40
        })?;
        if table.checked_add(count.checked_mul(4)?)? > file_end {
            return None;
        }
        return Some((
            family,
            BankLayout {
                kind,
                units,
                table,
                count,
                end: file_end,
                has_bbox: matches!(kind, BankKind::Latin { .. }),
                hanyang: false,
                jamo,
            },
        ));
    }

    let records = usize::from(u16_at(&head, 0x1a6)?) + usize::from(u16_at(&head, 0x1a8)?);
    if records == 0 || records > file_end.saturating_sub(512) / 12 || at < 512 {
        return None;
    }
    for record_index in 0..records {
        let record = read_at::<12, _>(reader, at)?;
        let distance = u32_at(&record, 0)?;
        let end = if distance == 0 && record_index + 1 == records {
            file_end
        } else {
            at.checked_add(distance)?
        };
        let rel = usize::from(u16_at(&record, 10)?);
        if rel < 12 || end > file_end || at.checked_add(rel)? >= end {
            return None;
        }
        let units = u16_at(&record, 4)?;
        if u16_at(&record, 6)? != 0 {
            if !(256..=4096).contains(&units) {
                return None;
            }
            let elements = usize::from(u16_at(&record, 8)?);
            let mut element_at = at.checked_add(rel)?;
            if elements == 0 || elements > (end - element_at) / 22 {
                return None;
            }
            for element_index in 0..elements {
                if element_at.checked_add(22)? > end {
                    return None;
                }
                let element = read_at::<22, _>(reader, element_at)?;
                let distance = u32_at(&element, 0)?;
                let element_end = if distance == 0 && element_index + 1 == elements {
                    end
                } else {
                    element_at.checked_add(distance)?
                };
                let data_at = element_at.checked_add(22)?;
                if element_end < data_at || element_end > end {
                    return None;
                }
                let flags = u16_at(&element, 4)?;
                let first = u16_at(&element, 6)?;
                let last = u16_at(&element, 8)?;
                let count = usize::from(u16_at(&element, 10)?);
                let mut table = data_at;
                let mut kstbl = false;
                if matches!(flags & 0xf, 1 | 2 | 4) {
                    if data_at.checked_add(4)? > element_end {
                        return None;
                    }
                    let block = u32_at(&read_at::<4, _>(reader, data_at)?, 0)?;
                    let block_len = if block & 0x8000_0000 != 0 {
                        4
                    } else {
                        block & 0xffff
                    };
                    if block_len < 4 {
                        return None;
                    }
                    table = data_at.checked_add(block_len)?;
                    kstbl = block == 0xffff_0004;
                }
                if table > element_end {
                    return None;
                }
                let kind = match (flags & 0x6f, first, last, count) {
                    (0 | 3, 0x20, 0x7e..=0xff, _) if count == usize::from(last - first) + 1 => {
                        Some(BankKind::Latin { first })
                    }
                    // HncGetKSTblPtr 의 2350개 조합형 코드는 KS X 1001 행열 순서다.
                    (1, 0x8000, 0xffff, 2350) if kstbl => Some(BankKind::Hangul),
                    (0 | 3, 0x4000, 0x5317, 4888) => Some(BankKind::Hanja),
                    _ => None,
                };
                if let Some(kind) = kind {
                    if table.checked_add(count.checked_mul(4)?)? > element_end {
                        return None;
                    }
                    let jamo = (kind == BankKind::Hangul)
                        .then(|| jamo_table(reader, at.checked_add(rel)?, elements, end))
                        .flatten();
                    return Some((
                        family,
                        BankLayout {
                            kind,
                            units,
                            table,
                            count,
                            end: element_end,
                            has_bbox: flags & 0x10 == 0,
                            hanyang: true,
                            jamo,
                        },
                    ));
                }
                element_at = element_end;
            }
        }
        at = end;
    }
    None
}

/// 같은 레코드의 요소 중 낱자모 요소를 찾는다: 조합형 코드 표(블록 머리 4바이트 +
/// 코드당 2바이트) 뒤에 글리프 오프셋 표가 온다. 구조가 어긋나면 낱자모 없이 둔다.
fn jamo_table<R: std::io::Read + std::io::Seek>(
    reader: &mut R,
    mut element_at: usize,
    elements: usize,
    record_end: usize,
) -> Option<JamoTable> {
    for element_index in 0..elements {
        let element = read_at::<22, _>(reader, element_at)?;
        let distance = u32_at(&element, 0)?;
        let element_end = if distance == 0 && element_index + 1 == elements {
            record_end
        } else {
            element_at.checked_add(distance)?
        };
        let data_at = element_at.checked_add(22)?;
        if element_end < data_at || element_end > record_end {
            return None;
        }
        let flags = u16_at(&element, 4)?;
        let first = u16_at(&element, 6)?;
        let last = u16_at(&element, 8)?;
        let count = usize::from(u16_at(&element, 10)?);
        if flags & 0xf == 1 && (first, last) == (0x8000, 0xffff) && (1..=94).contains(&count) {
            let block = u32_at(&read_at::<4, _>(reader, data_at)?, 0)?;
            let block_len = 4 + 2 * count;
            let table = data_at.checked_add(block_len)?;
            if block & 0x8000_0000 == 0
                && block & 0xffff == block_len
                && table.checked_add(count * 4)? <= element_end
            {
                reader
                    .seek(std::io::SeekFrom::Start(data_at as u64 + 4))
                    .ok()?;
                let mut raw = vec![0u8; count * 2];
                reader.read_exact(&mut raw).ok()?;
                return Some(JamoTable {
                    codes: raw
                        .chunks_exact(2)
                        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                        .collect(),
                    table,
                    end: element_end,
                    has_bbox: flags & 0x10 == 0,
                });
            }
        }
        element_at = element_end;
    }
    None
}

/// 단독 자모 → 채움 자모를 넣은 조합형 코드. 호환 자모와 첫가끝 자모를 함께 받는다.
fn johab_jamo(ch: char) -> Option<u16> {
    const JUNG: [u16; 21] = [
        3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 18, 19, 20, 21, 22, 23, 26, 27, 28, 29,
    ];
    const INITIAL: &str = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
    const FINAL: &str = "ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ";
    let initial = |consonant: char| INITIAL.chars().position(|c| c == consonant);
    let code = ch as u32;
    let (cho, jung) = match code {
        0x314f..=0x3163 => (1, JUNG[(code - 0x314f) as usize]),
        0x1161..=0x1175 => (1, JUNG[(code - 0x1161) as usize]),
        0x1100..=0x1112 => (code as usize - 0x1100 + 2, 2),
        0x11a8..=0x11c2 => (initial(FINAL.chars().nth(code as usize - 0x11a8)?)? + 2, 2),
        _ => (initial(ch)? + 2, 2),
    };
    Some(0x8000 | (cho as u16) << 10 | jung << 5 | 1)
}

impl Bank {
    fn parse(data: Arc<[u8]>) -> Option<(String, Bank)> {
        let (family, layout) = bank_layout(&mut std::io::Cursor::new(&*data))?;
        let mut bank = Bank { data, layout };
        // 한양은 모든 슬롯을 검증하여 잘못된 암호·잘린 명령열을 은행 등록 전에 거절한다.
        let count = bank.layout.count;
        let step = if bank.layout.hanyang {
            1
        } else {
            (count / 64).max(1)
        };
        let mut decoded = 0;
        for index in (0..count).step_by(step) {
            match bank.record(index) {
                Some(Some(_)) => decoded += 1,
                Some(None) => {}
                None => return None,
            }
        }
        let jamo_count = bank.layout.jamo.as_ref().map_or(0, |jamo| jamo.codes.len());
        if (0..jamo_count).any(|index| bank.jamo_record(index).is_none()) {
            bank.layout.jamo = None;
        }
        (decoded > 0).then_some((family, bank))
    }

    /// 글자의 윤곽선: 본 표를 먼저 보고, 한글 은행이면 낱자모 요소로 이어간다.
    fn commands(&self, ch: char) -> Option<Vec<HftPathCmd>> {
        if let Some(index) = self.index_of(ch) {
            return self.record(index)?;
        }
        let jamo = self.layout.jamo.as_ref()?;
        let code = johab_jamo(ch)?;
        let index = jamo.codes.iter().position(|&c| c == code)?;
        self.jamo_record(index)?
    }

    /// 글리프 기록을 해석한다. 바깥 None = 손상, 안쪽 None = 잉크 없음.
    fn record(&self, index: usize) -> Option<Option<Vec<HftPathCmd>>> {
        let layout = &self.layout;
        self.record_in(
            layout.table,
            layout.count,
            layout.end,
            layout.has_bbox,
            index,
        )
    }

    fn jamo_record(&self, index: usize) -> Option<Option<Vec<HftPathCmd>>> {
        let jamo = self.layout.jamo.as_ref()?;
        self.record_in(jamo.table, jamo.codes.len(), jamo.end, jamo.has_bbox, index)
    }

    fn record_in(
        &self,
        table: usize,
        count: usize,
        end: usize,
        has_bbox: bool,
        index: usize,
    ) -> Option<Option<Vec<HftPathCmd>>> {
        let data = &self.data;
        let layout = &self.layout;
        if index >= count {
            return None;
        }
        let offset = u32_at(data, table.checked_add(index.checked_mul(4)?)?)?;
        if layout.hanyang && offset == 0 {
            return Some(None);
        }
        let start = table.checked_add(offset)?;
        let header = if has_bbox { 10 } else { 2 };
        let body_at = start.checked_add(header)?;
        if body_at > end || (layout.hanyang && start < table + count * 4) {
            return None;
        }
        let length_at = body_at - 2;
        let length = usize::from(u16_at(data, length_at)?);
        if length == 0 {
            return Some(None);
        }
        let body_end = body_at.checked_add(length)?;
        if body_end > end {
            return None;
        }
        let body = data.get(body_at..body_end)?;
        let commands = if layout.hanyang {
            decode_outline_stream(&decrypt_hanyang(body), f32::from(layout.units), true)?
        } else {
            decode_outline(body, f32::from(layout.units))?
        };
        let inked = commands
            .iter()
            .any(|cmd| !matches!(cmd, HftPathCmd::MoveTo(..) | HftPathCmd::Close));
        Some(inked.then_some(commands))
    }

    fn index_of(&self, ch: char) -> Option<usize> {
        let index = match self.layout.kind {
            BankKind::Latin { first } => {
                let code = ch as u32;
                if !(0x21..=0x7e).contains(&code) {
                    return None;
                }
                (code - u32::from(first)) as usize
            }
            BankKind::Hangul => ks_index(ch, 0xB0)?,
            BankKind::Hanja => ks_index(ch, 0xCA)?,
        };
        (index < self.layout.count).then_some(index)
    }
}

/// KS X 1001 행열 순서 번호 (lead 행부터, 행당 94자).
fn ks_index(ch: char, first_lead: u8) -> Option<usize> {
    let mut buf = [0u8; 4];
    let (bytes, _, had_errors) = encoding_rs::EUC_KR.encode(ch.encode_utf8(&mut buf));
    if had_errors || bytes.len() != 2 || bytes[0] < first_lead || !(0xA1..=0xFE).contains(&bytes[1])
    {
        return None;
    }
    Some(usize::from(bytes[0] - first_lead) * 94 + usize::from(bytes[1] - 0xA1))
}

/// 암호화 라틴 은행의 얇은 사각 하이픈은 평문 bbox 로 복원할 수 있다.
/// 14바이트 사각 기록만 받으며, 다른 암호화 글자는 기존 대체 서체를 쓴다.
/// bbox 는 양끝 포함: (x, top, width, height) 에서 실제 폭·높이는 각각 1을 뺀다.
fn rectangular_hyphen<R: std::io::Read + std::io::Seek>(
    reader: &mut R,
) -> Option<(String, HftGlyph)> {
    use std::io::SeekFrom;
    let mut head = [0u8; 0x200];
    reader.read_exact(&mut head).ok()?;
    if !head.starts_with(MAGIC) {
        return None;
    }
    let family = family_name(&head)?;
    let mut at = u32_at(&head, 0x1ae)?;
    // 비트맵/특수문자 은행 다음에 오는 라틴 윤곽선도 찾는다.
    for _ in 0..16 {
        reader.seek(SeekFrom::Start(at as u64)).ok()?;
        let mut header = [0u8; 40];
        reader.read_exact(&mut header).ok()?;
        let length = u32_at(&header, 0)?;
        if length < 40 {
            return None;
        }
        let end = at.checked_add(length)?;
        let units = u16_at(&header, 4)?;
        let first = u16_at(&header, 20)?;
        let last = u16_at(&header, 22)?;
        let count = u16_at(&header, 24)?;
        if (256..=4096).contains(&units)
            && (0x20..=0x2d).contains(&first)
            && (0x2d..=0xff).contains(&last)
            && count == last - first + 1
        {
            let base = at.checked_add(34)?;
            let index = usize::from(0x2d - first);
            reader
                .seek(SeekFrom::Start((base + 2 + 4 * index) as u64))
                .ok()?;
            let mut offset = [0u8; 4];
            reader.read_exact(&mut offset).ok()?;
            let start = base.checked_add(u32_at(&offset, 0)?)?.checked_add(2)?;
            if start < base + 2 + 4 * usize::from(count) || start.checked_add(24)? > end {
                return None;
            }
            reader.seek(SeekFrom::Start(start as u64)).ok()?;
            let mut record = [0u8; 24];
            reader.read_exact(&mut record).ok()?;
            if u16_at(&record, 8)? != 14 || record[10] != 0xe5 {
                return None;
            }
            let x = i16::from_le_bytes(record[0..2].try_into().ok()?) as f32;
            let top = i16::from_le_bytes(record[2..4].try_into().ok()?) as f32;
            let width = i16::from_le_bytes(record[4..6].try_into().ok()?) as f32;
            let height = i16::from_le_bytes(record[6..8].try_into().ok()?) as f32;
            let em = f32::from(units);
            if x < 0.0
                || top < 0.0
                || top > em
                || width < 4.0 * height
                || height <= 1.0
                || height > em * 0.1
                || x + width > em
            {
                return None;
            }
            let x1 = x + width - 1.0;
            let bottom = top - height - em * HFT_BASELINE_EM;
            let top = top - 1.0 - em * HFT_BASELINE_EM;
            return Some((
                family,
                HftGlyph {
                    units_per_em: em,
                    commands: vec![
                        HftPathCmd::MoveTo(x, bottom),
                        HftPathCmd::LineTo(x1, bottom),
                        HftPathCmd::LineTo(x1, top),
                        HftPathCmd::LineTo(x, top),
                        HftPathCmd::Close,
                    ],
                },
            ));
        }
        at = end;
    }
    None
}

/// HFT 폭 디렉터리는 윤곽선 암호화와 무관한 1000em 단위의 평문이다.
struct LatinAdvances {
    first: u16,
    widths: Vec<u16>,
}

fn latin_advances<R: std::io::Read + std::io::Seek>(
    reader: &mut R,
) -> Option<(String, LatinAdvances)> {
    use std::io::SeekFrom;
    let mut head = [0u8; 512];
    reader.seek(SeekFrom::Start(0)).ok()?;
    reader.read_exact(&mut head).ok()?;
    if !head.starts_with(MAGIC) {
        return None;
    }
    let family = family_name(&head)?;
    let at = u32_at(&head, 0x1aa)?;
    let mut directory = [0u8; 10];
    reader.seek(SeekFrom::Start(at as u64)).ok()?;
    reader.read_exact(&mut directory).ok()?;
    let length = u32_at(&directory, 0)?;
    let first = u16_at(&directory, 4)?;
    let last = u16_at(&directory, 6)?;
    if first > 0x7e || last < first || last > 0xff || u16_at(&directory, 8)? != 1 {
        return None;
    }
    let count = usize::from(last - first) + 1;
    if length != 10 + count * 2 {
        return None;
    }
    let mut bytes = vec![0u8; count * 2];
    reader.read_exact(&mut bytes).ok()?;
    let widths: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    if widths.iter().any(|&width| width > 4000) {
        return None;
    }
    Some((family, LatinAdvances { first, widths }))
}

fn insert_latin_advances(advances: Option<(String, LatinAdvances)>) -> bool {
    let Some((family, advances)) = advances else {
        return false;
    };
    let Ok(mut registry) = REGISTRY.write() else {
        return false;
    };
    registry.latin_advances.entry(family).or_insert(advances);
    true
}

/// 원본 HFT 라틴 폭(em). 암호화 윤곽선을 대체 서체로 그릴 때도 원래 전진을 보존한다.
pub(crate) fn hft_advance_em(family: &str, ch: char) -> Option<f64> {
    let registry = REGISTRY.read().ok()?;
    let advances = registry.latin_advances.get(family.trim())?;
    let index = (ch as u32).checked_sub(u32::from(advances.first))? as usize;
    let width = *advances.widths.get(index)?;
    (width > 0).then_some(f64::from(width) / 1000.0)
}

fn insert_rectangular_hyphen(glyph: Option<(String, HftGlyph)>) -> bool {
    let Some((family, glyph)) = glyph else {
        return false;
    };
    let Ok(mut registry) = REGISTRY.write() else {
        return false;
    };
    registry
        .rectangular_hyphens
        .entry(family)
        .or_insert_with(|| Arc::new(glyph));
    true
}

fn insert_slot(family: String, kind: BankKind, slot: Slot) -> bool {
    let Ok(mut registry) = REGISTRY.write() else {
        return false;
    };
    registry.glyphs.retain(|(name, _), _| name != &family);
    let target = registry.families.entry(family).or_default().slot_mut(kind);
    // 같은 family 의 기울임/굵게 라틴 변형보다 먼저 온 기본 은행을 유지한다.
    if target.is_none() {
        *target = Some(slot);
    }
    true
}

/// HFT 파일 바이트를 등록한다 (wasm/Studio 가져오기). 지원하지 않는 은행이면 false.
pub fn register_hft_bytes(bytes: Vec<u8>) -> bool {
    let has_advances = insert_latin_advances(latin_advances(&mut std::io::Cursor::new(&bytes)));
    let has_hyphen =
        insert_rectangular_hyphen(rectangular_hyphen(&mut std::io::Cursor::new(&bytes)));
    let Some((family, bank)) = Bank::parse(Arc::from(bytes)) else {
        if has_hyphen || has_advances {
            super::layout::clear_measure_width_cache();
        }
        return has_hyphen || has_advances;
    };
    let kind = bank.layout.kind;
    let inserted = insert_slot(family, kind, Slot::Ready(bank));
    if inserted || has_advances || has_hyphen {
        super::layout::clear_measure_width_cache();
    }
    inserted
}

/// `.hft` 파일 판별.
#[cfg(not(target_arch = "wasm32"))]
pub fn is_hft_file(path: &std::path::Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("hft"))
}

/// 파일 머리만 읽어 family·은행 종류를 판별한다.
#[cfg(not(target_arch = "wasm32"))]
fn probe_hft_file(path: &std::path::Path) -> Option<(String, BankKind)> {
    let mut file = std::fs::File::open(path).ok()?;
    let (family, layout) = bank_layout(&mut file)?;
    Some((family, layout.kind))
}

/// 글꼴 source(파일/디렉터리, 비재귀) 안의 HFT 파일을 한 번씩 등록한다.
/// 머리만 읽고, 윤곽선은 그 은행의 글자를 처음 그릴 때 읽는다.
#[cfg(not(target_arch = "wasm32"))]
pub fn register_hft_sources(sources: &[std::path::PathBuf]) {
    for source in sources {
        let files: Vec<std::path::PathBuf> = if is_hft_file(source) {
            vec![source.clone()]
        } else if source.is_dir() {
            let Ok(entries) = std::fs::read_dir(source) else {
                continue;
            };
            let mut files: Vec<_> = entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| is_hft_file(path))
                .collect();
            files.sort();
            files
        } else {
            continue;
        };
        for file in files {
            let fresh = REGISTRY
                .write()
                .map(|mut registry| registry.scanned.insert(file.clone()))
                .unwrap_or(false);
            if !fresh {
                continue;
            }
            let mut changed = false;
            if let Ok(mut reader) = std::fs::File::open(&file) {
                changed |= insert_rectangular_hyphen(rectangular_hyphen(&mut reader));
                changed |= insert_latin_advances(latin_advances(&mut reader));
            }
            if let Some((family, kind)) = probe_hft_file(&file) {
                changed |= insert_slot(family, kind, Slot::Pending(file));
            }
            if changed {
                super::layout::clear_measure_width_cache();
            }
        }
    }
}

/// family 에 윤곽선을 읽을 수 있는 HFT 은행이 하나라도 있는가.
pub fn hft_family_available(family: &str) -> bool {
    REGISTRY
        .read()
        .map(|registry| {
            registry.families.contains_key(family.trim())
                || registry.rectangular_hyphens.contains_key(family.trim())
        })
        .unwrap_or(false)
}

/// 원본 은행에 윤곽이 없을 때만 쓰는 한양신명조 기호.
fn missing_hanyang_multiply(family: &str, ch: char) -> Option<Arc<HftGlyph>> {
    // HGSMJ 한글 은행과 SPSMJ 기호 은행, ENSMJ/TESMJEN 라틴 은행에는
    // U+00D7 윤곽이 없다. 한컴 Mac 의 작은 벡터 곱셈 기호를 세 렌더러가 공유한다.
    if family == "한양신명조" && ch == '×' {
        static MULTIPLY: LazyLock<Arc<HftGlyph>> = LazyLock::new(|| {
            Arc::new(HftGlyph {
                units_per_em: 1000.0,
                commands: vec![
                    HftPathCmd::MoveTo(512.0, 172.0),
                    HftPathCmd::LineTo(334.0, 349.0),
                    HftPathCmd::LineTo(509.0, 524.0),
                    HftPathCmd::LineTo(485.0, 549.0),
                    HftPathCmd::LineTo(309.0, 374.0),
                    HftPathCmd::LineTo(134.0, 548.0),
                    HftPathCmd::LineTo(108.0, 525.0),
                    HftPathCmd::LineTo(283.0, 350.0),
                    HftPathCmd::LineTo(101.0, 170.0),
                    HftPathCmd::LineTo(128.0, 144.0),
                    HftPathCmd::LineTo(308.0, 324.0),
                    HftPathCmd::LineTo(487.0, 146.0),
                    HftPathCmd::Close,
                ],
            })
        });
        return Some(MULTIPLY.clone());
    }
    None
}

/// `family` HFT 서체의 `ch` 윤곽선. 원본 은행을 우선하고, 누락된 기호만 보완한다.
pub fn hft_glyph(family: &str, ch: char) -> Option<Arc<HftGlyph>> {
    let family = family.trim();
    if family.is_empty() {
        return None;
    }
    let key = (family.to_string(), ch);
    {
        let registry = REGISTRY.read().ok()?;
        if ch == '-' {
            if let Some(glyph) = registry.rectangular_hyphens.get(family) {
                return Some(glyph.clone());
            }
        }
        if let Some(hit) = registry.glyphs.get(&key) {
            return hit.clone().or_else(|| missing_hanyang_multiply(family, ch));
        }
        if !registry.families.contains_key(family) {
            return missing_hanyang_multiply(family, ch);
        }
    }
    let mut registry = REGISTRY.write().ok()?;
    let glyph = registry.families.get_mut(family).and_then(|slot| {
        [&mut slot.hangul, &mut slot.latin, &mut slot.hanja]
            .into_iter()
            .flatten()
            .find_map(|slot| {
                let bank = slot.bank()?;
                let commands = bank.commands(ch)?;
                Some(Arc::new(HftGlyph {
                    units_per_em: f32::from(bank.layout.units),
                    commands,
                }))
            })
    });
    registry.glyphs.insert(key, glyph.clone());
    glyph.or_else(|| missing_hanyang_multiply(family, ch))
}

/// 텍스트의 모든 그릴 글자(공백·제어 제외)를 이 HFT 서체가 그릴 수 있는가.
///
/// 한 run 안에서 HFT 글자와 대체 서체 글자가 섞이면 획 모양이 갈라져 보이므로
/// 렌더러는 글자 단위로 HFT 를 쓰되, 이 함수로 run 전체 적용 여부를 정할 수 있다.
pub fn hft_covers(family: &str, text: &str) -> bool {
    text.chars()
        .filter(|ch| !ch.is_whitespace() && !ch.is_control())
        .all(|ch| hft_glyph(family, ch).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAIN_RECTANGLE: &[u8] = &[3, 10, 20, 5, 30, 6, 40, 4, 0];
    const HANYANG_RECTANGLE: &[u8] = &[229, 127, 232, 245, 14, 99, 195, 161, 78];

    fn hanyang_rectangle_commands() -> Vec<HftPathCmd> {
        vec![
            HftPathCmd::MoveTo(10.0, -130.0),
            HftPathCmd::LineTo(40.0, -130.0),
            HftPathCmd::LineTo(40.0, -90.0),
            HftPathCmd::LineTo(10.0, -130.0),
            HftPathCmd::Close,
        ]
    }

    /// 실제 서체 바이트 없이 만든 ASCII 은행. 앞 레코드·요소는 미지원 코드 범위다.
    fn hanyang_fixture(chained: bool) -> Vec<u8> {
        let record_at = if chained { 548 } else { 512 };
        let element_at = record_at + 14 + if chained { 22 } else { 0 };
        let table = element_at + 22;
        let glyph_at = table + 95 * 4;
        let mut data = vec![0; glyph_at + 10 + HANYANG_RECTANGLE.len()];
        data[..MAGIC.len()].copy_from_slice(MAGIC);
        data[0x6c..0x7d].copy_from_slice(b"HFT Decoder Test1");
        data[0x134..0x134 + HANYANG_FLAVOR.len()].copy_from_slice(HANYANG_FLAVOR);
        data[0x1a6..0x1a8].copy_from_slice(&(if chained { 2u16 } else { 1 }).to_le_bytes());
        data[0x1ae..0x1b2].copy_from_slice(&512u32.to_le_bytes());
        if chained {
            data[512..516].copy_from_slice(&36u32.to_le_bytes());
            data[516..518].copy_from_slice(&1000u16.to_le_bytes());
            data[518..520].copy_from_slice(&1u16.to_le_bytes());
            data[520..522].copy_from_slice(&1u16.to_le_bytes());
            data[522..524].copy_from_slice(&14u16.to_le_bytes());
            data[526..530].copy_from_slice(&22u32.to_le_bytes());
            data[record_at + 14..record_at + 18].copy_from_slice(&22u32.to_le_bytes());
        }
        let record_len = (data.len() - record_at) as u32;
        data[record_at..record_at + 4].copy_from_slice(&record_len.to_le_bytes());
        data[record_at + 4..record_at + 6].copy_from_slice(&1000u16.to_le_bytes());
        data[record_at + 6..record_at + 8].copy_from_slice(&1u16.to_le_bytes());
        data[record_at + 8..record_at + 10]
            .copy_from_slice(&(if chained { 2u16 } else { 1 }).to_le_bytes());
        data[record_at + 10..record_at + 12].copy_from_slice(&14u16.to_le_bytes());
        let element_len = (data.len() - element_at) as u32;
        data[element_at..element_at + 4].copy_from_slice(&element_len.to_le_bytes());
        data[element_at + 6..element_at + 8].copy_from_slice(&32u16.to_le_bytes());
        data[element_at + 8..element_at + 10].copy_from_slice(&126u16.to_le_bytes());
        data[element_at + 10..element_at + 12].copy_from_slice(&95u16.to_le_bytes());
        for index in 0..95 {
            data[table + index * 4..table + index * 4 + 4].copy_from_slice(&380u32.to_le_bytes());
        }
        data[glyph_at + 8..glyph_at + 10]
            .copy_from_slice(&(HANYANG_RECTANGLE.len() as u16).to_le_bytes());
        data[glyph_at + 10..].copy_from_slice(HANYANG_RECTANGLE);
        data
    }

    #[test]
    fn hanyang_cipher_and_exact_termination_reject_incomplete_streams() {
        assert_eq!(decrypt_hanyang(HANYANG_RECTANGLE), PLAIN_RECTANGLE);
        let expected = hanyang_rectangle_commands();
        assert_eq!(
            decode_outline_stream(&decrypt_hanyang(HANYANG_RECTANGLE), 1000.0, true),
            Some(expected)
        );
        assert!(decode_outline_stream(HANYANG_RECTANGLE, 1000.0, true).is_none());
        assert!(decode_outline_stream(&PLAIN_RECTANGLE[..8], 1000.0, true).is_none());
        let mut trailing = PLAIN_RECTANGLE.to_vec();
        trailing.push(0);
        assert!(decode_outline_stream(&trailing, 1000.0, true).is_none());
        let mut properties = vec![
            0x20, 1, 0, 0, 0, 1, 0, 0, 0x21, 1, 2, 0, 0, 0x22, 0, 0x23, 0, 0x44,
        ];
        properties.extend_from_slice(PLAIN_RECTANGLE);
        assert_eq!(
            decode_outline_stream(&properties, 1000.0, true),
            Some(hanyang_rectangle_commands())
        );
        for malformed in [&[0x20, 255, 0][..], &[0x21, 1, 255, 0][..], &[0x22][..]] {
            assert!(decode_outline_stream(malformed, 1000.0, true).is_none());
        }
    }

    #[test]
    fn hanyang_walks_chained_banks_and_checks_glyph_boundaries() {
        let data = hanyang_fixture(true);
        let (family, bank) = Bank::parse(Arc::from(data.clone())).unwrap();
        assert_eq!(family, "HFT Decoder Test1");
        assert_eq!(bank.layout.table, 606);
        assert_eq!(bank.index_of('A'), Some(33));
        assert_eq!(
            bank.record(33).unwrap().unwrap(),
            hanyang_rectangle_commands()
        );
        assert!(bank.index_of('가').is_none());
        assert!(bank.index_of('\u{80}').is_none());
        let table = bank.layout.table;
        for bad_offset in [4u32, u32::MAX] {
            let mut broken = data.clone();
            broken[table + 33 * 4..table + 34 * 4].copy_from_slice(&bad_offset.to_le_bytes());
            assert!(Bank::parse(Arc::from(broken)).is_none());
        }
        for position in [512, 562, 584] {
            let mut broken = data.clone();
            broken[position..position + 4].copy_from_slice(&u32::MAX.to_le_bytes());
            assert!(Bank::parse(Arc::from(broken)).is_none());
        }
        let mut broken = data.clone();
        *broken.last_mut().unwrap() ^= 1;
        assert!(Bank::parse(Arc::from(broken)).is_none());
        let mut wrong_cipher = data.clone();
        let stream_at = wrong_cipher.len() - PLAIN_RECTANGLE.len();
        wrong_cipher[stream_at..].copy_from_slice(PLAIN_RECTANGLE);
        assert!(Bank::parse(Arc::from(wrong_cipher)).is_none());
        assert!(Bank::parse(Arc::from(data[..data.len() - 1].to_vec())).is_none());
        let mut missing = data;
        missing[table + 33 * 4..table + 34 * 4].fill(0);
        assert!(Bank::parse(Arc::from(missing))
            .unwrap()
            .1
            .record(33)
            .unwrap()
            .is_none());
    }

    #[test]
    fn hanyang_and_plain_streams_keep_the_same_geometry() {
        let encrypted = hanyang_fixture(false);
        let mut expected = Bank::parse(Arc::from(encrypted.clone()))
            .unwrap()
            .1
            .record(33)
            .unwrap()
            .unwrap();
        // 한양의 명시적인 시작점 연결은 평문 Close 와 같은 닫힌 선분을 만든다.
        assert_eq!(expected.remove(3), HftPathCmd::LineTo(10.0, -130.0));
        let mut plain = encrypted;
        plain[0x134..0x154].fill(0);
        let stream_at = plain.len() - PLAIN_RECTANGLE.len();
        plain[stream_at..].copy_from_slice(PLAIN_RECTANGLE);
        assert_eq!(
            Bank::parse(Arc::from(plain)).unwrap().1.record(33).unwrap(),
            Some(expected)
        );
    }

    #[test]
    fn hanyang_return_to_start_allows_more_segments_in_the_same_contour() {
        let bytes = [3, 10, 20, 4, 5, 30, 6, 40, 5, 226, 0];
        assert_eq!(
            decode_outline_stream(&bytes, 1000.0, true).unwrap(),
            vec![
                HftPathCmd::MoveTo(10.0, -130.0),
                HftPathCmd::LineTo(10.0, -130.0),
                HftPathCmd::LineTo(40.0, -130.0),
                HftPathCmd::LineTo(40.0, -90.0),
                HftPathCmd::LineTo(10.0, -90.0),
                HftPathCmd::Close,
            ]
        );
        assert!(decode_outline(&bytes, 1000.0).is_none());
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn hanyang_file_and_imported_bytes_select_the_same_bank() {
        let data = hanyang_fixture(true);
        let path =
            std::env::temp_dir().join(format!("rhwp-hft-decoder-{}.HFT", std::process::id()));
        std::fs::write(&path, &data).unwrap();
        let (family, kind) = probe_hft_file(&path).unwrap();
        let mut pending = Slot::Pending(path.clone());
        let native = pending.bank().unwrap().record(33).unwrap().unwrap();
        assert_eq!(kind, BankKind::Latin { first: 32 });
        assert!(register_hft_bytes(data));
        assert_eq!(hft_glyph(&family, 'A').unwrap().commands, native);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn hanyang_multiply_fallback_keeps_face_specific_advance_and_outline() {
        use crate::renderer::font_metrics_data::find_metric;

        let canonical = find_metric("한양신명조", false, false).unwrap().metric;
        let alias = find_metric("신명조", false, false).unwrap().metric;
        let english = find_metric("HanyangSinMyeongJo", false, false)
            .unwrap()
            .metric;
        assert!(std::ptr::eq(canonical, alias));
        assert!(std::ptr::eq(canonical, english));
        assert_eq!(canonical.get_width('×'), Some(577));
        assert_eq!(canonical.em_size, 1024);
        let hy = find_metric("HY신명조", false, false).unwrap().metric;
        assert_eq!(canonical.get_width('Ø'), hy.get_width('Ø'));
        assert_ne!(canonical.get_width('×'), hy.get_width('×'));

        // 저장소에 HFT 파일이 없어도 이 페이스의 작은 벡터 기호는 쓰인다.
        let glyph = missing_hanyang_multiply("한양신명조", '×').unwrap();
        assert!(hft_glyph("한양신명조", '×').is_some());
        assert_eq!(glyph.units_per_em, 1000.0);
        let points: Vec<_> = glyph
            .scaled(1000.0, 1.0)
            .filter_map(|cmd| match cmd {
                HftPathCmd::MoveTo(x, y) | HftPathCmd::LineTo(x, y) => Some((x, y)),
                _ => None,
            })
            .collect();
        let left = points.iter().map(|(x, _)| *x).fold(f32::INFINITY, f32::min);
        let right = points
            .iter()
            .map(|(x, _)| *x)
            .fold(f32::NEG_INFINITY, f32::max);
        assert!(
            right - left < 600.0,
            "multiplication sign must stay compact"
        );

        // 이름이 비슷해도 HY 대체 서체와 미등록 서체에는 전용 글리프를 주지 않는다.
        assert!(missing_hanyang_multiply("HY신명조", '×').is_none());
        assert!(missing_hanyang_multiply("신명조", '×').is_none());
        assert!(missing_hanyang_multiply("한양신명조", '÷').is_none());
        assert!(hft_glyph("Unregistered HFT face", '×').is_none());
    }

    #[test]
    fn johab_decodes_hangul_family_names() {
        // "신명 신그래픽" (TESGRHG.HFT 0x6c)
        let mut data = vec![0u8; 0x8c];
        data[0x6c..0x79].copy_from_slice(&[
            0xaf, 0xa5, 0xa1, 0x77, 0x20, 0xaf, 0xa5, 0x8b, 0x61, 0x9c, 0x81, 0xcf, 0xa2,
        ]);
        assert_eq!(family_name(&data).as_deref(), Some("신명 신그래픽"));
    }

    #[test]
    fn outline_numbers_and_closepath_follow_hft_semantics() {
        // moveto(10, 150) → closepath 후 상대 moveto 는 윤곽 시작점 기준이다.
        let bytes = [
            0x03, 0x0a, 0x7c, 0x1a, // M(10, 150) → 기준선 0
            0x05, 0x7d, 0x00, // L dx=380
            0x06, 0x14, // L dy=20
            0x04, // Z → 현재점 (10, 200)
            0x01, 0x05, // M dx=5
            0x05, 0x84, 0x00, // L dx=-124
            0x00,
        ];
        let commands = decode_outline(&bytes, 1000.0).unwrap();
        assert_eq!(
            commands,
            vec![
                HftPathCmd::MoveTo(10.0, 0.0),
                HftPathCmd::LineTo(390.0, 0.0),
                HftPathCmd::LineTo(390.0, 20.0),
                HftPathCmd::Close,
                HftPathCmd::MoveTo(15.0, 0.0),
                HftPathCmd::LineTo(-109.0, 0.0),
                HftPathCmd::Close,
            ]
        );
    }

    #[test]
    fn rectangular_hyphen_uses_inclusive_bounds_in_a_later_outline_bank() {
        let mut data = vec![0u8; 640];
        data[..MAGIC.len()].copy_from_slice(MAGIC);
        data[0x6c..0x75].copy_from_slice(b"Test Dash");
        data[0x1ae..0x1b2].copy_from_slice(&512u32.to_le_bytes());
        for at in [512, 576] {
            data[at..at + 4].copy_from_slice(&64u32.to_le_bytes());
            data[at + 4..at + 6].copy_from_slice(&1000u16.to_le_bytes());
        }
        data[596..598].copy_from_slice(&45u16.to_le_bytes());
        data[598..600].copy_from_slice(&45u16.to_le_bytes());
        data[600..602].copy_from_slice(&1u16.to_le_bytes());
        data[612..616].copy_from_slice(&4u32.to_le_bytes());
        for (index, value) in [75i16, 517, 423, 31, 14].iter().enumerate() {
            data[616 + index * 2..618 + index * 2].copy_from_slice(&value.to_le_bytes());
        }
        data[626] = 0xe5;
        let (family, glyph) = rectangular_hyphen(&mut std::io::Cursor::new(&data)).unwrap();
        assert_eq!(family, "Test Dash");
        assert_eq!(
            glyph.commands,
            vec![
                HftPathCmd::MoveTo(75.0, 336.0),
                HftPathCmd::LineTo(497.0, 336.0),
                HftPathCmd::LineTo(497.0, 366.0),
                HftPathCmd::LineTo(75.0, 366.0),
                HftPathCmd::Close,
            ]
        );
        data[624..626].copy_from_slice(&15u16.to_le_bytes());
        assert!(rectangular_hyphen(&mut std::io::Cursor::new(&data)).is_none());
        data[624..626].copy_from_slice(&14u16.to_le_bytes());
        data[622..624].copy_from_slice(&500i16.to_le_bytes());
        assert!(rectangular_hyphen(&mut std::io::Cursor::new(&data)).is_none());
    }

    #[test]
    fn ks_x_1001_order_indexes_hangul_and_hanja() {
        assert_eq!(ks_index('가', 0xB0), Some(0));
        assert_eq!(ks_index('힝', 0xB0), Some(2349));
        assert_eq!(ks_index('伽', 0xCA), Some(0));
        assert_eq!(ks_index('a', 0xB0), None);
    }

    #[test]
    fn isolated_jamo_map_to_johab_fill_codes() {
        assert_eq!(johab_jamo('ㅎ'), Some(0xd041));
        assert_eq!(johab_jamo('\u{1112}'), Some(0xd041));
        assert_eq!(johab_jamo('ㅏ'), Some(0x8461));
        assert_eq!(johab_jamo('\u{11a8}'), Some(0x8841));
        assert_eq!(johab_jamo('ㄳ'), None);
        assert_eq!(johab_jamo('하'), None);
    }

    /// 한컴이 설치된 PC 에서만: 조합 중 단독 자모도 음절과 같은 디나루 은행에서 그린다.
    #[cfg(target_os = "macos")]
    #[test]
    fn installed_hancom_hft_draws_isolated_jamo_when_present() {
        let file = std::path::PathBuf::from(
            "/Applications/Hancom Office HWP.app/Contents/Resources/Hnc/Shared/Fonts/TEDNRHG.HFT",
        );
        if !file.is_file() {
            return;
        }
        register_hft_sources(&[file]);
        for ch in ['ㅎ', 'ㅏ', '\u{1112}', '하', '한'] {
            assert!(hft_glyph("신명 디나루", ch).is_some(), "{ch}");
        }
    }

    /// 한컴이 설치된 PC 에서만: 신명 신그래픽 '사' 윤곽선이 해석된다.
    #[cfg(target_os = "macos")]
    #[test]
    fn installed_hancom_hft_decodes_when_present() {
        let dir = std::path::PathBuf::from(
            "/Applications/Hancom Office HWP.app/Contents/Resources/Hnc/Shared/Fonts",
        );
        if !dir.join("TESGRHG.HFT").is_file() {
            return;
        }
        register_hft_sources(&[dir.join("TESGRHG.HFT"), dir.join("TESGREN.HFT")]);
        let glyph = hft_glyph("신명 신그래픽", '사').expect("사 glyph");
        assert!(glyph.commands.len() > 10);
        assert!(hft_glyph("신명 신그래픽", 'A').is_some());
        assert!(hft_glyph("신명 신그래픽", ' ').is_none());
    }
}

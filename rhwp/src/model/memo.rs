//! 메모(한컴 "메모", 풍선 주석) 공통 모델 도우미.
//!
//! 메모는 별도 컨트롤이 아니라 `Control::Field` + `FieldType::Memo` 로 표현한다.
//! 본문은 `Field::memo_paragraphs`, 메타데이터(작성자·작성 시각·번호·모양 참조)는
//! 필드 명령(`MEMO/<shapeRef>/<number>/<timeLow>/<timeHigh>/<author>/...`)이 유일한
//! 진실이다. 이 모듈은 명령 파싱/생성, 문서 순서 필드 순회, 메모 모양 해석을 모은다.

use super::control::{Control, Field, FieldType};
use super::document::{DocInfo, Document, RawRecord};
use super::paragraph::Paragraph;
use super::shape::ShapeObject;
use crate::parser::tags;

/// 메모 필드 명령의 기본 모양 참조 (한컴 저장본은 모두 65535 = 문서 기본 메모 모양).
pub const DEFAULT_MEMO_SHAPE_REF: &str = "65535";
/// 한컴 저장본의 명령 꼬리 세그먼트.
const DEFAULT_MEMO_COMMAND_TAIL: &str = "\\;;";

/// 메모 필드 명령 `MEMO/<shapeRef>/<number>/<timeLow>/<timeHigh>/<author>/<tail...>`.
///
/// `timeLow`/`timeHigh` 는 작성 시각 FILETIME(1601-01-01 UTC 기준 100ns 단위)의 하위/상위
/// 32비트다. 알 수 없는 꼬리 세그먼트는 그대로 보존한다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoCommand {
    pub shape_ref: String,
    pub number: u32,
    pub time_low: u32,
    pub time_high: u32,
    pub author: String,
    pub tail: Vec<String>,
}

impl MemoCommand {
    /// `MEMO` 로 시작하는 명령을 파싱한다. 숫자 세그먼트가 깨져 있으면 0 으로 읽는다.
    pub fn parse(command: &str) -> Option<Self> {
        let mut parts = command.split('/');
        if parts.next()? != "MEMO" {
            return None;
        }
        let shape_ref = parts.next().unwrap_or(DEFAULT_MEMO_SHAPE_REF).to_string();
        let number = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let time_low = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let time_high = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let author = parts.next().unwrap_or("").to_string();
        let tail = parts.map(str::to_string).collect();
        Some(Self {
            shape_ref,
            number,
            time_low,
            time_high,
            author,
            tail,
        })
    }

    /// 새 메모 명령. `unix_ms` 는 작성 시각(Unix epoch 밀리초, UTC).
    pub fn new(author: &str, number: u32, unix_ms: f64) -> Self {
        let filetime = unix_ms_to_filetime(unix_ms);
        Self {
            shape_ref: DEFAULT_MEMO_SHAPE_REF.to_string(),
            number,
            time_low: filetime as u32,
            time_high: (filetime >> 32) as u32,
            // 세그먼트 구분자와 섞이지 않게 '/' 는 뺀다.
            author: author.replace('/', ""),
            tail: vec![DEFAULT_MEMO_COMMAND_TAIL.to_string()],
        }
    }

    /// 작성 시각 FILETIME.
    pub fn filetime(&self) -> u64 {
        (u64::from(self.time_high) << 32) | u64::from(self.time_low)
    }

    /// 작성 시각을 `YYYY-MM-DDTHH:MM:SSZ` (UTC) 로 돌려준다. 시각이 없으면 `None`.
    pub fn created_at_iso(&self) -> Option<String> {
        filetime_to_iso(self.filetime())
    }
}

impl std::fmt::Display for MemoCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "MEMO/{}/{}/{}/{}/{}",
            self.shape_ref, self.number, self.time_low, self.time_high, self.author
        )?;
        for segment in &self.tail {
            write!(f, "/{segment}")?;
        }
        Ok(())
    }
}

/// 메모 메타데이터 (명령에서 읽은 값).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoMeta {
    pub author: String,
    pub created_at: Option<String>,
    pub number: u32,
    pub shape_ref: String,
}

impl Field {
    /// 메모 필드의 명령 메타데이터. 메모가 아니거나 명령이 `MEMO` 형식이 아니면 `None`.
    pub fn memo_meta(&self) -> Option<MemoMeta> {
        if self.field_type != FieldType::Memo {
            return None;
        }
        let command = MemoCommand::parse(&self.command)?;
        Some(MemoMeta {
            author: command.author.clone(),
            created_at: command.created_at_iso(),
            number: command.number,
            shape_ref: command.shape_ref.clone(),
        })
    }

    /// 메모 본문 평문 (문단은 줄바꿈으로 잇는다).
    pub fn memo_body_text(&self) -> String {
        self.memo_paragraphs
            .iter()
            .map(|p| p.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

const FILETIME_UNIX_EPOCH_SECS: u64 = 11_644_473_600;

fn unix_ms_to_filetime(unix_ms: f64) -> u64 {
    if !unix_ms.is_finite() || unix_ms < 0.0 {
        return FILETIME_UNIX_EPOCH_SECS * 10_000_000;
    }
    (unix_ms as u64)
        .saturating_mul(10_000)
        .saturating_add(FILETIME_UNIX_EPOCH_SECS * 10_000_000)
}

/// FILETIME → `YYYY-MM-DDTHH:MM:SSZ` (UTC).
pub fn filetime_to_iso(filetime: u64) -> Option<String> {
    if filetime == 0 {
        return None;
    }
    let secs = (filetime / 10_000_000).checked_sub(FILETIME_UNIX_EPOCH_SECS)? as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    Some(format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    ))
}

/// Howard Hinnant 의 days-from-civil 역함수 (proleptic Gregorian).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 현재 시각 (Unix epoch 밀리초).
pub fn now_unix_ms() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0)
    }
}

// ─── 문서 순서 필드 순회 ─────────────────────────────────────

/// 문단 목록 안의 모든 필드를 문서 순서대로 방문한다 (표 셀·캡션·글상자·묶음 개체·
/// 머리말/꼬리말·각주/미주·숨은 설명·메모 본문). 필드를 먼저 방문하고 그 메모 본문으로
/// 내려간다. HWP 저장의 메모 번호 계획과 메모 꼬리 수집이 같은 순서를 쓴다.
pub fn for_each_field<'a>(paragraphs: &'a [Paragraph], f: &mut dyn FnMut(&'a Field)) {
    for para in paragraphs {
        for control in &para.controls {
            for_each_field_in_control(control, f);
        }
    }
}

fn for_each_field_in_control<'a>(control: &'a Control, f: &mut dyn FnMut(&'a Field)) {
    match control {
        Control::Field(field) => {
            f(field);
            for_each_field(&field.memo_paragraphs, f);
        }
        Control::Table(table) => {
            if let Some(caption) = &table.caption {
                for_each_field(&caption.paragraphs, f);
            }
            for cell in &table.cells {
                for_each_field(&cell.paragraphs, f);
            }
        }
        Control::Picture(picture) => {
            if let Some(caption) = &picture.caption {
                for_each_field(&caption.paragraphs, f);
            }
        }
        Control::Shape(shape) => for_each_field_in_shape(shape, f),
        Control::Header(h) => for_each_field(&h.paragraphs, f),
        Control::Footer(h) => for_each_field(&h.paragraphs, f),
        Control::Footnote(n) => for_each_field(&n.paragraphs, f),
        Control::Endnote(n) => for_each_field(&n.paragraphs, f),
        Control::HiddenComment(c) => for_each_field(&c.paragraphs, f),
        _ => {}
    }
}

fn for_each_field_in_shape<'a>(shape: &'a ShapeObject, f: &mut dyn FnMut(&'a Field)) {
    if let Some(drawing) = shape.drawing() {
        if let Some(text_box) = &drawing.text_box {
            for_each_field(&text_box.paragraphs, f);
        }
        if let Some(caption) = &drawing.caption {
            for_each_field(&caption.paragraphs, f);
        }
    }
    match shape {
        ShapeObject::Group(group) => {
            if let Some(caption) = &group.caption {
                for_each_field(&caption.paragraphs, f);
            }
            for child in &group.children {
                for_each_field_in_shape(child, f);
            }
        }
        ShapeObject::Picture(picture) => {
            if let Some(caption) = &picture.caption {
                for_each_field(&caption.paragraphs, f);
            }
        }
        ShapeObject::Chart(chart) => {
            if let Some(caption) = &chart.caption {
                for_each_field(&caption.paragraphs, f);
            }
        }
        ShapeObject::Ole(ole) => {
            if let Some(caption) = &ole.caption {
                for_each_field(&caption.paragraphs, f);
            }
        }
        _ => {}
    }
}

/// [`for_each_field`] 의 가변 버전. 방문 순서가 같다.
pub fn for_each_field_mut(paragraphs: &mut [Paragraph], f: &mut dyn FnMut(&mut Field)) {
    for para in paragraphs {
        for control in &mut para.controls {
            for_each_field_in_control_mut(control, f);
        }
    }
}

fn for_each_field_in_control_mut(control: &mut Control, f: &mut dyn FnMut(&mut Field)) {
    match control {
        Control::Field(field) => {
            f(field);
            for_each_field_mut(&mut field.memo_paragraphs, f);
        }
        Control::Table(table) => {
            if let Some(caption) = &mut table.caption {
                for_each_field_mut(&mut caption.paragraphs, f);
            }
            for cell in &mut table.cells {
                for_each_field_mut(&mut cell.paragraphs, f);
            }
        }
        Control::Picture(picture) => {
            if let Some(caption) = &mut picture.caption {
                for_each_field_mut(&mut caption.paragraphs, f);
            }
        }
        Control::Shape(shape) => for_each_field_in_shape_mut(shape, f),
        Control::Header(h) => for_each_field_mut(&mut h.paragraphs, f),
        Control::Footer(h) => for_each_field_mut(&mut h.paragraphs, f),
        Control::Footnote(n) => for_each_field_mut(&mut n.paragraphs, f),
        Control::Endnote(n) => for_each_field_mut(&mut n.paragraphs, f),
        Control::HiddenComment(c) => for_each_field_mut(&mut c.paragraphs, f),
        _ => {}
    }
}

fn for_each_field_in_shape_mut(shape: &mut ShapeObject, f: &mut dyn FnMut(&mut Field)) {
    if let Some(drawing) = shape.drawing_mut() {
        if let Some(text_box) = &mut drawing.text_box {
            for_each_field_mut(&mut text_box.paragraphs, f);
        }
        if let Some(caption) = &mut drawing.caption {
            for_each_field_mut(&mut caption.paragraphs, f);
        }
    }
    match shape {
        ShapeObject::Group(group) => {
            if let Some(caption) = &mut group.caption {
                for_each_field_mut(&mut caption.paragraphs, f);
            }
            for child in &mut group.children {
                for_each_field_in_shape_mut(child, f);
            }
        }
        ShapeObject::Picture(picture) => {
            if let Some(caption) = &mut picture.caption {
                for_each_field_mut(&mut caption.paragraphs, f);
            }
        }
        ShapeObject::Chart(chart) => {
            if let Some(caption) = &mut chart.caption {
                for_each_field_mut(&mut caption.paragraphs, f);
            }
        }
        ShapeObject::Ole(ole) => {
            if let Some(caption) = &mut ole.caption {
                for_each_field_mut(&mut caption.paragraphs, f);
            }
        }
        _ => {}
    }
}

/// 구역 하나의 모든 필드 (본문 문단 + 구역 정의의 바탕쪽).
pub fn for_each_section_field<'a>(
    section: &'a super::document::Section,
    f: &mut dyn FnMut(&'a Field),
) {
    for_each_field(&section.paragraphs, f);
    for master in &section.section_def.master_pages {
        for_each_field(&master.paragraphs, f);
    }
}

/// [`for_each_section_field`] 의 가변 버전.
pub fn for_each_section_field_mut(
    section: &mut super::document::Section,
    f: &mut dyn FnMut(&mut Field),
) {
    for_each_field_mut(&mut section.paragraphs, f);
    for master in &mut section.section_def.master_pages {
        for_each_field_mut(&mut master.paragraphs, f);
    }
}

/// 문서에 메모(메모 필드 또는 앵커 없는 메모 본문)가 하나라도 있는지.
pub fn document_has_memos(doc: &Document) -> bool {
    if !doc.orphan_memo_lists.is_empty() {
        return true;
    }
    let mut found = false;
    for section in &doc.sections {
        for_each_section_field(section, &mut |field| {
            found |= field.field_type == FieldType::Memo;
        });
        if found {
            return true;
        }
    }
    false
}

// ─── 메모 모양 ───────────────────────────────────────────────

/// 메모 모양 (HWP `MEMO_SHAPE` / HWPX `hh:memoPr`). 색은 ColorRef(0x00BBGGRR).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoShape {
    pub width: u32,
    /// HWP5 메모 선 종류 (1 = 실선)
    pub line_type: u8,
    pub line_width: u8,
    pub line_color: u32,
    pub fill_color: u32,
    pub active_color: u32,
    pub memo_type: u32,
}

impl MemoShape {
    /// `samples/hwpx/aift.hwpx` 의 한컴 기본 memoPr 값.
    pub fn hancom_default() -> Self {
        Self {
            width: 15591,
            line_type: 1,
            line_width: 3,
            line_color: 0x00A9_A9A9,
            fill_color: 0x0099_FFCB,
            active_color: 0x00DD_BCFD,
            memo_type: 0,
        }
    }

    fn from_record(data: &[u8]) -> Option<Self> {
        if data.len() < 22 {
            return None;
        }
        let u32_at =
            |o: usize| u32::from_le_bytes([data[o], data[o + 1], data[o + 2], data[o + 3]]);
        Some(Self {
            width: u32_at(0),
            line_type: data[4],
            line_width: data[5],
            line_color: u32_at(6),
            fill_color: u32_at(10),
            active_color: u32_at(14),
            memo_type: u32_at(18),
        })
    }

    fn to_record(&self) -> Vec<u8> {
        let mut data = Vec::with_capacity(22);
        data.extend_from_slice(&self.width.to_le_bytes());
        data.push(self.line_type);
        data.push(self.line_width);
        data.extend_from_slice(&self.line_color.to_le_bytes());
        data.extend_from_slice(&self.fill_color.to_le_bytes());
        data.extend_from_slice(&self.active_color.to_le_bytes());
        data.extend_from_slice(&self.memo_type.to_le_bytes());
        data
    }

    /// HWPX `hh:memoPr` 요소 (id 는 1부터).
    pub fn to_hwpx_xml(&self, id: usize) -> String {
        format!(
            "<hh:memoPr id=\"{id}\" width=\"{}\" lineWidth=\"{}\" lineType=\"{}\" lineColor=\"{}\" fillColor=\"{}\" activeColor=\"{}\" memoType=\"NOMAL\"/>",
            self.width,
            self.line_width,
            memo_line_type_name(self.line_type),
            colorref_to_hex(self.line_color),
            colorref_to_hex(self.fill_color),
            colorref_to_hex(self.active_color),
        )
    }
}

/// HWP5 메모 선 종류 → OWPML 이름 (`parser::hwpx::header::parse_memo_line_type` 의 역).
fn memo_line_type_name(line_type: u8) -> &'static str {
    match line_type {
        2 => "DASH_DOT",
        3 => "DASH",
        4 => "DASH_DOT_DOT",
        5 => "LONG_DASH",
        6 => "CIRCLE",
        7 => "DOUBLE_SLIM",
        8 => "SLIM_THICK",
        9 => "THICK_SLIM",
        10 => "SLIM_THICK_SLIM",
        11 => "WAVE",
        12 => "DOUBLE_WAVE",
        13 => "DOT",
        _ => "SOLID",
    }
}

/// ColorRef(0x00BBGGRR) → `#RRGGBB`.
pub fn colorref_to_hex(color: u32) -> String {
    let r = color & 0xFF;
    let g = (color >> 8) & 0xFF;
    let b = (color >> 16) & 0xFF;
    format!("#{r:02X}{g:02X}{b:02X}")
}

impl DocInfo {
    /// 문서의 메모 모양 목록 (HWP `MEMO_SHAPE` 레코드, HWPX 는 파서가 같은 레코드를 만든다).
    pub fn memo_shapes(&self) -> Vec<MemoShape> {
        self.extra_records
            .iter()
            .filter(|record| record.tag_id == tags::HWPTAG_MEMO_SHAPE)
            .filter_map(|record| MemoShape::from_record(&record.data))
            .collect()
    }

    /// 메모 모양이 하나도 없으면 한컴 기본 모양을 하나 추가한다. 추가했으면 `true`.
    ///
    /// HWP 용 `MEMO_SHAPE` 레코드와 개수(`memo_shape_count`)를 함께 늘리고, HWPX 원문
    /// `memo_properties_xml` 이 있으면 거기에도 넣는다. DocInfo 원본 스트림은 무효화한다.
    pub fn ensure_default_memo_shape(&mut self) -> bool {
        if !self.memo_shapes().is_empty() {
            return false;
        }
        let shape = MemoShape::hancom_default();
        self.extra_records.push(RawRecord {
            tag_id: tags::HWPTAG_MEMO_SHAPE,
            level: 1,
            data: shape.to_record(),
        });
        self.memo_shape_count = self
            .extra_records
            .iter()
            .filter(|record| record.tag_id == tags::HWPTAG_MEMO_SHAPE)
            .count() as u32;
        if self.memo_properties_xml.is_some() {
            self.memo_properties_xml = Some(memo_properties_xml(&[shape]));
        }
        self.raw_stream = None;
        true
    }
}

impl Document {
    /// 문서의 메모 모양 목록.
    pub fn memo_shapes(&self) -> Vec<MemoShape> {
        self.doc_info.memo_shapes()
    }
}

/// `hh:memoProperties` 블록.
pub fn memo_properties_xml(shapes: &[MemoShape]) -> String {
    let body: String = shapes
        .iter()
        .enumerate()
        .map(|(i, shape)| shape.to_hwpx_xml(i + 1))
        .collect();
    format!(
        "<hh:memoProperties itemCnt=\"{}\">{body}</hh:memoProperties>",
        shapes.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memo_command_roundtrips_hancom_command() {
        let raw = "MEMO/65535/1/1517431184/31247371/user/\\;;";
        let command = MemoCommand::parse(raw).unwrap();
        assert_eq!(command.number, 1);
        assert_eq!(command.author, "user");
        assert_eq!(command.to_string(), raw);
        // aift.hwpx CreateDateTime 은 현지(KST) 시각을 Z 로 적는다: 21:36:44 KST = 12:36:44Z
        assert_eq!(
            command.created_at_iso().as_deref(),
            Some("2026-04-14T12:36:44Z")
        );
    }

    #[test]
    fn memo_command_new_encodes_filetime() {
        // 2026-04-14T12:36:44.841Z
        let command = MemoCommand::new("작성/자", 3, 1_776_170_204_841.0);
        assert_eq!(command.author, "작성자");
        assert_eq!(command.time_high, 31_247_371);
        assert_eq!(
            command.created_at_iso().as_deref(),
            Some("2026-04-14T12:36:44Z")
        );
        let reparsed = MemoCommand::parse(&command.to_string()).unwrap();
        assert_eq!(reparsed, command);
    }

    #[test]
    fn memo_command_rejects_other_fields() {
        assert!(MemoCommand::parse("$RevisionDelete;").is_none());
    }

    #[test]
    fn memo_shape_record_roundtrip_and_xml() {
        let shape = MemoShape::hancom_default();
        assert_eq!(
            MemoShape::from_record(&shape.to_record()),
            Some(shape.clone())
        );
        assert_eq!(
            shape.to_hwpx_xml(1),
            "<hh:memoPr id=\"1\" width=\"15591\" lineWidth=\"3\" lineType=\"SOLID\" lineColor=\"#A9A9A9\" fillColor=\"#CBFF99\" activeColor=\"#FDBCDD\" memoType=\"NOMAL\"/>"
        );
    }

    #[test]
    fn ensure_default_memo_shape_adds_once() {
        let mut info = DocInfo::default();
        assert!(info.ensure_default_memo_shape());
        assert!(!info.ensure_default_memo_shape());
        assert_eq!(info.memo_shape_count, 1);
        assert_eq!(info.memo_shapes(), vec![MemoShape::hancom_default()]);
    }
}

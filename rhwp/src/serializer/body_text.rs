//! BodyText 섹션 직렬화
//!
//! `parser::body_text`의 역방향으로, Section/Paragraph를 레코드 스트림으로 변환한다.
//!
//! 레코드 구조:
//! ```text
//! PARA_HEADER (level 0)
//!   PARA_TEXT (level 1)
//!   PARA_CHAR_SHAPE (level 1)
//!   PARA_LINE_SEG (level 1)
//!   PARA_RANGE_TAG (level 1)
//!   CTRL_HEADER (level 1)
//!     ... (level 2+)
//! ```

use std::borrow::Cow;

use super::byte_writer::ByteWriter;

use crate::model::control::Control;
use crate::model::document::Section;
use crate::model::paragraph::{CharShapeRef, ColumnBreakType, LineSeg, Paragraph, RangeTag};
use crate::parser::record::Record;
use crate::parser::tags;

/// Section을 레코드 바이너리 스트림으로 직렬화
pub fn serialize_section(section: &Section) -> Vec<u8> {
    serialize_section_limited(section, usize::MAX)
        .expect("unbounded section serialization")
        .into_owned()
}

/// Serialize one structural stream without allowing the destination buffer to
/// grow beyond `max_bytes`.
///
/// Raw round-trip streams stay borrowed so the bounded HWP writer can either
/// copy them directly into the final CFB or compress them without first making
/// another member-sized allocation.
pub(crate) fn serialize_section_limited(
    section: &Section,
    max_bytes: usize,
) -> Result<Cow<'_, [u8]>, String> {
    // 원본 스트림이 있으면 그대로 반환 (완벽한 라운드트립)
    if let Some(ref raw) = section.raw_stream {
        if raw.len() > max_bytes {
            return Err(format!(
                "HWP section structural stream exceeds byte limit: {} > {max_bytes}",
                raw.len()
            ));
        }
        return Ok(Cow::Borrowed(raw));
    }

    // Memo discovery and the SectionDef compatibility injection below both
    // recursively traverse or clone caller-built IR. Validate the complete
    // graph first, while the traversal is allocation-free and depth-bounded.
    preflight_section_graph_depth(section)?;

    let has_real_page_def =
        section.section_def.page_def.width > 0 && section.section_def.page_def.height > 0;
    let needs_section_def_injection = has_real_page_def
        && section.paragraphs.first().is_some_and(|paragraph| {
            !paragraph
                .controls
                .iter()
                .any(|control| matches!(control, Control::SectionDef(_)))
        });
    if needs_section_def_injection {
        preflight_section_def_injection(
            section
                .paragraphs
                .first()
                .expect("injection requires a first paragraph"),
            &section.section_def,
            max_bytes,
        )?;
    }

    // [Task #852 Stage 2.4] Form 컨트롤의 z-order/TabOrder 카운터 reset.
    // 한 섹션 내 Form 등장순으로 0..N-1 부여 → 정답지 패턴 재현.
    super::control::reset_form_order_counter();

    let mut output = LimitedRecordStream::new(max_bytes);
    let memo_lists = collect_memo_lists(section);
    let has_memo_tail = !memo_lists.is_empty();
    let para_count = section.paragraphs.len();
    // [Issue #1915] IR 계약 폴백: 첫 문단에 Control::SectionDef 가 없는 IR(HWP3 파서
    // 산출물, 외부 생성 IR)은 secd/PAGE_DEF 계열 레코드가 통째로 누락되어 재로드 시
    // 용지·여백이 0 이 된다 (hwpdocs 10k 서베이 41건, 전부 HWP3-origin).
    // hwpx_to_hwp 어댑터의 insert_section_def_control 보강과 동일 계약을 직렬화기
    // 진입에서 적용한다 — 첫 문단만 SectionDef 컨트롤을 삽입한 사본으로 직렬화.
    // 원본 스트림 경로(raw_stream)는 위에서 이미 반환되므로 영향 없음.
    // 실질 page_def(용지 크기 보유)가 있을 때만 보강한다 — 기본값(0×0) section_def
    // 를 가진 합성/부분 IR(유닛테스트 fixture 등)에 무의미한 secd 를 주입해 레코드
    // 시퀀스를 바꾸지 않기 위함.
    let first_para_with_secd = if needs_section_def_injection {
        section.paragraphs.first().map(|p| {
            let mut clone = p.clone();
            clone.controls.insert(
                0,
                Control::SectionDef(Box::new(section.section_def.clone())),
            );
            clone
        })
    } else {
        None
    };
    for (i, para) in section.paragraphs.iter().enumerate() {
        let is_last = i == para_count - 1 && !has_memo_tail;
        let para_ref = if i == 0 {
            first_para_with_secd.as_ref().unwrap_or(para)
        } else {
            para
        };
        serialize_paragraph_to_stream(para_ref, 0, is_last, &mut output)?;
    }
    if has_memo_tail {
        serialize_memo_tail(section, &memo_lists, &mut output)?;
    }
    serialize_master_page_tail(section, &mut output)?;
    Ok(Cow::Owned(output.finish()))
}

struct LimitedRecordStream {
    bytes: Vec<u8>,
    max_bytes: usize,
}

impl LimitedRecordStream {
    fn new(max_bytes: usize) -> Self {
        Self {
            bytes: Vec::new(),
            max_bytes,
        }
    }

    fn append_record(&mut self, tag_id: u16, level: u16, data: &[u8]) -> Result<(), String> {
        let data_len = u32::try_from(data.len()).map_err(|_| {
            format!(
                "HWP record payload exceeds the 32-bit format limit: {} bytes",
                data.len()
            )
        })?;
        let extended = data_len >= 0x0fff;
        let record_len = 4usize
            .checked_add(if extended { 4 } else { 0 })
            .and_then(|length| length.checked_add(data.len()))
            .ok_or_else(|| "HWP structural stream size overflow".to_string())?;
        let next = self
            .bytes
            .len()
            .checked_add(record_len)
            .ok_or_else(|| "HWP structural stream size overflow".to_string())?;
        if next > self.max_bytes {
            return Err(format!(
                "HWP section structural stream exceeds byte limit: {next} > {}",
                self.max_bytes
            ));
        }
        if next > self.bytes.capacity() {
            let target_capacity = self
                .bytes
                .capacity()
                .saturating_mul(2)
                .max(next)
                .min(self.max_bytes);
            self.bytes
                .try_reserve_exact(target_capacity - self.bytes.len())
                .map_err(|error| format!("HWP structural stream allocation failed: {error}"))?;
        }

        let header_size = if extended { 0x0fff } else { data_len };
        let header = (u32::from(tag_id) & 0x03ff)
            | ((u32::from(level) & 0x03ff) << 10)
            | (header_size << 20);
        self.bytes.extend_from_slice(&header.to_le_bytes());
        if extended {
            self.bytes.extend_from_slice(&data_len.to_le_bytes());
        }
        self.bytes.extend_from_slice(data);
        Ok(())
    }

    fn append_records(&mut self, records: &[Record]) -> Result<(), String> {
        for record in records {
            self.append_record(record.tag_id, record.level, &record.data)?;
        }
        Ok(())
    }

    fn remaining(&self) -> usize {
        self.max_bytes.saturating_sub(self.bytes.len())
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

fn serialize_master_page_tail(
    section: &Section,
    output: &mut LimitedRecordStream,
) -> Result<(), String> {
    // HWPX LAST_PAGE master page is an extension master page. Hancom HWP5 files store
    // extension master pages after the body paragraph stream as level-1 LIST_HEADER
    // records, not inside the SectionDef child record group.
    if section
        .section_def
        .extra_child_records
        .iter()
        .any(|raw| raw.tag_id == tags::HWPTAG_LIST_HEADER && raw.level == 1)
    {
        return Ok(());
    }

    for master_page in section
        .section_def
        .master_pages
        .iter()
        .filter(|master_page| master_page.is_extension)
    {
        preflight_master_page_allocation(master_page, output.remaining())?;
        let mut records = Vec::new();
        super::control::serialize_master_page(master_page, 1, &mut records);
        output.append_records(&records)?;
    }
    Ok(())
}

fn collect_memo_lists(section: &Section) -> Vec<(u32, &[Paragraph])> {
    let mut memo_lists = Vec::new();
    collect_memo_lists_in_paragraphs(&section.paragraphs, &mut memo_lists);
    for master_page in &section.section_def.master_pages {
        collect_memo_lists_in_paragraphs(&master_page.paragraphs, &mut memo_lists);
    }
    memo_lists
}

fn collect_memo_lists_in_paragraphs<'a>(
    paragraphs: &'a [Paragraph],
    memo_lists: &mut Vec<(u32, &'a [Paragraph])>,
) {
    for paragraph in paragraphs {
        for control in &paragraph.controls {
            collect_memo_lists_in_control(control, memo_lists);
        }
    }
}

fn collect_memo_lists_in_control<'a>(
    control: &'a Control,
    memo_lists: &mut Vec<(u32, &'a [Paragraph])>,
) {
    match control {
        Control::Field(field) => {
            if field.field_type == crate::model::control::FieldType::Memo
                && !field.memo_paragraphs.is_empty()
            {
                memo_lists.push((field.memo_index, &field.memo_paragraphs));
            }
            // 중첩 필드도 보존한다. 실제 메모 본문에 또 다른 필드가 들어갈 수 있다.
            collect_memo_lists_in_paragraphs(&field.memo_paragraphs, memo_lists);
        }
        Control::Table(table) => {
            if let Some(caption) = &table.caption {
                collect_memo_lists_in_paragraphs(&caption.paragraphs, memo_lists);
            }
            for cell in &table.cells {
                collect_memo_lists_in_paragraphs(&cell.paragraphs, memo_lists);
            }
        }
        Control::Picture(picture) => {
            if let Some(caption) = &picture.caption {
                collect_memo_lists_in_paragraphs(&caption.paragraphs, memo_lists);
            }
        }
        Control::Shape(shape) => collect_memo_lists_in_shape(shape, memo_lists),
        Control::Header(header) => collect_memo_lists_in_paragraphs(&header.paragraphs, memo_lists),
        Control::Footer(footer) => collect_memo_lists_in_paragraphs(&footer.paragraphs, memo_lists),
        Control::Footnote(note) => collect_memo_lists_in_paragraphs(&note.paragraphs, memo_lists),
        Control::Endnote(note) => collect_memo_lists_in_paragraphs(&note.paragraphs, memo_lists),
        Control::HiddenComment(comment) => {
            collect_memo_lists_in_paragraphs(&comment.paragraphs, memo_lists)
        }
        _ => {}
    }
}

fn collect_memo_lists_in_shape<'a>(
    shape: &'a crate::model::shape::ShapeObject,
    memo_lists: &mut Vec<(u32, &'a [Paragraph])>,
) {
    if let Some(drawing) = shape.drawing() {
        if let Some(text_box) = &drawing.text_box {
            collect_memo_lists_in_paragraphs(&text_box.paragraphs, memo_lists);
        }
        if let Some(caption) = &drawing.caption {
            collect_memo_lists_in_paragraphs(&caption.paragraphs, memo_lists);
        }
    }
    match shape {
        crate::model::shape::ShapeObject::Group(group) => {
            if let Some(caption) = &group.caption {
                collect_memo_lists_in_paragraphs(&caption.paragraphs, memo_lists);
            }
            for child in &group.children {
                collect_memo_lists_in_shape(child, memo_lists);
            }
        }
        crate::model::shape::ShapeObject::Picture(picture) => {
            if let Some(caption) = &picture.caption {
                collect_memo_lists_in_paragraphs(&caption.paragraphs, memo_lists);
            }
        }
        crate::model::shape::ShapeObject::Chart(chart) => {
            if let Some(caption) = &chart.caption {
                collect_memo_lists_in_paragraphs(&caption.paragraphs, memo_lists);
            }
        }
        crate::model::shape::ShapeObject::Ole(ole) => {
            if let Some(caption) = &ole.caption {
                collect_memo_lists_in_paragraphs(&caption.paragraphs, memo_lists);
            }
        }
        _ => {}
    }
}

fn serialize_memo_tail(
    section: &Section,
    memo_lists: &[(u32, &[Paragraph])],
    output: &mut LimitedRecordStream,
) -> Result<(), String> {
    if memo_lists.is_empty() {
        return Ok(());
    }

    // HWP5 spec: 메모 관련 정보는 마지막 구역 끝에 문단 리스트 형태로 저장된다.
    // 한컴 저장본은 마지막 본문 문단의 조판 속성을 복제한 빈 root 문단 아래에
    // MEMO_LIST, LIST_HEADER, 메모 본문 문단을 순서대로 둔다.
    let last_para = section.paragraphs.last();
    let mut root = Paragraph {
        char_count: 1,
        para_shape_id: last_para.map_or(0, |p| p.para_shape_id),
        style_id: last_para.map_or(0, |p| p.style_id),
        char_shapes: last_para
            .and_then(|p| p.char_shapes.first().cloned())
            .map(|mut cs| {
                cs.start_pos = 0;
                vec![cs]
            })
            .unwrap_or_else(|| {
                vec![CharShapeRef {
                    start_pos: 0,
                    char_shape_id: 0,
                }]
            }),
        line_segs: last_para
            .map(|p| p.line_segs.clone())
            .filter(|segs| !segs.is_empty())
            .unwrap_or_else(|| Paragraph::new_empty().line_segs),
        raw_header_extra: vec![0; 12],
        ..Default::default()
    };
    for seg in &mut root.line_segs {
        seg.vertical_pos = seg
            .vertical_pos
            .saturating_add(seg.line_height)
            .saturating_add(seg.line_spacing);
    }
    root.has_para_text = false;
    serialize_paragraph_to_stream(&root, 0, true, output)?;

    for (memo_index, paragraphs) in memo_lists {
        output.append_record(tags::HWPTAG_MEMO_LIST, 1, &memo_index.to_le_bytes())?;

        let mut list_header = Vec::with_capacity(16);
        list_header.extend_from_slice(&(paragraphs.len() as u32).to_le_bytes());
        list_header.extend_from_slice(&[0; 12]);
        output.append_record(tags::HWPTAG_LIST_HEADER, 1, &list_header)?;

        for (index, source_para) in paragraphs.iter().enumerate() {
            let mut para = source_para.clone();
            if para.raw_header_extra.len() < 12 {
                para.raw_header_extra = vec![0; 12];
            }
            // Hancom writes memo body paragraphs under MEMO_LIST without
            // PARA_LINE_SEG records. HWPX subList parsing may synthesize a
            // default line segment, but keeping it here breaks the HWP5 memo
            // container contract.
            para.line_segs.clear();
            serialize_paragraph_to_stream(&para, 1, index + 1 == paragraphs.len(), output)?;
        }
    }
    Ok(())
}

/// 문단 목록을 레코드로 직렬화 (재귀용: 셀, 머리말/꼬리말, 각주/미주 내부)
pub fn serialize_paragraph_list(
    paragraphs: &[Paragraph],
    base_level: u16,
    records: &mut Vec<Record>,
) {
    let para_count = paragraphs.len();
    for (i, para) in paragraphs.iter().enumerate() {
        let is_last = i == para_count - 1;
        serialize_paragraph_with_msb(para, base_level, is_last, records);
    }
}

/// 단일 문단을 레코드로 직렬화 (MSB를 위치 기반으로 강제 설정)
///
/// is_last: 이 문단이 현재 스코프(섹션/셀/텍스트박스 등)의 마지막 문단인지 여부
fn serialize_paragraph_with_msb(
    para: &Paragraph,
    base_level: u16,
    is_last: bool,
    records: &mut Vec<Record>,
) {
    // HWP는 모든 문단에 최소 1개의 PARA_CHAR_SHAPE 엔트리 필요
    // char_shapes가 비어있으면 기본 엔트리(위치 0, char_shape_id 0)를 사용
    let default_char_shape = [CharShapeRef {
        start_pos: 0,
        char_shape_id: 0,
    }];
    let effective_char_shapes: &[CharShapeRef] = if para.char_shapes.is_empty() {
        &default_char_shape
    } else {
        &para.char_shapes
    };

    // control_mask 재계산: 실제 controls에서 비트 마스크를 산출한다.
    // 모델의 control_mask가 controls와 불일치하면 한컴이 파일 손상으로 판단하므로,
    // 직렬화 시점에 항상 재계산하여 일관성을 보장한다.
    let actual_control_mask = compute_control_mask(para);

    // PARA_TEXT를 먼저 직렬화하여 실제 char_count를 계산한다.
    // char_count가 PARA_TEXT code unit 수와 불일치하면 한컴이 파일 손상으로 판단한다.
    // 앞 문단에서 시작한 필드의 끝(고아 FIELD_END)만 든 문단도 PARA_TEXT 가 있어야 한다.
    // 빠뜨리면 char_count 는 FIELD_END 를 센 채 텍스트 레코드가 없어 한글이 문서를
    // 열지 못했다 (여러 문단에 걸친 누름틀).
    let has_content =
        !para.text.is_empty() || !para.controls.is_empty() || !para.orphan_field_ends.is_empty();
    let text_data = if has_content || (para.has_para_text && para.char_count > 1) {
        Some(serialize_para_text(para))
    } else {
        None
    };

    // char_count 재계산: PARA_TEXT가 있으면 code unit 수. 없으면 문단 끝 표지 하나뿐이다.
    let actual_char_count = if let Some(ref td) = text_data {
        (td.len() / 2) as u32
    } else {
        para.char_count.min(1)
    };

    // [#6956] 형광펜 표지는 PARA_RANGE_TAG 종류 2 로 되돌린다 — 헤더 count 와 같은 목록.
    let range_tags = para.effective_markpen_range_tags();

    // PARA_HEADER (effective_char_shapes 길이 반영)
    // MSB는 모델 값이 아닌 위치 기반으로 결정: 마지막 문단만 MSB=true
    records.push(Record {
        tag_id: tags::HWPTAG_PARA_HEADER,
        level: base_level,
        size: 0,
        data: serialize_para_header_with_mask(
            para,
            effective_char_shapes.len(),
            range_tags.len(),
            is_last,
            actual_control_mask,
            actual_char_count,
        ),
    });

    // PARA_TEXT
    if let Some(text_data) = text_data {
        records.push(Record {
            tag_id: tags::HWPTAG_PARA_TEXT,
            level: base_level + 1,
            size: text_data.len() as u32,
            data: text_data,
        });
    }

    // PARA_CHAR_SHAPE (항상 출력 — HWP 필수)
    {
        let data = serialize_para_char_shape(effective_char_shapes);
        records.push(Record {
            tag_id: tags::HWPTAG_PARA_CHAR_SHAPE,
            level: base_level + 1,
            size: data.len() as u32,
            data,
        });
    }

    // PARA_LINE_SEG
    if !para.line_segs.is_empty() {
        let data = serialize_para_line_seg(&para.line_segs);
        records.push(Record {
            tag_id: tags::HWPTAG_PARA_LINE_SEG,
            level: base_level + 1,
            size: data.len() as u32,
            data,
        });
    }

    // PARA_RANGE_TAG
    if !range_tags.is_empty() {
        let data = serialize_para_range_tag(&range_tags);
        records.push(Record {
            tag_id: tags::HWPTAG_PARA_RANGE_TAG,
            level: base_level + 1,
            size: data.len() as u32,
            data,
        });
    }

    // CTRL_HEADER (컨트롤별) + CTRL_DATA (있으면)
    for (ctrl_idx, ctrl) in para.controls.iter().enumerate() {
        let ctrl_data_record = para
            .ctrl_data_records
            .get(ctrl_idx)
            .and_then(|opt| opt.as_ref())
            .map(|v| v.as_slice());
        super::control::serialize_control(ctrl, base_level + 1, ctrl_data_record, records);
    }
}

/// Bounded counterpart used by the HWP package writer.
///
/// Paragraph records are appended as soon as they are produced. This avoids
/// retaining a paragraph-sized `Vec<Record>` (and every record payload) in
/// addition to the final structural stream. Variable-size paragraph payloads
/// reserve fallibly against the stream's remaining budget before writing.
fn serialize_paragraph_to_stream(
    para: &Paragraph,
    base_level: u16,
    is_last: bool,
    output: &mut LimitedRecordStream,
) -> Result<(), String> {
    let default_char_shape = [CharShapeRef {
        start_pos: 0,
        char_shape_id: 0,
    }];
    let effective_char_shapes: &[CharShapeRef] = if para.char_shapes.is_empty() {
        &default_char_shape
    } else {
        &para.char_shapes
    };

    let actual_control_mask = compute_control_mask(para);
    // 앞 문단에서 시작한 필드의 끝(고아 FIELD_END)만 든 문단도 PARA_TEXT 가 있어야 한다.
    // 빠뜨리면 char_count 는 FIELD_END 를 센 채 텍스트 레코드가 없어 한글이 문서를
    // 열지 못했다 (여러 문단에 걸친 누름틀).
    let has_content =
        !para.text.is_empty() || !para.controls.is_empty() || !para.orphan_field_ends.is_empty();
    let text_data = if has_content || (para.has_para_text && para.char_count > 1) {
        Some(serialize_para_text_limited(para, output.remaining())?)
    } else {
        None
    };
    let actual_char_count = if let Some(ref data) = text_data {
        u32::try_from(data.len() / 2)
            .map_err(|_| "HWP paragraph character count exceeds u32".to_string())?
    } else {
        para.char_count.min(1)
    };

    let range_tags = para.effective_markpen_range_tags();
    let header = serialize_para_header_with_mask(
        para,
        effective_char_shapes.len(),
        range_tags.len(),
        is_last,
        actual_control_mask,
        actual_char_count,
    );
    output.append_record(tags::HWPTAG_PARA_HEADER, base_level, &header)?;

    if let Some(data) = text_data {
        output.append_record(tags::HWPTAG_PARA_TEXT, base_level + 1, &data)?;
    }

    let char_shapes = serialize_para_char_shape_limited(effective_char_shapes, output.remaining())?;
    output.append_record(tags::HWPTAG_PARA_CHAR_SHAPE, base_level + 1, &char_shapes)?;

    if !para.line_segs.is_empty() {
        let line_segs = serialize_para_line_seg_limited(&para.line_segs, output.remaining())?;
        output.append_record(tags::HWPTAG_PARA_LINE_SEG, base_level + 1, &line_segs)?;
    }

    if !range_tags.is_empty() {
        let range_tags = serialize_para_range_tag_limited(&range_tags, output.remaining())?;
        output.append_record(tags::HWPTAG_PARA_RANGE_TAG, base_level + 1, &range_tags)?;
    }

    // Existing control serializers still return records, so contain their
    // lifetime to one control instead of accumulating a whole paragraph tree.
    for (ctrl_idx, ctrl) in para.controls.iter().enumerate() {
        let ctrl_data_record = para
            .ctrl_data_records
            .get(ctrl_idx)
            .and_then(|value| value.as_ref())
            .map(Vec::as_slice);
        preflight_control_allocation(ctrl, ctrl_data_record, output.remaining())?;
        let mut records = Vec::new();
        records
            .try_reserve(8)
            .map_err(|error| format!("HWP control record allocation failed: {error}"))?;
        super::control::serialize_control(ctrl, base_level + 1, ctrl_data_record, &mut records);
        output.append_records(&records)?;
    }
    Ok(())
}

const CONTROL_PREFLIGHT_MAX_DEPTH: usize = 64;

struct ControlAllocationBudget {
    remaining: usize,
}

impl ControlAllocationBudget {
    fn new(remaining: usize) -> Self {
        Self { remaining }
    }

    fn charge(&mut self, bytes: usize) -> Result<(), String> {
        self.remaining = self.remaining.checked_sub(bytes).ok_or_else(|| {
            "HWP nested control exceeds remaining structural byte limit".to_string()
        })?;
        Ok(())
    }

    fn charge_slice(&mut self, len: usize, element_bytes: usize) -> Result<(), String> {
        self.charge(
            len.checked_mul(element_bytes)
                .ok_or_else(|| "HWP nested control size overflow".to_string())?,
        )
    }

    fn charge_string(&mut self, value: &str) -> Result<(), String> {
        // Legacy control serializers commonly materialize UTF-16 units and a
        // byte payload while the UTF-8 source remains live. Eight bytes per
        // source byte is a conservative upper bound for that transient peak.
        self.charge(
            value
                .len()
                .checked_mul(8)
                .ok_or_else(|| "HWP nested control string size overflow".to_string())?,
        )
    }
}

fn preflight_control_allocation(
    control: &Control,
    ctrl_data_record: Option<&[u8]>,
    remaining: usize,
) -> Result<(), String> {
    let mut budget = ControlAllocationBudget::new(remaining);
    if let Some(data) = ctrl_data_record {
        budget.charge_slice(data.len(), 2)?;
    }
    preflight_control_into(control, &mut budget, 0)
}

fn preflight_master_page_allocation(
    master_page: &crate::model::header_footer::MasterPage,
    remaining: usize,
) -> Result<(), String> {
    let mut budget = ControlAllocationBudget::new(remaining);
    budget.charge(4096)?;
    budget.charge_slice(master_page.raw_list_header.len(), 2)?;
    preflight_paragraphs_into(&master_page.paragraphs, &mut budget, 0)
}

fn preflight_section_graph_depth(section: &Section) -> Result<(), String> {
    // The estimator already visits every nested control without allocating.
    // An effectively unbounded byte budget leaves output-size enforcement to
    // the exact bounded writers while retaining its overflow and depth checks.
    let mut budget = ControlAllocationBudget::new(usize::MAX);
    preflight_paragraphs_into(&section.paragraphs, &mut budget, 0)?;
    for master_page in &section.section_def.master_pages {
        preflight_paragraphs_into(&master_page.paragraphs, &mut budget, 0)?;
    }
    Ok(())
}

fn preflight_section_def_into(
    section_def: &crate::model::document::SectionDef,
    budget: &mut ControlAllocationBudget,
    depth: usize,
) -> Result<(), String> {
    if depth > CONTROL_PREFLIGHT_MAX_DEPTH {
        return Err("HWP nested control depth exceeds 64".to_string());
    }
    for raw in &section_def.extra_child_records {
        budget.charge_slice(raw.data.len(), 2)?;
    }
    for master_page in &section_def.master_pages {
        budget.charge_slice(master_page.raw_list_header.len(), 2)?;
        preflight_paragraphs_into(&master_page.paragraphs, budget, depth + 1)?;
    }
    Ok(())
}

fn preflight_section_def_injection(
    paragraph: &Paragraph,
    section_def: &crate::model::document::SectionDef,
    max_bytes: usize,
) -> Result<(), String> {
    let mut budget = ControlAllocationBudget::new(max_bytes);
    preflight_paragraphs_into(std::slice::from_ref(paragraph), &mut budget, 0)?;
    // Account for the newly allocated boxed control as well as the SectionDef
    // subgraph that `clone` would duplicate.
    budget.charge(8192)?;
    preflight_section_def_into(section_def, &mut budget, 1)
}

/// Allocation-free upper-bound preflight shared by the HWPX renderer.
///
/// HWPX generation temporarily keeps escaped text, run content, and the
/// enclosing member alive at once. Giving the existing structural estimator
/// one quarter of the member budget applies a conservative 4x transient
/// multiplier without traversing or cloning the graph a second time.
pub(crate) fn preflight_hwpx_paragraphs_allocation(
    paragraphs: &[Paragraph],
    max_bytes: usize,
) -> Result<(), String> {
    let mut budget = ControlAllocationBudget::new(max_bytes / 4);
    preflight_paragraphs_into(paragraphs, &mut budget, 0)
}

pub(crate) fn preflight_hwpx_master_page_allocation(
    master_page: &crate::model::header_footer::MasterPage,
    max_bytes: usize,
) -> Result<(), String> {
    let mut budget = ControlAllocationBudget::new(max_bytes / 4);
    budget.charge(4096)?;
    budget.charge_slice(master_page.raw_list_header.len(), 2)?;
    preflight_paragraphs_into(&master_page.paragraphs, &mut budget, 0)
}

fn preflight_paragraphs_into(
    paragraphs: &[Paragraph],
    budget: &mut ControlAllocationBudget,
    depth: usize,
) -> Result<(), String> {
    if depth > CONTROL_PREFLIGHT_MAX_DEPTH {
        return Err("HWP nested control depth exceeds 64".to_string());
    }
    for paragraph in paragraphs {
        budget.charge(2048)?;
        budget.charge_string(&paragraph.text)?;
        budget.charge_slice(paragraph.raw_header_extra.len(), 2)?;
        budget.charge_slice(paragraph.char_offsets.len(), 8)?;
        budget.charge_slice(paragraph.char_shapes.len(), 16)?;
        budget.charge_slice(paragraph.line_segs.len(), 128)?;
        budget.charge_slice(paragraph.effective_markpen_range_tags().len(), 64)?;
        budget.charge_slice(paragraph.field_ranges.len(), 128)?;
        budget.charge_slice(paragraph.orphan_field_ends.len(), 128)?;
        budget.charge_slice(paragraph.tab_extended.len(), 28)?;
        for data in paragraph.ctrl_data_records.iter().flatten() {
            budget.charge_slice(data.len(), 2)?;
        }
        for control in &paragraph.controls {
            preflight_control_into(control, budget, depth + 1)?;
        }
    }
    Ok(())
}

fn preflight_caption_into(
    caption: &Option<crate::model::shape::Caption>,
    budget: &mut ControlAllocationBudget,
    depth: usize,
) -> Result<(), String> {
    if let Some(caption) = caption {
        budget.charge(1024)?;
        preflight_paragraphs_into(&caption.paragraphs, budget, depth + 1)?;
    }
    Ok(())
}

fn preflight_drawing_into(
    drawing: &crate::model::shape::DrawingObjAttr,
    budget: &mut ControlAllocationBudget,
    depth: usize,
) -> Result<(), String> {
    budget.charge(4096)?;
    budget.charge_slice(drawing.shape_attr.raw_rendering.len(), 2)?;
    if let Some(text_box) = &drawing.text_box {
        budget.charge_slice(text_box.raw_list_header_extra.len(), 2)?;
        preflight_paragraphs_into(&text_box.paragraphs, budget, depth + 1)?;
    }
    preflight_caption_into(&drawing.caption, budget, depth)
}

fn preflight_shape_into(
    shape: &crate::model::shape::ShapeObject,
    budget: &mut ControlAllocationBudget,
    depth: usize,
) -> Result<(), String> {
    use crate::model::shape::ShapeObject;

    if depth > CONTROL_PREFLIGHT_MAX_DEPTH {
        return Err("HWP nested control depth exceeds 64".to_string());
    }
    budget.charge(8192)?;
    budget.charge_string(&shape.common().description)?;
    budget.charge_slice(shape.common().raw_extra.len(), 2)?;
    if let Some(drawing) = shape.drawing() {
        preflight_drawing_into(drawing, budget, depth)?;
    }
    match shape {
        ShapeObject::Polygon(shape) => budget.charge_slice(shape.points.len(), 16)?,
        ShapeObject::Curve(shape) => budget.charge_slice(shape.points.len(), 16)?,
        ShapeObject::Group(group) => {
            preflight_caption_into(&group.caption, budget, depth)?;
            for child in &group.children {
                preflight_shape_into(child, budget, depth + 1)?;
            }
        }
        ShapeObject::Picture(picture) => preflight_picture_into(picture, budget, depth)?,
        ShapeObject::Chart(chart) => {
            budget.charge_slice(chart.raw_chart_data.len(), 2)?;
            if let Some(title) = &chart.title {
                budget.charge_string(title)?;
            }
            for axis in [&chart.x_axis, &chart.y_axis].into_iter().flatten() {
                if let Some(label) = &axis.label {
                    budget.charge_string(label)?;
                }
                for label in &axis.labels {
                    budget.charge_string(label)?;
                }
            }
            for series in &chart.series {
                budget.charge_string(&series.name)?;
                budget.charge_slice(series.values.len(), 16)?;
                for category in &series.categories {
                    budget.charge_string(category)?;
                }
            }
            preflight_caption_into(&chart.caption, budget, depth)?;
        }
        ShapeObject::Ole(ole) => {
            budget.charge_slice(ole.raw_tag_data.len(), 2)?;
            if let Some(preview) = &ole.preview {
                budget.charge_slice(preview.bytes.len(), 2)?;
            }
            preflight_caption_into(&ole.caption, budget, depth)?;
        }
        ShapeObject::Line(_)
        | ShapeObject::Rectangle(_)
        | ShapeObject::Ellipse(_)
        | ShapeObject::Arc(_) => {}
    }
    Ok(())
}

fn preflight_picture_into(
    picture: &crate::model::image::Picture,
    budget: &mut ControlAllocationBudget,
    depth: usize,
) -> Result<(), String> {
    budget.charge(8192)?;
    budget.charge_slice(picture.raw_picture_extra.len(), 2)?;
    if let Some(href) = &picture.href {
        budget.charge_string(href)?;
    }
    if let Some(path) = &picture.image_attr.external_path {
        budget.charge_string(path)?;
    }
    if let Some(shadow) = &picture.effects.shadow {
        for value in [
            &shadow.style,
            &shadow.alpha,
            &shadow.radius,
            &shadow.direction,
            &shadow.distance,
            &shadow.align_style,
            &shadow.rotation_style,
        ]
        .into_iter()
        .flatten()
        {
            budget.charge_string(value)?;
        }
        for point in [&shadow.skew, &shadow.scale].into_iter().flatten() {
            for value in [&point.x, &point.y].into_iter().flatten() {
                budget.charge_string(value)?;
            }
        }
        if let Some(color) = &shadow.color {
            for value in [
                &color.color_type,
                &color.scheme_idx,
                &color.system_idx,
                &color.preset_idx,
            ]
            .into_iter()
            .flatten()
            {
                budget.charge_string(value)?;
            }
            if let Some(rgb) = &color.rgb {
                for value in [&rgb.r, &rgb.g, &rgb.b].into_iter().flatten() {
                    budget.charge_string(value)?;
                }
            }
        }
    }
    preflight_caption_into(&picture.caption, budget, depth)
}

fn preflight_control_into(
    control: &Control,
    budget: &mut ControlAllocationBudget,
    depth: usize,
) -> Result<(), String> {
    if depth > CONTROL_PREFLIGHT_MAX_DEPTH {
        return Err("HWP nested control depth exceeds 64".to_string());
    }
    budget.charge(8192)?;
    match control {
        Control::SectionDef(section_def) => {
            preflight_section_def_into(section_def, budget, depth)?;
        }
        Control::ColumnDef(column) => {
            budget.charge_slice(column.widths.len(), 4)?;
            budget.charge_slice(column.gaps.len(), 4)?;
        }
        Control::Table(table) => {
            budget.charge_slice(table.raw_ctrl_data.len(), 2)?;
            budget.charge_slice(table.raw_table_record_extra.len(), 2)?;
            budget.charge_slice(table.row_sizes.len(), 4)?;
            budget.charge_slice(table.zones.len(), 24)?;
            preflight_caption_into(&table.caption, budget, depth)?;
            for cell in &table.cells {
                budget.charge(2048)?;
                budget.charge_slice(cell.raw_list_extra.len(), 2)?;
                if let Some(name) = &cell.field_name {
                    budget.charge_string(name)?;
                }
                preflight_paragraphs_into(&cell.paragraphs, budget, depth + 1)?;
            }
        }
        Control::Shape(shape) => preflight_shape_into(shape, budget, depth + 1)?,
        Control::Picture(picture) => preflight_picture_into(picture, budget, depth + 1)?,
        Control::Header(header) => {
            budget.charge_slice(header.raw_ctrl_extra.len(), 2)?;
            preflight_paragraphs_into(&header.paragraphs, budget, depth + 1)?;
        }
        Control::Footer(footer) => {
            budget.charge_slice(footer.raw_ctrl_extra.len(), 2)?;
            preflight_paragraphs_into(&footer.paragraphs, budget, depth + 1)?;
        }
        Control::Footnote(note) => {
            preflight_paragraphs_into(&note.paragraphs, budget, depth + 1)?;
        }
        Control::Endnote(note) => {
            preflight_paragraphs_into(&note.paragraphs, budget, depth + 1)?;
        }
        Control::HiddenComment(comment) => {
            preflight_paragraphs_into(&comment.paragraphs, budget, depth + 1)?;
        }
        Control::Bookmark(bookmark) => budget.charge_string(&bookmark.name)?,
        Control::CharOverlap(overlap) => {
            budget.charge_slice(overlap.chars.len(), 8)?;
            budget.charge_slice(overlap.char_shape_ids.len(), 8)?;
        }
        Control::Equation(equation) => {
            budget.charge_string(&equation.script)?;
            budget.charge_string(&equation.version_info)?;
            budget.charge_string(&equation.font_name)?;
            budget.charge_slice(equation.raw_ctrl_data.len(), 2)?;
        }
        Control::Field(field) => {
            budget.charge_string(&field.command)?;
            if let Some(name) = &field.ctrl_data_name {
                budget.charge_string(name)?;
            }
            if let Some(direction) = &field.memo_text_direction {
                budget.charge_string(direction)?;
            }
            if let Some(parameters) = &field.raw_parameters_xml {
                budget.charge_string(parameters)?;
            }
            preflight_paragraphs_into(&field.memo_paragraphs, budget, depth + 1)?;
        }
        Control::Form(form) => {
            budget.charge_string(&form.name)?;
            budget.charge_string(&form.caption)?;
            budget.charge_string(&form.text)?;
            for (key, value) in &form.properties {
                budget.charge_string(key)?;
                budget.charge_string(value)?;
            }
        }
        Control::Unknown(unknown) => {
            budget.charge_slice(unknown.raw_ctrl_data.len(), 2)?;
            for raw in &unknown.raw_child_records {
                budget.charge_slice(raw.data.len(), 2)?;
            }
        }
        Control::Hyperlink(link) => {
            budget.charge_string(&link.url)?;
            budget.charge_string(&link.text)?;
        }
        Control::Ruby(ruby) => {
            budget.charge_string(&ruby.main_text)?;
            budget.charge_string(&ruby.ruby_text)?;
        }
        Control::AutoNumber(_)
        | Control::NewNumber(_)
        | Control::PageNumberPos(_)
        | Control::PageHide(_) => {}
    }
    Ok(())
}

/// 문단의 control_mask 비트를 계산한다.
///
/// 각 컨트롤의 char_code(제어 문자 코드)가 비트 위치에 대응:
/// - 0x0002 (SectionDef, ColumnDef) → bit 2 = 0x04
/// - 0x0003 (FIELD_BEGIN) → bit 3 = 0x08
/// - 0x0004 (FIELD_END) → bit 4 = 0x10
/// - 0x0009 (TAB) → bit 9 = 0x200
/// - 0x000B (Table, Shape, Picture) → bit 11 = 0x800
/// - 0x0010 (Header, Footer) → bit 16 = 0x10000
/// - etc.
fn compute_control_mask(para: &Paragraph) -> u32 {
    let mut mask: u32 = 0;
    for ctrl in &para.controls {
        let (char_code, _) = control_char_code_and_id(ctrl);
        mask |= 1u32 << char_code;
    }
    // FIELD_END (0x0004): field_ranges 또는 앞 문단에서 시작한 필드의 끝이 있으면 비트 4 설정
    if !para.field_ranges.is_empty() || !para.orphan_field_ends.is_empty() {
        mask |= 1u32 << 0x0004;
    }
    // TAB (0x0009): text에 탭이 있으면 비트 9 설정
    if para.text.contains('\t') {
        mask |= 1u32 << 0x0009;
    }
    // LINE_BREAK (0x000A): text에 줄바꿈이 있으면 비트 10 설정
    if para.text.contains('\n') {
        mask |= 1u32 << 0x000A;
    }
    // 실제 방출할 묶음 빈칸(0x001E)만 비트 30을 세워 PARA_HEADER/PARA_TEXT를 맞춘다.
    if para
        .text
        .chars()
        .enumerate()
        .any(|(i, c)| c == '\u{00A0}' && serialize_nbspace_control(para, i))
    {
        mask |= 1u32 << 0x001E;
    }
    if should_serialize_soft_hyphen_as_hwp_hyphen(para) {
        mask |= 1u32 << tags::CHAR_HYPHEN;
    }
    // FIXED_WIDTH_SPACE (0x001F): HWPX에서 들어온 일부 문맥은 U+2007을
    // literal code point가 아니라 HWP5 fixed blank control로 저장해야 한다.
    if para
        .text
        .chars()
        .enumerate()
        .any(|(i, c)| c == '\u{2007}' && serialize_fwspace_control(para, i))
    {
        mask |= 1u32 << 0x001F;
    }
    mask
}

/// PARA_HEADER 직렬화 (control_mask를 외부에서 전달)
///
/// 레이아웃: char_count(u32) + control_mask(u32) + para_shape_id(u16) + style_id(u8) + break_type(u8)
/// + numCharShapes(u16) + numRangeTags(u16) + numLineSegs(u16) + instanceId(u32) + [추가 바이트]
fn serialize_para_header_with_mask(
    para: &Paragraph,
    num_char_shapes: usize,
    num_range_tags: usize,
    is_last: bool,
    control_mask: u32,
    char_count: u32,
) -> Vec<u8> {
    let mut w = ByteWriter::new();

    // MSB는 위치 기반으로 결정: 현재 스코프의 마지막 문단만 MSB=1
    let char_count_raw = char_count | if is_last { 0x80000000 } else { 0 };
    w.write_u32(char_count_raw).unwrap();
    w.write_u32(control_mask).unwrap();
    w.write_u16(para.para_shape_id).unwrap();
    w.write_u8(para.style_id).unwrap();

    let break_val: u8 = if para.raw_break_type != 0 {
        para.raw_break_type
    } else {
        match para.column_type {
            ColumnBreakType::Section => 0x01,
            ColumnBreakType::MultiColumn => 0x02,
            ColumnBreakType::Page => 0x04,
            ColumnBreakType::Column => 0x08,
            ColumnBreakType::None => 0x00,
        }
    };
    w.write_u8(break_val).unwrap();

    // count 필드는 실제 데이터 기반으로 항상 재생성 (편집 후 불일치 방지)
    w.write_u16(num_char_shapes as u16).unwrap();
    w.write_u16(num_range_tags as u16).unwrap();
    w.write_u16(para.line_segs.len() as u16).unwrap();

    // instanceId + 추가 바이트: raw_header_extra에서 복원
    // raw_header_extra[0..6] = numCharShapes(2) + numRangeTags(2) + numLineSegs(2) → 건너뜀
    // raw_header_extra[6..] = instanceId(4) + (옵션) 변경추적 UINT16 (2, 5.0.3.2 이상)
    if para.raw_header_extra.len() >= 10 {
        let extra = &para.raw_header_extra[6..];
        w.write_bytes(extra).unwrap();
    } else {
        // 새 문단 (HWPX 출처, raw_header_extra 없음): instanceId(4)만 기록.
        // 한컴 정답지 footnote-01.hwp 의 PARA_HEADER size=22 = 18 (heading) + 4 (instanceId).
        // 변경추적 UINT16 (size=24 형식) 은 한컴 정답지에 미사용.
        w.write_u32(0).unwrap();
    }

    w.into_bytes()
}


fn serialize_para_text(para: &Paragraph) -> Vec<u8> {
    serialize_para_text_limited(para, usize::MAX).expect("unbounded paragraph text serialization")
}

fn serialize_para_text_limited(para: &Paragraph, max_bytes: usize) -> Result<Vec<u8>, String> {
    para.validate_special_spaces().map_err(str::to_string)?;
    let utf16_units = para.text.encode_utf16().count();
    let tab_expansion_units = para
        .text
        .chars()
        .filter(|character| *character == '\t')
        .count()
        .checked_mul(7)
        .ok_or_else(|| "HWP paragraph text size overflow".to_string())?;
    let control_units = para
        .controls
        .len()
        .checked_mul(8)
        .ok_or_else(|| "HWP paragraph text size overflow".to_string())?;
    let field_end_units = para
        .field_ranges
        .len()
        .checked_add(para.orphan_field_ends.len())
        .and_then(|count| count.checked_mul(8))
        .ok_or_else(|| "HWP paragraph text size overflow".to_string())?;
    // This is a safe upper bound. Auto-number placeholders are counted once as
    // source text and again as a control, so actual output can be two bytes
    // smaller per placeholder.
    let max_units = utf16_units
        .checked_add(tab_expansion_units)
        .and_then(|units| units.checked_add(control_units))
        .and_then(|units| units.checked_add(field_end_units))
        .and_then(|units| units.checked_add(1))
        .ok_or_else(|| "HWP paragraph text size overflow".to_string())?;
    let required_bytes = max_units
        .checked_mul(2)
        .ok_or_else(|| "HWP paragraph text size overflow".to_string())?;
    if required_bytes > max_bytes {
        return Err(format!(
            "HWP paragraph text exceeds remaining structural byte limit: {required_bytes} > {max_bytes}"
        ));
    }
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(required_bytes)
        .map_err(|error| format!("HWP paragraph text allocation failed: {error}"))?;
    let mut ctrl_idx = 0;
    // Parsed character offsets are u32, but malformed inputs can legally carry
    // values at that boundary. Keep all working arithmetic wider so adding a
    // control slot or one encoded character cannot panic or wrap.
    let mut prev_end = 0u64;
    let mut tab_idx: usize = 0; // TAB 확장 데이터 인덱스

    // field_ranges에서 FIELD_END 삽입 정보를 수집
    // 두 종류로 분류:
    // 1. mid-text: end_char_idx < text_chars.len() → 해당 텍스트 문자 앞 갭에 삽입
    // 2. trailing: end_char_idx == text_chars.len() → 남은 컨트롤과 인터리빙
    let text_len = para.text.chars().count();
    let mut field_ends = Vec::new();
    let mut trailing_ends = Vec::new();
    field_ends
        .try_reserve_exact(para.field_ranges.len())
        .map_err(|error| format!("HWP field-end index allocation failed: {error}"))?;
    trailing_ends
        .try_reserve_exact(para.field_ranges.len())
        .map_err(|error| format!("HWP field-end index allocation failed: {error}"))?;

    for (order, fr) in para.field_ranges.iter().enumerate() {
        let marker = if let Some(control) = para.controls.get(fr.control_idx) {
            field_end_marker(control)
        } else {
            FieldEndMarker::default()
        };
        if fr.end_char_idx < text_len {
            field_ends.push((
                fr.end_char_idx,
                order,
                marker,
                fr.start_char_idx,
                fr.control_idx,
            ));
        } else {
            trailing_ends.push((fr.control_idx, marker, false));
        }
    }
    field_ends.sort_unstable_by_key(|&(end, order, _, _, _)| (end, order));
    let mut field_end_cursor = 0usize;
    let mut mid_end_emitted = vec![false; field_ends.len()];

    // Key trailing FIELD_ENDs by their control without allocating one map node
    // per entry. Linked indices retain declaration order for duplicate ranges,
    // while the final scan below retains declaration order for orphaned ends.
    // This makes emission O(controls + field ranges), rather than scanning every
    // field range once for every remaining control.
    let mut trailing_heads = Vec::new();
    trailing_heads
        .try_reserve_exact(para.controls.len())
        .map_err(|error| format!("HWP field-end control index allocation failed: {error}"))?;
    trailing_heads.resize(para.controls.len(), None);
    let mut trailing_tails = Vec::new();
    trailing_tails
        .try_reserve_exact(para.controls.len())
        .map_err(|error| format!("HWP field-end control index allocation failed: {error}"))?;
    trailing_tails.resize(para.controls.len(), None);
    let mut trailing_next = Vec::new();
    trailing_next
        .try_reserve_exact(trailing_ends.len())
        .map_err(|error| format!("HWP field-end link allocation failed: {error}"))?;
    trailing_next.resize(trailing_ends.len(), None);
    for (entry_index, (control_index, _, _)) in trailing_ends.iter().enumerate() {
        let Some(head) = trailing_heads.get_mut(*control_index) else {
            continue;
        };
        let tail = &mut trailing_tails[*control_index];
        if let Some(previous) = *tail {
            trailing_next[previous] = Some(entry_index);
        } else {
            *head = Some(entry_index);
        }
        *tail = Some(entry_index);
    }

    // 앞 문단에서 시작한 필드의 끝(고아 FIELD_END). 짝 필드의 ctrl_id 를 모르면(0) 마커를
    // 지어내지 않는다. 종전에는 아예 쓰지 않아, 여러 문단에 걸친 필드가 든 구역을 다시
    // 쓰면 필드가 닫히지 않은 채 남아 한글이 문서를 열지 못했다.
    let orphan_marker = |ofe: &crate::model::paragraph::OrphanFieldEnd| {
        (ofe.begin_ctrl_id != 0).then_some(FieldEndMarker {
            ctrl_id: ofe.begin_ctrl_id,
            memo_index: 0,
        })
    };
    for (i, ch) in para.text.chars().enumerate() {
        let offset = if i < para.char_offsets.len() {
            u64::from(para.char_offsets[i])
        } else {
            prev_end
        };
        for marker in para
            .orphan_field_ends
            .iter()
            .filter(|ofe| ofe.char_idx == i)
            .filter_map(orphan_marker)
        {
            push_field_end_ctrl_bytes(&mut bytes, marker);
            prev_end = prev_end
                .checked_add(8)
                .ok_or_else(|| "HWP paragraph character offset overflow".to_string())?;
        }

        // [Task #1050] AutoNumber placeholder 검출:
        // char_offsets[i] == prev_end 이고 ch == ' ' 이고 다음 char_offset 이 prev_end + 8 +
        // (실제 char 폭)인 경우 = placeholder space (i char 한 자리 차지 + 다음 char 가 8 점프 후).
        // 이 경우 ' ' 대신 AUTO_NUMBER 컨트롤 8 cu 작성 + prev_end = offset + 8.
        let next_offset = if i + 1 < para.char_offsets.len() {
            Some(u64::from(para.char_offsets[i + 1]))
        } else {
            None
        };
        // [#2740] placeholder 가 문단의 **마지막 문자**면 next_offset 이 없어 위 판정이
        // 항상 실패했다. 그러면 공백을 리터럴로 쓰고 남은 컨트롤을 뒤에 다시 방출하므로,
        // 재파싱 때 placeholder 가 하나 더 생겨 저장할 때마다 공백이 1개씩 무한히 늘었다
        // (수렴하지 않음 — 쪽번호 자동번호가 든 머리말/꼬리말이 대표 사례).
        //
        // 마지막 문자를 placeholder 로 봐도 안전한 근거: 파서(parser/body_text.rs:334)는
        // 0x0012 를 만나면 **항상** text 에 공백 placeholder 를 push 한다. 따라서 남은
        // 컨트롤이 자동번호인데 공백이 마지막이면 그 공백이 곧 placeholder 다 — 진짜
        // 공백이었다면 그 뒤에 placeholder 가 하나 더 붙어 마지막이 아니게 된다.
        let is_last_text_char = i + 1 == text_len;
        // 0x0012 만 본다. 각주·미주(0x0011)는 파서가 placeholder 공백을 넣지 않으므로
        // 그 앞의 공백은 사용자가 친 진짜 공백이다. 함께 보면 저장할 때마다 사라졌다.
        let is_autonum_placeholder = ch == ' '
            && offset == prev_end
            && ctrl_idx < para.controls.len()
            && control_char_code_and_id(&para.controls[ctrl_idx]).0 == 0x0012
            && next_offset.map_or(is_last_text_char, |n| n >= offset.saturating_add(8));
        if is_autonum_placeholder {
            let (ctrl_code, ctrl_id) = control_char_code_and_id(&para.controls[ctrl_idx]);
            push_extended_ctrl_bytes(&mut bytes, ctrl_code, ctrl_id);
            ctrl_idx += 1;
            prev_end = offset
                .checked_add(8)
                .ok_or_else(|| "HWP paragraph character offset overflow".to_string())?;
            continue;
        }

        // 갭에 컨트롤 문자 배치 (각 컨트롤 = 8 code unit)
        // 같은 문자 앞에 닫는 FIELD_END와 다음 FIELD_BEGIN이 같이 있으면
        // END를 먼저 놓는다. HWP 파서는 LIFO라 BEGIN→END 순이면 인접 링크가
        // 서로 비어 있는 중첩으로 다시 읽힌다. 빈 필드는 BEGIN 직후 END.
        // [#1795] 닫는 END를 먼저 소비하면 다음 컨트롤이 END 갭을 선점하지 않는다.
        let field_end_start = field_end_cursor;
        while field_end_cursor < field_ends.len() && field_ends[field_end_cursor].0 == i {
            field_end_cursor += 1;
        }
        for idx in field_end_start..field_end_cursor {
            let (_, _, marker, start, _) = field_ends[idx];
            if start < i {
                push_field_end_ctrl_bytes(&mut bytes, marker);
                prev_end = prev_end
                    .checked_add(8)
                    .ok_or_else(|| "HWP paragraph character offset overflow".to_string())?;
                mid_end_emitted[idx] = true;
            }
        }
        while ctrl_idx < para.controls.len() {
            let unpaired_empty = u64::try_from(
                (field_end_start..field_end_cursor)
                    .filter(|&idx| !mid_end_emitted[idx] && field_ends[idx].3 == i)
                    .count(),
            )
            .ok()
            .and_then(|count| count.checked_mul(8))
            .ok_or_else(|| "HWP paragraph field-end offset overflow".to_string())?;
            if !prev_end
                .checked_add(8)
                .and_then(|position| position.checked_add(unpaired_empty))
                .is_some_and(|position| position <= offset)
            {
                break;
            }
            let (ctrl_code, ctrl_id) = control_char_code_and_id(&para.controls[ctrl_idx]);
            push_extended_ctrl_bytes(&mut bytes, ctrl_code, ctrl_id);
            let emitted_ctrl = ctrl_idx;
            ctrl_idx += 1;
            prev_end = prev_end
                .checked_add(8)
                .ok_or_else(|| "HWP paragraph character offset overflow".to_string())?;
            for idx in field_end_start..field_end_cursor {
                let (_, _, marker, start, control_idx) = field_ends[idx];
                if !mid_end_emitted[idx] && start == i && control_idx == emitted_ctrl {
                    push_field_end_ctrl_bytes(&mut bytes, marker);
                    prev_end = prev_end
                        .checked_add(8)
                        .ok_or_else(|| "HWP paragraph character offset overflow".to_string())?;
                    mid_end_emitted[idx] = true;
                }
            }
        }
        for idx in field_end_start..field_end_cursor {
            if mid_end_emitted[idx] {
                continue;
            }
            push_field_end_ctrl_bytes(&mut bytes, field_ends[idx].2);
            prev_end = prev_end
                .checked_add(8)
                .ok_or_else(|| "HWP paragraph character offset overflow".to_string())?;
            mid_end_emitted[idx] = true;
        }

        // 앞선 컨트롤(secd/cold 등)을 갭에 채운 뒤에야 placeholder 위치에 닿는 경우가
        // 있다 (HWPX 출처 문단: 자동번호가 secd·cold 뒤에 온다). 위 판정은 갭을 채우기
        // 전 prev_end 로 했으므로 여기서 다시 본다. 놓치면 공백을 리터럴로 쓰고 자동번호를
        // 문단 끝에 내보내 번호가 문단 끝으로 옮겨지고 공백이 하나 늘었다.
        if ch == ' '
            && offset == prev_end
            && ctrl_idx < para.controls.len()
            && control_char_code_and_id(&para.controls[ctrl_idx]).0 == 0x0012
            && next_offset.map_or(is_last_text_char, |n| n >= offset.saturating_add(8))
        {
            let (ctrl_code, ctrl_id) = control_char_code_and_id(&para.controls[ctrl_idx]);
            push_extended_ctrl_bytes(&mut bytes, ctrl_code, ctrl_id);
            ctrl_idx += 1;
            prev_end = offset
                .checked_add(8)
                .ok_or_else(|| "HWP paragraph character offset overflow".to_string())?;
            continue;
        }

        // 텍스트 문자 쓰기
        match ch {
            '\t' => {
                push_code_unit(&mut bytes, 0x0009);
                // TAB 확장 데이터 복원 (탭 너비, 종류 등)
                if tab_idx < para.tab_extended.len() {
                    let mut ext = para.tab_extended[tab_idx];
                    // HWPX 파서가 탭 정지 간격/저장 거리 의미로 쓰는 예약 비트 — HWP5
                    // 스트림에는 보내지 않는다 (ext[5] 는 HWP5 원본 바이트 슬롯).
                    ext[5] &= !0xc000;
                    for &cu in &ext {
                        push_code_unit(&mut bytes, cu);
                    }
                } else {
                    // tab_extended 없을 때: ext[6]=0x0009 마커 필수, 나머지 0
                    for cu in [0u16, 0, 0, 0, 0, 0, 0x0009] {
                        push_code_unit(&mut bytes, cu);
                    }
                }
                tab_idx += 1;
                prev_end = offset
                    .checked_add(8)
                    .ok_or_else(|| "HWP paragraph character offset overflow".to_string())?;
            }
            '\n' => {
                push_code_unit(&mut bytes, 0x000A);
                prev_end = offset
                    .checked_add(1)
                    .ok_or_else(|| "HWP paragraph character offset overflow".to_string())?;
            }
            '\u{00A0}' => {
                // 묶음 빈칸 (HWP 5.0 표 7: 코드 30).
                push_code_unit(
                    &mut bytes,
                    if serialize_nbspace_control(para, i) {
                        0x001E
                    } else {
                        0x00A0
                    },
                );
                prev_end = offset
                    .checked_add(1)
                    .ok_or_else(|| "HWP paragraph character offset overflow".to_string())?;
            }
            '\u{00AD}' => {
                // HWP hyphen control (code 24), distinct from a literal '-'.
                // 원본이 리터럴 U+00AD 코드 유닛이었던 문단은 그대로 되돌린다.
                if should_serialize_soft_hyphen_as_hwp_hyphen(para) {
                    push_code_unit(&mut bytes, tags::CHAR_HYPHEN);
                } else {
                    push_code_unit(&mut bytes, 0x00AD);
                }
                prev_end = offset
                    .checked_add(1)
                    .ok_or_else(|| "HWP paragraph character offset overflow".to_string())?;
            }
            '\u{2007}' => {
                if serialize_fwspace_control(para, i) {
                    push_code_unit(&mut bytes, 0x001F);
                } else {
                    push_code_unit(&mut bytes, 0x2007);
                }
                prev_end = offset
                    .checked_add(1)
                    .ok_or_else(|| "HWP paragraph character offset overflow".to_string())?;
            }
            c => {
                let mut buf = [0u16; 2];
                let encoded = c.encode_utf16(&mut buf);
                for cu in encoded.iter() {
                    push_code_unit(&mut bytes, *cu);
                }
                prev_end = offset
                    .checked_add(encoded.len() as u64)
                    .ok_or_else(|| "HWP paragraph character offset overflow".to_string())?;
            }
        }
    }

    // 남은 컨트롤 배치 + trailing FIELD_END 인터리빙
    // FIELD_BEGIN 컨트롤 직후에 대응하는 FIELD_END를 삽입하여 올바른 순서를 보장한다.
    while ctrl_idx < para.controls.len() {
        let (ctrl_code, ctrl_id) = control_char_code_and_id(&para.controls[ctrl_idx]);
        push_extended_ctrl_bytes(&mut bytes, ctrl_code, ctrl_id);

        // 이 컨트롤(FIELD_BEGIN)에 대응하는 trailing FIELD_END 삽입
        let mut trailing_index = trailing_heads[ctrl_idx];
        while let Some(index) = trailing_index {
            let marker = trailing_ends[index].1;
            push_field_end_ctrl_bytes(&mut bytes, marker);
            trailing_ends[index].2 = true;
            trailing_index = trailing_next[index];
        }

        ctrl_idx += 1;
    }

    // orphan trailing FIELD_END: FIELD_BEGIN이 본문 갭에서 이미 배치된 경우
    // (미방출 항목 = FIELD_BEGIN 컨트롤이 본문 갭에서 이미 소진됨)
    for (_, marker, emitted) in trailing_ends {
        if !emitted {
            push_field_end_ctrl_bytes(&mut bytes, marker);
        }
    }
    for marker in para
        .orphan_field_ends
        .iter()
        .filter(|ofe| ofe.char_idx >= text_len)
        .filter_map(orphan_marker)
    {
        push_field_end_ctrl_bytes(&mut bytes, marker);
    }

    // 문단 끝 마커
    push_code_unit(&mut bytes, 0x000D);
    Ok(bytes)
}

fn push_code_unit(bytes: &mut Vec<u8>, code_unit: u16) {
    bytes.extend_from_slice(&code_unit.to_le_bytes());
}

/// Append one eight-code-unit extended control directly as UTF-16LE bytes.
fn push_extended_ctrl_bytes(bytes: &mut Vec<u8>, ctrl_code: u16, ctrl_id: u32) {
    push_code_unit(bytes, ctrl_code);
    let id_bytes = ctrl_id.to_le_bytes();
    push_code_unit(bytes, u16::from_le_bytes([id_bytes[0], id_bytes[1]]));
    push_code_unit(bytes, u16::from_le_bytes([id_bytes[2], id_bytes[3]]));
    for _ in 0..4 {
        push_code_unit(bytes, 0);
    }
    push_code_unit(bytes, ctrl_code);
}

/// PARA_CHAR_SHAPE 직렬화
///
/// 각 항목: start_pos(u32) + char_shape_id(u32) = 8바이트
fn serialize_para_char_shape(char_shapes: &[CharShapeRef]) -> Vec<u8> {
    serialize_para_char_shape_limited(char_shapes, usize::MAX)
        .expect("unbounded paragraph character-shape serialization")
}

fn serialize_para_char_shape_limited(
    char_shapes: &[CharShapeRef],
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let size = char_shapes
        .len()
        .checked_mul(8)
        .ok_or_else(|| "HWP paragraph character-shape size overflow".to_string())?;
    let mut bytes = try_payload_buffer(size, max_bytes, "paragraph character-shape")?;
    for cs in char_shapes {
        bytes.extend_from_slice(&cs.start_pos.to_le_bytes());
        bytes.extend_from_slice(&cs.char_shape_id.to_le_bytes());
    }
    Ok(bytes)
}

#[derive(Debug, Clone, Copy, Default)]
struct FieldEndMarker {
    ctrl_id: u32,
    memo_index: u32,
}

fn field_end_marker(ctrl: &Control) -> FieldEndMarker {
    match ctrl {
        Control::Field(field)
            if field.field_type == crate::model::control::FieldType::Memo
                || field.command.starts_with("MEMO/") =>
        {
            FieldEndMarker {
                ctrl_id: tags::FIELD_MEMO,
                memo_index: memo_field_index(field),
            }
        }
        Control::Field(field) => FieldEndMarker {
            ctrl_id: field.ctrl_id,
            memo_index: 0,
        },
        _ => FieldEndMarker::default(),
    }
}

fn memo_field_index(field: &crate::model::control::Field) -> u32 {
    if field.memo_index != 0 {
        return field.memo_index;
    }
    parse_memo_index_from_command(&field.command).unwrap_or(0)
}

fn parse_memo_index_from_command(command: &str) -> Option<u32> {
    command.split('/').nth(2)?.parse().ok()
}

fn push_field_end_ctrl_bytes(bytes: &mut Vec<u8>, marker: FieldEndMarker) {
    if marker.ctrl_id == tags::FIELD_MEMO {
        // Hancom writes MEMO field end with a distinct 8-code-unit marker:
        //   04 00 65 6d 25 00 01 ff ff 00 01 00 00 00 04 00
        // The sixth code unit is the memo index. Hard-coding `1` only
        // makes the first memo look correct and breaks later memo anchors.
        // The begin marker is still `%%me`; reusing that begin marker for
        // FIELD_END makes Hancom open the file but leaves memo visual styling
        // unapplied.
        for code_unit in [
            0x0004,
            0x6d65,
            0x0025,
            0xff01,
            0x00ff,
            marker.memo_index as u16,
            0x0000,
            0x0004,
        ] {
            push_code_unit(bytes, code_unit);
        }
    } else {
        push_extended_ctrl_bytes(bytes, 0x0004, marker.ctrl_id);
    }
}

/// PARA_LINE_SEG 직렬화
///
/// 각 항목: 36바이트 (u32 + i32×7 + u32)
fn serialize_para_line_seg(line_segs: &[LineSeg]) -> Vec<u8> {
    serialize_para_line_seg_limited(line_segs, usize::MAX)
        .expect("unbounded paragraph line-segment serialization")
}

fn serialize_para_line_seg_limited(
    line_segs: &[LineSeg],
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let size = line_segs
        .len()
        .checked_mul(36)
        .ok_or_else(|| "HWP paragraph line-segment size overflow".to_string())?;
    let mut bytes = try_payload_buffer(size, max_bytes, "paragraph line-segment")?;
    for seg in line_segs {
        bytes.extend_from_slice(&seg.text_start.to_le_bytes());
        bytes.extend_from_slice(&seg.vertical_pos.to_le_bytes());
        bytes.extend_from_slice(&seg.line_height.to_le_bytes());
        bytes.extend_from_slice(&seg.text_height.to_le_bytes());
        bytes.extend_from_slice(&seg.baseline_distance.to_le_bytes());
        bytes.extend_from_slice(&seg.line_spacing.to_le_bytes());
        bytes.extend_from_slice(&seg.column_start.to_le_bytes());
        bytes.extend_from_slice(&seg.segment_width.to_le_bytes());
        bytes.extend_from_slice(&seg.tag.to_le_bytes());
    }
    Ok(bytes)
}

/// PARA_RANGE_TAG 직렬화
///
/// 각 항목: 12바이트 (u32 × 3)
fn serialize_para_range_tag(range_tags: &[RangeTag]) -> Vec<u8> {
    serialize_para_range_tag_limited(range_tags, usize::MAX)
        .expect("unbounded paragraph range-tag serialization")
}

fn serialize_para_range_tag_limited(
    range_tags: &[RangeTag],
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let size = range_tags
        .len()
        .checked_mul(12)
        .ok_or_else(|| "HWP paragraph range-tag size overflow".to_string())?;
    let mut bytes = try_payload_buffer(size, max_bytes, "paragraph range-tag")?;
    for rt in range_tags {
        bytes.extend_from_slice(&rt.start.to_le_bytes());
        bytes.extend_from_slice(&rt.end.to_le_bytes());
        bytes.extend_from_slice(&rt.tag.to_le_bytes());
    }
    Ok(bytes)
}

fn try_payload_buffer(size: usize, max_bytes: usize, label: &str) -> Result<Vec<u8>, String> {
    if size > max_bytes {
        return Err(format!(
            "HWP {label} payload exceeds remaining structural byte limit: {size} > {max_bytes}"
        ));
    }
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(size)
        .map_err(|error| format!("HWP {label} allocation failed: {error}"))?;
    Ok(bytes)
}

/// U+00AD 를 HWP 하이픈 컨트롤(코드 24)로 되돌릴지 판단한다.
///
/// 파서는 코드 24 와 리터럴 U+00AD 코드 유닛을 모두 U+00AD 로 싣는다. 한컴 원본에는
/// 리터럴 U+00AD 만 든 문단(control_mask 비트 24 없음)도 있으므로, 문단의 control_mask
/// 비트 24 를 출처 표지로 삼아 원래 코드 유닛과 마스크를 보존한다.
fn should_serialize_soft_hyphen_as_hwp_hyphen(para: &Paragraph) -> bool {
    para.control_mask & (1u32 << tags::CHAR_HYPHEN) != 0 && para.text.contains('\u{00AD}')
}

fn serialize_nbspace_control(para: &Paragraph, index: usize) -> bool {
    match para.space_origin_at(index) {
        Some(crate::model::paragraph::SpecialSpaceOriginKind::NbSpace) => true,
        Some(_) => false,
        None => true, // 기존 미상 NBSP 경로
    }
}

fn serialize_fwspace_control(para: &Paragraph, index: usize) -> bool {
    match para.space_origin_at(index) {
        Some(crate::model::paragraph::SpecialSpaceOriginKind::FwSpace) => true,
        Some(_) => false,
        None => should_serialize_figure_space_as_hwp_fixed_blank(para),
    }
}

fn should_serialize_figure_space_as_hwp_fixed_blank(para: &Paragraph) -> bool {
    const HWP5_AUTONUM_FWSPACE_TRAILING_TAG: u32 = 0x0100_0023;
    const HWP5_FIXED_WIDTH_SPACE_MASK: u32 = 1u32 << 0x001f;

    if para.control_mask & HWP5_FIXED_WIDTH_SPACE_MASK != 0 && para.text.contains('\u{2007}') {
        return true;
    }

    para.text.starts_with(" \u{2007}")
        && para
            .controls
            .iter()
            .any(|ctrl| matches!(ctrl, Control::AutoNumber(_)))
        && para
            .range_tags
            .iter()
            .any(|range_tag| range_tag.tag == HWP5_AUTONUM_FWSPACE_TRAILING_TAG)
}

/// 컨트롤에 대응하는 PARA_TEXT 내 제어 문자 코드와 ctrl_id를 반환
///
/// HWP 5.0 제어 문자 분류 (표 6):
///   0x0002: 구역/단 정의 (secd, cold)
///   0x000B: 표/그림/도형 (tbl, gso)
///   0x000F: 숨은 설명 (tcmt)
///   0x0010: 머리말/꼬리말 (head, foot)
///   0x0011: 각주/미주 (fn, en)
///   0x0012: 자동번호 (atno)
///   0x0015: 페이지 컨트롤/새 번호 (pgnp, pghi, nwno)
///   0x0016: 책갈피 (bokm)
fn control_char_code_and_id(ctrl: &Control) -> (u16, u32) {
    match ctrl {
        Control::SectionDef(_) => (0x0002, tags::CTRL_SECTION_DEF),
        Control::ColumnDef(_) => (0x0002, tags::CTRL_COLUMN_DEF),
        Control::Table(_) => (0x000B, tags::CTRL_TABLE),
        Control::Shape(_) => (0x000B, tags::CTRL_GEN_SHAPE),
        Control::Picture(_) => (0x000B, tags::CTRL_GEN_SHAPE),
        Control::HiddenComment(_) => (0x000F, tags::CTRL_HIDDEN_COMMENT),
        Control::Header(_) => (0x0010, tags::CTRL_HEADER),
        Control::Footer(_) => (0x0010, tags::CTRL_FOOTER),
        Control::Footnote(_) => (0x0011, tags::CTRL_FOOTNOTE),
        Control::Endnote(_) => (0x0011, tags::CTRL_ENDNOTE),
        Control::AutoNumber(_) => (0x0012, tags::CTRL_AUTO_NUMBER),
        // Hancom HWP5 oracle files store `nwno` in the 0x0015 page-control
        // family. Serializing it as 0x0012 makes Hancom 2020 treat the first
        // section paragraph as damaged/modified around the page control chain.
        Control::NewNumber(_) => (0x0015, tags::CTRL_NEW_NUMBER),
        Control::PageNumberPos(_) => (0x0015, tags::CTRL_PAGE_NUM_POS),
        Control::PageHide(_) => (0x0015, tags::CTRL_PAGE_HIDE),
        Control::Bookmark(_) => (0x0016, tags::CTRL_BOOKMARK),
        Control::Hyperlink(_) => (0x000B, 0),
        // 덧말은 한컴 저장본과 같이 글자 겹침 계열(0x0017) 확장 문자 + 'tdut'.
        Control::Ruby(_) => (0x0017, tags::CTRL_CHAR_OVERLAP),
        Control::CharOverlap(_) => (0x0017, tags::CTRL_TCPS),
        Control::Field(f) => (0x0003, f.ctrl_id),
        Control::Equation(_) => (0x000B, tags::CTRL_EQUATION),
        Control::Form(_) => (0x000B, tags::CTRL_FORM),
        Control::Unknown(u) => (0x000B, u.ctrl_id),
    }
}


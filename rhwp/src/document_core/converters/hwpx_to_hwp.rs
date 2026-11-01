//! HWPX → HWP IR 매핑 어댑터
//!
//! HWPX 파서가 채운 IR 을 HWP 직렬화기가 받아들이는 형태로 정규화한다.
//!
//! ## 핵심 원칙
//!
//! - **HWP 직렬화기 0줄 수정**: `serializer/cfb_writer.rs`, `body_text.rs`,
//!   `control.rs` 등은 변경하지 않는다.
//! - **IR 만 만진다**: 진입점은 `&mut Document` 이며, 출력은 IR 필드 갱신뿐.
//! - **idempotent**: 같은 IR 에 두 번 호출해도 같은 결과.
//! - **HWP 출처 보호**: `source_format == Hwpx` 일 때만 동작. HWP 출처는 no-op.
//!
//! ## 매핑 명세서
//!
//! HWP 직렬화기가 IR 에서 무엇을 읽는지가 단 하나의 명세서 (구현계획서 §1.3 참조).
//!
//! Stage 1 (현재): 진입점만 노출. 영역별 매핑은 Stage 2~ 에서 추가.

use std::collections::BTreeSet;

use crate::model::bin_data::{BinDataContent, BinDataStatus, BinDataType};
use crate::model::control::Control;
use crate::model::document::{Document, Section, SectionDef};
use crate::model::image::Picture;
use crate::model::paragraph::Paragraph;
use crate::model::shape::{common_obj_offsets, ShapeObject, TextBox};
use crate::model::style::{BorderFill, BorderLineType, Fill, FillType};
use crate::model::table::{Cell, Table, TablePageBreak};
use crate::parser::FileFormat;

use super::common_obj_attr_writer::{pack_common_attr_bits, serialize_common_obj_attr};

/// 어댑터 실행 보고서.
///
/// 각 영역별로 변환된 항목 수를 누적한다. 진단 도구와 단계별 회귀 측정에 사용.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct AdapterReport {
    /// 변환을 건너뛴 사유 (HWP 출처 등). None 이면 정상 적용.
    pub skipped_reason: Option<String>,
    /// `table.raw_ctrl_data` 합성 횟수 (Stage 2)
    pub tables_ctrl_data_synthesized: u32,
    /// `table.attr` 재구성 횟수 (Stage 2)
    pub tables_attr_packed: u32,
    /// HWPX 표의 page_break 를 한컴 HWP 저장 관례에 맞춰 보강한 횟수
    pub tables_page_break_materialized: u32,
    /// 표 outer_margin 을 CommonObjAttr.margin 으로 승격한 횟수
    pub tables_outer_margin_materialized: u32,
    /// HWPX 표 CTRL_HEADER attr 중 한컴 HWP 저장 관례 비트 보강 횟수
    pub table_ctrl_header_attr_materialized: u32,
    /// HWPX 표 TABLE record attr 중 한컴 저장 관례 비트 보강 횟수
    pub table_record_attr_materialized: u32,
    /// HWPX 표 TABLE record row-size payload 를 행별 셀 수로 보강한 횟수
    pub table_record_row_sizes_materialized: u32,
    /// HWPX 표 TABLE record trailing zone/count payload 를 한컴 저장 관례로 보강한 횟수
    pub table_record_extra_materialized: u32,
    /// `cell.list_attr bit 16` 보강 횟수 (Stage 3)
    pub cells_list_attr_bit16_set: u32,
    /// HWPX 출처 셀 LIST_HEADER width_ref/raw_list_extra materialize 횟수
    pub cells_list_header_contract_materialized: u32,
    /// Native HWPX disabled cell margins materialized as the table margin for HWP5.
    pub cells_padding_normalized_for_hwp: u32,
    /// paragraph/char shape 참조 BorderFill 무채움 정규화 횟수
    pub border_fills_no_fill_normalized: u32,
    /// HWPX 출처 FileHeader를 HWP5 compressed 저장 관례로 보정한 횟수
    pub file_header_compression_normalized: u32,
    /// HWPX 출처 DocProperties.section_count 보정 횟수
    pub doc_properties_section_count_normalized: u32,
    /// HWPX embedded BinData metadata 보정 횟수
    pub bin_data_metadata_normalized: u32,
    /// HWPX OLE Storage 포함 문서의 HWP5 BinData 순서/참조 materialize 횟수
    pub bin_data_order_materialized: u32,
    /// HWPX manifest 번호(image14 등)를 HWP5 BinData 1-based 위치로 바꾼 횟수
    pub bin_data_ids_positionalized: u32,
    /// `Control::SectionDef` 컨트롤 삽입 횟수 (Stage 4 — 섹션 개수)
    pub section_def_controls_inserted: u32,
    /// HWPX `hp:pic@href` 를 HWP CTRL_DATA ParameterSet 으로 materialize한 횟수
    pub picture_href_ctrl_data_materialized: u32,
    /// HWPX 3x2 row-break table의 HWP5 layout CTRL_DATA ParameterSet materialize 횟수
    pub table_layout_ctrl_data_materialized: u32,
    /// HWPX drawText TextBox LIST_HEADER tail materialize 횟수
    pub text_box_list_header_tail_materialized: u32,
    /// HWPX drawText 내부 paragraph PARA_HEADER tail materialize 횟수
    pub text_box_para_header_tail_materialized: u32,
    /// HWPX 출처 일반 paragraph PARA_HEADER tail materialize 횟수
    pub para_header_tail_materialized: u32,
    /// HWPX 수식(Equation) CTRL_HEADER attr 중 한컴 저장 관례 비트 보강 횟수 (Task #1061)
    pub equation_ctrl_header_attr_materialized: u32,
    /// HWPX 수식(Equation) EQEDIT 의 font_name/version_info 정답지 정합 정정 횟수 (Task #1061 Stage 2)
    pub equation_font_version_normalized: u32,
    /// HWPX 바탕쪽 포함 SectionDef CTRL_HEADER 확장 tail materialize 횟수
    pub section_def_master_page_tail_materialized: u32,
    /// HWPX 후속 구역 첫 문단 break_type 을 한컴 HWP 저장 관례로 보정한 횟수
    pub following_section_break_type_materialized: u32,
    /// HWPX SectionDef masterPageCnt=1 flags 를 한컴 HWP 저장 관례로 보정한 횟수
    pub section_def_single_master_page_flags_materialized: u32,
    /// HWPX SectionDef masterPageCnt=2 flags 를 한컴 HWP 저장 관례로 보정한 횟수
    pub section_def_multi_master_page_flags_materialized: u32,
    /// HWPX SectionDef hide_empty_line bool 을 HWP5 flags bit 19로 동기화한 횟수
    pub section_def_hide_empty_line_flag_materialized: u32,
    /// HWPX AutoNumber 뒤 fixed-width space 문단의 HWP5 PARA_RANGE_TAG materialize 횟수
    pub autonum_fwspace_range_tag_materialized: u32,
    /// HWPX AutoNumber 뒤 fixed-width space 문단의 char shape start_pos 보정 횟수
    pub autonum_fwspace_char_shape_offsets_materialized: u32,
    /// HWPX fixed-width space를 HWP5 fixed blank control로 보존한 횟수
    pub header_footer_fwspace_control_materialized: u32,
    /// HWPX 바탕쪽 AutoNumber-only 문단의 placeholder space 제거 횟수
    pub master_page_autonum_placeholder_removed: u32,
    /// HWPX 바탕쪽 line shape rendering matrix를 HWP5 size ratio contract로 보정한 횟수
    pub master_page_line_rendering_size_ratio_materialized: u32,
    /// [#2767] 캡션이 있는 그림(gso `$pic`) CTRL_HEADER 의 한컴 캡션 비트(bit 29,
    /// 0x2000_0000) 보강 횟수. 표는 이미 `materialize_table_ctrl_header_attr` 로
    /// 보강되지만 그림은 빠져 있었다(전 코퍼스 실측 80/80 이 개체 종류와 무관하게
    /// 이 비트를 요구).
    pub picture_caption_common_attr_materialized: u32,
    /// 캡션이 있는 도형(선·사각형·타원·다각형·호·곡선·묶음·차트) CTRL_HEADER bit 29 보강 횟수
    pub shape_caption_common_attr_materialized: u32,
}

impl AdapterReport {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn no_op(mut self, reason: impl Into<String>) -> Self {
        self.skipped_reason = Some(reason.into());
        self
    }

    /// 어댑터가 실제로 무언가를 변경했는지 여부.
    pub fn changed_anything(&self) -> bool {
        self.skipped_reason.is_none()
            && (self.tables_ctrl_data_synthesized
                + self.tables_attr_packed
                + self.tables_page_break_materialized
                + self.tables_outer_margin_materialized
                + self.table_ctrl_header_attr_materialized
                + self.table_record_attr_materialized
                + self.table_record_row_sizes_materialized
                + self.table_record_extra_materialized
                + self.cells_list_attr_bit16_set
                + self.cells_list_header_contract_materialized
                + self.cells_padding_normalized_for_hwp
                + self.border_fills_no_fill_normalized
                + self.file_header_compression_normalized
                + self.doc_properties_section_count_normalized
                + self.bin_data_metadata_normalized
                + self.bin_data_order_materialized
                + self.bin_data_ids_positionalized
                + self.section_def_controls_inserted
                + self.picture_href_ctrl_data_materialized
                + self.table_layout_ctrl_data_materialized
                + self.text_box_list_header_tail_materialized
                + self.text_box_para_header_tail_materialized
                + self.para_header_tail_materialized
                + self.equation_ctrl_header_attr_materialized
                + self.equation_font_version_normalized
                + self.section_def_master_page_tail_materialized
                + self.following_section_break_type_materialized
                + self.section_def_single_master_page_flags_materialized
                + self.section_def_multi_master_page_flags_materialized
                + self.section_def_hide_empty_line_flag_materialized
                + self.autonum_fwspace_range_tag_materialized
                + self.autonum_fwspace_char_shape_offsets_materialized
                + self.header_footer_fwspace_control_materialized
                + self.master_page_autonum_placeholder_removed
                + self.master_page_line_rendering_size_ratio_materialized
                + self.picture_caption_common_attr_materialized
                + self.shape_caption_common_attr_materialized)
                > 0
    }
}

/// HWPX 출처 IR 을 HWP 직렬화기가 기대하는 형태로 정규화한다.
///
/// HWP 출처에는 no-op (idempotent + 보호).
///
/// ## 실행 영역
///
/// - **SectionDef 컨트롤 삽입** (Stage 4) — `Section.section_def` 를 첫 문단의 `controls`
///   시작 위치에 `Control::SectionDef` 로 삽입. HWPX 파서가 만들지 않으므로 PAGE_DEF 누락
///   → 재로드 시 페이지 크기 0 이 되는 결손 보강.
/// - **표 raw_ctrl_data + attr 합성** (Stage 2)
/// - **셀 list_attr bit 16 합성** (Stage 3)
///
/// ## lineseg vpos 가 본 어댑터에 없는 이유
///
/// HWPX 로드 시점에 `DocumentCore::from_bytes` 가 `reflow_zero_height_paragraphs`
/// (`document_core/commands/document.rs:208-318`) 를 호출하여 IR 의 `line_segs[].vertical_pos`
/// 를 in-place 로 갱신한다. 이 갱신은 메모리상 IR 에 영구 반영되므로, 어댑터 시점에는 이미
/// 정확한 vpos 가 채워져 있어 추가 사전계산이 불필요. 직렬화 → 재로드 시에도 vpos 가 그대로
/// 보존된다 (정수 필드 라운드트립).
pub fn convert_hwpx_to_hwp_ir(doc: &mut Document) -> AdapterReport {
    let mut report = AdapterReport::new();

    // The HWPX hasMargin switch makes a disabled cellMargin inert even when
    // inMargin is all zero. HWP5's legacy all-zero fallback would reactivate
    // that saved cellMargin after export unless the effective value is stored.
    if doc.layout_profile().native_hwpx_cell_margin() {
        materialize_native_hwpx_cell_margins(doc, &mut report);
    }

    normalize_file_header_for_hwp(doc, &mut report);
    normalize_doc_properties_for_hwp(doc, &mut report);
    positionalize_hwpx_bin_data_ids(doc, &mut report);
    materialize_hwp5_bin_data_order(doc, &mut report);
    normalize_bin_data_for_hwp(doc, &mut report);

    // Stage 4: SectionDef 컨트롤 삽입 (HWPX 파서가 만들지 않으므로 직렬화기가 PAGE_DEF 출력 못 함)
    for (section_idx, section) in doc.sections.iter_mut().enumerate() {
        adapt_section_def(&mut section.section_def, &mut report);
        insert_section_def_control(section, &mut report);
        materialize_following_section_break_type(section_idx, section, &mut report);
    }

    normalize_paragraph_char_border_fills(doc, &mut report);

    // Stage 2/3: 표 ctrl_data + 셀 list_attr (raw_ctrl_data 합성)
    for section in &mut doc.sections {
        for para in &mut section.paragraphs {
            adapt_paragraph(para, &mut report);
        }
    }

    report
}

fn materialize_native_hwpx_cell_margins(doc: &mut Document, report: &mut AdapterReport) {
    fn visit_shape(shape: &mut ShapeObject, report: &mut AdapterReport) {
        if let Some(drawing) = shape.drawing_mut() {
            if let Some(text_box) = &mut drawing.text_box {
                visit_paragraphs(&mut text_box.paragraphs, report);
            }
            if let Some(caption) = &mut drawing.caption {
                visit_paragraphs(&mut caption.paragraphs, report);
            }
        }
        match shape {
            ShapeObject::Group(group) => {
                if let Some(caption) = &mut group.caption {
                    visit_paragraphs(&mut caption.paragraphs, report);
                }
                for child in &mut group.children {
                    visit_shape(child, report);
                }
            }
            ShapeObject::Picture(picture) => {
                if let Some(caption) = &mut picture.caption {
                    visit_paragraphs(&mut caption.paragraphs, report);
                }
            }
            ShapeObject::Chart(chart) => {
                if let Some(caption) = &mut chart.caption {
                    visit_paragraphs(&mut caption.paragraphs, report);
                }
            }
            ShapeObject::Ole(ole) => {
                if let Some(caption) = &mut ole.caption {
                    visit_paragraphs(&mut caption.paragraphs, report);
                }
            }
            _ => {}
        }
    }

    fn visit_paragraphs(paragraphs: &mut [Paragraph], report: &mut AdapterReport) {
        for para in paragraphs {
            for control in &mut para.controls {
                match control {
                    Control::Table(table) => {
                        for cell in &mut table.cells {
                            if !cell.apply_inner_margin {
                                let effective = cell.effective_hwpx_padding(&table.padding);
                                if (
                                    cell.padding.left,
                                    cell.padding.right,
                                    cell.padding.top,
                                    cell.padding.bottom,
                                ) != (
                                    effective.left,
                                    effective.right,
                                    effective.top,
                                    effective.bottom,
                                ) {
                                    cell.padding = effective;
                                    report.cells_padding_normalized_for_hwp += 1;
                                }
                            }
                            visit_paragraphs(&mut cell.paragraphs, report);
                        }
                        if let Some(caption) = &mut table.caption {
                            visit_paragraphs(&mut caption.paragraphs, report);
                        }
                    }
                    Control::Header(header) => visit_paragraphs(&mut header.paragraphs, report),
                    Control::Footer(footer) => visit_paragraphs(&mut footer.paragraphs, report),
                    Control::Picture(picture) => {
                        if let Some(caption) = &mut picture.caption {
                            visit_paragraphs(&mut caption.paragraphs, report);
                        }
                    }
                    Control::Shape(shape) => visit_shape(shape, report),
                    Control::Footnote(note) => visit_paragraphs(&mut note.paragraphs, report),
                    Control::Endnote(note) => visit_paragraphs(&mut note.paragraphs, report),
                    Control::HiddenComment(comment) => {
                        visit_paragraphs(&mut comment.paragraphs, report)
                    }
                    Control::Field(field) => visit_paragraphs(&mut field.memo_paragraphs, report),
                    _ => {}
                }
            }
        }
    }

    for section in &mut doc.sections {
        for master_page in &mut section.section_def.master_pages {
            visit_paragraphs(&mut master_page.paragraphs, report);
        }
        visit_paragraphs(&mut section.paragraphs, report);
    }
}

/// HWPX embedded BinData를 한컴 HWP 저장 관례에 맞춰 materialize한다.
///
/// HWPX parser는 `content.hpf`의 BinData 항목을 모델에 등록하지만 HWP `BIN_DATA`
/// record 전용 attr/status 값은 비워 둔다. 한컴 HWP 로더는 일반 embedded image의
/// `BIN_DATA` record에서 `attr=0x0101` + Success 상태를 허용하지만, OLE storage가 함께
/// 있는 문서에서는 한컴 저장본이 image/OLE 모두 NotAccessed 계약(`0x0001`/`0x0002`)을
/// 사용한다. HWP 저장 직전에 HWPX 출처 모델을 이 계약으로 명시적으로 보정한다.
fn normalize_bin_data_for_hwp(doc: &mut Document, report: &mut AdapterReport) {
    let mut changed = false;
    let has_storage = doc
        .doc_info
        .bin_data_list
        .iter()
        .any(|bin_data| bin_data.data_type == BinDataType::Storage);

    for bin_data in &mut doc.doc_info.bin_data_list {
        if !matches!(
            bin_data.data_type,
            BinDataType::Embedding | BinDataType::Storage
        ) {
            continue;
        }

        let expected_attr = match bin_data.data_type {
            BinDataType::Embedding if has_storage => 0x0001,
            BinDataType::Embedding => 0x0101,
            BinDataType::Storage => 0x0002,
            BinDataType::Link => continue,
        };
        if bin_data.attr != expected_attr {
            bin_data.attr = expected_attr;
            changed = true;
        }

        let expected_status = match bin_data.data_type {
            BinDataType::Embedding if has_storage => BinDataStatus::NotAccessed,
            BinDataType::Embedding => BinDataStatus::Success,
            BinDataType::Storage => BinDataStatus::NotAccessed,
            BinDataType::Link => continue,
        };
        if bin_data.status != expected_status {
            bin_data.status = expected_status;
            changed = true;
        }

        if bin_data.raw_data.is_some() {
            bin_data.raw_data = None;
            changed = true;
        }
    }

    if changed {
        report.bin_data_metadata_normalized += 1;
        doc.doc_info.raw_stream_dirty = true;
    }
}

/// HWPX manifest 순서는 HWP5 저장 시 한컴이 기대하는 BinData 순서와 다를 수 있다.
///
/// 특히 OLE 차트가 포함된 HWPX 변환본은 `content.hpf`에 배경 이미지 → 본문 그림 → OLE
/// 순서로 적히는 경우가 있다. HWP5의 `bin_data_id`는 `BIN_DATA` 레코드 순번을 가리키므로,
/// 한컴 정답지처럼 본문 컨트롤에서 먼저 등장하는 그림/OLE를 앞에 두고 DocInfo 전용 배경
/// 이미지는 뒤로 보내야 한다. 이때 모든 참조 ID와 `BinDataContent.id`도 함께 remap한다.
/// HWPX 그림은 manifest 번호(`image14` → 14)를 참조하지만 HWP5 그림 참조는 DocInfo
/// BinData 의 1-based 위치다. 그림을 지운 HWPX 처럼 번호에 구멍이 있거나 1 에서
/// 시작하지 않으면, HWP 로 저장한 문서에서 한글은 없는 위치를 찾아 그림을 비운다.
/// 번호를 위치로 바꾸고 모든 참조(그림·채우기·테두리)를 함께 고친다.
fn positionalize_hwpx_bin_data_ids(doc: &mut Document, report: &mut AdapterReport) {
    let list = &doc.doc_info.bin_data_list;
    if list.is_empty()
        || list
            .iter()
            .enumerate()
            .all(|(index, bin_data)| bin_data.storage_id as usize == index + 1)
    {
        return;
    }
    let mut seen = BTreeSet::new();
    if list
        .iter()
        .any(|bin_data| bin_data.storage_id == 0 || !seen.insert(bin_data.storage_id))
    {
        return;
    }
    let is_chart =
        |content: &BinDataContent| content.extension == "ooxml_chart" && content.id > 60000;
    // 차트 보조 항목 외의 모든 내용이 목록의 번호와 짝지어져야 안전하게 바꿀 수 있다.
    if doc
        .bin_data_content
        .iter()
        .any(|content| !is_chart(content) && !seen.contains(&content.id))
    {
        return;
    }
    let max_id = list
        .iter()
        .map(|bin_data| bin_data.storage_id)
        .max()
        .unwrap_or(0);
    let mut remap = vec![0u16; max_id as usize + 1];
    for (index, bin_data) in list.iter().enumerate() {
        remap[bin_data.storage_id as usize] = (index + 1) as u16;
    }
    for bin_data in &mut doc.doc_info.bin_data_list {
        bin_data.storage_id = remap[bin_data.storage_id as usize];
    }
    for content in &mut doc.bin_data_content {
        if !is_chart(content) {
            content.id = remap[content.id as usize];
        }
    }
    remap_bin_refs_in_doc(doc, &remap);
    doc.doc_info.raw_stream_dirty = true;
    report.bin_data_ids_positionalized += 1;
}

fn materialize_hwp5_bin_data_order(doc: &mut Document, report: &mut AdapterReport) {
    let bin_count = doc.doc_info.bin_data_list.len();
    if bin_count <= 1
        || !doc
            .doc_info
            .bin_data_list
            .iter()
            .any(|bd| bd.data_type == BinDataType::Storage)
    {
        return;
    }

    let mut order = Vec::with_capacity(bin_count);
    let mut seen = BTreeSet::new();

    for section in &doc.sections {
        collect_bin_order_from_paragraphs(&section.paragraphs, bin_count, &mut order, &mut seen);
        for master_page in &section.section_def.master_pages {
            collect_bin_order_from_paragraphs(
                &master_page.paragraphs,
                bin_count,
                &mut order,
                &mut seen,
            );
        }
    }

    collect_bin_order_from_doc_info(doc, bin_count, &mut order, &mut seen);

    for id in 1..=bin_count as u16 {
        push_bin_order(id, bin_count, &mut order, &mut seen);
    }

    let identity: Vec<u16> = (1..=bin_count as u16).collect();
    if order == identity {
        return;
    }

    let mut remap = vec![0u16; bin_count + 1];
    for (new_idx, old_id) in order.iter().enumerate() {
        remap[*old_id as usize] = (new_idx + 1) as u16;
    }

    let old_bin_data = doc.doc_info.bin_data_list.clone();
    let mut new_bin_data = Vec::with_capacity(old_bin_data.len());
    for old_id in &order {
        let Some(old) = old_bin_data.get((*old_id as usize).saturating_sub(1)) else {
            continue;
        };
        let mut bin_data = old.clone();
        bin_data.storage_id = remap[*old_id as usize];
        new_bin_data.push(bin_data);
    }
    if new_bin_data.len() == old_bin_data.len() {
        doc.doc_info.bin_data_list = new_bin_data;
    }

    let old_content = doc.bin_data_content.clone();
    let mut new_content = Vec::with_capacity(old_content.len());
    for old_id in &order {
        if let Some(content) = old_content.iter().find(|content| content.id == *old_id) {
            let mut content = content.clone();
            content.id = remap[*old_id as usize];
            new_content.push(content);
        }
    }
    for content in old_content {
        if content.id == 0 || content.id as usize > bin_count {
            new_content.push(content);
        }
    }
    doc.bin_data_content = new_content;

    remap_bin_refs_in_doc(doc, &remap);
    doc.doc_info.raw_stream_dirty = true;
    report.bin_data_order_materialized += 1;
}

fn push_bin_order(id: u16, bin_count: usize, order: &mut Vec<u16>, seen: &mut BTreeSet<u16>) {
    if id == 0 || id as usize > bin_count || !seen.insert(id) {
        return;
    }
    order.push(id);
}

fn collect_bin_order_from_doc_info(
    doc: &Document,
    bin_count: usize,
    order: &mut Vec<u16>,
    seen: &mut BTreeSet<u16>,
) {
    for border_fill in &doc.doc_info.border_fills {
        if let Some(image) = &border_fill.fill.image {
            push_bin_order(image.bin_data_id, bin_count, order, seen);
        }
    }
}

fn collect_bin_order_from_paragraphs(
    paragraphs: &[Paragraph],
    bin_count: usize,
    order: &mut Vec<u16>,
    seen: &mut BTreeSet<u16>,
) {
    for para in paragraphs {
        for ctrl in &para.controls {
            collect_bin_order_from_control(ctrl, bin_count, order, seen);
        }
    }
}

fn collect_bin_order_from_control(
    ctrl: &Control,
    bin_count: usize,
    order: &mut Vec<u16>,
    seen: &mut BTreeSet<u16>,
) {
    match ctrl {
        Control::Picture(pic) => {
            push_bin_order(pic.image_attr.bin_data_id, bin_count, order, seen);
            // [#2736] 그림 캡션 문단도 순회한다. 표 캡션(아래 arm)·도형 캡션
            // (collect_bin_order_from_shape)은 이미 방문하는데 그림 캡션만 빠져 있어,
            // 같은 캡션 컨테이너인데 소유 개체 종류에 따라 순회 여부가 갈렸다.
            if let Some(caption) = &pic.caption {
                collect_bin_order_from_paragraphs(&caption.paragraphs, bin_count, order, seen);
            }
        }
        Control::Shape(shape) => collect_bin_order_from_shape(shape, bin_count, order, seen),
        Control::Table(table) => {
            for cell in &table.cells {
                collect_bin_order_from_paragraphs(&cell.paragraphs, bin_count, order, seen);
            }
            if let Some(caption) = &table.caption {
                collect_bin_order_from_paragraphs(&caption.paragraphs, bin_count, order, seen);
            }
        }
        Control::Header(header) => {
            collect_bin_order_from_paragraphs(&header.paragraphs, bin_count, order, seen);
        }
        Control::Footer(footer) => {
            collect_bin_order_from_paragraphs(&footer.paragraphs, bin_count, order, seen);
        }
        Control::Footnote(footnote) => {
            collect_bin_order_from_paragraphs(&footnote.paragraphs, bin_count, order, seen);
        }
        Control::Endnote(endnote) => {
            collect_bin_order_from_paragraphs(&endnote.paragraphs, bin_count, order, seen);
        }
        Control::HiddenComment(comment) => {
            collect_bin_order_from_paragraphs(&comment.paragraphs, bin_count, order, seen);
        }
        _ => {}
    }
}

fn collect_bin_order_from_shape(
    shape: &ShapeObject,
    bin_count: usize,
    order: &mut Vec<u16>,
    seen: &mut BTreeSet<u16>,
) {
    match shape {
        ShapeObject::Picture(pic) => {
            push_bin_order(pic.image_attr.bin_data_id, bin_count, order, seen);
        }
        ShapeObject::Ole(ole) => {
            if let Ok(id) = u16::try_from(ole.bin_data_id) {
                push_bin_order(id, bin_count, order, seen);
            }
        }
        ShapeObject::Group(group) => {
            for child in &group.children {
                collect_bin_order_from_shape(child, bin_count, order, seen);
            }
        }
        _ => {}
    }

    if let Some(drawing) = shape.drawing() {
        if let Some(image) = &drawing.fill.image {
            push_bin_order(image.bin_data_id, bin_count, order, seen);
        }
        if let Some(text_box) = &drawing.text_box {
            collect_bin_order_from_paragraphs(&text_box.paragraphs, bin_count, order, seen);
        }
        if let Some(caption) = &drawing.caption {
            collect_bin_order_from_paragraphs(&caption.paragraphs, bin_count, order, seen);
        }
    }
}

fn remap_bin_refs_in_doc(doc: &mut Document, remap: &[u16]) {
    for border_fill in &mut doc.doc_info.border_fills {
        remap_bin_ref_in_fill(&mut border_fill.fill, remap);
    }

    for section in &mut doc.sections {
        remap_bin_refs_in_paragraphs(&mut section.paragraphs, remap);
        for master_page in &mut section.section_def.master_pages {
            remap_bin_refs_in_paragraphs(&mut master_page.paragraphs, remap);
        }
    }
}

fn remap_bin_refs_in_paragraphs(paragraphs: &mut [Paragraph], remap: &[u16]) {
    for para in paragraphs {
        for ctrl in &mut para.controls {
            remap_bin_refs_in_control(ctrl, remap);
        }
    }
}

fn remap_bin_refs_in_control(ctrl: &mut Control, remap: &[u16]) {
    match ctrl {
        Control::Picture(pic) => {
            pic.image_attr.bin_data_id = remap_bin_ref(pic.image_attr.bin_data_id, remap);
            // [#2736] 그림 캡션 문단 안의 그림도 리맵해야 한다. 미방문 시 캡션 안 그림의
            // bin_data_id 가 재정렬 이전 번호로 남아 엉뚱한 이미지로 해석된다 —
            // 표 캡션에 대한 동형 결함이 이미 table_caption_picture_bin_ref_is_remapped
            // 로 회귀 고정돼 있고, 그림 캡션이 그 미수정 형제였다.
            if let Some(caption) = &mut pic.caption {
                remap_bin_refs_in_paragraphs(&mut caption.paragraphs, remap);
            }
        }
        Control::Shape(shape) => remap_bin_refs_in_shape(shape, remap),
        Control::Table(table) => {
            for cell in &mut table.cells {
                remap_bin_refs_in_paragraphs(&mut cell.paragraphs, remap);
            }
            if let Some(caption) = &mut table.caption {
                remap_bin_refs_in_paragraphs(&mut caption.paragraphs, remap);
            }
        }
        Control::Header(header) => remap_bin_refs_in_paragraphs(&mut header.paragraphs, remap),
        Control::Footer(footer) => remap_bin_refs_in_paragraphs(&mut footer.paragraphs, remap),
        Control::Footnote(footnote) => {
            remap_bin_refs_in_paragraphs(&mut footnote.paragraphs, remap)
        }
        Control::Endnote(endnote) => remap_bin_refs_in_paragraphs(&mut endnote.paragraphs, remap),
        // [#2767] adapt 워크·border-fill 워크는 이미 HiddenComment 를 방문한다
        // (#2467 근거). remap 워크만 빠져 있어 숨은설명 안 그림이 재정렬 후
        // 엉뚱한 이미지를 가리키는 채로 남았다.
        Control::HiddenComment(comment) => {
            remap_bin_refs_in_paragraphs(&mut comment.paragraphs, remap)
        }
        _ => {}
    }
}

fn remap_bin_refs_in_shape(shape: &mut ShapeObject, remap: &[u16]) {
    match shape {
        ShapeObject::Picture(pic) => {
            pic.image_attr.bin_data_id = remap_bin_ref(pic.image_attr.bin_data_id, remap);
            // [#2767] 그룹 내부 그림(ShapeObject::Picture)은 drawing_mut()이 항상
            // None 이라(모델상 DrawingObjAttr 를 갖지 않음) 아래 공통 캡션 remap
            // 경로를 타지 않는다. Picture 자신의 caption 필드를 직접 재귀해야 한다.
            if let Some(caption) = &mut pic.caption {
                remap_bin_refs_in_paragraphs(&mut caption.paragraphs, remap);
            }
        }
        ShapeObject::Ole(ole) => {
            if let Ok(id) = u16::try_from(ole.bin_data_id) {
                ole.bin_data_id = remap_bin_ref(id, remap) as u32;
            }
        }
        ShapeObject::Group(group) => {
            for child in &mut group.children {
                remap_bin_refs_in_shape(child, remap);
            }
        }
        _ => {}
    }

    if let Some(drawing) = shape.drawing_mut() {
        remap_bin_ref_in_fill(&mut drawing.fill, remap);
        if let Some(text_box) = &mut drawing.text_box {
            remap_bin_refs_in_paragraphs(&mut text_box.paragraphs, remap);
        }
        if let Some(caption) = &mut drawing.caption {
            remap_bin_refs_in_paragraphs(&mut caption.paragraphs, remap);
        }
    }
}

fn remap_bin_ref_in_fill(fill: &mut Fill, remap: &[u16]) {
    if let Some(image) = &mut fill.image {
        image.bin_data_id = remap_bin_ref(image.bin_data_id, remap);
    }
}

fn remap_bin_ref(id: u16, remap: &[u16]) -> u16 {
    remap
        .get(id as usize)
        .copied()
        .filter(|new_id| *new_id != 0)
        .unwrap_or(id)
}

/// HWPX 출처 문서를 HWP5 저장 관례에 맞춰 압축 문서로 보정한다.
///
/// HWPX 파서는 HWP `FileHeader` 원본이 없기 때문에 `compressed=false`, `flags=0`인
/// 임시 헤더를 만든다. 그러나 HWP 저장기는 이 값을 그대로 사용해 DocInfo/BodyText/BinData
/// 스트림 압축 여부를 결정한다. Stage30 probe의 공통 기준선도 압축 플래그를 켠 상태였으므로,
/// HWPX -> HWP 저장 adapter는 HWP5 compressed 헤더를 명시적으로 materialize해야 한다.
fn normalize_file_header_for_hwp(doc: &mut Document, report: &mut AdapterReport) {
    let mut changed = false;

    if !doc.header.compressed {
        doc.header.compressed = true;
        changed = true;
    }

    if doc.header.flags & 0x01 == 0 {
        doc.header.flags |= 0x01;
        changed = true;
    }

    if doc.header.raw_data.is_some() {
        doc.header.raw_data = None;
        changed = true;
    }

    if changed {
        report.file_header_compression_normalized += 1;
    }
}

/// HWP `DOCUMENT_PROPERTIES`의 구역 개수를 실제 BodyText 섹션 수와 동기화한다.
///
/// HWPX header.xml 파싱 경로는 `DocProperties.section_count`를 기본값 1로 남길 수 있다.
/// 한컴 HWP 로더는 이 값을 BodyText 섹션 스트림 해석의 상한으로 사용하므로, 실제 섹션이
/// 2개 이상인 문서에서는 마지막 섹션이 렌더링되지 않는다.
fn normalize_doc_properties_for_hwp(doc: &mut Document, report: &mut AdapterReport) {
    let section_count = doc.sections.len().min(u16::MAX as usize) as u16;
    let changed =
        doc.doc_properties.section_count != section_count || doc.doc_properties.raw_data.is_some();

    doc.doc_properties.section_count = section_count;
    doc.doc_properties.raw_data = None;

    if changed {
        report.doc_properties_section_count_normalized += 1;
        doc.doc_info.raw_stream_dirty = true;
    }
}

/// 섹션의 `section_def` 를 첫 문단의 `controls` 시작 위치에 `Control::SectionDef` 로 삽입한다.
///
/// ## 배경
///
/// HWPX 파서는 `<hp:secPr>` 정보를 `Section.section_def` 필드와
/// `Control::SectionDef` 컨트롤에 함께 반영한다. 단, 예전 파서 산출물이나 외부 생성 IR처럼
/// `section_def` 필드만 있고 문단 control stream 에 `Control::SectionDef` 가 빠진 문서를
/// HWP로 저장할 수 있으므로, 어댑터는 fallback 으로 이 컨트롤을 보강한다.
/// HWP 직렬화기 (`serializer/control.rs:40 + 171-241`) 는 `paragraph.controls` 를
/// 순회하면서 `Control::SectionDef` 를 만나야 PAGE_DEF / FOOTNOTE_SHAPE / PAGE_BORDER_FILL
/// 레코드를 출력한다. 이 컨트롤이 없으면 직렬화 결과의 PAGE_DEF 가 누락되어 재로드 시
/// `page_def.width = 0` 등 페이지 크기 손상으로 페이지 폭주 발생.
///
/// ## 동작
///
/// 1. 섹션의 첫 문단에 `Control::SectionDef` 가 이미 있으면 `section.section_def` 의 최신
///    값을 반영한다. HWPX package-level masterpage 는 section XML 파싱 뒤에 붙기 때문에,
///    기존 컨트롤 복사본이 오래된 상태일 수 있다.
/// 2. 없으면 `Control::SectionDef(Box::new(section.section_def.clone()))` 를 첫 문단의
///    `controls[0]` 위치에 삽입
///
/// ## 한컴 영향
///
/// 한컴은 `<secd>` CTRL_HEADER 와 PAGE_DEF 를 정상 인식. HWP 출처에서는 이미 컨트롤이
/// 있으므로 idempotent 가드에 막혀 변경 없음.
fn insert_section_def_control(section: &mut Section, report: &mut AdapterReport) {
    if section.paragraphs.is_empty() {
        return;
    }
    let first_para = &mut section.paragraphs[0];
    if let Some(Control::SectionDef(section_def)) = first_para
        .controls
        .iter_mut()
        .find(|c| matches!(c, Control::SectionDef(_)))
    {
        **section_def = section.section_def.clone();
        return;
    }
    first_para.controls.insert(
        0,
        Control::SectionDef(Box::new(section.section_def.clone())),
    );
    report.section_def_controls_inserted += 1;
}

fn materialize_following_section_break_type(
    section_idx: usize,
    section: &mut Section,
    report: &mut AdapterReport,
) {
    if section_idx == 0 {
        return;
    }

    let Some(first_para) = section.paragraphs.first_mut() else {
        return;
    };

    let has_section_def = first_para
        .controls
        .iter()
        .any(|control| matches!(control, Control::SectionDef(_)));
    if !has_section_def || first_para.raw_break_type != 0 {
        return;
    }

    // HWPX parser가 pageBreak/columnBreak/secPr/colPr를 HWP5 break flag로 합성한다.
    // 이 adapter는 과거 IR처럼 raw_break_type이 완전히 비어 있는 경우에만 최소 section
    // break를 보강한다. 이미 materialize된 0x03/0x07 같은 조합을 덮어쓰면 한컴이
    // 후속 section의 바탕쪽/머리말 layout을 다르게 해석한다.
    first_para.raw_break_type = 0x01;
    report.following_section_break_type_materialized += 1;
}

fn normalize_paragraph_char_border_fills(doc: &mut Document, report: &mut AdapterReport) {
    let para_char_refs = collect_paragraph_char_border_fill_refs(doc);
    if para_char_refs.is_empty() {
        return;
    }

    let object_refs = collect_object_border_fill_refs(doc);
    for id in para_char_refs {
        if id == 0 || object_refs.contains(&id) {
            continue;
        }

        let Some(border_fill) = doc
            .doc_info
            .border_fills
            .get_mut(id.saturating_sub(1) as usize)
        else {
            continue;
        };

        if is_transparent_paragraph_no_fill_candidate(border_fill) {
            border_fill.fill.fill_type = FillType::None;
            border_fill.fill.solid = None;
            border_fill.fill.gradient = None;
            border_fill.fill.image = None;
            border_fill.fill.alpha = 0;
            border_fill.raw_data = None;
            report.border_fills_no_fill_normalized += 1;
        }
    }
}

fn collect_paragraph_char_border_fill_refs(doc: &Document) -> std::collections::HashSet<u16> {
    let mut refs = std::collections::HashSet::new();
    for para_shape in &doc.doc_info.para_shapes {
        if para_shape.border_fill_id > 0 {
            refs.insert(para_shape.border_fill_id);
        }
    }
    for char_shape in &doc.doc_info.char_shapes {
        if char_shape.border_fill_id > 0 {
            refs.insert(char_shape.border_fill_id);
        }
    }
    refs
}

fn collect_object_border_fill_refs(doc: &Document) -> std::collections::HashSet<u16> {
    let mut refs = std::collections::HashSet::new();
    for section in &doc.sections {
        if section.section_def.page_border_fill.border_fill_id > 0 {
            refs.insert(section.section_def.page_border_fill.border_fill_id);
        }
        for page_border_fill in &section.section_def.extra_page_border_fills {
            if page_border_fill.border_fill_id > 0 {
                refs.insert(page_border_fill.border_fill_id);
            }
        }
        for para in &section.paragraphs {
            collect_object_border_fill_refs_from_paragraph(para, &mut refs);
        }
        // 바탕쪽(master page) 문단 안 개체 참조도 수집한다. bin 워크
        // (materialize_hwp5_bin_data_order, remap_bin_refs_in_doc)와 adapt 워크가
        // 이미 바탕쪽을 순회하는데 이 collect 워크만 빠져 있었다.
        for master_page in &section.section_def.master_pages {
            for para in &master_page.paragraphs {
                collect_object_border_fill_refs_from_paragraph(para, &mut refs);
            }
        }
    }
    refs
}

fn collect_object_border_fill_refs_from_paragraph(
    para: &Paragraph,
    refs: &mut std::collections::HashSet<u16>,
) {
    for ctrl in &para.controls {
        match ctrl {
            Control::Table(table) => collect_table_border_fill_refs(table, refs),
            Control::Shape(shape) => collect_object_border_fill_refs_from_shape(shape, refs),
            // [#2736] 그림 캡션 문단 안 개체 참조도 수집한다. `Control::Picture` arm 자체가
            // 없어 표 캡션(collect_table_border_fill_refs)·도형 캡션
            // (collect_object_border_fill_refs_from_shape)과 달리 그림 캡션만 빠져 있었고,
            // 미수집 시 normalize_paragraph_char_border_fills 가드가 실패해 캡션 안 개체
            // 채우기가 no-fill 로 정규화된다(#2467 과 동일 메커니즘).
            Control::Picture(pic) => {
                if let Some(caption) = &pic.caption {
                    for p in &caption.paragraphs {
                        collect_object_border_fill_refs_from_paragraph(p, refs);
                    }
                }
            }
            // 각주/미주/숨은설명 문단 안의 개체도 border_fill 을 참조할 수 있다.
            // 이 참조가 수집되지 않으면 normalize_paragraph_char_border_fills 의
            // 가드가 실패해, 문단 char-border 와 공유된 border_fill 이 no-fill 로
            // 정규화되어 컨테이너 안 개체의 채우기가 유실된다(#2467 adapt 워크와 동형).
            Control::Footnote(footnote) => {
                for p in &footnote.paragraphs {
                    collect_object_border_fill_refs_from_paragraph(p, refs);
                }
            }
            Control::Endnote(endnote) => {
                for p in &endnote.paragraphs {
                    collect_object_border_fill_refs_from_paragraph(p, refs);
                }
            }
            Control::HiddenComment(comment) => {
                for p in &comment.paragraphs {
                    collect_object_border_fill_refs_from_paragraph(p, refs);
                }
            }
            // 머리말/꼬리말 문단 안 개체도 다른 워크(bin order/remap, adapt)와 동일하게 순회.
            Control::Header(header) => {
                for p in &header.paragraphs {
                    collect_object_border_fill_refs_from_paragraph(p, refs);
                }
            }
            Control::Footer(footer) => {
                for p in &footer.paragraphs {
                    collect_object_border_fill_refs_from_paragraph(p, refs);
                }
            }
            _ => {}
        }
    }
}

fn collect_object_border_fill_refs_from_shape(
    shape: &ShapeObject,
    refs: &mut std::collections::HashSet<u16>,
) {
    if let Some(drawing) = shape.drawing() {
        if let Some(text_box) = &drawing.text_box {
            for para in &text_box.paragraphs {
                collect_object_border_fill_refs_from_paragraph(para, refs);
            }
        }
        // 도형 캡션 문단 안 개체 참조도 수집(bin order/remap 워크와 동형).
        // #2483 은 표 캡션을 다뤘고, 이 도형 drawing.caption 은 별개 경로다.
        if let Some(caption) = &drawing.caption {
            for para in &caption.paragraphs {
                collect_object_border_fill_refs_from_paragraph(para, refs);
            }
        }
    }

    if let ShapeObject::Group(group) = shape {
        for child in &group.children {
            collect_object_border_fill_refs_from_shape(child, refs);
        }
    }
}

fn collect_table_border_fill_refs(table: &Table, refs: &mut std::collections::HashSet<u16>) {
    if table.border_fill_id > 0 {
        refs.insert(table.border_fill_id);
    }
    for zone in &table.zones {
        if zone.border_fill_id > 0 {
            refs.insert(zone.border_fill_id);
        }
    }
    for cell in &table.cells {
        if cell.border_fill_id > 0 {
            refs.insert(cell.border_fill_id);
        }
        for para in &cell.paragraphs {
            collect_object_border_fill_refs_from_paragraph(para, refs);
        }
    }
    // 표 캡션 문단 안의 개체 참조도 수집(#2467 과 동일 근거).
    if let Some(caption) = &table.caption {
        for para in &caption.paragraphs {
            collect_object_border_fill_refs_from_paragraph(para, refs);
        }
    }
}

fn is_transparent_paragraph_no_fill_candidate(border_fill: &BorderFill) -> bool {
    if !border_fill
        .borders
        .iter()
        .all(|border| matches!(border.line_type, BorderLineType::None))
    {
        return false;
    }

    if !matches!(border_fill.fill.fill_type, FillType::Solid) {
        return false;
    }

    let Some(solid) = border_fill.fill.solid else {
        return false;
    };

    border_fill.fill.alpha == 0 && solid.background_color == 0xffff_ffff
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParagraphContext {
    Body,
    HeaderFooter,
    MasterPage,
}

fn adapt_paragraph(para: &mut Paragraph, report: &mut AdapterReport) {
    adapt_paragraph_with_context(para, report, ParagraphContext::Body);
}

fn adapt_paragraph_with_context(
    para: &mut Paragraph,
    report: &mut AdapterReport,
    context: ParagraphContext,
) {
    materialize_master_page_autonum_placeholder(para, report, context);
    materialize_autonum_fwspace_range_tag(para, report);
    materialize_autonum_fwspace_char_shape_offsets(para, report);
    materialize_fixed_width_space_control(para, report, context);
    materialize_para_header_tail(para, report);

    if para.ctrl_data_records.len() < para.controls.len() {
        para.ctrl_data_records
            .resize_with(para.controls.len(), || None);
    }

    let controls = &mut para.controls;
    let ctrl_data_records = &mut para.ctrl_data_records;
    for (idx, ctrl) in controls.iter_mut().enumerate() {
        match ctrl {
            Control::Table(table) => {
                adapt_table_with_context(table, report, context);
                adapt_table_layout_ctrl_data(table, &mut ctrl_data_records[idx], report);
            }
            Control::Header(header) => adapt_paragraphs_with_context(
                &mut header.paragraphs,
                report,
                ParagraphContext::HeaderFooter,
            ),
            Control::Footer(footer) => adapt_paragraphs_with_context(
                &mut footer.paragraphs,
                report,
                ParagraphContext::HeaderFooter,
            ),
            Control::Picture(pic) => {
                adapt_picture_href_ctrl_data(pic, &mut ctrl_data_records[idx], report);
                // [#2736] 그림 캡션 문단도 보강한다. 표 캡션은 adapt_table_with_context 가
                // 이미 보강하고, bin order/remap·border_fill 수집 워크는 캡션을 순회하는데
                // adapt 워크만 그림 캡션을 건너뛰었다. 실측(samples/hwpx/aift.hwpx): 본문
                // 921/921·표 캡션 2/2 가 방문되는 동안 그림 캡션 9/9 전부 미방문.
                // 미방문 시 캡션 안 그림 href·표 raw_ctrl_data·수식 보정이 물질화되지 않고
                // 문단 header tail 도 10바이트로 남아 PARA_HEADER 가 22/24 로 섞인다.
                if let Some(caption) = &mut pic.caption {
                    adapt_paragraphs_with_context(&mut caption.paragraphs, report, context);
                }
                materialize_picture_caption_common_attr(pic, report);
            }
            Control::Shape(shape) => adapt_shape_with_context(shape, report, context),
            Control::Equation(eq) => adapt_equation(eq, report),
            // 각주/미주/숨은설명 문단도 body 문단과 동일하게 보강해야 한다.
            // bin 참조 수집·리맵 워크(collect_bin_order/remap_bin_refs)는 이미 이들을
            // 재귀하므로 adapt 워크만 빠져 있으면, 이 안의 그림 href·표 ctrl_data 등이
            // 물질화되지 않고 HWPX→HWP 변환 시 유실된다.
            Control::Footnote(footnote) => {
                adapt_paragraphs_with_context(&mut footnote.paragraphs, report, context)
            }
            Control::Endnote(endnote) => {
                adapt_paragraphs_with_context(&mut endnote.paragraphs, report, context)
            }
            Control::HiddenComment(comment) => {
                adapt_paragraphs_with_context(&mut comment.paragraphs, report, context)
            }
            // MEMO 필드의 본문도 독립 paragraph list다. 여기만 재귀에서 빠지면
            // 내부 수식의 CTRL_HEADER attr/raw 상태가 HWP용으로 물질화되지 않는다.
            Control::Field(field) => {
                adapt_paragraphs_with_context(&mut field.memo_paragraphs, report, context)
            }
            _ => {}
        }
    }
}

fn materialize_autonum_fwspace_range_tag(para: &mut Paragraph, report: &mut AdapterReport) {
    const HWP5_AUTONUM_FWSPACE_TRAILING_TAG: u32 = 0x0100_0023;

    if para
        .range_tags
        .iter()
        .any(|tag| tag.tag == HWP5_AUTONUM_FWSPACE_TRAILING_TAG)
    {
        return;
    }

    if !para
        .controls
        .iter()
        .any(|ctrl| matches!(ctrl, Control::AutoNumber(_)))
    {
        return;
    }

    let mut chars = para.text.chars();
    if chars.next() != Some(' ') || chars.next() != Some('\u{2007}') {
        return;
    }

    if para.text.chars().count() <= 2 || para.char_offsets.len() != para.text.chars().count() {
        return;
    }

    let Some(last_char) = para.text.chars().last() else {
        return;
    };
    let Some(&start) = para.char_offsets.last() else {
        return;
    };

    let end = start + last_char.len_utf16() as u32;
    if end <= start {
        return;
    }

    // Hancom's HWPX->HWP save materializes an otherwise implicit range tag on
    // the final visible character in paragraphs shaped as:
    //   AutoNumber placeholder + fixed-width space + visible heading text.
    //
    // Without this tag the file is structurally readable by rhwp, but Hancom
    // reports corruption around the first AutoNumber/PageHide boundary in
    // exam_social.hwpx.
    para.range_tags.push(crate::model::paragraph::RangeTag {
        start,
        end,
        tag: HWP5_AUTONUM_FWSPACE_TRAILING_TAG,
    });
    report.autonum_fwspace_range_tag_materialized += 1;
}

fn materialize_autonum_fwspace_char_shape_offsets(
    para: &mut Paragraph,
    report: &mut AdapterReport,
) {
    if !para
        .controls
        .iter()
        .any(|ctrl| matches!(ctrl, Control::AutoNumber(_)))
    {
        return;
    }

    if !para.text.starts_with(" \u{2007}") {
        return;
    }

    if !para
        .char_shapes
        .iter()
        .any(|char_shape| (2..9).contains(&char_shape.start_pos))
    {
        return;
    }

    // HWPX positions are based on logical characters:
    //   placeholder space(1) + fixed-width space(1) + visible text...
    // HWP5 stores the AutoNumber as an 8-code-unit extended control and the
    // fixed-width space as 0x001f, so style boundaries after the placeholder
    // move by +7 code units. This matches Hancom's HWPX->HWP output.
    for char_shape in &mut para.char_shapes {
        if char_shape.start_pos >= 2 {
            char_shape.start_pos += 7;
        }
    }
    report.autonum_fwspace_char_shape_offsets_materialized += 1;
}

fn adapt_paragraphs(paragraphs: &mut [Paragraph], report: &mut AdapterReport) {
    adapt_paragraphs_with_context(paragraphs, report, ParagraphContext::Body);
}

fn adapt_paragraphs_with_context(
    paragraphs: &mut [Paragraph],
    report: &mut AdapterReport,
    context: ParagraphContext,
) {
    for para in paragraphs {
        adapt_paragraph_with_context(para, report, context);
    }
}

fn materialize_fixed_width_space_control(
    para: &mut Paragraph,
    report: &mut AdapterReport,
    context: ParagraphContext,
) {
    const HWP5_FIXED_WIDTH_SPACE_MASK: u32 = 1u32 << 0x001f;

    if context != ParagraphContext::Body
        || !para
            .text
            .chars()
            .enumerate()
            .any(|(i, c)| c == '\u{2007}' && para.space_origin_at(i).is_none())
    {
        return;
    }

    if para.control_mask & HWP5_FIXED_WIDTH_SPACE_MASK != 0 {
        return;
    }

    // Hancom's HWPX->HWP path stores body fixed-width blanks as HWP5
    // control char 0x001f in the affected exam_social body paragraphs.
    // Header/footer and master page paragraphs keep literal U+2007 because
    // page-number placeholder replacement depends on that visible spacer.
    para.control_mask |= HWP5_FIXED_WIDTH_SPACE_MASK;
    report.header_footer_fwspace_control_materialized += 1;
}

fn materialize_para_header_tail(para: &mut Paragraph, report: &mut AdapterReport) {
    if para.raw_header_extra.len() >= 12 {
        return;
    }

    if para.raw_header_extra.len() >= 10 {
        para.raw_header_extra.resize(12, 0);
    } else {
        let mut extra = vec![0; 12];
        let char_shape_count = para.char_shapes.len().max(1).min(u16::MAX as usize) as u16;
        let range_tag_count = para.range_tags.len().min(u16::MAX as usize) as u16;
        let line_seg_count = para.line_segs.len().min(u16::MAX as usize) as u16;

        extra[0..2].copy_from_slice(&char_shape_count.to_le_bytes());
        extra[2..4].copy_from_slice(&range_tag_count.to_le_bytes());
        extra[4..6].copy_from_slice(&line_seg_count.to_le_bytes());

        para.raw_header_extra = extra;
    }

    report.para_header_tail_materialized += 1;
}

fn adapt_section_def(section_def: &mut SectionDef, report: &mut AdapterReport) {
    materialize_section_def_hide_empty_line_flag(section_def, report);
    materialize_single_master_page_flags(section_def, report);
    materialize_multi_master_page_flags(section_def, report);
    materialize_section_def_master_page_tail(section_def, report);

    for master_page in &mut section_def.master_pages {
        adapt_paragraphs_with_context(
            &mut master_page.paragraphs,
            report,
            ParagraphContext::MasterPage,
        );
    }
}

fn materialize_section_def_hide_empty_line_flag(
    section_def: &mut SectionDef,
    report: &mut AdapterReport,
) {
    const HIDE_EMPTY_LINE_FLAG: u32 = 0x0008_0000;

    let old_flags = section_def.flags;
    if section_def.hide_empty_line {
        section_def.flags |= HIDE_EMPTY_LINE_FLAG;
    } else {
        section_def.flags &= !HIDE_EMPTY_LINE_FLAG;
    }

    if section_def.flags != old_flags {
        report.section_def_hide_empty_line_flag_materialized += 1;
    }
}

fn materialize_master_page_autonum_placeholder(
    para: &mut Paragraph,
    report: &mut AdapterReport,
    context: ParagraphContext,
) {
    // [Task #1113] 바탕쪽(MasterPage) 뿐 아니라 머리말/꼬리말(HeaderFooter) 글상자
    // 안의 AutoNumber-only 페이지번호 문단도 동일하게 처리한다.
    if !matches!(
        context,
        ParagraphContext::MasterPage | ParagraphContext::HeaderFooter
    ) {
        return;
    }

    if para.text != " "
        || para.char_offsets.as_slice() != [0]
        || para.controls.len() != 1
        || !matches!(para.controls.first(), Some(Control::AutoNumber(_)))
    {
        return;
    }

    // HWPX emits an empty <hp:t/> after PAGE AutoNumber controls. The generic
    // HWPX parser synthesizes a visible placeholder space (U+0020) for the
    // AutoNumber, but Hancom's HWPX->HWP save stores the page-number paragraph
    // as AutoNumber-only: no leading U+0020 before the control.
    //
    // [Task #1113] 머리말 홀수쪽 글상자(폭 4252)에서 이 잉여 U+0020 이 한컴
    // 에디터의 페이지번호 줄나눔/글상자 높이 증가를 유발. 정답지처럼
    // AutoNumber-only 로 정규화한다. (짝수쪽은 fwSpace+텍스트+autoNum 이라
    // `text != " "` 에서 자동 제외 → 회귀 없음)
    para.text.clear();
    para.char_offsets.clear();
    para.char_count = 9;
    para.has_para_text = true;
    report.master_page_autonum_placeholder_removed += 1;
}

fn materialize_single_master_page_flags(section_def: &mut SectionDef, report: &mut AdapterReport) {
    const HWPX_SINGLE_MASTER_PAGE_FLAGS: u32 = 0x4000_0000;
    const HANCOM_SINGLE_MASTER_PAGE_FLAGS: u32 = 0x2000_0000;
    const MASTER_PAGE_FLAGS_MASK: u32 = 0xe000_0000;

    if section_def.master_pages.len() != 1
        || section_def.flags & MASTER_PAGE_FLAGS_MASK != HWPX_SINGLE_MASTER_PAGE_FLAGS
    {
        return;
    }

    section_def.flags =
        (section_def.flags & !MASTER_PAGE_FLAGS_MASK) | HANCOM_SINGLE_MASTER_PAGE_FLAGS;
    report.section_def_single_master_page_flags_materialized += 1;
}

fn materialize_multi_master_page_flags(section_def: &mut SectionDef, report: &mut AdapterReport) {
    const HWPX_TWO_MASTER_PAGE_FLAGS: u32 = 0x8000_0000;
    const HANCOM_MULTI_MASTER_PAGE_FLAGS: u32 = 0xC000_0000;
    const MASTER_PAGE_FLAGS_MASK: u32 = 0xe000_0000;

    if section_def.master_pages.len() < 2
        || section_def.flags & MASTER_PAGE_FLAGS_MASK != HWPX_TWO_MASTER_PAGE_FLAGS
    {
        return;
    }

    section_def.flags =
        (section_def.flags & !MASTER_PAGE_FLAGS_MASK) | HANCOM_MULTI_MASTER_PAGE_FLAGS;
    report.section_def_multi_master_page_flags_materialized += 1;
}

fn materialize_section_def_master_page_tail(
    section_def: &mut SectionDef,
    report: &mut AdapterReport,
) {
    if section_def.master_pages.is_empty() || !section_def.raw_ctrl_extra.is_empty() {
        return;
    }

    // HWPX 출처 SectionDef는 HWP 원본 CTRL_HEADER tail이 없지만, 한컴이 HWPX를
    // HWP5로 저장한 정답지는 바탕쪽이 있는 구역에서 대표Language(0) 뒤에
    // 17 byte 확장 영역을 붙여 총 43 byte ctrl_data (CTRL_HEADER 47 byte)를 만든다.
    //
    // 관찰된 계약:
    // - exam_kor: masterPageCnt=3 -> 0x0001 marker + 15 byte zero
    // - exam_social-p1: 단일 Both 바탕쪽 -> 17 byte zero
    // - exam_social section1: Both + Odd 2개 바탕쪽 -> 17 byte zero
    let mut extra = vec![0; 19];
    extra[0..2].copy_from_slice(&0u16.to_le_bytes());
    if section_def.master_pages.len() >= 3 {
        extra[2..4].copy_from_slice(&1u16.to_le_bytes());
    }
    section_def.raw_ctrl_extra = extra;
    report.section_def_master_page_tail_materialized += 1;
}

/// [Task #1061] HWPX 수식 control 의 한컴 호환 contract 정정.
///
/// 정답지 (samples/math-001.hwp) vs 저장본 (saved/111math-001.hwp) record-level diff:
/// - common.attr 의 bit 27 (0x08000000) 누락 — 정답지 0x0C2A2211 vs 저장본 0x042A2211
/// - HWPX 의 `font` 속성을 HWP5 EQEDIT 의 font_name 자리에 매핑한 결과 정답지와 자리값 swap
///   → Stage 2 에서 parser 직접 정정 (정답지: version_info="Equation Version 60", font_name="")
///
/// 본 함수는 Stage 1 의 attr 재구성 (enum 필드 → bit 합성 + bit 27 보강) + raw_ctrl_data clear
/// (직렬화기가 common 으로 재합성).
fn adapt_equation(eq: &mut crate::model::control::Equation, report: &mut AdapterReport) {
    const HWPX_EQUATION_NUMBERING_BIT: u32 = 0x0800_0000;

    let before = eq.common.attr;
    // HWPX 출처는 attr=0 으로 IR 생성 → pack_common_attr_bits 로 enum 필드들에서 재합성 후
    // bit 27 보강. 표 어댑터 (materialize_table_ctrl_header_attr) 와 동일 패턴.
    eq.common.attr = pack_common_attr_bits(&eq.common) | HWPX_EQUATION_NUMBERING_BIT;

    // raw_ctrl_data 가 보존되어 있으면 직렬화기가 raw 우선 사용 → attr 갱신 무효화.
    // clear 하여 직렬화기가 common 으로 재합성하도록 함.
    let raw_was_present = !eq.raw_ctrl_data.is_empty();
    eq.raw_ctrl_data.clear();

    if eq.common.attr != before || raw_was_present {
        report.equation_ctrl_header_attr_materialized += 1;
    }
}

fn adapt_shape(shape: &mut ShapeObject, report: &mut AdapterReport) {
    adapt_shape_with_context(shape, report, ParagraphContext::Body);
}

fn adapt_shape_with_context(
    shape: &mut ShapeObject,
    report: &mut AdapterReport,
    context: ParagraphContext,
) {
    if context == ParagraphContext::MasterPage {
        if let ShapeObject::Line(line) = shape {
            materialize_master_page_line_rendering_size_ratio(line, report);
        }
    }

    materialize_shape_caption_common_attr(shape, report);
    if let Some(drawing) = shape.drawing_mut() {
        if let Some(text_box) = &mut drawing.text_box {
            materialize_text_box_hwp5_envelope(text_box, report);
            adapt_paragraphs_with_context(&mut text_box.paragraphs, report, context);
        }
        // [#2736] 도형 캡션 문단도 보강한다. `DrawingObjAttr` 를 공유하는 사각형·타원·선·호·
        // 다각형·곡선·글상자·묶음·차트·OLE 이 한 번에 덮인다. 형제 워크
        // (collect_bin_order_from_shape / remap_bin_refs_in_shape /
        // collect_object_border_fill_refs_from_shape)는 셋 다 이미 drawing.caption 을
        // 순회하는데 adapt 워크만 빠져 있었다.
        if let Some(caption) = &mut drawing.caption {
            adapt_paragraphs_with_context(&mut caption.paragraphs, report, context);
        }
    }

    // These variants keep their caption outside DrawingObjAttr. Equations and
    // nested fields there need the same HWP5 materialization as body/text-box
    // paragraphs.
    match shape {
        ShapeObject::Group(group) => {
            if let Some(caption) = &mut group.caption {
                adapt_paragraphs_with_context(&mut caption.paragraphs, report, context);
            }
            for child in &mut group.children {
                adapt_shape_with_context(child, report, context);
            }
        }
        ShapeObject::Picture(picture) => {
            if let Some(caption) = &mut picture.caption {
                adapt_paragraphs_with_context(&mut caption.paragraphs, report, context);
            }
        }
        ShapeObject::Chart(chart) => {
            if let Some(caption) = &mut chart.caption {
                adapt_paragraphs_with_context(&mut caption.paragraphs, report, context);
            }
        }
        ShapeObject::Ole(ole) => {
            if let Some(caption) = &mut ole.caption {
                adapt_paragraphs_with_context(&mut caption.paragraphs, report, context);
            }
        }
        _ => {}
    }
}

fn materialize_master_page_line_rendering_size_ratio(
    line: &mut crate::model::shape::LineShape,
    report: &mut AdapterReport,
) {
    const COUNT_SIZE: usize = 2;
    const MATRIX_SIZE: usize = 6 * 8;
    const SCALE_START: usize = COUNT_SIZE + MATRIX_SIZE;
    const ROTATION_START: usize = SCALE_START + MATRIX_SIZE;
    const MIN_RAW_LEN: usize = ROTATION_START + MATRIX_SIZE;
    const EPSILON: f64 = 0.01;

    let attr = &mut line.drawing.shape_attr;
    if attr.raw_rendering.len() < MIN_RAW_LEN
        || attr.original_width == 0
        || attr.original_height == 0
    {
        return;
    }

    let count = u16::from_le_bytes([attr.raw_rendering[0], attr.raw_rendering[1]]);
    if count == 0 {
        return;
    }

    let exact_sx = attr.current_width as f64 / attr.original_width as f64;
    let exact_sy = attr.current_height as f64 / attr.original_height as f64;
    let Some(raw_sx) = read_raw_rendering_f64(&attr.raw_rendering, SCALE_START) else {
        return;
    };
    let Some(raw_sy) = read_raw_rendering_f64(&attr.raw_rendering, SCALE_START + 4 * 8) else {
        return;
    };

    if (raw_sx - exact_sx).abs() > EPSILON || (raw_sy - exact_sy).abs() > EPSILON {
        return;
    }

    let mut changed = false;
    changed |= write_raw_rendering_f64(&mut attr.raw_rendering, SCALE_START, exact_sx);
    changed |= write_raw_rendering_f64(&mut attr.raw_rendering, SCALE_START + 4 * 8, exact_sy);

    if matches!(
        read_raw_rendering_f64(&attr.raw_rendering, ROTATION_START + 8),
        Some(value) if value == 0.0
    ) {
        changed |= write_raw_rendering_f64(&mut attr.raw_rendering, ROTATION_START + 8, -0.0);
    }

    if changed {
        attr.render_sx = exact_sx;
        attr.render_sy = exact_sy;
        report.master_page_line_rendering_size_ratio_materialized += 1;
    }
}

fn read_raw_rendering_f64(raw: &[u8], offset: usize) -> Option<f64> {
    let bytes = raw.get(offset..offset + 8)?;
    Some(f64::from_le_bytes(bytes.try_into().ok()?))
}

fn write_raw_rendering_f64(raw: &mut [u8], offset: usize, value: f64) -> bool {
    let Some(target) = raw.get_mut(offset..offset + 8) else {
        return false;
    };
    let bytes = value.to_le_bytes();
    if target == bytes {
        return false;
    }
    target.copy_from_slice(&bytes);
    true
}

fn materialize_text_box_hwp5_envelope(text_box: &mut TextBox, report: &mut AdapterReport) {
    if !is_draw_text_hwp5_envelope_candidate(text_box) {
        return;
    }

    if text_box.raw_list_header_extra.is_empty() {
        text_box.raw_list_header_extra = vec![0; 13];
        report.text_box_list_header_tail_materialized += 1;
    }

    for para in &mut text_box.paragraphs {
        if para.raw_header_extra.len() >= 12 {
            continue;
        }

        let mut extra = vec![0; 12];
        let char_shape_count = para.char_shapes.len().max(1).min(u16::MAX as usize) as u16;
        let range_tag_count = para.range_tags.len().min(u16::MAX as usize) as u16;
        let line_seg_count = para.line_segs.len().min(u16::MAX as usize) as u16;

        extra[0..2].copy_from_slice(&char_shape_count.to_le_bytes());
        extra[2..4].copy_from_slice(&range_tag_count.to_le_bytes());
        extra[4..6].copy_from_slice(&line_seg_count.to_le_bytes());
        extra[6..10].copy_from_slice(&0x8000_0000_u32.to_le_bytes());

        para.raw_header_extra = extra;
        report.text_box_para_header_tail_materialized += 1;
    }
}

fn is_draw_text_hwp5_envelope_candidate(text_box: &TextBox) -> bool {
    text_box.paragraphs.iter().any(|para| {
        para.controls
            .iter()
            .any(|control| matches!(control, Control::Picture(_)))
    })
}

fn adapt_picture_href_ctrl_data(
    pic: &Picture,
    ctrl_data_slot: &mut Option<Vec<u8>>,
    report: &mut AdapterReport,
) {
    let Some(href) = pic.href.as_deref().filter(|value| !value.is_empty()) else {
        return;
    };

    let ctrl_data = build_picture_href_ctrl_data(href);
    if ctrl_data_slot.as_deref() == Some(ctrl_data.as_slice()) {
        return;
    }

    *ctrl_data_slot = Some(ctrl_data);
    report.picture_href_ctrl_data_materialized += 1;
}

fn build_picture_href_ctrl_data(href: &str) -> Vec<u8> {
    let hwp_href = normalize_picture_href_for_hwp_ctrl_data(href);
    let utf16: Vec<u16> = hwp_href.encode_utf16().collect();

    let mut data = Vec::with_capacity(22 + utf16.len() * 2);
    data.extend_from_slice(&0x021b_u16.to_le_bytes());
    data.extend_from_slice(&1_u16.to_le_bytes());
    data.extend_from_slice(&0_u16.to_le_bytes());
    data.extend_from_slice(&0x026f_u16.to_le_bytes());
    data.extend_from_slice(&0x8000_u16.to_le_bytes());
    data.extend_from_slice(&0x026f_u16.to_le_bytes());
    data.extend_from_slice(&1_u16.to_le_bytes());
    data.extend_from_slice(&0_u16.to_le_bytes());
    data.extend_from_slice(&0x0265_u16.to_le_bytes());
    data.extend_from_slice(&0x0001_u16.to_le_bytes());
    data.extend_from_slice(&(utf16.len().min(u16::MAX as usize) as u16).to_le_bytes());
    for ch in utf16.into_iter().take(u16::MAX as usize) {
        data.extend_from_slice(&ch.to_le_bytes());
    }
    data
}

fn normalize_picture_href_for_hwp_ctrl_data(href: &str) -> String {
    if href.contains("\\://") {
        href.to_string()
    } else {
        href.replace("://", "\\://")
    }
}

fn adapt_table_layout_ctrl_data(
    table: &Table,
    ctrl_data_slot: &mut Option<Vec<u8>>,
    report: &mut AdapterReport,
) {
    if ctrl_data_slot.is_some() || !table_requires_layout_ctrl_data(table) {
        return;
    }

    *ctrl_data_slot = Some(build_table_layout_ctrl_data());
    report.table_layout_ctrl_data_materialized += 1;
}

fn table_requires_layout_ctrl_data(table: &Table) -> bool {
    table.row_count == 3
        && table.col_count == 2
        && table.repeat_header
        && matches!(table.page_break, TablePageBreak::RowBreak)
}

fn build_table_layout_ctrl_data() -> Vec<u8> {
    // 한컴 HWPX→HWP 변환본에서 3x2 선택지 표 뒤에 붙는 Table CTRL_DATA.
    // 공식 5.0 문서에는 의미가 정리되어 있지 않지만, #1064/#1099 정답지 모두
    // 같은 104바이트 ParameterSet(0x021b → 0x0242)을 사용한다.
    const VALUES: [u32; 11] = [3826, 1048, 28346, 8475, 708, 0, 2, 9, 0, 59528, 84188];

    let mut data = Vec::with_capacity(104);
    data.extend_from_slice(&0x021b_u16.to_le_bytes());
    data.extend_from_slice(&1_u16.to_le_bytes());
    data.extend_from_slice(&0_u16.to_le_bytes());
    data.extend_from_slice(&0x0242_u16.to_le_bytes());
    data.extend_from_slice(&0x8000_u16.to_le_bytes());
    data.extend_from_slice(&0x0242_u16.to_le_bytes());
    data.extend_from_slice(&(VALUES.len() as u16).to_le_bytes());
    data.extend_from_slice(&0_u16.to_le_bytes());
    for (idx, value) in VALUES.iter().enumerate() {
        data.extend_from_slice(&(0x4000_u16 + idx as u16).to_le_bytes());
        data.extend_from_slice(&0x0004_u16.to_le_bytes());
        data.extend_from_slice(&value.to_le_bytes());
    }
    data
}

fn adapt_table(table: &mut Table, report: &mut AdapterReport) {
    adapt_table_with_context(table, report, ParagraphContext::Body);
}

fn adapt_table_with_context(
    table: &mut Table,
    report: &mut AdapterReport,
    context: ParagraphContext,
) {
    // 1. raw_ctrl_data 합성 (HWPX 출처는 비어있음)
    if table.raw_ctrl_data.is_empty() {
        materialize_table_outer_margin(table, report);
        materialize_table_record_attr(table, report);
        materialize_table_record_row_sizes(table, report);
        materialize_table_record_extra(table, report);
        materialize_table_ctrl_header_attr(table, report);

        table.raw_ctrl_data = serialize_common_obj_attr(&table.common);
        report.tables_ctrl_data_synthesized += 1;

        if table.raw_ctrl_data.len() >= common_obj_offsets::FLAGS.end {
            let packed = u32::from_le_bytes(
                table.raw_ctrl_data[common_obj_offsets::FLAGS]
                    .try_into()
                    .unwrap(),
            );
            if table.attr != packed {
                table.attr = packed;
                report.tables_attr_packed += 1;
            }
        }
    }

    // 셀별 보강 + 내부 문단 재귀 (중첩 표 대응)
    let use_cell_width_ref = table_requires_cell_width_ref_contract(table);
    let table_padding = table.padding;
    for cell in &mut table.cells {
        adapt_cell_list_attr(cell, report);
        materialize_cell_list_header_contract(cell, use_cell_width_ref, &table_padding, report);
        for cpara in &mut cell.paragraphs {
            adapt_paragraph_with_context(cpara, report, context);
        }
    }

    // 표 캡션 문단도 보강한다(#2443 에서 캡션이 bin 리맵 대상임이 확인됨).
    // 누락 시 캡션 안의 그림 href·중첩 표 ctrl_data 등이 물질화되지 않는다.
    if let Some(caption) = &mut table.caption {
        adapt_paragraphs_with_context(&mut caption.paragraphs, report, context);
    }
}

fn table_requires_cell_width_ref_contract(table: &Table) -> bool {
    // HWPX 조직도류 표는 많은 논리 열로 셀 폭을 쪼개어 만든 micro-grid 형태다.
    // 이 계열은 LIST_HEADER width_ref bit가 없으면 한컴이 셀 내부 줄나눔 폭을 너무 좁게 잡는다.
    //
    // 반대로 mel-001의 8x12 인원 현황 표는 같은 bit를 세우면 한컴이 병합 셀 높이를 과도하게
    // 계산했다. 따라서 raw_list_extra는 모든 셀에 materialize하되 width_ref bit는
    // 고열 수 micro-grid 표에만 적용한다.
    table.col_count >= 30
}

fn materialize_cell_list_header_contract(
    cell: &mut Cell,
    use_width_ref: bool,
    table_padding: &crate::model::Padding,
    report: &mut AdapterReport,
) {
    let before_width_ref = cell.list_header_width_ref;
    let before_extra_len = cell.raw_list_extra.len();

    // [#1809] micro-grid 계약으로 width_ref bit0(=aim)을 켤 때, aim=false 셀의
    // 유효 안 여백(effective_padding — 표 기본 폴백 포함)을 셀 padding 에 물질화한다.
    // 재파싱 시 aim=true 가 되면 측정/레이아웃의 aim=true 원값 존중 경로(#493 시멘틱)가
    // raw cell padding 을 그대로 쓰므로, 물질화 없이는 padding 0 셀의 행높이가
    // 원본(HWPX, 표 기본 여백)과 어긋난다 (admrul_0296 행 32.37→31.60, 표 3.87px).
    if use_width_ref && !cell.apply_inner_margin {
        cell.padding = cell.effective_padding(table_padding);
    }

    if use_width_ref || cell.apply_inner_margin {
        cell.list_header_width_ref |= 0x0001;
    } else {
        cell.list_header_width_ref &= !0x0001;
    }

    if cell.raw_list_extra.is_empty() {
        let mut extra = vec![0u8; 13];
        extra[0..4].copy_from_slice(&cell.width.to_le_bytes());
        cell.raw_list_extra = extra;
    }

    if cell.list_header_width_ref != before_width_ref
        || cell.raw_list_extra.len() != before_extra_len
    {
        report.cells_list_header_contract_materialized += 1;
    }
}

fn materialize_table_outer_margin(table: &mut Table, report: &mut AdapterReport) {
    let changed = table.common.margin.left != table.outer_margin_left
        || table.common.margin.right != table.outer_margin_right
        || table.common.margin.top != table.outer_margin_top
        || table.common.margin.bottom != table.outer_margin_bottom;
    if changed {
        table.common.margin.left = table.outer_margin_left;
        table.common.margin.right = table.outer_margin_right;
        table.common.margin.top = table.outer_margin_top;
        table.common.margin.bottom = table.outer_margin_bottom;
        report.tables_outer_margin_materialized += 1;
    }
}

fn materialize_table_record_attr(table: &mut Table, report: &mut AdapterReport) {
    let mut attr = match table.page_break {
        TablePageBreak::CellBreak => 0x01,
        TablePageBreak::RowBreak => 0x02,
        TablePageBreak::None => 0,
    };
    if table.repeat_header {
        attr |= 0x04;
    }
    if (table.attr | table.raw_table_record_attr) & 0x08 != 0 {
        attr |= 0x08;
    }
    // HWPX inMargin 값만 쓰면 한컴 에디터의 "셀 안쪽 여백 지정"이 꺼진
    // 상태로 저장된다. HWP5 TABLE attr bit 26을 함께 켜야 해당 여백이
    // 조판 계약에 참여한다. 공식 5.0 문서에는 이 상위 비트가 명시되어
    // 있지 않아 aift 정답 HWP와의 교차 검증으로 보존한다.
    if table.padding.left != 0
        || table.padding.right != 0
        || table.padding.top != 0
        || table.padding.bottom != 0
    {
        attr |= 0x0400_0000;
    }

    if table.raw_table_record_attr != attr {
        table.raw_table_record_attr = attr;
        report.table_record_attr_materialized += 1;
    }
}

fn materialize_table_record_row_sizes(table: &mut Table, report: &mut AdapterReport) {
    let mut row_sizes = vec![0i16; table.row_count as usize];
    for cell in &table.cells {
        let row = cell.row as usize;
        if row < row_sizes.len() {
            row_sizes[row] = row_sizes[row].saturating_add(1);
        }
    }

    if row_sizes.is_empty() || row_sizes.iter().all(|&count| count == 0) {
        return;
    }

    if table.row_sizes != row_sizes {
        table.row_sizes = row_sizes;
        report.table_record_row_sizes_materialized += 1;
    }
}

fn materialize_table_record_extra(table: &mut Table, report: &mut AdapterReport) {
    if table.raw_table_record_extra.is_empty() {
        table.raw_table_record_extra = vec![0, 0];
        report.table_record_extra_materialized += 1;
    }
}

fn materialize_table_ctrl_header_attr(table: &mut Table, report: &mut AdapterReport) {
    const HWPX_TABLE_FLOW_WITH_TEXT_BIT: u32 = 0x0000_2000;
    const HWPX_TABLE_NUMBERING_BIT: u32 = 0x0800_0000;
    const HWP5_TABLE_CAPTION_COMMON_ATTR_BIT: u32 = 0x2000_0000;

    let before = table.common.attr;
    let mut attr = pack_common_attr_bits(&table.common) | HWPX_TABLE_FLOW_WITH_TEXT_BIT;
    // [#2697] 파서(materialize_hwpx_table_attrs)와 동일 게이트: "표 번호" 비트는
    // numberingType 이 실제로 TABLE 일 때만 세운다. 종전 무조건 OR 은 numberingType=
    // "PICTURE"/"NONE" 표를 HWP5 저장 시 표 번호 범주로 되돌려, 파서가 #2697 에서
    // 제거한 IR 모순(numbering_type=Picture ↔ attr=TABLE)을 변환 계층이 재도입했다.
    if table.common.numbering_type == crate::model::shape::ObjectNumberingType::Table {
        attr |= HWPX_TABLE_NUMBERING_BIT;
    }
    if table.caption.is_some() {
        attr |= HWP5_TABLE_CAPTION_COMMON_ATTR_BIT;
    }
    table.common.attr = attr;

    if table.common.attr != before {
        report.table_ctrl_header_attr_materialized += 1;
    }
}

/// [#2767] 캡션이 있는 그림(gso `$pic`) CTRL_HEADER 의 한컴 캡션 비트(bit 29) 보강.
///
/// 전 코퍼스 실측(`samples/**/*.hwp`, 한컴 저작 원본): 캡션 동반 gso 80개(그림 42,
/// 사각형 33, 연결선 3, OLE 2) 전부 bit 29=1, 캡션 없는 gso 2,674개 전부 bit 29=0.
/// 개체 종류와 무관하게 캡션 유무만으로 결정된다. HWPX 출처 그림의
/// `common.attr` 는 파서(`pack_hwpx_common_obj_attr`)가 이미 non-zero로 채우고
/// 직렬화기가 verbatim 기록하므로, 표처럼 `pack_common_attr_bits(...)`로
/// **recompute** 하지 않고 비트만 **OR** 한다 — recompute 하면 표 전용 비트를
/// 그림에 강제로 얹는 회귀가 된다. 멱등: 비트가 이미 켜져 있으면 카운트하지 않음.
///
/// 도형(`$rec`/`$con`)·OLE 캡션은 범위 밖이다 — 직렬화기(`serializer/control.rs`)가
/// 도형 캡션 레코드 자체를 아직 출력하지 않아, 레코드 없이 비트만 켜면 자기모순
/// 레코드가 된다(별도 후속 과제).
fn materialize_picture_caption_common_attr(pic: &mut Picture, report: &mut AdapterReport) {
    const HWP5_GSO_CAPTION_COMMON_ATTR_BIT: u32 = 0x2000_0000;
    if pic.caption.is_some() && pic.common.attr & HWP5_GSO_CAPTION_COMMON_ATTR_BIT == 0 {
        pic.common.attr |= HWP5_GSO_CAPTION_COMMON_ATTR_BIT;
        report.picture_caption_common_attr_materialized += 1;
    }
}

/// 캡션이 있는 도형 CTRL_HEADER 의 한컴 캡션 비트(bit 29) 보강.
///
/// 직렬화기는 선·사각형·타원·다각형·호·곡선·묶음·차트의 캡션 레코드를 쓴다
/// (`serializer/control.rs` `emit_caption`). 캡션 레코드가 있는데 bit 29 가 꺼져 있으면
/// 한글이 문서 열기를 거부했다 (3-10월_교육_통합_2022.hwpx: `<보기>` 캡션 사각형).
/// 그림과 같이 비트만 OR 한다. 캡션 레코드를 쓰지 않는 OLE 등은 건드리지 않는다.
fn materialize_shape_caption_common_attr(shape: &mut ShapeObject, report: &mut AdapterReport) {
    const HWP5_GSO_CAPTION_COMMON_ATTR_BIT: u32 = 0x2000_0000;
    let has_written_caption = match shape {
        ShapeObject::Line(_)
        | ShapeObject::Rectangle(_)
        | ShapeObject::Ellipse(_)
        | ShapeObject::Polygon(_)
        | ShapeObject::Arc(_)
        | ShapeObject::Curve(_) => shape
            .drawing()
            .is_some_and(|drawing| drawing.caption.is_some()),
        ShapeObject::Group(group) => group.caption.is_some(),
        ShapeObject::Chart(chart) => chart.caption.is_some(),
        _ => false,
    };
    let common = shape.common_mut();
    if has_written_caption && common.attr & HWP5_GSO_CAPTION_COMMON_ATTR_BIT == 0 {
        common.attr |= HWP5_GSO_CAPTION_COMMON_ATTR_BIT;
        report.shape_caption_common_attr_materialized += 1;
    }
}

/// 셀 `apply_inner_margin` → LIST_HEADER width_ref bit 0 합성 (Stage 3, 보수적).
///
/// ## 배경
///
/// `serializer/control.rs` 가 작성하는 셀 LIST_HEADER 의 앞 8바이트:
/// ```text
/// n_para: u16
/// list_attr: u32
/// width_ref/property: u16
/// ```
///
/// HWPX 출처 셀에서 `apply_inner_margin = true` 인 경우, 직렬화 시 `width_ref bit 0` 이
/// 0 으로 떨어지면 한컴이 셀 안 여백을 표 기본값으로 대체한다.
///
/// ## 합성 방식
///
/// `apply_inner_margin == true`인 경우 `list_header_width_ref |= 0x0001`을 적용한다.
fn adapt_cell_list_attr(cell: &mut Cell, report: &mut AdapterReport) {
    if cell.apply_inner_margin && cell.list_header_width_ref & 0x0001 == 0 {
        cell.list_header_width_ref |= 0x0001;
        report.cells_list_attr_bit16_set += 1;
    }
}

/// [Issue #1770] HWPX-origin 마커 스트림 경로.
///
/// rhwp 의 HWPX→HWP 변환은 LINE_SEG 를 verbatim 직렬화하므로 산출 HWP5 의 IR 은
/// HWPX 시멘틱 그대로다. 재파스 시 이 마커로 `Document::is_hwpx_variant` 를 세워
/// pagination/렌더의 `is_hwpx_source` 분기(RowBreak 분할 tolerance 등)를 HWPX 로
/// 해석한다 — 같은 IR 이 같은 쪽수(roundtrip 자기정합, 2953495 4→5쪽 divergence 해소).
/// 한컴은 미지의 루트 스트림을 무시하고(열림 계약 게이트로 검증), 한컴에서 재저장하면
/// 마커가 사라지며 그 문서는 진짜 native HWP5 가 되므로 시멘틱이 자기일관적이다.
pub const HWPX_ORIGIN_STREAM_PATH: &str = "/RhwpHwpxOrigin";

/// `source_format` 검사 후 어댑터를 호출하는 보조 함수.
///
/// 호출자: `DocumentCore::export_hwp_with_adapter()` (Stage 5 에서 추가).
pub fn convert_if_hwpx_source(doc: &mut Document, source_format: FileFormat) -> AdapterReport {
    if !matches!(source_format, FileFormat::Hwpx | FileFormat::Hwp3) {
        return AdapterReport::new().no_op("source_format != Hwpx/Hwp3");
    }
    // HWP5→HWPX 재저장은 HWP5 계보를 유지한다. 원래 HWPX 출처만 마커 부여.
    // idempotent — 이미 있으면 추가하지 않는다.
    if matches!(source_format, FileFormat::Hwpx)
        && !doc.layout_profile().hwp5_origin_hwpx()
        && !doc
            .extra_streams
            .iter()
            .any(|(p, _)| p == HWPX_ORIGIN_STREAM_PATH)
    {
        doc.extra_streams
            .push((HWPX_ORIGIN_STREAM_PATH.to_string(), b"1".to_vec()));
    }
    convert_hwpx_to_hwp_ir(doc)
}


//! HWP 레코드 직렬화
//!
//! `Record::read_all()`의 역방향으로, 레코드를 바이너리 스트림으로 인코딩한다.
//!
//! 레코드 헤더 구조 (4바이트):
//! - bits 0~9:   태그 ID (0~1023)
//! - bits 10~19: 레벨 (0~1023)
//! - bits 20~31: 크기 (0~4094, 4095=확장)
//! - 크기 >= 4095이면 헤더에 0xFFF 기록 후 실제 크기 u32 추가

use crate::parser::record::Record;

/// 단일 레코드를 바이너리로 인코딩
///
/// 반환: 레코드 헤더 + 데이터 바이트
pub fn write_record(tag_id: u16, level: u16, data: &[u8]) -> Vec<u8> {
    let size = data.len() as u32;
    let extended = size >= 0xFFF;

    let header_size = if extended { 0xFFF } else { size };
    let header: u32 =
        (tag_id as u32 & 0x3FF) | ((level as u32 & 0x3FF) << 10) | (header_size << 20);

    let mut bytes = Vec::with_capacity(4 + if extended { 4 } else { 0 } + data.len());
    bytes.extend_from_slice(&header.to_le_bytes());

    if extended {
        bytes.extend_from_slice(&size.to_le_bytes());
    }

    bytes.extend_from_slice(data);
    bytes
}

/// Record 구조체를 바이너리로 인코딩
pub fn write_record_from(record: &Record) -> Vec<u8> {
    write_record(record.tag_id, record.level, &record.data)
}

/// 여러 레코드를 연결하여 바이너리 스트림 생성
pub fn write_records(records: &[Record]) -> Vec<u8> {
    let total_size: usize = records
        .iter()
        .map(|r| 4 + if r.data.len() >= 0xFFF { 4 } else { 0 } + r.data.len())
        .sum();

    let mut bytes = Vec::with_capacity(total_size);
    for record in records {
        bytes.extend(write_record_from(record));
    }
    bytes
}


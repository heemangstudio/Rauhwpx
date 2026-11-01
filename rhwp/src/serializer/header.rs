//! FileHeader 직렬화
//!
//! `parse_file_header()`의 역방향으로, FileHeader를 256바이트 바이너리로 변환한다.
//!
//! FileHeader 구조 (256바이트, 비압축):
//! - [0-17]: "HWP Document File\0" 시그니처
//! - [18-31]: 0 패딩
//! - [32-35]: 버전 (revision, build, minor, major) LE
//! - [36-39]: 속성 플래그 u32 LE
//! - [40-255]: 0 패딩

use crate::model::document::FileHeader;
use crate::parser::header::{FILE_HEADER_SIZE, HWP_SIGNATURE};

/// FileHeader를 256바이트 바이너리로 직렬화
pub fn serialize_file_header(header: &FileHeader) -> Vec<u8> {
    // 원본 데이터가 있으면 그대로 반환 (완벽한 라운드트립)
    if let Some(ref raw) = header.raw_data {
        return raw.clone();
    }

    let mut data = vec![0u8; FILE_HEADER_SIZE];

    // [0-17]: 시그니처 "HWP Document File"
    data[..HWP_SIGNATURE.len()].copy_from_slice(HWP_SIGNATURE);
    // [18] 이후는 이미 0으로 패딩됨

    // [32-35]: 버전 (revision, build, minor, major)
    data[32] = header.version.revision;
    data[33] = header.version.build;
    data[34] = header.version.minor;
    data[35] = header.version.major;

    // [36-39]: 플래그
    data[36..40].copy_from_slice(&header.flags.to_le_bytes());

    data
}


//! 연결 그림 자리(빈 BinDataContent)는 저장 스트림이 아니다.
//!
//! HWP3 파서는 연결 그림 자리를 id 0·빈 바이트로 채워 순번 조회를 맞춘다. 직렬화가 이
//! 자리마다 `BIN0000.` 스트림을 만들려 해 연결 그림이 둘 이상인 문서는 저장할 수 없었다.
//! 느린 실제 표본 확인은 tests/sweeps/linked_images_save.rs 에 있다.

use rhwp::document_core::DocumentCore;
use rhwp::model::bin_data::{BinData, BinDataContent, BinDataType};

fn document_with_two_linked_images() -> rhwp::model::document::Document {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().expect("blank document");
    let mut doc = core.document().clone();
    for (id, name) in [
        (1u16, r"D:\Work\images\oracle.gif"),
        (2, r"D:\Work\images\s1.jpg"),
    ] {
        doc.doc_info.bin_data_list.push(BinData {
            data_type: BinDataType::Link,
            storage_id: id,
            extension: name.rsplit('.').next().map(str::to_string),
            abs_path: Some(name.to_string()),
            rel_path: Some(name.to_string()),
            ..Default::default()
        });
        doc.bin_data_content.push(BinDataContent {
            id: 0,
            extension: String::new(),
            data: Vec::new().into(),
        });
    }
    // 빈 문서의 DocInfo 원본 스트림 대신 바꾼 BinData 목록을 쓰게 한다.
    doc.doc_info.raw_stream_dirty = true;
    doc
}

#[test]
fn hwp_save_skips_linked_image_placeholders() {
    let doc = document_with_two_linked_images();
    let bytes = rhwp::serializer::serialize_hwp(&doc).expect("HWP save with linked images");
    let reopened = DocumentCore::from_bytes(&bytes).expect("reopen");
    let links: Vec<_> = reopened
        .document()
        .doc_info
        .bin_data_list
        .iter()
        .filter(|bin_data| bin_data.data_type == BinDataType::Link)
        .filter_map(|bin_data| bin_data.abs_path.clone())
        .collect();
    assert_eq!(
        links,
        [r"D:\Work\images\oracle.gif", r"D:\Work\images\s1.jpg"]
    );
}

#[test]
fn hwpx_save_skips_linked_image_placeholders() {
    let doc = document_with_two_linked_images();
    let bytes = rhwp::serializer::serialize_hwpx(&doc).expect("HWPX save with linked images");
    // export_hwpx_native refuses a package that fails this check.
    let report = rhwp::serializer::hwpx::package_check::check_package(&bytes, &doc);
    assert!(report.is_ok(), "{}", report.summary());
}

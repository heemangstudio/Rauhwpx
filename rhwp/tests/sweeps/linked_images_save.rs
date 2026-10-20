//! 연결(Link) 그림이 든 문서도 HWP·HWPX 로 저장된다.
//!
//! hwp3-sample10.hwp 는 그림 세 개가 `D:\Work\...` 의 외부 파일을 가리킨다. HWP3 파서는 그
//! 자리를 빈 BinDataContent 로 채우는데, HWP 저장은 모두 `BIN0000.` 으로 이름 지어 중복
//! 스트림으로 실패했고 HWPX 저장은 패키지 검사에서 BinData 수 불일치로 실패했다.
//! 한컴이 같은 문서를 HWP5 로 바꾼 hwp3-sample10-hwp5.hwp 는 HWPX 저장이 연결 그림을
//! 찾지 못해 실패했다.

use rhwp::document_core::DocumentCore;
use rhwp::model::bin_data::BinDataType;

fn load(path: &str) -> DocumentCore {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    DocumentCore::from_bytes(&bytes).unwrap_or_else(|e| panic!("{path}: {e:?}"))
}

fn link_count(core: &DocumentCore) -> usize {
    core.document()
        .doc_info
        .bin_data_list
        .iter()
        .filter(|bin_data| bin_data.data_type == BinDataType::Link)
        .count()
}

#[test]
fn hwp3_document_with_linked_images_saves_as_hwp_and_hwpx() {
    let core = load("samples/hwp3-sample10.hwp");
    assert!(
        link_count(&core) >= 2,
        "fixture must hold several linked images"
    );

    let hwp = core.export_hwp_native().expect("HWP save");
    let reopened = DocumentCore::from_bytes(&hwp).expect("reopen HWP");
    assert_eq!(link_count(&reopened), link_count(&core));

    let hwpx = core.export_hwpx_native().expect("HWPX save");
    let reopened = DocumentCore::from_bytes(&hwpx).expect("reopen HWPX");
    assert_eq!(link_count(&reopened), link_count(&core));
}

#[test]
fn hwp5_document_with_linked_images_saves_as_hwpx() {
    let core = load("samples/hwp3-sample10-hwp5.hwp");
    assert!(link_count(&core) >= 1, "fixture must hold a linked image");
    let hwpx = core.export_hwpx_native().expect("HWPX save");
    let reopened = DocumentCore::from_bytes(&hwpx).expect("reopen HWPX");
    assert_eq!(link_count(&reopened), link_count(&core));
}

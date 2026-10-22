//! 메모 교차 포맷 저장 계약: HWP↔HWPX 저장 후 다시 열어도 작성자·번호·본문·메모 모양이
//! 남고, 메모 번호는 문서 안에서 유일해야 한다.

use rhwp::model::document::Document;
use rhwp::wasm_api::HwpDocument;

use super::common::load_doc;
use super::memo_hwp_parse::memo_fields;
use super::memo_hwp_roundtrip::memo_set;

fn authors_and_numbers(doc: &Document) -> Vec<(u32, String, u32)> {
    let mut out: Vec<(u32, String, u32)> = memo_fields(doc)
        .iter()
        .map(|f| {
            let meta = f.memo_meta().expect("memo command");
            (f.memo_index, meta.author, meta.number)
        })
        .collect();
    out.sort();
    out
}

fn assert_distinct_indexes(doc: &Document, label: &str) {
    let memos = memo_fields(doc);
    let mut indexes: Vec<u32> = memos.iter().map(|f| f.memo_index).collect();
    indexes.sort();
    indexes.dedup();
    assert_eq!(indexes.len(), memos.len(), "{label}: distinct memo indexes");
    assert!(
        indexes.iter().all(|&i| i != 0),
        "{label}: no zero memo index"
    );
}

fn reload(bytes: &[u8]) -> HwpDocument {
    HwpDocument::from_bytes(bytes).expect("reload")
}

#[test]
fn hwp_memos_survive_hwpx_save() {
    for sample in [
        "samples/basic/NewYear_s_Day.hwp",
        "samples/basic/english.hwp",
        "samples/aift.hwp",
    ] {
        let mut doc = load_doc(sample);
        doc.insert_text_native(0, 0, 0, "X").unwrap();
        let before = doc.document();
        let shapes = before.memo_shapes();
        assert!(!shapes.is_empty(), "{sample}: HWP memo shapes");
        let hwpx = reload(&doc.export_hwpx_native().unwrap());
        let after = hwpx.document();
        assert_eq!(memo_set(after), memo_set(before), "{sample}: memo bodies");
        assert_eq!(
            authors_and_numbers(after),
            authors_and_numbers(before),
            "{sample}: author/number"
        );
        assert_distinct_indexes(after, sample);
        assert_eq!(after.memo_shapes(), shapes, "{sample}: memo shape colors");

        // HWP → HWPX → HWP keeps the MEMO_SHAPE count.
        let hwp = reload(&hwpx.export_hwp_with_adapter().unwrap());
        assert_eq!(
            hwp.document().doc_info.memo_shape_count,
            before.doc_info.memo_shape_count,
            "{sample}: memo_shape_count"
        );
        assert_eq!(
            memo_set(hwp.document()),
            memo_set(before),
            "{sample}: back to HWP"
        );
    }
}

#[test]
fn hwpx_memos_survive_hwp_save_and_hwpx_resave() {
    let mut doc = load_doc("samples/hwpx/aift.hwpx");
    let before = memo_set(doc.document());
    let authors = authors_and_numbers(doc.document());
    let shapes = doc.document().memo_shapes();
    assert_eq!(before.len(), 2);

    let hwp = reload(&doc.export_hwp_with_adapter().unwrap());
    assert_eq!(memo_set(hwp.document()), before, "HWPX → HWP");
    assert_eq!(
        authors_and_numbers(hwp.document()),
        authors,
        "HWPX → HWP author/number"
    );
    assert_eq!(
        hwp.document().memo_shapes(),
        shapes,
        "HWPX → HWP memo shapes"
    );

    doc.insert_text_native(2, 0, 0, "X").unwrap();
    let hwpx = reload(&doc.export_hwpx_native().unwrap());
    assert_eq!(memo_set(hwpx.document()), before, "HWPX edit → HWPX");
    assert_eq!(authors_and_numbers(hwpx.document()), authors);
    assert_distinct_indexes(hwpx.document(), "HWPX edit → HWPX");
}

#[test]
fn hwp_source_memo_writes_hancom_hwpx_memo_markup() {
    let mut doc = load_doc("samples/basic/english.hwp");
    doc.insert_text_native(0, 0, 0, "X").unwrap();
    let bytes = doc.export_hwpx_native().unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut read = |name: &str| {
        let mut s = String::new();
        std::io::Read::read_to_string(&mut zip.by_name(name).unwrap(), &mut s).unwrap();
        s
    };
    let header = read("Contents/header.xml");
    assert!(
        header.contains("<hh:memoProperties itemCnt="),
        "memoProperties from MEMO_SHAPE"
    );
    let section = read("Contents/section0.xml");
    let begin = section.find(r#"type="MEMO""#).expect("memo fieldBegin");
    let memo = &section[begin..section[begin..].find("</hp:fieldBegin>").unwrap() + begin];
    for param in [
        r#"<hp:parameters cnt="7""#,
        r#"name="Command""#,
        r#"<hp:stringParam name="ID">memo1</hp:stringParam>"#,
        r#"<hp:integerParam name="Number">1</hp:integerParam>"#,
        r#"<hp:stringParam name="Author">한글과컴퓨터</hp:stringParam>"#,
        r#"name="MemoShapeIDRef""#,
        r#"name="CreateDateTime""#,
    ] {
        assert!(memo.contains(param), "missing {param} in {memo}");
    }
    assert!(
        !memo.contains("<hp:linesegarray>"),
        "no invented linesegs in memo body: {memo}"
    );
}

/// HWP → HWPX 의 CreateDateTime 은 한컴과 같은 값이어야 한다. 한컴은 명령 FILETIME(UTC)을
/// 현지(KST) 시각으로 바꿔 `Z` 를 붙여 쓴다 — aift.hwp 와 한컴이 저장한 aift.hwpx 는 명령
/// 시각이 같고 CreateDateTime 은 +9h 이다.
#[test]
fn hwp_to_hwpx_create_date_time_matches_hancom() {
    fn create_date_times(bytes: Vec<u8>) -> Vec<String> {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut out = Vec::new();
        for index in 0.. {
            let Ok(mut entry) = zip.by_name(&format!("Contents/section{index}.xml")) else {
                break;
            };
            let mut s = String::new();
            std::io::Read::read_to_string(&mut entry, &mut s).unwrap();
            let key = r#"<hp:stringParam name="CreateDateTime">"#;
            for (at, _) in s.match_indices(key) {
                let rest = &s[at + key.len()..];
                out.push(rest[..rest.find('<').unwrap()].to_string());
            }
        }
        out.sort();
        out
    }
    let hancom = create_date_times(std::fs::read("samples/hwpx/aift.hwpx").unwrap());
    assert_eq!(hancom.len(), 2, "fixture memos");
    let mut doc = load_doc("samples/aift.hwp");
    doc.insert_text_native(0, 0, 0, "X").unwrap();
    assert_eq!(create_date_times(doc.export_hwpx_native().unwrap()), hancom);
}

//! upstream #7478: 새 HWPX의 호환성 블록은 실제 reference 구조와 같고, 포크의 설정은 보존한다.

use std::io::{Cursor, Read};

use quick_xml::events::Event;
use quick_xml::Reader;
use rhwp::parser::hwpx::parse_hwpx;
use rhwp::serializer::hwpx::serialize_hwpx;

const REFERENCE: &[u8] = include_bytes!("../samples/hwpx/ref/ref_empty.hwpx");

fn compatibility_children(bytes: &[u8]) -> Vec<String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut xml = String::new();
    zip.by_name("Contents/header.xml")
        .unwrap()
        .read_to_string(&mut xml)
        .unwrap();
    let mut reader = Reader::from_str(&xml);
    let mut inside = false;
    let mut blocks = 0;
    let mut children = Vec::new();
    loop {
        match reader.read_event().unwrap() {
            Event::Start(e) if e.local_name().as_ref() == b"layoutCompatibility" => {
                blocks += 1;
                inside = true;
            }
            Event::Empty(e) if e.local_name().as_ref() == b"layoutCompatibility" => blocks += 1,
            Event::End(e) if e.local_name().as_ref() == b"layoutCompatibility" => inside = false,
            Event::Start(e) | Event::Empty(e) if inside => {
                children.push(String::from_utf8(e.local_name().as_ref().to_vec()).unwrap());
            }
            Event::Eof => break,
            _ => {}
        }
    }
    assert_eq!(blocks, 1, "호환성 블록이 정확히 하나 있어야 한다");
    children
}

#[test]
fn fallback_matches_reference_and_preserves_each_supported_flag() {
    let expected = compatibility_children(REFERENCE);
    assert!(expected.is_empty(), "reference는 빈 호환성 블록이다");
    for baseline in [false, true] {
        for forbidden in [false, true] {
            let mut doc = parse_hwpx(REFERENCE).unwrap();
            doc.doc_info.hwpx_head_tail = None;
            doc.doc_info.adjust_baseline_in_fixed_line_spacing = baseline;
            doc.doc_info.do_not_align_last_forbidden = forbidden;
            doc.doc_info.hwpx_target_program = Some("MS_WORD".into());
            let output = serialize_hwpx(&doc).unwrap();
            let mut wanted = expected.clone();
            if baseline {
                wanted.push("adjustBaselineInFixedLinespacing".into());
            }
            if forbidden {
                wanted.push("doNotAlignLastForbidden".into());
            }
            assert_eq!(compatibility_children(&output), wanted);
            let reopened = parse_hwpx(&output).unwrap();
            assert_eq!(
                reopened.doc_info.adjust_baseline_in_fixed_line_spacing,
                baseline
            );
            assert_eq!(reopened.doc_info.do_not_align_last_forbidden, forbidden);
            assert_eq!(
                reopened.doc_info.hwpx_target_program.as_deref(),
                Some("MS_WORD")
            );
        }
    }
}

#[test]
fn existing_header_tail_survives_without_normalization() {
    let mut doc = parse_hwpx(REFERENCE).unwrap();
    // 원본 꼬리는 알 수 없는 공급자 설정까지 그대로 보존하는 기존 계약이다.
    let tail = r#"<hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility><hh:vendorSetting/></hh:layoutCompatibility></hh:compatibleDocument>"#;
    doc.doc_info.hwpx_head_tail = Some(tail.into());
    let output = serialize_hwpx(&doc).unwrap();
    assert_eq!(compatibility_children(&output), ["vendorSetting"]);
    let reopened = parse_hwpx(&output).unwrap();
    assert_eq!(reopened.doc_info.hwpx_head_tail.as_deref(), Some(tail));
}

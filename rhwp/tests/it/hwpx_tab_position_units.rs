//! HWPX 탭 정의는 네이티브 유효 단위와 IR의 2배 위치를 함께 보존한다.
use std::io::{Cursor, Read};

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use rhwp::model::document::Document;
use rhwp::model::style::{TabDef, TabItem};
use rhwp::parser::hwpx::{header::parse_hwpx_header, parse_hwpx};
use rhwp::serializer::serialize_hwpx;

const HWPUNITCHAR: &str = "http://www.hancom.co.kr/hwpml/2016/HwpUnitChar";

// 실제 native-english-step03-deleted.hwpx의 tabPr0/1/2 정의에서 발췌.
const NATIVE_TABS: &str = r#"<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hh:refList><hh:tabProperties itemCnt="3">
<hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/>
<hh:tabPr id="1" autoTabLeft="0" autoTabRight="0">
<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"><hh:tabItem pos="0" type="LEFT" leader="NONE" unit="HWPUNIT"/></hp:case><hp:default><hh:tabItem pos="0" type="LEFT" leader="NONE"/></hp:default></hp:switch>
<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"><hh:tabItem pos="7256" type="LEFT" leader="NONE" unit="HWPUNIT"/></hp:case><hp:default><hh:tabItem pos="14512" type="LEFT" leader="NONE"/></hp:default></hp:switch>
<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"><hh:tabItem pos="13380" type="LEFT" leader="NONE" unit="HWPUNIT"/></hp:case><hp:default><hh:tabItem pos="26760" type="LEFT" leader="NONE"/></hp:default></hp:switch>
<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"><hh:tabItem pos="19504" type="LEFT" leader="NONE" unit="HWPUNIT"/></hp:case><hp:default><hh:tabItem pos="39008" type="LEFT" leader="NONE"/></hp:default></hp:switch>
<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"><hh:tabItem pos="25624" type="LEFT" leader="NONE" unit="HWPUNIT"/></hp:case><hp:default><hh:tabItem pos="51248" type="LEFT" leader="NONE"/></hp:default></hp:switch>
</hh:tabPr>
<hh:tabPr id="2" autoTabLeft="0" autoTabRight="0">
<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"><hh:tabItem pos="0" type="LEFT" leader="NONE" unit="HWPUNIT"/></hp:case><hp:default><hh:tabItem pos="0" type="LEFT" leader="NONE"/></hp:default></hp:switch>
<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"><hh:tabItem pos="17008" type="LEFT" leader="NONE" unit="HWPUNIT"/></hp:case><hp:default><hh:tabItem pos="34016" type="LEFT" leader="NONE"/></hp:default></hp:switch>
</hh:tabPr></hh:tabProperties></hh:refList></hh:head>"#;

#[derive(Debug, PartialEq)]
struct XmlTab {
    position: u32,
    tab_type: String,
    leader: String,
    unit: Option<String>,
}

#[derive(Debug)]
struct XmlDefinition {
    id: u16,
    auto_left: bool,
    auto_right: bool,
    cases: Vec<XmlTab>,
    defaults: Vec<XmlTab>,
    bare: Vec<XmlTab>,
}

fn attr(element: &BytesStart<'_>, name: &[u8]) -> Option<String> {
    element
        .attributes()
        .map(|attribute| attribute.unwrap())
        .find(|attribute| attribute.key.as_ref() == name)
        .map(|attribute| String::from_utf8(attribute.value.into_owned()).unwrap())
}

fn definition(element: &BytesStart<'_>) -> XmlDefinition {
    XmlDefinition {
        id: attr(element, b"id").unwrap().parse().unwrap(),
        auto_left: attr(element, b"autoTabLeft").as_deref() == Some("1"),
        auto_right: attr(element, b"autoTabRight").as_deref() == Some("1"),
        cases: Vec::new(),
        defaults: Vec::new(),
        bare: Vec::new(),
    }
}

fn definitions(xml: &str) -> Vec<XmlDefinition> {
    let mut reader = Reader::from_str(xml);
    let mut result = Vec::new();
    let mut current = None;
    let mut branch = "";
    loop {
        match reader.read_event().unwrap() {
            Event::Start(element) => match element.name().as_ref() {
                b"hh:tabPr" => current = Some(definition(&element)),
                b"hp:case" if current.is_some() => {
                    assert_eq!(
                        attr(&element, b"hp:required-namespace").as_deref(),
                        Some(HWPUNITCHAR)
                    );
                    branch = "case";
                }
                b"hp:default" if current.is_some() => branch = "default",
                _ => {}
            },
            Event::Empty(element) => match element.name().as_ref() {
                b"hh:tabPr" => result.push(definition(&element)),
                b"hh:tabItem" if current.is_some() => {
                    let tab = XmlTab {
                        position: attr(&element, b"pos").unwrap().parse().unwrap(),
                        tab_type: attr(&element, b"type").unwrap(),
                        leader: attr(&element, b"leader").unwrap(),
                        unit: attr(&element, b"unit"),
                    };
                    let definition = current.as_mut().unwrap();
                    match branch {
                        "case" => definition.cases.push(tab),
                        "default" => definition.defaults.push(tab),
                        _ => definition.bare.push(tab),
                    }
                }
                _ => {}
            },
            Event::End(element) => match element.name().as_ref() {
                b"hh:tabPr" => result.push(current.take().unwrap()),
                b"hp:case" | b"hp:default" if current.is_some() => branch = "",
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    result
}

fn document(tabs: Vec<TabDef>) -> Document {
    let mut doc = parse_hwpx(include_bytes!("../../samples/hwpx/ref/ref_empty.hwpx")).unwrap();
    doc.doc_info.tab_defs = tabs;
    doc
}

fn export(doc: &Document) -> (Vec<XmlDefinition>, Document) {
    let bytes = serialize_hwpx(doc).unwrap();
    let mut zip = zip::ZipArchive::new(Cursor::new(&bytes)).unwrap();
    let mut xml = String::new();
    zip.by_name("Contents/header.xml")
        .unwrap()
        .read_to_string(&mut xml)
        .unwrap();
    (definitions(&xml), parse_hwpx(&bytes).unwrap())
}

fn tab(position: u32, tab_type: u8, fill_type: u8) -> TabItem {
    TabItem {
        position,
        tab_type,
        fill_type,
    }
}

#[test]
fn authentic_tab_stops_keep_native_effective_positions() {
    let (info, _) = parse_hwpx_header(NATIVE_TABS).unwrap();
    let expected_native = definitions(NATIVE_TABS);
    let doc = document(info.tab_defs);
    let (xml, reopened) = export(&doc);
    assert_eq!(xml.len(), 3);
    for (actual, native) in xml.iter().zip(&expected_native) {
        assert_eq!(actual.id, native.id);
        assert_eq!(actual.cases, native.cases, "네이티브 유효 탭 위치 보존");
        assert_eq!(actual.defaults, native.defaults);
        assert!(actual.bare.is_empty());
    }
    assert_eq!(reopened.doc_info.tab_defs, doc.doc_info.tab_defs);
    let (second_xml, second_reopen) = export(&reopened);
    for (first, second) in xml.iter().zip(second_xml) {
        assert_eq!(first.cases, second.cases);
        assert_eq!(first.defaults, second.defaults);
    }
    assert_eq!(second_reopen.doc_info.tab_defs, doc.doc_info.tab_defs);
}

#[test]
fn tab_types_leaders_and_auto_flags_survive_both_encodings() {
    let doc = document(vec![
        TabDef::default(),
        TabDef {
            auto_tab_left: true,
            auto_tab_right: true,
            tabs: vec![
                tab(0, 0, 0),
                tab(1200, 1, 8),
                tab(34016, 2, 9),
                tab(u32::MAX - 1, 3, 11),
            ],
            ..Default::default()
        },
        TabDef::default(),
    ]);
    let (xml, reopened) = export(&doc);
    let actual = &xml[1];
    assert_eq!(actual.id, 1);
    assert!(actual.auto_left && actual.auto_right);
    let expected = [
        (0, 0, "LEFT", "NONE"),
        (600, 1200, "RIGHT", "DOUBLE_SLIM"),
        (17008, 34016, "CENTER", "SLIM_THICK"),
        (2147483647, 4294967294, "DECIMAL", "SLIM_THICK_SLIM"),
    ];
    assert_eq!(actual.cases.len(), expected.len());
    assert_eq!(actual.defaults.len(), expected.len());
    for ((case, default), (effective, stored, kind, leader)) in
        actual.cases.iter().zip(&actual.defaults).zip(expected)
    {
        assert_eq!((case.position, default.position), (effective, stored));
        assert_eq!(
            (case.tab_type.as_str(), default.tab_type.as_str()),
            (kind, kind)
        );
        assert_eq!(
            (case.leader.as_str(), default.leader.as_str()),
            (leader, leader)
        );
        assert_eq!(case.unit.as_deref(), Some("HWPUNIT"));
        assert_eq!(default.unit, None);
    }
    assert_eq!(reopened.doc_info.tab_defs, doc.doc_info.tab_defs);
}

#[test]
fn empty_definitions_keep_auto_flags_without_item_branches() {
    let doc = document(vec![
        TabDef {
            auto_tab_left: true,
            ..Default::default()
        },
        TabDef {
            auto_tab_right: true,
            ..Default::default()
        },
        TabDef {
            auto_tab_left: true,
            auto_tab_right: true,
            ..Default::default()
        },
    ]);
    let (xml, reopened) = export(&doc);
    assert_eq!(xml.len(), 3);
    for (actual, expected) in xml.iter().zip(&doc.doc_info.tab_defs) {
        assert_eq!(actual.auto_left, expected.auto_tab_left);
        assert_eq!(actual.auto_right, expected.auto_tab_right);
        assert!(actual.cases.is_empty() && actual.defaults.is_empty() && actual.bare.is_empty());
    }
    assert_eq!(reopened.doc_info.tab_defs, doc.doc_info.tab_defs);
}

#[test]
fn odd_or_mixed_definitions_keep_all_original_positions() {
    // 홀수 위치의 네이티브 의미는 미검증. 같은 정의의 짝수 항목도 기존 경로를 유지한다.
    let doc = document(vec![
        TabDef::default(),
        TabDef {
            tabs: vec![tab(1, 1, 8), tab(14513, 2, 9), tab(u32::MAX, 3, 11)],
            ..Default::default()
        },
        TabDef {
            tabs: vec![
                tab(0, 0, 0),
                tab(14512, 1, 8),
                tab(26761, 2, 9),
                tab(51248, 3, 11),
            ],
            ..Default::default()
        },
        TabDef {
            tabs: vec![tab(0, 0, 0), tab(34016, 0, 0)],
            ..Default::default()
        },
    ]);
    let (xml, reopened) = export(&doc);
    for index in [1, 2] {
        let actual = &xml[index];
        assert_eq!(actual.id, index as u16);
        assert!(actual.cases.is_empty() && actual.defaults.is_empty());
        assert_eq!(
            actual
                .bare
                .iter()
                .map(|tab| tab.position)
                .collect::<Vec<_>>(),
            doc.doc_info.tab_defs[index]
                .tabs
                .iter()
                .map(|tab| tab.position)
                .collect::<Vec<_>>()
        );
        assert!(actual.bare.iter().all(|tab| tab.unit.is_none()));
    }
    assert_eq!(
        xml[3]
            .cases
            .iter()
            .map(|tab| tab.position)
            .collect::<Vec<_>>(),
        [0, 17008]
    );
    assert_eq!(reopened.doc_info.tab_defs, doc.doc_info.tab_defs);
}

//! 필드 컨트롤 직렬화 — Bookmark, Hyperlink, Field (fieldBegin/End) 뼈대.
//!
//! Stage 5 (#182): 인라인 필드 컨트롤의 `<hp:fieldBegin>` / `<hp:fieldEnd>` 및 `<hp:bookmark>`
//! 의 XML 뼈대를 제공한다. 각주(`<hp:fn>`) / 미주(`<hp:en>`) 는 향후 이슈에서 확장.
//!
//! ## 범위 한정
//!
//! - Stage 5 에서는 **필드 뼈대 출력** 기능만 제공 (section.rs dispatcher 연결은 #186).
//! - 누름틀(ClickHere), 날짜, 메일머지 등 복잡한 필드는 `<hp:fieldBegin type="...">` 의
//!   type 속성만 구분하고 내부 command 직렬화는 #186 에서 확장.

use std::io::Write;

use quick_xml::Writer;

use crate::model::control::{Bookmark, Field, FieldType, Hyperlink};

use super::utils::{empty_tag, end_tag, start_tag, start_tag_attrs, text};
use super::SerializeError;

// =====================================================================
// <hp:bookmark>
// =====================================================================

pub fn write_bookmark<W: Write>(w: &mut Writer<W>, bm: &Bookmark) -> Result<(), SerializeError> {
    empty_tag(w, "hp:bookmark", &[("name", &bm.name)])
}

// =====================================================================
// <hp:fieldBegin> / <hp:fieldEnd>
// =====================================================================

/// `<hp:fieldBegin>` 여는 태그 + 속성 문자열을 만든다 (자기닫힘 `/>` 없이).
///
/// [#1391] parameters / memo subList 가 있으면 호출부가 자식을 채우고 `</hp:fieldBegin>`
/// 로 닫는다. 없으면 호출부가 `/>` 로 자기닫힘 처리.
pub fn field_begin_open_tag(field: &Field) -> String {
    let id_str = field.field_id.to_string();
    let ft = field_type_str(field.field_type);
    let name = xml_escape_attr(field.ctrl_data_name.as_deref().unwrap_or(""));
    // [#task-m100] 원본 `fieldid` 속성 보존 — id 와 별개 값일 수 있어(#1512) 생략하면
    // 왕복 시 영구 손실된다. 없으면(None) 속성 자체를 생략(#1391 자기닫힘 태그 호환).
    match field.instance_id {
        Some(fieldid) => format!(
            r#"<hp:fieldBegin id="{}" type="{}" name="{}" editable="{}" fieldid="{}""#,
            id_str,
            ft,
            name,
            bool01(field.is_editable_in_form()),
            fieldid,
        ),
        None => format!(
            r#"<hp:fieldBegin id="{}" type="{}" name="{}" editable="{}""#,
            id_str,
            ft,
            name,
            bool01(field.is_editable_in_form()),
        ),
    }
}

fn xml_escape_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// `<hp:fieldBegin>` — 필드 시작 마커 (자식 없는 경우 자기닫힘).
///
/// HWPX 필드는 텍스트 흐름 안에서 `<hp:fieldBegin>` ~ 텍스트 ~ `<hp:fieldEnd>` 쌍으로 표현된다.
/// 한컴 저장본이 필드 종류마다 쓰는 `fieldid` 값 (종류마다 같은 값).
///
/// HWP5 출처 필드에는 이 값이 없다. `fieldid` 없이 여러 문단에 걸친 필드를 쓰면 한글이
/// 끝 표지를 짝짓지 못해 문서를 열지 못했다(차례 필드). 알려진 종류만 채운다.
pub(crate) fn hancom_field_type_id(field_type: FieldType) -> Option<u32> {
    match field_type {
        FieldType::ClickHere => Some(627_272_811),
        FieldType::Formula => Some(627_469_685),
        FieldType::Hyperlink => Some(627_600_491),
        FieldType::Bookmark => Some(627_207_531),
        FieldType::Memo => Some(623_209_829),
        FieldType::TableOfContents => Some(628_387_683),
        _ => None,
    }
}

/// HWP5 필드 ctrl_id 로 [`hancom_field_type_id`] 를 찾는다 (고아 fieldEnd 용).
pub(crate) fn hancom_field_type_id_for_ctrl(ctrl_id: u32) -> Option<u32> {
    use crate::parser::tags;
    let field_type = match ctrl_id {
        tags::FIELD_CLICKHERE => FieldType::ClickHere,
        tags::FIELD_FORMULA => FieldType::Formula,
        tags::FIELD_HYPERLINK => FieldType::Hyperlink,
        tags::FIELD_BOOKMARK => FieldType::Bookmark,
        tags::FIELD_MEMO => FieldType::Memo,
        tags::FIELD_TOC => FieldType::TableOfContents,
        _ => return None,
    };
    hancom_field_type_id(field_type)
}

pub fn write_field_begin<W: Write>(w: &mut Writer<W>, field: &Field) -> Result<(), SerializeError> {
    let id_str = field.field_id.to_string();
    let ft = field_type_str(field.field_type);
    let fieldid_str = field
        .instance_id
        .or_else(|| hancom_field_type_id(field.field_type))
        .map(|v| v.to_string());
    let editable_str = bool01(field.is_editable_in_form());
    match &fieldid_str {
        Some(fieldid_str) => empty_tag(
            w,
            "hp:fieldBegin",
            &[
                ("id", &id_str),
                ("type", ft),
                ("name", field.ctrl_data_name.as_deref().unwrap_or("")),
                ("editable", editable_str),
                ("fieldid", fieldid_str),
            ],
        ),
        None => empty_tag(
            w,
            "hp:fieldBegin",
            &[
                ("id", &id_str),
                ("type", ft),
                ("name", field.ctrl_data_name.as_deref().unwrap_or("")),
                ("editable", editable_str),
            ],
        ),
    }
}

/// `<hp:fieldEnd>` — 필드 끝 마커.
pub fn write_field_end<W: Write>(w: &mut Writer<W>, field_id: u32) -> Result<(), SerializeError> {
    let id_str = field_id.to_string();
    empty_tag(w, "hp:fieldEnd", &[("beginIDRef", &id_str)])
}

/// `<hp:fieldEnd beginIDRef=".." fieldid="..">` — beginIDRef 와 fieldid 동시 방출.
/// 다단락 필드의 고아 fieldEnd 복원용 (Task #1556). `field_id == 0` 이면 `fieldid` 생략.
pub fn write_field_end_full<W: Write>(
    w: &mut Writer<W>,
    begin_id_ref: u32,
    field_id: u32,
) -> Result<(), SerializeError> {
    let begin_str = begin_id_ref.to_string();
    if field_id == 0 {
        return empty_tag(w, "hp:fieldEnd", &[("beginIDRef", &begin_str)]);
    }
    let field_str = field_id.to_string();
    empty_tag(
        w,
        "hp:fieldEnd",
        &[("beginIDRef", &begin_str), ("fieldid", &field_str)],
    )
}

// =====================================================================
// 하이퍼링크 (필드의 특수형) — <hp:fieldBegin type="HYPERLINK"> 변형
// =====================================================================

#[allow(dead_code)]
pub fn write_hyperlink_begin<W: Write>(
    w: &mut Writer<W>,
    link: &Hyperlink,
    field_id: u32,
) -> Result<(), SerializeError> {
    // [#2957 계열] HWPX 스키마는 `<hp:fieldBegin>` 에 `command` 속성을 정의하지 않는다.
    // URL 은 파서(parse_field_parameters)가 읽는 대로 `<hp:parameters>` 자식의
    // `<hp:stringParam name="Command">` 텍스트로 담아야 한다. 종전엔 존재하지 않는
    // `command` 속성으로 방출해, 파서가 이를 무시(알 수 없는 속성)하여 저장 후 재로드 시
    // 하이퍼링크 URL 이 조용히 소실됐다.
    let id_str = field_id.to_string();
    start_tag_attrs(
        w,
        "hp:fieldBegin",
        &[
            ("id", &id_str),
            ("type", "HYPERLINK"),
            ("name", ""),
            ("editable", "0"),
        ],
    )?;
    start_tag(w, "hp:parameters")?;
    start_tag_attrs(w, "hp:stringParam", &[("name", "Command")])?;
    text(w, &link.url)?;
    end_tag(w, "hp:stringParam")?;
    end_tag(w, "hp:parameters")?;
    end_tag(w, "hp:fieldBegin")
}

// =====================================================================
// 각주 / 미주 뼈대 — <hp:fn> / <hp:en>
// =====================================================================

/// `<hp:fn>` 각주 뼈대 (내부 문단 직렬화는 #186 에서 연결).
#[allow(dead_code)]
pub fn write_footnote_open<W: Write>(w: &mut Writer<W>, number: u16) -> Result<(), SerializeError> {
    let n = number.to_string();
    start_tag(w, "hp:fn")?;
    empty_tag(w, "hp:autoNum", &[("num", &n)])?;
    Ok(())
}

#[allow(dead_code)]
pub fn write_footnote_close<W: Write>(w: &mut Writer<W>) -> Result<(), SerializeError> {
    end_tag(w, "hp:fn")
}

#[allow(dead_code)]
pub fn write_endnote_open<W: Write>(w: &mut Writer<W>, number: u16) -> Result<(), SerializeError> {
    let n = number.to_string();
    start_tag(w, "hp:en")?;
    empty_tag(w, "hp:autoNum", &[("num", &n)])?;
    Ok(())
}

#[allow(dead_code)]
pub fn write_endnote_close<W: Write>(w: &mut Writer<W>) -> Result<(), SerializeError> {
    end_tag(w, "hp:en")
}

// =====================================================================
// 헬퍼
// =====================================================================

fn bool01(b: bool) -> &'static str {
    if b {
        "1"
    } else {
        "0"
    }
}

fn field_type_str(t: FieldType) -> &'static str {
    use FieldType::*;
    match t {
        Unknown => "UNKNOWN",
        Date => "DATE",
        DocDate => "DOC_DATE",
        Path => "PATH",
        Bookmark => "BOOKMARK",
        MailMerge => "MAILMERGE",
        CrossRef => "CROSSREF",
        Formula => "FORMULA",
        ClickHere => "CLICK_HERE",
        Summary => "SUMMERY", // OWPML 스키마의 실제 표기(한컴 오탈자). schema.xml:2707
        UserInfo => "USER_INFO",
        Hyperlink => "HYPERLINK",
        Memo => "MEMO",
        PrivateInfoSecurity => "PRIVATE_INFO",
        // 한컴 저장본 표기 (파서는 TABLE_OF_CONTENTS 도 받는다).
        TableOfContents => "TABLEOFCONTENTS",
    }
}


//! HWPX(ZIP+XML) 직렬화 모듈 — `parser::hwpx`의 역방향.
//!
//! ## 단계 (#182)
//! - Stage 0 (완료): 기반 공사 — SerializeContext, IrDiff 하네스, canonical_defaults
//! - Stage 1: header.xml IR 기반 동적 생성
//! - Stage 2: section.xml 동적화 + charPrIDRef 매핑
//! - Stage 3: 표(Table)
//! - Stage 4: 그림(Picture) + BinData
//! - Stage 5: 도형·필드 + 대형 실문서 스모크

pub mod canonical_defaults;
pub mod content;
pub mod context;
pub mod field;
pub mod fixtures;
pub mod form;
pub mod header;
pub mod master_page;
pub mod package_check;
pub mod picture;
pub mod roundtrip;
pub mod section;
pub mod shape;
pub mod static_assets;
pub mod table;
pub mod utils;
mod version_metadata;
pub mod writer;

use std::collections::HashSet;

use crate::model::bin_data::BinDataBytes;
use crate::model::document::{
    hwpx_raw_fields, Document, HWP5_ORIGIN_HWPX_MARKER_PATH, OWN_LINE_LAYOUT_HWPX_MARKER_PATH,
    RAW_FIELDS_HWPX_PATH,
};

use super::SerializeError;
use content::BinDataEntry as ContentBinDataEntry;
use context::SerializeContext;
use writer::HwpxZipWriter;

fn write_bounded_binary_entry(
    writer: &mut HwpxZipWriter,
    href: &str,
    data: &BinDataBytes,
    label: &str,
) -> Result<(), SerializeError> {
    let member_limit = writer.remaining_entry_limit(href)?;
    let bytes = data.load_limited_payload(member_limit).ok_or_else(|| {
        SerializeError::ZipError(format!(
            "{label} entry could not be materialized within HWPX limits: {href}"
        ))
    })?;
    writer.write_media(href, bytes.as_ref())
}

/// Document IR을 HWPX(ZIP+XML) 바이트로 직렬화한다.
///
/// Stage 0 이후: 빈 문서 특수 분기를 제거하고 **항상 동적 경로**를 탄다.
/// `SerializeContext`가 1-pass 스캔으로 ID 풀을 구성하고, 각 writer가 동일 컨텍스트를
/// 참조한다. 직렬화 종료 시 `assert_all_refs_resolved()`가 미등록 참조를 단언한다.
pub fn serialize_hwpx(doc: &Document) -> Result<Vec<u8>, SerializeError> {
    use static_assets::*;

    // 1-pass: ID 풀 구성
    let mut ctx = SerializeContext::collect_from_document(doc);

    let mut z = HwpxZipWriter::new();
    let mut raw_fields = hwpx_raw_fields::Metadata::new();

    // 1. mimetype (반드시 최초 엔트리, STORED, extra field 없음)
    z.write_stored("mimetype", b"application/hwp+zip")?;

    // HwpUnitChar switches require XML >= 1.4. Preserve producer/platform
    // metadata, but do not label regenerated modern units as legacy XML.
    let version_xml = version_metadata::for_regenerated_hwpx(
        doc.hwpx_aux_entry("version.xml")
            .unwrap_or_else(|| VERSION_XML.as_bytes()),
    );
    z.write_deflated("version.xml", version_xml.as_ref())?;

    // 3. Contents/header.xml — Stage 1 동적 생성 (IR 기반)
    let header_limit = z.remaining_entry_limit("Contents/header.xml")?;
    let header_xml = header::write_header_limited(doc, &ctx, header_limit)?;
    let header_text =
        std::str::from_utf8(&header_xml).map_err(|e| SerializeError::XmlError(e.to_string()))?;
    raw_fields
        .capture_strokes(&doc.doc_info, header_text)
        .ok_or_else(|| {
            SerializeError::XmlError(
                "HWPX raw stroke metadata could not be bound to header XML".into(),
            )
        })?;
    z.write_deflated("Contents/header.xml", &header_xml)?;

    // 4. Contents/section{N}.xml — 실제 섹션만큼, 없으면 0개
    let section_hrefs: Vec<String> = (0..doc.sections.len())
        .map(|i| format!("Contents/section{}.xml", i))
        .collect();
    for (i, sec) in doc.sections.iter().enumerate() {
        let section_limit = z.remaining_entry_limit(&section_hrefs[i])?;
        let xml = section::write_section_limited(sec, doc, i, &mut ctx, section_limit)?;
        let text =
            std::str::from_utf8(&xml).map_err(|e| SerializeError::XmlError(e.to_string()))?;
        let clean = raw_fields
            .capture_part(&section_hrefs[i], text)
            .ok_or_else(|| {
                SerializeError::XmlError(
                    "HWPX raw tab metadata could not be bound to section XML".into(),
                )
            })?;
        z.write_deflated(&section_hrefs[i], clean.as_bytes())?;
    }

    // 4b. Contents/masterpage{N}.xml — 바탕쪽 (전 섹션 누적 전역 인덱스).
    //     id/href 의 인덱스는 section.rs 의 idRef 인덱스와 동일 규칙(전역 누적)이라
    //     별도 공유 상태 없이 정합한다.
    let mut master_items: Vec<(String, String)> = Vec::new();
    let mut mp_global = 0usize;
    for sec in &doc.sections {
        for mp in &sec.section_def.master_pages {
            let id = format!("masterpage{}", mp_global);
            let href = format!("Contents/masterpage{}.xml", mp_global);
            let master_limit = z.remaining_entry_limit(&href)?;
            let xml = master_page::render_master_page_xml_limited(mp, &id, &mut ctx, master_limit)?;
            let clean = raw_fields.capture_part(&href, &xml).ok_or_else(|| {
                SerializeError::XmlError(
                    "HWPX raw tab metadata could not be bound to master page XML".into(),
                )
            })?;
            z.write_deflated(&href, clean.as_bytes())?;
            master_items.push((id, href));
            mp_global += 1;
        }
    }

    // 5. Preview/PrvText.txt + Preview/PrvImage.png — 원본 보존 우선.
    //    하드코딩 상수는 빈/placeholder 미리보기라 원본 썸네일·미리보기 텍스트를
    //    잃는다. 보조 엔트리가 있으면 원본을 그대로 출력한다.
    z.write_deflated(
        "Preview/PrvText.txt",
        doc.hwpx_aux_entry("Preview/PrvText.txt")
            .unwrap_or(PRV_TEXT),
    )?;
    z.write_media(
        "Preview/PrvImage.png",
        doc.hwpx_aux_entry("Preview/PrvImage.png")
            .unwrap_or(PRV_IMAGE_PNG),
    )?;

    // 6. settings.xml — 원본 보존 우선.
    //    하드코딩 상수는 PrintInfo(확대/인쇄 설정) 등을 빠뜨린다.
    z.write_deflated(
        "settings.xml",
        doc.hwpx_aux_entry("settings.xml")
            .unwrap_or_else(|| SETTINGS_XML.as_bytes()),
    )?;

    if let Some(bytes) = crate::model::hyperlink_format::encode(doc) {
        z.write_deflated(crate::model::hyperlink_format::HWPX_ENTRY, &bytes)?;
    }
    let raw_bytes = raw_fields.encode().ok_or_else(|| {
        SerializeError::XmlError("HWPX raw field metadata exceeds validation or size limits".into())
    })?;
    z.write_deflated(RAW_FIELDS_HWPX_PATH, &raw_bytes)?;

    // 7. META-INF/container.rdf — header + every section part.
    // Hancom uses this RDF graph alongside content.hpf; a stale one-section
    // RDF makes multi-section documents fail to open even when the ZIP and
    // content.hpf contain every section.
    let rdf_limit = z.remaining_entry_limit("META-INF/container.rdf")?;
    let container_rdf = write_container_rdf_limited(&section_hrefs, rdf_limit)?;
    z.write_deflated("META-INF/container.rdf", &container_rdf)?;

    // 8. BinData ZIP 엔트리 (Stage 4)
    //    `ctx.bin_data_map` 의 엔트리 순서대로 실제 바이너리를 ZIP에 추가.
    //    3-way 단언(binaryItemIDRef ↔ manifest ↔ ZIP entry) 의 1차 출력 지점.
    let bin_entries = ctx.bin_data_entries();
    let mut zip_bin_entries: HashSet<String> = HashSet::new();
    for entry in &bin_entries {
        // 외부 참조(isEmbeded=0)는 ZIP 엔트리가 없다 — manifest 항목만 방출 (#1891).
        if !entry.is_embedded {
            continue;
        }
        let data = doc
            .bin_data_content
            .iter()
            .find(|b| b.id == entry.bin_data_id)
            .ok_or_else(|| {
                SerializeError::XmlError(format!(
                    "BinDataContent 누락: bin_data_id={}",
                    entry.bin_data_id
                ))
            })?;
        write_bounded_binary_entry(&mut z, &entry.href, &data.data, "BinData")?;
        zip_bin_entries.insert(entry.href.clone());
    }

    // HWPX-native OOXML charts are package parts, not BinData.  The parser's
    // 60000+N ID exists only so the renderer can locate chart XML in the IR.
    let mut chart_entries = HashSet::new();
    for chart in doc
        .bin_data_content
        .iter()
        .filter(|entry| entry.extension == "ooxml_chart" && entry.id > 60000)
    {
        let href = format!("Chart/chart{}.xml", chart.id - 60000);
        if !chart_entries.insert(href.clone()) {
            return Err(SerializeError::XmlError(format!(
                "duplicate HWPX chart part: {href}"
            )));
        }
        write_bounded_binary_entry(&mut z, &href, &chart.data, "chart")?;
    }

    // Preserve safe, unmodeled package entries (Scripts/* and vendor extension
    // parts among them).  Regenerated/modelled entries are excluded to avoid
    // duplicate ZIP names and stale core XML.
    let mut generated_entries: HashSet<String> = [
        "mimetype",
        "version.xml",
        "settings.xml",
        "Preview/PrvText.txt",
        "Preview/PrvImage.png",
        "Contents/header.xml",
        "Contents/content.hpf",
        "META-INF/container.rdf",
        "META-INF/container.xml",
        "META-INF/manifest.xml",
        HWP5_ORIGIN_HWPX_MARKER_PATH,
        OWN_LINE_LAYOUT_HWPX_MARKER_PATH,
        RAW_FIELDS_HWPX_PATH,
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    generated_entries.insert(crate::model::hyperlink_format::HWPX_ENTRY.to_string());
    generated_entries.extend(section_hrefs.iter().cloned());
    generated_entries.extend(master_items.iter().map(|(_, href)| href.clone()));
    generated_entries.extend(
        bin_entries
            .iter()
            .filter(|entry| entry.is_embedded)
            .map(|entry| entry.href.clone()),
    );
    generated_entries.extend(chart_entries);

    let mut passthrough_hrefs = Vec::new();
    for (path, data) in &doc.hwpx_aux_entries {
        if generated_entries.contains(path) || !is_safe_passthrough_path(path) {
            continue;
        }
        if passthrough_hrefs.iter().any(|written| written == path) {
            continue;
        }
        z.write_deflated(path, data)?;
        passthrough_hrefs.push(path.clone());
    }

    // 9. Contents/content.hpf — 항상 동적 경로 + BinData 매니페스트 엔트리
    let content_bin_entries: Vec<ContentBinDataEntry> = bin_entries
        .iter()
        .map(|e| ContentBinDataEntry {
            id: e.manifest_id.clone(),
            href: e.href.clone(),
            media_type: e.media_type.clone(),
            is_embedded: e.is_embedded,
        })
        .collect();
    let content_limit = z.remaining_entry_limit("Contents/content.hpf")?;
    let content_hpf = content::write_content_hpf_limited(
        &section_hrefs,
        &content_bin_entries,
        &master_items,
        &passthrough_hrefs,
        doc.hwpx_aux_entry("Contents/content.hpf"),
        content_limit,
    )?;
    z.write_deflated("Contents/content.hpf", &content_hpf)?;

    // 10. META-INF/container.xml
    z.write_deflated("META-INF/container.xml", META_INF_CONTAINER_XML.as_bytes())?;

    // 11. META-INF/manifest.xml
    z.write_deflated("META-INF/manifest.xml", META_INF_MANIFEST_XML.as_bytes())?;

    // HWP5-origin HWPX marker — HWP5에서 HWPX로 export한 산출물은 HWPX 컨테이너라도
    // lineSeg 부재/pagination 시멘틱을 HWP5 원본처럼 해석해야 자기정합한다.
    if let Some(marker) = doc.hwpx_aux_entry(HWP5_ORIGIN_HWPX_MARKER_PATH) {
        z.write_deflated(HWP5_ORIGIN_HWPX_MARKER_PATH, marker)?;
    } else if doc.provenance.own_line_layout {
        // 세션에서 계산한 줄은 구현 태그 없이 보존하고, 조판 출처만 따로 저장한다.
        // 보조 엔트리의 오래된 마커 대신 현재 provenance를 기준으로 한 번만 방출한다.
        z.write_deflated(OWN_LINE_LAYOUT_HWPX_MARKER_PATH, b"1")?;
    }

    // 참조 정합성 단언 (Stage 1+)
    ctx.assert_all_refs_resolved()?;

    // 3-way BinData 단언 (Stage 4):
    //   - ctx.bin_data_map 의 manifest_id/href 집합
    //   - content.hpf opf:item (위에서 content_bin_entries 로 생성됨, 집합 동일)
    //   - ZIP entry (위에서 zip_bin_entries 로 기록됨)
    // 세 집합이 동일해야 한컴이 바인딩 오류 없이 그림을 표시함.
    assert_bin_data_3way(&bin_entries, &zip_bin_entries)?;

    z.finish()
}

fn is_safe_passthrough_path(path: &str) -> bool {
    !path.is_empty()
        && !path.ends_with('/')
        && !path.starts_with('/')
        && !path.contains('\\')
        && path
            .split('/')
            .all(|component| !component.is_empty() && component != "." && component != "..")
}

fn write_container_rdf_limited(
    section_hrefs: &[String],
    max_bytes: usize,
) -> Result<Vec<u8>, SerializeError> {
    const PKG_NS: &str = "http://www.hancom.co.kr/hwpml/2016/meta/pkg#";

    let mut out = utils::BoundedXmlBuffer::new(max_bytes);
    let mut append = |value: &str| {
        std::io::Write::write_all(&mut out, value.as_bytes())
            .map_err(|error| SerializeError::XmlError(format!("container.rdf: {error}")))
    };
    append(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>"#)?;
    append(r#"<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">"#)?;
    append(r#"<rdf:Description rdf:about="">"#)?;
    append(&format!(
        r#"<ns0:hasPart xmlns:ns0="{PKG_NS}" rdf:resource="Contents/header.xml"/>"#
    ))?;
    append(r#"</rdf:Description>"#)?;
    append(r#"<rdf:Description rdf:about="Contents/header.xml">"#)?;
    append(&format!(r#"<rdf:type rdf:resource="{PKG_NS}HeaderFile"/>"#))?;
    append(r#"</rdf:Description>"#)?;

    for href in section_hrefs {
        append(r#"<rdf:Description rdf:about="">"#)?;
        append(&format!(
            r#"<ns0:hasPart xmlns:ns0="{PKG_NS}" rdf:resource="{href}"/>"#
        ))?;
        append(r#"</rdf:Description>"#)?;
        append(&format!(r#"<rdf:Description rdf:about="{href}">"#))?;
        append(&format!(
            r#"<rdf:type rdf:resource="{PKG_NS}SectionFile"/>"#
        ))?;
        append(r#"</rdf:Description>"#)?;
    }

    append(r#"<rdf:Description rdf:about="">"#)?;
    append(&format!(r#"<rdf:type rdf:resource="{PKG_NS}Document"/>"#))?;
    append(r#"</rdf:Description>"#)?;
    append(r#"</rdf:RDF>"#)?;
    drop(append);
    Ok(out.into_inner())
}

/// 3-way BinData 동기화 단언: `ctx.bin_data_entries()`, content.hpf manifest,
/// ZIP entry 의 href 집합이 모두 일치하는지 확인.
/// 외부 참조(isEmbeded=0) 항목은 ZIP 엔트리가 없는 것이 정상이므로 제외한다 (#1891).
fn assert_bin_data_3way(
    bin_entries: &[context::BinDataEntry],
    zip_entries: &HashSet<String>,
) -> Result<(), SerializeError> {
    let ctx_hrefs: HashSet<String> = bin_entries
        .iter()
        .filter(|e| e.is_embedded)
        .map(|e| e.href.clone())
        .collect();
    if ctx_hrefs != *zip_entries {
        let missing_zip: Vec<_> = ctx_hrefs.difference(zip_entries).cloned().collect();
        let orphan_zip: Vec<_> = zip_entries.difference(&ctx_hrefs).cloned().collect();
        return Err(SerializeError::XmlError(format!(
            "3-way BinData 불일치: ctx(href) vs zip_entries — ctx에만 있음: {:?}, zip에만 있음: {:?}",
            missing_zip, orphan_zip
        )));
    }
    Ok(())
}


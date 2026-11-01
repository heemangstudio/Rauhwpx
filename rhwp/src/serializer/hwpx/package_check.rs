//! 재조립 HWPX 패키지(ZIP) 구조 검증 (Task #1315).
//!
//! `serialize_hwpx()` 산출 바이트가 한컴/OPF 패키지 규약을 지키는지 IR 대비 검사한다.
//!
//! 검사 항목:
//! 1. ZIP 아카이브로 열림
//! 2. `mimetype` — 최초 엔트리, STORED, 내용 `application/hwp+zip`
//! 3. 필수 엔트리 존재 (version.xml, header.xml, content.hpf, Preview, settings,
//!    META-INF/container.xml·container.rdf·manifest.xml)
//! 4. `Contents/section{N}.xml` 엔트리 수 = IR 섹션 수 (잉여 섹션 엔트리 금지)
//! 5. `Contents/content.hpf` manifest 가 참조하는 href 가 모두 ZIP 에 실재
//! 6. `Contents/masterpage{N}.xml` 엔트리·manifest·section idRef = IR 바탕쪽 보존
//! 7. `BinData/` 엔트리 수·확장자 멀티셋 = IR `bin_data_content` 보존
//!
//! 주의: serializer 가 BinData href 를 `BinData/image{N}.{ext}` 로 재명명하므로
//! 원본 ZIP 의 엔트리 **이름**이 아니라 IR 기준 **수·확장자**를 보존 기준으로 삼는다.

use std::collections::HashSet;
use std::io::{Cursor, Read};

use crate::model::document::Document;

/// HWPX mimetype 고정 내용.
const HWPX_MIMETYPE: &[u8] = b"application/hwp+zip";

/// 섹션 수와 무관하게 항상 있어야 하는 엔트리.
const REQUIRED_ENTRIES: [&str; 9] = [
    "version.xml",
    "Contents/header.xml",
    "Contents/content.hpf",
    "Preview/PrvText.txt",
    "Preview/PrvImage.png",
    "settings.xml",
    "META-INF/container.xml",
    "META-INF/container.rdf",
    "META-INF/manifest.xml",
];

/// 패키지 검사 결과 — 발견된 문제 목록.
#[derive(Debug, Default)]
pub struct PackageCheckReport {
    pub problems: Vec<String>,
}

impl PackageCheckReport {
    pub fn is_ok(&self) -> bool {
        self.problems.is_empty()
    }

    pub fn summary(&self) -> String {
        self.problems.join("; ")
    }

    fn push(&mut self, problem: String) {
        self.problems.push(problem);
    }
}

/// 재조립 HWPX 바이트를 IR(`doc`) 기준으로 패키지 구조 검사한다.
///
/// `doc` 은 직렬화에 입력한 Document (원본 파싱 결과)여야 한다.
pub fn check_package(hwpx_bytes: &[u8], doc: &Document) -> PackageCheckReport {
    let mut report = PackageCheckReport::default();

    let mut archive = match zip::ZipArchive::new(Cursor::new(hwpx_bytes)) {
        Ok(a) => a,
        Err(e) => {
            report.push(format!("ZIP 열기 실패: {e}"));
            return report;
        }
    };

    let names: HashSet<String> = match archive
        .file_names()
        .map(|name| name.map(|name| name.into_owned()))
        .collect::<Result<_, _>>()
    {
        Ok(names) => names,
        Err(error) => {
            report.push(format!("ZIP 엔트리 이름 읽기 실패: {error}"));
            return report;
        }
    };

    // 2. mimetype — 최초 엔트리 + STORED + 내용 일치
    match archive.by_index(0) {
        Ok(mut first) => {
            let first_name = match first.name() {
                Ok(name) => name.into_owned(),
                Err(error) => {
                    report.push(format!("첫 엔트리 이름 읽기 실패: {error}"));
                    String::new()
                }
            };
            if first_name != "mimetype" {
                report.push(format!(
                    "mimetype 이 최초 엔트리가 아님 (첫 엔트리: {first_name})"
                ));
            } else {
                if first.compression() != zip::CompressionMethod::Stored {
                    report.push(format!(
                        "mimetype 압축 방식이 STORED 가 아님: {:?}",
                        first.compression()
                    ));
                }
                let mut content = Vec::new();
                if first.read_to_end(&mut content).is_ok() {
                    if content != HWPX_MIMETYPE {
                        report.push(format!(
                            "mimetype 내용 불일치: {:?}",
                            String::from_utf8_lossy(&content)
                        ));
                    }
                } else {
                    report.push("mimetype 읽기 실패".to_string());
                }
            }
        }
        Err(e) => report.push(format!("첫 엔트리 접근 실패: {e}")),
    }

    // 3. 필수 엔트리
    for required in REQUIRED_ENTRIES {
        if !names.contains(required) {
            report.push(format!("필수 엔트리 누락: {required}"));
        }
    }

    // 4. 섹션 엔트리 수 = IR 섹션 수
    for i in 0..doc.sections.len() {
        let entry = format!("Contents/section{i}.xml");
        if !names.contains(&entry) {
            report.push(format!("섹션 엔트리 누락: {entry} (IR 섹션 {i})"));
        }
    }
    let section_entry_count = names.iter().filter(|n| is_section_entry_name(n)).count();
    if section_entry_count != doc.sections.len() {
        report.push(format!(
            "섹션 엔트리 수 불일치: zip={} ir={}",
            section_entry_count,
            doc.sections.len()
        ));
    }

    // 5. content.hpf manifest href 실재 확인
    let content_hpf = match read_entry_string(&mut archive, "Contents/content.hpf") {
        Ok(hpf) => {
            for href in extract_hrefs(&hpf) {
                if !names.contains(href.as_str()) {
                    report.push(format!("content.hpf 참조 엔트리 누락: {href}"));
                }
            }
            Some(hpf)
        }
        Err(e) => {
            // 필수 엔트리 검사에서 이미 누락 보고됐을 수 있으므로 읽기 실패만 기록
            if names.contains("Contents/content.hpf") {
                report.push(format!("content.hpf 읽기 실패: {e}"));
            }
            None
        }
    };

    // 5b. container.rdf section graph coverage.
    // Hancom checks this package graph separately from content.hpf; stale RDF
    // can make otherwise ZIP-valid multi-section HWPX exports fail to open.
    match read_entry_string(&mut archive, "META-INF/container.rdf") {
        Ok(rdf) => check_container_rdf(&mut report, &rdf, doc),
        Err(e) => {
            if names.contains("META-INF/container.rdf") {
                report.push(format!("container.rdf 읽기 실패: {e}"));
            }
        }
    }

    // 6. 바탕쪽(masterpage) 엔트리·manifest·section idRef 보존.
    check_master_pages(
        &mut report,
        &mut archive,
        &names,
        content_hpf.as_deref(),
        doc,
    );

    // 7. BinData 수·확장자 보존 (IR 기준)
    let zip_bin: Vec<&String> = names.iter().filter(|n| n.starts_with("BinData/")).collect();
    let ir_bin_data: Vec<_> = doc
        .bin_data_content
        .iter()
        .filter(|entry| entry.extension != "ooxml_chart" && !entry.is_position_placeholder())
        .collect();
    if zip_bin.len() != ir_bin_data.len() {
        report.push(format!(
            "BinData 엔트리 수 불일치: zip={} ir={}",
            zip_bin.len(),
            ir_bin_data.len()
        ));
    } else {
        let mut zip_exts: Vec<String> = zip_bin.iter().map(|n| extension_lower(n)).collect();
        let mut ir_exts: Vec<String> = ir_bin_data
            .iter()
            .map(|b| b.extension.to_ascii_lowercase())
            .collect();
        zip_exts.sort();
        ir_exts.sort();
        if zip_exts != ir_exts {
            report.push(format!(
                "BinData 확장자 멀티셋 불일치: zip={:?} ir={:?}",
                zip_exts, ir_exts
            ));
        }
    }

    report
}

/// `Contents/section{숫자}.xml` 형태인지 확인.
fn is_section_entry_name(name: &str) -> bool {
    name.strip_prefix("Contents/section")
        .and_then(|rest| rest.strip_suffix(".xml"))
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

/// `Contents/masterpage{숫자}.xml` 형태인지 확인.
fn is_master_page_entry_name(name: &str) -> bool {
    name.strip_prefix("Contents/masterpage")
        .and_then(|rest| rest.strip_suffix(".xml"))
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

fn check_master_pages(
    report: &mut PackageCheckReport,
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    names: &HashSet<String>,
    content_hpf: Option<&str>,
    doc: &Document,
) {
    let expected_count: usize = doc
        .sections
        .iter()
        .map(|section| section.section_def.master_pages.len())
        .sum();
    let zip_count = names
        .iter()
        .filter(|n| is_master_page_entry_name(n))
        .count();
    if zip_count != expected_count {
        report.push(format!(
            "바탕쪽 엔트리 수 불일치: zip={} ir={}",
            zip_count, expected_count
        ));
    }

    let mut global = 0usize;
    for (section_idx, section) in doc.sections.iter().enumerate() {
        let section_master_count = section.section_def.master_pages.len();
        let ids: Vec<String> = (0..section_master_count)
            .map(|offset| format!("masterpage{}", global + offset))
            .collect();

        for id in &ids {
            let href = format!("Contents/{id}.xml");
            if !names.contains(&href) {
                report.push(format!("바탕쪽 엔트리 누락: {href}"));
            }
            if let Some(hpf) = content_hpf {
                if !hpf.contains(&format!(r#"id="{id}""#))
                    || !hpf.contains(&format!(r#"href="{href}""#))
                {
                    report.push(format!("content.hpf 바탕쪽 manifest 누락: {id} -> {href}"));
                }
            }
        }

        if section_master_count > 0 {
            let section_href = format!("Contents/section{section_idx}.xml");
            match read_entry_string(archive, &section_href) {
                Ok(section_xml) => {
                    let expected_cnt = format!(r#"masterPageCnt="{section_master_count}""#);
                    if !section_xml.contains(&expected_cnt) {
                        report.push(format!(
                            "section{section_idx} masterPageCnt 불일치: expected {section_master_count}"
                        ));
                    }
                    for id in &ids {
                        let expected_ref = format!(r#"idRef="{id}""#);
                        if !section_xml.contains(&expected_ref) {
                            report.push(format!("section{section_idx} 바탕쪽 idRef 누락: {id}"));
                        }
                    }
                }
                Err(e) => {
                    if names.contains(&section_href) {
                        report.push(format!("{section_href} 읽기 실패: {e}"));
                    }
                }
            }
        }

        global += section_master_count;
    }
}

fn check_container_rdf(report: &mut PackageCheckReport, rdf: &str, doc: &Document) {
    if !rdf.contains(r#"rdf:resource="Contents/header.xml""#)
        || !rdf.contains(r#"rdf:about="Contents/header.xml""#)
    {
        report.push("container.rdf header 참조 누락".to_string());
    }

    for i in 0..doc.sections.len() {
        let href = format!("Contents/section{i}.xml");
        if !rdf.contains(&format!(r#"rdf:resource="{href}""#))
            || !rdf.contains(&format!(r#"rdf:about="{href}""#))
        {
            report.push(format!("container.rdf 섹션 참조 누락: {href}"));
        }
    }

    let rdf_section_count = extract_rdf_resources(rdf)
        .iter()
        .filter(|href| is_section_entry_name(href))
        .count();
    if rdf_section_count != doc.sections.len() {
        report.push(format!(
            "container.rdf 섹션 참조 수 불일치: rdf={} ir={}",
            rdf_section_count,
            doc.sections.len()
        ));
    }
}

/// ZIP 엔트리를 문자열로 읽는다.
fn read_entry_string(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    name: &str,
) -> Result<String, String> {
    let mut entry = archive.by_name(name).map_err(|e| e.to_string())?;
    let mut s = String::new();
    entry.read_to_string(&mut s).map_err(|e| e.to_string())?;
    Ok(s)
}

/// XML 텍스트에서 `href="..."` 값을 단순 스캔으로 추출한다.
///
/// content.hpf 는 자체 writer 산출물이므로 따옴표 이스케이프 변형이 없다.
fn extract_hrefs(xml: &str) -> Vec<String> {
    // [#1891] isEmbeded="0"(외부 파일 참조) 항목의 href 는 ZIP 엔트리가 아니므로
    // 실재 검사 대상에서 제외한다. href/isEmbeded 속성 순서에 의존하지 않도록
    // 태그 단위로 스캔한다.
    let mut hrefs = Vec::new();
    let mut rest = xml;
    while let Some(pos) = rest.find('<') {
        rest = &rest[pos + 1..];
        let Some(end) = rest.find('>') else { break };
        let tag = &rest[..end];
        rest = &rest[end + 1..];
        if tag.contains("isEmbeded=\"0\"") {
            continue;
        }
        if let Some(hpos) = tag.find("href=\"") {
            let after = &tag[hpos + "href=\"".len()..];
            if let Some(hend) = after.find('"') {
                hrefs.push(after[..hend].to_string());
            }
        }
    }
    hrefs
}

fn extract_rdf_resources(xml: &str) -> Vec<String> {
    let mut resources = Vec::new();
    let mut rest = xml;
    while let Some(pos) = rest.find("rdf:resource=\"") {
        rest = &rest[pos + "rdf:resource=\"".len()..];
        if let Some(end) = rest.find('"') {
            resources.push(rest[..end].to_string());
            rest = &rest[end + 1..];
        } else {
            break;
        }
    }
    resources
}

/// 파일명에서 소문자 확장자 추출 (없으면 빈 문자열).
fn extension_lower(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default()
}


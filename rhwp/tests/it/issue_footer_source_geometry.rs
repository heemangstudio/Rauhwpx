//! 원본 아래 여백과 기존 페이지네이션 허용치를 분리한다.
//! 실문서 저장 기하와 합성 문서의 꼬리말/쪽 번호를 검사한다. 한컴 정합 증명은 아니다.

use rhwp::document_core::DocumentCore;
use rhwp::model::control::{Control, PageNumberPos};
use rhwp::model::document::Document;
use rhwp::model::page::{ColumnDef, PageDef};
use rhwp::model::paragraph::{CharShapeRef, Paragraph};
use rhwp::parser::{parse_document, parse_hwp_strict};
use rhwp::renderer::page_layout::PageLayoutInfo;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};
use rhwp::renderer::DEFAULT_DPI;
use rhwp::serializer::serialize_document;

const ADMITTED: &[(&str, u32)] = &[
    ("hwp3-sample-hwp5.hwp", 4252),
    ("hwp3-sample10-hwp5.hwp", 7088),
    ("hwp3-sample11-hwp5.hwp", 5668),
    ("hwp3-sample4-hwp5.hwp", 4252),
    ("hwp3-sample5-hwp5-v2018.hwp", 4252),
    ("hwp3-sample5-hwp5-v2024.hwp", 4252),
    ("hwp3-sample5-hwp5.hwp", 4252),
];

fn sample(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("samples")
        .join(name);
    std::fs::read(path).unwrap_or_else(|e| panic!("{name}: {e}"))
}

// 포맷에 기록되는 필드만 비교한다. 내부 tolerance는 저장 대상이 아니다.
fn source_geometry(page: &PageDef) -> ([u32; 10], bool, rhwp::model::page::BindingMethod) {
    (
        [
            page.width,
            page.height,
            page.margin_left,
            page.margin_right,
            page.margin_top,
            page.margin_bottom,
            page.margin_header,
            page.margin_footer,
            page.margin_gutter,
            page.attr,
        ],
        page.landscape,
        page.binding,
    )
}

fn assert_source_pages(doc: &Document, expected: &[PageDef], label: &str) {
    assert_eq!(doc.sections.len(), expected.len(), "{label}: sections");
    for (section, source) in doc.sections.iter().zip(expected) {
        assert_eq!(
            source_geometry(&section.section_def.page_def),
            source_geometry(source),
            "{label}: section PAGE_DEF"
        );
        for para in &section.paragraphs {
            for control in &para.controls {
                if let Control::SectionDef(def) = control {
                    assert_eq!(
                        source_geometry(&def.page_def),
                        source_geometry(source),
                        "{label}: embedded PAGE_DEF"
                    );
                }
            }
        }
    }
}

fn hwp5_source_pages(doc: &Document) -> Vec<PageDef> {
    doc.sections
        .iter()
        .map(|section| {
            let raw = section.raw_stream.as_ref().expect("HWP5 raw section");
            rhwp::parser::body_text::parse_body_text_section(raw)
                .expect("source BodyText")
                .section_def
                .page_def
        })
        .collect()
}

#[test]
fn seven_admitted_conversions_keep_raw_source_geometry_and_embedded_allowance() {
    for &(name, bottom) in ADMITTED {
        let doc = parse_document(&sample(name)).expect("public load");
        let source = hwp5_source_pages(&doc);
        assert!(!source.is_empty(), "{name}");
        assert!(doc.is_hwp3_variant && doc.provenance.hwp3_lineage, "{name}");
        assert_source_pages(&doc, &source, name);
        for section in &doc.sections {
            let page = &section.section_def.page_def;
            assert_eq!(page.margin_bottom, bottom, "{name}");
            assert_eq!(page.pagination_bottom_tolerance, 1600, "{name}");
            let embedded: Vec<_> = section
                .paragraphs
                .iter()
                .flat_map(|p| &p.controls)
                .filter_map(|c| match c {
                    Control::SectionDef(def) => Some(&def.page_def),
                    _ => None,
                })
                .collect();
            assert!(!embedded.is_empty(), "{name}: embedded SectionDef");
            for page in embedded {
                assert_eq!(page.pagination_bottom_tolerance, 1600, "{name}");
            }
        }
    }
}

#[test]
fn nonadmitted_legacy_conversion_keeps_source_without_allowance() {
    let doc = parse_document(&sample("hwp3-sample16-hwp5.hwp")).expect("sample16");
    assert!(doc.is_hwp3_variant && doc.provenance.hwp3_lineage);
    assert_source_pages(&doc, &hwp5_source_pages(&doc), "sample16");
    for section in &doc.sections {
        assert_eq!(section.section_def.page_def.margin_bottom, 2836);
        assert_eq!(section.section_def.page_def.pagination_bottom_tolerance, 0);
    }
}

#[test]
fn native_hwp3_bottom_matches_stored_docinfo_and_keeps_existing_path() {
    for name in [
        "hwp3-sample.hwp",
        "hwp3-sample16.hwp",
        "hwp3-pagedef-1915.hwp",
    ] {
        let bytes = sample(name);
        let source = rhwp::parser::hwp3::records::Hwp3DocInfo::read(&bytes[30..])
            .expect("source HWP3 DocInfo");
        let doc = parse_document(&bytes).expect("HWP3 public load");
        assert_eq!(
            doc.provenance.format,
            rhwp::model::provenance::SourceFormat::Hwp3
        );
        let page = &doc.sections[0].section_def.page_def;
        let bottom = u32::from(source.bottom_margin) * 4;
        assert_eq!(page.margin_bottom, bottom, "{name}");
        assert_eq!(page.pagination_bottom_tolerance, bottom.min(1600), "{name}");
    }
}

#[test]
fn raw_and_reconstructed_hwp5_saves_preserve_source_across_three_cycles() {
    let original = parse_document(&sample("hwp3-sample-hwp5.hwp")).expect("sample");
    let source = hwp5_source_pages(&original);
    for reconstruct in [false, true] {
        let mut doc = original.clone();
        for cycle in 0..3 {
            if reconstruct {
                for section in &mut doc.sections {
                    section.raw_stream = None;
                }
            }
            let saved = serialize_document(&doc).expect("HWP5 save");
            doc = parse_hwp_strict(&saved).expect("strict reload of generated CFB");
            assert_source_pages(
                &doc,
                &source,
                &format!("reconstruct={reconstruct} cycle={cycle}"),
            );
            assert_eq!(
                doc.sections[0]
                    .section_def
                    .page_def
                    .pagination_bottom_tolerance,
                1600
            );
        }
    }
}

// sample10은 그림을 포함하지 않고 이전 컴퓨터의 외부 파일 세 개를 참조한다
// (#1142/#1143). 원본 파일 대신 직접 만든 1px GIF/JPEG를 공개 주입 경로로 준비한다.
struct OwnedExternalImages {
    directory: std::path::PathBuf,
    gif: Vec<u8>,
    jpeg: Vec<u8>,
}

impl OwnedExternalImages {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "rhwp-footer-source-geometry-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("fixture timestamp")
                .as_nanos()
        ));
        std::fs::create_dir(&directory).expect("unique owned image directory");
        let mut fixture = Self {
            directory,
            // GIF87a: 1x1, 흑백 팔레트, clear/white/end LZW 코드.
            gif: vec![
                0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff,
                0xff, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 1, 0, 0x3b,
            ],
            jpeg: Vec::new(),
        };
        image::codecs::jpeg::JpegEncoder::new(&mut fixture.jpeg)
            .encode(&[255, 255, 255], 1, 1, image::ExtendedColorType::Rgb8)
            .expect("owned 1px JPEG");
        for name in ["oracle.gif", "rdb02.gif"] {
            std::fs::write(fixture.directory.join(name), &fixture.gif).expect("owned GIF");
        }
        std::fs::write(fixture.directory.join("s1.jpg"), &fixture.jpeg).expect("owned JPEG");
        fixture
    }

    fn assert_loaded(&self, document: &Document, label: &str) {
        assert_eq!(document.bin_data_content.len(), 3, "{label}: image count");
        for (id, extension, bytes) in [
            (1, "gif", self.gif.as_slice()),
            (2, "gif", self.gif.as_slice()),
            (3, "jpg", self.jpeg.as_slice()),
        ] {
            let content = document
                .bin_data_content
                .iter()
                .find(|content| content.id == id)
                .unwrap_or_else(|| panic!("{label}: owned image {id}"));
            assert_eq!(content.extension, extension, "{label}: image {id}");
            assert_eq!(content.data.load(), bytes, "{label}: image {id} bytes");
        }
    }
}

impl Drop for OwnedExternalImages {
    fn drop(&mut self) {
        // 재귀 삭제 없이 이 fixture가 만든 세 파일과 디렉터리만 정리한다.
        for name in ["oracle.gif", "rdb02.gif", "s1.jpg"] {
            let _ = std::fs::remove_file(self.directory.join(name));
        }
        let _ = std::fs::remove_dir(&self.directory);
    }
}

#[test]
fn public_hwpx_export_reload_does_not_accumulate_source_margin_changes() {
    let external_images = OwnedExternalImages::new();
    for name in ADMITTED
        .iter()
        .map(|&(name, _)| name)
        .chain(["hwp3-sample.hwp", "hwp3-pagedef-1915.hwp"])
    {
        let bytes = sample(name);
        let parsed = parse_document(&bytes).expect("source parse");
        let source = if parsed.provenance.format == rhwp::model::provenance::SourceFormat::Hwp5 {
            hwp5_source_pages(&parsed)
        } else {
            parsed
                .sections
                .iter()
                .map(|s| s.section_def.page_def.clone())
                .collect()
        };
        let mut core = DocumentCore::from_bytes(&bytes).expect("public load");
        if name == "hwp3-sample10-hwp5.hwp" {
            assert_eq!(core.document().doc_info.bin_data_list.len(), 3);
            assert!(core
                .document()
                .doc_info
                .bin_data_list
                .iter()
                .all(|entry| { entry.data_type == rhwp::model::bin_data::BinDataType::Link }));
            // 미해결 그림을 조용히 드롭하지 않는 기존 엄격한 저장 계약은 유지한다.
            let error = core
                .export_hwpx_native()
                .expect_err("missing external images must not be silently omitted")
                .to_string();
            assert!(
                error.contains("binaryItemIDRef")
                    && error.contains("bin_data_id=1")
                    && error.contains("BinDataContent"),
                "{name}: unresolved external image diagnostic: {error}"
            );
            assert_eq!(
                core.populate_external_images_from_dir(&external_images.directory),
                3,
                "all external dependencies must be supplied before geometry roundtrips"
            );
            external_images.assert_loaded(core.document(), name);
        }
        for cycle in 0..3 {
            assert_source_pages(core.document(), &source, name);
            let saved = core
                .export_hwpx_native()
                .unwrap_or_else(|e| panic!("{name}: cycle {cycle} public HWPX export: {e:?}"));
            core = DocumentCore::from_bytes(&saved).expect("public HWPX reload");
            assert_source_pages(core.document(), &source, name);
            if name == "hwp3-sample10-hwp5.hwp" {
                external_images.assert_loaded(core.document(), &format!("{name}: cycle {cycle}"));
            }
            // HWPX에 내부 허용치를 직렬화하거나 새로운 입장 조건을 만들지 않는다.
            for section in &core.document().sections {
                assert_eq!(
                    section.section_def.page_def.pagination_bottom_tolerance, 0,
                    "{name}"
                );
            }
        }
    }
}

fn synthetic_hwp(bottom: u32) -> Document {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().expect("blank");
    core.create_header_footer_native(0, false, 0)
        .expect("footer");
    core.insert_text_in_header_footer_native(0, false, 0, 0, 0, "footer")
        .expect("footer text");
    let mut doc = core.document().clone();
    // 템플릿의 사용하지 않는 스타일 수에 입장 조건이 좌우되지 않게 한다.
    doc.doc_info.para_shapes.truncate(1);
    doc.doc_info.char_shapes.truncate(1);
    doc.doc_info.styles.truncate(1);
    for style in &mut doc.doc_info.styles {
        style.para_shape_id = 0;
        style.char_shape_id = 0;
    }
    doc.doc_info.raw_stream = None;
    doc.doc_info.raw_stream_dirty = true;
    let section = &mut doc.sections[0];
    section.section_def.page_def.margin_bottom = bottom;
    section.section_def.page_def.pagination_bottom_tolerance = 0;
    // 첫 문단의 secd와 꼬리말은 유지하고 단순 본문으로 비율 조건을 만족시킨다.
    section.paragraphs.truncate(1);
    section.paragraphs[0].para_shape_id = 0;
    section.paragraphs[0].style_id = 0;
    section.paragraphs[0].char_shapes = vec![CharShapeRef::default()];
    section.paragraphs[0]
        .controls
        .push(Control::PageNumberPos(PageNumberPos {
            position: 5,
            ..Default::default()
        }));
    for control in &mut section.paragraphs[0].controls {
        if let Control::SectionDef(def) = control {
            def.page_def = section.section_def.page_def.clone();
        } else if let Control::Footer(footer) = control {
            for para in &mut footer.paragraphs {
                para.para_shape_id = 0;
                para.style_id = 0;
                para.char_shapes = vec![CharShapeRef::default()];
            }
        }
    }
    section.paragraphs.extend((1..100).map(|_| Paragraph {
        text: "body".into(),
        char_shapes: vec![CharShapeRef::default()],
        ..Default::default()
    }));
    section.raw_stream = None;
    // 실제 입장 조건에 들어가는지 확인한다.
    assert!(doc.doc_info.para_shapes.len() < 5);
    assert!(doc.doc_info.char_shapes.len() < 15);
    doc
}

#[test]
fn strict_and_public_load_clamp_small_bottoms_and_respect_origin_marker() {
    for bottom in [0, 700, 1600, 8503] {
        for excluded in [false, true] {
            let mut doc = synthetic_hwp(bottom);
            if excluded {
                doc.extra_streams.push((
                    rhwp::document_core::converters::hwpx_to_hwp::HWPX_ORIGIN_STREAM_PATH.into(),
                    b"1".to_vec(),
                ));
            }
            let bytes = serialize_document(&doc).expect("synthetic HWP");
            for loaded in [
                parse_hwp_strict(&bytes).unwrap(),
                parse_document(&bytes).unwrap(),
            ] {
                let page = &loaded.sections[0].section_def.page_def;
                assert_eq!(page.margin_bottom, bottom);
                assert_eq!(
                    page.pagination_bottom_tolerance,
                    if excluded { 0 } else { bottom.min(1600) }
                );
                assert_eq!(loaded.is_hwpx_variant, excluded);
                assert_source_pages(
                    &loaded,
                    &[doc.sections[0].section_def.page_def.clone()],
                    "synthetic",
                );
            }
        }
    }
}

fn text_y(node: &RenderNode, text: &str) -> Option<f64> {
    if let RenderNodeType::TextRun(run) = &node.node_type {
        if run.text == text {
            return Some(node.bbox.y);
        }
    }
    node.children.iter().find_map(|child| text_y(child, text))
}

fn set_page(doc: &mut Document, page: &PageDef) {
    doc.sections[0].section_def.page_def = page.clone();
    for para in &mut doc.sections[0].paragraphs {
        for control in &mut para.controls {
            if let Control::SectionDef(def) = control {
                def.page_def = page.clone();
            }
        }
    }
}

#[test]
fn rendered_footer_and_page_number_follow_source_while_plain_capacity_is_retained() {
    let original = synthetic_hwp(8503);
    let bytes = serialize_document(&original).expect("HWP save");
    let imported = parse_hwp_strict(&bytes).expect("HWP import");
    let source = &original.sections[0].section_def.page_def;
    let page = &imported.sections[0].section_def.page_def;
    assert_eq!(page.margin_bottom, source.margin_bottom);
    assert_eq!(page.pagination_bottom_tolerance, 1600);
    let columns = ColumnDef::default();
    let layout = PageLayoutInfo::from_page_def(page, &columns, DEFAULT_DPI);
    let source_layout = PageLayoutInfo::from_page_def(source, &columns, DEFAULT_DPI);
    assert_eq!(layout.footer_area.y, source_layout.footer_area.y);
    assert_eq!(layout.body_area.height, source_layout.body_area.height);

    let mut old_page = source.clone();
    old_page.margin_bottom = old_page.margin_bottom.saturating_sub(1600);
    let old_layout = PageLayoutInfo::from_page_def(&old_page, &columns, DEFAULT_DPI);
    assert!((layout.available_body_height() - old_layout.available_body_height()).abs() < 1e-8);

    let mut source_doc = imported.clone();
    set_page(&mut source_doc, source);
    let mut old_doc = imported.clone();
    set_page(&mut old_doc, &old_page);
    let render = |doc| {
        let mut core = DocumentCore::new_empty();
        core.set_document(doc);
        let pages = core.page_count();
        let tree = core.build_page_render_tree(0).expect("first page");
        (pages, tree)
    };
    let (new_count, new_tree) = render(imported);
    let (old_count, old_tree) = render(old_doc);
    let (_, source_tree) = render(source_doc);
    assert_eq!(new_count, old_count, "단순 본문 fit 용량 유지");
    for text in ["footer", "1"] {
        let new_y = text_y(&new_tree.root, text).expect("rendered footer/page number");
        let source_y = text_y(&source_tree.root, text).expect("source geometry text");
        let old_y = text_y(&old_tree.root, text).expect("old geometry text");
        assert!((new_y - source_y).abs() < 0.01, "{text}: source position");
        assert!(
            old_y > new_y + 10.0,
            "{text}: old margin mutation must move text"
        );
    }
}

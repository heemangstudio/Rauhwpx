//! 쪽 번호의 공통 기본값은 가져온 글자 모양과 독립적이며 작성된 스타일은 보존한다.
use rhwp::document_core::DocumentCore;
use rhwp::model::control::{Control, PageNumberPos};
use rhwp::model::document::{Document, Section};
use rhwp::model::paragraph::Paragraph;
use rhwp::model::provenance::{FontMetricsPolicy, SourceFormat};
use rhwp::model::style::{CharShape, Font, ParaShape, Style};
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};
use rhwp::renderer::TextStyle;

fn footer_style(
    policy: FontMetricsPolicy,
    named: Option<u16>,
    imported_zero_size: i32,
) -> TextStyle {
    footer_style_for_source(policy, named, imported_zero_size, SourceFormat::Hwpx, false)
}

fn footer_style_for_source(
    policy: FontMetricsPolicy,
    named: Option<u16>,
    imported_zero_size: i32,
    format: SourceFormat,
    hwp3_lineage: bool,
) -> TextStyle {
    let mut doc = Document::default();
    doc.provenance.format = format;
    doc.provenance.hwp3_lineage = hwp3_lineage;
    if format == SourceFormat::Hwp3 {
        doc.header.version.major = 3;
    }
    doc.doc_info.font_metrics_policy = policy;
    doc.doc_info.font_faces = vec![
        vec![
            Font {
                name: if imported_zero_size == 1_000 {
                    "Arial"
                } else {
                    "Times New Roman"
                }
                .into(),
                ..Default::default()
            },
            Font {
                name: "Arial".into(),
                ..Default::default()
            },
        ];
        7
    ];
    doc.doc_info.char_shapes = vec![
        CharShape {
            base_size: imported_zero_size,
            ratios: [100; 7],
            relative_sizes: [100; 7],
            ..Default::default()
        },
        CharShape {
            base_size: 1_800,
            font_ids: [1; 7],
            ratios: [100; 7],
            relative_sizes: [100; 7],
            ..Default::default()
        },
    ];
    doc.doc_info.para_shapes = vec![ParaShape::default()];
    if let Some(id) = named {
        doc.doc_info.styles.push(Style {
            english_name: "Page Number".into(),
            char_shape_id: id,
            ..Default::default()
        });
    }
    let mut section = Section::default();
    section.section_def.page_def = rhwp::model::page::PageDef::a4_default();
    section.paragraphs.push(Paragraph {
        controls: vec![Control::PageNumberPos(PageNumberPos {
            position: 5,
            ..Default::default()
        })],
        ..Default::default()
    });
    doc.sections.push(section);
    let mut core = DocumentCore::new_empty();
    core.set_document(doc);
    fn find(node: &RenderNode) -> Option<TextStyle> {
        if let RenderNodeType::TextRun(run) = &node.node_type {
            if run.text.contains('1') {
                return Some(run.style.clone());
            }
        }
        node.children.iter().find_map(find)
    }
    find(&core.build_page_render_tree(0).unwrap().root).expect("page number")
}

#[test]
fn missing_page_number_style_uses_shared_preset_without_imported_shape_zero() {
    for zero_size in [1_000, 2_300] {
        let mac = footer_style(FontMetricsPolicy::HcrDeclared, None, zero_size);
        assert_eq!(mac.font_family, "함초롬돋움");
        assert!((mac.font_size - 40.0 / 3.0).abs() < 1e-6);
        let windows = footer_style(FontMetricsPolicy::HancomWindows, None, zero_size);
        // main의 공통 10pt 기본값은 문서 플랫폼과 무관하게 HCR 돋움을 쓴다.
        assert_eq!(windows.font_family, "함초롬돋움");
        assert_eq!(windows.font_metrics_policy, FontMetricsPolicy::HcrDeclared);
    }
}

#[test]
fn authored_page_number_style_is_preserved_and_invalid_reference_uses_shared_preset() {
    for policy in [
        FontMetricsPolicy::HcrDeclared,
        FontMetricsPolicy::HancomWindows,
    ] {
        let explicit = footer_style(policy, Some(1), 2_300);
        assert!(explicit.font_family.starts_with("Arial"));
        assert_eq!(explicit.font_size, 24.0);
        assert_eq!(explicit.font_metrics_policy, policy);
        let invalid = footer_style(policy, Some(7), 2_300);
        assert_eq!(invalid.font_family, "함초롬돋움");
        assert_eq!(invalid.font_metrics_policy, FontMetricsPolicy::HcrDeclared);
    }
}

#[test]
fn hwp3_page_number_defaults_use_the_shared_preset() {
    for (format, lineage) in [(SourceFormat::Hwp3, false), (SourceFormat::Hwpx, true)] {
        let style =
            footer_style_for_source(FontMetricsPolicy::HcrDeclared, None, 2_300, format, lineage);
        assert_eq!(style.font_family, "함초롬돋움");
        assert!((style.font_size - 40.0 / 3.0).abs() < 1e-6);
    }
}

//! HWPX `OPTIONAL_PAGE pageDuplicate="0"` 바탕쪽이 기본 홀/짝 바탕쪽을 대체하는지
//! 고정한다. 종전에는 파서가 이 선언을 `LAST_PAGE` 에만 반영해 임의 쪽 바탕쪽이
//! 기본 바탕쪽 위에 덧그려졌고, 쪽번호가 같은 좌표에 포개졌다.
//!
//! 비공개 korea 샘플은 가져오지 않는다. IR 왕복과 렌더 트리로 같은 형상을 잠근다.
#![cfg(not(target_arch = "wasm32"))]

use rhwp::document_core::DocumentCore;
use rhwp::model::document::{Document, Section};
use rhwp::model::header_footer::{HeaderFooterApply, MasterPage};
use rhwp::model::paragraph::{ColumnBreakType, Paragraph};
use rhwp::model::style::CharShape;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};
use rhwp::serializer::hwpx::serialize_hwpx;

fn doc_with_odd_and_optional_master(replace_base: bool, target: u16, pages: usize) -> Document {
    let mut odd_para = Paragraph::default();
    odd_para.text = "홀수 바탕".to_string();
    let mut optional_para = Paragraph::default();
    optional_para.text = "임의 쪽".to_string();
    let mut section = Section::default();
    for page in 0..pages {
        section.paragraphs.push(Paragraph {
            text: format!("본문 {}", page + 1),
            column_type: if page == 0 {
                ColumnBreakType::None
            } else {
                ColumnBreakType::Page
            },
            ..Default::default()
        });
    }
    section.section_def.master_pages.push(MasterPage {
        apply_to: HeaderFooterApply::Odd,
        text_width: 10_000,
        text_height: 10_000,
        paragraphs: vec![odd_para],
        ..Default::default()
    });
    section.section_def.master_pages.push(MasterPage {
        apply_to: HeaderFooterApply::Even,
        text_width: 10_000,
        text_height: 10_000,
        paragraphs: vec![Paragraph {
            text: "짝수 바탕".into(),
            ..Default::default()
        }],
        ..Default::default()
    });
    section.section_def.master_pages.push(MasterPage {
        apply_to: HeaderFooterApply::Both,
        is_extension: true,
        overlap: true,
        replace_base,
        ext_flags: 0x0007,
        hwpx_page_number: Some(target),
        text_width: 10_000,
        text_height: 10_000,
        paragraphs: vec![optional_para],
        ..Default::default()
    });

    let mut doc = Document::default();
    doc.doc_info.char_shapes.push(CharShape::default());
    doc.sections.push(section);
    doc
}

fn master_page_children(root: &RenderNode) -> Vec<&RenderNode> {
    root.children
        .iter()
        .filter(|c| matches!(c.node_type, RenderNodeType::MasterPage))
        .collect()
}

fn visible_texts(node: &RenderNode, out: &mut Vec<String>) {
    if let RenderNodeType::TextRun(tr) = &node.node_type {
        let text = tr.display_or_text().trim();
        if !text.is_empty() {
            out.push(text.to_string());
        }
    }
    for child in &node.children {
        visible_texts(child, out);
    }
}

#[test]
fn optional_page_page_duplicate_0_roundtrips_replace_base() {
    let bytes = serialize_hwpx(&doc_with_odd_and_optional_master(true, 4, 1)).expect("serialize");
    let core = DocumentCore::from_bytes(&bytes).expect("parse");
    let optional = core.document().sections[0]
        .section_def
        .master_pages
        .iter()
        .find(|mp| mp.is_extension)
        .expect("OPTIONAL_PAGE");
    assert!(
        optional.replace_base,
        "pageDuplicate=0 왕복 후 replace_base 가 유지돼야 한다"
    );
    assert!(optional.overlap);
}

#[test]
fn optional_page_master_does_not_stack_on_the_base_master() {
    let bytes = serialize_hwpx(&doc_with_odd_and_optional_master(true, 1, 1)).expect("serialize");
    let core = DocumentCore::from_bytes(&bytes).expect("parse");
    let tree = core.build_page_render_tree(0).expect("render tree");
    let masters = master_page_children(&tree.root);
    let rendered: Vec<Vec<String>> = masters
        .iter()
        .map(|m| {
            let mut t = Vec::new();
            visible_texts(m, &mut t);
            t
        })
        .collect();

    assert_eq!(
        masters.len(),
        1,
        "바탕쪽이 겹쳐 그려지면 쪽번호·머리말이 같은 좌표에 포개진다. \
         그려진 바탕쪽 {}겹, 각 글자: {rendered:?}",
        masters.len()
    );
    assert!(
        rendered
            .iter()
            .any(|t| t.iter().any(|s| s.contains("임의"))),
        "확장 바탕쪽 글자가 그려져야 한다: {rendered:?}"
    );
    assert!(
        !rendered
            .iter()
            .any(|t| t.iter().any(|s| s.contains("홀수"))),
        "기본 홀수 바탕쪽 글자가 남아 있으면 덧그리기다: {rendered:?}"
    );
}

#[test]
fn optional_page_target_applies_only_to_its_page_and_preserves_overlay_on_reopen() {
    fn check(core: &DocumentCore, replace: bool) {
        assert_eq!(
            core.page_count(),
            4,
            "fixture must contain the targeted fourth page"
        );
        for page in 0..4 {
            let tree = core
                .build_page_render_tree(page)
                .expect("render targeted page");
            let masters = master_page_children(&tree.root);
            let mut text = Vec::new();
            for master in &masters {
                visible_texts(master, &mut text);
            }
            let optional = text.iter().any(|s| s.contains("임의"));
            let odd = text.iter().any(|s| s.contains("홀수"));
            let even = text.iter().any(|s| s.contains("짝수"));
            assert_eq!(optional, page == 3, "page {}: {text:?}", page + 1);
            assert_eq!(odd, page % 2 == 0, "page {}: {text:?}", page + 1);
            assert_eq!(
                even,
                page % 2 == 1 && !(replace && page == 3),
                "page {}: {text:?}",
                page + 1
            );
            assert_eq!(masters.len(), if page == 3 && !replace { 2 } else { 1 });
        }
    }
    for replace in [true, false] {
        let bytes = serialize_hwpx(&doc_with_odd_and_optional_master(replace, 4, 4)).unwrap();
        let core = DocumentCore::from_bytes(&bytes).expect("four-page source");
        check(&core, replace);
        let saved = core.export_hwpx_native().expect("public master save");
        let reopened = DocumentCore::from_bytes(&saved).expect("master reopen");
        check(&reopened, replace);
    }
}

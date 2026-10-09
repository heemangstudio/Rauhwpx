//! Issue #1549: visible host 문단(텍스트=섹션 제목)에 양수 offset co-anchored
//! TopAndBottom float 표가 여러 개 있을 때의 제목·표 배치.
//! 처음에는 제목을 문단 앵커(표 위)에 두도록 고정했으나, #374(9a7b639a) 검증에서 이
//! fixture 를 한컴 macOS 로 내보낸 결과(docs/evidence/pr374-parity/README.md)는 표 A·B·C 를
//! 차례로 쌓고 제목을 마지막 표 아래에 둔다. 지금은 그 순서를 고정한다.
//!
//! fixture: samples/issue1549_multipositive_float_tables.hwpx
//!   = issue1510 구조에서 float 표 offset 을 모두 작은 양수로 narrow
//!     (A=+200, B=+500, C=+800 HWPUNIT) — 표 top 이 제목 라인과 겹치는 multi-positive 케이스.

use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};
use std::fs;
use std::path::Path;

const HWPX_SAMPLE: &str = "samples/issue1549_multipositive_float_tables.hwpx";
const EMPTY_HOST_SAMPLE: &str = "samples/issue1549_empty_host_float_clamp.hwpx";
const TARGET_PI: usize = 0;
const TITLE_NEEDLE: &str = "MULTI POSITIVE TITLE";
const TARGET_TABLES: [usize; 3] = [2, 3, 4];

fn load_doc(sample: &str) -> rhwp::wasm_api::HwpDocument {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let hwp_path = Path::new(repo_root).join(sample);
    let bytes = fs::read(&hwp_path).unwrap_or_else(|e| panic!("read {}: {}", sample, e));
    rhwp::wasm_api::HwpDocument::from_bytes(&bytes)
        .unwrap_or_else(|e| panic!("parse {}: {}", sample, e))
}

fn find_table_bbox(root: &RenderNode, target_ci: usize) -> Option<(f64, f64)> {
    if let RenderNodeType::Table(table) = &root.node_type {
        if table.para_index == Some(TARGET_PI) && table.control_index == Some(target_ci) {
            return Some((root.bbox.y, root.bbox.y + root.bbox.height));
        }
    }
    for child in &root.children {
        if let Some(found) = find_table_bbox(child, target_ci) {
            return Some(found);
        }
    }
    None
}

fn find_table_bbox_by_para(root: &RenderNode, para_index: usize) -> Option<(f64, f64)> {
    if let RenderNodeType::Table(table) = &root.node_type {
        if table.para_index == Some(para_index) {
            return Some((root.bbox.y, root.bbox.y + root.bbox.height));
        }
    }
    for child in &root.children {
        if let Some(found) = find_table_bbox_by_para(child, para_index) {
            return Some(found);
        }
    }
    None
}

fn find_title_bbox(root: &RenderNode, needle: &str) -> Option<(f64, f64)> {
    if let RenderNodeType::TextRun(run) = &root.node_type {
        if run.para_index.is_some() && run.text.contains(needle) {
            return Some((root.bbox.y, root.bbox.y + root.bbox.height));
        }
    }
    for child in &root.children {
        if let Some(found) = find_title_bbox(child, needle) {
            return Some(found);
        }
    }
    None
}

fn table_bboxes(root: &RenderNode) -> Vec<(f64, f64)> {
    TARGET_TABLES
        .iter()
        .map(|&ci| find_table_bbox(root, ci).unwrap_or_else(|| panic!("table ci={ci} bbox")))
        .collect()
}

/// 한컴 macOS 내보내기(#374 검증, Hancom Mac 12.30): 첫 표 A 는 본문 상단 +
/// 바깥 위 여백 + 자기 offset(138.6px)에서 시작하고, 제목은 co-anchored 표들 아래에 온다.
#[test]
fn issue_1549_multi_positive_float_host_title_renders_below_tables() {
    let doc = load_doc(HWPX_SAMPLE);
    let tree = doc
        .build_page_render_tree(0)
        .expect("build_page_render_tree(0)");

    let (title_top, _) = find_title_bbox(&tree.root, TITLE_NEEDLE).expect("host title text bbox");
    let tables = table_bboxes(&tree.root);
    let first_table_top = tables.iter().map(|t| t.0).fold(f64::INFINITY, f64::min);
    let last_table_bottom = tables.iter().map(|t| t.1).fold(f64::NEG_INFINITY, f64::max);

    assert!(
        (first_table_top - 138.6).abs() <= 1.0,
        "first co-anchored float table must start at its declared offset like Hancom \
         (138.6px): first_table_top={first_table_top:.1}, tables={tables:?}",
    );
    assert!(
        title_top + 0.5 >= last_table_bottom,
        "host title must render below its co-anchored positive-offset float tables \
         (Hancom macOS export): title_top={title_top:.1}, tables={tables:?}",
    );
}

/// 제목을 앵커로 되돌리면(#1549 초기 수정), 옛 버그가 우연히 제공하던 flow advance 가
/// 사라져 뒤따르는 *빈-host(text 없는)* para float 표가 선행 float 점유밴드 위로
/// 올라와 겹칠 수 있다(작업일지류 실문서 회귀). 빈-host float 도 선행 exclusion
/// 밴드 아래로 클램프되는지 가드한다.
///
/// fixture: 문단0 = visible host 제목 + 양수 offset float 표 A,
///          문단1 = 빈 host(text 0) + 양수 offset float 표 C (A 밴드와 겹치는 자연위치).
#[test]
fn issue_1549_empty_host_following_float_clears_preceding_band() {
    let doc = load_doc(EMPTY_HOST_SAMPLE);
    let tree = doc
        .build_page_render_tree(0)
        .expect("build_page_render_tree(0)");

    let (a_top, a_bottom) =
        find_table_bbox_by_para(&tree.root, 0).expect("para0 visible-host float table A");
    let (c_top, _) =
        find_table_bbox_by_para(&tree.root, 1).expect("para1 empty-host float table C");

    assert!(
        c_top + 0.5 >= a_bottom,
        "empty-host following float table must clear the preceding float band, \
         not overlap it: a=({a_top:.1}..{a_bottom:.1}), c_top={c_top:.1}",
    );
}

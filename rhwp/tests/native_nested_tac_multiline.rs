#![cfg(not(target_arch = "wasm32"))]

//! 양평 표본 축소본(KOGL 1유형): 바깥 틀 한 칸의 같은 문단 저장 줄 0·1 에 글자처럼
//! 취급되는 중첩 표 두 개(10×6, 3×3)가 있다. 수정 전에는 두 표가 한 줄에 겹치거나 셀
//! 밖으로 밀려 잘렸다. 각 표가 원본 순서대로 별도 호스트 줄에 앉고 셀 안에 들어오는지
//! 상대 기하만 잠근다.

use std::path::Path;

use rhwp::document_core::DocumentCore;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

const FIXTURE: &str = "tests/fixtures/yangpyeong_nested_tac_multiline/source.hwpx";
const EPS: f64 = 0.5;

type Rect = (f64, f64, f64, f64);

struct Nested {
    rect: Rect,
    cells: usize,
    cell: Rect,
    outer: Rect,
}

fn rect(n: &RenderNode) -> Rect {
    (n.bbox.x, n.bbox.y, n.bbox.width, n.bbox.height)
}

fn count_cells(n: &RenderNode) -> usize {
    n.children
        .iter()
        .map(|c| match &c.node_type {
            RenderNodeType::TableCell(_) => 1,
            RenderNodeType::Table(_) => 0,
            _ => count_cells(c),
        })
        .sum()
}

fn walk(n: &RenderNode, outer: Option<Rect>, cell: Option<Rect>, out: &mut Vec<Nested>) {
    let (mut outer_next, mut cell_next) = (outer, cell);
    match &n.node_type {
        RenderNodeType::Table(t) => {
            // 같은 칸의 1×4 제목·바닥 표는 대상이 아니다. 10×6, 3×3 쌍만 기록한다.
            let dims = (t.row_count, t.col_count);
            if let (Some(outer), Some(cell), (10, 6) | (3, 3)) = (outer, cell, dims) {
                out.push(Nested {
                    rect: rect(n),
                    cells: count_cells(n),
                    cell,
                    outer,
                });
            }
            (outer_next, cell_next) = (Some(rect(n)), None);
        }
        RenderNodeType::TableCell(_) => cell_next = Some(rect(n)),
        _ => {}
    }
    for c in &n.children {
        walk(c, outer_next, cell_next, out);
    }
}

fn contains(outer: Rect, inner: Rect) -> bool {
    inner.0 >= outer.0 - EPS
        && inner.1 >= outer.1 - EPS
        && inner.0 + inner.2 <= outer.0 + outer.2 + EPS
        && inner.1 + inner.3 <= outer.1 + outer.3 + EPS
}

fn overlaps(a: Rect, b: Rect) -> bool {
    a.0 < b.0 + b.2 - EPS && b.0 < a.0 + a.2 - EPS && a.1 < b.1 + b.3 - EPS && b.1 < a.1 + a.3 - EPS
}

#[test]
fn nested_tac_tables_take_separate_host_lines_inside_cell() {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE);
    let core = DocumentCore::from_bytes(&std::fs::read(p).expect("표본 읽기")).expect("문서 로드");
    let root = core.build_page_render_tree(0).expect("render tree").root;
    let mut nested = Vec::new();
    walk(&root, None, None, &mut nested);
    assert_eq!(nested.len(), 2, "바깥 틀 안 중첩 표 한 쌍을 기대했다");
    let (a, b) = (&nested[0], &nested[1]);
    let rects = (a.rect, b.rect);
    assert!(
        a.rect.2 > 0.0 && a.rect.3 > 0.0 && b.rect.2 > 0.0 && b.rect.3 > 0.0,
        "{rects:?}"
    );
    assert!(
        a.cells > b.cells,
        "원본 순서: 10×6 표({}칸)가 3×3 표({}칸)보다 먼저 와야 한다",
        a.cells,
        b.cells
    );
    assert!(
        contains(a.cell, b.cell) && contains(b.cell, a.cell),
        "두 표는 같은 셀 문단에 속해야 한다"
    );
    assert!(
        !overlaps(a.rect, b.rect),
        "두 표가 겹친다(수정 전 한 줄 폴백): {rects:?}"
    );
    assert!(
        a.rect.1 + a.rect.3 <= b.rect.1 + EPS,
        "둘째 표는 첫째 표 아래 별도 호스트 줄에 앉아야 한다: {rects:?}"
    );
    for t in [a, b] {
        assert!(
            contains(t.cell, t.rect),
            "표가 셀 밖으로 잘린다: {:?} ⊄ {:?}",
            t.rect,
            t.cell
        );
        assert!(
            contains(t.outer, t.rect),
            "표가 바깥 틀을 벗어난다: {:?}",
            t.rect
        );
    }
}

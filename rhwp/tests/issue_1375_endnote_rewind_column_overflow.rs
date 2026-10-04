use rhwp::renderer::render_tree::{BoundingBox, RenderNode, RenderNodeType};
use rhwp::wasm_api::HwpDocument;

const SEP2020_SAMPLE: &str = "samples/3-09월_교육_통합_2024-구분선아래20구분선위20.hwp";

fn load_doc() -> HwpDocument {
    let bytes = std::fs::read(SEP2020_SAMPLE).expect("sep2020 sample");
    HwpDocument::from_bytes(&bytes).expect("parse sep2020 sample")
}

fn min_para_text_line_bbox(node: &RenderNode, para_index: usize) -> Option<BoundingBox> {
    let own = match &node.node_type {
        RenderNodeType::TextLine(line) if line.para_index == Some(para_index) => {
            Some(node.bbox.clone())
        }
        _ => None,
    };
    own.into_iter()
        .chain(
            node.children
                .iter()
                .filter_map(|child| min_para_text_line_bbox(child, para_index)),
        )
        .min_by(|a, b| a.y.partial_cmp(&b.y).unwrap())
}

fn max_para_text_line_bottom(node: &RenderNode, para_index: usize) -> Option<f64> {
    let own = match &node.node_type {
        RenderNodeType::TextLine(line) if line.para_index == Some(para_index) => {
            Some(node.bbox.y + node.bbox.height)
        }
        _ => None,
    };
    own.into_iter()
        .chain(
            node.children
                .iter()
                .filter_map(|child| max_para_text_line_bottom(child, para_index)),
        )
        .max_by(|a, b| a.partial_cmp(b).unwrap())
}

#[test]
fn issue_1375_sep2020_page17_rewind_paragraph_advances_whole_to_right_column() {
    let doc = load_doc();
    let page17 = doc.dump_page_items(Some(16));

    assert!(
        !page17.contains("PartialParagraph[미주]  pi=894"),
        "pi=894 rewind paragraph must not be split into the nearly-full left column\n{page17}"
    );

    let right_col = page17.find("  단 1").expect("page 17 right column dump");
    let para894 = page17
        .find("FullParagraph[미주]  pi=894")
        .expect("pi=894 whole paragraph on page 17");
    assert!(
        para894 > right_col,
        "pi=894 should start as a whole paragraph in the right column\n{page17}"
    );

    let tree = doc.build_page_render_tree(16).expect("page 17 render tree");
    let first_line = min_para_text_line_bbox(&tree.root, 894).expect("pi=894 first text line");
    assert!(
        first_line.x > 390.0 && (84.0..=110.0).contains(&first_line.y),
        "pi=894 should render at the right-column top band, got {:?}",
        first_line
    );
}

#[test]
fn issue_1375_sep2020_page22_rewind_tail_stays_inside_body_frame() {
    let doc = load_doc();
    let page22 = doc.dump_page_items(Some(21));
    let page23 = doc.dump_page_items(Some(22));

    assert!(
        page22.contains("PartialParagraph[미주]  pi=1175  lines=0..10"),
        "page 22 should keep only the render-safe head of pi=1175\n{page22}"
    );
    assert!(
        page23.contains("PartialParagraph[미주]  pi=1175  lines=10..13"),
        "page 23 should continue pi=1175 after the page 22 tail split\n{page23}"
    );

    let tree = doc.build_page_render_tree(21).expect("page 22 render tree");
    let tail_bottom =
        max_para_text_line_bottom(&tree.root, 1175).expect("pi=1175 page 22 text bottom");
    assert!(
        tail_bottom <= 1092.3,
        "pi=1175 page 22 tail should render inside the body frame, bottom={tail_bottom}"
    );
}

#[test]
fn saved_endnote_rewinds_fit_rendered_content_and_split_at_line_boundaries() {
    let bytes = std::fs::read("samples/3-11월_실전_통합_2022.hwpx").expect("nov2022 sample");
    let doc = HwpDocument::from_bytes(&bytes).expect("parse nov2022 sample");

    // macOS 한컴 PDF: 문12 적분식은 11쪽 왼쪽 끝, 다음 문장은 오른쪽 첫 줄이다.
    let page11 = doc.dump_page_items(Some(10));
    let (left, right) = page11.split_once("  단 1").expect("page 11 columns");
    assert!(left.contains("FullParagraph[미주]  pi=534"));
    assert!(right.contains("FullParagraph[미주]  pi=535"));

    // 설치 서체에 따라 분할 줄 수는 달라도 문15의 (iii)는 양쪽 단에
    // 빠짐없이 이어져야 한다. Hancom 서체를 로드한 시각 검증에서는 3+5줄이다.
    let page12 = doc.dump_page_items(Some(11));
    let (left, right) = page12.split_once("  단 1").expect("page 12 columns");
    let split = left
        .lines()
        .find_map(|line| line.split_once("pi=572  lines=0.."))
        .and_then(|(_, tail)| tail.split_whitespace().next())
        .and_then(|value| value.parse::<usize>().ok())
        .expect("left-column head of pi=572");
    assert!((1..8).contains(&split));
    assert!(right.contains(&format!("PartialParagraph[미주]  pi=572  lines={split}..8")));
    let tree12 = doc.build_page_render_tree(11).expect("page 12 render tree");
    let split_bottom = max_para_text_line_bottom(&tree12.root, 572).expect("split text lines");
    assert!(
        split_bottom <= 1092.3,
        "split paragraph bottom={split_bottom}"
    );

    // 저장 높이는 작아도 실제로 들어가지 않는 문19 그림은 다음 쪽으로 넘긴다.
    assert!(!page12.contains("FullParagraph[미주]  pi=593"));
    assert!(doc
        .dump_page_items(Some(12))
        .contains("FullParagraph[미주]  pi=593"));

    // 한 줄 텍스트의 저장 단 경계는 유지한다. 문30의 '가지'부터 16쪽이다.
    assert!(!doc
        .dump_page_items(Some(14))
        .contains("FullParagraph[미주]  pi=725"));
    assert!(doc
        .dump_page_items(Some(15))
        .contains("FullParagraph[미주]  pi=725"));

    // 되감긴 적분식과 후속 두 문단은 실제로 배치된 쪽의 frame 안에 있어야 한다.
    let pages = [doc.dump_page_items(Some(16)), doc.dump_page_items(Some(17))];
    for para_index in [821, 822, 823] {
        let marker = format!("FullParagraph[미주]  pi={para_index}");
        let page_offset = pages
            .iter()
            .position(|page| page.contains(&marker))
            .expect("equation tail on page 17 or 18");
        let tree = doc
            .build_page_render_tree(16 + page_offset as u32)
            .expect("tail render tree");
        let tail_bottom =
            max_para_text_line_bottom(&tree.root, para_index).expect("tail text line");
        assert!(
            tail_bottom <= 1092.3,
            "pi={para_index} measured tail bottom={tail_bottom}"
        );
    }
}

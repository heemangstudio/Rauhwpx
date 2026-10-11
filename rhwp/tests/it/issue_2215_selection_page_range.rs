use std::path::Path;

use rhwp::wasm_api::HwpDocument;
use serde_json::{json, Value};

const CELL_CONTEXT: (u32, u32, u32, u32) = (0, 0, 2, 2);

#[derive(Clone, Copy, Debug)]
struct SelectionCase {
    start_para: u32,
    start_offset: u32,
    end_para: u32,
    end_offset: u32,
    start_page_hint: u32,
    end_page_hint: u32,
}

fn load_sample(file_name: &str) -> HwpDocument {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("samples")
        .join(file_name);
    let bytes = std::fs::read(&path).unwrap_or_else(|error| {
        panic!("read {}: {error}", path.display());
    });
    HwpDocument::from_bytes(&bytes).unwrap_or_else(|error| {
        panic!("parse {}: {error}", path.display());
    })
}

fn selection_rects_with_hints(doc: &HwpDocument, case: SelectionCase) -> String {
    let (section, parent_para, control, cell) = CELL_CONTEXT;
    doc.get_selection_rects_in_cell_ex(
        &json!({
            "sectionIdx": section,
            "parentParaIdx": parent_para,
            "controlIdx": control,
            "cellIdx": cell,
            "startCellParaIdx": case.start_para,
            "startCharOffset": case.start_offset,
            "endCellParaIdx": case.end_para,
            "endCharOffset": case.end_offset,
            "startPageHint": case.start_page_hint,
            "endPageHint": case.end_page_hint,
        })
        .to_string(),
    )
    .expect("hinted cell selection rects")
}

fn rect_values(json: &str) -> Vec<Value> {
    serde_json::from_str(json).expect("selection rect JSON")
}

fn page_width(doc: &HwpDocument, page: u32) -> f64 {
    let info = doc.get_page_info(page).expect("page info");
    serde_json::from_str::<Value>(&info).expect("page info JSON")["width"]
        .as_f64()
        .expect("page width")
}

#[test]
fn issue_2215_missing_or_invalid_hints_match_the_positional_fallback() {
    let mut doc = load_sample("exam_social.hwp");
    let positional = doc
        .get_selection_rects_in_cell(1, 16, 0, 0, 0, 0, 6, 469, None)
        .expect("positional fallback");
    let base = json!({
        "sectionIdx": 1,
        "parentParaIdx": 16,
        "controlIdx": 0,
        "cellIdx": 0,
        "startCellParaIdx": 0,
        "startCharOffset": 0,
        "endCellParaIdx": 6,
        "endCharOffset": 469,
    });

    let missing = doc
        .get_selection_rects_in_cell_ex(&base.to_string())
        .expect("missing hint fallback");
    assert_eq!(missing, positional);

    let mut one_sided = base.clone();
    one_sided["startPageHint"] = json!(1);
    let one_sided = doc
        .get_selection_rects_in_cell_ex(&one_sided.to_string())
        .expect("one-sided hint fallback");
    assert_eq!(one_sided, positional);

    let mut invalid = base;
    invalid["startPageHint"] = json!(999);
    invalid["endPageHint"] = json!(999);
    let invalid = doc
        .get_selection_rects_in_cell_ex(&invalid.to_string())
        .expect("invalid hint fallback");
    assert_eq!(invalid, positional);

    let copied = doc
        .copy_selection_in_cell(1, 16, 0, 0, 0, 0, 6, 469)
        .expect("fallback copy remains available");
    assert!(copied.contains("\"ok\":true"));
}

#[test]
fn issue_2215_split_paragraph_same_page_hints_select_the_pointer_fragment() {
    let split_cases = [
        SelectionCase {
            start_para: 17,
            start_offset: 166,
            end_para: 17,
            end_offset: 170,
            start_page_hint: 1,
            end_page_hint: 1,
        },
        SelectionCase {
            start_para: 1277,
            start_offset: 78,
            end_para: 1277,
            end_offset: 82,
            start_page_hint: 56,
            end_page_hint: 56,
        },
        SelectionCase {
            start_para: 2499,
            start_offset: 114,
            end_para: 2499,
            end_offset: 118,
            start_page_hint: 114,
            end_page_hint: 114,
        },
    ];

    let mut failures = Vec::new();
    for file_name in [
        "issue1949_giant_cell_nested_tables_perf.hwp",
        "issue1949_giant_cell_nested_tables_perf.hwpx",
    ] {
        let doc = load_sample(file_name);
        for case in split_cases {
            let json = selection_rects_with_hints(&doc, case);
            let rects = rect_values(&json);
            let expected_page = u64::from(case.start_page_hint);
            let width = page_width(&doc, case.start_page_hint);
            let valid = !rects.is_empty()
                && rects.iter().all(|rect| {
                    let page_matches = rect["pageIndex"].as_u64() == Some(expected_page);
                    let x = rect["x"].as_f64().unwrap_or(f64::INFINITY);
                    let rect_width = rect["width"].as_f64().unwrap_or(f64::INFINITY);
                    page_matches && x >= -0.5 && x + rect_width <= width + 0.5
                });
            if !valid {
                failures.push(format!(
                    "{file_name}: para {} expected page {} within width {width}, got {json}",
                    case.start_para, case.start_page_hint
                ));
            }
        }
    }

    assert!(
        failures.is_empty(),
        "#2215 RED — getSelectionRectsInCellEx still ignores page hints:\n{}",
        failures.join("\n")
    );
}

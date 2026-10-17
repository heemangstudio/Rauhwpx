//! 찾기는 실제 표 경로를 돌려주며 치환의 기존 본문 범위를 확대하지 않는다.
use rhwp::document_core::DocumentCore;
use rhwp::model::{
    control::Control,
    paragraph::Paragraph,
    provenance::FontMetricsPolicy,
    table::{Cell, Table},
};
use rhwp::wasm_api::HwpDocument;
use serde_json::{json, Value};

fn parse(s: String) -> Value {
    serde_json::from_str(&s).unwrap()
}
fn imported() -> HwpDocument {
    // Business HWP5 8b786d6824622afae2220b203beeef6e5592157e1896fea055ebc602817113c1.
    HwpDocument::from_local_file_bytes_with_font_metrics(
        include_bytes!("../fixtures/imported_cell_margin_business.hwp"),
        FontMetricsPolicy::HcrDeclared,
    )
    .unwrap()
}
#[test]
fn imported_table_only_find_selects_real_cell_and_preserves_body_replace_scope() {
    let mut core = imported();
    let hit = parse(
        core.search_text_native("기술등급", 0, 0, 0, true, true)
            .unwrap(),
    );
    assert_eq!(hit["found"], true);
    assert_eq!(
        (hit["sec"].as_u64(), hit["para"].as_u64()),
        (Some(0), Some(70))
    );
    let path = hit["cellPath"].to_string();
    assert_eq!(
        hit["cellPath"],
        json!([{"controlIndex":0,"cellIndex":3,"cellParaIndex":0}])
    );
    let offset = hit["charOffset"].as_u64().unwrap() as usize;
    let length = hit["length"].as_u64().unwrap() as usize;
    let Control::Table(t) = &core.document().sections[0].paragraphs[70].controls[0] else {
        panic!()
    };
    assert_eq!(
        t.cells[3].paragraphs[0]
            .text
            .chars()
            .skip(offset)
            .take(length)
            .collect::<String>(),
        "기술등급"
    );
    let start = parse(
        core.get_cursor_rect_by_path(0, 70, &path, offset as u32)
            .unwrap(),
    );
    let end = parse(
        core.get_cursor_rect_by_path(0, 70, &path, (offset + length) as u32)
            .unwrap(),
    );
    assert_eq!(start["pageIndex"], end["pageIndex"]);
    assert!(end["x"].as_f64().unwrap() > start["x"].as_f64().unwrap());
    assert_eq!(
        parse(core.replace_one_native("기술등급", "wrong", true).unwrap())["ok"],
        false
    );
    let saved = core.export_hwpx_native().unwrap();
    let reopened = HwpDocument::from_local_file_bytes_with_font_metrics(
        &saved,
        FontMetricsPolicy::HcrDeclared,
    )
    .unwrap();
    let again = parse(
        reopened
            .search_text_native("기술등급", 0, 0, 0, true, true)
            .unwrap(),
    );
    assert_eq!(again["cellPath"], hit["cellPath"]);
    assert_eq!(again["charOffset"], hit["charOffset"]);
}
fn text(s: &str) -> Paragraph {
    Paragraph {
        text: s.into(),
        char_count: s.chars().count() as u32 + 1,
        char_offsets: (0..s.chars().count() as u32).collect(),
        ..Default::default()
    }
}
fn table(paragraphs: Vec<Paragraph>) -> Table {
    Table {
        row_count: 1,
        col_count: 1,
        cells: vec![Cell {
            row_span: 1,
            col_span: 1,
            width: 10000,
            height: 2000,
            paragraphs,
            ..Default::default()
        }],
        ..Default::default()
    }
}
#[test]
fn addressed_find_orders_body_cell_nested_cell_and_wraps_in_both_directions() {
    let mut model = imported().document().clone();
    model.sections.truncate(1);
    let mut cell = text("needle");
    cell.controls
        .push(Control::Table(Box::new(table(vec![text("needle")]))));
    let mut body = text("needleneedle");
    body.controls
        .push(Control::Table(Box::new(table(vec![cell]))));
    model.sections[0].paragraphs = vec![body, text("needle")];
    let mut core = DocumentCore::new_empty();
    core.set_document(model);
    let addresses = [
        (0, json!([]), 0),
        (0, json!([]), 6),
        (
            0,
            json!([{"controlIndex":0,"cellIndex":0,"cellParaIndex":0}]),
            0,
        ),
        (
            0,
            json!([{"controlIndex":0,"cellIndex":0,"cellParaIndex":0},{"controlIndex":0,"cellIndex":0,"cellParaIndex":0}]),
            0,
        ),
        (1, json!([]), 0),
    ];
    for (i, (root, path, offset)) in addresses.iter().enumerate() {
        for forward in [true, false] {
            let j = if forward {
                (i + 1) % addresses.len()
            } else {
                (i + addresses.len() - 1) % addresses.len()
            };
            let hit = parse(
                core.search_text_by_path_native(
                    "needle",
                    0,
                    *root,
                    if forward {
                        *offset + "needle".chars().count()
                    } else {
                        *offset
                    },
                    &path.to_string(),
                    forward,
                    true,
                )
                .unwrap(),
            );
            assert_eq!(hit["para"], addresses[j].0);
            assert_eq!(hit["cellPath"], addresses[j].1);
            assert_eq!(hit["charOffset"], addresses[j].2);
            assert_eq!(
                hit["wrapped"],
                if forward {
                    i == addresses.len() - 1
                } else {
                    i == 0
                }
            );
        }
    }
}

//! 실제 HWP 표에서 셀을 병합하고 저장한 뒤 다시 열어도 병합 범위와 셀 내용이 남아야 한다.

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::table::Table;

use crate::common::load_core;

const SAMPLE: &str = "samples/hwp_table_test.hwp";
const TABLE_PARA: usize = 3;

fn table(core: &DocumentCore) -> &Table {
    match &core.document().sections[0].paragraphs[TABLE_PARA].controls[0] {
        Control::Table(table) => table,
        _ => panic!("{SAMPLE}: 문단 {TABLE_PARA} 첫 컨트롤이 표가 아니다"),
    }
}

/// (행, 열, 행 병합, 열 병합, 셀 텍스트) 목록.
fn cells(table: &Table) -> Vec<(u16, u16, u16, u16, String)> {
    let mut cells: Vec<_> = table
        .cells
        .iter()
        .map(|cell| {
            let text: Vec<&str> = cell.paragraphs.iter().map(|p| p.text.as_str()).collect();
            (
                cell.row,
                cell.col,
                cell.row_span,
                cell.col_span,
                text.join("\n"),
            )
        })
        .collect();
    cells.sort();
    cells
}

#[test]
fn merged_cells_survive_hwp_save_and_reload() {
    let mut core = load_core(SAMPLE);
    let before = cells(table(&core));
    core.merge_table_cells_native(0, TABLE_PARA, 0, 2, 0, 2, 1)
        .expect("merge (2,0)-(2,1)");
    let merged = cells(table(&core));
    assert_ne!(merged, before, "병합이 표를 바꾸지 않았다");
    assert!(
        merged
            .iter()
            .any(|&(row, col, _, col_span, _)| (row, col, col_span) == (2, 0, 2)),
        "병합 직후 (2,0) 셀이 두 열을 덮어야 한다: {merged:?}"
    );

    let saved = core.export_hwp_native().expect("save HWP");
    let reloaded = DocumentCore::from_bytes(&saved).expect("reload saved HWP");
    assert_eq!(
        cells(table(&reloaded)),
        merged,
        "저장 후 다시 연 표가 병합 직후와 달라졌다"
    );
}

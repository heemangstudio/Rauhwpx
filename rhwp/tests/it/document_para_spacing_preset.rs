//! 서식 › 문단 간격 프리셋: 문서 전체 본문 문단의 줄 간격·문단 간격만 바꾸고
//! 정렬·여백·표 셀 문단·고정 줄 간격 문단은 그대로 둔다. 한 번의 스냅샷 복원으로 되돌아간다.

use rhwp::document_core::{DocumentCore, DocumentParaSpacing};
use rhwp::model::control::Control;
use rhwp::model::style::{LineSpacingType, ParaShape};

use super::common::load_core;

const SAMPLE: &str = "samples/2026_oss_rst.hwp";

const WIDE: DocumentParaSpacing = DocumentParaSpacing {
    line_spacing: 200,
    spacing_before: 0,
    spacing_after: 1200, // 6pt × 200
};

fn shape(core: &DocumentCore, id: u16) -> ParaShape {
    core.document().doc_info.para_shapes[id as usize].clone()
}

fn hosts_table(para: &rhwp::model::paragraph::Paragraph) -> bool {
    para.controls.iter().any(|c| matches!(c, Control::Table(_)))
}

/// 표 셀 문단의 문단 모양 ID 전체 (구역·문단·컨트롤·셀·셀 문단 순서)
fn cell_shape_ids(core: &DocumentCore) -> Vec<u16> {
    let mut out = Vec::new();
    for section in &core.document().sections {
        for para in &section.paragraphs {
            for ctrl in &para.controls {
                if let Control::Table(table) = ctrl {
                    for cell in &table.cells {
                        out.extend(cell.paragraphs.iter().map(|p| p.para_shape_id));
                    }
                }
            }
        }
    }
    out
}

fn body_shapes(core: &DocumentCore) -> Vec<(bool, ParaShape)> {
    core.document()
        .sections
        .iter()
        .flat_map(|s| s.paragraphs.iter())
        .map(|p| {
            let ps = shape(core, p.para_shape_id);
            let target = ps.line_spacing_type == LineSpacingType::Percent && !hosts_table(p);
            (target, ps)
        })
        .collect()
}

#[test]
fn wide_preset_changes_only_spacing_of_body_percent_paragraphs() {
    let mut core = load_core(SAMPLE);
    assert!(core.document().sections.len() > 1, "다구역 샘플이어야 한다");
    let before = body_shapes(&core);
    let cells_before = cell_shape_ids(&core);
    assert!(
        before.iter().any(|(t, _)| *t),
        "대상 본문 문단이 있어야 한다"
    );
    assert!(!cells_before.is_empty(), "표 셀 문단이 있어야 한다");

    let result = core.apply_document_para_spacing_native(WIDE).unwrap();
    assert!(result.contains("\"ok\":true"), "{result}");

    let after = body_shapes(&core);
    assert_eq!(before.len(), after.len());
    for (i, ((target, old), (_, new))) in before.iter().zip(&after).enumerate() {
        if *target {
            assert_eq!(new.line_spacing, 200, "문단 {i}");
            assert_eq!(new.spacing_before, 0, "문단 {i}");
            assert_eq!(new.spacing_after, 1200, "문단 {i}");
            // 5.0.2.5 줄 간격 필드도 함께 바뀌어야 한컴이 HWP 저장본을 새 줄 간격으로 연다
            if old.line_spacing_v2 != 0 {
                assert_eq!(new.line_spacing_v2, 200, "문단 {i} line_spacing_v2");
            }
            // 간격 외 속성은 문단마다 그대로다
            let mut expect = old.clone();
            expect.line_spacing = new.line_spacing;
            expect.line_spacing_v2 = new.line_spacing_v2;
            expect.spacing_before = new.spacing_before;
            expect.spacing_after = new.spacing_after;
            assert_eq!(&expect, new, "문단 {i} 의 나머지 문단 모양이 바뀌었다");
        } else {
            assert_eq!(old, new, "대상 밖 문단 {i} 이 바뀌었다");
        }
    }
    assert_eq!(
        cells_before,
        cell_shape_ids(&core),
        "표 셀 문단 모양이 바뀌었다"
    );

    // 바탕글 스타일도 프리셋을 따른다
    let base = core
        .document()
        .doc_info
        .styles
        .iter()
        .find(|s| s.local_name == "바탕글")
        .expect("바탕글 스타일")
        .clone();
    let base_shape = shape(&core, base.para_shape_id);
    assert_eq!(
        (base_shape.line_spacing, base_shape.spacing_after),
        (200, 1200)
    );

    let summary = core.get_document_para_spacing_native();
    assert!(
        summary.contains("\"lineSpacing\":200")
            && summary.contains("\"spacingBefore\":0")
            && summary.contains("\"spacingAfter\":1200"),
        "{summary}"
    );
}

#[test]
fn reapplying_a_preset_is_a_noop() {
    let mut core = load_core(SAMPLE);
    core.apply_document_para_spacing_native(WIDE).unwrap();
    let shapes = core.document().doc_info.para_shapes.len();
    let again = core.apply_document_para_spacing_native(WIDE).unwrap();
    assert!(again.contains("\"changed\":0"), "{again}");
    assert_eq!(shapes, core.document().doc_info.para_shapes.len());
}

#[test]
fn one_snapshot_restore_undoes_the_preset() {
    let mut core = load_core(SAMPLE);
    let ids_before: Vec<Vec<u16>> = core
        .document()
        .sections
        .iter()
        .map(|s| s.paragraphs.iter().map(|p| p.para_shape_id).collect())
        .collect();
    let vpos_before: Vec<Vec<i32>> = core
        .document()
        .sections
        .iter()
        .map(|s| {
            s.paragraphs
                .iter()
                .filter_map(|p| p.line_segs.first().map(|l| l.vertical_pos))
                .collect()
        })
        .collect();
    let pages_before = core.page_count();
    let summary_before = core.get_document_para_spacing_native();

    let snapshot = core.save_snapshot_native();
    core.apply_document_para_spacing_native(WIDE).unwrap();
    assert!(core.page_count() >= pages_before);
    core.restore_snapshot_native(snapshot).unwrap();

    let ids_after: Vec<Vec<u16>> = core
        .document()
        .sections
        .iter()
        .map(|s| s.paragraphs.iter().map(|p| p.para_shape_id).collect())
        .collect();
    let vpos_after: Vec<Vec<i32>> = core
        .document()
        .sections
        .iter()
        .map(|s| {
            s.paragraphs
                .iter()
                .filter_map(|p| p.line_segs.first().map(|l| l.vertical_pos))
                .collect()
        })
        .collect();
    assert_eq!(ids_before, ids_after);
    assert_eq!(
        vpos_before, vpos_after,
        "옮겨진 문단 vpos 도 복원되어야 한다"
    );
    assert_eq!(pages_before, core.page_count());
    assert_eq!(summary_before, core.get_document_para_spacing_native());
}

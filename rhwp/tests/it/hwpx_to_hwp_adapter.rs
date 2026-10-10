//! HWPX → HWP IR 어댑터 통합 테스트 (#178)
//!
//! Stage 1: 베이스라인 측정 (페이지 수 + 영역별 차이 인벤토리).
//!         일부 샘플은 HWPX 제어 스트림 보존이 누적되며 어댑터 전에도 페이지 수가 안정화된다.

use rhwp::document_core::converters::diagnostics::diff_hwpx_vs_serializer_assumptions;
use rhwp::document_core::converters::hwpx_to_hwp::{
    convert_hwpx_to_hwp_ir, convert_if_hwpx_source,
};
use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::document::{Document, Section};
use rhwp::model::paragraph::Paragraph;
use rhwp::model::style::FillType;

fn load_sample(name: &str) -> Vec<u8> {
    let path = format!("samples/hwpx/{}", name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("샘플 로드 실패 {}: {}", path, e))
}

fn oracle_hwp_page_count_for_hwpx(name: &str) -> Option<u32> {
    let stem = name.strip_suffix(".hwpx").unwrap_or(name);
    let path = format!("samples/hwpx/hancom-hwp/{}.hwp", stem);
    let bytes = std::fs::read(&path).ok()?;
    let core = DocumentCore::from_bytes(&bytes).ok()?;
    Some(core.page_count())
}

fn expected_hwp_page_count(name: &str, fallback_hwpx_pages: u32) -> u32 {
    oracle_hwp_page_count_for_hwpx(name).unwrap_or(fallback_hwpx_pages)
}

fn page_count_after_hwp_export(hwpx_bytes: &[u8]) -> (u32, u32) {
    let core = DocumentCore::from_bytes(hwpx_bytes).expect("HWPX 로드 실패");
    let original_pages = core.page_count();

    let hwp_bytes = core.export_hwp_native().expect("HWP 직렬화 실패");

    let reloaded = DocumentCore::from_bytes(&hwp_bytes).expect("HWP 재로드 실패");
    let reloaded_pages = reloaded.page_count();

    (original_pages, reloaded_pages)
}

/// 베이스라인 측정: HWPX 파서/IR 보존이 누적된 샘플은 어댑터 전에도 페이지 수가 안정적이다.
fn assert_stable_baseline(name: &str, bytes: &[u8]) {
    let (orig, reloaded) = page_count_after_hwp_export(bytes);
    eprintln!(
        "[#178 baseline] {}: orig={}, reloaded={}",
        name, orig, reloaded
    );
    assert!(orig >= 1, "{}: 원본 페이지 수 측정 실패", name);
    assert_eq!(
        reloaded, orig,
        "{}: baseline export/reload 페이지 수 불안정",
        name
    );
}

#[test]
fn baseline_page_count_stable_hwpx_h_01() {
    assert_stable_baseline("hwpx-h-01", &load_sample("hwpx-h-01.hwpx"));
}

#[test]
fn baseline_page_count_measured_hwpx_h_02() {
    let name = "hwpx-h-02";
    let bytes = load_sample("hwpx-h-02.hwpx");
    let (orig, reloaded) = page_count_after_hwp_export(&bytes);
    let expected = expected_hwp_page_count(name, orig);
    eprintln!(
        "[#178 baseline] {}: orig={}, expected_hwp={}, reloaded={}",
        name, orig, expected, reloaded
    );
    assert_eq!(
        orig, expected,
        "{}: HWPX 로드 페이지 수는 한컴 HWP 저장 기준과 일치해야 한다",
        name
    );
    assert!(
        (1..=expected).contains(&reloaded),
        "{}: 어댑터 없는 baseline export는 측정만 하되 0쪽/폭주는 허용하지 않는다 (expected={}, reloaded={})",
        name,
        expected,
        reloaded
    );
}

#[test]
fn baseline_page_count_explosion_hwpx_h_03() {
    let bytes = load_sample("hwpx-h-03.hwpx");
    let (orig, reloaded) = page_count_after_hwp_export(&bytes);
    eprintln!(
        "[#178 baseline] hwpx-h-03: orig={}, reloaded={}",
        orig, reloaded
    );
    // hwpx-h-03 은 폭주 여부 자체가 미확정 — 측정만 기록.
    assert!(orig >= 1);
    assert!(reloaded >= 1);
}

#[test]
fn baseline_diff_inventory_hwpx_h_01() {
    let bytes = load_sample("hwpx-h-01.hwpx");
    let core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드 실패");
    let summary = diff_hwpx_vs_serializer_assumptions(core.document());
    eprintln!("[#178 inventory] hwpx-h-01:\n{}", summary.human_report());
    // 영역별 카운트는 측정만. assert 는 의미있는 영역이 1개 이상 검출됐는지.
    let counts = summary.counts_by_area();
    let interesting = counts.iter().any(|(a, c)| {
        *c > 0
            && (*a == "table.raw_ctrl_data"
                || *a == "paragraph.line_seg.vertical_pos"
                || *a == "cell.list_header_width_ref.bit0")
    });
    assert!(
        interesting,
        "hwpx-h-01 에서 위반 영역이 검출돼야 함 (페이지 폭주가 발생하므로). counts={:?}",
        counts
    );
}

#[test]
fn adapter_deterministic_across_clones() {
    // 두 개의 동일 클론에 어댑터를 적용하면 결과가 같다 (결정론적 동작).
    let bytes = load_sample("hwpx-h-01.hwpx");
    let core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드 실패");

    let mut doc1 = core.document().clone();
    let mut doc2 = core.document().clone();

    let r1 = convert_hwpx_to_hwp_ir(&mut doc1);
    let r2 = convert_hwpx_to_hwp_ir(&mut doc2);
    assert_eq!(r1, r2);
}

#[test]
fn adapter_skips_hwp_source() {
    let mut doc = rhwp::model::document::Document::default();
    let report = convert_if_hwpx_source(&mut doc, rhwp::parser::FileFormat::Hwp);
    assert_eq!(
        report.skipped_reason.as_deref(),
        Some("source_format != Hwpx/Hwp3")
    );
}

// ============================================================
// Stage 2 — table.raw_ctrl_data 합성 검증
// ============================================================

#[test]
fn stage2_raw_ctrl_data_synthesized_for_hwpx_h_01() {
    let bytes = load_sample("hwpx-h-01.hwpx");
    let core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드 실패");

    // 어댑터 적용 전: raw_ctrl_data 가 모두 비어있어야 함 (HWPX 출처 특성)
    let mut empty_count_before = 0;
    for section in &core.document().sections {
        for para in &section.paragraphs {
            for ctrl in &para.controls {
                if let Control::Table(t) = ctrl {
                    if t.raw_ctrl_data.is_empty() {
                        empty_count_before += 1;
                    }
                }
            }
        }
    }
    assert!(
        empty_count_before > 0,
        "HWPX 출처에는 빈 raw_ctrl_data 가 있어야 함"
    );

    // 어댑터 적용
    let mut doc = core.document().clone();
    let report = convert_hwpx_to_hwp_ir(&mut doc);
    assert!(
        report.tables_ctrl_data_synthesized > 0,
        "어댑터가 ctrl_data 를 합성해야 함. report={:?}",
        report
    );

    // 어댑터 적용 후: 모든 표의 raw_ctrl_data 가 채워져 있어야 함
    let mut empty_count_after = 0;
    for section in &doc.sections {
        for para in &section.paragraphs {
            for ctrl in &para.controls {
                if let Control::Table(t) = ctrl {
                    if t.raw_ctrl_data.is_empty() {
                        empty_count_after += 1;
                    }
                }
            }
        }
    }
    assert_eq!(
        empty_count_after, 0,
        "어댑터 적용 후 모든 표는 raw_ctrl_data 가 채워져야 함"
    );
}

#[test]
fn stage2_diagnostics_no_longer_flag_table_ctrl_data() {
    let bytes = load_sample("hwpx-h-01.hwpx");
    let core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드 실패");
    let mut doc = core.document().clone();
    convert_hwpx_to_hwp_ir(&mut doc);

    let summary = diff_hwpx_vs_serializer_assumptions(&doc);
    let counts = summary.counts_by_area();
    let ctrl_data_count = counts
        .iter()
        .find(|(a, _)| *a == "table.raw_ctrl_data")
        .map(|(_, c)| *c)
        .unwrap_or(0);
    assert_eq!(
        ctrl_data_count, 0,
        "어댑터 적용 후 진단 도구가 table.raw_ctrl_data 위반을 보고하지 않아야 함. counts={:?}",
        counts
    );
}

#[test]
fn stage2_idempotent_does_not_double_synthesize() {
    let bytes = load_sample("hwpx-h-01.hwpx");
    let core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드 실패");
    let mut doc = core.document().clone();

    let r1 = convert_hwpx_to_hwp_ir(&mut doc);
    let r2 = convert_hwpx_to_hwp_ir(&mut doc);

    assert!(r1.tables_ctrl_data_synthesized > 0, "1차 호출 시 합성 발생");
    assert_eq!(
        r2.tables_ctrl_data_synthesized, 0,
        "2차 호출 시 합성 0 (idempotent)"
    );
}

#[test]
fn stage2_hwp_source_unchanged() {
    // HWP 원본 로드 → 어댑터 적용 → 표 raw_ctrl_data 가 변경되지 않아야 함
    // (HWP 출처는 raw_ctrl_data 가 이미 비어있지 않으므로 어댑터 가드에 막힘)
    let path = "samples/hwp_table_test.hwp";
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let core = DocumentCore::from_bytes(&bytes).expect("HWP 로드 실패");
    let mut doc = core.document().clone();

    // 어댑터 적용 전 raw_ctrl_data 스냅샷
    let snapshot_before: Vec<Vec<u8>> = doc
        .sections
        .iter()
        .flat_map(|s| s.paragraphs.iter())
        .flat_map(|p| p.controls.iter())
        .filter_map(|c| match c {
            Control::Table(t) => Some(t.raw_ctrl_data.clone()),
            _ => None,
        })
        .collect();

    convert_hwpx_to_hwp_ir(&mut doc);

    let snapshot_after: Vec<Vec<u8>> = doc
        .sections
        .iter()
        .flat_map(|s| s.paragraphs.iter())
        .flat_map(|p| p.controls.iter())
        .filter_map(|c| match c {
            Control::Table(t) => Some(t.raw_ctrl_data.clone()),
            _ => None,
        })
        .collect();

    assert_eq!(
        snapshot_before, snapshot_after,
        "HWP 출처 raw_ctrl_data 는 어댑터에 의해 변경되지 않아야 함"
    );
}

/// Stage 2 베이스라인 측정: 어댑터 적용 후 페이지 폭주 비율이 줄어야 함.
/// (완전 회복은 Stage 4 lineseg vpos 사전계산 후, 단계 회귀 측정 목적)
fn page_count_with_adapter(hwpx_bytes: &[u8]) -> (u32, u32) {
    let core = DocumentCore::from_bytes(hwpx_bytes).expect("HWPX 로드 실패");
    let original_pages = core.page_count();

    let mut doc = core.document().clone();
    convert_hwpx_to_hwp_ir(&mut doc);

    // 어댑터 적용된 doc 으로 직렬화 — DocumentCore 우회
    let hwp_bytes = rhwp::serializer::serialize_hwp(&doc).expect("직렬화 실패");

    let reloaded = DocumentCore::from_bytes(&hwp_bytes).expect("HWP 재로드 실패");
    let reloaded_pages = reloaded.page_count();

    (original_pages, reloaded_pages)
}

#[test]
fn stage2_page_count_after_adapter_hwpx_h_01() {
    let bytes = load_sample("hwpx-h-01.hwpx");
    let (orig, after) = page_count_with_adapter(&bytes);
    let (_, before) = page_count_after_hwp_export(&bytes);
    eprintln!(
        "[#178 Stage 2] hwpx-h-01: orig={}, before_adapter={}, after_adapter={}",
        orig, before, after
    );
    // 회복 단계 — Stage 5 까지는 부분 개선만 기대.
    // 어댑터로 인해 폭주가 더 심해지면 Stage 2 가 잘못된 합성을 한 것이므로 실패.
    assert!(
        after <= before,
        "어댑터 적용 후 페이지 수가 더 늘면 회귀: before={} after={}",
        before,
        after
    );
}

#[test]
fn task888_basic_table_materializes_hancom_table_attrs() {
    let bytes = load_sample("basic-table-01.hwpx");
    let core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드 실패");
    let mut doc = core.document().clone();

    let report = convert_hwpx_to_hwp_ir(&mut doc);
    let table = doc
        .sections
        .iter()
        .flat_map(|s| s.paragraphs.iter())
        .flat_map(|p| p.controls.iter())
        .find_map(|ctrl| match ctrl {
            Control::Table(t) => Some(t),
            _ => None,
        })
        .expect("basic-table-01 표 없음");

    assert_eq!(
        report.table_ctrl_header_attr_materialized, 0,
        "HWPX 파서가 table CTRL_HEADER attr를 이미 materialize한다"
    );
    assert_eq!(
        report.table_record_attr_materialized, 0,
        "HWPX 파서가 TABLE record attr를 이미 materialize한다"
    );
    assert_eq!(
        table.raw_table_record_attr, 0x0400_0006,
        "HWPX table record attr는 pageBreak/repeatHeader/noAdjust와 안쪽 여백 활성 계약 필드로 재구성한다"
    );
    // [#3062] row_sizes 는 이제 HWPX 파서가 셀 수로 직접 채우므로 어댑터
    // materialize 는 no-op 이다 (attr 계열과 동일한 "파서가 이미 한다" 계약).
    assert_eq!(report.table_record_row_sizes_materialized, 0);
    assert_eq!(table.row_sizes, vec![4, 4, 4]);
    assert!(table.raw_ctrl_data.len() >= 4);
    assert_eq!(
        u32::from_le_bytes([
            table.raw_ctrl_data[0],
            table.raw_ctrl_data[1],
            table.raw_ctrl_data[2],
            table.raw_ctrl_data[3],
        ]),
        0x082a_2210
    );
}

#[test]
fn task888_expense_report_materializes_tac_table_ctrl_attrs() {
    let bytes = load_sample("expense_report.hwpx");
    let core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드 실패");
    let mut doc = core.document().clone();

    let report = convert_hwpx_to_hwp_ir(&mut doc);
    let mut tac_attrs = Vec::new();
    let mut tac_row_sizes = Vec::new();

    for section in &doc.sections {
        for para in &section.paragraphs {
            for ctrl in &para.controls {
                if let Control::Table(t) = ctrl {
                    if t.common.treat_as_char {
                        assert!(t.raw_ctrl_data.len() >= 4, "TAC table raw_ctrl_data");
                        let packed = u32::from_le_bytes([
                            t.raw_ctrl_data[0],
                            t.raw_ctrl_data[1],
                            t.raw_ctrl_data[2],
                            t.raw_ctrl_data[3],
                        ]);
                        assert_ne!(packed, 0, "TAC table CTRL_HEADER attr must be materialized");
                        assert_eq!(t.attr, packed);
                        tac_attrs.push(packed);
                        tac_row_sizes.push(t.row_sizes.clone());
                    }
                }
            }
        }
    }

    assert_eq!(tac_attrs.len(), 2, "expense_report TAC table count");
    assert_eq!(
        tac_row_sizes,
        vec![vec![5, 3, 3], vec![4, 1, 4, 3, 6, 1, 3, 1, 2]],
        "TAC table row_sizes must be row cell counts, not row heights"
    );
    assert_eq!(
        report.table_ctrl_header_attr_materialized, 0,
        "HWPX 파서가 TAC table CTRL_HEADER attr를 이미 materialize한다"
    );
    // [#3062] row_sizes 는 파서가 직접 채우므로 어댑터 materialize 는 0 이다.
    assert_eq!(report.table_record_row_sizes_materialized, 0);
}

#[test]
fn task888_expense_report_normalizes_transparent_paragraph_border_fill() {
    let bytes = load_sample("expense_report.hwpx");
    let core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드 실패");
    let mut doc = core.document().clone();

    let report = convert_hwpx_to_hwp_ir(&mut doc);
    // [Issue #1172] winBrush faceColor="none" 은 이제 HWPX parser 단계에서
    // FillType::None 으로 정합된다 (header.rs). 따라서 어댑터의 후처리 정규화
    // (transparent → no-fill) 가 잡을 대상이 없어 카운트는 0 이다. 어댑터 정규화는
    // 다른 경로(예: 색상은 흰색이지만 alpha=0 인 변형)를 위한 방어선으로 유지된다.
    // 본 테스트의 본질(최종 BorderFill 이 no-fill 로 정합됨)은 아래 단언으로 보장.
    assert_eq!(report.border_fills_no_fill_normalized, 0);

    let mut refs = std::collections::HashSet::new();
    for para_shape in &doc.doc_info.para_shapes {
        if para_shape.border_fill_id > 0 {
            refs.insert(para_shape.border_fill_id);
        }
    }
    for char_shape in &doc.doc_info.char_shapes {
        if char_shape.border_fill_id > 0 {
            refs.insert(char_shape.border_fill_id);
        }
    }

    assert!(
        !refs.is_empty(),
        "paragraph/char BorderFill refs must exist"
    );
    for id in refs {
        let border_fill = doc
            .doc_info
            .border_fills
            .get(id.saturating_sub(1) as usize)
            .expect("valid BorderFill ref");
        assert!(
            matches!(border_fill.fill.fill_type, FillType::None),
            "paragraph/char BorderFill #{} must be normalized to no-fill",
            id
        );
    }
}

#[test]
fn task888_expense_report_parses_page_border_fills() {
    let bytes = load_sample("expense_report.hwpx");
    let core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드 실패");
    let section_def = &core.document().sections[0].section_def;

    assert_eq!(section_def.page_border_fill.attr, 0x0000_0001);
    assert_eq!(section_def.page_border_fill.border_fill_id, 3);
    assert_eq!(section_def.page_border_fill.spacing_left, 4252);
    assert_eq!(section_def.page_border_fill.spacing_right, 4252);
    assert_eq!(section_def.page_border_fill.spacing_top, 4252);
    assert_eq!(section_def.page_border_fill.spacing_bottom, 4252);

    assert_eq!(section_def.extra_page_border_fills.len(), 2);
    assert_eq!(section_def.extra_page_border_fills[0].attr, 0x0000_0001);
    assert_eq!(section_def.extra_page_border_fills[0].border_fill_id, 3);
    assert_eq!(section_def.extra_page_border_fills[1].attr, 0x0000_0001);
    assert_eq!(section_def.extra_page_border_fills[1].border_fill_id, 3);
}

#[test]
fn task888_expense_report_page_border_fills_survive_hwp_save_reload() {
    let bytes = load_sample("expense_report.hwpx");
    let mut core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드 실패");

    let hwp_bytes = core.export_hwp_with_adapter().expect("HWP 직렬화 실패");
    let reloaded = DocumentCore::from_bytes(&hwp_bytes).expect("HWP 재로드 실패");
    let section_def = &reloaded.document().sections[0].section_def;

    assert_eq!(section_def.page_border_fill.attr, 0x0000_0001);
    assert_eq!(section_def.page_border_fill.border_fill_id, 3);
    assert_eq!(section_def.page_border_fill.spacing_left, 4252);
    assert_eq!(section_def.page_border_fill.spacing_right, 4252);
    assert_eq!(section_def.page_border_fill.spacing_top, 4252);
    assert_eq!(section_def.page_border_fill.spacing_bottom, 4252);

    assert_eq!(section_def.extra_page_border_fills.len(), 2);
    assert_eq!(section_def.extra_page_border_fills[0].attr, 0x0000_0001);
    assert_eq!(section_def.extra_page_border_fills[0].border_fill_id, 3);
    assert_eq!(section_def.extra_page_border_fills[1].attr, 0x0000_0001);
    assert_eq!(section_def.extra_page_border_fills[1].border_fill_id, 3);
}

#[test]
fn task899_business_overview_cell_backgrounds_use_no_pattern() {
    let bytes = load_sample("business_overview.hwpx");
    let core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드 실패");
    let doc = core.document();

    for border_fill_id in [5_u16, 6, 7] {
        let border_fill = doc
            .doc_info
            .border_fills
            .get((border_fill_id - 1) as usize)
            .unwrap_or_else(|| panic!("BorderFill #{} 없음", border_fill_id));
        assert!(
            matches!(border_fill.fill.fill_type, FillType::Solid),
            "BorderFill #{} must be solid fill",
            border_fill_id
        );
        let solid = border_fill
            .fill
            .solid
            .as_ref()
            .unwrap_or_else(|| panic!("BorderFill #{} solid fill 없음", border_fill_id));
        assert!(
            solid.background_color != 0xffff_ffff,
            "BorderFill #{} must preserve faceColor",
            border_fill_id
        );
        assert_eq!(
            solid.pattern_type, -1,
            "BorderFill #{} has faceColor but no hatchStyle; HWP save must encode no-pattern as -1",
            border_fill_id
        );
    }
}

// ============================================================
// Stage 4 — lineseg lh/vpos 사전계산 + SectionDef 컨트롤 삽입 검증
// ============================================================

#[test]
fn stage4_section_def_control_inserted() {
    let bytes = load_sample("hwpx-h-01.hwpx");
    let core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드 실패");

    // 현재 HWPX 파서는 secPr 를 Section.section_def 와 control stream 에 함께 실체화한다.
    let first_para_orig = &core.document().sections[0].paragraphs[0];
    assert!(
        first_para_orig
            .controls
            .iter()
            .any(|c| matches!(c, Control::SectionDef(_))),
        "HWPX secPr 는 첫 문단 SectionDef 컨트롤로 materialize 되어야 함"
    );

    // 옛 파서 산출물/외부 IR 호환 fallback 검증을 위해 SectionDef 컨트롤을 제거한다.
    let mut doc = core.document().clone();
    for section in &mut doc.sections {
        if let Some(first_para) = section.paragraphs.first_mut() {
            first_para
                .controls
                .retain(|c| !matches!(c, Control::SectionDef(_)));
        }
    }
    let report = convert_hwpx_to_hwp_ir(&mut doc);
    assert!(
        report.section_def_controls_inserted > 0,
        "SectionDef fallback 삽입이 발생해야 함"
    );

    // 어댑터 적용 후: 모든 섹션의 첫 문단에 SectionDef 가 있어야 함
    for (s_idx, section) in doc.sections.iter().enumerate() {
        let first_para = &section.paragraphs[0];
        assert!(
            first_para
                .controls
                .iter()
                .any(|c| matches!(c, Control::SectionDef(_))),
            "섹션 {} 의 첫 문단에 SectionDef 컨트롤 없음",
            s_idx
        );
    }
}

#[test]
fn stage4_section_def_idempotent() {
    let bytes = load_sample("hwpx-h-01.hwpx");
    let core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드 실패");
    let mut doc = core.document().clone();
    for section in &mut doc.sections {
        if let Some(first_para) = section.paragraphs.first_mut() {
            first_para
                .controls
                .retain(|c| !matches!(c, Control::SectionDef(_)));
        }
    }

    let r1 = convert_hwpx_to_hwp_ir(&mut doc);
    let r2 = convert_hwpx_to_hwp_ir(&mut doc);
    assert!(r1.section_def_controls_inserted > 0);
    assert_eq!(
        r2.section_def_controls_inserted, 0,
        "2차 호출 시 삽입 0 (idempotent)"
    );
}

#[test]
fn stage4_page_def_preserved_after_roundtrip() {
    // 어댑터 적용 후 직렬화 → 재로드 시 PageDef (width, height, margins) 가 보존돼야 함.
    let bytes = load_sample("hwpx-h-01.hwpx");
    let core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드 실패");
    let orig_pd = core.document().sections[0].section_def.page_def.clone();

    let mut doc = core.document().clone();
    convert_hwpx_to_hwp_ir(&mut doc);
    let hwp_bytes = rhwp::serializer::serialize_hwp(&doc).expect("직렬화 실패");
    let reloaded = DocumentCore::from_bytes(&hwp_bytes).expect("재로드 실패");
    let reload_pd = &reloaded.document().sections[0].section_def.page_def;

    assert_eq!(orig_pd.width, reload_pd.width, "width 보존");
    assert_eq!(orig_pd.height, reload_pd.height, "height 보존");
    assert_eq!(
        orig_pd.margin_left, reload_pd.margin_left,
        "margin_left 보존"
    );
    assert_eq!(
        orig_pd.margin_right, reload_pd.margin_right,
        "margin_right 보존"
    );
    assert_eq!(orig_pd.margin_top, reload_pd.margin_top, "margin_top 보존");
    assert_eq!(
        orig_pd.margin_bottom, reload_pd.margin_bottom,
        "margin_bottom 보존"
    );
}

#[test]
fn task1654_hide_empty_line_flag_preserved_after_hwp_export_reload() {
    let mut section = Section::default();
    section.section_def.hide_empty_line = true;
    section.section_def.flags &= !0x0008_0000;
    section.paragraphs.push(Paragraph::default());

    let mut doc = Document {
        sections: vec![section],
        ..Default::default()
    };

    let report = convert_hwpx_to_hwp_ir(&mut doc);
    assert_eq!(report.section_def_hide_empty_line_flag_materialized, 1);

    let hwp_bytes = rhwp::serializer::serialize_hwp(&doc).expect("HWP 직렬화 실패");
    let reloaded = DocumentCore::from_bytes(&hwp_bytes).expect("HWP 재로드 실패");
    let section_def = &reloaded.document().sections[0].section_def;

    assert!(section_def.hide_empty_line);
    assert_ne!(section_def.flags & 0x0008_0000, 0);
}

/// Stage 4 핵심 게이트: 어댑터 적용 → 직렬화 → 재로드 시 페이지 수가 HWP 저장 기준과 일치.
fn assert_page_count_recovered(name: &str, bytes: &[u8]) {
    let (orig, after) = page_count_with_adapter(bytes);
    let expected = expected_hwp_page_count(name, orig);
    eprintln!(
        "[#178 Stage 4] {}: orig={}, expected_hwp={}, after_adapter={}",
        name, orig, expected, after
    );
    assert_eq!(
        after, expected,
        "{}: 어댑터 적용 후 페이지 수 {} != HWP 저장 기준 {} (HWPX 원본 {})",
        name, after, expected, orig
    );
}

#[test]
fn stage4_page_count_recovered_hwpx_h_01() {
    assert_page_count_recovered("hwpx-h-01", &load_sample("hwpx-h-01.hwpx"));
}

#[test]
fn stage4_page_count_recovered_hwpx_h_02() {
    assert_page_count_recovered("hwpx-h-02", &load_sample("hwpx-h-02.hwpx"));
}

#[test]
fn stage4_page_count_recovered_hwpx_h_03() {
    assert_page_count_recovered("hwpx-h-03", &load_sample("hwpx-h-03.hwpx"));
}

// ============================================================
// Stage 5 — 통합 진입점 export_hwp_with_adapter() 검증
// ============================================================

#[test]
fn stage5_export_hwp_with_adapter_hwpx_source_recovers_pages() {
    let bytes = load_sample("hwpx-h-01.hwpx");
    let mut core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드");
    let orig = core.page_count();

    let hwp_bytes = core.export_hwp_with_adapter().expect("HWP 직렬화");
    let reloaded = DocumentCore::from_bytes(&hwp_bytes).expect("HWP 재로드");

    assert_eq!(
        reloaded.page_count(),
        orig,
        "어댑터 통합 진입점: 페이지 수 보존 (orig={}, reloaded={})",
        orig,
        reloaded.page_count()
    );
}

#[test]
fn stage5_export_hwp_with_adapter_hwp_source_unchanged() {
    // HWP 원본 — 어댑터는 no-op (source_format != Hwpx)
    let path = "samples/hwp_table_test.hwp";
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let mut core = DocumentCore::from_bytes(&bytes).expect("HWP 로드");

    let bytes_native = core.export_hwp_native().expect("native 직렬화");
    let bytes_adapter = core.export_hwp_with_adapter().expect("adapter 직렬화");

    assert_eq!(
        bytes_native, bytes_adapter,
        "HWP 출처는 어댑터 호출이 native 와 동일 결과여야 함"
    );
}

#[test]
fn stage5_export_hwp_with_adapter_idempotent_on_repeated_calls() {
    // 같은 DocumentCore 에 export_hwp_with_adapter() 를 두 번 호출해도 저장 결과가 같다.
    // Stage #854부터 어댑터는 저장용 clone에만 적용되어 live IR을 변경하지 않는다.
    let bytes = load_sample("hwpx-h-01.hwpx");
    let mut core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드");

    let first = core.export_hwp_with_adapter().expect("1차");
    let second = core.export_hwp_with_adapter().expect("2차");

    assert_eq!(
        first, second,
        "동일 DocumentCore 에 어댑터 통합 진입점 2회 호출 시 같은 bytes"
    );

    use rhwp::document_core::converters::hwpx_to_hwp::HWPX_ORIGIN_STREAM_PATH;
    assert!(
        !core
            .document()
            .extra_streams
            .iter()
            .any(|(path, _)| path == HWPX_ORIGIN_STREAM_PATH),
        "HWP 저장용 origin 마커가 라이브 HWPX IR을 변경하면 안 됨",
    );
}

#[test]
fn stage5_all_three_samples_recover_via_unified_entry_point() {
    for name in ["hwpx-h-01.hwpx", "hwpx-h-02.hwpx", "hwpx-h-03.hwpx"] {
        let bytes = load_sample(name);
        let mut core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드");
        let orig = core.page_count();
        let expected = expected_hwp_page_count(name, orig);

        let hwp_bytes = core.export_hwp_with_adapter().expect("HWP 직렬화");
        let reloaded = DocumentCore::from_bytes(&hwp_bytes).expect("HWP 재로드");

        assert_eq!(
            reloaded.page_count(),
            expected,
            "{}: HWP 저장 기준 페이지 수 일치 (orig={}, expected_hwp={}, reloaded={})",
            name,
            orig,
            expected,
            reloaded.page_count()
        );
    }
}

// ============================================================
// Stage 6 — serialize_hwp_with_verify 명시 검증 함수
// ============================================================

#[test]
fn stage6_verify_recovered_for_hwpx_h_01() {
    let bytes = load_sample("hwpx-h-01.hwpx");
    let mut core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드");
    let v = core.serialize_hwp_with_verify().expect("verify");
    eprintln!(
        "[#178 Stage 6] verify hwpx-h-01: before={}, after={}, recovered={}, bytes={}",
        v.page_count_before, v.page_count_after, v.recovered, v.bytes_len
    );
    assert!(
        v.recovered,
        "페이지 회복 실패: before={} after={}",
        v.page_count_before, v.page_count_after
    );
    assert_eq!(v.page_count_before, v.page_count_after);
    assert!(v.page_count_matches);
    assert!(
        v.structure_matches,
        "구조 카운트 불일치: before={:?}, after={:?}, losses={:?}",
        v.structure_before, v.structure_after, v.serialization_losses
    );
    assert!(v.serialization_losses.is_empty());
    assert!(v.structure_before.text_count > 0);
    assert!(v.bytes_len > 0);
}

#[test]
fn stage6_verify_recovered_for_all_three_samples() {
    for name in ["hwpx-h-01.hwpx", "hwpx-h-02.hwpx", "hwpx-h-03.hwpx"] {
        let bytes = load_sample(name);
        let mut core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드");
        let v = core.serialize_hwp_with_verify().expect("verify");
        let expected = expected_hwp_page_count(name, v.page_count_before);
        assert_eq!(
            v.page_count_after, expected,
            "{}: HWP 저장 기준 페이지 수 불일치 before={} expected_hwp={} after={}",
            name, v.page_count_before, expected, v.page_count_after
        );
    }
}

#[test]
fn stage6_verify_for_hwp_source_also_recovered() {
    // HWP 출처 — 어댑터는 no-op, 그래도 verify 는 동작해야 함 (recovered=true)
    let path = "samples/hwp_table_test.hwp";
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let mut core = DocumentCore::from_bytes(&bytes).expect("HWP 로드");
    let v = core.serialize_hwp_with_verify().expect("verify");
    assert!(v.recovered, "HWP 출처 자기 재로드 페이지 수 일치");
}

fn first_line_vpos(core: &DocumentCore, section_idx: usize, para_idx: usize) -> i32 {
    core.document().sections[section_idx].paragraphs[para_idx].line_segs[0].vertical_pos
}

#[test]
fn task949_stage33_hwpx_h03_explicit_lineseg_vpos_preserved_on_load() {
    let bytes = load_sample("hwpx-h-03.hwpx");
    let core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드");

    assert_eq!(
        first_line_vpos(&core, 0, 18),
        68258,
        "HWPX source lineSegArray의 명시 vertpos를 자동 reflow가 덮어쓰면 안 됨"
    );
}

#[test]
fn task949_stage33_hwpx_h03_explicit_lineseg_vpos_survives_adapter_export_reload() {
    let bytes = load_sample("hwpx-h-03.hwpx");
    let mut core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드");

    let hwp_bytes = core.export_hwp_with_adapter().expect("HWP 직렬화");
    let reloaded = DocumentCore::from_bytes(&hwp_bytes).expect("HWP 재로드");

    assert_eq!(
        first_line_vpos(&reloaded, 0, 18),
        68258,
        "HWPX -> HWP 저장/재로드 후에도 paragraph 18의 lineSeg vpos가 보존되어야 함"
    );
}

#[test]
fn stage5_wasm_api_export_hwp_uses_adapter() {
    // wasm_api 의 export_hwp (네이티브 래퍼: export_hwp_native_wrapper 가 아니라
    // HwpDocument 자체가 DerefMut<DocumentCore>) 가 어댑터를 자동 적용하는지 확인.
    // 본 테스트는 네이티브 환경에서 wasm_api 진입점 동작을 검증.
    let bytes = load_sample("hwpx-h-01.hwpx");
    let mut doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes).expect("HWPX 로드");
    let orig = doc.page_count();

    // export_hwp 는 wasm_bindgen 메서드라 직접 호출 불가 → 동등한 export_hwp_with_adapter 호출
    let hwp_bytes = doc.export_hwp_with_adapter().expect("어댑터 직렬화");
    let reloaded = DocumentCore::from_bytes(&hwp_bytes).expect("HWP 재로드");

    assert_eq!(
        reloaded.page_count(),
        orig as u32,
        "wasm_api 경로: 페이지 수 보존 (orig={}, reloaded={})",
        orig,
        reloaded.page_count()
    );
}

#[test]
fn task903_hwpx_h_01_section_count_is_materialized_by_adapter() {
    let bytes = load_sample("hwpx-h-01.hwpx");
    let mut core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드 실패");
    let expected_section_count = core.document().sections.len() as u16;

    assert_eq!(
        expected_section_count, 2,
        "fixture는 2개 section으로 구성되어야 함"
    );
    assert_ne!(
        core.document().doc_properties.section_count,
        expected_section_count,
        "HWPX parser baseline은 section_count를 아직 보정하지 않아야 함"
    );

    let report = convert_hwpx_to_hwp_ir(core.document_mut());

    assert_eq!(
        report.file_header_compression_normalized, 1,
        "어댑터가 HWPX 출처 FileHeader를 compressed HWP5 저장 관례로 보정해야 함"
    );
    assert!(
        core.document().header.compressed,
        "HWP 저장 전 FileHeader.compressed=true여야 함"
    );
    assert_eq!(
        core.document().header.flags & 0x01,
        0x01,
        "HWP 저장 전 FileHeader flags에 compressed bit가 켜져야 함"
    );
    assert_eq!(
        report.doc_properties_section_count_normalized, 1,
        "어댑터가 DocProperties.section_count를 한 번 보정해야 함"
    );
    assert_eq!(
        core.document().doc_properties.section_count,
        expected_section_count,
        "HWP 저장 전 DocProperties.section_count는 실제 section 수와 같아야 함"
    );
    assert!(
        core.document().doc_properties.raw_data.is_none(),
        "DOCUMENT_PROPERTIES raw_data가 남으면 보정값이 직렬화되지 않음"
    );
    assert!(
        core.document().doc_info.raw_stream_dirty,
        "DocInfo raw stream을 재직렬화해야 section_count 보정이 HWP에 반영됨"
    );
}

#[test]
fn task903_hwpx_h_01_para_shape_margin_children_are_parsed() {
    let bytes = load_sample("hwpx-h-01.hwpx");
    let core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드 실패");
    let reference_bytes =
        std::fs::read("samples/hwpx/hancom-hwp/hwpx-h-01.hwp").expect("한컴 정답 HWP 필요");
    let reference = DocumentCore::from_bytes(&reference_bytes).expect("한컴 정답 HWP 파싱 실패");

    let source_shapes = &core.document().doc_info.para_shapes;
    let reference_shapes = &reference.document().doc_info.para_shapes;
    assert!(
        source_shapes.len() > 20 && reference_shapes.len() > 20,
        "fixture는 ParaShape 20개 이상을 가져야 함"
    );

    for idx in [10usize, 17, 20] {
        let actual = &source_shapes[idx];
        let expected = &reference_shapes[idx];
        assert_eq!(actual.indent, expected.indent, "ParaShape[{}].indent", idx);
        assert_eq!(
            actual.margin_left, expected.margin_left,
            "ParaShape[{}].margin_left",
            idx
        );
        assert_eq!(
            actual.margin_right, expected.margin_right,
            "ParaShape[{}].margin_right",
            idx
        );
        assert_eq!(
            actual.spacing_before, expected.spacing_before,
            "ParaShape[{}].spacing_before",
            idx
        );
        assert_eq!(
            actual.spacing_after, expected.spacing_after,
            "ParaShape[{}].spacing_after",
            idx
        );
    }

    assert_eq!(source_shapes[10].indent, -2800);
    assert_eq!(source_shapes[17].margin_left, 3000);
    assert_eq!(source_shapes[20].spacing_after, 1000);
}

#[test]
fn task903_stage31_restart_generate_impl_verify() {
    let bytes = load_sample("hwpx-h-01.hwpx");
    let mut core = DocumentCore::from_bytes(&bytes).expect("HWPX 로드 실패");
    let hwp_bytes = core.export_hwp_with_adapter().expect("HWP 직렬화 실패");

    let reloaded = DocumentCore::from_bytes(&hwp_bytes).expect("HWP 재로드 실패");
    assert!(
        hwp_bytes.len() < 600_000,
        "Stage31 restart 산출물은 compressed 저장으로 600KB 미만이어야 함 (actual={})",
        hwp_bytes.len()
    );
    assert!(
        reloaded.document().header.compressed,
        "Stage31 restart 산출물은 FileHeader.compressed=true여야 함"
    );
    assert_eq!(
        reloaded.document().header.flags & 0x01,
        0x01,
        "Stage31 restart 산출물은 FileHeader compressed bit가 켜져야 함"
    );
    assert_eq!(
        reloaded.document().doc_properties.section_count,
        2,
        "Stage31 restart 산출물은 DOCUMENT_PROPERTIES section_count=2를 가져야 함"
    );
    assert_eq!(
        reloaded.page_count(),
        9,
        "Stage31 restart 산출물은 rhwp-studio 기준 9페이지를 유지해야 함"
    );
}

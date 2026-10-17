//! Issue #1785: 셀 안 여백 선택 규칙은 레이아웃과 높이 측정이 단일 출처를 공유해야 한다.
//!
//! 셀의 hasMargin=false 는 0을 포함한 표 안 여백을 상속한다. hasMargin=true 는
//! 셀 값을 사용하고, 음수 결측 센티널만 표 값으로 폴백한다. 측정과 그리기는 같은
//! 선택 규칙을 사용해야 하며 HWPX→HWP 어댑터가 micro-grid width_ref bit0를 켤 때도
//! 바뀐 플래그에 맞춰 유효 여백을 물질화해야 한다.
//!
//! 종전 cell>table/2500HU 휴리스틱은 hasMargin=false/table=0 에서 저장 셀 값을
//! 채택했다. Polaris mode3의 getBorderMargin(true)는 이때 표의 0을 상속한다.
//! 아래 원본/재파스 기하 검사는 여백 선택과 별개인 왕복 일관성 계약을 유지한다.

use std::fs;
use std::path::Path;

use rhwp::model::table::Cell;
use rhwp::model::Padding;

const SAMPLE: &str = "samples/task1772/table_outer_margin_common_sync.hwpx";

fn pad(v: i16) -> Padding {
    Padding {
        left: v,
        right: v,
        top: v,
        bottom: v,
    }
}

#[test]
fn issue_1785_effective_padding_rule() {
    // hasMargin=false → 저장 셀 값과 무관하게 표의 명시적 0을 상속한다
    let mut cell = Cell {
        padding: pad(140),
        ..Default::default()
    };
    cell.apply_inner_margin = false;
    assert_eq!(cell.effective_padding(&pad(0)).top, 0);

    // hasMargin=false → 0이 아닌 표 기본값도 그대로 상속한다
    assert_eq!(cell.effective_padding(&pad(140)).top, 140);
    assert_eq!(cell.effective_padding(&pad(200)).top, 200);

    // 큰 저장 셀 값에도 같은 플래그 규칙을 적용한다
    cell.padding = pad(2834);
    assert_eq!(cell.effective_padding(&pad(0)).top, 0);

    // aim=true → 셀 값. [#2070] 0 도 사용자가 지정한 셀 고유 안 여백으로 존중
    // (한글 PDF 실측: 시장구조조사 pad=0 셀의 코드 폭 37.0px > 표 폴백 inner
    // 26.5px — 폴백이면 물리적으로 1줄 배치 불가). 음수(결측 센티널)만 표 폴백.
    cell.apply_inner_margin = true;
    cell.padding = pad(141);
    assert_eq!(cell.effective_padding(&pad(0)).top, 141);
    cell.padding = pad(0);
    assert_eq!(cell.effective_padding(&pad(140)).top, 0);
    cell.padding = pad(-1);
    assert_eq!(cell.effective_padding(&pad(140)).top, 140);
}

fn table_bboxes(doc: &rhwp::wasm_api::HwpDocument) -> Vec<(f64, f64)> {
    let tree = doc
        .build_page_render_tree(0)
        .unwrap_or_else(|e| panic!("render tree: {:?}", e));
    let json: serde_json::Value =
        serde_json::from_str(&tree.root.to_json()).expect("parse tree json");
    fn collect(v: &serde_json::Value, out: &mut Vec<(f64, f64)>) {
        if let Some(o) = v.as_object() {
            if o.get("type").and_then(|t| t.as_str()) == Some("Table") {
                if let Some(b) = o.get("bbox") {
                    out.push((
                        b.get("y").and_then(|y| y.as_f64()).unwrap_or(-1.0),
                        b.get("height").and_then(|h| h.as_f64()).unwrap_or(-1.0),
                    ));
                }
            }
            for c in o.values() {
                collect(c, out);
            }
        } else if let Some(a) = v.as_array() {
            for c in a {
                collect(c, out);
            }
        }
    }
    let mut out = Vec::new();
    collect(&json, &mut out);
    out
}

#[test]
fn issue_1785_roundtrip_preserves_microgrid_table_geometry() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(SAMPLE);
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {}: {}", SAMPLE, e));
    let mut doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes)
        .unwrap_or_else(|e| panic!("parse {}: {}", SAMPLE, e));
    let original = table_bboxes(&doc);

    let hwp_bytes = doc
        .export_hwp_with_adapter()
        .unwrap_or_else(|e| panic!("adapter export: {:?}", e));
    let rt_doc = rhwp::wasm_api::HwpDocument::from_bytes(&hwp_bytes)
        .unwrap_or_else(|e| panic!("reparse hwp: {:?}", e));
    let roundtrip = table_bboxes(&rt_doc);

    assert_eq!(original.len(), roundtrip.len(), "표 개수 보존");
    for (i, (a, b)) in original.iter().zip(roundtrip.iter()).enumerate() {
        assert!(
            (a.0 - b.0).abs() < 0.5 && (a.1 - b.1).abs() < 0.5,
            "표[{}] 라운드트립 기하 불일치: 원본 y={:.2} h={:.2} vs 재파스 y={:.2} h={:.2} \
             (수정 전 결함: 발신명의 micro-grid 표 h 244.9 → 254.2)",
            i,
            a.0,
            a.1,
            b.0,
            b.1
        );
    }
}

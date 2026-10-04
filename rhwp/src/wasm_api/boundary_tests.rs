//! wasm 경계 회귀 — export 는 스튜디오와 에이전트 도구에서 임의 인자로 불린다.
//! panic 한 번이 wasm 에선 unreachable trap 이 되어 세션 전체의 엔진을 멈추므로,
//! 적대적 인자에도 panic·무한 루프 없이 타입 있는 결과를 돌려주고 인스턴스가
//! 계속 동작해야 한다.
//!
//! wasm-bindgen 의 `JsValue` 는 네이티브 테스트에서 만들 수 없어, `Err(JsValue)` 로
//! 끝나는 경계 검사는 코어 `_native` 경로의 무패닉으로 대신 검증한다.

use super::*;
use serde_json::Value;
use std::time::{Duration, Instant};

const HOSTILE_SAMPLES: [&str; 3] = [
    "samples/hwp_table_test.hwp",
    "samples/footnote-01.hwp",
    "samples/누름틀-2024.hwpx",
];

fn load(path: &str) -> HwpDocument {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    HwpDocument::from_bytes(&bytes).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn assert_json(path: &str, what: &str, json: &str) -> Value {
    serde_json::from_str(json).unwrap_or_else(|e| panic!("{path} {what}: {e} — {json}"))
}

/// 적대적 호출 뒤에도 같은 인스턴스가 조판·저장을 계속할 수 있어야 한다.
fn assert_still_working(path: &str, doc: &HwpDocument) {
    assert!(doc.page_count() > 0, "{path}: 쪽 수");
    assert!(doc.export_hwpx_native().is_ok(), "{path}: HWPX 저장");
    assert!(doc.export_hwp().is_ok(), "{path}: HWP 저장");
}

fn section_one_first_table(doc: &HwpDocument) -> Option<(usize, usize)> {
    doc.document.sections[0]
        .paragraphs
        .iter()
        .enumerate()
        .find_map(|(pi, para)| {
            para.controls
                .iter()
                .position(|ctrl| matches!(ctrl, Control::Table(_)))
                .map(|ci| (pi, ci))
        })
}

/// F11/Shift+F11/탭 이동 export 는 범위 밖 구역·문단·컨트롤 번호에도 panic 없이
/// `{"type":"none"}` 류의 결과를 즉시 돌려준다. 셀 안 문단 번호가 본문 문단 수를 넘는
/// 표 문서에서 F11 을 누르면 종전엔 인덱싱 panic(=trap)이 났고, 큰 구역 번호는 약
/// 40억 번 헛돌았다.
#[test]
fn hostile_control_navigation_arguments_return_none_without_panicking() {
    for path in HOSTILE_SAMPLES {
        let doc = load(path);
        let sec_count = doc.document.sections.len() as u32;
        let body_len = doc.document.sections[0].paragraphs.len() as u32;
        let started = Instant::now();
        for sec in [0, sec_count, sec_count + 1, u32::MAX] {
            for para in [0, body_len, body_len + 1, body_len + 3, u32::MAX] {
                let in_range = sec < sec_count
                    && (para as usize) < doc.document.sections[sec as usize].paragraphs.len();
                for ci in [-1, 0, 50, i32::MAX, i32::MIN] {
                    for delta in [-1, 0, 1, i32::MAX] {
                        let json = doc.find_next_editable_control(sec, para, ci, delta);
                        let value = assert_json(path, "findNextEditableControl", &json);
                        if !in_range {
                            assert_eq!(value["type"], "none", "{path} ({sec},{para})");
                        }
                    }
                }
                for offset in [0, 5, u32::MAX] {
                    for json in [
                        doc.find_nearest_control_backward(sec, para, offset),
                        doc.find_nearest_control_forward(sec, para, offset),
                    ] {
                        let value = assert_json(path, "findNearestControl*", &json);
                        if !in_range {
                            assert_eq!(value["type"], "none", "{path} ({sec},{para})");
                        }
                    }
                }
            }
        }

        // 코어는 경계를 거치지 않는 네이티브 호출자도 있으므로 스스로 범위를 지킨다.
        let sec_len = doc.document.sections.len();
        let body_len = body_len as usize;
        for sec in [0, sec_len, usize::MAX] {
            for para in [body_len, body_len + 3, usize::MAX] {
                for ci in [-1, 7, i32::MAX] {
                    for delta in [-1, 1] {
                        let json = doc.find_next_editable_control_native(sec, para, ci, delta);
                        assert_json(path, "find_next_editable_control_native", &json);
                    }
                }
                for offset in [0, usize::MAX] {
                    let json = doc.find_nearest_control_backward_native(sec, para, offset);
                    assert_json(path, "find_nearest_control_backward_native", &json);
                    let json = doc.find_nearest_control_forward_native(sec, para, offset);
                    assert_json(path, "find_nearest_control_forward_native", &json);
                }
            }
        }
        // 컨트롤 번호가 문단의 컨트롤 수를 넘어도 뒤쪽 탐색은 문단 끝에서 출발한다.
        if let Some((pi, ci)) = section_one_first_table(&doc) {
            let json = doc.find_next_editable_control(0, pi as u32, i32::MAX, -1);
            let value = assert_json(path, "findNextEditableControl", &json);
            assert_eq!(value["para"], pi as u64, "{path}: {json}");
            assert!(
                value["ci"].as_u64().is_some_and(|found| found >= ci as u64),
                "{path}: {json}"
            );
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{path}: 컨트롤 탐색이 문서 크기와 무관하게 끝나야 한다 ({:?})",
            started.elapsed()
        );
        assert_still_working(path, &doc);
    }
}

/// 방향 0 은 머리말/꼬리말 쪽 이동을 제자리 무한 루프로 만들었다.
#[test]
fn hostile_header_footer_navigation_direction_terminates() {
    for path in HOSTILE_SAMPLES {
        let doc = load(path);
        let last = doc.page_count().saturating_sub(1);
        let started = Instant::now();
        for page in [0, last, u32::MAX] {
            for is_header in [false, true] {
                let json = doc
                    .navigate_header_footer_by_page(page, is_header, 0)
                    .unwrap_or_else(|_| panic!("{path}: 방향 0"));
                assert_eq!(json, "{\"ok\":false}", "{path}");
                for direction in [i32::MIN, -1, 1, i32::MAX] {
                    let json = doc
                        .navigate_header_footer_by_page(page, is_header, direction)
                        .unwrap_or_else(|_| panic!("{path}: 방향 {direction}"));
                    assert_json(path, "navigateHeaderFooterByPage", &json);
                }
            }
        }
        assert!(started.elapsed() < Duration::from_secs(10), "{path}");
        assert_still_working(path, &doc);
    }
}

/// NaN·무한대 좌표가 코어 히트테스트의 `partial_cmp().unwrap()` 에 닿으면 panic 했다.
/// export 는 경계에서 거절하고, 코어도 비유한 좌표에 panic 하지 않는다.
#[test]
fn hostile_hit_test_coordinates_do_not_panic() {
    for path in HOSTILE_SAMPLES {
        let mut doc = load(path);
        let expected = doc
            .hit_test_native(0, 100.0, 120.0)
            .expect("정상 히트테스트");
        let pages = doc.page_count();
        for page in [0, pages, u32::MAX] {
            for (x, y) in [
                (100.0, f64::NAN),
                (f64::NAN, 100.0),
                (f64::NAN, f64::NAN),
                (f64::INFINITY, 100.0),
                (100.0, f64::NEG_INFINITY),
                (-1.0e300, 1.0e300),
            ] {
                let _ = doc.hit_test_native(page, x, y);
                let _ = doc.hit_test_header_footer_native(page, x, y);
                let _ = doc.hit_test_in_header_footer_native(page, true, x, y);
                let _ = doc.hit_test_footnote_native(page, x, y);
                let _ = doc.hit_test_in_footnote_native(page, x, y);
                let _ = doc.hit_test_body_footnote_marker_native(page, x, y);
                let _ = doc.core.get_form_object_at_native(page, x, y);
            }
        }
        // 비유한 preferredX 는 미지정(-1)으로 바뀌어 코어에 닿는다.
        for preferred_x in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let json = doc
                .move_vertical(0, 0, 0, 1, preferred_x, u32::MAX, 0, 0, 0)
                .unwrap_or_else(|_| panic!("{path}: moveVertical"));
            assert_json(path, "moveVertical", &json);
        }
        // 0·음수·NaN DPI 는 무시해 조판 좌표를 오염시키지 않는다.
        for dpi in [f64::NAN, 0.0, -96.0, f64::INFINITY] {
            doc.set_dpi(dpi);
        }
        assert_eq!(doc.page_count(), pages, "{path}: 잘못된 DPI 는 무시");
        assert_eq!(
            doc.hit_test_native(0, 100.0, 120.0)
                .expect("정상 히트테스트"),
            expected,
            "{path}: 적대적 좌표 뒤에도 같은 히트 결과"
        );
        assert_still_working(path, &doc);
    }
}

/// 끝 오프셋 -1(u32::MAX)로 글자 서식을 적용하면 run 계산이 끝값까지 돌며 매 칸 O(n)
/// 조회를 해 UI 스레드가 사실상 멈췄다. 이제 즉시 끝나고 문단 끝까지 적용된다.
#[test]
fn hostile_char_format_end_offset_applies_to_paragraph_end_quickly() {
    let bold = |doc: &HwpDocument, para: &Paragraph| -> Vec<bool> {
        (0..para.char_offsets.len())
            .map(|i| {
                let id = para.char_shape_id_at(i).unwrap_or(0) as usize;
                doc.document.doc_info.char_shapes[id].bold
            })
            .collect()
    };

    let mut doc = load("samples/hwp_table_test.hwp");
    let pi = doc.document.sections[0]
        .paragraphs
        .iter()
        .position(|p| p.char_offsets.len() >= 2 && p.controls.is_empty())
        .expect("텍스트 문단");
    let started = Instant::now();
    doc.apply_char_format(0, pi, 0, u32::MAX as usize, r#"{"bold":true}"#)
        .unwrap_or_else(|_| panic!("본문 서식"));
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "본문 서식 적용이 즉시 끝나야 한다 ({:?})",
        started.elapsed()
    );
    let para = doc.document.sections[0].paragraphs[pi].clone();
    assert!(bold(&doc, &para).iter().all(|b| *b), "문단 끝까지 굵게");

    let (host, ci) = section_one_first_table(&doc).expect("표");
    let cell_para = match &doc.document.sections[0].paragraphs[host].controls[ci] {
        Control::Table(table) => table.cells[0].paragraphs[0].clone(),
        _ => unreachable!(),
    };
    let started = Instant::now();
    doc.apply_char_format_in_cell_by_path(
        0,
        host,
        &[(ci, 0, 0)],
        0,
        u32::MAX as usize,
        r#"{"bold":true}"#,
    )
    .expect("셀 서식");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "셀 서식 적용이 즉시 끝나야 한다 ({:?})",
        started.elapsed()
    );
    let after = match &doc.document.sections[0].paragraphs[host].controls[ci] {
        Control::Table(table) => table.cells[0].paragraphs[0].clone(),
        _ => unreachable!(),
    };
    if !cell_para.char_offsets.is_empty() {
        assert!(bold(&doc, &after).iter().all(|b| *b), "셀 문단 끝까지 굵게");
    }
    assert_still_working("samples/hwp_table_test.hwp", &doc);
}

// ─── 스타일 삭제: 문서 전체 참조 재배정 + undo ───────────────────────────

fn first_cell_paragraph_mut(
    doc: &mut HwpDocument,
    sec: usize,
    pi: usize,
    ci: usize,
) -> &mut Paragraph {
    match &mut doc.core.document.sections[sec].paragraphs[pi].controls[ci] {
        Control::Table(table) => &mut table.cells[0].paragraphs[0],
        _ => panic!("표 컨트롤이어야 한다"),
    }
}

/// deleteStyle 은 표 셀 문단의 참조도 옮기고, 스냅샷 undo/redo 가 재배정 전후를 정확히
/// 되살려야 한다. 종전엔 본문 문단만 옮겨 셀 문단이 삭제된 ID 뒤의 엉뚱한 스타일을
/// 가리켰고, revision 을 올리지 않아 undo 가 스타일 목록만 되돌리고 문단 ID 는 당겨진
/// 채 남겼다.
#[test]
fn delete_style_remaps_nested_paragraphs_and_undo_restores_them() {
    let mut doc = load("samples/hwp_table_test.hwp");
    let style_count = doc.document.doc_info.styles.len();
    assert!(style_count > 3, "샘플 스타일 수: {style_count}");
    let (pi, ci) = section_one_first_table(&doc).expect("표");
    doc.core.document.sections[0].paragraphs[0].style_id = 2;
    first_cell_paragraph_mut(&mut doc, 0, pi, ci).style_id = 2;

    let before = doc.save_snapshot_native();
    assert!(doc.delete_style(1));
    let after = doc.save_snapshot_native();

    let ids = |doc: &mut HwpDocument| {
        (
            doc.document.sections[0].paragraphs[0].style_id,
            first_cell_paragraph_mut(doc, 0, pi, ci).style_id,
        )
    };
    assert_eq!(
        ids(&mut doc),
        (1, 1),
        "본문과 셀 문단이 함께 한 칸 당겨져야 한다"
    );
    assert_eq!(doc.document.doc_info.styles.len(), style_count - 1);

    doc.restore_snapshot_native(before).expect("undo");
    assert_eq!(doc.document.doc_info.styles.len(), style_count);
    assert_eq!(
        ids(&mut doc),
        (2, 2),
        "undo 는 재배정 전 문단 ID 를 되살려야 한다"
    );

    doc.restore_snapshot_native(after).expect("redo");
    assert_eq!(doc.document.doc_info.styles.len(), style_count - 1);
    assert_eq!(
        ids(&mut doc),
        (1, 1),
        "redo 는 재배정 뒤 문단 ID 를 되살려야 한다"
    );
}

/// 각주·머리말/꼬리말·바탕쪽 문단의 스타일 참조도 삭제에 맞춰 옮긴다.
#[test]
fn delete_style_remaps_footnote_and_master_page_paragraphs() {
    use crate::model::header_footer::MasterPage;

    fn nested_first_paragraphs(doc: &mut HwpDocument) -> Vec<&mut Paragraph> {
        let mut out = Vec::new();
        for para in &mut doc.core.document.sections[0].paragraphs {
            for ctrl in &mut para.controls {
                let paragraphs = match ctrl {
                    Control::Footnote(note) => &mut note.paragraphs,
                    Control::Header(header) => &mut header.paragraphs,
                    Control::Footer(footer) => &mut footer.paragraphs,
                    _ => continue,
                };
                if let Some(first) = paragraphs.first_mut() {
                    out.push(first);
                }
            }
        }
        out
    }

    let mut doc = load("samples/footnote-01.hwp");
    assert!(doc.document.doc_info.styles.len() > 4);
    let nested = nested_first_paragraphs(&mut doc);
    assert!(!nested.is_empty(), "샘플에 각주가 있어야 한다");
    for para in nested {
        para.style_id = 4;
    }
    doc.core.document.sections[0]
        .section_def
        .master_pages
        .push(MasterPage {
            paragraphs: vec![Paragraph {
                style_id: 4,
                ..Default::default()
            }],
            ..Default::default()
        });

    let before = doc.save_snapshot_native();
    assert!(doc.delete_style(2));

    for para in nested_first_paragraphs(&mut doc) {
        assert_eq!(para.style_id, 3, "안쪽 문단 참조가 한 칸 당겨져야 한다");
    }
    let master_style = |doc: &HwpDocument| {
        doc.document.sections[0].section_def.master_pages[0].paragraphs[0].style_id
    };
    assert_eq!(master_style(&doc), 3, "바탕쪽 문단 참조도 옮겨야 한다");

    doc.restore_snapshot_native(before).expect("undo");
    assert_eq!(
        master_style(&doc),
        4,
        "undo 는 바탕쪽 문단 참조도 되살려야 한다"
    );
    for para in nested_first_paragraphs(&mut doc) {
        assert_eq!(para.style_id, 4, "undo 는 안쪽 문단 참조도 되살려야 한다");
    }
}

/// 문단 스타일 참조는 u8 이라 256 번째를 넘는 스타일은 만들지 않는다.
#[test]
fn create_style_rejects_ids_past_u8_range() {
    use crate::model::style::Style;
    let mut doc = HwpDocument::create_empty();
    let styles = &mut doc.core.document.doc_info.styles;
    while styles.len() < 255 {
        styles.push(Style::default());
    }
    assert_eq!(doc.create_style(r#"{"name":"마지막"}"#), 255);
    assert_eq!(doc.create_style(r#"{"name":"넘침"}"#), -1);
    assert_eq!(doc.document.doc_info.styles.len(), 256);
}

/// HWP3 변환 문서에서 스타일을 만들거나 지워도 로드 때의 HWP3 문단 보정을 유지한다.
/// 종전엔 보정 없는 `resolve_styles` 로 캐시를 덮어 다음 조판에서 여백·간격이 바뀌었다.
#[test]
fn create_and_delete_style_keep_hwp3_style_variant() {
    let mut doc = load("samples/hwp3-sample-hwp5.hwp");
    assert!(
        doc.document.layout_profile().hwp3_layout(),
        "HWP3 변환본이어야 이 회귀를 재현한다"
    );
    let pages = doc.page_count();
    let loaded = format!("{:?}", doc.styles);

    let id = doc.create_style(r#"{"name":"검증"}"#);
    assert!(id > 0);
    assert_eq!(
        format!("{:?}", doc.styles),
        format!("{:?}", doc.resolve_document_styles()),
        "createStyle 은 HWP3 변형 보정으로 재해소해야 한다"
    );
    for sec in 0..doc.document.sections.len() {
        doc.core.rebuild_section(sec);
    }
    assert_eq!(
        doc.page_count(),
        pages,
        "스타일 추가만으로 쪽 수가 바뀌면 안 된다"
    );

    assert!(doc.delete_style(id as u32));
    assert_eq!(format!("{:?}", doc.styles), loaded);
    for sec in 0..doc.document.sections.len() {
        doc.core.rebuild_section(sec);
    }
    assert_eq!(
        doc.page_count(),
        pages,
        "스타일 삭제만으로 쪽 수가 바뀌면 안 된다"
    );
}

#[test]
fn font_fallback_families_preserve_renderer_order_even_with_baked_metrics() {
    let read = |family: &str| -> Vec<String> {
        serde_json::from_str(&super::font_fallback_families(family, None)).unwrap()
    };
    assert!(crate::renderer::font_metrics_data::find_metric("HY신명조", false, false).is_some());
    assert_eq!(
        read("HY신명조"),
        vec!["함초롬바탕", "HCR Batang", "한컴바탕", "Haansoft Batang"]
    );
    assert_eq!(read(" 한양견고딕 "), vec!["HY견고딕", "HYgtrE"]);
    assert_eq!(
        read("HCI Poppy"),
        vec!["Palatino", "Palatino Linotype", "Book Antiqua"]
    );
    assert!(read("Arial").is_empty());
    assert!(read("함초롬돋움").is_empty());
    assert_eq!(read("Absent Test Face"), vec!["함초롬돋움", "HCR Dotum"]);
}

#[test]
fn document_font_substitute_precedes_generic_but_keeps_hft_mapping_first() {
    let families = |family: &str, subst: &str| -> Vec<String> {
        serde_json::from_str(&super::font_fallback_families(family, Some(subst.into()))).unwrap()
    };
    assert_eq!(
        families("Uninstalled document font", "한컴바탕"),
        vec!["한컴바탕", "함초롬돋움", "HCR Dotum"]
    );
    assert_eq!(families("KoPub돋움체 Light", "한컴바탕"), vec!["한컴바탕"]);
    assert_eq!(
        families("Uninstalled document font", "HCR Batang"),
        vec!["함초롬돋움", "HCR Dotum"]
    );
    assert_eq!(
        families("Uninstalled document font", "함초롬바탕"),
        vec!["함초롬바탕", "함초롬돋움", "HCR Dotum"]
    );
    assert!(families("HCR Batang", "").is_empty());
    assert_eq!(
        families("HY신명조", "한컴바탕"),
        vec!["한컴바탕", "함초롬바탕", "HCR Batang", "Haansoft Batang"]
    );
    let poppy = families("HCI Poppy", "한컴바탕");
    let explicit = poppy.iter().position(|name| name == "한컴바탕").unwrap();
    assert!(poppy[..explicit]
        .iter()
        .any(|name| name.contains("Palatino")));
}

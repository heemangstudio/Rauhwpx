//! 편집 캐럿 좌표(인라인 수식 = 1칸)와 텍스트 편집 API 의 계약.
//!
//! 캐럿·히트 테스트는 글자처럼 취급 개체를 1칸으로 세는 논리 오프셋을 쓰고, 텍스트
//! 삽입·삭제 API 는 텍스트 오프셋을 받는다. 둘을 섞으면 수식 뒤 입력이 한 칸 밀리고,
//! 문단 끝 입력은 char_offsets 가 문단 범위를 벗어나 렌더 TextRun 에서 빠진 채 캐럿이
//! 문단 첫 글자로 튀었다. Studio 는 `logical` 플래그로 논리 오프셋을 넘긴다.

use rhwp::model::control::Control;
use rhwp::model::paragraph::Paragraph;
use rhwp::wasm_api::HwpDocument;
use serde_json::Value;

fn rect(json: &str) -> (f64, f64) {
    let v: Value = serde_json::from_str(json).expect("cursor rect json");
    (v["x"].as_f64().unwrap(), v["y"].as_f64().unwrap())
}

/// 모든 글자의 UTF-16 위치가 증가하고 문단 끝 마커(char_count - 1) 앞에 있어야 한다.
fn assert_offsets_in_range(para: &Paragraph, label: &str) {
    let last = *para.char_offsets.last().unwrap();
    assert!(
        para.char_offsets.windows(2).all(|w| w[0] < w[1]) && last + 1 < para.char_count,
        "{label}: char_offsets 범위 이탈: {:?} (char_count={})",
        para.char_offsets,
        para.char_count
    );
}

/// 공백 캐럿은 마지막 보이는 글자 뒤 캐럿보다 왼쪽으로 가지 않고 같은 줄에 남는다.
fn assert_trailing_carets(rects: &[(f64, f64)], label: &str) {
    let (x0, y0) = rects[0];
    for (i, &(x, y)) in rects.iter().enumerate().skip(1) {
        assert!(
            x > rects[i - 1].0 && x >= x0,
            "{label}: 공백 {i} 캐럿 x 후퇴: {rects:?}"
        );
        assert!(
            (y - y0).abs() < 0.5,
            "{label}: 공백 {i} 캐럿이 줄을 벗어남: {rects:?}"
        );
    }
}

#[test]
fn 문단_중간_수식_뒤의_공백에서도_캐럿이_줄끝에_남는다() {
    // 본문: "앞 [수식]뒤." 뒤에 논리 끝 오프셋으로 공백 2개
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native().unwrap();
    doc.insert_text_native(0, 0, 0, "앞 ").unwrap();
    doc.insert_equation_native(0, 0, 2, "i", 1000, 0).unwrap();
    doc.insert_text_native(0, 0, 3, "뒤.").unwrap();
    doc.insert_text_native(0, 0, 5, " ").unwrap();
    doc.insert_text_native(0, 0, 6, " ").unwrap();
    let para = &doc.document().sections[0].paragraphs[0];
    assert_eq!(para.text, "앞 뒤.  ");
    assert_offsets_in_range(para, "본문");
    let body: Vec<_> = (4..=6)
        .map(|off| rect(&doc.get_cursor_rect_native(0, 0, off).unwrap()))
        .collect();
    assert_trailing_carets(&body, "본문");

    // 표 셀: "앞 [수식]를 측정한다." 뒤에 Studio 셀 캐럿(논리 오프셋)으로 공백 2개
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native().unwrap();
    let table: Value =
        serde_json::from_str(&doc.create_table_native(0, 0, 0, 1, 1).unwrap()).unwrap();
    let pp = table["paraIdx"].as_u64().unwrap() as usize;
    let ci = table["controlIdx"].as_u64().unwrap() as usize;
    doc.insert_text_in_cell_native(0, pp, ci, 0, 0, 0, "앞 ")
        .unwrap();
    doc.insert_equation_in_cell_native(0, pp, ci, 0, 0, 2, "i", 1000, 0)
        .unwrap();
    doc.insert_text_in_cell_native(0, pp, ci, 0, 0, 3, "를 측정한다.")
        .unwrap();
    // 논리 끝 = 텍스트 9자 + 수식 1칸 = 10
    doc.insert_text_in_cell_native(0, pp, ci, 0, 0, 10, " ")
        .unwrap();
    doc.insert_text_in_cell_native(0, pp, ci, 0, 0, 11, " ")
        .unwrap();
    let Control::Table(t) = &doc.document().sections[0].paragraphs[pp].controls[ci] else {
        panic!("표 컨트롤");
    };
    let cell_para = &t.cells[0].paragraphs[0];
    assert_eq!(cell_para.text, "앞 를 측정한다.  ");
    assert_offsets_in_range(cell_para, "셀");
    let cell: Vec<_> = (10..=12)
        .map(|off| {
            rect(
                &doc.get_cursor_rect_in_cell_native(0, pp, ci, 0, 0, off)
                    .unwrap(),
            )
        })
        .collect();
    assert_trailing_carets(&cell, "셀");
}

fn equation_text_positions(para: &Paragraph) -> Vec<usize> {
    let positions = para.control_text_positions();
    para.controls
        .iter()
        .enumerate()
        .filter(|(_, ctrl)| matches!(ctrl, Control::Equation(_)))
        .map(|(ci, _)| positions[ci])
        .collect()
}

#[test]
fn 논리_캐럿_편집은_인라인_수식_오른쪽의_텍스트를_보존한다() {
    let logical = Some(true);

    // 본문 "ab[수식]cd": 논리 a0 b1 [수식]2 c3 d4
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native().unwrap();
    doc.insert_text_native(0, 0, 0, "abcd").unwrap();
    doc.insert_equation_native(0, 0, 2, "i", 1000, 0).unwrap();
    doc.insert_text(0, 0, 3, "X", logical).unwrap();
    let para = &doc.document().sections[0].paragraphs[0];
    assert_eq!(para.text, "abXcd");
    assert_eq!(
        equation_text_positions(para),
        vec![2],
        "수식 뒤 캐럿 입력은 수식 뒤에 들어간다"
    );
    doc.delete_range(0, 0, 2, 0, 3, logical).unwrap();
    let para = &doc.document().sections[0].paragraphs[0];
    assert_eq!(para.text, "abXcd", "수식 칸 삭제는 글자를 지우지 않는다");
    assert!(
        equation_text_positions(para).is_empty(),
        "수식 칸 삭제는 수식을 지운다"
    );

    // 표 셀 "ab[수식]cd"
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native().unwrap();
    let table: Value =
        serde_json::from_str(&doc.create_table_native(0, 0, 0, 1, 1).unwrap()).unwrap();
    let pp = table["paraIdx"].as_u64().unwrap() as u32;
    let ci = table["controlIdx"].as_u64().unwrap() as u32;
    let cell_para = |doc: &HwpDocument| -> Paragraph {
        let Control::Table(t) =
            &doc.document().sections[0].paragraphs[pp as usize].controls[ci as usize]
        else {
            panic!("표 컨트롤");
        };
        t.cells[0].paragraphs[0].clone()
    };
    doc.insert_text_in_cell(0, pp, ci, 0, 0, 0, "abcd", logical)
        .unwrap();
    doc.insert_equation_in_cell_native(0, pp as usize, ci as usize, 0, 0, 2, "i", 1000, 0)
        .unwrap();
    doc.insert_text_in_cell(0, pp, ci, 0, 0, 3, "X", logical)
        .unwrap();
    doc.insert_text_in_cell(0, pp, ci, 0, 0, 2, "Y", logical)
        .unwrap();
    let para = cell_para(&doc);
    // 논리: a0 b1 Y2 [수식]3 X4 c5 d6
    assert_eq!(para.text, "abYXcd");
    assert_eq!(equation_text_positions(&para), vec![3]);
    assert_eq!(
        doc.get_text_in_cell(0, pp, ci, 0, 0, 4, 1, logical)
            .unwrap(),
        "X"
    );
    doc.delete_text_in_cell(0, pp, ci, 0, 0, 4, 1, logical)
        .unwrap();
    assert_eq!(cell_para(&doc).text, "abYcd");
    let path = format!(r#"[{{"controlIndex":{ci},"cellIndex":0,"cellParaIndex":0}}]"#);
    doc.delete_range_in_cell_by_path_api(0, pp, &path, 0, 2, 0, 4, logical)
        .unwrap();
    let para = cell_para(&doc);
    assert_eq!(para.text, "abcd", "Y 와 수식을 함께 지운다");
    assert!(equation_text_positions(&para).is_empty());
}

/// 문단의 수식을 controls 순서대로 (스크립트, 텍스트 위치) 로 돌려준다.
fn equations_in_order(para: &Paragraph) -> Vec<(String, usize)> {
    let positions = para.control_text_positions();
    para.controls
        .iter()
        .enumerate()
        .filter_map(|(ci, ctrl)| match ctrl {
            Control::Equation(eq) => Some((eq.script.clone(), positions[ci])),
            _ => None,
        })
        .collect()
}

#[test]
fn 논리_캐럿_수식_삽입은_캐럿_칸에_들어간다() {
    let logical = Some(true);
    let eqs = |doc: &HwpDocument| equations_in_order(&doc.document().sections[0].paragraphs[0]);
    let at = |script: &str, pos: usize| (script.to_string(), pos);

    // 본문 "a[A]bcdef": 논리 a0 [A]1 b2 c3 d4
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native().unwrap();
    doc.insert_text_native(0, 0, 0, "abcdef").unwrap();
    doc.insert_equation_native(0, 0, 1, "A", 1000, 0).unwrap();

    doc.insert_equation(0, 0, 4, "B", 1000, 0, logical).unwrap();
    assert_eq!(eqs(&doc), vec![at("A", 1), at("B", 3)], "c 와 d 사이");

    doc.insert_equation(0, 0, 1, "C", 1000, 0, logical).unwrap();
    assert_eq!(
        eqs(&doc),
        vec![at("C", 1), at("A", 1), at("B", 3)],
        "수식 바로 앞 캐럿은 그 수식 앞에 넣는다"
    );

    // a0 [C]1 [A]2 b3 — 캐럿 3 은 A 뒤, b 앞
    doc.insert_equation(0, 0, 3, "D", 1000, 0, logical).unwrap();
    assert_eq!(
        eqs(&doc),
        vec![at("C", 1), at("A", 1), at("D", 1), at("B", 3)],
        "수식 바로 뒤 캐럿은 그 수식 뒤에 넣는다"
    );

    // 글자 없는 문단: 이어서 넣은 수식이 넣은 순서대로 선다
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native().unwrap();
    for (caret, script) in ["A", "B", "C"].iter().enumerate() {
        doc.insert_equation(0, 0, caret as u32, script, 1000, 0, logical)
            .unwrap();
    }
    let order: Vec<String> = eqs(&doc).into_iter().map(|(script, _)| script).collect();
    assert_eq!(order, ["A", "B", "C"]);

    // 표 셀 "ab[E]cd": 캐럿 2 는 E 앞
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native().unwrap();
    let table: Value =
        serde_json::from_str(&doc.create_table_native(0, 0, 0, 1, 1).unwrap()).unwrap();
    let pp = table["paraIdx"].as_u64().unwrap() as u32;
    let ci = table["controlIdx"].as_u64().unwrap() as u32;
    doc.insert_text_in_cell(0, pp, ci, 0, 0, 0, "abcd", logical)
        .unwrap();
    doc.insert_equation_in_cell_native(0, pp as usize, ci as usize, 0, 0, 2, "E", 1000, 0)
        .unwrap();
    doc.insert_equation_in_cell(0, pp, ci, 0, 0, 2, "F", 1000, 0, logical)
        .unwrap();
    let Control::Table(t) =
        &doc.document().sections[0].paragraphs[pp as usize].controls[ci as usize]
    else {
        panic!("표 컨트롤");
    };
    assert_eq!(
        equations_in_order(&t.cells[0].paragraphs[0]),
        vec![at("F", 2), at("E", 2)]
    );
}

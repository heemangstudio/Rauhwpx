//! 저장 경로에서 문서를 깨거나 내용을 잃던 경우들 (한글 2022 로 확인한 사례).
//!
//! 각 테스트는 사용자가 하는 그대로 문서를 열고, 저장하고, 저장본을 다시 연 뒤
//! 내용이 그대로인지 본다. 한글이 거부하던 형식 계약(쪽 테두리 3개, 직선 좌표
//! 네임스페이스)은 한글 저장본과 같은 모양인지 확인한다.

use rhwp::model::control::Control;
use rhwp::model::document::Document;
use rhwp::model::paragraph::Paragraph;
use rhwp::model::shape::ShapeObject;
use rhwp::wasm_api::HwpDocument;

use crate::common::read_sample;

fn open(bytes: &[u8]) -> HwpDocument {
    HwpDocument::from_bytes(bytes).unwrap_or_else(|e| panic!("reopen saved file: {e:?}"))
}

fn save_hwp(doc: &HwpDocument) -> Vec<u8> {
    doc.export_hwp_with_adapter().expect("save as HWP")
}

fn save_hwpx(doc: &HwpDocument) -> Vec<u8> {
    doc.export_hwpx_native().expect("save as HWPX")
}

fn visit<'a>(paragraphs: &'a [Paragraph], f: &mut dyn FnMut(&'a Paragraph)) {
    fn shape<'a>(s: &'a ShapeObject, f: &mut dyn FnMut(&'a Paragraph)) {
        if let Some(text_box) = s.drawing().and_then(|d| d.text_box.as_ref()) {
            visit(&text_box.paragraphs, f);
        }
        if let ShapeObject::Group(group) = s {
            for child in &group.children {
                shape(child, f);
            }
        }
    }
    for para in paragraphs {
        f(para);
        for control in &para.controls {
            match control {
                Control::Table(table) => {
                    for cell in &table.cells {
                        visit(&cell.paragraphs, f);
                    }
                }
                Control::Shape(s) => shape(s, f),
                Control::Header(h) => visit(&h.paragraphs, f),
                Control::Footer(h) => visit(&h.paragraphs, f),
                Control::Footnote(n) => visit(&n.paragraphs, f),
                Control::Endnote(n) => visit(&n.paragraphs, f),
                _ => {}
            }
        }
    }
}

fn all_paragraphs(doc: &Document) -> Vec<&Paragraph> {
    let mut out = Vec::new();
    for section in &doc.sections {
        visit(&section.paragraphs, &mut |p| out.push(p));
    }
    out
}

fn texts(doc: &Document) -> Vec<String> {
    all_paragraphs(doc).iter().map(|p| p.text.clone()).collect()
}

fn count_controls(doc: &Document, pred: impl Fn(&Control) -> bool) -> usize {
    all_paragraphs(doc)
        .iter()
        .flat_map(|p| p.controls.iter())
        .filter(|c| pred(c))
        .count()
}

/// HWPX·HWP3 출처 필드는 ctrl_id 가 없다. HWP 로 저장할 때 0 을 써서, 다시 열면
/// 필드가 미지원 컨트롤로 바뀌어 메모·누름틀 같은 필드가 문서에서 사라졌다.
#[test]
fn fields_survive_hwp_to_hwpx_to_hwp() {
    let original = open(&read_sample("samples/basic/NewYear_s_Day.hwp"));
    let fields = count_controls(original.document(), |c| matches!(c, Control::Field(_)));
    assert!(fields > 0, "sample must contain fields");

    let via_hwpx = open(&save_hwpx(&original));
    let back = open(&save_hwp(&via_hwpx));

    assert_eq!(
        count_controls(back.document(), |c| matches!(c, Control::Field(_))),
        fields,
        "every field must still be a field after HWP -> HWPX -> HWP"
    );
    assert_eq!(
        count_controls(back.document(), |c| matches!(c, Control::Unknown(_))),
        0,
        "no field may turn into an unknown control"
    );
}

/// 구역 정의·단 정의 뒤에 오는 자동번호는 HWP 저장 때 자리를 잃고 문단 끝으로
/// 옮겨지며 공백이 하나 늘었다 (미주 번호 "문11）" 이 문단 끝에 찍힘).
#[test]
fn autonumber_after_section_controls_keeps_its_place_in_hwp() {
    let original = open(&read_sample("samples/hwpx/eq-002.hwpx"));
    let saved = open(&save_hwp(&original));
    assert_eq!(texts(saved.document()), texts(original.document()));
    let saved_again = open(&save_hwp(&saved));
    assert_eq!(texts(saved_again.document()), texts(original.document()));
}

/// HWP3 자동번호 placeholder 가 1 code unit 폭이라 HWP 저장 때마다 번호 앞 공백이
/// 하나씩 늘었다.
#[test]
fn hwp3_autonumber_does_not_gain_spaces_when_saved_as_hwp() {
    let original = open(&read_sample("samples/SO-SUEOP.hwp"));
    let saved = open(&save_hwp(&original));
    assert_eq!(texts(saved.document()), texts(original.document()));
}

/// HWP 를 HWPX 로 저장한 뒤 그 HWPX 를 다시 열어 저장하면, 표 뒤 run 의 책갈피와
/// 빈 hp:t 를 되살리지 못해 "작성된 빈 hp:t의 자식 구조를 복원할 수 없습니다" 로
/// 저장 자체가 거부됐다.
#[test]
fn hwpx_saved_from_hwp_can_be_saved_again() {
    for sample in [
        "samples/kps-ai.hwp",
        "samples/task2287/1342000_edu_curriculum_map.hwp",
    ] {
        let original = open(&read_sample(sample));
        let first = save_hwpx(&original);
        let reopened = open(&first);
        let second = reopened
            .export_hwpx_native()
            .unwrap_or_else(|e| panic!("{sample}: second HWPX save refused: {e:?}"));
        let again = open(&second);
        assert_eq!(
            texts(again.document()),
            texts(reopened.document()),
            "{sample}"
        );
    }
}

/// 직선 좌표를 hp: 네임스페이스로 써서 선이 든 HWP 를 HWPX 로 저장하면 한글이
/// 파일을 열지 못했다. 한글 저장본처럼 직선은 hc:, 연결선만 hp: 다.
#[test]
fn straight_line_endpoints_are_written_in_the_core_namespace() {
    let original = open(&read_sample("samples/exam_math.hwp"));
    let bytes = save_hwpx(&original);
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("hwpx zip");
    let mut lines = 0;
    for index in 0.. {
        let Ok(mut entry) = zip.by_name(&format!("Contents/section{index}.xml")) else {
            break;
        };
        let mut xml = String::new();
        std::io::Read::read_to_string(&mut entry, &mut xml).unwrap();
        for line in xml.split("<hp:line ").skip(1) {
            let line = &line[..line.find("</hp:line>").expect("closed line")];
            assert!(
                line.contains("<hc:startPt") && line.contains("<hc:endPt"),
                "{line}"
            );
            assert!(
                !line.contains("<hp:startPt") && !line.contains("<hp:endPt"),
                "{line}"
            );
            lines += 1;
        }
    }
    assert!(lines > 0, "sample must contain straight lines");
}

/// HWPX 그림은 manifest 번호(image14)를 참조하고 HWP5 는 BinData 위치를 참조한다.
/// 번호를 그대로 쓰면 HWP 저장본에서 한글이 없는 위치를 찾아 그림이 비었다.
#[test]
fn hwpx_pictures_point_at_the_same_image_after_saving_as_hwp() {
    fn picture_images(doc: &Document, by_position: bool) -> Vec<Vec<u8>> {
        let mut ids = Vec::new();
        for para in all_paragraphs(doc) {
            for control in &para.controls {
                if let Control::Picture(picture) = control {
                    ids.push(picture.image_attr.bin_data_id);
                }
            }
        }
        ids.into_iter()
            .map(|id| {
                let storage = if by_position {
                    let entry = doc
                        .doc_info
                        .bin_data_list
                        .get(usize::from(id).checked_sub(1).expect("1-based"))
                        .unwrap_or_else(|| {
                            panic!("picture refers to missing BinData position {id}")
                        });
                    entry.storage_id
                } else {
                    id
                };
                doc.bin_data_content
                    .iter()
                    .find(|content| content.id == storage)
                    .unwrap_or_else(|| panic!("no image for storage {storage}"))
                    .data
                    .load()
            })
            .collect()
    }

    let original = open(&read_sample("samples/issue6575/tac_picture_line_top.hwpx"));
    let saved = open(&save_hwp(&original));
    let before = picture_images(original.document(), false);
    assert!(!before.is_empty());
    assert_eq!(picture_images(saved.document(), true), before);
    // 그 HWP 를 다시 HWPX 로 저장할 수 있어야 한다 (종전: 미등록 binaryItemIDRef 로 거부).
    save_hwpx(&saved);
}

/// 표 캡션 안에 든 표는 HWP 로 저장한 뒤 다시 열면 0×0 빈 표가 되고, 그 문서를
/// HWPX 로 저장하면 미등록 borderFillIDRef 0 으로 거부됐다. 파서가 바깥 표의
/// TABLE 레코드를 찾으며 캡션 속 표의 레코드를 먼저 집었기 때문이다.
#[test]
fn table_inside_a_table_caption_survives_hwp_save() {
    fn caption_tables(doc: &Document) -> Vec<(u16, u16, usize)> {
        let mut out = Vec::new();
        for para in all_paragraphs(doc) {
            for control in &para.controls {
                let Control::Table(table) = control else {
                    continue;
                };
                let Some(caption) = &table.caption else {
                    continue;
                };
                for cp in &caption.paragraphs {
                    for inner in &cp.controls {
                        if let Control::Table(t) = inner {
                            out.push((t.row_count, t.col_count, t.cells.len()));
                        }
                    }
                }
            }
        }
        out
    }
    let original = open(&read_sample("samples/issue1891_external_bindata_link.hwpx"));
    let before = caption_tables(original.document());
    assert!(
        !before.is_empty(),
        "sample must contain a table inside a caption"
    );
    let saved = open(&save_hwp(&original));
    assert_eq!(caption_tables(saved.document()), before);
    save_hwpx(&saved);
}

/// 손대지 않은 누름틀은 한글 저장본에서 안내문을 필드 값으로 가진다. 로드 때 비운
/// 값을 그대로 HWPX 에 써서, 한 셀에 빈 누름틀이 이어진 서식을 한글이 열지 못했다.
#[test]
fn untouched_click_here_fields_keep_their_guide_text_in_hwpx() {
    let original = open(&read_sample("samples/issue-986-receipt.hwp"));
    let bytes = save_hwpx(&original);
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes.clone())).expect("hwpx zip");
    let mut xml = String::new();
    std::io::Read::read_to_string(&mut zip.by_name("Contents/section0.xml").unwrap(), &mut xml)
        .unwrap();
    for (name, guide) in [
        ("night_yn", "야간 진료 여부"),
        ("holiday_yn", "공휴일 진료 여부"),
    ] {
        let begin = xml
            .find(&format!("name=\"{name}\""))
            .unwrap_or_else(|| panic!("field {name}"));
        let id_start = xml[..begin].rfind(" id=\"").unwrap() + 5;
        let id = &xml[id_start..id_start + xml[id_start..].find('"').unwrap()];
        let end = xml
            .find(&format!("<hp:fieldEnd beginIDRef=\"{id}\""))
            .unwrap_or_else(|| panic!("end of {name}"));
        assert!(
            xml[begin..end].contains(&format!("<hp:t>{guide}</hp:t>")),
            "{name} must carry its guide text inside the field"
        );
    }
    let reopened = open(&bytes);
    assert_eq!(texts(reopened.document()), texts(original.document()));
}

/// 같은 누름틀 문서를 HWP 로 저장할 때도 안내문을 필드 값으로 써야 한글이 연다.
/// 줄 정보(line_segs)는 안내문을 포함한 원본 값이므로 그대로 두어야 한다 — 밀면 줄
/// 시작이 문단 끝을 넘어 한글이 문서를 거부했다.
#[test]
fn untouched_click_here_fields_keep_their_guide_text_in_hwp() {
    let original = open(&read_sample(
        "samples/issue1893_clickhere_field_roundtrip.hwpx",
    ));
    let bytes = save_hwp(&original);
    let raw = rhwp::parser::parse_document(&bytes).expect("raw parse");
    let raw_texts: String = all_paragraphs(&raw)
        .iter()
        .map(|p| p.text.as_str())
        .collect();
    for guide in ["소속관서", "죄명", "수사/입건전조사"] {
        assert!(
            raw_texts.contains(guide),
            "HWP must store guide text {guide}"
        );
    }
    for para in all_paragraphs(&raw) {
        for seg in &para.line_segs {
            assert!(
                seg.text_start < para.char_count.max(1),
                "line starts past the paragraph end: {} >= {} in {:?}",
                seg.text_start,
                para.char_count,
                para.text
            );
        }
    }
    let reopened = open(&bytes);
    assert_eq!(texts(reopened.document()), texts(original.document()));
}

/// 여러 문단에 걸친 누름틀은 끝 문단에 FIELD_END 만 남는다. HWP 저장기가 이 고아
/// 마커를 쓰지 않아, 필드가 닫히지 않고 char_count 만 남은 문단을 한글이 거부했다.
#[test]
fn field_spanning_paragraphs_keeps_its_end_marker_in_hwp() {
    fn orphan_ends(doc: &Document) -> Vec<u32> {
        all_paragraphs(doc)
            .iter()
            .flat_map(|p| p.orphan_field_ends.iter().map(|o| o.begin_ctrl_id))
            .collect()
    }
    let original = open(&read_sample("samples/task2279/36378481_gyeoljae.hwpx"));
    let before = orphan_ends(original.document());
    assert!(
        !before.is_empty(),
        "sample must contain a field spanning paragraphs"
    );
    assert!(before
        .iter()
        .all(|id| *id == rhwp::parser::tags::FIELD_CLICKHERE));
    let raw = rhwp::parser::parse_document(&save_hwp(&original)).expect("raw parse");
    assert_eq!(orphan_ends(&raw), before);
}

/// 캡션 레코드를 쓰는 도형은 CTRL_HEADER bit 29(캡션 있음)도 켜야 한다. 캡션 달린
/// 사각형(`<보기>`)이 든 HWPX 를 HWP 로 저장하면 비트가 꺼진 채라 한글이 거부했다.
#[test]
fn captioned_shapes_carry_the_caption_bit_in_hwp() {
    fn captioned_shape_attrs(doc: &Document) -> Vec<u32> {
        let mut out = Vec::new();
        for para in all_paragraphs(doc) {
            for control in &para.controls {
                if let Control::Shape(shape) = control {
                    if shape.drawing().is_some_and(|d| d.caption.is_some()) {
                        out.push(shape.common().attr);
                    }
                }
            }
        }
        out
    }
    let original = open(&read_sample("samples/3-10월_교육_통합_2022.hwpx"));
    assert!(!captioned_shape_attrs(original.document()).is_empty());
    let raw = rhwp::parser::parse_document(&save_hwp(&original)).expect("raw parse");
    let attrs = captioned_shape_attrs(&raw);
    assert!(!attrs.is_empty());
    for attr in attrs {
        assert_ne!(attr & 0x2000_0000, 0, "caption bit missing: {attr:#x}");
    }
}

/// 곡선은 한컴처럼 `<hp:seg>` 로 써야 한다. 다각형식 `<hc:pt>` 로 쓴 HWPX 를 열면
/// 한글이 멈췄다(곡선이 든 묶음 개체).
#[test]
fn curves_are_written_as_segments_in_hwpx() {
    fn curves(doc: &Document) -> Vec<(usize, Vec<u8>)> {
        fn walk(shape: &ShapeObject, out: &mut Vec<(usize, Vec<u8>)>) {
            match shape {
                ShapeObject::Curve(c) => out.push((c.points.len(), c.segment_types.clone())),
                ShapeObject::Group(g) => g.children.iter().for_each(|child| walk(child, out)),
                _ => {}
            }
        }
        let mut out = Vec::new();
        for para in all_paragraphs(doc) {
            for control in &para.controls {
                if let Control::Shape(shape) = control {
                    walk(shape, &mut out);
                }
            }
        }
        out
    }
    let original = open(&read_sample("samples/task1771/nested_group_vectors.hwpx"));
    let before = curves(original.document());
    assert!(!before.is_empty(), "sample must contain curves");
    let bytes = save_hwpx(&original);
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes.clone())).expect("hwpx zip");
    let mut xml = String::new();
    std::io::Read::read_to_string(&mut zip.by_name("Contents/section0.xml").unwrap(), &mut xml)
        .unwrap();
    for curve in xml.split("<hp:curve ").skip(1) {
        let curve = &curve[..curve.find("</hp:curve>").expect("closed curve")];
        assert!(curve.contains("<hp:seg "), "curve without segments");
        assert!(
            !curve.contains("<hc:pt "),
            "curve written as polygon points"
        );
    }
    assert_eq!(curves(open(&bytes).document()), before);
}

/// HWP 문단 앞의 책갈피는 HWPX 에서도 본문 앞에 와야 하고, 쪽 테두리는 없는 ID 0 을
/// 가리키면 안 된다. 책갈피가 본문 뒤로 밀린 HWPX 를 한글이 거부했다(sungeo.hwp).
#[test]
fn hwp_bookmarks_keep_their_place_and_page_borders_point_at_real_fills_in_hwpx() {
    let original = open(&read_sample("samples/basic/sungeo.hwp"));
    let bytes = save_hwpx(&original);
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("hwpx zip");
    let mut xml = String::new();
    std::io::Read::read_to_string(&mut zip.by_name("Contents/section2.xml").unwrap(), &mut xml)
        .unwrap();
    assert!(!xml.contains(r#"<hp:pageBorderFill type="BOTH" borderFillIDRef="0""#));
    assert!(
        !xml.contains(r#"borderFillIDRef="0" textBorder"#),
        "page border fill 0"
    );
    let first_paragraph = &xml[..xml.find("</hp:p>").unwrap()];
    let bookmark = first_paragraph.find("<hp:bookmark ").expect("bookmark");
    let text = first_paragraph.find("<hp:t>").expect("text");
    assert!(
        bookmark < text,
        "bookmark must stay before the paragraph text"
    );
}

/// 덧말은 기준 글을 컨트롤 안에 가진다. HWP 저장기가 'tdut' 레코드를 쓰지 않아 덧말과
/// 기준 글("팀단위 훈련")이 함께 사라졌고, HWP 의 'tdut' 은 미지원 컨트롤로 남아 HWPX
/// 저장에서 사라졌다.
#[test]
fn ruby_text_survives_hwpx_to_hwp_to_hwpx() {
    fn rubies(doc: &Document) -> Vec<(String, String)> {
        all_paragraphs(doc)
            .iter()
            .flat_map(|p| p.controls.iter())
            .filter_map(|c| match c {
                Control::Ruby(r) => Some((r.main_text.clone(), r.ruby_text.clone())),
                _ => None,
            })
            .collect()
    }
    let sample = std::fs::read_dir(crate::common::sample_path("samples/hwpx/opengov"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.to_string_lossy().ends_with("덧말.hwpx"))
        .expect("덧말 sample");
    let original = open(&std::fs::read(sample).unwrap());
    let before = rubies(original.document());
    assert!(before.iter().any(|(main, _)| main == "팀단위 훈련"));
    let as_hwp = open(&save_hwp(&original));
    assert_eq!(rubies(as_hwp.document()), before);
    let back_to_hwpx = open(&save_hwpx(&as_hwp));
    assert_eq!(rubies(back_to_hwpx.document()), before);
}

/// HWP 표·그림의 번호 매김 종류(attr bit 26-27)를 읽지 않아 HWPX 에 numberingType="NONE"
/// 으로 썼다. 한글은 그 표를 번호 없는 표로 보고 상호 참조("표 14 참조")를 "표 1" 로
/// 바꿨다.
#[test]
fn hwp_table_numbering_kind_survives_hwpx_save() {
    use rhwp::model::shape::ObjectNumberingType;
    fn table_kinds(doc: &Document) -> Vec<ObjectNumberingType> {
        all_paragraphs(doc)
            .iter()
            .flat_map(|p| p.controls.iter())
            .filter_map(|c| match c {
                Control::Table(t) => Some(t.common.numbering_type),
                _ => None,
            })
            .collect()
    }
    let original = open(&read_sample("samples/kps-ai.hwp"));
    let before = table_kinds(original.document());
    assert!(
        before.contains(&ObjectNumberingType::Table),
        "numbered tables expected"
    );
    let reopened = open(&save_hwpx(&original));
    assert_eq!(table_kinds(reopened.document()), before);
}

/// 본문의 미주형 자동번호는 파일에 저장된 번호(11)를 그대로 써야 한다. 로드 때
/// 번호 매김이 그 값을 1 로 덮어써, HWPX 저장본에서 "문11）" 이 "문1）" 로 바뀌었다.
#[test]
fn stored_autonumber_value_survives_hwpx_save() {
    fn numbers(doc: &Document) -> Vec<u16> {
        all_paragraphs(doc)
            .iter()
            .flat_map(|p| p.controls.iter())
            .filter_map(|c| match c {
                Control::AutoNumber(a) => Some(a.number),
                _ => None,
            })
            .collect()
    }
    let original = open(&read_sample("samples/eq-002.hwp"));
    assert_eq!(numbers(original.document()), vec![11]);
    assert_eq!(numbers(open(&save_hwpx(&original)).document()), vec![11]);
}

/// 손대지 않은 누름틀 값은 비울 때의 값 그대로(안내문 + 한컴이 붙인 뒤 공백) 되돌려야
/// 한다. 안내문만 쓰면 공백이 사라졌다(BlogForm_Recipe: "입력하세요. " → "입력하세요.").
#[test]
fn click_here_values_are_written_back_exactly() {
    fn field_paragraph_texts(doc: &Document) -> Vec<String> {
        all_paragraphs(doc)
            .iter()
            .filter(|p| p.controls.iter().any(|c| matches!(c, Control::Field(_))))
            .map(|p| p.text.clone())
            .collect()
    }
    let bytes = read_sample("samples/basic/BlogForm_Recipe.hwp");
    let raw_original = rhwp::parser::parse_document(&bytes).expect("raw parse");
    let before = field_paragraph_texts(&raw_original);
    assert!(before.iter().any(|t| t.ends_with(". ")), "{before:?}");
    let saved = save_hwpx(&open(&bytes));
    let raw_saved = rhwp::parser::parse_document(&saved).expect("raw parse");
    assert_eq!(field_paragraph_texts(&raw_saved), before);
}

/// HWP5 구역 정의는 양쪽/짝수/홀수 쪽 테두리 3개를 가진다. BOTH 하나뿐인 HWPX 를
/// HWP 로 저장하면 1개만 써서 한글이 파일을 열지 못했다.
#[test]
fn hwp_sections_always_carry_three_page_border_fills() {
    let original = open(&read_sample("samples/task2156/width_ladder.hwpx"));
    let saved = open(&save_hwp(&original));
    for section in &saved.document().sections {
        assert_eq!(section.section_def.extra_page_border_fills.len(), 2);
        assert_eq!(
            section.section_def.page_border_fill.border_fill_id,
            original.document().sections[0]
                .section_def
                .page_border_fill
                .border_fill_id
        );
    }
}

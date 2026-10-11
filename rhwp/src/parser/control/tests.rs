use super::*;
use crate::parser::tags;

fn make_record(tag_id: u16, level: u16, data: Vec<u8>) -> Record {
    Record {
        tag_id,
        level,
        size: data.len() as u32,
        data,
    }
}

fn make_para_header_data(char_count: u32) -> Vec<u8> {
    let mut data = Vec::new();
    data.extend_from_slice(&char_count.to_le_bytes());
    data.extend_from_slice(&0u32.to_le_bytes()); // control_mask
    data.extend_from_slice(&0u16.to_le_bytes()); // para_shape_id
    data.push(0); // style_id
    data.push(0); // break_type
    data
}

fn make_para_text_data(text: &str) -> Vec<u8> {
    let mut data = Vec::new();
    for ch in text.encode_utf16() {
        data.extend_from_slice(&ch.to_le_bytes());
    }
    data.extend_from_slice(&0x000Du16.to_le_bytes());
    data
}

#[test]
fn test_parse_table_basic() {
    // TABLE 레코드 데이터: 2×2 표
    let mut table_data = Vec::new();
    table_data.extend_from_slice(&0u32.to_le_bytes()); // attr
    table_data.extend_from_slice(&2u16.to_le_bytes()); // row_count
    table_data.extend_from_slice(&2u16.to_le_bytes()); // col_count
    table_data.extend_from_slice(&0i16.to_le_bytes()); // cell_spacing
    table_data.extend_from_slice(&0i16.to_le_bytes()); // padding_left
    table_data.extend_from_slice(&0i16.to_le_bytes()); // padding_right
    table_data.extend_from_slice(&0i16.to_le_bytes()); // padding_top
    table_data.extend_from_slice(&0i16.to_le_bytes()); // padding_bottom
                                                       // row heights
    table_data.extend_from_slice(&500i16.to_le_bytes());
    table_data.extend_from_slice(&500i16.to_le_bytes());
    table_data.extend_from_slice(&1u16.to_le_bytes()); // border_fill_id

    // LIST_HEADER (cell 0,0) 데이터
    let mut cell_data = Vec::new();
    cell_data.extend_from_slice(&1u16.to_le_bytes()); // n_paragraphs
    cell_data.extend_from_slice(&0u32.to_le_bytes()); // list_attr
    cell_data.extend_from_slice(&0u16.to_le_bytes()); // unknown (텍스트 영역 폭)
    cell_data.extend_from_slice(&0u16.to_le_bytes()); // col
    cell_data.extend_from_slice(&0u16.to_le_bytes()); // row
    cell_data.extend_from_slice(&1u16.to_le_bytes()); // col_span
    cell_data.extend_from_slice(&1u16.to_le_bytes()); // row_span
    cell_data.extend_from_slice(&10000u32.to_le_bytes()); // width
    cell_data.extend_from_slice(&5000u32.to_le_bytes()); // height
    cell_data.extend_from_slice(&0i16.to_le_bytes()); // paddings
    cell_data.extend_from_slice(&0i16.to_le_bytes());
    cell_data.extend_from_slice(&0i16.to_le_bytes());
    cell_data.extend_from_slice(&0i16.to_le_bytes());
    cell_data.extend_from_slice(&1u16.to_le_bytes()); // border_fill_id

    let child_records = vec![
        make_record(tags::HWPTAG_TABLE, 2, table_data),
        make_record(tags::HWPTAG_LIST_HEADER, 2, cell_data),
        make_record(tags::HWPTAG_PARA_HEADER, 3, make_para_header_data(5)),
        make_record(tags::HWPTAG_PARA_TEXT, 4, make_para_text_data("test")),
    ];

    let ctrl = parse_table_control(&[], &child_records);
    if let Control::Table(table) = ctrl {
        assert_eq!(table.row_count, 2);
        assert_eq!(table.col_count, 2);
        assert_eq!(table.cells.len(), 1);
        assert_eq!(table.cells[0].width, 10000);
        assert_eq!(table.cells[0].paragraphs.len(), 1);
        assert_eq!(table.cells[0].paragraphs[0].text, "test");
    } else {
        panic!("Expected Table control");
    }
}

#[test]
fn test_parse_header_control() {
    let mut ctrl_data = Vec::new();
    ctrl_data.extend_from_slice(&0u32.to_le_bytes()); // attr: Both

    // LIST_HEADER + paragraph
    let mut list_data = Vec::new();
    list_data.extend_from_slice(&1u16.to_le_bytes()); // n_paragraphs
    list_data.extend_from_slice(&0u32.to_le_bytes()); // list_attr

    let child_records = vec![
        make_record(tags::HWPTAG_LIST_HEADER, 2, list_data),
        make_record(tags::HWPTAG_PARA_HEADER, 3, make_para_header_data(6)),
        make_record(tags::HWPTAG_PARA_TEXT, 4, make_para_text_data("머리말")),
    ];

    let ctrl = parse_header_control(&ctrl_data, &child_records);
    if let Control::Header(header) = ctrl {
        assert_eq!(header.apply_to, HeaderFooterApply::Both);
        assert_eq!(header.paragraphs.len(), 1);
        assert_eq!(header.paragraphs[0].text, "머리말");
    } else {
        panic!("Expected Header control");
    }
}

/// [#2648] 머리말 LIST_HEADER 레코드 페이로드(list_attr/text_width/text_height/
/// text_ref/num_ref)가 파싱돼야 한다. 종전엔 레코드 뒤 문단만 읽고 페이로드
/// 자체는 무시해 이 필드들이 항상 0 이었다.
#[test]
fn test_parse_header_control_reads_list_header_layout_fields() {
    let mut ctrl_data = Vec::new();
    ctrl_data.extend_from_slice(&0u32.to_le_bytes()); // attr: Both

    let mut list_data = Vec::new();
    list_data.extend_from_slice(&1u16.to_le_bytes()); // n_paragraphs
    list_data.extend_from_slice(&0x0002_0000u32.to_le_bytes()); // list_attr (비영)
    list_data.extend_from_slice(&0u16.to_le_bytes()); // 예약
    list_data.extend_from_slice(&5000u32.to_le_bytes()); // text_width
    list_data.extend_from_slice(&3000u32.to_le_bytes()); // text_height
    list_data.push(7); // text_ref
    list_data.push(9); // num_ref
    list_data.extend_from_slice(&0u16.to_le_bytes()); // ext_flags
    list_data.extend_from_slice(&[0u8; 14]); // 예약

    let child_records = vec![
        make_record(tags::HWPTAG_LIST_HEADER, 2, list_data),
        make_record(tags::HWPTAG_PARA_HEADER, 3, make_para_header_data(6)),
        make_record(tags::HWPTAG_PARA_TEXT, 4, make_para_text_data("머리말")),
    ];

    let ctrl = parse_header_control(&ctrl_data, &child_records);
    let Control::Header(header) = ctrl else {
        panic!("Expected Header control");
    };
    assert_eq!(header.list_attr, 0x0002_0000, "list_attr 이 보존돼야 함");
    assert_eq!(header.text_width, 5000, "text_width 가 보존돼야 함");
    assert_eq!(header.text_height, 3000, "text_height 가 보존돼야 함");
    assert_eq!(header.text_ref, 7, "text_ref 가 보존돼야 함");
    assert_eq!(header.num_ref, 9, "num_ref 가 보존돼야 함");
    assert_eq!(header.paragraphs.len(), 1);
}

#[test]
fn test_parse_footer_control() {
    let mut ctrl_data = Vec::new();
    ctrl_data.extend_from_slice(&1u32.to_le_bytes()); // attr: Even

    let child_records = vec![make_record(tags::HWPTAG_LIST_HEADER, 2, vec![0; 6])];

    let ctrl = parse_footer_control(&ctrl_data, &child_records);
    if let Control::Footer(footer) = ctrl {
        assert_eq!(footer.apply_to, HeaderFooterApply::Even);
    } else {
        panic!("Expected Footer control");
    }
}

#[test]
fn test_parse_footnote_control() {
    // [Task #1050] CTRL_FOOTNOTE payload (size=20):
    // number(UInt4) + before(WChar) + after(WChar) + numberShape(UInt4) + instanceId(UInt4)
    let mut ctrl_data = Vec::new();
    ctrl_data.extend_from_slice(&3u32.to_le_bytes()); // number = 3 (UInt4)
    ctrl_data.extend_from_slice(&0u16.to_le_bytes()); // before = 0
    ctrl_data.extend_from_slice(&0x0029u16.to_le_bytes()); // after = ')'
    ctrl_data.extend_from_slice(&0u32.to_le_bytes()); // numberShape = 0
    ctrl_data.extend_from_slice(&42u32.to_le_bytes()); // instanceId = 42

    let child_records = vec![
        make_record(tags::HWPTAG_LIST_HEADER, 2, vec![0; 16]),
        make_record(tags::HWPTAG_PARA_HEADER, 3, make_para_header_data(5)),
        make_record(tags::HWPTAG_PARA_TEXT, 4, make_para_text_data("각주")),
    ];

    let ctrl = parse_footnote_control(&ctrl_data, &child_records);
    if let Control::Footnote(fn_) = ctrl {
        assert_eq!(fn_.number, 3);
        assert_eq!(fn_.after_decoration_letter, 0x0029);
        assert_eq!(fn_.instance_id, 42);
        assert_eq!(fn_.paragraphs.len(), 1);
        assert_eq!(fn_.paragraphs[0].text, "각주");
    } else {
        panic!("Expected Footnote control");
    }
}

#[test]
fn test_parse_auto_number() {
    let mut ctrl_data = Vec::new();
    ctrl_data.extend_from_slice(&0x04u32.to_le_bytes()); // Table type

    let ctrl = parse_auto_number(&ctrl_data);
    if let Control::AutoNumber(an) = ctrl {
        assert_eq!(an.number_type, AutoNumberType::Table);
    } else {
        panic!("Expected AutoNumber control");
    }
}

#[test]
fn test_parse_bookmark() {
    let mut ctrl_data = Vec::new();
    // HWP string: length=4, "test"
    ctrl_data.extend_from_slice(&4u16.to_le_bytes());
    for ch in "test".encode_utf16() {
        ctrl_data.extend_from_slice(&ch.to_le_bytes());
    }

    let ctrl = parse_bookmark(&ctrl_data);
    if let Control::Bookmark(bm) = ctrl {
        assert_eq!(bm.name, "test");
    } else {
        panic!("Expected Bookmark control");
    }
}

#[test]
fn test_parse_page_hide() {
    let mut ctrl_data = Vec::new();
    ctrl_data.extend_from_slice(&0x07u32.to_le_bytes()); // hide header+footer+master

    let ctrl = parse_page_hide(&ctrl_data);
    if let Control::PageHide(ph) = ctrl {
        assert!(ph.hide_header);
        assert!(ph.hide_footer);
        assert!(ph.hide_master_page);
        assert!(!ph.hide_border);
    } else {
        panic!("Expected PageHide control");
    }
}

#[test]
fn test_parse_hidden_comment() {
    let child_records = vec![
        make_record(tags::HWPTAG_LIST_HEADER, 2, vec![0; 6]),
        make_record(tags::HWPTAG_PARA_HEADER, 3, make_para_header_data(5)),
        make_record(tags::HWPTAG_PARA_TEXT, 4, make_para_text_data("메모")),
    ];

    let ctrl = parse_hidden_comment_control(&child_records);
    if let Control::HiddenComment(comment) = ctrl {
        assert_eq!(comment.paragraphs.len(), 1);
        assert_eq!(comment.paragraphs[0].text, "메모");
    } else {
        panic!("Expected HiddenComment control");
    }
}

#[test]
fn form_wstring_huge_length_does_not_panic() {
    // `wstring:N` 의 N 이 usize::MAX 면 종전 `pos + n` 이 오버플로해
    // 슬라이스 패닉으로 문서 열기가 중단됐다. 남은 문자까지만 읽어야 한다.
    let mut form = FormObject::default();
    parse_form_properties(
        &format!("Name:wstring:{}:x Caption:wstring:1:y", usize::MAX),
        &mut form,
    );
    assert_eq!(form.name, "x Caption:wstring:1:y");
}

#[test]
fn test_parse_control_dispatch() {
    let ctrl = parse_control(0x12345678, &[], &[]);
    assert!(matches!(ctrl, Control::Unknown(u) if u.ctrl_id == 0x12345678));
}

#[test]
fn test_parse_char_overlap() {
    // 표 152: WORD(len=2) + WCHAR['A','B'] + border_type(1) + inner_size(0) + expansion(0) + cs_count(0)
    let mut data = Vec::new();
    data.extend_from_slice(&2u16.to_le_bytes()); // len = 2
    data.extend_from_slice(&0x0041u16.to_le_bytes()); // 'A'
    data.extend_from_slice(&0x0042u16.to_le_bytes()); // 'B'
    data.push(1); // border_type = 원
    data.push(0i8 as u8); // inner_char_size = 0 (기본)
    data.push(0); // expansion
    data.push(0); // cs_count

    let ctrl = parse_char_overlap(&data);
    if let Control::CharOverlap(co) = ctrl {
        assert_eq!(co.chars, vec!['A', 'B']);
        assert_eq!(co.border_type, 1);
        assert_eq!(co.inner_char_size, 0);
        assert_eq!(co.char_shape_ids.len(), 0);
    } else {
        panic!("Expected CharOverlap control");
    }
}

#[test]
fn test_parse_common_obj_attr() {
    let mut data = Vec::new();
    data.extend_from_slice(&0x01u32.to_le_bytes()); // attr: treat_as_char
    data.extend_from_slice(&1000u32.to_le_bytes()); // vertical_offset
    data.extend_from_slice(&2000u32.to_le_bytes()); // horizontal_offset
    data.extend_from_slice(&5000u32.to_le_bytes()); // width
    data.extend_from_slice(&3000u32.to_le_bytes()); // height
    data.extend_from_slice(&1i32.to_le_bytes()); // z_order
    data.extend_from_slice(&0i16.to_le_bytes()); // margins
    data.extend_from_slice(&0i16.to_le_bytes());
    data.extend_from_slice(&0i16.to_le_bytes());
    data.extend_from_slice(&0i16.to_le_bytes());
    data.extend_from_slice(&42u32.to_le_bytes()); // instance_id

    let common = parse_common_obj_attr(&data);
    assert!(common.treat_as_char);
    assert_eq!(common.width, 5000);
    assert_eq!(common.height, 3000);
    assert_eq!(common.instance_id, 42);
}

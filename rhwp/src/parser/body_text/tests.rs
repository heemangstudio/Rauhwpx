use super::*;
use crate::parser::tags;

/// 테스트용 레코드 바이너리 생성
fn make_record_bytes(tag_id: u16, level: u16, data: &[u8]) -> Vec<u8> {
    let size = data.len() as u32;
    let header = (tag_id as u32) | ((level as u32) << 10) | (size << 20);
    let mut bytes = header.to_le_bytes().to_vec();
    bytes.extend_from_slice(data);
    bytes
}

/// PARA_HEADER 테스트 데이터 생성
fn make_para_header_data(char_count: u32, para_shape_id: u16, style_id: u8) -> Vec<u8> {
    let mut data = Vec::new();
    data.extend_from_slice(&char_count.to_le_bytes()); // nChars
    data.extend_from_slice(&0u32.to_le_bytes()); // controlMask
    data.extend_from_slice(&para_shape_id.to_le_bytes()); // paraShapeId
    data.push(style_id); // styleId
    data.push(0); // breakType
    data
}

/// UTF-16LE 텍스트 생성 (문단 끝 포함)
fn make_para_text_data(text: &str) -> Vec<u8> {
    let mut data = Vec::new();
    for ch in text.encode_utf16() {
        data.extend_from_slice(&ch.to_le_bytes());
    }
    // 문단 끝 마커 (0x000D)
    data.extend_from_slice(&0x000Du16.to_le_bytes());
    data
}

#[test]
fn test_parse_para_text_simple() {
    let (text, offsets, _, _, _) = parse_para_text(&make_para_text_data("Hello, World!"));
    assert_eq!(text, "Hello, World!");
    assert_eq!(offsets.len(), 13);
    assert_eq!(offsets[0], 0); // 'H' at position 0
}

#[test]
fn hwp_hyphen_control_remains_distinct_from_literal_hyphen() {
    let data = [0x0018u16, 0x002D, 0x0020, 0x005Fu16, 0x000D]
        .into_iter()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    let (text, offsets, _, _, _) = parse_para_text(&data);
    assert_eq!(text, "\u{00AD}- _");
    assert_eq!(offsets, vec![0, 1, 2, 3]);
}

#[test]
fn test_parse_para_text_korean() {
    let (text, offsets, _, _, _) = parse_para_text(&make_para_text_data("한글 테스트입니다."));
    assert_eq!(text, "한글 테스트입니다.");
    assert_eq!(offsets.len(), text.chars().count());
}

#[test]
fn test_parse_para_text_with_tab() {
    let mut data = Vec::new();
    // "A" + tab(0x0009, inline 8 code units = 16바이트) + "B" + para break
    data.extend_from_slice(&0x0041u16.to_le_bytes()); // 'A'
                                                      // tab: 0x0009 + 7 dummy code units (inline control data)
    data.extend_from_slice(&0x0009u16.to_le_bytes());
    for _ in 0..7 {
        data.extend_from_slice(&0x0000u16.to_le_bytes());
    }
    data.extend_from_slice(&0x0042u16.to_le_bytes()); // 'B'
    data.extend_from_slice(&0x000Du16.to_le_bytes()); // para break
    let (text, offsets, _, _, _) = parse_para_text(&data);
    assert_eq!(text, "A\tB");
    // 'A' at code unit 0, tab takes 8 units (1-8), 'B' at code unit 9
    assert_eq!(offsets, vec![0, 1, 9]);
}

#[test]
fn test_parse_para_text_with_extended_ctrl() {
    let mut data = Vec::new();
    // "A" + extended ctrl(0x000B, 8 code units) + "B" + para break
    data.extend_from_slice(&0x0041u16.to_le_bytes()); // 'A'
                                                      // Extended control character: 0x000B + 7 dummy code units
    data.extend_from_slice(&0x000Bu16.to_le_bytes());
    for _ in 0..7 {
        data.extend_from_slice(&0x0000u16.to_le_bytes());
    }
    data.extend_from_slice(&0x0042u16.to_le_bytes()); // 'B'
    data.extend_from_slice(&0x000Du16.to_le_bytes()); // para break
    let (text, offsets, _, _, _) = parse_para_text(&data);
    assert_eq!(text, "AB");
    // 'A' at code unit 0, extended ctrl takes 8 units (1-8), 'B' at code unit 9
    assert_eq!(offsets, vec![0, 9]);
}

#[test]
fn test_parse_para_text_empty() {
    // 문단 끝만 있는 경우
    let data = 0x000Du16.to_le_bytes();
    let (text, offsets, _, _, _) = parse_para_text(&data);
    assert_eq!(text, "");
    assert!(offsets.is_empty());
}

#[test]
fn test_is_extended_ctrl_char() {
    // extended (8 code units): 1-3, 11-12, 14-18, 21-23
    assert!(is_extended_ctrl_char(0x0001)); // reserved
    assert!(is_extended_ctrl_char(0x0002)); // section/column def
    assert!(is_extended_ctrl_char(0x0003)); // field begin
    assert!(is_extended_ctrl_char(0x000B)); // drawing/table
    assert!(is_extended_ctrl_char(0x000C)); // reserved
    assert!(is_extended_ctrl_char(0x0011)); // footnote/endnote
    assert!(is_extended_ctrl_char(0x0015)); // page control
    assert!(is_extended_ctrl_char(0x0017)); // annotation/overlap

    // inline (8 code units): 4-8, 19-20
    // (탭 0x09는 호출 전에 별도 처리되므로 여기서는 true)
    assert!(is_extended_ctrl_char(0x0004)); // field end (inline, 16 bytes)
    assert!(is_extended_ctrl_char(0x0005)); // reserved (inline, 16 bytes)
    assert!(is_extended_ctrl_char(0x0008)); // title mark (inline, 16 bytes)

    // char (1 code unit): 0, 10, 13, 24-31
    assert!(!is_extended_ctrl_char(0x0000)); // null
    assert!(!is_extended_ctrl_char(0x000A)); // line break
    assert!(!is_extended_ctrl_char(0x000D)); // para break
    assert!(!is_extended_ctrl_char(0x0018)); // hyphen
    assert!(!is_extended_ctrl_char(0x0019)); // reserved
    assert!(!is_extended_ctrl_char(0x001A)); // reserved
    assert!(!is_extended_ctrl_char(0x001E)); // non-breaking space
    assert!(!is_extended_ctrl_char(0x001F)); // fixed-width space

    // 일반 문자
    assert!(!is_extended_ctrl_char(0x0020)); // space
    assert!(!is_extended_ctrl_char(0x0041)); // 'A'
}

#[test]
fn test_parse_para_char_shape() {
    let mut data = Vec::new();
    // 항목 1: pos=0, id=3
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(&3u32.to_le_bytes());
    // 항목 2: pos=10, id=5
    data.extend_from_slice(&10u32.to_le_bytes());
    data.extend_from_slice(&5u32.to_le_bytes());

    let refs = parse_para_char_shape(&data);
    assert_eq!(refs.len(), 2);
    assert_eq!(refs[0].start_pos, 0);
    assert_eq!(refs[0].char_shape_id, 3);
    assert_eq!(refs[1].start_pos, 10);
    assert_eq!(refs[1].char_shape_id, 5);
}

#[test]
fn test_parse_para_line_seg() {
    let mut data = Vec::new();
    // LineSeg: 36바이트
    data.extend_from_slice(&0u32.to_le_bytes()); // text_start
    data.extend_from_slice(&100i32.to_le_bytes()); // vertical_pos
    data.extend_from_slice(&500i32.to_le_bytes()); // line_height
    data.extend_from_slice(&400i32.to_le_bytes()); // text_height
    data.extend_from_slice(&300i32.to_le_bytes()); // baseline_distance
    data.extend_from_slice(&200i32.to_le_bytes()); // line_spacing
    data.extend_from_slice(&0i32.to_le_bytes()); // column_start
    data.extend_from_slice(&42000i32.to_le_bytes()); // segment_width
    data.extend_from_slice(&0x01u32.to_le_bytes()); // tag (first line of page)

    let segs = parse_para_line_seg(&data);
    assert_eq!(segs.len(), 1);
    assert_eq!(segs[0].text_start, 0);
    assert_eq!(segs[0].line_height, 500);
    assert_eq!(segs[0].segment_width, 42000);
    assert!(segs[0].is_first_line_of_page());
}

#[test]
fn test_parse_para_range_tag() {
    let mut data = Vec::new();
    data.extend_from_slice(&5u32.to_le_bytes()); // start
    data.extend_from_slice(&15u32.to_le_bytes()); // end
    data.extend_from_slice(&0x01000003u32.to_le_bytes()); // tag

    let tags = parse_para_range_tag(&data);
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0].start, 5);
    assert_eq!(tags[0].end, 15);
    assert_eq!(tags[0].tag, 0x01000003);
}

#[test]
fn test_parse_page_def() {
    let mut data = Vec::new();
    data.extend_from_slice(&59528u32.to_le_bytes()); // width (A4)
    data.extend_from_slice(&84188u32.to_le_bytes()); // height
    data.extend_from_slice(&8504u32.to_le_bytes()); // margin_left
    data.extend_from_slice(&8504u32.to_le_bytes()); // margin_right
    data.extend_from_slice(&5669u32.to_le_bytes()); // margin_top
    data.extend_from_slice(&4252u32.to_le_bytes()); // margin_bottom
    data.extend_from_slice(&4252u32.to_le_bytes()); // margin_header
    data.extend_from_slice(&4252u32.to_le_bytes()); // margin_footer
    data.extend_from_slice(&0u32.to_le_bytes()); // margin_gutter
    data.extend_from_slice(&0u32.to_le_bytes()); // attr (세로, 한쪽)

    let pd = parse_page_def(&data);
    assert_eq!(pd.width, 59528);
    assert_eq!(pd.height, 84188);
    assert!(!pd.landscape);
    assert_eq!(pd.binding, BindingMethod::SingleSided);
}

#[test]
fn test_parse_page_def_landscape() {
    let mut data = Vec::new();
    data.extend_from_slice(&84188u32.to_le_bytes()); // width
    data.extend_from_slice(&59528u32.to_le_bytes()); // height
    for _ in 0..7 {
        data.extend_from_slice(&0u32.to_le_bytes()); // margins
    }
    data.extend_from_slice(&0x01u32.to_le_bytes()); // attr: landscape

    let pd = parse_page_def(&data);
    assert!(pd.landscape);
}

#[test]
fn test_parse_section_simple() {
    // 최소 섹션: PARA_HEADER + PARA_TEXT
    let para_header_data = make_para_header_data(6, 0, 0);
    let para_text_data = make_para_text_data("Hello");

    let mut section_bytes = Vec::new();
    section_bytes.extend(make_record_bytes(
        tags::HWPTAG_PARA_HEADER,
        0,
        &para_header_data,
    ));
    section_bytes.extend(make_record_bytes(
        tags::HWPTAG_PARA_TEXT,
        1,
        &para_text_data,
    ));

    let section = parse_body_text_section(&section_bytes).unwrap();
    assert_eq!(section.paragraphs.len(), 1);
    assert_eq!(section.paragraphs[0].text, "Hello");
}

#[test]
fn test_parse_section_multiple_paragraphs() {
    let mut section_bytes = Vec::new();

    // 문단 1
    let ph1 = make_para_header_data(4, 0, 0);
    let pt1 = make_para_text_data("ABC");
    section_bytes.extend(make_record_bytes(tags::HWPTAG_PARA_HEADER, 0, &ph1));
    section_bytes.extend(make_record_bytes(tags::HWPTAG_PARA_TEXT, 1, &pt1));

    // 문단 2
    let ph2 = make_para_header_data(4, 1, 0);
    let pt2 = make_para_text_data("DEF");
    section_bytes.extend(make_record_bytes(tags::HWPTAG_PARA_HEADER, 0, &ph2));
    section_bytes.extend(make_record_bytes(tags::HWPTAG_PARA_TEXT, 1, &pt2));

    let section = parse_body_text_section(&section_bytes).unwrap();
    assert_eq!(section.paragraphs.len(), 2);
    assert_eq!(section.paragraphs[0].text, "ABC");
    assert_eq!(section.paragraphs[1].text, "DEF");
    assert_eq!(section.paragraphs[1].para_shape_id, 1);
}

#[test]
fn test_parse_section_with_section_def() {
    let mut section_bytes = Vec::new();

    // 문단 1 (구역 정의 포함)
    let ph = make_para_header_data(2, 0, 0);
    section_bytes.extend(make_record_bytes(tags::HWPTAG_PARA_HEADER, 0, &ph));

    // 텍스트
    let pt = make_para_text_data("A");
    section_bytes.extend(make_record_bytes(tags::HWPTAG_PARA_TEXT, 1, &pt));

    // CTRL_HEADER (secd)
    let mut ctrl_data = Vec::new();
    ctrl_data.extend_from_slice(&tags::CTRL_SECTION_DEF.to_le_bytes()); // ctrl_id
    ctrl_data.extend_from_slice(&0u32.to_le_bytes()); // flags
    ctrl_data.extend_from_slice(&0i16.to_le_bytes()); // column_spacing
    ctrl_data.extend_from_slice(&1200i16.to_le_bytes()); // line_grid
    ctrl_data.extend_from_slice(&900i16.to_le_bytes()); // char_grid
    ctrl_data.extend_from_slice(&800u32.to_le_bytes()); // default_tab_spacing
    ctrl_data.extend_from_slice(&0u16.to_le_bytes()); // numbering_id
    ctrl_data.extend_from_slice(&1u16.to_le_bytes()); // page_num
    ctrl_data.extend_from_slice(&0u16.to_le_bytes()); // picture_num
    ctrl_data.extend_from_slice(&0u16.to_le_bytes()); // table_num
    ctrl_data.extend_from_slice(&0u16.to_le_bytes()); // equation_num
    section_bytes.extend(make_record_bytes(tags::HWPTAG_CTRL_HEADER, 1, &ctrl_data));

    // PAGE_DEF (secd의 자식)
    let mut page_data = Vec::new();
    page_data.extend_from_slice(&59528u32.to_le_bytes()); // width
    page_data.extend_from_slice(&84188u32.to_le_bytes()); // height
    for _ in 0..7 {
        page_data.extend_from_slice(&0u32.to_le_bytes());
    }
    page_data.extend_from_slice(&0u32.to_le_bytes()); // attr
    section_bytes.extend(make_record_bytes(tags::HWPTAG_PAGE_DEF, 2, &page_data));

    let section = parse_body_text_section(&section_bytes).unwrap();
    assert_eq!(section.section_def.default_tab_spacing, 800);
    assert_eq!(section.section_def.line_grid, 1200);
    assert_eq!(section.section_def.char_grid, 900);
    assert_eq!(section.section_def.page_num, 1);
    assert_eq!(section.section_def.page_def.width, 59528);
}

#[test]
fn test_parse_section_with_column_def() {
    let mut section_bytes = Vec::new();

    // 문단
    let ph = make_para_header_data(2, 0, 0);
    section_bytes.extend(make_record_bytes(tags::HWPTAG_PARA_HEADER, 0, &ph));

    // CTRL_HEADER (cold) - 2단, 같은 너비, 간격 1000
    // 표 141: bit 0-1=종류(0), bit 2-9=단수(2), bit 12=동일너비(1)
    let attr: u16 = (2 << 2) | (1 << 12); // 0x1008
    let mut ctrl_data = Vec::new();
    ctrl_data.extend_from_slice(&tags::CTRL_COLUMN_DEF.to_le_bytes());
    ctrl_data.extend_from_slice(&attr.to_le_bytes()); // attr (bits 0-15)
    ctrl_data.extend_from_slice(&1000i16.to_le_bytes()); // spacing
    ctrl_data.extend_from_slice(&0u16.to_le_bytes()); // attr2 (bits 16-32)
    section_bytes.extend(make_record_bytes(tags::HWPTAG_CTRL_HEADER, 1, &ctrl_data));

    let section = parse_body_text_section(&section_bytes).unwrap();
    assert_eq!(section.paragraphs.len(), 1);

    let has_column_def = section.paragraphs[0]
        .controls
        .iter()
        .any(|c| matches!(c, Control::ColumnDef(_)));
    assert!(has_column_def);

    if let Some(Control::ColumnDef(cd)) = section.paragraphs[0]
        .controls
        .iter()
        .find(|c| matches!(c, Control::ColumnDef(_)))
    {
        assert_eq!(cd.column_count, 2);
        assert!(cd.same_width);
        assert_eq!(cd.spacing, 1000);
    }
}

#[test]
fn test_parse_table_control_delegation() {
    let mut section_bytes = Vec::new();

    let ph = make_para_header_data(2, 0, 0);
    section_bytes.extend(make_record_bytes(tags::HWPTAG_PARA_HEADER, 0, &ph));

    // 표 컨트롤 → control.rs로 위임되어 Table로 파싱
    let mut ctrl_data = Vec::new();
    ctrl_data.extend_from_slice(&tags::CTRL_TABLE.to_le_bytes());
    ctrl_data.extend_from_slice(&[0u8; 20]); // dummy data
    section_bytes.extend(make_record_bytes(tags::HWPTAG_CTRL_HEADER, 1, &ctrl_data));

    let section = parse_body_text_section(&section_bytes).unwrap();
    let has_table = section.paragraphs[0]
        .controls
        .iter()
        .any(|c| matches!(c, Control::Table(_)));
    assert!(has_table);
}

/// 1×1 표를 depth 단 중첩한 섹션 레코드 (셀 안에 다음 표)
fn nested_table_section(depth: usize) -> Vec<u8> {
    let mut ctrl_data = tags::CTRL_TABLE.to_le_bytes().to_vec();
    ctrl_data.extend_from_slice(&[0u8; 44]);
    let mut table_data = vec![0u8; 4]; // attr
    table_data.extend_from_slice(&1u16.to_le_bytes()); // row_count
    table_data.extend_from_slice(&1u16.to_le_bytes()); // col_count
    table_data.extend_from_slice(&[0u8; 12]); // spacing + padding
    table_data.extend_from_slice(&1u16.to_le_bytes()); // 행별 셀 수
    let mut cell_data = vec![0u8; 8];
    for v in [0u16, 0, 1, 1] {
        cell_data.extend_from_slice(&v.to_le_bytes()); // col, row, col_span, row_span
    }
    cell_data.extend_from_slice(&[0u8; 18]);

    let mut bytes = Vec::new();
    for i in 0..depth {
        let level = (i * 2) as u16;
        let ph = make_para_header_data(0, 0, 0);
        bytes.extend(make_record_bytes(tags::HWPTAG_PARA_HEADER, level, &ph));
        bytes.extend(make_record_bytes(
            tags::HWPTAG_CTRL_HEADER,
            level + 1,
            &ctrl_data,
        ));
        bytes.extend(make_record_bytes(
            tags::HWPTAG_TABLE,
            level + 2,
            &table_data,
        ));
        bytes.extend(make_record_bytes(
            tags::HWPTAG_LIST_HEADER,
            level + 2,
            &cell_data,
        ));
    }
    let ph = make_para_header_data(0, 0, 0);
    bytes.extend(make_record_bytes(
        tags::HWPTAG_PARA_HEADER,
        (depth * 2) as u16,
        &ph,
    ));
    bytes
}

/// 과도한 중첩은 wasm 기본 스택(1MiB)을 넘기지 않고 깊이 상한에서 잘려야 한다.
/// 스택 오버플로는 잡을 수 없어 종전엔 23KB 짜리 중첩 표로 엔진이 죽었다.
#[test]
fn deeply_nested_tables_stop_at_nesting_cap_within_wasm_stack() {
    let data = nested_table_section(250);
    let depth = std::thread::Builder::new()
        .stack_size(1 << 20)
        .spawn(move || {
            let section = parse_body_text_section(&data).expect("중첩 표도 파싱되어야 함");
            let mut paragraphs = &section.paragraphs;
            let mut depth = 0;
            while let Some(Control::Table(table)) =
                paragraphs.first().and_then(|p| p.controls.first())
            {
                depth += 1;
                paragraphs = &table.cells[0].paragraphs;
            }
            depth
        })
        .unwrap()
        .join()
        .expect("1MiB 스택에서 오버플로 없이 끝나야 함");
    assert_eq!(depth, MAX_HWP5_NESTING_DEPTH as usize + 1);
}

#[test]
fn test_parse_unknown_control() {
    let mut section_bytes = Vec::new();

    let ph = make_para_header_data(2, 0, 0);
    section_bytes.extend(make_record_bytes(tags::HWPTAG_PARA_HEADER, 0, &ph));

    // 등록되지 않은 임의의 컨트롤 ID → Unknown
    let unknown_ctrl_id: u32 = 0x78797A77; // 'wxyz' (미등록)
    let mut ctrl_data = Vec::new();
    ctrl_data.extend_from_slice(&unknown_ctrl_id.to_le_bytes());
    ctrl_data.extend_from_slice(&[0u8; 20]); // dummy data
    section_bytes.extend(make_record_bytes(tags::HWPTAG_CTRL_HEADER, 1, &ctrl_data));

    let section = parse_body_text_section(&section_bytes).unwrap();
    let has_unknown = section.paragraphs[0]
        .controls
        .iter()
        .any(|c| matches!(c, Control::Unknown(u) if u.ctrl_id == unknown_ctrl_id));
    assert!(has_unknown);
}

#[test]
fn test_parse_para_header_fields() {
    let data = make_para_header_data(42, 5, 2);
    let para = parse_para_header(&data);
    assert_eq!(para.char_count, 42);
    assert_eq!(para.para_shape_id, 5);
    assert_eq!(para.style_id, 2);
}

#[test]
fn test_parse_page_border_fill() {
    let mut data = Vec::new();
    data.extend_from_slice(&0x01u32.to_le_bytes()); // attr
    data.extend_from_slice(&100i16.to_le_bytes()); // spacing_left
    data.extend_from_slice(&200i16.to_le_bytes()); // spacing_right
    data.extend_from_slice(&300i16.to_le_bytes()); // spacing_top
    data.extend_from_slice(&400i16.to_le_bytes()); // spacing_bottom
    data.extend_from_slice(&7u16.to_le_bytes()); // border_fill_id

    let pbf = parse_page_border_fill(&data);
    assert_eq!(pbf.attr, 0x01);
    assert_eq!(pbf.spacing_left, 100);
    assert_eq!(pbf.border_fill_id, 7);
    assert_eq!(pbf.basis, crate::model::page::PageBorderBasis::BodyBased);
    assert_eq!(pbf.ui_basis, crate::model::page::PageBorderUiBasis::Page);

    data[0..4].copy_from_slice(&0x00u32.to_le_bytes());
    let pbf = parse_page_border_fill(&data);
    assert_eq!(pbf.attr, 0x00);
    assert_eq!(pbf.basis, crate::model::page::PageBorderBasis::PaperBased);
    assert_eq!(pbf.ui_basis, crate::model::page::PageBorderUiBasis::Paper);
}

#[test]
fn test_parse_empty_section() {
    let section = parse_body_text_section(&[]).unwrap();
    assert!(section.paragraphs.is_empty());
}

fn list_header_data(text_width: u32, text_height: u32, ext_flags: u16) -> Vec<u8> {
    let mut data = Vec::new();
    data.extend_from_slice(&0u16.to_le_bytes());
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes());
    data.extend_from_slice(&text_width.to_le_bytes());
    data.extend_from_slice(&text_height.to_le_bytes());
    data.push(0);
    data.push(0);
    data.extend_from_slice(&ext_flags.to_le_bytes());
    data
}

fn raw_list_header(level: u16, data: Vec<u8>) -> crate::model::document::RawRecord {
    crate::model::document::RawRecord {
        tag_id: tags::HWPTAG_LIST_HEADER,
        level,
        data,
    }
}

#[test]
fn hwp5_extension_master_sets_replace_base() {
    let records = vec![
        raw_list_header(2, list_header_data(1000, 2000, 0)),
        raw_list_header(2, list_header_data(1000, 2000, 0x0003)),
    ];
    let pages = parse_master_pages_from_raw(&records);
    assert_eq!(pages.len(), 2);
    assert!(!pages[0].is_extension);
    assert!(!pages[0].replace_base);
    assert!(pages[1].is_extension);
    assert!(pages[1].overlap);
    assert!(
        pages[1].replace_base,
        "HWP5 확장 바탕쪽은 기본 홀/짝 바탕쪽을 대체해야 한다"
    );
}

#[test]
fn hwp5_base_master_does_not_set_replace_base() {
    let records = vec![raw_list_header(2, list_header_data(1000, 2000, 0x0001))];
    let pages = parse_master_pages_from_raw(&records);
    assert_eq!(pages.len(), 1);
    assert!(!pages[0].is_extension);
    assert!(pages[0].overlap);
    assert!(!pages[0].replace_base);
}

#[test]
fn trailing_hwp5_master_is_extension_even_without_legacy_flag() {
    let records = vec![raw_list_header(1, list_header_data(1000, 2000, 0x0004))];
    let pages = parse_master_pages_from_raw_at_location(&records, true);
    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0].ext_flags, 0x0004);
    assert!(pages[0].is_extension);
    assert!(pages[0].replace_base);
}

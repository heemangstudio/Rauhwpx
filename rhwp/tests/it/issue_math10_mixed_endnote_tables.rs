//! Source candidate regressions. Candidate version not compiled or executed.
//! Owned raw CFB fixtures mirror selected slot/row/size geometry, not exam text/images.
//! Prepared source only. Not compiled or executed. No licensed input is required.
use std::io::{Cursor, Write};

use rhwp::document_core::DocumentCore;
use rhwp::model::bin_data::{BinData, BinDataCompression, BinDataType};
use rhwp::model::control::{Control, Equation};
use rhwp::model::image::Picture;
use rhwp::model::page::ColumnDef;
use rhwp::model::paragraph::{LineSeg, Paragraph};
use rhwp::model::provenance::FontMetricsPolicy;
use rhwp::model::table::{Cell, Table, TablePageBreak};
use rhwp::model::Padding;
use rhwp::parser::tags;
use rhwp::renderer::render_tree::{BoundingBox, RenderNode, RenderNodeType};

const RED: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0,
    0, 0, 253, 212, 154, 115, 0, 0, 0, 16, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 0, 68, 12,
    16, 10, 0, 31, 238, 3, 253, 139, 95, 20, 212, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];
const BLUE: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0,
    0, 0, 253, 212, 154, 115, 0, 0, 0, 15, 73, 68, 65, 84, 120, 156, 99, 96, 96, 248, 15, 70, 96,
    10, 0, 23, 246, 3, 253, 126, 235, 55, 243, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];

fn record(out: &mut Vec<u8>, tag: u16, level: u16, data: &[u8]) {
    out.extend(rhwp::serializer::record_writer::write_record(
        tag, level, data,
    ));
}

fn slot(code: u16, id: u32) -> [u16; 8] {
    let b = id.to_le_bytes();
    [
        code,
        u16::from_le_bytes([b[0], b[1]]),
        u16::from_le_bytes([b[2], b[3]]),
        0,
        0,
        0,
        0,
        code,
    ]
}

fn line(start: u32, y: i32, h: i32, width: i32) -> LineSeg {
    LineSeg {
        text_start: start,
        vertical_pos: y,
        line_height: h,
        text_height: h,
        baseline_distance: h * 85 / 100,
        line_spacing: 500,
        segment_width: width,
        tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
        ..Default::default()
    }
}

fn paragraph(raw: &[u16], lines: &[LineSeg], children: &[u8], level: u16) -> Vec<u8> {
    paragraph_styled(raw, lines, children, level, &[(0, 0)])
}

fn paragraph_styled(raw: &[u16], lines: &[LineSeg], children: &[u8], level: u16, shapes: &[(u32, u32)]) -> Vec<u8> {
    let mut header = vec![0; 22];
    header[..4].copy_from_slice(&(raw.len() as u32 + 1).to_le_bytes());
    header[12..14].copy_from_slice(&(shapes.len() as u16).to_le_bytes());
    header[16..18].copy_from_slice(&(lines.len() as u16).to_le_bytes());
    let mut out = Vec::new();
    record(&mut out, tags::HWPTAG_PARA_HEADER, level, &header);
    let bytes: Vec<u8> = raw
        .iter()
        .copied()
        .chain([13])
        .flat_map(u16::to_le_bytes)
        .collect();
    record(&mut out, tags::HWPTAG_PARA_TEXT, level + 1, &bytes);
    let shape_bytes: Vec<u8> = shapes.iter().flat_map(|(start, id)| start.to_le_bytes().into_iter().chain(id.to_le_bytes())).collect();
    record(&mut out, tags::HWPTAG_PARA_CHAR_SHAPE, level + 1, &shape_bytes);
    let mut rows = Vec::new();
    for l in lines {
        for v in [
            l.text_start as i32,
            l.vertical_pos,
            l.line_height,
            l.text_height,
            l.baseline_distance,
            l.line_spacing,
            l.column_start,
            l.segment_width,
            l.tag as i32,
        ] {
            rows.extend(v.to_le_bytes());
        }
    }
    record(&mut out, tags::HWPTAG_PARA_LINE_SEG, level + 1, &rows);
    out.extend(children);
    out
}

fn serialize(control: &Control, level: u16) -> Vec<u8> {
    let mut records = Vec::new();
    rhwp::serializer::control::serialize_control(control, level, None, &mut records);
    rhwp::serializer::record_writer::write_records(&records)
}

fn eq(script: String) -> Control {
    let mut e = Equation::default();
    e.script = script;
    e.font_size = 900;
    e.baseline = 80;
    e.font_name = "HYhwpEQ".into();
    e.version_info = "Equation Version 60".into();
    e.common.attr = 1;
    e.common.treat_as_char = true;
    e.common.width = 2200;
    e.common.height = 1125;
    Control::Equation(Box::new(e))
}

fn variation(which: usize) -> Table {
    let widths = if which == 0 {
        [3943, 2528, 7339, 2528, 3943]
    } else {
        [3943, 3519, 2670, 7198, 2670]
    };
    let heights = [3146, 1716, 3146];
    let mut t = Table::default();
    t.row_count = 3;
    t.col_count = 5;
    t.row_sizes = vec![5; 3];
    t.page_break = TablePageBreak::RowBreak;
    t.common.attr = 0x082a2311;
    t.common.treat_as_char = true;
    t.common.width = widths.iter().sum();
    t.common.height = 8008;
    t.common.margin = Padding {
        left: 283,
        right: 283,
        top: 283,
        bottom: 283,
    };
    t.outer_margin_left = 283;
    t.outer_margin_right = 283;
    t.outer_margin_top = 283;
    t.outer_margin_bottom = 283;
    for row in 0..3 {
        for col in 0..5 {
            t.cells.push(Cell {
                row: row as u16,
                col: col as u16,
                row_span: 1,
                col_span: 1,
                width: widths[col],
                height: heights[row],
                paragraphs: vec![Paragraph {
                    char_count: 9,
                    controls: vec![eq(format!("v_{{{}{}}}={}", which, row, col))],
                    line_segs: vec![line(0, 0, 1125, widths[col] as i32)],
                    ..Default::default()
                }],
                ..Default::default()
            });
        }
    }
    t.rebuild_grid();
    t
}

fn graphs() -> Table {
    let mut t = Table::default();
    t.row_count = 1;
    t.col_count = 2;
    t.row_sizes = vec![2];
    t.common.attr = 0x082a2211;
    t.common.treat_as_char = true;
    t.common.width = 28916;
    t.common.height = 14220;
    for (col, (width, height)) in [(14456, 13940), (14460, 12020)].into_iter().enumerate() {
        let mut pic = Picture::default();
        pic.common.attr = 1;
        pic.common.treat_as_char = true;
        pic.common.width = 13432;
        pic.common.height = height;
        pic.shape_attr.current_width = 13432;
        pic.shape_attr.current_height = height;
        pic.shape_attr.original_width = 13432;
        pic.shape_attr.original_height = height;
        pic.image_attr.bin_data_id = (col + 1) as u16;
        t.cells.push(Cell {
            row: 0,
            col: col as u16,
            row_span: 1,
            col_span: 1,
            width,
            height: 14220,
            paragraphs: vec![Paragraph {
                char_count: 9,
                controls: vec![Control::Picture(Box::new(pic))],
                line_segs: vec![line(0, 0, height as i32, 13432)],
                ..Default::default()
            }],
            ..Default::default()
        });
    }
    t.rebuild_grid();
    t
}

// Raw marker positions are explicitly asserted before CFB ingestion.
fn mixed_host(
    raw_len: usize,
    markers: &[usize],
    table_ci: usize,
    breaks: &[usize],
    starts: &[u32],
    heights: &[i32],
    table: Table,
    y: i32,
) -> Vec<u8> {
    mixed_host_content(raw_len, markers, table_ci, breaks, starts, heights, table, y, false)
}

fn mixed_host_content(raw_len: usize, markers: &[usize], table_ci: usize, breaks: &[usize], starts: &[u32], heights: &[i32], table: Table, y: i32, spaces: bool) -> Vec<u8> {
    let mut raw = vec!['a' as u16; raw_len];
    if spaces {
        assert_eq!(markers[0], 4);
        raw[0] = 0x00a0;
        raw[1] = '가' as u16;
        raw[2] = 30;
        raw[3] = 0x2007;
        raw[12] = 31;
    }
    for b in breaks {
        raw[*b] = 10;
    }
    let mut controls = Vec::new();
    for (ci, pos) in markers.iter().copied().enumerate() {
        let id = if ci == table_ci {
            tags::CTRL_TABLE
        } else {
            tags::CTRL_EQUATION
        };
        raw[pos..pos + 8].copy_from_slice(&slot(11, id));
        if ci == table_ci {
            controls.extend(serialize(&Control::Table(Box::new(table.clone())), 3));
        } else {
            controls.extend(serialize(&eq(format!("d_{}=1", ci)), 3));
        }
        assert_eq!(raw[pos], 11);
        assert_eq!(
            u32::from_le_bytes([
                raw[pos + 1] as u8,
                (raw[pos + 1] >> 8) as u8,
                raw[pos + 2] as u8,
                (raw[pos + 2] >> 8) as u8
            ]),
            id
        );
    }
    for b in breaks {
        assert_eq!(raw[*b], 10, "raw newline must not overlap a slot");
    }
    let mut cursor = y;
    let lines: Vec<_> = starts
        .iter()
        .zip(heights)
        .map(|(s, h)| {
            let l = line(*s, cursor, *h, 31456);
            cursor += *h + 500;
            l
        })
        .collect();
    if spaces {
        paragraph_styled(&raw, &lines, &controls, 2, &[(0, 0), (3, 1)])
    } else { paragraph(&raw, &lines, &controls, 2) }
}

fn fixture(graph: bool) -> Vec<u8> {
    fixture_with_columns(graph, false)
}

fn fixture_with_columns(graph: bool, split: bool) -> Vec<u8> {
    fixture_options(graph, split, false, false, false, false)
}

fn fixture_options(graph: bool, split: bool, compact: bool, spaces: bool, multi: bool, rewind: bool) -> Vec<u8> {
    fixture_options_height(graph, split, compact, spaces, multi, rewind, 2400)
}

fn fixture_options_height(graph: bool, split: bool, compact: bool, spaces: bool, multi: bool, rewind: bool, later_height: i32) -> Vec<u8> {
    let mut blank = DocumentCore::new_empty();
    blank.create_blank_document_native().unwrap();
    let doc = blank.document_mut();
    let cs = &mut doc.doc_info.char_shapes[0];
    cs.raw_data = None;
    cs.base_size = 900;
    cs.ratios = [100; 7];
    cs.relative_sizes = [100; 7];
    cs.spacings = [0; 7];
    let ps = &mut doc.doc_info.para_shapes[0];
    ps.raw_data = None;
    ps.spacing_before = 0;
    ps.spacing_after = 0;
    for id in 1..=2 {
        doc.doc_info.bin_data_list.push(BinData {
            attr: 0x21,
            data_type: BinDataType::Embedding,
            compression: BinDataCompression::NoCompress,
            storage_id: id,
            extension: Some("png".into()),
            ..Default::default()
        });
    }
    if spaces {
        for (lang, fonts) in doc.doc_info.font_faces.iter_mut().enumerate() {
            *fonts = vec![rhwp::model::style::Font {
                name: match lang { 0 => "바탕", 1 => "Arial", 5 => "Symbol", _ => "Courier New" }.into(),
                ..Default::default()
            }];
        }
        assert_eq!(doc.doc_info.char_shapes.len(), 1, "owned style fixture seed");
        doc.doc_info.char_shapes[0].font_ids = [0; 7];
        let mut second = doc.doc_info.char_shapes[0].clone();
        second.base_size = 1100;
        doc.doc_info.char_shapes.push(second);
    }
    let mut sd = doc.sections[0].section_def.clone();
    sd.page_def.width = if split { 65912 } else { 33456 };
    sd.page_def.height = if split { 25000 } else { 110000 };
    sd.page_def.margin_left = 1000;
    sd.page_def.margin_right = 1000;
    sd.page_def.margin_top = 1000;
    sd.page_def.margin_bottom = 1000;
    sd.page_def.margin_header = 0;
    sd.page_def.margin_footer = 0;
    // Visible separator avoids treating whole-note spacing certification as this test's target.
    sd.endnote_shape.separator_line_type = 1;
    sd.endnote_shape.separator_line_width = 1;
    sd.endnote_shape.separator_length = 4000;
    if compact {
        sd.endnote_shape.separator_line_type = 0;
        sd.endnote_shape.separator_line_width = 0;
        sd.endnote_shape.separator_length = 0;
        sd.endnote_shape.separator_margin_top = 0;
        sd.endnote_shape.separator_margin_bottom = 0;
        sd.endnote_shape.note_spacing = 0;
        sd.endnote_shape.raw_unknown = 0;
    }
    let mut section_raw = slot(2, tags::CTRL_SECTION_DEF).to_vec();
    let mut section_controls = serialize(&Control::SectionDef(Box::new(sd)), 1);
    if split {
        section_raw.extend(slot(2, tags::CTRL_COLUMN_DEF));
        section_controls.extend(serialize(
            &Control::ColumnDef(ColumnDef {
                column_count: 2,
                same_width: true,
                spacing: 1000,
                ..Default::default()
            }),
            1,
        ));
    }
    let mut section = paragraph(
        &section_raw,
        &[line(0, 0, 1125, 31456)],
        &section_controls,
        0,
    );
    let head_height = if split { if multi { 16000 } else { 12000 } } else { 1125 };
    let target_y = head_height + 500;
    let mut note = paragraph(
        &"HEAD".encode_utf16().collect::<Vec<_>>(),
        &[line(0, 0, head_height, 31456)],
        &[],
        2,
    );
    if graph {
        note.extend(mixed_host(
            37,
            &[3, 29],
            1,
            &[],
            &[0, 26],
            &[1125, 14220],
            graphs(),
            target_y,
        ));
    } else {
        note.extend(mixed_host_content(
            127,
            &[4, 16, 31, 65, 74, 90, 106, 119],
            3,
            &[15, 64, 73, 105],
            &[0, 16, 65, 74, 106],
            &[2580, 1350, 8574, 2580, 2580],
            variation(0),
            target_y,
            spaces,
        ));
        note.extend(mixed_host(
            172,
            &[4, 16, 28, 37, 46, 59, 68, 82, 91, 106, 140, 149, 161],
            10,
            &[15, 27, 36, 45, 58, 67, 90, 139, 148],
            &[0, 16, 28, 37, 46, 59, 68, 91, 140, 149],
            &[1525, 1525, 1525, 1538, 1538, 2580, 2580, 1350, 8574, 2175],
            variation(1),
            if split { 35000 } else { 22000 },
        ));
    }
    let mut children = Vec::new();
    let mut en = tags::CTRL_ENDNOTE.to_le_bytes().to_vec();
    en.extend([1u8, 0, 0, 0]);
    en.extend([0; 8]);
    record(&mut children, tags::HWPTAG_CTRL_HEADER, 1, &en);
    let mut list = vec![0; 16];
    list[..4].copy_from_slice(&(if graph { 2u32 } else { 3u32 }).to_le_bytes());
    record(&mut children, tags::HWPTAG_LIST_HEADER, 2, &list);
    children.extend(note);
    let mut body = "BODY".encode_utf16().collect::<Vec<_>>();
    body.extend(slot(17, tags::CTRL_ENDNOTE));
    section.extend(paragraph(
        &body,
        &[line(0, 1625, 1125, 31456)],
        &children,
        0,
    ));
    if multi {
        let mut later = paragraph(&"LATER HEAD".encode_utf16().collect::<Vec<_>>(), &[line(0, 0, 1125, 31456)], &[], 2);
        if rewind {
            let mut raw = Vec::new();
            let mut controls = Vec::new();
            for i in 0..3 {
                raw.extend(slot(11, tags::CTRL_EQUATION));
                raw.push(('x' as u16) + i);
                controls.extend(serialize(&eq(format!("r_{}=2", i)), 3));
            }
            later.extend(paragraph(&raw, &[line(0, 0, 2768, 31456), line(9, 4000, 2768, 31456), line(18, 1000, 2768, 31456)], &controls, 2));
        } else {
            later.extend(paragraph(&"LATER FIT".encode_utf16().collect::<Vec<_>>(), &[line(0, 1625, later_height, 31456)], &[], 2));
        }
        let mut children = Vec::new();
        let mut en = tags::CTRL_ENDNOTE.to_le_bytes().to_vec(); en.extend([2u8, 0, 0, 0]); en.extend([0; 8]);
        record(&mut children, tags::HWPTAG_CTRL_HEADER, 1, &en);
        let mut list = vec![0; 16]; list[..4].copy_from_slice(&2u32.to_le_bytes());
        record(&mut children, tags::HWPTAG_LIST_HEADER, 2, &list); children.extend(later);
        let mut body = "NEXT BODY".encode_utf16().collect::<Vec<_>>(); body.extend(slot(17, tags::CTRL_ENDNOTE));
        section.extend(paragraph(&body, &[line(0, 3250, 1125, 31456)], &children, 0));
    }
    let mut header = vec![0; 256];
    header[..17].copy_from_slice(b"HWP Document File");
    header[32..36].copy_from_slice(&[0, 0, 0, 5]);
    let info = rhwp::serializer::doc_info::serialize_doc_info(&doc.doc_info, &doc.doc_properties);
    let mut cfb =
        cfb::CompoundFile::create_with_version(cfb::Version::V3, Cursor::new(Vec::new())).unwrap();
    cfb.create_storage_all("/BodyText").unwrap();
    cfb.create_storage_all("/BinData").unwrap();
    for (path, bytes) in [
        ("/FileHeader", header),
        ("/DocInfo", info),
        ("/BodyText/Section0", section),
        ("/BinData/BIN0001.png", RED.to_vec()),
        ("/BinData/BIN0002.png", BLUE.to_vec()),
    ] {
        cfb.create_stream(path).unwrap().write_all(&bytes).unwrap();
    }
    cfb.into_inner().into_inner()
}

fn assert_raw_contract(core: &DocumentCore, bytes: &[u8], graph: bool) {
    let section = &core.document().sections[0];
    assert_eq!(section.paragraphs.len(), 2, "owned body source address");
    let Control::Endnote(note) = &section.paragraphs[1].controls[0] else {
        panic!("owned s0/body1/control0");
    };
    let targets: Vec<(usize, usize, u32, usize)> = if graph {
        vec![(1, 1, 29, 1)]
    } else {
        vec![(1, 3, 65, 2), (2, 10, 140, 8)]
    };
    for &(np, ci, raw, row) in &targets {
        let p = &note.paragraphs[np];
        let Control::Table(table) = &p.controls[ci] else {
            panic!("parsed note{np}/control{ci}");
        };
        assert_eq!(p.line_segs[row].text_start, if graph { 26 } else { raw });
        let markers = p.control_text_positions();
        assert_eq!(
            markers[ci],
            if graph {
                21
            } else if np == 1 {
                41
            } else {
                60
            }
        );
        assert_eq!(table.cells.len(), if graph { 2 } else { 15 });
        // An explicit raw-slot assertion independent of visible positions.
        let mut cfb = cfb::CompoundFile::open(Cursor::new(bytes.to_vec())).unwrap();
        let mut stream = Vec::new();
        std::io::Read::read_to_end(
            &mut cfb.open_stream("/BodyText/Section0").unwrap(),
            &mut stream,
        )
        .unwrap();
        let records = rhwp::parser::record::Record::read_all(&stream).unwrap();
        let raw_hosts: Vec<_> = records
            .iter()
            .filter(|r| r.tag_id == tags::HWPTAG_PARA_TEXT && r.level == 3)
            .collect();
        let payload = &raw_hosts[np].data;
        assert_eq!(
            &payload[raw as usize * 2..raw as usize * 2 + 16],
            slot(11, tags::CTRL_TABLE)
                .into_iter()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>()
                .as_slice()
        );
        for (cell_idx, cell) in table.cells.iter().enumerate() {
            assert_eq!(cell.paragraphs.len(), 1);
            if graph {
                let Control::Picture(pic) = &cell.paragraphs[0].controls[0] else {
                    panic!("parsed graph cell{cell_idx}/para0/control0");
                };
                assert_eq!(pic.image_attr.bin_data_id, (cell_idx + 1) as u16);
            } else {
                let Control::Equation(e) = &cell.paragraphs[0].controls[0] else {
                    panic!("parsed variation cell{cell_idx}/para0/control0");
                };
                assert_eq!(
                    e.script,
                    format!("v_{{{}{}}}={}", np - 1, cell_idx / 5, cell_idx % 5)
                );
            }
        }
    }
}

fn note(core: &DocumentCore) -> &rhwp::model::footnote::Endnote {
    assert_eq!(core.document().sections.len(), 1);
    let notes: Vec<_> = core.document().sections[0]
        .paragraphs
        .iter()
        .flat_map(|p| p.controls.iter())
        .filter_map(|c| match c {
            Control::Endnote(n) => Some(n.as_ref()),
            _ => None,
        })
        .collect();
    assert_eq!(
        notes.len(),
        1,
        "owned fixture has one note, no deferred-section offset"
    );
    notes[0]
}

fn targets(graph: bool) -> Vec<(usize, usize)> {
    if graph {
        vec![(1, 1)]
    } else {
        vec![(1, 3), (2, 10)]
    }
}

fn raw_control_starts(p: &Paragraph) -> Vec<u32> {
    // All controls in these owned hosts are eight-unit Equation/Table slots.
    assert!(p
        .controls
        .iter()
        .all(|c| matches!(c, Control::Equation(_) | Control::Table(_))));
    let positions = p.control_text_positions();
    let chars: Vec<_> = p.text.chars().collect();
    assert_eq!(chars.len(), p.char_offsets.len());
    positions
        .iter()
        .enumerate()
        .map(|(ci, pos)| {
            let group_start = positions.partition_point(|v| v < pos);
            let group_end = positions.partition_point(|v| v <= pos);
            let first = if let Some(offset) = p.char_offsets.get(*pos) {
                offset
                    .checked_sub((group_end - group_start) as u32 * 8)
                    .expect("raw slot gap")
            } else {
                p.char_offsets
                    .last()
                    .zip(chars.last())
                    .map_or(0, |(o, c)| o + c.len_utf16() as u32)
            };
            first + (ci - group_start) as u32 * 8
        })
        .collect()
}

fn positive(b: BoundingBox) {
    assert!([b.x, b.y, b.width, b.height].iter().all(|v| v.is_finite()));
    assert!(b.width > 0.0 && b.height > 0.0, "positive geometry: {b:?}");
}

fn intersection(a: BoundingBox, b: BoundingBox) -> BoundingBox {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    BoundingBox::new(
        x,
        y,
        (a.x + a.width).min(b.x + b.width) - x,
        (a.y + a.height).min(b.y + b.height) - y,
    )
}

#[derive(Clone, Copy, Debug)]
struct Location {
    page: u32,
    column: u16,
    bbox: BoundingBox,
}

struct Visible<'a> {
    node: &'a RenderNode,
    location: Location,
    clip: BoundingBox,
    visible: bool,
}

fn walk<'a>(
    n: &'a RenderNode,
    page: u32,
    column: u16,
    clip: BoundingBox,
    visible: bool,
    out: &mut Vec<Visible<'a>>,
) {
    let column = if let RenderNodeType::Column(c) = &n.node_type {
        *c
    } else {
        column
    };
    let clip = match &n.node_type {
        RenderNodeType::Body { clip_rect: Some(b) } => intersection(clip, *b),
        RenderNodeType::TableCell(c) if c.clip => intersection(clip, n.bbox),
        _ => clip,
    };
    out.push(Visible {
        node: n,
        location: Location {
            page,
            column,
            bbox: n.bbox,
        },
        clip,
        visible: visible && n.visible,
    });
    for c in &n.children {
        walk(c, page, column, clip, visible && n.visible, out);
    }
}

fn assert_visible(v: &Visible<'_>) {
    positive(v.node.bbox);
    assert!(v.visible, "node and ancestors are visible");
    positive(intersection(v.node.bbox, v.clip));
}

fn assert_coverage(core: &DocumentCore, graph: bool, require_authored_row: bool) -> Vec<Location> {
    assert_coverage_at(core, graph, require_authored_row, note(core))
}

fn assert_coverage_at(core: &DocumentCore, graph: bool, require_authored_row: bool, note: &rhwp::model::footnote::Endnote) -> Vec<Location> {
    // Both loaded and reflowed rows must own their table's reservation.
    let _ = require_authored_row;
    let mut locations = Vec::new();
    for (np, ci) in targets(graph) {
        let p = &note.paragraphs[np];
        let Control::Table(table) = &p.controls[ci] else {
            panic!("source table note{np}/control{ci}");
        };
        // Valid only for this explicitly single-note owned fixture, never original addresses.
        let virtual_pi = core.document().sections[0].paragraphs.len() + np;
        let raw = raw_control_starts(p)[ci];
        let owner = p
            .line_segs
            .partition_point(|s| s.text_start <= raw)
            .saturating_sub(1);
        let mut table_locations = Vec::new();
        let mut descendants = Vec::new();
        let mut owners = Vec::new();
        for page in 0..core.page_count() {
            let tree = core.build_page_render_tree(page).unwrap();
            let mut all = Vec::new();
            walk(&tree.root, page, 0, tree.root.bbox, true, &mut all);
            for v in all {
                let n = v.node;
                match &n.node_type {
                    RenderNodeType::Table(t)
                        if (t.section_index, t.para_index, t.control_index)
                            == (Some(0), Some(virtual_pi), Some(ci)) =>
                    {
                        assert_visible(&v);
                        table_locations.push(v.location);
                    }
                    RenderNodeType::TextLine(l)
                        if l.section_index == Some(0)
                            && l.para_index == Some(virtual_pi)
                            && l.line_index == Some(owner as u32) =>
                    {
                        owners.push(v.location);
                    }
                    RenderNodeType::Image(img) if graph => {
                        if let Some(ctx) = &img.cell_context {
                            if ctx.parent_para_index == virtual_pi
                                && ctx.path[0].control_index == ci
                            {
                                assert_visible(&v);
                                assert_eq!(img.section_index, Some(0));
                                assert_eq!(ctx.path.len(), 1);
                                assert_eq!(ctx.path[0].cell_para_index, 0);
                                assert_eq!(img.control_index, Some(0));
                                let cell = ctx.path[0].cell_index;
                                assert!(cell < 2);
                                assert_eq!(img.bin_data_id, (cell + 1) as u16);
                                assert_eq!(
                                    img.data.as_deref(),
                                    Some(if cell == 0 { RED } else { BLUE })
                                );
                                assert!(img.opacity.is_finite() && img.opacity > 0.0);
                                if let Some((left, top, right, bottom)) = img.crop {
                                    assert!(right > left && bottom > top, "positive source crop");
                                }
                                descendants.push((cell, v.location));
                            }
                        }
                    }
                    RenderNodeType::Equation(e) if !graph => {
                        if let Some(ctx) = &e.cell_context {
                            if ctx.parent_para_index == virtual_pi
                                && ctx.path[0].control_index == ci
                            {
                                assert_visible(&v);
                                assert_eq!(e.section_index, Some(0));
                                assert_eq!(e.para_index, Some(virtual_pi));
                                assert_eq!(e.control_index, Some(ci));
                                assert_eq!(ctx.path.len(), 1);
                                assert_eq!(ctx.path[0].cell_para_index, 0);
                                assert_eq!(e.inner_control_index, Some(0));
                                assert!(!e.svg_content.is_empty());
                                descendants.push((ctx.path[0].cell_index, v.location));
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        assert_eq!(
            table_locations.len(),
            1,
            "all-page exact source table note{np}/control{ci}"
        );
        descendants.sort_by_key(|(cell, _)| *cell);
        assert_eq!(
            descendants
                .iter()
                .map(|(cell, _)| *cell)
                .collect::<Vec<_>>(),
            (0..table.cells.len()).collect::<Vec<_>>(),
            "each exact cell/para0/control0 once across all pages"
        );
        let location = table_locations[0];
        for (_, child) in descendants {
            assert_eq!((child.page, child.column), (location.page, location.column));
            positive(intersection(child.bbox, location.bbox));
        }
        {
            assert_eq!(owners.len(), 1, "current formatter table owner row must survive once");
            assert!((location.bbox.y - owners[0].bbox.y - rhwp::renderer::hwpunit_to_px(table.outer_margin_top as i32, 96.0)).abs() < 0.5,
                "table starts in its current row reservation, without a second advance");
            assert_eq!(
                (location.page, location.column),
                (owners[0].page, owners[0].column),
                "table belongs to its source row fragment"
            );
            let reservation = BoundingBox::new(
                location.bbox.x,
                owners[0].bbox.y,
                location.bbox.width,
                rhwp::renderer::hwpunit_to_px(p.line_segs[owner].line_height, 96.0),
            );
            positive(intersection(location.bbox, reservation));
        }
        locations.push(location);
    }
    locations
}

fn check(graph: bool, policy: FontMetricsPolicy) {
    let bytes = fixture(graph);
    let core = DocumentCore::from_bytes_with_font_metrics(&bytes, policy).unwrap();
    assert_raw_contract(&core, &bytes, graph);
    let model_before = format!("{:?}", core.document().sections);
    assert_coverage(&core, graph, true);
    assert_eq!(
        format!("{:?}", core.document().sections),
        model_before,
        "drawing leaves source unchanged"
    );
}

#[test]
fn owned_variation_tables_keep_all_source_cell_equations() {
    for p in [
        FontMetricsPolicy::HancomWindows,
        FontMetricsPolicy::HcrDeclared,
    ] {
        check(false, p);
    }
}

#[test]
fn owned_trailing_graph_table_keeps_both_source_cell_pictures() {
    for p in [
        FontMetricsPolicy::HancomWindows,
        FontMetricsPolicy::HcrDeclared,
    ] {
        check(true, p);
    }
}

#[test]
fn owned_authored_mixed_rows_keep_their_text_and_table_reservation() {
    for graph in [false, true] {
        let bytes = fixture(graph);
        for policy in [
            FontMetricsPolicy::HancomWindows,
            FontMetricsPolicy::HcrDeclared,
        ] {
            let core = DocumentCore::from_bytes_with_font_metrics(&bytes, policy).unwrap();
            assert_raw_contract(&core, &bytes, graph);
            for (np, ci) in targets(graph) {
                let p = &note(&core).paragraphs[np];
                let comp = rhwp::renderer::composer::compose_endnote_with_policy(p, policy);
                assert_eq!(
                    comp.lines.len(),
                    p.line_segs.len(),
                    "saved newline row membership"
                );
                for (row, seg) in comp.lines.iter().zip(&p.line_segs) {
                    assert_eq!(row.line_height, seg.line_height);
                    assert_eq!(row.baseline_distance, seg.baseline_distance);
                    assert_eq!(row.line_spacing, seg.line_spacing);
                    assert_eq!(
                        row.char_start,
                        p.char_offsets
                            .partition_point(|offset| *offset < seg.text_start)
                    );
                }
                let text: String = comp
                    .lines
                    .iter()
                    .flat_map(|l| l.runs.iter())
                    .map(|r| r.text.as_str())
                    .collect();
                assert_eq!(
                    text,
                    p.text.replace('\n', ""),
                    "composition neither loses nor duplicates prose"
                );
                let raw = raw_control_starts(p)[ci];
                let owner = p
                    .line_segs
                    .partition_point(|s| s.text_start <= raw)
                    .saturating_sub(1);
                assert_eq!(
                    comp.lines[owner].line_height,
                    if graph { 14220 } else { 8574 }
                );
                if !graph {
                    assert!(comp.lines[owner].runs.is_empty());
                }
            }
        }
    }
}

fn assert_reopened(core: &DocumentCore, graph: bool, policy: FontMetricsPolicy) {
    let before = note(core);
    let bytes = core.export_hwpx_native().unwrap();
    let reopened = DocumentCore::from_bytes_with_font_metrics(&bytes, policy).unwrap();
    for (np, ci) in targets(graph) {
        let a = &before.paragraphs[np];
        let b = &note(&reopened).paragraphs[np];
        assert_eq!(a.text, b.text);
        let (Control::Table(a), Control::Table(b)) = (&a.controls[ci], &b.controls[ci]) else {
            panic!("reopened source table");
        };
        assert_eq!(
            (a.row_count, a.col_count, a.cells.len()),
            (b.row_count, b.col_count, b.cells.len())
        );
        for (a, b) in a.cells.iter().zip(&b.cells) {
            assert_eq!(
                (a.row, a.col, a.row_span, a.col_span, a.width, a.height),
                (b.row, b.col, b.row_span, b.col_span, b.width, b.height)
            );
            assert_eq!(a.paragraphs.len(), b.paragraphs.len());
            match (&a.paragraphs[0].controls[0], &b.paragraphs[0].controls[0]) {
                (Control::Equation(a), Control::Equation(b)) => assert_eq!(a.script, b.script),
                (Control::Picture(a), Control::Picture(b)) => {
                    let data = |id, core: &DocumentCore| {
                        core.document()
                            .bin_data_content
                            .iter()
                            .find(|v| v.id == id)
                            .unwrap()
                            .data
                            .load_shared()
                    };
                    assert_eq!(
                        data(a.image_attr.bin_data_id, core),
                        data(b.image_attr.bin_data_id, &reopened)
                    );
                }
                _ => panic!("reopened descendant kind"),
            }
        }
    }
    assert_coverage(&reopened, graph, false);
}

#[test]
fn owned_mixed_tables_and_picture_bytes_survive_hwpx_reopen() {
    for graph in [false, true] {
        for policy in [
            FontMetricsPolicy::HancomWindows,
            FontMetricsPolicy::HcrDeclared,
        ] {
            let core = DocumentCore::from_bytes_with_font_metrics(&fixture(graph), policy).unwrap();
            assert_coverage(&core, graph, true);
            assert_reopened(&core, graph, policy);
        }
    }
}

fn cached_text(core: &DocumentCore) -> String {
    (0..core.page_count())
        .flat_map(|page| {
            core.build_page_layer_tree(page)
                .unwrap()
                .text_sources
                .entries
        })
        .map(|entry| entry.text)
        .collect()
}

#[test]
fn public_mixed_note_edit_inverse_and_redo_keep_current_tables_visible() {
    for graph in [false, true] {
        for policy in [
            FontMetricsPolicy::HancomWindows,
            FontMetricsPolicy::HcrDeclared,
        ] {
            let mut core =
                DocumentCore::from_bytes_with_font_metrics(&fixture(graph), policy).unwrap();
            let before = note(&core).paragraphs[1].text.clone();
            let offsets = note(&core).paragraphs[1].char_offsets.clone();
            let starts = raw_control_starts(&note(&core).paragraphs[1]);
            let controls = format!("{:?}", note(&core).paragraphs[1].controls);
            assert_coverage(&core, graph, true);
            cached_text(&core);
            let prefix = "EDITED ".repeat(100);
            // Public inverse operations used by the Studio insertion command's undo/redo.
            // This is not a test of the Studio undo stack.
            core.insert_text_in_footnote_native(0, 1, 0, 1, 0, &prefix)
                .unwrap();
            for refresh in [false, true] {
                if refresh {
                    core.refresh_layout_native();
                }
                let p = &note(&core).paragraphs[1];
                assert_eq!(p.text, format!("{prefix}{before}"));
                assert!(core.document().sections[0].raw_stream.is_none());
                assert_eq!(
                    raw_control_starts(p),
                    starts
                        .iter()
                        .map(|v| v + prefix.len() as u32)
                        .collect::<Vec<_>>()
                );
                assert_eq!(format!("{:?}", p.controls), controls);
                assert!(cached_text(&core).contains(&prefix));
                assert_coverage(&core, graph, false);
            }
            assert_reopened(&core, graph, policy);
            core.delete_text_in_footnote_native(0, 1, 0, 1, 0, prefix.chars().count())
                .unwrap();
            assert_eq!(note(&core).paragraphs[1].text, before);
            assert_eq!(note(&core).paragraphs[1].char_offsets, offsets);
            assert_eq!(raw_control_starts(&note(&core).paragraphs[1]), starts);
            assert!(!cached_text(&core).contains(&prefix));
            assert_coverage(&core, graph, false);
            assert_reopened(&core, graph, policy);
            core.insert_text_in_footnote_native(0, 1, 0, 1, 0, &prefix)
                .unwrap();
            assert!(cached_text(&core).contains(&prefix));
            assert_coverage(&core, graph, false);
            assert_reopened(&core, graph, policy);
        }
    }
}

#[test]
fn owned_mixed_tables_cross_columns_with_their_authored_row_once() {
    for graph in [false, true] {
        for policy in [
            FontMetricsPolicy::HancomWindows,
            FontMetricsPolicy::HcrDeclared,
        ] {
            let core = DocumentCore::from_bytes_with_font_metrics(
                &fixture_with_columns(graph, true),
                policy,
            )
            .unwrap();
            let locations = assert_coverage(&core, graph, true);
            assert!(
                locations.iter().any(|v| v.page > 0 || v.column > 0),
                "bounded frame must exercise transfer"
            );
            // Require the target host itself on multiple fragments, not merely a new-page note.
            let pi = core.document().sections[0].paragraphs.len() + 1;
            let mut frames = std::collections::BTreeSet::new();
            for page in 0..core.page_count() {
                let tree = core.build_page_render_tree(page).unwrap();
                let mut all = Vec::new();
                walk(&tree.root, page, 0, tree.root.bbox, true, &mut all);
                for v in all {
                    if let RenderNodeType::TextLine(line) = &v.node.node_type {
                        if line.section_index == Some(0) && line.para_index == Some(pi) {
                            frames.insert((page, v.location.column));
                        }
                    }
                }
            }
            assert!(
                frames.len() > 1,
                "fixture must actually split a mixed host, otherwise this is not split coverage"
            );
        }
    }
}

fn host_index(core: &DocumentCore) -> usize {
    core.document().sections[0].paragraphs.iter().position(|p| p.controls.iter().any(|c| matches!(c, Control::Endnote(_)))).unwrap()
}

#[test]
fn public_body_edit_and_host_transfer_keep_current_mixed_row_owners() {
    for graph in [false, true] {
        for policy in [FontMetricsPolicy::HancomWindows, FontMetricsPolicy::HcrDeclared] {
            let mut core = DocumentCore::from_bytes_with_font_metrics(&fixture(graph), policy).unwrap();
            assert_coverage(&core, graph, true);
            cached_text(&core);
            let before = host_index(&core);
            let other = if before == 0 { 1 } else { 0 };
            core.insert_text_native(0, other, 0, "BODY EDIT ").unwrap();
            assert_coverage(&core, graph, false);
            assert_reopened(&core, graph, policy);
            core.insert_paragraph_native(0, before).unwrap();
            assert_eq!(host_index(&core), before + 1, "actual source host moved");
            assert_coverage(&core, graph, false);
            assert_reopened(&core, graph, policy);
            core.delete_paragraph_native(0, before).unwrap();
            assert_eq!(host_index(&core), before);
            assert_coverage(&core, graph, false);
            core.refresh_layout_native();
            assert_coverage(&core, graph, false);
            assert_reopened(&core, graph, policy);
        }
    }
}

#[test]
fn public_note_spacing_and_style_edits_revoke_mixed_authored_rows() {
    for graph in [false, true] {
        for policy in [FontMetricsPolicy::HancomWindows, FontMetricsPolicy::HcrDeclared] {
            let mut core = DocumentCore::from_bytes_with_font_metrics(&fixture(graph), policy).unwrap();
            assert_coverage(&core, graph, true);
            let host = host_index(&core);
            let old_style = note(&core).paragraphs[1].para_shape_id;
            core.apply_para_format_in_footnote_native(0, host, 0, 1,
                r#"{"lineSpacing":120,"lineSpacingType":"Percent"}"#).unwrap();
            assert_ne!(note(&core).paragraphs[1].para_shape_id, old_style, "actual style edit");
            assert_coverage(&core, graph, false);
            assert_reopened(&core, graph, policy);
            core.set_para_shape_id_in_footnote_native(0, host, 0, 1, old_style).unwrap();
            assert_coverage(&core, graph, false);
            let end = note(&core).paragraphs[1].text.chars().count();
            let before = note(&core).paragraphs[1].char_shapes.clone();
            core.apply_char_format_in_footnote_native(0, host, 0, 1, 0, end,
                r#"{"fontSize":1200}"#).unwrap();
            assert!(note(&core).paragraphs[1].char_shapes.iter().map(|s| (s.start_pos,s.char_shape_id)).ne(before.iter().map(|s| (s.start_pos,s.char_shape_id))), "actual font/style edit");
            assert_coverage(&core, graph, false);
            core.refresh_layout_native();
            assert_coverage(&core, graph, false);
            assert_reopened(&core, graph, policy);
        }
    }
}


fn note_list(core: &DocumentCore) -> Vec<&rhwp::model::footnote::Endnote> {
    core.document().sections[0].paragraphs.iter().flat_map(|p| &p.controls)
        .filter_map(|c| match c { Control::Endnote(n) => Some(n.as_ref()), _ => None }).collect()
}

fn rendered_rows(core: &DocumentCore, pi: usize) -> Vec<(usize, Location)> {
    let mut result = Vec::new();
    for page in 0..core.page_count() {
        let tree = core.build_page_render_tree(page).unwrap();
        let mut all = Vec::new(); walk(&tree.root, page, 0, tree.root.bbox, true, &mut all);
        for v in all {
            if let RenderNodeType::TextLine(line) = &v.node.node_type {
                if line.section_index == Some(0) && line.para_index == Some(pi) {
                    assert_visible(&v);
                    result.push((line.line_index.unwrap() as usize, v.location));
                }
            }
        }
    }
    result.sort_by_key(|(row, _)| *row);
    result
}

fn assert_compact_rows(core: &DocumentCore, graph: bool) {
    let shape = &core.document().sections[0].section_def.endnote_shape;
    assert_eq!((shape.separator_line_type, shape.separator_line_width, shape.separator_length), (0, 0, 0), "actual zero separator fixture");
    assert_eq!(shape.raw_unknown, 0, "actual zero between-notes spacing");
    let notes = note_list(core);
    assert_coverage_at(core, graph, false, notes[0]);
    let mut checked = 0;
    for (np, _) in targets(graph) {
        let source = &notes[0].paragraphs[np];
        let rows = rendered_rows(core, core.document().sections[0].paragraphs.len() + np);
        assert_eq!(rows.iter().map(|(row, _)| *row).collect::<Vec<_>>(), (0..source.line_segs.len()).collect::<Vec<_>>(), "each current mixed row exactly once");
        for pair in rows.windows(2) {
            let (row, a) = pair[0]; let (_, b) = pair[1];
            if (a.page, a.column) == (b.page, b.column) {
                let h = source.line_segs[row].line_height;
                let expected = rhwp::renderer::hwpunit_to_px(h - h / 10, 96.0);
                assert!((b.bbox.y - a.bbox.y - expected).abs() < 0.5, "compact row advances once: actual {} expected {expected}", b.bbox.y - a.bbox.y);
                checked += 1;
            }
        }
    }
    assert!(checked > 0, "fixture must execute a same-fragment negative-gap interval");
}

fn assert_space_occurrences(core: &DocumentCore, policy: FontMetricsPolicy) -> Vec<(String, f64)> {
    use rhwp::model::paragraph::{SpecialSpaceOrigin, SpecialSpaceOriginKind as Kind};
    let p = &note(core).paragraphs[1];
    assert_eq!(p.special_space_origins.iter().map(|o| o.origin).collect::<Vec<_>>(), vec![Kind::Literal, Kind::NbSpace, Kind::Literal, Kind::FwSpace]);
    assert!(p.char_shapes.len() >= 2, "actual source style boundary");
    let comp = rhwp::renderer::composer::compose_endnote_with_policy(p, policy);
    assert_eq!(comp.lines.len(), p.line_segs.len());
    assert!(comp.lines.iter().any(|l| l.has_line_break), "terminal newline is a row cut");
    let mut composed_origins = Vec::new();
    for (row, line) in comp.lines.iter().enumerate() {
        let scalar = p.char_offsets.partition_point(|o| *o < p.line_segs[row].text_start);
        assert_eq!(line.char_start, scalar);
        let mut start = scalar;
        for run in &line.runs {
            for origin in &run.special_space_origins {
                composed_origins.push(SpecialSpaceOrigin { char_idx: start + origin.char_idx, origin: origin.origin });
                if policy == FontMetricsPolicy::HcrDeclared && origin.origin == Kind::Literal {
                    let ch = run.text.chars().nth(origin.char_idx).unwrap();
                    assert_eq!(run.lang_index, if ch == '\u{00a0}' { 1 } else { 5 });
                }
            }
            start += run.text.chars().count();
        }
    }
    assert_eq!(composed_origins, p.special_space_origins, "replacement runs retain every source occurrence");
    let pi = core.document().sections[0].paragraphs.len() + 1;
    let mut rendered = Vec::new();
    let mut literal_advances = Vec::new();
    for page in 0..core.page_count() {
        let tree = core.build_page_render_tree(page).unwrap();
        let mut all = Vec::new(); walk(&tree.root, page, 0, tree.root.bbox, true, &mut all);
        for v in all {
            if let RenderNodeType::TextRun(run) = &v.node.node_type {
                if run.section_index != Some(0) || run.para_index != Some(pi) || run.cell_context.is_some() { continue; }
                let start = run.char_start.unwrap();
                for origin in &run.style.special_space_origins {
                    let scalar = start + origin.char_idx;
                    let ch = p.text.chars().nth(scalar).unwrap();
                    assert_eq!(run.text.chars().nth(origin.char_idx), Some(ch));
                    let raw = p.char_offsets[scalar];
                    let shape = p.char_shapes.iter().rev().find(|s| s.start_pos <= raw).unwrap().char_shape_id;
                    assert_eq!(run.char_shape_id, Some(shape));
                    if policy == FontMetricsPolicy::HcrDeclared && origin.origin == Kind::Literal {
                        assert_eq!(run.style.font_family, if ch == '\u{00a0}' { "Arial" } else { "Symbol" });
                        assert_eq!(run.text.chars().count(), 1, "literal slot is an isolated glyph run");
                        assert!(v.node.bbox.width.is_finite() && v.node.bbox.width > 0.0);
                        literal_advances.push((run.style.font_family.clone(), v.node.bbox.width));
                    }
                    assert_visible(&v);
                    rendered.push(SpecialSpaceOrigin { char_idx: scalar, origin: origin.origin });
                }
            }
        }
    }
    rendered.sort_by_key(|o| o.char_idx);
    assert_eq!(rendered, p.special_space_origins, "public rendered text retains every space/style occurrence once");
    assert_coverage(core, false, false);
    literal_advances
}

#[test]
fn mixed_literal_and_control_spaces_keep_occurrences_styles_after_edit_and_reopen() {
    for policy in [FontMetricsPolicy::HancomWindows, FontMetricsPolicy::HcrDeclared] {
        let mut core = DocumentCore::from_bytes_with_font_metrics(&fixture_options(false, false, false, true, false, false), policy).unwrap();
        let initial = &note(&core).paragraphs[1];
        assert_eq!(initial.special_space_origins.iter().map(|o| o.char_idx).collect::<Vec<_>>(),
            vec![0, 2, 3, 4], "v4 isolated literal NBSP before Korean scalar");
        assert_eq!(initial.special_space_origins.iter().map(|o| initial.char_offsets[o.char_idx]).collect::<Vec<_>>(),
            vec![0, 2, 3, 12], "literal/control raw occurrence addresses");
        assert!(initial.char_shapes.iter().any(|s| s.start_pos == 3 && s.char_shape_id == 1),
            "raw style boundary 3 retained");
        let before = assert_space_occurrences(&core, policy);
        core.insert_text_in_footnote_native(0, host_index(&core), 0, 1, 0, "앞 ").unwrap();
        assert_eq!(note(&core).paragraphs[1].special_space_origins.iter()
            .map(|o| o.char_idx).collect::<Vec<_>>(), vec![2, 4, 5, 6],
            "public prefix edit shifts every occurrence by two scalars");
        let edited = assert_space_occurrences(&core, policy);
        assert_eq!(before.len(), edited.len());
        for (a, b) in before.iter().zip(&edited) {
            assert_eq!(a.0, b.0); assert!((a.1 - b.1).abs() < 0.01, "literal glyph advance after edit");
        }
        let reopened = DocumentCore::from_bytes_with_font_metrics(&core.export_hwpx_native().unwrap(), policy).unwrap();
        assert_eq!(note(&core).paragraphs[1].special_space_origins, note(&reopened).paragraphs[1].special_space_origins);
        let after = assert_space_occurrences(&reopened, policy);
        assert_eq!(edited.len(), after.len());
        for (a, b) in edited.iter().zip(&after) {
            assert_eq!(a.0, b.0); assert!((a.1 - b.1).abs() < 0.01, "literal glyph advance after HWPX reopen");
        }
    }
}

#[test]
fn mixed_zero_separator_uses_compact_current_rows_after_edit_and_reopen() {
    for graph in [false, true] {
        for policy in [FontMetricsPolicy::HancomWindows, FontMetricsPolicy::HcrDeclared] {
            let mut core = DocumentCore::from_bytes_with_font_metrics(&fixture_options(graph, false, true, false, false, false), policy).unwrap();
            assert_compact_rows(&core, graph);
            core.insert_text_in_footnote_native(0, host_index(&core), 0, 1, 0, "edit ").unwrap();
            assert_compact_rows(&core, graph);
            let reopened = DocumentCore::from_bytes_with_font_metrics(&core.export_hwpx_native().unwrap(), policy).unwrap();
            assert_compact_rows(&reopened, graph);
        }
    }
}

fn assert_later_note_boundary(core: &DocumentCore, graph: bool, compact: bool) {
    let notes = note_list(core); assert_eq!(notes.len(), 2, "actual multi-note fixture");
    assert_eq!(core.document().sections[0].paragraphs.len(), 3);
    let columns = &core.document().sections[0].paragraphs[0].controls;
    assert!(columns.iter().any(|c| matches!(c, Control::ColumnDef(c) if c.column_count == 2)), "actual two-column source");
    assert_coverage_at(core, graph, false, notes[0]);
    let base = core.document().sections[0].paragraphs.len();
    let rows = rendered_rows(core, base + 1);
    let frames: std::collections::BTreeSet<_> = rows.iter().map(|(_, l)| (l.page,l.column)).collect();
    assert!(frames.len() > 1, "preceding mixed host must actually split");
    let raw = raw_control_starts(&notes[0].paragraphs[1])[if graph { 1 } else { 3 }];
    let owner = notes[0].paragraphs[1].line_segs.partition_point(|l| l.text_start <= raw).saturating_sub(1);
    assert!(rows.iter().any(|(row, _)| *row >= owner), "split contains the table owner or a later row");
    if compact && !graph {
        let owner_location = rows.iter().find(|(row, _)| *row == owner).unwrap().1;
        assert!(rows.iter().any(|(row, location)| *row != owner
            && (location.page, location.column) == (owner_location.page, owner_location.column)),
            "compact split must include a multirow fragment owning the calculus table");
    }
    let later_base = base + notes[0].paragraphs.len();
    let later = rendered_rows(core, later_base + 1);
    assert_eq!(later.len(), notes[1].paragraphs[1].line_segs.len(), "later fit retains every current row exactly once");
    let mut preceding = Vec::new();
    for np in 0..notes[0].paragraphs.len() { preceding.extend(rendered_rows(core, base + np)); }
    let (_, tail) = preceding.last().unwrap();
    let (_, first) = later.first().unwrap();
    assert!((first.page, first.column) >= (tail.page, tail.column), "later fit cannot move before mixed tail");
    if (first.page, first.column) == (tail.page, tail.column) {
        assert!(first.bbox.y >= tail.bbox.y, "later fit cannot overlap preceding row origin");
    }
    if compact { assert_compact_rows(core, graph); }
}

#[test]
fn later_note_fit_after_partial_mixed_table_preserves_two_column_placement() {
    for graph in [false, true] {
        for compact in [false, true] {
            for policy in [FontMetricsPolicy::HancomWindows, FontMetricsPolicy::HcrDeclared] {
                let mut core = DocumentCore::from_bytes_with_font_metrics(&boundary_fixture(graph, compact, policy), policy).unwrap();
                assert_later_note_boundary(&core, graph, compact);
                assert_boundary_fit(&core, compact);
                let host = host_index(&core);
                core.insert_text_in_footnote_native(0, host, 0, 1, 0, "edit ").unwrap();
                assert_later_note_boundary(&core, graph, compact);
                let reopened = DocumentCore::from_bytes_with_font_metrics(&core.export_hwpx_native().unwrap(), policy).unwrap();
                assert_later_note_boundary(&reopened, graph, compact);
            }
        }
    }
}

#[test]
fn hwpx_later_equation_rewind_exercises_exact_simulation_with_mixed_prefix() {
    for policy in [FontMetricsPolicy::HancomWindows, FontMetricsPolicy::HcrDeclared] {
        let loaded = DocumentCore::from_bytes_with_font_metrics(&fixture_options(false, true, true, false, true, true), policy).unwrap();
        let core = DocumentCore::from_bytes_with_font_metrics(&loaded.export_hwpx_native().unwrap(), policy).unwrap();
        assert!(core.document().layout_profile().hwpx_stored_layout(), "actual supported exact-simulation profile");
        let notes = note_list(&core); assert_eq!(notes.len(), 2);
        let p = &notes[1].paragraphs[1];
        assert!(p.line_segs.windows(2).any(|s| s[1].vertical_pos < s[0].vertical_pos), "actual internal rewind trigger");
        assert!(p.controls.iter().all(|c| matches!(c, Control::Equation(e) if e.common.treat_as_char)), "supported exact-simulation controls");
        assert_eq!(p.line_segs.len(), 3, "actual multiline rewind");
        assert_eq!(p.column_type, rhwp::model::paragraph::ColumnBreakType::None);
        let resolved = rhwp::renderer::style_resolver::resolve_styles(&core.document().doc_info, 96.0);
        let style = &resolved.para_styles[p.para_shape_id as usize];
        assert!(!style.page_break_before && !style.keep_with_next, "no style exclusion of exact simulation");
        assert_later_note_boundary(&core, false, true);
        let pi = core.document().sections[0].paragraphs.len() + notes[0].paragraphs.len() + 1;
        let rows = rendered_rows(&core, pi);
        assert_eq!(rows.iter().map(|(row,_)| *row).collect::<Vec<_>>(), vec![0,1,2]);
        let mut equations = Vec::new();
        for page in 0..core.page_count() {
            let tree = core.build_page_render_tree(page).unwrap();
            let mut all = Vec::new(); walk(&tree.root, page, 0, tree.root.bbox, true, &mut all);
            for v in all {
                if let RenderNodeType::Equation(e) = &v.node.node_type {
                    if e.section_index == Some(0) && e.para_index == Some(pi) && e.cell_context.is_none() {
                        assert_visible(&v); assert!(!e.svg_content.is_empty());
                        equations.push(e.control_index.unwrap());
                    }
                }
            }
        }
        equations.sort_unstable(); assert_eq!(equations, vec![0,1,2], "exact simulation retains each later source equation once");
        for pair in rows.windows(2) {
            if (pair[0].1.page,pair[0].1.column)==(pair[1].1.page,pair[1].1.column) {
                assert!(pair[1].1.bbox.y > pair[0].1.bbox.y, "exact layout stacks the rewind rows");
            }
        }
    }
}


fn column_bottom(core: &DocumentCore, location: Location) -> f64 {
    let tree = core.build_page_render_tree(location.page).unwrap();
    let mut all = Vec::new(); walk(&tree.root, location.page, 0, tree.root.bbox, true, &mut all);
    all.iter().find_map(|v| match &v.node.node_type {
        RenderNodeType::Column(_) if v.location.column == location.column => Some(v.node.bbox.y + v.node.bbox.height),
        _ => None,
    }).expect("actual column frame")
}

fn boundary_fixture(graph: bool, compact: bool, policy: FontMetricsPolicy) -> Vec<u8> {
    // Size the later owned row against the public mixed prefix, never a private predictor.
    let seed = DocumentCore::from_bytes_with_font_metrics(&fixture_options_height(graph, true, compact, false, true, false, 1125), policy).unwrap();
    let notes = note_list(&seed); assert_eq!(notes.len(), 2);
    let last_np = notes[0].paragraphs.len() - 1;
    let tail_rows = rendered_rows(&seed, seed.document().sections[0].paragraphs.len() + last_np);
    let tail = tail_rows.last().unwrap().1;
    let room_hu = rhwp::renderer::px_to_hwpunit(column_bottom(&seed, tail) - tail.bbox.y - tail.bbox.height, 96.0);
    let title_advance = if compact { 1125 - 1125 / 10 } else { 1125 + 500 };
    let later_height = room_hu - title_advance - 500;
    assert!(later_height >= 1125, "owned prefix must leave a real later-row fit boundary");
    fixture_options_height(graph, true, compact, false, true, false, later_height)
}

fn assert_boundary_fit(core: &DocumentCore, compact: bool) {
    let notes = note_list(core); assert_eq!(notes.len(), 2);
    let base = core.document().sections[0].paragraphs.len();
    let tail = rendered_rows(core, base + notes[0].paragraphs.len() - 1).last().unwrap().1;
    let later = rendered_rows(core, base + notes[0].paragraphs.len() + 1);
    assert_eq!(later.len(), 1);
    let title_advance = if compact { 1125 - 1125 / 10 } else { 1125 + 500 };
    let needed = rhwp::renderer::hwpunit_to_px(title_advance + notes[1].paragraphs[1].line_segs[0].line_height, 96.0);
    let slack = column_bottom(core, tail) - tail.bbox.y - tail.bbox.height - needed;
    assert!(slack >= -0.5 && slack <= rhwp::renderer::hwpunit_to_px(1000, 96.0), "actual later fit is near the column boundary, slack {slack}");
    assert_eq!((later[0].1.page, later[0].1.column), (tail.page, tail.column), "a later row that fits after the scoped Partial must stay in its column");
}


// V4-R1: compact flow fits a fresh frame, but the last full Table row does not.
fn last_tall_table_fixture() -> Vec<u8> {
    let mut blank = DocumentCore::new_empty();
    blank.create_blank_document_native().unwrap();
    let doc = blank.document_mut();
    let cs = &mut doc.doc_info.char_shapes[0];
    cs.raw_data = None;
    cs.base_size = 900;
    cs.ratios = [100; 7];
    cs.relative_sizes = [100; 7];
    cs.spacings = [0; 7];
    let ps = &mut doc.doc_info.para_shapes[0];
    ps.raw_data = None;
    ps.spacing_before = 0;
    ps.spacing_after = 0;
    let mut sd = doc.sections[0].section_def.clone();
    sd.page_def.width = 65912;
    sd.page_def.height = 42000;
    sd.page_def.margin_left = 1000;
    sd.page_def.margin_right = 1000;
    sd.page_def.margin_top = 1000;
    sd.page_def.margin_bottom = 1000;
    sd.page_def.margin_header = 0;
    sd.page_def.margin_footer = 0;
    sd.endnote_shape.separator_line_type = 0;
    sd.endnote_shape.separator_line_width = 0;
    sd.endnote_shape.separator_length = 0;
    sd.endnote_shape.separator_margin_top = 0;
    sd.endnote_shape.separator_margin_bottom = 0;
    sd.endnote_shape.note_spacing = 0;
    sd.endnote_shape.raw_unknown = 0;
    let mut section_raw = slot(2, tags::CTRL_SECTION_DEF).to_vec();
    section_raw.extend(slot(2, tags::CTRL_COLUMN_DEF));
    let mut section_controls = serialize(&Control::SectionDef(Box::new(sd)), 1);
    section_controls.extend(serialize(&Control::ColumnDef(ColumnDef {
        column_count: 2, same_width: true, spacing: 1000, ..Default::default()
    }), 1));
    let mut section = paragraph(&section_raw, &[line(0, 0, 1125, 31456)], &section_controls, 0);
    let mut table = Table::default();
    table.row_count = 1;
    table.col_count = 1;
    table.row_sizes = vec![1];
    table.common.attr = 1;
    table.common.treat_as_char = true;
    table.common.width = 10000;
    table.common.height = 40000;
    table.cells.push(Cell {
        row: 0, col: 0, row_span: 1, col_span: 1, width: 10000, height: 40000,
        paragraphs: vec![Paragraph {
            char_count: 9, controls: vec![eq("last_tall_cell=7".into())],
            line_segs: vec![line(0, 0, 1125, 10000)], ..Default::default()
        }], ..Default::default()
    });
    table.rebuild_grid();
    let mut note = paragraph(&"HEAD".encode_utf16().collect::<Vec<_>>(),
        &[line(0, 0, 39500, 31456)], &[], 2);
    // Own first vpos zero rewinds against the positive preceding note boundary.
    note.extend(mixed_host(36, &[4, 16, 28], 2, &[15, 27], &[0, 16, 28],
        &[2580, 1350, 40000], table, 0));
    let mut children = Vec::new();
    let mut en = tags::CTRL_ENDNOTE.to_le_bytes().to_vec();
    en.extend([1u8, 0, 0, 0]);
    en.extend([0; 8]);
    record(&mut children, tags::HWPTAG_CTRL_HEADER, 1, &en);
    let mut list = vec![0; 16];
    list[..4].copy_from_slice(&2u32.to_le_bytes());
    record(&mut children, tags::HWPTAG_LIST_HEADER, 2, &list);
    children.extend(note);
    let mut body = "BODY".encode_utf16().collect::<Vec<_>>();
    body.extend(slot(17, tags::CTRL_ENDNOTE));
    section.extend(paragraph(&body, &[line(0, 1625, 1125, 31456)], &children, 0));
    let mut header = vec![0; 256];
    header[..17].copy_from_slice(b"HWP Document File");
    header[32..36].copy_from_slice(&[0, 0, 0, 5]);
    let info = rhwp::serializer::doc_info::serialize_doc_info(&doc.doc_info, &doc.doc_properties);
    let mut cfb = cfb::CompoundFile::create_with_version(cfb::Version::V3, Cursor::new(Vec::new())).unwrap();
    cfb.create_storage_all("/BodyText").unwrap();
    for (path, bytes) in [("/FileHeader", header), ("/DocInfo", info), ("/BodyText/Section0", section)] {
        cfb.create_stream(path).unwrap().write_all(&bytes).unwrap();
    }
    cfb.into_inner().into_inner()
}

fn assert_inside_frame(node: &RenderNode, frame: BoundingBox) {
    let b = node.bbox;
    let empty_caret = matches!(&node.node_type, RenderNodeType::TextRun(run)
        if run.text.is_empty() && run.display_text.as_deref().unwrap_or("").is_empty()
            && (run.is_para_end || run.is_line_break_end) && b.width == 0.0);
    if empty_caret {
        assert!([b.x, b.y, b.width, b.height].iter().all(|v| v.is_finite()));
        assert!(b.width >= 0.0 && b.height >= 0.0, "finite nonnegative caret geometry");
    } else {
        positive(b);
    }
    assert!(b.x >= frame.x - 0.5 && b.y >= frame.y - 0.5
        && b.x + b.width <= frame.x + frame.width + 0.5
        && b.y + b.height <= frame.y + frame.height + 0.5,
        "full paint box must fit actual frame: {:?} in {:?}", b, frame);
    for child in &node.children { assert_inside_frame(child, frame); }
}

#[test]
fn compact_last_tall_table_keeps_full_row_fit_after_empty_column_entry() {
    assert!(std::env::var_os("RHWP_EN_SSOT").is_none(), "run this fixture under default SSOT B");
    for policy in [FontMetricsPolicy::HancomWindows, FontMetricsPolicy::HcrDeclared] {
        let bytes = last_tall_table_fixture();
        let core = DocumentCore::from_bytes_with_font_metrics(&bytes, policy).unwrap();
        let doc = core.document();
        assert!(!doc.layout_profile().own_line_layout());
        assert!(!doc.layout_profile().hwp3_layout(), "ordinary HWP5 profile");
        assert!(doc.layout_profile().native_hwp5_layout(), "actual native HWP5 admission profile");
        assert!(!doc.layout_profile().hwpx_stored_layout(), "ordinary HWP5 excludes measured-rewind route");
        assert_eq!(doc.sections[0].paragraphs.len(), 2, "body source s0:p1:c0");
        let n = note(&core);
        assert_eq!(n.paragraphs.len(), 2);
        let p = &n.paragraphs[1];
        assert_eq!(p.line_segs.len(), 3, "nonfirst mixed target");
        assert_eq!(p.line_segs.iter().map(|l| l.line_height).collect::<Vec<_>>(), vec![2580,1350,40000]);
        assert_eq!(p.line_segs.iter().map(|l| l.vertical_pos).collect::<Vec<_>>(), vec![0,3080,4930]);
        assert!(p.line_segs.iter().all(|l| l.line_spacing == 500), "saved positive rows must require changed compact projection");
        let mut raw_file = cfb::CompoundFile::open(Cursor::new(bytes.clone())).unwrap();
        let mut raw_stream = Vec::new();
        std::io::Read::read_to_end(&mut raw_file.open_stream("/BodyText/Section0").unwrap(), &mut raw_stream).unwrap();
        let records = rhwp::parser::record::Record::read_all(&raw_stream).unwrap();
        let raw_hosts: Vec<_> = records.iter().filter(|r| r.tag_id==tags::HWPTAG_PARA_TEXT && r.level==3).collect();
        assert_eq!(raw_hosts.len(),2);
        let table_slot: Vec<_> = slot(11,tags::CTRL_TABLE).into_iter().flat_map(u16::to_le_bytes).collect();
        assert_eq!(&raw_hosts[1].data[56..72],table_slot.as_slice(), "raw source Table address28");
        assert_eq!(p.line_segs[0].vertical_pos, 0);
        assert!(p.line_segs.windows(2).all(|s| s[1].vertical_pos > s[0].vertical_pos),
            "no internal rewind");
        assert!(n.paragraphs[0].line_segs[0].vertical_pos
            + n.paragraphs[0].line_segs[0].line_height > p.line_segs[0].vertical_pos,
            "positive prior boundary causes local rewind");
        assert_eq!(raw_control_starts(p), vec![4,16,28]);
        assert_eq!(p.controls.len(), 3);
        let Control::Table(t) = &p.controls[2] else { panic!("s0:p1:c0:note1:control2"); };
        assert_eq!(t.cells.len(), 1);
        assert_eq!(t.common.height, 40000);
        assert_eq!(t.cells[0].height, 40000);
        let shape = &doc.sections[0].section_def.endnote_shape;
        assert_eq!((shape.separator_line_type, shape.separator_line_width, shape.separator_length), (0,0,0));
        assert_eq!((shape.separator_margin_top, shape.separator_margin_bottom, shape.note_spacing, shape.raw_unknown), (0,0,0,0));
        assert_eq!(p.column_type, rhwp::model::paragraph::ColumnBreakType::None);
        let columns = doc.sections[0].paragraphs[0].controls.iter().find_map(|c| match c {
            Control::ColumnDef(c) => Some(c), _ => None,
        }).unwrap();
        assert!(columns.same_width && columns.column_count == 2);
        let resolved = rhwp::renderer::style_resolver::resolve_styles(&doc.doc_info, 96.0);
        let style = &resolved.para_styles[p.para_shape_id as usize];
        assert!(!style.page_break_before && !style.keep_with_next);
        assert!(style.spacing_before.abs() < 1e-6 && style.spacing_after.abs() < 1e-6);
        let pi = doc.sections[0].paragraphs.len() + 1;
        let rows = rendered_rows(&core, pi);
        assert_eq!(rows.iter().map(|(r,_)| *r).collect::<Vec<_>>(), vec![0,1,2]);
        let head = rendered_rows(&core, doc.sections[0].paragraphs.len());
        assert_eq!(head.len(), 1);
        let first = rows[0].1;
        let second = rows[1].1;
        let last = rows[2].1;
        assert!((first.page,first.column) > (head[0].1.page,head[0].1.column),
            "local rewind must actually enter a new empty column");
        assert_eq!((first.page,first.column), (second.page,second.column));
        assert!((last.page,last.column) > (second.page,second.column), "Table row moves to a later column");
        let dump = core.dump_page_items(None);
        let parts: Vec<_> = dump.lines().filter(|l| l.contains(&format!("  pi={}  ", pi))).collect();
        assert_eq!(parts.len(), 2, "actual target page items exactly two");
        assert!(parts.iter().any(|l| l.contains("PartialParagraph") && l.contains("lines=0..2")));
        assert!(parts.iter().any(|l| l.contains("PartialParagraph") && l.contains("lines=2..3")));
        let mut tables = Vec::new();
        let mut cell_equations = Vec::new();
        let mut source_equations = Vec::new();
        let mut source_frames = Vec::new();
        for page in 0..core.page_count() {
            let tree = core.build_page_render_tree(page).unwrap();
            let mut all = Vec::new(); walk(&tree.root, page, 0, tree.root.bbox, true, &mut all);
            for v in &all {
                if let RenderNodeType::Column(_) = &v.node.node_type {
                    source_frames.push((page, v.location.column, v.node.bbox));
                }
            }
            for v in &all {
                let frame = source_frames.iter().find(|(pg,col,_)| (*pg,*col)==(page,v.location.column)).unwrap().2;
                match &v.node.node_type {
                    RenderNodeType::TextLine(l) if l.section_index==Some(0) && l.para_index==Some(pi) => {
                        assert_inside_frame(v.node, frame);
                    }
                    RenderNodeType::Table(t) => {
                        assert_eq!((t.section_index,t.para_index,t.control_index), (Some(0),Some(pi),Some(2)),
                            "all-page inventory has only the owned Table");
                        assert_inside_frame(v.node, frame);
                        tables.push(v.location);
                    }
                    RenderNodeType::Equation(e) if e.para_index==Some(pi) => {
                        assert_visible(v);
                        if let Some(ctx)=&e.cell_context {
                            assert_eq!(e.section_index,Some(0));
                            assert_eq!(e.control_index,Some(2));
                            assert_eq!(e.inner_control_index,Some(0));
                            assert_eq!(ctx.parent_para_index,pi);
                            assert_eq!(ctx.path.len(),1);
                            assert_eq!((ctx.path[0].control_index,ctx.path[0].cell_index,ctx.path[0].cell_para_index),(2,0,0));
                            assert!(!e.svg_content.is_empty());
                            cell_equations.push(v.location);
                        } else { source_equations.push(e.control_index.unwrap()); }
                    }
                    _ => {}
                }
            }
        }
        assert_eq!(tables.len(),1, "Table emitted once across all pages");
        assert_eq!(cell_equations.len(),1, "exact nested cell Equation emitted once");
        source_equations.sort_unstable();
        assert_eq!(source_equations,vec![0,1], "exact top-level Equation inventory");
        let table = tables[0];
        assert_eq!((table.page,table.column),(last.page,last.column));
        assert!((table.bbox.y-last.bbox.y).abs()<0.5, "no second owner advance");
        assert!((table.bbox.height-rhwp::renderer::hwpunit_to_px(t.common.height as i32,96.0)).abs()<0.5,
            "full Table box is never shrunk to frame");
        let frame = source_frames.iter().find(|(pg,col,_)| (*pg,*col)==(first.page,first.column)).unwrap().2;
        let last_frame = source_frames.iter().find(|(pg,col,_)| (*pg,*col)==(last.page,last.column)).unwrap().2;
        assert!((frame.height-rhwp::renderer::hwpunit_to_px(40000,96.0)).abs()<0.5);
        assert!((last_frame.height-frame.height).abs()<0.5 && (last_frame.width-frame.width).abs()<0.5,
            "actual uniform destination geometry");
        assert!((first.bbox.y-frame.y).abs()<0.5 && (last.bbox.y-last_frame.y).abs()<0.5,
            "head and Table fragments start at empty frame tops");
        assert!(head[0].1.bbox.y+rhwp::renderer::hwpunit_to_px(39500-3950,96.0)
            > column_bottom(&core,head[0].1)-frame.height*0.15, "prior column exceeds local-rewind threshold");
        let advances: Vec<_> = p.line_segs.iter().map(|l| l.line_height-l.line_height/10).collect();
        let total = rhwp::renderer::hwpunit_to_px(advances.iter().sum(),96.0);
        let bottom = rhwp::renderer::hwpunit_to_px(advances[0]+advances[1]+p.line_segs[2].line_height,96.0);
        assert!(total<=frame.height && bottom>frame.height+24.0,
            "public source and actual frame exhibit compact-fit/full-overflow counterexample");
        assert!(rhwp::renderer::hwpunit_to_px(p.line_segs[2].line_height,96.0)<=last_frame.height+0.5,
            "last row alone fits next frame");
        assert!((second.bbox.y-first.bbox.y-rhwp::renderer::hwpunit_to_px(advances[0],96.0)).abs()<0.5,
            "real same-fragment negative spacing retained");
        assert!((last.bbox.height-rhwp::renderer::hwpunit_to_px(p.line_segs[2].line_height,96.0)).abs()<0.5,
            "full owning row retained");
        let saved_span = p.line_segs[2].vertical_pos-p.line_segs[0].vertical_pos+p.line_segs[2].line_height;
        assert!(rhwp::renderer::hwpunit_to_px(saved_span,96.0)>frame.height+25.0,
            "saved-span legacy bypass cannot turn this into a different case");
    }
}


// V5-R1: public BODY-wide top reservation, no private admission flags.
fn reserved_tall_table_fixture() -> Vec<u8> {
    let mut blank = DocumentCore::new_empty();
    blank.create_blank_document_native().unwrap();
    let doc = blank.document_mut();
    let cs = &mut doc.doc_info.char_shapes[0];
    cs.raw_data = None;
    cs.base_size = 900;
    cs.ratios = [100; 7];
    cs.relative_sizes = [100; 7];
    cs.spacings = [0; 7];
    let ps = &mut doc.doc_info.para_shapes[0];
    ps.raw_data = None;
    ps.spacing_before = 0;
    ps.spacing_after = 0;
    let mut sd = doc.sections[0].section_def.clone();
    sd.page_def.width = 65912;
    sd.page_def.height = 42000;
    sd.page_def.margin_left = 1000;
    sd.page_def.margin_right = 1000;
    sd.page_def.margin_top = 1000;
    sd.page_def.margin_bottom = 1000;
    sd.page_def.margin_header = 0;
    sd.page_def.margin_footer = 0;
    sd.endnote_shape.separator_line_type = 0;
    sd.endnote_shape.separator_line_width = 0;
    sd.endnote_shape.separator_length = 0;
    sd.endnote_shape.separator_margin_top = 0;
    sd.endnote_shape.separator_margin_bottom = 0;
    sd.endnote_shape.note_spacing = 0;
    sd.endnote_shape.raw_unknown = 0;
    let mut section_raw = slot(2, tags::CTRL_SECTION_DEF).to_vec();
    section_raw.extend(slot(2, tags::CTRL_COLUMN_DEF));
    let mut section_controls = serialize(&Control::SectionDef(Box::new(sd)), 1);
    section_controls.extend(serialize(&Control::ColumnDef(ColumnDef {
        column_count: 2, same_width: true, spacing: 1000, ..Default::default()
    }), 1));
    let mut section = paragraph(&section_raw, &[line(0, 0, 1125, 31456)], &section_controls, 0);
    let mut table = Table::default();
    table.row_count = 1;
    table.col_count = 1;
    table.row_sizes = vec![1];
    table.common.attr = 1;
    table.common.treat_as_char = true;
    table.common.width = 10000;
    table.common.height = 40000;
    table.cells.push(Cell {
        row: 0, col: 0, row_span: 1, col_span: 1, width: 10000, height: 40000,
        paragraphs: vec![Paragraph {
            char_count: 9, controls: vec![eq("last_tall_cell=7".into())],
            line_segs: vec![line(0, 0, 1125, 10000)], ..Default::default()
        }], ..Default::default()
    });
    table.rebuild_grid();
    let mut note = paragraph(&"HEAD".encode_utf16().collect::<Vec<_>>(),
        &[line(0, 0, 1125, 31456)], &[], 2);
    // Positive nonrewinding start avoids the local/internal rewind routes.
    note.extend(mixed_host(36, &[4, 16, 28], 2, &[15, 27], &[0, 16, 28],
        &[2580, 1350, 40000], table, 1625));
    let mut children = Vec::new();
    let mut en = tags::CTRL_ENDNOTE.to_le_bytes().to_vec();
    en.extend([1u8, 0, 0, 0]);
    en.extend([0; 8]);
    record(&mut children, tags::HWPTAG_CTRL_HEADER, 1, &en);
    let mut list = vec![0; 16];
    list[..4].copy_from_slice(&2u32.to_le_bytes());
    record(&mut children, tags::HWPTAG_LIST_HEADER, 2, &list);
    children.extend(note);
    // A real raw BODY Table reserves the top 10000HU across both columns.
    let mut wide = Table::default();
    wide.row_count = 1; wide.col_count = 1; wide.row_sizes = vec![1];
    wide.common.attr = (1 << 21) | (1 << 3) | (1 << 8);
    wide.common.treat_as_char = false;
    wide.common.text_wrap = rhwp::model::shape::TextWrap::TopAndBottom;
    wide.common.vert_rel_to = rhwp::model::shape::VertRelTo::Page;
    wide.common.horz_rel_to = rhwp::model::shape::HorzRelTo::Page;
    wide.common.width = 63912; wide.common.height = 10000;
    wide.cells.push(Cell { row: 0, col: 0, row_span: 1, col_span: 1,
        width: 63912, height: 10000,
        paragraphs: vec![Paragraph { text: "WIDE".into(), char_count: 5,
            line_segs: vec![line(0, 0, 1125, 63912)], ..Default::default() }],
        ..Default::default() });
    wide.rebuild_grid();
    section.extend(paragraph(&slot(11, tags::CTRL_TABLE), &[line(0, 1625, 1125, 31456)],
        &serialize(&Control::Table(Box::new(wide)), 1), 0));
    let mut body = "BODY".encode_utf16().collect::<Vec<_>>();
    body.extend(slot(17, tags::CTRL_ENDNOTE));
    section.extend(paragraph(&body, &[line(0, 11625, 1125, 31456)], &children, 0));
    let mut header = vec![0; 256];
    header[..17].copy_from_slice(b"HWP Document File");
    header[32..36].copy_from_slice(&[0, 0, 0, 5]);
    let info = rhwp::serializer::doc_info::serialize_doc_info(&doc.doc_info, &doc.doc_properties);
    let mut cfb = cfb::CompoundFile::create_with_version(cfb::Version::V3, Cursor::new(Vec::new())).unwrap();
    cfb.create_storage_all("/BodyText").unwrap();
    for (path, bytes) in [("/FileHeader", header), ("/DocInfo", info), ("/BodyText/Section0", section)] {
        cfb.create_stream(path).unwrap().write_all(&bytes).unwrap();
    }
    cfb.into_inner().into_inner()
}

fn assert_full_clip(v: &Visible<'_>) {
    assert_visible(v);
    let ink = intersection(v.node.bbox,v.clip);
    assert!((ink.width-v.node.bbox.width).abs()<0.5 && (ink.height-v.node.bbox.height).abs()<0.5,
        "complete paint box survives effective ancestor clip");
}

#[test]
fn compact_table_tail_skips_body_wide_reserved_column_for_fresh_page() {
    assert!(std::env::var_os("RHWP_EN_SSOT").is_none(), "run this fixture under default SSOT B");
    for policy in [FontMetricsPolicy::HancomWindows, FontMetricsPolicy::HcrDeclared] {
        let bytes = reserved_tall_table_fixture();
        let core = DocumentCore::from_bytes_with_font_metrics(&bytes, policy).unwrap();
        let doc = core.document();
        assert!(!doc.layout_profile().own_line_layout());
        assert!(!doc.layout_profile().hwp3_layout(), "ordinary HWP5 profile");
        assert!(doc.layout_profile().native_hwp5_layout(), "actual native HWP5 admission profile");
        assert!(!doc.layout_profile().hwpx_stored_layout(), "ordinary HWP5 excludes measured-rewind route");
        assert_eq!(doc.sections[0].paragraphs.len(), 3, "body source s0:p2:c0");
        let n = note(&core);
        assert_eq!(n.paragraphs.len(), 2);
        let p = &n.paragraphs[1];
        assert_eq!(p.line_segs.len(), 3, "nonfirst mixed target");
        assert_eq!(p.line_segs.iter().map(|l| l.line_height).collect::<Vec<_>>(), vec![2580,1350,40000]);
        assert_eq!(p.line_segs.iter().map(|l| l.vertical_pos).collect::<Vec<_>>(), vec![1625,4705,6555]);
        assert!(p.line_segs.iter().all(|l| l.line_spacing == 500), "saved positive rows must require changed compact projection");
        let mut raw_file = cfb::CompoundFile::open(Cursor::new(bytes.clone())).unwrap();
        let mut raw_stream = Vec::new();
        std::io::Read::read_to_end(&mut raw_file.open_stream("/BodyText/Section0").unwrap(), &mut raw_stream).unwrap();
        let records = rhwp::parser::record::Record::read_all(&raw_stream).unwrap();
        let table_slot: Vec<_> = slot(11,tags::CTRL_TABLE).into_iter().flat_map(u16::to_le_bytes).collect();
        let raw_hosts: Vec<_> = records.iter().filter(|r| r.tag_id==tags::HWPTAG_PARA_TEXT
            && r.level==3 && r.data.len()>=72 && r.data[56..72]==table_slot).collect();
        assert_eq!(raw_hosts.len(),1,"exact raw mixed host, excluding BODY Table cell paragraph");
        assert_eq!(&raw_hosts[0].data[56..72],table_slot.as_slice(), "raw source Table address28");
        let raw_wide: Vec<_> = records.iter().filter(|r| r.tag_id==tags::HWPTAG_CTRL_HEADER
            && r.level==1 && r.data.starts_with(&tags::CTRL_TABLE.to_le_bytes())).collect();
        assert_eq!(raw_wide.len(),1,"one real BODY Table control at raw level1");
        assert_eq!(u32::from_le_bytes(raw_wide[0].data[4..8].try_into().unwrap()),(1<<21)|(1<<3)|(1<<8));
        assert_eq!(u32::from_le_bytes(raw_wide[0].data[16..20].try_into().unwrap()),63912);
        assert_eq!(u32::from_le_bytes(raw_wide[0].data[20..24].try_into().unwrap()),10000);
        assert_eq!(p.line_segs[0].vertical_pos, 1625);
        assert!(p.line_segs.windows(2).all(|s| s[1].vertical_pos > s[0].vertical_pos),
            "no internal rewind");
        assert!(n.paragraphs[0].line_segs[0].vertical_pos
            + n.paragraphs[0].line_segs[0].line_height + n.paragraphs[0].line_segs[0].line_spacing <= p.line_segs[0].vertical_pos,
            "positive current note start has no local rewind");
        assert_eq!(raw_control_starts(p), vec![4,16,28]);
        assert_eq!(p.controls.len(), 3);
        let Control::Table(t) = &p.controls[2] else { panic!("s0:p2:c0:note1:control2"); };
        assert_eq!(t.cells.len(), 1);
        assert_eq!(t.common.height, 40000);
        assert_eq!(t.cells[0].height, 40000);
        let shape = &doc.sections[0].section_def.endnote_shape;
        assert_eq!((shape.separator_line_type, shape.separator_line_width, shape.separator_length), (0,0,0));
        assert_eq!((shape.separator_margin_top, shape.separator_margin_bottom, shape.note_spacing, shape.raw_unknown), (0,0,0,0));
        assert_eq!(p.column_type, rhwp::model::paragraph::ColumnBreakType::None);
        let columns = doc.sections[0].paragraphs[0].controls.iter().find_map(|c| match c {
            Control::ColumnDef(c) => Some(c), _ => None,
        }).unwrap();
        assert!(columns.same_width && columns.column_count == 2);
        let resolved = rhwp::renderer::style_resolver::resolve_styles(&doc.doc_info, 96.0);
        let style = &resolved.para_styles[p.para_shape_id as usize];
        assert!(!style.page_break_before && !style.keep_with_next);
        assert!(style.spacing_before.abs() < 1e-6 && style.spacing_after.abs() < 1e-6);
        let pi = doc.sections[0].paragraphs.len() + 1;
        let rows = rendered_rows(&core, pi);
        assert_eq!(rows.iter().map(|(r,_)| *r).collect::<Vec<_>>(), vec![0,1,2]);
        let head = rendered_rows(&core, doc.sections[0].paragraphs.len());
        assert_eq!(head.len(), 1);
        let first = rows[0].1;
        let second = rows[1].1;
        let last = rows[2].1;
        assert_eq!((first.page,first.column), (head[0].1.page,head[0].1.column),
            "nonrewinding mixed head stays with prior note in BODY column0");
        assert_eq!(first.column, 0);
        assert_eq!((last.page,last.column), (first.page+1,0),
            "tail skips reserved column1 and fits fresh next page");
        let Control::Table(wide) = &doc.sections[0].paragraphs[1].controls[0] else { panic!("owned BODY Table"); };
        assert!(!wide.common.treat_as_char);
        assert_eq!(wide.common.text_wrap, rhwp::model::shape::TextWrap::TopAndBottom);
        assert_eq!(wide.common.vert_rel_to, rhwp::model::shape::VertRelTo::Page);
        assert_eq!((wide.common.width,wide.common.height,wide.common.vertical_offset),(63912,10000,0));
        assert_eq!((first.page,first.column), (second.page,second.column));
        assert!((last.page,last.column) > (second.page,second.column), "Table row moves to a later column");
        let dump = core.dump_page_items(None);
        let parts: Vec<_> = dump.lines().filter(|l| l.contains(&format!("  pi={}  ", pi))).collect();
        assert_eq!(parts.len(), 2, "actual target page items exactly two");
        assert!(parts.iter().any(|l| l.contains("PartialParagraph") && l.contains("lines=0..2")));
        assert!(parts.iter().any(|l| l.contains("PartialParagraph") && l.contains("lines=2..3")));
        let mut tables = Vec::new();
        let mut body_tables = Vec::new();
        let mut cell_equations = Vec::new();
        let mut source_equations = Vec::new();
        let mut source_frames = Vec::new();
        for page in 0..core.page_count() {
            let tree = core.build_page_render_tree(page).unwrap();
            let mut all = Vec::new(); walk(&tree.root, page, 0, tree.root.bbox, true, &mut all);
            for v in &all {
                if let RenderNodeType::Column(_) = &v.node.node_type {
                    source_frames.push((page, v.location.column, v.node.bbox));
                }
            }
            for v in &all {
                let frame = source_frames.iter().find(|(pg,col,_)| (*pg,*col)==(page,v.location.column)).unwrap().2;
                if let RenderNodeType::TextLine(l) = &v.node.node_type {
                    if l.para_index==Some(pi) { assert_full_clip(v); }
                }
                if let RenderNodeType::TableCell(_) = &v.node.node_type {
                    assert_full_clip(v);
                    let ink = intersection(v.node.bbox,v.clip);
                    assert!((ink.width-v.node.bbox.width).abs()<0.5 && (ink.height-v.node.bbox.height).abs()<0.5);
                }
                match &v.node.node_type {
                    RenderNodeType::TextLine(l) if l.section_index==Some(0) && l.para_index==Some(pi) => {
                        assert_inside_frame(v.node, frame);
                    }
                    RenderNodeType::Table(t) if t.para_index==Some(1) => {
                        assert_eq!((t.section_index,t.control_index),(Some(0),Some(0)));
                        assert_full_clip(v);
                        body_tables.push(v.location);
                    }
                    RenderNodeType::Table(t) => {
                        assert_full_clip(v);
                        assert_eq!((t.section_index,t.para_index,t.control_index), (Some(0),Some(pi),Some(2)),
                            "all-page remaining inventory has only the owned note Table");
                        assert_inside_frame(v.node, frame);
                        tables.push(v.location);
                    }
                    RenderNodeType::Equation(e) if e.para_index==Some(pi) => {
                        assert_full_clip(v);
                        assert!(!e.svg_content.is_empty(),"every owned Equation has actual SVG output");
                        if let Some(ctx)=&e.cell_context {
                            assert_eq!(e.section_index,Some(0));
                            assert_eq!(e.control_index,Some(2));
                            assert_eq!(e.inner_control_index,Some(0));
                            assert_eq!(ctx.parent_para_index,pi);
                            assert_eq!(ctx.path.len(),1);
                            assert_eq!((ctx.path[0].control_index,ctx.path[0].cell_index,ctx.path[0].cell_para_index),(2,0,0));
                            assert!(!e.svg_content.is_empty());
                            cell_equations.push(v.location);
                        } else { source_equations.push(e.control_index.unwrap()); }
                    }
                    RenderNodeType::Equation(_) => panic!("unexpected equation outside owned note identity"),
                    _ => {}
                }
            }
        }
        assert_eq!(body_tables.len(),1,"real body-wide reservation object emitted once");
        let wide_box=body_tables[0];
        assert_eq!((wide_box.page,wide_box.column),(first.page,0));
        assert!((wide_box.bbox.height-rhwp::renderer::hwpunit_to_px(10000,96.0)).abs()<0.5);
        assert_eq!(tables.len(),1, "Table emitted once across all pages");
        assert_eq!(cell_equations.len(),1, "exact nested cell Equation emitted once");
        source_equations.sort_unstable();
        assert_eq!(source_equations,vec![0,1], "exact top-level Equation inventory");
        let table = tables[0];
        assert_eq!((table.page,table.column),(last.page,last.column));
        assert!((table.bbox.y-last.bbox.y).abs()<0.5, "no second owner advance");
        assert!((table.bbox.height-rhwp::renderer::hwpunit_to_px(t.common.height as i32,96.0)).abs()<0.5,
            "full Table box is never shrunk to frame");
        let frame = source_frames.iter().find(|(pg,col,_)| (*pg,*col)==(first.page,first.column)).unwrap().2;
        let last_frame = source_frames.iter().find(|(pg,col,_)| (*pg,*col)==(last.page,last.column)).unwrap().2;
        assert!((frame.height-rhwp::renderer::hwpunit_to_px(40000,96.0)).abs()<0.5);
        assert!((last_frame.height-frame.height).abs()<0.5 && (last_frame.width-frame.width).abs()<0.5,
            "actual uniform destination geometry");
        let reserve=rhwp::renderer::hwpunit_to_px(10000,96.0);
        assert!((wide_box.bbox.y-frame.y).abs()<0.5);
        assert!(wide_box.bbox.width>=frame.width*1.8,"actual BODY-wide render geometry");
        assert!(first.bbox.y>=frame.y+reserve && first.bbox.y<frame.y+frame.height*0.5,
            "head actually starts after BODY reservation in occupied column0");
        assert!((last.bbox.y-last_frame.y).abs()<0.5,"fresh-page full tail starts at frame top");
        assert!(table.bbox.height>frame.height-reserve+1.0 && table.bbox.height<=last_frame.height+0.5,
            "full Table cannot fit reserved column1 but fits fresh page");
        let first_page_tree=core.build_page_render_tree(first.page).unwrap();
        let mut first_page_nodes=Vec::new();
        walk(&first_page_tree.root,first.page,0,first_page_tree.root.bbox,true,&mut first_page_nodes);
        for v in &first_page_nodes {
            match &v.node.node_type {
                RenderNodeType::TextLine(l) if l.para_index==Some(pi) => assert_eq!(v.location.column,0),
                RenderNodeType::Table(t) if t.para_index==Some(pi) => panic!("tail must skip reserved page"),
                _ => {}
            }
        }
        let ink=intersection(table.bbox,source_frames.iter().find(|(pg,col,_)| (*pg,*col)==(table.page,table.column)).unwrap().2);
        assert!((ink.width-table.bbox.width).abs()<0.5 && (ink.height-table.bbox.height).abs()<0.5);
        let advances: Vec<_> = p.line_segs.iter().map(|l| l.line_height-l.line_height/10).collect();
        let total = rhwp::renderer::hwpunit_to_px(advances.iter().sum(),96.0);
        let bottom = rhwp::renderer::hwpunit_to_px(advances[0]+advances[1]+p.line_segs[2].line_height,96.0);
        assert!(total<=frame.height && bottom>frame.height+24.0,
            "public source and actual frame exhibit compact-fit/full-overflow counterexample");
        assert!(rhwp::renderer::hwpunit_to_px(p.line_segs[2].line_height,96.0)<=last_frame.height+0.5,
            "last row alone fits next frame");
        assert!((second.bbox.y-first.bbox.y-rhwp::renderer::hwpunit_to_px(advances[0],96.0)).abs()<0.5,
            "real same-fragment negative spacing retained");
        assert!((last.bbox.height-rhwp::renderer::hwpunit_to_px(p.line_segs[2].line_height,96.0)).abs()<0.5,
            "full owning row retained");
        let saved_span = p.line_segs[2].vertical_pos-p.line_segs[0].vertical_pos+p.line_segs[2].line_height;
        assert!(rhwp::renderer::hwpunit_to_px(saved_span,96.0)>frame.height+25.0,
            "saved-span legacy bypass cannot turn this into a different case");
    }
}

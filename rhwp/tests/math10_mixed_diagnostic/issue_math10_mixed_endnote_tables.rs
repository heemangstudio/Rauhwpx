//! PREPARED ONLY. Not compiled or executed. No production registration.
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
    let mut header = vec![0; 22];
    header[..4].copy_from_slice(&(raw.len() as u32 + 1).to_le_bytes());
    header[12..14].copy_from_slice(&1u16.to_le_bytes());
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
    record(&mut out, tags::HWPTAG_PARA_CHAR_SHAPE, level + 1, &[0; 8]);
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
    let mut raw = vec!['a' as u16; raw_len];
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
    paragraph(&raw, &lines, &controls, 2)
}

fn fixture(graph: bool) -> Vec<u8> {
    fixture_with_columns(graph, false)
}

fn fixture_with_columns(graph: bool, split: bool) -> Vec<u8> {
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
    let head_height = if split { 12000 } else { 1125 };
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
        note.extend(mixed_host(
            127,
            &[4, 16, 31, 65, 74, 90, 106, 119],
            3,
            &[15, 64, 73, 105],
            &[0, 16, 65, 74, 106],
            &[2580, 1350, 8574, 2580, 2580],
            variation(0),
            target_y,
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
    let note = note(core);
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
        if require_authored_row {
            assert_eq!(owners.len(), 1, "authored table row must survive once");
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
                let comp = rhwp::renderer::composer::compose_paragraph_with_policy(p, policy);
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

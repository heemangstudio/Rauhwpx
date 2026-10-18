//! PREPARED ONLY. Not compiled or executed. No production registration.
//! Owned raw CFB fixtures mirror selected slot/row/size geometry, not exam text/images.
//! Proposed future standalone integration target in an isolated authorized checkout.
use std::io::{Cursor, Write};

use rhwp::document_core::DocumentCore;
use rhwp::model::bin_data::{BinData, BinDataCompression, BinDataType};
use rhwp::model::control::{Control, Equation};
use rhwp::model::image::Picture;
use rhwp::model::paragraph::{LineSeg, Paragraph};
use rhwp::model::provenance::FontMetricsPolicy;
use rhwp::model::table::{Cell, Table, TablePageBreak};
use rhwp::model::Padding;
use rhwp::parser::tags;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

const RED: &[u8] = include_bytes!("owned-red.png");
const BLUE: &[u8] = include_bytes!("owned-blue.png");

fn record(out: &mut Vec<u8>, tag: u16, level: u16, data: &[u8]) {
    out.extend(rhwp::serializer::record_writer::write_record(tag, level, data));
}

fn slot(code: u16, id: u32) -> [u16; 8] {
    let b = id.to_le_bytes();
    [code, u16::from_le_bytes([b[0], b[1]]), u16::from_le_bytes([b[2], b[3]]), 0, 0, 0, 0, code]
}

fn line(start: u32, y: i32, h: i32, width: i32) -> LineSeg {
    LineSeg { text_start: start, vertical_pos: y, line_height: h, text_height: h,
        baseline_distance: h * 85 / 100, line_spacing: 500, segment_width: width,
        tag: LineSeg::TAG_SINGLE_SEGMENT_LINE, ..Default::default() }
}

fn paragraph(raw: &[u16], lines: &[LineSeg], children: &[u8], level: u16) -> Vec<u8> {
    let mut header = vec![0; 22];
    header[..4].copy_from_slice(&(raw.len() as u32 + 1).to_le_bytes());
    header[12..14].copy_from_slice(&1u16.to_le_bytes());
    header[16..18].copy_from_slice(&(lines.len() as u16).to_le_bytes());
    let mut out=Vec::new();
    record(&mut out, tags::HWPTAG_PARA_HEADER, level, &header);
    let bytes: Vec<u8> = raw.iter().copied().chain([13]).flat_map(u16::to_le_bytes).collect();
    record(&mut out, tags::HWPTAG_PARA_TEXT, level+1, &bytes);
    record(&mut out, tags::HWPTAG_PARA_CHAR_SHAPE, level+1, &[0;8]);
    let mut rows=Vec::new();
    for l in lines {
        for v in [l.text_start as i32,l.vertical_pos,l.line_height,l.text_height,
            l.baseline_distance,l.line_spacing,l.column_start,l.segment_width,l.tag as i32] {
            rows.extend(v.to_le_bytes());
        }
    }
    record(&mut out, tags::HWPTAG_PARA_LINE_SEG, level+1, &rows);
    out.extend(children);
    out
}

fn serialize(control: &Control, level: u16) -> Vec<u8> {
    let mut records=Vec::new();
    rhwp::serializer::control::serialize_control(control,level,None,&mut records);
    rhwp::serializer::record_writer::write_records(&records)
}

fn eq(script: String) -> Control {
    let mut e=Equation::default();
    e.script=script;
    e.font_size=900;
    e.baseline=80;
    e.font_name="HYhwpEQ".into();
    e.version_info="Equation Version 60".into();
    e.common.attr=1;
    e.common.treat_as_char=true;
    e.common.width=2200;
    e.common.height=1125;
    Control::Equation(Box::new(e))
}

fn variation(which: usize) -> Table {
    let widths=if which==0 { [3943,2528,7339,2528,3943] } else { [3943,3519,2670,7198,2670] };
    let heights=[3146,1716,3146];
    let mut t=Table::default();
    t.row_count=3; t.col_count=5; t.row_sizes=vec![5;3];
    t.page_break=TablePageBreak::RowBreak;
    t.common.attr=0x082a2311; t.common.treat_as_char=true;
    t.common.width=widths.iter().sum(); t.common.height=8008;
    t.common.margin=Padding { left:283,right:283,top:283,bottom:283 };
    t.outer_margin_left=283;t.outer_margin_right=283;t.outer_margin_top=283;t.outer_margin_bottom=283;
    for row in 0..3 {
        for col in 0..5 {
            t.cells.push(Cell { row:row as u16,col:col as u16,row_span:1,col_span:1,
                width:widths[col],height:heights[row],paragraphs:vec![Paragraph {
                    char_count:9, controls:vec![eq(format!("v_{{{}{}}}={}",which,row,col))],
                    line_segs:vec![line(0,0,1125,widths[col] as i32)],..Default::default()
                }],..Default::default() });
        }
    }
    t.rebuild_grid();
    t
}

fn graphs() -> Table {
    let mut t=Table::default();
    t.row_count=1;t.col_count=2;t.row_sizes=vec![2];
    t.common.attr=0x082a2211;t.common.treat_as_char=true;
    t.common.width=28916;t.common.height=14220;
    for (col,(width,height)) in [(14456,13940),(14460,12020)].into_iter().enumerate() {
        let mut pic=Picture::default();
        pic.common.attr=1;pic.common.treat_as_char=true;
        pic.common.width=13432;pic.common.height=height;
        pic.shape_attr.current_width=13432;pic.shape_attr.current_height=height;
        pic.shape_attr.original_width=13432;pic.shape_attr.original_height=height;
        pic.image_attr.bin_data_id=(col+1) as u16;
        t.cells.push(Cell { row:0,col:col as u16,row_span:1,col_span:1,width,height:14220,
            paragraphs:vec![Paragraph { char_count:9,controls:vec![Control::Picture(Box::new(pic))],
                line_segs:vec![line(0,0,height as i32,13432)],..Default::default() }],
            ..Default::default() });
    }
    t.rebuild_grid();
    t
}

// Raw marker positions are explicitly asserted before CFB ingestion.
fn mixed_host(raw_len: usize, markers: &[usize], table_ci: usize, breaks: &[usize],
    starts: &[u32], heights: &[i32], table: Table, y: i32) -> Vec<u8> {
    let mut raw=vec!['a' as u16;raw_len];
    for b in breaks { raw[*b]=10; }
    let mut controls=Vec::new();
    for (ci,pos) in markers.iter().copied().enumerate() {
        let id=if ci==table_ci { tags::CTRL_TABLE } else { tags::CTRL_EQUATION };
        raw[pos..pos+8].copy_from_slice(&slot(11,id));
        if ci==table_ci { controls.extend(serialize(&Control::Table(Box::new(table.clone())),3)); }
        else { controls.extend(serialize(&eq(format!("d_{}=1",ci)),3)); }
        assert_eq!(raw[pos],11);
        assert_eq!(u32::from_le_bytes([raw[pos+1] as u8,(raw[pos+1]>>8) as u8,
            raw[pos+2] as u8,(raw[pos+2]>>8) as u8]),id);
    }
    for b in breaks { assert_eq!(raw[*b],10,"raw newline must not overlap a slot"); }
    let mut cursor=y;
    let lines: Vec<_>=starts.iter().zip(heights).map(|(s,h)| {
        let l=line(*s,cursor,*h,31456);cursor+=*h+500;l
    }).collect();
    paragraph(&raw,&lines,&controls,2)
}

fn fixture(graph: bool) -> Vec<u8> {
    let mut blank=DocumentCore::new_empty();blank.create_blank_document_native().unwrap();
    let doc=blank.document_mut();
    let cs=&mut doc.doc_info.char_shapes[0];cs.raw_data=None;cs.base_size=900;
    cs.ratios=[100;7];cs.relative_sizes=[100;7];cs.spacings=[0;7];
    let ps=&mut doc.doc_info.para_shapes[0];ps.raw_data=None;ps.spacing_before=0;ps.spacing_after=0;
    for id in 1..=2 {
        doc.doc_info.bin_data_list.push(BinData { attr:0x21,data_type:BinDataType::Embedding,
            compression:BinDataCompression::NoCompress,storage_id:id,extension:Some("png".into()),..Default::default() });
    }
    let mut sd=doc.sections[0].section_def.clone();
    sd.page_def.width=33456;sd.page_def.height=110000;
    sd.page_def.margin_left=1000;sd.page_def.margin_right=1000;
    sd.page_def.margin_top=1000;sd.page_def.margin_bottom=1000;
    sd.page_def.margin_header=0;sd.page_def.margin_footer=0;
    // Visible separator avoids treating whole-note spacing certification as this test's target.
    sd.endnote_shape.separator_line_type=1;sd.endnote_shape.separator_line_width=1;
    sd.endnote_shape.separator_length=4000;
    let mut section=paragraph(&slot(2,tags::CTRL_SECTION_DEF),&[line(0,0,1125,31456)],
        &serialize(&Control::SectionDef(Box::new(sd)),1),0);
    let mut note=paragraph(&"HEAD".encode_utf16().collect::<Vec<_>>(),&[line(0,0,1125,31456)],&[],2);
    if graph {
        note.extend(mixed_host(37,&[3,29],1,&[],&[0,26],&[1125,14220],graphs(),1625));
    } else {
        note.extend(mixed_host(127,&[4,16,31,65,74,90,106,119],3,&[15,64,73,105],
            &[0,16,65,74,106],&[2580,1350,8574,2580,2580],variation(0),1625));
        note.extend(mixed_host(172,&[4,16,28,37,46,59,68,82,91,106,140,149,161],10,
            &[15,27,36,45,58,67,90,139,148],&[0,16,28,37,46,59,68,91,140,149],
            &[1525,1525,1525,1538,1538,2580,2580,1350,8574,2175],variation(1),22000));
    }
    let mut children=Vec::new();
    let mut en=tags::CTRL_ENDNOTE.to_le_bytes().to_vec();en.extend([1u8,0,0,0]);en.extend([0;8]);
    record(&mut children,tags::HWPTAG_CTRL_HEADER,1,&en);
    let mut list=vec![0;16];list[..4].copy_from_slice(&(if graph {2u32}else{3u32}).to_le_bytes());
    record(&mut children,tags::HWPTAG_LIST_HEADER,2,&list);children.extend(note);
    let mut body="BODY".encode_utf16().collect::<Vec<_>>();body.extend(slot(17,tags::CTRL_ENDNOTE));
    section.extend(paragraph(&body,&[line(0,1625,1125,31456)],&children,0));
    let mut header=vec![0;256];header[..17].copy_from_slice(b"HWP Document File");header[32..36].copy_from_slice(&[0,0,0,5]);
    let info=rhwp::serializer::doc_info::serialize_doc_info(&doc.doc_info,&doc.doc_properties);
    let mut cfb=cfb::CompoundFile::create_with_version(cfb::Version::V3,Cursor::new(Vec::new())).unwrap();
    cfb.create_storage_all("/BodyText").unwrap();cfb.create_storage_all("/BinData").unwrap();
    for (path,bytes) in [("/FileHeader",header),("/DocInfo",info),("/BodyText/Section0",section),
        ("/BinData/BIN0001.png",RED.to_vec()),("/BinData/BIN0002.png",BLUE.to_vec())] {
        cfb.create_stream(path).unwrap().write_all(&bytes).unwrap();
    }
    cfb.into_inner().into_inner()
}

fn nodes<'a>(n: &'a RenderNode, out: &mut Vec<&'a RenderNode>) {
    out.push(n);for c in &n.children { nodes(c,out); }
}

fn check(graph: bool, policy: FontMetricsPolicy) {
    let bytes=fixture(graph);
    let core=DocumentCore::from_bytes_with_font_metrics(&bytes,policy).unwrap();
    let section=&core.document().sections[0];
    assert_eq!(section.paragraphs.len(),2,"owned body source address");
    let Control::Endnote(note)=&section.paragraphs[1].controls[0] else {panic!("owned s0/body1/control0");};
    let targets: Vec<(usize,usize,u32,usize)>=if graph {vec![(1,1,29,1)]} else {vec![(1,3,65,2),(2,10,140,8)]};
    for &(np,ci,raw,row) in &targets {
        let p=&note.paragraphs[np];
        let Control::Table(table)=&p.controls[ci] else {panic!("parsed note{np}/control{ci}");};
        assert_eq!(p.line_segs[row].text_start,if graph {26}else{raw});
        let markers=p.control_text_positions();
        assert_eq!(markers[ci],if graph {21}else if np==1 {41}else{60});
        assert_eq!(table.cells.len(),if graph {2}else{15});
        // An explicit raw-slot assertion independent of visible positions.
        let mut cfb=cfb::CompoundFile::open(Cursor::new(bytes.clone())).unwrap();
        let mut stream=Vec::new();std::io::Read::read_to_end(&mut cfb.open_stream("/BodyText/Section0").unwrap(),&mut stream).unwrap();
        let records=rhwp::parser::record::Record::read_all(&stream).unwrap();
        let raw_hosts:Vec<_>=records.iter().filter(|r|r.tag_id==tags::HWPTAG_PARA_TEXT&&r.level==3).collect();
        let payload=&raw_hosts[np].data;
        assert_eq!(&payload[raw as usize*2..raw as usize*2+16],
            slot(11,tags::CTRL_TABLE).into_iter().flat_map(u16::to_le_bytes).collect::<Vec<_>>().as_slice());
        for (cell_idx,cell) in table.cells.iter().enumerate() {
            assert_eq!(cell.paragraphs.len(),1);
            if graph {
                let Control::Picture(pic)=&cell.paragraphs[0].controls[0] else {panic!("parsed graph cell{cell_idx}/para0/control0");};
                assert_eq!(pic.image_attr.bin_data_id,(cell_idx+1) as u16);
            } else {
                let Control::Equation(e)=&cell.paragraphs[0].controls[0] else {panic!("parsed variation cell{cell_idx}/para0/control0");};
                assert_eq!(e.script,format!("v_{{{}{}}}={}",np-1,cell_idx/5,cell_idx%5));
            }
        }
        let virtual_pi=section.paragraphs.len()+np;
        let mut seen=Vec::new();
        let mut tables=0;
        for page in 0..core.page_count() {
            let tree=core.build_page_render_tree(page).unwrap();
            let mut all=Vec::new();nodes(&tree.root,&mut all);
            for n in all {
                if let RenderNodeType::Table(t)=&n.node_type {
                    if (t.section_index,t.para_index,t.control_index)==(Some(0),Some(virtual_pi),Some(ci)) {
                        assert!(n.visible&&n.bbox.width>0.0&&n.bbox.height>0.0);tables+=1;
                    }
                }
                if graph {
                    if let RenderNodeType::Image(img)=&n.node_type {
                        if let Some(ctx)=&img.cell_context {
                            if ctx.parent_para_index==virtual_pi&&ctx.path[0].control_index==ci {
                                assert_eq!(img.section_index,Some(0));assert_eq!(ctx.path.len(),1);
                                assert_eq!(ctx.path[0].cell_para_index,0);assert_eq!(img.control_index,Some(0));
                                let cell=ctx.path[0].cell_index;
                                assert_eq!(img.bin_data_id,(cell+1) as u16);
                                assert_eq!(img.data.as_deref(),Some(if cell==0 {RED}else{BLUE}));
                                assert!(n.visible&&n.bbox.width>0.0&&n.bbox.height>0.0);seen.push(cell);
                            }
                        }
                    }
                } else if let RenderNodeType::Equation(e)=&n.node_type {
                    if let Some(ctx)=&e.cell_context {
                        if ctx.parent_para_index==virtual_pi&&ctx.path[0].control_index==ci {
                            assert_eq!(ctx.path.len(),1);assert_eq!(e.inner_control_index,Some(0));
                            assert_eq!(ctx.path[0].cell_para_index,0);
                            assert!(n.visible&&!e.svg_content.is_empty()&&n.bbox.width>0.0&&n.bbox.height>0.0);
                            seen.push(ctx.path[0].cell_index);
                        }
                    }
                }
            }
        }
        assert_eq!(tables,1,"exact source table s0/body1/control0/note{np}/control{ci}");
        seen.sort_unstable();
        assert_eq!(seen,(0..table.cells.len()).collect::<Vec<_>>(),
            "each source cell/para0/control0 must emit exactly once across every page");
    }
}

#[test]
fn owned_variation_tables_keep_all_source_cell_equations() {
    for p in [FontMetricsPolicy::HancomWindows,FontMetricsPolicy::HcrDeclared] { check(false,p); }
}

#[test]
fn owned_trailing_graph_table_keeps_both_source_cell_pictures() {
    for p in [FontMetricsPolicy::HancomWindows,FontMetricsPolicy::HcrDeclared] { check(true,p); }
}

// Local-only original source join. Run this first in a future authorized native check.
// It does not assume original raw body indexes survived normalization.
// Source/file SHA256 checks in FUTURE-CHECKS.md are mandatory before running it.
#[test]
fn original_source_model_and_composition_probe() {
    let root="C:/Users/manag/parity-runs/math10-20261018/docs";
    for (file,instance,number,targets) in [
        ("math-2024-09-g3-calculus.hwp",1706071244u32,30u16,
            vec![(10usize,3usize,324668usize,3u16,5u16),(12,10,333797,3,5)]),
        ("math-2024-10-g3-geometry.hwp",1706883258u32,21u16,vec![(9usize,1usize,223161usize,1u16,2u16)]),
    ] {
        let bytes=std::fs::read(format!("{root}/{file}")).unwrap();
        for policy in [FontMetricsPolicy::HancomWindows,FontMetricsPolicy::HcrDeclared] {
            let core=DocumentCore::from_local_file_bytes_with_font_metrics(&bytes,policy).unwrap();
            let mut owners=Vec::new();
            for (si,sec) in core.document().sections.iter().enumerate() {
                for (pi,p) in sec.paragraphs.iter().enumerate() {
                    for (ci,c) in p.controls.iter().enumerate() {
                        if let Control::Endnote(n)=c {
                            if n.instance_id==instance {owners.push((si,pi,ci,n));}
                        }
                    }
                }
            }
            assert_eq!(owners.len(),1,"raw source note instance must identify exactly one parsed owner");
            let (si,pi,ci,note)=owners[0];assert_eq!(note.number,number);
            let raw=core.document().sections[si].raw_stream.as_ref().expect("raw HWP5 section required");
            for &(np,tci,offset,rows,cols) in &targets {
                let p=&note.paragraphs[np];
                let Control::Table(t)=&p.controls[tci] else {panic!("first missing model table at note{np}/control{tci}");};
                let word=u32::from_le_bytes(raw[offset..offset+4].try_into().unwrap());
                assert_eq!(word&1023,tags::HWPTAG_CTRL_HEADER as u32);
                let (size,skip)=if word>>20==4095 {
                    (u32::from_le_bytes(raw[offset+4..offset+8].try_into().unwrap()) as usize,8)
                } else {((word>>20) as usize,4)};
                let payload=&raw[offset+skip..offset+skip+size];
                assert_eq!(&payload[..4],&tags::CTRL_TABLE.to_le_bytes());
                assert_eq!(t.raw_ctrl_data.as_slice(),&payload[4..],"exact source CTRL_HEADER payload join");
                assert_eq!((t.row_count,t.col_count),(rows,cols));
                let composed=rhwp::renderer::composer::compose_paragraph_with_policy(p,policy);
                let width=p.line_segs[0].segment_width;
                let inline=rhwp::renderer::height_measurer::is_tac_table_inline_in_para(t,width,p);
                eprintln!("SOURCE_JOIN file={file} policy={policy:?} s={si} body={pi} note_control={ci} note_para={np} table_control={tci} raw_ctrl={offset} raw_rows={} composed_rows={} inline={inline} table_in_tacs={} widths={:?}",
                    p.line_segs.len(),composed.lines.len(),composed.tac_controls.iter().any(|(_,_,ci)|*ci==tci),t.get_column_widths());
                for (li,l) in composed.lines.iter().enumerate() {
                    eprintln!("COMPOSED row={li} char_start={} height={} baseline={} spacing={} runs={:?}",
                        l.char_start,l.line_height,l.baseline_distance,l.line_spacing,
                        l.runs.iter().map(|r|r.text.as_str()).collect::<Vec<_>>());
                }
                if number==21 {
                    for (cell,bin,height) in [(0usize,5u16,13940u32),(1,6,12020)] {
                        let Control::Picture(pic)=&t.cells[cell].paragraphs[0].controls[0]
                            else {panic!("first missing model picture note9/control1/cell{cell}/para0/control0");};
                        assert_eq!((pic.common.width,pic.common.height,pic.image_attr.bin_data_id),(13436,height,bin));
                        let blob=core.document().bin_data_content.iter().find(|b|b.id==bin).expect("parsed source BinData ID");
                        assert!(!blob.data.load_shared().is_empty());
                    }
                }
            }
        }
    }
}

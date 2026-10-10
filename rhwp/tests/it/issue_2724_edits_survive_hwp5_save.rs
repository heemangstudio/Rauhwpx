//! [#2724] HWP5 원본의 패스스루 층을 무효화하지 않는 편집은 저장 시점에 조용히 사라진다.
//!
//! HWP5 를 열면 구역마다 `Section::raw_stream` 이 채워지고, 직렬화는 그 값이 `Some` 이면
//! 원본 바이트를 그대로 내보낸다. DocInfo 도 `raw_stream_dirty` 가 꺼져 있으면 원본을 쓴다.
//! 이 파일은 명령 계열별 대표 편집을 HWP5 원본에 적용하고, 저장 후 다시 연 문서가 편집 직후의
//! 메모리 상태와 같은지 확인한다. 무효화가 빠진 편집은 재로드 결과가 원본으로 돌아가 실패한다.

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::paragraph::Paragraph;
use rhwp::model::shape::ShapeObject;

const SAMPLE: &str = "samples/hwp_table_test.hwp";

/// 1x1 투명 PNG.
const TINY_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x62, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

fn load(bytes: &[u8]) -> DocumentCore {
    DocumentCore::from_bytes(bytes).unwrap_or_else(|e| panic!("parse: {e:?}"))
}

/// 저장 왕복으로 보존돼야 하는 문서 상태. id 는 저장 시 재번호될 수 있으므로 속성으로 푼다.
fn fingerprint(core: &DocumentCore) -> Vec<String> {
    let doc = core.document();
    let mut out = Vec::new();
    for (si, section) in doc.sections.iter().enumerate() {
        walk(core, &section.paragraphs, &format!("s{si}"), &mut out);
    }
    out
}

fn walk(core: &DocumentCore, paragraphs: &[Paragraph], scope: &str, out: &mut Vec<String>) {
    let info = &core.document().doc_info;
    for (pi, para) in paragraphs.iter().enumerate() {
        let align = info
            .para_shapes
            .get(para.para_shape_id as usize)
            .map(|shape| format!("{:?}", shape.alignment))
            .unwrap_or_default();
        let bold = para.char_shapes.iter().any(|run| {
            info.char_shapes
                .get(run.char_shape_id as usize)
                .is_some_and(|shape| shape.bold)
        });
        out.push(format!("{scope}/p{pi} {align} bold={bold} {:?}", para.text));
        for (ci, control) in para.controls.iter().enumerate() {
            let here = format!("{scope}/p{pi}/c{ci}");
            match control {
                Control::Table(table) => {
                    out.push(format!(
                        "{here} table {}x{}",
                        table.row_count, table.col_count
                    ));
                    for (cell_idx, cell) in table.cells.iter().enumerate() {
                        walk(
                            core,
                            &cell.paragraphs,
                            &format!("{here}/cell{cell_idx}"),
                            out,
                        );
                    }
                }
                Control::Header(header) => {
                    out.push(format!("{here} header"));
                    walk(core, &header.paragraphs, &here, out);
                }
                Control::Footer(footer) => {
                    out.push(format!("{here} footer"));
                    walk(core, &footer.paragraphs, &here, out);
                }
                Control::Footnote(note) => {
                    out.push(format!("{here} footnote"));
                    walk(core, &note.paragraphs, &here, out);
                }
                Control::Shape(shape) => {
                    let kind = match shape.as_ref() {
                        ShapeObject::Rectangle(_) => "rectangle",
                        _ => "shape",
                    };
                    out.push(format!("{here} {kind}"));
                }
                Control::Picture(_) => out.push(format!("{here} picture")),
                Control::Equation(eq) => out.push(format!("{here} equation {:?}", eq.script)),
                Control::Bookmark(mark) => out.push(format!("{here} bookmark {:?}", mark.name)),
                _ => {}
            }
        }
    }
}

/// 컨트롤 없는 첫 텍스트 문단과 첫 표의 위치.
fn anchors(core: &DocumentCore) -> (usize, (usize, usize)) {
    let paragraphs = &core.document().sections[0].paragraphs;
    let text_para = paragraphs
        .iter()
        .position(|p| p.text.chars().count() >= 2 && p.controls.is_empty())
        .expect("text paragraph");
    let table = paragraphs
        .iter()
        .enumerate()
        .find_map(|(pi, p)| {
            p.controls
                .iter()
                .position(|c| matches!(c, Control::Table(_)))
                .map(|ci| (pi, ci))
        })
        .expect("table");
    (text_para, table)
}

type Edit = fn(&mut DocumentCore, usize, (usize, usize));

const EDITS: &[(&str, Edit)] = &[
    ("insert text", |core, p, _| {
        core.insert_text_native(0, p, 0, "편집").unwrap();
    }),
    ("delete text", |core, p, _| {
        core.delete_text_native(0, p, 0, 1).unwrap();
    }),
    ("char format", |core, p, _| {
        core.apply_char_format_native(0, p, 0, 2, r#"{"bold":true}"#)
            .unwrap();
    }),
    ("para format", |core, p, _| {
        core.apply_para_format_native(0, p, r#"{"alignment":"center"}"#)
            .unwrap();
    }),
    ("split paragraph", |core, p, _| {
        core.split_paragraph_native(0, p, 1, None).unwrap();
    }),
    ("paste html", |core, p, _| {
        core.paste_html_native(0, p, 0, "<p><strong>붙임</strong></p>")
            .unwrap();
    }),
    ("insert table row", |core, _, (tp, ci)| {
        core.insert_table_row_native(0, tp, ci, 0, true).unwrap();
    }),
    ("cell text", |core, _, (tp, ci)| {
        core.insert_text_in_cell_native(0, tp, ci, 0, 0, 0, "셀편집")
            .unwrap();
    }),
    ("create table", |core, p, _| {
        core.create_table_native(0, p, 0, 2, 2).unwrap();
    }),
    ("footnote", |core, p, _| {
        core.insert_footnote_native(0, p, 1).unwrap();
    }),
    ("header", |core, _, _| {
        core.create_header_footer_native(0, true, 0).unwrap();
        core.insert_text_in_header_footer_native(0, true, 0, 0, 0, "머리말")
            .unwrap();
    }),
    ("picture", |core, p, _| {
        core.insert_picture_with_placement_native(
            0,
            p,
            0,
            &[],
            TINY_PNG,
            3000,
            3000,
            1,
            1,
            "png",
            "",
            None,
            None,
            true,
        )
        .unwrap();
    }),
    ("shape", |core, p, _| {
        core.create_shape_control_native(
            0,
            p,
            0,
            9000,
            4000,
            0,
            0,
            false,
            "InFrontOfText",
            "rectangle",
            false,
            false,
            &[],
        )
        .unwrap();
    }),
    ("equation", |core, p, _| {
        core.insert_equation_native(0, p, 0, "1 over 2", 1000, 0)
            .unwrap();
    }),
    ("bookmark", |core, p, _| {
        core.add_bookmark_native(0, p, 0, "편집책갈피").unwrap();
    }),
];

#[test]
fn edits_on_hwp5_source_survive_save_and_reload() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(SAMPLE);
    let source = std::fs::read(&path).unwrap_or_else(|e| panic!("read {SAMPLE}: {e}"));
    let original = load(&source);
    assert!(
        original
            .document()
            .sections
            .iter()
            .all(|s| s.raw_stream.is_some()),
        "HWP5 원본은 구역 패스스루를 가져야 이 검사가 의미 있다"
    );
    let anchors = anchors(&original);
    let before = fingerprint(&original);

    let mut lost = Vec::new();
    for (name, edit) in EDITS {
        let mut core = load(&source);
        edit(&mut core, anchors.0, anchors.1);
        let edited = fingerprint(&core);
        assert_ne!(edited, before, "{name}: 편집이 문서를 바꾸지 않았다");

        let saved = core
            .export_hwp_native()
            .unwrap_or_else(|e| panic!("{name}: save: {e:?}"));
        let reloaded = fingerprint(&load(&saved));
        if reloaded != edited {
            lost.push(*name);
        }
    }
    assert!(lost.is_empty(), "저장 후 사라진 편집: {lost:?}");
}

//! HWPX 라운드트립 IR diff — `parse → serialize → parse` 한 IR을 원본과 비교.
//!
//! ## 원칙
//!
//! - **바이트 비교 금지**: XML 속성 순서·ZIP 압축율 유동성 때문에 브리틀함
//! - **IR 의미 비교**: Document 공개 필드 단위로 비교
//! - **누적 확장**: Stage 0에선 뼈대 필드(섹션 수·문단 수·리소스 카운트)만 비교하고,
//!   Stage 1~5 진행 시 비교 대상 필드를 누적 확장한다
//!
//! Stage 0 최소 세트:
//! - sections.len()
//! - 각 section의 paragraphs.len()
//! - doc_info의 리소스 카운트 (char_shapes, para_shapes, border_fills 등)
//! - bin_data_content.len()
//!
//! Task #1378 확장:
//! - 본문(top-level) 문단별 `char_shapes` 시퀀스 — `(start_pos, char_shape_id)` 전체 비교.
//!   serializer 의 run 평탄화(첫 run 서식으로 통일)를 검출한다.
//!   셀·글상자(Group 재귀)·각주/미주 내부 문단 재귀 비교 포함 (3단계).
//!
//! Task #1379 확장:
//! - 문단별 인라인 슬롯 컨트롤 타입 시퀀스 비교 (`is_hwpx_inline_slot` 기준, 본문 +
//!   #1378 재귀 동승). 셀·글상자 subList 의 컨트롤 소실(그림 등)을 검출한다.
//!   Bookmark 등 위치 없는 비슬롯 컨트롤은 비교 대상에서 제외.
//!
//! Task #1380 확장:
//! - 문단별 `line_segs` 9필드 비교 (`diff_linesegs`) 를 `ParagraphLinesegs` 로 변환해
//!   게이트 동승 (3단계). 파서 zero-default 주입 제거 + serializer 방출 생략(2단계)
//!   이후의 원본 무 ↔ RT 유 합성 비대칭(개수·값 불일치)을 검출한다.
//!
//! Task #1388 확장:
//! - 섹션별 `PageDef`(용지 크기·방향·제본 + 여백 7필드) 비교 (`diff_page_def`) 를
//!   `SectionPageDef` 로 게이트 동승. serializer 의 secPr 템플릿 고정값 방출
//!   (여백·gutterType 변형)을 검출한다.
//!
//! Task #1387 확장:
//! - 표 캡션 비교 (`diff_table_caption`) 를 `TableCaption` 으로 게이트 동승 —
//!   존재 비대칭/속성 5종/문단 수. 캡션 내부 문단은 char_shapes·controls·linesegs
//!   재귀에 `tbl.caption.p[k]` 경로로 동승한다.
//!
//! #1403 확장:
//! - 그림/도형/묶음 캡션을 `ObjectCaption` 으로 게이트 동승 — Picture 컨트롤은
//!   `pic.caption`, ShapeObject 는 `shape_caption` 접근자(그리기 도형 `drawing.caption`
//!   + Group/Chart/Ole/Picture 전용 필드) 경유. 비교·재귀는 #1387 경로 공유.

#![allow(dead_code)]

use super::section::is_hwpx_inline_slot;
use crate::model::document::Document;
use crate::parser::hwpx::parse_hwpx;
use crate::serializer::hwpx::serialize_hwpx;
use crate::serializer::SerializeError;

/// IR diff 결과 — 발견된 차이 목록을 보관.
#[derive(Debug, Default)]
pub struct IrDiff {
    pub differences: Vec<IrDifference>,
}

impl IrDiff {
    pub fn is_empty(&self) -> bool {
        self.differences.is_empty()
    }

    pub fn push(&mut self, d: IrDifference) {
        self.differences.push(d);
    }

    /// 관용 규칙 하에서 통과로 볼 수 있는가 (Stage 5에서 확장 예정).
    pub fn allowed(&self, _allow: IrDiffAllow) -> bool {
        self.is_empty()
    }
}

/// Stage 5에서 도형 raw 바이트 불일치 등을 허용하기 위한 옵션 (현재 미사용).
#[derive(Debug, Default, Clone, Copy)]
pub struct IrDiffAllow {
    pub shape_raw: bool,
}

/// 발견된 단일 차이.
#[derive(Debug, Clone)]
pub enum IrDifference {
    SectionCount {
        expected: usize,
        actual: usize,
    },
    ParagraphCount {
        section: usize,
        expected: usize,
        actual: usize,
    },
    CharShapeCount {
        expected: usize,
        actual: usize,
    },
    ParaShapeCount {
        expected: usize,
        actual: usize,
    },
    BorderFillCount {
        expected: usize,
        actual: usize,
    },
    TabDefCount {
        expected: usize,
        actual: usize,
    },
    NumberingCount {
        expected: usize,
        actual: usize,
    },
    StyleCount {
        expected: usize,
        actual: usize,
    },
    BinDataContentCount {
        expected: usize,
        actual: usize,
    },
    /// 문단의 char_shapes 시퀀스 불일치 — run 분할 보존 게이트 (#1378).
    ///
    /// `path` 는 중첩 위치 표기 — 본문 문단은 빈 문자열, 셀·글상자·각주/미주 내부
    /// 문단은 `/ctrl[i]tbl.cell[j].p[k]` 식의 경로.
    ParagraphCharShapes {
        section: usize,
        paragraph: usize,
        path: String,
        expected: String,
        actual: String,
    },
    /// 문단의 인라인 슬롯 컨트롤 타입 시퀀스 불일치 — 컨트롤 보존 게이트 (#1379).
    ///
    /// `path` 표기는 `ParagraphCharShapes` 와 동일.
    ParagraphControls {
        section: usize,
        paragraph: usize,
        path: String,
        expected: String,
        actual: String,
    },
    /// 문단의 `line_segs` 불일치 — lineseg 원본 보존 게이트 (#1380).
    ///
    /// `path` 표기는 `ParagraphCharShapes` 와 동일. `detail` 은 `LinesegDiffKind` 의
    /// 표시 문자열 (개수 불일치 또는 인덱스·필드 단위 값 불일치).
    ParagraphLinesegs {
        section: usize,
        paragraph: usize,
        path: String,
        detail: String,
    },
    /// 섹션 `PageDef`(용지·여백) 불일치 — secPr 페이지 여백 보존 게이트 (#1388).
    ///
    /// `detail` 은 불일치 필드별 "field: expected=.. actual=.." 을 세미콜론으로
    /// 연결한 문자열 (`diff_page_def`).
    SectionPageDef {
        section: usize,
        detail: String,
    },
    /// 섹션 `<hp:visibility>`(첫쪽 머리말/꼬리말/바탕쪽 숨김·테두리·배경·첫 빈줄 숨김)
    /// 불일치 — secPr visibility 보존 게이트 (#1637).
    ///
    /// 직렬화기가 visibility 를 IR 대신 템플릿 고정값으로 방출하면 hideFirstEmptyLine 등이
    /// 드롭되어 페이지네이션이 달라진다(IR-invisible 결함). `detail` 형식은 `diff_page_def` 동형.
    SectionVisibility {
        section: usize,
        detail: String,
    },
    /// 표 캡션 불일치 — 캡션 보존 게이트 (#1387).
    ///
    /// `path` 는 `…tbl.caption` 까지의 중첩 경로. `detail` 은 존재 비대칭 또는
    /// 불일치 필드별 "field: expected=.. actual=.." 세미콜론 연결 (`diff_table_caption`).
    TableCaption {
        section: usize,
        paragraph: usize,
        path: String,
        detail: String,
    },
    /// 그림/도형/묶음 캡션 불일치 — 캡션 보존 게이트 (#1403).
    ///
    /// `path` 는 `…pic.caption` / `…shape.caption` 등 중첩 경로. `detail` 형식은
    /// `TableCaption` 과 동일 (`diff_table_caption` 공유).
    ObjectCaption {
        section: usize,
        paragraph: usize,
        path: String,
        detail: String,
    },
    /// 그림/도형/수식/묶음 설명(`hp:shapeComment`) 불일치 — 설명 보존 게이트 (#1392).
    ///
    /// `path` 는 `…pic` / `…shape` / `…eq` 등 중첩 경로. `detail` 은
    /// `"expected={:?} actual={:?}"`.
    ObjectComment {
        section: usize,
        paragraph: usize,
        path: String,
        detail: String,
    },
    /// 수식 스크립트/EQEDIT 메타데이터/배치 속성 불일치. 수식은 문단 text에 포함되지
    /// 않으므로 이 게이트가 없으면 script가 빈 문자열이 되어도 검증이 통과한다.
    EquationContent {
        section: usize,
        paragraph: usize,
        path: String,
        detail: String,
    },
    /// 필드 parameters / MEMO 본문 불일치 — 필드 보존 게이트 (#1391).
    ///
    /// `path` 는 `…field` (parameters) 또는 `…field.memo.p[k]` (본문 재귀).
    FieldContent {
        section: usize,
        paragraph: usize,
        path: String,
        detail: String,
    },
    /// 그림 크기 요소(curSz/imgRect/imgDim) 불일치 — 그림 크기 보존 게이트 (#1389).
    ///
    /// `path` 는 `…pic`. `detail` 은 불일치 필드별 "field: expected=.. actual=.."
    /// 세미콜론 연결.
    PictureSize {
        section: usize,
        paragraph: usize,
        path: String,
        detail: String,
    },
    /// 표 `page_break` 불일치 — 표 분할 속성 보존 게이트 (#1393).
    ///
    /// 방출(serializer)은 PR #1405 에서 정정됨 — 본 게이트는 회귀 봉인용.
    /// `path` 는 `…tbl`.
    TablePageBreak {
        section: usize,
        paragraph: usize,
        path: String,
        detail: String,
    },
    /// 개체 `holdAnchorAndSO`(IR `prevent_page_break`) 불일치 — 페이지 하단 앵커
    /// 개체에서 1→0 드롭 시 한글 페이지 붕괴를 유발(#1594). IR-invisible 였던 갭을 봉인.
    ObjectHoldAnchor {
        section: usize,
        paragraph: usize,
        path: String,
        detail: String,
    },
    /// 개체 `flowWithText`(IR `flow_with_text`) 불일치 — 표(treatAsChar)에서 0→1 드롭 시
    /// partial-split 임계가 흔들려 페이지네이션이 달라진다(#1637). IR-invisible 였던 갭을 봉인.
    ObjectFlowWithText {
        section: usize,
        paragraph: usize,
        path: String,
        detail: String,
    },
}

impl std::fmt::Display for IrDifference {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        use IrDifference::*;
        match self {
            SectionCount { expected, actual } => {
                write!(f, "section count: expected={} actual={}", expected, actual)
            }
            ParagraphCount {
                section,
                expected,
                actual,
            } => write!(
                f,
                "section[{}] paragraph count: expected={} actual={}",
                section, expected, actual
            ),
            CharShapeCount { expected, actual } => write!(
                f,
                "char_shapes count: expected={} actual={}",
                expected, actual
            ),
            ParaShapeCount { expected, actual } => write!(
                f,
                "para_shapes count: expected={} actual={}",
                expected, actual
            ),
            BorderFillCount { expected, actual } => write!(
                f,
                "border_fills count: expected={} actual={}",
                expected, actual
            ),
            TabDefCount { expected, actual } => {
                write!(f, "tab_defs count: expected={} actual={}", expected, actual)
            }
            NumberingCount { expected, actual } => write!(
                f,
                "numberings count: expected={} actual={}",
                expected, actual
            ),
            StyleCount { expected, actual } => {
                write!(f, "styles count: expected={} actual={}", expected, actual)
            }
            BinDataContentCount { expected, actual } => write!(
                f,
                "bin_data_content count: expected={} actual={}",
                expected, actual
            ),
            ParagraphCharShapes {
                section,
                paragraph,
                path,
                expected,
                actual,
            } => write!(
                f,
                "section[{}] paragraph[{}]{} char_shapes: expected={} actual={}",
                section, paragraph, path, expected, actual
            ),
            ParagraphControls {
                section,
                paragraph,
                path,
                expected,
                actual,
            } => write!(
                f,
                "section[{}] paragraph[{}]{} controls: expected={} actual={}",
                section, paragraph, path, expected, actual
            ),
            ParagraphLinesegs {
                section,
                paragraph,
                path,
                detail,
            } => write!(
                f,
                "section[{}] paragraph[{}]{} linesegs: {}",
                section, paragraph, path, detail
            ),
            SectionPageDef { section, detail } => {
                write!(f, "section[{}] page_def: {}", section, detail)
            }
            SectionVisibility { section, detail } => {
                write!(f, "section[{}] visibility: {}", section, detail)
            }
            TableCaption {
                section,
                paragraph,
                path,
                detail,
            } => write!(
                f,
                "section[{}] paragraph[{}]{} caption: {}",
                section, paragraph, path, detail
            ),
            ObjectCaption {
                section,
                paragraph,
                path,
                detail,
            } => write!(
                f,
                "section[{}] paragraph[{}]{} caption: {}",
                section, paragraph, path, detail
            ),
            ObjectComment {
                section,
                paragraph,
                path,
                detail,
            } => write!(
                f,
                "section[{}] paragraph[{}]{} comment: {}",
                section, paragraph, path, detail
            ),
            EquationContent {
                section,
                paragraph,
                path,
                detail,
            } => write!(
                f,
                "section[{}] paragraph[{}]{} equation: {}",
                section, paragraph, path, detail
            ),
            FieldContent {
                section,
                paragraph,
                path,
                detail,
            } => write!(
                f,
                "section[{}] paragraph[{}]{} field: {}",
                section, paragraph, path, detail
            ),
            PictureSize {
                section,
                paragraph,
                path,
                detail,
            } => write!(
                f,
                "section[{}] paragraph[{}]{} pic_size: {}",
                section, paragraph, path, detail
            ),
            TablePageBreak {
                section,
                paragraph,
                path,
                detail,
            } => write!(
                f,
                "section[{}] paragraph[{}]{} tbl page_break: {}",
                section, paragraph, path, detail
            ),
            ObjectHoldAnchor {
                section,
                paragraph,
                path,
                detail,
            } => write!(
                f,
                "section[{}] paragraph[{}]{} holdAnchorAndSO: {}",
                section, paragraph, path, detail
            ),
            ObjectFlowWithText {
                section,
                paragraph,
                path,
                detail,
            } => write!(
                f,
                "section[{}] paragraph[{}]{} flowWithText: {}",
                section, paragraph, path, detail
            ),
        }
    }
}

/// 그림 크기 요소 비교 (#1389) — curSz(shape_attr current)·imgRect(border_x/y)·
/// imgDim. 불일치 필드를 세미콜론으로 연결. 일치하면 None.
fn diff_picture_size(
    a: &crate::model::image::Picture,
    b: &crate::model::image::Picture,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if a.shape_attr.current_width != b.shape_attr.current_width
        || a.shape_attr.current_height != b.shape_attr.current_height
    {
        parts.push(format!(
            "curSz: expected={}x{} actual={}x{}",
            a.shape_attr.current_width,
            a.shape_attr.current_height,
            b.shape_attr.current_width,
            b.shape_attr.current_height
        ));
    }
    if a.border_x != b.border_x || a.border_y != b.border_y {
        parts.push(format!(
            "imgRect: expected={:?}/{:?} actual={:?}/{:?}",
            a.border_x, a.border_y, b.border_x, b.border_y
        ));
    }
    if a.img_dim != b.img_dim {
        parts.push(format!(
            "imgDim: expected={:?} actual={:?}",
            a.img_dim, b.img_dim
        ));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("; "))
    }
}

/// 두 `CommonObjAttr.description` 비교 (#1392). 다르면 detail 문자열, 같으면 None.
fn diff_object_comment(a: &str, b: &str) -> Option<String> {
    if a == b {
        None
    } else {
        Some(format!("expected={:?} actual={:?}", a, b))
    }
}

/// 문단 텍스트 밖에 저장되는 수식의 본문과 표시 계약을 비교한다.
fn diff_equation(
    a: &crate::model::control::Equation,
    b: &crate::model::control::Equation,
) -> Option<String> {
    let mut parts = Vec::new();
    macro_rules! check {
        ($name:literal, $left:expr, $right:expr) => {
            if $left != $right {
                parts.push(format!(
                    "{}: expected={:?} actual={:?}",
                    $name, $left, $right
                ));
            }
        };
    }

    check!("script", &a.script, &b.script);
    check!("attr", a.attr, b.attr);
    check!("font_size", a.font_size, b.font_size);
    check!("color", a.color, b.color);
    check!("baseline", a.baseline, b.baseline);
    check!("unknown", a.unknown, b.unknown);
    check!("version_info", &a.version_info, &b.version_info);
    check!("font_name", &a.font_name, &b.font_name);
    check!("width", a.common.width, b.common.width);
    check!("height", a.common.height, b.common.height);
    check!(
        "width_criterion",
        a.common.width_criterion,
        b.common.width_criterion
    );
    check!(
        "height_criterion",
        a.common.height_criterion,
        b.common.height_criterion
    );
    check!("size_protect", a.common.size_protect, b.common.size_protect);
    check!(
        "treat_as_char",
        a.common.treat_as_char,
        b.common.treat_as_char
    );
    check!(
        "affect_line_spacing",
        a.common.affect_line_spacing,
        b.common.affect_line_spacing
    );
    check!(
        "allow_overlap",
        a.common.allow_overlap,
        b.common.allow_overlap
    );
    check!("text_wrap", a.common.text_wrap, b.common.text_wrap);
    check!("text_flow", a.common.text_flow, b.common.text_flow);
    check!("vert_rel_to", a.common.vert_rel_to, b.common.vert_rel_to);
    check!("horz_rel_to", a.common.horz_rel_to, b.common.horz_rel_to);
    check!("vert_align", a.common.vert_align, b.common.vert_align);
    check!("horz_align", a.common.horz_align, b.common.horz_align);
    check!(
        "vertical_offset",
        a.common.vertical_offset,
        b.common.vertical_offset
    );
    check!(
        "horizontal_offset",
        a.common.horizontal_offset,
        b.common.horizontal_offset
    );

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("; "))
    }
}

/// 두 개체의 `prevent_page_break`(holdAnchorAndSO) 비교 (#1594). 다르면 detail, 같으면 None.
fn diff_hold_anchor(
    a: &crate::model::shape::CommonObjAttr,
    b: &crate::model::shape::CommonObjAttr,
) -> Option<String> {
    if a.prevent_page_break == b.prevent_page_break {
        None
    } else {
        Some(format!(
            "expected={} actual={}",
            a.prevent_page_break, b.prevent_page_break
        ))
    }
}

/// 두 개체의 `flow_with_text`(flowWithText) 비교 (#1637). 다르면 detail, 같으면 None.
fn diff_flow_with_text(
    a: &crate::model::shape::CommonObjAttr,
    b: &crate::model::shape::CommonObjAttr,
) -> Option<String> {
    if a.flow_with_text == b.flow_with_text {
        None
    } else {
        Some(format!(
            "expected={} actual={}",
            a.flow_with_text, b.flow_with_text
        ))
    }
}

/// HWPX 바이트 → parse → serialize → parse → 원본 IR과 비교.
pub fn roundtrip_ir_diff(hwpx_bytes: &[u8]) -> Result<IrDiff, SerializeError> {
    let doc1 = parse_hwpx(hwpx_bytes)
        .map_err(|e| SerializeError::XmlError(format!("원본 HWPX 파싱 실패: {}", e)))?;
    let out = serialize_hwpx(&doc1)?;
    let doc2 = parse_hwpx(&out)
        .map_err(|e| SerializeError::XmlError(format!("재직렬화 HWPX 파싱 실패: {}", e)))?;
    Ok(diff_documents(&doc1, &doc2))
}

/// Stage 0 최소 필드 비교.
///
/// Stage 1~5에서 비교 대상 필드를 누적 확장한다 (문단 텍스트, 표·그림 속성 등).
/// `hwpx-roundtrip` 배치 진단(Task #1315)에서도 사용한다.
pub fn diff_documents(a: &Document, b: &Document) -> IrDiff {
    let mut diff = IrDiff::default();

    // 섹션 수
    if a.sections.len() != b.sections.len() {
        diff.push(IrDifference::SectionCount {
            expected: a.sections.len(),
            actual: b.sections.len(),
        });
    }

    // 각 섹션의 문단 수 (섹션 수가 같을 때만 대응 비교)
    let pairs = a.sections.len().min(b.sections.len());
    for i in 0..pairs {
        let ap = a.sections[i].paragraphs.len();
        let bp = b.sections[i].paragraphs.len();
        if ap != bp {
            diff.push(IrDifference::ParagraphCount {
                section: i,
                expected: ap,
                actual: bp,
            });
        }

        // 섹션 PageDef(용지·여백) 비교 (#1388) — secPr 페이지 여백 보존 게이트.
        if let Some(detail) = diff_page_def(
            &a.sections[i].section_def.page_def,
            &b.sections[i].section_def.page_def,
        ) {
            diff.push(IrDifference::SectionPageDef { section: i, detail });
        }

        // 섹션 visibility(hideFirstEmptyLine 등) 비교 (#1637) — secPr visibility 보존 게이트.
        if let Some(detail) =
            diff_visibility(&a.sections[i].section_def, &b.sections[i].section_def)
        {
            diff.push(IrDifference::SectionVisibility { section: i, detail });
        }

        // 문단별 char_shapes 시퀀스 비교 (#1378) — run 분할 보존 게이트.
        // 본문 + 셀(Table)·글상자(Shape/TextBox)·각주/미주 내부 문단 재귀 (3단계 확장).
        let pp = ap.min(bp);
        for j in 0..pp {
            diff_paragraph_char_shapes(
                &mut diff,
                i,
                j,
                "",
                &a.sections[i].paragraphs[j],
                &b.sections[i].paragraphs[j],
            );
        }
    }

    // DocInfo 리소스 카운트
    if a.doc_info.char_shapes.len() != b.doc_info.char_shapes.len() {
        diff.push(IrDifference::CharShapeCount {
            expected: a.doc_info.char_shapes.len(),
            actual: b.doc_info.char_shapes.len(),
        });
    }
    if a.doc_info.para_shapes.len() != b.doc_info.para_shapes.len() {
        diff.push(IrDifference::ParaShapeCount {
            expected: a.doc_info.para_shapes.len(),
            actual: b.doc_info.para_shapes.len(),
        });
    }
    if a.doc_info.border_fills.len() != b.doc_info.border_fills.len() {
        diff.push(IrDifference::BorderFillCount {
            expected: a.doc_info.border_fills.len(),
            actual: b.doc_info.border_fills.len(),
        });
    }
    if a.doc_info.tab_defs.len() != b.doc_info.tab_defs.len() {
        diff.push(IrDifference::TabDefCount {
            expected: a.doc_info.tab_defs.len(),
            actual: b.doc_info.tab_defs.len(),
        });
    }
    if a.doc_info.numberings.len() != b.doc_info.numberings.len() {
        diff.push(IrDifference::NumberingCount {
            expected: a.doc_info.numberings.len(),
            actual: b.doc_info.numberings.len(),
        });
    }
    if a.doc_info.styles.len() != b.doc_info.styles.len() {
        diff.push(IrDifference::StyleCount {
            expected: a.doc_info.styles.len(),
            actual: b.doc_info.styles.len(),
        });
    }

    // BinData
    if a.bin_data_content.len() != b.bin_data_content.len() {
        diff.push(IrDifference::BinDataContentCount {
            expected: a.bin_data_content.len(),
            actual: b.bin_data_content.len(),
        });
    }

    // 문단별 line_segs 비교 (#1380) — lineseg 원본 보존 게이트 (3단계 동승).
    // 순회 경로는 diff_paragraph_char_shapes 와 동일 (본문 + 셀·글상자·각주/미주 재귀).
    for d in diff_linesegs(a, b) {
        diff.push(IrDifference::ParagraphLinesegs {
            section: d.section,
            paragraph: d.paragraph,
            path: d.path,
            detail: d.kind.to_string(),
        });
    }

    diff
}

/// 표 캡션 비교 (#1387). 존재 비대칭/속성/문단 수 불일치를 "field: expected=..
/// actual=.." 세미콜론 연결로 돌려준다. 일치하면 `None`.
/// 그림/도형/묶음 캡션(#1403)도 동일 비교를 공유한다 (`ObjectCaption` 으로 보고).
///
/// `vert_align` 은 비교 제외 — HWPX `hp:caption` 에 대응 속성이 없는 HWP5 유래
/// 필드라(#1387 1단계 전수 측정) serializer 가 방출하지 않으며, HWP5 출발 플로우
/// 비교에서 위양성을 만든다. 내부 문단의 상세 비교는 char_shapes/controls/linesegs
/// 재귀가 담당하므로 여기서는 문단 수만 본다.
fn diff_table_caption(
    a: &Option<crate::model::shape::Caption>,
    b: &Option<crate::model::shape::Caption>,
) -> Option<String> {
    let (a, b) = match (a, b) {
        (None, None) => return None,
        (Some(_), None) => return Some("missing: expected=Some actual=None".to_string()),
        (None, Some(_)) => return Some("synthetic: expected=None actual=Some".to_string()),
        (Some(a), Some(b)) => (a, b),
    };
    let mut parts: Vec<String> = Vec::new();
    if a.direction != b.direction {
        parts.push(format!(
            "side: expected={:?} actual={:?}",
            a.direction, b.direction
        ));
    }
    if a.include_margin != b.include_margin {
        parts.push(format!(
            "fullSz: expected={} actual={}",
            a.include_margin, b.include_margin
        ));
    }
    if a.width != b.width {
        parts.push(format!("width: expected={} actual={}", a.width, b.width));
    }
    if a.spacing != b.spacing {
        parts.push(format!("gap: expected={} actual={}", a.spacing, b.spacing));
    }
    if a.max_width != b.max_width {
        parts.push(format!(
            "lastWidth: expected={} actual={}",
            a.max_width, b.max_width
        ));
    }
    if a.paragraphs.len() != b.paragraphs.len() {
        parts.push(format!(
            "paragraphs: expected={} actual={}",
            a.paragraphs.len(),
            b.paragraphs.len()
        ));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("; "))
    }
}

/// 섹션 `PageDef` 비교 (#1388). 불일치 필드를 "field: expected=.. actual=.." 로 모아
/// 세미콜론으로 연결해 돌려준다. 일치하면 `None`.
///
/// 비교 제외 필드와 사유:
/// - `attr`: 비트 원본 — `binding`/`landscape` 와 의미 중복 (해석 필드 쪽을 비교)
/// - `pagination_bottom_tolerance`: 렌더러 내부 허용치 — 파일 포맷 필드 아님
fn diff_page_def(
    a: &crate::model::page::PageDef,
    b: &crate::model::page::PageDef,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    macro_rules! cmp_field {
        ($field:ident) => {
            if a.$field != b.$field {
                parts.push(format!(
                    "{}: expected={} actual={}",
                    stringify!($field),
                    a.$field,
                    b.$field
                ));
            }
        };
    }
    cmp_field!(width);
    cmp_field!(height);
    cmp_field!(margin_left);
    cmp_field!(margin_right);
    cmp_field!(margin_top);
    cmp_field!(margin_bottom);
    cmp_field!(margin_header);
    cmp_field!(margin_footer);
    cmp_field!(margin_gutter);
    cmp_field!(landscape);
    if a.binding != b.binding {
        parts.push(format!(
            "binding: expected={:?} actual={:?}",
            a.binding, b.binding
        ));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("; "))
    }
}

/// 섹션 `<hp:visibility>` 플래그 비교 (#1637) — secPr visibility 보존 게이트.
///
/// IR(SectionDef)에 보존되는 6필드만 비교한다(hideFirstPageNum·showLineNumber 는
/// 파서가 IR 에 적재하지 않으므로 제외). 직렬화기가 visibility 를 IR 로 방출하지 않으면
/// (특히 hide_empty_line) 페이지네이션이 달라지는 IR-invisible 결함을 게이트화한다.
fn diff_visibility(
    a: &crate::model::document::SectionDef,
    b: &crate::model::document::SectionDef,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    macro_rules! cmp_field {
        ($field:ident) => {
            if a.$field != b.$field {
                parts.push(format!(
                    "{}: expected={} actual={}",
                    stringify!($field),
                    a.$field,
                    b.$field
                ));
            }
        };
    }
    cmp_field!(hide_header);
    cmp_field!(hide_footer);
    cmp_field!(hide_master_page);
    cmp_field!(hide_border);
    cmp_field!(hide_fill);
    cmp_field!(hide_empty_line);
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("; "))
    }
}

/// 문단별 lineseg 비교 결과 1건 (Task #1380).
///
/// `diff_documents` 가 `IrDifference::ParagraphLinesegs` 로 변환해 게이트에 동승하고
/// (3단계), `hwpx-roundtrip` 배치 진단의 필드 단위 TSV 측정에도 직접 사용한다.
///
/// `path` 표기는 `IrDifference::ParagraphCharShapes` 와 동일
/// (본문 문단은 빈 문자열, 중첩 문단은 `/ctrl[i]tbl.cell[j].p[k]` 식).
#[derive(Debug, Clone)]
pub struct LinesegDiff {
    pub section: usize,
    pub paragraph: usize,
    pub path: String,
    pub kind: LinesegDiffKind,
}

/// lineseg 불일치 종류.
#[derive(Debug, Clone)]
pub enum LinesegDiffKind {
    /// 문단의 lineseg 개수 불일치.
    CountMismatch { expected: usize, actual: usize },
    /// 같은 인덱스 lineseg 의 필드 값 불일치. `field` 는 HWPX 속성명
    /// (textpos/vertpos/vertsize/textheight/baseline/spacing/horzpos/horzsize/flags).
    ValueMismatch {
        index: usize,
        field: &'static str,
        expected: i64,
        actual: i64,
    },
}

impl std::fmt::Display for LinesegDiffKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LinesegDiffKind::CountMismatch { expected, actual } => {
                write!(f, "count: expected={} actual={}", expected, actual)
            }
            LinesegDiffKind::ValueMismatch {
                index,
                field,
                expected,
                actual,
            } => write!(
                f,
                "[{}].{}: expected={} actual={}",
                index, field, expected, actual
            ),
        }
    }
}

/// 문서 전체의 문단별 `line_segs` 를 비교한다 (Task #1380).
///
/// 1단계에서는 측정 전용이었고, 3단계부터 `diff_documents` 가 이 결과를
/// `ParagraphLinesegs` 로 변환해 baseline 게이트에 동승한다.
/// 순회 경로는 `diff_paragraph_char_shapes` 와 동일 (본문 + 셀·글상자(Group 재귀)·
/// 각주/미주). 개수 불일치 시에도 공통 구간(min)은 값 비교를 계속한다.
pub fn diff_linesegs(a: &Document, b: &Document) -> Vec<LinesegDiff> {
    let mut out = Vec::new();
    let pairs = a.sections.len().min(b.sections.len());
    for i in 0..pairs {
        let pp = a.sections[i]
            .paragraphs
            .len()
            .min(b.sections[i].paragraphs.len());
        for j in 0..pp {
            diff_paragraph_linesegs(
                &mut out,
                i,
                j,
                "",
                &a.sections[i].paragraphs[j],
                &b.sections[i].paragraphs[j],
            );
        }
    }
    out
}

/// 문단 1쌍의 lineseg 비교 + 컨트롤 내부 문단 재귀 (`diff_paragraph_char_shapes` 와
/// 동일 경로 순회).
fn diff_paragraph_linesegs(
    out: &mut Vec<LinesegDiff>,
    section: usize,
    paragraph: usize,
    path: &str,
    pa: &crate::model::paragraph::Paragraph,
    pb: &crate::model::paragraph::Paragraph,
) {
    use crate::model::control::Control;

    let la = &pa.line_segs;
    let lb = &pb.line_segs;
    if la.len() != lb.len() {
        out.push(LinesegDiff {
            section,
            paragraph,
            path: path.to_string(),
            kind: LinesegDiffKind::CountMismatch {
                expected: la.len(),
                actual: lb.len(),
            },
        });
    }
    for (idx, (sa, sb)) in la.iter().zip(lb.iter()).enumerate() {
        let fields: [(&'static str, i64, i64); 9] = [
            ("textpos", sa.text_start as i64, sb.text_start as i64),
            ("vertpos", sa.vertical_pos as i64, sb.vertical_pos as i64),
            ("vertsize", sa.line_height as i64, sb.line_height as i64),
            ("textheight", sa.text_height as i64, sb.text_height as i64),
            (
                "baseline",
                sa.baseline_distance as i64,
                sb.baseline_distance as i64,
            ),
            ("spacing", sa.line_spacing as i64, sb.line_spacing as i64),
            ("horzpos", sa.column_start as i64, sb.column_start as i64),
            ("horzsize", sa.segment_width as i64, sb.segment_width as i64),
            ("flags", sa.tag as i64, sb.tag as i64),
        ];
        for (field, ea, eb) in fields {
            if ea != eb {
                out.push(LinesegDiff {
                    section,
                    paragraph,
                    path: path.to_string(),
                    kind: LinesegDiffKind::ValueMismatch {
                        index: idx,
                        field,
                        expected: ea,
                        actual: eb,
                    },
                });
            }
        }
    }

    for (ci, (ctrl_a, ctrl_b)) in pa.controls.iter().zip(pb.controls.iter()).enumerate() {
        match (ctrl_a, ctrl_b) {
            (Control::Table(ta), Control::Table(tb)) => {
                for (cell_i, (cea, ceb)) in ta.cells.iter().zip(tb.cells.iter()).enumerate() {
                    for (k, (qa, qb)) in
                        cea.paragraphs.iter().zip(ceb.paragraphs.iter()).enumerate()
                    {
                        let p = format!("{path}/ctrl[{ci}]tbl.cell[{cell_i}].p[{k}]");
                        diff_paragraph_linesegs(out, section, paragraph, &p, qa, qb);
                    }
                }
                // 표 캡션 내부 문단 lineseg 재귀 (#1387) — 존재/속성 비교는
                // diff_paragraph_char_shapes 쪽 한 곳에서 수행.
                if let (Some(ca), Some(cb)) = (&ta.caption, &tb.caption) {
                    for (k, (qa, qb)) in ca.paragraphs.iter().zip(cb.paragraphs.iter()).enumerate()
                    {
                        let p = format!("{path}/ctrl[{ci}]tbl.caption.p[{k}]");
                        diff_paragraph_linesegs(out, section, paragraph, &p, qa, qb);
                    }
                }
            }
            // 그림 캡션 내부 문단 lineseg 재귀 (#1403 후속 — char_shapes 쪽과 대칭 복원).
            (Control::Picture(pia), Control::Picture(pib)) => {
                if let (Some(ca), Some(cb)) = (&pia.caption, &pib.caption) {
                    for (k, (qa, qb)) in ca.paragraphs.iter().zip(cb.paragraphs.iter()).enumerate()
                    {
                        let p = format!("{path}/ctrl[{ci}]pic.caption.p[{k}]");
                        diff_paragraph_linesegs(out, section, paragraph, &p, qa, qb);
                    }
                }
            }
            (Control::Shape(sa), Control::Shape(sb)) => {
                let p = format!("{path}/ctrl[{ci}]shape");
                diff_shape_linesegs(out, section, paragraph, &p, sa, sb);
            }
            (Control::Footnote(na), Control::Footnote(nb)) => {
                for (k, (qa, qb)) in na.paragraphs.iter().zip(nb.paragraphs.iter()).enumerate() {
                    let p = format!("{path}/ctrl[{ci}]fn.p[{k}]");
                    diff_paragraph_linesegs(out, section, paragraph, &p, qa, qb);
                }
            }
            (Control::Endnote(na), Control::Endnote(nb)) => {
                for (k, (qa, qb)) in na.paragraphs.iter().zip(nb.paragraphs.iter()).enumerate() {
                    let p = format!("{path}/ctrl[{ci}]en.p[{k}]");
                    diff_paragraph_linesegs(out, section, paragraph, &p, qa, qb);
                }
            }
            (Control::Header(ha), Control::Header(hb)) => {
                for (k, (qa, qb)) in ha.paragraphs.iter().zip(hb.paragraphs.iter()).enumerate() {
                    let p = format!("{path}/ctrl[{ci}]header.p[{k}]");
                    diff_paragraph_linesegs(out, section, paragraph, &p, qa, qb);
                }
            }
            (Control::Footer(fa), Control::Footer(fb)) => {
                for (k, (qa, qb)) in fa.paragraphs.iter().zip(fb.paragraphs.iter()).enumerate() {
                    let p = format!("{path}/ctrl[{ci}]footer.p[{k}]");
                    diff_paragraph_linesegs(out, section, paragraph, &p, qa, qb);
                }
            }
            (Control::HiddenComment(ca), Control::HiddenComment(cb)) => {
                for (k, (qa, qb)) in ca.paragraphs.iter().zip(cb.paragraphs.iter()).enumerate() {
                    let p = format!("{path}/ctrl[{ci}]hidden.p[{k}]");
                    diff_paragraph_linesegs(out, section, paragraph, &p, qa, qb);
                }
            }
            // MEMO 본문 문단 lineseg 재귀 (#1391).
            (Control::Field(fa), Control::Field(fb)) => {
                for (k, (qa, qb)) in fa
                    .memo_paragraphs
                    .iter()
                    .zip(fb.memo_paragraphs.iter())
                    .enumerate()
                {
                    let p = format!("{path}/ctrl[{ci}]field.memo.p[{k}]");
                    diff_paragraph_linesegs(out, section, paragraph, &p, qa, qb);
                }
            }
            _ => {}
        }
    }
}

/// 도형 내부 글상자(TextBox) 문단 lineseg 재귀 비교 — Group 은 자식 도형까지 재귀.
fn diff_shape_linesegs(
    out: &mut Vec<LinesegDiff>,
    section: usize,
    paragraph: usize,
    path: &str,
    sa: &crate::model::shape::ShapeObject,
    sb: &crate::model::shape::ShapeObject,
) {
    use crate::model::shape::ShapeObject;
    if let (Some(ta), Some(tb)) = (shape_text_box(sa), shape_text_box(sb)) {
        for (k, (qa, qb)) in ta.paragraphs.iter().zip(tb.paragraphs.iter()).enumerate() {
            let p = format!("{path}.tb.p[{k}]");
            diff_paragraph_linesegs(out, section, paragraph, &p, qa, qb);
        }
    }
    // 도형/묶음 캡션 내부 문단 lineseg 재귀 (#1403 후속 — char_shapes 쪽과 대칭 복원).
    if let (Some(ca), Some(cb)) = (shape_caption(sa), shape_caption(sb)) {
        for (k, (qa, qb)) in ca.paragraphs.iter().zip(cb.paragraphs.iter()).enumerate() {
            let p = format!("{path}.caption.p[{k}]");
            diff_paragraph_linesegs(out, section, paragraph, &p, qa, qb);
        }
    }
    if let (ShapeObject::Group(ga), ShapeObject::Group(gb)) = (sa, sb) {
        for (k, (c1, c2)) in ga.children.iter().zip(gb.children.iter()).enumerate() {
            let p = format!("{path}.child[{k}]");
            diff_shape_linesegs(out, section, paragraph, &p, c1, c2);
        }
    }
}

/// 문단 char_shapes 시퀀스(#1378)와 인라인 슬롯 컨트롤 타입 시퀀스(#1379)를 비교하고,
/// 컨트롤 내부 문단(셀·글상자·각주/미주)을 재귀 비교한다.
///
/// 컨트롤 쌍의 재귀는 인덱스 대응(zip)으로만 내려간다 — 수·타입 불일치는
/// `ParagraphControls` 가 해당 문단 수준에서 검출한다.
fn diff_paragraph_char_shapes(
    diff: &mut IrDiff,
    section: usize,
    paragraph: usize,
    path: &str,
    pa: &crate::model::paragraph::Paragraph,
    pb: &crate::model::paragraph::Paragraph,
) {
    use crate::model::control::Control;

    let ca = &pa.char_shapes;
    let cb = &pb.char_shapes;
    let same = ca.len() == cb.len()
        && ca
            .iter()
            .zip(cb.iter())
            .all(|(x, y)| x.start_pos == y.start_pos && x.char_shape_id == y.char_shape_id);
    if !same {
        diff.push(IrDifference::ParagraphCharShapes {
            section,
            paragraph,
            path: path.to_string(),
            expected: format_char_shapes(ca),
            actual: format_char_shapes(cb),
        });
    }

    // 인라인 슬롯 컨트롤 타입 시퀀스 비교 (#1379) — subList 컨트롤 소실 검출.
    // Bookmark 등 위치 정보가 없는 비슬롯 컨트롤은 제외 (serializer 가 문단 선두로
    // 재배치하므로 순서 비교가 성립하지 않음).
    let sa: Vec<&Control> = pa
        .controls
        .iter()
        .filter(|c| is_hwpx_inline_slot(c))
        .collect();
    let sb: Vec<&Control> = pb
        .controls
        .iter()
        .filter(|c| is_hwpx_inline_slot(c))
        .collect();
    let ctrl_same = sa.len() == sb.len()
        && sa
            .iter()
            .zip(sb.iter())
            .all(|(x, y)| control_type_name(x) == control_type_name(y));
    if !ctrl_same {
        diff.push(IrDifference::ParagraphControls {
            section,
            paragraph,
            path: path.to_string(),
            expected: format_control_types(&sa),
            actual: format_control_types(&sb),
        });
    }
    for (ci, (ctrl_a, ctrl_b)) in pa.controls.iter().zip(pb.controls.iter()).enumerate() {
        match (ctrl_a, ctrl_b) {
            (Control::Table(ta), Control::Table(tb)) => {
                // 표 page_break 비교 (#1393) — 방출은 PR #1405 정정, 게이트 회귀 봉인.
                if ta.page_break != tb.page_break {
                    diff.push(IrDifference::TablePageBreak {
                        section,
                        paragraph,
                        path: format!("{path}/ctrl[{ci}]tbl"),
                        detail: format!("expected={:?} actual={:?}", ta.page_break, tb.page_break),
                    });
                }
                // [#1594] holdAnchorAndSO 보존 게이트 — 페이지 하단 앵커 개체 붕괴 봉인.
                if let Some(detail) = diff_hold_anchor(&ta.common, &tb.common) {
                    diff.push(IrDifference::ObjectHoldAnchor {
                        section,
                        paragraph,
                        path: format!("{path}/ctrl[{ci}]tbl"),
                        detail,
                    });
                }
                // [#1637] flowWithText 보존 게이트 — 표 partial-split 임계 변동 봉인.
                if let Some(detail) = diff_flow_with_text(&ta.common, &tb.common) {
                    diff.push(IrDifference::ObjectFlowWithText {
                        section,
                        paragraph,
                        path: format!("{path}/ctrl[{ci}]tbl"),
                        detail,
                    });
                }
                for (cell_i, (cea, ceb)) in ta.cells.iter().zip(tb.cells.iter()).enumerate() {
                    for (k, (qa, qb)) in
                        cea.paragraphs.iter().zip(ceb.paragraphs.iter()).enumerate()
                    {
                        let p = format!("{path}/ctrl[{ci}]tbl.cell[{cell_i}].p[{k}]");
                        diff_paragraph_char_shapes(diff, section, paragraph, &p, qa, qb);
                    }
                }
                // 표 캡션 비교 (#1387) — 존재/속성/문단 수 + 내부 문단 재귀.
                if let Some(detail) = diff_table_caption(&ta.caption, &tb.caption) {
                    diff.push(IrDifference::TableCaption {
                        section,
                        paragraph,
                        path: format!("{path}/ctrl[{ci}]tbl.caption"),
                        detail,
                    });
                }
                if let (Some(ca), Some(cb)) = (&ta.caption, &tb.caption) {
                    for (k, (qa, qb)) in ca.paragraphs.iter().zip(cb.paragraphs.iter()).enumerate()
                    {
                        let p = format!("{path}/ctrl[{ci}]tbl.caption.p[{k}]");
                        diff_paragraph_char_shapes(diff, section, paragraph, &p, qa, qb);
                    }
                }
            }
            // 그림 캡션 비교 (#1403) — 존재/속성/문단 수 + 내부 문단 재귀.
            (Control::Picture(pia), Control::Picture(pib)) => {
                // 그림 크기 요소 비교 (#1389) — curSz/imgRect/imgDim IR 보존 게이트.
                if let Some(detail) = diff_picture_size(pia, pib) {
                    diff.push(IrDifference::PictureSize {
                        section,
                        paragraph,
                        path: format!("{path}/ctrl[{ci}]pic"),
                        detail,
                    });
                }
                if let Some(detail) = diff_table_caption(&pia.caption, &pib.caption) {
                    diff.push(IrDifference::ObjectCaption {
                        section,
                        paragraph,
                        path: format!("{path}/ctrl[{ci}]pic.caption"),
                        detail,
                    });
                }
                // 그림 설명 비교 (#1392).
                if let Some(detail) =
                    diff_object_comment(&pia.common.description, &pib.common.description)
                {
                    diff.push(IrDifference::ObjectComment {
                        section,
                        paragraph,
                        path: format!("{path}/ctrl[{ci}]pic"),
                        detail,
                    });
                }
                // [#1594] holdAnchorAndSO 보존 게이트.
                if let Some(detail) = diff_hold_anchor(&pia.common, &pib.common) {
                    diff.push(IrDifference::ObjectHoldAnchor {
                        section,
                        paragraph,
                        path: format!("{path}/ctrl[{ci}]pic"),
                        detail,
                    });
                }
                if let (Some(ca), Some(cb)) = (&pia.caption, &pib.caption) {
                    for (k, (qa, qb)) in ca.paragraphs.iter().zip(cb.paragraphs.iter()).enumerate()
                    {
                        let p = format!("{path}/ctrl[{ci}]pic.caption.p[{k}]");
                        diff_paragraph_char_shapes(diff, section, paragraph, &p, qa, qb);
                    }
                }
            }
            // 수식 설명 비교 (#1392) — equation 은 본문 텍스트 비교 대상이 아니므로
            // description 만 동승.
            (Control::Equation(ea), Control::Equation(eb)) => {
                if let Some(detail) = diff_equation(ea, eb) {
                    diff.push(IrDifference::EquationContent {
                        section,
                        paragraph,
                        path: format!("{path}/ctrl[{ci}]eq"),
                        detail,
                    });
                }
                if let Some(detail) =
                    diff_object_comment(&ea.common.description, &eb.common.description)
                {
                    diff.push(IrDifference::ObjectComment {
                        section,
                        paragraph,
                        path: format!("{path}/ctrl[{ci}]eq"),
                        detail,
                    });
                }
                // [#1594] holdAnchorAndSO 보존 게이트.
                if let Some(detail) = diff_hold_anchor(&ea.common, &eb.common) {
                    diff.push(IrDifference::ObjectHoldAnchor {
                        section,
                        paragraph,
                        path: format!("{path}/ctrl[{ci}]eq"),
                        detail,
                    });
                }
                // [#1655] 수식 flowWithText 보존 게이트.
                if let Some(detail) = diff_flow_with_text(&ea.common, &eb.common) {
                    diff.push(IrDifference::ObjectFlowWithText {
                        section,
                        paragraph,
                        path: format!("{path}/ctrl[{ci}]eq"),
                        detail,
                    });
                }
            }
            (Control::Shape(sa), Control::Shape(sb)) => {
                let p = format!("{path}/ctrl[{ci}]shape");
                diff_shape_char_shapes(diff, section, paragraph, &p, sa, sb);
            }
            (Control::Footnote(na), Control::Footnote(nb)) => {
                for (k, (qa, qb)) in na.paragraphs.iter().zip(nb.paragraphs.iter()).enumerate() {
                    let p = format!("{path}/ctrl[{ci}]fn.p[{k}]");
                    diff_paragraph_char_shapes(diff, section, paragraph, &p, qa, qb);
                }
            }
            (Control::Endnote(na), Control::Endnote(nb)) => {
                for (k, (qa, qb)) in na.paragraphs.iter().zip(nb.paragraphs.iter()).enumerate() {
                    let p = format!("{path}/ctrl[{ci}]en.p[{k}]");
                    diff_paragraph_char_shapes(diff, section, paragraph, &p, qa, qb);
                }
            }
            (Control::Header(ha), Control::Header(hb)) => {
                for (k, (qa, qb)) in ha.paragraphs.iter().zip(hb.paragraphs.iter()).enumerate() {
                    let p = format!("{path}/ctrl[{ci}]header.p[{k}]");
                    diff_paragraph_char_shapes(diff, section, paragraph, &p, qa, qb);
                }
            }
            (Control::Footer(fa), Control::Footer(fb)) => {
                for (k, (qa, qb)) in fa.paragraphs.iter().zip(fb.paragraphs.iter()).enumerate() {
                    let p = format!("{path}/ctrl[{ci}]footer.p[{k}]");
                    diff_paragraph_char_shapes(diff, section, paragraph, &p, qa, qb);
                }
            }
            (Control::HiddenComment(ca), Control::HiddenComment(cb)) => {
                for (k, (qa, qb)) in ca.paragraphs.iter().zip(cb.paragraphs.iter()).enumerate() {
                    let p = format!("{path}/ctrl[{ci}]hidden.p[{k}]");
                    diff_paragraph_char_shapes(diff, section, paragraph, &p, qa, qb);
                }
            }
            // 필드 parameters / MEMO 본문 비교 (#1391).
            (Control::Field(fa), Control::Field(fb)) => {
                if fa.raw_parameters_xml != fb.raw_parameters_xml {
                    diff.push(IrDifference::FieldContent {
                        section,
                        paragraph,
                        path: format!("{path}/ctrl[{ci}]field"),
                        detail: format!(
                            "parameters: expected={:?} actual={:?}",
                            fa.raw_parameters_xml, fb.raw_parameters_xml
                        ),
                    });
                }
                if fa.memo_paragraphs.len() != fb.memo_paragraphs.len() {
                    diff.push(IrDifference::FieldContent {
                        section,
                        paragraph,
                        path: format!("{path}/ctrl[{ci}]field"),
                        detail: format!(
                            "memo paragraphs: expected={} actual={}",
                            fa.memo_paragraphs.len(),
                            fb.memo_paragraphs.len()
                        ),
                    });
                }
                for (k, (qa, qb)) in fa
                    .memo_paragraphs
                    .iter()
                    .zip(fb.memo_paragraphs.iter())
                    .enumerate()
                {
                    let p = format!("{path}/ctrl[{ci}]field.memo.p[{k}]");
                    diff_paragraph_char_shapes(diff, section, paragraph, &p, qa, qb);
                }
            }
            _ => {}
        }
    }
}

/// 도형 내부 글상자(TextBox) 문단 재귀 비교 — Group 은 자식 도형까지 재귀.
fn diff_shape_char_shapes(
    diff: &mut IrDiff,
    section: usize,
    paragraph: usize,
    path: &str,
    sa: &crate::model::shape::ShapeObject,
    sb: &crate::model::shape::ShapeObject,
) {
    use crate::model::shape::ShapeObject;
    if let (Some(ta), Some(tb)) = (shape_text_box(sa), shape_text_box(sb)) {
        for (k, (qa, qb)) in ta.paragraphs.iter().zip(tb.paragraphs.iter()).enumerate() {
            let p = format!("{path}.tb.p[{k}]");
            diff_paragraph_char_shapes(diff, section, paragraph, &p, qa, qb);
        }
    }
    // 도형/묶음 캡션 비교 (#1403) — 존재/속성/문단 수 + 내부 문단 재귀.
    let (capa, capb) = (shape_caption(sa), shape_caption(sb));
    if let Some(detail) = diff_table_caption(capa, capb) {
        diff.push(IrDifference::ObjectCaption {
            section,
            paragraph,
            path: format!("{path}.caption"),
            detail,
        });
    }
    if let (Some(ca), Some(cb)) = (capa, capb) {
        for (k, (qa, qb)) in ca.paragraphs.iter().zip(cb.paragraphs.iter()).enumerate() {
            let p = format!("{path}.caption.p[{k}]");
            diff_paragraph_char_shapes(diff, section, paragraph, &p, qa, qb);
        }
    }
    // 도형/묶음 설명 비교 (#1392).
    if let Some(detail) =
        diff_object_comment(&shape_common(sa).description, &shape_common(sb).description)
    {
        diff.push(IrDifference::ObjectComment {
            section,
            paragraph,
            path: path.to_string(),
            detail,
        });
    }
    if let (ShapeObject::Group(ga), ShapeObject::Group(gb)) = (sa, sb) {
        for (k, (c1, c2)) in ga.children.iter().zip(gb.children.iter()).enumerate() {
            let p = format!("{path}.child[{k}]");
            diff_shape_char_shapes(diff, section, paragraph, &p, c1, c2);
        }
    }
}

/// ShapeObject 에서 `CommonObjAttr` 참조를 꺼낸다 (#1392 — description 비교용).
fn shape_common(s: &crate::model::shape::ShapeObject) -> &crate::model::shape::CommonObjAttr {
    use crate::model::shape::ShapeObject::*;
    match s {
        Line(x) => &x.common,
        Rectangle(x) => &x.common,
        Ellipse(x) => &x.common,
        Arc(x) => &x.common,
        Polygon(x) => &x.common,
        Curve(x) => &x.common,
        Chart(x) => &x.common,
        Ole(x) => &x.common,
        Group(x) => &x.common,
        Picture(x) => &x.common,
    }
}

/// ShapeObject 에서 글상자(TextBox) 참조를 꺼낸다 (없으면 None).
fn shape_text_box(s: &crate::model::shape::ShapeObject) -> Option<&crate::model::shape::TextBox> {
    use crate::model::shape::ShapeObject::*;
    match s {
        Line(x) => x.drawing.text_box.as_ref(),
        Rectangle(x) => x.drawing.text_box.as_ref(),
        Ellipse(x) => x.drawing.text_box.as_ref(),
        Arc(x) => x.drawing.text_box.as_ref(),
        Polygon(x) => x.drawing.text_box.as_ref(),
        Curve(x) => x.drawing.text_box.as_ref(),
        Chart(x) => x.drawing.text_box.as_ref(),
        Ole(x) => x.drawing.text_box.as_ref(),
        Group(_) | Picture(_) => None,
    }
}

/// ShapeObject 에서 캡션 필드 참조를 꺼낸다 (#1403).
/// 그리기 도형은 `drawing.caption`, 묶음/그림/차트/OLE 는 각자의 caption 필드.
fn shape_caption(s: &crate::model::shape::ShapeObject) -> &Option<crate::model::shape::Caption> {
    use crate::model::shape::ShapeObject::*;
    match s {
        Line(x) => &x.drawing.caption,
        Rectangle(x) => &x.drawing.caption,
        Ellipse(x) => &x.drawing.caption,
        Arc(x) => &x.drawing.caption,
        Polygon(x) => &x.drawing.caption,
        Curve(x) => &x.drawing.caption,
        Chart(x) => &x.caption,
        Ole(x) => &x.caption,
        Group(x) => &x.caption,
        Picture(x) => &x.caption,
    }
}

/// 컨트롤 타입 표기 — diff 메시지·시퀀스 비교용 (`render_control_slot` 디스패치 대상).
fn control_type_name(c: &crate::model::control::Control) -> &'static str {
    use crate::model::control::Control::*;
    match c {
        Table(_) => "tbl",
        Picture(_) => "pic",
        Shape(_) => "shape",
        Equation(_) => "eq",
        Footnote(_) => "fn",
        Endnote(_) => "en",
        Field(_) => "field",
        Form(_) => "form",
        Header(_) => "header",
        Footer(_) => "footer",
        AutoNumber(_) => "autoNum",
        PageHide(_) => "pageHide",
        PageNumberPos(_) => "pageNumPos",
        NewNumber(_) => "newNum",
        CharOverlap(_) => "charOverlap",
        Ruby(_) => "ruby",
        _ => "other",
    }
}

/// 컨트롤 타입 시퀀스를 `[tbl,pic, ...]` 형태로 표기 (diff 메시지용).
fn format_control_types(controls: &[&crate::model::control::Control]) -> String {
    let inner = controls
        .iter()
        .map(|c| control_type_name(c))
        .collect::<Vec<_>>()
        .join(",");
    format!("[{}]", inner)
}

/// char_shapes 시퀀스를 `[(start_pos,id), ...]` 형태로 표기 (diff 메시지용).
fn format_char_shapes(refs: &[crate::model::paragraph::CharShapeRef]) -> String {
    let inner = refs
        .iter()
        .map(|r| format!("({},{})", r.start_pos, r.char_shape_id))
        .collect::<Vec<_>>()
        .join(",");
    format!("[{}]", inner)
}


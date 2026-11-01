//! 수식 레이아웃 엔진
//!
//! AST(EqNode)를 레이아웃 박스(LayoutBox)로 변환하여
//! 각 요소의 크기와 위치를 계산한다.

use super::ast::*;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen::prelude::wasm_bindgen(catch, js_namespace = globalThis, js_name = measureEquationTextMetrics)]
    fn measure_equation_text(
        source: &str,
        text: &str,
        size: f64,
        italic: bool,
        hft: bool,
        literal: bool,
        bold: bool,
    ) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue>;
}

/// 수식 레이아웃 박스
#[derive(Debug, Clone, serde::Serialize)]
pub struct LayoutBox {
    /// 원본 현대 HY 메트릭으로 계산한 글자별 advance. None은 기존 fallback 배치다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub glyph_advances: Option<Vec<f64>>,
    /// X 위치 (부모 기준 상대 좌표)
    pub x: f64,
    /// Y 위치 (부모 기준 상대 좌표)
    pub y: f64,
    /// 폭
    pub width: f64,
    /// 높이
    pub height: f64,
    /// 기준선 (상단으로부터의 거리, 텍스트 정렬의 기준)
    pub baseline: f64,
    /// 렌더링 요소
    pub kind: LayoutKind,
}

impl LayoutBox {
    pub(crate) fn positioned_glyphs(&self) -> Option<Vec<LayoutBox>> {
        let advances = self.glyph_advances.as_ref()?;
        let text = match &self.kind {
            LayoutKind::Text(s)
            | LayoutKind::Number(s)
            | LayoutKind::Symbol(s)
            | LayoutKind::MathSymbol(s)
            | LayoutKind::Function(s) => s,
            _ => return None,
        };
        if text.chars().count() != advances.len()
            || advances
                .iter()
                .any(|advance| !advance.is_finite() || *advance < 0.0)
        {
            return None;
        }
        let mut x = 0.0;
        Some(
            text.chars()
                .zip(advances)
                .map(|(ch, advance)| {
                    let kind = match &self.kind {
                        LayoutKind::Text(_) => LayoutKind::Text(ch.to_string()),
                        LayoutKind::Number(_) => LayoutKind::Number(ch.to_string()),
                        LayoutKind::Function(_) => LayoutKind::Function(ch.to_string()),
                        _ => LayoutKind::MathSymbol(ch.to_string()),
                    };
                    let glyph = LayoutBox {
                        glyph_advances: None,
                        x,
                        y: 0.0,
                        width: *advance,
                        height: self.height,
                        baseline: self.baseline,
                        kind,
                    };
                    x += advance;
                    glyph
                })
                .collect(),
        )
    }
}

/// 레이아웃 요소 종류
#[derive(Debug, Clone, serde::Serialize)]
pub enum LayoutKind {
    /// 수평 나열
    Row(Vec<LayoutBox>),
    /// 일반 텍스트 (이탤릭)
    Text(String),
    /// 숫자
    Number(String),
    /// 기호
    Symbol(String),
    /// 수학 기호 (Unicode)
    MathSymbol(String),
    /// 함수 이름 (로만체)
    Function(String),
    /// 분수
    Fraction {
        numer: Box<LayoutBox>,
        denom: Box<LayoutBox>,
        /// 분수 개체의 왼쪽/오른쪽 경계에서 선까지의 거리.
        bar_inset: f64,
    },
    /// 위아래 배치 (분수선 없음)
    Atop {
        top: Box<LayoutBox>,
        bottom: Box<LayoutBox>,
    },
    /// 제곱근
    Sqrt {
        index: Option<Box<LayoutBox>>,
        body: Box<LayoutBox>,
    },
    /// 위첨자
    Superscript {
        base: Box<LayoutBox>,
        sup: Box<LayoutBox>,
    },
    /// 아래첨자
    Subscript {
        base: Box<LayoutBox>,
        sub: Box<LayoutBox>,
    },
    /// 위·아래첨자
    SubSup {
        base: Box<LayoutBox>,
        sub: Box<LayoutBox>,
        sup: Box<LayoutBox>,
    },
    /// 큰 연산자
    BigOp {
        symbol: String,
        sub: Option<Box<LayoutBox>>,
        sup: Option<Box<LayoutBox>>,
    },
    /// 극한
    Limit {
        is_upper: bool,
        sub: Option<Box<LayoutBox>>,
        /// 이름의 조판 원점. 구형 서체에서는 두 값 모두 0이다.
        name_x: f64,
        name_y: f64,
    },
    /// 행렬
    Matrix {
        cells: Vec<Vec<LayoutBox>>,
        style: MatrixStyle,
    },
    /// 관계식 (REL/BUILDREL) — 화살표 위/아래 내용
    Rel {
        arrow: Box<LayoutBox>,
        over: Box<LayoutBox>,
        under: Option<Box<LayoutBox>>,
    },
    /// 칸 맞춤 정렬 (EQALIGN)
    EqAlign {
        rows: Vec<(LayoutBox, LayoutBox)>, // (왼쪽, 오른쪽) 쌍
    },
    /// 괄호
    Paren {
        left: String,
        right: String,
        body: Box<LayoutBox>,
        /// 현대 HY 괄호의 페인트 상단/높이. 논리 상자 및 HFT 배치는 유지한다.
        #[serde(skip_serializing_if = "Option::is_none")]
        modern_extent: Option<(f64, f64)>,
    },
    /// 장식
    Decoration {
        kind: super::symbols::DecoKind,
        body: Box<LayoutBox>,
    },
    /// 글꼴 스타일
    FontStyle {
        style: super::symbols::FontStyleKind,
        body: Box<LayoutBox>,
    },
    /// 공백
    Space(f64),
    /// 줄바꿈 (세로 쌓기용 마커)
    Newline,
    /// 빈 박스
    Empty,
}

/// 수식 레이아웃 계산기
#[derive(Clone)]
pub struct EqLayout {
    /// 기본 글꼴 크기 (px)
    pub font_size: f64,
    font_family: Option<String>,
    hft: bool,
    italic: bool,
    bold: bool,
    /// 원자 사이 수식 간격(thin/medium/thick)의 배율. 저장 개체 폭에 맞출 때만 줄인다.
    operator_padding_scale: f64,
    /// 수식 기본 크기(pt). 문서 경로에서만 설정된다 — 한컴이 10pt 미만 버전60
    /// 수식을 현대 조판하지 않는 경계를 가린다. 미설정이면 크기 판정을 건너뛴다.
    eq_base_pt: Option<f64>,
    /// Measure the occupied box of a vector in drawText without changing paint layout.
    draw_text_vector_occupancy: bool,
}

/// 비율 상수
pub(crate) const SCRIPT_SCALE: f64 = 0.7; // 첨자 크기 비율
pub(crate) const FRAC_LINE_PAD: f64 = 0.2; // 분수선 상하 여백 (font_size 비율)
const FRAC_LINE_THICK: f64 = 0.04; // 분수선 두께 (font_size 비율)
const SQRT_PAD: f64 = 0.1; // 제곱근 내부 상단 여백
const PAREN_PAD: f64 = 0.08; // 괄호 내부 좌우 여백
pub(crate) const BIG_OP_SCALE: f64 = 1.5; // 큰 연산자(∑/∏) 크기 비율
/// Hancom 2022 PDF: HYhwpEQ U+E067 is 16.26 pt for a 9.06 pt equation.
pub(crate) const MODERN_HY_SUM_SCALE: f64 = 1.8;
/// U+E067 has 739 units of advance in the 1024-unit HYhwpEQ font.
pub(crate) const MODERN_HY_SUM_ADVANCE_EM: f64 = 739.0 / 1024.0;
// 현대 Σ의 limit stack 폭은 다음 피연산자의 원점까지다. 별도 tail은 없다.
pub(crate) const MODERN_HY_SUM_TRAIL_PAD: f64 = 0.0;
pub(crate) const MODERN_HY_SUM_BASELINE: f64 = 0.74;
/// 적분(∫/∮ 등) 전용 크기 비율 — Task #1313.
/// 적분 글리프는 ∑/∏ 보다 세로로 길게 그려져야 정답(한글 2022)과 정합한다. BIG_OP_SCALE
/// (1.5) 로는 글리프가 작아 상·하한이 기호와 벌어져 보이므로 적분만 별도 스케일을 쓴다.
pub(crate) const INTEGRAL_SCALE: f64 = 2.5;

/// HYhwpEQ 근호 부품의 세로 크기와 기준선. 좌표는 근호 상자 기준이다.
#[derive(Clone, Copy, Debug)]
pub(crate) struct SqrtPuaGeometry {
    pub sign_size: f64,
    pub sign_baseline: f64,
    pub bar_size: f64,
    pub bar_baseline: f64,
    pub bar_advance: f64,
}

pub(crate) fn sqrt_pua_geometry(
    body: &LayoutBox,
    baseline: f64,
    root_width: f64,
    fs: f64,
    modern: bool,
) -> SqrtPuaGeometry {
    if modern {
        // 한컴 버전60: 윗줄의 두께는 본문 em을 유지하고 근호만 본문 높이에 맞춘다.
        // HYhwpEQ의 UPEM=1024, e05c/e06d 글리프 상단은 각각 821/639다.
        let top = body.y - fs * 0.10;
        let sign_size = body.height + fs * 0.1;
        SqrtPuaGeometry {
            sign_size,
            sign_baseline: top + sign_size * (821.0 / 1024.0),
            bar_size: fs,
            bar_baseline: top + fs * (639.0 / 1024.0),
            // The bar follows the root's measured clearance, including italic
            // ink reach or script-digit hinting. Its far edge overhangs the
            // layout box by 0.02em regardless of the radicand.
            bar_advance: root_width - body.x + fs * SQRT_PAD * 0.5,
        }
    } else {
        SqrtPuaGeometry {
            sign_size: fs * 0.682 + body.height * 0.37,
            sign_baseline: baseline,
            bar_size: body.height * 1.11,
            bar_baseline: body.y + body.height * 0.694,
            bar_advance: body.width + fs * 0.17,
        }
    }
}

/// 적분 글리프 path 기하 — Task #1317.
///
/// 적분기호(∫)의 stroke path 와 상·하한 attach point 가 공유하는 기준.
/// 현대 HY fallback path 의 상단만 `integral_fallback_top_y` 에서 잉크 높이에
/// 맞춰 조정하며, 레이아웃 기준은 유지한다.
///
/// 모든 좌표는 글리프 박스(좌상단 원점, 높이 = `fs*INTEGRAL_SCALE`) 기준 상대 px 이며,
/// y 는 아래로 증가한다. 비율은 정답(한글 2022) `pdf/3-10월_교육_통합_2022.pdf` 9p 적분
/// (`∫_0^2(-2x^2+6x)dx`) 시각 정합 기준.
#[derive(Clone, Copy, Debug)]
pub(crate) struct IntegralGeom {
    /// 글리프 가로 폭(상·하 갈고리 포함, trailing pad 제외)
    pub width: f64,
    /// 줄기 stroke 두께
    pub stroke_w: f64,
    /// 레이아웃 기준 상단 갈고리 y
    pub top_y: f64,
    /// path 하단(하단 갈고리 끝) y
    pub bottom_y: f64,
    /// 상단 갈고리 우측 끝 x — 상한(sup) attach 기준
    pub top_hook_x: f64,
    /// 하단 갈고리 좌측 끝 x — 하한(sub) attach 기준
    pub bottom_hook_x: f64,
}

/// 글꼴 크기 `fs` 에 대한 적분 글리프 기하를 산출한다(SSOT).
pub(crate) fn integral_geom(fs: f64) -> IntegralGeom {
    let h = fs * INTEGRAL_SCALE;
    IntegralGeom {
        width: fs * 0.52,
        stroke_w: fs * 0.06,
        top_y: h * 0.04,
        bottom_y: h * 0.96,
        top_hook_x: fs * 0.50,
        bottom_hook_x: fs * 0.04,
    }
}

/// Fallback stroke ink keeps the layout's lower hook but matches the 2em
/// painted height of a modern HY integral. Legacy stroke geometry is unchanged.
pub(crate) fn integral_fallback_top_y(g: IntegralGeom, fs: f64, modern_hy: bool) -> f64 {
    if modern_hy {
        g.bottom_y - fs * 2.0
    } else {
        g.top_y
    }
}

/// 큰 연산자(Σ/∏/∫) 뒤 피연산자와의 trailing 간격 (font_size 비율) — Task #1233.
/// layout_row 는 형제를 간격 0으로 붙이므로, 큰 연산자 box width 에 이 trailing 공백을
/// 더해 피연산자가 연산자에 붙지 않게 한다(TeX thin/med space 관례, 한컴 PDF 정합).
///
/// 인라인 수식은 svg.rs 에서 컨트롤 advance(tac_w)로 가로 스케일(scale_x = tac_w/자연폭)
/// 되므로, 자연폭에 더한 pad 는 scale_x 만큼 줄어 렌더된다. 분수·괄호를 포함한 큰 수식은
/// scale_x 가 작아(0.6~0.9) pad 가 약화되므로, 압축 후에도 충분한 간격이 남도록 0.45 로
/// 둔다(작업지시자 시각 판정 — 0.25 는 부족, 0.45 가 적정).
///
/// 렌더러(svg_render/canvas_render)는 limits 연산자를 `max_w = lb.width - fs*PAD` 에
/// 중앙정렬하므로(이 const 참조), pad 전체가 **순수 trailing** 이 되고 연산자는 첨자와 정렬된다.
pub(crate) const BIG_OP_TRAIL_PAD: f64 = 0.45;
const MODERN_DECO_SIDE_EM: f64 = 0.055;
const MATRIX_COL_GAP: f64 = 0.8; // 행렬 열 간격 (font_size 비율)
const MATRIX_ROW_GAP: f64 = 0.3; // 행렬 행 간격 (font_size 비율)
/// 수식 축 높이 (TeX axis_height = 0.25em) — 분수선이 배치되는 기준 위치
pub(crate) const AXIS_HEIGHT: f64 = 0.25;
/// 현대 HY cases/eqalign 줄 간격(em) — 한컴 probe 11pt 13.0pt, math-001 12.9pt.
pub(crate) const MODERN_CASES_LINE_EM: f64 = 1.17;
/// 현대 HY cases 첫 열 구분자 간격(em) — probe `5x+a & x<-2` 2.12pt@11.
pub(crate) const MODERN_CASES_COL_GAP_EM: f64 = 0.19;
/// 같은 열 구분자에서 반복된 `&` 하나당 추가 간격(em).
/// 한컴 6/9/12pt `a&&&condition` 대조군에서 약 0.7em씩 증가한다.
const MODERN_CASES_EXTRA_AMP_EM: f64 = 0.70;
/// 현대 HY cases 에서 키 큰 행(분수 등)이 앞 행 잉크 아래로 띄우는 최소 간격(em).
pub(crate) const MODERN_CASES_ROW_GAP_EM: f64 = 0.15;
/// 현대 HY lim 이름 크기 배율 — painter는 Limit 기준선(0.8×이름 크기)에서 되돌려 쓴다.
pub(crate) const LIMIT_NAME_SCALE: f64 = 1.2;
/// 현대 HY 둥근 괄호 묶음의 괄호 폭(em).
pub(crate) const MODERN_ROUND_PAREN_EM: f64 = 0.333;
/// 현대 HY LEFT/RIGHT 절댓값 막대의 칸 폭. 높이와 무관하게 0.5em을 유지한다.
const MODERN_ABSOLUTE_BAR_EM: f64 = 0.5;
/// 현대 HY 중괄호 폭(em) — LEFT{ RIGHT} 와 cases 공통.
pub(crate) const MODERN_BRACE_EM: f64 = 0.48;
/// HY's square-bracket cell keeps an allowance beyond each actual glyph
/// advance, then a thin gap between the cell and its contents.
const MODERN_SHORT_SQUARE_ALLOWANCE_EM: f64 = 0.10;
pub(crate) const MODERN_SHORT_SQUARE_PAD_EM: f64 = 0.125;
/// 텍스트 기본 baseline 비율 (상단에서 baseline까지)
const TEXT_BASELINE: f64 = 0.8;

/// 분수선은 분자의 em box와 padding 뒤에 둔다. 버전별 baseline/axis와 분리한다.
pub(crate) fn fraction_line_y(numerator: &LayoutBox, font_size: f64) -> f64 {
    numerator.height + font_size * (FRAC_LINE_PAD + FRAC_LINE_THICK / 2.0)
}

impl EqLayout {
    pub fn new(font_size: f64) -> Self {
        Self {
            font_size,
            font_family: None,
            hft: false,
            italic: true,
            bold: false,
            operator_padding_scale: 1.0,
            eq_base_pt: None,
            draw_text_vector_occupancy: false,
        }
    }

    pub fn with_font(font_size: f64, font_family: &str) -> Self {
        Self {
            font_size,
            font_family: (!font_family.trim().is_empty()).then(|| font_family.to_string()),
            hft: false,
            italic: true,
            bold: false,
            operator_padding_scale: 1.0,
            eq_base_pt: None,
            draw_text_vector_occupancy: false,
        }
    }

    pub fn with_version(mut self, version: &str) -> Self {
        self.hft = version.is_empty()
            && self
                .font_family
                .as_deref()
                .is_some_and(super::font::is_legacy_equation_font);
        self
    }

    pub(crate) fn for_draw_text_vector_occupancy(mut self) -> Self {
        self.draw_text_vector_occupancy = true;
        self
    }

    /// 측정기의 현대 advance 적용 여부. 비legacy 서체는 크기와 무관하게 현대
    /// 모델을 유지하고, HYhwpEQ 계열은 위의 pt 경계를 따른다.
    fn modern_run_metrics(&self) -> bool {
        !self.hft
            && (self.is_modern_hy()
                || !self
                    .font_family
                    .as_deref()
                    .is_some_and(super::font::is_legacy_equation_font))
    }

    /// 수식 기본 크기를 pt로 알려 준다. dpi-확장된 px(font_size)로는 서로 다른
    /// 렌더 해상도에서 같은 판정이 어긋나므로 문서 쪽 호출자가 HWPUNIT을 넘긴다.
    pub fn with_base_pt(mut self, pt: f64) -> Self {
        self.eq_base_pt = (pt.is_finite() && pt > 0.0).then_some(pt);
        self
    }

    fn is_modern_hy(&self) -> bool {
        // 한컴(macOS)은 버전60 수식을 크기와 무관하게 현대 조판한다 (probe 9pt:
        // `1`→`2` 4.08pt = 현대 advance, `a=b` 관계 간격 0.21em). 10pt 미만 legacy
        // 간격(eq-002)은 Windows 출력 기준이었다.
        !self.hft
            && self
                .font_family
                .as_deref()
                .is_some_and(super::font::is_legacy_equation_font)
    }

    /// 원본 수식 서체(HYhwpEQ)의 실측 메트릭으로 배치하는지 — 이때만 자연 폭이
    /// 한컴이 다시 계산한 개체 폭과 같다. HFT 은행과 fallback 서체는 추정이다.
    pub(crate) fn has_source_face_metrics(&self) -> bool {
        !self.hft
            && self
                .font_family
                .as_deref()
                .is_some_and(super::font::is_legacy_equation_font)
            && self
                .node_advance_right(&EqNode::Number("0".into()), self.font_size)
                .is_some()
    }

    fn has_modern_hy_metrics(&self, fs: f64) -> bool {
        self.is_modern_hy()
            && self
                .node_advance_right(&EqNode::Number("0".into()), fs)
                .is_some()
    }

    fn source_roman_pi_glyph<'a>(&self, text: &'a str, italic: bool) -> &'a str {
        if self.is_modern_hy()
            && !italic
            && text == "π"
            && self.has_source_face_metrics()
            && super::font::registered_char_advance_em("HYhwpEQ", '\u{e0ac}').is_some()
        {
            "\u{e0ac}"
        } else {
            text
        }
    }

    fn leading_font_declaration(node: &EqNode) -> bool {
        match node {
            EqNode::FontDeclaration { .. } => true,
            EqNode::FontStyle { body, .. } | EqNode::Color { body, .. } => {
                Self::leading_font_declaration(body)
            }
            _ => false,
        }
    }

    fn is_bar_decoration(node: &EqNode) -> bool {
        match node {
            EqNode::Decoration {
                kind: super::symbols::DecoKind::Bar,
                ..
            } => true,
            EqNode::FontStyle { body, .. }
            | EqNode::FontDeclaration { body, .. }
            | EqNode::Color { body, .. } => Self::is_bar_decoration(body),
            _ => false,
        }
    }

    /// 현대 HY 원자 간격(em) — 한컴 Mac probe 실측(11pt/9pt).
    ///
    /// 간격은 앞 원자의 뒤 간격과 뒤 원자의 앞 간격의 합이다 (`=` 뒤 `` ` ``-: 0.21+0.14).
    /// 관계 0.21, 이항 0.14, 구두점 뒤·닫는 기호 앞·글자 뒤 여는 기호 앞 0.07.
    /// 연산자의 앞 간격은 바로 앞이 글자·공백일 때만 붙는다 — 괄호 묶음·분수·근호·
    /// 장식 같은 복합 상자 바로 뒤에서는 연산자가 상자 끝에 붙는다
    /// (`LEFT(x RIGHT)=`, `{1} over {2}+`, `sqrt{5} times`, `bar a<`).
    fn modern_atom_space_em(
        prev_node: &EqNode,
        prev: Atom,
        next_node: &EqNode,
        next: Atom,
        glue: bool,
    ) -> f64 {
        let declaration = Self::leading_font_declaration(next_node);
        fn unstyled(mut node: &EqNode) -> &EqNode {
            while let EqNode::FontStyle { body, .. }
            | EqNode::FontDeclaration { body, .. }
            | EqNode::Color { body, .. } = node
            {
                node = body;
            }
            node
        }
        // `rm PP' =` keeps the prime in the Roman run and joins it directly
        // to `=`. In `boldrmFPP'  =`, the prime is a separate bare symbol and
        // Hancom retains the relation gap. Keep that run boundary before
        // stripping styles for the remaining atom rules.
        let roman_prime = matches!(
            prev_node,
            EqNode::FontStyle {
                style: super::symbols::FontStyleKind::Roman,
                body,
            } | EqNode::FontDeclaration {
                style: super::symbols::FontStyleKind::Roman,
                body,
            } if matches!(body.as_ref(), EqNode::Symbol(s) | EqNode::MathSymbol(s) if matches!(s.as_str(), "'" | "′" | "″"))
        );
        let prev_node = unstyled(prev_node);
        let next_node = unstyled(next_node);
        let barred_subscript = matches!(prev_node, EqNode::Subscript { base, .. }
            if Self::is_bar_decoration(base));
        if Self::is_postfix_sign(prev_node, prev) {
            return 0.0;
        }
        let next = if Self::is_postfix_sign(next_node, next) {
            Atom::of(MathClass::Bin)
        } else {
            next
        };
        fn symbol(node: &EqNode) -> Option<&str> {
            match node {
                EqNode::Symbol(s) | EqNode::MathSymbol(s) => Some(s.as_str()),
                _ => None,
            }
        }
        // HY's NEQ/!=, SIM and SIMEQ use its binary spacing class (kind 3),
        // while LEQ/GEQ retain relation class 4. Keep this source-font
        // distinction out of the shared TeX atom classifier.
        let prev = if matches!(symbol(prev_node), Some("≠" | "∼" | "≃")) {
            Atom::of(MathClass::Bin)
        } else {
            prev
        };
        // HY TIMES는 TeX 행 끝 규칙으로 postfix가 되어도 원본 kind 3의 앞 간격을
        // 유지한다. 앞 피연산자가 없는 단항 분류는 그대로 둔다.
        let next = if matches!(symbol(next_node), Some("≠" | "∼" | "≃"))
            || (next.postfix && symbol(next_node) == Some("×"))
        {
            Atom::of(MathClass::Bin)
        } else {
            next
        };
        fn starts_with_glyph(node: &EqNode) -> bool {
            match unstyled(node) {
                EqNode::Row(children) => children.first().is_some_and(starts_with_glyph),
                EqNode::Symbol(_) | EqNode::MathSymbol(_) => true,
                _ => false,
            }
        }
        // Roman run 안의 prime은 뒤 관계 연산자에 붙는다 (`rm PP'=`).
        // 별도 bare prime이나 명시 공백은 관계식 앞 간격을 유지한다.
        if !glue && roman_prime && next.left == MathClass::Rel {
            return 0.0;
        }
        // A postfix prime is part of the preceding operand, so the ordinary
        // binary gap before the next sign would count its side bearing twice.
        if matches!(symbol(prev_node), Some("'" | "′" | "″")) && next.left == MathClass::Bin {
            return 0.0;
        }
        // ⋅의 1em 글립 자체에 좌우 여백이 있으므로 중복 이항 간격을 넣지 않는다.
        if symbol(prev_node) == Some("⋅") || symbol(next_node) == Some("⋅") {
            return 0.0;
        }
        // HY's right arrow carries its own side bearings. Hancom's
        // `X->X` and `X``->``X` differ only by the explicit backtick spaces.
        if symbol(prev_node) == Some("→") || symbol(next_node) == Some("→") {
            return 0.0;
        }
        // A relation immediately before the opening sequence ellipsis uses
        // the ellipsis' own left bearing in place of another relation gap.
        if symbol(prev_node) == Some("=") && symbol(next_node) == Some("⋯") {
            return 0.0;
        }
        // A comma followed by an explicit thin space and a closing ellipsis
        // keeps the same relation-sized separation as Hancom's list tail.
        if glue && symbol(prev_node) == Some(",") && symbol(next_node) == Some("⋯") {
            return 0.28;
        }
        // 합집합·교집합 글립은 자체 좌우 여백을 포함한다.
        // 6/9/12pt Hancom probe에서 양쪽 .14em을 더하면 피연산자가 벌어진다.
        if matches!(symbol(prev_node), Some("∪" | "∩"))
            || matches!(symbol(next_node), Some("∪" | "∩"))
        {
            return 0.0;
        }
        let unary = |node: &EqNode, atom: Atom| {
            atom.left == MathClass::Ord
                && symbol(node).is_some_and(|s| symbol_class(s) == MathClass::Bin)
        };
        // 단일 소문자 피제곱근 뒤의 여백은 다음 원자의 종류와 무관하다.
        // 9pt Hancom probe: sqrt{x}의 x→d/2/+/=는 모두 약 6.24pt다.
        let trailing: f64 = if matches!(prev_node, EqNode::Sqrt { body, .. }
            if matches!(body.as_ref(), EqNode::Text(text)
                if text.len() == 1 && text.bytes().all(|ch| ch.is_ascii_lowercase())))
        {
            0.125
        } else {
            match prev.right {
                MathClass::Rel => 0.21,
                MathClass::Bin => 0.14,
                MathClass::Punct => 0.07,
                _ => 0.0,
            }
        };
        // 단항 부호는 앞 연산자에 붙는다. 명시 서체 선언이 새 run을 시작하면
        // 앞 연산자의 뒤 간격은 유지한다 (`x=it-1/3`과 `x=-1/3`).
        if unary(next_node, next) {
            return if declaration { trailing } else { 0.0 };
        }
        if unary(prev_node, prev) {
            return 0.14;
        }
        let script = matches!(
            prev_node,
            EqNode::Superscript { .. } | EqNode::Subscript { .. } | EqNode::SubSup { .. }
        );
        // 명시 공백은 글자처럼 앞 간격을 되살린다 (`bar{AD} `:`` 의 `:`).
        let simple_prev = glue || !Self::ends_in_composite(prev_node);
        let operator = matches!(
            prev.right,
            MathClass::Rel | MathClass::Bin | MathClass::Punct
        );
        // 명시 rm/it는 새 조판 run을 시작하여 다음 연산자의 앞 간격을 끊는다.
        // 서체 선언은 바로 앞에 붙은 연산자의 앞 간격만 끊는다 (`{rm AB} it <b`);
        // 사이에 공백이 있으면 간격이 그대로다 (`{bar{rm AD it}} `:``).
        // A declaration inherited from inside a subscript does not cancel the
        // binary operator's space after the completed scripted atom.
        let inherited_script_binary = script && next.left == MathClass::Bin;
        let leading = if (declaration && !glue && !inherited_script_binary) || !simple_prev {
            0.0
        } else {
            match next.left {
                MathClass::Rel => {
                    // A bar's trailing side margin follows its subscript;
                    // the generic 0.30em postscript gap would count it twice.
                    if barred_subscript && !glue {
                        MODERN_DECO_SIDE_EM
                    } else if script && !glue {
                        0.30
                    } else {
                        0.21
                    }
                }
                MathClass::Bin => {
                    if script {
                        0.20
                    } else {
                        0.14
                    }
                }
                // 글립 괄호: `a)`·`f(`·`1(` 0.07em, `)(`·`=(`·`((`는 붙인다.
                MathClass::Close if symbol(next_node).is_some() => 0.07,
                MathClass::Open
                    if starts_with_glyph(next_node)
                        && !operator
                        && !matches!(prev.right, MathClass::Open | MathClass::Close) =>
                {
                    0.07
                }
                _ => 0.0,
            }
        };
        trailing + leading
    }

    fn is_explicit_space(node: &EqNode) -> bool {
        match node {
            EqNode::Space(_) => true,
            EqNode::FontStyle { body, .. }
            | EqNode::FontDeclaration { body, .. }
            | EqNode::Color { body, .. } => Self::is_explicit_space(body),
            _ => false,
        }
    }

    fn is_sign(mut node: &EqNode) -> bool {
        while let EqNode::FontStyle { body, .. }
        | EqNode::FontDeclaration { body, .. }
        | EqNode::Color { body, .. } = node
        {
            node = body;
        }
        matches!(node, EqNode::Symbol(s) | EqNode::MathSymbol(s)
            if matches!(s.as_str(), "+" | "-" | "−"))
    }

    fn is_postfix_sign(node: &EqNode, atom: Atom) -> bool {
        atom.postfix && Self::is_sign(node)
    }

    fn compatible_literal_apostrophes(first: &EqNode, second: &EqNode) -> bool {
        match (first, second) {
            (EqNode::Symbol(a), EqNode::Symbol(b)) => a == "'" && b == "'",
            (
                EqNode::FontStyle {
                    style: a,
                    body: a_body,
                },
                EqNode::FontStyle {
                    style: b,
                    body: b_body,
                },
            )
            | (
                EqNode::FontDeclaration {
                    style: a,
                    body: a_body,
                },
                EqNode::FontDeclaration {
                    style: b,
                    body: b_body,
                },
            ) => a == b && Self::compatible_literal_apostrophes(a_body, b_body),
            (
                EqNode::Color {
                    r: ar,
                    g: ag,
                    b: ab,
                    body: a_body,
                },
                EqNode::Color {
                    r: br,
                    g: bg,
                    b: bb,
                    body: b_body,
                },
            ) => {
                (ar, ag, ab) == (br, bg, bb) && Self::compatible_literal_apostrophes(a_body, b_body)
            }
            _ => false,
        }
    }

    fn is_prime_atom(node: &EqNode) -> bool {
        match node {
            EqNode::Symbol(text) | EqNode::MathSymbol(text) => {
                matches!(text.as_str(), "'" | "′" | "″")
            }
            EqNode::FontStyle { body, .. }
            | EqNode::FontDeclaration { body, .. }
            | EqNode::Color { body, .. } => Self::is_prime_atom(body),
            _ => false,
        }
    }

    fn doubled_prime(node: &EqNode) -> EqNode {
        match node {
            EqNode::FontStyle { style, body } => EqNode::FontStyle {
                style: *style,
                body: Box::new(Self::doubled_prime(body)),
            },
            EqNode::FontDeclaration { style, body } => EqNode::FontDeclaration {
                style: *style,
                body: Box::new(Self::doubled_prime(body)),
            },
            EqNode::Color { r, g, b, body } => EqNode::Color {
                r: *r,
                g: *g,
                b: *b,
                body: Box::new(Self::doubled_prime(body)),
            },
            _ => EqNode::MathSymbol("″".into()),
        }
    }

    fn is_unary_sign(node: &EqNode, atom: Atom) -> bool {
        atom.left == MathClass::Ord && !atom.postfix && Self::is_sign(node)
    }

    /// 행 끝 원자가 괄호 묶음·분수·근호·장식 같은 복합 상자인지.
    fn ends_in_composite(node: &EqNode) -> bool {
        match node {
            EqNode::Paren { .. }
            | EqNode::Fraction { .. }
            | EqNode::Atop { .. }
            | EqNode::Sqrt { .. }
            | EqNode::Decoration { .. }
            | EqNode::Cases { .. }
            | EqNode::Matrix { .. }
            | EqNode::Pile { .. }
            | EqNode::EqAlign { .. }
            | EqNode::OperatorBody(_) => true,
            EqNode::FontStyle { body, .. }
            | EqNode::FontDeclaration { body, .. }
            | EqNode::Color { body, .. } => Self::ends_in_composite(body),
            EqNode::Row(children) => children
                .iter()
                .rev()
                .find(|child| !matches!(child, EqNode::Space(_) | EqNode::Empty))
                .is_some_and(Self::ends_in_composite),
            _ => false,
        }
    }

    /// 인접 원자 사이 간격 (em). 한컴 수식의 legacy 서체(HYhwpEQ 등)는 글립을
    /// advance가 아니라 잉크 가장자리끼리 포개고, 원자 종류별 고정 간격을 둔다
    /// (eq-002 PDF 잉크 간격 실측: `=`→`−` 0.00em, `=`→숫자 0.20em,
    /// `×`→`3` 0.21em, `)`→`=` 0.27em, `f`→`(` 0.05em 등).
    /// 그 외는 TeX 표.
    fn atom_space_em(
        &self,
        prev_node: &EqNode,
        prev: Atom,
        next_node: &EqNode,
        next: Atom,
        script: bool,
        glue: bool,
    ) -> f64 {
        // 서체·색상 래퍼는 수학 원자의 간격 분류를 바꾸지 않는다.
        fn unstyled(mut node: &EqNode) -> &EqNode {
            while let EqNode::FontStyle { body, .. }
            | EqNode::FontDeclaration { body, .. }
            | EqNode::Color { body, .. } = node
            {
                node = body;
            }
            node
        }
        if self.has_modern_hy_metrics(self.font_size) {
            // 첨자 행의 관계식은 붙이되, k+1 같은 변수·상수 이항식에는 HY의
            // 좌우 여백을 둔다. 원본 PDF의 k/+/1 원점은 6.18pt 글립에서
            // 각각 약 0.15em씩 떨어진다. 2+√2의 숫자·연산자·근호는
            // 6.18pt 글립에서 각 경계 약 0.125em씩 떨어진다.
            if script {
                // In a one-sided limit the sign after an arrow is unary even
                // when the source surrounds it with explicit backticks.
                if (glue
                    && matches!(prev_node, EqNode::Symbol(s) | EqNode::MathSymbol(s) if s == "→")
                    && Self::is_sign(next_node))
                    || (Self::is_sign(prev_node)
                        && matches!(next_node, EqNode::MathSymbol(s) | EqNode::Symbol(s) if s == "∞"))
                {
                    return 0.15;
                }
                // Explicit spaces around `=` in a limit retain the relation's
                // side space (`sum _{m`=`2}`: 0.21em per side in the source PDF).
                // Arrow limits have their own glyph side bearings.
                if glue
                    && (matches!(prev_node, EqNode::Symbol(text) if text == "=")
                        || matches!(next_node, EqNode::Symbol(text) if text == "="))
                {
                    return 0.21;
                }
                // 한쪽 극한의 끝 부호는 숫자·변수 뒤에 같은 간격을 둔다.
                if Self::is_postfix_sign(next_node, next) {
                    return 0.15;
                }
                if Self::is_postfix_sign(prev_node, prev) {
                    return 0.0;
                }
                // 첨자의 앞 부호도 본문과 달리 양옆 간격을 둔다.
                // 한컴의 x^{-1}, x_{-1}, lim_{x->-inf} 대조에서 모두 0.15em이다.
                if Self::is_unary_sign(prev_node, prev)
                    || (prev.right == MathClass::Rel && Self::is_unary_sign(next_node, next))
                {
                    return 0.15;
                }
                // 중첩 위첨자 뒤 이항 부호는 위첨자 행의 0.20em 간격을
                // 유지한다. 한컴 6/9/12pt `2^{2^2-3}`의 안쪽 2→− 원점은
                // 각각 2.16/3.12~3.24/4.32pt다.
                if next.left == MathClass::Bin
                    && matches!(unstyled(prev_node), EqNode::Superscript { .. })
                {
                    return 0.20;
                }
                let variable_before_binary = next.left == MathClass::Bin
                    && matches!(prev_node, EqNode::Text(text) if text.chars().any(char::is_alphabetic));
                let number_after_binary =
                    prev.right == MathClass::Bin && matches!(next_node, EqNode::Number(_));
                let number_before_binary =
                    next.left == MathClass::Bin && matches!(unstyled(prev_node), EqNode::Number(_));
                let radical_after_binary = prev.right == MathClass::Bin
                    && matches!(unstyled(next_node), EqNode::Sqrt { .. });
                return if variable_before_binary || number_after_binary {
                    0.15
                } else if number_before_binary || radical_after_binary {
                    0.125
                } else {
                    0.0
                };
            }
            return Self::modern_atom_space_em(prev_node, prev, next_node, next, glue);
        }
        let prev_node = unstyled(prev_node);
        let next_node = unstyled(next_node);
        if self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font)
        {
            // 복합 원자(√·큰 괄호·분수·대형 연산자) 앞 thin space
            // (eq-002 실측: `−`→√`³` 1.4pt@9pt, `)`→`×` 1.5pt).
            let mut node = next_node;
            loop {
                match node {
                    EqNode::FontStyle { body, .. }
                    | EqNode::FontDeclaration { body, .. }
                    | EqNode::Color { body, .. } => node = body,
                    EqNode::Sqrt { .. }
                    | EqNode::Paren { .. }
                    | EqNode::Fraction { .. }
                    | EqNode::Atop { .. }
                    | EqNode::BigOp { .. }
                    | EqNode::Matrix { .. }
                    | EqNode::Limit { .. }
                    | EqNode::Cases { .. }
                    | EqNode::Pile { .. }
                    | EqNode::EqAlign { .. }
                    | EqNode::Decoration { .. }
                    | EqNode::Rel { .. } => return THIN_SPACE_EM,
                    _ => break,
                }
            }
            // resolve_atoms로 Ord로 강등된 단항 부호(단항 − 등): 앞 원자에는
            // 붙고(0) 뒤 피연산자에는 0.15em 간격을 둔다
            // (eq-002 실측 `=`→`−` 0pt, `−`→`3` 1.35pt@9pt).
            let is_unary_sign = |node: &EqNode, atom: Atom| {
                atom.left == MathClass::Ord
                    && matches!(node, EqNode::Symbol(s) | EqNode::MathSymbol(s)
                        if symbol_class(s) == MathClass::Bin)
            };
            if is_unary_sign(next_node, next) {
                return 0.0;
            }
            if is_unary_sign(prev_node, prev) {
                return 0.15;
            }
            // 이항·관계 기호 앞 간격 — 앞 원자 종류에 따라 다르다
            // (실측 `=`→`−` 0pt, `)`→`=` 2.45pt, sup→`×` 0.3pt@9pt).
            if matches!(next.left, MathClass::Bin | MathClass::Rel) {
                // Ord 복합 원자(첨자 상자 등) 뒤의 이항/관계는 좀 더 넓다
                // (실측 sup→`×` 2.03pt, sup→`=` 1.23pt@9.06).
                let composite_ord = prev.right == MathClass::Ord
                    && !matches!(
                        prev_node,
                        EqNode::Symbol(_)
                            | EqNode::MathSymbol(_)
                            | EqNode::Number(_)
                            | EqNode::Text(_)
                            | EqNode::Quoted(_)
                            | EqNode::Function(_)
                    );
                if composite_ord {
                    return if next.left == MathClass::Bin {
                        0.22
                    } else {
                        0.14
                    };
                }
                return match prev.right {
                    MathClass::Rel => 0.0,
                    MathClass::Open => 0.08,
                    MathClass::Close => {
                        if next.left == MathClass::Rel {
                            0.27
                        } else {
                            THIN_SPACE_EM
                        }
                    }
                    // 한글 텍스트 원자 뒤의 이항/관계는 라틴 원자보다 넓다
                    // (eq-01 실측: 점→`=` 0.15em, 도→`×` 0.08em@12~13pt;
                    // 라틴 원자는 eq-002 실측 0.03em 유지).
                    MathClass::Ord => {
                        let prev_cjk = match prev_node {
                            EqNode::Text(s) | EqNode::Quoted(s) | EqNode::Number(s) => {
                                s.chars().any(is_cjk_char)
                            }
                            _ => false,
                        };
                        if prev_cjk {
                            if next.left == MathClass::Rel {
                                0.15
                            } else {
                                0.08
                            }
                        } else {
                            0.03
                        }
                    }
                    _ => THIN_SPACE_EM,
                };
            }
            // 여는 기호 앞 소간격 (실측 `f`→`(` 0.48pt@9pt).
            if next.left == MathClass::Open {
                return 0.05;
            }
            // 닫는 기호 앞 소간격 (실측 `n`→`)` 0.56pt@9pt).
            if next.left == MathClass::Close {
                return 0.06;
            }
            // 보통 원자 앞: 앞 원자 종류별 간격
            // (실측 `=`→`3` 1.77pt, `×`→`3` 1.91pt, `(`→`n` 0.56pt, `⋯`→`⋯` 0.71pt@9pt).
            // 한글 텍스트가 이항/관계 뒤에 올 때는 그보다 좁다
            // (eq-01 실측: `=`→입 0.15em, `-`→해 0.08em@12~13pt).
            let next_cjk = match next_node {
                EqNode::Text(s) | EqNode::Quoted(s) | EqNode::Number(s) => {
                    s.chars().any(is_cjk_char)
                }
                _ => false,
            };
            return match prev.right {
                MathClass::Rel => {
                    if next_cjk {
                        0.15
                    } else {
                        0.20
                    }
                }
                MathClass::Bin => {
                    if next_cjk {
                        0.08
                    } else {
                        0.21
                    }
                }
                MathClass::Open => 0.06,
                MathClass::Inner => 0.07,
                MathClass::Ord => 0.08,
                // 도형 접두 기호(△x 등)는 뒤 피연산자와 thin space로 떨어진다.
                MathClass::Op => THIN_SPACE_EM,
                _ => 0.0,
            };
        }
        math_space_em(prev, next, script)
    }

    /// legacy 글립 원자의 실측치 — painter가 칠할 문자→PUA 매핑·이탤릭·볼드를
    /// 그대로 따라간다. 비글립 원자(복합·공백·줄바꿈)나 측정 불가 시 None.
    #[cfg(not(target_arch = "wasm32"))]
    fn node_run_metrics(&self, node: &EqNode, fs: f64) -> Option<super::measure::LegacyRunMetrics> {
        let (text, italic, bold) = match node {
            EqNode::Text(s) => (s.as_str(), self.is_italic_text(s), self.bold),
            EqNode::Quoted(s) if self.is_modern_hy() => {
                (s.as_str(), self.is_italic_text(s), self.bold)
            }
            EqNode::Number(s) | EqNode::Quoted(s) => (s.as_str(), false, self.bold),
            EqNode::Symbol(s) if self.is_modern_hy() && s == "'" => ("′", false, false),
            EqNode::Symbol(s) => (s.as_str(), false, false),
            EqNode::MathSymbol(s) => {
                if matches!(symbol_class(s), MathClass::Rel | MathClass::Bin)
                    || is_integral_symbol(s)
                {
                    (s.as_str(), false, false)
                } else {
                    let italic = self.italic && super::font::is_greek_variable(s);
                    (self.source_roman_pi_glyph(s, italic), italic, false)
                }
            }
            EqNode::Function(s) => (s.as_str(), false, false),
            EqNode::FontStyle { style, body } | EqNode::FontDeclaration { style, body } => {
                return self.styled(*style).node_run_metrics(body, fs);
            }
            EqNode::Color { body, .. } => return self.node_run_metrics(body, fs),
            _ => return None,
        };
        super::measure::measure_legacy_run_native(text, fs, italic, bold, self.modern_run_metrics())
    }

    /// 브라우저에서도 네이티브와 같은 원본 glyf/hmtx 잉크 경계를 사용한다.
    #[cfg(target_arch = "wasm32")]
    fn node_run_metrics_wasm(&self, node: &EqNode, fs: f64) -> Option<(f64, f64, f64)> {
        let (text, italic, bold) = match node {
            EqNode::Text(s) => (s.as_str(), self.is_italic_text(s), self.bold),
            EqNode::Quoted(s) if self.is_modern_hy() => {
                (s.as_str(), self.is_italic_text(s), self.bold)
            }
            EqNode::Number(s) | EqNode::Quoted(s) => (s.as_str(), false, self.bold),
            EqNode::Symbol(s) if self.is_modern_hy() && s == "'" => ("′", false, false),
            EqNode::Symbol(s) => (s.as_str(), false, false),
            EqNode::MathSymbol(s) => {
                if matches!(symbol_class(s), MathClass::Rel | MathClass::Bin)
                    || is_integral_symbol(s)
                {
                    (s.as_str(), false, false)
                } else {
                    let italic = self.italic && super::font::is_greek_variable(s);
                    (self.source_roman_pi_glyph(s, italic), italic, false)
                }
            }
            EqNode::Function(s) => (s.as_str(), false, false),
            EqNode::FontStyle { style, body } | EqNode::FontDeclaration { style, body } => {
                return self.styled(*style).node_run_metrics_wasm(body, fs);
            }
            EqNode::Color { body, .. } => return self.node_run_metrics_wasm(body, fs),
            _ => return None,
        };
        let family = self.font_family.as_deref()?;
        let value = measure_equation_text(family, text, fs, italic, self.hft, true, bold).ok()?;
        let metrics = super::measure::RunMetrics::from_js(value.clone())?;
        let ink_left = super::measure::js_property(&value, "inkLeft")?.as_f64()?;
        ink_left
            .is_finite()
            .then_some((metrics.advance, ink_left, metrics.ink_right))
    }

    /// 글립 원자의 좌측 베어링(lsb, px). 한컴 legacy 수식은 글립을 advance가 아니라
    /// 앞 글립의 잉크 끝에 붙여 식자한다 — layout_row가 다음 원자 원점을
    /// `앞 잉크 끝 − 이 원자 lsb`로 놓는다 (eq-002 실측). 비글립 원자·측정 불가 시 0.
    #[cfg(not(target_arch = "wasm32"))]
    fn node_ink_left(&self, node: &EqNode, fs: f64) -> f64 {
        self.node_run_metrics(node, fs)
            .map(|m| m.ink_left)
            .unwrap_or(0.0)
    }

    #[cfg(target_arch = "wasm32")]
    fn node_ink_left(&self, node: &EqNode, fs: f64) -> f64 {
        self.node_run_metrics_wasm(node, fs)
            .map(|(_, left, _)| left)
            .unwrap_or(0.0)
    }

    /// 글립 run의 advance 오른쪽 끝(px, run 원점 기준) — 잉크 오른쪽 끝에 마지막
    /// 글립의 우측 베어링을 더한 값이다. 비글립 원자·측정 불가 시 None.
    #[cfg(not(target_arch = "wasm32"))]
    fn node_advance_right(&self, node: &EqNode, fs: f64) -> Option<f64> {
        self.node_run_metrics(node, fs).map(|m| m.advance)
    }

    #[cfg(target_arch = "wasm32")]
    fn node_advance_right(&self, node: &EqNode, fs: f64) -> Option<f64> {
        self.node_run_metrics_wasm(node, fs)
            .map(|(advance, _, _)| advance)
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn node_ink_overhang_right(&self, node: &EqNode, fs: f64) -> Option<f64> {
        self.node_run_metrics(node, fs)
            .map(|m| (m.ink_right - m.advance).max(0.0))
    }

    #[cfg(target_arch = "wasm32")]
    fn node_ink_overhang_right(&self, node: &EqNode, fs: f64) -> Option<f64> {
        self.node_run_metrics_wasm(node, fs)
            .map(|(advance, _, right)| (right - advance).max(0.0))
    }

    /// Last painted glyph beyond its hinted advance. Roman/italic declarations
    /// select different HY glyphs, so the measured reach must follow the style.
    fn trailing_radical_ink_overhang(&self, node: &EqNode, fs: f64) -> f64 {
        match node {
            EqNode::Row(children) => children
                .iter()
                .rev()
                .find(|node| !matches!(node, EqNode::Space(_) | EqNode::Empty))
                .map_or(0.0, |node| self.trailing_radical_ink_overhang(node, fs)),
            EqNode::FontStyle { style, body } | EqNode::FontDeclaration { style, body } => {
                self.styled(*style).trailing_radical_ink_overhang(body, fs)
            }
            EqNode::Color { body, .. } => self.trailing_radical_ink_overhang(body, fs),
            EqNode::Text(text) => self.node_ink_overhang_right(node, fs).unwrap_or_else(|| {
                if self.italic
                    && text
                        .chars()
                        .last()
                        .is_some_and(|ch| ch.is_ascii_lowercase())
                {
                    fs * 0.07
                } else {
                    0.0
                }
            }),
            _ => self.node_ink_overhang_right(node, fs).unwrap_or(0.0),
        }
    }

    fn text_width(&self, text: &str, font_size: f64, italic: bool, literal: bool) -> f64 {
        self.text_metrics(text, font_size, italic, self.bold, literal)
            .0
    }

    /// (advance, 이탤릭 보정) — painter가 실제로 칠하는 서체 기준.
    ///
    /// 세션에 로드된 원본 수식 서체(HYhwpEQ PUA/HFT bank), painter의 CSS fallback
    /// 체인을 같은 font 문자열로 canvas 측정, 같은 체인의 내장 메트릭, 추정 순이다.
    /// 추정 폭으로 배치하고 fallback 서체로 칠하면 △처럼 넓은 글립이 옆 원자를 덮는다.
    fn text_metrics(
        &self,
        text: &str,
        font_size: f64,
        italic: bool,
        bold: bool,
        literal: bool,
    ) -> (f64, f64) {
        if self.is_modern_hy() {
            if let Some(advance) = super::font::modern_hancom_fallback_run_advance_em(text) {
                return (
                    super::font::modern_glyph_advance(advance * font_size, font_size, false),
                    0.0,
                );
            }
        }
        #[cfg(target_arch = "wasm32")]
        if let Some(metrics) = self
            .font_family
            .as_deref()
            .and_then(|family| {
                measure_equation_text(family, text, font_size, italic, self.hft, literal, bold).ok()
            })
            .and_then(super::measure::RunMetrics::from_js)
        {
            let legacy = self
                .font_family
                .as_deref()
                .is_some_and(super::font::is_legacy_equation_font);
            return (
                if legacy && !self.is_modern_hy() {
                    metrics.ink_right
                } else {
                    metrics.advance
                },
                if italic && !legacy {
                    metrics.overhang()
                } else {
                    0.0
                },
            );
        }
        let family = super::font::equation_css_font_family(self.font_family.as_deref());
        if let Some(metrics) =
            self.measure_painted_run(&family, text, font_size, italic, bold, literal)
        {
            let overhang = if italic { metrics.overhang() } else { 0.0 };
            return (metrics.advance, overhang);
        }
        // 네이티브: painter가 실제 legacy 서체로 칠할 수 있으면 같은 서체로 실측한다.
        #[cfg(not(target_arch = "wasm32"))]
        if self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font)
        {
            if let Some(metrics) = super::measure::measure_legacy_run_native(
                text,
                font_size,
                italic,
                bold,
                self.modern_run_metrics(),
            ) {
                // HFT는 잉크 끝을 연결하고 현대 HY는 힌팅된 advance를 연결한다.
                return (
                    if self.is_modern_hy() {
                        metrics.advance
                    } else {
                        metrics.ink_right
                    },
                    0.0,
                );
            }
        }
        #[cfg(not(target_arch = "wasm32"))]
        let _ = literal;
        let measure = |family: &str, text: &str| {
            crate::renderer::layout::measure_known_font_run_width(
                family, bold, italic, text, font_size,
            )
        };
        // 요청 서체의 내장 메트릭이 있으면 그 폭을 쓴다(잉크 정보 없음).
        if let Some(width) = self
            .font_family
            .as_deref()
            .and_then(|name| measure(name, text))
        {
            return (width, 0.0);
        }
        // 그 외에는 painter fallback 체인(Times 계열)의 메트릭과 이탤릭 보정표를 쓴다.
        let chain = super::font::equation_font_families(self.font_family.as_deref()).join(", ");
        let width = measure(&chain, text).unwrap_or_else(|| {
            text.chars()
                .map(|ch| {
                    let glyph = ch.to_string();
                    measure(&chain, &glyph)
                        .unwrap_or_else(|| estimate_text_width(&glyph, font_size, italic))
                })
                .sum()
        });
        let overhang = match text.chars().last() {
            Some(last) if italic => super::measure::italic_overhang_em(last) * font_size,
            _ => 0.0,
        };
        (width, overhang)
    }

    /// canvas painter의 fallback 경로와 같은 글꼴·run 단위로 측정한다.
    fn measure_painted_run(
        &self,
        family: &str,
        text: &str,
        font_size: f64,
        italic: bool,
        bold: bool,
        literal: bool,
    ) -> Option<super::measure::RunMetrics> {
        use super::measure::{css_font, measure_css_run, RunMetrics};
        if !(self.hft && literal && !text.is_ascii()) {
            return measure_css_run(&css_font(font_size, italic, bold, family), text);
        }
        // HFT literal은 글자마다 칠한다. 비ASCII 글자는 직립이다(canvas_render::draw_legacy_literal).
        let mut advance = 0.0;
        let mut ink_right = 0.0;
        for ch in text.chars() {
            let glyph_italic = italic && ch.is_ascii();
            let run = measure_css_run(
                &css_font(font_size, glyph_italic, bold, family),
                &ch.to_string(),
            )?;
            ink_right = advance + run.ink_right;
            advance += run.advance;
        }
        Some(RunMetrics { advance, ink_right })
    }

    /// AST를 레이아웃 박스로 변환
    pub fn layout(&self, node: &EqNode) -> LayoutBox {
        let mut result = self.layout_node(node, self.font_size);
        // A standalone numeric EQEDIT control shares the surrounding prose
        // baseline. Hancom places its digits 0.12pt above that baseline at
        // 6, 9, and 12pt, independent of the equation font size. The modern
        // per-glyph digit shift serves mixed expressions, so cancel it only
        // at the root of a pure-number equation without changing its flow box.
        if matches!(node, EqNode::Number(_)) && self.has_modern_hy_metrics(self.font_size) {
            result.y -= self.font_size * super::font::modern_glyph_baseline_em('0', false)
                + 0.12 * 4.0 / 3.0;
        }
        result
    }

    /// 원본 개체의 여유 폭 안에 자연 크기의 수식을 왼쪽에 둔다. 글립은 늘이지 않는다.
    pub fn layout_in_control_width(&self, node: &EqNode, width: f64) -> LayoutBox {
        let mut result = self.layout(node);
        if !width.is_finite() || width <= 0.0 {
            return result;
        }
        if result.width > width {
            // 저장 폭은 font stretch가 아닌 개체 크기다. 추정 연산자 여백만 줄인다.
            // 최소 여백으로도 못 맞추는 폰트 대체/수동 크기 변경은 자연 배치를 유지한다.
            let mut compact = self.clone();
            compact.operator_padding_scale = 0.0;
            let minimum = compact.layout(node);
            if minimum.width <= width && minimum.width < result.width {
                let mut low = 0.0;
                let mut high = 1.0;
                let mut scale = (width - minimum.width) / (result.width - minimum.width);
                for _ in 0..16 {
                    compact.operator_padding_scale = scale;
                    result = compact.layout(node);
                    if (result.width - width).abs() < 0.0001 {
                        break;
                    }
                    if result.width > width {
                        high = scale;
                    } else {
                        low = scale;
                    }
                    scale = (low + high) / 2.0;
                }
            }
        }
        // 한컴은 저장 폭보다 짧은 수식을 상자 왼쪽(여백 뒤)에 두지 가운데 정렬하지
        // 않는다 (eq-002 실측: 선언 72.98pt 상자에 `=` 글립이 좌측 여백 바로 뒤).
        result
    }

    fn layout_node(&self, node: &EqNode, fs: f64) -> LayoutBox {
        let mut result = match node {
            EqNode::Row(children) => self.layout_row(children, fs),
            EqNode::OperatorBody(body) => self.layout_node(body, fs),
            EqNode::Text(s) => self.layout_text(s, fs),
            EqNode::Number(s) => self.layout_number(s, fs),
            EqNode::Symbol(s) => self.layout_symbol(s, fs),
            EqNode::MathSymbol(s) => self.layout_math_symbol(s, fs),
            EqNode::Function(s) => self.layout_function(s, fs),
            EqNode::Quoted(s) if self.is_modern_hy() => self.layout_text(s, fs),
            EqNode::Quoted(s) => self.layout_number(s, fs),
            EqNode::Fraction { numer, denom } => self.layout_fraction(numer, denom, fs),
            EqNode::Atop { top, bottom } => self.layout_atop(top, bottom, fs),
            EqNode::Sqrt { index, body } => self.layout_sqrt(index, body, fs),
            EqNode::Superscript { base, sup } => self.layout_superscript(base, sup, fs),
            EqNode::Subscript { base, sub } => self.layout_subscript(base, sub, fs),
            EqNode::SubSup { base, sub, sup } => self.layout_subsup(base, sub, sup, fs),
            EqNode::BigOp { symbol, sub, sup } => self.layout_big_op(symbol, sub, sup, fs),
            EqNode::Limit { is_upper, sub } => self.layout_limit(*is_upper, sub, fs),
            EqNode::Matrix { rows, style } => self.layout_matrix(rows, *style, fs),
            EqNode::Cases { rows } => self.layout_cases(rows, fs),
            EqNode::EqAlign { rows } => self.layout_eqalign(rows, fs),
            EqNode::Rel { arrow, over, under } => self.layout_rel(arrow, over, under, fs),
            EqNode::Pile { rows, align } => self.layout_pile(rows, *align, fs),
            EqNode::Paren { left, right, body } => self.layout_paren(left, right, body, fs),
            EqNode::Decoration { kind, body } => self.layout_decoration(*kind, body, fs),
            EqNode::FontStyle { style, body } | EqNode::FontDeclaration { style, body } => {
                self.layout_font_style(*style, body, fs)
            }
            EqNode::Color { body, .. } => self.layout_node(body, fs),
            EqNode::Space(kind) => self.layout_space(*kind, fs),
            EqNode::Newline => LayoutBox {
                glyph_advances: None,
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
                baseline: 0.0,
                kind: LayoutKind::Newline,
            },
            EqNode::Empty => LayoutBox {
                glyph_advances: None,
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
                baseline: 0.0,
                kind: LayoutKind::Empty,
            },
        };
        if self.is_modern_hy() {
            let leaf = match node {
                EqNode::Text(text)
                | EqNode::Quoted(text)
                | EqNode::Number(text)
                | EqNode::Symbol(text)
                | EqNode::Function(text) => Some(text),
                EqNode::MathSymbol(text) if !is_integral_symbol(text) => Some(text),
                _ => None,
            };
            if let Some(text) = leaf {
                result.glyph_advances = text
                    .chars()
                    .map(|ch| {
                        let value = ch.to_string();
                        let single = match node {
                            EqNode::Text(_) => EqNode::Text(value),
                            EqNode::Quoted(_) => EqNode::Quoted(value),
                            EqNode::Number(_) => EqNode::Number(value),
                            EqNode::Symbol(_) => EqNode::Symbol(value),
                            EqNode::MathSymbol(_) => EqNode::MathSymbol(value),
                            EqNode::Function(_) => EqNode::Function(value),
                            _ => unreachable!(),
                        };
                        self.node_advance_right(&single, fs)
                    })
                    .collect();
            }
        }
        result
    }

    fn layout_row(&self, children: &[EqNode], fs: f64) -> LayoutBox {
        self.layout_row_with_sum_limit(children, fs, false)
    }

    fn layout_row_with_sum_limit(
        &self,
        children: &[EqNode],
        fs: f64,
        sum_limit: bool,
    ) -> LayoutBox {
        // Hancom combines two adjacent apostrophe tokens into one double-prime
        // glyph. Preserve the original AST and legacy rendering; only modern
        // HY layout needs the combined painted node.
        let combined = (self.is_modern_hy()
            && children
                .windows(2)
                .any(|pair| Self::compatible_literal_apostrophes(&pair[0], &pair[1])))
        .then(|| {
            let mut result = Vec::with_capacity(children.len());
            let mut i = 0;
            while i < children.len() {
                if i + 1 < children.len()
                    && Self::compatible_literal_apostrophes(&children[i], &children[i + 1])
                {
                    result.push(Self::doubled_prime(&children[i]));
                    i += 2;
                } else {
                    result.push(children[i].clone());
                    i += 1;
                }
            }
            result
        });
        let children = combined.as_deref().unwrap_or(children);
        let modern = self.has_modern_hy_metrics(fs);
        let laid: Vec<(&EqNode, LayoutBox)> = children
            .iter()
            .flat_map(|node| match node {
                EqNode::OperatorBody(body) if !modern => match body.as_ref() {
                    EqNode::Row(children) => children.as_slice(),
                    body => std::slice::from_ref(body),
                },
                node => std::slice::from_ref(node),
            })
            .map(|c| (c, self.layout_node(c, fs)))
            // 현대 HY에서는 폭이 0인 PILE도 빈 행 높이로 주변 괄호를 늘린다.
            .filter(|(node, b)| {
                b.width > 0.0
                    || matches!(b.kind, LayoutKind::Newline)
                    || (self.is_modern_hy() && matches!(node, EqNode::Pile { .. }))
            })
            .collect();

        fn unstyled(mut node: &EqNode) -> &EqNode {
            while let EqNode::FontStyle { body, .. }
            | EqNode::FontDeclaration { body, .. }
            | EqNode::Color { body, .. } = node
            {
                node = body;
            }
            node
        }
        // Hancom reserves an extra eighth-em after a composite operand's
        // multiplication glyph (`bar OD × cos`, `sqrt OD × cos`). The gap is
        // absent for `2 × cos` and `bar OD × x`.
        let composite_product_function: Vec<bool> = (0..laid.len())
            .map(|i| {
                modern
                    && i >= 2
                    && Self::ends_in_composite(laid[i - 2].0)
                    && matches!(unstyled(laid[i - 1].0), EqNode::Symbol(s) | EqNode::MathSymbol(s) if s == "×")
                    && matches!(unstyled(laid[i].0), EqNode::Function(_))
            })
            .collect();

        if laid.is_empty() {
            return LayoutBox {
                glyph_advances: None,
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: fs,
                baseline: fs * 0.8,
                kind: LayoutKind::Row(Vec::new()),
            };
        }

        // 기준선 정렬: 가장 높은 baseline과 가장 깊은 descent
        let max_ascent = laid.iter().map(|(_, b)| b.baseline).fold(0.0f64, f64::max);
        let max_descent = laid
            .iter()
            .map(|(_, b)| b.height - b.baseline)
            .fold(0.0f64, f64::max);
        let total_height = max_ascent + max_descent;

        let atoms = resolve_atoms(
            laid.iter()
                .enumerate()
                .map(|(index, (node, _))| {
                    // 식 번호 앞 말줄임표는 관계 구분자다. 수열의 일반 말줄임표와
                    // 달리 앞뒤 관계 간격을 둔다 (한컴 `a^2=4b^2 cdots②`).
                    if modern && is_equation_label_separator(node, laid.get(index + 1).map(|p| p.0))
                    {
                        AtomSlot::Atom(Atom::of(MathClass::Rel))
                    } else {
                        atom_of(node)
                    }
                })
                .collect(),
            modern,
        );
        let mut extent = 0.0f64;
        let script = fs < self.font_size * 0.95;
        let legacy = self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font);
        let mut previous: Option<(&EqNode, Atom, f64)> = None;
        let mut glue = false;
        let mut x = 0.0;
        let mut boxes = Vec::with_capacity(laid.len());
        let leading_tick_before_equals =
            matches!(laid.first(), Some((EqNode::Space(SpaceKind::Thin), _)))
                && matches!(laid.get(1), Some((EqNode::Symbol(s), _)) if s == "=");
        for (index, ((node, mut b), atom)) in laid.into_iter().zip(atoms).enumerate() {
            // A prime on an overbar attaches to the body's last glyph. The
            // overbar's right margin remains part of its occupied width, but
            // does not move the prime ink away from the body.
            let prime_ink_shift = if modern
                && previous
                    .as_ref()
                    .is_some_and(|(prior, _, _)| Self::is_bar_decoration(prior))
                && Self::is_prime_atom(node)
            {
                fs * MODERN_DECO_SIDE_EM
            } else {
                0.0
            };
            // Hancom gives an explicit backtick after CDOTS an extra 0.21em
            // beyond the ordinary thin-space slot. Unspaced CDOTS pairs keep
            // their tracked glyph pitch; only the first explicit space grows.
            if modern
                && !glue
                && matches!(node, EqNode::Space(SpaceKind::Thin))
                && previous.as_ref().is_some_and(
                    |(prev, _, _)| matches!(prev, EqNode::MathSymbol(text) if text == "⋯"),
                )
            {
                b.width += fs * 0.21;
            }
            // An initial explicit backtick before `=` reserves its relation
            // space before the first painted atom of this equation control.
            if modern && index == 0 && leading_tick_before_equals {
                b.width += fs * 0.21;
            }
            match atom {
                AtomSlot::Atom(atom) => {
                    if let Some((prev_node, prev, overhang)) = previous {
                        // 명시 공백 뒤 관계식은 위첨자 잉크 끝에서 새 간격을 시작한다.
                        let spaced_relation = glue && atom.left == MathClass::Rel;
                        if !Self::leading_font_declaration(node) && !spaced_relation {
                            x -= overhang;
                        }
                        // Σ의 위/아래 limit 행은 명시 backtick 없이도 '=' 옆 간격을 둔다.
                        // 일반 첨자와 limit 안의 중첩 첨자에는 이 문맥을 전파하지 않는다.
                        let limit_equality = sum_limit
                            && (matches!(prev_node, EqNode::Symbol(s) if s == "=")
                                || matches!(node, EqNode::Symbol(s) if s == "="));
                        let mut space = self.atom_space_em(
                            prev_node,
                            prev,
                            node,
                            atom,
                            script,
                            glue || limit_equality,
                        );
                        if composite_product_function[index] && !glue {
                            space += 0.125;
                        }
                        x += space * fs * self.operator_padding_scale;
                    }
                    glue = false;
                    previous = Some((
                        node,
                        atom,
                        if self.has_modern_hy_metrics(fs) && Self::ends_in_capital_superscript(node)
                        {
                            Self::modern_script_overhang(&b)
                        } else {
                            0.0
                        },
                    ));
                }
                AtomSlot::Break => previous = None,
                // 명시 공백(~, `)은 원자 간격에 더해지며 양옆 원자의 관계를 끊지 않는다.
                AtomSlot::Glue => glue = Self::is_explicit_space(node),
            }
            // legacy 서체는 글립을 advance가 아닌 잉크 가장자리로 포갠다:
            // 원점 = 커서(앞 글립 잉크 끝) − 이 글립 lsb. 첫 원자는 원점을
            // 상자 왼쪽에 둔다 (eq-002: `=` 원점이 좌측 여백 바로 뒤).
            let lsb = if legacy && !self.has_modern_hy_metrics(fs) && !boxes.is_empty() {
                self.node_ink_left(node, fs)
            } else {
                0.0
            };
            let logical_x = x - lsb;
            b.x = logical_x - prime_ink_shift;
            b.y = max_ascent - b.baseline;
            x = logical_x + b.width;
            // 행 폭 = 커서가 아니라 각 원자의 advance 오른쪽 끝 — 한컴이 개체의
            // paint 폭으로 쓰는 값은 마지막 글립의 우측 베어링까지 포함한다
            // (eq-002 실측: `f(n)` 개체 advance 18.0pt ≈ 마지막 글립 advance 끝).
            let end = if legacy {
                self.node_advance_right(node, fs)
                    .map(|adv| logical_x + adv)
                    .unwrap_or_else(|| b.x + b.width)
            } else {
                b.x + b.width
            };
            extent = extent.max(end);
            boxes.push(b);
        }

        let width = if legacy { extent } else { x };
        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width,
            height: total_height,
            baseline: max_ascent,
            kind: LayoutKind::Row(boxes),
        }
    }

    fn is_italic_text(&self, text: &str) -> bool {
        self.italic
            && !text.chars().any(is_cjk_char)
            && !(self.is_modern_hy()
                && super::font::modern_hancom_fallback_run_advance_em(text).is_some())
    }

    fn layout_text(&self, text: &str, fs: f64) -> LayoutBox {
        // CJK/한글 텍스트는 이탤릭이 아니므로 italic 보정 제외.
        // 이탤릭 보정(잉크가 advance를 넘는 폭)은 TeX처럼 글자 폭에 포함한다.
        let (advance, overhang) =
            self.text_metrics(text, fs, self.is_italic_text(text), self.bold, true);
        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: advance + overhang,
            height: fs,
            baseline: fs * 0.8,
            kind: LayoutKind::Text(text.to_string()),
        }
    }

    /// 첨자 기준 글자의 이탤릭 보정. 아래첨자는 이만큼 왼쪽(글자 advance)에 붙는다.
    fn trailing_italic_correction(&self, node: &EqNode, fs: f64) -> f64 {
        match node {
            EqNode::Text(text) if self.is_italic_text(text) => {
                self.text_metrics(text, fs, true, self.bold, true).1
            }
            EqNode::MathSymbol(text)
                if self.italic
                    && super::font::is_greek_variable(text)
                    && !is_integral_symbol(text)
                    && symbol_class(text) == MathClass::Ord =>
            {
                self.text_metrics(text, fs, true, false, false).1
            }
            EqNode::FontStyle { style, body } | EqNode::FontDeclaration { style, body } => {
                self.styled(*style).trailing_italic_correction(body, fs)
            }
            EqNode::Color { body, .. } => self.trailing_italic_correction(body, fs),
            EqNode::Row(children) => children
                .last()
                .map_or(0.0, |last| self.trailing_italic_correction(last, fs)),
            _ => 0.0,
        }
    }

    fn layout_number(&self, text: &str, fs: f64) -> LayoutBox {
        let w = self.text_metrics(text, fs, false, self.bold, false).0;
        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: w,
            height: fs,
            baseline: fs * 0.8,
            kind: LayoutKind::Number(text.to_string()),
        }
    }

    /// 연산자·구두점 기호. 좌우 간격은 layout_row의 원자 간격이 정한다.
    fn layout_symbol(&self, text: &str, fs: f64) -> LayoutBox {
        // In a modern HY equation, an apostrophe token is Hancom's prime,
        // including when it follows an `rm` declaration or an overbar.
        let text = if self.is_modern_hy() && text == "'" {
            "′"
        } else {
            text
        };
        let w = self.text_metrics(text, fs, false, false, false).0;
        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: w,
            height: fs,
            baseline: fs * 0.8,
            kind: LayoutKind::Symbol(text.to_string()),
        }
    }

    fn layout_math_symbol(&self, text: &str, fs: f64) -> LayoutBox {
        // 적분 기호: 큰 크기로 렌더링 (INTEGRAL_SCALE 적용 — Task #1313)
        // Task #1317: 글리프를 path 로 그리므로 advance 는 path 폭(geom.width)을 쓴다.
        if is_integral_symbol(text) {
            let op_fs = fs * INTEGRAL_SCALE;
            let geom = integral_geom(fs);
            return LayoutBox {
                glyph_advances: None,
                x: 0.0,
                y: 0.0,
                // Task #1233: 첨자 없는 bare 적분도 뒤 피연산자와 trailing 간격 유지.
                width: geom.width + fs * BIG_OP_TRAIL_PAD,
                height: op_fs,
                baseline: op_fs * 0.7, // 적분 기호 baseline: 기호 높이의 70%
                kind: LayoutKind::MathSymbol(text.to_string()),
            };
        }
        // 관계·이항 연산 기호는 Symbol 로 두어 가운데에 그린다.
        if matches!(symbol_class(text), MathClass::Rel | MathClass::Bin) {
            return self.layout_symbol(text, fs);
        }
        let italic = self.italic && super::font::is_greek_variable(text);
        // EQEDIT's `pi` command keeps the HY math glyph even after a persistent
        // `rm` declaration. The Unicode code point is absent from HYhwpEQ;
        // Hancom paints its U+E0AC glyph at every tested base size.
        let glyph = self.source_roman_pi_glyph(text, italic);
        let (advance, overhang) = self.text_metrics(glyph, fs, italic, false, false);
        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: advance + overhang,
            height: fs,
            baseline: fs * 0.8,
            kind: LayoutKind::MathSymbol(glyph.to_string()),
        }
    }

    fn layout_function(&self, name: &str, fs: f64) -> LayoutBox {
        // 함수 이름은 Op 원자다. 뒤 피연산자와의 thin space는 layout_row가 넣는다.
        let w = self.text_metrics(name, fs, false, false, false).0;
        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: w,
            height: fs,
            baseline: fs * 0.8,
            kind: LayoutKind::Function(name.to_string()),
        }
    }

    fn layout_fraction(&self, numer: &EqNode, denom: &EqNode, fs: f64) -> LayoutBox {
        fn contains_fraction(node: &EqNode) -> bool {
            match node {
                EqNode::Fraction { .. } => true,
                EqNode::Row(parts) => parts.iter().any(contains_fraction),
                EqNode::Sqrt { body, .. }
                | EqNode::OperatorBody(body)
                | EqNode::Paren { body, .. }
                | EqNode::Decoration { body, .. }
                | EqNode::FontStyle { body, .. }
                | EqNode::FontDeclaration { body, .. }
                | EqNode::Color { body, .. } => contains_fraction(body),
                EqNode::Superscript { base, sup } => {
                    contains_fraction(base) || contains_fraction(sup)
                }
                EqNode::Subscript { base, sub } => {
                    contains_fraction(base) || contains_fraction(sub)
                }
                EqNode::SubSup { base, sub, sup } => {
                    contains_fraction(base) || contains_fraction(sub) || contains_fraction(sup)
                }
                _ => false,
            }
        }
        let n = self.layout_node(numer, fs);
        let d = self.layout_node(denom, fs);

        let pad = fs * FRAC_LINE_PAD;
        let line_thick = fs * FRAC_LINE_THICK;
        let axis = fs * if self.hft { 0.375 } else { AXIS_HEIGHT };
        let child_width = n.width.max(d.width);
        let natural_width = child_width + pad * 2.0;
        // 현대 HY 분수는 최소 1em 개체/0.8em 선을 사용한다. 좁은 분수를
        // 글립 advance까지 줄이면 같은 분자도 분모에 따라 시작점이 달라진다.
        // 긴 분수는 기존 0.15em 선 여백을 유지한다 (eq-01의 12pt 분수).
        let modern_hy = self.is_modern_hy();
        let (w, bar_inset) = if modern_hy {
            // 분수 폭은 가장 긴 자식 advance와 양쪽 thin 여백이다.
            // eq-002의 1/4는 두 숫자의 advance가 같아 중앙 정렬해도 원점이 같다.
            let child_advance = |node: &EqNode, lb: &LayoutBox| {
                self.node_advance_right(node, fs).unwrap_or(lb.width)
            };
            // 한컴 probe: 분수선 = 긴 자식 + 0.15em×2 (최소 0.8em), 개체는 선 양옆에
            // 0.1em 씩 더 차지한다 (`{1} over {3}` 선 8.76pt@11, `+`→선 1.54+1.1pt).
            if self.has_modern_hy_metrics(fs) {
                let bar = (child_advance(numer, &n).max(child_advance(denom, &d)) + fs * 0.3)
                    .max(fs * 0.8);
                (bar + fs * 0.2, fs * 0.1)
            } else {
                let width = (child_advance(numer, &n).max(child_advance(denom, &d))
                    + fs * THIN_SPACE_EM * 2.0)
                    .max(fs * 0.628);
                (width, 0.0)
            }
        } else {
            (natural_width, fs * 0.05)
        };

        let numer_h = n.height + pad;
        let denom_h = d.height + pad;

        // TeX 방식: 분수선은 baseline에서 axis_height 위에 배치
        // baseline(상단에서) = 분자높이 + 분수선두께/2 + axis_height
        // 즉, 분수선 y = baseline - axis_height (상단 기준)
        let frac_line_from_top = numer_h + line_thick / 2.0;
        let baseline = frac_line_from_top + axis;
        let mut total_h = numer_h + line_thick + denom_h;

        let mut n_box = n;
        // 분수 자식은 분수선 폭 안에서 가운데 정렬이다 — 좁은 자식이 넓은 자식의
        // 중심 아래 온다 (02-eq-01 실측: 분자 중심 = 분모 중심). legacy 원자 폭은
        // 잉크 경계이므로 현대 HY 정렬에는 실제 advance를 사용한다.
        n_box.x = if modern_hy {
            (w - self.node_advance_right(numer, fs).unwrap_or(n_box.width)) / 2.0
        } else {
            (w - n_box.width) / 2.0
        };
        n_box.y = pad;

        let mut d_box = d;
        d_box.x = if modern_hy {
            (w - self.node_advance_right(denom, fs).unwrap_or(d_box.width)) / 2.0
        } else {
            (w - d_box.width) / 2.0
        };
        d_box.y = numer_h + line_thick;

        // HYhwpEQ는 분자/분모의 baseline을 수식 baseline 위/아래에 놓는다.
        // em box의 시작점에 같은 padding을 더하면 실제 간격이 1.04em으로 줄어든다.
        // 한컴 원본 PDF(eq-01-2022의 12/13pt, 11pt 광학 실험지)에서는 약 1.3em이다.
        if self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font)
        {
            // 분자/분모 baseline은 상자 baseline에서 ±0.65em 대칭이다
            // (eq-002 실측: ¼의 1·4가 baseline 위아래 각각 5.9pt@9.06).
            // HFT serif cap은 약 0.70em이다. 분모 cap과 bar 사이의 기존
            // FRAC_LINE_PAD clearance를 유지하고 HFT axis(0.375em)를 뺀다.
            let numer_shift = if self.hft { 0.625 } else { 0.65 };
            n_box.y = if modern_hy && contains_fraction(numer) {
                // A fraction nested in the numerator uses Hancom's regular
                // top padding. Its lower content reaches nearer the outer bar.
                pad
            } else if modern_hy {
                // 분자에 아래 첨자가 있어도 분자 상자가 분수선 여백을 침범하지 않는다.
                // baseline 대칭만 맞추면 늘어난 descent만큼 분자가 선 쪽으로 내려간다.
                (frac_line_from_top - pad - n_box.height).max(0.0)
            } else {
                (baseline - fs * numer_shift - n_box.baseline).max(0.0)
            };
            let denom_shift = if self.hft {
                0.70 + FRAC_LINE_PAD - 0.375
            } else {
                0.65
            };
            let clear_top = if self.hft {
                let cap_ascent = if matches!(
                    d_box.kind,
                    LayoutKind::Text(_) | LayoutKind::Number(_) | LayoutKind::MathSymbol(_)
                ) {
                    fs * 0.70
                } else {
                    d_box.baseline
                };
                frac_line_from_top + fs * FRAC_LINE_PAD - (d_box.baseline - cap_ascent)
            } else {
                // 분수선 아래만 넘지 않으면 된다 — baseline 대칭이 우선이다.
                frac_line_from_top + line_thick
            };
            d_box.y = (baseline + fs * denom_shift - d_box.baseline).max(clear_top);
            total_h = total_h.max(d_box.y + d_box.height);
        }

        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: w,
            height: total_h,
            baseline,
            kind: LayoutKind::Fraction {
                numer: Box::new(n_box),
                denom: Box::new(d_box),
                bar_inset,
            },
        }
    }

    fn layout_atop(&self, top: &EqNode, bottom: &EqNode, fs: f64) -> LayoutBox {
        let t = self.layout_node(top, fs);
        let b = self.layout_node(bottom, fs);

        let pad = fs * FRAC_LINE_PAD;
        let axis = fs * AXIS_HEIGHT;
        let w = t.width.max(b.width) + pad * 2.0;

        let top_h = t.height + pad;
        let bottom_h = b.height + pad;
        let baseline = top_h + axis;
        let total_h = top_h + bottom_h;

        let mut top_box = t;
        top_box.x = (w - top_box.width) / 2.0;
        top_box.y = pad;

        let mut bottom_box = b;
        bottom_box.x = (w - bottom_box.width) / 2.0;
        bottom_box.y = top_h;

        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: w,
            height: total_h,
            baseline,
            kind: LayoutKind::Atop {
                top: Box::new(top_box),
                bottom: Box::new(bottom_box),
            },
        }
    }

    fn layout_sqrt(&self, index: &Option<Box<EqNode>>, body: &EqNode, fs: f64) -> LayoutBox {
        let b = self.layout_node(body, fs);
        let pad = fs * SQRT_PAD;
        // Modern HY superscript roots use the script's em for their sign slot.
        // The outer equation's em makes `2^{sqrt 2}` wider than Hancom by nearly
        // 4px at a 12px base. Older HFT roots keep their fixed outer-em slot.
        let sign_w = if self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font)
        {
            if self.is_modern_hy() {
                fs
            } else {
                self.font_size
            }
        } else {
            fs * 0.6
        };
        // 근호 획은 본문 잉크 오른쪽에 작은 여백을 남긴다. HYhwpEQ 이탤릭 d
        // (E0E8)는 12px에서 잉크 끝 528/1024em=6.19px, 힌팅 advance 5.4px로
        // 약 0.07em 넘친다. 실제 끝 글립의 잉크 범위를 사용해 Roman 선언이나
        // 다른 변수 자형을 구분한다. 숫자는 HY의 원래 hmtx advance와 현대
        // 픽셀 힌팅 advance 사이의 차이만큼 근호 뒤의 자연폭을 보존한다.
        // 이 값은 근호 자신의 em에서 구하므로 독립/첨자 문맥에 의존하지 않는다.
        let numeric_hint_gap = match body {
            EqNode::Number(text)
                if !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()) =>
            {
                super::measure::legacy_natural_width(text, fs)
                    .map_or(0.0, |natural| (natural - b.width).max(0.0))
            }
            _ => 0.0,
        };
        let body_w = b.width
            + pad
            + if self.is_modern_hy() {
                fs * if b.height > fs * 1.05 {
                    0.06
                } else {
                    (self.trailing_radical_ink_overhang(body, fs) / fs)
                        .max(numeric_hint_gap / fs)
                        .min(0.07)
                }
            } else {
                0.0
            };
        let body_h = b.height + pad * 2.0;

        let legacy = self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font);
        let idx = index.as_ref().map(|i| {
            // legacy 지수는 2차 첨자 크기(0.5em)다 (eq-002 실측 4.56pt@9.06).
            self.layout_node(i, fs * if legacy { 0.5 } else { SCRIPT_SCALE })
        });
        let idx_w = idx.as_ref().map(|i| i.width).unwrap_or(0.0);
        let total_w = idx_w.max(sign_w * 0.5) + sign_w * 0.5 + body_w;

        let mut body_box = b;
        body_box.x = total_w - body_w + pad * 0.5;
        body_box.y = pad;

        let idx = idx.map(|mut ib| {
            if legacy {
                // 지수는 기호 zone 안쪽 +0.26em 지점에, 기준선은 본문 기준선
                // −0.57em 높이에 놓인다 (eq-002 실측 4@sign+2.4pt, baseline−5.16pt).
                ib.x = body_box.x - sign_w + fs * 0.26;
                let sb = body_box.y + body_box.baseline;
                ib.y = sb - fs * 0.57 - ib.baseline;
            } else {
                ib.x = 0.0;
                ib.y = 0.0;
            }
            ib
        });

        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: total_w,
            height: body_h,
            baseline: body_box.y + body_box.baseline,
            kind: LayoutKind::Sqrt {
                index: idx.map(Box::new),
                body: Box::new(body_box),
            },
        }
    }

    // legacy 서체의 첨자 크기는 본문의 0.68em (eq-002 실측 sup 글립 6.18pt@9.06).
    fn script_font_size(&self, fs: f64) -> f64 {
        if self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font)
        {
            fs * 0.68
        } else {
            fs * SCRIPT_SCALE
        }
    }

    fn ends_in_latin_capital(node: &EqNode) -> bool {
        match node {
            EqNode::Text(text) | EqNode::Quoted(text) => text
                .chars()
                .last()
                .is_some_and(|ch| ch.is_ascii_uppercase()),
            EqNode::FontStyle { body, .. }
            | EqNode::FontDeclaration { body, .. }
            | EqNode::Color { body, .. } => Self::ends_in_latin_capital(body),
            EqNode::Row(children) => children.last().is_some_and(Self::ends_in_latin_capital),
            _ => false,
        }
    }

    fn ends_in_capital_superscript(node: &EqNode) -> bool {
        match node {
            EqNode::Superscript { base, .. } | EqNode::SubSup { base, .. } => {
                Self::ends_in_latin_capital(base)
            }
            EqNode::FontStyle { body, .. }
            | EqNode::FontDeclaration { body, .. }
            | EqNode::Color { body, .. } => Self::ends_in_capital_superscript(body),
            EqNode::Row(children) => children
                .last()
                .is_some_and(Self::ends_in_capital_superscript),
            _ => false,
        }
    }

    fn modern_capital_superscript_gap(&self, node: &EqNode, fs: f64) -> f64 {
        if self.has_modern_hy_metrics(fs) && Self::ends_in_latin_capital(node) {
            // 현대 HY의 Latin 대문자 위첨자 보정. HFT의 1/6em 간격과 구별한다.
            fs * 0.15
        } else {
            0.0
        }
    }

    /// 위첨자의 대문자 보정은 잉크 범위를 넓히지만 다음 수학 원자의 커서는 넓히지 않는다.
    /// 명시 서체 선언은 이전 run의 전체 범위를 닫으므로 이 overhang을 유지한다.
    fn modern_script_overhang(layout: &LayoutBox) -> f64 {
        match &layout.kind {
            LayoutKind::FontStyle { body, .. } => Self::modern_script_overhang(body),
            LayoutKind::Row(children) => {
                let Some((last, preceding)) = children.split_last() else {
                    return 0.0;
                };
                let logical = preceding.iter().map(|child| child.x + child.width).fold(
                    last.x + last.width - Self::modern_script_overhang(last),
                    f64::max,
                );
                (layout.width - logical).max(0.0)
            }
            LayoutKind::Superscript { base, sup } => (sup.x - base.width).max(0.0),
            LayoutKind::SubSup { base, sub, sup } => {
                let correction = (sup.x - base.width).max(0.0);
                let logical = base
                    .width
                    .max(sub.x + sub.width)
                    .max(sup.x + sup.width - correction);
                (layout.width - logical).max(0.0)
            }
            _ => 0.0,
        }
    }

    fn layout_superscript(&self, base: &EqNode, sup: &EqNode, fs: f64) -> LayoutBox {
        let legacy = self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font);
        let b = self.layout_node(base, fs);
        let s = self.layout_node(sup, self.script_font_size(fs));

        if legacy {
            // legacy 위첨자: sup 상자 *하단*이 base 기준선 위 ~0.30em에 걸린다.
            // (eq-002 실측 재측정: leaf `2`→2.8pt, 분수 sup→3.4pt@9.06)
            // 분수 sup 처럼 하단이 구조적 padding 으로 부풀려진 상자는 실제
            // 자식 배치 하단(content_bottom)을 앵커로 쓴다 — 잎의 em 꼬리
            // (baseline 아래 0.2em)까지만 들어가고 그 아래 pad 는 빠진다.
            // A tall fraction in round parentheses carries its baseline down
            // inside the fraction. HY attaches the exponent at the ordinary
            // nucleus baseline: in Mock Q1 the 2+√2 begins above the paren top.
            // 큰 대괄호의 끝점 첨자도 같은 본체 기준선에 붙는다. 한컴의
            // 분수/PILE 대괄호 상한은 괄호 상단보다 위에 있고, 안쪽 지수와
            // 같은 줄까지 내려오지 않는다.
            let fraction_in_round_parens = matches!(
                &b.kind,
                LayoutKind::Paren { left, right, body, .. }
                    if left == "(" && right == ")" && matches!(&body.kind, LayoutKind::Fraction { .. })
            );
            let tall_square_eval = matches!(
                &b.kind,
                LayoutKind::Paren { left, right, .. }
                    if left == "[" && right == "]" && b.height > fs * 1.2
            );
            let mut attach_baseline =
                if self.is_modern_hy() && (fraction_in_round_parens || tall_square_eval) {
                    b.baseline.min(fs * 0.8)
                } else {
                    b.baseline
                };
            if self.is_modern_hy()
                && matches!(
                    &b.kind,
                    LayoutKind::Paren { left, right, body, .. }
                        if left == "(" && right == ")"
                            && matches!(&body.kind, LayoutKind::Superscript { .. })
                )
            {
                // Hancom attaches an exponent above the nucleus of a parenthesized
                // power. A second exponent sits 1.5pt higher at 9pt in Mock Q1.
                attach_baseline -= fs * 0.17;
            }
            // 큰 대괄호의 분수 상한은 분모 하단 대신 수식 기준선에 붙는다.
            // 보통 첨자의 기준선 아래 0.2em 여백을 유지한다.
            let sup_bottom = if self.is_modern_hy()
                && tall_square_eval
                && matches!(&s.kind, LayoutKind::Fraction { .. })
            {
                s.baseline + self.script_font_size(fs) * 0.2
            } else {
                content_bottom(&s)
            };
            let mut sup_y = attach_baseline - fs * 0.30 - sup_bottom;
            let mut base_y = 0.0;
            if sup_y < 0.0 {
                base_y = -sup_y;
                sup_y = 0.0;
            }
            let total_h = (base_y + b.height).max(sup_y + s.height);
            let mut base_box = b;
            base_box.x = 0.0;
            base_box.y = base_y;
            let mut sup_box = s;
            sup_box.x = base_box.width
                + if self.has_modern_hy_metrics(fs) {
                    self.modern_capital_superscript_gap(base, fs)
                } else {
                    fs * THIN_SPACE_EM
                };
            sup_box.y = sup_y;
            let total_w = sup_box.x + sup_box.width;
            return LayoutBox {
                glyph_advances: None,
                x: 0.0,
                y: 0.0,
                width: total_w,
                height: total_h,
                baseline: base_box.y + base_box.baseline,
                kind: LayoutKind::Superscript {
                    base: Box::new(base_box),
                    sup: Box::new(sup_box),
                },
            };
        }

        // sup_shift: 기준선으로부터 위첨자 상단까지의 거리 (양수 = base 상단 아래)
        let sup_shift = b.baseline - s.height * 0.7;

        let (base_y, sup_y, total_h);
        if sup_shift >= 0.0 {
            // [Task #1300] 위첨자 상단을 base 상단에 맞춘다 (한컴 정합).
            // 기존엔 base 를 sup_shift(=b.baseline 비례) 만큼 아래로 밀어 위첨자를
            // 박스 최상단에 두었는데, 키 큰 base(괄호 분수 등)에서 위첨자가 base 상단
            // 위로 과하게 치솟아 윗줄을 침범했다(#1300). base 를 밀지 않고(상단 정렬)
            // 위첨자 상단이 base 상단과 같은 높이에 오도록 한다.
            // base 가 sup 보다 낮은 경우만 sup 를 담도록 base 를 내린다.
            sup_y = 0.0;
            base_y = (s.height - b.height).max(0.0);
            total_h = (base_y + b.height).max(s.height);
        } else {
            // 위첨자가 base 상단 위로 확장 — sup를 상단에, base를 |sup_shift|만큼 내림
            sup_y = 0.0;
            base_y = -sup_shift;
            total_h = (base_y + b.height).max(s.height);
        }

        let mut base_box = b;
        base_box.x = 0.0;
        base_box.y = base_y;

        let mut sup_box = s;
        // 한컴 legacy 수식의 위첨자 간격은 base 잉크 끝에서 ~thin
        // (eq-002 실측: `3`→`⅛` 상자 1.62pt@9.06).
        let sup_gap = if self.has_modern_hy_metrics(fs) {
            0.0
        } else if self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font)
        {
            fs * THIN_SPACE_EM
        } else {
            0.0
        };
        sup_box.x = base_box.width + sup_gap;
        sup_box.y = sup_y;

        let total_w = sup_box.x + sup_box.width;

        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: total_w,
            height: total_h,
            baseline: base_box.y + base_box.baseline,
            kind: LayoutKind::Superscript {
                base: Box::new(base_box),
                sup: Box::new(sup_box),
            },
        }
    }

    fn layout_subscript(&self, base: &EqNode, sub: &EqNode, fs: f64) -> LayoutBox {
        let b = self.layout_node(base, fs);
        let s = self.layout_node(sub, self.script_font_size(fs));

        // 버전60의 아래첨자 기준선은 본체 em 하단보다 0.05em 아래다.
        // 단일 글자는 본체 기준선 +0.25em, 분수는 분모 아래에 같은 간격을 둔다.
        let sub_shift = if self.is_modern_hy() {
            content_bottom(&b) + fs * 0.05 - s.baseline
        } else {
            b.baseline * 0.4
        };
        let total_h = (b.height).max(sub_shift + s.height);

        let mut base_box = b;
        base_box.x = 0.0;
        base_box.y = 0.0;

        let mut sub_box = s;
        // 아래첨자는 이탤릭 보정 전 advance에 붙는다 (TeX rule 18).
        // legacy 서체는 첨자 앞 thin space를 둔다 (위첨자와 같은 규칙).
        let sub_gap = if self.has_modern_hy_metrics(fs) {
            0.0
        } else if self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font)
        {
            fs * THIN_SPACE_EM
        } else {
            0.0
        };
        // Attach at the barred glyph's ink edge. Keep the trailing side
        // margin for the next atom's spacing decision.
        let bar_side = if self.has_modern_hy_metrics(fs) && Self::is_bar_decoration(base) {
            fs * MODERN_DECO_SIDE_EM
        } else {
            0.0
        };
        sub_box.x = base_box.width + sub_gap - self.trailing_italic_correction(base, fs) - bar_side;
        sub_box.y = sub_shift;

        let total_w = base_box.width.max(sub_box.x + sub_box.width);

        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: total_w,
            height: total_h,
            baseline: base_box.baseline,
            kind: LayoutKind::Subscript {
                base: Box::new(base_box),
                sub: Box::new(sub_box),
            },
        }
    }

    fn layout_subsup(&self, base: &EqNode, sub: &EqNode, sup: &EqNode, fs: f64) -> LayoutBox {
        // 적분 기호: 상한은 기호 상단, 하한은 기호 하단에 맞춤
        let is_integral = matches!(base, EqNode::MathSymbol(s) if is_integral_symbol(s));

        let b = self.layout_node(base, fs);
        let sb = self.layout_node(sub, self.script_font_size(fs));
        let sp = self.layout_node(sup, self.script_font_size(fs));
        let upper_is_fraction = matches!(sp.kind, LayoutKind::Fraction { .. });
        let upper_is_mixed_fraction = match &sp.kind {
            LayoutKind::Row(children) => children
                .iter()
                .any(|child| matches!(child.kind, LayoutKind::Fraction { .. })),
            _ => false,
        };

        if is_integral {
            // 적분 전용 배치 (Task #1317): 글리프를 stroke path 로 그리므로 상·하한 attach
            // point 를 path 기하(`integral_geom`)에 맞춰 산출한다. SVG/Canvas/Skia 가 동일
            // geom 을 공유하여 폰트 대체에 무관하게 정합한다(정답 한글 2022 비례).
            //   - 상한(sup): 상단 갈고리 우측, 글리프 최상단 근처
            //   - 하한(sub): 하단 갈고리 우측, 글리프 최하단(=baseline 근처)
            let geom = integral_geom(fs);
            // 상·하한이 적분 줄기에 붙지 않도록 **가로 간격(gap_x)만** 키워 띄운다.
            // 세로로 벌리면 적분 박스 높이가 커져 줄 간격이 위/아래로 넓어지므로
            // 세로 위치는 컴팩트하게 유지한다 (작업지시자 피드백, Task #1317 v4).
            let gap_x = fs * 0.22;

            let mut base_box = b;
            base_box.x = 0.0;
            base_box.width = geom.width; // 글리프 advance = path 폭

            // 글리프 기준 첨자 세로 위치(박스 상단 원점) — 컴팩트(글리프 상·하단 근처).
            let sup_dy = geom.top_y - sp.height * 0.30; // 상한: 최상단 근처
            let sub_dy = geom.bottom_y - sb.height * 0.72; // 하한: 최하단 근처

            // 상한이 박스 위로 넘치지 않도록 글리프를 그만큼 아래로 내린다.
            let head = (-sup_dy).max(0.0);
            base_box.y = head;

            let mut sup_box = sp;
            sup_box.x = base_box.x + geom.top_hook_x + gap_x;
            sup_box.y = base_box.y + sup_dy;

            let mut sub_box = sb;
            sub_box.x = base_box.x + geom.bottom_hook_x + gap_x;
            sub_box.y = base_box.y + sub_dy;

            // Modern HY paints the 18pt integral glyph in a 9pt equation. Its
            // limits attach at the source PDF's hook positions (1.293em upper,
            // 0.747em lower). The next operand follows their positioned right
            // edge, so reserve width after moving the limits. Vertical metrics
            // retain the existing line-flow box.
            let right = (sup_box.x + sup_box.width)
                .max(sub_box.x + sub_box.width)
                .max(base_box.x + geom.width);
            let mut total_w = right + fs * BIG_OP_TRAIL_PAD;
            if self.is_modern_hy() {
                sup_box.x = fs * 1.293;
                sub_box.x = fs * 0.747;
                // The painted integral sits below the stroke-path attachment.
                // Hancom's plain upper limits are 0.33em lower at 6–12pt;
                // a mixed fraction + term needs only 0.11em, and a standalone
                // fraction already aligns at the old attachment point.
                sup_box.y += fs
                    * if upper_is_fraction {
                        0.0
                    } else if upper_is_mixed_fraction {
                        0.11
                    } else {
                        0.33
                    };
                total_w = (sup_box.x + sup_box.width)
                    .max(sub_box.x + sub_box.width)
                    .max(base_box.x + geom.width);
            }
            let total_h = (sub_box.y + sub_box.height)
                .max(base_box.y + base_box.height)
                .max(sup_box.y + sup_box.height);

            return LayoutBox {
                glyph_advances: None,
                x: 0.0,
                y: 0.0,
                width: total_w,
                height: total_h,
                baseline: base_box.y + base_box.baseline,
                kind: LayoutKind::SubSup {
                    base: Box::new(base_box),
                    sub: Box::new(sub_box),
                    sup: Box::new(sup_box),
                },
            };
        }

        if self.is_modern_hy() {
            let mut upper = self.layout_superscript(base, sup, fs);
            let lower = self.layout_subscript(base, sub, fs);
            if let (LayoutKind::Superscript { base, sup }, LayoutKind::Subscript { sub, .. }) =
                (&mut upper.kind, lower.kind)
            {
                let mut sub = sub;
                sub.y += base.y;
                return LayoutBox {
                    glyph_advances: None,
                    x: 0.0,
                    y: 0.0,
                    width: upper.width.max(sub.x + sub.width),
                    height: upper.height.max(sub.y + sub.height),
                    baseline: upper.baseline,
                    kind: LayoutKind::SubSup {
                        base: base.clone(),
                        sub,
                        sup: sup.clone(),
                    },
                };
            }
            unreachable!("script layout kinds");
        }

        let sup_shift = b.baseline - sp.height * 0.7;
        let sub_shift = b.baseline * 0.4;

        let ascent = if sup_shift < 0.0 {
            sp.height - sup_shift.abs()
        } else {
            sp.height.max(0.0)
        };
        let top = sup_shift.min(0.0).abs();
        let total_h = (top + b.height)
            .max(top + sub_shift + sb.height)
            .max(ascent + b.height);

        let base_y = top.max(
            if sup_shift > 0.0 {
                0.0
            } else {
                sp.height - sup_shift.abs() - b.baseline
            }
            .max(0.0),
        );

        let mut base_box = b;
        base_box.x = 0.0;
        base_box.y = base_y;

        // legacy 서체는 첨자 앞 thin space (layout_superscript/subscript와 같은 규칙).
        let script_gap = if self.has_modern_hy_metrics(fs) {
            0.0
        } else if self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font)
        {
            fs * THIN_SPACE_EM
        } else {
            0.0
        };
        let mut sup_box = sp;
        sup_box.x = base_box.width + script_gap + self.modern_capital_superscript_gap(base, fs);
        sup_box.y = 0.0;

        let mut sub_box = sb;
        sub_box.x = base_box.width + script_gap - self.trailing_italic_correction(base, fs);
        sub_box.y = base_y + sub_shift;

        let total_w = (sup_box.x + sup_box.width).max(sub_box.x + sub_box.width);

        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: total_w,
            height: total_h
                .max(base_box.y + base_box.height)
                .max(sub_box.y + sub_box.height),
            baseline: base_box.y + base_box.baseline,
            kind: LayoutKind::SubSup {
                base: Box::new(base_box),
                sub: Box::new(sub_box),
                sup: Box::new(sup_box),
            },
        }
    }

    fn layout_big_op(
        &self,
        symbol: &str,
        sub: &Option<Box<EqNode>>,
        sup: &Option<Box<EqNode>>,
        fs: f64,
    ) -> LayoutBox {
        // 적분 기호: nolimits 스타일 (큰 기호 + 오른쪽 위/아래 첨자)
        if is_integral_symbol(symbol) {
            return self.layout_integral(symbol, sub, sup, fs);
        }
        // ∑, ∏ 등: limits 스타일 (위/아래 중앙)
        // Modern HYhwpEQ uses the font's large U+E067 sum glyph at 1.8 em.
        // Its 739/1024 advance almost touches the following operand.
        let modern_hy_sum = symbol == "∑" && self.is_modern_hy();
        let op_fs = fs
            * if modern_hy_sum {
                MODERN_HY_SUM_SCALE
            } else {
                BIG_OP_SCALE
            };
        let op_w = if modern_hy_sum {
            op_fs * MODERN_HY_SUM_ADVANCE_EM
        } else {
            estimate_text_width(symbol, op_fs, false)
        };
        let op_h = op_fs;

        let layout_limit = |node: &EqNode| match node {
            EqNode::Row(children) if modern_hy_sum => {
                self.layout_row_with_sum_limit(children, self.script_font_size(fs), true)
            }
            _ => self.layout_node(node, self.script_font_size(fs)),
        };
        let sub_box = sub.as_deref().map(layout_limit);
        let sup_box = sup.as_deref().map(layout_limit);

        let sup_h = sup_box
            .as_ref()
            .map(|b| b.height + fs * 0.05)
            .unwrap_or(0.0);
        let sub_h = sub_box
            .as_ref()
            .map(|b| b.height + fs * 0.05)
            .unwrap_or(0.0);

        let total_h = sup_h + op_h + sub_h;
        let max_w = [
            op_w,
            sub_box.as_ref().map(|b| b.width).unwrap_or(0.0),
            sup_box.as_ref().map(|b| b.width).unwrap_or(0.0),
        ]
        .iter()
        .copied()
        .fold(0.0f64, f64::max);

        let baseline = sup_h + op_h * 0.6;

        let sup_laid = sup_box.map(|mut b| {
            b.x = (max_w - b.width) / 2.0;
            b.y = if modern_hy_sum { fs * 0.08 } else { 0.0 };
            b
        });
        let sub_laid = sub_box.map(|mut b| {
            b.x = if modern_hy_sum {
                0.0
            } else {
                (max_w - b.width) / 2.0
            };
            b.y = sup_h + op_h - if modern_hy_sum { fs * 0.36 } else { 0.0 };
            b
        });

        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            // 현대 HY Σ는 limit stack 폭을 쓰고 아래첨자를 왼쪽에 붙인다.
            // 다른 큰 연산자는 종전 trailing 간격과 중앙 정렬을 유지한다.
            width: max_w
                + fs * if modern_hy_sum {
                    MODERN_HY_SUM_TRAIL_PAD
                } else {
                    BIG_OP_TRAIL_PAD
                },
            height: total_h,
            baseline,
            kind: LayoutKind::BigOp {
                symbol: symbol.to_string(),
                sub: sub_laid.map(Box::new),
                sup: sup_laid.map(Box::new),
            },
        }
    }

    /// 적분 기호 레이아웃: 큰 기호 + 오른쪽 위/아래 첨자 (nolimits 스타일)
    fn layout_integral(
        &self,
        symbol: &str,
        sub: &Option<Box<EqNode>>,
        sup: &Option<Box<EqNode>>,
        fs: f64,
    ) -> LayoutBox {
        let op_fs = fs * BIG_OP_SCALE;
        let op_w = estimate_text_width(symbol, op_fs, false);
        let op_h = op_fs;

        let sub_box = sub
            .as_ref()
            .map(|s| self.layout_node(s, self.script_font_size(fs)));
        let sup_box = sup
            .as_ref()
            .map(|s| self.layout_node(s, self.script_font_size(fs)));

        // 기호 기준선: 기호 높이의 60% (중앙보다 약간 위)
        let op_baseline = op_h * 0.6;

        // 위첨자: 기호 오른쪽 위
        let sup_shift = op_h * 0.1; // 기호 상단에서 약간 아래
                                    // 아래첨자: 기호 오른쪽 아래
        let sub_shift = op_h * 0.55; // 기호 중앙 아래

        let script_x = op_w; // 첨자는 기호 오른쪽에 배치

        let mut total_w = op_w;
        let mut total_h = op_h;

        let sup_laid = sup_box.map(|mut b| {
            b.x = script_x;
            b.y = sup_shift;
            total_w = total_w.max(script_x + b.width);
            b
        });

        let sub_laid = sub_box.map(|mut b| {
            b.x = script_x;
            b.y = sub_shift;
            total_w = total_w.max(script_x + b.width);
            total_h = total_h.max(sub_shift + b.height);
            b
        });

        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            // Task #1233: 적분 뒤 피연산자(예: f(x)dx)가 첨자에 붙지 않도록 trailing 간격.
            width: total_w + fs * BIG_OP_TRAIL_PAD,
            height: total_h,
            baseline: op_baseline,
            kind: LayoutKind::BigOp {
                symbol: symbol.to_string(),
                sub: sub_laid.map(Box::new),
                sup: sup_laid.map(Box::new),
            },
        }
    }

    fn layout_limit(&self, is_upper: bool, sub: &Option<Box<EqNode>>, fs: f64) -> LayoutBox {
        let name = if is_upper { "Lim" } else { "lim" };
        // 현대 HY는 이름을 1.2배 Roman으로 칠한다. 이름 칸은 힌팅한 advance를
        // 0.9 포개기 없이 예약하고, 넓은 하한과 가운데를 맞춘다.
        let modern = self.has_modern_hy_metrics(fs);
        let name_fs = if modern { fs * LIMIT_NAME_SCALE } else { fs };
        let name_w = if modern {
            self.text_metrics(name, name_fs, false, false, false).0
                / super::font::EQUATION_GLYPH_TRACKING
        } else {
            self.text_metrics(name, fs, false, false, false).0
        };
        let name_h = name_fs;
        let sub_fs = if modern {
            self.script_font_size(fs)
        } else {
            fs * SCRIPT_SCALE
        };

        let sub_box = sub.as_ref().map(|s| self.layout_node(s, sub_fs));
        let sub_h = sub_box
            .as_ref()
            .map(|b| b.height + fs * 0.05)
            .unwrap_or(0.0);
        let sub_w = sub_box.as_ref().map(|b| b.width).unwrap_or(0.0);

        let w = name_w.max(sub_w);
        let total_h = name_h + sub_h;

        let sub_laid = sub_box.map(|mut b| {
            b.x = (w - b.width) / 2.0;
            b.y = name_h + if modern { fs * 0.05 } else { 0.0 };
            b
        });

        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: w,
            height: total_h,
            baseline: name_fs * 0.8,
            kind: LayoutKind::Limit {
                is_upper,
                sub: sub_laid.map(Box::new),
                name_x: if modern { (w - name_w) / 2.0 } else { 0.0 },
                // 확대된 이름은 본문 연산자 기준선보다 낮다. 한컴 6/9/12pt
                // 대조에서 이 원점은 반올림 오차 0.18pt 안으로 일치한다.
                name_y: if modern { fs * 0.13 } else { 0.0 },
            },
        }
    }

    fn layout_matrix(&self, rows: &[Vec<EqNode>], style: MatrixStyle, fs: f64) -> LayoutBox {
        if rows.is_empty() {
            return LayoutBox {
                glyph_advances: None,
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: fs,
                baseline: fs * 0.8,
                kind: LayoutKind::Empty,
            };
        }

        let col_gap = fs * MATRIX_COL_GAP;
        let row_gap = fs * MATRIX_ROW_GAP;

        // 모든 셀 레이아웃
        let mut cell_boxes: Vec<Vec<LayoutBox>> = rows
            .iter()
            .map(|row| row.iter().map(|c| self.layout_node(c, fs)).collect())
            .collect();

        let num_cols = cell_boxes.iter().map(|r| r.len()).max().unwrap_or(0);

        // 열 폭 계산
        let mut col_widths = vec![0.0f64; num_cols];
        for row in &cell_boxes {
            for (ci, cell) in row.iter().enumerate() {
                if ci < num_cols {
                    col_widths[ci] = col_widths[ci].max(cell.width);
                }
            }
        }

        // 행 높이 계산
        let mut row_heights: Vec<f64> = cell_boxes
            .iter()
            .map(|row| row.iter().map(|c| c.height).fold(fs, f64::max))
            .collect();

        // 셀 위치 배정
        let mut y = 0.0;
        for (ri, row) in cell_boxes.iter_mut().enumerate() {
            let rh = row_heights[ri];
            let mut x = 0.0;
            for (ci, cell) in row.iter_mut().enumerate() {
                let cw = if ci < num_cols {
                    col_widths[ci]
                } else {
                    cell.width
                };
                cell.x = x + (cw - cell.width) / 2.0;
                cell.y = y + (rh - cell.height) / 2.0;
                x += cw + if ci + 1 < num_cols { col_gap } else { 0.0 };
            }
            y += rh + row_gap;
        }

        let total_w: f64 =
            col_widths.iter().sum::<f64>() + col_gap * (num_cols.saturating_sub(1)) as f64;
        let total_h = y - row_gap;
        let bracket_pad = fs * 0.2;

        // 괄호 포함 폭
        let paren_w = match style {
            MatrixStyle::Plain => 0.0,
            _ => fs * 0.3,
        };
        let full_w = total_w + paren_w * 2.0 + bracket_pad * 2.0;

        // 셀 x 오프셋 (괄호 포함)
        let x_offset = paren_w + bracket_pad;
        for row in &mut cell_boxes {
            for cell in row.iter_mut() {
                cell.x += x_offset;
            }
        }

        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: full_w,
            height: total_h,
            baseline: total_h / 2.0,
            kind: LayoutKind::Matrix {
                cells: cell_boxes,
                style,
            },
        }
    }

    /// 현대 HY 경우 나눔(cases). 한컴 probe/math-001 실측:
    /// - 줄 간격은 내용과 무관하게 1.17em, 전체 줄의 가운데가 수식 기준선이다
    ///   (`cases{a#b}` 13.0pt@11, math-001 세 줄 397.32/·/423.12 ↔ 기준선 410.16).
    /// - eqalign 의 줄은 그대로 줄 수에 들어간다 (끝의 빈 행도 한 줄).
    /// - `&` 는 열을 나눈다. 첫 `&` 는 0.19em, 이어진 `&` 는 각각 0.70em을 더한다.
    /// - 중괄호 0.48em 뒤에 내용이 온다.
    fn layout_cases_modern(&self, rows: &[EqNode], fs: f64) -> LayoutBox {
        let pitch = fs * MODERN_CASES_LINE_EM;
        // 행을 `&` 묶음 기준 셀로 나눈다: (셀 노드, 앞 구분자의 & 수).
        let split = |row: &EqNode| -> Vec<(Vec<EqNode>, usize)> {
            let children: Vec<EqNode> = match row {
                EqNode::Row(children) => children.clone(),
                other => vec![other.clone()],
            };
            let mut cells = vec![(Vec::new(), 0usize)];
            let mut amps = 0usize;
            for child in children {
                if matches!(child, EqNode::Space(SpaceKind::Tab)) {
                    amps += 1;
                    continue;
                }
                if amps > 0 {
                    cells.push((Vec::new(), amps));
                    amps = 0;
                }
                cells.last_mut().unwrap().0.push(child);
            }
            cells
        };
        let lines_of = |node: &EqNode| -> usize {
            match node {
                EqNode::EqAlign { rows } => rows.len().max(1),
                EqNode::Row(children) if children.len() == 1 => match &children[0] {
                    EqNode::EqAlign { rows } => rows.len().max(1),
                    _ => 1,
                },
                _ => 1,
            }
        };
        let rows_cells: Vec<Vec<(LayoutBox, usize, usize)>> = rows
            .iter()
            .map(|row| {
                split(row)
                    .into_iter()
                    .map(|(nodes, amps)| {
                        let node = EqNode::Row(nodes).simplify();
                        let lines = lines_of(&node);
                        (self.layout_node(&node, fs), amps, lines)
                    })
                    .collect()
            })
            .collect();
        // 분수처럼 위아래로 쌓인 항이 있는 행. 위첨자(x^2) 같은 일반 행은 고정 pitch 를 지킨다.
        let row_stacked: Vec<bool> = rows
            .iter()
            .map(|row| {
                let children: &[EqNode] = match row {
                    EqNode::Row(children) => children,
                    other => std::slice::from_ref(other),
                };
                children
                    .iter()
                    .any(|n| matches!(n, EqNode::Fraction { .. } | EqNode::Atop { .. }))
            })
            .collect();
        let cols = rows_cells.iter().map(Vec::len).max().unwrap_or(0);
        let mut col_w = vec![0.0f64; cols];
        let mut col_amps = vec![0usize; cols];
        for cells in &rows_cells {
            for (k, (cell, amps, _)) in cells.iter().enumerate() {
                // eqalign은 오른쪽 정렬 열 앞에 0.5em을 예약한다. 오른쪽 열이
                // 비어 있으면 이 여백을 다음 cases 열 위치에 반영하지 않는다.
                let width = match &cell.kind {
                    LayoutKind::EqAlign { rows }
                        if rows.iter().all(|(_, right)| right.width == 0.0) =>
                    {
                        (cell.width - fs * 0.5).max(0.0)
                    }
                    _ => cell.width,
                };
                col_w[k] = col_w[k].max(width);
                col_amps[k] = col_amps[k].max(*amps);
            }
        }
        let brace = fs * MODERN_BRACE_EM;
        let mut col_x = vec![0.0f64; cols];
        let mut cx = 0.0;
        for k in 0..cols {
            if k > 0 {
                let amps = col_amps[k];
                let gap = if amps == 0 {
                    0.0
                } else {
                    fs * (MODERN_CASES_COL_GAP_EM + (amps - 1) as f64 * MODERN_CASES_EXTRA_AMP_EM)
                };
                cx += col_w[k - 1] + gap;
            }
            col_x[k] = cx;
        }
        let content_w = if cols > 0 {
            col_x[cols - 1] + col_w[cols - 1]
        } else {
            0.0
        };
        let total_lines: usize = rows_cells
            .iter()
            .map(|cells| cells.iter().map(|c| c.2).max().unwrap_or(1))
            .sum::<usize>()
            .max(1);
        // 첫 줄 기준선 = 0 으로 놓고 셀 상자를 쌓는다.
        // 행 간격은 한 줄 pitch 가 기본이지만, 분수처럼 키 큰 행은 앞 행 아래와
        // 겹치지 않게 내려간다 (한컴: 단순 행 1.15em, 1/3 행 1.88em).
        let mut line = 0usize;
        let mut row_boxes = Vec::new();
        let mut top = 0.0f64;
        let mut bottom = 0.0f64;
        let mut shift = 0.0f64;
        let mut prev_row_bottom: Option<f64> = None;
        let mut last_base = 0.0f64;
        for (row_idx, cells) in rows_cells.into_iter().enumerate() {
            let lines = cells.iter().map(|c| c.2).max().unwrap_or(1);
            let stacked_pair = row_stacked.get(row_idx).copied().unwrap_or(false)
                || (row_idx > 0 && row_stacked.get(row_idx - 1).copied().unwrap_or(false));
            let ascent = cells.iter().map(|c| c.0.baseline).fold(0.0f64, f64::max);
            let mut base = line as f64 * pitch + shift;
            if let Some(prev_bottom) = prev_row_bottom.filter(|_| stacked_pair) {
                let needed = prev_bottom + fs * MODERN_CASES_ROW_GAP_EM + ascent;
                if needed > base {
                    shift += needed - base;
                    base = needed;
                }
            }
            let descent = cells
                .iter()
                .map(|c| c.0.height - c.0.baseline)
                .fold(0.0f64, f64::max);
            prev_row_bottom = Some(base + (lines - 1) as f64 * pitch + descent);
            last_base = base + (lines - 1) as f64 * pitch;
            // 같은 행의 셀은 첫 셀의 상자 중심에 맞춘다. 위첨자가 첫 셀을
            // 키우면 조건식 기준선도 그 중심을 따라 올라간다 (x²-a 옆 조건식).
            let center = cells
                .first()
                .map(|(cell, _, _)| base - cell.baseline + cell.height / 2.0)
                .unwrap_or(base);
            let mut boxes = Vec::new();
            for (k, (mut cell, _, _)) in cells.into_iter().enumerate() {
                cell.x = col_x[k];
                cell.y = center - cell.height / 2.0;
                top = top.min(cell.y);
                bottom = bottom.max(cell.y + cell.height);
                boxes.push(cell);
            }
            row_boxes.extend(boxes);
            line += lines;
        }
        let last = last_base;
        let plain_top = -fs * 0.8;
        let plain_bottom = last + fs * 0.2;
        top = top.min(plain_top);
        bottom = bottom.max(plain_bottom);
        // over 분수가 쌓인 행은 한쪽 끝으로 뻗은 높이만큼 기준선을 옮긴다.
        // atop과 일반 행의 위첨자 돌출은 줄 기준선을 바꾸지 않는다.
        let has_fraction = rows.iter().any(|row| {
            let children: &[EqNode] = match row {
                EqNode::Row(children) => children,
                other => std::slice::from_ref(other),
            };
            children
                .iter()
                .any(|n| matches!(n, EqNode::Fraction { .. }))
        });
        let baseline_from_first = if has_fraction {
            let extra_above = plain_top - top;
            let extra_below = bottom - plain_bottom;
            last / 2.0 + (extra_below - extra_above) / 2.0
        } else {
            last / 2.0
        };
        let height = bottom - top;
        for b in &mut row_boxes {
            b.y -= top;
        }
        let inner = LayoutBox {
            glyph_advances: None,
            x: brace,
            y: 0.0,
            width: content_w,
            height,
            baseline: -top + baseline_from_first,
            kind: LayoutKind::Row(row_boxes),
        };
        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: brace + content_w,
            height,
            baseline: -top + baseline_from_first,
            kind: LayoutKind::Paren {
                modern_extent: Some((-top - fs * 0.65, last + fs * 0.6)),
                left: "{".to_string(),
                right: String::new(),
                body: Box::new(inner),
            },
        }
    }

    fn layout_cases(&self, rows: &[EqNode], fs: f64) -> LayoutBox {
        if self.has_modern_hy_metrics(fs) {
            return self.layout_cases_modern(rows, fs);
        }
        let row_gap = fs * MATRIX_ROW_GAP;
        let mut row_boxes: Vec<LayoutBox> = rows.iter().map(|r| self.layout_node(r, fs)).collect();

        let max_w = row_boxes.iter().map(|b| b.width).fold(0.0f64, f64::max);
        let mut y = 0.0;
        for b in &mut row_boxes {
            b.x = fs * 0.3; // 왼쪽 중괄호 여백
            b.y = y;
            y += b.height + row_gap;
        }
        let total_h = y - row_gap;
        let full_w = max_w + fs * 0.6;

        // 중괄호 포함 레이아웃 → Paren으로 래핑
        let inner = LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: full_w,
            height: total_h,
            baseline: total_h / 2.0,
            kind: LayoutKind::Row(row_boxes),
        };

        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: full_w + fs * 0.3,
            height: total_h,
            baseline: total_h / 2.0,
            kind: LayoutKind::Paren {
                modern_extent: None,
                left: "{".to_string(),
                right: String::new(),
                body: Box::new(inner),
            },
        }
    }

    fn layout_rel(
        &self,
        arrow: &str,
        over: &EqNode,
        under: &Option<Box<EqNode>>,
        fs: f64,
    ) -> LayoutBox {
        let small_fs = fs * 0.7;
        let gap = fs * 0.1;

        // 화살표 레이아웃
        let mut arrow_box = self.layout_node(&EqNode::MathSymbol(arrow.to_string()), fs);
        // 위 내용
        let mut over_box = self.layout_node(over, small_fs);
        // 아래 내용
        let mut under_box = under.as_ref().map(|u| self.layout_node(u, small_fs));

        // 전체 폭: 가장 넓은 요소 기준
        let max_w = arrow_box
            .width
            .max(over_box.width)
            .max(under_box.as_ref().map(|u| u.width).unwrap_or(0.0));

        // 화살표 폭을 max_w로 확장 (시각적으로 늘림)
        arrow_box.width = max_w;

        // 세로 배치: over → arrow → under
        let mut y = 0.0;
        over_box.x = (max_w - over_box.width) / 2.0;
        over_box.y = y;
        y += over_box.height + gap;

        arrow_box.x = 0.0;
        arrow_box.y = y;
        let arrow_center_y = y + arrow_box.height / 2.0;
        y += arrow_box.height + gap;

        if let Some(ref mut ub) = under_box {
            ub.x = (max_w - ub.width) / 2.0;
            ub.y = y;
            y += ub.height;
        } else {
            y -= gap; // under가 없으면 마지막 gap 제거
        }

        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: max_w,
            height: y,
            baseline: arrow_center_y,
            kind: LayoutKind::Rel {
                arrow: Box::new(arrow_box),
                over: Box::new(over_box),
                under: under_box.map(Box::new),
            },
        }
    }

    /// 현대 HY eqalign: 줄 간격 1.17em, 기준선은 첫 줄, 왼쪽 열 오른쪽 정렬 뒤 0.5em.
    fn layout_eqalign_modern(&self, rows: &[(EqNode, EqNode)], fs: f64) -> LayoutBox {
        let pitch = fs * MODERN_CASES_LINE_EM;
        let gap = fs * 0.5;
        let mut laid: Vec<(LayoutBox, LayoutBox)> = rows
            .iter()
            .map(|(l, r)| (self.layout_node(l, fs), self.layout_node(r, fs)))
            .collect();
        let max_left = laid.iter().map(|(l, _)| l.width).fold(0.0f64, f64::max);
        let max_right = laid.iter().map(|(_, r)| r.width).fold(0.0f64, f64::max);
        let mut top = -fs * 0.8;
        let mut bottom = fs * 0.2;
        for (i, (left, right)) in laid.iter_mut().enumerate() {
            let base = i as f64 * pitch;
            left.x = max_left - left.width;
            right.x = max_left + gap;
            left.y = base - left.baseline;
            right.y = base - right.baseline;
            top = top.min(left.y).min(right.y);
            bottom = bottom
                .max(left.y + left.height)
                .max(right.y + right.height)
                .max(base + fs * 0.2);
        }
        for (left, right) in &mut laid {
            left.y -= top;
            right.y -= top;
        }
        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: max_left + gap + max_right,
            height: bottom - top,
            baseline: -top,
            kind: LayoutKind::EqAlign { rows: laid },
        }
    }

    fn layout_eqalign(&self, rows: &[(EqNode, EqNode)], fs: f64) -> LayoutBox {
        if self.has_modern_hy_metrics(fs) {
            return self.layout_eqalign_modern(rows, fs);
        }
        let row_gap = fs * MATRIX_ROW_GAP;
        let align_gap = fs * 0.15; // & 기준 좌우 사이 간격

        // 각 행의 왼쪽/오른쪽 레이아웃 계산
        let mut laid_rows: Vec<(LayoutBox, LayoutBox)> = rows
            .iter()
            .map(|(l, r)| (self.layout_node(l, fs), self.layout_node(r, fs)))
            .collect();

        // 왼쪽 최대 폭 (& 정렬 기준)
        let max_left_w = laid_rows
            .iter()
            .map(|(l, _)| l.width)
            .fold(0.0f64, f64::max);

        let mut y = 0.0;
        let mut total_w = 0.0f64;
        for (left, right) in &mut laid_rows {
            // 왼쪽: 오른쪽 정렬 (& 기준으로 맞춤)
            left.x = max_left_w - left.width;
            // 오른쪽: & 기준 바로 뒤
            right.x = max_left_w + align_gap;

            let row_h = left.height.max(right.height);
            let row_bl = left.baseline.max(right.baseline);
            // 베이스라인 정렬
            left.y = y + (row_bl - left.baseline);
            right.y = y + (row_bl - right.baseline);

            total_w = total_w.max(right.x + right.width);
            y += row_h + row_gap;
        }
        let total_h = (y - row_gap).max(0.0);

        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: total_w,
            height: total_h,
            baseline: total_h / 2.0,
            kind: LayoutKind::EqAlign { rows: laid_rows },
        }
    }

    fn layout_pile(&self, rows: &[EqNode], align: PileAlign, fs: f64) -> LayoutBox {
        let modern_hy = self.is_modern_hy();
        // 구형 HFT와 일반 서체는 종전 파서처럼 마지막 빈 행을 제외한다.
        let rows = if !modern_hy && matches!(rows.last(), Some(EqNode::Empty)) {
            &rows[..rows.len() - 1]
        } else {
            rows
        };
        // HYhwpEQ PILE 행 기준선 간격은 6/9/12pt 한컴 PDF 모두 약 1.15em.
        // 행 자체가 1em이므로 MATRIX의 0.30em 대신 0.15em을 둔다.
        let row_gap = fs * if modern_hy { 0.15 } else { MATRIX_ROW_GAP };
        let mut row_boxes: Vec<LayoutBox> = rows
            .iter()
            .map(|row| {
                if modern_hy && matches!(row, EqNode::Empty) {
                    // 빈 PILE 행은 0.5em 폭과 한 줄 높이를 차지한다.
                    // 명시 공백이 있는 행은 그 공백의 폭을 그대로 쓴다.
                    LayoutBox {
                        glyph_advances: None,
                        x: 0.0,
                        y: 0.0,
                        width: fs * 0.5,
                        height: fs,
                        baseline: fs * 0.8,
                        kind: LayoutKind::Empty,
                    }
                } else {
                    self.layout_node(row, fs)
                }
            })
            .collect();

        let empty_width = if modern_hy && rows.is_empty() {
            fs * 0.5
        } else {
            0.0
        };
        let max_w = row_boxes
            .iter()
            .map(|b| b.width)
            .fold(empty_width, f64::max);
        let mut y = 0.0;
        for b in &mut row_boxes {
            b.x = match align {
                PileAlign::Left => 0.0,
                PileAlign::Center => (max_w - b.width) / 2.0,
                PileAlign::Right => max_w - b.width,
            };
            b.y = y;
            y += b.height + row_gap;
        }
        let total_h = if modern_hy {
            (y - row_gap).max(0.0)
        } else {
            y - row_gap
        };
        // PILE의 기준선은 상자 높이의 절반이 아니라 가운데 행 기준선이다.
        // 짝수 행이면 가운데 두 행 기준선의 중간에 놓는다.
        let row_baseline = |index: usize| row_boxes[index].y + row_boxes[index].baseline;
        let baseline = if modern_hy {
            match row_boxes.len() {
                0 => 0.0,
                n if n % 2 == 1 => row_baseline(n / 2),
                n => (row_baseline(n / 2 - 1) + row_baseline(n / 2)) / 2.0,
            }
        } else {
            total_h / 2.0
        };

        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: max_w,
            height: total_h,
            baseline,
            kind: LayoutKind::Row(row_boxes),
        }
    }

    fn layout_paren(&self, left: &str, right: &str, body: &EqNode, fs: f64) -> LayoutBox {
        let b = self.layout_node(body, fs);
        let legacy = self
            .font_family
            .as_deref()
            .is_some_and(super::font::is_legacy_equation_font);
        let use_stretch_round = b.height > fs * 1.2 && matches!((left, right), ("(", ")"));
        // A split LEFT/RIGHT pair can live in separate EQEDIT controls.  The
        // surviving tall side uses the same HY glyph extent as a paired one.
        let modern_one_sided_round = b.height > fs * 1.2
            && self.is_modern_hy()
            && matches!((left, right), ("(", "") | ("", ")"));
        // legacy는 큰 대괄호도 e100..e105 파트 글립으로 늘린다 (02-eq-01 실측).
        let use_stretch_square =
            legacy && b.height > fs * 1.2 && matches!((left, right), ("[", "]"));
        // 현대 HY 괄호 묶음은 안쪽 여백 없이 내용에 붙는다 (probe `LEFT(x RIGHT)`:
        // `(`→x 3.72pt, x→`)` = x advance).
        let source_metrics = self.has_modern_hy_metrics(fs);
        let square_advances =
            (source_metrics && b.height <= fs * 1.2 && matches!((left, right), ("[", "]")))
                .then(|| {
                    super::font::registered_char_advance_em("HYhwpEQ", '\u{e049}').zip(
                        super::font::registered_char_advance_em("HYhwpEQ", '\u{e04a}'),
                    )
                })
                .flatten();
        let short_modern_square = square_advances.is_some();
        let pad = if source_metrics {
            0.0
        } else if use_stretch_round || use_stretch_square {
            fs * 0.03
        } else {
            fs * PAREN_PAD
        };
        let left_pad = if short_modern_square {
            fs * MODERN_SHORT_SQUARE_PAD_EM
        } else {
            pad
        };
        let right_pad = left_pad;
        // Times New Roman '(' advance (em 기준) = 0.333. 텍스트 높이 glyph는 이 폭을 유지하고,
        // 큰 둥근 괄호 path는 한컴 HyhwpEQ 출력에 가깝게 더 좁게 잡는다. (Task #283, #1139)
        let paren_w = if use_stretch_square {
            // e100..e105 파트 글립 advance = 0.494em (02-eq-01 실측 대괄호 폭).
            fs * 0.494
        } else if source_metrics && matches!(left, "(" | ")") | matches!(right, "(" | ")") {
            // LEFT/RIGHT 괄호는 원본 글립의 힌팅된 폭을 쓰되 글자 run의 90% 포개기를
            // 적용하지 않는다. Mac 8/9/10/11/12/14pt 괄호 slot은 4/5/5/5/6/7px다.
            self.node_advance_right(&EqNode::Symbol("(".into()), fs)
                .map(|advance| advance / super::font::EQUATION_GLYPH_TRACKING)
                .unwrap_or(fs * MODERN_ROUND_PAREN_EM)
        } else if source_metrics && matches!(left, "{" | "}") | matches!(right, "{" | "}") {
            // 중괄호는 0.48em (probe `LEFT{a RIGHT}`·cases: 괄호→내용 5.28pt@11).
            fs * MODERN_BRACE_EM
        } else if source_metrics && is_absolute_bar_pair(left, right) {
            fs * MODERN_ABSOLUTE_BAR_EM
        } else if use_stretch_round {
            // legacy는 e044/e045 글립 잉크가 slot(0.39em)까지 늘어난다
            // (eq-002 실측 괄호 잉크 3.55pt@9.06).
            if legacy {
                fs * 0.39
            } else {
                fs * 0.27
            }
        } else {
            fs * 0.333
        };

        let left_w = if let Some((advance, _)) = square_advances {
            fs * (advance + MODERN_SHORT_SQUARE_ALLOWANCE_EM)
        } else if left.is_empty() {
            0.0
        } else {
            paren_w
        };
        let right_w = if let Some((_, advance)) = square_advances {
            fs * (advance + MODERN_SHORT_SQUARE_ALLOWANCE_EM)
        } else if right.is_empty() {
            0.0
        } else {
            paren_w
        };

        let mut body_box = b;
        if short_modern_square && matches!(body, EqNode::Empty) {
            // Hancom leaves a half-em editable slot in an empty fence pair.
            body_box.width = fs * 0.5;
        }
        body_box.x = left_w + left_pad;
        body_box.y = 0.0;

        let total_w = left_w + left_pad + body_box.width + right_pad + right_w;

        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: total_w,
            height: body_box.height,
            baseline: body_box.baseline,
            kind: LayoutKind::Paren {
                modern_extent: ((use_stretch_round && self.is_modern_hy())
                    || modern_one_sided_round)
                    .then(|| modern_round_paren_extent(&body_box, body_box.baseline, fs)),
                left: left.to_string(),
                right: right.to_string(),
                body: Box::new(body_box),
            },
        }
    }

    fn layout_decoration(
        &self,
        kind: super::symbols::DecoKind,
        body: &EqNode,
        fs: f64,
    ) -> LayoutBox {
        let b = self.layout_node(body, fs);
        let deco_h = if self.draw_text_vector_occupancy
            && self.is_modern_hy()
            && kind == super::symbols::DecoKind::Vec
        {
            fs * 0.20
        } else {
            fs * 0.25
        };

        let mut body_box = b;
        // Hancom raises the text under a modern vector arrow by 0.067em:
        // 0.36/0.60/0.84pt at 6/9/12pt. Keep the arrow and control baseline
        // fixed so this ink correction does not move surrounding prose.
        let vector_body_raise = if self.is_modern_hy() && kind == super::symbols::DecoKind::Vec {
            fs * 0.067
        } else {
            0.0
        };
        body_box.y = deco_h - vector_body_raise;
        // 현대 HY 장식 상자는 내용 양옆에 0.055em 씩 둔다 (probe `bar{a}<b`: 막대·내용이
        // 상자 시작 +0.6pt, `<` 는 내용 끝 +0.6~0.8pt@11).
        let side = if self.has_modern_hy_metrics(fs) {
            fs * MODERN_DECO_SIDE_EM
        } else {
            0.0
        };
        body_box.x = side;

        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: body_box.width + side * 2.0,
            height: body_box.height + deco_h,
            baseline: deco_h + body_box.baseline,
            kind: LayoutKind::Decoration {
                kind,
                body: Box::new(body_box),
            },
        }
    }

    fn layout_font_style(
        &self,
        style: super::symbols::FontStyleKind,
        body: &EqNode,
        fs: f64,
    ) -> LayoutBox {
        let styled = self.styled(style);
        let b = styled.layout_node(body, fs);
        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: b.width,
            height: b.height,
            baseline: b.baseline,
            kind: LayoutKind::FontStyle {
                style,
                body: Box::new(b),
            },
        }
    }

    /// FontStyle 적용 후 상태. canvas/svg painter의 전환 규칙과 같아야 측정과 paint가 맞는다.
    fn styled(&self, style: super::symbols::FontStyleKind) -> Self {
        use super::symbols::FontStyleKind;
        let mut styled = self.clone();
        (styled.italic, styled.bold) = match style {
            FontStyleKind::Roman | FontStyleKind::SansSerif | FontStyleKind::Monospace => {
                (false, false)
            }
            FontStyleKind::Italic => (true, self.bold),
            FontStyleKind::Bold => (self.italic, true),
            FontStyleKind::Blackboard => (false, true),
            FontStyleKind::Calligraphy | FontStyleKind::Fraktur => (false, false),
        };
        styled
    }

    fn layout_space(&self, kind: SpaceKind, fs: f64) -> LayoutBox {
        // `~` 반각 공백은 현대 경로에서 0.5em (eq-01 실측: 가→배 잉크 간격
        // 6pt@12.96 ≈ 0.44em); 나머지 경로는 Times 계열 스페이스 0.33em 유지.
        // `` ` `` 는 sqrt→sup처럼 복합 원자 사이에 들어갈 때 잔여 간격과 합쳐지므로
        // eq-01 `가`배` 1.5pt@12(0.125em)로 줄이면 eq-002가 역행 — 0.17 유지.
        let w = match kind {
            SpaceKind::Normal if self.is_modern_hy() => fs * 0.5,
            SpaceKind::Normal => fs * 0.33,
            // 현대 backtick은 normal 공백(0.5em)의 1/4이다.
            SpaceKind::Thin if self.is_modern_hy() => fs * 0.5 / 4.0,
            SpaceKind::Thin => fs * 0.17,
            SpaceKind::Tab => fs * 1.0,
        };
        LayoutBox {
            glyph_advances: None,
            x: 0.0,
            y: 0.0,
            width: w,
            height: fs,
            baseline: fs * 0.8,
            kind: LayoutKind::Space(w),
        }
    }
}

/// 오른쪽 괄호 칸 폭. 현대 HY 중괄호 묶음은 칸이 0.48em 이고 안쪽 여백이 없어
/// 본문 뒤 남은 폭이 곧 칸이다. 그 밖에는 painter 기본 칸을 쓴다.
pub(crate) fn paren_right_slot(
    lb: &LayoutBox,
    body: &LayoutBox,
    left: &str,
    right: &str,
    fs: f64,
    default: f64,
) -> f64 {
    let after = lb.width - body.x - body.width;
    if modern_short_square_layout(lb, body, left, right, fs) {
        after - fs * MODERN_SHORT_SQUARE_PAD_EM
    } else if right == "}" && (after - fs * MODERN_BRACE_EM).abs() < 1e-6 {
        after
    } else {
        default
    }
}

fn modern_short_square_layout(
    lb: &LayoutBox,
    body: &LayoutBox,
    left: &str,
    right: &str,
    fs: f64,
) -> bool {
    if !matches!((left, right), ("[", "]")) || lb.height > fs * 1.2 {
        return false;
    }
    let Some((left_advance, right_advance)) =
        super::font::registered_char_advance_em("HYhwpEQ", '\u{e049}').zip(
            super::font::registered_char_advance_em("HYhwpEQ", '\u{e04a}'),
        )
    else {
        return false;
    };
    let expected = |advance: f64| {
        fs * (advance + MODERN_SHORT_SQUARE_ALLOWANCE_EM + MODERN_SHORT_SQUARE_PAD_EM)
    };
    (body.x - expected(left_advance)).abs() < 1e-6
        && (lb.width - body.x - body.width - expected(right_advance)).abs() < 1e-6
}

/// Paint the opening glyph at its actual source-face ink bearing. Its layout
/// cell still begins at x=0 so body and following text keep their advances.
pub(crate) fn paren_left_square_ink_offset(
    lb: &LayoutBox,
    body: &LayoutBox,
    left: &str,
    right: &str,
    fs: f64,
) -> f64 {
    if modern_short_square_layout(lb, body, left, right, fs) {
        EqLayout::with_font(fs, "HYhwpEQ")
            .with_version("Equation Version 60")
            .node_ink_left(&EqNode::Symbol("[".into()), fs)
            .max(0.0)
    } else {
        0.0
    }
}

fn is_absolute_bar_pair(left: &str, right: &str) -> bool {
    matches!((left, right), ("|", "|") | ("|", "") | ("", "|"))
}

/// 조판에서 확보한 현대 HY 막대 칸을 painter에도 전달한다.
/// HFT 및 일반 `|x|` 글립은 이 0.5em LEFT/RIGHT 상자를 만들지 않는다.
pub(crate) fn paren_bar_slot(
    lb: &LayoutBox,
    body: &LayoutBox,
    left: &str,
    right: &str,
    fs: f64,
    default: f64,
) -> f64 {
    let slot = fs * MODERN_ABSOLUTE_BAR_EM;
    let left_slot = if left.is_empty() { 0.0 } else { slot };
    let right_slot = if right.is_empty() { 0.0 } else { slot };
    if is_absolute_bar_pair(left, right)
        && (body.x - left_slot).abs() < 1e-6
        && (lb.width - body.x - body.width - right_slot).abs() < 1e-6
    {
        slot
    } else {
        default
    }
}

/// 적분 기호 여부 판별
pub(crate) fn is_integral_symbol(symbol: &str) -> bool {
    matches!(symbol, "∫" | "∬" | "∭" | "∮" | "∯" | "∰")
}

/// 잎의 높이는 측정에 사용한 em이다. 복합 상자(Limit/BigOp 등)는 부모 크기를
/// 유지해야 하며, 상자 전체 높이를 글자 크기로 해석하면 안 된다.
pub(crate) fn leaf_font_size(lb: &LayoutBox, inherited: f64) -> f64 {
    let leaf = matches!(
        &lb.kind,
        LayoutKind::Text(_)
            | LayoutKind::Number(_)
            | LayoutKind::Symbol(_)
            | LayoutKind::Function(_)
    ) || matches!(&lb.kind, LayoutKind::MathSymbol(s) if !is_integral_symbol(s));
    if leaf && lb.height > 0.0 {
        lb.height
    } else {
        inherited
    }
}

/// 상자를 구성하는 자식들의 실제 배치 하단 (상자 좌표계). 잎 상자는 em 꼬리를
/// 포함한 자기 높이, 컨테이너는 자식들의 재귀 하단 최댓값이다 — 구조적 padding
/// 으로 부풀려진 `height` 와 달리 시각적으로 보이는 잉크 범위에 가깝다.
pub(crate) fn content_bottom(lb: &LayoutBox) -> f64 {
    match &lb.kind {
        LayoutKind::Row(children) => children
            .iter()
            .map(|child| child.y + content_bottom(child))
            .fold(0.0, f64::max),
        LayoutKind::Fraction { numer, denom, .. } => {
            (numer.y + content_bottom(numer)).max(denom.y + content_bottom(denom))
        }
        LayoutKind::Atop { top, bottom, .. } => {
            (top.y + content_bottom(top)).max(bottom.y + content_bottom(bottom))
        }
        _ => lb.height,
    }
}

/// 현대 HY 둥근 괄호는 가로 글립 폭을 유지하고 실제 자식 높이를 덮는다.
/// 축은 HYhwpEQ 등호의 glyf yMin=164, yMax=403 (1024 UPEM) 중앙이다.
pub(crate) fn modern_round_paren_extent(body: &LayoutBox, baseline: f64, fs: f64) -> (f64, f64) {
    let height = content_bottom(body).max(fs);
    let axis = fs * (164.0 + 403.0) / (2.0 * 1024.0);
    // A parenthesis around a power rises above the powered nucleus. Hancom's
    // 9pt round glyph is 1.2pt higher than a centered extent in Mock Q1.
    let nested_sup_shift = if matches!(body.kind, LayoutKind::Superscript { .. }) {
        fs * 0.13
    } else {
        0.0
    };
    // A vector arrow raises and shortens the parenthesized ink relative to
    // ordinary tall content. Hancom's e044/e045 glyphs around vec AD+vec BP
    // have this extent at 6, 9, and 12pt; the control's box stays fixed.
    let has_vector = contains_direct_vector_decoration(body);
    let vector_shift = if has_vector { fs * 0.164 } else { 0.0 };
    (
        baseline - axis - height / 2.0 - nested_sup_shift - vector_shift,
        height - if has_vector { fs * 0.04 } else { 0.0 },
    )
}

fn contains_direct_vector_decoration(body: &LayoutBox) -> bool {
    match &body.kind {
        LayoutKind::Decoration {
            kind: super::symbols::DecoKind::Vec,
            ..
        } => true,
        LayoutKind::Row(children) => children.iter().any(contains_direct_vector_decoration),
        LayoutKind::FontStyle { body, .. } => contains_direct_vector_decoration(body),
        _ => false,
    }
}

/// 텍스트 폭 추정
pub(crate) fn estimate_text_width(text: &str, font_size: f64, italic: bool) -> f64 {
    let mut w = 0.0;
    for ch in text.chars() {
        let ratio = if ch.is_ascii() {
            if ch.is_ascii_uppercase() {
                0.65
            } else if ch.is_ascii_lowercase() {
                0.55
            } else if ch.is_ascii_digit() {
                0.55
            } else {
                0.5
            }
        } else {
            estimate_unicode_char_width(ch)
        };
        w += font_size * ratio;
    }
    if italic {
        w *= 1.05;
    }
    w
}

/// 비-ASCII 문자의 폭 비율 추정 (font_size 대비)
fn estimate_unicode_char_width(ch: char) -> f64 {
    match ch {
        // 프라임/아포스트로피 — 매우 좁음
        '′' | '″' | '‴' | '\'' | '`' => 0.3,
        // 그리스 소문자 — 일반 라틴 소문자와 유사
        'α'..='ω' | 'ϑ' | 'ϖ' => 0.55,
        // 그리스 대문자 — 일반 라틴 대문자와 유사
        'Α'..='Ω' | 'ϒ' => 0.65,
        // 수학 연산자 — 중간 너비
        '±' | '∓' | '×' | '÷' | '·' | '⋅' | '∘' | '†' | '‡' | '•' => 0.6,
        // 관계 기호 — 등호 너비와 유사
        '≠' | '≤' | '≥' | '≈' | '≡' | '≅' | '∼' | '≃' | '≍' | '≐' | '∝' | '≺' | '≻' => {
            0.7
        }
        // 집합/논리 기호
        '∈' | '∉' | '∋' | '⊂' | '⊃' | '⊆' | '⊇' | '∀' | '∃' | '¬' | '∧' | '∨' => {
            0.65
        }
        '⊏' | '⊐' | '⊑' | '⊒' | '⊻' | '⊢' | '⊣' | '⊨' => 0.65,
        // 큰 연산자 기호 (단독 텍스트로 사용될 때)
        '∫' | '∬' | '∭' | '∮' | '∯' | '∰' => 0.5,
        '∑' | '∏' | '∐' => 0.8,
        '∪' | '∩' | '⊔' | '⊓' | '⊎' | '⋀' | '⋁' => 0.7,
        '⊕' | '⊗' | '⊙' | '⊖' | '⊘' => 0.7,
        // 화살표
        '←' | '→' | '↑' | '↓' | '↔' | '↕' => 0.8,
        '⇐' | '⇒' | '⇑' | '⇓' | '⇔' | '⇕' => 0.8,
        '↖' | '↗' | '↙' | '↘' | '↦' | '↩' | '↪' => 0.8,
        // 점 기호
        '⋯' | '…' | '⋮' | '⋱' => 0.8,
        // 기타 수학 기호 — 좁은 것
        '∂' | '∅' | '∇' | '∞' | '∠' | '∡' | '∢' | '⊾' => 0.6,
        '⊥' | '⊤' | '°' | '‰' | '‱' | '♯' => 0.5,
        'ℵ' | 'ℏ' | 'ı' | 'ȷ' | 'ℓ' | '℘' | 'ℑ' | 'ℜ' | 'ℒ' | 'Å' | '℧' => 0.6,
        '℃' | '℉' => 0.9,
        // 기하 도형은 대체 서체(Apple Symbols·맑은 고딕 등)에서 거의 전각이다.
        '△' | '∆' | '▽' | '○' | '◇' | '□' | '▲' | '▼' | '●' | '◆' | '■' => {
            0.97
        }
        '⋄' => 0.7,
        // 원문자 식 번호는 serif fallback의 전각 자형을 쓴다.
        '\u{2460}'..='\u{2473}' => 1.0,
        // CJK — 전각
        '\u{3000}'..='\u{9FFF}' | '\u{F900}'..='\u{FAFF}' | '\u{AC00}'..='\u{D7AF}' => 1.0,
        // 기타 비-ASCII — 중간 너비 기본값
        _ => 0.6,
    }
}


pub(crate) fn is_cjk_char(c: char) -> bool {
    matches!(c, '\u{3000}'..='\u{9FFF}' | '\u{F900}'..='\u{FAFF}' | '\u{AC00}'..='\u{D7AF}')
}

fn is_equation_label_separator(node: &EqNode, next: Option<&EqNode>) -> bool {
    matches!(node, EqNode::MathSymbol(text) if text == "⋯")
        && matches!(next, Some(EqNode::Number(text))
            if !text.is_empty() && text.chars().all(super::symbols::is_circled_number))
}

/// TeX 수식 원자 분류 (The TeXbook 17장).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MathClass {
    Ord,
    Op,
    Bin,
    Rel,
    Open,
    Close,
    Punct,
    Inner,
}

/// 행 안의 원자. 괄호 묶음처럼 왼쪽/오른쪽 경계의 분류가 다를 수 있다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Atom {
    left: MathClass,
    right: MathClass,
    /// 큰 연산자처럼 박스 안에 이미 뒤 간격을 가진 원자.
    trailing_space: bool,
    /// 뒤 피연산자가 없는 이항 기호. 현대 HY의 끝 +/−는 앞 간격을 유지한다.
    postfix: bool,
}

impl Atom {
    fn of(class: MathClass) -> Self {
        Self {
            left: class,
            right: class,
            trailing_space: false,
            postfix: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AtomSlot {
    Atom(Atom),
    /// 명시 공백: 간격에 더해지지만 원자 관계는 유지한다.
    Glue,
    /// 줄바꿈: 앞뒤 원자 관계를 끊는다.
    Break,
}

fn atom_of(node: &EqNode) -> AtomSlot {
    let class = match node {
        EqNode::OperatorBody(body) => return atom_of(body),
        EqNode::Space(_) | EqNode::Empty => return AtomSlot::Glue,
        EqNode::Newline => return AtomSlot::Break,
        EqNode::Symbol(s) | EqNode::MathSymbol(s) if is_integral_symbol(s) => {
            return AtomSlot::Atom(Atom {
                trailing_space: true,
                ..Atom::of(MathClass::Op)
            })
        }
        EqNode::Symbol(s) | EqNode::MathSymbol(s) => symbol_class(s),
        EqNode::Text(_) | EqNode::Number(_) | EqNode::Quoted(_) => MathClass::Ord,
        EqNode::Function(_) | EqNode::Limit { .. } => MathClass::Op,
        EqNode::BigOp { .. } => {
            return AtomSlot::Atom(Atom {
                trailing_space: true,
                ..Atom::of(MathClass::Op)
            })
        }
        // 분수선은 개체 여백(bar_inset) 안쪽에서 끝난다. TeX의 null delimiter와 같은 역할.
        EqNode::Fraction { .. } | EqNode::Atop { .. } | EqNode::Cases { .. } => MathClass::Inner,
        EqNode::Matrix { style, .. } => {
            if *style == MatrixStyle::Plain {
                MathClass::Ord
            } else {
                MathClass::Inner
            }
        }
        EqNode::Rel { .. } => MathClass::Rel,
        EqNode::Paren { .. } => {
            return AtomSlot::Atom(Atom {
                left: MathClass::Open,
                right: MathClass::Close,
                trailing_space: false,
                postfix: false,
            })
        }
        EqNode::Superscript { base, .. }
        | EqNode::Subscript { base, .. }
        | EqNode::SubSup { base, .. }
        | EqNode::Color { body: base, .. }
        | EqNode::FontStyle { body: base, .. }
        | EqNode::FontDeclaration { body: base, .. } => {
            return match atom_of(base) {
                AtomSlot::Atom(atom) => AtomSlot::Atom(atom),
                // 서체 선언이 감싼 공백도 공백이다 (`{rm AD it} `:`).
                AtomSlot::Glue
                    if matches!(
                        node,
                        EqNode::Color { .. }
                            | EqNode::FontStyle { .. }
                            | EqNode::FontDeclaration { .. }
                    ) =>
                {
                    AtomSlot::Glue
                }
                _ => AtomSlot::Atom(Atom::of(MathClass::Ord)),
            };
        }
        // 괄호로 시작·끝나는 평탄화된 괄호 행은 경계 분류를 유지하고, 그 밖의 묶음은 Ord다.
        EqNode::Row(children) => {
            let edge = |node: Option<&EqNode>| match node {
                Some(EqNode::Symbol(s)) => Some(symbol_class(s)),
                _ => None,
            };
            if edge(children.first()) == Some(MathClass::Open)
                && edge(children.last()) == Some(MathClass::Close)
            {
                return AtomSlot::Atom(Atom {
                    left: MathClass::Open,
                    right: MathClass::Close,
                    trailing_space: false,
                    postfix: false,
                });
            }
            MathClass::Ord
        }
        _ => MathClass::Ord,
    };
    AtomSlot::Atom(Atom::of(class))
}

/// TeX rule 5·6: 앞에 피연산자가 없는 Bin(부호)과 뒤에 피연산자가 없는 Bin은 Ord가 된다.
///
/// `spaced_binary`: 현대 HY는 명시 공백 뒤의 부호를 이항으로 둔다
/// (한컴 probe `a=`-b`: `=`→`-` 0.35em = 관계+이항 간격, `a=-b`는 붙음).
fn resolve_atoms(mut slots: Vec<AtomSlot>, spaced_binary: bool) -> Vec<AtomSlot> {
    let mut previous: Option<usize> = None;
    let mut spaced = false;
    for i in 0..slots.len() {
        match slots[i] {
            AtomSlot::Atom(_) if spaced_binary && spaced && previous.is_some() => {
                spaced = false;
                previous = Some(i);
            }
            AtomSlot::Atom(atom) => {
                spaced = false;
                let prev_right = previous.and_then(|p| match slots[p] {
                    AtomSlot::Atom(prev) => Some(prev.right),
                    _ => None,
                });
                if atom.left == MathClass::Bin
                    && prev_right.map_or(true, |right| {
                        matches!(
                            right,
                            MathClass::Bin
                                | MathClass::Op
                                | MathClass::Rel
                                | MathClass::Open
                                | MathClass::Punct
                        )
                    })
                {
                    slots[i] = AtomSlot::Atom(Atom::of(MathClass::Ord));
                } else if matches!(
                    atom.left,
                    MathClass::Rel | MathClass::Close | MathClass::Punct
                ) && prev_right == Some(MathClass::Bin)
                {
                    slots[previous.unwrap()] = AtomSlot::Atom(Atom {
                        postfix: true,
                        ..Atom::of(MathClass::Ord)
                    });
                }
                previous = Some(i);
            }
            AtomSlot::Break => {
                demote_trailing_bin(&mut slots, previous);
                previous = None;
            }
            AtomSlot::Glue => spaced = true,
        }
    }
    demote_trailing_bin(&mut slots, previous);
    slots
}

fn demote_trailing_bin(slots: &mut [AtomSlot], last: Option<usize>) {
    if let Some(i) = last {
        if matches!(slots[i], AtomSlot::Atom(atom) if atom.right == MathClass::Bin) {
            slots[i] = AtomSlot::Atom(Atom {
                postfix: true,
                ..Atom::of(MathClass::Ord)
            });
        }
    }
}

const THIN_SPACE_EM: f64 = 3.0 / 18.0;
const MEDIUM_SPACE_EM: f64 = 4.0 / 18.0;
const THICK_SPACE_EM: f64 = 5.0 / 18.0;

/// 인접 원자 사이 간격 (em). TeX 원자 간격표를 따르며, 괄호 항목(첨자 크기에서 생략)은
/// 음수로 적는다. 0 = 없음, 1 = thin, 2 = medium, 3 = thick.
fn math_space_em(prev: Atom, next: Atom, script: bool) -> f64 {
    use MathClass::*;
    if prev.trailing_space {
        return 0.0;
    }
    #[rustfmt::skip]
    const TABLE: [[i8; 8]; 8] = [
        //  Ord  Op  Bin  Rel Open Close Punct Inner
        [    0,   1,  -2,  -3,   0,   0,    0,   -1], // Ord
        [    1,   1,   0,  -3,   0,   0,    0,   -1], // Op
        [   -2,  -2,   0,   0,  -2,   0,    0,   -2], // Bin
        [   -3,  -3,   0,   0,  -3,   0,    0,   -3], // Rel
        [    0,   0,   0,   0,   0,   0,    0,    0], // Open
        [    0,   1,  -2,  -3,   0,   0,    0,   -1], // Close
        [   -1,  -1,   0,  -1,  -1,  -1,   -1,   -1], // Punct
        [   -1,   1,  -2,  -3,  -1,   0,   -1,   -1], // Inner
    ];
    let index = |class: MathClass| match class {
        Ord => 0,
        Op => 1,
        Bin => 2,
        Rel => 3,
        Open => 4,
        Close => 5,
        Punct => 6,
        Inner => 7,
    };
    let entry = TABLE[index(prev.right)][index(next.left)];
    if entry < 0 && script {
        return 0.0;
    }
    match entry.abs() {
        1 => THIN_SPACE_EM,
        2 => MEDIUM_SPACE_EM,
        3 => THICK_SPACE_EM,
        _ => 0.0,
    }
}

/// 기호의 TeX 원자 분류.
pub(crate) fn symbol_class(text: &str) -> MathClass {
    match text {
        "=" | "<" | ">" | "<=" | ">=" | "!=" | "==" | "->" | "<<" | ">>" | "<<<" | ">>>" | ":"
        | "≤" | "≥" | "≠" | "≈" | "≡" | "∼" | "≃" | "≅" | "∝" | "≪" | "≫" | "→" | "←" | "↔"
        | "⇒" | "⇐" | "⇔" | "∈" | "∉" | "∋" | "⊂" | "⊃" | "⊆" | "⊇" | "≒" | "≐" | "∥" | "↦"
        | "⟶" | "⟵" | "⟹" | "⟸" | "⟺" => MathClass::Rel,
        "+" | "-" | "−" | "*" | "×" | "÷" | "±" | "∓" | "·" | "⋅" | "∙" | "∘" | "⊕" | "⊖" | "⊗"
        | "⊙" | "∪" | "∩" | "∧" | "∨" | "⊔" | "⊓" | "∖" => MathClass::Bin,
        "(" | "[" | "{" | "⟨" | "⌈" | "⌊" => MathClass::Open,
        ")" | "]" | "}" | "⟩" | "⌉" | "⌋" | "!" => MathClass::Close,
        "," | ";" => MathClass::Punct,
        // 도형 접두 기호(△ABC, ∠ABC, △x)는 뒤 피연산자와 thin space로 떨어진다.
        // 대체 서체의 도형 글립은 오른쪽 여백이 거의 없어 Ord로 두면 변수에 붙는다.
        "△" | "∆" | "▽" | "∠" | "∡" | "∢" | "□" | "◇" | "○" | "⊿" => {
            MathClass::Op
        }
        _ => MathClass::Ord,
    }
}

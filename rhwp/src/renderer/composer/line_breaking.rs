//! 줄 나눔 엔진 (Line Breaking Engine)
//!
//! 문단 텍스트를 토큰화하고 줄 나눔을 수행한다.
//! 한글 어절/글자, 영어 단어/하이픈, CJK 개별 분할을 지원한다.

use super::{find_active_char_shape, is_lang_neutral, is_word_break_neutral};
use crate::model::control::Control;
use crate::model::paragraph::{CharShapeRef, LineSeg, Paragraph};
use crate::model::shape::{HorzRelTo, TextWrap, VertRelTo};
use crate::model::style::LineSpacingType;
use crate::renderer::float_placement::{
    available_text_intervals, float_exclusion, object_frame, FloatExclusion,
    ObjectPlacementContext, WrapGeometry,
};
use crate::renderer::hwpunit_to_px;
use crate::renderer::layout::{
    estimate_text_width, estimate_text_width_unrounded, find_next_tab_stop, is_cjk_char,
    resolved_to_text_style,
};
use crate::renderer::page_layout::LayoutRect;
use crate::renderer::style_resolver::{detect_lang_category, ResolvedParaStyle, ResolvedStyleSet};
use crate::renderer::{px_to_hwpunit, px_to_hwpunit_round};
use unicode_segmentation::UnicodeSegmentation;

/// 줄 나눔 토큰
#[derive(Debug, Clone)]
pub(crate) enum BreakToken {
    /// 분할 불가 텍스트 조각 (어절/단어/글자)
    /// char_widths: 글자별 px 폭 (char_level_break용, 단일 글자 토큰은 비어있음)
    /// trailing_spacing: 토큰 마지막 글자의 자간 + 뒤따르는 글자와의 자동 간격(px).
    /// 한컴은 줄 끝 글자의 자간을 줄 맞춤 판정에서 뺀다 (합성 스윕 자간 축 69/70).
    /// char_spacings: char_widths 와 같은 배치의 글자별 trailing 값 (모두 0이면 비어있음)
    Text {
        start_idx: usize,
        end_idx: usize,
        width: f64,
        max_font_size: f64,
        char_widths: Vec<f64>,
        trailing_spacing: f64,
        char_spacings: Vec<f64>,
    },
    /// 공백 (줄 바꿈 가능 지점, 줄 끝에서 흡수)
    Space {
        idx: usize,
        width: f64,
        max_font_size: f64,
        /// 고정폭 공백은 문단의 공백 압축에 참여하지 않는다.
        is_fixed_width: bool,
    },
    /// 탭 (줄 바꿈 가능 지점, 폭은 줄 위치에 따라 동적)
    Tab { idx: usize, max_font_size: f64 },
    /// 강제 줄 바꿈 (\n)
    LineBreak { idx: usize, max_font_size: f64 },
    /// 인라인 개체 (treat_as_char 수식/그림/표 등).
    /// 문자를 소비하지 않고 지정 폭(HWPUNIT)만큼 가로 공간만 예약한다.
    /// idx는 개체가 삽입된 문자 위치 (개체 바로 다음 문자 인덱스와 동일).
    /// own_line: 한컴이 전용 줄을 부여하는 블록형 개체(표/그림/도형) 여부.
    /// true 이면 개체 줄에 뒤따르는 토큰이 넘칠 때 토큰 통째를 다음 줄로 본내
    /// 글자 단위 분할(한 글자 run 조각남)을 피한다. 수식(false)은 텍스트 흐름
    /// 개처이므로 기존 첫 글자 고정(pin) 동작을 유지한다.
    InlineControl {
        idx: usize,
        width_hwp: i32,
        max_font_size: f64,
        own_line: bool,
    },
}

/// 줄 채움 결과
#[derive(Debug)]
struct LineBreakResult {
    start_idx: usize,
    end_idx: usize, // exclusive
    max_font_size: f64,
    has_line_break: bool, // 강제 줄 바꿈 여부
}

/// 문단-로컬 어울림(Square/Tight/Through) 배제 계획.
///
/// 편집 재배치(reflow)는 저장 LINE_SEG 의 column_start/segment_width 를 통째로
/// 재생성하는데, 종전에는 전 줄을 단 전체 폭으로 채워 같은 문단에 앵커된 어울림
/// 개체 위로 텍스트가 그대로 겹쳤다(감사 finding #7: available_text_intervals 는
/// 사장 코드였다). 이 계획은 문단 자신이 소유한 비-TAC 어울림 개체의 배제
/// 사각형을 문단-로컬 좌표(단 좌측=0, 문단 상단=0)로 만들어 두고, 줄 채움과
/// 재생성 seg 지오메트리가 **동일한 결정적 계산**으로 줄별 (시작 x, 폭)을
/// 얻게 한다. 렌더러(paragraph_layout)는 이렇게 기록된 wrap zone 을 저장
/// 지오메트리와 똑같이 재생하므로 별도 재생 경로가 필요 없다.
///
/// 근사 2가지(주석 계약): ① 앵커 줄 y 는 전폭 1차 채움으로 추정한다(그림 옆
/// 문단의 지배적 케이스인 문단 선두 앵커에서는 오차 0). ② 줄 대역 조회는
/// 해당 줄의 실제 폰트가 아니라 직전 줄들의 누적 전진량을 쓴다.
pub(crate) struct LineBandPlan {
    exclusions: Vec<FloatExclusion>,
    column_w_px: f64,
    generated_body: bool,
    ls_type: LineSpacingType,
    ls_value: f64,
    dpi: f64,
}

impl LineBandPlan {
    /// make_line_seg 와 동일 산식의 줄 전진량(px).
    fn advance_px(&self, max_font_size: f64) -> f64 {
        let fs = if max_font_size > 0.0 {
            max_font_size
        } else {
            12.0
        };
        let line_height_hwp = font_size_to_line_height(fs, self.dpi);
        let line_spacing_hwp =
            compute_line_spacing_hwp(self.ls_type, self.ls_value, line_height_hwp, self.dpi);
        hwpunit_to_px(line_height_hwp + line_spacing_hwp, self.dpi)
    }

    /// 줄 상자 [y, y+글자 높이) 에서 쓸 수 있는 가장 넓은 구간 (시작 x, 폭).
    /// 렌더러 재생이 줄당 단일 세그먼트만 지원하므로 구간이 갈리면 넓은 쪽을
    /// 택한다(양쪽 어울림의 반대편은 비워 둔다 — 겹침 없음이 우선).
    /// 배제가 대역을 전부 덮으면 전폭으로 되돌린다(현행과 동일한 안전망).
    fn interval_at(&self, band_top: f64, band_font_size: f64) -> (f64, f64) {
        let column = LayoutRect {
            x: 0.0,
            y: 0.0,
            width: self.column_w_px,
            height: f64::INFINITY,
        };
        // 생성 본문은 줄간격만 그림 윗부분에 닿으면 전폭을 쓴다.
        // 저장/혼합 문서의 기존 재조판은 종전 줄 전진량 기준을 보존한다.
        let band_height = if self.generated_body {
            if band_font_size > 0.0 {
                band_font_size
            } else {
                12.0
            }
        } else {
            self.advance_px(band_font_size).max(1.0)
        };
        let band_bottom = band_top + band_height;
        let widest = available_text_intervals(column, band_top, band_bottom, &self.exclusions)
            .into_iter()
            .max_by(|a, b| (a.1 - a.0).total_cmp(&(b.1 - b.0)));
        match widest {
            Some((start, end)) if end - start >= 1.0 => (start, end - start),
            _ => (0.0, self.column_w_px),
        }
    }

    /// 계획이 실제로 어떤 줄이라도 좁히는지 (전부 전폭이면 seg 기록 생략).
    fn narrows(&self, x: f64, w: f64) -> bool {
        x > 0.5 || w < self.column_w_px - 0.5
    }
}

/// 같은 문단에 앵커된 비-TAC 어울림(Square/Tight/Through) 그림/도형에서
/// 문단-로컬 배제 계획을 만든다. 대상이 없으면 None (기존 경로 그대로).
///
/// 문단-로컬로 해석 가능한 기준만 다룬다: VertRelTo::Para (앵커 줄 기준) ×
/// HorzRelTo::Column/Para (단·문단 박스를 available_width 로 근사). 쪽/용지 기준은
/// 가로든 세로든 쪽 배치가 끝나야 위치가 정해지므로 계획에서 제외한다 — 잘못된
/// 위치에 배제를 만드는 것보다 종전(전폭) 동작이 안전하다.
fn paragraph_local_wrap_plan(
    para: &Paragraph,
    available_width_px: f64,
    margins_px: (f64, f64),
    anchor_line_y: impl Fn(usize) -> f64,
    ls_type: LineSpacingType,
    ls_value: f64,
    dpi: f64,
) -> Option<LineBandPlan> {
    let control_positions = para.control_text_positions();
    let mut exclusions = Vec::new();
    for (ci, ctrl) in para.controls.iter().enumerate() {
        let common = match ctrl {
            Control::Picture(pic) => &pic.common,
            Control::Shape(shape) => shape.common(),
            // 어울림 표(본문 옆 `[A]` 괄호 표 등)도 같은 배제를 만든다.
            Control::Table(table) => &table.common,
            _ => continue,
        };
        if common.treat_as_char
            || !matches!(
                common.text_wrap,
                TextWrap::Square | TextWrap::Tight | TextWrap::Through
            )
            || !matches!(common.vert_rel_to, VertRelTo::Para)
            || !matches!(common.horz_rel_to, HorzRelTo::Column | HorzRelTo::Para)
        {
            continue;
        }
        let w_px = hwpunit_to_px(common.width as i32, dpi);
        let h_px = hwpunit_to_px(common.height as i32, dpi);
        if w_px <= 0.0 || h_px <= 0.0 {
            continue;
        }
        let anchor_pos = control_positions.get(ci).copied().unwrap_or(0);
        let line_y = anchor_line_y(anchor_pos);
        let local_box = LayoutRect {
            x: 0.0,
            y: 0.0,
            width: available_width_px,
            height: f64::INFINITY,
        };
        // 줄 좌표 0 은 문단 왼쪽 여백 끝이다 — 단 기준 개체는 단 왼쪽(= -여백)에서 잰다.
        let column_box = LayoutRect {
            x: -margins_px.0,
            width: available_width_px + margins_px.0 + margins_px.1,
            ..local_box
        };
        let frame = object_frame(
            common,
            w_px,
            h_px,
            ObjectPlacementContext {
                paper: column_box,
                page: column_box,
                column: column_box,
                paragraph: local_box,
                line_y,
            },
            dpi,
        );
        if let Some(excl) = float_exclusion(common, frame, dpi) {
            // 자리차지(TopAndBottom)는 줄 폭이 아니라 흐름 예약으로 처리된다.
            if matches!(excl.geometry, WrapGeometry::Side(_)) {
                exclusions.push(excl);
            }
        }
    }
    if exclusions.is_empty() {
        return None;
    }
    Some(LineBandPlan {
        exclusions,
        column_w_px: available_width_px,
        generated_body: false,
        ls_type,
        ls_value,
        dpi,
    })
}

/// 줄 머리 금칙: 줄 시작에 올 수 없는 문자
pub(crate) fn is_line_start_forbidden(ch: char) -> bool {
    matches!(
        ch,
        ')' | ']'
            | '}'
            | '>'
            | ','
            | '.'
            | '!'
            | '?'
            | ';'
            | ':'
            | '\''
            | '"'
            | '\u{3001}'
            | '\u{3002}'
            | '\u{2026}'
            | '\u{00B7}'
            | '\u{2015}'
            | '\u{30FC}'
            | '\u{300B}'
            | '\u{300D}'
            | '\u{300F}'
            | '\u{3011}'
            | '\u{FF09}'
            | '\u{FF5D}'
            | '\u{3015}'
            | '\u{3009}'
            | '\u{FF1E}'
            | '\u{226B}'
            | '\u{FF3D}'
            | '\u{FE5E}'
            | '\u{301E}'
            | '\u{2019}'
            | '\u{201D}'
            | '\u{FF0C}'
            | '\u{FF0E}'
            | '\u{FF01}'
            | '\u{FF1F}'
            | '\u{FF1B}'
            | '\u{FF1A}'
            | '%'
            | '\u{2030}'
            | '\u{2103}'
            | '\u{00B0}'
            | '\u{FF05}'
    )
}

/// 줄 꼬리 금칙: 줄 끝에 올 수 없는 문자
pub(crate) fn is_line_end_forbidden(ch: char) -> bool {
    matches!(
        ch,
        '(' | '['
            | '{'
            | '<'
            | '\''
            | '"'
            | '\u{300A}'
            | '\u{300C}'
            | '\u{300E}'
            | '\u{3010}'
            | '\u{FF08}'
            | '\u{FF5B}'
            | '\u{3014}'
            | '\u{3008}'
            | '\u{FF1C}'
            | '\u{226A}'
            | '\u{FF3B}'
            | '\u{301D}'
            | '\u{2018}'
            | '\u{201C}'
            | '$'
            | '\u{20A9}'
            | '\u{00A3}'
            | '\u{20AC}'
            | '\u{00A5}'
            | '\u{FF04}'
            | '\u{FFE5}'
    )
}

/// 한글 음절/자모 여부 (옛한글 확장 자모 포함)
fn is_hangul(ch: char) -> bool {
    ('\u{AC00}'..='\u{D7A3}').contains(&ch)       // 한글 음절
        || ('\u{1100}'..='\u{11FF}').contains(&ch) // 한글 자모
        || ('\u{3130}'..='\u{318F}').contains(&ch) // 한글 호환 자모 (ㆍ U+318D 포함)
        || ('\u{A960}'..='\u{A97F}').contains(&ch) // 한글 자모 확장-A (옛한글 초성)
        || ('\u{D7B0}'..='\u{D7FF}').contains(&ch) // 한글 자모 확장-B (옛한글 중/종성)
}

/// 라틴 문자 여부 (영문+숫자)
fn is_latin(ch: char) -> bool {
    // 단어 경계용 분류: 영문자/숫자만. 구두점은 영문 글꼴 슬롯이지만 단어를 이루지 않는다.
    detect_lang_category(ch) == 1 && !super::super::style_resolver::is_latin_slot_punctuation(ch)
}

/// CJK 문자 여부 (한자/일본어 — 개별 분할 대상)
fn is_cjk_ideograph(ch: char) -> bool {
    let lang = detect_lang_category(ch);
    lang == 2 || lang == 3 // Chinese or Japanese
}

fn grapheme_end_map(chars: &[char]) -> Vec<usize> {
    let text: String = chars.iter().collect();
    let mut ends = vec![0; chars.len()];
    let mut start = 0;
    for grapheme in text.graphemes(true) {
        let end = start + grapheme.chars().count();
        for slot in &mut ends[start..end] {
            *slot = end;
        }
        start = end;
    }
    ends
}

fn grapheme_char_widths(width: f64, len: usize) -> Vec<f64> {
    let mut widths = vec![0.0; len];
    if let Some(first) = widths.first_mut() {
        *first = width;
    }
    widths
}

/// 글자 스타일의 font_size 만 조회한다. `resolved_to_text_style(..).font_size` 와 같은
/// 값이지만, 글자마다 폰트명 String 2개와 TextStyle 전체를 만들지 않는다.
fn style_font_size(styles: &ResolvedStyleSet, style_id: u32) -> f64 {
    styles
        .char_styles
        .get(style_id as usize)
        .map(|cs| cs.font_size)
        .unwrap_or(0.0)
}

fn measure_grapheme_metrics(
    text_chars: &[char],
    start: usize,
    end: usize,
    char_offsets: &[u32],
    char_shapes: &[CharShapeRef],
    styles: &ResolvedStyleSet,
    default_lang: usize,
) -> (f64, f64, usize) {
    let cluster: String = text_chars[start..end].iter().collect();
    let width = measure_token_width(
        &cluster,
        start,
        char_offsets,
        char_shapes,
        styles,
        default_lang,
    );
    let mut max_font_size = 0.0f64;
    let mut current_lang = default_lang;
    for (offset, ch) in text_chars[start..end].iter().copied().enumerate() {
        let index = start + offset;
        let utf16_pos = char_offsets.get(index).copied().unwrap_or(index as u32);
        let style_id = find_active_char_shape(char_shapes, utf16_pos);
        if !is_lang_neutral(ch) {
            current_lang = detect_lang_category(ch);
        }
        // 한컴은 6~8.5pt 한글 줄도 글자 크기 그대로 줄 높이를 잡는다 (스윕 6pt@160% =
        // 9.60pt 피치). 종전 9pt(12px) 하한은 작은 글씨 줄을 14.40pt 로 부풀렸다.
        let fs = style_font_size(styles, style_id);
        max_font_size = max_font_size.max(if fs > 0.0 { fs } else { 12.0 });
    }
    (width, max_font_size, current_lang)
}

/// 글자(grapheme cluster)별 폭을 클러스터 단독 측정으로 구한다 (선형 시간).
/// 한글 어절은 커닝이 없어 접두 차분(measure_grapheme_advances)과 같은 값을 준다.
fn measure_grapheme_widths_linear(
    text_chars: &[char],
    start: usize,
    end: usize,
    grapheme_ends: &[usize],
    char_offsets: &[u32],
    char_shapes: &[CharShapeRef],
    styles: &ResolvedStyleSet,
    default_lang: usize,
) -> Vec<f64> {
    let mut widths = vec![0.0; end - start];
    // (글자 모양, 언어)가 같은 동안 해소한 TextStyle 을 재사용한다.
    let mut cached: Option<((u32, usize), crate::renderer::TextStyle)> = None;
    let mut current_lang = default_lang;
    let mut index = start;
    while index < end {
        let cluster_end = grapheme_ends[index].min(end).max(index + 1);
        let ch = text_chars[index];
        if !is_lang_neutral(ch) {
            current_lang = detect_lang_category(ch);
        }
        let key = (
            char_style_id_at(char_offsets, char_shapes, index),
            current_lang,
        );
        if cached.as_ref().is_none_or(|(k, _)| *k != key) {
            cached = Some((key, resolved_to_text_style(styles, key.0, key.1)));
        }
        let cluster: String = text_chars[index..cluster_end].iter().collect();
        if let Some((_, ts)) = &cached {
            widths[index - start] = estimate_text_width_unrounded(&cluster, ts);
        }
        index = cluster_end;
    }
    widths
}

fn measure_grapheme_advances(
    text_chars: &[char],
    start: usize,
    end: usize,
    grapheme_ends: &[usize],
    char_offsets: &[u32],
    char_shapes: &[CharShapeRef],
    styles: &ResolvedStyleSet,
    default_lang: usize,
) -> Vec<f64> {
    let mut widths = vec![0.0; end - start];
    let mut previous_prefix_width = 0.0;
    let mut index = start;
    while index < end {
        let cluster_end = grapheme_ends[index].min(end).max(index + 1);
        let prefix: String = text_chars[start..cluster_end].iter().collect();
        let prefix_width = measure_token_width(
            &prefix,
            start,
            char_offsets,
            char_shapes,
            styles,
            default_lang,
        );
        widths[index - start] = prefix_width - previous_prefix_width;
        previous_prefix_width = prefix_width;
        index = cluster_end;
    }
    widths
}

/// 한글과 영문/숫자 사이 자동 간격 (HWPX `autoSpacing@eAsianEng/eAsianNum`,
/// HWP5 ParaShape attr2 bit 4/5). 문단 모양 설정을 그대로 따른다.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct AutoSpacing {
    /// 한글 ↔ 영문 글자 경계
    pub eng: bool,
    /// 한글 ↔ 숫자 경계
    pub num: bool,
}

impl AutoSpacing {
    /// 붙어 있는 두 글자 사이에 자동 간격이 들어가는지 판정한다.
    /// 한컴은 두 방향(한글→영문, 영문→한글) 모두 같은 간격을 넣는다 (합성 스윕 R6).
    fn applies(self, left: char, right: char) -> bool {
        let latin_letter = |c: char| c.is_alphabetic() && is_latin(c);
        let digit = |c: char| c.is_ascii_digit();
        let pair = |a: &dyn Fn(char) -> bool, b: &dyn Fn(char) -> bool| {
            (a(left) && b(right)) || (b(left) && a(right))
        };
        (self.eng && pair(&is_hangul, &latin_letter)) || (self.num && pair(&is_hangul, &digit))
    }
}

/// 자동 간격 폭(px): 글자 크기의 1/4 을 한컴 1/1800 인치 격자(4 HWPUNIT)에 맞춘 값.
/// 글자 크기 단위 = floor(size_HU / 4), 간격 = round_half_up(단위 / 4) — 10pt 에서 2.52pt.
fn auto_spacing_gap_px(font_size_px: f64) -> f64 {
    if font_size_px <= 0.0 {
        return 0.0;
    }
    let size_units = (font_size_px * 75.0).round() as i32 / 4;
    let gap_units = (size_units + 2) / 4;
    (gap_units * 4) as f64 / 75.0
}

/// 줄의 글자 배치(paragraph_layout)가 쓰는 자동 간격(px): 붙은 두 글자 `left`·`right`
/// 사이에 문단 autoSpacing 설정이 간격을 넣으면 왼쪽 글자 크기 기준 폭, 아니면 0.
/// 줄 나눔(annotate_trailing_spacing)과 같은 규칙·폭이다.
pub(crate) fn auto_spacing_gap_between(
    para_style: Option<&crate::renderer::style_resolver::ResolvedParaStyle>,
    left: char,
    right: char,
    left_font_size_px: f64,
) -> f64 {
    let Some(style) = para_style else {
        return 0.0;
    };
    let auto = AutoSpacing {
        eng: style.auto_spacing_eng,
        num: style.auto_spacing_num,
    };
    if auto.applies(left, right) {
        auto_spacing_gap_px(left_font_size_px)
    } else {
        0.0
    }
}

/// 문자 위치의 활성 글자 모양 ID.
fn char_style_id_at(char_offsets: &[u32], char_shapes: &[CharShapeRef], idx: usize) -> u32 {
    let utf16_pos = char_offsets.get(idx).copied().unwrap_or(idx as u32);
    find_active_char_shape(char_shapes, utf16_pos)
}

/// 문자 위치의 언어 슬롯 — 언어 중립 문자는 앞쪽의 첫 비중립 문자를 따른다.
fn lang_at(text_chars: &[char], idx: usize) -> usize {
    text_chars[..=idx.min(text_chars.len().saturating_sub(1))]
        .iter()
        .rev()
        .take(64)
        .find(|c| !is_lang_neutral(**c))
        .map(|c| detect_lang_category(*c))
        .unwrap_or(0)
}

/// grapheme cluster [cs, ce) 가 자간으로 더하는 폭(px). 자간이 없으면 0.
fn cluster_letter_spacing_px(
    text_chars: &[char],
    cs: usize,
    ce: usize,
    char_offsets: &[u32],
    char_shapes: &[CharShapeRef],
    styles: &ResolvedStyleSet,
) -> f64 {
    let style_id = char_style_id_at(char_offsets, char_shapes, cs);
    let Some(char_style) = styles.char_styles.get(style_id as usize) else {
        return 0.0;
    };
    if char_style.letter_spacing == 0.0 && char_style.letter_spacings.iter().all(|v| *v == 0.0) {
        return 0.0;
    }
    let lang = lang_at(text_chars, cs);
    if char_style.letter_spacing_for_lang(lang) == 0.0 {
        return 0.0;
    }
    let cluster: String = text_chars[cs..ce].iter().collect();
    let mut ts = resolved_to_text_style(styles, style_id, lang);
    let with_spacing = estimate_text_width_unrounded(&cluster, &ts);
    ts.letter_spacing = 0.0;
    with_spacing - estimate_text_width_unrounded(&cluster, &ts)
}

/// 텍스트 토큰마다 줄 끝 판정에서 뺄 폭(마지막 글자 자간)을 기록하고, 자동 간격이
/// 켜진 문단은 한글↔영문/숫자 경계의 간격을 왼쪽 토큰 폭에 더한다. 경계 간격도
/// 줄 끝에서는 맞춤 판정에서 빠지도록 trailing 에 함께 넣는다.
fn annotate_trailing_spacing(
    tokens: &mut [BreakToken],
    text_chars: &[char],
    grapheme_ends: &[usize],
    char_offsets: &[u32],
    char_shapes: &[CharShapeRef],
    styles: &ResolvedStyleSet,
    auto_spacing: AutoSpacing,
) {
    for k in 0..tokens.len() {
        let next_text_start = match tokens.get(k + 1) {
            Some(BreakToken::Text { start_idx, .. }) => Some(*start_idx),
            _ => None,
        };
        let BreakToken::Text {
            start_idx,
            end_idx,
            width,
            char_widths,
            trailing_spacing,
            char_spacings,
            ..
        } = &mut tokens[k]
        else {
            continue;
        };
        let (start, end) = (*start_idx, *end_idx);
        if start >= end || end > text_chars.len() {
            continue;
        }
        // 글자별 자간 (cluster 시작 위치에 기록 — char_widths 배치와 동일)
        let mut spacings = vec![0.0; end - start];
        let mut last_cluster = start;
        let mut cs = start;
        while cs < end {
            let ce = grapheme_ends[cs].min(end).max(cs + 1);
            spacings[cs - start] =
                cluster_letter_spacing_px(text_chars, cs, ce, char_offsets, char_shapes, styles);
            last_cluster = cs;
            cs = ce;
        }
        // 자동 간격: 바로 붙은 다음 텍스트 토큰과의 경계
        if next_text_start == Some(end)
            && end < text_chars.len()
            && auto_spacing.applies(text_chars[end - 1], text_chars[end])
        {
            let style_id = char_style_id_at(char_offsets, char_shapes, end - 1);
            let lang = lang_at(text_chars, end - 1);
            let fs = styles
                .char_styles
                .get(style_id as usize)
                .map(|cs| cs.font_size_for_lang(lang))
                .unwrap_or(0.0);
            let gap = auto_spacing_gap_px(fs);
            *width += gap;
            spacings[last_cluster - start] += gap;
            if let Some(w) = char_widths.get_mut(last_cluster - start) {
                *w += gap;
            }
        }
        *trailing_spacing = spacings[last_cluster - start];
        *char_spacings = if spacings.iter().all(|v| *v == 0.0) {
            Vec::new()
        } else {
            spacings
        };
    }
}

/// 문단 텍스트를 줄 나눔 토큰으로 분할한다.
pub(crate) fn tokenize_paragraph(
    text_chars: &[char],
    char_offsets: &[u32],
    char_shapes: &[CharShapeRef],
    styles: &ResolvedStyleSet,
    english_break_unit: u8,
    korean_break_unit: u8,
) -> Vec<BreakToken> {
    tokenize_paragraph_with_controls(
        text_chars,
        char_offsets,
        char_shapes,
        styles,
        english_break_unit,
        korean_break_unit,
        AutoSpacing::default(),
        &[],
    )
}

/// 문단 텍스트를 줄 나눔 토큰으로 분할한다. 인라인 개체를 토큰에 포함하는 버전.
///
/// `inline_controls`: (문자 위치, HWPUNIT 폭, own_line) 목록 — 위치 오름차순 정렬 필요.
/// 개체 위치에서 텍스트 토큰(어절/단어)을 강제로 분할하고 InlineControl 토큰을
/// 삽입해 fill_lines가 개체 폭만큼 가로 공간을 예약하게 한다.
fn tokenize_paragraph_with_controls(
    text_chars: &[char],
    char_offsets: &[u32],
    char_shapes: &[CharShapeRef],
    styles: &ResolvedStyleSet,
    english_break_unit: u8,
    korean_break_unit: u8,
    auto_spacing: AutoSpacing,
    inline_controls: &[(usize, i32, bool)],
) -> Vec<BreakToken> {
    let text_len = text_chars.len();
    if text_len == 0 {
        return Vec::new();
    }

    let mut tokens = Vec::new();
    let grapheme_ends = grapheme_end_map(text_chars);
    let mut i = 0;
    let mut current_lang: usize = 0;
    let mut ctrls = inline_controls.iter().copied().peekable();

    // 현재 문자 위치 i에 삽입된 인라인 개체 토큰을 방출한다 (문자를 소비하지 않음).
    // 텍스트 토큰 폰트와 같은 활성 글자 모양 크기를 써서 줄 높이 계산이 흔들리지
    // 않게 한다 (개체 실제 높이는 reflow의 metrics 패치가 별도로 반영).
    macro_rules! emit_inline_controls_at {
        ($pos:expr) => {{
            let pos = $pos;
            while let Some(&(cpos, width_hwp, own_line)) = ctrls.peek() {
                if cpos > pos {
                    break;
                }
                if cpos == pos {
                    let utf16_pos = if pos < char_offsets.len() {
                        char_offsets[pos]
                    } else {
                        pos as u32
                    };
                    let style_id = find_active_char_shape(char_shapes, utf16_pos);
                    let font_size = style_font_size(styles, style_id);
                    let fs = if font_size > 0.0 { font_size } else { 12.0 };
                    tokens.push(BreakToken::InlineControl {
                        idx: pos,
                        width_hwp,
                        max_font_size: fs,
                        own_line,
                    });
                }
                // cpos < pos 는 정렬 깨짐/중복 방어 — 건너뛴다
                ctrls.next();
            }
        }};
    }

    while i < text_len {
        emit_inline_controls_at!(i);
        let ch = text_chars[i];

        // 강제 줄 바꿈
        if ch == '\n' {
            let style_id = char_style_id_at(char_offsets, char_shapes, i);
            tokens.push(BreakToken::LineBreak {
                idx: i,
                max_font_size: style_font_size(styles, style_id),
            });
            i += 1;
            continue;
        }

        // 탭
        if ch == '\t' {
            let utf16_pos = if i < char_offsets.len() {
                char_offsets[i]
            } else {
                i as u32
            };
            let style_id = find_active_char_shape(char_shapes, utf16_pos);
            let font_size = style_font_size(styles, style_id);
            let font_size = if font_size > 0.0 { font_size } else { 12.0 };
            tokens.push(BreakToken::Tab {
                idx: i,
                max_font_size: font_size,
            });
            i += 1;
            continue;
        }

        // 고정폭 공백(HWP code 31 / HWPX fwSpace)도 줄 나눔 지점이다.
        // 비분리 공백 U+00A0/U+202F는 어절 안에 남긴다.
        if is_breakable_space(ch) {
            let utf16_pos = if i < char_offsets.len() {
                char_offsets[i]
            } else {
                i as u32
            };
            let style_id = find_active_char_shape(char_shapes, utf16_pos);
            let ts = resolved_to_text_style(styles, style_id, current_lang);
            // 줄 높이는 글자 모양 기준 크기를 쓴다 — 언어별 상대 크기는 넣지 않는다
            // (글자 토큰과 같은 규칙, 오라클 H4: 상대 크기 106% 공백 줄 1217 → 저장 1148).
            let base_size = style_font_size(styles, style_id);
            let font_size = if base_size > 0.0 { base_size } else { 12.0 };
            let space = if ch == ' ' { " " } else { "\u{2007}" };
            let w = estimate_text_width_unrounded(space, &ts);
            tokens.push(BreakToken::Space {
                idx: i,
                width: w,
                max_font_size: font_size,
                is_fixed_width: ch == '\u{2007}',
            });
            i += 1;
            continue;
        }

        // 한글 어절 또는 글자.
        // [#2185] bit7=1(KEEP_WORD)이 **글자 단위**, bit7=0(BREAK_WORD)이
        // 어절 단위 — 스키마 명목과 반대 (한컴 통제 실측 3중 확증: #2169
        // kbu 사다리, 80168 r10, #2185 giant-cell LINE_SEG [0,44,84,122]
        // 보존 대조). 종전 == 1 어절 분기는 역해석 (0da18bbc 회귀).
        if is_hangul(ch) {
            if korean_break_unit == 0 {
                // 어절 모드: 연속 한글 + 후행 금칙 문자를 하나의 토큰으로
                let start = i;
                let mut max_fs = 0.0f64;
                let mut token_text = String::new();

                while i < text_len {
                    let c = text_chars[i];
                    if is_breakable_space(c) || c == '\n' || c == '\t' {
                        break;
                    }
                    // 인라인 개체 위치에서는 어절 토큰을 분할
                    if ctrls.peek().is_some_and(|&(p, ..)| p == i) {
                        break;
                    }
                    // 한글이 아니고 라틴이면 다른 토큰으로 분리
                    if !is_hangul(c) && is_latin(c) {
                        break;
                    }
                    // CJK 한자/일본어는 개별 토큰
                    if is_cjk_ideograph(c) {
                        break;
                    }

                    let utf16_pos = if i < char_offsets.len() {
                        char_offsets[i]
                    } else {
                        i as u32
                    };
                    let style_id = find_active_char_shape(char_shapes, utf16_pos);
                    if !is_lang_neutral(c) {
                        current_lang = detect_lang_category(c);
                    }
                    let font_size = style_font_size(styles, style_id);
                    let fs = if font_size > 0.0 { font_size } else { 12.0 };
                    if fs > max_fs {
                        max_fs = fs;
                    }
                    token_text.push(c);
                    i += 1;
                }

                // 후행 금칙 문자 (줄 머리 금칙) 흡수
                while i < text_len
                    && is_line_start_forbidden(text_chars[i])
                    && text_chars[i] != '\n'
                    && text_chars[i] != '\t'
                    && !ctrls.peek().is_some_and(|&(p, ..)| p == i)
                {
                    let c = text_chars[i];
                    let utf16_pos = if i < char_offsets.len() {
                        char_offsets[i]
                    } else {
                        i as u32
                    };
                    let style_id = find_active_char_shape(char_shapes, utf16_pos);
                    if !is_lang_neutral(c) {
                        current_lang = detect_lang_category(c);
                    }
                    let font_size = style_font_size(styles, style_id);
                    let fs = if font_size > 0.0 { font_size } else { 12.0 };
                    if fs > max_fs {
                        max_fs = fs;
                    }
                    token_text.push(c);
                    i += 1;
                }

                if !token_text.is_empty() {
                    let width = measure_token_width(
                        &token_text,
                        start,
                        char_offsets,
                        char_shapes,
                        styles,
                        current_lang,
                    );
                    // 줄보다 긴 어절의 강제 분할(char_level_break_hwp)도 실제 글자 폭으로
                    // 채운다. 종전 빈 폭 목록은 글자당 글꼴 크기 휴리스틱(1.0em)으로
                    // 떨어져 한글(0.97em)이 한컴보다 한 글자 적게 들어갔다 (스윕 16/16).
                    let cw = measure_grapheme_widths_linear(
                        text_chars,
                        start,
                        i,
                        &grapheme_ends,
                        char_offsets,
                        char_shapes,
                        styles,
                        current_lang,
                    );
                    tokens.push(BreakToken::Text {
                        start_idx: start,
                        end_idx: i,
                        width,
                        max_font_size: max_fs,
                        char_widths: cw,
                        trailing_spacing: 0.0,
                        char_spacings: vec![],
                    });
                }
                continue;
            } else {
                // 글자 모드에서도 Unicode grapheme cluster는 분할하지 않는다.
                current_lang = detect_lang_category(ch);
                let end = grapheme_ends[i];
                let (w, fs, lang) = measure_grapheme_metrics(
                    text_chars,
                    i,
                    end,
                    char_offsets,
                    char_shapes,
                    styles,
                    current_lang,
                );
                current_lang = lang;
                tokens.push(BreakToken::Text {
                    start_idx: i,
                    end_idx: end,
                    width: w,
                    max_font_size: fs,
                    char_widths: grapheme_char_widths(w, end - i),
                    trailing_spacing: 0.0,
                    char_spacings: vec![],
                });
                i = end;
                continue;
            }
        }

        // 라틴 단어 또는 글자
        if is_latin(ch) {
            if english_break_unit == 0 || english_break_unit == 1 {
                // 단어/하이픈 모드: 연속 라틴 문자를 하나의 토큰으로
                let start = i;
                let mut max_fs = 0.0f64;
                let mut token_text = String::new();

                while i < text_len {
                    let c = text_chars[i];
                    if is_breakable_space(c) || c == '\n' || c == '\t' {
                        break;
                    }
                    // 인라인 개체 위치에서는 단어 토큰을 분할
                    if ctrls.peek().is_some_and(|&(p, ..)| p == i) {
                        break;
                    }
                    if !is_latin(c) && !is_word_break_neutral(c) {
                        break;
                    }
                    // 하이픈 모드: 하이픈에서 분할 (하이픈 포함 후 분리)
                    if english_break_unit == 1 && c == '-' && !token_text.is_empty() {
                        let utf16_pos = if i < char_offsets.len() {
                            char_offsets[i]
                        } else {
                            i as u32
                        };
                        let style_id = find_active_char_shape(char_shapes, utf16_pos);
                        let font_size = style_font_size(styles, style_id);
                        let fs = if font_size > 0.0 { font_size } else { 12.0 };
                        if fs > max_fs {
                            max_fs = fs;
                        }
                        token_text.push(c);
                        i += 1;
                        break; // 하이픈 뒤에서 분할
                    }

                    let utf16_pos = if i < char_offsets.len() {
                        char_offsets[i]
                    } else {
                        i as u32
                    };
                    let style_id = find_active_char_shape(char_shapes, utf16_pos);
                    if !is_lang_neutral(c) {
                        current_lang = 1; // English
                    }
                    let font_size = style_font_size(styles, style_id);
                    let fs = if font_size > 0.0 { font_size } else { 12.0 };
                    if fs > max_fs {
                        max_fs = fs;
                    }
                    token_text.push(c);
                    i += 1;
                }

                if !token_text.is_empty() {
                    let width = measure_token_width(
                        &token_text,
                        start,
                        char_offsets,
                        char_shapes,
                        styles,
                        current_lang,
                    );
                    // 개별 글자 폭 수집 (char_level_break용)
                    let cw = measure_grapheme_advances(
                        text_chars,
                        start,
                        i,
                        &grapheme_ends,
                        char_offsets,
                        char_shapes,
                        styles,
                        current_lang,
                    );
                    tokens.push(BreakToken::Text {
                        start_idx: start,
                        end_idx: i,
                        width,
                        max_font_size: max_fs,
                        char_widths: cw,
                        trailing_spacing: 0.0,
                        char_spacings: vec![],
                    });
                }
                continue;
            } else {
                // 글자 모드 (grapheme cluster 단위)
                current_lang = 1;
                let end = grapheme_ends[i];
                let (w, fs, lang) = measure_grapheme_metrics(
                    text_chars,
                    i,
                    end,
                    char_offsets,
                    char_shapes,
                    styles,
                    current_lang,
                );
                current_lang = lang;
                tokens.push(BreakToken::Text {
                    start_idx: i,
                    end_idx: end,
                    width: w,
                    max_font_size: fs,
                    char_widths: grapheme_char_widths(w, end - i),
                    trailing_spacing: 0.0,
                    char_spacings: vec![],
                });
                i = end;
                continue;
            }
        }

        // CJK 한자/일본어: 항상 개별 토큰
        if is_cjk_ideograph(ch) {
            current_lang = detect_lang_category(ch);
            let end = grapheme_ends[i];
            let (w, fs, lang) = measure_grapheme_metrics(
                text_chars,
                i,
                end,
                char_offsets,
                char_shapes,
                styles,
                current_lang,
            );
            current_lang = lang;
            tokens.push(BreakToken::Text {
                start_idx: i,
                end_idx: end,
                width: w,
                max_font_size: fs,
                char_widths: grapheme_char_widths(w, end - i),
                trailing_spacing: 0.0,
                char_spacings: vec![],
            });
            i = end;
            continue;
        }

        // 기타 문자 (기호, NonBreakingSpace 등): 개별 Text 토큰
        {
            let lang = if is_lang_neutral(ch) {
                current_lang
            } else {
                let detected = detect_lang_category(ch);
                current_lang = detected;
                detected
            };
            let end = grapheme_ends[i];
            let (w, fs, lang) = measure_grapheme_metrics(
                text_chars,
                i,
                end,
                char_offsets,
                char_shapes,
                styles,
                lang,
            );
            current_lang = lang;
            tokens.push(BreakToken::Text {
                start_idx: i,
                end_idx: end,
                width: w,
                max_font_size: fs,
                char_widths: grapheme_char_widths(w, end - i),
                trailing_spacing: 0.0,
                char_spacings: vec![],
            });
            i = end;
        }
    }

    // 텍스트 끝에 위치한 인라인 개체 (painter는 문단 끝 TAC를 마지막 줄에 방출)
    emit_inline_controls_at!(text_len);

    annotate_trailing_spacing(
        &mut tokens,
        text_chars,
        &grapheme_ends,
        char_offsets,
        char_shapes,
        styles,
        auto_spacing,
    );
    tokens
}

/// 토큰 텍스트의 폭을 글자별 언어 인식 측정으로 합산한다.
fn measure_token_width(
    text: &str,
    start_char_idx: usize,
    char_offsets: &[u32],
    char_shapes: &[CharShapeRef],
    styles: &ResolvedStyleSet,
    default_lang: usize,
) -> f64 {
    let mut total = 0.0;
    let mut current_lang = default_lang;
    let mut run_text = String::new();
    let mut run_style = None;
    let mut run_lang = current_lang;
    for (offset, ch) in text.chars().enumerate() {
        let idx = start_char_idx + offset;
        let utf16_pos = if idx < char_offsets.len() {
            char_offsets[idx]
        } else {
            idx as u32
        };
        let style_id = find_active_char_shape(char_shapes, utf16_pos);
        let lang = if is_lang_neutral(ch) {
            current_lang
        } else {
            let detected = detect_lang_category(ch);
            current_lang = detected;
            detected
        };
        if run_style != Some(style_id) || run_lang != lang {
            if let Some(active_style) = run_style {
                let ts = resolved_to_text_style(styles, active_style, run_lang);
                total += estimate_text_width_unrounded(&run_text, &ts);
                run_text.clear();
            }
            run_style = Some(style_id);
            run_lang = lang;
        }
        run_text.push(ch);
    }
    if let Some(active_style) = run_style {
        let ts = resolved_to_text_style(styles, active_style, run_lang);
        total += estimate_text_width_unrounded(&run_text, &ts);
    }
    total
}

/// px를 HWPUNIT(i32)로 변환 (내림, DPI=96 기준: px * 75)
#[inline]
fn to_hwp(px: f64) -> i32 {
    (px * 75.0) as i32
}

fn is_breakable_space(ch: char) -> bool {
    matches!(ch, ' ' | '\u{2007}')
}

fn condense_space_savings_hwp(space_width_hwp: i32, condense_min_space: u8) -> i32 {
    if condense_min_space == 0 || space_width_hwp <= 0 {
        return 0;
    }
    let shrink_percent = condense_min_space.min(75) as i32;
    space_width_hwp * shrink_percent / 100
}

fn condensed_line_width_hwp(width_hwp: i32, space_savings_hwp: i32) -> i32 {
    width_hwp - space_savings_hwp
}

/// 한컴(macOS) 공백 압축(condense) 규칙: 어절 앞 공백까지의 자연 폭이 이미 줄 폭을
/// 넘었으면(앞 어절을 압축해서 넣은 줄) 다음 어절의 어떤 글자도 그 줄에 넣지 않는다.
/// 자연 폭 안에 있는 줄에서는 다음 어절을 압축 한도(공백 폭 × condense%) 안에서
/// 통째로 또는 글자 단위로 나눠 넣는다. 합성 탐침 J_condense(함초롬바탕 15pt·
/// 한컴바탕 9.5pt, condense 0–70%, 자간 0/−5/−10%): 84문단 중 75문단 줄 나눔 일치
/// (종전 17). 어절 중간 글자에는 적용하지 않는다.
fn line_full_before_word(tokens: &[BreakToken], ti: usize, lw: i32, effective_width: i32) -> bool {
    matches!(
        ti.checked_sub(1).and_then(|p| tokens.get(p)),
        Some(BreakToken::Space { width, .. }) if lw - to_hwp(*width) > effective_width
    )
}

#[allow(dead_code)]
fn condense_fit_can_pull_next_token(
    current_width_hwp: i32,
    current_space_savings_hwp: i32,
    effective_width_hwp: i32,
    max_font_size: f64,
    has_inline_object: bool,
    next_token_width_hwp: i32,
) -> bool {
    let current_condensed_width =
        condensed_line_width_hwp(current_width_hwp, current_space_savings_hwp);
    let remaining_hwp = effective_width_hwp - current_condensed_width;
    // Hancom uses condense to rescue a line that still has a meaningful
    // natural gap, but it does not pull the next word into an already tight
    // line. The p03 PDF preface is sensitive to that distinction.
    let min_remaining_hwp = if has_inline_object {
        // A short word after an inline object only needs its own advance.
        to_hwp((max_font_size * 2.0).max(20.0)).min(next_token_width_hwp)
    } else {
        to_hwp((max_font_size * 2.5).max(20.0))
    };
    remaining_hwp >= min_remaining_hwp
}

/// SQUEEZE는 폭을 넘으면 자간을 줄이고, 명시적 줄바꿈에서만 줄을 나눈다.
/// macOS 한컴 탐침: 맑은 고딕/함초롬바탕 12pt 문장을 160~60pt 폭에 모두 한 줄로 배치.
fn squeeze_lines(tokens: &[BreakToken], text_len: usize) -> Vec<LineBreakResult> {
    let mut lines = Vec::new();
    let mut start_idx = 0;
    let mut max_font_size = 0.0f64;
    for token in tokens {
        match token {
            BreakToken::LineBreak {
                idx,
                max_font_size: break_font_size,
            } => {
                max_font_size = max_font_size.max(*break_font_size);
                lines.push(LineBreakResult {
                    start_idx,
                    end_idx: *idx + 1,
                    max_font_size,
                    has_line_break: true,
                });
                start_idx = *idx + 1;
                max_font_size = 0.0;
            }
            BreakToken::Text {
                max_font_size: fs, ..
            }
            | BreakToken::Space {
                max_font_size: fs, ..
            }
            | BreakToken::Tab {
                max_font_size: fs, ..
            }
            | BreakToken::InlineControl {
                max_font_size: fs, ..
            } => {
                max_font_size = max_font_size.max(*fs);
            }
        }
    }
    lines.push(LineBreakResult {
        start_idx,
        end_idx: text_len,
        max_font_size,
        has_line_break: false,
    });
    lines
}

/// 토큰을 줄에 배치하는 Greedy 알고리즘
/// 한컴과 동일한 결과를 위해 HWPUNIT 정수로 폭을 누적한다.
fn fill_lines(
    tokens: &[BreakToken],
    text_chars: &[char],
    available_width_px: f64,
    indent_px: f64,
    head_reserve_px: (f64, f64),
    para_style: Option<&ResolvedParaStyle>,
    korean_break_unit: u8,
    english_break_unit: u8,
    condense_min_space: u8,
    band_plan: Option<&LineBandPlan>,
) -> Vec<LineBreakResult> {
    if tokens.is_empty() {
        return vec![LineBreakResult {
            start_idx: 0,
            end_idx: 0,
            max_font_size: 0.0,
            has_line_break: false,
        }];
    }

    let default_tab_width = para_style.map(|s| s.default_tab_width).unwrap_or(0.0);
    let tab_w_px = if default_tab_width > 0.0 {
        default_tab_width
    } else {
        48.0
    };
    let custom_tabs =
        para_style.filter(|style| !style.tab_stops.is_empty() || style.auto_tab_right);
    let mut results = Vec::new();
    let mut line_start_idx = 0usize;
    let mut lw = 0i32; // HWPUNIT 정수 누적
    let mut line_space_savings = 0i32;
    let mut last_content_end = 0usize;
    let mut space_content_end = 0usize;
    let mut consecutive_spaces = 0usize;
    let mut space_run_has_fixed_width = false;
    let mut line_max_fs = 0.0f64;
    let mut is_first_line = true;

    let mut last_break_token_idx: Option<usize> = None;
    let mut last_break_char_idx: usize = 0;
    let mut width_at_last_break = 0i32;
    let mut space_savings_at_last_break = 0i32;
    let mut fs_at_last_break = 0.0f64;
    // 직전에 줄에 놓인 텍스트 토큰의 trailing 폭 (그 뒤에서 줄을 끝낼 때 맞춤 판정에서 뺀다)
    let mut last_trailing_hwp = 0i32;

    // 글자 단위로 나눌 수 있는 글자인지 (문단의 줄 나눔 기준 설정)
    // 한글: breakNonLatinWord=KEEP_WORD(bit7=1) / 영문·숫자: breakLatinWord=BREAK_WORD(2)
    let char_breakable = |c: char| -> bool {
        // 한컴 PUA 책괄호는 일반 글자처럼 나눈다. U+F0855 는 줄 머리에도
        // 올 수 있으므로 표준 『』의 금칙 분류로 바꾸지 않는다.
        if is_hangul(c) || matches!(c, '\u{F0854}' | '\u{F0855}') {
            korean_break_unit == 1
        } else if is_latin(c) {
            english_break_unit == 2
        } else {
            is_cjk_ideograph(c)
        }
    };

    // 어울림 배제 계획이 있으면 현재 줄의 가용 폭을 대역별로 좁힌다. 줄이
    // 확정될 때마다(results.push 직후) 다음 줄 대역으로 갱신한다. 계획이 없으면
    // 항상 전폭 — 기존 동작과 바이트 동일.
    let current_line_w = std::cell::Cell::new(match band_plan {
        Some(plan) => plan.interval_at(0.0, 0.0).1,
        None => available_width_px,
    });
    let current_band_top = std::cell::Cell::new(0.0);
    let advance_band = |results: &[LineBreakResult]| {
        if let Some(plan) = band_plan {
            let fs = results.last().map(|r| r.max_font_size).unwrap_or(0.0);
            let y = current_band_top.get() + plan.advance_px(fs);
            current_band_top.set(y);
            current_line_w.set(plan.interval_at(y, fs).1);
        }
    };
    let eff_w = |first: bool| -> i32 {
        // 문단 머리(번호/글머리표)는 첫 줄(자동 내어쓰기면 이어지는 줄도) 가용 폭을 줄인다.
        let reserve = if first {
            head_reserve_px.0
        } else {
            head_reserve_px.1
        };
        let base_w = (current_line_w.get() - reserve).max(1.0);
        if indent_px > 0.0 {
            if first {
                to_hwp((base_w - indent_px).max(1.0))
            } else {
                to_hwp(base_w)
            }
        } else if indent_px < 0.0 {
            if first {
                to_hwp(base_w)
            } else {
                to_hwp((base_w + indent_px).max(1.0))
            }
        } else {
            to_hwp(base_w)
        }
    };

    for (ti, token) in tokens.iter().enumerate() {
        consecutive_spaces = if matches!(token, BreakToken::Space { .. }) {
            consecutive_spaces + 1
        } else {
            0
        };
        if consecutive_spaces == 1 {
            space_run_has_fixed_width = tokens[ti..]
                .iter()
                .take_while(|token| matches!(token, BreakToken::Space { .. }))
                .any(|token| {
                    matches!(
                        token,
                        BreakToken::Space {
                            is_fixed_width: true,
                            ..
                        }
                    )
                });
        }
        match token {
            BreakToken::Text { end_idx, .. } => last_content_end = *end_idx,
            BreakToken::Tab { idx, .. } | BreakToken::InlineControl { idx, .. } => {
                last_content_end = *idx + 1;
            }
            BreakToken::Space { .. } => space_content_end = last_content_end,
            _ => {}
        }
        // 줄 머리 공백만 있는 줄은 첫 어절이나 개체를 압축해서 끌어오지 않는다.
        // 내용 뒤 공백이 생긴 줄은 기존 전체 공백 압축 여유를 유지한다.
        let eligible_space_savings = if space_content_end > line_start_idx {
            line_space_savings
        } else {
            0
        };
        match token {
            BreakToken::LineBreak {
                idx,
                max_font_size: break_font_size,
            } => {
                // 줄바꿈 문자도 줄 높이에 참여한다. 빈 11pt 줄을 기본 9pt로
                // 내리거나 9pt 본문 뒤의 16pt 줄바꿈을 무시하면 뒤 줄이 올라간다.
                line_max_fs = line_max_fs.max(*break_font_size);
                results.push(LineBreakResult {
                    start_idx: line_start_idx,
                    end_idx: *idx + 1,
                    max_font_size: line_max_fs,
                    has_line_break: true,
                });
                advance_band(&results);
                line_start_idx = *idx + 1;
                lw = 0;
                line_space_savings = 0;
                line_max_fs = 0.0;
                is_first_line = false;
                last_break_token_idx = None;
            }
            BreakToken::Tab { idx, max_font_size } => {
                if let Some(style) = custom_tabs {
                    let (following_advance, terminal_spacing) = tokens[ti + 1..]
                        .iter()
                        .take_while(|token| {
                            !matches!(token, BreakToken::Tab { .. } | BreakToken::LineBreak { .. })
                        })
                        .fold((0_i32, 0_i32), |(advance, _), token| {
                            let (width, trailing) = match token {
                                BreakToken::Text {
                                    width,
                                    trailing_spacing,
                                    ..
                                } => (to_hwp(*width), to_hwp(*trailing_spacing)),
                                BreakToken::Space { width, .. } => (to_hwp(*width), 0),
                                BreakToken::InlineControl { width_hwp, .. } => (*width_hwp, 0),
                                _ => (0, 0),
                            };
                            (advance.saturating_add(width), trailing)
                        });
                    // 줄 맞춤처럼 마지막 글자 뒤 자간은 제외한다. 음수 자간을
                    // 포함하면 오른쪽 탭이 그만큼 밀려 끝 글자만 다음 줄로 넘는다.
                    let following_width = following_advance.saturating_sub(terminal_spacing);
                    let next_stop = |width: i32, first: bool| {
                        let reserve = if first {
                            head_reserve_px.0
                        } else {
                            head_reserve_px.1
                        };
                        let indent = if first {
                            indent_px.max(0.0)
                        } else {
                            -indent_px.min(0.0)
                        };
                        let origin = style.margin_left + reserve + indent;
                        let absolute_x = origin + width as f64 / 75.0;
                        let (position, kind, _) = find_next_tab_stop(
                            absolute_x,
                            &style.tab_stops,
                            tab_w_px,
                            style.auto_tab_right,
                            current_line_w.get(),
                        );
                        // 명시적 탭은 단 기준, 자동 오른쪽 탭은 본문 여백 기준이다.
                        let position = if kind == 1 && style.auto_tab_right {
                            style.margin_left + position
                        } else {
                            position
                        };
                        let target =
                            to_hwp(position - origin) - if kind == 1 { following_width } else { 0 };
                        (target.max(width), kind)
                    };
                    let (target, kind) = next_stop(lw, is_first_line);
                    if kind <= 1 {
                        line_max_fs = line_max_fs.max(*max_font_size);
                        // 정지점이 줄 밖이면 탭부터 다음 줄로 넘긴다.
                        // 앞 텍스트를 마지막 공백까지 되돌리지 않는다.
                        if target > eff_w(is_first_line) && line_start_idx < *idx {
                            results.push(LineBreakResult {
                                start_idx: line_start_idx,
                                end_idx: *idx,
                                max_font_size: line_max_fs,
                                has_line_break: false,
                            });
                            advance_band(&results);
                            line_start_idx = *idx;
                            is_first_line = false;
                            lw = next_stop(0, false).0;
                            line_space_savings = 0;
                            line_max_fs = *max_font_size;
                            last_break_token_idx = None;
                        } else {
                            // 뒤 낱말이 넘치면 탭은 앞 줄 끝에 남는다. 다음 줄로
                            // 탭까지 옮기면 낱말이 다시 들여써진다 (한컴 탐침).
                            last_break_token_idx = Some(ti);
                            last_break_char_idx = *idx + 1;
                            width_at_last_break = target;
                            space_savings_at_last_break = line_space_savings;
                            fs_at_last_break = line_max_fs;
                            lw = target;
                        }
                        last_trailing_hwp = 0;
                        continue;
                    }
                }
                // 탭 계산은 px로 수행 후 HWPUNIT 변환 (정밀도 유지)
                let lw_px = lw as f64 / 75.0;
                let next_tab_px = ((lw_px / tab_w_px).floor() + 1.0) * tab_w_px;
                let next_tab_hwp = to_hwp(next_tab_px);
                if *max_font_size > line_max_fs {
                    line_max_fs = *max_font_size;
                }

                if next_tab_hwp > eff_w(is_first_line) && line_start_idx < *idx {
                    if let Some(_) = last_break_token_idx {
                        results.push(LineBreakResult {
                            start_idx: line_start_idx,
                            end_idx: last_break_char_idx,
                            max_font_size: fs_at_last_break,
                            has_line_break: false,
                        });
                        advance_band(&results);
                        line_start_idx = last_break_char_idx;
                        lw = lw - width_at_last_break;
                        line_space_savings -= space_savings_at_last_break;
                    } else {
                        results.push(LineBreakResult {
                            start_idx: line_start_idx,
                            end_idx: *idx,
                            max_font_size: line_max_fs,
                            has_line_break: false,
                        });
                        advance_band(&results);
                        line_start_idx = *idx;
                        lw = 0;
                        line_space_savings = 0;
                        line_max_fs = *max_font_size;
                    }
                    is_first_line = false;
                    last_break_token_idx = None;
                    let lw_px2 = lw as f64 / 75.0;
                    let next_tab2 = ((lw_px2 / tab_w_px).floor() + 1.0) * tab_w_px;
                    lw = to_hwp(next_tab2);
                    last_trailing_hwp = 0;
                } else {
                    last_break_token_idx = Some(ti);
                    last_break_char_idx = *idx;
                    width_at_last_break = lw;
                    space_savings_at_last_break = line_space_savings;
                    fs_at_last_break = line_max_fs;
                    lw = next_tab_hwp;
                    last_trailing_hwp = 0;
                }
            }
            BreakToken::Space {
                idx,
                width,
                max_font_size,
                is_fixed_width,
            } => {
                let space_hwp = to_hwp(*width);
                // 고정 공백이 섞인 묶음은 첫 고정 공백(일반 공백은 두 칸)까지
                // 줄 끝에서 흡수한다. 나머지는 먼저 다음 줄에 배치해야 뒤 어절이
                // 공백뿐인 줄에서 쪼개지지 않는다. 일반 공백 묶음은 종전 경로를 쓴다.
                let absorbed_spaces = if *is_fixed_width { 1 } else { 2 };
                if space_run_has_fixed_width
                    && consecutive_spaces > absorbed_spaces
                    && lw + space_hwp > eff_w(is_first_line)
                    && *idx > line_start_idx
                    && (line_start_idx == 0 || space_content_end > line_start_idx)
                {
                    results.push(LineBreakResult {
                        start_idx: line_start_idx,
                        end_idx: *idx,
                        max_font_size: line_max_fs,
                        has_line_break: false,
                    });
                    advance_band(&results);
                    line_start_idx = *idx;
                    lw = 0;
                    line_space_savings = 0;
                    line_max_fs = 0.0;
                    is_first_line = false;
                }
                if *max_font_size > line_max_fs {
                    line_max_fs = *max_font_size;
                }
                last_break_token_idx = Some(ti);
                last_break_char_idx = *idx;
                width_at_last_break = lw;
                space_savings_at_last_break = line_space_savings;
                fs_at_last_break = line_max_fs;
                lw += space_hwp;
                last_trailing_hwp = 0;
                if !is_fixed_width {
                    line_space_savings += condense_space_savings_hwp(space_hwp, condense_min_space);
                }
            }
            BreakToken::InlineControl {
                idx,
                width_hwp,
                max_font_size,
                ..
            } => {
                if *max_font_size > line_max_fs {
                    line_max_fs = *max_font_size;
                }
                // 개체가 현재 줄에 들어가지 않으면 개체 앞에서 줄을 나눈다
                // (줄 시작 개체는 넘치더라도 그대로 배치 — 분할 불가).
                // 개체 직후는 break point로 등록하지 않는다: 줄 끝 경계와 개체
                // 위치가 정확히 겹치면 painter/metrics가 개체를 다음 줄로 판정해
                // (char_pos_in_line 반열림 규칙) anchor 줄이 어긋나기 때문이다.
                if condensed_line_width_hwp(lw + width_hwp, eligible_space_savings)
                    > eff_w(is_first_line)
                    && *idx > line_start_idx
                {
                    // 개체 바로 앞 글자 뒤가 원래 줄을 나눌 수 있는 자리(닫는 문장부호,
                    // 글자 단위 한글, 한자)이면 개체 앞에서 바로 나눈다. 마지막 공백까지
                    // 되돌리면 "형성한다." 의 마침표처럼 줄 머리 금칙 글자나 어절 조각이
                    // 개체와 함께 다음 줄로 넘어가 앞 줄만 짧게 남는다.
                    let break_before_object = text_chars.get(*idx - 1).is_some_and(|&c| {
                        (is_line_start_forbidden(c) && !is_line_end_forbidden(c))
                            || (is_hangul(c) && korean_break_unit == 1)
                            || is_cjk_ideograph(c)
                    });
                    if last_break_token_idx.is_some() && !break_before_object {
                        let mut break_char = last_break_char_idx;
                        let mut next_start = break_char;
                        while next_start < text_chars.len()
                            && is_breakable_space(text_chars[next_start])
                        {
                            next_start += 1;
                        }
                        // 공백 흡수가 개체 위치를 지나치면 개체가 이전 줄 끝에
                        // 좌초한다 (painter는 run 끝의 TAC를 현재 줄에 방출) —
                        // 폭 예약은 다음 줄인데 잉크는 이전 줄에 그려지는 어긋남.
                        // last_break 를 등록한 토큰이 단일 글자 토큰(kbu=1 한글/
                        // CJK 글자 나눔 — 글자 경계 분할 허용)이면 한 글자 앞에서
                        // 다시 나눠, 개체가 다음 줄 텍스트 중간에 놓이고 양 줄이
                        // 공백으로 시작/끝나지 않게 한다 (경계 공백은 justify 로
                        // 늘어나 그려져 컬럼을 넘는다). 그 외에는 개체가 새 줄
                        // 선두가 되도록 되돌린다.
                        if *idx < next_start {
                            let step_back = last_break_token_idx.and_then(|bi| match &tokens[bi] {
                                BreakToken::Text {
                                    start_idx, end_idx, ..
                                } if *end_idx == break_char
                                    && *end_idx - *start_idx == 1
                                    && *start_idx > line_start_idx =>
                                {
                                    Some(*start_idx)
                                }
                                _ => None,
                            });
                            if let Some(bp) = step_back {
                                break_char = bp;
                                next_start = bp;
                            } else {
                                next_start = *idx;
                            }
                        }
                        results.push(LineBreakResult {
                            start_idx: line_start_idx,
                            end_idx: break_char,
                            max_font_size: fs_at_last_break,
                            has_line_break: false,
                        });
                        advance_band(&results);
                        line_start_idx = next_start;
                        lw = recalc_width_hwp(tokens, ti, next_start);
                        line_space_savings =
                            recalc_space_savings_hwp(tokens, ti, next_start, condense_min_space);
                        lw += width_hwp;
                        last_trailing_hwp = 0;
                        line_max_fs = *max_font_size;
                        is_first_line = false;
                        last_break_token_idx = None;
                    } else {
                        // 같은 위치에 연속으로 배치된 인라인 개체가 현재 줄에 있으면
                        // 함께 다음 줄로 본낸다 — painter는 줄 끝 경계에 걸린 개체를
                        // 다음 줄 선두로 판정하므로, 폭 예약 줄과 그리는 줄을 맞춘다.
                        let mut carry_w = 0i32;
                        let mut k = ti;
                        while k > 0 {
                            match &tokens[k - 1] {
                                BreakToken::InlineControl {
                                    idx: prev_idx,
                                    width_hwp: prev_w,
                                    ..
                                } if *prev_idx == *idx => {
                                    carry_w += prev_w;
                                    k -= 1;
                                }
                                _ => break,
                            }
                        }
                        results.push(LineBreakResult {
                            start_idx: line_start_idx,
                            end_idx: *idx,
                            max_font_size: line_max_fs,
                            has_line_break: false,
                        });
                        advance_band(&results);
                        line_start_idx = *idx;
                        lw = *width_hwp + carry_w;
                        line_space_savings = 0;
                        line_max_fs = *max_font_size;
                        is_first_line = false;
                        last_break_token_idx = None;
                    }
                } else {
                    lw += width_hwp;
                    last_trailing_hwp = 0;
                }
            }
            BreakToken::Text {
                start_idx,
                end_idx,
                width,
                max_font_size,
                ref char_widths,
                trailing_spacing,
                ref char_spacings,
            } => {
                if *max_font_size > line_max_fs {
                    line_max_fs = *max_font_size;
                }

                let w_hwp = to_hwp(*width);
                let trailing_hwp = to_hwp(*trailing_spacing);
                // 단일 문자 CJK/한글 토큰의 줄바꿈 가능 지점 처리
                // 이 글자를 포함한 후 break point 갱신 (end_idx 사용)
                // → 초과 시 이 글자까지 L0에 포함하고 다음 토큰부터 다음 줄
                let is_single_grapheme = !char_widths.is_empty()
                    && char_widths.iter().skip(1).all(|width| *width == 0.0);
                if (*end_idx - *start_idx == 1 || is_single_grapheme) && *start_idx > line_start_idx
                {
                    let c = text_chars[*start_idx];
                    // 글자 단위 한글은 앞이 라틴 등 다른 토큰이어도 그 사이에서 나눌 수
                    // 있다 — 한컴은 `SF의` 를 `SF|의` 로 나눈다 (onsaemiro-textbook p5).
                    // 글자 단위 영문(BREAK_WORD)도 앞 어절과의 경계에서 나눌 수 있다.
                    let prev = text_chars[*start_idx - 1];
                    // `’(` 처럼 닫는 부호 다음에 여는 부호가 오면 그 사이에서
                    // 나눌 수 있다. 여는 부호까지 현재 줄에 들어가야 이 경계를
                    // 쓴다. 여는 부호도 넘치면 앞 글자와 닫는 부호를 함께 넘긴다.
                    if is_line_end_forbidden(c)
                        && !is_line_start_forbidden(c)
                        && is_line_start_forbidden(prev)
                        && !is_line_end_forbidden(prev)
                        && ti > 0
                        && condensed_line_width_hwp(
                            lw + w_hwp - trailing_hwp,
                            eligible_space_savings,
                        ) <= eff_w(is_first_line)
                    {
                        last_break_token_idx = Some(ti - 1);
                        last_break_char_idx = *start_idx;
                        width_at_last_break = lw;
                        space_savings_at_last_break = line_space_savings;
                        fs_at_last_break = line_max_fs;
                    }
                    let same_script_prev = if is_hangul(c) {
                        is_hangul(prev)
                    } else {
                        is_latin(prev)
                    };
                    if (is_hangul(c) || is_latin(c))
                        && char_breakable(c)
                        && !is_breakable_space(prev)
                        && !same_script_prev
                        && !is_line_end_forbidden(prev)
                        && !is_line_start_forbidden(c)
                        && ti > 0
                        && condensed_line_width_hwp(lw - last_trailing_hwp, eligible_space_savings)
                            <= eff_w(is_first_line)
                    {
                        last_break_token_idx = Some(ti - 1);
                        last_break_char_idx = *start_idx;
                        width_at_last_break = lw;
                        space_savings_at_last_break = line_space_savings;
                        fs_at_last_break = line_max_fs;
                    }
                    // [#2185] 한글 bit7=1 = 글자 단위 break 허용 (위 주석 참조).
                    // 줄 머리 금칙 글자(`,` `’` 등) 앞에서는 나누지 않는다 — 한컴은
                    // 금칙 글자를 앞 글자와 함께 다음 줄로 넘긴다 (스윕 1,513 문단 위반 0).
                    let allow_break = char_breakable(c)
                        && !is_line_end_forbidden(c)
                        && !text_chars
                            .get(*end_idx)
                            .is_some_and(|&next| is_line_start_forbidden(next));
                    let candidate_w = lw + w_hwp;
                    // 이 글자가 줄에 들어가는 경우에만 break point 갱신
                    if allow_break
                        && !line_full_before_word(tokens, ti, lw, eff_w(is_first_line))
                        && condensed_line_width_hwp(
                            candidate_w - trailing_hwp,
                            eligible_space_savings,
                        ) <= eff_w(is_first_line)
                    {
                        last_break_token_idx = Some(ti);
                        last_break_char_idx = *end_idx; // 이 글자 다음 (이 글자 포함)
                        width_at_last_break = candidate_w; // 이 글자 폭 포함
                        space_savings_at_last_break = line_space_savings;
                        fs_at_last_break = line_max_fs;
                    }
                }
                // 한컴은 정수 글자 폭의 합이 가용 폭을 넘으면 다음 줄로 넘긴다.
                let effective_width = eff_w(is_first_line);
                // 줄 끝 글자의 자간(과 자동 간격)은 맞춤 판정에서 뺀다.
                let natural_candidate = lw + w_hwp - trailing_hwp;
                let condensed_candidate =
                    condensed_line_width_hwp(natural_candidate, eligible_space_savings);
                let needs_condense_to_fit =
                    natural_candidate > effective_width && condensed_candidate <= effective_width;
                // An inline object's attached suffix belongs to the same word.
                // The next-word safeguard must not strand that suffix on a new line.
                let attached_to_inline = matches!(tokens.get(ti.wrapping_sub(1)),
                    Some(BreakToken::InlineControl { idx, .. }) if idx == start_idx);
                let has_inline_object = needs_condense_to_fit
                    && tokens[..ti].iter().any(|token| {
                        matches!(token, BreakToken::InlineControl { idx, .. }
                        if *idx >= line_start_idx && *idx <= *start_idx)
                    });
                let condense_pull_allowed = !needs_condense_to_fit
                    || !line_full_before_word(tokens, ti, lw, effective_width);
                if condensed_candidate > effective_width || !condense_pull_allowed {
                    if *start_idx > line_start_idx {
                        if let Some(bi) = last_break_token_idx {
                            let carried_space_start = spaces_carried_to_next_line(
                                tokens,
                                bi,
                                width_at_last_break,
                                eff_w(is_first_line),
                            );
                            results.push(LineBreakResult {
                                start_idx: line_start_idx,
                                end_idx: carried_space_start.unwrap_or(last_break_char_idx),
                                max_font_size: fs_at_last_break,
                                has_line_break: false,
                            });
                            advance_band(&results);
                            let mut next_start = last_break_char_idx;
                            if let Some(carried) = carried_space_start {
                                next_start = carried;
                            } else {
                                while next_start < text_chars.len()
                                    && is_breakable_space(text_chars[next_start])
                                {
                                    next_start += 1;
                                }
                            }
                            line_start_idx = next_start;
                            lw = recalc_width_hwp(tokens, ti, next_start);
                            line_space_savings = recalc_space_savings_hwp(
                                tokens,
                                ti,
                                next_start,
                                condense_min_space,
                            );
                            let lw_before_token = lw;
                            lw += w_hwp;
                            last_trailing_hwp = trailing_hwp;
                            line_max_fs = *max_font_size;
                            is_first_line = false;
                            last_break_token_idx = None;
                            // 새 줄에서도 넘치는 낱말은 그 줄에서 글자 단위로 나눈다 — 한컴은
                            // `나나나나나 가…가.111…` 의 둘째 어절을 둘째 줄 폭에서 끊는다
                            // (스윕 J_kinsoku BREAK_WORD). 종전에는 줄 폭을 넘긴 채 두었다.
                            if lw - trailing_hwp > eff_w(false) && char_widths.len() > 1 {
                                let cw_hwp: Vec<i32> =
                                    char_widths.iter().map(|w| to_hwp(*w)).collect();
                                let cs_hwp: Vec<i32> =
                                    char_spacings.iter().map(|w| to_hwp(*w)).collect();
                                let (results_part, remaining_w, remaining_fs) =
                                    char_level_break_hwp(
                                        text_chars,
                                        *start_idx,
                                        *end_idx,
                                        &mut line_start_idx,
                                        lw_before_token,
                                        line_max_fs,
                                        eff_w(false),
                                        eff_w(false),
                                        false,
                                        &cw_hwp,
                                        &cs_hwp,
                                        false,
                                        0,
                                    );
                                for r in results_part {
                                    results.push(r);
                                    advance_band(&results);
                                }
                                lw = remaining_w;
                                last_trailing_hwp = 0;
                                line_space_savings = 0;
                                line_max_fs = remaining_fs;
                            }
                            continue;
                        }
                    }
                    // [pr_2219] 블록형 인라인 개체(표/그림/도형)만 놓인 줄의 선두
                    // 토큰이 넘치면 토큰 통째를 다음 줄로 본내고 개체 줄을 빈 텍스트
                    // 줄로 확정한다. char 분할로 첫 글자를 개체 줄에 억지 배치하면
                    // 한 char shape 의 단어가 "e"+"fg" 처럼 한 글자 run 으로 조각나
                    // paint/run 경계가 깨진다. 수식(own_line=false) 줄은 기존 첫 글자
                    // 고정(pin) 동작을 유지한다 (painter anchor 모호성 회피).
                    if *start_idx == line_start_idx
                        && line_hosts_own_line_control(tokens, ti, line_start_idx)
                    {
                        results.push(LineBreakResult {
                            start_idx: line_start_idx,
                            end_idx: *start_idx, // == line_start_idx — 빈 텍스트 줄 (개체 호스트)
                            max_font_size: line_max_fs,
                            has_line_break: false,
                        });
                        advance_band(&results);
                        // line_start_idx 는 유지 — 토큰이 새 줄 선두가 된다.
                        lw = 0;
                        line_space_savings = 0;
                        line_max_fs = *max_font_size;
                        is_first_line = false;
                        last_break_token_idx = None;
                        if w_hwp - trailing_hwp <= eff_w(false) {
                            lw += w_hwp;
                            last_trailing_hwp = trailing_hwp;
                        } else {
                            // 빈 줄에도 넘치는 장문: 새 줄에서 글자 단위 분할.
                            let cw_hwp: Vec<i32> = char_widths.iter().map(|w| to_hwp(*w)).collect();
                            let cs_hwp: Vec<i32> =
                                char_spacings.iter().map(|w| to_hwp(*w)).collect();
                            let (results_part, remaining_w, remaining_fs) = char_level_break_hwp(
                                text_chars,
                                *start_idx,
                                *end_idx,
                                &mut line_start_idx,
                                lw,
                                line_max_fs,
                                eff_w(false),
                                eff_w(false),
                                false,
                                &cw_hwp,
                                &cs_hwp,
                                false,
                                0,
                            );
                            for r in results_part {
                                results.push(r);
                                advance_band(&results);
                            }
                            lw = remaining_w;
                            last_trailing_hwp = 0;
                            line_max_fs = remaining_fs;
                        }
                        continue;
                    }
                    // 토큰에 저장된 개별 글자 폭을 HWPUNIT로 변환
                    let cw_hwp: Vec<i32> = char_widths.iter().map(|w| to_hwp(*w)).collect();
                    let cs_hwp: Vec<i32> = char_spacings.iter().map(|w| to_hwp(*w)).collect();
                    // 직전 토큰이 이 줄에 배치된 인라인 개체인 경우, 첫 글자에서 자륵면
                    // 줄 끝이 개체 위치와 정확히 겹쳐 painter가 개체를 다음 줄로
                    // 판정한다 (anchor 모호성). 첫 글자는 현재 줄에 고정해 피한다.
                    let pin_first_char = *start_idx > line_start_idx
                        && matches!(
                            ti.checked_sub(1).and_then(|p| tokens.get(p)),
                            Some(BreakToken::InlineControl { idx, .. }) if *idx == *start_idx
                        );
                    // 강제 분할이 토큰 첫 글자 앞에서 일어나면 줄이 줄 꼬리 금칙 글자(`(` 등)로
                    // 끝난다. 그 글자를 다음 줄로 함께 넘긴다 (aift `(단계−해당차수)` 좁은 셀).
                    let first_fits = cw_hwp
                        .first()
                        .is_some_and(|w| lw + w <= eff_w(is_first_line));
                    if !pin_first_char && !first_fits && *start_idx >= line_start_idx + 2 {
                        if let Some(BreakToken::Text {
                            start_idx: ps,
                            end_idx: pe,
                            width: pw,
                            ..
                        }) = ti.checked_sub(1).and_then(|p| tokens.get(p))
                        {
                            if *pe == *start_idx
                                && *pe - *ps == 1
                                && is_line_end_forbidden(text_chars[*ps])
                            {
                                results.push(LineBreakResult {
                                    start_idx: line_start_idx,
                                    end_idx: *ps,
                                    max_font_size: line_max_fs,
                                    has_line_break: false,
                                });
                                advance_band(&results);
                                line_start_idx = *ps;
                                lw = to_hwp(*pw);
                                is_first_line = false;
                            }
                        }
                    }
                    let (results_part, remaining_w, remaining_fs) = char_level_break_hwp(
                        text_chars,
                        *start_idx,
                        *end_idx,
                        &mut line_start_idx,
                        lw,
                        line_max_fs,
                        eff_w(is_first_line),
                        eff_w(false),
                        is_first_line,
                        &cw_hwp,
                        &cs_hwp,
                        pin_first_char,
                        eligible_space_savings,
                    );
                    for r in results_part {
                        results.push(r);
                        advance_band(&results);
                        is_first_line = false;
                    }
                    lw = remaining_w;
                    last_trailing_hwp = 0;
                    line_space_savings = 0;
                    line_max_fs = remaining_fs;
                    last_break_token_idx = None;
                    continue;
                } else {
                    lw += w_hwp;
                    last_trailing_hwp = trailing_hwp;
                }
            }
        }
    }

    let last_end = tokens
        .last()
        .map(|t| match t {
            BreakToken::Text { end_idx, .. } => *end_idx,
            BreakToken::Space { idx, .. }
            | BreakToken::Tab { idx, .. }
            | BreakToken::LineBreak { idx, .. } => *idx + 1,
            // 인라인 개체는 문자를 소비하지 않으므로 삽입 위치를 그대로 반환
            BreakToken::InlineControl { idx, .. } => *idx,
        })
        .unwrap_or(text_chars.len());

    if line_start_idx <= last_end {
        results.push(LineBreakResult {
            start_idx: line_start_idx,
            end_idx: last_end,
            max_font_size: line_max_fs,
            has_line_break: false,
        });
    }

    if results.is_empty() {
        results.push(LineBreakResult {
            start_idx: 0,
            end_idx: text_chars.len(),
            max_font_size: 0.0,
            has_line_break: false,
        });
    }

    results
}

/// 줄 끝의 일반 공백 묶음에서 다음 줄 머리로 넘길 첫 공백 위치.
/// 폭 안에 들어가는 공백과 넘치는 한 칸(최소 두 칸)은 앞 줄에 남긴다.
/// 고정 공백이 섞인 묶음은 Space 분기에서 이미 배치했으므로 건드리지 않는다.
fn spaces_carried_to_next_line(
    tokens: &[BreakToken],
    last_space_token: usize,
    width_before_last_space: i32,
    line_width_limit: i32,
) -> Option<usize> {
    let mut run: Vec<(usize, i32)> = Vec::new();
    let mut k = last_space_token;
    loop {
        match &tokens[k] {
            BreakToken::Space {
                is_fixed_width: true,
                ..
            } => return None,
            BreakToken::Space { idx, width, .. }
                if run.last().is_none_or(|(next_idx, _)| *idx + 1 == *next_idx) =>
            {
                run.push((*idx, to_hwp(*width)));
            }
            _ => break,
        }
        if k == 0 {
            break;
        }
        k -= 1;
    }
    if run.len() < 2 {
        return None;
    }
    run.reverse();
    let preceding: i32 = run[..run.len() - 1].iter().map(|(_, w)| *w).sum();
    let mut x = width_before_last_space - preceding;
    let mut keep = 0usize;
    for (_, w) in &run {
        x += w;
        keep += 1;
        if x > line_width_limit {
            break;
        }
    }
    run.get(keep.max(2)).map(|(idx, _)| *idx)
}

/// 현재 줄에 own_line 인라인 개체(표/그림/도형)가 배치됐는지 판별한다.
/// 개체 토큰은 문자를 소비하지 않으므로, idx >= line_start 인 개체가
/// 현재 줄에 놓인 것으로 본다 (개체는 줄 바꿈과 함께 앞으로 이동하므로
/// 이전 줄에 남은 개체가 현재 line_start 이상의 idx 를 가지는 일은 없다).
fn line_hosts_own_line_control(
    tokens: &[BreakToken],
    current_token_idx: usize,
    line_start: usize,
) -> bool {
    tokens[..current_token_idx].iter().any(|t| {
        matches!(
            t,
            BreakToken::InlineControl {
                idx,
                own_line: true,
                ..
            } if *idx >= line_start
        )
    })
}

/// 줄 바꿈 지점 이후 토큰의 누적 폭 재계산 (HWPUNIT)
fn recalc_width_hwp(tokens: &[BreakToken], current_token_idx: usize, new_line_start: usize) -> i32 {
    let mut w = 0i32;
    for t in &tokens[..current_token_idx] {
        match t {
            BreakToken::Text {
                start_idx, width, ..
            } if *start_idx >= new_line_start => {
                w += to_hwp(*width);
            }
            BreakToken::Space { idx, width, .. } if *idx >= new_line_start => {
                w += to_hwp(*width);
            }
            BreakToken::InlineControl { idx, width_hwp, .. } if *idx >= new_line_start => {
                w += width_hwp;
            }
            _ => {}
        }
    }
    w
}

/// 줄 바꿈 지점 이후 공백 압축 가능 폭 재계산 (HWPUNIT)
fn recalc_space_savings_hwp(
    tokens: &[BreakToken],
    current_token_idx: usize,
    new_line_start: usize,
    condense_min_space: u8,
) -> i32 {
    let mut w = 0i32;
    for t in &tokens[..current_token_idx] {
        match t {
            BreakToken::Space {
                idx,
                width,
                is_fixed_width: false,
                ..
            } if *idx >= new_line_start => {
                let space_hwp = to_hwp(*width);
                w += condense_space_savings_hwp(space_hwp, condense_min_space);
            }
            _ => {}
        }
    }
    w
}

/// 긴 단어 폴백: 글자 단위 분할 (HWPUNIT)
/// char_widths_hwp: 토큰 내 각 글자의 HWPUNIT 폭 (None이면 휴리스틱)
/// pin_first_char: true이면 첫 글자는 줄이 넘쳐도 현재 줄에 고정한다
/// (직전 인라인 개체와의 anchor 모호성 회피 — fill_lines 호출부 주석 참조)
fn char_level_break_hwp(
    text_chars: &[char],
    token_start: usize,
    token_end: usize,
    line_start_idx: &mut usize,
    mut lw: i32,
    mut line_max_fs: f64,
    first_line_w: i32,
    normal_w: i32,
    mut is_first_line: bool,
    char_widths_hwp: &[i32],   // 토큰 내 글자별 HWPUNIT 폭
    char_spacings_hwp: &[i32], // 글자별 trailing(자간) 폭 — 줄 끝 글자는 맞춤 판정에서 뺀다
    pin_first_char: bool,
    first_line_space_savings: i32, // 첫 줄 공백 압축(condense) 여유 — 어절을 나눌 때도 쓴다
) -> (Vec<LineBreakResult>, i32, f64) {
    let mut space_savings = first_line_space_savings;
    let mut results = Vec::new();
    let mut current_w = if is_first_line {
        first_line_w
    } else {
        normal_w
    };

    let grapheme_ends = grapheme_end_map(text_chars);
    let mut ci = token_start;
    while ci < token_end {
        let cluster_end = grapheme_ends[ci].min(token_end).max(ci + 1);
        let rel_idx = ci - token_start;
        let cluster_w = if rel_idx < char_widths_hwp.len() {
            char_widths_hwp[rel_idx..(cluster_end - token_start).min(char_widths_hwp.len())]
                .iter()
                .sum()
        } else {
            let ch = text_chars[ci];
            let fs = if line_max_fs > 0.0 { line_max_fs } else { 12.0 };
            let char_w_px = if is_cjk_char(ch) { fs } else { fs * 0.5 };
            to_hwp(char_w_px)
        };
        let cluster_trailing: i32 = char_spacings_hwp
            .get(rel_idx..(cluster_end - token_start).min(char_spacings_hwp.len()))
            .map(|s| s.iter().sum())
            .unwrap_or(0);

        if lw + cluster_w - cluster_trailing > current_w + space_savings
            && ci > *line_start_idx
            && !(pin_first_char && rel_idx == 0)
        {
            // 강제 분할은 줄 머리 금칙을 따지지 않는다 — macOS 한컴은 `1,234|,567` 처럼
            // 쉼표로도 다음 줄을 시작한다 (스윕 I_squeeze 좁은 문단).
            results.push(LineBreakResult {
                start_idx: *line_start_idx,
                end_idx: ci,
                max_font_size: line_max_fs,
                has_line_break: false,
            });
            *line_start_idx = ci;
            lw = cluster_w;
            is_first_line = false;
            current_w = normal_w;
            space_savings = 0;
        } else {
            lw += cluster_w;
        }
        ci = cluster_end;
    }

    (results, lw, line_max_fs)
}

#[cfg(test)]
mod wrap_band_perf_tests {
    use super::*;
    use crate::model::shape::TextFlow;

    #[test]
    fn wrap_band_overlap_uses_text_height_not_line_spacing() {
        let plan = LineBandPlan {
            exclusions: vec![FloatExclusion {
                rect: LayoutRect {
                    x: 60.0,
                    y: 20.0,
                    width: 40.0,
                    height: 40.0,
                },
                geometry: WrapGeometry::Side(TextFlow::BothSides),
            }],
            column_w_px: 100.0,
            generated_body: true,
            ls_type: LineSpacingType::Percent,
            ls_value: 200.0,
            dpi: 96.0,
        };
        assert_eq!(plan.interval_at(0.0, 16.0), (0.0, 100.0));
        assert_eq!(plan.interval_at(8.0, 16.0), (0.0, 60.0));
        assert_eq!(plan.interval_at(60.0, 16.0), (0.0, 100.0));
    }

    #[test]
    #[ignore = "수동 장문단 성능 계측"]
    fn long_wrap_band_fill_perf() {
        const LINE_COUNT: usize = 20_000;
        let text_chars = vec!['\n'; LINE_COUNT];
        let tokens = (0..LINE_COUNT)
            .map(|idx| BreakToken::LineBreak {
                idx,
                max_font_size: 12.0,
            })
            .collect::<Vec<_>>();
        let plan = LineBandPlan {
            exclusions: vec![FloatExclusion {
                rect: LayoutRect {
                    x: 0.0,
                    y: 0.0,
                    width: 80.0,
                    height: 2_000.0,
                },
                geometry: WrapGeometry::Side(TextFlow::BothSides),
            }],
            column_w_px: 600.0,
            generated_body: false,
            ls_type: LineSpacingType::Percent,
            ls_value: 160.0,
            dpi: 96.0,
        };

        let started = std::time::Instant::now();
        let results = fill_lines(
            &tokens,
            &text_chars,
            600.0,
            0.0,
            (0.0, 0.0),
            None,
            0,
            0,
            0,
            Some(&plan),
        );
        let elapsed = started.elapsed();

        assert_eq!(results.len(), LINE_COUNT + 1);
        eprintln!(
            "long_wrap_band_fill lines={} elapsed_us={}",
            LINE_COUNT,
            elapsed.as_micros()
        );
    }
}

#[cfg(test)]
mod grapheme_reflow_tests {
    use super::*;
    use crate::renderer::style_resolver::{ResolvedCharStyle, ResolvedParaStyle};

    fn styles() -> ResolvedStyleSet {
        ResolvedStyleSet {
            char_styles: vec![
                ResolvedCharStyle {
                    font_family: "Noto Sans KR".to_string(),
                    font_families: vec!["Noto Sans KR".to_string(); 7],
                    font_size: 12.0,
                    ..Default::default()
                },
                ResolvedCharStyle {
                    font_family: "Noto Sans KR".to_string(),
                    font_families: vec!["Noto Sans KR".to_string(); 7],
                    font_size: 24.0,
                    ..Default::default()
                },
            ],
            para_styles: vec![ResolvedParaStyle {
                english_break_unit: 2,
                korean_break_unit: 1,
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn overwide_grapheme_is_not_split_by_long_token_fallback() {
        let chars: Vec<char> = "e\u{301}x".chars().collect();
        let mut line_start = 0;
        let (lines, remaining_width, _) = char_level_break_hwp(
            &chars,
            0,
            chars.len(),
            &mut line_start,
            0,
            12.0,
            1000,
            1000,
            true,
            &[1500, 0, 500],
            &[],
            false,
            0,
        );

        assert_eq!(lines.len(), 1);
        assert_eq!((lines[0].start_idx, lines[0].end_idx), (0, 2));
        assert_eq!(line_start, 2);
        assert_eq!(remaining_width, 500);
    }

    #[test]
    fn grapheme_measurement_respects_style_boundary_after_field_gap() {
        let chars: Vec<char> = "e\u{301}x".chars().collect();
        // A field/control stream gap precedes the combining mark. The char-shape
        // boundary uses stream offsets, not visible character indexes.
        let offsets = vec![0, 9, 10];
        let shapes = vec![
            CharShapeRef {
                start_pos: 0,
                char_shape_id: 0,
            },
            CharShapeRef {
                start_pos: 9,
                char_shape_id: 1,
            },
        ];
        let tokens = tokenize_paragraph(&chars, &offsets, &shapes, &styles(), 2, 1);
        let BreakToken::Text {
            start_idx,
            end_idx,
            width,
            max_font_size,
            ..
        } = &tokens[0]
        else {
            panic!("expected grapheme text token");
        };
        assert_eq!((*start_idx, *end_idx), (0, 2));
        assert_eq!(*max_font_size, 24.0);
        let expected = measure_token_width("e\u{301}", 0, &offsets, &shapes, &styles(), 1);
        assert!((*width - expected).abs() < 1e-9);
    }

    #[test]
    fn inline_control_after_grapheme_keeps_token_and_anchor_order() {
        let chars: Vec<char> = "e\u{301}x".chars().collect();
        let offsets = vec![0, 1, 2];
        let shapes = vec![CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        }];
        let tokens = tokenize_paragraph_with_controls(
            &chars,
            &offsets,
            &shapes,
            &styles(),
            2,
            1,
            AutoSpacing::default(),
            &[(2, 500, false)],
        );

        assert!(matches!(
            tokens.as_slice(),
            [
                BreakToken::Text {
                    start_idx: 0,
                    end_idx: 2,
                    ..
                },
                BreakToken::InlineControl { idx: 2, .. },
                BreakToken::Text {
                    start_idx: 2,
                    end_idx: 3,
                    ..
                }
            ]
        ));
    }
}

/// 문단의 line_segs를 텍스트 내용과 컬럼 너비에 맞게 재계산한다.
///
/// 텍스트 편집(삽입/삭제) 후 호출하여 줄 바꿈을 재배치한다.
/// `available_width_px`는 문단 여백을 제외한 사용 가능 너비(px)이다.
#[derive(Debug, Clone, Copy)]
struct InlineControlMetricsHwp {
    width: i32,
    height: i32,
    baseline: i32,
}

/// 위·아래 캡션은 개체의 세로 점유 상자에 들어간다. 마지막 줄 뒤 간격은 제외한다.
fn inline_caption_height_hwp(caption: &Option<crate::model::shape::Caption>) -> i32 {
    use crate::model::shape::CaptionDirection;
    let Some(cap) = caption else { return 0 };
    if cap.paragraphs.is_empty()
        || !matches!(
            cap.direction,
            CaptionDirection::Top | CaptionDirection::Bottom
        )
    {
        return 0;
    }
    let height = crate::renderer::layout::caption_height_px(caption, 96.0);
    if height > 0.0 {
        px_to_hwpunit_round(height, 96.0).saturating_add(i32::from(cap.spacing))
    } else {
        0
    }
}

fn inline_control_metrics_hwp(ctrl: &Control) -> Option<InlineControlMetricsHwp> {
    let (width, height, baseline) = match ctrl {
        Control::Picture(pic) if pic.common.treat_as_char => {
            let image_height = pic.common.height as i32;
            let top_margin = i32::from(pic.common.margin.top);
            let bottom_margin = i32::from(pic.common.margin.bottom);
            let height = image_height
                .saturating_add(top_margin)
                .saturating_add(bottom_margin)
                .saturating_add(inline_caption_height_hwp(&pic.caption));
            // 한컴 저장 줄: 기준선 = 바깥 여백까지 포함한 개체 상자 높이의 0.85
            // (HWPX 표본 그림 단독 줄 840건 전부). 여백을 빼고 그림 높이만 0.85 로 재면
            // 아래 여백이 글자 아래로 내려가 줄이 그만큼 커진다.
            (
                super::inline_picture_occupied_width_hu(pic),
                height,
                (height as f64 * 0.85).round() as i32,
            )
        }
        Control::Shape(shape) if shape.common().treat_as_char => {
            use crate::model::shape::ShapeObject;
            let common = shape.common();
            let shape_attr = shape.shape_attr();
            let caption = match shape.as_ref() {
                ShapeObject::Group(group) => &group.caption,
                ShapeObject::Picture(picture) => &picture.caption,
                ShapeObject::Chart(chart) if chart.caption.is_some() => &chart.caption,
                ShapeObject::Ole(ole) if ole.caption.is_some() => &ole.caption,
                _ => &shape.drawing()?.caption,
            };
            // 그림과 도형 모두 캡션까지 포함한 상자의 0.85가 기준선이다.
            let height = (common.height as i32)
                .max(shape_attr.current_height as i32)
                .saturating_add(i32::from(common.margin.top))
                .saturating_add(i32::from(common.margin.bottom))
                .saturating_add(inline_caption_height_hwp(caption));
            let width = (common.width as i32)
                .max(shape_attr.current_width as i32)
                .saturating_add(i32::from(common.margin.left))
                .saturating_add(i32::from(common.margin.right))
                .max(0);
            (width, height, (height as f64 * 0.85).round() as i32)
        }
        Control::Table(table) if table.common.treat_as_char => {
            // 한컴 저장 LINE_SEG 는 글자처럼 취급한 표의 줄 높이에 바깥 여백 위/아래를
            // 포함하고(samples 897건 전부 vertsize = 표 높이 + 위 + 아래 여백), 기준선은
            // 그 높이의 85% 다. 줄 채움 폭도 좌우 바깥 여백까지 차지한다.
            let width = (table.get_column_widths().iter().sum::<u32>() as i32)
                .saturating_add(i32::from(table.outer_margin_left.max(0)))
                .saturating_add(i32::from(table.outer_margin_right.max(0)));
            let height = (table.common.height as i32)
                .saturating_add(i32::from(table.outer_margin_top.max(0)))
                .saturating_add(i32::from(table.outer_margin_bottom.max(0)))
                .saturating_add(inline_caption_height_hwp(&table.caption));
            (width, height, (height as f64 * 0.85).round() as i32)
        }
        Control::Equation(eq) if eq.common.treat_as_char => {
            let (_, natural_height, natural_baseline) =
                crate::renderer::equation::intrinsic_metrics_hwp_with_version(
                    &eq.script,
                    eq.font_size,
                    &eq.font_name,
                    &eq.version_info,
                );
            let margin = &eq.common.margin;
            // 인라인 수식의 줄 전진 = 선언(개체 상자) 폭 + 양쪽 outMargin — 개체 상자는
            // 내용이 작아도 그대로 점유하고, 넘치는 잉크도 상자 밖으로 전진을 넓히지
            // 않는다 (eq-002 실측: `=8` 전진 13.13pt = 선언 12.01+여백, `f(n)` 1788HWU =
            // 선언 1677+112 — paint 1651 이 아니라 선언 폭을 쓴다).
            let width = crate::renderer::equation::occupied_width_hwp(eq);
            // 한컴 저장 줄 높이는 수식 개체의 선언 높이 + 바깥 여백 그대로다 (HWPX 표본 수식
            // 줄 3,700여 건: vertsize = 높이 + 위/아래 여백, baseline = 위 여백 + 높이 ×
            // baseLine%). 잉크 기반 흐름 높이는 선언 높이가 없을 때만 쓴다.
            let height = if eq.common.height > 0 {
                eq.common.height as i32
            } else {
                crate::renderer::equation::control_line_flow_height(
                    eq,
                    natural_height as f64,
                    natural_baseline as f64,
                    eq.font_size as f64,
                )
                .round() as i32
            };
            let baseline =
                crate::renderer::equation::control_baseline_hwp(eq, natural_baseline as f64);
            (
                width,
                height + i32::from(margin.top) + i32::from(margin.bottom),
                baseline.round() as i32 + i32::from(margin.top),
            )
        }
        Control::Form(form) => {
            let height = form.height as i32;
            (
                form.occupied_width(),
                height,
                (height as f64 * 0.85).round() as i32,
            )
        }
        _ => return None,
    };

    if width > 0 && height > 0 {
        Some(InlineControlMetricsHwp {
            width,
            height,
            baseline: baseline.clamp(0, height),
        })
    } else {
        None
    }
}

fn apply_inline_control_line_metrics(seg: &mut LineSeg, metrics: InlineControlMetricsHwp) {
    // 한컴 저장 줄: 줄 높이 = 글자·개체 높이의 최댓값, 기준선 = 기준선의 최댓값이다.
    // 위·아래 연장(ascent+descent 합)이 아니다 — 9pt 글자 + 높이 900·기준선 774 수식
    // 줄이 900/774 로 저장된다 (오라클 H2, 표본 7,900여 줄).
    let ascent = seg.baseline_distance.max(metrics.baseline);
    let height = seg.line_height.max(metrics.height);

    if height > seg.line_height || ascent > seg.baseline_distance {
        let text_height = seg.text_height.max(height);
        seg.line_height = height;
        seg.text_height = text_height;
        seg.baseline_distance = ascent;
    }
}

/// 글자 테두리는 기준선을 옮기지 않는다. 아래 선은 보이는 높이에, 위·아래 선은
/// 줄 피치 계산에 들어간다. 줄 진행은 text_height + line_spacing 으로 계산한다.
fn apply_char_border_line_metrics(
    seg: &mut LineSeg,
    end_pos: u32,
    para: &Paragraph,
    styles: &ResolvedStyleSet,
    dpi: f64,
    ls_type: LineSpacingType,
    ls_value: f64,
) {
    use crate::model::style::{BorderLineType, BORDER_WIDTHS};
    let original_height = seg.line_height;
    for (index, shape) in para.char_shapes.iter().enumerate() {
        let run_end = para
            .char_shapes
            .get(index + 1)
            .map(|next| next.start_pos)
            .unwrap_or(u32::MAX);
        if shape.start_pos >= end_pos || run_end <= seg.text_start {
            continue;
        }
        let Some(style) = styles.char_styles.get(shape.char_shape_id as usize) else {
            continue;
        };
        let Some(border) = usize::from(style.border_fill_id)
            .checked_sub(1)
            .and_then(|id| styles.border_styles.get(id))
        else {
            continue;
        };
        let width = |side: usize| {
            let line = &border.borders[side];
            if line.line_type == BorderLineType::None {
                return 0;
            }
            let mm = BORDER_WIDTHS
                .get(usize::from(line.width))
                .map(|&(mm, _)| mm)
                .unwrap_or(0.1);
            (mm * 7200.0 / 25.4).round() as i32
        };
        let (top, bottom) = (width(2), width(3));
        if top == 0 && bottom == 0 {
            continue;
        }
        let font_height = font_size_to_line_height(style.font_size, dpi);
        seg.line_height = seg.line_height.max(font_height + bottom);
        seg.text_height = seg.text_height.max(font_height + top + bottom);
    }
    if seg.text_height > original_height {
        seg.line_spacing = compute_line_spacing_hwp(ls_type, ls_value, seg.text_height, dpi);
    }
}

fn line_index_for_text_position(line_breaks: &[LineBreakResult], position: usize) -> usize {
    line_breaks
        .partition_point(|line| line.start_idx <= position)
        .saturating_sub(1)
        .min(line_breaks.len().saturating_sub(1))
}

fn apply_inline_control_metrics_to_text_lines(
    para: &Paragraph,
    line_breaks: &[LineBreakResult],
    line_segs: &mut [LineSeg],
    styles: &ResolvedStyleSet,
    dpi: f64,
) {
    if line_breaks.is_empty() || line_segs.is_empty() {
        return;
    }

    let mut positions = para.control_text_positions();
    crate::renderer::ruby::project_control_positions(para, &mut positions);
    for (control_index, control) in para.controls.iter().enumerate() {
        if matches!(control, Control::Form(_)) {
            continue;
        }
        let Some(metrics) = ruby_control_metrics(para, control_index, styles, dpi)
            .or_else(|| inline_control_metrics_hwp(control))
        else {
            continue;
        };
        let position = positions
            .get(control_index)
            .copied()
            .unwrap_or_else(|| para.text.chars().count());
        // Pictures can occupy a line with no text, immediately before a text
        // line with the same start index. That first line owns the object slot.
        let line_index = if matches!(control, Control::Equation(_)) {
            line_index_for_text_position(line_breaks, position)
        } else {
            line_breaks
                .iter()
                .position(|line| line.start_idx == position && line.end_idx == position)
                .unwrap_or_else(|| line_index_for_text_position(line_breaks, position))
        };
        if let Some(line_seg) = line_segs.get_mut(line_index) {
            apply_inline_control_line_metrics(line_seg, metrics);
        }
    }
}

#[cfg(test)]
mod inline_equation_metric_tests {
    use super::*;
    use crate::model::control::Equation;
    use crate::model::shape::CommonObjAttr;

    #[test]
    fn inline_table_reflow_reserves_outer_vertical_margins() {
        use crate::model::table::{Cell, Table};

        for (top, bottom) in [(0, 0), (200, 300)] {
            let table = Table {
                common: CommonObjAttr {
                    treat_as_char: true,
                    width: 6000,
                    height: 4000,
                    ..Default::default()
                },
                row_count: 1,
                col_count: 1,
                outer_margin_top: top,
                outer_margin_bottom: bottom,
                cells: vec![Cell {
                    width: 6000,
                    height: 4000,
                    row_span: 1,
                    col_span: 1,
                    ..Default::default()
                }],
                ..Default::default()
            };
            let mut para = Paragraph {
                controls: vec![Control::Table(Box::new(table))],
                ..Default::default()
            };
            reflow_line_segs(&mut para, 400.0, &ResolvedStyleSet::default(), 96.0);
            assert_eq!(para.line_segs.len(), 1);
            let occupied_height = 4000 + i32::from(top) + i32::from(bottom);
            assert_eq!(para.line_segs[0].line_height, occupied_height);
            assert_eq!(
                para.line_segs[0].baseline_distance,
                (occupied_height as f64 * 0.85).round() as i32
            );
        }
    }

    #[test]
    fn fresh_control_only_table_spacing_uses_each_occupied_anchor_style() {
        use crate::model::table::{Cell, Table};
        use crate::renderer::style_resolver::{ResolvedCharStyle, ResolvedParaStyle};
        let table = Table {
            common: CommonObjAttr {
                treat_as_char: true,
                width: 6000,
                height: 4000,
                ..Default::default()
            },
            row_count: 1,
            col_count: 1,
            cells: vec![Cell {
                width: 6000,
                height: 4000,
                row_span: 1,
                col_span: 1,
                ..Default::default()
            }],
            ..Default::default()
        };
        let styles = ResolvedStyleSet {
            char_styles: [40.0 / 3.0, 56.0 / 3.0, 80.0]
                .into_iter()
                .map(|font_size| ResolvedCharStyle {
                    font_size,
                    ..Default::default()
                })
                .collect(),
            para_styles: vec![ResolvedParaStyle {
                line_spacing_type: LineSpacingType::Percent,
                line_spacing: 160.0,
                ..Default::default()
            }],
            ..Default::default()
        };
        let para = Paragraph {
            char_count: 25,
            controls: vec![
                Control::ColumnDef(Default::default()),
                Control::Bookmark(Default::default()),
                Control::Table(Box::new(table.clone())),
                Control::Table(Box::new(table)),
            ],
            char_shapes: vec![
                CharShapeRef {
                    start_pos: 0,
                    char_shape_id: 2,
                },
                CharShapeRef {
                    start_pos: 8,
                    char_shape_id: 0,
                },
                CharShapeRef {
                    start_pos: 16,
                    char_shape_id: 1,
                },
                CharShapeRef {
                    start_pos: 24,
                    char_shape_id: 2,
                },
            ],
            ..Default::default()
        };
        let mut shared = para.clone();
        reflow_line_segs(&mut shared, 200.0, &styles, 96.0);
        assert_eq!(shared.line_segs.len(), 1);
        assert_eq!(shared.line_segs[0].line_height, 4000);
        assert_eq!(shared.line_segs[0].line_spacing, 840);
        for (size, percent, expected) in [
            (56.0 / 3.0, 175.0, 1052),
            (20.0, 190.0, 1352),
            (20.0, 210.0, 1652),
        ] {
            let mut quarter_styles = styles.clone();
            quarter_styles.char_styles[1].font_size = size;
            quarter_styles.para_styles[0].line_spacing = percent;
            let mut quarter = para.clone();
            reflow_line_segs(&mut quarter, 200.0, &quarter_styles, 96.0);
            assert_eq!(quarter.line_segs[0].line_spacing, expected);
        }
        let mut separate = para.clone();
        reflow_line_segs(&mut separate, 90.0, &styles, 96.0);
        assert_eq!(
            separate
                .line_segs
                .iter()
                .map(|line| line.line_spacing)
                .collect::<Vec<_>>(),
            [600, 840]
        );
        let mut saved = para.clone();
        saved.line_segs.push(LineSeg {
            line_height: 4000,
            line_spacing: 333,
            ..Default::default()
        });
        reflow_line_segs(&mut saved, 200.0, &styles, 96.0);
        assert_eq!(saved.line_segs[0].line_spacing, 333);
        let mut unknown = para.clone();
        unknown.char_count = 0;
        reflow_line_segs(&mut unknown, 200.0, &styles, 96.0);
        // 축이 확정되지 않은 문단은 일반 컨트롤 줄의 최대 글자 모양(80px)을 쓴다.
        assert_eq!(unknown.line_segs[0].line_spacing, 3600);
        let mut extended_bookmark = para.clone();
        extended_bookmark.char_count = 33;
        reflow_line_segs(&mut extended_bookmark, 200.0, &styles, 96.0);
        assert_eq!(extended_bookmark.line_segs[0].line_spacing, 3600);
        let mut fixed_styles = styles.clone();
        fixed_styles.para_styles[0].line_spacing_type = LineSpacingType::Fixed;
        fixed_styles.para_styles[0].line_spacing = 70.0;
        let mut fixed = para.clone();
        reflow_line_segs(&mut fixed, 200.0, &fixed_styles, 96.0);
        let mut fixed_unknown = para;
        fixed_unknown.char_count = 0;
        reflow_line_segs(&mut fixed_unknown, 200.0, &fixed_styles, 96.0);
        assert_eq!(
            fixed.line_segs[0].line_spacing,
            fixed_unknown.line_segs[0].line_spacing
        );
        assert_eq!(
            fixed.line_segs[0].line_height,
            fixed_unknown.line_segs[0].line_height
        );
    }

    #[test]
    fn inline_object_captions_reserve_only_top_and_bottom_extents() {
        use crate::model::shape::{Caption, CaptionDirection, RectangleShape, ShapeObject};
        use crate::model::table::{Cell, Table};
        let mut rectangle = RectangleShape::default();
        rectangle.common.treat_as_char = true;
        rectangle.common.width = 12_000;
        rectangle.common.height = 5_000;
        rectangle.drawing.caption = Some(Caption {
            spacing: 141,
            paragraphs: vec![Paragraph {
                text: "caption".into(),
                line_segs: vec![LineSeg {
                    line_height: 700,
                    text_height: 700,
                    baseline_distance: 595,
                    line_spacing: 352,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        });
        let mut table = Table {
            common: rectangle.common.clone(),
            row_count: 1,
            col_count: 1,
            cells: vec![Cell {
                width: 12_000,
                col_span: 1,
                row_span: 1,
                ..Default::default()
            }],
            outer_margin_top: 100,
            outer_margin_bottom: 200,
            ..Default::default()
        };
        assert_eq!(
            inline_control_metrics_hwp(&Control::Table(Box::new(table.clone())))
                .unwrap()
                .height,
            5_300
        );
        table.caption = rectangle.drawing.caption.clone();
        for direction in [
            CaptionDirection::Top,
            CaptionDirection::Bottom,
            CaptionDirection::Left,
            CaptionDirection::Right,
        ] {
            rectangle.drawing.caption.as_mut().unwrap().direction = direction;
            let metrics = inline_control_metrics_hwp(&Control::Shape(Box::new(
                ShapeObject::Rectangle(rectangle.clone()),
            )))
            .unwrap();
            let expected = if matches!(direction, CaptionDirection::Top | CaptionDirection::Bottom)
            {
                5_841
            } else {
                5_000
            };
            assert_eq!(metrics.height, expected);
            assert_eq!(
                metrics.baseline,
                (f64::from(expected) * 0.85).round() as i32
            );
            assert_eq!(metrics.width, 12_000);
            table.caption.as_mut().unwrap().direction = direction;
            let metrics =
                inline_control_metrics_hwp(&Control::Table(Box::new(table.clone()))).unwrap();
            assert_eq!(metrics.height, expected + 300);
            assert_eq!(
                metrics.baseline,
                (f64::from(expected + 300) * 0.85).round() as i32
            );
            assert_eq!(metrics.width, 12_000);
        }
    }

    #[test]
    fn form_outer_margins_are_reserved_in_stored_and_reflowed_lines() {
        let mut form = crate::model::control::FormObject {
            width: 1700,
            height: 1700,
            ..Default::default()
        };
        form.properties.insert("OutMarginLeft".into(), "566".into());
        form.properties
            .insert("OutMarginRight".into(), "200".into());
        let control = Control::Form(Box::new(form));
        assert_eq!(inline_control_metrics_hwp(&control).unwrap().width, 2466);
        let mut para = Paragraph::default();
        para.controls.push(control);
        let composed = crate::renderer::composer::compose_paragraph(&para);
        assert_eq!(composed.tac_controls[0].1, 2466);
    }

    #[test]
    fn inline_shape_reserves_outer_margins_in_cached_and_reflowed_lines() {
        let mut shape = crate::model::shape::RectangleShape::default();
        shape.common.treat_as_char = true;
        shape.common.width = 1800;
        shape.common.height = 900;
        shape.common.margin.left = 300;
        shape.common.margin.right = 600;
        shape.drawing.shape_attr.current_width = 1800;
        let para = Paragraph {
            controls: vec![Control::Shape(Box::new(
                crate::model::shape::ShapeObject::Rectangle(shape),
            ))],
            ..Default::default()
        };
        assert_eq!(
            inline_control_metrics_hwp(&para.controls[0]).unwrap().width,
            2700
        );
        let composed = crate::renderer::composer::compose_paragraph(&para);
        assert_eq!(composed.tac_controls[0].1, 2700);
    }

    #[test]
    fn equation_reflow_reserves_outer_margins_and_authored_baseline() {
        let mut eq = Equation::default();
        eq.common.treat_as_char = true;
        eq.common.width = 2400;
        eq.common.height = 1800;
        eq.common.margin = crate::model::Padding {
            left: 100,
            right: 200,
            top: 150,
            bottom: 250,
        };
        eq.script = "x".to_string();
        eq.baseline = 70;
        let para = Paragraph {
            controls: vec![Control::Equation(Box::new(eq))],
            ..Default::default()
        };
        let metrics = inline_control_metrics_hwp(&para.controls[0]).unwrap();
        // 줄 advance 는 선언(개체 상자) 폭+여백을 따른다 — 내용이 상자보다 짧아도
        // 상자 자리를 유지한다 (eq-002 실측: `=8` 선언 12.01pt 상자 → 13.13pt 전진).
        assert_eq!(metrics.width, 2700);
        assert_eq!(metrics.height, 2200);
        assert_eq!(metrics.baseline, 1410);
        // 인라인 배치 폭도 같은 규칙(선언 폭+여백)을 따라야 한다.
        let composed = crate::renderer::composer::compose_paragraph(&para);
        assert_eq!(composed.tac_controls[0].1, metrics.width);
    }

    #[test]
    fn equation_reflow_respects_affect_line_spacing_for_ink_below_the_line() {
        struct ClearFontMetrics;
        impl Drop for ClearFontMetrics {
            fn drop(&mut self) {
                crate::renderer::runtime_font_metrics::clear();
            }
        }
        let _clear_font_metrics = ClearFontMetrics;
        crate::renderer::runtime_font_metrics::register(
            include_bytes!("../../../tests/fixtures/fonts/RHWPShapingFixture.ttf"),
            &["HYhwpEQ".to_string()],
            false,
            false,
        )
        .expect("register equation face metrics");
        let mut eq = Equation::default();
        eq.version_info = "Equation Version 60".to_string();
        eq.common.treat_as_char = true;
        eq.common.height = 1_000;
        eq.common.width = 3_000;
        eq.font_size = 1_000;
        eq.script = "x over y".to_string();
        eq.baseline = 80;
        let (_, natural_height, natural_baseline) =
            crate::renderer::equation::intrinsic_metrics_hwp(&eq.script, eq.font_size);
        assert!(natural_height > eq.common.height);

        // 한컴 저장 수식 줄 높이는 선언 높이 그대로다 (흐름 높이는 선언 높이가 없을 때만).
        let declared = inline_control_metrics_hwp(&Control::Equation(Box::new(eq.clone())));
        assert_eq!(declared.unwrap().height, 1_000);
        eq.common.height = 0;

        let mut control = Control::Equation(Box::new(eq));
        let without = inline_control_metrics_hwp(&control).unwrap();
        if let Control::Equation(eq) = &mut control {
            eq.common.affect_line_spacing = true;
        }
        let with = inline_control_metrics_hwp(&control).unwrap();
        let expected_without = crate::renderer::equation::line_flow_height(
            natural_height as f64,
            natural_baseline as f64,
            1_000.0,
            false,
        )
        .round() as i32;
        assert_eq!(without.height, expected_without);
        assert_eq!(with.height, natural_height as i32);
        assert!(with.height > without.height);
        if let Control::Equation(eq) = &mut control {
            eq.version_info.clear();
            eq.common.affect_line_spacing = false;
        }
        assert_eq!(
            inline_control_metrics_hwp(&control).unwrap().height,
            natural_height as i32,
            "legacy HFT keeps the full natural box"
        );
    }

    #[test]
    fn equation_metrics_are_applied_to_the_anchored_wrapped_line() {
        let script = "W = sum_{i=1}^{n} u_i";
        let (width, height, equation_baseline) =
            crate::renderer::equation::intrinsic_metrics_hwp(script, 1000);
        let equation = Equation {
            common: CommonObjAttr {
                treat_as_char: true,
                width,
                height,
                ..Default::default()
            },
            script: script.to_string(),
            font_size: 1000,
            baseline: ((equation_baseline as f64 / height as f64) * 100.0).round() as i16,
            ..Default::default()
        };
        let expected_baseline =
            crate::renderer::equation::control_baseline_hwp(&equation, equation_baseline as f64)
                .round() as i32;
        let mut para = Paragraph {
            text: "abcdefghij".to_string(),
            // One 8-code-unit control gap before character 5.
            char_offsets: (0..10)
                .map(|index| if index < 5 { index } else { index + 8 })
                .collect(),
            controls: vec![Control::Equation(Box::new(equation))],
            ..Default::default()
        };
        para.char_count = 19;

        let line_breaks = vec![
            LineBreakResult {
                start_idx: 0,
                end_idx: 5,
                max_font_size: 10.0,
                has_line_break: false,
            },
            LineBreakResult {
                start_idx: 5,
                end_idx: 10,
                max_font_size: 10.0,
                has_line_break: false,
            },
        ];
        let plain_line = LineSeg {
            line_height: 1000,
            text_height: 1000,
            baseline_distance: 850,
            ..Default::default()
        };
        let mut line_segs = vec![plain_line.clone(), plain_line.clone()];

        apply_inline_control_metrics_to_text_lines(
            &para,
            &line_breaks,
            &mut line_segs,
            &ResolvedStyleSet::default(),
            96.0,
        );

        assert_eq!(line_segs[0].line_height, plain_line.line_height);
        assert_eq!(line_segs[0].baseline_distance, plain_line.baseline_distance);
        assert_eq!(
            line_segs[1].baseline_distance,
            expected_baseline.max(plain_line.baseline_distance)
        );
        assert!(line_segs[1].line_height >= height as i32);
    }
}

#[cfg(test)]
mod inline_equation_15pt_wrap_tests {
    //! 회귀: 에이전트 삽입 인라인 수식의 줄넘침 (footnote-01.hwp e2e 결함 보고).
    //!
    //! 상속된 15pt(20px) 한글 문단에서 reflow 가 한글을 10pt 기본 서식(한글 ≈12.9~13.3px/char)으로
    //! 잘못 측정하면 수식 폭 예약이 줄 끝에서 어긋나 수식 잉크가 컬럼 밖으로 나간다.
    //! ① 토큰화가 각 위치의 유효 char shape(15pt)으로 측정하는지, ② 넓은 수식이
    //! 삽입돼도 모든 줄이 컬럼 안에 들어오는지를 고정한다.
    use super::*;
    use crate::model::control::Equation;
    use crate::model::shape::CommonObjAttr;
    use crate::renderer::style_resolver::{ResolvedCharStyle, ResolvedParaStyle, ResolvedStyleSet};

    /// footnote-01.hwp 구조 재현: id 0 = 기본 10pt(13.33px), id 1 = 본문 15pt(20px).
    fn styles_10pt_default_15pt_body() -> ResolvedStyleSet {
        ResolvedStyleSet {
            hwp3_variant: false,
            char_styles: vec![
                ResolvedCharStyle {
                    font_family: "함초롬바탕".to_string(),
                    font_size: 40.0 / 3.0, // 10pt
                    ratio: 1.0,
                    ..Default::default()
                },
                ResolvedCharStyle {
                    font_family: "한컴바탕".to_string(),
                    font_size: 20.0, // 15pt
                    ratio: 1.0,
                    ..Default::default()
                },
            ],
            para_styles: vec![ResolvedParaStyle::default()],
            ..Default::default()
        }
    }

    /// e2e 채움 문단 (76자) — agent-edit-loop.test.mjs 의 FILLER 와 동일.
    const FILLER: &str = "에이전트 줄바꿈 검증용 채움 문단입니다 이 문장은 첫 줄을 가득 채우고 다음 줄로 넘어가야 하므로 일부러 아주 길게 작성한 문장입니다 끝";

    /// footnote-01.hwp 본문 컬럼 폭 (48190 HWP = 642.53px).
    const COLUMN_PX: f64 = 642.5333333333333;

    fn tac_equation(width_hwp: u32, height_hwp: u32) -> Control {
        Control::Equation(Box::new(Equation {
            common: CommonObjAttr {
                treat_as_char: true,
                width: width_hwp,
                height: height_hwp,
                ..Default::default()
            },
            script: "x = {-b +- sqrt {b^2 - 4ac}} over {2a}".to_string(),
            font_size: 1500,
            ..Default::default()
        }))
    }

    /// 각 줄의 잉크 폭(px): canonical 측정(estimate_text_width)으로 줄 텍스트를 합산하고,
    /// 그 줄에 anchor 된 인라인 개체의 예약 폭을 더한다.
    fn line_ink_widths_px(para: &Paragraph, styles: &ResolvedStyleSet) -> Vec<f64> {
        let text_chars: Vec<char> = para.text.chars().collect();
        let ctrl_positions = para.control_text_positions();
        para.line_segs
            .iter()
            .enumerate()
            .map(|(li, seg)| {
                let end_u16 = para
                    .line_segs
                    .get(li + 1)
                    .map(|s| s.text_start)
                    .unwrap_or(u32::MAX);
                let start_ci = para
                    .char_offsets
                    .iter()
                    .position(|&o| o >= seg.text_start)
                    .unwrap_or(0);
                let end_ci = para
                    .char_offsets
                    .iter()
                    .position(|&o| o >= end_u16)
                    .unwrap_or(text_chars.len());
                let mut w = 0.0f64;
                let mut lang = 0usize;
                for ci in start_ci..end_ci.min(text_chars.len()) {
                    let c = text_chars[ci];
                    if !is_lang_neutral(c) {
                        lang = detect_lang_category(c);
                    }
                    let sid = find_active_char_shape(&para.char_shapes, para.char_offsets[ci]);
                    let ts = resolved_to_text_style(styles, sid, lang);
                    w += estimate_text_width(&c.to_string(), &ts);
                }
                for (k, &pos) in ctrl_positions.iter().enumerate() {
                    if pos >= start_ci && pos < end_ci.max(start_ci + 1) {
                        if let Some(m) = inline_control_metrics_hwp(&para.controls[k]) {
                            w += m.width as f64 / 75.0;
                        }
                    }
                }
                w
            })
            .collect()
    }

    /// 문자 위치(인라인 개체 anchor)를 포함하는 줄의 시작 문자 인덱스.
    fn line_start_char_of(para: &Paragraph, char_pos: usize) -> Option<usize> {
        let mut starts: Vec<usize> = para
            .line_segs
            .iter()
            .map(|seg| {
                para.char_offsets
                    .iter()
                    .position(|&o| o >= seg.text_start)
                    .unwrap_or(usize::MAX)
            })
            .collect();
        starts.push(usize::MAX);
        starts.windows(2).find_map(|w| {
            if char_pos >= w[0] && char_pos < w[1] {
                Some(w[0])
            } else {
                None
            }
        })
    }

    /// 15pt char shape 를 참조하는 한글 토큰은 글자당 20px 로 측정되어야 한다.
    /// 기본 10pt 서식으로 잘못 해석되면 13.33px/char 가 된다 (보고된 오측정치).
    #[test]
    fn tokenize_measures_hangul_with_effective_15pt_shape_not_default_10pt() {
        let styles = styles_10pt_default_15pt_body();
        let text: Vec<char> = "에이전트 줄바꿈 검증".chars().collect();
        let offsets: Vec<u32> = (0..text.len() as u32).collect();

        for (shape_id, expect_w) in [(1u32, 80.0f64), (0u32, 51.733333)] {
            let shapes = vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: shape_id,
            }];
            let tokens = tokenize_paragraph(&text, &offsets, &shapes, &styles, 0, 0);
            let width = tokens
                .iter()
                .find_map(|t| match t {
                    BreakToken::Text {
                        start_idx,
                        end_idx,
                        width,
                        ..
                    } if *start_idx == 0 && *end_idx == 4 => Some(*width),
                    _ => None,
                })
                .expect("어절 토큰 '에이전트' 가 있어야 한다");
            assert!(
                (width - expect_w).abs() < 0.5,
                "char_shape_id={} → '에이전트' 폭 {:.2}px (기대 {:.2}px)",
                shape_id,
                width,
                expect_w
            );
        }
    }

    /// 15pt 한글 문단 첫 줄 끝에 컬럼 남은 폭보다 넓은 인라인 수식을 삽입하면
    /// 수식이 다음 줄로 밀리고, 모든 줄의 잉크 폭이 컬럼 안에 들어와야 한다.
    #[test]
    fn reflow_wraps_wide_equation_inside_column_15pt_hangul() {
        let styles = styles_10pt_default_15pt_body();
        let n_chars = FILLER.chars().count();
        let eq_pos = 34usize; // 첫 줄 끝(lineEnd=36) 근처 — e2e 삽입점과 동일
        let char_offsets: Vec<u32> = (0..n_chars)
            .map(|i| if i < eq_pos { i } else { i + 8 })
            .map(|v| v as u32)
            .collect();
        let mut para = Paragraph {
            text: FILLER.to_string(),
            char_offsets,
            char_shapes: vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: 1,
            }],
            controls: vec![tac_equation(13380, 5000)],
            line_segs: vec![LineSeg::default()],
            ..Default::default()
        };
        para.char_count = (n_chars + 8 + 1) as u32;

        reflow_line_segs(&mut para, COLUMN_PX, &styles, 96.0);

        // 수식(178.4px)이 첫 줄 남은 폭(~52px)보다 넓어 자기 줄로 밀려난다:
        // anchor(문자 34)가 줄 시작(흡수된 공백 1자 이내)에 놓인다.
        assert_eq!(
            para.line_segs.len(),
            3,
            "수식 예약으로 3줄이 되어야 한다 (line_segs={:?})",
            para.line_segs
                .iter()
                .map(|ls| ls.text_start)
                .collect::<Vec<_>>()
        );
        let anchor_line_start =
            line_start_char_of(&para, eq_pos).expect("수식 anchor 를 포함하는 줄이 있어야 한다");
        assert!(
            anchor_line_start >= eq_pos - 2 && anchor_line_start <= eq_pos,
            "수식 anchor 가 줄 시작 근처에 와야 한다: line_start={} anchor={} (line_segs={:?})",
            anchor_line_start,
            eq_pos,
            para.line_segs
                .iter()
                .map(|ls| ls.text_start)
                .collect::<Vec<_>>()
        );
        // 모든 줄의 잉크 폭이 컬럼 안.
        for (li, w) in line_ink_widths_px(&para, &styles).iter().enumerate() {
            assert!(
                *w <= COLUMN_PX + 0.2,
                "line {} 잉크 폭 {:.1}px 가 컬럼 {:.1}px 를 넘는다",
                li,
                w,
                COLUMN_PX
            );
        }
    }

    /// 실물 문서 회귀: footnote-01.hwp 로드 → 에이전트 편집 시퀀스(채움 문단 삽입
    /// → 서식 편집 → 쪽 나눔 → 수식 삽입)를 그대로 재현해, 수식이 든 문단의
    /// 모든 줄이 컬럼 안에 들어오는지 검증한다.
    #[test]
    fn footnote01_agent_equation_insert_stays_inside_column() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("samples/footnote-01.hwp");
        if !path.exists() {
            eprintln!("테스트 파일 없음: {} — 건너뜀", path.display());
            return;
        }
        let bytes = std::fs::read(&path).unwrap();
        let mut core = crate::document_core::DocumentCore::from_bytes(&bytes).unwrap();

        // e2e performInsert 재현: 마지막 문단 끝에서 줄 단위 insertText + splitParagraph.
        let seed_base = core.document().sections[0].paragraphs.len();
        let seed_len = core.document().sections[0].paragraphs[seed_base - 1]
            .text
            .chars()
            .count();
        core.insert_text_native(0, seed_base - 1, seed_len, " ")
            .unwrap();
        let lines = [
            "",
            FILLER,
            "첫째 에이전트 목록 항목입니다",
            "둘째 항목의 원본 텍스트 구간입니다",
            "셋째 에이전트 목록 항목입니다",
        ];
        let mut cur_para = seed_base - 1;
        let mut cur_off = seed_len + 1;
        for (li, line) in lines.iter().enumerate() {
            if li > 0 {
                core.split_paragraph_native(0, cur_para, cur_off, None)
                    .unwrap();
                cur_para += 1;
                cur_off = 0;
            }
            if !line.is_empty() {
                core.insert_text_native(0, cur_para, cur_off, line).unwrap();
                cur_off += line.chars().count();
            }
        }
        let filler_p = seed_base;
        let l2_p = seed_base + 2;

        // e2e 중간 편집: L2 볼드(새 char shape 추가) + 채움 문단 pageBreakBefore.
        core.apply_char_format_native(0, l2_p, 6, 14, "{\"bold\":true}")
            .unwrap();
        core.apply_para_format_native(0, filler_p, "{\"pageBreakBefore\":true}")
            .unwrap();

        // 상속 서식이 15pt(20px)인지 먼저 고정한다.
        let filler = &core.document().sections[0].paragraphs[filler_p];
        let shape_id = filler
            .char_shapes
            .first()
            .map(|cs| cs.char_shape_id)
            .unwrap();
        let font_size = core.styles.char_styles[shape_id as usize].font_size;
        assert_eq!(font_size, 20.0, "채움 문단 상속 서식은 15pt(20px)여야 한다");

        // 첫 줄 끝 근처(lineEnd - 2)에 15pt 수식 삽입.
        let first_line_end_u16 = filler
            .line_segs
            .get(1)
            .map(|ls| ls.text_start)
            .unwrap_or(u32::MAX);
        let line_end = filler
            .char_offsets
            .iter()
            .position(|&o| o >= first_line_end_u16)
            .unwrap_or(filler.char_offsets.len())
            .saturating_sub(1);
        core.insert_equation_native(
            0,
            filler_p,
            line_end - 2,
            "x = {-b +- sqrt {b^2 - 4ac}} over {2a}",
            1500,
            0,
        )
        .unwrap();

        // 컬럼 폭: insert_equation_native 의 reflow 와 동일 산식.
        let (column_px, eq_pos) = {
            let core_styles = &core.styles;
            let section = &core.document().sections[0];
            let page_def = &section.section_def.page_def;
            let text_width =
                page_def.width as i32 - page_def.margin_left as i32 - page_def.margin_right as i32;
            let para = &section.paragraphs[filler_p];
            let para_style = core_styles.para_styles.get(para.para_shape_id as usize);
            let ml = para_style.map(|s| s.margin_left).unwrap_or(0.0);
            let mr = para_style.map(|s| s.margin_right).unwrap_or(0.0);
            let col = (crate::renderer::hwpunit_to_px(text_width, 96.0) - ml - mr).max(0.0);
            let pos = para.control_text_positions()[0];
            (col, pos)
        };

        let para = &core.document().sections[0].paragraphs[filler_p];
        let anchor_line_start =
            line_start_char_of(para, eq_pos).expect("수식 anchor 를 포함하는 줄이 있어야 한다");
        assert!(
            anchor_line_start >= eq_pos - 2 && anchor_line_start <= eq_pos,
            "수식이 자기 줄 시작으로 밀려야 한다: line_start={} anchor={} (line_segs={:?})",
            anchor_line_start,
            eq_pos,
            para.line_segs
                .iter()
                .map(|ls| ls.text_start)
                .collect::<Vec<_>>()
        );
        for (li, w) in line_ink_widths_px(para, &core.styles).iter().enumerate() {
            assert!(
                *w <= column_px + 0.5,
                "line {} 잉크 폭 {:.1}px 가 컬럼 {:.1}px 를 넘는다",
                li,
                w,
                column_px
            );
        }
    }

    /// 브라우저 e2e(agent-edit-loop f절)와 동일 경로의 실물 회귀.
    ///
    /// getCursorRect 로 찾은 첫 줄 끝 두 글자 앞에 15pt 수식을 삽입한다 — 이
    /// 삽입점에서는 수식 anchor 가 공백과 같은 문자 위치에 놓인다. 공백 흡수형
    /// 줄나눔이 개체를 이전 줄 끝에 좌초시켜(폭 예약 줄 ≠ painter 방출 줄)
    /// 수식 잉크가 컬럼 밖으로 나가던 결함(eqRight=824 > rightEdge=718.1)을
    /// 고정한다. anchor 가 줄 경계에 걸리는 이 시나리오만 잡는다 — 단순
    /// line_segs 기반 삽입점(어절 경계)으로는 재현되지 않았다.
    #[test]
    fn footnote01_cursor_probe_equation_insert_matches_browser_layout() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("samples/footnote-01.hwp");
        if !path.exists() {
            eprintln!("테스트 파일 없음: {} — 건너뜀", path.display());
            return;
        }
        let bytes = std::fs::read(&path).unwrap();
        let mut doc = crate::wasm_api::HwpDocument::from_bytes(&bytes).unwrap();
        doc.convert_to_editable().unwrap();

        // TS performInsert 동형 시드 삽입 (마지막 문단 뒤에 4개 문단)
        let seed_base = doc.document().sections[0].paragraphs.len();
        let seed_len = doc.document().sections[0].paragraphs[seed_base - 1]
            .text
            .chars()
            .count();
        doc.insert_text_native(0, seed_base - 1, seed_len, " ")
            .unwrap();
        let lines = [
            "",
            FILLER,
            "첫째 에이전트 목록 항목입니다",
            "둘째 항목의 원본 텍스트 구간입니다",
            "셋째 에이전트 목록 항목입니다",
        ];
        let mut cur_para = seed_base - 1;
        let mut cur_off = seed_len + 1;
        for (li, line) in lines.iter().enumerate() {
            if li > 0 {
                doc.split_paragraph_native(0, cur_para, cur_off, None)
                    .unwrap();
                cur_para += 1;
                cur_off = 0;
            }
            if !line.is_empty() {
                doc.insert_text_native(0, cur_para, cur_off, line).unwrap();
                cur_off += line.chars().count();
            }
        }
        let filler_p = seed_base;
        doc.apply_para_format_native(0, filler_p, "{\"pageBreakBefore\":true}")
            .unwrap();

        // e2e probe: getCursorRect y 가 처음 바뀌는 지점 = 첫 줄 끝
        let len = doc.document().sections[0].paragraphs[filler_p]
            .text
            .chars()
            .count();
        let r0 = doc.get_cursor_rect(0, filler_p as u32, 0).unwrap();
        let r0y = json_f64(&r0, "y");
        let page = json_f64(&r0, "pageIndex");
        let mut line_end = len;
        for o in 1..=len {
            let r = doc.get_cursor_rect(0, filler_p as u32, o as u32).unwrap();
            if json_f64(&r, "pageIndex") != page || json_f64(&r, "y") > r0y + 1.0 {
                line_end = o - 1;
                break;
            }
        }
        let eq_offset = line_end - 2;
        doc.insert_equation_native(
            0,
            filler_p,
            eq_offset,
            "x = {-b +- sqrt {b^2 - 4ac}} over {2a}",
            1500,
            0,
        )
        .unwrap();

        let page_def = &doc.document().sections[0].section_def.page_def;
        let margin_left = crate::renderer::hwpunit_to_px(page_def.margin_left as i32, 96.0);
        let right_edge = crate::renderer::hwpunit_to_px(
            page_def.width as i32 - page_def.margin_right as i32,
            96.0,
        );

        // 수식 bbox (painter 가 실제 그린 위치)
        let layout = doc.get_page_control_layout(page as u32).unwrap();
        let (eq_x, eq_w) = find_equation_bbox(&layout, filler_p).expect("수식 bbox 가 있어야 한다");
        assert!(
            eq_x <= margin_left + 40.0,
            "남은 폭보다 넓은 수식이 다음 줄로 밀려야 함: eq.x={:.1} marginLeft={:.1}",
            eq_x,
            margin_left
        );
        assert!(
            eq_x + eq_w <= right_edge + 4.0,
            "수식 bbox 가 열 안이어야 함: eqRight={:.1} rightEdge={:.1}",
            eq_x + eq_w,
            right_edge
        );

        // 어떤 커서 위치도 열 오른쪽을 넘지 않아야 한다 (e2e caretOk)
        let mut max_x = 0.0f64;
        for o in 0..=(len + 10) {
            if let Ok(r) = doc.get_cursor_rect(0, filler_p as u32, o as u32) {
                let x = json_f64(&r, "x");
                if x > max_x {
                    max_x = x;
                }
            }
        }
        assert!(
            max_x <= right_edge + 4.0,
            "수식 문단 어떤 런도 열 오른쪽을 넘지 않아야 함: maxX={:.1} rightEdge={:.1}",
            max_x,
            right_edge
        );
    }

    fn json_f64(json: &str, key: &str) -> f64 {
        let pat = format!("\"{}\":", key);
        let Some(i) = json.find(&pat) else {
            return -1.0;
        };
        let rest = &json[i + pat.len()..];
        let end = rest
            .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
            .unwrap_or(rest.len());
        rest[..end].parse().unwrap_or(-1.0)
    }

    fn find_equation_bbox(layout: &str, para_idx: usize) -> Option<(f64, f64)> {
        let marker = format!("\"paraIdx\":{}", para_idx);
        let mut rest = layout;
        while let Some(i) = rest.find("\"type\":\"equation\"") {
            let start = rest[..i].rfind('{')?;
            let end = rest[i..].find('}').map(|e| i + e)?;
            let obj = &rest[start..end];
            if obj.contains(&marker) {
                return Some((json_f64(obj, "x"), json_f64(obj, "w")));
            }
            rest = &rest[end..];
        }
        None
    }
}

#[cfg(test)]
mod inline_control_wrap_tests {
    use super::*;

    #[test]
    fn inline_objects_condense_only_regular_spaces_after_content() {
        for (condense, fixed_space, width, line_count) in [
            (0, false, 85.0, 2),
            (30, false, 85.0, 1),
            (30, true, 85.0, 2),
            (30, false, 84.0, 2),
        ] {
            for text_prefix in [false, true] {
                let prefix_len = usize::from(text_prefix);
                let prefix = if text_prefix {
                    BreakToken::Text {
                        start_idx: 0,
                        end_idx: 1,
                        width: 40.0,
                        max_font_size: 24.0,
                        char_widths: Vec::new(),
                        trailing_spacing: 0.0,
                        char_spacings: Vec::new(),
                    }
                } else {
                    BreakToken::InlineControl {
                        idx: 0,
                        width_hwp: 3000,
                        max_font_size: 24.0,
                        own_line: false,
                    }
                };
                let tokens = [
                    prefix,
                    BreakToken::Space {
                        idx: prefix_len,
                        width: 6.0,
                        max_font_size: 24.0,
                        is_fixed_width: fixed_space,
                    },
                    BreakToken::InlineControl {
                        idx: prefix_len + 1,
                        width_hwp: 3000,
                        max_font_size: 24.0,
                        own_line: false,
                    },
                ];
                let mut chars = vec!['가'; prefix_len];
                chars.push(if fixed_space { '\u{2007}' } else { ' ' });
                let lines = fill_lines(
                    &tokens,
                    &chars,
                    width,
                    0.0,
                    (0.0, 0.0),
                    None,
                    0,
                    0,
                    condense,
                    None,
                );
                assert_eq!(
                    lines.len(),
                    line_count,
                    "condense={condense}, fixed={fixed_space}, width={width}, text={text_prefix}"
                );
            }
        }
        for count in [1, 5] {
            let mut tokens: Vec<_> = (0..count)
                .map(|idx| BreakToken::Space {
                    idx,
                    width: 6.0,
                    max_font_size: 24.0,
                    is_fixed_width: false,
                })
                .collect();
            tokens.push(BreakToken::InlineControl {
                idx: count,
                width_hwp: 6000,
                max_font_size: 24.0,
                own_line: false,
            });
            let chars = vec![' '; count];
            let lines = fill_lines(
                &tokens,
                &chars,
                80.0 + count as f64 * 6.0 - 1.0,
                0.0,
                (0.0, 0.0),
                None,
                0,
                0,
                30,
                None,
            );
            assert_eq!(lines.len(), 2, "leading spaces={count}");
            assert_eq!(lines[1].start_idx, count);
        }
    }

    #[test]
    fn condensed_inline_object_keeps_its_attached_suffix() {
        let tokens = vec![
            BreakToken::Text {
                start_idx: 0,
                end_idx: 1,
                width: 40.0,
                max_font_size: 12.0,
                char_widths: vec![],
                trailing_spacing: 0.0,
                char_spacings: vec![],
            },
            BreakToken::Space {
                idx: 1,
                width: 6.0,
                max_font_size: 12.0,
                is_fixed_width: false,
            },
            BreakToken::InlineControl {
                idx: 2,
                width_hwp: 3000,
                max_font_size: 12.0,
                own_line: false,
            },
            BreakToken::Text {
                start_idx: 2,
                end_idx: 3,
                width: 12.0,
                max_font_size: 12.0,
                char_widths: vec![],
                trailing_spacing: 0.0,
                char_spacings: vec![],
            },
        ];
        let lines = fill_lines(
            &tokens,
            &['가', ' ', '개'],
            97.0,
            0.0,
            (0.0, 0.0),
            None,
            0,
            0,
            20,
            None,
        );
        assert_eq!(lines.len(), 1);
        assert_eq!((lines[0].start_idx, lines[0].end_idx), (0, 3));
    }

    #[test]
    fn condensed_line_with_equation_keeps_fitting_final_word() {
        let mut tokens = vec![BreakToken::Text {
            start_idx: 0,
            end_idx: 20,
            width: 260.0,
            max_font_size: 12.0,
            char_widths: vec![],
            trailing_spacing: 0.0,
            char_spacings: vec![],
        }];
        for idx in 20..26 {
            tokens.push(BreakToken::Space {
                idx,
                width: 6.0,
                max_font_size: 12.0,
                is_fixed_width: false,
            });
        }
        tokens.push(BreakToken::InlineControl {
            idx: 26,
            width_hwp: 3000,
            max_font_size: 12.0,
            own_line: false,
        });
        tokens.push(BreakToken::Text {
            start_idx: 26,
            end_idx: 28,
            width: 24.0,
            max_font_size: 12.0,
            char_widths: vec![],
            trailing_spacing: 0.0,
            char_spacings: vec![],
        });
        let mut chars = vec!['가'; 20];
        chars.extend([' '; 6]);
        chars.extend(['있', '다']);
        let lines = fill_lines(
            &tokens,
            &chars,
            357.0,
            0.0,
            (0.0, 0.0),
            None,
            0,
            0,
            20,
            None,
        );
        assert_eq!(lines.len(), 1);
        assert_eq!((lines[0].start_idx, lines[0].end_idx), (0, 28));
    }

    #[test]
    fn condensed_inline_line_can_end_with_a_short_detached_word() {
        let tokens = vec![
            BreakToken::Text {
                start_idx: 0,
                end_idx: 2,
                width: 70.0,
                max_font_size: 12.0,
                char_widths: vec![],
                trailing_spacing: 0.0,
                char_spacings: vec![],
            },
            BreakToken::InlineControl {
                idx: 2,
                width_hwp: 1200,
                max_font_size: 12.0,
                own_line: false,
            },
            BreakToken::Space {
                idx: 2,
                width: 6.0,
                max_font_size: 12.0,
                is_fixed_width: false,
            },
            BreakToken::Text {
                start_idx: 3,
                end_idx: 4,
                width: 12.0,
                max_font_size: 12.0,
                char_widths: vec![],
                trailing_spacing: 0.0,
                char_spacings: vec![],
            },
        ];
        let chars = ['가', '나', ' ', '다'];
        let condensed = fill_lines(
            &tokens,
            &chars,
            103.5,
            0.0,
            (0.0, 0.0),
            None,
            0,
            0,
            10,
            None,
        );
        assert_eq!(condensed.len(), 1);
        let natural = fill_lines(&tokens, &chars, 103.5, 0.0, (0.0, 0.0), None, 0, 0, 0, None);
        assert_eq!(natural.len(), 2);
    }

    use crate::model::control::Equation;
    use crate::model::shape::CommonObjAttr;
    use crate::renderer::style_resolver::{ResolvedCharStyle, ResolvedParaStyle, ResolvedStyleSet};

    fn styles_16px() -> ResolvedStyleSet {
        ResolvedStyleSet {
            hwp3_variant: false,
            char_styles: vec![ResolvedCharStyle {
                font_size: 16.0,
                ratio: 1.0,
                ..Default::default()
            }],
            para_styles: vec![ResolvedParaStyle::default()],
            ..Default::default()
        }
    }

    fn tac_equation(width_hwp: u32, height_hwp: u32) -> Control {
        tac_equation_script(width_hwp, height_hwp, "x")
    }

    /// 줄 advance 는 paint 폭을 따르므로, 넓은 수식 시나리오는 실제로 넓게
    /// 그려지는 스크립트가 필요하다 (font_size=1000 에서 'x' ≈ 443 HWP/자).
    fn tac_equation_script(width_hwp: u32, height_hwp: u32, script: &str) -> Control {
        Control::Equation(Box::new(Equation {
            common: CommonObjAttr {
                treat_as_char: true,
                width: width_hwp,
                height: height_hwp,
                ..Default::default()
            },
            script: script.to_string(),
            font_size: 1000,
            ..Default::default()
        }))
    }

    #[test]
    fn control_only_lines_use_max_height_and_baseline_independently() {
        let equation = |height, baseline| {
            let mut control = tac_equation(2400, height);
            if let Control::Equation(eq) = &mut control {
                eq.baseline = baseline;
            }
            control
        };
        for reverse in [false, true] {
            for with_text in [false, true] {
                let mut controls = vec![equation(3510, 43), equation(2250, 69)];
                if reverse {
                    controls.reverse();
                }
                let mut para = Paragraph {
                    text: if with_text {
                        "가".into()
                    } else {
                        String::new()
                    },
                    char_offsets: if with_text { vec![16] } else { vec![] },
                    char_count: if with_text { 18 } else { 17 },
                    char_shapes: vec![CharShapeRef {
                        start_pos: 0,
                        char_shape_id: 0,
                    }],
                    controls,
                    ..Default::default()
                };
                reflow_line_segs(&mut para, 200.0, &styles_16px(), 96.0);
                assert_eq!(para.line_segs.len(), 1);
                let line = &para.line_segs[0];
                // 짧은 수식의 기준선이 더 높아도 두 수식의 ascent/descent를
                // 합쳐 줄 높이를 3554로 늘리지 않는다.
                assert_eq!(
                    line.line_height, 3510,
                    "text={with_text}, reverse={reverse}"
                );
                assert_eq!(line.text_height, 3510);
                assert_eq!(line.baseline_distance, 1553);
            }
        }
    }

    #[test]
    fn generated_note_marker_reserves_only_the_first_line() {
        use crate::model::footnote::{Endnote, Footnote};

        for footnote in [false, true] {
            let marker = if footnote {
                Control::Footnote(Box::new(Footnote {
                    number: 28,
                    ..Default::default()
                }))
            } else {
                Control::Endnote(Box::new(Endnote {
                    number: 28,
                    ..Default::default()
                }))
            };
            let para = Paragraph {
                text: "가나 다라 마바".into(),
                char_offsets: (0..8).map(|i| i + 8 + if i >= 3 { 8 } else { 0 }).collect(),
                char_shapes: vec![CharShapeRef {
                    start_pos: 0,
                    char_shape_id: 0,
                }],
                controls: vec![marker, tac_equation(1500, 3000)],
                char_count: 25,
                ..Default::default()
            };
            let mut generated = para.clone();
            reflow_line_segs_with_exclusions(&mut generated, 100.0, &styles_16px(), 96.0, &[]);
            assert_eq!(generated.line_segs.len(), 2);
            assert_eq!(generated.line_segs[0].line_height, 1200);
            assert_eq!(generated.line_segs[1].line_height, 3000);

            // 저장 줄의 별도 재조판은 호출자가 번호 폭을 전달한다.
            let mut ordinary = para;
            reflow_line_segs(&mut ordinary, 100.0, &styles_16px(), 96.0);
            assert_eq!(ordinary.line_segs.len(), 2);
            assert_eq!(ordinary.line_segs[0].line_height, 3000);
            assert_eq!(ordinary.line_segs[1].line_height, 1200);
        }
    }

    #[test]
    fn wrapped_picture_reserves_height_only_on_its_own_line() {
        let mut para = Paragraph {
            text: "aaaa bbbb cccc dddd".to_string(),
            char_offsets: (0..19u32).map(|i| if i < 10 { i } else { i + 8 }).collect(),
            char_shapes: vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: 0,
            }],
            controls: vec![Control::Picture(Box::new(crate::model::image::Picture {
                common: CommonObjAttr {
                    treat_as_char: true,
                    width: 7000,
                    height: 5000,
                    ..Default::default()
                },
                ..Default::default()
            }))],
            line_segs: vec![LineSeg::default()],
            char_count: 28,
            ..Default::default()
        };
        reflow_line_segs(&mut para, 100.0, &styles_16px(), 96.0);
        assert!(para.line_segs.len() >= 3);
        assert_eq!(
            para.line_segs[0].line_height, 1200,
            "text above the picture must retain text height"
        );
        assert!(
            para.line_segs[1].line_height >= 5000,
            "picture line must reserve its full height"
        );
        assert!(
            para.line_segs[2..]
                .iter()
                .all(|line| line.line_height == 1200),
            "text after the picture must retain text height"
        );
    }

    #[test]
    fn edited_picture_line_reserves_outer_margins_with_ink_baseline() {
        use crate::model::Padding;

        let picture = Control::Picture(Box::new(crate::model::image::Picture {
            common: CommonObjAttr {
                treat_as_char: true,
                width: 3600,
                height: 3000,
                margin: Padding {
                    left: 300,
                    right: 450,
                    top: 500,
                    bottom: 700,
                },
                ..Default::default()
            },
            ..Default::default()
        }));
        let metrics = inline_control_metrics_hwp(&picture).unwrap();
        assert_eq!(metrics.width, 4350);
        assert_eq!(metrics.height, 4200);
        // 기준선 = 바깥 여백 포함 상자 높이의 0.85 (한컴 저장 그림 줄 840건).
        assert_eq!(metrics.baseline, 3570);

        let mut para = Paragraph {
            controls: vec![picture],
            line_segs: vec![LineSeg {
                segment_width: 7000,
                ..Default::default()
            }],
            ..Default::default()
        };
        reflow_line_segs(&mut para, 100.0, &styles_16px(), 96.0);
        assert_eq!(para.line_segs.len(), 1);
        assert!(para.line_segs[0].line_height >= 4200);
        assert_eq!(para.line_segs[0].baseline_distance, 3570);
        assert_eq!(para.line_segs[0].segment_width, 7000);
    }

    /// 줄이 거의 찬 텍스트에 넓은 인라인 수식이 삽입되면 수식 폭을 예약해
    /// 뒤따르는 텍스트가 다음 줄로 밀려나야 한다 (컬럼 밖 overflow 방지).
    #[test]
    fn reflow_reserves_inline_equation_width_and_wraps_trailing_text() {
        let styles = styles_16px();
        // 라틴 19자, 문자 위치 10 앞에 8 code-unit 컨트롤 갭 (수식 anchor)
        let mut para = Paragraph {
            text: "aaaa bbbb cccc dddd".to_string(),
            char_offsets: (0..19u32).map(|i| if i < 10 { i } else { i + 8 }).collect(),
            char_shapes: vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: 0,
            }],
            controls: vec![tac_equation_script(4000, 5000, &"x".repeat(9))],
            line_segs: vec![LineSeg::default()],
            ..Default::default()
        };
        para.char_count = 28;

        // 컬럼 100px(7500 HWP): 단어 32px(2400 HWP), 수식 paint ≈4000 HWP.
        // 폭 예약이 없으면 2줄 [0,9),[10,19) — 2번째 줄이 수식+텍스트 8800+ HWP로
        // 컬럼을 넘는다. 예약이 있으면 3줄로 나뉘고 각 줄이 컬럼 안에 들어간다.
        reflow_line_segs(&mut para, 100.0, &styles, 96.0);

        assert_eq!(para.line_segs.len(), 3);
        assert_eq!(para.line_segs[0].text_start, 0);
        // 2번째 줄은 수식 anchor(문자 10 → UTF-16 18)에서 시작
        assert_eq!(para.line_segs[1].text_start, 18);
        // 3번째 줄은 "dddd"(문자 15 → UTF-16 23)
        assert_eq!(para.line_segs[2].text_start, 23);
        // 수식이 놓인 2번째 줄만 수식 높이(5000 HWP)로 커진다
        assert!(para.line_segs[1].line_height >= 5000);
        assert_eq!(para.line_segs[0].line_height, 1200);
        assert_eq!(para.line_segs[2].line_height, 1200);
    }

    /// 인라인 수식이 줄에 들어가면 불필요한 줄 나눔이 생기지 않는다.
    #[test]
    fn reflow_keeps_fitting_inline_equation_on_single_line() {
        let styles = styles_16px();
        // "aaaa bbbb", 문자 위치 5 앞에 컨트롤 갭
        let mut para = Paragraph {
            text: "aaaa bbbb".to_string(),
            char_offsets: (0..9u32).map(|i| if i < 5 { i } else { i + 8 }).collect(),
            char_shapes: vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: 0,
            }],
            controls: vec![tac_equation(1000, 1200)],
            line_segs: vec![LineSeg::default()],
            ..Default::default()
        };
        para.char_count = 18;

        // 2400 + 공백 + 1000 + 2400 = 5800+ HWP < 7500 HWP → 1줄 유지
        reflow_line_segs(&mut para, 100.0, &styles, 96.0);
        assert_eq!(para.line_segs.len(), 1);
    }

    /// 단어 중간(straddle)에 삽입된 수식도 토큰을 분할해 폭을 예약한다.
    /// break point(공백)가 없는 줄에서는 수식 바로 뒤 글자에서 잘리지 않고
    /// (painter anchor 모호성) 그 다음 글자에서 줄이 나뉜다.
    #[test]
    fn reflow_splits_word_token_at_inline_equation() {
        let styles = styles_16px();
        // 라틴 10자 단어, 문자 위치 5 앞에 컨트롤 갭
        let mut para = Paragraph {
            text: "aaaaaaaaaa".to_string(),
            char_offsets: (0..10u32).map(|i| if i < 5 { i } else { i + 8 }).collect(),
            char_shapes: vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: 0,
            }],
            controls: vec![tac_equation_script(4000, 5000, &"x".repeat(9))],
            line_segs: vec![LineSeg::default()],
            ..Default::default()
        };
        para.char_count = 19;

        // 3000(5글자) + 수식 paint ≈4000 = 7000 ≤ 7500이라 수식은 1번째 줄에 배치.
        // 뒤 5글자(3000)는 넘치므로 글자 단위 분할 — 단 첫 글자는 수식과 같은 줄에
        // 고정되어 [0,6),[6,10) 으로 나뉜다 ([0,5),[5,10) 가 아님).
        reflow_line_segs(&mut para, 100.0, &styles, 96.0);

        assert_eq!(para.line_segs.len(), 2);
        // 2번째 줄은 문자 6 (UTF-16 6+8=14)에서 시작
        assert_eq!(para.line_segs[1].text_start, 14);
        // 수식 anchor(위치 5)는 1번째 줄 [0,6) 안 → 1번째 줄만 높이 보정
        assert!(para.line_segs[0].line_height >= 5000);
        assert_eq!(para.line_segs[1].line_height, 1200);
    }

    /// 한컴: 글자처럼 취급한 표의 줄 높이는 바깥 여백 위/아래를 포함하고, 표가 줄 폭을
    /// 넘기면 뒤따르는 폭 0 컨트롤(책갈피 등)은 그 글자 모양 높이의 다음 줄로 간다.
    /// 넘치지 않으면 같은 줄에 남는다.
    #[test]
    fn overflowing_tac_table_pushes_trailing_controls_to_own_line() {
        use crate::model::control::Bookmark;
        use crate::model::table::{Cell, Table};

        let mut styles = styles_16px();
        styles.char_styles.push(ResolvedCharStyle {
            font_size: crate::renderer::hwpunit_to_px(1_000, 96.0),
            ratio: 1.0,
            ..Default::default()
        });
        let para_with_table = |cell_width: u32| {
            let mut table = Table {
                col_count: 1,
                row_count: 1,
                outer_margin_left: 283,
                outer_margin_right: 283,
                outer_margin_top: 283,
                outer_margin_bottom: 283,
                ..Default::default()
            };
            table.common.treat_as_char = true;
            table.common.height = 3_000;
            table.cells.push(Cell {
                col_span: 1,
                width: cell_width,
                ..Default::default()
            });
            Paragraph {
                char_shapes: vec![
                    CharShapeRef {
                        start_pos: 0,
                        char_shape_id: 0,
                    },
                    CharShapeRef {
                        start_pos: 8,
                        char_shape_id: 1,
                    },
                ],
                controls: vec![
                    Control::Table(Box::new(table)),
                    Control::Bookmark(Bookmark {
                        name: "a".to_string(),
                    }),
                ],
                ..Default::default()
            }
        };

        // 7400 + 좌우 여백 566 > 7500 HWP(100px): 책갈피 줄이 따로 생긴다.
        let mut para = para_with_table(7_400);
        reflow_line_segs(&mut para, 100.0, &styles, 96.0);
        assert_eq!(para.line_segs.len(), 2);
        assert_eq!(para.line_segs[0].line_height, 3_566);
        assert_eq!(para.line_segs[1].text_start, 8);
        assert_eq!(para.line_segs[1].line_height, 1_000);

        // 6000 + 566 ≤ 7500: 책갈피는 표 줄에 남는다.
        let mut para = para_with_table(6_000);
        reflow_line_segs(&mut para, 100.0, &styles, 96.0);
        assert_eq!(para.line_segs.len(), 1);
        assert_eq!(para.line_segs[0].line_height, 3_566);
    }
}

pub(crate) fn reflow_line_segs(
    para: &mut Paragraph,
    available_width_px: f64,
    styles: &ResolvedStyleSet,
    dpi: f64,
) {
    reflow_line_segs_with_squeeze(para, available_width_px, styles, dpi, false);
}

/// 각주 번호의 모델 공백은 실제 번호 문자열의 자리다. 렌더와 같은 자간 없는
/// 번호 폭을 넣어 첫 줄이 번호 대신 공백 하나만 예약하지 않도록 한다.
/// 미주는 조판 사본에 번호 텍스트를 붙이는 별도 경로를 사용한다.
fn measure_footnote_number_tokens(
    tokens: &mut [BreakToken],
    para: &Paragraph,
    styles: &ResolvedStyleSet,
) {
    use crate::model::control::AutoNumberType;
    use crate::model::footnote::FootnoteShape;

    if !para.controls.iter().any(|control| {
        matches!(control, Control::AutoNumber(number) if number.number_type == AutoNumberType::Footnote)
    }) {
        return;
    }
    let positions =
        crate::renderer::layout::LayoutEngine::auto_number_placeholder_positions(para, |kind| {
            kind == AutoNumberType::Footnote
        });
    for (pos, control_index) in positions {
        let Control::AutoNumber(number) = &para.controls[control_index] else {
            continue;
        };
        let Some(token) = tokens.iter_mut().find(|token| match token {
            BreakToken::Space { idx, .. } => *idx == pos,
            BreakToken::Text {
                start_idx, end_idx, ..
            } => *start_idx == pos && *end_idx == pos + 1,
            _ => false,
        }) else {
            continue;
        };
        let text = crate::renderer::layout::format_footnote_number(
            number.assigned_number,
            &FootnoteShape::number_format_from_attr_code(number.format.into()),
            number.prefix_char,
            number.suffix_char,
        );
        let style_id = char_style_id_at(&para.char_offsets, &para.char_shapes, pos);
        let mut style = resolved_to_text_style(styles, style_id, 0);
        style.letter_spacing = 0.0;
        *token = BreakToken::Text {
            start_idx: pos,
            end_idx: pos + 1,
            width: estimate_text_width(text.trim_end(), &style),
            max_font_size: style_font_size(styles, style_id),
            char_widths: Vec::new(),
            trailing_spacing: 0.0,
            char_spacings: Vec::new(),
        };
    }
}

/// 셀의 SQUEEZE 설정도 문단과 같은 줄나눔·높이 계산을 사용한다.
pub(crate) fn reflow_line_segs_with_squeeze(
    para: &mut Paragraph,
    available_width_px: f64,
    styles: &ResolvedStyleSet,
    dpi: f64,
    squeeze: bool,
) {
    reflow_line_segs_with_wrap_exclusions(
        para,
        available_width_px,
        styles,
        dpi,
        squeeze,
        &[],
        false,
    );
}

/// 앞 문단의 어울림 영역은 단 기준 x, 현재 문단 기준 y로 전달한다.
/// 반환값도 같은 좌표계이며 현재 문단이 새로 소유하는 영역만 포함한다.
pub(crate) fn reflow_line_segs_with_exclusions(
    para: &mut Paragraph,
    available_width_px: f64,
    styles: &ResolvedStyleSet,
    dpi: f64,
    preceding: &[FloatExclusion],
) -> Vec<FloatExclusion> {
    reflow_line_segs_with_wrap_exclusions(
        para,
        available_width_px,
        styles,
        dpi,
        false,
        preceding,
        true,
    );
    let style = styles.para_styles.get(para.para_shape_id as usize);
    let margins = style.map_or((0.0, 0.0), |s| (s.margin_left, s.margin_right));
    let first_vpos = para.line_segs.first().map_or(0, |line| line.vertical_pos);
    let Some(plan) = paragraph_local_wrap_plan(
        para,
        available_width_px,
        margins,
        |anchor| {
            let offset = para.char_offsets.get(anchor).copied().unwrap_or(0);
            para.line_segs
                .iter()
                .rev()
                .find(|line| line.text_start <= offset)
                .map_or(0.0, |line| {
                    hwpunit_to_px(line.vertical_pos - first_vpos, dpi)
                })
        },
        style.map_or(LineSpacingType::Percent, |s| s.line_spacing_type),
        style.map_or(160.0, |s| s.line_spacing),
        dpi,
    ) else {
        return Vec::new();
    };
    plan.exclusions
        .into_iter()
        .map(|mut exclusion| {
            exclusion.rect.x += margins.0;
            exclusion
        })
        .collect()
}

fn reflow_line_segs_with_wrap_exclusions(
    para: &mut Paragraph,
    available_width_px: f64,
    styles: &ResolvedStyleSet,
    dpi: f64,
    squeeze: bool,
    preceding: &[FloatExclusion],
    generated_body: bool,
) {
    // HWPX 저장 탭 이동량은 원래 줄에서만 유효하다.
    for tab in &mut para.tab_extended {
        tab[5] &= !0x4000;
    }
    // 줄 폭(segment_width)은 폭 해석(단/셀 폭의 4 HU 격자 내림 포함)이 준 HU 값 그대로다.
    // px 왕복 절삭은 −1 HU 를 만든다 (lineseg 오라클 W0) — 반올림한다.
    let seg_width_hwp = px_to_hwpunit_round(available_width_px, dpi);
    let orig = para.line_segs.first().cloned();
    let has_valid_orig = orig.as_ref().map(|ls| ls.line_height > 0).unwrap_or(false);

    // ParaPr의 줄간격 설정 (합성 LineSeg에서 line_spacing 계산에 사용)
    let para_style = styles.para_styles.get(para.para_shape_id as usize);
    let ls_type = para_style
        .map(|s| s.line_spacing_type)
        .unwrap_or(LineSpacingType::Percent);
    let ls_value = para_style.map(|s| s.line_spacing).unwrap_or(160.0);
    let vertical_align = para_style.map(|s| s.vertical_align).unwrap_or(0);

    // 줄별 max_font_size에 따라 line_height/text_height/baseline_distance를 계산
    // 한컴은 줄마다 최대 폰트 크기에 맞게 다른 치수를 사용
    let make_line_seg = |utf16_start: u32, max_font_size: f64| -> LineSeg {
        let fs = if max_font_size > 0.0 {
            max_font_size
        } else {
            12.0
        };
        let line_height_hwp = font_size_to_line_height(fs, dpi);
        let text_height_hwp = line_height_hwp;
        let baseline_distance_hwp = baseline_for_vertical_align(text_height_hwp, vertical_align);
        let line_spacing_hwp = compute_line_spacing_hwp(ls_type, ls_value, line_height_hwp, dpi);
        // [Task #1811] 원본 linesegarray 부재(orig=None) 시 합성 seg 에 구현속성
        // 태그를 부여 — vpos 보정 등에서 실제 저장 증거와 구분한다 (컨버터의
        // 합성 lineseg flags=0x8000_0000 관례와 정합).
        let orig_tag = orig
            .as_ref()
            .map(|ls| ls.tag)
            .unwrap_or(LineSeg::TAG_SINGLE_SEGMENT_LINE | LineSeg::TAG_IMPLEMENTATION_PROPERTY);
        LineSeg {
            text_start: utf16_start,
            line_height: line_height_hwp,
            text_height: text_height_hwp,
            baseline_distance: baseline_distance_hwp,
            line_spacing: line_spacing_hwp,
            segment_width: seg_width_hwp,
            tag: if orig_tag != 0 {
                orig_tag
            } else {
                LineSeg::TAG_SINGLE_SEGMENT_LINE
            },
            ..Default::default()
        }
    };

    if para.text.is_empty() {
        let inline_sizes = para
            .controls
            .iter()
            .enumerate()
            .map(|(ci, control)| {
                ruby_control_metrics(para, ci, styles, dpi)
                    .or_else(|| inline_control_metrics_hwp(control))
            })
            .collect::<Vec<_>>();
        // HWPX 책갈피·숨은 설명은 확장 레코드를 소비하지 않는 메타데이터다.
        let mut control_units = 0u32;
        let control_anchors: Vec<u32> = para
            .controls
            .iter()
            .map(|control| {
                let anchor = control_units;
                if !matches!(control, Control::Bookmark(_) | Control::HiddenComment(_)) {
                    control_units = control_units.saturating_add(8);
                }
                anchor
            })
            .collect();
        // fresh TAC 표는 확장 제어 축이 확인될 때 점유 개체의 글자 모양으로 간격을 잰다.
        let use_control_font_basis = ls_type == LineSpacingType::Percent
            && crate::renderer::para_has_no_stored_line_segs(para)
            && !para.char_shapes.is_empty()
            && para.field_ranges.is_empty()
            && para.orphan_field_ends.is_empty()
            && para.char_count == control_units.saturating_add(1)
            && inline_sizes
                .iter()
                .enumerate()
                .filter(|(_, m)| m.is_some())
                .all(|(ci, _)| {
                    matches!(&para.controls[ci], Control::Table(table)
                    if !table.common.affect_line_spacing)
                        && para
                            .char_shapes
                            .iter()
                            .any(|shape| shape.start_pos <= control_anchors[ci])
                        && style_font_size(
                            styles,
                            find_active_char_shape(&para.char_shapes, control_anchors[ci]),
                        ) > 0.0
                });
        let has_ruby = para
            .controls
            .iter()
            .any(|c| matches!(c, Control::Ruby(r) if r.option == 0));
        if inline_sizes.iter().any(Option::is_some) {
            let max_line_width = seg_width_hwp.max(1);
            // (text_start, 첫 컨트롤, 끝 컨트롤(포함), 최대 기준선, 최대 높이)
            let mut line_specs: Vec<(usize, usize, usize, i32, i32)> = Vec::new();
            let mut line_start = 0usize;
            let mut line_first_ctrl = 0usize;
            let mut line_width = 0i32;
            let mut line_baseline = 0i32;
            let mut line_height = 0i32;
            let mut line_descent = 0i32;
            let mut inline_index = 0usize;

            for (ci, metrics) in inline_sizes.iter().copied().enumerate() {
                if metrics.is_none()
                    && (has_ruby
                        || (use_control_font_basis
                            && !matches!(para.controls[ci], Control::PageNumberPos(_))))
                {
                    continue;
                }
                // 한컴: 글자처럼 취급한 개체가 이미 줄 폭을 넘긴 줄에는 뒤따르는 폭 0
                // 컨트롤(쪽 번호 위치·책갈피 등)도 남지 못하고 다음 줄로 넘어가 그 글자
                // 모양 높이의 줄을 하나 더 만든다. 넘치지 않으면 같은 줄에 남는다.
                // 줄 폭을 넘는 개체는 앞에 폭 0 조판 부호(쪽 번호 위치 등)가 있으면 새 줄에서
                // 시작한다 — 그 컨트롤 줄은 글자 높이 줄로 남는다 (fdi-press s0/p0: 구역·단·
                // 쪽번호 컨트롤 줄 th 100 + 48263 HU 표 줄, 한컴 PDF 표 1.44pt 아래).
                // 구역/단 정의뿐이면 한 줄로 둔다: 한컴은 저장 줄이 둘이어도 표를 문단
                // 상단에 그리고 쪽에 담는다 (hcar-001 s1·gov-fire-report 표 위치, 6쪽).
                let ctrl_line_before = !use_control_font_basis
                    && !has_ruby
                    && ci > line_first_ctrl
                    && para.controls[line_first_ctrl..ci]
                        .iter()
                        .any(|c| !matches!(c, Control::SectionDef(_) | Control::ColumnDef(_)));
                let wraps = match metrics {
                    Some(m) => {
                        (line_width > 0 || ctrl_line_before)
                            && line_width + m.width > max_line_width
                    }
                    None => line_width > max_line_width,
                };
                if wraps {
                    line_specs.push((
                        line_start,
                        line_first_ctrl,
                        ci - 1,
                        line_baseline,
                        line_height,
                    ));
                    // 한컴 저장값처럼 줄 시작은 컨트롤의 UTF-16 위치(8ci)다. 쪽 나눔 엔진도
                    // 같은 축으로 개체 줄을 찾는다 (`pagination::control_utf16_position`).
                    line_start = if use_control_font_basis {
                        control_anchors[ci] as usize
                    } else if has_ruby {
                        inline_index
                    } else {
                        ci * 8
                    };
                    line_first_ctrl = ci;
                    line_width = 0;
                    line_baseline = 0;
                    line_height = 0;
                    line_descent = 0;
                }
                if let Some(m) = metrics {
                    line_width += m.width;
                    line_baseline = line_baseline.max(m.baseline);
                    line_descent = line_descent.max(m.height - m.baseline);
                    line_height = if has_ruby {
                        line_baseline.saturating_add(line_descent)
                    } else {
                        line_height.max(m.height)
                    };
                    inline_index += 1;
                }
            }
            line_specs.push((
                line_start,
                line_first_ctrl,
                para.controls.len() - 1,
                line_baseline,
                line_height,
            ));

            // 빈 텍스트 문단에서 컨트롤 ci 는 UTF-16 [8ci, 8ci+8) 을 차지한다. 줄 높이·
            // 줄간격의 글꼴 크기는 그 구간에 걸친 글자 모양의 최댓값이다 (한컴 저장
            // LINE_SEG: 표 줄 줄간격 = 글자 모양 크기 × (비율 − 100%)).
            let line_font_size = |first_ctrl: usize, last_ctrl: usize| -> f64 {
                if use_control_font_basis {
                    return (first_ctrl..=last_ctrl)
                        .filter(|&ci| {
                            inline_sizes[ci].is_some()
                                || matches!(para.controls[ci], Control::PageNumberPos(_))
                        })
                        .map(|ci| {
                            style_font_size(
                                styles,
                                find_active_char_shape(&para.char_shapes, control_anchors[ci]),
                            )
                        })
                        .fold(0.0, f64::max);
                }
                if has_ruby {
                    return 0.0;
                }
                let lo = (first_ctrl as u32).saturating_mul(8);
                let hi = (last_ctrl as u32 + 1).saturating_mul(8);
                para.char_shapes
                    .iter()
                    .enumerate()
                    .filter(|(i, cs)| {
                        let end = para
                            .char_shapes
                            .get(i + 1)
                            .map(|next| next.start_pos)
                            .unwrap_or(u32::MAX);
                        cs.start_pos < hi && end > lo
                    })
                    .filter_map(|(_, cs)| styles.char_styles.get(cs.char_shape_id as usize))
                    .map(|style| style.font_size)
                    .fold(0.0, f64::max)
            };

            let orig_line_segs = para.line_segs.clone();
            let has_object: Vec<bool> = line_specs
                .iter()
                .map(|&(_, _, _, _, height)| height > 0)
                .collect();
            let mut new_line_segs = Vec::with_capacity(line_specs.len());
            for (line_idx, (start_pos, first_ctrl, last_ctrl, baseline_hwp, height_hwp)) in
                line_specs.into_iter().enumerate()
            {
                let start_pos = if line_idx == 0 { 0 } else { start_pos };
                let font_size = line_font_size(first_ctrl, last_ctrl);
                let mut seg = make_line_seg(start_pos as u32, font_size);
                if use_control_font_basis {
                    // 원본 percent 경로는 1/4 HWPUNIT 기준에서 MulDiv 후 4배한다.
                    let quarter = i64::from(font_size_to_line_height(font_size, dpi) / 4);
                    let product = quarter * (ls_value - 100.0) as i64;
                    let rounded = (product.abs() + 50) / 100 * product.signum();
                    seg.line_spacing =
                        (rounded * 4).clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
                }
                if let Some(template) = orig_line_segs
                    .get(line_idx)
                    .or_else(|| orig_line_segs.first())
                {
                    if !use_control_font_basis {
                        seg.line_spacing = template.line_spacing;
                    }
                    seg.segment_width = if template.segment_width > 0 {
                        template.segment_width
                    } else {
                        seg_width_hwp
                    };
                    seg.tag = if template.tag != 0 {
                        template.tag
                    } else {
                        seg.tag
                    };
                }
                apply_inline_control_line_metrics(
                    &mut seg,
                    InlineControlMetricsHwp {
                        width: 0,
                        height: height_hwp,
                        baseline: baseline_hwp,
                    },
                );
                new_line_segs.push(seg);
            }
            // 개체 줄 앞의 컨트롤 전용 줄: 한컴은 줄 높이를 뒤 개체 줄 높이로 두고 글자
            // 높이·기준선은 글자 모양 그대로 저장한다 (lh 4091 / th 100 / bl 85).
            for i in (0..new_line_segs.len().saturating_sub(1)).rev() {
                let next_h = new_line_segs[i + 1].line_height;
                if !has_object[i] && has_object[i + 1] && new_line_segs[i].line_height < next_h {
                    new_line_segs[i].line_height = next_h;
                }
            }

            let mut vpos = orig.as_ref().map(|ls| ls.vertical_pos).unwrap_or(0);
            for seg in &mut new_line_segs {
                seg.vertical_pos = vpos;
                // 전진량은 TAC 관례대로 글자 높이 기준 (lh>th 줄은 th).
                let advance = if seg.line_height > seg.text_height && seg.text_height > 0 {
                    seg.text_height
                } else {
                    seg.line_height
                };
                vpos += advance + seg.line_spacing;
            }
            let narrowed = vec![false; new_line_segs.len()];
            apply_hancom_line_geometry(&mut new_line_segs, &narrowed, para_style, dpi);
            para.line_segs = new_line_segs;
        } else {
            // 빈 문단도 활성 글자 모양의 크기로 줄을 만든다. 앞 문단 LINE_SEG의
            // 치수를 복사하면 TAC 그림 높이까지 상속되므로 vpos 원점만 보존한다.
            let font_size = para
                .char_shapes
                .first()
                .and_then(|char_shape| styles.char_styles.get(char_shape.char_shape_id as usize))
                .map(|style| style.font_size)
                .unwrap_or(12.0);
            let mut seg = make_line_seg(0, font_size);
            if let Some(template) = orig.as_ref() {
                seg.vertical_pos = template.vertical_pos;
            }
            let mut segs = vec![seg];
            apply_hancom_line_geometry(&mut segs, &[false], para_style, dpi);
            para.line_segs = segs;
        }
        return;
    }

    let text_chars: Vec<char> = para.text.chars().collect();
    let text_len = text_chars.len();

    // 문단 스타일에서 들여쓰기 및 줄 나눔 설정 조회
    let para_style = styles.para_styles.get(para.para_shape_id as usize);
    let indent_px = para_style.map(|s| s.indent).unwrap_or(0.0);
    let english_break_unit = para_style.map(|s| s.english_break_unit).unwrap_or(0);
    let korean_break_unit = para_style.map(|s| s.korean_break_unit).unwrap_or(0);
    let condense_min_space = para_style.map(|s| s.condense_min_space).unwrap_or(0);
    // 한글↔영문/숫자 자동 간격 (문단 모양 autoSpacing 설정)
    let auto_spacing = para_style
        .map(|s| AutoSpacing {
            eng: s.auto_spacing_eng,
            num: s.auto_spacing_num,
        })
        .unwrap_or_default();

    // 인라인(treat_as_char) 개체를 줄 나눔 토큰에 반영한다 — 개체 폭을 예약하지
    // 않으면 개체 삽입 편집 후 재배치 시 뒤따르는 텍스트가 컬럼 밖으로 밀려난다.
    // Form은 인라인 흐름 개체가 아니므로 제외한다.
    // own_line: 표/그림/도형은 한컴이 전용 줄을 부여하는 블록형 개체로 취급한다
    // (수식은 텍스트 흐름 개체). 블록형 개체 줄에서 넘치는 후행 토큰은 통째로
    // 다음 줄로 본내 한 글자 run 조각남을 피한다 (pr_2219).
    let mut control_positions = para.control_text_positions();
    crate::renderer::ruby::project_control_positions(para, &mut control_positions);
    let mut inline_controls: Vec<(usize, i32, bool)> = para
        .controls
        .iter()
        .enumerate()
        .filter(|(_, ctrl)| !matches!(ctrl, Control::Form(_)))
        .filter_map(|(ci, ctrl)| {
            ruby_control_metrics(para, ci, styles, dpi)
                .or_else(|| inline_control_metrics_hwp(ctrl))
                .map(|m| {
                    (
                        ci,
                        m.width,
                        !matches!(ctrl, Control::Equation(_) | Control::Ruby(_)),
                    )
                })
        })
        .map(|(ci, width, own_line)| {
            let pos = control_positions
                .get(ci)
                .copied()
                .unwrap_or(text_len)
                .min(text_len);
            (pos, width, own_line)
        })
        .collect();
    inline_controls.sort_by_key(|&(pos, _, _)| pos);

    // 토큰화 → 줄 채움 → LineSeg 생성
    let mut tokens = tokenize_paragraph_with_controls(
        &text_chars,
        &para.char_offsets,
        &para.char_shapes,
        styles,
        english_break_unit,
        korean_break_unit,
        auto_spacing,
        &inline_controls,
    );
    measure_footnote_number_tokens(&mut tokens, para, styles);
    // 1차: 전폭 채움. 어울림 개체가 있으면 여기서 앵커 줄 y 를 추정해 배제
    // 계획을 만들고, 2차 채움과 seg 지오메트리가 같은 계산으로 wrap zone 을 쓴다.
    let advance_px_of = |fs: f64| -> f64 {
        let f = if fs > 0.0 { fs } else { 12.0 };
        let lh = font_size_to_line_height(f, dpi);
        let sp = compute_line_spacing_hwp(ls_type, ls_value, lh, dpi);
        hwpunit_to_px(lh + sp, dpi)
    };
    // 문단 머리(번호/글머리표) 폭 — macOS 한컴은 첫 줄을 그만큼 덜 채운다 (aift p37).
    let mut head_reserve_px = crate::renderer::layout::paragraph_head_reserve_px(styles, para, dpi);
    if generated_body {
        // 본문 참조 번호는 첫 줄 앞에 그려진다. 합성 단계부터 같은 폭을 예약해
        // 뒤늦은 캐시 재조판이 다른 줄의 개체 높이를 이어받지 않게 한다.
        head_reserve_px.0 +=
            crate::renderer::layout::leading_note_marker_width_px(para, styles).unwrap_or(0.0);
    }
    let squeeze = squeeze || para_style.is_some_and(|s| s.line_wrap_squeeze);
    let line_breaks_full = if squeeze {
        squeeze_lines(&tokens, text_len)
    } else {
        fill_lines(
            &tokens,
            &text_chars,
            available_width_px,
            indent_px,
            head_reserve_px,
            para_style,
            korean_break_unit,
            english_break_unit,
            condense_min_space,
            None,
        )
    };
    let margins_px = para_style
        .map(|s| (s.margin_left, s.margin_right))
        .unwrap_or((0.0, 0.0));
    let mut wrap_plan = paragraph_local_wrap_plan(
        para,
        available_width_px,
        margins_px,
        |anchor_pos: usize| -> f64 {
            let mut y = 0.0;
            for lb in &line_breaks_full {
                if anchor_pos < lb.end_idx {
                    break;
                }
                y += advance_px_of(lb.max_font_size);
            }
            y
        },
        ls_type,
        ls_value,
        dpi,
    );
    if !preceding.is_empty() {
        let plan = wrap_plan.get_or_insert_with(|| LineBandPlan {
            exclusions: Vec::new(),
            column_w_px: available_width_px,
            generated_body,
            ls_type,
            ls_value,
            dpi,
        });
        plan.exclusions.extend(preceding.iter().map(|exclusion| {
            let mut exclusion = *exclusion;
            exclusion.rect.x -= margins_px.0;
            exclusion
        }));
    }
    if let Some(plan) = &mut wrap_plan {
        plan.generated_body = generated_body;
    }
    let line_breaks = match &wrap_plan {
        Some(plan) if !squeeze => fill_lines(
            &tokens,
            &text_chars,
            available_width_px,
            indent_px,
            head_reserve_px,
            para_style,
            korean_break_unit,
            english_break_unit,
            condense_min_space,
            Some(plan),
        ),
        _ => line_breaks_full,
    };
    // 문단 머리(번호/글머리표)는 자기 글자 모양으로 첫 줄에 놓인다 — 그 크기가 본문보다
    // 크면 첫 줄 높이가 커진다 (오라클 H4: exam-social 11.5pt 본문 + 14pt 번호 → 1400).
    let head_font_size = paragraph_head_font_size(styles, para_style);
    // 문단 끝 표시(문단 부호)의 글자 모양도 마지막 줄 높이에 든다 — 끝에 빈 run 으로
    // 남은 큰 글자 모양 (오라클 H4: aift 11pt 본문 + 끝 16pt run → 1600).
    let end_mark_font_size = {
        let end_pos = para
            .char_offsets
            .last()
            .zip(text_chars.last())
            .map(|(&off, ch)| off + ch.len_utf16() as u32)
            .unwrap_or(0);
        let style_id = find_active_char_shape(&para.char_shapes, end_pos);
        style_font_size(styles, style_id)
    };
    let mut new_line_segs: Vec<LineSeg> = Vec::new();
    for lb in &line_breaks {
        let utf16_start = if new_line_segs.is_empty() {
            0 // 첫 번째 줄의 text_start는 항상 0 (문단 시작)
        } else if lb.start_idx < para.char_offsets.len() {
            para.char_offsets[lb.start_idx]
        } else if !para.char_offsets.is_empty() {
            // start_idx가 텍스트 끝을 넘을 때: 마지막 문자 다음 UTF-16 위치
            let last_idx = para.char_offsets.len() - 1;
            let last_char_utf16_len = para
                .text
                .chars()
                .nth(last_idx)
                .map(|c| c.len_utf16() as u32)
                .unwrap_or(1);
            para.char_offsets[last_idx] + last_char_utf16_len
        } else {
            lb.start_idx as u32
        };
        let mut fs = if lb.max_font_size > 0.0 {
            lb.max_font_size
        } else {
            12.0
        };
        if new_line_segs.is_empty() {
            fs = fs.max(head_font_size);
        }
        if std::ptr::eq(lb, line_breaks.last().unwrap_or(lb)) {
            fs = fs.max(end_mark_font_size);
        }
        let mut seg = make_line_seg(utf16_start as u32, fs);
        let end_pos = para
            .char_offsets
            .get(lb.end_idx)
            .copied()
            .unwrap_or_else(|| {
                para.char_offsets
                    .last()
                    .zip(text_chars.last())
                    .map(|(&offset, ch)| offset + ch.len_utf16() as u32)
                    .unwrap_or(0)
            });
        apply_char_border_line_metrics(&mut seg, end_pos, para, styles, dpi, ls_type, ls_value);
        new_line_segs.push(seg);
    }

    if new_line_segs.is_empty() {
        new_line_segs.push(make_line_seg(0, 12.0));
    }

    // Reserve each object's height on its actual line. Applying the largest
    // picture to the first line creates a blank band above wrapped pictures.
    apply_inline_control_metrics_to_text_lines(para, &line_breaks, &mut new_line_segs, styles, dpi);

    // 어울림 배제 계획이 있으면 줄별 wrap zone 을 seg 에 기록한다 — 채움(2차
    // fill_lines)과 동일한 결정적 대역 계산이라 텍스트가 기록 폭을 넘지 않는다.
    // 렌더러는 이 column_start/segment_width 를 저장 지오메트리처럼 재생한다.
    let mut narrowed = vec![false; new_line_segs.len()];
    if let Some(plan) = &wrap_plan {
        let mut y = 0.0;
        for i in 0..new_line_segs.len() {
            let band_fs = if i == 0 {
                0.0
            } else {
                line_breaks
                    .get(i - 1)
                    .map(|lb| lb.max_font_size)
                    .unwrap_or(0.0)
            };
            let (x, w) = plan.interval_at(y, band_fs);
            if plan.narrows(x, w) {
                let column_x = x + if generated_body { margins_px.0 } else { 0.0 };
                new_line_segs[i].column_start = px_to_hwpunit(column_x, dpi);
                new_line_segs[i].segment_width = px_to_hwpunit(w, dpi).max(1);
                narrowed[i] = true;
            }
            let line_fs = line_breaks.get(i).map(|lb| lb.max_font_size).unwrap_or(0.0);
            y += advance_px_of(line_fs);
        }
    }

    // vertical_pos 누적 계산 (각 줄의 문단 내 Y 오프셋)
    // 원본 첫 LineSeg의 vertical_pos를 보존하여 vpos 체계 연속성 유지
    // (layout.rs의 vpos 보정이 문단 간 vpos 연속성을 가정하므로)
    let vpos_start = orig.as_ref().map(|ls| ls.vertical_pos).unwrap_or(0);
    let mut vpos = vpos_start;
    for i in 0..new_line_segs.len() {
        new_line_segs[i].vertical_pos = vpos;
        vpos += new_line_segs[i].text_height + new_line_segs[i].line_spacing;
    }

    apply_hancom_line_geometry(&mut new_line_segs, &narrowed, para_style, dpi);
    para.line_segs = new_line_segs;
}

/// 문단 머리(번호/글머리표)가 자기 글자 모양을 가질 때 그 글자 크기(px). 없으면 0.
/// 개요 번호는 구역 개요 번호 정의가 필요해 여기서는 다루지 않는다.
fn paragraph_head_font_size(
    styles: &ResolvedStyleSet,
    para_style: Option<&crate::renderer::style_resolver::ResolvedParaStyle>,
) -> f64 {
    use crate::model::style::HeadType;
    let Some(ps) = para_style else {
        return 0.0;
    };
    if ps.numbering_id == 0 {
        return 0.0;
    }
    let idx = (ps.numbering_id - 1) as usize;
    let char_shape_id = match ps.head_type {
        HeadType::Number => styles.numberings.get(idx).and_then(|n| {
            let level = (ps.para_level as usize).min(6);
            (!n.level_formats[level].is_empty()).then(|| n.heads[level].char_shape_id)
        }),
        HeadType::Bullet => styles
            .bullets
            .get(idx)
            .filter(|b| b.bullet_char != '\u{FFFF}')
            .map(|b| b.char_shape_id),
        _ => None,
    };
    char_shape_id
        .and_then(|id| styles.char_styles.get(id as usize))
        .map(|cs| cs.font_size)
        .unwrap_or(0.0)
}

/// HWPUNIT 값을 한컴 1/1800인치 격자(4 HU)로 내린다 (0 쪽으로).
fn floor_to_hancom_grid(hu: i32) -> i32 {
    hu - hu.rem_euclid(4)
}

/// 0 에서 먼 쪽으로 반올림 (한컴 정수 환산 규칙).
fn round_half_away(x: f64) -> i32 {
    x.round() as i32
}

/// 줄 기준선 위치: 문단 세로 정렬을 따른다 (lineseg 오라클 B1/B2).
/// 글꼴 기준(0)은 글자 높이의 0.85 를 반올림, 위(1)=0, 가운데(2)=0.5, 아래(3)=1.0.
fn baseline_for_vertical_align(text_height_hwp: i32, vertical_align: u8) -> i32 {
    let ratio = match vertical_align {
        1 => 0.0,
        2 => 0.5,
        3 => 1.0,
        _ => 0.85,
    };
    round_half_away(text_height_hwp as f64 * ratio)
}

/// 한컴 저장 LINE_SEG 의 줄 시작 위치와 줄 플래그 (lineseg 오라클 C1/G1/G2).
///
/// - column_start: 단 왼쪽에서 잰 줄 시작 = 문단 왼쪽 여백 (들여쓰기는 넣지 않는다).
///   어울림 계획으로 좁힌 줄(`narrowed`)은 계획 값을 그대로 둔다.
/// - bit 20(들여쓰기 적용): 들여쓰기(>0)는 첫 줄, 내어쓰기(<0)와 문단 머리 모양
///   (번호/글머리표)은 둘째 줄부터.
/// - bit 21(문단 머리): 머리 모양이 있는 문단의 첫 줄.
fn apply_hancom_line_geometry(
    segs: &mut [LineSeg],
    narrowed: &[bool],
    para_style: Option<&crate::renderer::style_resolver::ResolvedParaStyle>,
    dpi: f64,
) {
    let (margin_hu, indent, has_head) = para_style
        .map(|s| {
            (
                px_to_hwpunit_round(s.margin_left, dpi),
                s.indent,
                !matches!(s.head_type, crate::model::style::HeadType::None),
            )
        })
        .unwrap_or((0, 0.0, false));
    // 어울림 계획 문단은 계획의 줄 좌표(문단 여백 기준)를 렌더러가 그대로 재생한다 —
    // 그 문단의 줄 시작은 건드리지 않는다.
    let wrap_planned = narrowed.iter().any(|n| *n);
    for (i, seg) in segs.iter_mut().enumerate() {
        if !wrap_planned {
            seg.column_start = margin_hu;
        }
        let mut tag = seg.tag & !(LineSeg::TAG_INDENTATION | LineSeg::TAG_PARAGRAPH_HEAD);
        let indented = if i == 0 {
            indent > 0.0
        } else {
            indent < 0.0 || has_head
        };
        if indented {
            tag |= LineSeg::TAG_INDENTATION;
        }
        if i == 0 && has_head {
            tag |= LineSeg::TAG_PARAGRAPH_HEAD;
        }
        seg.tag = tag;
    }
}

/// 구역 내 문단들의 vertical_pos를 순차적으로 재계산한다.
///
/// `start_para`부터 구역 끝까지 각 문단의 vpos를 이전 문단의 vpos_end 기준으로 재계산.
/// 표 등 특수 문단의 line_height는 보존하고 vpos만 갱신한다.
///
/// [Task #2299] 저장 vpos 리셋(단/쪽 경계 인코딩) 보존: 편집발 재계산이 구역 전체를
/// 선형 누적 좌표로 이어붙이면 다단 zone 의 단-상대 리셋(급감)이 소멸해
/// typeset(#321/#470/#702)·pagination 의 단/쪽 진행 신호가 무력화된다
/// (shortcut.hwp 앞문단 편집 시 col=[0,1]→[0], 7→9쪽). 현재 문단의 저장 first 가
/// 직전 문단의 "이동 전(저장)" end 보다 감소하면 경계 인코딩으로 보고 delta=0 으로
/// 보존한다. 저장 좌표는 밴드 내 정상 흐름에서 단조 증가하므로 감소 감지에 임계가
/// 필요 없다.
///
/// 좌표 갱신은 경계 성격별로 셋으로 나뉜다.
///
/// - **리셋 경계**: delta=0 보존.
/// - **변조 인접 경계**(현재 문단이 편집 대상 `start_para` 이거나 신규
///   문단(`ignore_reset_range`)이거나, 직전 문단이 그중 하나): 직전 이동 후 end 에
///   문단 여백 gap(spacing_after + spacing_before, 셀 recalc `boundary_gaps` 동일
///   산식)을 더해 다시 잇는다. reflow/신규 생성으로 저장 gap 이 소실된 경계라
///   스타일에서 재유도한다. gap 없는 abutment 는 문단 간격을 압축해 near-top
///   리셋(#1086/#1921)의 `prev_vpos_end > 60000` 임계를 무너뜨렸다
///   (SO-SUEOP.hwpx 46→44).
/// - **미변조 연속 경계**: 직전 문단의 delta 를 그대로 캐리해 저장(또는 로드 합성
///   #927) 문단 간격을 정확히 보존한다. 스타일 gap 재유도는 저장 gap 과의
///   오차(px 왕복 절삭 ±1HU, 스타일-저장 불일치)를 밴드 전체에 누적시키고 로드
///   합성 gap-less 체인과도 어긋나므로 쓰지 않는다. delta==0 이면 순수 no-op.
///
/// 리셋 감지는 저장 좌표끼리의 비교여야 한다. 직전 문단이 변조 대상이면 그 end 는
/// 저장 좌표가 아니므로(성장 편집이 다음 문단을 가짜 리셋으로 동결시키고,
/// placeholder 는 기준을 붕괴시킨다) reflow 가 보존하는 **first** 로 비교한다.
/// 미변조 경계는 end 기준을 유지한다(연속 0-first 밴드 감지에 필요).
///
/// placeholder 저지선 2종: ① split/insert/paste 가 방금 만든 신규 문단의 vpos=0 은
/// 경계 인코딩이 아니다 — 보존하면 문단마다 가짜 쪽나눔이 생긴다
/// (test_page_boundary_with_incremental_spacing_increase 핀). 호출자가 신규 구간을
/// `ignore_reset_range` 로 지정하면 보존 없이 흐름에 연결한다(셀 경로
/// `recalculate_cell_paragraph_vpos` 의 ignore_reset_at 과 동일 취지, 다중 삽입을
/// 위해 범위형). ② lineseg 부재였다가 on-demand reflow(#177/#927)로 합성된
/// seg(TAG_IMPLEMENTATION_PROPERTY, #1811)도 보존하지 않는다.
///
/// 줄 전진량은 로드 경로(document.rs 의 vpos 체인)와 동일하게 TAC 호스트
/// 줄(lh>th)을 th 기준으로 센다 — lh 기준이면 인라인 개체 호스트의 end 가 저장
/// 후속 first 를 넘어서 가짜 리셋을 만든다.
pub(crate) fn recalculate_section_vpos(
    paragraphs: &mut [Paragraph],
    start_para: usize,
    ignore_reset_range: Option<std::ops::Range<usize>>,
    start_stored_end: Option<i32>,
    styles: &ResolvedStyleSet,
    dpi: f64,
    is_hwp3_variant: bool,
) {
    if paragraphs.is_empty() || start_para >= paragraphs.len() {
        return;
    }

    // 문단 경계 gap (HWPUNIT) = 앞 문단 spacing_after + 뒤 문단 spacing_before.
    // recalculate_cell_paragraph_vpos 의 boundary_gaps 와 동일 산식.
    let boundary_gap = |prev: &Paragraph, curr: &Paragraph| -> i32 {
        let spacing_after = styles
            .para_styles
            .get(prev.para_shape_id as usize)
            .map(|style| style.spacing_after)
            .unwrap_or(0.0);
        let spacing_before = styles
            .para_styles
            .get(curr.para_shape_id as usize)
            .map(|style| style.spacing_before)
            .unwrap_or(0.0);
        let spacing_before =
            crate::renderer::hwp3_variant_flow_spacing_before(spacing_before, is_hwp3_variant);
        // 문단 여백은 HWPUNIT 정수에서 온다 — px 왕복 절삭은 −1 HU 를 만든다 (오라클 V1).
        px_to_hwpunit_round(spacing_after + spacing_before, dpi)
    };

    // 줄 전진량 — 로드 경로와 동일한 TAC th-관례. saturating: 조작 파일의 극단
    // spacing/좌표로 i32 가 넘치지 않게 한다 (release wasm 은 overflow-check 가
    // 없어 무음 랩 → 전 문단 오판으로 이어진다).
    let seg_advance = |ls: &LineSeg| -> i32 {
        let height = if ls.text_height > 0 {
            ls.text_height
        } else {
            ls.line_height
        };
        height.saturating_add(ls.line_spacing)
    };
    // 문단 흐름 끝. 문단에 앵커된 자리차지(TopAndBottom) 표가 줄들보다 아래로
    // 내려가면 다음 문단은 그 표 아래(세로 오프셋 + 높이 + 바깥 여백 위/아래)에서
    // 시작한다 (한컴 저장 vpos, 오라클 군집 15: aift s2/p57 0+6205+282=6487,
    // s2/p147 35093+261+11536+282=47172).
    let seg_end = |p: &Paragraph| -> Option<i32> {
        let first = p.line_segs.first()?.vertical_pos;
        let lines_end = p
            .line_segs
            .last()
            .map(|ls| ls.vertical_pos.saturating_add(seg_advance(ls)))?;
        let block_end = p
            .controls
            .iter()
            .filter_map(|ctrl| match ctrl {
                Control::Table(t)
                    if !t.common.treat_as_char
                        && matches!(t.common.text_wrap, TextWrap::TopAndBottom)
                        && matches!(t.common.vert_rel_to, VertRelTo::Para) =>
                {
                    Some(
                        first
                            .saturating_add(t.common.vertical_offset as i32)
                            .saturating_add(t.common.height as i32)
                            .saturating_add(i32::from(t.outer_margin_top.max(0)))
                            .saturating_add(i32::from(t.outer_margin_bottom.max(0))),
                    )
                }
                _ => None,
            })
            .max();
        Some(block_end.map_or(lines_end, |b| b.max(lines_end)))
    };
    let is_ignored = |pi: usize| {
        ignore_reset_range
            .as_ref()
            .is_some_and(|range| range.contains(&pi))
    };

    // 직전 문단(마지막 비어있지 않은 lineseg 보유 문단) 인덱스.
    // start_para 이전 문단들은 이 호출에서 이동하지 않으므로 현재 좌표가 곧 저장 좌표다.
    let mut prev_idx: Option<usize> = paragraphs[..start_para]
        .iter()
        .rposition(|p| !p.line_segs.is_empty());
    let mut next_vpos = match prev_idx {
        Some(pp) => seg_end(&paragraphs[pp]).unwrap_or(0),
        // 첫 문단: 기존 vpos 유지
        None => paragraphs[start_para]
            .line_segs
            .first()
            .map(|ls| ls.vertical_pos)
            .unwrap_or(0),
    };
    // 리셋 감지 기준 — 직전 문단의 "이동 전(저장)" first/end.
    let mut orig_prev_first: Option<i32> = prev_idx
        .and_then(|pp| paragraphs[pp].line_segs.first())
        .map(|ls| ls.vertical_pos);
    let mut orig_prev_end: Option<i32> = prev_idx.and_then(|pp| seg_end(&paragraphs[pp]));
    // 직전 문단이 이번 편집의 변조 대상이었는가 + 직전 문단에 적용된 delta.
    let mut prev_modified = false;
    let mut prev_delta: i32 = 0;

    for pi in start_para..paragraphs.len() {
        if paragraphs[pi].line_segs.is_empty() {
            continue;
        }

        let para_modified = pi == start_para || is_ignored(pi);
        let current_start = paragraphs[pi].line_segs[0].vertical_pos;
        let is_original_lineseg =
            paragraphs[pi].line_segs[0].tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY == 0;

        // 리셋 감지: 신규 문단(placeholder)·합성 seg 는 제외. 기준은 직전 문단의
        // "저장" 좌표여야 한다 — 직전이 편집 문단(start_para)이면 reflow 로 end 가
        // 이미 변조됐으므로 호출자가 캡처해 준 reflow 이전 저장 end 를 쓰고(성장
        // 편집의 가짜 리셋과 저장-겹침 문서의 정당한 리셋을 모두 정확히 판별),
        // 없으면 reflow 가 보존하는 first 로 보수적으로 비교한다. 신규 문단이
        // 직전이면 placeholder 라 first(=0) 기준. 미변조 경계는 end 기준을
        // 유지한다(연속 0-first 밴드 감지에 필요).
        let prev_stored_bound = if prev_idx == Some(start_para) && !is_ignored(start_para) {
            start_stored_end.or(orig_prev_first)
        } else if prev_modified {
            orig_prev_first
        } else {
            orig_prev_end
        };
        let is_reset = is_original_lineseg
            && !is_ignored(pi)
            && prev_stored_bound.is_some_and(|bound| current_start < bound);

        let delta = if is_reset {
            // 단/쪽 리셋 경계 — 저장 좌표 유지.
            0
        } else if para_modified || prev_modified {
            // 변조 인접 경계 — 이동 후 흐름에 스타일 여백 gap 으로 다시 잇는다.
            let gap = prev_idx
                .map(|pp| boundary_gap(&paragraphs[pp], &paragraphs[pi]))
                .unwrap_or(0);
            next_vpos.saturating_add(gap) - current_start
        } else {
            // 미변조 연속 경계 — 직전 delta 캐리로 기존 간격을 정확히 보존.
            prev_delta
        };

        // 다음 문단의 리셋 감지 기준은 "이동 전(저장)" first/end 로 기록한다.
        let orig_first = current_start;
        let orig_end = seg_end(&paragraphs[pi]);

        if delta != 0 {
            // 모든 LineSeg의 vpos를 delta만큼 이동
            for seg in &mut paragraphs[pi].line_segs {
                seg.vertical_pos = seg.vertical_pos.saturating_add(delta);
            }
        }

        // 다음 문단의 시작 vpos 계산 (이동 후 end = 저장 end + delta)
        if let Some(end) = orig_end {
            next_vpos = end.saturating_add(delta);
        }
        orig_prev_first = Some(orig_first);
        orig_prev_end = orig_end;
        prev_modified = para_modified;
        prev_delta = delta;
        prev_idx = Some(pi);
    }
}

/// [Task #2299] 문단의 흐름 end (마지막 LineSeg 의 vpos + 전진량, TAC th-관례).
/// 편집 호출자가 reflow 이전에 캡처해 `recalculate_section_vpos` 의
/// `start_stored_end` 로 전달하기 위한 헬퍼 — reflow 가 end 를 덮은 뒤에는 저장
/// 좌표를 복원할 수 없다.
pub(crate) fn paragraph_flow_end(para: &Paragraph) -> Option<i32> {
    para.line_segs.last().map(|ls| {
        let height = if ls.text_height > 0 {
            ls.text_height
        } else {
            ls.line_height
        };
        ls.vertical_pos
            .saturating_add(height.saturating_add(ls.line_spacing))
    })
}

/// font_size(px)를 LineSeg의 line_height(HWPUNIT)로 변환한다.
/// HWP의 LineSeg.line_height = 폰트 크기 (HWPUNIT).
/// 실증 데이터: 10pt → lh=1000, 12pt → lh=1200, 25pt → lh=2500
fn font_size_to_line_height(font_size_px: f64, dpi: f64) -> i32 {
    // 글자 크기는 HWPUNIT 정수(13pt = 1300)다. px 왕복 절삭은 1299 를 만든다 (오라클 H1).
    px_to_hwpunit_round(font_size_px, dpi)
}

/// ParaPr의 줄간격 설정으로부터 LineSeg.line_spacing(HWPUNIT)을 계산한다.
///
/// line_spacing = 현재 줄 하단 → 다음 줄 상단 사이의 추가 간격.
/// Y advance = line_height + line_spacing.
pub(super) fn compute_line_spacing_hwp(
    ls_type: LineSpacingType,
    ls_value: f64,
    line_height_hwp: i32,
    dpi: f64,
) -> i32 {
    match ls_type {
        LineSpacingType::Percent => {
            // ls_value = 비율값 (예: 160 = 160%)
            // 전체 줄 피치 = line_height * percent / 100
            // line_spacing = 전체 줄 피치 - line_height
            // [#2279] sub-100% 퍼센트는 음수 gap(압축)으로 존중 — 한글은
            // line=60% 를 advance 13.6px(=lh×0.6)로 렌더한다 (36398700 pi20
            // 한글 재저장 anchor 1020HU 실측). 종전 .max(0) 클램프는 fresh
            // 합성을 lh 그대로(+9px/문단) 팽창시켰다.
            // 음수 ls_value 는 결손 데이터 — 적용 금지. 0% 는 한컴이 그대로 적용한다
            // (줄 간격 = −줄 높이, HWPX 표본 13줄 전부).
            // 한컴은 1/1800인치 격자로 계산한다: 줄 높이를 4 HU 로 내린 뒤 4 HU 단위로
            // 반올림한다 — 4·round_half_away(floor4(lh)·(pct−100)/400) (오라클 L1, 스윕
            // 115%@10pt 피치 11.52pt 와도 일치).
            if ls_value >= 0.0 {
                let lh4 = floor_to_hancom_grid(line_height_hwp) as f64;
                4 * round_half_away(lh4 * (ls_value - 100.0) / 400.0)
            } else {
                0
            }
        }
        LineSpacingType::Fixed => {
            // ls_value = 고정 줄 피치 (px, resolver가 HWPUNIT→px 변환 완료)
            // line_spacing = 고정값 - line_height
            // 한컴은 글자 크기보다 작은 고정값도 그대로 쓴다 — 줄이 겹친다 (스윕 FIXED
            // 5pt@16pt 피치 5.01, 20pt 줄 뒤 16pt 고정 피치 7.56). 음수 간격을 허용한다.
            // ls_value<=0 은 결손 데이터 — 음수 적용 금지 (Percent 와 같은 규약).
            let fixed_hwp = px_to_hwpunit_round(ls_value, dpi);
            if fixed_hwp > 0 {
                fixed_hwp - line_height_hwp
            } else {
                0
            }
        }
        LineSpacingType::SpaceOnly => {
            // ls_value = 줄 사이 추가 간격만 (px)
            px_to_hwpunit_round(ls_value, dpi)
        }
        LineSpacingType::Minimum => {
            // 최소값: 콘텐츠가 최소값보다 크면 추가 간격 없음
            let min_hwp = px_to_hwpunit_round(ls_value, dpi);
            (min_hwp - line_height_hwp).max(0)
        }
    }
}

fn ruby_control_metrics(
    para: &Paragraph,
    ci: usize,
    styles: &ResolvedStyleSet,
    dpi: f64,
) -> Option<InlineControlMetricsHwp> {
    let r = super::super::ruby::prepare(para, ci, styles, dpi)?;
    Some(InlineControlMetricsHwp {
        width: super::super::px_to_hwpunit_round(r.main_width, dpi),
        height: r.height_hu,
        baseline: r.baseline_hu,
    })
}

#[cfg(test)]
mod hancom_break_rule_tests {
    //! 한컴 줄 나눔 규칙 (합성 스윕 /tmp/rhwp-parity-top20/sweep FINDINGS #2~#10).
    use super::*;
    use crate::renderer::style_resolver::{ResolvedCharStyle, ResolvedParaStyle};

    fn styles(font_family: &str, font_size: f64, letter_spacing: f64) -> ResolvedStyleSet {
        ResolvedStyleSet {
            char_styles: vec![ResolvedCharStyle {
                font_family: font_family.to_string(),
                font_families: vec![font_family.to_string(); 7],
                font_size,
                ratio: 1.0,
                letter_spacing,
                ..Default::default()
            }],
            para_styles: vec![ResolvedParaStyle::default()],
            ..Default::default()
        }
    }

    fn tokens(text: &str, st: &ResolvedStyleSet, ebu: u8, kbu: u8) -> (Vec<char>, Vec<BreakToken>) {
        let chars: Vec<char> = text.chars().collect();
        let offsets: Vec<u32> = (0..chars.len() as u32).collect();
        let shapes = vec![CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        }];
        let toks = tokenize_paragraph(&chars, &offsets, &shapes, st, ebu, kbu);
        (chars, toks)
    }

    fn text_width(tok: &BreakToken) -> f64 {
        match tok {
            BreakToken::Text { width, .. } => *width,
            _ => 0.0,
        }
    }

    #[test]
    fn integer_line_budget_accepts_equality_without_extra_width() {
        let chars: Vec<char> = "가나다라".chars().collect();
        let toks: Vec<BreakToken> = chars
            .iter()
            .enumerate()
            .map(|(i, _)| BreakToken::Text {
                start_idx: i,
                end_idx: i + 1,
                width: 10.0,
                max_font_size: 16.0,
                char_widths: vec![10.0],
                trailing_spacing: 0.0,
                char_spacings: vec![],
            })
            .collect();
        // 10px 글자 세 개는 정확히 2250 HU다. 1 HU라도 부족하면 세 번째 글자를 넘긴다.
        for delta_hwp in -2..=2 {
            let width = f64::from(2250 + delta_hwp) / 75.0;
            let lines = fill_lines(&toks, &chars, width, 0.0, (0.0, 0.0), None, 1, 0, 0, None);
            assert_eq!(lines[0].end_idx, if delta_hwp < 0 { 2 } else { 3 });
        }
    }

    #[test]
    fn ascii_angles_keep_brackets_with_adjacent_text() {
        let st = styles("함초롬돋움", 16.0, 0.0);
        for (text, prefix, expected_first) in [
            ("가나다<보기>라마바", "가나다<", "가나다"),
            ("가나다<보기>라마바", "가나다<보기", "가나다<보"),
            ("가나다(보기)라마바", "가나다(", "가나다"),
            ("가나다(보기)라마바", "가나다(보기", "가나다(보"),
        ] {
            let (chars, toks) = tokens(text, &st, 0, 1);
            let (_, prefix_toks) = tokens(prefix, &st, 0, 1);
            let width = prefix_toks.iter().map(text_width).sum::<f64>() + 0.1;
            let lines = fill_lines(&toks, &chars, width, 0.0, (0.0, 0.0), None, 1, 0, 0, None);
            let first: String = chars[lines[0].start_idx..lines[0].end_idx].iter().collect();
            assert_eq!(first, expected_first, "{text}, width={width}");
        }

        // 공백은 관계 연산자 앞에서도 명시적인 줄 나눔 지점이다.
        for text in ["가나다 > 라마바", "가나다 < 라마바"] {
            let (chars, toks) = tokens(text, &st, 0, 1);
            let width = toks
                .iter()
                .take(4)
                .map(|token| match token {
                    BreakToken::Text { width, .. } | BreakToken::Space { width, .. } => *width,
                    _ => 0.0,
                })
                .sum::<f64>()
                + 0.1;
            let lines = fill_lines(&toks, &chars, width, 0.0, (0.0, 0.0), None, 1, 0, 0, None);
            assert_eq!(lines[1].start_idx, 4, "{text}");
        }
    }
    #[test]
    fn fixed_width_space_breaks_words_without_condensing() {
        let st = styles("", 16.0, 0.0);
        for (separator, next_start) in [(' ', 6), ('\u{2007}', 6), ('\u{00a0}', 3), ('\u{202f}', 3)]
        {
            let text = format!("가나 다라{separator}마바");
            let (chars, toks) = tokens(&text, &st, 0, 0);
            let lines = fill_lines(&toks, &chars, 90.0, 0.0, (0.0, 0.0), None, 0, 0, 0, None);
            assert_eq!(lines.len(), 2, "{text:?}");
            assert_eq!(lines[1].start_idx, next_start, "{text:?}");
        }

        let (chars, toks) = tokens("가나\u{2007}다라\u{2007}마바", &st, 0, 0);
        for condense in [0, 25, 50, 75] {
            let lines = fill_lines(
                &toks,
                &chars,
                102.0,
                0.0,
                (0.0, 0.0),
                None,
                0,
                0,
                condense,
                None,
            );
            assert_eq!(lines.len(), 2, "condense={condense}");
            assert_eq!(lines[1].start_idx, 6);
        }
        assert_eq!(recalc_space_savings_hwp(&toks, toks.len(), 0, 75), 0);

        // 넓은 줄의 고정 공백 폭은 줄 나눔 여부나 압축 설정에 좌우되지 않는다.
        let space_widths: Vec<f64> = toks
            .iter()
            .filter_map(|token| match token {
                BreakToken::Space { width, .. } => Some(*width),
                _ => None,
            })
            .collect();
        assert_eq!(space_widths, [4.0, 4.0]);
        let (chars, toks) = tokens("가나 다라 마바", &st, 0, 0);
        let lines = fill_lines(&toks, &chars, 102.0, 0.0, (0.0, 0.0), None, 0, 0, 75, None);
        assert_eq!(lines.len(), 1);
    }

    #[test]
    fn overflowing_spaces_keep_their_advance_before_the_next_word() {
        let st = styles("", 16.0, 0.0);
        for (spaces, width, starts) in [
            ("\u{2007}", 100.0 / 3.0, vec![0, 3]),
            ("\u{2007}\u{2007}\u{2007}", 100.0 / 3.0, vec![0, 3, 5]),
            ("\u{2007}\u{2007}\u{2007}", 40.0, vec![0, 4]),
            ("\u{2007}\u{2007}\u{2007}", 48.0, vec![0, 5]),
            ("       ", 100.0 / 3.0, vec![0, 4, 9]),
            ("   ", 40.0, vec![0, 4]),
            (" \u{2007}", 40.0, vec![0, 3]),
            ("\u{2007} ", 40.0, vec![0, 4]),
            ("\u{2007}\u{2007} ", 40.0, vec![0, 4]),
        ] {
            let text = format!("가나{spaces}다라");
            let (chars, toks) = tokens(&text, &st, 0, 0);
            let lines = fill_lines(&toks, &chars, width, 0.0, (0.0, 0.0), None, 0, 0, 0, None);
            assert_eq!(
                lines.iter().map(|line| line.start_idx).collect::<Vec<_>>(),
                starts,
                "{text:?}, width={width}"
            );
        }
    }

    #[test]
    fn condensation_requires_a_space_after_content() {
        let st = styles("", 16.0, 0.0);
        for condense in [25, 50, 75] {
            for (text, blank_line, hard_break) in [
                ("   가나다라", true, false),
                ("가   나다라", false, false),
                ("   가나 다라", false, false),
                ("\n   가나다라", true, true),
            ] {
                let (chars, toks) = tokens(text, &st, 0, 0);
                let mut natural = 0.0;
                let mut spaces = 0.0;
                for token in &toks {
                    match token {
                        BreakToken::Text { width, .. } => natural += width,
                        BreakToken::Space { width, .. } => {
                            natural += width;
                            spaces += width;
                        }
                        _ => {}
                    }
                }
                let width = natural - spaces * f64::from(condense) / 200.0;
                let lines = fill_lines(
                    &toks,
                    &chars,
                    width,
                    0.0,
                    (0.0, 0.0),
                    None,
                    0,
                    0,
                    condense,
                    None,
                );
                let first = usize::from(hard_break);
                assert_eq!(lines.len(), first + 1 + usize::from(blank_line), "{text:?}");
                if blank_line {
                    assert_eq!(lines[first + 1].start_idx, first + 3, "{text:?}");
                }
            }
        }
    }

    #[test]
    fn hard_break_character_size_contributes_to_line_metrics() {
        let cases: &[(&str, &[(u32, &str)], &[i32])] = &[
            ("leading 9pt", &[(0, "\nTAIL")], &[900, 900]),
            ("leading 11pt", &[(1, "\nTAIL")], &[1100, 1100]),
            ("consecutive", &[(1, "FIRST\n\nTAIL")], &[1100, 1100, 1100]),
            ("trailing", &[(1, "FIRST\n")], &[1100, 1100]),
            (
                "larger break",
                &[(0, "FIRST"), (2, "\n"), (0, "TAIL")],
                &[1600, 900],
            ),
            (
                "smaller break",
                &[(2, "FIRST"), (0, "\n"), (2, "TAIL")],
                &[1600, 1600],
            ),
            (
                "mixed empty lines",
                &[(0, "\n"), (1, "\n"), (2, "\n"), (0, "TAIL")],
                &[900, 1100, 1600, 900],
            ),
        ];
        for squeeze in [false, true] {
            let mut st = styles("맑은 고딕", 12.0, 0.0);
            for points in [11.0, 16.0] {
                let mut cs = st.char_styles[0].clone();
                cs.font_size = points * 96.0 / 72.0;
                st.char_styles.push(cs);
            }
            st.para_styles[0].line_spacing = 130.0;
            st.para_styles[0].line_wrap_squeeze = squeeze;
            for &(name, runs, heights) in cases {
                let mut para = Paragraph::default();
                for &(style_id, text) in runs {
                    para.char_shapes.push(CharShapeRef {
                        start_pos: para.text.len() as u32,
                        char_shape_id: style_id,
                    });
                    para.text.push_str(text);
                }
                para.char_count = para.text.len() as u32;
                para.char_offsets = (0..para.char_count).collect();
                reflow_line_segs(&mut para, 300.0, &st, 96.0);
                assert_eq!(
                    para.line_segs
                        .iter()
                        .map(|line| line.line_height)
                        .collect::<Vec<_>>(),
                    heights,
                    "{name}, squeeze={squeeze}"
                );
                let mut y = 0;
                for line in &para.line_segs {
                    let gap = match line.line_height {
                        900 => 272,
                        1100 => 332,
                        1600 => 480,
                        height => panic!("unexpected line height: {height}"),
                    };
                    assert_eq!((line.vertical_pos, line.line_spacing), (y, gap), "{name}");
                    y += line.line_height + gap;
                }
            }
        }
    }

    #[test]
    fn footnote_reflow_reserves_formatted_marker_without_letter_spacing() {
        use crate::model::control::{AutoNumber, AutoNumberType};

        for spacing in [-5.0, 0.0, 5.0] {
            let mut st = styles("함초롬바탕", 16.0, spacing);
            let mut marker_style = st.char_styles[0].clone();
            marker_style.letter_spacing = 0.0;
            st.char_styles.push(marker_style);
            st.para_styles[0].korean_break_unit = 1;
            let body = " 가나 다라 마바 사아 자차 카타 파하";
            for (assigned, format, prefix, suffix, marker) in [
                (1, 0, '\0', ')', "1)"),
                (12, 0, '\0', ')', "12)"),
                (123, 0, '[', ']', "[123]"),
                (12, 2, '\0', '.', "XII."),
            ] {
                for width in [64.0, 100.0, 160.0] {
                    let note_text = format!(" {body}");
                    let mut note = Paragraph {
                        text: note_text.clone(),
                        char_count: note_text.chars().count() as u32 + 7,
                        char_offsets: std::iter::once(0)
                            .chain(8..8 + body.chars().count() as u32)
                            .collect(),
                        char_shapes: vec![CharShapeRef {
                            start_pos: 0,
                            char_shape_id: 0,
                        }],
                        controls: vec![Control::AutoNumber(AutoNumber {
                            number_type: AutoNumberType::Footnote,
                            number: 1,
                            assigned_number: assigned,
                            format,
                            prefix_char: prefix,
                            suffix_char: suffix,
                            ..Default::default()
                        })],
                        ..Default::default()
                    };
                    let literal_text = format!("{marker}{body}");
                    let mut literal = Paragraph {
                        char_offsets: (0..literal_text.chars().count() as u32).collect(),
                        char_count: literal_text.chars().count() as u32,
                        text: literal_text,
                        char_shapes: vec![
                            CharShapeRef {
                                start_pos: 0,
                                char_shape_id: 1,
                            },
                            CharShapeRef {
                                start_pos: marker.len() as u32,
                                char_shape_id: 0,
                            },
                        ],
                        ..Default::default()
                    };
                    reflow_line_segs(&mut note, width, &st, 96.0);
                    reflow_line_segs(&mut literal, width, &st, 96.0);
                    let body_breaks = |p: &Paragraph, prefix_len: u32| {
                        p.line_segs
                            .iter()
                            .skip(1)
                            .map(|line| line.text_start.saturating_sub(prefix_len))
                            .collect::<Vec<_>>()
                    };
                    assert_eq!(
                        body_breaks(&note, 8),
                        body_breaks(&literal, marker.len() as u32),
                        "spacing={spacing}, marker={marker}, width={width}"
                    );
                }
            }
        }
    }

    #[test]
    fn footnote_width_reservation_preserves_unrelated_auto_numbers() {
        use crate::model::control::{AutoNumber, AutoNumberType};
        let st = styles("함초롬바탕", 16.0, -5.0);
        for kind in [
            AutoNumberType::Table,
            AutoNumberType::Picture,
            AutoNumberType::Equation,
            AutoNumberType::Endnote,
            AutoNumberType::Page,
            AutoNumberType::TotalPage,
        ] {
            let para = Paragraph {
                text: " 가나".into(),
                char_offsets: vec![0, 8, 9],
                controls: vec![Control::AutoNumber(AutoNumber {
                    number_type: kind,
                    assigned_number: 123,
                    suffix_char: ')',
                    ..Default::default()
                })],
                ..Default::default()
            };
            let (_, mut toks) = tokens(&para.text, &st, 0, 1);
            let before = format!("{toks:?}");
            measure_footnote_number_tokens(&mut toks, &para, &st);
            assert_eq!(format!("{toks:?}"), before, "{kind:?}");
        }
    }

    #[test]
    fn wide_symbols_do_not_separate_unspaced_latin_words() {
        let st = styles("맑은 고딕", 16.0, 0.0);
        // 한컴 12pt / 57.8pt 탐침: 기호 뒤도 같은 어절이므로 첫 줄을
        // 채운 뒤 강제 분할한다. 숫자와 영문에 같은 규칙을 적용한다.
        for (text, expected) in [
            ("(△12,428.3)", vec!["(△12,428.", "3)"]),
            ("(△ABCDEFG)", vec!["(△ABCDE", "FG)"]),
            ("△△1234567", vec!["△△12345", "67"]),
            ("ABC△DEFGHI", vec!["ABC△DEF", "GHI"]),
            ("△1234567", vec!["△123456", "7"]),
            ("가ABCDEFG", vec!["가ABCDEF", "G"]),
            ("△ 1234567", vec!["△", "1234567"]),
            ("aa bbbbbbbbbbbb", vec!["aa", "bbbbbbbb", "bbbb"]),
        ] {
            let (chars, toks) = tokens(text, &st, 0, 1);
            let lines = fill_lines(
                &toks,
                &chars,
                5780.0 / 75.0,
                0.0,
                (0.0, 0.0),
                None,
                1,
                0,
                0,
                None,
            );
            let actual: Vec<String> = lines
                .iter()
                .map(|line| chars[line.start_idx..line.end_idx].iter().collect())
                .collect();
            assert_eq!(actual, expected, "{text}");
        }
    }

    #[test]
    fn explicit_tab_stops_determine_line_fit_across_the_following_word() {
        use crate::renderer::TabStop;

        let st = styles("함초롬바탕", 16.0, 0.0);
        let (chars, toks) = tokens("AAAA\tBBBBBB", &st, 0, 1);
        let prefix = text_width(&toks[0]);
        let suffix = text_width(&toks[2]);
        let width = prefix + suffix + 3.0;
        let mut ps = ResolvedParaStyle {
            default_tab_width: prefix + 10.0,
            ..Default::default()
        };
        let layout = |style: &ResolvedParaStyle, available, indent| {
            fill_lines(
                &toks,
                &chars,
                available,
                indent,
                (0.0, 0.0),
                Some(style),
                1,
                0,
                0,
                None,
            )
        };
        assert_eq!(layout(&ps, width, 0.0).len(), 2);
        for (tab_type, position) in [(0, prefix + 2.0), (1, width - 1.0)] {
            ps.tab_stops = vec![TabStop {
                position,
                tab_type,
                fill_type: 0,
            }];
            let lines = layout(&ps, width, 0.0);
            assert_eq!(lines.len(), 1, "kind={tab_type}: {lines:?}");
            assert_eq!(lines[0].end_idx, chars.len());
        }
        ps.margin_left = 20.0;
        ps.tab_stops = vec![TabStop {
            position: prefix + 40.0,
            tab_type: 0,
            fill_type: 0,
        }];
        assert_eq!(layout(&ps, prefix + suffix + 21.0, 10.0).len(), 1);
    }

    #[test]
    fn explicit_tab_stays_on_the_previous_line_when_its_suffix_wraps() {
        use crate::renderer::TabStop;

        let st = styles("함초롬바탕", 16.0, 0.0);
        let (chars, toks) = tokens("AAAA\tBBBBBB", &st, 0, 1);
        let width = text_width(&toks[0]) + text_width(&toks[2]) - 1.0;
        for tab_type in [0, 1] {
            let ps = ResolvedParaStyle {
                default_tab_width: 48.0,
                tab_stops: vec![TabStop {
                    position: width - 1.0,
                    tab_type,
                    fill_type: 0,
                }],
                ..Default::default()
            };
            let lines = fill_lines(
                &toks,
                &chars,
                width,
                0.0,
                (0.0, 0.0),
                Some(&ps),
                1,
                0,
                0,
                None,
            );
            assert_eq!(lines.len(), 2, "kind={tab_type}: {lines:?}");
            assert_eq!((lines[0].end_idx, lines[1].start_idx), (5, 5));
            assert_eq!(chars[lines[1].start_idx], 'B');
        }
    }

    #[test]
    fn right_aligned_tabs_use_suffix_ink_width_across_style_and_group_boundaries() {
        use crate::renderer::TabStop;

        for spacing in [-1.6, 0.0, 1.6] {
            for mixed in [false, true] {
                for two_stops in [false, true] {
                    let mut st = styles("함초롬바탕", 16.0, if mixed { 0.0 } else { spacing });
                    let mut terminal = st.char_styles[0].clone();
                    terminal.letter_spacing = spacing;
                    st.char_styles.push(terminal);
                    let text = if two_stops {
                        "A\tTITLE]\tEND]\nNEXT"
                    } else {
                        "A\tTITLE]\nNEXT"
                    };
                    let chars: Vec<char> = text.chars().collect();
                    let offsets: Vec<u32> = (0..chars.len() as u32).collect();
                    let mut shapes = vec![CharShapeRef {
                        start_pos: 0,
                        char_shape_id: 0,
                    }];
                    if mixed {
                        for (idx, ch) in chars.iter().enumerate() {
                            if *ch == ']' {
                                shapes.push(CharShapeRef {
                                    start_pos: idx as u32,
                                    char_shape_id: 1,
                                });
                                shapes.push(CharShapeRef {
                                    start_pos: idx as u32 + 1,
                                    char_shape_id: 0,
                                });
                            }
                        }
                    }
                    let toks = tokenize_paragraph(&chars, &offsets, &shapes, &st, 0, 1);
                    let ps = ResolvedParaStyle {
                        auto_tab_right: !two_stops,
                        tab_stops: if two_stops {
                            [180.0, 360.0]
                                .into_iter()
                                .map(|position| TabStop {
                                    position,
                                    tab_type: 1,
                                    fill_type: 0,
                                })
                                .collect()
                        } else {
                            Vec::new()
                        },
                        ..Default::default()
                    };
                    let lines = fill_lines(
                        &toks,
                        &chars,
                        360.0,
                        -16.0,
                        (0.0, 0.0),
                        Some(&ps),
                        1,
                        0,
                        0,
                        None,
                    );
                    assert_eq!(lines.len(), 2, "{spacing}/{mixed}/{two_stops}: {lines:?}");
                    assert_eq!(lines[0].end_idx, text.find('\n').unwrap() + 1);
                    assert_eq!(
                        chars[lines[1].start_idx..].iter().collect::<String>(),
                        "NEXT"
                    );
                }
            }
        }
    }

    #[test]
    fn break_word_latin_splits_inside_word_only_when_set() {
        let st = styles("", 16.0, 0.0);
        let text = "aa bbbbbbbbbbbbbbbb";
        for (ebu, splits) in [(0u8, false), (2u8, true)] {
            let (chars, toks) = tokens(text, &st, ebu, 1);
            let lines = fill_lines(&toks, &chars, 80.0, 0.0, (0.0, 0.0), None, 1, ebu, 0, None);
            assert_eq!(lines[0].end_idx > 3, splits, "ebu={ebu}: {lines:?}");
        }
    }

    #[test]
    fn line_never_starts_with_closing_punctuation() {
        let st = styles("", 16.0, 0.0);
        let (chars, toks) = tokens("가나다라,마", &st, 0, 1);
        let four: f64 = toks.iter().take(4).map(text_width).sum();
        let lines = fill_lines(
            &toks,
            &chars,
            four + 0.1,
            0.0,
            (0.0, 0.0),
            None,
            1,
            0,
            0,
            None,
        );
        // `,` 는 줄 머리에 올 수 없다 — `라,` 가 함께 다음 줄로 간다.
        assert_eq!((lines[0].end_idx, lines[1].start_idx), (3, 3), "{lines:?}");
    }

    #[test]
    fn closing_punctuation_can_end_a_line_before_an_opening_parenthesis() {
        let st = styles("", 16.0, 0.0);
        for closing in ['’', '”', ')', ']', '.', ','] {
            let text = format!("가나다{closing}(라마바)");
            let (chars, toks) = tokens(&text, &st, 0, 1);
            for (fit_chars, expected) in [(4, 2), (5, 4)] {
                let width: f64 = toks.iter().take(fit_chars).map(text_width).sum();
                let lines = fill_lines(
                    &toks,
                    &chars,
                    width + 0.1,
                    0.0,
                    (0.0, 0.0),
                    None,
                    1,
                    0,
                    0,
                    None,
                );
                assert_eq!(
                    (lines[0].end_idx, lines[1].start_idx),
                    (expected, expected),
                    "{text}, fit_chars={fit_chars}: {lines:?}"
                );
            }
        }
    }

    #[test]
    fn hancom_pua_book_brackets_allow_character_boundaries() {
        let st = styles("", 16.0, 0.0);
        for bracket in ['\u{F0854}', '\u{F0855}'] {
            let text = format!("가나다{bracket}ABCD");
            let (chars, toks) = tokens(&text, &st, 0, 1);
            for fit_chars in [3, 4] {
                let width: f64 = toks.iter().take(fit_chars).map(text_width).sum();
                let lines = fill_lines(
                    &toks,
                    &chars,
                    width + 0.1,
                    0.0,
                    (0.0, 0.0),
                    None,
                    1,
                    0,
                    0,
                    None,
                );
                assert_eq!(
                    (lines[0].end_idx, lines[1].start_idx),
                    (fit_chars, fit_chars),
                    "{text}, fit_chars={fit_chars}: {lines:?}"
                );
            }
        }
    }

    #[test]
    fn last_glyph_letter_spacing_is_excluded_from_fit() {
        let st = styles("", 16.0, 1.6);
        let (chars, toks) = tokens("가나다라마", &st, 0, 1);
        let BreakToken::Text {
            trailing_spacing, ..
        } = &toks[3]
        else {
            panic!("text token");
        };
        assert!(*trailing_spacing > 0.0);
        let four: f64 = toks.iter().take(4).map(text_width).sum();
        // 4글자 자연 폭보다 좁지만 마지막 글자 자간을 빼면 들어가는 폭.
        let lines = fill_lines(
            &toks,
            &chars,
            four - trailing_spacing / 2.0,
            0.0,
            (0.0, 0.0),
            None,
            1,
            0,
            0,
            None,
        );
        assert_eq!(lines[0].end_idx, 4, "{lines:?}");
    }

    #[test]
    fn forced_word_split_uses_real_glyph_widths() {
        let st = styles("함초롬바탕", 16.0, 0.0);
        let text: String = "가".repeat(60);
        let (chars, toks) = tokens(&text, &st, 0, 0);
        let BreakToken::Text { char_widths, .. } = &toks[0] else {
            panic!("text token");
        };
        assert_eq!(char_widths.len(), 60);
        let fit43: f64 = char_widths
            .iter()
            .take(43)
            .map(|w| to_hwp(*w) as f64 / 75.0)
            .sum();
        let lines = fill_lines(
            &toks,
            &chars,
            fit43 + 0.05,
            0.0,
            (0.0, 0.0),
            None,
            0,
            0,
            0,
            None,
        );
        assert_eq!(lines[0].end_idx, 43, "{lines:?}");
    }

    #[test]
    fn auto_spacing_adds_quarter_em_on_the_hancom_grid() {
        // 10pt: 크기 단위 250 → 간격 63단위 = 252 HWPUNIT (2.52pt)
        assert_eq!(
            (auto_spacing_gap_px(1000.0 / 75.0) * 75.0).round() as i32,
            252
        );
        let st = styles("", 16.0, 0.0);
        let chars: Vec<char> = "가A1".chars().collect();
        let offsets: Vec<u32> = (0..3).collect();
        let shapes = vec![CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        }];
        let plain = tokenize_paragraph_with_controls(
            &chars,
            &offsets,
            &shapes,
            &st,
            2,
            1,
            AutoSpacing::default(),
            &[],
        );
        let spaced = tokenize_paragraph_with_controls(
            &chars,
            &offsets,
            &shapes,
            &st,
            2,
            1,
            AutoSpacing {
                eng: true,
                num: false,
            },
            &[],
        );
        let gap = text_width(&spaced[0]) - text_width(&plain[0]);
        assert!((gap - auto_spacing_gap_px(16.0)).abs() < 1e-9);
        // 영문↔숫자 경계에는 간격이 없다.
        assert_eq!(text_width(&spaced[1]), text_width(&plain[1]));
    }

    #[test]
    fn fixed_line_spacing_below_font_size_is_used_as_is() {
        let dpi = 96.0;
        let fixed_500_px = hwpunit_to_px(500, dpi);
        assert_eq!(
            compute_line_spacing_hwp(LineSpacingType::Fixed, fixed_500_px, 1000, dpi),
            -500
        );
    }

    #[test]
    fn small_hangul_line_height_follows_font_size() {
        let st = styles("", 8.0, 0.0); // 6pt
        let (_, toks) = tokens("가나", &st, 0, 1);
        let BreakToken::Text { max_font_size, .. } = &toks[0] else {
            panic!("text token");
        };
        assert_eq!(*max_font_size, 8.0);
    }
}

#[cfg(test)]
mod lineseg_oracle_rule_tests {
    //! 한컴 저장 LINE_SEG 규칙 (lineseg 오라클, /tmp/rhwp-parity-top20/lineseg).
    use super::*;
    use crate::model::style::HeadType;
    use crate::renderer::style_resolver::{ResolvedCharStyle, ResolvedParaStyle};

    #[test]
    fn character_borders_expand_pitch_without_moving_the_text_baseline() {
        use crate::model::style::{BorderLine, BorderLineType};
        use crate::renderer::style_resolver::ResolvedBorderStyle;
        for (edges, height, text_height, pitch) in [
            (vec![], 1_300, 1_300, 2_080),
            (vec![2], 1_300, 1_498, 2_394),
            (vec![3], 1_498, 1_498, 2_394),
            (vec![2, 3], 1_498, 1_696, 2_712),
            (vec![0, 1], 1_300, 1_300, 2_080),
            (vec![0, 1, 2, 3], 1_498, 1_696, 2_712),
        ] {
            let mut border = ResolvedBorderStyle {
                borders: [BorderLine {
                    line_type: BorderLineType::None,
                    width: 9,
                    color: 0,
                }; 4],
                ..Default::default()
            };
            for edge in edges {
                border.borders[edge].line_type = BorderLineType::Solid;
            }
            let mut styles = ResolvedStyleSet {
                char_styles: vec![
                    ResolvedCharStyle {
                        font_size: 1_300.0 / 75.0,
                        border_fill_id: 1,
                        ..Default::default()
                    },
                    ResolvedCharStyle {
                        font_size: 1_300.0 / 75.0,
                        ..Default::default()
                    },
                ],
                para_styles: vec![ResolvedParaStyle {
                    line_spacing: 160.0,
                    ..Default::default()
                }],
                border_styles: vec![border],
                ..Default::default()
            };
            let paragraph = || Paragraph {
                text: "가\n나".into(),
                char_offsets: vec![0, 1, 2],
                char_shapes: vec![
                    CharShapeRef {
                        start_pos: 0,
                        char_shape_id: 0,
                    },
                    CharShapeRef {
                        start_pos: 2,
                        char_shape_id: 1,
                    },
                ],
                ..Default::default()
            };
            for (kind, value, expected_pitch) in [
                (LineSpacingType::Percent, 160.0, pitch),
                (LineSpacingType::Fixed, 500.0 / 75.0, 500),
                (LineSpacingType::Fixed, 2_600.0 / 75.0, 2_600),
            ] {
                styles.para_styles[0].line_spacing_type = kind;
                styles.para_styles[0].line_spacing = value;
                let mut para = paragraph();
                reflow_line_segs(&mut para, 300.0, &styles, 96.0);
                assert_eq!(para.line_segs.len(), 2);
                let first = &para.line_segs[0];
                assert_eq!(first.line_height, height);
                assert_eq!(first.text_height, text_height);
                assert_eq!(first.baseline_distance, 1_105);
                assert_eq!(first.line_spacing, expected_pitch - text_height);
                assert_eq!(para.line_segs[1].vertical_pos, expected_pitch);
                assert_eq!(para.line_segs[1].line_height, 1_300);
            }
        }
    }

    #[test]
    fn percent_line_spacing_uses_the_4hu_grid() {
        let pct = |v: f64, lh: i32| compute_line_spacing_hwp(LineSpacingType::Percent, v, lh, 96.0);
        assert_eq!(pct(130.0, 900), 272);
        assert_eq!(pct(50.0, 1500), -752);
        assert_eq!(pct(115.0, 1000), 152);
        assert_eq!(font_size_to_line_height(1300.0 / 75.0, 96.0), 1300);
    }

    #[test]
    fn baseline_follows_paragraph_vertical_align() {
        assert_eq!(baseline_for_vertical_align(1150, 0), 978);
        assert_eq!(baseline_for_vertical_align(900, 1), 0);
        assert_eq!(baseline_for_vertical_align(900, 2), 450);
        assert_eq!(baseline_for_vertical_align(900, 3), 900);
    }

    #[test]
    fn column_start_and_indent_head_flags() {
        let styles = |indent: f64, head: HeadType| ResolvedStyleSet {
            char_styles: vec![ResolvedCharStyle {
                font_size: 16.0,
                ratio: 1.0,
                ..Default::default()
            }],
            para_styles: vec![ResolvedParaStyle {
                margin_left: 20.0,
                indent,
                head_type: head,
                ..Default::default()
            }],
            ..Default::default()
        };
        let para = || Paragraph {
            text: "가나다라마바사아자차카타파하".repeat(4),
            char_offsets: (0..56).collect(),
            char_shapes: vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: 0,
            }],
            ..Default::default()
        };
        let ind = LineSeg::TAG_INDENTATION;
        let head = LineSeg::TAG_PARAGRAPH_HEAD;
        for (indent, head_type, line0, rest) in [
            (10.0, HeadType::None, ind, 0),
            (-10.0, HeadType::None, 0, ind),
            (0.0, HeadType::Bullet, head, ind),
        ] {
            let mut p = para();
            reflow_line_segs(&mut p, 200.0, &styles(indent, head_type), 96.0);
            assert!(p.line_segs.len() > 1);
            assert!(p.line_segs.iter().all(|s| s.column_start == 1500));
            let bits = |s: &LineSeg| s.tag & (ind | head);
            assert_eq!(bits(&p.line_segs[0]), line0, "{indent} {head_type:?}");
            assert!(p.line_segs[1..].iter().all(|s| bits(s) == rest));
        }
    }

    #[test]
    fn inline_object_line_takes_max_height_and_max_baseline() {
        let mut seg = LineSeg {
            line_height: 900,
            text_height: 900,
            baseline_distance: 765,
            ..Default::default()
        };
        apply_inline_control_line_metrics(
            &mut seg,
            InlineControlMetricsHwp {
                width: 450,
                height: 900,
                baseline: 774,
            },
        );
        assert_eq!((seg.line_height, seg.baseline_distance), (900, 774));
    }

    #[test]
    fn next_paragraph_starts_below_top_and_bottom_table_of_previous() {
        use crate::model::shape::{TextWrap, VertRelTo};
        use crate::model::table::Table;
        let mut table = Table::default();
        table.common.text_wrap = TextWrap::TopAndBottom;
        table.common.vert_rel_to = VertRelTo::Para;
        table.common.vertical_offset = 261;
        table.common.height = 11536;
        table.outer_margin_top = 141;
        table.outer_margin_bottom = 141;
        let seg = |vpos: i32| LineSeg {
            vertical_pos: vpos,
            line_height: 1000,
            text_height: 1000,
            ..Default::default()
        };
        let mut paras = vec![
            Paragraph {
                controls: vec![Control::Table(Box::new(table))],
                line_segs: vec![seg(35093)],
                ..Default::default()
            },
            Paragraph {
                line_segs: vec![LineSeg {
                    tag: LineSeg::TAG_IMPLEMENTATION_PROPERTY,
                    ..seg(0)
                }],
                ..Default::default()
            },
        ];
        let styles = ResolvedStyleSet {
            para_styles: vec![ResolvedParaStyle::default()],
            ..Default::default()
        };
        recalculate_section_vpos(&mut paras, 1, None, None, &styles, 96.0, false);
        assert_eq!(paras[1].line_segs[0].vertical_pos, 47172);
    }
}

#[cfg(test)]
mod mac_flow_rule_tests {
    //! macOS 한컴이 줄 정보 없는 문서를 스스로 조판한 규칙 (lso-breaking3 flow/스윕).
    use super::*;
    use crate::renderer::style_resolver::{ResolvedCharStyle, ResolvedParaStyle};

    fn styles() -> ResolvedStyleSet {
        ResolvedStyleSet {
            char_styles: vec![ResolvedCharStyle {
                font_size: 16.0,
                ratio: 1.0,
                ..Default::default()
            }],
            para_styles: vec![ResolvedParaStyle::default()],
            ..Default::default()
        }
    }

    #[test]
    fn full_symbol_prefix_leaves_no_room_for_the_next_digit() {
        // 기호로 줄을 채우면 첫 숫자가 다음 줄에서 시작한다.
        let st = styles();
        let (chars, toks) = {
            let chars: Vec<char> = "△△12345".chars().collect();
            let offsets: Vec<u32> = (0..chars.len() as u32).collect();
            let shapes = vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: 0,
            }];
            let toks = tokenize_paragraph(&chars, &offsets, &shapes, &st, 0, 1);
            (chars, toks)
        };
        let two: f64 = toks
            .iter()
            .take(2)
            .map(|t| match t {
                BreakToken::Text { width, .. } => *width,
                _ => 0.0,
            })
            .sum();
        let lines = fill_lines(
            &toks,
            &chars,
            two + 1.0,
            0.0,
            (0.0, 0.0),
            None,
            1,
            0,
            0,
            None,
        );
        assert_eq!(lines[0].end_idx, 2, "{lines:?}");
    }

    #[test]
    fn head_reserve_narrows_first_and_continuation_lines() {
        let chars: Vec<char> = "가".repeat(10).chars().collect();
        let offsets: Vec<u32> = (0..10).collect();
        let shapes = vec![CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        }];
        let toks = tokenize_paragraph(&chars, &offsets, &shapes, &styles(), 0, 1);
        let w: f64 = match &toks[0] {
            BreakToken::Text { width, .. } => *width,
            _ => 0.0,
        };
        let plain = fill_lines(
            &toks,
            &chars,
            w * 5.0 + 0.5,
            0.0,
            (0.0, 0.0),
            None,
            1,
            0,
            0,
            None,
        );
        let headed = fill_lines(
            &toks,
            &chars,
            w * 5.0 + 0.5,
            0.0,
            (w, w),
            None,
            1,
            0,
            0,
            None,
        );
        assert_eq!(plain[0].end_idx, 5);
        assert_eq!(headed[0].end_idx, 4);
        assert_eq!(headed[1].end_idx, 8);
    }
}

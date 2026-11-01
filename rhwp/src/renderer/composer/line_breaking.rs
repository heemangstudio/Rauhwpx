//! 줄 나눔 엔진 (Line Breaking Engine)
//!
//! 문단 텍스트를 토큰화하고 줄 나눔을 수행한다.
//! 한글 어절/글자, 영어 단어/하이픈, CJK 개별 분할을 지원한다.

use super::{
    carried_lang_category, find_active_char_shape, is_lang_neutral, is_occurrence_lang_neutral,
    is_word_break_neutral, literal_space_lang_category, occurrence_lang_category,
};
use crate::model::control::Control;
use crate::model::paragraph::{CharShapeRef, LineSeg, Paragraph, SpecialSpaceOrigin};
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
        /// 자간 적용 전 폭(px). 문단 공백 압축률은 이 폭을 기준으로 적용한다.
        base_width: f64,
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
    /// true 이면 개체 줄에 뒤따르는 토큰이 넘칠 때 토큰 통째를 다음 줄로 보낸다.
    /// 수식(false)은 텍스트와 같은 줄 안에서도 독립된 토큰 경계를 가진다.
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
    /// 실제 첫 토큰. 같은 scalar 위치의 제어 슬롯도 서로 다른 줄에 속할 수 있다.
    start_token_idx: usize,
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
    special_space_origins: &[SpecialSpaceOrigin],
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
        special_space_origins,
        &cluster,
        start,
        char_offsets,
        char_shapes,
        styles,
        default_lang,
    );
    let mut max_font_size = 0.0f64;
    let mut legacy_lang = default_lang;
    for (offset, ch) in text_chars[start..end].iter().copied().enumerate() {
        let index = start + offset;
        let utf16_pos = char_offsets.get(index).copied().unwrap_or(index as u32);
        let style_id = find_active_char_shape(char_shapes, utf16_pos);
        if !is_occurrence_lang_neutral(ch, index, special_space_origins, styles.font_metrics_policy)
        {
            legacy_lang =
                carried_lang_category(ch, index, special_space_origins, styles.font_metrics_policy);
        }
        // 한컴은 6~8.5pt 한글 줄도 글자 크기 그대로 줄 높이를 잡는다 (스윕 6pt@160% =
        // 9.60pt 피치). 종전 9pt(12px) 하한은 작은 글씨 줄을 14.40pt 로 부풀렸다.
        let fs = style_font_size(styles, style_id);
        max_font_size = max_font_size.max(if fs > 0.0 { fs } else { 12.0 });
    }
    (width, max_font_size, legacy_lang)
}

/// 글자(grapheme cluster)별 폭을 클러스터 단독 측정으로 구한다 (선형 시간).
/// 한글 어절은 커닝이 없어 접두 차분(measure_grapheme_advances)과 같은 값을 준다.
fn measure_grapheme_widths_linear(
    special_space_origins: &[SpecialSpaceOrigin],
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
    let mut legacy_lang = default_lang;
    let mut index = start;
    while index < end {
        let cluster_end = grapheme_ends[index].min(end).max(index + 1);
        let ch = text_chars[index];
        if !is_occurrence_lang_neutral(ch, index, special_space_origins, styles.font_metrics_policy)
        {
            legacy_lang =
                carried_lang_category(ch, index, special_space_origins, styles.font_metrics_policy);
            current_lang = occurrence_lang_category(
                ch,
                index,
                special_space_origins,
                styles.font_metrics_policy,
            );
        } else {
            current_lang = legacy_lang;
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
            let cluster_style =
                ts.clone()
                    .with_origin_range(special_space_origins, index, cluster_end);
            widths[index - start] = estimate_text_width_unrounded(&cluster, &cluster_style);
        }
        index = cluster_end;
    }
    widths
}

fn measure_grapheme_advances(
    special_space_origins: &[SpecialSpaceOrigin],
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
            special_space_origins,
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

/// 줄 끝 자간 슬롯을 한 번 계산한다. A0의 활성 중립 구간 밖은 기존 64자 제한이다.
fn trailing_lang_categories(
    text_chars: &[char],
    origins: &[SpecialSpaceOrigin],
    policy: crate::model::provenance::FontMetricsPolicy,
) -> Vec<usize> {
    let mut literal_slots = vec![None; text_chars.len()];
    if policy == crate::model::provenance::FontMetricsPolicy::HcrDeclared {
        for origin in origins {
            if origin.origin == crate::model::paragraph::SpecialSpaceOriginKind::Literal {
                if let Some(ch) = text_chars.get(origin.char_idx) {
                    literal_slots[origin.char_idx] = match ch {
                        '\u{00a0}' => Some(1),
                        '\u{2007}' => Some(5),
                        _ => None,
                    };
                }
            }
        }
    }
    let mut nearest = None;
    let mut active_a0 = false;
    text_chars
        .iter()
        .copied()
        .enumerate()
        .map(|(scalar, ch)| {
            if ch == '\u{00a0}' && literal_slots[scalar] == Some(1) {
                active_a0 = true;
                1
            } else if !is_lang_neutral(ch) {
                active_a0 = false;
                let legacy = detect_lang_category(ch);
                nearest = Some((scalar, legacy));
                literal_slots[scalar].unwrap_or(legacy)
            } else if active_a0 {
                1
            } else {
                nearest
                    .filter(|(index, _)| scalar - index < 64)
                    .map(|(_, lang)| lang)
                    .unwrap_or(0)
            }
        })
        .collect()
}

/// grapheme cluster [cs, ce) 가 자간으로 더하는 폭(px). 자간이 없으면 0.
fn cluster_letter_spacing_px(
    special_space_origins: &[SpecialSpaceOrigin],
    text_chars: &[char],
    cs: usize,
    ce: usize,
    lang: usize,
    char_offsets: &[u32],
    char_shapes: &[CharShapeRef],
    styles: &ResolvedStyleSet,
) -> f64 {
    let style_id = char_style_id_at(char_offsets, char_shapes, cs);
    let Some(char_style) = styles.char_styles.get(style_id as usize) else {
        return 0.0;
    };
    let cluster: String = text_chars[cs..ce].iter().collect();
    let mut ts = resolved_to_text_style(styles, style_id, lang).with_origin_range(
        special_space_origins,
        cs,
        ce,
    );
    let has_raw31_tracking = cluster.chars().enumerate().any(|(scalar, ch)| {
        ts.raw31_tracking_percent(scalar, ch)
            .is_some_and(|v| v != 0)
    });
    if !has_raw31_tracking
        && (char_style.letter_spacing == 0.0
            && char_style.letter_spacings.iter().all(|v| *v == 0.0)
            || char_style.letter_spacing_for_lang(lang) == 0.0)
    {
        return 0.0;
    }
    let with_spacing = estimate_text_width_unrounded(&cluster, &ts);
    ts.zero_tracking();
    with_spacing - estimate_text_width_unrounded(&cluster, &ts)
}

/// 텍스트 토큰마다 줄 끝 판정에서 뺄 폭(마지막 글자 자간)을 기록하고, 자동 간격이
/// 켜진 문단은 한글↔영문/숫자 경계의 간격을 왼쪽 토큰 폭에 더한다. 경계 간격도
/// 줄 끝에서는 맞춤 판정에서 빠지도록 trailing 에 함께 넣는다.
fn annotate_trailing_spacing(
    special_space_origins: &[SpecialSpaceOrigin],
    tokens: &mut [BreakToken],
    text_chars: &[char],
    grapheme_ends: &[usize],
    char_offsets: &[u32],
    char_shapes: &[CharShapeRef],
    styles: &ResolvedStyleSet,
    auto_spacing: AutoSpacing,
) {
    let mut trailing_langs = trailing_lang_categories(
        text_chars,
        special_space_origins,
        styles.font_metrics_policy,
    );
    for (lang, selected) in trailing_langs.iter_mut().zip(super::font_space_lang_slots(
        text_chars
            .iter()
            .copied()
            .enumerate()
            .map(|(scalar, ch)| (ch, char_style_id_at(char_offsets, char_shapes, scalar))),
        styles,
    )) {
        if let Some(selected) = selected {
            *lang = selected;
        }
    }
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
            spacings[cs - start] = cluster_letter_spacing_px(
                special_space_origins,
                text_chars,
                cs,
                ce,
                trailing_langs[cs],
                char_offsets,
                char_shapes,
                styles,
            );
            last_cluster = cs;
            cs = ce;
        }
        // 자동 간격: 바로 붙은 다음 텍스트 토큰과의 경계
        if next_text_start == Some(end)
            && end < text_chars.len()
            && auto_spacing.applies(text_chars[end - 1], text_chars[end])
        {
            let style_id = char_style_id_at(char_offsets, char_shapes, end - 1);
            let lang = trailing_langs[end - 1];
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
        &[],
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
    special_space_origins: &[SpecialSpaceOrigin],
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

    let font_space_langs = super::font_space_lang_slots(
        text_chars
            .iter()
            .copied()
            .enumerate()
            .map(|(scalar, ch)| (ch, char_style_id_at(char_offsets, char_shapes, scalar))),
        styles,
    );
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
            let selected =
                occurrence_lang_category(ch, i, special_space_origins, styles.font_metrics_policy);
            let space_lang = if let Some(lang) = font_space_langs[i] {
                lang
            } else if ch == '\u{2007}' && selected == 5 {
                selected
            } else {
                current_lang
            };
            let ts = resolved_to_text_style(styles, style_id, space_lang).with_origin_range(
                special_space_origins,
                i,
                i + 1,
            );
            // 줄 높이는 글자 모양 기준 크기를 쓴다 — 언어별 상대 크기는 넣지 않는다
            // (글자 토큰과 같은 규칙, 오라클 H4: 상대 크기 106% 공백 줄 1217 → 저장 1148).
            let base_size = style_font_size(styles, style_id);
            let font_size = if base_size > 0.0 { base_size } else { 12.0 };
            let space = if ch == ' ' { " " } else { "\u{2007}" };
            let w = estimate_text_width_unrounded(space, &ts);
            let mut untracked = ts;
            untracked.zero_tracking();
            let base_width = estimate_text_width_unrounded(space, &untracked);
            tokens.push(BreakToken::Space {
                idx: i,
                width: w,
                base_width,
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
                    if !is_occurrence_lang_neutral(
                        c,
                        i,
                        special_space_origins,
                        styles.font_metrics_policy,
                    ) {
                        current_lang = occurrence_lang_category(
                            c,
                            i,
                            special_space_origins,
                            styles.font_metrics_policy,
                        );
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
                    if !is_occurrence_lang_neutral(
                        c,
                        i,
                        special_space_origins,
                        styles.font_metrics_policy,
                    ) {
                        current_lang = occurrence_lang_category(
                            c,
                            i,
                            special_space_origins,
                            styles.font_metrics_policy,
                        );
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
                        special_space_origins,
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
                        special_space_origins,
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
                current_lang = occurrence_lang_category(
                    ch,
                    i,
                    special_space_origins,
                    styles.font_metrics_policy,
                );
                let end = grapheme_ends[i];
                let (w, fs, lang) = measure_grapheme_metrics(
                    special_space_origins,
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
                    if !is_occurrence_lang_neutral(
                        c,
                        i,
                        special_space_origins,
                        styles.font_metrics_policy,
                    ) {
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
                        special_space_origins,
                        &token_text,
                        start,
                        char_offsets,
                        char_shapes,
                        styles,
                        current_lang,
                    );
                    // 개별 글자 폭 수집 (char_level_break용)
                    let cw = measure_grapheme_advances(
                        special_space_origins,
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
                    special_space_origins,
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
            current_lang =
                occurrence_lang_category(ch, i, special_space_origins, styles.font_metrics_policy);
            let end = grapheme_ends[i];
            let (w, fs, lang) = measure_grapheme_metrics(
                special_space_origins,
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
            let lang = if is_occurrence_lang_neutral(
                ch,
                i,
                special_space_origins,
                styles.font_metrics_policy,
            ) {
                current_lang
            } else {
                let detected = occurrence_lang_category(
                    ch,
                    i,
                    special_space_origins,
                    styles.font_metrics_policy,
                );
                current_lang = detected;
                detected
            };
            let end = grapheme_ends[i];
            let (w, fs, lang) = measure_grapheme_metrics(
                special_space_origins,
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
        special_space_origins,
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
    special_space_origins: &[SpecialSpaceOrigin],
    text: &str,
    start_char_idx: usize,
    char_offsets: &[u32],
    char_shapes: &[CharShapeRef],
    styles: &ResolvedStyleSet,
    default_lang: usize,
) -> f64 {
    let mut total = 0.0;
    let mut current_lang = default_lang;
    let mut legacy_lang = default_lang;
    let mut run_text = String::new();
    let mut run_style = None;
    let mut run_lang = current_lang;
    let mut run_start = start_char_idx;
    for (offset, ch) in text.chars().enumerate() {
        let idx = start_char_idx + offset;
        let utf16_pos = if idx < char_offsets.len() {
            char_offsets[idx]
        } else {
            idx as u32
        };
        let style_id = find_active_char_shape(char_shapes, utf16_pos);
        let lang = if is_occurrence_lang_neutral(
            ch,
            idx,
            special_space_origins,
            styles.font_metrics_policy,
        ) {
            current_lang = legacy_lang;
            current_lang
        } else {
            legacy_lang =
                carried_lang_category(ch, idx, special_space_origins, styles.font_metrics_policy);
            let detected = occurrence_lang_category(
                ch,
                idx,
                special_space_origins,
                styles.font_metrics_policy,
            );
            current_lang = detected;
            detected
        };
        if run_style != Some(style_id) || run_lang != lang {
            if let Some(active_style) = run_style {
                let ts = resolved_to_text_style(styles, active_style, run_lang).with_origin_range(
                    special_space_origins,
                    run_start,
                    idx,
                );
                total += estimate_text_width_unrounded(&run_text, &ts);
                run_text.clear();
            }
            run_style = Some(style_id);
            run_lang = lang;
            run_start = idx;
        }
        run_text.push(ch);
    }
    if let Some(active_style) = run_style {
        let ts = resolved_to_text_style(styles, active_style, run_lang).with_origin_range(
            special_space_origins,
            run_start,
            start_char_idx + text.chars().count(),
        );
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
    let mut start_token_idx = 0;
    let mut max_font_size = 0.0f64;
    for (ti, token) in tokens.iter().enumerate() {
        match token {
            BreakToken::LineBreak {
                idx,
                max_font_size: break_font_size,
            } => {
                max_font_size = max_font_size.max(*break_font_size);
                lines.push(LineBreakResult {
                    start_token_idx,
                    start_idx,
                    end_idx: *idx + 1,
                    max_font_size,
                    has_line_break: true,
                });
                start_idx = *idx + 1;
                start_token_idx = ti + 1;
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
        start_token_idx,
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
    exact_control_cuts: bool,
) -> Vec<LineBreakResult> {
    if tokens.is_empty() {
        return vec![LineBreakResult {
            start_token_idx: 0,
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
    let mut line_start_token_idx = 0usize;
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
                    start_token_idx: line_start_token_idx,
                    start_idx: line_start_idx,
                    end_idx: *idx + 1,
                    max_font_size: line_max_fs,
                    has_line_break: true,
                });
                advance_band(&results);
                line_start_idx = *idx + 1;
                line_start_token_idx = ti + 1;
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
                            style.margin_left + current_line_w.get(),
                        );
                        // 현재 x와 오른쪽 끝 모두 단 기준 좌표다. 본문 폭만 넘기면
                        // 왼쪽 여백 안쪽의 마지막 자동 오른쪽 정지를 놓친다.
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
                                start_token_idx: line_start_token_idx,
                                start_idx: line_start_idx,
                                end_idx: *idx,
                                max_font_size: line_max_fs,
                                has_line_break: false,
                            });
                            advance_band(&results);
                            line_start_idx = *idx;
                            line_start_token_idx = ti;
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
                            start_token_idx: line_start_token_idx,
                            start_idx: line_start_idx,
                            end_idx: last_break_char_idx,
                            max_font_size: fs_at_last_break,
                            has_line_break: false,
                        });
                        advance_band(&results);
                        line_start_idx = last_break_char_idx;
                        line_start_token_idx = token_index_after_break(
                            tokens,
                            last_break_token_idx.unwrap(),
                            ti,
                            line_start_idx,
                        );
                        lw = lw - width_at_last_break;
                        line_space_savings -= space_savings_at_last_break;
                    } else {
                        results.push(LineBreakResult {
                            start_token_idx: line_start_token_idx,
                            start_idx: line_start_idx,
                            end_idx: *idx,
                            max_font_size: line_max_fs,
                            has_line_break: false,
                        });
                        advance_band(&results);
                        line_start_idx = *idx;
                        line_start_token_idx = ti;
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
                base_width,
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
                        start_token_idx: line_start_token_idx,
                        start_idx: line_start_idx,
                        end_idx: *idx,
                        max_font_size: line_max_fs,
                        has_line_break: false,
                    });
                    advance_band(&results);
                    line_start_idx = *idx;
                    line_start_token_idx = ti;
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
                if !is_fixed_width && space_content_end > line_start_idx {
                    line_space_savings +=
                        condense_space_savings_hwp(to_hwp(*base_width), condense_min_space);
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
                // 개체는 텍스트 위치와 별도로 토큰 경계에서 줄 소유권을 보존한다.
                if condensed_line_width_hwp(lw + width_hwp, eligible_space_savings)
                    > eff_w(is_first_line)
                    && if exact_control_cuts {
                        ti > line_start_token_idx
                    } else {
                        *idx > line_start_idx
                    }
                {
                    // 개체 바로 앞 글자 뒤가 원래 줄을 나눌 수 있는 자리(닫는 문장부호,
                    // 글자 단위 한글, 한자)이면 개체 앞에서 바로 나눈다. 마지막 공백까지
                    // 되돌리면 "형성한다." 의 마침표처럼 줄 머리 금칙 글자나 어절 조각이
                    // 개체와 함께 다음 줄로 넘어가 앞 줄만 짧게 남는다.
                    // 같은 scalar 위치여도 이미 들어간 앞 개체 다음은 정확한 토큰 경계다.
                    // 이 경계보다 앞 공백으로 되돌리면 들어간 개체까지 다시 옮기게 된다.
                    let break_before_object = (exact_control_cuts
                        && matches!(tokens.get(ti - 1),
                        Some(BreakToken::InlineControl {idx:previous,..}) if previous==idx))
                        || text_chars.get(idx.saturating_sub(1)).is_some_and(|&c| {
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
                            start_token_idx: line_start_token_idx,
                            start_idx: line_start_idx,
                            end_idx: break_char,
                            max_font_size: fs_at_last_break,
                            has_line_break: false,
                        });
                        advance_band(&results);
                        line_start_idx = next_start;
                        line_start_token_idx = token_index_after_break(
                            tokens,
                            last_break_token_idx.unwrap(),
                            ti,
                            next_start,
                        );
                        lw = recalc_width_hwp(
                            tokens,
                            ti,
                            next_start,
                            if exact_control_cuts {
                                line_start_token_idx
                            } else {
                                0
                            },
                        );
                        line_space_savings = recalc_space_savings_hwp(
                            tokens,
                            ti,
                            next_start,
                            if exact_control_cuts {
                                line_start_token_idx
                            } else {
                                0
                            },
                            condense_min_space,
                        );
                        lw += width_hwp;
                        last_trailing_hwp = 0;
                        line_max_fs = *max_font_size;
                        is_first_line = false;
                        last_break_token_idx = None;
                    } else {
                        // 복원된 슬롯은 현재 토큰에서 나눈다. 알 수 없는 슬롯은 기존
                        // scalar 기반 painter 계약에 맞춰 같은 위치의 앞 개체도 옮긴다.
                        let mut first_control = ti;
                        let mut carry_w = 0;
                        if !exact_control_cuts {
                            while first_control > 0 {
                                match &tokens[first_control - 1] {
                                    BreakToken::InlineControl {
                                        idx: previous,
                                        width_hwp,
                                        ..
                                    } if previous == idx => {
                                        carry_w += width_hwp;
                                        first_control -= 1;
                                    }
                                    _ => break,
                                }
                            }
                        }
                        results.push(LineBreakResult {
                            start_token_idx: line_start_token_idx,
                            start_idx: line_start_idx,
                            end_idx: *idx,
                            max_font_size: line_max_fs,
                            has_line_break: false,
                        });
                        advance_band(&results);
                        line_start_idx = *idx;
                        line_start_token_idx = first_control;
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
                // 복원된 개체 뒤의 글자가 현재 문단 규칙에서 나눌 수 있으면
                // 개체가 이미 들어간 이 토큰 경계도 유효하다. 앞 공백으로 되감아
                // 개체까지 옮기지 않는다. KEEP_WORD/알 수 없는 슬롯은 종전대로다.
                if exact_control_cuts
                    && text_chars
                        .get(*idx)
                        .is_some_and(|&ch| char_breakable(ch) && !is_line_start_forbidden(ch))
                {
                    last_break_token_idx = Some(ti);
                    last_break_char_idx = *idx;
                    width_at_last_break = lw;
                    space_savings_at_last_break = line_space_savings;
                    fs_at_last_break = line_max_fs;
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
                    && tokens[if exact_control_cuts {
                        line_start_token_idx
                    } else {
                        0
                    }..ti]
                        .iter()
                        .any(|token| {
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
                                start_token_idx: line_start_token_idx,
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
                            line_start_token_idx = token_index_after_break(
                                tokens,
                                last_break_token_idx.unwrap(),
                                ti,
                                next_start,
                            );
                            lw = recalc_width_hwp(
                                tokens,
                                ti,
                                next_start,
                                if exact_control_cuts {
                                    line_start_token_idx
                                } else {
                                    0
                                },
                            );
                            line_space_savings = recalc_space_savings_hwp(
                                tokens,
                                ti,
                                next_start,
                                if exact_control_cuts {
                                    line_start_token_idx
                                } else {
                                    0
                                },
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
                                        &mut line_start_token_idx,
                                        ti,
                                        lw_before_token,
                                        line_max_fs,
                                        eff_w(false),
                                        eff_w(false),
                                        false,
                                        &cw_hwp,
                                        &cs_hwp,
                                        false,
                                        exact_control_cuts,
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
                    // paint/run 경계가 깨진다. 수식은 실제 토큰 경계에서 글자를 나눈다.
                    if *start_idx == line_start_idx
                        && line_hosts_own_line_control(
                            tokens,
                            ti,
                            line_start_idx,
                            if exact_control_cuts {
                                line_start_token_idx
                            } else {
                                0
                            },
                        )
                    {
                        results.push(LineBreakResult {
                            start_token_idx: line_start_token_idx,
                            start_idx: line_start_idx,
                            end_idx: *start_idx, // == line_start_idx — 빈 텍스트 줄 (개체 호스트)
                            max_font_size: line_max_fs,
                            has_line_break: false,
                        });
                        advance_band(&results);
                        // scalar 위치는 같아도 개체 토큰은 앞 줄에서 이미 소비했다.
                        line_start_token_idx = ti;
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
                                &mut line_start_token_idx,
                                ti,
                                lw,
                                line_max_fs,
                                eff_w(false),
                                eff_w(false),
                                false,
                                &cw_hwp,
                                &cs_hwp,
                                false,
                                exact_control_cuts,
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
                    let pin_first_char = !exact_control_cuts
                        && *start_idx > line_start_idx
                        && matches!(ti.checked_sub(1).and_then(|i|tokens.get(i)),
                            Some(BreakToken::InlineControl {idx,..}) if idx==start_idx);
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
                                    start_token_idx: line_start_token_idx,
                                    start_idx: line_start_idx,
                                    end_idx: *ps,
                                    max_font_size: line_max_fs,
                                    has_line_break: false,
                                });
                                advance_band(&results);
                                line_start_idx = *ps;
                                line_start_token_idx = ti - 1;
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
                        &mut line_start_token_idx,
                        ti,
                        lw,
                        line_max_fs,
                        eff_w(is_first_line),
                        eff_w(false),
                        is_first_line,
                        &cw_hwp,
                        &cs_hwp,
                        pin_first_char,
                        exact_control_cuts,
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
            start_token_idx: line_start_token_idx,
            start_idx: line_start_idx,
            end_idx: last_end,
            max_font_size: line_max_fs,
            has_line_break: false,
        });
    }

    if results.is_empty() {
        results.push(LineBreakResult {
            start_token_idx: line_start_token_idx,
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

/// 되돌린 글자 위치와 실제 break 토큰을 함께 써 이미 소비한 제어 슬롯을 제외한다.
fn token_index_after_break(
    tokens: &[BreakToken],
    break_token: usize,
    current: usize,
    next_char: usize,
) -> usize {
    let start_of = |token: &BreakToken| match token {
        BreakToken::Text { start_idx, .. } => *start_idx,
        BreakToken::Space { idx, .. }
        | BreakToken::Tab { idx, .. }
        | BreakToken::LineBreak { idx, .. }
        | BreakToken::InlineControl { idx, .. } => *idx,
    };
    let from = if next_char < start_of(&tokens[break_token]) {
        // 줄 꼬리에서 남긴 공백 묶음은 그 가시 토큰부터 시작한다.
        tokens[..=break_token]
            .iter()
            .position(|token| {
                !matches!(token, BreakToken::InlineControl { .. }) && start_of(token) == next_char
            })
            .unwrap_or(break_token)
    } else if matches!(tokens[break_token], BreakToken::InlineControl { .. }) {
        break_token + 1
    } else {
        break_token
    };
    (from..=current)
        .find(|&i| match &tokens[i] {
            BreakToken::Text { end_idx, .. } => *end_idx > next_char,
            token => start_of(token) >= next_char,
        })
        .unwrap_or(current)
}

/// 현재 줄에 own_line 인라인 개체(표/그림/도형)가 배치됐는지 판별한다.
/// 가시 문자 위치가 같아도 앞 줄에서 소비한 개체 토큰은 다시 포함하지 않는다.
fn line_hosts_own_line_control(
    tokens: &[BreakToken],
    current_token_idx: usize,
    line_start_idx: usize,
    line_start_token_idx: usize,
) -> bool {
    tokens[line_start_token_idx..current_token_idx]
        .iter()
        .any(|t| matches!(t, BreakToken::InlineControl { idx, own_line: true, .. } if *idx >= line_start_idx))
}

/// 줄 바꿈 지점 이후 토큰의 누적 폭 재계산 (HWPUNIT)
fn recalc_width_hwp(
    tokens: &[BreakToken],
    current_token_idx: usize,
    new_line_start: usize,
    start_token_idx: usize,
) -> i32 {
    let mut w = 0i32;
    for t in &tokens[start_token_idx..current_token_idx] {
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
    start_token_idx: usize,
    condense_min_space: u8,
) -> i32 {
    let mut w = 0i32;
    let mut content_end = 0;
    for t in &tokens[start_token_idx..current_token_idx] {
        match t {
            BreakToken::Text { end_idx, .. } => content_end = *end_idx,
            BreakToken::Tab { idx, .. } | BreakToken::InlineControl { idx, .. } => {
                content_end = *idx + 1;
            }
            BreakToken::Space {
                idx,
                base_width,
                is_fixed_width: false,
                ..
            } if *idx >= new_line_start && content_end > new_line_start => {
                let space_hwp = to_hwp(*base_width);
                w += condense_space_savings_hwp(space_hwp, condense_min_space);
            }
            _ => {}
        }
    }
    w
}

/// 긴 단어 폴백: 글자 단위 분할 (HWPUNIT)
/// char_widths_hwp: 토큰 내 각 글자의 HWPUNIT 폭 (None이면 휴리스틱)
fn char_level_break_hwp(
    text_chars: &[char],
    token_start: usize,
    token_end: usize,
    line_start_idx: &mut usize,
    line_start_token_idx: &mut usize,
    current_token_idx: usize,
    mut lw: i32,
    mut line_max_fs: f64,
    first_line_w: i32,
    normal_w: i32,
    mut is_first_line: bool,
    char_widths_hwp: &[i32],   // 토큰 내 글자별 HWPUNIT 폭
    char_spacings_hwp: &[i32], // 글자별 trailing(자간) 폭 — 줄 끝 글자는 맞춤 판정에서 뺀다
    pin_first_char: bool,
    exact_control_cuts: bool,
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
            && (ci > *line_start_idx
                || exact_control_cuts && current_token_idx > *line_start_token_idx)
            && !(pin_first_char && rel_idx == 0)
        {
            // 강제 분할은 줄 머리 금칙을 따지지 않는다 — macOS 한컴은 `1,234|,567` 처럼
            // 쉼표로도 다음 줄을 시작한다 (스윕 I_squeeze 좁은 문단).
            results.push(LineBreakResult {
                start_token_idx: *line_start_token_idx,
                start_idx: *line_start_idx,
                end_idx: ci,
                max_font_size: line_max_fs,
                has_line_break: false,
            });
            *line_start_idx = ci;
            *line_start_token_idx = current_token_idx;
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

fn line_index_for_token(line_breaks: &[LineBreakResult], token: usize) -> usize {
    line_breaks
        .partition_point(|line| line.start_token_idx <= token)
        .saturating_sub(1)
        .min(line_breaks.len().saturating_sub(1))
}

/// 가시 위치로 접힌 제어 슬롯의 시작을 실제 UTF-16 갭에서 복원한다.
/// 탭·필드 끝 등 컨트롤 배열과 대응하지 않는 갭은 추측하지 않는다.
fn control_stream_starts(para: &Paragraph, positions: &[usize]) -> Vec<Option<u32>> {
    const EXTENDED_UNITS: u32 = 8;
    let mut anchors = vec![None; para.controls.len()];
    // FIELD_END와 미지원 inline 마커는 controls 배열에 없고, 번호·덧말은
    // 가시 위치를 따로 투영한다. 갭 길이가 우연히 맞아도 슬롯 소유를 추정하지 않는다.
    const UNMAPPED_INLINE_MASK: u32 = (0b1_1111 << 4) | (0b11 << 19);
    if !para.field_ranges.is_empty()
        || !para.orphan_field_ends.is_empty()
        || para.control_mask & UNMAPPED_INLINE_MASK != 0
        || para.controls.iter().any(|control| {
            !matches!(
                control,
                Control::Equation(_)
                    | Control::Picture(_)
                    | Control::Table(_)
                    | Control::Shape(_)
                    | Control::SectionDef(_)
                    | Control::ColumnDef(_)
                    | Control::Header(_)
                    | Control::Footer(_)
                    | Control::PageNumberPos(_)
                    | Control::PageHide(_)
            )
        })
    {
        return anchors;
    }
    let chars: Vec<_> = para.text.chars().collect();
    let mut begin = 0;
    while begin < positions.len() {
        let position = positions[begin];
        let mut end = begin + 1;
        while positions.get(end) == Some(&position) {
            end += 1;
        }
        let previous_end = position
            .checked_sub(1)
            .and_then(|i| para.char_offsets.get(i).zip(chars.get(i)))
            .map_or(0, |(offset, ch)| offset + ch.len_utf16() as u32);
        let following = para
            .char_offsets
            .get(position)
            .copied()
            .or_else(|| (position == chars.len()).then_some(para.char_count.saturating_sub(1)));
        if let Some(following) = following.filter(|next| *next >= previous_end) {
            let gap = following - previous_end;
            let count = end - begin;
            if gap == count as u32 * EXTENDED_UNITS {
                for (ordinal, control) in (begin..end).enumerate() {
                    anchors[control] = Some(previous_end + ordinal as u32 * EXTENDED_UNITS);
                }
            }
            if gap < EXTENDED_UNITS && count == 1 && chars.get(position) == Some(&'\u{FFFC}') {
                anchors[begin] = Some(following);
            }
        }
        begin = end;
    }
    anchors
}

fn folded_control_line_index(
    control: &Control,
    line_breaks: &[LineBreakResult],
    position: usize,
) -> usize {
    let text_owner = || {
        line_breaks
            .partition_point(|line| line.start_idx <= position)
            .saturating_sub(1)
            .min(line_breaks.len().saturating_sub(1))
    };
    if matches!(control, Control::Equation(_)) {
        text_owner()
    } else {
        line_breaks
            .iter()
            .position(|line| line.start_idx == position && line.end_idx == position)
            .unwrap_or_else(text_owner)
    }
}

fn apply_inline_control_metrics_to_text_lines(
    para: &Paragraph,
    line_breaks: &[LineBreakResult],
    control_tokens: &[Option<usize>],
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
        let line_index = control_tokens
            .get(control_index)
            .copied()
            .flatten()
            .map(|token| line_index_for_token(line_breaks, token))
            .unwrap_or_else(|| {
                folded_control_line_index(
                    control,
                    line_breaks,
                    positions
                        .get(control_index)
                        .copied()
                        .unwrap_or_else(|| para.text.chars().count()),
                )
            });
        if let Some(line_seg) = line_segs.get_mut(line_index) {
            apply_inline_control_line_metrics(line_seg, metrics);
        }
    }
}

/// 저장 줄의 UTF-16 범위에 속한 개체를 찾는다. composed 줄은 강제 줄바꿈을
/// 별도 줄로 풀 수 있으므로 저장 LINE_SEG 인덱스와 혼용하지 않는다.
fn saved_control_line_index(
    para: &Paragraph,
    anchors: &[Option<u32>],
    control_index: usize,
) -> Option<usize> {
    if para.line_segs.len() == 1 {
        return Some(0);
    }
    let anchor = anchors.get(control_index).copied().flatten()?;
    Some(
        para.line_segs
            .partition_point(|line| line.text_start <= anchor)
            .saturating_sub(1),
    )
}

pub(crate) fn inline_table_host_line_index(
    para: &Paragraph,
    control_index: usize,
) -> Option<usize> {
    let mut positions = para.control_text_positions();
    crate::renderer::ruby::project_control_positions(para, &mut positions);
    saved_control_line_index(
        para,
        &control_stream_starts(para, &positions),
        control_index,
    )
}

/// 리플로우와 개체 줄 갱신은 같은 글자·문단 머리·끝 표시·테두리 치수를 사용한다.
fn apply_text_line_metrics(
    segment: &mut LineSeg,
    para: &Paragraph,
    styles: &ResolvedStyleSet,
    dpi: f64,
    end_pos: u32,
    mut font_size: f64,
    first: bool,
    last: bool,
) {
    let para_style = styles.para_styles.get(para.para_shape_id as usize);
    if first {
        font_size = font_size.max(paragraph_head_font_size(styles, para_style));
    }
    if last {
        let end = para
            .char_offsets
            .last()
            .zip(para.text.chars().last())
            .map(|(offset, ch)| offset + ch.len_utf16() as u32)
            .unwrap_or(0);
        font_size = font_size.max(style_font_size(
            styles,
            find_active_char_shape(&para.char_shapes, end),
        ));
    }
    let height = font_size_to_line_height(if font_size > 0.0 { font_size } else { 12.0 }, dpi);
    let spacing_type = para_style
        .map(|style| style.line_spacing_type)
        .unwrap_or(LineSpacingType::Percent);
    let spacing = para_style.map(|style| style.line_spacing).unwrap_or(160.0);
    segment.line_height = height;
    segment.text_height = height;
    segment.baseline_distance = baseline_for_vertical_align(
        height,
        para_style.map(|style| style.vertical_align).unwrap_or(0),
    );
    segment.line_spacing = compute_line_spacing_hwp(spacing_type, spacing, height, dpi);
    apply_char_border_line_metrics(segment, end_pos, para, styles, dpi, spacing_type, spacing);
}

/// 현재 표 높이를 저장된 소속 줄에 반영하고 폭·원점·플래그를 보존한다.
pub(crate) fn refresh_inline_table_host_metrics(
    para: &mut Paragraph,
    control_index: usize,
    styles: &ResolvedStyleSet,
    dpi: f64,
) -> bool {
    if !matches!(para.controls.get(control_index), Some(Control::Table(table)) if table.common.treat_as_char)
    {
        return false;
    }
    let mut positions = para.control_text_positions();
    crate::renderer::ruby::project_control_positions(para, &mut positions);
    let anchors = control_stream_starts(para, &positions);
    let Some(line_index) = saved_control_line_index(para, &anchors, control_index) else {
        return false;
    };
    let Some(original) = para.line_segs.get(line_index).cloned() else {
        return false;
    };
    let end = para
        .line_segs
        .get(line_index + 1)
        .map(|line| line.text_start)
        .unwrap_or(u32::MAX);
    let font_size = para
        .char_shapes
        .iter()
        .enumerate()
        .filter(|(index, run)| {
            let run_end = para
                .char_shapes
                .get(index + 1)
                .map(|next| next.start_pos)
                .unwrap_or(u32::MAX);
            run.start_pos < end && run_end > original.text_start
        })
        .filter_map(|(_, run)| styles.char_styles.get(run.char_shape_id as usize))
        .map(|style| style.font_size)
        .fold(0.0, f64::max);
    let mut segment = original.clone();
    apply_text_line_metrics(
        &mut segment,
        para,
        styles,
        dpi,
        end,
        font_size,
        line_index == 0,
        line_index + 1 == para.line_segs.len(),
    );
    for (index, control) in para.controls.iter().enumerate() {
        if saved_control_line_index(para, &anchors, index) != Some(line_index) {
            continue;
        }
        if let Some(metrics) = ruby_control_metrics(para, index, styles, dpi)
            .or_else(|| inline_control_metrics_hwp(control))
        {
            apply_inline_control_line_metrics(&mut segment, metrics);
        }
    }
    let delta = saved_line_advance(&segment).saturating_sub(saved_line_advance(&original));
    let changed = (
        segment.line_height,
        segment.text_height,
        segment.baseline_distance,
        segment.line_spacing,
    ) != (
        original.line_height,
        original.text_height,
        original.baseline_distance,
        original.line_spacing,
    );
    para.line_segs[line_index] = segment;
    for segment in para.line_segs.iter_mut().skip(line_index + 1) {
        segment.vertical_pos = segment.vertical_pos.saturating_add(delta);
    }
    changed
}




pub(crate) fn reflow_line_segs(
    para: &mut Paragraph,
    available_width_px: f64,
    styles: &ResolvedStyleSet,
    dpi: f64,
) {
    reflow_line_segs_with_squeeze(para, available_width_px, styles, dpi, false, false);
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
    known_horizontal: bool,
) {
    let head_reserve =
        crate::renderer::layout::paragraph_head_reserve_px(styles, para, dpi, known_horizontal);
    reflow_line_segs_with_wrap_exclusions(
        para,
        available_width_px,
        styles,
        dpi,
        squeeze,
        &[],
        false,
        Some(head_reserve),
    );
}

/// 앞 문단의 어울림 영역은 단 기준 x, 현재 문단 기준 y로 전달한다.
/// 반환값도 같은 좌표계이며 현재 문단이 새로 소유하는 영역만 포함한다.
pub(crate) fn reflow_line_segs_with_head(
    para: &mut Paragraph,
    width: f64,
    styles: &ResolvedStyleSet,
    dpi: f64,
    head_reserve: (f64, f64),
) {
    reflow_line_segs_with_wrap_exclusions(
        para,
        width,
        styles,
        dpi,
        false,
        &[],
        false,
        Some(head_reserve),
    );
}

pub(crate) fn reflow_line_segs_with_exclusions(
    para: &mut Paragraph,
    width: f64,
    styles: &ResolvedStyleSet,
    dpi: f64,
    preceding: &[FloatExclusion],
) -> Vec<FloatExclusion> {
    reflow_line_segs_with_exclusions_and_head(para, width, styles, dpi, preceding, None)
}

pub(crate) fn reflow_line_segs_with_exclusions_and_head(
    para: &mut Paragraph,
    available_width_px: f64,
    styles: &ResolvedStyleSet,
    dpi: f64,
    preceding: &[FloatExclusion],
    head_reserve: Option<(f64, f64)>,
) -> Vec<FloatExclusion> {
    reflow_line_segs_with_wrap_exclusions(
        para,
        available_width_px,
        styles,
        dpi,
        false,
        preceding,
        true,
        head_reserve,
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
    head_reserve: Option<(f64, f64)>,
) {
    // 실제 편집 reflow는 새 줄의 권위다. 이전 저장 줄로 되돌리지 않는다.
    para.cached_equation_line_origin = None;
    crate::renderer::float_placement::normalize_leading_host_layout(para, styles);
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
        // 새 접두 줄은 저장 줄 소비자가 같은 실제 앵커를 복원할 때만 만든다.
        let can_split_fresh_control_prefix = use_control_font_basis
            && para.char_offsets.is_empty()
            && control_stream_starts(para, &para.control_text_positions())
                .iter()
                .zip(&control_anchors)
                .all(|(resolved, actual)| *resolved == Some(*actual));
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
                // 글꼴 측정과 논리적 줄 소유는 별개다. fresh 경로에서 실제로 방문하는
                // 폭 0 쪽번호 컨트롤은 앵커가 확인된 스트림에서만 별도 줄로 보존한다.
                let ctrl_line_before = !has_ruby
                    && ci > line_first_ctrl
                    && para.controls[line_first_ctrl..ci].iter().any(|c| {
                        if use_control_font_basis {
                            can_split_fresh_control_prefix && matches!(c, Control::PageNumberPos(_))
                        } else {
                            !matches!(c, Control::SectionDef(_) | Control::ColumnDef(_))
                        }
                    });
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
                .unwrap_or(12.0)
                .max(paragraph_head_font_size(styles, para_style));
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
    let control_stream_starts = control_stream_starts(para, &control_positions);
    crate::renderer::ruby::project_control_positions(para, &mut control_positions);
    let mut inline_controls: Vec<(usize, i32, bool, usize)> = para
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
            (pos, width, own_line, ci)
        })
        .collect();
    inline_controls.sort_by_key(|&(pos, _, _, _)| pos);

    // 토큰화 → 줄 채움 → LineSeg 생성
    let mut tokens = tokenize_paragraph_with_controls(
        &para.special_space_origins,
        &text_chars,
        &para.char_offsets,
        &para.char_shapes,
        styles,
        english_break_unit,
        korean_break_unit,
        auto_spacing,
        &inline_controls
            .iter()
            .map(|&(p, w, o, _)| (p, w, o))
            .collect::<Vec<_>>(),
    );
    let mut control_tokens = vec![None; para.controls.len()];
    for ((ti, _), (_, _, _, ci)) in tokens
        .iter()
        .enumerate()
        .filter(|(_, token)| matches!(token, BreakToken::InlineControl { .. }))
        .zip(&inline_controls)
    {
        control_tokens[*ci] = control_stream_starts
            .get(*ci)
            .copied()
            .flatten()
            .map(|_| ti);
    }
    // 합성 painter도 같은 원시 슬롯 계약을 쓴다. 일부만 복원되거나 가시
    // offset이 없으면 문단 전체를 기존 scalar 계약으로 유지한다.
    let exact_control_cuts = !para.char_offsets.is_empty()
        && inline_controls
            .iter()
            .all(|(_, _, _, ci)| control_tokens[*ci].is_some());
    if !exact_control_cuts {
        control_tokens.fill(None);
    }
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
    let mut head_reserve_px = head_reserve.unwrap_or_else(|| {
        crate::renderer::layout::paragraph_head_reserve_px(styles, para, dpi, false)
    });
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
            exact_control_cuts,
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
            exact_control_cuts,
        ),
        _ => line_breaks_full,
    };
    let mut inline_line_starts = vec![None; line_breaks.len()];
    if exact_control_cuts {
        for (ci, token) in control_tokens.iter().enumerate() {
            let Some(token) = *token else {
                continue;
            };
            let Some(anchor) = control_stream_starts.get(ci).copied().flatten() else {
                continue;
            };
            let owner = line_index_for_token(&line_breaks, token);
            if line_breaks
                .get(owner)
                .is_some_and(|line| line.start_token_idx == token)
            {
                inline_line_starts[owner] = Some(anchor);
            }
        }
    } else {
        for (ci, control) in para.controls.iter().enumerate() {
            let Some(anchor) = control_stream_starts.get(ci).copied().flatten() else {
                continue;
            };
            if matches!(control, Control::Form(_))
                || ruby_control_metrics(para, ci, styles, dpi)
                    .or_else(|| inline_control_metrics_hwp(control))
                    .is_none()
            {
                continue;
            }
            let position = control_positions.get(ci).copied().unwrap_or(text_len);
            let owner = folded_control_line_index(control, &line_breaks, position);
            if line_breaks
                .get(owner)
                .is_some_and(|line| line.start_idx == position)
            {
                let start = &mut inline_line_starts[owner];
                *start = Some(start.map_or(anchor, |previous: u32| previous.min(anchor)));
            }
        }
    }
    let mut new_line_segs: Vec<LineSeg> = Vec::new();
    for (line_index, lb) in line_breaks.iter().enumerate() {
        let text_utf16_start = if new_line_segs.is_empty() {
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
        let utf16_start = if line_index == 0 {
            text_utf16_start
        } else {
            inline_line_starts[line_index]
                .filter(|anchor| *anchor <= text_utf16_start)
                .unwrap_or(text_utf16_start)
        };
        let mut fs = if lb.max_font_size > 0.0 {
            lb.max_font_size
        } else {
            12.0
        };
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
        apply_text_line_metrics(
            &mut seg,
            para,
            styles,
            dpi,
            end_pos,
            fs,
            line_index == 0,
            line_index + 1 == line_breaks.len(),
        );
        new_line_segs.push(seg);
    }

    if new_line_segs.is_empty() {
        new_line_segs.push(make_line_seg(0, 12.0));
    }

    // Reserve each object's height on its actual line. Applying the largest
    // picture to the first line creates a blank band above wrapped pictures.
    apply_inline_control_metrics_to_text_lines(
        para,
        &line_breaks,
        &control_tokens,
        &mut new_line_segs,
        styles,
        dpi,
    );

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
    // Polaris HWP 줄 저장기는 binary32 곱셈 뒤 BrFRound를 적용한다.
    round_half_away(f64::from(text_height_hwp as f32 * ratio as f32))
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
    // 어울림으로 좁힌 줄만 계획 좌표를 보존하고, 배제가 끝난 줄은 문단 여백을 쓴다.
    for (i, seg) in segs.iter_mut().enumerate() {
        if !narrowed.get(i).copied().unwrap_or(false) {
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
    recalculate_section_vpos_for_body(
        paragraphs,
        start_para,
        ignore_reset_range,
        start_stored_end,
        styles,
        dpi,
        is_hwp3_variant,
        false,
    );
}

/// 인증된 자연 흐름의 편집 범위에서는 fit으로 생긴 암시적 프레임 원점을 다시 잇는다.
pub(crate) fn recalculate_section_vpos_for_body(
    paragraphs: &mut [Paragraph],
    start_para: usize,
    ignore_reset_range: Option<std::ops::Range<usize>>,
    start_stored_end: Option<i32>,
    styles: &ResolvedStyleSet,
    dpi: f64,
    is_hwp3_variant: bool,
    rejoin_implicit_frames: bool,
) {
    if paragraphs.is_empty() || start_para >= paragraphs.len() {
        return;
    }

    // 인증 해제 시 원본 capture와 실제 줄 좌표를 같은 축으로 한 번만 바꾼다.
    for paragraph in paragraphs.iter_mut() {
        crate::renderer::float_placement::normalize_leading_host_layout(paragraph, styles);
    }
    let start_stored_end = match paragraphs[start_para].leading_host_rollback_bound.take() {
        Some((native_end, legacy_end)) if start_stored_end == Some(native_end) => Some(legacy_end),
        _ => start_stored_end,
    };

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
    let seg_advance = saved_line_advance;
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
        if crate::renderer::float_placement::leading_host_reserve(p) > 0 {
            return Some(lines_end);
        }
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
        None => crate::renderer::float_placement::paragraph_flow_anchor(&paragraphs[start_para])
            .unwrap_or(0),
    };
    // 리셋 감지 기준 — 직전 문단의 "이동 전(저장)" first/end.
    let mut orig_prev_first: Option<i32> = prev_idx
        .and_then(|pp| crate::renderer::float_placement::paragraph_flow_anchor(&paragraphs[pp]));
    let mut orig_prev_end: Option<i32> = prev_idx.and_then(|pp| seg_end(&paragraphs[pp]));
    // 직전 문단이 이번 편집의 변조 대상이었는가 + 직전 문단에 적용된 delta.
    let mut prev_modified = false;
    let mut prev_delta: i32 = 0;

    let mut rejoin_implicit_frames = rejoin_implicit_frames;
    for pi in start_para..paragraphs.len() {
        if paragraphs[pi].line_segs.is_empty() {
            continue;
        }

        let para_modified = pi == start_para || is_ignored(pi);
        let current_start = paragraphs[pi].line_segs[0].vertical_pos;
        let prefix = crate::renderer::float_placement::leading_host_reserve(&paragraphs[pi]);
        let current_anchor = current_start.saturating_sub(prefix);
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
            && prev_stored_bound.is_some_and(|bound| current_anchor < bound);
        let para = &paragraphs[pi];
        let explicit_boundary = !matches!(
            para.column_type,
            crate::model::paragraph::ColumnBreakType::None
        ) || styles
            .para_styles
            .get(para.para_shape_id as usize)
            .is_some_and(|style| style.page_break_before);
        let selected_explicit_boundary = rejoin_implicit_frames && explicit_boundary;
        // 원본 내부 줄 리셋과 개체/단 정의의 별도 배치 규칙은 기존 경로에 남긴다.
        let intra_paragraph_frame = para
            .line_segs
            .iter()
            .skip(1)
            .any(|line| line.vertical_pos == 0)
            || para
                .line_segs
                .windows(2)
                .any(|pair| pair[1].vertical_pos < pair[0].vertical_pos);
        if !para.controls.is_empty()
            || intra_paragraph_frame
            || (explicit_boundary && pi > start_para)
        {
            rejoin_implicit_frames = false;
        }
        let cached_frame_rewind = rejoin_implicit_frames && is_reset && !explicit_boundary;

        let delta = if selected_explicit_boundary || (is_reset && !cached_frame_rewind) {
            // 단/쪽 리셋 경계 — 저장 좌표 유지.
            0
        } else if para_modified || prev_modified || cached_frame_rewind {
            // 변조 인접 경계 — 이동 후 흐름에 스타일 여백 gap 으로 다시 잇는다.
            let gap = prev_idx
                .map(|pp| boundary_gap(&paragraphs[pp], &paragraphs[pi]))
                .unwrap_or(0);
            next_vpos
                .saturating_add(gap)
                .saturating_add(prefix)
                .saturating_sub(current_start)
        } else {
            // 미변조 연속 경계 — 직전 delta 캐리로 기존 간격을 정확히 보존.
            prev_delta
        };

        // 다음 문단의 리셋 감지 기준은 "이동 전(저장)" first/end 로 기록한다.
        let orig_first = current_anchor;
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
    // reset capture는 fallback block max와 다르다. 인증 무효라면 해제 후의 글줄 축을 읽는다.
    crate::renderer::float_placement::effective_host_text_end(para)
}

fn saved_line_advance(line: &LineSeg) -> i32 {
    let height = if line.text_height > 0 {
        line.text_height
    } else {
        line.line_height
    };
    height.saturating_add(line.line_spacing)
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






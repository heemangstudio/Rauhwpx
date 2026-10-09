//! 렌더링 엔진 모듈
//!
//! IR(Document Model) → 렌더 트리 → 백엔드 렌더링 파이프라인을 구현한다.
//! Renderer Trait으로 추상화하여 Canvas/SVG/HTML 백엔드를 선택할 수 있다.

use serde::Serialize;

use crate::model::control::Control;
use crate::model::style::{LineSpacingType, UnderlineType};

pub mod canvas;
pub mod canvaskit_policy;
pub mod composer;
pub mod equation;
pub(crate) mod equation_tac_flow;
pub mod float_placement;
pub mod font_metrics_data;
#[cfg(not(target_arch = "wasm32"))]
pub mod font_paths;
pub(crate) mod form_caption;
pub(crate) mod gradient_fill;
pub mod height_cursor;
pub mod height_measurer;
pub mod hft_glyphs;
mod hft_metrics;
pub mod html;
pub mod hyperlinks;
pub(crate) mod image_header;
pub(crate) mod image_resample;
pub mod image_resolver;
pub mod layer_renderer;
pub mod layout;
pub mod page_layout;
pub mod page_number;
pub mod pagination;
#[cfg(not(target_arch = "wasm32"))]
pub mod pdf;
pub mod pua_oldhangul;
pub mod render_normalization;
pub mod render_tree;
pub(crate) mod ruby;
pub(crate) mod runtime_font_metrics;
pub mod scheduler;
#[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
pub mod skia;
pub(crate) mod static_svg;
pub mod style_resolver;
pub mod svg;
pub mod svg_fragment;
pub mod svg_layer;
mod text_replay_policy;
pub mod typeset;
#[cfg(target_arch = "wasm32")]
pub mod web_canvas;
#[cfg(target_arch = "wasm32")]
pub mod web_picture_cache;

use crate::model::ColorRef;

/// 렌더링 백엔드 종류
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RenderBackend {
    /// Canvas 2D API (1차)
    Canvas,
    /// SVG 엘리먼트 생성 (2차)
    Svg,
    /// HTML DOM 생성 (3차)
    Html,
}

impl RenderBackend {
    /// 문자열로부터 백엔드 파싱
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "canvas" => Some(RenderBackend::Canvas),
            "svg" => Some(RenderBackend::Svg),
            "html" => Some(RenderBackend::Html),
            _ => None,
        }
    }
}

/// 탭 정지 (렌더링용)
#[derive(Debug, Clone, Serialize)]
pub struct TabStop {
    /// 절대 위치 (px, 단 시작 기준)
    pub position: f64,
    /// 탭 종류 (0=왼쪽, 1=오른쪽, 2=가운데, 3=소수점)
    pub tab_type: u8,
    /// 채움 종류 (0=없음, 1=실선, 2=파선, 3=점선)
    pub fill_type: u8,
}

/// 탭 리더(채움 기호) 렌더링 정보
#[derive(Debug, Clone, Serialize)]
pub struct TabLeaderInfo {
    /// 리더 시작 x (run 내 상대 좌표)
    pub start_x: f64,
    /// 리더 끝 x (run 내 상대 좌표)
    pub end_x: f64,
    /// 채움 종류 (1=실선, 2=파선, 3=점선)
    pub fill_type: u8,
}

pub(crate) fn clamp_tab_leader_end_x(
    text: &str,
    char_positions: &[f64],
    leader: &TabLeaderInfo,
    font_size: f64,
) -> f64 {
    let content_stop = text.chars().enumerate().find_map(|(i, ch)| {
        if ch != '\t'
            && !ch.is_whitespace()
            && i < char_positions.len()
            && char_positions[i] > leader.start_x + 0.5
        {
            Some(char_positions[i] - font_size * 0.25)
        } else {
            None
        }
    });
    content_stop
        .map(|stop| stop.min(leader.end_x).max(leader.start_x))
        .unwrap_or(leader.end_x)
}

/// 형광펜(글자 음영) 사각형의 기준선 위 높이 (em). 한컴(macOS)은 음영을 글자 높이
/// 1em 상자로 칠하고 기준선을 그 0.85em 지점에 둔다 — mel-001 p4 15pt 음영
/// = 기준선 −12.72pt ~ +2.4pt.
pub(crate) const SHADE_ASCENT_EM: f64 = 0.85;

/// 점선(채움 3) 탭 리더의 점 배치: 한컴은 글자 크기 1/4 간격의 가운뎃점 글리프로 채우고
/// 마지막 점이 뒤 글자 바로 앞에 닿는다 (aift 목차 돋움체 12.96pt: 3.24pt 간격, 점 지름
/// 약 0.12em). `clamped_end` 는 `clamp_tab_leader_end_x` 결과(뒤 글자 앞 1/4em).
/// 반환: (첫 점 중심 x, 마지막 점 중심 x, 점 지름, 간격). 점이 없으면 None.
pub(crate) fn dot_tab_leader_layout(
    start: f64,
    clamped_end: f64,
    font_size: f64,
) -> Option<(f64, f64, f64, f64)> {
    let pitch = font_size / 4.0;
    let diameter = font_size * 0.12;
    if pitch <= 0.0 {
        return None;
    }
    let last = clamped_end + pitch - diameter / 2.0;
    // 전각 가운뎃점 글리프의 앞쪽 반각 여백은 채우지 않는다. 끝점 기준의
    // 점 위상은 유지하되 앞 글자에 닿는 두 점 자리를 비운다.
    let ink_start = start + font_size * 0.5;
    let count = ((last - ink_start - diameter / 2.0) / pitch).floor();
    if count < 0.0 {
        return None;
    }
    Some((last - count * pitch, last, diameter, pitch))
}

/// 텍스트 렌더링 스타일
#[derive(Debug, Clone, Serialize)]
pub struct TextStyle {
    /// Font substitution policy shared by wrapping and glyph positioning.
    pub font_metrics_policy: crate::model::provenance::FontMetricsPolicy,
    /// 일반 공백을 글꼴 고유 advance 로 잰다 (MS Word 호환 라틴 run, 또는 글자 모양의
    /// "글꼴에 어울리는 빈칸"). 아니면 반각을 유지한다.
    pub latin_space: bool,
    /// 글꼴 이름
    pub font_family: String,
    /// 문서가 선언한 대체 글꼴 face (HWPX `<hh:substFont>` / HWP5 alt_name).
    /// 원본 글꼴 미설치 시 generic 폴백보다 먼저 시도할 이름. 비어 있으면 없음.
    pub font_subst: String,
    /// 문서가 지정한 원본 HFT 글꼴 이름 (HFT 가 아니면 빈 문자열).
    /// `font_family` 는 측정용 대체 서체일 수 있다. 설치된 HFT 윤곽선이 있으면
    /// 렌더러가 글자 모양만 이 서체로 그린다 (`hft_glyphs`).
    pub hft_family: String,
    /// 글자 위치 (CharShape 상대 위치, 글자 크기 비율, 양수 = 아래로).
    /// 줄 배치는 바꾸지 않고 글리프만 기준선에서 옮긴다.
    pub char_offset: f64,
    /// 글꼴 크기 (px)
    pub font_size: f64,
    /// 글자 색상
    pub color: ColorRef,
    /// 진하게
    pub bold: bool,
    /// 기울임
    pub italic: bool,
    /// 밑줄 위치 (None/Bottom/Top)
    pub underline: UnderlineType,
    /// 취소선
    pub strikethrough: bool,
    /// 자간 (px)
    pub letter_spacing: f64,
    /// 장평 비율 (1.0 = 100%, 0.8 = 80%)
    pub ratio: f64,
    /// 글자 모양의 커닝 적용 여부
    pub kerning: bool,
    /// 기본 탭 간격 (px, 0이면 font_size 기반 fallback)
    pub default_tab_width: f64,
    /// 커스텀 탭 정지 목록 (position 오름차순)
    pub tab_stops: Vec<TabStop>,
    /// 문단 오른쪽 끝 자동 탭 여부
    pub auto_tab_right: bool,
    /// 사용 가능 너비 (px, auto_tab_right 계산용)
    pub available_width: f64,
    /// 단 시작으로부터 run 시작 위치 (탭 절대좌표 변환용)
    pub line_x_offset: f64,
    /// 단 시작으로부터 텍스트 영역 시작 위치 (effective_margin_left, px).
    /// auto_tab_right 의 col-relative 위치 = text_start_offset + available_width.
    /// [Task #874] 종전 find_next_tab_stop 의 auto_right 반환값(=available_width) 은
    /// 텍스트-시작-상대 좌표였으나, 호출자(compute_char_positions / pending_right_tab)
    /// 가 col-relative 로 해석해 effective_margin_left 만큼 좌측으로 밀린 정렬 발생.
    /// 본 필드로 변환 보정.
    pub text_start_offset: f64,
    /// auto_tab_right + 다음 run-경계 cross 시 우측 정렬 블록의 총 폭 (px).
    /// composer 가 lang/script 경계로 run 을 쪼개면 (예: "F3→Alt+I" → "F3"/"→"/"Alt+I")
    /// `measure_segment_from` 이 현재 run 의 post-tab chars 만 측정하여 seg_w 가
    /// 과소되고, 우측 정렬이 무너진다. paragraph_layout 에서 line 내 후속 runs 합산
    /// 을 미리 계산해 주입한다. None 이면 기존 동작 (현재 run 내부 측정).
    pub right_tab_block_width_override: Option<f64>,
    /// 탭 리더 정보 (compute_char_positions 후 채움)
    pub tab_leaders: Vec<TabLeaderInfo>,
    /// HWPX 인라인 탭 확장 데이터 ([width, leader, type, ...])
    pub inline_tabs: Vec<[u16; 7]>,
    /// 양쪽 정렬용: 공백 문자당 추가 간격 (px)
    pub extra_word_spacing: f64,
    /// 배분/나눔 정렬용: 글자당 추가 간격 (px)
    pub extra_char_spacing: f64,
    /// 검증된 비격자 일반 글자 압축. 문서 자간의 최소 폭 정책은 바꾸지 않는다.
    #[serde(skip)]
    #[doc(hidden)]
    pub native_negative_spacing: bool,
    /// Legacy compatibility spacing retained in serialized styles.
    /// Literal hyphens are ordinary text; real leaders use `tab_leaders`.
    pub extra_dash_advance: f64,
    /// 외곽선 종류 (0=없음, 1~6=종류)
    pub outline_type: u8,
    /// 그림자 종류 (0=없음, 1=비연속, 2=연속)
    pub shadow_type: u8,
    /// 그림자 색
    pub shadow_color: ColorRef,
    /// 그림자 X 오프셋 (px)
    pub shadow_offset_x: f64,
    /// 그림자 Y 오프셋 (px)
    pub shadow_offset_y: f64,
    /// 양각
    pub emboss: bool,
    /// 음각
    pub engrave: bool,
    /// 위 첨자
    pub superscript: bool,
    /// 아래 첨자
    pub subscript: bool,
    /// 첨자 측정 스타일에서만 쓰는 원래 글자 크기(px). 0 이면 첨자 측정이 아니다.
    /// 한컴(macOS)은 첨자 run 의 빈칸을 줄이지 않고 원래 크기의 em/2 로 조판한다.
    #[serde(skip)]
    pub script_base_size: f64,
    /// 강조점 종류 (0=없음, 1~6)
    pub emphasis_dot: u8,
    /// 밑줄 모양 (표 27 선 종류, 0=실선 ~ 10=삼중선)
    pub underline_shape: u8,
    /// 취소선 모양 (표 27 선 종류, 0=실선 ~ 10=삼중선)
    pub strike_shape: u8,
    /// 밑줄 색상
    pub underline_color: ColorRef,
    /// 취소선 색상
    pub strike_color: ColorRef,
    /// 음영 색 (형광펜, 0xFFFFFF = 없음)
    pub shade_color: ColorRef,
}

impl TextStyle {
    /// 문서 선언 대체를 보존하며 원본 HFT 별칭의 대체 서체를 해소한다.
    /// 미설치 HY신명조 TTF는 함초롬바탕, 신명 HFT 별칭은 한컴바탕을 쓴다.
    pub fn effective_font_subst(&self) -> &str {
        if self.font_subst.is_empty()
            && self.font_family == "HY신명조"
            && !self.hft_family.is_empty()
        {
            "한컴바탕"
        } else {
            &self.font_subst
        }
    }

    /// HFT의 굵게는 원본 폭에 반영하고, 대응 서체의 윤곽선 굵기는 유지한다.
    /// 실제 Bold face 또는 원본보다 가는 명조 대체 서체는 굵게 그린다.
    pub fn paint_bold(&self) -> bool {
        self.bold
            && (self.hft_family.is_empty()
                // 한양신명조의 바탕 대체 윤곽선은 원본 HFT보다 가늘어 획 보정이 필요하다.
                || self.hft_family == "한양신명조"
                || font_metrics_data::find_metric(&self.hft_family, true, self.italic)
                    .is_some_and(|matched| matched.metric.bold)
                || self.font_metrics_policy
                    == crate::model::provenance::FontMetricsPolicy::HancomWindows)
    }

    /// 시각적 bold 여부.
    ///
    /// CharShape.bold=true 외에도 HY헤드라인M 같은 heavy display face 를
    /// 사용할 때 true 를 반환. 해당 face 가 fallback 으로 대체될 때 발생하는
    /// 시각 bold 소실을 보완하기 위해 SVG 출력 시 font-weight="bold" 강제에
    /// 사용된다.
    pub fn is_visually_bold(&self) -> bool {
        self.paint_bold()
            || (self.face_name_weight_applies()
                && (crate::renderer::style_resolver::is_heavy_display_face(&self.font_family)
                    || crate::renderer::style_resolver::is_bold_weight_face(&self.font_family)))
    }

    /// 중고딕 계열(font-weight 500) 여부. SVG/HTML 출력 시 `font-weight: 500` 힌트 삽입에 사용.
    pub fn is_medium_weight(&self) -> bool {
        !self.paint_bold()
            && self.face_name_weight_applies()
            && crate::renderer::style_resolver::is_medium_weight_face(&self.font_family)
    }

    /// face 이름의 굵기 표기(Light/Bold/중고딕 등)를 대체 서체 굵기 힌트로 쓸지.
    /// 한컴이 기본 글꼴로 대체하는 미해석 face 는 이름과 무관하게 보통 굵기로
    /// 그린다 (`hancom_unresolved_face`).
    fn face_name_weight_applies(&self) -> bool {
        !hancom_unresolved_face(style_resolver::primary_font_name(&self.font_family))
    }

    /// CSS/SVG font-weight hint for fallback rendering.
    pub fn css_font_weight(&self) -> Option<&'static str> {
        if self.is_visually_bold() {
            Some("bold")
        } else if self.face_name_weight_applies()
            && crate::renderer::style_resolver::is_light_weight_face(&self.font_family)
        {
            Some("300")
        } else if self.is_medium_weight() {
            Some("500")
        } else {
            None
        }
    }
}

impl Default for TextStyle {
    fn default() -> Self {
        Self {
            font_metrics_policy: Default::default(),
            latin_space: false,
            script_base_size: 0.0,
            font_family: String::new(),
            font_subst: String::new(),
            hft_family: String::new(),
            char_offset: 0.0,
            font_size: 0.0,
            color: 0,
            bold: false,
            italic: false,
            underline: UnderlineType::None,
            strikethrough: false,
            letter_spacing: 0.0,
            ratio: 1.0,
            kerning: false,
            default_tab_width: 0.0,
            tab_stops: Vec::new(),
            auto_tab_right: false,
            available_width: 0.0,
            line_x_offset: 0.0,
            text_start_offset: 0.0,
            right_tab_block_width_override: None,
            tab_leaders: Vec::new(),
            inline_tabs: Vec::new(),
            extra_word_spacing: 0.0,
            extra_char_spacing: 0.0,
            native_negative_spacing: false,
            extra_dash_advance: 0.0,
            outline_type: 0,
            shadow_type: 0,
            shadow_color: 0x00B2B2B2,
            shadow_offset_x: 0.0,
            shadow_offset_y: 0.0,
            emboss: false,
            engrave: false,
            superscript: false,
            subscript: false,
            emphasis_dot: 0,
            underline_shape: 0,
            strike_shape: 0,
            underline_color: 0,
            strike_color: 0,
            shade_color: 0x00FFFFFF,
        }
    }
}

/// 합성 진하게 획 두께 (글자 크기 대비, 획 중심 기준 전체 폭).
///
/// 한컴(macOS) PDF 는 Bold 글꼴이 없는 서체를 `2 Tr`(fill+stroke) 로 그리고
/// 선 굵기를 글자 크기의 1/40 로 준다 (돋움체 10pt 2.075/83, HY견고딕 12pt 2.5/100).
pub(crate) const FAUX_BOLD_STROKE_EM: f64 = 0.025;

/// 실제 Bold 메트릭이 없을 때만 한/글과 같은 가는 합성 획을 추가한다.
/// Bold 서체에 획까지 겹치면 글자가 과하게 두꺼워진다.
pub(crate) fn faux_bold_stroke_width(style: &TextStyle, font_size: f64) -> Option<f64> {
    if !style.paint_bold() {
        return None;
    }
    let primary = style_resolver::primary_font_name(&style.font_family);
    // macOS 한컴이 Bold face 를 제공하지 않는 서체는 DB 의 Windows Bold 메트릭이
    // 있어도 합성하며, 획 비율도 서체별로 다르다.
    if let Some(em) = macos_synthetic_bold_em(primary, style.font_metrics_policy) {
        return Some(font_size * em);
    }
    let bold_fallback = match font_metrics_data::find_metric(primary, true, style.italic) {
        Some(metric) => metric.bold_fallback,
        // 내장 메트릭이 없으면 런타임 레지스트리의 페이스 선택을 따른다.
        None => runtime_font_metrics::bold_fallback(primary, style.italic)?,
    };
    bold_fallback.then_some(font_size * FAUX_BOLD_STROKE_EM)
}

/// macOS 한컴이 Bold face 를 제공하지 않아 굵게를 Regular + 합성 획(`2 Tr`)으로
/// 그리는 서체의 획 비율(글자 크기 대비). 이 서체들의 DB Bold 메트릭은 Windows
/// 글꼴 파일에서 추출한 것으로 참조 환경에는 없으므로 `HcrDeclared`(macOS)
/// 규칙에서는 Bold 메트릭을 무시하고 Regular 폭으로 조판한다. `HancomWindows`
/// 문서는 Windows 한/글이 실제 Bold 글꼴을 쓰므로 대상에서 제외한다.
///
/// 획 비율은 서체마다 다르다 — 한컴 macOS PDF 실측 `w`/Tm 단위:
/// 맑은 고딕 ≈1/30 (2.75/83, 3.325/100, 3.6/108 — landscape-001·hwpx-h-01),
/// 나머지(Haansoft Batang·돋움체·HY견고딕·HMKMM 등) ≈1/40 = FAUX_BOLD_STROKE_EM.
/// 함초롬돋움 처럼 한컴 번들에 Bold face(HCR Dotum Bold)가 있는 서체는
/// 실제 Bold 를 유지하므로 None 반환.
pub(crate) fn macos_synthetic_bold_em(
    font_name: &str,
    policy: crate::model::provenance::FontMetricsPolicy,
) -> Option<f64> {
    if policy == crate::model::provenance::FontMetricsPolicy::HancomWindows {
        return None;
    }
    let n: String = font_name.split_whitespace().collect();
    if n.eq_ignore_ascii_case("malgungothic") || n == "맑은고딕" {
        return Some(1.0 / 30.0);
    }
    None
}

/// 한컴(macOS)이 HFT 서체의 굵게를 합성할 때 글자마다 더하는 advance(글자 크기 대비).
/// 획 두께와 별개다 — 한양신명조 굵게 영문은 획이 거의 그대로인데 글자당 약 1/24em
/// 씩 벌어진다 (복학원서 PDF 세 줄 실측 0.041·0.041·0.044em, HFT 폭 기준).
/// 실측이 없는 HFT 는 None 으로 두어 공통 획 비율을 쓴다.
pub(crate) fn hft_synthetic_bold_advance_em(font_name: &str) -> Option<f64> {
    match font_name.trim() {
        "한양신명조" => Some(1.0 / 24.0),
        _ => None,
    }
}

/// 한양 HFT 한글 글꼴(KS 고정폭, 전각 1em)이 직접 그리는 점 줄임표류인지.
///
/// 한컴은 한글 슬롯의 `․ ‥ …`(U+2024–U+2026)을 한양 HFT 한글 글꼴의 KS 전각
/// 글자로 조판한다 — 복학원서 `휴․복학` 의 점이 한컴 Mac/Windows PDF 모두 1em
/// 칸을 차지한다(대체 TTF 의 0.17–0.29em 이 아니다).
pub(crate) fn hft_hangul_fullwidth_char(font_name: &str, c: char) -> bool {
    matches!(c, '\u{2024}'..='\u{2026}')
        && matches!(
            font_name.trim(),
            "한양신명조" | "한양견명조" | "한양중고딕" | "한양견고딕"
        )
}

/// 위/아래 첨자 glyph 크기 비율. 한컴(macOS) PDF 실측: 15pt 본문 → 9.6pt (80/125 장치 단위).
pub(crate) const SCRIPT_GLYPH_SCALE: f64 = 0.64;
/// 위첨자 기준선 상승량 (기본 글자 크기 대비). 한컴 PDF 실측: 15pt → 6.6pt.
pub(crate) const SUPERSCRIPT_RAISE_EM: f64 = 0.44;
/// 아래첨자 기준선 하강량 (기본 글자 크기 대비). 한컴 PDF 실측: 15pt → 1.8pt.
pub(crate) const SUBSCRIPT_DROP_EM: f64 = 0.12;

/// 위/아래 첨자의 (glyph 크기, 기준선 y 이동량). 모든 렌더러(SVG/Canvas/Skia/HTML)가 공유한다.
/// 진행폭도 같은 비율로 줄어들며, 이는 측정 단계(`text_measurement::script_measure_style`)가
/// 맡으므로 렌더러는 레이아웃 글자 위치를 그대로 쓴다.
pub(crate) fn script_glyph_size_and_shift(style: &TextStyle, base_font_size: f64) -> (f64, f64) {
    let (size, dy) = script_glyph_size_and_shift_only(style, base_font_size);
    (size, dy + char_offset_dy(style))
}

/// 글자 위치(%)에 따른 글리프 기준선 이동량(px, 양수 = 아래로).
///
/// 한컴은 글리프를 글자 크기 비율만큼 내린다(음수는 올림) — onsaemiro 본문(-10%,
/// 9.8pt)이 한컴 PDF 에서 기준선보다 0.96pt 위에 놓인다. 밑줄·취소선은 옮기지 않는다
/// (exam-kor 2쪽: -10% 본문의 밑줄이 원래 기준선 기준 위치에 그대로 있다). 렌더러는
/// `script_glyph_size_and_shift` 로 옮긴 y 에서 이 값을 빼 장식선 y 를 얻는다.
pub(crate) fn char_offset_dy(style: &TextStyle) -> f64 {
    let size = if style.font_size > 0.0 {
        style.font_size
    } else {
        12.0
    };
    size * style.char_offset
}

fn script_glyph_size_and_shift_only(style: &TextStyle, base_font_size: f64) -> (f64, f64) {
    if style.superscript {
        (
            base_font_size * SCRIPT_GLYPH_SCALE,
            -base_font_size * SUPERSCRIPT_RAISE_EM,
        )
    } else if style.subscript {
        (
            base_font_size * SCRIPT_GLYPH_SCALE,
            base_font_size * SUBSCRIPT_DROP_EM,
        )
    } else {
        (base_font_size, 0.0)
    }
}

/// 반각 advance 로 줄인 전각 구두점의 glyph x 오프셋 (슬롯 시작 기준, OpenType `halt` 규칙).
///
/// 한컴(macOS)은 레이아웃에서 전각 `「` 에 반각 칸만 주되 glyph 는 줄이지 않고 그린다.
/// 잉크가 전각 칸 오른쪽 반에 있는 여는 괄호·따옴표는 glyph 를 칸 오른쪽 끝에 맞추고
/// (왼쪽으로 전각−반각 만큼 이동), 잉크가 왼쪽 반에 있는 닫는 쪽은 칸 시작에 둔다.
/// PDF 실측(el-school-001 제목, HY헤드라인M 16pt·자간 -13%): `「` glyph 원점 141.12pt,
/// 다음 글자 155.04pt — 전각 폭에도 슬롯과 같은 자간 비율(0.87)이 적용된 13.92pt.
///
/// `natural` 은 실제로 그릴 glyph 의 advance(장평 반영), `glyph_advance` 는 레이아웃이 준
/// glyph advance(자간 제외, `compute_glyph_positions`). glyph 가 이미 칸에 맞으면 `None` —
/// 렌더러는 기존 배치를 그대로 쓴다. SVG/Canvas/Skia 가 공유한다.
pub(crate) fn halfwidth_punct_glyph_offset(
    cluster: &str,
    natural: f64,
    glyph_advance: f64,
    style: &TextStyle,
) -> Option<f64> {
    let mut chars = cluster.chars();
    let (Some(ch), None) = (chars.next(), chars.next()) else {
        return None;
    };
    if !layout::is_halfwidth_forced_punct(ch) || !natural.is_finite() || glyph_advance <= 0.0 {
        return None;
    }
    // HFT 한 점 지시자는 전각 KS 칸에 놓인다. 대체 TTF 의 좁은 점 글리프는
    // 그 칸 가운데에 두되 원문 advance 와 뒤따르는 글자 위치는 보존한다.
    if ch == '\u{2024}'
        && !style.hft_family.is_empty()
        && style.font_metrics_policy == crate::model::provenance::FontMetricsPolicy::HcrDeclared
        && glyph_advance > natural
    {
        return Some((glyph_advance - natural) / 2.0);
    }
    // 여는 쪽(Unicode Ps/Pi): 잉크가 전각 칸의 오른쪽 반에 있다.
    let opening = matches!(
        ch,
        '\u{2018}' | '\u{201B}' | '\u{201C}' | '\u{201F}' | '\u{300C}'
    );
    // 자간(%)은 glyph 진행폭에 비례하므로 전각 폭에도 같은 비율을 적용한다.
    let font_size = if style.font_size > 0.0 {
        style.font_size
    } else {
        12.0
    };
    let spacing_scale = (1.0 + style.letter_spacing / font_size).max(0.0);
    // 축소 케이스: 조판이 advance 를 자연 폭보다 좁혔다. 여는 괄호는 칸 오른쪽에
    // 붙여야 하므로 왼쪽으로 (natural - advance) 만큼, 닫는 괄호는 원위치.
    if natural > glyph_advance * 1.2 {
        return if opening {
            Some((glyph_advance - natural) * spacing_scale)
        } else {
            Some(0.0)
        };
    }
    // 확장 케이스: 조판 advance(폰트 기록 전각)가 paint 서체 자연 폭보다 넓다 —
    // 「」가 HFT 조판폭(전각)에 함초롬 계열 치환 글리프(반각, 잉크가 칸 안쪽에
    // 붙는 형태)로 그려지는 경우. 여는 「 는 잉크를 칸 오른쪽에 붙인다
    // (36-apartment-form 지원제외대상 표 실측); 닫는 」는 잉크가 칸 왼쪽이라 0.
    if opening && layout::is_halfwidth_cjk_quote(ch) && glyph_advance > natural * 1.2 {
        return Some((glyph_advance - natural) * spacing_scale);
    }
    None
}

/// run 전체에 `halfwidth_punct_glyph_offset` 을 적용한 (글자 index, glyph x 오프셋) 목록.
///
/// 레이어 트리 JSON 으로 글자를 재생하는 backend(CanvasKit)가 규칙을 복제하지 않도록
/// 엔진이 계산해 내보낸다. natural 폭은 SVG 와 같이 등록 글꼴 메트릭 기준이며,
/// 0 이 아닌 오프셋(여는 괄호·따옴표)만 담는다.
pub(crate) fn halfwidth_punct_glyph_offsets(text: &str, style: &TextStyle) -> Vec<(usize, f64)> {
    if !text.chars().any(layout::is_halfwidth_forced_punct) {
        return Vec::new();
    }
    let glyph_positions = layout::compute_glyph_positions(text, style);
    let ratio = if style.ratio > 0.0 { style.ratio } else { 1.0 };
    let mut utf8 = [0u8; 4];
    text.chars()
        .enumerate()
        .filter_map(|(idx, ch)| {
            if !layout::is_halfwidth_forced_punct(ch) {
                return None;
            }
            let natural = if ch == '\u{2024}' && !style.hft_family.is_empty() {
                hft_substitute_faces(&style.hft_family)
                    .iter()
                    .find_map(|family| {
                        let mut paint_style = style.clone();
                        paint_style.font_family = (*family).into();
                        paint_style.hft_family.clear();
                        layout::registered_glyph_advance(ch, &paint_style)
                    })
            } else {
                layout::registered_glyph_advance(ch, style)
            }? * ratio;
            let advance = glyph_positions.get(idx + 1)? - glyph_positions.get(idx)?;
            let offset =
                halfwidth_punct_glyph_offset(ch.encode_utf8(&mut utf8), natural, advance, style)?;
            (offset != 0.0).then_some((idx, offset))
        })
        .collect()
}

#[cfg(test)]
mod faux_bold_tests {
    use super::{faux_bold_stroke_width, TextStyle};

    #[test]
    fn hft_fallback_keeps_layout_bold_without_synthetic_paint() {
        let mut style = TextStyle {
            font_family: "한양중고딕".into(),
            hft_family: "한양중고딕".into(),
            font_metrics_policy: crate::model::provenance::FontMetricsPolicy::HcrDeclared,
            bold: true,
            ..TextStyle::default()
        };
        assert!(style.bold);
        assert!(!style.paint_bold());
        assert_eq!(faux_bold_stroke_width(&style, 16.0), None);
        assert!(!crate::paint::paint_op::PaintTextStyle::from(&style).bold);
        style.hft_family = "한양신명조".into();
        style.font_family = "한양신명조".into();
        assert!(style.paint_bold());
        style.hft_family = "HCI Poppy".into();
        style.font_family = "HCI Poppy".into();
        assert!(style.paint_bold());
        style.hft_family.clear();
        assert!(style.paint_bold());
        style.hft_family = "한양중고딕".into();
        style.font_metrics_policy = crate::model::provenance::FontMetricsPolicy::HancomWindows;
        assert!(style.paint_bold());
    }

    #[test]
    fn hft_dot_is_centered_without_changing_its_source_advance() {
        let style = TextStyle {
            font_family: "한양신명조".into(),
            hft_family: "한양신명조".into(),
            font_size: 16.0,
            font_metrics_policy: crate::model::provenance::FontMetricsPolicy::HcrDeclared,
            ..Default::default()
        };
        assert_eq!(
            super::halfwidth_punct_glyph_offset("․", 2.56, 16.0, &style),
            Some(6.72)
        );
        let offsets = super::halfwidth_punct_glyph_offsets("가․나", &style);
        assert_eq!(offsets.len(), 1, "{offsets:?}");
        assert_eq!(offsets[0].0, 1);
        assert!(offsets[0].1 > 5.0 && offsets[0].1 < 7.0, "{offsets:?}");
        let positions = super::layout::compute_char_positions("가․나", &style);
        assert_eq!(positions, vec![0.0, 16.0, 32.0, 48.0]);
        let regular = TextStyle {
            hft_family: String::new(),
            ..style.clone()
        };
        assert_eq!(
            super::halfwidth_punct_glyph_offset("․", 2.56, 16.0, &regular),
            None
        );
        let windows = TextStyle {
            font_metrics_policy: crate::model::provenance::FontMetricsPolicy::HancomWindows,
            ..style
        };
        assert_eq!(
            super::halfwidth_punct_glyph_offset("․", 2.56, 16.0, &windows),
            None
        );
    }

    #[test]
    fn stroke_is_only_needed_when_bold_metrics_are_missing() {
        let mut style = TextStyle {
            font_family: "함초롬돋움".into(),
            bold: true,
            ..TextStyle::default()
        };
        assert_eq!(faux_bold_stroke_width(&style, 17.3), None);

        style.font_family = "굴림체".into();
        assert_eq!(faux_bold_stroke_width(&style, 16.0), Some(0.4));

        style.bold = false;
        assert_eq!(faux_bold_stroke_width(&style, 16.0), None);
    }
}

/// 패턴 채우기 정보 (HWP pattern_type 1~6)
#[derive(Debug, Clone, Copy, Serialize)]
pub struct PatternFillInfo {
    /// 패턴 종류 (1=가로줄, 2=세로줄, 3=역대각선, 4=대각선, 5=십자, 6=격자)
    pub pattern_type: i32,
    /// 무늬색
    pub pattern_color: ColorRef,
    /// 배경색
    pub background_color: ColorRef,
}

/// 도형 렌더링 스타일
#[derive(Debug, Clone, Serialize)]
pub struct ShapeStyle {
    /// 채우기 색상 (None이면 채우기 없음)
    pub fill_color: Option<ColorRef>,
    /// 패턴 채우기 (pattern_type > 0일 때)
    pub pattern: Option<PatternFillInfo>,
    /// 테두리 색상
    pub stroke_color: Option<ColorRef>,
    /// 테두리 두께 (px)
    pub stroke_width: f64,
    /// 테두리 종류
    pub stroke_dash: StrokeDash,
    /// 투명도 (0.0=완전투명, 1.0=불투명)
    pub opacity: f64,
    /// 그림자 (None이면 그림자 없음)
    pub shadow: Option<ShadowStyle>,
}

/// 도형 그림자 스타일
#[derive(Debug, Clone, Serialize)]
pub struct ShadowStyle {
    /// 그림자 종류 (1~8)
    pub shadow_type: u32,
    /// 그림자 색상
    pub color: ColorRef,
    /// X 오프셋 (px)
    pub offset_x: f64,
    /// Y 오프셋 (px)
    pub offset_y: f64,
    /// 투명도 (0~255, 0=불투명)
    pub alpha: u8,
}

impl Default for ShapeStyle {
    fn default() -> Self {
        Self {
            fill_color: None,
            pattern: None,
            stroke_color: None,
            stroke_width: 0.0,
            stroke_dash: StrokeDash::default(),
            opacity: 1.0,
            shadow: None,
        }
    }
}

/// 그라데이션 채우기 렌더링 정보
#[derive(Debug, Clone, Serialize)]
pub struct GradientFillInfo {
    /// 유형 (1: 줄무늬/선형, 2: 원형, 3: 원뿔형, 4: 사각형)
    pub gradient_type: i16,
    /// 기울임 각도 (도)
    pub angle: i16,
    /// 가로 중심 (%)
    pub center_x: i16,
    /// 세로 중심 (%)
    pub center_y: i16,
    /// 번짐 단계 (HWPX step, 모델 blur)
    pub step: i16,
    /// 번짐 중심 (%)
    pub step_center: u8,
    /// 색상 목록 (ColorRef)
    pub colors: Vec<ColorRef>,
    /// 색상 위치 (0.0~1.0 정규화)
    pub positions: Vec<f64>,
}

/// 글자 겹치기 안쪽 글자 크기 비율 (`charSz`).
/// 양수는 백분율, 음수는 10% 단계 축소 (한컴 PDF 실측: -2 → 0.8, 17pt→13.56pt;
/// -3 → 0.7), 0 은 100%.
pub fn char_overlap_inner_ratio(inner_char_size: i8) -> f64 {
    match inner_char_size {
        n if n > 0 => f64::from(n) / 100.0,
        n if n < 0 => (1.0 + f64::from(n) * 0.10).max(0.1),
        _ => 1.0,
    }
}

/// 글자 겹치기 테두리 도형을 그리는 글자. 한컴(macOS)은 테두리를 도형으로 긋지 않고
/// 런 글꼴의 도형 글자를 런 크기·기준선 그대로 찍는다 (k-water-rfp `❸` 실측: 17pt
/// HY헤드라인M `■` 글리프 위에 흰 13.56pt 숫자). 삼각형 등은 기존 도형 경로를 쓴다.
pub fn char_overlap_shape_glyph(border_type: u8) -> Option<char> {
    match border_type {
        1 => Some('○'),
        2 => Some('●'),
        3 => Some('□'),
        4 => Some('■'),
        _ => None,
    }
}

impl GradientFillInfo {
    /// 모델 그라데이션 → 렌더링 정보. 원형은 한컴처럼 계단 색으로 펼친다.
    pub fn from_model(g: &crate::model::style::GradientFill) -> Self {
        let n = g.colors.len();
        let positions: Vec<f64> = if g.positions.is_empty() {
            (0..n).map(|i| i as f64 / (n.max(2) - 1) as f64).collect()
        } else {
            g.positions.iter().map(|&p| p as f64 / 100.0).collect()
        };
        let (colors, positions) = if g.gradient_type == 2 {
            hancom_radial_steps(&g.colors, &positions, g.blur, g.step_center)
        } else {
            (g.colors.clone(), positions)
        };
        Self {
            gradient_type: g.gradient_type,
            angle: g.angle,
            center_x: g.center_x,
            center_y: g.center_y,
            step: g.blur,
            step_center: g.step_center,
            colors,
            positions,
        }
    }
}

/// 한컴 원형 그라데이션의 계단 색 stop (같은 위치에 두 stop 을 둬 경계를 끊는다).
///
/// 한컴 Mac PDF 실측 (k-water-rfp 표지 셀 step 26·stepCenter 44, 2.1 절 사각형 step 50·
/// stepCenter 50): 반지름 max(w,h)/2 를 `step` 개 동심원 띠로 나누고, 안쪽 절반의 띠가
/// 중심~stepCenter%, 바깥 절반이 stepCenter%~가장자리를 고르게 덮는다. 중심에서 k 번째
/// 띠 색은 첫 색 + trunc((끝 색 - 첫 색)·k/(step-1)) (채널별 정수 버림).
fn hancom_radial_steps(
    colors: &[ColorRef],
    positions: &[f64],
    steps: i16,
    step_center: u8,
) -> (Vec<ColorRef>, Vec<f64>) {
    if colors.len() < 2 || positions.len() != colors.len() || steps < 2 {
        return (colors.to_vec(), positions.to_vec());
    }
    let n = steps.min(256) as usize;
    let inner = n / 2;
    let outer = n - inner;
    let c = (f64::from(step_center) / 100.0).clamp(0.0, 1.0);
    let edge = |k: usize| -> f64 {
        if k <= inner {
            c * k as f64 / inner.max(1) as f64
        } else {
            c + (1.0 - c) * (k - inner) as f64 / outer as f64
        }
    };
    // 띠 k 의 색: 색 목록 구간에서 정수 버림 보간
    let band_color = |k: usize| -> ColorRef {
        let u = k as f64 / (n - 1) as f64;
        let seg = positions
            .windows(2)
            .position(|w| u <= w[1])
            .unwrap_or(positions.len() - 2);
        let (p0, p1) = (positions[seg], positions[seg + 1]);
        let f = if p1 > p0 {
            ((u - p0) / (p1 - p0)).clamp(0.0, 1.0)
        } else {
            1.0
        };
        let (a, b) = (colors[seg], colors[seg + 1]);
        let ch = |shift: u32| -> u32 {
            let ca = ((a >> shift) & 0xFF) as f64;
            let cb = ((b >> shift) & 0xFF) as f64;
            ((ca + ((cb - ca) * f + 1e-9 * (cb - ca).signum()).trunc()).clamp(0.0, 255.0) as u32)
                << shift
        };
        (a & 0xFF00_0000) | ch(16) | ch(8) | ch(0)
    };
    let mut out_colors = Vec::with_capacity(n * 2);
    let mut out_positions = Vec::with_capacity(n * 2);
    for k in 0..n {
        let color = band_color(k);
        out_colors.push(color);
        out_positions.push(edge(k));
        out_colors.push(color);
        out_positions.push(edge(k + 1));
    }
    (out_colors, out_positions)
}

/// 선 렌더링 스타일
#[derive(Debug, Clone, Default, Serialize)]
pub struct LineStyle {
    /// 선 색상
    pub color: ColorRef,
    /// 선 두께 (px)
    pub width: f64,
    /// 선 종류
    pub dash: StrokeDash,
    /// 선 렌더링 종류 (이중선/삼중선 등)
    pub line_type: LineRenderType,
    /// 시작 화살표
    pub start_arrow: ArrowStyle,
    /// 끝 화살표
    pub end_arrow: ArrowStyle,
    /// 시작 화살표 크기 (HWP bits 22-25: 0=작은-작은 ~ 8=큰-큰)
    pub start_arrow_size: u8,
    /// 끝 화살표 크기 (HWP bits 26-29)
    pub end_arrow_size: u8,
    /// 그림자
    pub shadow: Option<ShadowStyle>,
}

/// 테두리 점선 종류
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub enum StrokeDash {
    #[default]
    Solid,
    Dash,
    LongDash,
    Dot,
    Circle,
    DashDot,
    DashDotDot,
}

/// 점선(Dot) 대시 간격 (선 그리기 단위, on/off 순).
/// 한컴은 선 굵기 w 에 비례해 [4w/3 선분, 2w 공백]로 그린다 — 한컴 PDF 출력에서
/// 0.36pt 선이 [0.48 on, 0.72 off] 로, 0.24pt 선이 [0.36, 0.48] 로 나오는 것으로 확인.
/// (OWPML 명명 뒤바뀜으로 HWPX XML "DASH" 가 이 변형이다)
/// 고정 px 패턴을 쓰면 가는 표 안선에서 점이 지나치게 성기게 나온다.
pub fn dot_dash_segments(width: f64) -> (f64, f64) {
    let w = width.max(0.2); // 0 에 가까운 선폭에서 대시가 사라지지 않게 하한만 둔다
    (w * 4.0 / 3.0, w * 2.0)
}

/// 선 렌더링 종류 (이중선/삼중선)
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub enum LineRenderType {
    #[default]
    Single,
    /// 이중선 (같은 굵기)
    Double,
    /// 가는선-굵은선 이중선
    ThinThickDouble,
    /// 굵은선-가는선 이중선
    ThickThinDouble,
    /// 가는선-굵은선-가는선 삼중선
    ThinThickThinTriple,
}

/// 화살표 스타일
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub enum ArrowStyle {
    #[default]
    None,
    /// 화살 모양 (채움)
    Arrow,
    /// 오목한 화살 모양 (채움)
    ConcaveArrow,
    /// 속이 빈 다이아몬드
    OpenDiamond,
    /// 속이 빈 원
    OpenCircle,
    /// 속이 빈 사각
    OpenSquare,
    /// 속이 채운 다이아몬드
    Diamond,
    /// 속이 채운 원
    Circle,
    /// 속이 채운 사각
    Square,
}

/// 패스 커맨드 (벡터 도형용)
#[derive(Debug, Clone, Copy, Serialize)]
pub enum PathCommand {
    MoveTo(f64, f64),
    LineTo(f64, f64),
    CurveTo(f64, f64, f64, f64, f64, f64),
    /// SVG arc: (rx, ry, x_rotation, large_arc_flag, sweep_flag, x, y)
    ArcTo(f64, f64, f64, bool, bool, f64, f64),
    ClosePath,
}

/// SVG arc(endpoint parameterization)를 cubic bezier 곡선으로 변환
///
/// SVG spec: Implementation Notes - Arc Conversion
/// (x1, y1): 시작점, (x2, y2): 끝점, rx/ry: 반지름,
/// phi: x축 회전(도), large_arc/sweep: 플래그
pub fn svg_arc_to_beziers(
    x1: f64,
    y1: f64,
    mut rx: f64,
    mut ry: f64,
    phi_deg: f64,
    large_arc: bool,
    sweep: bool,
    x2: f64,
    y2: f64,
) -> Vec<PathCommand> {
    use std::f64::consts::PI;

    let mut result = Vec::new();

    // 퇴화 케이스: 시작점 == 끝점
    if (x1 - x2).abs() < 1e-6 && (y1 - y2).abs() < 1e-6 {
        return result;
    }
    // 퇴화 케이스: 반지름 0
    rx = rx.abs();
    ry = ry.abs();
    if rx < 1e-6 || ry < 1e-6 {
        result.push(PathCommand::LineTo(x2, y2));
        return result;
    }

    let phi = phi_deg.to_radians();
    let cos_phi = phi.cos();
    let sin_phi = phi.sin();

    // Step 1: (x1', y1') 계산
    let dx = (x1 - x2) / 2.0;
    let dy = (y1 - y2) / 2.0;
    let x1p = cos_phi * dx + sin_phi * dy;
    let y1p = -sin_phi * dx + cos_phi * dy;

    // Step 2: 반지름 보정 (너무 작은 경우 확대)
    let x1p2 = x1p * x1p;
    let y1p2 = y1p * y1p;
    let lambda = x1p2 / (rx * rx) + y1p2 / (ry * ry);
    if lambda > 1.0 {
        let s = lambda.sqrt();
        rx *= s;
        ry *= s;
    }
    let rx2 = rx * rx;
    let ry2 = ry * ry;

    // Step 3: 중심점' (cx', cy') 계산
    let num = (rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2).max(0.0);
    let den = rx2 * y1p2 + ry2 * x1p2;
    let sq = if den > 1e-10 { (num / den).sqrt() } else { 0.0 };
    let sign = if large_arc == sweep { -1.0 } else { 1.0 };
    let cxp = sign * sq * rx * y1p / ry;
    let cyp = sign * sq * (-ry * x1p) / rx;

    // Step 4: 중심점 (cx, cy) 계산
    let cx = cos_phi * cxp - sin_phi * cyp + (x1 + x2) / 2.0;
    let cy = sin_phi * cxp + cos_phi * cyp + (y1 + y2) / 2.0;

    // Step 5: θ1 (시작 각도), dθ (호 각도) 계산
    let theta1 = ((y1p - cyp) / ry).atan2((x1p - cxp) / rx);
    let theta2 = ((-y1p - cyp) / ry).atan2((-x1p - cxp) / rx);
    let mut dtheta = theta2 - theta1;

    if !sweep && dtheta > 0.0 {
        dtheta -= 2.0 * PI;
    }
    if sweep && dtheta < 0.0 {
        dtheta += 2.0 * PI;
    }

    // 호를 최대 90° 세그먼트로 분할하여 bezier 근사
    let n_segs = (dtheta.abs() / (PI / 2.0 + 0.001)).ceil().max(1.0) as usize;
    let seg_angle = dtheta / n_segs as f64;

    for i in 0..n_segs {
        let t1 = theta1 + seg_angle * i as f64;
        let t2 = theta1 + seg_angle * (i + 1) as f64;

        // 호 세그먼트의 bezier 제어점 계산
        // alpha = 4/3 * tan(segment_angle / 4)
        let alpha = 4.0 / 3.0 * (seg_angle / 4.0).tan();

        let cos_t1 = t1.cos();
        let sin_t1 = t1.sin();
        let cos_t2 = t2.cos();
        let sin_t2 = t2.sin();

        // 단위 원 위의 제어점 (반지름 적용 전)
        let ep1x = cos_t1 - alpha * sin_t1;
        let ep1y = sin_t1 + alpha * cos_t1;
        let ep2x = cos_t2 + alpha * sin_t2;
        let ep2y = sin_t2 - alpha * cos_t2;

        // 반지름 적용
        let cp1x = rx * ep1x;
        let cp1y = ry * ep1y;
        let cp2x = rx * ep2x;
        let cp2y = ry * ep2y;
        let endx = rx * cos_t2;
        let endy = ry * sin_t2;

        // 회전(phi) + 이동(cx, cy) 적용
        result.push(PathCommand::CurveTo(
            cos_phi * cp1x - sin_phi * cp1y + cx,
            sin_phi * cp1x + cos_phi * cp1y + cy,
            cos_phi * cp2x - sin_phi * cp2y + cx,
            sin_phi * cp2x + cos_phi * cp2y + cy,
            cos_phi * endx - sin_phi * endy + cx,
            sin_phi * endx + cos_phi * endy + cy,
        ));
    }

    result
}

/// 렌더러 트레이트 (모든 백엔드가 구현)
pub trait Renderer {
    /// 페이지 렌더링 시작
    fn begin_page(&mut self, width: f64, height: f64);
    /// 페이지 렌더링 종료
    fn end_page(&mut self);

    /// 텍스트 그리기
    fn draw_text(&mut self, text: &str, x: f64, y: f64, style: &TextStyle);
    /// 사각형 그리기 (corner_radius > 0이면 둥근 모서리)
    fn draw_rect(&mut self, x: f64, y: f64, w: f64, h: f64, corner_radius: f64, style: &ShapeStyle);
    /// 선 그리기
    fn draw_line(&mut self, x1: f64, y1: f64, x2: f64, y2: f64, style: &LineStyle);
    /// 타원 그리기
    fn draw_ellipse(&mut self, cx: f64, cy: f64, rx: f64, ry: f64, style: &ShapeStyle);
    /// 이미지 그리기
    fn draw_image(&mut self, data: &[u8], x: f64, y: f64, w: f64, h: f64);
    /// 패스 그리기 (벡터 도형)
    fn draw_path(&mut self, commands: &[PathCommand], style: &ShapeStyle);
}

/// HWPUNIT → 픽셀 변환 (96 DPI 기준)
pub const DEFAULT_DPI: f64 = 96.0;
pub const HWPUNIT_PER_INCH: f64 = 7200.0;

/// LINE_SEG line_height가 줄의 최대 글자 크기보다 작으면
/// ParaShape의 줄간격 설정으로 재계산한다.
/// height_measurer와 layout 양쪽에서 동일 로직을 사용해야 한다.
#[inline]
pub fn corrected_line_height(
    raw_lh: f64,
    max_fs: f64,
    ls_type: LineSpacingType,
    ls_val: f64,
) -> f64 {
    if max_fs > 0.0 && raw_lh < max_fs {
        match ls_type {
            LineSpacingType::Percent => max_fs * ls_val / 100.0,
            LineSpacingType::Fixed => ls_val.max(max_fs),
            LineSpacingType::SpaceOnly => max_fs + ls_val,
            LineSpacingType::Minimum => ls_val.max(max_fs),
        }
    } else {
        raw_lh
    }
}

/// LINE_SEG의 line_height/line_spacing 의미를 보존하면서 폴백 line_height를 보정한다.
///
/// raw line_height가 글자 크기보다 작은 합성 줄은 한컴의
/// `(line_height=base, line_spacing=extra)` 모델에 맞춰 분해한다.
#[inline]
pub fn corrected_line_metrics(
    raw_lh: f64,
    raw_ls: f64,
    max_fs: f64,
    ls_type: LineSpacingType,
    ls_val: f64,
) -> (f64, f64) {
    if max_fs > 0.0 && raw_lh < max_fs {
        match ls_type {
            LineSpacingType::Percent => {
                // [#2279] sub-100% 퍼센트 음수 gap 존중 (line_breaking 정합)
                let extra = if ls_val > 0.0 {
                    max_fs * (ls_val - 100.0) / 100.0
                } else {
                    0.0
                };
                (max_fs, extra)
            }
            LineSpacingType::Fixed => (ls_val.max(max_fs), 0.0),
            LineSpacingType::SpaceOnly => (max_fs, ls_val.max(0.0)),
            LineSpacingType::Minimum => (ls_val.max(max_fs), 0.0),
        }
    } else {
        (raw_lh, raw_ls)
    }
}

/// 구역 첫 문단의 저장 줄 metrics를 재조판할 수 있는 구조인가.
///
/// `SectionDef`와 `ColumnDef`가 함께 들어 있는 문단은 본문 첫 줄을 선언하는
/// HWPX 구조다. task2093처럼 해당 첫 줄의 저장 좌표계 전체가 오래된 경우에만
/// 줄 높이와 baseline을 글꼴 기준으로 다시 계산한다. 일반 본문/미주 문단의 큰
/// 줄 높이는 의도된 조판일 수 있으므로 이 보정 대상이 아니다.
#[inline]
pub(crate) fn controls_mark_section_start(controls: &[Control]) -> bool {
    let mut has_section_def = false;
    let mut has_column_def = false;

    for control in controls {
        match control {
            Control::SectionDef(_) => has_section_def = true,
            Control::ColumnDef(_) => has_column_def = true,
            Control::Bookmark(_) => {}
            _ => return false,
        }
    }

    has_section_def && has_column_def
}

const STALE_SOURCE_LINE_ADVANCE_MULTIPLIER: f64 = 40.0;

/// 조합 줄의 최대 글꼴 크기를 구한다.
///
/// 문단 선두의 구역/단 정의처럼 가시 문자가 아닌 control이 UTF-16 stream offset을
/// 앞당기면, 조합 과정에서 줄 run의 글자 모양을 해소하지 못하는 문서가 있다. 이때도
/// 해당 줄 시작 위치의 `CharShapeRef`는 원본 문단에 남아 있으므로 이를 보조 근거로
/// 사용한다. run에서 얻은 유효한 크기가 있으면 그것을 항상 우선한다.
pub(crate) fn composed_line_max_font_size(
    line: &composer::ComposedLine,
    para: &crate::model::paragraph::Paragraph,
    styles: &style_resolver::ResolvedStyleSet,
) -> f64 {
    let run_max = line
        .runs
        .iter()
        .filter_map(|run| {
            styles
                .char_styles
                .get(run.char_style_id as usize)
                .map(|style| style.font_size)
        })
        .fold(0.0f64, f64::max);

    if run_max > 0.0 {
        return run_max;
    }

    para.char_shape_id_at(line.char_start)
        .or_else(|| para.char_shapes.first().map(|shape| shape.char_shape_id))
        .and_then(|shape_id| styles.char_styles.get(shape_id as usize))
        .map(|style| style.font_size)
        .unwrap_or(0.0)
}

/// 한컴의 글꼴 기준 줄 상자 높이. 글꼴의 hhea/typographic 수직 메트릭에
/// 한컴의 줄 상자 여유(130%)를 적용한다. 실폰트가 없으면 일반 CJK 수직
/// 메트릭(1.3em)을 사용한다.
pub(crate) fn composed_line_font_box_height(
    line: &composer::ComposedLine,
    styles: &style_resolver::ResolvedStyleSet,
) -> f64 {
    line.runs
        .iter()
        .filter_map(|run| {
            let style = styles.char_styles.get(run.char_style_id as usize)?;
            Some(char_style_font_box_height(style, run.lang_index))
        })
        .fold(0.0, f64::max)
}

pub(crate) fn char_style_font_box_height(
    style: &style_resolver::ResolvedCharStyle,
    lang_index: usize,
) -> f64 {
    let face = style.font_family_for_lang(lang_index);
    #[cfg(not(target_arch = "wasm32"))]
    let ratio = font_paths::custom_face_line_height_ratio(face, style.bold, style.italic)
        .or_else(|| runtime_font_metrics::line_height_ratio(face, style.bold, style.italic));
    #[cfg(target_arch = "wasm32")]
    let ratio = runtime_font_metrics::line_height_ratio(face, style.bold, style.italic);
    style.font_size * ratio.unwrap_or(1.3) * line_box_script_scale(lang_index)
}

/// 한컴의 CJK 줄 상자는 글꼴 hhea 높이의 130%, 라틴/기타 문자는 hhea 높이 그대로다.
fn line_box_script_scale(lang_index: usize) -> f64 {
    if matches!(lang_index, 0 | 2 | 3) {
        1.3
    } else {
        1.0
    }
}

/// 생성된 줄의 기준선: 폰트 어센트에 글꼴 줄 상자의 추가 여백 절반을 더한다.
/// 실폰트가 없으면 원본 기준선을 보존하도록 None을 반환한다.
pub(crate) fn char_style_font_baseline_distance(
    style: &style_resolver::ResolvedCharStyle,
    lang_index: usize,
) -> Option<f64> {
    let face = style.font_family_for_lang(lang_index);
    #[cfg(not(target_arch = "wasm32"))]
    let ratios = font_paths::custom_face_line_height_ratio(face, style.bold, style.italic)
        .zip(font_paths::custom_face_ascender_ratio(
            face,
            style.bold,
            style.italic,
        ))
        .or_else(|| {
            runtime_font_metrics::line_height_ratio(face, style.bold, style.italic).zip(
                runtime_font_metrics::ascender_ratio(face, style.bold, style.italic),
            )
        });
    #[cfg(target_arch = "wasm32")]
    let ratios = runtime_font_metrics::line_height_ratio(face, style.bold, style.italic).zip(
        runtime_font_metrics::ascender_ratio(face, style.bold, style.italic),
    );
    ratios.map(|(line_height, ascent)| {
        style.font_size * (ascent + (line_box_script_scale(lang_index) - 1.0) * line_height / 2.0)
    })
}

pub(crate) fn composed_line_font_baseline_distance(
    line: &composer::ComposedLine,
    styles: &style_resolver::ResolvedStyleSet,
) -> Option<f64> {
    line.runs
        .iter()
        .filter_map(|run| {
            let style = styles.char_styles.get(run.char_style_id as usize)?;
            char_style_font_baseline_distance(style, run.lang_index)
        })
        .reduce(f64::max)
}

/// 순수 텍스트 줄의 저장 metrics가 글자와 문단 스타일로부터 가능한 줄 advance보다
/// 현저히 크면 한컴처럼 재조판한다. 개체가 없는 줄에서 `line_height`와
/// `text_height`가 모두 비정상적으로 큰 값이면 저장 조판 정보가 현재 텍스트와 맞지
/// 않는다. 원본 IR은 보존하고 렌더/조판용 metrics만 바꾼다.
///
/// 40배는 10pt/160% 줄이 A4 본문 한 쪽에 가까운 높이를 단일 줄에 기록한 경우만
/// 잡는다. 이보다 작은 큰 줄은 하단 고정 틀의 fit 경계처럼 의도된 저장 조판일 수 있다.
#[inline]
pub(crate) fn source_line_metrics_need_reflow(
    raw_lh: f64,
    raw_text_height: f64,
    max_fs: f64,
    ls_type: LineSpacingType,
    ls_val: f64,
    source_metrics_reflow_eligible: bool,
) -> bool {
    if !source_metrics_reflow_eligible || max_fs <= 0.0 || raw_lh <= 0.0 || raw_text_height <= 0.0 {
        return false;
    }

    let (expected_lh, expected_ls) = corrected_line_metrics(0.0, 0.0, max_fs, ls_type, ls_val);
    let expected_advance = (expected_lh + expected_ls).max(max_fs);

    raw_lh > expected_advance * STALE_SOURCE_LINE_ADVANCE_MULTIPLIER
        && raw_text_height > expected_advance * STALE_SOURCE_LINE_ADVANCE_MULTIPLIER
}

/// 저장 줄 metrics를 재조판하는 경우의 baseline을 글꼴 기준으로 복원한다.
///
/// 원본 `baseline_distance`도 손상된 `line_height` 좌표계에 기록되므로, 줄 높이만
/// 낮추고 baseline을 그대로 두면 SVG/Canvas 텍스트가 페이지 하단으로 이탈한다.
#[inline]
pub(crate) fn corrected_line_baseline_for_source(
    raw_baseline: f64,
    max_fs: f64,
    source_metrics_reflowed: bool,
) -> f64 {
    if source_metrics_reflowed {
        max_fs * 0.85
    } else {
        raw_baseline
    }
}

/// 문단의 단일 저장 줄이 현재 글꼴/문단 스타일 기준으로 재조판 대상인지 판별한다.
///
/// 이 판정은 HWPX의 손상된 첫 줄이 이후 문단의 `vertical_pos`까지 크게 밀어 둔
/// 경우에만 사용한다. 원본 줄 배열은 바꾸지 않고, 페이지네이터와 렌더러가 같은
/// 조판 커서 보정 여부를 결정하는 데 쓴다.
pub(crate) fn paragraph_source_line_metrics_need_reflow(
    para: &crate::model::paragraph::Paragraph,
    styles: &style_resolver::ResolvedStyleSet,
    dpi: f64,
) -> bool {
    if !controls_mark_section_start(&para.controls)
        || !para
            .text
            .chars()
            .any(|ch| ch > '\u{001F}' && ch != '\u{FFFC}')
    {
        return false;
    }

    let [line] = para.line_segs.as_slice() else {
        return false;
    };
    let max_fs = para
        .char_shape_id_at(0)
        .or_else(|| para.char_shapes.first().map(|shape| shape.char_shape_id))
        .and_then(|shape_id| styles.char_styles.get(shape_id as usize))
        .map(|style| style.font_size)
        .unwrap_or(0.0);
    let (ls_type, ls_val) = styles
        .para_styles
        .get(para.para_shape_id as usize)
        .map(|style| (style.line_spacing_type, style.line_spacing))
        .unwrap_or((LineSpacingType::Percent, 160.0));

    source_line_metrics_need_reflow(
        hwpunit_to_px(line.line_height, dpi),
        hwpunit_to_px(line.text_height, dpi),
        max_fs,
        ls_type,
        ls_val,
        true,
    )
}

/// 저장된 순수 텍스트 줄은 `vertsize`에 내부 여백이 포함되어도 한컴의 줄 진행이
/// `textheight + spacing`에 맞춰지는 사례가 있다. IR 값은 보존하고 렌더/조판용
/// line height만 낮춘다.
#[inline]
pub fn corrected_line_metrics_for_source(
    raw_lh: f64,
    raw_text_height: f64,
    raw_ls: f64,
    max_fs: f64,
    ls_type: LineSpacingType,
    ls_val: f64,
    use_stored_text_height: bool,
    source_metrics_reflow_eligible: bool,
) -> (f64, f64) {
    if source_line_metrics_need_reflow(
        raw_lh,
        raw_text_height,
        max_fs,
        ls_type,
        ls_val,
        source_metrics_reflow_eligible,
    ) {
        return corrected_line_metrics(0.0, 0.0, max_fs, ls_type, ls_val);
    }

    let (lh, ls) = corrected_line_metrics(raw_lh, raw_ls, max_fs, ls_type, ls_val);
    if use_stored_text_height
        && raw_text_height > 0.0
        && raw_text_height < lh
        && (max_fs <= 0.0 || raw_text_height + 0.5 >= max_fs * 0.8)
    {
        (raw_text_height, ls)
    } else if use_stored_text_height
        && raw_lh > 0.0
        && raw_text_height > lh
        && raw_text_height <= raw_lh * 1.5
    {
        // 저장 글자 높이가 줄 높이보다 크면 한컴은 글자 높이로 다음 줄을 놓는다
        // (다음 vertpos = vertpos + textheight + spacing). mel-001 p6 의 글자 테두리
        // 줄(vertsize 1498 · textheight 1696), onsaemiro·exam-social 의 줄이 모두
        // 이 규칙으로 저장돼 있다.
        (raw_text_height, ls)
    } else {
        (lh, ls)
    }
}

/// HWP3-origin HWP5 conversions may omit PARA_LINE_SEG for body paragraphs.
/// The composer then emits synthetic lines with a tiny raw line height. For
/// those synthetic lines, applying ParaShape's percent line spacing again makes
/// the paragraph too tall compared with Hancom's converted layout.
#[inline]
pub fn corrected_line_height_for_variant_synthetic(
    raw_lh: f64,
    max_fs: f64,
    ls_type: LineSpacingType,
    ls_val: f64,
    hwp3_variant_synthetic: bool,
) -> f64 {
    if hwp3_variant_synthetic && max_fs > 0.0 && raw_lh < max_fs {
        max_fs
    } else {
        corrected_line_height(raw_lh, max_fs, ls_type, ls_val)
    }
}

/// [Task #1116] HWP3-origin HWP5 변환본의 문단 앞 간격 보정.
///
/// 기존 style resolver는 변환본의 ParaShape spacing 계열을 절반으로 줄인다.
/// 이는 페이지 수 회귀를 막기 위해 유지하되, 본문 흐름에서 다음 문단을
/// 배치할 때 쓰는 `spacing_before`는 한컴 PDF의 3mm 격자와 같이 원래 값을 쓴다.
#[inline]
pub(crate) fn hwp3_variant_flow_spacing_before(base: f64, is_hwp3_variant: bool) -> f64 {
    if is_hwp3_variant {
        base * 2.0
    } else {
        base
    }
}

/// [#2169] 저장 LINE_SEG 부재 판별 — 원본 NO_LS 와 자기-export HWPX 재파싱본
/// (전부 synthetic, tag 0x8000_0000)을 동일 취급해 왕복 시멘틱을 정합한다
/// (#1770 계열: 국소 문맥 판별).
#[inline]
pub(crate) fn para_has_no_stored_line_segs(p: &crate::model::paragraph::Paragraph) -> bool {
    p.line_segs.is_empty() || p.line_segs.iter().all(|s| s.tag & 0x8000_0000 != 0)
}

/// [#2287] 저장 LINE_SEG 없는 빈 anchor 문단의 TAC(글자처럼) 그림/도형 플로우
/// 줄 메트릭 합성. 컨트롤 폭을 가용 폭에 greedy wrap 하여 줄별 (최대 높이, 0)
/// 을 돌려준다.
///
/// 한글은 글자처럼 개체를 줄박스로 취급해 그림 높이만큼 본문 흐름을 전진시키나,
/// rhwp 는 composed lines 가 비면(빈 텍스트 + 컨트롤) 문단 높이가 0 으로 붕괴해
/// 차트/스캔 그림 수십 장이 한 쪽에 응축된다 (미래부 정서분석 88 vs 한글 129쪽,
/// 농촌 S-OJT 꼬리 26쪽 응축 — 10k 서베이 r14 대형 음수 델타 지배 성분).
/// 호출부는 pairs 가 빈 경우(합성 폴백 실패 후)에만 사용한다.
pub(crate) fn tac_object_stack_line_metrics(
    para: &crate::model::paragraph::Paragraph,
    dpi: f64,
    available_width_px: Option<f64>,
) -> Option<Vec<(f64, f64)>> {
    use crate::model::control::Control;
    if !para_has_no_stored_line_segs(para) {
        return None;
    }
    let objs: Vec<(f64, f64)> = para
        .controls
        .iter()
        .filter_map(|c| {
            let common = match c {
                Control::Picture(pic) if pic.common.treat_as_char => &pic.common,
                Control::Shape(s) if s.common().treat_as_char => s.common(),
                _ => return None,
            };
            let w = hwpunit_to_px(common.width as i32, dpi);
            let h = hwpunit_to_px(common.height as i32, dpi);
            (h > 0.5).then_some((w, h))
        })
        .collect();
    if objs.is_empty() {
        return None;
    }
    let avail = available_width_px.unwrap_or(f64::INFINITY).max(1.0);
    let mut lines: Vec<(f64, f64)> = Vec::new();
    let mut line_w = 0.0f64;
    let mut line_h = 0.0f64;
    for (w, h) in objs {
        if line_w > 0.0 && line_w + w > avail + 0.5 {
            lines.push((line_h, 0.0));
            line_w = 0.0;
            line_h = 0.0;
        }
        line_w += w;
        line_h = line_h.max(h);
    }
    if line_h > 0.0 {
        lines.push((line_h, 0.0));
    }
    (!lines.is_empty()).then_some(lines)
}

/// HWPUNIT을 픽셀로 변환
#[inline]
pub fn hwpunit_to_px(hwpunit: i32, dpi: f64) -> f64 {
    hwpunit as f64 * dpi / HWPUNIT_PER_INCH
}

pub(crate) const MIN_TAC_OBJECT_HEIGHT_PX: f64 = 8.0;
const TAC_OWNER_HEIGHT_UNDER_PX: f64 = 4.0;
const TAC_OWNER_HEIGHT_OVER_PX: f64 = 8.0;

pub(crate) fn tac_object_flow_height_px(
    ctrl: &crate::model::control::Control,
    dpi: f64,
) -> Option<f64> {
    tac_object_flow_height_hu(ctrl).map(|height_hu| hwpunit_to_px(height_hu, dpi))
}

#[inline]
pub(crate) fn tac_object_flow_height_hu(ctrl: &crate::model::control::Control) -> Option<i32> {
    match ctrl {
        Control::Picture(pic) if pic.common.treat_as_char => Some(pic.common.height as i32),
        Control::Shape(shape) if shape.common().treat_as_char => Some(shape.common().height as i32),
        _ => None,
    }
}

pub(crate) fn line_owning_tac_object_height_px(
    para: &crate::model::paragraph::Paragraph,
    raw_line_height: f64,
    dpi: f64,
) -> Option<f64> {
    para.controls
        .iter()
        .filter_map(|ctrl| tac_object_flow_height_px(ctrl, dpi))
        .find(|height| {
            *height > MIN_TAC_OBJECT_HEIGHT_PX
                && raw_line_height + TAC_OWNER_HEIGHT_UNDER_PX >= *height
                && raw_line_height <= *height + TAC_OWNER_HEIGHT_OVER_PX
        })
}

/// 픽셀을 HWPUNIT으로 변환
#[inline]
pub fn px_to_hwpunit(px: f64, dpi: f64) -> i32 {
    (px * HWPUNIT_PER_INCH / dpi) as i32
}

/// px → HWPUNIT, 반올림 변형. 임포트 값 변환·오차 표시처럼 절단이 아니라
/// 가장 가까운 정수가 맞는 자리에서 쓴다.
pub fn px_to_hwpunit_round(px: f64, dpi: f64) -> i32 {
    (px * HWPUNIT_PER_INCH / dpi).round() as i32
}

/// [Task #1745] 텍스트 혼합 anchor 문단의 Square wrap 표 우측 wrap 띠 (cs, sw) HU 도출.
///
/// Square wrap(어울림) 표가 텍스트 문단(예: 별표 제목)에 anchor 되면 anchor 문단의
/// 첫 LINE_SEG 는 전폭 텍스트 줄(cs=0)이라 wrap 띠를 인코딩하지 않는다. 이때 표
/// geometry(가로 오프셋 + 바깥여백 좌 + 폭 + 바깥여백 우)로 띠 시작 cs 를 계산하고,
/// 띠 폭은 전폭 줄 너비에서 뺀 나머지로 잡는다 (한글 저장 LINE_SEG 와 정확 일치 —
/// samples/task1745 cs=45568=45002+283×2, sw=2620=48188−45568).
///
/// 기존 케이스(표 단독 anchor — 첫 LINE_SEG 가 이미 띠, cs>0)나 텍스트 없는 anchor,
/// 좌측 정렬이 아닌 표, 띠 폭이 남지 않는 표는 None (기존 경로 유지).
pub(crate) fn text_anchor_square_table_strip(
    para: &crate::model::paragraph::Paragraph,
) -> Option<(i32, i32)> {
    let first = para.line_segs.first()?;
    if first.column_start != 0 {
        return None;
    }
    let full_sw = first.segment_width;
    if full_sw <= 0 {
        return None;
    }
    let has_real_text = para.text.chars().any(|c| c > '\u{001F}' && c != '\u{FFFC}');
    if !has_real_text {
        return None;
    }
    let cm = para.controls.iter().find_map(|c| match c {
        crate::model::control::Control::Table(t)
            if !t.common.treat_as_char
                && matches!(t.common.text_wrap, crate::model::shape::TextWrap::Square)
                && matches!(t.common.horz_align, crate::model::shape::HorzAlign::Left) =>
        {
            Some(&t.common)
        }
        _ => None,
    })?;
    let strip_cs = cm.horizontal_offset as i32
        + cm.margin.left as i32
        + cm.width as i32
        + cm.margin.right as i32;
    let strip_sw = full_sw - strip_cs;
    (strip_cs > 0 && strip_sw > 0).then_some((strip_cs, strip_sw))
}

/// [#3314] 요청 face 의 굵기/폭 접미사를 벗긴 base family.
///
/// `"Noto Serif KR Black"` → `Some("Noto Serif KR")`, 접미사가 없으면 `None`.
/// 폴백 체인은 요청 face 바로 뒤에 이 base 를 끼워 넣는다 — 접미사 face 가
/// 미설치일 때 같은 family 의 base face 가 generic 체인(Batang 등)보다 먼저
/// 구제한다(1.hwpx: 한컴 NotoSerifKR vs rhwp Batang, 제목 잉크 −31%).
/// 요청 face 가 실존하면 체인 선두라 무영향. **렌더 경로 전용** — 측정 경로
/// (`text_measurement`)는 쓰지 않아 조판(쪽수)이 불변이다.
pub fn base_family_without_weight_suffix(font_family: &str) -> Option<String> {
    // 뒤에서부터 제거되는 토큰들. "Extra Bold" 처럼 두 토큰으로 쪼개진 경우를
    // 위해 수식 접두 토큰(extra/ultra/semi/demi)도 포함한다.
    const WEIGHT_TOKENS: &[&str] = &[
        "black",
        "heavy",
        "extrabold",
        "ultrabold",
        "semibold",
        "demibold",
        "bold",
        "medium",
        "regular",
        "normal",
        "extralight",
        "ultralight",
        "demilight",
        "light",
        "thin",
        "extra",
        "ultra",
        "semi",
        "demi",
    ];
    let mut tokens: Vec<&str> = font_family.split_whitespace().collect();
    let original_len = tokens.len();
    while tokens.len() > 1 {
        let last = tokens.last().expect("len > 1").to_ascii_lowercase();
        if WEIGHT_TOKENS.contains(&last.as_str()) {
            tokens.pop();
        } else {
            break;
        }
    }
    (tokens.len() < original_len).then(|| tokens.join(" "))
}

/// 같은 family가 여러 fallback 단계에 있어도 첫 위치와 표기만 남긴다.
fn join_unique_font_families(families: &[String], separator: &str) -> String {
    let mut names = Vec::new();
    let mut unique = Vec::new();
    for group in families {
        for family in group.split(',') {
            let family = family.trim();
            let name = family.trim_matches(['\'', '"']);
            if !name.is_empty() && !names.contains(&name) {
                names.push(name);
                unique.push(family);
            }
        }
    }
    unique.join(separator)
}

/// 렌더용 체인: 요청 face → base family → HFT/문서 대체 → generic.
pub fn render_font_family_chain(font_family: &str, font_subst: &str) -> String {
    // 스타일에 붙은 제네릭 체인보다 검증된 한컴 대체 face를 먼저 선택한다.
    let primary = style_resolver::primary_font_name(font_family);
    let font_family = if matches!(primary, "HY신명조" | "한양신명조") {
        primary
    } else {
        font_family
    };
    let mut families = vec![font_family.to_string()];
    if let Some(base) = base_family_without_weight_suffix(font_family) {
        families.push(format!("'{base}'"));
    }
    families.extend(
        font_fallback_families(font_family, font_subst)
            .into_iter()
            .map(|name| format!("'{name}'")),
    );
    families.push(generic_fallback(font_family).to_string());
    join_unique_font_families(&families, ",")
}

/// Canvas 2D도 문서 대체 서체와 HFT 우선순위를 같은 규칙으로 해석한다.
pub fn canvas_font_family_chain(font_family: &str, font_subst: &str) -> String {
    // 스타일에 붙은 제네릭 체인보다 검증된 한컴 대체 face를 먼저 선택한다.
    let primary = style_resolver::primary_font_name(font_family);
    let font_family = if matches!(primary, "HY신명조" | "한양신명조") {
        primary
    } else {
        font_family
    };
    if font_family.is_empty() {
        return "sans-serif".to_string();
    }
    let mut families = vec![format!("\"{font_family}\"")];
    if let Some(base) = base_family_without_weight_suffix(font_family) {
        families.push(format!("\"{base}\""));
    }
    families.extend(
        font_fallback_families(font_family, font_subst)
            .into_iter()
            .map(|name| format!("\"{name}\"")),
    );
    families.push(generic_fallback(font_family).to_string());
    join_unique_font_families(&families, ", ")
}

/// run 의 원본 HFT 서체에서 `ch` 윤곽선을 찾는다 (설치된 HFT 를 등록한 경우만).
///
/// 기울임은 한컴의 합성 기울기를 아직 재현하지 않으므로 기존 대체 서체로 그린다.
pub(crate) fn hft_glyph_for_style(
    style: &TextStyle,
    ch: char,
) -> Option<std::sync::Arc<hft_glyphs::HftGlyph>> {
    if style.hft_family.is_empty() || style.italic {
        return None;
    }
    hft_glyphs::hft_glyph(&style.hft_family, ch)
}

/// macOS 한컴은 굵은 세로쓰기 HFT 한글의 원래 윤곽선에 아래쪽 굵은 사본을 겹친다.
/// 추가 사본의 위치와 굵기는 글자 크기에 비례하며 레이아웃 폭은 바꾸지 않는다.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct HftVerticalBoldCopy {
    pub offset_x: f64,
    pub offset_y: f64,
    pub rotation: f64,
    pub embolden_x: f64,
}

impl HftVerticalBoldCopy {
    pub fn x_offsets(self) -> impl Iterator<Item = f64> {
        (0..=5).map(move |step| self.embolden_x * f64::from(step) / 5.0)
    }

    /// 사본은 글리프 효과만 반복하고 음영·강조점·장식선은 원래 위치에 둔다.
    pub fn glyph_style(self, style: &TextStyle) -> TextStyle {
        TextStyle {
            underline: crate::model::style::UnderlineType::None,
            strikethrough: false,
            emphasis_dot: 0,
            shade_color: 0xFFFF_FFFF,
            ..style.clone()
        }
    }
}

pub(crate) fn hft_vertical_bold_copy(
    style: &TextStyle,
    text: &str,
    is_vertical: bool,
) -> Option<HftVerticalBoldCopy> {
    if style.font_metrics_policy != crate::model::provenance::FontMetricsPolicy::HcrDeclared
        || !is_vertical
        || !style.bold
        || style.italic
        || style.hft_family.is_empty()
        || text.is_empty()
        || !(text.chars().all(layout::is_cjk_char) || matches!(text, "(" | ")"))
    {
        return None;
    }
    let (size, _) = script_glyph_size_and_shift(style, style.font_size.max(1.0));
    let rotated = matches!(text, "(" | ")");
    let embolden_x = size * 0.05;
    Some(HftVerticalBoldCopy {
        offset_x: if rotated { -embolden_x / 2.0 } else { 0.0 },
        offset_y: if rotated {
            embolden_x / 2.0
        } else {
            size * 0.9
        },
        rotation: if rotated { 90.0 } else { 0.0 },
        embolden_x,
    })
}

/// 대응 HY TTF가 있는 HFT의 가운뎃점은 원래 글꼴의 전각 자형을 쓴다.
/// 일반 대체 점의 0.3em 폭과 원형 도형은 이 서체의 사각 점에 맞지 않는다.
pub(crate) fn hft_uses_paired_middle_dot(style: &TextStyle) -> bool {
    style.font_metrics_policy == crate::model::provenance::FontMetricsPolicy::HcrDeclared
        && hft_substitute_faces(&style.hft_family)
            .first()
            .is_some_and(|name| name.starts_with("HY"))
}

/// 한컴 전용 HFT 영문 글꼴 대신 글리프를 그릴 설치 서체 (선호 순서).
///
/// HCI Poppy(HMEPO*.HFT)는 Palatino 복제 서체다. 폭 테이블이 macOS Palatino 와
/// 같고, Palatino Linotype 과는 `# + / < = > @ ^ | ~` 폭(0.605em vs 0.5em)이 다르다.
/// 레이아웃은 HFT 자체 폭(font_metrics_data "HCI Poppy")으로 재므로 호스트와
/// 무관하게 같다. 글리프만 설치된 첫 서체로 그린다: macOS Palatino(4 스타일) →
/// Windows Palatino Linotype(4 스타일) → Book Antiqua (한컴 FontMap.dat
/// `mapAllFont=Palatino,Palatino Linotype` / `Palatino,Book Antiqua`).
pub(crate) fn hft_substitute_faces(font_family: &str) -> &'static [&'static str] {
    match font_family.trim() {
        "HCI Poppy" => &["Palatino", "Palatino Linotype", "Book Antiqua"],
        // HMEHL*.HFT 설명의 Helvetica 쌍. 조판 폭은 HFT 512/em 테이블을 유지한다.
        "HCI Hollyhock" => &["Helvetica", "Arial"],
        // 한양 견명조/견고딕 HFT 에는 한컴 배포 TTF 쌍이 있다
        // (known_font_filenames: 한양견명조→HYMJRE.TTF, 한양견고딕→HYGTRE.TTF).
        // 원명은 font_metrics_data 의 HanyangKyun* 메트릭이 재므로 레이아웃은
        // 그대로 두고, 미설치 시 글리프 소스만 같은 face 의 TTF 로 대체한다.
        "한양견명조" => &["HY견명조", "HYmjrE"],
        "한양견고딕" => &["HY견고딕", "HYgtrE"],
        // 한양신명조 HFT(HGSMJ/ENSMJ)는 한컴이 자체 폭으로 조판한다 — 복학원서의
        // 영문 줄 폭이 한컴 Mac/Windows PDF 모두 HFT 폭과 맞고 한컴바탕 hmtx 보다
        // 약 2% 좁다. 글리프만 명조 번들로 대체한다.
        "한양신명조" => &["한컴바탕", "Haansoft Batang", "함초롬바탕", "HCR Batang"],
        "신명 디나루" => &["돋움", "한컴돋움", "Haansoft Dotum"],
        // [macOS 정합] 한컴 FontMap.dat `mapFontClass=…,DOTUM` — 돋움 계열
        // HFT 가 미설치면 한컴은 돋움 계열 번들(한컴돋움)로 그린다.
        // 치환이 없으면 generic sans 체인이 --font-path 의 Malgun Gothic 을
        // 먼저 잡아 한컴 출력보다 획이 굵게 렌더된다 (09-table-004 셀 본문).
        "한양중고딕" | "한양중고딕V" | "HY중고딕" | "중고딕" | "중고딕V" | "중고딕 간자"
        | "중고딕 약자" | "휴먼고딕" => {
            &["한컴돋움", "Haansoft Dotum", "함초롬돋움", "HCR Dotum"]
        }
        _ => &[],
    }
}

/// 설치되지 않은 표준 Windows 한글 폰트를 대신할 한컴 번들 서체 (선호 순서).
///
/// 한컴(macOS)은 문서가 요청한 표준 폰트가 없으면 자체 번들 서체로 치환해 그린다:
/// 바탕·궁서(세리프) 계열 → 한컴바탕(Haansoft Batang), 돋움·굴림(산세리프)
/// 계열 → 한컴돋움(Haansoft Dotum). 함초롬 계열은 둘째 후보다. 정답지 근거:
/// hwpx-h-01 의 바탕 본문이 한컴 출력에서 Haansoft-Batang 으로 임베드된다.
/// `hft_substitute_faces` 와 달리 generic fallback 체인과 무관하며, 요청
/// family 가 어느 경로로도 해석되지 않을 때만 호출자가 적용한다.
pub(crate) fn hancom_substitute_faces(font_family: &str) -> &'static [&'static str] {
    let declared = hancom_fontmap_faces(font_family);
    if !declared.is_empty() {
        declared
    } else if hancom_unresolved_face(font_family) {
        HANCOM_DEFAULT_FACES
    } else {
        &[]
    }
}

fn hancom_fontmap_faces(font_family: &str) -> &'static [&'static str] {
    match font_family.trim() {
        "바탕" | "Batang" | "바탕체" | "BatangChe" | "궁서" | "Gungsuh" | "궁서체"
        | "GungsuhChe" => &["한컴바탕", "Haansoft Batang", "함초롬바탕", "HCR Batang"],
        // 한양/신명 명조 계열은 한컴 FontMap 치환에서도 명조 번들로 간다 —
        // exam-kor-1p 정답지는 HY신명조/한양신명조 런을 HCRBatang 글리프로 굽는다.
        // 두 서체를 generic serif chain 에 맡기면 macOS 는 AppleMyungjo 를 먼저
        // 잡아 한컴 출력과 다른 명조로 렌더한다.
        // HY신명조 TTF 미설치·문서 대체 미지정 시 Mac 한컴은 HCRBatang을 쓴다.
        // 굴착복구 현황의 한글 0.97em / 하이픈·숫자 0.55em과 PDF 임베드 서체로 확인.
        // 문서가 한컴바탕을 지정한 경우는 font_fallback_families의 앞선 후보가 우선한다.
        "HY신명조" | "한양신명조" => {
            &["함초롬바탕", "HCR Batang", "한컴바탕", "Haansoft Batang"]
        }
        "신명 신명조" | "신명 견명조" | "신명 중명조" | "명조" | "새문명조" => {
            &["한컴바탕", "Haansoft Batang", "함초롬바탕", "HCR Batang"]
        }
        "돋움" | "Dotum" | "돋움체" | "DotumChe" | "굴림" | "Gulim" | "굴림체" | "GulimChe" => {
            &["한컴돋움", "Haansoft Dotum", "함초롬돋움", "HCR Dotum"]
        }
        _ => &[],
    }
}

/// 한컴 기본 글꼴 (함초롬돋움). 요청 face 를 어떤 경로로도 해석하지 못하면 쓴다.
pub(crate) const HANCOM_DEFAULT_FACES: &[&str] = &["함초롬돋움", "HCR Dotum"];

/// 사용 가능 여부를 조회하지 않는 선언 글꼴 판정. 메트릭이 있어도 FontMap의
/// 그리기 대체 후보를 숨기지 않도록 후보 수집과 별도로 사용한다.
fn hancom_known_face(name: &str) -> bool {
    if name.is_empty() || name.contains(',') || HANCOM_DEFAULT_FACES.contains(&name) {
        return true;
    }
    if !hft_substitute_faces(name).is_empty()
        || hft_metric_fallback(name).is_some()
        || font_metrics_data::find_metric(name, false, false).is_some()
    {
        return true;
    }
    // KoPub 돋움/바탕은 자체 폭 규칙(`kopub_char_width`)을 유지한다.
    let lower = name.to_lowercase();
    if name.contains("KoPub돋움체")
        || name.contains("KoPub바탕체")
        || lower.contains("kopub dotum")
        || lower.contains("kopub batang")
    {
        return true;
    }
    false
}

/// 문서 대체 글꼴은 한컴의 문서 face 이름으로 조회한다.
/// `HCR Batang`은 실제 TTF 영문 family여도 이 조회에서는 인식하지 않는다.
/// Mac 한컴 교차 검증: 동일 문서에서 `함초롬바탕`은 HCRBatang을 선택하지만
/// `HCR Batang`은 기본 HCRDotum으로 돌아간다. 원본 face 이름에는 적용하지 않는다.
pub(crate) fn hancom_document_substitute(font_subst: &str) -> &str {
    match font_subst.trim() {
        "HCR Batang" => "",
        name => name,
    }
}

/// 정확한 요청 글꼴을 찾지 못했을 때 로드할 그리기 후보. 순서와 중복 제거는
/// 모든 호스트에서 같으며 현재 설치/등록된 글꼴에 의존하지 않는다.
pub(crate) fn font_fallback_families(font_family: &str, font_subst: &str) -> Vec<String> {
    let name = font_family.trim();
    let mut families = Vec::new();
    let mut push = |family: &str| {
        if !family.is_empty() && family != name && !families.iter().any(|item| item == family) {
            families.push(family.to_string());
        }
    };
    // HFT 고유 치환(HCI Poppy → Palatino 등)은 문서의 일반 대체 서체보다 앞선다.
    for family in hft_substitute_faces(name) {
        push(family);
    }
    push(hancom_document_substitute(font_subst));
    for family in hancom_fontmap_faces(name) {
        push(family);
    }
    if !hancom_known_face(name) {
        for family in HANCOM_DEFAULT_FACES {
            push(family);
        }
    }
    families
}

/// [macOS 정합] 한컴이 이름으로 해석하지 못하는 face 인가.
///
/// 한컴(macOS)은 요청 face 가 설치·번들·FontMap 치환 어디에도 없으면 face 이름
/// (바탕/돋움, Light/Bold 등)과 무관하게 기본 글꼴 함초롬돋움으로 조판하고
/// 그린다. 굵기는 글자 모양의 진하게 속성만 따른다 — onsaemiro-textbook 정답지는
/// KoPubWorld바탕체 Light·배달의민족 도현·IM혜민 Bold 등 미설치 서체 런을 모두
/// HCRDotum(진하게 런만 HCRDotum-Bold)으로 굽는다.
///
/// 해석 가능 = 내장 메트릭(HFT 포함)·한컴 FontMap 치환·문서 내장/런타임 등록
/// face·custom 폰트 경로·시스템 폰트 중 하나라도 있음. 내장 메트릭이 있는
/// face 는 종전대로 그 메트릭을 쓴다.
pub(crate) fn hancom_unresolved_face(font_family: &str) -> bool {
    let name = font_family.trim();
    if hancom_known_face(name) {
        return false;
    }
    if layout::active_shaping_face_available(name)
        || runtime_font_metrics::bold_fallback(name, false).is_some()
    {
        return false;
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        if font_paths::custom_font_face_available(name) {
            return false;
        }
        thread_local! {
            static SYSTEM_FACE_CACHE: std::cell::RefCell<std::collections::HashMap<String, bool>> =
                std::cell::RefCell::new(std::collections::HashMap::new());
        }
        let on_system = SYSTEM_FACE_CACHE.with(|cache| {
            if let Some(hit) = cache.borrow().get(name) {
                return *hit;
            }
            let hit = font_paths::font_family_available(name, &[]);
            cache.borrow_mut().insert(name.to_string(), hit);
            hit
        });
        if on_system {
            return false;
        }
    }
    true
}

/// HFT 폭 테이블에 없는 글자(0x7F 이후)를 잴 글꼴.
///
/// 한컴 FontMap.dat `mapFont=HCI Poppy,Palatino Linotype`: HFT 에 없는 글자는
/// 한컴 번들 pala.ttf 로 그린다 (hy-001 PDF 의 `·` = PalatinoLinotype-Roman).
pub(crate) fn hft_metric_fallback(font_family: &str) -> Option<&'static str> {
    match font_family.trim() {
        "HCI Poppy" => Some("Palatino Linotype"),
        "신명 디나루" => Some("돋움"),
        _ => None,
    }
}

const HCI_POPPY_FALLBACK: &str = "'Palatino','Palatino Linotype','Book Antiqua','Batang','바탕','Nanum Myeongjo','AppleMyungjo','Noto Serif KR','Noto Serif CJK KR','Haansoft Batang','한컴바탕','HCR Batang Ext-B','함초롬바탕 확장B','HCR Batang Ext','함초롬바탕 확장','HCR Batang','함초롬바탕','Source Han Serif K Old Hangul',serif";

/// CSS generic fallback 반환 (serif 또는 sans-serif)
///
/// 폰트 이름에 명조/바탕/궁서 등 세리프 계열 키워드가 포함되면 "serif",
/// 그 외에는 "sans-serif"를 반환한다.
pub fn generic_fallback(font_family: &str) -> &'static str {
    // Task #727 (F-1): sans/serif chain 마지막 단계에 함초롬바탕 family
    // (확장B → 확장 → 일반) 를 끼움. 한컴 자체 PUA 영역 (사각 안 숫자
    // U+F02B1~F02C5 등) 글리프는 표준 한글 폰트 (Malgun Gothic, Noto Sans
    // KR 등) 에 없어 .notdef tofu 가 나옴. 함초롬바탕 확장B 가 한컴 PUA
    // 글리프를 보유하므로 chain 의 generic 직전에 우선순위로 매칭시킨다.
    // 한글 본문 영역은 1순위 폰트가 글리프 가지면 chain 우선순위에 의해
    // 1순위 사용 → 영향 0. PUA 글리프 부재 시에만 함초롬바탕 매칭.
    if font_family.is_empty() {
        // Sans-serif: Windows → macOS/iOS → Android → 오픈소스 → 한컴 → generic
        // Task #1224: 시스템 고딕(맑은고딕/Apple) 부재 환경(Linux/CI)에서 폴백되는
        // 'Noto Sans KR'(CJK Regular)의 획이 한컴 돋움보다 +43% 두꺼워 본문이 과도하게
        // 굵게 렌더됨. 한컴 돋움 획 두께(페이지 밀도 0.265)에 근접한
        // 'Noto Sans KR ExtraLight'(rsvg 페이지 밀도 0.277)를 무거운 Noto 직전에 삽입 —
        // 시스템 고딕 렌더는 무영향, Noto 폴백만 가볍게 교체.
        return "'Malgun Gothic','맑은 고딕','Apple SD Gothic Neo','Noto Sans KR ExtraLight','Noto Sans KR','Pretendard','Haansoft Dotum','한컴돋움','HCR Dotum','함초롬돋움','HCR Batang Ext-B','함초롬바탕 확장B','HCR Batang Ext','함초롬바탕 확장','HCR Batang','함초롬바탕','Source Han Serif K Old Hangul',sans-serif";
    }
    // 한컴이 해석하지 못하는 face 는 이름 분류(바탕체=고정폭 등)와 무관하게
    // 기본 글꼴 함초롬돋움으로 그린다 (`hancom_unresolved_face`).
    if hancom_unresolved_face(font_family) {
        return "'HCR Dotum','함초롬돋움','Malgun Gothic','맑은 고딕','Apple SD Gothic Neo','Noto Sans KR','Pretendard','HCR Batang Ext-B','함초롬바탕 확장B','HCR Batang Ext','함초롬바탕 확장','HCR Batang','함초롬바탕','Source Han Serif K Old Hangul',sans-serif";
    }
    // 고정폭 키워드
    let lower = font_family.to_ascii_lowercase();
    if (font_family.contains("KoPub돋움체") || lower.contains("kopub dotum"))
        && (font_family.contains("Light") || lower.contains("light"))
    {
        return "'Noto Sans KR ExtraLight','Malgun Gothic','맑은 고딕','Apple SD Gothic Neo','Noto Sans KR','Pretendard','Haansoft Dotum','한컴돋움','HCR Dotum','함초롬돋움','HCR Batang Ext-B','함초롬바탕 확장B','HCR Batang Ext','함초롬바탕 확장','HCR Batang','함초롬바탕','Source Han Serif K Old Hangul',sans-serif";
    }
    // KoPub Batang uses "바탕체" in the family name, but it is a proportional
    // serif publication face, not the Windows fixed-width BatangChe face.
    if font_family.contains("KoPub바탕체") || lower.contains("kopub batang") {
        return "'Batang','바탕','Nanum Myeongjo','AppleMyungjo','Noto Serif KR','Noto Serif CJK KR','Haansoft Batang','한컴바탕','HCR Batang Ext-B','함초롬바탕 확장B','HCR Batang Ext','함초롬바탕 확장','HCR Batang','함초롬바탕','Source Han Serif K Old Hangul',serif";
    }
    if font_family.contains("굴림체")
        || font_family.contains("바탕체")
        || lower.contains("gulimche")
        || lower.contains("batangche")
        || lower.contains("coding")
        || lower.contains("courier")
        || lower.contains("mono")
    {
        // Monospace: Windows → 오픈소스 → generic
        return "'GulimChe','굴림체','D2Coding','Noto Sans Mono',monospace";
    }
    if font_family.trim() == "HCI Poppy" {
        return HCI_POPPY_FALLBACK;
    }
    if font_family.trim() == "신명 디나루" {
        return "'돋움','한컴돋움','Haansoft Dotum','Malgun Gothic','맑은 고딕','Apple SD Gothic Neo','Noto Sans KR',sans-serif";
    }
    // 네이티브 설치 대체 순서와 SVG/Canvas 체인을 맞춘다. 요청 face는 호출자가
    // 체인 맨 앞에 두므로 실폰트가 있으면 그대로 쓰고, HCR 미설치 시에는 기존
    // 한컴바탕 및 제네릭 명조 후보로 내려간다.
    if matches!(font_family.trim(), "HY신명조" | "한양신명조") {
        return "'함초롬바탕','HCR Batang','한컴바탕','Haansoft Batang','Batang','바탕','Nanum Myeongjo','AppleMyungjo','Noto Serif KR','Noto Serif CJK KR','HCR Batang Ext-B','함초롬바탕 확장B','HCR Batang Ext','함초롬바탕 확장','Source Han Serif K Old Hangul',serif";
    }
    // 한양 HFT → 한컴 TTF 쌍(hft_substitute_faces 와 같은 매핑)을 generic 체인
    // 앞에 둔다. 미설치 환경에선 자연스럽게 다음 후보로 넘어간다.
    if font_family.trim() == "한양견고딕" {
        return "'HY견고딕','HYgtrE','Malgun Gothic','맑은 고딕','Apple SD Gothic Neo','Noto Sans KR ExtraLight','Noto Sans KR','Pretendard','HCR Batang Ext-B','함초롬바탕 확장B','HCR Batang Ext','함초롬바탕 확장','HCR Batang','함초롬바탕','Source Han Serif K Old Hangul',sans-serif";
    }
    if font_family.trim() == "한양견명조" {
        return "'HY견명조','HYmjrE','Batang','바탕','Nanum Myeongjo','AppleMyungjo','Noto Serif KR','Noto Serif CJK KR','HCR Batang Ext-B','함초롬바탕 확장B','HCR Batang Ext','함초롬바탕 확장','HCR Batang','함초롬바탕','Source Han Serif K Old Hangul',serif";
    }
    // 한컴 FontMap.dat `mapFontClass=…,DOTUM` — 돋움 계열 HFT (한양중고딕 등)
    // 는 미설치 시 돋움 계열 번들로 치환된다 (hft_substitute_faces 와 같은 매핑).
    if [
        "한양중고딕",
        "한양중고딕V",
        "HY중고딕",
        "중고딕",
        "중고딕V",
        "중고딕 간자",
        "중고딕 약자",
        "휴먼고딕",
    ]
    .contains(&font_family.trim())
    {
        return "'한컴돋움','Haansoft Dotum','함초롬돋움','HCR Dotum','Malgun Gothic','맑은 고딕','Apple SD Gothic Neo','Noto Sans KR ExtraLight','Noto Sans KR','Pretendard','HCR Batang Ext-B','함초롬바탕 확장B','HCR Batang Ext','함초롬바탕 확장','HCR Batang','함초롬바탕','Source Han Serif K Old Hangul',sans-serif";
    }
    // 세리프 키워드 (한글)
    if font_family.contains("바탕") || font_family.contains("명조") || font_family.contains("궁서")
    {
        // Serif: Windows → macOS(Bold 보유 우선) → macOS 기본 → Android → 오픈소스 → 한컴 → 리눅스 시스템 → generic
        // Nanum Myeongjo 는 macOS 10.9+ 기본 설치이며 Bold variant 보유.
        // AppleMyungjo 보다 앞에 두어야 macOS Chrome 에서 CJK 글리프 bold 매칭 성공.
        // 'Source Han Serif K Old Hangul' (Task #528): @font-face unicode-range 가 옛한글
        // 영역 (U+1100-11FF, U+A960-A97F, U+D7B0-D7FF) 만 매칭하므로 일반 한글에 영향 없음.
        return "'Batang','바탕','Nanum Myeongjo','AppleMyungjo','Noto Serif KR','Noto Serif CJK KR','Haansoft Batang','한컴바탕','HCR Batang Ext-B','함초롬바탕 확장B','HCR Batang Ext','함초롬바탕 확장','HCR Batang','함초롬바탕','Source Han Serif K Old Hangul',serif";
    }
    // 세리프 키워드 (영문) — "serif" 포함하되 "sans" 부분 문자열을 가진 폰트명 전체 제외
    if lower.contains("times")
        || lower.contains("hymjre")
        || lower.contains("palatino")
        || lower.contains("georgia")
        || lower.contains("batang")
        || lower.contains("gungsuh")
        || (lower.contains("serif") && !lower.contains("sans"))
    {
        return "'Batang','바탕','Nanum Myeongjo','AppleMyungjo','Noto Serif KR','Noto Serif CJK KR','Haansoft Batang','한컴바탕','HCR Batang Ext-B','함초롬바탕 확장B','HCR Batang Ext','함초롬바탕 확장','HCR Batang','함초롬바탕','Source Han Serif K Old Hangul',serif";
    }
    // Sans-serif: Windows → macOS/iOS → Android → 오픈소스 → 한컴 → generic
    // 'Source Han Serif K Old Hangul' (Task #528): unicode-range 옛한글 자모 영역 한정
    // 'Noto Sans KR ExtraLight' (Task #1224): 무거운 Noto CJK Regular 폴백 직전에 삽입해
    // 한컴 돋움 획 두께에 근접시킴. 시스템 고딕 우선 → 부재 시에만 ExtraLight 매칭.
    "'Malgun Gothic','맑은 고딕','Apple SD Gothic Neo','Noto Sans KR ExtraLight','Noto Sans KR','Pretendard','Haansoft Dotum','한컴돋움','HCR Dotum','함초롬돋움','HCR Batang Ext-B','함초롬바탕 확장B','HCR Batang Ext','함초롬바탕 확장','HCR Batang','함초롬바탕','Source Han Serif K Old Hangul',sans-serif"
}

pub(crate) fn contains_old_hangul_jamo(text: &str) -> bool {
    text.chars().any(|ch| {
        let code = ch as u32;
        matches!(
            code,
            0x1100..=0x11FF | 0xA960..=0xA97F | 0xD7B0..=0xD7FF
        )
    })
}

// ============================================================
// 자동 번호 매기기 (AutoNumber)
// ============================================================

use crate::model::control::AutoNumberType;

/// 자동 번호 카운터
///
/// 각 번호 종류별로 카운터를 유지하여 순차적인 번호를 생성한다.
#[derive(Debug, Clone, Default)]
pub struct AutoNumberCounter {
    /// 그림 번호
    pub picture: u16,
    /// 표 번호
    pub table: u16,
    /// 수식 번호
    pub equation: u16,
    /// 각주 번호
    pub footnote: u16,
    /// 미주 번호
    pub endnote: u16,
    /// 쪽 번호
    pub page: u16,
}

impl AutoNumberCounter {
    /// 새 카운터 생성
    pub fn new() -> Self {
        Self::default()
    }

    /// 번호 증가 후 현재 값 반환
    pub fn increment(&mut self, number_type: AutoNumberType) -> u16 {
        match number_type {
            AutoNumberType::Picture => {
                self.picture += 1;
                self.picture
            }
            AutoNumberType::Table => {
                self.table += 1;
                self.table
            }
            AutoNumberType::Equation => {
                self.equation += 1;
                self.equation
            }
            AutoNumberType::Footnote => {
                self.footnote += 1;
                self.footnote
            }
            AutoNumberType::Endnote => {
                self.endnote += 1;
                self.endnote
            }
            // 전체 쪽수는 카운터가 아니라 페이지네이션 완료 후 레이아웃에서 결정한다.
            AutoNumberType::TotalPage => 0,
            AutoNumberType::Page => {
                self.page += 1;
                self.page
            }
        }
    }

    /// 현재 번호 조회 (증가 없이)
    pub fn current(&self, number_type: AutoNumberType) -> u16 {
        match number_type {
            AutoNumberType::Picture => self.picture,
            AutoNumberType::Table => self.table,
            AutoNumberType::Equation => self.equation,
            AutoNumberType::Footnote => self.footnote,
            AutoNumberType::Endnote => self.endnote,
            AutoNumberType::Page => self.page,
            AutoNumberType::TotalPage => 0,
        }
    }

    /// 모든 카운터 초기화
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// 번호 형식
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub enum NumberFormat {
    /// 아라비아 숫자: 1, 2, 3
    #[default]
    Digit,
    /// 원 문자: ①, ②, ③
    CircledDigit,
    /// 로마 숫자 대문자: I, II, III
    RomanUpper,
    /// 로마 숫자 소문자: i, ii, iii
    RomanLower,
    /// 영문 대문자: A, B, C
    LatinUpper,
    /// 영문 소문자: a, b, c
    LatinLower,
    /// 한글 가나다: 가, 나, 다
    HangulGaNaDa,
    /// 한글 일이삼: 일, 이, 삼
    HangulNumber,
    /// 한자 一二三: 一, 二, 三
    HanjaNumber,
}

impl NumberFormat {
    /// HWP 형식 코드에서 변환
    pub fn from_hwp_format(format: u8) -> Self {
        match format {
            0 => NumberFormat::Digit,
            1 => NumberFormat::CircledDigit,
            2 => NumberFormat::RomanUpper,
            3 => NumberFormat::RomanLower,
            4 => NumberFormat::LatinUpper,
            5 => NumberFormat::LatinLower,
            6 => NumberFormat::HangulGaNaDa,
            7 => NumberFormat::HangulNumber,
            8 => NumberFormat::HanjaNumber,
            _ => NumberFormat::Digit,
        }
    }
}

/// 번호를 문자열로 변환
pub fn format_number(number: u16, format: NumberFormat) -> String {
    match format {
        NumberFormat::Digit => number.to_string(),
        NumberFormat::CircledDigit => format_circled_digit(number),
        NumberFormat::RomanUpper => format_roman(number, true),
        NumberFormat::RomanLower => format_roman(number, false),
        NumberFormat::LatinUpper => format_latin(number, true),
        NumberFormat::LatinLower => format_latin(number, false),
        NumberFormat::HangulGaNaDa => format_hangul_ganada(number),
        NumberFormat::HangulNumber => format_hangul_number(number),
        NumberFormat::HanjaNumber => format_hanja_number(number),
    }
}

/// 원 문자 변환 (① ~ ⑳, 이후 숫자)
fn format_circled_digit(n: u16) -> String {
    const CIRCLED: [char; 20] = [
        '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱',
        '⑲', '⑳',
    ];
    if n >= 1 && n <= 20 {
        CIRCLED[(n - 1) as usize].to_string()
    } else {
        n.to_string()
    }
}

/// 로마 숫자 변환
fn format_roman(n: u16, upper: bool) -> String {
    if n == 0 || n > 3999 {
        return n.to_string();
    }

    let values = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
    let symbols_upper = [
        "M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I",
    ];
    let symbols_lower = [
        "m", "cm", "d", "cd", "c", "xc", "l", "xl", "x", "ix", "v", "iv", "i",
    ];

    let symbols = if upper {
        &symbols_upper
    } else {
        &symbols_lower
    };
    let mut result = String::new();
    let mut num = n as i32;

    for (i, &val) in values.iter().enumerate() {
        while num >= val {
            result.push_str(symbols[i]);
            num -= val;
        }
    }
    result
}

/// 영문자 변환 (A-Z, AA-AZ, ...)
fn format_latin(n: u16, upper: bool) -> String {
    if n == 0 {
        return String::new();
    }

    let mut result = String::new();
    let mut num = n;

    while num > 0 {
        num -= 1;
        let c = if upper {
            (b'A' + (num % 26) as u8) as char
        } else {
            (b'a' + (num % 26) as u8) as char
        };
        result.insert(0, c);
        num /= 26;
    }
    result
}

/// 한글 가나다 변환
fn format_hangul_ganada(n: u16) -> String {
    const GANADA: [char; 14] = [
        '가', '나', '다', '라', '마', '바', '사', '아', '자', '차', '카', '타', '파', '하',
    ];
    if n >= 1 && n <= 14 {
        GANADA[(n - 1) as usize].to_string()
    } else {
        n.to_string()
    }
}

/// 한글 숫자 변환 (일, 이, 삼, ...)
fn format_hangul_number(n: u16) -> String {
    const HANGUL_DIGITS: [&str; 10] = ["", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];
    const HANGUL_UNITS: [&str; 4] = ["", "십", "백", "천"];
    const HANGUL_LARGE: [&str; 4] = ["", "만", "억", "조"];

    if n == 0 {
        return "영".to_string();
    }

    let mut result = String::new();
    let mut num = n as u32;
    let mut large_unit = 0;

    while num > 0 {
        let group = (num % 10000) as usize;
        if group > 0 {
            let mut group_str = String::new();
            let mut g = group;
            let mut unit = 0;

            while g > 0 {
                let digit = g % 10;
                if digit > 0 {
                    let digit_str = if digit == 1 && unit > 0 {
                        ""
                    } else {
                        HANGUL_DIGITS[digit]
                    };
                    group_str.insert_str(0, HANGUL_UNITS[unit]);
                    group_str.insert_str(0, digit_str);
                }
                g /= 10;
                unit += 1;
            }
            group_str.push_str(HANGUL_LARGE[large_unit]);
            result.insert_str(0, &group_str);
        }
        num /= 10000;
        large_unit += 1;
    }
    result
}

/// 한자 숫자 변환 (一, 二, 三, ...)
fn format_hanja_number(n: u16) -> String {
    const HANJA_DIGITS: [&str; 10] = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
    const HANJA_UNITS: [&str; 4] = ["", "十", "百", "千"];
    const HANJA_LARGE: [&str; 4] = ["", "萬", "億", "兆"];

    if n == 0 {
        return "零".to_string();
    }

    let mut result = String::new();
    let mut num = n as u32;
    let mut large_unit = 0;

    while num > 0 {
        let group = (num % 10000) as usize;
        if group > 0 {
            let mut group_str = String::new();
            let mut g = group;
            let mut unit = 0;

            while g > 0 {
                let digit = g % 10;
                if digit > 0 {
                    let digit_str = if digit == 1 && unit > 0 {
                        ""
                    } else {
                        HANJA_DIGITS[digit]
                    };
                    group_str.insert_str(0, HANJA_UNITS[unit]);
                    group_str.insert_str(0, digit_str);
                }
                g /= 10;
                unit += 1;
            }
            group_str.push_str(HANJA_LARGE[large_unit]);
            result.insert_str(0, &group_str);
        }
        num /= 10000;
        large_unit += 1;
    }
    result
}

#[cfg(test)]
mod tests {
    #[test]
    fn mac_missing_serif_substitution_keeps_shared_render_policy() {
        // 미설치 HY TTF는 HCR, 원명 유지 HFT는 자체 폭과 Haansoft 그리기를 쓴다.
        for (family, preferred, later) in [
            ("HY신명조", "HCR Batang", "Haansoft Batang"),
            ("한양신명조", "Haansoft Batang", "HCR Batang"),
        ] {
            let prepared = format!("{family}, Batang, AppleMyungjo, serif");
            for chain in [
                super::render_font_family_chain(&prepared, ""),
                super::canvas_font_family_chain(&prepared, ""),
            ] {
                assert!(chain.find("함초롬바탕").unwrap() < chain.find("serif").unwrap());
                assert!(chain.find(preferred).unwrap() < chain.find(later).unwrap());
                assert!(
                    chain.find("HCR Batang").unwrap()
                        < chain.find("Batang, AppleMyungjo").unwrap_or(usize::MAX)
                );
            }
            assert_eq!(super::hancom_substitute_faces(family)[0], "함초롬바탕");
            let svg = super::render_font_family_chain(family, "");
            let canvas = super::canvas_font_family_chain(family, "");
            for chain in [&svg, &canvas] {
                assert!(chain.find(family).unwrap() < chain.find("함초롬바탕").unwrap());
                assert!(chain.find(preferred).unwrap() < chain.find(later).unwrap());
            }
        }
        for family in ["바탕", "궁서", "신명 중명조", "새문명조"] {
            assert_eq!(super::hancom_substitute_faces(family)[0], "한컴바탕");
        }
    }

    use super::*;

    /// 한컴 Mac PDF 실측 (k-water-rfp 표지 셀): step 26·stepCenter 44 원형은 안쪽 13띠가
    /// 반지름 0~44%, 바깥 13띠가 44~100% 를 덮고, 띠 색은 채널별 정수 버림 보간이다.
    #[test]
    fn hancom_radial_gradient_steps_follow_step_center() {
        // ColorRef 는 0x00BBGGRR
        let center = 0x00FE_E6D6; // #D6E6FE
        let edge = 0x0080_0000; // #000080
        let (colors, positions) = hancom_radial_steps(&[center, edge], &[0.0, 1.0], 26, 44);
        assert_eq!(colors.len(), 52);
        assert_eq!(colors[0], center);
        assert_eq!(colors[51], edge);
        // 바깥에서 두 번째 띠: (9, 10, 134) — 버림 보간 (한컴 PDF 0.0353/0.0392/0.5255)
        assert_eq!(colors[49], 0x0086_0A09);
        assert!((positions[26] - 0.44).abs() < 1e-9);
        assert!((positions[2] - 0.44 / 13.0).abs() < 1e-9);
        assert!((positions[51] - 1.0).abs() < 1e-9);
    }

    #[test]
    fn test_render_backend_from_str() {
        assert_eq!(
            RenderBackend::from_str("canvas"),
            Some(RenderBackend::Canvas)
        );
        assert_eq!(RenderBackend::from_str("svg"), Some(RenderBackend::Svg));
        assert_eq!(RenderBackend::from_str("html"), Some(RenderBackend::Html));
        assert_eq!(RenderBackend::from_str("unknown"), None);
    }

    #[test]
    fn test_hwpunit_to_px() {
        // 1인치 = 7200 HWPUNIT, 96 DPI → 96px
        let px = hwpunit_to_px(7200, 96.0);
        assert!((px - 96.0).abs() < 0.01);
    }

    // [#2287] 저장 LINE_SEG 없는 빈 anchor 문단의 TAC 그림 줄 메트릭 합성.
    fn tac_picture_para(sizes_hu: &[(i32, i32)]) -> crate::model::paragraph::Paragraph {
        use crate::model::control::Control;
        let mut para = crate::model::paragraph::Paragraph::default();
        for (w, h) in sizes_hu {
            let mut pic = crate::model::image::Picture::default();
            pic.common.treat_as_char = true;
            pic.common.width = *w as u32;
            pic.common.height = *h as u32;
            para.controls.push(Control::Picture(Box::new(pic)));
        }
        para
    }

    #[test]
    fn test_tac_object_stack_single_picture_line() {
        // 590×387px 그림 1장 (미래부 정서분석 pi854 형상) — 1줄, 그림 높이.
        let para = tac_picture_para(&[(44222, 29069)]);
        let lines = tac_object_stack_line_metrics(&para, 96.0, Some(661.0)).unwrap();
        assert_eq!(lines.len(), 1);
        assert!((lines[0].0 - hwpunit_to_px(29069, 96.0)).abs() < 0.01);
        assert_eq!(lines[0].1, 0.0);
    }

    #[test]
    fn test_tac_object_stack_wraps_by_width() {
        // 590px 그림 3장, 가용 661px — 줄당 1장씩 3줄 (농촌 S-OJT 스택 형상).
        let para = tac_picture_para(&[(44222, 29069); 3]);
        let lines = tac_object_stack_line_metrics(&para, 96.0, Some(661.0)).unwrap();
        assert_eq!(lines.len(), 3);
        // 300px 그림 2장, 가용 661px — 한 줄 수용.
        let para2 = tac_picture_para(&[(22000, 10000), (22000, 12000)]);
        let lines2 = tac_object_stack_line_metrics(&para2, 96.0, Some(661.0)).unwrap();
        assert_eq!(lines2.len(), 1);
        assert!((lines2[0].0 - hwpunit_to_px(12000, 96.0)).abs() < 0.01);
    }

    #[test]
    fn test_tac_object_stack_rejects_stored_ls_and_non_tac() {
        // 저장 LINE_SEG 보유 문단 제외 (이중 계상 방지).
        let mut para = tac_picture_para(&[(44222, 29069)]);
        para.line_segs
            .push(crate::model::paragraph::LineSeg::default());
        assert!(tac_object_stack_line_metrics(&para, 96.0, Some(661.0)).is_none());
        // 비-TAC 그림 제외 (PageItem::Shape 오버레이 경로 유지).
        let mut para2 = tac_picture_para(&[(44222, 29069)]);
        if let crate::model::control::Control::Picture(pic) = &mut para2.controls[0] {
            pic.common.treat_as_char = false;
        }
        assert!(tac_object_stack_line_metrics(&para2, 96.0, Some(661.0)).is_none());
    }

    #[test]
    fn test_px_to_hwpunit() {
        let hu = px_to_hwpunit(96.0, 96.0);
        assert_eq!(hu, 7200);
    }

    #[test]
    fn test_source_line_metrics_reflow_when_text_height_is_implausible() {
        let max_fs = hwpunit_to_px(1000, 96.0);
        let raw_h = hwpunit_to_px(68800, 96.0);
        let (line_height, line_spacing) = corrected_line_metrics_for_source(
            raw_h,
            raw_h,
            0.0,
            max_fs,
            LineSpacingType::Percent,
            160.0,
            true,
            true,
        );

        assert!((line_height - max_fs).abs() < 0.01);
        assert!((line_spacing - max_fs * 0.6).abs() < 0.01);
    }

    #[test]
    fn test_source_line_metrics_advance_by_taller_stored_text_height() {
        // mel-001 p6: vertsize 1498 · textheight 1696 → 다음 줄은 textheight 기준.
        let max_fs = hwpunit_to_px(1300, 96.0);
        let (line_height, _) = corrected_line_metrics_for_source(
            hwpunit_to_px(1498, 96.0),
            hwpunit_to_px(1696, 96.0),
            hwpunit_to_px(1016, 96.0),
            max_fs,
            LineSpacingType::Percent,
            160.0,
            true,
            false,
        );
        assert!((line_height - hwpunit_to_px(1696, 96.0)).abs() < 0.01);
    }

    #[test]
    fn test_source_line_metrics_keep_normal_stored_height() {
        let max_fs = hwpunit_to_px(1000, 96.0);
        let stored_h = hwpunit_to_px(3000, 96.0);
        let (line_height, line_spacing) = corrected_line_metrics_for_source(
            stored_h,
            stored_h,
            0.0,
            max_fs,
            LineSpacingType::Percent,
            160.0,
            true,
            false,
        );

        assert!((line_height - stored_h).abs() < 0.01);
        assert_eq!(line_spacing, 0.0);
    }

    #[test]
    fn test_source_line_metrics_preserve_intentional_tall_section_line() {
        let max_fs = hwpunit_to_px(1000, 96.0);
        let intentional_tall_line = hwpunit_to_px(55000, 96.0);

        assert!(!source_line_metrics_need_reflow(
            intentional_tall_line,
            intentional_tall_line,
            max_fs,
            LineSpacingType::Percent,
            160.0,
            true,
        ));
    }

    #[test]
    fn test_source_line_metrics_reflow_replaces_stale_baseline() {
        let max_fs = hwpunit_to_px(1000, 96.0);
        let stale_baseline = hwpunit_to_px(58480, 96.0);

        let baseline = corrected_line_baseline_for_source(stale_baseline, max_fs, true);

        assert!((baseline - max_fs * 0.85).abs() < 0.01);
        assert!(baseline < stale_baseline / 10.0);
    }

    #[test]
    fn test_structural_controls_mark_section_start() {
        assert!(controls_mark_section_start(&[
            Control::SectionDef(Box::default()),
            Control::ColumnDef(Default::default()),
        ]));
        assert!(!controls_mark_section_start(&[]));
    }

    #[test]
    fn test_a4_page_size_px() {
        // A4: 210mm × 297mm = 59528 × 84188 HWPUNIT
        let w = hwpunit_to_px(59528, 96.0);
        let h = hwpunit_to_px(84188, 96.0);
        // A4 @ 96DPI ≈ 793.7 × 1122.5 px
        assert!((w - 793.7).abs() < 1.0);
        assert!((h - 1122.5).abs() < 1.0);
    }

    /// [Task #1745] 텍스트 혼합 anchor: 표 geometry 로 wrap 띠 도출
    #[test]
    fn test_text_anchor_square_table_strip_derives_from_geometry() {
        use crate::model::control::Control;
        use crate::model::paragraph::{LineSeg, Paragraph};
        use crate::model::shape::TextWrap;
        use crate::model::table::Table;

        let mut table = Table::default();
        table.common.treat_as_char = false;
        table.common.text_wrap = TextWrap::Square;
        table.common.horizontal_offset = 0;
        table.common.width = 45002;
        table.common.margin.left = 283;
        table.common.margin.right = 283;

        let mut para = Paragraph::default();
        para.text = "■ 약사법 시행령 [별표 2]".to_string();
        para.line_segs.push(LineSeg {
            column_start: 0,
            segment_width: 48188,
            ..Default::default()
        });
        para.controls.push(Control::Table(Box::new(table)));

        // samples/task1745: cs=45568(=45002+283×2), sw=2620(=48188−45568)
        assert_eq!(text_anchor_square_table_strip(&para), Some((45568, 2620)));
    }

    /// [Task #1745] 표 단독 anchor(첫 seg 가 이미 wrap 띠) — None (기존 경로 유지)
    #[test]
    fn test_text_anchor_square_table_strip_none_for_table_only_anchor() {
        use crate::model::control::Control;
        use crate::model::paragraph::{LineSeg, Paragraph};
        use crate::model::shape::TextWrap;
        use crate::model::table::Table;

        let mut table = Table::default();
        table.common.treat_as_char = false;
        table.common.text_wrap = TextWrap::Square;
        table.common.width = 20000;

        // 표 단독 anchor: 첫 LINE_SEG 가 이미 띠 (cs>0)
        let mut para = Paragraph::default();
        para.text = " ".to_string();
        para.line_segs.push(LineSeg {
            column_start: 20600,
            segment_width: 27000,
            ..Default::default()
        });
        para.controls.push(Control::Table(Box::new(table.clone())));
        assert_eq!(text_anchor_square_table_strip(&para), None);

        // 텍스트 없는 anchor — None
        let mut para2 = Paragraph::default();
        para2.text = String::new();
        para2.line_segs.push(LineSeg {
            column_start: 0,
            segment_width: 48188,
            ..Default::default()
        });
        para2.controls.push(Control::Table(Box::new(table.clone())));
        assert_eq!(text_anchor_square_table_strip(&para2), None);

        // 띠 폭이 남지 않는 표(전폭) — None
        let mut wide = table.clone();
        wide.common.width = 48188;
        let mut para3 = Paragraph::default();
        para3.text = "제목".to_string();
        para3.line_segs.push(LineSeg {
            column_start: 0,
            segment_width: 48188,
            ..Default::default()
        });
        para3.controls.push(Control::Table(Box::new(wide)));
        assert_eq!(text_anchor_square_table_strip(&para3), None);
    }

    #[test]
    fn test_auto_number_counter() {
        let mut counter = AutoNumberCounter::new();
        assert_eq!(counter.increment(AutoNumberType::Picture), 1);
        assert_eq!(counter.increment(AutoNumberType::Picture), 2);
        assert_eq!(counter.increment(AutoNumberType::Table), 1);
        assert_eq!(counter.current(AutoNumberType::Picture), 2);
        assert_eq!(counter.current(AutoNumberType::Table), 1);
        counter.reset();
        assert_eq!(counter.current(AutoNumberType::Picture), 0);
    }

    #[test]
    fn test_format_number_digit() {
        assert_eq!(format_number(1, NumberFormat::Digit), "1");
        assert_eq!(format_number(123, NumberFormat::Digit), "123");
    }

    #[test]
    fn test_format_number_circled() {
        assert_eq!(format_number(1, NumberFormat::CircledDigit), "①");
        assert_eq!(format_number(10, NumberFormat::CircledDigit), "⑩");
        assert_eq!(format_number(20, NumberFormat::CircledDigit), "⑳");
        assert_eq!(format_number(21, NumberFormat::CircledDigit), "21");
    }

    #[test]
    fn test_format_number_roman() {
        assert_eq!(format_number(1, NumberFormat::RomanUpper), "I");
        assert_eq!(format_number(4, NumberFormat::RomanUpper), "IV");
        assert_eq!(format_number(9, NumberFormat::RomanUpper), "IX");
        assert_eq!(format_number(10, NumberFormat::RomanLower), "x");
        assert_eq!(format_number(14, NumberFormat::RomanLower), "xiv");
    }

    #[test]
    fn test_format_number_latin() {
        assert_eq!(format_number(1, NumberFormat::LatinUpper), "A");
        assert_eq!(format_number(26, NumberFormat::LatinUpper), "Z");
        assert_eq!(format_number(27, NumberFormat::LatinUpper), "AA");
        assert_eq!(format_number(1, NumberFormat::LatinLower), "a");
    }

    /// [#3314] 굵기 접미사 face 의 base family 추출과 렌더 체인 삽입.
    #[test]
    fn test_base_family_without_weight_suffix() {
        assert_eq!(
            base_family_without_weight_suffix("Noto Serif KR Black").as_deref(),
            Some("Noto Serif KR")
        );
        assert_eq!(
            base_family_without_weight_suffix("나눔고딕 Bold").as_deref(),
            Some("나눔고딕")
        );
        assert_eq!(
            base_family_without_weight_suffix("경기천년제목 Light").as_deref(),
            Some("경기천년제목")
        );
        // 두 토큰 접미사 ("Extra Bold")
        assert_eq!(
            base_family_without_weight_suffix("Noto Sans KR Extra Bold").as_deref(),
            Some("Noto Sans KR")
        );
        // 접미사 없음 → None (체인 불변)
        assert_eq!(base_family_without_weight_suffix("맑은 고딕"), None);
        assert_eq!(base_family_without_weight_suffix("HY헤드라인M"), None);
        assert_eq!(base_family_without_weight_suffix("휴먼명조"), None);
        // 전체가 접미사 토큰뿐이면 벗기지 않는다
        assert_eq!(base_family_without_weight_suffix("Light"), None);
        // 렌더 체인: 요청 face → base → generic
        let chain = render_font_family_chain("Noto Serif KR Black", "");
        assert!(chain.starts_with("Noto Serif KR Black,'Noto Serif KR',"));
        let plain = render_font_family_chain("맑은 고딕", "");
        assert!(plain.starts_with("맑은 고딕,'Malgun Gothic'"));
        // 문서 선언 대체 글꼴은 base 뒤·generic 앞에 삽입
        let sub = render_font_family_chain("나눔고딕", "한컴바탕");
        assert!(sub.starts_with("나눔고딕,'한컴바탕',"));
        // HFT 설치 대체 서체가 있으면 문서 대체 글꼴이 그 앞을 가로채지 않는다
        let poppy = render_font_family_chain("HCI Poppy", "Batang");
        assert!(poppy.starts_with("HCI Poppy,'Palatino','Palatino Linotype',"));
        assert!(canvas_font_family_chain("HCI Poppy", "Batang")
            .starts_with("\"HCI Poppy\", \"Palatino\", \"Palatino Linotype\","));

        let canvas = canvas_font_family_chain("Noto Serif KR Black", "");
        assert!(canvas.starts_with("\"Noto Serif KR Black\", \"Noto Serif KR\","));
        assert_eq!(
            canvas.rsplit(',').next().unwrap().trim(),
            generic_fallback("Noto Serif KR Black")
                .rsplit(',')
                .next()
                .unwrap()
        );
        let korean = canvas_font_family_chain("맑은 고딕", "");
        assert!(korean.starts_with("\"맑은 고딕\", 'Malgun Gothic',"));
        let sub = canvas_font_family_chain("나눔고딕", "한컴바탕");
        assert!(sub.starts_with("\"나눔고딕\", \"한컴바탕\","));
        for family_chain in [&chain, &plain, &poppy, &canvas, &korean, &sub] {
            let names: Vec<_> = family_chain
                .split(',')
                .map(|family| family.trim().trim_matches(['\'', '"']))
                .collect();
            for (index, name) in names.iter().enumerate() {
                assert!(
                    !names[..index].contains(name),
                    "중복 family: {family_chain}"
                );
            }
        }
    }

    #[test]
    fn test_generic_fallback() {
        // 시스템 설치 상태와 무관하게 알려진 face 의 이름 분류를 검증한다.
        // 미설치 face 는 macOS 한컴 기본 서체로 내려가는 별도 계약이다.
        assert!(generic_fallback("__rhwp_missing_Serif_Mono__")
            .starts_with("'HCR Dotum','함초롬돋움',"));
        let font = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/ttfs/opensource/NotoSansKR-Regular.ttf"
        ))
        .unwrap();
        let aliases: Vec<String> = [
            "D2Coding ligature",
            "Noto Sans Mono",
            "Noto Serif CJK SC",
            "Liberation Serif",
            "Noto Serif KR",
            "Liberation Sans",
            "Noto Sans KR",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        crate::renderer::runtime_font_metrics::register(&font, &aliases, false, false).unwrap();

        let serif = "'Batang','바탕','Nanum Myeongjo','AppleMyungjo','Noto Serif KR','Noto Serif CJK KR','Haansoft Batang','한컴바탕','HCR Batang Ext-B','함초롬바탕 확장B','HCR Batang Ext','함초롬바탕 확장','HCR Batang','함초롬바탕','Source Han Serif K Old Hangul',serif";
        let sans = "'Malgun Gothic','맑은 고딕','Apple SD Gothic Neo','Noto Sans KR ExtraLight','Noto Sans KR','Pretendard','Haansoft Dotum','한컴돋움','HCR Dotum','함초롬돋움','HCR Batang Ext-B','함초롬바탕 확장B','HCR Batang Ext','함초롬바탕 확장','HCR Batang','함초롬바탕','Source Han Serif K Old Hangul',sans-serif";
        // Task #1224: ExtraLight 가 무거운 Noto 직전에 위치하는지 명시 검증
        assert!(sans.contains("'Noto Sans KR ExtraLight','Noto Sans KR'"));
        let mono = "'GulimChe','굴림체','D2Coding','Noto Sans Mono',monospace";
        // 세리프 계열
        assert_eq!(generic_fallback("함초롬바탕"), serif);
        assert_eq!(generic_fallback("바탕"), serif);
        assert_eq!(generic_fallback("궁서"), serif);
        assert_eq!(generic_fallback("HY견명조"), serif);
        assert_eq!(generic_fallback("Times New Roman"), serif);
        assert_eq!(generic_fallback("Palatino Linotype"), serif);
        // HFT HCI Poppy: Palatino 대체 서체 → 세리프 체인
        assert!(generic_fallback("HCI Poppy").starts_with("'Palatino','Palatino Linotype',"));
        assert!(generic_fallback("HCI Poppy").ends_with(serif));
        // KoPub바탕체는 이름에 "바탕체"가 들어가지만 고정폭 BatangChe가 아니라
        // 비례폭 본문/제목용 세리프 계열이다.
        assert_eq!(generic_fallback("KoPub바탕체 Light"), serif);
        assert_eq!(generic_fallback("KoPub바탕체 Medium"), serif);
        assert_eq!(generic_fallback("KoPub Batang Medium"), serif);
        // 산세리프 계열
        assert_eq!(generic_fallback("함초롬돋움"), sans);
        assert_eq!(generic_fallback("돋움"), sans);
        assert_eq!(generic_fallback("굴림"), sans);
        assert_eq!(generic_fallback("Arial"), sans);
        assert_eq!(generic_fallback("맑은 고딕"), sans);
        assert!(generic_fallback("KoPub돋움체 Light")
            .starts_with("'Noto Sans KR ExtraLight','Malgun Gothic'"));
        assert!(generic_fallback("KoPub Dotum Light")
            .starts_with("'Noto Sans KR ExtraLight','Malgun Gothic'"));
        // 고정폭 계열
        assert_eq!(generic_fallback("굴림체"), mono);
        assert_eq!(generic_fallback("바탕체"), mono);
        assert_eq!(generic_fallback("Courier New"), mono);
        assert_eq!(generic_fallback("D2Coding ligature"), mono);
        assert_eq!(generic_fallback("Noto Sans Mono"), mono);
        // 영문 세리프 (issue #616)
        assert_eq!(generic_fallback("Noto Serif CJK SC"), serif);
        assert_eq!(generic_fallback("Liberation Serif"), serif);
        assert_eq!(generic_fallback("Noto Serif KR"), serif);
        // "sans" 포함 폰트는 세리프로 분류되지 않음
        assert_eq!(generic_fallback("Liberation Sans"), sans);
        assert_eq!(generic_fallback("Noto Sans KR"), sans);
        // 빈 문자열
        assert_eq!(generic_fallback(""), sans);
        crate::renderer::runtime_font_metrics::clear();
    }

    #[test]
    fn test_medium_weight_face() {
        use crate::renderer::style_resolver::is_medium_weight_face;
        assert!(is_medium_weight_face("HY중고딕"));
        assert!(is_medium_weight_face("신명 중고딕"));
        assert!(is_medium_weight_face("한양중고딕"));
        assert!(is_medium_weight_face("HY태고딕"));
        assert!(is_medium_weight_face("신명 태고딕"));
        assert!(!is_medium_weight_face("HY헤드라인M"));
        assert!(!is_medium_weight_face("돋움"));
        assert!(!is_medium_weight_face("바탕"));
        assert!(!is_medium_weight_face("맑은 고딕"));
        assert!(!is_medium_weight_face(""));
    }

    #[test]
    fn test_explicit_face_weight_hints() {
        let light = TextStyle {
            font_family: "KoPub돋움체 Light".to_string(),
            ..Default::default()
        };
        assert_eq!(light.css_font_weight(), Some("300"));

        let bold = TextStyle {
            font_family: "KoPub바탕체 Bold".to_string(),
            ..Default::default()
        };
        assert_eq!(bold.css_font_weight(), Some("bold"));
        assert!(bold.is_visually_bold());
    }

    #[test]
    fn hft_vertical_bold_copy_preserves_source_orientation_and_profile() {
        let mut style = TextStyle {
            font_size: 16.0,
            bold: true,
            hft_family: "한양중고딕".into(),
            font_metrics_policy: crate::model::provenance::FontMetricsPolicy::HcrDeclared,
            ..Default::default()
        };
        let copy = hft_vertical_bold_copy(&style, "데", true).unwrap();
        assert_eq!(copy.offset_y, 14.4);
        assert_eq!(copy.embolden_x, 0.8);
        assert_eq!(copy.x_offsets().count(), 6);
        assert!(hft_vertical_bold_copy(&style, "데", false).is_none());
        let paren = hft_vertical_bold_copy(&style, "(", true).unwrap();
        assert_eq!(paren.offset_x, -0.4);
        assert_eq!(paren.offset_y, 0.4);
        assert_eq!(paren.rotation, 90.0);
        assert_eq!(paren.embolden_x, 0.8);
        assert!(hft_vertical_bold_copy(&style, "A", true).is_none());
        assert!(hft_vertical_bold_copy(&style, "데(A)", true).is_none());
        assert!(hft_vertical_bold_copy(&style, "", true).is_none());
        style.font_metrics_policy = crate::model::provenance::FontMetricsPolicy::HancomWindows;
        assert!(hft_vertical_bold_copy(&style, "데", true).is_none());
        style.font_metrics_policy = crate::model::provenance::FontMetricsPolicy::HcrDeclared;
        style.bold = false;
        assert!(hft_vertical_bold_copy(&style, "데", true).is_none());
        style.bold = true;
        style.italic = true;
        assert!(hft_vertical_bold_copy(&style, "데", true).is_none());
        style.italic = false;
        style.hft_family.clear();
        assert!(hft_vertical_bold_copy(&style, "데", true).is_none());
    }

    #[test]
    fn test_format_number_hangul() {
        assert_eq!(format_number(1, NumberFormat::HangulGaNaDa), "가");
        assert_eq!(format_number(2, NumberFormat::HangulGaNaDa), "나");
        assert_eq!(format_number(1, NumberFormat::HangulNumber), "일");
        assert_eq!(format_number(12, NumberFormat::HangulNumber), "십이");
    }
}

#[cfg(test)]
mod tab_leader_spacing_tests {
    use super::dot_tab_leader_layout;

    #[test]
    fn tab_leader_reserves_leading_glyph_bearing_without_changing_end_phase() {
        let (first, last, diameter, pitch) = dot_tab_leader_layout(20.0, 100.0, 16.0).unwrap();
        assert!(first - diameter / 2.0 >= 28.0);
        assert!((last - 103.04).abs() < 1e-9);
        assert!(((last - first) / pitch).fract().abs() < 1e-9);
        assert!(dot_tab_leader_layout(20.0, 23.0, 16.0).is_none());
    }
}

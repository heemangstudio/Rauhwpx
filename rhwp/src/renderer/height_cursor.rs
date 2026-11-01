//! [Task #1027 Stage C] 공유 측정 커서 (페이지네이터 ↔ 렌더러 y-advance 정합).
//!
//! 렌더러(`layout.rs build_single_column`)의 컬럼 단위 inter-item VPOS_CORR
//! 상태머신을 캡슐화한다. 한 컬럼을 흐르는 동안의 vpos 기준점(page_base/
//! lazy_base)과 직전 항목 추적 상태를 보유하며, 항목 사이의 vpos 보정(Stage A
//! `vpos_corrected_end_y` + Stage B `para_has_overlay_shape` 결합)을 적용한다.
//!
//! Stage C: 렌더러가 이 커서에 위임(무동작). Stage D 에서 페이지네이터(typeset)
//! 가 동일 커서로 height-only 패스를 수행하여 두 측정 공간을 일치시킨다.
//!
//! 보유 상태(렌더러 build_single_column 로컬과 1:1):
//! - `vpos_page_base` / `vpos_lazy_base`: vpos→y 변환 기준점 (#412).
//! - `prev_layout_para`: 직전에 배치한 문단 인덱스.
//! - `prev_item_was_partial_table`: 직전 항목이 분할 표였는지 (#991).
//!
//! 기하 상수: `dpi`, `col_area_y/height`, `col_anchor_y`.

use super::layout::{para_has_overlay_shape, vpos_corrected_end_y};
use super::style_resolver::ResolvedStyleSet;
use crate::model::control::Control;
use crate::model::paragraph::Paragraph;
use crate::model::shape::{TextWrap, VertRelTo};
use crate::renderer::hwpunit_to_px;

fn para_has_visible_text(para: &Paragraph) -> bool {
    para.text.chars().any(|c| c > '\u{001F}' && c != '\u{FFFC}')
}

fn para_is_treat_as_char_equation_only(para: &Paragraph) -> bool {
    !para_has_visible_text(para)
        && para
            .controls
            .iter()
            .any(|ctrl| matches!(ctrl, Control::Equation(eq) if eq.common.treat_as_char))
}

fn para_has_equation_only(para: &Paragraph) -> bool {
    !para_has_visible_text(para)
        && para
            .controls
            .iter()
            .any(|ctrl| matches!(ctrl, Control::Equation(_)))
}

fn para_is_treat_as_char_picture_only(para: &Paragraph) -> bool {
    para.text.trim().is_empty()
        && para.controls.iter().any(|ctrl| match ctrl {
            Control::Picture(pic) => pic.common.treat_as_char,
            Control::Shape(shape) => shape.common().treat_as_char,
            _ => false,
        })
}

fn para_has_treat_as_char_table(para: &Paragraph) -> bool {
    para.controls
        .iter()
        .any(|ctrl| matches!(ctrl, Control::Table(table) if table.common.treat_as_char))
}

fn compact_between_notes_gap_px(raw_gap_hu: i32, dpi: f64, use_pagination_gap: bool) -> f64 {
    if raw_gap_hu <= 0 {
        return 10.0;
    }
    let effective_hu = if use_pagination_gap {
        let extra = (raw_gap_hu - 1984).max(0);
        if extra > 0 {
            extra * 3 / 4
        } else {
            raw_gap_hu
        }
    } else {
        raw_gap_hu
    };
    hwpunit_to_px(effective_hu, dpi)
}

pub(crate) struct HeightCursor {
    /// DPI (px/inch).
    pub dpi: f64,
    /// 단 영역 top y (px). lazy_path anchor.
    pub col_area_y: f64,
    /// 단 영역 높이 (px). 본문내 클램프 상한 산출.
    pub col_area_height: f64,
    /// body_wide_reserved 푸시 적용 후 첫 항목 y (px). page_path anchor (#412).
    pub col_anchor_y: f64,
    /// 페이지 기준 vpos. 첫 PageItem 이 명확한 vpos 를 가질 때 (#412).
    pub vpos_page_base: Option<i32>,
    /// 지연 기준 vpos. 첫 PageItem 이 신뢰 불가할 때 sequential y 에서 역산 (#412).
    pub vpos_lazy_base: Option<i32>,
    /// 직전 배치 문단 인덱스.
    pub prev_layout_para: Option<usize>,
    /// 직전 항목이 분할 표(PartialTable)였는지 (#991).
    pub prev_item_was_partial_table: bool,
    /// HWP3-origin 흐름에서는 vpos 보정에서 spacing_before 사전 차감을 생략한다(#1116).
    pub skip_spacing_before_prededuct: bool,
    /// 미주 흐름에서는 LINE_SEG vpos 가 같은 단 안에서 크게 되감길 수 있다.
    pub allow_vpos_rewind: bool,
    /// 미주 단은 하단부에서 뒤로 크게 되감을 수 있다.
    pub allow_start_height_backtrack: bool,
    /// 미주 흐름의 큰 forward vpos 점프는 단/쪽 재배치 흔적일 수 있어 순차 배치를 유지한다.
    pub suppress_large_forward_jump: bool,
    /// HWPX 원본의 일부 LINE_SEG vpos 는 이전 쪽/단 조판 좌표가 남아 페이지 상단 본문을
    /// 과도하게 아래로 밀 수 있다. 원본 IR은 보존하고 조판 커서에서만 제한적으로 접는다.
    pub suppress_hwpx_stale_forward: bool,
    /// Paint-only correction for an underfilled non-affecting endnote equation line.
    /// Pagination keeps the saved height budget to preserve page assignment.
    pub render_endnote_textheight_compaction: bool,
    /// [Task #1246] 현재 섹션 미주의 between-notes 마진(HU, 0=미적용). 새 미주 제목이 forward
    /// 흐름에서 이 마진보다 작은 간격을 가지면(다줄 풀이 끝 trailing 누락=문22) 끌어올린다.
    /// 생성자는 0 으로 두고 호출자(build_single_column)가 미주 흐름 컬럼에서만 설정한다.
    pub endnote_between_notes_hu: i32,
    /// 렌더러가 기록한 직전 항목의 실제 콘텐츠 하단(px). trailing 줄간격을 실제
    /// 콘텐츠 하단으로 오인하는 compact 미주 경계에서 공통 gap 기준으로 사용한다.
    pub prev_item_content_bottom_y: Option<f64>,
    /// 직전 `vpos_adjust`에서 새 미주 제목 gap을 저장 end_y보다 위로 compact했는지.
    pub(crate) last_compacted_endnote_title_gap: bool,
    /// [편집 세션] 저장 사다리의 전방 점프가 쪽 말미(하단 15%)로 향하면 기각한다.
    /// 편집으로 앞 내용이 밀린 뒤의 저장 좌표는 이 쪽의 물리 상태와 무관해,
    /// 점프하면 후속 분할 조각이 쪽 밖으로 밀린다(셀 Enter 재현).
    pub session_edited: bool,
    /// [lso-load4] 로드가 모든 줄을 직접 조판한 문서 — 빈 문단도 줄 높이 + 줄간격으로 순차
    /// 전진하므로 저장 사다리용 trailing-ls bridge 가 줄간격을 이중 계상한다 (줄 정보를
    /// 지운 kedi p2: 빈 문단 뒤 +10.4px 씩 누적 → 7쪽).
    pub own_line_layout: bool,
}

impl HeightCursor {
    /// 컬럼 진입 시 생성. `vpos_page_base` 초기값은 호출자가 첫 PageItem 에서 산출.
    pub(crate) fn new(
        dpi: f64,
        col_area_y: f64,
        col_area_height: f64,
        col_anchor_y: f64,
        vpos_page_base: Option<i32>,
        skip_spacing_before_prededuct: bool,
        allow_vpos_rewind: bool,
        allow_start_height_backtrack: bool,
        suppress_large_forward_jump: bool,
    ) -> Self {
        HeightCursor {
            dpi,
            col_area_y,
            col_area_height,
            col_anchor_y,
            vpos_page_base,
            vpos_lazy_base: None,
            prev_layout_para: None,
            prev_item_was_partial_table: false,
            skip_spacing_before_prededuct,
            allow_vpos_rewind,
            allow_start_height_backtrack,
            suppress_large_forward_jump,
            suppress_hwpx_stale_forward: false,
            render_endnote_textheight_compaction: false,
            endnote_between_notes_hu: 0,
            prev_item_content_bottom_y: None,
            last_compacted_endnote_title_gap: false,
            session_edited: false,
            own_line_layout: false,
        }
    }

    /// 항목 배치 직전, vpos 기반 y_offset 보정을 적용한다.
    ///
    /// 렌더러 `build_single_column` 의 inter-item VPOS_CORR 블록과 동작 동일.
    /// 보정이 적용되면 보정된 y, 아니면 입력 `y_offset` 을 그대로 반환한다.
    /// `vpos_lazy_base` 는 지연 산출 시 갱신된다.
    ///
    /// 호출자는 `!shape_jumped && !prev_tac_seg_applied` 가드 안에서 호출한다.
    pub(crate) fn vpos_adjust(
        &mut self,
        y_offset: f64,
        item_para: usize,
        paragraphs: &[Paragraph],
        styles: &ResolvedStyleSet,
    ) -> f64 {
        self.last_compacted_endnote_title_gap = false;
        let Some(prev_pi) = self.prev_layout_para else {
            return y_offset;
        };
        if item_para == prev_pi {
            return y_offset;
        }
        // 글앞으로/글뒤로/위아래 Shape·Picture 가 있는 문단: vpos 에 개체 높이 포함 → bypass
        // (#409, #1027 Stage B). 분할 표 직후 첫 문단도 sequential 신뢰 (#991).
        let prev_has_overlay_shape = paragraphs
            .get(prev_pi)
            .map(para_has_overlay_shape)
            .unwrap_or(false);
        if prev_has_overlay_shape || self.prev_item_was_partial_table {
            return y_offset;
        }
        let Some(prev_para) = paragraphs.get(prev_pi) else {
            return y_offset;
        };
        // Task #332 Stage 5: width 검증을 가드 조건으로 약화, 마지막 유효 segment 사용.
        let prev_seg = prev_para
            .line_segs
            .iter()
            .rev()
            .find(|ls| ls.segment_width > 0)
            .or_else(|| prev_para.line_segs.last());
        let Some(seg) = prev_seg else {
            return y_offset;
        };
        // [Task #1811] 합성 seg(원본 linesegarray 부재 — reflow/컨버터 생성,
        // TAG_IMPLEMENTATION_PROPERTY)는 저장 증거가 아니다. **전방(forward)** 보정
        // 근거로 쓰면 구세션 저장 flow 위치로 과대 전진해(+9.6px) 후속 분할 표 예산이
        // 부족해진다 (saved_bounds_cumulative_page_break p4 컷 [2]→[3] 결손).
        // [Task #1811 v2] 단, 되감기와 대형 재앵커 점프는 허용한다 — 전면 차단하면
        // 파스 경로별 미세 측정차가 재동기화를 잃고 누적되어 라운드트립 쪽나눔이
        // 갈린다 (seoul_1006 p7→p8 Group+줄 이월 회귀). 판정은 최종 result 산출 후
        // 방향·크기로 한다 (함수 끝 SYNTH_FORWARD_REANCHOR_MIN_PX 클램프).
        let synthetic_prev_seg =
            seg.tag & crate::model::paragraph::LineSeg::TAG_IMPLEMENTATION_PROPERTY != 0;
        if seg.vertical_pos == 0 && prev_pi > 0 {
            return y_offset;
        }
        let prev_vpos_end = seg.vertical_pos + seg.line_height + seg.line_spacing;
        // 실제 콘텐츠 하단에서 미주 간격을 이미 소비했으면 하단 제목 cap으로 줄이지 않는다.
        let preserve_measured_note_gap = self.suppress_hwpx_stale_forward
            && self.suppress_large_forward_jump
            && self.endnote_between_notes_hu > 0
            && seg.line_spacing >= self.endnote_between_notes_hu
            && self.prev_item_content_bottom_y.is_some_and(|bottom| {
                bottom.is_finite()
                    && ((y_offset - bottom)
                        - hwpunit_to_px(self.endnote_between_notes_hu, self.dpi))
                    .abs()
                        <= 0.5
            });
        // A saved prime/superscript object can enlarge its LineSeg even when it
        // does not affect line spacing. Once the previous paragraph has flowed
        // with the ordinary text box, carry that contraction through the saved
        // vpos ladder; otherwise the next paragraph snaps back down.
        let contraction = if self.suppress_hwpx_stale_forward {
            crate::renderer::equation::stored_unaffected_upper_compaction_hu(prev_para)
                + if self.render_endnote_textheight_compaction {
                    crate::renderer::equation::endnote_unaffected_equation_textheight_compaction_total_hu(
                        prev_para,
                    )
                } else {
                    0
                }
        } else {
            0
        };
        if contraction > 0 {
            if let Some(base) = self.vpos_page_base.as_mut() {
                *base += contraction;
            } else if let Some(base) = self.vpos_lazy_base.as_mut() {
                *base += contraction;
            }
        }
        let curr_first_vpos = paragraphs
            .get(item_para)
            .and_then(super::float_placement::paragraph_flow_anchor);
        let prev_spacing_after_hu = styles
            .para_styles
            .get(prev_para.para_shape_id as usize)
            .map(|ps| (ps.spacing_after * 7200.0 / self.dpi).round() as i32)
            .unwrap_or(0);
        // [Task #412] page_base / lazy_base 경로 분리.
        let (base, is_page_path) = if let Some(b) = self.vpos_page_base {
            (b, true)
        } else if let Some(b) = self.vpos_lazy_base {
            (b, false)
        } else {
            // [Task #1022 v2] trailing-ls 보정의 조건부 복원 (upstream stream/devel 정합).
            // 컬럼이 vpos 0 에서 시작해 sequential 이 IR 을 정확히 추적(drift 0)하면
            // +trailing_ls 는 over-correction(lazy_base 음수 → 표 overflow, exam_kor p5).
            // 그러나 컬럼이 vpos 0 이 아닌 곳에서 시작(상단 박스/도형 뒤 본문, footnote-01 p1)
            // 하면 trailing_ls bridge 가 필요. 게이트: 보정 lazy_base ≥ 0 이면 보정 적용.
            // [Task #1049] 직전이 실텍스트 본문 문단이고 vpos 가 연속
            // (curr_first_vpos == prev_vpos_end)이면, 그 문단의 trailing 줄간격이 이미
            // 연속 vpos 흐름·sequential y 에 포함되어 있으므로 trailing-ls bridge 를 끈다
            // (인라인 TAC 리셋 직후 +trailing_ls 가 12.8px 과대 전진을 일으키는 회귀 차단).
            // - curr_first_vpos 가 prev_vpos_end 초과(gap: top-box 후 본문·footnote-01 p1)
            //   또는 미상이면 종전대로 bridge 적용(#1022 v2).
            // - 직전이 빈 문단이면 렌더러의 빈줄 높이 억제로 trailing_ls 가 sequential y 에
            //   반영되지 않을 수 있어 bridge 유지(복학원서 page1: 빈 문단 뒤 폼 표).
            let prev_has_text = prev_para
                .text
                .chars()
                .any(|c| c > '\u{001F}' && c != '\u{FFFC}');
            // [#2243] 직전 문단이 **빈 앵커 자리차지(TopAndBottom, 비-TAC) 표 host** 면
            // prev_end→curr 저장 vpos 갭은 표의 흐름 공간 인코딩이다. sequential y 는
            // 표 소비를 이미 포함하므로 lazy 역산이 이 갭을 재가산하면 표 높이만큼
            // 이중 계상된다 (36382819 pi=31: lazy_base 역산 +12971HU → 페이지3
            // +184.9px → 4쪽 sliver, 한글 3쪽). 보정 없이 sequential 을 신뢰한다.
            // page_base 경로(절대 좌표)는 정상 동작하므로 lazy 역산 한정.
            let prev_is_empty_float_table_host = !prev_has_text
                && prev_para.controls.iter().any(|c| {
                    matches!(c, Control::Table(t)
                        if !t.common.treat_as_char
                            && matches!(t.common.text_wrap, TextWrap::TopAndBottom))
                });
            // 전방 재가산 형상(저장 갭 존재 = curr_v0 > prev_end)만 차단 — 갭이
            // 없으면 정상 lazy 역산을 유지해 sequential 과대의 역방향 보정을
            // 살린다 (156631374: 무차별 차단 시 1→2쪽 회귀).
            let stored_gap_exists = matches!(curr_first_vpos, Some(v) if v > prev_vpos_end);
            if prev_is_empty_float_table_host && stored_gap_exists {
                return y_offset;
            }
            // [lso-load4] 로드가 직접 조판한 문서는 텍스트가 있는 host 문단도 같다 — vpos
            // 사다리는 host 줄 끝에 자리차지 표 높이를 더해 다음 문단을 두고(cluster 15),
            // 순차 y 도 표 항목을 이미 소비했다. 역산하면 표 높이만큼 이중 전진한다
            // (줄 정보 없는 aift 44쪽 pi=580: +339px → 다음 표가 쪽을 넘김, 75쪽).
            let prev_hosts_float_table = prev_para.controls.iter().any(|c| {
                matches!(c, Control::Table(t)
                    if !t.common.treat_as_char
                        && matches!(t.common.text_wrap, TextWrap::TopAndBottom))
            });
            if self.own_line_layout && prev_hosts_float_table && stored_gap_exists {
                return y_offset;
            }
            // [Issue #1898] 직전 문단이 "실텍스트 + 인라인(tac) 그림 호스트" 이면, 저장
            // vpos gap 이 현재 문단 spacing_before 이하일 때 연속으로 본다. 이 gap 은 sb
            // 인코딩이며 sb 는 vpos_corrected_end_y 가 별도로 사전 차감하므로 이미 계상된
            // 정상 전진이다. tac 그림 PageItem 이 vpos base 를 리셋한 직후 이 gap 을
            // 불연속으로 오판해 +trailing_ls bridge 를 더하면 그림 문단 뒤 줄 전진이
            // gap 1회분(+11.7px) 과대해진다 (36388711 p9 참고자료: 렌더 44.8px vs
            // layout/한컴 33.1px — 기전 1). 시그니처를 tac 그림 텍스트 호스트 직후로
            // 한정해 일반 lazy 재역산의 bridge 는 종전 유지 (rowbreak-problem-pages
            // 쪽나눔 무회귀). HWP3-origin 변환본(sb 사전 차감 생략 경로)도 종전 유지.
            let prev_is_tac_picture_text_host = prev_has_text
                && prev_para
                    .controls
                    .iter()
                    .any(|c| matches!(c, Control::Picture(p) if p.common.treat_as_char));
            // 일반 본문도 실제 하단에서 후행 줄간격을 이미 소비했으면 같은 sb 규칙을 쓴다.
            // 빈 spacer·개체 host·미측정 경로는 기존 bridge를 유지한다.
            let prev_text_tail_consumed = prev_has_text
                && !prev_para.text.trim().is_empty()
                && prev_para.controls.is_empty()
                && self.prev_item_content_bottom_y.is_some_and(|bottom| {
                    bottom.is_finite()
                        && ((y_offset - bottom) - hwpunit_to_px(seg.line_spacing.max(0), self.dpi))
                            .abs()
                            <= 0.5
                });
            let curr_sb_hu = if self.skip_spacing_before_prededuct
                || !(prev_is_tac_picture_text_host || prev_text_tail_consumed)
            {
                0
            } else {
                paragraphs
                    .get(item_para)
                    .and_then(|p| styles.para_styles.get(p.para_shape_id as usize))
                    .map(|ps| ((ps.spacing_before * 7200.0 / self.dpi).round() as i32).max(0))
                    .unwrap_or(0)
            };
            let vpos_continuous =
                matches!(curr_first_vpos, Some(v) if v <= prev_vpos_end + curr_sb_hu);
            // 합성 TAC 표의 줄간격은 표 배치에서 이미 소비한다. 그 뒤 빈 줄도
            // 완전한 줄 전진으로 배치되므로 lazy 원점 역산에 간격을 다시 빼면
            // 다음 저장 줄부터 같은 간격이 중복된다.
            let follows_synthetic_tac_table = prev_pi
                .checked_sub(1)
                .and_then(|pi| paragraphs.get(pi))
                .is_some_and(|p| {
                    para_has_treat_as_char_table(p)
                        && p.line_segs.last().is_some_and(|ls| {
                            ls.tag & crate::model::paragraph::LineSeg::TAG_IMPLEMENTATION_PROPERTY
                                != 0
                        })
                });
            let consumed_synthetic_tac_spacing = (synthetic_prev_seg
                && para_has_treat_as_char_table(prev_para))
                || (!prev_has_text && prev_para.controls.is_empty() && follows_synthetic_tac_table);
            // 빈 미주 줄도 실제 렌더가 후행 간격을 소비했다면 bridge를 중복하지 않는다.
            let previous_gap_consumed = self.suppress_large_forward_jump
                && self.suppress_hwpx_stale_forward
                && self
                    .prev_item_content_bottom_y
                    .filter(|y| y.is_finite())
                    .is_some_and(|bottom| {
                        y_offset - bottom >= hwpunit_to_px(seg.line_spacing.max(0), self.dpi) - 0.5
                    });
            let trailing_ls_hu = if self.own_line_layout
                || vpos_continuous
                    && (prev_has_text || consumed_synthetic_tac_spacing || previous_gap_consumed)
            {
                0
            } else {
                paragraphs
                    .get(prev_pi)
                    .and_then(|p| p.line_segs.last())
                    .map(|s| s.line_spacing.max(0))
                    .unwrap_or(0)
            };
            let y_delta_hu = ((y_offset - self.col_area_y) / self.dpi * 7200.0).round() as i32;
            // 렌더 커서가 줄간격과 문단 뒤 간격을 이미 소비했으면 같은 끝점으로
            // 원점을 역산한다. fit 커서나 문단 중간 조각은 뒤 간격을 아직 쓰지
            // 않을 수 있으므로 실제 콘텐츠 하단과 남은 간격으로 확인한다.
            // 빈 spacer의 콘텐츠 하단은 줄 상단이므로 빈 줄 높이도 남은 간격에 포함한다.
            let blank_line_height_hu =
                if prev_para.text.trim().is_empty() && prev_para.controls.is_empty() {
                    seg.line_height.max(0)
                } else {
                    0
                };
            let painted_after_consumed = prev_spacing_after_hu > 0
                && self.prev_item_content_bottom_y.is_some_and(|bottom| {
                    bottom.is_finite()
                        && ((y_offset - bottom)
                            - hwpunit_to_px(
                                seg.line_spacing
                                    .saturating_add(prev_spacing_after_hu)
                                    .saturating_add(blank_line_height_hu),
                                self.dpi,
                            ))
                        .abs()
                            <= 0.5
                });
            let consumed_after_spacing = self.own_line_layout
                && (painted_after_consumed
                    || (!prev_has_text && para_is_treat_as_char_picture_only(prev_para)));
            let consumed_vpos_end = if consumed_after_spacing {
                prev_vpos_end.saturating_add(prev_spacing_after_hu.max(0))
            } else {
                prev_vpos_end
            };
            let lazy_base_corrected = consumed_vpos_end - (y_delta_hu + trailing_ls_hu);
            let lazy_base = if lazy_base_corrected >= 0 {
                lazy_base_corrected
            } else {
                consumed_vpos_end - y_delta_hu
            };
            if lazy_base < 0 {
                // 역산 무효(자리차지 표 등): 이전 개체 높이가 sequential y 에 이미
                // 반영된 상태다. 여기서 vpos 보정을 적용하면 단 상단으로 되감겨
                // 본문 표와 뒤따르는 미주가 겹친다.
                if std::env::var("RHWP_VPOS_DEBUG").is_ok() {
                    eprintln!(
                        "VPOS_CORR_SKIP: pi={} prev_pi={} y_in={:.2} prev_vpos_end={} lazy_base_corrected={} lazy_base={}",
                        item_para, prev_pi, y_offset, prev_vpos_end, lazy_base_corrected, lazy_base,
                    );
                }
                let compact_endnote_question_title = self.suppress_large_forward_jump
                    && paragraphs
                        .get(item_para)
                        .map(|p| p.text.trim_start().starts_with('문'))
                        .unwrap_or(false)
                    && seg.line_spacing > 1000;
                let compact_zero_gap_endnote_title_boundary = self.suppress_large_forward_jump
                    && self.endnote_between_notes_hu == 0
                    && paragraphs
                        .get(item_para)
                        .map(|p| p.text.trim_start().starts_with('문'))
                        .unwrap_or(false)
                    && seg.line_spacing > 0
                    && seg.line_spacing <= 800;
                if compact_zero_gap_endnote_title_boundary {
                    // 0/0/0 미주에서 lazy_base 역산이 무효가 되는 페이지/단 시작부는
                    // 순차 y가 직전 문단 trailing line_spacing까지 포함한다. 한컴은
                    // 미주 사이 0mm 경계에서는 그 trailing gap을 다음 제목 앞 간격으로
                    // 쓰지 않으므로 한 줄 gap만 접어 문항별 +6px 누적 drift를 막는다.
                    let prev_line_spacing_px = (seg.line_spacing.max(0) as f64) / 7200.0 * self.dpi;
                    let compacted_y = y_offset - prev_line_spacing_px;
                    if compacted_y >= self.col_area_y && y_offset - compacted_y <= 12.0 {
                        return compacted_y;
                    }
                }
                if compact_endnote_question_title
                    && !preserve_measured_note_gap
                    && y_offset > self.col_area_y + self.col_area_height * 0.85
                {
                    let prev_line_spacing_px = (seg.line_spacing.max(0) as f64) / 7200.0 * self.dpi;
                    let prev_content_bottom_y = y_offset - prev_line_spacing_px;
                    let capped_y = prev_content_bottom_y + 10.0;
                    if capped_y < y_offset
                        && y_offset - capped_y <= 24.0
                        && capped_y >= self.col_area_y
                    {
                        return capped_y;
                    }
                }
                return y_offset;
            } else {
                self.vpos_lazy_base = Some(lazy_base);
                (lazy_base, false)
            }
        };
        // [Task #874 #8] stale table-host(TopAndBottom+vert=Para) 판정.
        let curr_has_topbottom_para_table = paragraphs
            .get(item_para)
            .map(|p| {
                p.controls.iter().any(|c| {
                    matches!(c, Control::Table(t)
                        if !t.common.treat_as_char
                        && matches!(t.common.text_wrap, TextWrap::TopAndBottom)
                        && matches!(t.common.vert_rel_to, VertRelTo::Para))
                })
            })
            .unwrap_or(false);
        // [Task #412] 현재 paragraph first vpos 우선(spacing_after 인코딩), reset 시 fallback.
        //
        // 단, 현재 문단이 para-relative TopAndBottom 표의 host 이면 first_vpos 가 표
        // 예약 높이를 포함할 수 있다. 그 값을 inter-item 목표 y 로 쓰면 표 높이만큼
        // 빈 공간을 만든 뒤 표를 다시 배치하게 된다(PR #1088 hwp-multi-001 pi=14).
        // 이 경우에는 직전 문단의 line-seg 끝만 신뢰하고, 표 위치/높이는 Table
        // PageItem 렌더 단계에서 반영한다.
        let vpos_rewind = matches!(curr_first_vpos, Some(v) if v < seg.vertical_pos);
        let curr_tac_picture_only = paragraphs
            .get(item_para)
            .map(para_is_treat_as_char_picture_only)
            .unwrap_or(false);
        let prev_has_visible_text = paragraphs
            .get(prev_pi)
            .map(para_has_visible_text)
            .unwrap_or(false);
        let compact_endnote_tac_picture_rewind = self.suppress_large_forward_jump
            && vpos_rewind
            && curr_tac_picture_only
            && !prev_has_visible_text;
        let compact_endnote_bottom_rewind = self.suppress_large_forward_jump
            && vpos_rewind
            && y_offset > self.col_area_y + self.col_area_height * 0.75;
        let vpos_end = match curr_first_vpos {
            Some(v)
                if (self.allow_vpos_rewind
                    || compact_endnote_bottom_rewind
                    || compact_endnote_tac_picture_rewind)
                    && vpos_rewind =>
            {
                v
            }
            Some(v) if v > seg.vertical_pos && !curr_has_topbottom_para_table => v,
            // 표 host 의 첫 vpos 가 직전 문단 끝 + 직전 문단 문단 아래 간격 안이면 표
            // 예약 높이가 아니라 그 간격의 인코딩이다 — 그대로 쓴다 (kedi-application
            // p3: sa 200HU 뒤 RowBreak 표, 한컴 PDF 실측 표 상단 = 저장 vpos).
            Some(v)
                if curr_has_topbottom_para_table
                    && v > prev_vpos_end
                    && v - prev_vpos_end <= prev_spacing_after_hu =>
            {
                v
            }
            _ => prev_vpos_end,
        };
        // [Task #643] sb_N 사전 차감 대상 (vpos_corrected_end_y 내부에서 차감).
        let curr_sb = paragraphs
            .get(item_para)
            .and_then(|p| styles.para_styles.get(p.para_shape_id as usize))
            .map(|ps| ps.spacing_before)
            .unwrap_or(0.0);
        // [Task #1027 Stage A] 공유 클램프 함수.
        let allow_large_backward = (self.allow_vpos_rewind && vpos_rewind)
            || (self.allow_start_height_backtrack
                && y_offset > self.col_area_y + self.col_area_height * 0.75)
            || compact_endnote_bottom_rewind
            || compact_endnote_tac_picture_rewind;
        let (mut end_y, mut applied) = vpos_corrected_end_y(
            is_page_path,
            self.col_anchor_y,
            self.col_area_y,
            self.col_area_height,
            vpos_end,
            base,
            curr_sb,
            y_offset,
            curr_has_topbottom_para_table,
            self.skip_spacing_before_prededuct,
            allow_large_backward,
            self.dpi,
        );
        // An inline auto-height textbox can legitimately contract farther
        // than the ordinary 8px saved-position backtrack limit. Only accept
        // the larger move when it equals that textbox's recomposed height
        // change; unrelated stale saved positions keep the normal clamp.
        if !applied && self.suppress_hwpx_stale_forward && end_y < y_offset - 8.0 {
            if let Some(delta) = super::typeset::TypesetEngine::new(self.dpi)
                .live_inline_textbox_flow_delta_hu(prev_para, styles)
            {
                if delta < 0
                    && delta.checked_neg().is_some_and(|contraction| {
                        ((y_offset - end_y) - hwpunit_to_px(contraction, self.dpi)).abs() <= 0.75
                    })
                {
                    (end_y, applied) = vpos_corrected_end_y(
                        is_page_path,
                        self.col_anchor_y,
                        self.col_area_y,
                        self.col_area_height,
                        vpos_end,
                        base,
                        curr_sb,
                        y_offset,
                        curr_has_topbottom_para_table,
                        self.skip_spacing_before_prededuct,
                        true,
                        self.dpi,
                    );
                }
            }
        }
        let prev_line_spacing_px = (seg.line_spacing.max(0) as f64) / 7200.0 * self.dpi;
        let prev_content_bottom_y = y_offset - prev_line_spacing_px;
        let measured_prev_content_bottom_y =
            self.prev_item_content_bottom_y.filter(|y| y.is_finite());
        let prev_content_floor_y = measured_prev_content_bottom_y
            .map(|bottom| bottom.max(prev_content_bottom_y))
            .unwrap_or(prev_content_bottom_y);
        let follows_tall_inline_item = self.suppress_large_forward_jump && seg.line_height > 1500;
        let current_is_compact_endnote_title = self.suppress_large_forward_jump
            && paragraphs
                .get(item_para)
                .map(|p| p.text.trim_start().starts_with('문'))
                .unwrap_or(false);
        let prev_line_carries_note_gap = seg.line_spacing > 1000;
        let compact_endnote_question_title =
            current_is_compact_endnote_title && prev_line_carries_note_gap;
        let bottom_new_note_gap_cap = if self.suppress_large_forward_jump
            && end_y <= self.col_area_y + self.col_area_height
            && (y_offset > self.col_area_y + self.col_area_height * 0.75
                || compact_endnote_question_title)
        {
            let preserved_gap_y = if compact_endnote_question_title && follows_tall_inline_item {
                // compact 미주의 display 수식 뒤 새 문항 제목은 저장 trailing
                // line_spacing 전체 뒤가 아니라 실제 보이는 수식 하단 뒤의 "미주 사이"
                // 공통 간격에 맞춘다.
                // 렌더러가 실제 콘텐츠 하단을 제공하면 그 값을 공통 기준으로 삼고,
                // height-only 경로처럼 값이 없으면 기존 LINE_SEG 추정값으로 폴백한다.
                let content_bottom_y = measured_prev_content_bottom_y
                    .map(|y| y.max(prev_content_bottom_y))
                    .unwrap_or(prev_content_bottom_y);
                let gap_px = compact_between_notes_gap_px(
                    self.endnote_between_notes_hu,
                    self.dpi,
                    prev_para.text.trim().is_empty()
                        || para_is_treat_as_char_equation_only(prev_para),
                );
                content_bottom_y + gap_px
            } else if y_offset > self.col_area_y + self.col_area_height * 0.75
                || prev_para.text.trim().is_empty()
            {
                // Empty paragraphs before the next compact endnote title already carry the
                // visual spacer. Adding the mid-column buffer again pushes later notes down.
                y_offset + prev_line_spacing_px
            } else if prev_para.line_segs.len() > 1 && self.endnote_between_notes_hu <= 2500 {
                // 기본 미주 다줄 tail 뒤 새 문항은 single-line tail보다 완충이 작다.
                // 큰 40px buffer를 쓰면 2023-09 p19 문29처럼 뒤 풀이가 frame 밖으로 밀린다.
                y_offset + prev_line_spacing_px + 18.0
            } else {
                y_offset + prev_line_spacing_px + 40.0
            };
            if compact_endnote_question_title && follows_tall_inline_item {
                Some(preserved_gap_y)
            } else {
                Some(preserved_gap_y.min(end_y))
            }
        } else {
            None
        };
        let compact_endnote_new_note_jump = self.suppress_large_forward_jump
            && compact_endnote_question_title
            && (seg.line_height > 1500 || bottom_new_note_gap_cap.is_some())
            && end_y > y_offset + 32.0
            && end_y < y_offset + 120.0;
        let compact_endnote_stale_note_gap = self.suppress_large_forward_jump
            && !is_page_path
            && compact_endnote_question_title
            && !follows_tall_inline_item
            && y_offset <= self.col_area_y + self.col_area_height * 0.75
            && end_y > y_offset + 200.0
            && prev_line_spacing_px > 0.0;
        let compact_endnote_top_stale_note_gap = compact_endnote_stale_note_gap
            && y_offset <= self.col_area_y + self.col_area_height * 0.08;
        let stale_note_gap_y =
            compact_endnote_stale_note_gap.then_some(if compact_endnote_top_stale_note_gap {
                y_offset
            } else {
                y_offset + prev_line_spacing_px
            });
        let compact_endnote_tac_picture_gap = self.suppress_large_forward_jump
            && !is_page_path
            && end_y > y_offset
            && end_y <= y_offset + 12.0
            && (paragraphs
                .get(prev_pi)
                .map(para_is_treat_as_char_picture_only)
                .unwrap_or(false)
                || paragraphs
                    .get(item_para)
                    .map(para_is_treat_as_char_picture_only)
                    .unwrap_or(false));
        let follows_endnote_title = self.suppress_large_forward_jump
            && paragraphs
                .get(prev_pi)
                .map(|p| p.text.trim_start().starts_with('문'))
                .unwrap_or(false);
        let current_is_endnote_title = self.suppress_large_forward_jump
            && paragraphs
                .get(item_para)
                .map(|p| p.text.trim_start().starts_with('문'))
                .unwrap_or(false);
        // page-path compact 미주 하단의 새 문항 제목은 저장 vpos가 이미
        // 제목/다음 본문을 분리하는 경우가 있다. 기존 95% 꼬리 조건은
        // 2022-09 p17 문29처럼 하단 1줄 차이에서 제목만 아래로 눌러
        // 다음 본문과 겹치게 만들었으므로 page-path 제목만 90%부터 허용한다.
        let title_bottom_threshold = if is_page_path { 0.90 } else { 0.95 };
        let compact_endnote_title_bottom_backtrack = current_is_endnote_title
            && !preserve_measured_note_gap
            && !vpos_rewind
            && !prev_para.text.trim().is_empty()
            && end_y < y_offset - 8.0
            && y_offset > self.col_area_y + self.col_area_height * title_bottom_threshold
            && end_y <= self.col_area_y + self.col_area_height
            && y_offset - end_y <= 32.0;
        // [Task #1302] curr 첫 줄 stored vpos 가 prev 한 줄 정상 전진(lh+ls) 이상을 인코딩하는
        // **breakable 비제목 텍스트** 연속 문단은 overlap tail 이 아니라 정상 연속이다. 이때
        // page_base drift 로 end_y 가 위로 보여도(end_y < y_offset) page_tail backtrack 으로
        // y_offset(=trailing 포함 정답)을 깎으면 같은 미주 연속 문단이 컬럼 하단에서 줄간격이
        // 좁아진다(3-11월 18쪽 pi=852→853). 텍스트는 컬럼/쪽으로 넘길 수 있어 frame-fit 이
        // 불필요하다. 반면 문항 제목은 title-bottom 보정 계열의 기존 PDF 핀(#1284)을 따라야
        // 하고, 수식-only tail(#1274)은 atomic 이라 frame 안에 맞춰야 하므로 제외하고 종전대로
        // backtrack 한다(equation_tail_fit 경로와 정합).
        let curr_is_equation_only_tail = paragraphs
            .get(item_para)
            .map(para_is_treat_as_char_equation_only)
            .unwrap_or(false);
        let curr_first_full_advance = !current_is_endnote_title
            && !curr_is_equation_only_tail
            && matches!(
                curr_first_vpos,
                Some(v) if v - seg.vertical_pos >= seg.line_height + seg.line_spacing
            );
        let compact_endnote_page_tail_backtrack = self.suppress_large_forward_jump
            && is_page_path
            && !vpos_rewind
            && !follows_tall_inline_item
            && !curr_first_full_advance
            && end_y < y_offset - 8.0
            && y_offset > self.col_area_y + self.col_area_height * 0.95
            && end_y <= self.col_area_y + self.col_area_height
            && y_offset - end_y <= 32.0;
        let current_has_visible_text = paragraphs
            .get(item_para)
            .map(para_has_visible_text)
            .unwrap_or(false);
        let current_looks_like_numbered_note = paragraphs
            .get(item_para)
            .map(|p| {
                let text = p.text.trim_start();
                let digit_len = text
                    .as_bytes()
                    .iter()
                    .take_while(|b| b.is_ascii_digit())
                    .count();
                (1..=3).contains(&digit_len) && text.as_bytes().get(digit_len) == Some(&b')')
            })
            .unwrap_or(false);
        let current_is_tac_table_host = paragraphs
            .get(item_para)
            .map(para_has_treat_as_char_table)
            .unwrap_or(false);
        let compact_endnote_title_body_stale_forward = self.suppress_large_forward_jump
            && !is_page_path
            && follows_endnote_title
            && !current_is_endnote_title
            && !vpos_rewind
            && current_has_visible_text
            && end_y > y_offset + 32.0
            && end_y < y_offset + 120.0
            && y_offset > self.col_area_y + 1.0;
        let title_body_gap_y = compact_endnote_title_body_stale_forward
            .then_some(y_offset + prev_line_spacing_px.max(10.0).min(18.0));
        let compact_endnote_text_after_tall_tail_backtrack = self.suppress_large_forward_jump
            && is_page_path
            && !vpos_rewind
            // A continuous saved pitch already includes the previous line's
            // trailing spacing. Only a true saved rewind calls for pulling
            // the next text line toward the tall equation's bottom.
            && matches!(curr_first_vpos, Some(v) if v < prev_vpos_end)
            && follows_tall_inline_item
            && current_has_visible_text
            && !current_is_endnote_title
            && end_y < y_offset - 8.0
            && y_offset > self.col_area_y + self.col_area_height * 0.90
            && end_y <= self.col_area_y + self.col_area_height
            && y_offset - end_y <= 32.0;
        let compact_endnote_text_after_lazy_tall_equation_floor = self.suppress_large_forward_jump
            && !is_page_path
            && !vpos_rewind
            // 저장된 연속 진행량은 수식 뒤 간격을 이미 포함한다.
            // 실제 저장 되감기가 있을 때만 수식 하단의 여유를 추정한다.
            && matches!(curr_first_vpos, Some(v) if v < prev_vpos_end)
            && follows_tall_inline_item
            && current_has_visible_text
            && !current_is_endnote_title
            && para_has_equation_only(prev_para)
            && y_offset <= self.col_area_y + self.col_area_height - 80.0;
        let compact_endnote_deep_backtrack = self.suppress_large_forward_jump
            && !is_page_path
            && !vpos_rewind
            && !follows_endnote_title
            && !follows_tall_inline_item
            && !(compact_endnote_question_title && prev_para.text.trim().is_empty())
            && end_y < y_offset - 8.0
            && end_y >= prev_content_bottom_y
            && end_y <= self.col_area_y + self.col_area_height
            && y_offset > self.col_area_y + self.col_area_height * 0.90
            && y_offset - end_y <= 80.0;
        let compact_endnote_single_line_tail_backtrack = self.suppress_large_forward_jump
            && !is_page_path
            && !vpos_rewind
            && follows_endnote_title
            && end_y < y_offset - 8.0
            && y_offset > self.col_area_y + self.col_area_height
            && end_y <= self.col_area_y + self.col_area_height
            && end_y >= prev_content_bottom_y
            && y_offset - end_y <= 32.0;
        let current_line_advance_px = paragraphs
            .get(item_para)
            .and_then(|p| p.line_segs.first())
            .map(|s| hwpunit_to_px((s.line_height + s.line_spacing).max(0), self.dpi))
            .unwrap_or(0.0);
        let compact_endnote_page_no_separator_tail_pullup = self.suppress_large_forward_jump
            && is_page_path
            && current_has_visible_text
            && current_looks_like_numbered_note
            && !curr_is_equation_only_tail
            && seg.line_spacing < 0
            && current_line_advance_px <= 14.5
            && end_y < y_offset - 6.0
            && y_offset - end_y <= 18.0
            && end_y <= self.col_area_y + self.col_area_height
            && y_offset > self.col_area_y + self.col_area_height - 80.0;
        let current_line_height_px = paragraphs
            .get(item_para)
            .and_then(|p| p.line_segs.first())
            .map(|s| hwpunit_to_px(s.line_height.max(0), self.dpi))
            .unwrap_or(current_line_advance_px);
        let equation_tail_prev_overlap_tolerance = if is_page_path { 6.0 } else { 0.0 };
        let col_bottom = self.col_area_y + self.col_area_height;
        let compact_endnote_question_title_bottom_fit = self.suppress_large_forward_jump
            && current_is_endnote_title
            && !vpos_rewind
            && current_line_height_px > 0.0
            && y_offset + current_line_height_px > col_bottom + 0.5
            && y_offset <= col_bottom + 80.0
            && prev_content_bottom_y < col_bottom;
        let compact_endnote_question_title_tail_backtrack = self.suppress_large_forward_jump
            && !is_page_path
            && current_is_endnote_title
            && !vpos_rewind
            && prev_para.text.trim().is_empty()
            && end_y < y_offset - 32.0
            && y_offset > self.col_area_y + self.col_area_height * 0.90
            && y_offset <= col_bottom
            && y_offset - end_y <= 96.0;
        let compact_endnote_question_title_tail_soft_backtrack = self.suppress_large_forward_jump
            && !is_page_path
            && current_is_endnote_title
            && !vpos_rewind
            && follows_tall_inline_item
            && prev_para.text.trim().is_empty()
            && end_y < y_offset - 20.0
            && end_y >= y_offset - 32.0
            && y_offset > self.col_area_y + self.col_area_height * 0.90
            && y_offset <= col_bottom;
        let compact_endnote_question_title_after_tall_tail_backtrack = self
            .suppress_large_forward_jump
            && !is_page_path
            && current_is_endnote_title
            && !vpos_rewind
            && follows_tall_inline_item
            && !prev_para.text.trim().is_empty()
            && end_y < y_offset - 32.0
            && y_offset > self.col_area_y + self.col_area_height * 0.84
            && y_offset <= col_bottom
            && y_offset - end_y <= 120.0;
        let compact_endnote_question_title_after_tall_mid_backtrack = self
            .suppress_large_forward_jump
            && !is_page_path
            && current_is_endnote_title
            && !vpos_rewind
            && follows_tall_inline_item
            && seg.line_height <= 3600
            && (!prev_para.text.trim().is_empty() || para_has_equation_only(prev_para))
            && end_y < y_offset - 32.0
            && y_offset > self.col_area_y + self.col_area_height * 0.50
            && y_offset <= self.col_area_y + self.col_area_height * 0.75
            && y_offset - end_y <= 96.0
            && self.endnote_between_notes_hu <= 2500;
        let compact_endnote_question_title_after_tall_regular_gap = self
            .suppress_large_forward_jump
            && !is_page_path
            && current_is_endnote_title
            && !vpos_rewind
            && follows_tall_inline_item
            && compact_endnote_new_note_jump
            && !prev_para.text.trim().is_empty()
            && !para_is_treat_as_char_equation_only(prev_para)
            && self.endnote_between_notes_hu <= 2500
            && y_offset <= self.col_area_y + self.col_area_height * 0.45;
        let compact_endnote_question_title_after_tall_upper_flow = self.suppress_large_forward_jump
            && current_is_endnote_title
            && !vpos_rewind
            && follows_tall_inline_item
            && !prev_para.text.trim().is_empty()
            && end_y > y_offset + 8.0
            && end_y - y_offset <= 48.0
            && !compact_endnote_new_note_jump
            && y_offset <= self.col_area_y + self.col_area_height * 0.35;
        let compact_endnote_zero_gap_title_forward = self.suppress_large_forward_jump
            && current_is_endnote_title
            && !vpos_rewind
            && self.endnote_between_notes_hu == 0
            && !prev_para.text.trim().is_empty()
            && seg.line_spacing <= 800
            && end_y > y_offset + 18.0
            && end_y <= y_offset + 96.0
            && (!follows_tall_inline_item || !prev_para.text.trim().is_empty())
            && y_offset <= self.col_area_y + self.col_area_height * 0.35;
        let compact_endnote_equation_tail_fit = self.suppress_large_forward_jump
            && !vpos_rewind
            && paragraphs
                .get(item_para)
                .map(para_is_treat_as_char_equation_only)
                .unwrap_or(false)
            && current_line_height_px > 0.0
            && y_offset > self.col_area_y + self.col_area_height * 0.95
            && end_y <= y_offset + 0.5
            && end_y + current_line_height_px > col_bottom + 0.5
            && end_y + equation_tail_prev_overlap_tolerance >= prev_content_bottom_y
            && end_y - current_line_height_px <= y_offset;
        let compact_endnote_title_tail_backtrack = self.suppress_large_forward_jump
            && !is_page_path
            && !vpos_rewind
            && follows_endnote_title
            && paragraphs
                .get(item_para)
                .map(|p| p.line_segs.len() >= 3)
                .unwrap_or(false)
            && end_y < y_offset - 8.0
            && y_offset > self.col_area_y + self.col_area_height * 0.90
            && y_offset - end_y <= 80.0;
        // Compact endnote LINE_SEG sometimes encodes a saved visual gap inside
        // the previous line spacing. In the active mid-column flow it is safe
        // to honor that backward target when it stays below the previous
        // visible content bottom; near the column tail, the configured endnote
        // note-gap must remain authoritative.
        let compact_endnote_safe_vpos_backtrack = self.suppress_large_forward_jump
            && !vpos_rewind
            && !(current_is_endnote_title && self.endnote_between_notes_hu > 3000)
            && end_y < y_offset - 8.0
            && end_y >= prev_content_bottom_y
            && end_y <= self.col_area_y + self.col_area_height
            && y_offset <= self.col_area_y + self.col_area_height * 0.75;
        let stale_forward = self.suppress_large_forward_jump && end_y > y_offset + 100.0;
        let prev_is_initial_empty_reset = prev_pi == 0
            && seg.vertical_pos == 0
            && !prev_has_visible_text
            && prev_para.text.trim().is_empty()
            && y_offset <= self.col_area_y + 48.0;
        let current_vpos_far_from_prev =
            matches!(curr_first_vpos, Some(v) if v - prev_vpos_end > 3200);
        let previous_has_stale_hwpx_line_metrics = self.suppress_hwpx_stale_forward
            && crate::renderer::paragraph_source_line_metrics_need_reflow(
                prev_para, styles, self.dpi,
            );
        let hwpx_page_start_stale_forward = self.suppress_hwpx_stale_forward
            && is_page_path
            && applied
            && !vpos_rewind
            && y_offset <= self.col_area_y + 96.0
            && end_y > y_offset + 48.0
            && ((prev_is_initial_empty_reset
                && current_has_visible_text
                && current_vpos_far_from_prev)
                || (current_is_tac_table_host && end_y > y_offset + 180.0)
                // 손상된 단일 줄의 저장 높이가 이후 문단의 절대 vpos까지 밀어 둔
                // HWPX는 순차 조판 위치를 유지한다. 그렇지 않으면 앞 줄을 재조판해도
                // 다음 문단에서 동일한 빈 공간이 다시 복원된다.
                || (previous_has_stale_hwpx_line_metrics && current_has_visible_text));
        let compact_endnote_large_gap_body_stale_forward = self.suppress_large_forward_jump
            && !is_page_path
            && !vpos_rewind
            && self.endnote_between_notes_hu > 3000
            && current_has_visible_text
            && !current_is_endnote_title
            && end_y > y_offset + 80.0
            && end_y < y_offset + 140.0
            && y_offset > self.col_area_y + self.col_area_height * 0.55
            && y_offset < self.col_area_y + self.col_area_height * 0.80;
        let compact_endnote_page_title_body_stale_forward = self.suppress_large_forward_jump
            && is_page_path
            && !vpos_rewind
            && self.endnote_between_notes_hu > 3000
            && follows_endnote_title
            && !current_is_endnote_title
            && current_has_visible_text
            && end_y > y_offset + 32.0
            && end_y < y_offset + 120.0
            && y_offset <= self.col_area_y + self.col_area_height * 0.25;
        let compact_endnote_page_title_mid_stale_gap = self.suppress_large_forward_jump
            && is_page_path
            && !vpos_rewind
            && stale_forward
            && current_is_endnote_title
            && self.endnote_between_notes_hu > 0
            && self.endnote_between_notes_hu <= 2500
            && seg.line_spacing >= self.endnote_between_notes_hu
            && y_offset > self.col_area_y + self.col_area_height * 0.55
            && y_offset <= self.col_area_y + self.col_area_height * 0.85;
        let compact_endnote_page_title_default_mid_gap = self.suppress_large_forward_jump
            && is_page_path
            && !vpos_rewind
            && current_is_endnote_title
            && self.endnote_between_notes_hu > 0
            && self.endnote_between_notes_hu <= 2500
            && seg.line_spacing > 0
            && seg.line_spacing < self.endnote_between_notes_hu
            && end_y > y_offset + 48.0
            && end_y <= y_offset + 120.0
            && y_offset > self.col_area_y + self.col_area_height * 0.35
            && y_offset <= self.col_area_y + self.col_area_height * 0.55;
        let compact_endnote_large_empty_spacer_collapse = self.suppress_large_forward_jump
            && !is_page_path
            && stale_forward
            && current_is_endnote_title
            && !vpos_rewind
            && self.endnote_between_notes_hu > 3000
            && seg.line_spacing >= self.endnote_between_notes_hu
            && prev_para.line_segs.len() == 1
            && prev_para.text.trim().is_empty()
            && prev_para.controls.is_empty()
            && y_offset > self.col_area_y + self.col_area_height * 0.75;
        let compact_endnote_large_between_title_tail_backtrack = self.suppress_large_forward_jump
            && !is_page_path
            && current_is_endnote_title
            && !vpos_rewind
            && self.endnote_between_notes_hu > 3000
            && seg.line_spacing >= self.endnote_between_notes_hu
            && end_y < y_offset - 8.0
            && y_offset > self.col_area_y + self.col_area_height * 0.80
            && end_y <= col_bottom
            && end_y >= prev_content_floor_y
            && y_offset - end_y <= 36.0;
        let compact_no_separator_large_title_tail_gap = self.suppress_large_forward_jump
            && !is_page_path
            && stale_forward
            && current_is_endnote_title
            && !vpos_rewind
            && self.endnote_between_notes_hu > 3000
            && seg.line_spacing >= self.endnote_between_notes_hu
            && !prev_para.text.trim().is_empty()
            && !follows_tall_inline_item
            && y_offset > self.col_area_y + self.col_area_height * 0.90
            && y_offset <= col_bottom;
        let compact_endnote_zero_gap_text_floor = self.suppress_large_forward_jump
            && is_page_path
            && self.endnote_between_notes_hu == 0
            && !current_is_endnote_title
            && current_has_visible_text
            && current_looks_like_numbered_note
            && !curr_is_equation_only_tail
            && measured_prev_content_bottom_y.is_some()
            && end_y < prev_content_floor_y - 0.25
            && y_offset >= prev_content_floor_y
            && y_offset - end_y <= 24.0;
        // page-path 에서 제목 stale-forward(>100px)를 순차 y로 접은 뒤, 잔여 점프가
        // 100px 바로 아래로 줄어든 단 하단 본문이 저장 vpos 로 다시 스냅하면
        // 뒤 문항 제목이 frame 밖으로 밀린다 (2023-09 p14 pi=748 → 문23 y=1186).
        // 이 잔여 스냅만 순차 y로 유지하고 page_base 를 옮겨 후속 항목도 따라가게 한다.
        let compact_endnote_page_residual_stale_snap = self.suppress_large_forward_jump
            && is_page_path
            && !vpos_rewind
            && !stale_forward
            && applied
            && end_y > y_offset + 80.0
            && end_y <= y_offset + 100.0
            && y_offset > self.col_area_y + self.col_area_height * 0.65
            && y_offset <= col_bottom;
        if compact_endnote_stale_note_gap
            || compact_endnote_title_body_stale_forward
            || compact_endnote_large_gap_body_stale_forward
            || compact_endnote_page_title_body_stale_forward
            || compact_endnote_page_title_mid_stale_gap
            || compact_no_separator_large_title_tail_gap
            || hwpx_page_start_stale_forward
            || (applied && (compact_endnote_new_note_jump || compact_endnote_tac_picture_gap))
            || compact_endnote_page_residual_stale_snap
        {
            // Compact endnote flow encodes visual gaps in absolute vpos.
            // Suppressed gaps must also move the vpos base, otherwise the next
            // line restores the skipped gap.
            let rendered_y = if let Some(y) = title_body_gap_y {
                y
            } else if compact_endnote_page_title_body_stale_forward {
                // 구분선 없는 큰 미주 block의 page-path에서도 문항 제목 뒤
                // 본문 첫 줄 vpos가 미주 사이만큼 stale-forward로 남는 경우가
                // 있다. 제목 자체는 한컴 위치와 맞으므로 본문부터 순차 gap에
                // 붙이고 후속 vpos 기준도 함께 당긴다.
                y_offset + prev_line_spacing_px.max(10.0).min(18.0)
            } else if compact_endnote_page_title_mid_stale_gap {
                // 보이는 구분선 + compact 미주의 page-path 중하단 제목은 저장
                // vpos가 이전 미주 사이를 한 번 더 포함한 채 stale-forward로
                // 남을 수 있다. 제목을 현재 단 순차 위치에서 note gap 한 번만
                // 접고, 뒤따르는 같은 미주 본문도 같은 base를 쓰게 한다.
                y_offset - prev_line_spacing_px
            } else if compact_endnote_large_gap_body_stale_forward {
                y_offset
            } else if compact_no_separator_large_title_tail_gap {
                // 구분선 없는 큰 미주 block의 마지막 단에서 새 문항 제목은
                // 저장된 20mm gap 전체보다 조금 위에 놓인다. 직전 풀이의
                // line spacing이 이미 시각 gap을 만들었으므로 약 1/4만 접고,
                // 뒤따르는 같은 미주 본문도 같은 기준으로 흐르게 한다.
                // 제목 문단은 paragraph layout에서 spacing_before가 다시 더해지므로
                // 커서 기준 y에서는 그만큼 미리 빼야 실제 첫 줄이 목표 gap에 놓인다.
                y_offset - prev_line_spacing_px * 0.25 - curr_sb
            } else if hwpx_page_start_stale_forward {
                y_offset
            } else if compact_endnote_new_note_jump {
                bottom_new_note_gap_cap.unwrap_or(y_offset)
            } else if let Some(y) = stale_note_gap_y {
                y
            } else {
                y_offset
            };
            let base_delta_hu = ((end_y - rendered_y) / self.dpi * 7200.0).round() as i32;
            if base_delta_hu != 0 {
                if is_page_path {
                    self.vpos_page_base = Some(base + base_delta_hu);
                } else {
                    self.vpos_lazy_base = Some(base + base_delta_hu);
                }
            }
        }
        let mut result = if compact_endnote_title_bottom_backtrack {
            // 저장 vpos가 제목 top만 frame 안쪽으로 맞추는 경우가 있어,
            // page-tail이 아닌 제목+첫줄 보존 케이스에서는 작은 하단 여유를 둔다.
            let title_tail_pad = if compact_endnote_page_tail_backtrack {
                0.0
            } else {
                4.0
            };
            (end_y - title_tail_pad)
                .max(prev_content_bottom_y)
                .max(self.col_area_y)
        } else if compact_endnote_question_title_tail_backtrack {
            // 빈 spacer 뒤 새 문항 제목은 저장 line_spacing 전체가 아니라
            // 한컴처럼 하단 tail 1줄만 앞 단에 남긴다.
            (y_offset - (y_offset - end_y).min(50.0))
                .max(self.col_area_y)
                .min(y_offset)
        } else if compact_endnote_question_title_tail_soft_backtrack {
            // 직전 수식 tail 보정으로 hard backtrack 임계값 바로 위에 놓인
            // 제목은 순차 y를 그대로 쓰면 한컴보다 약 1줄 낮아진다.
            // 저장 end_y 전체가 아니라 작은 폭만 당겨 tail과 제목 간격을 맞춘다.
            (y_offset - (y_offset - end_y).min(10.0))
                .max(self.col_area_y)
                .min(y_offset)
        } else if compact_endnote_question_title_after_tall_tail_backtrack {
            // 하단부 큰 수식/inline 뒤 새 문항 제목은 저장 vpos 전체를 따르면
            // 앞 문항과 겹친다. 한컴처럼 제한적으로만 당겨 뒤 풀이 줄이
            // frame 안에 들어갈 공간을 확보한다.
            let strong_tall_tail_backtrack = measured_prev_content_bottom_y.is_some()
                && prev_line_carries_note_gap
                && seg.line_height >= 2000
                && y_offset - end_y > 80.0;
            let backtrack_limit = if strong_tall_tail_backtrack {
                56.0
            } else {
                30.0
            };
            let prev_floor_pad = if strong_tall_tail_backtrack {
                40.0
            } else {
                12.0
            };
            (y_offset - (y_offset - end_y).min(backtrack_limit) - curr_sb)
                .max(prev_content_bottom_y - curr_sb - prev_floor_pad)
                .max(self.col_area_y)
                .min(y_offset)
        } else if compact_endnote_question_title_after_tall_mid_backtrack {
            // 중단 하단의 큰 수식 line 뒤 문항 제목은 저장 vpos가 한컴보다
            // 약 한 줄 아래로 밀린 케이스가 있다. 전체 end_y까지 당기면 앞
            // 풀이와 붙으므로, 수식 바닥 기준을 침범하지 않는 선에서만 제한한다.
            (y_offset - (y_offset - end_y).min(41.0) - curr_sb)
                .max(prev_content_bottom_y - curr_sb + 10.0)
                .max(self.col_area_y)
                .min(y_offset)
        } else if compact_endnote_question_title_after_tall_regular_gap {
            // 기본 7mm compact 미주에서 텍스트가 섞인 큰 수식 line 뒤 문항 제목은
            // 저장된 미주 사이 전체가 아니라 보이는 line bottom 뒤 짧은 gap에 붙는다.
            let target =
                measured_prev_content_bottom_y.unwrap_or(prev_content_bottom_y) + 10.0 - curr_sb;
            if measured_prev_content_bottom_y.is_some() {
                target.max(self.col_area_y)
            } else {
                target.max(self.col_area_y).min(y_offset)
            }
        } else if compact_endnote_question_title_after_tall_upper_flow {
            // 단 상단/중단의 큰 수식 tail 뒤 새 문항 제목은 순차 흐름이 이미
            // PDF/Hancom 위치와 맞는 경우가 있다. 이때 저장 vpos forward를 따르면
            // 같은 단의 뒤 문항까지 누적되어 마지막 풀이 줄이 frame 밖으로 밀린다.
            y_offset
        } else if compact_endnote_zero_gap_title_forward {
            // 구분선 위/미주 사이/구분선 아래가 모두 0에 가까운 미주는 새 문항
            // 제목 앞 저장 vpos gap이 이전 단 재배치 흔적으로 남을 수 있다.
            // 한컴처럼 직전 tail 바로 다음 순차 위치를 따르고, 후속 문항도 같은
            // 기준으로 흐르도록 아래에서 vpos base를 함께 옮긴다.
            y_offset
        } else if compact_endnote_large_empty_spacer_collapse {
            // 큰 미주 사이 문서의 단 하단에서 빈 spacer 문단이 이미 한 줄 높이를
            // 만들었는데, 주입된 line_spacing까지 그대로 소비하면 다음 문항 제목이
            // 한컴/PDF보다 한 note 간격만큼 내려간다. 빈 줄은 유지하고 주입된
            // "미주 사이" trailing만 접어 현재 단의 문항 흐름을 맞춘다.
            (y_offset - prev_line_spacing_px - 4.0)
                .max(self.col_area_y)
                .min(y_offset)
        } else if compact_endnote_large_between_title_tail_backtrack {
            // 보이는 구분선 + 큰 "미주 사이"에서 직전 spacer의 주입 gap과
            // 저장 vpos가 동시에 존재하면 단 하단 제목/본문이 한 줄가량 내려간다.
            // 저장 vpos가 직전 콘텐츠 바닥을 침범하지 않고 frame 안쪽을 가리키는
            // 경우에는 그 위치를 공통 기준으로 삼아 뒤 본문도 함께 끌어올린다.
            end_y.max(prev_content_floor_y).min(y_offset)
        } else if compact_no_separator_large_title_tail_gap {
            (y_offset - prev_line_spacing_px * 0.25 - curr_sb)
                .max(prev_content_floor_y)
                .max(self.col_area_y)
                .min(y_offset)
        } else if compact_endnote_zero_gap_text_floor {
            // 0mm 미주의 일반 텍스트 연속 문단은 저장 vpos가 실제 렌더 하단보다
            // 위를 가리키는 경우가 있다. 제목/수식 tail 특수 보정이 아닌 일반
            // 텍스트에서는 직전 TextLine bbox 하단을 최소 시작점으로 보존한다.
            prev_content_floor_y.max(self.col_area_y).min(y_offset)
        } else if hwpx_page_start_stale_forward {
            y_offset
        } else if compact_endnote_large_gap_body_stale_forward {
            // 큰 미주 사이 문서의 본문 중간 텍스트는 저장 vpos가 이전 제목/수식
            // 그룹의 절대 위치 흔적으로 남아 순차 y보다 한 note 간격 이상 앞으로
            // 튈 수 있다. 이 경우 한컴처럼 순차 흐름을 유지하고 base만 보정한다.
            y_offset
        } else if compact_endnote_page_title_body_stale_forward {
            // page-path에서 새 문항 제목은 이미 올바른 tail 위치에 있고, 바로
            // 뒤 본문만 stale-forward vpos로 내려간 경우다. 본문은 제목 뒤
            // 순차 gap으로 붙이고 base를 옮겨 다음 풀이도 같은 기준을 따른다.
            y_offset + prev_line_spacing_px.max(10.0).min(18.0)
        } else if compact_endnote_page_title_mid_stale_gap {
            // 보이는 구분선 + compact 미주의 중하단 제목은 저장 vpos의
            // stale-forward 간격을 한컴처럼 한 note gap만 접어 배치한다.
            (y_offset - prev_line_spacing_px)
                .max(prev_content_floor_y)
                .max(self.col_area_y)
                .min(y_offset)
        } else if compact_endnote_page_title_default_mid_gap {
            // 직전 줄이 기본 lineSpacing만 들고 있는 page-path 중단 제목은
            // 저장 vpos forward를 그대로 쓰면 `미주 사이`가 과대해진다.
            // 순차 y 뒤에 공식 미주 사이에서 이미 소비된 lineSpacing만 뺀
            // gap을 보존해 한컴/PDF의 중단 제목 위치에 맞춘다.
            let target_gap =
                hwpunit_to_px(self.endnote_between_notes_hu, self.dpi) - prev_line_spacing_px;
            (y_offset + target_gap.max(0.0))
                .max(prev_content_floor_y)
                .max(self.col_area_y)
                .min(end_y)
        } else if compact_endnote_page_tail_backtrack {
            // page-path 하단 tail은 frame 안에 남기기 위해 저장 vpos를 따르되,
            // 이전 텍스트 line의 실제 하단을 깊게 침범하면 문20처럼 본문/수식이
            // 겹친다. 이전 line 하단보다 위로 올라가지 않게 한다.
            end_y.max(prev_content_bottom_y).min(y_offset)
        } else if compact_endnote_text_after_tall_tail_backtrack {
            let mut prev_floor = measured_prev_content_bottom_y
                .map(|y| y + 0.25)
                .unwrap_or(prev_content_bottom_y);
            if para_has_equation_only(prev_para) {
                let inferred_extra =
                    hwpunit_to_px((seg.line_height - seg.line_spacing).max(0), self.dpi).min(1.8);
                let equation_line_floor = prev_content_bottom_y + inferred_extra;
                prev_floor = prev_floor.max(equation_line_floor);
            }
            end_y.max(prev_floor).min(y_offset)
        } else if compact_endnote_question_title_bottom_fit {
            // 큰 미주 사이 문서에서는 새 문항 제목 1줄만 단 하단에 남기고
            // 본문은 다음 단으로 넘기는 저장본이 있다. 이때 stale-forward vpos는
            // 버리되, 순차 y가 frame을 조금 넘으면 제목 visual line-height만큼
            // 하단 안쪽으로 당겨 한컴/PDF처럼 제목 tail을 보존한다. 제목 바로
            // 다음 첫 줄까지 하단 frame에 걸리는 케이스가 있어 여유를 조금 둔다. 반환값은
            // paragraph top이므로 layout에서 다시 더해지는 spacing_before를 뺀다.
            if self.endnote_between_notes_hu == 0
                && para_has_equation_only(prev_para)
                && prev_content_bottom_y > col_bottom - 24.0
            {
                // 0mm 미주에서 작은 equation-only 결과식 바로 뒤 제목은 내부 여유를
                // 더 빼면 결과식과 같은 줄처럼 붙는다. 순차 y를 유지하면 제목의
                // 실제 visual line은 frame 안쪽에서 결과식 뒤에 놓인다.
                y_offset
            } else {
                (col_bottom - current_line_height_px - 11.0 - curr_sb)
                    .max(prev_content_bottom_y - curr_sb - 4.0)
                    .max(self.col_area_y)
                    .min(y_offset)
            }
        } else if compact_endnote_equation_tail_fit {
            let prev_floor = prev_content_bottom_y - equation_tail_prev_overlap_tolerance;
            // 단 하단에는 수식의 실제 높이만 들어가면 된다. 다음 줄 앞에 쓸
            // 후행 간격까지 넣으려 당기면 정상 저장 pitch가 줄어든다.
            (col_bottom - current_line_height_px - 2.0)
                .max(prev_floor)
                .max(self.col_area_y)
                .min(y_offset)
        } else if compact_endnote_page_no_separator_tail_pullup {
            // 렌더용 lineSeg를 위로 당긴 page-path 한 줄 tail은 저장 end_y가
            // 의도한 위치다. 여기서 순차 y_offset을 고르면 127~129 같은 마지막
            // 번호 묶음이 frame 아래로 잘린다.
            end_y.max(self.col_area_y).min(y_offset)
        } else if compact_endnote_single_line_tail_backtrack {
            end_y
        } else if compact_endnote_title_tail_backtrack {
            // 제목 다음 본문을 너무 위로 당기면 제목 bbox와 첫 줄이 겹친다.
            // 저장 vpos backtrack은 존중하되, 직전 제목의 실제 하단 아래에서만
            // 시작하도록 제한한다.
            let capped = y_offset - (y_offset - end_y).min(16.0);
            let floor = measured_prev_content_bottom_y
                .map(|y| y + 2.0)
                .unwrap_or(self.col_area_y);
            capped.max(floor).min(y_offset)
        } else if let Some(y) = title_body_gap_y {
            y
        } else if self.suppress_large_forward_jump && vpos_rewind && end_y < prev_content_floor_y {
            // compact 미주의 vpos rewind가 직전 줄의 실제 콘텐츠 하단을 침범하면
            // 저장 vpos가 같은 단의 재배치 흔적으로 남은 것이다. 이 경우 순차 y를
            // 유지해야 문항 tail 본문이나 TAC 그림이 앞줄 위로 겹치지 않는다.
            y_offset
        } else if (applied || compact_endnote_deep_backtrack || compact_endnote_safe_vpos_backtrack)
            && !stale_forward
            && !compact_endnote_new_note_jump
            && !compact_endnote_tac_picture_gap
            && !compact_endnote_page_residual_stale_snap
        {
            end_y
        } else if compact_endnote_new_note_jump {
            bottom_new_note_gap_cap.unwrap_or(y_offset)
        } else if let Some(y) = stale_note_gap_y {
            y
        } else {
            y_offset
        };
        let title_after_equation_tail_extra_gap = if self.suppress_large_forward_jump
            && !self.own_line_layout
            && current_is_endnote_title
            && !vpos_rewind
            && self.endnote_between_notes_hu > 0
            && self.endnote_between_notes_hu <= 2500
            && y_offset > self.col_area_y + self.col_area_height * 0.55
            && y_offset < col_bottom - 180.0
            && y_offset + current_line_height_px <= col_bottom - 2.0
            && prev_line_carries_note_gap
            && (para_is_treat_as_char_equation_only(prev_para)
                || (prev_para.text.trim().is_empty()
                    && prev_para.controls.iter().any(
                        |ctrl| matches!(ctrl, Control::Equation(eq) if eq.common.treat_as_char),
                    )))
            && result <= y_offset + 0.5
        {
            // 기본 7mm 미주에서 수식 tail 뒤 새 문항 제목은 저장 vpos가
            // 수식 visual bottom보다 살짝 위쪽으로 compact되는 경우가 있다.
            // 이 gap floor가 없으면 문18→문19, 문19→문20처럼 뒤 문항 전체가
            // 위로 당겨져 다음 수식 줄이 이전 본문 검색 영역에 걸린다.
            if follows_tall_inline_item {
                8.0
            } else {
                0.0
            }
        } else {
            0.0
        };
        if title_after_equation_tail_extra_gap > 0.0 {
            result = (result + title_after_equation_tail_extra_gap).min(col_bottom);
            self.shift_vpos_base_for_rendered_delta(title_after_equation_tail_extra_gap);
        }
        if compact_endnote_zero_gap_text_floor && result > end_y + 0.5 {
            self.shift_vpos_base_for_rendered_delta(result - end_y);
        }
        if compact_endnote_text_after_lazy_tall_equation_floor {
            let inferred_extra =
                hwpunit_to_px((seg.line_height - seg.line_spacing).max(0), self.dpi) * 0.4;
            result = result.max(prev_content_bottom_y + inferred_extra + 0.25);
        }
        let compact_endnote_zero_gap_title_boundary_applied = if self.suppress_large_forward_jump
            && !self.own_line_layout
            && current_is_endnote_title
            && self.endnote_between_notes_hu == 0
            && !vpos_rewind
            && seg.line_spacing > 0
            && seg.line_spacing <= 800
            && (result - y_offset).abs() <= 0.5
            && !compact_endnote_zero_gap_title_forward
            && !compact_endnote_title_bottom_backtrack
            && !compact_endnote_question_title_bottom_fit
            && !compact_endnote_question_title_tail_backtrack
            && !compact_endnote_question_title_tail_soft_backtrack
            && !compact_endnote_question_title_after_tall_tail_backtrack
            && !compact_endnote_question_title_after_tall_mid_backtrack
            && !compact_endnote_question_title_after_tall_regular_gap
            && !compact_endnote_question_title_after_tall_upper_flow
        {
            // 0/0/0 미주의 새 문항 경계에서는 저장 vpos가 직전 문단의
            // trailing line_spacing을 포함한 연속값으로 기록될 수 있다. 미주
            // 사이가 0mm이면 한컴은 이 trailing을 다음 문항 제목 앞 공백으로
            // 쓰지 않으므로, 실제 콘텐츠 하단을 침범하지 않는 범위에서 한
            // 줄 gap을 접고 후속 vpos 기준도 함께 이동한다.
            let compacted = (result - prev_line_spacing_px)
                .max(prev_content_floor_y)
                .max(self.col_area_y);
            if compacted < result - 0.5 {
                result = compacted;
                true
            } else {
                false
            }
        } else {
            false
        };
        if (compact_endnote_title_bottom_backtrack
            || compact_endnote_question_title_after_tall_regular_gap
            || compact_endnote_question_title_after_tall_upper_flow
            || compact_endnote_zero_gap_title_forward
            || compact_endnote_zero_gap_title_boundary_applied
            || compact_endnote_page_title_default_mid_gap)
            && result < end_y - 0.5
        {
            let base_delta_hu = ((end_y - result) / self.dpi * 7200.0).round() as i32;
            if base_delta_hu != 0 {
                if is_page_path {
                    self.vpos_page_base = Some(base + base_delta_hu);
                } else {
                    self.vpos_lazy_base = Some(base + base_delta_hu);
                }
            }
        }
        if compact_endnote_question_title_after_tall_mid_backtrack && result > end_y + 0.5 {
            let base_delta_hu = ((end_y - result) / self.dpi * 7200.0).round() as i32;
            if base_delta_hu != 0 {
                if is_page_path {
                    self.vpos_page_base = Some(base + base_delta_hu);
                } else {
                    self.vpos_lazy_base = Some(base + base_delta_hu);
                }
            }
        }
        self.last_compacted_endnote_title_gap = compact_endnote_new_note_jump
            && bottom_new_note_gap_cap
                .map(|cap| end_y - cap > 8.0)
                .unwrap_or(false)
            || compact_no_separator_large_title_tail_gap;
        if std::env::var("RHWP_VPOS_DEBUG").is_ok() {
            let path = if is_page_path { "page" } else { "lazy" };
            eprintln!(
                "VPOS_CORR: path={} pi={} prev_pi={} prev_vpos={} prev_lh={} prev_ls={} vpos_end={} base={} col_y={:.2} y_in={:.2} end_y={:.2} result={:.2} stale_forward={} large_gap_body_stale={} current_title={} title_bottom={} page_tail={} equation_tail={} single_tail={} zero_gap_title={} compact_new_note={} compact_stale_note_gap={} compact_tac_pic_gap={} compact_bottom_rewind={} compact_deep_backtrack={} compact_safe_backtrack={} applied={}",
                path, item_para, prev_pi, seg.vertical_pos, seg.line_height, seg.line_spacing,
                vpos_end, base, self.col_area_y, y_offset, end_y, result, stale_forward,
                compact_endnote_large_gap_body_stale_forward, current_is_endnote_title, compact_endnote_title_bottom_backtrack,
                compact_endnote_page_tail_backtrack, compact_endnote_equation_tail_fit,
                compact_endnote_single_line_tail_backtrack,
                compact_endnote_zero_gap_title_forward,
                compact_endnote_new_note_jump, compact_endnote_stale_note_gap,
                compact_endnote_tac_picture_gap, compact_endnote_bottom_rewind,
                compact_endnote_deep_backtrack, compact_endnote_safe_vpos_backtrack,
                (applied || compact_endnote_deep_backtrack || compact_endnote_safe_vpos_backtrack) && !stale_forward && !compact_endnote_new_note_jump && !compact_endnote_tac_picture_gap,
            );
        }
        let prev_is_multiline = prev_para.line_segs.len() > 1;
        let stored_gap_px = result - y_offset;
        // [Task #1256/#1261] 단일 줄 prev(빈 separator)로 끝나는 미주 제목 경계: y_offset 은
        // typeset 이 주입한 between-notes trailing 을 이미 포함한다. applied/
        // safe_vpos_backtrack 이 그보다 위로 당기는 경우뿐 아니라, page-path vpos 가 소폭
        // 아래로 미는 경우도 y_offset 을 유지해야 한다. 그렇지 않으면 `미주 사이`가 두 번
        // 적용되어 다음 제목들이 아래로 누적 밀린다(미주사이20 p10 문10→문12 overflow).
        // 기준을 y_offset 으로 유지하고, 차이만큼 활성 vpos base 를 이동해 후속 미주 항목이
        // 동일 기준을 따르게 한다. 다줄 prev(문22)는 y_offset 이 between-notes 를 못 가지는
        // 별개 경로라 아래 #1246 rescue(+prev_ls)가 담당.
        let injected_between_notes =
            self.endnote_between_notes_hu > 0 && seg.line_spacing >= self.endnote_between_notes_hu;
        if injected_between_notes
            && compact_endnote_question_title
            && !compact_endnote_question_title_tail_backtrack
            && !compact_endnote_question_title_tail_soft_backtrack
            && !compact_endnote_question_title_after_tall_tail_backtrack
            && !compact_endnote_question_title_after_tall_mid_backtrack
            && !compact_endnote_question_title_after_tall_regular_gap
            && !compact_endnote_title_bottom_backtrack
            && !compact_endnote_large_empty_spacer_collapse
            && !compact_endnote_large_between_title_tail_backtrack
            && !compact_no_separator_large_title_tail_gap
            && !vpos_rewind
            && !prev_is_multiline
            && (stored_gap_px < -0.5
                || (stored_gap_px > 0.5
                    && (self.endnote_between_notes_hu > 3000
                        || (self.suppress_hwpx_stale_forward
                            && measured_prev_content_bottom_y.is_some_and(|bottom| {
                                y_offset - bottom >= prev_line_spacing_px - 0.5
                            })))))
        {
            // 제목 clamp가 중간 결과를 이미 줄였어도 원래 저장 좌표 전체를
            // 현재 위치로 옮겨야 다음 본문이 남은 차이만큼 다시 내려가지 않는다.
            let anchor_y = if self.suppress_hwpx_stale_forward {
                end_y
            } else {
                result
            };
            let delta_hu = ((anchor_y - y_offset) / self.dpi * 7200.0).round() as i32;
            if delta_hu != 0 {
                if is_page_path {
                    self.vpos_page_base = Some(base + delta_hu);
                } else {
                    self.vpos_lazy_base = Some(base + delta_hu);
                }
            }
            return y_offset;
        }
        // [Task #1246] 미주 사이 min-gap: 새 미주 제목이 forward 흐름인데 between-notes 간격을
        // 확보하지 못하면(다줄 풀이로 끝나는 미주 → 직전 다줄 문단 마지막 줄 trailing 이 render
        // 에서 누락 → gap≈0, 문22) 직전 줄간격(주입된 between_notes)만큼 끌어올린다.
        // - 다줄 prev 한정: 단일줄 prev 는 위 #1256 분기가 y_offset(주입 7mm 포함) 유지로 처리.
        // - 이미 충분한 간격(result >= y_offset + prev_ls, 3-09월 문15 등)은 무변경(max 의미).
        // - backtrack/rewind 류(result < y_offset)는 위 분기가 의도 선택한 값이므로 제외.
        // #1238 render-클램프가 침범하던 #1209 safe-vpos-backtrack 과 양립(여기선 forward 만).
        // 핵심: stored vpos 가 gap 을 거의 안 주는 경우(≈0)만 보정한다. 다줄 풀이로 끝나는 미주의
        // 마지막 줄 trailing 이 render 에서 누락되어 gap≈0 이 된 케이스(문22)가 대상.
        // stored vpos 가 의도적으로 작은 gap(예: 문13 ~12px)을 인코딩한 경우는 존중(over-lift 방지).
        if self.endnote_between_notes_hu > 0
            && compact_endnote_question_title
            && !vpos_rewind
            && prev_is_multiline
            && (-0.5..4.0).contains(&stored_gap_px)
        {
            if self.suppress_hwpx_stale_forward {
                if let Some(bottom) = measured_prev_content_bottom_y {
                    if y_offset - bottom >= prev_line_spacing_px - 0.5 {
                        return result;
                    }
                }
            }
            return y_offset + prev_line_spacing_px;
        }
        // [Task #1811 v2] 합성 seg 증거의 **소폭(drift형) 전방 이동**만 차단한다.
        // - 되감기(result < y_offset): 허용 — sequential 이 앞서 나갔을 때의 재동기화.
        // - 대형 전방 점프(> SYNTH_FORWARD_REANCHOR_MIN_PX): 허용 — 저장 vpos 로의
        //   구조적 재앵커. 파스 경로별 미세 측정차(예: seoul_1006 pi=41 표 +9.6px)가
        //   누적되어도 양 경로가 같은 저장 좌표에 재앵커되어 쪽나눔 결정이 수렴한다.
        //   전면 차단하면 누적차가 쪽 경계에서 발현해 라운드트립 pagination 이 갈린다.
        // - 소폭 전방(≤ 임계): 차단 — 구세션 저장 flow 위치로의 과대 전진(+9.6px,
        //   saved_bounds_cumulative_page_break p4 분할 예산 결손)이 이 대역이다.
        const SYNTH_FORWARD_REANCHOR_MIN_PX: f64 = 48.0;
        if synthetic_prev_seg
            && result > y_offset + 0.5
            && result - y_offset <= SYNTH_FORWARD_REANCHOR_MIN_PX
        {
            if std::env::var("RHWP_VPOS_DEBUG").is_ok() {
                eprintln!(
                    "VPOS_SYNTH_FWD_SKIP: pi={} prev_pi={} y_in={:.2} result={:.2}",
                    item_para, prev_pi, y_offset, result,
                );
            }
            return y_offset;
        }
        // [편집 세션] 전방 점프 목적지가 쪽 말미(하단 15%)면 낡은 저장 좌표다 —
        // fresh 흐름을 유지한다. 같은 쪽 소폭 재동기화(상단·중단)는 종전대로.
        if self.session_edited
            && result > y_offset
            && result > self.col_area_y + self.col_area_height * 0.85
        {
            return y_offset;
        }
        result
    }

    /// 이미 계산된 vpos 기준 y에서 실제 렌더 y를 이동했을 때, 후속 항목도
    /// 같은 시각 기준을 따르도록 활성 vpos base를 반대로 이동한다.
    pub(crate) fn shift_vpos_base_for_rendered_delta(&mut self, delta_px: f64) {
        if !delta_px.is_finite() || delta_px == 0.0 {
            return;
        }
        let delta_hu = (delta_px / self.dpi * 7200.0).round() as i32;
        if delta_hu == 0 {
            return;
        }
        if let Some(base) = self.vpos_page_base {
            self.vpos_page_base = Some(base.saturating_sub(delta_hu));
        } else if let Some(base) = self.vpos_lazy_base {
            self.vpos_lazy_base = Some(base.saturating_sub(delta_hu));
        }
    }
}


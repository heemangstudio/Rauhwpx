//! 실문서 쪽수·쪽 배치 핀. 기대값은 한글 2020/2022(맥·윈도) 정답지와 COM 실측에서 왔다.
//!
//! 표 한 줄이 테스트 하나다: `이름: "샘플", pages 기대 쪽수[, on [(쪽, 문자열)]][, off [...]];`
//! `on`/`off` 는 `dump_page_items(쪽)` 출력(0-based 쪽)에 그 문자열이 있어야/없어야 함을 뜻한다.
//! 기대값은 한글 기준이므로 렌더러를 고쳐도 숫자를 바꾸지 않는다. 바뀌면 회귀다.

use std::ops::{RangeFull, RangeInclusive, RangeToInclusive};
use std::path::Path;

use rhwp::document_core::DocumentCore;

trait Pages: std::fmt::Debug {
    fn accepts(&self, pages: u32) -> bool;
}

impl Pages for u32 {
    fn accepts(&self, pages: u32) -> bool {
        pages == *self
    }
}

impl Pages for RangeInclusive<u32> {
    fn accepts(&self, pages: u32) -> bool {
        self.contains(&pages)
    }
}

impl Pages for RangeToInclusive<u32> {
    fn accepts(&self, pages: u32) -> bool {
        self.contains(&pages)
    }
}

impl Pages for RangeFull {
    fn accepts(&self, _: u32) -> bool {
        true
    }
}

fn check(sample: &str, expected: impl Pages, on: &[(u32, &str)], off: &[(u32, &str)]) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(sample);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {sample}: {e}"));
    let core = DocumentCore::from_bytes(&bytes).unwrap_or_else(|e| panic!("parse {sample}: {e:?}"));
    let pages = core.page_count();
    assert!(
        expected.accepts(pages),
        "{sample}: 쪽수 {pages}, 한글 기준 {expected:?}"
    );
    for (page, needle) in on {
        let items = core.dump_page_items(Some(*page));
        assert!(
            items.contains(needle),
            "{sample}: {}쪽에 `{needle}` 이 있어야 한다\n{items}",
            page + 1
        );
    }
    for (page, needle) in off {
        let items = core.dump_page_items(Some(*page));
        assert!(
            !items.contains(needle),
            "{sample}: {}쪽에 `{needle}` 이 없어야 한다\n{items}",
            page + 1
        );
    }
}

macro_rules! pins {
    ($($name:ident: $sample:literal, pages $pages:expr
        $(, on [$(($on_page:literal, $on:literal)),* $(,)?])?
        $(, off [$(($off_page:literal, $off:literal)),* $(,)?])?;)*) => {
        $(
            #[test]
            fn $name() {
                check(
                    $sample,
                    $pages,
                    &[$($(($on_page, $on)),*)?],
                    &[$($(($off_page, $off)),*)?],
                );
            }
        )*
    };
}

pins! {
    // #359/#391 다단 시험지.
    exam_eng_multicolumn: "samples/exam_eng.hwp", pages 8;
    // #546: PR #506 회귀 시 6쪽.
    issue_546_exam_science: "samples/exam_science.hwp", pages 4;

    // #554 HWP3 원본과 HWP5/HWPX 변환본, 무회귀 실문서.
    issue_554_hwp3_sample4_hwp5: "samples/hwp3-sample4-hwp5.hwp", pages 36;
    issue_554_hwp3_sample5_hwp5: "samples/hwp3-sample5-hwp5.hwp", pages 64;
    issue_554_hwp3_sample5_hwpx: "samples/hwp3-sample5-hwpx.hwpx", pages 64;
    issue_554_hwp3_sample5_hwp3: "samples/hwp3-sample5.hwp", pages 64;
    issue_554_hwp3_sample_hwp5: "samples/hwp3-sample-hwp5.hwp", pages 16;
    issue_554_hwp3_sample_hwpx: "samples/hwp3-sample-hwpx.hwpx", pages 16;
    issue_554_hwp3_sample_hwp3: "samples/hwp3-sample.hwp", pages 16;
    issue_554_kuglip_2022: "samples/2022년 국립국어원 업무계획.hwp", pages 35;
    issue_554_exam_kor: "samples/exam_kor.hwp", pages 20;
    issue_554_aift: "samples/aift.hwp", pages 74;
    issue_554_donations_2025_hwpx: "samples/2025년 기부·답례품 실적 지자체 보고서_양식.hwpx", pages 30;

    // #676 꼬리 빈 문단 가드(회귀 시 2쪽), #703 BehindText 표 높이 가산.
    issue_676_tonghap_2010_11: "samples/통합재정통계(2010.11월).hwp", pages 1;
    issue_676_tonghap_2011_10: "samples/통합재정통계(2011.10월).hwp", pages 1;
    issue_676_tonghap_2014_08: "samples/통합재정통계(2014.8월).hwp", pages 1;
    issue_703_calendar_year: "samples/basic/calendar_year.hwp", pages 1;

    // #1417 TAC 그림 묶음과 공백 전용 표 호스트.
    issue_1417_tac_image_group_stays_on_page_2: "samples/hwpx/pagenation-001.hwpx", pages ..,
        on [(1, "Table          pi=26"), (1, "Shape          pi=27")],
        off [(1, "PartialParagraph  pi=16")];
    // #1611 발신명의 꼬리말(Page+Bottom) page-fit, #1624 꼬리말 과밀림.
    issue_1611_footer_page_bottom: "samples/hwpx/opengov/36387725_footer_page_bottom.hwpx", pages 2;
    issue_1624_footer_overpush: "samples/hwpx/opengov/36395270_footer_overpush.hwpx", pages 2;
    // #1749 누적좌표 꼬리 공백 문단, #1750 sb 포함 분할 가드.
    issue_1749_pi18_starts_on_page_2: "samples/task1749/saved_bounds_cumulative_vpos.hwpx", pages ..,
        on [(1, "pi=18")], off [(0, "pi=18")];
    issue_1750_pi22_starts_on_page_2: "samples/task1750/split_guard_spacing_before.hwp", pages ..,
        on [(1, "pi=22")], off [(0, "pi=22")];
    // #1858 용지 기준 co-anchored 자리차지 상자(수정 전 4쪽).
    issue_1858_paper_anchor_float_stack: "samples/issue1858_paper_anchor_float_stack.hwpx", pages 1;
    issue_1880_anchor_stack_hwpx: "samples/issue1880_anchor_stack_sb_convert.hwpx", pages 13;
    // #1937 각주 RowBreak 표 과분할(수정 전 231, 한글 50).
    issue_1937_rowbreak_footnote: "samples/issue1937_rowbreak_footnote_overpagination.hwp", pages 45..=80;
    // #2019 부동 폼 과분할 부분 완화(수정 전 81, 한글 18).
    issue_2019_floating_form: "samples/hwpx/issue2019_floating_form_74312.hwpx", pages ..=20;

    // #2093 쪽 하단 단일 줄 sa 과분할.
    issue_2093_hydrogen_1192000: "samples/task2093/1192000_hydrogen_policy_research.hwp", pages 16;
    issue_2093_sa_tail_line_stays_on_page_1: "samples/task2093/saved_single_line_spacing_after.hwpx", pages 1,
        on [(0, "pi=0"), (0, "pi=1"), (0, "pi=2")];

    // #2097 선언 높이 fit, 마지막 행 sliver 분할, 하단 squeeze, 블록 밴드 채움.
    issue_2097_selection_report_1730000: "samples/task2097/1730000_selection_report.hwp", pages 1;
    issue_2097_pii_ledger_3080901: "samples/task2097/3080901_pii_ledger.hwp", pages 1;
    issue_2097_none_table_declared_fits: "samples/task2097/none_table_declared_fits.hwpx", pages 2,
        on [(0, "Table")], off [(0, "PartialTable"), (1, "PartialTable")];
    issue_2097_rowbreak_midpage_declared_fits: "samples/task2097/rowbreak_midpage_declared_fits.hwpx", pages 2,
        on [(0, "Table")], off [(0, "PartialTable"), (1, "PartialTable")];
    issue_2097_squeeze_1741000: "samples/task2097/1741000_project_application.hwp", pages 2;
    issue_2097_squeeze_21298295: "samples/task2097/21298295_byeolpyo5_disaster.hwp", pages 2;
    issue_2097_squeeze_21761835: "samples/task2146/21761835_jeonjik_exemption_table.hwp", pages 6;
    issue_2097_band_fill_3248363: "samples/task2097/3248363_upmu_bunjang.hwpx", pages 4;
    issue_2097_band_fill_21217935: "samples/task2097/21217935_simsa_jipyo.hwp", pages 8;
    issue_2097_band_fill_18095317: "samples/task2097/18095317_eogu_geumji.hwp", pages 21;
    issue_2097_band_fill_75544: "samples/task2097/75544_pii_bunseok.hwpx", pages 66;
    issue_2097_band_fill_3023771: "samples/task2097/3023771_wichokjang.hwpx", pages 2;
    issue_2097_band_fill_17809123: "samples/task2097/17809123_jawonbongsa.hwpx", pages 1;

    // #2098 쪽-하단 고정 틀 앵커, #2105 RowBreak 표 선언 높이, #2136 저장 리셋.
    issue_2098_margin_boundary_footer_splits: "samples/task2098/page_bottom_fixed_anchor_margin_split.hwpx", pages 2,
        on [(1, "Table")];
    issue_2098_page_bottom_fixed_anchor_vpos0: "samples/task2098/page_bottom_fixed_anchor_vpos0.hwpx", pages 1,
        on [(0, "Table")];
    issue_2105_rowbreak_table_declared_fits: "samples/task2105/rowbreak_table_declared_fits.hwpx", pages 2,
        on [(0, "Table")], off [(0, "PartialTable"), (1, "PartialTable")];
    issue_2136_sb2500_reset_starts_new_page: "samples/task2136/neartop_reset_sb2500.hwpx", pages 2,
        on [(1, "pi=1")];
    // #2137 저장 page-last 증거가 있는 소형 float/tac 개체.
    issue_2137_small_float_anchor: "samples/task2137/156618554_petfood_press.hwp", pages 1,
        on [(0, "pi=13")];
    issue_2137_small_tac_topbottom_shape: "samples/task2137/156637323_unification_lecture.hwpx", pages 1;

    // #2151 HWP3 그림 pgy=0 거짓 쪽 경계, #2158 저장 vpos 리셋 보존.
    issue_2151_hwp3_sample14: "samples/hwp3-sample14.hwp", pages 11;
    issue_2151_hwp3_sample11: "samples/hwp3-sample11.hwp", pages 151;
    issue_2158_hwp3_sample16_hwpx: "samples/hwp3-sample16-hwp5.hwpx", pages 64;
    issue_2158_hwp3_sample16_hwp5: "samples/hwp3-sample16-hwp5.hwp", pages 64;
    issue_2158_onsaemiro_hwpx: "samples/[2027] 온새미로 1 본교재.hwpx", pages 47;

    // #2243 결재란 sliver 쪽.
    issue_2243_gyeoljae_consulting: "samples/task2243/36395325_gyeoljae_consulting.hwpx", pages 5;
    issue_2243_gyeoljae_pm_traffic: "samples/task2243/36382819_gyeoljae_pm_traffic.hwpx", pages 3;
    issue_2243_gyeoljae_sewoon: "samples/task2243/36386907_gyeoljae_sewoon.hwpx", pages 5;
    issue_2243_taxi_press: "samples/task2243/156631374_taxi_press.hwpx", pages 1;

    // #2311 붙임 포스터(수정 전 5쪽), #2319 tac 표 높이 붕괴(수정 전 1쪽), #2322 전면 tac 쌍.
    issue_2311_poster_doc: "samples/task2311/156744475_nano_plan_poster.hwpx", pages 3;
    issue_2319_form_doc: "samples/task2319/20544835_jinan_apt_form.hwp", pages 2;
    issue_2322_fullpage_tac_pair: "samples/task2322/20862337_cheongyang_voucher_form.hwp", pages 2;
    // #2373 모순 TAC host 과대 가산(5쪽이면 회귀).
    issue_2373_kftc_press: "samples/issue2373/156689818_kftc_press.hwpx", pages 4;
    // #2430 셀 재래핑 임계(회귀 시 40쪽).
    issue_2430_cell_rewrap_threshold: "samples/task2430/1382000_domestic_violence_survey.hwp", pages 39;
    issue_2470_stale_lh_table_36382471: "samples/issue2470/36382471_masked.hwpx", pages 2;
    issue_2470_masked_rewrap_36341511: "samples/issue2470/36341511_masked.hwpx", pages 8;
    // #2559 빈 꼬리말 밴드 회수(98쪽 부근이면 회귀), 94쪽 부근이면 #2430 회귀.
    issue_2559_footnote_footer_band: "samples/issue2559/1341000_research_report_footnotes.hwp", pages 92;
}

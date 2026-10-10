//! `samples/chart/` 차트 말뭉치(hwp, hwpx) 1쪽 SVG 렌더 회귀 가드 (#1431 Track C).
//! 기대값은 한컴 2022 정답지(`pdf/chart/`) 실측이다.

use std::fs;
use std::path::Path;

fn render_page0_svg(rel: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {}: {}", rel, e));
    let mut doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes)
        .unwrap_or_else(|e| panic!("parse {}: {:?}", rel, e));
    doc.render_page_svg(0)
        .unwrap_or_else(|e| panic!("render {}: {:?}", rel, e))
}

fn for_both_exts(stem: &str, f: impl Fn(&str, &str)) {
    for ext in ["hwpx", "hwp"] {
        let rel = format!("samples/chart/{stem}.{ext}");
        f(&rel, &render_page0_svg(&rel));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #1453 (C1a, #1431 Track C): 3D막대·3D원형·ofPie 차트 라우팅 회귀 가드.
//
// 파서가 이미 series·값·cats를 추출하던 7종(3D막대 4 + 3D원형 1 + ofPie 2)이
// 요소명 미인식으로 `chart_type=Unknown`이 되어 "차트 (미지원)" placeholder로
// 렌더되던 문제(`renderer.rs` fallback)를, `handle_start`에 `bar3DChart`/`pie3DChart`/
// `ofPieChart` 라우팅을 추가해 기존 막대/원형 렌더러로 그리도록 한 회귀 가드.
//
// 검증: 7종 × (hwp, hwpx) = 14파일 각각 page 0 SVG가
//   - "차트 (미지원)" placeholder **미포함**
//   - 정상 차트 클래스 `hwp-ooxml-chart"` **포함** (fallback `hwp-ooxml-chart-fallback` 아님)

/// 7종 차트 (samples/chart 하위 상대경로, 확장자 제외)
const CHART_STEMS: &[&str] = &[
    "세로막대형/3차원묶은세로막대형", // bar3DChart, barDir=col → Column
    "세로막대형/3차원누적세로막대형", // bar3DChart, barDir=col → Column
    "가로막대형/3차원묶은가로막대형", // bar3DChart, barDir=bar → Bar
    "가로막대형/3차원누적가로막대형", // bar3DChart, barDir=bar → Bar
    "원형/3차원원형",                 // pie3DChart → Pie
    "원형/원형대원형",                // ofPieChart (ofPieType=pie) → Pie
    "원형/원형대가로막대형",          // ofPieChart (ofPieType=bar) → Pie
];

#[test]
fn chart_3d_ofpie_routed_no_unsupported_placeholder() {
    for stem in CHART_STEMS {
        for ext in ["hwpx", "hwp"] {
            let rel = format!("samples/chart/{stem}.{ext}");
            let svg = render_page0_svg(&rel);

            assert!(
                !svg.contains("차트 (미지원)"),
                "{rel}: '차트 (미지원)' placeholder가 남아있음 (라우팅 누락)",
            );
            assert!(
                svg.contains("hwp-ooxml-chart\""),
                "{rel}: 정상 차트(hwp-ooxml-chart) 미렌더",
            );
            assert!(
                !svg.contains("hwp-ooxml-chart-fallback"),
                "{rel}: fallback 차트가 렌더됨",
            );
        }
    }
}

/// Part B (#1453): 막대 누적(stacked/percentStacked) 6종 — C1a 3D 누적(2) + 기존 2D 누적/백프로(4).
/// percent 여부 = `c:grouping=percentStacked` 샘플.
const STACKED_BAR_STEMS: &[(&str, bool)] = &[
    ("세로막대형/3차원누적세로막대형", false),
    ("가로막대형/3차원누적가로막대형", false),
    ("세로막대형/누적세로막대형", false),
    ("가로막대형/누적가로막대형", false),
    ("세로막대형/백프로기준누적세로막대형", true),
    ("가로막대형/백프로기준누적가로막대형", true),
];

#[test]
fn chart_stacked_bars_render_with_percent_axis() {
    for (stem, is_percent) in STACKED_BAR_STEMS {
        let rel = format!("samples/chart/{stem}.hwpx");
        let svg = render_page0_svg(&rel);

        assert!(
            !svg.contains("차트 (미지원)") && svg.contains("hwp-ooxml-chart\""),
            "{rel}: 누적 막대 정상 렌더 실패",
        );
        // 백분율 누적은 % 축 라벨(0%/100%)을 가진다. 일반 누적은 가지지 않는다.
        if *is_percent {
            assert!(
                svg.contains("100%"),
                "{rel}: percentStacked인데 % 축(100%) 라벨 없음",
            );
        } else {
            assert!(
                !svg.contains("100%"),
                "{rel}: 일반 stacked인데 % 축이 잘못 적용됨",
            );
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #1882 (C1c, #1431 Track C): 차트 스타일 4갭 보정 회귀 가드.
//
// 한컴 2022 정답지(`pdf/chart/`) 실측 기준 4갭:
//   ① 자동 제목 "차트 제목" (c:title 요소 존재 + autoTitleDeleted=0 + 텍스트 없음)
//   ② 팔레트 파랑(#6183D7)→주황(#FE813B)→회색(#B0B0B0)→노랑(#FCD801) — 실측값
//   ③ 범례 우측 세로 스택 (`c:legendPos val="r"` — 코퍼스 전 샘플)
//   ④ Y축 headroom + step 기반 눈금 (막대 max 5.0 → 축 0~6 라벨 0,2,4,6)
//
// 대표 샘플 × (hwp, hwpx)의 page 0 SVG substring으로 검증.

#[test]
fn chart_auto_title_rendered() {
    // ① 다계열: 제목 텍스트가 없으면 한컴처럼 "차트 제목"을 렌더 (regular weight).
    for stem in ["세로막대형/묶은세로막대형", "라인/꺽은선형"] {
        for_both_exts(stem, |rel, svg| {
            assert!(svg.contains("차트 제목"), "{rel}: 자동 제목 미렌더");
            assert!(
                !svg.contains("font-weight=\"600\""),
                "{rel}: 제목이 bold(600) — 한컴은 regular",
            );
        });
    }
    // ① v2: 단일 시리즈는 자동 제목 = 시리즈 이름 (한컴 실측 — 원형 5종 "판매",
    //    단일 시리즈 가로막대 "계열 1"; 차트 종류 불문 시리즈 수 기준).
    for (stem, name) in [
        ("원형/2차원원형", "판매"),
        ("원형/원형대원형", "판매"),
        (
            "특이케이스/가로막대형_하나만있을떄_단일시리즈제목",
            "계열 1",
        ),
    ] {
        for_both_exts(stem, |rel, svg| {
            assert!(
                svg.contains(&format!(">{name}<")),
                "{rel}: 단일 시리즈 이름({name}) 제목 미렌더"
            );
            assert!(
                !svg.contains("차트 제목"),
                "{rel}: 단일 시리즈인데 placeholder 렌더"
            );
        });
    }
}

#[test]
fn chart_hancom_palette_applied() {
    // ② 3시리즈 막대 → 파랑/주황/회색 (구 녹색-우선 #70ad47 미사용).
    for_both_exts("세로막대형/묶은세로막대형", |rel, svg| {
        for color in ["#6183d7", "#fe813b", "#b0b0b0"] {
            assert!(svg.contains(color), "{rel}: 실측 팔레트 {color} 미사용");
        }
        assert!(
            !svg.contains("#70ad47"),
            "{rel}: 구 녹색-우선 팔레트가 여전히 사용됨",
        );
    });
}

#[test]
fn chart_axis_headroom_and_sparse_ticks() {
    // ④ 막대 데이터 max 5.0(step 경계) → 축 0~6, step 재계산 → 라벨 0,2,4,6.
    for_both_exts("세로막대형/묶은세로막대형", |rel, svg| {
        for want in [">0<", ">2<", ">4<", ">6<"] {
            assert!(
                svg.contains(want),
                "{rel}: 축 라벨 {want} 없음 (0~6 step 2)"
            );
        }
        for absent in [">3<", ">5<"] {
            assert!(
                !svg.contains(absent),
                "{rel}: 축 라벨 {absent} 존재 (성긴 라벨이어야)",
            );
        }
    });
    // ④ scatter Y max 4.0 → 0~5 (headroom), X max 2.6 → 0~3 step 0.5 유지.
    for_both_exts("분산형/표식만있는분산형", |rel, svg| {
        for want in [">5<", ">0.5<", ">2.5<", ">3<"] {
            assert!(svg.contains(want), "{rel}: 축 라벨 {want} 없음");
        }
    });
    // ④ 방향별 눈금 밀도 (한컴 실측): 같은 합(12.3)인데
    //    누적'세로' → 0~15 step 5 / 누적'가로' → 0~14 step 2.
    for_both_exts("세로막대형/누적세로막대형", |rel, svg| {
        for want in [">10<", ">15<"] {
            assert!(
                svg.contains(want),
                "{rel}: 세로 누적 라벨 {want} 없음 (0~15 step 5)"
            );
        }
        assert!(
            !svg.contains(">14<"),
            "{rel}: 세로 누적에 14 라벨 (step 2 회귀)"
        );
    });
    for_both_exts("가로막대형/누적가로막대형", |rel, svg| {
        assert!(
            svg.contains(">14<"),
            "{rel}: 가로 누적 라벨 14 없음 (0~14 step 2)"
        );
        assert!(!svg.contains(">15<"), "{rel}: 가로 누적에 15 라벨");
    });
    // ④ 3D 축 정책 (한컴 실측): 묶은 3D는 세로·가로 모두 0~5(무헤드룸),
    //    누적 3D 세로는 0~20(2D 15 + 1 step), 누적 3D 가로는 2D와 동일 0~14.
    for stem in [
        "세로막대형/3차원묶은세로막대형",
        "가로막대형/3차원묶은가로막대형",
    ] {
        for_both_exts(stem, |rel, svg| {
            assert!(svg.contains(">5<"), "{rel}: 3D 묶은 라벨 5 없음 (0~5)");
            assert!(!svg.contains(">6<"), "{rel}: 3D 묶은에 headroom(6) 적용됨");
        });
    }
    for_both_exts(
        "세로막대형/3차원누적세로막대형",
        |rel, svg| {
            assert!(
                svg.contains(">20<"),
                "{rel}: 3D 누적세로 라벨 20 없음 (0~20)"
            );
        },
    );
    for_both_exts(
        "가로막대형/3차원누적가로막대형",
        |rel, svg| {
            assert!(
                svg.contains(">14<"),
                "{rel}: 3D 누적가로 라벨 14 없음 (0~14)"
            );
            assert!(
                !svg.contains(">20<"),
                "{rel}: 3D 누적가로에 세로용 과헤드룸 적용됨"
            );
        },
    );
}

#[test]
fn chart_legend_on_right() {
    // ③ legendPos=r → 범례 그룹이 존재하고, 범례 텍스트 x가 모든 데이터 막대의
    //    우측 끝보다 오른쪽 (하단 가로 배치였다면 x가 플롯 좌측부터 시작).
    for_both_exts("세로막대형/묶은세로막대형", |rel, svg| {
        // 페이지 SVG에는 페이지 배경 등 차트 밖 rect도 있으므로 차트 그룹 내부로 한정.
        let chart_start = svg
            .find("class=\"hwp-ooxml-chart\"")
            .unwrap_or_else(|| panic!("{rel}: 차트 그룹 없음"));
        let chart = &svg[chart_start..];
        let legend_start = chart
            .find("class=\"hwp-chart-legend\"")
            .unwrap_or_else(|| panic!("{rel}: hwp-chart-legend 그룹 없음"));
        let (plot, legend) = chart.split_at(legend_start);
        let legend = &legend[..legend.find("</g>").unwrap_or(legend.len())];

        let legend_text_x = first_attr_f64(legend, "<text ", "x=\"")
            .unwrap_or_else(|| panic!("{rel}: 범례 텍스트 없음"));
        let max_bar_right = plot
            .split("<rect ")
            .skip(1)
            .filter(|c| {
                let tag = &c[..c.find('>').unwrap_or(c.len())];
                // 데이터 막대: fill=#... + stroke 없음 + 범례 스와치(10×10) 제외
                !tag.contains("stroke")
                    && tag.contains("fill=\"#")
                    && !tag.contains("width=\"10\" height=\"10\"")
            })
            .filter_map(|c| {
                let tag = &c[..c.find('>').unwrap_or(c.len())];
                Some(attr_f64(tag, "x=\"")? + attr_f64(tag, "width=\"")?)
            })
            .fold(f64::NEG_INFINITY, f64::max);
        assert!(
            legend_text_x > max_bar_right,
            "{rel}: 범례 텍스트 x={legend_text_x}가 막대 우측 끝 {max_bar_right}보다 왼쪽 (우측 배치 아님)",
        );
    });
}

fn attr_f64(tag: &str, pat: &str) -> Option<f64> {
    let s = tag.find(pat)? + pat.len();
    let e = s + tag[s..].find('"')?;
    tag[s..e].parse().ok()
}

fn first_attr_f64(fragment: &str, elem: &str, pat: &str) -> Option<f64> {
    let chunk = fragment.split(elem).nth(1)?;
    attr_f64(&chunk[..chunk.find('>').unwrap_or(chunk.len())], pat)
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #2277 (C2a stage5, #1431 Track C): 특이케이스 1카테고리 미니차트 축 회귀 가드.
//
// 정답지(`pdf/chart/특이케이스/가로막대형_하나만있을떄_단일시리즈제목-2022.pdf`) 실측:
// 값 4.3의 가로막대 1카테고리 미니차트는 가로 값축이 **0~5 step 0.5**(라벨 11개) —
// 기존 가로축 앵커(12.3→step2 / 5.0→step1 / 2.6→step0.5)와 단일 규칙이 성립하지
// 않아 C1c v2에서 기록만 했던 특수 동작. `가로 && 1카테고리 && 비누적·비3D`로
// 좁게 게이트해 step 절반 적용 (코퍼스 나머지 27종은 전부 4카테고리 — 회귀 반경 0).

const STEM: &str = "특이케이스/가로막대형_하나만있을떄_단일시리즈제목";

#[test]
fn mini_chart_horizontal_axis_uses_half_step() {
    for ext in ["hwpx", "hwp"] {
        let rel = format!("samples/chart/{STEM}.{ext}");
        let svg = render_page0_svg(&rel);
        for want in [">0.5<", ">4.5<", ">5<"] {
            assert!(
                svg.contains(want),
                "{rel}: 미니차트 0.5 step 축 라벨 {want} 없음 (정답지 0~5 step 0.5)",
            );
        }
        // 기존 가드 유지 확인: 자동 제목 = 시리즈 이름 (issue_1882 v2와 중복 핀)
        assert!(svg.contains(">계열 1<"), "{rel}: 단일 시리즈 제목 유지");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #2278 (C2b, #1431 Track C): 3D 입체·ofPie 보조플롯 렌더 회귀 가드.
//
// Stage 1 — 3D 막대 압출: bar3DChart 4종(묶은/누적 × 세로/가로)이 top/side
// 압출 면(`hwp-bar3d-top`/`hwp-bar3d-side` 폴리곤)을 방출하고, 축 라벨
// (#1882 3D 축 앵커)은 불변임을 가드.
//
// Stage 2 — 3D 원형: pie3DChart(코퍼스 rotX=30/persp=30)가 타원 top 슬라이스
// (`hwp-pie3d-top`)와 하반부 측벽(`hwp-pie3d-wall`)을 방출함을 가드.
//
// Stage 3 — ofPie 보조플롯: 원형대원형/원형대가로막대형이 주 원 + 보조 플롯 +
// serLines(`hwp-ofpie-*`)를 방출하고, 결합 슬라이스가 실측 팔레트 [4]
// (#27a172)를 사용함을 가드.
//
// 주의: 페이지 SVG 전역에는 도형/WMF `<polygon>`이 존재할 수 있으므로
// 면 계수는 반드시 `hwp-bar3d-*`/`hwp-pie3d-*`/`hwp-ofpie-*` 클래스 기준으로 한다.

/// (stem, 축 라벨 존재 문구(#1882 앵커), 축 라벨 부재 문구)
const BAR3D_STEMS: &[(&str, &[&str], &[&str])] = &[
    ("세로막대형/3차원묶은세로막대형", &[">5<"], &[">6<"]),
    ("세로막대형/3차원누적세로막대형", &[">20<"], &[]),
    ("가로막대형/3차원묶은가로막대형", &[">5<"], &[">6<"]),
    ("가로막대형/3차원누적가로막대형", &[">14<"], &[">20<"]),
];

#[test]
fn bar3d_charts_emit_extrusion_faces_with_stable_axis() {
    for (stem, present, absent) in BAR3D_STEMS {
        for ext in ["hwpx", "hwp"] {
            let rel = format!("samples/chart/{stem}.{ext}");
            let svg = render_page0_svg(&rel);

            // 코퍼스 3계열 × 4카테고리 = 12 막대(세그먼트) — 면 12쌍
            let tops = svg.matches("hwp-bar3d-top").count();
            let sides = svg.matches("hwp-bar3d-side").count();
            assert_eq!(tops, 12, "{rel}: top 면 12개 (3계열×4카테고리)");
            assert_eq!(sides, 12, "{rel}: side 면 12개");

            // 3D 방(뒷벽+바닥+커넥터) 1회 — 시각판정 보정(2026-07-16) 범위 추가
            assert_eq!(svg.matches("hwp-bar3d-room").count(), 1, "{rel}: 3D 방 1회");

            // #1882 3D 축 앵커 불변 (압출은 rect 방출만 대체 — 축 계산 무접촉)
            for want in *present {
                assert!(
                    svg.contains(want),
                    "{rel}: 축 라벨 {want} 소실 (#1882 앵커)"
                );
            }
            for no in *absent {
                assert!(!svg.contains(no), "{rel}: 축 라벨 {no} 출현 (#1882 앵커)");
            }
        }
    }
}

#[test]
fn ofpie_charts_emit_secondary_plot_and_serlines() {
    // 코퍼스 [10, 3.5, 1.5, 1.2] → 주 원 3(2+결합) + 보조 2 (기본 k=2)
    for (stem, second_is_rect) in [("원형대원형", false), ("원형대가로막대형", true)] {
        for ext in ["hwpx", "hwp"] {
            let rel = format!("samples/chart/원형/{stem}.{ext}");
            let svg = render_page0_svg(&rel);

            assert_eq!(
                svg.matches("hwp-ofpie-main").count(),
                3,
                "{rel}: 주 원 슬라이스 3"
            );
            assert_eq!(
                svg.matches("hwp-ofpie-second").count(),
                2,
                "{rel}: 보조 플롯 2"
            );
            assert_eq!(
                svg.matches("hwp-ofpie-serline").count(),
                2,
                "{rel}: serLines 2"
            );
            // 결합 슬라이스 = 실측 팔레트 [4] 초록계
            assert!(svg.contains("#27a172"), "{rel}: 결합 슬라이스 실측색");
            if second_is_rect {
                assert!(
                    svg.contains("<rect class=\"hwp-ofpie-second\""),
                    "{rel}: 가로막대형 보조는 rect"
                );
            }
            assert!(
                !svg.contains("hwp-ooxml-chart-fallback"),
                "{rel}: placeholder 잔존"
            );
        }
    }
}

#[test]
fn pie3d_chart_emits_ellipse_tops_and_lower_walls() {
    for ext in ["hwpx", "hwp"] {
        let rel = format!("samples/chart/원형/3차원원형.{ext}");
        let svg = render_page0_svg(&rel);

        // 코퍼스 4슬라이스 — top 4개, 하반부 노출 슬라이스만 벽(≥1)
        assert_eq!(
            svg.matches("hwp-pie3d-top").count(),
            4,
            "{rel}: top 타원 슬라이스 4개"
        );
        assert!(
            svg.matches("hwp-pie3d-wall").count() >= 1,
            "{rel}: 하반부 측벽 ≥ 1"
        );
        // placeholder 미출현 (렌더 전환 완료)
        assert!(
            !svg.contains("hwp-ooxml-chart-fallback"),
            "{rel}: placeholder 잔존"
        );
    }
}

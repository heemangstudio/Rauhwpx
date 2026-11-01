//! OOXML 차트 → SVG 네이티브 렌더러
//!
//! `OoxmlChart` 데이터 모델을 지정된 bbox 안에 SVG 문자열로 그린다.
//! - 세로/가로 막대, 꺾은선, 원형
//! - **콤보 차트** (bar + line) 및 **이중 Y축** 지원

use super::{
    BarGrouping, LegendPos, OfPieInfo, OfPieType, OoxmlChart, OoxmlChartType, OoxmlSeries,
    RadarStyle, ScatterStyle, SeriesMarker, View3D,
};

/// 기본 시리즈 색상 팔레트 (시리즈 색상 미지정 시 순환 사용)
///
/// 한컴 2022 기본 팔레트(`hncChartStyle colorIndex="0"`) — 앞 5색은 `pdf/chart/` 정답지
/// PDF 픽셀 실측(막대 3시리즈 + 원형 4슬라이스 + ofPie 결합 슬라이스), 6번째 이후는
/// 코퍼스에 초과 샘플이 없어 미실측(Office 유사색 순서로 유추 배치).
const DEFAULT_PALETTE: &[u32] = &[
    0xFF6183D7, // 파랑 (실측)
    0xFFFE813B, // 주황 (실측)
    0xFFB0B0B0, // 회색 (실측)
    0xFFFCD801, // 노랑 (실측)
    0xFF27A172, // 초록계 (실측 — ofPie 결합 슬라이스, 원형대원형·가로막대 교차 일치)
    0xFF5B9BD5, // 하늘 (유추 — [4]에서 강등)
    0xFF9013FE, 0xFF50E3C2,
];

fn palette(i: usize) -> u32 {
    DEFAULT_PALETTE[i % DEFAULT_PALETTE.len()]
}

fn color_hex(c: u32) -> String {
    format!("#{:06x}", c & 0xFFFFFF)
}

/// RGB 음영 — factor>0 은 흰색 방향 lighten, factor<0 은 검정 방향 darken.
/// 채널별 선형 보간, 상위(알파) 바이트는 보존. 3D 면 음영용. (C2b #2278)
fn shade(rgb: u32, factor: f64) -> u32 {
    let f = factor.clamp(-1.0, 1.0);
    let ch = |c: u32| -> u32 {
        let c = c as f64;
        let v = if f >= 0.0 {
            c + (255.0 - c) * f
        } else {
            c * (1.0 + f)
        };
        v.round().clamp(0.0, 255.0) as u32
    };
    (rgb & 0xFF00_0000)
        | (ch((rgb >> 16) & 0xFF) << 16)
        | (ch((rgb >> 8) & 0xFF) << 8)
        | ch(rgb & 0xFF)
}

/// 3D 막대 면 음영 계수 — 정답지 4종 판독 근사(윗면 밝게/우측면 어둡게,
/// stage1 실측 기록), 시각판정 보정 대상. (C2b #2278)
const BAR3D_TOP_SHADE: f64 = 0.25;
const BAR3D_SIDE_SHADE: f64 = -0.25;

/// rAngAx=1(직각 축 — 한컴 차트 스펙 rev1.2 표 100 ProjectionType=1
/// "2.5차원: 회전·상승해도 XY 면 불변"과 동계) 시어 투영 사전계산.
/// 씬 = 앞면 플롯평면 × 깊이 [0..D], 화면 깊이 벡터 = (+sin(rotY), −sin(rotX))·D.
/// 투영 bbox를 플롯 rect에 비등방 fit — 앞면은 좌하 고정, 뒷벽이 우상으로.
/// rAngAx=0 막대는 코퍼스 부재 — 동일 시어 폴백(근사, 진짜 회전 투영은 Stage 2
/// 원형에서 rot_x 유도로 도입). (C2b #2278 v2)
struct ShearProj {
    /// fit 후 앞면(z=0) rect — 3D 배치 수식의 기준
    fx: f64,
    fy: f64,
    fw: f64,
    fh: f64,
    /// fit 후 z=D 화면 오프셋 (+우/+상)
    dxf: f64,
    dyf: f64,
}

fn shear_proj(view: &View3D, px: f64, py: f64, pw: f64, ph: f64, depth: f64) -> ShearProj {
    // 음수 시어 성분(rotX<0 하향, sin(rotY)<0 좌향)은 코퍼스 부재 + 페인트
    // 순서(아래→위/왼→오른쪽 은면 제거)와 상충 — 0 클램프 방어 근사.
    // 실샘플 확보 시 순회 방향 반전과 함께 확장. (v2 설계 리뷰 확정)
    let ox = (depth * view.rot_y.to_radians().sin()).max(0.0);
    let oy = (depth * view.rot_x.to_radians().sin()).max(0.0);
    let sx = pw / (pw + ox).max(1e-9);
    let sy = ph / (ph + oy).max(1e-9);
    ShearProj {
        fx: px,           // ox ≥ 0 → 앞면 좌측 고정
        fy: py + oy * sy, // oy ≥ 0 → 앞면 하단 고정 (화면 y-down: 상단 여백 = oy·sy)
        fw: pw * sx,
        fh: ph * sy,
        dxf: ox * sx,
        dyf: oy * sy,
    }
}

/// 3D 막대 1개(또는 누적 세그먼트 1개) — 압출 벡터 (+dx, −dy) 3면:
/// top 평행사변형(밝게) + right 평행사변형(어둡게) + front rect(원색).
/// dx, dy ≥ 0 전제(shear_proj 클램프 — 음수 성분은 페인트 순서 은면 제거와
/// 상충하여 정의역 밖). 은면 제거는 호출측 페인트 순서(누적: 아래→위/왼→오른쪽)가
/// 담당하므로 루프 순서 변경 금지. w/h ≤ 0(0값 세그먼트)이면 무방출 — 누적에서
/// 이웃 세그먼트의 캡 재도색 방지. 압출 퇴화(dx,dy < 0.01)면 front만. (C2b #2278 v2)
fn push_bar_3d(svg: &mut String, x: f64, y: f64, w: f64, h: f64, dx: f64, dy: f64, color: u32) {
    if w <= 0.0 || h <= 0.0 {
        return;
    }
    debug_assert!(dx >= 0.0 && dy >= 0.0, "시어 성분은 클램프로 비음수");
    if dx > 0.01 || dy > 0.01 {
        svg.push_str(&format!(
            "<polygon class=\"hwp-bar3d-top\" points=\"{:.2},{:.2} {:.2},{:.2} {:.2},{:.2} {:.2},{:.2}\" fill=\"{}\"/>\n",
            x, y, x + dx, y - dy, x + w + dx, y - dy, x + w, y,
            color_hex(shade(color, BAR3D_TOP_SHADE))
        ));
        svg.push_str(&format!(
            "<polygon class=\"hwp-bar3d-side\" points=\"{:.2},{:.2} {:.2},{:.2} {:.2},{:.2} {:.2},{:.2}\" fill=\"{}\"/>\n",
            x + w, y, x + w + dx, y - dy, x + w + dx, y + h - dy, x + w, y + h,
            color_hex(shade(color, BAR3D_SIDE_SHADE))
        ));
    }
    svg.push_str(&format!(
        "<rect x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" fill=\"{}\"/>\n",
        x,
        y,
        w,
        h,
        color_hex(color)
    ));
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

/// 숫자 포맷 (#,##0 기본. 실수면 소수점 반올림)
fn format_num(v: f64, format_code: Option<&str>) -> String {
    let fc = format_code.unwrap_or("#,##0");
    let has_thousands = fc.contains(',');
    let _ = fc; // decimal handling 확장 여지
    let rounded = v.round() as i64;
    let abs = rounded.unsigned_abs();
    let sign = if rounded < 0 { "-" } else { "" };
    let s = abs.to_string();
    if !has_thousands {
        return format!("{}{}", sign, s);
    }
    // 콤마 구분
    let bytes = s.as_bytes();
    let len = bytes.len();
    let mut out = String::with_capacity(len + len / 3);
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && (len - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(*b as char);
    }
    format!("{}{}", sign, out)
}

/// 분산형 수치축 눈금용 소수 포맷. 정수면 소수점 없이, 아니면 소수 2자리 후 trailing 0 제거.
/// (`format_num`은 정수 반올림이라 0.5/2.6 등 소수 눈금을 손상시키므로 별도 헬퍼) — C1b #1660.
fn format_axis_num(v: f64) -> String {
    if (v - v.round()).abs() < 1e-9 {
        return format!("{}", v.round() as i64);
    }
    let mut s = format!("{:.2}", v);
    while s.ends_with('0') {
        s.pop();
    }
    if s.ends_with('.') {
        s.pop();
    }
    s
}

/// 차트 전체를 SVG 조각으로 렌더
pub fn render_chart_svg(chart: &OoxmlChart, x: f64, y: f64, w: f64, h: f64) -> String {
    if chart.series.is_empty() || chart.chart_type == OoxmlChartType::Unknown {
        return render_fallback(chart, x, y, w, h);
    }

    let mut svg = String::new();
    // A nested SVG establishes a chart-local viewport. This keeps labels,
    // markers, and thick strokes inside the source object's bbox in every
    // renderer without globally-scoped clipPath IDs.
    svg.push_str(&format!(
        "<svg class=\"hwp-ooxml-chart-viewport\" x=\"{x:.2}\" y=\"{y:.2}\" width=\"{w:.2}\" height=\"{h:.2}\" viewBox=\"{x:.2} {y:.2} {w:.2} {h:.2}\" overflow=\"hidden\"><g class=\"hwp-ooxml-chart\"><rect x=\"{x:.2}\" y=\"{y:.2}\" width=\"{w:.2}\" height=\"{h:.2}\" fill=\"#ffffff\" stroke=\"#cccccc\" stroke-width=\"0.5\"/>\n"
    ));

    // C1c #1882 갭①: 명시 제목이 없어도 c:title 요소가 있고 autoTitleDeleted=0이면
    // 한컴처럼 자동 제목 placeholder "차트 제목"을 그린다 (정답지 PDF 실측).
    // 자동 제목 우선순위(#1882 v2): 명시 텍스트 → 단일 시리즈면 그 이름 → "차트 제목".
    // 한컴 실측: 원형 5종("판매")·단일 시리즈 가로막대("계열 1") 정답지가 시리즈
    // 이름을 제목으로 렌더 — 차트 종류가 아니라 시리즈 수 기준 (Excel 동작과 동일).
    let effective_title: Option<String> = chart.title.clone().or_else(|| {
        (chart.has_title_elem && !chart.auto_title_deleted).then(|| match &chart.series[..] {
            [only] if !only.name.is_empty() => only.name.clone(),
            _ => "차트 제목".to_string(),
        })
    });

    // 영역 분할
    let title_h = if effective_title.is_some() { 22.0 } else { 4.0 };
    // 파이는 카테고리 기반 범례라 시리즈 이름과 무관하게 항상 그려진다(파이 분기가
    // render_legend/render_legend_right를 무조건 호출) — 공간 예약도 그에 맞춰야 함.
    let legend_visible = matches!(
        chart.chart_type,
        OoxmlChartType::Pie | OoxmlChartType::Doughnut
    ) || chart.series.iter().any(|s| !s.name.is_empty());
    // C1c #1882 갭③: legendPos=r(한컴 코퍼스 전 샘플)은 우측 세로 스택 — 하단 슬롯
    // 대신 우측 폭(legend_w)을 확보. 그 외 위치는 현행 하단 가로 유지.
    // `w * 0.30 >= 50.0` 가드: 폭이 좁으면(<167px) 하단 폴백 — 아래 clamp의
    // min(50)>max(w*0.30) 패닉 방지 (w는 문서 데이터가 결정). NaN도 false → 폴백.
    let legend_right = legend_visible && chart.legend_pos == LegendPos::Right && w * 0.30 >= 50.0;
    let legend_h = if legend_visible && !legend_right {
        22.0
    } else {
        0.0
    };
    let legend_w = if legend_right {
        let max_chars = legend_items(chart)
            .iter()
            .map(|(label, _, _)| label.chars().count())
            .max()
            .unwrap_or(0);
        // 스와치 10 + 간격 8 + CJK ~10px/자 (플롯 최소폭은 아래 .max(10.0)이 방어)
        (max_chars as f64 * 10.0 + 26.0).clamp(50.0, w * 0.30)
    } else {
        0.0
    };
    // 좌측 여유: 세로 차트는 값축 숫자 라벨, **가로 막대는 카테고리 라벨**("항목 1" 등)이
    // 좌측에 오므로 카테고리 폭 기준 — 숫자 폭(2자≈32px)으로 잡으면 라벨이 잘림.
    let horizontal_bars =
        chart.chart_type == OoxmlChartType::Bar && !chart.is_combo() && !chart.has_secondary_axis;
    let mut left_pad = if horizontal_bars {
        estimate_category_label_width(chart, w)
    } else {
        estimate_axis_label_width(chart, 0)
    };
    if chart.primary_value_axis_title.is_some() {
        left_pad += 16.0;
    }
    let mut right_pad = if chart.has_secondary_axis {
        estimate_axis_label_width(chart, 1)
    } else {
        16.0
    };
    if chart.secondary_value_axis_title.is_some() {
        right_pad += 16.0;
    }
    let axis_title_h = if chart.category_axis_title.is_some() {
        16.0
    } else {
        0.0
    };
    let bottom_pad = 26.0 + axis_title_h;
    let plot_x = x + left_pad;
    let plot_y = y + title_h + 4.0;
    let plot_w = (w - left_pad - right_pad - legend_w).max(10.0);
    let plot_h = (h - title_h - legend_h - bottom_pad).max(10.0);

    if let Some(ref title) = effective_title {
        // 한컴 제목은 regular weight (정답지 PDF 실측 — C1c #1882 갭①)
        svg.push_str(&format!(
            "<text x=\"{:.2}\" y=\"{:.2}\" font-family=\"sans-serif\" font-size=\"13\" font-weight=\"400\" fill=\"#222\" text-anchor=\"middle\">{}</text>\n",
            x + w / 2.0,
            y + title_h - 4.0,
            xml_escape(title)
        ));
    }

    // 파이 차트는 단독 경로 (ofPie 보조플롯 / 3D 타원+측벽 — 2D 경로 무접촉)
    if matches!(
        chart.chart_type,
        OoxmlChartType::Pie | OoxmlChartType::Doughnut
    ) {
        if let Some(of) = &chart.of_pie {
            render_of_pie(&mut svg, chart, of, plot_x, plot_y, plot_w, plot_h);
        } else if chart.chart_type == OoxmlChartType::Doughnut {
            render_doughnut(&mut svg, chart, plot_x, plot_y, plot_w, plot_h);
        } else if chart.is_3d {
            render_pie_3d(&mut svg, chart, plot_x, plot_y, plot_w, plot_h);
        } else {
            render_pie(&mut svg, chart, plot_x, plot_y, plot_w, plot_h);
        }
        if legend_right {
            render_legend_right(&mut svg, chart, x + w - legend_w + 4.0, plot_y, plot_h);
        } else {
            render_legend(
                &mut svg,
                chart,
                x + 8.0,
                y + h - legend_h,
                w - 16.0,
                legend_h,
            );
        }
        render_data_labels(&mut svg, chart, plot_x, plot_y, plot_w, plot_h);
        render_axis_titles(&mut svg, chart, plot_x, plot_y, plot_w, plot_h);
        svg.push_str("</g></svg>\n");
        return svg;
    }

    // 콤보 또는 이중축이면 조합 렌더
    if chart.is_combo() || chart.has_secondary_axis {
        render_combo(&mut svg, chart, plot_x, plot_y, plot_w, plot_h);
    } else {
        match chart.chart_type {
            OoxmlChartType::Column => {
                render_bars(&mut svg, chart, plot_x, plot_y, plot_w, plot_h, false)
            }
            OoxmlChartType::Bar => {
                render_bars(&mut svg, chart, plot_x, plot_y, plot_w, plot_h, true)
            }
            OoxmlChartType::Line => render_line(&mut svg, chart, plot_x, plot_y, plot_w, plot_h),
            OoxmlChartType::Scatter => {
                render_scatter(&mut svg, chart, plot_x, plot_y, plot_w, plot_h)
            }
            OoxmlChartType::Stock => render_stock(&mut svg, chart, plot_x, plot_y, plot_w, plot_h),
            OoxmlChartType::Area => render_area(&mut svg, chart, plot_x, plot_y, plot_w, plot_h),
            OoxmlChartType::Radar => render_radar(&mut svg, chart, plot_x, plot_y, plot_w, plot_h),
            _ => {}
        }
    }

    render_data_labels(&mut svg, chart, plot_x, plot_y, plot_w, plot_h);
    render_axis_titles(&mut svg, chart, plot_x, plot_y, plot_w, plot_h);

    if legend_right {
        render_legend_right(&mut svg, chart, x + w - legend_w + 4.0, plot_y, plot_h);
    } else {
        render_legend(
            &mut svg,
            chart,
            x + 8.0,
            y + h - legend_h,
            w - 16.0,
            legend_h,
        );
    }
    svg.push_str("</g></svg>\n");
    svg
}

fn render_fallback(chart: &OoxmlChart, x: f64, y: f64, w: f64, h: f64) -> String {
    let label = format!("차트 ({})", chart.chart_type.label());
    format!(
        "<g class=\"hwp-ooxml-chart-fallback\"><rect x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" fill=\"#f0f0f0\" stroke=\"#707070\" stroke-width=\"1\" stroke-dasharray=\"6 3\"/><text x=\"{:.2}\" y=\"{:.2}\" font-family=\"sans-serif\" font-size=\"14\" fill=\"#707070\" text-anchor=\"middle\" dominant-baseline=\"central\">{}</text></g>\n",
        x, y, w, h,
        x + w / 2.0, y + h / 2.0,
        xml_escape(&label)
    )
}

fn series_color(s: &OoxmlSeries, idx: usize) -> String {
    color_hex(s.color.unwrap_or_else(|| palette(idx)))
}

/// 가로 막대 좌측 카테고리 라벨용 여백: 최장 카테고리 문자 수 기반 (CJK ~10px/자).
/// 상한은 차트 폭의 35%(플롯 최소폭은 호출부 `.max(10.0)`이 방어).
fn estimate_category_label_width(chart: &OoxmlChart, w: f64) -> f64 {
    let max_chars = chart
        .categories
        .iter()
        .map(|c| c.chars().count())
        .max()
        .unwrap_or(0);
    (max_chars as f64 * 10.0 + 14.0)
        .min((w * 0.35).max(28.0))
        .max(28.0)
}

/// 지정한 axis_group의 최대 라벨 길이(문자 수) 기반으로 여백 추정
fn estimate_axis_label_width(chart: &OoxmlChart, axis_group: u8) -> f64 {
    let series: Vec<&OoxmlSeries> = chart
        .series
        .iter()
        .filter(|s| s.axis_group == axis_group)
        .collect();
    if series.is_empty() {
        return 16.0;
    }
    let (vmin, vmax, _) = value_range_for(series.iter().cloned(), VERTICAL_AXIS_TICKS);
    let fmt = series.first().and_then(|s| s.format_code.as_deref());
    let min_label = format_num(vmin, fmt);
    let max_label = format_num(vmax, fmt);
    let max_chars = min_label.chars().count().max(max_label.chars().count());
    // 숫자/콤마는 ~7px, 안전 여유 18px (좌우 플롯 영역 바깥 라벨 공간 확보)
    (max_chars as f64 * 7.0 + 18.0).max(28.0)
}

/// 시리즈 부분집합의 원시 값 범위 (0-baseline clamp + 퇴화 방어, nice 반올림 전)
fn raw_value_bounds<'a>(series: impl Iterator<Item = &'a OoxmlSeries>) -> (f64, f64) {
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for s in series {
        for &v in &s.values {
            if v < min {
                min = v;
            }
            if v > max {
                max = v;
            }
        }
    }
    if !min.is_finite() {
        min = 0.0;
    }
    if !max.is_finite() {
        max = 1.0;
    }
    if min > 0.0 {
        min = 0.0;
    }
    if max == min {
        max = min + 1.0;
    }
    (min, max)
}

/// 시리즈 부분집합에 대한 값 범위 `(min, max, step)`. `target_ticks`는 축 방향별
/// 눈금 밀도(`VERTICAL_AXIS_TICKS`/`HORIZONTAL_AXIS_TICKS`).
fn value_range_for<'a>(
    series: impl Iterator<Item = &'a OoxmlSeries>,
    target_ticks: f64,
) -> (f64, f64, f64) {
    let (min, max) = raw_value_bounds(series);
    // Nice number 반올림 (눈금을 깔끔하게, 경계 headroom 포함)
    nice_axis(min, max, target_ticks)
}

fn value_range(chart: &OoxmlChart, target_ticks: f64) -> (f64, f64, f64) {
    value_range_for(chart.series.iter(), target_ticks)
}

/// raw 간격에 가장 가까운 "깔끔한" 눈금 간격 (1/2/5/10 × 10^n, 반올림 임계 1.5/3/7)
fn floor_nice_step(raw: f64) -> f64 {
    let mag = 10f64.powf(raw.abs().log10().floor());
    let norm = raw / mag;
    let step = if norm < 1.5 {
        1.0
    } else if norm < 3.0 {
        2.0
    } else if norm < 7.0 {
        5.0
    } else {
        10.0
    };
    step * mag
}

/// 세로 값축 눈금 목표 칸수 (한컴 2022 실측: 세로막대/선의 값축은 ~3칸 — 5.0→0~6
/// step 2, 누적 12.3→0~15 step 5)
const VERTICAL_AXIS_TICKS: f64 = 3.0;
/// 가로 값축·scatter 양축 눈금 목표 칸수 (실측: 가로 누적 12.3→0~14 step 2,
/// 가로 묶은 5.0→0~6 step 1, scatter X 2.6→0~3 step 0.5)
const HORIZONTAL_AXIS_TICKS: f64 = 5.0;

/// min~max 구간을 "깔끔한" 눈금으로 확장하고 `(min', max', step)`을 반환.
///
/// 한컴 정합(C1c #1882 갭④, 시각판정 실측 보강): 데이터 max가 step 경계에 정확히
/// 걸리면 **+1 step headroom**(step은 유지 — 가로 묶은막대 5.0→0~6 step 1 실측).
/// 눈금 밀도는 축 방향별 target_ticks로 제어(세로 3칸/가로·scatter 5칸) — 같은
/// 데이터(합 12.3)가 세로 누적 0~15 step 5, 가로 누적 0~14 step 2로 실측됨.
/// 3차원 계열의 고유 축(묶은 0~5 무헤드룸/누적 0~20 과헤드룸)은 2D 근사 범위 밖(C2).
fn nice_axis(min: f64, max: f64, target_ticks: f64) -> (f64, f64, f64) {
    let (new_min, mut new_max, step) = nice_axis_no_headroom(min, max, target_ticks);
    if (new_max - max).abs() < step * 1e-6 {
        new_max += step; // 경계 headroom +1 step (step 유지)
    }
    (new_min, new_max, step)
}

/// `nice_axis`의 경계 headroom 없는 변형 — 한컴 3D 묶은막대 실측(세로·가로 모두
/// 0~5: 데이터 max 5.0이 step 1 경계에 걸려도 확장하지 않음)용.
fn nice_axis_no_headroom(min: f64, max: f64, target_ticks: f64) -> (f64, f64, f64) {
    if max <= min {
        return (min, max, 1.0);
    }
    let step = floor_nice_step((max - min) / target_ticks);
    let new_min = (min / step).floor() * step;
    let new_max = (max / step).ceil() * step;
    (new_min, new_max, step)
}

/// 분산형 수치축 범위 `(min, max, step)`. 양수 데이터는 **0 기준선으로 clamp**한다 —
/// 한컴 분산형 PDF 정합(정답지 X·Y 모두 0부터: 표식만있는분산형 X 0~3·Y 0~5).
/// 막대/선 축(`value_range_for`)과 동일한 0-baseline 동작이라 차트 종류 간 일관성도
/// 확보. nice_axis로 눈금 정리(경계 headroom 포함, C1c #1882 갭④). — C1b #1660.
fn scatter_range(vals: impl Iterator<Item = f64>) -> (f64, f64, f64) {
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for v in vals {
        if v < min {
            min = v;
        }
        if v > max {
            max = v;
        }
    }
    if !min.is_finite() {
        min = 0.0;
    }
    if !max.is_finite() {
        max = 1.0;
    }
    if min > 0.0 {
        min = 0.0; // 양수 데이터는 0 기준선 (한컴 분산형 정합)
    }
    if (max - min).abs() < 1e-9 {
        max = min + 1.0;
    }
    nice_axis(min, max, HORIZONTAL_AXIS_TICKS)
}

// ---------------- Bar / Column (단일 축) ----------------

fn render_bars(
    svg: &mut String,
    chart: &OoxmlChart,
    px: f64,
    py: f64,
    pw: f64,
    ph: f64,
    horizontal: bool,
) {
    let stacked = matches!(
        chart.grouping,
        BarGrouping::Stacked | BarGrouping::PercentStacked
    );
    let percent = chart.grouping == BarGrouping::PercentStacked;

    let cat_count = chart.categories.len().max(
        chart
            .series
            .iter()
            .map(|s| s.values.len())
            .max()
            .unwrap_or(0),
    );
    if cat_count == 0 {
        return;
    }
    let ser_count = chart.series.len().max(1);

    // 값축 범위: clustered=개별값, stacked=카테고리 합의 최대, percent=0~100%
    // (percent는 step 20 고정 = 종전 5등분 라벨 0/20/…/100%와 동일)
    // 눈금 밀도는 값축 방향 기준: 세로막대=세로 값축(3칸), 가로막대=가로 값축(5칸)
    let ticks = if horizontal {
        HORIZONTAL_AXIS_TICKS
    } else {
        VERTICAL_AXIS_TICKS
    };
    let (vmin, vmax, vstep) = if percent {
        (0.0, 100.0, 20.0)
    } else if stacked {
        let max_sum = (0..cat_count)
            .map(|ci| category_positive_sum(chart, ci))
            .fold(0.0_f64, f64::max);
        let (mn, mx, st) = nice_axis(0.0, max_sum.max(1.0), ticks);
        if chart.is_3d && !horizontal {
            // 한컴 3D 누적'세로' 실측: 2D(0~15) + 1 step = 0~20. 가로는 2D와 동일(0~14).
            (mn, mx + st, st)
        } else {
            (mn, mx, st)
        }
    } else if chart.is_3d {
        // 한컴 3D 묶은막대 실측: 세로·가로 모두 촘촘 눈금(5칸) + 경계 headroom 없음
        // (max 5.0 → 0~5 step 1; 2D의 0~6과 다름)
        let (mn, mx) = raw_value_bounds(chart.series.iter());
        nice_axis_no_headroom(mn, mx, HORIZONTAL_AXIS_TICKS)
    } else {
        let (mn, mx, st) = value_range(chart, ticks);
        // 특이케이스 실측(C1c v2 기록 → #2277 stage5): 가로막대 1카테고리 미니차트는
        // 축 범위 유지·step 절반 (4.3 → 0~5 step 0.5, 라벨 11개). 기존 가로축 앵커
        // (12.3→2 / 5.0→1 / 2.6→0.5)와 단일 규칙 불성립 — 단일 샘플 근거라
        // 가로·1카테고리(·이 분기 자체로 비누적·비3D)로 좁게 게이트. 세로 1카테고리는
        // 미실측이라 불변.
        if horizontal && cat_count == 1 {
            (mn, mx, st / 2.0)
        } else {
            (mn, mx, st)
        }
    };

    if chart.is_3d {
        // 3D는 시어 투영 기반 별도 경로 — 축 범위(vmin/vmax/vstep)는 위에서
        // 플롯 rect 기준으로 이미 확정(#1882 앵커 무접촉). 배치·방·압출만
        // 투영 좌표로 수행. (C2b #2278 v2)
        render_bars_3d(
            svg, chart, px, py, pw, ph, horizontal, stacked, percent, cat_count, ser_count, vmin,
            vmax, vstep,
        );
        return;
    }

    svg.push_str(&format!(
        "<rect x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" fill=\"#ffffff\" stroke=\"#cccccc\" stroke-width=\"0.5\"/>\n",
        px, py, pw, ph
    ));

    render_value_grid(
        svg,
        px,
        py,
        pw,
        ph,
        vmin,
        vmax,
        vstep,
        chart.series.first().and_then(|s| s.format_code.as_deref()),
        horizontal,
        false,
        percent,
        false,
    );

    let (cat_span, bar_span_total) = if horizontal {
        let span = ph / cat_count as f64;
        (span, span * 0.7)
    } else {
        let span = pw / cat_count as f64;
        (span, span * 0.7)
    };

    // 가로 막대는 카테고리를 아래→위로 배치 (한컴 실측: 항목 1이 맨 아래).
    // 세로는 왼→오른쪽 그대로.
    let cat_slot = |ci: usize| -> f64 {
        let idx = if horizontal { cat_count - 1 - ci } else { ci };
        cat_span * idx as f64
    };

    if stacked {
        // 누적: 카테고리당 단일 막대, 시리즈를 아래/왼쪽부터 쌓음.
        // percent → 카테고리 합으로 정규화(전체 길이 = 100%), stacked → vmax로 정규화.
        for ci in 0..cat_count {
            let denom = if percent {
                let s = category_positive_sum(chart, ci);
                if s > 0.0 {
                    s
                } else {
                    1.0
                }
            } else {
                (vmax - vmin).max(1e-9)
            };
            let mut acc = 0.0_f64; // 지금까지 쌓인 픽셀 길이
            for (si, ser) in chart.series.iter().enumerate() {
                let v = ser.values.get(ci).copied().unwrap_or(0.0).max(0.0);
                let color = series_color(ser, si);
                let base = px;
                // 셀 시작: 가로=세로축(py) 기준, 세로=가로축(px) 기준
                let cell = if horizontal { py } else { px }
                    + cat_slot(ci)
                    + (cat_span - bar_span_total) / 2.0;
                if horizontal {
                    let seg = pw * (v / denom);
                    svg.push_str(&format!(
                        "<rect x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" fill=\"{}\"/>\n",
                        base + acc, cell, seg.max(0.0), bar_span_total, color
                    ));
                    acc += seg;
                } else {
                    let seg = ph * (v / denom);
                    let by = py + ph - acc - seg;
                    svg.push_str(&format!(
                        "<rect x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" fill=\"{}\"/>\n",
                        cell, by, bar_span_total, seg.max(0.0), color
                    ));
                    acc += seg;
                }
            }
        }
    } else {
        let bar_w = bar_span_total / ser_count as f64;
        for ci in 0..cat_count {
            for (si, ser) in chart.series.iter().enumerate() {
                let v = *ser.values.get(ci).unwrap_or(&0.0);
                let t = if vmax > vmin {
                    (v - vmin) / (vmax - vmin)
                } else {
                    0.0
                };
                let color = series_color(ser, si);
                if horizontal {
                    // 슬롯 내 세로 배치: 계열1이 맨 아래 (정답지 실측 — 위→아래 =
                    // 계열3→1, 범례 역순과 시각 일치. #2277 stage3)
                    let cy = py
                        + cat_slot(ci)
                        + (cat_span - bar_span_total) / 2.0
                        + bar_w * (ser_count - 1 - si) as f64;
                    let bw = pw * t;
                    svg.push_str(&format!(
                        "<rect x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" fill=\"{}\"/>\n",
                        px, cy, bw.max(0.0), bar_w * 0.95, color
                    ));
                } else {
                    let cx =
                        px + cat_slot(ci) + (cat_span - bar_span_total) / 2.0 + bar_w * si as f64;
                    let bh = ph * t;
                    let by = py + ph - bh;
                    svg.push_str(&format!(
                        "<rect x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" fill=\"{}\"/>\n",
                        cx, by, bar_w * 0.95, bh.max(0.0), color
                    ));
                }
            }
        }
    }

    render_category_labels(svg, chart, px, py, pw, ph, cat_count, horizontal);
}

/// 한 카테고리의 (양수) 시리즈 값 합. 누적 막대 축/정규화에 사용.
fn category_positive_sum(chart: &OoxmlChart, ci: usize) -> f64 {
    chart
        .series
        .iter()
        .map(|s| s.values.get(ci).copied().unwrap_or(0.0).max(0.0))
        .sum()
}

// ---------------- Line (단일 축) ----------------

fn render_line(svg: &mut String, chart: &OoxmlChart, px: f64, py: f64, pw: f64, ph: f64) {
    let stacked = matches!(
        chart.line_grouping,
        BarGrouping::Stacked | BarGrouping::PercentStacked
    );
    let percent = chart.line_grouping == BarGrouping::PercentStacked;

    let max_len = chart
        .series
        .iter()
        .map(|s| s.values.len())
        .max()
        .unwrap_or(0);
    if max_len < 2 {
        return;
    }

    // 값축: 비누적=개별값, 누적=카테고리 합의 최대, 백프로=0~100% step 20
    // (render_bars 누적 정책 미러 — 정답지 실측 누적 0~15 step 5. C1d #2129)
    let (vmin, vmax, vstep) = if percent {
        (0.0, 100.0, 20.0)
    } else if stacked {
        let max_sum = (0..max_len)
            .map(|ci| category_positive_sum(chart, ci))
            .fold(0.0_f64, f64::max);
        nice_axis(0.0, max_sum.max(1.0), VERTICAL_AXIS_TICKS)
    } else {
        value_range(chart, VERTICAL_AXIS_TICKS)
    };

    svg.push_str(&format!(
        "<rect x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" fill=\"#ffffff\" stroke=\"#cccccc\" stroke-width=\"0.5\"/>\n",
        px, py, pw, ph
    ));
    render_value_grid(
        svg,
        px,
        py,
        pw,
        ph,
        vmin,
        vmax,
        vstep,
        chart.series.first().and_then(|s| s.format_code.as_deref()),
        false,
        false,
        percent,
        false,
    );

    // x 배치: 카테고리 슬롯 중앙 (한컴 정합, XML crossBetween=between —
    // 첫/끝 점이 플롯 가장자리가 아닌 반 슬롯 안쪽. 카테고리 라벨과 동일 공식.
    // 작업지시자 시각판정 반영, C1d #2129)
    let cat_span = pw / max_len as f64;
    let mut cum = vec![0.0_f64; max_len]; // 카테고리별 누적값 (값공간)
    for (si, ser) in chart.series.iter().enumerate() {
        let color = series_color(ser, si);
        let mut points: Vec<(f64, f64)> = Vec::with_capacity(ser.values.len());
        for (i, &v) in ser.values.iter().enumerate() {
            let val = if stacked {
                cum[i] += v.max(0.0); // 음수 clamp — render_bars 누적과 동일 정책
                if percent {
                    let sum = category_positive_sum(chart, i);
                    if sum > 0.0 {
                        cum[i] / sum * 100.0
                    } else {
                        0.0 // 합 0 카테고리 → 0% (막대 denom=1.0 가드와 동등)
                    }
                } else {
                    cum[i]
                }
            } else {
                v
            };
            let t = if vmax > vmin {
                (val - vmin) / (vmax - vmin)
            } else {
                0.0
            };
            points.push((px + cat_span * (i as f64 + 0.5), py + ph - ph * t));
        }
        svg.push_str(&format!(
            "<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"2\"/>\n",
            polyline_path(&points),
            color
        ));
        if chart.line_markers {
            for &(mx, my) in &points {
                push_line_marker(svg, si, mx, my, &color);
            }
        }
    }

    render_category_labels(svg, chart, px, py, pw, ph, max_len, false);
}

// ---------------- Area ----------------

fn render_area(svg: &mut String, chart: &OoxmlChart, px: f64, py: f64, pw: f64, ph: f64) {
    let count = chart
        .series
        .iter()
        .map(|series| series.values.len())
        .max()
        .unwrap_or(0);
    if count == 0 {
        return;
    }
    let stacked = matches!(
        chart.area_grouping,
        BarGrouping::Stacked | BarGrouping::PercentStacked
    );
    let percent = chart.area_grouping == BarGrouping::PercentStacked;
    let (vmin, vmax, vstep) = if percent {
        (0.0, 100.0, 20.0)
    } else if stacked {
        let max_sum = (0..count)
            .map(|index| category_positive_sum(chart, index))
            .fold(0.0_f64, f64::max);
        nice_axis(0.0, max_sum.max(1.0), VERTICAL_AXIS_TICKS)
    } else {
        value_range(chart, VERTICAL_AXIS_TICKS)
    };
    svg.push_str(&format!(
        "<rect class=\"hwp-chart-area-plot\" x=\"{px:.2}\" y=\"{py:.2}\" width=\"{pw:.2}\" height=\"{ph:.2}\" fill=\"#ffffff\" stroke=\"#cccccc\" stroke-width=\"0.5\"/>\n"
    ));
    render_value_grid(
        svg,
        px,
        py,
        pw,
        ph,
        vmin,
        vmax,
        vstep,
        chart.series.first().and_then(|s| s.format_code.as_deref()),
        false,
        false,
        percent,
        false,
    );
    let span = pw / count.max(1) as f64;
    let baseline_t = ((0.0 - vmin) / (vmax - vmin).max(1e-9)).clamp(0.0, 1.0);
    let baseline_y = py + ph * (1.0 - baseline_t);
    let mut cumulative = vec![0.0_f64; count];
    let mut previous_boundary: Vec<(f64, f64)> = (0..count)
        .map(|index| (px + span * (index as f64 + 0.5), baseline_y))
        .collect();
    for (si, series) in chart.series.iter().enumerate() {
        let mut points = Vec::with_capacity(series.values.len());
        for (i, value) in series.values.iter().copied().enumerate() {
            let plotted = if stacked {
                cumulative[i] += value.max(0.0);
                if percent {
                    let total = category_positive_sum(chart, i);
                    if total > 0.0 {
                        cumulative[i] / total * 100.0
                    } else {
                        0.0
                    }
                } else {
                    cumulative[i]
                }
            } else {
                value
            };
            let t = ((plotted - vmin) / (vmax - vmin).max(1e-9)).clamp(0.0, 1.0);
            points.push((px + span * (i as f64 + 0.5), py + ph * (1.0 - t)));
        }
        if points.is_empty() {
            continue;
        }
        let color = series_color(series, si);
        let lower_boundary = if stacked {
            previous_boundary.as_slice()
        } else {
            &[]
        };
        let mut d = if let Some(first) = lower_boundary.first() {
            format!(
                "M{:.2},{:.2} L{:.2},{:.2}",
                first.0, first.1, points[0].0, points[0].1
            )
        } else {
            format!(
                "M{:.2},{:.2} L{:.2},{:.2}",
                points[0].0, baseline_y, points[0].0, points[0].1
            )
        };
        for point in points.iter().skip(1) {
            d.push_str(&format!(" L{:.2},{:.2}", point.0, point.1));
        }
        if stacked {
            for point in lower_boundary.iter().rev() {
                d.push_str(&format!(" L{:.2},{:.2}", point.0, point.1));
            }
        } else {
            d.push_str(&format!(
                " L{:.2},{:.2}",
                points.last().unwrap().0,
                baseline_y
            ));
        }
        d.push_str(" Z");
        svg.push_str(&format!(
            "<path class=\"hwp-chart-area-series\" d=\"{d}\" fill=\"{color}\" fill-opacity=\"0.55\" stroke=\"{color}\" stroke-width=\"1.5\"/>\n"
        ));
        if stacked {
            previous_boundary = points;
        }
    }
    render_category_labels(svg, chart, px, py, pw, ph, count, false);
}

// ---------------- Radar ----------------

fn render_radar(svg: &mut String, chart: &OoxmlChart, px: f64, py: f64, pw: f64, ph: f64) {
    let count = chart.categories.len().max(
        chart
            .series
            .iter()
            .map(|s| s.values.len())
            .max()
            .unwrap_or(0),
    );
    if count < 3 {
        return render_line(svg, chart, px, py, pw, ph);
    }
    let cx = px + pw / 2.0;
    let cy = py + ph / 2.0;
    let radius = pw.min(ph) * 0.38;
    let (_, vmax, _) = value_range(chart, VERTICAL_AXIS_TICKS);
    let angle =
        |i: usize| -std::f64::consts::FRAC_PI_2 + std::f64::consts::TAU * i as f64 / count as f64;
    for ring in 1..=5 {
        let rr = radius * ring as f64 / 5.0;
        let points: Vec<(f64, f64)> = (0..count)
            .map(|i| (cx + rr * angle(i).cos(), cy + rr * angle(i).sin()))
            .collect();
        svg.push_str(&format!(
            "<path class=\"hwp-chart-radar-grid\" d=\"{} Z\" fill=\"none\" stroke=\"#dddddd\" stroke-width=\"0.75\"/>\n",
            polyline_path(&points)
        ));
    }
    for i in 0..count {
        let a = angle(i);
        let x = cx + radius * a.cos();
        let y = cy + radius * a.sin();
        svg.push_str(&format!(
            "<line x1=\"{cx:.2}\" y1=\"{cy:.2}\" x2=\"{x:.2}\" y2=\"{y:.2}\" stroke=\"#dddddd\" stroke-width=\"0.75\"/>\n"
        ));
        let label = chart.categories.get(i).map(String::as_str).unwrap_or("");
        svg.push_str(&format!(
            "<text x=\"{:.2}\" y=\"{:.2}\" font-family=\"sans-serif\" font-size=\"10\" fill=\"#333\" text-anchor=\"middle\">{}</text>\n",
            cx + radius * 1.14 * a.cos(),
            cy + radius * 1.14 * a.sin() + 3.0,
            xml_escape(label)
        ));
    }
    for (si, series) in chart.series.iter().enumerate() {
        let points: Vec<(f64, f64)> = (0..count)
            .map(|i| {
                let rr =
                    radius * series.values.get(i).copied().unwrap_or(0.0).max(0.0) / vmax.max(1e-9);
                (cx + rr * angle(i).cos(), cy + rr * angle(i).sin())
            })
            .collect();
        let color = series_color(series, si);
        let fill = if chart.radar_style == RadarStyle::Filled {
            color.as_str()
        } else {
            "none"
        };
        let opacity = if chart.radar_style == RadarStyle::Filled {
            0.35
        } else {
            1.0
        };
        svg.push_str(&format!(
            "<path class=\"hwp-chart-radar-series\" d=\"{} Z\" fill=\"{fill}\" fill-opacity=\"{opacity}\" stroke=\"{color}\" stroke-width=\"2\"/>\n",
            polyline_path(&points)
        ));
        if chart.radar_style == RadarStyle::Marker {
            for (x, y) in points {
                push_marker(svg, "hwp-chart-marker", si, x, y, 3.5, &color);
            }
        }
    }
}

// ---------------- Stock (주식형, hiLowLines/upDownBars) ----------------

/// stock (주식형). 계열 역할 = XML 순서 규약: 3계열=고/저/종, 4계열=시/고/저/종
/// (코퍼스 실측 — 그 외 계열 수는 render_line 폴백으로 placeholder 재발 방지).
/// 정답지 정합: 검정 고저선 + (OHLC) 시가↔종가 캔들(하락=진회색 채움/상승=흰
/// 채움+검정 테두리) + 종가 마커(마커 사이클·팔레트 폴백이 ▲회색/×노랑을 자동
/// 결정 — 시/고/저는 `c:symbol val="none"`이라 무마커). (C2a #2277)
fn render_stock(svg: &mut String, chart: &OoxmlChart, px: f64, py: f64, pw: f64, ph: f64) {
    let (hi_i, lo_i, close_i, open_i) = match chart.series.len() {
        3 => (0usize, 1usize, 2usize, None),
        4 => (1, 2, 3, Some(0usize)),
        _ => return render_line(svg, chart, px, py, pw, ph),
    };
    let cat_count = chart.categories.len().max(
        chart
            .series
            .iter()
            .map(|s| s.values.len())
            .max()
            .unwrap_or(0),
    );
    if cat_count == 0 {
        return;
    }

    // 값축: stock 전용 무조건 +1 step 헤드룸 — 정답지 실측 max 59 → 0~80 step 20.
    // nice_axis의 경계 조건부 +1로는 0~60이라 부족. 3D 누적세로(+1 step)와 동형 패턴.
    let (raw_min, raw_max) = raw_value_bounds(chart.series.iter());
    let (vmin, mx, vstep) = nice_axis_no_headroom(raw_min, raw_max, VERTICAL_AXIS_TICKS);
    let vmax = mx + vstep;

    svg.push_str(&format!(
        "<rect x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" fill=\"#ffffff\" stroke=\"#cccccc\" stroke-width=\"0.5\"/>\n",
        px, py, pw, ph
    ));
    render_value_grid(
        svg,
        px,
        py,
        pw,
        ph,
        vmin,
        vmax,
        vstep,
        chart.series.first().and_then(|s| s.format_code.as_deref()),
        false,
        false,
        false,
        false,
    );

    let y_of = |v: f64| -> f64 {
        let t = if vmax > vmin {
            (v - vmin) / (vmax - vmin)
        } else {
            0.0
        };
        py + ph - ph * t
    };
    let val = |si: usize, ci: usize| -> Option<f64> {
        chart.series.get(si).and_then(|s| s.values.get(ci)).copied()
    };
    let cat_span = pw / cat_count as f64;
    // 캔들 폭 = cat_span / (1 + gapWidth/100) — 정답지 gapWidth=150 → 슬롯의 40%
    let gap = chart.up_down_gap_width.unwrap_or(150.0).max(0.0);
    let candle_w = cat_span / (1.0 + gap / 100.0);

    for ci in 0..cat_count {
        let x = px + cat_span * (ci as f64 + 0.5);
        if chart.has_hi_low_lines {
            if let (Some(hi), Some(lo)) = (val(hi_i, ci), val(lo_i, ci)) {
                svg.push_str(&format!(
                    "<line class=\"hwp-stock-hilow\" x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" stroke=\"#000000\" stroke-width=\"1\"/>\n",
                    x,
                    y_of(hi),
                    x,
                    y_of(lo)
                ));
            }
        }
        if chart.has_up_down_bars {
            if let (Some(open), Some(close)) = (open_i.and_then(|oi| val(oi, ci)), val(close_i, ci))
            {
                let top = y_of(open.max(close));
                let bot = y_of(open.min(close));
                // 하락(종<시)=진회색 채움(#404040 근사 — 시각판정에서 픽셀 실측 확정),
                // 상승·동률=흰 채움+검정 테두리 (동률은 미실측 — 상승 처리 고정).
                let (fill, stroke) = if close < open {
                    ("#404040", "none")
                } else {
                    ("#ffffff", "#000000")
                };
                svg.push_str(&format!(
                    "<rect class=\"hwp-stock-candle\" x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" fill=\"{}\" stroke=\"{}\" stroke-width=\"1\"/>\n",
                    x - candle_w / 2.0,
                    top,
                    candle_w,
                    (bot - top).max(0.5),
                    fill,
                    stroke
                ));
            }
        }
    }

    // 마커: Auto/Named 계열만 (코퍼스 = 종가만 Auto). 고저선/캔들 위에 그린다.
    for (si, ser) in chart.series.iter().enumerate() {
        if !matches!(
            ser.marker_symbol,
            SeriesMarker::Auto | SeriesMarker::Named(_)
        ) {
            continue;
        }
        let color = series_color(ser, si);
        for (ci, &v) in ser.values.iter().enumerate() {
            let x = px + cat_span * (ci as f64 + 0.5);
            push_marker(svg, "hwp-chart-marker", si, x, y_of(v), 3.5, &color);
        }
    }

    render_category_labels(svg, chart, px, py, pw, ph, cat_count, false);
}

// ---------------- Scatter (분산형, 2 수치축) ----------------

fn render_scatter(svg: &mut String, chart: &OoxmlChart, px: f64, py: f64, pw: f64, ph: f64) {
    // 전 시리즈가 (x,y) 쌍을 못 만들면 격자도 의미 없음 → 조기 종료.
    // (상위 <g class="hwp-ooxml-chart">는 이미 출력되어 placeholder는 안 뜸)
    if chart
        .series
        .iter()
        .all(|s| s.x_values.is_empty() || s.values.is_empty())
    {
        return;
    }

    let (xmin, xmax, xstep) =
        scatter_range(chart.series.iter().flat_map(|s| s.x_values.iter().copied()));
    let (ymin, ymax, ystep) =
        scatter_range(chart.series.iter().flat_map(|s| s.values.iter().copied()));
    let xspan = (xmax - xmin).max(1e-9);
    let yspan = (ymax - ymin).max(1e-9);

    // 플롯 배경
    svg.push_str(&format!(
        "<rect x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" fill=\"#ffffff\" stroke=\"#cccccc\" stroke-width=\"0.5\"/>\n",
        px, py, pw, ph
    ));
    // X축(하단, 수직 격자선) + Y축(좌측, 수평 격자선) — 둘 다 수치축, 소수 라벨
    render_value_grid(
        svg, px, py, pw, ph, xmin, xmax, xstep, None, true, false, false, true,
    );
    render_value_grid(
        svg, px, py, pw, ph, ymin, ymax, ystep, None, false, false, false, true,
    );

    let (show_line, smooth, show_markers) = chart.scatter_style.flags();

    for (si, ser) in chart.series.iter().enumerate() {
        let color = series_color(ser, si);
        // (x,y) 픽셀 좌표. 데이터 순서 유지(x 정렬 안 함), 길이 불일치 시 짧은 쪽으로 절단.
        let points: Vec<(f64, f64)> = ser
            .x_values
            .iter()
            .zip(ser.values.iter())
            .map(|(&x, &y)| {
                (
                    px + pw * (x - xmin) / xspan,
                    py + ph - ph * (y - ymin) / yspan,
                )
            })
            .collect();
        if points.is_empty() {
            continue;
        }

        if show_line && points.len() >= 2 {
            let d = if smooth {
                smooth_path(&points)
            } else {
                polyline_path(&points)
            };
            svg.push_str(&format!(
                "<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"2\"/>\n",
                d, color
            ));
        }
        if show_markers {
            // 계열 사이클 글리프 ◆■▲× — 정답지 실측(표식만있는분산형: 계열1 ◆/계열2 ■).
            // 반경 4.5 = 라인(3.5)보다 큰 실측 근사, 시각판정 조정 여지. (C2a #2277)
            for &(xp, yp) in &points {
                push_marker(svg, "hwp-chart-marker", si, xp, yp, 4.5, &color);
            }
        }
    }
}

/// 마커 경로. 계열 인덱스 사이클 ◆■▲× — 한컴 기본 (정답지 실측: 라인 ◆■▲
/// C1d #2129, OHLC 종가 ×·scatter ◆■ C2a #2277). 반환 `(d, stroke 기반 여부)` —
/// ×는 채움 없는 열린 경로라 stroke=계열색으로 그린다. `r`=명목 반경, ■/×는
/// 하프폭 `r-0.5` (종전 ◆3.5/■3.0 비율 유지 — 출력 바이트 보존).
fn marker_path(si: usize, cx: f64, cy: f64, r: f64) -> (String, bool) {
    let h = r - 0.5;
    match si % 4 {
        0 => (
            // ◆ 다이아몬드
            format!(
                "M{:.2},{:.2} L{:.2},{:.2} L{:.2},{:.2} L{:.2},{:.2} Z",
                cx,
                cy - r,
                cx + r,
                cy,
                cx,
                cy + r,
                cx - r,
                cy
            ),
            false,
        ),
        1 => (
            // ■ 정사각형
            format!(
                "M{:.2},{:.2} L{:.2},{:.2} L{:.2},{:.2} L{:.2},{:.2} Z",
                cx - h,
                cy - h,
                cx + h,
                cy - h,
                cx + h,
                cy + h,
                cx - h,
                cy + h
            ),
            false,
        ),
        2 => (
            // ▲ 삼각형
            format!(
                "M{:.2},{:.2} L{:.2},{:.2} L{:.2},{:.2} Z",
                cx,
                cy - r,
                cx + r,
                cy + r * 0.8,
                cx - r,
                cy + r * 0.8
            ),
            false,
        ),
        _ => (
            // × 두 대각선 열린 경로 — OHLC 종가 정답지 실측 (C2a #2277, 종전 원 폴백 교체)
            format!(
                "M{:.2},{:.2} L{:.2},{:.2} M{:.2},{:.2} L{:.2},{:.2}",
                cx - h,
                cy - h,
                cx + h,
                cy + h,
                cx + h,
                cy - h,
                cx - h,
                cy + h
            ),
            true,
        ),
    }
}

/// 마커 1개 방출. 채움형(◆■▲)=fill 계열색+흰 테두리, stroke 기반(×)=fill 없이
/// stroke 계열색. `class`로 데이터 마커("hwp-chart-marker")와 범례 글리프
/// ("hwp-legend-glyph", 4단계)를 구분 — issue_2129 마커 카운트 오염 방지. (C2a #2277)
fn push_marker(svg: &mut String, class: &str, si: usize, cx: f64, cy: f64, r: f64, color: &str) {
    let (d, stroke_based) = marker_path(si, cx, cy, r);
    if stroke_based {
        svg.push_str(&format!(
            "<path class=\"{}\" d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"1.5\"/>\n",
            class, d, color
        ));
    } else {
        svg.push_str(&format!(
            "<path class=\"{}\" d=\"{}\" fill=\"{}\" stroke=\"#ffffff\" stroke-width=\"1\"/>\n",
            class, d, color
        ));
    }
}

/// 라인 차트 표식(마커) — `marker_path` 사이클, 반경 3.5(정답지 근사, 시각판정
/// 조정 여지). (C1d #2129)
fn push_line_marker(svg: &mut String, si: usize, cx: f64, cy: f64, color: &str) {
    push_marker(svg, "hwp-chart-marker", si, cx, cy, 3.5, color);
}

/// 직선 폴리라인 path (`M…L…`).
fn polyline_path(points: &[(f64, f64)]) -> String {
    let mut d = String::new();
    for (i, (x, y)) in points.iter().enumerate() {
        d.push_str(&format!(
            "{}{:.2},{:.2} ",
            if i == 0 { "M" } else { "L" },
            x,
            y
        ));
    }
    d.trim().to_string()
}

/// Catmull-Rom → cubic Bézier 곡선 path. 데이터 순서, 끝점 clamp(P₋₁=P₀, Pₙ=Pₙ₋₁). — C1b #1660.
fn smooth_path(points: &[(f64, f64)]) -> String {
    let n = points.len();
    if n < 2 {
        return polyline_path(points);
    }
    let mut d = format!("M{:.2},{:.2}", points[0].0, points[0].1);
    for i in 0..n - 1 {
        let p0 = if i == 0 { points[0] } else { points[i - 1] };
        let p1 = points[i];
        let p2 = points[i + 1];
        let p3 = if i + 2 >= n {
            points[n - 1]
        } else {
            points[i + 2]
        };
        let c1 = (p1.0 + (p2.0 - p0.0) / 6.0, p1.1 + (p2.1 - p0.1) / 6.0);
        let c2 = (p2.0 - (p3.0 - p1.0) / 6.0, p2.1 - (p3.1 - p1.1) / 6.0);
        d.push_str(&format!(
            " C{:.2},{:.2} {:.2},{:.2} {:.2},{:.2}",
            c1.0, c1.1, c2.0, c2.1, p2.0, p2.1
        ));
    }
    d
}

// ---------------- Pie ----------------

fn render_pie(svg: &mut String, chart: &OoxmlChart, px: f64, py: f64, pw: f64, ph: f64) {
    let first = match chart.series.first() {
        Some(s) => s,
        None => return,
    };
    let total: f64 = first
        .values
        .iter()
        .copied()
        .filter(|value| value.is_finite() && *value > 0.0)
        .sum();
    if !total.is_finite() || total <= 0.0 {
        return;
    }
    let cx = px + pw / 2.0;
    let cy = py + ph / 2.0;
    // 쪼개진원형: 계열 explosion(%)만큼 슬라이스를 중심각 방향으로 이동 —
    // 벌어진 extent(r×(1+e))가 기존 fit과 같도록 반지름 축소. explosion 부재
    // (e=0) 시 기존 산식·출력 그대로. (C2b #2278 Stage 3 v3, 정답지 쪼개진원형)
    let explode = first.explosion.unwrap_or(0.0).max(0.0) / 100.0;
    let r = (pw.min(ph) / 2.0) * 0.9 / (1.0 + explode);

    let mut start_angle = -std::f64::consts::FRAC_PI_2;
    let positive_count = first
        .values
        .iter()
        .filter(|value| value.is_finite() && **value > 0.0)
        .count();
    for (i, &v) in first.values.iter().enumerate() {
        let value = if v.is_finite() { v.max(0.0) } else { 0.0 };
        if value == 0.0 {
            continue;
        }
        let sweep = value / total * std::f64::consts::TAU;
        let end_angle = start_angle + sweep;
        let mid = start_angle + sweep / 2.0;
        let (ox, oy) = (cx + r * explode * mid.cos(), cy + r * explode * mid.sin());
        let color = color_hex(first.color.unwrap_or_else(|| palette(i)));
        if positive_count == 1 {
            svg.push_str(&format!(
                "<circle class=\"hwp-chart-pie-slice\" cx=\"{ox:.2}\" cy=\"{oy:.2}\" r=\"{r:.2}\" fill=\"{color}\"/>\n"
            ));
            start_angle = end_angle;
            continue;
        }
        let (x1, y1) = (ox + r * start_angle.cos(), oy + r * start_angle.sin());
        let (x2, y2) = (ox + r * end_angle.cos(), oy + r * end_angle.sin());
        let large = if sweep > std::f64::consts::PI { 1 } else { 0 };
        svg.push_str(&format!(
            "<path d=\"M{:.2},{:.2} L{:.2},{:.2} A{:.2},{:.2} 0 {} 1 {:.2},{:.2} Z\" fill=\"{}\"/>\n",
            ox, oy, x1, y1, r, r, large, x2, y2, color
        ));
        start_angle = end_angle;
    }
}

fn render_doughnut(svg: &mut String, chart: &OoxmlChart, px: f64, py: f64, pw: f64, ph: f64) {
    render_pie(svg, chart, px, py, pw, ph);
    let outer = pw.min(ph) * 0.45;
    let inner = outer * chart.doughnut_hole_size.unwrap_or(50.0).clamp(10.0, 90.0) / 100.0;
    svg.push_str(&format!(
        "<circle class=\"hwp-chart-doughnut-hole\" cx=\"{:.2}\" cy=\"{:.2}\" r=\"{inner:.2}\" fill=\"#ffffff\"/>\n",
        px + pw / 2.0,
        py + ph / 2.0,
    ));
}

fn render_axis_titles(svg: &mut String, chart: &OoxmlChart, px: f64, py: f64, pw: f64, ph: f64) {
    if let Some(title) = chart.category_axis_title.as_deref() {
        svg.push_str(&format!(
            "<text class=\"hwp-chart-axis-title hwp-chart-category-axis-title\" x=\"{:.2}\" y=\"{:.2}\" font-family=\"sans-serif\" font-size=\"11\" fill=\"#333\" text-anchor=\"middle\">{}</text>\n",
            px + pw / 2.0,
            py + ph + 24.0,
            xml_escape(title)
        ));
    }
    if let Some(title) = chart.primary_value_axis_title.as_deref() {
        svg.push_str(&format!(
            "<text class=\"hwp-chart-axis-title hwp-chart-primary-axis-title\" x=\"{:.2}\" y=\"{:.2}\" transform=\"rotate(-90 {:.2} {:.2})\" font-family=\"sans-serif\" font-size=\"11\" fill=\"#333\" text-anchor=\"middle\">{}</text>\n",
            px - 30.0,
            py + ph / 2.0,
            px - 30.0,
            py + ph / 2.0,
            xml_escape(title)
        ));
    }
    if let Some(title) = chart.secondary_value_axis_title.as_deref() {
        svg.push_str(&format!(
            "<text class=\"hwp-chart-axis-title hwp-chart-secondary-axis-title\" x=\"{:.2}\" y=\"{:.2}\" transform=\"rotate(90 {:.2} {:.2})\" font-family=\"sans-serif\" font-size=\"11\" fill=\"#333\" text-anchor=\"middle\">{}</text>\n",
            px + pw + 30.0,
            py + ph / 2.0,
            px + pw + 30.0,
            py + ph / 2.0,
            xml_escape(title)
        ));
    }
}

fn render_data_labels(svg: &mut String, chart: &OoxmlChart, px: f64, py: f64, pw: f64, ph: f64) {
    let options = chart.data_labels;
    if !(options.show_value || options.show_category_name || options.show_series_name) {
        return;
    }
    if matches!(
        chart.chart_type,
        OoxmlChartType::Pie | OoxmlChartType::Doughnut
    ) {
        let Some(series) = chart.series.first() else {
            return;
        };
        let total: f64 = series
            .values
            .iter()
            .copied()
            .filter(|value| value.is_finite() && *value > 0.0)
            .sum();
        if !total.is_finite() || total <= 0.0 {
            return;
        }
        let (cx, cy) = (px + pw / 2.0, py + ph / 2.0);
        let radius = pw.min(ph) * 0.32;
        let mut start = -std::f64::consts::FRAC_PI_2;
        for (i, value) in series.values.iter().copied().enumerate() {
            if !value.is_finite() || value <= 0.0 {
                continue;
            }
            let sweep = value / total * std::f64::consts::TAU;
            let mid = start + sweep / 2.0;
            push_data_label(
                svg,
                chart,
                series,
                i,
                value,
                cx + radius * mid.cos(),
                cy + radius * mid.sin(),
            );
            start += sweep;
        }
        return;
    }
    if matches!(
        chart.chart_type,
        OoxmlChartType::Radar | OoxmlChartType::Scatter
    ) {
        return;
    }
    let count = chart
        .series
        .iter()
        .map(|s| s.values.len())
        .max()
        .unwrap_or(0);
    if count == 0 {
        return;
    }
    let (vmin, vmax, _) = value_range(chart, VERTICAL_AXIS_TICKS);
    let cat_span = pw / count as f64;
    for (si, series) in chart.series.iter().enumerate() {
        for (i, value) in series.values.iter().copied().enumerate() {
            let x = px
                + cat_span * (i as f64 + 0.5)
                + (si as f64 - (chart.series.len().saturating_sub(1)) as f64 / 2.0) * 4.0;
            let y = py + ph - ph * (value - vmin) / (vmax - vmin).max(1e-9) - 4.0;
            push_data_label(svg, chart, series, i, value, x, y);
        }
    }
}

fn push_data_label(
    svg: &mut String,
    chart: &OoxmlChart,
    series: &OoxmlSeries,
    point_index: usize,
    value: f64,
    x: f64,
    y: f64,
) {
    let mut parts = Vec::new();
    if chart.data_labels.show_series_name && !series.name.is_empty() {
        parts.push(series.name.clone());
    }
    if chart.data_labels.show_category_name {
        if let Some(category) = chart.categories.get(point_index) {
            parts.push(category.clone());
        }
    }
    if chart.data_labels.show_value {
        parts.push(format_num(value, series.format_code.as_deref()));
    }
    if parts.is_empty() {
        return;
    }
    svg.push_str(&format!(
        "<text class=\"hwp-chart-data-label\" x=\"{x:.2}\" y=\"{y:.2}\" font-family=\"sans-serif\" font-size=\"9\" fill=\"#222\" text-anchor=\"middle\">{}</text>\n",
        xml_escape(&parts.join(" "))
    ));
}

/// ofPie — 주 원(앞 n−k 카테고리 + 결합 슬라이스) + 보조 플롯(pie|bar) + serLines.
/// k = split_pos(반올림, 1..=n−1 클램프) 없으면 2. n < 3 → 일반 원형 폴백.
/// 주 원은 결합 슬라이스 중앙이 보조 플롯(3시 방향)을 향하도록 회전. 결합 슬라이스
/// 색 = palette(n)(정답지 실측 초록계 [4]), 보조 플롯 색 = palette(n−k+j)
/// (범례의 카테고리 정순 색과 일치). (C2b #2278 Stage 3)
fn render_of_pie(
    svg: &mut String,
    chart: &OoxmlChart,
    of: &OfPieInfo,
    px: f64,
    py: f64,
    pw: f64,
    ph: f64,
) {
    use std::f64::consts::TAU;
    let first = match chart.series.first() {
        Some(s) => s,
        None => return,
    };
    let n = first.values.len();
    if n < 3 {
        render_pie(svg, chart, px, py, pw, ph);
        return;
    }
    let total: f64 = first.values.iter().sum();
    if total <= 0.0 {
        return;
    }
    // splitPos 의 count 해석은 splitType=pos(및 미지정 auto — 종전 코퍼스 정책
    // 보존)에만 유효. val/percent/cust 는 값·백분율·점별 임계라 count 로 읽으면
    // 오분할 — splitPos 를 무시하고 기본 2로 폴백한다. (PR #2500 후속)
    let split_pos_as_count = matches!(
        of.split_type,
        super::OfPieSplitType::Auto | super::OfPieSplitType::Pos
    );
    let k = of
        .split_pos
        .filter(|_| split_pos_as_count)
        .map(|v| (v.round() as usize).clamp(1, n - 1))
        .unwrap_or(2)
        .min(n - 1);
    let combined: f64 = first.values[n - k..].iter().sum();

    // 레이아웃 — 정답지(원형대원형-2022 임베드 2702×1577) 픽셀 실측 캘리브레이션:
    // 주 원 중심 x≈0.23·플롯폭, 보조 중심 x≈0.80, r1≈0.38·플롯높이(가로는 캡),
    // r2/r1 실측 0.754 = secondPieSize(75)/100 ✓ (스키마 의미 그대로)
    let cx1 = px + pw * 0.23;
    let cy = py + ph / 2.0;
    let r1 = (pw * 0.46).min(ph * 0.76) / 2.0;
    let cx2 = px + pw * 0.80;
    let r2 = r1 * (of.second_pie_size.max(0.0) / 100.0);

    // 주 원 — 값 시퀀스 = values[..n−k] + [combined]. 결합 슬라이스 중앙이 3시(θ=0)
    let sweep_c = combined / total * TAU;
    let start_main = -sweep_c / 2.0 - (total - combined) / total * TAU;
    let main_vals: Vec<(f64, u32)> = first.values[..n - k]
        .iter()
        .enumerate()
        .map(|(ci, &v)| (v, first.color.unwrap_or_else(|| palette(ci))))
        .chain(std::iter::once((
            combined,
            first.color.unwrap_or_else(|| palette(n)),
        )))
        .collect();
    let mut start_angle = start_main;
    for (v, rgb) in &main_vals {
        let sweep = v / total * TAU;
        let end_angle = start_angle + sweep;
        let (x1, y1) = (cx1 + r1 * start_angle.cos(), cy + r1 * start_angle.sin());
        let (x2, y2) = (cx1 + r1 * end_angle.cos(), cy + r1 * end_angle.sin());
        let large = if sweep > std::f64::consts::PI { 1 } else { 0 };
        svg.push_str(&format!(
            "<path class=\"hwp-ofpie-main\" d=\"M{:.2},{:.2} L{:.2},{:.2} A{:.2},{:.2} 0 {} 1 {:.2},{:.2} Z\" fill=\"{}\"/>\n",
            cx1, cy, x1, y1, r1, r1, large, x2, y2, color_hex(*rgb)
        ));
        start_angle = end_angle;
    }

    if combined > 0.0 {
        match of.of_pie_type {
            OfPieType::Pie => {
                // 보조 원 — 시작각 = +sweep_c/2 (결합 슬라이스 아래 모서리 각도와
                // 정렬, 정답지 실측 경계 26°≈유도 30°; 12시 시작 아님)
                let mut s = sweep_c / 2.0;
                for (j, &v) in first.values[n - k..].iter().enumerate() {
                    let sweep = v / combined * TAU;
                    let e = s + sweep;
                    let (x1, y1) = (cx2 + r2 * s.cos(), cy + r2 * s.sin());
                    let (x2, y2) = (cx2 + r2 * e.cos(), cy + r2 * e.sin());
                    let large = if sweep > std::f64::consts::PI { 1 } else { 0 };
                    let rgb = first.color.unwrap_or_else(|| palette(n - k + j));
                    svg.push_str(&format!(
                        "<path class=\"hwp-ofpie-second\" d=\"M{:.2},{:.2} L{:.2},{:.2} A{:.2},{:.2} 0 {} 1 {:.2},{:.2} Z\" fill=\"{}\"/>\n",
                        cx2, cy, x1, y1, r2, r2, large, x2, y2, color_hex(rgb)
                    ));
                    s = e;
                }
            }
            OfPieType::Bar => {
                // 보조 누적 막대 — 첫 분할 카테고리가 맨 위, 위→아래 누적
                let bar_h = 2.0 * r2;
                let bar_w = bar_h * 0.45;
                let bx = cx2 - bar_w / 2.0;
                let top = cy - bar_h / 2.0;
                let mut acc = 0.0;
                for (j, &v) in first.values[n - k..].iter().enumerate() {
                    let seg = v / combined * bar_h;
                    let rgb = first.color.unwrap_or_else(|| palette(n - k + j));
                    svg.push_str(&format!(
                        "<rect class=\"hwp-ofpie-second\" x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" fill=\"{}\"/>\n",
                        bx,
                        top + acc,
                        bar_w,
                        seg,
                        color_hex(rgb)
                    ));
                    acc += seg;
                }
            }
        }

        // serLines — 결합 슬라이스 양 모서리 → 보조 플롯. 색은 검정(정답지 실측
        // 코어 (8,8,8)). Pie는 보조 원 **접선점**(실측: 원 상/하단 아님 —
        // 모서리에서 원에 접하는 선), Bar는 막대 좌변 상/하단.
        if of.has_ser_lines {
            let (ux, uy) = (
                cx1 + r1 * (-sweep_c / 2.0).cos(),
                cy + r1 * (-sweep_c / 2.0).sin(),
            );
            let (lx, ly) = (
                cx1 + r1 * (sweep_c / 2.0).cos(),
                cy + r1 * (sweep_c / 2.0).sin(),
            );
            // 외부점 P → 원(cx2, cy, r2) 접점: 중심→P 각 α, β=acos(r2/d), α±β 중
            // 위 연결선은 위쪽(작은 y) 접점 선택. d ≤ r2 퇴화 시 원 좌측점 폴백.
            let tangent = |pxp: f64, pyp: f64, upper: bool| -> (f64, f64) {
                let (dx, dy) = (pxp - cx2, pyp - cy);
                let d = (dx * dx + dy * dy).sqrt();
                if d <= r2 {
                    return (cx2 - r2, cy);
                }
                let alpha = dy.atan2(dx);
                let beta = (r2 / d).acos();
                let p1 = (
                    cx2 + r2 * (alpha + beta).cos(),
                    cy + r2 * (alpha + beta).sin(),
                );
                let p2 = (
                    cx2 + r2 * (alpha - beta).cos(),
                    cy + r2 * (alpha - beta).sin(),
                );
                if (p1.1 < p2.1) == upper {
                    p1
                } else {
                    p2
                }
            };
            let ((tx, ty), (bx2, by2)) = match of.of_pie_type {
                OfPieType::Pie => (tangent(ux, uy, true), tangent(lx, ly, false)),
                OfPieType::Bar => {
                    let bar_h = 2.0 * r2;
                    let bar_w = bar_h * 0.45;
                    let bx = cx2 - bar_w / 2.0;
                    ((bx, cy - r2), (bx, cy + r2))
                }
            };
            for ((x1, y1), (x2, y2)) in [((ux, uy), (tx, ty)), ((lx, ly), (bx2, by2))] {
                svg.push_str(&format!(
                    "<line class=\"hwp-ofpie-serline\" x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" stroke=\"#000000\" stroke-width=\"0.75\"/>\n",
                    x1, y1, x2, y2
                ));
            }
        }
    }
}

/// 3D 원형 측벽 높이 / rx — 정답지(3차원원형-2022, rotX=30/persp=30) 픽셀 실측
/// 175px/846.5px. 한컴 스펙 표 43 Pie.ThicknessRatio(반지름의 백분율) 구조 채택,
/// 비율값은 실측 캘리브레이션. hPercent(기본 100)로 스케일.
const PIE3D_WALL_RATIO: f64 = 0.207;

/// 3D 원형 — 타원(top) 슬라이스 + 하반부 측벽 밴드 (rAngAx=0 회전+원근).
///
/// 타원비 `ry/rx = sin(rotX)·cos(perspective/2°)` — 정답지 실측 0.480과 유도
/// 0.483이 0.5% 이내 정합(캘리브레이션 1점). 앞/뒤 반타원이 실측 대칭(407.5px
/// 동일)이라 원근 나눗셈(비대칭) 모델은 기각 — 대칭 타원 유지. rotY는 시작각
/// 오프셋. 벽 전체를 먼저, top을 나중에 그린다(은면 제거 — 페인트 순서).
/// 2D `render_pie`는 무접촉(바이트 불변). (C2b #2278 Stage 2)
fn render_pie_3d(svg: &mut String, chart: &OoxmlChart, px: f64, py: f64, pw: f64, ph: f64) {
    let first = match chart.series.first() {
        Some(s) => s,
        None => return,
    };
    let total: f64 = first.values.iter().sum();
    if total <= 0.0 {
        return;
    }
    let view = chart.view3d.clone().unwrap_or_default();
    // 정의역 방어: rotX 5..90 클램프(0° 타원 퇴화 차단), perspective 0..90 클램프
    // (perspective/2 > 90° → cos 음수 차단) — 코퍼스(30/30) 밖 카메라 방어
    let tilt = view.rot_x.clamp(5.0, 90.0).to_radians().sin();
    let persp = (view.perspective.clamp(0.0, 90.0) / 2.0).to_radians().cos();
    let ratio = tilt * persp;
    let wall_k = PIE3D_WALL_RATIO * (view.h_percent.max(0.0) / 100.0);
    // 반경: 타원+벽 블록(가로 2rx, 세로 (2·타원비+벽비)·rx)이 플롯에 맞는 최대 —
    // 2D의 원 fit(min(pw,ph))과 달리 납작한 타원의 세로 여유를 사용 (한컴 실측:
    // rx=846.5 ≈ 플롯 절반폭 × 0.85, 세로는 비구속)
    let rx = (pw / 2.0).min(ph / (2.0 * ratio + wall_k).max(1e-6)) * 0.9;
    let ry = rx * ratio;
    let wall_h = rx * wall_k;
    let cx = px + pw / 2.0;
    let cy = py + (ph - wall_h) / 2.0;

    use std::f64::consts::{FRAC_PI_2, PI, TAU};
    let start0 = -FRAC_PI_2 + view.rot_y.to_radians();

    // 1차 루프 — 하반부(θ∈(0,π), SVG y-down에서 벽 노출면) 측벽. rotY 오프셋으로
    // 각도가 τ를 넘을 수 있어 (0,π)와 (τ,τ+π) 두 윈도우 클립 — 랩어라운드 불요.
    let mut s = start0;
    for (i, &v) in first.values.iter().enumerate() {
        let e = s + v / total * TAU;
        let rgb = first.color.unwrap_or_else(|| palette(i));
        for (w0, w1) in [(0.0, PI), (TAU, TAU + PI)] {
            let a = s.max(w0);
            let b = e.min(w1);
            if b - a > 1e-6 {
                let (xa, ya) = (cx + rx * a.cos(), cy + ry * a.sin());
                let (xb, yb) = (cx + rx * b.cos(), cy + ry * b.sin());
                svg.push_str(&format!(
                    "<path class=\"hwp-pie3d-wall\" d=\"M{:.2},{:.2} A{:.2},{:.2} 0 0 1 {:.2},{:.2} L{:.2},{:.2} A{:.2},{:.2} 0 0 0 {:.2},{:.2} Z\" fill=\"{}\"/>\n",
                    xa,
                    ya,
                    rx,
                    ry,
                    xb,
                    yb,
                    xb,
                    yb + wall_h,
                    rx,
                    ry,
                    xa,
                    ya + wall_h,
                    color_hex(shade(rgb, BAR3D_SIDE_SHADE))
                ));
            }
        }
        s = e;
    }

    // 2차 루프 — top 타원 슬라이스 (2D render_pie 로직의 타원호 버전)
    let mut start_angle = start0;
    for (i, &v) in first.values.iter().enumerate() {
        let sweep = v / total * TAU;
        let end_angle = start_angle + sweep;
        let (x1, y1) = (cx + rx * start_angle.cos(), cy + ry * start_angle.sin());
        let (x2, y2) = (cx + rx * end_angle.cos(), cy + ry * end_angle.sin());
        let large = if sweep > PI { 1 } else { 0 };
        let color = color_hex(first.color.unwrap_or_else(|| palette(i)));
        svg.push_str(&format!(
            "<path class=\"hwp-pie3d-top\" d=\"M{:.2},{:.2} L{:.2},{:.2} A{:.2},{:.2} 0 {} 1 {:.2},{:.2} Z\" fill=\"{}\"/>\n",
            cx, cy, x1, y1, rx, ry, large, x2, y2, color
        ));
        start_angle = end_angle;
    }
}

// ---------------- Combo + Dual Axis ----------------

fn render_combo(svg: &mut String, chart: &OoxmlChart, px: f64, py: f64, pw: f64, ph: f64) {
    let cat_count = chart.categories.len().max(
        chart
            .series
            .iter()
            .map(|s| s.values.len())
            .max()
            .unwrap_or(0),
    );
    if cat_count == 0 {
        return;
    }

    // 기본축/보조축 시리즈 분리
    let pri: Vec<&OoxmlSeries> = chart.series.iter().filter(|s| s.axis_group == 0).collect();
    let sec: Vec<&OoxmlSeries> = chart.series.iter().filter(|s| s.axis_group == 1).collect();

    let (pri_min, pri_max, pri_step) = if pri.is_empty() {
        value_range(chart, VERTICAL_AXIS_TICKS)
    } else {
        value_range_for(pri.iter().cloned(), VERTICAL_AXIS_TICKS)
    };
    let (sec_min, sec_max, sec_step) = if sec.is_empty() {
        (0.0, 1.0, 0.2)
    } else {
        value_range_for(sec.iter().cloned(), VERTICAL_AXIS_TICKS)
    };

    svg.push_str(&format!(
        "<rect x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" fill=\"#ffffff\" stroke=\"#cccccc\" stroke-width=\"0.5\"/>\n",
        px, py, pw, ph
    ));

    // 기본축 격자 (좌측)
    let pri_fmt = pri.first().and_then(|s| s.format_code.as_deref());
    render_value_grid(
        svg, px, py, pw, ph, pri_min, pri_max, pri_step, pri_fmt, false, false, false, false,
    );

    // 보조축 격자 (우측, 눈금만) — step 기반이라 기본축과 눈금 수가 다를 수 있음
    // (보조축은 라벨만 출력하므로 격자선 불일치 없음)
    if !sec.is_empty() {
        let sec_fmt = sec.first().and_then(|s| s.format_code.as_deref());
        render_value_grid(
            svg, px, py, pw, ph, sec_min, sec_max, sec_step, sec_fmt, false, true, false, false,
        );
    }

    // 막대 시리즈만 추려서 그룹화 렌더 (카테고리별 여러 바는 나란히)
    let bar_series: Vec<(usize, &OoxmlSeries)> = chart
        .series
        .iter()
        .enumerate()
        .filter(|(_, s)| matches!(s.series_type, OoxmlChartType::Column | OoxmlChartType::Bar))
        .collect();
    let line_series: Vec<(usize, &OoxmlSeries)> = chart
        .series
        .iter()
        .enumerate()
        .filter(|(_, s)| s.series_type == OoxmlChartType::Line)
        .collect();
    let area_series: Vec<(usize, &OoxmlSeries)> = chart
        .series
        .iter()
        .enumerate()
        .filter(|(_, s)| s.series_type == OoxmlChartType::Area)
        .collect();

    let cat_span = pw / cat_count as f64;
    // 막대 그룹 너비를 더 좁혀 라인이 바 양옆으로 가려지지 않게 함
    let bar_group_w = cat_span * 0.55;
    let bar_w = if bar_series.is_empty() {
        0.0
    } else {
        bar_group_w / bar_series.len() as f64
    };

    // Area plots are painted first so bars, lines, and markers remain legible
    // in mixed OOXML charts. Each series uses its assigned value axis.
    for (si, ser) in &area_series {
        if ser.values.is_empty() {
            continue;
        }
        let (vmin, vmax) = if ser.axis_group == 1 {
            (sec_min, sec_max)
        } else {
            (pri_min, pri_max)
        };
        let baseline = py + ph - ph * ((0.0 - vmin) / (vmax - vmin).max(1e-9)).clamp(0.0, 1.0);
        let mut points = Vec::with_capacity(ser.values.len());
        for (index, value) in ser.values.iter().copied().enumerate() {
            let t = ((value - vmin) / (vmax - vmin).max(1e-9)).clamp(0.0, 1.0);
            points.push((px + cat_span * (index as f64 + 0.5), py + ph * (1.0 - t)));
        }
        let color = series_color(ser, *si);
        let mut d = format!(
            "M{:.2},{baseline:.2} L{:.2},{:.2}",
            points[0].0, points[0].0, points[0].1
        );
        for point in points.iter().skip(1) {
            d.push_str(&format!(" L{:.2},{:.2}", point.0, point.1));
        }
        d.push_str(&format!(
            " L{:.2},{baseline:.2} Z",
            points.last().unwrap().0
        ));
        svg.push_str(&format!(
            "<path class=\"hwp-chart-area-series hwp-chart-combo-area-series\" d=\"{d}\" fill=\"{color}\" fill-opacity=\"0.35\" stroke=\"{color}\" stroke-width=\"1.5\"/>\n"
        ));
    }

    // 막대 렌더 (각 시리즈 축 기준)
    for ci in 0..cat_count {
        for (bi, (si, ser)) in bar_series.iter().enumerate() {
            let v = *ser.values.get(ci).unwrap_or(&0.0);
            let (vmin, vmax) = if ser.axis_group == 1 {
                (sec_min, sec_max)
            } else {
                (pri_min, pri_max)
            };
            let t = if vmax > vmin {
                (v - vmin) / (vmax - vmin)
            } else {
                0.0
            };
            let color = series_color(ser, *si);
            let cx = px + cat_span * ci as f64 + (cat_span - bar_group_w) / 2.0 + bar_w * bi as f64;
            let bh = ph * t;
            let by = py + ph - bh;
            svg.push_str(&format!(
                "<rect x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" fill=\"{}\"/>\n",
                cx,
                by,
                (bar_w * 0.95).max(0.0),
                bh.max(0.0),
                color
            ));
        }
    }

    // 라인 렌더 (각자 축 기준) — 바보다 항상 위에 그려지고, 데이터 포인트 마커까지 표시
    let step = if cat_count > 1 {
        pw / (cat_count - 1) as f64
    } else {
        pw
    };
    let line_x_offset = cat_span / 2.0;
    for (si, ser) in &line_series {
        let (vmin, vmax) = if ser.axis_group == 1 {
            (sec_min, sec_max)
        } else {
            (pri_min, pri_max)
        };
        let color = series_color(ser, *si);
        let mut d = String::new();
        let mut points: Vec<(f64, f64)> = Vec::new();
        for (i, &v) in ser.values.iter().enumerate() {
            let t = if vmax > vmin {
                (v - vmin) / (vmax - vmin)
            } else {
                0.0
            };
            let xp = if !bar_series.is_empty() {
                px + cat_span * i as f64 + line_x_offset
            } else {
                px + step * i as f64
            };
            let yp = py + ph - ph * t;
            d.push_str(&format!(
                "{}{:.2},{:.2} ",
                if i == 0 { "M" } else { "L" },
                xp,
                yp
            ));
            points.push((xp, yp));
        }
        // 라인: 3px + 흰색 외곽 1px (바와 겹쳐도 선명하게)
        svg.push_str(&format!(
            "<path d=\"{}\" fill=\"none\" stroke=\"#ffffff\" stroke-width=\"4\" stroke-linejoin=\"round\" stroke-linecap=\"round\"/>\n",
            d.trim()
        ));
        svg.push_str(&format!(
            "<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"2.5\" stroke-linejoin=\"round\" stroke-linecap=\"round\"/>\n",
            d.trim(), color
        ));
        // 데이터 포인트 마커
        for (xp, yp) in &points {
            svg.push_str(&format!(
                "<circle cx=\"{:.2}\" cy=\"{:.2}\" r=\"2.5\" fill=\"{}\" stroke=\"#ffffff\" stroke-width=\"1\"/>\n",
                xp, yp, color
            ));
        }
    }

    render_category_labels(svg, chart, px, py, pw, ph, cat_count, false);
}

// ---------------- 공통: 값 격자/라벨 ----------------

#[allow(clippy::too_many_arguments)]
fn render_value_grid(
    svg: &mut String,
    px: f64,
    py: f64,
    pw: f64,
    ph: f64,
    vmin: f64,
    vmax: f64,
    step: f64,
    format_code: Option<&str>,
    horizontal: bool,
    secondary: bool,
    percent: bool,
    decimal: bool,
) {
    // 비정수 step은 소수 라벨 강제 — format_num의 정수 반올림이 0.5 간격 라벨을
    // "0,1,1,2…"로 손상시키는 것 차단 (C1c #1882 갭④)
    let decimal = decimal || (step - step.round()).abs() > 1e-9;
    let label = |v: f64| -> String {
        if percent {
            format!("{}%", v.round() as i64)
        } else if decimal {
            format_axis_num(v)
        } else {
            format_num(v, format_code)
        }
    };
    // step 기반 눈금: v = vmin + step*i (정수 루프 — 부동소수 누적 드리프트 방지)
    let span = (vmax - vmin).max(1e-9);
    let step = if step > 0.0 { step } else { span / 5.0 };
    let grid_lines = (span / step).round().max(1.0) as usize;
    for i in 0..=grid_lines {
        let t = (step * i as f64) / span;
        if horizontal {
            let gx = px + pw * t;
            // 보조축일 때는 격자선 중복 방지, 라벨만
            if !secondary {
                svg.push_str(&format!(
                    "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" stroke=\"#e8e8e8\" stroke-width=\"0.5\"/>\n",
                    gx, py, gx, py + ph
                ));
            }
            let v = vmin + step * i as f64;
            svg.push_str(&format!(
                "<text x=\"{:.2}\" y=\"{:.2}\" font-family=\"sans-serif\" font-size=\"10\" fill=\"#666\" text-anchor=\"middle\">{}</text>\n",
                gx, py + ph + 12.0, xml_escape(&label(v))
            ));
        } else {
            let gy = py + ph - ph * t;
            if !secondary {
                svg.push_str(&format!(
                    "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" stroke=\"#e8e8e8\" stroke-width=\"0.5\"/>\n",
                    px, gy, px + pw, gy
                ));
            }
            let v = vmin + step * i as f64;
            let (tx, anchor) = if secondary {
                (px + pw + 4.0, "start")
            } else {
                (px - 4.0, "end")
            };
            svg.push_str(&format!(
                "<text x=\"{:.2}\" y=\"{:.2}\" font-family=\"sans-serif\" font-size=\"10\" fill=\"#666\" text-anchor=\"{}\">{}</text>\n",
                tx, gy + 3.0, anchor, xml_escape(&label(v))
            ));
        }
    }
}

/// 3D 방 선 스타일 — 정답지 임베드(2702px) 픽셀 실측: 축선·조그·격자·틱 전부
/// #808080 균일(gray 126~148)·0.72pt≈0.75. 2D의 축/격자 명암 구분(#e8e8e8)과
/// 다른 3D 전용 실측 규칙 (시각판정 피드백 2026-07-19).
const ROOM_LINE_STYLE: &str = "stroke=\"#808080\" stroke-width=\"0.75\"";
/// 값·카테고리 좌측 틱 길이(pt) — 실측 44/38px ÷ 8.34px/pt ≈ 5.3/4.6
const ROOM_TICK_LEFT: f64 = 5.0;
/// 하단 틱 길이(pt) — 실측 31~37px ≈ 3.7~4.4
const ROOM_TICK_DOWN: f64 = 4.0;

/// 3D 방 + 값축 격자·라벨 — 시어 투영 기반: 뒷벽(z=D, 격자 포함) + 눈금별
/// 바닥 조그 + 바닥 평행사변형 + 값·카테고리 틱. 격자는 `<line>` 2개(조그+뒷벽)로
/// 방출(`<polyline>` 미사용 — room 테스트 어휘 유지). 라벨 문자열·포맷은
/// render_value_grid와 동일(#1882 라벨 앵커) — 위치는 fit 후 앞면 rect 기준.
/// 한컴 실측(2026-07-19): 벽 테두리·바닥 채움 없음, 바닥 외곽선·틱은 격자와
/// 동일 스타일. 2D 경로는 이 함수를 쓰지 않는다. (C2b #2278 v2)
#[allow(clippy::too_many_arguments)]
fn render_value_grid_3d(
    svg: &mut String,
    proj: &ShearProj,
    vmin: f64,
    vmax: f64,
    step: f64,
    format_code: Option<&str>,
    horizontal: bool,
    percent: bool,
    cat_count: usize,
) {
    let (fx, fy, fw, fh) = (proj.fx, proj.fy, proj.fw, proj.fh);
    let (dxf, dyf) = (proj.dxf, proj.dyf);
    // 방 표면: 뒷벽(흰 면, 무테두리 — 한컴: 벽 모서리선 없음) → 바닥(흰 면 +
    // #808080 외곽선; 뒷모서리·좌측 대각은 0 눈금 격자/조그와 겹침) → 앞면 좌측 축선
    svg.push_str(&format!(
        "<g class=\"hwp-bar3d-room\">\n<rect x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" fill=\"#ffffff\"/>\n",
        fx + dxf,
        fy - dyf,
        fw,
        fh
    ));
    svg.push_str(&format!(
        "<polygon points=\"{:.2},{:.2} {:.2},{:.2} {:.2},{:.2} {:.2},{:.2}\" fill=\"#ffffff\" {ROOM_LINE_STYLE}/>\n",
        fx,
        fy + fh,
        fx + dxf,
        fy + fh - dyf,
        fx + fw + dxf,
        fy + fh - dyf,
        fx + fw,
        fy + fh
    ));
    svg.push_str(&format!(
        "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" {ROOM_LINE_STYLE}/>\n",
        fx,
        fy,
        fx,
        fy + fh
    ));

    // 라벨 문자열 규칙은 render_value_grid와 동일 (#1882 라벨 앵커 — 위치는
    // 앞면 rect 기준)
    let decimal = (step - step.round()).abs() > 1e-9;
    let label = |v: f64| -> String {
        if percent {
            format!("{}%", v.round() as i64)
        } else if decimal {
            format_axis_num(v)
        } else {
            format_num(v, format_code)
        }
    };
    let span = (vmax - vmin).max(1e-9);
    let step = if step > 0.0 { step } else { span / 5.0 };
    let grid_lines = (span / step).round().max(1.0) as usize;
    for i in 0..=grid_lines {
        let t = (step * i as f64) / span;
        let v = vmin + step * i as f64;
        if horizontal {
            let gx = fx + fw * t;
            // 바닥 조그(앞 눈금 → 뒷벽, 깊이 D) + 뒷벽 세로 격자 + 하단 값 틱
            svg.push_str(&format!(
                "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" {ROOM_LINE_STYLE}/>\n",
                gx,
                fy + fh,
                gx + dxf,
                fy + fh - dyf
            ));
            svg.push_str(&format!(
                "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" {ROOM_LINE_STYLE}/>\n",
                gx + dxf,
                fy + fh - dyf,
                gx + dxf,
                fy - dyf
            ));
            svg.push_str(&format!(
                "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" {ROOM_LINE_STYLE}/>\n",
                gx,
                fy + fh,
                gx,
                fy + fh + ROOM_TICK_DOWN
            ));
            svg.push_str(&format!(
                "<text x=\"{:.2}\" y=\"{:.2}\" font-family=\"sans-serif\" font-size=\"10\" fill=\"#666\" text-anchor=\"middle\">{}</text>\n",
                gx,
                fy + fh + 12.0,
                xml_escape(&label(v))
            ));
        } else {
            let gy = fy + fh - fh * t;
            // 바닥 조그(앞 좌측 눈금 → 뒷벽) + 뒷벽 수평 격자 + 좌측 값 틱
            svg.push_str(&format!(
                "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" {ROOM_LINE_STYLE}/>\n",
                fx,
                gy,
                fx + dxf,
                gy - dyf
            ));
            svg.push_str(&format!(
                "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" {ROOM_LINE_STYLE}/>\n",
                fx + dxf,
                gy - dyf,
                fx + fw + dxf,
                gy - dyf
            ));
            svg.push_str(&format!(
                "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" {ROOM_LINE_STYLE}/>\n",
                fx - ROOM_TICK_LEFT,
                gy,
                fx,
                gy
            ));
            svg.push_str(&format!(
                "<text x=\"{:.2}\" y=\"{:.2}\" font-family=\"sans-serif\" font-size=\"10\" fill=\"#666\" text-anchor=\"end\">{}</text>\n",
                fx - ROOM_TICK_LEFT - 1.0,
                gy + 3.0,
                xml_escape(&label(v))
            ));
        }
    }
    // 카테고리 경계 틱 — 경계+양끝 = cat_count+1개 (한컴 실측: 세로형은 바닥
    // 앞모서리 아래로, 가로형은 축선 왼쪽으로; k=0 틱이 축선 연장 역할)
    for k in 0..=cat_count {
        if horizontal {
            let by = fy + fh * k as f64 / cat_count.max(1) as f64;
            svg.push_str(&format!(
                "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" {ROOM_LINE_STYLE}/>\n",
                fx - ROOM_TICK_LEFT,
                by,
                fx,
                by
            ));
        } else {
            let bx = fx + fw * k as f64 / cat_count.max(1) as f64;
            svg.push_str(&format!(
                "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" {ROOM_LINE_STYLE}/>\n",
                bx,
                fy + fh,
                bx,
                fy + fh + ROOM_TICK_DOWN
            ));
        }
    }
    svg.push_str("</g>\n");
}

/// 3D 막대 렌더 — 시어 투영(rAngAx=1 관례) 기반 별도 경로. 축 범위
/// (vmin/vmax/vstep)는 호출측 render_bars가 플롯 rect 기준으로 확정(#1882
/// 앵커 무접촉), 여기서는 방·배치·압출만 담당. 배치는 fit 후 앞면 rect 기준 —
/// 2D 루프와 완전 분리(2D 출력 바이트 불변). (C2b #2278 v2)
#[allow(clippy::too_many_arguments)]
fn render_bars_3d(
    svg: &mut String,
    chart: &OoxmlChart,
    px: f64,
    py: f64,
    pw: f64,
    ph: f64,
    horizontal: bool,
    stacked: bool,
    percent: bool,
    cat_count: usize,
    ser_count: usize,
    vmin: f64,
    vmax: f64,
    vstep: f64,
) {
    let view = chart.view3d.clone().unwrap_or_default();
    // 두께 규칙 slot/(n_eff + gapWidth/100) — Excel gapWidth 의미(슬롯 내 여백을
    // 막대 폭 %로). 코퍼스 150: 누적 1/2.5=0.4, 묶은 3계열 3/4.5≈0.667 —
    // v1~v3 눈대중 상수의 유도 원형. 2D는 0.7 휴리스틱 동결.
    let gap_w = chart.bar_gap_width.unwrap_or(150.0).max(0.0);
    let n_eff = if stacked { 1.0 } else { ser_count as f64 };

    // fit 전 좌표로 깊이 산출 (fit이 깊이에 의존 — 역방향 순환 없음).
    // depthPercent = 막대 깊이/폭 % — ECMA "차트 폭 대비"와 다른 의도적 편차
    // (mod.rs View3D 주석 참조).
    let slot0 = (if horizontal { ph } else { pw }) / cat_count as f64;
    let bar_w0 = slot0 / (n_eff + gap_w / 100.0);
    let b_depth = bar_w0 * view.depth_percent.max(0.0) / 100.0;
    let d_scene = b_depth * (1.0 + chart.gap_depth.unwrap_or(150.0).max(0.0) / 100.0);

    let proj = shear_proj(&view, px, py, pw, ph, d_scene);

    // 막대 깊이 센터링: z ∈ [z0, z0+b], z0 = (D−b)/2 — gapDepth 여백을 앞뒤로
    // 분할(Excel/한컴 관례, v2 설계 리뷰). d_scene ≤ ε 퇴화(depthPercent=0)는
    // 0/0 NaN 가드.
    let (bdx0, bdy0, bdx, bdy) = if d_scene > 1e-9 {
        let z0 = (d_scene - b_depth) / 2.0 / d_scene;
        let zb = b_depth / d_scene;
        (proj.dxf * z0, proj.dyf * z0, proj.dxf * zb, proj.dyf * zb)
    } else {
        (0.0, 0.0, 0.0, 0.0)
    };

    render_value_grid_3d(
        svg,
        &proj,
        vmin,
        vmax,
        vstep,
        chart.series.first().and_then(|s| s.format_code.as_deref()),
        horizontal,
        percent,
        cat_count,
    );

    // 배치는 fit 후 앞면 rect 기준
    let (fx, fy, fw, fh) = (proj.fx, proj.fy, proj.fw, proj.fh);
    let cat_span = (if horizontal { fh } else { fw }) / cat_count as f64;
    let bar_w = cat_span / (n_eff + gap_w / 100.0);
    let bar_span_total = bar_w * n_eff;

    // 가로 막대는 카테고리를 아래→위로 배치 (2D와 동일 규칙)
    let cat_slot = |ci: usize| -> f64 {
        let idx = if horizontal { cat_count - 1 - ci } else { ci };
        cat_span * idx as f64
    };

    if stacked {
        // 페인트 순서(세로: 아래→위, 가로: 왼→오른쪽)가 은면 제거 담당 —
        // 시어 성분 ≥0 클램프(shear_proj)가 이 순서의 유효 전제. 순서 변경 금지.
        for ci in 0..cat_count {
            let denom = if percent {
                let s = category_positive_sum(chart, ci);
                if s > 0.0 {
                    s
                } else {
                    1.0
                }
            } else {
                (vmax - vmin).max(1e-9)
            };
            let mut acc = 0.0_f64;
            for (si, ser) in chart.series.iter().enumerate() {
                let v = ser.values.get(ci).copied().unwrap_or(0.0).max(0.0);
                let rgb = ser.color.unwrap_or_else(|| palette(si));
                let cell = (if horizontal { fy } else { fx })
                    + cat_slot(ci)
                    + (cat_span - bar_span_total) / 2.0;
                if horizontal {
                    let seg = fw * (v / denom);
                    push_bar_3d(
                        svg,
                        fx + acc + bdx0,
                        cell - bdy0,
                        seg.max(0.0),
                        bar_span_total,
                        bdx,
                        bdy,
                        rgb,
                    );
                    acc += seg;
                } else {
                    let seg = fh * (v / denom);
                    let by = fy + fh - acc - seg;
                    push_bar_3d(
                        svg,
                        cell + bdx0,
                        by - bdy0,
                        bar_span_total,
                        seg.max(0.0),
                        bdx,
                        bdy,
                        rgb,
                    );
                    acc += seg;
                }
            }
        }
    } else {
        for ci in 0..cat_count {
            for (si, ser) in chart.series.iter().enumerate() {
                let v = *ser.values.get(ci).unwrap_or(&0.0);
                let t = if vmax > vmin {
                    (v - vmin) / (vmax - vmin)
                } else {
                    0.0
                };
                let rgb = ser.color.unwrap_or_else(|| palette(si));
                if horizontal {
                    let cy = fy
                        + cat_slot(ci)
                        + (cat_span - bar_span_total) / 2.0
                        + bar_w * (ser_count - 1 - si) as f64;
                    let bw = fw * t;
                    // 3D는 gapWidth 규칙이 간격 담당 — 2D의 0.95 계수 미적용
                    push_bar_3d(svg, fx + bdx0, cy - bdy0, bw.max(0.0), bar_w, bdx, bdy, rgb);
                } else {
                    let cx =
                        fx + cat_slot(ci) + (cat_span - bar_span_total) / 2.0 + bar_w * si as f64;
                    let bh = fh * t;
                    let by = fy + fh - bh;
                    push_bar_3d(svg, cx + bdx0, by - bdy0, bar_w, bh.max(0.0), bdx, bdy, rgb);
                }
            }
        }
    }

    // 가로형 라벨은 좌측 카테고리 틱(5pt) 바깥 — 한컴 실측 간격(2D는 4.0 유지)
    render_category_labels_at(svg, chart, fx, fy, fw, fh, cat_count, horizontal, 6.0);
}

fn render_category_labels(
    svg: &mut String,
    chart: &OoxmlChart,
    px: f64,
    py: f64,
    pw: f64,
    ph: f64,
    cat_count: usize,
    horizontal: bool,
) {
    render_category_labels_at(svg, chart, px, py, pw, ph, cat_count, horizontal, 4.0);
}

/// 카테고리 라벨 — `left_gap`: 가로형 라벨의 축선~라벨 간격(2D 4.0 불변,
/// 3D는 좌측 틱 밖 6.0). 세로형 위치는 공통.
#[allow(clippy::too_many_arguments)]
fn render_category_labels_at(
    svg: &mut String,
    chart: &OoxmlChart,
    px: f64,
    py: f64,
    pw: f64,
    ph: f64,
    cat_count: usize,
    horizontal: bool,
    left_gap: f64,
) {
    let cat_span = if horizontal {
        ph / cat_count as f64
    } else {
        pw / cat_count as f64
    };
    for (ci, cat) in chart.categories.iter().enumerate() {
        if ci >= cat_count {
            break;
        }
        if horizontal {
            // 가로 막대: 카테고리 아래→위 (한컴 실측 — 막대 배치와 동일 순서)
            let row = cat_count - 1 - ci;
            let cy = py + cat_span * row as f64 + cat_span / 2.0 + 3.0;
            svg.push_str(&format!(
                "<text x=\"{:.2}\" y=\"{:.2}\" font-family=\"sans-serif\" font-size=\"10\" fill=\"#333\" text-anchor=\"end\">{}</text>\n",
                px - left_gap, cy, xml_escape(cat)
            ));
        } else {
            let cx = px + cat_span * ci as f64 + cat_span / 2.0;
            svg.push_str(&format!(
                "<text x=\"{:.2}\" y=\"{:.2}\" font-family=\"sans-serif\" font-size=\"10\" fill=\"#333\" text-anchor=\"middle\">{}</text>\n",
                cx, py + ph + 14.0, xml_escape(cat)
            ));
        }
    }
}

// ---------------- Legend ----------------

/// 범례 항목 역순 여부 — 정답지 PDF 28종 전수 실측 규칙 (#2277 stage3 보고서 표, 예외 0).
///
/// 한컴은 계열이 플롯에서 **세로 방향으로 배열되는 차트**의 우측 세로 범례를 시각적
/// 상→하 순서와 일치시키기 위해 역순으로 나열한다 (C1c의 "관찰 상충"은 이 규칙):
/// - 세로 값축 누적(막대·라인 stacked/percentStacked): 스택 맨 위 = 마지막 계열
/// - 가로막대 묶음(clustered): 슬롯 맨 위 = 마지막 계열 (슬롯 배치 반전과 세트)
///
/// 3D는 2D와 동일 규칙(실측 4종 일치). pie(카테고리 범례)/scatter/stock/콤보/이중축
/// = 정순. 하단 가로 범례는 코퍼스 미실측(전 샘플 legendPos=r) — 현행 정순 유지.
fn legend_order_reversed(chart: &OoxmlChart) -> bool {
    if chart.legend_pos != LegendPos::Right || chart.is_combo() || chart.has_secondary_axis {
        return false;
    }
    match chart.chart_type {
        OoxmlChartType::Column => matches!(
            chart.grouping,
            BarGrouping::Stacked | BarGrouping::PercentStacked
        ),
        OoxmlChartType::Bar => chart.grouping == BarGrouping::Clustered,
        OoxmlChartType::Line => matches!(
            chart.line_grouping,
            BarGrouping::Stacked | BarGrouping::PercentStacked
        ),
        _ => false,
    }
}

/// 범례 스와치 형태 — 정답지 28종 전수 실측 (#2277 stage3 표). 글리프 인덱스는
/// **원 계열 인덱스**(역순 나열과 무관하게 플롯 마커·팔레트와 동일 형상/색 유지).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SwatchKind {
    /// 막대/원형: 10×10 색 사각형 (현행 유지 — issue_1882 필터 문자열 보호)
    Square,
    /// 무표식 라인·콤보 라인: 14px 색 선분 (현행 유지)
    LineOnly,
    /// 표식 라인·선+표식 분산형: 선분 + 중앙 마커 글리프 (—◆—)
    LineGlyph(usize),
    /// 표식만 분산형·stock 종가: 마커 글리프만
    GlyphOnly(usize),
    /// stock 시/고/저 (`c:symbol val="none"`): 스와치 없음 — 텍스트 정렬은 유지
    Blank,
}

/// 계열별 스와치 형태 결정. 실측 근거: 표식 라인 = 선+글리프 / 분산형 = 스타일
/// flags 따라 선·글리프 조합 / stock = 종가만 글리프·나머지 빈 스와치. (C2a #2277)
fn swatch_kind(chart: &OoxmlChart, s: &OoxmlSeries, i: usize) -> SwatchKind {
    match s.series_type {
        // 순수 라인 차트 + plot 레벨 표식 → 선+글리프. 콤보의 라인 계열은
        // render_combo가 마커를 그리지 않으므로 선만 (현행 유지).
        OoxmlChartType::Line if chart.chart_type == OoxmlChartType::Line && chart.line_markers => {
            SwatchKind::LineGlyph(i)
        }
        OoxmlChartType::Line => SwatchKind::LineOnly,
        OoxmlChartType::Scatter => {
            let (line, _, marker) = chart.scatter_style.flags();
            match (line, marker) {
                (true, true) => SwatchKind::LineGlyph(i),
                (false, true) => SwatchKind::GlyphOnly(i),
                _ => SwatchKind::LineOnly,
            }
        }
        OoxmlChartType::Stock => {
            if matches!(s.marker_symbol, SeriesMarker::Auto | SeriesMarker::Named(_)) {
                SwatchKind::GlyphOnly(i)
            } else {
                SwatchKind::Blank
            }
        }
        _ => SwatchKind::Square,
    }
}

/// 범례 항목 목록 `(라벨, 색상, 스와치 형태)`. pie는 카테고리별, 그 외는 시리즈별
/// (색·글리프 매핑 후 `legend_order_reversed`면 역순 나열).
fn legend_items(chart: &OoxmlChart) -> Vec<(String, u32, SwatchKind)> {
    match chart.chart_type {
        OoxmlChartType::Pie | OoxmlChartType::Doughnut => {
            let first = chart.series.first();
            first
                .map(|s| {
                    s.values
                        .iter()
                        .enumerate()
                        .map(|(i, _)| {
                            let label = chart
                                .categories
                                .get(i)
                                .cloned()
                                .unwrap_or_else(|| format!("항목 {}", i + 1));
                            let color = s.color.unwrap_or_else(|| palette(i));
                            (label, color, SwatchKind::Square)
                        })
                        .collect()
                })
                .unwrap_or_default()
        }
        _ => {
            let mut items: Vec<(String, u32, SwatchKind)> = chart
                .series
                .iter()
                .enumerate()
                .map(|(i, s)| {
                    let label = if s.name.is_empty() {
                        format!("시리즈 {}", i + 1)
                    } else {
                        s.name.clone()
                    };
                    let color = s.color.unwrap_or_else(|| palette(i));
                    (label, color, swatch_kind(chart, s, i))
                })
                .collect();
            if legend_order_reversed(chart) {
                items.reverse();
            }
            items
        }
    }
}

/// 범례 스와치 1개. `cy` = 행 세로 중심. Square/LineOnly는 종전 출력 바이트 유지,
/// 글리프는 별도 클래스 `hwp-legend-glyph`(플롯 마커 `hwp-chart-marker` 카운트
/// 오염 방지 — issue_2129 보호). (C2a #2277)
fn push_legend_swatch(svg: &mut String, ix: f64, cy: f64, color: u32, kind: SwatchKind) {
    let swatch_line = |svg: &mut String| {
        svg.push_str(&format!(
            "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" stroke=\"{}\" stroke-width=\"2\"/>\n",
            ix, cy, ix + 14.0, cy, color_hex(color)
        ));
    };
    match kind {
        SwatchKind::Square => {
            svg.push_str(&format!(
                "<rect x=\"{:.2}\" y=\"{:.2}\" width=\"10\" height=\"10\" fill=\"{}\"/>\n",
                ix,
                cy - 6.0,
                color_hex(color)
            ));
        }
        SwatchKind::LineOnly => swatch_line(svg),
        SwatchKind::LineGlyph(si) => {
            swatch_line(svg);
            push_marker(
                svg,
                "hwp-legend-glyph",
                si,
                ix + 7.0,
                cy,
                3.0,
                &color_hex(color),
            );
        }
        SwatchKind::GlyphOnly(si) => {
            push_marker(
                svg,
                "hwp-legend-glyph",
                si,
                ix + 7.0,
                cy,
                3.5,
                &color_hex(color),
            );
        }
        SwatchKind::Blank => {}
    }
}

/// 하단 가로 범례 (legendPos=b 및 기본값)
fn render_legend(svg: &mut String, chart: &OoxmlChart, x: f64, y: f64, w: f64, _h: f64) {
    if chart.series.is_empty() {
        return;
    }
    let items = legend_items(chart);

    svg.push_str("<g class=\"hwp-chart-legend\">\n");
    // 가운데 정렬: 항목 개수로 총 너비 계산
    let item_w = 100.0_f64.min((w / items.len().max(1) as f64).max(60.0));
    let total_w = item_w * items.len() as f64;
    let start_x = x + (w - total_w) / 2.0;
    for (i, (label, color, kind)) in items.iter().enumerate() {
        let ix = start_x + item_w * i as f64;
        push_legend_swatch(svg, ix, y + 11.0, *color, *kind);
        svg.push_str(&format!(
            "<text x=\"{:.2}\" y=\"{:.2}\" font-family=\"sans-serif\" font-size=\"10\" fill=\"#333\">{}</text>\n",
            ix + 18.0, y + 14.0, xml_escape(label)
        ));
    }
    svg.push_str("</g>\n");
}

/// 우측 세로 범례 (legendPos=r — 한컴 코퍼스 전 샘플). 플롯 세로 중앙 정렬.
/// C1c #1882 갭③.
fn render_legend_right(svg: &mut String, chart: &OoxmlChart, x: f64, y: f64, h: f64) {
    if chart.series.is_empty() {
        return;
    }
    let items = legend_items(chart);
    let row_h = 16.0;
    let total_h = row_h * items.len() as f64;
    let start_y = y + ((h - total_h) / 2.0).max(0.0);

    svg.push_str("<g class=\"hwp-chart-legend\">\n");
    for (i, (label, color, kind)) in items.iter().enumerate() {
        let cy = start_y + row_h * i as f64 + row_h / 2.0;
        push_legend_swatch(svg, x, cy, *color, *kind);
        svg.push_str(&format!(
            "<text x=\"{:.2}\" y=\"{:.2}\" font-family=\"sans-serif\" font-size=\"10\" fill=\"#333\">{}</text>\n",
            x + 18.0,
            cy + 3.0,
            xml_escape(label)
        ));
    }
    svg.push_str("</g>\n");
}


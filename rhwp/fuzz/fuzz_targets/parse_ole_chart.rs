//! HWP OLE legacy 차트 `Contents` 파싱 + SVG 렌더 퍼징 하네스.
//!
//! 반환값은 무시한다 — 패닉/abort/자원 고갈/타임아웃만 검출 대상이다.
//! 레이아웃은 파싱 결과를 곧바로 SVG 로 그리므로(shape_layout.rs) 렌더러까지 편다.

#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if let Ok(chart) = rhwp::ole_chart::parse_ole_chart_contents(data) {
        let _ = rhwp::ole_chart::render_ole_chart_svg_fragment(&chart, 0.0, 0.0, 300.0, 200.0, 1);
    }
});

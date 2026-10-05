//! EMF(Enhanced Metafile) 파싱 + SVG 변환 퍼징 하네스.
//!
//! 반환값은 무시한다 — 패닉/abort/자원 고갈/타임아웃만 검출 대상이다.
//! OLE 개체의 `OlePres000`/`Contents` EMF 미리보기는 레이아웃마다
//! `convert_to_svg` 를 거치므로(shape_layout.rs) 파서와 플레이어를 함께 편다.

#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = rhwp::emf::convert_to_svg(data, (0.0, 0.0, 100.0, 100.0));
});

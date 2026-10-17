//! 준비된 SFNT face의 glyph ID를 backend 공통 원본 윤곽선으로 읽는다.

use std::fmt::Write;
use ttf_parser::{Face, GlyphId, OutlineBuilder};

/// SVG 경로: 1000=1em, 기준점 원점, y 아래쪽 양수. 윤곽선 없는 glyph는 빈 문자열.
pub(crate) fn glyph_path_em(bytes: &[u8], face_index: u32, glyph_id: u32) -> String {
    let Ok(id) = u16::try_from(glyph_id) else {
        return String::new();
    };
    let Ok(face) = Face::parse(bytes, face_index) else {
        return String::new();
    };
    if id == 0 || id >= face.number_of_glyphs() || face.units_per_em() == 0 {
        return String::new();
    }
    let mut pen = SvgOutline {
        path: String::new(),
        scale: 1000.0 / f64::from(face.units_per_em()),
        valid: true,
    };
    if face.outline_glyph(GlyphId(id), &mut pen).is_some() && pen.valid {
        pen.path
    } else {
        String::new()
    }
}

struct SvgOutline {
    path: String,
    scale: f64,
    valid: bool,
}

impl SvgOutline {
    fn point(&mut self, x: f32, y: f32) {
        let x = f64::from(x) * self.scale;
        let y = -f64::from(y) * self.scale;
        if !x.is_finite() || !y.is_finite() {
            self.valid = false;
            return;
        }
        let _ = write!(self.path, "{x:.6} {y:.6} ");
    }
}

impl OutlineBuilder for SvgOutline {
    fn move_to(&mut self, x: f32, y: f32) {
        self.path.push('M');
        self.point(x, y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.path.push('L');
        self.point(x, y);
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.path.push('Q');
        self.point(x1, y1);
        self.point(x, y);
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.path.push('C');
        self.point(x1, y1);
        self.point(x2, y2);
        self.point(x, y);
    }
    fn close(&mut self) {
        self.path.push('Z');
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wasm_api::sfnt_glyph_path_em as public_path;

    #[test]
    fn exact_sfnt_face_glyph_paths_preserve_ink_and_reject_unknown_payloads() {
        let bytes = include_bytes!("../../ttfs/opensource/NotoSansKR-Regular.ttf");
        let face = Face::parse(bytes, 0).unwrap();
        for character in ['9', 'Å'] {
            let id = u32::from(face.glyph_index(character).unwrap().0);
            let path = public_path(bytes, 0, id);
            assert!(path.starts_with('M') && path.contains('Z'), "{character}");
            assert!(!path.contains("NaN") && !path.contains("inf"));
        }
        let collection = include_bytes!("../../tests/fixtures/fonts/RHWPExactFaceSmoke.ttc");
        assert!(!public_path(collection, 0, 1).is_empty());
        assert!(!public_path(collection, 1, 1).is_empty());
        assert!(public_path(collection, 2, 1).is_empty());
        let blank = u32::from(face.glyph_index(' ').unwrap().0);
        assert!(public_path(bytes, 0, blank).is_empty());
        for (payload, index, id) in [
            (bytes.as_slice(), 1, 1),
            (bytes.as_slice(), 0, 0),
            (bytes.as_slice(), 0, u32::from(face.number_of_glyphs())),
            (bytes.as_slice(), 0, u32::MAX),
            (b"invalid SFNT".as_slice(), 0, 1),
        ] {
            assert!(public_path(payload, index, id).is_empty());
        }
    }
}

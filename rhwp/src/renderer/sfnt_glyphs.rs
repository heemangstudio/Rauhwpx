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


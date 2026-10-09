use crate::wmf::converter::{svg::util::css_color_from_color_ref, *};

#[derive(Clone, Debug)]
pub struct DeviceContext {
    // structures
    pub drawing_position: PointS,
    pub text_bk_color: ColorRef,
    pub text_color: ColorRef,
    pub window: Window,

    // graphics props
    pub bk_mode: MixMode,
    pub clipping_region: Option<Rect>,
    pub poly_fill_mode: PolyFillMode,
    pub text_align_horizontal: TextAlignmentMode,
    pub text_align_vertical: VerticalTextAlignmentMode,
    pub text_align_update_cp: bool,

    pub draw_mode: Option<BinaryRasterOperation>,
    pub map_mode: MapMode,
}

impl Default for DeviceContext {
    fn default() -> Self {
        Self {
            bk_mode: MixMode::TRANSPARENT,
            clipping_region: None,
            drawing_position: PointS { x: 0, y: 0 },
            draw_mode: None,
            map_mode: MapMode::MM_TEXT,
            poly_fill_mode: PolyFillMode::ALTERNATE,
            text_align_horizontal: TextAlignmentMode::TA_LEFT,
            text_align_vertical: VerticalTextAlignmentMode::VTA_BASELINE,
            text_align_update_cp: false,
            text_bk_color: ColorRef::white(),
            text_color: ColorRef::black(),
            window: Window::new(),
        }
    }
}

// mutations
impl DeviceContext {
    pub fn bk_mode(mut self, bk_mode: MixMode) -> Self {
        self.bk_mode = bk_mode;
        self
    }

    pub fn clipping_region(mut self, clipping_region: Rect) -> Self {
        let clipping_region = if let Some(ref existing) = self.clipping_region {
            if let Some(overlap_region) = existing.overlap(&clipping_region) {
                overlap_region
            } else {
                clipping_region
            }
        } else {
            clipping_region
        };

        self.clipping_region = clipping_region.into();
        self
    }

    pub fn drawing_position(mut self, drawing_position: PointS) -> Self {
        self.drawing_position = drawing_position;
        self
    }

    pub fn draw_mode(mut self, draw_mode: BinaryRasterOperation) -> Self {
        self.draw_mode = draw_mode.into();
        self
    }

    pub fn extend_window(self, p: &PointS) -> Self {
        // SetWindowExt 또는 Placeable 헤더로 명시적으로 설정된 경우 자동 확장하지 않음
        if self.window.ext_explicitly_set {
            return self;
        }

        let (mut x, mut y) = (0, 0);

        if self.window.x < p.x {
            x = p.x;
        }

        if self.window.y < p.y {
            y = p.y;
        }

        if x > 0 && y > 0 {
            self.window_ext(x, y)
        } else {
            self
        }
    }

    pub fn map_mode(mut self, map_mode: MapMode) -> Self {
        self.map_mode = map_mode;
        self
    }

    pub fn poly_fill_mode(mut self, poly_fill_mode: PolyFillMode) -> Self {
        self.poly_fill_mode = poly_fill_mode;
        self
    }

    pub fn text_align_horizontal(mut self, text_align_horizontal: TextAlignmentMode) -> Self {
        self.text_align_horizontal = text_align_horizontal;
        self
    }

    pub fn text_align_vertical(mut self, text_align_vertical: VerticalTextAlignmentMode) -> Self {
        self.text_align_vertical = text_align_vertical;
        self
    }

    pub fn text_align_update_cp(mut self, text_align_update_cp: bool) -> Self {
        self.text_align_update_cp = text_align_update_cp;
        self
    }

    pub fn text_bk_color(mut self, text_bk_color: ColorRef) -> Self {
        self.text_bk_color = text_bk_color;
        self
    }

    pub fn text_color(mut self, text_color: ColorRef) -> Self {
        self.text_color = text_color;
        self
    }

    pub fn window_ext(mut self, x: i16, y: i16) -> Self {
        self.window = self.window.ext(x, y);
        self
    }

    pub fn window_origin(mut self, x: i16, y: i16) -> Self {
        self.window = self.window.origin(x, y);
        self
    }

    pub fn window_scale(mut self, x: f32, y: f32) -> Self {
        self.window = self.window.scale(x, y);
        self
    }
}

impl DeviceContext {
    pub fn as_css_text_align(&self) -> String {
        match self.text_align_horizontal {
            TextAlignmentMode::TA_CENTER => "middle".to_owned(),
            TextAlignmentMode::TA_RIGHT => "end".to_owned(),
            _ => "start".to_owned(),
        }
    }

    pub fn as_css_text_align_vertical(&self) -> String {
        match self.text_align_vertical {
            VerticalTextAlignmentMode::VTA_BOTTOM => "text-bottom".to_owned(),
            // VTA_TOP: y 좌표에서 이미 ascent를 보정했으므로 기본 baseline 사용
            VerticalTextAlignmentMode::VTA_TOP => "auto".to_owned(),
            VerticalTextAlignmentMode::VTA_CENTER => "central".to_owned(),
            _ => "auto".to_owned(),
        }
    }

    pub fn point_s_to_absolute_point(&self, point: &PointS) -> PointS {
        let x = window_distance(point.x, self.window.origin_x, self.window.scale_x);
        let y = window_distance(point.y, self.window.origin_y, self.window.scale_y);

        PointS { x, y }
    }

    pub fn point_s_to_relative_point(&self, point: &PointS) -> PointS {
        let x = window_distance(point.x, self.window.origin_x, self.window.scale_x)
            .saturating_add(self.drawing_position.x);
        let y = window_distance(point.y, self.window.origin_y, self.window.scale_y)
            .saturating_add(self.drawing_position.y);

        PointS { x, y }
    }

    pub fn poly_fill_rule(&self) -> String {
        match self.poly_fill_mode {
            PolyFillMode::ALTERNATE => "evenodd",
            PolyFillMode::WINDING => "nonzero",
        }
        .to_owned()
    }

    pub fn text_color_as_css_color(&self) -> String {
        css_color_from_color_ref(&self.text_color)
    }
}

/// 논리 좌표 한 축의 창 원점까지 거리를 창 배율로 나눈 값.
///
/// 좌표는 파일이 정한 i16 이다. i16 으로 빼고 `abs()` 하면 `-32768` 이나
/// `32767 - (-1)` 에서 넘친다(디버그 빌드 패닉). i32 로 셈하면 넘치지 않는 입력은
/// 예전과 같은 값이고, 넘치던 입력은 `as i16` 포화로 끝난다.
fn window_distance(value: i16, origin: i16, scale: f32) -> i16 {
    ((i32::from(value) - i32::from(origin)).abs() as f32 / scale) as i16
}

#[derive(Clone, Debug)]
pub struct Window {
    pub x: i16,
    pub y: i16,
    pub origin_x: i16,
    pub origin_y: i16,
    pub scale_x: f32,
    pub scale_y: f32,
    /// SetWindowExt가 명시적으로 호출되었는지 여부
    pub ext_explicitly_set: bool,
    /// [Task #860 Stage D] WMF 의 SetWindowExt y < 0 (Cartesian, bottom-up) 인 경우 true.
    /// SVG renderer 는 top-down (y 아래 증가). y < 0 처리를 위해 element y 좌표 flip 필요.
    pub y_inverted: bool,
}

impl Default for Window {
    fn default() -> Self {
        Self {
            x: 1024,
            y: 1024,
            origin_x: 0,
            origin_y: 0,
            scale_x: 1.0,
            scale_y: 1.0,
            ext_explicitly_set: false,
            y_inverted: false,
        }
    }
}

impl Window {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn ext(mut self, x: i16, y: i16) -> Self {
        self.x = x.saturating_abs();
        self.y = y.saturating_abs();
        self.ext_explicitly_set = true;
        // [Task #860 Stage D] y < 0 = Cartesian 좌표계 (bottom-up) — 일부 application
        // 이 WMF 에 SetWindowExt(width, -height) 로 bottom-up 설정. SVG 변환 시
        // y-flip transform 필요. 현재 sample 들에서는 미발견.
        if y < 0 {
            self.y_inverted = true;
        }
        self
    }

    pub fn origin(mut self, origin_x: i16, origin_y: i16) -> Self {
        self.origin_x = origin_x;
        self.origin_y = origin_y;
        self
    }

    pub fn scale(mut self, scale_x: f32, scale_y: f32) -> Self {
        self.scale_x = scale_x;
        self.scale_y = scale_y;
        self
    }

    pub fn as_view_box(&self) -> (i16, i16, i16, i16) {
        // [Task #864] element 좌표는 모두 `point_s_to_absolute_point` 로 origin-relative
        // (device coord) 변환됨. image (TernaryRasterOperator) 도 호출 측에서 동일하게
        // 변환 (Task #864). viewBox 도 이 device 공간 (0, 0, ext_x, ext_y) 으로 정합.
        // (Task #860 Stage D 의 (origin_x, origin_y, ...) 변경 revert — image 와 text
        // 의 좌표 공간이 mismatch 였던 본질을 정정.)
        (0, 0, self.x.saturating_abs(), self.y.saturating_abs())
    }
}

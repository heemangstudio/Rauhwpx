//! 한컴 원뿔 채우기의 유한 색상 부채꼴. 장치 정수 좌표 양자화는 백엔드 경계다.
use super::{render_tree::BoundingBox, GradientFillInfo};
use crate::model::ColorRef;

pub(crate) struct FillPolygon {
    pub points: Vec<(f64, f64)>,
    pub color: ColorRef,
}

fn rounded_mul_div(a: i32, b: i32, denominator: i32) -> i32 {
    let value = i64::from(a) * i64::from(b);
    let denominator = i64::from(denominator);
    let magnitude = (value.abs() + denominator.abs() / 2) / denominator.abs();
    (if (value < 0) != (denominator < 0) {
        -magnitude
    } else {
        magnitude
    }) as i32
}

/// 선택된 두 색상 원뿔형만 해석한다. 다른 종류/다중 스톱은 기존 경로에 남긴다.
pub(crate) fn conical_polygons(
    gradient: &GradientFillInfo,
    bbox: BoundingBox,
) -> Option<Vec<FillPolygon>> {
    if gradient.gradient_type != 3
        || gradient.colors.len() != 2
        || gradient.colors[0] == gradient.colors[1]
        || gradient.step <= 0
        || !(0..=100).contains(&gradient.center_x)
        || !(0..=100).contains(&gradient.center_y)
        || gradient.step_center > 100
        || ![bbox.x, bbox.y, bbox.width, bbox.height]
            .iter()
            .all(|v| v.is_finite())
        || bbox.width <= 0.0
        || bbox.height <= 0.0
    {
        return None;
    }
    let n = i32::from(gradient.step);
    let m = if n % 2 == 0 { n } else { 2 * n };
    let half = m / 2;
    let pivot = rounded_mul_div(180, i32::from(gradient.step_center), 100);
    let center = (
        bbox.x + bbox.width * f64::from(gradient.center_x) / 100.0,
        bbox.y + bbox.height * f64::from(gradient.center_y) / 100.0,
    );
    let angle = 360 - i32::from(gradient.angle);
    let mut previous = 0;
    let mut polygons = Vec::new();
    for i in 0..m {
        let odd = n % 2 != 0;
        if odd && i % 2 != 0 && i != half - 1 && i != half {
            continue;
        }
        let increment = if odd && i != half - 1 && i != half {
            2
        } else {
            1
        };
        let end = if i < half {
            rounded_mul_div(pivot, i + increment, half)
        } else {
            pivot + rounded_mul_div(180 - pivot, i - half + increment, half)
        };
        let color_index = if odd { i / 2 } else { i };
        let mut color = 0;
        for shift in [0, 8, 16] {
            let start = ((gradient.colors[0] >> shift) & 255) as i32;
            let stop = ((gradient.colors[1] >> shift) & 255) as i32;
            let channel = if n == 1 {
                start
            } else {
                start + (stop - start) * color_index / (n - 1)
            };
            color |= (channel as u32) << shift;
        }
        for sign in [1, -1] {
            polygons.push(FillPolygon {
                points: wedge(bbox, center, angle + sign * previous, angle + sign * end),
                color,
            });
        }
        previous = end;
    }
    Some(polygons)
}

// 각도는 정수이고, 꼭짓점으로 나누어진 변 구간도 native와 같이 정수각을 쓴다.
fn ray(bbox: BoundingBox, center: (f64, f64), angle: i32) -> ((f64, f64), usize) {
    let corners = [
        (bbox.x, bbox.y),
        (bbox.x + bbox.width, bbox.y),
        (bbox.x + bbox.width, bbox.y + bbox.height),
        (bbox.x, bbox.y + bbox.height),
    ];
    let angle = angle.rem_euclid(360);
    let corner_angles = corners.map(|p| {
        let dx = p.0 - center.0;
        let dy = p.1 - center.1;
        if dx == 0.0 {
            if dy < 0.0 {
                270
            } else {
                90
            }
        } else {
            dy.atan2(dx).to_degrees().rem_euclid(360.0) as i32
        }
    });
    let edge = (0..4)
        .find(|&edge| {
            let start = corner_angles[edge];
            let mut end = corner_angles[(edge + 1) % 4];
            let mut candidate = angle;
            if end < start {
                end += 360;
                if candidate < start {
                    candidate += 360;
                }
            }
            start <= candidate && candidate < end
        })
        .unwrap_or(3);
    let tangent = f64::from(angle).to_radians().tan();
    // 장치 격자는 미확정이다. 현재 부동소수 프레임에서 같은 교차식을 사용한다.
    let point = if edge == 0 || edge == 2 {
        let y = if edge == 0 {
            bbox.y
        } else {
            bbox.y + bbox.height
        };
        let x = if angle == 90 || angle == 270 || y == center.1 {
            center.0
        } else {
            center.0 + (y - center.1) / tangent
        };
        (x, y)
    } else {
        let x = if edge == 1 {
            bbox.x + bbox.width
        } else {
            bbox.x
        };
        (x, center.1 + tangent * (x - center.0))
    };
    (point, edge)
}

fn wedge(bbox: BoundingBox, center: (f64, f64), start: i32, end: i32) -> Vec<(f64, f64)> {
    let (a, edge_a) = ray(bbox, center, start);
    let (b, edge_b) = ray(bbox, center, end);
    let mut points = vec![center, a];
    if edge_a != edge_b {
        // native는 교차한 두 변에 닿는 하나의 사각형 꼭짓점을 끼운다.
        points.push((
            if edge_a == 3 || edge_b == 3 {
                bbox.x
            } else if edge_a == 1 || edge_b == 1 {
                bbox.x + bbox.width
            } else {
                b.0
            },
            if edge_a == 2 || edge_b == 2 {
                bbox.y + bbox.height
            } else if edge_a == 0 || edge_b == 0 {
                bbox.y
            } else {
                b.1
            },
        ));
    }
    points.push(b);
    points
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finite_conical_fan_preserves_steps_colors_and_mirrored_angles() {
        let gradient = GradientFillInfo {
            gradient_type: 3,
            angle: 90,
            center_x: 0,
            center_y: 0,
            step: 50,
            step_center: 50,
            colors: vec![0x00ffffcc, 0x00ffffff],
            positions: vec![],
        };
        let bounds = BoundingBox::new(0.0, 0.0, 100.0, 40.0);
        let polygons = conical_polygons(&gradient, bounds).unwrap();
        assert_eq!(polygons.len(), 100);
        assert_eq!(polygons[0].color, gradient.colors[0]);
        assert_eq!(polygons[98].color, gradient.colors[1]);
        assert_eq!(polygons[48].color & 255, 228);
        assert!(polygons
            .iter()
            .flat_map(|p| &p.points)
            .all(|p| p.0.is_finite() && p.1.is_finite()));
        assert_eq!(rounded_mul_div(3, 1, 2), 2);
        assert_eq!(rounded_mul_div(-3, 1, 2), -2);
        let mut odd = gradient.clone();
        odd.step = 5;
        let polygons = conical_polygons(&odd, bounds).unwrap();
        assert_eq!(polygons.len(), 12);
        assert_eq!(polygons.last().unwrap().color, odd.colors[1]);
        for (cx, cy) in [(0, 0), (0, 100), (100, 0), (100, 100), (50, 50)] {
            odd.center_x = cx;
            odd.center_y = cy;
            assert!(conical_polygons(&odd, bounds)
                .unwrap()
                .iter()
                .flat_map(|p| &p.points)
                .all(|p| p.0.is_finite() && p.1.is_finite()));
        }
        let mut solid = gradient.clone();
        solid.colors[1] = solid.colors[0];
        assert!(conical_polygons(&solid, bounds).is_none());
        odd.gradient_type = 1;
        assert!(conical_polygons(&odd, bounds).is_none());
    }
    #[test]
    fn conical_rectangle_replays_finite_colors_in_svg_json_and_native_pixels() {
        use crate::renderer::render_tree::{
            PageRenderTree, RectangleNode, RenderNode, RenderNodeType,
        };
        use crate::renderer::ShapeStyle;
        let gradient = GradientFillInfo {
            gradient_type: 3,
            angle: 90,
            center_x: 0,
            center_y: 0,
            step: 50,
            step_center: 50,
            colors: vec![0x00ffffcc, 0x00ffffff],
            positions: vec![],
        };
        let mut tree = PageRenderTree::new(0, 120.0, 60.0);
        tree.root.children.push(RenderNode::new(
            1,
            RenderNodeType::Rectangle(RectangleNode::new(
                0.0,
                ShapeStyle::default(),
                Some(Box::new(gradient)),
            )),
            BoundingBox::new(5.0, 5.0, 100.0, 40.0),
        ));
        let mut svg = crate::renderer::svg::SvgRenderer::new();
        svg.render_tree(&tree);
        assert_eq!(svg.output().matches("<polygon ").count(), 100);
        assert!(!svg.output().contains("linearGradient"));
        let layers =
            crate::paint::LayerBuilder::new(crate::paint::RenderProfile::Print).build(&tree);
        let json: serde_json::Value = serde_json::from_str(&layers.to_json()).unwrap();
        fn find_fan(value: &serde_json::Value) -> Option<&serde_json::Value> {
            if let Some(fan) = value.get("conicalPolygons") {
                return Some(fan);
            }
            match value {
                serde_json::Value::Array(values) => values.iter().find_map(find_fan),
                serde_json::Value::Object(values) => values.values().find_map(find_fan),
                _ => None,
            }
        }
        assert_eq!(find_fan(&json).unwrap().as_array().unwrap().len(), 100);
        #[cfg(feature = "native-skia")]
        {
            let rendered = crate::renderer::skia::SkiaLayerRenderer::new()
                .render_raster_with_options(
                    &layers,
                    crate::renderer::layer_renderer::RasterRenderOptions::default(),
                )
                .unwrap();
            let pixels = image::load_from_memory(&rendered.bytes).unwrap().to_rgba8();
            let vertical = pixels.get_pixel(15, 35).0;
            let horizontal = pixels.get_pixel(85, 10).0;
            assert!(
                vertical[0] > horizontal[0] + 8,
                "finite cyan/white fan must vary by angle: {vertical:?} vs {horizontal:?}"
            );
            assert!(
                vertical[0] < 254,
                "last wedge must not overpaint lower fan white: {vertical:?}"
            );
            assert_eq!(vertical[1], 255);
            assert_eq!(horizontal[2], 255);
        }
    }
}

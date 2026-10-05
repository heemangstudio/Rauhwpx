//! 렌더러가 공유하는 그림 샘플러.

/// 확대·혼합 축 그림을 정수 디바이스 영역에 샘플링한다.
/// 채널은 합성하지 않고 각각 처리해 투명 픽셀의 RGB를 보존한다.
pub(crate) fn gridfit_affine_sample(
    encoded: &[u8],
    source: (f32, f32, f32, f32),
    width: u32,
    height: u32,
    nearest: bool,
) -> Option<Vec<u8>> {
    let decoded = image::load_from_memory(encoded).ok()?.to_rgba8();
    let (source_width, source_height) = decoded.dimensions();
    gridfit_affine_sample_rgba(
        decoded.as_raw(),
        source_width,
        source_height,
        source,
        width,
        height,
        nearest,
    )
}

pub(crate) fn gridfit_affine_sample_rgba(
    pixels: &[u8],
    source_width: u32,
    source_height: u32,
    source: (f32, f32, f32, f32),
    width: u32,
    height: u32,
    nearest: bool,
) -> Option<Vec<u8>> {
    const MAX_AXIS: usize = 16_384;
    const MAX_PIXELS: usize = 16_777_216;
    const ONE: i64 = 1 << 14;
    let (left, top, right, bottom) = source;
    let source_len = (source_width as usize)
        .checked_mul(source_height as usize)?
        .checked_mul(4)?;
    let target_len = (width as usize)
        .checked_mul(height as usize)?
        .checked_mul(4)?;
    if source_width == 0
        || source_height == 0
        || width == 0
        || height == 0
        || source_width as usize > MAX_AXIS
        || source_height as usize > MAX_AXIS
        || width as usize > MAX_AXIS
        || height as usize > MAX_AXIS
        || (width as usize).checked_mul(height as usize)? > MAX_PIXELS
        || pixels.len() != source_len
        || ![left, top, right, bottom]
            .iter()
            .all(|value| value.is_finite())
        || left < 0.0
        || top < 0.0
        || right > source_width as f32
        || bottom > source_height as f32
        || right <= left
        || bottom <= top
    {
        return None;
    }
    // 고정소수점 보간은 시작 좌표와 한 픽셀 이동량을 각각 한 번만 절삭한다.
    // 매 픽셀의 실수 좌표를 다시 절삭하면 긴 그림에서 샘플 위상이 달라진다.
    let scale_x = (right - left) as f64 / width as f64;
    let scale_y = (bottom - top) as f64 / height as f64;
    let sample_offset = if nearest { 0 } else { ONE / 2 };
    let start_x = ((left as f64 + 0.5 * scale_x) * ONE as f64).trunc() as i64 - sample_offset;
    let start_y = ((top as f64 + 0.5 * scale_y) * ONE as f64).trunc() as i64 - sample_offset;
    let step_x = (scale_x * ONE as f64).trunc() as i64;
    let step_y = (scale_y * ONE as f64).trunc() as i64;
    let horizontal: Vec<_> = (0..width)
        .map(|x| {
            let fixed = start_x + x as i64 * step_x;
            let base = fixed >> 14;
            let first = base.clamp(0, source_width as i64 - 1) as usize;
            let second = if nearest {
                first
            } else {
                (base + 1).clamp(0, source_width as i64 - 1) as usize
            };
            (first, second, if nearest { 0 } else { fixed & (ONE - 1) })
        })
        .collect();
    let mut output = vec![0; target_len];
    for y in 0..height as usize {
        let fixed = start_y + y as i64 * step_y;
        let base_y = fixed >> 14;
        let first_y = base_y.clamp(0, source_height as i64 - 1) as usize;
        let second_y = if nearest {
            first_y
        } else {
            (base_y + 1).clamp(0, source_height as i64 - 1) as usize
        };
        let fraction_y = if nearest { 0 } else { fixed & (ONE - 1) };
        for (x, &(first_x, second_x, fraction_x)) in horizontal.iter().enumerate() {
            let target = (y * width as usize + x) * 4;
            let a = (first_y * source_width as usize + first_x) * 4;
            let b = (first_y * source_width as usize + second_x) * 4;
            let c = (second_y * source_width as usize + first_x) * 4;
            let d = (second_y * source_width as usize + second_x) * 4;
            for channel in 0..4 {
                let top = pixels[a + channel] as i64
                    + (((pixels[b + channel] as i64 - pixels[a + channel] as i64) * fraction_x)
                        >> 14);
                let bottom = pixels[c + channel] as i64
                    + (((pixels[d + channel] as i64 - pixels[c + channel] as i64) * fraction_x)
                        >> 14);
                output[target + channel] =
                    (top + (((bottom - top) * fraction_y) >> 14)).clamp(0, 255) as u8;
            }
        }
    }
    Some(output)
}

/// 인코딩된 그림의 비합성 RGBA 채널을 각각 축소한다.
pub(crate) fn smooth_hermite_downsample(
    encoded: &[u8],
    source: (f32, f32, f32, f32),
    width: u32,
    height: u32,
) -> Option<Vec<u8>> {
    let decoded = image::load_from_memory(encoded).ok()?.to_rgba8();
    let (source_width, source_height) = decoded.dimensions();
    smooth_hermite_downsample_rgba(
        decoded.as_raw(),
        source_width,
        source_height,
        source,
        width,
        height,
    )
}

/// CanvasKit도 디코딩된 원본의 비합성 RGBA 픽셀을 이 경로에 전달한다.
pub(crate) fn smooth_hermite_downsample_rgba(
    pixels: &[u8],
    source_width: u32,
    source_height: u32,
    source: (f32, f32, f32, f32),
    width: u32,
    height: u32,
) -> Option<Vec<u8>> {
    // 가로 가중치와 중간 래스터의 할당 크기를 모두 제한한다.
    const MAX_AXIS: usize = 16_384;
    const MAX_PIXELS: usize = 16_777_216;
    let (left, top, right, bottom) = source;
    if source_width as usize > MAX_AXIS
        || source_height as usize > MAX_AXIS
        || width as usize > MAX_AXIS
        || height as usize > MAX_AXIS
        || source_width == 0
        || source_height == 0
        || width == 0
        || height == 0
        || ![left, top, right, bottom].iter().all(|v| v.is_finite())
        || right <= left
        || bottom <= top
        || left < 0.0
        || top < 0.0
        || right > source_width as f32
        || bottom > source_height as f32
        || (width as usize).checked_mul(height as usize)? > MAX_PIXELS
        || (width as usize).checked_mul(source_height as usize)? > MAX_PIXELS
        || (source_width as usize)
            .checked_mul(source_height as usize)?
            .checked_mul(4)?
            != pixels.len()
    {
        return None;
    }

    let horizontal_weights: Vec<_> = (0..width as usize)
        .map(|x| {
            weights(
                left as f64,
                right as f64,
                width as usize,
                x,
                source_width as usize,
            )
        })
        .collect();
    let mut horizontal = vec![0; width as usize * source_height as usize * 4];
    for y in 0..source_height as usize {
        for x in 0..width as usize {
            let weights = &horizontal_weights[x];
            let target = (y * width as usize + x) * 4;
            for channel in 0..4 {
                let value: f64 = weights
                    .iter()
                    .map(|&(source_x, weight)| {
                        pixels[(y * source_width as usize + source_x) * 4 + channel] as f64 * weight
                    })
                    .sum();
                horizontal[target + channel] = value.round().clamp(0.0, 255.0) as u8;
            }
        }
    }

    let mut output = vec![0; width as usize * height as usize * 4];
    for y in 0..height as usize {
        let weights = weights(
            top as f64,
            bottom as f64,
            height as usize,
            y,
            source_height as usize,
        );
        for x in 0..width as usize {
            let target = (y * width as usize + x) * 4;
            for channel in 0..4 {
                let value: f64 = weights
                    .iter()
                    .map(|&(source_y, weight)| {
                        horizontal[(source_y * width as usize + x) * 4 + channel] as f64 * weight
                    })
                    .sum();
                output[target + channel] = value.round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    Some(output)
}

fn weights(
    start: f64,
    end: f64,
    count: usize,
    output: usize,
    source_count: usize,
) -> Vec<(usize, f64)> {
    let scale = (end - start) / count as f64;
    let radius = scale.max(1.0);
    let center = start + (output as f64 + 0.5) * scale;
    let first =
        ((center - radius - 0.5).floor() as isize).clamp(0, source_count as isize - 1) as usize;
    let last =
        ((center + radius - 0.5).ceil() as isize).clamp(0, source_count as isize - 1) as usize;
    let mut result = Vec::new();
    let mut total = 0.0;
    for index in first..=last.max(first) {
        let distance = ((index as f64 + 0.5 - center) / radius).abs();
        if distance < 1.0 {
            let weight = 1.0 - 3.0 * distance * distance + 2.0 * distance * distance * distance;
            result.push((index, weight));
            total += weight;
        }
    }
    if total > 0.0 {
        for (_, weight) in &mut result {
            *weight /= total;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{gridfit_affine_sample_rgba, smooth_hermite_downsample_rgba};

    #[test]
    fn bilinear_coordinates_accumulate_quantized_steps_on_both_axes() {
        let mut source = Vec::new();
        for y in 0..8 {
            for x in 0..8 {
                source.extend_from_slice(&[(x % 2 * 255) as u8, (y % 2 * 255) as u8, 0, 255]);
            }
        }
        let result =
            gridfit_affine_sample_rgba(&source, 8, 8, (0.0, 0.0, 8.0, 8.0), 11, 11, false).unwrap();
        // 8/11 픽셀 이동량을 14비트로 절삭한 뒤 누적한 인덱스 4의 샘플이다.
        assert_eq!(
            &result[(4 * 11 + 4) * 4..(4 * 11 + 4) * 4 + 4],
            &[196, 196, 0, 255]
        );
    }

    #[test]
    fn enlarged_edge_clamps_to_source_pixels() {
        let source = [0, 0, 0, 0, 255, 255, 255, 255];
        let result =
            gridfit_affine_sample_rgba(&source, 2, 1, (0.0, 0.0, 2.0, 1.0), 4, 1, false).unwrap();
        let channels: Vec<_> = result.chunks_exact(4).map(|pixel| pixel[0]).collect();
        assert_eq!(channels, [0, 63, 191, 255]);
        assert!(result.chunks_exact(4).all(|pixel| pixel[0] == pixel[3]));
    }

    #[test]
    fn large_magnification_uses_source_pixels_without_blending() {
        let source = [0, 0, 0, 255, 255, 255, 255, 255];
        let result =
            gridfit_affine_sample_rgba(&source, 2, 1, (0.0, 0.0, 2.0, 1.0), 6, 1, true).unwrap();
        let channels: Vec<_> = result.chunks_exact(4).map(|pixel| pixel[0]).collect();
        assert_eq!(channels, [0, 0, 0, 255, 255, 255]);
    }

    #[test]
    fn transparent_rgb_is_filtered_independently_of_alpha() {
        let black_clear = [0, 0, 0, 0];
        let white_opaque = [255, 255, 255, 255];
        let source = [black_clear, white_opaque, black_clear, white_opaque].concat();
        let result =
            smooth_hermite_downsample_rgba(&source, 2, 2, (0.0, 0.0, 2.0, 2.0), 1, 1).unwrap();
        assert_eq!(result, [128, 128, 128, 128]);
    }
}

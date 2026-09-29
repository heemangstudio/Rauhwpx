use crate::wmf::{imports::*, parser::*};

#[derive(Clone)]
pub struct Bitmap(Vec<u8>);

impl core::fmt::Debug for Bitmap {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_tuple("Bitmap")
            .field(&format!("[u8; {}]", self.0.len()))
            .finish()
    }
}

impl Bitmap {
    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }

    pub fn to_vec(self) -> Vec<u8> {
        self.0
    }
}

impl From<DeviceIndependentBitmap> for Bitmap {
    fn from(dib: DeviceIndependentBitmap) -> Self {
        let dib = dib.expand_color_palette();

        // 펼치지 않은 팔레트 DIB(RLE 압축, 너무 큰 그림)는 색상표를 BMP 에 그대로
        // 싣는다. 색상표가 없으면 BMP 디코더가 인덱스를 해석할 수 없다.
        let palette: Vec<u8> = match &dib.colors {
            Colors::RGBQuad(values) => values
                .iter()
                .flat_map(|v| [v.blue, v.green, v.red, 0])
                .collect(),
            Colors::RGBTriple(values) => values
                .iter()
                .flat_map(|v| [v.blue, v.green, v.red])
                .collect(),
            Colors::Null | Colors::PaletteIndices(_) => Vec::new(),
        };

        let mut info_header = vec![];
        let mut file_size: u32 = 0;

        // write info header
        match dib.dib_header_info {
            BitmapInfoHeader::Core(BitmapInfoHeaderCore {
                header_size,
                width,
                height,
                planes,
                bit_count,
            }) => {
                file_size += header_size;
                info_header.extend(header_size.to_le_bytes());
                info_header.extend(width.to_le_bytes());
                info_header.extend(height.to_le_bytes());
                info_header.extend(planes.to_le_bytes());
                info_header.extend((bit_count as u16).to_le_bytes());
            }
            BitmapInfoHeader::Info(BitmapInfoHeaderInfo {
                header_size,
                width,
                height,
                planes,
                bit_count,
                compression,
                image_size,
                x_pels_per_meter,
                y_pels_per_meter,
                color_used,
                color_important,
            }) => {
                file_size += header_size;
                info_header.extend(header_size.to_le_bytes());
                info_header.extend(width.to_le_bytes());
                info_header.extend(height.to_le_bytes());
                info_header.extend(planes.to_le_bytes());
                info_header.extend((bit_count as u16).to_le_bytes());
                info_header.extend((compression as u32).to_le_bytes());
                info_header.extend(image_size.to_le_bytes());
                info_header.extend(x_pels_per_meter.to_le_bytes());
                info_header.extend(y_pels_per_meter.to_le_bytes());
                info_header.extend(color_used.to_le_bytes());
                info_header.extend(color_important.to_le_bytes());
            }
            BitmapInfoHeader::V4(BitmapInfoHeaderV4 {
                header_size,
                width,
                height,
                planes,
                bit_count,
                compression,
                image_size,
                x_pels_per_meter,
                y_pels_per_meter,
                color_used,
                color_important,
                red_mask,
                green_mask,
                blue_mask,
                alpha_mask,
                color_space_type,
                endpoints,
                gamma_red,
                gamma_green,
                gamma_blue,
            }) => {
                file_size += header_size;
                info_header.extend(header_size.to_le_bytes());
                info_header.extend(width.to_le_bytes());
                info_header.extend(height.to_le_bytes());
                info_header.extend(planes.to_le_bytes());
                info_header.extend((bit_count as u16).to_le_bytes());
                info_header.extend((compression as u32).to_le_bytes());
                info_header.extend(image_size.to_le_bytes());
                info_header.extend(x_pels_per_meter.to_le_bytes());
                info_header.extend(y_pels_per_meter.to_le_bytes());
                info_header.extend(color_used.to_le_bytes());
                info_header.extend(color_important.to_le_bytes());
                info_header.extend(red_mask.to_le_bytes());
                info_header.extend(green_mask.to_le_bytes());
                info_header.extend(blue_mask.to_le_bytes());
                info_header.extend(alpha_mask.to_le_bytes());
                info_header.extend((color_space_type as u32).to_le_bytes());
                info_header.extend(endpoints.red.x.to_le_bytes());
                info_header.extend(endpoints.red.y.to_le_bytes());
                info_header.extend(endpoints.red.z.to_le_bytes());
                info_header.extend(endpoints.green.x.to_le_bytes());
                info_header.extend(endpoints.green.y.to_le_bytes());
                info_header.extend(endpoints.green.z.to_le_bytes());
                info_header.extend(endpoints.blue.x.to_le_bytes());
                info_header.extend(endpoints.blue.y.to_le_bytes());
                info_header.extend(endpoints.blue.z.to_le_bytes());
                info_header.extend(gamma_red.to_le_bytes());
                info_header.extend(gamma_green.to_le_bytes());
                info_header.extend(gamma_blue.to_le_bytes());
            }
            BitmapInfoHeader::V5(BitmapInfoHeaderV5 {
                header_size,
                width,
                height,
                planes,
                bit_count,
                compression,
                image_size,
                x_pels_per_meter,
                y_pels_per_meter,
                color_used,
                color_important,
                red_mask,
                green_mask,
                blue_mask,
                alpha_mask,
                color_space_type,
                endpoints,
                gamma_red,
                gamma_green,
                gamma_blue,
                intent,
                profile_data,
                profile_size,
                reserved,
            }) => {
                file_size += header_size;
                info_header.extend(header_size.to_le_bytes());
                info_header.extend(width.to_le_bytes());
                info_header.extend(height.to_le_bytes());
                info_header.extend(planes.to_le_bytes());
                info_header.extend((bit_count as u16).to_le_bytes());
                info_header.extend((compression as u32).to_le_bytes());
                info_header.extend(image_size.to_le_bytes());
                info_header.extend(x_pels_per_meter.to_le_bytes());
                info_header.extend(y_pels_per_meter.to_le_bytes());
                info_header.extend(color_used.to_le_bytes());
                info_header.extend(color_important.to_le_bytes());
                info_header.extend(red_mask.to_le_bytes());
                info_header.extend(green_mask.to_le_bytes());
                info_header.extend(blue_mask.to_le_bytes());
                info_header.extend(alpha_mask.to_le_bytes());
                info_header.extend((color_space_type as u32).to_le_bytes());
                info_header.extend(endpoints.red.x.to_le_bytes());
                info_header.extend(endpoints.red.y.to_le_bytes());
                info_header.extend(endpoints.red.z.to_le_bytes());
                info_header.extend(endpoints.green.x.to_le_bytes());
                info_header.extend(endpoints.green.y.to_le_bytes());
                info_header.extend(endpoints.green.z.to_le_bytes());
                info_header.extend(endpoints.blue.x.to_le_bytes());
                info_header.extend(endpoints.blue.y.to_le_bytes());
                info_header.extend(endpoints.blue.z.to_le_bytes());
                info_header.extend(gamma_red.to_le_bytes());
                info_header.extend(gamma_green.to_le_bytes());
                info_header.extend(gamma_blue.to_le_bytes());
                info_header.extend((intent as u32).to_le_bytes());
                info_header.extend(profile_data.to_le_bytes());
                info_header.extend(profile_size.to_le_bytes());
                info_header.extend(reserved.to_le_bytes());
            }
        }

        // write color table (팔레트 길이는 최대 256 항목)
        file_size += palette.len() as u32;
        info_header.extend(palette);

        // write pixel data
        let data = dib.bitmap_buffer.a_data;
        let data_len = u32::try_from(data.len()).expect("should be as u32");
        file_size += data_len;

        // write file headers
        let mut file_header = vec![];
        file_size += 14;
        file_header.extend(b"BM");
        file_header.extend(file_size.to_le_bytes());
        file_header.extend(0u32.to_le_bytes());
        file_header.extend((file_size - data_len).to_le_bytes());

        let data = {
            file_header.extend(info_header);
            file_header.extend(data);
            file_header
        };

        Self(data)
    }
}

impl From<(ColorRef, HatchStyle)> for Bitmap {
    fn from((color_ref, brush_hatch): (ColorRef, HatchStyle)) -> Self {
        let mut a_data = Vec::with_capacity(100);

        match brush_hatch {
            HatchStyle::HS_HORIZONTAL => {
                for i in 0..10 {
                    if i == 0 {
                        a_data.extend([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
                    } else {
                        a_data.extend([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
                    }
                }
            }
            HatchStyle::HS_VERTICAL => {
                a_data.extend(
                    vec![[1, 0, 0, 0, 0, 0, 0, 0, 0, 0]; 10]
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>(),
                );
            }
            HatchStyle::HS_FDIAGONAL => {
                for i in 0..10 {
                    for j in 0..10 {
                        if i + j == 9 {
                            a_data.push(1);
                        } else {
                            a_data.push(0);
                        }
                    }
                }
            }
            HatchStyle::HS_BDIAGONAL => {
                for i in 0..10 {
                    for j in 0..10 {
                        if i == j {
                            a_data.push(1);
                        } else {
                            a_data.push(0);
                        }
                    }
                }
            }
            HatchStyle::HS_CROSS => {
                for i in 0..10 {
                    if i == 0 {
                        a_data.extend([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
                    } else {
                        a_data.extend([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
                    }
                }
            }
            HatchStyle::HS_DIAGCROSS => {
                for i in 0..10 {
                    for j in 0..10 {
                        if i == j || i + j == 9 {
                            a_data.push(1);
                        } else {
                            a_data.push(0);
                        }
                    }
                }
            }
        }

        // 한 픽셀이 팔레트 인덱스 1바이트(8bpp)다. DIB 줄은 DWORD 경계로 맞추므로
        // 10바이트 줄마다 2바이트를 덧댄다. 예전에는 24bpp 로 선언해 줄 길이(32바이트)가
        // 데이터(100바이트)와 맞지 않아 팔레트 펼치기에서 범위 밖 슬라이스로 패닉했다.
        let a_data: Vec<u8> = a_data
            .chunks(10)
            .flat_map(|row| row.iter().copied().chain([0, 0]))
            .collect();

        DeviceIndependentBitmap {
            dib_header_info: BitmapInfoHeader::Info(BitmapInfoHeaderInfo {
                header_size: 40,
                width: 10,
                height: 10,
                planes: 1,
                bit_count: BitCount::BI_BITCOUNT_3,
                compression: Compression::BI_RGB,
                image_size: 0,
                x_pels_per_meter: 0,
                y_pels_per_meter: 0,
                color_used: 0,
                color_important: 0,
            }),
            colors: Colors::RGBTriple(vec![
                RGBTriple {
                    red: 0,
                    green: 0,
                    blue: 0,
                },
                RGBTriple {
                    red: color_ref.red,
                    green: color_ref.green,
                    blue: color_ref.blue,
                },
            ]),
            bitmap_buffer: BitmapBuffer {
                undefined_space: vec![],
                a_data,
            },
        }
        .into()
    }
}

/// 한 줄의 바이트 수 (`width * bits` 비트를 DWORD 경계로 올림). 넘치면 None.
fn dword_aligned_line_bytes(width: usize, bits: usize) -> Option<usize> {
    let line_bits = width.checked_mul(bits)?;
    Some(line_bits.checked_add(31)? / 32 * 4)
}

impl DeviceIndependentBitmap {
    /// aData 가 비압축 기하(폭×높이×비트)대로 놓여 있는지. `size()` 가 공식으로
    /// 길이를 셈하는 경우와 같다. RLE/JPEG/PNG 는 ImageSize 만큼의 압축 스트림이라
    /// 줄 단위로 자르면 안 된다.
    fn has_uncompressed_rows(&self) -> bool {
        match &self.dib_header_info {
            BitmapInfoHeader::Core(_) => true,
            BitmapInfoHeader::Info(BitmapInfoHeaderInfo { compression, .. })
            | BitmapInfoHeader::V4(BitmapInfoHeaderV4 { compression, .. })
            | BitmapInfoHeader::V5(BitmapInfoHeaderV5 { compression, .. }) => matches!(
                compression,
                Compression::BI_RGB | Compression::BI_BITFIELDS | Compression::BI_CMYK
            ),
        }
    }

    fn expand_color_palette(self) -> Self {
        // nothing to do.
        if matches!(
            self.colors,
            crate::wmf::parser::Colors::Null | crate::wmf::parser::Colors::PaletteIndices(_)
        ) || !self.has_uncompressed_rows()
        {
            return self;
        }

        let bit_count = self.dib_header_info.bit_count();
        let new_bit_count = crate::wmf::parser::BitCount::BI_BITCOUNT_5;
        let width = self.dib_header_info.width();
        // 펼친 결과는 BMP→PNG 디코더 한도를 넘으면 어차피 버려진다. 1bpp 를 24bpp 로
        // 펼치면 24배로 불어나므로(압축된 0 바이트 수백 KB 가 GB 단위가 된다) 한도를
        // 넘는 그림은 펼치지 않고 색상표째 싣는다.
        let height = self.dib_header_info.height();
        let max_dimension = crate::renderer::image_header::CANVASKIT_MAX_IMAGE_DIMENSION as usize;
        let max_pixels = crate::renderer::image_header::CANVASKIT_MAX_IMAGE_PIXELS;
        if width > max_dimension
            || height > max_dimension
            || (width as u64) * (height as u64) > max_pixels
        {
            return self;
        }
        // 폭은 신뢰할 수 없는 값이다. 줄 길이 계산이 넘치거나 0 이면(빈 줄을 높이만큼,
        // 최대 2^31 번 도는 루프가 된다) 펼치지 않는다.
        let (Some(line_bytes), Some(new_line_bytes)) = (
            dword_aligned_line_bytes(width, bit_count as usize),
            dword_aligned_line_bytes(width, new_bit_count as usize),
        ) else {
            return self;
        };
        if line_bytes == 0 {
            return self;
        }
        let new_line_padding = new_line_bytes - width * (new_bit_count as usize / 8);

        let Self {
            dib_header_info,
            colors,
            bitmap_buffer,
        } = self;
        let palette: Vec<_> = match colors {
            Colors::RGBTriple(values) => values
                .into_iter()
                .map(|v| vec![v.red, v.green, v.blue])
                .collect(),
            Colors::RGBQuad(values) => values
                .into_iter()
                .map(|v| vec![v.red, v.green, v.blue])
                .collect(),
            _ => unreachable!(),
        };

        let mut position: usize = 0;
        let mut new_data = vec![];

        for _ in 0..dib_header_info.height() {
            // aData 가 선언 높이보다 짧으면(잘린 입력) 있는 줄까지만 펼친다.
            let Some(row) = bitmap_buffer
                .a_data
                .get(position..position.saturating_add(line_bytes))
            else {
                break;
            };
            let mut reader = BitReader::new(row);

            for _ in 0..dib_header_info.width() {
                let Some(idx) = reader.read_bits(bit_count as u8) else {
                    break;
                };

                let rgb = palette
                    .get(idx as usize)
                    .cloned()
                    .unwrap_or_else(|| vec![0xFF, 0xFF, 0xFF]);

                new_data.extend(rgb);
            }

            new_data.extend(vec![0; new_line_padding]);
            position += line_bytes;
        }

        Self {
            dib_header_info: match dib_header_info {
                // 펼친 aData 는 24bpp 다. Core 헤더도 비트 수를 맞춰야 BMP 로 읽힌다.
                crate::wmf::parser::BitmapInfoHeader::Core(v) => {
                    crate::wmf::parser::BitmapInfoHeader::Core(
                        crate::wmf::parser::BitmapInfoHeaderCore {
                            bit_count: new_bit_count,
                            ..v
                        },
                    )
                }
                crate::wmf::parser::BitmapInfoHeader::Info(v) => {
                    crate::wmf::parser::BitmapInfoHeader::Info(
                        crate::wmf::parser::BitmapInfoHeaderInfo {
                            bit_count: new_bit_count,
                            ..v
                        },
                    )
                }
                crate::wmf::parser::BitmapInfoHeader::V4(v) => {
                    crate::wmf::parser::BitmapInfoHeader::V4(
                        crate::wmf::parser::BitmapInfoHeaderV4 {
                            bit_count: new_bit_count,
                            ..v
                        },
                    )
                }
                crate::wmf::parser::BitmapInfoHeader::V5(v) => {
                    crate::wmf::parser::BitmapInfoHeader::V5(
                        crate::wmf::parser::BitmapInfoHeaderV5 {
                            bit_count: new_bit_count,
                            ..v
                        },
                    )
                }
            },
            colors: crate::wmf::parser::Colors::Null,
            bitmap_buffer: crate::wmf::parser::BitmapBuffer {
                undefined_space: vec![],
                a_data: new_data,
            },
        }
    }
}

struct BitReader<'a> {
    data: &'a [u8],
    byte_index: usize,
    bit_index: u8,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        BitReader {
            data,
            byte_index: 0,
            bit_index: 0,
        }
    }

    fn read_bits(&mut self, num_bits: u8) -> Option<u32> {
        if num_bits == 0 || num_bits > 32 {
            return None;
        }

        let mut value = 0u32;
        for _ in 0..num_bits {
            if self.byte_index >= self.data.len() {
                return None;
            }

            let bit = (self.data[self.byte_index] >> (7 - self.bit_index)) & 1;
            value = (value << 1) | u32::from(bit);

            self.bit_index += 1;
            if self.bit_index >= 8 {
                self.bit_index = 0;
                self.byte_index += 1;
            }
        }

        Some(value)
    }
}

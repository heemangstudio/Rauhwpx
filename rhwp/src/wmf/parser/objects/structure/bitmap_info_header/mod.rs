mod core;
mod info;
mod v4;
mod v5;

pub use self::{core::*, info::*, v4::*, v5::*};

#[derive(Clone, Debug)]
pub enum BitmapInfoHeader {
    Core(BitmapInfoHeaderCore),
    Info(BitmapInfoHeaderInfo),
    V4(BitmapInfoHeaderV4),
    V5(BitmapInfoHeaderV5),
}

impl BitmapInfoHeader {
    pub fn parse<R: crate::wmf::Read>(
        buf: &mut R,
    ) -> Result<(Self, usize), crate::wmf::parser::ParseError> {
        let (header_size, mut consumed_bytes) = crate::wmf::parser::read_u32_from_le_bytes(buf)?;

        match header_size {
            0x0000000C => {
                let (header, c) = BitmapInfoHeaderCore::parse(buf, header_size)?;
                consumed_bytes += c;

                Ok((Self::Core(header), consumed_bytes))
            }
            13..=40 => {
                let (header, c) = BitmapInfoHeaderInfo::parse(buf, header_size)?;
                consumed_bytes += c;

                Ok((Self::Info(header), consumed_bytes))
            }
            41..=108 => {
                let (header, c) = BitmapInfoHeaderV4::parse(buf, header_size)?;
                consumed_bytes += c;

                Ok((Self::V4(header), consumed_bytes))
            }
            109..=124 => {
                let (header, c) = BitmapInfoHeaderV5::parse(buf, header_size)?;
                consumed_bytes += c;

                Ok((Self::V5(header), consumed_bytes))
            }
            _ => Err(crate::wmf::parser::ParseError::UnexpectedPattern {
                cause: format!(
                    "The header_size `{header_size:#10X}` field is not match \
                     as any BitmapInfoHeader format"
                ),
            }),
        }
    }

    pub fn header_size(&self) -> u32 {
        match self {
            Self::Core(BitmapInfoHeaderCore { header_size, .. })
            | Self::Info(BitmapInfoHeaderInfo { header_size, .. })
            | Self::V4(BitmapInfoHeaderV4 { header_size, .. })
            | Self::V5(BitmapInfoHeaderV5 { header_size, .. }) => *header_size,
        }
    }

    pub fn bit_count(&self) -> crate::wmf::parser::BitCount {
        match self {
            Self::Core(BitmapInfoHeaderCore { bit_count, .. })
            | Self::Info(BitmapInfoHeaderInfo { bit_count, .. })
            | Self::V4(BitmapInfoHeaderV4 { bit_count, .. })
            | Self::V5(BitmapInfoHeaderV5 { bit_count, .. }) => *bit_count,
        }
    }

    /// aData 바이트 수 (MS-WMF 2.2.2.9 BitmapBuffer).
    ///
    /// 폭·높이·평면 수는 신뢰할 수 없는 값이다. 예전의 u16(Core)/u32(Info) 산술은
    /// 256×256 8bpp Core DIB 나 폭 i32::MAX 인 Info DIB 에서 넘쳐 디버그 빌드는
    /// 패닉하고 릴리스 빌드는 0 이 돼 뒤의 줄 자르기가 패닉했다. u64 로 계산하고,
    /// 넘치면 `usize::MAX` 로 포화한다 — 읽기 단계(`read_variable`)가 입력 부족으로
    /// 깔끔히 실패한다.
    pub fn size(&self) -> usize {
        fn packed_size(width: u64, planes: u64, bit_count: u64, height: u64) -> Option<u64> {
            let row_bits = width.checked_mul(planes)?.checked_mul(bit_count)?;
            let row_bytes = (row_bits.checked_add(31)? & !31) / 8;
            row_bytes.checked_mul(height)
        }

        let size = match self {
            Self::Core(BitmapInfoHeaderCore {
                width,
                height,
                planes,
                bit_count,
                ..
            }) => packed_size(
                u64::from(*width),
                u64::from(*planes),
                u64::from(*bit_count as u16),
                u64::from(*height),
            ),
            Self::Info(BitmapInfoHeaderInfo {
                width,
                height,
                planes,
                bit_count,
                image_size,
                compression,
                ..
            })
            | Self::V4(BitmapInfoHeaderV4 {
                width,
                height,
                planes,
                bit_count,
                image_size,
                compression,
                ..
            })
            | Self::V5(BitmapInfoHeaderV5 {
                width,
                height,
                planes,
                bit_count,
                image_size,
                compression,
                ..
            }) => match compression {
                crate::wmf::parser::Compression::BI_RGB
                | crate::wmf::parser::Compression::BI_BITFIELDS
                | crate::wmf::parser::Compression::BI_CMYK => packed_size(
                    u64::from(width.unsigned_abs()),
                    u64::from(*planes),
                    u64::from(*bit_count as u16),
                    u64::from(height.unsigned_abs()),
                ),
                _ => Some(u64::from(*image_size)),
            },
        };

        size.and_then(|size| usize::try_from(size).ok())
            .unwrap_or(usize::MAX)
    }

    pub fn color_used(&self) -> u32 {
        match self {
            Self::Core(BitmapInfoHeaderCore { bit_count, .. }) => 2u32.pow(*bit_count as u32),
            Self::Info(BitmapInfoHeaderInfo {
                bit_count,
                color_used,
                ..
            })
            | Self::V4(BitmapInfoHeaderV4 {
                bit_count,
                color_used,
                ..
            })
            | Self::V5(BitmapInfoHeaderV5 {
                bit_count,
                color_used,
                ..
            }) => {
                if *color_used == 0
                    && matches!(
                        bit_count,
                        crate::wmf::parser::BitCount::BI_BITCOUNT_1
                            | crate::wmf::parser::BitCount::BI_BITCOUNT_2
                            | crate::wmf::parser::BitCount::BI_BITCOUNT_3
                    )
                {
                    2u32.pow(*bit_count as u32)
                } else {
                    *color_used
                }
            }
        }
    }

    pub fn height(&self) -> usize {
        match self {
            Self::Core(BitmapInfoHeaderCore { height, .. }) => usize::from(*height),
            // A negative Height indicates a top-down DIB (MS-WMF 2.2.2.9);
            // the pixel height is the magnitude, matching `size()`'s use of
            // `unsigned_abs()` below.
            Self::Info(BitmapInfoHeaderInfo { height, .. })
            | Self::V4(BitmapInfoHeaderV4 { height, .. })
            | Self::V5(BitmapInfoHeaderV5 { height, .. }) => height.unsigned_abs() as usize,
        }
    }

    pub fn width(&self) -> usize {
        match self {
            Self::Core(BitmapInfoHeaderCore { width, .. }) => usize::from(*width),
            Self::Info(BitmapInfoHeaderInfo { width, .. })
            | Self::V4(BitmapInfoHeaderV4 { width, .. })
            // 파서는 양수 폭만 받지만 필드가 pub 이다. 음수가 들어와도 `as usize` 로
            // 거대한 값이 되지 않도록 `height()`·`size()` 와 같이 크기만 쓴다.
            | Self::V5(BitmapInfoHeaderV5 { width, .. }) => width.unsigned_abs() as usize,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // MS-WMF 2.2.2.9: a negative Height indicates a top-down DIB; the
    // absolute value is still the pixel height. `height()` must return the
    // magnitude, matching what `size()` already does via `unsigned_abs()`.
    #[test]
    fn height_of_top_down_dib_is_absolute_value() {
        let header = BitmapInfoHeader::Info(BitmapInfoHeaderInfo {
            header_size: 40,
            width: 10,
            height: -10,
            planes: 1,
            bit_count: crate::wmf::parser::BitCount::BI_BITCOUNT_5,
            compression: crate::wmf::parser::Compression::BI_RGB,
            image_size: 0,
            x_pels_per_meter: 0,
            y_pels_per_meter: 0,
            color_used: 0,
            color_important: 0,
        });

        assert_eq!(header.height(), 10);
    }
}

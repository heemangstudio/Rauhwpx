const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

pub(crate) const CANVASKIT_MAX_IMAGE_DIMENSION: u32 = 8192;
pub(crate) const CANVASKIT_MAX_IMAGE_PIXELS: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CanvasKitEncodedImageFormat {
    Png,
    Jpeg,
    Gif,
    WebP,
    Bmp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CanvasKitEncodedImageHeader {
    pub format: CanvasKitEncodedImageFormat,
    pub width: u32,
    pub height: u32,
}

impl CanvasKitEncodedImageHeader {
    pub(crate) fn is_within_decode_limits(self) -> bool {
        self.width <= CANVASKIT_MAX_IMAGE_DIMENSION
            && self.height <= CANVASKIT_MAX_IMAGE_DIMENSION
            && u64::from(self.width).saturating_mul(u64::from(self.height))
                <= CANVASKIT_MAX_IMAGE_PIXELS
    }
}

pub(crate) fn canvaskit_encoded_image_header(bytes: &[u8]) -> Option<CanvasKitEncodedImageHeader> {
    parse_png_header(bytes)
        .or_else(|| parse_gif_header(bytes))
        .or_else(|| parse_webp_header(bytes))
        .or_else(|| parse_bmp_header(bytes))
        .or_else(|| parse_jpeg_header(bytes))
}

fn parse_png_header(bytes: &[u8]) -> Option<CanvasKitEncodedImageHeader> {
    if bytes.len() < 33
        || &bytes[..8] != PNG_SIGNATURE
        || read_be_u32(bytes, 8)? != 13
        || &bytes[12..16] != b"IHDR"
    {
        return None;
    }

    let width = read_be_u32(bytes, 16)?;
    let height = read_be_u32(bytes, 20)?;
    let bit_depth = bytes[24];
    let color_type = bytes[25];
    let valid_depth = match color_type {
        0 => matches!(bit_depth, 1 | 2 | 4 | 8 | 16),
        2 | 4 | 6 => matches!(bit_depth, 8 | 16),
        3 => matches!(bit_depth, 1 | 2 | 4 | 8),
        _ => false,
    };
    if width == 0
        || height == 0
        || !valid_depth
        || bytes[26] != 0
        || bytes[27] != 0
        || bytes[28] > 1
    {
        return None;
    }

    Some(CanvasKitEncodedImageHeader {
        format: CanvasKitEncodedImageFormat::Png,
        width,
        height,
    })
}

fn parse_gif_header(bytes: &[u8]) -> Option<CanvasKitEncodedImageHeader> {
    if bytes.len() < 13 || !matches!(&bytes[..6], b"GIF87a" | b"GIF89a") {
        return None;
    }

    let width = u32::from(read_le_u16(bytes, 6)?);
    let height = u32::from(read_le_u16(bytes, 8)?);
    if width == 0 || height == 0 {
        return None;
    }

    let packed = bytes[10];
    if packed & 0x80 != 0 {
        let color_count = 1usize.checked_shl(u32::from((packed & 0x07) + 1))?;
        let header_len = 13usize.checked_add(color_count.checked_mul(3)?)?;
        if bytes.len() < header_len {
            return None;
        }
    }

    Some(CanvasKitEncodedImageHeader {
        format: CanvasKitEncodedImageFormat::Gif,
        width,
        height,
    })
}

fn parse_webp_header(bytes: &[u8]) -> Option<CanvasKitEncodedImageHeader> {
    if bytes.len() < 20 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return None;
    }

    let riff_end = usize::try_from(read_le_u32(bytes, 4)?)
        .ok()?
        .checked_add(8)?;
    if riff_end > bytes.len() || riff_end < 20 {
        return None;
    }
    let chunk_len = usize::try_from(read_le_u32(bytes, 16)?).ok()?;
    let chunk_end = 20usize.checked_add(chunk_len)?.checked_add(chunk_len & 1)?;
    if chunk_end > riff_end || chunk_end > bytes.len() {
        return None;
    }

    let (width, height) = match &bytes[12..16] {
        b"VP8X" if chunk_len >= 10 => (
            read_le_u24(bytes, 24)?.checked_add(1)?,
            read_le_u24(bytes, 27)?.checked_add(1)?,
        ),
        b"VP8 " if chunk_len >= 10 && &bytes[23..26] == b"\x9d\x01\x2a" => (
            u32::from(read_le_u16(bytes, 26)? & 0x3fff),
            u32::from(read_le_u16(bytes, 28)? & 0x3fff),
        ),
        b"VP8L" if chunk_len >= 5 && bytes[20] == 0x2f => {
            let bits = read_le_u32(bytes, 21)?;
            (
                (bits & 0x3fff).checked_add(1)?,
                ((bits >> 14) & 0x3fff).checked_add(1)?,
            )
        }
        _ => return None,
    };
    if width == 0 || height == 0 {
        return None;
    }

    Some(CanvasKitEncodedImageHeader {
        format: CanvasKitEncodedImageFormat::WebP,
        width,
        height,
    })
}

fn parse_bmp_header(bytes: &[u8]) -> Option<CanvasKitEncodedImageHeader> {
    if bytes.len() < 54 || &bytes[..2] != b"BM" {
        return None;
    }

    let dib_len = usize::try_from(read_le_u32(bytes, 14)?).ok()?;
    let dib_end = 14usize.checked_add(dib_len)?;
    if dib_len < 40 || dib_end > bytes.len() {
        return None;
    }
    let pixel_offset = usize::try_from(read_le_u32(bytes, 10)?).ok()?;
    if pixel_offset < dib_end || read_le_u16(bytes, 26)? != 1 {
        return None;
    }
    if !matches!(read_le_u16(bytes, 28)?, 1 | 4 | 8 | 16 | 24 | 32) {
        return None;
    }

    let width = read_le_i32(bytes, 18)?;
    let height = read_le_i32(bytes, 22)?;
    if width <= 0 || height == 0 || height == i32::MIN {
        return None;
    }

    Some(CanvasKitEncodedImageHeader {
        format: CanvasKitEncodedImageFormat::Bmp,
        width: width as u32,
        height: height.unsigned_abs(),
    })
}

fn parse_jpeg_header(bytes: &[u8]) -> Option<CanvasKitEncodedImageHeader> {
    if bytes.len() < 4 || !bytes.starts_with(b"\xff\xd8") {
        return None;
    }

    let mut offset = 2usize;
    while offset < bytes.len() {
        if bytes[offset] != 0xff {
            return None;
        }
        while offset < bytes.len() && bytes[offset] == 0xff {
            offset += 1;
        }
        let marker = *bytes.get(offset)?;
        offset += 1;

        if marker == 0x00 || matches!(marker, 0xd8..=0xda) {
            return None;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }

        let segment_len = usize::from(read_be_u16(bytes, offset)?);
        if segment_len < 2 {
            return None;
        }
        let segment_end = offset.checked_add(segment_len)?;
        if segment_end > bytes.len() {
            return None;
        }

        let is_start_of_frame =
            (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc);
        if is_start_of_frame {
            if segment_len < 11 {
                return None;
            }
            let component_count = usize::from(*bytes.get(offset + 7)?);
            if component_count == 0
                || segment_len != 8usize.checked_add(component_count.checked_mul(3)?)?
            {
                return None;
            }
            let height = u32::from(read_be_u16(bytes, offset + 3)?);
            let width = u32::from(read_be_u16(bytes, offset + 5)?);
            if width == 0 || height == 0 {
                return None;
            }
            return Some(CanvasKitEncodedImageHeader {
                format: CanvasKitEncodedImageFormat::Jpeg,
                width,
                height,
            });
        }

        offset = segment_end;
    }
    None
}

fn read_be_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn read_le_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn read_be_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn read_le_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn read_le_i32(bytes: &[u8], offset: usize) -> Option<i32> {
    Some(i32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn read_le_u24(bytes: &[u8], offset: usize) -> Option<u32> {
    let value = bytes.get(offset..offset + 3)?;
    Some(u32::from(value[0]) | (u32::from(value[1]) << 8) | (u32::from(value[2]) << 16))
}


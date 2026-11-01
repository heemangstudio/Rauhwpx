use crate::wmf::imports::*;


/// The Region Object defines a potentially non-rectilinear shape defined by an
/// array of scanlines.
#[derive(Clone, Debug)]
pub struct Region {
    /// nextInChain (2 bytes): A value that MUST be ignored. (Windows sets this
    /// field to `0x0000` .)
    pub next_in_chain: u16,
    /// ObjectType (2 bytes): A 16-bit signed integer that specifies the region
    /// identifier. It MUST be `0x0006`.
    pub object_type: i16,
    /// ObjectCount (4 bytes): A value that MUST be ignored. (Windows sets this
    /// field to an arbitrary value.)
    pub object_count: u32,
    /// RegionSize (2 bytes): A 16-bit signed integer that defines the size of
    /// the region in bytes plus the size of aScans in bytes.
    pub size: i16,
    /// ScanCount (2 bytes): A 16-bit signed integer that defines the number of
    /// scanlines composing the region.
    pub scan_count: i16,
    /// maxScan (2 bytes): A 16-bit signed integer that defines the maximum
    /// number of points in any one scan in this region.
    pub max_scan: i16,
    /// BoundingRectangle (8 bytes): A Rect Object that defines the bounding
    /// rectangle.
    pub bounding_rectangle: crate::wmf::parser::Rect,
    /// aScans (variable): An array of Scan Objects that define the scanlines
    /// in the region.
    pub a_scans: Vec<crate::wmf::parser::Scan>,
}

impl Region {
    #[cfg_attr(feature = "tracing", tracing::instrument(
        level = tracing::Level::TRACE,
        skip_all,
        err(level = tracing::Level::ERROR, Display),
    ))]
    pub fn parse<R: crate::wmf::Read>(
        buf: &mut R,
    ) -> Result<(Self, usize), crate::wmf::parser::ParseError> {
        let (
            (next_in_chain, next_in_chain_bytes),
            (object_type, object_type_bytes),
            (object_count, object_count_bytes),
            (size, size_bytes),
            (scan_count, scan_count_bytes),
            (max_scan, max_scan_bytes),
            (bounding_rectangle, bounding_rectangle_bytes),
        ) = (
            crate::wmf::parser::read_u16_from_le_bytes(buf)?,
            crate::wmf::parser::read_i16_from_le_bytes(buf)?,
            crate::wmf::parser::read_u32_from_le_bytes(buf)?,
            crate::wmf::parser::read_i16_from_le_bytes(buf)?,
            crate::wmf::parser::read_i16_from_le_bytes(buf)?,
            crate::wmf::parser::read_i16_from_le_bytes(buf)?,
            crate::wmf::parser::Rect::parse(buf)?,
        );

        let mut consumed_bytes = next_in_chain_bytes
            + object_type_bytes
            + object_count_bytes
            + size_bytes
            + scan_count_bytes
            + max_scan_bytes
            + bounding_rectangle_bytes;
        if scan_count < 0 {
            return Err(crate::wmf::parser::ParseError::UnexpectedPattern {
                cause: format!("The scan_count field `{scan_count}` must not be negative"),
            });
        }
        let mut a_scans = Vec::with_capacity(scan_count as usize);

        for _ in 0..scan_count {
            let (v, c) = crate::wmf::parser::Scan::parse(buf)?;

            consumed_bytes += c;
            a_scans.push(v);
        }

        if object_type != 0x0006 {
            return Err(crate::wmf::parser::ParseError::UnexpectedPattern {
                cause: "The object_type field must be 0x0006".to_owned(),
            });
        }

        Ok((
            Self {
                next_in_chain,
                object_type,
                object_count,
                size,
                scan_count,
                max_scan,
                bounding_rectangle,
                a_scans,
            },
            consumed_bytes,
        ))
    }
}

//! DocInfo resource-table look-up helpers.
//!
//! This module is the **only** place in `hangulang` that imports rhwp types.
//! All other modules work exclusively with the crate's own Semantic IR.
//!
//! ## Binary-data 2-hop lookup
//!
//! `Picture.image_attr.bin_data_id` (a `u16`) is the **storage ID** of the
//! embedded binary stream inside the HWP CFB container.  The parser populates
//! `Document.bin_data_content` with entries whose `id` field equals that same
//! storage ID (`BinDataContent { id: bd.storage_id, data, extension }`).
//! Therefore the lookup is a direct linear scan over `bin_data_content` for an
//! entry whose `id` matches the requested `bin_data_id`.
//!
//! Source evidence:
//! - `src/parser/mod.rs:631,1137` — `id: bd.storage_id` when building content vec
//! - `src/parser/control/shape.rs:304` — comment: "bin_data_id ← DocInfo BinData 목록의 storage_id"

use crate::model::document::{DocInfo, Document};
use crate::model::style::{CharShape, Font, ParaShape};

/// Look up a `CharShape` by its zero-based index into `DocInfo.char_shapes`.
///
/// Returns `None` if `id` is out of range.
pub fn char_shape(doc_info: &DocInfo, id: u32) -> Option<&CharShape> {
    doc_info.char_shapes.get(id as usize)
}

/// Look up a `ParaShape` by its zero-based index into `DocInfo.para_shapes`.
///
/// Returns `None` if `id` is out of range.
pub fn para_shape(doc_info: &DocInfo, id: u16) -> Option<&ParaShape> {
    doc_info.para_shapes.get(id as usize)
}

/// Resolve a binary-data ID to its decoded byte slice and file extension.
///
/// `bin_data_id` is the value stored in `Picture.image_attr.bin_data_id`.  It
/// equals the CFB storage ID used as the `id` field in `BinDataContent`.
///
/// Returns `Some((Vec<u8>, &str))` — the raw (already-decompressed) image bytes
/// and the lowercase file extension (e.g. `"jpg"`, `"png"`) — or `None` if
/// the content was not found or the data slice is empty.
///
/// The bytes are returned owned because rhwp's
/// [`BinDataBytes`](crate::model::bin_data::BinDataBytes) may resolve them lazily
/// from the source container (`BinDataBytes::Lazy`), so there is no stable borrow
/// to hand back; `BinDataBytes::load` decompresses on demand.
pub fn bin_data_bytes(document: &Document, bin_data_id: u16) -> Option<(Vec<u8>, &str)> {
    if bin_data_id == 0 {
        return None;
    }
    document
        .bin_data_content
        .iter()
        .find(|c| c.id == bin_data_id && !c.data.is_empty())
        .map(|c| (c.data.load(), c.extension.as_str()))
}

/// Look up a font name by language index and font ID.
///
/// `DocInfo.font_faces` is a `Vec<Vec<Font>>` where the outer index is the
/// language slot (0=한글, 1=영어, 2=한자, 3=일어, 4=기타, 5=기호, 6=사용자)
/// and the inner index is the font ID referenced by `CharShape.font_ids[lang]`.
///
/// Returns `None` if either index is out of range.
pub fn font_name(doc_info: &DocInfo, lang_idx: usize, font_id: u16) -> Option<&str> {
    doc_info
        .font_faces
        .get(lang_idx)
        .and_then(|faces: &Vec<Font>| faces.get(font_id as usize))
        .map(|f| f.name.as_str())
}


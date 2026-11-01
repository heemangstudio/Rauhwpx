//! Table lowering — rhwp [`Table`] → crate-IR [`ir::Table`].
//!
//! rhwp stores tables as a flat list of **anchor cells** (`Table.cells`), each
//! carrying its zero-based `(col, row)` origin plus `col_span`/`row_span`.
//! Non-anchor (merged-over) grid positions are *not* present in `cells`; they
//! are only referenced by `Table.cell_grid` (a `row*col_count+col` → anchor
//! index map).  Our IR uses the same anchor-only convention
//! ([`ir::Table::cells`] documents this), so the mapping is a direct 1:1
//! transform of `Table.cells` → [`ir::TableCell`] with no grid expansion.
//!
//! # Paragraph-conversion callback contract
//!
//! Each rhwp [`Cell`] owns a `Vec<Paragraph>` whose lowering into block-level
//! [`Block`] nodes lives in the paragraph adapter (task T5).  To keep *this*
//! module free of any dependency on `paragraph.rs` (which is built in a later
//! wave and wired here by T8), the per-cell paragraph conversion is injected as
//! a callback:
//!
//! ```ignore
//! convert_paragraphs: &dyn Fn(&[crate::model::paragraph::Paragraph]) -> Vec<Block>
//! ```
//!
//! The callback is invoked once per cell with that cell's `paragraphs` slice and
//! must return the cell's block content (including any nested
//! [`Block::Table`] for tables-within-tables).  T8 supplies the real closure
//! that delegates to the T5 paragraph adapter; the unit tests below pass a
//! trivial stub.
//!
//! # Caption
//!
//! rhwp's [`Caption`](crate::model::shape::Caption) is a paragraph list.  We
//! flatten every caption paragraph through [`extract_inlines`] and concatenate
//! the results into [`ir::Table::caption`] (`Option<Vec<Inline>>`).  Caption
//! *direction* / *width* / *spacing* have no DocLang counterpart; if a caption
//! is present we record a single [`LossKind::Caption`] entry noting the dropped
//! geometry so lean-mode audits stay honest (plan Critic N4).
//!
//! # Defensive clamping
//!
//! A malformed document could place a cell origin outside the declared
//! `row_count`/`col_count` grid.  Such a cell is clamped into range and a
//! [`LossKind::Other`] entry is recorded; this keeps the OTSL writer's grid
//! walk well-formed instead of panicking on an out-of-bounds anchor.

use std::collections::HashSet;

use crate::model::document::DocInfo;
use crate::model::paragraph::Paragraph;
use crate::model::shape::Caption;
use crate::model::table::Table;

use crate::doclang::ir::{Block, Inline, Table as IrTable, TableCell as IrTableCell};
use crate::doclang::loss::report::{LossEntry, LossKind, LossReport};

use super::inline::extract_inlines;

/// Lower a rhwp [`Table`] into the crate IR [`ir::Table`].
///
/// `convert_paragraphs` lowers one cell's paragraph list into block content
/// (see the module-level contract); it is injected so this module has no
/// dependency on the paragraph adapter (`paragraph.rs`, wired by T8).
///
/// `location` is a human-readable source path (e.g. `"s0/p3/tbl"`) used for
/// loss-entry attribution.
///
/// `loss` accumulates lean-mode loss entries: at most one
/// [`LossKind::Caption`] per table (caption geometry) and one
/// [`LossKind::Other`] per out-of-range cell that had to be clamped.
pub(crate) fn convert_table(
    table: &Table,
    doc_info: &DocInfo,
    location: &str,
    convert_paragraphs: &dyn Fn(&[Paragraph]) -> Vec<Block>,
    loss: &mut LossReport,
) -> IrTable {
    let rows = table.row_count;
    let cols = table.col_count;

    let mut cells: Vec<IrTableCell> = Vec::with_capacity(table.cells.len());
    // Track anchor positions already taken so clamping can flag collisions:
    // two out-of-bounds cells clamped to the same corner would otherwise overlap
    // silently. Well-formed tables never collide (every anchor is distinct).
    let mut occupied: HashSet<(u16, u16)> = HashSet::with_capacity(table.cells.len());
    for cell in &table.cells {
        // Defensive: clamp anchor origins that fall outside the declared grid.
        // `rows`/`cols` of 0 would make every coordinate out of range; guard so
        // the clamp target (`rows - 1`) does not underflow.
        let mut col = cell.col;
        let mut row = cell.row;

        if cols == 0 || row >= rows || col >= cols {
            let new_col = if cols == 0 { 0 } else { col.min(cols - 1) };
            let new_row = if rows == 0 { 0 } else { row.min(rows - 1) };
            loss.push(LossEntry {
                kind: LossKind::Other("table-cell-out-of-bounds".to_string()),
                location: location.to_string(),
                detail: format!(
                    "cell ({},{}) outside {}x{} grid, clamped to ({},{})",
                    row, col, rows, cols, new_row, new_col
                ),
            });
            col = new_col;
            row = new_row;
        }

        // If the (possibly clamped) anchor lands on a position already taken,
        // record the collision so the overlap is auditable rather than silent.
        if !occupied.insert((row, col)) {
            loss.push(LossEntry {
                kind: LossKind::Other("table-cell-collision".to_string()),
                location: location.to_string(),
                detail: format!(
                    "cell anchor ({},{}) collides with an earlier cell",
                    row, col
                ),
            });
        }

        // Spans must be at least 1; a malformed 0 span would yield an empty
        // grid region.  Anchor cells legitimately carry span >= 1 in rhwp.
        let col_span = cell.col_span.max(1);
        let row_span = cell.row_span.max(1);

        cells.push(IrTableCell {
            col,
            row,
            col_span,
            row_span,
            is_header: cell.is_header,
            content: convert_paragraphs(&cell.paragraphs),
        });
    }

    let caption = table
        .caption
        .as_ref()
        .and_then(|cap| convert_caption(cap, doc_info, location, loss));

    IrTable {
        rows,
        cols,
        cells,
        caption,
        // Provenance is stamped by the body driver (paragraph.rs), which knows
        // the (section, para, control) position of the owning Table control.
        // Nested tables (lowered through the cell paragraph callback) stay
        // `None` — their indices are cell-local and carry no global provenance.
        prov: None,
    }
}

/// Flatten a rhwp [`Caption`]'s paragraph list into inline content.
///
/// Returns `None` when the caption has no representable inline content (so the
/// IR stores `caption: None` rather than `Some(vec![])`).  Caption geometry
/// (direction / width / spacing) is unrepresentable in DocLang; a single
/// [`LossKind::Caption`] entry records the drop whenever a caption is present.
fn convert_caption(
    caption: &Caption,
    doc_info: &DocInfo,
    location: &str,
    loss: &mut LossReport,
) -> Option<Vec<Inline>> {
    let caption_loc = format!("{}/caption", location);
    let mut inlines: Vec<Inline> = Vec::new();
    for para in &caption.paragraphs {
        inlines.extend(extract_inlines(para, doc_info, &caption_loc, loss));
    }

    // Caption is present → its non-inline geometry is dropped in lean mode.
    loss.push(LossEntry {
        kind: LossKind::Caption,
        location: caption_loc,
        detail: format!(
            "caption direction/width/spacing dropped (direction={:?})",
            caption.direction
        ),
    });

    if inlines.is_empty() {
        None
    } else {
        Some(inlines)
    }
}


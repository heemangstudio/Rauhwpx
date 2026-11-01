//! DocLang v0.6 XML writer.
//!
//! Consumes a [`SirDocument`] (the rhwp-agnostic Semantic IR) and produces a
//! DocLang XML string.  Output is built by manual string concatenation so that
//! raw-payload elements (`<formula>`, `<custom>`) keep precise control over
//! escaping; see [`escape`] for the rationale.
//!
//! ## Element-head ordering
//!
//! DocLang elements place a fixed-order "element head" before their content:
//! `label → thread → xref/href → layer → location → caption → custom`.  This
//! v1 writer only ever emits the `thread` and `caption` members of that head;
//! the others belong to features not yet implemented (xref/href links,
//! layering, v2 `<location>`).  Where the head is emitted it follows that order.
//!
//! ## Whitespace
//!
//! `xml:space="preserve"` is intentionally not emitted (see [`escape`]): the
//! adapter trim-normalises paragraph whitespace, so the writer treats element
//! content whitespace as insignificant.

pub(crate) mod custom;
pub mod escape;
pub mod inline;
pub(crate) mod otsl;

use crate::doclang::error::ConvertError;
use crate::doclang::ir::block::{Block, HeaderFooterApply, ListItem};
use crate::doclang::ir::formula::Formula;
use crate::doclang::ir::prov::{Location, LocationMap, Prov, LOCATION_RESOLUTION};
use crate::doclang::ir::{Section, SirDocument};
use crate::doclang::loss::{LossEntry, LossKind, LossReport};
use crate::doclang::options::{ConvertOptions, Mode};
use crate::doclang::resources::resolve_resource;

use custom::{record_loss, write_custom_payload, write_lost_as_custom};
use escape::{escape_attr, escape_text};
use inline::write_inlines;

/// Serialise a Semantic IR document to DocLang v0.6 XML.
///
/// The root element is `<doclang version="…">` using
/// [`SirDocument::doclang_version`].  Any information that cannot be represented
/// is appended to `loss`.
pub fn write_doclang(
    doc: &SirDocument,
    opts: &ConvertOptions,
    loss: &mut LossReport,
) -> Result<String, ConvertError> {
    write_doclang_with_locations(doc, opts, &LocationMap::new(), loss)
}

/// Serialise a Semantic IR document to DocLang v0.6 XML, emitting v2
/// `<location>` head elements for every block whose [`Prov`] resolves a box in
/// `locs`.
///
/// When `opts.with_location` is `false` (or `locs` is empty) this is
/// byte-identical to [`write_doclang`]: no `<location>` is ever emitted, so the
/// default-off path is a strict superset-free no-op.
pub fn write_doclang_with_locations(
    doc: &SirDocument,
    opts: &ConvertOptions,
    locs: &LocationMap,
    loss: &mut LossReport,
) -> Result<String, ConvertError> {
    let mut out = String::new();

    out.push_str("<doclang version=\"");
    out.push_str(&escape_attr(doc.doclang_version));
    out.push_str("\">");

    for (si, section) in doc.sections.iter().enumerate() {
        write_section(&mut out, section, si, opts, locs, loss);
    }

    out.push_str("</doclang>");
    Ok(out)
}

fn write_section(
    out: &mut String,
    section: &Section,
    si: usize,
    opts: &ConvertOptions,
    locs: &LocationMap,
    loss: &mut LossReport,
) {
    for (bi, block) in section.blocks.iter().enumerate() {
        let loc = format!("section[{si}]/block[{bi}]");
        write_block(out, block, &loc, opts, locs, loss);
    }
}

/// Resolve a block's location box (only when location output is enabled).
fn resolve_loc<'a>(
    opts: &ConvertOptions,
    locs: &'a LocationMap,
    prov: Option<Prov>,
) -> Option<&'a Location> {
    if !opts.with_location {
        return None;
    }
    prov.and_then(|p| locs.get(&p))
}

/// Emit the four `<location value="N" resolution="512"/>` head elements for a
/// resolved box, in DocLang order (x_min, y_min, x_max, y_max). No-op for
/// `None`.
fn emit_location(out: &mut String, loc: Option<&Location>) {
    let Some(l) = loc else { return };
    for value in [l.x_min, l.y_min, l.x_max, l.y_max] {
        out.push_str("<location value=\"");
        out.push_str(&value.to_string());
        out.push_str("\" resolution=\"");
        out.push_str(&LOCATION_RESOLUTION.to_string());
        out.push_str("\"/>");
    }
}

fn write_block(
    out: &mut String,
    block: &Block,
    loc: &str,
    opts: &ConvertOptions,
    locs: &LocationMap,
    loss: &mut LossReport,
) {
    match block {
        Block::Paragraph {
            content,
            lost,
            prov,
        } => {
            out.push_str("<text>");
            // Element-head order: (lost→custom is LAST, so) location precedes it.
            emit_location(out, resolve_loc(opts, locs, *prov));
            emit_or_record_lost(out, lost.as_ref(), loc, opts, loss);
            write_inlines(out, content);
            out.push_str("</text>");
        }

        Block::Heading {
            level,
            content,
            lost,
            prov,
        } => {
            let lvl = clamp_level(*level);
            out.push_str("<heading level=\"");
            out.push_str(&lvl.to_string());
            out.push_str("\">");
            emit_location(out, resolve_loc(opts, locs, *prov));
            emit_or_record_lost(out, lost.as_ref(), loc, opts, loss);
            write_inlines(out, content);
            out.push_str("</heading>");
        }

        Block::List {
            ordered,
            items,
            lost,
            prov,
        } => {
            out.push_str("<list class=\"");
            out.push_str(if *ordered { "ordered" } else { "unordered" });
            out.push_str("\">");
            emit_location(out, resolve_loc(opts, locs, *prov));
            emit_or_record_lost(out, lost.as_ref(), loc, opts, loss);
            for (ii, item) in items.iter().enumerate() {
                let item_loc = format!("{loc}/ldiv[{ii}]");
                write_list_item(out, item, &item_loc, opts, locs, loss);
            }
            out.push_str("</list>");
        }

        Block::Table(table) => {
            otsl::write_table(out, table, loc, opts, locs, loss);
        }

        Block::Picture {
            data,
            extension,
            lost,
            prov,
            ..
        } => {
            let resource = resolve_resource(&opts.resource_policy, loc, extension, data);
            out.push_str("<picture>");
            // Element head: location precedes `<custom>` (lost) which precedes `<src>`.
            emit_location(out, resolve_loc(opts, locs, *prov));
            emit_or_record_lost(out, lost.as_ref(), loc, opts, loss);
            out.push_str("<src uri=\"");
            out.push_str(&escape_attr(&resource.uri));
            out.push_str("\"/></picture>");
        }

        Block::Formula(formula) => {
            write_formula(out, formula, loc, opts, locs, loss);
        }

        Block::PageBreak => {
            out.push_str("<page_break/>");
        }

        Block::Footnote {
            number: _,
            content,
            prov,
        } => {
            // DocLang footnotes are numbered implicitly by document order; the
            // schema (`component_with_semantic_seq`) does not permit a `number`
            // attribute, so the IR's number is intentionally dropped here.
            out.push_str("<footnote>");
            emit_location(out, resolve_loc(opts, locs, *prov));
            write_blocks(out, content, loc, opts, locs, loss);
            out.push_str("</footnote>");
        }

        Block::PageHeader {
            content,
            apply,
            prov,
        } => {
            record_apply_loss(loss, apply, loc, "page_header");
            out.push_str("<page_header>");
            emit_location(out, resolve_loc(opts, locs, *prov));
            write_blocks(out, content, loc, opts, locs, loss);
            out.push_str("</page_header>");
        }

        Block::PageFooter {
            content,
            apply,
            prov,
        } => {
            record_apply_loss(loss, apply, loc, "page_footer");
            out.push_str("<page_footer>");
            emit_location(out, resolve_loc(opts, locs, *prov));
            write_blocks(out, content, loc, opts, locs, loss);
            out.push_str("</page_footer>");
        }

        // Threads mark column / text-box flow boundaries. In DocLang v0.6
        // `<thread>` is NOT a standalone block — it is a member of an element
        // *head* and carries a required `thread_id` of type positiveInteger
        // (no `id`, no `continuation` attribute exist in the schema). We
        // therefore anchor each boundary to an empty `<group>` whose head holds
        // the `<thread>`: `<group><thread thread_id="N"/></group>`. Both the
        // start and every continuation of the same flow share the same numeric
        // id, so a validator/consumer can stitch the segments back together.
        Block::ThreadStart { thread_id } => {
            out.push_str("<group><thread thread_id=\"");
            out.push_str(&thread_id_to_int(thread_id).to_string());
            out.push_str("\"/></group>");
        }

        Block::ThreadContinuation { thread_id } => {
            out.push_str("<group><thread thread_id=\"");
            out.push_str(&thread_id_to_int(thread_id).to_string());
            out.push_str("\"/></group>");
            // The start/continuation distinction has no DocLang v0.6
            // representation (a thread head is identical for every segment);
            // record it so nothing is silently dropped.
            loss.push(LossEntry {
                kind: LossKind::SectionSettings,
                location: loc.to_string(),
                detail: format!(
                    "thread '{thread_id}' continuation marker flattened; DocLang \
                     v0.6 <thread> has no continuation attribute"
                ),
            });
        }

        // In Preserve mode: emit the opaque custom block as-is.
        // In Lean mode: drop the block entirely and record a loss entry so
        // callers know something was elided.
        Block::Custom { namespace, payload } => {
            match opts.mode {
                Mode::Preserve => {
                    // A bare `<custom>` is only valid inside an element head, so
                    // wrap it in a `<group>` (whose head may carry `<custom>`).
                    // The opaque `key=value;` payload becomes `<hwp_prop>`
                    // children — `<custom>` is element-only and attribute-free.
                    out.push_str("<group>");
                    write_custom_payload(out, namespace, payload);
                    out.push_str("</group>");
                }
                Mode::Lean => {
                    // Drop; record as FloatingObject loss (the main source of
                    // adapter-generated Custom blocks is shapes/text-boxes).
                    loss.push(LossEntry {
                        kind: LossKind::FloatingObject,
                        location: loc.to_string(),
                        detail: format!("custom block dropped (ns={})", namespace),
                    });
                }
            }
        }
    }
}

fn write_blocks(
    out: &mut String,
    blocks: &[Block],
    loc: &str,
    opts: &ConvertOptions,
    locs: &LocationMap,
    loss: &mut LossReport,
) {
    for (bi, block) in blocks.iter().enumerate() {
        let child_loc = format!("{loc}/block[{bi}]");
        write_block(out, block, &child_loc, opts, locs, loss);
    }
}

fn write_list_item(
    out: &mut String,
    item: &ListItem,
    loc: &str,
    opts: &ConvertOptions,
    locs: &LocationMap,
    loss: &mut LossReport,
) {
    // Per the DocLang schema, `<ldiv>` is an item-delimiter element whose only
    // permitted child is an optional `<marker>`; the item's actual content
    // (text / nested semantic elements) follows the `<ldiv/>` as siblings
    // within the enclosing `<list>` (schema group `list_item`).
    out.push_str("<ldiv/>");
    write_blocks(out, &item.content, loc, opts, locs, loss);
}

/// In Preserve mode: append `<custom ns="hwp:style">…</custom>` adjacent to
/// the owning element (LAST in element-head order per DocLang spec).
/// In Lean mode: record each non-empty field as a [`LossEntry`].
///
/// Does nothing when `lost` is `None` or all fields are empty.
fn emit_or_record_lost(
    out: &mut String,
    lost: Option<&crate::doclang::ir::style::LostProperties>,
    loc: &str,
    opts: &ConvertOptions,
    loss: &mut LossReport,
) {
    let Some(lost) = lost else { return };
    match opts.mode {
        Mode::Preserve => {
            write_lost_as_custom(out, lost);
        }
        Mode::Lean => {
            record_loss(loss, lost, loc);
        }
    }
}

fn write_formula(
    out: &mut String,
    formula: &Formula,
    loc: &str,
    opts: &ConvertOptions,
    locs: &LocationMap,
    loss: &mut LossReport,
) {
    out.push_str("<formula>");
    emit_location(out, resolve_loc(opts, locs, formula.prov));
    match &formula.latex {
        Some(latex) => out.push_str(&escape_text(latex)),
        None => {
            // No LaTeX available yet (eqedit conversion is a later task). Emit
            // the raw EqEdit script verbatim (escaped) so no content is lost,
            // and record a FormulaFallback loss entry.
            out.push_str(&escape_text(&formula.raw_eqedit));
            loss.push(LossEntry {
                kind: LossKind::FormulaFallback,
                location: loc.to_string(),
                detail: format!(
                    "no LaTeX conversion; emitted raw EqEdit script: {}",
                    formula.raw_eqedit
                ),
            });
        }
    }
    out.push_str("</formula>");
}

/// Clamp a heading level to the DocLang-supported 1..=6 range.
fn clamp_level(level: u8) -> u8 {
    level.clamp(1, 6)
}

/// Map an adapter thread id (e.g. `"col-0"`, `"textbox-3"`) to a DocLang
/// `thread_id`, which the schema types as `xs:positiveInteger` (≥ 1).
///
/// The adapter assigns ids as `"<prefix>-<n>"` with a monotonically increasing
/// `n` starting at 0. We extract the trailing integer and shift it to a
/// 1-based value so it satisfies `positiveInteger`. Ids without a numeric
/// suffix fall back to `1`. The mapping is deterministic and order-preserving,
/// so start and continuation segments of the same flow get the same id.
fn thread_id_to_int(thread_id: &str) -> u64 {
    thread_id
        .rsplit('-')
        .next()
        .and_then(|s| s.parse::<u64>().ok())
        .map(|n| n + 1)
        .unwrap_or(1)
}

/// Record the header/footer page-applicability as a loss.
///
/// DocLang v0.6's `page_header`/`page_footer` (`component_with_semantic_seq`)
/// carry **no `apply` attribute** — the schema cannot express "odd/even/first
/// page only". The IR distinguishes these (HWP stores separate odd/even/first
/// headers), so emitting the distinction would produce schema-invalid XML.
/// We therefore drop it from the output and record a [`LossKind::SectionSettings`]
/// entry. `All` is the representable default and produces no loss.
fn record_apply_loss(loss: &mut LossReport, apply: &HeaderFooterApply, loc: &str, element: &str) {
    let scope = match apply {
        HeaderFooterApply::All => return,
        HeaderFooterApply::Even => "even pages",
        HeaderFooterApply::Odd => "odd pages",
        HeaderFooterApply::First => "first page",
    };
    loss.push(LossEntry {
        kind: LossKind::SectionSettings,
        location: loc.to_string(),
        detail: format!(
            "{element} applies to {scope} only; DocLang v0.6 has no page-scope \
             attribute, so it is rendered for all pages"
        ),
    });
}


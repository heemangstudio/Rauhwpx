//! Preserve-mode `<custom>` emission for HWP-specific lost properties.
//!
//! ## Serialisation format
//!
//! Each [`LostProperties`] is serialised as a sequence of self-closing
//! `<hwp_prop name="…" value="…"/>` child elements inside the outer
//! `<custom>` tag.  The `hwp_` prefix follows DocLang Appendix B's
//! organisation-prefix recommendation (`hwp_` for the HWP vocabulary).
//!
//! ```xml
//! <custom>
//!   <hwp_prop name="ns" value="hwp:style"/>
//!   <hwp_prop name="font_name" value="나눔고딕"/>
//!   <hwp_prop name="font_size" value="100"/>
//!   <hwp_prop name="text_color" value="#ff0000"/>
//!   <hwp_prop name="named_style" value="제목1"/>
//! </custom>
//! ```
//!
//! The DocLang `<custom>` element is **element-only** and carries **no
//! attributes** (XSD: `<xs:any>` children, no `ns` attribute).  The HWP
//! namespace is therefore recorded as a leading `<hwp_prop name="ns" …/>`
//! child rather than an attribute.
//!
//! This format was chosen over nested elements or JSON because:
//! - Every field escapes uniformly via [`escape_attr`] — no second-level
//!   quoting is needed.
//! - Names and values are human-readable without a schema.
//! - Adding new fields never changes the grammar (open-ended KV list).
//! - Round-trip tooling can reconstruct [`LostProperties`] by matching
//!   `name` attributes without parsing XML structure.
//!
//! ## Element-head ordering
//!
//! Per DocLang's element-head spec the `<custom>` element is **last** in
//! the element head.  Callers in [`super::mod`] are responsible for that
//! ordering — this module only produces the `<custom>…</custom>` fragment
//! itself.
//!
//! ## Lean-mode behaviour
//!
//! This module is **only** called in `Preserve` mode.  Lean-mode callers
//! call [`record_loss`] instead, which appends entries to the
//! [`LossReport`] and emits nothing to the XML buffer.

use crate::doclang::ir::style::LostProperties;
use crate::doclang::loss::{LossEntry, LossKind, LossReport};

use super::escape::escape_attr;

// ──────────────────────────────────────────────────────────────────────────────
// Preserve-mode emit
// ──────────────────────────────────────────────────────────────────────────────

/// Append a `<custom ns="hwp:style">…</custom>` block to `out` containing all
/// fields present in `lost`.
///
/// The block is only appended when at least one field is non-empty; if `lost`
/// is entirely default/empty, nothing is written and the function returns
/// `false`.
///
/// Returns `true` if output was written.
pub(crate) fn write_lost_as_custom(out: &mut String, lost: &LostProperties) -> bool {
    let props = collect_props(lost);
    if props.is_empty() {
        return false;
    }

    out.push_str("<custom>");
    push_hwp_prop(out, "ns", "hwp:style");
    for (name, value) in &props {
        push_hwp_prop(out, name, value);
    }
    out.push_str("</custom>");
    true
}

/// Append a `<custom>…</custom>` block carrying an opaque `key=value;` payload
/// (as produced by the adapter for floating objects / shapes).
///
/// The `namespace` is recorded as a leading `<hwp_prop name="ns" …/>` child and
/// each `key=value` pair becomes its own `<hwp_prop>` element.  This keeps the
/// `<custom>` element schema-valid (element-only content, no attributes).
pub(crate) fn write_custom_payload(out: &mut String, namespace: &str, payload: &str) {
    out.push_str("<custom>");
    push_hwp_prop(out, "ns", namespace);
    for pair in payload.split(';') {
        let pair = pair.trim();
        if pair.is_empty() {
            continue;
        }
        match pair.split_once('=') {
            Some((k, v)) => push_hwp_prop(out, k, v),
            None => push_hwp_prop(out, "value", pair),
        }
    }
    out.push_str("</custom>");
}

/// Append a single `<hwp_prop name="…" value="…"/>` element.
///
/// Both `name` and `value` are escaped via [`escape_attr`]; `name` is a
/// trusted ASCII identifier (no escaping needed in practice), but we escape
/// defensively.
fn push_hwp_prop(out: &mut String, name: &str, value: &str) {
    out.push_str("<hwp_prop name=\"");
    out.push_str(&escape_attr(name));
    out.push_str("\" value=\"");
    out.push_str(&escape_attr(value));
    out.push_str("\"/>");
}

/// Collect all non-empty [`LostProperties`] fields as `(name, value)` pairs
/// in a stable order.
fn collect_props(lost: &LostProperties) -> Vec<(&'static str, String)> {
    let mut props: Vec<(&'static str, String)> = Vec::new();

    if let Some(ref s) = lost.named_style {
        if !s.is_empty() {
            props.push(("named_style", s.clone()));
        }
    }
    if let Some(ref f) = lost.font_name {
        if !f.is_empty() {
            props.push(("font_name", f.clone()));
        }
    }
    if let Some(sz) = lost.font_size {
        props.push(("font_size", sz.to_string()));
    }
    if let Some(color) = lost.text_color {
        // Emit as CSS-style hex: #rrggbb
        props.push(("text_color", format!("#{color:06x}")));
    }
    if let Some(ref sec) = lost.section_info {
        if !sec.is_empty() {
            props.push(("section_info", sec.clone()));
        }
    }
    for (k, v) in &lost.extras {
        props.push(("extra", format!("{k}={v}")));
    }

    props
}

// ──────────────────────────────────────────────────────────────────────────────
// Lean-mode loss recording
// ──────────────────────────────────────────────────────────────────────────────

/// Record all non-empty fields of `lost` into `loss` as individual
/// [`LossEntry`] items.  No XML is emitted.
///
/// `location` is a human-readable path string (e.g. `"section[0]/block[2]"`).
pub(crate) fn record_loss(loss: &mut LossReport, lost: &LostProperties, location: &str) {
    if let Some(ref f) = lost.font_name {
        if !f.is_empty() {
            loss.push(LossEntry {
                kind: LossKind::FontInfo,
                location: location.to_string(),
                detail: format!("font_name={f}"),
            });
        }
    }
    if let Some(sz) = lost.font_size {
        loss.push(LossEntry {
            kind: LossKind::FontInfo,
            location: location.to_string(),
            detail: format!("font_size={sz}"),
        });
    }
    if let Some(color) = lost.text_color {
        loss.push(LossEntry {
            kind: LossKind::CharColor,
            location: location.to_string(),
            detail: format!("text_color=#{color:06x}"),
        });
    }
    if let Some(ref s) = lost.named_style {
        if !s.is_empty() {
            loss.push(LossEntry {
                kind: LossKind::NamedStyle,
                location: location.to_string(),
                detail: format!("named_style={s}"),
            });
        }
    }
    if let Some(ref sec) = lost.section_info {
        if !sec.is_empty() {
            loss.push(LossEntry {
                kind: LossKind::SectionSettings,
                location: location.to_string(),
                detail: format!("section_info={sec}"),
            });
        }
    }
    for (k, v) in &lost.extras {
        loss.push(LossEntry {
            kind: LossKind::Other(k.clone()),
            location: location.to_string(),
            detail: format!("{k}={v}"),
        });
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────


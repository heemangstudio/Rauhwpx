//! XML escaping helpers for the DocLang writer.
//!
//! The writer builds output via manual string concatenation (rather than a
//! streaming XML library) because DocLang's `<formula>` and `<custom>` elements
//! carry raw, already-formed payloads whose internal characters must be escaped
//! as ordinary text while the surrounding structure stays literal.  Manual
//! escaping keeps that distinction explicit and makes the OTSL table writer
//! (task T11) easier to layer on top.
//!
//! ## Whitespace handling
//!
//! DocLang v0.6 supports `xml:space="preserve"` on `<content>`, but v1 of this
//! writer does **not** emit it: we trim-normalise paragraph whitespace during
//! adapter lowering, so significant leading/trailing whitespace never reaches
//! the writer.  Tabs are emitted as literal U+0009 characters and hard line
//! breaks as U+000A; XML treats both as insignificant whitespace in element
//! content, which matches the lean-mode "structure, not pixel layout" goal.

/// Escape a string for use in XML **element text** content.
///
/// Escapes the three characters that are significant in character data: `&`,
/// `<`, and `>`.  Quote characters are left untouched (they are only
/// significant inside attribute values; see [`escape_attr`]).
pub fn escape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

/// Escape a string for use in a double-quoted XML **attribute value**.
///
/// In addition to the character-data escapes, this escapes `"` and `'` so the
/// value is safe inside either quoting style; callers always emit attributes
/// with double quotes.
pub fn escape_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}


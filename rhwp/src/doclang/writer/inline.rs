//! Inline content serialisation for the DocLang writer.
//!
//! Converts a slice of [`Inline`] nodes into DocLang inline markup, appending
//! to a caller-supplied `String` buffer.

use crate::doclang::ir::inline::Inline;
use crate::doclang::ir::style::StyleFlags;

use super::escape::{escape_attr, escape_text};

/// Canonical nesting order for inline style tags.
///
/// When several flags are set on a single run they are emitted as nested
/// elements in this fixed order (outermost first): bold → italic → underline →
/// strikethrough → superscript → subscript.  A stable order keeps output
/// deterministic and golden-file comparisons reliable.
fn active_style_tags(flags: &StyleFlags) -> Vec<&'static str> {
    let mut tags = Vec::with_capacity(6);
    if flags.bold {
        tags.push("bold");
    }
    if flags.italic {
        tags.push("italic");
    }
    if flags.underline {
        tags.push("underline");
    }
    if flags.strike {
        tags.push("strikethrough");
    }
    if flags.superscript {
        tags.push("superscript");
    }
    if flags.subscript {
        tags.push("subscript");
    }
    tags
}

/// Write a sequence of inline nodes into `out`.
pub fn write_inlines(out: &mut String, inlines: &[Inline]) {
    for inline in inlines {
        write_inline(out, inline);
    }
}

fn write_inline(out: &mut String, inline: &Inline) {
    match inline {
        Inline::Text(t) => out.push_str(&escape_text(t)),

        Inline::Styled(flags, children) => {
            // Collect the tags that are actually set, in canonical order.
            let active = active_style_tags(flags);

            // Open tags outermost-first …
            for name in &active {
                out.push('<');
                out.push_str(name);
                out.push('>');
            }
            // … inner content …
            write_inlines(out, children);
            // … then close innermost-first.
            for name in active.iter().rev() {
                out.push_str("</");
                out.push_str(name);
                out.push('>');
            }
        }

        // Footnote bodies are emitted as block-level `<footnote>` elements; the
        // inline reference carries no DocLang markup in v1 (footnote numbering
        // is implicit in document order), so we emit nothing here.
        Inline::FootnoteRef(_) => {}

        // Hard line break -> literal newline. DocLang has no `<br/>` element;
        // newline in element content is the idiomatic representation.
        Inline::LineBreak => out.push('\n'),

        // DocLang has no tab element. We emit a single space: the lean-mode goal
        // is logical structure, not pixel-accurate horizontal positioning.
        Inline::Tab => out.push(' '),

        // Hyperlink span -> <href uri="…">anchor</href>.
        Inline::Href { uri, content } => {
            out.push_str("<href uri=\"");
            out.push_str(&escape_attr(uri));
            out.push_str("\">");
            write_inlines(out, content);
            out.push_str("</href>");
        }
    }
}


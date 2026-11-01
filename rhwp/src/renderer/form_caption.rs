//! Form control caption display helpers.
//!
//! HWPX stores form captions with UI-caption escaping semantics. In observed
//! Hancom output, `&&` in a form caption displays as one literal `&`, while the
//! stored value and XML roundtrip must remain unchanged.

use std::borrow::Cow;

pub(crate) fn display_form_caption(caption: &str) -> Cow<'_, str> {
    if !caption.contains("&&") {
        return Cow::Borrowed(caption);
    }

    let mut out = String::with_capacity(caption.len());
    let mut chars = caption.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '&' && chars.peek() == Some(&'&') {
            chars.next();
            out.push('&');
        } else {
            out.push(ch);
        }
    }

    Cow::Owned(out)
}


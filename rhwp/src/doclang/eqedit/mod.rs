//! EqEdit → LaTeX converter.
//!
//! HWP stores equations as a script in Hancom's *EqEdit* language (see
//! [`crate::doclang::ir::formula::Formula::raw_eqedit`]).  This module converts that
//! script to raw LaTeX suitable for a DocLang `<formula>` element (no `$`
//! delimiters).
//!
//! # Design
//!
//! The pipeline is the classic three stages:
//!
//! 1. [`lexer`] — split the script into a flat token stream.
//! 2. [`parser`] — recursive-descent build of a small AST ([`parser::Node`]).
//! 3. [`latex`] — emit LaTeX from the AST.
//!
//! # Error policy
//!
//! Conversion is **permissive by design**.  Unknown commands and identifiers
//! are *not* errors: they pass through as upright `\text{…}` or as a literal
//! command so the caller still gets usable output.  The **only** failure is
//! structurally broken input — unbalanced braces that cannot be recovered —
//! which returns [`EqError`].  Callers (the writer) treat any `Err` as a signal
//! to fall back to a placeholder and record `LossKind::FormulaFallback`.
//!
//! ```
//! use rhwp::doclang::eqedit::convert;
//! assert_eq!(convert("1 over 2").unwrap(), "\\frac{1}{2}");
//! assert!(convert("{ x").is_err()); // unbalanced brace
//! ```

pub mod error;
pub mod latex;
pub mod lexer;
pub mod parser;

pub use error::EqError;

/// The outcome of a successful EqEdit → LaTeX conversion.
///
/// Conversion always produces usable `latex`; `degraded` lists any command-like
/// identifiers (alphabetic, length ≥ 2) that were **not** recognised as commands
/// and therefore fell through to upright `\text{…}`.  A non-empty `degraded`
/// means the LaTeX is structurally valid but *semantically lossy* — e.g. an
/// uppercase `TIMES` that rendered as `\text{TIMES}` instead of `\times`.
/// Callers should keep the `latex` but record the degradation as a loss.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EqOutcome {
    /// The emitted LaTeX (no `$` delimiters).
    pub latex: String,
    /// Command-like identifiers that degraded to `\text{…}` (may be empty).
    pub degraded: Vec<String>,
}

/// Converts an EqEdit `script` into a LaTeX string (no `$` delimiters).
///
/// Returns [`EqError`] only for structurally irrecoverable input (unbalanced
/// braces). Unknown commands/identifiers are passed through, not rejected.
///
/// This is a convenience wrapper over [`convert_with_degraded`] that discards
/// the degraded-token list; use [`convert_with_degraded`] when the caller needs
/// to know whether the conversion was semantically lossy.
///
/// # Examples
///
/// ```
/// use rhwp::doclang::eqedit::convert;
/// assert_eq!(convert("sum from {i=1} to {n} i^2").unwrap(),
///            "\\sum_{i=1}^n i^2");
/// ```
pub fn convert(script: &str) -> Result<String, EqError> {
    convert_with_degraded(script).map(|o| o.latex)
}

/// Converts an EqEdit `script` into LaTeX, also reporting any degraded
/// (command-like-but-unrecognised) tokens.
///
/// Returns [`EqError`] only for structurally irrecoverable input (unbalanced
/// braces). A successful conversion always yields usable LaTeX; inspect
/// [`EqOutcome::degraded`] to learn whether it was semantically lossy.
///
/// # Examples
///
/// ```
/// use rhwp::doclang::eqedit::convert_with_degraded;
/// let out = convert_with_degraded("TIMES").unwrap();
/// // Uppercase commands now resolve, so nothing degrades:
/// assert_eq!(out.latex, "\\times");
/// assert!(out.degraded.is_empty());
/// ```
pub fn convert_with_degraded(script: &str) -> Result<EqOutcome, EqError> {
    let tokens = lexer::lex(script);
    let ast = parser::parse(&tokens)?;
    let (latex, degraded) = latex::emit_with_degraded(&ast);
    Ok(EqOutcome { latex, degraded })
}


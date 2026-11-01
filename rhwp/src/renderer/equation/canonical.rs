//! Canonical Hancom equation-script output for newly edited LaTeX input.

use super::ast::{EqNode, MatrixStyle, PileAlign, SpaceKind};
use super::symbols::{DecoKind, FontStyleKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanonicalScriptError {
    UnsupportedFontStyle(FontStyleKind),
}

#[derive(Clone, Copy)]
struct FontState {
    italic: bool,
    bold: bool,
}

impl FontState {
    fn styled(self, style: FontStyleKind) -> Self {
        match style {
            FontStyleKind::Roman => Self {
                italic: false,
                bold: false,
            },
            FontStyleKind::Italic => Self {
                italic: true,
                ..self
            },
            FontStyleKind::Bold => Self { bold: true, ..self },
            _ => self,
        }
    }
}

pub fn to_hwp_script(node: &EqNode) -> Result<String, CanonicalScriptError> {
    let initial = FontState {
        italic: true,
        bold: false,
    };
    let mut active = initial;
    script_with_style(node, initial, &mut active)
}

/// HWP 글꼴 선언은 중괄호를 넘어 유지된다. 원하는 스타일과 실제 출력 상태를
/// 분리해 상속된 FontStyle에 불필요한 rm/it 경계를 만들지 않는다.
fn script_with_style(
    node: &EqNode,
    state: FontState,
    active: &mut FontState,
) -> Result<String, CanonicalScriptError> {
    let mut output = String::new();
    let has_own_glyph = matches!(
        node,
        EqNode::Text(_)
            | EqNode::Number(_)
            | EqNode::Symbol(_)
            | EqNode::MathSymbol(_)
            | EqNode::Function(_)
            | EqNode::Quoted(_)
            | EqNode::BigOp { .. }
            | EqNode::Limit { .. }
    );
    if has_own_glyph {
        if !state.bold && active.bold {
            output.push_str("rm ");
            *active = active.styled(FontStyleKind::Roman);
        }
        if state.italic != active.italic {
            output.push_str(if state.italic { "it " } else { "rm " });
            *active = active.styled(if state.italic {
                FontStyleKind::Italic
            } else {
                FontStyleKind::Roman
            });
        }
    }
    if state.bold
        && !active.bold
        && !matches!(
            node,
            EqNode::FontDeclaration { .. } | EqNode::FontStyle { .. }
        )
    {
        let old_active = *active;
        active.bold = true;
        let mut body = String::new();
        write_node(node, &mut body, state, active)?;
        *active = old_active;
        output.push_str(&format!("{{bold {{{}}}}}", body.trim()));
    } else {
        write_node(node, &mut output, state, active)?;
    }
    Ok(output.trim().to_string())
}

fn group(
    node: &EqNode,
    state: FontState,
    active: &mut FontState,
) -> Result<String, CanonicalScriptError> {
    Ok(format!("{{{}}}", script_with_style(node, state, active)?))
}

fn write_node(
    node: &EqNode,
    output: &mut String,
    state: FontState,
    active: &mut FontState,
) -> Result<(), CanonicalScriptError> {
    match node {
        EqNode::Row(children) => {
            for child in children {
                let text = script_with_style(child, state, active)?;
                if text.is_empty() {
                    continue;
                }
                if !output.is_empty() && !output.ends_with([' ', '~', '`', '&', '#']) {
                    output.push(' ');
                }
                output.push_str(&text);
            }
        }
        EqNode::OperatorBody(body) => output.push_str(&group(body, state, active)?),
        EqNode::Text(text) => write_text(text, output),
        EqNode::Number(text) | EqNode::Symbol(text) | EqNode::Function(text) => {
            output.push_str(text)
        }
        EqNode::MathSymbol(symbol) => output.push_str(math_symbol_name(symbol)),
        EqNode::Fraction { numer, denom } => {
            output.push_str(&group(numer, state, active)?);
            output.push_str(" over ");
            output.push_str(&group(denom, state, active)?);
        }
        EqNode::Atop { top, bottom } => {
            output.push_str(&group(top, state, active)?);
            output.push_str(" atop ");
            output.push_str(&group(bottom, state, active)?);
        }
        EqNode::Sqrt { index, body } => {
            if let Some(index) = index {
                output.push_str("root ");
                output.push_str(&group(index, state, active)?);
                output.push_str(" of ");
            } else {
                output.push_str("sqrt ");
            }
            output.push_str(&group(body, state, active)?);
        }
        EqNode::Superscript { base, sup } => {
            output.push_str(&group(base, state, active)?);
            output.push('^');
            output.push_str(&group(sup, state, active)?);
        }
        EqNode::Subscript { base, sub } => {
            output.push_str(&group(base, state, active)?);
            output.push('_');
            output.push_str(&group(sub, state, active)?);
        }
        EqNode::SubSup { base, sub, sup } => {
            output.push_str(&group(base, state, active)?);
            output.push('_');
            output.push_str(&group(sub, state, active)?);
            output.push('^');
            output.push_str(&group(sup, state, active)?);
        }
        EqNode::BigOp { symbol, sub, sup } => {
            output.push_str(big_operator_name(symbol));
            if let Some(sub) = sub {
                output.push('_');
                output.push_str(&group(sub, state, active)?);
            }
            if let Some(sup) = sup {
                output.push('^');
                output.push_str(&group(sup, state, active)?);
            }
        }
        EqNode::Limit { is_upper, sub } => {
            output.push_str(if *is_upper { "Lim" } else { "lim" });
            if let Some(sub) = sub {
                output.push('_');
                output.push_str(&group(sub, state, active)?);
            }
        }
        EqNode::Matrix { rows, style } => {
            output.push_str(match style {
                MatrixStyle::Plain => "matrix",
                MatrixStyle::Paren => "pmatrix",
                MatrixStyle::Bracket => "bmatrix",
                MatrixStyle::Vert => "dmatrix",
            });
            output.push_str(" {");
            for (row_index, row) in rows.iter().enumerate() {
                if row_index > 0 {
                    output.push_str(" # ");
                }
                for (column_index, cell) in row.iter().enumerate() {
                    if column_index > 0 {
                        output.push_str(" & ");
                    }
                    output.push_str(&script_with_style(cell, state, active)?);
                }
            }
            output.push('}');
        }
        EqNode::Cases { rows } => write_rows("cases", rows, output, state, active)?,
        EqNode::Pile { rows, align } => write_rows(
            match align {
                PileAlign::Center => "pile",
                PileAlign::Left => "lpile",
                PileAlign::Right => "rpile",
            },
            rows,
            output,
            state,
            active,
        )?,
        EqNode::EqAlign { rows } => {
            output.push_str("eqalign {");
            for (index, (left, right)) in rows.iter().enumerate() {
                if index > 0 {
                    output.push_str(" # ");
                }
                output.push_str(&script_with_style(left, state, active)?);
                output.push_str(" & ");
                output.push_str(&script_with_style(right, state, active)?);
            }
            output.push('}');
        }
        EqNode::Rel { arrow, over, under } => {
            output.push_str(if under.is_some() { "rel " } else { "buildrel " });
            output.push_str(arrow);
            output.push(' ');
            output.push_str(&group(over, state, active)?);
            if let Some(under) = under {
                output.push(' ');
                output.push_str(&group(under, state, active)?);
            }
        }
        EqNode::Paren { left, right, body } => {
            output.push_str("left ");
            output.push_str(bracket_name(left, true));
            output.push(' ');
            output.push_str(&script_with_style(body, state, active)?);
            output.push_str(" right ");
            output.push_str(bracket_name(right, false));
        }
        EqNode::Decoration { kind, body } => {
            output.push_str(decoration_name(*kind));
            output.push(' ');
            output.push_str(&group(body, state, active)?);
        }
        EqNode::FontDeclaration { style, body } => {
            let name = match style {
                FontStyleKind::Roman => "rm",
                FontStyleKind::Italic => "it",
                unsupported => {
                    return Err(CanonicalScriptError::UnsupportedFontStyle(*unsupported))
                }
            };
            output.push_str(name);
            output.push(' ');
            *active = active.styled(*style);
            output.push_str(&script_with_style(body, state.styled(*style), active)?);
        }
        EqNode::FontStyle { style, body } => {
            if !matches!(
                style,
                FontStyleKind::Roman | FontStyleKind::Italic | FontStyleKind::Bold
            ) {
                return Err(CanonicalScriptError::UnsupportedFontStyle(*style));
            }
            if *style == FontStyleKind::Bold {
                let old_active = *active;
                active.bold = true;
                let body = script_with_style(body, state.styled(*style), active)?;
                *active = old_active;
                output.push_str(&format!("{{bold {{{body}}}}}"));
            } else {
                output.push_str(&script_with_style(body, state.styled(*style), active)?);
            }
        }
        EqNode::Color { r, g, b, body } => {
            output.push_str(&format!("color {{{r},{g},{b}}} "));
            output.push_str(&group(body, state, active)?);
        }
        EqNode::Space(SpaceKind::Normal) => output.push('~'),
        EqNode::Space(SpaceKind::Thin) => output.push('`'),
        EqNode::Space(SpaceKind::Tab) => output.push('&'),
        EqNode::Newline => output.push('#'),
        EqNode::Quoted(text) => {
            output.push('"');
            output.push_str(&text.replace('"', "\\\""));
            output.push('"');
        }
        EqNode::Empty => {}
    }
    Ok(())
}

fn write_rows(
    command: &str,
    rows: &[EqNode],
    output: &mut String,
    state: FontState,
    active: &mut FontState,
) -> Result<(), CanonicalScriptError> {
    output.push_str(command);
    output.push_str(" {");
    for (index, row) in rows.iter().enumerate() {
        if index > 0 {
            output.push_str(" # ");
        }
        output.push_str(&script_with_style(row, state, active)?);
    }
    output.push('}');
    Ok(())
}

fn write_text(text: &str, output: &mut String) {
    for character in text.chars() {
        match character {
            '\u{2009}' => output.push('`'),
            '\u{205f}' => output.push_str("``"),
            '\u{2004}' => output.push_str("```"),
            '\u{2002}' => output.push('~'),
            '\u{2003}' => output.push_str("~~"),
            other => output.push(other),
        }
    }
}

fn big_operator_name(symbol: &str) -> &str {
    match symbol {
        "∑" => "sum",
        "∏" => "prod",
        "∐" => "coprod",
        "⋃" => "bigcup",
        "⋂" => "bigcap",
        "⊔" => "bigsqcup",
        "⊎" => "biguplus",
        "⋀" => "bigwedge",
        "⋁" => "bigvee",
        "⊕" => "bigoplus",
        "⊗" => "bigotimes",
        "⊙" => "bigodot",
        "⊖" => "bigominus",
        "⊘" => "bigodiv",
        "∫" => "int",
        "∬" => "dint",
        "∭" => "tint",
        "∮" => "oint",
        "∯" => "odint",
        "∰" => "otint",
        other => other,
    }
}

fn math_symbol_name(symbol: &str) -> &str {
    match symbol {
        "α" => "alpha",
        "β" => "beta",
        "γ" => "gamma",
        "δ" => "delta",
        "ε" => "epsilon",
        "ζ" => "zeta",
        "η" => "eta",
        "θ" => "theta",
        "ϑ" => "vartheta",
        "ι" => "iota",
        "κ" => "kappa",
        "λ" => "lambda",
        "μ" => "mu",
        "ν" => "nu",
        "ξ" => "xi",
        "ο" => "omicron",
        "π" => "pi",
        "ϖ" => "varpi",
        "ρ" => "rho",
        "σ" => "sigma",
        "ς" => "varsigma",
        "τ" => "tau",
        "υ" => "upsilon",
        "φ" => "phi",
        "χ" => "chi",
        "ψ" => "psi",
        "ω" => "omega",
        "Γ" => "Gamma",
        "Δ" => "Delta",
        "Θ" => "Theta",
        "Λ" => "Lambda",
        "Ξ" => "Xi",
        "Π" => "Pi",
        "Σ" => "Sigma",
        "Φ" => "Phi",
        "Ψ" => "Psi",
        "Ω" => "Omega",
        "±" => "pm",
        "∓" => "mp",
        "×" => "times",
        "÷" => "div",
        "⋅" => "cdot",
        "∘" => "circ",
        "•" => "bullet",
        "≠" => "neq",
        "≤" => "leq",
        "≥" => "geq",
        "≈" => "approx",
        "∼" => "sim",
        "≅" => "cong",
        "≡" => "equiv",
        "∝" => "propto",
        "∞" => "inf",
        "∂" => "partial",
        "∅" => "emptyset",
        "∈" => "in",
        "∉" => "notin",
        "⊂" => "subset",
        "⊃" => "superset",
        "⊆" => "subseteq",
        "⊇" => "supseteq",
        "∪" => "union",
        "∩" => "inter",
        "∀" => "forall",
        "∃" => "exist",
        "¬" => "lnot",
        "∧" => "wedge",
        "∨" => "vee",
        "⊕" => "oplus",
        "⊗" => "otimes",
        "∴" => "therefore",
        "∵" => "because",
        "←" => "larrow",
        "→" => "rarrow",
        "↑" => "uparrow",
        "↓" => "downarrow",
        "↔" => "lrarrow",
        "⇐" => "LARROW",
        "⇒" => "RARROW",
        "⇔" => "LRARROW",
        "↦" => "mapsto",
        "↗" => "nearrow",
        "↘" => "searrow",
        "∫" => "int",
        "∬" => "dint",
        "∭" => "tint",
        "∮" => "oint",
        "∯" => "odint",
        "∰" => "otint",
        "ℓ" => "ell",
        "ℏ" => "hbar",
        "ℵ" => "aleph",
        "⋯" => "cdots",
        "…" => "ldots",
        "⋮" => "vdots",
        "⋱" => "ddots",
        "△" => "BASE",
        "∆" => "triangle",
        "∠" => "angle",
        "⊥" => "bot",
        "°" => "deg",
        "†" => "dagger",
        "‡" => "ddagger",
        "★" => "star",
        "℃" => "CENTIGRADE",
        "′" => "prime",
        other => other,
    }
}

fn bracket_name(value: &str, left: bool) -> &str {
    match value {
        "" => ".",
        "{" => "lbrace",
        "}" => "rbrace",
        "⌈" => "lceil",
        "⌉" => "rceil",
        "⌊" => "lfloor",
        "⌋" => "rfloor",
        "⟨" => "langle",
        "⟩" => "rangle",
        value if value == "(" && !left => ")",
        value if value == ")" && left => "(",
        other => other,
    }
}

fn decoration_name(kind: DecoKind) -> &'static str {
    match kind {
        DecoKind::Hat => "hat",
        DecoKind::Check => "check",
        DecoKind::Tilde => "tilde",
        DecoKind::Acute => "acute",
        DecoKind::Grave => "grave",
        DecoKind::Dot => "dot",
        DecoKind::DDot => "ddot",
        DecoKind::Bar => "bar",
        DecoKind::Vec => "vec",
        DecoKind::Dyad => "dyad",
        DecoKind::Under => "under",
        DecoKind::Arch => "arch",
        DecoKind::Underline => "UNDERLINE",
        DecoKind::Overline => "OVERLINE",
        DecoKind::StrikeThrough => "NOT",
    }
}


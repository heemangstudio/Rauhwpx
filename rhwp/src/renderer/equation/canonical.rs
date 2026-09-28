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
    script_with_style(
        node,
        FontState {
            italic: true,
            bold: false,
        },
        &mut false,
    )
}

// HWP rm persists across braces. A later child under a scoped bold style must
// reopen its own bold argument after rm has cleared the active weight.
fn begins_bold_scope(node: &EqNode) -> bool {
    match node {
        EqNode::FontStyle {
            style: FontStyleKind::Bold,
            ..
        } => true,
        EqNode::FontStyle {
            style: FontStyleKind::Roman | FontStyleKind::Italic,
            body,
        } => begins_bold_scope(body),
        _ => false,
    }
}

fn script_with_style(
    node: &EqNode,
    state: FontState,
    roman_declared: &mut bool,
) -> Result<String, CanonicalScriptError> {
    let mut output = String::new();
    if state.bold && *roman_declared && !begins_bold_scope(node) {
        let mut scoped_declaration = false;
        write_node(node, &mut output, state, &mut scoped_declaration)?;
        let bold = format!("{{bold {{{}}}}}", output.trim());
        return Ok(if state.italic {
            bold
        } else {
            format!("{{rm {{{bold}}}}}")
        });
    }
    write_node(node, &mut output, state, roman_declared)?;
    Ok(output.trim().to_string())
}

fn group(
    node: &EqNode,
    state: FontState,
    roman_declared: &mut bool,
) -> Result<String, CanonicalScriptError> {
    Ok(format!(
        "{{{}}}",
        script_with_style(node, state, roman_declared)?
    ))
}

fn write_node(
    node: &EqNode,
    output: &mut String,
    state: FontState,
    roman_declared: &mut bool,
) -> Result<(), CanonicalScriptError> {
    match node {
        EqNode::Row(children) => {
            for child in children {
                let text = script_with_style(child, state, roman_declared)?;
                if text.is_empty() {
                    continue;
                }
                if !output.is_empty() && !output.ends_with([' ', '~', '`', '&', '#']) {
                    output.push(' ');
                }
                output.push_str(&text);
            }
        }
        EqNode::Text(text) => write_text(text, output),
        EqNode::Number(text) | EqNode::Symbol(text) | EqNode::Function(text) => {
            output.push_str(text)
        }
        EqNode::MathSymbol(symbol) => output.push_str(math_symbol_name(symbol)),
        EqNode::Fraction { numer, denom } => {
            output.push_str(&group(numer, state, roman_declared)?);
            output.push_str(" over ");
            output.push_str(&group(denom, state, roman_declared)?);
        }
        EqNode::Atop { top, bottom } => {
            output.push_str(&group(top, state, roman_declared)?);
            output.push_str(" atop ");
            output.push_str(&group(bottom, state, roman_declared)?);
        }
        EqNode::Sqrt { index, body } => {
            if let Some(index) = index {
                output.push_str("root ");
                output.push_str(&group(index, state, roman_declared)?);
                output.push_str(" of ");
            } else {
                output.push_str("sqrt ");
            }
            output.push_str(&group(body, state, roman_declared)?);
        }
        EqNode::Superscript { base, sup } => {
            output.push_str(&group(base, state, roman_declared)?);
            output.push('^');
            output.push_str(&group(sup, state, roman_declared)?);
        }
        EqNode::Subscript { base, sub } => {
            output.push_str(&group(base, state, roman_declared)?);
            output.push('_');
            output.push_str(&group(sub, state, roman_declared)?);
        }
        EqNode::SubSup { base, sub, sup } => {
            output.push_str(&group(base, state, roman_declared)?);
            output.push('_');
            output.push_str(&group(sub, state, roman_declared)?);
            output.push('^');
            output.push_str(&group(sup, state, roman_declared)?);
        }
        EqNode::BigOp { symbol, sub, sup } => {
            output.push_str(big_operator_name(symbol));
            if let Some(sub) = sub {
                output.push('_');
                output.push_str(&group(sub, state, roman_declared)?);
            }
            if let Some(sup) = sup {
                output.push('^');
                output.push_str(&group(sup, state, roman_declared)?);
            }
        }
        EqNode::Limit { is_upper, sub } => {
            output.push_str(if *is_upper { "Lim" } else { "lim" });
            if let Some(sub) = sub {
                output.push('_');
                output.push_str(&group(sub, state, roman_declared)?);
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
                    output.push_str(&script_with_style(cell, state, roman_declared)?);
                }
            }
            output.push('}');
        }
        EqNode::Cases { rows } => write_rows("cases", rows, output, state, roman_declared)?,
        EqNode::Pile { rows, align } => write_rows(
            match align {
                PileAlign::Center => "pile",
                PileAlign::Left => "lpile",
                PileAlign::Right => "rpile",
            },
            rows,
            output,
            state,
            roman_declared,
        )?,
        EqNode::EqAlign { rows } => {
            output.push_str("eqalign {");
            for (index, (left, right)) in rows.iter().enumerate() {
                if index > 0 {
                    output.push_str(" # ");
                }
                output.push_str(&script_with_style(left, state, roman_declared)?);
                output.push_str(" & ");
                output.push_str(&script_with_style(right, state, roman_declared)?);
            }
            output.push('}');
        }
        EqNode::Rel { arrow, over, under } => {
            output.push_str(if under.is_some() { "rel " } else { "buildrel " });
            output.push_str(arrow);
            output.push(' ');
            output.push_str(&group(over, state, roman_declared)?);
            if let Some(under) = under {
                output.push(' ');
                output.push_str(&group(under, state, roman_declared)?);
            }
        }
        EqNode::Paren { left, right, body } => {
            output.push_str("left ");
            output.push_str(bracket_name(left, true));
            output.push(' ');
            output.push_str(&script_with_style(body, state, roman_declared)?);
            output.push_str(" right ");
            output.push_str(bracket_name(right, false));
        }
        EqNode::Decoration { kind, body } => {
            output.push_str(decoration_name(*kind));
            output.push(' ');
            output.push_str(&group(body, state, roman_declared)?);
        }
        EqNode::FontStyle { style, body } => {
            if (*style == FontStyleKind::Italic && state.italic)
                || (*style == FontStyleKind::Roman && !state.italic && !state.bold)
            {
                write_node(body, output, state, roman_declared)?;
                return Ok(());
            }
            let name = match style {
                FontStyleKind::Roman => "rm",
                FontStyleKind::Italic => "it",
                FontStyleKind::Bold => "bold",
                unsupported => {
                    return Err(CanonicalScriptError::UnsupportedFontStyle(*unsupported))
                }
            };
            let body_state = state.styled(*style);
            output.push('{');
            output.push_str(name);
            output.push(' ');
            if *style == FontStyleKind::Bold {
                // The parser scopes declarations inside a bold argument.
                let mut scoped_declaration = false;
                output.push_str(&group(body, body_state, &mut scoped_declaration)?);
            } else {
                if *style == FontStyleKind::Roman {
                    *roman_declared = true;
                }
                output.push_str(&group(body, body_state, roman_declared)?);
            }
            if body_state.italic != state.italic {
                output.push_str(if state.italic { " it" } else { " rm" });
                if !state.italic {
                    *roman_declared = true;
                }
            }
            output.push('}');
        }
        EqNode::Color { r, g, b, body } => {
            output.push_str(&format!("color {{{r},{g},{b}}} "));
            output.push_str(&group(body, state, roman_declared)?);
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
    roman_declared: &mut bool,
) -> Result<(), CanonicalScriptError> {
    output.push_str(command);
    output.push_str(" {");
    for (index, row) in rows.iter().enumerate() {
        if index > 0 {
            output.push_str(" # ");
        }
        output.push_str(&script_with_style(row, state, roman_declared)?);
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
        "·" => "cdot",
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
        "△" => "triangle",
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer::equation::parser::parse;

    fn canonical(script: &str) -> String {
        to_hwp_script(&parse(script)).expect("supported canonical script")
    }

    #[test]
    fn canonicalizes_common_latex_without_backslash_commands() {
        for script in [
            r"\frac{1}{2}",
            r"x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}",
            r"\sqrt[3]{x}",
            r"x_i^2",
            r"\sum_{i=1}^{n} i",
            r"\int_0^1 x dx",
            r"\left( x \right)^2",
            r"\begin{matrix} a & b \\ c & d \end{matrix}",
        ] {
            let output = canonical(script);
            assert!(!output.contains('\\'), "{script} -> {output}");
            assert_eq!(parse(&output), parse(script), "{script} -> {output}");
        }
    }

    #[test]
    fn scoped_text_in_cases_preserves_structure_and_inherited_styles() {
        // lexical it 복원이 만드는 기본 스타일 래퍼만 제거한다. Roman 내부의
        // 명시적 Italic 전환은 남겨 구조뿐 아니라 실제 스타일도 비교한다.
        fn normalize(node: EqNode, italic: bool) -> EqNode {
            match node {
                EqNode::Row(nodes) => {
                    EqNode::Row(nodes.into_iter().map(|n| normalize(n, italic)).collect())
                }
                EqNode::Cases { rows } => EqNode::Cases {
                    rows: rows.into_iter().map(|n| normalize(n, italic)).collect(),
                },
                EqNode::FontStyle {
                    style: FontStyleKind::Italic,
                    body,
                } if italic => normalize(*body, italic),
                EqNode::FontStyle { style, body } => EqNode::FontStyle {
                    style,
                    body: Box::new(normalize(
                        *body,
                        match style {
                            FontStyleKind::Roman => false,
                            FontStyleKind::Italic => true,
                            _ => italic,
                        },
                    )),
                },
                other => other,
            }
        }
        let script = r"\begin{cases} x & \text{if } x \ge 0 \\ -x & \text{otherwise} \end{cases}";
        let output = canonical(script);
        assert_eq!(
            normalize(parse(&output), true),
            normalize(parse(script), true)
        );
        assert_eq!(canonical(&output), output);
    }

    fn letter_styles(node: &EqNode, state: FontState, out: &mut Vec<(String, bool, bool)>) {
        match node {
            EqNode::FontStyle { style, body } => letter_styles(body, state.styled(*style), out),
            EqNode::Row(nodes) => {
                for node in nodes {
                    letter_styles(node, state, out);
                }
            }
            EqNode::Fraction { numer, denom } => {
                letter_styles(numer, state, out);
                letter_styles(denom, state, out);
            }
            EqNode::Text(text) => out.push((text.clone(), state.italic, state.bold)),
            _ => {}
        }
    }

    #[test]
    fn persistent_roman_in_bold_row_does_not_change_next_sibling() {
        let bold_row = EqNode::FontStyle {
            style: FontStyleKind::Bold,
            body: Box::new(EqNode::Row(vec![
                EqNode::FontStyle {
                    style: FontStyleKind::Roman,
                    body: Box::new(EqNode::Text("x".into())),
                },
                EqNode::Text("y".into()),
            ])),
        };
        for (ast, expected_y_italic) in [
            (bold_row.clone(), true),
            (
                EqNode::FontStyle {
                    style: FontStyleKind::Roman,
                    body: Box::new(bold_row),
                },
                false,
            ),
        ] {
            let output = to_hwp_script(&ast).unwrap();
            let parsed = parse(&output);
            let mut styles = Vec::new();
            letter_styles(
                &parsed,
                FontState {
                    italic: true,
                    bold: false,
                },
                &mut styles,
            );
            assert_eq!(
                styles,
                [
                    ("x".into(), false, false),
                    ("y".into(), expected_y_italic, true)
                ]
            );
            assert_eq!(canonical(&output), output);
        }
    }

    #[test]
    fn persistent_roman_in_fraction_numerator_does_not_change_denominator() {
        let ast = EqNode::FontStyle {
            style: FontStyleKind::Bold,
            body: Box::new(EqNode::Fraction {
                numer: Box::new(EqNode::FontStyle {
                    style: FontStyleKind::Roman,
                    body: Box::new(EqNode::Text("x".into())),
                }),
                denom: Box::new(EqNode::Text("y".into())),
            }),
        };
        let output = to_hwp_script(&ast).unwrap();
        let parsed = parse(&output);
        let mut styles = Vec::new();
        letter_styles(
            &parsed,
            FontState {
                italic: true,
                bold: false,
            },
            &mut styles,
        );
        assert_eq!(
            styles,
            [("x".into(), false, false), ("y".into(), true, true)]
        );
        assert_eq!(canonical(&output), output);
    }

    #[test]
    fn restoring_roman_after_italic_keeps_fraction_denominator_bold() {
        let ast = EqNode::FontStyle {
            style: FontStyleKind::Roman,
            body: Box::new(EqNode::FontStyle {
                style: FontStyleKind::Bold,
                body: Box::new(EqNode::Fraction {
                    numer: Box::new(EqNode::FontStyle {
                        style: FontStyleKind::Italic,
                        body: Box::new(EqNode::Text("x".into())),
                    }),
                    denom: Box::new(EqNode::Text("y".into())),
                }),
            }),
        };
        let output = to_hwp_script(&ast).unwrap();
        let mut styles = Vec::new();
        letter_styles(
            &parse(&output),
            FontState {
                italic: true,
                bold: false,
            },
            &mut styles,
        );
        assert_eq!(
            styles,
            [("x".into(), true, true), ("y".into(), false, true)]
        );
        assert_eq!(canonical(&output), output);
    }

    #[test]
    fn persistent_roman_simultaneous_scripts_are_canonical_once() {
        let output = canonical("rm x_i^2");
        assert_eq!(canonical(&output), output);
    }

    #[test]
    fn emits_eqedit_names_for_supported_latex_symbols() {
        let script = r"\zeta \Xi \emptyset \subseteq \rightarrow \iint \iiint \oint \aleph \ddots";
        let output = canonical(script);

        assert_eq!(
            output,
            "zeta Xi emptyset subseteq rarrow dint tint oint aleph ddots"
        );
        assert!(!output.contains('\\'));
        assert!(!matches!(parse(&output), EqNode::Empty));
    }

    #[test]
    fn preserves_latex_spacing_with_eqedit_spacing_tokens() {
        assert_eq!(canonical(r"x\,y\quad z"), "x `y ~~z");
    }

    #[test]
    fn rejects_latex_only_font_styles_instead_of_flattening_them() {
        assert_eq!(
            to_hwp_script(&parse(r"\mathbb{R}")),
            Err(CanonicalScriptError::UnsupportedFontStyle(
                FontStyleKind::Blackboard
            )),
        );
    }
}

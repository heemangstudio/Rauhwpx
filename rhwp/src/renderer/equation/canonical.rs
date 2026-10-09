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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer::equation::parser::parse;

    fn canonical(script: &str) -> String {
        to_hwp_script(&parse(script)).expect("supported canonical script")
    }

    #[test]
    fn dot_operator_commands_preserve_their_glyph_and_literal_middle_dot() {
        for script in ["a CDOT b", r"a \cdot b", "a · b"] {
            let output = canonical(script);
            assert_eq!(parse(&output), parse(script), "{script} -> {output}");
        }
        assert_ne!(parse("a CDOT b"), parse("a · b"));
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
            r"\int_0^2 {g(x)dx}=2",
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
                EqNode::FontDeclaration {
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
                EqNode::FontDeclaration { style, body } => EqNode::FontStyle {
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
            EqNode::FontStyle { style, body } | EqNode::FontDeclaration { style, body } => {
                letter_styles(body, state.styled(*style), out)
            }
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
    fn explicit_declarations_survive_canonical_roundtrips_without_inherited_boundaries() {
        for (script, expected, boundaries) in [
            ("rm A B + C", "rm A B + C", vec![true, false, false, false]),
            (
                "it R^2 rm = 1",
                "it {R}^{2} rm = 1",
                vec![true, true, false],
            ),
            ("{rm} + x", "rm + x", vec![true, false]),
            ("x {rm} = y", "x rm = y", vec![false, true, false]),
        ] {
            let output = canonical(script);
            assert_eq!(output, expected);
            assert_eq!(canonical(&output), output);
            let EqNode::Row(nodes) = parse(&output) else {
                panic!("행이어야 함: {output}");
            };
            assert_eq!(
                nodes
                    .iter()
                    .map(|node| matches!(node, EqNode::FontDeclaration { .. }))
                    .collect::<Vec<_>>(),
                boundaries,
                "{output}"
            );
        }
        assert!(matches!(
            parse(r"\text{A}"),
            EqNode::FontStyle {
                style: FontStyleKind::Roman,
                ..
            }
        ));
    }

    #[test]
    fn declaration_inside_bold_does_not_add_a_boundary_after_its_argument() {
        let ast = EqNode::Row(vec![
            EqNode::FontStyle {
                style: FontStyleKind::Bold,
                body: Box::new(EqNode::FontDeclaration {
                    style: FontStyleKind::Roman,
                    body: Box::new(EqNode::Text("x".into())),
                }),
            },
            EqNode::Text("y".into()),
        ]);
        let output = to_hwp_script(&ast).unwrap();
        assert_eq!(output, "{bold {rm x}} y");
        let EqNode::Row(nodes) = parse(&output) else {
            panic!("행이어야 함: {output}");
        };
        assert!(matches!(nodes[1], EqNode::Text(ref text) if text == "y"));
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

//! 수식 글꼴 fallback. 문서가 지정한 서체는 항상 첫 후보로 보존한다.

const DEFAULT_FAMILIES: &[&str] = &[
    "Latin Modern Math",
    "STIX Two Text",
    "STIX Two Math",
    "Times New Roman",
    "Times",
    "serif",
];

// HYhwpEQ의 라틴 변수에는 Times 계열의 실제 italic 자형이 가깝다.
// regular만 있는 math face를 앞에 두면 브라우저가 직립 자형을 기울여 그린다.
const LEGACY_FAMILIES: &[&str] = &[
    "Times New Roman",
    "Times",
    "STIX Two Text",
    "Latin Modern Math",
    "STIX Two Math",
    "serif",
];

pub(crate) fn equation_font_families(font_name: Option<&str>) -> Vec<&str> {
    let requested = font_name.map(str::trim).filter(|name| !name.is_empty());
    let fallbacks = if requested.is_some_and(|name| name.eq_ignore_ascii_case("HYhwpEQ")) {
        LEGACY_FAMILIES
    } else {
        DEFAULT_FAMILIES
    };
    requested
        .into_iter()
        .chain(fallbacks.iter().copied())
        .collect()
}

pub(crate) fn equation_css_font_family(font_name: Option<&str>) -> String {
    equation_font_families(font_name)
        .into_iter()
        // Unicode SVG/Canvas fallback에는 legacy cmap의 본문 ASCII 자형을 섞지 않는다.
        // 정확한 HYhwpEQ 경로는 로드/coverage를 확인한 renderer adapter가 선택한다.
        .filter(|name| !is_legacy_equation_font(name))
        .map(|name| {
            if name == "serif" {
                name.to_string()
            } else {
                format!("'{}'", name.replace('\\', "\\\\").replace('\'', "\\'"))
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

pub(crate) fn is_legacy_equation_font(name: &str) -> bool {
    name.trim().eq_ignore_ascii_case("HYhwpEQ")
}

/// 한컴 수식기가 run 안 글립을 포개는 비율 — 자형은 그대로 두고 진행폭만
/// 이 배율로 좁혀 식자한다(02-eq-01 공식 PDF 실측: 한글 pitch 0.9em 고정,
/// 숫자 pitch 0.45em = hmtx 0.5×0.9, '%' pitch 0.75em = 0.833×0.9).
/// 레이아웃 측정과 네이티브 painter가 같은 값을 써야 박스와 잉크가 맞는다.
pub(crate) const EQUATION_GLYPH_TRACKING: f64 = 0.9;

pub(crate) fn registered_char_advance_em(family: &str, character: char) -> Option<f64> {
    crate::renderer::runtime_font_metrics::char_em_advance(family, false, false, character).or_else(
        || {
            #[cfg(not(target_arch = "wasm32"))]
            {
                crate::renderer::font_paths::custom_face_char_em_advance(
                    family, false, false, character,
                )
            }
            #[cfg(target_arch = "wasm32")]
            {
                None
            }
        },
    )
}

/// These modern HY equation characters are absent from HYhwpEQ and Hancom
/// paints them with the bundled Haansoft Batang face when it is available.
pub(crate) fn modern_hancom_fallback_advance_em(character: char) -> Option<f64> {
    if !matches!(character, '□' | '∆' | '′' | '″')
        || registered_char_advance_em("HYhwpEQ", character).is_some()
    {
        return None;
    }
    registered_char_advance_em("Haansoft Batang", character)
}

pub(crate) fn modern_hancom_fallback_run_advance_em(text: &str) -> Option<f64> {
    let mut characters = text.chars();
    let character = characters.next()?;
    if characters.next().is_some() {
        return None;
    }
    modern_hancom_fallback_advance_em(character)
}

/// HYhwpEQ의 수식 전용 cmap. ASCII 영역은 본문 자형이며, 수식 자형은 PUA에 있다.
/// 호출자는 실제 서체와 해당 글립의 존재를 먼저 확인해야 한다.
/// 반환 bool은 남아 있는 합성 기울임이다. 소문자/그리스 문자는 이미 기울어진 자형이다.
pub(crate) fn legacy_equation_glyph(character: char, italic: bool, modern: bool) -> (char, bool) {
    // Equation Version 60's DEG command uses the wide HY degree glyph; the
    // Unicode degree in the same face has a different advance.
    if modern && character == '°' {
        return ('\u{e0c8}', false);
    }
    // rm·함수 이름은 본문 Roman cmap, 수학 이탤릭 변수는 PUA cmap을 쓴다.
    if modern && character.is_ascii_alphabetic() && !italic {
        return (character, false);
    }
    let code = match character {
        'A'..='Z' => {
            return (
                char::from_u32(0xe000 + character as u32 - 'A' as u32).unwrap(),
                italic,
            )
        }
        'a'..='z' => 0xe01a + character as u32 - 'a' as u32 + if italic { 0xcb } else { 0 },
        '1'..='9' => 0xe034 + character as u32 - '1' as u32,
        '0' => 0xe03d,
        _ => {
            if italic {
                if let Some(index) = "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω"
                    .chars()
                    .position(|greek| greek == character)
                {
                    return (char::from_u32(0xe085 + index as u32).unwrap(), false);
                }
            }
            match character {
                '!' => 0xe03e,
                '@' => 0xe03f,
                '#' => 0xe040,
                '$' => 0xe041,
                '%' => 0xe042,
                '*' => 0xe043,
                '(' => 0xe044,
                ')' => 0xe045,
                '-' | '−' => 0xe046,
                '=' => 0xe047,
                '+' => 0xe048,
                '[' => 0xe049,
                ']' => 0xe04a,
                '{' => 0xe04b,
                '}' => 0xe04c,
                '|' => 0xe04d,
                ';' => 0xe04e,
                ':' => 0xe04f,
                ',' => 0xe052,
                '.' => 0xe053,
                '/' => 0xe054,
                '<' => 0xe055,
                '>' => 0xe056,
                '?' => 0xe057,
                '∑' => 0xe067,
                _ => return (character, italic),
            }
        }
    };
    (char::from_u32(code).unwrap(), false)
}

pub(crate) fn is_greek_variable(text: &str) -> bool {
    text.chars().any(|c| matches!(c, '\u{0391}'..='\u{03c9}'))
}

/// 버전60 수학 자형의 원점은 연산자/본문 Roman 기준선보다 0.06em 낮다.
/// 소스 PDF의 단일 run 안에서도 숫자와 소수점의 원점이 달라진다.
pub(crate) fn modern_glyph_baseline_em(character: char, italic: bool) -> f64 {
    if character.is_ascii_digit()
        || matches!(character, '⋅' | '×' | '→' | '∞')
        || (italic
            && (character.is_ascii_alphabetic() || is_greek_variable(&character.to_string())))
    {
        0.06
    } else {
        0.0
    }
}

/// 현대 HY 조판은 96dpi의 짝수 pixel 크기에서 정수 advance를 얻고 90%로 배치한다.
/// 합성 이탤릭 글립은 축소하지 않는다. 출력 글립 크기는 그대로 유지한다.
/// 한컴 10/11/12/13/16/20pt 및 Roman/이탤릭 대조에서 확인했다.
pub(crate) fn modern_glyph_advance(
    raw_advance: f64,
    font_size: f64,
    synthetic_italic: bool,
) -> f64 {
    let grid_size = (font_size / 2.0).round().max(1.0) * 2.0;
    (raw_advance / font_size * grid_size).round() * if synthetic_italic { 1.0 } else { 0.9 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modern_hinted_advance_matches_size_steps_without_scaling_the_glyph() {
        for (points, digit_advance) in [
            (10.0, 4.725),
            (11.0, 4.725),
            (12.0, 5.4),
            (13.0, 6.075),
            (16.0, 7.425),
            (20.0, 8.775),
        ] {
            let px = points * 4.0 / 3.0;
            assert!(
                (modern_glyph_advance(px * 0.5, px, false) * 3.0 / 4.0 - digit_advance).abs()
                    < 1e-9
            );
        }
    }

    #[test]
    fn modern_advance_shrink_follows_the_mapped_synthetic_style() {
        for (character, italic, shrink) in [
            ('A', true, 1.0),
            ('A', false, 0.9),
            ('a', true, 0.9),
            ('α', true, 0.9),
        ] {
            let (_, synthetic) = legacy_equation_glyph(character, italic, true);
            assert_eq!(modern_glyph_advance(10.0, 20.0, synthetic), 10.0 * shrink);
        }
    }

    #[test]
    fn modern_math_origin_and_roman_mapping_preserve_hft_fallback() {
        assert_eq!(legacy_equation_glyph('P', false, true), ('P', false));
        assert_eq!(
            legacy_equation_glyph('P', false, false),
            ('\u{e00f}', false)
        );
        assert_eq!(
            legacy_equation_glyph('p', false, false),
            ('\u{e029}', false)
        );
        assert_eq!(modern_glyph_baseline_em('2', false), 0.06);
        assert_eq!(modern_glyph_baseline_em('x', true), 0.06);
        assert_eq!(modern_glyph_baseline_em('→', false), 0.06);
        assert_eq!(modern_glyph_baseline_em('∞', false), 0.06);
        assert_eq!(modern_glyph_baseline_em('x', false), 0.0);
        assert_eq!(modern_glyph_baseline_em('.', false), 0.0);
        assert_eq!(modern_glyph_baseline_em('+', false), 0.0);
    }

    #[test]
    fn legacy_equation_fallback_keeps_real_italic_faces_before_regular_math_faces() {
        let families = equation_font_families(Some("HYhwpEQ"));
        assert_eq!(
            &families[..4],
            ["HYhwpEQ", "Times New Roman", "Times", "STIX Two Text"]
        );
        assert_eq!(families.last(), Some(&"serif"));
        assert!(!equation_css_font_family(Some("HYhwpEQ")).contains("HYhwpEQ"));
        for requested in ["Latin Modern Math", "Cambria Math", "STIX Two Math"] {
            assert_eq!(equation_font_families(Some(requested))[0], requested);
        }
    }

    #[test]
    fn legacy_math_cmap_keeps_roman_and_intrinsic_italic_distinct() {
        assert_eq!(legacy_equation_glyph('p', true, true), ('\u{e0f4}', false));
        assert_eq!(legacy_equation_glyph('i', true, true), ('\u{e0ed}', false));
        assert_eq!(legacy_equation_glyph('f', true, true), ('\u{e0ea}', false));
        assert_eq!(legacy_equation_glyph('p', false, true), ('p', false));
        assert_eq!(legacy_equation_glyph('P', false, true), ('P', false));
        assert_eq!(legacy_equation_glyph('1', false, true), ('\u{e034}', false));
        assert_eq!(legacy_equation_glyph('L', true, true), ('\u{e00b}', true));
        assert_eq!(legacy_equation_glyph('α', true, true), ('\u{e09d}', false));
        assert_eq!(legacy_equation_glyph('Ω', true, true), ('\u{e09c}', false));
        assert_eq!(legacy_equation_glyph('∑', false, true), ('\u{e067}', false));
        assert_eq!(legacy_equation_glyph('°', false, true), ('\u{e0c8}', false));
        assert_eq!(legacy_equation_glyph('°', false, false), ('°', false));
        assert_eq!(legacy_equation_glyph('α', false, true), ('α', false));
        assert_eq!(legacy_equation_glyph('한', false, true), ('한', false));
    }
}

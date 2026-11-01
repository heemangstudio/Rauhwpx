//! 한컴 수식 스크립트 재귀 하강 파서
//!
//! 토큰 리스트를 AST(EqNode)로 변환한다.

use super::ast::*;
use super::symbols::{
    self, is_big_operator, is_function, is_structure_command, lookup_function, lookup_symbol,
    FontStyleKind, DECORATIONS, FONT_STYLES,
};
use super::tokenizer::{tokenize, Token, TokenType};

/// 파서 재귀(중첩) 한도 — 비정상적으로 깊게 중첩된 스크립트(최대 8000자)가
/// WASM 스택 오버플로를 일으키지 않도록 제한한다. 한도 초과 시 경고를 수집하고
/// 해당 노드를 Empty 로 대체한다 (레이아웃 재귀 깊이도 AST 깊이에 의해 제한됨).
pub(crate) const MAX_PARSE_DEPTH: usize = 64;

/// 수식 파서
pub struct EqParser {
    tokens: Vec<Token>,
    pos: usize,
    /// 파싱 중 수집한 검증 경고 (미지 명령어, 괄호 불일치, 빈 그룹, 깊이 초과).
    /// 파싱 자체는 기존과 동일하게 관대하게(tolerant) 진행하고, 경고는
    /// 미리보기 검증 게이트(renderEquationPreview)가 소비한다.
    warnings: Vec<String>,
    /// 현재 재귀 깊이 (parse_element / parse_single_or_group 진입 시 증가)
    depth: usize,
    /// 깊이 초과 경고를 이미 냈는지 (중복 경고 방지)
    depth_warned: bool,
    /// HWP의 rm/it 선언은 중괄호를 넘어 다음 선언까지 뒤따르는 원자에 적용된다.
    font_declaration: Option<FontStyleKind>,
    /// 닫는 경계 앞 선언은 다음 실제 원자까지 간격 경계를 전달한다.
    pending_font_declaration: Option<FontStyleKind>,
}

impl EqParser {
    pub fn new(tokens: Vec<Token>) -> Self {
        Self {
            tokens,
            pos: 0,
            warnings: Vec::new(),
            depth: 0,
            depth_warned: false,
            font_declaration: None,
            pending_font_declaration: None,
        }
    }

    /// 파싱 중 수집된 검증 경고 목록
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    /// 깊이 초과 경고 (한 번만 기록)
    fn warn_depth_exceeded(&mut self) {
        if !self.depth_warned {
            self.depth_warned = true;
            self.warnings.push(format!(
                "수식 중첩 깊이가 한도({MAX_PARSE_DEPTH})를 초과했습니다"
            ));
        }
    }

    fn current(&self) -> Option<&Token> {
        self.tokens.get(self.pos).filter(|t| t.ty != TokenType::Eof)
    }

    fn current_type(&self) -> TokenType {
        self.tokens
            .get(self.pos)
            .map(|t| t.ty)
            .unwrap_or(TokenType::Eof)
    }

    fn current_value(&self) -> &str {
        self.tokens
            .get(self.pos)
            .map(|t| t.value.as_str())
            .unwrap_or("")
    }

    fn at_end(&self) -> bool {
        self.pos >= self.tokens.len() || self.current_type() == TokenType::Eof
    }

    fn advance(&mut self) -> Option<&Token> {
        if self.at_end() {
            return None;
        }
        let tok = &self.tokens[self.pos];
        self.pos += 1;
        Some(tok)
    }

    fn expect(&mut self, ty: TokenType) -> bool {
        if self.current_type() == ty {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    /// 명령어 대소문자 무시 비교
    fn cmd_eq(val: &str, target: &str) -> bool {
        val.eq_ignore_ascii_case(target)
    }

    /// 최상위 레벨에서 OVER가 있는지 확인 (괄호/LEFT-RIGHT 내부 제외)
    fn has_toplevel_over(tokens: &[Token]) -> bool {
        let mut brace_depth = 0i32;
        let mut lr_depth = 0i32;
        for t in tokens {
            match t.ty {
                TokenType::LBrace => brace_depth += 1,
                TokenType::RBrace => brace_depth -= 1,
                TokenType::Command => {
                    if Self::cmd_eq(&t.value, "LEFT") {
                        lr_depth += 1;
                    } else if Self::cmd_eq(&t.value, "RIGHT") {
                        lr_depth -= 1;
                    } else if Self::cmd_eq(&t.value, "OVER") && brace_depth == 0 && lr_depth == 0 {
                        return true;
                    }
                }
                _ => {}
            }
        }
        false
    }

    /// 수식 전체 파싱 (엔트리 포인트)
    pub fn parse(&mut self) -> EqNode {
        let mut parts = vec![self.parse_expression()];
        loop {
            // An unmatched `}` can appear in otherwise usable HWP equation text.
            // A nested group consumes its own closing brace; only a brace left at
            // the top level reaches here. Skip it and retain the trailing equation.
            if self.current_type() == TokenType::RBrace {
                self.warnings
                    .push("짝 없는 닫는 괄호가 있습니다".to_string());
                self.pos += 1;
                parts.push(self.parse_expression());
                continue;
            }
            // LEFT와 RIGHT가 서로 다른 수식 개체에 있을 수 있다. 짝 없는 RIGHT도
            // 앞 식의 오른쪽 구분 기호를 그린다 (`0<alpha<1 over 2 RIGHT )`).
            if self.current_type() == TokenType::Command
                && Self::cmd_eq(self.current_value(), "RIGHT")
            {
                self.pos += 1;
                let right = self.read_bracket_char();
                let body = EqNode::Row(std::mem::take(&mut parts)).simplify();
                parts.push(EqNode::Paren {
                    left: String::new(),
                    right,
                    body: Box::new(body),
                });
                if !self.at_end() {
                    parts.push(self.parse_expression());
                }
                continue;
            }
            break;
        }
        // 최상위 parse_expression 은 RBrace/RIGHT 에서 중단한다 — 최상위에서
        // 토큰이 남았다면 짝 없는 닫는 괄호가 있다는 뜻 (기존엔 조용히 유실됨).
        if !self.at_end() {
            self.warnings
                .push("짝 없는 닫는 괄호가 있습니다".to_string());
        }
        EqNode::Row(parts).simplify()
    }

    /// OVER/ATOP 중위 연산자 처리. 현재 토큰이 OVER/ATOP 이면 children 의 마지막 요소를
    /// pop 하여 분수/atop 으로 결합한다. 처리했으면 true, 아니면 false.
    /// CASES/PILE/EQALIGN 등 row-collecting 파서가 분수를 인식하지 못하는 결함(#505)을
    /// 방지하기 위해 모든 token-collecting 루프에서 호출한다.
    fn try_consume_infix_over_atop(&mut self, children: &mut Vec<EqNode>) -> bool {
        if self.current_type() != TokenType::Command {
            return false;
        }
        let val = self.current_value();
        let is_over = Self::cmd_eq(val, "OVER");
        let is_atop = Self::cmd_eq(val, "ATOP");
        let is_lsub = Self::cmd_eq(val, "LSUB");
        let is_lsup = Self::cmd_eq(val, "LSUP");
        if (is_lsub || is_lsup) && !children.is_empty() {
            // `C LSUB {3} _{1}` = ₃C₁: 앞 요소의 왼쪽에 첨자를 단다 (한컴 중위 표기).
            // 이어지는 오른쪽 첨자는 같은 앞 요소에 붙는다.
            self.pos += 1;
            let script = self.parse_single_or_group();
            let base = children.pop().unwrap_or(EqNode::Empty);
            let base = self.try_parse_scripts(base);
            let left = if is_lsub {
                EqNode::Subscript {
                    base: Box::new(EqNode::Empty),
                    sub: Box::new(script),
                }
            } else {
                EqNode::Superscript {
                    base: Box::new(EqNode::Empty),
                    sup: Box::new(script),
                }
            };
            children.push(EqNode::Row(vec![left, base]));
            return true;
        }
        if !is_over && !is_atop {
            return false;
        }
        self.pos += 1;
        let top = children.pop().unwrap_or(EqNode::Empty);
        let bottom = self.parse_element();
        children.push(if is_atop {
            EqNode::Atop {
                top: Box::new(top),
                bottom: Box::new(bottom),
            }
        } else {
            EqNode::Fraction {
                numer: Box::new(top),
                denom: Box::new(bottom),
            }
        });
        true
    }

    /// 표현식 파싱 (중단 조건 없이 끝까지)
    /// OVER/ATOP을 중위 연산자로 처리: 바로 앞/뒤 요소를 위아래로 배치
    fn parse_expression(&mut self) -> EqNode {
        let mut children = Vec::new();
        while !self.at_end() {
            // 그룹 종료 또는 RIGHT 만나면 중단
            if self.current_type() == TokenType::RBrace {
                break;
            }
            if self.current_type() == TokenType::Command
                && Self::cmd_eq(self.current_value(), "RIGHT")
            {
                break;
            }
            // OVER/ATOP 중위 연산자: 직전/직후 요소를 위아래로 결합
            if self.try_consume_infix_over_atop(&mut children) {
                continue;
            }
            children.push(self.parse_element());
        }
        EqNode::Row(children).simplify()
    }

    /// 단일 요소 파싱 (재귀 깊이 가드 포함)
    fn parse_element(&mut self) -> EqNode {
        if self.at_end() {
            return EqNode::Empty;
        }
        if self.depth >= MAX_PARSE_DEPTH {
            // 깊이 초과: 모든 수집 루프의 진행을 보장하기 위해 토큰 하나를
            // 소비하고 빈 노드를 반환한다 (무한 루프/스택 오버플로 방지).
            self.warn_depth_exceeded();
            self.pos += 1;
            return EqNode::Empty;
        }
        self.depth += 1;
        let declaration = self.font_declaration;
        let pending = self.pending_font_declaration.take();
        let explicit_group = self.current_type() == TokenType::LBrace;
        let mut node = self.parse_element_inner();
        // 공백 없이 이어진 문자/숫자는 하나의 피연산자다. 토크나이저가 ASCII와
        // Unicode 경계에서 나누어도 dΔx, 10a^3 전체가 OVER의 분자가 되어야 한다.
        // 명시적 그룹은 피연산자 경계다. `{2}a`의 a는 분모 밖에 있어야 한다.
        if !explicit_group && Self::is_literal_operand(&node) {
            let mut parts = vec![node];
            while self.current().is_some_and(|token| {
                if token.space_before {
                    return false;
                }
                match token.ty {
                    TokenType::Number => true,
                    TokenType::Text => token.value.chars().all(char::is_alphabetic),
                    TokenType::Command => {
                        let name = token.value.as_str();
                        let lower = name.to_ascii_lowercase();
                        !is_structure_command(name)
                            && !is_structure_command(&name.to_ascii_uppercase())
                            && !is_function(name)
                            && !FONT_STYLES.contains_key(lower.as_str())
                            && !DECORATIONS.contains_key(lower.as_str())
                            && lookup_symbol(name).map_or(true, |symbol| {
                                symbol.chars().all(|c| matches!(c, '\u{0391}'..='\u{03c9}'))
                            })
                    }
                    _ => false,
                }
            }) {
                parts.push(self.parse_element_inner());
            }
            node = EqNode::Row(parts).simplify();
        }
        let operator_base = match &node {
            EqNode::SubSup { base, .. }
            | EqNode::Superscript { base, .. }
            | EqNode::Subscript { base, .. } => base.as_ref(),
            _ => &node,
        };
        let limit_operand = matches!(operator_base, EqNode::Limit { .. });
        let takes_grouped_operand = limit_operand
            || matches!(operator_base, EqNode::MathSymbol(symbol)
                if matches!(symbol.as_str(), "∫" | "∬" | "∭" | "∮" | "∯" | "∰"));
        if takes_grouped_operand && self.current_type() == TokenType::LBrace {
            let mut parts = vec![self.parse_element()];
            // `lim {분자} over {분모}`의 극한 기호는 분자 밖에 남는다.
            while limit_operand && self.try_consume_infix_over_atop(&mut parts) {}
            let body = EqNode::Row(parts).simplify();
            if !matches!(body, EqNode::Empty) {
                node = EqNode::Row(vec![node, EqNode::OperatorBody(Box::new(body))]);
            }
        }
        self.depth -= 1;
        self.finish_font_element(node, declaration, pending)
    }

    fn finish_font_element(
        &mut self,
        node: EqNode,
        declaration: Option<FontStyleKind>,
        pending: Option<FontStyleKind>,
    ) -> EqNode {
        if let Some(style) = pending {
            if matches!(node, EqNode::Empty | EqNode::Space(_) | EqNode::Newline) {
                self.pending_font_declaration.get_or_insert(style);
            } else {
                let body = match node {
                    EqNode::FontStyle { style: inner, body } if inner == style => *body,
                    other => other,
                };
                return EqNode::FontDeclaration {
                    style,
                    body: Box::new(body),
                };
            }
        }
        Self::apply_font_declaration(node, declaration)
    }

    fn apply_font_declaration(node: EqNode, declaration: Option<FontStyleKind>) -> EqNode {
        match declaration {
            Some(style) if !matches!(node, EqNode::Empty) => {
                if matches!(&node, EqNode::FontStyle { style: inner, .. } if *inner == style)
                    || matches!(&node, EqNode::FontDeclaration { .. })
                {
                    node
                } else {
                    EqNode::FontStyle {
                        style,
                        body: Box::new(node),
                    }
                }
            }
            _ => node,
        }
    }

    fn is_literal_operand(node: &EqNode) -> bool {
        match node {
            EqNode::Text(text) => text.chars().all(char::is_alphabetic),
            EqNode::Number(_) => true,
            EqNode::MathSymbol(text) => text.chars().all(|c| matches!(c, '\u{0391}'..='\u{03c9}')),
            EqNode::Superscript { base, .. }
            | EqNode::Subscript { base, .. }
            | EqNode::SubSup { base, .. }
            | EqNode::FontStyle { body: base, .. } => Self::is_literal_operand(base),
            _ => false,
        }
    }

    /// 렉서의 관계 연산자 축약도 명령어와 같은 원본 기호로 해석한다.
    /// 일반 문장부호·팩토리얼과 인용 문자열은 그대로 둔다.
    fn symbol_node(value: String) -> EqNode {
        if value == "->" {
            EqNode::MathSymbol("→".to_string())
        } else if let Some(symbol) = lookup_symbol(&value) {
            EqNode::MathSymbol(symbol.to_string())
        } else {
            EqNode::Symbol(value)
        }
    }

    /// 단일 요소 파싱
    fn parse_element_inner(&mut self) -> EqNode {
        if self.at_end() {
            return EqNode::Empty;
        }

        let ty = self.current_type();
        let val = self.current_value().to_string();

        match ty {
            TokenType::Command => {
                let from_latex = self.tokens.get(self.pos).is_some_and(|t| t.from_latex);
                self.pos += 1;
                // 구조 명령어(sqrt, matrix, cases, …) 전체에도 뒤따르는 ^/_ 첨자를
                // 결합한다. 내부에서 이미 try_parse_scripts 를 거친 노드(기호/함수/
                // LEFT 등)는 첨자가 소비돼 있으므로 바깥 호출은 no-op 이다.
                let node = self.parse_command(&val, from_latex);
                self.try_parse_scripts(node)
            }
            TokenType::Number => {
                self.pos += 1;
                self.try_parse_scripts(EqNode::Number(val))
            }
            TokenType::Symbol => {
                self.pos += 1;
                Self::symbol_node(val)
            }
            TokenType::Text => {
                self.pos += 1;
                self.try_parse_scripts(EqNode::Text(val))
            }
            TokenType::Quoted => {
                self.pos += 1;
                self.try_parse_scripts(EqNode::Quoted(val))
            }
            TokenType::Whitespace => {
                self.pos += 1;
                match val.as_str() {
                    "~" => EqNode::Space(SpaceKind::Normal),
                    "`" => EqNode::Space(SpaceKind::Thin),
                    "#" => EqNode::Newline,
                    "&" => EqNode::Space(SpaceKind::Tab),
                    _ => EqNode::Empty,
                }
            }
            TokenType::LBrace => {
                let group = self.parse_group();
                self.try_parse_scripts(group)
            }
            TokenType::LParen => {
                // 괄호 primary를 먼저 균형 있게 소비한 뒤 postfix 첨자를 결합한다.
                // 내부 괄호에 첨자가 없어도 재귀적으로 소비해야 `(f(x))^5`의 안쪽 `)`가
                // 바깥 그룹을 조기에 닫지 않는다. 첨자가 없는 괄호는 기존 Symbol 흐름으로
                // 평탄화해 렌더링 호환성을 유지한다.
                self.parse_parenthesized_primary()
            }
            TokenType::RParen | TokenType::LBracket | TokenType::RBracket => {
                self.pos += 1;
                EqNode::Symbol(val)
            }
            TokenType::Subscript | TokenType::Superscript => {
                // 베이스 없는 첨자 (예: _{y} x)
                self.try_parse_scripts(EqNode::Empty)
            }
            _ => {
                self.pos += 1;
                EqNode::Empty
            }
        }
    }

    /// 명령어 처리
    /// `from_latex`: 백슬래시 명령어(`\foo`)에서 온 토큰이면 true — 미지 명령어
    /// 경고는 이 경우에만 발생한다 (베어워드는 변수 식별자와 구분 불가).
    fn parse_command(&mut self, cmd: &str, from_latex: bool) -> EqNode {
        let cmd_upper = cmd.to_ascii_uppercase();
        let cu = cmd_upper.as_str();
        // [#1204] hwpeq 명령은 대소문자 무시 — DECORATIONS/FONT_STYLES 는 소문자 키이므로
        // 1차 lookup 실패 시 소문자 fallback (`RM`/`BAR` 등 대문자 변형이 leak 되지 않도록).
        let cmd_lower = cmd.to_ascii_lowercase();

        // OVER/ATOP은 parse_expression에서 처리됨 (단독 발생 시)
        if cu == "OVER" {
            return EqNode::Empty;
        }

        if cu == "ATOP" {
            return EqNode::Empty;
        }

        // LaTeX 분수: \frac{a}{b}, \dfrac{a}{b}, \tfrac{a}{b}
        if matches!(cu, "FRAC" | "DFRAC" | "TFRAC") {
            return self.parse_latex_fraction();
        }

        // LaTeX \text/\operatorname의 로만체 인자는 HWP 선언과 별도 범위다.
        // 토크나이저가 일반 공백을 건너뛰므로 명시 공백은 ~로 입력한다.
        if matches!(cu, "TEXT" | "OPERATORNAME") {
            let declaration = self.font_declaration.take();
            let body = self.parse_single_or_group();
            self.font_declaration = declaration;
            return EqNode::FontStyle {
                style: FontStyleKind::Roman,
                body: Box::new(body),
            };
        }

        // LaTeX \phantom{...} — 보이지 않는 공간 (레이아웃 정렬용)
        if matches!(cu, "PHANTOM" | "VPHANTOM" | "HPHANTOM") {
            self.parse_single_or_group();
            return EqNode::Text(" ".to_string());
        }

        // LaTeX spacing: \quad, \qquad, \,, \:, \;, \!
        if matches!(
            cu,
            "QUAD" | "QQUAD" | "THINSPACE" | "MEDSPACE" | "THICKSPACE" | "NEGSPACE" | "ENSPACE"
        ) {
            let space = lookup_symbol(cu).unwrap_or(" ");
            return EqNode::Text(space.to_string());
        }

        // LaTeX \overset{over}{base}, \underset{under}{base}, \stackrel{over}{base}
        if matches!(cu, "OVERSET" | "STACKREL") {
            let over = self.parse_single_or_group();
            let base = self.parse_single_or_group();
            return EqNode::Superscript {
                base: Box::new(base),
                sup: Box::new(over),
            };
        }
        if cu == "UNDERSET" {
            let under = self.parse_single_or_group();
            let base = self.parse_single_or_group();
            return EqNode::Subscript {
                base: Box::new(base),
                sub: Box::new(under),
            };
        }

        // LaTeX \begin{env}...\end{env}
        if cu == "BEGIN" {
            return self.parse_latex_environment();
        }
        if cu == "END" {
            self.skip_brace_arg();
            return EqNode::Empty;
        }

        // 제곱근
        if cu == "SQRT" || cu == "ROOT" {
            return self.parse_sqrt();
        }

        // 적분 기호 — nolimits: 큰 기호 + 일반 첨자 (BigOp이 아닌 MathSymbol로 처리)
        if matches!(
            cu,
            "INT"
                | "INTEGRAL"
                | "SMALLINT"
                | "DINT"
                | "TINT"
                | "OINT"
                | "SMALLOINT"
                | "ODINT"
                | "OTINT"
        ) {
            let symbol = lookup_symbol(cu)
                .or_else(|| lookup_symbol(cmd))
                .unwrap_or("∫")
                .to_string();
            let node = EqNode::MathSymbol(symbol);
            return self.try_parse_scripts(node);
        }

        // SMALLPROD/SMCOPROD는 본문 크기의 곱 기호다. 큰 연산자(1.5em)로
        // 만들면 뒤따르는 독립 아래첨자가 기호에서 한 글자 폭만큼 밀린다.
        if matches!(cu, "SMALLPROD" | "SMCOPROD") {
            let symbol = lookup_symbol(cu).unwrap_or("∏").to_string();
            return self.try_parse_scripts(EqNode::MathSymbol(symbol));
        }

        // 큰 연산자 (∑, ∏ 등) — limits: 기호 위/아래 중앙
        if is_big_operator(cu) {
            let symbol = lookup_symbol(cu).unwrap_or("?").to_string();
            return self.parse_big_op(symbol);
        }
        // 원본 대소문자로도 확인 (대소문자 구분 명령어)
        if is_big_operator(cmd) {
            let symbol = lookup_symbol(cmd).unwrap_or("?").to_string();
            return self.parse_big_op(symbol);
        }

        // 극한 (대소문자 구분)
        if cmd == "lim" || cmd == "Lim" {
            return self.parse_limit(cmd == "Lim");
        }

        // 행렬
        if matches!(cu, "MATRIX" | "PMATRIX" | "BMATRIX" | "DMATRIX") {
            let style = match cu {
                "PMATRIX" => MatrixStyle::Paren,
                "BMATRIX" => MatrixStyle::Bracket,
                "DMATRIX" => MatrixStyle::Vert,
                _ => MatrixStyle::Plain,
            };
            return self.parse_matrix(style);
        }

        // 조건식
        if cu == "CASES" {
            return self.parse_cases();
        }

        // 칸 맞춤 정렬
        if cu == "EQALIGN" {
            return self.parse_eqalign();
        }

        // 세로 쌓기
        if matches!(cu, "PILE" | "LPILE" | "RPILE") {
            let align = match cu {
                "LPILE" => PileAlign::Left,
                "RPILE" => PileAlign::Right,
                _ => PileAlign::Center,
            };
            return self.parse_pile(align);
        }

        // LEFT-RIGHT 괄호
        if cu == "LEFT" {
            // ★ KeepGong fix: 구분기호 그룹(left|...right| 등) 뒤 첨자(^/_)를 그룹 전체에 부착.
            //   기존엔 try_parse_scripts 를 안 거쳐 |x|^3 의 ^3 가 base 없는 고아 첨자가 됐다.
            let node = self.parse_left_right();
            return self.try_parse_scripts(node);
        }

        if cu == "RIGHT" {
            return EqNode::Empty;
        }

        // REL / BUILDREL
        if cu == "REL" || cu == "BUILDREL" {
            let is_buildrel = cu == "BUILDREL";
            // 화살표 기호 읽기 (다음 요소를 파싱하여 화살표로 사용)
            let arrow_node = self.parse_element();
            let arrow = match &arrow_node {
                EqNode::MathSymbol(s) => s.clone(),
                EqNode::Symbol(s) => s.clone(),
                EqNode::Text(s) => s.clone(),
                _ => "→".to_string(),
            };
            // {위 내용}
            let over = self.parse_single_or_group();
            // {아래 내용} (REL만)
            let under = if !is_buildrel {
                Some(Box::new(self.parse_single_or_group()))
            } else {
                None
            };
            return EqNode::Rel {
                arrow,
                over: Box::new(over),
                under,
            };
        }

        // LONGDIV: LONGDIV {제수}{몫}{피제수#나머지...}
        if cu == "LONGDIV" {
            let divisor = self.parse_single_or_group();
            let quotient = self.parse_single_or_group();
            let body = self.parse_single_or_group();
            // 간이 표현: 몫 위에 줄, 제수)피제수 형태
            return EqNode::Row(vec![
                quotient,
                EqNode::Symbol("÷".to_string()),
                divisor,
                EqNode::Symbol("=".to_string()),
                body,
            ]);
        }

        // LADDER / SLADDER: 사다리꼴 레이아웃 → Matrix로 fallback
        if cu == "LADDER" || cu == "SLADDER" {
            return self.parse_matrix(MatrixStyle::Plain);
        }

        // BENZENE: 벤젠 분자 구조 → 텍스트 placeholder
        if cu == "BENZENE" {
            return EqNode::MathSymbol("⌬".to_string());
        }

        // BIGG: 크기 확대 (현재 크기 변경 무시, 내부 요소만 반환)
        if cu == "BIGG" {
            let inner = self.parse_element();
            return inner;
        }

        // CHOOSE / BINOM
        if cu == "CHOOSE" {
            // n CHOOSE r → 이전 요소와 다음 요소를 조합으로
            let body = self.parse_single_or_group();
            return EqNode::Paren {
                left: "(".to_string(),
                right: ")".to_string(),
                body: Box::new(EqNode::Atop {
                    top: Box::new(EqNode::Empty), // 이전 요소는 상위에서 처리
                    bottom: Box::new(body),
                }),
            };
        }

        if cu == "BINOM" {
            let top = self.parse_single_or_group();
            let bottom = self.parse_single_or_group();
            return EqNode::Paren {
                left: "(".to_string(),
                right: ")".to_string(),
                body: Box::new(EqNode::Atop {
                    top: Box::new(top),
                    bottom: Box::new(bottom),
                }),
            };
        }

        // 색상
        if cu == "COLOR" {
            return self.parse_color();
        }

        // 왼쪽 첨자
        if cu == "LSUB" || cu == "LSUP" {
            let script = self.parse_single_or_group();
            let body = self.parse_single_or_group();
            if cu == "LSUB" {
                return EqNode::Subscript {
                    base: Box::new(body),
                    sub: Box::new(script),
                };
            } else {
                return EqNode::Superscript {
                    base: Box::new(body),
                    sup: Box::new(script),
                };
            }
        }

        // SUP/SUB 동의어
        if cu == "SUP" {
            let body = self.parse_single_or_group();
            return self.try_parse_scripts(body);
        }
        if cu == "SUB" {
            let body = self.parse_single_or_group();
            return self.try_parse_scripts(body);
        }

        // 글자 장식
        if let Some(&deco) = DECORATIONS
            .get(cmd)
            .or_else(|| DECORATIONS.get(cmd_lower.as_str()))
        {
            let body = self.parse_single_or_group();
            return EqNode::Decoration {
                kind: deco,
                body: Box::new(body),
            };
        }

        // 글꼴 스타일
        if let Some(&style) = FONT_STYLES
            .get(cmd)
            .or_else(|| FONT_STYLES.get(cmd_lower.as_str()))
        {
            if !from_latex && matches!(cmd_lower.as_str(), "rm" | "it") {
                self.font_declaration = Some(style);
                // 닫는 경계와 뒤따르는 연산자를 선언의 인자로 삼지 않는다.
                if self.at_end()
                    || self.current_type() == TokenType::RBrace
                    || (self.current_type() == TokenType::Command
                        && matches!(
                            self.current_value().to_ascii_uppercase().as_str(),
                            "RIGHT" | "OVER" | "ATOP"
                        ))
                {
                    self.pending_font_declaration = Some(style);
                    return EqNode::Empty;
                }
                let body = self.parse_element();
                // 첫 피연산자에 상속 선언이 이미 적용됐으므로 중복 래퍼를 제거한다.
                let body = match body {
                    EqNode::FontStyle { style: inner, body } if inner == style => *body,
                    other => other,
                };
                return EqNode::FontDeclaration {
                    style,
                    body: Box::new(body),
                };
            }
            // LaTeX의 \mathrm{...} 등은 인자 범위에만 적용된다. 외부 HWP 선언이
            // 내부의 명시적 스타일보다 우선하지 않도록 인자를 독립적으로 파싱한다.
            let saved_declaration = self.font_declaration.take();
            let body = self.parse_single_or_group();
            self.font_declaration = saved_declaration;
            return EqNode::FontStyle {
                style,
                body: Box::new(body),
            };
        }

        // Unicode 기호 매핑 — 함수보다 우선 (hwpeq inf=∞ vs LaTeX \inf=infimum 충돌 방지)
        if let Some(symbol) = lookup_symbol(cmd) {
            let node = EqNode::MathSymbol(symbol.to_string());
            return self.try_parse_scripts(node);
        }

        // 함수 (sin, cos, log 등)
        if is_function(cmd) {
            let func_name = lookup_function(cmd).unwrap_or(cmd).to_string();
            // 함수 뒤 `` ` ``는 간격으로 남는다 (한컴 probe `sin `A`: n→A 1.44pt 더 넓다).
            let node = EqNode::Function(func_name);
            return self.try_parse_scripts(node);
        }

        // 알 수 없는 명령어 → 텍스트로 처리
        // LaTeX 스타일(\cmd) 미지 명령어만 경고한다 — hwpeq 베어워드는 일반 변수
        // 식별자(x, mc 등)와 구분할 수 없어 경고하면 모든 스크립트가 오탐이 된다.
        if from_latex {
            self.warnings
                .push(format!("알 수 없는 수식 명령어: \\{cmd}"));
        }
        let node = EqNode::Text(cmd.to_string());
        self.try_parse_scripts(node)
    }

    /// 중괄호 그룹 파싱: {...}
    /// 그룹 내의 OVER는 parse_expression의 중위 연산자 처리로 자동 처리된다.
    fn parse_group(&mut self) -> EqNode {
        if !self.expect(TokenType::LBrace) {
            return self.parse_element();
        }

        let mut children = Vec::new();
        while !self.at_end() {
            if self.current_type() == TokenType::RBrace {
                break;
            }
            // OVER/ATOP 중위 연산자: 그룹 내에서도 동일하게 처리
            if self.try_consume_infix_over_atop(&mut children) {
                continue;
            }
            children.push(self.parse_element());
        }

        // 닫는 괄호 건너뛰기 — EOF 까지 닫는 괄호가 없었으면 경고
        // (기존과 동일하게 관대하게 파싱하되 검증 게이트용 경고만 남긴다)
        if !self.expect(TokenType::RBrace) {
            self.warnings
                .push("닫는 중괄호 '}' 가 없습니다".to_string());
        }
        if children.is_empty() {
            self.warnings.push("빈 그룹 '{}' 입니다".to_string());
        }

        EqNode::Row(children).simplify()
    }

    /// 매칭되는 닫는 괄호 위치 찾기
    fn find_matching_brace(&self, start: usize) -> usize {
        let mut depth = 1i32;
        let mut pos = start;
        while pos < self.tokens.len() {
            match self.tokens[pos].ty {
                TokenType::LBrace => depth += 1,
                TokenType::RBrace => {
                    depth -= 1;
                    if depth == 0 {
                        return pos;
                    }
                }
                _ => {}
            }
            pos += 1;
        }
        self.tokens.len()
    }

    /// 소괄호 primary를 재귀적으로 파싱하고 뒤따르는 첨자를 결합한다.
    ///
    /// 첨자가 없는 소괄호는 종전처럼 일반 Symbol 행으로 돌려 렌더링을 보존한다.
    /// 첨자가 있으면 균형 있게 소비한 전체 괄호를 하나의 Paren base로 사용한다.
    fn parse_parenthesized_primary(&mut self) -> EqNode {
        debug_assert_eq!(self.current_type(), TokenType::LParen);
        self.pos += 1;
        let mut items = Vec::new();
        while !self.at_end() && self.current_type() != TokenType::RParen {
            // 짝 없는 `(` 는 그룹 경계(`}`)나 RIGHT 를 넘어가지 않는다.
            // `LEFT. (… RIGHT )` 에서 `)` 는 RIGHT 의 구분 기호다.
            if self.current_type() == TokenType::RBrace
                || (self.current_type() == TokenType::Command
                    && Self::cmd_eq(self.current_value(), "RIGHT"))
            {
                break;
            }
            if self.try_consume_infix_over_atop(&mut items) {
                continue;
            }
            items.push(self.parse_element());
        }

        let closed = self.expect(TokenType::RParen);
        if !closed {
            self.warnings
                .push("닫는 소괄호 ')' 가 없습니다".to_string());
        }

        let has_postfix = self.script_postfix_follows();
        if has_postfix {
            let group = EqNode::Paren {
                left: "(".to_string(),
                right: ")".to_string(),
                body: Box::new(EqNode::Row(items).simplify()),
            };
            self.try_parse_scripts(group)
        } else {
            let mut plain = Vec::with_capacity(items.len() + 2);
            plain.push(EqNode::Symbol("(".to_string()));
            plain.extend(items);
            if closed {
                plain.push(EqNode::Symbol(")".to_string()));
            }
            EqNode::Row(plain).simplify()
        }
    }

    /// 현재 위치에서 `^`/`_` postfix가 시작되는지 확인한다.
    /// 한컴의 thin-space 표기(`) 뒤 첨자도 try_parse_scripts와 같은 규칙으로 본다.
    fn script_postfix_follows(&self) -> bool {
        matches!(
            self.tokens[self.pos..]
                .iter()
                .skip_while(|token| token.ty == TokenType::Whitespace && token.value == "`")
                .next()
                .map(|token| token.ty),
            Some(TokenType::Subscript) | Some(TokenType::Superscript)
        )
    }

    /// 단일 토큰 또는 그룹 파싱 (첨자/인자용) — 재귀 깊이 가드 포함
    fn parse_single_or_group(&mut self) -> EqNode {
        if self.at_end() {
            return EqNode::Empty;
        }
        if self.depth >= MAX_PARSE_DEPTH {
            // 깊이 초과: RBrace(그룹 종료 마커)는 소비하지 않는 기존 계약을 유지하고,
            // 그 외 토큰은 하나 소비하여 진행을 보장한다.
            self.warn_depth_exceeded();
            if self.current_type() != TokenType::RBrace {
                self.pos += 1;
            }
            return EqNode::Empty;
        }
        self.depth += 1;
        let declaration = self.font_declaration;
        let pending = self.pending_font_declaration.take();
        let node = self.parse_single_or_group_inner();
        self.depth -= 1;
        self.finish_font_element(node, declaration, pending)
    }

    /// 단일 토큰 또는 그룹 파싱 (첨자/인자용)
    fn parse_single_or_group_inner(&mut self) -> EqNode {
        if self.at_end() {
            return EqNode::Empty;
        }

        // RBrace는 그룹 종료 마커 — 소비하지 않고 빈 노드 반환
        if self.current_type() == TokenType::RBrace {
            return EqNode::Empty;
        }

        if self.current_type() == TokenType::LBrace {
            return self.parse_group();
        }

        // 단일 토큰
        let ty = self.current_type();
        let val = self.current_value().to_string();
        let from_latex = self.tokens.get(self.pos).is_some_and(|t| t.from_latex);
        self.pos += 1;

        match ty {
            TokenType::Command => {
                if let Some(symbol) = lookup_symbol(&val) {
                    EqNode::MathSymbol(symbol.to_string())
                } else if is_function(&val) {
                    EqNode::Function(lookup_function(&val).unwrap_or(&val).to_string())
                } else if !from_latex
                    && !is_structure_command(&val.to_ascii_uppercase())
                    && !FONT_STYLES.contains_key(val.to_ascii_lowercase().as_str())
                    && !DECORATIONS.contains_key(val.to_ascii_lowercase().as_str())
                {
                    // 무브레이스 첨자의 변수는 한 토큰이다. i가 다음 ^2까지
                    // 소비하면 x_i^2가 x_(i^2)로 바뀌어 동시 첨자를 잃는다.
                    EqNode::Text(val)
                } else {
                    // [#1204-B] decoration/구조 명령(bar, sqrt 등)도 단일 인자/body 로
                    // 올 수 있다 (`rm bar {...}`). parse_command 로 위임 — 미지 명령은
                    // parse_command 의 fall-through 가 Text 로 처리하므로 안전.
                    self.parse_command(&val, from_latex)
                }
            }
            TokenType::Number => EqNode::Number(val),
            TokenType::Text => EqNode::Text(val),
            TokenType::Quoted => EqNode::Quoted(val),
            TokenType::Symbol => Self::symbol_node(val),
            _ => EqNode::Text(val),
        }
    }

    /// 현재 토큰이 "공백 없이 붙은 관계연산자"인지 (#1304).
    /// HWP 무브레이스 하한 operand 의 연결 구분자 — `sum_k=1`, `lim_x->0`, `1<=k`.
    /// 관계연산자 앞에 공백이 있으면(`x^2 = 4`) false 를 돌려 묶지 않는다.
    fn is_tight_relational(&self) -> bool {
        match self.tokens.get(self.pos) {
            Some(t) => {
                t.ty == TokenType::Symbol
                    && !t.space_before
                    && matches!(
                        t.value.as_str(),
                        "=" | "<" | ">" | "<=" | ">=" | "!=" | "==" | "->"
                    )
            }
            None => false,
        }
    }

    /// 무브레이스 아래첨자/하한 operand 파싱 (#1304).
    /// `원자 (공백없는 관계연산자 원자)*` 패턴으로 하나의 operand 를 묶는다.
    /// `sum_k=1 ^6` 의 하한이 `k=1` 전체가 되도록 한다.
    /// 위첨자(`^`)에는 적용하지 않는다 — `x^2=4` 류 위첨자 등식 보호.
    fn parse_script_operand(&mut self) -> EqNode {
        // A closing brace is an explicit operand boundary even when `=` is
        // tight against it: `x_{2}=5^2` must leave `=5^2` outside the subscript.
        let explicit_group = self.current_type() == TokenType::LBrace;
        let first = self.parse_single_or_group();
        if explicit_group || !self.is_tight_relational() {
            return first;
        }
        let mut items = vec![first];
        while self.is_tight_relational() {
            let sym = self.current_value().to_string();
            self.pos += 1;
            items.push(Self::symbol_node(sym));
            items.push(self.parse_single_or_group());
        }
        EqNode::Row(items).simplify()
    }

    /// 공백 없는 위첨자 식의 다음 원자. `r^2n-1`의 `n`처럼 곱셈을
    /// 생략한 원자는 위첨자 안에 남지만 관계연산자와 명시적 그룹 경계는 넘지 않는다.
    fn is_tight_superscript_atom(&self, pos: usize) -> bool {
        self.tokens.get(pos).is_some_and(|token| {
            !token.space_before
                && matches!(
                    token.ty,
                    TokenType::Command | TokenType::Number | TokenType::Text | TokenType::Quoted
                )
                && (token.ty != TokenType::Command
                    || !is_structure_command(&token.value.to_ascii_uppercase()))
        })
    }

    /// 한컴의 무브레이스 위첨자는 공백 없는 가감식 전체를 피연산자로 쓴다.
    /// `r^n-1 +1`에서는 공백 앞에서 끝나고, `{n-1}`은 명시적 경계다.
    fn parse_superscript_operand(&mut self) -> EqNode {
        let explicit_group = self.current_type() == TokenType::LBrace;
        let first = self.parse_single_or_group();
        if explicit_group {
            return first;
        }

        let mut items = vec![first];
        loop {
            if self.is_tight_superscript_atom(self.pos) {
                items.push(self.parse_single_or_group());
                continue;
            }
            let Some(operator) = self.tokens.get(self.pos) else {
                break;
            };
            if operator.ty != TokenType::Symbol
                || operator.space_before
                || !matches!(operator.value.as_str(), "+" | "-")
                || !self.is_tight_superscript_atom(self.pos + 1)
            {
                break;
            }
            items.push(EqNode::Symbol(operator.value.clone()));
            self.pos += 1;
            items.push(self.parse_single_or_group());
        }
        EqNode::Row(items).simplify()
    }

    /// 첨자(subscript/superscript) 파싱 시도
    /// 한컴 수식에서 함수/기호 뒤에 Thin 공백(`)이 오고 첨자가 따라오는 패턴이 일반적이므로,
    /// Thin 공백 뒤에 첨자가 있으면 공백을 건너뛰고 첨자를 파싱한다.
    fn try_parse_scripts(&mut self, base: EqNode) -> EqNode {
        let attach = |base, sub: Option<EqNode>, sup: Option<EqNode>| match (sub, sup) {
            (Some(sub), Some(sup)) => EqNode::SubSup {
                base: Box::new(base),
                sub: Box::new(sub),
                sup: Box::new(sup),
            },
            (Some(sub), None) => EqNode::Subscript {
                base: Box::new(base),
                sub: Box::new(sub),
            },
            (None, Some(sup)) => EqNode::Superscript {
                base: Box::new(base),
                sup: Box::new(sup),
            },
            (None, None) => base,
        };
        let mut result = base;
        let mut sub = None;
        let mut sup = None;

        loop {
            if self.at_end() {
                break;
            }
            // HWP font declarations between a nucleus and its script style
            // the following script; they do not make the script a new atom.
            // `rm C it rm _{it r rm}` is the saved combinatorial form.
            if let (Some(first), Some(second), Some(script)) = (
                self.tokens.get(self.pos),
                self.tokens.get(self.pos + 1),
                self.tokens.get(self.pos + 2),
            ) {
                if first.ty == TokenType::Command
                    && second.ty == TokenType::Command
                    && !first.from_latex
                    && !second.from_latex
                    && Self::cmd_eq(&first.value, "it")
                    && Self::cmd_eq(&second.value, "rm")
                    && matches!(script.ty, TokenType::Subscript | TokenType::Superscript)
                {
                    self.pos += 2;
                    self.font_declaration = Some(FontStyleKind::Roman);
                }
            }
            // 명시한 thin 공백은 첨자 앞에서도 실제 폭이다. 이미 읽은 첨자 뒤의
            // 공백은 그 첨자를 닫으므로 x_1`^2의 두 첨자는 같은 칸에 겹치지 않는다.
            let mut after_spaces = self.pos;
            while self
                .tokens
                .get(after_spaces)
                .is_some_and(|token| token.ty == TokenType::Whitespace && token.value == "`")
            {
                after_spaces += 1;
            }
            if after_spaces > self.pos
                && self.tokens.get(after_spaces).is_some_and(|token| {
                    matches!(token.ty, TokenType::Subscript | TokenType::Superscript)
                })
            {
                result = attach(result, sub.take(), sup.take());
                let mut spaced = vec![result];
                spaced.extend((self.pos..after_spaces).map(|_| EqNode::Space(SpaceKind::Thin)));
                result = EqNode::Row(spaced).simplify();
                self.pos = after_spaces;
            }
            let ty = self.current_type();
            if ty == TokenType::Subscript && sub.is_none() {
                self.pos += 1;
                sub = Some(self.parse_script_operand());
            } else if ty == TokenType::Superscript && sup.is_none() {
                self.pos += 1;
                sup = Some(self.parse_superscript_operand());
            } else {
                break;
            }
        }

        attach(result, sub, sup)
    }

    /// 분수 파싱: 최상위 OVER 기준으로 분자/분모 분리
    /// LEFT-RIGHT 내부의 OVER는 무시하고 최상위 레벨의 OVER만 분수 분기점으로 사용한다.
    fn parse_fraction(&mut self) -> EqNode {
        // 최상위 OVER 위치를 먼저 찾는다 (brace_depth==0 && lr_depth==0)
        let toplevel_over_pos = {
            let mut brace_depth = 0i32;
            let mut lr_depth = 0i32;
            let mut found = None;
            for i in self.pos..self.tokens.len() {
                let t = &self.tokens[i];
                match t.ty {
                    TokenType::LBrace => brace_depth += 1,
                    TokenType::RBrace => brace_depth -= 1,
                    TokenType::Command => {
                        if Self::cmd_eq(&t.value, "LEFT") {
                            lr_depth += 1;
                        } else if Self::cmd_eq(&t.value, "RIGHT") {
                            lr_depth -= 1;
                        } else if Self::cmd_eq(&t.value, "OVER")
                            && brace_depth == 0
                            && lr_depth == 0
                        {
                            found = Some(i);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            found
        };

        let over_pos = match toplevel_over_pos {
            Some(p) => p,
            None => return self.parse_expression(), // fallback
        };

        // OVER 앞의 모든 요소를 파싱
        let mut before_nodes = Vec::new();
        while self.pos < over_pos && !self.at_end() {
            before_nodes.push(self.parse_element());
        }
        // OVER 건너뛰기
        if self.current_type() == TokenType::Command && Self::cmd_eq(self.current_value(), "OVER") {
            self.pos += 1;
        }

        // 분자: OVER 바로 앞의 마지막 요소 (그룹 또는 단일 요소)
        let (pre_nodes, numer) = if before_nodes.len() > 1 {
            let numer = before_nodes.pop().unwrap();
            (before_nodes, numer)
        } else {
            (Vec::new(), EqNode::Row(before_nodes).simplify())
        };

        // 분모: OVER 바로 뒤의 첫 번째 요소 (그룹 또는 단일 요소)
        let denom = if !self.at_end() {
            self.parse_element()
        } else {
            EqNode::Empty
        };

        // 분수 뒤 나머지 요소
        let mut after_nodes = Vec::new();
        while !self.at_end() {
            if self.current_type() == TokenType::RBrace {
                break;
            }
            if self.current_type() == TokenType::Command
                && Self::cmd_eq(self.current_value(), "RIGHT")
            {
                break;
            }
            after_nodes.push(self.parse_element());
        }

        let fraction = EqNode::Fraction {
            numer: Box::new(numer),
            denom: Box::new(denom),
        };

        // 앞/뒤 요소와 분수를 Row로 조립
        if pre_nodes.is_empty() && after_nodes.is_empty() {
            fraction
        } else {
            let mut all = pre_nodes;
            all.push(fraction);
            all.extend(after_nodes);
            EqNode::Row(all).simplify()
        }
    }

    /// RBrace까지 분수 파싱
    fn parse_fraction_until_rbrace(&mut self) -> EqNode {
        let mut numer_nodes = Vec::new();
        while !self.at_end() {
            if self.current_type() == TokenType::RBrace {
                break;
            }
            if self.current_type() == TokenType::Command
                && (Self::cmd_eq(self.current_value(), "OVER"))
            {
                self.pos += 1;
                break;
            }
            numer_nodes.push(self.parse_element());
        }

        let mut denom_nodes = Vec::new();
        while !self.at_end() {
            if self.current_type() == TokenType::RBrace {
                break;
            }
            denom_nodes.push(self.parse_element());
        }

        EqNode::Fraction {
            numer: Box::new(EqNode::Row(numer_nodes).simplify()),
            denom: Box::new(EqNode::Row(denom_nodes).simplify()),
        }
    }

    /// 제곱근 파싱: SQRT x, SQRT(n) of x
    fn parse_sqrt(&mut self) -> EqNode {
        // LaTeX \sqrt[n]{x} 패턴
        if self.current_type() == TokenType::LBracket {
            self.pos += 1; // [
            let mut index_nodes = Vec::new();
            while !self.at_end() && self.current_type() != TokenType::RBracket {
                index_nodes.push(self.parse_element());
            }
            self.expect(TokenType::RBracket);

            let body = self.parse_single_or_group();
            return EqNode::Sqrt {
                index: Some(Box::new(EqNode::Row(index_nodes).simplify())),
                body: Box::new(body),
            };
        }

        // SQRT(n) of x 패턴 확인 — 소괄호
        if self.current_type() == TokenType::LParen {
            self.pos += 1; // (
            let mut index_nodes = Vec::new();
            while !self.at_end() && self.current_type() != TokenType::RParen {
                index_nodes.push(self.parse_element());
            }
            self.expect(TokenType::RParen); // )

            // 'of' 키워드 건너뛰기
            if self.current_type() == TokenType::Command
                && self.current_value().eq_ignore_ascii_case("of")
            {
                self.pos += 1;
            }

            let body = self.parse_single_or_group();
            return EqNode::Sqrt {
                index: Some(Box::new(EqNode::Row(index_nodes).simplify())),
                body: Box::new(body),
            };
        }

        // SQRT {n} of {x} 패턴 확인 — 중괄호 + of
        if self.current_type() == TokenType::LBrace {
            // 먼저 {n} 뒤에 'of'가 있는지 미리 확인
            let saved_pos = self.pos;
            let brace_end = self.find_matching_brace(self.pos + 1);
            let after_brace = brace_end + 1;
            let has_of = after_brace < self.tokens.len()
                && self.tokens[after_brace].ty == TokenType::Command
                && self.tokens[after_brace].value.eq_ignore_ascii_case("of");

            if has_of {
                // {n} 파싱
                let index = self.parse_group();
                // 'of' 건너뛰기
                if self.current_type() == TokenType::Command
                    && self.current_value().eq_ignore_ascii_case("of")
                {
                    self.pos += 1;
                }
                let body = self.parse_single_or_group();
                return EqNode::Sqrt {
                    index: Some(Box::new(index)),
                    body: Box::new(body),
                };
            }
            // of가 없으면 되돌리고 일반 제곱근으로 처리
            self.pos = saved_pos;
        }

        // 일반 제곱근
        let body = self.parse_single_or_group();
        EqNode::Sqrt {
            index: None,
            body: Box::new(body),
        }
    }

    /// LaTeX 분수 파싱: \frac{numer}{denom}
    fn parse_latex_fraction(&mut self) -> EqNode {
        let numer = self.parse_single_or_group();
        let denom = self.parse_single_or_group();
        EqNode::Fraction {
            numer: Box::new(numer),
            denom: Box::new(denom),
        }
    }

    /// \begin{env}...\end{env} 환경 파싱
    fn parse_latex_environment(&mut self) -> EqNode {
        let env_name = self.read_brace_arg();
        let env_upper = env_name.to_ascii_uppercase();

        match env_upper.as_str() {
            "PMATRIX" => self.parse_latex_env_matrix(MatrixStyle::Paren, &env_name),
            "BMATRIX" => self.parse_latex_env_matrix(MatrixStyle::Bracket, &env_name),
            "VMATRIX" => self.parse_latex_env_matrix(MatrixStyle::Vert, &env_name),
            "BVMATRIX" => self.parse_latex_env_matrix(MatrixStyle::Vert, &env_name),
            "SMALLMATRIX" => self.parse_latex_env_matrix(MatrixStyle::Plain, &env_name),
            "MATRIX" | "ARRAY" => self.parse_latex_env_matrix(MatrixStyle::Plain, &env_name),
            "CASES" => self.parse_latex_env_cases(&env_name),
            "ALIGNED" | "ALIGN" | "EQNARRAY" | "SPLIT" | "GATHER" | "GATHERED" => {
                self.parse_latex_env_eqalign(&env_name)
            }
            _ => EqNode::Empty,
        }
    }

    /// {env_name} 읽기 — 중괄호 안의 텍스트를 반환
    fn read_brace_arg(&mut self) -> String {
        if self.current_type() != TokenType::LBrace {
            return String::new();
        }
        self.pos += 1;
        let mut name = String::new();
        while !self.at_end() && self.current_type() != TokenType::RBrace {
            name.push_str(self.current_value());
            self.pos += 1;
        }
        self.expect(TokenType::RBrace);
        name
    }

    /// \end{env} 의 {env} 인자를 소비하고 건너뛰기
    fn skip_brace_arg(&mut self) {
        if self.current_type() == TokenType::LBrace {
            self.pos += 1;
            while !self.at_end() && self.current_type() != TokenType::RBrace {
                self.pos += 1;
            }
            self.expect(TokenType::RBrace);
        }
    }

    /// \end{env} 도달 여부 확인
    fn at_latex_env_end(&self, env_name: &str) -> bool {
        if self.current_type() != TokenType::Command {
            return false;
        }
        let val = self.current_value();
        if !val.eq_ignore_ascii_case("end") {
            return false;
        }
        let next = self.pos + 1;
        if next >= self.tokens.len() || self.tokens[next].ty != TokenType::LBrace {
            return false;
        }
        let mut i = next + 1;
        let mut name = String::new();
        while i < self.tokens.len() && self.tokens[i].ty != TokenType::RBrace {
            name.push_str(&self.tokens[i].value);
            i += 1;
        }
        name.eq_ignore_ascii_case(env_name)
    }

    /// \end{env}를 소비 (command + {env_name})
    fn consume_latex_env_end(&mut self) {
        if self.current_type() == TokenType::Command
            && self.current_value().eq_ignore_ascii_case("end")
        {
            self.pos += 1;
            self.skip_brace_arg();
        }
    }

    /// LaTeX matrix 환경 파싱: \begin{pmatrix} a & b \\ c & d \end{pmatrix}
    fn parse_latex_env_matrix(&mut self, style: MatrixStyle, env_name: &str) -> EqNode {
        let mut rows: Vec<Vec<EqNode>> = vec![vec![]];
        let mut current_cell = Vec::new();

        while !self.at_end() && !self.at_latex_env_end(env_name) {
            if self.current_type() == TokenType::Whitespace && self.current_value() == "#" {
                self.pos += 1;
                if let Some(last_row) = rows.last_mut() {
                    last_row.push(EqNode::Row(current_cell).simplify());
                }
                current_cell = Vec::new();
                rows.push(vec![]);
            } else if self.current_type() == TokenType::Whitespace && self.current_value() == "&" {
                if let Some(last_row) = rows.last_mut() {
                    last_row.push(EqNode::Row(current_cell).simplify());
                }
                current_cell = Vec::new();
                self.pos += 1;
            } else if self.try_consume_infix_over_atop(&mut current_cell) {
                continue;
            } else {
                current_cell.push(self.parse_element());
            }
        }

        if !current_cell.is_empty() || rows.last().map_or(false, |r| !r.is_empty()) {
            if let Some(last_row) = rows.last_mut() {
                last_row.push(EqNode::Row(current_cell).simplify());
            }
        }
        // 빈 마지막 행 제거 (후행 \\ 대응)
        if rows.last().map_or(false, |r| r.is_empty()) {
            rows.pop();
        }

        self.consume_latex_env_end();
        EqNode::Matrix { rows, style }
    }

    /// LaTeX cases 환경 파싱: \begin{cases} expr & cond \\ ... \end{cases}
    fn parse_latex_env_cases(&mut self, env_name: &str) -> EqNode {
        let mut case_rows = Vec::new();
        let mut current_row = Vec::new();

        while !self.at_end() && !self.at_latex_env_end(env_name) {
            if self.current_type() == TokenType::Whitespace && self.current_value() == "#" {
                self.pos += 1;
                case_rows.push(EqNode::Row(current_row).simplify());
                current_row = Vec::new();
            } else if self.current_type() == TokenType::Whitespace && self.current_value() == "&" {
                current_row.push(EqNode::Space(SpaceKind::Tab));
                self.pos += 1;
            } else if self.try_consume_infix_over_atop(&mut current_row) {
                continue;
            } else {
                current_row.push(self.parse_element());
            }
        }

        if !current_row.is_empty() {
            case_rows.push(EqNode::Row(current_row).simplify());
        }

        self.consume_latex_env_end();
        EqNode::Cases { rows: case_rows }
    }

    /// LaTeX aligned/align 환경 파싱
    fn parse_latex_env_eqalign(&mut self, env_name: &str) -> EqNode {
        let mut eq_rows: Vec<(EqNode, EqNode)> = Vec::new();
        let mut current_left = Vec::new();
        let mut current_right: Option<Vec<EqNode>> = None;

        while !self.at_end() && !self.at_latex_env_end(env_name) {
            if self.current_type() == TokenType::Whitespace && self.current_value() == "#" {
                self.pos += 1;
                let left = EqNode::Row(current_left).simplify();
                let right = current_right
                    .map(|r| EqNode::Row(r).simplify())
                    .unwrap_or(EqNode::Empty);
                eq_rows.push((left, right));
                current_left = Vec::new();
                current_right = None;
            } else if self.current_type() == TokenType::Whitespace && self.current_value() == "&" {
                if current_right.is_none() {
                    current_right = Some(Vec::new());
                }
                self.pos += 1;
            } else {
                let consumed = if let Some(ref mut right) = current_right {
                    self.try_consume_infix_over_atop(right)
                } else {
                    self.try_consume_infix_over_atop(&mut current_left)
                };
                if consumed {
                    continue;
                }
                if let Some(ref mut right) = current_right {
                    right.push(self.parse_element());
                } else {
                    current_left.push(self.parse_element());
                }
            }
        }

        if !current_left.is_empty() || current_right.is_some() {
            let left = EqNode::Row(current_left).simplify();
            let right = current_right
                .map(|r| EqNode::Row(r).simplify())
                .unwrap_or(EqNode::Empty);
            eq_rows.push((left, right));
        }

        self.consume_latex_env_end();
        EqNode::EqAlign { rows: eq_rows }
    }

    /// 큰 연산자 파싱 (적분, 합 등) — 첨자 포함
    fn parse_big_op(&mut self, symbol: String) -> EqNode {
        let mut sub = None;
        let mut sup = None;

        // 첨자 파싱
        loop {
            if self.at_end() {
                break;
            }
            if self.current_type() == TokenType::Subscript && sub.is_none() {
                self.pos += 1;
                sub = Some(Box::new(self.parse_script_operand()));
            } else if self.current_type() == TokenType::Superscript && sup.is_none() {
                self.pos += 1;
                sup = Some(Box::new(self.parse_single_or_group()));
            } else {
                break;
            }
        }

        EqNode::BigOp { symbol, sub, sup }
    }

    /// 극한 파싱
    fn parse_limit(&mut self, is_upper: bool) -> EqNode {
        let mut sub = None;

        if self.current_type() == TokenType::Subscript {
            self.pos += 1;
            let explicit_group = self.current_type() == TokenType::LBrace;
            let mut operand = self.parse_script_operand();
            // 한쪽 극한의 부호는 공백 앞에서 하한을 닫는다 (`lim_t->0+ g(t)`).
            // 명시 그룹과 본문에 띄어 쓴 부호는 이 경계를 넘지 않는다.
            let one_sided = !explicit_group
                && matches!(&operand, EqNode::Row(nodes)
                    if nodes.iter().any(|node| matches!(node, EqNode::MathSymbol(s) if s == "→")))
                && self.tokens.get(self.pos).is_some_and(|token| {
                    token.ty == TokenType::Symbol
                        && !token.space_before
                        && matches!(token.value.as_str(), "+" | "-")
                })
                && self.tokens.get(self.pos + 1).map_or(true, |token| {
                    token.space_before
                        || matches!(
                            token.ty,
                            TokenType::RBrace | TokenType::Whitespace | TokenType::Eof
                        )
                });
            if one_sided {
                if let EqNode::Row(nodes) = &mut operand {
                    nodes.push(EqNode::Symbol(self.current_value().to_string()));
                }
                self.pos += 1;
            }
            sub = Some(Box::new(operand));
        }

        EqNode::Limit { is_upper, sub }
    }

    /// 행렬 파싱: MATRIX{a & b # c & d}
    fn parse_matrix(&mut self, style: MatrixStyle) -> EqNode {
        if !self.expect(TokenType::LBrace) {
            return EqNode::Empty;
        }

        let end = self.find_matching_brace(self.pos);
        let mut rows: Vec<Vec<EqNode>> = vec![vec![]];
        let mut current_cell = Vec::new();

        while self.pos < end && !self.at_end() {
            if self.current_type() == TokenType::RBrace {
                break;
            }
            if self.current_type() == TokenType::Whitespace && self.current_value() == "#" {
                // 새 행
                if let Some(last_row) = rows.last_mut() {
                    last_row.push(EqNode::Row(current_cell).simplify());
                }
                current_cell = Vec::new();
                rows.push(vec![]);
                self.pos += 1;
            } else if self.current_type() == TokenType::Whitespace && self.current_value() == "&" {
                // 새 셀
                if let Some(last_row) = rows.last_mut() {
                    last_row.push(EqNode::Row(current_cell).simplify());
                }
                current_cell = Vec::new();
                self.pos += 1;
            } else if self.try_consume_infix_over_atop(&mut current_cell) {
                // OVER/ATOP 중위 처리 (#505)
                continue;
            } else {
                current_cell.push(self.parse_element());
            }
        }

        // 마지막 셀 추가
        if !current_cell.is_empty() || rows.last().map_or(false, |r| !r.is_empty()) {
            if let Some(last_row) = rows.last_mut() {
                last_row.push(EqNode::Row(current_cell).simplify());
            }
        }

        self.expect(TokenType::RBrace);

        EqNode::Matrix { rows, style }
    }

    /// 조건식 파싱: CASES{...}
    fn parse_cases(&mut self) -> EqNode {
        if !self.expect(TokenType::LBrace) {
            return EqNode::Empty;
        }

        let end = self.find_matching_brace(self.pos);
        let mut rows = Vec::new();
        let mut current_row = Vec::new();

        while self.pos < end && !self.at_end() {
            if self.current_type() == TokenType::RBrace {
                break;
            }
            if self.current_type() == TokenType::Whitespace && self.current_value() == "#" {
                rows.push(EqNode::Row(current_row).simplify());
                current_row = Vec::new();
                self.pos += 1;
            } else if self.current_type() == TokenType::Whitespace && self.current_value() == "&" {
                // && (연속 &): 큰 탭 공간으로 조건 부분 분리
                let mut amp_count = 0;
                while self.pos < end
                    && self.current_type() == TokenType::Whitespace
                    && self.current_value() == "&"
                {
                    amp_count += 1;
                    self.pos += 1;
                }
                for _ in 0..amp_count {
                    current_row.push(EqNode::Space(super::ast::SpaceKind::Tab));
                }
            } else if self.try_consume_infix_over_atop(&mut current_row) {
                // OVER/ATOP 중위 처리 (#505)
                continue;
            } else {
                current_row.push(self.parse_element());
            }
        }

        if !current_row.is_empty() {
            rows.push(EqNode::Row(current_row).simplify());
        }

        self.expect(TokenType::RBrace);

        EqNode::Cases { rows }
    }

    /// 세로 쌓기 파싱
    fn parse_pile(&mut self, align: PileAlign) -> EqNode {
        if !self.expect(TokenType::LBrace) {
            return EqNode::Empty;
        }

        let end = self.find_matching_brace(self.pos);
        let mut rows = Vec::new();
        let mut current_row = Vec::new();

        while self.pos < end && !self.at_end() {
            if self.current_type() == TokenType::RBrace {
                break;
            }
            if self.current_type() == TokenType::Whitespace && self.current_value() == "#" {
                rows.push(EqNode::Row(current_row).simplify());
                current_row = Vec::new();
                self.pos += 1;
            } else if self.try_consume_infix_over_atop(&mut current_row) {
                // OVER/ATOP 중위 처리 (#505)
                continue;
            } else {
                current_row.push(self.parse_element());
            }
        }

        // 마지막 `#`도 빈 행 하나를 만든다. PILE의 행 수는 둘러싼
        // LEFT/RIGHT 괄호 높이에 쓰인다.
        if !current_row.is_empty() || !rows.is_empty() {
            rows.push(EqNode::Row(current_row).simplify());
        }

        self.expect(TokenType::RBrace);

        EqNode::Pile { rows, align }
    }

    /// EQALIGN 파싱: EQALIGN{row1_left & row1_right # row2_left & row2_right}
    fn parse_eqalign(&mut self) -> EqNode {
        if !self.expect(TokenType::LBrace) {
            return EqNode::Empty;
        }

        let end = self.find_matching_brace(self.pos);
        let mut rows: Vec<(EqNode, EqNode)> = Vec::new();
        let mut current_left = Vec::new();
        let mut current_right: Option<Vec<EqNode>> = None;
        // `#` 뒤가 비어도 빈 행이다 (math-001 `eqalign{``5x+a#}`: 한컴이 한 줄을 비운다).
        let mut after_separator = false;

        while self.pos < end && !self.at_end() {
            if self.current_type() == TokenType::RBrace {
                break;
            }
            if self.current_type() == TokenType::Whitespace && self.current_value() == "#" {
                // 새 행: 현재 행 완료
                let left = EqNode::Row(current_left).simplify();
                let right = current_right
                    .map(|r| EqNode::Row(r).simplify())
                    .unwrap_or(EqNode::Empty);
                rows.push((left, right));
                current_left = Vec::new();
                current_right = None;
                after_separator = true;
                self.pos += 1;
            } else if self.current_type() == TokenType::Whitespace && self.current_value() == "&" {
                // & 구분: 왼쪽→오른쪽 전환
                // 연속 &&: 큰 탭 공간 (조건 부분 분리용)
                let mut amp_count = 0;
                while self.pos < end
                    && self.current_type() == TokenType::Whitespace
                    && self.current_value() == "&"
                {
                    amp_count += 1;
                    self.pos += 1;
                }
                if current_right.is_none() {
                    current_right = Some(Vec::new());
                    // 연속 && 이면 큰 탭 공간 삽입
                    if amp_count >= 2 {
                        if let Some(ref mut right) = current_right {
                            right.push(EqNode::Space(super::ast::SpaceKind::Tab));
                        }
                    }
                } else if let Some(ref mut right) = current_right {
                    // 이미 오른쪽: 추가 & → 탭 공간
                    for _ in 0..amp_count {
                        right.push(EqNode::Space(super::ast::SpaceKind::Tab));
                    }
                }
            } else {
                // OVER/ATOP 중위 처리 (#505) — 활성 측(right 우선) 의 children 에 적용
                let consumed = if let Some(ref mut right) = current_right {
                    self.try_consume_infix_over_atop(right)
                } else {
                    self.try_consume_infix_over_atop(&mut current_left)
                };
                if consumed {
                    continue;
                }
                if let Some(ref mut right) = current_right {
                    right.push(self.parse_element());
                } else {
                    current_left.push(self.parse_element());
                }
            }
        }

        // 마지막 행 추가
        if !current_left.is_empty() || current_right.is_some() || after_separator {
            let left = EqNode::Row(current_left).simplify();
            let right = current_right
                .map(|r| EqNode::Row(r).simplify())
                .unwrap_or(EqNode::Empty);
            rows.push((left, right));
        }

        self.expect(TokenType::RBrace);

        EqNode::EqAlign { rows }
    }

    /// LEFT-RIGHT 괄호 파싱
    /// 내부의 OVER는 parse_expression의 중위 연산자 처리로 자동 처리된다.
    fn parse_left_right(&mut self) -> EqNode {
        // LEFT 다음 괄호 문자 읽기
        let left = self.read_bracket_char();

        // RIGHT까지의 내용을 parse_expression으로 파싱
        // parse_expression은 RIGHT를 만나면 자동 중단하고, OVER도 중위 연산자로 처리
        let body = self.parse_expression();

        // RIGHT 건너뛰기
        if self.current_type() == TokenType::Command && Self::cmd_eq(self.current_value(), "RIGHT")
        {
            self.pos += 1;
        }

        // RIGHT 다음 괄호 문자 읽기
        let right = self.read_bracket_char();

        EqNode::Paren {
            left,
            right,
            body: Box::new(body),
        }
    }

    /// 괄호 문자 읽기 (LEFT/RIGHT 뒤)
    fn read_bracket_char(&mut self) -> String {
        if self.at_end() {
            return String::new();
        }

        let ty = self.current_type();
        let val = self.current_value().to_string();

        match ty {
            TokenType::LParen
            | TokenType::RParen
            | TokenType::LBracket
            | TokenType::RBracket
            | TokenType::LBrace
            | TokenType::RBrace => {
                self.pos += 1;
                val
            }
            TokenType::Symbol if val == "|" || val == "." => {
                self.pos += 1;
                if val == "." {
                    String::new() // . = 괄호 생략
                } else {
                    val
                }
            }
            TokenType::Command => {
                // LBRACE, RBRACE 등 명령어
                if let Some(sym) = lookup_symbol(&val) {
                    self.pos += 1;
                    sym.to_string()
                } else {
                    String::new()
                }
            }
            _ => String::new(),
        }
    }

    /// RIGHT 위치 찾기 (LEFT-RIGHT 쌍 고려)
    fn find_right_pos(&self) -> usize {
        let mut depth = 1i32;
        let mut pos = self.pos;
        while pos < self.tokens.len() {
            let t = &self.tokens[pos];
            if t.ty == TokenType::Command {
                if Self::cmd_eq(&t.value, "LEFT") {
                    depth += 1;
                } else if Self::cmd_eq(&t.value, "RIGHT") {
                    depth -= 1;
                    if depth == 0 {
                        return pos;
                    }
                }
            }
            pos += 1;
        }
        self.tokens.len()
    }

    /// 범위 내 분수 파싱
    /// OVER 앞/뒤에 중괄호 그룹이 있으면 해당 그룹만 분자/분모로 사용하고
    /// 나머지는 분수 바깥 요소로 처리한다.
    fn parse_fraction_in_range(&mut self, end: usize) -> EqNode {
        // OVER 앞의 모든 요소를 파싱
        let mut before_nodes = Vec::new();
        while self.pos < end && !self.at_end() {
            if self.current_type() == TokenType::Command
                && Self::cmd_eq(self.current_value(), "OVER")
            {
                self.pos += 1;
                break;
            }
            before_nodes.push(self.parse_element());
        }

        // 분자: OVER 바로 앞의 마지막 요소 (또는 그룹)
        // 나머지 앞 요소들은 분수 앞에 배치
        let (pre_nodes, numer) = if before_nodes.len() > 1 {
            let numer = before_nodes.pop().unwrap();
            (before_nodes, numer)
        } else {
            (Vec::new(), EqNode::Row(before_nodes).simplify())
        };

        // 분모: OVER 바로 뒤의 첫 번째 요소 (또는 그룹)
        let denom = if self.pos < end && !self.at_end() {
            self.parse_element()
        } else {
            EqNode::Empty
        };

        // 분수 뒤 나머지 요소
        let mut after_nodes = Vec::new();
        while self.pos < end && !self.at_end() {
            if self.current_type() == TokenType::Command
                && Self::cmd_eq(self.current_value(), "RIGHT")
            {
                break;
            }
            after_nodes.push(self.parse_element());
        }

        let fraction = EqNode::Fraction {
            numer: Box::new(numer),
            denom: Box::new(denom),
        };

        // 앞/뒤 요소와 분수를 Row로 조립
        if pre_nodes.is_empty() && after_nodes.is_empty() {
            fraction
        } else {
            let mut all = pre_nodes;
            all.push(fraction);
            all.extend(after_nodes);
            EqNode::Row(all).simplify()
        }
    }

    /// COLOR{R,G,B}{body} 파싱
    fn parse_color(&mut self) -> EqNode {
        if !self.expect(TokenType::LBrace) {
            return EqNode::Empty;
        }

        // R, G, B 값 읽기
        let mut rgb = [0u8; 3];
        for i in 0..3 {
            if self.current_type() == TokenType::Number {
                rgb[i] = self.current_value().parse().unwrap_or(0);
                self.pos += 1;
            }
            // 콤마 건너뛰기
            if self.current_type() == TokenType::Symbol && self.current_value() == "," {
                self.pos += 1;
            }
        }
        self.expect(TokenType::RBrace);

        let body = self.parse_single_or_group();

        EqNode::Color {
            r: rgb[0],
            g: rgb[1],
            b: rgb[2],
            body: Box::new(body),
        }
    }
}

/// 수식 스크립트를 AST로 파싱
pub fn parse(script: &str) -> EqNode {
    let tokens = tokenize(script);
    let mut parser = EqParser::new(tokens);
    parser.parse()
}








// LaTeX 명령어 호환 확장 테스트 (#143 2차)


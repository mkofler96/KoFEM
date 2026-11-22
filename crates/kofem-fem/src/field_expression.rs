// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Scalar field expressions in the model coordinates x, y, z (the mesh's
//! units, mm in the app), such as a temperature field `sqrt(x^2 + y^2) + z`.
//!
//! Grammar, loosest binding first:
//!
//! ```text
//! sum     = product { ("+" | "-") product }
//! product = unary { ("*" | "/") unary }
//! unary   = ("+" | "-") unary | power
//! power   = primary [ "^" unary ]          (right-associative)
//! primary = number | "x" | "y" | "z" | "pi" | "(" sum ")"
//!         | function "(" sum { "," sum } ")"
//! ```
//!
//! so `-x^2` is `-(x^2)` and `2^3^2` is `2^9`. Numbers are decimal with an
//! optional exponent (`1e-3`, `.5`). The functions are `sqrt abs exp ln log10
//! sin cos tan` of one argument (angles in radians) and `min max` of two.
//! Names are case-sensitive. Positions in errors count characters from 1.
//!
//! The parser builds a small expression tree once; evaluating it at a point
//! only walks the tree, so a field over every node of a mesh is cheap.

use thiserror::Error;

/// Every way a field expression is refused, naming the problem and the
/// character position (from 1) where it is.
#[derive(Debug, Clone, Error, PartialEq)]
pub enum FieldExpressionError {
    #[error("the expression is empty")]
    Empty,
    #[error(
        "unknown name \"{name}\" at position {position}; use x, y, z, pi or one of the \
         functions sqrt, abs, exp, ln, log10, sin, cos, tan, min, max"
    )]
    UnknownIdentifier { name: String, position: usize },
    #[error("unexpected \"{token}\" at position {position}")]
    UnexpectedToken { token: String, position: usize },
    #[error("unexpected character '{character}' at position {position}")]
    UnexpectedCharacter { character: char, position: usize },
    #[error("\"{text}\" at position {position} is not a valid number")]
    InvalidNumber { text: String, position: usize },
    #[error("the expression ends early; expected {expected}")]
    UnexpectedEnd { expected: &'static str },
    #[error("the parenthesis opened at position {position} is never closed")]
    UnclosedParenthesis { position: usize },
    #[error("the closing parenthesis at position {position} has no opening one")]
    UnmatchedClosingParenthesis { position: usize },
    #[error(
        "{function} at position {position} takes {expected} argument(s), but {found} were given"
    )]
    ArgumentCount {
        function: String,
        expected: usize,
        found: usize,
        position: usize,
    },
    #[error("{function} at position {position} needs its arguments in parentheses")]
    MissingArguments {
        function: &'static str,
        position: usize,
    },
    #[error("coordinate array has {len} values, which is not a multiple of 3")]
    CoordinateArrayLength { len: usize },
    #[error(
        "the expression is not a finite number ({value}) at the point ({}, {}, {})",
        point[0],
        point[1],
        point[2]
    )]
    NonFinite { value: f64, point: [f64; 3] },
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Function {
    Sqrt,
    Abs,
    Exp,
    Ln,
    Log10,
    Sin,
    Cos,
    Tan,
    Min,
    Max,
}

impl Function {
    fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "sqrt" => Self::Sqrt,
            "abs" => Self::Abs,
            "exp" => Self::Exp,
            "ln" => Self::Ln,
            "log10" => Self::Log10,
            "sin" => Self::Sin,
            "cos" => Self::Cos,
            "tan" => Self::Tan,
            "min" => Self::Min,
            "max" => Self::Max,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Self::Sqrt => "sqrt",
            Self::Abs => "abs",
            Self::Exp => "exp",
            Self::Ln => "ln",
            Self::Log10 => "log10",
            Self::Sin => "sin",
            Self::Cos => "cos",
            Self::Tan => "tan",
            Self::Min => "min",
            Self::Max => "max",
        }
    }

    fn arity(self) -> usize {
        match self {
            Self::Min | Self::Max => 2,
            _ => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Binary {
    Add,
    Subtract,
    Multiply,
    Divide,
    Power,
}

#[derive(Debug, Clone, PartialEq)]
enum Node {
    Number(f64),
    /// Coordinate 0, 1 or 2 (x, y, z).
    Coordinate(usize),
    Negate(Box<Node>),
    Binary(Binary, Box<Node>, Box<Node>),
    Call(Function, Vec<Node>),
}

impl Node {
    fn evaluate(&self, point: [f64; 3]) -> f64 {
        match self {
            Self::Number(value) => *value,
            Self::Coordinate(axis) => point[*axis],
            Self::Negate(operand) => -operand.evaluate(point),
            Self::Binary(operator, lhs, rhs) => {
                let (lhs, rhs) = (lhs.evaluate(point), rhs.evaluate(point));
                match operator {
                    Binary::Add => lhs + rhs,
                    Binary::Subtract => lhs - rhs,
                    Binary::Multiply => lhs * rhs,
                    Binary::Divide => lhs / rhs,
                    Binary::Power => lhs.powf(rhs),
                }
            }
            Self::Call(function, arguments) => {
                let first = arguments[0].evaluate(point);
                match function {
                    Function::Sqrt => first.sqrt(),
                    Function::Abs => first.abs(),
                    Function::Exp => first.exp(),
                    Function::Ln => first.ln(),
                    Function::Log10 => first.log10(),
                    Function::Sin => first.sin(),
                    Function::Cos => first.cos(),
                    Function::Tan => first.tan(),
                    Function::Min => first.min(arguments[1].evaluate(point)),
                    Function::Max => first.max(arguments[1].evaluate(point)),
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum TokenKind {
    Number(f64),
    Name(String),
    Plus,
    Minus,
    Star,
    Slash,
    Caret,
    Comma,
    Open,
    Close,
}

#[derive(Debug, Clone)]
struct Token {
    kind: TokenKind,
    /// The source text, for error messages.
    text: String,
    /// Character position, from 1.
    position: usize,
}

fn tokenize(source: &str) -> Result<Vec<Token>, FieldExpressionError> {
    let chars: Vec<char> = source.chars().collect();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        let character = chars[index];
        let position = index + 1;
        if character.is_whitespace() {
            index += 1;
            continue;
        }
        if character.is_ascii_digit() || character == '.' {
            let start = index;
            while index < chars.len() && (chars[index].is_ascii_digit() || chars[index] == '.') {
                index += 1;
            }
            if index < chars.len() && matches!(chars[index], 'e' | 'E') {
                index += 1;
                if index < chars.len() && matches!(chars[index], '+' | '-') {
                    index += 1;
                }
                while index < chars.len() && chars[index].is_ascii_digit() {
                    index += 1;
                }
            }
            let text: String = chars[start..index].iter().collect();
            let value: f64 = text
                .parse()
                .map_err(|_| FieldExpressionError::InvalidNumber {
                    text: text.clone(),
                    position,
                })?;
            tokens.push(Token {
                kind: TokenKind::Number(value),
                text,
                position,
            });
            continue;
        }
        if character.is_ascii_alphabetic() || character == '_' {
            let start = index;
            while index < chars.len()
                && (chars[index].is_ascii_alphanumeric() || chars[index] == '_')
            {
                index += 1;
            }
            let text: String = chars[start..index].iter().collect();
            tokens.push(Token {
                kind: TokenKind::Name(text.clone()),
                text,
                position,
            });
            continue;
        }
        let kind = match character {
            '+' => TokenKind::Plus,
            '-' | '\u{2212}' => TokenKind::Minus,
            '*' => TokenKind::Star,
            '/' => TokenKind::Slash,
            '^' => TokenKind::Caret,
            ',' => TokenKind::Comma,
            '(' => TokenKind::Open,
            ')' => TokenKind::Close,
            _ => {
                return Err(FieldExpressionError::UnexpectedCharacter {
                    character,
                    position,
                })
            }
        };
        tokens.push(Token {
            kind,
            text: character.to_string(),
            position,
        });
        index += 1;
    }
    Ok(tokens)
}

const OPERAND: &str = "a number, x, y, z, pi, a function or \"(\"";

struct Parser {
    tokens: Vec<Token>,
    next: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.next)
    }

    fn peek_kind(&self) -> Option<&TokenKind> {
        self.peek().map(|token| &token.kind)
    }

    fn advance(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.next).cloned();
        self.next += 1;
        token
    }

    fn unexpected(token: &Token) -> FieldExpressionError {
        if token.kind == TokenKind::Close {
            FieldExpressionError::UnmatchedClosingParenthesis {
                position: token.position,
            }
        } else {
            FieldExpressionError::UnexpectedToken {
                token: token.text.clone(),
                position: token.position,
            }
        }
    }

    fn sum(&mut self) -> Result<Node, FieldExpressionError> {
        let mut node = self.product()?;
        loop {
            let operator = match self.peek_kind() {
                Some(TokenKind::Plus) => Binary::Add,
                Some(TokenKind::Minus) => Binary::Subtract,
                _ => return Ok(node),
            };
            self.next += 1;
            node = Node::Binary(operator, Box::new(node), Box::new(self.product()?));
        }
    }

    fn product(&mut self) -> Result<Node, FieldExpressionError> {
        let mut node = self.unary()?;
        loop {
            let operator = match self.peek_kind() {
                Some(TokenKind::Star) => Binary::Multiply,
                Some(TokenKind::Slash) => Binary::Divide,
                _ => return Ok(node),
            };
            self.next += 1;
            node = Node::Binary(operator, Box::new(node), Box::new(self.unary()?));
        }
    }

    fn unary(&mut self) -> Result<Node, FieldExpressionError> {
        match self.peek_kind() {
            Some(TokenKind::Plus) => {
                self.next += 1;
                self.unary()
            }
            Some(TokenKind::Minus) => {
                self.next += 1;
                Ok(Node::Negate(Box::new(self.unary()?)))
            }
            _ => self.power(),
        }
    }

    fn power(&mut self) -> Result<Node, FieldExpressionError> {
        let base = self.primary()?;
        if self.peek_kind() == Some(&TokenKind::Caret) {
            self.next += 1;
            let exponent = self.unary()?;
            return Ok(Node::Binary(
                Binary::Power,
                Box::new(base),
                Box::new(exponent),
            ));
        }
        Ok(base)
    }

    /// Expect a ")" closing the parenthesis opened at `opened`.
    fn close(&mut self, opened: usize) -> Result<(), FieldExpressionError> {
        match self.advance() {
            Some(Token {
                kind: TokenKind::Close,
                ..
            }) => Ok(()),
            Some(token) => Err(FieldExpressionError::UnexpectedToken {
                token: token.text,
                position: token.position,
            }),
            None => Err(FieldExpressionError::UnclosedParenthesis { position: opened }),
        }
    }

    fn primary(&mut self) -> Result<Node, FieldExpressionError> {
        let token = self
            .advance()
            .ok_or(FieldExpressionError::UnexpectedEnd { expected: OPERAND })?;
        match &token.kind {
            TokenKind::Number(value) => Ok(Node::Number(*value)),
            TokenKind::Open => {
                let inner = self.sum()?;
                self.close(token.position)?;
                Ok(inner)
            }
            TokenKind::Name(name) => match name.as_str() {
                "x" => Ok(Node::Coordinate(0)),
                "y" => Ok(Node::Coordinate(1)),
                "z" => Ok(Node::Coordinate(2)),
                "pi" => Ok(Node::Number(std::f64::consts::PI)),
                other => {
                    let function = Function::from_name(other).ok_or_else(|| {
                        FieldExpressionError::UnknownIdentifier {
                            name: other.to_owned(),
                            position: token.position,
                        }
                    })?;
                    self.call(function, token.position)
                }
            },
            _ => Err(Self::unexpected(&token)),
        }
    }

    fn call(&mut self, function: Function, position: usize) -> Result<Node, FieldExpressionError> {
        let Some(open) = self
            .peek()
            .filter(|token| token.kind == TokenKind::Open)
            .map(|token| token.position)
        else {
            return Err(FieldExpressionError::MissingArguments {
                function: function.name(),
                position,
            });
        };
        self.next += 1;
        let mut arguments = vec![self.sum()?];
        while self.peek_kind() == Some(&TokenKind::Comma) {
            self.next += 1;
            arguments.push(self.sum()?);
        }
        self.close(open)?;
        if arguments.len() != function.arity() {
            return Err(FieldExpressionError::ArgumentCount {
                function: function.name().to_owned(),
                expected: function.arity(),
                found: arguments.len(),
                position,
            });
        }
        Ok(Node::Call(function, arguments))
    }
}

/// A parsed scalar field f(x, y, z).
#[derive(Debug, Clone, PartialEq)]
pub struct FieldExpression {
    root: Node,
}

impl FieldExpression {
    /// Parse `source` (see the module documentation for the grammar).
    ///
    /// # Errors
    /// A [`FieldExpressionError`] naming the first problem and its position.
    pub fn parse(source: &str) -> Result<Self, FieldExpressionError> {
        let tokens = tokenize(source)?;
        if tokens.is_empty() {
            return Err(FieldExpressionError::Empty);
        }
        let mut parser = Parser { tokens, next: 0 };
        let root = parser.sum()?;
        if let Some(token) = parser.peek() {
            return Err(Parser::unexpected(token));
        }
        Ok(Self { root })
    }

    /// The value at `point` (x, y, z).
    ///
    /// # Errors
    /// [`FieldExpressionError::NonFinite`] when the value is infinite or not
    /// a number there (a division by zero, the root or logarithm of a
    /// negative number, an overflow).
    pub fn evaluate(&self, point: [f64; 3]) -> Result<f64, FieldExpressionError> {
        let value = self.root.evaluate(point);
        if value.is_finite() {
            Ok(value)
        } else {
            Err(FieldExpressionError::NonFinite { value, point })
        }
    }

    /// The values at the points `coordinates` holds as x, y, z triples.
    ///
    /// # Errors
    /// [`FieldExpressionError::CoordinateArrayLength`] when the array does
    /// not hold triples, or the first point where the value is not finite.
    pub fn evaluate_points(&self, coordinates: &[f64]) -> Result<Vec<f64>, FieldExpressionError> {
        let (points, rest) = coordinates.as_chunks::<3>();
        if !rest.is_empty() {
            return Err(FieldExpressionError::CoordinateArrayLength {
                len: coordinates.len(),
            });
        }
        points.iter().map(|point| self.evaluate(*point)).collect()
    }
}

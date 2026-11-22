// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Scalar field expressions in x, y, z: grammar, precedence, functions, and
//! the errors that name what is wrong and where.

#![allow(
    clippy::panic,
    reason = "test helpers abort the test on an unexpected parse result"
)]

use kofem_fem::{FieldExpression, FieldExpressionError};

fn eval(formula: &str, point: [f64; 3]) -> f64 {
    FieldExpression::parse(formula)
        .unwrap_or_else(|error| panic!("{formula:?} should parse: {error}"))
        .evaluate(point)
        .unwrap_or_else(|error| panic!("{formula:?} should evaluate: {error}"))
}

fn parse_error(formula: &str) -> FieldExpressionError {
    match FieldExpression::parse(formula) {
        Ok(_) => panic!("{formula:?} should not parse"),
        Err(error) => error,
    }
}

fn close(actual: f64, expected: f64) -> bool {
    (actual - expected).abs() <= 1e-12 * expected.abs().max(1.0)
}

#[test]
fn numbers_and_coordinates() {
    assert!(close(eval("42", [0.0; 3]), 42.0));
    assert!(close(eval("1e-3", [0.0; 3]), 1e-3));
    assert!(close(eval("2.5E+2", [0.0; 3]), 250.0));
    assert!(close(eval(".5", [0.0; 3]), 0.5));
    assert!(close(eval("x", [1.0, 2.0, 3.0]), 1.0));
    assert!(close(eval("y", [1.0, 2.0, 3.0]), 2.0));
    assert!(close(eval("z", [1.0, 2.0, 3.0]), 3.0));
    assert!(close(eval("pi", [0.0; 3]), std::f64::consts::PI));
}

#[test]
fn precedence_and_associativity() {
    let point = [2.0, 3.0, 4.0];
    assert!(close(eval("1 + 2 * 3", point), 7.0));
    assert!(close(eval("(1 + 2) * 3", point), 9.0));
    assert!(close(eval("8 / 4 / 2", point), 1.0));
    assert!(close(eval("10 - 4 - 3", point), 3.0));
    // ^ is right-associative: 2^(3^2) = 512.
    assert!(close(eval("2^3^2", point), 512.0));
    // ^ binds tighter than unary minus: -x^2 = -(x^2).
    assert!(close(eval("-x^2", point), -4.0));
    assert!(close(eval("(-x)^2", point), 4.0));
    assert!(close(eval("2^-1", point), 0.5));
    assert!(close(eval("+x - -y", point), 5.0));
    assert!(close(eval("2*x*y - z/4", point), 11.0));
}

#[test]
fn functions() {
    let point = [0.25, -2.0, 9.0];
    assert!(close(eval("sqrt(z)", point), 3.0));
    assert!(close(eval("abs(y)", point), 2.0));
    assert!(close(eval("exp(0)", point), 1.0));
    assert!(close(eval("ln(exp(2))", point), 2.0));
    assert!(close(eval("log10(1000)", point), 3.0));
    assert!(close(eval("sin(pi/2)", point), 1.0));
    assert!(close(eval("cos(0)", point), 1.0));
    assert!(close(eval("tan(pi/4)", point), 1.0));
    assert!(close(eval("min(x, y)", point), -2.0));
    assert!(close(eval("max(x, y)", point), 0.25));
    assert!(close(eval("max(min(x, z), -1)", point), 0.25));
    // NAFEMS LE11: T = (x² + y²)^½ + z.
    assert!(close(eval("sqrt(x^2 + y^2) + z", [3.0, 4.0, 1.0]), 6.0));
}

#[test]
fn evaluates_many_points() {
    let expression = FieldExpression::parse("x + 10*y + 100*z").expect("parses");
    let values = expression
        .evaluate_points(&[1.0, 2.0, 3.0, -1.0, 0.0, 0.5])
        .expect("evaluates");
    assert_eq!(values.len(), 2);
    assert!(close(values[0], 321.0));
    assert!(close(values[1], 49.0));
}

#[test]
fn point_array_must_hold_triples() {
    let expression = FieldExpression::parse("x").expect("parses");
    assert_eq!(
        expression.evaluate_points(&[1.0, 2.0]),
        Err(FieldExpressionError::CoordinateArrayLength { len: 2 })
    );
}

#[test]
fn empty_input_is_refused() {
    assert_eq!(parse_error(""), FieldExpressionError::Empty);
    assert_eq!(parse_error("   "), FieldExpressionError::Empty);
}

#[test]
fn unknown_identifier_names_it_and_its_position() {
    let error = parse_error("x + foo(2)");
    assert_eq!(
        error,
        FieldExpressionError::UnknownIdentifier {
            name: "foo".to_owned(),
            position: 5,
        }
    );
    let message = error.to_string();
    assert!(message.contains("foo"), "{message}");
    assert!(message.contains('5'), "{message}");
    // A coordinate name is not a function, and w is no coordinate.
    assert!(matches!(
        parse_error("w"),
        FieldExpressionError::UnknownIdentifier { position: 1, .. }
    ));
}

#[test]
fn unexpected_token_names_it_and_its_position() {
    assert_eq!(
        parse_error("x + * y"),
        FieldExpressionError::UnexpectedToken {
            token: "*".to_owned(),
            position: 5,
        }
    );
    assert_eq!(
        parse_error("2 x"),
        FieldExpressionError::UnexpectedToken {
            token: "x".to_owned(),
            position: 3,
        }
    );
    assert!(matches!(
        parse_error("x +"),
        FieldExpressionError::UnexpectedEnd { .. }
    ));
    assert!(matches!(
        parse_error("x # 2"),
        FieldExpressionError::UnexpectedCharacter {
            character: '#',
            position: 3
        }
    ));
    assert!(matches!(
        parse_error("1e"),
        FieldExpressionError::InvalidNumber { position: 1, .. }
    ));
}

#[test]
fn unbalanced_parentheses_are_refused() {
    assert_eq!(
        parse_error("(x + 1"),
        FieldExpressionError::UnclosedParenthesis { position: 1 }
    );
    assert_eq!(
        parse_error("sqrt(x + (1)"),
        FieldExpressionError::UnclosedParenthesis { position: 5 }
    );
    assert_eq!(
        parse_error("x + 1)"),
        FieldExpressionError::UnmatchedClosingParenthesis { position: 6 }
    );
}

#[test]
fn wrong_argument_count_is_refused() {
    assert_eq!(
        parse_error("min(x)"),
        FieldExpressionError::ArgumentCount {
            function: "min".to_owned(),
            expected: 2,
            found: 1,
            position: 1,
        }
    );
    assert_eq!(
        parse_error("sqrt(x, y)"),
        FieldExpressionError::ArgumentCount {
            function: "sqrt".to_owned(),
            expected: 1,
            found: 2,
            position: 1,
        }
    );
    assert!(matches!(
        parse_error("sin x"),
        FieldExpressionError::MissingArguments { position: 1, .. }
    ));
}

#[test]
fn non_finite_value_reports_the_point() {
    let expression = FieldExpression::parse("1 / x").expect("parses");
    let error = expression.evaluate([0.0, 1.0, 2.0]);
    let Err(error) = error else {
        panic!("1/0 must be refused")
    };
    assert!(matches!(error, FieldExpressionError::NonFinite { .. }));
    let message = error.to_string();
    assert!(message.contains("(0, 1, 2)"), "{message}");
    let negative_root = FieldExpression::parse("sqrt(x)").expect("parses");
    assert!(matches!(
        negative_root.evaluate([-1.0, 0.0, 0.0]),
        Err(FieldExpressionError::NonFinite { .. })
    ));
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Scalar field expressions f(x, y, z) for the browser: a check for form
//! validation and an evaluation at many points (see
//! `kofem_fem::field_expression` for the grammar).

use kofem_fem::FieldExpression;
use wasm_bindgen::prelude::*;

/// Parse `formula`, so a form can report a malformed one as it is typed.
///
/// # Errors
/// The first problem in the formula, with its character position (from 1).
#[wasm_bindgen(js_name = checkFieldExpression)]
pub fn check_field_expression(formula: &str) -> Result<(), JsError> {
    FieldExpression::parse(formula)
        .map(|_| ())
        .map_err(|error| JsError::new(&error.to_string()))
}

/// Evaluate `formula` at the points `coordinates` holds as x, y, z triples
/// (model coordinates, in the mesh's units); one value per point.
///
/// # Errors
/// A malformed formula, a coordinate array that does not hold triples, or
/// the first point where the value is not finite (named in the message).
#[wasm_bindgen(js_name = evaluateFieldExpression)]
pub fn evaluate_field_expression(formula: &str, coordinates: &[f64]) -> Result<Vec<f64>, JsError> {
    FieldExpression::parse(formula)
        .and_then(|expression| expression.evaluate_points(coordinates))
        .map_err(|error| JsError::new(&error.to_string()))
}

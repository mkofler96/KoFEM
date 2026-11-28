// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser binding for the analysis report's numbers (`kofem_fem::report`).

use wasm_bindgen::prelude::*;

use crate::to_js;

/// The report's numbers from the nodal displacements (x, y, z per node) and
/// the nodal von Mises stress the app draws: `[max |u|, its node index,
/// max von Mises, 99th-percentile von Mises]`.
///
/// # Errors
/// An empty or non-finite field, or displacements not three per node.
#[wasm_bindgen(js_name = reportStats)]
pub fn report_stats(displacements: &[f64], von_mises: &[f64]) -> Result<Vec<f64>, JsError> {
    let stats = kofem_fem::report_stats(displacements, von_mises).map_err(|error| to_js(&error))?;
    #[allow(clippy::cast_precision_loss, reason = "a node index is far below 2^52")]
    let node = stats.max_displacement_node as f64;
    Ok(vec![
        stats.max_displacement,
        node,
        stats.max_von_mises,
        stats.p99_von_mises,
    ])
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser bindings for the statistics of a result field
//! (`kofem_fem::field_statistics`): the volume-weighted percentiles the
//! Results panel lists next to the field's min and max, and the safety
//! factors against yield.

use kofem_fem::{ElementMesh, SafetyFactor, SafetyInput, SafetyScope, StatisticsMesh};
use wasm_bindgen::prelude::*;

use crate::to_js;

/// The volume-weighted `quantiles` (each in [0, 1]) of `values`, one per node.
/// `tets` holds `tet_nodes` (4 or 10) nodes per tetrahedron, `hexes` eight per
/// hexahedron, `shell_triangles` three per facet with one thickness each in
/// `shell_thicknesses`.
///
/// # Errors
/// The checks of [`kofem_fem::nodal_percentiles`].
#[wasm_bindgen(js_name = nodalPercentiles)]
#[expect(
    clippy::too_many_arguments,
    reason = "a flat wasm-bindgen signature: typed arrays in, one call per plotted field"
)]
pub fn nodal_percentiles(
    points: &[f64],
    values: &[f64],
    tets: &[u32],
    tet_nodes: u32,
    hexes: &[u32],
    shell_triangles: &[u32],
    shell_thicknesses: &[f64],
    quantiles: &[f64],
) -> Result<Vec<f64>, JsError> {
    kofem_fem::nodal_percentiles(
        &StatisticsMesh {
            points,
            values,
            tets,
            tet_nodes: tet_nodes as usize,
            hexes,
            shell_triangles,
            shell_thicknesses,
        },
        quantiles,
    )
    .map_err(|error| to_js(&error))
}

/// The safety factors of a result (`kofem_fem::safety_factor`), one row per
/// factor: over the whole model, or per body.
#[wasm_bindgen]
pub struct SafetyFactorRows {
    rows: Vec<SafetyFactor>,
}

#[wasm_bindgen]
impl SafetyFactorRows {
    /// Whether the one row is over the whole model, of one material.
    #[wasm_bindgen(getter, js_name = wholeModel)]
    #[must_use]
    pub fn whole_model(&self) -> bool {
        matches!(
            self.rows[..],
            [SafetyFactor {
                scope: SafetyScope::Model,
                ..
            }]
        )
    }

    /// Each row's body index; empty for a whole-model row.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn bodies(&self) -> Vec<u32> {
        self.rows
            .iter()
            .filter_map(|row| match row.scope {
                SafetyScope::Model => None,
                SafetyScope::Body(body) => u32::try_from(body).ok(),
            })
            .collect()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn materials(&self) -> Vec<u32> {
        self.rows.iter().map(|row| row.material).collect()
    }

    #[wasm_bindgen(getter, js_name = yieldStrengths)]
    #[must_use]
    pub fn yield_strengths(&self) -> Vec<f64> {
        self.rows.iter().map(|row| row.yield_strength).collect()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn max(&self) -> Vec<f64> {
        self.rows.iter().map(|row| row.max).collect()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn quantile(&self) -> Vec<f64> {
        self.rows.iter().map(|row| row.quantile).collect()
    }

    #[wasm_bindgen(getter, js_name = maxFactors)]
    #[must_use]
    pub fn max_factors(&self) -> Vec<f64> {
        self.rows.iter().map(|row| row.max_factor).collect()
    }

    #[wasm_bindgen(getter, js_name = quantileFactors)]
    #[must_use]
    pub fn quantile_factors(&self) -> Vec<f64> {
        self.rows.iter().map(|row| row.quantile_factor).collect()
    }
}

/// The safety factors against yield of a von Mises field, one value per
/// element (tetrahedra, then hexahedra, then shell facets), against its max
/// and its volume-weighted `quantile`. `element_bodies` gives each element's
/// body as an index into `body_materials`, which holds each body's material
/// id; `yield_materials` and `yield_strengths` list the materials that have a
/// yield strength. The mesh arrays are those of [`nodal_percentiles`].
///
/// # Errors
/// Yield lists of different lengths, and the checks of
/// [`kofem_fem::safety_factors`].
#[wasm_bindgen(js_name = safetyFactors)]
#[expect(
    clippy::too_many_arguments,
    reason = "a flat wasm-bindgen signature: typed arrays in, one call per result"
)]
pub fn safety_factors(
    points: &[f64],
    tets: &[u32],
    tet_nodes: u32,
    hexes: &[u32],
    shell_triangles: &[u32],
    shell_thicknesses: &[f64],
    von_mises: &[f64],
    element_bodies: &[u32],
    body_materials: &[u32],
    yield_materials: &[u32],
    yield_strengths: &[f64],
    quantile: f64,
) -> Result<SafetyFactorRows, JsError> {
    if yield_materials.len() != yield_strengths.len() {
        return Err(JsError::new(&format!(
            "safety factor: {} materials for {} yield strengths",
            yield_materials.len(),
            yield_strengths.len()
        )));
    }
    let yields: Vec<(u32, f64)> = yield_materials
        .iter()
        .copied()
        .zip(yield_strengths.iter().copied())
        .collect();
    let rows = kofem_fem::safety_factors(
        &SafetyInput {
            elements: ElementMesh {
                points,
                tets,
                tet_nodes: tet_nodes as usize,
                hexes,
                shell_triangles,
                shell_thicknesses,
            },
            von_mises,
            element_bodies,
            body_materials,
            yield_strengths: &yields,
        },
        quantile,
    )
    .map_err(|error| to_js(&error))?;
    Ok(SafetyFactorRows { rows })
}

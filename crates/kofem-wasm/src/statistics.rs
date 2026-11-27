// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser bindings for the statistics of a nodal field the Results panel
//! lists next to its min and max: the volume-weighted percentiles
//! (`kofem_fem::field_statistics`) and where the field peaks, with the
//! support and load selections on that node (`kofem_fem::field_peak`).

use kofem_fem::{PeakInput, StatisticsMesh};
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

/// Where a nodal field peaks (from `fieldPeak`).
#[wasm_bindgen]
pub struct FieldPeak {
    peak: kofem_fem::FieldPeak,
}

#[wasm_bindgen]
impl FieldPeak {
    /// The node's index in the field; the first such node on a tie.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn node(&self) -> usize {
        self.peak.node
    }

    /// The node's coordinates, x, y, z.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn at(&self) -> Vec<f64> {
        self.peak.at.to_vec()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn value(&self) -> f64 {
        self.peak.value
    }

    /// The selections that hold the node, in ascending order.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn selections(&self) -> Vec<usize> {
        self.peak.selections.clone()
    }
}

/// Where `values` (one per node at `points`, x, y, z each) is largest, and
/// which selections hold that node: selection `k` holds the node indices
/// `selection_nodes[selection_offsets[k]..selection_offsets[k + 1]]`.
///
/// # Errors
/// The checks of [`kofem_fem::field_peak`].
#[wasm_bindgen(js_name = fieldPeak)]
pub fn field_peak(
    points: &[f64],
    values: &[f64],
    selection_offsets: &[u32],
    selection_nodes: &[u32],
) -> Result<FieldPeak, JsError> {
    kofem_fem::field_peak(&PeakInput {
        points,
        values,
        selection_offsets,
        selection_nodes,
    })
    .map(|peak| FieldPeak { peak })
    .map_err(|error| to_js(&error))
}

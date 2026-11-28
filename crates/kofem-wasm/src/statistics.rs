// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser bindings for the statistics of a result field
//! (`kofem_fem::field_statistics`): the volume-weighted percentiles the
//! Results panel lists next to the field's min and max, and the per-body max
//! and percentile its safety factors are taken against.

use kofem_fem::{ElementMesh, StatisticsMesh};
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

/// Per group, the max and the volume-weighted `quantile` of an element field
/// averaged to the nodes over that group's elements, as `[max, quantile]`
/// pairs in group order. `values` and `groups` hold one entry per element:
/// tetrahedra, then hexahedra, then shell facets. The mesh arrays are those
/// of [`nodal_percentiles`].
///
/// # Errors
/// The checks of [`kofem_fem::grouped_element_statistics`].
#[wasm_bindgen(js_name = groupedElementStatistics)]
#[expect(
    clippy::too_many_arguments,
    reason = "a flat wasm-bindgen signature: typed arrays in, one call per result"
)]
pub fn grouped_element_statistics(
    points: &[f64],
    tets: &[u32],
    tet_nodes: u32,
    hexes: &[u32],
    shell_triangles: &[u32],
    shell_thicknesses: &[f64],
    values: &[f64],
    groups: &[u32],
    group_count: u32,
    quantile: f64,
) -> Result<Vec<f64>, JsError> {
    let statistics = kofem_fem::grouped_element_statistics(
        &ElementMesh {
            points,
            tets,
            tet_nodes: tet_nodes as usize,
            hexes,
            shell_triangles,
            shell_thicknesses,
        },
        values,
        groups,
        group_count as usize,
        quantile,
    )
    .map_err(|error| to_js(&error))?;
    Ok(statistics
        .iter()
        .flat_map(|group| [group.max, group.quantile])
        .collect())
}

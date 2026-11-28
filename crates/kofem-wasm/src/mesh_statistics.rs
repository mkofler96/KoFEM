// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser binding for what the Mesh step lists per body
//! (`kofem_fem::mesh_statistics`): mean element edge length, volume and mass.

use kofem_fem::{BodyMesh, BodyStatistics};
use wasm_bindgen::prelude::*;

use crate::to_js;

/// The numbers of each body with elements, in body id order; read one body
/// at a time by its index.
#[wasm_bindgen]
pub struct MeshBodyStatistics {
    bodies: Vec<BodyStatistics>,
}

#[wasm_bindgen]
impl MeshBodyStatistics {
    /// How many bodies have elements.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn count(&self) -> usize {
        self.bodies.len()
    }

    /// The id of the body at `index`.
    #[must_use]
    pub fn body(&self, index: usize) -> u32 {
        self.bodies[index].body
    }

    /// The number of elements of the body at `index`.
    #[must_use]
    pub fn elements(&self, index: usize) -> usize {
        self.bodies[index].elements
    }

    /// The mean length of the body's distinct element edges.
    #[wasm_bindgen(js_name = meanEdgeLength)]
    #[must_use]
    pub fn mean_edge_length(&self, index: usize) -> f64 {
        self.bodies[index].mean_edge_length
    }

    /// The body's volume.
    #[must_use]
    pub fn volume(&self, index: usize) -> f64 {
        self.bodies[index].volume
    }

    /// The body's mass; undefined when it has no density.
    #[must_use]
    pub fn mass(&self, index: usize) -> Option<f64> {
        self.bodies[index].mass
    }
}

/// The statistics of every body of the mesh: `tets` with `tet_nodes` (4 or
/// 10) nodes each, `hexes` with `hex_nodes` (8 or 27), `shell_triangles` three
/// per facet with one thickness each, and `bodies` one id per element in that
/// order. `density_bodies[i]` has the density `densities[i]`; a body left out
/// has no mass.
///
/// # Errors
/// The checks of [`kofem_fem::body_statistics`], or density arrays of
/// different lengths.
#[wasm_bindgen(js_name = meshBodyStatistics)]
#[expect(
    clippy::too_many_arguments,
    reason = "a flat wasm-bindgen signature: typed arrays in, one call per mesh"
)]
pub fn mesh_body_statistics(
    points: &[f64],
    tets: &[u32],
    tet_nodes: u32,
    hexes: &[u32],
    hex_nodes: u32,
    shell_triangles: &[u32],
    shell_thicknesses: &[f64],
    bodies: &[u32],
    density_bodies: &[u32],
    densities: &[f64],
) -> Result<MeshBodyStatistics, JsError> {
    if density_bodies.len() != densities.len() {
        return Err(JsError::new(&format!(
            "mesh statistics: {} density bodies but {} densities",
            density_bodies.len(),
            densities.len()
        )));
    }
    let pairs: Vec<(u32, f64)> = density_bodies
        .iter()
        .copied()
        .zip(densities.iter().copied())
        .collect();
    let mesh = BodyMesh {
        points,
        tets,
        tet_nodes: tet_nodes as usize,
        hexes,
        hex_nodes: hex_nodes as usize,
        shell_triangles,
        shell_thicknesses,
        bodies,
    };
    kofem_fem::body_statistics(&mesh, &pairs)
        .map(|bodies| MeshBodyStatistics { bodies })
        .map_err(|error| to_js(&error))
}

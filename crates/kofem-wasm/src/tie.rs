// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser bindings for constraint ties (`kofem_fem::tie`) and their dual
//! mortar weights (`kofem_fem::mortar`).

use kofem_fem::{mortar_weights, MortarFace, MortarRow};
use wasm_bindgen::prelude::*;

use crate::to_js;

/// Constraint ties for `ElasticModel.startTiedSolve`, in CSR form: vertex
/// `slaves[k]` follows Σ `weights[i]` · u(`masters[i]`) over
/// i ∈ [`offsets[k]`, `offsets[k + 1]`), as part of interface
/// `interfaces[k]` (its tie connection: on quadratic elements a tie extends
/// over the edges and faces of one interface only). Checked against the mesh
/// when the solve starts.
#[wasm_bindgen]
pub struct Ties {
    pub(crate) slaves: Vec<u32>,
    pub(crate) offsets: Vec<u32>,
    pub(crate) masters: Vec<u32>,
    pub(crate) weights: Vec<f64>,
    pub(crate) interfaces: Vec<u32>,
}

#[wasm_bindgen]
impl Ties {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(
        slaves: &[u32],
        offsets: &[u32],
        masters: &[u32],
        weights: &[f64],
        interfaces: &[u32],
    ) -> Ties {
        Ties {
            slaves: slaves.to_vec(),
            offsets: offsets.to_vec(),
            masters: masters.to_vec(),
            weights: weights.to_vec(),
            interfaces: interfaces.to_vec(),
        }
    }

    /// Tied vertices.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn count(&self) -> usize {
        self.slaves.len()
    }
}

/// The element faces of one side of a tie, for `tieMortarWeights`: face k
/// has the `sizes[k]` (3 or 4) nodes that follow in `nodes`, in cyclic
/// order, as indices into `points` (x,y,z per node); `centroids` holds the
/// centroid of the element each face bounds (x,y,z per face), which orients
/// its normal outwards.
#[wasm_bindgen]
pub struct MortarSurface {
    faces: Vec<MortarFace>,
}

#[wasm_bindgen]
impl MortarSurface {
    /// # Errors
    /// Arrays that disagree in length, a face that is not a triangle or a
    /// quadrilateral, or a node index outside `points`.
    #[wasm_bindgen(constructor)]
    pub fn new(
        points: &[f64],
        sizes: &[u32],
        nodes: &[u32],
        centroids: &[f64],
    ) -> Result<MortarSurface, JsError> {
        if !points.len().is_multiple_of(3) {
            return Err(JsError::new(&format!(
                "mortar surface: {} point coordinates are not x,y,z triples",
                points.len()
            )));
        }
        if centroids.len() != 3 * sizes.len() {
            return Err(JsError::new(&format!(
                "mortar surface: {} centroid coordinates for {} faces",
                centroids.len(),
                sizes.len()
            )));
        }
        let total: usize = sizes.iter().map(|&size| size as usize).sum();
        if total != nodes.len() {
            return Err(JsError::new(&format!(
                "mortar surface: the face sizes add up to {total}, but {} nodes are given",
                nodes.len()
            )));
        }
        let coordinates = points.as_chunks::<3>().0;
        let centres = centroids.as_chunks::<3>().0;
        let mut faces = Vec::with_capacity(sizes.len());
        let mut start = 0;
        for (index, &size) in sizes.iter().enumerate() {
            let size = size as usize;
            if !(size == 3 || size == 4) {
                return Err(JsError::new(&format!(
                    "mortar surface: face {index} has {size} nodes; a solid face has 3 or 4"
                )));
            }
            let face_nodes = &nodes[start..start + size];
            start += size;
            let mut face_points = Vec::with_capacity(size);
            for &node in face_nodes {
                let point = coordinates.get(node as usize).ok_or_else(|| {
                    JsError::new(&format!(
                        "mortar surface: face {index} names node {node}, but only {} points \
                         are given",
                        coordinates.len()
                    ))
                })?;
                face_points.push(*point);
            }
            faces.push(MortarFace {
                nodes: face_nodes.iter().map(|&node| node as usize).collect(),
                points: face_points,
                element_centroid: centres[index],
            });
        }
        Ok(MortarSurface { faces })
    }
}

/// Dual mortar weights of a tie, in CSR form like [`Ties`], with each tied
/// node's coverage (how much of its multiplier support the master surface
/// covers; nodes covered less than half are not tied).
#[wasm_bindgen]
pub struct MortarTies {
    rows: Vec<MortarRow>,
}

#[wasm_bindgen]
impl MortarTies {
    /// The tied (slave) nodes, sorted.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn slaves(&self) -> Vec<u32> {
        self.rows.iter().map(|row| to_u32(row.slave)).collect()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn offsets(&self) -> Vec<u32> {
        let mut offsets = Vec::with_capacity(self.rows.len() + 1);
        let mut end = 0;
        offsets.push(0);
        for row in &self.rows {
            end += row.masters.len();
            offsets.push(to_u32(end));
        }
        offsets
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn masters(&self) -> Vec<u32> {
        self.rows
            .iter()
            .flat_map(|row| row.masters.iter().map(|&master| to_u32(master)))
            .collect()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn weights(&self) -> Vec<f64> {
        self.rows
            .iter()
            .flat_map(|row| row.weights.iter().copied())
            .collect()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn coverage(&self) -> Vec<f64> {
        self.rows.iter().map(|row| row.coverage).collect()
    }
}

/// The dual mortar weights of the `slave` surface's nodes over the `master`
/// surface (node indices as the surfaces give them), counting only master
/// faces within `limit` (`Infinity` for the whole surface).
///
/// # Errors
/// A negative limit, or a degenerate face on either surface.
#[wasm_bindgen(js_name = tieMortarWeights)]
pub fn tie_mortar_weights(
    slave: &MortarSurface,
    master: &MortarSurface,
    limit: f64,
) -> Result<MortarTies, JsError> {
    let rows = mortar_weights(&slave.faces, &master.faces, limit).map_err(|error| to_js(&error))?;
    Ok(MortarTies { rows })
}

fn to_u32(index: usize) -> u32 {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "node indices come from u32 arrays"
    )]
    let narrow = index as u32;
    narrow
}

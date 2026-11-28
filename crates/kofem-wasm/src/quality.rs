// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser bindings for the shape quality of linear tetrahedra
//! (`kofem_fem::tet_quality`, KOF-456).

use wasm_bindgen::prelude::*;

use crate::to_js;

/// Each tetrahedron's smallest dihedral angle and aspect ratio, in element order.
#[wasm_bindgen]
pub struct TetMeshQuality {
    min_dihedral_deg: Vec<f64>,
    aspect_ratio: Vec<f64>,
}

#[wasm_bindgen]
impl TetMeshQuality {
    /// The smallest angle between two faces, in degrees (70.53° when regular).
    #[wasm_bindgen(getter, js_name = minDihedralDeg)]
    #[must_use]
    pub fn min_dihedral_deg(&self) -> Vec<f64> {
        self.min_dihedral_deg.clone()
    }

    /// Longest edge / (2√6 · inradius): 1 when regular, larger when worse.
    #[wasm_bindgen(getter, js_name = aspectRatio)]
    #[must_use]
    pub fn aspect_ratio(&self) -> Vec<f64> {
        self.aspect_ratio.clone()
    }
}

/// The quality of each tetrahedron in `tets` (4 vertex indices each) over
/// `points` (x, y, z per vertex).
///
/// # Errors
/// A ragged array, an index past the vertices, or a flat tetrahedron.
#[wasm_bindgen(js_name = tetQuality)]
pub fn tet_quality(points: &[f64], tets: &[u32]) -> Result<TetMeshQuality, JsError> {
    let quality = kofem_fem::tet_quality(points, tets).map_err(|error| to_js(&error))?;
    Ok(TetMeshQuality {
        min_dihedral_deg: quality.iter().map(|tet| tet.min_dihedral_deg).collect(),
        aspect_ratio: quality.iter().map(|tet| tet.aspect_ratio).collect(),
    })
}

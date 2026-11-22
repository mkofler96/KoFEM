// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser bindings for what the viewport draws of a FEM mesh
//! (`kofem_fem::mesh_outline`, KOF-457).

use wasm_bindgen::prelude::*;

use crate::to_js;

/// The outer faces of a mesh: the faces exactly one element uses.
#[wasm_bindgen]
pub struct MeshOuterFaces {
    faces: kofem_fem::OuterFaces,
}

#[wasm_bindgen]
impl MeshOuterFaces {
    /// Three corners per tetrahedron face.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn triangles(&self) -> Vec<u32> {
        self.faces.triangles.clone()
    }

    /// Four corners per hexahedron face, around it.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn quadrilaterals(&self) -> Vec<u32> {
        self.faces.quadrilaterals.clone()
    }
}

/// The outer faces of a mesh of tetrahedra (`tets`, 4 corners each) and
/// hexahedra (`hexes`, 8 each, CHEXA order), in the order the elements first
/// meet them.
///
/// # Errors
/// An array that is not whole elements.
#[wasm_bindgen(js_name = outerFaces)]
pub fn outer_faces(tets: &[u32], hexes: &[u32]) -> Result<MeshOuterFaces, JsError> {
    kofem_fem::outer_faces(tets, hexes)
        .map(|faces| MeshOuterFaces { faces })
        .map_err(|error| to_js(&error))
}

/// Every edge of the tetrahedra (4 corners each), hexahedra (8), triangles
/// (3) and quadrilaterals (4) once, as corner pairs in first-met order.
///
/// # Errors
/// An array that is not whole elements.
#[wasm_bindgen(js_name = uniqueEdges)]
pub fn unique_edges(
    tets: &[u32],
    hexes: &[u32],
    triangles: &[u32],
    quadrilaterals: &[u32],
) -> Result<Vec<u32>, JsError> {
    kofem_fem::unique_edges(tets, hexes, triangles, quadrilaterals).map_err(|error| to_js(&error))
}

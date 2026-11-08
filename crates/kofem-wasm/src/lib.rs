// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser bindings for `kofem-fem`. Arrays cross as typed arrays (copied into
//! WASM memory once); every failure reaches JS as an `Error` carrying the
//! `FemError` message. Assembly and solve are separate calls so the caller can
//! time them and keep the assembled matrix for several load cases.
//!
//! Numerical implementation based on KoFEM's MFEM solver approach; upstream
//! credit and BSD-3-Clause terms are retained in `../kofem-fem/NOTICE.md` and
//! `../kofem-fem/LICENSE-MFEM`, also shipped beside the generated WASM module.

use kofem_fem::{
    assemble_stiffness, solve_static, CgSettings, CsrMatrix, FemError, Isotropic, TetMesh,
};
use wasm_bindgen::prelude::*;

fn to_js(error: &FemError) -> JsError {
    JsError::new(&error.to_string())
}

/// A validated linear-elastic tetrahedral model.
#[wasm_bindgen]
pub struct ElasticModel {
    mesh: TetMesh,
    stiffness: Option<CsrMatrix>,
}

#[wasm_bindgen]
impl ElasticModel {
    /// `vertices`: x,y,z per vertex. `tets`: four vertex indices per element.
    /// `material_of_tet`: index into `materials`, which holds (E, ν) pairs.
    ///
    /// # Errors
    /// The first malformed array, index, element or material.
    #[wasm_bindgen(constructor)]
    pub fn new(
        vertices: &[f64],
        tets: &[u32],
        material_of_tet: &[u32],
        materials: &[f64],
    ) -> Result<ElasticModel, JsError> {
        if !materials.len().is_multiple_of(2) {
            return Err(JsError::new(&format!(
                "materials has {} values; expected (E, ν) pairs",
                materials.len()
            )));
        }
        let parsed = materials
            .as_chunks::<2>()
            .0
            .iter()
            .enumerate()
            .map(|(index, pair)| Isotropic::new(index, pair[0], pair[1]))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| to_js(&error))?;
        let mesh =
            TetMesh::new(vertices, tets, material_of_tet, parsed).map_err(|error| to_js(&error))?;
        Ok(ElasticModel {
            mesh,
            stiffness: None,
        })
    }

    #[wasm_bindgen(getter, js_name = dofCount)]
    #[must_use]
    pub fn dof_count(&self) -> usize {
        3 * self.mesh.vertex_count()
    }

    /// Assemble the global stiffness matrix; returns its non-zero count.
    pub fn assemble(&mut self) -> usize {
        let matrix = assemble_stiffness(&self.mesh);
        let nnz = matrix.nnz();
        self.stiffness = Some(matrix);
        nnz
    }

    /// Solve K·u = f with the given DOFs (3·vertex + component) prescribed.
    ///
    /// # Errors
    /// Missing assembly, malformed constraints or forces, or a solve that
    /// breaks down or does not converge.
    pub fn solve(
        &self,
        fixed_dofs: &[u32],
        fixed_values: &[f64],
        forces: &[f64],
        relative_tolerance: f64,
        max_iterations: usize,
    ) -> Result<ElasticSolution, JsError> {
        let assembled = self
            .stiffness
            .as_ref()
            .ok_or_else(|| JsError::new("assemble() must be called before solve()"))?;
        let settings = CgSettings {
            relative_tolerance,
            max_iterations,
        };
        let solution = solve_static(
            &self.mesh,
            assembled,
            fixed_dofs,
            fixed_values,
            forces,
            settings,
        )
        .map_err(|error| to_js(&error))?;
        Ok(ElasticSolution {
            displacements: solution.displacements,
            iterations: solution.iterations,
            relative_residual: solution.relative_residual,
            unused_vertices: solution.unused_vertices,
        })
    }
}

#[wasm_bindgen]
pub struct ElasticSolution {
    displacements: Vec<f64>,
    iterations: usize,
    relative_residual: f64,
    unused_vertices: usize,
}

#[wasm_bindgen]
impl ElasticSolution {
    /// Displacement per vertex, x,y,z interleaved (copied out as a `Float64Array`).
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn displacements(&self) -> Vec<f64> {
        self.displacements.clone()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn iterations(&self) -> usize {
        self.iterations
    }

    /// Vertices no element uses: held at zero displacement, never loaded.
    #[wasm_bindgen(getter, js_name = unusedVertices)]
    #[must_use]
    pub fn unused_vertices(&self) -> usize {
        self.unused_vertices
    }

    #[wasm_bindgen(getter, js_name = relativeResidual)]
    #[must_use]
    pub fn relative_residual(&self) -> f64 {
        self.relative_residual
    }
}

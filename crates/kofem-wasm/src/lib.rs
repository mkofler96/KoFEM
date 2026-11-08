// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser bindings for `kofem-fem`. Arrays cross as typed arrays (copied into
//! WASM memory once); every failure reaches JS as an `Error` carrying the
//! `FemError` message. Assembly and solve are separate calls so the caller can
//! time them and keep the assembled matrix for several load cases.

use kofem_fem::{
    apply_dirichlet, assemble_stiffness, solve_pcg, CgSettings, CsrMatrix, Dirichlet, FemError,
    Isotropic, TetMesh,
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
            .chunks_exact(2)
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
        let dof_count = self.dof_count();
        if forces.len() != dof_count {
            return Err(to_js(&FemError::ForceLength {
                len: forces.len(),
                count: dof_count,
            }));
        }
        if let Some(&value) = forces.iter().find(|value| !value.is_finite()) {
            return Err(to_js(&FemError::NonFinite {
                what: "a force component",
                value,
            }));
        }
        let constraints =
            Dirichlet::new(dof_count, fixed_dofs, fixed_values).map_err(|error| to_js(&error))?;
        // Elimination edits the matrix, so solve on a copy: the assembled
        // stiffness stays reusable for further load cases.
        let mut matrix = assembled.clone();
        let mut rhs = forces.to_vec();
        apply_dirichlet(&mut matrix, &mut rhs, &constraints);
        let settings = CgSettings {
            relative_tolerance,
            max_iterations,
        };
        let (displacements, outcome) =
            solve_pcg(&matrix, &rhs, settings).map_err(|error| to_js(&error))?;
        Ok(ElasticSolution {
            displacements,
            iterations: outcome.iterations,
            relative_residual: outcome.relative_residual,
        })
    }
}

#[wasm_bindgen]
pub struct ElasticSolution {
    displacements: Vec<f64>,
    iterations: usize,
    relative_residual: f64,
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

    #[wasm_bindgen(getter, js_name = relativeResidual)]
    #[must_use]
    pub fn relative_residual(&self) -> f64 {
        self.relative_residual
    }
}

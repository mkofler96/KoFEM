// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser bindings for the Kirchhoff shell solve (`kofem_fem::shell`).

use kofem_fem::shell::SHELL_NODE_DOFS;
use kofem_fem::{
    assemble_shell_stiffness, prepare_shell_static, shell_translations, shell_von_mises, CsrMatrix,
    PcgRun, ShellMesh, ShellPreconditioner, StoppingRule,
};
use wasm_bindgen::prelude::*;

use crate::{parse_materials, to_js, RunOutput, SolveRun};

/// A validated Kirchhoff shell model (CST membrane + DKT bending facets).
#[wasm_bindgen]
pub struct ShellModel {
    mesh: ShellMesh,
    stiffness: Option<CsrMatrix>,
}

#[wasm_bindgen]
impl ShellModel {
    /// `vertices`: x,y,z per vertex. `triangles`: three vertex indices per
    /// facet. `thicknesses`: one per facet. `material_of_triangle`: index into
    /// `materials`, which holds (E, ν) pairs.
    ///
    /// # Errors
    /// The first malformed array, index, facet, thickness or material.
    #[wasm_bindgen(constructor)]
    pub fn new(
        vertices: &[f64],
        triangles: &[u32],
        thicknesses: &[f64],
        material_of_triangle: &[u32],
        materials: &[f64],
    ) -> Result<ShellModel, JsError> {
        let mesh = ShellMesh::new(
            vertices,
            triangles,
            thicknesses,
            material_of_triangle,
            parse_materials(materials)?,
        )
        .map_err(|error| to_js(&error))?;
        Ok(ShellModel {
            mesh,
            stiffness: None,
        })
    }

    /// Six DOFs per vertex: u, v, w, θx, θy, θz.
    #[wasm_bindgen(getter, js_name = dofCount)]
    #[must_use]
    pub fn dof_count(&self) -> usize {
        SHELL_NODE_DOFS * self.mesh.vertex_count()
    }

    /// Assemble the global stiffness matrix; returns its non-zero count.
    pub fn assemble(&mut self) -> usize {
        let matrix = assemble_shell_stiffness(&self.mesh);
        let nnz = matrix.nnz();
        self.stiffness = Some(matrix);
        nnz
    }

    /// Set up K·u = f with the given DOFs (6·vertex + component, component
    /// 0..5 = u, v, w, θx, θy, θz) prescribed, as a run the caller advances in
    /// steps. `forces` holds forces and moments, 6 per vertex. The run stops
    /// on the force residual ‖f − K·u‖/‖f‖ ≤ `relative_tolerance`, the C++
    /// shell solve's rule.
    ///
    /// # Errors
    /// Missing assembly, malformed constraints or forces, a DOF constrained to
    /// two values, a support or load on a vertex no facet uses, or an invalid
    /// tolerance.
    #[wasm_bindgen(js_name = startSolve)]
    pub fn start_solve(
        &self,
        fixed_dofs: &[u32],
        fixed_values: &[f64],
        forces: &[f64],
        relative_tolerance: f64,
    ) -> Result<SolveRun, JsError> {
        let assembled = self
            .stiffness
            .as_ref()
            .ok_or_else(|| JsError::new("assemble() must be called before startSolve()"))?;
        let mut shell =
            prepare_shell_static(&self.mesh, assembled, fixed_dofs, fixed_values, forces)
                .map_err(|error| to_js(&error))?;
        let run = PcgRun::start(
            shell.prepared.system.as_mut(),
            &shell.prepared.rhs,
            relative_tolerance,
            StoppingRule::ResidualNorm,
        )
        .map_err(|error| to_js(&error))?;
        let preconditioner = match shell.preconditioner {
            ShellPreconditioner::IncompleteCholesky { shift: 0.0 } => {
                "incomplete Cholesky IC(0)".to_owned()
            }
            ShellPreconditioner::IncompleteCholesky { shift } => {
                format!("incomplete Cholesky IC(0), diagonal shift {shift}")
            }
            ShellPreconditioner::SymmetricGaussSeidel => {
                "symmetric Gauss–Seidel (IC(0) factorisation broke down)".to_owned()
            }
        };
        Ok(SolveRun {
            prepared: shell.prepared,
            run,
            preconditioner,
            reduction: None,
            output: RunOutput::Translations,
            tie_report: None,
        })
    }

    /// Von Mises stress of every facet for a solution (6 DOFs per vertex): the
    /// worse of the two surfaces z = ±t/2.
    ///
    /// # Errors
    /// A solution array that does not fit the mesh.
    #[wasm_bindgen(js_name = vonMises)]
    pub fn von_mises(&self, dofs: &[f64]) -> Result<Vec<f64>, JsError> {
        shell_von_mises(&self.mesh, dofs).map_err(|error| to_js(&error))
    }

    /// The three translations per vertex of a solution (6 DOFs per vertex),
    /// the layout the solid solve returns.
    ///
    /// # Errors
    /// A solution array that does not fit the mesh.
    pub fn translations(&self, dofs: &[f64]) -> Result<Vec<f64>, JsError> {
        shell_translations(&self.mesh, dofs).map_err(|error| to_js(&error))
    }
}

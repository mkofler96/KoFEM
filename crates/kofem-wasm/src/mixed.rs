// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser bindings for the mixed solid + shell solve
//! (`kofem_fem::prepare_mixed_static`): linear tets and Kirchhoff shell facets
//! over one node pool, joined by couplings — the engine's `solve_coupled`.

use kofem_fem::shell::SHELL_NODE_DOFS;
use kofem_fem::{
    assemble_shell_stiffness, assemble_stiffness, prepare_mixed_static, shell_von_mises, von_mises,
    AmgSettings, AppliedPreconditioner, CsrMatrix, MixedPreconditioner, PcgRun,
    PreconditionerChoice, PreparedMixed, ShellMesh, ShellPart, StoppingRule, TetMesh,
};
use wasm_bindgen::prelude::*;

use crate::{parse_materials, to_js, Couplings, RunOutput, SolveRun};

/// A validated mixed model: linear tets and, when there are any, Kirchhoff
/// shell facets (CST membrane + DKT bending) over the same vertices.
#[wasm_bindgen]
pub struct MixedModel {
    solid: TetMesh,
    shell: Option<ShellMesh>,
    solid_stiffness: Option<CsrMatrix>,
    shell_stiffness: Option<CsrMatrix>,
}

#[wasm_bindgen]
impl MixedModel {
    /// `vertices`: x,y,z per vertex, shared by both domains. `tets`: four
    /// vertex indices per linear tet, `material_of_tet` an index into
    /// `solid_materials` ((E, ν) pairs). `triangles`: three vertex indices
    /// per shell facet (may be empty), with one thickness and one index into
    /// `shell_materials` each.
    ///
    /// # Errors
    /// The first malformed array, index, element, thickness or material.
    #[wasm_bindgen(constructor)]
    #[allow(
        clippy::too_many_arguments,
        reason = "the two domains' arrays, as the engine's solve_coupled takes them"
    )]
    pub fn new(
        vertices: &[f64],
        tets: &[u32],
        material_of_tet: &[u32],
        solid_materials: &[f64],
        triangles: &[u32],
        thicknesses: &[f64],
        material_of_triangle: &[u32],
        shell_materials: &[f64],
    ) -> Result<MixedModel, JsError> {
        let solid = TetMesh::new(
            vertices,
            tets,
            material_of_tet,
            parse_materials(solid_materials)?,
        )
        .map_err(|error| to_js(&error))?;
        let shell = if triangles.is_empty() {
            if !thicknesses.is_empty() || !material_of_triangle.is_empty() {
                return Err(JsError::new(&format!(
                    "{} thicknesses and {} shell material ids given, but no shell triangles",
                    thicknesses.len(),
                    material_of_triangle.len()
                )));
            }
            None
        } else {
            Some(
                ShellMesh::new(
                    vertices,
                    triangles,
                    thicknesses,
                    material_of_triangle,
                    parse_materials(shell_materials)?,
                )
                .map_err(|error| to_js(&error))?,
            )
        };
        Ok(MixedModel {
            solid,
            shell,
            solid_stiffness: None,
            shell_stiffness: None,
        })
    }

    /// Six DOFs per vertex: u, v, w, θx, θy, θz.
    #[wasm_bindgen(getter, js_name = dofCount)]
    #[must_use]
    pub fn dof_count(&self) -> usize {
        SHELL_NODE_DOFS * self.solid.vertex_count()
    }

    #[wasm_bindgen(getter, js_name = vertexCount)]
    #[must_use]
    pub fn vertex_count(&self) -> usize {
        self.solid.vertex_count()
    }

    /// Assemble the solid and shell stiffness matrices; returns their total
    /// non-zero count.
    pub fn assemble(&mut self) -> usize {
        let solid = assemble_stiffness(&self.solid);
        let shell = self.shell.as_ref().map(assemble_shell_stiffness);
        let nnz = solid.nnz() + shell.as_ref().map_or(0, CsrMatrix::nnz);
        self.solid_stiffness = Some(solid);
        self.shell_stiffness = shell;
        nnz
    }

    /// Set up one load case as a run the caller advances in steps. DOFs are
    /// 6·vertex + component; `forces` holds forces and moments, 6 per
    /// vertex. A rotation is fixed, prescribed or loaded on a shell node or
    /// coupling reference point only. `preconditioner`: `"amg"`
    /// (smoothed-aggregation multigrid), `"incomplete-cholesky"` (IC(0), the
    /// engine's choice, with symmetric Gauss–Seidel if it cannot factor) or
    /// `"gauss-seidel"`. The run stops on ‖f − K·u‖/‖f‖ ≤
    /// `relative_tolerance`; its solution has all six DOFs per vertex.
    ///
    /// # Errors
    /// Missing assembly, an unknown preconditioner, malformed couplings,
    /// constraints or forces, a condition the couplings make impossible, or a
    /// multigrid setup that finds the model under-constrained.
    #[wasm_bindgen(js_name = startSolve)]
    pub fn start_solve(
        &self,
        couplings: &Couplings,
        fixed_dofs: &[u32],
        fixed_values: &[f64],
        forces: &[f64],
        relative_tolerance: f64,
        preconditioner: &str,
    ) -> Result<SolveRun, JsError> {
        let solid_stiffness = self
            .solid_stiffness
            .as_ref()
            .ok_or_else(|| JsError::new("assemble() must be called before startSolve()"))?;
        let choice = match preconditioner {
            "amg" => MixedPreconditioner::Choice(PreconditionerChoice::SmoothedAggregation(
                AmgSettings::default(),
            )),
            "gauss-seidel" => {
                MixedPreconditioner::Choice(PreconditionerChoice::SymmetricGaussSeidel)
            }
            "incomplete-cholesky" => MixedPreconditioner::IncompleteCholesky,
            other => {
                return Err(JsError::new(&format!(
                    "unknown preconditioner \"{other}\"; expected \"amg\", \
                     \"incomplete-cholesky\" or \"gauss-seidel\""
                )))
            }
        };
        let shell = match (&self.shell, &self.shell_stiffness) {
            (Some(mesh), Some(stiffness)) => Some(ShellPart { mesh, stiffness }),
            (None, _) => None,
            (Some(_), None) => {
                return Err(JsError::new(
                    "assemble() must be called before startSolve()",
                ))
            }
        };
        let PreparedMixed {
            mut prepared,
            reduction,
            preconditioner: applied,
        } = prepare_mixed_static(
            &self.solid,
            solid_stiffness,
            shell,
            &couplings.couplings,
            fixed_dofs,
            fixed_values,
            forces,
            choice,
        )
        .map_err(|error| to_js(&error))?;
        let run = PcgRun::start(
            prepared.system.as_mut(),
            &prepared.rhs,
            relative_tolerance,
            StoppingRule::ResidualNorm,
        )
        .map_err(|error| to_js(&error))?;
        let preconditioner = match applied {
            AppliedPreconditioner::SymmetricGaussSeidel => "symmetric Gauss–Seidel".to_owned(),
            AppliedPreconditioner::SmoothedAggregation => "smoothed-aggregation AMG".to_owned(),
            AppliedPreconditioner::IncompleteCholesky { shift: 0.0 } => {
                "incomplete Cholesky IC(0)".to_owned()
            }
            AppliedPreconditioner::IncompleteCholesky { shift } => {
                format!("incomplete Cholesky IC(0), diagonal shift {shift}")
            }
            AppliedPreconditioner::GaussSeidelAfterIncompleteCholesky => {
                "symmetric Gauss–Seidel (IC(0) factorisation broke down)".to_owned()
            }
        };
        Ok(SolveRun {
            prepared,
            run,
            preconditioner,
            reduction: Some(reduction),
            output: RunOutput::AllDofs,
            tie_report: None,
        })
    }

    /// The three translations per vertex of a solution (6 DOFs per vertex).
    ///
    /// # Errors
    /// A solution array that does not fit the model.
    pub fn translations(&self, dofs: &[f64]) -> Result<Vec<f64>, JsError> {
        self.check_dofs(dofs)?;
        Ok(dofs
            .as_chunks::<SHELL_NODE_DOFS>()
            .0
            .iter()
            .flat_map(|node| [node[0], node[1], node[2]])
            .collect())
    }

    /// Von Mises stress of every tet, at its centre, for a solution (6 DOFs
    /// per vertex).
    ///
    /// # Errors
    /// A solution array that does not fit the model.
    #[wasm_bindgen(js_name = vonMisesTets)]
    pub fn von_mises_tets(&self, dofs: &[f64]) -> Result<Vec<f64>, JsError> {
        let translations = self.translations(dofs)?;
        von_mises(&self.solid, &translations).map_err(|error| to_js(&error))
    }

    /// Von Mises stress of every shell facet for a solution (6 DOFs per
    /// vertex): the worse of the two surfaces z = ±t/2. Empty without shell
    /// facets.
    ///
    /// # Errors
    /// A solution array that does not fit the model.
    #[wasm_bindgen(js_name = vonMisesTris)]
    pub fn von_mises_tris(&self, dofs: &[f64]) -> Result<Vec<f64>, JsError> {
        self.check_dofs(dofs)?;
        match &self.shell {
            None => Ok(Vec::new()),
            Some(mesh) => shell_von_mises(mesh, dofs).map_err(|error| to_js(&error)),
        }
    }

    fn check_dofs(&self, dofs: &[f64]) -> Result<(), JsError> {
        let count = self.dof_count();
        if dofs.len() == count {
            return Ok(());
        }
        Err(JsError::new(&format!(
            "the solution has {} values, but the model has {count} DOFs (6 per vertex)",
            dofs.len()
        )))
    }
}

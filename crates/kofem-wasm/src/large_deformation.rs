// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser bindings for large deformation (`kofem_fem::hyperelastic`): the
//! Neo-Hookean solve as a run the worker advances in steps, one Newton
//! iteration at a time, and the Cauchy stress of its solution.

use kofem_fem::hyperelastic::{cauchy_corner_stress_tensors, cauchy_von_mises, NeoHookean};
use kofem_fem::nonlinear::{DirichletCg, NewtonRun, NewtonSettings, NewtonStatus};
use wasm_bindgen::prelude::*;

use crate::{preconditioner_name, to_js, ElasticModel, ElasticSolution, SolveOptions};

#[wasm_bindgen]
impl ElasticModel {
    /// Solve with large deformation: the elements' materials as compressible
    /// Neo-Hookean solids with the same E and ν, the loads and prescribed
    /// displacements applied over `increments` equal load increments, each
    /// solved by Newton's method within `max_iterations` iterations.
    /// Constraints and forces as for `startSolve`, 3 per node; the forces
    /// keep their direction (dead loads). Each correction solve stops at the
    /// options' tolerance and fails after their iteration budget; the
    /// out-of-balance force is held to the same tolerance. Needs no assembly.
    ///
    /// # Errors
    /// Malformed constraints or forces, or a zero increment count or
    /// iteration limit.
    #[wasm_bindgen(js_name = startLargeDeformationSolve)]
    pub fn start_large_deformation_solve(
        &self,
        fixed_dofs: &[u32],
        fixed_values: &[f64],
        forces: &[f64],
        options: &SolveOptions,
        increments: u32,
        max_iterations: usize,
    ) -> Result<LargeDeformationRun, JsError> {
        let run = NewtonRun::start(
            NeoHookean::new(&self.mesh),
            DirichletCg::new(&self.mesh, options.settings, options.preconditioner),
            &self.mesh,
            fixed_dofs,
            fixed_values,
            forces,
            NewtonSettings {
                increments,
                max_iterations,
                tolerance: options.settings.relative_tolerance,
            },
        )
        .map_err(|error| to_js(&error))?;
        Ok(LargeDeformationRun {
            run,
            status: NewtonStatus::Solving {
                increment: 1,
                iteration: 1,
                cg_iterations: 0,
            },
            increments,
            preconditioner: preconditioner_name(options.preconditioner).to_owned(),
        })
    }

    /// The Cauchy stress of every element at each of its corner vertices,
    /// laid out as `stressTensors`, for a large-deformation solution.
    ///
    /// # Errors
    /// A displacement array that does not fit the mesh, or one that turns an
    /// element inside out.
    #[wasm_bindgen(js_name = cauchyStressTensors)]
    pub fn cauchy_stress_tensors(&self, displacements: &[f64]) -> Result<Vec<f64>, JsError> {
        cauchy_corner_stress_tensors(&self.mesh, displacements)
            .map(|tensors| tensors.into_iter().flatten().collect())
            .map_err(|error| to_js(&error))
    }

    /// Von Mises stress of the Cauchy stress of every element at its centre,
    /// as `vonMises` gives the linear one.
    ///
    /// # Errors
    /// As `cauchyStressTensors`.
    #[wasm_bindgen(js_name = cauchyVonMises)]
    pub fn cauchy_von_mises(&self, displacements: &[f64]) -> Result<Vec<f64>, JsError> {
        cauchy_von_mises(&self.mesh, displacements).map_err(|error| to_js(&error))
    }
}

/// A large-deformation solve in progress (from
/// `ElasticModel.startLargeDeformationSolve`).
#[wasm_bindgen]
pub struct LargeDeformationRun {
    run: NewtonRun<NeoHookean, DirichletCg>,
    status: NewtonStatus,
    increments: u32,
    preconditioner: String,
}

#[wasm_bindgen]
impl LargeDeformationRun {
    /// Spend at most `budget` more CG iterations; returns after each Newton
    /// iteration, when the budget runs out, or once the last increment has
    /// converged. Returns whether it has.
    ///
    /// # Errors
    /// A correction solve that fails, an increment that does not converge
    /// within the iteration limit, an element turned inside out, or a
    /// tangent that is no longer positive definite (the model buckles).
    pub fn advance(&mut self, budget: usize) -> Result<bool, JsError> {
        self.status = self.run.advance(budget).map_err(|error| to_js(&error))?;
        Ok(self.status == NewtonStatus::Converged)
    }

    /// The load increment being solved, from 1.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn increment(&self) -> u32 {
        match self.status {
            NewtonStatus::Solving { increment, .. }
            | NewtonStatus::Iterated { increment, .. }
            | NewtonStatus::Checking { increment, .. } => increment,
            NewtonStatus::Converged => self.increments,
        }
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn increments(&self) -> u32 {
        self.increments
    }

    /// Newton iterations of the current increment finished so far.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn iteration(&self) -> usize {
        match self.status {
            NewtonStatus::Solving { iteration, .. } => iteration.saturating_sub(1),
            NewtonStatus::Iterated { iteration, .. } => iteration,
            NewtonStatus::Checking { .. } | NewtonStatus::Converged => 0,
        }
    }

    /// Whether the last `advance` returned after a finished Newton
    /// iteration, so `relativeResidual` belongs to it.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn iterated(&self) -> bool {
        matches!(self.status, NewtonStatus::Iterated { .. })
    }

    /// The out-of-balance force after the last iteration, relative to the
    /// load; NaN unless `iterated`.
    #[wasm_bindgen(getter, js_name = relativeResidual)]
    #[must_use]
    pub fn relative_residual(&self) -> f64 {
        match self.status {
            NewtonStatus::Iterated {
                relative_residual, ..
            } => relative_residual,
            _ => f64::NAN,
        }
    }

    /// The preconditioner, in words for the solve log.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn preconditioner(&self) -> String {
        self.preconditioner.clone()
    }

    /// The solution, once converged. Consumes the run.
    ///
    /// # Errors
    /// The run has not converged.
    pub fn finish(self) -> Result<LargeDeformationSolution, JsError> {
        let solution = self.run.into_solution().map_err(|error| to_js(&error))?;
        let iterations = solution
            .increments
            .iter()
            .map(|increment| increment.iterations)
            .sum();
        let cg_iterations = solution
            .increments
            .iter()
            .map(|increment| increment.cg_iterations)
            .sum();
        Ok(LargeDeformationSolution {
            elastic: ElasticSolution {
                full_dofs: solution.displacements.clone(),
                displacements: solution.displacements,
                iterations: cg_iterations,
                relative_residual: solution
                    .increments
                    .last()
                    .and_then(|increment| increment.residuals.last().copied())
                    .unwrap_or(0.0),
                unused_vertices: solution.unused_vertices,
                level_sizes: Vec::new(),
                reduction: None,
                internal_force: Some(solution.internal_force),
            },
            iterations,
        })
    }
}

/// A converged large-deformation solve.
#[wasm_bindgen]
pub struct LargeDeformationSolution {
    elastic: ElasticSolution,
    iterations: usize,
}

#[wasm_bindgen]
impl LargeDeformationSolution {
    /// The displacements as a solid solve's solution, for support reactions
    /// (from the internal force). Its `iterations` are the CG iterations of
    /// every correction and stability check; its `relativeResidual` the
    /// final out-of-balance force. Read stresses with `cauchyVonMises` and
    /// `cauchyStressTensors`.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn elastic(&self) -> ElasticSolution {
        self.elastic.clone()
    }

    /// Newton iterations over all increments.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn iterations(&self) -> usize {
        self.iterations
    }
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser bindings for frictionless contact (`kofem_fem::contact`): the
//! picked surface pairs, and the contact solve as a run the worker advances
//! in steps, one active-set iteration at a time.

use kofem_fem::contact::{ContactCg, ContactState};
use kofem_fem::nonlinear::{LinearElastic, NewtonRun, NewtonStatus};
use wasm_bindgen::prelude::*;

use crate::{to_js, ElasticSolution};

/// Contact pairs for `ElasticModel.startContactSolve`: each pair is two
/// picked surfaces, given by their vertices. The solve finds the boundary
/// faces of each and makes the finer side the slave.
#[wasm_bindgen]
pub struct ContactPairs {
    pub(crate) sides: Vec<(Vec<u32>, Vec<u32>)>,
}

#[wasm_bindgen]
impl ContactPairs {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> ContactPairs {
        ContactPairs { sides: Vec::new() }
    }

    /// Add the pair between the surfaces of the vertices `side_a` and
    /// `side_b`.
    pub fn add(&mut self, side_a: &[u32], side_b: &[u32]) {
        self.sides.push((side_a.to_vec(), side_b.to_vec()));
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn count(&self) -> usize {
        self.sides.len()
    }
}

impl Default for ContactPairs {
    fn default() -> Self {
        Self::new()
    }
}

/// A contact solve in progress (from `ElasticModel.startContactSolve`).
#[wasm_bindgen]
pub struct ContactRun {
    pub(crate) run: NewtonRun<LinearElastic, ContactCg>,
    pub(crate) status: NewtonStatus,
    pub(crate) preconditioner: String,
}

#[wasm_bindgen]
impl ContactRun {
    /// Spend at most `budget` more CG iterations; returns after each
    /// active-set iteration, when the budget runs out, or once converged.
    /// Returns whether the solve has converged.
    ///
    /// # Errors
    /// A correction solve that fails, or an active set that has not settled
    /// within the iteration limit.
    pub fn advance(&mut self, budget: usize) -> Result<bool, JsError> {
        self.status = self.run.advance(budget).map_err(|error| to_js(&error))?;
        Ok(self.status == NewtonStatus::Converged)
    }

    /// Active-set iterations finished so far.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn iteration(&self) -> usize {
        match self.status {
            NewtonStatus::Solving { iteration, .. } => iteration.saturating_sub(1),
            NewtonStatus::Iterated { iteration, .. } => iteration,
            NewtonStatus::Converged => 0,
        }
    }

    /// CG iterations spent on the correction being solved, while it is.
    #[wasm_bindgen(getter, js_name = cgIterations)]
    #[must_use]
    pub fn cg_iterations(&self) -> usize {
        match self.status {
            NewtonStatus::Solving { cg_iterations, .. } => cg_iterations,
            _ => 0,
        }
    }

    /// The out-of-balance force after the last iteration, relative to the
    /// load.
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

    /// Closed (touching) slave nodes in the current active set.
    #[wasm_bindgen(getter, js_name = closedNodes)]
    #[must_use]
    pub fn closed_nodes(&self) -> usize {
        self.run.solver().state().map_or(0, |state| {
            state.closed.iter().filter(|&&closed| closed).count()
        })
    }

    /// Slave nodes under a contact condition.
    #[wasm_bindgen(getter, js_name = slaveNodes)]
    #[must_use]
    pub fn slave_nodes(&self) -> usize {
        self.run
            .solver()
            .state()
            .map_or(0, |state| state.nodes.len())
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
    pub fn finish(self) -> Result<ContactSolution, JsError> {
        let state = self
            .run
            .solver()
            .state()
            .ok_or_else(|| JsError::new("contact: the solve has not started"))?;
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
        Ok(ContactSolution {
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
            },
            state,
            iterations,
        })
    }
}

/// A converged contact solve: the displacements, and the pressure and gap of
/// every slave node.
#[wasm_bindgen]
pub struct ContactSolution {
    elastic: ElasticSolution,
    state: ContactState,
    iterations: usize,
}

#[wasm_bindgen]
impl ContactSolution {
    /// The displacements as a solid solve's solution, for stresses and
    /// support reactions. Its `iterations` are the CG iterations of every
    /// correction; its `relativeResidual` the final out-of-balance force.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn elastic(&self) -> ElasticSolution {
        self.elastic.clone()
    }

    /// Active-set iterations until the set stopped changing.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn iterations(&self) -> usize {
        self.iterations
    }

    /// The slave vertices under a contact condition.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn nodes(&self) -> Vec<u32> {
        self.state
            .nodes
            .iter()
            .map(|&node| {
                #[allow(
                    clippy::cast_possible_truncation,
                    reason = "vertex indices come from u32 arrays"
                )]
                let narrow = node as u32;
                narrow
            })
            .collect()
    }

    /// Contact pressure per slave vertex (force per area, ≥ 0 pressing).
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn pressure(&self) -> Vec<f64> {
        self.state.pressure.clone()
    }

    /// Gap per slave vertex along its normal (≥ 0 apart).
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn gap(&self) -> Vec<f64> {
        self.state.gap.clone()
    }

    /// 1 where a slave vertex is closed (touching), 0 where open.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn closed(&self) -> Vec<u8> {
        self.state
            .closed
            .iter()
            .map(|&closed| u8::from(closed))
            .collect()
    }

    /// The total normal force the contact carries.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn force(&self) -> f64 {
        self.state.force()
    }

    /// Slave vertices a support holds along their whole normal: they keep
    /// the support and carry no contact condition.
    #[wasm_bindgen(getter, js_name = heldNodes)]
    #[must_use]
    pub fn held_nodes(&self) -> usize {
        self.state.held.len()
    }

    /// Nodes the model's ties tie; 0 without ties.
    #[wasm_bindgen(getter, js_name = tiedNodes)]
    #[must_use]
    pub fn tied_nodes(&self) -> usize {
        self.state.ties.tied_nodes
    }
}

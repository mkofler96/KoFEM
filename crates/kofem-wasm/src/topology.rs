// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! SIMP topology optimization of a solid model (`kofem_fem::topology`), as a
//! run the caller advances one iteration at a time — to log each iteration
//! and draw the emerging design between them.

use kofem_fem::topology::{
    Aggregation, Objective, SimpModel, SimpOptimizer, SimpSettings, SimpSolver, StepReport,
    StressConstraint,
};
use wasm_bindgen::prelude::*;

use crate::{to_js, ElasticModel};

/// The settings of one run. Defaults are the caller's: every value is given.
#[wasm_bindgen]
pub struct TopologySettings {
    settings: SimpSettings,
}

#[wasm_bindgen]
impl TopologySettings {
    /// `objective`: `"min_compliance"` (needs `volumeFraction`) or
    /// `"min_volume"` (needs `complianceLimit`, a stress limit, or both).
    /// `filterRadius` ≤ 0 takes 1.5 mean element sizes. `rhoMin` is the
    /// design lower bound (> 0 with a stress limit).
    ///
    /// # Errors
    /// An unknown objective, or one without the bound it needs.
    #[wasm_bindgen(constructor)]
    #[allow(
        clippy::too_many_arguments,
        reason = "one argument per setting of the Optimize panel's wire contract"
    )]
    pub fn new(
        objective: &str,
        volume_fraction: Option<f64>,
        compliance_limit: Option<f64>,
        penalty: f64,
        filter_radius: f64,
        move_limit: f64,
        max_iterations: usize,
        tolerance: f64,
        rho_min: f64,
        stream_every: usize,
    ) -> Result<TopologySettings, JsError> {
        let objective = match objective {
            "min_compliance" => Objective::MinCompliance,
            "min_volume" => Objective::MinVolume,
            other => {
                return Err(JsError::new(&format!(
                    "unknown topology-optimization objective \"{other}\" — expected \
                     \"min_compliance\" or \"min_volume\""
                )))
            }
        };
        let volume_fraction = match (objective, volume_fraction) {
            (Objective::MinCompliance, Some(fraction)) => fraction,
            (Objective::MinCompliance, None) => {
                return Err(JsError::new(
                    "the min_compliance objective requires a volume fraction",
                ))
            }
            // Unused by min_volume.
            (Objective::MinVolume, _) => 1.0,
        };
        if let Some(limit) = compliance_limit {
            if !(limit.is_finite() && limit > 0.0) {
                return Err(JsError::new("the compliance limit must be > 0"));
            }
        }
        Ok(TopologySettings {
            settings: SimpSettings {
                objective,
                volume_fraction,
                compliance_limit: compliance_limit.unwrap_or(0.0),
                penalty,
                filter_radius,
                move_limit,
                max_iterations,
                tolerance,
                rho_min,
                stream_every,
                ..SimpSettings::default()
            },
        })
    }

    /// Add a maximum von Mises stress `limit` (`σ_allow`, in the model's stress
    /// units) on the qp-relaxed element stress: `aggregation` `"pnorm"` or
    /// `"ks"` with parameter P, relaxation exponent q (0 ≤ q < penalty).
    ///
    /// # Errors
    /// An unknown aggregation.
    #[wasm_bindgen(js_name = setStressLimit)]
    pub fn set_stress_limit(
        &mut self,
        limit: f64,
        aggregation: &str,
        parameter: f64,
        relaxation: f64,
    ) -> Result<(), JsError> {
        let aggregation = match aggregation {
            "pnorm" => Aggregation::PNorm,
            "ks" => Aggregation::Ks,
            other => {
                return Err(JsError::new(&format!(
                    "unknown stress aggregation \"{other}\" — expected \"pnorm\" or \"ks\""
                )))
            }
        };
        self.settings.stress = Some(StressConstraint {
            aggregation,
            parameter,
            relaxation,
            ..StressConstraint::new(limit)
        });
        Ok(())
    }

    /// Elements (tets, then hexes) kept solid and kept void.
    #[wasm_bindgen(js_name = setPassive)]
    pub fn set_passive(&mut self, solid: &[u32], void: &[u32]) {
        self.settings.passive_solid = solid.iter().map(|&element| element as usize).collect();
        self.settings.passive_void = void.iter().map(|&element| element as usize).collect();
    }
}

/// A topology optimization in progress.
#[wasm_bindgen]
pub struct TopologyRun {
    optimizer: SimpOptimizer,
}

#[wasm_bindgen]
impl TopologyRun {
    /// Optimize `model` (linear elements, one design density per element)
    /// with the DOFs `fixedDofs` (3·node + component) held and the nodal
    /// `forces`, solved with multigrid CG. The compliance objective needs
    /// homogeneous supports, so every `fixedValues` entry must be 0.
    ///
    /// # Errors
    /// A prescribed (non-zero) displacement, a model SIMP cannot take
    /// (quadratic, unsupported, unloaded), or settings out of range.
    #[wasm_bindgen(constructor)]
    pub fn new(
        model: &ElasticModel,
        fixed_dofs: &[u32],
        fixed_values: &[f64],
        forces: Vec<f64>,
        settings: &TopologySettings,
    ) -> Result<TopologyRun, JsError> {
        if fixed_values.len() != fixed_dofs.len() {
            return Err(JsError::new(&format!(
                "{} constraint values given for {} constrained degrees of freedom",
                fixed_values.len(),
                fixed_dofs.len()
            )));
        }
        if fixed_values.iter().any(|&value| value != 0.0) {
            return Err(JsError::new(
                "topology optimization does not support prescribed (non-zero) displacements \
                 — the minimum-compliance objective assumes homogeneous supports (u = 0). Use \
                 fixed supports plus applied loads instead.",
            ));
        }
        let simp = SimpModel::new(
            model.mesh.clone(),
            fixed_dofs,
            forces,
            SimpSolver::default(),
        )
        .map_err(|error| to_js(&error))?;
        let optimizer =
            SimpOptimizer::new(simp, &settings.settings).map_err(|error| to_js(&error))?;
        Ok(TopologyRun { optimizer })
    }

    /// Analyse the current design and take one MMA step.
    ///
    /// # Errors
    /// The run has finished, a solve fails, or a limit turns out infeasible.
    pub fn step(&mut self) -> Result<TopologyStep, JsError> {
        let report = self.optimizer.step().map_err(|error| to_js(&error))?;
        Ok(TopologyStep { report })
    }

    /// The design the last step analysed — once finished, the returned one.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn density(&self) -> Vec<f64> {
        self.optimizer.density().to_vec()
    }

    /// Entries in the history: once finished, the length to keep of the
    /// recorded steps (a capped run that fell back drops its last ones).
    #[wasm_bindgen(getter, js_name = historyLength)]
    #[must_use]
    pub fn history_length(&self) -> usize {
        self.optimizer.history().len()
    }

    #[wasm_bindgen(getter, js_name = elementCount)]
    #[must_use]
    pub fn element_count(&self) -> usize {
        self.optimizer.element_count()
    }

    #[wasm_bindgen(getter, js_name = dofCount)]
    #[must_use]
    pub fn dof_count(&self) -> usize {
        self.optimizer.dof_count()
    }

    /// The filter radius in use (the default when the settings name none).
    #[wasm_bindgen(getter, js_name = filterRadius)]
    #[must_use]
    pub fn filter_radius(&self) -> f64 {
        self.optimizer.filter_radius()
    }
}

/// What one `TopologyRun.step` did.
#[wasm_bindgen]
pub struct TopologyStep {
    report: StepReport,
}

#[wasm_bindgen]
impl TopologyStep {
    /// The iteration this step analysed, from 1.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn iteration(&self) -> usize {
        self.report.entry.iteration
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn compliance(&self) -> f64 {
        self.report.entry.compliance
    }

    /// Volume fraction of the analysed design.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn volume(&self) -> f64 {
        self.report.entry.volume
    }

    /// max|Δρ| of the step that followed.
    #[wasm_bindgen(getter, js_name = maxChange)]
    #[must_use]
    pub fn max_change(&self) -> f64 {
        self.report.entry.max_change
    }

    /// The normalized stress aggregate (stress units); undefined without a
    /// stress limit.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn stress(&self) -> Option<f64> {
        self.report.entry.stress
    }

    /// The true max relaxed von Mises stress; undefined without a limit.
    #[wasm_bindgen(getter, js_name = maxStress)]
    #[must_use]
    pub fn max_stress(&self) -> Option<f64> {
        self.report.entry.max_stress
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn finished(&self) -> bool {
        self.report.finished
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn converged(&self) -> bool {
        self.report.converged
    }

    /// Whether to show `TopologyRun.density` now.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn stream(&self) -> bool {
        self.report.stream
    }

    /// The iteration whose design `TopologyRun.density` now holds.
    #[wasm_bindgen(getter, js_name = densityIteration)]
    #[must_use]
    pub fn density_iteration(&self) -> usize {
        self.report.density_iteration
    }

    /// Why the returned design is not this step's, for the log.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn note(&self) -> Option<String> {
        self.report.note.clone()
    }
}

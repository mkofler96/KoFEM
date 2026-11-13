// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The SIMP optimization loop, `min_compliance` or `min_volume`, optionally
//! stress-constrained. Port of the C++ engine's `topology_optimize.cpp`.
//!
//! One iteration:
//! 1. SIMP-penalized solve → compliance c and dc/dρ;
//! 2. filter the sensitivities for mesh independence;
//! 3. one MMA step on the objective and constraints, within the move limit
//!    and [`ρ_min`, 1];
//! 4. converge on max|Δρ| < tolerance once the design also meets its limits,
//!    or stop at the iteration cap.
//!
//! A stress-constrained run adds the relaxed stress, its aggregate and one
//! adjoint solve after (1), and filters densities instead of sensitivities:
//! the design variable x is smoothed into the analysed density ρ̃ = H·x/Hs,
//! and every gradient is chained back to x exactly. Sigmund's sensitivity
//! filter is a heuristic tuned for compliance; applied to the mixed-sign
//! stress gradient it is no longer a derivative and MMA stalls.
//!
//! [`SimpOptimizer`] runs one iteration per [`SimpOptimizer::step`], so the
//! caller can report progress and show the design between iterations.

use crate::error::FemError;

use super::filter::{default_filter_radius, DensityFilter};
use super::formulation::{
    constraint_count, formulate, FormulationInputs, Objective, COMPLIANCE_LIMIT_SLACK,
    STRESS_LIMIT_SLACK, VOLUME_LIMIT_SLACK,
};
use super::mma::Mma;
use super::simp::SimpModel;
use super::stress::StressConstraint;
use super::topology_error;

/// The settings of one run; [`SimpSettings::default`] holds the ADR-0002
/// defaults.
#[derive(Debug, Clone, PartialEq)]
pub struct SimpSettings {
    pub objective: Objective,
    /// `min_compliance`: the target `Σρ_e·V_e` / `ΣV_e`, in (0, 1].
    pub volume_fraction: f64,
    /// `min_volume`: `c_allow` (> 0); 0 means none, allowed only with a stress limit.
    pub compliance_limit: f64,
    /// SIMP penalty p.
    pub penalty: f64,
    /// `r_min` in model length units; ≤ 0 → 1.5 mean element sizes.
    pub filter_radius: f64,
    pub move_limit: f64,
    pub max_iterations: usize,
    /// Convergence on max|Δρ|.
    pub tolerance: f64,
    /// Stiffness floor `E_min/E₀`.
    pub emin_rel: f64,
    /// Design lower bound (> 0 with a stress limit whose p − q < 1).
    pub rho_min: f64,
    /// Elements kept at density 1 and at `rho_min`. They are not design
    /// variables but count toward the volume and take part in the filter.
    pub passive_solid: Vec<usize>,
    pub passive_void: Vec<usize>,
    pub stress: Option<StressConstraint>,
    /// Report the design for display every this many iterations (and always
    /// the last one).
    pub stream_every: usize,
}

impl Default for SimpSettings {
    fn default() -> Self {
        Self {
            objective: Objective::MinCompliance,
            volume_fraction: 0.5,
            compliance_limit: 0.0,
            penalty: 3.0,
            filter_radius: 0.0,
            move_limit: 0.2,
            max_iterations: 100,
            tolerance: 0.01,
            emin_rel: 1e-9,
            rho_min: 0.0,
            passive_solid: Vec::new(),
            passive_void: Vec::new(),
            stress: None,
            stream_every: 1,
        }
    }
}

/// One analysed design in the history. `compliance` is c(ρ), `volume` the
/// volume fraction, `max_change` max|Δρ| of the step that followed. A
/// stress-constrained run also records the normalized aggregate the
/// constraint bounds (`stress`) and the true max relaxed von Mises stress
/// (`max_stress`), both in stress units.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HistoryEntry {
    pub iteration: usize,
    pub compliance: f64,
    pub volume: f64,
    pub max_change: f64,
    pub stress: Option<f64>,
    pub max_stress: Option<f64>,
}

/// What one [`SimpOptimizer::step`] did.
#[derive(Debug, Clone, PartialEq)]
pub struct StepReport {
    /// The design this step analysed.
    pub entry: HistoryEntry,
    /// The run is over: converged, at the cap, or fallen back.
    pub finished: bool,
    pub converged: bool,
    /// Show [`SimpOptimizer::density`] now, as the design of iteration
    /// `density_iteration`.
    pub stream: bool,
    pub density_iteration: usize,
    /// Why the returned design is not this step's, for the log.
    pub note: Option<String>,
}

/// The result of a finished run.
#[derive(Debug, Clone, PartialEq)]
pub struct SimpResult {
    /// `ρ_e` per element, the design of the last history entry.
    pub density: Vec<f64>,
    /// Its solution, 3 per node.
    pub displacements: Vec<f64>,
    pub history: Vec<HistoryEntry>,
    pub iterations: usize,
    /// Stopped on the tolerance, not the cap.
    pub converged: bool,
}

/// Run a whole optimization, handing the design to `on_density` as
/// [`SimpSettings::stream_every`] asks.
///
/// # Errors
/// As [`SimpOptimizer::new`] and [`SimpOptimizer::step`].
pub fn optimize(
    model: SimpModel,
    settings: &SimpSettings,
    mut on_density: impl FnMut(usize, &[f64]),
) -> Result<SimpResult, FemError> {
    let mut optimizer = SimpOptimizer::new(model, settings)?;
    loop {
        let report = optimizer.step()?;
        if report.stream {
            on_density(report.density_iteration, optimizer.density());
        }
        if report.finished {
            return Ok(optimizer.into_result());
        }
    }
}

/// Element state in the design domain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pin {
    Active,
    Solid,
    Void,
}

/// The last analysed design that met its limits, returned instead of an
/// infeasible one when the cap lands on it.
struct Feasible {
    iteration: usize,
    rho: Vec<f64>,
    displacements: Vec<f64>,
}

/// A SIMP run in progress.
pub struct SimpOptimizer {
    model: SimpModel,
    settings: SimpSettings,
    pins: Vec<Pin>,
    active: Vec<usize>,
    filter: DensityFilter,
    filter_radius: f64,
    mma: Mma,
    /// Design variables of the active elements.
    design: Vec<f64>,
    /// Design field over every element (passives pinned).
    xfull: Vec<f64>,
    /// The density the next step analyses (the last analysed once finished).
    rho: Vec<f64>,
    total_volume: f64,
    volume_cap: f64,
    has_compliance_limit: bool,
    stress_excluded: Vec<bool>,
    /// Adaptive normalization `c_k` (Le et al. eq. 17); unset before the first.
    stress_norm: Option<f64>,
    /// Lowest true max stress of an iterate within the volume budget.
    lowest_stress: Option<(f64, usize)>,
    /// 1/c₀, fixed at the first iteration.
    compliance_scale: Option<f64>,
    history: Vec<HistoryEntry>,
    displacements: Vec<f64>,
    best_feasible: Option<Feasible>,
    finished: bool,
    converged: bool,
}

impl SimpOptimizer {
    /// Check the settings against the model and set up the run: the design
    /// domain, the filter and MMA. Active elements start at the volume
    /// fraction (`min_compliance`) or at full material (`min_volume`, so the
    /// first solve checks `c_allow` and MMA starts inside the feasible set).
    ///
    /// # Errors
    /// Settings out of range, contradictory passive pins, an infeasible
    /// volume fraction, or no design variables.
    #[allow(
        clippy::too_many_lines,
        reason = "the setting checks of the C++ loop, one after the other"
    )]
    pub fn new(model: SimpModel, settings: &SimpSettings) -> Result<Self, FemError> {
        let settings = settings.clone();
        let count = model.element_count();
        let min_volume = settings.objective == Objective::MinVolume;
        let fraction_ok = settings.volume_fraction > 0.0 && settings.volume_fraction <= 1.0;
        if settings.objective == Objective::MinCompliance && !fraction_ok {
            return Err(topology_error(format!(
                "the volume fraction must be in (0, 1], got {}",
                settings.volume_fraction
            )));
        }
        let has_compliance_limit = min_volume && settings.compliance_limit > 0.0;
        if min_volume
            && (!settings.compliance_limit.is_finite()
                || settings.compliance_limit < 0.0
                || (settings.compliance_limit == 0.0 && settings.stress.is_none()))
        {
            return Err(topology_error(
                "the min_volume objective needs a finite, positive compliance limit (or none \
                 together with a stress limit)",
            ));
        }
        if !(settings.rho_min >= 0.0 && settings.rho_min < 1.0) {
            return Err(topology_error("rho_min must be in [0, 1)"));
        }
        if settings.max_iterations == 0 {
            return Err(topology_error("maxIterations must be a positive integer"));
        }
        if settings.stream_every == 0 {
            return Err(topology_error("streamEvery must be a positive integer"));
        }
        let positive = |value: f64| value.is_finite() && value > 0.0;
        if !positive(settings.penalty) {
            return Err(topology_error(
                "the SIMP penalty must be finite and positive",
            ));
        }
        if !settings.filter_radius.is_finite() {
            return Err(topology_error("the filter radius must be finite"));
        }
        if !positive(settings.move_limit) {
            return Err(topology_error("the move limit must be finite and positive"));
        }
        if !positive(settings.tolerance) {
            return Err(topology_error("the tolerance must be finite and positive"));
        }
        if !(positive(settings.emin_rel) && settings.emin_rel < 1.0) {
            return Err(topology_error(
                "the stiffness floor emin_rel must be in (0, 1)",
            ));
        }
        if let Some(stress) = &settings.stress {
            if !positive(stress.limit) {
                return Err(topology_error(
                    "the stress limit sigma_allow must be finite and positive",
                ));
            }
            if !(stress.parameter.is_finite() && stress.parameter >= 1.0) {
                return Err(topology_error(
                    "the stress aggregation parameter P must be >= 1",
                ));
            }
            if !(stress.relaxation.is_finite()
                && stress.relaxation >= 0.0
                && stress.relaxation < settings.penalty)
            {
                return Err(topology_error(format!(
                    "the stress relaxation q must satisfy 0 <= q < p (penalty {})",
                    settings.penalty
                )));
            }
            if !(positive(stress.alpha) && stress.alpha <= 1.0) {
                return Err(topology_error(
                    "the stress normalization alpha must be in (0, 1]",
                ));
            }
            if settings.penalty - stress.relaxation < 1.0 && settings.rho_min <= 0.0 {
                return Err(topology_error(
                    "a stress-constrained run needs rho_min > 0 — the relaxed stress \
                     rho^(p-q) has an unbounded derivative at rho = 0",
                ));
            }
        }

        let mut pins = vec![Pin::Active; count];
        for (list, pin, which) in [
            (&settings.passive_solid, Pin::Solid, "solid"),
            (&settings.passive_void, Pin::Void, "void"),
        ] {
            for &element in list {
                let slot = pins.get_mut(element).ok_or_else(|| {
                    topology_error(format!(
                        "passive {which} element index {element} is out of range [0, {count})"
                    ))
                })?;
                if *slot != Pin::Active && *slot != pin {
                    return Err(topology_error(format!(
                        "element {element} is listed as both passive solid and passive void"
                    )));
                }
                *slot = pin;
            }
        }
        let active: Vec<usize> = (0..count)
            .filter(|&element| pins[element] == Pin::Active)
            .collect();
        if active.is_empty() {
            return Err(topology_error(
                "every element is pinned — no design variables",
            ));
        }

        let volumes = model.volumes();
        let total_volume: f64 = volumes.iter().sum();
        if total_volume.is_nan() || total_volume <= 0.0 {
            return Err(topology_error("the mesh has no volume"));
        }
        let volume_cap = settings.volume_fraction * total_volume;
        // The least reachable volume: pinned solid plus rho_min elsewhere.
        let solid_volume: f64 = (0..count)
            .filter(|&element| pins[element] == Pin::Solid)
            .map(|element| volumes[element])
            .sum();
        let least = solid_volume + settings.rho_min * (total_volume - solid_volume);
        if !min_volume && least > volume_cap * (1.0 + 1e-9) {
            return Err(topology_error(format!(
                "volume fraction {} is infeasible — the minimum reachable volume fraction is \
                 {} given rho_min and the pinned-solid volume",
                settings.volume_fraction,
                least / total_volume
            )));
        }

        let filter_radius = if settings.filter_radius > 0.0 {
            settings.filter_radius
        } else {
            default_filter_radius(volumes)?
        };
        let filter = DensityFilter::new(model.centroids(), filter_radius)?;

        let start = if min_volume {
            1.0
        } else {
            settings.volume_fraction
        };
        let xfull: Vec<f64> = pins
            .iter()
            .map(|pin| match pin {
                Pin::Active => start,
                Pin::Solid => 1.0,
                Pin::Void => settings.rho_min,
            })
            .collect();
        let design: Vec<f64> = active.iter().map(|&element| xfull[element]).collect();
        let rows = constraint_count(
            settings.objective,
            has_compliance_limit,
            settings.stress.is_some(),
        )?;
        let mma = Mma::new(
            active.len(),
            rows,
            vec![settings.rho_min; active.len()],
            vec![1.0; active.len()],
            settings.move_limit,
        )?;
        let stress_excluded = pins.iter().map(|&pin| pin == Pin::Void).collect();
        let mut optimizer = Self {
            model,
            pins,
            active,
            filter,
            filter_radius,
            mma,
            design,
            rho: Vec::new(),
            xfull,
            total_volume,
            volume_cap,
            has_compliance_limit,
            stress_excluded,
            stress_norm: None,
            lowest_stress: None,
            compliance_scale: None,
            history: Vec::with_capacity(settings.max_iterations),
            displacements: Vec::new(),
            best_feasible: None,
            finished: false,
            converged: false,
            settings,
        };
        optimizer.rho = optimizer.physical(&optimizer.xfull)?;
        Ok(optimizer)
    }

    /// The analysed density of a design field: the field itself, or with a
    /// stress limit its density-filtered form with the passives re-pinned.
    fn physical(&self, xfull: &[f64]) -> Result<Vec<f64>, FemError> {
        if self.settings.stress.is_none() {
            return Ok(xfull.to_vec());
        }
        let mut rho = self.filter.filter_density(xfull)?;
        for (element, value) in rho.iter_mut().enumerate() {
            if self.pins[element] != Pin::Active {
                *value = xfull[element];
            }
        }
        Ok(rho)
    }

    /// The filter radius in use (the default when the settings name none).
    #[must_use]
    pub fn filter_radius(&self) -> f64 {
        self.filter_radius
    }

    #[must_use]
    pub fn element_count(&self) -> usize {
        self.model.element_count()
    }

    /// Unknowns of each solve.
    #[must_use]
    pub fn dof_count(&self) -> usize {
        self.model.mesh().dof_count()
    }

    /// The design the last step analysed (once finished: the returned one).
    #[must_use]
    pub fn density(&self) -> &[f64] {
        &self.rho
    }

    #[must_use]
    pub fn history(&self) -> &[HistoryEntry] {
        &self.history
    }

    #[must_use]
    pub fn is_finished(&self) -> bool {
        self.finished
    }

    #[must_use]
    pub fn converged(&self) -> bool {
        self.converged
    }

    #[must_use]
    pub fn into_result(self) -> SimpResult {
        SimpResult {
            iterations: self.history.len(),
            density: self.rho,
            displacements: self.displacements,
            history: self.history,
            converged: self.converged,
        }
    }

    /// Analyse the current design, record it, and take the MMA step unless
    /// the run ends here.
    ///
    /// # Errors
    /// The run is already finished, a solve fails, the compliance limit is
    /// below what full material reaches, or no iterate met the stress limit
    /// by the cap.
    #[allow(
        clippy::too_many_lines,
        reason = "one iteration of the C++ loop, kept whole so the two stay comparable"
    )]
    pub fn step(&mut self) -> Result<StepReport, FemError> {
        if self.finished {
            return Err(topology_error("the optimization has already finished"));
        }
        let iteration = self.history.len() + 1;
        let settings = &self.settings;
        let (penalty, emin) = (settings.penalty, settings.emin_rel);
        let min_volume = settings.objective == Objective::MinVolume;
        let count = self.model.element_count();

        // (1) The penalized solve.
        let evaluation = self.model.evaluate_compliance(&self.rho, penalty, emin)?;
        let compliance = evaluation.compliance;
        let compliance_scale = *self.compliance_scale.get_or_insert(if compliance > 0.0 {
            1.0 / compliance
        } else {
            1.0
        });
        // Compliance falls with every ρ_e, so full material (iteration 1 of
        // min_volume) is the least any design reaches.
        if self.has_compliance_limit
            && iteration == 1
            && compliance > settings.compliance_limit * (1.0 + 1e-9)
        {
            return Err(topology_error(format!(
                "compliance limit {} is infeasible — even the full-material design has \
                 compliance {compliance}; raise the limit above that value",
                settings.compliance_limit
            )));
        }

        // (1b) The relaxed stress, its aggregate and the adjoint sensitivity.
        let stress_state = match settings.stress {
            Some(stress) => {
                let evaluated = self.model.evaluate_stress(
                    &self.rho,
                    &evaluation.displacements,
                    penalty,
                    emin,
                    penalty - stress.relaxation,
                    &stress,
                    Some(&self.stress_excluded),
                )?;
                let ratio = if evaluated.aggregate > 0.0 {
                    (evaluated.max_relaxed / stress.limit) / evaluated.aggregate
                } else {
                    1.0
                };
                let norm = match self.stress_norm {
                    None => ratio,
                    Some(previous) => stress.alpha * ratio + (1.0 - stress.alpha) * previous,
                };
                self.stress_norm = Some(norm);
                Some((stress, norm, evaluated))
            }
            None => None,
        };

        // (2) Sensitivities: the sensitivity filter on dc/dρ, or with a stress
        // limit every gradient chained back through the density filter (the
        // passives do not depend on x).
        let volumes = self.model.volumes();
        let mut dcompliance = evaluation.dcompliance;
        let mut dvolume = Vec::new();
        let mut dstress = Vec::new();
        match &stress_state {
            None => self
                .filter
                .filter_sensitivity(&self.rho, &mut dcompliance)?,
            Some((_, norm, evaluated)) => {
                dvolume = volumes.to_vec();
                dstress = evaluated
                    .daggregate
                    .iter()
                    .map(|value| value * norm)
                    .collect();
                for element in 0..count {
                    if self.pins[element] != Pin::Active {
                        dcompliance[element] = 0.0;
                        dvolume[element] = 0.0;
                        dstress[element] = 0.0;
                    }
                }
                self.filter.chain_density_sensitivity(&mut dcompliance)?;
                self.filter.chain_density_sensitivity(&mut dvolume)?;
                self.filter.chain_density_sensitivity(&mut dstress)?;
            }
        }
        let used_volume: f64 = self
            .rho
            .iter()
            .zip(volumes)
            .map(|(rho, volume)| rho * volume)
            .sum();
        let volume = used_volume / self.total_volume;
        let stress_measure = stress_state
            .as_ref()
            .map(|(_, norm, evaluated)| norm * evaluated.aggregate);
        let step = formulate(&FormulationInputs {
            objective: settings.objective,
            active: &self.active,
            volumes,
            total_volume: self.total_volume,
            used_volume,
            compliance,
            dcompliance: &dcompliance,
            dvolume: stress_state.as_ref().map(|_| dvolume.as_slice()),
            volume_cap: self.volume_cap,
            compliance_limit: if self.has_compliance_limit {
                settings.compliance_limit
            } else {
                0.0
            },
            compliance_scale,
            stress: stress_measure.map(|measure| (measure, dstress.as_slice())),
        })?;

        // (3) One MMA step, and the change it would make.
        let next = self
            .mma
            .update(&self.design, step.f0, &step.df0, &step.fval, &step.dfdx)?;
        let max_change = next
            .iter()
            .zip(&self.design)
            .map(|(new, old)| (new - old).abs())
            .fold(0.0, f64::max);

        // (4) Record the analysed design.
        let max_stress = stress_state
            .as_ref()
            .map(|(_, _, evaluated)| evaluated.max_relaxed);
        let entry = HistoryEntry {
            iteration,
            compliance,
            volume,
            max_change,
            stress: stress_state
                .as_ref()
                .zip(stress_measure)
                .map(|((stress, _, _), measure)| measure * stress.limit),
            max_stress,
        };
        self.history.push(entry);
        self.displacements = evaluation.displacements;

        // A constrained design converges only once it honours its limits.
        let compliance_ok = !self.has_compliance_limit
            || compliance <= settings.compliance_limit * (1.0 + COMPLIANCE_LIMIT_SLACK);
        let stress_ok = match (&settings.stress, max_stress) {
            (Some(stress), Some(peak)) => peak <= stress.limit * (1.0 + STRESS_LIMIT_SLACK),
            _ => true,
        };
        let volume_ok = min_volume
            || settings.stress.is_none()
            || used_volume <= self.volume_cap * (1.0 + VOLUME_LIMIT_SLACK);
        let feasible = compliance_ok && stress_ok && volume_ok;
        if let Some(peak) = max_stress {
            if volume_ok && self.lowest_stress.is_none_or(|(lowest, _)| peak < lowest) {
                self.lowest_stress = Some((peak, iteration));
            }
        }
        if (min_volume || settings.stress.is_some()) && feasible {
            self.best_feasible = Some(Feasible {
                iteration,
                rho: self.rho.clone(),
                displacements: self.displacements.clone(),
            });
        }
        let converged = max_change < settings.tolerance && feasible;
        let last = converged || iteration >= settings.max_iterations;

        if last && !feasible {
            let Some(best) = self.best_feasible.take() else {
                return Err(self.stress_infeasible(iteration));
            };
            let note = if let Some(peak) = max_stress {
                format!(
                    "hit max_iterations on a design above its limits (c={compliance}, \
                     vol={volume:.4}, max stress={peak}); returning the last design that met \
                     them (it {})",
                    best.iteration
                )
            } else {
                format!(
                    "hit max_iterations with c={compliance} above c_allow={}; returning the \
                     last design that met the limit (it {})",
                    settings.compliance_limit, best.iteration
                )
            };
            self.rho = best.rho;
            self.displacements = best.displacements;
            self.history.truncate(best.iteration);
            self.finished = true;
            self.converged = false;
            return Ok(StepReport {
                entry,
                finished: true,
                converged: false,
                stream: true,
                density_iteration: best.iteration,
                note: Some(note),
            });
        }
        let stream = last || iteration.is_multiple_of(settings.stream_every);
        if last {
            self.finished = true;
            self.converged = converged;
        } else {
            for (&element, &value) in self.active.iter().zip(&next) {
                self.xfull[element] = value;
            }
            self.design = next;
            self.rho = self.physical(&self.xfull)?;
        }
        Ok(StepReport {
            entry,
            finished: last,
            converged: last && converged,
            stream,
            density_iteration: iteration,
            note: None,
        })
    }

    /// No iterate met the stress limit (within the volume budget) by the cap.
    fn stress_infeasible(&self, iterations: usize) -> FemError {
        let min_volume = self.settings.objective == Objective::MinVolume;
        let limit = self.settings.stress.map_or(0.0, |stress| stress.limit);
        let budget = if min_volume {
            ""
        } else {
            " within the volume budget"
        };
        let reached = match self.lowest_stress {
            None => "no iterate even met the volume budget alongside it".to_owned(),
            Some((peak, at)) => format!(
                "the lowest max von Mises stress reached{budget} was {peak} (iteration {at})"
            ),
        };
        let (loads, advice) = if min_volume {
            ("", "")
        } else {
            (" and this volume fraction", ", raise the volume fraction")
        };
        topology_error(format!(
            "maximum-stress limit {limit} was not met{budget} by any of the {iterations} \
             iterations — {reached}. The limit looks infeasible for these loads{loads}: raise \
             it{advice} or allow more iterations."
        ))
    }
}

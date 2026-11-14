// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The objective and constraints one SIMP iteration hands to MMA. Port of
//! the C++ engine's `topology_formulation.cpp`:
//!
//! ```text
//! min_compliance:  minimize c(ρ)   s.t.  V(ρ) ≤ volfrac·V_total
//! min_volume:      minimize V(ρ)   s.t.  c(ρ) ≤ c_allow
//! ```
//!
//! either optionally with a maximum von Mises stress `σ_PN`(ρ) ≤ `σ_allow` on the
//! aggregated relaxed stress; a `min_volume` run may then drop the compliance
//! limit. Constraint rows are ordered [volume | compliance, stress], all in
//! the normalized form MMA wants (O(1), as `f_i` ≤ 0).

use crate::error::FemError;

use super::topology_error;

/// What a run minimizes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Objective {
    MinCompliance,
    MinVolume,
}

/// Relative slack on the compliance limit for a `min_volume` run to count as
/// converged: MMA approaches an active constraint from either side.
pub const COMPLIANCE_LIMIT_SLACK: f64 = 5e-3;

/// The same for the stress limit, judged on the true max relaxed stress. The
/// adaptive P-norm normalization lags the true max by one iteration, so the
/// iterate oscillates around `σ_allow` by a few percent before it settles.
pub const STRESS_LIMIT_SLACK: f64 = 2e-2;

/// Relative slack on the volume cap of a stress-constrained `min_compliance` run.
pub const VOLUME_LIMIT_SLACK: f64 = 5e-3;

/// Number of MMA constraint rows.
///
/// # Errors
/// A `min_volume` run with neither a compliance nor a stress limit: nothing
/// bounds how much material is removed.
pub fn constraint_count(
    objective: Objective,
    has_compliance_limit: bool,
    has_stress: bool,
) -> Result<usize, FemError> {
    let primary = usize::from(objective == Objective::MinCompliance || has_compliance_limit);
    let count = primary + usize::from(has_stress);
    if count == 0 {
        return Err(topology_error(
            "min_volume needs a compliance limit, a maximum-stress limit, or both — without \
             one nothing bounds how much material is removed",
        ));
    }
    Ok(count)
}

/// Everything one MMA step needs, over the active design variables.
#[derive(Debug, Clone, PartialEq)]
pub struct MmaStep {
    pub f0: f64,
    pub df0: Vec<f64>,
    pub fval: Vec<f64>,
    /// m × n, row-major.
    pub dfdx: Vec<f64>,
}

/// One iteration's responses, per element.
pub struct FormulationInputs<'data> {
    pub objective: Objective,
    /// Design element of each variable.
    pub active: &'data [usize],
    /// `V_e`.
    pub volumes: &'data [f64],
    /// Σ `V_e`.
    pub total_volume: f64,
    /// Σ `ρ_e·V_e`.
    pub used_volume: f64,
    pub compliance: f64,
    /// Filtered `dc/dρ_e`.
    pub dcompliance: &'data [f64],
    /// `dV/dρ_e`; `None` → `V_e` (exact when ρ is the design variable).
    pub dvolume: Option<&'data [f64]>,
    /// `min_compliance`: `volfrac·V_total`.
    pub volume_cap: f64,
    /// `min_volume`: `c_allow`; 0 → no compliance row.
    pub compliance_limit: f64,
    /// `min_compliance`: 1/c₀.
    pub compliance_scale: f64,
    /// The normalized stress aggregate g = `c·σ_PN/σ_allow` and `dg/dρ_e`; the
    /// row is g − 1.
    pub stress: Option<(f64, &'data [f64])>,
}

/// Assemble (f0, df0, fval, dfdx):
///
/// ```text
/// min_compliance: f0 = c/c₀,       f₁ = V/V_cap − 1
/// min_volume:     f0 = V/V_total,  f₁ = c/c_allow − 1   (when c_allow > 0)
/// + stress:                        f_m = g − 1
/// ```
///
/// # Errors
/// As [`constraint_count`].
pub fn formulate(inputs: &FormulationInputs) -> Result<MmaStep, FemError> {
    let active = inputs.active;
    let dvolume = inputs.dvolume.unwrap_or(inputs.volumes);
    let dcompliance = inputs.dcompliance;
    let min_volume = inputs.objective == Objective::MinVolume;
    let count = constraint_count(
        inputs.objective,
        inputs.compliance_limit > 0.0,
        inputs.stress.is_some(),
    )?;
    let mut fval = Vec::with_capacity(count);
    let mut dfdx = Vec::with_capacity(count * active.len());
    let (f0, df0) = if min_volume {
        let df0 = active
            .iter()
            .map(|&element| dvolume[element] / inputs.total_volume)
            .collect();
        if inputs.compliance_limit > 0.0 {
            fval.push((inputs.compliance / inputs.compliance_limit) - 1.0);
            dfdx.extend(
                active
                    .iter()
                    .map(|&element| dcompliance[element] / inputs.compliance_limit),
            );
        }
        (inputs.used_volume / inputs.total_volume, df0)
    } else {
        let df0 = active
            .iter()
            .map(|&element| dcompliance[element] * inputs.compliance_scale)
            .collect();
        fval.push((inputs.used_volume / inputs.volume_cap) - 1.0);
        dfdx.extend(
            active
                .iter()
                .map(|&element| dvolume[element] / inputs.volume_cap),
        );
        (inputs.compliance * inputs.compliance_scale, df0)
    };
    if let Some((measure, dstress)) = inputs.stress {
        fval.push(measure - 1.0);
        dfdx.extend(active.iter().map(|&element| dstress[element]));
    }
    Ok(MmaStep {
        f0,
        df0,
        fval,
        dfdx,
    })
}

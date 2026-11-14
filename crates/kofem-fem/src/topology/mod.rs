// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Density-based topology optimization (SIMP, ADR-0002) on solid meshes of
//! linear tetrahedra and hexahedra, and on shell and coupled shell/solid
//! models ([`mixed`]): the penalized solve and its sensitivities ([`simp`]), the mesh-independence filter ([`filter`]), the
//! MMA optimizer ([`mma`]), the `min_compliance` / `min_volume` formulations
//! ([`formulation`]), the maximum-stress constraint ([`stress`]) and the loop
//! that drives them ([`optimize`]). A port of the C++ engine's
//! `topology_*.cpp`, step for step, so both give the same designs.

pub mod filter;
pub mod formulation;
pub mod mixed;
pub mod mma;
pub mod optimize;
pub mod simp;
pub mod stress;

pub use filter::{default_filter_radius, mean_element_size, DensityFilter, Neighbour};
pub use formulation::{Objective, COMPLIANCE_LIMIT_SLACK, STRESS_LIMIT_SLACK, VOLUME_LIMIT_SLACK};
pub use mixed::{MixedSimpModel, MixedSolver};
pub use mma::Mma;
pub use optimize::{
    optimize, DesignModel, HistoryEntry, SimpOptimizer, SimpResult, SimpSettings, StepReport,
};
pub use simp::{
    simp_scale, simp_scale_deriv, ComplianceEvaluation, SimpModel, SimpPreconditioner, SimpSolver,
    AMG_REBUILD_EVERY,
};
pub use stress::{Aggregation, StressConstraint, StressEvaluation};

use crate::error::FemError;

fn topology_error(reason: impl Into<String>) -> FemError {
    FemError::TopologyInput {
        reason: reason.into(),
    }
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Stress-constrained SIMP: the relaxed element von Mises stress, its P-norm
//! and KS aggregates with their adjoint sensitivities, and the constraint in
//! the loop on the L-bracket — ported from the C++ engine's
//! `engine/tests/topology_stress_validation.cpp`.

#![allow(
    clippy::expect_used,
    clippy::cast_precision_loss,
    reason = "test fixtures: a run that fails should abort the test; element counts fit \
              any float"
)]

mod topology_support;

use kofem_fem::topology::{
    optimize, Aggregation, Objective, SimpModel, SimpResult, SimpSettings, SimpSolver,
    StressConstraint, STRESS_LIMIT_SLACK, VOLUME_LIMIT_SLACK,
};
use kofem_fem::FemError;
use topology_support::{l_bracket, tight_solver, Problem};

const PENALTY: f64 = 3.0;
const EMIN: f64 = 1e-9;
/// L-bracket cells per side for the loop runs, as in the C++ suite: coarser,
/// and the compliance-only peak moves from the re-entrant corner to the load.
const CELLS: usize = 25;

fn constraint(limit: f64, aggregation: Aggregation, parameter: f64) -> StressConstraint {
    StressConstraint {
        aggregation,
        parameter,
        ..StressConstraint::new(limit)
    }
}

#[test]
fn uniaxial_tension_gives_e_times_strain_on_every_element() {
    let problem = l_bracket(6);
    let mut model = problem.model(tight_solver());
    let strain = 1e-3;
    let displacements: Vec<f64> = problem
        .vertices
        .iter()
        .flat_map(|point| {
            [
                strain * point[0],
                -0.3 * strain * point[1],
                -0.3 * strain * point[2],
            ]
        })
        .collect();
    let rho = vec![1.0; model.element_count()];
    let evaluation = model
        .evaluate_stress(
            &rho,
            &displacements,
            PENALTY,
            EMIN,
            0.5,
            &constraint(1.0, Aggregation::PNorm, 8.0),
            None,
        )
        .expect("stress");
    for &stress in &evaluation.relaxed {
        assert!((stress - strain).abs() / strain < 1e-10, "σ_vm = {stress}");
    }
}

fn aggregate_at(model: &mut SimpModel, rho: &[f64], stress: &StressConstraint) -> (f64, Vec<f64>) {
    let state = model
        .evaluate_compliance(rho, PENALTY, EMIN)
        .expect("state solve");
    let evaluation = model
        .evaluate_stress(
            rho,
            &state.displacements,
            PENALTY,
            EMIN,
            PENALTY - 2.5,
            stress,
            None,
        )
        .expect("stress");
    (evaluation.aggregate, evaluation.daggregate)
}

#[test]
fn adjoint_sensitivities_match_central_differences() {
    let problem = l_bracket(10);
    let mut model = SimpModel::new(
        problem.mesh.clone(),
        &problem.fixed,
        problem.forces.clone(),
        kofem_fem::topology::SimpSolver {
            relative_tolerance: 1e-13,
            ..tight_solver()
        },
    )
    .expect("model");
    let count = model.element_count();
    let rho: Vec<f64> = (0..count)
        .map(|element| {
            let index = element as f64;
            0.65 + 0.35 * (0.7 * index + 0.3 * (1.3 * index).cos()).sin()
        })
        .collect();
    for stress in [
        constraint(0.5, Aggregation::PNorm, 8.0),
        constraint(0.5, Aggregation::Ks, 40.0),
    ] {
        let (_, gradient) = aggregate_at(&mut model, &rho, &stress);
        // Probe elements whose sensitivity is at least 1% of the largest:
        // below that the quotient is CG noise, not the derivative.
        let largest = gradient
            .iter()
            .fold(0.0_f64, |max, value| max.max(value.abs()));
        let mut significant: Vec<usize> = (0..count)
            .filter(|&element| gradient[element].abs() >= 1e-2 * largest)
            .collect();
        significant.sort_by(|&lhs, &rhs| gradient[rhs].abs().total_cmp(&gradient[lhs].abs()));
        let probes = significant.len().min(7);
        assert!(probes > 0);
        for probe in 0..probes {
            let element = significant[probe * (significant.len() - 1) / 6];
            let step = 1e-5;
            let mut plus = rho.clone();
            let mut minus = rho.clone();
            plus[element] += step;
            minus[element] -= step;
            let upper = aggregate_at(&mut model, &plus, &stress).0;
            let lower = aggregate_at(&mut model, &minus, &stress).0;
            let difference = (upper - lower) / (2.0 * step);
            let relative = (difference - gradient[element]).abs() / difference.abs().max(1e-12);
            assert!(
                relative <= 1e-4,
                "{:?} element {element}: adjoint {} vs FD {difference} (rel {relative:e})",
                stress.aggregation,
                gradient[element]
            );
        }
    }
}

fn l_settings() -> SimpSettings {
    SimpSettings {
        volume_fraction: 0.4,
        penalty: PENALTY,
        filter_radius: 1.5 / CELLS as f64,
        move_limit: 0.2,
        max_iterations: 150,
        tolerance: 0.01,
        rho_min: 1e-3,
        ..SimpSettings::default()
    }
}

fn run(problem: &Problem, settings: &SimpSettings) -> Result<SimpResult, FemError> {
    optimize(problem.model(SimpSolver::default()), settings, |_, _| {})
}

/// Max relaxed von Mises stress of a design, evaluated outside the loop.
fn peak(problem: &Problem, density: &[f64]) -> (f64, usize) {
    let mut model = problem.model(SimpSolver::default());
    let state = model
        .evaluate_compliance(density, PENALTY, EMIN)
        .expect("state");
    let evaluation = model
        .evaluate_stress(
            density,
            &state.displacements,
            PENALTY,
            EMIN,
            PENALTY - 2.5,
            &constraint(1.0, Aggregation::PNorm, 8.0),
            None,
        )
        .expect("stress");
    (evaluation.max_relaxed, evaluation.argmax)
}

#[test]
fn a_stress_limit_rounds_off_the_l_bracket_corner() {
    let problem = l_bracket(CELLS);
    let centroids = problem.model(SimpSolver::default()).centroids().to_vec();
    let base = run(&problem, &l_settings()).expect("compliance-only");
    let (base_peak, base_at) = peak(&problem, &base.density);
    let corner = centroids[base_at];
    assert!(
        (corner[0] - 0.4).hypot(corner[1] - 0.4) < 0.05,
        "compliance-only peak at {corner:?}"
    );
    let last = base.history.last().expect("history");
    assert!(last.stress.is_none() && last.max_stress.is_none());

    // min_volume s.t. σ ≤ σ_allow against a compliance design of equal volume.
    let limit = 0.7 * base_peak;
    let settings = SimpSettings {
        objective: Objective::MinVolume,
        compliance_limit: 0.0,
        stress: Some(constraint(limit, Aggregation::PNorm, 8.0)),
        max_iterations: 300,
        ..l_settings()
    };
    let constrained = run(&problem, &settings).expect("min_volume s.t. stress");
    let entry = constrained.history.last().expect("history");
    let (constrained_peak, _) = peak(&problem, &constrained.density);
    let recorded_peak = entry.max_stress.expect("max stress recorded");
    assert!(entry.stress.expect("aggregate recorded").is_finite());
    assert!((recorded_peak - constrained_peak).abs() <= 1e-6 * constrained_peak);
    assert!(constrained_peak <= limit * (1.0 + STRESS_LIMIT_SLACK));
    assert!((constrained.history[0].volume - 1.0).abs() < 1e-12);
    assert!(entry.volume < 0.7, "volume {}", entry.volume);

    let equal = run(
        &problem,
        &SimpSettings {
            volume_fraction: entry.volume,
            ..l_settings()
        },
    )
    .expect("equal volume");
    let (equal_peak, _) = peak(&problem, &equal.density);
    assert!(
        constrained_peak <= 0.9 * equal_peak,
        "stress design {constrained_peak} vs compliance design {equal_peak}"
    );

    // A limit far below anything the loads allow ends in a clear error.
    let unreachable = SimpSettings {
        volume_fraction: 0.2,
        max_iterations: 25,
        stress: Some(constraint(0.02 * base_peak, Aggregation::PNorm, 8.0)),
        ..l_settings()
    };
    match run(&problem, &unreachable) {
        Err(FemError::TopologyInput { reason }) => assert!(
            reason.contains("was not met") && reason.contains("lowest max von Mises"),
            "{reason}"
        ),
        other => panic!("expected the unreachable limit to be refused, got {other:?}"),
    }
}

#[test]
fn a_binding_stress_limit_on_min_compliance_meets_both_limits() {
    let problem = l_bracket(CELLS);
    let base = run(&problem, &l_settings()).expect("compliance-only");
    let (base_peak, _) = peak(&problem, &base.density);
    let fraction = 0.55;
    let limit = 0.75 * base_peak;
    let unconstrained = run(
        &problem,
        &SimpSettings {
            volume_fraction: fraction,
            ..l_settings()
        },
    )
    .expect("compliance-only at 0.55");
    let (free_peak, _) = peak(&problem, &unconstrained.density);
    assert!(
        free_peak > limit * (1.0 + STRESS_LIMIT_SLACK),
        "not binding"
    );
    let constrained = run(
        &problem,
        &SimpSettings {
            volume_fraction: fraction,
            stress: Some(constraint(limit, Aggregation::PNorm, 8.0)),
            max_iterations: 300,
            ..l_settings()
        },
    )
    .expect("min_compliance + stress");
    let (constrained_peak, _) = peak(&problem, &constrained.density);
    let entry = constrained.history.last().expect("history");
    assert!(constrained_peak <= limit * (1.0 + STRESS_LIMIT_SLACK));
    assert!(entry.volume <= fraction * (1.0 + VOLUME_LIMIT_SLACK));
    let free_compliance = unconstrained.history.last().expect("history").compliance;
    assert!(entry.compliance >= 0.99 * free_compliance);
}

#[test]
fn malformed_stress_settings_are_refused() {
    let problem = l_bracket(CELLS);
    let refused = |settings: &SimpSettings| {
        matches!(run(&problem, settings), Err(FemError::TopologyInput { .. }))
    };
    let with = |stress: StressConstraint, rho_min: f64| SimpSettings {
        stress: Some(stress),
        rho_min,
        max_iterations: 2,
        ..l_settings()
    };
    // A limit no design exceeds, so only the malformed field can refuse a run.
    let valid = constraint(1e12, Aggregation::PNorm, 8.0);
    assert!(!refused(&with(valid, 1e-3)), "the valid baseline runs");
    for malformed in [
        StressConstraint {
            relaxation: 3.0,
            ..valid
        },
        StressConstraint {
            limit: -1.0,
            ..valid
        },
        StressConstraint {
            parameter: 0.5,
            ..valid
        },
        StressConstraint {
            alpha: 0.0,
            ..valid
        },
    ] {
        assert!(refused(&with(malformed, 1e-3)), "{malformed:?}");
    }
    assert!(refused(&with(valid, 0.0)), "rho_min = 0 with ρ^½");
    assert!(refused(&SimpSettings {
        objective: Objective::MinVolume,
        compliance_limit: 0.0,
        ..l_settings()
    }));
}

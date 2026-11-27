// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The Method of Moving Asymptotes on problems with known optima — ported
//! from the C++ engine's `engine/tests/topology_mma_validation.cpp`.

#![allow(
    clippy::expect_used,
    clippy::cast_precision_loss,
    reason = "test fixtures: a run that fails should abort the test; tiny index counts"
)]

use kofem_fem::topology::Mma;
use kofem_fem::FemError;

/// Run MMA with one constraint until max|Δx| < `tolerance`; returns the
/// final point and the iterations taken.
fn run(
    bounds: (Vec<f64>, Vec<f64>),
    start: Vec<f64>,
    max_iterations: usize,
    tolerance: f64,
    objective: impl Fn(&[f64]) -> (f64, Vec<f64>),
    constraint: impl Fn(&[f64]) -> (f64, Vec<f64>),
) -> (Vec<f64>, usize) {
    let count = start.len();
    let mut mma = Mma::new(count, 1, bounds.0, bounds.1, 0.2).expect("MMA");
    let mut point = start;
    for iteration in 1..=max_iterations {
        let (value, gradient) = objective(&point);
        let (constraint_value, constraint_gradient) = constraint(&point);
        let next = mma
            .update(
                &point,
                value,
                &gradient,
                &[constraint_value],
                &constraint_gradient,
            )
            .expect("MMA step");
        let change = next
            .iter()
            .zip(&point)
            .map(|(new, old)| (new - old).abs())
            .fold(0.0, f64::max);
        point = next;
        if change < tolerance {
            return (point, iteration);
        }
    }
    (point, max_iterations)
}

#[test]
fn reaches_the_lagrangian_optimum_of_a_separable_convex_problem() {
    // min Σ c_j/ρ_j s.t. Σρ_j ≤ V with V = Σ√c_j, so ρ_j* = √c_j.
    let weights = [1.0, 2.0, 3.0, 4.0, 5.0];
    let volume: f64 = weights.iter().map(|weight: &f64| weight.sqrt()).sum();
    let count = weights.len();
    let (point, _) = run(
        (vec![0.01; count], vec![10.0; count]),
        vec![volume / count as f64; count],
        200,
        1e-7,
        |point| {
            let value = weights
                .iter()
                .zip(point)
                .map(|(weight, rho)| weight / rho)
                .sum();
            let gradient = weights
                .iter()
                .zip(point)
                .map(|(weight, rho)| -weight / (rho * rho))
                .collect();
            (value, gradient)
        },
        |point| {
            (
                point.iter().sum::<f64>() / volume - 1.0,
                vec![1.0 / volume; point.len()],
            )
        },
    );
    for (rho, weight) in point.iter().zip(weights) {
        assert!(
            (rho - weight.sqrt()).abs() < 1e-4,
            "{rho} vs {}",
            weight.sqrt()
        );
    }
    assert!((point.iter().sum::<f64>() - volume).abs() < 1e-6);
}

fn solve_qp(start: Vec<f64>) -> (Vec<f64>, usize) {
    // min ρ1² + ρ2² s.t. ρ1 + ρ2 ≥ 1: optimum (½, ½).
    run(
        (vec![0.0; 2], vec![2.0; 2]),
        start,
        300,
        1e-8,
        |point| {
            (
                point[0] * point[0] + point[1] * point[1],
                vec![2.0 * point[0], 2.0 * point[1]],
            )
        },
        |point| (1.0 - point[0] - point[1], vec![-1.0, -1.0]),
    )
}

#[test]
fn solves_a_constrained_quadratic_from_feasible_and_infeasible_starts() {
    for start in [vec![1.0, 1.0], vec![0.05, 0.05]] {
        let (point, _) = solve_qp(start.clone());
        assert!((point[0] - 0.5).abs() < 1e-5, "from {start:?}: {point:?}");
        assert!((point[1] - 0.5).abs() < 1e-5, "from {start:?}: {point:?}");
    }
}

#[test]
fn two_runs_are_bit_identical() {
    let first = solve_qp(vec![1.0, 1.0]);
    let second = solve_qp(vec![1.0, 1.0]);
    assert_eq!(first, second);
}

#[test]
fn inconsistent_sizes_and_bounds_are_refused() {
    assert!(matches!(
        Mma::new(0, 1, vec![], vec![], 0.2),
        Err(FemError::TopologyInput { .. })
    ));
    assert!(matches!(
        Mma::new(2, 1, vec![0.0; 2], vec![1.0], 0.2),
        Err(FemError::TopologyInput { .. })
    ));
    assert!(matches!(
        Mma::new(2, 1, vec![0.0; 2], vec![0.0, 1.0], 0.2),
        Err(FemError::TopologyInput { .. })
    ));
    assert!(matches!(
        Mma::new(2, 1, vec![0.0; 2], vec![1.0; 2], 0.0),
        Err(FemError::TopologyInput { .. })
    ));
    let mut mma = Mma::new(2, 1, vec![0.0; 2], vec![1.0; 2], 0.2).expect("MMA");
    assert!(mma
        .update(&[0.5, 0.5], 0.0, &[1.0], &[0.0], &[1.0, 1.0])
        .is_err());
    assert!(mma
        .update(&[0.5, 0.5], 0.0, &[1.0, 1.0], &[0.0], &[1.0])
        .is_err());
}

/// The message of the error a non-finite entry at the second MMA step gives.
fn second_step_refusal(df0: [f64; 2], fval: [f64; 1], dfdx: [f64; 2]) -> String {
    let mut mma = Mma::new(2, 1, vec![0.0; 2], vec![1.0; 2], 0.2).expect("MMA");
    let first = mma
        .update(&[0.5, 0.5], 1.0, &[-1.0, -1.0], &[0.0], &[1.0, 1.0])
        .expect("a finite first step");
    let error = mma
        .update(&first, 1.0, &df0, &fval, &dfdx)
        .expect_err("a non-finite sensitivity must be refused");
    assert!(matches!(error, FemError::TopologyInput { .. }), "{error:?}");
    error.to_string()
}

#[test]
fn a_nan_objective_sensitivity_is_refused_with_its_iteration() {
    let reason = second_step_refusal([-1.0, f64::NAN], [0.0], [1.0, 1.0]);
    assert!(reason.contains("iteration 2"), "{reason}");
    assert!(reason.contains("variable 1"), "{reason}");
}

#[test]
fn a_non_finite_constraint_value_or_gradient_is_refused_with_its_iteration() {
    let reason = second_step_refusal([-1.0, -1.0], [f64::NAN], [1.0, 1.0]);
    assert!(reason.contains("iteration 2"), "{reason}");
    let reason = second_step_refusal([-1.0, -1.0], [0.0], [f64::INFINITY, 1.0]);
    assert!(reason.contains("iteration 2"), "{reason}");
    assert!(reason.contains("variable 0"), "{reason}");
}

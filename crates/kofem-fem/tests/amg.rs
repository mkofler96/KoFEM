// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

mod support;

use kofem_fem::{
    apply_dirichlet, assemble_stiffness, prepare_static, solve_static, AmgSettings, CgSettings,
    CsrMatrix, Dirichlet, FemError, Isotropic, PcgRun, PcgStatus, Preconditioner,
    PreconditionerChoice, SmoothedAggregation, StaticSolution, StoppingRule,
};
use support::{box_mesh, BoxMesh};

const SETTINGS: CgSettings = CgSettings {
    relative_tolerance: 1e-8,
    max_iterations: 20_000,
    stopping: StoppingRule::PreconditionedNorm,
};

/// Small enough that the test meshes get three or more levels.
const DEEP: AmgSettings = AmgSettings {
    strength_threshold: 0.0,
    coarse_size: 60,
    max_levels: 10,
};

fn steel() -> Isotropic {
    Isotropic::new(0, 210_000.0, 0.3).expect("valid material")
}

/// Cantilever along x: clamped at x = 0, a transverse tip load at x = length.
fn cantilever(built: &BoxMesh) -> (Vec<u32>, Vec<f64>) {
    let mut fixed = Vec::new();
    let mut tip = Vec::new();
    for (node, point) in built.vertices.iter().enumerate() {
        if point[0].abs() < 1e-12 {
            fixed.extend((0..3).map(|component| (3 * node + component) as u32));
        } else if (point[0] - built.size[0]).abs() < 1e-12 {
            tip.push(node);
        }
    }
    let mut forces = vec![0.0; 3 * built.vertices.len()];
    for &node in &tip {
        forces[3 * node + 2] = -100.0 / tip.len() as f64;
    }
    (fixed, forces)
}

fn solve(
    built: &BoxMesh,
    fixed: &[u32],
    forces: &[f64],
    choice: PreconditionerChoice,
) -> StaticSolution {
    let stiffness = assemble_stiffness(&built.mesh);
    let values = vec![0.0; fixed.len()];
    solve_static(
        &built.mesh,
        &stiffness,
        fixed,
        &values,
        forces,
        SETTINGS,
        choice,
    )
    .expect("solves")
}

fn max_relative_difference(lhs: &[f64], rhs: &[f64]) -> f64 {
    let peak = lhs.iter().fold(0.0f64, |acc, value| acc.max(value.abs()));
    lhs.iter()
        .zip(rhs)
        .fold(0.0f64, |acc, (left, right)| acc.max((left - right).abs()))
        / peak
}

#[test]
fn multigrid_matches_gauss_seidel_on_a_cantilever() {
    let built = box_mesh([16, 3, 3], [80.0, 10.0, 10.0], steel());
    let (fixed, forces) = cantilever(&built);
    let gauss_seidel = solve(
        &built,
        &fixed,
        &forces,
        PreconditionerChoice::SymmetricGaussSeidel,
    );
    let multigrid = solve(
        &built,
        &fixed,
        &forces,
        PreconditionerChoice::SmoothedAggregation(DEEP),
    );
    assert!(
        multigrid.levels.len() >= 3,
        "expected a multilevel hierarchy, got {:?}",
        multigrid.levels
    );
    let difference = max_relative_difference(&gauss_seidel.displacements, &multigrid.displacements);
    assert!(difference < 1e-6, "AMG and GS differ by {difference}");
    assert!(
        multigrid.iterations * 4 < gauss_seidel.iterations,
        "AMG took {} iterations, GS {}",
        multigrid.iterations,
        gauss_seidel.iterations
    );
}

/// Supports that hold only some components of a node (rollers) zero those
/// rows of the near-null space; the result must still match Gauss–Seidel.
#[test]
fn partially_constrained_nodes_are_handled() {
    let built = box_mesh([12, 3, 3], [60.0, 10.0, 10.0], steel());
    let mut fixed = Vec::new();
    for (node, point) in built.vertices.iter().enumerate() {
        if point[0].abs() < 1e-12 {
            // 3-2-1 support: x on the end face (x translation, rotation about
            // y and z), y along the edge y = 0 (y translation, rotation about
            // x), z at one corner (z translation).
            fixed.push((3 * node) as u32);
            if point[1].abs() < 1e-12 {
                fixed.push((3 * node + 1) as u32);
                if point[2].abs() < 1e-12 {
                    fixed.push((3 * node + 2) as u32);
                }
            }
        }
    }
    let mut forces = vec![0.0; 3 * built.vertices.len()];
    for (node, point) in built.vertices.iter().enumerate() {
        if (point[0] - built.size[0]).abs() < 1e-12 {
            forces[3 * node] = 10.0;
        }
    }
    let gauss_seidel = solve(
        &built,
        &fixed,
        &forces,
        PreconditionerChoice::SymmetricGaussSeidel,
    );
    let multigrid = solve(
        &built,
        &fixed,
        &forces,
        PreconditionerChoice::SmoothedAggregation(DEEP),
    );
    let difference = max_relative_difference(&gauss_seidel.displacements, &multigrid.displacements);
    assert!(difference < 1e-6, "AMG and GS differ by {difference}");
}

/// The point of multigrid: refining the mesh must not drive the iteration
/// count up the way it does for Gauss–Seidel.
#[test]
fn iterations_stay_bounded_under_refinement() {
    let mut counts = Vec::new();
    // Every mesh is larger than the default coarse size, so each gets a real
    // hierarchy rather than a direct solve.
    for refinement in [2, 3, 4] {
        let built = box_mesh(
            [8 * refinement, 2 * refinement, 2 * refinement],
            [80.0, 10.0, 10.0],
            steel(),
        );
        let (fixed, forces) = cantilever(&built);
        let solution = solve(
            &built,
            &fixed,
            &forces,
            PreconditionerChoice::SmoothedAggregation(AmgSettings::default()),
        );
        counts.push(solution.iterations);
    }
    assert!(
        counts.iter().all(|&count| count < 60) && counts[2] < counts[0] + 10,
        "AMG iteration counts under refinement: {counts:?}"
    );
}

fn eliminated_cantilever(built: &BoxMesh) -> (CsrMatrix, Vec<bool>) {
    let (fixed, _) = cantilever(built);
    let count = 3 * built.vertices.len();
    let constraints =
        Dirichlet::new(count, &fixed, &vec![0.0; fixed.len()]).expect("valid constraints");
    let mut matrix = assemble_stiffness(&built.mesh);
    let mut rhs = vec![0.0; count];
    apply_dirichlet(&mut matrix, &mut rhs, &constraints);
    let constrained = (0..count)
        .map(|dof| constraints.value(dof).is_some())
        .collect();
    (matrix, constrained)
}

/// CG needs a symmetric positive-definite preconditioner: the V-cycle with a
/// forward sweep down and a backward sweep up must satisfy (M⁻¹x, y) =
/// (x, M⁻¹y) and (M⁻¹x, x) > 0.
#[test]
fn v_cycle_is_symmetric_positive_definite() {
    let built = box_mesh([10, 3, 3], [50.0, 10.0, 10.0], steel());
    let (matrix, constrained) = eliminated_cantilever(&built);
    let mut amg =
        SmoothedAggregation::new(matrix.clone(), built.mesh.vertices(), &constrained, DEEP)
            .expect("hierarchy builds");
    assert!(amg.levels().len() >= 3, "levels {:?}", amg.levels());
    let size = matrix.rows();
    let first: Vec<f64> = (0..size)
        .map(|index| ((index * 7919) % 101) as f64 - 50.0)
        .collect();
    let second: Vec<f64> = (0..size)
        .map(|index| ((index * 104_729) % 89) as f64 - 44.0)
        .collect();
    let mut first_out = vec![0.0; size];
    let mut second_out = vec![0.0; size];
    amg.apply(&first, &mut first_out);
    amg.apply(&second, &mut second_out);
    let dot = |lhs: &[f64], rhs: &[f64]| -> f64 {
        lhs.iter().zip(rhs).map(|(left, right)| left * right).sum()
    };
    let forward = dot(&first_out, &second);
    let backward = dot(&first, &second_out);
    assert!(
        (forward - backward).abs() <= 1e-9 * forward.abs().max(backward.abs()),
        "V-cycle is not symmetric: {forward} vs {backward}"
    );
    assert!(dot(&first_out, &first) > 0.0);
    assert!(dot(&second_out, &second) > 0.0);
    let complexity = amg.operator_complexity();
    assert!(
        complexity > 1.0 && complexity < 2.0,
        "operator complexity {complexity}"
    );
}

#[test]
fn unconstrained_model_is_refused_at_setup() {
    let built = box_mesh([6, 2, 2], [30.0, 10.0, 10.0], steel());
    let stiffness = assemble_stiffness(&built.mesh);
    let mut forces = vec![0.0; stiffness.rows()];
    forces[2] = 1.0;
    let error = solve_static(
        &built.mesh,
        &stiffness,
        &[],
        &[],
        &forces,
        SETTINGS,
        PreconditionerChoice::SmoothedAggregation(DEEP),
    )
    .err();
    assert!(
        matches!(
            error,
            Some(FemError::CoarseNotPositiveDefinite { .. } | FemError::NotPositiveDefinite { .. })
        ),
        "got {error:?}"
    );
}

#[test]
fn mismatched_setup_input_is_refused() {
    let built = box_mesh([4, 2, 2], [20.0, 10.0, 10.0], steel());
    let (matrix, constrained) = eliminated_cantilever(&built);
    let points = built.mesh.vertices();
    assert!(matches!(
        SmoothedAggregation::new(matrix.clone(), &points[1..], &constrained, DEEP).err(),
        Some(FemError::AmgInput { .. })
    ));
    assert!(matches!(
        SmoothedAggregation::new(matrix, points, &constrained[1..], DEEP).err(),
        Some(FemError::AmgInput { .. })
    ));
}

/// The residual rule stops on ‖f − K·u‖ / ‖f‖, whatever the preconditioner:
/// both must actually reach it, and then agree with each other.
#[test]
fn residual_rule_reaches_the_same_force_balance_with_either_preconditioner() {
    let built = box_mesh([16, 3, 3], [80.0, 10.0, 10.0], steel());
    let (fixed, forces) = cantilever(&built);
    let tolerance = 1e-7;
    let settings = CgSettings {
        relative_tolerance: tolerance,
        max_iterations: 20_000,
        stopping: StoppingRule::ResidualNorm,
    };
    let stiffness = assemble_stiffness(&built.mesh);
    let values = vec![0.0; fixed.len()];
    let mut is_fixed = vec![false; forces.len()];
    for &dof in &fixed {
        is_fixed[dof as usize] = true;
    }
    let mut results = Vec::new();
    for choice in [
        PreconditionerChoice::SymmetricGaussSeidel,
        PreconditionerChoice::SmoothedAggregation(DEEP),
    ] {
        let solution = solve_static(
            &built.mesh,
            &stiffness,
            &fixed,
            &values,
            &forces,
            settings,
            choice,
        )
        .expect("solves");
        let mut product = vec![0.0; forces.len()];
        stiffness.mul_vec(&solution.displacements, &mut product);
        let (mut residual, mut load) = (0.0, 0.0);
        for dof in (0..forces.len()).filter(|&dof| !is_fixed[dof]) {
            residual += (forces[dof] - product[dof]).powi(2);
            load += forces[dof].powi(2);
        }
        let relative = (residual / load).sqrt();
        assert!(
            relative <= 1.01 * tolerance,
            "{choice:?}: true residual {relative} above {tolerance}"
        );
        results.push(solution.displacements);
    }
    let difference = max_relative_difference(&results[0], &results[1]);
    assert!(difference < 1e-6, "GS and AMG differ by {difference}");
}

/// A run advanced in small steps (as the browser drives it, to log progress
/// and ask before going past the budget) ends exactly where one call does.
#[test]
fn stepwise_run_matches_a_single_solve() {
    let built = box_mesh([12, 3, 3], [60.0, 10.0, 10.0], steel());
    let (fixed, forces) = cantilever(&built);
    let stiffness = assemble_stiffness(&built.mesh);
    let values = vec![0.0; fixed.len()];
    let choice = PreconditionerChoice::SmoothedAggregation(DEEP);
    let mut prepared = prepare_static(&built.mesh, &stiffness, &fixed, &values, &forces, choice)
        .expect("prepares");
    let mut run = PcgRun::start(
        prepared.system.as_mut(),
        &prepared.rhs,
        1e-8,
        StoppingRule::ResidualNorm,
    )
    .expect("starts");
    let mut calls = 0;
    while run
        .advance(prepared.system.as_mut(), run.iterations() + 3)
        .expect("advances")
        == PcgStatus::Running
    {
        calls += 1;
        assert!(calls < 1000, "never converged");
    }
    assert!(calls > 1, "the run should have taken several steps");
    let iterations = run.iterations();
    let (stepwise, _) = run.into_solution().expect("converged");

    let settings = CgSettings {
        relative_tolerance: 1e-8,
        max_iterations: 1000,
        stopping: StoppingRule::ResidualNorm,
    };
    let single = solve_static(
        &built.mesh,
        &stiffness,
        &fixed,
        &values,
        &forces,
        settings,
        choice,
    )
    .expect("solves");
    assert_eq!(single.iterations, iterations);
    assert_eq!(single.displacements, stepwise);
}

/// The continuation test offers more iterations to a run that is still
/// converging, never to one that has converged, and refuses to hand out a
/// solution before convergence.
#[test]
fn continuation_is_offered_only_while_descending() {
    let built = box_mesh([16, 3, 3], [80.0, 10.0, 10.0], steel());
    let (fixed, forces) = cantilever(&built);
    let stiffness = assemble_stiffness(&built.mesh);
    let mut prepared = prepare_static(
        &built.mesh,
        &stiffness,
        &fixed,
        &vec![0.0; fixed.len()],
        &forces,
        PreconditionerChoice::SymmetricGaussSeidel,
    )
    .expect("prepares");
    let mut run = PcgRun::start(
        prepared.system.as_mut(),
        &prepared.rhs,
        1e-10,
        StoppingRule::ResidualNorm,
    )
    .expect("starts");
    // Gauss–Seidel on a slender beam: far from converged after 60 iterations,
    // but still clearly descending.
    assert_eq!(
        run.advance(prepared.system.as_mut(), 60).expect("advances"),
        PcgStatus::Running
    );
    assert!(
        !run.still_descending(100),
        "fewer than 100 residuals recorded"
    );
    assert!(run.still_descending(30));
    let unfinished = run.clone().into_solution().err();
    assert!(matches!(unfinished, Some(FemError::NotConverged { .. })));
    run.advance(prepared.system.as_mut(), 100_000)
        .expect("advances");
    assert!(run.is_converged());
    assert!(!run.still_descending(30));
}

/// A fully constrained model leaves nothing to aggregate, so the whole fine
/// matrix is the coarsest level. It must not be factored densely (a large
/// model would need gigabytes); relaxation solves its identity rows exactly.
#[test]
fn fully_constrained_model_solves_without_a_dense_factor() {
    let built = box_mesh([30, 4, 4], [60.0, 8.0, 8.0], steel());
    let dof_count = 3 * built.vertices.len();
    assert!(
        dof_count > 2000,
        "the fine level must exceed the dense limit"
    );
    let fixed: Vec<u32> = (0..dof_count).map(|dof| dof as u32).collect();
    let values: Vec<f64> = (0..dof_count).map(|dof| 1e-3 * (dof % 7) as f64).collect();
    let stiffness = assemble_stiffness(&built.mesh);
    let settings = CgSettings {
        relative_tolerance: 1e-10,
        max_iterations: 10,
        stopping: StoppingRule::ResidualNorm,
    };
    let solution = solve_static(
        &built.mesh,
        &stiffness,
        &fixed,
        &values,
        &vec![0.0; dof_count],
        settings,
        PreconditionerChoice::SmoothedAggregation(AmgSettings::default()),
    )
    .expect("solves");
    assert_eq!(solution.levels.len(), 1, "nothing to coarsen");
    assert!(solution.iterations <= 1);
    assert_eq!(solution.displacements, values);
}

/// When coarsening stops above the dense limit, the coarsest level is relaxed
/// instead of factored, and the solve still matches Gauss–Seidel.
#[test]
fn large_coarsest_level_is_relaxed_and_still_converges() {
    let built = box_mesh([30, 4, 4], [60.0, 8.0, 8.0], steel());
    let (fixed, forces) = cantilever(&built);
    let no_coarsening = AmgSettings {
        coarse_size: usize::MAX,
        ..AmgSettings::default()
    };
    let relaxed = solve(
        &built,
        &fixed,
        &forces,
        PreconditionerChoice::SmoothedAggregation(no_coarsening),
    );
    assert_eq!(relaxed.levels.len(), 1);
    assert!(relaxed.levels[0].unknowns > 2000);
    let gauss_seidel = solve(
        &built,
        &fixed,
        &forces,
        PreconditionerChoice::SymmetricGaussSeidel,
    );
    let difference = max_relative_difference(&gauss_seidel.displacements, &relaxed.displacements);
    assert!(
        difference < 1e-6,
        "relaxed AMG and GS differ by {difference}"
    );
}

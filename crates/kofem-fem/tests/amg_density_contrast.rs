// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Multigrid on SIMP-like systems: solid material with near-void pockets whose
//! stiffness is 1e-9 of the solid (KOF-341). A node inside a pocket couples
//! only weakly to the solid nodes around it, which used to leave it as a
//! single-node aggregate on every level, so coarsening stalled.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

mod support;

use kofem_fem::{
    apply_dirichlet, assemble_stiffness, solve_pcg, solve_pcg_with, AmgSettings, CgSettings,
    CsrMatrix, Dirichlet, FemError, Isotropic, SmoothedAggregation, StoppingRule, TetMesh,
};
use support::box_mesh;

const SETTINGS: CgSettings = CgSettings {
    relative_tolerance: 1e-8,
    max_iterations: 20_000,
    stopping: StoppingRule::ResidualNorm,
};

/// Default strength threshold with a small coarse size, so the test mesh
/// would need several levels and a stalled hierarchy shows.
fn deep_default() -> AmgSettings {
    AmgSettings {
        coarse_size: 60,
        ..AmgSettings::default()
    }
}

const CELLS: [usize; 3] = [32, 8, 8];
const SIZE: [f64; 3] = [32.0, 8.0, 8.0];
const SOLID: f64 = 210_000.0;

/// A cantilever along x (clamped at x = 0, tip load at x = 32) with 2×2×2-cell
/// void pockets on a 4-cell lattice. `void_ratio` is the void-to-solid modulus ratio; 1 gives
/// a uniform body with the same mesh.
struct System {
    matrix: CsrMatrix,
    rhs: Vec<f64>,
    vertices: Vec<[f64; 3]>,
    constrained: Vec<bool>,
}

fn system(void_ratio: f64) -> System {
    let base = box_mesh(
        CELLS,
        SIZE,
        Isotropic::new(0, SOLID, 0.3).expect("valid material"),
    );
    let vertices = base.vertices.clone();
    let length = base.size[0];
    let tets: Vec<u32> = base.mesh.tets().iter().flatten().copied().collect();
    // Cells 1 and 2 of every 4 along each axis.
    let in_pocket = |coordinate: f64| (1.0..3.0).contains(&coordinate.rem_euclid(4.0));
    let material_of_tet: Vec<u32> = base
        .mesh
        .tets()
        .iter()
        .map(|tet| {
            let centroid = tet.iter().fold([0.0; 3], |sum, &vertex| {
                let point = vertices[vertex as usize];
                [
                    sum[0] + point[0] / 4.0,
                    sum[1] + point[1] / 4.0,
                    sum[2] + point[2] / 4.0,
                ]
            });
            u32::from(centroid.iter().all(|&value| in_pocket(value)))
        })
        .collect();
    let materials = vec![
        Isotropic::new(0, SOLID, 0.3).expect("valid solid"),
        Isotropic::new(1, SOLID * void_ratio, 0.3).expect("valid void"),
    ];
    let flat: Vec<f64> = vertices.iter().flatten().copied().collect();
    let mesh = TetMesh::new(&flat, &tets, &material_of_tet, materials).expect("valid mesh");

    let count = 3 * vertices.len();
    let mut fixed = Vec::new();
    let mut tip = Vec::new();
    for (node, point) in vertices.iter().enumerate() {
        if point[0].abs() < 1e-12 {
            fixed.extend((0..3).map(|component| (3 * node + component) as u32));
        } else if (point[0] - length).abs() < 1e-12 {
            tip.push(node);
        }
    }
    let mut rhs = vec![0.0; count];
    for &node in &tip {
        rhs[3 * node + 2] = -100.0 / tip.len() as f64;
    }
    let constraints =
        Dirichlet::new(count, &fixed, &vec![0.0; fixed.len()]).expect("valid constraints");
    let mut matrix = assemble_stiffness(&mesh);
    apply_dirichlet(&mut matrix, &mut rhs, &constraints);
    let constrained = (0..count)
        .map(|dof| constraints.value(dof).is_some())
        .collect();
    System {
        matrix,
        rhs,
        vertices,
        constrained,
    }
}

fn max_relative_difference(lhs: &[f64], rhs: &[f64]) -> f64 {
    let peak = lhs.iter().fold(0.0f64, |acc, value| acc.max(value.abs()));
    lhs.iter()
        .zip(rhs)
        .fold(0.0f64, |acc, (left, right)| acc.max((left - right).abs()))
        / peak
}

/// Nodes inside the void pockets have no strong coupling. They must not stay
/// behind as single-node aggregates: the hierarchy keeps coarsening, stays
/// cheap, and the solve still matches Gauss–Seidel.
#[test]
fn void_pockets_do_not_stall_coarsening() {
    let built = system(1e-9);
    let mut amg = SmoothedAggregation::new(
        built.matrix.clone(),
        &built.vertices,
        &built.constrained,
        deep_default(),
    )
    .expect("hierarchy builds");
    let levels = amg.levels();
    let coarsest = levels.last().expect("at least one level").unknowns;
    assert!(
        coarsest <= deep_default().coarse_size,
        "coarsening stalled at {coarsest} unknowns: {levels:?}"
    );
    let complexity = amg.operator_complexity();
    assert!(complexity < 2.0, "operator complexity {complexity}");

    let (multigrid, outcome) =
        solve_pcg_with(&mut amg, &built.rhs, SETTINGS).expect("multigrid solves");
    let (gauss_seidel, reference) =
        solve_pcg(&built.matrix, &built.rhs, SETTINGS).expect("Gauss–Seidel solves");
    assert!(
        outcome.iterations * 4 < reference.iterations,
        "multigrid took {} iterations, Gauss–Seidel {}",
        outcome.iterations,
        reference.iterations
    );
    let difference = max_relative_difference(&gauss_seidel, &multigrid);
    assert!(difference < 1e-6, "multigrid and GS differ by {difference}");
}

/// The topology-optimization preset aggregates by the sparsity pattern alone,
/// so its hierarchy does not depend on the densities.
#[test]
fn topology_optimization_preset_ignores_the_densities() {
    let uniform = system(1.0);
    let pockets = system(1e-9);
    let settings = AmgSettings {
        coarse_size: 60,
        ..AmgSettings::topology_optimization()
    };
    let levels = |built: &System| {
        SmoothedAggregation::new(
            built.matrix.clone(),
            &built.vertices,
            &built.constrained,
            settings,
        )
        .expect("hierarchy builds")
        .levels()
        .iter()
        .map(|level| level.unknowns)
        .collect::<Vec<_>>()
    };
    assert_eq!(levels(&uniform), levels(&pockets));
}

/// A hierarchy built for one density field still preconditions the next
/// one once its finest matrix is replaced: the V-cycle stays symmetric
/// positive definite and the solve matches Gauss–Seidel.
#[test]
fn replaced_fine_matrix_reuses_the_hierarchy() {
    let uniform = system(1.0);
    let pockets = system(1e-3);
    let mut amg = SmoothedAggregation::new(
        uniform.matrix.clone(),
        &uniform.vertices,
        &uniform.constrained,
        AmgSettings {
            coarse_size: 60,
            ..AmgSettings::topology_optimization()
        },
    )
    .expect("hierarchy builds");
    amg.replace_fine_matrix(pockets.matrix.clone())
        .expect("same size");

    let size = pockets.matrix.rows();
    let first: Vec<f64> = (0..size)
        .map(|index| ((index * 7919) % 101) as f64 - 50.0)
        .collect();
    let second: Vec<f64> = (0..size)
        .map(|index| ((index * 104_729) % 89) as f64 - 44.0)
        .collect();
    let mut first_out = vec![0.0; size];
    let mut second_out = vec![0.0; size];
    kofem_fem::Preconditioner::apply(&mut amg, &first, &mut first_out);
    kofem_fem::Preconditioner::apply(&mut amg, &second, &mut second_out);
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

    let (reused, _) = solve_pcg_with(&mut amg, &pockets.rhs, SETTINGS).expect("reused solves");
    let (gauss_seidel, _) =
        solve_pcg(&pockets.matrix, &pockets.rhs, SETTINGS).expect("Gauss–Seidel solves");
    let difference = max_relative_difference(&gauss_seidel, &reused);
    assert!(
        difference < 1e-6,
        "reused AMG and GS differ by {difference}"
    );
}

#[test]
fn replacement_of_another_size_is_refused() {
    let built = system(1.0);
    let mut amg = SmoothedAggregation::new(
        built.matrix.clone(),
        &built.vertices,
        &built.constrained,
        AmgSettings::default(),
    )
    .expect("hierarchy builds");
    let smaller = box_mesh(
        [4, 2, 2],
        [4.0, 2.0, 2.0],
        Isotropic::new(0, SOLID, 0.3).expect("valid material"),
    );
    let error = amg
        .replace_fine_matrix(assemble_stiffness(&smaller.mesh))
        .expect_err("size mismatch");
    assert!(matches!(error, FemError::AmgInput { .. }), "{error}");
}

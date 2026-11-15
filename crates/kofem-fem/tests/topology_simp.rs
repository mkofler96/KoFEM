// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The SIMP core: the per-element stiffness cache, the penalized solve, the
//! compliance and its self-adjoint sensitivity — ported from the C++ engine's
//! `engine/tests/topology_simp_validation.cpp`.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

mod topology_support;

use kofem_fem::topology::{
    simp_scale, simp_scale_deriv, SimpModel, SimpPreconditioner, SimpSolver,
};
use kofem_fem::{
    assemble_stiffness, solve_static, CgSettings, ElementOrder, FemError, Isotropic,
    PreconditionerChoice, StoppingRule, TetMesh,
};
use topology_support::{cantilever, tight_solver, unit_material};

const PENALTY: f64 = 3.0;
const EMIN: f64 = 1e-9;

#[test]
fn simp_scale_spans_the_floor_to_full_material() {
    assert!((simp_scale(0.0, PENALTY, EMIN) - EMIN).abs() < 1e-18);
    assert!((simp_scale(1.0, PENALTY, EMIN) - 1.0).abs() < 1e-15);
    let rho: f64 = 0.4;
    let expected = EMIN + rho.powf(PENALTY) * (1.0 - EMIN);
    assert!((simp_scale(rho, PENALTY, EMIN) - expected).abs() < 1e-15);
    let expected_deriv = PENALTY * rho.powf(PENALTY - 1.0) * (1.0 - EMIN);
    assert!((simp_scale_deriv(rho, PENALTY, EMIN) - expected_deriv).abs() < 1e-15);
}

#[test]
fn element_volumes_sum_to_the_box_and_centroids_are_vertex_means() {
    let problem = cantilever();
    let model = problem.model(tight_solver());
    let total: f64 = model.volumes().iter().sum();
    assert!((total - 6.0).abs() < 1e-9, "Σ V_e = {total}");
    let first = problem.mesh.element_nodes(0);
    let mean: [f64; 3] = std::array::from_fn(|axis| {
        first
            .iter()
            .map(|&node| problem.vertices[node as usize][axis])
            .sum::<f64>()
            / 4.0
    });
    for (got, want) in model.centroids()[0].iter().zip(mean) {
        assert!((got - want).abs() < 1e-15);
    }
}

#[test]
fn full_material_reproduces_the_plain_static_compliance() {
    let problem = cantilever();
    let mut model = problem.model(tight_solver());
    let rho = vec![1.0; model.element_count()];
    let evaluation = model
        .evaluate_compliance(&rho, PENALTY, EMIN)
        .expect("SIMP solve");

    // Reference: the ordinary static solve of the same model (E scaled by s(1)).
    let stiffness = assemble_stiffness(&problem.mesh);
    let zeros = vec![0.0; problem.fixed.len()];
    let solution = solve_static(
        &problem.mesh,
        &stiffness,
        &problem.fixed,
        &zeros,
        &problem.forces,
        CgSettings {
            relative_tolerance: 1e-12,
            max_iterations: 20_000,
            stopping: StoppingRule::ResidualNorm,
        },
        PreconditionerChoice::SymmetricGaussSeidel,
    )
    .expect("static solve");
    let reference: f64 = problem
        .forces
        .iter()
        .zip(&solution.displacements)
        .map(|(force, displacement)| force * displacement)
        .sum::<f64>()
        / simp_scale(1.0, PENALTY, EMIN);
    let relative = (evaluation.compliance - reference).abs() / reference;
    assert!(
        relative < 1e-9,
        "c = {} vs static fᵀu = {reference}",
        evaluation.compliance
    );
    for (got, want) in evaluation.displacements.iter().zip(&solution.displacements) {
        assert!((got - want).abs() <= 1e-8 * want.abs().max(1e-6));
    }
}

#[test]
fn compliance_scales_exactly_with_the_simp_modulus() {
    let mut model = cantilever().model(tight_solver());
    let count = model.element_count();
    let full = model
        .evaluate_compliance(&vec![1.0; count], PENALTY, EMIN)
        .expect("solve at 1")
        .compliance;
    let half = model
        .evaluate_compliance(&vec![0.5; count], PENALTY, EMIN)
        .expect("solve at 0.5")
        .compliance;
    let expected = full / simp_scale(0.5, PENALTY, EMIN);
    assert!(
        (half - expected).abs() <= 1e-9 * expected,
        "{half} vs {expected}"
    );
}

fn assert_sensitivities_match_finite_differences(mut model: SimpModel) {
    let count = model.element_count();
    let rho = vec![0.5; count];
    let evaluation = model
        .evaluate_compliance(&rho, PENALTY, EMIN)
        .expect("SIMP solve");
    assert!(evaluation.dcompliance.iter().all(|&slope| slope <= 0.0));
    assert!(evaluation.strain_energy.iter().all(|&energy| energy >= 0.0));
    let step = 1e-4;
    for element in [0, count / 4, count / 2, 3 * count / 4, count - 1] {
        let mut plus = rho.clone();
        let mut minus = rho.clone();
        plus[element] += step;
        minus[element] -= step;
        let upper = model
            .evaluate_compliance(&plus, PENALTY, EMIN)
            .expect("+h")
            .compliance;
        let lower = model
            .evaluate_compliance(&minus, PENALTY, EMIN)
            .expect("−h")
            .compliance;
        let difference = (upper - lower) / (2.0 * step);
        let analytic = evaluation.dcompliance[element];
        let relative = (difference - analytic).abs() / analytic.abs().max(1e-30);
        assert!(
            relative < 1e-5,
            "element {element}: FD {difference} vs analytic {analytic} (rel {relative:e})"
        );
    }
}

#[test]
fn compliance_sensitivity_matches_central_differences_on_tets() {
    assert_sensitivities_match_finite_differences(cantilever().model(tight_solver()));
}

/// A 6×1×1 cantilever of hexahedra and tetrahedra: the left half hexes.
fn mixed_cantilever() -> (TetMesh, Vec<u32>, Vec<f64>) {
    let (nx, ny, nz) = (6usize, 2usize, 2usize);
    let index = |ix: usize, iy: usize, iz: usize| (ix + (nx + 1) * (iy + (ny + 1) * iz)) as u32;
    let mut vertices = Vec::new();
    for iz in 0..=nz {
        for iy in 0..=ny {
            for ix in 0..=nx {
                vertices.extend([ix as f64, iy as f64 / ny as f64, iz as f64 / nz as f64]);
            }
        }
    }
    let mut tets = Vec::new();
    let mut hexes = Vec::new();
    for iz in 0..nz {
        for iy in 0..ny {
            for ix in 0..nx {
                let corner = |bits: usize| {
                    index(
                        ix + (bits & 1),
                        iy + ((bits >> 1) & 1),
                        iz + ((bits >> 2) & 1),
                    )
                };
                if ix < nx / 2 {
                    // MFEM / CHEXA order: bottom face counter-clockwise, then top.
                    hexes.extend([0, 1, 3, 2, 4, 5, 7, 6].map(corner));
                } else {
                    for tet in [
                        [0, 1, 3, 7],
                        [0, 3, 2, 7],
                        [0, 2, 6, 7],
                        [0, 6, 4, 7],
                        [0, 4, 5, 7],
                        [0, 5, 1, 7],
                    ] {
                        tets.extend(tet.map(corner));
                    }
                }
            }
        }
    }
    let elements = tets.len() / 4 + hexes.len() / 8;
    let mesh = TetMesh::with_hexahedra(
        &vertices,
        &tets,
        &hexes,
        &vec![0; elements],
        vec![unit_material()],
    )
    .expect("valid mixed mesh");
    let mut fixed = Vec::new();
    let mut tip = Vec::new();
    for vertex in 0..vertices.len() / 3 {
        let along = vertices[3 * vertex];
        if along < 1e-9 {
            fixed.extend((0..3).map(|component| (3 * vertex + component) as u32));
        }
        if along > nx as f64 - 1e-9 {
            tip.push(vertex);
        }
    }
    let mut forces = vec![0.0; vertices.len()];
    for &vertex in &tip {
        forces[3 * vertex + 1] = -1.0 / tip.len() as f64;
    }
    (mesh, fixed, forces)
}

#[test]
fn compliance_sensitivity_matches_central_differences_on_hexes() {
    let (mesh, fixed, forces) = mixed_cantilever();
    let model = SimpModel::new(mesh, &fixed, forces, tight_solver()).expect("valid model");
    let total: f64 = model.volumes().iter().sum();
    assert!((total - 6.0).abs() < 1e-9, "Σ V_e = {total}");
    assert_sensitivities_match_finite_differences(model);
}

#[test]
fn multigrid_and_gauss_seidel_give_the_same_compliance() {
    let problem = cantilever();
    let mut gauss_seidel = problem.model(tight_solver());
    let mut amg = problem.model(SimpSolver {
        preconditioner: SimpPreconditioner::Amg,
        relative_tolerance: 1e-12,
    });
    // A sequence of designs drifting towards void, so the hierarchy built for
    // the first one is reused (and rebuilt) on the later ones.
    for step in 0..8 {
        let density: Vec<f64> = (0..problem.mesh.element_count())
            .map(|element| {
                let base = 0.2 + 0.8 * ((element * 37) % 11) as f64 / 10.0;
                (base * 0.8_f64.powi(step)).max(1e-3)
            })
            .collect();
        let reference = gauss_seidel
            .evaluate_compliance(&density, PENALTY, EMIN)
            .expect("GS")
            .compliance;
        let multigrid = amg
            .evaluate_compliance(&density, PENALTY, EMIN)
            .expect("AMG")
            .compliance;
        assert!(
            (multigrid - reference).abs() <= 1e-8 * reference,
            "design {step}: AMG {multigrid} vs GS {reference}"
        );
    }
}

#[test]
fn a_model_without_supports_or_load_or_with_quadratic_elements_is_refused() {
    let problem = cantilever();
    let no_support = SimpModel::new(
        problem.mesh.clone(),
        &[],
        problem.forces.clone(),
        tight_solver(),
    );
    assert!(matches!(no_support, Err(FemError::TopologyInput { .. })));

    let no_load = SimpModel::new(
        problem.mesh.clone(),
        &problem.fixed,
        vec![0.0; problem.forces.len()],
        tight_solver(),
    );
    assert!(matches!(no_load, Err(FemError::TopologyInput { .. })));

    let quadratic = problem
        .mesh
        .clone()
        .with_order(ElementOrder::Quadratic)
        .expect("quadratic mesh");
    let forces = vec![0.0; quadratic.dof_count()];
    let refused = SimpModel::new(quadratic, &problem.fixed, forces, tight_solver());
    assert!(matches!(refused, Err(FemError::TopologyInput { .. })));

    let short = SimpModel::new(
        problem.mesh.clone(),
        &problem.fixed,
        vec![1.0],
        tight_solver(),
    );
    assert!(matches!(short, Err(FemError::ForceLength { .. })));
}

#[test]
fn a_density_field_of_the_wrong_length_is_refused() {
    let mut model = cantilever().model(tight_solver());
    let result = model.evaluate_compliance(&[0.5; 3], PENALTY, EMIN);
    assert!(matches!(result, Err(FemError::TopologyInput { .. })));
}

#[test]
fn per_element_materials_scale_the_stiffness() {
    // Two materials: the same model with every element twice as stiff halves
    // the compliance.
    let problem = cantilever();
    let soft = problem
        .model(tight_solver())
        .evaluate_compliance(&vec![1.0; problem.mesh.element_count()], PENALTY, EMIN)
        .expect("soft")
        .compliance;
    let flat: Vec<f64> = problem.vertices.iter().flatten().copied().collect();
    let tets: Vec<u32> = (0..problem.mesh.element_count())
        .flat_map(|element| problem.mesh.element_nodes(element).to_vec())
        .collect();
    let stiff_mesh = TetMesh::new(
        &flat,
        &tets,
        &vec![1; tets.len() / 4],
        vec![
            unit_material(),
            Isotropic::new(1, 2.0, 0.3).expect("valid material"),
        ],
    )
    .expect("valid mesh");
    let stiff = SimpModel::new(
        stiff_mesh,
        &problem.fixed,
        problem.forces.clone(),
        tight_solver(),
    )
    .expect("valid model")
    .evaluate_compliance(&vec![1.0; problem.mesh.element_count()], PENALTY, EMIN)
    .expect("stiff")
    .compliance;
    assert!((stiff - soft / 2.0).abs() <= 1e-9 * soft);
}

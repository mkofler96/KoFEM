// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The reaction–diffusion level-set optimizer, ported from the C++ engine's
//! `engine/tests/topology_levelset_validation.cpp`: the exact tet volume
//! fraction of {φ > 0}, the MBB half-beam (volume, convergence, a crisp
//! design, compliance against SIMP), the returned level set, passive regions,
//! streaming, determinism and input validation.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::float_cmp,
    reason = "exact pins and bitwise-identical reruns are compared exactly; test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

mod topology_support;

use std::sync::OnceLock;

use kofem_fem::topology::{
    level_set_density, mean_element_size, optimize, optimize_level_set, tet_positive_fraction,
    LevelSetResult, LevelSetSettings, SimpSettings, SimpSolver,
};
use kofem_fem::{FemError, TetMesh};
use topology_support::{mbb_with_cells, unit_material, Problem};

fn near(value: f64, expected: f64, tol: f64) -> bool {
    (value - expected).abs() <= tol
}

fn problem() -> &'static Problem {
    static PROBLEM: OnceLock<Problem> = OnceLock::new();
    PROBLEM.get_or_init(|| mbb_with_cells(36, 12))
}

fn base_settings() -> LevelSetSettings {
    LevelSetSettings {
        volume_fraction: 0.5,
        regularization_length: 0.0,
        max_iterations: 120,
        tolerance: 0.01,
        ..LevelSetSettings::default()
    }
}

fn run(settings: &LevelSetSettings) -> Result<LevelSetResult, FemError> {
    optimize_level_set(problem().model(SimpSolver::default()), settings, |_, _| {})
}

/// The base run, shared by the tests that only read it.
fn base_run() -> &'static LevelSetResult {
    static RESULT: OnceLock<LevelSetResult> = OnceLock::new();
    RESULT.get_or_init(|| run(&base_settings()).expect("the MBB level-set run succeeds"))
}

fn volumes() -> Vec<f64> {
    problem().model(SimpSolver::default()).volumes().to_vec()
}

fn volume_fraction(density: &[f64]) -> f64 {
    let volumes = volumes();
    let total: f64 = volumes.iter().sum();
    density
        .iter()
        .zip(&volumes)
        .map(|(rho, volume)| rho * volume)
        .sum::<f64>()
        / total
}

// ── (1) Exact tet volume fraction ───────────────────────────────────────────

#[test]
fn tet_fraction_of_the_four_sign_patterns() {
    assert!(near(
        tet_positive_fraction([1.0, 2.0, 3.0, 4.0]),
        1.0,
        1e-12
    ));
    assert!(near(
        tet_positive_fraction([-1.0, -2.0, 0.0, -4.0]),
        0.0,
        1e-12
    ));
    assert!(near(
        tet_positive_fraction([1.0, -1.0, -1.0, -1.0]),
        0.125,
        1e-12
    ));
    assert!(near(
        tet_positive_fraction([-1.0, 1.0, 1.0, 1.0]),
        0.875,
        1e-12
    ));
    assert!(near(
        tet_positive_fraction([1.0, 1.0, -1.0, -1.0]),
        0.5,
        1e-12
    ));
}

#[test]
fn tet_fraction_is_exact_for_a_linear_field() {
    // φ = x − 0.3 on the reference tet: vol{x > 0.3} = 0.7³.
    let fraction = tet_positive_fraction([-0.3, 0.7, -0.3, -0.3]);
    assert!(near(fraction, 0.343, 1e-12), "{fraction}");
}

#[test]
fn tet_fraction_and_its_complement_sum_to_one() {
    let samples = [
        [0.3, -0.7, 0.1, -0.2],
        [0.9, 0.4, -0.05, -0.6],
        [-0.2, 0.8, -0.9, 0.35],
        [0.01, -0.02, 0.03, -0.04],
        [1.0, 1.0, -1.0, 0.5],
    ];
    for sample in samples {
        let sum = tet_positive_fraction(sample) + tet_positive_fraction(sample.map(|phi| -phi));
        assert!(near(sum, 1.0, 1e-12), "f(φ) + f(−φ) = {sum} for {sample:?}");
    }
}

#[test]
fn hex_kuhn_split_is_exact_for_a_linear_field() {
    let corners: [[f64; 3]; 8] = [
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [1.0, 1.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 1.0],
        [1.0, 1.0, 1.0],
        [0.0, 1.0, 1.0],
    ];
    let flat: Vec<f64> = corners.iter().flatten().copied().collect();
    let mesh = TetMesh::with_hexahedra(
        &flat,
        &[],
        &[0, 1, 2, 3, 4, 5, 6, 7],
        &[0],
        vec![unit_material()],
    )
    .expect("unit hex");
    let phi: Vec<f64> = corners.iter().map(|corner| corner[0] - 0.25).collect();
    let rho = level_set_density(&mesh, &phi).expect("density of a hex");
    assert_eq!(rho.len(), 1);
    assert!(near(rho[0], 0.75, 1e-12), "{}", rho[0]);
}

#[test]
fn density_rejects_a_level_set_of_the_wrong_length() {
    let mesh = &problem().mesh;
    assert!(level_set_density(mesh, &[0.0; 3]).is_err());
}

// ── (2)–(4) MBB half-beam ───────────────────────────────────────────────────

#[test]
fn mbb_converges_from_full_material_to_the_volume_target() {
    let result = base_run();
    let last = result.history.last().expect("a history");
    assert!(result.converged, "{} iterations", result.iterations);
    assert!((last.volume - 0.5).abs() < 0.01, "volume {}", last.volume);
    assert!(near(result.history[0].volume, 1.0, 1e-12));
}

#[test]
fn mbb_design_is_crisper_than_simp_and_competitive_in_compliance() {
    let result = base_run();
    let volumes = volumes();
    let total: f64 = volumes.iter().sum();
    let simp = optimize(
        problem().model(SimpSolver::default()),
        &SimpSettings {
            volume_fraction: 0.5,
            filter_radius: 1.5 * mean_element_size(&volumes).expect("element size"),
            max_iterations: 120,
            ..SimpSettings::default()
        },
        |_, _| {},
    )
    .expect("the SIMP reference run");
    let grayness = |rho: &[f64]| {
        rho.iter()
            .zip(&volumes)
            .map(|(rho, volume)| 4.0 * rho * (1.0 - rho) * volume)
            .sum::<f64>()
            / total
    };
    let (level_set, reference) = (grayness(&result.density), grayness(&simp.density));
    assert!(
        level_set < reference,
        "grayness {level_set} vs SIMP {reference}"
    );

    let compliance = result.history.last().expect("history").compliance;
    let simp_compliance = simp.history.last().expect("history").compliance;
    assert!(
        compliance < 1.15 * simp_compliance,
        "level set c = {compliance}, SIMP c = {simp_compliance}"
    );
}

#[test]
fn returned_level_set_is_per_vertex_bounded_and_matches_the_density() {
    let result = base_run();
    let mesh = &problem().mesh;
    assert_eq!(result.level_set.len(), mesh.vertex_count());
    assert!(result
        .level_set
        .iter()
        .all(|phi| (-1.0..=1.0).contains(phi)));
    let rho = level_set_density(mesh, &result.level_set).expect("density");
    assert_eq!(rho, result.density);
    let last = result.history.last().expect("history");
    assert!(near(volume_fraction(&result.density), last.volume, 1e-12));
}

// ── (5) Passive regions, streaming, determinism, validation ────────────────

#[test]
fn passive_regions_are_honoured() {
    let problem = problem();
    let settings = LevelSetSettings {
        passive_solid: problem.elements_in_box([1.0, 1.2, -1.0], [2.5, 2.0, 1.0]),
        passive_void: problem.elements_in_box([3.3, 0.7, -1.0], [4.2, 1.3, 1.0]),
        ..base_settings()
    };
    assert!(!settings.passive_solid.is_empty() && !settings.passive_void.is_empty());
    let result = run(&settings).expect("a run with passive regions");
    assert!(settings
        .passive_solid
        .iter()
        .all(|&element| result.density[element] == 1.0));
    assert!(settings
        .passive_void
        .iter()
        .all(|&element| result.density[element] == 0.0));
    let last = result.history.last().expect("history");
    assert!((last.volume - 0.5).abs() < 0.01, "volume {}", last.volume);
}

#[test]
fn streams_on_its_cadence_ends_on_the_result_and_is_deterministic() {
    let settings = LevelSetSettings {
        stream_every: 4,
        ..base_settings()
    };
    let mut iterations = Vec::new();
    let mut last_density = Vec::new();
    let result = optimize_level_set(
        problem().model(SimpSolver::default()),
        &settings,
        |iteration, density| {
            iterations.push(iteration);
            last_density = density.to_vec();
        },
    )
    .expect("a streamed run");
    assert_eq!(iterations.last(), Some(&result.iterations));
    assert!(iterations[..iterations.len() - 1]
        .iter()
        .all(|iteration| iteration % 4 == 0));
    assert_eq!(last_density, result.density);
    let base = base_run();
    assert_eq!(result.density, base.density);
    assert_eq!(result.level_set, base.level_set);
}

#[test]
fn each_streamed_design_is_the_one_its_iteration_analysed() {
    let settings = LevelSetSettings {
        max_iterations: 8,
        ..base_settings()
    };
    let mut streamed = Vec::new();
    let result = optimize_level_set(
        problem().model(SimpSolver::default()),
        &settings,
        |iteration, density| streamed.push((iteration, volume_fraction(density))),
    )
    .expect("a short run");
    assert_eq!(streamed.len(), 8);
    for (iteration, fraction) in streamed {
        let reported = result.history[iteration - 1].volume;
        assert!(
            near(fraction, reported, 1e-12),
            "iteration {iteration}: streamed volume {fraction}, reported {reported}"
        );
    }
}

#[test]
fn ill_posed_settings_are_refused() {
    let problem = problem();
    let refused = |settings: LevelSetSettings| run(&settings).is_err();
    assert!(refused(LevelSetSettings {
        volume_fraction: 0.0,
        ..base_settings()
    }));
    assert!(refused(LevelSetSettings {
        max_iterations: 0,
        ..base_settings()
    }));
    assert!(refused(LevelSetSettings {
        stream_every: 0,
        ..base_settings()
    }));
    assert!(refused(LevelSetSettings {
        time_step: 0.0,
        ..base_settings()
    }));
    assert!(refused(LevelSetSettings {
        regularization_length: f64::NAN,
        ..base_settings()
    }));
    // Two blocks either side of the grid plane x = 7/3 share its vertices.
    let solid = problem.elements_in_box([2.0, 0.5, -1.0], [7.0 / 3.0, 0.9, 1.0]);
    let void = problem.elements_in_box([7.0 / 3.0, 0.5, -1.0], [2.6, 0.9, 1.0]);
    assert!(!solid.is_empty() && !void.is_empty());
    assert!(refused(LevelSetSettings {
        passive_solid: solid,
        passive_void: void,
        ..base_settings()
    }));
    // Pins that put the target out of reach are refused up front.
    assert!(refused(LevelSetSettings {
        volume_fraction: 0.1,
        passive_solid: problem.elements_in_box([0.0, 0.0, -1.0], [5.0, 2.0, 1.0]),
        ..base_settings()
    }));
    assert!(refused(LevelSetSettings {
        volume_fraction: 0.9,
        passive_void: problem.elements_in_box([1.0, 0.0, -1.0], [5.0, 1.5, 1.0]),
        ..base_settings()
    }));
    let out_of_range = problem.mesh.element_count();
    assert!(refused(LevelSetSettings {
        passive_solid: vec![out_of_range],
        ..base_settings()
    }));
}

/// Each setting is refused at the edge of its range, for that setting's own
/// reason, and the closed ends of the ranges are still accepted.
#[test]
fn settings_out_of_range_are_refused_at_their_bounds() {
    let refusal = |settings: LevelSetSettings| match run(&settings) {
        Ok(_) => panic!("settings {settings:?} were accepted"),
        Err(error) => error.to_string(),
    };
    let refused_for = |settings: LevelSetSettings, reason: &str| {
        let message = refusal(settings);
        assert!(
            message.contains(reason),
            "expected a refusal containing {reason:?}, got {message:?}"
        );
    };
    let volume_fraction = "the volume fraction must be in (0, 1]";
    let tolerance = "the tolerance must be finite and positive";
    let volume_step = "the volume step must be in (0, 1]";
    let emin_rel = "the stiffness floor emin_rel must be in (0, 1)";

    refused_for(
        LevelSetSettings {
            volume_fraction: 1.0 + 1e-9,
            ..base_settings()
        },
        volume_fraction,
    );
    refused_for(
        LevelSetSettings {
            volume_fraction: f64::NAN,
            ..base_settings()
        },
        volume_fraction,
    );
    for value in [0.0, -0.01, f64::INFINITY, f64::NAN] {
        refused_for(
            LevelSetSettings {
                tolerance: value,
                ..base_settings()
            },
            tolerance,
        );
    }
    for value in [0.0, 1.0 + 1e-9, 1.5, f64::NAN] {
        refused_for(
            LevelSetSettings {
                volume_step: value,
                ..base_settings()
            },
            volume_step,
        );
    }
    for value in [0.0, 1.0, f64::NAN] {
        refused_for(
            LevelSetSettings {
                emin_rel: value,
                ..base_settings()
            },
            emin_rel,
        );
    }

    // The closed ends: full material and a whole-range volume step.
    for settings in [
        LevelSetSettings {
            volume_fraction: 1.0,
            max_iterations: 1,
            ..base_settings()
        },
        LevelSetSettings {
            volume_step: 1.0,
            max_iterations: 1,
            ..base_settings()
        },
    ] {
        run(&settings).unwrap_or_else(|error| panic!("{settings:?} was refused: {error}"));
    }
}

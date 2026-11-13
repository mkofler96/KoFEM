// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The SIMP loop end to end on the MBB half-beam: both formulations, passive
//! regions, streaming, determinism and the refusal of ill-posed settings —
//! ported from the C++ engine's `engine/tests/topology_optimize_validation.cpp`.

#![allow(
    clippy::expect_used,
    clippy::cast_precision_loss,
    reason = "test fixtures: a run that fails should abort the test; element counts fit \
              any float"
)]

mod topology_support;

use kofem_fem::topology::{
    optimize, Objective, SimpResult, SimpSettings, SimpSolver, COMPLIANCE_LIMIT_SLACK,
};
use kofem_fem::FemError;
use topology_support::{mbb, Problem};

fn base_settings() -> SimpSettings {
    SimpSettings {
        volume_fraction: 0.5,
        penalty: 3.0,
        filter_radius: 0.6,
        move_limit: 0.2,
        max_iterations: 60,
        tolerance: 0.01,
        ..SimpSettings::default()
    }
}

fn run(problem: &Problem, settings: &SimpSettings) -> Result<SimpResult, FemError> {
    optimize(problem.model(SimpSolver::default()), settings, |_, _| {})
}

fn volume_fraction(problem: &Problem, density: &[f64]) -> f64 {
    let model = problem.model(SimpSolver::default());
    let total: f64 = model.volumes().iter().sum();
    let used: f64 = model
        .volumes()
        .iter()
        .zip(density)
        .map(|(volume, rho)| volume * rho)
        .sum();
    used / total
}

fn compliance_of(problem: &Problem, density: &[f64], settings: &SimpSettings) -> f64 {
    problem
        .model(SimpSolver::default())
        .evaluate_compliance(density, settings.penalty, settings.emin_rel)
        .expect("re-evaluation")
        .compliance
}

#[test]
fn min_compliance_converges_to_a_topology_that_meets_the_volume() {
    let problem = mbb();
    let settings = base_settings();
    let result = run(&problem, &settings).expect("optimization");
    let history = &result.history;
    assert!(!history.is_empty() && history.len() <= settings.max_iterations);
    assert!(
        result.converged,
        "converged within {} iterations",
        history.len()
    );
    assert_eq!(result.iterations, history.len());

    let last = history.last().expect("history");
    assert!((last.volume - 0.5).abs() < 0.01, "volume {}", last.volume);

    let first = history.first().expect("history");
    assert!(last.compliance < 0.75 * first.compliance);
    for pair in history[6..].windows(2) {
        assert!(
            pair[1].compliance <= pair[0].compliance * 1.02,
            "compliance rose from {} to {} at iteration {}",
            pair[0].compliance,
            pair[1].compliance,
            pair[1].iteration
        );
    }
    assert!(history.iter().all(|entry| entry.stress.is_none()));

    let count = result.density.len() as f64;
    let mean = result.density.iter().sum::<f64>() / count;
    let spread = (result
        .density
        .iter()
        .map(|rho| (rho - mean).powi(2))
        .sum::<f64>()
        / count)
        .sqrt();
    assert!(result.density.iter().any(|&rho| rho > 0.9), "no solid");
    assert!(result.density.iter().any(|&rho| rho < 0.1), "no void");
    assert!(spread > 0.1, "density spread {spread}");

    // The returned density is the analysed design of the last entry.
    let compliance = compliance_of(&problem, &result.density, &settings);
    assert!((compliance - last.compliance).abs() <= 1e-6 * last.compliance);
    assert!((volume_fraction(&problem, &result.density) - last.volume).abs() < 1e-12);
    assert_eq!(result.displacements.len(), 3 * problem.vertices.len());
}

#[test]
#[allow(
    clippy::float_cmp,
    reason = "a pinned density is copied, never computed, so it must be exact"
)]
fn passive_elements_stay_pinned() {
    let problem = mbb();
    let solid = problem.elements_in_box([1.0, 1.2, -1.0], [2.5, 2.0, 1.0]);
    let void = problem.elements_in_box([3.0, 0.6, -1.0], [4.5, 1.4, 1.0]);
    assert!(!solid.is_empty() && !void.is_empty());
    let settings = SimpSettings {
        rho_min: 1e-3,
        passive_solid: solid.clone(),
        passive_void: void.clone(),
        ..base_settings()
    };
    let result = run(&problem, &settings).expect("optimization");
    assert!(solid.iter().all(|&element| result.density[element] == 1.0));
    assert!(void.iter().all(|&element| result.density[element] == 1e-3));
    let last = result.history.last().expect("history");
    assert!((last.volume - 0.5).abs() < 0.01);
    assert!(last.compliance.is_finite() && last.compliance < 1e6);
}

#[test]
fn ill_posed_settings_are_refused() {
    let problem = mbb();
    let solid = problem.elements_in_box([1.0, 1.2, -1.0], [2.5, 2.0, 1.0]);
    let refused = |settings: SimpSettings| {
        matches!(
            run(&problem, &settings),
            Err(FemError::TopologyInput { .. })
        )
    };
    assert!(refused(SimpSettings {
        passive_solid: vec![solid[0]],
        passive_void: vec![solid[0]],
        ..base_settings()
    }));
    assert!(refused(SimpSettings {
        passive_solid: vec![problem.mesh.element_count()],
        ..base_settings()
    }));
    assert!(refused(SimpSettings {
        volume_fraction: 0.3,
        rho_min: 0.5,
        ..base_settings()
    }));
    assert!(refused(SimpSettings {
        volume_fraction: 0.1,
        passive_solid: problem.elements_in_box([0.0, 0.0, -1.0], [5.0, 2.0, 1.0]),
        ..base_settings()
    }));
    assert!(refused(SimpSettings {
        max_iterations: 0,
        ..base_settings()
    }));
    assert!(refused(SimpSettings {
        stream_every: 0,
        ..base_settings()
    }));
    assert!(refused(SimpSettings {
        volume_fraction: f64::NAN,
        ..base_settings()
    }));
    assert!(refused(SimpSettings {
        volume_fraction: 1.5,
        ..base_settings()
    }));
    // Repeating an index pins no more material.
    let duplicate = SimpSettings {
        max_iterations: 1,
        passive_solid: vec![solid[0]; 1000],
        ..base_settings()
    };
    assert!(run(&problem, &duplicate).is_ok());
}

#[test]
fn streams_on_its_cadence_and_always_the_final_design() {
    let problem = mbb();
    let settings = SimpSettings {
        stream_every: 3,
        ..base_settings()
    };
    let mut streamed = Vec::new();
    let mut last_density = Vec::new();
    let result = optimize(
        problem.model(SimpSolver::default()),
        &settings,
        |iteration, density| {
            streamed.push(iteration);
            last_density = density.to_vec();
        },
    )
    .expect("optimization");
    let (last, earlier) = streamed.split_last().expect("streamed");
    assert!(earlier.iter().all(|iteration| iteration % 3 == 0));
    assert_eq!(*last, result.iterations);
    assert_eq!(last_density, result.density);

    let plain = run(&problem, &base_settings()).expect("optimization");
    assert_eq!(
        plain.density, result.density,
        "streaming changed the design"
    );
    assert_eq!(plain.history, result.history, "two runs differ");
}

#[test]
fn min_volume_meets_the_compliance_limit_and_agrees_with_min_compliance() {
    let problem = mbb();
    let baseline = run(&problem, &base_settings()).expect("baseline");
    let optimum = baseline.history.last().expect("history");
    let settings = SimpSettings {
        objective: Objective::MinVolume,
        compliance_limit: optimum.compliance,
        max_iterations: 150,
        ..base_settings()
    };
    let result = run(&problem, &settings).expect("min_volume");
    let last = result.history.last().expect("history");
    assert!(result.converged);
    assert!(last.compliance <= optimum.compliance * (1.0 + COMPLIANCE_LIMIT_SLACK));
    assert!((result.history[0].volume - 1.0).abs() < 1e-12);
    assert!(last.volume < 0.8);
    assert!(
        (last.volume - optimum.volume).abs() < 0.005,
        "min_volume {} vs min_compliance {}",
        last.volume,
        optimum.volume
    );

    // Wherever the cap lands, the returned design meets the limit and is the
    // design its last entry describes.
    let mut fallbacks = 0;
    for cap in (4..=32).step_by(4) {
        let capped = run(
            &problem,
            &SimpSettings {
                max_iterations: cap,
                ..settings.clone()
            },
        )
        .expect("capped run");
        let entry = capped.history.last().expect("history");
        if capped.iterations < cap && !capped.converged {
            fallbacks += 1;
        }
        assert!(entry.compliance <= settings.compliance_limit * (1.0 + COMPLIANCE_LIMIT_SLACK));
        assert_eq!(capped.history.len(), capped.iterations);
        let compliance = compliance_of(&problem, &capped.density, &settings);
        assert!((compliance - entry.compliance).abs() <= 1e-6 * entry.compliance);
    }
    assert!(fallbacks > 0, "the infeasible-cap fallback never ran");

    // A looser limit buys a smaller volume.
    let loose = run(
        &problem,
        &SimpSettings {
            compliance_limit: 2.0 * optimum.compliance,
            ..settings.clone()
        },
    )
    .expect("loose");
    let loose_last = loose.history.last().expect("history");
    assert!(loose_last.volume < last.volume - 0.05);
    assert!(loose_last.compliance <= 2.0 * optimum.compliance * (1.0 + COMPLIANCE_LIMIT_SLACK));

    // Full material is the stiffest design: a limit below it is unreachable.
    let full = baseline.history[0].compliance * 0.5_f64.powi(3);
    for limit in [0.5 * full, 0.0] {
        let refused = run(
            &problem,
            &SimpSettings {
                compliance_limit: limit,
                ..settings.clone()
            },
        );
        assert!(matches!(refused, Err(FemError::TopologyInput { .. })));
    }
}

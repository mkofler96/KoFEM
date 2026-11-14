// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! SIMP on the shell and coupled shell/solid design domains
//! ([`MixedSimpModel`]), against the cases and tolerances of the C++ engine's
//! `engine/tests/topology_shell_validation.cpp`: the compliance sensitivity
//! of shell facets and of tets coupled to facets against central
//! differences, the simply-supported plate's rib layout in both
//! formulations, capped `min_volume` runs, and the inputs the shell path
//! refuses.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::min_ident_chars,
    clippy::many_single_char_names,
    clippy::too_many_lines,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              corner names a..h as in the C++ suite, and a fixture that fails to build \
              should abort the test"
)]

use kofem_fem::topology::{
    optimize, MixedSimpModel, MixedSolver, Objective, SimpOptimizer, SimpResult, SimpSettings,
    StressConstraint, COMPLIANCE_LIMIT_SLACK,
};
use kofem_fem::{
    assemble_shell_stiffness, solve_shell_static, AmgSettings, CgSettings, Coupling, CouplingKind,
    FemError, Isotropic, MixedPreconditioner, PreconditionerChoice, ShellMesh, StoppingRule,
    TetMesh, DOFS_PER_NODE,
};

fn material(young: f64, poisson: f64) -> Isotropic {
    Isotropic::new(0, young, poisson).expect("valid material")
}

/// Tight IC(0) CG, for finite-difference checks.
fn tight() -> MixedSolver {
    MixedSolver {
        preconditioner: MixedPreconditioner::IncompleteCholesky,
        relative_tolerance: 1e-12,
    }
}

fn dof(node: usize, component: usize) -> u32 {
    (DOFS_PER_NODE * node + component) as u32
}

/// The square [0, a]² in the z = 0 plane, n×n cells of two facets each:
/// vertex (i, j) is i·(n + 1) + j.
fn plate(a: f64, n: usize, thickness: f64) -> ShellMesh {
    let mut vertices = Vec::new();
    for i in 0..=n {
        for j in 0..=n {
            vertices.extend([a * i as f64 / n as f64, a * j as f64 / n as f64, 0.0]);
        }
    }
    let id = |i: usize, j: usize| (i * (n + 1) + j) as u32;
    let mut triangles = Vec::new();
    for i in 0..n {
        for j in 0..n {
            let [a0, a1, a2, a3] = [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)];
            triangles.extend([a0, a1, a2, a0, a2, a3]);
        }
    }
    let count = triangles.len() / 3;
    ShellMesh::new(
        &vertices,
        &triangles,
        &vec![thickness; count],
        &vec![0; count],
        vec![material(210_000.0, 0.3)],
    )
    .expect("valid plate")
}

/// u, v, w held on the boundary of the n×n plate, rotations free.
fn simply_supported(n: usize) -> Vec<u32> {
    let mut fixed = Vec::new();
    for i in 0..=n {
        for j in 0..=n {
            if i == 0 || j == 0 || i == n || j == n {
                fixed.extend((0..3).map(|component| dof(i * (n + 1) + j, component)));
            }
        }
    }
    fixed
}

/// The C++ suite's plate: a = 100, t = 2, simply supported, under a central
/// point load (`n` = 4) or a uniform pressure (`pressure`).
fn plate_model(n: usize, pressure: bool, solver: MixedSolver) -> MixedSimpModel {
    let shell = plate(100.0, n, 2.0);
    let mut forces = vec![0.0; DOFS_PER_NODE * shell.vertex_count()];
    if pressure {
        for i in 1..n {
            for j in 1..n {
                forces[DOFS_PER_NODE * (i * (n + 1) + j) + 2] = -1.0;
            }
        }
    } else {
        let middle = (n / 2) * (n + 1) + n / 2;
        forces[DOFS_PER_NODE * middle + 2] = -50.0;
    }
    MixedSimpModel::new(
        None,
        Some(shell),
        Vec::new(),
        &simply_supported(n),
        forces,
        solver,
    )
    .expect("valid plate model")
}

/// Central differences of the compliance against the analytic sensitivity,
/// at `elements`, within `percent`.
fn assert_sensitivities(model: &mut MixedSimpModel, rho: &[f64], elements: &[usize], percent: f64) {
    let (penalty, emin, step) = (3.0, 1e-9, 1e-6);
    let analytic = model
        .evaluate_compliance(rho, penalty, emin)
        .expect("solve")
        .dcompliance;
    for &element in elements {
        let mut perturbed = rho.to_vec();
        perturbed[element] = rho[element] + step;
        let plus = model
            .evaluate_compliance(&perturbed, penalty, emin)
            .expect("solve")
            .compliance;
        perturbed[element] = rho[element] - step;
        let minus = model
            .evaluate_compliance(&perturbed, penalty, emin)
            .expect("solve")
            .compliance;
        let central = (plus - minus) / (2.0 * step);
        let error = 100.0 * (analytic[element] - central).abs() / central.abs();
        assert!(
            error < percent,
            "element {element}: dc/drho {} vs central difference {central} ({error:.3} %)",
            analytic[element]
        );
    }
}

#[test]
fn shell_facet_sensitivity_matches_central_differences() {
    let mut model = plate_model(4, false, tight());
    let count = model.element_count();
    let rho: Vec<f64> = (0..count)
        .map(|element| 0.35 + 0.5 * ((element * 7) % 11) as f64 / 11.0)
        .collect();
    let every_third: Vec<usize> = (0..count).step_by(3).collect();
    assert_sensitivities(&mut model, &rho, &every_third, 0.5);
}

#[test]
fn full_material_reproduces_the_static_shell_compliance() {
    let n = 4;
    let mut model = plate_model(n, false, tight());
    let rho = vec![1.0; model.element_count()];
    let evaluation = model.evaluate_compliance(&rho, 3.0, 1e-9).expect("solve");

    let shell = plate(100.0, n, 2.0);
    let stiffness = assemble_shell_stiffness(&shell);
    let mut forces = vec![0.0; DOFS_PER_NODE * shell.vertex_count()];
    let middle = (n / 2) * (n + 1) + n / 2;
    forces[DOFS_PER_NODE * middle + 2] = -50.0;
    let fixed = simply_supported(n);
    let solution = solve_shell_static(
        &shell,
        &stiffness,
        &fixed,
        &vec![0.0; fixed.len()],
        &forces,
        CgSettings {
            relative_tolerance: 1e-12,
            max_iterations: 100_000,
            stopping: StoppingRule::ResidualNorm,
        },
    )
    .expect("static shell solve");
    let work: f64 = forces.iter().zip(&solution.dofs).map(|(f, u)| f * u).sum();
    let relative = (evaluation.compliance - work).abs() / work;
    assert!(
        relative < 1e-8,
        "compliance {} vs fᵀu {work}",
        evaluation.compliance
    );
    // Translations of the middle node, three per vertex.
    let w = evaluation.displacements[3 * middle + 2];
    assert!((w - solution.dofs[DOFS_PER_NODE * middle + 2]).abs() <= 1e-10 * w.abs());
    // Facet volume is area times thickness: the whole plate is 100² · 2.
    let total: f64 = model.volumes().iter().sum();
    assert!((total - 2.0e4).abs() < 1e-8);
}

/// The C++ suite's coupled case: a solid block cantilevered at x = 0 with a
/// thin shell wall hanging from it on y = W/2, joined by distributing
/// couplings; tets and facets form one design domain, the couplings do not.
fn wall_on_block(solver: MixedSolver) -> MixedSimpModel {
    let (length, width, height, wall, thickness) = (40.0, 8.0, 8.0, 20.0, 1.5);
    let (nx, ny, nz, nzw) = (2usize, 1usize, 1usize, 2usize);
    let mut points: Vec<[f64; 3]> = Vec::new();
    let sid = |i: usize, j: usize, k: usize| (i * (ny + 1) + j) * (nz + 1) + k;
    for i in 0..=nx {
        for j in 0..=ny {
            for k in 0..=nz {
                points.push([
                    length * i as f64 / nx as f64,
                    width * j as f64 / ny as f64,
                    height * k as f64 / nz as f64,
                ]);
            }
        }
    }
    let mut tets = Vec::new();
    for i in 0..nx {
        for j in 0..ny {
            for k in 0..nz {
                let a = sid(i, j, k);
                let b = sid(i + 1, j, k);
                let c = sid(i + 1, j + 1, k);
                let d = sid(i, j + 1, k);
                let e = sid(i, j, k + 1);
                let f = sid(i + 1, j, k + 1);
                let g = sid(i + 1, j + 1, k + 1);
                let h = sid(i, j + 1, k + 1);
                for tet in [
                    [a, b, c, g],
                    [a, c, d, g],
                    [a, d, h, g],
                    [a, h, e, g],
                    [a, e, f, g],
                    [a, f, b, g],
                ] {
                    tets.extend(tet.map(|node| node as u32));
                }
            }
        }
    }
    let solid_nodes = points.len();
    let wid = |i: usize, k: usize| solid_nodes + i * (nzw + 1) + k;
    for i in 0..=nx {
        for k in 0..=nzw {
            points.push([
                length * i as f64 / nx as f64,
                width / 2.0,
                -wall * k as f64 / nzw as f64,
            ]);
        }
    }
    let mut triangles = Vec::new();
    for i in 0..nx {
        for k in 0..nzw {
            let [a, b, c, d] = [wid(i, k), wid(i + 1, k), wid(i + 1, k + 1), wid(i, k + 1)];
            triangles.extend([a, b, c, a, c, d].map(|node| node as u32));
        }
    }
    let flat: Vec<f64> = points.iter().flatten().copied().collect();
    let solid = TetMesh::new(
        &flat,
        &tets,
        &vec![0; tets.len() / 4],
        vec![material(210_000.0, 0.3)],
    )
    .expect("valid block");
    let facets = triangles.len() / 3;
    let shell = ShellMesh::new(
        &flat,
        &triangles,
        &vec![thickness; facets],
        &vec![0; facets],
        vec![material(70_000.0, 0.33)],
    )
    .expect("valid wall");

    let radius = 1.3 * length;
    let mut couplings = Vec::new();
    for i in 0..=nx {
        let reference = wid(i, 0);
        let patch: Vec<usize> = (0..solid_nodes)
            .filter(|&node| {
                let distance: f64 = (0..3)
                    .map(|axis| (points[node][axis] - points[reference][axis]).powi(2))
                    .sum();
                distance <= radius * radius
            })
            .collect();
        if patch.len() >= 3 {
            couplings.push(Coupling {
                reference,
                nodes: patch,
                weights: Vec::new(),
                kind: CouplingKind::Distributing,
            });
        }
    }
    let mut fixed = Vec::new();
    for j in 0..=ny {
        for k in 0..=nz {
            fixed.extend((0..3).map(|component| dof(sid(0, j, k), component)));
        }
    }
    let mut forces = vec![0.0; DOFS_PER_NODE * points.len()];
    for i in 0..=nx {
        forces[DOFS_PER_NODE * wid(i, nzw)] = 30.0;
    }
    MixedSimpModel::new(Some(solid), Some(shell), couplings, &fixed, forces, solver)
        .expect("valid coupled model")
}

#[test]
fn coupled_tet_and_facet_sensitivities_match_central_differences() {
    let mut model = wall_on_block(tight());
    let (tets, facets) = (model.tet_count(), model.facet_count());
    assert_eq!((tets, facets), (12, 8));
    let rho: Vec<f64> = (0..tets + facets)
        .map(|element| 0.4 + 0.4 * ((element * 5) % 7) as f64 / 7.0)
        .collect();
    assert_sensitivities(
        &mut model,
        &rho,
        &[0, tets / 2, tets, tets + facets / 2],
        1.0,
    );
}

#[test]
fn the_preconditioners_agree_on_the_coupled_compliance() {
    let rho: Vec<f64> = (0..20_usize)
        .map(|element| 0.4 + 0.4 * ((element * 5) % 7) as f64 / 7.0)
        .collect();
    let compliance = |preconditioner| {
        wall_on_block(MixedSolver {
            preconditioner,
            relative_tolerance: 1e-10,
        })
        .evaluate_compliance(&rho, 3.0, 1e-9)
        .expect("solve")
        .compliance
    };
    let reference = compliance(MixedPreconditioner::IncompleteCholesky);
    for preconditioner in [
        MixedPreconditioner::Choice(PreconditionerChoice::SymmetricGaussSeidel),
        MixedPreconditioner::Choice(PreconditionerChoice::SmoothedAggregation(
            AmgSettings::topology_optimization(),
        )),
    ] {
        let other = compliance(preconditioner);
        assert!(
            (other - reference).abs() <= 1e-7 * reference,
            "{preconditioner:?}: {other} vs IC(0) {reference}"
        );
    }
}

fn plate_settings() -> SimpSettings {
    SimpSettings {
        volume_fraction: 0.4,
        penalty: 3.0,
        filter_radius: 2.5 * 100.0 / 16.0,
        move_limit: 0.2,
        max_iterations: 40,
        tolerance: 0.01,
        ..SimpSettings::default()
    }
}

fn run(model: MixedSimpModel, settings: &SimpSettings) -> SimpResult {
    optimize(model, settings, |_, _| {}).expect("the plate optimizes")
}

#[test]
fn the_plate_forms_ribs_and_both_formulations_agree() {
    let settings = plate_settings();
    let result = run(plate_model(16, true, MixedSolver::default()), &settings);
    let history = &result.history;
    let (first, last) = (&history[0], &history[history.len() - 1]);
    assert!(
        last.compliance < 0.999 * first.compliance,
        "compliance {} → {}",
        first.compliance,
        last.compliance
    );
    assert!(
        (last.volume - 0.4).abs() <= 0.08 * 0.4,
        "volume {}",
        last.volume
    );
    let low = result.density.iter().copied().fold(f64::INFINITY, f64::min);
    let high = result.density.iter().copied().fold(0.0, f64::max);
    assert!(high - low > 0.5, "density spans {low}..{high}: no ribs");
    assert_eq!(result.displacements.len(), 3 * 17 * 17);

    let volume_settings = SimpSettings {
        objective: Objective::MinVolume,
        compliance_limit: last.compliance,
        max_iterations: 150,
        ..settings
    };
    let volume = run(
        plate_model(16, true, MixedSolver::default()),
        &volume_settings,
    );
    let end = &volume.history[volume.history.len() - 1];
    assert!(volume.converged, "min_volume hit its cap");
    assert!(end.compliance <= last.compliance * (1.0 + COMPLIANCE_LIMIT_SLACK));
    assert!(
        (end.volume - last.volume).abs() <= 0.01 * last.volume,
        "min_volume volume {} vs min_compliance {}",
        end.volume,
        last.volume
    );
}

#[test]
fn a_capped_min_volume_run_returns_a_feasible_self_consistent_design() {
    let limit = run(
        plate_model(16, true, MixedSolver::default()),
        &plate_settings(),
    )
    .history
    .last()
    .expect("history")
    .compliance;
    let mut fallbacks = 0;
    for cap in (5..=60).step_by(5) {
        let settings = SimpSettings {
            objective: Objective::MinVolume,
            compliance_limit: limit,
            max_iterations: cap,
            ..plate_settings()
        };
        let result = run(plate_model(16, true, MixedSolver::default()), &settings);
        let end = result.history.last().expect("history");
        if result.iterations < cap && !result.converged {
            fallbacks += 1;
        }
        assert!(
            end.compliance <= limit * (1.0 + COMPLIANCE_LIMIT_SLACK),
            "cap {cap}: c = {} above {limit}",
            end.compliance
        );
        let again = plate_model(16, true, MixedSolver::default())
            .evaluate_compliance(&result.density, 3.0, 1e-9)
            .expect("re-evaluate")
            .compliance;
        assert!(
            (again - end.compliance).abs() <= 1e-4 * end.compliance,
            "cap {cap}: the returned design has c = {again}, its history entry {}",
            end.compliance
        );
        assert_eq!(result.history.len(), result.iterations);
    }
    assert!(fallbacks > 0, "no cap landed on an infeasible iterate");
}

#[test]
fn passive_facets_stay_pinned() {
    let n = 8;
    let model = plate_model(n, true, MixedSolver::default());
    let solid: Vec<usize> = (0..8).collect();
    let void: Vec<usize> = (100..110).collect();
    let settings = SimpSettings {
        max_iterations: 10,
        passive_solid: solid.clone(),
        passive_void: void.clone(),
        filter_radius: 2.5 * 100.0 / n as f64,
        ..plate_settings()
    };
    let result = run(model, &settings);
    for element in solid {
        assert!((result.density[element] - 1.0).abs() < 1e-15);
    }
    for element in void {
        assert!(result.density[element].abs() < 1e-15);
    }
}

#[test]
fn a_stress_limit_on_a_shell_model_is_refused() {
    let settings = SimpSettings {
        rho_min: 1e-3,
        stress: Some(StressConstraint::new(100.0)),
        ..plate_settings()
    };
    let Err(error) = SimpOptimizer::new(plate_model(4, false, tight()), &settings) else {
        panic!("a stress-limited shell run was accepted");
    };
    assert!(
        error.to_string().contains("all-solid models only"),
        "{error}"
    );
}

#[test]
fn a_model_without_supports_load_or_elements_is_refused() {
    let shell = || plate(100.0, 2, 2.0);
    let forces = || {
        let mut forces = vec![0.0; DOFS_PER_NODE * 9];
        forces[DOFS_PER_NODE * 4 + 2] = -1.0;
        forces
    };
    let refuse = |result: Result<MixedSimpModel, FemError>| match result {
        Ok(_) => panic!("the model was accepted"),
        Err(error) => error.to_string(),
    };
    let unsupported = refuse(MixedSimpModel::new(
        None,
        Some(shell()),
        Vec::new(),
        &[],
        forces(),
        tight(),
    ));
    assert!(unsupported.contains("fixed support"), "{unsupported}");
    let unloaded = refuse(MixedSimpModel::new(
        None,
        Some(shell()),
        Vec::new(),
        &simply_supported(2),
        vec![0.0; DOFS_PER_NODE * 9],
        tight(),
    ));
    assert!(unloaded.contains("applied load"), "{unloaded}");
    let empty = refuse(MixedSimpModel::new(
        None,
        None,
        Vec::new(),
        &simply_supported(2),
        forces(),
        tight(),
    ));
    assert!(empty.contains("no elements"), "{empty}");
    let coupled_without_solid = refuse(MixedSimpModel::new(
        None,
        Some(shell()),
        vec![Coupling {
            reference: 4,
            nodes: vec![0, 1, 2],
            weights: Vec::new(),
            kind: CouplingKind::Distributing,
        }],
        &simply_supported(2),
        forces(),
        tight(),
    ));
    assert!(
        coupled_without_solid.contains("solid body"),
        "{coupled_without_solid}"
    );
}

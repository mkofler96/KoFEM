// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The Newton driver: linear elasticity through it matches the linear solve on
//! every element type, load increments do not change a linear answer, a
//! nonlinear problem with a known solution converges quadratically, a
//! non-converging increment is refused by name, and stepping the driver in
//! small CG budgets changes nothing.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

mod support;

use kofem_fem::nonlinear::{
    solve_newton, DirichletCg, LinearElastic, NewtonRun, NewtonSettings, NewtonSolution,
    NewtonStatus, NonlinearProblem,
};
use kofem_fem::{
    assemble_stiffness, solve_static, AmgSettings, CgSettings, CsrMatrix, ElementOrder, FemError,
    Isotropic, PreconditionerChoice, StoppingRule, TetMesh,
};

const CG: CgSettings = CgSettings {
    relative_tolerance: 1e-12,
    max_iterations: 20_000,
    stopping: StoppingRule::ResidualNorm,
};
const GS: PreconditionerChoice = PreconditionerChoice::SymmetricGaussSeidel;
const SIZE: [f64; 3] = [2.0, 1.0, 1.0];

fn amg() -> PreconditionerChoice {
    PreconditionerChoice::SmoothedAggregation(AmgSettings::default())
}

fn steel() -> Isotropic {
    Isotropic::new(0, 210_000.0, 0.3).expect("valid material")
}

fn settings(increments: u32) -> NewtonSettings {
    NewtonSettings {
        increments,
        max_iterations: 20,
        tolerance: 1e-9,
    }
}

fn tet_mesh(order: ElementOrder) -> TetMesh {
    support::box_mesh([2, 1, 1], SIZE, steel())
        .mesh
        .with_order(order)
        .expect("fits")
}

/// Cube corner (bit 0 = x, bit 1 = y, bit 2 = z) of each CHEXA corner.
const CUBE_CORNER_OF_HEX: [usize; 8] = [0b000, 0b001, 0b011, 0b010, 0b100, 0b101, 0b111, 0b110];

fn hex_mesh(order: ElementOrder) -> TetMesh {
    let [nx, ny, nz] = [2, 1, 1];
    let index = |ix: usize, iy: usize, iz: usize| ix + (nx + 1) * (iy + (ny + 1) * iz);
    let mut points = Vec::new();
    for iz in 0..=nz {
        for iy in 0..=ny {
            for ix in 0..=nx {
                points.extend([
                    SIZE[0] * ix as f64 / nx as f64,
                    SIZE[1] * iy as f64 / ny as f64,
                    SIZE[2] * iz as f64 / nz as f64,
                ]);
            }
        }
    }
    let mut hexes = Vec::new();
    for iz in 0..nz {
        for iy in 0..ny {
            for ix in 0..nx {
                hexes.extend(CUBE_CORNER_OF_HEX.map(|bits| {
                    index(
                        ix + (bits & 1),
                        iy + ((bits >> 1) & 1),
                        iz + ((bits >> 2) & 1),
                    ) as u32
                }));
            }
        }
    }
    let materials = vec![0; hexes.len() / 8];
    TetMesh::with_hexahedra(&points, &[], &hexes, &materials, vec![steel()])
        .expect("valid hexes")
        .with_order(order)
        .expect("fits")
}

/// A load case with both kinds of load: the x = 0 face clamped, the x = 2
/// face pulled 1e-3 along x, and a corner of that face pushed down.
struct LoadCase {
    fixed_dofs: Vec<u32>,
    fixed_values: Vec<f64>,
    forces: Vec<f64>,
}

fn load_case(mesh: &TetMesh) -> LoadCase {
    let mut fixed_dofs = Vec::new();
    let mut fixed_values = Vec::new();
    let mut forces = vec![0.0; mesh.dof_count()];
    for (vertex, point) in mesh.vertices().iter().enumerate() {
        let dof = 3 * vertex as u32;
        if point[0] == 0.0 {
            fixed_dofs.extend([dof, dof + 1, dof + 2]);
            fixed_values.extend([0.0; 3]);
        } else if point[0] == SIZE[0] {
            fixed_dofs.push(dof);
            fixed_values.push(1e-3);
            if point[1] == SIZE[1] && point[2] == SIZE[2] {
                forces[3 * vertex + 2] = -500.0;
            }
        }
    }
    LoadCase {
        fixed_dofs,
        fixed_values,
        forces,
    }
}

fn newton(
    mesh: &TetMesh,
    case: &LoadCase,
    increments: u32,
    preconditioner: PreconditionerChoice,
) -> NewtonSolution {
    solve_newton(
        LinearElastic::new(assemble_stiffness(mesh)),
        DirichletCg::new(mesh, CG, preconditioner),
        mesh,
        &case.fixed_dofs,
        &case.fixed_values,
        &case.forces,
        settings(increments),
    )
    .expect("Newton converges")
}

fn relative_difference(lhs: &[f64], rhs: &[f64]) -> f64 {
    let difference: f64 = lhs
        .iter()
        .zip(rhs)
        .map(|(left, right)| (left - right).powi(2))
        .sum();
    let scale: f64 = rhs.iter().map(|value| value * value).sum();
    (difference / scale).sqrt()
}

fn assert_matches_linear_solve(name: &str, mesh: &TetMesh, preconditioner: PreconditionerChoice) {
    let case = load_case(mesh);
    let linear = solve_static(
        mesh,
        &assemble_stiffness(mesh),
        &case.fixed_dofs,
        &case.fixed_values,
        &case.forces,
        CG,
        preconditioner,
    )
    .expect("linear solve");
    for increments in [1, 3] {
        let solution = newton(mesh, &case, increments, preconditioner);
        assert_eq!(solution.increments.len(), increments as usize, "{name}");
        for (index, increment) in solution.increments.iter().enumerate() {
            assert_eq!(
                increment.iterations,
                1,
                "{name}: increment {} of {increments} took {} Newton iterations",
                index + 1,
                increment.iterations
            );
        }
        let difference = relative_difference(&solution.displacements, &linear.displacements);
        println!(
            "{name} ({preconditioner:?}), {increments} increment(s): \
             ‖u_newton − u_static‖ / ‖u_static‖ = {difference:.3e}"
        );
        assert!(
            difference <= 1e-9,
            "{name}, {increments} increment(s): differs from solve_static by {difference:e}"
        );
    }
}

#[test]
fn linear_elasticity_on_tet4_matches_the_linear_solve_in_one_iteration_per_increment() {
    let mesh = tet_mesh(ElementOrder::Linear);
    assert_matches_linear_solve("tet4", &mesh, GS);
    assert_matches_linear_solve("tet4", &mesh, amg());
}

#[test]
fn linear_elasticity_on_tet10_matches_the_linear_solve_in_one_iteration_per_increment() {
    let mesh = tet_mesh(ElementOrder::Quadratic);
    assert_matches_linear_solve("tet10", &mesh, GS);
    assert_matches_linear_solve("tet10", &mesh, amg());
}

#[test]
fn linear_elasticity_on_hex8_matches_the_linear_solve_in_one_iteration_per_increment() {
    let mesh = hex_mesh(ElementOrder::Linear);
    assert_matches_linear_solve("hex8", &mesh, GS);
    assert_matches_linear_solve("hex8", &mesh, amg());
}

#[test]
fn linear_elasticity_on_hex27_matches_the_linear_solve_in_one_iteration_per_increment() {
    let mesh = hex_mesh(ElementOrder::Quadratic);
    assert_matches_linear_solve("hex27", &mesh, GS);
    assert_matches_linear_solve("hex27", &mesh, amg());
}

#[test]
fn splitting_a_linear_load_into_increments_gives_the_same_displacements() {
    let mesh = tet_mesh(ElementOrder::Quadratic);
    let case = load_case(&mesh);
    let whole = newton(&mesh, &case, 1, GS);
    for increments in [2, 5] {
        let split = newton(&mesh, &case, increments, GS);
        let difference = relative_difference(&split.displacements, &whole.displacements);
        println!("{increments} increments vs 1: relative difference {difference:.3e}");
        assert!(
            difference <= 1e-9,
            "{increments} increments differ from one by {difference:e}"
        );
    }
}

/// Linear elasticity plus a cubic spring on every DOF: `f_int` = K·u + α·u³,
/// tangent K + 3α·diag(u²). A strongly nonlinear, test-only problem.
struct CubicSprings {
    stiffness: CsrMatrix,
    alpha: f64,
}

impl CubicSprings {
    fn internal_force(&self, displacements: &[f64]) -> Vec<f64> {
        let mut force = vec![0.0; displacements.len()];
        self.stiffness.mul_vec(displacements, &mut force);
        for (force, value) in force.iter_mut().zip(displacements) {
            *force += self.alpha * value.powi(3);
        }
        force
    }
}

impl NonlinearProblem for CubicSprings {
    fn tangent_pattern(&self) -> CsrMatrix {
        let mut pattern = self.stiffness.clone();
        pattern.values_mut().fill(0.0);
        pattern
    }

    fn tangent_varies(&self) -> bool {
        true
    }

    fn internal_force_and_tangent(
        &mut self,
        displacements: &[f64],
        tangent: &mut CsrMatrix,
    ) -> Result<Vec<f64>, FemError> {
        tangent
            .values_mut()
            .copy_from_slice(self.stiffness.values());
        for (row, value) in displacements.iter().enumerate() {
            let position = tangent.diagonal_position(row);
            tangent.values_mut()[position] += 3.0 * self.alpha * value * value;
        }
        Ok(self.internal_force(displacements))
    }
}

/// The cubic-spring problem with a manufactured solution: the x = 0 face
/// clamped, the x = 2 face pulled to `u_x` = 0.02 and the forces `f_int(u*)` of a
/// smooth field u* applied, so that u* is the exact answer.
struct Manufactured {
    mesh: TetMesh,
    problem: CubicSprings,
    exact: Vec<f64>,
    case: LoadCase,
}

fn manufactured() -> Manufactured {
    let mesh = tet_mesh(ElementOrder::Linear);
    let mut exact = vec![0.0; mesh.dof_count()];
    for (vertex, point) in mesh.vertices().iter().enumerate() {
        let ramp = point[0] / SIZE[0];
        exact[3 * vertex] = 0.02 * ramp;
        exact[3 * vertex + 1] = 0.01 * ramp * (1.0 + point[1]) * (0.5 + point[2]);
        exact[3 * vertex + 2] = -0.015 * ramp * ramp * (1.0 + 0.5 * point[1]);
    }
    let problem = CubicSprings {
        stiffness: assemble_stiffness(&mesh),
        alpha: 1e9,
    };
    let mut forces = problem.internal_force(&exact);
    let mut fixed_dofs = Vec::new();
    let mut fixed_values = Vec::new();
    for (vertex, point) in mesh.vertices().iter().enumerate() {
        let dof = 3 * vertex as u32;
        if point[0] == 0.0 {
            fixed_dofs.extend([dof, dof + 1, dof + 2]);
            fixed_values.extend([0.0; 3]);
            forces[3 * vertex..3 * vertex + 3].fill(0.0);
        } else if point[0] == SIZE[0] {
            fixed_dofs.push(dof);
            fixed_values.push(exact[3 * vertex]);
            forces[3 * vertex] = 0.0;
        }
    }
    Manufactured {
        mesh,
        problem,
        exact,
        case: LoadCase {
            fixed_dofs,
            fixed_values,
            forces,
        },
    }
}

fn start(
    model: Manufactured,
    preconditioner: PreconditionerChoice,
    settings: NewtonSettings,
) -> NewtonRun<CubicSprings, DirichletCg> {
    NewtonRun::start(
        model.problem,
        DirichletCg::new(&model.mesh, CG, preconditioner),
        &model.mesh,
        &model.case.fixed_dofs,
        &model.case.fixed_values,
        &model.case.forces,
        settings,
    )
    .expect("valid input")
}

/// Newton converges quadratically only near the solution; far from it (from
/// u = 0 under the full load) it first creeps. Load increments are what bring
/// it near, so the bound is checked on the last increment, which starts from
/// the converged previous one and is the only one whose exact answer, u*, is
/// known.
#[test]
fn a_nonlinear_problem_with_a_known_solution_converges_quadratically() {
    const INCREMENTS: u32 = 4;
    let model = manufactured();
    let exact = model.exact.clone();
    let scale = exact
        .iter()
        .fold(0.0_f64, |max, value| max.max(value.abs()));
    let mut run = start(model, GS, settings(INCREMENTS));
    let error_of = |displacements: &[f64]| {
        displacements
            .iter()
            .zip(&exact)
            .fold(0.0_f64, |max, (value, exact)| {
                max.max((value - exact).abs())
            })
            / scale
    };
    // The iterate entering the last increment, then each one in it.
    let mut errors = Vec::new();
    let mut residuals = Vec::new();
    loop {
        match run.advance(usize::MAX).expect("converges") {
            NewtonStatus::Iterated {
                increment,
                relative_residual,
                ..
            } => {
                println!("increment {increment}: relative residual {relative_residual:.3e}");
                if increment < INCREMENTS {
                    errors = vec![error_of(run.displacements())];
                } else {
                    errors.push(error_of(run.displacements()));
                    residuals.push(relative_residual);
                }
            }
            NewtonStatus::Converged => break,
            NewtonStatus::Solving { .. } | NewtonStatus::Checking { .. } => {
                panic!("an unlimited budget finishes every solve")
            }
        }
    }
    println!(
        "last increment: iteration, relative error ‖u − u*‖∞/‖u*‖∞, relative residual, \
         e_k+1 / e_k²"
    );
    for (iteration, error) in errors.iter().enumerate() {
        let residual = iteration.checked_sub(1).map_or(String::from("-"), |index| {
            format!("{:.3e}", residuals[index])
        });
        let ratio = iteration
            .checked_sub(1)
            .map_or(String::from("-"), |previous| {
                format!("{:.3}", error / errors[previous].powi(2))
            });
        println!("{iteration:>2}  {error:.3e}  {residual}  {ratio}");
    }
    let solution = run.into_solution().expect("converged");
    assert_eq!(
        solution.increments[INCREMENTS as usize - 1].residuals,
        residuals
    );
    assert!(
        errors.len() >= 4,
        "the problem must be nonlinear enough to need several iterations: {errors:?}"
    );
    assert!(
        *errors.last().expect("iterated") < 1e-9,
        "Newton converged to the known solution: {errors:?}"
    );
    // Quadratic convergence: e_k+1 ≤ C·e_k², checked wherever e_k² is far
    // enough above the CG accuracy (1e-12) to mean something.
    let constant = 10.0;
    for pair in errors.windows(2).filter(|pair| pair[0] > 1e-5) {
        assert!(
            pair[1] <= constant * pair[0] * pair[0],
            "not quadratic: e = {:e} after {:e} (errors {errors:?})",
            pair[1],
            pair[0]
        );
    }
}

#[test]
fn an_increment_that_does_not_converge_in_its_iteration_limit_is_refused_by_name() {
    let model = manufactured();
    let limited = NewtonSettings {
        increments: 2,
        max_iterations: 2,
        tolerance: 1e-9,
    };
    let mut run = start(model, GS, limited);
    let error = loop {
        match run.advance(usize::MAX) {
            Ok(NewtonStatus::Converged) => panic!("two iterations cannot converge here"),
            Ok(_) => {}
            Err(error) => break error,
        }
    };
    let FemError::NewtonNotConverged {
        increment,
        increments,
        iterations,
        relative_residual,
        ..
    } = error
    else {
        panic!("expected NewtonNotConverged, got {error:?}");
    };
    assert_eq!((increment, increments, iterations), (1, 2, 2));
    assert!(relative_residual > 1e-9 && relative_residual.is_finite());
    let message = error.to_string();
    println!("{message}");
    assert!(message.contains("increment 1 of 2"), "{message}");
    assert!(message.contains("2 iterations"), "{message}");
    assert!(
        message.contains(&format!("{relative_residual:e}")),
        "{message}"
    );
}

#[test]
fn a_tangent_solve_that_fails_is_refused_with_its_increment_and_iteration() {
    let model = manufactured();
    let starved = CgSettings {
        max_iterations: 2,
        ..CG
    };
    let error = solve_newton(
        model.problem,
        DirichletCg::new(&model.mesh, starved, GS),
        &model.mesh,
        &model.case.fixed_dofs,
        &model.case.fixed_values,
        &model.case.forces,
        settings(1),
    )
    .expect_err("two CG iterations cannot solve a correction");
    println!("{error}");
    let FemError::TangentSolve {
        increment,
        iteration,
        reason,
    } = error
    else {
        panic!("expected TangentSolve, got {error:?}");
    };
    assert_eq!((increment, iteration), (1, 1));
    assert!(reason.starts_with("CG did not converge"), "{reason}");
}

fn run_with_budget(budget: usize) -> (NewtonSolution, usize) {
    let mut run = start(manufactured(), GS, settings(2));
    let mut calls = 0;
    while run.advance(budget).expect("converges") != NewtonStatus::Converged {
        calls += 1;
    }
    (run.into_solution().expect("converged"), calls)
}

#[test]
fn stepping_in_small_cg_budgets_gives_the_same_result_as_one_go() {
    let (whole, whole_calls) = run_with_budget(usize::MAX);
    let (stepped, stepped_calls) = run_with_budget(3);
    println!("one go: {whole_calls} calls; budget 3: {stepped_calls} calls");
    assert!(
        stepped_calls > 2 * whole_calls,
        "the budget split the solves"
    );
    assert_eq!(stepped.displacements, whole.displacements);
    assert_eq!(stepped.increments, whole.increments);
}

#[test]
fn the_linear_solve_checks_refuse_a_load_on_an_unused_vertex() {
    let built = support::box_mesh([2, 1, 1], SIZE, steel());
    let mut points: Vec<f64> = built.vertices.iter().flatten().copied().collect();
    points.extend(built.size.map(|extent| 2.5 * extent));
    let tets: Vec<u32> = built.mesh.tets().iter().flatten().copied().collect();
    let mesh =
        TetMesh::new(&points, &tets, &vec![0; tets.len() / 4], vec![steel()]).expect("valid mesh");
    let mut case = load_case(&mesh);
    let unused = mesh.vertex_count() - 1;
    case.forces[3 * unused] = 1.0;
    let error = NewtonRun::start(
        LinearElastic::new(assemble_stiffness(&mesh)),
        DirichletCg::new(&mesh, CG, GS),
        &mesh,
        &case.fixed_dofs,
        &case.fixed_values,
        &case.forces,
        settings(1),
    )
    .err()
    .expect("refused");
    assert_eq!(error, FemError::LoadOnUnusedVertex { vertex: unused });
}

/// Supports that only move the body rigidly leave every force at round-off:
/// the force they exert on the held model is the increment's scale then.
#[test]
fn a_prescribed_rigid_motion_converges() {
    let mesh = tet_mesh(ElementOrder::Linear);
    let shift = [1e-3, -2e-3, 5e-4];
    let mut fixed_dofs = Vec::new();
    let mut fixed_values = Vec::new();
    for (vertex, point) in mesh.vertices().iter().enumerate() {
        if point[0] == 0.0 {
            for (component, &value) in shift.iter().enumerate() {
                fixed_dofs.push(3 * vertex as u32 + component as u32);
                fixed_values.push(value);
            }
        }
    }
    let solution = solve_newton(
        LinearElastic::new(assemble_stiffness(&mesh)),
        DirichletCg::new(&mesh, CG, GS),
        &mesh,
        &fixed_dofs,
        &fixed_values,
        &vec![0.0; mesh.dof_count()],
        settings(2),
    )
    .expect("converges");
    for node in solution.displacements.chunks(3) {
        for (value, expected) in node.iter().zip(shift) {
            assert!((value - expected).abs() < 1e-12, "{node:?}");
        }
    }
}

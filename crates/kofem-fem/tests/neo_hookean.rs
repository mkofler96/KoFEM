// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Compressible Neo-Hookean solids in a total-Lagrangian formulation, solved
//! by the Newton driver:
//!
//! * the element tangent is the derivative of the internal force (central
//!   differences), on every element type;
//! * under small loads the answer is the linear one, the difference shrinking
//!   as the load squared;
//! * a 90° rigid rotation stores no stress, where linear elasticity does;
//! * a uniaxial stretch matches the closed-form Neo-Hookean answer;
//! * a cantilever under a large tip load matches the elastica (Mattiasson
//!   1981);
//! * a column past its Euler load is refused as unstable, not solved.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::float_cmp,
    reason = "test fixtures: small structured meshes whose indices fit any integer type and \
              whose faces lie at exact coordinates, and a fixture that fails to build should \
              abort the test"
)]

mod support;

use kofem_fem::hyperelastic::{cauchy_corner_stress_tensors, cauchy_stress_tensors, NeoHookean};
use kofem_fem::nonlinear::{
    solve_newton, DirichletCg, NewtonSettings, NewtonSolution, NonlinearProblem,
};
use kofem_fem::{
    assemble_stiffness, solve_static, stress_tensors, AmgSettings, BoundaryFaces, CgSettings,
    CsrMatrix, ElementOrder, FemError, Isotropic, PreconditionerChoice, StoppingRule,
    SurfaceLoadKind, TetMesh,
};

const CG: CgSettings = CgSettings {
    relative_tolerance: 1e-12,
    max_iterations: 50_000,
    stopping: StoppingRule::ResidualNorm,
};
const GS: PreconditionerChoice = PreconditionerChoice::SymmetricGaussSeidel;

/// Multigrid, for the slender beams, where Gauss–Seidel needs thousands of
/// iterations per correction.
fn amg() -> PreconditionerChoice {
    PreconditionerChoice::SmoothedAggregation(AmgSettings::default())
}

fn material(young: f64, poisson: f64) -> Isotropic {
    Isotropic::new(0, young, poisson).expect("valid material")
}

fn settings(increments: u32) -> NewtonSettings {
    NewtonSettings {
        increments,
        max_iterations: 30,
        tolerance: 1e-10,
    }
}

/// Cube corner (bit 0 = x, bit 1 = y, bit 2 = z) of each CHEXA corner.
const CUBE_CORNER_OF_HEX: [usize; 8] = [0b000, 0b001, 0b011, 0b010, 0b100, 0b101, 0b111, 0b110];

/// `cells` hexahedra along each axis over a box of `size`.
fn hex_box(cells: [usize; 3], size: [f64; 3], material: Isotropic) -> support::BoxMesh {
    let [nx, ny, nz] = cells;
    let index = |ix: usize, iy: usize, iz: usize| ix + (nx + 1) * (iy + (ny + 1) * iz);
    let mut points = Vec::new();
    for iz in 0..=nz {
        for iy in 0..=ny {
            for ix in 0..=nx {
                points.extend([
                    size[0] * ix as f64 / nx as f64,
                    size[1] * iy as f64 / ny as f64,
                    size[2] * iz as f64 / nz as f64,
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
    let mesh = TetMesh::with_hexahedra(&points, &[], &hexes, &materials, vec![material])
        .expect("valid hexes");
    support::BoxMesh {
        vertices: mesh.vertices().to_vec(),
        mesh,
        size,
    }
}

#[derive(Clone, Copy, Debug)]
enum Kind {
    Tet4,
    Tet10,
    Hex8,
    Hex27,
}

const KINDS: [Kind; 4] = [Kind::Tet4, Kind::Tet10, Kind::Hex8, Kind::Hex27];

fn order(kind: Kind) -> ElementOrder {
    match kind {
        Kind::Tet4 | Kind::Hex8 => ElementOrder::Linear,
        Kind::Tet10 | Kind::Hex27 => ElementOrder::Quadratic,
    }
}

/// A box of `size`, meshed with `kind`.
fn box_of(kind: Kind, cells: [usize; 3], size: [f64; 3], material: Isotropic) -> support::BoxMesh {
    let linear = match kind {
        Kind::Tet4 | Kind::Tet10 => support::box_mesh(cells, size, material),
        Kind::Hex8 | Kind::Hex27 => hex_box(cells, size, material),
    };
    support::BoxMesh {
        mesh: linear.mesh.with_order(order(kind)).expect("fits"),
        ..linear
    }
}

/// One distorted element of `kind`: no edge parallel to an axis, and a hex
/// that is not a parallelepiped.
fn single_element(kind: Kind) -> TetMesh {
    let soft = material(1000.0, 0.3);
    let linear = match kind {
        Kind::Tet4 | Kind::Tet10 => TetMesh::new(
            &[0.1, -0.2, 0.0, 1.3, 0.1, 0.2, 0.2, 0.9, -0.1, 0.3, 0.2, 1.1],
            &[0, 1, 2, 3],
            &[0],
            vec![soft],
        ),
        Kind::Hex8 | Kind::Hex27 => TetMesh::with_hexahedra(
            &[
                0.0, 0.0, 0.0, 1.2, 0.1, -0.1, 1.1, 1.0, 0.1, -0.1, 0.9, 0.0, 0.1, -0.1, 1.0, 1.0,
                0.0, 1.2, 1.3, 1.2, 0.9, 0.0, 1.0, 1.1,
            ],
            &[],
            &[0, 1, 2, 3, 4, 5, 6, 7],
            &[0],
            vec![soft],
        ),
    };
    linear
        .expect("valid element")
        .with_order(order(kind))
        .expect("fits")
}

/// A deterministic displacement of every DOF in [−amplitude, amplitude]: a
/// finite strain of the order of `amplitude`, with no symmetry.
fn scrambled(count: usize, amplitude: f64) -> Vec<f64> {
    (0..count)
        .map(|dof| amplitude * (1.7 * dof as f64 + 0.3).sin())
        .collect()
}

fn evaluate(problem: &mut NeoHookean, displacements: &[f64]) -> (Vec<f64>, CsrMatrix) {
    let mut tangent = problem.tangent_pattern();
    let force = problem
        .internal_force_and_tangent(displacements, &mut tangent)
        .expect("valid state");
    (force, tangent)
}

#[test]
fn the_tangent_matches_central_differences_of_the_internal_force_on_every_element_type() {
    for kind in KINDS {
        let mesh = single_element(kind);
        let mut problem = NeoHookean::new(&mesh);
        let displacements = scrambled(mesh.dof_count(), 0.08);
        let (_, tangent) = evaluate(&mut problem, &displacements);
        let scale = tangent
            .values()
            .iter()
            .fold(0.0_f64, |max, value| max.max(value.abs()));
        let step = 1e-6;
        for column in 0..mesh.dof_count() {
            let mut ahead = displacements.clone();
            ahead[column] += step;
            let mut behind = displacements.clone();
            behind[column] -= step;
            let (force_ahead, _) = evaluate(&mut problem, &ahead);
            let (force_behind, _) = evaluate(&mut problem, &behind);
            for row in 0..mesh.dof_count() {
                let difference = (force_ahead[row] - force_behind[row]) / (2.0 * step);
                let entry = tangent
                    .find(row, column)
                    .map_or(0.0, |position| tangent.values()[position]);
                assert!(
                    (difference - entry).abs() <= 1e-6 * scale,
                    "{kind:?}: tangent ({row}, {column}) is {entry}, the force difference \
                     {difference}"
                );
            }
        }
    }
}

#[test]
fn the_tangent_is_symmetric_and_at_rest_is_the_linear_stiffness() {
    for kind in KINDS {
        let mesh = single_element(kind);
        let mut problem = NeoHookean::new(&mesh);
        let (force, tangent) = evaluate(&mut problem, &vec![0.0; mesh.dof_count()]);
        assert!(
            force.iter().all(|value| *value == 0.0),
            "{kind:?}: no force at rest"
        );
        let stiffness = assemble_stiffness(&mesh);
        let scale = stiffness
            .values()
            .iter()
            .fold(0.0_f64, |max, value| max.max(value.abs()));
        for (lhs, rhs) in tangent.values().iter().zip(stiffness.values()) {
            assert!(
                (lhs - rhs).abs() <= 1e-12 * scale,
                "{kind:?}: tangent at rest {lhs}, stiffness {rhs}"
            );
        }
        let (_, deformed) = evaluate(&mut problem, &scrambled(mesh.dof_count(), 0.08));
        for row in 0..mesh.dof_count() {
            for position in deformed.row_range(row) {
                let column = deformed.columns()[position] as usize;
                let mirror = deformed.find(column, row).expect("symmetric pattern");
                assert!(
                    (deformed.values()[position] - deformed.values()[mirror]).abs()
                        <= 1e-10 * scale,
                    "{kind:?}: tangent not symmetric at ({row}, {column})"
                );
            }
        }
    }
}

#[test]
fn an_element_turned_inside_out_is_refused_by_name() {
    let mesh = single_element(Kind::Tet4);
    let mut problem = NeoHookean::new(&mesh);
    // Push the apex through the opposite face.
    let mut displacements = vec![0.0; mesh.dof_count()];
    displacements[3 * 3 + 2] = -2.0;
    let mut tangent = problem.tangent_pattern();
    let error = problem
        .internal_force_and_tangent(&displacements, &mut tangent)
        .expect_err("inverted");
    assert!(
        matches!(error, FemError::InvertedElement { element: 0, .. }),
        "{error}"
    );
}

/// A cantilever box 2 × 1 × 1: the x = 0 face clamped, a downward force on
/// the far top edge's vertices totalling `load`.
struct Cantilever {
    fixed_dofs: Vec<u32>,
    fixed_values: Vec<f64>,
    forces: Vec<f64>,
}

fn cantilever(boxed: &support::BoxMesh, load: f64) -> Cantilever {
    let mesh = &boxed.mesh;
    let mut fixed_dofs = Vec::new();
    let mut fixed_values = Vec::new();
    let mut forces = vec![0.0; mesh.dof_count()];
    let tip: Vec<usize> = mesh
        .vertices()
        .iter()
        .enumerate()
        .filter(|(_, point)| point[0] == boxed.size[0] && point[2] == boxed.size[2])
        .map(|(vertex, _)| vertex)
        .collect();
    for (vertex, point) in mesh.vertices().iter().enumerate() {
        if point[0] == 0.0 {
            let dof = 3 * vertex as u32;
            fixed_dofs.extend([dof, dof + 1, dof + 2]);
            fixed_values.extend([0.0; 3]);
        }
    }
    for vertex in &tip {
        forces[3 * vertex + 2] = -load / tip.len() as f64;
    }
    Cantilever {
        fixed_dofs,
        fixed_values,
        forces,
    }
}

fn newton(mesh: &TetMesh, case: &Cantilever, increments: u32) -> NewtonSolution {
    solve_newton(
        NeoHookean::new(mesh),
        DirichletCg::new(mesh, CG, GS),
        mesh,
        &case.fixed_dofs,
        &case.fixed_values,
        &case.forces,
        settings(increments),
    )
    .expect("converges")
}

fn norm(values: impl Iterator<Item = f64>) -> f64 {
    values.map(|value| value * value).sum::<f64>().sqrt()
}

#[test]
fn under_small_loads_the_answer_is_linear_with_a_difference_shrinking_as_the_load_squared() {
    // E = 1000 and a tip load of 1e-3 bend the box to a strain near 1e-5.
    for kind in KINDS {
        let boxed = box_of(kind, [2, 1, 1], [2.0, 1.0, 1.0], material(1000.0, 0.3));
        let mesh = &boxed.mesh;
        let mut differences = Vec::new();
        for load in [1e-3, 0.5e-3] {
            let case = cantilever(&boxed, load);
            let linear = solve_static(
                mesh,
                &assemble_stiffness(mesh),
                &case.fixed_dofs,
                &case.fixed_values,
                &case.forces,
                CG,
                GS,
            )
            .expect("linear solve");
            let nonlinear = newton(mesh, &case, 1);
            let difference = norm(
                nonlinear
                    .displacements
                    .iter()
                    .zip(&linear.displacements)
                    .map(|(lhs, rhs)| lhs - rhs),
            );
            let size = norm(linear.displacements.iter().copied());
            assert!(
                difference <= 1e-3 * size,
                "{kind:?}: load {load}: differs from the linear answer by {difference} of {size}"
            );
            differences.push(difference);
        }
        let ratio = differences[0] / differences[1];
        assert!(
            (3.8..=4.2).contains(&ratio),
            "{kind:?}: halving the load divides the difference by {ratio}, not 4"
        );
    }
}

/// Rotation by 90° about z: (x, y, z) → (−y, x, z).
fn quarter_turn(point: [f64; 3]) -> [f64; 3] {
    [-point[1], point[0], point[2]]
}

#[test]
fn a_ninety_degree_rigid_rotation_stores_no_stress_where_linear_elasticity_does() {
    let young = 1000.0;
    for kind in KINDS {
        let mesh = box_of(kind, [2, 1, 1], [2.0, 1.0, 1.0], material(young, 0.3)).mesh;
        let mut displacements = vec![0.0; mesh.dof_count()];
        for (node, point) in mesh.node_coordinates().iter().enumerate() {
            let turned = quarter_turn(*point);
            for axis in 0..3 {
                displacements[3 * node + axis] = turned[axis] - point[axis];
            }
        }
        let largest = |tensors: &[[f64; 6]]| {
            tensors
                .iter()
                .flatten()
                .fold(0.0_f64, |max, value| max.max(value.abs()))
        };
        let cauchy = cauchy_stress_tensors(&mesh, &displacements).expect("valid");
        let corners = cauchy_corner_stress_tensors(&mesh, &displacements).expect("valid");
        assert!(largest(&cauchy) <= 1e-10 * young, "{kind:?}: {cauchy:?}");
        assert!(largest(&corners) <= 1e-10 * young, "{kind:?}: {corners:?}");
        let linear = stress_tensors(&mesh, &displacements).expect("valid");
        assert!(
            largest(&linear) >= 0.5 * young,
            "{kind:?}: linear elasticity should see a strain of order 1"
        );
        let mut problem = NeoHookean::new(&mesh);
        let (force, _) = evaluate(&mut problem, &displacements);
        assert!(
            norm(force.into_iter()) <= 1e-10 * young,
            "{kind:?}: a rigid rotation needs no force"
        );
    }
}

#[test]
fn turning_one_face_through_ninety_degrees_turns_the_body_rigidly() {
    let young = 1000.0;
    let mesh = box_of(Kind::Hex8, [2, 1, 1], [2.0, 1.0, 1.0], material(young, 0.3)).mesh;
    let mut fixed_dofs = Vec::new();
    let mut fixed_values = Vec::new();
    for (vertex, point) in mesh.vertices().iter().enumerate() {
        if point[0] == 0.0 {
            let turned = quarter_turn(*point);
            for axis in 0..3 {
                fixed_dofs.push((3 * vertex + axis) as u32);
                fixed_values.push(turned[axis] - point[axis]);
            }
        }
    }
    // Each increment turns the face by a straight-line move of its corners,
    // which is no rotation until the last; the body follows, unstrained.
    let solution = solve_newton(
        NeoHookean::new(&mesh),
        DirichletCg::new(&mesh, CG, GS),
        &mesh,
        &fixed_dofs,
        &fixed_values,
        &vec![0.0; mesh.dof_count()],
        settings(8),
    )
    .expect("converges");
    for (vertex, point) in mesh.vertices().iter().enumerate() {
        let turned = quarter_turn(*point);
        for axis in 0..3 {
            let moved = point[axis] + solution.displacements[3 * vertex + axis];
            assert!(
                (moved - turned[axis]).abs() <= 1e-8,
                "vertex {vertex} axis {axis}: at {moved}, expected {}",
                turned[axis]
            );
        }
    }
}

/// The lateral stretch of a Neo-Hookean bar stretched by `stretch` along x
/// and free laterally: the root of μ·(λ₂² − 1) + λ·ln(stretch·λ₂²) = 0, the
/// condition σ₂₂ = 0, found by bisection (the left side grows with λ₂).
fn lateral_stretch(lambda: f64, mu: f64, stretch: f64) -> f64 {
    let condition =
        |lateral: f64| mu * (lateral * lateral - 1.0) + lambda * (stretch * lateral * lateral).ln();
    let (mut low, mut high) = (0.1, 2.0);
    for _ in 0..200 {
        let middle = f64::midpoint(low, high);
        if condition(middle) > 0.0 {
            high = middle;
        } else {
            low = middle;
        }
    }
    f64::midpoint(low, high)
}

#[test]
fn a_uniaxial_stretch_matches_the_closed_form_neo_hookean_answer() {
    let young = 1000.0;
    let iso = material(young, 0.3);
    let (lambda, mu) = iso.lame();
    let stretch = 1.5;
    let lateral = lateral_stretch(lambda, mu, stretch);
    let jacobian = stretch * lateral * lateral;
    // σ = μ/J·(b − I) + λ/J·ln J·I, with b = diag(stretch², lateral²,
    // lateral²).
    let sigma_xx = (mu * (stretch * stretch - 1.0) + lambda * jacobian.ln()) / jacobian;
    for kind in KINDS {
        let boxed = box_of(kind, [2, 2, 2], [1.0, 1.0, 1.0], iso);
        let mesh = &boxed.mesh;
        // Symmetry planes x = 0, y = 0, z = 0; the x = 1 face pulled.
        let mut fixed_dofs = Vec::new();
        let mut fixed_values = Vec::new();
        for (vertex, point) in boxed.vertices.iter().enumerate() {
            for (axis, coordinate) in point.iter().enumerate() {
                if *coordinate == 0.0 {
                    fixed_dofs.push((3 * vertex + axis) as u32);
                    fixed_values.push(0.0);
                }
            }
            if point[0] == boxed.size[0] {
                fixed_dofs.push(3 * vertex as u32);
                fixed_values.push(stretch - 1.0);
            }
        }
        let solution = solve_newton(
            NeoHookean::new(mesh),
            DirichletCg::new(mesh, CG, GS),
            mesh,
            &fixed_dofs,
            &fixed_values,
            &vec![0.0; mesh.dof_count()],
            settings(5),
        )
        .expect("converges");
        for (vertex, point) in mesh.vertices().iter().enumerate() {
            for axis in 1..3 {
                let expected = (lateral - 1.0) * point[axis];
                let got = solution.displacements[3 * vertex + axis];
                assert!(
                    (got - expected).abs() <= 1e-8,
                    "{kind:?}: vertex {vertex} axis {axis}: {got}, expected {expected}"
                );
            }
        }
        let tensors = cauchy_stress_tensors(mesh, &solution.displacements).expect("valid");
        for (element, tensor) in tensors.iter().enumerate() {
            let expected = [sigma_xx, 0.0, 0.0, 0.0, 0.0, 0.0];
            for (got, want) in tensor.iter().zip(expected) {
                assert!(
                    (got - want).abs() <= 1e-7 * young,
                    "{kind:?}: element {element}: σ = {tensor:?}, expected σxx = {sigma_xx}"
                );
            }
        }
        // The pulling force: σxx on the current area lateral² of the face.
        let mut problem = NeoHookean::new(mesh);
        let (force, _) = evaluate(&mut problem, &solution.displacements);
        let pull: f64 = mesh
            .node_coordinates()
            .iter()
            .enumerate()
            .filter(|(_, point)| point[0] == 1.0)
            .map(|(node, _)| force[3 * node])
            .sum();
        let expected = sigma_xx * lateral * lateral;
        assert!(
            (pull - expected).abs() <= 1e-8 * expected,
            "{kind:?}: pulling force {pull}, expected {expected}"
        );
    }
}

/// A slender beam of 27-node hexahedra along x, `length` × `depth` × `depth`,
/// clamped at x = 0, with the vertex quadruple of its free end face.
struct Beam {
    mesh: TetMesh,
    clamp_dofs: Vec<u32>,
    end_face: [u32; 4],
    /// The node at the centre of the end face, on the beam axis.
    end_centre: usize,
}

fn beam(length: f64, depth: f64, cells: usize, iso: Isotropic) -> Beam {
    let mesh = hex_box([cells, 1, 1], [length, depth, depth], iso)
        .mesh
        .with_order(ElementOrder::Quadratic)
        .expect("fits");
    let mut clamp_dofs = Vec::new();
    let mut end_face = Vec::new();
    for (vertex, point) in mesh.vertices().iter().enumerate() {
        if point[0] == 0.0 {
            let dof = 3 * vertex as u32;
            clamp_dofs.extend([dof, dof + 1, dof + 2]);
        }
        if point[0] == length {
            end_face.push(vertex as u32);
        }
    }
    // Cyclic order around the square end face: (y, z) = (0,0), (d,0), (d,d), (0,d).
    end_face.sort_by(|lhs, rhs| {
        let key = |vertex: &u32| {
            let point = mesh.vertices()[*vertex as usize];
            match (point[1] > 0.0, point[2] > 0.0) {
                (false, false) => 0,
                (true, false) => 1,
                (true, true) => 2,
                (false, true) => 3,
            }
        };
        key(lhs).cmp(&key(rhs))
    });
    let end_centre = mesh
        .node_coordinates()
        .iter()
        .position(|point| point[0] == length && point[1] == depth / 2.0 && point[2] == depth / 2.0)
        .expect("a 27-node hex has a node at each face centre");
    Beam {
        mesh,
        clamp_dofs,
        end_face: end_face.try_into().expect("four corners"),
        end_centre,
    }
}

/// The force `force` spread over the end face as a uniform traction.
fn end_load(beam: &Beam, force: [f64; 3]) -> Vec<f64> {
    let mut forces = vec![0.0; beam.mesh.dof_count()];
    BoundaryFaces::new(&beam.mesh)
        .apply(
            &beam.mesh,
            0,
            &[],
            &[beam.end_face],
            SurfaceLoadKind::Force(force),
            &mut forces,
        )
        .expect("the end face is on the boundary");
    forces
}

/// Mattiasson (IJNME 17, 1981, 145–153), Table 1: a cantilever under a dead
/// tip load P with P·L²/(E·I) = 2 deflects by v/L = 0.49346 across and
/// shortens by u/L = 0.16064 along its axis (the elastica, inextensible and
/// without shear). A beam 50 times longer than deep, with ν = 0, is that
/// beam to well within half a percent.
#[test]
fn a_cantilever_under_a_large_tip_load_matches_the_elastica() {
    let (length, depth, young) = (10.0, 0.2, 1.0e6);
    let beam = beam(length, depth, 20, material(young, 0.0));
    let inertia = depth.powi(4) / 12.0;
    let load = 2.0 * young * inertia / (length * length);
    let forces = end_load(&beam, [0.0, 0.0, -load]);
    let solution = solve_newton(
        NeoHookean::new(&beam.mesh),
        DirichletCg::new(&beam.mesh, CG, amg()),
        &beam.mesh,
        &beam.clamp_dofs,
        &vec![0.0; beam.clamp_dofs.len()],
        &forces,
        settings(10),
    )
    .expect("converges");
    let tip = &solution.displacements[3 * beam.end_centre..3 * beam.end_centre + 3];
    let (across, along) = (-tip[2] / length, -tip[0] / length);
    println!("tip: v/L = {across:.5} (elastica 0.49346), u/L = {along:.5} (elastica 0.16064)");
    assert!(
        (across - 0.49346).abs() <= 0.005 * 0.49346,
        "tip deflection v/L = {across}, the elastica 0.49346"
    );
    assert!(
        (along - 0.16064).abs() <= 0.005 * 0.16064,
        "tip shortening u/L = {along}, the elastica 0.16064"
    );
}

/// A perfect column clamped at x = 0 and pushed along its axis at the free
/// end: it buckles at Euler's load π²·E·I/(4·L²). Below, the straight column
/// is the answer; above, it is an unstable equilibrium, which the solve must
/// refuse rather than return.
fn column(load_over_euler: f64, increments: u32) -> Result<NewtonSolution, FemError> {
    let (length, depth, young) = (10.0, 0.2, 1.0e6);
    let beam = beam(length, depth, 20, material(young, 0.0));
    let inertia = depth.powi(4) / 12.0;
    let euler = std::f64::consts::PI.powi(2) * young * inertia / (4.0 * length * length);
    let forces = end_load(&beam, [-load_over_euler * euler, 0.0, 0.0]);
    solve_newton(
        NeoHookean::new(&beam.mesh),
        DirichletCg::new(&beam.mesh, CG, amg()),
        &beam.mesh,
        &beam.clamp_dofs,
        &vec![0.0; beam.clamp_dofs.len()],
        &forces,
        settings(increments),
    )
}

#[test]
fn a_column_below_its_euler_load_stays_straight() {
    let solution = column(0.7, 1).expect("stable");
    let sideways = solution.displacements.chunks(3).fold(0.0_f64, |max, node| {
        max.max(node[1].abs()).max(node[2].abs())
    });
    assert!(sideways <= 1e-8, "the column moved sideways by {sideways}");
}

#[test]
fn a_column_past_its_euler_load_is_refused_as_unstable() {
    // Increment 1 (0.7 of Euler's load) is stable; increment 2 (1.4) is not.
    let error = column(1.4, 2).expect_err("unstable");
    assert!(
        matches!(
            error,
            FemError::TangentNotPositiveDefinite {
                increment: 2,
                increments: 2,
                ..
            }
        ),
        "{error}"
    );
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Surface-to-point couplings in the solid solve, against closed-form
//! results. Linear tets reproduce a uniform stress state exactly, so an axial
//! bar loaded through a coupling has an exact answer whatever the mesh; the
//! bending cases are checked by equilibrium (support reactions against the
//! applied loads), which holds exactly on any mesh.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

mod support;

use kofem_fem::{
    assemble_stiffness, prepare_coupled_static, solve_coupled_static, AmgSettings, CgSettings,
    CoupledSolution, Coupling, CouplingKind, CsrMatrix, FemError, Isotropic, PreconditionerChoice,
    StoppingRule, TetMesh, ALL_DOFS, DOFS_PER_NODE,
};
use support::box_mesh;

const YOUNG: f64 = 210_000.0;
const POISSON: f64 = 0.3;
const LENGTH: f64 = 100.0;
const HEIGHT: f64 = 10.0;

const SETTINGS: CgSettings = CgSettings {
    relative_tolerance: 1e-11,
    max_iterations: 20_000,
    stopping: StoppingRule::ResidualNorm,
};

/// Small enough that the test meshes get several levels, so the rotation
/// blocks of the reference points are aggregated too.
const DEEP: AmgSettings = AmgSettings {
    strength_threshold: 0.0,
    coarse_size: 60,
    max_levels: 10,
};

fn steel() -> Isotropic {
    Isotropic::new(0, YOUNG, POISSON).expect("valid material")
}

/// Bars along x of `HEIGHT` × `HEIGHT` section, each meshed on its own, plus
/// free points (reference points) that no element uses.
struct Model {
    mesh: TetMesh,
    points: Vec<[f64; 3]>,
    stiffness: CsrMatrix,
}

impl Model {
    /// One bar per x-offset in `starts`, `cells` cubes along each, then the
    /// extra `free` points.
    fn new(starts: &[f64], length: f64, cells: usize, free: &[[f64; 3]]) -> Self {
        let mut points: Vec<[f64; 3]> = Vec::new();
        let mut tets: Vec<u32> = Vec::new();
        for &start in starts {
            let bar = box_mesh([cells, 2, 2], [length, HEIGHT, HEIGHT], steel());
            assert!((bar.size[0] - length).abs() < 1e-12);
            let offset = points.len() as u32;
            points.extend(
                bar.vertices
                    .iter()
                    .map(|point| [point[0] + start, point[1], point[2]]),
            );
            tets.extend(
                bar.mesh
                    .tets()
                    .iter()
                    .flatten()
                    .map(|&vertex| vertex + offset),
            );
        }
        points.extend_from_slice(free);
        let flat: Vec<f64> = points.iter().flatten().copied().collect();
        let materials = vec![0; tets.len() / 4];
        let mesh = TetMesh::new(&flat, &tets, &materials, vec![steel()]).expect("valid mesh");
        let stiffness = assemble_stiffness(&mesh);
        Self {
            mesh,
            points,
            stiffness,
        }
    }

    fn nodes_where(&self, predicate: impl Fn([f64; 3]) -> bool) -> Vec<usize> {
        (0..self.mesh.vertex_count())
            .filter(|&node| self.mesh.is_used(node) && predicate(self.points[node]))
            .collect()
    }

    fn node_at(&self, target: [f64; 3]) -> usize {
        let found = self.nodes_where(|point| distance(point, target) < 1e-9);
        assert_eq!(found.len(), 1, "one element node at {target:?}");
        found[0]
    }

    fn solve(
        &self,
        couplings: &[Coupling],
        fixed: &[(usize, f64)],
        forces: &[f64],
        preconditioner: PreconditionerChoice,
    ) -> Result<CoupledSolution, FemError> {
        let dofs: Vec<u32> = fixed.iter().map(|&(dof, _)| dof as u32).collect();
        let values: Vec<f64> = fixed.iter().map(|&(_, value)| value).collect();
        solve_coupled_static(
            &self.mesh,
            &self.stiffness,
            couplings,
            &dofs,
            &values,
            forces,
            SETTINGS,
            preconditioner,
        )
    }

    fn reactions(
        &self,
        couplings: &[Coupling],
        fixed: &[(usize, f64)],
        forces: &[f64],
    ) -> Vec<f64> {
        let solution = self
            .solve(couplings, fixed, forces, amg())
            .expect("the model solves");
        let dofs: Vec<u32> = fixed.iter().map(|&(dof, _)| dof as u32).collect();
        let values: Vec<f64> = fixed.iter().map(|&(_, value)| value).collect();
        let prepared = prepare_coupled_static(
            &self.mesh,
            &self.stiffness,
            couplings,
            &dofs,
            &values,
            forces,
            amg(),
        )
        .expect("the model is valid");
        prepared
            .reduction
            .reactions(&self.stiffness, &solution.dofs, forces)
            .expect("vectors fit")
    }

    fn dof_count(&self) -> usize {
        DOFS_PER_NODE * self.mesh.vertex_count()
    }
}

fn amg() -> PreconditionerChoice {
    PreconditionerChoice::SmoothedAggregation(DEEP)
}

fn distance(lhs: [f64; 3], rhs: [f64; 3]) -> f64 {
    (0..3)
        .map(|axis| (lhs[axis] - rhs[axis]).powi(2))
        .sum::<f64>()
        .sqrt()
}

fn dof(node: usize, component: usize) -> usize {
    DOFS_PER_NODE * node + component
}

fn kinematic(reference: usize, nodes: Vec<usize>, dof_mask: u8) -> Coupling {
    Coupling {
        reference,
        nodes,
        weights: Vec::new(),
        kind: CouplingKind::Kinematic { dof_mask },
    }
}

fn distributing(reference: usize, nodes: Vec<usize>) -> Coupling {
    Coupling {
        reference,
        nodes,
        weights: Vec::new(),
        kind: CouplingKind::Distributing,
    }
}

/// The minimal supports of an axial bar starting at `start`: `u_x = 0` on its
/// end face, and its corner nodes holding the lateral rigid-body motion, so
/// the section contracts freely and the stress stays uniform.
fn axial_supports(model: &Model, start: f64) -> Vec<(usize, f64)> {
    let mut fixed: Vec<(usize, f64)> = model
        .nodes_where(|point| (point[0] - start).abs() < 1e-9)
        .into_iter()
        .map(|node| (dof(node, 0), 0.0))
        .collect();
    let origin = model.node_at([start, 0.0, 0.0]);
    let side = model.node_at([start, HEIGHT, 0.0]);
    fixed.extend([
        (dof(origin, 1), 0.0),
        (dof(origin, 2), 0.0),
        (dof(side, 2), 0.0),
    ]);
    fixed
}

fn relative_error(value: f64, expected: f64) -> f64 {
    (value - expected).abs() / expected.abs()
}

/// Bit mask of the x translation only.
const X_ONLY: u8 = 0b1;

#[test]
fn a_force_through_a_kinematic_coupling_stretches_a_bar_exactly() {
    let reference = [LENGTH, HEIGHT / 2.0, HEIGHT / 2.0];
    let model = Model::new(&[0.0], LENGTH, 8, &[reference]);
    let point = model.mesh.vertex_count() - 1;
    let tip = model.nodes_where(|node| (node[0] - LENGTH).abs() < 1e-9);
    // Tie only u_x of the tip face to the point, so the section still
    // contracts freely and the stress stays uniform.
    let couplings = [kinematic(point, tip.clone(), X_ONLY)];
    let force = 1000.0;
    let mut forces = vec![0.0; model.dof_count()];
    forces[dof(point, 0)] = force;
    let fixed = axial_supports(&model, 0.0);

    let solution = model
        .solve(&couplings, &fixed, &forces, amg())
        .expect("the bar solves");
    let area = HEIGHT * HEIGHT;
    let stretch = force * LENGTH / (YOUNG * area);
    assert!(relative_error(solution.dofs[dof(point, 0)], stretch) < 1e-8);
    for &node in &tip {
        assert!(relative_error(solution.dofs[dof(node, 0)], stretch) < 1e-8);
    }
    // Free lateral contraction: u_y = −ν·σ/E·y on the top edge.
    let top = model.node_at([LENGTH, HEIGHT, 0.0]);
    let contraction = -POISSON * force / (YOUNG * area) * HEIGHT;
    assert!(relative_error(solution.dofs[dof(top, 1)], contraction) < 1e-7);
    // A uniform stretch turns the point by nothing.
    for axis in 3..6 {
        assert!(solution.dofs[dof(point, axis)].abs() < 1e-8 * stretch / HEIGHT);
    }
    // The root carries the whole force.
    let reactions = model.reactions(&couplings, &fixed, &forces);
    let root: f64 = model
        .nodes_where(|node| node[0].abs() < 1e-9)
        .iter()
        .map(|&node| reactions[dof(node, 0)])
        .sum();
    assert!(relative_error(root, -force) < 1e-8);
}

#[test]
fn a_chain_of_couplings_joins_two_bars_into_one() {
    // Bars [0, L] and [L, 2L] meshed apart, each end face tied (u_x only) to a
    // point at the joint, the two points tied rigidly to each other, and the
    // far tip tied to a third point that carries the load: four couplings in
    // a chain, which must act as one bar of length 2L.
    let joint = [LENGTH, HEIGHT / 2.0, HEIGHT / 2.0];
    let far = [2.0 * LENGTH, HEIGHT / 2.0, HEIGHT / 2.0];
    let model = Model::new(&[0.0, LENGTH], LENGTH, 6, &[joint, joint, far]);
    let count = model.mesh.vertex_count();
    let (point_a, point_b, point_tip) = (count - 3, count - 2, count - 1);
    let half = model.mesh.vertex_count() - 3;
    let bar_a = |node: usize| node < half / 2;
    let end_a = model.nodes_where(|point| (point[0] - LENGTH).abs() < 1e-9);
    let (end_a, start_b): (Vec<usize>, Vec<usize>) =
        end_a.into_iter().partition(|&node| bar_a(node));
    let tip = model.nodes_where(|point| (point[0] - 2.0 * LENGTH).abs() < 1e-9);
    let couplings = [
        kinematic(point_a, end_a, X_ONLY),
        kinematic(point_b, start_b.clone(), X_ONLY),
        kinematic(point_a, vec![point_b], ALL_DOFS),
        kinematic(point_tip, tip, X_ONLY),
    ];
    let force = 2500.0;
    let mut forces = vec![0.0; model.dof_count()];
    forces[dof(point_tip, 0)] = force;
    let mut fixed = axial_supports(&model, 0.0);
    // Bar B's lateral rigid-body motion, held at the nodes where bar A's
    // uniform contraction leaves the same displacement.
    let corner = |target: [f64; 3]| -> usize {
        *start_b
            .iter()
            .find(|&&node| distance(model.points[node], target) < 1e-9)
            .expect("bar B corner")
    };
    let origin_b = corner([LENGTH, 0.0, 0.0]);
    let side_b = corner([LENGTH, HEIGHT, 0.0]);
    fixed.extend([
        (dof(origin_b, 1), 0.0),
        (dof(origin_b, 2), 0.0),
        (dof(side_b, 2), 0.0),
    ]);

    let solution = model
        .solve(&couplings, &fixed, &forces, amg())
        .expect("the chain solves");
    let stretch = force * LENGTH / (YOUNG * HEIGHT * HEIGHT);
    assert!(relative_error(solution.dofs[dof(point_a, 0)], stretch) < 1e-8);
    assert!(relative_error(solution.dofs[dof(point_b, 0)], stretch) < 1e-8);
    assert!(relative_error(solution.dofs[dof(point_tip, 0)], 2.0 * stretch) < 1e-8);
}

/// Sum of the reactions at the given nodes' translations, as a force and a
/// moment about `centre`.
fn resultant(
    model: &Model,
    reactions: &[f64],
    nodes: &[usize],
    centre: [f64; 3],
) -> ([f64; 3], [f64; 3]) {
    let mut force = [0.0; 3];
    let mut moment = [0.0; 3];
    for &node in nodes {
        let reaction = [0, 1, 2].map(|axis| reactions[dof(node, axis)]);
        let arm = [0, 1, 2].map(|axis| model.points[node][axis] - centre[axis]);
        let turn = cross(arm, reaction);
        for axis in 0..3 {
            force[axis] += reaction[axis];
            moment[axis] += turn[axis];
        }
    }
    (force, moment)
}

fn cross(lhs: [f64; 3], rhs: [f64; 3]) -> [f64; 3] {
    [
        lhs[1] * rhs[2] - lhs[2] * rhs[1],
        lhs[2] * rhs[0] - lhs[0] * rhs[2],
        lhs[0] * rhs[1] - lhs[1] * rhs[0],
    ]
}

fn assert_balances(label: &str, actual: [f64; 3], applied: [f64; 3], scale: f64) {
    for axis in 0..3 {
        assert!(
            (actual[axis] + applied[axis]).abs() < 1e-8 * scale,
            "{label} {axis}: reaction {} against applied {}",
            actual[axis],
            applied[axis]
        );
    }
}

/// A cantilever clamped node by node at x = 0, with its tip face coupled to
/// a point at the face centre.
fn tip_coupled_cantilever() -> (Model, usize, Vec<usize>, Vec<(usize, f64)>) {
    let centre = [LENGTH, HEIGHT / 2.0, HEIGHT / 2.0];
    let model = Model::new(&[0.0], LENGTH, 8, &[centre]);
    let point = model.mesh.vertex_count() - 1;
    let tip = model.nodes_where(|node| (node[0] - LENGTH).abs() < 1e-9);
    let fixed = model
        .nodes_where(|node| node[0].abs() < 1e-9)
        .into_iter()
        .flat_map(|node| (0..3).map(move |axis| (dof(node, axis), 0.0)))
        .collect();
    (model, point, tip, fixed)
}

#[test]
fn a_moment_at_a_kinematic_point_reaches_the_supports() {
    let (model, point, tip, fixed) = tip_coupled_cantilever();
    let couplings = [kinematic(point, tip.clone(), ALL_DOFS)];
    let force = [0.0, 40.0, -300.0];
    let moment = [5000.0, -2000.0, 8000.0];
    let mut forces = vec![0.0; model.dof_count()];
    for axis in 0..3 {
        forces[dof(point, axis)] = force[axis];
        forces[dof(point, 3 + axis)] = moment[axis];
    }
    let solution = model
        .solve(&couplings, &fixed, &forces, amg())
        .expect("the cantilever solves");
    // The tip face moves as a rigid body with the point.
    let centre = model.points[point];
    let translation = [0, 1, 2].map(|axis| solution.dofs[dof(point, axis)]);
    let rotation = [3, 4, 5].map(|axis| solution.dofs[dof(point, axis)]);
    for &node in &tip {
        let arm = [0, 1, 2].map(|axis| model.points[node][axis] - centre[axis]);
        let turn = cross(rotation, arm);
        for axis in 0..3 {
            let rigid = translation[axis] + turn[axis];
            assert!((solution.dofs[dof(node, axis)] - rigid).abs() < 1e-12);
        }
    }
    // The root reacts the force and the moment about the point.
    let reactions = model.reactions(&couplings, &fixed, &forces);
    let root = model.nodes_where(|node| node[0].abs() < 1e-9);
    let (reaction_force, reaction_moment) = resultant(&model, &reactions, &root, centre);
    assert_balances("force", reaction_force, force, 300.0);
    assert_balances("moment", reaction_moment, moment, 8000.0);
}

#[test]
fn a_fixed_kinematic_point_holds_the_surface_it_grips() {
    let root_centre = [0.0, HEIGHT / 2.0, HEIGHT / 2.0];
    let model = Model::new(&[0.0], LENGTH, 8, &[root_centre]);
    let point = model.mesh.vertex_count() - 1;
    let root = model.nodes_where(|node| node[0].abs() < 1e-9);
    let couplings = [kinematic(point, root.clone(), ALL_DOFS)];
    let fixed: Vec<(usize, f64)> = (0..6).map(|axis| (dof(point, axis), 0.0)).collect();
    // An eccentric, skew tip load: forces at two tip corners.
    let corner = model.node_at([LENGTH, HEIGHT, HEIGHT]);
    let other = model.node_at([LENGTH, 0.0, HEIGHT]);
    let mut forces = vec![0.0; model.dof_count()];
    forces[dof(corner, 2)] = -250.0;
    forces[dof(corner, 1)] = 60.0;
    forces[dof(other, 0)] = 900.0;

    let solution = model
        .solve(&couplings, &fixed, &forces, amg())
        .expect("the cantilever solves");
    for &node in &root {
        for axis in 0..3 {
            assert!(solution.dofs[dof(node, axis)].abs() < 1e-14);
        }
    }
    // The point's six reactions balance the load about the point.
    let reactions = model.reactions(&couplings, &fixed, &forces);
    let force_at = |node: usize| [0, 1, 2].map(|axis| forces[dof(node, axis)]);
    let mut applied_force = [0.0; 3];
    let mut applied_moment = [0.0; 3];
    for node in [corner, other] {
        let arm = [0, 1, 2].map(|axis| model.points[node][axis] - root_centre[axis]);
        let turn = cross(arm, force_at(node));
        for axis in 0..3 {
            applied_force[axis] += force_at(node)[axis];
            applied_moment[axis] += turn[axis];
        }
    }
    let reaction_force = [0, 1, 2].map(|axis| reactions[dof(point, axis)]);
    let reaction_moment = [3, 4, 5].map(|axis| reactions[dof(point, axis)]);
    assert_balances("force", reaction_force, applied_force, 900.0);
    assert_balances("moment", reaction_moment, applied_moment, 900.0 * LENGTH);
}

#[test]
fn a_distributing_coupling_spreads_force_and_moment_as_their_equivalent_nodal_loads() {
    let (model, point, tip, fixed) = tip_coupled_cantilever();
    let couplings = [distributing(point, tip.clone())];
    let force = [120.0, -80.0, -300.0];
    let moment = [4000.0, 1500.0, -2500.0];
    let mut forces = vec![0.0; model.dof_count()];
    for axis in 0..3 {
        forces[dof(point, axis)] = force[axis];
        forces[dof(point, 3 + axis)] = moment[axis];
    }
    let coupled = model
        .solve(&couplings, &fixed, &forces, amg())
        .expect("the cantilever solves");
    // The point adds no stiffness: the reduced matrix is K without the
    // point's own (empty) block, with no fill between the coupled nodes.
    let dofs: Vec<u32> = fixed.iter().map(|&(dof, _)| dof as u32).collect();
    let prepared = prepare_coupled_static(
        &model.mesh,
        &model.stiffness,
        &couplings,
        &dofs,
        &vec![0.0; dofs.len()],
        &forces,
        amg(),
    )
    .expect("the model is valid");
    assert_eq!(
        prepared.prepared.system.matrix().nnz(),
        model.stiffness.nnz() - 9
    );

    // RBE3 with equal weights about the patch centroid: node i carries
    // F/N + (H⁻¹·M) × rᵢ, with H = Σ (|rᵢ|² I − rᵢrᵢᵀ).
    let centre = model.points[point];
    let arms: Vec<[f64; 3]> = tip
        .iter()
        .map(|&node| [0, 1, 2].map(|axis| model.points[node][axis] - centre[axis]))
        .collect();
    let mut inertia = [[0.0; 3]; 3];
    for arm in &arms {
        let squared: f64 = arm.iter().map(|value| value * value).sum();
        for row in 0..3 {
            for column in 0..3 {
                let diagonal = if row == column { squared } else { 0.0 };
                inertia[row][column] += diagonal - arm[row] * arm[column];
            }
        }
    }
    // The face is the plane x = L, so H is diagonal here.
    let spin = [0, 1, 2].map(|axis| moment[axis] / inertia[axis][axis]);
    for (row, line) in inertia.iter().enumerate() {
        for (column, value) in line.iter().enumerate() {
            if row != column {
                assert!(value.abs() < 1e-9);
            }
        }
    }
    let mut direct = vec![0.0; model.dof_count()];
    for (&node, arm) in tip.iter().zip(&arms) {
        let turn = cross(spin, *arm);
        for axis in 0..3 {
            direct[dof(node, axis)] = force[axis] / tip.len() as f64 + turn[axis];
        }
    }
    let reference = model
        .solve(&[], &fixed, &direct, amg())
        .expect("the directly loaded cantilever solves");
    let largest = reference
        .dofs
        .iter()
        .fold(0.0f64, |max, value| max.max(value.abs()));
    for node in 0..point {
        for axis in 0..3 {
            let difference = coupled.dofs[dof(node, axis)] - reference.dofs[dof(node, axis)];
            assert!(difference.abs() < 1e-8 * largest);
        }
    }
    // The point follows the mean of the face.
    for axis in 0..3 {
        let mean: f64 = tip
            .iter()
            .map(|&node| coupled.dofs[dof(node, axis)])
            .sum::<f64>()
            / tip.len() as f64;
        assert!((coupled.dofs[dof(point, axis)] - mean).abs() < 1e-12 * largest);
    }
    // And the root reacts force and moment about the point.
    let reactions = model.reactions(&couplings, &fixed, &forces);
    let root = model.nodes_where(|node| node[0].abs() < 1e-9);
    let (reaction_force, reaction_moment) = resultant(&model, &reactions, &root, centre);
    assert_balances("force", reaction_force, force, 300.0);
    assert_balances("moment", reaction_moment, moment, 4000.0);
}

#[test]
fn multigrid_and_gauss_seidel_agree_on_a_coupled_model() {
    let (model, point, tip, fixed) = tip_coupled_cantilever();
    let couplings = [kinematic(point, tip, ALL_DOFS)];
    let mut forces = vec![0.0; model.dof_count()];
    forces[dof(point, 2)] = -500.0;
    forces[dof(point, 3)] = 7000.0;
    let multigrid = model
        .solve(&couplings, &fixed, &forces, amg())
        .expect("AMG solves");
    let gauss_seidel = model
        .solve(
            &couplings,
            &fixed,
            &forces,
            PreconditionerChoice::SymmetricGaussSeidel,
        )
        .expect("Gauss–Seidel solves");
    assert!(multigrid.levels.len() >= 2, "levels {:?}", multigrid.levels);
    assert!(multigrid.iterations < gauss_seidel.iterations);
    let largest = gauss_seidel
        .dofs
        .iter()
        .fold(0.0f64, |max, value| max.max(value.abs()));
    for (lhs, rhs) in multigrid.dofs.iter().zip(&gauss_seidel.dofs) {
        assert!((lhs - rhs).abs() < 1e-8 * largest);
    }
}

fn expect_error(
    model: &Model,
    couplings: &[Coupling],
    fixed: &[(usize, f64)],
    forces: &[f64],
) -> FemError {
    model
        .solve(couplings, fixed, forces, amg())
        .expect_err("the model should be refused")
}

#[test]
fn modelling_errors_are_named() {
    let (model, point, tip, fixed) = tip_coupled_cantilever();
    let mut forces = vec![0.0; model.dof_count()];
    forces[dof(point, 2)] = -100.0;

    // Two kinematic couplings eliminating the same node.
    let error = expect_error(
        &model,
        &[
            kinematic(point, tip.clone(), ALL_DOFS),
            kinematic(point, vec![tip[0]], ALL_DOFS),
        ],
        &fixed,
        &forces,
    );
    assert_eq!(
        error,
        FemError::CouplingDofConflict {
            node: tip[0],
            component: 0
        }
    );

    // A distributing point cannot be fixed: the coupling dictates its motion.
    let mut clamped = fixed.clone();
    clamped.push((dof(point, 1), 0.0));
    let error = expect_error(
        &model,
        &[distributing(point, tip.clone())],
        &clamped,
        &forces,
    );
    assert_eq!(
        error,
        FemError::ConstraintOnCoupledDof {
            node: point,
            component: 1,
            what: "fixed"
        }
    );

    // A distributing coupling needs three nodes that do not lie on one line
    // with the point.
    let edge = model.nodes_where(|node| {
        (node[0] - LENGTH).abs() < 1e-9 && (node[2] - HEIGHT / 2.0).abs() < 1e-9
    });
    let error = expect_error(&model, &[distributing(point, edge)], &fixed, &forces);
    assert!(
        matches!(&error, FemError::Coupling { coupling: 0, reason } if reason.contains("one line")),
        "{error}"
    );
    let error = expect_error(
        &model,
        &[distributing(point, tip[..2].to_vec())],
        &fixed,
        &forces,
    );
    assert!(
        matches!(error, FemError::Coupling { coupling: 0, .. }),
        "{error}"
    );

    // A moment on a solid node has no rotation to act on.
    let mut moment = vec![0.0; model.dof_count()];
    moment[dof(tip[0], 4)] = 10.0;
    let error = expect_error(
        &model,
        &[kinematic(point, tip.clone(), ALL_DOFS)],
        &fixed,
        &moment,
    );
    assert_eq!(
        error,
        FemError::RotationWithoutDof {
            node: tip[0],
            component: 4,
            what: "moment"
        }
    );

    // A point no coupling uses cannot carry a load.
    let error = expect_error(&model, &[], &fixed, &forces);
    assert_eq!(
        error,
        FemError::LoadWithoutStiffness {
            node: point,
            component: 2
        }
    );
}

#[test]
fn couplings_that_depend_on_each_other_are_a_cycle() {
    let free = [
        [LENGTH, 0.5 * HEIGHT, 0.5 * HEIGHT],
        [LENGTH + 1.0, 0.5 * HEIGHT, 0.5 * HEIGHT],
    ];
    let model = Model::new(&[0.0], LENGTH, 4, &free);
    let count = model.mesh.vertex_count();
    let (first, second) = (count - 2, count - 1);
    let error = expect_error(
        &model,
        &[
            kinematic(first, vec![second], ALL_DOFS),
            kinematic(second, vec![first], ALL_DOFS),
        ],
        &[],
        &vec![0.0; model.dof_count()],
    );
    assert!(matches!(error, FemError::CouplingCycle { .. }), "{error}");
}

#[test]
fn shell_to_solid_couplings_need_shell_elements() {
    // The relaxed MPC and the shell footprint tie a shell to a solid; an
    // all-solid model has no shell for them to tie (the mixed solve does).
    let (model, point, tip, fixed) = tip_coupled_cantilever();
    for kind in [
        CouplingKind::RelaxedMpc { relaxation: 1.0 },
        CouplingKind::ShellFootprint,
    ] {
        let coupling = Coupling {
            reference: point,
            nodes: tip.clone(),
            weights: Vec::new(),
            kind,
        };
        let error = expect_error(&model, &[coupling], &fixed, &vec![0.0; model.dof_count()]);
        assert!(
            matches!(error, FemError::Coupling { coupling: 0, ref reason } if reason.contains("shell")),
            "{error}"
        );
    }
}

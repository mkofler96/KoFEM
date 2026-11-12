// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Surface-to-point couplings on quadratic (10-node) tetrahedra. The caller
//! names vertices only; the coupled solve brings the edge nodes along:
//!
//! * an edge whose two ends a coupling grips joins that coupling, so a
//!   kinematic surface stays rigid between its corners and a distributing
//!   coupling spreads its load over the edge nodes as well;
//! * an edge node whose two ends follow couplings in a component follows
//!   their mean in it (the linear interpolation along the edge);
//! * vertex supports extend to edge nodes as in the uncoupled solve.
//!
//! Each rule is checked against an uncoupled quadratic solve of the
//! equivalent model, which must agree to solver precision.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

mod support;

use kofem_fem::{
    assemble_stiffness, solve_coupled_static, solve_static, AmgSettings, CgSettings,
    CoupledSolution, Coupling, CouplingKind, CsrMatrix, ElementOrder, FemError, Isotropic,
    PreconditionerChoice, StoppingRule, TetMesh, ALL_DOFS, DOFS_PER_NODE,
};
use support::box_mesh;

const YOUNG: f64 = 210_000.0;
const POISSON: f64 = 0.3;
const LENGTH: f64 = 60.0;
const HEIGHT: f64 = 10.0;

const SETTINGS: CgSettings = CgSettings {
    relative_tolerance: 1e-12,
    max_iterations: 20_000,
    stopping: StoppingRule::ResidualNorm,
};

/// Small enough that the test meshes get several levels.
const DEEP: AmgSettings = AmgSettings {
    strength_threshold: 0.0,
    coarse_size: 60,
    max_levels: 10,
};

fn amg() -> PreconditionerChoice {
    PreconditionerChoice::SmoothedAggregation(DEEP)
}

fn steel() -> Isotropic {
    Isotropic::new(0, YOUNG, POISSON).expect("valid material")
}

/// Quadratic bars along x of `HEIGHT` × `HEIGHT` section, each meshed on its
/// own, plus free reference points; the edge nodes follow all vertices.
struct Model {
    mesh: TetMesh,
    stiffness: CsrMatrix,
}

impl Model {
    fn new(starts: &[f64], cells: usize, free: &[[f64; 3]]) -> Self {
        let mut points: Vec<[f64; 3]> = Vec::new();
        let mut tets: Vec<u32> = Vec::new();
        for &start in starts {
            let bar = box_mesh([cells, 2, 2], [LENGTH, HEIGHT, HEIGHT], steel());
            assert!((bar.size[0] - LENGTH).abs() < 1e-12);
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
        let mesh = TetMesh::new(&flat, &tets, &materials, vec![steel()])
            .and_then(|mesh| mesh.with_order(ElementOrder::Quadratic))
            .expect("valid mesh");
        let stiffness = assemble_stiffness(&mesh);
        Self { mesh, stiffness }
    }

    fn point(&self, node: usize) -> [f64; 3] {
        self.mesh.node_coordinates()[node]
    }

    /// Vertices (corner nodes) that an element uses and that satisfy `on`.
    fn vertices_where(&self, on: impl Fn([f64; 3]) -> bool) -> Vec<usize> {
        (0..self.mesh.vertex_count())
            .filter(|&node| self.mesh.is_used(node) && on(self.point(node)))
            .collect()
    }

    /// Edge nodes whose two ends satisfy `on`.
    fn edge_nodes_where(&self, on: impl Fn([f64; 3]) -> bool) -> Vec<usize> {
        let vertices = self.mesh.vertex_count();
        self.mesh
            .edges()
            .iter()
            .enumerate()
            .filter(|(_, ends)| ends.iter().all(|&end| on(self.point(end as usize))))
            .map(|(edge, _)| vertices + edge)
            .collect()
    }

    fn coupled(
        &self,
        couplings: &[Coupling],
        fixed: &[(usize, f64)],
        forces: &[f64],
    ) -> Result<CoupledSolution, FemError> {
        let (dofs, values) = split(fixed);
        solve_coupled_static(
            &self.mesh,
            &self.stiffness,
            couplings,
            &dofs,
            &values,
            forces,
            SETTINGS,
            amg(),
        )
    }

    /// The uncoupled solve, 3 DOFs per node.
    fn plain(&self, fixed: &[(usize, f64)], forces: &[f64]) -> Vec<f64> {
        let (dofs, values) = split(fixed);
        solve_static(
            &self.mesh,
            &self.stiffness,
            &dofs,
            &values,
            forces,
            SETTINGS,
            amg(),
        )
        .expect("the uncoupled model solves")
        .displacements
    }

    fn coupled_dof_count(&self) -> usize {
        DOFS_PER_NODE * self.mesh.node_count()
    }
}

fn split(fixed: &[(usize, f64)]) -> (Vec<u32>, Vec<f64>) {
    fixed
        .iter()
        .map(|&(dof, value)| (dof as u32, value))
        .unzip()
}

/// DOF of `component` at `node` in the coupled (6 per node) numbering.
fn six(node: usize, component: usize) -> usize {
    DOFS_PER_NODE * node + component
}

/// DOF of `component` at `node` in the uncoupled (3 per node) numbering.
fn three(node: usize, component: usize) -> usize {
    3 * node + component
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

fn at_x(value: f64) -> impl Fn([f64; 3]) -> bool {
    move |point| (point[0] - value).abs() < 1e-9
}

fn cross(lhs: [f64; 3], rhs: [f64; 3]) -> [f64; 3] {
    [
        lhs[1] * rhs[2] - lhs[2] * rhs[1],
        lhs[2] * rhs[0] - lhs[0] * rhs[2],
        lhs[0] * rhs[1] - lhs[1] * rhs[0],
    ]
}

fn largest(values: &[f64]) -> f64 {
    values
        .iter()
        .fold(0.0f64, |max, value| max.max(value.abs()))
}

/// Every node's translations of the coupled solution against the uncoupled
/// one, relative to the largest displacement — except the reference point,
/// which the uncoupled model does not have.
fn assert_same_field(coupled: &CoupledSolution, plain: &[f64], reference: usize) {
    let scale = largest(plain);
    assert!(scale > 0.0, "the reference solve moves");
    for node in (0..plain.len() / 3).filter(|&node| node != reference) {
        for axis in 0..3 {
            let difference = coupled.dofs[six(node, axis)] - plain[three(node, axis)];
            assert!(
                difference.abs() < 1e-8 * scale,
                "node {node} axis {axis}: coupled {} against uncoupled {}",
                coupled.dofs[six(node, axis)],
                plain[three(node, axis)]
            );
        }
    }
}

/// A quadratic cantilever with a reference point at the centre of its root
/// face (x = 0), and corner forces at its tip.
fn root_coupled() -> (Model, usize, Vec<usize>) {
    let model = Model::new(&[0.0], 6, &[[0.0, HEIGHT / 2.0, HEIGHT / 2.0]]);
    let point = model.mesh.vertex_count() - 1;
    let root = model.vertices_where(at_x(0.0));
    (model, point, root)
}

fn tip_corner_forces(model: &Model, per_node: usize) -> Vec<f64> {
    let mut forces = vec![0.0; per_node * model.mesh.node_count()];
    let corner = model.vertices_where(|point| {
        at_x(LENGTH)(point) && (point[1] - HEIGHT).abs() < 1e-9 && (point[2] - HEIGHT).abs() < 1e-9
    })[0];
    let other = model.vertices_where(|point| {
        at_x(LENGTH)(point) && point[1].abs() < 1e-9 && (point[2] - HEIGHT).abs() < 1e-9
    })[0];
    forces[per_node * corner + 2] = -250.0;
    forces[per_node * corner + 1] = 60.0;
    forces[per_node * other] = 900.0;
    forces
}

#[test]
fn a_fixed_kinematic_point_clamps_the_quadratic_face_it_grips() {
    let (model, point, root) = root_coupled();
    let couplings = [kinematic(point, root.clone(), ALL_DOFS)];
    let fixed: Vec<(usize, f64)> = (0..6).map(|axis| (six(point, axis), 0.0)).collect();
    let coupled = model
        .coupled(&couplings, &fixed, &tip_corner_forces(&model, 6))
        .expect("the coupled cantilever solves");

    // The same cantilever with its root vertices clamped: the uncoupled solve
    // clamps the root's edge nodes too, so both are one discrete problem.
    let clamped: Vec<(usize, f64)> = root
        .iter()
        .flat_map(|&node| (0..3).map(move |axis| (three(node, axis), 0.0)))
        .collect();
    let plain = model.plain(&clamped, &tip_corner_forces(&model, 3));
    assert_same_field(&coupled, &plain, point);
    for node in model.edge_nodes_where(at_x(0.0)) {
        for axis in 0..3 {
            assert!(coupled.dofs[six(node, axis)].abs() < 1e-14);
        }
    }
}

#[test]
fn a_driven_kinematic_point_moves_its_quadratic_face_as_a_rigid_body() {
    let (model, point, root) = root_coupled();
    let couplings = [kinematic(point, root.clone(), ALL_DOFS)];
    let translation = [0.01, -0.02, 0.005];
    let rotation = [0.0004, -0.0003, 0.0002];
    let fixed: Vec<(usize, f64)> = (0..3)
        .map(|axis| (six(point, axis), translation[axis]))
        .chain((0..3).map(|axis| (six(point, 3 + axis), rotation[axis])))
        .collect();
    let forces = vec![0.0; model.coupled_dof_count()];
    let coupled = model
        .coupled(&couplings, &fixed, &forces)
        .expect("the driven cantilever solves");

    // u = d + θ × r at every root node, corner or edge, and the uncoupled
    // solve with those displacements prescribed at the root vertices agrees.
    let centre = model.point(point);
    let rigid = |node: usize| -> [f64; 3] {
        let arm = [0, 1, 2].map(|axis| model.point(node)[axis] - centre[axis]);
        let turn = cross(rotation, arm);
        [0, 1, 2].map(|axis| translation[axis] + turn[axis])
    };
    for node in root
        .iter()
        .copied()
        .chain(model.edge_nodes_where(at_x(0.0)))
    {
        let expected = rigid(node);
        for axis in 0..3 {
            assert!(
                (coupled.dofs[six(node, axis)] - expected[axis]).abs() < 1e-14,
                "node {node} axis {axis}"
            );
        }
    }
    let prescribed: Vec<(usize, f64)> = root
        .iter()
        .flat_map(|&node| {
            let value = rigid(node);
            (0..3).map(move |axis| (three(node, axis), value[axis]))
        })
        .collect();
    let plain = model.plain(&prescribed, &vec![0.0; 3 * model.mesh.node_count()]);
    assert_same_field(&coupled, &plain, point);
}

#[test]
fn a_distributing_point_spreads_its_load_over_the_corner_and_edge_nodes() {
    let centre = [LENGTH, HEIGHT / 2.0, HEIGHT / 2.0];
    let model = Model::new(&[0.0], 6, &[centre]);
    let point = model.mesh.vertex_count() - 1;
    let tip_vertices = model.vertices_where(at_x(LENGTH));
    let tip: Vec<usize> = tip_vertices
        .iter()
        .copied()
        .chain(model.edge_nodes_where(at_x(LENGTH)))
        .collect();
    assert!(tip.len() > tip_vertices.len());
    let root = model.vertices_where(at_x(0.0));
    let clamped: Vec<(usize, f64)> = root
        .iter()
        .flat_map(|&node| (0..3).map(move |axis| (six(node, axis), 0.0)))
        .collect();
    let force = [120.0, -80.0, -300.0];
    let moment = [4000.0, 1500.0, -2500.0];
    let mut forces = vec![0.0; model.coupled_dof_count()];
    for axis in 0..3 {
        forces[six(point, axis)] = force[axis];
        forces[six(point, 3 + axis)] = moment[axis];
    }
    // The coupling names the tip vertices only.
    let coupled = model
        .coupled(&[distributing(point, tip_vertices)], &clamped, &forces)
        .expect("the coupled cantilever solves");

    // RBE3 with equal weights over all tip nodes about their centroid (the
    // face centre): node i carries F/N + (H⁻¹·M) × rᵢ, H diagonal for the
    // plane x = L.
    let arms: Vec<[f64; 3]> = tip
        .iter()
        .map(|&node| [0, 1, 2].map(|axis| model.point(node)[axis] - centre[axis]))
        .collect();
    let mut inertia = [0.0; 3];
    for arm in &arms {
        let squared: f64 = arm.iter().map(|value| value * value).sum();
        for axis in 0..3 {
            inertia[axis] += squared - arm[axis] * arm[axis];
        }
    }
    let spin = [0, 1, 2].map(|axis| moment[axis] / inertia[axis]);
    let mut direct = vec![0.0; 3 * model.mesh.node_count()];
    for (&node, arm) in tip.iter().zip(&arms) {
        let turn = cross(spin, *arm);
        for axis in 0..3 {
            direct[three(node, axis)] = force[axis] / tip.len() as f64 + turn[axis];
        }
    }
    let plain_fixed: Vec<(usize, f64)> = root
        .iter()
        .flat_map(|&node| (0..3).map(move |axis| (three(node, axis), 0.0)))
        .collect();
    let plain = model.plain(&plain_fixed, &direct);
    assert_same_field(&coupled, &plain, point);
    // The point follows the mean of all tip nodes.
    let scale = largest(&plain);
    for axis in 0..3 {
        let mean = tip
            .iter()
            .map(|&node| coupled.dofs[six(node, axis)])
            .sum::<f64>()
            / tip.len() as f64;
        assert!((coupled.dofs[six(point, axis)] - mean).abs() < 1e-12 * scale);
    }
}

#[test]
fn vertex_supports_reach_the_edge_nodes_in_a_coupled_quadratic_solve() {
    let centre = [LENGTH, HEIGHT / 2.0, HEIGHT / 2.0];
    let model = Model::new(&[0.0], 6, &[centre]);
    let point = model.mesh.vertex_count() - 1;
    let tip = model.vertices_where(at_x(LENGTH));
    let root = model.vertices_where(at_x(0.0));
    // The root pulled 0.01 along x on its top half, held elsewhere; the tip
    // loaded through a kinematic point.
    let fixed: Vec<(usize, f64)> = root
        .iter()
        .flat_map(|&node| {
            let pull = if model.point(node)[2] > HEIGHT / 2.0 - 1e-9 {
                0.01
            } else {
                0.0
            };
            [
                (six(node, 0), pull),
                (six(node, 1), 0.0),
                (six(node, 2), 0.0),
            ]
        })
        .collect();
    let mut forces = vec![0.0; model.coupled_dof_count()];
    forces[six(point, 2)] = -400.0;
    let coupled = model
        .coupled(&[kinematic(point, tip, ALL_DOFS)], &fixed, &forces)
        .expect("the coupled cantilever solves");
    // Where both ends of a root edge are prescribed, the edge node takes
    // their mean.
    for node in model.edge_nodes_where(at_x(0.0)) {
        let ends = model.mesh.edges()[node - model.mesh.vertex_count()];
        for axis in 0..3 {
            let mean = ends
                .iter()
                .map(|&end| coupled.dofs[six(end as usize, axis)])
                .sum::<f64>()
                / 2.0;
            assert!(
                (coupled.dofs[six(node, axis)] - mean).abs() < 1e-14,
                "edge node {node} axis {axis}"
            );
        }
    }
}

#[test]
fn an_edge_node_between_two_coupled_vertices_follows_their_mean() {
    // Bars [0, L] and [L, 2L] meshed apart, joined node to node in u_x: each
    // vertex of bar A's end face follows the coincident vertex of bar B's
    // start face (a kinematic coupling in x only). No coupling grips both
    // ends of an edge of A's end face, so its edge nodes follow the mean of
    // their ends.
    let model = Model::new(&[0.0, LENGTH], 6, &[]);
    let joint = at_x(LENGTH);
    let face = model.vertices_where(&joint);
    let half = model.mesh.vertex_count() / 2;
    let (end_a, start_b): (Vec<usize>, Vec<usize>) =
        face.into_iter().partition(|&node| node < half);
    let partner = |node: usize| -> usize {
        *start_b
            .iter()
            .find(|&&other| {
                (0..3).all(|axis| (model.point(other)[axis] - model.point(node)[axis]).abs() < 1e-9)
            })
            .expect("coincident vertex")
    };
    let couplings: Vec<Coupling> = end_a
        .iter()
        .map(|&node| kinematic(partner(node), vec![node], 0b1))
        .collect();
    // Bar A clamped at its root; bar B held across at its start face (its
    // x follows bar A through the couplings) and bent by a load at its tip.
    let mut fixed: Vec<(usize, f64)> = model
        .vertices_where(at_x(0.0))
        .into_iter()
        .flat_map(|node| (0..3).map(move |axis| (six(node, axis), 0.0)))
        .collect();
    fixed.extend(
        start_b
            .iter()
            .flat_map(|&node| [(six(node, 1), 0.0), (six(node, 2), 0.0)]),
    );
    let mut forces = vec![0.0; model.coupled_dof_count()];
    let tip = model.vertices_where(at_x(2.0 * LENGTH));
    for &node in &tip {
        forces[six(node, 2)] = -300.0 / tip.len() as f64;
    }
    let solution = model
        .coupled(&couplings, &fixed, &forces)
        .expect("the joined bars solve");
    let scale = largest(&solution.dofs);
    let edges_a: Vec<usize> = model
        .edge_nodes_where(&joint)
        .into_iter()
        .filter(|&node| {
            let ends = model.mesh.edges()[node - model.mesh.vertex_count()];
            (ends[0] as usize) < half
        })
        .collect();
    assert_ne!(edges_a.len(), 0, "bar A's end face has edge nodes");
    for node in edges_a {
        let ends = model.mesh.edges()[node - model.mesh.vertex_count()];
        let mean = f64::midpoint(
            solution.dofs[six(ends[0] as usize, 0)],
            solution.dofs[six(ends[1] as usize, 0)],
        );
        assert!(
            (solution.dofs[six(node, 0)] - mean).abs() < 1e-12 * scale,
            "edge node {node}: u_x {} against the mean of its ends {mean}",
            solution.dofs[six(node, 0)]
        );
        // Across, the edge node stays free.
        assert!(solution.dofs[six(node, 2)].abs() > 0.0);
    }
}

#[test]
fn a_quadratic_coupled_solve_takes_six_dofs_per_node_edge_nodes_included() {
    let (model, point, root) = root_coupled();
    let couplings = [kinematic(point, root, ALL_DOFS)];
    let fixed: Vec<(usize, f64)> = (0..6).map(|axis| (six(point, axis), 0.0)).collect();
    let short = vec![0.0; DOFS_PER_NODE * model.mesh.vertex_count()];
    let error = model
        .coupled(&couplings, &fixed, &short)
        .expect_err("forces for the vertices only are refused");
    assert_eq!(
        error,
        FemError::ForceLength {
            len: short.len(),
            count: model.coupled_dof_count()
        }
    );
}

#[test]
fn an_edge_node_joins_a_weighted_coupling_with_the_mean_weight_of_its_ends() {
    let centre = [LENGTH, HEIGHT / 2.0, HEIGHT / 2.0];
    let model = Model::new(&[0.0], 6, &[centre]);
    let point = model.mesh.vertex_count() - 1;
    let tip_vertices = model.vertices_where(at_x(LENGTH));
    // A weight linear in y, so an edge node's mean weight is its own 1 + y/H.
    let weight = |node: usize| 1.0 + model.point(node)[1] / HEIGHT;
    let coupling = Coupling {
        weights: tip_vertices.iter().map(|&node| weight(node)).collect(),
        ..distributing(point, tip_vertices.clone())
    };
    let root = model.vertices_where(at_x(0.0));
    let clamped: Vec<(usize, f64)> = root
        .iter()
        .flat_map(|&node| (0..3).map(move |axis| (six(node, axis), 0.0)))
        .collect();
    let force = [50.0, -30.0, -200.0];
    let mut forces = vec![0.0; model.coupled_dof_count()];
    for axis in 0..3 {
        forces[six(point, axis)] = force[axis];
    }
    let coupled = model
        .coupled(&[coupling], &clamped, &forces)
        .expect("the coupled cantilever solves");

    // A force at an RBE3 point reaches node i as F·wᵢ/Σw.
    let tip: Vec<usize> = tip_vertices
        .into_iter()
        .chain(model.edge_nodes_where(at_x(LENGTH)))
        .collect();
    let total: f64 = tip.iter().map(|&node| weight(node)).sum();
    let mut direct = vec![0.0; 3 * model.mesh.node_count()];
    for &node in &tip {
        for axis in 0..3 {
            direct[three(node, axis)] = force[axis] * weight(node) / total;
        }
    }
    let plain_fixed: Vec<(usize, f64)> = root
        .iter()
        .flat_map(|&node| (0..3).map(move |axis| (three(node, axis), 0.0)))
        .collect();
    let plain = model.plain(&plain_fixed, &direct);
    assert_same_field(&coupled, &plain, point);
}

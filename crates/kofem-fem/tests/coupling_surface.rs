// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! A distributing (RBE3) coupling over a picked surface weights each coupled
//! node by its share of the surface's area: the nodal shares of a uniform
//! pressure. On linear faces those are A/3 per corner; on quadratic faces the
//! corners get nothing and each edge node A/3 (see `surface`), so the solve
//! brings the face's edge nodes into the coupling.
//!
//! With the reference point at the surface's area centroid, a force on it is
//! then exactly a uniform traction F / A on the surface. Each check compares
//! the coupled solve with an uncoupled solve of that traction, which must
//! agree to solver precision — on a face whose nodes are unevenly spaced,
//! where equal weights per node would not.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

mod support;

use kofem_fem::surface::{BoundaryFaces, SurfaceLoadKind};
use kofem_fem::{
    assemble_stiffness, solve_coupled_static, solve_static, AmgSettings, CgSettings,
    CoupledSolution, Coupling, CouplingKind, CsrMatrix, ElementOrder, FemError, Isotropic,
    PreconditionerChoice, StoppingRule, TetMesh, DOFS_PER_NODE,
};
use support::box_mesh;

const LENGTH: f64 = 60.0;
const HEIGHT: f64 = 10.0;

const SETTINGS: CgSettings = CgSettings {
    relative_tolerance: 1e-12,
    max_iterations: 20_000,
    stopping: StoppingRule::ResidualNorm,
};

fn amg() -> PreconditionerChoice {
    PreconditionerChoice::SmoothedAggregation(AmgSettings {
        strength_threshold: 0.0,
        coarse_size: 60,
        max_levels: 10,
    })
}

fn steel() -> Isotropic {
    Isotropic::new(0, 210_000.0, 0.3).expect("valid material")
}

/// A bar along x whose middle rows of vertices are moved off centre (to
/// y = 0.3·H and z = 0.7·H), so the tip face's triangles differ in area and
/// equal weights per node are not a uniform traction; plus one free point
/// at the tip face's area centroid.
struct Model {
    mesh: TetMesh,
    stiffness: CsrMatrix,
    tip: Vec<[u32; 3]>,
    point: usize,
}

impl Model {
    fn new(order: ElementOrder) -> Self {
        let bar = box_mesh([6, 2, 2], [LENGTH, HEIGHT, HEIGHT], steel());
        assert!(
            (bar.size[0] - LENGTH).abs() < 1e-12,
            "the bar is LENGTH long"
        );
        let shift = |value: f64, to: f64| {
            if (value - HEIGHT / 2.0).abs() < 1e-9 {
                to
            } else {
                value
            }
        };
        let mut points: Vec<[f64; 3]> = bar
            .vertices
            .iter()
            .map(|&[along, across, up]| {
                [along, shift(across, 0.3 * HEIGHT), shift(up, 0.7 * HEIGHT)]
            })
            .collect();
        let tets: Vec<u32> = bar.mesh.tets().iter().flatten().copied().collect();
        let on_tip = |vertex: u32| (points[vertex as usize][0] - LENGTH).abs() < 1e-9;
        let mut tip = Vec::new();
        for tet in bar.mesh.tets() {
            for skip in 0..4 {
                let face: Vec<u32> = (0..4)
                    .filter(|&corner| corner != skip)
                    .map(|corner| tet[corner])
                    .collect();
                if face.iter().all(|&vertex| on_tip(vertex)) {
                    tip.push([face[0], face[1], face[2]]);
                }
            }
        }
        // The area centroid of the tip face.
        let (mut area, mut moment) = (0.0, [0.0; 3]);
        for triangle in &tip {
            let [first, second, third] = triangle.map(|vertex| points[vertex as usize]);
            let doubled = cross(sub(second, first), sub(third, first));
            let piece = 0.5 * dot(doubled, doubled).sqrt();
            area += piece;
            for axis in 0..3 {
                moment[axis] += piece * (first[axis] + second[axis] + third[axis]) / 3.0;
            }
        }
        let point = points.len();
        points.push(moment.map(|value| value / area));
        let flat: Vec<f64> = points.iter().flatten().copied().collect();
        let materials = vec![0; tets.len() / 4];
        let mesh = TetMesh::new(&flat, &tets, &materials, vec![steel()])
            .and_then(|mesh| mesh.with_order(order))
            .expect("valid mesh");
        let stiffness = assemble_stiffness(&mesh);
        Self {
            mesh,
            stiffness,
            tip,
            point,
        }
    }

    fn tip_vertices(&self) -> Vec<usize> {
        let mut vertices: Vec<usize> = self
            .tip
            .iter()
            .flatten()
            .map(|&vertex| vertex as usize)
            .collect();
        vertices.sort_unstable();
        vertices.dedup();
        vertices
    }

    /// Every vertex at the root x = 0, fixed in all three translations.
    fn root(&self) -> Vec<usize> {
        (0..self.mesh.vertex_count())
            .filter(|&node| {
                self.mesh.is_used(node) && self.mesh.node_coordinates()[node][0].abs() < 1e-9
            })
            .collect()
    }

    fn coupled(
        &self,
        couplings: &[Coupling],
        force: [f64; 3],
    ) -> Result<CoupledSolution, FemError> {
        let dofs: Vec<u32> = self
            .root()
            .iter()
            .flat_map(|&node| (0..3).map(move |axis| (DOFS_PER_NODE * node + axis) as u32))
            .collect();
        let values = vec![0.0; dofs.len()];
        let mut forces = vec![0.0; DOFS_PER_NODE * self.mesh.node_count()];
        for axis in 0..3 {
            forces[DOFS_PER_NODE * self.point + axis] = force[axis];
        }
        solve_coupled_static(
            &self.mesh,
            &self.stiffness,
            couplings,
            &dofs,
            &values,
            &forces,
            SETTINGS,
            amg(),
        )
    }

    /// The uncoupled solve of the total force spread as a uniform traction
    /// over the tip face.
    fn traction(&self, force: [f64; 3]) -> Vec<f64> {
        let dofs: Vec<u32> = self
            .root()
            .iter()
            .flat_map(|&node| (0..3).map(move |axis| (3 * node + axis) as u32))
            .collect();
        let values = vec![0.0; dofs.len()];
        let mut forces = vec![0.0; self.mesh.dof_count()];
        BoundaryFaces::new(&self.mesh)
            .apply(
                &self.mesh,
                0,
                &self.tip,
                &[],
                SurfaceLoadKind::Force(force),
                &mut forces,
            )
            .expect("the tip faces are on the boundary");
        solve_static(
            &self.mesh,
            &self.stiffness,
            &dofs,
            &values,
            &forces,
            SETTINGS,
            amg(),
        )
        .expect("the uncoupled model solves")
        .displacements
    }
}

fn surface(reference: usize, nodes: Vec<usize>) -> Coupling {
    Coupling {
        reference,
        nodes,
        weights: Vec::new(),
        kind: CouplingKind::DistributingSurface,
    }
}

fn sub(lhs: [f64; 3], rhs: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|axis| lhs[axis] - rhs[axis])
}

fn dot(lhs: [f64; 3], rhs: [f64; 3]) -> f64 {
    lhs[0] * rhs[0] + lhs[1] * rhs[1] + lhs[2] * rhs[2]
}

fn cross(lhs: [f64; 3], rhs: [f64; 3]) -> [f64; 3] {
    [
        lhs[1] * rhs[2] - lhs[2] * rhs[1],
        lhs[2] * rhs[0] - lhs[0] * rhs[2],
        lhs[0] * rhs[1] - lhs[1] * rhs[0],
    ]
}

/// The largest difference between the coupled and the uncoupled field,
/// relative to the largest displacement, over every node but the point.
fn field_difference(model: &Model, coupled: &CoupledSolution, plain: &[f64]) -> f64 {
    let scale = plain.iter().fold(0.0f64, |max, value| max.max(value.abs()));
    assert!(scale > 0.0, "the traction moves the bar");
    (0..plain.len() / 3)
        .filter(|&node| node != model.point)
        .flat_map(|node| {
            (0..3).map(move |axis| {
                (coupled.dofs[DOFS_PER_NODE * node + axis] - plain[3 * node + axis]).abs()
            })
        })
        .fold(0.0f64, f64::max)
        / scale
}

const FORCES: [(&str, [f64; 3]); 2] = [
    ("axial", [5000.0, 0.0, 0.0]),
    ("transverse", [0.0, -800.0, 300.0]),
];

#[test]
fn a_surface_coupling_loads_linear_faces_as_a_uniform_traction() {
    let model = Model::new(ElementOrder::Linear);
    for (label, force) in FORCES {
        let coupled = model
            .coupled(&[surface(model.point, model.tip_vertices())], force)
            .expect("the coupled model solves");
        let difference = field_difference(&model, &coupled, &model.traction(force));
        assert!(
            difference < 1e-8,
            "{label}: relative difference {difference:e}"
        );
    }
}

#[test]
fn a_surface_coupling_loads_quadratic_faces_through_their_edge_nodes() {
    let model = Model::new(ElementOrder::Quadratic);
    for (label, force) in FORCES {
        let coupled = model
            .coupled(&[surface(model.point, model.tip_vertices())], force)
            .expect("the coupled model solves");
        let difference = field_difference(&model, &coupled, &model.traction(force));
        assert!(
            difference < 1e-8,
            "{label}: relative difference {difference:e}"
        );
    }
}

/// Equal weights on the corner nodes, the plain distributing coupling, are
/// not a uniform traction on this face: the check above can tell them apart.
#[test]
fn equal_weights_on_the_corners_are_not_a_uniform_traction() {
    for order in [ElementOrder::Linear, ElementOrder::Quadratic] {
        let model = Model::new(order);
        let coupled = model
            .coupled(
                &[Coupling {
                    kind: CouplingKind::Distributing,
                    ..surface(model.point, model.tip_vertices())
                }],
                FORCES[0].1,
            )
            .expect("the coupled model solves");
        let difference = field_difference(&model, &coupled, &model.traction(FORCES[0].1));
        assert!(
            difference > 1e-3,
            "{order:?}: relative difference {difference:e}"
        );
    }
}

#[test]
fn a_surface_coupling_needs_whole_faces_of_the_boundary() {
    let model = Model::new(ElementOrder::Linear);
    // Three tip vertices on one straight edge of the face: no whole triangle.
    let row: Vec<usize> = model
        .tip_vertices()
        .into_iter()
        .filter(|&node| model.mesh.node_coordinates()[node][1].abs() < 1e-9)
        .collect();
    assert_eq!(
        row.len(),
        3,
        "the fixture has three vertices on the edge y = 0"
    );
    match model.coupled(&[surface(model.point, row)], FORCES[0].1) {
        Err(FemError::Coupling { coupling, reason }) => {
            assert_eq!(coupling, 0);
            assert!(
                reason.contains("no whole face"),
                "the reason says no whole face is gripped: {reason}"
            );
        }
        other => panic!("expected a coupling error, got {other:?}"),
    }
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Constraint ("MPC") ties in the solid solve: a tied node follows the
//! surface it is tied to, `u_slave = Σ wᵢ u_masterᵢ`, by master–slave
//! elimination. No node moves, so two bodies meshed on their own join across
//! a gap without a node in common.
//!
//! The model is two boxes along x with a gap between them, box B meshed finer
//! than box A, so no node of B faces a node of A. B's facing nodes are tied to
//! A's facing surface by node-to-surface projection weights.
//!
//! * Validation of the tie table: the C++ engine's checks and messages.
//! * Patch test: under a prescribed end displacement and roller supports the
//!   exact solution is linear in each box (the gap carries no strain), which
//!   linear and quadratic tetrahedra and hexahedra reproduce exactly. A
//!   slave DOF a roller prescribes keeps its condition (the support wins).
//! * Quadratic elements: the master side is a quadratic field, so the tied
//!   vertices follow its shape functions, and the edge (and hex face) nodes
//!   of the tied surface are tied as well.
//! * A tie chain is substituted out; a cycle is refused.
//! * Dual mortar weights (linear faces): each set sums to one and reproduces
//!   a linear field, matching meshes tie node to node, and a constant
//!   traction crosses a non-matching tie exactly — the patch test the
//!   node-to-surface projection fails.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

use kofem_fem::{
    assemble_stiffness, mortar_weights, node_ties, solve_tied_static, AmgSettings, BoundaryFaces,
    CgSettings, ElementOrder, FemError, Isotropic, MortarFace, MortarRow, PreconditionerChoice,
    StoppingRule, SurfaceLoadKind, TetMesh, VertexTies,
};

const YOUNG: f64 = 210_000.0;
const POISSON: f64 = 0.3;
const LENGTH: f64 = 10.0;
const SIDE: f64 = 4.0;
const GAP: f64 = 0.5;
const STRAIN: f64 = 1e-3;

const SETTINGS: CgSettings = CgSettings {
    relative_tolerance: 1e-12,
    max_iterations: 20_000,
    stopping: StoppingRule::ResidualNorm,
};

fn preconditioners() -> [PreconditionerChoice; 2] {
    [
        PreconditionerChoice::SymmetricGaussSeidel,
        PreconditionerChoice::SmoothedAggregation(AmgSettings {
            strength_threshold: 0.0,
            coarse_size: 40,
            max_levels: 10,
        }),
    ]
}

/// The cube corners of a hex cell (bit0 x, bit1 y, bit2 z) in CHEXA order.
const HEX_CORNERS: [usize; 8] = [0, 1, 3, 2, 4, 5, 7, 6];

/// A cube as six tetrahedra around its 0–7 diagonal (cube-corner bits).
const KUHN: [[usize; 4]; 6] = [
    [0, 1, 3, 7],
    [0, 3, 2, 7],
    [0, 2, 6, 7],
    [0, 6, 4, 7],
    [0, 4, 5, 7],
    [0, 5, 1, 7],
];

#[derive(Clone, Copy, PartialEq)]
enum Shape {
    Tet,
    Hex,
}

/// Two boxes of `LENGTH` × `SIDE` × `SIDE` along x, `GAP` apart: box A with
/// 2 × 2 cells across, box B with `divisions_b` × `divisions_b`.
struct Boxes {
    vertices: Vec<[f64; 3]>,
    tets: Vec<u32>,
    hexes: Vec<u32>,
    /// First vertex of box B.
    first_b: usize,
    /// Box A's element faces on its facing plane x = LENGTH, as triangles.
    master_triangles: Vec<[usize; 3]>,
}

fn boxes(shape: Shape, divisions_b: usize) -> Boxes {
    let mut out = Boxes {
        vertices: Vec::new(),
        tets: Vec::new(),
        hexes: Vec::new(),
        first_b: 0,
        master_triangles: Vec::new(),
    };
    for (start, across) in [(0.0, 2), (LENGTH + GAP, divisions_b)] {
        let along = 5;
        let first = out.vertices.len();
        if start > 0.0 {
            out.first_b = first;
        }
        let index = |ix: usize, iy: usize, iz: usize| {
            (first + ix + (along + 1) * (iy + (across + 1) * iz)) as u32
        };
        for iz in 0..=across {
            for iy in 0..=across {
                for ix in 0..=along {
                    out.vertices.push([
                        start + LENGTH * ix as f64 / along as f64,
                        SIDE * iy as f64 / across as f64,
                        SIDE * iz as f64 / across as f64,
                    ]);
                }
            }
        }
        for iz in 0..across {
            for iy in 0..across {
                for ix in 0..along {
                    let corner = |bits: usize| {
                        index(
                            ix + (bits & 1),
                            iy + ((bits >> 1) & 1),
                            iz + ((bits >> 2) & 1),
                        )
                    };
                    match shape {
                        Shape::Hex => out.hexes.extend(HEX_CORNERS.map(corner)),
                        Shape::Tet => {
                            for tet in KUHN {
                                out.tets.extend(tet.map(corner));
                            }
                        }
                    }
                }
            }
        }
    }
    // Box A's faces on x = LENGTH, split into triangles as the app projects.
    let on_face = |vertex: u32| (out.vertices[vertex as usize][0] - LENGTH).abs() < 1e-9;
    for tet in out.tets.chunks(4) {
        for skip in 0..4 {
            let face: Vec<u32> = (0..4).filter(|&k| k != skip).map(|k| tet[k]).collect();
            if face.iter().all(|&vertex| on_face(vertex)) {
                out.master_triangles
                    .push([face[0] as usize, face[1] as usize, face[2] as usize]);
            }
        }
    }
    for hex in out.hexes.chunks(8) {
        for face in [
            [0, 3, 2, 1],
            [4, 5, 6, 7],
            [0, 1, 5, 4],
            [1, 2, 6, 5],
            [2, 3, 7, 6],
            [3, 0, 4, 7],
        ] {
            let ids = face.map(|k| hex[k] as usize);
            if ids.iter().all(|&vertex| on_face(vertex as u32)) {
                out.master_triangles.push([ids[0], ids[1], ids[2]]);
                out.master_triangles.push([ids[0], ids[2], ids[3]]);
            }
        }
    }
    out
}

impl Boxes {
    fn mesh(&self, order: ElementOrder) -> TetMesh {
        let flat: Vec<f64> = self.vertices.iter().flatten().copied().collect();
        let elements = self.tets.len() / 4 + self.hexes.len() / 8;
        TetMesh::with_hexahedra(
            &flat,
            &self.tets,
            &self.hexes,
            &vec![0; elements],
            vec![Isotropic::new(0, YOUNG, POISSON).expect("valid material")],
        )
        .and_then(|mesh| mesh.with_order(order))
        .expect("valid boxes")
    }

    /// The element faces on the plane `x`, in cyclic order, with the centroid
    /// of the element each bounds.
    fn faces_on(&self, plane: f64) -> Vec<MortarFace> {
        let on = |vertex: u32| (self.vertices[vertex as usize][0] - plane).abs() < 1e-9;
        let centroid = |element: &[u32]| {
            let mut sum = [0.0; 3];
            for &vertex in element {
                for axis in 0..3 {
                    sum[axis] += self.vertices[vertex as usize][axis] / element.len() as f64;
                }
            }
            sum
        };
        let face = |ids: Vec<u32>, element: &[u32]| MortarFace {
            points: ids.iter().map(|&id| self.vertices[id as usize]).collect(),
            nodes: ids.iter().map(|&id| id as usize).collect(),
            element_centroid: centroid(element),
        };
        let mut faces = Vec::new();
        for tet in self.tets.chunks(4) {
            for skip in 0..4 {
                let ids: Vec<u32> = (0..4).filter(|&k| k != skip).map(|k| tet[k]).collect();
                if ids.iter().all(|&vertex| on(vertex)) {
                    faces.push(face(ids, tet));
                }
            }
        }
        for hex in self.hexes.chunks(8) {
            for local in [
                [0, 3, 2, 1],
                [4, 5, 6, 7],
                [0, 1, 5, 4],
                [1, 2, 6, 5],
                [2, 3, 7, 6],
                [3, 0, 4, 7],
            ] {
                let ids: Vec<u32> = local.iter().map(|&k| hex[k]).collect();
                if ids.iter().all(|&vertex| on(vertex)) {
                    faces.push(face(ids, hex));
                }
            }
        }
        faces
    }

    /// Mortar ties of box B's facing nodes to box A's facing surface.
    fn mortar_rows(&self, limit: f64) -> Vec<MortarRow> {
        mortar_weights(&self.faces_on(LENGTH + GAP), &self.faces_on(LENGTH), limit)
            .expect("mortar weights")
    }

    fn mortar_ties(&self) -> VertexTies {
        let rows = self.mortar_rows(f64::INFINITY);
        let mut offsets = vec![0u32];
        let mut masters = Vec::new();
        let mut weights = Vec::new();
        for row in &rows {
            masters.extend(row.masters.iter().map(|&master| master as u32));
            weights.extend_from_slice(&row.weights);
            offsets.push(masters.len() as u32);
        }
        let slaves: Vec<u32> = rows.iter().map(|row| row.slave as u32).collect();
        VertexTies::new(self.vertices.len(), &slaves, &offsets, &masters, &weights)
            .expect("valid mortar ties")
    }

    /// Box B's vertices on its facing plane.
    fn slaves(&self) -> Vec<usize> {
        (self.first_b..self.vertices.len())
            .filter(|&vertex| (self.vertices[vertex][0] - LENGTH - GAP).abs() < 1e-9)
            .collect()
    }

    /// Node-to-surface ties: each slave follows the master triangle its
    /// (y, z) lies in, with barycentric weights (zero weights dropped).
    fn projection_ties(&self) -> (Vec<u32>, Vec<u32>, Vec<u32>, Vec<f64>) {
        let mut slaves = Vec::new();
        let mut offsets = vec![0u32];
        let mut masters = Vec::new();
        let mut weights = Vec::new();
        for slave in self.slaves() {
            let [_, along_y, along_z] = self.vertices[slave];
            let (triangle, lambda) = self
                .master_triangles
                .iter()
                .find_map(|triangle| {
                    let lambda =
                        barycentric(triangle.map(|id| self.vertices[id]), along_y, along_z);
                    lambda
                        .iter()
                        .all(|&value| value > -1e-12)
                        .then_some((*triangle, lambda))
                })
                .expect("every slave faces a master triangle");
            slaves.push(slave as u32);
            for (&master, &weight) in triangle.iter().zip(&lambda) {
                if weight > 1e-12 {
                    masters.push(master as u32);
                    weights.push(weight);
                }
            }
            let total: f64 = weights[offsets[offsets.len() - 1] as usize..].iter().sum();
            for weight in &mut weights[offsets[offsets.len() - 1] as usize..] {
                *weight /= total;
            }
            offsets.push(masters.len() as u32);
        }
        (slaves, offsets, masters, weights)
    }

    fn vertex_ties(&self) -> VertexTies {
        let (slaves, offsets, masters, weights) = self.projection_ties();
        VertexTies::new(self.vertices.len(), &slaves, &offsets, &masters, &weights)
            .expect("valid ties")
    }
}

/// Barycentric weights of (y, z) in a triangle on a plane x = const.
fn barycentric(points: [[f64; 3]; 3], along_y: f64, along_z: f64) -> [f64; 3] {
    let [p0, p1, p2] = points;
    let det = (p1[1] - p0[1]) * (p2[2] - p0[2]) - (p2[1] - p0[1]) * (p1[2] - p0[2]);
    let second = ((along_y - p0[1]) * (p2[2] - p0[2]) - (p2[1] - p0[1]) * (along_z - p0[2])) / det;
    let third = ((p1[1] - p0[1]) * (along_z - p0[2]) - (along_y - p0[1]) * (p1[2] - p0[2])) / det;
    [1.0 - second - third, second, third]
}

/// The exact patch-test field: uniaxial strain along x in each box, with the
/// gap rigid, so box B is shifted back by the gap.
fn exact(point: [f64; 3]) -> [f64; 3] {
    let along = if point[0] > LENGTH + GAP / 2.0 {
        point[0] - GAP
    } else {
        point[0]
    };
    [
        STRAIN * along,
        -POISSON * STRAIN * point[1],
        -POISSON * STRAIN * point[2],
    ]
}

/// Rollers on x = 0, y = 0 and z = 0 (of both boxes), and the far end pulled
/// to the exact displacement, on every node of `points` — the solve extends
/// vertex supports to edge nodes, but not to the face nodes of 27-node hexes.
fn patch_supports(points: &[[f64; 3]]) -> (Vec<u32>, Vec<f64>) {
    let mut dofs = Vec::new();
    let mut values = Vec::new();
    let far = 2.0 * LENGTH + GAP;
    for (node, point) in points.iter().enumerate() {
        for axis in 0..3 {
            let roller = point[axis].abs() < 1e-9;
            let pulled = axis == 0 && (point[0] - far).abs() < 1e-9;
            if roller || pulled {
                dofs.push((3 * node + axis) as u32);
                values.push(exact(*point)[axis]);
            }
        }
    }
    (dofs, values)
}

#[test]
fn malformed_tie_tables_are_refused_with_the_engine_messages() {
    let refuse =
        |slaves: &[u32], offsets: &[u32], masters: &[u32], weights: &[f64]| match VertexTies::new(
            4, slaves, offsets, masters, weights,
        ) {
            Err(FemError::Tie { reason }) => reason,
            other => panic!("expected a tie error, got {other:?}"),
        };
    assert!(refuse(&[0], &[0, 1], &[1], &[1.0, 0.0]).contains("one CSR table"));
    assert!(refuse(&[7], &[0, 1], &[1], &[1.0]).contains("outside the mesh"));
    assert!(refuse(&[0, 0], &[0, 1, 2], &[1, 2], &[1.0, 1.0]).contains("tied twice"));
    assert!(refuse(&[0], &[0, 0], &[], &[]).contains("tied to no node"));
    assert!(refuse(&[0], &[0, 1], &[0], &[1.0]).contains("tied to itself"));
    assert!(refuse(&[0], &[0, 1], &[9], &[1.0]).contains("outside the mesh"));
    assert!(refuse(&[0], &[0, 1], &[1], &[f64::NAN]).contains("non-finite"));
    assert!(refuse(&[0], &[0, 2], &[1, 2], &[0.5, 0.4]).contains("sum to"));
    // Negative dual-mortar weights are fine as long as the set sums to one.
    assert!(VertexTies::new(4, &[0], &[0, 3], &[1, 2, 3], &[1.2, -0.4, 0.2]).is_ok());
}

#[test]
fn a_tie_cycle_is_refused() {
    let model = boxes(Shape::Hex, 3);
    let mesh = model.mesh(ElementOrder::Linear);
    let stiffness = assemble_stiffness(&mesh);
    let [first, second] = [model.first_b, model.first_b + 1];
    let ties = VertexTies::new(
        model.vertices.len(),
        &[first as u32, second as u32],
        &[0, 1, 2],
        &[second as u32, first as u32],
        &[1.0, 1.0],
    )
    .expect("a valid table");
    let (dofs, values) = patch_supports(&model.vertices);
    let error = solve_tied_static(
        &mesh,
        &stiffness,
        &ties,
        &dofs,
        &values,
        &vec![0.0; mesh.dof_count()],
        SETTINGS,
        PreconditionerChoice::SymmetricGaussSeidel,
    )
    .expect_err("a cycle has no elimination order");
    assert!(matches!(error, FemError::CouplingCycle { .. }), "{error}");
}

/// Solve the patch test of `model` at `order` with `ties`, under both
/// preconditioners; returns the worst nodal error relative to the pull, the
/// solution and its report.
fn patch_test(
    model: &Boxes,
    order: ElementOrder,
    ties: &VertexTies,
) -> Vec<(f64, kofem_fem::TiedSolution)> {
    let mesh = model.mesh(order);
    let stiffness = assemble_stiffness(&mesh);
    let (dofs, values) = patch_supports(mesh.node_coordinates());
    preconditioners()
        .into_iter()
        .map(|preconditioner| {
            let solution = solve_tied_static(
                &mesh,
                &stiffness,
                ties,
                &dofs,
                &values,
                &vec![0.0; mesh.dof_count()],
                SETTINGS,
                preconditioner,
            )
            .expect("the tied boxes solve");
            assert_eq!(solution.displacements.len(), mesh.dof_count());
            let mut worst: f64 = 0.0;
            for (node, point) in mesh.node_coordinates().iter().enumerate() {
                let expected = exact(*point);
                for axis in 0..3 {
                    worst =
                        worst.max((solution.displacements[3 * node + axis] - expected[axis]).abs());
                }
            }
            (worst / (STRAIN * 2.0 * LENGTH), solution)
        })
        .collect()
}

#[test]
fn the_patch_test_passes_across_a_non_matching_mortar_tie() {
    // Equilibrium of the reduced system, Tᵀ(K·u − f) = 0, holds for the exact
    // field only if the slave face's consistent forces map onto the master
    // face's: the mortar condition. So the linear patch test is the mortar
    // tie's.
    for shape in [Shape::Tet, Shape::Hex] {
        let model = boxes(shape, 3);
        for (worst, solution) in patch_test(&model, ElementOrder::Linear, &model.mortar_ties()) {
            assert!(
                worst < 1e-9,
                "{}: off the exact field by {worst:e}",
                if shape == Shape::Hex { "hexes" } else { "tets" }
            );
            // The slaves on y = 0 and z = 0 keep their rollers.
            assert!(solution.report.prescribed > 0);
            assert!(solution.report.eliminated > 0);
        }
    }
}

#[test]
fn quadratic_ties_pass_the_patch_test_on_matching_meshes() {
    // Facing nodes coincide: every vertex, edge and face node follows its
    // twin, so the quadratic solve reproduces the exact field.
    for shape in [Shape::Tet, Shape::Hex] {
        let model = boxes(shape, 2);
        for (worst, _) in patch_test(&model, ElementOrder::Quadratic, &model.vertex_ties()) {
            assert!(worst < 1e-9, "off the exact field by {worst:e}");
        }
    }
}

#[test]
fn quadratic_ties_hold_across_a_non_matching_interface() {
    // Node-to-surface ties do not pass the patch test on non-matching meshes
    // (see above), but every tied node must follow its master field, and the
    // joint must carry the pull: the tied face moves by about half of it.
    for shape in [Shape::Tet, Shape::Hex] {
        let model = boxes(shape, 3);
        let mesh = model.mesh(ElementOrder::Quadratic);
        let ties = model.vertex_ties();
        let fe_ties = node_ties(&mesh, &ties).expect("quadratic ties");
        let (dofs, _) = patch_supports(mesh.node_coordinates());
        for (worst, solution) in patch_test(&model, ElementOrder::Quadratic, &ties) {
            assert!(worst < 0.02, "off the exact field by {worst:e}");
            let displacements = &solution.displacements;
            for tie in &fe_ties {
                for axis in 0..3 {
                    if dofs.contains(&((3 * tie.node + axis) as u32)) {
                        continue;
                    }
                    let followed: f64 = tie
                        .masters
                        .iter()
                        .zip(&tie.weights)
                        .map(|(&master, &weight)| weight * displacements[3 * master + axis])
                        .sum();
                    assert!(
                        (followed - displacements[3 * tie.node + axis]).abs() < 1e-12,
                        "node {} axis {axis} does not follow its master field",
                        tie.node
                    );
                }
            }
        }
    }
}

#[test]
fn a_fixed_tied_node_keeps_its_support() {
    let model = boxes(Shape::Hex, 3);
    let mesh = model.mesh(ElementOrder::Linear);
    let stiffness = assemble_stiffness(&mesh);
    let ties = model.vertex_ties();
    let (mut dofs, mut values) = patch_supports(&model.vertices);
    // A slave inside the face, which no roller reaches.
    let pinned = model
        .slaves()
        .into_iter()
        .find(|&vertex| {
            let point = model.vertices[vertex];
            point[1] > 1e-9 && point[2] > 1e-9 && point[1] < SIDE - 1e-9
        })
        .expect("an inner slave");
    for axis in 0..3 {
        dofs.push((3 * pinned + axis) as u32);
        values.push(0.0);
    }
    let solution = solve_tied_static(
        &mesh,
        &stiffness,
        &ties,
        &dofs,
        &values,
        &vec![0.0; mesh.dof_count()],
        SETTINGS,
        PreconditionerChoice::SymmetricGaussSeidel,
    )
    .expect("a fixed tied node does not break the solve");
    assert_eq!(
        &solution.displacements[3 * pinned..3 * pinned + 3],
        &[0.0; 3]
    );
}

#[test]
fn quadratic_ties_follow_the_master_field_on_the_whole_surface() {
    for shape in [Shape::Tet, Shape::Hex] {
        let model = boxes(shape, 3);
        let mesh = model.mesh(ElementOrder::Quadratic);
        let ties = node_ties(&mesh, &model.vertex_ties()).expect("quadratic ties");
        let points = mesh.node_coordinates();
        let tied_nodes: Vec<usize> = ties.iter().map(|tie| tie.node).collect();
        // Every node of box B on the facing plane is tied: vertices, edge
        // nodes and (hexes) face nodes.
        let facing: Vec<usize> = (0..mesh.node_count())
            .filter(|&node| {
                (points[node][0] - LENGTH - GAP).abs() < 1e-9
                    && (node >= mesh.vertex_count() || node >= model.first_b)
            })
            .collect();
        for node in &facing {
            assert!(tied_nodes.contains(node), "facing node {node} is not tied");
        }
        assert_eq!(tied_nodes.len(), facing.len());
        for tie in &ties {
            let sum: f64 = tie.weights.iter().sum();
            assert!((sum - 1.0).abs() < 1e-12, "weights sum to {sum}");
            // The masters are nodes of box A's facing plane, and their
            // weighted position is the node's own projection across the gap.
            let mut followed = [0.0; 3];
            for (&master, &weight) in tie.masters.iter().zip(&tie.weights) {
                assert!((points[master][0] - LENGTH).abs() < 1e-9);
                for axis in 0..3 {
                    followed[axis] += weight * points[master][axis];
                }
            }
            let own = points[tie.node];
            assert!(
                (followed[1] - own[1]).abs() < 1e-9 && (followed[2] - own[2]).abs() < 1e-9,
                "node {} at {own:?} follows {followed:?}",
                tie.node
            );
        }
    }
}

#[test]
fn a_tie_chain_is_substituted_out() {
    // With matching 2 × 2 grids every slave follows one master. Re-tie the
    // second slave to the first: s0 follows m0 and s1 follows s0, a chain
    // the elimination must substitute out.
    let model = boxes(Shape::Hex, 2);
    let mesh = model.mesh(ElementOrder::Linear);
    let stiffness = assemble_stiffness(&mesh);
    let (slaves, offsets, masters, weights) = model.projection_ties();
    assert!(offsets.windows(2).all(|pair| pair[1] - pair[0] == 1));
    let mut chained_masters = masters.clone();
    chained_masters[1] = slaves[0];
    let mut chained_weights = weights.clone();
    chained_weights[1] = 1.0;
    let ties = VertexTies::new(
        model.vertices.len(),
        &slaves,
        &offsets,
        &chained_masters,
        &chained_weights,
    )
    .expect("a valid chain");
    let (dofs, values) = patch_supports(&model.vertices);
    let solution = solve_tied_static(
        &mesh,
        &stiffness,
        &ties,
        &dofs,
        &values,
        &vec![0.0; mesh.dof_count()],
        SETTINGS,
        PreconditionerChoice::SymmetricGaussSeidel,
    )
    .expect("a chain resolves");
    let moved = |vertex: u32, axis: usize| solution.displacements[3 * vertex as usize + axis];
    for axis in 0..3 {
        // s0 follows m0, s1 follows s0 — wherever no roller prescribes them.
        let s0_free = !dofs.contains(&(3 * slaves[0] + axis as u32));
        let s1_free = !dofs.contains(&(3 * slaves[1] + axis as u32));
        if s0_free {
            assert!((moved(slaves[0], axis) - moved(masters[0], axis)).abs() < 1e-12);
        }
        if s1_free {
            assert!((moved(slaves[1], axis) - moved(slaves[0], axis)).abs() < 1e-12);
        }
    }
}

/// Rollers on x = 0, y = 0 and z = 0 of both boxes, and box B's far end
/// pulled by the traction `STRESS`: uniform uniaxial stress, whose exact
/// field is [`exact`] scaled to the strain STRESS / E.
const STRESS: f64 = 100.0;

fn traction_patch(model: &Boxes, mesh: &TetMesh, ties: &VertexTies) -> f64 {
    let stiffness = assemble_stiffness(mesh);
    let mut dofs = Vec::new();
    for (vertex, point) in model.vertices.iter().enumerate() {
        for (axis, &coordinate) in point.iter().enumerate() {
            if coordinate.abs() < 1e-9 {
                dofs.push((3 * vertex + axis) as u32);
            }
        }
    }
    let values = vec![0.0; dofs.len()];
    let far: Vec<MortarFace> = model.faces_on(2.0 * LENGTH + GAP);
    let triangles: Vec<[u32; 3]> = far
        .iter()
        .filter(|face| face.nodes.len() == 3)
        .map(|face| [0, 1, 2].map(|k| face.nodes[k] as u32))
        .collect();
    let quads: Vec<[u32; 4]> = far
        .iter()
        .filter(|face| face.nodes.len() == 4)
        .map(|face| [0, 1, 2, 3].map(|k| face.nodes[k] as u32))
        .collect();
    let mut forces = vec![0.0; mesh.dof_count()];
    BoundaryFaces::new(mesh)
        .apply(
            mesh,
            0,
            &triangles,
            &quads,
            SurfaceLoadKind::Traction([STRESS, 0.0, 0.0]),
            &mut forces,
        )
        .expect("the far face is loaded");
    let solution = solve_tied_static(
        mesh,
        &stiffness,
        ties,
        &dofs,
        &values,
        &forces,
        SETTINGS,
        PreconditionerChoice::SymmetricGaussSeidel,
    )
    .expect("the tied boxes solve");
    let scale = STRESS / YOUNG / STRAIN;
    let mut worst: f64 = 0.0;
    for (node, point) in mesh.node_coordinates().iter().enumerate() {
        let expected = exact(*point);
        for axis in 0..3 {
            worst =
                worst.max((solution.displacements[3 * node + axis] - scale * expected[axis]).abs());
        }
    }
    // Relative to the end displacement.
    worst / (STRESS / YOUNG * 2.0 * LENGTH)
}

#[test]
fn mortar_weights_reproduce_a_linear_field() {
    for shape in [Shape::Tet, Shape::Hex] {
        let model = boxes(shape, 3);
        let rows = model.mortar_rows(f64::INFINITY);
        let slaves = model.slaves();
        assert_eq!(rows.len(), slaves.len(), "every facing node of B is tied");
        for row in &rows {
            assert!(slaves.contains(&row.slave));
            let sum: f64 = row.weights.iter().sum();
            assert!((sum - 1.0).abs() < 1e-12, "weights sum to {sum}");
            assert!(row.coverage > 0.999, "full coverage, got {}", row.coverage);
            let own = model.vertices[row.slave];
            for axis in [1, 2] {
                let followed: f64 = row
                    .masters
                    .iter()
                    .zip(&row.weights)
                    .map(|(&master, &weight)| weight * model.vertices[master][axis])
                    .sum();
                assert!(
                    (followed - own[axis]).abs() < 1e-9,
                    "node {} axis {axis}: {followed} vs {}",
                    row.slave,
                    own[axis]
                );
            }
        }
    }
}

#[test]
fn mortar_ties_matching_meshes_node_to_node() {
    for shape in [Shape::Tet, Shape::Hex] {
        let model = boxes(shape, 2);
        for row in model.mortar_rows(f64::INFINITY) {
            assert_eq!(
                row.masters.len(),
                1,
                "node {} follows {:?}",
                row.slave,
                row.masters
            );
            assert!((row.weights[0] - 1.0).abs() < 1e-12);
            let [master, slave] = [model.vertices[row.masters[0]], model.vertices[row.slave]];
            assert!((master[1] - slave[1]).abs() < 1e-12 && (master[2] - slave[2]).abs() < 1e-12);
        }
    }
}

#[test]
fn mortar_search_honours_the_limit_and_the_facing_rule() {
    let model = boxes(Shape::Hex, 3);
    // A limit shorter than the gap reaches nothing.
    assert_eq!(model.mortar_rows(0.1).len(), 0);
    assert_eq!(model.mortar_rows(0.6).len(), model.slaves().len());
    // Box A's far face (x = 0) faces the same way as B's facing surface, so
    // adding it to the master side changes nothing.
    let mut masters = model.faces_on(LENGTH);
    masters.extend(model.faces_on(0.0));
    let with_far = mortar_weights(&model.faces_on(LENGTH + GAP), &masters, f64::INFINITY)
        .expect("mortar weights");
    let plain = model.mortar_rows(f64::INFINITY);
    assert_eq!(with_far.len(), plain.len());
    for (first, second) in with_far.iter().zip(&plain) {
        assert_eq!(first.slave, second.slave);
        assert_eq!(first.masters, second.masters);
    }
}

#[test]
fn a_slave_node_the_master_barely_covers_is_not_tied() {
    // Only the master faces with y < SIDE/2 (half of A's facing surface): B's nodes beyond it are not tied, and those well inside are.
    let model = boxes(Shape::Hex, 3);
    let masters: Vec<MortarFace> = model
        .faces_on(LENGTH)
        .into_iter()
        .filter(|face| face.points.iter().all(|point| point[1] < SIDE / 2.0 + 1e-9))
        .collect();
    let rows = mortar_weights(&model.faces_on(LENGTH + GAP), &masters, f64::INFINITY)
        .expect("mortar weights");
    assert_ne!(rows.len(), 0);
    for row in &rows {
        assert!(row.coverage >= 0.5);
        assert!(model.vertices[row.slave][1] < SIDE / 2.0 + 1e-9);
    }
    let far_side = model
        .slaves()
        .into_iter()
        .filter(|&slave| model.vertices[slave][1] > SIDE * 0.75)
        .count();
    assert!(far_side > 0);
    assert!(rows.len() <= model.slaves().len() - far_side);
}

#[test]
fn a_constant_traction_crosses_a_mortar_tie_exactly() {
    for shape in [Shape::Tet, Shape::Hex] {
        let model = boxes(shape, 3);
        let mesh = model.mesh(ElementOrder::Linear);
        let mortar = traction_patch(&model, &mesh, &model.mortar_ties());
        assert!(
            mortar < 1e-8,
            "{}: the mortar tie is off the uniform-stress field by {mortar:e}",
            if shape == Shape::Hex { "hexes" } else { "tets" }
        );
    }
    // The node-to-surface projection does not pass it on the hexes: the two
    // faces interpolate differently between the slave nodes.
    let model = boxes(Shape::Hex, 3);
    let mesh = model.mesh(ElementOrder::Linear);
    let projection = traction_patch(&model, &mesh, &model.vertex_ties());
    assert!(projection > 1e-4, "projection off by only {projection:e}");
}

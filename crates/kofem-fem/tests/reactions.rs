// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Support reactions against the applied loads (KOF-387): a cantilever's
//! clamp carries the tip load and its moment, on every solve path — solid
//! (linear and quadratic tets, hexes), solid with a coupling, mixed shell and
//! solid, and pure shell. Equilibrium holds exactly on any mesh, so the
//! checks are tight.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

mod support;

use kofem_fem::hyperelastic::NeoHookean;
use kofem_fem::nonlinear::NonlinearProblem;
use kofem_fem::{
    assemble_shell_stiffness, assemble_stiffness, fold_onto_vertices, fold_onto_vertices_at,
    load_on_held_nodes, nodal_residual, prepare_coupled_static, prepare_mixed_static,
    solve_coupled_static, solve_mixed_static, solve_shell_static, solve_static,
    summarize_reactions, summarize_reactions_at, widen_translations, CgSettings, Coupling,
    CouplingKind, ElementOrder, FemError, Isotropic, MixedPreconditioner, PreconditionerChoice,
    ReactionSummary, ShellMesh, ShellPart, StoppingRule, TetMesh, DOFS_PER_NODE,
};
use support::box_mesh;

const LENGTH: f64 = 100.0;
const HEIGHT: f64 = 10.0;
const TIP_LOAD: f64 = -1000.0;

const SETTINGS: CgSettings = CgSettings {
    relative_tolerance: 1e-12,
    max_iterations: 50_000,
    stopping: StoppingRule::ResidualNorm,
};

fn steel() -> Isotropic {
    Isotropic::new(0, 210_000.0, 0.3).expect("valid material")
}

fn close(got: f64, want: f64, scale: f64) -> bool {
    (got - want).abs() <= 1e-6 * scale
}

/// The clamp at x = 0 is support 0; the tip load −1000 N in z acts at x = L.
/// Its reaction is +1000 N in z, and the moment about the clamp's centroid
/// balances the load's: (L, ·, ·) × (0, 0, −1000) has y-component +L·1000.
fn assert_cantilever(summary: &ReactionSummary, centroid: [f64; 3]) {
    assert_eq!(summary.supports.len(), 1);
    let clamp = &summary.supports[0];
    let scale = TIP_LOAD.abs();
    assert!(close(clamp.force[0], 0.0, scale), "Fx {}", clamp.force[0]);
    assert!(close(clamp.force[1], 0.0, scale), "Fy {}", clamp.force[1]);
    assert!(
        close(clamp.force[2], -TIP_LOAD, scale),
        "Fz {}",
        clamp.force[2]
    );
    let moment = LENGTH * TIP_LOAD.abs();
    assert!(
        close(clamp.moment[0], 0.0, moment),
        "Mx {}",
        clamp.moment[0]
    );
    assert!(
        close(clamp.moment[1], -moment, moment),
        "My {}",
        clamp.moment[1]
    );
    assert!(
        close(clamp.moment[2], 0.0, moment),
        "Mz {}",
        clamp.moment[2]
    );
    for axis in 0..3 {
        assert!(close(clamp.centroid[axis], centroid[axis], LENGTH));
    }
    assert!(close(summary.applied[2], TIP_LOAD, scale));
    assert!(close(summary.applied[0], 0.0, scale));
    assert_eq!(summary.applied_on_supports, [0.0; 3]);
}

/// A box cantilever of linear tets along x.
struct Bar {
    mesh: TetMesh,
    vertices: Vec<[f64; 3]>,
}

impl Bar {
    fn new(order: ElementOrder) -> Self {
        let bar = box_mesh([8, 2, 2], [LENGTH, HEIGHT, HEIGHT], steel());
        assert_eq!(bar.size, [LENGTH, HEIGHT, HEIGHT]);
        Self {
            mesh: bar.mesh.with_order(order).expect("valid order"),
            vertices: bar.vertices,
        }
    }

    fn vertices_at_x(&self, position: f64) -> Vec<usize> {
        (0..self.vertices.len())
            .filter(|&vertex| (self.vertices[vertex][0] - position).abs() < 1e-9)
            .collect()
    }

    /// Owners, 6 per vertex: the clamp's translations belong to support 0.
    fn clamp_owners(&self) -> Vec<i32> {
        let mut owners = vec![-1; DOFS_PER_NODE * self.vertices.len()];
        for vertex in self.vertices_at_x(0.0) {
            for component in 0..3 {
                owners[DOFS_PER_NODE * vertex + component] = 0;
            }
        }
        owners
    }
}

#[test]
fn a_solid_cantilever_clamp_carries_the_tip_load_and_its_moment() {
    for order in [ElementOrder::Linear, ElementOrder::Quadratic] {
        let bar = Bar::new(order);
        let stiffness = assemble_stiffness(&bar.mesh);
        let mut forces = vec![0.0; bar.mesh.dof_count()];
        let tip = bar.vertices_at_x(LENGTH);
        for &vertex in &tip {
            forces[3 * vertex + 2] += TIP_LOAD / tip.len() as f64;
        }
        let fixed: Vec<u32> = bar
            .vertices_at_x(0.0)
            .iter()
            .flat_map(|&vertex| (0..3).map(move |component| (3 * vertex + component) as u32))
            .collect();
        let values = vec![0.0; fixed.len()];
        let solution = solve_static(
            &bar.mesh,
            &stiffness,
            &fixed,
            &values,
            &forces,
            SETTINGS,
            PreconditionerChoice::SymmetricGaussSeidel,
        )
        .expect("the bar solves");
        let residual =
            nodal_residual(&stiffness, &solution.displacements, &forces).expect("vectors fit");
        let reactions = fold_onto_vertices(&bar.mesh, &widen_translations(&residual))
            .expect("one value per node");
        let loads =
            fold_onto_vertices(&bar.mesh, &widen_translations(&forces)).expect("fits the mesh");
        let summary = summarize_reactions(
            bar.mesh.vertices(),
            &reactions,
            &loads,
            &bar.clamp_owners(),
            1,
        )
        .expect("valid owners");
        assert_cantilever(&summary, [0.0, HEIGHT / 2.0, HEIGHT / 2.0]);
    }
}

#[test]
fn a_quadratic_hex_clamp_gets_its_edge_face_and_centre_nodes_reactions() {
    // Four hexes along x; the clamp face's edge and face nodes hold reactions
    // that fold onto its corners.
    let cells = 4;
    let mut vertices = Vec::new();
    for i in 0..=cells {
        for (across, up) in [(0.0, 0.0), (HEIGHT, 0.0), (HEIGHT, HEIGHT), (0.0, HEIGHT)] {
            vertices.push([LENGTH * i as f64 / cells as f64, across, up]);
        }
    }
    // Bottom face (z = 0) first, then the top face above it.
    let hexes: Vec<u32> = (0..cells as u32)
        .flat_map(|i| {
            let (near, far) = (4 * i, 4 * (i + 1));
            [
                near,
                far,
                far + 1,
                near + 1,
                near + 3,
                far + 3,
                far + 2,
                near + 2,
            ]
        })
        .collect();
    let flat: Vec<f64> = vertices.iter().flatten().copied().collect();
    let mesh = TetMesh::with_hexahedra(&flat, &[], &hexes, &vec![0; cells], vec![steel()])
        .and_then(|mesh| mesh.with_order(ElementOrder::Quadratic))
        .expect("valid hexes");
    let stiffness = assemble_stiffness(&mesh);
    let mut forces = vec![0.0; mesh.dof_count()];
    let tip: Vec<usize> = (4 * cells..4 * cells + 4).collect();
    for &vertex in &tip {
        forces[3 * vertex + 2] += TIP_LOAD / 4.0;
    }
    let fixed: Vec<u32> = (0..4u32)
        .flat_map(|vertex| (0..3).map(move |component| 3 * vertex + component))
        .collect();
    let values = vec![0.0; fixed.len()];
    let solution = solve_static(
        &mesh,
        &stiffness,
        &fixed,
        &values,
        &forces,
        SETTINGS,
        PreconditionerChoice::SymmetricGaussSeidel,
    )
    .expect("the hexes solve");
    let residual = nodal_residual(&stiffness, &solution.displacements, &forces).expect("fits");
    let reactions = fold_onto_vertices(&mesh, &widen_translations(&residual)).expect("fits");
    let loads = fold_onto_vertices(&mesh, &widen_translations(&forces)).expect("fits");
    let mut owners = vec![-1; DOFS_PER_NODE * vertices.len()];
    for vertex in 0..4 {
        for component in 0..3 {
            owners[DOFS_PER_NODE * vertex + component] = 0;
        }
    }
    let summary =
        summarize_reactions(mesh.vertices(), &reactions, &loads, &owners, 1).expect("valid owners");
    assert_cantilever(&summary, [0.0, HEIGHT / 2.0, HEIGHT / 2.0]);
}

#[test]
fn a_coupled_tip_load_reaches_the_clamp() {
    // The tip load acts on a reference point beyond the tip, distributed onto
    // the tip face: the clamp reaction is the same, its moment about the clamp
    // includes the reference point's lever arm.
    let bar = Bar::new(ElementOrder::Linear);
    let mut flat: Vec<f64> = bar.vertices.iter().flatten().copied().collect();
    flat.extend([LENGTH, HEIGHT / 2.0, HEIGHT / 2.0]);
    let reference = bar.vertices.len();
    let tets: Vec<u32> = bar.mesh.tets().iter().flatten().copied().collect();
    let mesh =
        TetMesh::new(&flat, &tets, &vec![0; tets.len() / 4], vec![steel()]).expect("valid mesh");
    let stiffness = assemble_stiffness(&mesh);
    let coupling = Coupling {
        reference,
        nodes: bar.vertices_at_x(LENGTH),
        weights: Vec::new(),
        kind: CouplingKind::Distributing,
    };
    let fixed: Vec<u32> = bar
        .vertices_at_x(0.0)
        .iter()
        .flat_map(|&vertex| {
            (0..3).map(move |component| (DOFS_PER_NODE * vertex + component) as u32)
        })
        .collect();
    let values = vec![0.0; fixed.len()];
    let mut forces = vec![0.0; DOFS_PER_NODE * mesh.vertex_count()];
    forces[DOFS_PER_NODE * reference + 2] = TIP_LOAD;
    let couplings = [coupling];
    let solution = solve_coupled_static(
        &mesh,
        &stiffness,
        &couplings,
        &fixed,
        &values,
        &forces,
        SETTINGS,
        PreconditionerChoice::SymmetricGaussSeidel,
    )
    .expect("the model solves");
    let prepared = prepare_coupled_static(
        &mesh,
        &stiffness,
        &couplings,
        &fixed,
        &values,
        &forces,
        PreconditionerChoice::SymmetricGaussSeidel,
    )
    .expect("valid model");
    let reactions = prepared
        .reduction
        .mixed_reactions(&stiffness, None, &solution.dofs, &forces)
        .expect("vectors fit");
    let mut owners = bar.clamp_owners();
    owners.extend([-1; DOFS_PER_NODE]);
    let summary = summarize_reactions(mesh.vertices(), &reactions, &forces, &owners, 1)
        .expect("valid owners");
    assert_cantilever(&summary, [0.0, HEIGHT / 2.0, HEIGHT / 2.0]);
}

/// A flat plate cantilever in the z = 0 plane: x along the span, y across.
fn plate() -> (Vec<[f64; 3]>, Vec<u32>, usize, usize) {
    let (nx, ny) = (8, 2);
    let mut vertices = Vec::new();
    for i in 0..=nx {
        for j in 0..=ny {
            vertices.push([
                LENGTH * i as f64 / nx as f64,
                HEIGHT * j as f64 / ny as f64,
                0.0,
            ]);
        }
    }
    let id = |i: usize, j: usize| (i * (ny + 1) + j) as u32;
    let mut triangles = Vec::new();
    for i in 0..nx {
        for j in 0..ny {
            triangles.extend([
                id(i, j),
                id(i + 1, j),
                id(i + 1, j + 1),
                id(i, j),
                id(i + 1, j + 1),
                id(i, j + 1),
            ]);
        }
    }
    (vertices, triangles, nx, ny)
}

#[test]
fn a_shell_clamp_carries_the_tip_load_and_its_moment() {
    let (vertices, triangles, nx, ny) = plate();
    let flat: Vec<f64> = vertices.iter().flatten().copied().collect();
    let count = triangles.len() / 3;
    let mesh = ShellMesh::new(
        &flat,
        &triangles,
        &vec![1.0; count],
        &vec![0; count],
        vec![steel()],
    )
    .expect("valid shell");
    let stiffness = assemble_shell_stiffness(&mesh);
    let mut fixed = Vec::new();
    let mut owners = vec![-1; DOFS_PER_NODE * vertices.len()];
    for j in 0..=ny {
        for component in 0..DOFS_PER_NODE {
            fixed.push((DOFS_PER_NODE * j + component) as u32);
            owners[DOFS_PER_NODE * j + component] = 0;
        }
    }
    let values = vec![0.0; fixed.len()];
    let mut forces = vec![0.0; DOFS_PER_NODE * vertices.len()];
    for j in 0..=ny {
        forces[DOFS_PER_NODE * (nx * (ny + 1) + j) + 2] = TIP_LOAD / (ny + 1) as f64;
    }
    let solution = solve_shell_static(&mesh, &stiffness, &fixed, &values, &forces, SETTINGS)
        .expect("the plate solves");
    let reactions = nodal_residual(&stiffness, &solution.dofs, &forces).expect("vectors fit");
    let summary = summarize_reactions(mesh.vertices(), &reactions, &forces, &owners, 1)
        .expect("valid owners");
    assert_cantilever(&summary, [0.0, HEIGHT / 2.0, 0.0]);
}

#[test]
fn a_mixed_shell_on_solid_reaction_balances_the_load() {
    // The plate's clamp edge is its own support; a solid block under its tip
    // shares the tip vertices, so the shell and solid stiffness both act.
    let (mut vertices, triangles, nx, ny) = plate();
    let tip: Vec<u32> = (0..=ny).map(|j| (nx * (ny + 1) + j) as u32).collect();
    let apex = vertices.len() as u32;
    vertices.push([LENGTH + 5.0, HEIGHT / 2.0, -5.0]);
    let behind = ((nx - 1) * (ny + 1)) as u32;
    let tets = vec![tip[0], tip[2], behind, apex];
    let flat: Vec<f64> = vertices.iter().flatten().copied().collect();
    let solid = TetMesh::new(&flat, &tets, &[0], vec![steel()]).expect("valid solid");
    let count = triangles.len() / 3;
    let shell = ShellMesh::new(
        &flat,
        &triangles,
        &vec![1.0; count],
        &vec![0; count],
        vec![steel()],
    )
    .expect("valid shell");
    let solid_stiffness = assemble_stiffness(&solid);
    let shell_stiffness = assemble_shell_stiffness(&shell);
    let mut fixed = Vec::new();
    let mut owners = vec![-1; DOFS_PER_NODE * vertices.len()];
    for j in 0..=ny {
        for component in 0..DOFS_PER_NODE {
            fixed.push((DOFS_PER_NODE * j + component) as u32);
            owners[DOFS_PER_NODE * j + component] = 0;
        }
    }
    let values = vec![0.0; fixed.len()];
    let mut forces = vec![0.0; DOFS_PER_NODE * vertices.len()];
    forces[DOFS_PER_NODE * apex as usize + 2] = TIP_LOAD;
    let part = ShellPart {
        mesh: &shell,
        stiffness: &shell_stiffness,
    };
    let solution = solve_mixed_static(
        &solid,
        &solid_stiffness,
        Some(part),
        &[],
        &fixed,
        &values,
        &forces,
        SETTINGS,
        MixedPreconditioner::IncompleteCholesky,
    )
    .expect("the model solves");
    let prepared = prepare_mixed_static(
        &solid,
        &solid_stiffness,
        Some(part),
        &[],
        &fixed,
        &values,
        &forces,
        MixedPreconditioner::IncompleteCholesky,
    )
    .expect("valid model");
    let reactions = prepared
        .reduction
        .mixed_reactions(
            &solid_stiffness,
            Some(&shell_stiffness),
            &solution.dofs,
            &forces,
        )
        .expect("vectors fit");
    let summary = summarize_reactions(solid.vertices(), &reactions, &forces, &owners, 1)
        .expect("valid owners");
    let clamp = &summary.supports[0];
    assert!(
        close(clamp.force[2], -TIP_LOAD, TIP_LOAD.abs()),
        "Fz {}",
        clamp.force[2]
    );
    let lever = LENGTH + 5.0;
    let moment = lever * TIP_LOAD.abs();
    assert!(
        close(clamp.moment[1], -moment, moment),
        "My {}",
        clamp.moment[1]
    );
}

#[test]
fn a_dof_belongs_to_the_support_that_holds_it() {
    // One vertex, x held by support 0 and y by support 1: each support gets
    // its own component, and a load on a held DOF counts as on a support.
    let vertices = [[1.0, 2.0, 3.0]];
    let reactions = [5.0, 7.0, 0.0, 0.0, 0.0, 0.0];
    let forces = [2.0, 0.0, -4.0, 0.0, 0.0, 0.0];
    let owners = [0, 1, -1, -1, -1, -1];
    let summary =
        summarize_reactions(&vertices, &reactions, &forces, &owners, 2).expect("valid owners");
    assert_eq!(summary.supports[0].force, [5.0, 0.0, 0.0]);
    assert_eq!(summary.supports[1].force, [0.0, 7.0, 0.0]);
    assert_eq!(summary.supports[0].vertices, 1);
    assert_eq!(summary.applied, [2.0, 0.0, -4.0]);
    assert_eq!(summary.applied_on_supports, [2.0, 0.0, 0.0]);
}

#[test]
fn a_support_with_no_vertex_in_the_solve_reports_none() {
    let summary =
        summarize_reactions(&[[0.0; 3]], &[0.0; 6], &[0.0; 6], &[-1; 6], 1).expect("valid owners");
    assert_eq!(summary.supports[0].vertices, 0);
    assert_eq!(summary.supports[0].force, [0.0; 3]);
}

#[test]
fn malformed_reaction_input_is_refused() {
    let vertices = [[0.0; 3]];
    assert!(matches!(
        summarize_reactions(&vertices, &[0.0; 5], &[0.0; 6], &[-1; 6], 1),
        Err(FemError::ReactionInput { .. })
    ));
    assert!(matches!(
        summarize_reactions(&vertices, &[0.0; 6], &[0.0; 6], &[2, -1, -1, -1, -1, -1], 2),
        Err(FemError::ReactionInput { .. })
    ));
    assert!(matches!(
        summarize_reactions(
            &vertices,
            &[0.0; 6],
            &[0.0; 6],
            &[-2, -1, -1, -1, -1, -1],
            1
        ),
        Err(FemError::ReactionInput { .. })
    ));
}

#[test]
fn load_on_a_free_edge_node_is_not_load_on_a_support() {
    // One quadratic tet; vertices 0 and 1 are held in z. Load on the edge
    // node between them sits on the support; load on the edge node between
    // 0 and the free vertex 2 does not, although folding would give half of
    // it to vertex 0.
    let flat = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    let mesh = TetMesh::new(&flat, &[0, 1, 2, 3], &[0], vec![steel()])
        .and_then(|mesh| mesh.with_order(ElementOrder::Quadratic))
        .expect("valid tet");
    let edge = |first: u32, second: u32| {
        4 + mesh
            .edges()
            .iter()
            .position(|&ends| ends == [first, second])
            .expect("edge exists")
    };
    let mut forces = vec![0.0; DOFS_PER_NODE * mesh.node_count()];
    forces[DOFS_PER_NODE * edge(0, 1) + 2] = -10.0;
    forces[DOFS_PER_NODE * edge(0, 2) + 2] = -6.0;
    forces[DOFS_PER_NODE + 2] = -1.0; // vertex 1
    let mut owners = vec![-1; DOFS_PER_NODE * 4];
    owners[2] = 0;
    owners[DOFS_PER_NODE + 2] = 0;
    let held = load_on_held_nodes(&mesh, &forces, &owners).expect("fits the mesh");
    assert_eq!(held, [0.0, 0.0, -11.0]);
}

#[test]
fn each_held_vertex_reports_its_own_reaction_for_drawing() {
    // Vertex 0 is held in x, y, z by support 0; vertex 1 only in x by
    // support 1; vertex 2 is free. A free DOF's residual (solver noise) is
    // not a reaction, so it is left out of the vertex's force.
    let vertices = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [2.0, 0.0, 0.0]];
    let mut owners = vec![-1; 3 * DOFS_PER_NODE];
    owners[..3].copy_from_slice(&[0, 0, 0]);
    owners[DOFS_PER_NODE] = 1;
    let mut reactions = vec![0.0; 3 * DOFS_PER_NODE];
    reactions[..3].copy_from_slice(&[1.0, 2.0, 3.0]);
    reactions[DOFS_PER_NODE..DOFS_PER_NODE + 3].copy_from_slice(&[4.0, 1e-9, 0.0]);
    reactions[2 * DOFS_PER_NODE] = 7.0;
    let forces = vec![0.0; 3 * DOFS_PER_NODE];

    let summary =
        summarize_reactions(&vertices, &reactions, &forces, &owners, 2).expect("valid owners");

    assert_eq!(summary.nodal.len(), 2);
    assert_eq!(summary.nodal[0].support, 0);
    assert_eq!(summary.nodal[0].position, [0.0, 0.0, 0.0]);
    assert_eq!(summary.nodal[0].force, [1.0, 2.0, 3.0]);
    assert_eq!(summary.nodal[1].support, 1);
    assert_eq!(summary.nodal[1].position, [1.0, 0.0, 0.0]);
    assert_eq!(summary.nodal[1].force, [4.0, 0.0, 0.0]);
}

/// The forces a large deformation leaves at the vertices, and where they
/// act: a single element with every node held, displaced by `field`, so its
/// reactions are its Neo-Hookean internal forces. Those balance in moment
/// about any point in the deformed configuration (the energy is unchanged by
/// a rigid rotation), not in the undeformed one.
struct Deformed {
    mesh: TetMesh,
    reactions: Vec<f64>,
    /// Where each node is after the deformation.
    positions: Vec<[f64; 3]>,
    owners: Vec<i32>,
}

fn deformed(order: ElementOrder, field: impl Fn([f64; 3]) -> [f64; 3]) -> Deformed {
    let mesh = TetMesh::new(
        &[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
        &[0, 1, 2, 3],
        &[0],
        vec![Isotropic::new(0, 1000.0, 0.3).expect("valid material")],
    )
    .expect("valid tet")
    .with_order(order)
    .expect("fits");
    let mut displacements = vec![0.0; mesh.dof_count()];
    let mut positions: Vec<[f64; 3]> = Vec::new();
    for (node, point) in mesh.node_coordinates().iter().enumerate() {
        let motion = field(*point);
        displacements[3 * node..3 * node + 3].copy_from_slice(&motion);
        positions.push(std::array::from_fn(|axis| point[axis] + motion[axis]));
    }
    let mut problem = NeoHookean::new(&mesh);
    let mut tangent = problem.tangent_pattern();
    let reactions = problem
        .internal_force_and_tangent(&displacements, &mut tangent)
        .expect("not inverted");
    // Every vertex held in translation by support 0.
    let owners = (0..mesh.vertex_count())
        .flat_map(|_| [0, 0, 0, -1, -1, -1])
        .collect();
    Deformed {
        mesh,
        reactions,
        positions,
        owners,
    }
}

fn largest(values: &[f64]) -> f64 {
    values
        .iter()
        .fold(0.0_f64, |max, value| max.max(value.abs()))
}

#[test]
fn a_large_deformation_balances_its_moment_where_the_forces_act() {
    // Shear and stretch: u_x = 0.5·X + 0.4·Y.
    let model = deformed(ElementOrder::Linear, |point| {
        [0.5 * point[0] + 0.4 * point[1], 0.0, 0.0]
    });
    let reactions = widen_translations(&model.reactions);
    let loads = vec![0.0; reactions.len()];
    let vertices = model.mesh.vertices();
    let scale = largest(&model.reactions);
    let undeformed =
        summarize_reactions(vertices, &reactions, &loads, &model.owners, 1).expect("valid owners");
    assert!(
        largest(&undeformed.supports[0].moment) > 0.1 * scale,
        "taken about the undeformed vertices the moment does not balance"
    );
    let summary = summarize_reactions_at(
        vertices,
        &model.positions,
        &reactions,
        &loads,
        &model.owners,
        1,
    )
    .expect("valid owners");
    let support = &summary.supports[0];
    assert!(
        largest(&support.force) <= 1e-10 * scale,
        "{:?}",
        support.force
    );
    assert!(
        largest(&support.moment) <= 1e-10 * scale,
        "moment {:?} in the deformed configuration",
        support.moment
    );
    // Drawn where the support's nodes are in the model, undeformed.
    assert_eq!(summary.nodal[1].position, vertices[1]);
    assert_eq!(support.centroid, [0.25; 3]);
}

#[test]
fn folding_curved_edge_nodes_keeps_the_moment_in_the_deformed_configuration() {
    // A quadratic field bends the edges, so a deformed edge node no longer
    // lies midway between its deformed ends.
    let model = deformed(ElementOrder::Quadratic, |point| {
        [
            0.2 * point[1] * point[1],
            0.3 * point[0] * point[2],
            0.1 * point[0] * point[0],
        ]
    });
    let reactions = widen_translations(&model.reactions);
    let loads = vec![0.0; reactions.len()];
    let vertices = model.mesh.vertices();
    let corners = &model.positions[..vertices.len()];
    let scale = largest(&model.reactions);
    let moment_after = |folded: &[f64]| {
        let summary = summarize_reactions_at(
            vertices,
            corners,
            folded,
            &loads[..folded.len()],
            &model.owners,
            1,
        )
        .expect("valid owners");
        summary.supports[0].moment
    };
    let plain = fold_onto_vertices(&model.mesh, &reactions).expect("fits");
    assert!(
        largest(&moment_after(&plain)) > 1e-3 * scale,
        "folding to the corners alone loses the edge nodes' offset"
    );
    let folded = fold_onto_vertices_at(&model.mesh, &reactions, &model.positions).expect("fits");
    let moment = moment_after(&folded);
    assert!(largest(&moment) <= 1e-10 * scale, "moment {moment:?}");
    // The fold keeps the forces as the plain one does.
    for vertex in 0..vertices.len() {
        for axis in 0..3 {
            let at = DOFS_PER_NODE * vertex + axis;
            assert!((folded[at] - plain[at]).abs() <= 1e-12 * scale);
        }
    }
}

#[test]
fn a_fold_at_positions_of_the_wrong_length_is_refused() {
    let model = deformed(ElementOrder::Quadratic, |_| [0.0; 3]);
    let reactions = widen_translations(&model.reactions);
    assert!(matches!(
        fold_onto_vertices_at(&model.mesh, &reactions, &model.positions[..4]),
        Err(FemError::ReactionInput { .. })
    ));
}

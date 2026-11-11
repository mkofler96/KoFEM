// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Quadratic (10-node) tetrahedra through the whole solve: patch tests,
//! edge-node boundary conditions, loads on 6-node faces, and a cantilever
//! against beam theory.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

mod support;

use kofem_fem::{
    assemble_stiffness, solve_static, von_mises, AmgSettings, BoundaryFaces, CgSettings,
    ElementOrder, Isotropic, PreconditionerChoice, StoppingRule, SurfaceLoadKind, TetMesh,
};
use support::{box_mesh, BoxMesh};

const SETTINGS: CgSettings = CgSettings {
    relative_tolerance: 1e-11,
    max_iterations: 20_000,
    stopping: StoppingRule::ResidualNorm,
};
const GS: PreconditionerChoice = PreconditionerChoice::SymmetricGaussSeidel;
const YOUNG: f64 = 210_000.0;
const POISSON: f64 = 0.3;

fn steel() -> Isotropic {
    Isotropic::new(0, YOUNG, POISSON).expect("valid material")
}

/// The box mesh of `support`, with quadratic elements.
fn quadratic(cells: [usize; 3], size: [f64; 3]) -> BoxMesh {
    let built = box_mesh(cells, size, steel());
    BoxMesh {
        mesh: built
            .mesh
            .with_order(ElementOrder::Quadratic)
            .expect("fits"),
        ..built
    }
}

fn on_boundary(point: [f64; 3], size: [f64; 3]) -> bool {
    (0..3).any(|axis| point[axis].abs() < 1e-12 || (point[axis] - size[axis]).abs() < 1e-12)
}

/// Faces of the box side `axis` = `value`, as vertex triples.
fn side(mesh: &TetMesh, axis: usize, value: f64) -> Vec<[u32; 3]> {
    let on = |vertex: u32| (mesh.vertices()[vertex as usize][axis] - value).abs() < 1e-12;
    let mut faces = Vec::new();
    for tet in mesh.tets() {
        for skip in 0..4 {
            let face: Vec<u32> = (0..4)
                .filter(|&corner| corner != skip)
                .map(|corner| tet[corner])
                .collect();
            if face.iter().all(|&vertex| on(vertex)) {
                faces.push([face[0], face[1], face[2]]);
            }
        }
    }
    faces
}

#[test]
fn quadratic_mesh_numbers_vertices_first_then_one_node_per_edge() {
    let built = box_mesh([2, 1, 1], [2.0, 1.0, 1.0], steel());
    assert_eq!(built.mesh.vertices(), built.vertices.as_slice());
    let linear = built.mesh;
    let mesh = linear
        .clone()
        .with_order(ElementOrder::Quadratic)
        .expect("fits");
    // The distinct edges, counted independently from the tets.
    let mut edges: Vec<[u32; 2]> = Vec::new();
    for tet in linear.tets() {
        for first in 0..4 {
            for second in first + 1..4 {
                let pair = [tet[first].min(tet[second]), tet[first].max(tet[second])];
                edges.push(pair);
            }
        }
    }
    edges.sort_unstable();
    edges.dedup();
    assert_eq!(mesh.vertex_count(), linear.vertex_count());
    assert_eq!(mesh.node_count(), linear.vertex_count() + edges.len());
    assert_eq!(mesh.edges(), edges.as_slice());
    assert_eq!(mesh.vertices(), linear.vertices());
    for tet in 0..mesh.tets().len() {
        let nodes = mesh.element_nodes(tet);
        assert_eq!(nodes.len(), 10);
        assert_eq!(&nodes[..4], &mesh.tets()[tet]);
        for (slot, &node) in nodes[4..].iter().enumerate() {
            let [first, second] = mesh.edges()[node as usize - mesh.vertex_count()];
            let corners = kofem_fem::mesh::EDGES_OF_TET[slot].map(|corner| nodes[corner]);
            assert_eq!(
                [first, second],
                [corners[0].min(corners[1]), corners[0].max(corners[1])]
            );
            let point = mesh.node_coordinates()[node as usize];
            let (lhs, rhs) = (
                mesh.vertices()[first as usize],
                mesh.vertices()[second as usize],
            );
            for axis in 0..3 {
                assert!((point[axis] - 0.5 * (lhs[axis] + rhs[axis])).abs() < 1e-15);
            }
        }
    }
    // Back to linear drops the edge nodes again.
    let back = mesh.with_order(ElementOrder::Linear).expect("fits");
    assert_eq!(back.node_count(), linear.vertex_count());
    assert_eq!(back.element_nodes(0), &linear.tets()[0]);
}

/// Patch test at order 2: a linear field prescribed on the boundary vertices
/// only — the boundary edge nodes inherit it through the edge-node rule — is
/// reproduced exactly at every node, and the stress is the field's.
#[test]
fn linear_field_is_reproduced_exactly_from_vertex_conditions() {
    let size = [2.0, 1.5, 1.0];
    let built = quadratic([3, 2, 2], size);
    let mesh = &built.mesh;
    let gradient = [
        [1e-3, 2e-4, -3e-4],
        [5e-4, -1e-3, 1e-4],
        [-2e-4, 3e-4, 7e-4],
    ];
    let field = |point: [f64; 3]| -> [f64; 3] {
        let mut value = [1e-3, -2e-3, 5e-4];
        for row in 0..3 {
            for col in 0..3 {
                value[row] += gradient[row][col] * point[col];
            }
        }
        value
    };
    let mut dofs = Vec::new();
    let mut values = Vec::new();
    for (vertex, point) in mesh.vertices().iter().enumerate() {
        if on_boundary(*point, built.size) {
            for (component, value) in field(*point).into_iter().enumerate() {
                dofs.push((3 * vertex + component) as u32);
                values.push(value);
            }
        }
    }
    let stiffness = assemble_stiffness(mesh);
    let forces = vec![0.0; mesh.dof_count()];
    let solution =
        solve_static(mesh, &stiffness, &dofs, &values, &forces, SETTINGS, GS).expect("solves");
    assert!(solution.iterations > 0, "the interior must be solved for");
    for (node, point) in mesh.node_coordinates().iter().enumerate() {
        let expected = field(*point);
        for component in 0..3 {
            let got = solution.displacements[3 * node + component];
            assert!(
                (got - expected[component]).abs() < 1e-12,
                "node {node} component {component}: {got} vs {expected:?}"
            );
        }
    }

    // Uniform stress σ = λ·tr(ε)·I + 2μ·ε of the field's constant strain.
    let (lambda, mu) = steel().lame();
    let trace = gradient[0][0] + gradient[1][1] + gradient[2][2];
    let sigma: [[f64; 3]; 3] = std::array::from_fn(|row| {
        std::array::from_fn(|col| {
            let strain = 0.5 * (gradient[row][col] + gradient[col][row]);
            2.0 * mu * strain + if row == col { lambda * trace } else { 0.0 }
        })
    });
    let mean = (sigma[0][0] + sigma[1][1] + sigma[2][2]) / 3.0;
    let mut sum = 0.0;
    for (row, entries) in sigma.iter().enumerate() {
        for (col, entry) in entries.iter().enumerate() {
            let deviator = entry - if row == col { mean } else { 0.0 };
            sum += deviator * deviator;
        }
    }
    let expected = (1.5 * sum).sqrt();
    let stresses = von_mises(mesh, &solution.displacements).expect("fits");
    assert_eq!(stresses.len(), mesh.tets().len());
    for stress in stresses {
        assert!((stress - expected).abs() < 1e-9 * expected);
    }
}

/// Higher-order patch test: the exact pure-bending solution of elasticity is
/// quadratic and needs no body force, so with every boundary node prescribed
/// (edge nodes included, at their exact — not mean — values) the interior is
/// reproduced exactly and the centre stress is `σ_xx = E·κ·z`. Interior edges
/// that join two boundary vertices would take the mean by the edge-node rule,
/// so they are prescribed at their exact values too.
#[test]
fn pure_bending_field_is_reproduced_exactly() {
    let size = [3.0, 2.0, 2.0];
    let built = quadratic([3, 2, 2], size);
    let mesh = &built.mesh;
    let kappa = 1e-4;
    let field = |[along, across, height]: [f64; 3]| -> [f64; 3] {
        [
            kappa * along * height,
            -POISSON * kappa * across * height,
            -0.5 * kappa * (along * along + POISSON * (height * height - across * across)),
        ]
    };
    let mut dofs = Vec::new();
    let mut values = Vec::new();
    let vertex_on_boundary =
        |vertex: u32| on_boundary(mesh.vertices()[vertex as usize], built.size);
    for (node, point) in mesh.node_coordinates().iter().enumerate() {
        let joins_boundary = node >= mesh.vertex_count() && {
            let [first, second] = mesh.edges()[node - mesh.vertex_count()];
            vertex_on_boundary(first) && vertex_on_boundary(second)
        };
        if on_boundary(*point, built.size) || joins_boundary {
            for (component, value) in field(*point).into_iter().enumerate() {
                dofs.push((3 * node + component) as u32);
                values.push(value);
            }
        }
    }
    let stiffness = assemble_stiffness(mesh);
    let forces = vec![0.0; mesh.dof_count()];
    let solution =
        solve_static(mesh, &stiffness, &dofs, &values, &forces, SETTINGS, GS).expect("solves");
    assert!(solution.iterations > 0, "the interior must be solved for");
    for (node, point) in mesh.node_coordinates().iter().enumerate() {
        let expected = field(*point);
        for component in 0..3 {
            let got = solution.displacements[3 * node + component];
            assert!(
                (got - expected[component]).abs() < 1e-12,
                "node {node} component {component}: {got} vs {expected:?}"
            );
        }
    }
    let stresses = von_mises(mesh, &solution.displacements).expect("fits");
    for (tet, stress) in stresses.into_iter().enumerate() {
        let centre_z: f64 = mesh
            .corners(tet)
            .iter()
            .map(|corner| corner[2])
            .sum::<f64>()
            / 4.0;
        let expected = YOUNG * kappa * centre_z.abs();
        assert!(
            (stress - expected).abs() < 1e-9 * YOUNG * kappa,
            "tet {tet}: {stress} vs {expected}"
        );
    }
}

#[test]
fn surface_load_on_six_node_faces_goes_to_the_edge_nodes() {
    let size = [4.0, 2.0, 1.0];
    let built = quadratic([4, 2, 2], size);
    let mesh = &built.mesh;
    let boundary = BoundaryFaces::new(mesh);
    let mut forces = vec![0.0; mesh.dof_count()];
    let faces = side(mesh, 0, size[0]);
    let report = boundary
        .apply(
            mesh,
            0,
            &faces,
            SurfaceLoadKind::Force([0.0, 0.0, -600.0]),
            &mut forces,
        )
        .expect("applies");
    assert_eq!(report.matched, faces.len());
    let mut total = [0.0; 3];
    for (node, chunk) in forces.chunks_exact(3).enumerate() {
        for axis in 0..3 {
            total[axis] += chunk[axis];
        }
        if node < mesh.vertex_count() {
            assert!(
                chunk.iter().all(|&force| force == 0.0),
                "corner {node} of a 6-node face carries no load, got {chunk:?}"
            );
        } else if chunk.iter().any(|&force| force != 0.0) {
            let [first, second] = mesh.edges()[node - mesh.vertex_count()];
            for vertex in [first, second] {
                assert!((mesh.vertices()[vertex as usize][0] - size[0]).abs() < 1e-12);
            }
        }
    }
    assert!(total[0].abs() < 1e-9 && total[1].abs() < 1e-9);
    assert!((total[2] + 600.0).abs() < 1e-9);
}

/// Cantilever clamped at x = 0 (vertex conditions only), loaded by a total
/// shear force on x = L. Quadratic tets resolve bending: the tip deflection
/// matches Timoshenko beam theory within the effect of the Poisson-restrained
/// clamp, where linear tets on the same mesh lock badly. AMG finds the same
/// field as Gauss–Seidel, and the clamp holds the edge nodes on it.
#[test]
fn cantilever_matches_beam_theory_at_order_2() {
    let size = [100.0, 10.0, 10.0];
    let cells = [20, 2, 2];
    let force = -1000.0;
    let solve = |mesh: &TetMesh, preconditioner| {
        let mut dofs = Vec::new();
        for (vertex, point) in mesh.vertices().iter().enumerate() {
            if point[0].abs() < 1e-12 {
                dofs.extend((0..3).map(|component| (3 * vertex + component) as u32));
            }
        }
        let values = vec![0.0; dofs.len()];
        let mut forces = vec![0.0; mesh.dof_count()];
        BoundaryFaces::new(mesh)
            .apply(
                mesh,
                0,
                &side(mesh, 0, size[0]),
                SurfaceLoadKind::Force([0.0, 0.0, force]),
                &mut forces,
            )
            .expect("applies");
        let stiffness = assemble_stiffness(mesh);
        solve_static(
            mesh,
            &stiffness,
            &dofs,
            &values,
            &forces,
            SETTINGS,
            preconditioner,
        )
        .expect("solves")
    };
    let tip_deflection = |mesh: &TetMesh, displacements: &[f64]| -> f64 {
        let tip: Vec<usize> = (0..mesh.vertex_count())
            .filter(|&vertex| (mesh.vertices()[vertex][0] - size[0]).abs() < 1e-12)
            .collect();
        tip.iter()
            .map(|&vertex| displacements[3 * vertex + 2])
            .sum::<f64>()
            / tip.len() as f64
    };

    let built = quadratic(cells, size);
    let mesh = &built.mesh;
    let gauss_seidel = solve(mesh, GS);
    let amg = solve(
        mesh,
        PreconditionerChoice::SmoothedAggregation(AmgSettings::default()),
    );
    let deflection = tip_deflection(mesh, &gauss_seidel.displacements);

    let inertia = size[1] * size[2].powi(3) / 12.0;
    let shear_modulus = YOUNG / (2.0 * (1.0 + POISSON));
    let area = size[1] * size[2];
    let timoshenko = force * size[0].powi(3) / (3.0 * YOUNG * inertia)
        + force * size[0] / (5.0 / 6.0 * shear_modulus * area);
    let ratio = deflection / timoshenko;
    assert!(
        (0.97..=1.0).contains(&ratio),
        "order-2 tip deflection {deflection} vs Timoshenko {timoshenko} (ratio {ratio})"
    );

    let linear = box_mesh(cells, size, steel()).mesh;
    let linear_ratio = tip_deflection(&linear, &solve(&linear, GS).displacements) / timoshenko;
    assert!(
        linear_ratio < ratio - 0.2,
        "linear tets should lock in bending: ratio {linear_ratio} vs order 2 {ratio}"
    );

    let peak = gauss_seidel
        .displacements
        .iter()
        .fold(0.0_f64, |peak, value| peak.max(value.abs()));
    for (lhs, rhs) in gauss_seidel.displacements.iter().zip(&amg.displacements) {
        assert!(
            (lhs - rhs).abs() < 1e-8 * peak,
            "AMG {rhs} vs Gauss–Seidel {lhs}"
        );
    }
    assert!(
        amg.iterations < gauss_seidel.iterations,
        "AMG took {} iterations, Gauss–Seidel {}",
        amg.iterations,
        gauss_seidel.iterations
    );
    assert!(
        amg.levels.len() > 1,
        "AMG must coarsen the quadratic system"
    );

    assert_clamp_holds_its_edge_nodes(mesh, &gauss_seidel.displacements);
}

/// Edge nodes on the clamp (x = 0) are held; an edge leaving it is free.
fn assert_clamp_holds_its_edge_nodes(mesh: &TetMesh, displacements: &[f64]) {
    let mut clamped_edges = 0;
    let mut leaving_edges = 0;
    for (edge, &[first, second]) in mesh.edges().iter().enumerate() {
        let at_root = |vertex: u32| mesh.vertices()[vertex as usize][0].abs() < 1e-12;
        let node = mesh.vertex_count() + edge;
        let motion = &displacements[3 * node..3 * node + 3];
        if at_root(first) && at_root(second) {
            clamped_edges += 1;
            assert!(
                motion.iter().all(|&value| value == 0.0),
                "clamped edge node {node} moved"
            );
        } else if at_root(first) || at_root(second) {
            leaving_edges += 1;
            assert!(
                motion.iter().any(|&value| value != 0.0),
                "edge node {node} is not clamped"
            );
        }
    }
    assert!(clamped_edges > 0 && leaving_edges > 0);
}

/// A prescribed displacement on both ends of an edge carries over to its edge
/// node at the mean value, and an edge-node DOF set explicitly keeps its own.
#[test]
fn edge_nodes_take_the_mean_of_prescribed_vertex_values() {
    let size = [2.0, 1.0, 1.0];
    let built = quadratic([2, 1, 1], size);
    let mesh = &built.mesh;
    // Clamp x = 0, and pull x = L axially by u_x = 0.01·(1 + y) — a linear
    // profile, so the mean at each edge node is the profile's value there.
    let mut dofs = Vec::new();
    let mut values = Vec::new();
    for (vertex, point) in mesh.vertices().iter().enumerate() {
        if point[0].abs() < 1e-12 {
            for component in 0..3 {
                dofs.push((3 * vertex + component) as u32);
                values.push(0.0);
            }
        } else if (point[0] - size[0]).abs() < 1e-12 {
            dofs.push((3 * vertex) as u32);
            values.push(0.01 * (1.0 + point[1]));
        }
    }
    // One end edge node set explicitly to a value off the profile.
    let end_edge = mesh
        .edges()
        .iter()
        .position(|&[first, second]| {
            [first, second]
                .iter()
                .all(|&vertex| (mesh.vertices()[vertex as usize][0] - size[0]).abs() < 1e-12)
        })
        .expect("the end face has edges");
    let explicit = mesh.vertex_count() + end_edge;
    dofs.push((3 * explicit) as u32);
    values.push(0.5);

    let stiffness = assemble_stiffness(mesh);
    let forces = vec![0.0; mesh.dof_count()];
    let solution =
        solve_static(mesh, &stiffness, &dofs, &values, &forces, SETTINGS, GS).expect("solves");
    for (edge, &[first, second]) in mesh.edges().iter().enumerate() {
        let node = mesh.vertex_count() + edge;
        let point = mesh.node_coordinates()[node];
        let at_end = |vertex: u32| (mesh.vertices()[vertex as usize][0] - size[0]).abs() < 1e-12;
        if at_end(first) && at_end(second) {
            let expected = if node == explicit {
                0.5
            } else {
                0.01 * (1.0 + point[1])
            };
            let got = solution.displacements[3 * node];
            assert!(
                (got - expected).abs() < 1e-9,
                "edge node {node}: {got} vs {expected}"
            );
        }
    }
}

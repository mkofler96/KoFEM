// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

mod support;

use kofem_fem::{
    apply_dirichlet, assemble_stiffness, solve_pcg, solve_static, CgSettings, Dirichlet, FemError,
    Isotropic, PreconditionerChoice, TetMesh,
};

const GS: PreconditionerChoice = PreconditionerChoice::SymmetricGaussSeidel;
use support::box_mesh;

const SETTINGS: CgSettings = CgSettings {
    relative_tolerance: 1e-10,
    max_iterations: 10_000,
};

fn steel() -> Isotropic {
    Isotropic::new(0, 210_000.0, 0.3).expect("valid material")
}

fn on_boundary(point: [f64; 3], size: [f64; 3]) -> bool {
    (0..3).any(|axis| point[axis].abs() < 1e-12 || (point[axis] - size[axis]).abs() < 1e-12)
}

/// Patch test: any linear displacement field is reproduced exactly by linear
/// tetrahedra. Prescribe it on the boundary; every interior node must match.
#[test]
fn linear_field_is_reproduced_exactly() {
    let built = box_mesh([4, 3, 3], [2.0, 1.5, 1.0], steel());
    let gradient = [
        [1e-3, 2e-4, -3e-4],
        [5e-4, -1e-3, 1e-4],
        [-2e-4, 3e-4, 7e-4],
    ];
    let offset = [1e-3, -2e-3, 5e-4];
    let field = |point: [f64; 3]| -> [f64; 3] {
        let mut value = offset;
        for row in 0..3 {
            for col in 0..3 {
                value[row] += gradient[row][col] * point[col];
            }
        }
        value
    };

    let mut dofs = Vec::new();
    let mut values = Vec::new();
    for (node, point) in built.vertices.iter().enumerate() {
        if on_boundary(*point, built.size) {
            for (component, value) in field(*point).into_iter().enumerate() {
                dofs.push((3 * node + component) as u32);
                values.push(value);
            }
        }
    }
    let dof_count = 3 * built.mesh.vertex_count();
    let constraints = Dirichlet::new(dof_count, &dofs, &values).expect("valid constraints");
    let mut matrix = assemble_stiffness(&built.mesh);
    let mut rhs = vec![0.0; dof_count];
    apply_dirichlet(&mut matrix, &mut rhs, &constraints);
    let (displacement, outcome) = solve_pcg(&matrix, &rhs, SETTINGS).expect("converges");
    assert!(
        outcome.iterations > 0,
        "the interior must actually be solved for"
    );

    for (node, point) in built.vertices.iter().enumerate() {
        let expected = field(*point);
        for component in 0..3 {
            let got = displacement[3 * node + component];
            assert!(
                (got - expected[component]).abs() < 1e-9,
                "node {node} component {component}: {got} vs {expected:?}"
            );
        }
    }
}

/// Uniaxial tension of a bar: clamp x = 0 axially (with the rigid-body modes
/// removed), pull x = L with work-equivalent nodal forces of a uniform stress.
/// Uniform stress is in the tet4 space, so the extension is σ·L/E exactly.
#[test]
fn bar_extension_matches_hookes_law() {
    let size = [10.0, 2.0, 2.0];
    let built = box_mesh([10, 2, 2], size, steel());
    let stress = 100.0;
    let dof_count = 3 * built.mesh.vertex_count();

    let mut dofs = Vec::new();
    for (node, point) in built.vertices.iter().enumerate() {
        if point[0].abs() < 1e-12 {
            dofs.push((3 * node) as u32);
            if point[1].abs() < 1e-12 {
                dofs.push((3 * node + 1) as u32);
            }
            if point[2].abs() < 1e-12 {
                dofs.push((3 * node + 2) as u32);
            }
        }
    }
    let values = vec![0.0; dofs.len()];
    let constraints = Dirichlet::new(dof_count, &dofs, &values).expect("valid constraints");

    // Work-equivalent load of a uniform traction: each end-face triangle
    // gives a third of its force to each of its corners.
    let mut rhs = vec![0.0; dof_count];
    for tet in built.mesh.tets() {
        let on_end: Vec<u32> = tet
            .iter()
            .copied()
            .filter(|&node| (built.vertices[node as usize][0] - size[0]).abs() < 1e-12)
            .collect();
        if on_end.len() == 3 {
            let corner = |slot: usize| built.vertices[on_end[slot] as usize];
            let (first, second, third) = (corner(0), corner(1), corner(2));
            let area = 0.5
                * ((second[1] - first[1]) * (third[2] - first[2])
                    - (second[2] - first[2]) * (third[1] - first[1]))
                    .abs();
            for &node in &on_end {
                rhs[3 * node as usize] += stress * area / 3.0;
            }
        }
    }
    let mut matrix = assemble_stiffness(&built.mesh);
    apply_dirichlet(&mut matrix, &mut rhs, &constraints);
    let (displacement, _) = solve_pcg(&matrix, &rhs, SETTINGS).expect("converges");

    let expected = stress * size[0] / 210_000.0;
    for (node, point) in built.vertices.iter().enumerate() {
        if (point[0] - size[0]).abs() < 1e-12 {
            let got = displacement[3 * node];
            assert!(
                (got - expected).abs() < 1e-9 * expected.max(1.0),
                "{got} vs {expected}"
            );
        }
    }
}

#[test]
fn unconstrained_model_is_refused() {
    let built = box_mesh([2, 1, 1], [2.0, 1.0, 1.0], steel());
    let dof_count = 3 * built.mesh.vertex_count();
    let mut rhs = vec![0.0; dof_count];
    rhs[0] = 1.0;
    let matrix = assemble_stiffness(&built.mesh);
    let settings = CgSettings {
        relative_tolerance: 1e-10,
        max_iterations: 500,
    };
    let result = solve_pcg(&matrix, &rhs, settings);
    assert!(
        matches!(
            result,
            Err(FemError::NotPositiveDefinite { .. } | FemError::NotConverged { .. })
        ),
        "a floating model must not return a displacement, got {result:?}"
    );
}

#[test]
fn malformed_input_is_refused_with_its_reason() {
    let tet = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    let flat = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0];
    let make = |vertices: &[f64], tets: &[u32]| TetMesh::new(vertices, tets, &[0], vec![steel()]);
    assert_eq!(
        make(&tet, &[0, 1, 2, 4]).err(),
        Some(FemError::VertexOutOfRange {
            tet: 0,
            vertex: 4,
            count: 4
        })
    );
    assert_eq!(
        make(&flat, &[0, 1, 2, 3]).err(),
        Some(FemError::DegenerateTet { tet: 0 })
    );
    assert_eq!(
        make(&tet[..11], &[0, 1, 2, 3]).err(),
        Some(FemError::VertexArrayLength { len: 11 })
    );
    assert_eq!(
        Isotropic::new(2, 1.0, 0.5).err(),
        Some(FemError::PoissonRatio {
            index: 2,
            value: 0.5
        })
    );
    assert_eq!(
        Dirichlet::new(12, &[3, 3], &[0.0, 1.0]).err(),
        Some(FemError::ConflictingConstraint {
            dof: 3,
            first: 0.0,
            second: 1.0
        })
    );
    assert_eq!(
        Dirichlet::new(12, &[12], &[0.0]).err(),
        Some(FemError::DofOutOfRange { dof: 12, count: 12 })
    );
}

/// Meshers can leave vertices no element uses (Netgen did on a 208k-tet NIST
/// model, KOF-299). They have no stiffness: the solve must hold them, not
/// index past an empty matrix row, and must refuse to load or support them.
#[test]
fn vertices_no_element_uses_are_held_and_cannot_be_loaded() {
    let built = box_mesh([2, 2, 2], [1.0, 1.0, 1.0], steel());
    let mut flat: Vec<f64> = built.vertices.iter().flatten().copied().collect();
    flat.extend_from_slice(&[5.0, 5.0, 5.0]); // the stray vertex
    let stray = built.vertices.len();
    let tets: Vec<u32> = built.mesh.tets().iter().flatten().copied().collect();
    let mesh = TetMesh::new(&flat, &tets, &vec![0; tets.len() / 4], vec![steel()]).expect("valid");
    assert_eq!(mesh.unused_vertex_count(), 1);

    // The patch field again, prescribed on the box boundary only.
    let field = |point: [f64; 3]| [1e-3 * point[0], -3e-4 * point[1], 2e-4 * point[2]];
    let mut dofs = Vec::new();
    let mut values = Vec::new();
    for (node, point) in built.vertices.iter().enumerate() {
        if on_boundary(*point, built.size) {
            for (component, value) in field(*point).into_iter().enumerate() {
                dofs.push((3 * node + component) as u32);
                values.push(value);
            }
        }
    }
    let stiffness = assemble_stiffness(&mesh);
    let forces = vec![0.0; 3 * mesh.vertex_count()];
    let solution =
        solve_static(&mesh, &stiffness, &dofs, &values, &forces, SETTINGS, GS).expect("solves");
    assert_eq!(solution.unused_vertices, 1);
    assert_eq!(
        &solution.displacements[3 * stray..3 * stray + 3],
        &[0.0, 0.0, 0.0]
    );
    for (node, point) in built.vertices.iter().enumerate() {
        for (component, expected) in field(*point).into_iter().enumerate() {
            assert!((solution.displacements[3 * node + component] - expected).abs() < 1e-9);
        }
    }

    let mut loaded = forces.clone();
    loaded[3 * stray + 1] = 1.0;
    assert_eq!(
        solve_static(&mesh, &stiffness, &dofs, &values, &loaded, SETTINGS, GS).err(),
        Some(FemError::LoadOnUnusedVertex { vertex: stray })
    );
    let mut supported = dofs.clone();
    supported.push((3 * stray) as u32);
    let mut supported_values = values.clone();
    supported_values.push(0.0);
    assert_eq!(
        solve_static(
            &mesh,
            &stiffness,
            &supported,
            &supported_values,
            &forces,
            SETTINGS,
            GS
        )
        .err(),
        Some(FemError::ConstraintOnUnusedVertex { vertex: stray })
    );
}

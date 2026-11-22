// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Memory of setting up a solve (KOF-457): the solve takes the assembled
//! stiffness matrix rather than copying it, keeps only the entries its
//! supports overwrite, and gives the assembled matrix back exactly when asked
//! — for the support reactions and the next load case.
//!
//! "Takes" is checked directly: the solver's matrix is the very allocation
//! that was handed in.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

mod support;

use kofem_fem::shell::SHELL_NODE_DOFS;
use kofem_fem::{
    assemble_shell_stiffness, assemble_stiffness, prepare_shell_static, prepare_static,
    AmgSettings, CsrMatrix, Isotropic, PreconditionerChoice, ShellMesh,
};
use support::box_mesh;

fn steel() -> Isotropic {
    Isotropic::new(0, 210_000.0, 0.3).expect("valid material")
}

/// A long beam clamped at x = 0 and pulled at the tip: the clamp holds a
/// small share of the DOFs, as a real support does.
fn beam() -> (support::BoxMesh, Vec<u32>, Vec<f64>) {
    let built = box_mesh([24, 3, 3], [240.0, 30.0, 30.0], steel());
    let mut fixed = Vec::new();
    let mut forces = vec![0.0; 3 * built.vertices.len()];
    for (node, point) in built.vertices.iter().enumerate() {
        if point[0].abs() < 1e-12 {
            fixed.extend((0..3).map(|component| (3 * node + component) as u32));
        } else if (point[0] - built.size[0]).abs() < 1e-12 {
            forces[3 * node + 2] = -10.0;
        }
    }
    (built, fixed, forces)
}

fn assert_identical(got: &CsrMatrix, want: &CsrMatrix) {
    assert_eq!(got.rows(), want.rows());
    assert_eq!(got.columns(), want.columns());
    for (position, (back, assembled)) in got.values().iter().zip(want.values()).enumerate() {
        assert!(
            back.to_bits() == assembled.to_bits(),
            "entry {position}: given back {back}, assembled {assembled}"
        );
    }
}

#[test]
fn a_solid_solve_does_not_copy_the_stiffness_matrix() {
    let (built, fixed, forces) = beam();
    let values = vec![0.0; fixed.len()];
    for choice in [
        PreconditionerChoice::SymmetricGaussSeidel,
        PreconditionerChoice::SmoothedAggregation(AmgSettings::default()),
    ] {
        let stiffness = assemble_stiffness(&built.mesh);
        let handed_in = stiffness.values().as_ptr();
        let prepared = prepare_static(&built.mesh, stiffness, &fixed, &values, &forces, choice)
            .expect("prepares");
        assert_eq!(
            prepared.system.matrix().values().as_ptr(),
            handed_in,
            "{choice:?}: the solve works on a copy of the stiffness matrix"
        );
        // What it keeps for the reactions is the clamp's share, not a matrix.
        assert!(
            prepared.eliminated_entries() < prepared.system.matrix().nnz() / 10,
            "{choice:?}: {} entries kept of {}",
            prepared.eliminated_entries(),
            prepared.system.matrix().nnz()
        );
    }
}

#[test]
fn a_solid_solve_gives_the_assembled_matrix_back() {
    let (built, fixed, forces) = beam();
    let stiffness = assemble_stiffness(&built.mesh);
    // Prescribed values that are not zero, so the right-hand side moves too.
    let values: Vec<f64> = (0..fixed.len()).map(|i| 0.01 * (i % 5) as f64).collect();
    for choice in [
        PreconditionerChoice::SymmetricGaussSeidel,
        PreconditionerChoice::SmoothedAggregation(AmgSettings::default()),
    ] {
        let prepared = prepare_static(
            &built.mesh,
            stiffness.clone(),
            &fixed,
            &values,
            &forces,
            choice,
        )
        .expect("prepares");
        let handed_in = prepared.system.matrix().values().as_ptr();
        let given_back = prepared.into_stiffness().expect("uncoupled");
        assert_eq!(given_back.values().as_ptr(), handed_in, "{choice:?}");
        assert_identical(&given_back, &stiffness);
    }
}

fn plate() -> (ShellMesh, Vec<u32>, Vec<f64>) {
    let (nx, ny) = (30, 4);
    let mut flat = Vec::new();
    for i in 0..=nx {
        for j in 0..=ny {
            flat.extend([10.0 * i as f64, 10.0 * j as f64, 0.0]);
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
    let count = triangles.len() / 3;
    let mesh = ShellMesh::new(
        &flat,
        &triangles,
        &vec![1.0; count],
        &vec![0; count],
        vec![steel()],
    )
    .expect("valid shell");
    let fixed: Vec<u32> = (0..=ny)
        .flat_map(|j| {
            (0..SHELL_NODE_DOFS).map(move |dof| SHELL_NODE_DOFS as u32 * id(0, j) + dof as u32)
        })
        .collect();
    let mut forces = vec![0.0; SHELL_NODE_DOFS * mesh.vertex_count()];
    for j in 0..=ny {
        forces[SHELL_NODE_DOFS * id(nx, j) as usize + 2] = -10.0;
    }
    (mesh, fixed, forces)
}

#[test]
fn a_shell_solve_does_not_copy_the_stiffness_matrix() {
    let (mesh, fixed, forces) = plate();
    let stiffness = assemble_shell_stiffness(&mesh);
    let handed_in = stiffness.values().as_ptr();
    let values = vec![0.0; fixed.len()];
    let prepared = prepare_shell_static(&mesh, stiffness, &fixed, &values, &forces)
        .expect("prepares")
        .prepared;
    assert_eq!(
        prepared.system.matrix().values().as_ptr(),
        handed_in,
        "the shell solve works on a copy of the stiffness matrix"
    );
}

#[test]
fn a_shell_solve_gives_the_assembled_matrix_back() {
    let (mesh, fixed, forces) = plate();
    let stiffness = assemble_shell_stiffness(&mesh);
    let values: Vec<f64> = (0..fixed.len()).map(|i| 0.001 * (i % 3) as f64).collect();
    let prepared = prepare_shell_static(&mesh, stiffness.clone(), &fixed, &values, &forces)
        .expect("prepares")
        .prepared;
    assert_identical(&prepared.into_stiffness().expect("uncoupled"), &stiffness);
}

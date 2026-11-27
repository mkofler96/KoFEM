// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! An open-ended thin tube under internal pressure on structured meshes whose
//! nodes lie on the exact mid-surface cylinder (KOF-453). The exact response
//! is uniform: every ring moves out by p·R²/(E·t), the free end included.
//!
//! On a curved surface the rotation about one facet's normal is partly a
//! bending rotation of its neighbours. Taken as each facet's drilling DOF, it
//! let a free edge flare and shed hoop strain: the end rings moved out 46 %
//! too far on 64 cells round. The drilling DOF is the rotation about the
//! smooth surface's normal instead.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

use kofem_fem::{
    assemble_shell_stiffness, solve_shell_static, CgSettings, Isotropic, ShellMesh, StoppingRule,
};

const SETTINGS: CgSettings = CgSettings {
    relative_tolerance: 1e-10,
    max_iterations: 100_000,
    stopping: StoppingRule::ResidualNorm,
};

/// Millimetres, newtons, megapascals.
const RADIUS: f64 = 1000.0;
const THICKNESS: f64 = 10.0;
const LENGTH: f64 = 1000.0;
const YOUNG: f64 = 210_000.0;
const POISSON: f64 = 0.3;
const PRESSURE: f64 = 1.0;

/// A tube of `around` cells round and square cells along it, alternating
/// diagonals; node (i, j) = j·around + i. Returns the mesh and the cell count
/// along.
fn tube(around: usize) -> (ShellMesh, usize) {
    let cell = std::f64::consts::TAU * RADIUS / around as f64;
    let along = (LENGTH / cell).round() as usize;
    let mut vertices = Vec::new();
    for j in 0..=along {
        for i in 0..around {
            let angle = std::f64::consts::TAU * i as f64 / around as f64;
            vertices.extend([
                RADIUS * angle.cos(),
                RADIUS * angle.sin(),
                LENGTH * j as f64 / along as f64,
            ]);
        }
    }
    let id = |i: usize, j: usize| (j * around + i % around) as u32;
    let mut triangles = Vec::new();
    for j in 0..along {
        for i in 0..around {
            let (a0, a1, a2, a3) = (id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1));
            if (i + j) % 2 == 0 {
                triangles.extend([a0, a1, a2, a0, a2, a3]);
            } else {
                triangles.extend([a0, a1, a3, a1, a2, a3]);
            }
        }
    }
    let count = triangles.len() / 3;
    let mesh = ShellMesh::new(
        &vertices,
        &triangles,
        &vec![THICKNESS; count],
        &vec![0; count],
        vec![Isotropic::new(0, YOUNG, POISSON).expect("valid material")],
    )
    .expect("valid mesh");
    (mesh, along)
}

/// Mean radial displacement of the rings z = 0, z = L/2 and z = L, over
/// p·R²/(E·t).
fn ring_expansion(around: usize) -> [f64; 3] {
    let (mesh, along) = tube(around);
    let id = |i: usize, j: usize| (j * around + i % around) as u32;

    // The pressure on each facet, a third to each corner, along the facet's
    // outward normal (the corner order above turns it outward).
    let mut forces = vec![0.0; 6 * mesh.vertex_count()];
    for (facet, nodes) in mesh.triangles().iter().enumerate() {
        let corners = mesh.corners(facet);
        let first: [f64; 3] = std::array::from_fn(|k| corners[1][k] - corners[0][k]);
        let second: [f64; 3] = std::array::from_fn(|k| corners[2][k] - corners[0][k]);
        let area_normal = [
            0.5 * (first[1] * second[2] - first[2] * second[1]),
            0.5 * (first[2] * second[0] - first[0] * second[2]),
            0.5 * (first[0] * second[1] - first[1] * second[0]),
        ];
        for &node in nodes {
            for axis in 0..3 {
                forces[6 * node as usize + axis] += PRESSURE * area_normal[axis] / 3.0;
            }
        }
    }
    // Uz on the ring z = 0; Uy at θ = 0 and θ = 180°, Ux at θ = 90°.
    let mut fixed: Vec<u32> = (0..around).map(|i| 6 * id(i, 0) + 2).collect();
    fixed.extend([
        6 * id(0, 0) + 1,
        6 * id(around / 2, 0) + 1,
        6 * id(around / 4, 0),
    ]);
    let values = vec![0.0; fixed.len()];
    let stiffness = assemble_shell_stiffness(&mesh);
    let solution = solve_shell_static(&mesh, &stiffness, &fixed, &values, &forces, SETTINGS)
        .expect("the tube solves");

    let exact = PRESSURE * RADIUS * RADIUS / (YOUNG * THICKNESS);
    [0, along / 2, along].map(|j| {
        (0..around)
            .map(|column| {
                let node = id(column, j) as usize;
                let [along_x, along_y, _] = mesh.vertices()[node];
                (along_x * solution.dofs[6 * node] + along_y * solution.dofs[6 * node + 1]) / RADIUS
            })
            .sum::<f64>()
            / around as f64
            / exact
    })
}

#[test]
fn the_free_end_expands_as_the_rest_of_the_tube() {
    for (around, band) in [(64, 0.015), (128, 0.001)] {
        let [held, middle, free] = ring_expansion(around);
        for (name, ring) in [("held end", held), ("middle", middle), ("free end", free)] {
            assert!(
                (ring - 1.0).abs() < band,
                "{around} cells round: the {name} ring moves out {ring:.4} of p·R²/(E·t)"
            );
        }
        assert!(
            (free / middle - 1.0).abs() < 1e-3,
            "{around} cells round: free end {free:.4}, middle {middle:.4}"
        );
    }
}

#[test]
fn a_rigid_motion_of_the_curved_tube_loads_nothing() {
    let (mesh, _) = tube(32);
    let stiffness = assemble_shell_stiffness(&mesh);
    let offset = [0.3, -0.2, 0.1];
    let spin = [2e-4, -3e-4, 1e-4];
    let motion: Vec<f64> = mesh
        .vertices()
        .iter()
        .flat_map(|point| {
            let turn = [
                spin[1] * point[2] - spin[2] * point[1],
                spin[2] * point[0] - spin[0] * point[2],
                spin[0] * point[1] - spin[1] * point[0],
            ];
            [
                offset[0] + turn[0],
                offset[1] + turn[1],
                offset[2] + turn[2],
                spin[0],
                spin[1],
                spin[2],
            ]
        })
        .collect();
    let mut forces = vec![0.0; motion.len()];
    stiffness.mul_vec(&motion, &mut forces);
    let largest = stiffness
        .values()
        .iter()
        .fold(0.0_f64, |acc, value| acc.max(value.abs()));
    let worst = forces
        .iter()
        .fold(0.0_f64, |acc, value| acc.max(value.abs()));
    assert!(
        worst <= 1e-9 * largest,
        "a rigid motion loads a DOF with {worst:e} (largest stiffness {largest:e})"
    );
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! NAFEMS LE3, the pinched hemisphere with an 18° hole, on structured meshes
//! whose nodes lie on the exact mid-surface sphere (KOF-453). These meshes
//! leave out the shellized geometry, the CAD load patches and the mesher, so
//! what they show belongs to the element.
//!
//! On a curved surface the rotation about one facet's normal is partly a
//! bending rotation of its neighbours. A drilling DOF held by a fictitious
//! spring therefore stiffened bending more the finer the mesh, and LE3
//! drifted to 4 % below 185 mm. With the drilling DOF the true in-plane
//! rotation of an Allman-type membrane, about the smooth surface's normal,
//! LE3 converges from below, as flat facets do on a doubly curved shell:
//! 173 mm on 500 mm facets, then 186 and 187 mm.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

use kofem_fem::{
    assemble_shell_stiffness, solve_shell_static, CgSettings, CsrMatrix, Isotropic, ShellMesh,
    StoppingRule,
};

/// The app's shell stopping rule. Ux at A is the same to five digits at
/// 1e-8 and 1e-14, so the drift is not left-over algebraic error.
const SETTINGS: CgSettings = CgSettings {
    relative_tolerance: 1e-10,
    max_iterations: 100_000,
    stopping: StoppingRule::ResidualNorm,
};

/// NAFEMS LE3 in millimetres, newtons and megapascals.
const RADIUS: f64 = 10_000.0;
const THICKNESS: f64 = 40.0;
const YOUNG: f64 = 68_250.0;
const POISSON: f64 = 0.3;
const LOAD: f64 = 2000.0;
const HOLE_ELEVATION_DEG: f64 = 72.0;
const REFERENCE_UX: f64 = 185.0;

/// A quarter hemisphere of `cells[0]` cells around (θ = 0..90°) by
/// `cells[1]` cells up (φ = 0..72°), each split into two triangles along
/// alternating diagonals; node (i, j) = i·(cells[1] + 1) + j.
struct Quarter {
    mesh: ShellMesh,
    cells: [usize; 2],
}

impl Quarter {
    fn new(cells: [usize; 2]) -> Self {
        let [around, up] = cells;
        let mut vertices = Vec::new();
        for i in 0..=around {
            let theta = (90.0 * i as f64 / around as f64).to_radians();
            for j in 0..=up {
                let phi = (HOLE_ELEVATION_DEG * j as f64 / up as f64).to_radians();
                vertices.extend([
                    RADIUS * phi.cos() * theta.cos(),
                    RADIUS * phi.cos() * theta.sin(),
                    RADIUS * phi.sin(),
                ]);
            }
        }
        let id = |i: usize, j: usize| (i * (up + 1) + j) as u32;
        let mut triangles = Vec::new();
        for i in 0..around {
            for j in 0..up {
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
        Self { mesh, cells }
    }

    fn node(&self, i: usize, j: usize) -> usize {
        i * (self.cells[1] + 1) + j
    }

    /// Ux at A = (R, 0, 0) under the LE3 supports and loads: symmetry
    /// (Uy, Rx, Rz) on θ = 0 and (Ux, Ry, Rz) on θ = 90°, Uz held at E on
    /// the hole edge, 2 kN out at A and 2 kN in at C.
    fn ux_at_a(&self, stiffness: &CsrMatrix) -> f64 {
        let [around, up] = self.cells;
        let mut fixed = Vec::new();
        for j in 0..=up {
            fixed.extend([1, 3, 5].map(|dof| (6 * self.node(0, j) + dof) as u32));
            fixed.extend([0, 4, 5].map(|dof| (6 * self.node(around, j) + dof) as u32));
        }
        fixed.push((6 * self.node(0, up) + 2) as u32);
        let values = vec![0.0; fixed.len()];
        let mut forces = vec![0.0; 6 * self.mesh.vertex_count()];
        forces[6 * self.node(0, 0)] = LOAD;
        forces[6 * self.node(around, 0) + 1] = -LOAD;
        let solution =
            solve_shell_static(&self.mesh, stiffness, &fixed, &values, &forces, SETTINGS)
                .expect("the hemisphere solves");
        solution.dofs[6 * self.node(0, 0)]
    }
}

/// Meshes of about 500, 250 and 125 mm along the equator, the range of the
/// app's case.
const LEVELS: [[usize; 2]; 3] = [[32, 25], [64, 51], [128, 102]];

fn percent_off(ux: f64) -> f64 {
    100.0 * (ux - REFERENCE_UX) / REFERENCE_UX
}

#[test]
fn le3_converges_from_below_to_within_two_percent() {
    let readings: Vec<f64> = LEVELS
        .iter()
        .map(|&cells| {
            let quarter = Quarter::new(cells);
            quarter.ux_at_a(&assemble_shell_stiffness(&quarter.mesh))
        })
        .collect();
    assert!(
        readings.windows(2).all(|pair| pair[1] > pair[0]),
        "readings {readings:.2?} should rise with refinement"
    );
    for (cells, ux) in LEVELS.iter().zip(&readings).skip(1) {
        assert!(
            percent_off(*ux).abs() < 2.0,
            "{cells:?}: Ux at A = {ux:.2} mm, {:+.2} % off 185 mm",
            percent_off(*ux)
        );
    }
    let (fine, finer) = (readings[1], readings[2]);
    assert!(
        (finer - fine).abs() < 0.01 * REFERENCE_UX,
        "the two finest meshes read {fine:.2} and {finer:.2} mm: still drifting"
    );
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! NAFEMS LE3, the pinched hemisphere with an 18° hole, on structured meshes
//! whose nodes lie on the exact mid-surface sphere (KOF-453). The app's case
//! (`examples/validation/cases/nafems-le3.mjs`) reads Ux at A = 185.4, 183.2,
//! 180.2 and 178.4 mm as its mesh is refined, against 185 mm. These meshes
//! leave out the shellized geometry, the CAD load patches and the mesher, so
//! what they show belongs to the element.
//!
//! The facet's fictitious drilling spring (`DRILLING_RATIO` in
//! `shell/element.rs`) acts on the rotation about each facet's own normal.
//! Where neighbouring facets meet at an angle, that rotation is also a
//! bending rotation of the neighbours, so the spring stiffens bending. The
//! angle shrinks with the mesh, but the bending stiffness it meets shrinks
//! faster (as the angle squared), so the spring locks more as the mesh is
//! refined: the drift away from 185 mm.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

use kofem_fem::shell::facet_stiffness;
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

    /// The assembled stiffness with each facet's drilling spring taken out
    /// again. The spring is the only stiffness a facet puts on the rotation
    /// about its own normal, so the facet matrix's rotation block projected
    /// on that normal is the spring itself, whatever its ratio.
    fn stiffness_without_drilling(&self) -> CsrMatrix {
        let mut matrix = assemble_shell_stiffness(&self.mesh);
        for (facet, nodes) in self.mesh.triangles().iter().enumerate() {
            let corners = self.mesh.corners(facet);
            let normal = unit_normal(&corners);
            let element = facet_stiffness(
                &corners,
                self.mesh.thickness(facet),
                self.mesh.material(facet),
            );
            for (local, &node) in nodes.iter().enumerate() {
                let block: [[f64; 3]; 3] = std::array::from_fn(|row| {
                    std::array::from_fn(|col| element[6 * local + 3 + row][6 * local + 3 + col])
                });
                let spring = dot(normal, block.map(|row| dot(row, normal)));
                for (row, normal_row) in normal.iter().enumerate() {
                    for (col, normal_col) in normal.iter().enumerate() {
                        let first = 6 * node as usize + 3;
                        let position = matrix
                            .find(first + row, first + col)
                            .expect("a node's own block is stored");
                        matrix.values_mut()[position] -= spring * normal_row * normal_col;
                    }
                }
            }
        }
        matrix
    }
}

fn unit_normal(corners: &[[f64; 3]; 3]) -> [f64; 3] {
    let first = sub(corners[1], corners[0]);
    let second = sub(corners[2], corners[0]);
    let normal = [
        first[1] * second[2] - first[2] * second[1],
        first[2] * second[0] - first[0] * second[2],
        first[0] * second[1] - first[1] * second[0],
    ];
    let length = dot(normal, normal).sqrt();
    normal.map(|component| component / length)
}

fn sub(lhs: [f64; 3], rhs: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|axis| lhs[axis] - rhs[axis])
}

fn dot(lhs: [f64; 3], rhs: [f64; 3]) -> f64 {
    lhs.iter().zip(&rhs).map(|(left, right)| left * right).sum()
}

/// Meshes of about 1000, 500 and 250 mm along the equator.
const LEVELS: [[usize; 2]; 3] = [[16, 12], [32, 25], [64, 51]];

fn percent_off(ux: f64) -> f64 {
    100.0 * (ux - REFERENCE_UX) / REFERENCE_UX
}

#[test]
fn without_the_drilling_spring_le3_converges_within_two_percent() {
    let readings: Vec<f64> = LEVELS
        .iter()
        .map(|&cells| {
            let quarter = Quarter::new(cells);
            quarter.ux_at_a(&quarter.stiffness_without_drilling())
        })
        .collect();
    for (cells, ux) in LEVELS.iter().zip(&readings) {
        assert!(
            percent_off(*ux).abs() < 2.0,
            "{cells:?}: Ux at A = {ux:.2} mm, {:+.2} % off 185 mm",
            percent_off(*ux)
        );
    }
    let spread = readings.iter().copied().fold(f64::MIN, f64::max)
        - readings.iter().copied().fold(f64::MAX, f64::min);
    assert!(
        spread < 0.01 * REFERENCE_UX,
        "readings {readings:.2?} should settle, not drift"
    );
}

#[test]
fn the_drilling_spring_alone_pulls_le3_down_as_the_mesh_is_refined() {
    let gaps: Vec<f64> = LEVELS
        .iter()
        .map(|&cells| {
            let quarter = Quarter::new(cells);
            let with = quarter.ux_at_a(&assemble_shell_stiffness(&quarter.mesh));
            let without = quarter.ux_at_a(&quarter.stiffness_without_drilling());
            100.0 * (without - with) / without
        })
        .collect();
    assert!(
        gaps.windows(2).all(|pair| pair[1] > pair[0]),
        "the spring's share {gaps:.2?} % should grow with refinement"
    );
    assert!(
        gaps[2] > 2.0,
        "on a 250 mm mesh the spring should cost over 2 %, got {gaps:.2?} %"
    );
}

#[test]
#[ignore = "KOF-453: fails until the drilling spring stops locking curved shells; \
            the fix moves the stored C++ shell references, which awaits the maintainer"]
fn le3_converges_within_two_percent() {
    // The 125 mm mesh is where the app's own case falls out of the band.
    for cells in [[64, 51], [128, 102]] {
        let quarter = Quarter::new(cells);
        let ux = quarter.ux_at_a(&assemble_shell_stiffness(&quarter.mesh));
        assert!(
            percent_off(ux).abs() < 2.0,
            "{cells:?}: Ux at A = {ux:.2} mm, {:+.2} % off 185 mm",
            percent_off(ux)
        );
    }
}

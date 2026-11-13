// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The topology-optimization benchmarks of the C++ engine's validation suites
//! (`engine/tests/topology_*_validation.cpp`), as Rust fixtures: a clamped
//! cantilever, the MBB half-beam and the L-bracket, each a slab of Kuhn tets.

#![allow(
    dead_code,
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures shared by several test files, each using a subset; small \
              structured meshes whose indices fit any integer type, and a fixture that \
              fails to build should abort the test"
)]

use kofem_fem::topology::{SimpModel, SimpPreconditioner, SimpSolver};
use kofem_fem::{Isotropic, TetMesh};

/// Kuhn split of a cube (corner c = bit0·x + bit1·y + bit2·z) along 0 → 7.
const KUHN: [[usize; 4]; 6] = [
    [0, 1, 3, 7],
    [0, 3, 2, 7],
    [0, 2, 6, 7],
    [0, 6, 4, 7],
    [0, 4, 5, 7],
    [0, 5, 1, 7],
];

pub const TOL: f64 = 1e-9;

pub fn unit_material() -> Isotropic {
    Isotropic::new(0, 1.0, 0.3).expect("valid material")
}

/// A slab of `cells` cubes over `size`, keeping the cells `keep(ix, iy, iz)`
/// accepts, with unused vertices dropped. Returns the mesh and its vertices.
pub fn slab(
    cells: [usize; 3],
    size: [f64; 3],
    keep: impl Fn(usize, usize, usize) -> bool,
) -> (TetMesh, Vec<[f64; 3]>) {
    let [nx, ny, nz] = cells;
    let grid_index = |ix: usize, iy: usize, iz: usize| ix + (nx + 1) * (iy + (ny + 1) * iz);
    let mut grid_tets = Vec::new();
    for iz in 0..nz {
        for iy in 0..ny {
            for ix in 0..nx {
                if !keep(ix, iy, iz) {
                    continue;
                }
                let corner = |bits: usize| {
                    grid_index(
                        ix + (bits & 1),
                        iy + ((bits >> 1) & 1),
                        iz + ((bits >> 2) & 1),
                    )
                };
                for tet in KUHN {
                    grid_tets.push(tet.map(corner));
                }
            }
        }
    }
    let mut renumber = vec![u32::MAX; (nx + 1) * (ny + 1) * (nz + 1)];
    let mut vertices = Vec::new();
    let mut tets = Vec::new();
    for tet in &grid_tets {
        for &grid_vertex in tet {
            if renumber[grid_vertex] == u32::MAX {
                renumber[grid_vertex] = vertices.len() as u32;
                let ix = grid_vertex % (nx + 1);
                let iy = (grid_vertex / (nx + 1)) % (ny + 1);
                let iz = grid_vertex / ((nx + 1) * (ny + 1));
                vertices.push([
                    size[0] * ix as f64 / nx as f64,
                    size[1] * iy as f64 / ny as f64,
                    size[2] * iz as f64 / nz as f64,
                ]);
            }
            tets.push(renumber[grid_vertex]);
        }
    }
    let flat: Vec<f64> = vertices.iter().flatten().copied().collect();
    let materials = vec![0; tets.len() / 4];
    let mesh = TetMesh::new(&flat, &tets, &materials, vec![unit_material()]).expect("valid slab");
    (mesh, vertices)
}

/// Tight Gauss–Seidel CG, for finite-difference checks.
pub fn tight_solver() -> SimpSolver {
    SimpSolver {
        preconditioner: SimpPreconditioner::GaussSeidel,
        relative_tolerance: 1e-12,
    }
}

/// A problem: the mesh, its vertices, the supported DOFs and the load.
pub struct Problem {
    pub mesh: TetMesh,
    pub vertices: Vec<[f64; 3]>,
    pub fixed: Vec<u32>,
    pub forces: Vec<f64>,
}

impl Problem {
    pub fn model(&self, solver: SimpSolver) -> SimpModel {
        SimpModel::new(self.mesh.clone(), &self.fixed, self.forces.clone(), solver)
            .expect("valid SIMP model")
    }

    /// Element indices whose centroid lies in the box [lo, hi].
    pub fn elements_in_box(&self, lo: [f64; 3], hi: [f64; 3]) -> Vec<usize> {
        (0..self.mesh.element_count())
            .filter(|&element| {
                let nodes = self.mesh.element_nodes(element);
                let centroid: [f64; 3] = std::array::from_fn(|axis| {
                    nodes
                        .iter()
                        .map(|&node| self.vertices[node as usize][axis])
                        .sum::<f64>()
                        / nodes.len() as f64
                });
                (0..3).all(|axis| centroid[axis] >= lo[axis] && centroid[axis] <= hi[axis])
            })
            .collect()
    }
}

fn dof(vertex: usize, component: usize) -> u32 {
    (3 * vertex + component) as u32
}

/// Spread a total downward (−y) force of 1 over `vertices`.
fn load_down(vertex_count: usize, vertices: &[usize]) -> Vec<f64> {
    let mut forces = vec![0.0; 3 * vertex_count];
    for &vertex in vertices {
        forces[3 * vertex + 1] -= 1.0 / vertices.len() as f64;
    }
    forces
}

/// A 6×1×1 cantilever of 6×2×2 cubes, clamped at x = 0, with a downward unit
/// load spread over the x = 6 face (`topology_simp_validation.cpp`).
pub fn cantilever() -> Problem {
    let (mesh, vertices) = slab([6, 2, 2], [6.0, 1.0, 1.0], |_, _, _| true);
    let mut fixed = Vec::new();
    let mut tip = Vec::new();
    for (vertex, point) in vertices.iter().enumerate() {
        if point[0] < TOL {
            fixed.extend((0..3).map(|component| dof(vertex, component)));
        }
        if point[0] > 6.0 - TOL {
            tip.push(vertex);
        }
    }
    let forces = load_down(vertices.len(), &tip);
    Problem {
        mesh,
        vertices,
        fixed,
        forces,
    }
}

/// The MBB half-beam: a 6×2×⅓ slab of 18×6×1 cubes, out-of-plane motion
/// suppressed (2D in 3D), the x = 0 symmetry face on rollers, the bottom
/// right edge on a roller, and a downward unit load on the top of the
/// symmetry edge (`topology_optimize_validation.cpp`).
pub fn mbb() -> Problem {
    let (lx, ly) = (6.0, 2.0);
    let (mesh, vertices) = slab([18, 6, 1], [lx, ly, 1.0 / 3.0], |_, _, _| true);
    let mut fixed = Vec::new();
    let mut loaded = Vec::new();
    for (vertex, point) in vertices.iter().enumerate() {
        fixed.push(dof(vertex, 2));
        if point[0] < TOL {
            fixed.push(dof(vertex, 0));
        }
        if point[0] > lx - TOL && point[1] < TOL {
            fixed.push(dof(vertex, 1));
        }
        if point[0] < TOL && point[1] > ly - TOL {
            loaded.push(vertex);
        }
    }
    let forces = load_down(vertices.len(), &loaded);
    Problem {
        mesh,
        vertices,
        fixed,
        forces,
    }
}

/// The L-bracket of Le et al. (2010): a unit square of n×n cells, one cell
/// thick, without its upper right 0.6×0.6 block; 2D in 3D, clamped along
/// the top edge, loaded downward on the upper half of the arm's end
/// (`topology_stress_validation.cpp`).
pub fn l_bracket(cells: usize) -> Problem {
    let cut = 0.4;
    let cell = 1.0 / cells as f64;
    let (mesh, vertices) = slab([cells, cells, 1], [1.0, 1.0, cell], |ix, iy, _| {
        (ix as f64 + 0.5) * cell <= cut || (iy as f64 + 0.5) * cell <= cut
    });
    let mut fixed = Vec::new();
    let mut loaded = Vec::new();
    for (vertex, point) in vertices.iter().enumerate() {
        fixed.push(dof(vertex, 2));
        if point[1] > 1.0 - TOL {
            fixed.push(dof(vertex, 0));
            fixed.push(dof(vertex, 1));
        }
        if point[0] > 1.0 - TOL && point[1] > 0.2 - TOL {
            loaded.push(vertex);
        }
    }
    let forces = load_down(vertices.len(), &loaded);
    Problem {
        mesh,
        vertices,
        fixed,
        forces,
    }
}

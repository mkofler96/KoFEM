// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Structured test meshes: a box of cubes, each split into six tetrahedra
//! (Kuhn), which tiles conformingly.

use kofem_fem::{Isotropic, TetMesh};

pub const KUHN: [[usize; 4]; 6] = [
    [0, 1, 3, 7],
    [0, 3, 2, 7],
    [0, 2, 6, 7],
    [0, 6, 4, 7],
    [0, 4, 5, 7],
    [0, 5, 1, 7],
];

pub struct BoxMesh {
    pub mesh: TetMesh,
    pub vertices: Vec<[f64; 3]>,
    pub size: [f64; 3],
}

/// `cells` cubes along each axis over a box of the given size.
pub fn box_mesh(cells: [usize; 3], size: [f64; 3], material: Isotropic) -> BoxMesh {
    let [nx, ny, nz] = cells;
    let index = |ix: usize, iy: usize, iz: usize| ix + (nx + 1) * (iy + (ny + 1) * iz);
    let mut vertices = Vec::new();
    for iz in 0..=nz {
        for iy in 0..=ny {
            for ix in 0..=nx {
                vertices.push([
                    size[0] * ix as f64 / nx as f64,
                    size[1] * iy as f64 / ny as f64,
                    size[2] * iz as f64 / nz as f64,
                ]);
            }
        }
    }
    let mut tets = Vec::new();
    for iz in 0..nz {
        for iy in 0..ny {
            for ix in 0..nx {
                // Cube corner c = bit0·x + bit1·y + bit2·z.
                let corner = |bits: usize| {
                    index(
                        ix + (bits & 1),
                        iy + ((bits >> 1) & 1),
                        iz + ((bits >> 2) & 1),
                    ) as u32
                };
                for tet in KUHN {
                    tets.extend(tet.map(corner));
                }
            }
        }
    }
    let flat: Vec<f64> = vertices.iter().flatten().copied().collect();
    let materials_of_tet = vec![0; tets.len() / 4];
    let mesh = TetMesh::new(&flat, &tets, &materials_of_tet, vec![material]).expect("valid box");
    BoxMesh {
        mesh,
        vertices,
        size,
    }
}

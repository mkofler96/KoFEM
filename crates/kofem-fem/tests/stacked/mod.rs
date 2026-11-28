// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Two blocks over the unit square, one above the other, meshed on their own
//! so their facing surfaces do not match: the fixture of the offset
//! constraint rows and of contact.

use kofem_fem::{Isotropic, MortarFace, TetMesh};

pub const POISSON: f64 = 0.3;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Shape {
    Tet,
    Hex,
}

#[derive(Clone, Copy, Debug)]
pub struct Block {
    pub cells: [usize; 3],
    pub height: f64,
    pub shape: Shape,
    pub young: f64,
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

/// CHEXA faces, each wound outwards.
const HEX_FACES: [[usize; 4]; 6] = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
];

pub struct Stacked {
    pub mesh: TetMesh,
    pub vertices: Vec<[f64; 3]>,
    /// The first vertex of the upper block.
    pub first_upper: usize,
    /// Height of the lower block's top.
    pub lower_height: f64,
    pub upper: Block,
    pub lower: Block,
    /// The lower block's top faces and the upper block's bottom faces.
    pub lower_top: Vec<MortarFace>,
    pub upper_bottom: Vec<MortarFace>,
    /// The upper block's top faces.
    pub upper_top: Vec<MortarFace>,
}

/// Blocks over the unit square, one above the other, each meshed on its own.
pub struct Tower {
    pub mesh: TetMesh,
    pub vertices: Vec<[f64; 3]>,
    tets: Vec<u32>,
    hexes: Vec<u32>,
    /// The first vertex of each block, then the vertex count.
    firsts: Vec<usize>,
    /// The height of each block's bottom.
    pub bases: Vec<f64>,
}

/// Each of `blocks` (material = its index) `gap` above the one below it,
/// the first from z = 0.
pub fn tower(blocks: &[(Block, f64)]) -> Tower {
    let mut vertices: Vec<[f64; 3]> = Vec::new();
    let mut tets: Vec<u32> = Vec::new();
    let mut hexes: Vec<u32> = Vec::new();
    let mut tet_material = Vec::new();
    let mut hex_material = Vec::new();
    let mut firsts = Vec::new();
    let mut bases = Vec::new();
    let mut base = 0.0;
    for (material, &(block, gap)) in blocks.iter().enumerate() {
        base += gap;
        bases.push(base);
        let first = vertices.len();
        firsts.push(first);
        let [nx, ny, nz] = block.cells;
        let index =
            |ix: usize, iy: usize, iz: usize| (first + ix + (nx + 1) * (iy + (ny + 1) * iz)) as u32;
        for iz in 0..=nz {
            for iy in 0..=ny {
                for ix in 0..=nx {
                    vertices.push([
                        ix as f64 / nx as f64,
                        iy as f64 / ny as f64,
                        base + block.height * iz as f64 / nz as f64,
                    ]);
                }
            }
        }
        for iz in 0..nz {
            for iy in 0..ny {
                for ix in 0..nx {
                    let corner = |bits: usize| {
                        index(
                            ix + (bits & 1),
                            iy + ((bits >> 1) & 1),
                            iz + ((bits >> 2) & 1),
                        )
                    };
                    match block.shape {
                        Shape::Hex => {
                            hexes.extend(HEX_CORNERS.map(corner));
                            hex_material.push(material as u32);
                        }
                        Shape::Tet => {
                            for tet in KUHN {
                                tets.extend(tet.map(corner));
                                tet_material.push(material as u32);
                            }
                        }
                    }
                }
            }
        }
        base += block.height;
    }
    firsts.push(vertices.len());
    let flat: Vec<f64> = vertices.iter().flatten().copied().collect();
    let mut materials = tet_material;
    materials.extend(hex_material);
    let mesh = TetMesh::with_hexahedra(
        &flat,
        &tets,
        &hexes,
        &materials,
        blocks
            .iter()
            .enumerate()
            .map(|(index, (block, _))| {
                Isotropic::new(index, block.young, POISSON).expect("valid material")
            })
            .collect(),
    )
    .expect("valid blocks");
    Tower {
        mesh,
        vertices,
        tets,
        hexes,
        firsts,
        bases,
    }
}

impl Tower {
    /// The faces of block `block` on the plane z = `height`.
    pub fn faces(&self, block: usize, height: f64) -> Vec<MortarFace> {
        let nodes = self.firsts[block]..self.firsts[block + 1];
        element_faces_on(&self.vertices, &self.tets, &self.hexes, height)
            .into_iter()
            .filter(|face| face.nodes.iter().all(|node| nodes.contains(node)))
            .collect()
    }

    /// The vertices of block `block`.
    pub fn block_vertices(&self, block: usize) -> std::ops::Range<usize> {
        self.firsts[block]..self.firsts[block + 1]
    }
}

/// `lower` on z ∈ [0, `lower.height`], `upper` from `gap` above it, both
/// over [0, 1]².
pub fn stacked(lower: Block, upper: Block, gap: f64) -> Stacked {
    let tower = tower(&[(lower, 0.0), (upper, gap)]);
    let base = tower.bases[1];
    Stacked {
        lower_top: tower.faces(0, lower.height),
        upper_bottom: tower.faces(1, base),
        upper_top: tower.faces(1, base + upper.height),
        first_upper: tower.block_vertices(1).start,
        mesh: tower.mesh,
        vertices: tower.vertices,
        lower_height: lower.height,
        upper,
        lower,
    }
}

/// The element faces whose corners all lie on the plane z = `height`.
fn element_faces_on(
    vertices: &[[f64; 3]],
    tets: &[u32],
    hexes: &[u32],
    height: f64,
) -> Vec<MortarFace> {
    let on = |vertex: u32| (vertices[vertex as usize][2] - height).abs() < 1e-12;
    let centroid = |element: &[u32]| {
        let mut sum = [0.0; 3];
        for &vertex in element {
            for axis in 0..3 {
                sum[axis] += vertices[vertex as usize][axis] / element.len() as f64;
            }
        }
        sum
    };
    let face = |ids: Vec<u32>, element: &[u32]| MortarFace {
        points: ids.iter().map(|&id| vertices[id as usize]).collect(),
        nodes: ids.iter().map(|&id| id as usize).collect(),
        element_centroid: centroid(element),
    };
    let mut faces = Vec::new();
    for tet in tets.chunks(4) {
        for skip in 0..4 {
            let ids: Vec<u32> = (0..4).filter(|&k| k != skip).map(|k| tet[k]).collect();
            if ids.iter().all(|&vertex| on(vertex)) {
                faces.push(face(ids, tet));
            }
        }
    }
    for hex in hexes.chunks(8) {
        for local in HEX_FACES {
            let ids: Vec<u32> = local.iter().map(|&k| hex[k]).collect();
            if ids.iter().all(|&vertex| on(vertex)) {
                faces.push(face(ids, hex));
            }
        }
    }
    faces
}

impl Stacked {
    /// [`symmetry_supports`] of the two blocks.
    pub fn symmetry_supports(&self) -> (Vec<u32>, Vec<f64>) {
        symmetry_supports(&self.vertices)
    }

    /// [`traction_on`] the upper block's top.
    pub fn top_traction(&self, traction: impl Fn(f64, f64) -> f64) -> Vec<f64> {
        traction_on(&self.upper_top, self.vertices.len(), traction)
    }
}

/// Symmetry supports: x held on x = 0 and y on y = 0, z on the bottom
/// z = 0. As (3·node + component, value).
pub fn symmetry_supports(vertices: &[[f64; 3]]) -> (Vec<u32>, Vec<f64>) {
    let mut dofs = Vec::new();
    for (node, point) in vertices.iter().enumerate() {
        let dof = 3 * node as u32;
        if point[0] == 0.0 {
            dofs.push(dof);
        }
        if point[1] == 0.0 {
            dofs.push(dof + 1);
        }
        if point[2] == 0.0 {
            dofs.push(dof + 2);
        }
    }
    let values = vec![0.0; dofs.len()];
    (dofs, values)
}

/// Nodal forces (3 per node over `vertex_count` nodes) of a traction
/// `traction(x, y)` along z on `faces`, lumped as each corner's share of its
/// face's area — exact for a uniform traction on linear faces.
pub fn traction_on(
    faces: &[MortarFace],
    vertex_count: usize,
    traction: impl Fn(f64, f64) -> f64,
) -> Vec<f64> {
    let mut forces = vec![0.0; 3 * vertex_count];
    for face in faces {
        let area = polygon_area(&face.points);
        let share = area / face.nodes.len() as f64;
        for (&node, point) in face.nodes.iter().zip(&face.points) {
            forces[3 * node + 2] += share * traction(point[0], point[1]);
        }
    }
    forces
}

fn polygon_area(points: &[[f64; 3]]) -> f64 {
    let mut twice = 0.0;
    for (index, point) in points.iter().enumerate() {
        let next = points[(index + 1) % points.len()];
        twice += point[0] * next[1] - next[0] * point[1];
    }
    twice.abs() / 2.0
}

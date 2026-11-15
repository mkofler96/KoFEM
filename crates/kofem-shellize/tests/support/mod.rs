// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Structured test meshes: axis-aligned boxes on one shared grid, so boxes
//! that touch share their interface nodes (a conforming multi-body mesh).

use std::collections::HashMap;

use kofem_shellize::geometry::{cross, dot, sub, triangle_extent};
use kofem_shellize::ShellizeMesh;

/// Six tets per grid cell (Kuhn), corners numbered x + 2y + 4z.
const KUHN: [[usize; 4]; 6] = [
    [0, 1, 3, 7],
    [0, 3, 2, 7],
    [0, 2, 6, 7],
    [0, 6, 4, 7],
    [0, 4, 5, 7],
    [0, 5, 1, 7],
];

/// One box: its corners, cell counts, body id and the first of its six CAD
/// face ids (`face_base + 2·axis + side`, side 1 at the max).
pub struct BoxSpec {
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub cells: [usize; 3],
    pub body: i32,
    pub face_base: i32,
}

#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    reason = "test fixtures: small grids whose indices fit any integer type"
)]
pub fn boxes_labelled(specs: &[BoxSpec], label: impl Fn([[f64; 3]; 3]) -> i32) -> ShellizeMesh {
    let mut vertices: Vec<f64> = Vec::new();
    let mut index: HashMap<[i64; 3], u32> = HashMap::new();
    let mut vertex = |point: [f64; 3]| -> u32 {
        // Grid points are exact multiples of 1e-6 mm here.
        let key = point.map(|value| (value * 1e6).round() as i64);
        *index.entry(key).or_insert_with(|| {
            vertices.extend_from_slice(&point);
            (vertices.len() / 3 - 1) as u32
        })
    };
    let mut tets: Vec<u32> = Vec::new();
    let mut body: Vec<i32> = Vec::new();
    for spec in specs {
        let step =
            [0, 1, 2].map(|axis| (spec.max[axis] - spec.min[axis]) / spec.cells[axis] as f64);
        for k in 0..spec.cells[2] {
            for j in 0..spec.cells[1] {
                for i in 0..spec.cells[0] {
                    let corner: Vec<u32> = (0..8)
                        .map(|bits| {
                            let offset = [bits & 1, (bits >> 1) & 1, (bits >> 2) & 1];
                            let cell = [i, j, k];
                            vertex([0, 1, 2].map(|axis| {
                                spec.min[axis] + step[axis] * (cell[axis] + offset[axis]) as f64
                            }))
                        })
                        .collect();
                    for tet in KUHN {
                        tets.extend(tet.map(|local| corner[local]));
                        body.push(spec.body);
                    }
                }
            }
        }
    }
    let points: Vec<[f64; 3]> = vertices
        .chunks(3)
        .map(|xyz| [xyz[0], xyz[1], xyz[2]])
        .collect();
    let groups: Vec<[usize; 4]> = tets
        .chunks(4)
        .map(|tet| [tet[0], tet[1], tet[2], tet[3]].map(|vertex| vertex as usize))
        .collect();
    // Exterior triangles, wound outward (away from their tet's fourth node) as
    // Netgen's surface mesh is, each labelled with a CAD face id.
    let mut seen: HashMap<[usize; 3], ([usize; 3], usize, usize)> = HashMap::new();
    let mut order: Vec<[usize; 3]> = Vec::new();
    for tet in &groups {
        for (opposite, face) in [
            (3, [0, 1, 2]),
            (2, [0, 1, 3]),
            (1, [0, 2, 3]),
            (0, [1, 2, 3]),
        ] {
            let tri = face.map(|corner| tet[corner]);
            let mut key = tri;
            key.sort_unstable();
            seen.entry(key)
                .and_modify(|entry| entry.1 += 1)
                .or_insert_with(|| {
                    order.push(key);
                    (tri, 1, tet[opposite])
                });
        }
    }
    let mut surf_tris: Vec<u32> = Vec::new();
    let mut surf_face: Vec<i32> = Vec::new();
    for key in order {
        let (tri, count, opposite) = seen[&key];
        if count != 1 {
            continue;
        }
        let corners = tri.map(|vertex| points[vertex]);
        let normal = cross(sub(corners[1], corners[0]), sub(corners[2], corners[0]));
        let inward = sub(points[opposite], corners[0]);
        let tri = if dot(normal, inward) > 0.0 {
            [tri[0], tri[2], tri[1]]
        } else {
            tri
        };
        assert!(triangle_extent(corners) > 0.0);
        surf_tris.extend(tri.map(|vertex| vertex as u32));
        surf_face.push(label(corners));
    }
    ShellizeMesh::new(&vertices, &tets, &body, &surf_tris, &surf_face).expect("valid fixture mesh")
}

/// Boxes whose exterior triangles carry the id of the box side they lie on
/// (`face_base + 2·axis + side`, side 1 at the max).
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    reason = "an axis index below 3"
)]
pub fn boxes(specs: &[BoxSpec]) -> ShellizeMesh {
    boxes_labelled(specs, |corners| {
        specs
            .iter()
            .find_map(|spec| {
                (0..3).find_map(|axis| {
                    (0..2).find_map(|side| {
                        let plane = if side == 0 {
                            spec.min[axis]
                        } else {
                            spec.max[axis]
                        };
                        let inside = |point: [f64; 3]| {
                            (point[axis] - plane).abs() < 1e-9
                                && (0..3).all(|other| {
                                    other == axis
                                        || (point[other] >= spec.min[other] - 1e-9
                                            && point[other] <= spec.max[other] + 1e-9)
                                })
                        };
                        corners
                            .iter()
                            .all(|&point| inside(point))
                            .then_some(spec.face_base + 2 * axis as i32 + side)
                    })
                })
            })
            .expect("every exterior triangle lies on a box side")
    })
}

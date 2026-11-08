// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Thin-wall detection: aggregate the surface mesh per CAD face, then pair up
//! opposite planar faces of the same body that are close enough to be a wall.

use std::collections::{HashMap, HashSet};

use crate::geometry::{
    cross, dot, norm, scale, sub, tet_face, triangle_key, OrderedMap, ShellizeMesh, Vec3, TET_FACES,
};

/// One CAD face, measured on the surface mesh.
#[derive(Debug, Clone, PartialEq)]
pub struct FaceProp {
    pub id: i32,
    pub area: f64,
    /// Owning body, `None` when no tet face carries the face's first triangle
    /// (such a face takes no part in wall detection and never reaches a solver).
    pub body: Option<i32>,
    /// |Σ n·A| / Σ A — 1 for a planar face.
    pub flat: f64,
    pub normal: Vec3,
    pub centroid: Vec3,
}

/// A detected thin wall: the CAD face kept as its mid-surface source (the outer
/// face of the pair), that face's unit normal, the wall thickness and the body.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Wall {
    pub keep: i32,
    pub normal: Vec3,
    pub thickness: f64,
    pub body: i32,
}

struct FaceSum {
    area: f64,
    normal: Vec3,
    weighted_centroid: Vec3,
    body: Option<i32>,
}

/// Per-CAD-face area, area-weighted normal and centroid, and owning body;
/// sorted by area, largest first (stable, so equal areas keep first-seen order).
#[must_use]
pub fn face_props(mesh: &ShellizeMesh) -> Vec<FaceProp> {
    let mut face_body: HashMap<[usize; 3], i32> = HashMap::new();
    for (element, &tet) in mesh.tets.iter().enumerate() {
        for face in TET_FACES {
            face_body.insert(tet_face(tet, face).1, mesh.body[element]);
        }
    }
    let mut sums: OrderedMap<i32, FaceSum> = OrderedMap::new();
    for (triangle, &tri) in mesh.surf_tris.iter().enumerate() {
        let [pos_a, pos_b, pos_c] = tri.map(|vertex| mesh.vertices[vertex]);
        let raw = cross(sub(pos_b, pos_a), sub(pos_c, pos_a));
        let area = 0.5 * norm(raw);
        let entry = sums.get_or_insert_with(mesh.surf_face[triangle], || FaceSum {
            area: 0.0,
            normal: [0.0; 3],
            weighted_centroid: [0.0; 3],
            body: face_body.get(&triangle_key(tri)).copied(),
        });
        entry.area += area;
        for axis in 0..3 {
            entry.normal[axis] += raw[axis] / 2.0;
            entry.weighted_centroid[axis] += (pos_a[axis] + pos_b[axis] + pos_c[axis]) / 3.0 * area;
        }
    }
    let mut faces: Vec<FaceProp> = sums
        .iter()
        .map(|(&id, sum)| {
            let length = norm(sum.normal);
            // A degenerate (zero-area) face has no defined normal; dividing by 1
            // leaves its normal zero, and its NaN flatness keeps it out of
            // wall detection.
            let divisor = if length == 0.0 { 1.0 } else { length };
            FaceProp {
                id,
                area: sum.area,
                body: sum.body,
                flat: divisor / sum.area,
                normal: scale(sum.normal, 1.0 / divisor),
                centroid: scale(sum.weighted_centroid, 1.0 / sum.area),
            }
        })
        .collect();
    faces.sort_by(|left, right| right.area.total_cmp(&left.area));
    faces
}

/// Pair up opposite planar faces of the same body into thin walls, keeping the
/// OUTER face of each pair (its normal points away from the other face):
/// adjacent walls' outer faces meet at convex CAD edges and share Netgen's edge
/// nodes, which the junction weld relies on.
#[must_use]
pub fn detect_wall_pairs(faces: &[FaceProp], max_wall: f64) -> Vec<Wall> {
    let Some(largest) = faces.first() else {
        return Vec::new();
    };
    let big: Vec<&FaceProp> = faces
        .iter()
        .filter(|face| face.area > 0.01 * largest.area && face.flat > 0.9)
        // A face no tet carries belongs to no body, so it can be no body's wall.
        .filter(|face| face.body.is_some())
        .collect();
    let mut used: HashSet<i32> = HashSet::new();
    let mut walls = Vec::new();
    for (i, first) in big.iter().enumerate() {
        if used.contains(&first.id) {
            continue;
        }
        let mut best: Option<usize> = None;
        let mut best_along = f64::INFINITY;
        for (j, second) in big.iter().enumerate() {
            if i == j || used.contains(&second.id) || first.body != second.body {
                continue;
            }
            if dot(first.normal, second.normal) > -0.85 {
                continue;
            }
            let offset = sub(second.centroid, first.centroid);
            // Wall thickness is the centroid offset ALONG the face normal. The
            // euclidean centroid distance also picks up any lateral shift, and
            // since bending stiffness scales with t³ that inflation made the
            // shell several-fold too stiff. A large lateral shift relative to
            // the face extent means the faces don't overlap — not a wall.
            let along = dot(first.normal, offset).abs();
            let lateral = (dot(offset, offset) - along * along).max(0.0).sqrt();
            let extent = first.area.min(second.area).sqrt();
            let area_ratio = (first.area - second.area).abs() / first.area.max(second.area);
            if area_ratio > 0.4 || along < 0.05 || along > max_wall || lateral > 0.35 * extent {
                continue;
            }
            if along < best_along {
                best_along = along;
                best = Some(j);
            }
        }
        let (Some(best), Some(body)) = (best, first.body) else {
            continue;
        };
        let second = big[best];
        used.insert(first.id);
        used.insert(second.id);
        let outer = if dot(first.normal, sub(first.centroid, second.centroid)) > 0.0 {
            first
        } else {
            second
        };
        walls.push(Wall {
            keep: outer.id,
            normal: outer.normal,
            thickness: best_along,
            body,
        });
    }
    walls
}

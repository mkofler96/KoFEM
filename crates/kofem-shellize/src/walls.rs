// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Thin-wall detection: aggregate the surface mesh per CAD face, then pair up
//! opposite planar faces of the same body that are close enough to be a wall.

use std::collections::{HashMap, HashSet};

use crate::geometry::{
    add, cross, dot, norm, scale, sub, tet_face, triangle_key, OrderedMap, ShellizeMesh, Vec3,
    TET_FACES,
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
    /// Axis-aligned bounding box of the face's triangles.
    pub min: Vec3,
    pub max: Vec3,
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

/// A wall with the opposite face(s) it was paired against: one for a plain
/// pair, several for a wall whose inner side is split (an I-beam flange, cut in
/// two by the web).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PairedWall {
    pub wall: Wall,
    pub partners: Vec<i32>,
}

struct FaceSum {
    area: f64,
    normal: Vec3,
    weighted_centroid: Vec3,
    body: Option<i32>,
    min: Vec3,
    max: Vec3,
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
            min: [f64::INFINITY; 3],
            max: [f64::NEG_INFINITY; 3],
        });
        entry.area += area;
        for point in [pos_a, pos_b, pos_c] {
            entry.min = [0, 1, 2].map(|axis| entry.min[axis].min(point[axis]));
            entry.max = [0, 1, 2].map(|axis| entry.max[axis].max(point[axis]));
        }
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
                min: sum.min,
                max: sum.max,
            }
        })
        .collect();
    faces.sort_by(|left, right| right.area.total_cmp(&left.area));
    faces
}

/// CAD faces that share a surface-mesh node (a CAD edge or vertex), per face.
fn face_adjacency(mesh: &ShellizeMesh) -> HashMap<i32, HashSet<i32>> {
    let mut faces_of_node: HashMap<usize, HashSet<i32>> = HashMap::new();
    for (triangle, tri) in mesh.surf_tris.iter().enumerate() {
        for &vertex in tri {
            faces_of_node
                .entry(vertex)
                .or_default()
                .insert(mesh.surf_face[triangle]);
        }
    }
    let mut adjacency: HashMap<i32, HashSet<i32>> = HashMap::new();
    for faces in faces_of_node.values() {
        for &face in faces {
            adjacency
                .entry(face)
                .or_default()
                .extend(faces.iter().copied().filter(|&other| other != face));
        }
    }
    adjacency
}

/// Relative slack on the thickest wall: a wall exactly `max_wall` thick is a
/// wall, even when its measured gap rounds a few ulps above it.
const MAX_WALL_SLACK: f64 = 1e-6;

/// Pair up opposite planar faces of the same body into thin walls, keeping the
/// OUTER face of each pair (its normal points away from the other face):
/// adjacent walls' outer faces meet at convex CAD edges and share Netgen's edge
/// nodes, which the junction weld relies on.
///
/// A second pass pairs a face left over by the first against SEVERAL coplanar
/// opposite faces — the inner side of a wall split by a wall standing on it
/// (an I-beam flange, cut in two by the web). See [`split_wall`].
#[must_use]
pub fn detect_wall_pairs(mesh: &ShellizeMesh, faces: &[FaceProp], max_wall: f64) -> Vec<Wall> {
    detect_walls(mesh, faces, max_wall)
        .into_iter()
        .map(|paired| paired.wall)
        .collect()
}

/// [`detect_wall_pairs`] with the partner faces of every wall.
pub(crate) fn detect_walls(
    mesh: &ShellizeMesh,
    faces: &[FaceProp],
    max_wall: f64,
) -> Vec<PairedWall> {
    let Some(largest) = faces.first() else {
        return Vec::new();
    };
    let max_wall = max_wall * (1.0 + MAX_WALL_SLACK);
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
        let (outer, inner) = if dot(first.normal, sub(first.centroid, second.centroid)) > 0.0 {
            (*first, second)
        } else {
            (second, *first)
        };
        walls.push(PairedWall {
            wall: Wall {
                keep: outer.id,
                normal: outer.normal,
                thickness: best_along,
                body,
            },
            partners: vec![inner.id],
        });
    }
    let mut adjacency: Option<HashMap<i32, HashSet<i32>>> = None;
    for first in &big {
        if used.contains(&first.id) {
            continue;
        }
        let adjacency = adjacency.get_or_insert_with(|| face_adjacency(mesh));
        let Some(paired) = split_wall(first, &big, &used, &walls, adjacency, max_wall) else {
            continue;
        };
        used.insert(first.id);
        used.extend(paired.partners.iter().copied());
        walls.push(paired);
    }
    walls
}

/// Pair `first` against a SET of opposite faces of its body: the inner side of
/// a wall that another wall stands on is split along the junction into several
/// coplanar faces, each too small to pair one-to-one (an I-beam flange's inner
/// side is two half-faces, each ~40 % of the outer face). The nearest layer of
/// opposite faces that lie over `first` is taken when it holds at least two
/// faces whose COMBINED area and centroid match `first` as a one-to-one pair's
/// would. `first` is kept as the mid-surface source.
///
/// The split must come from a wall of the same body standing on that side:
/// every face of the layer borders one wall found before, square to `first`
/// (the I-beam's half-faces both border the web). A face split by something
/// else — another body's contact footprint, say — is no split wall.
///
/// Only faces the one-to-one pass left over take part, so every pair it found
/// stays as it was.
fn split_wall(
    first: &FaceProp,
    big: &[&FaceProp],
    used: &HashSet<i32>,
    walls: &[PairedWall],
    adjacency: &HashMap<i32, HashSet<i32>>,
    max_wall: f64,
) -> Option<PairedWall> {
    let body = first.body?;
    let over_first = |point: Vec3| {
        (0..3).all(|axis| {
            point[axis] >= first.min[axis] - max_wall && point[axis] <= first.max[axis] + max_wall
        })
    };
    let mut layer: Vec<(f64, &FaceProp)> = big
        .iter()
        .filter(|second| {
            second.id != first.id
                && !used.contains(&second.id)
                && second.body == first.body
                && second.area < first.area
                && dot(first.normal, second.normal) <= -0.85
                && over_first(second.centroid)
        })
        .map(|second| {
            (
                dot(first.normal, sub(second.centroid, first.centroid)),
                *second,
            )
        })
        // The opposite faces lie behind `first` (inside its material).
        .filter(|&(signed, _)| -signed >= 0.05 && -signed <= max_wall)
        .map(|(signed, second)| (-signed, second))
        .collect();
    layer.sort_by(|left, right| left.0.total_cmp(&right.0));
    let nearest = layer.first()?.0;
    layer.retain(|&(along, _)| along - nearest <= 1e-3 * nearest);
    if layer.len() < 2 {
        return None;
    }
    let area: f64 = layer.iter().map(|(_, face)| face.area).sum();
    let mut centroid: Vec3 = [0.0; 3];
    let mut along = 0.0;
    for (distance, face) in &layer {
        along += distance * face.area / area;
        centroid = add(centroid, scale(face.centroid, face.area / area));
    }
    let offset = sub(centroid, first.centroid);
    let lateral = (dot(offset, offset) - along * along).max(0.0).sqrt();
    let area_ratio = (first.area - area).abs() / first.area.max(area);
    if area_ratio > 0.4 || lateral > 0.35 * first.area.min(area).sqrt() {
        return None;
    }
    // The walls standing on this side that cut the layer: square to `first`,
    // with layer faces on both sides of their mid-plane.
    let cutting: Vec<&PairedWall> = walls
        .iter()
        .filter(|standing| {
            let wall = &standing.wall;
            if wall.body != body || dot(wall.normal, first.normal).abs() >= 0.3 {
                return false;
            }
            let Some(kept) = big.iter().find(|face| face.id == wall.keep) else {
                return false;
            };
            let side = |face: &FaceProp| {
                dot(wall.normal, sub(face.centroid, kept.centroid)) + wall.thickness / 2.0
            };
            layer.iter().any(|(_, face)| side(face) > 0.0)
                && layer.iter().any(|(_, face)| side(face) < 0.0)
        })
        .collect();
    let borders = |face: &FaceProp, standing: &PairedWall| {
        adjacency.get(&face.id).is_some_and(|neighbours| {
            neighbours.contains(&standing.wall.keep)
                || standing
                    .partners
                    .iter()
                    .any(|partner| neighbours.contains(partner))
        })
    };
    let split_by_walls = layer
        .iter()
        .all(|(_, face)| cutting.iter().any(|standing| borders(face, standing)));
    if !split_by_walls {
        return None;
    }
    Some(PairedWall {
        wall: Wall {
            keep: first.id,
            normal: first.normal,
            thickness: along,
            body,
        },
        partners: layer.iter().map(|(_, face)| face.id).collect(),
    })
}

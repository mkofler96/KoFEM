// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Corner weld (KOF-452). Two planar walls meeting at an L-corner collapse to
//! mid-surfaces that must end on one line: where their mid-planes cross.
//!
//! Three things keep them from doing so by node identity alone:
//! - One wall kept on the inside of the corner and the other on the outside
//!   (always so at one corner of a Z-section): the kept faces share no CAD
//!   edge, each touches the other's inner face instead. Those edge nodes get
//!   the other wall's mid-plane as a constraint.
//! - Kept-face nodes inside the corner block, between the corner edge and the
//!   other wall's mid-plane, would end past that mid-plane. They are moved
//!   onto the corner line too, and the facets that collapse there are dropped.
//! - The two walls' nodes on the line come from different CAD edges or faces,
//!   meshed independently. Nodes that nearly coincide are welded; each other
//!   one splits the facet edge of the other wall it lies on.

use kofem_fem::extremum::{largest, smallest};
use std::collections::{BTreeSet, HashMap, HashSet};

use crate::geometry::{cross, dot, norm, scale, sub, OrderedMap, Vec3};
use crate::walls::{FaceProp, Wall};

/// Two walls `|n₁·n₂|` above this are (near) parallel: they never form a
/// corner (a plate split into two coplanar faces, say).
const PARALLEL: f64 = 0.9;

/// One L-corner between two planar walls (kept faces).
pub(crate) struct Corner {
    pub walls: [i32; 2],
    pub normals: [Vec3; 2],
    /// Each wall's mid-plane: a point on it and its thickness.
    mid: [(Vec3, f64); 2],
    /// Along the corner line, the span of its edge nodes.
    direction: Vec3,
    span: [f64; 2],
    /// Which side of the other wall's mid-plane each wall lies on (±1).
    side: [f64; 2],
    /// Edge nodes per wall that lie on the other wall's inner face (a corner
    /// kept on opposite sides).
    touching: [HashSet<usize>; 2],
    /// Original nodes per wall that land on the corner line.
    pub members: [Vec<usize>; 2],
}

impl Corner {
    /// Signed distance of `point` from wall `index`'s mid-plane, positive on
    /// its kept side.
    fn mid_plane_distance(&self, index: usize, point: Vec3) -> f64 {
        dot(self.normals[index], sub(point, self.mid[index].0))
    }

    /// Does a node of wall `index`, placed at `point` on its own mid-plane,
    /// reach the corner line? Yes for an edge node on the other wall's inner
    /// face; yes for a node at or beyond the other wall's mid-plane, within
    /// its half thickness and the corner's length.
    fn reaches(&self, index: usize, original: usize, point: Vec3) -> bool {
        if self.touching[index].contains(&original) {
            return true;
        }
        let other = 1 - index;
        let half = 0.5 * self.mid[other].1;
        let tolerance = 1e-6 * half;
        let along = dot(point, self.direction);
        let distance = self.mid_plane_distance(other, point);
        along >= self.span[0] - tolerance
            && along <= self.span[1] + tolerance
            && distance * self.side[index] <= tolerance
            && distance.abs() <= half + tolerance
    }
}

/// What the corner search reads about one wall node.
pub(crate) struct NodeWalls<'walls> {
    pub walls_of_node: &'walls OrderedMap<usize, BTreeSet<i32>>,
    pub inner_walls_of_node: &'walls HashMap<usize, BTreeSet<i32>>,
}

/// Two walls meeting at a corner, and the edge nodes they meet at.
struct CornerEdge {
    walls: (i32, i32),
    edge: Vec<usize>,
    /// Per wall, the edge nodes on the other wall's inner face.
    touching: [HashSet<usize>; 2],
}

/// Every L-corner between two planar walls: kept faces sharing edge nodes at
/// an angle, or each touching the other's inner face. A T-junction touches in
/// one direction only (the standing wall's kept face meets the base wall's
/// inner face, never the reverse), so it is no corner.
pub(crate) fn find_corners(
    vertices: &[Vec3],
    nodes: &NodeWalls<'_>,
    keep: &HashMap<i32, Wall>,
    face_of: &HashMap<i32, &FaceProp>,
) -> Vec<Corner> {
    let planar = |face: i32| keep.get(&face).is_some_and(|wall| !wall.curved);
    // (kept wall, other wall) → the edge nodes they share or touch at.
    let mut shared: OrderedMap<(i32, i32), Vec<usize>> = OrderedMap::new();
    let mut touching: OrderedMap<(i32, i32), Vec<usize>> = OrderedMap::new();
    for (&vertex, node_walls) in nodes.walls_of_node.iter() {
        let kept: Vec<i32> = node_walls
            .iter()
            .copied()
            .filter(|&face| planar(face))
            .collect();
        for (position, &first) in kept.iter().enumerate() {
            for &second in &kept[position + 1..] {
                shared
                    .get_or_insert_with((first, second), Vec::new)
                    .push(vertex);
            }
        }
        for &inner in nodes.inner_walls_of_node.get(&vertex).into_iter().flatten() {
            if node_walls.contains(&inner) {
                continue;
            }
            for &wall in &kept {
                touching
                    .get_or_insert_with((wall, inner), Vec::new)
                    .push(vertex);
            }
        }
    }
    let mut pairs: Vec<CornerEdge> = shared
        .iter()
        .map(|(&walls, edge)| CornerEdge {
            walls,
            edge: edge.clone(),
            touching: [HashSet::new(), HashSet::new()],
        })
        .collect();
    for (&(first, second), edge) in touching.iter() {
        if first > second {
            continue;
        }
        let Some(back) = touching.get(&(second, first)) else {
            continue;
        };
        pairs.push(CornerEdge {
            walls: (first, second),
            edge: edge.iter().chain(back).copied().collect(),
            touching: [
                edge.iter().copied().collect(),
                back.iter().copied().collect(),
            ],
        });
    }
    let mut corners = Vec::new();
    for CornerEdge {
        walls: (first, second),
        edge,
        touching,
    } in pairs
    {
        let (Some(first_wall), Some(second_wall)) = (keep.get(&first), keep.get(&second)) else {
            continue;
        };
        let (Some(first_face), Some(second_face)) = (face_of.get(&first), face_of.get(&second))
        else {
            continue;
        };
        let normals = [first_wall.normal, second_wall.normal];
        let direction = cross(normals[0], normals[1]);
        let length = norm(direction);
        if dot(normals[0], normals[1]).abs() > PARALLEL || length == 0.0 {
            continue;
        }
        let direction = scale(direction, 1.0 / length);
        let along = edge.iter().map(|&vertex| dot(vertices[vertex], direction));
        let span = [
            smallest(f64::INFINITY, along.clone()),
            largest(f64::NEG_INFINITY, along),
        ];
        // The mid-plane passes t/2 behind the kept face.
        let mid = [(first_wall, first_face), (second_wall, second_face)].map(|(wall, face)| {
            (
                sub(face.centroid, scale(wall.normal, 0.5 * wall.thickness)),
                wall.thickness,
            )
        });
        let mut corner = Corner {
            walls: [first, second],
            normals,
            mid,
            direction,
            span,
            side: [1.0, 1.0],
            touching,
            members: [Vec::new(), Vec::new()],
        };
        corner.side = [
            corner.mid_plane_distance(1, first_face.centroid).signum(),
            corner.mid_plane_distance(0, second_face.centroid).signum(),
        ];
        corners.push(corner);
    }
    corners
}

/// The other wall of each corner that a node of `wall` at `point` (on its own
/// mid-plane) reaches; recorded as a member of those corners.
pub(crate) fn corner_walls(
    corners: &mut [Corner],
    wall: i32,
    original: usize,
    point: Vec3,
) -> Vec<i32> {
    let mut reached = Vec::new();
    for corner in corners {
        let Some(index) = corner.walls.iter().position(|&face| face == wall) else {
            continue;
        };
        if corner.reaches(index, original, point) {
            corner.members[index].push(original);
            reached.push(corner.walls[1 - index]);
        }
    }
    reached
}

/// One corner line over raw shell nodes: per wall, the nodes on it.
pub(crate) struct CornerLine {
    pub walls: [i32; 2],
    pub normals: [Vec3; 2],
    pub nodes: [Vec<usize>; 2],
}

/// The weld of every corner line: node pairs to join, facets that collapsed
/// onto a line, and the facet edges (either direction) to split, with the
/// nodes on them in order from the edge's first node.
#[derive(Default)]
pub(crate) struct CornerWeld {
    pub merged: Vec<(usize, usize)>,
    pub dropped: HashSet<usize>,
    pub splits: HashMap<(usize, usize), Vec<usize>>,
}

/// A node on a corner line: where along it, which wall, which node.
#[derive(Clone, Copy)]
struct OnLine {
    along: f64,
    wall: usize,
    node: usize,
}

/// Weld every corner line. `vertices` are moved: each welded node, and every
/// copy of its original node (`copies`), lands on the first node of its group.
pub(crate) fn weld_corners(
    vertices: &mut [Vec3],
    copies: &dyn Fn(usize) -> Vec<usize>,
    triangles: &[[usize; 3]],
    triangle_wall: &[i32],
    lines: &[CornerLine],
) -> CornerWeld {
    let mut weld = CornerWeld::default();
    for line in lines {
        let on_line: [HashSet<usize>; 2] =
            [0, 1].map(|wall| line.nodes[wall].iter().copied().collect());
        // Facets of each wall on the line, the collapsed ones dropped.
        let mut facets: [Vec<usize>; 2] = [Vec::new(), Vec::new()];
        for (index, tri) in triangles.iter().enumerate() {
            let Some(wall) = line
                .walls
                .iter()
                .position(|&face| face == triangle_wall[index])
            else {
                continue;
            };
            if weld.dropped.contains(&index) {
                continue;
            }
            if tri.iter().all(|node| on_line[wall].contains(node)) {
                weld.dropped.insert(index);
            } else {
                facets[wall].push(index);
            }
        }
        let points = line_points(line, &on_line, &facets, triangles, vertices);
        let groups = group_points(&points, vertices, copies, &mut weld.merged);
        for wall_facets in &facets {
            for &index in wall_facets {
                split_on_line(triangles[index], &groups, &mut weld.splits);
            }
        }
    }
    weld
}

/// The line nodes the remaining facets use, sorted along the line.
fn line_points(
    line: &CornerLine,
    on_line: &[HashSet<usize>; 2],
    facets: &[Vec<usize>; 2],
    triangles: &[[usize; 3]],
    vertices: &[Vec3],
) -> Vec<OnLine> {
    let direction = cross(line.normals[0], line.normals[1]);
    let direction = scale(direction, 1.0 / norm(direction));
    let mut points: Vec<OnLine> = Vec::new();
    for wall in 0..2 {
        let used: BTreeSet<usize> = facets[wall]
            .iter()
            .flat_map(|&index| triangles[index])
            .filter(|node| on_line[wall].contains(node))
            .collect();
        points.extend(used.into_iter().map(|node| OnLine {
            along: dot(vertices[node], direction),
            wall,
            node,
        }));
    }
    points.sort_by(|left, right| left.along.total_cmp(&right.along));
    points
}

/// The groups of line nodes, in order along the line: each its first node,
/// and the group of every node.
struct Groups {
    first: Vec<usize>,
    of: HashMap<usize, usize>,
}

/// Group nodes closer than a quarter of their spacing along their own wall's
/// edge: sliding one that far along the straight edge keeps its facets sound,
/// while splitting there would leave slivers. Each later node of a group (and
/// its copies) moves onto the first, and the pair is recorded in `merged`.
fn group_points(
    points: &[OnLine],
    vertices: &mut [Vec3],
    copies: &dyn Fn(usize) -> Vec<usize>,
    merged: &mut Vec<(usize, usize)>,
) -> Groups {
    let spacing = |position: usize| {
        let point = points[position];
        let same = |other: &&OnLine| other.wall == point.wall;
        let before = points[..position]
            .iter()
            .rev()
            .find(same)
            .map_or(f64::INFINITY, |other| point.along - other.along);
        let after = points[position + 1..]
            .iter()
            .find(same)
            .map_or(f64::INFINITY, |other| other.along - point.along);
        before.min(after)
    };
    let mut groups = Groups {
        first: Vec::new(),
        of: HashMap::new(),
    };
    for (position, point) in points.iter().enumerate() {
        let joins = position > 0
            && point.along - points[position - 1].along
                <= 0.25 * spacing(position).min(spacing(position - 1));
        match groups.first.last() {
            Some(&representative) if joins => {
                let target = vertices[representative];
                for copy in copies(point.node) {
                    vertices[copy] = target;
                }
                merged.push((point.node, representative));
            }
            _ => groups.first.push(point.node),
        }
        groups.of.insert(point.node, groups.first.len() - 1);
    }
    groups
}

/// Record a split of each edge of `tri` on the line at the groups strictly
/// inside it.
fn split_on_line(
    tri: [usize; 3],
    groups: &Groups,
    splits: &mut HashMap<(usize, usize), Vec<usize>>,
) {
    for corner in 0..3 {
        let (start, end) = (tri[corner], tri[(corner + 1) % 3]);
        let (Some(&from), Some(&to)) = (groups.of.get(&start), groups.of.get(&end)) else {
            continue;
        };
        if from.abs_diff(to) < 2 {
            continue;
        }
        let between: Vec<usize> = if from < to {
            groups.first[from + 1..to].to_vec()
        } else {
            groups.first[to + 1..from].iter().rev().copied().collect()
        };
        let mut reversed = between.clone();
        reversed.reverse();
        splits.insert((start, end), between);
        splits.insert((end, start), reversed);
    }
}

/// Fan-split `tri` at every edge that carries split nodes, recursively, so a
/// facet with edges on two corner lines is split at both.
pub(crate) fn split_triangle(
    tri: [usize; 3],
    splits: &HashMap<(usize, usize), Vec<usize>>,
) -> Vec<[usize; 3]> {
    let mut pending = vec![tri];
    let mut done = Vec::new();
    while let Some(tri) = pending.pop() {
        let split = (0..3).find_map(|corner| {
            let (start, end) = (tri[corner], tri[(corner + 1) % 3]);
            splits
                .get(&(start, end))
                .map(|between| (corner, start, end, between))
        });
        let Some((corner, start, end, between)) = split else {
            done.push(tri);
            continue;
        };
        let apex = tri[(corner + 2) % 3];
        let chain: Vec<usize> = std::iter::once(start)
            .chain(between.iter().copied())
            .chain(std::iter::once(end))
            .collect();
        // Reversed, so the pieces come out in order along the edge.
        pending.extend(
            chain
                .windows(2)
                .rev()
                .map(|piece| [piece[0], piece[1], apex]),
        );
    }
    done
}

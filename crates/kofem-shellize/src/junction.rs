// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! T-junction weld. Where one wall stands on another's face (an I-beam web on
//! a flange), the standing wall's edge nodes land on the other wall's
//! mid-plane — inside its facets, not on its nodes, since Netgen meshed the
//! two CAD faces independently. Imprint those nodes, and the standing wall's
//! edges between them, into the other wall's facets, so the two mid-surfaces
//! share nodes and edges along the junction line.

use std::collections::{HashMap, HashSet, VecDeque};

use crate::geometry::{add, cross, dot, norm, scale, sub, Vec3};

type Point2 = [f64; 2];

/// Where a junction node went.
enum Placement {
    /// Outside every facet of the base wall: not welded.
    Outside,
    /// Inserted as a new node of the base wall's facets.
    Inserted,
    /// Welded onto this base node, which was moved onto it.
    Welded(usize),
}

/// Twice the signed area of (`first`, `second`, `third`): positive when the
/// three run counter-clockwise.
fn orient(first: Point2, second: Point2, third: Point2) -> f64 {
    (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0])
}

/// Positive when `query` lies inside the circumcircle of the counter-clockwise
/// triangle (`first`, `second`, `third`).
fn in_circle(first: Point2, second: Point2, third: Point2, query: Point2) -> f64 {
    let rows = [first, second, third].map(|corner| {
        let delta = [corner[0] - query[0], corner[1] - query[1]];
        [
            delta[0],
            delta[1],
            delta[0] * delta[0] + delta[1] * delta[1],
        ]
    });
    rows[0][0] * (rows[1][1] * rows[2][2] - rows[2][1] * rows[1][2])
        - rows[1][0] * (rows[0][1] * rows[2][2] - rows[2][1] * rows[0][2])
        + rows[2][0] * (rows[0][1] * rows[1][2] - rows[1][1] * rows[0][2])
}

/// What the standing walls imprint on one base wall.
pub(crate) struct Imprint<'input> {
    /// Unit normal of the base wall; its facets run counter-clockwise about it.
    pub normal: Vec3,
    /// The base wall's facets, over raw node ids.
    pub triangles: &'input [[usize; 3]],
    /// Junction nodes to insert (raw ids of the standing walls' nodes).
    pub points: &'input [usize],
    /// Standing-wall edges between junction nodes, to recover as facet edges.
    pub segments: &'input [[usize; 2]],
}

/// The base wall's facets after the imprint, and the junction nodes that were
/// welded onto an existing base node instead of being inserted (each such
/// base node was first moved onto the junction node).
pub(crate) struct Imprinted {
    pub triangles: Vec<[usize; 3]>,
    pub merged: Vec<(usize, usize)>,
}

/// A planar triangulation with directed-edge adjacency: facet `[a, b, c]`
/// owns the edges a→b, b→c, c→a; the facet across a→b owns b→a.
struct Triangulation<'vertices> {
    vertices: &'vertices mut [Vec3],
    origin: Vec3,
    axes: [Vec3; 2],
    triangles: Vec<Option<[usize; 3]>>,
    edges: HashMap<(usize, usize), usize>,
    /// Recovered junction segments, both directions: never flipped.
    fixed: HashSet<(usize, usize)>,
    /// Junction nodes and the base nodes moved onto them: never moved again.
    pinned: HashSet<usize>,
    normal: Vec3,
}

impl Triangulation<'_> {
    fn point(&self, node: usize) -> Point2 {
        let delta = sub(self.vertices[node], self.origin);
        [dot(delta, self.axes[0]), dot(delta, self.axes[1])]
    }

    fn add(&mut self, triangle: [usize; 3]) -> usize {
        let index = self.triangles.len();
        for corner in 0..3 {
            self.edges
                .insert((triangle[corner], triangle[(corner + 1) % 3]), index);
        }
        self.triangles.push(Some(triangle));
        index
    }

    fn remove(&mut self, index: usize) -> Option<[usize; 3]> {
        let triangle = self.triangles[index].take()?;
        for corner in 0..3 {
            self.edges
                .remove(&(triangle[corner], triangle[(corner + 1) % 3]));
        }
        Some(triangle)
    }

    fn signed_area(&self, triangle: [usize; 3]) -> f64 {
        orient(
            self.point(triangle[0]),
            self.point(triangle[1]),
            self.point(triangle[2]),
        )
    }

    /// The live facet that contains `query` (most inside first), with its
    /// barycentric coordinates; `None` when `query` lies outside them all.
    fn locate(&self, query: Point2) -> Option<(usize, [f64; 3])> {
        let mut best: Option<(usize, [f64; 3])> = None;
        let mut best_inside = f64::NEG_INFINITY;
        for (index, triangle) in self.triangles.iter().enumerate() {
            let Some(triangle) = *triangle else {
                continue;
            };
            let corners = triangle.map(|node| self.point(node));
            let area = orient(corners[0], corners[1], corners[2]);
            if area <= 0.0 {
                continue;
            }
            let weights = [
                orient(query, corners[1], corners[2]) / area,
                orient(corners[0], query, corners[2]) / area,
                orient(corners[0], corners[1], query) / area,
            ];
            let inside = weights[0].min(weights[1]).min(weights[2]);
            if inside > best_inside {
                best_inside = inside;
                best = Some((index, weights));
            }
        }
        best.filter(|_| best_inside >= -1e-9)
    }

    /// The live facets around `node`.
    fn fan(&self, node: usize) -> Vec<usize> {
        self.triangles
            .iter()
            .enumerate()
            .filter_map(|(index, triangle)| {
                triangle.filter(|tri| tri.contains(&node)).map(|_| index)
            })
            .collect()
    }

    /// Shape quality of a facet: 1 for equilateral, 0 for degenerate.
    fn quality(&self, triangle: [usize; 3]) -> f64 {
        let corners = triangle.map(|node| self.point(node));
        let squared = (0..3)
            .map(|corner| {
                let next = corners[(corner + 1) % 3];
                let delta = [next[0] - corners[corner][0], next[1] - corners[corner][1]];
                delta[0] * delta[0] + delta[1] * delta[1]
            })
            .sum::<f64>();
        if squared == 0.0 {
            return 0.0;
        }
        2.0 * 3.0_f64.sqrt() * orient(corners[0], corners[1], corners[2]) / squared
    }

    fn worst_quality(&self, fan: &[usize]) -> f64 {
        fan.iter()
            .filter_map(|&index| self.triangles[index].map(|tri| self.quality(tri)))
            .fold(f64::INFINITY, f64::min)
    }

    /// The far ends of the boundary edges (edges with no facet across) at
    /// `node`; empty for an interior node.
    fn boundary_neighbours(&self, fan: &[usize], node: usize) -> Vec<usize> {
        let mut ends = Vec::new();
        for &index in fan {
            let Some(triangle) = self.triangles[index] else {
                continue;
            };
            for corner in 0..3 {
                let edge = (triangle[corner], triangle[(corner + 1) % 3]);
                if (edge.0 == node || edge.1 == node) && !self.edges.contains_key(&(edge.1, edge.0))
                {
                    ends.push(if edge.0 == node { edge.1 } else { edge.0 });
                }
            }
        }
        ends
    }

    /// Move `node` to `position` when that keeps the wall's outline and every
    /// facet around it valid, and `accept` agrees given the worst facet
    /// quality around it before and after. A boundary node may only slide
    /// along its straight boundary. Returns whether it moved.
    fn try_move(&mut self, node: usize, position: Vec3, accept: impl Fn(f64, f64) -> bool) -> bool {
        let fan = self.fan(node);
        let ends = self.boundary_neighbours(&fan, node);
        if !ends.is_empty() {
            let [first, second] = ends[..] else {
                return false;
            };
            let [start, here, end] = [first, node, second].map(|corner| self.point(corner));
            let delta = sub(position, self.origin);
            let target = [dot(delta, self.axes[0]), dot(delta, self.axes[1])];
            let span = (end[0] - start[0]).hypot(end[1] - start[1]);
            let straight = |point: Point2| orient(start, end, point).abs() <= 1e-9 * span * span;
            let along = (target[0] - start[0]) * (end[0] - start[0])
                + (target[1] - start[1]) * (end[1] - start[1]);
            if !straight(here) || !straight(target) || along <= 0.0 || along >= span * span {
                return false;
            }
        }
        let areas: Vec<f64> = fan
            .iter()
            .filter_map(|&index| self.triangles[index].map(|tri| self.signed_area(tri)))
            .collect();
        let before = self.worst_quality(&fan);
        let previous = self.vertices[node];
        self.vertices[node] = position;
        let valid = fan.iter().zip(&areas).all(|(&index, &area)| {
            self.triangles[index].is_some_and(|tri| self.signed_area(tri) > 1e-9 * area)
        });
        let moved = valid && accept(before, self.worst_quality(&fan));
        if !moved {
            self.vertices[node] = previous;
        }
        moved
    }

    /// Relax the free base nodes next to the junction: each moves to the mean
    /// of its neighbours when that improves the worst facet around it. Base
    /// nodes Netgen placed just off the junction line otherwise leave slivers
    /// against the imprinted edges.
    fn smooth(&mut self, movable: &dyn Fn(usize) -> bool) {
        let mut candidates: Vec<usize> = Vec::new();
        let mut seen: HashSet<usize> = HashSet::new();
        let mut pinned: Vec<usize> = self.pinned.iter().copied().collect();
        pinned.sort_unstable();
        for &junction in &pinned {
            for index in self.fan(junction) {
                for node in self.triangles[index].into_iter().flatten() {
                    if !self.pinned.contains(&node) && movable(node) && seen.insert(node) {
                        candidates.push(node);
                    }
                }
            }
        }
        for _ in 0..4 {
            for &node in &candidates {
                let fan = self.fan(node);
                let mut neighbours: Vec<usize> = fan
                    .iter()
                    .filter_map(|&index| self.triangles[index])
                    .flatten()
                    .filter(|&corner| corner != node)
                    .collect();
                neighbours.sort_unstable();
                neighbours.dedup();
                if neighbours.is_empty() {
                    continue;
                }
                let mut mean: Vec3 = [0.0; 3];
                for &neighbour in &neighbours {
                    mean = add(mean, self.vertices[neighbour]);
                }
                #[allow(
                    clippy::cast_precision_loss,
                    reason = "a handful of neighbours, far below 2^52"
                )]
                let mean = scale(mean, 1.0 / neighbours.len() as f64);
                // Stay in the wall's plane: drop the off-plane part.
                let off = dot(sub(mean, self.vertices[node]), self.normal);
                let target = sub(mean, scale(self.normal, off));
                self.try_move(node, target, |before, after| after > before + 1e-6);
            }
        }
    }

    /// Flip the edge `first`→`second` shared by two facets, when their quad is
    /// strictly convex. Returns the two new facets.
    fn flip(&mut self, first: usize, second: usize) -> Option<[usize; 2]> {
        let &left = self.edges.get(&(first, second))?;
        let &right = self.edges.get(&(second, first))?;
        let apex = |triangle: [usize; 3]| {
            triangle
                .into_iter()
                .find(|&node| node != first && node != second)
        };
        let near = apex(self.triangles[left]?)?;
        let far = apex(self.triangles[right]?)?;
        let [near_point, first_point, second_point, far_point] =
            [near, first, second, far].map(|node| self.point(node));
        if orient(near_point, first_point, far_point) <= 0.0
            || orient(near_point, far_point, second_point) <= 0.0
        {
            return None;
        }
        self.remove(left);
        self.remove(right);
        Some([self.add([near, first, far]), self.add([near, far, second])])
    }

    /// Lawson flips out from a freshly inserted `node`: restore the
    /// empty-circumcircle property on the edges facing it.
    fn legalize(&mut self, node: usize, mut stack: Vec<usize>) {
        let mut budget = 64 * (self.triangles.len() + 16);
        while let Some(index) = stack.pop() {
            if budget == 0 {
                return;
            }
            budget -= 1;
            let Some(triangle) = self.triangles[index] else {
                continue;
            };
            let Some(position) = triangle.iter().position(|&corner| corner == node) else {
                continue;
            };
            let first = triangle[(position + 1) % 3];
            let second = triangle[(position + 2) % 3];
            if self.fixed.contains(&(first, second)) {
                continue;
            }
            let Some(&across) = self.edges.get(&(second, first)) else {
                continue;
            };
            let Some(far) = self.triangles[across].and_then(|tri| {
                tri.into_iter()
                    .find(|&corner| corner != first && corner != second)
            }) else {
                continue;
            };
            let illegal = in_circle(
                self.point(node),
                self.point(first),
                self.point(second),
                self.point(far),
            ) > 0.0;
            if illegal {
                if let Some(new) = self.flip(first, second) {
                    stack.extend(new);
                }
            }
        }
    }

    /// Insert `node` into the facet that contains it. Returns `None` when it
    /// lies outside every facet, or the base node it was welded onto.
    fn insert(&mut self, node: usize, movable: &dyn Fn(usize) -> bool) -> Placement {
        let query = self.point(node);
        let Some((index, weights)) = self.locate(query) else {
            return Placement::Outside;
        };
        let Some(triangle) = self.triangles[index] else {
            return Placement::Outside;
        };
        // Weld onto the nearest corner when it can move there cleanly.
        let shortest = (0..3)
            .map(|corner| {
                let delta = sub(
                    self.vertices[triangle[corner]],
                    self.vertices[triangle[(corner + 1) % 3]],
                );
                norm(delta)
            })
            .fold(f64::INFINITY, f64::min);
        let nearest = (0..3)
            .min_by(|&left, &right| {
                let distance =
                    |corner: usize| norm(sub(self.vertices[triangle[corner]], self.vertices[node]));
                distance(left).total_cmp(&distance(right))
            })
            .map(|corner| triangle[corner]);
        if let Some(nearest) = nearest {
            let distance = norm(sub(self.vertices[nearest], self.vertices[node]));
            if distance <= 1e-9 * shortest
                || (distance < 0.25 * shortest
                    && !self.pinned.contains(&nearest)
                    && movable(nearest)
                    && self.try_move(nearest, self.vertices[node], |before, after| {
                        after >= 0.3 * before
                    }))
            {
                self.vertices[nearest] = self.vertices[node];
                self.pinned.insert(nearest);
                return Placement::Welded(nearest);
            }
        }
        self.pinned.insert(node);
        let on_edge = (0..3).find(|&corner| weights[corner].abs() <= 1e-9);
        let mut created = Vec::new();
        if let Some(opposite) = on_edge {
            // On the edge first→second: split this facet and the one across.
            let first = triangle[(opposite + 1) % 3];
            let second = triangle[(opposite + 2) % 3];
            let apex = triangle[opposite];
            // The facet across, and its corner off the edge (none on the boundary).
            let across = self
                .edges
                .get(&(second, first))
                .copied()
                .and_then(|across| {
                    self.triangles[across]?
                        .into_iter()
                        .find(|&corner| corner != first && corner != second)
                        .map(|far| (across, far))
                });
            self.remove(index);
            created.push(self.add([apex, first, node]));
            created.push(self.add([apex, node, second]));
            if let Some((across, far)) = across {
                self.remove(across);
                created.push(self.add([far, second, node]));
                created.push(self.add([far, node, first]));
            }
        } else {
            self.remove(index);
            for corner in 0..3 {
                created.push(self.add([node, triangle[corner], triangle[(corner + 1) % 3]]));
            }
        }
        self.legalize(node, created);
        Placement::Inserted
    }

    /// Does the edge `first`–`second` cross the open segment `start`–`end`?
    fn crosses(&self, [first, second]: [usize; 2], [start, end]: [usize; 2]) -> bool {
        if [first, second]
            .iter()
            .any(|&node| node == start || node == end)
        {
            return false;
        }
        let [first_point, second_point, start_point, end_point] =
            [first, second, start, end].map(|node| self.point(node));
        orient(start_point, end_point, first_point) * orient(start_point, end_point, second_point)
            < 0.0
            && orient(first_point, second_point, start_point)
                * orient(first_point, second_point, end_point)
                < 0.0
    }

    /// Make the segment `start`–`end` a facet edge by flipping the edges that
    /// cross it (Sloan's recovery). Returns whether it is one now.
    fn recover(&mut self, segment: [usize; 2]) -> bool {
        let [start, end] = segment;
        let present = |this: &Self| {
            this.edges.contains_key(&(start, end)) || this.edges.contains_key(&(end, start))
        };
        if !present(self) {
            let mut queue: VecDeque<[usize; 2]> = VecDeque::new();
            for triangle in self.triangles.iter().flatten() {
                for corner in 0..3 {
                    let edge = [triangle[corner], triangle[(corner + 1) % 3]];
                    if edge[0] < edge[1] && self.crosses(edge, segment) {
                        queue.push_back(edge);
                    }
                }
            }
            let mut budget = 16 * (queue.len() + 4) * (queue.len() + 4);
            while let Some(edge) = queue.pop_front() {
                if budget == 0 {
                    break;
                }
                budget -= 1;
                if !self.crosses(edge, segment) {
                    continue;
                }
                let flipped = self
                    .flip(edge[0], edge[1])
                    .or_else(|| self.flip(edge[1], edge[0]));
                let Some([new, _]) = flipped else {
                    queue.push_back(edge); // not convex yet: retry later
                    continue;
                };
                // The new edge is the one the two new facets share.
                if let Some(triangle) = self.triangles[new] {
                    let shared = [triangle[0], triangle[2]];
                    if self.crosses(shared, segment) {
                        queue.push_back(shared);
                    }
                }
            }
        }
        let recovered = present(self);
        if recovered {
            self.fixed.insert((start, end));
            self.fixed.insert((end, start));
        }
        recovered
    }
}

/// Two unit axes spanning the plane square to `normal`, so that
/// (first, second, normal) is right-handed.
fn plane_axes(normal: Vec3) -> [Vec3; 2] {
    let helper = if normal[0].abs() < 0.9 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    let first = cross(helper, normal);
    let first = scale(first, 1.0 / norm(first));
    [first, cross(normal, first)]
}

/// How deep `point` lies inside the facets, measured in their plane: its
/// distance to the nearest boundary edge (an edge with no facet across), or
/// `None` when no facet contains it.
pub(crate) fn clearance(
    vertices: &[Vec3],
    triangles: &[[usize; 3]],
    normal: Vec3,
    point: Vec3,
) -> Option<f64> {
    let axes = plane_axes(normal);
    let flat = |position: Vec3| [dot(position, axes[0]), dot(position, axes[1])];
    let query = flat(point);
    let inside = triangles.iter().any(|triangle| {
        let corners = triangle.map(|node| flat(vertices[node]));
        let area = orient(corners[0], corners[1], corners[2]);
        area > 0.0
            && orient(query, corners[1], corners[2]) >= -1e-9 * area
            && orient(corners[0], query, corners[2]) >= -1e-9 * area
            && orient(corners[0], corners[1], query) >= -1e-9 * area
    });
    if !inside {
        return None;
    }
    let directed: HashSet<(usize, usize)> = triangles
        .iter()
        .flat_map(|triangle| {
            (0..3).map(move |corner| (triangle[corner], triangle[(corner + 1) % 3]))
        })
        .collect();
    let mut nearest = f64::INFINITY;
    for &(start, end) in &directed {
        if directed.contains(&(end, start)) {
            continue;
        }
        let [from, to] = [start, end].map(|node| flat(vertices[node]));
        let along = [to[0] - from[0], to[1] - from[1]];
        let length2 = along[0] * along[0] + along[1] * along[1];
        let offset = [query[0] - from[0], query[1] - from[1]];
        let fraction = if length2 > 0.0 {
            ((offset[0] * along[0] + offset[1] * along[1]) / length2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let gap = [
            offset[0] - fraction * along[0],
            offset[1] - fraction * along[1],
        ];
        nearest = nearest.min(gap[0].hypot(gap[1]));
    }
    Some(nearest)
}

/// Imprint the junction nodes and segments of one base wall. A node outside
/// the base wall's facets is left where it is (not welded); `movable` says
/// which base nodes are interior to their CAD face and may be nudged onto a
/// junction node right next to them.
pub(crate) fn imprint(
    vertices: &mut [Vec3],
    imprint: &Imprint<'_>,
    movable: &dyn Fn(usize) -> bool,
) -> Imprinted {
    let normal = imprint.normal;
    let origin = imprint
        .triangles
        .first()
        .map_or([0.0; 3], |triangle| vertices[triangle[0]]);
    let mut mesh = Triangulation {
        vertices,
        origin,
        axes: plane_axes(normal),
        triangles: Vec::with_capacity(imprint.triangles.len() + 4 * imprint.points.len()),
        edges: HashMap::new(),
        fixed: HashSet::new(),
        pinned: HashSet::new(),
        normal,
    };
    for &triangle in imprint.triangles {
        mesh.add(triangle);
    }
    let mut merged = Vec::new();
    // Where each placed junction node ended up: itself, or the base node it
    // was welded onto. A node outside the base wall is not placed.
    let mut placed: HashMap<usize, usize> = HashMap::new();
    for &node in imprint.points {
        match mesh.insert(node, movable) {
            Placement::Welded(base) => {
                merged.push((node, base));
                placed.insert(node, base);
            }
            Placement::Inserted => {
                placed.insert(node, node);
            }
            Placement::Outside => {}
        }
    }
    for &[start, end] in imprint.segments {
        let (Some(&start), Some(&end)) = (placed.get(&start), placed.get(&end)) else {
            continue;
        };
        if start != end {
            mesh.recover([start, end]);
        }
    }
    mesh.smooth(movable);
    Imprinted {
        triangles: mesh.triangles.into_iter().flatten().collect(),
        merged,
    }
}

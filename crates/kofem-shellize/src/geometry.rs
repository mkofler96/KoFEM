// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Mesh primitives shared by every stage: the validated input mesh and the
//! small measurements each stage takes of it.

use std::collections::{HashMap, HashSet};
use std::hash::Hash;

use crate::error::ShellizeError;

pub type Vec3 = [f64; 3];

/// The four faces of a tetrahedron, as corner indices.
pub const TET_FACES: [[usize; 3]; 4] = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]];

#[must_use]
pub fn sub(left: Vec3, right: Vec3) -> Vec3 {
    [left[0] - right[0], left[1] - right[1], left[2] - right[2]]
}

#[must_use]
pub fn add(left: Vec3, right: Vec3) -> Vec3 {
    [left[0] + right[0], left[1] + right[1], left[2] + right[2]]
}

#[must_use]
pub fn scale(vector: Vec3, factor: f64) -> Vec3 {
    [vector[0] * factor, vector[1] * factor, vector[2] * factor]
}

#[must_use]
pub fn dot(left: Vec3, right: Vec3) -> f64 {
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

#[must_use]
pub fn cross(left: Vec3, right: Vec3) -> Vec3 {
    [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ]
}

#[must_use]
pub fn norm(vector: Vec3) -> f64 {
    dot(vector, vector).sqrt()
}

#[must_use]
pub fn dist2(left: Vec3, right: Vec3) -> f64 {
    let delta = sub(left, right);
    dot(delta, delta)
}

/// Largest value of a slice; `None` when it is empty. Never spreads the slice
/// into a call, so a mesh of any size is fine (the TS `Math.max(...array)` this
/// replaces overflowed V8's call stack past ~120k values).
#[must_use]
pub fn max_of(values: &[f64]) -> Option<f64> {
    values.iter().copied().reduce(f64::max)
}

/// The distinct items of `items`, in order of first appearance — the order a JS
/// `new Set(array)` iterates in, which the pool numbering depends on.
pub fn unique_in_order<T: Copy + Eq + Hash>(items: impl IntoIterator<Item = T>) -> Vec<T> {
    let mut seen = HashSet::new();
    items
        .into_iter()
        .filter(|item| seen.insert(*item))
        .collect()
}

/// Insertion-ordered map from a hashable key to a value, for the places where
/// the TS pipeline relies on `Map` iteration order.
#[derive(Debug, Clone)]
pub struct OrderedMap<K, V> {
    index: HashMap<K, usize>,
    entries: Vec<(K, V)>,
}

impl<K: Copy + Eq + Hash, V> Default for OrderedMap<K, V> {
    fn default() -> Self {
        Self {
            index: HashMap::new(),
            entries: Vec::new(),
        }
    }
}

impl<K: Copy + Eq + Hash, V> OrderedMap<K, V> {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The value for `key`, inserting `make()` first if it is absent.
    pub fn get_or_insert_with(&mut self, key: K, make: impl FnOnce() -> V) -> &mut V {
        let position = if let Some(&position) = self.index.get(&key) {
            position
        } else {
            let position = self.entries.len();
            self.index.insert(key, position);
            self.entries.push((key, make()));
            position
        };
        &mut self.entries[position].1
    }

    #[must_use]
    pub fn get(&self, key: &K) -> Option<&V> {
        self.index
            .get(key)
            .map(|&position| &self.entries[position].1)
    }

    pub fn get_mut(&mut self, key: &K) -> Option<&mut V> {
        self.index
            .get(key)
            .map(|&position| &mut self.entries[position].1)
    }

    /// Insert or overwrite, keeping the key's first position.
    pub fn insert(&mut self, key: K, value: V) {
        if let Some(&position) = self.index.get(&key) {
            self.entries[position].1 = value;
        } else {
            self.index.insert(key, self.entries.len());
            self.entries.push((key, value));
        }
    }

    #[must_use]
    pub fn contains_key(&self, key: &K) -> bool {
        self.index.contains_key(key)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&K, &V)> {
        self.entries.iter().map(|(key, value)| (key, value))
    }

    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.entries.iter().map(|(_, value)| value)
    }

    pub fn keys(&self) -> impl Iterator<Item = &K> {
        self.entries.iter().map(|(key, _)| key)
    }
}

/// The mesh the idealisation reads: a linear tet mesh with a body id per tet,
/// plus the boundary triangles Netgen produced with the CAD face each lies on.
/// Validated on construction, so every index the stages follow is in range.
#[derive(Debug, Clone, PartialEq)]
pub struct ShellizeMesh {
    pub(crate) vertices: Vec<Vec3>,
    pub(crate) tets: Vec<[usize; 4]>,
    pub(crate) body: Vec<i32>,
    pub(crate) surf_tris: Vec<[usize; 3]>,
    pub(crate) surf_face: Vec<i32>,
}

fn checked_vertices(vertices: &[f64]) -> Result<Vec<Vec3>, ShellizeError> {
    if !vertices.len().is_multiple_of(3) {
        return Err(ShellizeError::ArrayLength {
            what: "vertex array",
            len: vertices.len(),
            stride: 3,
        });
    }
    if let Some(&value) = vertices.iter().find(|value| !value.is_finite()) {
        return Err(ShellizeError::NonFinite {
            what: "a vertex coordinate",
            value,
        });
    }
    Ok(vertices.as_chunks::<3>().0.to_vec())
}

/// Split a flat index array into fixed-size groups, each index checked
/// against `count` vertices.
pub(crate) fn checked_groups<const N: usize>(
    indices: &[u32],
    count: usize,
    what: &'static str,
) -> Result<Vec<[usize; N]>, ShellizeError> {
    if !indices.len().is_multiple_of(N) {
        return Err(ShellizeError::ArrayLength {
            what,
            len: indices.len(),
            stride: N,
        });
    }
    if let Some(&vertex) = indices.iter().find(|&&vertex| vertex as usize >= count) {
        return Err(ShellizeError::VertexOutOfRange {
            what,
            vertex: vertex as usize,
            count,
        });
    }
    Ok(indices
        .as_chunks::<N>()
        .0
        .iter()
        .map(|group| group.map(|vertex| vertex as usize))
        .collect())
}

impl ShellizeMesh {
    /// Build from flat arrays: `vertices` as x,y,z triples, `tets` as four
    /// vertex indices each with `body` holding one body id per tet, and
    /// `surf_tris` as three vertex indices each with `surf_face` holding the
    /// CAD face id of each surface triangle.
    ///
    /// # Errors
    /// The first malformed array or out-of-range index.
    pub fn new(
        vertices: &[f64],
        tets: &[u32],
        body: &[i32],
        surf_tris: &[u32],
        surf_face: &[i32],
    ) -> Result<Self, ShellizeError> {
        let points = checked_vertices(vertices)?;
        let tets = checked_groups::<4>(tets, points.len(), "tetrahedron array")?;
        if body.len() != tets.len() {
            return Err(ShellizeError::ArrayCount {
                what: "body id array",
                len: body.len(),
                expected: tets.len(),
            });
        }
        let surf_tris = checked_groups::<3>(surf_tris, points.len(), "surface triangle array")?;
        if surf_face.len() != surf_tris.len() {
            return Err(ShellizeError::ArrayCount {
                what: "surface face id array",
                len: surf_face.len(),
                expected: surf_tris.len(),
            });
        }
        Ok(Self {
            vertices: points,
            tets,
            body: body.to_vec(),
            surf_tris,
            surf_face: surf_face.to_vec(),
        })
    }

    #[must_use]
    pub fn vertices(&self) -> &[Vec3] {
        &self.vertices
    }

    #[must_use]
    pub fn tets(&self) -> &[[usize; 4]] {
        &self.tets
    }

    #[must_use]
    pub fn body(&self) -> &[i32] {
        &self.body
    }

    #[must_use]
    pub fn surface_triangles(&self) -> &[[usize; 3]] {
        &self.surf_tris
    }

    #[must_use]
    pub fn surface_faces(&self) -> &[i32] {
        &self.surf_face
    }

    #[must_use]
    pub fn point(&self, index: usize) -> Vec3 {
        self.vertices[index]
    }

    /// Volume of tet `element`.
    #[must_use]
    pub fn tet_volume(&self, element: usize) -> f64 {
        let corner = self.tets[element].map(|vertex| self.vertices[vertex]);
        let edge = [1, 2, 3].map(|k| sub(corner[k], corner[0]));
        // |e₁ · (e₂ × e₃)| / 6, the edges from corner 0
        (edge[0][0] * (edge[1][1] * edge[2][2] - edge[1][2] * edge[2][1])
            + edge[0][1] * (edge[1][2] * edge[2][0] - edge[1][0] * edge[2][2])
            + edge[0][2] * (edge[1][0] * edge[2][1] - edge[1][1] * edge[2][0]))
            .abs()
            / 6.0
    }
}

/// Longest edge of a triangle.
#[must_use]
pub fn triangle_extent(corners: [Vec3; 3]) -> f64 {
    norm(sub(corners[1], corners[0]))
        .max(norm(sub(corners[2], corners[1])))
        .max(norm(sub(corners[0], corners[2])))
}

fn sorted_face(tri: [usize; 3]) -> [usize; 3] {
    let mut key = tri;
    key.sort_unstable();
    key
}

/// The vertex triple of tet face `face`, and its order-independent key.
pub(crate) fn tet_face(tet: [usize; 4], face: [usize; 3]) -> ([usize; 3], [usize; 3]) {
    let tri = face.map(|corner| tet[corner]);
    (tri, sorted_face(tri))
}

#[must_use]
pub(crate) fn triangle_key(tri: [usize; 3]) -> [usize; 3] {
    sorted_face(tri)
}

/// Boundary of a tet mesh: the faces used by exactly one element, over the
/// same vertex numbering as `tets`, in order of first appearance.
#[must_use]
pub fn tet_mesh_boundary(tets: &[[usize; 4]]) -> Vec<[usize; 3]> {
    let mut seen: OrderedMap<[usize; 3], ([usize; 3], usize)> = OrderedMap::new();
    for &tet in tets {
        for face in TET_FACES {
            let (tri, key) = tet_face(tet, face);
            seen.get_or_insert_with(key, || (tri, 0)).1 += 1;
        }
    }
    seen.values()
        .filter(|(_, count)| *count == 1)
        .map(|(tri, _)| *tri)
        .collect()
}

/// Median tet edge — the solid mesh's own length scale, from which the
/// coupling distances are derived so none is a fixed number of millimetres.
/// Zero for an empty mesh.
#[must_use]
pub fn median_tet_edge(point: impl Fn(usize) -> Vec3, tets: &[[usize; 4]]) -> f64 {
    let mut edges: Vec<f64> = Vec::with_capacity(6 * tets.len());
    for tet in tets {
        let nodes = tet.map(&point);
        for i in 0..4 {
            for j in (i + 1)..4 {
                edges.push(norm(sub(nodes[i], nodes[j])));
            }
        }
    }
    if edges.is_empty() {
        return 0.0;
    }
    edges.sort_by(f64::total_cmp);
    edges[edges.len() / 2]
}

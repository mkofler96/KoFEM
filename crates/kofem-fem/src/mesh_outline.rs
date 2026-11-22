// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! What the viewport draws of a FEM mesh (KOF-457): its outer faces — the
//! faces exactly one element uses — and its edges, each once however many
//! elements share it. Only the outer faces are drawn as a surface; the
//! elements inside are never sent to the GPU, as in a surface view.
//!
//! Both work on element corners: 4 per tetrahedron and 8 per hexahedron in
//! CHEXA order (the bottom face, then the top face above it). Faces and edges
//! come in the order the elements and their local faces or edges first meet
//! them, corners in local order, so a mesh is drawn the same every time. The
//! search sorts instead of hashing: a few bytes per face, no allocation per
//! face.

use crate::error::FemError;

/// A tetrahedron's faces, as the viewport has always drawn them.
const TET_FACES: [[usize; 3]; 4] = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]];

/// A hexahedron's faces: bottom, top, then the four sides.
const HEX_FACES: [[usize; 4]; 6] = [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [0, 3, 7, 4],
    [1, 2, 6, 5],
];

const TET_EDGES: [[usize; 2]; 6] = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];

const HEX_EDGES: [[usize; 2]; 12] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
];

/// The faces exactly one element uses.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OuterFaces {
    /// Three corners per tetrahedron face.
    pub triangles: Vec<u32>,
    /// Four corners per hexahedron face, around it.
    pub quadrilaterals: Vec<u32>,
}

fn check(what: &'static str, values: &[u32], per: usize) -> Result<(), FemError> {
    if values.len().is_multiple_of(per) {
        Ok(())
    } else {
        Err(FemError::ConnectivityLength {
            what,
            len: values.len(),
            per,
        })
    }
}

/// The faces of `elements` (`N` corners each, `F` faces of `K` corners) that
/// no other face matches, in first-met order.
fn singles<const N: usize, const K: usize, const F: usize>(
    elements: &[u32],
    faces: &[[usize; K]; F],
) -> Vec<u32> {
    let corners = elements.as_chunks::<N>().0;
    let corners_of = |at: usize| {
        let local = &faces[at % F];
        let element = &corners[at / F];
        local.map(|corner| element[corner])
    };
    // Every face by its sorted corners, then where it was met.
    let mut order: Vec<(usize, [u32; K])> = (0..F * corners.len())
        .map(|at| {
            let mut key = corners_of(at);
            key.sort_unstable();
            (at, key)
        })
        .collect();
    order.sort_unstable_by(|first, second| first.1.cmp(&second.1).then(first.0.cmp(&second.0)));
    let mut kept: Vec<usize> = Vec::new();
    let mut start = 0;
    while start < order.len() {
        let mut end = start + 1;
        while end < order.len() && order[end].1 == order[start].1 {
            end += 1;
        }
        if end - start == 1 {
            kept.push(order[start].0);
        }
        start = end;
    }
    drop(order);
    kept.sort_unstable();
    kept.into_iter().flat_map(corners_of).collect()
}

/// The outer faces of a mesh of tetrahedra (`tets`, 4 corners each) and
/// hexahedra (`hexes`, 8 each).
///
/// # Errors
/// [`FemError::ConnectivityLength`] when an array is not whole elements.
pub fn outer_faces(tets: &[u32], hexes: &[u32]) -> Result<OuterFaces, FemError> {
    check("tetrahedron", tets, 4)?;
    check("hexahedron", hexes, 8)?;
    Ok(OuterFaces {
        triangles: singles::<4, 3, 4>(tets, &TET_FACES),
        quadrilaterals: singles::<8, 4, 6>(hexes, &HEX_FACES),
    })
}

/// Push the edges `local` of each element in `elements` (`per` corners each).
fn push_edges(elements: &[u32], per: usize, local: &[[usize; 2]], into: &mut Vec<[u32; 2]>) {
    for element in elements.chunks_exact(per) {
        into.extend(local.iter().map(|&[from, to]| [element[from], element[to]]));
    }
}

/// The edges around a polygon of `corners` corners: 0–1, 1–2, …, last–0.
fn polygon_edges(corners: usize) -> Vec<[usize; 2]> {
    (0..corners)
        .map(|from| [from, (from + 1) % corners])
        .collect()
}

/// Every edge of the tetrahedra (`tets`, 4 corners each), hexahedra
/// (`hexes`, 8), triangles (3) and quadrilaterals (4) once, as corner pairs
/// in first-met order: an element mesh's wireframe, or with only the outer
/// faces, its outline.
///
/// # Errors
/// [`FemError::ConnectivityLength`] when an array is not whole elements.
pub fn unique_edges(
    tets: &[u32],
    hexes: &[u32],
    triangles: &[u32],
    quadrilaterals: &[u32],
) -> Result<Vec<u32>, FemError> {
    check("tetrahedron", tets, 4)?;
    check("hexahedron", hexes, 8)?;
    check("triangle", triangles, 3)?;
    check("quadrilateral", quadrilaterals, 4)?;
    let mut edges = Vec::with_capacity(
        6 * (tets.len() / 4) + 12 * (hexes.len() / 8) + triangles.len() + quadrilaterals.len(),
    );
    push_edges(tets, 4, &TET_EDGES, &mut edges);
    push_edges(hexes, 8, &HEX_EDGES, &mut edges);
    push_edges(triangles, 3, &polygon_edges(3), &mut edges);
    push_edges(quadrilaterals, 4, &polygon_edges(4), &mut edges);
    // First meeting of each edge, either way round.
    let mut order: Vec<(u64, usize)> = edges
        .iter()
        .enumerate()
        .map(|(at, &[from, to])| {
            let (low, high) = if from < to { (from, to) } else { (to, from) };
            ((u64::from(low) << 32) | u64::from(high), at)
        })
        .collect();
    order.sort_unstable();
    order.dedup_by_key(|entry| entry.0);
    let mut first: Vec<usize> = order.into_iter().map(|(_, at)| at).collect();
    first.sort_unstable();
    Ok(first.into_iter().flat_map(|at| edges[at]).collect())
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The outer faces and unique edges of a FEM mesh, for drawing it (KOF-457):
//! a face that one element uses is on the outside, a face two share is not,
//! and an edge many elements share is drawn once.

#![allow(
    clippy::expect_used,
    reason = "a fixture that fails to build should abort the test"
)]

use kofem_fem::{outer_faces, unique_edges, FemError};

/// Two tets sharing the face (1, 2, 3).
const TWO_TETS: [u32; 8] = [0, 1, 2, 3, 1, 2, 3, 4];

/// Two unit hexes side by side, sharing the face (1, 2, 6, 5) / (4 … 7) in
/// CHEXA order: the bottom face, then the top face above it.
const TWO_HEXES: [u32; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 1, 8, 9, 2, 5, 10, 11, 6];

fn sorted_triples(flat: &[u32]) -> Vec<[u32; 3]> {
    let mut faces: Vec<[u32; 3]> = flat
        .as_chunks::<3>()
        .0
        .iter()
        .map(|face| {
            let mut key = [face[0], face[1], face[2]];
            key.sort_unstable();
            key
        })
        .collect();
    faces.sort_unstable();
    faces
}

#[test]
fn a_face_two_tets_share_is_not_outer() {
    let faces = outer_faces(&TWO_TETS, &[]).expect("valid tets");
    assert_eq!(faces.quadrilaterals, Vec::<u32>::new());
    assert_eq!(
        sorted_triples(&faces.triangles),
        vec![
            [0, 1, 2],
            [0, 1, 3],
            [0, 2, 3],
            [1, 2, 4],
            [1, 3, 4],
            [2, 3, 4]
        ]
    );
}

#[test]
fn outer_faces_keep_element_order_and_corner_order() {
    // Faces in the order the elements and their local faces (0,1,2), (0,1,3),
    // (0,2,3), (1,2,3) first meet them, corners in local order, as the
    // viewport drew them before.
    let faces = outer_faces(&TWO_TETS, &[]).expect("valid tets");
    assert_eq!(
        faces.triangles,
        vec![0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 4, 1, 3, 4, 2, 3, 4]
    );
}

#[test]
fn a_face_two_hexes_share_is_not_outer() {
    let faces = outer_faces(&[], &TWO_HEXES).expect("valid hexes");
    assert_eq!(faces.triangles, Vec::<u32>::new());
    // 2 × 6 faces, one shared: 10 outer faces.
    assert_eq!(faces.quadrilaterals.len(), 4 * 10);
    let shared = {
        let mut key = [1, 2, 6, 5];
        key.sort_unstable();
        key
    };
    for face in faces.quadrilaterals.as_chunks::<4>().0 {
        let mut key = [face[0], face[1], face[2], face[3]];
        key.sort_unstable();
        assert_ne!(key, shared, "the shared face is drawn");
    }
    // The first hex's faces in local order (bottom, top, then the sides).
    assert_eq!(&faces.quadrilaterals[..8], &[0, 1, 2, 3, 4, 5, 6, 7]);
}

#[test]
fn edges_many_elements_share_come_once() {
    // Two tets: 6 + 6 edges, 3 of them on the shared face.
    let edges = unique_edges(&TWO_TETS, &[], &[], &[]).expect("valid tets");
    assert_eq!(edges.len(), 2 * 9);
    assert_eq!(&edges[..12], &[0, 1, 0, 2, 0, 3, 1, 2, 1, 3, 2, 3]);
    assert_eq!(&edges[12..], &[1, 4, 2, 4, 3, 4]);
    // Two hexes: 12 + 12 edges, 4 on the shared face.
    let edges = unique_edges(&[], &TWO_HEXES, &[], &[]).expect("valid hexes");
    assert_eq!(edges.len(), 2 * 20);
}

#[test]
fn polygon_edges_of_triangles_and_quadrilaterals() {
    // A square split into two triangles beside a quadrilateral that shares
    // the edge (1, 2): 5 + 4 − 1 edges.
    let edges = unique_edges(&[], &[], &[0, 1, 2, 0, 2, 3], &[1, 4, 5, 2]).expect("valid");
    assert_eq!(edges, vec![0, 1, 1, 2, 2, 0, 2, 3, 3, 0, 1, 4, 4, 5, 5, 2]);
}

#[test]
fn malformed_connectivity_is_refused() {
    assert!(matches!(
        outer_faces(&[0, 1, 2], &[]),
        Err(FemError::ConnectivityLength { .. })
    ));
    assert!(matches!(
        outer_faces(&[], &[0; 7]),
        Err(FemError::ConnectivityLength { .. })
    ));
    assert!(matches!(
        unique_edges(&[], &[], &[0, 1], &[]),
        Err(FemError::ConnectivityLength { .. })
    ));
    assert!(matches!(
        unique_edges(&[], &[], &[], &[0, 1, 2]),
        Err(FemError::ConnectivityLength { .. })
    ));
}

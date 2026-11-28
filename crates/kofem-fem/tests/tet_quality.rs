// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The shape quality of linear tetrahedra (KOF-456): the smallest dihedral
//! angle and the aspect ratio, normalised so a regular tetrahedron scores 1.

#![allow(
    clippy::expect_used,
    reason = "a fixture that fails to build should abort the test"
)]

use kofem_fem::{tet_quality, FemError};

/// A regular tetrahedron with unit edges.
fn regular() -> Vec<f64> {
    let height = (2.0_f64 / 3.0).sqrt();
    vec![
        0.0,
        0.0,
        0.0,
        1.0,
        0.0,
        0.0,
        0.5,
        3.0_f64.sqrt() / 2.0,
        0.0,
        0.5,
        3.0_f64.sqrt() / 6.0,
        height,
    ]
}

#[test]
fn a_regular_tetrahedron_has_the_ideal_angle_and_aspect_ratio_one() {
    let quality = tet_quality(&regular(), &[0, 1, 2, 3]).expect("a valid tet");
    assert_eq!(quality.len(), 1);
    let ideal = (1.0_f64 / 3.0).acos().to_degrees();
    assert!((quality[0].min_dihedral_deg - ideal).abs() < 1e-9);
    assert!((quality[0].aspect_ratio - 1.0).abs() < 1e-9);
}

#[test]
fn the_corner_tetrahedron_has_a_right_dihedral_angle_and_a_known_aspect_ratio() {
    // Unit right-corner tet: three faces meet at 90°, the slanted face makes
    // acos(1/√3) ≈ 54.7° with each, so 54.7° is the smallest.
    let points = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    let quality = tet_quality(&points, &[0, 1, 2, 3]).expect("a valid tet");
    let smallest = (1.0_f64 / 3.0_f64.sqrt()).acos().to_degrees();
    assert!((quality[0].min_dihedral_deg - smallest).abs() < 1e-9);
    // Inradius 3V / A = 0.5 / (1.5 + √3/2); longest edge √2.
    let inradius = 0.5 / (1.5 + 3.0_f64.sqrt() / 2.0);
    let expected = 2.0_f64.sqrt() / (2.0 * 6.0_f64.sqrt() * inradius);
    assert!((quality[0].aspect_ratio - expected).abs() < 1e-9);
}

#[test]
fn a_sliver_scores_a_small_angle_and_a_large_aspect_ratio() {
    // A square's corners lifted alternately by ±ε: all edges near 1, volume near 0.
    let lift = 0.01;
    let points = [
        0.0, 0.0, -lift, 1.0, 0.0, lift, 1.0, 1.0, -lift, 0.0, 1.0, lift,
    ];
    let quality = tet_quality(&points, &[0, 1, 2, 3]).expect("a valid tet");
    assert!(quality[0].min_dihedral_deg < 5.0);
    assert!(quality[0].aspect_ratio > 20.0);
}

#[test]
fn orientation_does_not_change_the_quality() {
    let points = regular();
    let forward = tet_quality(&points, &[0, 1, 2, 3]).expect("a valid tet");
    let flipped = tet_quality(&points, &[1, 0, 2, 3]).expect("a valid tet");
    assert!((forward[0].min_dihedral_deg - flipped[0].min_dihedral_deg).abs() < 1e-12);
    assert!((forward[0].aspect_ratio - flipped[0].aspect_ratio).abs() < 1e-12);
}

#[test]
fn a_flat_tetrahedron_is_refused() {
    let points = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0];
    assert_eq!(
        tet_quality(&points, &[0, 1, 2, 3]),
        Err(FemError::DegenerateTet { tet: 0 })
    );
}

#[test]
fn an_index_past_the_vertices_is_refused() {
    assert_eq!(
        tet_quality(&regular(), &[0, 1, 2, 4]),
        Err(FemError::VertexOutOfRange {
            tet: 0,
            vertex: 4,
            count: 4
        })
    );
}

#[test]
fn a_ragged_tetrahedron_array_is_refused() {
    assert_eq!(
        tet_quality(&regular(), &[0, 1, 2]),
        Err(FemError::TetArrayLength { len: 3 })
    );
}

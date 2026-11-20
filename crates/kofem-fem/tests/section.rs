// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The result section cut (KOF-390): a plane normal to x, y or z cuts the
//! solid elements into a filled cap and the shell facets into lines, both
//! carrying the nodal field interpolated linearly along the cut edges. A unit
//! cube carrying a linear field makes every area and value exact.

#![allow(
    clippy::expect_used,
    reason = "a cut that fails on valid input should abort the test"
)]

use kofem_fem::{section_cut, FemError, SectionMesh, SectionPlane};

/// Corner `index` of the unit cube at (index & 1, (index >> 1) & 1, (index >> 2) & 1).
fn cube_points() -> Vec<f64> {
    (0..8u32)
        .flat_map(|index| {
            [
                f64::from(index & 1),
                f64::from((index >> 1) & 1),
                f64::from((index >> 2) & 1),
            ]
        })
        .collect()
}

fn field(point: [f64; 3]) -> f64 {
    point[0] + 2.0 * point[1] + 3.0 * point[2]
}

fn cube_values(points: &[f64]) -> Vec<f64> {
    points
        .as_chunks::<3>()
        .0
        .iter()
        .map(|point| field(*point))
        .collect()
}

/// Six tetrahedra about the 0–7 diagonal.
const CUBE_TETS: [u32; 24] = [
    0, 1, 3, 7, 0, 3, 2, 7, 0, 2, 6, 7, 0, 6, 4, 7, 0, 4, 5, 7, 0, 5, 1, 7,
];
/// The same cube as one hexahedron, in the CHEXA order (bottom face, then top).
const CUBE_HEX: [u32; 8] = [0, 1, 3, 2, 4, 5, 7, 6];

/// Every point of a flat x, y, z array.
fn points_of(flat: &[f64]) -> &[[f64; 3]] {
    flat.as_chunks::<3>().0
}

/// Area of the cap and its area-weighted mean normal component along `axis`.
fn cap_area(cut: &kofem_fem::SectionCut, axis: usize) -> (f64, f64) {
    let points = points_of(&cut.cap_points);
    let mut area = 0.0;
    let mut facing = 0.0;
    for triangle in cut.cap_triangles.as_chunks::<3>().0 {
        let [first, second, third] = triangle.map(|corner| points[corner as usize]);
        let along = [0, 1, 2].map(|k| second[k] - first[k]);
        let across = [0, 1, 2].map(|k| third[k] - first[k]);
        let normal = [
            along[1] * across[2] - along[2] * across[1],
            along[2] * across[0] - along[0] * across[2],
            along[0] * across[1] - along[1] * across[0],
        ];
        area += 0.5 * normal.iter().map(|value| value * value).sum::<f64>().sqrt();
        facing += 0.5 * normal[axis];
    }
    (area, facing)
}

#[test]
fn a_cut_through_tetrahedra_fills_the_whole_cross_section() {
    let points = cube_points();
    let values = cube_values(&points);
    for axis in 0..3 {
        let cut = section_cut(
            &SectionMesh {
                points: &points,
                values: &values,
                tets: &CUBE_TETS,
                hexes: &[],
                shell_triangles: &[],
            },
            SectionPlane {
                axis,
                level: 0.3,
                flipped: false,
            },
        )
        .expect("the cube cuts");
        let (area, facing) = cap_area(&cut, axis);
        assert!((area - 1.0).abs() < 1e-12, "axis {axis}: area {area}");
        // Kept below the plane, the cap faces +axis, toward the removed part.
        assert!((facing - 1.0).abs() < 1e-12, "axis {axis}: facing {facing}");
        for (point, value) in points_of(&cut.cap_points).iter().zip(&cut.cap_values) {
            assert!((point[axis] - 0.3).abs() < 1e-12);
            assert!((value - field(*point)).abs() < 1e-12);
        }
    }
}

#[test]
fn flipping_keeps_the_other_side_and_turns_the_cap_round() {
    let points = cube_points();
    let values = cube_values(&points);
    let cut = section_cut(
        &SectionMesh {
            points: &points,
            values: &values,
            tets: &CUBE_TETS,
            hexes: &[],
            shell_triangles: &[],
        },
        SectionPlane {
            axis: 2,
            level: 0.6,
            flipped: true,
        },
    )
    .expect("the cube cuts");
    let (area, facing) = cap_area(&cut, 2);
    assert!((area - 1.0).abs() < 1e-12);
    assert!((facing + 1.0).abs() < 1e-12, "facing {facing}");
}

#[test]
fn a_hexahedron_is_cut_like_the_tetrahedra_it_splits_into() {
    let points = cube_points();
    let values = cube_values(&points);
    let cut = section_cut(
        &SectionMesh {
            points: &points,
            values: &values,
            tets: &[],
            hexes: &CUBE_HEX,
            shell_triangles: &[],
        },
        SectionPlane {
            axis: 1,
            level: 0.45,
            flipped: false,
        },
    )
    .expect("the hexahedron cuts");
    let (area, _) = cap_area(&cut, 1);
    assert!((area - 1.0).abs() < 1e-12, "area {area}");
    for (point, value) in points_of(&cut.cap_points).iter().zip(&cut.cap_values) {
        assert!((value - field(*point)).abs() < 1e-12);
    }
}

#[test]
fn shell_facets_are_cut_into_lines() {
    // The cube's bottom face as two shell facets, cut by x = 0.25.
    let points = cube_points();
    let values = cube_values(&points);
    let cut = section_cut(
        &SectionMesh {
            points: &points,
            values: &values,
            tets: &[],
            hexes: &[],
            shell_triangles: &[0, 1, 3, 0, 3, 2],
        },
        SectionPlane {
            axis: 0,
            level: 0.25,
            flipped: false,
        },
    )
    .expect("the facets cut");
    assert_eq!(cut.cap_triangles, Vec::<u32>::new());
    // Two segments, one per facet, together spanning y = 0 … 1 at x = 0.25.
    assert_eq!(cut.line_points.len(), 2 * 2 * 3);
    let ends = points_of(&cut.line_points);
    let length: f64 = ends
        .as_chunks::<2>()
        .0
        .iter()
        .map(|[start, end]| {
            (0..3)
                .map(|k| (end[k] - start[k]).powi(2))
                .sum::<f64>()
                .sqrt()
        })
        .sum();
    assert!((length - 1.0).abs() < 1e-12, "length {length}");
    for (point, value) in ends.iter().zip(&cut.line_values) {
        assert!((point[0] - 0.25).abs() < 1e-12);
        assert!((value - field(*point)).abs() < 1e-12);
    }
}

#[test]
fn a_plane_that_misses_the_model_cuts_nothing() {
    let points = cube_points();
    let values = cube_values(&points);
    let cut = section_cut(
        &SectionMesh {
            points: &points,
            values: &values,
            tets: &CUBE_TETS,
            hexes: &[],
            shell_triangles: &[],
        },
        SectionPlane {
            axis: 0,
            level: 2.0,
            flipped: false,
        },
    )
    .expect("a miss is not an error");
    assert_eq!(cut, kofem_fem::SectionCut::default());
}

#[test]
fn malformed_input_is_refused_by_name() {
    let points = cube_points();
    let values = cube_values(&points);
    let mesh = |values: &[f64], tets: &[u32]| {
        section_cut(
            &SectionMesh {
                points: &points,
                values,
                tets,
                hexes: &[],
                shell_triangles: &[],
            },
            SectionPlane {
                axis: 0,
                level: 0.5,
                flipped: false,
            },
        )
    };
    let reason = |error: FemError| error.to_string();
    assert!(
        reason(mesh(&values[..7], &CUBE_TETS).expect_err("short values"))
            .contains("7 values for 8 nodes")
    );
    assert!(
        reason(mesh(&values, &CUBE_TETS[..6]).expect_err("ragged tets")).contains("multiple of 4")
    );
    assert!(reason(mesh(&values, &[0, 1, 2, 9]).expect_err("bad node")).contains("node 9"));
    let bad_axis = section_cut(
        &SectionMesh {
            points: &points,
            values: &values,
            tets: &CUBE_TETS,
            hexes: &[],
            shell_triangles: &[],
        },
        SectionPlane {
            axis: 3,
            level: 0.5,
            flipped: false,
        },
    )
    .expect_err("axis 3");
    assert!(reason(bad_axis).contains("axis"));
}

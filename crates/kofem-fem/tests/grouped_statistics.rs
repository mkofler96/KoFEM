// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Statistics of an element field per group of elements (KOF-496): each
//! group's field is averaged to the nodes over that group's elements only,
//! weighted by element volume, and its max and volume-weighted percentile are
//! taken over that group. A safety factor per body reads them.

use kofem_fem::{grouped_element_statistics, ElementMesh, FemError, GroupStatistics};

/// Two tetrahedra on either side of the shared face 0-1-2.
const POINTS: [f64; 15] = [
    0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, -1.0,
];
const TETS: [u32; 8] = [0, 1, 2, 3, 0, 2, 1, 4];

fn tets(tets: &[u32]) -> ElementMesh<'_> {
    ElementMesh {
        points: &POINTS,
        tets,
        tet_nodes: 4,
        hexes: &[],
        shell_triangles: &[],
        shell_thicknesses: &[],
    }
}

fn close(actual: f64, expected: f64) -> bool {
    (actual - expected).abs() <= 1e-12 * expected.abs().max(1.0)
}

#[test]
fn each_group_is_averaged_over_its_own_elements() {
    let stats = grouped_element_statistics(&tets(&TETS), &[100.0, 50.0], &[0, 1], 2, 0.99).unwrap();
    assert_eq!(stats.len(), 2);
    for (GroupStatistics { max, quantile }, expected) in stats.iter().zip([100.0, 50.0]) {
        assert!(close(*max, expected), "max {max}, expected {expected}");
        assert!(
            close(*quantile, expected),
            "quantile {quantile}, expected {expected}"
        );
    }
}

#[test]
fn one_group_averages_across_the_shared_nodes() {
    // The shared face's nodes take the mean of the two equal-volume elements,
    // and hold the median of the volume.
    let stats = grouped_element_statistics(&tets(&TETS), &[100.0, 50.0], &[0, 0], 1, 0.5).unwrap();
    assert!(close(stats[0].max, 100.0));
    assert!(close(stats[0].quantile, 75.0));
}

#[test]
fn shells_weigh_by_area_times_thickness() {
    // A 100 facet and a 10 facet sharing an edge, the second ten times
    // thicker: the shared nodes, which hold the median of the volume, lean
    // towards 10.
    let points = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0];
    let mesh = ElementMesh {
        points: &points,
        tets: &[],
        tet_nodes: 4,
        hexes: &[],
        shell_triangles: &[0, 1, 2, 1, 3, 2],
        shell_thicknesses: &[1.0, 10.0],
    };
    let stats = grouped_element_statistics(&mesh, &[100.0, 10.0], &[0, 0], 1, 0.5).unwrap();
    assert!(close(stats[0].max, 100.0));
    assert!(close(stats[0].quantile, (100.0 + 10.0 * 10.0) / 11.0));
}

#[test]
fn refuses_a_value_count_other_than_the_element_count() {
    let error = grouped_element_statistics(&tets(&TETS), &[100.0], &[0, 1], 2, 0.99).unwrap_err();
    assert!(matches!(error, FemError::StatisticsInput { .. }), "{error}");
}

#[test]
fn refuses_a_group_outside_the_group_count() {
    let error =
        grouped_element_statistics(&tets(&TETS), &[100.0, 50.0], &[0, 2], 2, 0.99).unwrap_err();
    assert!(error.to_string().contains("group 2"), "{error}");
}

#[test]
fn refuses_a_group_without_elements() {
    let error =
        grouped_element_statistics(&tets(&TETS), &[100.0, 50.0], &[0, 0], 2, 0.99).unwrap_err();
    assert!(
        error.to_string().contains("group 1 has no elements"),
        "{error}"
    );
}

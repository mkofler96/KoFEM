// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Volume-weighted percentiles of a nodal field (KOF-477): the value below
//! which a given share of the model's volume lies.

use kofem_fem::{nodal_percentiles, FemError, StatisticsMesh};

/// A unit cube as one hexahedron, its corners in CHEXA order.
const CUBE: [f64; 24] = [
    0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, //
    0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 1.0, 1.0,
];

fn mesh<'a>(points: &'a [f64], values: &'a [f64]) -> StatisticsMesh<'a> {
    StatisticsMesh {
        points,
        values,
        tets: &[],
        tet_nodes: 4,
        hexes: &[],
        shell_triangles: &[],
        shell_thicknesses: &[],
    }
}

#[test]
fn a_uniform_field_has_every_percentile_at_its_value() {
    let values = [100.0; 8];
    let hexes: Vec<u32> = (0..8).collect();
    let input = StatisticsMesh {
        hexes: &hexes,
        ..mesh(&CUBE, &values)
    };
    let percentiles = nodal_percentiles(&input, &[0.0, 0.5, 0.95, 0.99, 1.0]).unwrap();
    assert_eq!(percentiles, vec![100.0; 5]);
}

#[test]
fn a_finely_meshed_peak_does_not_outweigh_the_volume_around_it() {
    // A big tetrahedron at 10 and a tiny one sharing no node at 1000: by node
    // count half the nodes sit at the peak, by volume almost none of it does.
    let points = [
        0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0, //
        20.0, 0.0, 0.0, 20.1, 0.0, 0.0, 20.0, 0.1, 0.0, 20.0, 0.0, 0.1,
    ];
    let values = [10.0, 10.0, 10.0, 10.0, 1000.0, 1000.0, 1000.0, 1000.0];
    let tets = [0, 1, 2, 3, 4, 5, 6, 7];
    let input = StatisticsMesh {
        tets: &tets,
        ..mesh(&points, &values)
    };
    let percentiles = nodal_percentiles(&input, &[0.5, 0.95, 0.99, 1.0]).unwrap();
    assert_eq!(percentiles, vec![10.0, 10.0, 10.0, 1000.0]);
}

#[test]
fn the_percentile_is_the_lowest_value_with_that_share_of_volume_at_or_below_it() {
    // Two equal tetrahedra sharing no node: one at 1, one at 2. Half the volume
    // is at or below 1, so the median is 1 and anything higher is 2.
    let points = [
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, //
        5.0, 0.0, 0.0, 6.0, 0.0, 0.0, 5.0, 1.0, 0.0, 5.0, 0.0, 1.0,
    ];
    let values = [1.0, 1.0, 1.0, 1.0, 2.0, 2.0, 2.0, 2.0];
    let tets = [0, 1, 2, 3, 4, 5, 6, 7];
    let input = StatisticsMesh {
        tets: &tets,
        ..mesh(&points, &values)
    };
    let percentiles = nodal_percentiles(&input, &[0.0, 0.5, 0.51, 1.0]).unwrap();
    assert_eq!(percentiles, vec![1.0, 1.0, 2.0, 2.0]);
}

#[test]
fn quadratic_tetrahedra_share_their_volume_among_all_ten_nodes() {
    // One straight-sided quadratic tetrahedron: the midside nodes carry the
    // peak, 6 of 10 nodes, so 60 % of the volume.
    let points = [
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, //
        0.5, 0.0, 0.0, 0.5, 0.5, 0.0, 0.0, 0.5, 0.0, 0.0, 0.0, 0.5, 0.5, 0.0, 0.5, 0.0, 0.5, 0.5,
    ];
    let values = [1.0, 1.0, 1.0, 1.0, 9.0, 9.0, 9.0, 9.0, 9.0, 9.0];
    let tets: Vec<u32> = (0..10).collect();
    let input = StatisticsMesh {
        tets: &tets,
        tet_nodes: 10,
        ..mesh(&points, &values)
    };
    let percentiles = nodal_percentiles(&input, &[0.4, 0.41]).unwrap();
    assert_eq!(percentiles, vec![1.0, 9.0]);
}

#[test]
fn shell_facets_weigh_their_area_times_thickness_against_solid_volume() {
    // A unit cube at 1 (volume 1) and a shell facet at 5 of area 2 and
    // thickness 0.5 (volume 1): half the volume each.
    let mut points = CUBE.to_vec();
    points.extend_from_slice(&[5.0, 0.0, 0.0, 7.0, 0.0, 0.0, 5.0, 2.0, 0.0]);
    let mut values = vec![1.0; 8];
    values.extend_from_slice(&[5.0, 5.0, 5.0]);
    let hexes: Vec<u32> = (0..8).collect();
    let input = StatisticsMesh {
        hexes: &hexes,
        shell_triangles: &[8, 9, 10],
        shell_thicknesses: &[0.5],
        ..mesh(&points, &values)
    };
    let percentiles = nodal_percentiles(&input, &[0.5, 0.51]).unwrap();
    assert_eq!(percentiles, vec![1.0, 5.0]);
}

#[test]
fn nodes_no_element_uses_are_left_out() {
    let mut points = CUBE.to_vec();
    points.extend_from_slice(&[9.0, 9.0, 9.0]);
    let mut values = vec![3.0; 8];
    values.push(1e9);
    let hexes: Vec<u32> = (0..8).collect();
    let input = StatisticsMesh {
        hexes: &hexes,
        ..mesh(&points, &values)
    };
    assert_eq!(nodal_percentiles(&input, &[1.0]).unwrap(), vec![3.0]);
}

#[test]
fn inconsistent_input_is_refused() {
    let values = [1.0; 8];
    let hexes: Vec<u32> = (0..8).collect();
    let good = StatisticsMesh {
        hexes: &hexes,
        ..mesh(&CUBE, &values)
    };
    let refused = |input: &StatisticsMesh, quantiles: &[f64]| {
        matches!(
            nodal_percentiles(input, quantiles),
            Err(FemError::StatisticsInput { .. })
        )
    };
    assert!(refused(&good, &[1.5]));
    assert!(refused(&good, &[f64::NAN]));
    assert!(refused(
        &StatisticsMesh {
            values: &values[..7],
            ..good
        },
        &[0.5]
    ));
    assert!(refused(
        &StatisticsMesh {
            hexes: &[0, 1, 2, 3, 4, 5, 6, 99],
            ..good
        },
        &[0.5]
    ));
    assert!(refused(
        &StatisticsMesh {
            shell_triangles: &[0, 1, 2],
            shell_thicknesses: &[],
            ..good
        },
        &[0.5]
    ));
    assert!(refused(
        &StatisticsMesh {
            tet_nodes: 5,
            ..good
        },
        &[0.5]
    ));
    assert!(refused(&mesh(&CUBE, &values), &[0.5]));
}

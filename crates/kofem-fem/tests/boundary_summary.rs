// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! What a support or load group card says it applies (KOF-494): the area of
//! its CAD faces, each counted once, and a load's total and mean traction.

#![allow(
    clippy::expect_used,
    reason = "a fixture that fails should abort the test"
)]

use kofem_fem::{force_summary, moment_summary, pressure_summary, selected_area, FemError};

// The axial-bar example's CAD face areas: four 1000 × 100 mm sides and the
// two 100 × 100 mm ends (faces 2 and 4).
const BAR: [f64; 6] = [1.0e5, 1.0e4, 1.0e5, 1.0e4, 1.0e5, 1.0e5];

fn close(value: f64, expected: f64) -> bool {
    (value - expected).abs() <= 1e-12 * expected.abs().max(1.0)
}

#[test]
fn the_area_of_one_face_is_its_cad_area() {
    let area = selected_area(&BAR, &[2]).expect("area");
    assert!(close(area.area, 1.0e4));
    assert_eq!(area.faces, 1);
    assert_eq!(area.repeated, Vec::<u32>::new());
}

#[test]
fn several_faces_add_up() {
    let area = selected_area(&BAR, &[2, 1, 4]).expect("area");
    assert!(close(area.area, 1.2e5));
    assert_eq!(area.faces, 3);
}

#[test]
fn a_face_selected_twice_is_counted_once_and_named() {
    let area = selected_area(&BAR, &[2, 4, 2, 2]).expect("area");
    assert!(close(area.area, 2.0e4));
    assert_eq!(area.faces, 2);
    assert_eq!(area.repeated, vec![2]);
}

#[test]
fn no_face_is_refused_rather_than_zero_area() {
    assert!(matches!(
        selected_area(&BAR, &[]),
        Err(FemError::BoundarySummary { .. })
    ));
}

#[test]
fn a_face_the_geometry_does_not_have_is_refused() {
    assert!(matches!(
        selected_area(&BAR, &[7]),
        Err(FemError::BoundarySummary { .. })
    ));
    assert!(matches!(
        selected_area(&BAR, &[0]),
        Err(FemError::BoundarySummary { .. })
    ));
}

#[test]
fn a_face_without_a_positive_finite_area_is_refused() {
    assert!(matches!(
        selected_area(&[1.0, f64::NAN], &[2]),
        Err(FemError::BoundarySummary { .. })
    ));
    assert!(matches!(
        selected_area(&[0.0], &[1]),
        Err(FemError::BoundarySummary { .. })
    ));
}

#[test]
fn a_force_is_spread_over_the_area_as_its_mean_traction() {
    // The axial bar: 1 MN on the 100 × 100 mm end is 100 MPa.
    let summary = force_summary([1.0e6, 0.0, 0.0], Some(1.0e4))
        .expect("summary")
        .expect("a value");
    assert!(close(summary.total, 1.0e6));
    assert!(close(summary.mean_traction.expect("traction"), 100.0));
}

#[test]
fn a_force_total_is_the_magnitude_of_its_components() {
    // 3-4-12 gives 13.
    let summary = force_summary([3.0, -4.0, 12.0], Some(2.0))
        .expect("summary")
        .expect("a value");
    assert!(close(summary.total, 13.0));
    assert!(close(summary.mean_traction.expect("traction"), 6.5));
}

#[test]
fn a_force_on_an_area_not_known_keeps_its_total() {
    let summary = force_summary([0.0, -500.0, 0.0], None)
        .expect("summary")
        .expect("a value");
    assert_eq!(summary.total, 500.0);
    assert_eq!(summary.mean_traction, None);
}

#[test]
fn a_pressure_totals_to_pressure_times_area() {
    // 10 MPa on 149 mm² pushes with 1,490 N.
    let summary = pressure_summary(10.0, Some(149.0))
        .expect("summary")
        .expect("a value");
    assert_eq!(summary.pressure, 10.0);
    assert!(close(summary.total.expect("total"), 1490.0));
}

#[test]
fn a_negative_pressure_pulls_with_a_negative_total() {
    let summary = pressure_summary(-2.0, Some(50.0))
        .expect("summary")
        .expect("a value");
    assert!(close(summary.total.expect("total"), -100.0));
}

#[test]
fn a_pressure_on_an_area_not_known_has_no_total() {
    let summary = pressure_summary(3.0, None)
        .expect("summary")
        .expect("a value");
    assert_eq!(summary.total, None);
}

#[test]
fn a_moment_on_one_face_is_its_magnitude() {
    let summary = moment_summary([0.0, 0.0, -1000.0], 1, Some(1.0e4))
        .expect("summary")
        .expect("a value");
    assert!(close(summary.each, 1000.0));
    assert!(close(summary.total, 1000.0));
}

#[test]
fn a_moment_on_several_faces_totals_once_per_face() {
    // The solve applies a moment group's full vector to each of its face
    // selections (momentToNodalForces), so two faces carry it twice.
    let summary = moment_summary([0.0, 0.0, 1000.0], 2, Some(2.0e4))
        .expect("summary")
        .expect("a value");
    assert_eq!(summary.applied, 2);
    assert!(close(summary.total, 2000.0));
}

#[test]
fn a_load_of_zero_has_no_value_rather_than_0_n() {
    assert_eq!(force_summary([0.0; 3], Some(1.0)).expect("summary"), None);
    assert_eq!(
        moment_summary([0.0; 3], 1, Some(1.0)).expect("summary"),
        None
    );
    assert_eq!(pressure_summary(0.0, Some(1.0)).expect("summary"), None);
}

#[test]
fn a_value_that_is_not_finite_is_refused() {
    assert!(matches!(
        force_summary([f64::NAN, 0.0, 1.0], Some(1.0)),
        Err(FemError::BoundarySummary { .. })
    ));
    assert!(matches!(
        pressure_summary(f64::INFINITY, None),
        Err(FemError::BoundarySummary { .. })
    ));
}

#[test]
fn an_area_that_is_not_positive_is_refused() {
    for area in [0.0, -1.0, f64::INFINITY] {
        assert!(matches!(
            pressure_summary(1.0, Some(area)),
            Err(FemError::BoundarySummary { .. })
        ));
    }
}

#[test]
fn a_moment_applied_nowhere_is_refused() {
    assert!(matches!(
        moment_summary([0.0, 0.0, 1000.0], 0, Some(1.0)),
        Err(FemError::BoundarySummary { .. })
    ));
}

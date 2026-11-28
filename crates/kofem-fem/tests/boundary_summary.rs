// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! What a support or load group card says it applies (KOF-494): the area of
//! its CAD faces, each counted once, and a load's total and mean traction.

#![allow(
    clippy::expect_used,
    reason = "a fixture that fails should abort the test"
)]

use kofem_fem::{load_summary, selected_area, FemError, LoadValue};

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
    let summary = load_summary(LoadValue::Force([1.0e6, 0.0, 0.0]), Some(1.0e4)).expect("summary");
    assert!(close(summary.total.expect("total"), 1.0e6));
    assert!(close(summary.mean_traction.expect("traction"), 100.0));
}

#[test]
fn a_force_total_is_the_magnitude_of_its_components() {
    // 3-4-12 gives 13.
    let summary = load_summary(LoadValue::Force([3.0, -4.0, 12.0]), Some(2.0)).expect("summary");
    assert!(close(summary.total.expect("total"), 13.0));
    assert!(close(summary.mean_traction.expect("traction"), 6.5));
}

#[test]
fn a_pressure_totals_to_pressure_times_area() {
    // 10 MPa on 149 mm² pushes with 1,490 N.
    let summary = load_summary(LoadValue::Pressure(10.0), Some(149.0)).expect("summary");
    assert!(close(summary.total.expect("total"), 1490.0));
    assert!(close(summary.mean_traction.expect("traction"), 10.0));
}

#[test]
fn a_negative_pressure_pulls_with_a_negative_total() {
    let summary = load_summary(LoadValue::Pressure(-2.0), Some(50.0)).expect("summary");
    assert!(close(summary.total.expect("total"), -100.0));
}

#[test]
fn a_moment_has_a_total_but_no_traction() {
    let summary =
        load_summary(LoadValue::Moment([0.0, 0.0, -1000.0]), Some(1.0e4)).expect("summary");
    assert!(close(summary.total.expect("total"), 1000.0));
    assert_eq!(summary.mean_traction, None);
}

#[test]
fn a_load_without_a_value_is_refused_rather_than_zero() {
    for value in [
        LoadValue::Force([0.0; 3]),
        LoadValue::Moment([0.0; 3]),
        LoadValue::Pressure(0.0),
        LoadValue::Force([f64::NAN, 0.0, 1.0]),
    ] {
        assert!(matches!(
            load_summary(value, Some(1.0)),
            Err(FemError::BoundarySummary { .. })
        ));
    }
}

#[test]
fn an_area_that_is_not_positive_is_refused() {
    for area in [0.0, -1.0, f64::INFINITY] {
        assert!(matches!(
            load_summary(LoadValue::Pressure(1.0), Some(area)),
            Err(FemError::BoundarySummary { .. })
        ));
    }
}

#[test]
fn a_force_on_an_area_not_known_keeps_its_total() {
    let summary = load_summary(LoadValue::Force([0.0, -500.0, 0.0]), None).expect("summary");
    assert_eq!(summary.total, Some(500.0));
    assert_eq!(summary.mean_traction, None);
}

#[test]
fn a_pressure_on_an_area_not_known_has_no_total() {
    let summary = load_summary(LoadValue::Pressure(3.0), None).expect("summary");
    assert_eq!(summary.total, None);
    assert_eq!(summary.mean_traction, Some(3.0));
}

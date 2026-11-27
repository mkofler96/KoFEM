// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

use kofem_fem::extremum::{largest, smallest};

#[test]
fn largest_and_smallest_of_finite_values() {
    assert_eq!(largest(0.0, [3.0, -7.0, 5.0]), 5.0);
    assert_eq!(smallest(f64::INFINITY, [3.0, -7.0, 5.0]), -7.0);
}

#[test]
fn the_start_value_bounds_the_result() {
    assert_eq!(largest(10.0, [3.0, 5.0]), 10.0);
    assert_eq!(smallest(-1.0, [3.0, 5.0]), -1.0);
}

#[test]
fn no_values_give_the_start_value() {
    assert_eq!(largest(0.0, []), 0.0);
    assert_eq!(smallest(f64::INFINITY, []), f64::INFINITY);
}

#[test]
fn a_nan_anywhere_gives_nan() {
    assert!(largest(0.0, [f64::NAN, 1.0]).is_nan());
    assert!(largest(0.0, [1.0, f64::NAN]).is_nan());
    assert!(largest(f64::NAN, [1.0]).is_nan());
    assert!(smallest(f64::INFINITY, [f64::NAN, 1.0]).is_nan());
    assert!(smallest(f64::INFINITY, [1.0, f64::NAN]).is_nan());
}

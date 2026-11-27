// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The numbers of the analysis report (KOF-391): the largest displacement and
//! the largest and 99th-percentile von Mises stress of the nodal fields the
//! app draws.

#![allow(
    clippy::expect_used,
    reason = "a fixture that fails should abort the test"
)]

use kofem_fem::{percentile, report_stats, FemError};

#[test]
fn percentile_interpolates_between_ranks() {
    // Sorted 1..=101: the p-th percentile of n + 1 evenly spaced values is
    // the value at rank p·n.
    let values: Vec<f64> = (1..=101).rev().map(f64::from).collect();
    assert_eq!(percentile(&values, 99.0).expect("percentile"), 100.0);
    assert_eq!(percentile(&values, 50.0).expect("percentile"), 51.0);
    assert_eq!(percentile(&values, 100.0).expect("percentile"), 101.0);
    assert_eq!(percentile(&values, 0.0).expect("percentile"), 1.0);
    // Between ranks: 0.99 · 3 = 2.97 between 30 and 40.
    let four = [10.0, 40.0, 20.0, 30.0];
    assert!((percentile(&four, 99.0).expect("percentile") - 39.7).abs() < 1e-12);
}

#[test]
fn percentile_of_one_value_is_that_value() {
    assert_eq!(percentile(&[7.5], 99.0).expect("percentile"), 7.5);
}

#[test]
fn percentile_refuses_what_has_none() {
    assert_eq!(
        percentile(&[], 99.0),
        Err(FemError::ReportField {
            reason: "the field has no values".into()
        })
    );
    assert!(matches!(
        percentile(&[1.0, f64::NAN], 99.0),
        Err(FemError::ReportField { .. })
    ));
    assert!(matches!(
        percentile(&[1.0], 101.0),
        Err(FemError::ReportField { .. })
    ));
}

#[test]
fn report_stats_reads_the_peaks_and_the_percentile() {
    // Three nodes: |u| = 1, 5 (3-4-0) and 2.
    let displacements = [1.0, 0.0, 0.0, 3.0, -4.0, 0.0, 0.0, 0.0, 2.0];
    let von_mises: Vec<f64> = (0..=100).map(f64::from).collect();
    let stats = report_stats(&displacements, &von_mises).expect("stats");
    assert_eq!(stats.max_displacement, 5.0);
    assert_eq!(stats.max_displacement_node, 1);
    assert_eq!(stats.max_von_mises, 100.0);
    assert!((stats.p99_von_mises - 99.0).abs() < 1e-12);
}

#[test]
fn report_stats_refuses_a_broken_displacement_field() {
    assert!(matches!(
        report_stats(&[1.0, 2.0], &[1.0]),
        Err(FemError::ReportField { .. })
    ));
    assert!(matches!(
        report_stats(&[], &[1.0]),
        Err(FemError::ReportField { .. })
    ));
    assert!(matches!(
        report_stats(&[f64::INFINITY, 0.0, 0.0], &[1.0]),
        Err(FemError::ReportField { .. })
    ));
}

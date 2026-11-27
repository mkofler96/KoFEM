// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Where a nodal field peaks, and whether the peak sits on a support or load
//! selection (KOF-495): a peak on one is usually the idealisation's
//! singularity, not a stress the part sees.

use kofem_fem::{field_peak, FemError, PeakInput};

/// Four nodes along x at 0, 10, 20 and 30 mm.
const POINTS: [f64; 12] = [
    0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 20.0, 0.0, 0.0, 30.0, 0.0, 0.0,
];

fn input<'a>(
    values: &'a [f64],
    selection_offsets: &'a [u32],
    selection_nodes: &'a [u32],
) -> PeakInput<'a> {
    PeakInput {
        points: &POINTS,
        values,
        selection_offsets,
        selection_nodes,
    }
}

#[test]
fn locates_the_node_with_the_largest_value() {
    let peak = field_peak(&input(&[1.0, 5.0, 3.0, 2.0], &[0], &[])).unwrap();
    assert_eq!(peak.node, 1);
    assert_eq!(peak.at, [10.0, 0.0, 0.0]);
    assert_eq!(peak.value, 5.0);
    assert_eq!(peak.selections, Vec::<usize>::new());
}

#[test]
fn a_tie_takes_the_first_node_as_the_min_and_max_rows_do() {
    let peak = field_peak(&input(&[1.0, 4.0, 4.0, 2.0], &[0], &[])).unwrap();
    assert_eq!(peak.node, 1);
}

#[test]
fn names_every_selection_that_holds_the_peak_node() {
    // Selection 0 (a support) holds nodes 0 and 1; selection 1 (a load)
    // holds node 3; selection 2 holds nodes 1 and 2.
    let offsets = [0, 2, 3, 5];
    let nodes = [0, 1, 3, 1, 2];
    let peak = field_peak(&input(&[1.0, 5.0, 3.0, 2.0], &offsets, &nodes)).unwrap();
    assert_eq!(peak.selections, vec![0, 2]);
}

#[test]
fn a_peak_off_every_selection_names_none() {
    let offsets = [0, 2, 3];
    let nodes = [0, 1, 3];
    let peak = field_peak(&input(&[1.0, 2.0, 9.0, 2.0], &offsets, &nodes)).unwrap();
    assert_eq!(peak.node, 2);
    assert_eq!(peak.selections, Vec::<usize>::new());
}

#[test]
fn an_empty_selection_holds_nothing() {
    let offsets = [0, 0, 1];
    let nodes = [1];
    let peak = field_peak(&input(&[1.0, 5.0, 3.0, 2.0], &offsets, &nodes)).unwrap();
    assert_eq!(peak.selections, vec![1]);
}

fn refusal(result: Result<kofem_fem::FieldPeak, FemError>) -> String {
    match result {
        Err(FemError::StatisticsInput { reason }) => reason,
        // Fails every `contains` check below, and shows what came back.
        other => format!("not a statistics input error: {other:?}"),
    }
}

#[test]
fn refuses_a_field_without_nodes() {
    let reason = refusal(field_peak(&PeakInput {
        points: &[],
        values: &[],
        selection_offsets: &[0],
        selection_nodes: &[],
    }));
    assert!(reason.contains("no nodes"), "{reason}");
}

#[test]
fn refuses_a_value_count_that_differs_from_the_node_count() {
    let reason = refusal(field_peak(&input(&[1.0, 2.0], &[0], &[])));
    assert!(reason.contains("2 values for 4 nodes"), "{reason}");
}

#[test]
fn refuses_a_non_finite_value() {
    let reason = refusal(field_peak(&input(&[1.0, f64::NAN, 3.0, 2.0], &[0], &[])));
    assert!(reason.contains("node 1"), "{reason}");
}

#[test]
fn refuses_offsets_that_do_not_start_at_zero_or_end_at_the_node_list() {
    let reason = refusal(field_peak(&input(&[1.0; 4], &[1, 2], &[0, 1])));
    assert!(reason.contains("start at 0"), "{reason}");
    let reason = refusal(field_peak(&input(&[1.0; 4], &[0, 1], &[0, 1])));
    assert!(reason.contains("end at 2"), "{reason}");
    let reason = refusal(field_peak(&input(&[1.0; 4], &[], &[])));
    assert!(reason.contains("start at 0"), "{reason}");
}

#[test]
fn refuses_decreasing_offsets() {
    let reason = refusal(field_peak(&input(&[1.0; 4], &[0, 2, 1, 2], &[0, 1])));
    assert!(reason.contains("decrease"), "{reason}");
}

#[test]
fn refuses_a_selection_on_a_node_the_model_does_not_have() {
    let reason = refusal(field_peak(&input(&[1.0; 4], &[0, 1], &[7])));
    assert!(reason.contains("node 7"), "{reason}");
}

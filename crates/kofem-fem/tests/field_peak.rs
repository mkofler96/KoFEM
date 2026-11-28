// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Where a nodal field peaks, and which idealised supports and loads sit on
//! that node (KOF-495): a peak on one is usually the idealisation's
//! singularity, not a stress the part sees.

use kofem_fem::{
    field_peak, BoundaryGroup, Condition, CouplingSurface, FemError, FieldPeak, PeakInput,
    PickGeometry, Selection,
};

/// Five nodes along x at 0, 10, 20, 30 and 40 mm; node 4 stands for a
/// coupling's reference point.
const POINTS: [f64; 15] = [
    0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 20.0, 0.0, 0.0, 30.0, 0.0, 0.0, 40.0, 0.0, 0.0,
];
/// Peaks at node 2.
const VALUES: [f64; 5] = [1.0, 2.0, 9.0, 3.0, 0.0];

const CLAMP: [u32; 3] = [0, 1, 2];

fn selection(geometry: PickGeometry, nodes: &[u32]) -> Selection {
    Selection {
        geometry,
        nodes: nodes.to_vec(),
    }
}

fn support(dofs: &[u32], selections: Vec<Selection>) -> BoundaryGroup {
    BoundaryGroup {
        condition: Condition::Support {
            dofs: dofs.to_vec(),
        },
        selections,
    }
}

fn load(selections: Vec<Selection>) -> BoundaryGroup {
    BoundaryGroup {
        condition: Condition::Load,
        selections,
    }
}

fn peak_on(groups: &[BoundaryGroup], shell_triangles: &[u32]) -> Result<FieldPeak, FemError> {
    peak_with(groups, shell_triangles, &[])
}

fn peak_with(
    groups: &[BoundaryGroup],
    shell_triangles: &[u32],
    couplings: &[CouplingSurface],
) -> Result<FieldPeak, FemError> {
    field_peak(&PeakInput {
        points: &POINTS,
        values: &VALUES,
        shell_triangles,
        groups,
        couplings,
    })
}

const NONE: Vec<usize> = Vec::new();

#[test]
fn locates_the_node_with_the_largest_value() {
    let peak = peak_on(&[], &[]).unwrap();
    assert_eq!(peak.node, 2);
    assert_eq!(peak.at, [20.0, 0.0, 0.0]);
    assert_eq!(peak.value, 9.0);
    assert_eq!(peak.idealised, NONE);
}

#[test]
fn a_tie_takes_the_first_node_as_the_min_and_max_rows_do() {
    let peak = field_peak(&PeakInput {
        points: &POINTS,
        values: &[1.0, 4.0, 4.0, 2.0, 0.0],
        shell_triangles: &[],
        groups: &[],
        couplings: &[],
    })
    .unwrap();
    assert_eq!(peak.node, 1);
}

#[test]
fn a_support_holding_every_translation_on_the_peak_is_named() {
    let face = || vec![selection(PickGeometry::Face, &[1, 2])];
    let groups = [
        support(&[0, 1], face()),
        support(&CLAMP, vec![selection(PickGeometry::Face, &[0])]),
        support(&CLAMP, face()),
    ];
    assert_eq!(peak_on(&groups, &[]).unwrap().idealised, vec![2]);
}

#[test]
fn a_symmetry_support_and_a_face_load_on_the_peak_are_real_stresses() {
    // Symmetry on x: Ux and the rotations Ry, Rz held, Uy and Uz free.
    let groups = [
        support(&[0, 4, 5], vec![selection(PickGeometry::Face, &[2, 3])]),
        load(vec![selection(PickGeometry::Face, &[1, 2])]),
    ];
    assert_eq!(peak_on(&groups, &[]).unwrap().idealised, NONE);
}

#[test]
fn a_support_or_load_on_a_point_is_named() {
    let groups = [
        support(&[2], vec![selection(PickGeometry::Point, &[2])]),
        load(vec![
            selection(PickGeometry::Face, &[0, 1]),
            selection(PickGeometry::Point, &[2]),
        ]),
    ];
    assert_eq!(peak_on(&groups, &[]).unwrap().idealised, vec![0, 1]);
}

#[test]
fn a_support_on_an_edge_of_a_solid_holds_a_line_and_is_named() {
    let groups = [support(&[2], vec![selection(PickGeometry::Edge, &[2, 3])])];
    assert_eq!(peak_on(&groups, &[]).unwrap().idealised, vec![0]);
}

#[test]
fn an_edge_of_a_shell_is_its_boundary_not_a_line() {
    let groups = [
        support(&[0, 2, 4, 5], vec![selection(PickGeometry::Edge, &[2, 3])]),
        load(vec![selection(PickGeometry::Edge, &[2, 3])]),
    ];
    assert_eq!(peak_on(&groups, &[1, 2, 3]).unwrap().idealised, NONE);
}

#[test]
fn a_selection_saved_before_its_pick_was_recorded_reads_as_a_face() {
    let groups = [support(
        &[2],
        vec![selection(PickGeometry::Unrecorded, &[2])],
    )];
    assert_eq!(peak_on(&groups, &[]).unwrap().idealised, NONE);
}

#[test]
fn a_support_on_a_couplings_reference_point_holds_the_coupled_surface() {
    let coupling = [CouplingSurface {
        reference: 4,
        nodes: vec![2, 3],
    }];
    let groups = [support(&CLAMP, vec![selection(PickGeometry::Point, &[4])])];
    let peak = peak_with(&groups, &[], &coupling).unwrap();
    assert_eq!(peak.idealised, vec![0]);
}

#[test]
fn a_load_on_a_couplings_reference_point_is_spread_over_the_surface() {
    let coupling = [CouplingSurface {
        reference: 4,
        nodes: vec![2, 3],
    }];
    let groups = [load(vec![selection(PickGeometry::Point, &[4])])];
    let peak = peak_with(&groups, &[], &coupling).unwrap();
    assert_eq!(peak.idealised, NONE);
}

#[test]
fn a_peak_off_every_group_names_none() {
    let groups = [
        support(&CLAMP, vec![selection(PickGeometry::Face, &[0])]),
        load(vec![selection(PickGeometry::Point, &[3])]),
    ];
    assert_eq!(peak_on(&groups, &[]).unwrap().idealised, NONE);
}

fn refusal(result: Result<FieldPeak, FemError>) -> String {
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
        shell_triangles: &[],
        groups: &[],
        couplings: &[],
    }));
    assert!(reason.contains("no nodes"), "{reason}");
}

#[test]
fn refuses_a_value_count_that_differs_from_the_node_count() {
    let reason = refusal(field_peak(&PeakInput {
        points: &POINTS,
        values: &[1.0, 2.0],
        shell_triangles: &[],
        groups: &[],
        couplings: &[],
    }));
    assert!(reason.contains("2 values for 5 nodes"), "{reason}");
}

#[test]
fn refuses_a_non_finite_value() {
    let reason = refusal(field_peak(&PeakInput {
        points: &POINTS,
        values: &[1.0, f64::NAN, 3.0, 2.0, 0.0],
        shell_triangles: &[],
        groups: &[],
        couplings: &[],
    }));
    assert!(reason.contains("node 1"), "{reason}");
}

#[test]
fn refuses_a_selection_on_a_node_the_model_does_not_have() {
    let groups = [load(vec![selection(PickGeometry::Point, &[7])])];
    let reason = refusal(peak_with(&groups, &[], &[]));
    assert!(reason.contains("node 7"), "{reason}");
}

#[test]
fn refuses_a_dof_outside_the_six_of_a_node() {
    let groups = [support(&[6], vec![selection(PickGeometry::Face, &[0])])];
    let reason = refusal(peak_with(&groups, &[], &[]));
    assert!(reason.contains("dof 6"), "{reason}");
}

#[test]
fn refuses_ragged_or_unknown_shell_facets() {
    let reason = refusal(peak_with(&[], &[0, 1], &[]));
    assert!(reason.contains("multiple of 3"), "{reason}");
    let reason = refusal(peak_with(&[], &[0, 1, 9], &[]));
    assert!(reason.contains("node 9"), "{reason}");
}

#[test]
fn refuses_a_coupling_on_a_node_the_model_does_not_have() {
    let coupling = [CouplingSurface {
        reference: 8,
        nodes: vec![2],
    }];
    let reason = refusal(peak_with(&[], &[], &coupling));
    assert!(reason.contains("node 8"), "{reason}");
}

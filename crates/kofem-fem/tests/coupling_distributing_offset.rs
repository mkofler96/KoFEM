// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! A distributing (RBE3) coupling whose reference point is not at the
//! weighted centroid of its coupled nodes (KOF-410): a bolt load at the end
//! of a bore's axis, or a remote point typed in as coordinates.
//!
//! The reference node's equations must reproduce a rigid motion of the
//! coupled nodes exactly, measured at the reference point, and — by the
//! transpose — spread a force or moment at the point as nodal loads that are
//! statically equivalent to it.

#![allow(
    clippy::expect_used,
    reason = "a fixture that fails to build should abort the test"
)]

use kofem_fem::{Coupling, CouplingConstraints, CouplingKind, DOFS_PER_NODE};

/// An irregular patch on the plane x = 0 with unequal weights, so neither
/// the centroid nor the inertia has any symmetry to hide behind, and a
/// reference point well away from the centroid, off the patch's plane.
const PATCH: [[f64; 3]; 6] = [
    [0.0, 0.0, 0.0],
    [0.0, 4.0, 0.5],
    [0.0, 1.0, 3.0],
    [0.0, 5.0, 4.0],
    [0.0, -2.0, 2.5],
    [0.0, 2.5, -1.5],
];
const WEIGHTS: [f64; 6] = [1.0, 2.0, 0.5, 1.5, 3.0, 0.75];
const REFERENCE: [f64; 3] = [7.0, -3.0, 9.0];

fn cross(lhs: [f64; 3], rhs: [f64; 3]) -> [f64; 3] {
    [
        lhs[1] * rhs[2] - lhs[2] * rhs[1],
        lhs[2] * rhs[0] - lhs[0] * rhs[2],
        lhs[0] * rhs[1] - lhs[1] * rhs[0],
    ]
}

fn sub(lhs: [f64; 3], rhs: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|axis| lhs[axis] - rhs[axis])
}

/// The patch nodes, then the reference node, and the coupling between them.
fn offset_coupling() -> (Vec<[f64; 3]>, CouplingConstraints, usize) {
    let mut points = PATCH.to_vec();
    points.push(REFERENCE);
    let reference = PATCH.len();
    let mut has_rotation = vec![false; points.len()];
    has_rotation[reference] = true;
    let coupling = Coupling {
        reference,
        nodes: (0..PATCH.len()).collect(),
        weights: WEIGHTS.to_vec(),
        kind: CouplingKind::Distributing,
    };
    let constraints = CouplingConstraints::build(&points, &[coupling], &has_rotation)
        .expect("the coupling builds");
    (points, constraints, reference)
}

/// The weighted centroid of the patch.
fn centroid() -> [f64; 3] {
    let total: f64 = WEIGHTS.iter().sum();
    let mut out = [0.0; 3];
    for (point, weight) in PATCH.iter().zip(WEIGHTS) {
        for axis in 0..3 {
            out[axis] += weight / total * point[axis];
        }
    }
    out
}

/// The reference node's six DOFs evaluated from the given nodal values.
fn reference_motion(
    constraints: &CouplingConstraints,
    reference: usize,
    values: &[f64],
) -> [f64; 6] {
    [0, 1, 2, 3, 4, 5].map(|component| {
        constraints
            .row(DOFS_PER_NODE * reference + component)
            .expect("the reference DOF is dependent")
            .iter()
            .map(|&(dof, coefficient)| coefficient * values[dof])
            .sum()
    })
}

fn assert_close(label: &str, actual: [f64; 3], expected: [f64; 3]) {
    for axis in 0..3 {
        assert!(
            (actual[axis] - expected[axis]).abs() < 1e-10,
            "{label} {axis}: got {actual:?}, expected {expected:?}"
        );
    }
}

#[test]
fn an_offset_reference_point_follows_a_rigid_motion_of_its_patch() {
    let (points, constraints, reference) = offset_coupling();
    let cases = [
        ("translation", [0.3, -1.2, 0.7], [0.0; 3]),
        ("rotation", [0.0; 3], [0.02, -0.05, 0.03]),
        ("both", [-0.4, 0.9, 1.1], [-0.01, 0.04, 0.06]),
    ];
    for (label, translation, rotation) in cases {
        // u = U + θ × (x − R): the rigid motion whose value at R is U.
        let mut values = vec![0.0; DOFS_PER_NODE * points.len()];
        for (node, point) in PATCH.iter().enumerate() {
            let turn = cross(rotation, sub(*point, REFERENCE));
            for axis in 0..3 {
                values[DOFS_PER_NODE * node + axis] = translation[axis] + turn[axis];
            }
        }
        let motion = reference_motion(&constraints, reference, &values);
        assert_close(
            &format!("{label}: translation"),
            [motion[0], motion[1], motion[2]],
            translation,
        );
        assert_close(
            &format!("{label}: rotation"),
            [motion[3], motion[4], motion[5]],
            rotation,
        );
    }
}

/// The nodal loads a load at the reference point spreads to the patch: the
/// transpose of the reference node's equations, `fᵢ = Σ_c (∂u_R,c/∂uᵢ) F_c`.
fn spread(constraints: &CouplingConstraints, reference: usize, load: [f64; 6]) -> Vec<[f64; 3]> {
    let mut nodal = vec![[0.0; 3]; PATCH.len()];
    for (component, value) in load.iter().enumerate() {
        let row = constraints
            .row(DOFS_PER_NODE * reference + component)
            .expect("the reference DOF is dependent");
        for &(dof, coefficient) in row {
            nodal[dof / DOFS_PER_NODE][dof % DOFS_PER_NODE] += coefficient * value;
        }
    }
    nodal
}

/// Resultant force and moment about `centre` of loads at the patch nodes.
fn resultant(nodal: &[[f64; 3]], centre: [f64; 3]) -> ([f64; 3], [f64; 3]) {
    let mut force = [0.0; 3];
    let mut moment = [0.0; 3];
    for (point, load) in PATCH.iter().zip(nodal) {
        let turn = cross(sub(*point, centre), *load);
        for axis in 0..3 {
            force[axis] += load[axis];
            moment[axis] += turn[axis];
        }
    }
    (force, moment)
}

#[test]
fn a_force_at_an_offset_reference_point_keeps_its_lever_arm() {
    let (_, constraints, reference) = offset_coupling();
    let force = [120.0, -80.0, -300.0];
    let nodal = spread(
        &constraints,
        reference,
        [force[0], force[1], force[2], 0.0, 0.0, 0.0],
    );
    // Statically equivalent to F at R: no moment about R, so about the
    // centroid c the loads carry the lever-arm moment (R − c) × F.
    let (total, about_reference) = resultant(&nodal, REFERENCE);
    assert_close("force", total, force);
    assert_close("moment about R", about_reference, [0.0; 3]);
    let centre = centroid();
    let (_, about_centroid) = resultant(&nodal, centre);
    assert_close(
        "moment about the centroid",
        about_centroid,
        cross(sub(REFERENCE, centre), force),
    );
}

#[test]
fn a_moment_at_an_offset_reference_point_arrives_unscaled() {
    let (_, constraints, reference) = offset_coupling();
    let moment = [4000.0, 1500.0, -2500.0];
    let nodal = spread(
        &constraints,
        reference,
        [0.0, 0.0, 0.0, moment[0], moment[1], moment[2]],
    );
    let (total, about_reference) = resultant(&nodal, REFERENCE);
    assert_close("force", total, [0.0; 3]);
    assert_close("moment", about_reference, moment);
}

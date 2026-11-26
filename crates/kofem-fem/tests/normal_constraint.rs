// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Constraint rows with an offset in the coupled solve's reduction: a node's
//! displacement along a normal follows other nodes plus an offset,
//!
//! ```text
//! n · u_node = Σ wₖ n · u_k + offset,
//! ```
//!
//! while it stays free in the tangent plane (Wohlmuth's rotated basis). This
//! is how an active contact node is eliminated.
//!
//! The model is two non-matching blocks, the upper one's bottom nodes
//! following the lower one's top by dual mortar weights, pressed together by
//! a uniform traction on symmetry supports. The exact solution is linear in
//! each block: uniaxial compression, with the upper block shifted down by
//! the offset and the blocks sliding freely against each other as their
//! Poisson expansions differ.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

mod stacked;

use kofem_fem::{
    assemble_stiffness, mortar_integrals, prepare_constrained_static, solve_pcg_with, AmgSettings,
    CgSettings, Coupling, CouplingKind, FemError, NormalConstraint, PreconditionerChoice,
    StoppingRule,
};
use stacked::{stacked, Block, Shape, Stacked, POISSON};

const CG: CgSettings = CgSettings {
    relative_tolerance: 1e-12,
    max_iterations: 20_000,
    stopping: StoppingRule::ResidualNorm,
};
const TRACTION: f64 = -50.0;
const OFFSET: f64 = 2e-4;

fn preconditioners() -> [PreconditionerChoice; 2] {
    [
        PreconditionerChoice::SymmetricGaussSeidel,
        PreconditionerChoice::SmoothedAggregation(AmgSettings::default()),
    ]
}

fn blocks(lower: Shape, upper: Shape) -> Stacked {
    stacked(
        Block {
            cells: [2, 2, 2],
            height: 1.0,
            shape: lower,
            young: 70_000.0,
        },
        Block {
            cells: [3, 3, 2],
            height: 0.5,
            shape: upper,
            young: 210_000.0,
        },
        0.0,
    )
}

/// The upper block's bottom nodes follow the lower block's top along their
/// outward normal (−z), `offset` closer.
fn rows(model: &Stacked, offset: f64) -> Vec<NormalConstraint> {
    mortar_integrals(&model.upper_bottom, &model.lower_top, f64::INFINITY)
        .expect("mortar integrals")
        .into_iter()
        .map(|node| NormalConstraint {
            node: node.slave,
            normal: node.normal,
            weights: node
                .coupling
                .iter()
                .map(|value| value / node.diagonal)
                .collect(),
            masters: node.masters,
            offset,
        })
        .collect()
}

/// The exact displacement at `point` of the upper or lower block.
fn exact(model: &Stacked, upper: bool, point: [f64; 3]) -> [f64; 3] {
    let lower_young = model.lower.young;
    let young = if upper {
        model.upper.young
    } else {
        lower_young
    };
    let strain = TRACTION / young;
    let lateral = -POISSON * strain;
    let vertical = if upper {
        TRACTION / lower_young * model.lower_height - OFFSET
            + strain * (point[2] - model.lower_height)
    } else {
        strain * point[2]
    };
    [lateral * point[0], lateral * point[1], vertical]
}

#[test]
fn an_offset_normal_constraint_passes_the_patch_test() {
    for (lower, upper) in [
        (Shape::Hex, Shape::Hex),
        (Shape::Tet, Shape::Hex),
        (Shape::Hex, Shape::Tet),
        (Shape::Tet, Shape::Tet),
    ] {
        let model = blocks(lower, upper);
        let constraints = rows(&model, OFFSET);
        assert_eq!(
            constraints.len(),
            16,
            "every bottom node of the upper block"
        );
        let stiffness = assemble_stiffness(&model.mesh);
        let (dofs, values) = model.symmetry_supports();
        let wide_dofs: Vec<u32> = dofs.iter().map(|&dof| widen_dof(dof)).collect();
        let forces = widen(&model.top_traction(|_, _| TRACTION));
        for preconditioner in preconditioners() {
            let mut prepared = prepare_constrained_static(
                &model.mesh,
                &stiffness,
                &[],
                &constraints,
                &wide_dofs,
                &values,
                &forces,
                preconditioner,
            )
            .expect("prepares");
            let (reduced, _) = solve_pcg_with(
                prepared.prepared.system.as_mut(),
                &prepared.prepared.rhs,
                CG,
            )
            .expect("converges");
            let solution = prepared.reduction.expand(&reduced);
            let scale = (TRACTION / model.lower.young).abs();
            let mut worst: f64 = 0.0;
            for (node, &point) in model.vertices.iter().enumerate() {
                let expected = exact(&model, node >= model.first_upper, point);
                for axis in 0..3 {
                    worst = worst.max((solution[6 * node + axis] - expected[axis]).abs());
                }
            }
            assert!(
                worst < 1e-9 * scale.max(OFFSET),
                "{lower:?} below {upper:?}: worst displacement error {worst:e}"
            );
        }
    }
}

#[test]
fn a_support_across_the_normal_is_refused() {
    let model = blocks(Shape::Hex, Shape::Hex);
    let constraints = rows(&model, OFFSET);
    let stiffness = assemble_stiffness(&model.mesh);
    let node = constraints[0].node;
    // z of a constrained node is its normal direction: a support cannot hold it.
    let result = prepare_constrained_static(
        &model.mesh,
        &stiffness,
        &[],
        &constraints,
        &[widen_dof(3 * node as u32 + 2)],
        &[0.0],
        &vec![0.0; 6 * model.vertices.len()],
        PreconditionerChoice::SymmetricGaussSeidel,
    );
    assert!(
        matches!(result, Err(FemError::ConstraintOnCoupledDof { node: refused, component: 2, .. }) if refused == node),
        "got {:?}",
        result.err()
    );
}

#[test]
fn a_tied_node_cannot_also_follow_a_normal() {
    let model = blocks(Shape::Hex, Shape::Hex);
    let constraints = rows(&model, OFFSET);
    let stiffness = assemble_stiffness(&model.mesh);
    let first = &constraints[0];
    let tie = Coupling {
        reference: first.node,
        nodes: first.masters.clone(),
        weights: first.weights.clone(),
        kind: CouplingKind::Tie { dof_mask: 0b111 },
    };
    let result = prepare_constrained_static(
        &model.mesh,
        &stiffness,
        &[tie],
        &constraints,
        &[],
        &[],
        &vec![0.0; 6 * model.vertices.len()],
        PreconditionerChoice::SymmetricGaussSeidel,
    );
    assert!(
        matches!(result, Err(FemError::CouplingInput { .. })),
        "got {:?}",
        result.err()
    );
}

/// Three DOFs per node to six (translations, then three zero rotations).
fn widen(values: &[f64]) -> Vec<f64> {
    values
        .chunks(3)
        .flat_map(|node| [node[0], node[1], node[2], 0.0, 0.0, 0.0])
        .collect()
}

/// A 3-per-node DOF index in the 6-per-node numbering.
fn widen_dof(dof: u32) -> u32 {
    6 * (dof / 3) + dof % 3
}

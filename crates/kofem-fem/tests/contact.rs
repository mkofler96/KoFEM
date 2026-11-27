// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Frictionless dual mortar contact, small sliding, solved with the
//! primal–dual active set inside the Newton driver.
//!
//! * Patch test: two blocks with non-matching meshes pressed together by a
//!   uniform traction transmit it as a uniform contact pressure, exactly.
//! * Gap closing: with an initial gap g, no contact force until the imposed
//!   displacement closes g; then the force of the two blocks in series.
//! * Sign conditions: where a load pulls part of the interface apart, it
//!   opens; at convergence the pressure is ≥ 0 on every closed node and the
//!   gap ≥ 0 everywhere.
//! * Hertz: a cylinder on a flat block matches the analytic peak pressure
//!   and contact width.
//! * A missing or degenerate contact surface is refused by name.
//! * Bodies that overlap outside the picked surfaces are held there too: the
//!   contact grows over the faces where they meet.
//! * A body that only the contact holds, across an initial gap and free to
//!   slide along the contact, is pressed on all the same; a load the
//!   contact cannot take is refused with the motion nothing holds.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

mod stacked;

use kofem_fem::contact::{ContactCg, ContactInterface, ContactPair, ContactState, UnheldMotion};
use kofem_fem::nonlinear::{LinearElastic, NewtonRun, NewtonSettings, NewtonStatus};
use kofem_fem::{
    assemble_stiffness, mortar_weights, AmgSettings, BoundaryFaces, CgSettings, ElementOrder,
    FemError, Isotropic, MortarFace, PreconditionerChoice, StoppingRule, TetMesh, VertexTies,
};
use stacked::{stacked, symmetry_supports, tower, traction_on, Block, Shape, Stacked, POISSON};

const CG: CgSettings = CgSettings {
    relative_tolerance: 1e-12,
    max_iterations: 20_000,
    stopping: StoppingRule::ResidualNorm,
};
const TRACTION: f64 = -50.0;

fn preconditioners() -> [PreconditionerChoice; 2] {
    [
        PreconditionerChoice::SymmetricGaussSeidel,
        PreconditionerChoice::SmoothedAggregation(AmgSettings::default()),
    ]
}

fn settings(increments: u32) -> NewtonSettings {
    NewtonSettings {
        increments,
        max_iterations: 30,
        tolerance: 1e-9,
    }
}

/// What a contact solve ended with.
struct Outcome {
    displacements: Vec<f64>,
    state: ContactState,
    /// Newton (= active-set) iterations per increment.
    iterations: Vec<usize>,
}

/// The upper block's bottom (slave) against the lower block's top (master).
fn interface(model: &Stacked) -> ContactInterface {
    ContactInterface::new(
        &model.mesh,
        &[ContactPair {
            slave: model.upper_bottom.clone(),
            master: model.lower_top.clone(),
        }],
    )
    .expect("a valid contact interface")
}

#[allow(
    clippy::too_many_arguments,
    reason = "a load case's parts, as the Newton driver takes them"
)]
fn solve(
    mesh: &TetMesh,
    interface: ContactInterface,
    fixed_dofs: &[u32],
    fixed_values: &[f64],
    forces: &[f64],
    increments: u32,
    preconditioner: PreconditionerChoice,
) -> Outcome {
    try_solve(
        mesh,
        interface,
        fixed_dofs,
        fixed_values,
        forces,
        increments,
        preconditioner,
    )
    .expect("converges")
}

/// [`solve`], returning the error a solve that does not converge ends in.
#[allow(
    clippy::too_many_arguments,
    reason = "a load case's parts, as the Newton driver takes them"
)]
fn try_solve(
    mesh: &TetMesh,
    interface: ContactInterface,
    fixed_dofs: &[u32],
    fixed_values: &[f64],
    forces: &[f64],
    increments: u32,
    preconditioner: PreconditionerChoice,
) -> Result<Outcome, FemError> {
    let stiffness = assemble_stiffness(mesh);
    let solver = ContactCg::new(mesh, interface, None, CG, preconditioner);
    let mut run = NewtonRun::start(
        LinearElastic::new(stiffness),
        solver,
        mesh,
        fixed_dofs,
        fixed_values,
        forces,
        settings(increments),
    )
    .expect("starts");
    while run.advance(usize::MAX)? != NewtonStatus::Converged {}
    let state = run.solver().state().expect("settled");
    let solution = run.into_solution().expect("finished");
    Ok(Outcome {
        displacements: solution.displacements,
        state,
        iterations: solution
            .increments
            .iter()
            .map(|increment| increment.iterations)
            .collect(),
    })
}

fn pressed(lower: Shape, upper: Shape) -> Stacked {
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

#[test]
fn contact_patch_test_transmits_a_uniform_pressure_exactly() {
    for (lower, upper) in [
        (Shape::Hex, Shape::Hex),
        (Shape::Tet, Shape::Hex),
        (Shape::Hex, Shape::Tet),
        (Shape::Tet, Shape::Tet),
    ] {
        let model = pressed(lower, upper);
        let (dofs, values) = model.symmetry_supports();
        let forces = model.top_traction(|_, _| TRACTION);
        for preconditioner in preconditioners() {
            let outcome = solve(
                &model.mesh,
                interface(&model),
                &dofs,
                &values,
                &forces,
                1,
                preconditioner,
            );
            let state = &outcome.state;
            assert_eq!(
                state.nodes.len(),
                16,
                "every bottom node of the upper block"
            );
            let worst = state
                .pressure
                .iter()
                .map(|pressure| (pressure - (-TRACTION)).abs())
                .fold(0.0, f64::max);
            assert!(
                state.closed.iter().all(|&closed| closed),
                "{lower:?} below {upper:?}: every node closed"
            );
            assert!(
                worst <= 1e-8 * TRACTION.abs(),
                "{lower:?} below {upper:?}: pressure error {worst:e} (pressures {:?})",
                state.pressure
            );
            println!(
                "patch {lower:?} below {upper:?} {preconditioner:?}: max |p − σ|/σ = {:.2e}, \
                 active-set iterations {:?}",
                worst / TRACTION.abs(),
                outcome.iterations
            );
        }
    }
}

const GAP: f64 = 1e-3;

/// The upper block's top pushed down by `push`; returns the total contact
/// force and how many nodes closed.
fn gap_case(push: f64, increments: u32) -> (f64, usize, Stacked, Outcome) {
    let model = stacked(
        Block {
            cells: [2, 2, 2],
            height: 1.0,
            shape: Shape::Hex,
            young: 70_000.0,
        },
        Block {
            cells: [3, 3, 2],
            height: 0.5,
            shape: Shape::Tet,
            young: 210_000.0,
        },
        GAP,
    );
    let (mut dofs, mut values) = model.symmetry_supports();
    let top = model.lower_height + GAP + model.upper.height;
    for (node, point) in model.vertices.iter().enumerate() {
        if (point[2] - top).abs() < 1e-12 {
            dofs.push(3 * node as u32 + 2);
            values.push(-push);
        }
    }
    let forces = vec![0.0; 3 * model.vertices.len()];
    let outcome = solve(
        &model.mesh,
        interface(&model),
        &dofs,
        &values,
        &forces,
        increments,
        PreconditionerChoice::SmoothedAggregation(AmgSettings::default()),
    );
    let closed = outcome
        .state
        .closed
        .iter()
        .filter(|&&closed| closed)
        .count();
    (outcome.state.force(), closed, model, outcome)
}

#[test]
fn an_initial_gap_carries_no_force_until_it_closes() {
    // Uniaxial stress in both blocks in series: F = (push − g) / Σ H/E over
    // the unit area.
    let compliance = |model: &Stacked| {
        model.lower.height / model.lower.young + model.upper.height / model.upper.young
    };
    for push in [0.5 * GAP, 0.9 * GAP, 1.5 * GAP, 3.0 * GAP] {
        let (force, closed, model, outcome) = gap_case(push, 1);
        let compliance = compliance(&model);
        if push < GAP {
            assert_eq!(closed, 0, "push {push:e}: the gap is still open");
            assert_eq!(force, 0.0, "push {push:e}: no contact force");
            let lower_moved = (0..model.first_upper)
                .map(|node| outcome.displacements[3 * node + 2].abs())
                .fold(0.0, f64::max);
            assert_eq!(
                lower_moved, 0.0,
                "push {push:e}: the lower block is unloaded"
            );
        } else {
            let expected = (push - GAP) / compliance;
            assert_eq!(closed, 16, "push {push:e}: the whole interface closes");
            assert!(
                (force - expected).abs() <= 1e-8 * expected,
                "push {push:e}: force {force}, expected {expected}"
            );
        }
        println!(
            "gap {GAP:e}, push {push:e}: contact force {force:.6e}, closed nodes {closed}, \
             active-set iterations {:?}",
            outcome.iterations
        );
    }
    // Through load increments: closed half-way, then pressed.
    let (force, _, model, outcome) = gap_case(3.0 * GAP, 4);
    let expected = 2.0 * GAP / compliance(&model);
    assert!(
        (force - expected).abs() <= 1e-8 * expected,
        "in 4 increments: force {force}, expected {expected}"
    );
    println!(
        "push 3g in 4 increments: contact force {force:.6e} (expected {expected:.6e}), \
         active-set iterations per increment {:?}",
        outcome.iterations
    );
}

#[test]
fn a_pulled_edge_opens_and_the_sign_conditions_hold() {
    // Pushed at x = 0, pulled at x = 1, compressive overall: the contact
    // opens towards x = 1.
    let model = stacked(
        Block {
            cells: [6, 6, 3],
            height: 1.0,
            shape: Shape::Hex,
            young: 70_000.0,
        },
        Block {
            cells: [7, 7, 3],
            height: 0.5,
            shape: Shape::Tet,
            young: 210_000.0,
        },
        0.0,
    );
    let (dofs, values) = model.symmetry_supports();
    let forces = model.top_traction(|along_x, _| -50.0 * (1.5 - 2.0 * along_x));
    let outcome = solve(
        &model.mesh,
        interface(&model),
        &dofs,
        &values,
        &forces,
        1,
        PreconditionerChoice::SmoothedAggregation(AmgSettings::default()),
    );
    let state = &outcome.state;
    let closed = state.closed.iter().filter(|&&closed| closed).count();
    assert!(
        closed > 0 && closed < state.nodes.len(),
        "part of the interface opens: {closed} of {} closed",
        state.nodes.len()
    );
    let scale = state.pressure.iter().copied().fold(0.0, f64::max);
    let gap_scale = outcome
        .displacements
        .iter()
        .map(|value| value.abs())
        .fold(0.0, f64::max);
    let mut worst_pressure: f64 = 0.0;
    let mut worst_gap: f64 = 0.0;
    for (index, &closed) in state.closed.iter().enumerate() {
        if closed {
            worst_pressure = worst_pressure.min(state.pressure[index]);
            assert!(
                state.gap[index].abs() <= 1e-9 * gap_scale,
                "closed node {} has gap {}",
                state.nodes[index],
                state.gap[index]
            );
        } else {
            assert_eq!(state.pressure[index], 0.0);
        }
        worst_gap = worst_gap.min(state.gap[index]);
    }
    assert!(
        worst_pressure >= -1e-9 * scale,
        "pressure {worst_pressure:e} on a closed node"
    );
    assert!(
        worst_gap >= -1e-9 * gap_scale,
        "gap {worst_gap:e} somewhere"
    );
    // Equilibrium: the contact force carries the whole load.
    let load: f64 = forces.iter().sum();
    assert!(
        (state.force() + load).abs() <= 1e-8 * load.abs(),
        "contact force {} for a load of {load}",
        state.force()
    );
    println!(
        "lift-off: {closed} of {} nodes closed, min pressure {worst_pressure:.2e} (max {scale:.3e}), \
         min gap {worst_gap:.2e}, active-set iterations {:?}",
        state.nodes.len(),
        outcome.iterations
    );
}

#[test]
fn surfaces_that_do_not_face_each_other_are_refused() {
    let model = pressed(Shape::Hex, Shape::Hex);
    // The upper block's top faces the same way as the lower block's top.
    let result = ContactInterface::new(
        &model.mesh,
        &[ContactPair {
            slave: model.upper_top.clone(),
            master: model.lower_top.clone(),
        }],
    );
    assert!(
        matches!(result, Err(FemError::Contact { .. })),
        "got {:?}",
        result.err()
    );
    let empty = ContactInterface::new(
        &model.mesh,
        &[ContactPair {
            slave: Vec::new(),
            master: model.lower_top.clone(),
        }],
    );
    assert!(
        matches!(empty, Err(FemError::Contact { .. })),
        "got {:?}",
        empty.err()
    );
}

#[test]
fn a_degenerate_contact_face_is_refused() {
    let model = pressed(Shape::Hex, Shape::Hex);
    let mut slave: Vec<MortarFace> = model.upper_bottom.clone();
    let point = slave[0].points[0];
    slave[0].points = vec![point; 4];
    let result = ContactInterface::new(
        &model.mesh,
        &[ContactPair {
            slave,
            master: model.lower_top.clone(),
        }],
    );
    assert!(result.is_err(), "a zero-area face is refused");
}

#[test]
fn contact_on_quadratic_elements_is_refused() {
    let model = pressed(Shape::Hex, Shape::Hex);
    let quadratic = model
        .mesh
        .clone()
        .with_order(ElementOrder::Quadratic)
        .expect("fits");
    let result = ContactInterface::new(
        &quadratic,
        &[ContactPair {
            slave: model.upper_bottom.clone(),
            master: model.lower_top.clone(),
        }],
    );
    assert!(
        matches!(result, Err(FemError::Contact { .. })),
        "got {:?}",
        result.err()
    );
}

#[test]
fn a_face_in_two_contacts_is_refused() {
    // Its area would count twice. Which side is the slave depends on the
    // supports, so the solve refuses it when it starts.
    let model = pressed(Shape::Hex, Shape::Hex);
    let pair = ContactPair {
        slave: model.upper_bottom.clone(),
        master: model.lower_top.clone(),
    };
    let interface =
        ContactInterface::new(&model.mesh, &[pair.clone(), pair]).expect("a valid interface");
    let (dofs, values) = model.symmetry_supports();
    let result = NewtonRun::start(
        LinearElastic::new(assemble_stiffness(&model.mesh)),
        ContactCg::new(
            &model.mesh,
            interface,
            None,
            CG,
            PreconditionerChoice::SymmetricGaussSeidel,
        ),
        &model.mesh,
        &dofs,
        &values,
        &model.top_traction(|_, _| TRACTION),
        settings(1),
    );
    let Err(FemError::TangentSolve { reason, .. }) = result else {
        panic!("expected a refusal, got {:?}", result.err());
    };
    assert!(reason.contains("two contacts"), "{reason}");
}

/// The upper block finer than the lower one, both with a grid line at
/// x = 0.5, and the faces of each facing surface on either side of it.
struct Split {
    model: Stacked,
    upper_left: Vec<MortarFace>,
    upper_right: Vec<MortarFace>,
    lower_left: Vec<MortarFace>,
    lower_right: Vec<MortarFace>,
}

fn split() -> Split {
    let model = stacked(
        Block {
            cells: [2, 2, 2],
            height: 1.0,
            shape: Shape::Hex,
            young: 70_000.0,
        },
        Block {
            cells: [4, 4, 2],
            height: 0.5,
            shape: Shape::Tet,
            young: 210_000.0,
        },
        0.0,
    );
    let halves = |faces: &[MortarFace]| -> (Vec<MortarFace>, Vec<MortarFace>) {
        faces.iter().cloned().partition(|face| {
            face.points.iter().map(|point| point[0]).sum::<f64>() / (face.points.len() as f64) < 0.5
        })
    };
    let (upper_left, upper_right) = halves(&model.upper_bottom);
    let (lower_left, lower_right) = halves(&model.lower_top);
    Split {
        model,
        upper_left,
        upper_right,
        lower_left,
        lower_right,
    }
}

fn solve_pairs(model: &Stacked, pairs: &[ContactPair]) -> Outcome {
    let (dofs, values) = model.symmetry_supports();
    solve(
        &model.mesh,
        ContactInterface::new(&model.mesh, pairs).expect("a valid interface"),
        &dofs,
        &values,
        &model.top_traction(|_, _| TRACTION),
        1,
        PreconditionerChoice::SmoothedAggregation(AmgSettings::default()),
    )
}

/// One surface picked as two contacts, split along a grid line: the nodes
/// on the line take both contacts' shares as one condition, so the two
/// contacts pass the patch test as one would.
#[test]
fn two_contacts_over_one_surface_split_in_two_act_as_one() {
    let split = split();
    let outcome = solve_pairs(
        &split.model,
        &[
            ContactPair {
                slave: split.upper_left.clone(),
                master: split.lower_left.clone(),
            },
            ContactPair {
                slave: split.upper_right.clone(),
                master: split.lower_right.clone(),
            },
        ],
    );
    let state = &outcome.state;
    assert_eq!(
        state.nodes.len(),
        25,
        "every bottom node of the upper block, once"
    );
    assert!(
        state.shared.is_empty(),
        "no condition dropped: {:?}",
        state.shared
    );
    assert!(
        state.closed.iter().all(|&closed| closed),
        "every node closed"
    );
    let worst = state
        .pressure
        .iter()
        .map(|pressure| (pressure - (-TRACTION)).abs())
        .fold(0.0, f64::max);
    assert!(
        worst <= 1e-8 * TRACTION.abs(),
        "pressure error {worst:e} (pressures {:?})",
        state.pressure
    );
}

/// Two contacts whose slave sides cross at a shared grid line: each node on
/// the line is a slave of one contact and a master of the other. It keeps
/// one role, and the interface still carries the whole load.
#[test]
fn crossed_contacts_at_a_shared_edge_carry_the_load() {
    let split = split();
    let outcome = solve_pairs(
        &split.model,
        &[
            ContactPair {
                slave: split.upper_left.clone(),
                master: split.lower_left.clone(),
            },
            ContactPair {
                slave: split.lower_right.clone(),
                master: split.upper_right.clone(),
            },
        ],
    );
    let state = &outcome.state;
    assert!(!state.shared.is_empty(), "the line's nodes are shared");
    for &node in &state.shared {
        assert!(
            (split.model.vertices[node][0] - 0.5).abs() < 1e-12,
            "node {node} at {:?} off the shared line",
            split.model.vertices[node]
        );
    }
    assert!(
        (state.force() + TRACTION).abs() <= 1e-8 * TRACTION.abs(),
        "contact force {} carries the load",
        state.force()
    );
    let pressure_tolerance = 1e-9 * TRACTION.abs();
    for (pressure, gap) in state.pressure.iter().zip(&state.gap) {
        assert!(*pressure >= -pressure_tolerance, "pressure {pressure:e}");
        assert!(*gap >= -1e-9, "gap {gap:e}");
    }
    println!(
        "crossed contacts: {} shared node(s), pressures {:.4}..{:.4}",
        state.shared.len(),
        state.pressure.iter().copied().fold(f64::INFINITY, f64::min),
        state.pressure.iter().copied().fold(0.0, f64::max)
    );
}

/// Grid lines over [0, `extent`]: uniform steps of `fine` up to `uniform`,
/// then each step `growth` times the last.
fn graded(fine: f64, uniform: f64, extent: f64, growth: f64) -> Vec<f64> {
    let mut lines = vec![0.0];
    let mut step = fine;
    while lines.last().copied().unwrap_or(0.0) < extent - 1e-12 {
        let last = lines.last().copied().unwrap_or(0.0);
        if last >= uniform - 1e-12 {
            step *= growth;
        }
        let next = last + step;
        // Absorb a sliver at the end into the last step.
        lines.push(if next > extent - 0.5 * step {
            extent
        } else {
            next
        });
    }
    lines
}

/// Grid lines over [−`extent`, `extent`], symmetric about 0.
fn symmetric(fine: f64, uniform: f64, extent: f64, growth: f64) -> Vec<f64> {
    let half = graded(fine, uniform, extent, growth);
    let mut lines: Vec<f64> = half.iter().rev().map(|value| -value).collect();
    lines.extend(half.iter().skip(1));
    lines
}

/// A plane-strain cylinder of radius `RADIUS` on a flat block, both of
/// width 2·`EXTENT` and height `EXTENT`, one hexahedron layer of
/// `THICKNESS`. The cylinder is its Hertz profile, y = x² / 2R, on top of
/// the block's surface y = 0.
struct Hertz {
    mesh: TetMesh,
    vertices: Vec<[f64; 3]>,
    /// The block's top (slave) and the cylinder's bottom (master).
    flat: Vec<MortarFace>,
    curved: Vec<MortarFace>,
    /// The element size of the flat surface under the contact.
    flat_step: f64,
    first_upper: usize,
}

const RADIUS: f64 = 50.0;
const EXTENT: f64 = 15.0;
const THICKNESS: f64 = 0.1;
const YOUNG: f64 = 1_000.0;

fn hertz() -> Hertz {
    let flat_step = 1.0 / 16.0;
    let mut vertices: Vec<[f64; 3]> = Vec::new();
    let mut hexes: Vec<u32> = Vec::new();
    let mut flat = Vec::new();
    let mut curved = Vec::new();
    let mut first_upper = 0;
    for upper in [false, true] {
        let first = vertices.len();
        if upper {
            first_upper = first;
        }
        let step = if upper { 1.0 / 12.0 } else { flat_step };
        let xs = symmetric(step, 2.0, EXTENT, 1.2);
        let depths = graded(step, step, EXTENT, 1.2);
        let surface = |along: f64| {
            if upper {
                along * along / (2.0 * RADIUS)
            } else {
                0.0
            }
        };
        let (nx, ny) = (xs.len(), depths.len());
        let index = |i: usize, j: usize, k: usize| (first + i + nx * (j + ny * k)) as u32;
        for k in 0..2 {
            for &depth in &depths {
                for &along in &xs {
                    let height = if upper {
                        let base = surface(along);
                        base + (EXTENT - base) * depth / EXTENT
                    } else {
                        -depth
                    };
                    vertices.push([along, height, THICKNESS * f64::from(k)]);
                }
            }
        }
        for j in 0..ny - 1 {
            for i in 0..nx - 1 {
                // Corners wound so the first face points along −z, as CHEXA.
                let (near, far) = if upper { (j, j + 1) } else { (j + 1, j) };
                let corners = [
                    index(i, near, 0),
                    index(i + 1, near, 0),
                    index(i + 1, far, 0),
                    index(i, far, 0),
                    index(i, near, 1),
                    index(i + 1, near, 1),
                    index(i + 1, far, 1),
                    index(i, far, 1),
                ];
                hexes.extend(corners);
                if j == 0 {
                    let face = [
                        index(i, 0, 0),
                        index(i + 1, 0, 0),
                        index(i + 1, 0, 1),
                        index(i, 0, 1),
                    ];
                    let points: Vec<[f64; 3]> =
                        face.iter().map(|&id| vertices[id as usize]).collect();
                    let mut centroid = [0.0; 3];
                    for &corner in &corners {
                        for axis in 0..3 {
                            centroid[axis] += vertices[corner as usize][axis] / 8.0;
                        }
                    }
                    let mortar = MortarFace {
                        nodes: face.iter().map(|&id| id as usize).collect(),
                        points,
                        element_centroid: centroid,
                    };
                    if upper {
                        curved.push(mortar);
                    } else {
                        flat.push(mortar);
                    }
                }
            }
        }
    }
    let flat_points: Vec<f64> = vertices.iter().flatten().copied().collect();
    let mesh = TetMesh::with_hexahedra(
        &flat_points,
        &[],
        &hexes,
        &vec![0; hexes.len() / 8],
        vec![Isotropic::new(0, YOUNG, POISSON).expect("valid material")],
    )
    .expect("valid hexahedra");
    Hertz {
        mesh,
        vertices,
        flat,
        curved,
        flat_step,
        first_upper,
    }
}

#[test]
fn hertz_line_contact_matches_the_analytic_pressure_and_width() {
    let model = hertz();
    let push = 0.07;
    let mut dofs = Vec::new();
    let mut values = Vec::new();
    for (node, point) in model.vertices.iter().enumerate() {
        let dof = 3 * node as u32;
        // Plane strain; symmetry about x = 0; the block's base held; the
        // cylinder's top pushed down.
        dofs.push(dof + 2);
        values.push(0.0);
        if point[0] == 0.0 {
            dofs.push(dof);
            values.push(0.0);
        }
        if point[1] == -EXTENT {
            dofs.push(dof + 1);
            values.push(0.0);
        } else if node >= model.first_upper && point[1] == EXTENT {
            dofs.push(dof + 1);
            values.push(-push);
        }
    }
    let interface = ContactInterface::new(
        &model.mesh,
        &[ContactPair {
            slave: model.flat.clone(),
            master: model.curved.clone(),
        }],
    )
    .expect("a valid contact interface");
    let outcome = solve(
        &model.mesh,
        interface,
        &dofs,
        &values,
        &vec![0.0; 3 * model.vertices.len()],
        1,
        PreconditionerChoice::SmoothedAggregation(AmgSettings::default()),
    );
    let state = &outcome.state;
    // Plane strain, both bodies alike: 1/E* = 2(1 − ν²)/E.
    let modulus = YOUNG / (2.0 * (1.0 - POISSON * POISSON));
    let load = state.force() / THICKNESS;
    let half_width = (4.0 * load * RADIUS / (std::f64::consts::PI * modulus)).sqrt();
    let peak = 2.0 * load / (std::f64::consts::PI * half_width);
    let x_of = |index: usize| model.vertices[state.nodes[index]][0];
    let numeric_peak = state.pressure.iter().copied().fold(0.0, f64::max);
    let last_closed = (0..state.nodes.len())
        .filter(|&index| state.closed[index])
        .map(|index| x_of(index).abs())
        .fold(0.0, f64::max);
    let first_open = (0..state.nodes.len())
        .filter(|&index| !state.closed[index])
        .map(|index| x_of(index).abs())
        .fold(f64::INFINITY, f64::min);
    println!(
        "Hertz: load {load:.4} per length; peak pressure {numeric_peak:.4} vs analytic {peak:.4} \
         ({:+.2} %); contact half-width between {last_closed:.4} and {first_open:.4} vs \
         analytic {half_width:.4}; element size {:.4}; active-set iterations {:?}",
        100.0 * (numeric_peak / peak - 1.0),
        model.flat_step,
        outcome.iterations
    );
    // The half-width lies between the last closed and the first open node,
    // each a node spacing of the flat surface: within one element of it.
    assert!(
        last_closed <= half_width + model.flat_step && first_open >= half_width - model.flat_step,
        "contact half-width: closed to {last_closed}, open from {first_open}, analytic \
         {half_width}"
    );
    assert!(
        first_open - last_closed <= model.flat_step + 1e-9,
        "the contact edge is one element wide"
    );
    // The peak pressure within 3 %: the blocks are 15 half-widths across, not
    // half-spaces, and the pressure is resolved by 16 elements per half-width.
    assert!(
        (numeric_peak / peak - 1.0).abs() < 0.03,
        "peak pressure {numeric_peak} vs analytic {peak}"
    );
    // Sign conditions hold here too.
    for (index, &closed) in state.closed.iter().enumerate() {
        if closed {
            assert!(state.pressure[index] >= -1e-9 * numeric_peak);
        }
        assert!(state.gap[index] >= -1e-9 * push);
    }
}

#[test]
fn a_pair_from_picked_vertices_finds_the_faces_and_makes_the_finer_side_the_slave() {
    let model = pressed(Shape::Hex, Shape::Tet);
    let on_interface = |upper: bool| -> Vec<u32> {
        model
            .vertices
            .iter()
            .enumerate()
            .filter(|&(node, point)| {
                (point[2] - model.lower_height).abs() < 1e-12
                    && (node >= model.first_upper) == upper
            })
            .map(|(node, _)| node as u32)
            .collect()
    };
    // Picked lower side first: the upper side (3×3 cells, split in tets) is
    // finer, so it becomes the slave whichever order the sides come in.
    let boundary = BoundaryFaces::new(&model.mesh);
    for (first, second) in [(false, true), (true, false)] {
        let pair = ContactPair::between(
            &model.mesh,
            &boundary,
            &on_interface(first),
            &on_interface(second),
        )
        .expect("both sides name boundary faces");
        assert_eq!(pair.slave.len(), 18, "the upper block's 18 triangles");
        assert_eq!(pair.master.len(), 4, "the lower block's 4 quadrilaterals");
        assert!(pair
            .slave
            .iter()
            .all(|face| face.nodes.iter().all(|&node| node >= model.first_upper)));
    }
    let interior: Vec<u32> = vec![0, 1];
    assert!(matches!(
        ContactPair::between(&model.mesh, &boundary, &interior, &on_interface(true)),
        Err(FemError::Contact { .. })
    ));
}

/// Three blocks: the bottom two meshed apart and joined by a dual mortar tie,
/// the top one pressed on the middle one through contact. A uniform traction
/// crosses both interfaces exactly. The tied blocks share a material: a tie
/// bonds them, so different Poisson expansions would shear the joint; the
/// contact lets the top block expand on its own.
#[test]
fn contact_and_a_tie_in_one_model_pass_the_patch_test() {
    let block = |cells, shape, young| Block {
        cells,
        height: 0.5,
        shape,
        young,
    };
    let model = tower(&[
        (block([2, 2, 1], Shape::Hex, 70_000.0), 0.0),
        (block([3, 3, 1], Shape::Tet, 70_000.0), 0.0),
        (block([4, 4, 2], Shape::Hex, 210_000.0), 0.0),
    ]);
    let rows = mortar_weights(&model.faces(1, 0.5), &model.faces(0, 0.5), f64::INFINITY)
        .expect("tie weights");
    let mut offsets = vec![0u32];
    let mut masters = Vec::new();
    let mut weights = Vec::new();
    for row in &rows {
        masters.extend(row.masters.iter().map(|&master| master as u32));
        weights.extend_from_slice(&row.weights);
        offsets.push(masters.len() as u32);
    }
    let slaves: Vec<u32> = rows.iter().map(|row| row.slave as u32).collect();
    let ties = VertexTies::new(model.vertices.len(), &slaves, &offsets, &masters, &weights)
        .expect("valid ties");
    let interface = ContactInterface::new(
        &model.mesh,
        &[ContactPair {
            slave: model.faces(2, 1.0),
            master: model.faces(1, 1.0),
        }],
    )
    .expect("a valid contact interface");
    let (dofs, values) = symmetry_supports(&model.vertices);
    let forces = traction_on(&model.faces(2, 1.5), model.vertices.len(), |_, _| TRACTION);
    let stiffness = assemble_stiffness(&model.mesh);
    let solver = ContactCg::new(
        &model.mesh,
        interface,
        Some(ties),
        CG,
        PreconditionerChoice::SmoothedAggregation(AmgSettings::default()),
    );
    let mut run = NewtonRun::start(
        LinearElastic::new(stiffness),
        solver,
        &model.mesh,
        &dofs,
        &values,
        &forces,
        settings(1),
    )
    .expect("starts");
    while run.advance(usize::MAX).expect("converges") != NewtonStatus::Converged {}
    let state = run.solver().state().expect("settled");
    let solution = run.into_solution().expect("finished");
    assert_eq!(
        state.ties.tied_nodes, 16,
        "the middle block's bottom is tied"
    );
    assert!(state.closed.iter().all(|&closed| closed));
    let worst = state
        .pressure
        .iter()
        .map(|pressure| (pressure + TRACTION).abs())
        .fold(0.0, f64::max);
    assert!(worst <= 1e-8 * TRACTION.abs(), "pressure error {worst:e}");
    // Uniaxial compression in each block: z-displacement linear in z with
    // the block's own strain, continuous across the tie and the contact.
    let youngs = [70_000.0, 70_000.0, 210_000.0];
    let mut worst_displacement: f64 = 0.0;
    for (block, young) in youngs.iter().enumerate() {
        let below: f64 = youngs[..block]
            .iter()
            .map(|young| TRACTION / young * 0.5)
            .sum();
        for node in model.block_vertices(block) {
            let height = model.vertices[node][2] - model.bases[block];
            let expected = below + TRACTION / young * height;
            worst_displacement =
                worst_displacement.max((solution.displacements[3 * node + 2] - expected).abs());
        }
    }
    assert!(
        worst_displacement < 1e-9 * (TRACTION / 70_000.0).abs(),
        "worst z-displacement error {worst_displacement:e}"
    );
    println!(
        "tie + contact: max |p − σ|/σ = {:.2e}, worst z-displacement error {worst_displacement:.2e}",
        worst / TRACTION.abs()
    );
}

/// Surfaces that overlap at the start, with no load: the closed nodes' gap
/// equations still have to be solved, pushing the upper block out of the
/// lower one, before the run may converge.
#[test]
fn an_initial_overlap_is_pushed_apart_before_convergence() {
    let overlap = 1e-3;
    let model = stacked(
        Block {
            cells: [2, 2, 2],
            height: 1.0,
            shape: Shape::Hex,
            young: 70_000.0,
        },
        Block {
            cells: [3, 3, 2],
            height: 0.5,
            shape: Shape::Hex,
            young: 210_000.0,
        },
        -overlap,
    );
    let (dofs, values) = model.symmetry_supports();
    let outcome = solve(
        &model.mesh,
        interface(&model),
        &dofs,
        &values,
        &vec![0.0; 3 * model.vertices.len()],
        1,
        PreconditionerChoice::SymmetricGaussSeidel,
    );
    // Pushed apart without load, the surfaces just touch: zero gap and zero
    // pressure, which a node satisfies closed or open.
    let state = &outcome.state;
    let pressure_scale = model.upper.young * overlap / model.upper.height;
    for pressure in &state.pressure {
        assert!(
            pressure.abs() < 1e-9 * pressure_scale,
            "pressure {pressure:e} without load"
        );
    }
    for gap in &state.gap {
        assert!(
            gap.abs() < 1e-9 * overlap,
            "gap {gap:e} left open or overlapping"
        );
    }
    for node in model.first_upper..model.vertices.len() {
        let lift = outcome.displacements[3 * node + 2];
        assert!(
            (lift - overlap).abs() < 1e-9 * overlap,
            "upper block lifted by {lift:e}"
        );
    }
    assert!(outcome.iterations[0] >= 1, "the gap equations were solved");
}

/// The finer surface on a body its supports hold: it cannot follow the other
/// surface, so the other surface takes the contact condition, and the pushed
/// block stops on the held one instead of passing through it.
#[test]
fn a_held_finer_surface_makes_the_other_side_the_slave() {
    let push = 1e-3;
    let model = stacked(
        Block {
            cells: [4, 4, 2],
            height: 1.0,
            shape: Shape::Hex,
            young: 70_000.0,
        },
        Block {
            cells: [2, 2, 2],
            height: 0.5,
            shape: Shape::Hex,
            young: 210_000.0,
        },
        0.0,
    );
    let mut dofs = Vec::new();
    let mut values = Vec::new();
    let top = model.lower_height + model.upper.height;
    for (node, point) in model.vertices.iter().enumerate() {
        let dof = 3 * node as u32;
        if node < model.first_upper {
            dofs.extend([dof, dof + 1, dof + 2]);
            values.extend([0.0; 3]);
            continue;
        }
        if point[0] == 0.0 {
            dofs.push(dof);
            values.push(0.0);
        }
        if point[1] == 0.0 {
            dofs.push(dof + 1);
            values.push(0.0);
        }
        if (point[2] - top).abs() < 1e-12 {
            dofs.push(dof + 2);
            values.push(-push);
        }
    }
    let boundary = BoundaryFaces::new(&model.mesh);
    let side = |upper: bool| -> Vec<u32> {
        model
            .vertices
            .iter()
            .enumerate()
            .filter(|&(node, point)| {
                (point[2] - model.lower_height).abs() < 1e-12
                    && (node >= model.first_upper) == upper
            })
            .map(|(node, _)| node as u32)
            .collect()
    };
    let pair = ContactPair::between(&model.mesh, &boundary, &side(false), &side(true))
        .expect("both sides name faces");
    let interface = ContactInterface::new(&model.mesh, &[pair]).expect("a valid interface");
    let outcome = solve(
        &model.mesh,
        interface,
        &dofs,
        &values,
        &vec![0.0; 3 * model.vertices.len()],
        1,
        PreconditionerChoice::SymmetricGaussSeidel,
    );
    let state = &outcome.state;
    assert!(
        state.held.is_empty(),
        "no slave node is held: {:?}",
        state.held
    );
    assert!(
        state.nodes.iter().all(|&node| node >= model.first_upper),
        "the upper (free) surface is the slave"
    );
    // The upper block is squeezed between its pushed top and the held block.
    let expected = model.upper.young * push / model.upper.height;
    assert!(
        (state.force() - expected).abs() <= 1e-8 * expected,
        "force {}, expected {expected}",
        state.force()
    );
}

/// The upper block resting `GAP` above the lower one with no support of its
/// own: only the contact can hold it, and only along z. The lower block is
/// held by symmetry supports.
fn resting(lower: Shape, upper: Shape) -> (Stacked, Vec<u32>, Vec<f64>) {
    resting_at(lower, upper, GAP)
}

/// [`resting`], `gap` above the lower block.
fn resting_at(lower: Shape, upper: Shape, gap: f64) -> (Stacked, Vec<u32>, Vec<f64>) {
    let model = stacked(
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
        gap,
    );
    let (dofs, values) = symmetry_supports(&model.vertices[..model.first_upper]);
    (model, dofs, values)
}

/// The upper block's top loaded by a uniform traction per area, `lateral`
/// along x and `vertical` along z.
fn top_load(model: &Stacked, lateral: f64, vertical: f64) -> Vec<f64> {
    let mut forces = model.top_traction(|_, _| vertical);
    let along_x = model.top_traction(|_, _| lateral);
    for node in 0..model.vertices.len() {
        forces[3 * node] = along_x[3 * node + 2];
    }
    forces
}

#[test]
fn a_body_only_the_contact_holds_is_pressed_on_across_a_gap() {
    for (lower, upper) in [(Shape::Hex, Shape::Tet), (Shape::Tet, Shape::Hex)] {
        let (model, dofs, values) = resting(lower, upper);
        let forces = top_load(&model, 0.0, TRACTION);
        for preconditioner in preconditioners() {
            let outcome = solve(
                &model.mesh,
                interface(&model),
                &dofs,
                &values,
                &forces,
                1,
                preconditioner,
            );
            let state = &outcome.state;
            assert!(
                state.closed.iter().all(|&closed| closed),
                "{lower:?} below {upper:?}: every node closed"
            );
            let worst = state
                .pressure
                .iter()
                .map(|pressure| (pressure - (-TRACTION)).abs())
                .fold(0.0, f64::max);
            assert!(
                worst <= 1e-8 * TRACTION.abs(),
                "{lower:?} below {upper:?} {preconditioner:?}: pressure error {worst:e}"
            );
            assert!(
                (state.force() + TRACTION).abs() <= 1e-8 * TRACTION.abs(),
                "{lower:?} below {upper:?}: contact force {} carries the load",
                state.force()
            );
            // Free to slide, the block does not drift: it moves no further
            // than its own lateral expansion.
            let slide = (model.first_upper..model.vertices.len())
                .flat_map(|node| [0, 1].map(|axis| outcome.displacements[3 * node + axis]))
                .map(f64::abs)
                .fold(0.0, f64::max);
            let expansion = POISSON * TRACTION.abs() / model.upper.young;
            assert!(
                slide <= expansion,
                "{lower:?} below {upper:?}: slid {slide:e}, expansion {expansion:e}"
            );
            println!(
                "resting {lower:?} below {upper:?} {preconditioner:?}: max |p − σ|/σ = {:.2e}, \
                 active-set iterations {:?}",
                worst / TRACTION.abs(),
                outcome.iterations
            );
        }
    }
}

/// The error a load on the resting block ends in (tractions as for
/// [`top_load`]), and the upper block's first vertex.
fn unheld(lateral: f64, vertical: f64) -> (FemError, usize) {
    unheld_at(GAP, lateral, vertical)
}

/// [`unheld`], the block `gap` above the lower one.
fn unheld_at(gap: f64, lateral: f64, vertical: f64) -> (FemError, usize) {
    let (model, dofs, values) = resting_at(Shape::Hex, Shape::Tet, gap);
    let forces = top_load(&model, lateral, vertical);
    let error = try_solve(
        &model.mesh,
        interface(&model),
        &dofs,
        &values,
        &forces,
        1,
        PreconditionerChoice::SmoothedAggregation(AmgSettings::default()),
    )
    .err()
    .expect("the load on the resting block is refused");
    (error, model.first_upper)
}

#[test]
fn a_load_along_the_contact_that_nothing_holds_is_refused() {
    let (error, first_upper) = unheld(1.0, TRACTION);
    assert!(
        matches!(
            error,
            FemError::ContactUnheld {
                node,
                motion: UnheldMotion::Along([1.0, 0.0, 0.0]),
            } if node >= first_upper
        ),
        "refused along x at a node of the upper block, got {error:?}"
    );
}

#[test]
fn a_body_pulled_off_the_contact_is_refused() {
    let (error, _) = unheld(0.0, -TRACTION);
    assert!(
        matches!(
            error,
            FemError::ContactUnheld {
                motion: UnheldMotion::Along([0.0, 0.0, 1.0]),
                ..
            }
        ),
        "refused along z, got {error:?}"
    );
}

/// Surfaces that touch at the start leave the first active set as it is:
/// the springs must still be checked on a balanced correction, not on the
/// undisplaced start where they carry nothing.
#[test]
fn a_load_along_the_contact_is_refused_where_the_surfaces_already_touch() {
    let cube = |height| Block {
        cells: [1, 1, 1],
        height,
        shape: Shape::Hex,
        young: 70_000.0,
    };
    let model = stacked(cube(1.0), cube(0.5), 0.0);
    let (dofs, values) = symmetry_supports(&model.vertices[..model.first_upper]);
    let error = try_solve(
        &model.mesh,
        interface(&model),
        &dofs,
        &values,
        &top_load(&model, 1.0, TRACTION),
        1,
        PreconditionerChoice::SymmetricGaussSeidel,
    )
    .err()
    .expect("the load along the contact is refused");
    assert!(
        matches!(
            error,
            FemError::ContactUnheld {
                motion: UnheldMotion::Along([1.0, 0.0, 0.0]),
                ..
            }
        ),
        "refused along x, got {error:?}"
    );
}

/// A load far below what the springs resist in closing the gap: the contact
/// holds the block, so the springs' share of the gap closing is no verdict.
#[test]
fn a_light_load_across_a_gap_is_held_by_the_contact() {
    let light = -1e-3;
    let (model, dofs, values) = resting(Shape::Hex, Shape::Tet);
    let outcome = solve(
        &model.mesh,
        interface(&model),
        &dofs,
        &values,
        &top_load(&model, 0.0, light),
        1,
        PreconditionerChoice::SmoothedAggregation(AmgSettings::default()),
    );
    let state = &outcome.state;
    assert!(
        state.closed.iter().all(|&closed| closed),
        "every node closed"
    );
    assert!(
        (state.force() + light).abs() <= 1e-8 * light.abs(),
        "contact force {} carries the load",
        state.force()
    );
}

/// The vertices of `faces`, as a contact side picks them.
fn vertices_of(faces: &[MortarFace]) -> Vec<u32> {
    let mut vertices: Vec<u32> = faces
        .iter()
        .flat_map(|face| face.nodes.iter().map(|&node| node as u32))
        .collect();
    vertices.sort_unstable();
    vertices.dedup();
    vertices
}

/// A contact solve over picked surfaces, run to convergence.
fn solve_picked(model: &Stacked, sides: &[(Vec<u32>, Vec<u32>)]) -> ContactState {
    let (dofs, values) = model.symmetry_supports();
    let solver = ContactCg::from_picked_surfaces(
        &model.mesh,
        sides,
        None,
        CG,
        PreconditionerChoice::SmoothedAggregation(AmgSettings::default()),
    )
    .expect("the picked surfaces name faces");
    let mut run = NewtonRun::start(
        LinearElastic::new(assemble_stiffness(&model.mesh)),
        solver,
        &model.mesh,
        &dofs,
        &values,
        &model.top_traction(|_, _| TRACTION),
        settings(1),
    )
    .expect("starts");
    while run.advance(usize::MAX).expect("converges") != NewtonStatus::Converged {}
    run.solver().state().expect("settled")
}

/// Only half of the touching faces picked: the other half would pass through
/// the lower block, so the contact grows over it, and the two blocks pass
/// the patch test as if the whole face had been picked.
#[test]
fn a_contact_grows_over_faces_where_the_bodies_overlap() {
    let split = split();
    let state = solve_picked(
        &split.model,
        &[(
            vertices_of(&split.upper_left),
            vertices_of(&split.lower_left),
        )],
    );
    assert!(state.grown_faces > 0, "the contact grew");
    assert_eq!(
        state.nodes.len(),
        25,
        "every bottom node of the upper block"
    );
    assert!(
        state.closed.iter().all(|&closed| closed),
        "every node closed"
    );
    let worst = state
        .pressure
        .iter()
        .map(|pressure| (pressure - (-TRACTION)).abs())
        .fold(0.0, f64::max);
    assert!(
        worst <= 1e-8 * TRACTION.abs(),
        "pressure error {worst:e} (pressures {:?})",
        state.pressure
    );
}

/// Bodies that do not overlap outside the picked faces keep them as they
/// are.
#[test]
fn a_contact_without_overlap_elsewhere_does_not_grow() {
    let model = pressed(Shape::Hex, Shape::Tet);
    let state = solve_picked(
        &model,
        &[(
            vertices_of(&model.upper_bottom),
            vertices_of(&model.lower_top),
        )],
    );
    assert_eq!(state.grown_faces, 0, "nothing overlaps outside the contact");
}

/// [`two_contacts_over_one_surface_split_in_two_act_as_one`], picked as the
/// app picks them: the two contacts share their edge, which is no overlap
/// to grow over.
#[test]
fn two_picked_contacts_split_in_two_act_as_one_and_do_not_grow() {
    let split = split();
    let state = solve_picked(
        &split.model,
        &[
            (
                vertices_of(&split.upper_left),
                vertices_of(&split.lower_left),
            ),
            (
                vertices_of(&split.upper_right),
                vertices_of(&split.lower_right),
            ),
        ],
    );
    let worst = state
        .pressure
        .iter()
        .map(|pressure| (pressure - (-TRACTION)).abs())
        .fold(0.0, f64::max);
    assert!(
        worst <= 1e-8 * TRACTION.abs(),
        "pressure error {worst:e}, grown {} (pressures {:?})",
        state.grown_faces,
        state.pressure
    );
    assert_eq!(state.grown_faces, 0, "the shared edge is no overlap");
}

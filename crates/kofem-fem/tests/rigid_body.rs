// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The rigid-body check that runs before a solve (KOF-388): which bodies the
//! supports, ties and couplings leave free to slide or spin, and along which
//! axes. Each case is a model whose free motions follow from the geometry by
//! inspection.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

use kofem_fem::{free_rigid_motions, FemError, FreeMotion, RigidBodyModel, RigidLink};

const ALONG_X: [f64; 3] = [1.0, 0.0, 0.0];
const ALONG_Y: [f64; 3] = [0.0, 1.0, 0.0];
const ALONG_Z: [f64; 3] = [0.0, 0.0, 1.0];

/// Connectivity and positions of a model under construction. Only which nodes
/// an element joins matters to the check, so a block is a grid of 8-node cells
/// and a plate a grid of triangles.
#[derive(Default)]
struct Model {
    positions: Vec<f64>,
    offsets: Vec<u32>,
    nodes: Vec<u32>,
    labels: Vec<u32>,
    rotational: Vec<u32>,
    links: Vec<RigidLink>,
    fixed: Vec<u32>,
}

impl Model {
    fn new() -> Self {
        Self {
            offsets: vec![0],
            ..Self::default()
        }
    }

    fn node(&mut self, point: [f64; 3]) -> u32 {
        let index = (self.positions.len() / 3) as u32;
        self.positions.extend_from_slice(&point);
        index
    }

    fn element(&mut self, nodes: &[u32], label: u32) {
        self.nodes.extend_from_slice(nodes);
        self.offsets.push(self.nodes.len() as u32);
        self.labels.push(label);
    }

    /// A block of `cells` unit cubes from `origin`, its own nodes.
    fn block(&mut self, origin: [f64; 3], cells: [usize; 3], label: u32) -> Vec<u32> {
        let [nx, ny, nz] = cells;
        let mut grid = Vec::new();
        for iz in 0..=nz {
            for iy in 0..=ny {
                for ix in 0..=nx {
                    grid.push(self.node([
                        origin[0] + ix as f64,
                        origin[1] + iy as f64,
                        origin[2] + iz as f64,
                    ]));
                }
            }
        }
        let at = |ix: usize, iy: usize, iz: usize| grid[ix + (nx + 1) * (iy + (ny + 1) * iz)];
        for iz in 0..nz {
            for iy in 0..ny {
                for ix in 0..nx {
                    let cell = [
                        at(ix, iy, iz),
                        at(ix + 1, iy, iz),
                        at(ix + 1, iy + 1, iz),
                        at(ix, iy + 1, iz),
                        at(ix, iy, iz + 1),
                        at(ix + 1, iy, iz + 1),
                        at(ix + 1, iy + 1, iz + 1),
                        at(ix, iy + 1, iz + 1),
                    ];
                    self.element(&cell, label);
                }
            }
        }
        grid
    }

    /// A flat plate of triangles in the plane z = `height`, x from `x0`, every
    /// node a shell node with rotations.
    fn plate(&mut self, x0: f64, height: f64, cells: [usize; 2], label: u32) -> Vec<u32> {
        let [nx, ny] = cells;
        let mut grid = Vec::new();
        for iy in 0..=ny {
            for ix in 0..=nx {
                let node = self.node([x0 + ix as f64, iy as f64, height]);
                self.rotational.push(node);
                grid.push(node);
            }
        }
        let at = |ix: usize, iy: usize| grid[ix + (nx + 1) * iy];
        for iy in 0..ny {
            for ix in 0..nx {
                self.element(&[at(ix, iy), at(ix + 1, iy), at(ix + 1, iy + 1)], label);
                self.element(&[at(ix, iy), at(ix + 1, iy + 1), at(ix, iy + 1)], label);
            }
        }
        grid
    }

    fn position(&self, node: u32) -> [f64; 3] {
        let start = 3 * node as usize;
        [
            self.positions[start],
            self.positions[start + 1],
            self.positions[start + 2],
        ]
    }

    /// The nodes of `nodes` whose coordinate `axis` equals `value`.
    fn on_plane(&self, nodes: &[u32], axis: usize, value: f64) -> Vec<u32> {
        nodes
            .iter()
            .copied()
            .filter(|&node| (self.position(node)[axis] - value).abs() < 1e-9)
            .collect()
    }

    fn fix(&mut self, nodes: &[u32], dofs: &[u32]) {
        for &node in nodes {
            for &dof in dofs {
                self.fixed.push(6 * node + dof);
            }
        }
    }

    fn free(&self) -> Vec<FreeMotion> {
        free_rigid_motions(&RigidBodyModel {
            positions: &self.positions,
            element_offsets: &self.offsets,
            element_nodes: &self.nodes,
            element_labels: &self.labels,
            rotational_nodes: &self.rotational,
            links: &self.links,
            fixed_dofs: &self.fixed,
        })
        .expect("a valid model")
    }
}

const XYZ: [u32; 3] = [0, 1, 2];
const ALL_SIX: [u32; 6] = [0, 1, 2, 3, 4, 5];

fn assert_axes(actual: &[[f64; 3]], expected: &[[f64; 3]]) {
    assert_eq!(actual.len(), expected.len(), "{actual:?} vs {expected:?}");
    for (got, want) in actual.iter().zip(expected) {
        for component in 0..3 {
            assert!(
                (got[component] - want[component]).abs() < 1e-9,
                "{actual:?} vs {expected:?}"
            );
        }
    }
}

fn assert_free(motion: &FreeMotion, labels: &[u32], along: &[[f64; 3]], about: &[[f64; 3]]) {
    assert_eq!(motion.labels, labels);
    assert_axes(&motion.translations, along);
    assert_axes(&motion.rotation_axes, about);
}

#[test]
fn a_clamped_face_holds_a_block() {
    let mut model = Model::new();
    let block = model.block([0.0; 3], [3, 1, 1], 1);
    let face = model.on_plane(&block, 0, 0.0);
    model.fix(&face, &XYZ);
    assert_eq!(model.free(), vec![]);
}

#[test]
fn an_unsupported_block_is_free_in_all_six() {
    let mut model = Model::new();
    model.block([0.0; 3], [2, 1, 1], 1);
    let free = model.free();
    assert_eq!(free.len(), 1);
    assert_free(
        &free[0],
        &[1],
        &[ALONG_X, ALONG_Y, ALONG_Z],
        &[ALONG_X, ALONG_Y, ALONG_Z],
    );
}

#[test]
fn a_roller_base_leaves_the_in_plane_motion() {
    let mut model = Model::new();
    let block = model.block([0.0; 3], [2, 2, 1], 1);
    let base = model.on_plane(&block, 2, 0.0);
    model.fix(&base, &[2]);
    let free = model.free();
    assert_eq!(free.len(), 1);
    assert_free(&free[0], &[1], &[ALONG_X, ALONG_Y], &[ALONG_Z]);
}

#[test]
fn one_pinned_node_leaves_every_rotation() {
    let mut model = Model::new();
    let block = model.block([0.0; 3], [2, 1, 1], 1);
    model.fix(&block[..1], &XYZ);
    let free = model.free();
    assert_eq!(free.len(), 1);
    assert_free(&free[0], &[1], &[], &[ALONG_X, ALONG_Y, ALONG_Z]);
}

#[test]
fn two_pins_leave_the_rotation_about_the_line_through_them() {
    let mut model = Model::new();
    let block = model.block([0.0; 3], [2, 1, 1], 1);
    // (0,0,0) and (2,0,0): a hinge along X.
    let pins = [block[0], block[2]];
    model.fix(&pins, &XYZ);
    let free = model.free();
    assert_eq!(free.len(), 1);
    assert_free(&free[0], &[1], &[], &[ALONG_X]);
}

#[test]
fn a_hinge_off_the_axes_is_given_as_its_direction() {
    let mut model = Model::new();
    let block = model.block([0.0; 3], [1, 1, 1], 1);
    // (0,0,0) and (1,1,0): a hinge along the diagonal of the base.
    let pins = [block[0], block[3]];
    model.fix(&pins, &XYZ);
    let free = model.free();
    assert_eq!(free.len(), 1);
    let diagonal = [0.5_f64.sqrt(), 0.5_f64.sqrt(), 0.0];
    assert_free(&free[0], &[1], &[], &[diagonal]);
}

#[test]
fn a_second_body_without_a_support_is_named() {
    let mut model = Model::new();
    let first = model.block([0.0; 3], [1, 1, 1], 1);
    model.block([5.0, 0.0, 0.0], [1, 1, 1], 2);
    let face = model.on_plane(&first, 0, 0.0);
    model.fix(&face, &XYZ);
    let free = model.free();
    assert_eq!(free.len(), 1);
    assert_free(
        &free[0],
        &[2],
        &[ALONG_X, ALONG_Y, ALONG_Z],
        &[ALONG_X, ALONG_Y, ALONG_Z],
    );
}

#[test]
fn bodies_that_share_nodes_hold_each_other() {
    let mut model = Model::new();
    let first = model.block([0.0; 3], [1, 1, 1], 1);
    let face = model.on_plane(&first, 0, 0.0);
    model.fix(&face, &XYZ);
    // The second body reuses the first one's face at x = 1: a conforming mesh.
    let shared = model.on_plane(&first, 0, 1.0);
    let far: Vec<u32> = shared
        .iter()
        .map(|&node| {
            let point = model.position(node);
            model.node([point[0] + 1.0, point[1], point[2]])
        })
        .collect();
    let cell = [
        shared[0], far[0], far[1], shared[1], shared[2], far[2], far[3], shared[3],
    ];
    model.element(&cell, 2);
    assert_eq!(model.free(), vec![]);
}

#[test]
fn a_tie_holds_a_body_through_its_partner() {
    let mut model = Model::new();
    let first = model.block([0.0; 3], [1, 1, 1], 1);
    let second = model.block([1.0, 0.0, 0.0], [1, 1, 1], 2);
    let face = model.on_plane(&first, 0, 0.0);
    model.fix(&face, &XYZ);
    model.links.push(RigidLink {
        primary: model.on_plane(&first, 0, 1.0),
        secondary: model.on_plane(&second, 0, 1.0),
        dof_mask: 0b111,
    });
    assert_eq!(model.free(), vec![]);
}

/// A reference point at (−1, 0.5, 0.5) gripping the block's face at x = 0.
fn coupled_block(fixed_dofs: &[u32]) -> Model {
    let mut model = Model::new();
    let block = model.block([0.0; 3], [2, 1, 1], 1);
    let reference = model.node([-1.0, 0.5, 0.5]);
    model.rotational.push(reference);
    model.links.push(RigidLink {
        primary: vec![reference],
        secondary: model.on_plane(&block, 0, 0.0),
        dof_mask: 0b111,
    });
    model.fix(&[reference], fixed_dofs);
    model
}

#[test]
fn a_clamped_reference_point_holds_the_body_it_grips() {
    assert_eq!(coupled_block(&ALL_SIX).free(), vec![]);
}

#[test]
fn a_reference_point_fixed_in_translation_only_lets_the_body_spin_about_it() {
    let free = coupled_block(&XYZ).free();
    assert_eq!(free.len(), 1);
    assert_free(&free[0], &[1], &[], &[ALONG_X, ALONG_Y, ALONG_Z]);
}

/// Two blocks, each gripped by a reference point, the points joined to each
/// other on `joint_dofs`. Only the first block is clamped.
fn jointed_blocks(joint_dofs: u8) -> Model {
    let mut model = Model::new();
    let first = model.block([0.0; 3], [1, 1, 1], 1);
    let second = model.block([3.0, 0.0, 0.0], [1, 1, 1], 2);
    let clamped = model.on_plane(&first, 0, 0.0);
    model.fix(&clamped, &XYZ);
    let joint = [2.0, 0.5, 0.5];
    let near = model.node(joint);
    let far = model.node(joint);
    model.rotational.extend([near, far]);
    model.links.push(RigidLink {
        primary: vec![near],
        secondary: model.on_plane(&first, 0, 1.0),
        dof_mask: 0b11_1111,
    });
    model.links.push(RigidLink {
        primary: vec![far],
        secondary: model.on_plane(&second, 0, 3.0),
        dof_mask: 0b11_1111,
    });
    model.links.push(RigidLink {
        primary: vec![near],
        secondary: vec![far],
        dof_mask: joint_dofs,
    });
    model
}

#[test]
fn a_rigid_point_to_point_joint_holds_the_second_body() {
    assert_eq!(jointed_blocks(0b11_1111).free(), vec![]);
}

#[test]
fn a_spherical_joint_lets_the_second_body_spin() {
    let free = jointed_blocks(0b111).free();
    assert_eq!(free.len(), 1);
    assert_free(&free[0], &[2], &[], &[ALONG_X, ALONG_Y, ALONG_Z]);
}

#[test]
fn a_shell_node_clamped_in_all_six_holds_the_plate() {
    let mut model = Model::new();
    let plate = model.plate(0.0, 0.0, [3, 2], 1);
    model.fix(&plate[..1], &ALL_SIX);
    assert_eq!(model.free(), vec![]);
}

#[test]
fn a_shell_node_pinned_in_translation_lets_the_plate_spin() {
    let mut model = Model::new();
    let plate = model.plate(0.0, 0.0, [3, 2], 1);
    model.fix(&plate[..1], &XYZ);
    let free = model.free();
    assert_eq!(free.len(), 1);
    assert_free(&free[0], &[1], &[], &[ALONG_X, ALONG_Y, ALONG_Z]);
}

#[test]
fn a_shell_coupled_to_a_solid_along_a_straight_seam_is_held() {
    // The plate's edge at x = 1 meets the block's edge along a line (the seam
    // of a shell welded to a solid). Translations alone along a line would
    // leave the rotation about it; the shell-to-solid coupling transfers the
    // rotation too.
    let mut model = Model::new();
    let block = model.block([0.0; 3], [1, 2, 1], 1);
    let clamped = model.on_plane(&block, 0, 0.0);
    model.fix(&clamped, &XYZ);
    let plate = model.plate(1.0, 1.0, [2, 2], 2);
    let edge = model.on_plane(&plate, 0, 1.0);
    for shell_node in edge {
        let point = model.position(shell_node);
        let solid_node = block
            .iter()
            .copied()
            .find(|&node| {
                let other = model.position(node);
                (0..3).all(|axis| (other[axis] - point[axis]).abs() < 1e-9)
            })
            .expect("a solid node under every seam node");
        model.links.push(RigidLink {
            primary: vec![shell_node],
            secondary: vec![solid_node],
            dof_mask: 0b11_1111,
        });
    }
    assert_eq!(model.free(), vec![]);
}

#[test]
fn a_support_on_a_node_outside_the_model_is_refused() {
    let mut model = Model::new();
    model.block([0.0; 3], [1, 1, 1], 1);
    model.fixed.push(6 * 999);
    let result = free_rigid_motions(&RigidBodyModel {
        positions: &model.positions,
        element_offsets: &model.offsets,
        element_nodes: &model.nodes,
        element_labels: &model.labels,
        rotational_nodes: &model.rotational,
        links: &model.links,
        fixed_dofs: &model.fixed,
    });
    assert!(
        matches!(result, Err(FemError::RigidBodyInput { .. })),
        "{result:?}"
    );
}

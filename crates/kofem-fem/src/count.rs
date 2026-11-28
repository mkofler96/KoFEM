// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The one place a count of things becomes a float, and an index a `u32`.

/// `count` as an `f64`, for averaging divisors, shares and ratios of counts,
/// and for counts and indices carried in a float array.
///
/// The conversion is exact: every count the solver and shell idealisation
/// take is bounded by a mesh, whose nodes are capped at
/// [`MAX_NODES`](crate::mesh::MAX_NODES) (so its DOFs fit in `u32`), far
/// below the 2^53 where an `f64` stops representing every integer.
#[must_use]
pub fn count_as_f64(count: usize) -> f64 {
    debug_assert!(
        u64::try_from(count).is_ok_and(|wide| wide < 1 << 53),
        "a count of {count} has no exact f64"
    );
    #[allow(
        clippy::cast_precision_loss,
        reason = "counts are bounded by MAX_NODES-sized meshes, far below 2^53"
    )]
    let exact = count as f64;
    exact
}

/// A node, DOF, row or aggregate number as the `u32` that sparse matrix
/// columns and the JS interface index with.
///
/// It fits: [`MAX_NODES`](crate::mesh::MAX_NODES) and
/// [`MAX_SHELL_VERTICES`](crate::shell::MAX_SHELL_VERTICES) cap every mesh
/// so that its DOF numbers fit in `u32`, and every such number is below the
/// DOF count.
#[must_use]
pub fn index_as_u32(index: usize) -> u32 {
    debug_assert!(
        u32::try_from(index).is_ok(),
        "index {index} does not fit in u32"
    );
    #[allow(
        clippy::cast_possible_truncation,
        reason = "mesh caps keep every node and DOF number within u32"
    )]
    let narrow = index as u32;
    narrow
}

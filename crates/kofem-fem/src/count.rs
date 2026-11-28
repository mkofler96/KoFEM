// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The one place a count of things becomes a float.

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

/// `index` (a node, or a count of nodes) as the `u32` the sparse matrices and
/// the JS interface carry. Exact for every node of a mesh: the mesh caps its
/// nodes at [`MAX_NODES`](crate::mesh::MAX_NODES), whose DOFs fit in `u32`.
#[must_use]
pub fn node_index(index: usize) -> u32 {
    u32::try_from(index)
        .unwrap_or_else(|_| unreachable!("node {index} is past MAX_NODES, which fits in u32"))
}

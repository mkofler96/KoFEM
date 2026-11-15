// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Distributing-coupling partner search shared by the shell↔solid seam and the
//! tie connections: which solid nodes each reference node ties to.

use crate::coupling_set::{CouplingKind, CouplingSet};
use crate::error::ShellizeError;
use crate::geometry::{dist2, Vec3};
use crate::grid::SpatialGrid;

/// Distance a coupling reference may reach to find its solid partners. It has
/// to span at least one solid element, otherwise a seam node on a coarse mesh
/// finds fewer than the three partners an RBE3/MPC needs.
#[must_use]
pub fn partner_search_radius(median_edge: f64, floor: f64) -> f64 {
    (2.0 * median_edge).max(floor).max(1e-9)
}

#[derive(Debug, Clone, Copy)]
struct Candidate {
    node: usize,
    distance2: f64,
}

/// Pick at most `budget` candidates, keeping the PATCH WIDE: the nearest first
/// (the MPC tie needs it), then repeatedly the candidate farthest from all
/// chosen so far (farthest-point sampling). The `budget` nearest would shrink
/// the patch with the element size and drive the RBE3 inertia toward its
/// singular limit as the mesh is refined.
fn spread_patch(
    candidates: &[Candidate],
    budget: usize,
    point: &impl Fn(usize) -> Vec3,
) -> Vec<usize> {
    if candidates.len() <= budget {
        return candidates.iter().map(|candidate| candidate.node).collect();
    }
    let Some(nearest) = candidates.iter().copied().reduce(|best, next| {
        if best.distance2 <= next.distance2 {
            best
        } else {
            next
        }
    }) else {
        return Vec::new();
    };
    let mut chosen = vec![nearest.node];
    let rest: Vec<usize> = candidates
        .iter()
        .map(|candidate| candidate.node)
        .filter(|&node| node != nearest.node)
        .collect();
    let mut separation: Vec<f64> = rest
        .iter()
        .map(|&node| dist2(point(node), point(nearest.node)))
        .collect();
    while chosen.len() < budget {
        let mut best: Option<usize> = None;
        for (i, &value) in separation.iter().enumerate() {
            let threshold = best.map_or(-1.0, |index| separation[index]);
            if value > threshold {
                best = Some(i);
            }
        }
        let Some(best) = best else { break };
        let picked = rest[best];
        chosen.push(picked);
        separation[best] = -1.0; // never picked again
        for (i, value) in separation.iter_mut().enumerate() {
            if *value >= 0.0 {
                *value = value.min(dist2(point(rest[i]), point(picked)));
            }
        }
    }
    chosen
}

/// Distributing couplings: every reference node with ≥ 3 solid nodes within
/// `radius` ties to (at most `max_coupled_nodes` of, chosen for spread) them.
/// The RBE3 expansion is quadratic in the partner count, so the budget keeps a
/// fine mesh from dominating the solve.
///
/// # Errors
/// A radius that is not positive and finite.
pub fn auto_detect_couplings(
    point: &impl Fn(usize) -> Vec3,
    solid_nodes: &[usize],
    references: &[usize],
    radius: f64,
    max_coupled_nodes: usize,
) -> Result<CouplingSet, ShellizeError> {
    let grid = SpatialGrid::new(solid_nodes.iter().copied(), point, radius)?;
    let radius2 = radius * radius;
    let mut coupling = CouplingSet::default();
    for &reference in references {
        let position = point(reference);
        let near: Vec<Candidate> = grid
            .candidates(position, 1, 0)
            .map(|node| Candidate {
                node,
                distance2: dist2(position, point(node)),
            })
            .filter(|candidate| candidate.distance2 <= radius2)
            .collect();
        if near.len() >= 3 {
            let partners = spread_patch(&near, max_coupled_nodes, point);
            coupling.push_unweighted(reference, &partners, CouplingKind::Distributing);
        }
    }
    Ok(coupling)
}

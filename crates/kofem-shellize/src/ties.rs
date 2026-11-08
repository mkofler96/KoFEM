// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Tie connections the user declared between solid bodies, turned into
//! distributing couplings — with a report of what each one contributed.

use std::collections::HashSet;

use crate::coupling_set::CouplingSet;
use crate::error::ShellizeError;
use crate::geometry::{dist2, OrderedMap, Vec3};
use crate::grid::SpatialGrid;
use crate::partners::{auto_detect_couplings, partner_search_radius};

/// One tie connection over store vertex indices: the two picked surfaces and
/// how far the tie reaches (`f64::INFINITY` couples the full surface).
#[derive(Debug, Clone, PartialEq)]
pub struct TieSurfaces {
    pub name: String,
    pub vertices_a: Vec<usize>,
    pub vertices_b: Vec<usize>,
    pub max_separation: f64,
}

/// Which picked surface(s) had no node in the solved pool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TieSide {
    SurfaceA,
    SurfaceB,
    Both,
}

/// Why a tie connection coupled nothing — each has a different fix (KOF-203).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TieCouplingDrop {
    /// One or both picked surfaces contributed no node to the solved pool.
    NoPoolNodes { side: TieSide },
    /// The two surfaces never saw each other, even after widening the search.
    OutOfReach { searched: f64 },
    /// They meet, but no closer than the connection's own search distance.
    BeyondSearchDistance { gap: f64, reach: f64 },
    /// In range, but no reference found the three partners an RBE3 needs.
    TooFewPartners { refs: usize, radius: f64 },
}

/// What one tie connection contributed to the coupled model.
#[derive(Debug, Clone, PartialEq)]
pub struct TieCouplingReport {
    pub name: String,
    /// Reference nodes that got a distributing coupling.
    pub coupled: usize,
    /// Partner slots those references distribute onto.
    pub partners: usize,
    /// Nodes the two surfaces already share.
    pub shared: usize,
    /// Measured closest approach, 0 when never measured.
    pub gap: f64,
    pub drop: Option<TieCouplingDrop>,
}

impl TieCouplingReport {
    /// The sentence for a connection that coupled nothing, or `None` when it
    /// did. Shared nodes are rigidly joined already, so a connection that only
    /// shares is connected, not dropped.
    #[must_use]
    pub fn problem(&self) -> Option<String> {
        if self.coupled > 0 || self.shared > 0 {
            return None;
        }
        let drop = self.drop?;
        let head = format!("Tie \"{}\" coupled no nodes", self.name);
        Some(match drop {
            TieCouplingDrop::NoPoolNodes { side } => {
                let which = match side {
                    TieSide::Both => "neither picked surface has a node".to_owned(),
                    TieSide::SurfaceA => "picked surface A has no node".to_owned(),
                    TieSide::SurfaceB => "picked surface B has no node".to_owned(),
                };
                format!(
                    "{head} — {which} in the solved model. Re-pick its surfaces after \
                     remeshing, or mark the body Solid if the tie lands on a wall that was \
                     idealised as shell."
                )
            }
            TieCouplingDrop::OutOfReach { searched } => format!(
                "{head} — its two surfaces are more than {searched:.4} mm apart. They are not \
                 the surfaces that touch; re-pick them."
            ),
            TieCouplingDrop::BeyondSearchDistance { gap, reach } => format!(
                "{head} — its surfaces come no closer than {gap:.4} mm, beyond its {reach:.4} mm \
                 search distance. Increase the distance, or couple the full surface."
            ),
            TieCouplingDrop::TooFewPartners { refs, radius } => format!(
                "{head} — none of its {refs} in-range reference node(s) found the three partners \
                 a distributing coupling needs within {radius:.4} mm. Refine the mesh on the \
                 other surface, or pick more of it."
            ),
        })
    }
}

/// One tie connection mapped onto pool nodes: surface A becomes the coupling
/// partners, surface B the references.
#[derive(Debug, Clone, PartialEq)]
pub struct PoolTie {
    pub name: String,
    pub masters: Vec<usize>,
    pub refs: Vec<usize>,
    pub reach: f64,
}

/// Distance from each ref node to its nearest master node, for the refs that
/// have one within `reach`, in ref order. Grid cells are `reach` wide, so the
/// 27-cell scan sees every candidate in range.
fn nearest_master_distances(
    point: &impl Fn(usize) -> Vec3,
    masters: &[usize],
    refs: &[usize],
    reach: f64,
) -> Result<OrderedMap<usize, f64>, ShellizeError> {
    let mut out = OrderedMap::new();
    if masters.is_empty() || refs.is_empty() || reach.is_nan() || reach <= 0.0 {
        return Ok(out);
    }
    let grid = SpatialGrid::new(masters.iter().copied(), point, reach)?;
    let reach2 = reach * reach;
    for &reference in refs {
        let position = point(reference);
        let best = grid
            .candidates(position, 1, 0)
            .map(|node| dist2(position, point(node)))
            .fold(f64::INFINITY, f64::min);
        if best <= reach2 {
            out.insert(reference, best.sqrt());
        }
    }
    Ok(out)
}

/// Distributing (RBE3) ties for the declared connections: the nodes of surface
/// B become references, each distributing onto the surface-A nodes around it,
/// transmitting force and moment across a clearance without merging meshes.
///
/// Two distances, both derived: the gap — the measured closest approach, found
/// by doubling the search until the surfaces see each other — and the partner
/// radius ([`partner_search_radius`]). A "within distance" connection keeps
/// only the references within its search distance of the other surface. Every
/// connection gets a report; one that coupled nothing is a missing load path
/// the caller refuses (KOF-203).
///
/// # Errors
/// A degenerate grid size.
pub fn tie_couplings(
    point: &impl Fn(usize) -> Vec3,
    ties: &[PoolTie],
    median_edge: f64,
    max_coupled_nodes: usize,
) -> Result<(CouplingSet, Vec<TieCouplingReport>), ShellizeError> {
    let mut all = CouplingSet::default();
    let mut reports = Vec::with_capacity(ties.len());
    for tie in ties {
        // Shared nodes are rigidly joined through the common pool DOFs, and a
        // coupling reference must not also be a partner.
        let ref_set: HashSet<usize> = tie.refs.iter().copied().collect();
        let shared: HashSet<usize> = tie
            .masters
            .iter()
            .copied()
            .filter(|node| ref_set.contains(node))
            .collect();
        let masters: Vec<usize> = tie
            .masters
            .iter()
            .copied()
            .filter(|node| !shared.contains(node))
            .collect();
        let refs: Vec<usize> = tie
            .refs
            .iter()
            .copied()
            .filter(|node| !shared.contains(node))
            .collect();
        let base = TieCouplingReport {
            name: tie.name.clone(),
            coupled: 0,
            partners: 0,
            shared: shared.len(),
            gap: 0.0,
            drop: None,
        };
        let dropped = |drop: TieCouplingDrop, gap: f64| TieCouplingReport {
            gap,
            drop: Some(drop),
            ..base.clone()
        };
        if masters.is_empty() || refs.is_empty() {
            let side = match (masters.is_empty(), refs.is_empty()) {
                (true, true) => TieSide::Both,
                (true, false) => TieSide::SurfaceA,
                _ => TieSide::SurfaceB,
            };
            reports.push(dropped(TieCouplingDrop::NoPoolNodes { side }, 0.0));
            continue;
        }

        let mut distances = OrderedMap::new();
        let mut searched = 0.0;
        let mut reach = (2.0 * median_edge).max(1e-9);
        for _ in 0..=6 {
            searched = reach;
            distances = nearest_master_distances(point, &masters, &refs, reach)?;
            if !distances.is_empty() {
                break;
            }
            reach *= 2.0;
        }
        if distances.is_empty() {
            reports.push(dropped(TieCouplingDrop::OutOfReach { searched }, 0.0));
            continue;
        }

        let gap = distances.values().copied().fold(f64::INFINITY, f64::min);
        let kept: Vec<usize> = distances
            .iter()
            .filter(|(_, &distance)| distance <= tie.reach)
            .map(|(&node, _)| node)
            .collect();
        if kept.is_empty() {
            reports.push(dropped(
                TieCouplingDrop::BeyondSearchDistance {
                    gap,
                    reach: tie.reach,
                },
                gap,
            ));
            continue;
        }

        let radius = partner_search_radius(median_edge, gap);
        let one = auto_detect_couplings(point, &masters, &kept, radius, max_coupled_nodes)?;
        if one.is_empty() {
            reports.push(dropped(
                TieCouplingDrop::TooFewPartners {
                    refs: kept.len(),
                    radius,
                },
                gap,
            ));
            continue;
        }
        reports.push(TieCouplingReport {
            gap,
            coupled: one.len(),
            partners: one.partner.len(),
            ..base.clone()
        });
        all = all.concat(&one);
    }
    Ok((all, reports))
}

/// Map each connection's picked surfaces from store vertex indices onto pool
/// nodes. A vertex with no pool node is skipped (on the auto-shell path the
/// walls it covered became mid-surface nodes, which the seam ties); a surface
/// left with no pool node at all is reported as a dropped tie.
#[must_use]
pub fn ties_to_pool(
    ties: &[TieSurfaces],
    pool_of_vertex: impl Fn(usize) -> Option<usize>,
) -> Vec<PoolTie> {
    let to_pool = |vertices: &[usize]| -> Vec<usize> {
        vertices
            .iter()
            .filter_map(|&vertex| pool_of_vertex(vertex))
            .collect()
    };
    ties.iter()
        .map(|tie| PoolTie {
            name: tie.name.clone(),
            masters: to_pool(&tie.vertices_a),
            refs: to_pool(&tie.vertices_b),
            reach: tie.max_separation,
        })
        .collect()
}

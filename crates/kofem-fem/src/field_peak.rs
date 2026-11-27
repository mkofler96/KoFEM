// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Where a nodal field peaks, and which idealised supports and loads sit on
//! that node (KOF-495).
//!
//! An idealised support or load concentrates the stress where it is applied:
//! a clamp pins its surface in its own plane, and a point, or a line on a
//! solid, carries its force on no area. The peak there grows as the mesh is
//! refined and says little about the part, so Results name the group and
//! point to the volume percentile instead (`field_statistics`). A symmetry or
//! roller support leaves its surface free to slide, and a load spread over a
//! face, or over a shell's edge (the boundary of the plate), loads the part as
//! it is loaded: a peak there is a real stress, such as the hole edge of a
//! plate on its symmetry line or the bore of a pressurised cylinder.

use std::collections::HashSet;

use crate::error::FemError;

/// What the user picked for a selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickGeometry {
    Face,
    Edge,
    Point,
    /// Saved before the pick kind was recorded: a face or an edge, which the
    /// node set cannot tell apart. It is read as a face, so the note stays
    /// silent rather than call a real stress a singularity.
    Unrecorded,
}

/// One pick of a group: its kind and its node indices.
#[derive(Debug, Clone, PartialEq)]
pub struct Selection {
    pub geometry: PickGeometry,
    pub nodes: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Condition {
    /// The held degrees of freedom: 0–2 translations, 3–5 rotations.
    Support {
        dofs: Vec<u32>,
    },
    Load,
}

/// A support or load group.
#[derive(Debug, Clone, PartialEq)]
pub struct BoundaryGroup {
    pub condition: Condition,
    pub selections: Vec<Selection>,
}

/// A coupling's reference point and the surface nodes it is coupled to. A
/// support on the reference point holds that surface; a load on it is spread
/// over the surface.
#[derive(Debug, Clone, PartialEq)]
pub struct CouplingSurface {
    pub reference: u32,
    pub nodes: Vec<u32>,
}

/// The nodal field (x, y, z per node, one value per node), the shell facets
/// (three node indices each), and the support, load and coupling groups.
#[derive(Debug, Clone, Copy)]
pub struct PeakInput<'a> {
    pub points: &'a [f64],
    pub values: &'a [f64],
    pub shell_triangles: &'a [u32],
    pub groups: &'a [BoundaryGroup],
    pub couplings: &'a [CouplingSurface],
}

/// The node where the field is largest.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldPeak {
    /// Its index; the first such node on a tie, as the Results min and max
    /// rows take it.
    pub node: usize,
    /// Its coordinates.
    pub at: [f64; 3],
    pub value: f64,
    /// The idealised groups that hold the node, by index in `groups`, in
    /// ascending order.
    pub idealised: Vec<usize>,
}

const TRANSLATIONS: [u32; 3] = [0, 1, 2];
const DOFS_PER_NODE: u32 = 6;

fn invalid(reason: String) -> FemError {
    FemError::StatisticsInput { reason }
}

fn check_nodes(what: &str, nodes: &[u32], node_count: usize) -> Result<(), FemError> {
    match nodes.iter().find(|&&node| node as usize >= node_count) {
        Some(node) => Err(invalid(format!(
            "{what} holds node {node}, but the model has {node_count} nodes"
        ))),
        None => Ok(()),
    }
}

fn check_input(input: &PeakInput<'_>) -> Result<(), FemError> {
    if !input.points.len().is_multiple_of(3) {
        return Err(invalid(format!(
            "{} coordinates, which is not a multiple of 3",
            input.points.len()
        )));
    }
    let node_count = input.points.len() / 3;
    if node_count == 0 {
        return Err(invalid("the field has no nodes".to_owned()));
    }
    if input.values.len() != node_count {
        return Err(invalid(format!(
            "{} values for {node_count} nodes",
            input.values.len()
        )));
    }
    if let Some(node) = input.values.iter().position(|value| !value.is_finite()) {
        return Err(invalid(format!(
            "node {node} has the non-finite value {}",
            input.values[node]
        )));
    }
    if !input.shell_triangles.len().is_multiple_of(3) {
        return Err(invalid(format!(
            "{} shell facet indices, which is not a multiple of 3",
            input.shell_triangles.len()
        )));
    }
    check_nodes("a shell facet", input.shell_triangles, node_count)?;
    for group in input.groups {
        if let Condition::Support { dofs } = &group.condition {
            if let Some(dof) = dofs.iter().find(|&&dof| dof >= DOFS_PER_NODE) {
                return Err(invalid(format!(
                    "a support holds dof {dof}; a node has dofs 0 to 5"
                )));
            }
        }
        for selection in &group.selections {
            check_nodes("a selection", &selection.nodes, node_count)?;
        }
    }
    for coupling in input.couplings {
        check_nodes("a coupling", &[coupling.reference], node_count)?;
        check_nodes("a coupling", &coupling.nodes, node_count)?;
    }
    Ok(())
}

/// Whether `selection` concentrates its support or load: a point, or an edge
/// with a node off every shell facet, which is a line on a solid.
fn concentrated(selection: &Selection, shell_nodes: &HashSet<u32>) -> bool {
    match selection.geometry {
        PickGeometry::Point => true,
        PickGeometry::Edge => !selection
            .nodes
            .iter()
            .all(|node| shell_nodes.contains(node)),
        PickGeometry::Face | PickGeometry::Unrecorded => false,
    }
}

/// Whether the idealised part of `group` holds `node`.
fn holds(
    group: &BoundaryGroup,
    node: u32,
    shell_nodes: &HashSet<u32>,
    couplings: &[CouplingSurface],
) -> bool {
    let (clamp, through_coupling) = match &group.condition {
        Condition::Support { dofs } => (TRANSLATIONS.iter().all(|dof| dofs.contains(dof)), true),
        Condition::Load => (false, false),
    };
    group
        .selections
        .iter()
        .filter(|selection| clamp || concentrated(selection, shell_nodes))
        .flat_map(|selection| &selection.nodes)
        .any(|&member| {
            member == node
                || (through_coupling
                    && couplings.iter().any(|coupling| {
                        coupling.reference == member && coupling.nodes.contains(&node)
                    }))
        })
}

/// The node where `input.values` is largest, its coordinates, and the
/// idealised groups that hold it.
///
/// # Errors
/// [`FemError::StatisticsInput`] for a field without nodes, coordinates not in
/// triples, a value count that differs from the node count, a non-finite
/// value, shell facets not in triples, a support dof above 5, or a shell
/// facet, selection or coupling on a node the model does not have.
pub fn field_peak(input: &PeakInput<'_>) -> Result<FieldPeak, FemError> {
    check_input(input)?;
    let mut node = 0;
    for (candidate, &value) in input.values.iter().enumerate() {
        if value > input.values[node] {
            node = candidate;
        }
    }
    let peak = u32::try_from(node)
        .map_err(|_| invalid(format!("node {node} does not fit a 32-bit index")))?;
    let shell_nodes: HashSet<u32> = input.shell_triangles.iter().copied().collect();
    let idealised = input
        .groups
        .iter()
        .enumerate()
        .filter(|(_, group)| holds(group, peak, &shell_nodes, input.couplings))
        .map(|(index, _)| index)
        .collect();
    let at = 3 * node;
    Ok(FieldPeak {
        node,
        at: [input.points[at], input.points[at + 1], input.points[at + 2]],
        value: input.values[node],
        idealised,
    })
}

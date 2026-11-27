// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Where a nodal field peaks, and which support or load selections hold that
//! node (KOF-495).
//!
//! An idealised support or load concentrates the stress on the nodes it is
//! applied to: the fixed face's rim, a loaded edge, a point. The peak there
//! grows as the mesh is refined and says little about the part, so Results
//! name the selection and point to the volume percentile instead
//! (`field_statistics`). A selection's nodes include its rim, so a peak on the
//! edge of a fixed face counts as on that support.

use crate::error::FemError;

/// The nodal field (x, y, z per node, one value per node) and the support and
/// load selections, each a list of node indices: selection `k` holds
/// `selection_nodes[selection_offsets[k]..selection_offsets[k + 1]]`.
#[derive(Debug, Clone, Copy)]
pub struct PeakInput<'a> {
    pub points: &'a [f64],
    pub values: &'a [f64],
    /// One more than the number of selections: starts at 0, never decreases,
    /// ends at `selection_nodes.len()`.
    pub selection_offsets: &'a [u32],
    pub selection_nodes: &'a [u32],
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
    /// The selections that hold the node, in ascending order.
    pub selections: Vec<usize>,
}

fn invalid(reason: String) -> FemError {
    FemError::StatisticsInput { reason }
}

fn check_selections(input: &PeakInput<'_>, node_count: usize) -> Result<(), FemError> {
    let offsets = input.selection_offsets;
    if offsets.first() != Some(&0) {
        return Err(invalid("the selection offsets must start at 0".to_owned()));
    }
    if offsets.windows(2).any(|pair| pair[1] < pair[0]) {
        return Err(invalid(
            "the selection offsets must not decrease".to_owned(),
        ));
    }
    let listed = input.selection_nodes.len();
    if offsets.last().map(|&end| end as usize) != Some(listed) {
        return Err(invalid(format!(
            "the selection offsets must end at {listed}, the number of selection nodes"
        )));
    }
    if let Some(&node) = input
        .selection_nodes
        .iter()
        .find(|&&node| node as usize >= node_count)
    {
        return Err(invalid(format!(
            "a selection holds node {node}, but the model has {node_count} nodes"
        )));
    }
    Ok(())
}

/// The node where `input.values` is largest, its coordinates, and the
/// selections that hold it.
///
/// # Errors
/// [`FemError::StatisticsInput`] for a field without nodes, coordinates not in
/// triples, a value count that differs from the node count, a non-finite
/// value, offsets that do not start at 0, decrease or do not end at the
/// number of selection nodes, or a selection on a node the model does not
/// have.
pub fn field_peak(input: &PeakInput<'_>) -> Result<FieldPeak, FemError> {
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
    check_selections(input, node_count)?;

    let mut node = 0;
    for (candidate, &value) in input.values.iter().enumerate() {
        if value > input.values[node] {
            node = candidate;
        }
    }
    let selections = input
        .selection_offsets
        .windows(2)
        .enumerate()
        .filter(|(_, range)| {
            input.selection_nodes[range[0] as usize..range[1] as usize]
                .iter()
                .any(|&member| member as usize == node)
        })
        .map(|(selection, _)| selection)
        .collect();
    let at = 3 * node;
    Ok(FieldPeak {
        node,
        at: [input.points[at], input.points[at + 1], input.points[at + 2]],
        value: input.values[node],
        selections,
    })
}

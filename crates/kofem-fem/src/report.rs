// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The numbers of the analysis report (KOF-391), read from the nodal fields
//! the app draws: the largest displacement, and the largest and the
//! 99th-percentile von Mises stress. The percentile says how high the stress
//! runs away from the one node a singularity can put the peak on.

use crate::FemError;

/// The report's result numbers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReportStats {
    /// The largest displacement magnitude |u|.
    pub max_displacement: f64,
    /// The node (index in the field) where it occurs.
    pub max_displacement_node: usize,
    /// The largest von Mises stress.
    pub max_von_mises: f64,
    /// The 99th percentile of the von Mises stress over the nodes.
    pub p99_von_mises: f64,
}

fn refuse(reason: impl Into<String>) -> FemError {
    FemError::ReportField {
        reason: reason.into(),
    }
}

fn check_finite(values: &[f64], what: &str) -> Result<(), FemError> {
    if values.is_empty() {
        return Err(refuse(format!("the {what} has no values")));
    }
    match values.iter().position(|value| !value.is_finite()) {
        Some(index) => Err(refuse(format!("the {what} is not finite at value {index}"))),
        None => Ok(()),
    }
}

/// The `percent`-th percentile (0–100) of `values`, interpolated linearly
/// between the order statistics: rank `percent / 100 · (n − 1)` from the
/// smallest.
///
/// # Errors
/// [`FemError::ReportField`] for no values, a value that is not finite, or
/// `percent` outside 0–100.
pub fn percentile(values: &[f64], percent: f64) -> Result<f64, FemError> {
    if values.is_empty() {
        return Err(refuse("the field has no values"));
    }
    check_finite(values, "field")?;
    if !(0.0..=100.0).contains(&percent) {
        return Err(refuse(format!("percentile {percent} lies outside 0–100")));
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a node count is far below 2^52, and the floor of a rank in 0..n−1 is a valid index"
    )]
    {
        let rank = percent / 100.0 * (sorted.len() - 1) as f64;
        let below = rank.floor() as usize;
        let above = (below + 1).min(sorted.len() - 1);
        let fraction = rank - below as f64;
        Ok(sorted[below] + fraction * (sorted[above] - sorted[below]))
    }
}

/// The report's numbers from the nodal displacements (x, y, z per node) and
/// the nodal von Mises stress.
///
/// # Errors
/// [`FemError::ReportField`] for an empty field, a displacement array that is
/// not three values per node, or a value that is not finite.
pub fn report_stats(displacements: &[f64], von_mises: &[f64]) -> Result<ReportStats, FemError> {
    check_finite(displacements, "displacement field")?;
    if !displacements.len().is_multiple_of(3) {
        return Err(refuse(format!(
            "the displacement field has {} values, which is not three per node",
            displacements.len()
        )));
    }
    check_finite(von_mises, "von Mises field")?;
    let (nodal, _) = displacements.as_chunks::<3>();
    let (max_displacement_node, max_displacement) = nodal
        .iter()
        .map(|[ux, uy, uz]| (ux * ux + uy * uy + uz * uz).sqrt())
        .enumerate()
        .fold((0, f64::NEG_INFINITY), |best, (node, magnitude)| {
            if magnitude > best.1 {
                (node, magnitude)
            } else {
                best
            }
        });
    let max_von_mises = von_mises.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    Ok(ReportStats {
        max_displacement,
        max_displacement_node,
        max_von_mises,
        p99_von_mises: percentile(von_mises, 99.0)?,
    })
}

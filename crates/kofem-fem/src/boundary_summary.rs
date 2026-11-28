// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! What a support or load group card says it applies (KOF-494): the area of
//! its CAD faces and a load's total and mean traction, so a wrong unit or a
//! face picked twice shows before the solve. The face areas are the engine's
//! measure of the exact CAD faces (`cad_face_properties`, KOF-493), the same
//! the status bar shows for a picked face.

use std::collections::BTreeMap;

use crate::{count_as_f64, FemError};

fn refuse(reason: impl Into<String>) -> FemError {
    FemError::BoundarySummary {
        reason: reason.into(),
    }
}

/// The area a group's CAD faces cover.
#[derive(Debug, Clone, PartialEq)]
pub struct SelectedArea {
    /// The sum of the distinct faces' areas.
    pub area: f64,
    /// How many distinct faces that is.
    pub faces: usize,
    /// The faces selected more than once, ascending. Each is counted once in
    /// `area`, as the solve integrates each element face of a group once.
    pub repeated: Vec<u32>,
}

/// The area of the CAD faces `selected` (ids from 1) out of `face_areas`
/// (one per CAD face, in id order), each face counted once.
///
/// # Errors
/// [`FemError::BoundarySummary`] for no face, a face id the geometry does not
/// have, or a face whose area is not positive and finite.
pub fn selected_area(face_areas: &[f64], selected: &[u32]) -> Result<SelectedArea, FemError> {
    if selected.is_empty() {
        return Err(refuse("no face is selected"));
    }
    let mut picks: BTreeMap<u32, usize> = BTreeMap::new();
    for &face in selected {
        *picks.entry(face).or_default() += 1;
    }
    let mut area = 0.0;
    for &face in picks.keys() {
        let index = usize::try_from(face)
            .ok()
            .and_then(|id| id.checked_sub(1))
            .filter(|&index| index < face_areas.len())
            .ok_or_else(|| {
                refuse(format!(
                    "face {face} is selected, but the geometry has faces 1 to {}",
                    face_areas.len()
                ))
            })?;
        let face_area = face_areas[index];
        if !(face_area.is_finite() && face_area > 0.0) {
            return Err(refuse(format!("face {face} has area {face_area}")));
        }
        area += face_area;
    }
    Ok(SelectedArea {
        area,
        faces: picks.len(),
        repeated: picks
            .iter()
            .filter(|&(_, &count)| count > 1)
            .map(|(&face, _)| face)
            .collect(),
    })
}

fn check_area(area: Option<f64>) -> Result<(), FemError> {
    match area {
        Some(area) if !(area.is_finite() && area > 0.0) => {
            Err(refuse(format!("the load's area is {area}")))
        }
        _ => Ok(()),
    }
}

// A load's size, or `None` for a load of zero, which has nothing to show.
fn size(size: f64, what: &str) -> Result<Option<f64>, FemError> {
    if !size.is_finite() {
        return Err(refuse(format!("the {what} is {size}")));
    }
    Ok((size != 0.0).then_some(size))
}

fn magnitude(vector: [f64; 3]) -> f64 {
    vector
        .iter()
        .map(|component| component * component)
        .sum::<f64>()
        .sqrt()
}

/// What a force group applies.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ForceSummary {
    /// The force's magnitude |F| (N): the total the solve spreads over the
    /// group's faces as a uniform traction.
    pub total: f64,
    /// |F| over the area (N/mm²); `None` on an area not known.
    pub mean_traction: Option<f64>,
}

/// What the force vector `force` (N) applies over `area` (mm²), `None` where
/// the selection's area is not known (a point, or a region picked node by
/// node). `Ok(None)` for a force of zero.
///
/// # Errors
/// [`FemError::BoundarySummary`] for an area that is not positive and finite,
/// or a component that is not finite.
pub fn force_summary(force: [f64; 3], area: Option<f64>) -> Result<Option<ForceSummary>, FemError> {
    check_area(area)?;
    Ok(size(magnitude(force), "force")?.map(|total| ForceSummary {
        total,
        mean_traction: area.map(|area| total / area),
    }))
}

/// What a moment group applies.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MomentSummary {
    /// The moment's magnitude |M| (N·mm).
    pub each: f64,
    /// How many times the solve applies it.
    pub applied: usize,
    /// |M| times `applied`.
    pub total: f64,
}

/// What the moment vector `moment` (N·mm) applies when the solve applies it
/// `applied` times: in full on each face selection (`momentToNodalForces` in
/// the app), and once shared by the group's point selections. `area` is
/// checked as for a force. `Ok(None)` for a moment of zero.
///
/// # Errors
/// [`FemError::BoundarySummary`] for an area that is not positive and finite,
/// a component that is not finite, or a moment applied to no selection.
pub fn moment_summary(
    moment: [f64; 3],
    applied: usize,
    area: Option<f64>,
) -> Result<Option<MomentSummary>, FemError> {
    check_area(area)?;
    if applied == 0 {
        return Err(refuse("the moment is applied to no selection"));
    }
    Ok(
        size(magnitude(moment), "moment")?.map(|each| MomentSummary {
            each,
            applied,
            total: each * count_as_f64(applied),
        }),
    )
}

/// What a pressure group applies.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PressureSummary {
    /// The pressure (N/mm²), positive pushing in.
    pub pressure: f64,
    /// The pressure times the area (N), signed like it; `None` on an area
    /// not known.
    pub total: Option<f64>,
}

/// What `pressure` (N/mm²) applies over `area` (mm²), `None` where the
/// selection's area is not known. `Ok(None)` for a pressure of zero.
///
/// # Errors
/// [`FemError::BoundarySummary`] for an area that is not positive and finite,
/// or a pressure that is not finite.
pub fn pressure_summary(
    pressure: f64,
    area: Option<f64>,
) -> Result<Option<PressureSummary>, FemError> {
    check_area(area)?;
    Ok(size(pressure, "pressure")?.map(|pressure| PressureSummary {
        pressure,
        total: area.map(|area| pressure * area),
    }))
}

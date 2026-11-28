// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! What a support or load group card says it applies (KOF-494): the area of
//! its CAD faces and a load's total and mean traction, so a wrong unit or a
//! face picked twice shows before the solve. The face areas are the engine's
//! measure of the exact CAD faces (`cad_face_properties`, KOF-493), the same
//! the status bar shows for a picked face.

use std::collections::BTreeMap;

use crate::FemError;

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

/// A load group's value, as the solve takes it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LoadValue {
    /// The total force vector (N), spread over the faces as a uniform traction.
    Force([f64; 3]),
    /// The total moment vector (N·mm).
    Moment([f64; 3]),
    /// The pressure (N/mm²) on every face, positive pushing in.
    Pressure(f64),
}

/// What a load applies over its area.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoadSummary {
    /// A force's or moment's magnitude, or a pressure times the area: the
    /// total force it pushes with, signed like the pressure. A pressure on an
    /// area that is not known has none.
    pub total: Option<f64>,
    /// The force per unit area (N/mm²): a force's magnitude over the area, or
    /// the pressure. A moment has none, nor a force on an area not known.
    pub mean_traction: Option<f64>,
}

fn magnitude(vector: [f64; 3]) -> f64 {
    vector
        .iter()
        .map(|component| component * component)
        .sum::<f64>()
        .sqrt()
}

/// What `value` applies over `area` (mm²); `None` where the selection's area
/// is not known (a picked point, edge or mesh region rather than CAD faces).
///
/// # Errors
/// [`FemError::BoundarySummary`] for an area that is not positive and finite,
/// or a value that is zero or not finite: such a load has nothing to show.
pub fn load_summary(value: LoadValue, area: Option<f64>) -> Result<LoadSummary, FemError> {
    if let Some(area) = area {
        if !(area.is_finite() && area > 0.0) {
            return Err(refuse(format!("the load's area is {area}")));
        }
    }
    let size = match value {
        LoadValue::Force(vector) | LoadValue::Moment(vector) => magnitude(vector),
        LoadValue::Pressure(pressure) => pressure.abs(),
    };
    if !size.is_finite() || size == 0.0 {
        return Err(refuse(format!("the load's value {value:?} has no size")));
    }
    Ok(match value {
        LoadValue::Force(_) => LoadSummary {
            total: Some(size),
            mean_traction: area.map(|area| size / area),
        },
        LoadValue::Moment(_) => LoadSummary {
            total: Some(size),
            mean_traction: None,
        },
        LoadValue::Pressure(pressure) => LoadSummary {
            total: area.map(|area| pressure * area),
            mean_traction: Some(pressure),
        },
    })
}

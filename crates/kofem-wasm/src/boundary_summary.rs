// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser bindings for what a support or load group card says it applies
//! (`kofem_fem::boundary_summary`, KOF-494).

use wasm_bindgen::prelude::*;

use crate::to_js;

/// The area a group's CAD faces cover, each face counted once.
#[wasm_bindgen]
pub struct SelectedArea {
    inner: kofem_fem::SelectedArea,
}

#[wasm_bindgen]
impl SelectedArea {
    /// The sum of the distinct faces' areas (mm²).
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn area(&self) -> f64 {
        self.inner.area
    }

    /// The faces selected more than once, ascending.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn repeated(&self) -> Vec<u32> {
        self.inner.repeated.clone()
    }
}

/// The area of the CAD faces `selected` (ids from 1), given every CAD face's
/// area in id order.
///
/// # Errors
/// The checks of [`kofem_fem::selected_area`].
#[wasm_bindgen(js_name = selectedArea)]
pub fn selected_area(face_areas: &[f64], selected: &[u32]) -> Result<SelectedArea, JsError> {
    kofem_fem::selected_area(face_areas, selected)
        .map(|inner| SelectedArea { inner })
        .map_err(|error| to_js(&error))
}

fn vector(components: &[f64]) -> Result<[f64; 3], JsError> {
    components.try_into().map_err(|_| {
        JsError::new(&format!(
            "a load vector has 3 components, got {}",
            components.len()
        ))
    })
}

/// What a force group applies.
#[wasm_bindgen]
pub struct ForceSummary {
    inner: kofem_fem::ForceSummary,
}

#[wasm_bindgen]
impl ForceSummary {
    /// The force's magnitude |F| (N).
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn total(&self) -> f64 {
        self.inner.total
    }

    /// |F| over the area (N/mm²); undefined on an area not known.
    #[wasm_bindgen(getter, js_name = meanTraction)]
    #[must_use]
    pub fn mean_traction(&self) -> Option<f64> {
        self.inner.mean_traction
    }
}

/// What a force [Fx, Fy, Fz] (N) applies over `area` (mm²), undefined when
/// the selection's area is not known; undefined for a force of zero.
///
/// # Errors
/// Not three components, or the checks of [`kofem_fem::force_summary`].
#[wasm_bindgen(js_name = forceSummary)]
pub fn force_summary(
    components: &[f64],
    area: Option<f64>,
) -> Result<Option<ForceSummary>, JsError> {
    Ok(kofem_fem::force_summary(vector(components)?, area)
        .map_err(|error| to_js(&error))?
        .map(|inner| ForceSummary { inner }))
}

/// What a moment group applies.
#[wasm_bindgen]
pub struct MomentSummary {
    inner: kofem_fem::MomentSummary,
}

#[wasm_bindgen]
impl MomentSummary {
    /// The moment's magnitude |M| (N·mm).
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn each(&self) -> f64 {
        self.inner.each
    }

    /// How many times the solve applies it.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn applied(&self) -> u32 {
        kofem_fem::index_as_u32(self.inner.applied)
    }

    /// |M| times `applied`.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn total(&self) -> f64 {
        self.inner.total
    }
}

/// What a moment [Mx, My, Mz] (N·mm) applies when the solve applies it
/// `applied` times; undefined for a moment of zero. `area` (mm²) is checked
/// as for a force.
///
/// # Errors
/// Not three components, or the checks of [`kofem_fem::moment_summary`].
#[wasm_bindgen(js_name = momentSummary)]
pub fn moment_summary(
    components: &[f64],
    applied: u32,
    area: Option<f64>,
) -> Result<Option<MomentSummary>, JsError> {
    Ok(
        kofem_fem::moment_summary(vector(components)?, applied as usize, area)
            .map_err(|error| to_js(&error))?
            .map(|inner| MomentSummary { inner }),
    )
}

/// What a pressure group applies.
#[wasm_bindgen]
pub struct PressureSummary {
    inner: kofem_fem::PressureSummary,
}

#[wasm_bindgen]
impl PressureSummary {
    /// The pressure (N/mm²), positive pushing in.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn pressure(&self) -> f64 {
        self.inner.pressure
    }

    /// The pressure times the area (N); undefined on an area not known.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn total(&self) -> Option<f64> {
        self.inner.total
    }
}

/// What a pressure (N/mm²) applies over `area` (mm²), undefined when the
/// selection's area is not known; undefined for a pressure of zero.
///
/// # Errors
/// The checks of [`kofem_fem::pressure_summary`].
#[wasm_bindgen(js_name = pressureSummary)]
pub fn pressure_summary(
    pressure: f64,
    area: Option<f64>,
) -> Result<Option<PressureSummary>, JsError> {
    Ok(kofem_fem::pressure_summary(pressure, area)
        .map_err(|error| to_js(&error))?
        .map(|inner| PressureSummary { inner }))
}

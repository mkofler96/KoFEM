// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser bindings for what a support or load group card says it applies
//! (`kofem_fem::boundary_summary`, KOF-494).

use kofem_fem::LoadValue;
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

/// What a load applies over its area.
#[wasm_bindgen]
pub struct LoadSummary {
    inner: kofem_fem::LoadSummary,
}

#[wasm_bindgen]
impl LoadSummary {
    /// A force's or moment's magnitude, or a pressure times the area;
    /// undefined for a pressure on an area not known.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn total(&self) -> Option<f64> {
        self.inner.total
    }

    /// The force per unit area (N/mm²); undefined for a moment, or a force on
    /// an area not known.
    #[wasm_bindgen(getter, js_name = meanTraction)]
    #[must_use]
    pub fn mean_traction(&self) -> Option<f64> {
        self.inner.mean_traction
    }
}

fn vector(components: &[f64]) -> Result<[f64; 3], JsError> {
    components.try_into().map_err(|_| {
        JsError::new(&format!(
            "a load vector has 3 components, got {}",
            components.len()
        ))
    })
}

fn summary(value: LoadValue, area: Option<f64>) -> Result<LoadSummary, JsError> {
    kofem_fem::load_summary(value, area)
        .map(|inner| LoadSummary { inner })
        .map_err(|error| to_js(&error))
}

/// A total force [Fx, Fy, Fz] (N) over `area` (mm²), undefined when the
/// selection's area is not known.
///
/// # Errors
/// Not three components, or the checks of [`kofem_fem::load_summary`].
#[wasm_bindgen(js_name = forceSummary)]
pub fn force_summary(components: &[f64], area: Option<f64>) -> Result<LoadSummary, JsError> {
    summary(LoadValue::Force(vector(components)?), area)
}

/// A moment [Mx, My, Mz] (N·mm) the solve applies `applied` times, over
/// `area` (mm²), undefined when the selection's area is not known.
///
/// # Errors
/// Not three components, or the checks of [`kofem_fem::load_summary`].
#[wasm_bindgen(js_name = momentSummary)]
pub fn moment_summary(
    components: &[f64],
    applied: u32,
    area: Option<f64>,
) -> Result<LoadSummary, JsError> {
    summary(
        LoadValue::Moment(vector(components)?, applied as usize),
        area,
    )
}

/// A pressure (N/mm²) over `area` (mm²), undefined when the
/// selection's area is not known.
///
/// # Errors
/// The checks of [`kofem_fem::load_summary`].
#[wasm_bindgen(js_name = pressureSummary)]
pub fn pressure_summary(pressure: f64, area: Option<f64>) -> Result<LoadSummary, JsError> {
    summary(LoadValue::Pressure(pressure), area)
}

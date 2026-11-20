// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser binding for the result section cut (`kofem_fem::section`): the
//! viewport cuts the deformed model with a plane and draws the filled cap and
//! the shell lines in the field's colours.

use kofem_fem::{SectionMesh, SectionPlane};
use wasm_bindgen::prelude::*;

use crate::to_js;

/// A section cut: the cap (points x,y,z, a value per point, triangles by
/// point index) and the shell lines (two points per segment, a value per
/// point).
#[wasm_bindgen]
pub struct SectionCut {
    cut: kofem_fem::SectionCut,
}

#[wasm_bindgen]
impl SectionCut {
    #[wasm_bindgen(getter, js_name = capPoints)]
    #[must_use]
    pub fn cap_points(&self) -> Vec<f64> {
        self.cut.cap_points.clone()
    }

    #[wasm_bindgen(getter, js_name = capValues)]
    #[must_use]
    pub fn cap_values(&self) -> Vec<f64> {
        self.cut.cap_values.clone()
    }

    #[wasm_bindgen(getter, js_name = capTriangles)]
    #[must_use]
    pub fn cap_triangles(&self) -> Vec<u32> {
        self.cut.cap_triangles.clone()
    }

    #[wasm_bindgen(getter, js_name = linePoints)]
    #[must_use]
    pub fn line_points(&self) -> Vec<f64> {
        self.cut.line_points.clone()
    }

    #[wasm_bindgen(getter, js_name = lineValues)]
    #[must_use]
    pub fn line_values(&self) -> Vec<f64> {
        self.cut.line_values.clone()
    }
}

/// Cut the model by the plane normal to `axis` (0 x, 1 y, 2 z) at `level`,
/// keeping the part below it, or above it when `flipped`. `points` holds the
/// node coordinates as drawn (x,y,z per node), `values` the field per node;
/// `tets` (4 per element), `hexes` (8) and `shellTriangles` (3) index them.
///
/// # Errors
/// The cut's own checks: an axis other than 0, 1 or 2, a non-finite level,
/// array lengths that do not fit together, or an element with an unknown
/// node.
#[wasm_bindgen(js_name = sectionCut)]
#[expect(
    clippy::too_many_arguments,
    reason = "a flat wasm-bindgen signature: typed arrays in, one call per slider move"
)]
pub fn section_cut(
    points: &[f64],
    values: &[f64],
    tets: &[u32],
    hexes: &[u32],
    shell_triangles: &[u32],
    axis: u32,
    level: f64,
    flipped: bool,
) -> Result<SectionCut, JsError> {
    let cut = kofem_fem::section_cut(
        &SectionMesh {
            points,
            values,
            tets,
            hexes,
            shell_triangles,
        },
        SectionPlane {
            axis: axis as usize,
            level,
            flipped,
        },
    )
    .map_err(|error| to_js(&error))?;
    Ok(SectionCut { cut })
}

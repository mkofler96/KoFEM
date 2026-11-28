// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser bindings for the statistics of a nodal field the Results panel
//! lists next to its min and max: the volume-weighted percentiles
//! (`kofem_fem::field_statistics`) and where the field peaks, with the
//! idealised supports and loads on that node (`kofem_fem::field_peak`).

use kofem_fem::{
    BoundaryGroup, Condition, CouplingSurface, PeakInput, PickGeometry, Selection, StatisticsMesh,
};
use wasm_bindgen::prelude::*;

use crate::to_js;

/// The volume-weighted `quantiles` (each in [0, 1]) of `values`, one per node.
/// `tets` holds `tet_nodes` (4 or 10) nodes per tetrahedron, `hexes` eight per
/// hexahedron, `shell_triangles` three per facet with one thickness each in
/// `shell_thicknesses`.
///
/// # Errors
/// The checks of [`kofem_fem::nodal_percentiles`].
#[wasm_bindgen(js_name = nodalPercentiles)]
#[expect(
    clippy::too_many_arguments,
    reason = "a flat wasm-bindgen signature: typed arrays in, one call per plotted field"
)]
pub fn nodal_percentiles(
    points: &[f64],
    values: &[f64],
    tets: &[u32],
    tet_nodes: u32,
    hexes: &[u32],
    shell_triangles: &[u32],
    shell_thicknesses: &[f64],
    quantiles: &[f64],
) -> Result<Vec<f64>, JsError> {
    kofem_fem::nodal_percentiles(
        &StatisticsMesh {
            points,
            values,
            tets,
            tet_nodes: tet_nodes as usize,
            hexes,
            shell_triangles,
            shell_thicknesses,
        },
        quantiles,
    )
    .map_err(|error| to_js(&error))
}

/// The support, load and coupling groups for `fieldPeak`, added one group at
/// a time: `support` or `load` opens a group, and each `select` adds a pick to
/// the group opened last.
#[wasm_bindgen]
#[derive(Default)]
pub struct PeakConditions {
    groups: Vec<BoundaryGroup>,
    couplings: Vec<CouplingSurface>,
}

#[wasm_bindgen]
impl PeakConditions {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> PeakConditions {
        PeakConditions::default()
    }

    /// Open a support group that holds `dofs` (0–2 translations, 3–5
    /// rotations).
    pub fn support(&mut self, dofs: &[u32]) {
        self.groups.push(BoundaryGroup {
            condition: Condition::Support {
                dofs: dofs.to_vec(),
            },
            selections: Vec::new(),
        });
    }

    /// Open a load group.
    pub fn load(&mut self) {
        self.groups.push(BoundaryGroup {
            condition: Condition::Load,
            selections: Vec::new(),
        });
    }

    /// Add a pick of the node indices `nodes` to the group opened last.
    /// `geometry` is "face", "edge" or "point", or undefined for a pick saved
    /// before its kind was recorded.
    ///
    /// # Errors
    /// No group opened yet, or an unknown `geometry`.
    pub fn select(&mut self, geometry: Option<String>, nodes: &[u32]) -> Result<(), JsError> {
        let geometry = match geometry {
            None => PickGeometry::Unrecorded,
            Some(kind) => pick_geometry(&kind)?,
        };
        let group = self
            .groups
            .last_mut()
            .ok_or_else(|| JsError::new("a pick needs a support or load group to belong to"))?;
        group.selections.push(Selection {
            geometry,
            nodes: nodes.to_vec(),
        });
        Ok(())
    }

    /// Add the coupling of the reference point `reference` to the surface
    /// nodes `nodes`.
    pub fn coupling(&mut self, reference: u32, nodes: &[u32]) {
        self.couplings.push(CouplingSurface {
            reference,
            nodes: nodes.to_vec(),
        });
    }
}

fn pick_geometry(kind: &str) -> Result<PickGeometry, JsError> {
    match kind {
        "face" => Ok(PickGeometry::Face),
        "edge" => Ok(PickGeometry::Edge),
        "point" => Ok(PickGeometry::Point),
        other => Err(JsError::new(&format!(
            "a pick is a face, an edge or a point, got \"{other}\""
        ))),
    }
}

/// Where a nodal field peaks (from `fieldPeak`).
#[wasm_bindgen]
pub struct FieldPeak {
    peak: kofem_fem::FieldPeak,
}

#[wasm_bindgen]
impl FieldPeak {
    /// The node's index in the field; the first such node on a tie.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn node(&self) -> usize {
        self.peak.node
    }

    /// The node's coordinates, x, y, z.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn at(&self) -> Vec<f64> {
        self.peak.at.to_vec()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn value(&self) -> f64 {
        self.peak.value
    }

    /// The idealised groups that hold the node, by the order they were
    /// added, ascending.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn idealised(&self) -> Vec<usize> {
        self.peak.idealised.clone()
    }
}

/// Where `values` (one per node at `points`, x, y, z each) is largest, and
/// which of the idealised groups in `conditions` hold that node.
/// `shell_triangles` holds three node indices per shell facet.
///
/// # Errors
/// The checks of [`kofem_fem::field_peak`].
#[wasm_bindgen(js_name = fieldPeak)]
pub fn field_peak(
    points: &[f64],
    values: &[f64],
    shell_triangles: &[u32],
    conditions: &PeakConditions,
) -> Result<FieldPeak, JsError> {
    kofem_fem::field_peak(&PeakInput {
        points,
        values,
        shell_triangles,
        groups: &conditions.groups,
        couplings: &conditions.couplings,
    })
    .map(|peak| FieldPeak { peak })
    .map_err(|error| to_js(&error))
}

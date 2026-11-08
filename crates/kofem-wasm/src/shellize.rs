// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser bindings for `kofem-shellize`: the mesh-time shell idealisation and
//! the coupled model of an explicit shell/solid mesh. Index arrays cross as
//! `Uint32Array`, ids as `Int32Array`, coordinates as `Float64Array`.

use kofem_shellize::{
    build_explicit_coupled_model, build_shell_transition_model, extract_thin_wall_shells,
    CouplingOptions, CouplingSet, ExtractOptions, ShellizeError, ShellizeMesh, TieCouplingReport,
    TieSurfaces,
};
use wasm_bindgen::prelude::*;

fn to_js(error: &ShellizeError) -> JsError {
    JsError::new(&error.to_string())
}

fn flat<const N: usize>(groups: &[[usize; N]]) -> Vec<u32> {
    groups
        .iter()
        .flatten()
        .map(|&index| index_u32(index))
        .collect()
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "every index came in as a u32 or was created from one; the module's 4 GB memory \
              cannot hold 2^32 vertices"
)]
fn index_u32(index: usize) -> u32 {
    index as u32
}

fn indices(values: &[usize]) -> Vec<u32> {
    values.iter().map(|&index| index_u32(index)).collect()
}

fn coordinates(points: &[[f64; 3]]) -> Vec<f64> {
    points.iter().flatten().copied().collect()
}

/// The CSR coupling arrays in the layout `solve_coupled` reads.
#[derive(Clone)]
struct CouplingArrays {
    reference: Vec<u32>,
    offsets: Vec<u32>,
    partner: Vec<u32>,
    kind: Vec<i32>,
    weights: Vec<f64>,
    dof_mask: Vec<u32>,
}

impl From<&CouplingSet> for CouplingArrays {
    fn from(set: &CouplingSet) -> Self {
        Self {
            reference: indices(&set.reference),
            offsets: indices(&set.offsets),
            partner: indices(&set.partner),
            kind: set.kind.iter().map(|kind| kind.code()).collect(),
            weights: set.weights.clone(),
            dof_mask: set.dof_mask.clone(),
        }
    }
}

/// The mixed shell/solid model produced at mesh time.
#[wasm_bindgen]
pub struct ShellTransitionResult {
    shell_body: i32,
    wall_count: usize,
    pool: Vec<f64>,
    tets: Vec<u32>,
    tet_body: Vec<i32>,
    triangles: Vec<u32>,
    thicknesses: Vec<f64>,
    shell_pool: Vec<u32>,
    solid_pool_vertices: Vec<u32>,
    solid_pool_indices: Vec<u32>,
    coupling: CouplingArrays,
    shell_vertices: Vec<f64>,
    shell_triangles: Vec<u32>,
    shell_node_source: Vec<i32>,
    shell_triangle_source: Vec<i32>,
    surface_triangles: Vec<u32>,
    surface_faces: Vec<i32>,
}

/// Idealise the Shell body of a tet mesh: detect its thin walls, collapse them
/// to a mid-surface, cut the retained solid at the wall roots and build the
/// coupled pool. `shell_body_ids` names the bodies the user marked Shell (the
/// one with the largest wall is used). Returns `undefined` when no thin wall is
/// found, which the caller must report — a Shell choice is never silently
/// solved as solid.
///
/// # Errors
/// A malformed mesh, a Shell body the walls do not cover, or a transition the
/// footprint cannot connect.
#[wasm_bindgen(js_name = buildShellTransitionModel)]
pub fn build_shell_transition(
    vertices: &[f64],
    tets: &[u32],
    body: &[i32],
    surface_triangles: &[u32],
    surface_faces: &[i32],
    shell_body_ids: &[i32],
    max_wall: f64,
) -> Result<Option<ShellTransitionResult>, JsError> {
    let mesh = ShellizeMesh::new(vertices, tets, body, surface_triangles, surface_faces)
        .map_err(|error| to_js(&error))?;
    let shells = extract_thin_wall_shells(
        &mesh,
        &ExtractOptions {
            max_wall,
            shell_body_ids: Some(shell_body_ids.to_vec()),
        },
    )
    .map_err(|error| to_js(&error))?;
    let Some(shell_body) = shells.shell_body else {
        return Ok(None);
    };
    let transition = build_shell_transition_model(&mesh, &shells).map_err(|error| to_js(&error))?;
    let model = &transition.model;
    Ok(Some(ShellTransitionResult {
        shell_body,
        wall_count: transition.shells.walls.len(),
        pool: coordinates(&model.pool),
        tets: flat(&model.tets),
        tet_body: model.tet_body.clone(),
        triangles: flat(&model.triangles),
        thicknesses: model.thicknesses.clone(),
        shell_pool: indices(&model.shell_pool),
        solid_pool_vertices: model
            .solid_pool
            .iter()
            .map(|&(vertex, _)| index_u32(vertex))
            .collect(),
        solid_pool_indices: model
            .solid_pool
            .iter()
            .map(|&(_, index)| index_u32(index))
            .collect(),
        coupling: CouplingArrays::from(&model.coupling),
        shell_vertices: coordinates(&transition.shells.vertices),
        shell_triangles: flat(&transition.shells.triangles),
        shell_node_source: transition.shells.node_source.clone(),
        shell_triangle_source: transition.shells.triangle_source.clone(),
        surface_triangles: flat(transition.mesh.surface_triangles()),
        surface_faces: transition.mesh.surface_faces().to_vec(),
    }))
}

macro_rules! getters {
    ($type:ty { $($js:literal => $field:ident : $out:ty),* $(,)? }) => {
        #[wasm_bindgen]
        impl $type {
            $(
                #[wasm_bindgen(getter, js_name = $js)]
                #[must_use]
                pub fn $field(&self) -> $out {
                    self.$field.clone()
                }
            )*
        }
    };
}

getters!(ShellTransitionResult {
    "shellBody" => shell_body: i32,
    "wallCount" => wall_count: usize,
    "pool" => pool: Vec<f64>,
    "tets" => tets: Vec<u32>,
    "tetBody" => tet_body: Vec<i32>,
    "triangles" => triangles: Vec<u32>,
    "thicknesses" => thicknesses: Vec<f64>,
    "shellPool" => shell_pool: Vec<u32>,
    "solidPoolVertices" => solid_pool_vertices: Vec<u32>,
    "solidPoolIndices" => solid_pool_indices: Vec<u32>,
    "shellVertices" => shell_vertices: Vec<f64>,
    "shellTriangles" => shell_triangles: Vec<u32>,
    "shellNodeSource" => shell_node_source: Vec<i32>,
    "shellTriangleSource" => shell_triangle_source: Vec<i32>,
    "surfaceTriangles" => surface_triangles: Vec<u32>,
    "surfaceFaces" => surface_faces: Vec<i32>,
});

/// The coupled model of an explicit shell/solid mesh.
#[wasm_bindgen]
pub struct CoupledResult {
    pool: Vec<f64>,
    tets: Vec<u32>,
    triangles: Vec<u32>,
    pool_of_vertex_keys: Vec<u32>,
    pool_of_vertex_values: Vec<u32>,
    shell_pool_index: Vec<u32>,
    coupling: CouplingArrays,
    tie_problems: Vec<String>,
    tie_coupled: Vec<u32>,
    tie_partners: Vec<u32>,
    tie_shared: Vec<u32>,
    tie_gap: Vec<f64>,
}

getters!(CoupledResult {
    "pool" => pool: Vec<f64>,
    "tets" => tets: Vec<u32>,
    "triangles" => triangles: Vec<u32>,
    "poolOfVertexKeys" => pool_of_vertex_keys: Vec<u32>,
    "poolOfVertexValues" => pool_of_vertex_values: Vec<u32>,
    "shellPoolIndex" => shell_pool_index: Vec<u32>,
    "tieProblems" => tie_problems: Vec<String>,
    "tieCoupled" => tie_coupled: Vec<u32>,
    "tiePartners" => tie_partners: Vec<u32>,
    "tieShared" => tie_shared: Vec<u32>,
    "tieGap" => tie_gap: Vec<f64>,
});

macro_rules! coupling_getters {
    ($type:ty) => {
        #[wasm_bindgen]
        impl $type {
            #[wasm_bindgen(getter, js_name = couplingRef)]
            #[must_use]
            pub fn coupling_ref(&self) -> Vec<u32> {
                self.coupling.reference.clone()
            }
            #[wasm_bindgen(getter, js_name = couplingOffsets)]
            #[must_use]
            pub fn coupling_offsets(&self) -> Vec<u32> {
                self.coupling.offsets.clone()
            }
            #[wasm_bindgen(getter, js_name = couplingSolid)]
            #[must_use]
            pub fn coupling_solid(&self) -> Vec<u32> {
                self.coupling.partner.clone()
            }
            #[wasm_bindgen(getter, js_name = couplingMpc)]
            #[must_use]
            pub fn coupling_mpc(&self) -> Vec<i32> {
                self.coupling.kind.clone()
            }
            #[wasm_bindgen(getter, js_name = couplingWeights)]
            #[must_use]
            pub fn coupling_weights(&self) -> Vec<f64> {
                self.coupling.weights.clone()
            }
            #[wasm_bindgen(getter, js_name = couplingDofMask)]
            #[must_use]
            pub fn coupling_dof_mask(&self) -> Vec<u32> {
                self.coupling.dof_mask.clone()
            }
        }
    };
}

coupling_getters!(ShellTransitionResult);
coupling_getters!(CoupledResult);

fn split_csr(
    values: &[u32],
    offsets: &[u32],
    what: &'static str,
) -> Result<Vec<Vec<usize>>, JsError> {
    let malformed = || JsError::new(&format!("{what}: offsets do not describe the value array"));
    if offsets.first() != Some(&0)
        || offsets.last().map(|&last| last as usize) != Some(values.len())
    {
        return Err(malformed());
    }
    offsets
        .windows(2)
        .map(|pair| {
            values
                .get(pair[0] as usize..pair[1] as usize)
                .map(|slice| slice.iter().map(|&value| value as usize).collect())
                .ok_or_else(malformed)
        })
        .collect()
}

/// Build the coupled model of an explicit shell/solid mesh, with the model's
/// tie connections (surface A / B vertex lists in CSR form, one name and one
/// search distance each — `Infinity` couples the full surface) and the
/// reference points of its surface-to-point couplings.
///
/// # Errors
/// A malformed array, index or tie list, or a tie that overlaps the
/// shell/solid transition.
#[wasm_bindgen(js_name = buildExplicitCoupledModel)]
#[allow(
    clippy::too_many_arguments,
    reason = "a wasm-bindgen entry point takes flat typed arrays, one per field"
)]
pub fn build_explicit_coupled(
    vertices: &[f64],
    solid_tets: &[u32],
    shell_triangles: &[u32],
    shell_thickness: &[f64],
    tie_names: Vec<String>,
    tie_vertices_a: &[u32],
    tie_offsets_a: &[u32],
    tie_vertices_b: &[u32],
    tie_offsets_b: &[u32],
    tie_max_separation: &[f64],
    reference_points: &[u32],
) -> Result<CoupledResult, JsError> {
    let surfaces_a = split_csr(tie_vertices_a, tie_offsets_a, "tie surface A")?;
    let surfaces_b = split_csr(tie_vertices_b, tie_offsets_b, "tie surface B")?;
    if surfaces_a.len() != tie_names.len()
        || surfaces_b.len() != tie_names.len()
        || tie_max_separation.len() != tie_names.len()
    {
        return Err(JsError::new(
            "tie arrays disagree on the number of tie connections",
        ));
    }
    let ties = tie_names
        .into_iter()
        .zip(surfaces_a)
        .zip(surfaces_b)
        .zip(tie_max_separation)
        .map(
            |(((name, vertices_a), vertices_b), &max_separation)| TieSurfaces {
                name,
                vertices_a,
                vertices_b,
                max_separation,
            },
        )
        .collect();
    let options = CouplingOptions {
        ties,
        reference_points: reference_points
            .iter()
            .map(|&vertex| vertex as usize)
            .collect(),
        ..CouplingOptions::default()
    };
    let model = build_explicit_coupled_model(
        vertices,
        solid_tets,
        shell_triangles,
        shell_thickness,
        &options,
    )
    .map_err(|error| to_js(&error))?;
    let reports: &[TieCouplingReport] = &model.tie_reports;
    Ok(CoupledResult {
        pool: coordinates(&model.pool),
        tets: flat(&model.tets),
        triangles: flat(&model.triangles),
        pool_of_vertex_keys: model
            .pool_of_vertex
            .iter()
            .map(|&(vertex, _)| index_u32(vertex))
            .collect(),
        pool_of_vertex_values: model
            .pool_of_vertex
            .iter()
            .map(|&(_, index)| index_u32(index))
            .collect(),
        shell_pool_index: indices(&model.shell_pool_index),
        coupling: CouplingArrays::from(&model.coupling),
        tie_problems: reports
            .iter()
            .map(|report| report.problem().unwrap_or_default())
            .collect(),
        tie_coupled: reports
            .iter()
            .map(|report| index_u32(report.coupled))
            .collect(),
        tie_partners: reports
            .iter()
            .map(|report| index_u32(report.partners))
            .collect(),
        tie_shared: reports
            .iter()
            .map(|report| index_u32(report.shared))
            .collect(),
        tie_gap: reports.iter().map(|report| report.gap).collect(),
    })
}

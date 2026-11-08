// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser bindings for `kofem-shellize`, the shell idealisation the solver
//! worker runs between Netgen meshing and the coupled solve. Index arrays cross
//! as `Uint32Array`, ids as `Int32Array`, coordinates as `Float64Array`; every
//! result is copied out of WASM memory by its getters. `web/src/lib/shellize.ts`
//! wraps these into the app's types.

use std::collections::BTreeSet;

use kofem_shellize::coupled_model::{CoupledModel, ExplicitCoupledModel};
use kofem_shellize::geometry::Vec3;
use kofem_shellize::{
    build_coupled_model, build_explicit_coupled_model, build_shell_transition_model,
    extract_thin_wall_shells, shell_body_tets, shell_wall_tets, CouplingOptions, CouplingSet,
    ExtractOptions, ShellExtraction, ShellizeError, ShellizeMesh, TieCouplingDrop,
    TieCouplingReport, TieSide, TieSurfaces, Wall,
};
use wasm_bindgen::prelude::*;

fn to_js(error: &ShellizeError) -> JsError {
    JsError::new(&error.to_string())
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "every index came in as a u32 or was created from one; the module's 4 GB memory \
              cannot hold 2^32 vertices"
)]
fn index_u32(index: usize) -> u32 {
    index as u32
}

fn indices(values: impl IntoIterator<Item = usize>) -> Vec<u32> {
    values.into_iter().map(index_u32).collect()
}

fn flat<const N: usize>(groups: &[[usize; N]]) -> Vec<u32> {
    indices(groups.iter().flatten().copied())
}

fn coordinates(points: &[Vec3]) -> Vec<f64> {
    points.iter().flatten().copied().collect()
}

fn index_set(values: &[u32]) -> BTreeSet<usize> {
    values.iter().map(|&value| value as usize).collect()
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

// ── Mesh ──────────────────────────────────────────────────────────────────────

/// A validated tet mesh with its CAD-labelled surface triangles.
#[wasm_bindgen]
#[derive(Clone)]
pub struct ShellizeInput {
    mesh: ShellizeMesh,
}

#[wasm_bindgen]
impl ShellizeInput {
    /// # Errors
    /// The first malformed array or out-of-range index.
    #[wasm_bindgen(constructor)]
    pub fn new(
        vertices: &[f64],
        tets: &[u32],
        body: &[i32],
        surface_triangles: &[u32],
        surface_faces: &[i32],
    ) -> Result<ShellizeInput, JsError> {
        let mesh = ShellizeMesh::new(vertices, tets, body, surface_triangles, surface_faces)
            .map_err(|error| to_js(&error))?;
        Ok(Self { mesh })
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn vertices(&self) -> Vec<f64> {
        coordinates(self.mesh.vertices())
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn tets(&self) -> Vec<u32> {
        flat(self.mesh.tets())
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn body(&self) -> Vec<i32> {
        self.mesh.body().to_vec()
    }

    #[wasm_bindgen(getter, js_name = surfaceTriangles)]
    #[must_use]
    pub fn surface_triangles(&self) -> Vec<u32> {
        flat(self.mesh.surface_triangles())
    }

    #[wasm_bindgen(getter, js_name = surfaceFaces)]
    #[must_use]
    pub fn surface_faces(&self) -> Vec<i32> {
        self.mesh.surface_faces().to_vec()
    }
}

// ── Shell extraction ──────────────────────────────────────────────────────────

/// A shell mid-surface and the walls it was collapsed from.
#[wasm_bindgen]
#[derive(Clone)]
pub struct ShellSet {
    shells: ShellExtraction,
}

#[wasm_bindgen]
impl ShellSet {
    /// Rebuild a shell set from its flat form (`wall_normal` holds x,y,z per
    /// wall); `shell_body` is `undefined` for an empty extraction.
    ///
    /// # Errors
    /// The first malformed array or out-of-range index.
    #[wasm_bindgen(constructor)]
    #[allow(
        clippy::too_many_arguments,
        reason = "a wasm-bindgen constructor takes flat typed arrays, one per field"
    )]
    pub fn new(
        shell_body: Option<i32>,
        wall_keep: &[i32],
        wall_normal: &[f64],
        wall_thickness: &[f64],
        wall_body: &[i32],
        vertices: &[f64],
        triangles: &[u32],
        thicknesses: &[f64],
        node_source: &[i32],
        triangle_source: &[i32],
    ) -> Result<ShellSet, JsError> {
        let count = wall_keep.len();
        if wall_normal.len() != 3 * count
            || wall_thickness.len() != count
            || wall_body.len() != count
        {
            return Err(JsError::new("wall arrays disagree on the number of walls"));
        }
        let walls = (0..count)
            .map(|i| Wall {
                keep: wall_keep[i],
                normal: [
                    wall_normal[3 * i],
                    wall_normal[3 * i + 1],
                    wall_normal[3 * i + 2],
                ],
                thickness: wall_thickness[i],
                body: wall_body[i],
            })
            .collect();
        let shells = ShellExtraction::from_parts(
            shell_body,
            walls,
            vertices,
            triangles,
            thicknesses,
            node_source,
            triangle_source,
        )
        .map_err(|error| to_js(&error))?;
        Ok(Self { shells })
    }

    #[wasm_bindgen(getter, js_name = shellBody)]
    #[must_use]
    pub fn shell_body(&self) -> Option<i32> {
        self.shells.shell_body
    }

    #[wasm_bindgen(getter, js_name = wallKeep)]
    #[must_use]
    pub fn wall_keep(&self) -> Vec<i32> {
        self.shells.walls.iter().map(|wall| wall.keep).collect()
    }

    #[wasm_bindgen(getter, js_name = wallNormal)]
    #[must_use]
    pub fn wall_normal(&self) -> Vec<f64> {
        self.shells
            .walls
            .iter()
            .flat_map(|wall| wall.normal)
            .collect()
    }

    #[wasm_bindgen(getter, js_name = wallThickness)]
    #[must_use]
    pub fn wall_thickness(&self) -> Vec<f64> {
        self.shells
            .walls
            .iter()
            .map(|wall| wall.thickness)
            .collect()
    }

    #[wasm_bindgen(getter, js_name = wallBody)]
    #[must_use]
    pub fn wall_body(&self) -> Vec<i32> {
        self.shells.walls.iter().map(|wall| wall.body).collect()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn vertices(&self) -> Vec<f64> {
        coordinates(&self.shells.vertices)
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn triangles(&self) -> Vec<u32> {
        flat(&self.shells.triangles)
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn thicknesses(&self) -> Vec<f64> {
        self.shells.thicknesses.clone()
    }

    #[wasm_bindgen(getter, js_name = nodeSource)]
    #[must_use]
    pub fn node_source(&self) -> Vec<i32> {
        self.shells.node_source.clone()
    }

    #[wasm_bindgen(getter, js_name = triangleSource)]
    #[must_use]
    pub fn triangle_source(&self) -> Vec<i32> {
        self.shells.triangle_source.clone()
    }
}

/// Detect the thin walls and collapse them to a mid-surface. `shell_body_ids`
/// names the bodies marked Shell (`undefined` lets the largest wall's body
/// win); the result's `shellBody` is `undefined` when no wall was found.
///
/// # Errors
/// An internal inconsistency in the wall bookkeeping.
#[wasm_bindgen(js_name = extractThinWallShells)]
pub fn extract_shells(
    mesh: &ShellizeInput,
    shell_body_ids: Option<Vec<i32>>,
    max_wall: f64,
) -> Result<ShellSet, JsError> {
    let shells = extract_thin_wall_shells(
        &mesh.mesh,
        &ExtractOptions {
            max_wall,
            shell_body_ids,
        },
    )
    .map_err(|error| to_js(&error))?;
    Ok(ShellSet { shells })
}

/// The shelled body's tets that lie inside a detected wall.
///
/// # Errors
/// A degenerate grid size.
#[wasm_bindgen(js_name = shellWallTets)]
pub fn wall_tets(
    mesh: &ShellizeInput,
    shells: &ShellSet,
    margin: f64,
) -> Result<Vec<u32>, JsError> {
    let tets =
        shell_wall_tets(&mesh.mesh, &shells.shells, margin).map_err(|error| to_js(&error))?;
    Ok(indices(tets))
}

/// Every tet of the shelled body, refused when the walls do not cover it.
///
/// # Errors
/// A Shell body some of whose tets lie in no wall.
#[wasm_bindgen(js_name = shellBodyTets)]
pub fn body_tets(mesh: &ShellizeInput, shells: &ShellSet) -> Result<Vec<u32>, JsError> {
    let tets = shell_body_tets(&mesh.mesh, &shells.shells).map_err(|error| to_js(&error))?;
    Ok(indices(tets))
}

// ── Coupling options and results ──────────────────────────────────────────────

/// The model's tie connections (surface A / B vertex lists in CSR form, one
/// name and one search distance each — `Infinity` couples the full surface)
/// and the reference points of its surface-to-point couplings.
#[wasm_bindgen]
pub struct CouplingInput {
    options: CouplingOptions,
}

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

#[wasm_bindgen]
impl CouplingInput {
    /// # Errors
    /// Malformed CSR offsets, or tie arrays of different lengths.
    #[wasm_bindgen(constructor)]
    pub fn new(
        tie_names: Vec<String>,
        tie_vertices_a: &[u32],
        tie_offsets_a: &[u32],
        tie_vertices_b: &[u32],
        tie_offsets_b: &[u32],
        tie_max_separation: &[f64],
        reference_points: &[u32],
    ) -> Result<CouplingInput, JsError> {
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
        Ok(Self {
            options: CouplingOptions {
                ties,
                reference_points: reference_points
                    .iter()
                    .map(|&vertex| vertex as usize)
                    .collect(),
                ..CouplingOptions::default()
            },
        })
    }
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
            reference: indices(set.reference.iter().copied()),
            offsets: indices(set.offsets.iter().copied()),
            partner: indices(set.partner.iter().copied()),
            kind: set.kind.iter().map(|kind| kind.code()).collect(),
            weights: set.weights.clone(),
            dof_mask: set.dof_mask.clone(),
        }
    }
}

/// What each tie connection contributed, one entry per connection. A drop is
/// encoded as its kind (`""` when the tie coupled), its surface side (`""`
/// unless the kind is `no-pool-nodes`) and three numbers whose meaning follows
/// the kind: out-of-reach (searched, 0, 0), beyond-search-distance (gap,
/// reach, 0), too-few-partners (refs, radius, 0). `problems` holds the
/// sentence for a connection that coupled nothing, `""` otherwise.
#[derive(Clone, Default)]
struct TieReports {
    names: Vec<String>,
    coupled: Vec<u32>,
    partners: Vec<u32>,
    shared: Vec<u32>,
    gap: Vec<f64>,
    drop_kind: Vec<String>,
    drop_side: Vec<String>,
    drop_values: Vec<f64>,
    problems: Vec<String>,
}

#[allow(
    clippy::cast_precision_loss,
    reason = "a reference count far below 2^52, carried as a float in a mixed array"
)]
fn drop_wire(drop: Option<TieCouplingDrop>) -> (&'static str, &'static str, [f64; 3]) {
    match drop {
        None => ("", "", [0.0; 3]),
        Some(TieCouplingDrop::NoPoolNodes { side }) => (
            "no-pool-nodes",
            match side {
                TieSide::SurfaceA => "A",
                TieSide::SurfaceB => "B",
                TieSide::Both => "both",
            },
            [0.0; 3],
        ),
        Some(TieCouplingDrop::OutOfReach { searched }) => {
            ("out-of-reach", "", [searched, 0.0, 0.0])
        }
        Some(TieCouplingDrop::BeyondSearchDistance { gap, reach }) => {
            ("beyond-search-distance", "", [gap, reach, 0.0])
        }
        Some(TieCouplingDrop::TooFewPartners { refs, radius }) => {
            ("too-few-partners", "", [refs as f64, radius, 0.0])
        }
    }
}

impl From<&[TieCouplingReport]> for TieReports {
    fn from(reports: &[TieCouplingReport]) -> Self {
        let mut wire = Self::default();
        for report in reports {
            let (kind, side, values) = drop_wire(report.drop);
            wire.names.push(report.name.clone());
            wire.coupled.push(index_u32(report.coupled));
            wire.partners.push(index_u32(report.partners));
            wire.shared.push(index_u32(report.shared));
            wire.gap.push(report.gap);
            wire.drop_kind.push(kind.to_owned());
            wire.drop_side.push(side.to_owned());
            wire.drop_values.extend(values);
            wire.problems.push(report.problem().unwrap_or_default());
        }
        wire
    }
}

macro_rules! coupling_and_tie_getters {
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
            #[wasm_bindgen(getter, js_name = tieNames)]
            #[must_use]
            pub fn tie_names(&self) -> Vec<String> {
                self.ties.names.clone()
            }
            #[wasm_bindgen(getter, js_name = tieCoupled)]
            #[must_use]
            pub fn tie_coupled(&self) -> Vec<u32> {
                self.ties.coupled.clone()
            }
            #[wasm_bindgen(getter, js_name = tiePartners)]
            #[must_use]
            pub fn tie_partners(&self) -> Vec<u32> {
                self.ties.partners.clone()
            }
            #[wasm_bindgen(getter, js_name = tieShared)]
            #[must_use]
            pub fn tie_shared(&self) -> Vec<u32> {
                self.ties.shared.clone()
            }
            #[wasm_bindgen(getter, js_name = tieGap)]
            #[must_use]
            pub fn tie_gap(&self) -> Vec<f64> {
                self.ties.gap.clone()
            }
            #[wasm_bindgen(getter, js_name = tieDropKind)]
            #[must_use]
            pub fn tie_drop_kind(&self) -> Vec<String> {
                self.ties.drop_kind.clone()
            }
            #[wasm_bindgen(getter, js_name = tieDropSide)]
            #[must_use]
            pub fn tie_drop_side(&self) -> Vec<String> {
                self.ties.drop_side.clone()
            }
            #[wasm_bindgen(getter, js_name = tieDropValues)]
            #[must_use]
            pub fn tie_drop_values(&self) -> Vec<f64> {
                self.ties.drop_values.clone()
            }
            #[wasm_bindgen(getter, js_name = tieProblems)]
            #[must_use]
            pub fn tie_problems(&self) -> Vec<String> {
                self.ties.problems.clone()
            }
        }
    };
}

/// The auto-shell coupled model: solid nodes, then shell nodes, then
/// reference points.
#[wasm_bindgen]
#[derive(Clone)]
pub struct CoupledResult {
    pool: Vec<f64>,
    tets: Vec<u32>,
    tet_body: Vec<i32>,
    triangles: Vec<u32>,
    thicknesses: Vec<f64>,
    solid_pool_vertices: Vec<u32>,
    solid_pool_indices: Vec<u32>,
    shell_pool: Vec<u32>,
    ref_pool_vertices: Vec<u32>,
    ref_pool_indices: Vec<u32>,
    coupling: CouplingArrays,
    ties: TieReports,
}

impl From<&CoupledModel> for CoupledResult {
    fn from(model: &CoupledModel) -> Self {
        Self {
            pool: coordinates(&model.pool),
            tets: flat(&model.tets),
            tet_body: model.tet_body.clone(),
            triangles: flat(&model.triangles),
            thicknesses: model.thicknesses.clone(),
            solid_pool_vertices: indices(model.solid_pool.iter().map(|&(vertex, _)| vertex)),
            solid_pool_indices: indices(model.solid_pool.iter().map(|&(_, index)| index)),
            shell_pool: indices(model.shell_pool.iter().copied()),
            ref_pool_vertices: indices(model.ref_pool.iter().map(|&(vertex, _)| vertex)),
            ref_pool_indices: indices(model.ref_pool.iter().map(|&(_, index)| index)),
            coupling: CouplingArrays::from(&model.coupling),
            ties: TieReports::from(model.tie_reports.as_slice()),
        }
    }
}

getters!(CoupledResult {
    "pool" => pool: Vec<f64>,
    "tets" => tets: Vec<u32>,
    "tetBody" => tet_body: Vec<i32>,
    "triangles" => triangles: Vec<u32>,
    "thicknesses" => thicknesses: Vec<f64>,
    "solidPoolVertices" => solid_pool_vertices: Vec<u32>,
    "solidPoolIndices" => solid_pool_indices: Vec<u32>,
    "shellPool" => shell_pool: Vec<u32>,
    "refPoolVertices" => ref_pool_vertices: Vec<u32>,
    "refPoolIndices" => ref_pool_indices: Vec<u32>,
});
coupling_and_tie_getters!(CoupledResult);

/// Pool the solid tets — every tet except the shelled body's `wall_tets` — and
/// the shell facets, and tie the two domains.
///
/// # Errors
/// A malformed coupling input or a footprint/tie conflict.
#[wasm_bindgen(js_name = buildCoupledModel)]
pub fn coupled_model(
    mesh: &ShellizeInput,
    shells: &ShellSet,
    wall_tets: &[u32],
    options: &CouplingInput,
) -> Result<CoupledResult, JsError> {
    let model = build_coupled_model(
        &mesh.mesh,
        &shells.shells,
        &index_set(wall_tets),
        &options.options,
    )
    .map_err(|error| to_js(&error))?;
    Ok(CoupledResult::from(&model))
}

/// The mixed shell/solid model produced at mesh time.
#[wasm_bindgen]
pub struct ShellTransitionResult {
    mesh: ShellizeInput,
    shells: ShellSet,
    model: CoupledResult,
}

getters!(ShellTransitionResult {
    "mesh" => mesh: ShellizeInput,
    "shells" => shells: ShellSet,
    "model" => model: CoupledResult,
});

/// Cut the retained solid at the wall roots, clip the shell to match, and
/// build the coupled pool (no ties: this runs before any are picked).
///
/// # Errors
/// A Shell body the walls do not cover, a shell too short for its joint
/// sections, or a joint the footprint could not connect.
#[wasm_bindgen(js_name = buildShellTransitionModel)]
pub fn shell_transition(
    mesh: &ShellizeInput,
    shells: &ShellSet,
) -> Result<ShellTransitionResult, JsError> {
    let transition =
        build_shell_transition_model(&mesh.mesh, &shells.shells).map_err(|error| to_js(&error))?;
    Ok(ShellTransitionResult {
        model: CoupledResult::from(&transition.model),
        mesh: ShellizeInput {
            mesh: transition.mesh,
        },
        shells: ShellSet {
            shells: transition.shells,
        },
    })
}

/// The coupled model of an explicit shell/solid mesh.
#[wasm_bindgen]
pub struct ExplicitCoupledResult {
    pool: Vec<f64>,
    tets: Vec<u32>,
    triangles: Vec<u32>,
    pool_of_vertex_keys: Vec<u32>,
    pool_of_vertex_values: Vec<u32>,
    shell_pool_index: Vec<u32>,
    coupling: CouplingArrays,
    ties: TieReports,
}

impl From<&ExplicitCoupledModel> for ExplicitCoupledResult {
    fn from(model: &ExplicitCoupledModel) -> Self {
        Self {
            pool: coordinates(&model.pool),
            tets: flat(&model.tets),
            triangles: flat(&model.triangles),
            pool_of_vertex_keys: indices(model.pool_of_vertex.iter().map(|&(vertex, _)| vertex)),
            pool_of_vertex_values: indices(model.pool_of_vertex.iter().map(|&(_, index)| index)),
            shell_pool_index: indices(model.shell_pool_index.iter().copied()),
            coupling: CouplingArrays::from(&model.coupling),
            ties: TieReports::from(model.tie_reports.as_slice()),
        }
    }
}

getters!(ExplicitCoupledResult {
    "pool" => pool: Vec<f64>,
    "tets" => tets: Vec<u32>,
    "triangles" => triangles: Vec<u32>,
    "poolOfVertexKeys" => pool_of_vertex_keys: Vec<u32>,
    "poolOfVertexValues" => pool_of_vertex_values: Vec<u32>,
    "shellPoolIndex" => shell_pool_index: Vec<u32>,
});
coupling_and_tie_getters!(ExplicitCoupledResult);

/// Build the coupled model of an explicit shell/solid mesh (a stored mixed
/// CTRIA3 + CTETRA model).
///
/// # Errors
/// A malformed array or index, or a tie that overlaps the shell/solid
/// transition.
#[wasm_bindgen(js_name = buildExplicitCoupledModel)]
pub fn explicit_coupled_model(
    vertices: &[f64],
    solid_tets: &[u32],
    shell_triangles: &[u32],
    shell_thickness: &[f64],
    options: &CouplingInput,
) -> Result<ExplicitCoupledResult, JsError> {
    let model = build_explicit_coupled_model(
        vertices,
        solid_tets,
        shell_triangles,
        shell_thickness,
        &options.options,
    )
    .map_err(|error| to_js(&error))?;
    Ok(ExplicitCoupledResult::from(&model))
}

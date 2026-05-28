//! WebAssembly bindings for the KoFEM pipeline:
//!   STEP → OCCT tessellation → Netgen volume mesh → MFEM linear-elastic solve
//!
//! # Build requirements
//!
//! This crate links OCCT, Netgen, and MFEM through their C bridges.  For the
//! WASM target (`wasm32-unknown-emscripten`) all three libraries must be
//! pre-compiled with Emscripten.  Set the environment variables:
//!
//! ```text
//! OCCT_WASM_ROOT   — Emscripten install prefix of OpenCASCADE
//! NETGEN_WASM_ROOT — Emscripten install prefix of Netgen (nglib)
//! MFEM_WASM_ROOT   — Emscripten install prefix of MFEM
//! ```
//!
//! Then run `scripts/build-wasm.sh` which invokes cargo with the correct
//! target and flags.

use kofem_core::{
    solver::mfem::{MfemParams, MfemSolver},
    solver::FemSolver,
    BoundaryConditions, LinearElasticMaterial,
};
use kofem_geom::{load_step, tessellate_model, TessOptions};
use kofem_mesh::{mesh_volume, MeshOptions, SurfaceMesh, VolumeMesh};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

// ── JSON data-transfer types ─────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct SurfaceMeshDto {
    pub vertices: Vec<[f64; 3]>,
    pub triangles: Vec<[usize; 3]>,
}

#[derive(Serialize, Deserialize)]
pub struct VolumeMeshDto {
    pub vertices: Vec<[f64; 3]>,
    pub tetrahedra: Vec<[usize; 4]>,
}

#[derive(Serialize, Deserialize)]
pub struct TessOptionsDto {
    /// Chord-height tolerance (mm).
    pub linear_deflection: f64,
    pub angular_deflection: f64,
}

#[derive(Serialize, Deserialize)]
pub struct MeshOptionsDto {
    pub max_element_size: f64,
    pub min_element_size: f64,
    pub grading: f64,
    pub second_order: bool,
}

#[derive(Serialize, Deserialize)]
pub struct MaterialDto {
    pub young_modulus: f64,
    pub poisson_ratio: f64,
    pub density: f64,
}

#[derive(Serialize, Deserialize)]
pub struct BoundaryConditionsDto {
    pub fixed_vertices: Vec<usize>,
    pub point_loads: Vec<PointLoadDto>,
}

#[derive(Serialize, Deserialize)]
pub struct PointLoadDto {
    pub vertex: usize,
    pub force: [f64; 3],
}

#[derive(Serialize, Deserialize)]
pub struct SolveResultDto {
    /// Flat array: [ux0, uy0, uz0, ux1, …]
    pub displacements: Vec<f64>,
    /// One von-Mises value per tetrahedral element.
    pub von_mises: Vec<f64>,
}

// ── WASM-exported functions ──────────────────────────────────────────────────

/// Load a STEP file and tessellate it into a surface triangle mesh.
///
/// @param step_bytes  raw STEP file content as a Uint8Array
/// @param opts_json   JSON-serialised TessOptionsDto
/// @returns JSON-serialised SurfaceMeshDto
#[wasm_bindgen]
pub fn tessellate_step(step_bytes: &[u8], opts_json: &str) -> Result<String, JsValue> {
    let opts: TessOptionsDto = serde_json::from_str(opts_json)
        .map_err(|e| JsValue::from_str(&format!("invalid opts: {e}")))?;

    let model = load_step(step_bytes).map_err(|e| JsValue::from_str(&e.to_string()))?;

    let tess_opts = TessOptions {
        linear_deflection: opts.linear_deflection,
        angular_deflection: opts.angular_deflection,
        ..TessOptions::default()
    };

    let surface =
        tessellate_model(&model, &tess_opts).map_err(|e| JsValue::from_str(&e.to_string()))?;

    let dto = SurfaceMeshDto {
        vertices: surface.vertices,
        triangles: surface.triangles,
    };
    serde_json::to_string(&dto).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Generate a quality tetrahedral volume mesh from a closed surface mesh.
///
/// @param surface_json  JSON-serialised SurfaceMeshDto
/// @param opts_json     JSON-serialised MeshOptionsDto
/// @returns JSON-serialised VolumeMeshDto
#[wasm_bindgen]
pub fn generate_volume_mesh(surface_json: &str, opts_json: &str) -> Result<String, JsValue> {
    let dto: SurfaceMeshDto = serde_json::from_str(surface_json)
        .map_err(|e| JsValue::from_str(&format!("invalid surface: {e}")))?;
    let opts: MeshOptionsDto = serde_json::from_str(opts_json)
        .map_err(|e| JsValue::from_str(&format!("invalid opts: {e}")))?;

    let surface = SurfaceMesh {
        vertices: dto.vertices,
        triangles: dto.triangles,
    };
    let mesh_opts = MeshOptions {
        max_element_size: opts.max_element_size,
        min_element_size: opts.min_element_size,
        grading: opts.grading,
        second_order: opts.second_order,
    };

    let volume =
        mesh_volume(&surface, &mesh_opts).map_err(|e| JsValue::from_str(&e.to_string()))?;

    let result = VolumeMeshDto {
        vertices: volume.vertices,
        tetrahedra: volume.tetrahedra,
    };
    serde_json::to_string(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Run a linear-elastic FEM solve using MFEM.
///
/// @param mesh_json  JSON-serialised VolumeMeshDto
/// @param mat_json   JSON-serialised MaterialDto
/// @param bcs_json   JSON-serialised BoundaryConditionsDto
/// @param order      FE polynomial order (1 = linear, 2 = quadratic)
/// @returns JSON-serialised SolveResultDto
#[wasm_bindgen]
pub fn solve_linear_elastic(
    mesh_json: &str,
    mat_json: &str,
    bcs_json: &str,
    order: i32,
) -> Result<String, JsValue> {
    let mesh_dto: VolumeMeshDto = serde_json::from_str(mesh_json)
        .map_err(|e| JsValue::from_str(&format!("invalid mesh: {e}")))?;
    let mat_dto: MaterialDto = serde_json::from_str(mat_json)
        .map_err(|e| JsValue::from_str(&format!("invalid material: {e}")))?;
    let bcs_dto: BoundaryConditionsDto = serde_json::from_str(bcs_json)
        .map_err(|e| JsValue::from_str(&format!("invalid BCs: {e}")))?;

    let mesh = VolumeMesh {
        vertices: mesh_dto.vertices,
        tetrahedra: mesh_dto.tetrahedra,
    };
    let material = LinearElasticMaterial {
        young_modulus: mat_dto.young_modulus,
        poisson_ratio: mat_dto.poisson_ratio,
        density: mat_dto.density,
    };
    let mut bcs = BoundaryConditions::default();
    for v in bcs_dto.fixed_vertices {
        bcs.fix_vertex(v);
    }
    for l in bcs_dto.point_loads {
        bcs.apply_force(l.vertex, l.force);
    }

    let solver = MfemSolver::new(MfemParams { order });
    let result = solver
        .solve_linear_elastic(&mesh, &material, &bcs)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let dto = SolveResultDto {
        displacements: result.displacements,
        von_mises: result.von_mises,
    };
    serde_json::to_string(&dto).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Convenience: full pipeline from STEP bytes to solve result in one call.
///
/// Production use should call each stage separately so the surface and volume
/// meshes can be inspected and visualised between steps.
#[wasm_bindgen]
pub fn step_to_fem_result(
    step_bytes: &[u8],
    tess_opts_json: &str,
    mesh_opts_json: &str,
    mat_json: &str,
    bcs_json: &str,
    order: i32,
) -> Result<String, JsValue> {
    let surface_json = tessellate_step(step_bytes, tess_opts_json)?;
    let volume_json = generate_volume_mesh(&surface_json, mesh_opts_json)?;
    solve_linear_elastic(&volume_json, mat_json, bcs_json, order)
}

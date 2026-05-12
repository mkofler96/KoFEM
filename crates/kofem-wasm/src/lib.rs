use wasm_bindgen::prelude::*;
use kofem_core::{Mesh, LinearStaticSolver};
use kofem_core::boundary::BoundaryConditions;

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

/// Exposed to JavaScript: create and solve a simple model.
/// Returns displacement array as Float64Array.
#[wasm_bindgen]
pub fn solve_linear_static(model_json: &str) -> Result<Vec<f64>, JsError> {
    // TODO: deserialize model from JSON, build Mesh + BCs, call solver
    let _ = model_json;
    let mesh = Mesh::new();
    let bcs = BoundaryConditions::default();
    let result = LinearStaticSolver::solve(&mesh, &bcs)
        .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(result.displacements)
}

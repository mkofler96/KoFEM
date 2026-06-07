pub mod types;
pub use types::{MeshOptions, SurfaceMesh, VolumeMesh};

use thiserror::Error;

// Native Netgen bridge — not implemented yet.
// The production pipeline runs via the WASM build: see engine/cpp/engine.cpp.

#[derive(Debug, Error)]
pub enum MeshError {
    #[error("meshing failed: {0}")]
    MeshingFailed(String),
}

/// Generate a tetrahedral volume mesh from a closed surface mesh using Netgen.
///
/// # Panics
/// Always panics on native targets. Use the WASM build via `scripts/build-wasm.sh`.
pub fn mesh_volume(_surface: &SurfaceMesh, _opts: &MeshOptions) -> Result<VolumeMesh, MeshError> {
    unimplemented!(
        "Native Netgen bridge is not implemented. \
         Use the WASM build produced by engine/cpp/engine.cpp via scripts/build-wasm.sh."
    )
}

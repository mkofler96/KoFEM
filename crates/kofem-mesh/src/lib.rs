// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

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
/// # Errors
/// Always returns [`MeshError::MeshingFailed`] on native targets — the Netgen bridge is not yet
/// implemented. Use the WASM build via `scripts/build-wasm.sh`.
pub fn mesh_volume(_surface: &SurfaceMesh, _opts: &MeshOptions) -> Result<VolumeMesh, MeshError> {
    Err(MeshError::MeshingFailed(
        "Native Netgen bridge is not yet implemented. \
         Use the WASM build produced by engine/cpp/engine.cpp via scripts/build-wasm.sh."
            .to_string(),
    ))
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn unit_tetrahedron_surface() -> SurfaceMesh {
        SurfaceMesh {
            vertices: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            triangles: vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
        }
    }

    #[test]
    fn mesh_volume_reports_missing_native_bridge() {
        let result = mesh_volume(&unit_tetrahedron_surface(), &MeshOptions::default());
        match result {
            Err(MeshError::MeshingFailed(msg)) => assert!(msg.contains("WASM build")),
            Ok(mesh) => panic!(
                "native Netgen bridge must not report success, got {} tets",
                mesh.tetrahedra.len()
            ),
        }
    }

    #[test]
    fn default_mesh_options_are_valid() {
        let opts = MeshOptions::default();
        assert!(opts.max_element_size > 0.0);
        assert!(opts.min_element_size >= 0.0);
        assert!(opts.min_element_size <= opts.max_element_size);
        assert!((0.1..=1.0).contains(&opts.grading));
        assert!(!opts.second_order);
    }
}

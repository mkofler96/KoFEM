//! `kofem-mesh` — volumetric mesh types and Netgen-based quality meshing.
//!
//! # Workflow
//!
//! 1. Obtain a [`SurfaceMesh`] from `kofem-geom` (OCCT tessellation of a STEP file).
//! 2. Call [`mesh_volume`] to fill the closed surface with quality tetrahedra via Netgen.
//! 3. Pass the resulting [`VolumeMesh`] to `kofem-core` for FEM solving.

pub mod netgen;
pub mod types;

pub use netgen::mesh_volume;
pub use types::{MeshOptions, SurfaceMesh, VolumeMesh};

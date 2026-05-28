//! `kofem-geom` — OCCT-based geometry import and tessellation.
//!
//! # Workflow
//!
//! 1. Load a STEP file with [`load_step`] → [`BRepModel`].
//! 2. Tessellate it with [`tessellate`] → [`kofem_mesh::SurfaceMesh`].
//! 3. Pass the surface mesh to `kofem-mesh` for volumetric meshing.

mod occt;

pub use occt::{GeomError, TessOptions};

use kofem_mesh::SurfaceMesh;

/// An opaque handle to an in-memory OCCT B-rep model.
///
/// Obtained via [`load_step`] and consumed by [`tessellate`].
/// The underlying OCCT shape is freed when this value is dropped.
pub struct BRepModel(occt::OcctShapeHandle);

/// Load a STEP file from raw bytes and return a handle to the B-rep model.
///
/// # Errors
/// Returns [`GeomError`] if the file cannot be parsed or contains no shapes.
pub fn load_step(data: &[u8]) -> Result<BRepModel, GeomError> {
    occt::load_step(data).map(BRepModel)
}

/// Tessellate a [`BRepModel`] into a closed triangle surface mesh.
///
/// The mesh can then be passed to [`kofem_mesh::mesh_volume`].
pub fn tessellate_model(model: &BRepModel, opts: &TessOptions) -> Result<SurfaceMesh, GeomError> {
    occt::tessellate(model.0.as_ptr(), opts)
}

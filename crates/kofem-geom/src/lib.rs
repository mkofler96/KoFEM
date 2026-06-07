use thiserror::Error;

// Native OCCT bridge — not implemented yet.
// The production pipeline runs via the WASM build: see engine/cpp/engine.cpp.

/// Opaque handle to a loaded CAD model. Not usable in native builds.
pub struct OcctModel;

/// Surface tessellation produced by OCCT — vertices + triangle indices.
pub struct Tessellation {
    pub vertices: Vec<[f64; 3]>,
    pub triangles: Vec<[usize; 3]>,
}

/// Load a STEP file into an [`OcctModel`].
///
/// # Panics
/// Always panics on native targets. Use the WASM build via `scripts/build-wasm.sh`.
pub fn load_step(_bytes: &[u8]) -> Result<OcctModel, GeomError> {
    unimplemented!(
        "Native OCCT bridge is not implemented. \
         Use the WASM build produced by engine/cpp/engine.cpp via scripts/build-wasm.sh."
    )
}

/// Tessellate an [`OcctModel`] into a surface triangle mesh.
///
/// # Panics
/// Always panics on native targets. Use the WASM build via `scripts/build-wasm.sh`.
pub fn tessellate_model(
    _model: &OcctModel,
    _opts: &TessOptions,
) -> Result<Tessellation, GeomError> {
    unimplemented!(
        "Native OCCT bridge is not implemented. \
         Use the WASM build produced by engine/cpp/engine.cpp via scripts/build-wasm.sh."
    )
}

#[derive(Debug, Error)]
pub enum GeomError {
    #[error("failed to load geometry: {0}")]
    LoadFailed(String),
    #[error("tessellation failed: {0}")]
    TessFailed(String),
    #[error("shape produced no triangles — try a smaller linear_deflection")]
    EmptyTessellation,
}

/// Options for surface tessellation.
#[derive(Debug, Clone)]
pub struct TessOptions {
    /// Chord-height tolerance (mm). Smaller = finer mesh on curves.
    pub linear_deflection: f64,
    /// Maximum angular deviation between adjacent triangle normals (radians).
    pub angular_deflection: f64,
    /// Use relative deflection (fraction of bounding-box size) instead of absolute.
    pub relative: bool,
}

impl Default for TessOptions {
    fn default() -> Self {
        Self {
            linear_deflection: 0.1,
            angular_deflection: 0.5,
            relative: false,
        }
    }
}

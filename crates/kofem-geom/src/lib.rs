use thiserror::Error;

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

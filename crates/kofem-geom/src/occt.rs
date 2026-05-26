use kofem_mesh::SurfaceMesh;
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

/// Options for OCCT incremental surface tessellation.
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

/// Newtype wrapping a raw `*mut c_void` OCCT shape pointer so we can impl Drop.
pub struct OcctShapeHandle(*mut std::ffi::c_void);

// Safety: OCCT shape objects are not thread-local; sending across threads is safe.
unsafe impl Send for OcctShapeHandle {}
unsafe impl Sync for OcctShapeHandle {}

impl OcctShapeHandle {
    pub fn as_ptr(&self) -> *mut std::ffi::c_void {
        self.0
    }
}

impl Drop for OcctShapeHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { ffi::occt_free_shape(self.0) };
        }
    }
}

/// Load a STEP file from a byte slice.
pub fn load_step(data: &[u8]) -> Result<OcctShapeHandle, GeomError> {
    let mut err_ptr: *const std::ffi::c_char = std::ptr::null();
    let handle = unsafe { ffi::occt_load_step(data.as_ptr(), data.len(), &mut err_ptr) };
    if handle.is_null() {
        let msg = if err_ptr.is_null() {
            "unknown OCCT error".to_string()
        } else {
            unsafe { std::ffi::CStr::from_ptr(err_ptr) }
                .to_string_lossy()
                .into_owned()
        };
        return Err(GeomError::LoadFailed(msg));
    }
    Ok(OcctShapeHandle(handle))
}

/// Tessellate a raw OCCT shape pointer.
pub fn tessellate(
    shape: *mut std::ffi::c_void,
    opts: &TessOptions,
) -> Result<SurfaceMesh, GeomError> {
    let c_opts = ffi::OcctTessOptions {
        linear_deflection: opts.linear_deflection,
        angular_deflection: opts.angular_deflection,
        relative_deflection: opts.relative as i32,
    };

    let mut verts_ptr: *mut f64 = std::ptr::null_mut();
    let mut n_verts: usize = 0;
    let mut tris_ptr: *mut i32 = std::ptr::null_mut();
    let mut n_tris: usize = 0;
    let mut err_ptr: *const std::ffi::c_char = std::ptr::null();

    let rc = unsafe {
        ffi::occt_tessellate(
            shape,
            &c_opts,
            &mut verts_ptr,
            &mut n_verts,
            &mut tris_ptr,
            &mut n_tris,
            &mut err_ptr,
        )
    };

    if rc != 0 {
        let msg = if err_ptr.is_null() {
            format!("OCCT tessellation error code {rc}")
        } else {
            unsafe { std::ffi::CStr::from_ptr(err_ptr) }
                .to_string_lossy()
                .into_owned()
        };
        return Err(if n_verts == 0 {
            GeomError::EmptyTessellation
        } else {
            GeomError::TessFailed(msg)
        });
    }

    // Copy into owned Rust vecs, then free the C buffers
    let vertices = unsafe { std::slice::from_raw_parts(verts_ptr, 3 * n_verts) }
        .chunks_exact(3)
        .map(|c| [c[0], c[1], c[2]])
        .collect();

    let triangles = unsafe { std::slice::from_raw_parts(tris_ptr, 3 * n_tris) }
        .chunks_exact(3)
        .map(|c| [c[0] as usize, c[1] as usize, c[2] as usize])
        .collect();

    unsafe { ffi::occt_free_tessellation(verts_ptr, tris_ptr) };

    Ok(SurfaceMesh {
        vertices,
        triangles,
    })
}

mod ffi {
    #[repr(C)]
    pub struct OcctTessOptions {
        pub linear_deflection: f64,
        pub angular_deflection: f64,
        pub relative_deflection: i32,
    }

    pub type OcctShape = *mut std::ffi::c_void;

    unsafe extern "C" {
        pub fn occt_load_step(
            data: *const u8,
            len: usize,
            err: *mut *const std::ffi::c_char,
        ) -> OcctShape;

        pub fn occt_free_shape(shape: OcctShape);

        pub fn occt_tessellate(
            shape: OcctShape,
            opts: *const OcctTessOptions,
            out_vertices: *mut *mut f64,
            out_n_vertices: *mut usize,
            out_triangles: *mut *mut i32,
            out_n_triangles: *mut usize,
            err: *mut *const std::ffi::c_char,
        ) -> i32;

        pub fn occt_free_tessellation(vertices: *mut f64, triangles: *mut i32);
    }
}

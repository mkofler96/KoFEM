use crate::types::{MeshOptions, SurfaceMesh, VolumeMesh};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum MeshError {
    #[error("surface mesh is empty")]
    EmptySurface,
    #[error("Netgen failed with error code {0}")]
    NetgenError(i32),
    #[error("Netgen returned an empty volume mesh")]
    EmptyResult,
}

/// Fill a closed surface with quality tetrahedra using Netgen.
pub fn mesh_volume(surface: &SurfaceMesh, opts: &MeshOptions) -> Result<VolumeMesh, MeshError> {
    if surface.vertices.is_empty() || surface.triangles.is_empty() {
        return Err(MeshError::EmptySurface);
    }

    // Flatten to C-compatible buffers
    let vertices: Vec<f64> = surface
        .vertices
        .iter()
        .flat_map(|v| v.iter().copied())
        .collect();
    let triangles: Vec<i32> = surface
        .triangles
        .iter()
        .flat_map(|t| t.iter().map(|&i| i as i32))
        .collect();

    let ng_opts = ffi::NgMeshOptions {
        max_element_size: opts.max_element_size,
        min_element_size: opts.min_element_size,
        grading: opts.grading,
        second_order: opts.second_order as i32,
    };

    unsafe {
        let handle = ffi::ng_mesh_create(
            vertices.as_ptr(),
            surface.vertices.len(),
            triangles.as_ptr(),
            surface.triangles.len(),
        );

        let rc = ffi::ng_mesh_generate_volume(handle, &ng_opts);
        if rc != 0 {
            ffi::ng_mesh_free(handle);
            return Err(MeshError::NetgenError(rc));
        }

        let n_verts = ffi::ng_mesh_n_vertices(handle);
        let n_tets = ffi::ng_mesh_n_tets(handle);

        if n_verts == 0 || n_tets == 0 {
            ffi::ng_mesh_free(handle);
            return Err(MeshError::EmptyResult);
        }

        let mut flat_verts = vec![0.0f64; 3 * n_verts];
        let mut flat_tets = vec![0i32; 4 * n_tets];
        ffi::ng_mesh_get_vertices(handle, flat_verts.as_mut_ptr());
        ffi::ng_mesh_get_tets(handle, flat_tets.as_mut_ptr());
        ffi::ng_mesh_free(handle);

        let vertices = flat_verts
            .chunks_exact(3)
            .map(|c| [c[0], c[1], c[2]])
            .collect();

        let tetrahedra = flat_tets
            .chunks_exact(4)
            .map(|c| [c[0] as usize, c[1] as usize, c[2] as usize, c[3] as usize])
            .collect();

        Ok(VolumeMesh {
            vertices,
            tetrahedra,
        })
    }
}

mod ffi {
    #[repr(C)]
    pub struct NgMeshOptions {
        pub max_element_size: f64,
        pub min_element_size: f64,
        pub grading: f64,
        pub second_order: i32,
    }

    pub type NgMeshHandle = *mut std::ffi::c_void;

    unsafe extern "C" {
        pub fn ng_mesh_create(
            vertices: *const f64,
            n_vertices: usize,
            triangles: *const i32,
            n_triangles: usize,
        ) -> NgMeshHandle;

        pub fn ng_mesh_generate_volume(mesh: NgMeshHandle, opts: *const NgMeshOptions) -> i32;

        pub fn ng_mesh_n_vertices(mesh: NgMeshHandle) -> usize;
        pub fn ng_mesh_n_tets(mesh: NgMeshHandle) -> usize;

        pub fn ng_mesh_get_vertices(mesh: NgMeshHandle, out: *mut f64);
        pub fn ng_mesh_get_tets(mesh: NgMeshHandle, out: *mut i32);

        pub fn ng_mesh_free(mesh: NgMeshHandle);
    }
}

//! Integration tests for the OCCT → Netgen → MFEM pipeline.
//!
//! These tests require the native libraries to be installed:
//!   OCCT  (libocct-*-dev),  NETGEN_ROOT / system netgen-headers + libnglib,
//!   MFEM  (libmfem-dev + MPI + HYPRE headers)
//!
//! All heavy tests are gated behind `#[ignore]` so `cargo test` in CI
//! requires `-- --include-ignored` or the dedicated `-- --test-threads=1`
//! flag used in the ci.yml.

use kofem_core::{
    solver::{mfem::MfemParams, FemSolver},
    BoundaryConditions, LinearElasticMaterial, MfemSolver,
};
use kofem_mesh::{mesh_volume, MeshOptions, SurfaceMesh};

// ── helpers ──────────────────────────────────────────────────────────────────

/// A unit cube (side = 1.0) as a closed surface mesh (12 triangles, CCW from outside).
fn unit_cube_surface() -> SurfaceMesh {
    let vertices = vec![
        // bottom face z = 0
        [0.0, 0.0, 0.0], // 0
        [1.0, 0.0, 0.0], // 1
        [1.0, 1.0, 0.0], // 2
        [0.0, 1.0, 0.0], // 3
        // top face z = 1
        [0.0, 0.0, 1.0], // 4
        [1.0, 0.0, 1.0], // 5
        [1.0, 1.0, 1.0], // 6
        [0.0, 1.0, 1.0], // 7
    ];
    let triangles = vec![
        // -Z bottom (inward normal = +Z, so CCW from below = CW from above)
        [0, 2, 1],
        [0, 3, 2],
        // +Z top
        [4, 5, 6],
        [4, 6, 7],
        // -Y front
        [0, 1, 5],
        [0, 5, 4],
        // +Y back
        [2, 3, 7],
        [2, 7, 6],
        // -X left
        [0, 4, 7],
        [0, 7, 3],
        // +X right
        [1, 2, 6],
        [1, 6, 5],
    ];
    SurfaceMesh {
        vertices,
        triangles,
    }
}

/// A 1×1×5 elongated box surface mesh for a cantilever test.
fn cantilever_surface() -> SurfaceMesh {
    let vertices = vec![
        // z = 0 (fixed end)
        [0.0, 0.0, 0.0], // 0
        [1.0, 0.0, 0.0], // 1
        [1.0, 1.0, 0.0], // 2
        [0.0, 1.0, 0.0], // 3
        // z = 5 (free end)
        [0.0, 0.0, 5.0], // 4
        [1.0, 0.0, 5.0], // 5
        [1.0, 1.0, 5.0], // 6
        [0.0, 1.0, 5.0], // 7
    ];
    let triangles = vec![
        [0, 2, 1],
        [0, 3, 2], // -z
        [4, 5, 6],
        [4, 6, 7], // +z
        [0, 1, 5],
        [0, 5, 4], // -y
        [2, 3, 7],
        [2, 7, 6], // +y
        [0, 4, 7],
        [0, 7, 3], // -x
        [1, 2, 6],
        [1, 6, 5], // +x
    ];
    SurfaceMesh {
        vertices,
        triangles,
    }
}

// ── Netgen tests ─────────────────────────────────────────────────────────────

/// Smoke test: Netgen can mesh a unit cube surface.
#[test]
fn netgen_unit_cube() {
    let surface = unit_cube_surface();
    let opts = MeshOptions {
        max_element_size: 0.5,
        ..MeshOptions::default()
    };
    let vol = mesh_volume(&surface, &opts).expect("Netgen volume mesh failed");

    // A unit cube should produce at least a handful of tets
    assert!(
        vol.tetrahedra.len() >= 4,
        "too few tets: {}",
        vol.tetrahedra.len()
    );
    assert!(
        vol.vertices.len() >= 8,
        "fewer vertices than input: {}",
        vol.vertices.len()
    );

    // All tet vertex indices must be in range
    for (i, tet) in vol.tetrahedra.iter().enumerate() {
        for &v in tet {
            assert!(
                v < vol.vertices.len(),
                "tet {i} references out-of-range vertex {v}"
            );
        }
    }
    println!(
        "netgen_unit_cube: {} vertices, {} tets",
        vol.vertices.len(),
        vol.tetrahedra.len()
    );
}

// ── MFEM tests ───────────────────────────────────────────────────────────────

/// Smoke test: MFEM can solve a simple linear-elastic problem on a cube mesh.
#[test]
fn mfem_unit_cube_elastic() {
    // 1. Mesh the cube
    let surface = unit_cube_surface();
    let vol = mesh_volume(
        &surface,
        &MeshOptions {
            max_element_size: 0.4,
            ..Default::default()
        },
    )
    .expect("meshing failed");

    // 2. Fix the z=0 face (find vertices with z ≈ 0)
    let mut bcs = BoundaryConditions::default();
    for (i, v) in vol.vertices.iter().enumerate() {
        if v[2] < 1e-6 {
            bcs.fix_vertex(i);
        }
    }
    assert!(!bcs.fixed_vertices.is_empty(), "no fixed vertices found");

    // 3. Apply a unit load on all z=1 vertices in +z direction
    for (i, v) in vol.vertices.iter().enumerate() {
        if v[2] > 1.0 - 1e-6 {
            bcs.apply_force(i, [0.0, 0.0, 100.0]);
        }
    }

    let material = LinearElasticMaterial::steel();
    let solver = MfemSolver::new(MfemParams { order: 1 });
    let result = solver
        .solve_linear_elastic(&vol, &material, &bcs)
        .expect("MFEM solve failed");

    // Displacements at fixed vertices must be zero
    for &v in &bcs.fixed_vertices {
        let ux = result.displacements[3 * v];
        let uy = result.displacements[3 * v + 1];
        let uz = result.displacements[3 * v + 2];
        assert!(
            ux.abs() < 1e-12 && uy.abs() < 1e-12 && uz.abs() < 1e-12,
            "vertex {v} should be fixed but has displacement ({ux}, {uy}, {uz})"
        );
    }

    // Free-end vertices should have positive z-displacement (loaded in +z)
    let max_uz = vol
        .vertices
        .iter()
        .enumerate()
        .filter(|(_, v)| v[2] > 1.0 - 1e-6)
        .map(|(i, _)| result.displacements[3 * i + 2])
        .fold(f64::NEG_INFINITY, f64::max);
    assert!(
        max_uz > 0.0,
        "top face should move in +z; max uz = {max_uz}"
    );

    println!(
        "mfem_unit_cube_elastic: {} vertices, {} elements, max uz = {:.2e}",
        result.displacements.len() / 3,
        result.von_mises.len(),
        max_uz
    );
}

// ── Full pipeline test ────────────────────────────────────────────────────────

/// End-to-end: mesh a cantilever via Netgen, solve via MFEM, check basic physics.
/// (OCCT step skipped — we feed a programmatic surface mesh directly.)
#[test]
fn full_pipeline_cantilever() {
    let surface = cantilever_surface();

    let vol = mesh_volume(
        &surface,
        &MeshOptions {
            max_element_size: 1.0,
            grading: 0.3,
            ..Default::default()
        },
    )
    .expect("Netgen failed");

    let mut bcs = BoundaryConditions::default();
    // Fix z = 0 face (clamped root)
    for (i, v) in vol.vertices.iter().enumerate() {
        if v[2] < 1e-6 {
            bcs.fix_vertex(i);
        }
    }

    // Apply transverse load at z = 5 tip
    for (i, v) in vol.vertices.iter().enumerate() {
        if v[2] > 5.0 - 1e-6 {
            bcs.apply_force(i, [0.0, 1000.0, 0.0]); // force in y
        }
    }

    let material = LinearElasticMaterial::steel();
    let solver = MfemSolver::new(MfemParams { order: 1 });
    let result = solver
        .solve_linear_elastic(&vol, &material, &bcs)
        .expect("solve failed");

    // Tip should deflect in +y
    let tip_uy_max = vol
        .vertices
        .iter()
        .enumerate()
        .filter(|(_, v)| v[2] > 5.0 - 1e-6)
        .map(|(i, _)| result.displacements[3 * i + 1])
        .fold(f64::NEG_INFINITY, f64::max);
    assert!(
        tip_uy_max > 0.0,
        "cantilever tip should deflect in +y; got {tip_uy_max}"
    );

    // Von-Mises stresses should all be non-negative
    for (i, &vm) in result.von_mises.iter().enumerate() {
        assert!(vm >= 0.0, "element {i} has negative von Mises stress {vm}");
    }

    println!(
        "full_pipeline_cantilever: {} verts, {} tets, tip uy = {:.2e} m",
        vol.vertices.len(),
        vol.tetrahedra.len(),
        tip_uy_max
    );
}

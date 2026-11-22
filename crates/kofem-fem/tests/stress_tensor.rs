// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Stress tensors (KOF-447): the six global components per element, for solid
//! elements at the centre and for shell facets on a chosen surface, and the
//! principal stresses of a tensor.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::many_single_char_names,
    clippy::min_ident_chars,
    reason = "test fixtures that fail to build should abort the test; the tensor \
              components keep the textbook names σ, τ, g"
)]

#[allow(
    dead_code,
    reason = "the shared fixture's vertices and size are not needed here"
)]
mod support;

use kofem_fem::{
    principal_stresses, shell_stress_tensors, stress_tensors, von_mises, ElementOrder, Isotropic,
    ShellMesh, ShellSurface, TetMesh,
};
use support::box_mesh;

const YOUNG: f64 = 210_000.0;
const POISSON: f64 = 0.3;

fn steel() -> Isotropic {
    Isotropic::new(0, YOUNG, POISSON).expect("valid material")
}

/// A general linear displacement gradient G (u = G·x): every element type
/// reproduces it exactly.
const GRADIENT: [[f64; 3]; 3] = [
    [1.0e-4, 2.0e-5, -3.0e-5],
    [4.0e-5, -2.0e-4, 1.0e-5],
    [-5.0e-5, 3.0e-5, 1.5e-4],
];

/// σ = λ·tr(ε)·I + 2μ·ε of GRADIENT, as [σxx, σyy, σzz, τxy, τyz, τzx].
fn expected_tensor() -> [f64; 6] {
    let (lambda, mu) = steel().lame();
    let g = GRADIENT;
    let strain = |i: usize, j: usize| f64::midpoint(g[i][j], g[j][i]);
    let trace = g[0][0] + g[1][1] + g[2][2];
    [
        lambda * trace + 2.0 * mu * strain(0, 0),
        lambda * trace + 2.0 * mu * strain(1, 1),
        lambda * trace + 2.0 * mu * strain(2, 2),
        2.0 * mu * strain(0, 1),
        2.0 * mu * strain(1, 2),
        2.0 * mu * strain(2, 0),
    ]
}

fn linear_field(mesh: &TetMesh) -> Vec<f64> {
    mesh.node_coordinates()
        .iter()
        .flat_map(|p| GRADIENT.map(|row| row[0] * p[0] + row[1] * p[1] + row[2] * p[2]))
        .collect()
}

fn assert_tensors(mesh: &TetMesh, label: &str) {
    let tensors = stress_tensors(mesh, &linear_field(mesh)).expect("fits");
    assert_eq!(tensors.len(), mesh.element_count(), "{label}");
    let expected = expected_tensor();
    let scale = expected.iter().fold(0.0_f64, |m, v| m.max(v.abs()));
    for (element, tensor) in tensors.iter().enumerate() {
        for (got, want) in tensor.iter().zip(expected) {
            assert!(
                (got - want).abs() < 1e-9 * scale,
                "{label} element {element}: {tensor:?} vs {expected:?}"
            );
        }
    }
}

#[test]
fn linear_tets_reproduce_a_linear_field() {
    assert_tensors(&box_mesh([2, 2, 1], [2.0, 3.0, 1.0], steel()).mesh, "tet4");
}

#[test]
fn quadratic_tets_reproduce_a_linear_field() {
    let mesh = box_mesh([2, 1, 1], [2.0, 1.0, 1.0], steel())
        .mesh
        .with_order(ElementOrder::Quadratic)
        .expect("fits");
    assert_tensors(&mesh, "tet10");
}

fn hex_cube(order: ElementOrder) -> TetMesh {
    // One unit hex, bottom face then the top face above it.
    let points = [
        [0.0, 0.0, 0.0],
        [2.0, 0.0, 0.0],
        [2.0, 1.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.5],
        [2.0, 0.0, 1.5],
        [2.0, 1.0, 1.5],
        [0.0, 1.0, 1.5],
    ];
    let flat: Vec<f64> = points.iter().flatten().copied().collect();
    TetMesh::with_hexahedra(&flat, &[], &[0, 1, 2, 3, 4, 5, 6, 7], &[0], vec![steel()])
        .and_then(|mesh| mesh.with_order(order))
        .expect("valid hex")
}

#[test]
fn hexahedra_reproduce_a_linear_field() {
    assert_tensors(&hex_cube(ElementOrder::Linear), "hex8");
    assert_tensors(&hex_cube(ElementOrder::Quadratic), "hex27");
}

#[test]
fn von_mises_of_the_tensor_matches_von_mises() {
    let mesh = box_mesh([2, 1, 1], [2.0, 1.0, 1.0], steel()).mesh;
    let field = linear_field(&mesh);
    let [sx, sy, sz, txy, tyz, tzx] = stress_tensors(&mesh, &field).expect("fits")[0];
    let from_tensor = (0.5 * ((sx - sy).powi(2) + (sy - sz).powi(2) + (sz - sx).powi(2))
        + 3.0 * (txy * txy + tyz * tyz + tzx * tzx))
        .sqrt();
    let vm = von_mises(&mesh, &field).expect("fits")[0];
    assert!(
        (from_tensor - vm).abs() < 1e-9 * vm,
        "{from_tensor} vs {vm}"
    );
}

#[test]
fn stress_tensors_refuse_a_displacement_of_the_wrong_length() {
    let mesh = box_mesh([1, 1, 1], [1.0, 1.0, 1.0], steel()).mesh;
    assert!(stress_tensors(&mesh, &[0.0; 5]).is_err());
}

#[test]
fn principal_stresses_of_a_diagonal_tensor_are_its_entries_sorted() {
    let principal = principal_stresses([5.0, -2.0, 7.0, 0.0, 0.0, 0.0]);
    for (got, want) in principal.iter().zip([7.0, 5.0, -2.0]) {
        assert!((got - want).abs() < 1e-12, "{principal:?}");
    }
}

#[test]
fn principal_stresses_of_pure_shear_are_plus_and_minus_tau() {
    let [s1, s2, s3] = principal_stresses([0.0, 0.0, 0.0, 4.0, 0.0, 0.0]);
    assert!((s1 - 4.0).abs() < 1e-12 && s2.abs() < 1e-12 && (s3 + 4.0).abs() < 1e-12);
}

#[test]
fn principal_stresses_keep_the_invariants() {
    let tensor = [10.0, -3.0, 2.0, 4.0, -1.5, 2.5];
    let [sx, sy, sz, txy, tyz, tzx] = tensor;
    let [s1, s2, s3] = principal_stresses(tensor);
    assert!(s1 >= s2 && s2 >= s3);
    let i1 = sx + sy + sz;
    let i2 = sx * sy + sy * sz + sz * sx - txy * txy - tyz * tyz - tzx * tzx;
    let i3 =
        sx * sy * sz + 2.0 * txy * tyz * tzx - sx * tyz * tyz - sy * tzx * tzx - sz * txy * txy;
    assert!((s1 + s2 + s3 - i1).abs() < 1e-9);
    assert!((s1 * s2 + s2 * s3 + s3 * s1 - i2).abs() < 1e-9);
    assert!((s1 * s2 * s3 - i3).abs() < 1e-8);
}

/// One flat facet in the plane z = 0 (normal +z) with a prescribed membrane
/// stretch and bending curvature through nodal DOFs.
fn facet() -> ShellMesh {
    ShellMesh::new(
        &[0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 2.0, 0.0],
        &[0, 1, 2],
        &[0.1],
        &[0],
        vec![steel()],
    )
    .expect("valid facet")
}

#[test]
fn shell_membrane_stress_is_the_same_on_every_surface() {
    let mesh = facet();
    // u = ε·x: a uniaxial membrane strain εxx along x.
    let strain = 1e-4;
    let mut dofs = vec![0.0; 18];
    for (node, x) in [0.0, 2.0, 0.0].into_iter().enumerate() {
        dofs[6 * node] = strain * x;
    }
    let sigma = YOUNG / (1.0 - POISSON * POISSON) * strain;
    for surface in [
        ShellSurface::Top,
        ShellSurface::Middle,
        ShellSurface::Bottom,
    ] {
        let [sx, sy, sz, txy, tyz, tzx] =
            shell_stress_tensors(&mesh, &dofs, surface).expect("fits")[0];
        assert!((sx - sigma).abs() < 1e-9 * sigma, "{surface:?} σxx {sx}");
        assert!(
            (sy - POISSON * sigma).abs() < 1e-9 * sigma,
            "{surface:?} σyy {sy}"
        );
        for zero in [sz, txy, tyz, tzx] {
            assert!(zero.abs() < 1e-9 * sigma, "{surface:?}: {zero}");
        }
    }
}

#[test]
fn shell_bending_stress_has_the_physical_sign_on_each_surface() {
    let mesh = facet();
    // The exact Kirchhoff field w = κ·x²/2 with the rotation it implies: a
    // right-handed rotation θy about +y moves the material at height z by
    // u = θy·z and tilts the facet as w = −θy·x, so θy = −∂w/∂x = −κ·x and
    // εxx(z) = ∂u/∂x = −κ·z. For κ > 0 the facet curves up (towards +z): its
    // top surface z = +t/2 is shortened, its bottom stretched.
    let kappa = 1e-3;
    let mut dofs = vec![0.0; 18];
    for (node, x) in [0.0_f64, 2.0, 0.0].into_iter().enumerate() {
        dofs[6 * node + 2] = 0.5 * kappa * x * x;
        dofs[6 * node + 4] = -kappa * x;
    }
    let top = shell_stress_tensors(&mesh, &dofs, ShellSurface::Top).expect("fits")[0];
    let middle = shell_stress_tensors(&mesh, &dofs, ShellSurface::Middle).expect("fits")[0];
    let bottom = shell_stress_tensors(&mesh, &dofs, ShellSurface::Bottom).expect("fits")[0];
    let half = 0.05;
    let bending = YOUNG / (1.0 - POISSON * POISSON) * kappa * half;
    assert!(
        (top[0] + bending).abs() < 1e-6 * bending,
        "top σxx {}",
        top[0]
    );
    assert!(
        (bottom[0] - bending).abs() < 1e-6 * bending,
        "bottom σxx {}",
        bottom[0]
    );
    assert!(
        (top[1] + POISSON * bending).abs() < 1e-6 * bending,
        "top σyy {}",
        top[1]
    );
    assert!(middle[0].abs() < 1e-9 * bending);
    // A facet in the plane z = 0 has no out-of-plane components.
    for tensor in [top, bottom] {
        assert!(tensor[2].abs() < 1e-12 && tensor[4].abs() < 1e-12 && tensor[5].abs() < 1e-12);
    }
}

#[test]
fn shell_stress_is_rotated_into_global_axes() {
    // The facet of `facet` stood up in the plane x = 0, its local x along
    // global y: a membrane strain along global y gives σyy, not σxx.
    let mesh = ShellMesh::new(
        &[0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 2.0],
        &[0, 1, 2],
        &[0.1],
        &[0],
        vec![steel()],
    )
    .expect("valid facet");
    let strain = 1e-4;
    let mut dofs = vec![0.0; 18];
    for (node, y) in [0.0, 2.0, 0.0].into_iter().enumerate() {
        dofs[6 * node + 1] = strain * y;
    }
    let sigma = YOUNG / (1.0 - POISSON * POISSON) * strain;
    let [sx, sy, sz, txy, tyz, tzx] =
        shell_stress_tensors(&mesh, &dofs, ShellSurface::Middle).expect("fits")[0];
    assert!((sy - sigma).abs() < 1e-9 * sigma, "σyy {sy}");
    assert!((sz - POISSON * sigma).abs() < 1e-9 * sigma, "σzz {sz}");
    for zero in [sx, txy, tyz, tzx] {
        assert!(zero.abs() < 1e-9 * sigma, "{zero}");
    }
}

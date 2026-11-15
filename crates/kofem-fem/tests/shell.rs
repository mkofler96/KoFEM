// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The Kirchhoff shell (CST + DKT) against closed-form references: the same
//! cases and tolerances as the C++ engine's `engine/tests/shell_validation.cpp`,
//! plus membrane and bending patch tests and rigid-body motion on distorted,
//! tilted meshes.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

use kofem_fem::shell::facet_stiffness;
use kofem_fem::{
    assemble_shell_stiffness, shell_translations, shell_von_mises, solve_shell_static, CgSettings,
    FemError, Isotropic, ShellMesh, ShellPreconditioner, ShellSolution, StoppingRule,
};

/// The C++ shell solve's stopping rule: ‖r‖/‖f‖ < 1e-10.
const SETTINGS: CgSettings = CgSettings {
    relative_tolerance: 1e-10,
    max_iterations: 100_000,
    stopping: StoppingRule::ResidualNorm,
};

/// A shell model under construction: mesh arrays, supports and loads.
struct Model {
    vertices: Vec<[f64; 3]>,
    triangles: Vec<u32>,
    thickness: Vec<f64>,
    material_of_triangle: Vec<u32>,
    materials: Vec<Isotropic>,
    fixed: Vec<u32>,
    values: Vec<f64>,
    forces: Vec<f64>,
}

impl Model {
    /// [0, a]×[0, b] in the z = 0 plane, nx × ny cells of two triangles,
    /// node (i, j) = i·(ny + 1) + j — the C++ `plate_mesh` layout.
    fn grid(size: [f64; 2], cells: [usize; 2], thickness: f64, material: Isotropic) -> Self {
        let [nx, ny] = cells;
        let mut vertices = Vec::new();
        for i in 0..=nx {
            for j in 0..=ny {
                vertices.push([
                    size[0] * i as f64 / nx as f64,
                    size[1] * j as f64 / ny as f64,
                    0.0,
                ]);
            }
        }
        let id = |i: usize, j: usize| (i * (ny + 1) + j) as u32;
        let mut triangles = Vec::new();
        for i in 0..nx {
            for j in 0..ny {
                let (a0, a1, a2, a3) = (id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1));
                triangles.extend([a0, a1, a2, a0, a2, a3]);
            }
        }
        let count = triangles.len() / 3;
        let nodes = vertices.len();
        Self {
            vertices,
            triangles,
            thickness: vec![thickness; count],
            material_of_triangle: vec![0; count],
            materials: vec![material],
            fixed: Vec::new(),
            values: Vec::new(),
            forces: vec![0.0; 6 * nodes],
        }
    }

    fn triangle_count(&self) -> usize {
        self.triangles.len() / 3
    }

    fn fix(&mut self, node: usize, components: &[usize]) {
        for &component in components {
            self.prescribe(node, component, 0.0);
        }
    }

    fn prescribe(&mut self, node: usize, component: usize, value: f64) {
        self.fixed.push((6 * node + component) as u32);
        self.values.push(value);
    }

    fn load(&mut self, node: usize, component: usize, value: f64) {
        self.forces[6 * node + component] += value;
    }

    fn mesh(&self) -> Result<ShellMesh, FemError> {
        let flat: Vec<f64> = self.vertices.iter().flatten().copied().collect();
        ShellMesh::new(
            &flat,
            &self.triangles,
            &self.thickness,
            &self.material_of_triangle,
            self.materials.clone(),
        )
    }

    fn solve(&self) -> Result<(ShellMesh, ShellSolution), FemError> {
        let mesh = self.mesh()?;
        let stiffness = assemble_shell_stiffness(&mesh);
        let solution = solve_shell_static(
            &mesh,
            &stiffness,
            &self.fixed,
            &self.values,
            &self.forces,
            SETTINGS,
        )?;
        Ok((mesh, solution))
    }
}

fn material(young: f64, poisson: f64) -> Isotropic {
    Isotropic::new(0, young, poisson).expect("valid material")
}

fn relative_error(got: f64, reference: f64) -> f64 {
    (got - reference).abs() / reference.abs()
}

fn assert_within(name: &str, got: f64, reference: f64, percent: f64) {
    let error = 100.0 * relative_error(got, reference);
    assert!(
        error <= percent,
        "{name}: got {got:e}, reference {reference:e}, error {error:.3}% (tolerance {percent}%)"
    );
}

fn triangle_area(corners: [[f64; 3]; 3]) -> f64 {
    let first = sub(corners[1], corners[0]);
    let second = sub(corners[2], corners[0]);
    0.5 * norm(cross(first, second))
}

fn sub(lhs: [f64; 3], rhs: [f64; 3]) -> [f64; 3] {
    [lhs[0] - rhs[0], lhs[1] - rhs[1], lhs[2] - rhs[2]]
}

fn cross(lhs: [f64; 3], rhs: [f64; 3]) -> [f64; 3] {
    [
        lhs[1] * rhs[2] - lhs[2] * rhs[1],
        lhs[2] * rhs[0] - lhs[0] * rhs[2],
        lhs[0] * rhs[1] - lhs[1] * rhs[0],
    ]
}

fn dot(lhs: [f64; 3], rhs: [f64; 3]) -> f64 {
    lhs.iter().zip(&rhs).map(|(left, right)| left * right).sum()
}

fn norm(vector: [f64; 3]) -> f64 {
    vector.iter().map(|value| value * value).sum::<f64>().sqrt()
}

// ── Plates (Timoshenko & Woinowsky-Krieger) ──────────────────────────────────

const PLATE: (f64, f64, f64, f64, f64) = (1.0, 0.01, 1.0e7, 0.3, 1.0); // a, t, E, ν, q

/// Centre deflection of a square plate under uniform pressure, and the von
/// Mises stress of the facet nearest the centre — the C++ `plate_center_w`.
fn plate_centre(cells: usize, clamped: bool) -> (f64, f64) {
    let (side, thickness, young, poisson, pressure) = PLATE;
    let mut model = Model::grid(
        [side, side],
        [cells, cells],
        thickness,
        material(young, poisson),
    );
    let id = |i: usize, j: usize| i * (cells + 1) + j;
    for i in 0..=cells {
        for j in 0..=cells {
            let edge = i == 0 || i == cells || j == 0 || j == cells;
            if clamped {
                if edge {
                    model.fix(id(i, j), &[0, 1, 2, 3, 4, 5]);
                }
            } else {
                if edge {
                    model.fix(id(i, j), &[2]);
                }
                // Isolate bending: pin in-plane translations and drilling.
                model.fix(id(i, j), &[0, 1, 5]);
            }
        }
    }
    for triangle in model.triangles.clone().as_chunks::<3>().0 {
        let corners = [0, 1, 2].map(|k| model.vertices[triangle[k] as usize]);
        let share = pressure * triangle_area(corners) / 3.0;
        for &node in triangle {
            model.load(node as usize, 2, share);
        }
    }
    let (mesh, solution) = model.solve().expect("plate solves");
    let stresses = shell_von_mises(&mesh, &solution.dofs).expect("stress recovery");
    let centre = [side / 2.0, side / 2.0, 0.0];
    let nearest = (0..mesh.triangles().len())
        .min_by(|&lhs, &rhs| {
            let distance = |triangle: usize| {
                let corners = mesh.corners(triangle);
                let centroid: [f64; 3] =
                    std::array::from_fn(|k| (corners[0][k] + corners[1][k] + corners[2][k]) / 3.0);
                norm(sub(centroid, centre))
            };
            distance(lhs).total_cmp(&distance(rhs))
        })
        .expect("the plate has facets");
    (
        solution.dofs[6 * id(cells / 2, cells / 2) + 2],
        stresses[nearest],
    )
}

fn flexural_rigidity() -> f64 {
    let (_, thickness, young, poisson, _) = PLATE;
    young * thickness.powi(3) / (12.0 * (1.0 - poisson * poisson))
}

#[test]
fn clamped_square_plate_matches_plate_theory() {
    let (side, .., pressure) = PLATE;
    let (deflection, _) = plate_centre(32, true);
    let reference = 0.00126 * pressure * side.powi(4) / flexural_rigidity();
    assert_within("clamped plate", deflection, reference, 1.5);
}

#[test]
fn simply_supported_square_plate_matches_plate_theory() {
    let (side, thickness, .., pressure) = PLATE;
    let (deflection, stress) = plate_centre(32, false);
    let reference = 0.00406 * pressure * side.powi(4) / flexural_rigidity();
    assert_within("simply supported plate", deflection, reference, 1.0);
    // M = 0.0479·q·a² (ν = 0.3) in both directions, so von Mises = 6M/t².
    let moment = 0.0479 * pressure * side * side;
    assert_within(
        "simply supported plate, centre von Mises",
        stress,
        6.0 * moment / (thickness * thickness),
        8.0,
    );
}

#[test]
fn membrane_tension_matches_bar_theory() {
    let (young, thickness, stress, cells) = (1000.0, 0.1, 1.0, 8);
    let mut model = Model::grid([1.0, 1.0], [cells, cells], thickness, material(young, 0.0));
    let id = |i: usize, j: usize| i * (cells + 1) + j;
    for node in 0..model.vertices.len() {
        model.fix(node, &[2, 3, 4, 5]);
    }
    for j in 0..=cells {
        model.fix(id(0, j), &[0, 1]);
        let weight = if j == 0 || j == cells { 0.5 } else { 1.0 };
        model.load(id(cells, j), 0, stress * thickness * weight / cells as f64);
    }
    let (_, solution) = model.solve().expect("membrane solves");
    let mean = (0..=cells)
        .map(|j| solution.dofs[6 * id(cells, j)])
        .sum::<f64>()
        / (cells + 1) as f64;
    assert_within("membrane tension", mean, stress / young, 0.5);
}

// ── Patch tests and rigid-body motion on a distorted, tilted mesh ────────────

/// A 4×4 grid with its interior nodes moved off the grid lines, mapped onto a
/// tilted plane, so no facet edge is aligned with a global axis.
fn distorted_tilted_patch() -> (Model, Vec<bool>, [[f64; 3]; 3]) {
    let cells = 4;
    let mut model = Model::grid([2.0, 1.5], [cells, cells], 0.05, material(70_000.0, 0.33));
    let mut boundary = Vec::new();
    for i in 0..=cells {
        for j in 0..=cells {
            let on_edge = i == 0 || i == cells || j == 0 || j == cells;
            boundary.push(on_edge);
            if !on_edge {
                // Deterministic, irregular offsets.
                let node = i * (cells + 1) + j;
                let phase = (i * 7 + j * 3) as f64;
                model.vertices[node][0] += 0.12 * phase.sin();
                model.vertices[node][1] += 0.09 * (1.7 * phase).cos();
            }
        }
    }
    // An orthonormal frame (rows): local x, local y, normal.
    let tilt = 0.6_f64;
    let turn = 0.4_f64;
    let axes = [
        [turn.cos(), turn.sin(), 0.0],
        [
            -turn.sin() * tilt.cos(),
            turn.cos() * tilt.cos(),
            tilt.sin(),
        ],
        [
            turn.sin() * tilt.sin(),
            -turn.cos() * tilt.sin(),
            tilt.cos(),
        ],
    ];
    for vertex in &mut model.vertices {
        let [along_x, along_y, _] = *vertex;
        *vertex =
            std::array::from_fn(|k| along_x * axes[0][k] + along_y * axes[1][k] + 0.3 * axes[2][k]);
    }
    (model, boundary, axes)
}

/// Prescribe `field` (six DOFs from a global position) on the boundary nodes,
/// solve, and return the largest interior deviation relative to the field's
/// largest value.
fn interior_error(
    model: &mut Model,
    boundary: &[bool],
    field: &dyn Fn([f64; 3]) -> [f64; 6],
) -> f64 {
    for (node, &on_edge) in boundary.iter().enumerate() {
        if on_edge {
            let values = field(model.vertices[node]);
            for (component, value) in values.into_iter().enumerate() {
                model.prescribe(node, component, value);
            }
        }
    }
    let (_, solution) = model.solve().expect("patch solves");
    let mut scale: f64 = 0.0;
    let mut worst: f64 = 0.0;
    for (node, &on_edge) in boundary.iter().enumerate() {
        let expected = field(model.vertices[node]);
        for (component, value) in expected.into_iter().enumerate() {
            scale = scale.max(value.abs());
            if !on_edge {
                worst = worst.max((solution.dofs[6 * node + component] - value).abs());
            }
        }
    }
    worst / scale
}

/// The rotation DOFs of a rigid motion with spin `spin` on a facet with unit
/// normal `normal`: the spin without its normal part. The drilling (θz)
/// stiffness is a small spring on the absolute normal rotation, decoupled from
/// the in-plane translations (as in the C++ element), so a rigid turn about
/// the normal leaves θz at rest rather than at the spin.
fn rotation_dofs(spin: [f64; 3], normal: [f64; 3]) -> [f64; 3] {
    let along = dot(spin, normal);
    std::array::from_fn(|k| spin[k] - along * normal[k])
}

#[test]
fn rigid_body_motion_strains_nothing() {
    let (mut model, boundary, axes) = distorted_tilted_patch();
    // u = c + ω × x, θ = ω less its normal part.
    let offset = [1e-3, -2e-3, 5e-4];
    let spin = [3e-4, -1e-4, 2e-4];
    let rotation = rotation_dofs(spin, axes[2]);
    let field = |point: [f64; 3]| -> [f64; 6] {
        let turn = cross(spin, point);
        [
            offset[0] + turn[0],
            offset[1] + turn[1],
            offset[2] + turn[2],
            rotation[0],
            rotation[1],
            rotation[2],
        ]
    };
    let error = interior_error(&mut model, &boundary, &field);
    assert!(error < 1e-8, "rigid-body motion: interior error {error:e}");
}

#[test]
fn membrane_patch_test_reproduces_a_linear_field() {
    let (mut model, boundary, axes) = distorted_tilted_patch();
    let [ex, ey, _] = axes;
    // In-plane displacement linear in the in-plane coordinates; no bending and
    // no drilling rotation (the drilling DOF is independent of the membrane).
    let field = |point: [f64; 3]| -> [f64; 6] {
        let (px, py) = (dot(point, ex), dot(point, ey));
        let along_x = 1e-3 + 2e-4 * px - 5e-4 * py;
        let along_y = -2e-3 + 3e-4 * px + 1e-4 * py;
        let global: [f64; 3] = std::array::from_fn(|k| along_x * ex[k] + along_y * ey[k]);
        [global[0], global[1], global[2], 0.0, 0.0, 0.0]
    };
    let error = interior_error(&mut model, &boundary, &field);
    assert!(
        error < 1e-8,
        "membrane patch test: interior error {error:e}"
    );
}

#[test]
fn bending_patch_test_reproduces_constant_curvature() {
    let (mut model, boundary, axes) = distorted_tilted_patch();
    let [ex, ey, normal] = axes;
    let (kx, ky, kxy) = (2e-3, -1e-3, 1.5e-3);
    // w = ½(kx·x² + ky·y²) + kxy·x·y along the normal; the rotation vector is
    // θ = (∂w/∂y)·ex − (∂w/∂x)·ey (right-hand rule about the local axes).
    let local = |point: [f64; 3]| -> (f64, f64) { (dot(point, ex), dot(point, ey)) };
    let field = |point: [f64; 3]| -> [f64; 6] {
        let (px, py) = local(point);
        let deflection = f64::midpoint(kx * px * px, ky * py * py) + kxy * px * py;
        let slope_x = kx * px + kxy * py;
        let slope_y = ky * py + kxy * px;
        let translation: [f64; 3] = std::array::from_fn(|k| deflection * normal[k]);
        let rotation: [f64; 3] = std::array::from_fn(|k| slope_y * ex[k] - slope_x * ey[k]);
        [
            translation[0],
            translation[1],
            translation[2],
            rotation[0],
            rotation[1],
            rotation[2],
        ]
    };
    let error = interior_error(&mut model, &boundary, &field);
    assert!(error < 1e-8, "bending patch test: interior error {error:e}");

    // Constant curvature ⇒ every facet carries the same surface stress,
    // σ = D·(t/2)·(kx, ky, 2kxy).
    let (mesh, solution) = model.solve().expect("patch solves");
    let stresses = shell_von_mises(&mesh, &solution.dofs).expect("stress recovery");
    let (young, poisson, half) = (70_000.0, 0.33, 0.025);
    let factor = young / (1.0 - poisson * poisson) * half;
    let sx = factor * (kx + poisson * ky);
    let sy = factor * (poisson * kx + ky);
    let txy = factor * (1.0 - poisson) / 2.0 * 2.0 * kxy;
    let reference = (sx * sx - sx * sy + sy * sy + 3.0 * txy * txy).sqrt();
    for (triangle, &stress) in stresses.iter().enumerate() {
        assert!(
            relative_error(stress, reference) < 1e-7,
            "facet {triangle}: von Mises {stress:e}, reference {reference:e}"
        );
    }
}

#[test]
fn facet_stiffness_is_symmetric_with_six_rigid_modes() {
    let corners = [[0.1, 0.2, 0.3], [1.3, 0.1, 0.5], [0.4, 1.1, 0.9]];
    let stiffness = facet_stiffness(&corners, 0.02, &material(200_000.0, 0.3));
    let largest = stiffness
        .iter()
        .flatten()
        .fold(0.0_f64, |acc, value| acc.max(value.abs()));
    for (i, row) in stiffness.iter().enumerate() {
        for (j, &entry) in row.iter().enumerate() {
            assert!(
                (entry - stiffness[j][i]).abs() <= 1e-12 * largest,
                "K[{i}][{j}] ≠ K[{j}][{i}]"
            );
        }
    }
    let normal = {
        let raw = cross(sub(corners[1], corners[0]), sub(corners[2], corners[0]));
        let length = norm(raw);
        raw.map(|value| value / length)
    };
    // Three translations and three rotations about the global axes.
    for mode in 0..6 {
        let mut motion = [0.0; 18];
        for (node, corner) in corners.iter().enumerate() {
            let mut spin = [0.0; 3];
            if mode < 3 {
                motion[6 * node + mode] = 1.0;
            } else {
                spin[mode - 3] = 1.0;
                let turn = cross(spin, *corner);
                motion[6 * node..6 * node + 3].copy_from_slice(&turn);
                motion[6 * node + 3..6 * node + 6].copy_from_slice(&rotation_dofs(spin, normal));
            }
        }
        for (i, row) in stiffness.iter().enumerate() {
            let force: f64 = row
                .iter()
                .zip(&motion)
                .map(|(entry, value)| entry * value)
                .sum();
            assert!(
                force.abs() <= 1e-10 * largest,
                "rigid mode {mode} loads DOF {i} with {force:e}"
            );
        }
    }
}

// ── Prescribed displacements (KOF-210, KOF-218) ──────────────────────────────

const STRIP: (f64, f64, f64, f64, f64) = (1.0, 0.25, 0.01, 210e9, 0.3); // L, b, t, E, ν
const STRIP_CELLS: [usize; 2] = [8, 2];

fn strip_id(i: usize, j: usize) -> usize {
    i * (STRIP_CELLS[1] + 1) + j
}

/// Uniaxial membrane strip pulled to `delta` at x = L, by displacement or by
/// the equivalent force. Returns (mean ux at x = L, uy at the far corner).
fn strip_uniaxial(by_displacement: bool, delta: f64) -> (f64, f64) {
    let (length, width, thickness, young, poisson) = STRIP;
    let [nx, ny] = STRIP_CELLS;
    let mut model = Model::grid(
        [length, width],
        STRIP_CELLS,
        thickness,
        material(young, poisson),
    );
    for node in 0..model.vertices.len() {
        model.fix(node, &[2, 3, 4, 5]);
    }
    for j in 0..=ny {
        model.fix(strip_id(0, j), &[0]);
    }
    for i in 0..=nx {
        model.fix(strip_id(i, 0), &[1]);
    }
    let total = young * (delta / length) * width * thickness;
    for j in 0..=ny {
        if by_displacement {
            model.prescribe(strip_id(nx, j), 0, delta);
        } else {
            let weight = if j == 0 || j == ny { 0.5 } else { 1.0 };
            model.load(strip_id(nx, j), 0, total * weight / ny as f64);
        }
    }
    let (_, solution) = model.solve().expect("strip solves");
    let mean = (0..=ny)
        .map(|j| solution.dofs[6 * strip_id(nx, j)])
        .sum::<f64>()
        / (ny + 1) as f64;
    (mean, solution.dofs[6 * strip_id(nx, ny) + 1])
}

#[test]
fn prescribed_extension_is_honoured_and_matches_the_force_drive() {
    let (length, width, .., poisson) = STRIP;
    let delta = 1e-4;
    let (extension, contraction) = strip_uniaxial(true, delta);
    assert_within("prescribed extension", extension, delta, 0.01);
    assert_within(
        "prescribed Poisson contraction",
        contraction,
        -poisson * (delta / length) * width,
        0.1,
    );
    let (forced, _) = strip_uniaxial(false, delta);
    assert_within("prescribed vs force drive", extension, forced, 0.01);
}

fn small_plate() -> Model {
    let mut model = Model::grid([1.0, 1.0], [2, 2], 0.01, material(1e7, 0.3));
    for node in 0..9 {
        let components: Vec<usize> = (0..6)
            .filter(|&component| 6 * node + component != 6 * 4 + 2)
            .collect();
        model.fix(node, &components);
    }
    model
}

#[test]
fn conflicting_prescribed_values_are_refused() {
    let mut model = small_plate();
    model.prescribe(4, 2, 1e-3);
    model.prescribe(4, 2, 2e-3);
    let error = model.solve().expect_err("a conflict is refused");
    assert_eq!(
        error,
        FemError::ConflictingConstraint {
            dof: 26,
            first: 1e-3,
            second: 2e-3
        }
    );
}

#[test]
fn fixed_and_prescribed_to_different_values_is_refused() {
    let mut model = small_plate();
    model.fix(4, &[2]);
    model.prescribe(4, 2, 1e-3);
    let error = model.solve().expect_err("a conflict is refused");
    assert_eq!(
        error,
        FemError::ConflictingConstraint {
            dof: 26,
            first: 0.0,
            second: 1e-3
        }
    );
}

#[test]
fn identical_duplicate_constraints_solve() {
    let mut model = small_plate();
    model.prescribe(0, 2, 0.0); // fixed and prescribed to 0
    model.prescribe(4, 2, 1e-3);
    model.prescribe(4, 2, 1e-3);
    let (_, solution) = model.solve().expect("identical duplicates solve");
    assert!((solution.dofs[6 * 4 + 2] - 1e-3).abs() < 1e-12);
}

// ── Malformed input ──────────────────────────────────────────────────────────

#[test]
fn a_thickness_field_of_the_wrong_length_is_refused() {
    let mut model = small_plate();
    model.thickness.pop();
    let error = model.mesh().expect_err("refused");
    assert_eq!(
        error,
        FemError::ThicknessCount {
            count: 7,
            triangles: 8
        }
    );
}

#[test]
fn a_non_positive_thickness_is_refused() {
    let mut model = small_plate();
    model.thickness[3] = 0.0;
    let error = model.mesh().expect_err("refused");
    assert_eq!(
        error,
        FemError::Thickness {
            triangle: 3,
            value: 0.0
        }
    );
}

#[test]
fn a_material_field_of_the_wrong_length_or_range_is_refused() {
    let mut model = small_plate();
    model.material_of_triangle.pop();
    assert_eq!(
        model.mesh().err(),
        Some(FemError::ShellMaterialIdCount {
            count: 7,
            triangles: 8
        })
    );
    let mut model = small_plate();
    model.material_of_triangle[5] = 1;
    assert_eq!(
        model.mesh().err(),
        Some(FemError::ShellMaterialOutOfRange {
            triangle: 5,
            material: 1,
            count: 1
        })
    );
}

#[test]
fn a_degenerate_triangle_is_refused() {
    let mut model = small_plate();
    // Move node 4 onto the edge from node 0 to node 3: facet 0 is (0, 3, 4).
    model.vertices[4] = [0.25, 0.0, 0.0];
    assert_eq!(
        model.mesh().err(),
        Some(FemError::DegenerateTriangle { triangle: 0 })
    );
}

#[test]
fn an_unused_vertex_is_held_and_must_not_be_loaded() {
    let mut model = small_plate();
    model.prescribe(4, 2, 1e-3);
    model.vertices.push([5.0, 5.0, 5.0]);
    model.forces.extend([0.0; 6]);
    let (mesh, solution) = model.solve().expect("an unused vertex is held");
    assert_eq!(solution.unused_vertices, 1);
    assert!(solution.dofs[54..60].iter().all(|&value| value == 0.0));
    let translations = shell_translations(&mesh, &solution.dofs).expect("6 per vertex");
    assert_eq!(translations.len(), 30);
    assert!((translations[3 * 4 + 2] - 1e-3).abs() < 1e-12);

    model.load(9, 2, 1.0);
    assert_eq!(
        model.solve().err(),
        Some(FemError::LoadOnUnusedVertex { vertex: 9 })
    );
}

#[test]
fn the_shell_solve_preconditions_with_incomplete_cholesky() {
    let (_, solution) = {
        let mut model = small_plate();
        model.prescribe(4, 2, 1e-3);
        model.solve().expect("solves")
    };
    assert!(
        matches!(
            solution.preconditioner,
            ShellPreconditioner::IncompleteCholesky { .. }
        ),
        "{:?}",
        solution.preconditioner
    );
}

// ── Per-facet materials (issue #389) ─────────────────────────────────────────

const BIMATERIAL: (f64, f64) = (210e9, 70e9);

/// The C++ `BimaterialStrip`: ν = 0, split across the length (`series`) or
/// along it.
fn bimaterial_strip(series: bool) -> Model {
    let (length, width, thickness, ..) = STRIP;
    let (steel, aluminium) = BIMATERIAL;
    let [nx, ny] = STRIP_CELLS;
    let mut model = Model::grid(
        [length, width],
        STRIP_CELLS,
        thickness,
        material(steel, 0.0),
    );
    model.materials = vec![material(steel, 0.0), material(aluminium, 0.0)];
    let mut ids = Vec::new();
    for i in 0..nx {
        for j in 0..ny {
            let first = if series { i < nx / 2 } else { j < ny / 2 };
            ids.extend([u32::from(!first); 2]);
        }
    }
    model.material_of_triangle = ids;
    model
}

fn membrane_supports(model: &mut Model) {
    let [nx, ny] = STRIP_CELLS;
    for node in 0..model.vertices.len() {
        model.fix(node, &[2, 3, 4, 5]);
    }
    for j in 0..=ny {
        model.fix(strip_id(0, j), &[0]);
    }
    for i in 0..=nx {
        model.fix(strip_id(i, 0), &[1]);
    }
}

fn extremes(values: &[f64]) -> (f64, f64) {
    values
        .iter()
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(low, high), &value| {
            (low.min(value), high.max(value))
        })
}

#[test]
fn bimaterial_strip_in_series_adds_compliances() {
    let (length, width, thickness, ..) = STRIP;
    let (steel, aluminium) = BIMATERIAL;
    let [nx, ny] = STRIP_CELLS;
    let stress = 1.0e6;
    let mut model = bimaterial_strip(true);
    membrane_supports(&mut model);
    for j in 0..=ny {
        let weight = if j == 0 || j == ny { 0.5 } else { 1.0 };
        model.load(
            strip_id(nx, j),
            0,
            stress * width * thickness * weight / ny as f64,
        );
    }
    let (mesh, solution) = model.solve().expect("series strip solves");
    let mean = (0..=ny)
        .map(|j| solution.dofs[6 * strip_id(nx, j)])
        .sum::<f64>()
        / (ny + 1) as f64;
    let reference = stress * 0.5 * length * (1.0 / steel + 1.0 / aluminium);
    assert_within("series extension", mean, reference, 0.01);
    let (low, high) = extremes(&shell_von_mises(&mesh, &solution.dofs).expect("stress"));
    assert_within("series von Mises min", low, stress, 0.01);
    assert_within("series von Mises max", high, stress, 0.01);
}

#[test]
fn bimaterial_strip_in_parallel_adds_stiffnesses() {
    let (length, width, thickness, ..) = STRIP;
    let (steel, aluminium) = BIMATERIAL;
    let [nx, ny] = STRIP_CELLS;
    let strain = 1.0e-4;
    let mut model = bimaterial_strip(false);
    membrane_supports(&mut model);
    let height = width / ny as f64;
    for j in 0..ny {
        let modulus = if j < ny / 2 { steel } else { aluminium };
        let segment = modulus * strain * height * thickness;
        model.load(strip_id(nx, j), 0, 0.5 * segment);
        model.load(strip_id(nx, j + 1), 0, 0.5 * segment);
    }
    let (mesh, solution) = model.solve().expect("parallel strip solves");
    let ends: Vec<f64> = (0..=ny)
        .map(|j| solution.dofs[6 * strip_id(nx, j)])
        .collect();
    let (low, high) = extremes(&ends);
    assert_within("parallel end min", low, strain * length, 0.01);
    assert_within("parallel end max", high, strain * length, 0.01);
    let (low, high) = extremes(&shell_von_mises(&mesh, &solution.dofs).expect("stress"));
    assert_within(
        "parallel von Mises aluminium",
        low,
        aluminium * strain,
        0.01,
    );
    assert_within("parallel von Mises steel", high, steel * strain, 0.01);
}

#[test]
fn bimaterial_strip_in_series_bends_by_both_halves() {
    let (length, width, thickness, ..) = STRIP;
    let (steel, aluminium) = BIMATERIAL;
    let [nx, ny] = STRIP_CELLS;
    let moment = 1.0;
    let mut model = bimaterial_strip(true);
    for j in 0..=ny {
        model.fix(strip_id(0, j), &[0, 1, 2, 3, 4, 5]);
        let weight = if j == 0 || j == ny { 0.5 } else { 1.0 };
        model.load(strip_id(nx, j), 4, moment * weight / ny as f64);
    }
    let (_, solution) = model.solve().expect("bending strip solves");
    let rotation = (0..=ny)
        .map(|j| solution.dofs[6 * strip_id(nx, j) + 4])
        .sum::<f64>()
        / (ny + 1) as f64;
    let inertia = width * thickness.powi(3) / 12.0;
    let reference = moment * 0.5 * length * (1.0 / (steel * inertia) + 1.0 / (aluminium * inertia));
    assert_within("series bending rotation", rotation.abs(), reference, 0.5);
    assert_eq!(model.triangle_count(), 32);
}

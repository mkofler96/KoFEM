// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! A hex face that meets two tet triangles, the two sharing the four corners
//! but not the face (KOF-433). The hex's field on that face is bilinear and
//! the tets' is linear on each triangle, so the two disagree inside the face.
//! The hex is solved as a transition element instead: pyramids on its other
//! faces and two tets on the interface face, split as the tet side is, all
//! meeting at the hex centre. Then
//!
//! * the displacement is continuous across the interface, at either order;
//! * a linear field is reproduced exactly (the patch test), which the
//!   mismatched interface does not pass;
//! * the interface faces are inside the body: no load, tie or contact can
//!   land on them.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

#[allow(
    dead_code,
    reason = "this suite takes only the Kuhn split from the shared fixtures"
)]
mod support;

use kofem_fem::hyperelastic::NeoHookean;
use kofem_fem::nonlinear::{solve_newton, DirichletCg, NewtonSettings};
use kofem_fem::topology::{SimpModel, SimpPreconditioner, SimpSolver};
use kofem_fem::{
    assemble_stiffness, corner_stress_tensors_thermal, displacement_at, outer_faces, solve_static,
    stress_tensors, thermal_load, AmgSettings, BoundaryFaces, CgSettings, ElementOrder, FemError,
    Isotropic, PreconditionerChoice, StoppingRule, SurfaceLoadKind, TetMesh,
};
use support::KUHN;

const CG: CgSettings = CgSettings {
    relative_tolerance: 1e-12,
    max_iterations: 100_000,
    stopping: StoppingRule::ResidualNorm,
};

/// The Solve panel's two preconditioners.
fn preconditioners() -> [PreconditionerChoice; 2] {
    [
        PreconditionerChoice::SmoothedAggregation(AmgSettings::default()),
        PreconditionerChoice::SymmetricGaussSeidel,
    ]
}

/// The hex corner (CHEXA order) of each unit-cube corner bit pattern
/// x + 2y + 4z.
const HEX_OF_BITS: [usize; 8] = [0, 1, 3, 2, 4, 5, 7, 6];

/// A box of `cells` along x, y and z: the cells with x below the middle are
/// hexahedra, the rest Kuhn tetrahedra, so the plane x = middle is a hex/tet
/// interface whose quads the tets split along a diagonal. With `distort`,
/// every vertex off the outer surface moves, so no element is a box and the
/// interface quads are neither parallelograms nor flat.
struct Bar {
    mesh: TetMesh,
    points: Vec<[f64; 3]>,
    cells: [usize; 3],
    tets: Vec<[u32; 4]>,
    hexes: Vec<[u32; 8]>,
}

fn bar(cells: [usize; 3], distort: bool, order: ElementOrder) -> Bar {
    let [nx, ny, nz] = cells;
    let size = [2.0, 1.0, 1.0];
    let index = |ix: usize, iy: usize, iz: usize| (ix + (nx + 1) * (iy + (ny + 1) * iz)) as u32;
    let mut points = Vec::new();
    for iz in 0..=nz {
        for iy in 0..=ny {
            for ix in 0..=nx {
                let mut point = [
                    size[0] * ix as f64 / nx as f64,
                    size[1] * iy as f64 / ny as f64,
                    size[2] * iz as f64 / nz as f64,
                ];
                let inside = ix > 0 && ix < nx && iy > 0 && iy < ny && iz > 0 && iz < nz;
                if distort && inside {
                    let phase = (3 * ix + 5 * iy + 7 * iz) as f64;
                    point[0] += 0.12 * size[0] / nx as f64 * phase.sin();
                    point[1] += 0.12 * size[1] / ny as f64 * (1.3 * phase).cos();
                    point[2] += 0.12 * size[2] / nz as f64 * (0.7 * phase).sin();
                }
                points.push(point);
            }
        }
    }
    let mut tets = Vec::new();
    let mut hexes = Vec::new();
    for iz in 0..nz {
        for iy in 0..ny {
            for ix in 0..nx {
                let corner = |bits: usize| {
                    index(
                        ix + (bits & 1),
                        iy + ((bits >> 1) & 1),
                        iz + ((bits >> 2) & 1),
                    )
                };
                if ix < nx / 2 {
                    let mut hex = [0; 8];
                    for (bits, &slot) in HEX_OF_BITS.iter().enumerate() {
                        hex[slot] = corner(bits);
                    }
                    hexes.push(hex);
                } else {
                    tets.extend(KUHN.map(|tet| tet.map(corner)));
                }
            }
        }
    }
    let flat: Vec<f64> = points.iter().flatten().copied().collect();
    let materials = vec![0; tets.len() + hexes.len()];
    let mesh = TetMesh::with_hexahedra(
        &flat,
        tets.as_flattened(),
        hexes.as_flattened(),
        &materials,
        vec![Isotropic::new(0, 200_000.0, 0.3).expect("valid material")],
    )
    .and_then(|mesh| mesh.with_order(order))
    .expect("valid bar");
    Bar {
        mesh,
        points,
        cells,
        tets,
        hexes,
    }
}

const ORDERS: [ElementOrder; 2] = [ElementOrder::Linear, ElementOrder::Quadratic];

/// The interface quads: the face x = middle of each hex in the last hex
/// column, as (hex element, corners).
fn interface_quads(bar: &Bar) -> Vec<(usize, [u32; 4])> {
    let [nx, ny, nz] = bar.cells;
    let column = nx / 2 - 1;
    let mut quads = Vec::new();
    for iz in 0..nz {
        for iy in 0..ny {
            let hex = column + (nx / 2) * (iy + ny * iz);
            // Face 3 of FACES_OF_HEX, [1, 2, 6, 5]: the +x side.
            let corners = [1, 2, 6, 5].map(|corner| bar.hexes[hex][corner]);
            quads.push((bar.tets.len() + hex, corners));
        }
    }
    quads
}

/// The tet triangles that lie on the interface: tet faces whose three corners
/// all sit on the plane x = middle.
fn interface_triangles(bar: &Bar) -> Vec<[u32; 3]> {
    let middle = bar.points[interface_quads(bar)[0].1[0] as usize][0];
    let on = |vertex: u32| (bar.points[vertex as usize][0] - middle).abs() < 1e-12;
    let mut triangles = Vec::new();
    for tet in &bar.tets {
        for skip in 0..4 {
            let face: Vec<u32> = (0..4)
                .filter(|&corner| corner != skip)
                .map(|corner| tet[corner])
                .collect();
            if face.iter().all(|&vertex| on(vertex)) {
                triangles.push([face[0], face[1], face[2]]);
            }
        }
    }
    triangles
}

/// Clamp x = 0 and pull the tet end x = 2 sideways and along: a load whose
/// field across the interface is not linear.
fn cantilever(bar: &Bar, preconditioner: PreconditionerChoice) -> Vec<f64> {
    let mesh = &bar.mesh;
    let mut fixed = Vec::new();
    for (vertex, point) in bar.points.iter().enumerate() {
        if point[0].abs() < 1e-12 {
            fixed.extend((0..3).map(|component| (3 * vertex + component) as u32));
        }
    }
    let boundary = BoundaryFaces::new(mesh);
    let tip: Vec<[u32; 3]> = bar
        .tets
        .iter()
        .flat_map(|tet| {
            (0..4).map(move |skip| {
                let face: Vec<u32> = (0..4)
                    .filter(|&corner| corner != skip)
                    .map(|corner| tet[corner])
                    .collect();
                [face[0], face[1], face[2]]
            })
        })
        .filter(|face| {
            face.iter()
                .all(|&vertex| (bar.points[vertex as usize][0] - 2.0).abs() < 1e-12)
        })
        .collect();
    let mut forces = vec![0.0; mesh.dof_count()];
    boundary
        .apply(
            mesh,
            0,
            &tip,
            &[],
            SurfaceLoadKind::Force([300.0, 1000.0, -700.0]),
            &mut forces,
        )
        .expect("the tip is on the boundary");
    let stiffness = assemble_stiffness(mesh);
    solve_static(
        mesh,
        &stiffness,
        &fixed,
        &vec![0.0; fixed.len()],
        &forces,
        CG,
        preconditioner,
    )
    .expect("the cantilever solves")
    .displacements
}

/// Points spread over the inside and the edges of an interface quad: bilinear
/// combinations of its corners, which lie on both the hex face and (for a
/// flat quad) the tets' triangles.
fn points_on(bar: &Bar, quad: [u32; 4]) -> Vec<[f64; 3]> {
    let corners = quad.map(|vertex| bar.points[vertex as usize]);
    let mut points = Vec::new();
    for (along_s, along_t) in [(0.5, 0.5), (0.25, 0.25), (0.8, 0.3), (0.2, 0.7), (0.5, 0.0)] {
        let weights = [
            (1.0 - along_s) * (1.0 - along_t),
            along_s * (1.0 - along_t),
            along_s * along_t,
            (1.0 - along_s) * along_t,
        ];
        points.push(std::array::from_fn(|axis| {
            corners
                .iter()
                .zip(weights)
                .map(|(corner, weight)| weight * corner[axis])
                .sum()
        }));
    }
    points
}

/// The largest jump of the displacement across the interface, from the hex's
/// field to the field of the tet on the other side, relative to the largest
/// displacement.
fn largest_jump(bar: &Bar, displacements: &[f64]) -> f64 {
    let peak = displacements
        .iter()
        .fold(0.0_f64, |max, value| max.max(value.abs()));
    let mut jump = 0.0_f64;
    for (hex, quad) in interface_quads(bar) {
        for point in points_on(bar, quad) {
            let from_hex = displacement_at(&bar.mesh, hex, point, displacements)
                .expect("the point is on the hex's face");
            let from_tet = (0..bar.tets.len())
                .find_map(|tet| displacement_at(&bar.mesh, tet, point, displacements).ok())
                .expect("a tet holds the point");
            for axis in 0..3 {
                jump = jump.max((from_hex[axis] - from_tet[axis]).abs());
            }
        }
    }
    jump / peak
}

#[test]
fn the_displacement_is_continuous_across_a_hex_tet_interface() {
    for order in ORDERS {
        let bar = bar([4, 2, 2], false, order);
        for preconditioner in preconditioners() {
            let displacements = cantilever(&bar, preconditioner);
            let jump = largest_jump(&bar, &displacements);
            assert!(
                jump < 1e-9,
                "{order:?}, {preconditioner:?}: the displacement jumps by {jump:e} of the \
                 largest across the interface"
            );
        }
    }
}

/// u = A·x + b, a field every element reproduces.
fn linear_field(point: [f64; 3]) -> [f64; 3] {
    const GRADIENT: [[f64; 3]; 3] = [
        [2e-3, -1e-3, 0.5e-3],
        [0.7e-3, 1.5e-3, -0.4e-3],
        [-0.3e-3, 0.9e-3, 1.1e-3],
    ];
    const OFFSET: [f64; 3] = [1e-3, -2e-3, 0.5e-3];
    std::array::from_fn(|row| {
        OFFSET[row]
            + (0..3)
                .map(|col| GRADIENT[row][col] * point[col])
                .sum::<f64>()
    })
}

/// The DOFs of the vertices on the bar's outer surface, held at `field`.
fn held_surface(bar: &Bar, field: impl Fn([f64; 3]) -> [f64; 3]) -> (Vec<u32>, Vec<f64>) {
    let mut fixed = Vec::new();
    let mut values = Vec::new();
    for (vertex, point) in bar.points.iter().enumerate() {
        let on_surface = [point[0] / 2.0, point[1], point[2]]
            .iter()
            .any(|&coordinate| coordinate.abs() < 1e-12 || (coordinate - 1.0).abs() < 1e-12);
        if on_surface {
            for (component, value) in field(*point).into_iter().enumerate() {
                fixed.push((3 * vertex + component) as u32);
                values.push(value);
            }
        }
    }
    (fixed, values)
}

/// The largest difference between `displacements` and `field` at any node.
fn largest_error(
    mesh: &TetMesh,
    displacements: &[f64],
    field: impl Fn([f64; 3]) -> [f64; 3],
) -> f64 {
    let mut error = 0.0_f64;
    for (node, point) in mesh.node_coordinates().iter().enumerate() {
        let value = field(*point);
        for component in 0..3 {
            error = error.max((displacements[3 * node + component] - value[component]).abs());
        }
    }
    error
}

#[test]
fn a_hex_tet_interface_passes_the_patch_test() {
    for order in ORDERS {
        let bar = bar([4, 3, 3], true, order);
        let mesh = &bar.mesh;
        let (fixed, values) = held_surface(&bar, linear_field);
        let stiffness = assemble_stiffness(mesh);
        for preconditioner in preconditioners() {
            let solution = solve_static(
                mesh,
                &stiffness,
                &fixed,
                &values,
                &vec![0.0; mesh.dof_count()],
                CG,
                preconditioner,
            )
            .expect("the patch solves");
            let mut error = 0.0_f64;
            for (node, point) in mesh.node_coordinates().iter().enumerate() {
                let field = linear_field(*point);
                for component in 0..3 {
                    error = error.max(
                        (solution.displacements[3 * node + component] - field[component]).abs(),
                    );
                }
            }
            assert!(
                error < 1e-12,
                "{order:?}, {preconditioner:?}: a linear field is off by {error:e} at a node"
            );
            let tensors = stress_tensors(mesh, &solution.displacements).expect("stresses");
            let spread = tensors
                .iter()
                .flat_map(|tensor| {
                    tensor
                        .iter()
                        .zip(&tensors[0])
                        .map(|(entry, first)| (entry - first).abs())
                })
                .fold(0.0_f64, f64::max);
            assert!(
                spread < 1e-6,
                "{order:?}, {preconditioner:?}: the stress of a linear field varies by {spread:e}"
            );
        }
    }
}

#[test]
fn hex_tet_interface_faces_are_not_on_the_boundary() {
    for order in ORDERS {
        let bar = bar([4, 2, 2], false, order);
        let mesh = &bar.mesh;
        let [nx, ny, nz] = bar.cells;
        let hex_columns = nx / 2;
        // The outer surface: on the hex half one quad per cell face, on the
        // tet half two triangles.
        let quads = ny * nz + 2 * hex_columns * (ny + nz);
        let triangles = 2 * (ny * nz + 2 * (nx - hex_columns) * (ny + nz));
        let boundary = BoundaryFaces::new(mesh);
        assert_eq!(
            boundary.len(),
            quads + triangles,
            "{order:?}: only the outer surface is boundary"
        );

        let quad = interface_quads(&bar)[0].1;
        let mut forces = vec![0.0; mesh.dof_count()];
        let on_quad = boundary.apply(
            mesh,
            0,
            &[],
            &[quad],
            SurfaceLoadKind::Pressure(1.0),
            &mut forces,
        );
        assert!(
            matches!(
                on_quad,
                Err(FemError::SurfaceLoadUnmatched { unmatched: 1, .. })
            ),
            "{order:?}: a load on an interface quad is refused, got {on_quad:?}"
        );
        let triangle = interface_triangles(&bar)[0];
        let on_triangle = boundary.apply(
            mesh,
            0,
            &[triangle],
            &[],
            SurfaceLoadKind::Pressure(1.0),
            &mut forces,
        );
        assert!(
            matches!(
                on_triangle,
                Err(FemError::SurfaceLoadUnmatched { unmatched: 1, .. })
            ),
            "{order:?}: a load on an interface triangle is refused, got {on_triangle:?}"
        );

        // Ties and contact take their faces from the same boundary.
        let middle = bar.points[quad[0] as usize][0];
        let tied = boundary.mortar_faces(mesh, |vertex| {
            (bar.points[vertex as usize][0] - middle).abs() < 1e-12
        });
        assert!(
            tied.is_empty(),
            "{order:?}: no tie or contact face on the interface, got {}",
            tied.len()
        );
    }
}

#[test]
fn the_mesh_outline_leaves_out_hex_tet_interface_faces() {
    let bar = bar([4, 2, 2], false, ElementOrder::Linear);
    let outline =
        outer_faces(bar.tets.as_flattened(), bar.hexes.as_flattened()).expect("valid elements");
    let [nx, ny, nz] = bar.cells;
    let hex_columns = nx / 2;
    assert_eq!(
        outline.quadrilaterals.len() / 4,
        ny * nz + 2 * hex_columns * (ny + nz),
        "only outer quads"
    );
    assert_eq!(
        outline.triangles.len() / 3,
        2 * (ny * nz + 2 * (nx - hex_columns) * (ny + nz)),
        "only outer triangles"
    );
}

#[test]
fn free_thermal_expansion_stays_stress_free_across_a_hex_tet_interface() {
    let (alpha, delta_t) = (1.2e-5, 80.0);
    let expansion = |point: [f64; 3]| point.map(|coordinate| alpha * delta_t * coordinate);
    for order in ORDERS {
        let bar = bar([4, 3, 3], true, order);
        let mesh = &bar.mesh;
        let alphas = vec![alpha; mesh.element_count()];
        let temperatures = vec![delta_t; mesh.node_count()];
        let forces = thermal_load(mesh, &alphas, &temperatures).expect("thermal load");
        let (fixed, values) = held_surface(&bar, expansion);
        let stiffness = assemble_stiffness(mesh);
        let solution = solve_static(
            mesh,
            &stiffness,
            &fixed,
            &values,
            &forces,
            CG,
            PreconditionerChoice::SymmetricGaussSeidel,
        )
        .expect("the expansion solves");
        let error = largest_error(mesh, &solution.displacements, expansion);
        assert!(
            error < 1e-12,
            "{order:?}: the free expansion is off by {error:e}"
        );
        let largest =
            corner_stress_tensors_thermal(mesh, &solution.displacements, &alphas, &temperatures)
                .expect("thermal stresses")
                .iter()
                .flatten()
                .fold(0.0_f64, |max, value| max.max(value.abs()));
        assert!(
            largest < 1e-6,
            "{order:?}: a free expansion leaves a stress of {largest:e}"
        );
    }
}

#[test]
fn a_large_homogeneous_stretch_crosses_a_hex_tet_interface_exactly() {
    // u = (F − I)·x with F a finite stretch and shear.
    let stretch = |point: [f64; 3]| {
        [
            0.15 * point[0] + 0.05 * point[1],
            -0.04 * point[1] + 0.03 * point[2],
            0.02 * point[0] - 0.06 * point[2],
        ]
    };
    for order in ORDERS {
        let bar = bar([4, 2, 2], true, order);
        let mesh = &bar.mesh;
        let (fixed, values) = held_surface(&bar, stretch);
        let solution = solve_newton(
            NeoHookean::new(mesh),
            DirichletCg::new(mesh, CG, PreconditionerChoice::SymmetricGaussSeidel),
            mesh,
            &fixed,
            &values,
            &vec![0.0; mesh.dof_count()],
            NewtonSettings {
                increments: 2,
                max_iterations: 30,
                tolerance: 1e-11,
            },
        )
        .expect("the stretch solves");
        let error = largest_error(mesh, &solution.displacements, stretch);
        assert!(
            error < 1e-10,
            "{order:?}: the homogeneous stretch is off by {error:e}"
        );
    }
}

#[test]
fn simp_solves_the_transition_elements() {
    let bar = bar([4, 2, 2], true, ElementOrder::Linear);
    let mesh = &bar.mesh;
    let mut fixed = Vec::new();
    let mut forces = vec![0.0; mesh.dof_count()];
    let tip: Vec<usize> = (0..bar.points.len())
        .filter(|&vertex| (bar.points[vertex][0] - 2.0).abs() < 1e-12)
        .collect();
    for (vertex, point) in bar.points.iter().enumerate() {
        if point[0].abs() < 1e-12 {
            fixed.extend((0..3).map(|component| (3 * vertex + component) as u32));
        }
    }
    for &vertex in &tip {
        forces[3 * vertex + 2] = -1.0 / tip.len() as f64;
    }
    let stiffness = assemble_stiffness(mesh);
    let static_solution = solve_static(
        mesh,
        &stiffness,
        &fixed,
        &vec![0.0; fixed.len()],
        &forces,
        CG,
        PreconditionerChoice::SymmetricGaussSeidel,
    )
    .expect("the static solve");
    let compliance: f64 = forces
        .iter()
        .zip(&static_solution.displacements)
        .map(|(force, motion)| force * motion)
        .sum();
    for preconditioner in [SimpPreconditioner::Amg, SimpPreconditioner::GaussSeidel] {
        let mut model = SimpModel::new(
            mesh.clone(),
            &fixed,
            forces.clone(),
            SimpSolver {
                preconditioner,
                relative_tolerance: 1e-12,
            },
        )
        .expect("a SIMP model");
        assert_eq!(model.element_count(), bar.tets.len() + bar.hexes.len());
        let full = vec![1.0; model.element_count()];
        let evaluation = model
            .evaluate_compliance(&full, 3.0, 1e-9)
            .expect("the SIMP solve");
        assert!(
            (evaluation.compliance - compliance).abs() < 1e-8 * compliance,
            "{preconditioner:?}: SIMP at full density gives {} where the static solve gives {compliance}",
            evaluation.compliance
        );
    }
}

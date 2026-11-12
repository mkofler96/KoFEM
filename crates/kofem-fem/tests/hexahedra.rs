// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Hexahedra (8-node at order 1, 27-node at order 2) through the whole solve,
//! alone and mixed with tetrahedra: node numbering, patch tests, loads on
//! quadrilateral faces, a cantilever against beam theory, and the refusal of
//! malformed hexahedra.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

use kofem_fem::mesh::{EDGES_OF_HEX, FACES_OF_HEX};
use kofem_fem::{
    assemble_stiffness, solve_static, von_mises, AmgSettings, BoundaryFaces, CgSettings,
    ElementOrder, FemError, Isotropic, PreconditionerChoice, StoppingRule, SurfaceLoadKind,
    TetMesh,
};

const SETTINGS: CgSettings = CgSettings {
    relative_tolerance: 1e-11,
    max_iterations: 20_000,
    stopping: StoppingRule::ResidualNorm,
};
const GS: PreconditionerChoice = PreconditionerChoice::SymmetricGaussSeidel;
const YOUNG: f64 = 210_000.0;
const POISSON: f64 = 0.3;

fn steel() -> Isotropic {
    Isotropic::new(0, YOUNG, POISSON).expect("valid material")
}

fn aluminium() -> Isotropic {
    Isotropic::new(1, 70_000.0, 0.33).expect("valid material")
}

/// Cube corner (bit 0 = x, bit 1 = y, bit 2 = z) of each CHEXA corner: the
/// bottom face counter-clockwise, then the top face above it.
const CUBE_CORNER_OF_HEX: [usize; 8] = [0b000, 0b001, 0b011, 0b010, 0b100, 0b101, 0b111, 0b110];

/// The six Kuhn tets of a cube, as cube corners.
const KUHN: [[usize; 4]; 6] = [
    [0, 1, 3, 7],
    [0, 3, 2, 7],
    [0, 2, 6, 7],
    [0, 6, 4, 7],
    [0, 4, 5, 7],
    [0, 5, 1, 7],
];

struct Grid {
    points: Vec<[f64; 3]>,
    size: [f64; 3],
    /// Cube corners of every cell, by cube-corner bits.
    cells: Vec<[u32; 8]>,
    /// Cell column (along x) of every cell.
    columns: Vec<usize>,
}

/// A structured grid of `cells` over a box; with `distort`, interior points
/// move off the grid so the hexes are not parallelepipeds.
fn grid(cells: [usize; 3], size: [f64; 3], distort: bool) -> Grid {
    let [nx, ny, nz] = cells;
    let index = |ix: usize, iy: usize, iz: usize| ix + (nx + 1) * (iy + (ny + 1) * iz);
    let mut points = Vec::new();
    for iz in 0..=nz {
        for iy in 0..=ny {
            for ix in 0..=nx {
                let interior = ix > 0 && ix < nx && iy > 0 && iy < ny && iz > 0 && iz < nz;
                let mut point = [
                    size[0] * ix as f64 / nx as f64,
                    size[1] * iy as f64 / ny as f64,
                    size[2] * iz as f64 / nz as f64,
                ];
                if distort && interior {
                    // A fixed, irregular shift of up to a fifth of a cell.
                    let seed = (ix * 7 + iy * 13 + iz * 29) as f64;
                    for (axis, coordinate) in point.iter_mut().enumerate() {
                        let cell = size[axis] / cells[axis] as f64;
                        *coordinate += 0.2 * cell * (seed * (axis as f64 + 1.3)).sin();
                    }
                }
                points.push(point);
            }
        }
    }
    let mut corners = Vec::new();
    let mut columns = Vec::new();
    for iz in 0..nz {
        for iy in 0..ny {
            for ix in 0..nx {
                corners.push(std::array::from_fn(|bits| {
                    index(
                        ix + (bits & 1),
                        iy + ((bits >> 1) & 1),
                        iz + ((bits >> 2) & 1),
                    ) as u32
                }));
                columns.push(ix);
            }
        }
    }
    Grid {
        points,
        size,
        cells: corners,
        columns,
    }
}

fn hex_of(cell: &[u32; 8]) -> [u32; 8] {
    CUBE_CORNER_OF_HEX.map(|bits| cell[bits])
}

fn flat(points: &[[f64; 3]]) -> Vec<f64> {
    points.iter().flatten().copied().collect()
}

/// An all-hex mesh of the grid, every element steel.
fn hex_mesh(grid: &Grid, order: ElementOrder) -> TetMesh {
    let hexes: Vec<u32> = grid.cells.iter().flat_map(hex_of).collect();
    TetMesh::with_hexahedra(
        &flat(&grid.points),
        &[],
        &hexes,
        &vec![0; grid.cells.len()],
        vec![steel()],
    )
    .and_then(|mesh| mesh.with_order(order))
    .expect("valid hex mesh")
}

/// The grid's cells left of column `split` as Kuhn tets (steel), the others
/// as hexes (aluminium), sharing the vertices on the interface.
fn mixed_mesh(grid: &Grid, split: usize, order: ElementOrder) -> TetMesh {
    let mut tets = Vec::new();
    let mut hexes = Vec::new();
    for (cell, &column) in grid.cells.iter().zip(&grid.columns) {
        if column < split {
            for tet in KUHN {
                tets.extend(tet.map(|bits| cell[bits]));
            }
        } else {
            hexes.extend(hex_of(cell));
        }
    }
    let materials: Vec<u32> = std::iter::repeat_n(0, tets.len() / 4)
        .chain(std::iter::repeat_n(1, hexes.len() / 8))
        .collect();
    TetMesh::with_hexahedra(
        &flat(&grid.points),
        &tets,
        &hexes,
        &materials,
        vec![steel(), aluminium()],
    )
    .and_then(|mesh| mesh.with_order(order))
    .expect("valid mixed mesh")
}

fn on_boundary(point: [f64; 3], size: [f64; 3]) -> bool {
    (0..3).any(|axis| point[axis].abs() < 1e-12 || (point[axis] - size[axis]).abs() < 1e-12)
}

/// The hex faces of the box side `axis` = `value`, as vertex quadruples.
fn quad_side(mesh: &TetMesh, axis: usize, value: f64) -> Vec<[u32; 4]> {
    let on = |vertex: u32| (mesh.vertices()[vertex as usize][axis] - value).abs() < 1e-12;
    let mut faces = Vec::new();
    for hex in mesh.hexes() {
        for face in FACES_OF_HEX {
            let quad = face.map(|corner| hex[corner]);
            if quad.iter().all(|&vertex| on(vertex)) {
                faces.push(quad);
            }
        }
    }
    faces
}

/// Every DOF of the vertices on the plane `axis` = `value` — what a support
/// in the app prescribes; the solve extends it to edge nodes only.
fn clamp(mesh: &TetMesh, axis: usize, value: f64) -> Vec<u32> {
    clamp_nodes(mesh.vertices(), axis, value)
}

/// Every DOF of every node on the plane, face nodes included: a true clamp.
fn clamp_every_node(mesh: &TetMesh, axis: usize, value: f64) -> Vec<u32> {
    clamp_nodes(mesh.node_coordinates(), axis, value)
}

fn clamp_nodes(points: &[[f64; 3]], axis: usize, value: f64) -> Vec<u32> {
    let mut dofs = Vec::new();
    for (node, point) in points.iter().enumerate() {
        if (point[axis] - value).abs() < 1e-12 {
            dofs.extend((0..3).map(|component| (3 * node + component) as u32));
        }
    }
    dofs
}

fn energy(stiffness: &kofem_fem::CsrMatrix, displacements: &[f64]) -> f64 {
    let mut product = vec![0.0; displacements.len()];
    stiffness.mul_vec(displacements, &mut product);
    0.5 * product
        .iter()
        .zip(displacements)
        .map(|(force, motion)| force * motion)
        .sum::<f64>()
}

/// The von Mises stress of the constant strain of `gradient` (`∂u_i/∂x_j`).
fn uniform_von_mises(gradient: &[[f64; 3]; 3], material: &Isotropic) -> f64 {
    let (lambda, mu) = material.lame();
    let trace = gradient[0][0] + gradient[1][1] + gradient[2][2];
    let sigma: [[f64; 3]; 3] = std::array::from_fn(|row| {
        std::array::from_fn(|col| {
            let strain = f64::midpoint(gradient[row][col], gradient[col][row]);
            2.0 * mu * strain + if row == col { lambda * trace } else { 0.0 }
        })
    });
    let mean = (sigma[0][0] + sigma[1][1] + sigma[2][2]) / 3.0;
    let mut sum = 0.0;
    for (row, entries) in sigma.iter().enumerate() {
        for (col, entry) in entries.iter().enumerate() {
            let deviator = entry - if row == col { mean } else { 0.0 };
            sum += deviator * deviator;
        }
    }
    (1.5 * sum).sqrt()
}

const GRADIENT: [[f64; 3]; 3] = [
    [1e-3, 2e-4, -3e-4],
    [5e-4, -1e-3, 1e-4],
    [-2e-4, 3e-4, 7e-4],
];

fn linear_field(point: [f64; 3]) -> [f64; 3] {
    let mut value = [1e-3, -2e-3, 5e-4];
    for (row, entries) in GRADIENT.iter().enumerate() {
        for (col, entry) in entries.iter().enumerate() {
            value[row] += entry * point[col];
        }
    }
    value
}

/// Prescribe `field` on the nodes `chosen` picks; solve with no load.
fn solve_prescribed(
    mesh: &TetMesh,
    field: impl Fn([f64; 3]) -> [f64; 3],
    chosen: impl Fn(usize, [f64; 3]) -> bool,
) -> Vec<f64> {
    let mut dofs = Vec::new();
    let mut values = Vec::new();
    for (node, point) in mesh.node_coordinates().iter().enumerate() {
        if chosen(node, *point) {
            for (component, value) in field(*point).into_iter().enumerate() {
                dofs.push((3 * node + component) as u32);
                values.push(value);
            }
        }
    }
    let stiffness = assemble_stiffness(mesh);
    let forces = vec![0.0; mesh.dof_count()];
    let solution =
        solve_static(mesh, &stiffness, &dofs, &values, &forces, SETTINGS, GS).expect("solves");
    assert!(solution.iterations > 0, "the interior must be solved for");
    solution.displacements
}

fn assert_field(mesh: &TetMesh, displacements: &[f64], field: impl Fn([f64; 3]) -> [f64; 3]) {
    for (node, point) in mesh.node_coordinates().iter().enumerate() {
        let expected = field(*point);
        for component in 0..3 {
            let got = displacements[3 * node + component];
            assert!(
                (got - expected[component]).abs() < 1e-12,
                "node {node} component {component}: {got} vs {expected:?}"
            );
        }
    }
}

#[test]
fn linear_hex_mesh_has_one_node_per_vertex() {
    let grid = grid([2, 1, 1], [2.0, 1.0, 1.0], false);
    let mesh = hex_mesh(&grid, ElementOrder::Linear);
    assert_eq!(mesh.tets().len(), 0);
    assert_eq!(mesh.hexes().len(), 2);
    assert_eq!(mesh.element_count(), 2);
    assert_eq!(mesh.node_count(), grid.points.len());
    for (hex, corners) in mesh.hexes().iter().enumerate() {
        assert_eq!(mesh.element_nodes(hex), corners);
    }
}

/// A 27-node hex: corners, one node per distinct edge (shared with the
/// neighbours), one per distinct face, one at the centre — numbered in that
/// order after the vertices, each at the mean of its corners.
#[test]
fn quadratic_hex_mesh_numbers_edges_then_faces_then_centres() {
    let grid = grid([2, 2, 1], [2.0, 2.0, 1.0], true);
    let mesh = hex_mesh(&grid, ElementOrder::Quadratic);
    let vertices = mesh.vertex_count();
    // A 2×2×1 grid: 3·3·2 vertices, 33 edges, 20 faces, 4 cells.
    assert_eq!(vertices, 18);
    assert_eq!(mesh.edges().len(), 33);
    assert_eq!(mesh.faces().len(), 20);
    assert_eq!(mesh.node_count(), 18 + 33 + 20 + 4);
    let mean = |corners: &[u32]| -> [f64; 3] {
        let mut sum = [0.0; 3];
        for &vertex in corners {
            for (axis, total) in sum.iter_mut().enumerate() {
                *total += mesh.vertices()[vertex as usize][axis];
            }
        }
        sum.map(|total| total / corners.len() as f64)
    };
    let at = |node: u32| mesh.node_coordinates()[node as usize];
    let close =
        |lhs: [f64; 3], rhs: [f64; 3]| (0..3).all(|axis| (lhs[axis] - rhs[axis]).abs() < 1e-14);
    for (hex, corners) in mesh.hexes().iter().enumerate() {
        let nodes = mesh.element_nodes(hex);
        assert_eq!(nodes.len(), 27);
        assert_eq!(&nodes[..8], corners);
        for (slot, edge) in EDGES_OF_HEX.iter().enumerate() {
            let node = nodes[8 + slot];
            let ends = edge.map(|corner| corners[corner]);
            let index = node as usize - vertices;
            assert_eq!(
                mesh.edges()[index],
                [ends[0].min(ends[1]), ends[0].max(ends[1])]
            );
            assert!(close(at(node), mean(&ends)));
        }
        for (slot, face) in FACES_OF_HEX.iter().enumerate() {
            let node = nodes[20 + slot];
            let mut quad = face.map(|corner| corners[corner]);
            assert!(close(at(node), mean(&quad)));
            quad.sort_unstable();
            let index = node as usize - vertices - mesh.edges().len();
            assert_eq!(mesh.faces()[index], quad);
        }
        let centre = nodes[26] as usize;
        assert_eq!(centre, vertices + 33 + 20 + hex);
        assert!(close(at(nodes[26]), mean(corners)));
    }
    // Neighbouring hexes share the nodes of their common face.
    let first: std::collections::BTreeSet<u32> = mesh.element_nodes(0).iter().copied().collect();
    let second: std::collections::BTreeSet<u32> = mesh.element_nodes(1).iter().copied().collect();
    assert_eq!(first.intersection(&second).count(), 9);
}

/// Patch test at order 1 on distorted (non-parallelepiped) hexes: a linear
/// field prescribed on the boundary vertices is reproduced exactly inside, and
/// every element's centre stress is the field's.
#[test]
fn linear_field_is_reproduced_exactly_on_distorted_linear_hexes() {
    let grid = grid([3, 3, 2], [2.0, 1.5, 1.0], true);
    let mesh = hex_mesh(&grid, ElementOrder::Linear);
    let displacements = solve_prescribed(&mesh, linear_field, |_, point| {
        on_boundary(point, grid.size)
    });
    assert_field(&mesh, &displacements, linear_field);
    let expected = uniform_von_mises(&GRADIENT, &steel());
    let stresses = von_mises(&mesh, &displacements).expect("fits");
    assert_eq!(stresses.len(), mesh.hexes().len());
    for stress in stresses {
        assert!((stress - expected).abs() < 1e-9 * expected);
    }
}

/// Patch test at order 2 on distorted hexes, every boundary node (edge and
/// face nodes too) prescribed.
#[test]
fn linear_field_is_reproduced_exactly_on_distorted_quadratic_hexes() {
    let grid = grid([3, 3, 2], [2.0, 1.5, 1.0], true);
    let mesh = hex_mesh(&grid, ElementOrder::Quadratic);
    let displacements = solve_prescribed(&mesh, linear_field, |_, point| {
        on_boundary(point, grid.size)
    });
    assert_field(&mesh, &displacements, linear_field);
    let expected = uniform_von_mises(&GRADIENT, &steel());
    for stress in von_mises(&mesh, &displacements).expect("fits") {
        assert!((stress - expected).abs() < 1e-9 * expected);
    }
}

/// Higher-order patch test: the exact pure-bending field is quadratic, so
/// 27-node hexes reproduce it exactly from their boundary nodes, with the
/// centre stress `σ_xx = E·κ·z`.
#[test]
fn pure_bending_field_is_reproduced_exactly_on_quadratic_hexes() {
    let grid = grid([3, 2, 2], [3.0, 2.0, 2.0], false);
    let mesh = hex_mesh(&grid, ElementOrder::Quadratic);
    let kappa = 1e-4;
    let field = |[along, across, height]: [f64; 3]| -> [f64; 3] {
        [
            kappa * along * height,
            -POISSON * kappa * across * height,
            -0.5 * kappa * (along * along + POISSON * (height * height - across * across)),
        ]
    };
    let displacements = solve_prescribed(&mesh, field, |_, point| on_boundary(point, grid.size));
    assert_field(&mesh, &displacements, field);
    for (hex, stress) in von_mises(&mesh, &displacements)
        .expect("fits")
        .into_iter()
        .enumerate()
    {
        let centre_z: f64 = mesh
            .hex_corners(hex)
            .iter()
            .map(|corner| corner[2])
            .sum::<f64>()
            / 8.0;
        let expected = YOUNG * kappa * centre_z.abs();
        assert!(
            (stress - expected).abs() < 1e-9 * YOUNG * kappa,
            "hex {hex}: {stress} vs {expected}"
        );
    }
}

/// Order 2 extends vertex conditions to edge nodes only, as the MFEM engine
/// does: a face node of a clamped face stays free.
#[test]
fn vertex_conditions_reach_edge_nodes_but_not_face_nodes() {
    let grid = grid([2, 1, 1], [2.0, 1.0, 1.0], false);
    let mesh = hex_mesh(&grid, ElementOrder::Quadratic);
    let dofs = clamp(&mesh, 0, 0.0);
    let values = vec![0.0; dofs.len()];
    let mut forces = vec![0.0; mesh.dof_count()];
    BoundaryFaces::new(&mesh)
        .apply(
            &mesh,
            0,
            &[],
            &quad_side(&mesh, 0, 2.0),
            SurfaceLoadKind::Force([0.0, 0.0, -100.0]),
            &mut forces,
        )
        .expect("applies");
    let stiffness = assemble_stiffness(&mesh);
    let solution =
        solve_static(&mesh, &stiffness, &dofs, &values, &forces, SETTINGS, GS).expect("solves");
    let points = mesh.node_coordinates();
    let first_face = mesh.vertex_count() + mesh.edges().len();
    for (node, point) in points.iter().enumerate() {
        if point[0].abs() > 1e-12 {
            continue;
        }
        let motion = &solution.displacements[3 * node..3 * node + 3];
        if node < first_face {
            assert!(
                motion.iter().all(|&value| value == 0.0),
                "clamped vertex or edge node {node} moved: {motion:?}"
            );
        } else {
            assert!(
                motion.iter().any(|&value| value != 0.0),
                "the clamped face's centre node {node} is free, as in MFEM"
            );
        }
    }
}

#[test]
fn surface_force_on_linear_quadrilaterals_goes_a_quarter_to_each_corner() {
    let size = [4.0, 2.0, 1.0];
    let grid = grid([4, 2, 2], size, false);
    let mesh = hex_mesh(&grid, ElementOrder::Linear);
    let faces = quad_side(&mesh, 0, size[0]);
    assert_eq!(faces.len(), 4);
    let mut forces = vec![0.0; mesh.dof_count()];
    // A duplicate and an interior face: counted once, and reported.
    let mut selection = faces.clone();
    selection.push(faces[0]);
    let interior = quad_side(&mesh, 0, 1.0)[0];
    selection.push(interior);
    let report = BoundaryFaces::new(&mesh)
        .apply(
            &mesh,
            0,
            &[],
            &selection,
            SurfaceLoadKind::Force([0.0, 0.0, -400.0]),
            &mut forces,
        )
        .expect("applies");
    assert_eq!(report.matched, 4);
    assert_eq!(report.unmatched, 1);
    // Four equal faces: −100 each, −25 per face corner.
    for (vertex, point) in mesh.vertices().iter().enumerate() {
        let faces_here = faces
            .iter()
            .filter(|face| face.contains(&(vertex as u32)))
            .count() as f64;
        let expected = -25.0 * faces_here;
        let got = forces[3 * vertex + 2];
        assert!(
            (got - expected).abs() < 1e-9,
            "vertex {vertex} at {point:?}: {got} vs {expected}"
        );
        assert!(forces[3 * vertex].abs() < 1e-12 && forces[3 * vertex + 1].abs() < 1e-12);
    }
}

/// A 9-node face: ∫N dA is A/36 per corner, A/9 per edge node and 4A/9 at the
/// centre.
#[test]
fn surface_traction_on_quadratic_quadrilaterals_follows_the_biquadratic_weights() {
    let size = [4.0, 2.0, 1.0];
    let grid = grid([1, 1, 1], size, false);
    let mesh = hex_mesh(&grid, ElementOrder::Quadratic);
    let faces = quad_side(&mesh, 2, size[2]);
    assert_eq!(faces.len(), 1);
    let mut forces = vec![0.0; mesh.dof_count()];
    BoundaryFaces::new(&mesh)
        .apply(
            &mesh,
            0,
            &[],
            &faces,
            SurfaceLoadKind::Traction([0.0, 0.0, -9.0]),
            &mut forces,
        )
        .expect("applies");
    let area = size[0] * size[1];
    let nodes = mesh.element_nodes(0);
    // The top face is local face 1 (corners 4..7).
    let top: Vec<u32> = (4..8).map(|corner| nodes[corner]).collect();
    let edges: Vec<u32> = (4..8).map(|edge| nodes[8 + edge]).collect();
    let centre = nodes[21];
    let total: f64 = forces.iter().skip(2).step_by(3).sum();
    assert!((total + 9.0 * area).abs() < 1e-9);
    for &node in &top {
        assert!((forces[3 * node as usize + 2] + 9.0 * area / 36.0).abs() < 1e-9);
    }
    for &node in &edges {
        assert!((forces[3 * node as usize + 2] + 9.0 * area / 9.0).abs() < 1e-9);
    }
    assert!((forces[3 * centre as usize + 2] + 9.0 * area * 4.0 / 9.0).abs() < 1e-9);
}

/// Pressure on the warped side of a distorted mesh: the resultant is
/// −p·(outward area vector), whatever the face shapes.
#[test]
fn pressure_on_distorted_quadrilaterals_pushes_along_the_inward_normal() {
    let size = [2.0, 1.5, 1.0];
    for order in [ElementOrder::Linear, ElementOrder::Quadratic] {
        let mut grid = grid([3, 3, 2], size, true);
        // Move the top face's interior vertices up and down: a warped side.
        for point in &mut grid.points {
            if (point[2] - size[2]).abs() < 1e-12
                && point[0] > 1e-12
                && point[0] < size[0] - 1e-12
                && point[1] > 1e-12
                && point[1] < size[1] - 1e-12
            {
                point[2] += 0.05 * (3.0 * point[0] + 5.0 * point[1]).sin();
            }
        }
        let mesh = hex_mesh(&grid, order);
        // The upper faces of the top layer (the last 3·3 cells).
        let faces: Vec<[u32; 4]> = mesh.hexes()[9..]
            .iter()
            .map(|hex| FACES_OF_HEX[1].map(|corner| hex[corner]))
            .collect();
        assert_eq!(faces.len(), 9);
        let mut forces = vec![0.0; mesh.dof_count()];
        BoundaryFaces::new(&mesh)
            .apply(
                &mesh,
                0,
                &[],
                &faces,
                SurfaceLoadKind::Pressure(2.0),
                &mut forces,
            )
            .expect("applies");
        // The top surface's projected area is size[0]·size[1] along +z; the
        // closed outline lies in the plane z = size[2], so x and y cancel.
        let mut total = [0.0; 3];
        for chunk in forces.as_chunks::<3>().0 {
            for axis in 0..3 {
                total[axis] += chunk[axis];
            }
        }
        let expected = -2.0 * size[0] * size[1];
        assert!(
            total[0].abs() < 1e-9 && total[1].abs() < 1e-9 && (total[2] - expected).abs() < 1e-9,
            "{order:?}: resultant {total:?}, expected [0, 0, {expected}]"
        );
    }
}

/// Cantilever clamped at x = 0, loaded by a total shear force on x = L.
/// 27-node hexes resolve bending to within the Poisson-restrained clamp of
/// Timoshenko beam theory; 8-node hexes, fully integrated, lock in shear and
/// come out stiffer. AMG finds the same field as Gauss–Seidel.
#[test]
fn cantilever_matches_beam_theory() {
    let size: [f64; 3] = [100.0, 10.0, 10.0];
    let cells = [20, 2, 2];
    let force = -1000.0;
    let solve = |mesh: &TetMesh, preconditioner| {
        let dofs = clamp_every_node(mesh, 0, 0.0);
        let values = vec![0.0; dofs.len()];
        let mut forces = vec![0.0; mesh.dof_count()];
        BoundaryFaces::new(mesh)
            .apply(
                mesh,
                0,
                &[],
                &quad_side(mesh, 0, size[0]),
                SurfaceLoadKind::Force([0.0, 0.0, force]),
                &mut forces,
            )
            .expect("applies");
        let stiffness = assemble_stiffness(mesh);
        solve_static(
            mesh,
            &stiffness,
            &dofs,
            &values,
            &forces,
            SETTINGS,
            preconditioner,
        )
        .expect("solves")
    };
    let tip_deflection = |mesh: &TetMesh, displacements: &[f64]| -> f64 {
        let tip: Vec<usize> = (0..mesh.vertex_count())
            .filter(|&vertex| (mesh.vertices()[vertex][0] - size[0]).abs() < 1e-12)
            .collect();
        tip.iter()
            .map(|&vertex| displacements[3 * vertex + 2])
            .sum::<f64>()
            / tip.len() as f64
    };
    let inertia = size[1] * size[2].powi(3) / 12.0;
    let shear_modulus = YOUNG / (2.0 * (1.0 + POISSON));
    let area = size[1] * size[2];
    let timoshenko = force * size[0].powi(3) / (3.0 * YOUNG * inertia)
        + force * size[0] / (5.0 / 6.0 * shear_modulus * area);

    let grid = grid(cells, size, false);
    let quadratic = hex_mesh(&grid, ElementOrder::Quadratic);
    let gauss_seidel = solve(&quadratic, GS);
    let amg = solve(
        &quadratic,
        PreconditionerChoice::SmoothedAggregation(AmgSettings::default()),
    );
    let ratio = tip_deflection(&quadratic, &gauss_seidel.displacements) / timoshenko;
    assert!(
        (0.97..=1.0).contains(&ratio),
        "27-node tip deflection is {ratio} × Timoshenko"
    );
    let peak = gauss_seidel
        .displacements
        .iter()
        .fold(0.0_f64, |peak, value| peak.max(value.abs()));
    for (lhs, rhs) in gauss_seidel.displacements.iter().zip(&amg.displacements) {
        assert!(
            (lhs - rhs).abs() < 1e-8 * peak,
            "AMG {rhs} vs Gauss–Seidel {lhs}"
        );
    }
    assert!(amg.levels.len() > 1, "AMG must coarsen the 27-node system");

    let linear = hex_mesh(&grid, ElementOrder::Linear);
    let linear_ratio = tip_deflection(&linear, &solve(&linear, GS).displacements) / timoshenko;
    assert!(
        (0.8..ratio - 0.05).contains(&linear_ratio),
        "8-node tip deflection is {linear_ratio} × Timoshenko (27-node: {ratio})"
    );
}

/// Linear 8-node hexes converge to beam theory as the mesh is refined
/// through the depth: halving the element size brings the tip deflection
/// within 5 % of Timoshenko.
#[test]
fn linear_hex_cantilever_converges_with_refinement() {
    let size: [f64; 3] = [100.0, 10.0, 10.0];
    let force = -1000.0;
    let inertia = size[1] * size[2].powi(3) / 12.0;
    let shear_modulus = YOUNG / (2.0 * (1.0 + POISSON));
    let timoshenko = force * size[0].powi(3) / (3.0 * YOUNG * inertia)
        + force * size[0] / (5.0 / 6.0 * shear_modulus * size[1] * size[2]);
    let ratio = |cells: [usize; 3]| -> f64 {
        let mesh = hex_mesh(&grid(cells, size, false), ElementOrder::Linear);
        let dofs = clamp_every_node(&mesh, 0, 0.0);
        let values = vec![0.0; dofs.len()];
        let mut forces = vec![0.0; mesh.dof_count()];
        BoundaryFaces::new(&mesh)
            .apply(
                &mesh,
                0,
                &[],
                &quad_side(&mesh, 0, size[0]),
                SurfaceLoadKind::Force([0.0, 0.0, force]),
                &mut forces,
            )
            .expect("applies");
        let stiffness = assemble_stiffness(&mesh);
        let solution = solve_static(
            &mesh,
            &stiffness,
            &dofs,
            &values,
            &forces,
            SETTINGS,
            PreconditionerChoice::SmoothedAggregation(AmgSettings::default()),
        )
        .expect("solves");
        let tip: Vec<usize> = (0..mesh.vertex_count())
            .filter(|&vertex| (mesh.vertices()[vertex][0] - size[0]).abs() < 1e-12)
            .collect();
        tip.iter()
            .map(|&vertex| solution.displacements[3 * vertex + 2])
            .sum::<f64>()
            / tip.len() as f64
            / timoshenko
    };
    let coarse = ratio([20, 2, 2]);
    let fine = ratio([40, 4, 4]);
    assert!(
        coarse < fine && (0.95..=1.0).contains(&fine),
        "8-node tip deflection: {coarse} → {fine} × Timoshenko"
    );
}

/// Tets and hexes in one mesh: the tets are elements 0.., the hexes follow,
/// each with its own material; a quadratic mesh shares the edge nodes of the
/// interface between them, and a uniform strain stores exactly the energy of
/// both parts.
#[test]
fn mixed_mesh_numbers_tets_first_and_stores_both_parts_energy() {
    let size = [2.0, 1.0, 1.0];
    let grid = grid([2, 2, 2], size, false);
    for order in [ElementOrder::Linear, ElementOrder::Quadratic] {
        let mesh = mixed_mesh(&grid, 1, order);
        assert_eq!(mesh.tets().len(), 6 * 4);
        assert_eq!(mesh.hexes().len(), 4);
        assert_eq!(mesh.element_count(), 28);
        assert_eq!(mesh.material(0), &steel());
        assert_eq!(mesh.material(24), &aluminium());
        let strain = 1e-3;
        let mut displacements = vec![0.0; mesh.dof_count()];
        for (node, point) in mesh.node_coordinates().iter().enumerate() {
            displacements[3 * node] = strain * point[0];
        }
        let stiffness = assemble_stiffness(&mesh);
        let expected: f64 = [steel(), aluminium()]
            .iter()
            .map(|material| {
                let (lambda, mu) = material.lame();
                // Each half of the box has volume 1: ½·(λ+2μ)·ε²·1.
                (lambda + 2.0 * mu) * strain * strain / 2.0
            })
            .sum();
        let stored = energy(&stiffness, &displacements);
        assert!(
            (stored - expected).abs() < 1e-12 * expected,
            "{order:?}: energy {stored} vs {expected}"
        );
        // A rigid translation costs nothing.
        let shift: Vec<f64> = (0..mesh.dof_count())
            .map(|dof| [1.0, -2.0, 0.5][dof % 3])
            .collect();
        assert!(energy(&stiffness, &shift).abs() < 1e-9);
    }
    // At order 2 the interface edges carry one node, used by both kinds.
    let mesh = mixed_mesh(&grid, 1, ElementOrder::Quadratic);
    let tet_nodes: std::collections::BTreeSet<u32> = (0..mesh.tets().len())
        .flat_map(|tet| mesh.element_nodes(tet).to_vec())
        .collect();
    let hex_nodes: std::collections::BTreeSet<u32> = (mesh.tets().len()..mesh.element_count())
        .flat_map(|hex| mesh.element_nodes(hex).to_vec())
        .collect();
    let shared: Vec<u32> = tet_nodes.intersection(&hex_nodes).copied().collect();
    let interface_edges = shared
        .iter()
        .filter(|&&node| node as usize >= mesh.vertex_count())
        .count();
    // The x = 1 plane: 3×3 vertices, 12 grid edges between them.
    assert_eq!(shared.len() - interface_edges, 9);
    assert_eq!(interface_edges, 12);
}

/// The mixed mesh's boundary has triangles (tet faces) and quadrilaterals (hex
/// faces); a load can select both, and the hex face against two tet
/// triangles is not part of it.
#[test]
fn mixed_mesh_loads_triangles_and_quadrilaterals_together() {
    let size = [2.0, 1.0, 1.0];
    let grid = grid([2, 1, 1], size, false);
    let mesh = mixed_mesh(&grid, 1, ElementOrder::Linear);
    let on_top = |vertex: u32| (mesh.vertices()[vertex as usize][2] - size[2]).abs() < 1e-12;
    let mut triangles = Vec::new();
    for tet in mesh.tets() {
        for skip in 0..4 {
            let face: Vec<u32> = (0..4)
                .filter(|&corner| corner != skip)
                .map(|corner| tet[corner])
                .collect();
            if face.iter().all(|&vertex| on_top(vertex)) {
                triangles.push([face[0], face[1], face[2]]);
            }
        }
    }
    let quads = quad_side(&mesh, 2, size[2]);
    assert_eq!((triangles.len(), quads.len()), (2, 1));
    let interface = quad_side(&mesh, 0, 1.0);
    assert_eq!(interface.len(), 1);
    let boundary = BoundaryFaces::new(&mesh);
    let mut forces = vec![0.0; mesh.dof_count()];
    let report = boundary
        .apply(
            &mesh,
            0,
            &triangles,
            &[quads[0], interface[0]],
            SurfaceLoadKind::Pressure(3.0),
            &mut forces,
        )
        .expect("applies");
    // The interface quad has two tet triangles on its other side: in MFEM's
    // mesh it is still a boundary face, so it is matched and loaded too.
    assert_eq!(report.matched, 4);
    let total: f64 = forces.iter().skip(2).step_by(3).sum();
    assert!((total + 3.0 * 2.0).abs() < 1e-9, "top resultant {total}");
    let along: f64 = forces.iter().step_by(3).sum();
    // The interface quad's outward normal (from the hex) is −x.
    assert!((along - 3.0).abs() < 1e-9, "interface resultant {along}");
}

#[test]
fn malformed_hexes_are_refused_with_their_reason() {
    let cube = flat(&[
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [1.0, 1.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 1.0],
        [1.0, 1.0, 1.0],
        [0.0, 1.0, 1.0],
    ]);
    let make = |vertices: &[f64], hexes: &[u32], materials: &[u32]| {
        TetMesh::with_hexahedra(vertices, &[], hexes, materials, vec![steel()])
    };
    let corners: Vec<u32> = (0..8).collect();
    assert!(make(&cube, &corners, &[0]).is_ok());
    assert_eq!(
        make(&cube, &corners[..7], &[0]).err(),
        Some(FemError::HexArrayLength { len: 7 })
    );
    assert_eq!(
        make(&cube, &[0, 1, 2, 3, 4, 5, 6, 8], &[0]).err(),
        Some(FemError::HexVertexOutOfRange {
            hex: 0,
            vertex: 8,
            count: 8
        })
    );
    assert_eq!(
        make(&cube, &corners, &[0, 0]).err(),
        Some(FemError::MaterialIdCount {
            count: 2,
            elements: 1
        })
    );
    assert_eq!(
        make(&cube, &corners, &[3]).err(),
        Some(FemError::HexMaterialOutOfRange {
            hex: 0,
            material: 3,
            count: 1
        })
    );
    // The top face collapsed onto the bottom: no volume.
    assert_eq!(
        make(&cube, &[0, 1, 2, 3, 0, 1, 2, 3], &[0]).err(),
        Some(FemError::DegenerateHex { hex: 0 })
    );
    // Two corners swapped: the element folds over itself.
    assert_eq!(
        make(&cube, &[0, 2, 1, 3, 4, 5, 6, 7], &[0]).err(),
        Some(FemError::DegenerateHex { hex: 0 })
    );
    // A mirrored hex (top and bottom swapped) is a valid element, as a tet of
    // either winding is.
    assert!(make(&cube, &[4, 5, 6, 7, 0, 1, 2, 3], &[0]).is_ok());
    assert_eq!(
        TetMesh::with_hexahedra(&cube, &[], &[], &[], vec![steel()]).err(),
        Some(FemError::EmptyMesh)
    );
}

/// Hexes whose Jacobian vanishes or turns only at a corner — a wedge written
/// as a hex with one edge collapsed, a hex with a slightly non-convex face —
/// are integrable: every point the element is integrated (and its stress
/// recovered) at has a positive Jacobian, so MFEM solves them and so must
/// this solver. A uniform strain stores the exact energy of their volume.
#[test]
fn collapsed_and_slightly_non_convex_hexes_are_accepted() {
    let box_corners = [
        [0.0, 0.0, 0.0],
        [2.0, 0.0, 0.0],
        [2.0, 1.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 3.0],
        [2.0, 0.0, 3.0],
        [2.0, 1.0, 3.0],
        [0.0, 1.0, 3.0],
    ];
    // The top face's x = 2 edge collapsed onto its x = 0 edge: a wedge of
    // half the box, 2·1·3 / 2 = 3.
    let wedge: Vec<u32> = vec![0, 1, 2, 3, 4, 4, 7, 7];
    // Corner 2 of the bottom face pushed inward, past the diagonal 1–3: the
    // face turns non-convex there, so the Jacobian at that corner is negative.
    let mut dented = box_corners;
    dented[2] = [1.3, 0.3, 0.0];
    let material = steel();
    let (lambda, mu) = material.lame();
    let strain = 1e-3;
    for order in [ElementOrder::Linear, ElementOrder::Quadratic] {
        let mesh = TetMesh::with_hexahedra(&flat(&box_corners), &[], &wedge, &[0], vec![steel()])
            .and_then(|mesh| mesh.with_order(order))
            .expect("a collapsed hex is a proper element");
        let mut stretch = vec![0.0; mesh.dof_count()];
        for (node, point) in mesh.node_coordinates().iter().enumerate() {
            stretch[3 * node] = strain * point[0];
        }
        let stored = energy(&assemble_stiffness(&mesh), &stretch);
        let expected = (lambda + 2.0 * mu) * strain * strain * 3.0 / 2.0;
        assert!(
            (stored - expected).abs() < 1e-12 * expected,
            "{order:?}: wedge energy {stored} vs {expected}"
        );
        let stresses = von_mises(&mesh, &stretch).expect("fits");
        assert!(stresses[0].is_finite() && stresses[0] > 0.0);

        let mesh = TetMesh::with_hexahedra(
            &flat(&dented),
            &[],
            &(0..8).collect::<Vec<u32>>(),
            &[0],
            vec![steel()],
        )
        .and_then(|mesh| mesh.with_order(order))
        .expect("a slightly non-convex hex is a proper element");
        let stiffness = assemble_stiffness(&mesh);
        // A stretch stores energy; a rigid translation of similar size none.
        let mut stretch = vec![0.0; mesh.dof_count()];
        for (node, point) in mesh.node_coordinates().iter().enumerate() {
            stretch[3 * node] = point[0];
        }
        let stretched = energy(&stiffness, &stretch);
        assert!(stretched > 0.0);
        let shift: Vec<f64> = (0..mesh.dof_count())
            .map(|dof| [1.0, -2.0, 0.5][dof % 3])
            .collect();
        assert!(energy(&stiffness, &shift).abs() < 1e-12 * stretched);
    }
}

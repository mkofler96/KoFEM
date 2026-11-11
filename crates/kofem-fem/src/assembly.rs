// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::element::{tet10_stiffness, tet4_stiffness};
use crate::mesh::{ElementOrder, TetMesh};
use crate::sparse::CsrMatrix;

/// Sorted neighbour list of every node (including itself): the nodes it shares
/// an element with. A vertex no element uses lists only itself, so its rows
/// keep a (zero) diagonal block for the solve to hold it.
#[must_use]
pub fn node_neighbours(mesh: &TetMesh) -> Vec<Vec<u32>> {
    let mut neighbours: Vec<Vec<u32>> = vec![Vec::new(); mesh.node_count()];
    for tet in 0..mesh.tets().len() {
        let nodes = mesh.element_nodes(tet);
        for &node in nodes {
            neighbours[node as usize].extend_from_slice(nodes);
        }
    }
    for (node, list) in neighbours.iter_mut().enumerate() {
        if list.is_empty() {
            #[allow(
                clippy::cast_possible_truncation,
                reason = "TetMesh caps the node count at MAX_NODES"
            )]
            list.push(node as u32);
        }
        list.sort_unstable();
        list.dedup();
    }
    neighbours
}

/// Global stiffness matrix of a linear-elastic tetrahedral mesh, of either
/// element order.
#[must_use]
pub fn assemble_stiffness(mesh: &TetMesh) -> CsrMatrix {
    let neighbours = node_neighbours(mesh);
    let mut matrix = CsrMatrix::from_node_pattern(&neighbours);
    for tet in 0..mesh.tets().len() {
        let (corners, material) = (mesh.corners(tet), mesh.material(tet));
        let nodes = mesh.element_nodes(tet);
        match mesh.order() {
            ElementOrder::Linear => scatter(
                &mut matrix,
                &neighbours,
                tet,
                nodes,
                tet4_stiffness(&corners, material).as_flattened(),
            ),
            ElementOrder::Quadratic => scatter(
                &mut matrix,
                &neighbours,
                tet,
                nodes,
                tet10_stiffness(&corners, material).as_flattened(),
            ),
        }
    }
    matrix
}

/// Add one element stiffness (row-major, 3 DOFs per node of `nodes`) into the
/// global matrix.
fn scatter(
    matrix: &mut CsrMatrix,
    neighbours: &[Vec<u32>],
    tet: usize,
    nodes: &[u32],
    element: &[f64],
) {
    let width = 3 * nodes.len();
    debug_assert_eq!(element.len(), width * width);
    let mut block_offset = [0usize; 10];
    for (local_a, &node_a) in nodes.iter().enumerate() {
        let list = &neighbours[node_a as usize];
        // Column offset of block (a, b) within each of a's rows: rows list
        // the neighbours in order, three columns each.
        for (local_b, &node_b) in nodes.iter().enumerate() {
            let position = list
                .binary_search(&node_b)
                .unwrap_or_else(|_| unreachable!("nodes of element {tet} are neighbours"));
            block_offset[local_b] = 3 * position;
        }
        for component_a in 0..3 {
            let row = 3 * node_a as usize + component_a;
            let row_first = matrix.row_range(row).start;
            let element_row = &element[width * (3 * local_a + component_a)..][..width];
            let values = matrix.values_mut();
            for (local_b, offset) in block_offset[..nodes.len()].iter().enumerate() {
                let first = row_first + offset;
                for component_b in 0..3 {
                    values[first + component_b] += element_row[3 * local_b + component_b];
                }
            }
        }
    }
}

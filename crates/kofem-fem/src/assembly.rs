// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::count::index_as_u32;
use crate::mesh::TetMesh;
use crate::sparse::CsrMatrix;

/// Most nodes of one element: the 27-node hexahedron.
const MAX_ELEMENT_NODES: usize = 27;

/// Sorted neighbour list of every node (including itself): the nodes it
/// shares an element with. A vertex no element uses lists only itself, so its rows
/// keep a (zero) diagonal block for the solve to hold it.
#[must_use]
pub fn node_neighbours(mesh: &TetMesh) -> Vec<Vec<u32>> {
    neighbours_of(mesh, mesh.node_count(), |element| {
        mesh.element_nodes(element)
    })
}

/// Sorted neighbour list of each of `count` nodes (itself included): the
/// nodes it shares an element with, as `nodes_of(element)` lists them. A node
/// no element lists has only itself.
pub(crate) fn neighbours_of<'mesh>(
    mesh: &'mesh TetMesh,
    count: usize,
    nodes_of: impl Fn(usize) -> &'mesh [u32],
) -> Vec<Vec<u32>> {
    let mut neighbours: Vec<Vec<u32>> = vec![Vec::new(); count];
    for element in 0..mesh.element_count() {
        let nodes = nodes_of(element);
        for &node in nodes {
            neighbours[node as usize].extend_from_slice(nodes);
        }
    }
    for (node, list) in neighbours.iter_mut().enumerate() {
        if list.is_empty() {
            list.push(index_as_u32(node));
        }
        list.sort_unstable();
        list.dedup();
    }
    neighbours
}

/// Global stiffness matrix of a linear-elastic mesh of tetrahedra and
/// hexahedra, of either element order: every piece of every element
/// ([`TetMesh::pieces`]).
#[must_use]
pub fn assemble_stiffness(mesh: &TetMesh) -> CsrMatrix {
    let neighbours = node_neighbours(mesh);
    let mut matrix = CsrMatrix::from_node_pattern(&neighbours);
    for element in 0..mesh.element_count() {
        let material = mesh.material(element);
        for piece in mesh.pieces(element) {
            let stiffness = piece.stiffness(material);
            scatter(&mut matrix, &neighbours, element, piece.nodes, &stiffness);
        }
    }
    matrix
}

/// Add one element stiffness (row-major, 3 DOFs per node of `nodes`) into the
/// global matrix.
pub(crate) fn scatter(
    matrix: &mut CsrMatrix,
    neighbours: &[Vec<u32>],
    element: usize,
    nodes: &[u32],
    stiffness: &[f64],
) {
    let width = 3 * nodes.len();
    debug_assert_eq!(stiffness.len(), width * width);
    let mut block_offset = [0usize; MAX_ELEMENT_NODES];
    for (local_a, &node_a) in nodes.iter().enumerate() {
        let list = &neighbours[node_a as usize];
        // Column offset of block (a, b) within each of a's rows: rows list
        // the neighbours in order, three columns each.
        for (local_b, &node_b) in nodes.iter().enumerate() {
            let position = list
                .binary_search(&node_b)
                .unwrap_or_else(|_| unreachable!("nodes of element {element} are neighbours"));
            block_offset[local_b] = 3 * position;
        }
        for component_a in 0..3 {
            let row = 3 * node_a as usize + component_a;
            let row_first = matrix.row_range(row).start;
            let element_row = &stiffness[width * (3 * local_a + component_a)..][..width];
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

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::element::tet4_stiffness;
use crate::mesh::TetMesh;
use crate::sparse::CsrMatrix;

/// Sorted neighbour list of every node (including itself): the nodes it shares
/// an element with.
#[must_use]
pub fn node_neighbours(mesh: &TetMesh) -> Vec<Vec<u32>> {
    let mut neighbours: Vec<Vec<u32>> = vec![Vec::new(); mesh.vertex_count()];
    for tet in mesh.tets() {
        for &node in tet {
            neighbours[node as usize].extend_from_slice(tet);
        }
    }
    for list in &mut neighbours {
        list.sort_unstable();
        list.dedup();
    }
    neighbours
}

/// Global stiffness matrix of a linear-elastic tetrahedral mesh.
#[must_use]
pub fn assemble_stiffness(mesh: &TetMesh) -> CsrMatrix {
    let neighbours = node_neighbours(mesh);
    let mut matrix = CsrMatrix::from_node_pattern(&neighbours);
    for (tet, nodes) in mesh.tets().iter().enumerate() {
        let element = tet4_stiffness(&mesh.corners(tet), mesh.material(tet));
        for (local_a, &node_a) in nodes.iter().enumerate() {
            let list = &neighbours[node_a as usize];
            // Column offset of block (a, b) within each of a's rows: rows list
            // the neighbours in order, three columns each.
            let mut block_offset = [0usize; 4];
            for (local_b, &node_b) in nodes.iter().enumerate() {
                let position = list
                    .binary_search(&node_b)
                    .unwrap_or_else(|_| unreachable!("nodes of element {tet} are neighbours"));
                block_offset[local_b] = 3 * position;
            }
            for component_a in 0..3 {
                let row = 3 * node_a as usize + component_a;
                let row_first = matrix.row_range(row).start;
                let element_row = &element[3 * local_a + component_a];
                let values = matrix.values_mut();
                for (local_b, offset) in block_offset.iter().enumerate() {
                    let first = row_first + offset;
                    for component_b in 0..3 {
                        values[first + component_b] += element_row[3 * local_b + component_b];
                    }
                }
            }
        }
    }
    matrix
}

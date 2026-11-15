// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::shell::element::facet_stiffness;
use crate::shell::mesh::ShellMesh;
use crate::sparse::CsrMatrix;

/// DOFs per shell node: u, v, w, θx, θy, θz.
pub const SHELL_NODE_DOFS: usize = 6;

/// Sorted neighbour list of every node (including itself): the nodes it shares
/// a facet with. A vertex no facet uses lists only itself, so its rows keep a
/// (zero) diagonal block for the solve to hold it.
#[must_use]
pub fn shell_node_neighbours(mesh: &ShellMesh) -> Vec<Vec<u32>> {
    let mut neighbours: Vec<Vec<u32>> = vec![Vec::new(); mesh.vertex_count()];
    for triangle in mesh.triangles() {
        for &node in triangle {
            neighbours[node as usize].extend_from_slice(triangle);
        }
    }
    for (node, list) in neighbours.iter_mut().enumerate() {
        if list.is_empty() {
            #[allow(
                clippy::cast_possible_truncation,
                reason = "ShellMesh::new caps the vertex count at MAX_SHELL_VERTICES"
            )]
            list.push(node as u32);
        }
        list.sort_unstable();
        list.dedup();
    }
    neighbours
}

/// Global stiffness matrix of a shell mesh, 6 DOFs per node (DOF 6·node +
/// component).
#[must_use]
pub fn assemble_shell_stiffness(mesh: &ShellMesh) -> CsrMatrix {
    let neighbours = shell_node_neighbours(mesh);
    let mut matrix = CsrMatrix::from_node_blocks(&neighbours, SHELL_NODE_DOFS);
    for (triangle, nodes) in mesh.triangles().iter().enumerate() {
        let element = facet_stiffness(
            &mesh.corners(triangle),
            mesh.thickness(triangle),
            mesh.material(triangle),
        );
        for (local_a, &node_a) in nodes.iter().enumerate() {
            let list = &neighbours[node_a as usize];
            // Column offset of block (a, b) within each of a's rows: rows list
            // the neighbours in order, six columns each.
            let mut block_offset = [0usize; 3];
            for (local_b, &node_b) in nodes.iter().enumerate() {
                let position = list
                    .binary_search(&node_b)
                    .unwrap_or_else(|_| unreachable!("nodes of facet {triangle} are neighbours"));
                block_offset[local_b] = SHELL_NODE_DOFS * position;
            }
            for component_a in 0..SHELL_NODE_DOFS {
                let row = SHELL_NODE_DOFS * node_a as usize + component_a;
                let row_first = matrix.row_range(row).start;
                let element_row = &element[SHELL_NODE_DOFS * local_a + component_a];
                let values = matrix.values_mut();
                for (local_b, offset) in block_offset.iter().enumerate() {
                    let first = row_first + offset;
                    for component_b in 0..SHELL_NODE_DOFS {
                        values[first + component_b] +=
                            element_row[SHELL_NODE_DOFS * local_b + component_b];
                    }
                }
            }
        }
    }
    matrix
}

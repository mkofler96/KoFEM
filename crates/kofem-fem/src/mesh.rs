// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::error::FemError;
use crate::material::Isotropic;

/// Polynomial order of the displacement field on each tetrahedron.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElementOrder {
    /// 4-node tetrahedron: one node per corner.
    Linear,
    /// 10-node tetrahedron: the corners plus one node at the midpoint of each
    /// edge. The mid-edge nodes are generated from the corner mesh, as MFEM's
    /// order-2 H1 space does, so the caller still passes vertices only.
    Quadratic,
}

impl ElementOrder {
    /// Nodes of one element: 4 or 10.
    #[must_use]
    pub fn nodes_per_element(self) -> usize {
        match self {
            Self::Linear => 4,
            Self::Quadratic => 10,
        }
    }
}

/// Local corner pairs of the six tet edges, in the order the mid-edge nodes of
/// a quadratic element follow its four corners.
pub const EDGES_OF_TET: [[usize; 2]; 6] = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];

/// Local edge of a tet joining corners `first` and `second` (either order).
#[must_use]
pub fn local_edge(first: usize, second: usize) -> usize {
    let pair = [first.min(second), first.max(second)];
    EDGES_OF_TET
        .iter()
        .position(|edge| *edge == pair)
        .unwrap_or_else(|| unreachable!("corners {first} and {second} do not form a tet edge"))
}

/// Tetrahedral mesh with one material per element, validated on construction:
/// every index is in range and every element has volume.
///
/// Nodes carry the DOFs (3·node + component). The vertices come first, in
/// input order; a quadratic mesh appends one node per distinct edge, so the
/// first 3·`vertex_count` entries of a displacement vector are always the
/// vertex displacements.
#[derive(Debug, Clone)]
pub struct TetMesh {
    order: ElementOrder,
    /// Vertices, then edge midpoints for a quadratic mesh.
    nodes: Vec<[f64; 3]>,
    vertex_count: usize,
    tets: Vec<[u32; 4]>,
    /// `nodes_per_element` node indices per element: corners, then edges in
    /// [`EDGES_OF_TET`] order.
    element_nodes: Vec<u32>,
    /// Corner vertices of each edge node, edge k being node `vertex_count + k`.
    edges: Vec<[u32; 2]>,
    material_of_tet: Vec<u32>,
    materials: Vec<Isotropic>,
    used: Vec<bool>,
}

impl TetMesh {
    /// Build a linear mesh from flat arrays: `vertices` as x,y,z triples,
    /// `tets` as four vertex indices each, `material_of_tet` as an index into
    /// `materials`. Vertex winding does not matter. [`TetMesh::with_order`]
    /// turns it into a quadratic mesh.
    ///
    /// # Errors
    /// A [`FemError`] naming the first malformed array, index or element.
    pub fn new(
        vertices: &[f64],
        tets: &[u32],
        material_of_tet: &[u32],
        materials: Vec<Isotropic>,
    ) -> Result<Self, FemError> {
        if !vertices.len().is_multiple_of(3) {
            return Err(FemError::VertexArrayLength {
                len: vertices.len(),
            });
        }
        if !tets.len().is_multiple_of(4) {
            return Err(FemError::TetArrayLength { len: tets.len() });
        }
        if tets.is_empty() {
            return Err(FemError::EmptyMesh);
        }
        if vertices.len() / 3 > MAX_NODES {
            return Err(FemError::TooManyNodes {
                count: vertices.len() / 3,
                max: MAX_NODES,
            });
        }
        if let Some(&value) = vertices.iter().find(|value| !value.is_finite()) {
            return Err(FemError::NonFinite {
                what: "a vertex coordinate",
                value,
            });
        }
        // The lengths were checked above, so there is no remainder to drop.
        let points: Vec<[f64; 3]> = vertices.as_chunks::<3>().0.to_vec();
        let elements: Vec<[u32; 4]> = tets.as_chunks::<4>().0.to_vec();
        if material_of_tet.len() != elements.len() {
            return Err(FemError::MaterialIdCount {
                count: material_of_tet.len(),
                tets: elements.len(),
            });
        }

        for (tet, ids) in elements.iter().enumerate() {
            for &vertex in ids {
                if vertex as usize >= points.len() {
                    return Err(FemError::VertexOutOfRange {
                        tet,
                        vertex,
                        count: points.len(),
                    });
                }
            }
            let material = material_of_tet[tet];
            if material as usize >= materials.len() {
                return Err(FemError::MaterialOutOfRange {
                    tet,
                    material,
                    count: materials.len(),
                });
            }
            let corners = ids.map(|vertex| points[vertex as usize]);
            if signed_volume(&corners).abs() <= degenerate_volume(&corners) {
                return Err(FemError::DegenerateTet { tet });
            }
        }

        // Meshers can leave vertices that no element uses (Netgen does). They
        // carry no stiffness, so the solve must hold them explicitly.
        let mut used = vec![false; points.len()];
        for ids in &elements {
            for &vertex in ids {
                used[vertex as usize] = true;
            }
        }

        Ok(Self {
            order: ElementOrder::Linear,
            vertex_count: points.len(),
            nodes: points,
            element_nodes: elements.iter().flatten().copied().collect(),
            tets: elements,
            edges: Vec::new(),
            material_of_tet: material_of_tet.to_vec(),
            materials,
            used,
        })
    }

    /// The same mesh with elements of `order`. Quadratic elements get one node
    /// per distinct edge, numbered after the vertices in sorted (lower vertex,
    /// higher vertex) order, so the numbering depends only on the mesh.
    ///
    /// # Errors
    /// [`FemError::TooManyNodes`] when the vertices and edge nodes together
    /// exceed [`MAX_NODES`].
    pub fn with_order(self, order: ElementOrder) -> Result<Self, FemError> {
        let linear = Self {
            order: ElementOrder::Linear,
            nodes: self.nodes[..self.vertex_count].to_vec(),
            element_nodes: self.tets.iter().flatten().copied().collect(),
            edges: Vec::new(),
            used: self.used[..self.vertex_count].to_vec(),
            ..self
        };
        match order {
            ElementOrder::Linear => Ok(linear),
            ElementOrder::Quadratic => linear.into_quadratic(),
        }
    }

    fn into_quadratic(self) -> Result<Self, FemError> {
        let mut edges: Vec<[u32; 2]> = self
            .tets
            .iter()
            .flat_map(|tet| {
                EDGES_OF_TET.map(|[first, second]| {
                    let (first, second) = (tet[first], tet[second]);
                    [first.min(second), first.max(second)]
                })
            })
            .collect();
        edges.sort_unstable();
        edges.dedup();
        let node_count = self.vertex_count + edges.len();
        if node_count > MAX_NODES {
            return Err(FemError::TooManyNodes {
                count: node_count,
                max: MAX_NODES,
            });
        }
        let edge_node = |first: u32, second: u32| -> u32 {
            let key = [first.min(second), first.max(second)];
            let index = edges
                .binary_search(&key)
                .unwrap_or_else(|_| unreachable!("every element edge was collected"));
            #[allow(
                clippy::cast_possible_truncation,
                reason = "node_count was checked against MAX_NODES above"
            )]
            let node = (self.vertex_count + index) as u32;
            node
        };
        let mut element_nodes = Vec::with_capacity(10 * self.tets.len());
        for tet in &self.tets {
            element_nodes.extend_from_slice(tet);
            for [first, second] in EDGES_OF_TET {
                element_nodes.push(edge_node(tet[first], tet[second]));
            }
        }
        let midpoints: Vec<[f64; 3]> = edges
            .iter()
            .map(|&[first, second]| {
                let (first, second) = (self.nodes[first as usize], self.nodes[second as usize]);
                [0, 1, 2].map(|axis| f64::midpoint(first[axis], second[axis]))
            })
            .collect();
        let mut nodes = self.nodes;
        nodes.extend(midpoints);
        let mut used = self.used;
        used.resize(node_count, true);
        Ok(Self {
            order: ElementOrder::Quadratic,
            nodes,
            element_nodes,
            edges,
            used,
            ..self
        })
    }

    #[must_use]
    pub fn order(&self) -> ElementOrder {
        self.order
    }

    #[must_use]
    pub fn vertex_count(&self) -> usize {
        self.vertex_count
    }

    /// Vertices plus, for a quadratic mesh, edge nodes.
    #[must_use]
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// Unknowns of the displacement field: 3 per node.
    #[must_use]
    pub fn dof_count(&self) -> usize {
        3 * self.nodes.len()
    }

    /// Whether any element uses `node`. Edge nodes always are.
    #[must_use]
    pub fn is_used(&self, node: usize) -> bool {
        self.used[node]
    }

    /// Vertices that no element uses.
    #[must_use]
    pub fn unused_vertex_count(&self) -> usize {
        self.used.iter().filter(|&&used| !used).count()
    }

    /// Vertex coordinates.
    #[must_use]
    pub fn vertices(&self) -> &[[f64; 3]] {
        &self.nodes[..self.vertex_count]
    }

    /// Node coordinates: the vertices, then the edge midpoints.
    #[must_use]
    pub fn node_coordinates(&self) -> &[[f64; 3]] {
        &self.nodes
    }

    /// Corner vertices of each edge node; edge k is node `vertex_count + k`.
    /// Empty for a linear mesh.
    #[must_use]
    pub fn edges(&self) -> &[[u32; 2]] {
        &self.edges
    }

    #[must_use]
    pub fn tets(&self) -> &[[u32; 4]] {
        &self.tets
    }

    /// The nodes of element `tet`: its corners, then (quadratic) its edge
    /// nodes in [`EDGES_OF_TET`] order.
    #[must_use]
    pub fn element_nodes(&self, tet: usize) -> &[u32] {
        let count = self.order.nodes_per_element();
        &self.element_nodes[count * tet..count * (tet + 1)]
    }

    /// Corner coordinates of element `tet`.
    #[must_use]
    pub fn corners(&self, tet: usize) -> [[f64; 3]; 4] {
        self.tets[tet].map(|vertex| self.nodes[vertex as usize])
    }

    #[must_use]
    pub fn material(&self, tet: usize) -> &Isotropic {
        &self.materials[self.material_of_tet[tet] as usize]
    }
}

/// Largest node count whose DOF numbers (3·node + component) fit in `u32`,
/// the index type of the sparse matrix columns and of the JS interface.
pub const MAX_NODES: usize = (u32::MAX / 3) as usize;

/// Signed volume of a tetrahedron (positive for right-handed winding).
#[must_use]
pub fn signed_volume(corners: &[[f64; 3]; 4]) -> f64 {
    let edge = |to: usize| sub(corners[to], corners[0]);
    let (first, second, third) = (edge(1), edge(2), edge(3));
    dot(first, cross(second, third)) / 6.0
}

/// Volume below which an element counts as flat: a relative tolerance on the
/// cube of its longest edge, so the test is independent of the model's units.
fn degenerate_volume(corners: &[[f64; 3]; 4]) -> f64 {
    let mut longest: f64 = 0.0;
    for first in 0..4 {
        for second in first + 1..4 {
            let edge = sub(corners[second], corners[first]);
            longest = longest.max(dot(edge, edge).sqrt());
        }
    }
    1e-12 * longest.powi(3)
}

pub(crate) fn sub(lhs: [f64; 3], rhs: [f64; 3]) -> [f64; 3] {
    [lhs[0] - rhs[0], lhs[1] - rhs[1], lhs[2] - rhs[2]]
}

pub(crate) fn dot(lhs: [f64; 3], rhs: [f64; 3]) -> f64 {
    lhs[0] * rhs[0] + lhs[1] * rhs[1] + lhs[2] * rhs[2]
}

pub(crate) fn cross(lhs: [f64; 3], rhs: [f64; 3]) -> [f64; 3] {
    [
        lhs[1] * rhs[2] - lhs[2] * rhs[1],
        lhs[2] * rhs[0] - lhs[0] * rhs[2],
        lhs[0] * rhs[1] - lhs[1] * rhs[0],
    ]
}

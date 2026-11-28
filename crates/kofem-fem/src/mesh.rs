// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::count::{count_as_f64, index_as_u32};
use crate::element::{
    cube_rule, hex8_reference_gradients, hex_jacobian, HEX27_RULE_POINTS, HEX8_RULE_POINTS,
};
use crate::error::FemError;
use crate::material::Isotropic;
use crate::piece::{Piece, PieceGeometry, PieceRef};
use crate::transition::{find_interface_faces, split_hexes, InterfaceFace, Split};

/// Polynomial order of the displacement field on each element.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElementOrder {
    /// One node per corner: 4-node tetrahedra, 8-node hexahedra.
    Linear,
    /// Lagrange elements of order 2: 10-node tetrahedra (corners and edge
    /// midpoints) and 27-node hexahedra (corners, edge midpoints, face centres
    /// and the centre). The extra nodes are generated from the corner mesh, as
    /// MFEM's order-2 H1 space does, so the caller still passes vertices only.
    Quadratic,
}

/// The kind of a solid element.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElementShape {
    Tetrahedron,
    Hexahedron,
}

impl ElementShape {
    /// Nodes of one element of `order`: 4 or 10 for a tetrahedron, 8 or 27
    /// for a hexahedron.
    #[must_use]
    pub fn node_count(self, order: ElementOrder) -> usize {
        match (self, order) {
            (Self::Tetrahedron, ElementOrder::Linear) => 4,
            (Self::Tetrahedron, ElementOrder::Quadratic) => 10,
            (Self::Hexahedron, ElementOrder::Linear) => 8,
            (Self::Hexahedron, ElementOrder::Quadratic) => 27,
        }
    }
}

/// Local corner pairs of the six tet edges, in the order the mid-edge nodes of
/// a quadratic element follow its four corners.
pub const EDGES_OF_TET: [[usize; 2]; 6] = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];

/// Local corner pairs of the twelve hex edges, in the order the mid-edge nodes
/// of a 27-node element follow its eight corners. Corners are numbered as in
/// MFEM and a Nastran CHEXA: the bottom face 0–3 counter-clockwise, then the
/// top face 4–7 above it.
pub const EDGES_OF_HEX: [[usize; 2]; 12] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [0, 3],
    [4, 5],
    [5, 6],
    [6, 7],
    [4, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
];

/// Local corners of the six hex faces, each in cyclic order (outward by the
/// right-hand rule on a positively oriented hex), in the order the face nodes
/// of a 27-node element follow its edge nodes: bottom, top, then the four
/// sides.
pub const FACES_OF_HEX: [[usize; 4]; 6] = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
];

/// Local edge of a tet joining corners `first` and `second` (either order).
#[must_use]
pub fn local_edge(first: usize, second: usize) -> usize {
    let pair = [first.min(second), first.max(second)];
    EDGES_OF_TET
        .iter()
        .position(|edge| *edge == pair)
        .unwrap_or_else(|| unreachable!("corners {first} and {second} do not form a tet edge"))
}

/// Local edge of a hex joining corners `first` and `second` (either order).
#[must_use]
pub fn local_hex_edge(first: usize, second: usize) -> usize {
    let pair = [first.min(second), first.max(second)];
    EDGES_OF_HEX
        .iter()
        .position(|edge| *edge == pair)
        .unwrap_or_else(|| unreachable!("corners {first} and {second} do not form a hex edge"))
}

/// Solid mesh of tetrahedra and hexahedra with one material per element,
/// validated on construction: every index is in range and every element has
/// volume. (The name predates the hexahedra.)
///
/// Elements are numbered tets first, then hexes — the order of the MFEM
/// engine's `mesh.attributes` and of its per-element results. Nodes carry the
/// DOFs (3·node + component). The vertices come first, in input order; a
/// quadratic mesh appends one node per distinct edge, then one per distinct
/// hex face, then one per hex centre, so the first 3·`vertex_count` entries
/// of a displacement vector are always the vertex displacements.
///
/// A hex with a face that meets two tet triangles is solved as a transition
/// element ([`crate::transition`]): its pieces ([`TetMesh::pieces`]) add a
/// node at its centre (a quadratic hex has one) and, at order 2, nodes inside
/// it, numbered after all the others.
#[derive(Debug, Clone)]
pub struct TetMesh {
    order: ElementOrder,
    /// Vertices, then (quadratic) edge midpoints, face centres and hex centres.
    nodes: Vec<[f64; 3]>,
    vertex_count: usize,
    tets: Vec<[u32; 4]>,
    hexes: Vec<[u32; 8]>,
    /// The nodes of every element, tets first: corners, then (quadratic) edges
    /// in [`EDGES_OF_TET`] / [`EDGES_OF_HEX`] order, and for a hex its faces in
    /// [`FACES_OF_HEX`] order and its centre.
    element_nodes: Vec<u32>,
    /// Corner vertices of each edge node, edge k being node `vertex_count + k`.
    edges: Vec<[u32; 2]>,
    /// Sorted corner vertices of each hex face node, face k being node
    /// `vertex_count + edges.len() + k`.
    faces: Vec<[u32; 4]>,
    material_of_element: Vec<u32>,
    materials: Vec<Isotropic>,
    used: Vec<bool>,
    /// The hex faces that meet two tet triangles, sorted by hex and face.
    interfaces: Vec<InterfaceFace>,
    /// Both triangles of every interface face, each sorted, the list sorted.
    interface_triangles: Vec<[u32; 3]>,
    /// The hexes solved as transition elements, sorted by element.
    splits: Vec<Split>,
    /// The first node a transition adds, and the hex each added node is in.
    first_transition_node: usize,
    transition_hex: Vec<usize>,
}

impl TetMesh {
    /// Build a linear tetrahedral mesh from flat arrays: `vertices` as x,y,z
    /// triples, `tets` as four vertex indices each, `material_of_tet` as an
    /// index into `materials`. Vertex winding does not matter.
    /// [`TetMesh::with_order`] turns it into a quadratic mesh.
    ///
    /// # Errors
    /// A [`FemError`] naming the first malformed array, index or element.
    pub fn new(
        vertices: &[f64],
        tets: &[u32],
        material_of_tet: &[u32],
        materials: Vec<Isotropic>,
    ) -> Result<Self, FemError> {
        Self::with_hexahedra(vertices, tets, &[], material_of_tet, materials)
    }

    /// Build a linear mesh of tetrahedra and hexahedra: `hexes` as eight
    /// vertex indices each, in MFEM / CHEXA order (the bottom face, then the
    /// top face above it), and `material_of_element` with one index into
    /// `materials` per element, tets first. Either element array may be
    /// empty. A hex may be mirrored (all its Jacobians negative), as a tet may
    /// have either winding, but not folded.
    ///
    /// # Errors
    /// A [`FemError`] naming the first malformed array, index or element.
    pub fn with_hexahedra(
        vertices: &[f64],
        tets: &[u32],
        hexes: &[u32],
        material_of_element: &[u32],
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
        if !hexes.len().is_multiple_of(8) {
            return Err(FemError::HexArrayLength { len: hexes.len() });
        }
        if tets.is_empty() && hexes.is_empty() {
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
        let tet_elements: Vec<[u32; 4]> = tets.as_chunks::<4>().0.to_vec();
        let hex_elements: Vec<[u32; 8]> = hexes.as_chunks::<8>().0.to_vec();
        let element_count = tet_elements.len() + hex_elements.len();
        if material_of_element.len() != element_count {
            return Err(FemError::MaterialIdCount {
                count: material_of_element.len(),
                elements: element_count,
            });
        }

        for (tet, ids) in tet_elements.iter().enumerate() {
            if let Some(&vertex) = ids.iter().find(|&&vertex| vertex as usize >= points.len()) {
                return Err(FemError::VertexOutOfRange {
                    tet,
                    vertex,
                    count: points.len(),
                });
            }
            let material = material_of_element[tet];
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
        check_hexes(
            &points,
            &hex_elements,
            &material_of_element[tet_elements.len()..],
            materials.len(),
        )?;

        // Meshers can leave vertices that no element uses (Netgen does). They
        // carry no stiffness, so the solve must hold them explicitly.
        let mut used = vec![false; points.len()];
        for &vertex in tets.iter().chain(hexes) {
            used[vertex as usize] = true;
        }
        let interfaces = find_interface_faces(&tet_elements, &hex_elements)?;
        let interface_triangles = sorted_triangles(&interfaces, &hex_elements);

        Self {
            order: ElementOrder::Linear,
            vertex_count: points.len(),
            nodes: points,
            element_nodes: tets.iter().chain(hexes).copied().collect(),
            tets: tet_elements,
            hexes: hex_elements,
            edges: Vec::new(),
            faces: Vec::new(),
            material_of_element: material_of_element.to_vec(),
            materials,
            used,
            interfaces,
            interface_triangles,
            splits: Vec::new(),
            first_transition_node: 0,
            transition_hex: Vec::new(),
        }
        .with_transitions()
    }

    /// The same mesh with elements of `order`. Quadratic elements get one node
    /// per distinct edge, numbered after the vertices in sorted (lower vertex,
    /// higher vertex) order, then one per distinct hex face in sorted order of
    /// its corners, then one per hex centre — so the numbering depends only on
    /// the mesh.
    ///
    /// # Errors
    /// [`FemError::TooManyNodes`] when the vertices and the added nodes
    /// together exceed [`MAX_NODES`].
    pub fn with_order(self, order: ElementOrder) -> Result<Self, FemError> {
        let linear = Self {
            order: ElementOrder::Linear,
            nodes: self.nodes[..self.vertex_count].to_vec(),
            element_nodes: self
                .tets
                .iter()
                .flatten()
                .chain(self.hexes.iter().flatten())
                .copied()
                .collect(),
            edges: Vec::new(),
            faces: Vec::new(),
            used: self.used[..self.vertex_count].to_vec(),
            splits: Vec::new(),
            first_transition_node: 0,
            transition_hex: Vec::new(),
            ..self
        };
        match order {
            ElementOrder::Linear => linear.with_transitions(),
            ElementOrder::Quadratic => linear.into_quadratic()?.with_transitions(),
        }
    }

    /// Split the hexes with an interface face into their pieces, adding their
    /// nodes after all the others.
    fn with_transitions(mut self) -> Result<Self, FemError> {
        if self.interfaces.is_empty() {
            return Ok(self);
        }
        let first_node = self.nodes.len();
        let transitions = split_hexes(&self.interfaces, &self, first_node);
        let node_count = first_node + transitions.added.len();
        if node_count > MAX_NODES {
            return Err(FemError::TooManyNodes {
                count: node_count,
                max: MAX_NODES,
            });
        }
        self.nodes.extend(transitions.added);
        self.used.resize(node_count, true);
        self.splits = transitions.splits;
        self.first_transition_node = first_node;
        self.transition_hex = transitions.added_in;
        Ok(self)
    }

    fn into_quadratic(self) -> Result<Self, FemError> {
        // The 27-node rule samples the hex at other points than the 8-node one.
        if let Some(hex) = (0..self.hexes.len())
            .find(|&hex| !hex_is_valid(&self.hex_corners(hex), ElementOrder::Quadratic))
        {
            return Err(FemError::DegenerateHex { hex });
        }
        let sorted_pair = |first: u32, second: u32| [first.min(second), first.max(second)];
        let mut edges: Vec<[u32; 2]> = self
            .tets
            .iter()
            .flat_map(|tet| {
                EDGES_OF_TET.map(|[first, second]| sorted_pair(tet[first], tet[second]))
            })
            .chain(self.hexes.iter().flat_map(|hex| {
                EDGES_OF_HEX.map(|[first, second]| sorted_pair(hex[first], hex[second]))
            }))
            .collect();
        edges.sort_unstable();
        edges.dedup();
        let faces = self.face_node_keys();
        let first_face = self.vertex_count + edges.len();
        let first_centre = first_face + faces.len();
        let node_count = first_centre + self.hexes.len();
        if node_count > MAX_NODES {
            return Err(FemError::TooManyNodes {
                count: node_count,
                max: MAX_NODES,
            });
        }
        #[allow(
            clippy::cast_possible_truncation,
            reason = "node_count was checked against MAX_NODES above"
        )]
        let node_number = |index: usize| index as u32;
        let edge_node = |first: u32, second: u32| -> u32 {
            let index = edges
                .binary_search(&sorted_pair(first, second))
                .unwrap_or_else(|_| unreachable!("every element edge was collected"));
            node_number(self.vertex_count + index)
        };
        let face_node = |hex: &[u32; 8], face: [usize; 4]| -> u32 {
            let index = faces
                .binary_search(&sorted_face(hex, face))
                .unwrap_or_else(|_| unreachable!("every hex face was collected"));
            node_number(first_face + index)
        };
        let mut element_nodes = Vec::with_capacity(10 * self.tets.len() + 27 * self.hexes.len());
        for tet in &self.tets {
            element_nodes.extend_from_slice(tet);
            for [first, second] in EDGES_OF_TET {
                element_nodes.push(edge_node(tet[first], tet[second]));
            }
        }
        for (index, hex) in self.hexes.iter().enumerate() {
            element_nodes.extend_from_slice(hex);
            for [first, second] in EDGES_OF_HEX {
                element_nodes.push(edge_node(hex[first], hex[second]));
            }
            for (face, local) in FACES_OF_HEX.into_iter().enumerate() {
                element_nodes.push(if self.is_interface_face(index, face) {
                    NO_NODE
                } else {
                    face_node(hex, local)
                });
            }
            element_nodes.push(node_number(first_centre + index));
        }
        let mean = |corners: &[u32]| mean_point(&self.nodes, corners);
        let added: Vec<[f64; 3]> = edges
            .iter()
            .map(|edge| mean(edge))
            .chain(faces.iter().map(|face| mean(face)))
            .chain(self.hexes.iter().map(|hex| mean(hex)))
            .collect();
        let mut nodes = self.nodes;
        nodes.extend(added);
        let mut used = self.used;
        used.resize(node_count, true);
        Ok(Self {
            order: ElementOrder::Quadratic,
            nodes,
            element_nodes,
            edges,
            faces,
            used,
            ..self
        })
    }

    /// The sorted corners of every distinct hex face that gets a node at
    /// order 2, sorted: all but the interface faces, which are split between
    /// the tets beside them and the transition's pieces.
    fn face_node_keys(&self) -> Vec<[u32; 4]> {
        let mut faces: Vec<[u32; 4]> = self
            .hexes
            .iter()
            .enumerate()
            .flat_map(|(hex, corners)| {
                (0..6)
                    .filter(move |&face| !self.is_interface_face(hex, face))
                    .map(move |face| sorted_face(corners, FACES_OF_HEX[face]))
            })
            .collect();
        faces.sort_unstable();
        faces.dedup();
        faces
    }

    #[must_use]
    pub fn order(&self) -> ElementOrder {
        self.order
    }

    #[must_use]
    pub fn vertex_count(&self) -> usize {
        self.vertex_count
    }

    /// Vertices plus, for a quadratic mesh, edge, face and centre nodes, and
    /// the nodes transition elements add.
    #[must_use]
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// Unknowns of the displacement field: 3 per node.
    #[must_use]
    pub fn dof_count(&self) -> usize {
        3 * self.nodes.len()
    }

    /// Whether any element uses `node`. Added (quadratic) nodes always are.
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

    /// Node coordinates: the vertices, then the edge midpoints, face centres
    /// and hex centres.
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

    /// Sorted corner vertices of each hex face node; face k is node
    /// `vertex_count + edges().len() + k`. Empty for a linear mesh.
    #[must_use]
    pub fn faces(&self) -> &[[u32; 4]] {
        &self.faces
    }

    /// The tetrahedra: elements `0..tets().len()`.
    #[must_use]
    pub fn tets(&self) -> &[[u32; 4]] {
        &self.tets
    }

    /// The hexahedra: elements `tets().len()..element_count()`.
    #[must_use]
    pub fn hexes(&self) -> &[[u32; 8]] {
        &self.hexes
    }

    /// Tets plus hexes.
    #[must_use]
    pub fn element_count(&self) -> usize {
        self.tets.len() + self.hexes.len()
    }

    #[must_use]
    pub fn shape(&self, element: usize) -> ElementShape {
        if element < self.tets.len() {
            ElementShape::Tetrahedron
        } else {
            ElementShape::Hexahedron
        }
    }

    /// The nodes of `element`: its corners, then (quadratic) its edge nodes in
    /// [`EDGES_OF_TET`] / [`EDGES_OF_HEX`] order and, for a hex, its face
    /// nodes in [`FACES_OF_HEX`] order and its centre node. A transition hex
    /// ([`crate::transition`]) lists its corners, then the other nodes its
    /// pieces use, once each: its interface faces have no node.
    #[must_use]
    pub fn element_nodes(&self, element: usize) -> &[u32] {
        match self.split_of(element) {
            Some(split) => &split.nodes,
            None => self.layout(element),
        }
    }

    /// The corner vertices of `element`: 4 for a tet, 8 for a hex.
    #[must_use]
    pub fn element_corners(&self, element: usize) -> &[u32] {
        let corners = match self.shape(element) {
            ElementShape::Tetrahedron => 4,
            ElementShape::Hexahedron => 8,
        };
        &self.layout(element)[..corners]
    }

    /// The element's nodes in its shape's order; [`NO_NODE`] in the slot of
    /// an interface face.
    fn layout(&self, element: usize) -> &[u32] {
        let tet_nodes = ElementShape::Tetrahedron.node_count(self.order);
        let (start, count) = if element < self.tets.len() {
            (tet_nodes * element, tet_nodes)
        } else {
            let hex_nodes = ElementShape::Hexahedron.node_count(self.order);
            (
                tet_nodes * self.tets.len() + hex_nodes * (element - self.tets.len()),
                hex_nodes,
            )
        };
        &self.element_nodes[start..start + count]
    }

    /// Of a quadratic mesh: the node on edge `edge` ([`EDGES_OF_HEX`]) of
    /// hexahedron `hex`.
    pub(crate) fn hex_edge_node(&self, hex: usize, edge: usize) -> u32 {
        debug_assert_eq!(self.order, ElementOrder::Quadratic);
        self.layout(self.tets.len() + hex)[8 + edge]
    }

    /// Of a quadratic mesh: the node of face `face` ([`FACES_OF_HEX`]) of
    /// hexahedron `hex`, none for an interface face.
    pub(crate) fn hex_face_node(&self, hex: usize, face: usize) -> Option<u32> {
        debug_assert_eq!(self.order, ElementOrder::Quadratic);
        let node = self.layout(self.tets.len() + hex)[20 + face];
        (node != NO_NODE).then_some(node)
    }

    /// Of a quadratic mesh: the centre node of hexahedron `hex`.
    pub(crate) fn hex_centre_node(&self, hex: usize) -> u32 {
        debug_assert_eq!(self.order, ElementOrder::Quadratic);
        self.layout(self.tets.len() + hex)[26]
    }

    /// The nodes hexahedron `hex` has of its own (corners, and at order 2 its
    /// edge, face and centre nodes), whether or not it is split.
    pub(crate) fn own_hex_nodes(&self, hex: usize) -> impl Iterator<Item = u32> + '_ {
        self.layout(self.tets.len() + hex)
            .iter()
            .copied()
            .filter(|&node| node != NO_NODE)
    }

    /// Of a quadratic mesh: the node of the edge between two vertices, if the
    /// mesh has that edge.
    pub(crate) fn edge_node(&self, first: u32, second: u32) -> Option<u32> {
        let pair = [first.min(second), first.max(second)];
        self.edges
            .binary_search(&pair)
            .ok()
            .map(|index| index_as_u32(self.vertex_count + index))
    }

    /// Corner coordinates of tetrahedron `tet` (also element `tet`).
    #[must_use]
    pub fn corners(&self, tet: usize) -> [[f64; 3]; 4] {
        self.tets[tet].map(|vertex| self.nodes[vertex as usize])
    }

    /// Corner coordinates of hexahedron `hex` (element `tets().len() + hex`).
    #[must_use]
    pub fn hex_corners(&self, hex: usize) -> [[f64; 3]; 8] {
        self.hexes[hex].map(|vertex| self.nodes[vertex as usize])
    }

    /// The material of `element` (tets first, then hexes).
    #[must_use]
    pub fn material(&self, element: usize) -> &Isotropic {
        &self.materials[self.material_of_element[element] as usize]
    }

    /// The hex faces that meet two tet triangles, sorted by hex and face;
    /// each such hex is solved as a transition element.
    #[must_use]
    pub fn interface_faces(&self) -> &[InterfaceFace] {
        &self.interfaces
    }

    /// Whether face `face` ([`FACES_OF_HEX`] order) of hexahedron `hex` meets
    /// two tet triangles: then it is inside the body.
    #[must_use]
    pub fn is_interface_face(&self, hex: usize, face: usize) -> bool {
        self.interfaces
            .binary_search_by_key(&(hex, face), |interface| (interface.hex, interface.face))
            .is_ok()
    }

    /// Whether the tet triangle with the (sorted) corners `key` lies on an
    /// interface face: then it is inside the body.
    #[must_use]
    pub fn is_interface_triangle(&self, key: [u32; 3]) -> bool {
        self.interface_triangles.binary_search(&key).is_ok()
    }

    fn split_of(&self, element: usize) -> Option<&Split> {
        self.splits
            .binary_search_by_key(&element, |split| split.element)
            .ok()
            .map(|index| &self.splits[index])
    }

    /// The pieces `element` is solved as ([`crate::piece`]): the element
    /// itself, or the pieces of a transition element.
    #[must_use]
    pub fn pieces(&self, element: usize) -> Pieces<'_> {
        if let Some(split) = self.split_of(element) {
            Pieces(PiecesOf::Split {
                pieces: split.pieces.iter(),
                order: self.order,
            })
        } else {
            Pieces(PiecesOf::Whole {
                mesh: self,
                element: Some(element),
            })
        }
    }

    /// `element` as its own one piece.
    fn whole_piece(&self, element: usize) -> PieceRef<'_> {
        let geometry = match self.shape(element) {
            ElementShape::Tetrahedron => PieceGeometry::Tetrahedron(self.corners(element)),
            ElementShape::Hexahedron => {
                PieceGeometry::Hexahedron(self.hex_corners(element - self.tets.len()))
            }
        };
        PieceRef {
            geometry,
            nodes: self.layout(element),
            order: self.order,
            blends: &[],
        }
    }

    /// Every node a transition element adds, with the corners of its hex.
    pub fn transition_nodes(&self) -> impl Iterator<Item = (usize, &[u32; 8])> + '_ {
        self.transition_hex
            .iter()
            .enumerate()
            .map(|(index, &hex)| (self.first_transition_node + index, &self.hexes[hex]))
    }
}

/// The pieces of one element ([`TetMesh::pieces`]).
pub struct Pieces<'a>(PiecesOf<'a>);

enum PiecesOf<'a> {
    Whole {
        mesh: &'a TetMesh,
        element: Option<usize>,
    },
    Split {
        pieces: std::slice::Iter<'a, Piece>,
        order: ElementOrder,
    },
}

impl<'a> Iterator for Pieces<'a> {
    type Item = PieceRef<'a>;

    fn next(&mut self) -> Option<PieceRef<'a>> {
        match &mut self.0 {
            PiecesOf::Whole { mesh, element } => {
                element.take().map(|element| mesh.whole_piece(element))
            }
            PiecesOf::Split { pieces, order } => pieces.next().map(|piece| PieceRef {
                geometry: piece.geometry,
                nodes: &piece.nodes,
                order: *order,
                blends: &piece.blends,
            }),
        }
    }
}

/// Check that every hex names vertices and a material that exist, and has
/// volume; `material_of_hex` holds the hexes' material indices.
fn check_hexes(
    points: &[[f64; 3]],
    hex_elements: &[[u32; 8]],
    material_of_hex: &[u32],
    material_count: usize,
) -> Result<(), FemError> {
    for (hex, ids) in hex_elements.iter().enumerate() {
        if let Some(&vertex) = ids.iter().find(|&&vertex| vertex as usize >= points.len()) {
            return Err(FemError::HexVertexOutOfRange {
                hex,
                vertex,
                count: points.len(),
            });
        }
        let material = material_of_hex[hex];
        if material as usize >= material_count {
            return Err(FemError::HexMaterialOutOfRange {
                hex,
                material,
                count: material_count,
            });
        }
        if !hex_is_valid(
            &ids.map(|vertex| points[vertex as usize]),
            ElementOrder::Linear,
        ) {
            return Err(FemError::DegenerateHex { hex });
        }
    }
    Ok(())
}

/// The corners `face` of `hex`, sorted.
fn sorted_face(hex: &[u32; 8], face: [usize; 4]) -> [u32; 4] {
    let mut key = face.map(|corner| hex[corner]);
    key.sort_unstable();
    key
}

/// Both triangles of every interface face, each sorted, the list sorted.
fn sorted_triangles(interfaces: &[InterfaceFace], hexes: &[[u32; 8]]) -> Vec<[u32; 3]> {
    let mut triangles: Vec<[u32; 3]> = interfaces
        .iter()
        .flat_map(|interface| interface.triangles(&hexes[interface.hex]))
        .map(|mut triangle| {
            triangle.sort_unstable();
            triangle
        })
        .collect();
    triangles.sort_unstable();
    triangles
}

/// The layout slot of a hex face without a node: an interface face, which
/// the tets beside it and the transition's pieces split.
const NO_NODE: u32 = u32::MAX;

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
/// cube of its longest edge (or diagonal), so the test is independent of the
/// model's units.
fn degenerate_volume(corners: &[[f64; 3]]) -> f64 {
    let mut longest: f64 = 0.0;
    for (first, from) in corners.iter().enumerate() {
        for to in &corners[first + 1..] {
            let edge = sub(*to, *from);
            longest = longest.max(dot(edge, edge).sqrt());
        }
    }
    1e-12 * longest.powi(3)
}

/// Mean of the points `corners` index: where the trilinear map of a straight
/// edge, a face or a hex puts its midpoint or centre.
fn mean_point(points: &[[f64; 3]], corners: &[u32]) -> [f64; 3] {
    let mut sum = [0.0; 3];
    for &vertex in corners {
        for (axis, total) in sum.iter_mut().enumerate() {
            *total += points[vertex as usize][axis];
        }
    }
    let count = count_as_f64(corners.len());
    sum.map(|total| total / count)
}

/// Whether a hex can be integrated at `order`: the Jacobian of its trilinear
/// map has one sign, and is not vanishingly small, at every point the element
/// is evaluated at — the Gauss points of its stiffness rule and the centre,
/// where its stress is recovered. Either sign is accepted (a mirrored hex is
/// valid). Corners are not checked: a wedge written as a hex with a collapsed
/// edge, or a hex with a slightly non-convex face, has a vanishing or turned
/// Jacobian only there, and integrates (in MFEM too) like any other element.
fn hex_is_valid(corners: &[[f64; 3]; 8], order: ElementOrder) -> bool {
    let threshold = degenerate_volume(corners);
    let mut signs = [0_i8; 2];
    let points_per_axis = match order {
        ElementOrder::Linear => HEX8_RULE_POINTS,
        ElementOrder::Quadratic => HEX27_RULE_POINTS,
    };
    let rule = cube_rule(points_per_axis);
    let centre = [0.5; 3];
    for point in rule
        .iter()
        .map(|(point, _)| *point)
        .chain(std::iter::once(centre))
    {
        let jacobian = hex_jacobian(corners, &hex8_reference_gradients(point));
        let det = determinant(&jacobian);
        if det.abs() <= threshold {
            return false;
        }
        signs[usize::from(det > 0.0)] = 1;
    }
    signs[0] + signs[1] == 1
}

pub(crate) fn determinant(matrix: &[[f64; 3]; 3]) -> f64 {
    dot(matrix[0], cross(matrix[1], matrix[2]))
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

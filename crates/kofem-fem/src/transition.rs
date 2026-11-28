// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Hex/tet transitions (KOF-433). Where a hexahedron's face meets two
//! tetrahedron triangles that share its four corners, split along one of its
//! diagonals, the two sides do not share a face: the hex's field on it is
//! bilinear (biquadratic), the tets' linear (quadratic) on each triangle. The
//! displacement jumps inside the face, and a constant stress already puts
//! spurious forces on its corners, so the mesh fails the patch test.
//!
//! Tying the two sides together does not cure it: the corners are shared, so
//! a tie can only force each interface quad to be affine, which removes its
//! twist mode and locks the interface — a stiffening of the order of 1 % in
//! bending and torsion that does not shrink under refinement.
//!
//! Such a hex is solved as a transition element instead: a pyramid on each
//! of its other faces, written as a hexahedron whose four top corners meet at
//! the apex, and two tetrahedra on each interface face, split as the tets
//! beside it are, all meeting at the hex centre. A collapsed hex's field is
//! bilinear (biquadratic) on its base, matching the next hex, and linear on
//! its side triangles, matching a tet; on a quadratic mesh the centre of a
//! side triangle a pyramid shares with a tet is blended to the tet's
//! quadratic field there ([`crate::piece`]). Every piece reproduces a linear
//! (quadratic) field, so the transition is conforming, passes the patch test
//! and converges. The hex keeps its number, its material and its result; its
//! centre (the apex) and, on a quadratic mesh, the nodes inside it are added
//! nodes, after the vertices, as the edge and face nodes of a quadratic mesh
//! are.

use std::collections::HashMap;

use crate::count::{count_as_f64, index_as_u32};
use crate::error::FemError;
use crate::mesh::{local_hex_edge, ElementOrder, TetMesh, EDGES_OF_HEX, FACES_OF_HEX};
use crate::piece::{Blend, Piece, PieceGeometry};

/// Which diagonal of a hex face the tets split it along, by the positions in
/// the face's corner cycle ([`FACES_OF_HEX`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Diagonal {
    /// Corners 0 and 2 of the cycle.
    ZeroTwo,
    /// Corners 1 and 3 of the cycle.
    OneThree,
}

/// A hex face that meets two tet triangles: hexahedron `hex` (counted among
/// the hexahedra), its face `face` in [`FACES_OF_HEX`] order, and the diagonal
/// the triangles split it along.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InterfaceFace {
    pub hex: usize,
    pub face: usize,
    pub diagonal: Diagonal,
}

impl InterfaceFace {
    /// The two triangles of the face, as hex corners in cycle order.
    #[must_use]
    pub fn triangles(&self, hex: &[u32; 8]) -> [[u32; 3]; 2] {
        let [first, second, third, fourth] = FACES_OF_HEX[self.face].map(|corner| hex[corner]);
        match self.diagonal {
            Diagonal::ZeroTwo => [[first, second, third], [first, third, fourth]],
            Diagonal::OneThree => [[second, third, fourth], [second, fourth, first]],
        }
    }
}

fn sorted<const N: usize>(mut vertices: [u32; N]) -> [u32; N] {
    vertices.sort_unstable();
    vertices
}

/// The faces of `hexes` that meet two triangles of `tets` (see the module
/// notes), sorted by hex and face. A face counts when no other hex shares
/// it and both triangles of one of its diagonals are faces of exactly one
/// tet each.
///
/// # Errors
/// [`FemError::PartialHexTetInterface`] for a hex face that meets tets on
/// one half only, or on triangles of both diagonals.
pub fn find_interface_faces(
    tets: &[[u32; 4]],
    hexes: &[[u32; 8]],
) -> Result<Vec<InterfaceFace>, FemError> {
    if tets.is_empty() || hexes.is_empty() {
        return Ok(Vec::new());
    }
    let mut triangles: Vec<[u32; 3]> = tets
        .iter()
        .flat_map(|tet| {
            [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]]
                .map(|face| sorted(face.map(|corner| tet[corner])))
        })
        .collect();
    triangles.sort_unstable();
    let outer_triangles = singles(&triangles);
    let mut quads: HashMap<[u32; 4], usize> = HashMap::new();
    for hex in hexes {
        for face in FACES_OF_HEX {
            *quads
                .entry(sorted(face.map(|corner| hex[corner])))
                .or_default() += 1;
        }
    }
    let on_tets = |triangle: [u32; 3]| outer_triangles.binary_search(&sorted(triangle)).is_ok();
    let mut found = Vec::new();
    for (index, hex) in hexes.iter().enumerate() {
        for (face, local) in FACES_OF_HEX.iter().enumerate() {
            if quads[&sorted(local.map(|corner| hex[corner]))] != 1 {
                continue;
            }
            let count = |diagonal: Diagonal| {
                InterfaceFace {
                    hex: index,
                    face,
                    diagonal,
                }
                .triangles(hex)
                .into_iter()
                .filter(|&triangle| on_tets(triangle))
                .count()
            };
            let along = [Diagonal::ZeroTwo, Diagonal::OneThree].map(count);
            let diagonal = match along {
                [0, 0] => continue,
                [2, 0] => Diagonal::ZeroTwo,
                [0, 2] => Diagonal::OneThree,
                [first, second] => {
                    return Err(FemError::PartialHexTetInterface {
                        hex: index,
                        face,
                        triangles: first + second,
                    })
                }
            };
            found.push(InterfaceFace {
                hex: index,
                face,
                diagonal,
            });
        }
    }
    Ok(found)
}

/// The entries of a sorted list that occur exactly once.
fn singles<T: PartialEq + Copy>(sorted: &[T]) -> Vec<T> {
    let mut kept = Vec::new();
    let mut index = 0;
    while index < sorted.len() {
        let mut end = index + 1;
        while end < sorted.len() && sorted[end] == sorted[index] {
            end += 1;
        }
        if end == index + 1 {
            kept.push(sorted[index]);
        }
        index = end;
    }
    kept
}

/// One hex solved as a transition element: its pieces, and every node its
/// field uses (its own nodes first, then the added ones).
#[derive(Debug, Clone)]
pub(crate) struct Split {
    pub(crate) element: usize,
    pub(crate) nodes: Vec<u32>,
    pub(crate) pieces: Vec<Piece>,
}

/// What [`split_hexes`] adds to a mesh.
pub(crate) struct Transitions {
    /// One per hex with an interface face, sorted by element.
    pub(crate) splits: Vec<Split>,
    /// Coordinates of the added nodes, numbered from the `first_node` given.
    pub(crate) added: Vec<[f64; 3]>,
    /// The hexahedron (counted among the hexahedra) each added node is in.
    pub(crate) added_in: Vec<usize>,
}

/// The faces of [`FACES_OF_HEX`] holding each edge of [`EDGES_OF_HEX`].
fn faces_of_edge(edge: usize) -> [usize; 2] {
    let [first, second] = EDGES_OF_HEX[edge];
    let mut faces = (0..6).filter(|&face| {
        FACES_OF_HEX[face].contains(&first) && FACES_OF_HEX[face].contains(&second)
    });
    let pair = [faces.next(), faces.next()];
    match pair {
        [Some(one), Some(other)] => [one, other],
        _ => unreachable!("every hex edge lies on two faces"),
    }
}

fn mean(points: &[[f64; 3]]) -> [f64; 3] {
    let count = count_as_f64(points.len());
    std::array::from_fn(|axis| points.iter().map(|point| point[axis]).sum::<f64>() / count)
}

/// Split every hex with an interface face into its pieces (module notes),
/// numbering the nodes it adds from `first_node`.
pub(crate) fn split_hexes(
    interfaces: &[InterfaceFace],
    mesh: &TetMesh,
    first_node: usize,
) -> Transitions {
    let mut transitions = Transitions {
        splits: Vec::new(),
        added: Vec::new(),
        added_in: Vec::new(),
    };
    let mut start = 0;
    while start < interfaces.len() {
        let hex = interfaces[start].hex;
        let mut end = start;
        let mut interface: [Option<Diagonal>; 6] = [None; 6];
        while end < interfaces.len() && interfaces[end].hex == hex {
            interface[interfaces[end].face] = Some(interfaces[end].diagonal);
            end += 1;
        }
        let split = split_one(hex, interface, mesh, first_node, &mut transitions);
        transitions.splits.push(split);
        start = end;
    }
    transitions
}

/// One transition hex while its pieces are built: its nodes, its apex and,
/// on a quadratic mesh, the nodes added inside it.
struct HexInside<'mesh> {
    mesh: &'mesh TetMesh,
    hex: usize,
    corners: [u32; 8],
    corner_points: [[f64; 3]; 8],
    apex: u32,
    apex_point: [f64; 3],
    /// Quadratic: the node halfway from each corner to the apex.
    riser: [u32; 8],
    /// Quadratic: the centre of the side triangle over each hex edge, when
    /// two pyramids share it.
    side: [Option<u32>; 12],
    /// Quadratic: the centre of the pyramid on each face without an
    /// interface.
    pyramid_centre: [Option<u32>; 6],
}

impl HexInside<'_> {
    fn quadratic(&self) -> bool {
        self.mesh.order() == ElementOrder::Quadratic
    }

    fn hex_edge_node(&self, first: usize, second: usize) -> u32 {
        self.mesh
            .hex_edge_node(self.hex, local_hex_edge(first, second))
    }

    /// The edge node between hex corners `first` and `second`: the hex's own
    /// on a hex edge, the tets' on the face diagonal they split along.
    fn edge_node(&self, first: usize, second: usize) -> u32 {
        if EDGES_OF_HEX.contains(&[first.min(second), first.max(second)]) {
            self.hex_edge_node(first, second)
        } else {
            self.mesh
                .edge_node(self.corners[first], self.corners[second])
                .unwrap_or_else(|| {
                    unreachable!("an interface diagonal is an edge of the tets beside it")
                })
        }
    }

    /// The tet over hex corners `local` (one half of an interface face) and
    /// the apex.
    fn tet(&self, local: [usize; 3]) -> Piece {
        let mut nodes: Vec<u32> = local.iter().map(|&corner| self.corners[corner]).collect();
        nodes.push(self.apex);
        if self.quadratic() {
            // EDGES_OF_TET of (first, second, third, apex): 01, 02, 03, 12,
            // 13, 23.
            let [first, second, third] = local;
            nodes.extend([
                self.edge_node(first, second),
                self.edge_node(first, third),
                self.riser[first],
                self.edge_node(second, third),
                self.riser[second],
                self.riser[third],
            ]);
        }
        Piece {
            geometry: PieceGeometry::Tetrahedron([
                self.corner_points[local[0]],
                self.corner_points[local[1]],
                self.corner_points[local[2]],
                self.apex_point,
            ]),
            nodes,
            blends: Vec::new(),
        }
    }

    /// The pyramid on face `face`, as a hex whose top corners meet at the
    /// apex.
    fn pyramid(&self, face: usize) -> Piece {
        let cycle = FACES_OF_HEX[face];
        // The base in inward order, so the apex lies above it.
        let base = [cycle[0], cycle[3], cycle[2], cycle[1]];
        let mut nodes: Vec<u32> = base.iter().map(|&corner| self.corners[corner]).collect();
        nodes.extend([self.apex; 4]);
        let mut blends = Vec::new();
        if self.quadratic() {
            // EDGES_OF_HEX of the piece: the base edges 01, 12, 23, 03, the
            // collapsed top edges, then the risers.
            nodes.extend([
                self.hex_edge_node(base[0], base[1]),
                self.hex_edge_node(base[1], base[2]),
                self.hex_edge_node(base[2], base[3]),
                self.hex_edge_node(base[0], base[3]),
            ]);
            nodes.extend([self.apex; 4]);
            nodes.extend(base.map(|corner| self.riser[corner]));
            // FACES_OF_HEX of the piece: the base, the collapsed top, then the
            // side over base corners (k, k + 1).
            nodes.push(
                self.mesh
                    .hex_face_node(self.hex, face)
                    .unwrap_or_else(|| unreachable!("a face without an interface has a face node")),
            );
            nodes.push(self.apex);
            for k in 0..4 {
                let edge = local_hex_edge(base[k], base[(k + 1) % 4]);
                if let Some(node) = self.side[edge] {
                    nodes.push(node);
                } else {
                    // Shared with a tet: its quadratic field at the
                    // triangle's centre (¼, ¼, ½), from the corners −⅛ each,
                    // the base edge ¼ and the risers ½ each.
                    nodes.push(self.apex);
                    blends.push(Blend {
                        slot: 22 + k,
                        sources: vec![
                            (k, -0.125),
                            ((k + 1) % 4, -0.125),
                            (8 + k, 0.25),
                            (16 + k, 0.5),
                            (16 + (k + 1) % 4, 0.5),
                        ],
                    });
                }
            }
            nodes.push(self.pyramid_centre[face].unwrap_or_else(|| {
                unreachable!("every face without an interface has a pyramid centre")
            }));
        }
        let base_points = base.map(|corner| self.corner_points[corner]);
        Piece {
            geometry: PieceGeometry::Hexahedron([
                base_points[0],
                base_points[1],
                base_points[2],
                base_points[3],
                self.apex_point,
                self.apex_point,
                self.apex_point,
                self.apex_point,
            ]),
            nodes,
            blends,
        }
    }
}

/// Add the apex and (quadratic) the nodes inside transition hex `hex` to
/// `out`, numbered from `first_node`.
fn hex_inside<'mesh>(
    hex: usize,
    interface: [Option<Diagonal>; 6],
    mesh: &'mesh TetMesh,
    first_node: usize,
    out: &mut Transitions,
) -> HexInside<'mesh> {
    let corners = mesh.hexes()[hex];
    let points = mesh.node_coordinates();
    let corner_points = corners.map(|vertex| points[vertex as usize]);
    let mut add = |at: [f64; 3]| -> u32 {
        let node = index_as_u32(first_node + out.added.len());
        out.added.push(at);
        out.added_in.push(hex);
        node
    };
    let quadratic = mesh.order() == ElementOrder::Quadratic;
    let (apex, apex_point) = if quadratic {
        let centre = mesh.hex_centre_node(hex);
        (centre, points[centre as usize])
    } else {
        let centre = mean(&corner_points);
        (add(centre), centre)
    };
    let mut inside = HexInside {
        mesh,
        hex,
        corners,
        corner_points,
        apex,
        apex_point,
        riser: [apex; 8],
        side: [None; 12],
        pyramid_centre: [None; 6],
    };
    if quadratic {
        for (corner, riser) in inside.riser.iter_mut().enumerate() {
            *riser = add(mean(&[corner_points[corner], apex_point]));
        }
        for (edge, side) in inside.side.iter_mut().enumerate() {
            if faces_of_edge(edge)
                .iter()
                .all(|&face| interface[face].is_none())
            {
                let [first, second] = EDGES_OF_HEX[edge];
                *side = Some(add(mean(&[
                    corner_points[first],
                    corner_points[second],
                    apex_point,
                    apex_point,
                ])));
            }
        }
        for (face, centre) in inside.pyramid_centre.iter_mut().enumerate() {
            if interface[face].is_none() {
                let base = FACES_OF_HEX[face].map(|corner| corner_points[corner]);
                *centre = Some(add(mean(&[mean(&base), apex_point])));
            }
        }
    }
    inside
}

fn split_one(
    hex: usize,
    interface: [Option<Diagonal>; 6],
    mesh: &TetMesh,
    first_node: usize,
    out: &mut Transitions,
) -> Split {
    let inside = hex_inside(hex, interface, mesh, first_node, out);
    let mut pieces = Vec::new();
    for (face, diagonal) in interface.iter().enumerate() {
        if let Some(diagonal) = diagonal {
            let [first, second, third, fourth] = FACES_OF_HEX[face];
            let halves = match diagonal {
                Diagonal::ZeroTwo => [[first, second, third], [first, third, fourth]],
                Diagonal::OneThree => [[second, third, fourth], [second, fourth, first]],
            };
            pieces.extend(halves.map(|half| inside.tet(half)));
        } else {
            pieces.push(inside.pyramid(face));
        }
    }
    let mut nodes: Vec<u32> = Vec::new();
    for node in mesh
        .own_hex_nodes(hex)
        .chain(pieces.iter().flat_map(|piece| piece.nodes.iter().copied()))
    {
        if !nodes.contains(&node) {
            nodes.push(node);
        }
    }
    Split {
        element: mesh.tets().len() + hex,
        nodes,
        pieces,
    }
}

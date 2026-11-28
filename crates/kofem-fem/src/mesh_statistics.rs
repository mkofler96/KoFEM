// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Per-body mesh statistics (KOF-497): mean element edge length, volume, mass.
//!
//! Each distinct edge counts once per body, however many of its elements share
//! it. Volumes and edges are taken from the corners: the solver's quadratic
//! elements are subparametric, so they have the geometry of their corners.

use std::collections::{BTreeMap, BTreeSet};

use crate::count::count_as_f64;
use crate::element::{cube_rule, hex8_reference_gradients, hex_jacobian};
use crate::error::FemError;
use crate::mesh::{cross, determinant, dot, sub, EDGES_OF_HEX, EDGES_OF_TET};

/// The elements of a mesh and the body each belongs to.
#[derive(Debug, Clone, Copy)]
pub struct BodyMesh<'a> {
    /// Node coordinates, x, y, z per node.
    pub points: &'a [f64],
    /// `tet_nodes` nodes per tetrahedron, its four corners first.
    pub tets: &'a [u32],
    /// 4 for linear, 10 for quadratic tetrahedra.
    pub tet_nodes: usize,
    /// `hex_nodes` nodes per hexahedron, its eight corners first in CHEXA
    /// order (the bottom face, then the top face).
    pub hexes: &'a [u32],
    /// 8 for linear, 27 for quadratic hexahedra.
    pub hex_nodes: usize,
    /// Three nodes per shell facet.
    pub shell_triangles: &'a [u32],
    /// One wall thickness per shell facet: its volume is area × thickness.
    pub shell_thicknesses: &'a [f64],
    /// The body of each element: tetrahedra, then hexahedra, then facets.
    pub bodies: &'a [u32],
}

/// One body's numbers. `mass` is `None` when the body has no density.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BodyStatistics {
    pub body: u32,
    pub elements: usize,
    pub mean_edge_length: f64,
    pub volume: f64,
    pub mass: Option<f64>,
}

#[derive(Default)]
struct Totals {
    elements: usize,
    volume: f64,
    edges: BTreeSet<[u32; 2]>,
}

/// Local corner pairs of a shell facet's three edges.
const FACET_EDGES: [[usize; 2]; 3] = [[0, 1], [1, 2], [0, 2]];

fn invalid(reason: String) -> FemError {
    FemError::MeshStatisticsInput { reason }
}

/// The numbers of every body with elements in `mesh`, by body id. A body's
/// mass is its volume times its entry in `densities` (body, density); a body
/// without an entry has no mass.
///
/// # Errors
/// [`FemError::MeshStatisticsInput`] for an unsupported node count, a
/// connectivity that is not whole elements or names a missing node, a body or
/// thickness count that does not match the elements, a density that is not
/// positive and finite, or a body given two densities.
pub fn body_statistics(
    mesh: &BodyMesh,
    densities: &[(u32, f64)],
) -> Result<Vec<BodyStatistics>, FemError> {
    let density_of = check_densities(densities)?;
    let points = check_points(mesh.points)?;
    let tets = elements(
        "tetrahedra",
        mesh.tets,
        mesh.tet_nodes,
        &[4, 10],
        points.len(),
    )?;
    let hexes = elements(
        "hexahedra",
        mesh.hexes,
        mesh.hex_nodes,
        &[8, 27],
        points.len(),
    )?;
    let facets = elements("shell facets", mesh.shell_triangles, 3, &[3], points.len())?;
    if mesh.shell_thicknesses.len() != facets.len() {
        return Err(invalid(format!(
            "{} shell facets but {} thicknesses",
            facets.len(),
            mesh.shell_thicknesses.len()
        )));
    }
    let count = tets.len() + hexes.len() + facets.len();
    if mesh.bodies.len() != count {
        return Err(invalid(format!(
            "{count} elements but {} body ids",
            mesh.bodies.len()
        )));
    }

    let (tet_bodies, rest) = mesh.bodies.split_at(tets.len());
    let (hex_bodies, facet_bodies) = rest.split_at(hexes.len());
    let mut bodies: BTreeMap<u32, Totals> = BTreeMap::new();
    let mut add = |body: u32, corners: &[u32], edges: &[[usize; 2]], volume: f64| {
        let totals = bodies.entry(body).or_default();
        totals.elements += 1;
        totals.volume += volume;
        for &[first, second] in edges {
            let (from, to) = (corners[first], corners[second]);
            totals.edges.insert([from.min(to), from.max(to)]);
        }
    };
    for (tet, &body) in tets.iter().zip(tet_bodies) {
        let corners = &tet[..4];
        let volume = tet_volume(&corner_points(&points, corners));
        add(body, corners, &EDGES_OF_TET, volume);
    }
    for (hex, &body) in hexes.iter().zip(hex_bodies) {
        let corners = &hex[..8];
        let volume = hex_volume(&corner_points(&points, corners));
        add(body, corners, &EDGES_OF_HEX, volume);
    }
    for ((facet, &thickness), &body) in facets.iter().zip(mesh.shell_thicknesses).zip(facet_bodies)
    {
        if !(thickness.is_finite() && thickness > 0.0) {
            return Err(invalid(format!(
                "a shell thickness must be positive, not {thickness}"
            )));
        }
        let area = triangle_area(&corner_points(&points, facet));
        add(body, facet, &FACET_EDGES, area * thickness);
    }

    Ok(bodies
        .into_iter()
        .map(|(body, totals)| {
            let length: f64 = totals
                .edges
                .iter()
                .map(|&[from, to]| {
                    let edge = sub(points[to as usize], points[from as usize]);
                    dot(edge, edge).sqrt()
                })
                .sum();
            BodyStatistics {
                body,
                elements: totals.elements,
                mean_edge_length: length / count_as_f64(totals.edges.len()),
                volume: totals.volume,
                mass: density_of.get(&body).map(|density| density * totals.volume),
            }
        })
        .collect())
}

fn check_densities(densities: &[(u32, f64)]) -> Result<BTreeMap<u32, f64>, FemError> {
    let mut by_body = BTreeMap::new();
    for &(body, density) in densities {
        if !(density.is_finite() && density > 0.0) {
            return Err(invalid(format!(
                "body {body}: a density must be positive, not {density}"
            )));
        }
        if by_body.insert(body, density).is_some() {
            return Err(invalid(format!("body {body} is given a density twice")));
        }
    }
    Ok(by_body)
}

fn check_points(points: &[f64]) -> Result<Vec<[f64; 3]>, FemError> {
    if !points.len().is_multiple_of(3) {
        return Err(invalid(format!(
            "{} node coordinates are not three per node",
            points.len()
        )));
    }
    Ok(points.as_chunks::<3>().0.to_vec())
}

fn elements<'a>(
    what: &str,
    nodes: &'a [u32],
    per_element: usize,
    supported: &[usize],
    node_count: usize,
) -> Result<Vec<&'a [u32]>, FemError> {
    if !supported.contains(&per_element) {
        let options: Vec<String> = supported.iter().map(ToString::to_string).collect();
        return Err(invalid(format!(
            "{what} have {} nodes each, not {per_element}",
            options.join(" or ")
        )));
    }
    if !nodes.len().is_multiple_of(per_element) {
        return Err(invalid(format!(
            "{} {what} nodes are not {per_element} per element",
            nodes.len()
        )));
    }
    if let Some(&node) = nodes.iter().find(|&&node| node as usize >= node_count) {
        return Err(invalid(format!(
            "{what} name node {node}, but the mesh has {node_count} nodes"
        )));
    }
    Ok(nodes.chunks_exact(per_element).collect())
}

fn corner_points<const N: usize>(points: &[[f64; 3]], corners: &[u32]) -> [[f64; 3]; N] {
    std::array::from_fn(|corner| points[corners[corner] as usize])
}

fn tet_volume(corners: &[[f64; 3]; 4]) -> f64 {
    let [origin, first, second, third] = *corners;
    dot(
        sub(first, origin),
        cross(sub(second, origin), sub(third, origin)),
    )
    .abs()
        / 6.0
}

/// The trilinear map's Jacobian determinant is of degree two in each
/// reference coordinate, so two Gauss points per axis integrate it exactly.
fn hex_volume(corners: &[[f64; 3]; 8]) -> f64 {
    cube_rule(2)
        .iter()
        .map(|&(point, weight)| {
            weight * determinant(&hex_jacobian(corners, &hex8_reference_gradients(point)))
        })
        .sum::<f64>()
        .abs()
}

fn triangle_area(corners: &[[f64; 3]; 3]) -> f64 {
    let [origin, first, second] = *corners;
    let normal = cross(sub(first, origin), sub(second, origin));
    dot(normal, normal).sqrt() / 2.0
}

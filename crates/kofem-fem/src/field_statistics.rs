// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Volume-weighted percentiles of a nodal result field (KOF-477).
//!
//! The peak of a stress field often sits at a singularity — an idealised
//! support, a point load, a re-entrant corner — and grows as the mesh is
//! refined there. A high percentile is what a part is judged on instead. It is
//! taken by volume, not by node count, so the mesh grading that crowds nodes
//! into a notch does not drag the percentile towards the peak: each element's
//! volume is shared equally among its nodes, and the q-percentile is the lowest
//! nodal value with at least the share q of the volume at or below it.

use crate::error::FemError;
use crate::mesh::{cross, dot, sub};

/// The model: node coordinates (x, y, z per node), one field value per node,
/// and the element connectivities by node index.
#[derive(Debug, Clone, Copy)]
pub struct StatisticsMesh<'a> {
    pub points: &'a [f64],
    pub values: &'a [f64],
    /// `tet_nodes` nodes per tetrahedron, the four corners first.
    pub tets: &'a [u32],
    /// 4 for linear, 10 for quadratic tetrahedra; the volume is that of the
    /// straight-sided tetrahedron on the corners.
    pub tet_nodes: usize,
    /// Eight nodes per hexahedron, bottom face then top face.
    pub hexes: &'a [u32],
    /// Three nodes per shell facet.
    pub shell_triangles: &'a [u32],
    /// One wall thickness per shell facet: a facet's volume is its area times
    /// its thickness, so shells and solids of a mixed model weigh alike.
    pub shell_thicknesses: &'a [f64],
}

/// A hexahedron (CHEXA corner order) as six tetrahedra about its 0–6 diagonal.
const HEX_TETS: [[usize; 4]; 6] = [
    [0, 1, 2, 6],
    [0, 2, 3, 6],
    [0, 3, 7, 6],
    [0, 7, 4, 6],
    [0, 4, 5, 6],
    [0, 5, 1, 6],
];

/// Summing many small weights does not reproduce their total exactly; a share
/// that ties a quantile exactly must not fall just short of it.
const SHARE_TOLERANCE: f64 = 1e-12;

fn invalid(reason: String) -> FemError {
    FemError::StatisticsInput { reason }
}

fn point(points: &[f64], node: u32) -> [f64; 3] {
    let at = 3 * node as usize;
    [points[at], points[at + 1], points[at + 2]]
}

fn tet_volume(corners: [[f64; 3]; 4]) -> f64 {
    let [origin, first, second, third] = corners;
    dot(
        sub(first, origin),
        cross(sub(second, origin), sub(third, origin)),
    )
    .abs()
        / 6.0
}

fn triangle_area(corners: [[f64; 3]; 3]) -> f64 {
    let [origin, first, second] = corners;
    let normal = cross(sub(first, origin), sub(second, origin));
    dot(normal, normal).sqrt() / 2.0
}

fn check_connectivity(
    what: &str,
    nodes: &[u32],
    per_element: usize,
    node_count: usize,
) -> Result<(), FemError> {
    if !nodes.len().is_multiple_of(per_element) {
        return Err(invalid(format!(
            "{what} array has {} indices, which is not a multiple of {per_element}",
            nodes.len()
        )));
    }
    if let Some(&node) = nodes.iter().find(|&&node| node as usize >= node_count) {
        return Err(invalid(format!(
            "a {what} references node {node}, but the model has {node_count} nodes"
        )));
    }
    Ok(())
}

/// Each node's share of the model's volume.
fn nodal_volumes(mesh: &StatisticsMesh<'_>, node_count: usize) -> Vec<f64> {
    let points = mesh.points;
    let mut weights = vec![0.0; node_count];
    let mut share = |nodes: &[u32], per_element: f64, volume: f64| {
        for &node in nodes {
            weights[node as usize] += volume / per_element;
        }
    };
    let tet_nodes = if mesh.tet_nodes == 4 { 4.0 } else { 10.0 };
    for tet in mesh.tets.chunks_exact(mesh.tet_nodes) {
        let corners = [0, 1, 2, 3].map(|k| point(points, tet[k]));
        share(tet, tet_nodes, tet_volume(corners));
    }
    for hex in mesh.hexes.as_chunks::<8>().0 {
        let volume = HEX_TETS
            .iter()
            .map(|tet| tet_volume(tet.map(|k| point(points, hex[k]))))
            .sum();
        share(hex, 8.0, volume);
    }
    for (facet, &thickness) in mesh
        .shell_triangles
        .as_chunks::<3>()
        .0
        .iter()
        .zip(mesh.shell_thicknesses)
    {
        let corners = [0, 1, 2].map(|k| point(points, facet[k]));
        share(facet, 3.0, triangle_area(corners) * thickness);
    }
    weights
}

/// The volume-weighted `quantiles` (each in [0, 1]) of the nodal field, in
/// the order asked. Nodes no element uses carry no volume and are left out.
///
/// # Errors
/// [`FemError::StatisticsInput`] for a quantile outside [0, 1], coordinates
/// not in triples or not finite, a value count that differs from the node count, a
/// non-finite value, a connectivity with a ragged length or an unknown node,
/// a tetrahedron size other than 4 or 10, a thickness count that differs from
/// the facet count or a thickness that is not positive, or a model without
/// volume.
pub fn nodal_percentiles(
    mesh: &StatisticsMesh<'_>,
    quantiles: &[f64],
) -> Result<Vec<f64>, FemError> {
    if let Some(quantile) = quantiles
        .iter()
        .find(|quantile| !(0.0..=1.0).contains(*quantile))
    {
        return Err(invalid(format!(
            "a quantile must lie in [0, 1], got {quantile}"
        )));
    }
    if !mesh.points.len().is_multiple_of(3) {
        return Err(invalid(format!(
            "{} coordinates, which is not a multiple of 3",
            mesh.points.len()
        )));
    }
    if let Some(at) = mesh
        .points
        .iter()
        .position(|coordinate| !coordinate.is_finite())
    {
        return Err(invalid(format!(
            "node {} has a non-finite coordinate",
            at / 3
        )));
    }
    let node_count = mesh.points.len() / 3;
    if mesh.values.len() != node_count {
        return Err(invalid(format!(
            "{} values for {node_count} nodes",
            mesh.values.len()
        )));
    }
    if let Some(node) = mesh.values.iter().position(|value| !value.is_finite()) {
        return Err(invalid(format!(
            "node {node} has the non-finite value {}",
            mesh.values[node]
        )));
    }
    if mesh.tet_nodes != 4 && mesh.tet_nodes != 10 {
        return Err(invalid(format!(
            "a tetrahedron has 4 or 10 nodes, got {}",
            mesh.tet_nodes
        )));
    }
    check_connectivity("tetrahedron", mesh.tets, mesh.tet_nodes, node_count)?;
    check_connectivity("hexahedron", mesh.hexes, 8, node_count)?;
    check_connectivity("shell facet", mesh.shell_triangles, 3, node_count)?;
    let facets = mesh.shell_triangles.len() / 3;
    if mesh.shell_thicknesses.len() != facets {
        return Err(invalid(format!(
            "{} shell thicknesses for {facets} shell facets",
            mesh.shell_thicknesses.len()
        )));
    }
    if let Some(thickness) = mesh
        .shell_thicknesses
        .iter()
        .find(|thickness| thickness.is_nan() || **thickness <= 0.0)
    {
        return Err(invalid(format!(
            "a shell thickness must be positive, got {thickness}"
        )));
    }

    let weights = nodal_volumes(mesh, node_count);
    let mut order: Vec<usize> = (0..node_count).filter(|&n| weights[n] > 0.0).collect();
    order.sort_by(|&lhs, &rhs| mesh.values[lhs].total_cmp(&mesh.values[rhs]));
    let total: f64 = order.iter().map(|&n| weights[n]).sum();
    if total <= 0.0 {
        return Err(invalid("the model has no volume".to_owned()));
    }
    let mut cumulative = Vec::with_capacity(order.len());
    let mut running = 0.0;
    for &n in &order {
        running += weights[n];
        cumulative.push(running);
    }
    Ok(quantiles
        .iter()
        .map(|&quantile| {
            let target = (quantile - SHARE_TOLERANCE) * total;
            let at = cumulative.partition_point(|&share| share < target);
            mesh.values[order[at.min(order.len() - 1)]]
        })
        .collect())
}

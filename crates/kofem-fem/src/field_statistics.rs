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

/// The elements of a model without a field: node coordinates (x, y, z per
/// node) and the element connectivities by node index, as in
/// [`StatisticsMesh`].
#[derive(Debug, Clone, Copy)]
pub struct ElementMesh<'a> {
    pub points: &'a [f64],
    pub tets: &'a [u32],
    pub tet_nodes: usize,
    pub hexes: &'a [u32],
    pub shell_triangles: &'a [u32],
    pub shell_thicknesses: &'a [f64],
}

impl<'a> StatisticsMesh<'a> {
    fn elements(&self) -> ElementMesh<'a> {
        ElementMesh {
            points: self.points,
            tets: self.tets,
            tet_nodes: self.tet_nodes,
            hexes: self.hexes,
            shell_triangles: self.shell_triangles,
            shell_thicknesses: self.shell_thicknesses,
        }
    }
}

impl ElementMesh<'_> {
    fn element_count(&self) -> usize {
        self.tets.len() / self.tet_nodes + self.hexes.len() / 8 + self.shell_triangles.len() / 3
    }

    /// Each element's nodes, its node count and its volume, tetrahedra
    /// first, then hexahedra, then shell facets (area times thickness).
    fn measured(&self) -> impl Iterator<Item = (&[u32], f64, f64)> + '_ {
        let points = self.points;
        let tet_nodes = if self.tet_nodes == 4 { 4.0 } else { 10.0 };
        let tets = self.tets.chunks_exact(self.tet_nodes).map(move |tet| {
            let corners = [0, 1, 2, 3].map(|k| point(points, tet[k]));
            (tet, tet_nodes, tet_volume(corners))
        });
        let hexes = self.hexes.as_chunks::<8>().0.iter().map(move |hex| {
            let volume = HEX_TETS
                .iter()
                .map(|tet| tet_volume(tet.map(|k| point(points, hex[k]))))
                .sum();
            (hex.as_slice(), 8.0, volume)
        });
        let facets = self
            .shell_triangles
            .as_chunks::<3>()
            .0
            .iter()
            .zip(self.shell_thicknesses)
            .map(move |(facet, &thickness)| {
                let corners = [0, 1, 2].map(|k| point(points, facet[k]));
                (facet.as_slice(), 3.0, triangle_area(corners) * thickness)
            });
        tets.chain(hexes).chain(facets)
    }
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

/// Each node's share of the model's volume: an element's volume is shared
/// equally among its nodes.
fn nodal_volumes(mesh: &ElementMesh<'_>, node_count: usize) -> Vec<f64> {
    let mut weights = vec![0.0; node_count];
    for (nodes, node_count, volume) in mesh.measured() {
        let share = volume / node_count;
        for &node in nodes {
            weights[node as usize] += share;
        }
    }
    weights
}

/// The checks every statistic makes of the elements; the node count.
fn check_elements(elements: &ElementMesh<'_>) -> Result<usize, FemError> {
    if !elements.points.len().is_multiple_of(3) {
        return Err(invalid(format!(
            "{} coordinates, which is not a multiple of 3",
            elements.points.len()
        )));
    }
    if let Some(at) = elements
        .points
        .iter()
        .position(|coordinate| !coordinate.is_finite())
    {
        return Err(invalid(format!(
            "node {} has a non-finite coordinate",
            at / 3
        )));
    }
    let node_count = elements.points.len() / 3;
    if elements.tet_nodes != 4 && elements.tet_nodes != 10 {
        return Err(invalid(format!(
            "a tetrahedron has 4 or 10 nodes, got {}",
            elements.tet_nodes
        )));
    }
    check_connectivity("tetrahedron", elements.tets, elements.tet_nodes, node_count)?;
    check_connectivity("hexahedron", elements.hexes, 8, node_count)?;
    check_connectivity("shell facet", elements.shell_triangles, 3, node_count)?;
    let facets = elements.shell_triangles.len() / 3;
    if elements.shell_thicknesses.len() != facets {
        return Err(invalid(format!(
            "{} shell thicknesses for {facets} shell facets",
            elements.shell_thicknesses.len()
        )));
    }
    if let Some(thickness) = elements
        .shell_thicknesses
        .iter()
        .find(|thickness| thickness.is_nan() || **thickness <= 0.0)
    {
        return Err(invalid(format!(
            "a shell thickness must be positive, got {thickness}"
        )));
    }
    Ok(node_count)
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
    let node_count = check_elements(&mesh.elements())?;
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
    let weights = nodal_volumes(&mesh.elements(), node_count);
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

/// The statistics of one group of elements: the max and the asked percentile
/// of the group's field averaged to its nodes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GroupStatistics {
    pub max: f64,
    pub quantile: f64,
}

/// Per group, the max and the volume-weighted `quantile` (in [0, 1]) of an
/// element field averaged to the nodes over that group's elements only, each
/// element weighted by its volume. `values` and `groups` hold one entry per
/// element, tetrahedra first, then hexahedra, then shell facets; groups are
/// numbered from 0 to `group_count` − 1. A stiff group's stress so does not
/// leak into a soft neighbour at the nodes they share.
///
/// # Errors
/// [`FemError::StatisticsInput`] for the element checks of
/// [`nodal_percentiles`], a value or group count that differs from the
/// element count, a non-finite value, a group outside `group_count`, or a
/// group without elements.
pub fn grouped_element_statistics(
    elements: &ElementMesh<'_>,
    values: &[f64],
    groups: &[u32],
    group_count: usize,
    quantile: f64,
) -> Result<Vec<GroupStatistics>, FemError> {
    let node_count = check_elements(elements)?;
    let element_count = elements.element_count();
    if values.len() != element_count || groups.len() != element_count {
        return Err(invalid(format!(
            "{} values and {} groups for {element_count} elements",
            values.len(),
            groups.len()
        )));
    }
    if let Some(element) = values.iter().position(|value| !value.is_finite()) {
        return Err(invalid(format!(
            "element {element} has the non-finite value {}",
            values[element]
        )));
    }
    if let Some(group) = groups.iter().find(|&&group| group as usize >= group_count) {
        return Err(invalid(format!(
            "an element is in group {group}, but there are {group_count} groups"
        )));
    }
    let measured: Vec<(&[u32], f64)> = elements
        .measured()
        .map(|(nodes, _, volume)| (nodes, volume))
        .collect();
    (0..group_count)
        .map(|group| {
            let members: Vec<usize> = (0..element_count)
                .filter(|&element| groups[element] as usize == group)
                .collect();
            if members.is_empty() {
                return Err(invalid(format!("group {group} has no elements")));
            }
            let mut sums = vec![0.0; node_count];
            let mut weights = vec![0.0; node_count];
            for &element in &members {
                let (nodes, volume) = measured[element];
                for &node in nodes {
                    sums[node as usize] += volume * values[element];
                    weights[node as usize] += volume;
                }
            }
            let averaged: Vec<f64> = sums
                .iter()
                .zip(&weights)
                .map(|(&sum, &weight)| if weight > 0.0 { sum / weight } else { 0.0 })
                .collect();
            let max = averaged
                .iter()
                .zip(&weights)
                .filter(|(_, &weight)| weight > 0.0)
                .map(|(&value, _)| value)
                .fold(f64::NEG_INFINITY, f64::max);
            let own = |family: &[u32], per: usize, offset: usize| -> Vec<u32> {
                family
                    .chunks_exact(per)
                    .enumerate()
                    .filter(|(index, _)| groups[offset + index] as usize == group)
                    .flat_map(|(_, nodes)| nodes.iter().copied())
                    .collect()
            };
            let tet_count = elements.tets.len() / elements.tet_nodes;
            let hex_count = elements.hexes.len() / 8;
            let tets = own(elements.tets, elements.tet_nodes, 0);
            let hexes = own(elements.hexes, 8, tet_count);
            let shell_triangles = own(elements.shell_triangles, 3, tet_count + hex_count);
            let shell_thicknesses: Vec<f64> = elements
                .shell_thicknesses
                .iter()
                .enumerate()
                .filter(|(index, _)| groups[tet_count + hex_count + index] as usize == group)
                .map(|(_, &thickness)| thickness)
                .collect();
            let [quantile] = nodal_percentiles(
                &StatisticsMesh {
                    points: elements.points,
                    values: &averaged,
                    tets: &tets,
                    tet_nodes: elements.tet_nodes,
                    hexes: &hexes,
                    shell_triangles: &shell_triangles,
                    shell_thicknesses: &shell_thicknesses,
                },
                &[quantile],
            )?[..] else {
                unreachable!("one quantile asked, one returned")
            };
            Ok(GroupStatistics { max, quantile })
        })
        .collect()
}

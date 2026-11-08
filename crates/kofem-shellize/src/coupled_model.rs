// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The node pool of the coupled solve: solid nodes, then shell nodes, then
//! reference points, with the tets and shell facets remapped onto it and the
//! couplings that join the two domains.

use std::collections::{BTreeSet, HashMap, HashSet};

use crate::coupling_set::{CouplingKind, CouplingSet};
use crate::error::ShellizeError;
use crate::footprint::shell_footprint_couplings;
use crate::geometry::{
    dist2, max_of, median_tet_edge, tet_mesh_boundary, unique_in_order, ShellizeMesh, Vec3,
};
use crate::grid::SpatialGrid;
use crate::mid_surface::ShellExtraction;
use crate::partners::{auto_detect_couplings, partner_search_radius};
use crate::seam::{seam_shell_nodes, seam_tolerance};
use crate::ties::{tie_couplings, ties_to_pool, PoolTie, TieCouplingReport, TieSurfaces};

/// Options shared by both builders.
#[derive(Debug, Clone)]
pub struct CouplingOptions {
    /// How far off the retained solid's boundary a shell node may sit and
    /// still count as seam; `None` derives it ([`seam_tolerance`]).
    pub seam_tolerance: Option<f64>,
    /// How far a seam node reaches for its solid partners; `None` derives it
    /// from the solid mesh's spacing ([`partner_search_radius`]).
    pub coupling_radius: Option<f64>,
    pub max_coupled_nodes: usize,
    /// The model's tie connections. Distinct solid bodies are joined ONLY by
    /// these, so an assembly with none keeps its bodies apart.
    pub ties: Vec<TieSurfaces>,
    /// Store vertex indices of the reference points of surface-to-point
    /// couplings. They belong to no element, so nothing else pools them.
    pub reference_points: Vec<usize>,
}

impl Default for CouplingOptions {
    fn default() -> Self {
        Self {
            seam_tolerance: None,
            coupling_radius: None,
            max_coupled_nodes: 16,
            ties: Vec::new(),
            reference_points: Vec::new(),
        }
    }
}

/// The auto-shell coupled model.
#[derive(Debug, Clone, PartialEq)]
pub struct CoupledModel {
    /// Solid nodes, then shell nodes, then reference points.
    pub pool: Vec<Vec3>,
    pub tets: Vec<[usize; 4]>,
    /// Body id per solid tet.
    pub tet_body: Vec<i32>,
    pub triangles: Vec<[usize; 3]>,
    pub thicknesses: Vec<f64>,
    pub coupling: CouplingSet,
    /// Original vertex index → pool index, for the solid nodes, in pool order.
    pub solid_pool: Vec<(usize, usize)>,
    /// Local shell index → pool index.
    pub shell_pool: Vec<usize>,
    /// Reference-point vertex index → pool index, in pool order.
    pub ref_pool: Vec<(usize, usize)>,
    pub tie_reports: Vec<TieCouplingReport>,
}

impl CoupledModel {
    /// Whether a pool index is a shell mid-surface node (the middle block —
    /// the only one carrying shell element stiffness).
    #[must_use]
    pub fn is_shell_pool_index(&self, pool_index: usize) -> bool {
        pool_index >= self.solid_pool.len()
            && pool_index < self.solid_pool.len() + self.shell_pool.len()
    }
}

struct DomainCouplingOptions {
    seam_tolerance: Option<f64>,
    coupling_radius: Option<f64>,
    max_coupled_nodes: usize,
}

/// The couplings joining a pool's solid and shell domains, shared by both
/// builders: the declared ties first (their references become dependent, so
/// the seam must not target them), then the physical footprint on
/// through-thickness sections, then the seam tie of the remaining shell nodes
/// on the retained solid. The seam is continuous material, so it uses the
/// relaxed MPC; a tie across a clearance stays distributing.
#[allow(
    clippy::too_many_arguments,
    reason = "mirrors the stage's inputs one to one; bundling them would only rename them"
)]
fn domain_couplings(
    pool: &[Vec3],
    tets: &[[usize; 4]],
    triangles: &[[usize; 3]],
    thicknesses: &[f64],
    seam_candidates: &[usize],
    solid_pool_indices: &[usize],
    ties: &[PoolTie],
    options: &DomainCouplingOptions,
) -> Result<(CouplingSet, Vec<TieCouplingReport>), ShellizeError> {
    let point = |index: usize| pool[index];
    let median_edge = median_tet_edge(point, tets);
    let (solid_coupling, tie_reports) =
        tie_couplings(&point, ties, median_edge, options.max_coupled_nodes)?;
    let solid_refs: HashSet<usize> = solid_coupling.reference.iter().copied().collect();
    let tolerance = options
        .seam_tolerance
        .unwrap_or_else(|| seam_tolerance(max_of(thicknesses).unwrap_or(0.0), median_edge));
    let seam = seam_shell_nodes(&point, seam_candidates, &tet_mesh_boundary(tets), tolerance)?;
    let footprint =
        shell_footprint_couplings(pool, tets, triangles, thicknesses, &solid_refs, tolerance)?;
    let partners: Vec<usize> = solid_pool_indices
        .iter()
        .copied()
        .filter(|node| !solid_refs.contains(node))
        .collect();
    let references: Vec<usize> = seam
        .into_iter()
        .filter(|node| !footprint.shell_nodes.contains(node))
        .collect();
    let shell_coupling = auto_detect_couplings(
        &point,
        &partners,
        &references,
        options
            .coupling_radius
            .unwrap_or_else(|| partner_search_radius(median_edge, tolerance)),
        options.max_coupled_nodes,
    )?;
    let coupling = footprint
        .coupling
        .concat(&shell_coupling.with_kind(CouplingKind::RelaxedMpc))
        .concat(&solid_coupling.with_kind(CouplingKind::Distributing));
    Ok((coupling, tie_reports))
}

/// Assemble the coupled pool (solid nodes, then shell nodes, then reference
/// points), remap the solid tets — every tet except the shelled body's
/// `wall_tets` — and the shell facets onto it, and tie the domains.
///
/// # Errors
/// A malformed coupling input or a footprint/tie conflict.
pub fn build_coupled_model(
    mesh: &ShellizeMesh,
    shells: &ShellExtraction,
    wall_tets: &BTreeSet<usize>,
    options: &CouplingOptions,
) -> Result<CoupledModel, ShellizeError> {
    let mut solid_tets: Vec<[usize; 4]> = Vec::new();
    let mut tet_body: Vec<i32> = Vec::new();
    for (element, &tet) in mesh.tets.iter().enumerate() {
        let replaced =
            Some(mesh.body[element]) == shells.shell_body && wall_tets.contains(&element);
        if !replaced {
            solid_tets.push(tet);
            tet_body.push(mesh.body[element]);
        }
    }

    let mut pool: Vec<Vec3> = Vec::new();
    let mut solid_index: HashMap<usize, usize> = HashMap::new();
    let mut solid_pool: Vec<(usize, usize)> = Vec::new();
    for vertex in unique_in_order(solid_tets.iter().flatten().copied()) {
        solid_index.insert(vertex, pool.len());
        solid_pool.push((vertex, pool.len()));
        pool.push(mesh.vertices[vertex]);
    }
    let mut shell_pool: Vec<usize> = Vec::with_capacity(shells.vertices.len());
    for &vertex in &shells.vertices {
        shell_pool.push(pool.len());
        pool.push(vertex);
    }
    // Reference points last, so the three blocks stay apart by index range.
    let mut ref_pool: Vec<(usize, usize)> = Vec::new();
    for vertex in unique_in_order(options.reference_points.iter().copied()) {
        if vertex >= mesh.vertices.len() {
            return Err(ShellizeError::VertexOutOfRange {
                what: "reference point",
                vertex,
                count: mesh.vertices.len(),
            });
        }
        ref_pool.push((vertex, pool.len()));
        pool.push(mesh.vertices[vertex]);
    }

    // Every solid tet vertex was pooled just above.
    let tets = solid_tets
        .iter()
        .map(|tet| {
            let mut mapped = [0usize; 4];
            for (corner, vertex) in tet.iter().enumerate() {
                mapped[corner] = *solid_index.get(vertex).ok_or(ShellizeError::Internal {
                    reason: "solid node missing from the coupled pool",
                })?;
            }
            Ok(mapped)
        })
        .collect::<Result<Vec<[usize; 4]>, ShellizeError>>()?;
    let triangles: Vec<[usize; 3]> = shells
        .triangles
        .iter()
        .map(|tri| tri.map(|node| shell_pool[node]))
        .collect();
    let solid_pool_indices: Vec<usize> = solid_pool.iter().map(|&(_, index)| index).collect();

    let (coupling, tie_reports) = domain_couplings(
        &pool,
        &tets,
        &triangles,
        &shells.thicknesses,
        &shell_pool,
        &solid_pool_indices,
        &ties_to_pool(&options.ties, |vertex| solid_index.get(&vertex).copied()),
        &DomainCouplingOptions {
            seam_tolerance: options.seam_tolerance,
            coupling_radius: options.coupling_radius,
            max_coupled_nodes: options.max_coupled_nodes,
        },
    )?;

    Ok(CoupledModel {
        pool,
        tets,
        tet_body,
        triangles,
        thicknesses: shells.thicknesses.clone(),
        coupling,
        solid_pool,
        shell_pool,
        ref_pool,
        tie_reports,
    })
}

/// A coupled model built from EXPLICIT shell and solid elements (a stored mixed
/// CTRIA3 + CTETRA model), as opposed to one derived by collapsing walls.
#[derive(Debug, Clone, PartialEq)]
pub struct ExplicitCoupledModel {
    pub pool: Vec<Vec3>,
    pub tets: Vec<[usize; 4]>,
    pub triangles: Vec<[usize; 3]>,
    pub thicknesses: Vec<f64>,
    pub coupling: CouplingSet,
    /// Store vertex index → pool index, in pool order.
    pub pool_of_vertex: Vec<(usize, usize)>,
    /// Pool indices carrying shell stiffness, in first-use order.
    pub shell_pool_index: Vec<usize>,
    pub tie_reports: Vec<TieCouplingReport>,
}

/// Pool the solid tet nodes, then the shell nodes (a node also used by a tet
/// reuses its entry — a direct rigid connection), then the reference points,
/// and tie the unshared shell nodes on the solid boundary by the same rule as
/// the auto-shell path, so a saved mixed model reloads with its seam.
///
/// # Errors
/// A malformed array or index, or a footprint/tie conflict.
pub fn build_explicit_coupled_model(
    vertices: &[f64],
    solid_tets: &[u32],
    shell_tris: &[u32],
    shell_thickness: &[f64],
    options: &CouplingOptions,
) -> Result<ExplicitCoupledModel, ShellizeError> {
    let mesh = ShellizeMesh::new(
        vertices,
        solid_tets,
        &vec![0; solid_tets.len() / 4],
        shell_tris,
        &vec![0; shell_tris.len() / 3],
    )?;
    if shell_thickness.len() != mesh.surf_tris.len() {
        return Err(ShellizeError::ArrayCount {
            what: "shell thickness array",
            len: shell_thickness.len(),
            expected: mesh.surf_tris.len(),
        });
    }
    let mut pool: Vec<Vec3> = Vec::new();
    let mut index_of: HashMap<usize, usize> = HashMap::new();
    let mut pool_of_vertex: Vec<(usize, usize)> = Vec::new();
    let mut add_vertex = |vertex: usize, pool: &mut Vec<Vec3>| -> usize {
        *index_of.entry(vertex).or_insert_with(|| {
            pool_of_vertex.push((vertex, pool.len()));
            pool.push(mesh.vertices[vertex]);
            pool.len() - 1
        })
    };

    let solid_pool_indices: Vec<usize> = unique_in_order(mesh.tets.iter().flatten().copied())
        .into_iter()
        .map(|vertex| add_vertex(vertex, &mut pool))
        .collect();
    let tets: Vec<[usize; 4]> = mesh
        .tets
        .iter()
        .map(|tet| tet.map(|vertex| add_vertex(vertex, &mut pool)))
        .collect();
    let triangles: Vec<[usize; 3]> = mesh
        .surf_tris
        .iter()
        .map(|tri| tri.map(|vertex| add_vertex(vertex, &mut pool)))
        .collect();
    let shell_pool_index = unique_in_order(triangles.iter().flatten().copied());
    for &vertex in &options.reference_points {
        if vertex >= mesh.vertices.len() {
            return Err(ShellizeError::VertexOutOfRange {
                what: "reference point",
                vertex,
                count: mesh.vertices.len(),
            });
        }
        add_vertex(vertex, &mut pool);
    }

    let solid_set: HashSet<usize> = solid_pool_indices.iter().copied().collect();
    let unshared: Vec<usize> = shell_pool_index
        .iter()
        .copied()
        .filter(|node| !solid_set.contains(node))
        .collect();
    let (coupling, tie_reports) = domain_couplings(
        &pool,
        &tets,
        &triangles,
        shell_thickness,
        &unshared,
        &solid_pool_indices,
        &ties_to_pool(&options.ties, |vertex| index_of.get(&vertex).copied()),
        &DomainCouplingOptions {
            seam_tolerance: options.seam_tolerance,
            coupling_radius: options.coupling_radius,
            max_coupled_nodes: options.max_coupled_nodes,
        },
    )?;

    Ok(ExplicitCoupledModel {
        pool,
        tets,
        triangles,
        thicknesses: shell_thickness.to_vec(),
        coupling,
        pool_of_vertex,
        shell_pool_index,
        tie_reports,
    })
}

/// Nearest shell mid-surface node to a point — used to map the shelled body's
/// boundary conditions and displacement result (the mid-surface is offset ~t/2
/// from the solid surface). Expanding ring search on a 15-unit grid.
#[derive(Debug)]
pub struct ShellNodeLocator {
    grid: SpatialGrid,
    pool: Vec<Vec3>,
}

const LOCATOR_CELL: f64 = 15.0;
const LOCATOR_RINGS: i64 = 6;

impl ShellNodeLocator {
    /// # Errors
    /// Never in practice (the cell size is a positive constant).
    pub fn new(model: &CoupledModel) -> Result<Self, ShellizeError> {
        let grid = SpatialGrid::new(
            model.shell_pool.iter().copied(),
            |index| model.pool[index],
            LOCATOR_CELL,
        )?;
        Ok(Self {
            grid,
            pool: model.pool.clone(),
        })
    }

    /// # Errors
    /// [`ShellizeError::NoShellNodeNear`] when no shell node lies within the
    /// searched rings — mapping onto an arbitrary node would misplace a BC.
    #[allow(clippy::cast_precision_loss, reason = "a ring count of at most 6")]
    pub fn nearest(&self, point: Vec3) -> Result<usize, ShellizeError> {
        for ring in 0..=LOCATOR_RINGS {
            let mut best: Option<(usize, f64)> = None;
            for node in self.grid.candidates(point, ring, ring) {
                let distance = dist2(point, self.pool[node]);
                if best.is_none_or(|(_, current)| distance < current) {
                    best = Some((node, distance));
                }
            }
            if let Some((node, _)) = best {
                return Ok(node);
            }
        }
        Err(ShellizeError::NoShellNodeNear {
            radius: LOCATOR_RINGS as f64 * LOCATOR_CELL,
            point_x: point[0],
            point_y: point[1],
            point_z: point[2],
        })
    }
}

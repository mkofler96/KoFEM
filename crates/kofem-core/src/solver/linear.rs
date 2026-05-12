//! Linear static solver: [K]{u} = {f}
//! Uses Cholesky decomposition for SPD global stiffness matrix.

use crate::boundary::BoundaryConditions;
use crate::elements::beam::CbarElement;
use crate::elements::solid::{Chexa8Element, Ctetra4Element};
use crate::elements::{Element as ElementTrait, ElementType};
use crate::mesh::Mesh;
use crate::property::PropertyCard;
use alloc::vec::Vec;
use nalgebra::{DMatrix, DVector};

#[derive(Debug)]
pub struct LinearStaticResult {
    /// Always 6 values per node (ux, uy, uz, rx, ry, rz).
    /// Rotational DOF are zero for solid elements.
    pub displacements: Vec<f64>,
}

pub struct LinearStaticSolver;

impl LinearStaticSolver {
    /// Assemble and solve [K]{u} = {f}.
    ///
    /// The DOF count per node is derived from the property card (3 for solids,
    /// 6 for beams/shells). The returned displacement vector is always padded
    /// to 6 values per node so callers can index with `node_idx * 6 + dof`.
    pub fn solve(mesh: &Mesh, bcs: &BoundaryConditions) -> Result<LinearStaticResult, SolverError> {
        let n_nodes = mesh.nodes.len();

        // Per-node active DOF count: max over all elements that reference the node.
        let mut node_dof = alloc::vec![0usize; n_nodes];
        for elem in &mesh.elements {
            if let Some(prop) = mesh.find_property(elem.property_id) {
                let edof = prop.dof_per_node();
                for &id in &elem.node_ids {
                    if let Some(idx) = mesh.find_node_idx(id) {
                        node_dof[idx] = node_dof[idx].max(edof);
                    }
                }
            }
        }
        // Nodes not referenced by any element default to 6 (won't contribute stiffness).
        for d in node_dof.iter_mut() {
            if *d == 0 {
                *d = 6;
            }
        }

        // Cumulative DOF offsets.
        let mut dof_offset = alloc::vec![0usize; n_nodes + 1];
        for i in 0..n_nodes {
            dof_offset[i + 1] = dof_offset[i] + node_dof[i];
        }
        let n_total = dof_offset[n_nodes];

        let mut k_global = DMatrix::<f64>::zeros(n_total, n_total);
        let mut f_global = DVector::<f64>::zeros(n_total);

        // Assemble element stiffness matrices.
        for elem in &mesh.elements {
            let pairs: Vec<([f64; 3], usize)> = elem
                .node_ids
                .iter()
                .map(|&id| {
                    let idx = mesh.find_node_idx(id).ok_or(SolverError::MissingNode(id))?;
                    Ok((mesh.nodes[idx].coords, idx))
                })
                .collect::<Result<_, SolverError>>()?;
            let (node_coords, node_indices): (Vec<[f64; 3]>, Vec<usize>) =
                pairs.into_iter().unzip();

            let prop = mesh
                .find_property(elem.property_id)
                .ok_or(SolverError::MissingProperty(elem.property_id))?;
            let mat = mesh
                .find_material(prop.material_id())
                .ok_or(SolverError::MissingMaterial(prop.material_id()))?;

            let e_dof = prop.dof_per_node(); // active DOF per node for this element

            let k_elem = match elem.element_type {
                ElementType::CBAR | ElementType::CBEAM => {
                    let (area, i1, i2, j) = match prop {
                        PropertyCard::PBAR(p) => (p.area, p.i1, p.i2, p.j),
                        PropertyCard::PBEAM(p) => (p.area, p.i1, p.i2, p.j),
                        _ => continue,
                    };
                    CbarElement {
                        material: *mat,
                        area,
                        i1,
                        i2,
                        j_torsion: j,
                    }
                    .stiffness_matrix(&node_coords)
                }
                ElementType::CHEXA => {
                    if !matches!(prop, PropertyCard::PSOLID(_)) {
                        continue;
                    }
                    Chexa8Element { material: *mat }.stiffness_matrix(&node_coords)
                }
                ElementType::CTETRA => {
                    if !matches!(prop, PropertyCard::PSOLID(_)) {
                        continue;
                    }
                    Ctetra4Element { material: *mat }.stiffness_matrix(&node_coords)
                }
                _ => continue,
            };

            // Scatter-add: local DOF (ln*e_dof + ld) → global DOF (dof_offset[ni] + ld).
            for (ln, &ni) in node_indices.iter().enumerate() {
                for ld in 0..e_dof {
                    let gi = dof_offset[ni] + ld;
                    let li = ln * e_dof + ld;
                    for (mn, &mi) in node_indices.iter().enumerate() {
                        for md in 0..e_dof {
                            let gj = dof_offset[mi] + md;
                            let lj = mn * e_dof + md;
                            k_global[(gi, gj)] += k_elem[(li, lj)];
                        }
                    }
                }
            }
        }

        // Apply nodal loads.
        for load in &bcs.nodal_loads {
            let idx = mesh
                .find_node_idx(load.node_id)
                .ok_or(SolverError::MissingNode(load.node_id))?;
            let dof = load.dof as usize;
            if dof < node_dof[idx] {
                f_global[dof_offset[idx] + dof] += load.value;
            }
        }

        // Penalty method for Dirichlet BCs.
        let max_diag = k_global.diagonal().max();
        let penalty = if max_diag > 0.0 {
            max_diag * 1e14
        } else {
            1e14
        };
        for bc in &bcs.constraints {
            let idx = mesh
                .find_node_idx(bc.node_id)
                .ok_or(SolverError::MissingNode(bc.node_id))?;
            let dof = bc.dof as usize;
            if dof < node_dof[idx] {
                let row = dof_offset[idx] + dof;
                k_global[(row, row)] = penalty;
                f_global[row] = penalty * bc.prescribed_value;
            }
        }

        let chol = k_global
            .clone()
            .cholesky()
            .ok_or(SolverError::NotPositiveDefinite)?;
        let u = chol.solve(&f_global);

        // Pad result to 6 DOF per node (rotational DOF stay 0 for solid elements).
        let mut padded = alloc::vec![0.0f64; n_nodes * 6];
        for i in 0..n_nodes {
            for d in 0..node_dof[i] {
                padded[i * 6 + d] = u[dof_offset[i] + d];
            }
        }

        Ok(LinearStaticResult {
            displacements: padded,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boundary::{BoundaryConditions, DofIndex};
    use crate::elements::ElementType;
    use crate::material::IsotropicElastic;
    use crate::property::{PbarProps, PropertyCard, PsolidProps};

    /// 10-element CBAR cantilever, tip load P = 1 N (Uy).
    /// Analytical: δ = PL³ / (3EI), error < 1%.
    #[test]
    fn cbar_cantilever_tip_deflection() {
        let n_elem = 10usize;
        let steel = IsotropicElastic::new(210e9, 0.3, 7850.0);
        let a = 0.01f64;
        let i1 = a.powi(4) / 12.0;

        let mut mesh = Mesh::new();
        let mut bcs = BoundaryConditions::default();

        for i in 0..=n_elem {
            mesh.add_node(i, i as f64 / n_elem as f64, 0.0, 0.0);
        }
        mesh.add_material(1, steel);
        mesh.add_property(
            1,
            PropertyCard::PBAR(PbarProps {
                material_id: 1,
                area: a * a,
                i1,
                i2: i1,
                j: 0.1406 * a.powi(4),
            }),
        );
        for i in 0..n_elem {
            mesh.add_element(i, ElementType::CBAR, alloc::vec![i, i + 1], 1, 1);
        }
        bcs.fix_node(0);
        bcs.apply_force(n_elem, DofIndex::Uy, -1.0);

        let r = LinearStaticSolver::solve(&mesh, &bcs).unwrap();
        let tip_uy = r.displacements[n_elem * 6 + 1];
        let expected = -1.0 / (3.0 * steel.young * i1);
        let rel = ((tip_uy - expected) / expected).abs();
        assert!(rel < 0.01, "rel error {:.1}%", rel * 100.0);
    }

    /// 10×2×2 CHEXA8 cantilever (40 elements), tip load P = 10000 N (Uy).
    /// 2 elements through each cross-section direction reduces shear locking.
    /// Tolerance 12% — standard trilinear hex converges slowly in bending.
    #[test]
    fn chexa_cantilever_tip_deflection() {
        let nx = 10usize; // elements along beam axis
        let ny = 2usize; // elements through y
        let nz = 2usize; // elements through z
        let h = 0.1f64; // cross-section side (m)
        let l = 1.0f64;
        let p = -10_000.0f64;
        let steel = IsotropicElastic::new(210e9, 0.3, 7850.0);
        let i_bending = h.powi(4) / 12.0;

        let mut mesh = Mesh::new();
        let mut bcs = BoundaryConditions::default();

        let dx = l / nx as f64;
        let dy = h / ny as f64;
        let dz = h / nz as f64;
        // node_id(ix, iy, iz) with stride (ny+1)*(nz+1)
        let stride_y = nz + 1;
        let stride_x = (ny + 1) * (nz + 1);
        let node_id = |ix: usize, iy: usize, iz: usize| ix * stride_x + iy * stride_y + iz;

        for ix in 0..=nx {
            for iy in 0..=ny {
                for iz in 0..=nz {
                    mesh.add_node(
                        node_id(ix, iy, iz),
                        ix as f64 * dx,
                        iy as f64 * dy,
                        iz as f64 * dz,
                    );
                }
            }
        }
        mesh.add_material(1, steel);
        mesh.add_property(1, PropertyCard::PSOLID(PsolidProps { material_id: 1 }));

        let mut eid = 0usize;
        for ei in 0..nx {
            for ej in 0..ny {
                for ek in 0..nz {
                    mesh.add_element(
                        eid,
                        ElementType::CHEXA,
                        alloc::vec![
                            node_id(ei, ej, ek),
                            node_id(ei + 1, ej, ek),
                            node_id(ei + 1, ej + 1, ek),
                            node_id(ei, ej + 1, ek),
                            node_id(ei, ej, ek + 1),
                            node_id(ei + 1, ej, ek + 1),
                            node_id(ei + 1, ej + 1, ek + 1),
                            node_id(ei, ej + 1, ek + 1),
                        ],
                        1,
                        1,
                    );
                    eid += 1;
                }
            }
        }

        // Fix Ux, Uy, Uz at the left face (ix=0)
        for iy in 0..=ny {
            for iz in 0..=nz {
                let id = node_id(0, iy, iz);
                for dof in [DofIndex::Ux, DofIndex::Uy, DofIndex::Uz] {
                    bcs.constraints.push(crate::boundary::NodalConstraint {
                        node_id: id,
                        dof,
                        prescribed_value: 0.0,
                    });
                }
            }
        }

        // Distribute P equally over (ny+1)*(nz+1) nodes on right face
        let n_face = (ny + 1) * (nz + 1);
        let f_node = p / n_face as f64;
        for iy in 0..=ny {
            for iz in 0..=nz {
                bcs.apply_force(node_id(nx, iy, iz), DofIndex::Uy, f_node);
            }
        }

        let r = LinearStaticSolver::solve(&mesh, &bcs).unwrap();

        // Average Uy across all tip-face nodes
        let tip_uy: f64 = (0..=ny)
            .flat_map(|iy| (0..=nz).map(move |iz| (iy, iz)))
            .map(|(iy, iz)| {
                let ni = mesh.find_node_idx(node_id(nx, iy, iz)).unwrap();
                r.displacements[ni * 6 + 1]
            })
            .sum::<f64>()
            / n_face as f64;

        let expected = p / (3.0 * steel.young * i_bending);
        let rel = ((tip_uy - expected) / expected).abs();
        assert!(
            rel < 0.12,
            "rel error {:.1}% (expect <12% for 10×2×2 hex)",
            rel * 100.0
        );
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SolverError {
    #[error("Global stiffness matrix is not positive definite — check boundary conditions")]
    NotPositiveDefinite,
    #[error("Singular stiffness matrix — model may be under-constrained")]
    Singular,
    #[error("Node {0} not found in mesh")]
    MissingNode(usize),
    #[error("Material {0} not found in mesh")]
    MissingMaterial(usize),
    #[error("Property {0} not found in mesh")]
    MissingProperty(usize),
}

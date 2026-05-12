//! Linear static solver: [K]{u} = {f}
//! Uses Cholesky decomposition for SPD global stiffness matrix.

use crate::boundary::BoundaryConditions;
use crate::elements::beam::CbarElement;
use crate::elements::{Element as ElementTrait, ElementType};
use crate::mesh::Mesh;
use crate::property::PropertyCard;
use alloc::vec::Vec;
use nalgebra::{DMatrix, DVector};

#[derive(Debug)]
pub struct LinearStaticResult {
    pub displacements: Vec<f64>,
}

pub struct LinearStaticSolver;

impl LinearStaticSolver {
    /// Assemble and solve the linear system [K]{u} = {f}.
    /// Returns nodal displacements (6 values per node: ux, uy, uz, rx, ry, rz).
    pub fn solve(mesh: &Mesh, bcs: &BoundaryConditions) -> Result<LinearStaticResult, SolverError> {
        let n = mesh.n_dof();
        let mut k_global = DMatrix::<f64>::zeros(n, n);
        let mut f_global = DVector::<f64>::zeros(n);

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
                // Solid/surface elements not yet wired into solver
                _ => continue,
            };

            // Scatter-add element stiffness into global matrix
            let dof_per_node = 6usize;
            for (ln, &ni) in node_indices.iter().enumerate() {
                for ld in 0..dof_per_node {
                    let gi = ni * dof_per_node + ld;
                    let li = ln * dof_per_node + ld;
                    for (mn, &mi) in node_indices.iter().enumerate() {
                        for md in 0..dof_per_node {
                            let gj = mi * dof_per_node + md;
                            let lj = mn * dof_per_node + md;
                            k_global[(gi, gj)] += k_elem[(li, lj)];
                        }
                    }
                }
            }
        }

        // Apply nodal loads
        for load in &bcs.nodal_loads {
            let idx = mesh
                .find_node_idx(load.node_id)
                .ok_or(SolverError::MissingNode(load.node_id))?;
            let row = idx * 6 + load.dof as usize;
            f_global[row] += load.value;
        }

        // Penalty method for Dirichlet BCs
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
            let row = idx * 6 + bc.dof as usize;
            k_global[(row, row)] = penalty;
            f_global[row] = penalty * bc.prescribed_value;
        }

        let chol = k_global
            .clone()
            .cholesky()
            .ok_or(SolverError::NotPositiveDefinite)?;
        let u = chol.solve(&f_global);

        Ok(LinearStaticResult {
            displacements: u.as_slice().to_vec(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boundary::{BoundaryConditions, DofIndex};
    use crate::elements::ElementType;
    use crate::material::IsotropicElastic;
    use crate::property::{PbarProps, PropertyCard};

    /// 10-element cantilever beam, tip load P = 1 N downward (Uy).
    /// Analytical tip deflection: δ = PL³ / (3EI).
    #[test]
    fn cantilever_tip_deflection() {
        let n_elem = 10usize;
        let l_total = 1.0f64;
        let steel = IsotropicElastic::new(210e9, 0.3, 7850.0);
        let a = 0.01f64;
        let area = a * a;
        let i1 = a.powi(4) / 12.0;
        let i2 = i1;
        let j = 0.1406 * a.powi(4);

        let mut mesh = Mesh::new();
        let mut bcs = BoundaryConditions::default();

        for i in 0..=n_elem {
            mesh.add_node(i, (i as f64) * l_total / (n_elem as f64), 0.0, 0.0);
        }
        mesh.add_material(1, steel);
        mesh.add_property(
            1,
            PropertyCard::PBAR(PbarProps {
                material_id: 1,
                area,
                i1,
                i2,
                j,
            }),
        );
        for i in 0..n_elem {
            mesh.add_element(i, ElementType::CBAR, alloc::vec![i, i + 1], 1, 1);
        }

        bcs.fix_node(0);
        bcs.apply_force(n_elem, DofIndex::Uy, -1.0);

        let result = LinearStaticSolver::solve(&mesh, &bcs).expect("solver failed");
        let d = &result.displacements;

        let tip_uy = d[n_elem * 6 + 1];
        let expected = -1.0 / (3.0 * steel.young * i1);
        let rel_error = ((tip_uy - expected) / expected).abs();

        assert!(
            rel_error < 0.01,
            "Tip Uy {tip_uy:.4e} differs from analytical {expected:.4e} by {:.1}%",
            rel_error * 100.0
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

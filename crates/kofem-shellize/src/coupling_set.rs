// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The CSR coupling set handed to the coupled solve, and the operations on it
//! that do not depend on how its couplings were found.

use std::collections::HashSet;

use crate::error::ShellizeError;

/// How a coupling joins its reference node to its partners (the engine's
/// `mpc` code per reference).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum CouplingKind {
    /// Distributing RBE3, for a gapped interface.
    Distributing = 0,
    /// Relaxed shell-to-solid MPC (rigid translation tie + relaxed rotation),
    /// for a continuous-material seam.
    RelaxedMpc = 1,
    /// Kinematic RBE2: the partners follow the reference rigidly.
    Kinematic = 2,
    /// Physical footprint: a solid node follows an interpolated shell edge.
    Footprint = 3,
}

impl CouplingKind {
    #[must_use]
    pub fn code(self) -> i32 {
        self as i32
    }

    /// # Errors
    /// A code the engine does not define.
    pub fn from_code(code: i32) -> Result<Self, ShellizeError> {
        match code {
            0 => Ok(Self::Distributing),
            1 => Ok(Self::RelaxedMpc),
            2 => Ok(Self::Kinematic),
            3 => Ok(Self::Footprint),
            _ => Err(ShellizeError::MalformedCoupling {
                reason: "unknown coupling kind code",
            }),
        }
    }
}

/// All six DOFs of a coupling — the engine's `kAllDofs`.
pub const ALL_DOF_MASK: u32 = 0x3f;

/// CSR coupling set: reference `reference[k]` ties to partners
/// `partner[offsets[k]..offsets[k + 1]]` with interpolation `weights` (one per
/// partner), coupling kind `kind[k]` and tied-DOF bit mask `dof_mask[k]`.
#[derive(Debug, Clone, PartialEq)]
pub struct CouplingSet {
    pub reference: Vec<usize>,
    pub offsets: Vec<usize>,
    pub partner: Vec<usize>,
    pub kind: Vec<CouplingKind>,
    pub weights: Vec<f64>,
    pub dof_mask: Vec<u32>,
}

impl Default for CouplingSet {
    fn default() -> Self {
        Self {
            reference: Vec::new(),
            offsets: vec![0],
            partner: Vec::new(),
            kind: Vec::new(),
            weights: Vec::new(),
            dof_mask: Vec::new(),
        }
    }
}

impl CouplingSet {
    #[must_use]
    pub fn len(&self) -> usize {
        self.reference.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.reference.is_empty()
    }

    /// Append one coupling over all six DOFs.
    pub fn push(
        &mut self,
        reference: usize,
        partners: &[usize],
        weights: &[f64],
        kind: CouplingKind,
    ) {
        self.reference.push(reference);
        self.partner.extend_from_slice(partners);
        self.weights.extend_from_slice(weights);
        self.offsets.push(self.partner.len());
        self.kind.push(kind);
        self.dof_mask.push(ALL_DOF_MASK);
    }

    /// Append one coupling with unit weights over all six DOFs.
    pub fn push_unweighted(&mut self, reference: usize, partners: &[usize], kind: CouplingKind) {
        self.push(reference, partners, &vec![1.0; partners.len()], kind);
    }

    /// The same couplings with every kind set to `kind`.
    #[must_use]
    pub fn with_kind(mut self, kind: CouplingKind) -> Self {
        self.kind.fill(kind);
        self
    }

    /// Partners of coupling `k`.
    #[must_use]
    pub fn partners(&self, k: usize) -> &[usize] {
        &self.partner[self.offsets[k]..self.offsets[k + 1]]
    }

    /// Check the CSR invariants.
    ///
    /// # Errors
    /// The first broken invariant.
    pub fn validate(&self) -> Result<(), ShellizeError> {
        let count = self.reference.len();
        if self.offsets.len() != count + 1 {
            return Err(ShellizeError::MalformedCoupling {
                reason: "offsets must have one entry more than the references",
            });
        }
        if self.offsets.first() != Some(&0) || self.offsets.last() != Some(&self.partner.len()) {
            return Err(ShellizeError::MalformedCoupling {
                reason: "offsets must start at 0 and end at the partner count",
            });
        }
        if self.offsets.windows(2).any(|pair| pair[0] > pair[1]) {
            return Err(ShellizeError::MalformedCoupling {
                reason: "offsets must not decrease",
            });
        }
        if self.kind.len() != count || self.dof_mask.len() != count {
            return Err(ShellizeError::MalformedCoupling {
                reason: "one kind and one DOF mask per reference",
            });
        }
        if self.weights.len() != self.partner.len() {
            return Err(ShellizeError::MalformedCoupling {
                reason: "one weight per partner",
            });
        }
        Ok(())
    }

    /// Concatenate `other` after `self`, keeping each set's kinds, masks and
    /// weights.
    #[must_use]
    pub fn concat(mut self, other: &CouplingSet) -> Self {
        let base = self.partner.len();
        self.reference.extend_from_slice(&other.reference);
        self.partner.extend_from_slice(&other.partner);
        self.offsets
            .extend(other.offsets.iter().skip(1).map(|offset| base + offset));
        self.kind.extend_from_slice(&other.kind);
        self.weights.extend_from_slice(&other.weights);
        self.dof_mask.extend_from_slice(&other.dof_mask);
        self
    }

    /// Drop the dependent couplings whose reference node carries an essential
    /// BC (`fixed_dofs` numbered 6·node + component). A fixed node's motion is
    /// prescribed, so it cannot also be the dependent of a coupling — the
    /// engine refuses that conflict (#377). A KINEMATIC coupling's reference is
    /// independent, so fixing it is no conflict and it stays.
    ///
    /// # Errors
    /// [`ShellizeError::PrescribedTransitionNode`] when a footprint coupling's
    /// solid node is fixed: dropping it would cut the shell/solid transition.
    pub fn drop_on_fixed_nodes(&self, fixed_dofs: &[u32]) -> Result<Self, ShellizeError> {
        let fixed_nodes: HashSet<usize> = fixed_dofs.iter().map(|&dof| dof as usize / 6).collect();
        let mut kept = CouplingSet::default();
        for k in 0..self.len() {
            let fixed = fixed_nodes.contains(&self.reference[k]);
            if fixed && self.kind[k] == CouplingKind::Footprint {
                return Err(ShellizeError::PrescribedTransitionNode);
            }
            if fixed && self.kind[k] != CouplingKind::Kinematic {
                continue;
            }
            let range = self.offsets[k]..self.offsets[k + 1];
            kept.reference.push(self.reference[k]);
            kept.partner.extend_from_slice(&self.partner[range.clone()]);
            kept.weights.extend_from_slice(&self.weights[range]);
            kept.offsets.push(kept.partner.len());
            kept.kind.push(self.kind[k]);
            kept.dof_mask.push(self.dof_mask[k]);
        }
        Ok(kept)
    }
}

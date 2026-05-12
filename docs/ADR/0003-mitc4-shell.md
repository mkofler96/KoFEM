# ADR 0003: MITC4 Shell Element Formulation

**Status:** Accepted  
**Date:** 2026-05-12

## Context
Shell elements are prone to shear locking (spurious stiffness) when the shell is thin, and membrane locking when curved. We need a robust formulation for general structural analysis.

## Decision
Implement the **MITC4** element (Mixed Interpolation of Tensorial Components, 4-node quadrilateral).

Key properties:
- Avoids shear locking via mixed interpolation of transverse shear strains at "tying points"
- 6 DOF per node (ux, uy, uz, rx, ry, rz) — drilling DOF (rz) added via Allman (1984) for numerical stability
- 2×2 Gauss integration for membrane and bending; reduced integration for shear (1 point)

## References
- Bathe & Dvorkin, "A four-node plate bending element based on Mindlin/Reissner plate theory and a mixed interpolation," IJNME 21 (1985)
- Chapelle & Bathe, "The Finite Element Analysis of Shells" (2011), Ch. 8

## Consequences
- **+** Industry-standard formulation used in Abaqus (S4) and LS-DYNA
- **+** No stabilization parameters required
- **-** More complex B-matrix assembly than simple displacement-based formulation
- **-** Requires careful implementation of the tying point interpolation

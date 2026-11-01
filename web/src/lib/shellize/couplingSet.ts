// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The CSR coupling set handed to the engine's coupled solve, and the operations
// on it that do not depend on how its couplings were found.

// CSR-style coupling set. `mpc[k]` selects the coupling kind for reference k:
// 1 ⇒ relaxed shell-to-solid MPC (rigid translation tie + relaxed rotation, for a
// continuous-material seam), 2 ⇒ kinematic RBE2 (the coupled nodes follow the
// reference point rigidly), 3 ⇒ physical footprint (solid translations follow
// an interpolated shell edge), 0/absent ⇒ distributing RBE3 (for a gapped
// interface). `dofMask[k]` selects which of a kinematic coupling's six DOFs are
// tied (bits 0..5); absent ⇒ all six, which is what every coupling this module
// derives itself wants.
export interface CouplingSet {
  ref: number[];
  offsets: number[];
  solid: number[];
  mpc?: number[]; // per ref; length matches ref when present
  weights?: number[]; // per partner; shell-footprint interpolation coefficients
  dofMask?: number[]; // per ref; length matches ref when present
}

// All six DOFs of a coupling — the engine's kAllDofs.
const ALL_DOF_MASK = 0x3f;

// Per-reference coupling kinds / DOF masks of a set, defaulted for the sets
// built here (which are all distributing or relaxed-MPC, and tie all six DOFs).
export function couplingMpcCodes(set: CouplingSet): number[] {
  if (set.mpc) return set.mpc;
  return set.ref.map(() => 0);
}

export function couplingDofMasks(set: CouplingSet): number[] {
  if (set.dofMask) return set.dofMask;
  return set.ref.map(() => ALL_DOF_MASK);
}

// Concatenate two CSR coupling sets (shell↔solid, solid↔solid, and the
// reference-point couplings the user declared) into one, preserving each set's
// per-reference kind and DOF mask.
export function concatCouplings(a: CouplingSet, b: CouplingSet): CouplingSet {
  const ref = [...a.ref, ...b.ref];
  const solid = [...a.solid, ...b.solid];
  const offsets = [...a.offsets];
  const base = a.solid.length;
  for (let k = 1; k < b.offsets.length; k++) offsets.push(base + b.offsets[k]);
  return {
    ref,
    offsets,
    solid,
    mpc: [...couplingMpcCodes(a), ...couplingMpcCodes(b)],
    dofMask: [...couplingDofMasks(a), ...couplingDofMasks(b)],
    weights: [
      ...(a.weights ?? a.solid.map(() => 1)),
      ...(b.weights ?? b.solid.map(() => 1)),
    ],
  };
}

// Drop distributing couplings whose reference (shell) node carries an essential
// BC. A fixed node's motion is prescribed, so it cannot ALSO be the dependent of
// an RBE3 average of the solid — the engine refuses that conflict rather than
// silently dropping the constraint (issue #377). This arises where a clamped
// shell edge (e.g. a bolted holder rim) sits next to the retained base solid: the
// proximity detector would otherwise couple the very nodes the user fixed. The BC
// wins; the surrounding shell/solid stays connected through the mesh either way.
export function dropCouplingsOnFixedNodes(
  coupling: CouplingSet,
  fixedDofs: Iterable<number>,
): CouplingSet {
  const fixedNodes = new Set<number>();
  for (const d of fixedDofs) fixedNodes.add(Math.floor(d / 6));
  const kinds = couplingMpcCodes(coupling);
  const masks = couplingDofMasks(coupling);
  const weights: number[] = [];
  const ref: number[] = [],
    offsets = [0],
    solid: number[] = [],
    mpc: number[] = [],
    dofMask: number[] = [];
  for (let k = 0; k < coupling.ref.length; k++) {
    // A KINEMATIC coupling's reference point is INDEPENDENT — fixing it is the
    // whole point of a bolted or clamped reference point, not a conflict — so
    // only the couplings whose reference is dependent (distributing, relaxed
    // MPC) are dropped here.
    if (kinds[k] === 3 && fixedNodes.has(coupling.ref[k]))
      throw new Error(
        "A shell/solid transition node is prescribed. Move the support away from the transition or keep the body Solid.",
      );
    if (kinds[k] !== 2 && fixedNodes.has(coupling.ref[k])) continue;
    ref.push(coupling.ref[k]);
    for (let i = coupling.offsets[k]; i < coupling.offsets[k + 1]; i++) {
      solid.push(coupling.solid[i]);
      weights.push(coupling.weights ? coupling.weights[i] : 1);
    }
    offsets.push(solid.length);
    mpc.push(kinds[k]);
    dofMask.push(masks[k]);
  }
  return { ref, offsets, solid, mpc, dofMask, weights };
}

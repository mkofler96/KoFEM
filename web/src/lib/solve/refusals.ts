// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What a solve path cannot apply yet, in words for the user (KOF-353). A path
// that cannot honour a tie or an element order refuses the model by name rather
// than solve a different model; the panels show the same words before the run.

import type { TieDefinition } from "../tie.js";

// `tie "Tie1"`, or `2 ties ("Tie1", "Pin")`.
function namedTies(ties: TieDefinition[]): string {
  const names = ties.map((tie) => `"${tie.name}"`);
  return ties.length === 1
    ? `tie ${names[0]}`
    : `${ties.length} ties (${names.join(", ")})`;
}

// The topology optimizer applies no tie in any design domain: a tied assembly
// would be optimized as separate, disconnected parts.
export function topOptTieRefusal(
  ties: TieDefinition[] | undefined,
): string | null {
  if (!ties || ties.length === 0) return null;
  const them = ties.length === 1 ? "it" : "them";
  return `Topology optimization does not support ties yet, but this model has ${namedTies(ties)}. Delete ${them} to optimize.`;
}

// The Kirchhoff shell solver applies no tie: shell-to-shell ties need
// rotations and a mid-surface mapping of the picked faces.
export function shellTieRefusal(
  ties: TieDefinition[] | undefined,
): string | null {
  if (!ties || ties.length === 0) return null;
  const them = ties.length === 1 ? "it" : "them";
  return `The shell solver does not support ties yet, but this model has ${namedTies(ties)}. Delete ${them} to solve this shell model.`;
}

// Shell (DKT) facets are linear, and so are the tetrahedra the mixed
// shell/solid assembler couples to them.
export function shellOrderRefusal(elementOrder: number): string | null {
  if (elementOrder === 1) return null;
  return `Shell and mixed shell/solid models solve with linear elements only, but element order ${elementOrder} is selected. Set Element order to Linear in the Mesh panel.`;
}

// A coupling is an RBE2/RBE3 constraint, and only the coupled assembler applies
// one — the pure Kirchhoff shell solver has no couplings, and the coupled
// assembler needs a solid domain to assemble. An all-shell model therefore
// cannot carry a coupling, in the solve or the optimizer.
export function shellCouplingRefusal(couplingCount: number): string {
  return (
    `This model is all shell elements and declares ${couplingCount} surface-to-point ` +
    "coupling(s), which the shell solver cannot apply — a coupling needs the " +
    "coupled solid-shell assembler, and that needs at least one solid body. " +
    "Delete the coupling, or keep one body solid."
  );
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What a solve path cannot apply yet, in words for the user (KOF-353). A path
// that cannot honour a tie or an element order refuses the model by name rather
// than solve a different model; the panels show the same words before the run.

import type { TieDefinition } from "../tie.js";
import type { Element, SurfaceLoad } from "../../workers/solverTypes.js";
import { faceKey, loadableFaceKeys } from "../../store/boundaryRebuild.js";

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

// A solid model the Rust solver does not take (amgUnavailableReason). The C++
// solvers that once took these left the engine (KOF-309).
export function solidModelRefusal(reason: string): string {
  return `The solver cannot solve this model: ${reason}.`;
}

// A surface load the solve cannot apply in full (KOF-411): a selection that
// spans no face of the mesh, or a face that is not on the mesh boundary (nor
// a shell facet or a shell edge). Applying the rest would put a total force
// on a smaller area than the user picked, or drop the load, while the result
// looks plausible. Every solve path and the optimizer route through here, so
// none can apply such a load (routeSolve, routeTopOpt).
//
// Checked on the store payload rather than in the Rust module: the Solve
// panel runs this routing on the main thread, which does not load the Rust
// module, and the shell paths build no solid boundary in Rust at all.
export function surfaceLoadRefusal(
  elements: readonly Element[],
  surfaceLoads: readonly SurfaceLoad[] | undefined,
): string | null {
  if (!surfaceLoads || surfaceLoads.length === 0) return null;
  const loadable = loadableFaceKeys(elements);
  for (const [index, load] of surfaceLoads.entries()) {
    const name =
      load.name !== undefined
        ? `Load "${load.name}"`
        : `Surface load ${index + 1}`;
    const stale =
      // eslint-disable-next-line kofem/no-silent-fallback -- counted only for loads rebuilt from groups (boundaryRebuild); a load built from faces directly has no selection that can have gone stale
      load.unmatchedSelections !== undefined ? load.unmatchedSelections : 0;
    if (stale > 0 || load.faces.length === 0) {
      const counted =
        stale === 1
          ? "1 of its selections matches"
          : `${stale} of its selections match`;
      const what =
        load.faces.length === 0
          ? "so it would apply no load at all"
          : "so its total would act on the other selections alone";
      return (
        `${name}: ${stale > 0 ? counted : "its selection matches"} no face of the ` +
        `current mesh, ${what}. Re-pick the load on faces of the mesh.`
      );
    }
    const off = load.faces.filter(
      (face) => !loadable.has(faceKey(face)),
    ).length;
    if (off > 0)
      return (
        `${name}: ${off} of its ${load.faces.length} faces ${off === 1 ? "is" : "are"} ` +
        "not on the mesh boundary, so the rest would carry the whole load. Re-pick " +
        "the load on faces of the mesh."
      );
  }
  return null;
}

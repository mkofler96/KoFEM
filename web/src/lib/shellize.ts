// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Solid → shell idealisation used by the solver worker: find the thin walls of
// the body the user marked Shell, collapse them to a Kirchhoff shell mid-surface
// (per-wall thickness), keep the other bodies as solid tets, and build the inputs
// for the engine's coupled solve (engine/cpp/solve_coupled.cpp). The pipeline
// demonstrated in examples/shell-coupling/lib.mjs, in the app.
//
// This module is the public entry point; each stage lives in shellize/:
//   walls.ts        thin-wall detection (opposite planar CAD-face pairs)
//   midSurface.ts   collapse the walls to welded mid-surface facets
//   wallTets.ts     which solid tets the shell facets replace
//   transition.ts   cut retained solid at a wall root (physical footprint)
//   coupledModel.ts the coupled node pool and the couplings joining its domains
//   seam.ts, footprint.ts, ties.ts, partners.ts   how those couplings are found
//   couplingSet.ts  the CSR coupling set and operations on it
//   geometry.ts     mesh primitives shared by all of the above

export type { ShellizeMesh } from "./shellize/geometry.js";
export {
  extractThinWallShells,
  type ShellExtraction,
} from "./shellize/midSurface.js";
export { shellBodyTets, shellWallTets } from "./shellize/wallTets.js";
export {
  concatCouplings,
  couplingDofMasks,
  couplingMpcCodes,
  dropCouplingsOnFixedNodes,
  type CouplingSet,
} from "./shellize/couplingSet.js";
export {
  tieCouplingProblem,
  type TieCouplingDrop,
  type TieCouplingReport,
  type TieSurfaces,
} from "./shellize/ties.js";
export {
  buildCoupledModel,
  buildExplicitCoupledModel,
  isShellPoolIndex,
  shellNodeLocator,
  type CoupledModel,
  type ExplicitCoupledModel,
} from "./shellize/coupledModel.js";
export { buildShellTransitionModel } from "./shellize/transition.js";

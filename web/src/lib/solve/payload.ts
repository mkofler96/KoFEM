// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The static solve request for the model as it is in the store. The Solve
// panel (hooks/useSolver) and each level of the mesh refinement study
// (hooks/useRefinementStudy) send exactly this.

import type { ModelState } from "../../store/modelStore";
import type { SolvePayload } from "../../workers/solverTypes";

export type SolveSource = Pick<
  ModelState,
  | "nodes"
  | "elements"
  | "materials"
  | "properties"
  | "constraints"
  | "loads"
  | "surfaceLoads"
  | "temperature"
  | "elementOrder"
  | "solverMethod"
  | "tieGroups"
  | "couplingGroups"
  | "contactGroups"
  | "surfaceTriangles"
  | "surfaceFaceIds"
>;

export function solvePayload(s: SolveSource): SolvePayload {
  return {
    nodes: s.nodes,
    elements: s.elements,
    materials: s.materials,
    properties: s.properties,
    constraints: s.constraints,
    loads: s.loads,
    surfaceLoads: s.surfaceLoads,
    temperature: s.temperature,
    elementOrder: s.elementOrder,
    solverMethod: s.solverMethod,
    tieGroups: s.tieGroups,
    couplings: s.couplingGroups,
    contacts: s.contactGroups,
    // Surface mesh + CAD face ids drive auto-shell idealisation of thin
    // bodies in the worker's coupled solve.
    surfaceTriangles: s.surfaceTriangles,
    surfaceFaceIds: s.surfaceFaceIds,
  };
}

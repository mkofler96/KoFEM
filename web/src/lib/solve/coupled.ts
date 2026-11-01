// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Coupled solid-shell payload builder for the engine's coupled assembler
// (solve_coupled) and its coupled topology optimizer: a hand-mixed CTRIA3 +
// CTETRA model, or an all-solid model carrying a surface-to-point coupling. The
// auto-shell path (autoShell.ts) feeds the same assembler and reuses the
// coupling/BC packing here.

import type {
  Element,
  Property,
  SolvePayload,
} from "../../workers/solverTypes.js";
import { mixedCoupledMaterials } from "../coupledMaterials.js";
import { bodyMembership, tieLimit, tieSides } from "../tie.js";
import type { TieDefinition } from "../tie.js";
import {
  buildExplicitCoupledModel,
  concatCouplings,
  couplingDofMasks,
  couplingMpcCodes,
  dropCouplingsOnFixedNodes,
  tieCouplingProblem,
  type TieCouplingReport,
  type TieSurfaces,
} from "../shellize.js";
import { buildReferenceCouplings, referencePointIds } from "../coupling.js";
import { buildVertexIndexer, type VertexIndexer } from "../solveMeshPacking.js";
import {
  coupledFixedDofs,
  coupledLoads,
  type CoupledDirichlet,
} from "./bcs.js";

export type SolveLog = (line: string) => void;

// Relaxation factor ψ for the shell↔solid MPC coupling (Lu, Zhang & Yang 2023,
// "A Relaxed MPC Method for Non-rigid Shell to Solid Coupling", J. Phys.: Conf.
// Ser. 2528 012064). ψ ∈ [0.5, 1]: 1 is the classical rigid MPC, < 1 relaxes the
// rotation transfer to avoid the artificial over-stiffening of a fully rigid tie.
// The rigid translation tie (mpc = 1 in the coupling set) is ψ-independent and is
// what restores displacement continuity across the shell/solid seam.
export const SHELL_SOLID_MPC_RELAXATION = 1.0;

// The coupling set as solve_coupled takes it (CSR arrays + per-coupling codes).
export interface EngineCoupling {
  ref: Int32Array;
  offsets: Int32Array;
  solid: Int32Array;
  mpc: Int32Array;
  dof_mask: Int32Array;
  weights?: Float64Array;
  relaxation: number;
}

// The essential BCs and loads as solve_coupled takes them (DOF = 6·pool+dof).
export interface EngineCoupledBcs {
  fixed_dofs: Int32Array;
  prescribed_dofs: Int32Array;
  prescribed_vals: Float64Array;
  load_dofs: Int32Array;
  load_vals: Float64Array;
}

type CouplingSet = ReturnType<typeof concatCouplings>;

export function engineCoupling(coupling: CouplingSet): EngineCoupling {
  return {
    ref: Int32Array.from(coupling.ref),
    offsets: Int32Array.from(coupling.offsets),
    solid: Int32Array.from(coupling.solid),
    mpc: Int32Array.from(couplingMpcCodes(coupling)),
    weights: coupling.weights ? Float64Array.from(coupling.weights) : undefined,
    dof_mask: Int32Array.from(couplingDofMasks(coupling)),
    relaxation: SHELL_SOLID_MPC_RELAXATION,
  };
}

export function engineCoupledBcs(
  dirichlet: CoupledDirichlet,
  loads: { load_dofs: number[]; load_vals: number[] },
): EngineCoupledBcs {
  return {
    fixed_dofs: Int32Array.from(dirichlet.fixed_dofs),
    prescribed_dofs: Int32Array.from(dirichlet.prescribed_dofs),
    prescribed_vals: Float64Array.from(dirichlet.prescribed_vals),
    load_dofs: Int32Array.from(loads.load_dofs),
    load_vals: Float64Array.from(loads.load_vals),
  };
}

// The model's tie connections in the form the coupled builders take: the two
// picked surfaces as vertex indices, and how far the tie reaches. This is the
// ONLY thing that joins distinct solid bodies in a coupled model — nothing is
// inferred from the geometry — so a payload with no connections leaves the
// bodies apart, exactly as the all-solid path does.
export function coupledTies(
  tieGroups: TieDefinition[] | undefined,
  elements: Element[],
  vid: VertexIndexer,
): TieSurfaces[] {
  if (!tieGroups || tieGroups.length === 0) return [];
  // The same side resolution the weld path uses (tieSides), so a connection
  // means the same thing whichever solver ends up carrying it.
  const bodyOf = bodyMembership(elements);
  return tieGroups.map((tie) => {
    const sides = tieSides(tie, bodyOf);
    return {
      name: tie.name,
      verticesA: sides.a.map((nodeId) => vid(nodeId, "tie surface")),
      verticesB: sides.b.map((nodeId) => vid(nodeId, "tie surface")),
      maxSeparation: tieLimit(tie),
    };
  });
}

// Say what each tie connection contributed to a coupled model, and refuse one
// that contributed nothing. A declared connection that couples no node and shares
// none leaves the assembly split: the solve still runs and returns a
// plausible-looking but structurally wrong shape. This is the same refusal the
// all-solid weld path makes on its own reports (KOF-203) — a connection is a
// modelling statement, so failing to honour it is an error, not a silent skip.
export function reportTieCouplings(
  reports: TieCouplingReport[],
  log: SolveLog,
): void {
  for (const report of reports) {
    const problem = tieCouplingProblem(report);
    if (problem) throw new Error(problem);
    log(
      report.nCoupled === 0
        ? `Tie "${report.name}": already joined through ${report.nShared} shared node(s)`
        : `Tie "${report.name}": ${report.nCoupled} distributing coupling(s) onto ${report.nPartners} partner node(s) across a ${report.gap.toFixed(4)} mm gap${report.nShared > 0 ? `, ${report.nShared} node(s) already shared` : ""}`,
    );
  }
}

// Per-facet shell thickness from each CTRIA3 element's PSHELL property, in shell
// element order (matching the triangles handed to solve_coupled).
export function resolveMixedThicknesses(
  shellElements: Element[],
  properties: Property[],
): number[] {
  const propById = new Map(properties.map((p) => [p.id, p]));
  return shellElements.map((el) => {
    const prop = propById.get(el.propertyId);
    if (!prop)
      throw new Error(
        `mixed solve: shell element ${el.id} belongs to body ${el.propertyId}, ` +
          "which has no property — the model is inconsistent",
      );
    if (typeof prop.thickness !== "number" || prop.thickness <= 0)
      throw new Error(
        `mixed solve: property ${prop.id} has no positive shell thickness — ` +
          "shell (CTRIA3) elements require a thickness on their property",
      );
    return prop.thickness;
  });
}

// The mesh/coupling/BC/material payload the coupled solid-shell assembler takes,
// built from a store model — shared by the coupled SOLVE and the coupled
// topology optimizer (KOF-237), so both feed the assembler the identical model.
// The engine consumes design elements as solid tets first (in `solidElements`
// order) then shell facets (in `shellElements` order), which is the same order
// the density/von-Mises fields come back in.
export interface CoupledEngineInputs {
  mesh: {
    vertices: Float64Array;
    tets: Int32Array;
    triangles: Int32Array;
    thicknesses: Float64Array;
    attributes: Int32Array;
  };
  coupling: EngineCoupling;
  bcs: EngineCoupledBcs;
  matJson: string;
  model: ReturnType<typeof buildExplicitCoupledModel>;
  solidElements: Element[];
  shellElements: Element[];
  solidMaterialNames: string[];
  couplingCount: number;
  declaredCouplings: number;
}

// Build the coupled-assembler inputs for a hand-mixed shell+solid model (explicit
// CTRIA3 shells alongside CTETRA solids). The CTRIA3 elements become DKT shell
// facets (per-facet thickness from their PSHELL property), the CTETRA elements
// the solid tets, and the two domains are joined by RBE3 distributing couplings
// re-derived from proximity — the same pipeline the auto-shell path uses, only
// with the shells given explicitly instead of idealised from thin solid walls.
//
// An ALL-SOLID model comes here too when it carries a surface-to-point coupling:
// an RBE2/RBE3 constraint only exists in this assembler, and it is happy with
// zero shell triangles. Nothing else about the path changes — the shell arrays
// are simply empty.
export function buildCoupledEngineInputs(
  payload: SolvePayload,
  log: SolveLog,
): CoupledEngineInputs {
  const {
    nodes,
    elements,
    materials,
    properties,
    constraints,
    loads,
    surfaceLoads,
  } = payload;

  const shellElements = elements.filter((e) => e.type === "CTRIA3");
  const solidElements = elements.filter((e) => e.type !== "CTRIA3");
  const nonTet = solidElements.find((e) => e.type !== "CTETRA");
  if (nonTet)
    throw new Error(
      `mixed solve: solid element ${nonTet.id} is a ${nonTet.type} — the coupled ` +
        "solid-shell solver supports CTETRA solids only; mesh the solid bodies as tetrahedra",
    );
  if (solidElements.length === 0)
    throw new Error(
      "mixed solve: no solid (CTETRA) elements — a mixed model needs at least one solid body",
    );

  const vid = buildVertexIndexer(nodes);
  const verts = new Array<number>(3 * nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    verts[3 * i] = nodes[i].x;
    verts[3 * i + 1] = nodes[i].y;
    verts[3 * i + 2] = nodes[i].z;
  }
  const solidTets: number[] = [];
  for (const el of solidElements) {
    if (el.nodeIds.length !== 4)
      throw new Error(
        `CTETRA element ${el.id} has ${el.nodeIds.length} nodes — expected 4`,
      );
    for (const nid of el.nodeIds) solidTets.push(vid(nid, "CTETRA element"));
  }
  const shellTris: number[] = [];
  for (const el of shellElements) {
    if (el.nodeIds.length !== 3)
      throw new Error(
        `CTRIA3 element ${el.id} has ${el.nodeIds.length} nodes — expected 3`,
      );
    for (const nid of el.nodeIds) shellTris.push(vid(nid, "CTRIA3 element"));
  }
  const thicknesses = resolveMixedThicknesses(shellElements, properties);

  // Reference points belong to no element, so they enter the pool explicitly.
  const couplings = payload.couplings ?? [];
  const refIds = referencePointIds(couplings);
  const model = buildExplicitCoupledModel(
    verts,
    solidTets,
    shellTris,
    thicknesses,
    {
      ties: coupledTies(payload.tieGroups, elements, vid),
      referencePoints: [...refIds].map((nodeId) =>
        vid(nodeId, "coupling reference point"),
      ),
    },
  );
  reportTieCouplings(model.tieReports, log);

  const poolOf = (nodeId: number): number => {
    const pi = model.poolOfVertex.get(vid(nodeId, "coupled bc/load"));
    if (pi === undefined)
      throw new Error(
        `mixed solve: node ${nodeId} carries a boundary condition or load but is not part of ` +
          "any shell or solid element — the model is inconsistent",
      );
    return pi;
  };
  const refPoolIndices = new Set([...refIds].map((nodeId) => poolOf(nodeId)));
  const isRefPoint = (pi: number) => refPoolIndices.has(pi);
  const dirichlet = coupledFixedDofs(
    constraints,
    poolOf,
    (pi) => model.shellPoolIndex.has(pi),
    isRefPoint,
  );
  // A clamped or driven shell node that also sits within coupling range of the
  // solid would be both constrained and a distributing-coupling dependent — the
  // engine refuses that (#377/KOF-210). The BC wins; drop the coupling on those
  // nodes.
  const coupling = concatCouplings(
    dropCouplingsOnFixedNodes(model.coupling, [
      ...dirichlet.fixed_dofs,
      ...dirichlet.prescribed_dofs,
    ]),
    buildReferenceCouplings(couplings, (nodeId, context) => {
      const pi = model.poolOfVertex.get(vid(nodeId, context));
      if (pi === undefined)
        throw new Error(
          `${context}: node ${nodeId} is not part of the solved model — re-pick the ` +
            "coupled surface, or delete the coupling.",
        );
      return pi;
    }),
  );
  const nodalLoads = coupledLoads(
    loads,
    surfaceLoads,
    poolOf,
    isRefPoint,
    nodes,
    vid,
  );
  const { mat, solidAttributes, solidMaterialNames } = mixedCoupledMaterials(
    materials,
    properties,
    shellElements,
    solidElements,
  );

  return {
    mesh: {
      vertices: Float64Array.from(model.pool),
      tets: Int32Array.from(model.tets),
      triangles: Int32Array.from(model.triangles),
      thicknesses: Float64Array.from(model.thicknesses),
      attributes: Int32Array.from(solidAttributes),
    },
    coupling: engineCoupling(coupling),
    bcs: engineCoupledBcs(dirichlet, nodalLoads),
    matJson: JSON.stringify(mat),
    model,
    solidElements,
    shellElements,
    solidMaterialNames,
    couplingCount: coupling.ref.length,
    declaredCouplings: couplings.length,
  };
}

// Map a coupled-assembler result back onto the store model. Displacements: every
// store node maps to its pool node (solid and shell store nodes both live in the
// pool). Von Mises: one solid-tet value per CTETRA and one shell-facet value per
// CTRIA3, in the order they crossed the WASM boundary (solid tets first, then
// shell triangles) — walk the original element list and pull from whichever
// field the element type selects.
export function mapMixedResult(
  payload: Pick<SolvePayload, "nodes" | "elements">,
  model: CoupledEngineInputs["model"],
  result: {
    displacements: Float64Array;
    von_mises_tets: Float64Array;
    von_mises_tris: Float64Array;
  },
): { displacements: Float64Array; vonMises: Float64Array } {
  const { nodes, elements } = payload;
  const displacements = new Float64Array(3 * nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    // A node in no element is not part of the solve; it stays at rest (u = 0).
    const pi = model.poolOfVertex.get(i);
    if (pi === undefined) continue;
    displacements[3 * i] = result.displacements[3 * pi];
    displacements[3 * i + 1] = result.displacements[3 * pi + 1];
    displacements[3 * i + 2] = result.displacements[3 * pi + 2];
  }
  const vonMises = new Float64Array(elements.length);
  let solidIdx = 0,
    shellIdx = 0;
  for (let e = 0; e < elements.length; e++) {
    vonMises[e] =
      elements[e].type === "CTRIA3"
        ? result.von_mises_tris[shellIdx++]
        : result.von_mises_tets[solidIdx++];
  }
  return { displacements, vonMises };
}

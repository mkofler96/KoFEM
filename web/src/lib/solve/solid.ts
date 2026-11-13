// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// All-solid (CTETRA/CHEXA) payload builder for the engine's linear-elastic
// solve (solve_linear_elastic) and its solid topology optimizer, plus the ties
// that join solid bodies for the static solve — welded (node-merge) or
// constrained (MPC), per connection. Constraint ties are solved by the Rust
// module only (lib/solve/amg.ts, crates/kofem-fem/src/tie.rs).

import type {
  Constraint,
  Element,
  Load,
  Material,
  Node,
  Property,
  SurfaceLoad,
} from "../../workers/solverTypes.js";
import type { SolveMesh } from "../../wasm/pkg/kofem_wasm.js";
import {
  buildTie,
  remapElement,
  assertValidTiedMesh,
  tiedId,
  expandToOriginalNodes,
  tieMethod,
  type TieDefinition,
  type TieResult,
} from "../tie.js";
import {
  tieConstraints,
  type TieConstraint,
  type TieWeighting,
} from "../tieConstraints.js";
import {
  buildVertexIndexer,
  packSolveMesh,
  resolveMaterials,
  groupDirichlet,
  groupPointLoads,
  type VertexIndexer,
} from "../solveMeshPacking.js";
import { surfaceLoadsToVertices } from "./bcs.js";

export interface SolidEngineInputs {
  mesh: SolveMesh;
  matJson: string;
  bcsJson: string;
  // Design elements in the order they cross the WASM boundary: tets, then hexes.
  elementCount: number;
}

// The solid model the solid engine entries take. `vid` indexes element
// connectivity; `refVid` resolves every stored node reference (constraints,
// loads, surface-load faces), which a tie remaps to its representative first.
export function buildSolidEngineInputs(
  model: {
    nodes: Node[];
    elements: Element[];
    materials: Material[];
    properties: Property[];
    constraints: Constraint[];
    loads: Load[];
    surfaceLoads?: SurfaceLoad[];
  },
  vid: VertexIndexer,
  refVid: VertexIndexer = vid,
): SolidEngineInputs {
  // Tets and hexs cross the WASM boundary as separate arrays (tets first) —
  // the per-element material attributes must follow the same order.
  const tetElements = model.elements.filter((e) => e.type === "CTETRA");
  const hexElements = model.elements.filter((e) => e.type === "CHEXA");
  const mesh = packSolveMesh(model.nodes, tetElements, hexElements, vid);
  const { materials: engineMaterials, attributes } = resolveMaterials(
    [...tetElements, ...hexElements],
    model.materials,
    model.properties,
  );
  mesh.attributes = attributes;

  const bcs = {
    ...groupDirichlet(model.constraints, refVid),
    point_loads: groupPointLoads(model.loads, refVid),
    surface_loads: surfaceLoadsToVertices(model.surfaceLoads, refVid),
  };
  return {
    mesh,
    matJson: JSON.stringify(engineMaterials),
    bcsJson: JSON.stringify(bcs),
    elementCount: tetElements.length + hexElements.length,
  };
}

// Constraint ties as the Rust solver's CSR tables (kofem-wasm `Ties`): vertex
// slaves[k] follows masters[offsets[k]..offsets[k+1]) with the matching
// weights. A master that a node-merge tie welded away resolves to its
// representative through `refVid`.
export function rustTieTables(
  constraints: TieConstraint[],
  refVid: VertexIndexer,
): {
  slaves: Uint32Array;
  offsets: Uint32Array;
  masters: Uint32Array;
  weights: Float64Array;
} {
  const slaves: number[] = [];
  const offsets: number[] = [0];
  const masters: number[] = [];
  const weights: number[] = [];
  for (const constraint of constraints) {
    slaves.push(refVid(constraint.slaveId, "tie constraint"));
    constraint.masterIds.forEach((masterId, k) => {
      masters.push(refVid(masterId, "tie constraint"));
      weights.push(constraint.weights[k]);
    });
    offsets.push(masters.length);
  }
  return {
    slaves: Uint32Array.from(slaves),
    offsets: Uint32Array.from(offsets),
    masters: Uint32Array.from(masters),
    weights: Float64Array.from(weights),
  };
}

// The solve model after its ties are applied: the representative node set left
// by the node-merge ties (#359), the elements remapped onto it, indexers for
// both, and the equations of the constraint ties (#357), which move nothing.
export interface TiedSolidModel {
  tie: TieResult;
  constraints: TieConstraint[];
  solveNodes: Node[];
  tiedElements: Element[];
  vid: VertexIndexer;
  vidTied: VertexIndexer;
}

// Apply every connection the user defined, so parts that touch without a shared
// face are joined for the solve: node-merge connections weld node pairs,
// constraint connections tie nodes to the opposite surface. A no-op when the
// model has none, in which case solveNodes/tiedElements are the originals. A
// connection that joins nothing AND shares no nodes leaves the assembly split
// and the solve would fail far from the cause, so it is refused.
//
// `weighting` is how constraint ties weigh their nodes, picked by the solve's
// element order (tieWeighting in ./tieMortar.ts). A model with constraint ties
// needs it; one with node-merge ties only does not.
export function weldTies(
  nodes: Node[],
  elements: Element[],
  tieGroups: TieDefinition[] | undefined,
  log: (line: string) => void,
  weighting: TieWeighting | null = null,
): TiedSolidModel {
  const ties = tieGroups ?? [];
  const constraintTies = ties.filter((group) => tieMethod(group) === "mpc");
  if (constraintTies.length > 0 && weighting === null)
    throw new Error(
      `Tie "${constraintTies[0].name}" joins its surfaces by constraint, but this ` +
        "solve has no tie weighting — constraint ties are solved by the Rust solver only",
    );
  const tie = buildTie(
    nodes,
    elements,
    ties.filter((group) => tieMethod(group) === "merge"),
  );
  const solveNodes = tie.nodes;
  const tiedElements =
    tie.repOf.size > 0
      ? elements.map((el) => remapElement(el, tie.repOf))
      : elements;
  assertValidTiedMesh(nodes, elements, tie);
  const refuseEmpty = (report: { name: string }) => {
    throw new Error(
      `Tie "${report.name}" connected no nodes — its two surfaces have no ` +
        "nodes within the search distance of each other. Increase the " +
        "distance, or couple the full surface.",
    );
  };
  for (const report of tie.reports) {
    if (report.nPaired === 0 && report.nShared === 0) refuseEmpty(report);
    log(
      `Tie "${report.name}": welded ${report.nPaired} node pair(s) up to ${report.maxDistance.toFixed(4)} mm apart${report.nShared > 0 ? `, ${report.nShared} already shared` : ""}`,
    );
  }
  if (tie.nWelded > 0)
    log(
      `Ties merged ${tie.nWelded} node(s); ${solveNodes.length} nodes remain`,
    );

  // Constraint ties are found on the ORIGINAL mesh — they move no node — and
  // leave alone the nodes a node-merge tie has already welded.
  const welded = new Set<number>();
  for (const pair of tie.pairs) welded.add(pair.aId).add(pair.bId);
  const constrained =
    weighting === null
      ? { constraints: [], reports: [] }
      : tieConstraints(nodes, elements, constraintTies, weighting, welded);
  for (const report of constrained.reports) {
    if (report.nPaired === 0 && report.nShared === 0) refuseEmpty(report);
    log(
      `Tie "${report.name}": constrained ${report.nPaired} node(s) to the opposite surface, up to ${report.maxDistance.toFixed(4)} mm away${report.nShared > 0 ? `, ${report.nShared} already shared` : ""}`,
    );
  }

  const vid = buildVertexIndexer(solveNodes);
  // Every stored node reference is an ORIGINAL node id; map it through the tie
  // to its representative before resolving to a solve vertex index.
  const vidTied: VertexIndexer = (nodeId, context) =>
    vid(tiedId(tie.repOf, nodeId), context);
  return {
    tie,
    constraints: constrained.constraints,
    solveNodes,
    tiedElements,
    vid,
    vidTied,
  };
}

// The engine returns one displacement per SOLVE node (tied set). Expand back to
// one per ORIGINAL store node — a merged-away node takes its representative's
// displacement — so the result overlays the original mesh. When nothing was
// welded this is a straight pass-through (zero-copy).
export function expandTiedDisplacements(
  nodes: Node[],
  tied: TiedSolidModel,
  displacements: Float64Array,
): Float64Array {
  return tied.tie.nWelded > 0
    ? expandToOriginalNodes(
        nodes,
        tied.solveNodes,
        tied.tie.repOf,
        displacements,
        3,
      )
    : displacements;
}

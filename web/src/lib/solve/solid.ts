// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// All-solid (CTETRA/CHEXA) payload builder for the engine's linear-elastic
// solve (solve_linear_elastic) and its solid topology optimizer, plus the tie
// welding that joins solid bodies for the static solve.

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
  assertNoCollapsedElements,
  tiedId,
  expandToOriginalNodes,
  type TieDefinition,
  type TieResult,
} from "../tie.js";
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

// The solve model after tie welding (#359): the representative node set, the
// elements remapped onto it, and indexers for both.
export interface TiedSolidModel {
  tie: TieResult;
  solveNodes: Node[];
  tiedElements: Element[];
  vid: VertexIndexer;
  vidTied: VertexIndexer;
}

// Weld the node pairs of every connection the user defined, so parts that touch
// without a shared face are joined for the solve. A no-op when the model has
// none, in which case solveNodes/tiedElements are the originals. A connection
// that welds nothing AND shares no nodes joins nothing: the assembly stays split
// and the solve would fail far from the cause, so it is refused.
export function weldTies(
  nodes: Node[],
  elements: Element[],
  tieGroups: TieDefinition[] | undefined,
  log: (line: string) => void,
): TiedSolidModel {
  const tie = buildTie(nodes, elements, tieGroups ?? []);
  const solveNodes = tie.nodes;
  const tiedElements =
    tie.repOf.size > 0
      ? elements.map((el) => remapElement(el, tie.repOf))
      : elements;
  if (tie.repOf.size > 0) assertNoCollapsedElements(tiedElements);
  for (const report of tie.reports) {
    if (report.nPaired === 0 && report.nShared === 0)
      throw new Error(
        `Tie "${report.name}" connected no nodes — its two surfaces have no ` +
          "node pairs within the search distance. Increase the distance, or " +
          "couple the full surface.",
      );
    log(
      `Tie "${report.name}": welded ${report.nPaired} node pair(s) up to ${report.maxDistance.toFixed(4)} mm apart${report.nShared > 0 ? `, ${report.nShared} already shared` : ""}`,
    );
  }
  if (tie.nWelded > 0)
    log(
      `Ties merged ${tie.nWelded} node(s); ${solveNodes.length} nodes remain`,
    );

  const vid = buildVertexIndexer(solveNodes);
  // Every stored node reference is an ORIGINAL node id; map it through the tie
  // to its representative before resolving to a solve vertex index.
  const vidTied: VertexIndexer = (nodeId, context) =>
    vid(tiedId(tie.repOf, nodeId), context);
  return { tie, solveNodes, tiedElements, vid, vidTied };
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

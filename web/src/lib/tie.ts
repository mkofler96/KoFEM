// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Node-merge ("bonded tie") between two EXPLICITLY SELECTED surfaces — the
// connector condition the user defines in the Constraints panel, alongside the
// fixed displacements and the loads.
//
// It replaces the former model-wide "tie distance" (issue #359), which welded
// every near-contact node pair of every pair of bodies at once: a single number
// with no visible extent, no name, and nothing in the viewport showing what it
// had joined. A tie is now a named object with two picked surfaces, so what is
// connected to what is a modelling decision the user states and can see.
//
// Each connection welds pairs of nodes — one from surface A, one from surface B
// — into one shared node, fusing the meshes over the contact patch so load
// transfers and the assembly is solvable. Two extents:
//
//   "full"   — every mutual-nearest pair across the two surfaces is welded,
//              whatever the gap. The whole selected surface is coupled.
//   "region" — only pairs closer than `searchDistance` are welded, so a tie can
//              be limited to the part of the surface that actually touches
//              (a pin resting in a hook eye touches along a tangent line, not
//              over the whole cylinder).
//
// This is an approximation — it pulls the two surfaces together within the
// pairing distance and stiffens the joint locally — adequate for the overall
// load path but not for accurate local contact stress. A geometry-preserving
// MPC tie is the accurate follow-up (issue tracked separately).

import { SpatialGrid } from "./spatialGrid.js";

export type TieExtent = "full" | "region";

export interface TieNode {
  id: number;
  x: number;
  y: number;
  z: number;
}

export interface TieElement {
  nodeIds: number[];
  propertyId: number;
}

// The structural minimum of a tie connection the weld needs. The store's
// TieGroup (tieSlice) satisfies it, and so does the solve payload.
export interface TieDefinition {
  name: string;
  facesA: { nodeIds: number[] }[];
  facesB: { nodeIds: number[] }[];
  extent: TieExtent;
  searchDistance: number;
}

// One welded node pair, in ORIGINAL node ids — what the viewport draws to show
// which nodes a connection actually joined.
export interface TiePair {
  // Name of the connection that welded the pair.
  tie: string;
  aId: number;
  bId: number;
  distance: number;
}

// Per-connection outcome, for the solver log and for the panel's summary.
export interface TieReport {
  name: string;
  nPaired: number;
  // Nodes the two surfaces already have in common (a conforming interface):
  // they need no weld, and a connection that finds only these is not an error.
  nShared: number;
  maxDistance: number;
}

export interface TieResult {
  // Representative nodes only (merged-away partners removed), positions averaged
  // over each welded pair. This is the node set the solve runs on.
  nodes: TieNode[];
  // Original node id → representative node id, for every node that was merged
  // away. Roots keep their own id and are absent (use `tiedId` below).
  repOf: Map<number, number>;
  // How many nodes were merged away (original count − representative count).
  nWelded: number;
  pairs: TiePair[];
  reports: TieReport[];
}

// Representative id of an original node id (identity when it was not merged).
export function tiedId(repOf: Map<number, number>, nodeId: number): number {
  return repOf.get(nodeId) ?? nodeId;
}

// Distance limit a connection pairs within: its search distance in "region"
// extent, unbounded when the whole surface is coupled.
export function tieLimit(tie: TieDefinition): number {
  return tie.extent === "region" ? tie.searchDistance : Infinity;
}

function nodeIdsOf(faces: { nodeIds: number[] }[]): Set<number> {
  const ids = new Set<number>();
  for (const face of faces) for (const id of face.nodeIds) ids.add(id);
  return ids;
}

// Bodies (property ids) that use each node. A node on a conforming interface
// belongs to several bodies; an ordinary surface node to one.
export function bodyMembership(
  elements: TieElement[],
): Map<number, Set<number>> {
  const bodies = new Map<number, Set<number>>();
  for (const el of elements)
    for (const nodeId of el.nodeIds) {
      let set = bodies.get(nodeId);
      if (!set) bodies.set(nodeId, (set = new Set()));
      set.add(el.propertyId);
    }
  return bodies;
}

// The two node sets a connection actually joins.
//
// Normally they are just the two picked surfaces minus whatever they have in
// common (nodes already shared by both are one node — nothing to join).
//
// A NEARLY-CONFORMAL interface cannot be picked that way: where a pin sits in a
// hook eye the two surfaces are coincident, the mesher gives them a single CAD
// face, and one click selects both bodies' nodes at once. There the sides are
// separated by BODY instead — the two bodies with the most nodes in the pick
// become the two sides. That is not a guess about whether the parts are joined
// (creating the connection said so), only about which side of it each node is
// on, which is a fact about the mesh. It is what makes the pin/hook tie of the
// crane assembly expressible at all: 30 of its ~1000 interface nodes are shared,
// and the rest split cleanly 564 / 445 between hook and pin.
export function tieSides(
  tie: TieDefinition,
  bodyOf: Map<number, Set<number>>,
): { a: number[]; b: number[]; nShared: number } {
  const idsA = nodeIdsOf(tie.facesA);
  const idsB = nodeIdsOf(tie.facesB);
  const shared = [...idsA].filter((id) => idsB.has(id));
  const exclusiveA = [...idsA].filter((id) => !idsB.has(id));
  const exclusiveB = [...idsB].filter((id) => !idsA.has(id));
  if (exclusiveA.length > 0 && exclusiveB.length > 0)
    return { a: exclusiveA, b: exclusiveB, nShared: shared.length };

  // The picks coincide — separate them by body.
  const perBody = new Map<number, number[]>();
  for (const id of new Set([...idsA, ...idsB])) {
    const bodies = bodyOf.get(id);
    if (!bodies || bodies.size !== 1) continue; // shared by bodies ⇒ already joined
    const body = [...bodies][0];
    let list = perBody.get(body);
    if (!list) perBody.set(body, (list = []));
    list.push(id);
  }
  const ranked = [...perBody.values()].sort(
    (first, second) => second.length - first.length,
  );
  if (ranked.length < 2) return { a: [], b: [], nShared: shared.length };
  return { a: ranked[0], b: ranked[1], nShared: shared.length };
}

// ── Nearest-partner search ────────────────────────────────────────────────────
//
// A uniform grid over the candidate set, scanned in Chebyshev shells around the
// query cell. A point in a shell at index-distance r is at least (r−1)·cell
// away, so once shell r is done every unscanned point is ≥ r·cell out and the
// best hit so far is final. That termination rule is what lets the SAME search
// serve both extents: "region" additionally stops as soon as r·cell exceeds the
// search distance, "full" runs until the grid is exhausted.

interface PointGrid {
  cell: number;
  candidates: SpatialGrid<number>;
  maxShell: number;
}

function buildPointGrid(points: TieNode[], limit: number): PointGrid {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    minZ = Math.min(minZ, point.z);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
    maxZ = Math.max(maxZ, point.z);
  }
  const span = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  // Aim for a handful of points per cell — the grid is sparse (a Map), so empty
  // cells cost nothing, while a cell far bigger than the node spacing would make
  // every shell scan quadratic.
  const spacing = span / Math.max(1, Math.cbrt(points.length));
  // A search distance smaller than that spacing must not force wide shells:
  // clamping the cell to the limit keeps "region" ties at one or two shells.
  const cell = Math.max(
    Number.isFinite(limit) ? Math.min(spacing, limit) : spacing,
    1e-9,
  );

  const candidates = new SpatialGrid(
    points.map((_, index) => index),
    (index) => [points[index].x, points[index].y, points[index].z],
    cell,
  );
  return { cell, candidates, maxShell: Math.ceil(span / cell) + 1 };
}

// Index of the point nearest `from` within `limit`, or -1 when none is in reach.
function nearestInGrid(
  grid: PointGrid,
  points: TieNode[],
  from: TieNode,
  limit: number,
): number {
  const { cell, candidates, maxShell } = grid;
  const limit2 = Number.isFinite(limit) ? limit * limit : Infinity;

  let best = -1;
  let bestDist2 = Infinity;
  const consider = (idx: number) => {
    const dx = points[idx].x - from.x;
    const dy = points[idx].y - from.y;
    const dz = points[idx].z - from.z;
    const dist2 = dx * dx + dy * dy + dz * dz;
    if (dist2 <= limit2 && dist2 < bestDist2) {
      bestDist2 = dist2;
      best = idx;
    }
  };

  for (let shell = 0; shell <= maxShell; shell++) {
    const reach = shell * cell;
    if (reach > limit) break; // nothing left inside the search distance
    for (const idx of candidates.candidates(
      [from.x, from.y, from.z],
      shell,
      shell,
    ))
      consider(idx);
    // Everything unscanned is now at least shell·cell away.
    if (best >= 0 && bestDist2 <= reach * reach) break;
  }
  return best;
}

// ── Pairing ───────────────────────────────────────────────────────────────────

// Welded node pairs of one connection, plus what it found.
//
// Pairing is by MUTUAL nearest neighbour (a↔b only when each is the other's
// nearest across the interface), which makes every weld a disjoint 1:1 pair
// rather than a chain. (Welding every in-range pair would chain a node
// reachable from two others of one element into a zero-volume tet.) A disjoint
// pair can still damage the mesh when it bridges a wide gap — both sides may
// belong to one element, or the midpoint may tangle its neighbours — which
// assertValidTiedMesh refuses after the weld.
function pairOneTie(
  tie: TieDefinition,
  nodeById: Map<number, TieNode>,
  bodyOf: Map<number, Set<number>>,
): { pairs: TiePair[]; report: TieReport } {
  const { a: idsA, b: idsB, nShared } = tieSides(tie, bodyOf);

  const resolve = (ids: number[]): TieNode[] => {
    const out: TieNode[] = [];
    for (const id of ids) {
      const node = nodeById.get(id);
      if (!node)
        throw new Error(
          `Tie "${tie.name}" references node ${id}, which is not in the mesh — ` +
            "re-pick its surfaces after remeshing",
        );
      out.push(node);
    }
    return out;
  };
  const sideA = resolve(idsA);
  const sideB = resolve(idsB);

  const limit = tieLimit(tie);
  const empty: TieReport = {
    name: tie.name,
    nPaired: 0,
    nShared,
    maxDistance: 0,
  };
  if (sideA.length === 0 || sideB.length === 0)
    return { pairs: [], report: empty };

  const gridB = buildPointGrid(sideB, limit);
  const gridA = buildPointGrid(sideA, limit);
  const nearestOfA = sideA.map((node) =>
    nearestInGrid(gridB, sideB, node, limit),
  );
  const nearestOfB = sideB.map((node) =>
    nearestInGrid(gridA, sideA, node, limit),
  );

  const pairs: TiePair[] = [];
  let maxDistance = 0;
  for (let ia = 0; ia < sideA.length; ia++) {
    const ib = nearestOfA[ia];
    if (ib < 0 || nearestOfB[ib] !== ia) continue; // not mutual → not a weld
    const distance = Math.hypot(
      sideA[ia].x - sideB[ib].x,
      sideA[ia].y - sideB[ib].y,
      sideA[ia].z - sideB[ib].z,
    );
    maxDistance = Math.max(maxDistance, distance);
    pairs.push({
      tie: tie.name,
      aId: sideA[ia].id,
      bId: sideB[ib].id,
      distance,
    });
  }

  return {
    pairs,
    report: { name: tie.name, nPaired: pairs.length, nShared, maxDistance },
  };
}

// Welded node pairs of every connection. Exported on its own because the
// viewport draws exactly this — the nodes each tie joined, and to what — without
// needing the collapsed solve mesh.
//
// A node already welded by an earlier connection is not welded again, so every
// weld stays a disjoint pair across connections too (see pairOneTie).
export function tiedNodePairs(
  nodes: TieNode[],
  elements: TieElement[],
  ties: TieDefinition[],
): { pairs: TiePair[]; reports: TieReport[] } {
  const nodeById = new Map<number, TieNode>();
  for (const node of nodes) nodeById.set(node.id, node);
  const bodyOf = bodyMembership(elements);

  const welded = new Set<number>();
  const pairs: TiePair[] = [];
  const reports: TieReport[] = [];
  for (const tie of ties) {
    const one = pairOneTie(tie, nodeById, bodyOf);
    let kept = 0;
    for (const pair of one.pairs) {
      if (welded.has(pair.aId) || welded.has(pair.bId)) continue;
      welded.add(pair.aId);
      welded.add(pair.bId);
      pairs.push(pair);
      kept++;
    }
    reports.push({ ...one.report, nPaired: kept });
  }
  return { pairs, reports };
}

// Collapse each welded pair to one representative node at the average of its
// members' positions, and record the original → representative id remap.
function collapseWeldedPairs(nodes: TieNode[], pairs: TiePair[]): TieResult {
  const partnerOf = new Map<number, number>();
  for (const pair of pairs) {
    partnerOf.set(pair.aId, pair.bId);
    partnerOf.set(pair.bId, pair.aId);
  }

  const repOf = new Map<number, number>();
  const outNodes: TieNode[] = [];
  const positionById = new Map<number, TieNode>();
  for (const node of nodes) positionById.set(node.id, node);

  const merged = new Set<number>();
  for (const node of nodes) {
    const partnerId = partnerOf.get(node.id);
    if (partnerId === undefined) {
      outNodes.push(node);
      continue;
    }
    if (merged.has(node.id)) continue; // this pair's representative is out already
    const partner = positionById.get(partnerId);
    if (!partner)
      throw new Error(
        `tie: welded node ${partnerId} is not in the mesh — the tie and the mesh disagree`,
      );
    merged.add(partnerId);
    repOf.set(partnerId, node.id);
    outNodes.push({
      id: node.id,
      x: 0.5 * (node.x + partner.x),
      y: 0.5 * (node.y + partner.y),
      z: 0.5 * (node.z + partner.z),
    });
  }

  return {
    nodes: outNodes,
    repOf,
    nWelded: nodes.length - outNodes.length,
    pairs,
    reports: [],
  };
}

// Weld the node pairs of every tie connection. An empty connection list is a
// no-op (returns the mesh unchanged), so a model with no ties is untouched.
export function buildTie(
  nodes: TieNode[],
  elements: TieElement[],
  ties: TieDefinition[],
): TieResult {
  if (ties.length === 0)
    return { nodes, repOf: new Map(), nWelded: 0, pairs: [], reports: [] };

  const { pairs, reports } = tiedNodePairs(nodes, elements, ties);
  return { ...collapseWeldedPairs(nodes, pairs), reports };
}

// Remap an element's connectivity onto the tied (representative) node ids.
export function remapElement<T extends TieElement>(
  el: T,
  repOf: Map<number, number>,
): T {
  if (repOf.size === 0) return el;
  return { ...el, nodeIds: el.nodeIds.map((id) => tiedId(repOf, id)) };
}

// ── Post-weld mesh check ──────────────────────────────────────────────────────
//
// Mutual-nearest pairing keeps every weld a disjoint 1:1 pair, but it does not
// keep the mesh valid: a weld moves both nodes to their midpoint, so a pair that
// bridges a gap wider than the local element size drags the elements beside it
// out of shape. Three failures are possible, and each is refused here with the
// tie and the gap it bridged, before the engine sees the mesh:
//
//   collapsed   — the pair shares an element, which degenerates to zero volume.
//   non-manifold — a triangle or quad ends up shared by three elements; MFEM
//                  aborts on it ("Invalid mesh topology", KOF-298).
//   inverted    — an element turns inside out. MFEM's orientation fix would
//                  silently flip it back, leaving a tangled mesh and a wrong
//                  result instead of an error.
//
// Only elements that contain a welded node can change, so only they are checked.

// Corner tets whose signed volume tracks an element's orientation: the tet
// itself, or each hex corner with its three edge neighbours (CHEXA order, 0–3
// bottom, 4–7 top).
const TET_CORNERS: readonly (readonly [number, number, number, number])[] = [
  [0, 1, 2, 3],
];
const HEX_CORNERS: readonly (readonly [number, number, number, number])[] = [
  [0, 1, 3, 4],
  [1, 2, 0, 5],
  [2, 3, 1, 6],
  [3, 0, 2, 7],
  [4, 7, 5, 0],
  [5, 4, 6, 1],
  [6, 5, 7, 2],
  [7, 6, 4, 3],
];
const TET_FACES: readonly (readonly number[])[] = [
  [0, 1, 2],
  [0, 1, 3],
  [0, 2, 3],
  [1, 2, 3],
];
const HEX_FACES: readonly (readonly number[])[] = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [1, 2, 6, 5],
  [2, 3, 7, 6],
  [3, 0, 4, 7],
];

function elementShape(el: TieElement): {
  corners: readonly (readonly [number, number, number, number])[];
  faces: readonly (readonly number[])[];
} {
  if (el.nodeIds.length === 4)
    return { corners: TET_CORNERS, faces: TET_FACES };
  if (el.nodeIds.length === 8)
    return { corners: HEX_CORNERS, faces: HEX_FACES };
  throw new Error(
    `tie: cannot check an element with ${el.nodeIds.length} nodes next to a ` +
      "weld — ties support 4-node tetrahedra and 8-node hexahedra",
  );
}

function signedVolume(
  nodeIds: number[],
  corner: readonly [number, number, number, number],
  positionOf: (id: number) => TieNode,
): number {
  const [p, q, r, s] = corner.map((k) => positionOf(nodeIds[k]));
  const ux = q.x - p.x,
    uy = q.y - p.y,
    uz = q.z - p.z;
  const vx = r.x - p.x,
    vy = r.y - p.y,
    vz = r.z - p.z;
  const wx = s.x - p.x,
    wy = s.y - p.y,
    wz = s.z - p.z;
  return (
    ux * (vy * wz - vz * wy) -
    uy * (vx * wz - vz * wx) +
    uz * (vx * wy - vy * wx)
  );
}

// Refuse a weld that leaves the solve mesh invalid (see above). `nodes` and
// `elements` are the mesh before the weld, `tie` the result of buildTie on it.
export function assertValidTiedMesh(
  nodes: TieNode[],
  elements: TieElement[],
  tie: TieResult,
): void {
  if (tie.repOf.size === 0) return;

  // Which connection each welded node belongs to, to name it in the error.
  const tieOfNode = new Map<number, string>();
  const pairsOfTie = new Map<string, TiePair[]>();
  for (const pair of tie.pairs) {
    tieOfNode.set(pair.aId, pair.tie);
    tieOfNode.set(pair.bId, pair.tie);
    let list = pairsOfTie.get(pair.tie);
    if (!list) pairsOfTie.set(pair.tie, (list = []));
    list.push(pair);
  }

  const before = new Map<number, TieNode>();
  for (const node of nodes) before.set(node.id, node);
  const after = new Map<number, TieNode>();
  for (const node of tie.nodes) after.set(node.id, node);
  const lookup = (positions: Map<number, TieNode>) => (id: number) => {
    const node = positions.get(id);
    if (!node) throw new Error(`tie: element node ${id} is not in the mesh`);
    return node;
  };
  const positionBefore = lookup(before);
  const positionAfter = lookup(after);

  const refuse = (tieName: string, problem: string): never => {
    const gap = Math.max(
      0,
      ...(pairsOfTie.get(tieName) ?? []).map((pair) => pair.distance),
    );
    throw new Error(
      `Tie "${tieName}" pulls nodes up to ${gap.toFixed(2)} mm apart together, ` +
        `which ${problem}. Tie surfaces that touch or nearly touch, or set the ` +
        "connection to a region with a search distance below the element size.",
    );
  };

  const touched: { original: TieElement; tied: TieElement; tieName: string }[] =
    [];
  for (const el of elements) {
    const welded = el.nodeIds.find((id) => tieOfNode.has(id));
    if (welded === undefined) continue;
    touched.push({
      original: el,
      tied: remapElement(el, tie.repOf),
      tieName: tieOfNode.get(welded) ?? "",
    });
  }

  for (const { tied, tieName } of touched)
    if (new Set(tied.nodeIds).size !== tied.nodeIds.length)
      refuse(
        tieName,
        "merges two nodes of one element and collapses it to zero volume",
      );

  const faceUse = new Map<string, { count: number; tieName: string }>();
  for (const { tied, tieName } of touched)
    for (const face of elementShape(tied).faces) {
      const key = face
        .map((k) => tied.nodeIds[k])
        .sort((first, second) => first - second)
        .join(",");
      const use = faceUse.get(key);
      if (use) use.count++;
      else faceUse.set(key, { count: 1, tieName });
    }
  for (const use of faceUse.values())
    if (use.count > 2)
      refuse(
        use.tieName,
        "leaves an element face shared by three elements, so the mesh is no " +
          "longer a valid solid",
      );

  for (const { original, tied, tieName } of touched)
    for (const corner of elementShape(original).corners) {
      const volumeBefore = signedVolume(
        original.nodeIds,
        corner,
        positionBefore,
      );
      const volumeAfter = signedVolume(tied.nodeIds, corner, positionAfter);
      if (
        volumeBefore !== 0 &&
        Math.sign(volumeAfter) !== Math.sign(volumeBefore)
      )
        refuse(tieName, "turns elements next to the weld inside out");
    }
}

// Expand a solve result indexed by tied (representative) node back to one value
// per original node: a merged-away node takes its representative's value.
export function expandToOriginalNodes(
  originalNodes: TieNode[],
  tiedNodes: TieNode[],
  repOf: Map<number, number>,
  perTiedNode: Float64Array,
  components: number,
): Float64Array {
  const solveIndexOfId = new Map<number, number>();
  for (let i = 0; i < tiedNodes.length; i++)
    solveIndexOfId.set(tiedNodes[i].id, i);

  const out = new Float64Array(components * originalNodes.length);
  for (let i = 0; i < originalNodes.length; i++) {
    const repId = tiedId(repOf, originalNodes[i].id);
    const si = solveIndexOfId.get(repId);
    if (si === undefined)
      throw new Error(
        `tie: original node ${originalNodes[i].id} has no representative in the tied mesh`,
      );
    for (let c = 0; c < components; c++)
      out[components * i + c] = perTiedNode[components * si + c];
  }
  return out;
}

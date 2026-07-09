// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Node-merge ("bonded tie") for multibody assemblies whose parts touch without
// a shared face — e.g. a pin resting in a hook eye, where two different-radius
// cylinders meet along a tangent line (issue #359). The conforming-mesh bond
// (issue #353) needs coincident faces, so a line/point contact ends up joined
// by at most a couple of coincidental nodes: a near-hinge that makes the
// stiffness matrix nearly singular and stalls the solver.
//
// The tie welds every pair of surface nodes from DIFFERENT bodies that lie
// within a detection distance into one shared node, fusing the meshes over a
// contact patch so load transfers and the assembly is solvable. This is an
// approximation — it pulls the two surfaces together within the tolerance and
// stiffens the joint locally — adequate for the overall load path but not for
// accurate local contact stress. A geometry-preserving MPC tie is the accurate
// follow-up (issue tracked separately).

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

export interface TieResult {
  // Representative nodes only (merged-away slaves removed), positions averaged
  // over each welded cluster. This is the node set the solve runs on.
  nodes: TieNode[];
  // Original node id → representative node id, for every node that was merged
  // away. Roots keep their own id and are absent (use `tiedId` below).
  repOf: Map<number, number>;
  // How many nodes were merged away (original count − representative count).
  nWelded: number;
}

// Representative id of an original node id (identity when it was not merged).
export function tiedId(repOf: Map<number, number>, nodeId: number): number {
  return repOf.get(nodeId) ?? nodeId;
}

// Bodies (property ids) that reference each node index. A node shared by a
// conforming interface belongs to several bodies; a plain surface node to one.
function bodyMembership(
  nodes: TieNode[],
  elements: TieElement[],
): (Set<number> | undefined)[] {
  const idxOfId = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) idxOfId.set(nodes[i].id, i);

  const bodiesOf: (Set<number> | undefined)[] = new Array(nodes.length);
  for (const el of elements) {
    for (const nid of el.nodeIds) {
      const i = idxOfId.get(nid);
      if (i === undefined) continue;
      (bodiesOf[i] ??= new Set()).add(el.propertyId);
    }
  }
  return bodiesOf;
}

// Nearest cross-body neighbour index of each node within `tieDistance` (-1 if
// none). A uniform grid with cell = tieDistance keeps this near-linear: any pair
// within the distance shares a cell or an adjacent one, so a 3×3×3 scan finds
// every candidate.
function nearestCrossBodyNeighbours(
  nodes: TieNode[],
  bodiesOf: (Set<number> | undefined)[],
  tieDistance: number,
): Int32Array {
  const n = nodes.length;
  const differentBodies = (a: number, b: number): boolean => {
    const sa = bodiesOf[a];
    const sb = bodiesOf[b];
    if (!sa || !sb) return false;
    for (const body of sa) if (sb.has(body)) return false; // share a body → skip
    return true;
  };

  const cell = (v: number) => Math.floor(v / tieDistance);
  const key = (cx: number, cy: number, cz: number) => `${cx},${cy},${cz}`;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = key(cell(nodes[i].x), cell(nodes[i].y), cell(nodes[i].z));
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  }

  const d2 = tieDistance * tieDistance;
  const nearest = new Int32Array(n).fill(-1);
  const nearestD2 = new Float64Array(n).fill(Infinity);
  const consider = (i: number, j: number) => {
    if (j === i || !differentBodies(i, j)) return;
    const ex = nodes[i].x - nodes[j].x;
    const ey = nodes[i].y - nodes[j].y;
    const ez = nodes[i].z - nodes[j].z;
    const dist2 = ex * ex + ey * ey + ez * ez;
    if (dist2 <= d2 && dist2 < nearestD2[i]) {
      nearestD2[i] = dist2;
      nearest[i] = j;
    }
  };
  for (let i = 0; i < n; i++) {
    const cx = cell(nodes[i].x);
    const cy = cell(nodes[i].y);
    const cz = cell(nodes[i].z);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(key(cx + dx, cy + dy, cz + dz));
          if (bucket) for (const j of bucket) consider(i, j);
        }
  }
  return nearest;
}

// Collapse each union-find cluster to one representative node at the average of
// its members' positions, and record the original → representative id remap.
function collapseWeldedClusters(
  nodes: TieNode[],
  find: (i: number) => number,
): TieResult {
  const acc = new Map<number, { x: number; y: number; z: number; c: number }>();
  for (let i = 0; i < nodes.length; i++) {
    const root = find(i);
    let agg = acc.get(root);
    if (!agg) {
      agg = { x: 0, y: 0, z: 0, c: 0 };
      acc.set(root, agg);
    }
    agg.x += nodes[i].x;
    agg.y += nodes[i].y;
    agg.z += nodes[i].z;
    agg.c++;
  }

  const outNodes: TieNode[] = [];
  for (const [root, agg] of acc)
    outNodes.push({
      id: nodes[root].id,
      x: agg.x / agg.c,
      y: agg.y / agg.c,
      z: agg.z / agg.c,
    });

  const repOf = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) {
    const root = find(i);
    if (root !== i) repOf.set(nodes[i].id, nodes[root].id);
  }

  return { nodes: outNodes, repOf, nWelded: nodes.length - outNodes.length };
}

// Weld near-contact nodes from different bodies. `tieDistance` ≤ 0 is a no-op
// (returns the mesh unchanged), so the tie is strictly opt-in.
//
// Welding by MUTUAL nearest neighbours (i↔j only when each is the other's
// nearest) makes every weld a disjoint 1:1 pair — never a chain — so two nodes
// of the same element can never collapse onto one representative. (A union-find
// over all in-range pairs would chain a node reachable from two others of one
// element into a zero-volume tet.)
export function buildTie(
  nodes: TieNode[],
  elements: TieElement[],
  tieDistance: number,
): TieResult {
  if (!(tieDistance > 0)) return { nodes, repOf: new Map(), nWelded: 0 };

  const n = nodes.length;
  const bodiesOf = bodyMembership(nodes, elements);
  const nearest = nearestCrossBodyNeighbours(nodes, bodiesOf, tieDistance);

  // Union-find over node indices, joining only mutual-nearest pairs.
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  for (let i = 0; i < n; i++) {
    const j = nearest[i];
    if (j > i && nearest[j] === i) parent[j] = i; // mutual nearest → weld pair
  }

  return collapseWeldedClusters(nodes, find);
}

// Remap an element's connectivity onto the tied (representative) node ids.
export function remapElement<T extends TieElement>(
  el: T,
  repOf: Map<number, number>,
): T {
  if (repOf.size === 0) return el;
  return { ...el, nodeIds: el.nodeIds.map((id) => tiedId(repOf, id)) };
}

// A tie distance larger than an element edge can pull two nodes of the same
// element onto one representative, collapsing it to zero volume. Detect that so
// the solve fails with an actionable message instead of a silent bad result.
export function assertNoCollapsedElements(elements: TieElement[]): void {
  for (const el of elements) {
    if (new Set(el.nodeIds).size !== el.nodeIds.length)
      throw new Error(
        "Tie distance is too large — it merged two nodes of the same element, " +
          "collapsing it to zero volume. Reduce the bonded tie distance.",
      );
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

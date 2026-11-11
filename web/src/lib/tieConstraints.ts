// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Constraint ("MPC") tie between two picked surfaces (issue #357) — the
// geometry-preserving alternative to the node-merge of lib/tie.ts.
//
// Every node of one surface (the slave side) is projected onto the element
// faces of the other (the master side) and constrained to follow its
// projection:
//
//     u_slave = Σ Nᵢ · u_masterᵢ
//
// with Nᵢ the face's shape functions at the projected point. No node moves and
// no element changes shape, so the mesh the solver sees is the mesh the user
// meshed; the engine eliminates the slave DOFs (engine/cpp/tie_constraints.h).
// Because a slave projects onto a FACE, the two meshes need no matching nodes —
// the pin/hook line contact of the crane assembly ties without distortion.
//
// The finer surface is the slave side: constraining the coarse side to the fine
// one would leave fine-side nodes free to pass through the coarse faces.
//
// Quadrilateral (hex) faces are split into two triangles for the projection, so
// the weights are linear over each half rather than bilinear over the quad.
// They still sum to one and reproduce any linear displacement field, which is
// what a tie needs.

import { SpatialGrid, type Point3 } from "./spatialGrid.js";
import {
  bodyMembership,
  tieLimit,
  tieSides,
  type TieDefinition,
  type TieElement,
  type TieNode,
  type TieReport,
} from "./tie.js";

// One constrained node, in ORIGINAL node ids.
export interface TieConstraint {
  // Name of the connection that constrains the node.
  tie: string;
  slaveId: number;
  // The nodes of the face it follows, and their shape-function weights (Σ = 1).
  masterIds: number[];
  weights: number[];
  // Where on the master surface the node projects, and how far away that is.
  point: Point3;
  distance: number;
}

interface Triangle {
  ids: [number, number, number];
  a: Point3;
  b: Point3;
  c: Point3;
  centroid: Point3;
  // Radius of the bounding sphere about the centroid.
  radius: number;
  area: number;
}

// Local face → node indices of the supported solid elements.
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

function facesOf(el: TieElement): readonly (readonly number[])[] {
  if (el.nodeIds.length === 4) return TET_FACES;
  if (el.nodeIds.length === 8) return HEX_FACES;
  throw new Error(
    `tie: cannot tie an element with ${el.nodeIds.length} nodes — constraint ` +
      "ties support 4-node tetrahedra and 8-node hexahedra",
  );
}

const sub = (p: Point3, q: Point3): Point3 => [
  p[0] - q[0],
  p[1] - q[1],
  p[2] - q[2],
];
const dot = (p: Point3, q: Point3): number =>
  p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const distanceBetween = (p: Point3, q: Point3): number =>
  Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

function makeTriangle(
  ids: [number, number, number],
  positionOf: (id: number) => Point3,
): Triangle {
  const cornerA = positionOf(ids[0]);
  const cornerB = positionOf(ids[1]);
  const cornerC = positionOf(ids[2]);
  const centroid: Point3 = [
    (cornerA[0] + cornerB[0] + cornerC[0]) / 3,
    (cornerA[1] + cornerB[1] + cornerC[1]) / 3,
    (cornerA[2] + cornerB[2] + cornerC[2]) / 3,
  ];
  const ab = sub(cornerB, cornerA);
  const ac = sub(cornerC, cornerA);
  const area =
    0.5 *
    Math.hypot(
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    );
  const radius = Math.max(
    distanceBetween(cornerA, centroid),
    distanceBetween(cornerB, centroid),
    distanceBetween(cornerC, centroid),
  );
  return { ids, a: cornerA, b: cornerB, c: cornerC, centroid, radius, area };
}

// The free surface of each side as triangles: the element faces whose nodes all
// lie on that side and that belong to ONE element. (A face used by two elements
// is interior, even when all its nodes happen to sit on the picked surface.)
function sideTriangles(
  elements: TieElement[],
  sides: readonly Set<number>[],
  positionOf: (id: number) => Point3,
): Triangle[][] {
  const sideOf = (id: number): number =>
    sides.findIndex((side) => side.has(id));
  const faces = new Map<
    string,
    { ids: number[]; side: number; count: number }
  >();
  for (const el of elements) {
    // A face needs three nodes on a side, so most elements are skipped here.
    let onSides = 0;
    for (const id of el.nodeIds) if (sideOf(id) >= 0) onSides++;
    if (onSides < 3) continue;
    for (const face of facesOf(el)) {
      const ids = face.map((k) => el.nodeIds[k]);
      const side = sideOf(ids[0]);
      if (side < 0 || !ids.every((id) => sides[side].has(id))) continue;
      const key = [...ids].sort((first, second) => first - second).join(",");
      const seen = faces.get(key);
      if (seen) seen.count++;
      else faces.set(key, { ids, side, count: 1 });
    }
  }

  const out: Triangle[][] = sides.map(() => []);
  for (const { ids, side, count } of faces.values()) {
    if (count !== 1) continue;
    out[side].push(makeTriangle([ids[0], ids[1], ids[2]], positionOf));
    if (ids.length === 4)
      out[side].push(makeTriangle([ids[0], ids[2], ids[3]], positionOf));
  }
  return out;
}

// Closest point of triangle abc to p, as barycentric weights (Ericson,
// Real-Time Collision Detection §5.1.5 — the Voronoi-region walk, which is
// exact on the edges and corners and never leaves the triangle).
function closestWeights(p: Point3, tri: Triangle): [number, number, number] {
  const ab = sub(tri.b, tri.a);
  const ac = sub(tri.c, tri.a);
  const ap = sub(p, tri.a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return [1, 0, 0];

  const bp = sub(p, tri.b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return [0, 1, 0];

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const alongAb = d1 / (d1 - d3);
    return [1 - alongAb, alongAb, 0];
  }

  const cp = sub(p, tri.c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return [0, 0, 1];

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const alongAc = d2 / (d2 - d6);
    return [1 - alongAc, 0, alongAc];
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const alongBc = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [0, 1 - alongBc, alongBc];
  }

  const denom = 1 / (va + vb + vc);
  const weightB = vb * denom;
  const weightC = vc * denom;
  return [1 - weightB - weightC, weightB, weightC];
}

interface Projection {
  triangle: Triangle;
  weights: [number, number, number];
  point: Point3;
  distance: number;
}

// Nearest-point search over a master surface.
//
// Triangles are binned by centroid in a grid whose cell is at least the largest
// triangle's diameter. Once ring r is scanned, every triangle left is at least
// r·cell − radius away, so the best hit is final as soon as it is closer than
// that — the same stopping rule as the node pairing in
// lib/tie.ts, shifted by the triangle size. A query that is still empty-handed
// after a few rings (a "full" tie across a wide gap) scans every triangle
// instead, pruned by bounding sphere: rings grow cubically, the scan does not.
class SurfaceSearch {
  private readonly grid: SpatialGrid<Triangle>;
  private readonly cell: number;
  private readonly maxRadius: number;
  private static readonly MAX_RINGS = 3;

  constructor(private readonly triangles: Triangle[]) {
    let maxRadius = 0;
    for (const tri of triangles) maxRadius = Math.max(maxRadius, tri.radius);
    this.maxRadius = maxRadius;
    this.cell = Math.max(2 * maxRadius, 1e-9);
    this.grid = new SpatialGrid(triangles, (tri) => tri.centroid, this.cell);
  }

  private project(p: Point3, tri: Triangle): Projection {
    const weights = closestWeights(p, tri);
    const point: Point3 = [
      weights[0] * tri.a[0] + weights[1] * tri.b[0] + weights[2] * tri.c[0],
      weights[0] * tri.a[1] + weights[1] * tri.b[1] + weights[2] * tri.c[1],
      weights[0] * tri.a[2] + weights[1] * tri.b[2] + weights[2] * tri.c[2],
    ];
    return {
      triangle: tri,
      weights,
      point,
      distance: distanceBetween(p, point),
    };
  }

  // Closest point of the surface within `limit` of p, or null when none is.
  closest(p: Point3, limit: number): Projection | null {
    const found: { best: Projection | null } = { best: null };
    const consider = (tri: Triangle) => {
      const bound = found.best ? found.best.distance : limit;
      if (distanceBetween(p, tri.centroid) - tri.radius > bound) return;
      const hit = this.project(p, tri);
      if (
        hit.distance <= limit &&
        (!found.best || hit.distance < found.best.distance)
      )
        found.best = hit;
    };

    for (let ring = 0; ring <= SurfaceSearch.MAX_RINGS; ring++) {
      for (const tri of this.grid.candidates(p, ring, ring)) consider(tri);
      // p may sit on the edge of its cell, so a centroid in ring r+1 is at
      // least r·cell away, and its triangle a radius closer than that.
      const unscanned = ring * this.cell - this.maxRadius;
      if (unscanned > limit) return found.best;
      if (found.best && found.best.distance <= unscanned) return found.best;
    }
    for (const tri of this.triangles) consider(tri);
    return found.best;
  }
}

const meanArea = (triangles: Triangle[]): number =>
  triangles.reduce((sum, tri) => sum + tri.area, 0) / triangles.length;

// Weights this small are round-off of a projection that landed on an edge or a
// corner; the node they belong to plays no part in the constraint.
const NEGLIGIBLE_WEIGHT = 1e-9;

// The constraints of every "mpc" connection in `ties`, and what each found.
// Exported on its own because the viewport draws exactly this — which nodes a
// connection constrains, and to where — and the solve applies the same list.
//
// `taken` holds nodes that must not be constrained: nodes a node-merge tie has
// already welded. A node is constrained by one connection only, and a node that
// already leads a constraint is never made to follow one, so the constraints of
// several connections cannot form a cycle (a master may still be an earlier
// connection's slave — the engine substitutes such chains out).
export function tieConstraints(
  nodes: TieNode[],
  elements: TieElement[],
  ties: TieDefinition[],
  taken: ReadonlySet<number> = new Set(),
): { constraints: TieConstraint[]; reports: TieReport[] } {
  const constraints: TieConstraint[] = [];
  const reports: TieReport[] = [];
  if (ties.length === 0) return { constraints, reports };

  const nodeById = new Map<number, TieNode>();
  for (const node of nodes) nodeById.set(node.id, node);
  const bodyOf = bodyMembership(elements);

  const slaves = new Set<number>();
  const masters = new Set<number>();
  for (const tie of ties) {
    const positionOf = (id: number): Point3 => {
      const node = nodeById.get(id);
      if (!node)
        throw new Error(
          `Tie "${tie.name}" references node ${id}, which is not in the mesh — ` +
            "re-pick its surfaces after remeshing",
        );
      return [node.x, node.y, node.z];
    };

    const { a, b, nShared } = tieSides(tie, bodyOf);
    const report: TieReport = {
      name: tie.name,
      nPaired: 0,
      nShared,
      maxDistance: 0,
    };
    reports.push(report);
    if (a.length === 0 || b.length === 0) continue;

    const sideIds = [new Set(a), new Set(b)];
    const [trianglesA, trianglesB] = sideTriangles(
      elements,
      sideIds,
      positionOf,
    );
    // Slave = the finer side, provided the other has faces to project onto.
    // A side picked so narrowly that it holds no whole element face (an edge)
    // can only follow, never lead.
    let slaveSide: 0 | 1;
    if (trianglesB.length === 0 && trianglesA.length === 0) continue;
    if (trianglesB.length === 0) slaveSide = 1;
    else if (trianglesA.length === 0) slaveSide = 0;
    else slaveSide = meanArea(trianglesA) <= meanArea(trianglesB) ? 0 : 1;
    const slaveIds = slaveSide === 0 ? a : b;
    const search = new SurfaceSearch(slaveSide === 0 ? trianglesB : trianglesA);

    const limit = tieLimit(tie);
    for (const slaveId of slaveIds) {
      if (taken.has(slaveId) || slaves.has(slaveId) || masters.has(slaveId))
        continue;
      const hit = search.closest(positionOf(slaveId), limit);
      if (!hit) continue;

      const masterIds: number[] = [];
      const weights: number[] = [];
      let total = 0;
      for (let k = 0; k < 3; k++) {
        if (hit.weights[k] <= NEGLIGIBLE_WEIGHT) continue;
        masterIds.push(hit.triangle.ids[k]);
        weights.push(hit.weights[k]);
        total += hit.weights[k];
      }
      for (let k = 0; k < weights.length; k++) weights[k] /= total;

      slaves.add(slaveId);
      for (const id of masterIds) masters.add(id);
      constraints.push({
        tie: tie.name,
        slaveId,
        masterIds,
        weights,
        point: hit.point,
        distance: hit.distance,
      });
      report.nPaired++;
      report.maxDistance = Math.max(report.maxDistance, hit.distance);
    }
  }
  return { constraints, reports };
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The CAD faces a shell idealisation collapsed onto the rim of its
// mid-surface.
//
// Meshing a body as a shell (lib/solve/autoShell) replaces each thin wall by
// its mid-surface. The faces through the wall thickness (a plate's side faces,
// the bore of a hole) are not on the shell mesh: they collapse to its free
// edges, the rim. A support or load on such a face is an Edge selection on the
// shell. This module says which CAD face each rim edge came from, so an edge
// pick can select that whole face's rim and remember the face
// (BcFaceEntry.cadFaceId), and a re-mesh can find the face's rim again
// (lib/remeshGroups) — as a face pick does with a face on the mesh surface.
//
// A rim node lies on its side face: the mid-surface is the kept wall face moved
// half the thickness along its normal, which keeps a node on a side face square
// to the wall on that face. So a rim edge's CAD face is the face of the
// geometry that contains both of its end nodes, measured on the geometry's
// display tessellation within its chordal deflection (the worker tessellates
// with deflection_relative 0.001 of the bounding-box diagonal). The wall faces
// the shell facets carry are not candidates. When several faces contain both
// ends (a wall thinner than the deflection), the one nearest the edge's
// midpoint wins if it is clearly nearest. An edge on no face (a side face at
// an angle to the wall) or on several alike has no CAD face; it is still picked
// as a polyline (facePick pickEdgeNodeIds), without a face to remember.

import type { Point3 } from "./spatialGrid";
import { TriangleGrid } from "./spatialGrid";

// The worker's tessellation chord tolerance, relative to the model size
// (solver.worker.ts loadGeometry: deflection_relative).
export const TESSELLATION_DEFLECTION_RELATIVE = 0.001;

export interface ShellRim {
  // CAD face of each rim edge that has one, keyed by `rimEdgeKey`.
  faceOfEdge: Map<string, number>;
  // The rim nodes of each collapsed CAD face, sorted node ids.
  nodesByFace: Map<number, number[]>;
}

export interface ShellRimModel {
  nodes: { id: number; x: number; y: number; z: number }[];
  elements: { type: string; nodeIds: number[] }[];
  // The mesh's surface triangles (node ids) and the CAD face of each.
  surfaceTriangles: [number, number, number][] | null;
  surfaceFaceIds: number[] | null;
}

export interface FacedGeometry {
  points: Point3[];
  triangles: [number, number, number][];
  faceIds: number[];
}

export const rimEdgeKey = (a: number, b: number): string =>
  a < b ? `${a},${b}` : `${b},${a}`;

const EMPTY: ShellRim = { faceOfEdge: new Map(), nodesByFace: new Map() };

// A face clearly nearest the midpoint is less than half as far as the next.
const CLEARLY_NEARER = 0.5;

/**
 * The CAD face of every rim edge of the model's shell facets (CTRIA3 edges
 * used by one facet only), and the rim nodes of each such face. Empty when the
 * model has no shell facets.
 */
export function shellRimFaces(
  model: ShellRimModel,
  geometry: FacedGeometry,
): ShellRim {
  const facets = model.elements.filter((e) => e.type === "CTRIA3");
  if (facets.length === 0) return EMPTY;
  if (geometry.faceIds.length !== geometry.triangles.length)
    throw new Error(
      `shell rim: the geometry has ${geometry.triangles.length} triangles but ${geometry.faceIds.length} CAD face ids`,
    );
  if (geometry.points.length === 0) return EMPTY;

  const position = new Map<number, Point3>();
  for (const n of model.nodes) position.set(n.id, [n.x, n.y, n.z]);
  const pos = (id: number): Point3 => {
    const point = position.get(id);
    if (!point)
      throw new Error(`shell rim: facet node ${id} is not a node of the mesh`);
    return point;
  };

  // Rim edges: the facet edges only one facet uses.
  const uses = new Map<string, [number, number, number]>();
  for (const { nodeIds } of facets)
    for (let k = 0; k < 3; k++) {
      const first = nodeIds[k],
        second = nodeIds[(k + 1) % 3];
      const key = rimEdgeKey(first, second);
      const entry = uses.get(key);
      if (entry) entry[2]++;
      else uses.set(key, [first, second, 1]);
    }

  // The wall faces the facets carry (their surface triangles' CAD faces).
  const wallFaces = new Set<number>();
  if (model.surfaceTriangles && model.surfaceFaceIds) {
    const faceOfTriangle = new Map<string, number>();
    model.surfaceTriangles.forEach((tri, t) =>
      faceOfTriangle.set(
        [...tri].sort((x, y) => x - y).join(","),
        (model.surfaceFaceIds as number[])[t],
      ),
    );
    for (const { nodeIds } of facets) {
      const face = faceOfTriangle.get(
        [...nodeIds].sort((x, y) => x - y).join(","),
      );
      if (face !== undefined) wallFaces.add(face);
    }
  }

  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of geometry.points)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k]);
      hi[k] = Math.max(hi[k], p[k]);
    }
  const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const tol = TESSELLATION_DEFLECTION_RELATIVE * size;
  const corner = (t: number, k: number): Point3 =>
    geometry.points[geometry.triangles[t][k]];
  const grid = new TriangleGrid(
    geometry.triangles.length,
    corner,
    Math.max(tol, size / 32),
  );
  // Squared distance from p to each CAD face within the tolerance.
  const facesNear = (p: Point3): Map<number, number> => {
    const near = new Map<number, number>();
    grid.anyNear(p, (dist2, t) => {
      const face = geometry.faceIds[t];
      if (dist2 <= tol * tol && !wallFaces.has(face)) {
        const prev = near.get(face);
        if (prev === undefined || dist2 < prev) near.set(face, dist2);
      }
      return false; // visit every candidate
    });
    return near;
  };
  const nearNode = new Map<number, Map<number, number>>();
  const facesAt = (id: number) => {
    let near = nearNode.get(id);
    if (!near) {
      near = facesNear(pos(id));
      nearNode.set(id, near);
    }
    return near;
  };

  const faceOfEdge = new Map<string, number>();
  const nodeSets = new Map<number, Set<number>>();
  for (const [key, [a, b, count]] of uses) {
    if (count !== 1) continue;
    const atB = facesAt(b);
    const both = [...facesAt(a).keys()].filter((face) => atB.has(face));
    let face: number | undefined;
    if (both.length === 1) face = both[0];
    else if (both.length > 1) {
      const [pa, pb] = [pos(a), pos(b)];
      const mid: Point3 = [
        (pa[0] + pb[0]) / 2,
        (pa[1] + pb[1]) / 2,
        (pa[2] + pb[2]) / 2,
      ];
      const atMid = facesNear(mid);
      const ranked = both
        .map((f) => [f, atMid.get(f) ?? Infinity] as const)
        .sort((x, y) => x[1] - y[1]);
      if (
        Number.isFinite(ranked[0][1]) &&
        Math.sqrt(ranked[0][1]) < CLEARLY_NEARER * Math.sqrt(ranked[1][1])
      )
        face = ranked[0][0];
    }
    if (face === undefined) continue;
    faceOfEdge.set(key, face);
    let set = nodeSets.get(face);
    if (!set) {
      set = new Set();
      nodeSets.set(face, set);
    }
    set.add(a);
    set.add(b);
  }
  const nodesByFace = new Map<number, number[]>();
  for (const [face, set] of nodeSets)
    nodesByFace.set(
      face,
      [...set].sort((x, y) => x - y),
    );
  return { faceOfEdge, nodesByFace };
}

/**
 * The shell rim of a stored model: its mesh against the CAD geometry it was
 * meshed from (the store's stepSurface). Empty when there is no geometry with
 * CAD face ids (a model built without a STEP import) or no shell facet.
 */
export function modelShellRim(
  model: ShellRimModel,
  geometry: {
    points: Point3[];
    triangles: [number, number, number][];
    faceIds?: number[];
  } | null,
): ShellRim {
  if (!geometry?.faceIds) return EMPTY;
  return shellRimFaces(model, {
    points: geometry.points,
    triangles: geometry.triangles,
    faceIds: geometry.faceIds,
  });
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Thin walls meshed with too few linear elements through their thickness
// (KOF-274).
//
// Linear tets lock in bending. With one or two of them through a wall the wall
// comes out two to four times too stiff, and refining the mesh closes the gap
// only slowly, so a linear h-refinement study can look converged while the
// deflection is half the true one. Quadratic tets resolve bending with a single
// element through the thickness. This finds the walls to warn about: on each
// Solid body, its thinnest wall measured in local element sizes.
//
// Walls are the Shell detector's opposite planar CAD-face pairs
// (shellize/walls.ts), so a body flagged here is also one the Shell element
// type can idealise. Curved walls (tubes, shells of revolution) are not paired
// by that detector and are not checked.

import type { Element, Node, Property } from "../workers/solverTypes.js";
import { detectWallPairs, faceProps } from "./shellize/walls.js";
import { pt, type ShellizeMesh } from "./shellize/geometry.js";
import { buildVertexIndexer } from "./solveMeshPacking.js";

// Fewer linear elements than this through a wall and the bending deflection is
// more than ~12 % too small. Measured on a 100 × 20 × 3 mm cantilever plate
// meshed by Netgen at 6 to 0.5 mm (the case in tests/test_thin_wall_order.mjs),
// against the order-2 deflection, which is mesh-converged to 0.1 %. With the
// elementsThrough estimate below: 1 → 25 %, 1.5 → 32 %, 2 → 61 %, 3 → 72 %,
// 4.1 → 88 %, 6.1 → 92 % of the deflection.
export const MIN_LINEAR_ELEMENTS_THROUGH_WALL = 4;

export interface UnderResolvedWall {
  // The body (property id) the wall belongs to.
  bodyId: number;
  // Wall thickness, mm.
  thickness: number;
  // Thickness over the mean surface-mesh edge length on the wall face: about
  // how many elements span the thickness.
  elementsThrough: number;
}

export interface ThinWallModel {
  nodes: Node[];
  elements: Element[];
  surfaceTriangles: [number, number, number][] | null;
  surfaceFaceIds: number[] | null;
  properties: Property[];
}

// The flat mesh the wall detector reads, over the Solid bodies' tets. Same
// layout as solve/autoShell's buildShellizeMesh, built here so the main thread
// does not pull in the solver's shell pipeline.
function shellizeMesh(
  nodes: Node[],
  tets: Element[],
  surfaceTriangles: [number, number, number][],
  surfaceFaceIds: number[],
): ShellizeMesh {
  const vid = buildVertexIndexer(nodes);
  const coords = new Array<number>(3 * nodes.length);
  nodes.forEach((node, i) => {
    coords[3 * i] = node.x;
    coords[3 * i + 1] = node.y;
    coords[3 * i + 2] = node.z;
  });
  const tet: number[] = [];
  const body: number[] = [];
  for (const el of tets) {
    for (const nid of el.nodeIds) tet.push(vid(nid, "thin-wall check tet"));
    body.push(el.propertyId);
  }
  const surfTri: number[] = [];
  for (const tri of surfaceTriangles)
    for (const nid of tri) surfTri.push(vid(nid, "thin-wall check surface"));
  return { V: coords, tet, body, surfTri, surfFace: surfaceFaceIds };
}

// Mean surface-mesh edge length per CAD face.
function meanEdgePerFace(mesh: ShellizeMesh): Map<number, number> {
  const sums = new Map<number, { length: number; edges: number }>();
  for (let t = 0; t < mesh.surfFace.length; t++) {
    const corners = [0, 1, 2].map((k) => pt(mesh.V, mesh.surfTri[3 * t + k]));
    let length = 0;
    for (let k = 0; k < 3; k++) {
      const [ax, ay, az] = corners[k];
      const [bx, by, bz] = corners[(k + 1) % 3];
      length += Math.hypot(bx - ax, by - ay, bz - az);
    }
    let entry = sums.get(mesh.surfFace[t]);
    if (entry === undefined) {
      entry = { length: 0, edges: 0 };
      sums.set(mesh.surfFace[t], entry);
    }
    entry.length += length;
    entry.edges += 3;
  }
  return new Map(
    [...sums].map(([face, { length, edges }]) => [face, length / edges]),
  );
}

// The thinnest wall of every Solid body with fewer than
// MIN_LINEAR_ELEMENTS_THROUGH_WALL elements through it, fewest first. Shell
// bodies are idealised to shells and suppressed bodies are not meshed, so
// neither is checked. The finding does not depend on the element order; the
// caller warns only for linear elements.
export function underResolvedWalls(model: ThinWallModel): UnderResolvedWall[] {
  const { nodes, elements, surfaceTriangles, surfaceFaceIds, properties } =
    model;
  // Wall detection pairs CAD faces of the surface mesh. A model without one
  // (an imported mesh, an analysis saved without it) has no CAD faces to pair.
  if (surfaceTriangles === null || surfaceFaceIds === null) return [];
  if (surfaceFaceIds.length !== surfaceTriangles.length)
    throw new Error(
      `Thin-wall check: the surface mesh has ${surfaceTriangles.length} triangles but ${surfaceFaceIds.length} CAD face ids`,
    );
  const solidBodies = new Set(
    properties
      .filter((p) => p.discretization !== "shell" && !p.suppressed)
      .map((p) => p.id),
  );
  const tets = elements.filter(
    (e) => e.type === "CTETRA" && solidBodies.has(e.propertyId),
  );
  if (tets.length === 0) return [];

  const mesh = shellizeMesh(nodes, tets, surfaceTriangles, surfaceFaceIds);
  const faces = faceProps(mesh);
  if (faces.length === 0) return [];
  const edge = meanEdgePerFace(mesh);

  // No upper bound on the thickness: what matters is the thickness in element
  // sizes, so a 20 mm wall meshed at 10 mm is as locked as a 2 mm one at 1 mm.
  const worst = new Map<number, UnderResolvedWall>();
  for (const wall of detectWallPairs(faces, Infinity)) {
    if (!solidBodies.has(wall.body)) continue;
    const size = edge.get(wall.keep);
    if (size === undefined || !(size > 0))
      throw new Error(
        `Thin-wall check: CAD face ${wall.keep} of body ${wall.body} has no surface-mesh edges`,
      );
    const elementsThrough = wall.thk / size;
    if (elementsThrough >= MIN_LINEAR_ELEMENTS_THROUGH_WALL) continue;
    const seen = worst.get(wall.body);
    if (seen === undefined || elementsThrough < seen.elementsThrough)
      worst.set(wall.body, {
        bodyId: wall.body,
        thickness: wall.thk,
        elementsThrough,
      });
  }
  return [...worst.values()].sort(
    (a, b) => a.elementsThrough - b.elementsThrough,
  );
}

// "Body 2: 3 mm wall, ~2 linear elements through it". One line per body, for
// the pre-flight check and the result note.
export function describeUnderResolvedWall(wall: UnderResolvedWall): string {
  const thickness = Number(wall.thickness.toPrecision(2));
  const through = Math.max(1, Math.round(wall.elementsThrough));
  return `Body ${wall.bodyId}: ${thickness} mm wall, ~${through} linear element${through === 1 ? "" : "s"} through it`;
}

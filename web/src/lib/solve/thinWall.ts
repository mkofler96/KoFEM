// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Linear tetrahedra lock in bending: with too few through a thin wall the
// solve returns a result that is too stiff, and refining the linear mesh a
// little barely moves it (KOF-274). This finds the thinnest wall of each solid
// body and estimates how many elements span it, so the pre-flight can warn.

import { extractThinWallShells } from "../shellize.js";
import { buildVertexIndexer } from "../solveMeshPacking.js";
import { buildShellizeMesh } from "./autoShell.js";
import type { Element, Node, Property } from "../../workers/solverTypes.js";

// Below this many linear elements through a wall the bending stiffness is
// more than ~12 % too high (100×20×3 mm cantilever: 3 elements → 72 % of the
// converged deflection, 4 → 88 %).
export const MIN_LINEAR_ELEMENTS_THROUGH_WALL = 4;

export interface ThinWallFinding {
  bodyId: number;
  thickness: number; // mm
  elementsThrough: number; // estimated linear elements across the wall
}

export interface ThinWallCheckInput {
  nodes: Node[];
  elements: Element[];
  properties: Property[];
  surfaceTriangles?: [number, number, number][];
  surfaceFaceIds?: number[];
  elementOrder: number;
}

// Mean edge length of the surface triangles on one CAD face.
function meanFaceEdge(
  nodes: Node[],
  triangles: [number, number, number][],
  faceIds: number[],
  face: number,
): number {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const at = (id: number): Node => {
    const node = byId.get(id);
    if (!node)
      throw new Error(`surface triangle references unknown node ${id}`);
    return node;
  };
  let sum = 0;
  let count = 0;
  triangles.forEach((tri, t) => {
    if (faceIds[t] !== face) return;
    for (let k = 0; k < 3; k++) {
      const from = at(tri[k]);
      const to = at(tri[(k + 1) % 3]);
      sum += Math.hypot(from.x - to.x, from.y - to.y, from.z - to.z);
      count++;
    }
  });
  if (count === 0)
    throw new Error(`wall face ${face} has no surface triangles in the mesh`);
  return sum / count;
}

// The solid bodies whose thinnest wall holds fewer than
// MIN_LINEAR_ELEMENTS_THROUGH_WALL linear elements. Empty for a quadratic
// mesh, a mixed shell/solid mesh, or a mesh without surface data. Needs the
// Rust module loaded (it runs the wall detector).
export function thinWallFindings(input: ThinWallCheckInput): ThinWallFinding[] {
  const { nodes, elements, properties, surfaceTriangles, surfaceFaceIds } =
    input;
  if (input.elementOrder !== 1) return [];
  if (!surfaceTriangles || !surfaceFaceIds || surfaceTriangles.length === 0)
    return [];
  if (surfaceFaceIds.length !== surfaceTriangles.length) return [];
  if (elements.some((e) => e.type !== "CTETRA")) return [];

  const vid = buildVertexIndexer(nodes);
  const findings: ThinWallFinding[] = [];
  for (const property of properties) {
    if (property.suppressed || property.discretization === "shell") continue;
    const bodyTets = elements.filter((e) => e.propertyId === property.id);
    if (bodyTets.length === 0) continue;
    // Only this body goes to the detector: it drops faces under 1 % of the
    // largest face it sees, so a big neighbour would hide a small body's walls.
    const bodyNodes = new Set(bodyTets.flatMap((e) => e.nodeIds));
    const bodyTris: [number, number, number][] = [];
    const bodyFaces: number[] = [];
    surfaceTriangles.forEach((tri, t) => {
      if (!tri.every((id) => bodyNodes.has(id))) return;
      bodyTris.push(tri);
      bodyFaces.push(surfaceFaceIds[t]);
    });
    const mesh = buildShellizeMesh(nodes, bodyTets, bodyTris, bodyFaces, vid);
    const { walls } = extractThinWallShells(mesh, {
      shellBodyIds: new Set([property.id]),
    });
    let worst: ThinWallFinding | null = null;
    for (const wall of walls) {
      if (wall.body !== property.id) continue;
      const edge = meanFaceEdge(nodes, bodyTris, bodyFaces, wall.keep);
      const elementsThrough = wall.thk / edge;
      if (worst === null || elementsThrough < worst.elementsThrough)
        worst = { bodyId: property.id, thickness: wall.thk, elementsThrough };
    }
    if (worst && worst.elementsThrough < MIN_LINEAR_ELEMENTS_THROUGH_WALL)
      findings.push(worst);
  }
  return findings;
}

export function thinWallMessage(finding: ThinWallFinding): string {
  return (
    `Thin wall on body ${finding.bodyId}: about ${finding.elementsThrough.toFixed(1)} ` +
    `linear elements across ${finding.thickness.toFixed(1)} mm — results may be far too stiff. ` +
    "Use quadratic elements (Mesh panel) or set the body to Shell."
  );
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pressures on the faces of a curved thin wall that the shell idealisation
// collapsed (KOF-448). The solve-time auto-shell paths otherwise put each
// solid node's share of a surface load on its nearest shell node. On a curved
// wall the two faces are meshed apart from the shell, so those shares land
// unevenly, and a thin tube is soft enough in ovalisation that the unevenness
// alone bends it out of round. A pressure on a whole face of a curved wall is
// instead applied to that wall's facets: the work-equivalent p·n·A/3 per facet
// node, scaled to the loaded face's area so the wall carries the force the
// face carried (p·r_i per unit length on a pressurised bore, say).
//
// It stays in TypeScript beside the load packing it feeds (lib/solveLoads.ts):
// it reads the store's surface loads and node positions and hands the packing
// plain nodal forces.

import type { ShellExtraction, Vec3, Wall } from "../shellize.js";
import type { SurfaceLoad } from "../../workers/solverTypes.js";

export interface WallPressureSplit {
  // The surface loads (or parts of them) left for the nearest-node mapping.
  remaining: SurfaceLoad[];
  // Work-equivalent forces on the shell, keyed by local shell node index.
  shellForces: Map<number, Vec3>;
}

// A face whose loaded triangles cover at least this share of its area is
// loaded whole.
const WHOLE_FACE = 1 - 1e-9;

const faceKey = (ids: readonly number[]): string =>
  [...ids].sort((a, b) => a - b).join(",");

// (b − a) × (c − a) / 2: the area-weighted winding normal.
function areaNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return [
    (ab[1] * ac[2] - ab[2] * ac[1]) / 2,
    (ab[2] * ac[0] - ab[0] * ac[2]) / 2,
    (ab[0] * ac[1] - ab[1] * ac[0]) / 2,
  ];
}

const areaOf = (normal: Vec3): number => Math.hypot(...normal);

// Split `surfaceLoads` (solid faces wound outward, as solidFacesOutward winds
// them) into the pressures on whole faces of the shelled body's curved walls,
// returned as forces on those walls' facets, and the rest. The facets of a
// curved wall are wound along its kept face's outward normal
// (crates/kofem-shellize mid_surface), so a pressure on the kept face pushes
// against the winding and one on the partner face with it.
export function curvedWallPressures(
  surfaceLoads: SurfaceLoad[] | undefined,
  shells: ShellExtraction,
  surface: { triangles: [number, number, number][]; faceIds: number[] },
  position: (nodeId: number) => Vec3,
): WallPressureSplit {
  const remaining: SurfaceLoad[] = [];
  const shellForces = new Map<number, Vec3>();
  const wallOfFace = new Map<number, { wall: Wall; kept: boolean }>();
  for (const wall of shells.walls) {
    if (!wall.curved) continue;
    wallOfFace.set(wall.keep, { wall, kept: true });
    wallOfFace.set(wall.partner, { wall, kept: false });
  }
  if (wallOfFace.size === 0 || !surfaceLoads)
    return { remaining: surfaceLoads ?? [], shellForces };

  if (surface.faceIds.length !== surface.triangles.length)
    throw new Error(
      `The surface mesh is inconsistent: ${surface.triangles.length} surface triangles but ` +
        `${surface.faceIds.length} face ids. Re-mesh the model.`,
    );
  const triangleArea = (ids: readonly number[]): number =>
    areaOf(areaNormal(position(ids[0]), position(ids[1]), position(ids[2])));
  const faceOfTriangle = new Map<string, number>();
  const faceArea = new Map<number, number>();
  surface.triangles.forEach((triangle, index) => {
    const face = surface.faceIds[index];
    faceOfTriangle.set(faceKey(triangle), face);
    if (wallOfFace.has(face))
      faceArea.set(face, (faceArea.get(face) ?? 0) + triangleArea(triangle));
  });

  const shellPoint = (node: number): Vec3 => [
    shells.shellVerts[3 * node],
    shells.shellVerts[3 * node + 1],
    shells.shellVerts[3 * node + 2],
  ];
  const facetNormals = (wall: Wall): { nodes: number[]; normal: Vec3 }[] => {
    const facets: { nodes: number[]; normal: Vec3 }[] = [];
    for (let t = 0; t < shells.shellTriSrc.length; t++) {
      if (shells.shellTriSrc[t] !== wall.keep) continue;
      const nodes = shells.shellTris.slice(3 * t, 3 * t + 3);
      const [a, b, c] = nodes.map(shellPoint);
      facets.push({ nodes, normal: areaNormal(a, b, c) });
    }
    if (facets.length === 0)
      throw new Error(
        `curved wall on face ${wall.keep} has no shell facets to carry its pressure`,
      );
    return facets;
  };

  for (const surfaceLoad of surfaceLoads) {
    if (surfaceLoad.type !== "pressure" || surfaceLoad.pressure === undefined) {
      remaining.push(surfaceLoad);
      continue;
    }
    const pressure = surfaceLoad.pressure;
    const rest: number[][] = [];
    const onWallFace = new Map<number, number[][]>();
    for (const triangle of surfaceLoad.faces) {
      const face =
        triangle.length === 3
          ? faceOfTriangle.get(faceKey(triangle))
          : undefined;
      if (face === undefined || !wallOfFace.has(face)) {
        rest.push(triangle);
        continue;
      }
      const list = onWallFace.get(face) ?? [];
      list.push(triangle);
      onWallFace.set(face, list);
    }
    for (const [face, triangles] of onWallFace) {
      const loaded = triangles.reduce((sum, t) => sum + triangleArea(t), 0);
      const whole = faceArea.get(face);
      const entry = wallOfFace.get(face);
      if (whole === undefined || entry === undefined)
        throw new Error(`face ${face} of a curved wall has no measured area`);
      // Part of a face keeps the nearest-node mapping: the facets carry the
      // wall as a whole and cannot say where on it a part load sits.
      if (loaded < WHOLE_FACE * whole) {
        rest.push(...triangles);
        continue;
      }
      const facets = facetNormals(entry.wall);
      const facetArea = facets.reduce((sum, f) => sum + areaOf(f.normal), 0);
      // Kept face: its outward normal is the winding, the pressure pushes
      // against it; partner face: the other way round.
      const factor =
        ((entry.kept ? -1 : 1) * pressure * (loaded / facetArea)) / 3;
      for (const { nodes, normal } of facets)
        for (const node of nodes) {
          let force = shellForces.get(node);
          if (force === undefined) {
            force = [0, 0, 0];
            shellForces.set(node, force);
          }
          for (let axis = 0; axis < 3; axis++)
            force[axis] += factor * normal[axis];
        }
    }
    if (rest.length === surfaceLoad.faces.length) remaining.push(surfaceLoad);
    else if (rest.length > 0) remaining.push({ ...surfaceLoad, faces: rest });
  }
  return { remaining, shellForces };
}

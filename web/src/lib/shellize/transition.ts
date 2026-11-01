// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shell/solid transition: where a Shell body's wall meets retained solid, cut
// the solid at a plane a few wall thicknesses in, so the shell edge lands on a
// through-thickness solid section and couples through its physical footprint.

import { clipShellTransition, type TransitionPlane } from "../clipMesh.js";
import { TriangleGrid } from "../spatialGrid.js";
import { buildCoupledModel, type CoupledModel } from "./coupledModel.js";
import { couplingMpcCodes } from "./couplingSet.js";
import { shellBoundaryEdges } from "./footprint.js";
import {
  pt,
  tetMeshBoundary,
  type ShellizeMesh,
  type Vec3,
} from "./geometry.js";
import type { ShellExtraction } from "./midSurface.js";
import { faceProps } from "./walls.js";
import { shellBodyTets } from "./wallTets.js";

// Preserve 3-D material at planar wall roots before the shell idealisation.
export function buildShellTransitionModel(
  mesh: ShellizeMesh,
  shells: ShellExtraction,
): { mesh: ShellizeMesh; model: CoupledModel } {
  const replaced = shellBodyTets(mesh, shells);
  const retained: number[] = [];
  for (let element = 0; element < mesh.body.length; element++)
    if (!replaced.has(element))
      retained.push(...mesh.tet.slice(4 * element, 4 * element + 4));
  if (retained.length === 0)
    return { mesh, model: buildCoupledModel(mesh, shells, replaced) };
  const boundary = tetMeshBoundary(retained);
  const tolerance = Math.max(...shells.shellThk) * 1e-7;
  const grid = new TriangleGrid(
    boundary.length / 3,
    (triangle, corner) => pt(mesh.V, boundary[3 * triangle + corner]),
    Math.max(...shells.shellThk),
  );
  const planes: TransitionPlane[] = [];
  for (const edge of shellBoundaryEdges(
    shells.shellVerts,
    shells.shellTris,
    shells.shellThk,
  )) {
    const first = pt(shells.shellVerts, edge.first),
      second = pt(shells.shellVerts, edge.second);
    const middle = first.map(
      (value, axis) => (value + second[axis]) / 2,
    ) as Vec3;
    if (
      ![first, second, middle].every((point) =>
        grid.anyNear(point, (distance) => distance <= tolerance * tolerance),
      )
    )
      continue;
    const origin = middle.map(
      (value, axis) => value + 3 * edge.thickness * edge.inward[axis],
    ) as Vec3;
    if (
      !planes.some(
        (plane) =>
          plane.normal.every(
            (value, axis) => Math.abs(value - edge.inward[axis]) < 1e-7,
          ) &&
          Math.abs(
            plane.normal.reduce(
              (sum, value, axis) =>
                sum + value * (plane.origin[axis] - origin[axis]),
              0,
            ),
          ) < tolerance,
      )
    )
      planes.push({ origin, normal: edge.inward });
  }
  if (planes.length === 0)
    return { mesh, model: buildCoupledModel(mesh, shells, replaced) };
  const shellFaces = new Set(
    faceProps(mesh)
      .filter((face) => face.body === shells.shellBody)
      .map((face) => face.id),
  );
  const clipped = clipShellTransition(
    mesh,
    shells,
    replaced,
    planes,
    shellFaces,
    tolerance,
  );
  const model = buildCoupledModel(clipped, shells, new Set());
  if (!couplingMpcCodes(model.coupling).includes(3))
    throw new Error(
      "The retained solid joint could not be connected to the shell footprint. Keep this body Solid.",
    );
  return { mesh: clipped, model };
}

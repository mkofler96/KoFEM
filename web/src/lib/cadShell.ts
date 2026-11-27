// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The stored model of a Shell body whose mid-surface the engine built from the
// CAD geometry (KOF-498): the engine's midSurface turned into CTRIA3 facets,
// one PSHELL per thickness, and the links from every facet and rim edge back
// to the CAD faces it came from. The CAD faces stay the ground truth: supports
// and loads are picked on them and resolved through these links on every mesh.

import type { Element, Node, Property } from "../workers/solverTypes.js";

export type ShellRoute =
  | {
      body: number;
      path: "cad";
      walls: {
        kind: "planar" | "cylindrical";
        thickness: number;
        top: number[];
        bottom: number[];
        sides: number[];
      }[];
    }
  | { body: number; path: "mesh"; face: number; reason: string };

export interface MidSurfaceDto {
  vertices: Float64Array;
  // Wound so each triangle's normal points to the top side of its wall.
  triangles: Int32Array;
  // Per triangle, its index into faces.
  midFace: Int32Array;
  faces: { body: number; top: number; bottom: number; thickness: number }[];
  // [a, b, sideFace] per rim edge: vertex indices and the CAD side face.
  rimEdges: Int32Array;
}

export interface CadShellMeshDto {
  midSurface?: MidSurfaceDto;
  shellRoutes: ShellRoute[];
}

export interface MidSurfaceLinks {
  // Per shell element, in element order: its top and bottom CAD face.
  facetTop: number[];
  facetBottom: number[];
  // Each rim edge in store node ids, with the CAD side face it came from.
  rim: { nodeIds: [number, number]; sideFace: number }[];
}

export interface CadShellModel {
  nodes: Node[];
  elements: Element[];
  properties: Property[];
  surfaceTriangles: [number, number, number][];
  surfaceFaceIds: number[];
  links: MidSurfaceLinks;
}

export function buildCadShellModel(
  _dto: CadShellMeshDto,
  _properties: Property[],
  shellBodyId: number,
): CadShellModel {
  throw new Error(
    `KOF-498: buildCadShellModel is not implemented (body ${shellBodyId})`,
  );
}

// The facets a CAD face covers, wound along that face's outward normal.
export function cadFaceSurface(
  _model: CadShellModel,
  cadFaceId: number,
): [number, number, number][] {
  throw new Error(
    `KOF-498: cadFaceSurface is not implemented (face ${cadFaceId})`,
  );
}

// The store nodes a CAD face resolves to: a top or bottom face's facet nodes,
// a side face's rim nodes.
export function cadFaceNodes(
  _model: CadShellModel,
  cadFaceId: number,
): number[] {
  throw new Error(
    `KOF-498: cadFaceNodes is not implemented (face ${cadFaceId})`,
  );
}

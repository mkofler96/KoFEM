// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The stored model of Shell bodies whose mid-surface the engine built from the
// CAD geometry (KOF-498): the engine's midSurface turned into CTRIA3 facets,
// one PSHELL per body and thickness (lib/shellSections), the bodies meshed as
// volumes as CTETRA, and the links from every facet and rim edge back to the
// CAD faces it came from. The CAD faces stay the ground truth: supports and
// loads are picked on them and resolved through these links on every mesh.

import type { FemMesh } from "../wasm/pkg/kofem_wasm.js";
import type { Element, Node, Property } from "../workers/solverTypes.js";
import { shellSections } from "./shellSections.js";

export interface MidSurfaceLinks {
  // One entry per shell facet: its element id and its two source faces.
  facets: { element: number; top: number; bottom: number }[];
  // Each rim edge in store node ids, with the CAD side face it came from.
  rim: { nodeIds: [number, number]; sideFace: number }[];
}

export interface CadShellModel {
  nodes: Node[];
  elements: Element[];
  properties: Property[];
  // The volume-meshed bodies' boundary, then every shell facet under its top
  // face, so a face pick on the mesh still finds the facets.
  surfaceTriangles: [number, number, number][];
  surfaceFaceIds: number[];
  links: MidSurfaceLinks;
}

type Triangle = [number, number, number];

// Nodes are numbered from 0: the volume mesh's vertices, then the
// mid-surface's. Elements likewise: the tetrahedra, then the facets.
export function buildCadShellModel(
  dto: FemMesh,
  properties: Property[],
): CadShellModel {
  const mid = dto.midSurface;
  if (!mid)
    throw new Error(
      "CAD shell model: the mesh has no mid-surface — no Shell body took the CAD path",
    );
  const solidCount = dto.vertices.length / 3;
  const nodes: Node[] = [];
  const pushNodes = (vertices: Float64Array) => {
    for (let i = 0; i < vertices.length / 3; i++)
      nodes.push({
        id: nodes.length,
        x: vertices[3 * i],
        y: vertices[3 * i + 1],
        z: vertices[3 * i + 2],
      });
  };
  pushNodes(dto.vertices);
  pushNodes(mid.vertices);

  const elements: Element[] = [];
  for (let t = 0; t < dto.tetrahedra.length / 4; t++)
    elements.push({
      id: elements.length,
      type: "CTETRA",
      nodeIds: Array.from(dto.tetrahedra.subarray(4 * t, 4 * t + 4)),
      // The tet's body (1-based CAD solid index), resolved to a material via
      // the properties at solve time (#353).
      propertyId: dto.bodyIds[t],
    });

  const sections = shellSections(properties, mid.faces);
  const surfaceTriangles: Triangle[] = [];
  const surfaceFaceIds: number[] = [];
  for (let t = 0; t < dto.surfaceFaceIds.length; t++) {
    surfaceTriangles.push(
      Array.from(dto.surfaceTriangles.subarray(3 * t, 3 * t + 3)) as Triangle,
    );
    surfaceFaceIds.push(dto.surfaceFaceIds[t]);
  }
  const facets: MidSurfaceLinks["facets"] = [];
  for (let t = 0; t < mid.midFace.length; t++) {
    const face = mid.faces[mid.midFace[t]];
    const nodeIds = Array.from(
      mid.triangles.subarray(3 * t, 3 * t + 3),
      (vertex) => solidCount + vertex,
    ) as Triangle;
    facets.push({
      element: elements.length,
      top: face.top,
      bottom: face.bottom,
    });
    elements.push({
      id: elements.length,
      type: "CTRIA3",
      nodeIds,
      propertyId: sections.propertyOf(face.body, face.thickness),
    });
    surfaceTriangles.push(nodeIds);
    surfaceFaceIds.push(face.top);
  }
  const rim: MidSurfaceLinks["rim"] = [];
  for (let e = 0; e < mid.rimEdges.length / 3; e++)
    rim.push({
      nodeIds: [
        solidCount + mid.rimEdges[3 * e],
        solidCount + mid.rimEdges[3 * e + 1],
      ],
      sideFace: mid.rimEdges[3 * e + 2],
    });

  return {
    nodes,
    elements,
    properties: sections.properties,
    surfaceTriangles,
    surfaceFaceIds,
    links: { facets, rim },
  };
}

function facetNodes(model: CadShellModel, elementId: number): Triangle {
  const element = model.elements[elementId];
  if (element?.id !== elementId || element.type !== "CTRIA3")
    throw new Error(
      `CAD shell model: element ${elementId} is not the shell facet the links name`,
    );
  return element.nodeIds as Triangle;
}

// The triangles a CAD face covers, wound along that face's outward normal, so
// a pressure on them pushes into the body: a top face's facets as they are
// wound (toward the top side), a bottom face's the other way, and a face of a
// volume-meshed body its own boundary triangles. A side face collapsed to the
// rim covers no area; it is picked for its nodes (cadFaceNodes).
export function cadFaceSurface(
  model: CadShellModel,
  cadFaceId: number,
): Triangle[] {
  const { facets, rim } = model.links;
  const top = facets.filter((f) => f.top === cadFaceId);
  if (top.length > 0) return top.map((f) => facetNodes(model, f.element));
  const bottom = facets.filter((f) => f.bottom === cadFaceId);
  if (bottom.length > 0)
    return bottom.map((f) => {
      const [a, b, c] = facetNodes(model, f.element);
      return [a, c, b];
    });
  if (rim.some((edge) => edge.sideFace === cadFaceId))
    throw new Error(
      `CAD face ${cadFaceId} is a side face of a shell: it collapsed to the shell's edge and covers no area`,
    );
  const triangles = model.surfaceTriangles.filter(
    (_, t) => model.surfaceFaceIds[t] === cadFaceId,
  );
  if (triangles.length === 0)
    throw new Error(`CAD face ${cadFaceId} is not on this mesh`);
  return triangles;
}

// The nodes a CAD face resolves to: a side face's rim nodes, a top or bottom
// face's facet nodes, a volume-meshed face's boundary nodes. Ascending ids.
export function cadFaceNodes(
  model: CadShellModel,
  cadFaceId: number,
): number[] {
  const rimNodes = model.links.rim
    .filter((edge) => edge.sideFace === cadFaceId)
    .flatMap((edge) => edge.nodeIds);
  const ids =
    rimNodes.length > 0 ? rimNodes : cadFaceSurface(model, cadFaceId).flat();
  return [...new Set(ids)].sort((a, b) => a - b);
}

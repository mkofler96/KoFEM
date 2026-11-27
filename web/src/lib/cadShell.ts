// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The stored model of Shell bodies whose mid-surface the engine built from the
// CAD geometry (KOF-498): the engine's midSurface turned into CTRIA3 facets,
// one PSHELL per body and thickness (lib/shellSections), the bodies meshed as
// volumes as CTETRA, and the links from every facet and rim edge back to the
// CAD faces it came from. The CAD faces stay the ground truth: supports and
// loads are picked on them and resolved through these links on every mesh.

import type { MidSurfaceMesh, ShellRoute } from "../wasm/pkg/kofem_wasm.js";
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

// The bodies meshed as volumes, as the store holds them: node and element ids
// equal to their index (the worker builds them that way, dropSuppressedBodies
// keeps it). Empty when every body is a shell.
export interface VolumeParts {
  nodes: Node[];
  elements: Element[];
  surfaceTriangles: Triangle[];
  surfaceFaceIds: number[];
}

function requireIndexIds(items: { id: number }[], what: string): void {
  items.forEach((item, index) => {
    if (item.id !== index)
      throw new Error(
        `CAD shell model: ${what} ${item.id} is at index ${index}; the volume mesh must be numbered from 0`,
      );
  });
}

// Nodes and elements continue the volume part's numbering: its nodes, then
// the mid-surface's; its tetrahedra, then the facets.
export function buildCadShellModel(
  volume: VolumeParts,
  mid: MidSurfaceMesh,
  properties: Property[],
): CadShellModel {
  requireIndexIds(volume.nodes, "node");
  requireIndexIds(volume.elements, "element");
  if (volume.surfaceTriangles.length !== volume.surfaceFaceIds.length)
    throw new Error(
      `CAD shell model: ${volume.surfaceTriangles.length} surface triangles but ${volume.surfaceFaceIds.length} face ids`,
    );
  const solidCount = volume.nodes.length;
  const nodes: Node[] = [...volume.nodes];
  for (let i = 0; i < mid.vertices.length / 3; i++)
    nodes.push({
      id: nodes.length,
      x: mid.vertices[3 * i],
      y: mid.vertices[3 * i + 1],
      z: mid.vertices[3 * i + 2],
    });
  const elements: Element[] = [...volume.elements];

  const sections = shellSections(properties, mid.faces);
  const surfaceTriangles: Triangle[] = [...volume.surfaceTriangles];
  const surfaceFaceIds: number[] = [...volume.surfaceFaceIds];
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

// One log line per Shell body: which path meshed it, and on the CAD path its
// walls, or on the mesh-based path the face that did not pair and why.
export function describeShellRoute(route: ShellRoute): string {
  if (route.path === "mesh")
    return `[shell] body ${route.body}: mesh-based mid-surface, face ${route.face} (${route.reason})`;
  const kinds = [...new Set(route.walls.map((w) => w.kind))].join("/");
  const thicknesses = route.walls.map((w) => `${w.thickness} mm`).join(", ");
  const top = route.walls.flatMap((w) => w.top).join(", ");
  const bottom = route.walls.flatMap((w) => w.bottom).join(", ");
  const count = route.walls.length;
  return (
    `[shell] body ${route.body}: CAD mid-surface, ${count} ${kinds} wall${count === 1 ? "" : "s"} ` +
    `(${thicknesses}), top faces ${top}, bottom faces ${bottom}`
  );
}

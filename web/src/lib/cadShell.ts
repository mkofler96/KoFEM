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
  // The area of each top and bottom face per unit area of the mid-surface it
  // loads: 1 for a flat wall, r_face / r_mid for a cylindrical one. A load on
  // the face carries the face's own area onto the facets.
  areaRatios: { face: number; ratio: number }[];
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

  const areaRatios = new Map<number, number>();
  for (const face of mid.faces) {
    areaRatios.set(face.top, face.topAreaRatio);
    areaRatios.set(face.bottom, face.bottomAreaRatio);
  }
  return {
    nodes,
    elements,
    properties: sections.properties,
    surfaceTriangles,
    surfaceFaceIds,
    links: {
      areaRatios: [...areaRatios].map(([face, ratio]) => ({ face, ratio })),
      facets,
      rim,
    },
  };
}

type ShellElements = readonly { id: number; type: string; nodeIds: number[] }[];

function facetNodes(
  model: { elements: ShellElements },
  elementId: number,
): Triangle {
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

const ascending = (ids: number[]): number[] =>
  [...new Set(ids)].sort((a, b) => a - b);

// Whether a CAD face is a top or bottom face of a CAD mid-surface ("face"),
// a side face it collapsed to the rim ("edge"), or not part of it (null).
export function cadShellFaceKind(
  links: MidSurfaceLinks,
  cadFaceId: number,
): "face" | "edge" | null {
  if (links.facets.some((f) => f.top === cadFaceId || f.bottom === cadFaceId))
    return "face";
  if (links.rim.some((edge) => edge.sideFace === cadFaceId)) return "edge";
  return null;
}

// The facet nodes of every top and bottom face, ascending. A top face and
// its bottom face hold the same nodes: they are told apart by face id.
export function shellFaceNodes(
  links: MidSurfaceLinks,
  elements: ShellElements,
): Map<number, number[]> {
  const nodes = new Map<number, number[]>();
  for (const facet of links.facets) {
    const corners = facetNodes({ elements }, facet.element);
    for (const face of [facet.top, facet.bottom]) {
      let list = nodes.get(face);
      if (!list) {
        list = [];
        nodes.set(face, list);
      }
      list.push(...corners);
    }
  }
  return new Map([...nodes].map(([face, ids]) => [face, ascending(ids)]));
}

// What a click on a CAD face of a shell selects: a top or bottom face, its
// facets' nodes; a side face, the rim nodes it collapsed to. null for a face
// that is not part of the mid-surface.
export function cadShellPick(
  links: MidSurfaceLinks,
  elements: ShellElements,
  cadFaceId: number,
): { geometry: "face" | "edge"; nodeIds: number[] } | null {
  const kind = cadShellFaceKind(links, cadFaceId);
  if (kind === "edge")
    return {
      geometry: "edge",
      nodeIds: ascending(
        links.rim
          .filter((edge) => edge.sideFace === cadFaceId)
          .flatMap((edge) => edge.nodeIds),
      ),
    };
  if (kind === null) return null;
  const nodeIds = shellFaceNodes(links, elements).get(cadFaceId);
  if (!nodeIds)
    throw new Error(`CAD shell model: face ${cadFaceId} has no facets`);
  return { geometry: "face", nodeIds };
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

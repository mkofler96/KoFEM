// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A mesh whose Shell body took the CAD mid-surface path (KOF-498) reaches the
// store with its links: every facet's top and bottom CAD face, and every rim
// edge's side face. The store keeps them with the mesh and each body's route,
// and the rim of a side face comes from the links exactly, without matching
// the display tessellation (lib/shellRim's geometric match is for the
// mesh-based path). A mesh without a CAD shell clears them.

import { describe, expect, test } from "bun:test";
import { modelShellRim, rimEdgeKey } from "../../src/lib/shellRim";
import {
  describeShellRoute,
  type MidSurfaceLinks,
} from "../../src/lib/cadShell";

// The store reads the sidebar width from localStorage and the theme from
// matchMedia when it is created; bun has neither.
const memory = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => {
      memory.set(k, v);
    },
    removeItem: (k: string) => {
      memory.delete(k);
    },
  },
  window: Object.assign(globalThis, {
    matchMedia: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  }),
});

const { useModelStore } = await import("../../src/store/modelStore");

// A 2 × 1 strip of two facets: top face 7, bottom face 8, side faces 3 (y = 0)
// and 4 (x = 2).
const nodes = [
  { id: 0, x: 0, y: 0, z: 1 },
  { id: 1, x: 1, y: 0, z: 1 },
  { id: 2, x: 2, y: 0, z: 1 },
  { id: 3, x: 0, y: 1, z: 1 },
  { id: 4, x: 1, y: 1, z: 1 },
  { id: 5, x: 2, y: 1, z: 1 },
];
const elements = [
  { id: 0, type: "CTRIA3" as const, nodeIds: [0, 1, 4], propertyId: 2 },
  { id: 1, type: "CTRIA3" as const, nodeIds: [1, 2, 5], propertyId: 2 },
];
const links: MidSurfaceLinks = {
  areaRatios: [
    { face: 7, ratio: 1 },
    { face: 8, ratio: 1 },
  ],
  facets: [
    { element: 0, top: 7, bottom: 8 },
    { element: 1, top: 7, bottom: 8 },
  ],
  rim: [
    { nodeIds: [0, 1], sideFace: 3 },
    { nodeIds: [1, 2], sideFace: 3 },
    { nodeIds: [2, 5], sideFace: 4 },
  ],
};
const routes = [
  {
    body: 1,
    path: "cad" as const,
    walls: [
      {
        kind: "planar" as const,
        thickness: 2,
        top: [7],
        bottom: [8],
        sides: [3, 4],
      },
    ],
  },
];
const sizes = { max: 1, min: 0.1, regions: {}, faces: {} };
const surfaceTriangles: [number, number, number][] = [
  [0, 1, 4],
  [1, 2, 5],
];

describe("the rim of a CAD mid-surface comes from its links", () => {
  test("each side face's rim nodes and edges, without any geometry", () => {
    const rim = modelShellRim(
      {
        nodes,
        elements,
        surfaceTriangles,
        surfaceFaceIds: [7, 7],
        midSurfaceLinks: links,
      },
      null,
    );
    expect(rim.nodesByFace).toEqual(
      new Map([
        [3, [0, 1, 2]],
        [4, [2, 5]],
      ]),
    );
    expect(rim.faceOfEdge.get(rimEdgeKey(1, 0))).toBe(3);
    expect(rim.faceOfEdge.get(rimEdgeKey(5, 2))).toBe(4);
    expect(rim.faceOfEdge.size).toBe(3);
  });
});

describe("a shell route reads as one log line", () => {
  test("the CAD path names its walls and thicknesses", () => {
    expect(describeShellRoute(routes[0])).toBe(
      "[shell] body 1: CAD mid-surface, 1 planar wall (2 mm), top faces 7, bottom faces 8",
    );
  });

  test("the mesh-based path names the face and the reason", () => {
    expect(
      describeShellRoute({
        body: 2,
        path: "mesh",
        face: 12,
        reason: "partial_overlap",
      }),
    ).toBe("[shell] body 2: mesh-based mid-surface, face 12 (partial_overlap)");
  });
});

describe("the store keeps the links and routes with the mesh", () => {
  test("a CAD shell mesh brings them, a plain mesh clears them", () => {
    const store = useModelStore.getState();
    store.applyMeshResult(
      nodes,
      elements,
      "STEP Shell Mesh",
      sizes,
      surfaceTriangles,
      [7, 7],
      null,
      [],
      { midSurfaceLinks: links, shellRoutes: routes },
    );
    expect(useModelStore.getState().midSurfaceLinks).toEqual(links);
    expect(useModelStore.getState().shellRoutes).toEqual(routes);

    store.applyMeshResult(nodes, elements, "STEP Shell Mesh", sizes);
    expect(useModelStore.getState().midSurfaceLinks).toBeNull();
    expect(useModelStore.getState().shellRoutes).toEqual([]);
  });

  test("a support on a side face follows the face's rim onto the new mesh", () => {
    const store = useModelStore.getState();
    store.applyMeshResult(
      nodes,
      elements,
      "STEP Shell Mesh",
      sizes,
      surfaceTriangles,
      [7, 7],
      null,
      [],
      { midSurfaceLinks: links, shellRoutes: routes },
    );
    useModelStore.setState({
      bcGroups: [
        {
          id: 1,
          name: "Edge",
          dofs: [0, 1, 2],
          value: 0,
          faces: [
            {
              id: 1,
              label: "Face 4",
              nodeIds: [2, 5],
              geometry: "edge",
              cadFaceId: 4,
            },
          ],
        },
      ],
    });
    store.applyMeshResult(
      nodes,
      elements,
      "STEP Shell Mesh",
      sizes,
      surfaceTriangles,
      [7, 7],
      null,
      [],
      { midSurfaceLinks: links, shellRoutes: routes },
    );
    const [group] = useModelStore.getState().bcGroups;
    expect(group.faces[0].nodeIds).toEqual([2, 5]);
  });
});

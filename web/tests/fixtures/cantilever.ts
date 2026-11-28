// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Cantilever-beam test fixture.
//
// This model used to be the welcome-screen "Start with example" button. It is
// no longer a user-facing feature — KoFEM operates on real (STEP) geometry only.
// It lives on here purely as a test fixture: a known CHEXA8 mesh with a fixed
// support and a tip load, used to verify the JS/WASM solve pipeline and the
// load-conversion math without going through the UI.

import type { Page } from "@playwright/test";

export interface CantileverModel {
  nodes: { id: number; x: number; y: number; z: number }[];
  elements: {
    id: number;
    type: "CHEXA";
    nodeIds: number[];
    propertyId: number;
  }[];
  materials: {
    id: number;
    name: string;
    young: number;
    poisson: number;
    density: number;
    color: string;
  }[];
  properties: { id: number; materialId: number }[];
  bcGroups: {
    id: number;
    name: string;
    dofs: number[];
    value: number;
    faces: { id: number; label: string; nodeIds: number[] }[];
  }[];
  loadGroups: {
    id: number;
    name: string;
    dof: number;
    totalForce: number;
    faces: { id: number; label: string; nodeIds: number[] }[];
  }[];
  constraints: { nodeId: number; dof: number; prescribedValue: number }[];
  loads: { nodeId: number; dof: number; value: number }[];
}

// 1.0 × 0.1 × 0.1 m steel cantilever, 10×2×2 CHEXA8, fixed at x=0,
// Fy = −10 kN distributed over the free end (x=1.0).
export function buildCantilever(): CantileverModel {
  const nx = 10,
    ny = 2,
    nz = 2;
  const length = 1.0,
    height = 0.1;
  const dx = length / nx,
    dy = height / ny,
    dz = height / nz;

  const strideZ = nz + 1;
  const strideX = (ny + 1) * (nz + 1);
  const nid = (ix: number, iy: number, iz: number) =>
    ix * strideX + iy * strideZ + iz;

  const nodes: CantileverModel["nodes"] = [];
  for (let ix = 0; ix <= nx; ix++)
    for (let iy = 0; iy <= ny; iy++)
      for (let iz = 0; iz <= nz; iz++)
        nodes.push({ id: nid(ix, iy, iz), x: ix * dx, y: iy * dy, z: iz * dz });

  const elements: CantileverModel["elements"] = [];
  let eid = 0;
  for (let ei = 0; ei < nx; ei++)
    for (let ej = 0; ej < ny; ej++)
      for (let ek = 0; ek < nz; ek++)
        elements.push({
          id: eid++,
          type: "CHEXA",
          nodeIds: [
            nid(ei, ej, ek),
            nid(ei + 1, ej, ek),
            nid(ei + 1, ej + 1, ek),
            nid(ei, ej + 1, ek),
            nid(ei, ej, ek + 1),
            nid(ei + 1, ej, ek + 1),
            nid(ei + 1, ej + 1, ek + 1),
            nid(ei, ej + 1, ek + 1),
          ],
          propertyId: 1,
        });

  const materials = [
    {
      id: 1,
      name: "Steel",
      young: 210e9,
      poisson: 0.3,
      density: 7850,
      color: "#4e79a7",
    },
  ];
  const properties = [{ id: 1, materialId: 1 }];

  // Fixed support at x=0
  const bcNodeIds: number[] = [];
  for (let iy = 0; iy <= ny; iy++)
    for (let iz = 0; iz <= nz; iz++) bcNodeIds.push(nid(0, iy, iz));

  // Tip load at x=L
  const loadNodeIds: number[] = [];
  for (let iy = 0; iy <= ny; iy++)
    for (let iz = 0; iz <= nz; iz++) loadNodeIds.push(nid(nx, iy, iz));

  const totalForce = -10_000;

  const bcGroups = [
    {
      id: 1,
      name: "BC1",
      dofs: [0, 1, 2],
      value: 0,
      faces: [{ id: 1, label: "Face 1", nodeIds: bcNodeIds }],
    },
  ];
  const loadGroups = [
    {
      id: 1,
      name: "Load1",
      dof: 1,
      totalForce,
      faces: [{ id: 2, label: "Face 1", nodeIds: loadNodeIds }],
    },
  ];

  const constraints = bcNodeIds.flatMap((nodeId) =>
    [0, 1, 2].map((dof) => ({ nodeId, dof, prescribedValue: 0 })),
  );
  const perNode = totalForce / loadNodeIds.length;
  const loads = loadNodeIds.map((nodeId) => ({
    nodeId,
    dof: 1,
    value: perNode,
  }));

  return {
    nodes,
    elements,
    materials,
    properties,
    bcGroups,
    loadGroups,
    constraints,
    loads,
  };
}

// Open the app and inject the cantilever fixture straight into the store (the
// model is invisible to real users, so there is no UI button to click). The mesh
// and materials go in via setState, but the BC and load are built through the
// real store actions so the load derives exactly as it does after a save→load
// round-trip (a work-equivalent surface traction over the hex end face), keeping
// the initial and re-solved fields identical. Leaves the app in geometry mode
// with a solver-ready CHEXA8 mesh.
export async function bootstrapCantilever(page: Page): Promise<void> {
  await page.goto("/app/");
  await page.waitForFunction(
    () => !!(window as unknown as { __kofemStore?: unknown }).__kofemStore,
  );
  await page.evaluate((model) => {
    type FaceArg = { label: string; nodeIds: number[] };
    const store = (
      window as unknown as {
        __kofemStore: {
          setState(s: object): void;
          getState(): {
            createBcGroup(
              faces: FaceArg[],
              dofs: number[],
              value: number,
            ): void;
            createLoadGroup(
              faces: FaceArg[],
              dof: number,
              totalForce: number,
            ): void;
          };
        };
      }
    ).__kofemStore;
    store.setState({
      nodes: model.nodes,
      elements: model.elements,
      materials: model.materials,
      properties: model.properties,
      modelName: "Cantilever Beam",
      result: null,
      stepSurface: null,
      volMesh: null,
      surfaceTriangles: null,
      surfaceFaceIds: null,
      bcGroups: [],
      loadGroups: [],
      constraints: [],
      loads: [],
      surfaceLoads: [],
      nextBcGroupId: 1,
      nextLoadGroupId: 1,
      nextFaceEntryId: 1,
      viewRepr: "surface",
      selectedFace: null,
      pendingFaces: [],
      pickMode: null,
      pickTargetGroupId: null,
      hasStarted: true,
      mode: "geometry",
    });
    const state = store.getState();
    const bc = model.bcGroups[0];
    const load = model.loadGroups[0];
    state.createBcGroup(
      bc.faces.map((f) => ({ label: f.label, nodeIds: f.nodeIds })),
      bc.dofs,
      bc.value,
    );
    state.createLoadGroup(
      load.faces.map((f) => ({ label: f.label, nodeIds: f.nodeIds })),
      load.dof,
      load.totalForce,
    );
  }, buildCantilever());
}

// One more hexahedron on the cantilever's free end, above it, sharing only the
// end face's top edge along Z (KOF-490). It is part of body 1, so the
// rigid-body check holds it with the beam, but it can still swing about that
// edge: the stiffness matrix is singular and the solve fails inside the solver.
export async function hingeBlockOnCantilever(page: Page): Promise<void> {
  const model = buildCantilever();
  const at = (x: number, y: number, z: number) => {
    const node = model.nodes.find(
      (n) =>
        Math.abs(n.x - x) < 1e-9 &&
        Math.abs(n.y - y) < 1e-9 &&
        Math.abs(n.z - z) < 1e-9,
    );
    if (!node) throw new Error(`the cantilever has no node at ${x},${y},${z}`);
    return node.id;
  };
  const hinge = [at(1, 0.1, 0), at(1, 0.1, 0.05)];
  await page.evaluate(
    ({ hinge, firstNode, elementId }) => {
      const store = (
        window as unknown as {
          __kofemStore: {
            setState(s: object): void;
            getState(): {
              nodes: { id: number; x: number; y: number; z: number }[];
              elements: {
                id: number;
                type: string;
                nodeIds: number[];
                propertyId: number;
              }[];
            };
          };
        }
      ).__kofemStore;
      const { nodes, elements } = store.getState();
      const added = [
        [1.1, 0.1, 0],
        [1.1, 0.2, 0],
        [1, 0.2, 0],
        [1.1, 0.1, 0.05],
        [1.1, 0.2, 0.05],
        [1, 0.2, 0.05],
      ].map(([x, y, z], i) => ({ id: firstNode + i, x, y, z }));
      const id = (i: number) => added[i].id;
      store.setState({
        nodes: [...nodes, ...added],
        elements: [
          ...elements,
          {
            id: elementId,
            type: "CHEXA",
            nodeIds: [
              hinge[0],
              id(0),
              id(1),
              id(2),
              hinge[1],
              id(3),
              id(4),
              id(5),
            ],
            propertyId: 1,
          },
        ],
      });
    },
    {
      hinge,
      firstNode: Math.max(...model.nodes.map((n) => n.id)) + 1,
      elementId: Math.max(...model.elements.map((e) => e.id)) + 1,
    },
  );
}

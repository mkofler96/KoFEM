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
  }[];
  properties: { id: number; type: "PSOLID"; materialId: number }[];
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
  const L = 1.0,
    h = 0.1;
  const dx = L / nx,
    dy = h / ny,
    dz = h / nz;

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
    { id: 1, name: "Steel", young: 210e9, poisson: 0.3, density: 7850 },
  ];
  const properties = [{ id: 1, type: "PSOLID" as const, materialId: 1 }];

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
// model is invisible to real users, so there is no UI button to click). Leaves
// the app in geometry mode with a solver-ready CHEXA8 mesh.
export async function bootstrapCantilever(page: Page): Promise<void> {
  await page.goto("/app/");
  await page.waitForFunction(
    () => !!(window as unknown as { __kofemStore?: unknown }).__kofemStore,
  );
  await page.evaluate((model) => {
    const store = (
      window as unknown as { __kofemStore: { setState(s: object): void } }
    ).__kofemStore;
    store.setState({
      ...model,
      modelName: "Cantilever Beam",
      result: null,
      stepSurface: null,
      volMesh: null,
      viewRepr: "surface",
      selectedFace: null,
      pendingFaces: [],
      pickMode: null,
      pickTargetGroupId: null,
      nextBcGroupId: 2,
      nextLoadGroupId: 2,
      nextFaceEntryId: 3,
      hasStarted: true,
      mode: "geometry",
    });
  }, buildCantilever());
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A cantilever whose root half is hexahedra and tip half tetrahedra (KOF-433),
// solved from the Solve panel: the hexes against the tets are solved as
// transition elements, and the solve log says so.

import type { Page } from "@playwright/test";
import { test, expect } from "./coverage";
import { openTree } from "./fixtures/tree";

const KUHN = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
];
const HEX_OF_BITS = [0, 1, 3, 2, 4, 5, 7, 6];

// 1 m × 0.1 m × 0.1 m steel, 10×2×2 cells: hexes for x < 0.5, Kuhn tets
// beyond, so the plane x = 0.5 is a hex/tet interface of 4 quads.
export function mixedCantilever() {
  const [nx, ny, nz] = [10, 2, 2];
  const id = (i: number, j: number, k: number) =>
    1 + i + (nx + 1) * (j + (ny + 1) * k);
  const nodes = [];
  for (let k = 0; k <= nz; k++)
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i <= nx; i++)
        nodes.push({ id: id(i, j, k), x: i / nx, y: j / 20, z: k / 20 });
  const elements: { type: "CHEXA" | "CTETRA"; nodeIds: number[] }[] = [];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const corner = (bits: number) =>
          id(i + (bits & 1), j + ((bits >> 1) & 1), k + ((bits >> 2) & 1));
        if (i < nx / 2) {
          const hex = new Array<number>(8);
          HEX_OF_BITS.forEach((slot, bits) => (hex[slot] = corner(bits)));
          elements.push({ type: "CHEXA", nodeIds: hex });
        } else
          for (const tet of KUHN)
            elements.push({ type: "CTETRA", nodeIds: tet.map(corner) });
      }
  const at = (i: number) =>
    nodes.filter((node) => Math.abs(node.x - i / nx) < 1e-12).map((n) => n.id);
  return {
    nodes,
    elements: elements.map((element, index) => ({
      ...element,
      id: index + 1,
      propertyId: 1,
    })),
    clamped: at(0),
    tip: at(nx),
  };
}

async function bootstrapMixedCantilever(page: Page): Promise<void> {
  await page.goto("/app/");
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __kofemStore?: unknown }).__kofemStore),
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
      materials: [
        {
          id: 1,
          name: "Steel",
          young: 210e9,
          poisson: 0.3,
          density: 7850,
          color: "#4e79a7",
        },
      ],
      properties: [{ id: 1, materialId: 1 }],
      modelName: "Hex/tet cantilever",
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
    state.createBcGroup(
      [{ label: "Face 1", nodeIds: model.clamped }],
      [0, 1, 2],
      0,
    );
    state.createLoadGroup(
      [{ label: "Face 2", nodeIds: model.tip }],
      1,
      -10_000,
    );
  }, mixedCantilever());
}

test("a hex/tet cantilever solves with its interface hexes as transition elements", async ({
  page,
}) => {
  await bootstrapMixedCantilever(page);
  await openTree(page, "static");
  const run = page.getByRole("button", { name: /Run static solve/ });
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByTestId("colorbar")).toBeVisible();
  // The solve log is on the study's panel; the solve opened the result.
  await openTree(page, "static");
  await expect(
    page.getByText("4 hexahedra joined to tetrahedra by transition elements"),
  ).toBeVisible();
});

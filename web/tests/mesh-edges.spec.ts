// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The mesh's edge overlays (KOF-457): each edge is drawn once however many
// elements share it, and the wireframe of every element edge exists only in a
// view that shows it — on a large mesh it is the biggest buffer the viewport
// would build.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { boxHexMesh } from "../../examples/validation/lib/mesh.mjs";
import { drawnSegments } from "./fixtures/viewport";

type Store = { setState(s: object): void };

// A 5 × 2 × 2 hex box: 117 distinct edges (45 along x, 36 along y, 36 along
// z), 96 of them on its surface (V + F − 2 = 50 + 48 − 2); 240 if every hex
// drew its own 12.
const ELEMENT_EDGES = 117;
const SURFACE_EDGES = 96;

async function openBox(page: Page, viewRepr: string) {
  const mesh = boxHexMesh(10, 4, 4, 5, 2, 2);
  const nodes = mesh.vertices.map((v: number[], i: number) => ({
    id: i,
    x: v[0],
    y: v[1],
    z: v[2],
  }));
  const elements = mesh.hexahedra.map((h: number[], i: number) => ({
    id: i,
    type: "CHEXA",
    nodeIds: [...h],
    propertyId: 1,
  }));
  await page.goto("/app/");
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __kofemStore?: unknown }).__kofemStore),
  );
  await page.evaluate(
    ({ model, repr }) => {
      (window as unknown as { __kofemStore: Store }).__kofemStore.setState({
        nodes: model.nodes,
        elements: model.elements,
        properties: [{ id: 1, materialId: 1 }],
        modelName: "Box",
        hasStarted: true,
        viewRepr: repr,
      });
    },
    { model: { nodes, elements }, repr: viewRepr },
  );
}

const setRepr = (page: Page, repr: string) =>
  page.evaluate((viewRepr) => {
    (window as unknown as { __kofemStore: Store }).__kofemStore.setState({
      viewRepr,
    });
  }, repr);

test("the Surface view draws the outline once and no element wireframe", async ({
  page,
}) => {
  await openBox(page, "surface");
  await expect
    .poll(() => drawnSegments(page, "fem-surface-edges"))
    .toBe(SURFACE_EDGES);
  expect(await drawnSegments(page, "fem-element-edges")).toBe(0);
});

test("the Wireframe view draws every element edge once", async ({ page }) => {
  await openBox(page, "surface");
  await setRepr(page, "wireframe");
  await expect
    .poll(() => drawnSegments(page, "fem-element-edges"))
    .toBe(ELEMENT_EDGES);
  expect(await drawnSegments(page, "fem-surface-edges")).toBe(0);
});

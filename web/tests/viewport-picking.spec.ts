// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The viewport renders on demand, so a click can arrive before the frame that
// follows a camera move. The pick must use the camera and scene as they are
// now, not as they were at the last rendered frame.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { boxHexMesh } from "../../examples/validation/lib/mesh.mjs";
import { addBoundary } from "./fixtures/tree";
import type { ViewportHooks } from "../src/components/viewport/ViewportTestHooks";

type Point = [number, number, number];

type Store = {
  getState(): {
    nodes: { id: number; x: number; y: number; z: number }[];
    selectedFace: { nodeIds: number[] } | null;
  };
  setState(s: object): void;
};

// A 10 × 4 × 4 hex box in the Surface view, in constraints mode.
async function openBox(page: Page) {
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
    (model) => {
      (window as unknown as { __kofemStore: Store }).__kofemStore.setState({
        nodes: model.nodes,
        elements: model.elements,
        properties: [{ id: 1, materialId: 1 }],
        modelName: "Box",
        hasStarted: true,
        viewRepr: "surface",
        mode: "constraints",
      });
    },
    { nodes, elements },
  );
}

// Turn the camera and click `point` in the same task, so no frame can render
// in between, the way a click that beats the next animation frame does.
async function turnAndClick(page: Page, direction: Point, point: Point) {
  await page.evaluate(
    ({ direction, point }) => {
      const hooks = (window as unknown as { __kofemViewport: ViewportHooks })
        .__kofemViewport;
      hooks.lookFrom(direction);
      const screen = hooks.project(point);
      if (!screen) throw new Error(`point ${point} is behind the camera`);
      const canvas = document.querySelector("canvas");
      if (!canvas) throw new Error("the viewport canvas is not mounted");
      const at = {
        clientX: screen.x,
        clientY: screen.y,
        bubbles: true,
        button: 0,
      };
      canvas.dispatchEvent(
        new PointerEvent("pointerdown", { ...at, pointerId: 1, buttons: 1 }),
      );
      canvas.dispatchEvent(
        new PointerEvent("pointerup", { ...at, pointerId: 1 }),
      );
      canvas.dispatchEvent(new MouseEvent("click", at));
    },
    { direction, point },
  );
}

const selectedXs = (page: Page) =>
  page.evaluate(() => {
    const { nodes, selectedFace } = (
      window as unknown as { __kofemStore: Store }
    ).__kofemStore.getState();
    if (!selectedFace) return null;
    return selectedFace.nodeIds.map((id) => {
      const node = nodes.find((candidate) => candidate.id === id);
      if (!node) throw new Error(`picked node ${id} is not in the mesh`);
      return node.x;
    });
  });

test("a click right after a camera turn picks the face under the cursor", async ({
  page,
}) => {
  await openBox(page);
  await addBoundary(page, "bc");
  await page.waitForFunction(() =>
    Boolean(
      (window as unknown as { __kofemViewport?: unknown }).__kofemViewport,
    ),
  );
  await page.getByRole("button", { name: "Fit View", exact: true }).click();

  // The fitted view looks from (1, 1, 1); turn to the x = 0 end and click its
  // centre before the turned view has been drawn.
  await turnAndClick(page, [-1, 0, 0], [0, 2, 2]);

  const xs = await selectedXs(page);
  expect(xs, "the click picked no face").not.toBeNull();
  expect(xs?.every((x) => Math.abs(x) < 1e-9)).toBe(true);
});

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
import { settleViewport } from "./fixtures/viewport";

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
  await settleViewport(page);

  // The fitted view looks from (1, 1, 1); turn to the x = 0 end and click its
  // centre before the turned view has been drawn.
  await turnAndClick(page, [-1, 0, 0], [0, 2, 2]);

  const xs = await selectedXs(page);
  expect(xs, "the click picked no face").not.toBeNull();
  expect(xs?.every((x) => Math.abs(x) < 1e-9)).toBe(true);
});

const selectedCount = (page: Page) =>
  page.evaluate(() => {
    const state = (
      window as unknown as {
        __kofemStore: {
          getState(): { pendingFaces: unknown[]; selectedFace: unknown };
        };
      }
    ).__kofemStore.getState();
    return state.pendingFaces.length + (state.selectedFace ? 1 : 0);
  });

// The viewport's React tree commits a store change in a task of its own, which
// the browser may run after input that is already waiting. A click must still
// see the pick session and the faces picked so far as the store has them.

test("a click right after a pick session starts picks the face under the cursor", async ({
  page,
}) => {
  await openBox(page);
  await page.waitForFunction(() =>
    Boolean(
      (window as unknown as { __kofemViewport?: unknown }).__kofemViewport,
    ),
  );
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  await page.getByTestId("tree-add-boundary").click();
  await settleViewport(page);

  // Boundary conditions → + Add → Fixed displacement starts the pick; click the
  // top face before the viewport has committed the session.
  await page.evaluate(
    async (point) => {
      const hooks = (window as unknown as { __kofemViewport: ViewportHooks })
        .__kofemViewport;
      const add = document.querySelector<HTMLElement>(
        "[data-testid=add-boundary-bc]",
      );
      if (!add) throw new Error("the + Add chooser is not open");
      add.click();
      // React renders the panel, whose effect starts the pick, in a microtask.
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const store = (
        window as unknown as {
          __kofemStore: { getState(): { pickMode: string | null } };
        }
      ).__kofemStore;
      if (store.getState().pickMode !== "bc")
        throw new Error("the BC pick session has not started");
      const screen = hooks.project(point);
      if (!screen) throw new Error(`point ${point} is behind the camera`);
      const clickAt = ({ x, y }: { x: number; y: number }) => {
        const canvas = document.querySelector("canvas");
        if (!canvas) throw new Error("the viewport canvas is not mounted");
        const at = { clientX: x, clientY: y, bubbles: true, button: 0 };
        canvas.dispatchEvent(
          new PointerEvent("pointerdown", { ...at, pointerId: 1, buttons: 1 }),
        );
        canvas.dispatchEvent(
          new PointerEvent("pointerup", { ...at, pointerId: 1 }),
        );
        canvas.dispatchEvent(new MouseEvent("click", at));
      };
      clickAt(screen);
    },
    [5, 4, 2] as Point,
  );

  expect(await selectedCount(page), "the click picked no face").toBe(1);
});

test("two quick clicks on two faces pick both", async ({ page }) => {
  await openBox(page);
  await addBoundary(page, "bc");
  await page.waitForFunction(() =>
    Boolean(
      (window as unknown as { __kofemViewport?: unknown }).__kofemViewport,
    ),
  );
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __kofemStore: { getState(): { pickMode: string | null } };
            }
          ).__kofemStore.getState().pickMode,
      ),
    )
    .toBe("bc");
  await settleViewport(page);

  // The top face, then the x = 10 end, in one task: the second click comes
  // before the viewport has committed the first pick.
  await page.evaluate(
    (points) => {
      const hooks = (window as unknown as { __kofemViewport: ViewportHooks })
        .__kofemViewport;
      const clickAt = ({ x, y }: { x: number; y: number }) => {
        const canvas = document.querySelector("canvas");
        if (!canvas) throw new Error("the viewport canvas is not mounted");
        const at = { clientX: x, clientY: y, bubbles: true, button: 0 };
        canvas.dispatchEvent(
          new PointerEvent("pointerdown", { ...at, pointerId: 1, buttons: 1 }),
        );
        canvas.dispatchEvent(
          new PointerEvent("pointerup", { ...at, pointerId: 1 }),
        );
        canvas.dispatchEvent(new MouseEvent("click", at));
      };
      for (const point of points) {
        const screen = hooks.project(point);
        if (!screen) throw new Error(`point ${point} is behind the camera`);
        clickAt(screen);
      }
    },
    [
      [5, 4, 2],
      [10, 2, 2],
    ] as Point[],
  );

  expect(await selectedCount(page)).toBe(2);
});

// Fit View moves the camera in an effect of the viewport's React tree, which
// runs in a task of its own. A test that projects a point before that task
// clicks where the old camera put it. settled() applies what is pending and
// waits for the frame, so the fixtures can project and click deterministically.
test("settled() applies a pending Fit View before a point is projected", async ({
  page,
}) => {
  await openBox(page);
  await page.waitForFunction(() =>
    Boolean(
      (window as unknown as { __kofemViewport?: unknown }).__kofemViewport,
    ),
  );

  const views = await page.evaluate(
    async (point) => {
      const win = window as unknown as {
        __kofemViewport: ViewportHooks;
        __kofemStore: { getState(): { triggerFitView(): void } };
      };
      const hooks = win.__kofemViewport;
      await hooks.settled();
      // Look along x, then ask for Fit View in the same task: the fit is
      // pending and the camera still looks from the side.
      hooks.lookFrom([-1, 0, 0]);
      win.__kofemStore.getState().triggerFitView();
      const pending = hooks.project(point);
      await hooks.settled();
      const settled = hooks.project(point);
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      return { pending, settled, later: hooks.project(point) };
    },
    [0, 2, 2] as Point,
  );

  expect(views.settled, "Fit View was not applied").not.toEqual(views.pending);
  expect(views.later, "the view still moved after settled()").toEqual(
    views.settled,
  );
});

// Every fixture click awaits settled() before and after, and a test that
// scans a model for a face clicks hundreds of times. settled() must not draw
// on its own account: it waits for the frames the viewport has asked for, and
// returns at once when there are none.
test("settled() draws nothing when the viewport is up to date, and waits for a frame that is due", async ({
  page,
}) => {
  await openBox(page);
  await page.waitForFunction(() =>
    Boolean(
      (window as unknown as { __kofemViewport?: unknown }).__kofemViewport,
    ),
  );

  const drawn = await page.evaluate(async () => {
    const hooks = (window as unknown as { __kofemViewport: ViewportHooks })
      .__kofemViewport;
    const canvas = document.querySelector("canvas");
    if (!canvas) throw new Error("the viewport canvas is not mounted");
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("the viewport canvas has no WebGL 2 context");
    await hooks.settled();

    // Every rendered frame clears the canvas and draws the model.
    let calls = 0;
    const counted =
      <Args extends unknown[]>(draw: (...args: Args) => void) =>
      (...args: Args) => {
        calls += 1;
        draw(...args);
      };
    gl.clear = counted(gl.clear.bind(gl));
    gl.drawElements = counted(gl.drawElements.bind(gl));
    gl.drawArrays = counted(gl.drawArrays.bind(gl));

    await hooks.settled();
    await hooks.settled();
    const upToDate = calls;
    hooks.lookFrom([-1, 0, 0]);
    await hooks.settled();
    return { upToDate, afterTurn: calls - upToDate };
  });

  expect(drawn.upToDate, "settled() drew a frame nobody asked for").toBe(0);
  expect(
    drawn.afterTurn,
    "settled() returned before the turned view was drawn",
  ).toBeGreaterThan(0);
});

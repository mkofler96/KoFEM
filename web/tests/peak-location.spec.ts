// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Results → where the von Mises max sits (KOF-495): its coordinates, a Show
// button that frames it in the viewport, and a note when it sits on an
// idealised support or load, pointing to the P99 row. Cook's membrane is
// clamped along x = 0 and sheared at its far end: the max sits on the clamp's
// upper corner, a support singularity. The shell plate with a hole
// peaks at the hole edge on its symmetry line, a real stress the note must
// not call a singularity. The coupled fin covers the mixed shell/solid path.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { setElementType, openTree } from "./fixtures/tree";
import {
  projectPoint,
  viewCamera,
  settleViewport,
  type Point,
} from "./fixtures/viewport";

const here = dirname(fileURLToPath(import.meta.url));
const FIN_STEP = join(here, "../../test_files/fin_two_parts.step");

type StoreWindow = {
  __kofemStore: {
    getState(): {
      bcGroups: { name: string; faces: { nodeIds: number[] }[] }[];
    };
  };
};

async function runSolve(page: Page): Promise<void> {
  const run = page.getByRole("button", { name: /Run static solve/ });
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByTestId("colorbar")).toBeVisible();
}

async function showVonMises(page: Page): Promise<void> {
  await page.getByTestId("tree-plot-1").click();
  await page.getByTestId("plot-field").selectOption("Von Mises stress");
}

// The max's coordinates as the Results row shows them, after checking they
// are the Max row's node.
async function peakAt(page: Page): Promise<Point> {
  const at = page.getByTestId("peak-location-at");
  await expect(at).toHaveAttribute("data-at", /\d/);
  await expect(page.getByTestId("probe-vector-max")).toContainText(
    (await at.textContent()) ?? "",
  );
  const [x, y, z] = ((await at.getAttribute("data-at")) ?? "")
    .split(",")
    .map(Number);
  return [x, y, z];
}

// The supports, by name, whose selections hold the max's node.
async function supportsOnPeak(page: Page): Promise<string[]> {
  const nodeId = Number(
    await page.getByTestId("peak-location").getAttribute("data-node-id"),
  );
  return page.evaluate(
    (id) =>
      (window as unknown as StoreWindow).__kofemStore
        .getState()
        .bcGroups.filter((group) =>
          group.faces.some((face) => face.nodeIds.includes(id)),
        )
        .map((group) => group.name),
    nodeId,
  );
}

const pixels = (
  a: { x: number; y: number } | null,
  b: { x: number; y: number } | null,
) => {
  if (!a || !b) throw new Error("a point is behind the camera");
  return Math.hypot(a.x - b.x, a.y - b.y);
};

test("Cook's membrane peaks on its clamp: the note points to P99, and Show frames the max @pipeline", async ({
  page,
}) => {
  await page.goto("/app/?example=cooks-membrane");
  await expect(page.locator("nav")).toBeVisible();
  await runSolve(page);
  await showVonMises(page);

  // The clamped edge is x = 0, from y = 0 to 44 mm.
  const at = await peakAt(page);
  expect(at[0]).toBeCloseTo(0, 6);
  expect(at[1]).toBeCloseTo(44, 6);
  const [clamp] = await supportsOnPeak(page);
  expect(clamp).toBe("Clamp");

  const note = page.getByTestId("peak-note");
  await expect(note).toContainText(`support “${clamp}”`);
  await expect(note).toContainText(
    `P99 = ${await page.getByTestId("percentile-value-99").textContent()}`,
  );

  // Undeformed, so the max is drawn at its coordinates.
  await page.getByLabel("Deformation scale").fill("0");
  await settleViewport(page);
  const along: Point = [at[0] + 10, at[1], at[2]];
  const before = pixels(
    await projectPoint(page, at),
    await projectPoint(page, along),
  );

  await page.getByTestId("peak-show").click();
  const camera = await viewCamera(page);
  camera.target.forEach((c, axis) => expect(c).toBeCloseTo(at[axis], 6));
  const canvas = await page.locator("canvas").boundingBox();
  if (!canvas) throw new Error("the viewport canvas is not drawn");
  const centre = {
    x: canvas.x + canvas.width / 2,
    y: canvas.y + canvas.height / 2,
  };
  expect(pixels(await projectPoint(page, at), centre)).toBeLessThan(2);
  const after = pixels(
    await projectPoint(page, at),
    await projectPoint(page, along),
  );
  expect(after).toBeGreaterThan(2 * before);
  await expect(page.getByTestId("probe-label-max")).toBeVisible();
});

test("the shell plate peaks at the hole on its symmetry line, with no singularity note @pipeline", async ({
  page,
}) => {
  await page.goto("/app/?example=plate-with-hole-shell");
  await expect(page.locator("nav")).toBeVisible();
  await runSolve(page);
  await showVonMises(page);

  // The hole (radius 10 mm about the origin) across the load, on the
  // symmetry support of its cut edge.
  const at = await peakAt(page);
  expect(Math.hypot(at[0], at[1])).toBeCloseTo(10, 1);
  expect(await supportsOnPeak(page)).not.toEqual([]);
  await expect(page.getByTestId("peak-note")).toHaveCount(0);
});

test("a coupled shell and solid model shows where its max sits @pipeline", async ({
  page,
}) => {
  await page.goto("/app/");
  await expect(page.locator("nav")).toBeVisible();
  await page.setInputFiles('input[accept=".stp,.step"]', FIN_STEP);
  await expect(page.getByTestId("tree-body-2")).toBeVisible();
  // Body 2 is the 2 mm fin under the 50 × 100 × 30 mm base block.
  await setElementType(page, 2, "shell");
  await openTree(page, "mesh");
  await page.getByRole("button", { name: /Generate mesh/i }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __kofemStore: { getState(): { nodes: unknown[] } };
            }
          ).__kofemStore.getState().nodes.length,
      ),
    )
    .toBeGreaterThan(0);
  // The top of the block clamped, the fin's free edge pushed sideways, on
  // node sets: where the max sits is under test, not face picking.
  await page.evaluate(() => {
    type Store = {
      getState(): {
        nodes: { id: number; z: number }[];
        createBcGroup(
          faces: { label: string; nodeIds: number[]; geometry: string }[],
          dofs: number[],
          value: number,
        ): void;
        createLoadGroup(
          faces: { label: string; nodeIds: number[]; geometry: string }[],
          dof: number,
          totalForce: number,
          kind: string,
          components: [number, number, number],
        ): void;
      };
    };
    const store = (window as unknown as { __kofemStore: Store }).__kofemStore;
    const { nodes } = store.getState();
    const near = (z: number) =>
      nodes.filter((node) => Math.abs(node.z - z) < 1e-6).map((n) => n.id);
    const bottom = Math.min(...nodes.map((node) => node.z));
    store
      .getState()
      .createBcGroup(
        [{ label: "Block top", nodeIds: near(30), geometry: "face" }],
        [0, 1, 2],
        0,
      );
    store
      .getState()
      .createLoadGroup(
        [{ label: "Fin edge", nodeIds: near(bottom), geometry: "edge" }],
        1,
        100,
        "force",
        [0, 100, 0],
      );
  });
  await page.getByTestId("tree-add-studies").click();
  await page.getByTestId("add-study-static").click();
  await runSolve(page);
  await showVonMises(page);

  await peakAt(page);
  // The note names the clamp exactly when the max is on one of its nodes.
  const clamps = await supportsOnPeak(page);
  if (clamps.length > 0)
    await expect(page.getByTestId("peak-note")).toContainText(
      `support “${clamps[0]}”`,
    );
  else await expect(page.getByTestId("peak-note")).toHaveCount(0);
});

test("on a phone, Show closes the panel so the framed max is in view @pipeline", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/?example=cooks-membrane");
  const showPanel = page.getByRole("button", { name: "Show panel" });
  await showPanel.click();
  await runSolve(page);
  if (await showPanel.isVisible()) await showPanel.click();
  await showVonMises(page);
  const at = await peakAt(page);

  await page.getByTestId("peak-show").click();
  await expect(showPanel).toBeVisible();
  const camera = await viewCamera(page);
  camera.target.forEach((c, axis) => expect(c).toBeCloseTo(at[axis], 0));
  await expect(page.getByTestId("probe-label-max")).toBeInViewport();
});

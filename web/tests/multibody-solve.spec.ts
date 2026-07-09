// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Multibody solve + tie coverage (issues #353 / #359). Drives the solver worker
// (window.__kofem) directly, so the tie module and the worker's per-body
// material / tie path run in the instrumented worker and are captured by the
// coverage fixture. Also meshes a two-body assembly and toggles a body's
// visibility to exercise the mesh-hiding and per-body rendering paths.

import { test, expect } from "./coverage";
import path from "path";
import { gotoApp, importStep } from "./fixtures/app";
import { boxHexMesh } from "../../examples/validation/lib/mesh.mjs";

const TWO_BOXES = path.resolve("..", "test_files", "two_boxes.stp");

interface SolveNode {
  id: number;
  x: number;
  y: number;
  z: number;
}
interface SolveElement {
  id: number;
  type: string;
  nodeIds: number[];
  propertyId: number;
}

// Two independently-meshed hex boxes separated by a 0.5 mm gap (distinct node
// ids, different bodies) — the pin/eye line-contact case in miniature. Box A is
// clamped; box B carries a load but touches nothing, so it is only solvable
// once a tie welds the near-contact faces.
function twoGappedBoxes() {
  const gap = 0.5;
  const boxA = boxHexMesh(10, 4, 4, 5, 2, 2);
  const boxB = boxHexMesh(10, 4, 4, 5, 2, 2);
  const off = 1000;

  const nodes: SolveNode[] = [];
  boxA.vertices.forEach((v: number[], i: number) =>
    nodes.push({ id: i, x: v[0], y: v[1], z: v[2] }),
  );
  boxB.vertices.forEach((v: number[], i: number) =>
    nodes.push({ id: off + i, x: v[0] + 10 + gap, y: v[1], z: v[2] }),
  );

  const elements: SolveElement[] = [];
  boxA.hexahedra.forEach((h: number[], i: number) =>
    elements.push({ id: i, type: "CHEXA", nodeIds: [...h], propertyId: 1 }),
  );
  boxB.hexahedra.forEach((h: number[], i: number) =>
    elements.push({
      id: off + i,
      type: "CHEXA",
      nodeIds: h.map((n) => off + n),
      propertyId: 2,
    }),
  );

  const constraints: { nodeId: number; dof: number }[] = [];
  const loads: { nodeId: number; dof: number; value: number }[] = [];
  for (const nd of nodes) {
    if (nd.id < off && Math.abs(nd.x) < 1e-9)
      for (const dof of [0, 1, 2]) constraints.push({ nodeId: nd.id, dof });
    if (nd.id >= off && Math.abs(nd.x - (20 + gap)) < 1e-9)
      loads.push({ nodeId: nd.id, dof: 0, value: 100 });
  }

  return {
    nodes,
    elements,
    materials: [
      {
        id: 1,
        name: "Steel",
        young: 210000,
        poisson: 0.3,
        density: 7.85e-9,
        color: "#4e79a7",
      },
    ],
    properties: [
      { id: 1, materialId: 1 },
      { id: 2, materialId: 1 },
    ],
    constraints,
    loads,
    surfaceLoads: [],
    elementOrder: 1,
  };
}

test("a bonded tie makes a disconnected two-body solve converge", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await gotoApp(page);
  await page.waitForFunction(
    () => !!(window as unknown as { __kofem?: unknown }).__kofem,
  );

  const model = twoGappedBoxes();
  const solve = (tieDistance: number) =>
    page.evaluate(
      async ({ model, tieDistance }) => {
        const win = window as unknown as {
          __kofem: {
            sendToWorker(name: string, payload: object): Promise<unknown>;
          };
        };
        try {
          const result = (await win.__kofem.sendToWorker("solve", {
            ...model,
            tieDistance,
          })) as { displacements: Float64Array };
          return { ok: true as const, nDisp: result.displacements.length };
        } catch (err) {
          return { ok: false as const, error: (err as Error).message };
        }
      },
      { model, tieDistance },
    );

  // Without a tie, box B is disconnected → the solve cannot converge.
  const untied = await solve(0);
  expect(untied.ok).toBe(false);

  // With a tie spanning the 0.5 mm gap, the meshes weld and the solve succeeds,
  // returning one displacement vector per original node.
  const tied = await solve(0.6);
  expect(tied.ok).toBe(true);
  if (tied.ok) expect(tied.nDisp).toBe(model.nodes.length * 3);
});

test("meshing a two-body part and toggling a body's visibility", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await importStep(page, TWO_BOXES);

  // Mesh the assembly so the FEM surface exists (exercises applyMeshResult's
  // per-body property backfill and the mesh render layers).
  await page
    .getByRole("button")
    .filter({ hasText: "Mesh STEP volume" })
    .click();
  await page.waitForFunction(
    () =>
      ((
        window as unknown as {
          __kofemStore: { getState(): { nodes: unknown[] } };
        }
      ).__kofemStore.getState().nodes.length ?? 0) > 0,
    { timeout: 60_000 },
  );

  const readHidden = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __kofemStore: { getState(): { hiddenBodyIds: number[] } };
          }
        ).__kofemStore.getState().hiddenBodyIds,
    );

  // Hover to highlight (switches to the geometry view and dims the other body),
  // then hide and re-show body 2 (drives the mesh-hiding filter + render layers).
  await page
    .getByTestId("body-material-2")
    .locator("xpath=ancestor::div[1]")
    .hover();
  await page.getByTestId("body-visibility-2").click();
  await expect.poll(readHidden).toEqual([2]);
  await page.getByTestId("body-visibility-2").click();
  await expect.poll(readHidden).toEqual([]);
});

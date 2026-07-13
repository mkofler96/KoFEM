// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Full STEP → mesh → solve roundtrip of the I-beam as an all-SOLID cantilever:
//   1. Import I_beam.step (a single body, 300 mm long, 80×80 mm I-section).
//   2. Mesh the STEP volume through the real meshing pipeline.
//   3. Fully fix the x = 0 end, pull the x = 300 end down (−z) with a tip load.
//   4. Solve through the real worker (the same solve message the Solve button
//      sends) with the body left as Solid (its default). The all-solid path
//      carries it — no [auto-shell] log — and the tip deflects downward by a
//      physically sane amount.
//
// This is the solid half of the I-beam pair; ibeam-shell.spec.ts is the same
// geometry solved as shells.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect } from "./coverage";

const here = dirname(fileURLToPath(import.meta.url));
const STEP_PATH = join(here, "../../test_files/I_beam.step");

const LENGTH = 300; // beam length along x (mm)
const TIP_LOAD_N = 5000; // 5 kN total, downward (−z)

interface Node {
  id: number;
  x: number;
  y: number;
  z: number;
}

test("i-beam solid: import STEP, mesh, cantilever tip load, all-solid solve", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const logs: string[] = [];
  page.on("console", (msg) => logs.push(msg.text()));

  await page.goto("/app/");
  await expect(page.locator("nav")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __kofem?: unknown }).__kofem),
  );

  // 1. Import the STEP through the real file-import path.
  await page.setInputFiles('input[accept=".stp,.step"]', STEP_PATH);
  await expect
    .poll(
      async () =>
        (await page.evaluate(
          () =>
            (
              window as unknown as {
                __kofemStore: { getState(): { properties: unknown[] } };
              }
            ).__kofemStore.getState().properties.length,
        )) as number,
      { timeout: 60_000 },
    )
    .toBe(1); // the I-beam is a single body

  // 2. Mesh the STEP volume.
  await page.getByRole("button", { name: /Mesh STEP volume/i }).click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(
          () =>
            (
              window as unknown as {
                __kofemStore: { getState(): { nodes: unknown[] } };
              }
            ).__kofemStore.getState().nodes.length,
        )) as number,
      { timeout: 180_000 },
    )
    .toBeGreaterThan(0);

  // 3 + 4. Fully fix the x = 0 end, apply the tip load on the x = 300 end, solve.
  const result = await page.evaluate(
    async ({ length, tipLoad }) => {
      const win = window as unknown as {
        __kofem: {
          sendToWorker(name: string, payload: object): Promise<unknown>;
        };
        __kofemStore: { getState(): Record<string, unknown> };
      };
      const st = win.__kofemStore.getState();
      const nodes = st.nodes as Node[];
      const fixed = nodes.filter((n) => n.x < 1e-6);
      const tip = nodes.filter((n) => n.x > length - 1e-6);
      if (fixed.length === 0 || tip.length === 0)
        return {
          ok: false,
          error: `end lookup failed: fixed ${fixed.length}, tip ${tip.length}`,
        };

      const constraints = fixed.flatMap((n) =>
        [0, 1, 2].map((dof) => ({ nodeId: n.id, dof })),
      );
      const loads = tip.map((n) => ({
        nodeId: n.id,
        dof: 2,
        value: -tipLoad / tip.length,
      }));

      const res = (await win.__kofem.sendToWorker("solve", {
        nodes: st.nodes,
        elements: st.elements,
        materials: st.materials,
        properties: st.properties, // body left Solid (its default)
        constraints,
        loads,
        surfaceLoads: [],
        elementOrder: st.elementOrder,
        surfaceTriangles: st.surfaceTriangles,
        surfaceFaceIds: st.surfaceFaceIds,
      })) as { displacements: Float64Array; vonMises: Float64Array };

      const disp = res.displacements;
      let tipUz = 0; // most-negative w at the loaded end
      let maxU = 0;
      for (const n of tip) {
        const i = nodes.indexOf(n);
        tipUz = Math.min(tipUz, disp[3 * i + 2]);
      }
      for (let i = 0; i < disp.length; i += 3)
        maxU = Math.max(maxU, Math.hypot(disp[i], disp[i + 1], disp[i + 2]));
      let maxVm = 0;
      for (const vm of res.vonMises) maxVm = Math.max(maxVm, vm);
      return {
        ok: true,
        nNodes: nodes.length,
        nElems: (st.elements as unknown[]).length,
        nDisp: disp.length,
        nVm: res.vonMises.length,
        allFinite:
          [...disp].every(Number.isFinite) &&
          [...res.vonMises].every(Number.isFinite),
        tipUz,
        maxU,
        maxVm,
      };
    },
    { length: LENGTH, tipLoad: TIP_LOAD_N },
  );

  if (!result.ok) throw new Error(result.error);
  // The all-solid path carried the solve — the body is Solid, so no shell log.
  expect(logs.some((l) => l.includes("[auto-shell]"))).toBe(false);
  expect(result.nDisp).toBe((result.nNodes ?? 0) * 3);
  expect(result.nVm).toBe(result.nElems);
  expect(result.allFinite).toBe(true);
  // The tip bends DOWN under a downward load; a coarse linear-tet I-beam of this
  // size deflects a fraction of a millimetre. The window is wide but catches a
  // wrong sign, a runaway (broken BC → NaN/huge) and a locked-solid (≈0) result.
  expect(result.tipUz).toBeLessThan(0);
  expect(-(result.tipUz ?? 0)).toBeGreaterThan(0.01);
  expect(result.maxU ?? 0).toBeLessThan(5);
  expect(result.maxVm ?? 0).toBeGreaterThan(0);
});

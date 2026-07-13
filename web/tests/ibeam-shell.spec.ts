// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Full STEP → mesh → solve roundtrip of the I-beam idealised as SHELLS.
//   1. Import I_beam.step (a single body, 300 mm long, 80×80 mm I-section).
//   2. Mesh the STEP volume.
//   3. Mark the body "Shell" and pull the x = 300 end in +x (axial tension),
//      fully fixing the x = 0 end.
//   4. Solve. A single thin-walled body has no solid body to couple to, so the
//      worker idealises its thin walls to a mid-surface Kirchhoff shell mesh and
//      solves them directly (the pure auto-shell path). Before this path existed,
//      marking a single body "Shell" silently fell back to the all-solid solve —
//      the choice did nothing. So this test also guards that regression: the
//      shell run must log [auto-shell] AND be more compliant than the same model
//      solved Solid (a shell carries the axial load on the thin wall alone, not
//      the full solid cross-section), proving it is genuinely a different model.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect } from "./coverage";

const here = dirname(fileURLToPath(import.meta.url));
const STEP_PATH = join(here, "../../test_files/I_beam.step");

const LENGTH = 300; // beam length along x (mm)
const AXIAL_LOAD_N = 100_000; // 100 kN total, +x (axial tension)

interface Node {
  id: number;
  x: number;
  y: number;
  z: number;
}
interface Property {
  id: number;
  discretization?: string;
}

test("i-beam shell: import STEP, mesh, mark Shell, solve through the shell path", async ({
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

  // 1. Import + 2. mesh.
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
    .toBe(1);

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

  // 3 + 4. Solve axial tension twice — once with the body marked Shell (the
  // feature under test) and once Solid (the baseline) — through the real worker.
  const result = await page.evaluate(
    async ({ length, axialLoad }) => {
      const win = window as unknown as {
        __kofem: {
          sendToWorker(name: string, payload: object): Promise<unknown>;
        };
        __kofemStore: { getState(): Record<string, unknown> };
      };
      const st = win.__kofemStore.getState();
      const nodes = st.nodes as Node[];
      const props = st.properties as Property[];
      const fixed = nodes.filter((n) => n.x < 1e-6);
      const end = nodes.filter((n) => n.x > length - 1e-6);
      if (fixed.length === 0 || end.length === 0)
        return {
          ok: false,
          error: `end lookup failed: fixed ${fixed.length}, end ${end.length}`,
        };

      const constraints = fixed.flatMap((n) =>
        [0, 1, 2].map((dof) => ({ nodeId: n.id, dof })),
      );
      const loads = end.map((n) => ({
        nodeId: n.id,
        dof: 0, // +x axial tension
        value: axialLoad / end.length,
      }));

      const solveWith = async (discretization: "shell" | "solid") => {
        const properties = props.map((p) => ({ ...p, discretization }));
        const res = (await win.__kofem.sendToWorker("solve", {
          nodes: st.nodes,
          elements: st.elements,
          materials: st.materials,
          properties,
          constraints,
          loads,
          surfaceLoads: [],
          elementOrder: st.elementOrder,
          surfaceTriangles: st.surfaceTriangles,
          surfaceFaceIds: st.surfaceFaceIds,
        })) as { displacements: Float64Array; vonMises: Float64Array };
        const disp = res.displacements;
        let endUx = 0; // largest +x extension at the loaded end
        for (const n of end) {
          const i = nodes.indexOf(n);
          endUx = Math.max(endUx, disp[3 * i]);
        }
        let maxU = 0;
        for (let i = 0; i < disp.length; i += 3)
          maxU = Math.max(maxU, Math.hypot(disp[i], disp[i + 1], disp[i + 2]));
        let maxVm = 0;
        for (const vm of res.vonMises) maxVm = Math.max(maxVm, vm);
        return {
          nDisp: disp.length,
          nVm: res.vonMises.length,
          allFinite:
            [...disp].every(Number.isFinite) &&
            [...res.vonMises].every(Number.isFinite),
          endUx,
          maxU,
          maxVm,
        };
      };

      const shell = await solveWith("shell");
      const solid = await solveWith("solid");
      return {
        ok: true,
        nNodes: nodes.length,
        nElems: (st.elements as unknown[]).length,
        shell,
        solid,
      };
    },
    { length: LENGTH, axialLoad: AXIAL_LOAD_N },
  );

  if (!result.ok) throw new Error(result.error);
  const { shell, solid } = result;

  // The pure auto-shell path carried the shell solve (not the silent all-solid
  // fallback that existed before): its log names the thin-wall idealisation.
  expect(logs.some((l) => l.includes("[auto-shell]"))).toBe(true);

  // Result contract is preserved: three translations per store node, one von
  // Mises per store element, all finite (a converged solve).
  expect(shell.nDisp).toBe(result.nNodes * 3);
  expect(shell.nVm).toBe(result.nElems);
  expect(shell.allFinite).toBe(true);

  // The beam extends in +x under axial tension — non-trivial and bounded.
  expect(shell.endUx).toBeGreaterThan(0);
  expect(shell.maxU).toBeGreaterThan(1e-4);
  expect(shell.maxU).toBeLessThan(5);
  expect(shell.maxVm).toBeGreaterThan(0);

  // The shell idealisation is genuinely a different (more compliant) model than
  // the solid: the thin wall carries the axial load on a fraction of the full
  // cross-section, so it extends noticeably more. Were the "Shell" choice still
  // silently solving solid, the two would be identical.
  expect(solid.endUx).toBeGreaterThan(0);
  expect(shell.endUx).toBeGreaterThan(1.3 * solid.endUx);
});

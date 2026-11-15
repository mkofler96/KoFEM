// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Full STEP → mesh → solve roundtrip of the I-beam idealised as SHELLS.
//   1. Import I_beam.step (a single body, 300 mm long, 80×80 mm I-section:
//      web in the z = 0 plane, flanges at y = ±35).
//   2. Mesh the STEP volume.
//   3. Mark the body "Shell", fully fix the x = 0 end and load the x = 300 end
//      in −y: a cantilever bent about its strong axis, where the flanges carry
//      most of the stiffness.
//   4. Solve. A single thin-walled body has no solid body to couple to, so the
//      worker idealises its thin walls to a mid-surface Kirchhoff shell mesh and
//      solves them directly (the pure auto-shell path). The idealisation must
//      find all three plates — web and both flanges — and weld them along the
//      two web/flange T-junctions (KOF-205). It used to find the web alone, so
//      the shell bent several times further than the solid.
//   5. Solve the same model Solid and compare the tip deflections.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect } from "./coverage";

const here = dirname(fileURLToPath(import.meta.url));
const STEP_PATH = join(here, "../../test_files/I_beam.step");

const LENGTH = 300; // beam length along x (mm)
const TIP_LOAD_N = 5000; // 5 kN total, −y (strong-axis bending)
// Timoshenko cantilever with the default steel (E = 210 GPa, ν = 0.3):
// bending P·L³/(3·E·I) = 0.096 mm with I = 2.24e6 mm⁴, plus shear
// P·L/(G·A_web) = 0.018 mm — 0.113 mm in all. The web alone (I = 4.3e5 mm⁴)
// would bend about 0.52 mm.
const BEAM_THEORY_TIP_MM = 0.113;

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

test("i-beam shell: import STEP, mesh, mark Shell, solve through the shell path @pipeline", async ({
  page,
}) => {
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
    )
    .toBe(1);

  await page.getByRole("button", { name: /Generate mesh/i }).click();
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
    )
    .toBeGreaterThan(0);

  // 3–5. Solve the cantilever twice — once with the body marked Shell (the
  // feature under test) and once Solid (the reference) — through the real worker.
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
        dof: 1, // −y: bends the beam about its strong axis
        value: -tipLoad / end.length,
      }));

      const solveWith = async (discretization: "shell" | "solid") => {
        const properties = props.map((p) => ({ ...p, discretization }));
        const res = (await win.__kofem.sendToWorker("solve", {
          solverMethod: "gauss-seidel",
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
        let tipUy = 0; // mean deflection of the loaded end, along the load
        for (const n of end) tipUy += disp[3 * nodes.indexOf(n) + 1];
        tipUy /= end.length;
        let maxVm = 0;
        for (const vm of res.vonMises) maxVm = Math.max(maxVm, vm);
        return {
          nDisp: disp.length,
          nVm: res.vonMises.length,
          allFinite:
            [...disp].every(Number.isFinite) &&
            [...res.vonMises].every(Number.isFinite),
          tipUy,
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
    { length: LENGTH, tipLoad: TIP_LOAD_N },
  );

  if (!result.ok) throw new Error(result.error);
  const { shell, solid } = result;

  // The pure auto-shell path carried the shell solve (not the silent all-solid
  // fallback that existed before), with the web and both flanges as walls.
  expect(
    logs.some((l) => /\[auto-shell\] body \d+: 3 thin walls/.test(l)),
  ).toBe(true);

  // Result contract is preserved: three translations per store node, one von
  // Mises per store element, all finite (a converged solve).
  expect(shell.nDisp).toBe(result.nNodes * 3);
  expect(shell.nVm).toBe(result.nElems);
  expect(shell.allFinite).toBe(true);
  expect(shell.maxVm).toBeGreaterThan(0);

  // The tip deflects along the load, as far as beam theory and the solid say.
  // A shell that lost the flanges, or whose plates were not welded at the
  // web/flange junctions, would bend several times further (or not solve).
  expect(shell.tipUy).toBeLessThan(0);
  expect(-shell.tipUy).toBeGreaterThan(0.85 * BEAM_THEORY_TIP_MM);
  expect(-shell.tipUy).toBeLessThan(1.15 * BEAM_THEORY_TIP_MM);
  expect(solid.tipUy).toBeLessThan(0);
  expect(shell.tipUy / solid.tipUy).toBeGreaterThan(0.85);
  expect(shell.tipUy / solid.tipUy).toBeLessThan(1.15);
});

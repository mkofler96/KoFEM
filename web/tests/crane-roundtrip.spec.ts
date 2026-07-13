// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Full STEP → mesh → solve roundtrip of the crane assembly, exercising the
// per-body element-type feature end to end:
//   1. Import full-crane-hook.step. The thin holder is auto-preselected "Shell",
//      the pin and hook stay "Solid" — decided from the tessellation before any
//      mesh exists (detectShellBodies).
//   2. Mesh the STEP volume through the real meshing pipeline (worker reset and
//      all).
//   3. Fully fix the holder's top face and apply 2 kN total downward on the pin.
//   4. Solve. Because the holder is marked Shell, the worker routes to the coupled
//      solid+shell path (auto-shell), which converges where the all-solid thin
//      part stalls (#358). Assert a converged, finite, physically sane result.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect } from "./coverage";

const here = dirname(fileURLToPath(import.meta.url));
const STEP_PATH = join(here, "../../test_files/full-crane-hook.step");

// CAD (OCC) face ids, stable across re-meshing: 7 is the holder's top mounting
// face (fully fixed); 66 and 67 are the two pin ends (loaded). Same ids the
// coupled crane generator uses.
const FIXED_FACE = 7;
const LOAD_FACES = [66, 67];
const TOTAL_LOAD_N = 2000; // 2 kN total, downward (−Y)

interface Body {
  id: number;
  discretization?: string;
}

test("crane roundtrip: import STEP, auto-shell the holder, mesh, load 2 kN, fix top, solve", async ({
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

  // 1. Import the STEP through the real file-import path (hidden STEP input).
  await page.setInputFiles('input[accept=".stp,.step"]', STEP_PATH);

  // The tessellation-based detector runs on import: the thin holder (body 1) is
  // preselected Shell, the bulky pin (3) and hook (2) stay Solid.
  await expect
    .poll(
      async () =>
        (
          (await page.evaluate(
            () =>
              (
                window as unknown as {
                  __kofemStore: { getState(): { properties: Body[] } };
                }
              ).__kofemStore.getState().properties,
          )) as Body[]
        ).length,
      { timeout: 60_000 },
    )
    .toBe(3);
  const bodies = (await page.evaluate(
    () =>
      (
        window as unknown as {
          __kofemStore: { getState(): { properties: Body[] } };
        }
      ).__kofemStore.getState().properties,
  )) as Body[];
  const disc = Object.fromEntries(bodies.map((b) => [b.id, b.discretization]));
  expect(disc[1]).toBe("shell"); // thin holder → shell, auto-preselected pre-mesh
  expect(disc[2]).toBe("solid"); // hook → solid
  expect(disc[3]).toBe("solid"); // pin → solid

  // 2. Mesh the STEP volume (coarser element size keeps the roundtrip quick).
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

  // 3. Fully fix the top face, apply 2 kN total on the pin ends, and solve
  //    through the real worker (same solve message the Solve button sends).
  const result = await page.evaluate(
    async ({ fixedFace, loadFaces, totalLoad }) => {
      const win = window as unknown as {
        __kofem: {
          sendToWorker(name: string, payload: object): Promise<unknown>;
        };
        __kofemStore: { getState(): Record<string, unknown> };
      };
      const st = win.__kofemStore.getState();
      const tris = st.surfaceTriangles as [number, number, number][] | null;
      const faceIds = st.surfaceFaceIds as number[] | null;
      if (!tris || !faceIds) return { ok: false, error: "no surface mesh" };
      const faces = [...new Set(faceIds)].sort((a, b) => a - b);

      const fixedNodes = new Set<number>();
      const loadTriangles: number[][] = [];
      for (let t = 0; t < faceIds.length; t++) {
        if (faceIds[t] === fixedFace)
          for (const n of tris[t]) fixedNodes.add(n);
        if (loadFaces.includes(faceIds[t])) loadTriangles.push([...tris[t]]);
      }
      if (fixedNodes.size === 0 || loadTriangles.length === 0)
        return {
          ok: false,
          error: `face lookup failed: fixed ${fixedNodes.size}, load tris ${loadTriangles.length}, faces [${faces.join(", ")}]`,
        };

      // Fully clamp the top face (all three translations; the coupled path
      // auto-fixes the shell rotations of a fully-clamped shell node). 2 kN total
      // downward on the pin ends, distributed as a surface traction.
      const constraints = [...fixedNodes].flatMap((nodeId) =>
        [0, 1, 2].map((dof) => ({ nodeId, dof })),
      );
      const surfaceLoads = [
        { type: "force", faces: loadTriangles, force: [0, -totalLoad, 0] },
      ];

      const res = (await win.__kofem.sendToWorker("solve", {
        nodes: st.nodes,
        elements: st.elements,
        materials: st.materials,
        properties: st.properties, // carry the per-body discretization
        constraints,
        loads: [],
        surfaceLoads,
        elementOrder: st.elementOrder,
        surfaceTriangles: st.surfaceTriangles,
        surfaceFaceIds: st.surfaceFaceIds,
      })) as { displacements: Float64Array; vonMises: Float64Array };

      const disp = res.displacements;
      let maxU = 0;
      for (let i = 0; i < disp.length; i += 3)
        maxU = Math.max(maxU, Math.hypot(disp[i], disp[i + 1], disp[i + 2]));
      return {
        ok: true,
        nNodes: (st.nodes as unknown[]).length,
        nElems: (st.elements as unknown[]).length,
        nDisp: disp.length,
        nVm: res.vonMises.length,
        allFinite:
          [...disp].every(Number.isFinite) &&
          [...res.vonMises].every(Number.isFinite),
        maxU,
      };
    },
    { fixedFace: FIXED_FACE, loadFaces: LOAD_FACES, totalLoad: TOTAL_LOAD_N },
  );

  if (!result.ok) throw new Error(result.error);
  // The coupled (auto-shell) path carried the solve — the holder is Shell.
  expect(logs.some((l) => l.includes("[auto-shell]"))).toBe(true);
  expect(result.nDisp).toBe((result.nNodes ?? 0) * 3);
  expect(result.nVm).toBe(result.nElems);
  expect(result.allFinite).toBe(true);
  // A 2 kN load on a steel crane hook deflects on the order of a millimetre —
  // non-trivial but far from a runaway (a broken/near-hinge tie).
  expect(result.maxU ?? 0).toBeGreaterThan(1e-3);
  expect(result.maxU ?? 0).toBeLessThan(20);
});

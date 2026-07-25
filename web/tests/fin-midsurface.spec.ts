// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Mesh-time auto-shell idealisation (#397): meshing a STEP whose thin body is
// marked Shell must STORE the mixed CTRIA3 + CTETRA model, not an all-solid mesh
// whose shells exist only transiently inside the solve.
//
// fin_two_parts.step is a 2 mm fin (body 2, walls at y = 49 and y = 51) attached
// to a solid base block (body 1). After meshing the model must contain:
//   - CTRIA3 facets on the fin MID-SURFACE (y = 50, i.e. t/2 inside each wall),
//   - CTETRA tets for the base that stays solid,
//   - one PSHELL property per distinct wall thickness, carrying that thickness,
// and the mixed model must then solve through the coupled shell/solid path.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect } from "./coverage";

const here = dirname(fileURLToPath(import.meta.url));
const STEP_PATH = join(here, "../../test_files/fin_two_parts.step");

const WALL_THICKNESS = 2; // fin walls at y = 49 / y = 51
const MID_SURFACE_Y = 50;

test("mesh-time auto-shell: the fin is stored as a mid-surface shell mesh", async ({
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
    .toBeGreaterThan(0);

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

  const meshed = await page.evaluate(() => {
    const state = (
      window as unknown as {
        __kofemStore: { getState(): Record<string, unknown> };
      }
    ).__kofemStore.getState();
    const nodes = state.nodes as {
      id: number;
      x: number;
      y: number;
      z: number;
    }[];
    const els = state.elements as {
      type: string;
      nodeIds: number[];
      propertyId: number;
    }[];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const shellEls = els.filter((e) => e.type === "CTRIA3");
    let ymin = Infinity,
      ymax = -Infinity;
    for (const e of shellEls)
      for (const nid of e.nodeIds) {
        const n = byId.get(nid);
        if (!n) continue;
        ymin = Math.min(ymin, n.y);
        ymax = Math.max(ymax, n.y);
      }
    const props = state.properties as {
      id: number;
      thickness?: number;
      discretization?: string;
    }[];
    return {
      nTets: els.filter((e) => e.type === "CTETRA").length,
      nShells: shellEls.length,
      shellYMin: ymin,
      shellYMax: ymax,
      shellProps: props
        .filter((p) => p.thickness !== undefined)
        .map((p) => ({ id: p.id, thickness: p.thickness })),
    };
  });

  // Both element families are present — a genuinely mixed model.
  expect(meshed.nShells).toBeGreaterThan(0);
  expect(meshed.nTets).toBeGreaterThan(0);

  // The shell facets sit on the mid-surface, not on either original wall face.
  expect(meshed.shellYMin).toBeCloseTo(MID_SURFACE_Y, 3);
  expect(meshed.shellYMax).toBeCloseTo(MID_SURFACE_Y, 3);

  // One PSHELL per wall thickness, carrying the measured section thickness.
  expect(meshed.shellProps.length).toBeGreaterThan(0);
  for (const p of meshed.shellProps)
    expect(p.thickness).toBeCloseTo(WALL_THICKNESS, 1);

  expect(
    logs.some(
      (l) => l.includes("[auto-shell]") && l.includes("thickness section"),
    ),
  ).toBe(true);

  // The stored mixed model solves through the coupled shell/solid path.
  const solved = await page.evaluate(async () => {
    const win = window as unknown as {
      __kofem: {
        sendToWorker(name: string, payload: object): Promise<unknown>;
      };
      __kofemStore: { getState(): Record<string, unknown> };
    };
    const state = win.__kofemStore.getState();
    const nodes = state.nodes as {
      id: number;
      x: number;
      y: number;
      z: number;
    }[];
    let zmin = Infinity,
      zmax = -Infinity;
    for (const n of nodes) {
      zmin = Math.min(zmin, n.z);
      zmax = Math.max(zmax, n.z);
    }
    const constraints: { nodeId: number; dof: number; value: number }[] = [];
    const loads: { nodeId: number; dof: number; value: number }[] = [];
    const tip = nodes.filter((n) => n.z > zmax - 1e-6);
    for (const n of nodes)
      if (n.z < zmin + 1e-6)
        for (let d = 0; d < 3; d++)
          constraints.push({ nodeId: n.id, dof: d, value: 0 });
    for (const n of tip)
      loads.push({ nodeId: n.id, dof: 1, value: 500 / tip.length });
    const result = (await win.__kofem.sendToWorker("solve", {
      nodes: state.nodes,
      elements: state.elements,
      materials: state.materials,
      properties: state.properties,
      constraints,
      loads,
      surfaceTriangles: state.surfaceTriangles,
      surfaceFaceIds: state.surfaceFaceIds,
    })) as { displacements?: Float64Array };
    const disp = result.displacements ?? new Float64Array();
    let maxMag = 0;
    let allFinite = true;
    for (let i = 0; i < disp.length; i += 3) {
      const mag = Math.hypot(disp[i], disp[i + 1], disp[i + 2]);
      if (!Number.isFinite(mag)) allFinite = false;
      maxMag = Math.max(maxMag, mag);
    }
    return { maxMag, allFinite, len: disp.length };
  });

  expect(solved.len).toBeGreaterThan(0);
  expect(solved.allFinite).toBe(true);
  expect(solved.maxMag).toBeGreaterThan(0);
  expect(logs.some((l) => l.includes("[coupled] converged"))).toBe(true);
});

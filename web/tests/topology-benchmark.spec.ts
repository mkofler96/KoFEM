// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Fast Playwright guard for the topology-optimization BENCHMARK behaviour
// (KOF-234). The authoritative benchmarks — the MBB beam, a 3D cantilever and a
// mesh-independence study, with documented compliance/volume bands — live in
// examples/validation/topopt/ and run against the fetched engine under node.
// They are thorough but take ~25 s, too slow for every CI run.
//
// This spec drives the same optimize_topology worker path with a small MBB
// half-beam and asserts the benchmark-defining trajectory SHAPE, so the
// Playwright suite catches a regression cheaply: the volume constraint is met,
// the structure stiffens substantially, the run ends at its stiffest design, and
// a real bimodal topology emerges rather than a stalled uniform-gray field. The
// sibling topology-optimize.spec.ts only checks the field is well-formed; this
// one checks the optimizer actually optimized.

import { test, expect } from "./coverage";
import { gotoApp } from "./fixtures/app";

// MBB half-beam on a structured hex grid: left face is the symmetry plane
// (u_x = 0), a roller at the bottom-right corner (u_y = 0), and half the central
// load presses down at the top of the symmetry edge. One element through the
// thickness with u_z = 0 makes it planar. Returns store-shaped nodes/CHEXA
// elements plus the constrained/loaded node-id lists. Hex vertex order matches
// MFEM's AddHex (bottom face CCW, then the matching top face).
function makeMbb(nx: number, ny: number) {
  const halfSpan = 6;
  const height = 2;
  const thickness = 0.5;
  const nid = (i: number, j: number, k: number) => i * (ny + 1) * 2 + j * 2 + k;

  const nodes: { id: number; x: number; y: number; z: number }[] = [];
  for (let i = 0; i <= nx; i++)
    for (let j = 0; j <= ny; j++)
      for (let k = 0; k <= 1; k++)
        nodes.push({
          id: nid(i, j, k),
          x: (i * halfSpan) / nx,
          y: (j * height) / ny,
          z: k * thickness,
        });

  const elements: {
    id: number;
    type: string;
    nodeIds: number[];
    propertyId: number;
  }[] = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      elements.push({
        id: elements.length,
        type: "CHEXA",
        nodeIds: [
          nid(i, j, 0),
          nid(i + 1, j, 0),
          nid(i + 1, j + 1, 0),
          nid(i, j + 1, 0),
          nid(i, j, 1),
          nid(i + 1, j, 1),
          nid(i + 1, j + 1, 1),
          nid(i, j + 1, 1),
        ],
        propertyId: 1,
      });

  const tol = 1e-9;
  // u_z = 0 on every node (planar); u_x = 0 on the symmetry face x = 0; u_y = 0
  // at the bottom-right roller corner (x = halfSpan, y = 0).
  const constraints: { nodeId: number; dof: number }[] = [];
  for (const n of nodes) {
    constraints.push({ nodeId: n.id, dof: 2 });
    if (n.x <= tol) constraints.push({ nodeId: n.id, dof: 0 });
    if (n.x >= halfSpan - tol && n.y <= tol)
      constraints.push({ nodeId: n.id, dof: 1 });
  }
  const loadedNodeIds = nodes
    .filter((n) => n.x <= tol && n.y >= height - tol)
    .map((n) => n.id);
  const loads = loadedNodeIds.map((nodeId) => ({
    nodeId,
    dof: 1,
    value: -1 / loadedNodeIds.length,
  }));

  return { nodes, elements, constraints, loads };
}

test("optimize_topology worker: MBB beam converges to a stiffened bimodal layout", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const logs: string[] = [];
  page.on("console", (msg) => logs.push(msg.text()));
  page.on("pageerror", (e) =>
    console.error(`[topopt-benchmark] page error: ${e.message}`),
  );

  await gotoApp(page);
  await page.waitForFunction(
    () => !!(window as unknown as { __kofem: unknown }).__kofem,
  );

  const result = (await page.evaluate(
    async (mbb) => {
      const { nodes, elements, constraints, loads } = mbb;
      const payload = {
        nodes,
        elements,
        materials: [
          { id: 1, name: "Unit", young: 1, poisson: 0.3, density: 1 },
        ],
        properties: [{ id: 1, materialId: 1 }],
        constraints,
        loads,
        settings: {
          objective: "min_compliance",
          constraints: { volumeFraction: 0.5 },
          penalty: 3,
          filterRadius: 0.54, // ≈ 1.8 element widths at 20×7 (L/nx = 0.3)
          moveLimit: 0.2,
          maxIterations: 40,
          tolerance: 0.01,
        },
      };

      const res = (await (
        window as unknown as {
          __kofem: {
            sendToWorker: (
              type: string,
              payload: unknown,
            ) => Promise<{
              density: Float64Array;
              history: { it: number; objective: number; volume: number }[];
            }>;
          };
        }
      ).__kofem.sendToWorker("optimize_topology", payload)) as {
        density: Float64Array;
        history: { it: number; objective: number; volume: number }[];
      };

      const density = Array.from(res.density);
      const n = density.length;
      let mean = 0;
      let solid = 0;
      let empty = 0;
      for (const d of density) {
        mean += d;
        if (d > 0.9) solid++;
        if (d < 0.1) empty++;
      }
      mean /= n;
      let variance = 0;
      for (const d of density) variance += (d - mean) ** 2;
      const std = Math.sqrt(variance / n);

      const objectives = res.history.map((h) => h.objective);
      return {
        elementCount: elements.length,
        densityLength: n,
        iterations: res.history.length,
        ratio: objectives[objectives.length - 1] / objectives[0],
        finalIsMin:
          objectives[objectives.length - 1] <=
          Math.min(...objectives) * (1 + 1e-6),
        finalVolume: res.history[res.history.length - 1].volume,
        std,
        solid,
        void: empty,
      };
    },
    makeMbb(20, 7),
  )) as {
    elementCount: number;
    densityLength: number;
    iterations: number;
    ratio: number;
    finalIsMin: boolean;
    finalVolume: number;
    std: number;
    solid: number;
    void: number;
  };

  // One density per element.
  expect(result.densityLength).toBe(result.elementCount);
  // The volume constraint is met (within 2 % of the 0.5 target).
  expect(Math.abs(result.finalVolume - 0.5)).toBeLessThan(0.02);
  // The structure stiffens substantially — final compliance well under half the
  // uniform-density start — and the run ends at its stiffest design.
  expect(result.ratio).toBeLessThan(0.5);
  expect(result.finalIsMin).toBe(true);
  // A real topology emerged: material pushed to both extremes, not a gray field.
  expect(result.std).toBeGreaterThan(0.15);
  expect(result.solid).toBeGreaterThan(0);
  expect(result.void).toBeGreaterThan(0);

  // The per-iteration progress still streams over the log channel.
  expect(logs.some((l) => l.includes("[topopt] it"))).toBe(true);
});

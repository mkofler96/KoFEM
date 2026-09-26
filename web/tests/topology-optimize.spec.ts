// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit-level smoke test for the topology-optimization worker path (KOF-231):
// build a tiny solid tet mesh in the page, post it to the solver worker's
// `optimize_topology` message, and check that the engine returns a density field
// with one value per element and streams at least one per-iteration progress log
// line. It exercises the whole KOF-231 surface end to end — handleTopOpt's mesh
// packing, the Embind entry, the SIMP loop (KOF-230) and the progress channel —
// without needing a STEP import or the UI. The optimized layout itself (the
// "textbook truss") is validated separately in the native cases (KOF-234).

import { test, expect } from "./coverage";
import { gotoApp } from "./fixtures/app";

// A cantilever beam of unit cubes, each split into 6 tets (Freudenthal, all
// sharing the 0–7 body diagonal). Returns store-shaped nodes/elements plus the
// x=0 (built-in) and x=Lx (loaded) node ids, so the caller can constrain and
// load the two ends into a well-posed minimum-compliance problem.
function makeBeam(nx: number, ny: number, nz: number) {
  const nid = (ix: number, iy: number, iz: number) =>
    ix + (nx + 1) * (iy + (ny + 1) * iz);

  const nodes: { id: number; x: number; y: number; z: number }[] = [];
  for (let iz = 0; iz <= nz; iz++)
    for (let iy = 0; iy <= ny; iy++)
      for (let ix = 0; ix <= nx; ix++)
        nodes.push({ id: nid(ix, iy, iz), x: ix, y: iy, z: iz });

  // Local corner offsets 0..7 with bits (lx=1, ly=2, lz=4).
  const corner = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 1],
  ];
  const tets = [
    [0, 1, 3, 7],
    [0, 3, 2, 7],
    [0, 2, 6, 7],
    [0, 6, 4, 7],
    [0, 4, 5, 7],
    [0, 5, 1, 7],
  ];

  const elements: {
    id: number;
    type: string;
    nodeIds: number[];
    propertyId: number;
  }[] = [];
  for (let cz = 0; cz < nz; cz++)
    for (let cy = 0; cy < ny; cy++)
      for (let cx = 0; cx < nx; cx++) {
        const gnode = (local: number) =>
          nid(
            cx + corner[local][0],
            cy + corner[local][1],
            cz + corner[local][2],
          );
        for (const tet of tets)
          elements.push({
            id: elements.length,
            type: "CTETRA",
            nodeIds: tet.map(gnode),
            propertyId: 1,
          });
      }

  const fixedNodeIds = nodes.filter((n) => n.x === 0).map((n) => n.id);
  const loadedNodeIds = nodes.filter((n) => n.x === nx).map((n) => n.id);
  return { nodes, elements, fixedNodeIds, loadedNodeIds };
}

test("optimize_topology worker: density field of element length + progress logs", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const logs: string[] = [];
  page.on("console", (msg) => logs.push(msg.text()));
  page.on("pageerror", (e) =>
    console.error(`[topopt-unit] page error: ${e.message}`),
  );

  await gotoApp(page);
  await page.waitForFunction(() => !!(window as any).__kofem);

  const result = (await page.evaluate(
    async (beam) => {
      const { nodes, elements, fixedNodeIds, loadedNodeIds } = beam;
      const constraints = fixedNodeIds.flatMap((nodeId) => [
        { nodeId, dof: 0 },
        { nodeId, dof: 1 },
        { nodeId, dof: 2 },
      ]);
      const loads = loadedNodeIds.map((nodeId) => ({
        nodeId,
        dof: 2,
        value: -100,
      }));

      const payload = {
        nodes,
        elements,
        materials: [
          {
            id: 1,
            name: "Steel",
            young: 210000,
            poisson: 0.3,
            density: 7.85e-9,
          },
        ],
        properties: [{ id: 1, materialId: 1 }],
        constraints,
        loads,
        settings: {
          objective: "min_compliance",
          constraints: { volumeFraction: 0.5 },
          penalty: 3,
          filterRadius: 1.5,
          moveLimit: 0.2,
          maxIterations: 8,
          tolerance: 0.01,
        },
      };

      const res = (await (window as any).__kofem.sendToWorker(
        "optimize_topology",
        payload,
      )) as { density: Float64Array; history: unknown[] };
      return {
        densityLength: res.density.length,
        elementCount: elements.length,
        historyLength: res.history.length,
        allFinite: Array.from(res.density).every((d) => Number.isFinite(d)),
        inRange: Array.from(res.density).every((d) => d >= 0 && d <= 1),
      };
    },
    makeBeam(4, 1, 1),
  )) as {
    densityLength: number;
    elementCount: number;
    historyLength: number;
    allFinite: boolean;
    inRange: boolean;
  };

  // One density per element, all finite and within the SIMP [0, 1] bounds.
  expect(result.densityLength).toBe(result.elementCount);
  expect(result.historyLength).toBeGreaterThanOrEqual(1);
  expect(result.allFinite).toBe(true);
  expect(result.inRange).toBe(true);

  // At least one per-iteration progress line reached the log channel (the engine
  // prints "[topopt] it N: c=… vol=… change=…" each iteration).
  expect(logs.some((l) => l.includes("[topopt] it"))).toBe(true);
});

// The level-set method: same worker message with `method: "level_set"`. Besides
// the element densities it returns the nodal level set φ — one value per node,
// in payload node order, bounded to [−1, 1] — which the viewport contours at
// φ = 0 for the smooth boundary. The run starts from full material and walks the
// volume down, so the first history entry sits at volume 1.
test("optimize_topology worker: level-set method returns a nodal level set", async ({
  page,
}) => {
  test.setTimeout(180_000);
  page.on("pageerror", (e) =>
    console.error(`[topopt-levelset] page error: ${e.message}`),
  );

  await gotoApp(page);
  await page.waitForFunction(() =>
    Boolean((window as unknown as KofemTestHooks).__kofem),
  );

  const result = await page.evaluate(
    async (beam) => {
      const { nodes, elements, fixedNodeIds, loadedNodeIds } = beam;
      const kofem = (window as unknown as KofemTestHooks).__kofem;
      if (!kofem)
        throw new Error("window.__kofem test hooks are not installed");
      const res = (await kofem.sendToWorker("optimize_topology", {
        nodes,
        elements,
        materials: [
          {
            id: 1,
            name: "Steel",
            young: 210000,
            poisson: 0.3,
            density: 7.85e-9,
          },
        ],
        properties: [{ id: 1, materialId: 1 }],
        constraints: fixedNodeIds.flatMap((nodeId) =>
          [0, 1, 2].map((dof) => ({ nodeId, dof })),
        ),
        loads: loadedNodeIds.map((nodeId) => ({
          nodeId,
          dof: 2,
          value: -100,
        })),
        settings: {
          method: "level_set",
          objective: "min_compliance",
          constraints: { volumeFraction: 0.5 },
          filterRadius: 1,
          maxIterations: 40,
          tolerance: 0.01,
        },
      })) as {
        density: Float64Array;
        levelSet?: Float64Array;
        history: { volume: number }[];
      };
      const phi = res.levelSet ? Array.from(res.levelSet) : [];
      return {
        nodeCount: nodes.length,
        elementCount: elements.length,
        densityLength: res.density.length,
        levelSetLength: phi.length,
        phiBounded: phi.every((v) => v >= -1 && v <= 1),
        hasBoundary: phi.some((v) => v > 0) && phi.some((v) => v < 0),
        densityInRange: Array.from(res.density).every((d) => d >= 0 && d <= 1),
        firstVolume: res.history[0].volume,
        lastVolume: res.history[res.history.length - 1].volume,
      };
    },
    makeBeam(8, 2, 2),
  );

  expect(result.densityLength).toBe(result.elementCount);
  expect(result.levelSetLength).toBe(result.nodeCount);
  expect(result.phiBounded).toBe(true);
  expect(result.hasBoundary).toBe(true);
  expect(result.densityInRange).toBe(true);
  expect(result.firstVolume).toBeCloseTo(1, 9);
  expect(Math.abs(result.lastVolume - 0.5)).toBeLessThan(0.01);
});

// Live density streaming (KOF-240): the engine hands the worker the design
// density every iteration, and the worker forwards it as a progress message
// before the call resolves. One snapshot per iteration (streamEvery defaults to
// 1), iterations in order, the shape actually changing between snapshots, and
// the last snapshot bit-identical to the returned density.
type KofemTestHooks = {
  __kofem?: {
    sendToWorker(type: string, payload: unknown): Promise<unknown>;
    setProgressCallback(
      cb: ((progress: { it: number; density: Float64Array }) => void) | null,
    ): void;
  };
};

test("optimize_topology worker: streams the density every iteration", async ({
  page,
}) => {
  test.setTimeout(120_000);
  page.on("pageerror", (e) =>
    console.error(`[topopt-stream] page error: ${e.message}`),
  );

  await gotoApp(page);
  await page.waitForFunction(() =>
    Boolean((window as unknown as KofemTestHooks).__kofem),
  );

  const result = (await page.evaluate(
    async (beam) => {
      const { nodes, elements, fixedNodeIds, loadedNodeIds } = beam;
      const kofem = (window as unknown as KofemTestHooks).__kofem;
      if (!kofem)
        throw new Error("window.__kofem test hooks are not installed");
      const snapshots: { it: number; density: number[] }[] = [];
      kofem.setProgressCallback(
        ({ it, density }: { it: number; density: Float64Array }) =>
          snapshots.push({ it, density: Array.from(density) }),
      );
      const res = (await kofem.sendToWorker("optimize_topology", {
        nodes,
        elements,
        materials: [
          { id: 1, name: "Steel", young: 210000, poisson: 0.3, density: 0 },
        ],
        properties: [{ id: 1, materialId: 1 }],
        constraints: fixedNodeIds.flatMap((nodeId) =>
          [0, 1, 2].map((dof) => ({ nodeId, dof })),
        ),
        loads: loadedNodeIds.map((nodeId) => ({
          nodeId,
          dof: 2,
          value: -100,
        })),
        settings: {
          objective: "min_compliance",
          constraints: { volumeFraction: 0.5 },
          penalty: 3,
          filterRadius: 1.5,
          moveLimit: 0.2,
          maxIterations: 8,
          tolerance: 0.01,
        },
      })) as { density: Float64Array; history: { it: number }[] };
      kofem.setProgressCallback(null);

      const last = snapshots[snapshots.length - 1];
      const final = Array.from(res.density);
      return {
        its: snapshots.map((snap) => snap.it),
        historyIts: res.history.map((h) => h.it),
        lengthsOk: snapshots.every(
          (snap) => snap.density.length === elements.length,
        ),
        lastMatchesFinal:
          last !== undefined &&
          last.density.length === final.length &&
          last.density.every((d, i) => d === final[i]),
        firstDiffersFromLast:
          snapshots.length > 1 &&
          snapshots[0].density.some((d, i) => d !== last.density[i]),
      };
    },
    makeBeam(4, 1, 1),
  )) as {
    its: number[];
    historyIts: number[];
    lengthsOk: boolean;
    lastMatchesFinal: boolean;
    firstDiffersFromLast: boolean;
  };

  expect(result.its.length).toBeGreaterThan(1);
  expect(result.its).toEqual(result.historyIts);
  expect(result.lengthsOk).toBe(true);
  expect(result.firstDiffersFromLast).toBe(true);
  expect(result.lastMatchesFinal).toBe(true);
});

// KOF-235: the min_volume objective (minimize volume s.t. compliance ≤ c_allow)
// runs through the same worker entry. The full-material compliance c_full is the
// least any design can reach, so a limit of 2·c_full is feasible and must shed
// material while meeting the limit, and a limit below c_full must be rejected.
test("optimize_topology worker: min_volume meets its compliance limit", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await gotoApp(page);
  await page.waitForFunction(() =>
    Boolean((window as unknown as KofemTestHooks).__kofem),
  );

  const result = (await page.evaluate(
    async (beam) => {
      const { nodes, elements, fixedNodeIds, loadedNodeIds } = beam;
      type History = {
        it: number;
        objective: number;
        compliance: number;
        volume: number;
      }[];
      const kofem = (window as unknown as KofemTestHooks).__kofem;
      if (!kofem)
        throw new Error("window.__kofem test hooks are not installed");
      const run = async (settings: Record<string, unknown>) => {
        const payload = {
          nodes,
          elements,
          materials: [
            {
              id: 1,
              name: "Steel",
              young: 210000,
              poisson: 0.3,
              density: 7.85e-9,
            },
          ],
          properties: [{ id: 1, materialId: 1 }],
          constraints: fixedNodeIds.flatMap((nodeId) => [
            { nodeId, dof: 0 },
            { nodeId, dof: 1 },
            { nodeId, dof: 2 },
          ]),
          loads: loadedNodeIds.map((nodeId) => ({
            nodeId,
            dof: 2,
            value: -100,
          })),
          settings: {
            penalty: 3,
            filterRadius: 1.5,
            moveLimit: 0.2,
            tolerance: 0.01,
            ...settings,
          },
        };
        try {
          const res = (await kofem.sendToWorker(
            "optimize_topology",
            payload,
          )) as { history: History };
          return { history: res.history, error: null };
        } catch (e) {
          return { history: [] as History, error: String(e) };
        }
      };

      // One full-material analysis gives c_full.
      const full = await run({
        objective: "min_compliance",
        constraints: { volumeFraction: 1 },
        maxIterations: 1,
      });
      const cFull = full.history[0].compliance;
      const limit = 2 * cFull;
      const minVol = await run({
        objective: "min_volume",
        constraints: { complianceLimit: limit },
        maxIterations: 60,
      });
      const infeasible = await run({
        objective: "min_volume",
        constraints: { complianceLimit: 0.5 * cFull },
        maxIterations: 5,
      });
      return { cFull, limit, minVol, infeasible };
    },
    makeBeam(6, 1, 1),
  )) as {
    cFull: number;
    limit: number;
    minVol: {
      history: {
        objective: number;
        compliance: number;
        volume: number;
      }[];
      error: string | null;
    };
    infeasible: { error: string | null };
  };

  expect(result.cFull).toBeGreaterThan(0);
  expect(result.minVol.error).toBeNull();
  const history = result.minVol.history;
  const last = history[history.length - 1];
  // Starts at full material; the objective reported is the volume fraction.
  expect(history[0].volume).toBeCloseTo(1, 9);
  expect(last.objective).toBe(last.volume);
  // Material was removed while the compliance limit held (within MMA's slack).
  expect(last.volume).toBeLessThan(0.9);
  expect(last.compliance).toBeLessThanOrEqual(result.limit * 1.02);

  expect(result.infeasible.error).toContain("infeasible");
});

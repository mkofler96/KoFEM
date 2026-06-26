// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import { bootstrapCantilever } from "./fixtures/cantilever";

type Store = {
  getState(): {
    nodes: { id: number; x: number; y: number; z: number }[];
    loads: { nodeId: number; dof: number; value: number }[];
    clearLoads(): void;
    createLoadGroup(
      faces: { label: string; nodeIds: number[] }[],
      dof: number,
      totalForce: number,
    ): void;
  };
};

// ── Moment-load conversion math ───────────────────────────────────────────────

test("Mz moment produces tangential forces with zero net force and correct net moment", async ({
  page,
}) => {
  await bootstrapCantilever(page);

  const result = await page.evaluate(() => {
    const store = (window as unknown as { __kofemStore: Store }).__kofemStore;

    // End face of cantilever (x ≈ 1.0) — 9 nodes on a 3×3 grid
    const endNodes = store
      .getState()
      .nodes.filter((n) => Math.abs(n.x - 1.0) < 1e-9);
    store.getState().clearLoads();
    store.getState().createLoadGroup(
      [{ label: "End face", nodeIds: endNodes.map((n) => n.id) }],
      5, // Mz
      1000,
    );

    // Re-read loads from fresh state after mutations
    const loads = store.getState().loads;

    // Centroid of the face
    const cx = endNodes.reduce((s, n) => s + n.x, 0) / endNodes.length;
    const cy = endNodes.reduce((s, n) => s + n.y, 0) / endNodes.length;

    const nodeById = new Map(endNodes.map((n) => [n.id, n]));
    let netFx = 0,
      netFy = 0,
      netFz = 0,
      netMz = 0;
    for (const l of loads) {
      const n = nodeById.get(l.nodeId)!;
      const rx = n.x - cx,
        ry = n.y - cy;
      if (l.dof === 0) {
        netFx += l.value;
        netMz -= ry * l.value;
      }
      if (l.dof === 1) {
        netFy += l.value;
        netMz += rx * l.value;
      }
      if (l.dof === 2) netFz += l.value;
    }

    return { nodeCount: endNodes.length, netFx, netFy, netFz, netMz, loads };
  });

  expect(result.nodeCount).toBe(9); // 3×3 end face
  // All resulting loads must be force DOFs (0–2), not moment DOFs
  expect(result.loads.every((l) => l.dof <= 2)).toBe(true);
  // Net force must be zero (pure couple)
  expect(result.netFx).toBeCloseTo(0, 9);
  expect(result.netFy).toBeCloseTo(0, 9);
  expect(result.netFz).toBeCloseTo(0, 9);
  // Net moment about z must equal the applied moment exactly
  expect(result.netMz).toBeCloseTo(1000, 6);
});

test("Mx moment produces correct net moment about x and zero net force", async ({
  page,
}) => {
  await bootstrapCantilever(page);

  const result = await page.evaluate(() => {
    const store = (window as unknown as { __kofemStore: Store }).__kofemStore;

    const endNodes = store
      .getState()
      .nodes.filter((n) => Math.abs(n.x - 1.0) < 1e-9);
    store.getState().clearLoads();
    store.getState().createLoadGroup(
      [{ label: "End face", nodeIds: endNodes.map((n) => n.id) }],
      3, // Mx
      500,
    );

    const loads = store.getState().loads;
    const cy = endNodes.reduce((s, n) => s + n.y, 0) / endNodes.length;
    const cz = endNodes.reduce((s, n) => s + n.z, 0) / endNodes.length;

    const nodeById = new Map(endNodes.map((n) => [n.id, n]));
    let netFx = 0,
      netFy = 0,
      netFz = 0,
      netMx = 0;
    for (const l of loads) {
      const n = nodeById.get(l.nodeId)!;
      const ry = n.y - cy,
        rz = n.z - cz;
      if (l.dof === 0) netFx += l.value;
      if (l.dof === 1) {
        netFy += l.value;
        netMx -= rz * l.value;
      }
      if (l.dof === 2) {
        netFz += l.value;
        netMx += ry * l.value;
      }
    }

    return { netFx, netFy, netFz, netMx, loads };
  });

  expect(result.loads.every((l) => l.dof <= 2)).toBe(true);
  expect(result.netFx).toBeCloseTo(0, 9);
  expect(result.netFy).toBeCloseTo(0, 9);
  expect(result.netFz).toBeCloseTo(0, 9);
  expect(result.netMx).toBeCloseTo(500, 6);
});

test("My moment produces correct net moment about y and zero net force", async ({
  page,
}) => {
  await bootstrapCantilever(page);

  const result = await page.evaluate(() => {
    const store = (window as unknown as { __kofemStore: Store }).__kofemStore;

    const endNodes = store
      .getState()
      .nodes.filter((n) => Math.abs(n.x - 1.0) < 1e-9);
    store.getState().clearLoads();
    store.getState().createLoadGroup(
      [{ label: "End face", nodeIds: endNodes.map((n) => n.id) }],
      4, // My
      750,
    );

    const loads = store.getState().loads;
    const cx = endNodes.reduce((s, n) => s + n.x, 0) / endNodes.length;
    const cz = endNodes.reduce((s, n) => s + n.z, 0) / endNodes.length;

    const nodeById = new Map(endNodes.map((n) => [n.id, n]));
    let netFx = 0,
      netFy = 0,
      netFz = 0,
      netMy = 0;
    for (const l of loads) {
      const n = nodeById.get(l.nodeId)!;
      const rx = n.x - cx,
        rz = n.z - cz;
      if (l.dof === 0) {
        netFx += l.value;
        netMy += rz * l.value;
      }
      if (l.dof === 1) netFy += l.value;
      if (l.dof === 2) {
        netFz += l.value;
        netMy -= rx * l.value;
      }
    }

    return { netFx, netFy, netFz, netMy, loads };
  });

  expect(result.loads.every((l) => l.dof <= 2)).toBe(true);
  expect(result.netFx).toBeCloseTo(0, 9);
  expect(result.netFy).toBeCloseTo(0, 9);
  expect(result.netFz).toBeCloseTo(0, 9);
  expect(result.netMy).toBeCloseTo(750, 6);
});

// ── Solve integration ─────────────────────────────────────────────────────────

test("solve worker completes when loads include a moment (Mz)", async ({
  page,
}) => {
  await bootstrapCantilever(page);

  // Replace the default Fy force load with a Mz moment load, then feed the
  // resulting (force-only) solver payload straight into the worker — no UI.
  const result = (await page.evaluate(async () => {
    const store = (window as unknown as { __kofemStore: Store }).__kofemStore;
    const state = store.getState();
    const endNodes = state.nodes.filter((n) => Math.abs(n.x - 1.0) < 1e-9);
    state.clearLoads();
    state.createLoadGroup(
      [{ label: "End face", nodeIds: endNodes.map((n) => n.id) }],
      5, // Mz — 1 kN·m torsion at the free end
      1000,
    );

    const s = store.getState() as unknown as {
      nodes: unknown[];
      elements: unknown[];
      materials: unknown[];
      properties: unknown[];
      constraints: unknown[];
      loads: unknown[];
    };
    const kofem = (
      window as unknown as {
        __kofem: {
          sendToWorker(name: string, payload: object): Promise<unknown>;
        };
      }
    ).__kofem;
    return kofem.sendToWorker("solve", {
      nodes: s.nodes,
      elements: s.elements,
      materials: s.materials,
      properties: s.properties,
      constraints: s.constraints,
      loads: s.loads,
    });
  })) as { displacements: number[] };

  // 3 displacement components per node — a complete solve with no NaNs.
  expect(result.displacements.length).toBeGreaterThan(0);
  expect(result.displacements.every((v) => Number.isFinite(v))).toBe(true);
});

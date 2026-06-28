// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import { bootstrapCantilever } from "./fixtures/cantilever";

// Coverage for issues #219 / #190: forces (and moments) specified componentwise
// — a full [x, y, z] vector instead of a single axis + magnitude.

type Store = {
  getState(): {
    nodes: { id: number; x: number; y: number; z: number }[];
    loads: { nodeId: number; dof: number; value: number }[];
    surfaceLoads: {
      type: string;
      force?: [number, number, number];
      faces: number[][];
    }[];
    loadGroups: {
      kind?: string;
      dof: number;
      totalForce: number;
      components?: [number, number, number];
    }[];
    clearLoads(): void;
    createLoadGroup(
      faces: { label: string; nodeIds: number[] }[],
      dof: number,
      totalForce: number,
      kind?: string,
      components?: [number, number, number],
    ): void;
  };
};

// ── Componentwise force ───────────────────────────────────────────────────────

test("a componentwise force builds surface loads carrying the full vector", async ({
  page,
}) => {
  await bootstrapCantilever(page);

  const result = await page.evaluate(() => {
    const store = (window as unknown as { __kofemStore: Store }).__kofemStore;
    const endNodes = store
      .getState()
      .nodes.filter((n) => Math.abs(n.x - 1.0) < 1e-9);
    store.getState().clearLoads();
    store
      .getState()
      .createLoadGroup(
        [{ label: "End face", nodeIds: endNodes.map((n) => n.id) }],
        0,
        0,
        "force",
        [100, -200, 300],
      );
    const s = store.getState();
    return {
      group: s.loadGroups[0],
      surfaceLoads: s.surfaceLoads,
      nodalLoads: s.loads.length,
    };
  });

  // The vector is stored verbatim as the source of truth.
  expect(result.group.components).toEqual([100, -200, 300]);
  expect(result.group.kind).toBe("force");
  // Forces reach the solver as surface tractions, never lumped nodal forces.
  expect(result.nodalLoads).toBe(0);
  expect(result.surfaceLoads.length).toBeGreaterThan(0);
  for (const sl of result.surfaceLoads) {
    expect(sl.type).toBe("force");
    expect(sl.force).toEqual([100, -200, 300]);
  }
});

test("a single-axis legacy force still maps onto the surface-load vector", async ({
  page,
}) => {
  await bootstrapCantilever(page);

  // The 3-arg createLoadGroup (no components) is the legacy single-axis form
  // used by older saved analyses and the fixtures; it must reconstruct the
  // same surface-load vector that componentwise input produces.
  const result = await page.evaluate(() => {
    const store = (window as unknown as { __kofemStore: Store }).__kofemStore;
    const endNodes = store
      .getState()
      .nodes.filter((n) => Math.abs(n.x - 1.0) < 1e-9);
    store.getState().clearLoads();
    store
      .getState()
      .createLoadGroup(
        [{ label: "End face", nodeIds: endNodes.map((n) => n.id) }],
        1,
        -5000,
      );
    return store.getState().surfaceLoads;
  });

  expect(result.length).toBeGreaterThan(0);
  for (const sl of result) expect(sl.force).toEqual([0, -5000, 0]);
});

// ── Componentwise moment ──────────────────────────────────────────────────────

test("a componentwise moment sums per-axis couples with zero net force", async ({
  page,
}) => {
  await bootstrapCantilever(page);

  const result = await page.evaluate(() => {
    const store = (window as unknown as { __kofemStore: Store }).__kofemStore;
    const endNodes = store
      .getState()
      .nodes.filter((n) => Math.abs(n.x - 1.0) < 1e-9);
    store.getState().clearLoads();
    // Simultaneous Mx and Mz applied componentwise.
    store
      .getState()
      .createLoadGroup(
        [{ label: "End face", nodeIds: endNodes.map((n) => n.id) }],
        0,
        0,
        "moment",
        [500, 0, 1000],
      );

    const loads = store.getState().loads;
    const cx = endNodes.reduce((s, n) => s + n.x, 0) / endNodes.length;
    const cy = endNodes.reduce((s, n) => s + n.y, 0) / endNodes.length;
    const cz = endNodes.reduce((s, n) => s + n.z, 0) / endNodes.length;

    const nodeById = new Map(endNodes.map((n) => [n.id, n]));
    let netFx = 0,
      netFy = 0,
      netFz = 0,
      netMx = 0,
      netMz = 0;
    for (const l of loads) {
      const n = nodeById.get(l.nodeId)!;
      const rx = n.x - cx,
        ry = n.y - cy,
        rz = n.z - cz;
      if (l.dof === 0) {
        netFx += l.value;
        netMz -= ry * l.value;
      }
      if (l.dof === 1) {
        netFy += l.value;
        netMx -= rz * l.value;
        netMz += rx * l.value;
      }
      if (l.dof === 2) {
        netFz += l.value;
        netMx += ry * l.value;
      }
    }
    return { netFx, netFy, netFz, netMx, netMz, loads };
  });

  // Every resulting load is a force DOF (the moment is lumped to nodal forces).
  expect(result.loads.every((l) => l.dof <= 2)).toBe(true);
  // Pure couples: no net force in any direction.
  expect(result.netFx).toBeCloseTo(0, 9);
  expect(result.netFy).toBeCloseTo(0, 9);
  expect(result.netFz).toBeCloseTo(0, 9);
  // Net moment matches the applied vector on each axis.
  expect(result.netMx).toBeCloseTo(500, 6);
  expect(result.netMz).toBeCloseTo(1000, 6);
});

// ── Solve integration ─────────────────────────────────────────────────────────

test("solve completes with a componentwise force load", async ({ page }) => {
  await bootstrapCantilever(page);

  const result = (await page.evaluate(async () => {
    const store = (window as unknown as { __kofemStore: Store }).__kofemStore;
    const endNodes = store
      .getState()
      .nodes.filter((n) => Math.abs(n.x - 1.0) < 1e-9);
    store.getState().clearLoads();
    store
      .getState()
      .createLoadGroup(
        [{ label: "End face", nodeIds: endNodes.map((n) => n.id) }],
        0,
        0,
        "force",
        [3000, -10000, 0],
      );

    const s = store.getState() as unknown as {
      nodes: unknown[];
      elements: unknown[];
      materials: unknown[];
      properties: unknown[];
      constraints: unknown[];
      loads: unknown[];
      surfaceLoads: unknown[];
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
      surfaceLoads: s.surfaceLoads,
    });
  })) as { displacements: number[] };

  expect(result.displacements.length).toBeGreaterThan(0);
  expect(result.displacements.every((v) => Number.isFinite(v))).toBe(true);
  // A force with both an x and y component must bend the beam in both: the tip
  // displacement field is non-trivial in both directions.
  let maxUx = 0,
    maxUy = 0;
  for (let i = 0; i < result.displacements.length; i += 3) {
    maxUx = Math.max(maxUx, Math.abs(result.displacements[i]));
    maxUy = Math.max(maxUy, Math.abs(result.displacements[i + 1]));
  }
  expect(maxUx).toBeGreaterThan(0);
  expect(maxUy).toBeGreaterThan(0);
});

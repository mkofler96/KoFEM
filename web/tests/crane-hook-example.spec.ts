// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Loads the crane-hook example — a real multibody assembly (three CAD solids)
// with constraints and loads — through the ?example= deep-link, and verifies
// the multibody analysis restores intact: mesh, per-body properties (issue
// #353), and the saved boundary conditions / loads.

import { test, expect } from "./coverage";

interface CraneHookState {
  modelName: string;
  nodes: number;
  elements: number;
  bodies: number;
  materials: number;
  bcGroups: number;
  loadGroups: number;
  mode: string;
  hasResult: boolean;
}

function readStore(
  page: import("@playwright/test").Page,
): Promise<CraneHookState> {
  return page.evaluate(() => {
    const state = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            modelName: string;
            nodes: unknown[];
            elements: { propertyId: number }[];
            properties: unknown[];
            materials: unknown[];
            bcGroups: unknown[];
            loadGroups: unknown[];
            result: unknown;
            mode: string;
          };
        };
      }
    ).__kofemStore.getState();
    return {
      modelName: state.modelName,
      nodes: state.nodes.length,
      elements: state.elements.length,
      bodies: new Set(state.elements.map((e) => e.propertyId)).size,
      materials: state.materials.length,
      bcGroups: state.bcGroups.length,
      loadGroups: state.loadGroups.length,
      mode: state.mode,
      hasResult: state.result !== null,
    };
  });
}

test("?example=full-crane-hook restores the multibody analysis", async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.goto("/app/?example=full-crane-hook");
  await expect(page.locator("nav")).toBeVisible();

  // The 20 MB example .vtu is fetched, parsed and loaded into the store.
  await expect
    .poll(async () => (await readStore(page)).nodes, { timeout: 60_000 })
    .toBeGreaterThan(0);

  const snap = await readStore(page);

  // Multibody: the hook's three CAD solids each become a body (property) — the
  // core of issue #353, so every tet carries one of three body ids.
  expect(snap.bodies).toBe(3);
  // The full mesh restores (exact counts guard the committed example file).
  expect(snap.nodes).toBe(69709);
  expect(snap.elements).toBe(244821);
  // Per-body materials and the saved constraints / loads all come back.
  expect(snap.materials).toBe(2);
  expect(snap.bcGroups).toBe(1);
  expect(snap.loadGroups).toBe(2);
  // Not pre-solved — the example ships as a ready-to-solve setup.
  expect(snap.hasResult).toBe(false);
});

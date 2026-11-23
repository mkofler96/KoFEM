// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A renamed load is quoted by its new name: each surface load the solve
// receives carries its group's name into refusals (KOF-462). A name is not
// physics, so the rename keeps the result.

import { beforeEach, describe, expect, test } from "bun:test";

// The store reads the sidebar width from localStorage and the theme from
// matchMedia when it is created; bun has neither.
const memory = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => {
      memory.set(k, v);
    },
    removeItem: (k: string) => {
      memory.delete(k);
    },
  },
  window: Object.assign(globalThis, {
    matchMedia: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  }),
});

const { useModelStore } = await import("../../src/store/modelStore");

const nodes = [
  { id: 1, x: 0, y: 0, z: 0 },
  { id: 2, x: 1, y: 0, z: 0 },
  { id: 3, x: 0, y: 1, z: 0 },
  { id: 4, x: 0, y: 0, z: 1 },
];
const elements = [
  { id: 1, type: "CTETRA" as const, nodeIds: [1, 2, 3, 4], propertyId: 1 },
];
const sizes = { max: 1, min: 0.1, regions: {} };

describe("renaming a load group (KOF-462)", () => {
  beforeEach(() => {
    const state = useModelStore.getState();
    state.reset();
    state.setBodies(1);
    state.applyMeshResult(nodes, elements, "STEP Volume Mesh", sizes);
    state.createLoadGroup(
      [{ label: "Face 1", nodeIds: [1, 2, 3], geometry: "face" }],
      0,
      0.1,
      "pressure",
    );
  });

  test("the surface load the solve receives takes the new name", () => {
    const { loadGroups } = useModelStore.getState();
    useModelStore.getState().renameLoadGroup(loadGroups[0].id, "Top plate");
    expect(useModelStore.getState().surfaceLoads.map((l) => l.name)).toEqual([
      "Top plate",
    ]);
  });

  test("the result stands", () => {
    const result = { displacements: new Float64Array(12) };
    useModelStore.getState().setResult(result);
    const { loadGroups } = useModelStore.getState();
    useModelStore.getState().renameLoadGroup(loadGroups[0].id, "Top plate");
    expect(useModelStore.getState().result).toBe(result);
  });
});

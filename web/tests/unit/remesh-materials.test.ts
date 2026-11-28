// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A mesh can hold bodies the body table does not know: Netgen split a domain
// of an imported part. Such a body gets no material behind the user's back
// (KOF-413): the remesh notice names it, the body is marked as needing a
// material, and the solve waits until the user has chosen one. A model built
// without a CAD import has nobody to ask, and keeps its default.

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
      // The theme never changes in a test, so nobody needs to hear of it.
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  }),
});

const { useModelStore } = await import("../../src/store/modelStore");
const { unconfirmedMaterialBodies, unconfirmedMaterialMessage } =
  await import("../../src/store/geometrySlice");

const nodes = [
  { id: 1, x: 0, y: 0, z: 0 },
  { id: 2, x: 1, y: 0, z: 0 },
  { id: 3, x: 0, y: 1, z: 0 },
  { id: 4, x: 0, y: 0, z: 1 },
  { id: 5, x: 1, y: 1, z: 1 },
];

// Two tetrahedra: one on body 1, one on body 2.
const elements = [
  { id: 1, type: "CTETRA" as const, nodeIds: [1, 2, 3, 4], propertyId: 1 },
  { id: 2, type: "CTETRA" as const, nodeIds: [2, 3, 4, 5], propertyId: 2 },
];

const sizes = { max: 1, min: 0.1, regions: {}, faces: {} };

function mesh() {
  useModelStore
    .getState()
    .applyMeshResult(nodes, elements, "STEP Volume Mesh", sizes);
}

const aluminium = {
  id: 2,
  name: "Aluminium",
  young: 70000,
  poisson: 0.33,
  density: 2.7e-9,
};

describe("bodies a mesh adds to an imported part (KOF-413)", () => {
  beforeEach(() => {
    const state = useModelStore.getState();
    state.reset();
    state.setStepBytes(new Uint8Array([1, 2, 3]), []);
    state.setBodies(1);
    state.addMaterial(aluminium);
    state.assignBodyMaterial(1, aluminium.id);
  });

  test("the remesh notice names the new body and asks for its material", () => {
    mesh();
    expect(useModelStore.getState().remeshNotice).toMatch(
      /body 2 .*choose its material/i,
    );
  });

  test("the new body is marked as needing a material", () => {
    mesh();
    const { properties } = useModelStore.getState();
    expect(unconfirmedMaterialBodies(properties)).toEqual([2]);
    // The body that was there keeps its own material, unmarked.
    const body1 = properties.find((p) => p.id === 1);
    expect(body1?.materialId).toBe(aluminium.id);
    expect(body1?.materialUnconfirmed).toBeUndefined();
  });

  test("the solve check refuses until the material is chosen", () => {
    mesh();
    const message = unconfirmedMaterialMessage(
      unconfirmedMaterialBodies(useModelStore.getState().properties),
    );
    expect(message).toMatch(/body 2/i);
  });

  test("choosing a material confirms it", () => {
    mesh();
    useModelStore.getState().assignBodyMaterial(2, aluminium.id);
    const { properties } = useModelStore.getState();
    expect(unconfirmedMaterialBodies(properties)).toEqual([]);
    expect(unconfirmedMaterialMessage([])).toBeNull();
  });

  test("keeping the offered material confirms it too", () => {
    mesh();
    const offered = useModelStore
      .getState()
      .properties.find((p) => p.id === 2)?.materialId;
    useModelStore.getState().confirmBodyMaterial(2);
    const prop = useModelStore.getState().properties.find((p) => p.id === 2);
    expect(prop?.materialId).toBe(offered);
    expect(prop?.materialUnconfirmed).toBeUndefined();
  });

  test("confirming a body that does not exist is an error", () => {
    expect(() => useModelStore.getState().confirmBodyMaterial(9)).toThrow(
      /body 9 does not exist/,
    );
  });

  test("a mesh whose bodies all match says nothing about materials", () => {
    useModelStore.getState().setBodies(2);
    mesh();
    const state = useModelStore.getState();
    expect(unconfirmedMaterialBodies(state.properties)).toEqual([]);
    expect(state.remeshNotice).toBeNull();
  });
});

describe("a model built without a CAD import (KOF-413)", () => {
  beforeEach(() => {
    useModelStore.getState().reset();
  });

  test("its unknown bodies get the first material, with nothing to confirm", () => {
    mesh();
    const state = useModelStore.getState();
    const body2 = state.properties.find((p) => p.id === 2);
    expect(body2?.materialId).toBe(state.materials[0].id);
    expect(unconfirmedMaterialBodies(state.properties)).toEqual([]);
    expect(state.remeshNotice).toBeNull();
  });
});

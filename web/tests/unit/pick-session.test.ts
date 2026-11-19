// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A face-pick session belongs to the Supports & Loads step (KOF-407). Its
// clicks are matched against the undeformed mesh, so a session left running on
// Results would compare a click on the deformed surface with undeformed node
// positions and select a different rim or node than the one clicked. Leaving
// the step therefore ends the session, however the step is left.

import { beforeEach, describe, expect, test } from "bun:test";

// The store reads the sidebar width from localStorage and the theme from
// matchMedia when it is created; bun has neither.
const memory = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
  },
  window: Object.assign(globalThis, {
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  }),
});

const { useModelStore } = await import("../../src/store/modelStore");
const { addSelection } = await import("../../src/store/viewSlice");

const face = {
  nodeIds: [1, 2],
  axis: "X" as const,
  isMax: true,
  label: "Edge (2 nodes)",
};

function startEdgePick() {
  const state = useModelStore.getState();
  state.selectTreeNode(addSelection("boundary"));
  state.setPickMode("bc");
  state.setPickGeometry("edge");
  state.setSelectedFace(face);
  state.setPendingFaces([face]);
}

describe("pick session (KOF-407)", () => {
  beforeEach(() => {
    useModelStore.getState().setPickMode(null);
  });

  test("opening Results in the tree ends the pick session", () => {
    startEdgePick();
    useModelStore.getState().selectTreeNode(addSelection("results"));
    const state = useModelStore.getState();
    expect(state.mode).toBe("results");
    expect(state.pickMode).toBeNull();
    expect(state.pickGeometry).toBe("face");
    expect(state.selectedFace).toBeNull();
    expect(state.pendingFaces).toEqual([]);
  });

  test("a mode change to Results (a finished solve) ends the pick session", () => {
    startEdgePick();
    useModelStore.getState().setMode("results");
    const state = useModelStore.getState();
    expect(state.mode).toBe("results");
    expect(state.pickMode).toBeNull();
  });

  test("moving within Supports & Loads keeps the pick session", () => {
    startEdgePick();
    useModelStore.getState().selectTreeNode(addSelection("boundary"));
    const state = useModelStore.getState();
    expect(state.pickMode).toBe("bc");
    expect(state.pickGeometry).toBe("edge");
    expect(state.selectedFace).toEqual(face);
  });
});

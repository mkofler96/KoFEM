// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-459: the reactions output belongs to the static solve. Selecting it
// shows the static result, also when an optimization's density was on view.

import { beforeEach, expect, test } from "bun:test";

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
const { itemSelection, REACTIONS_ITEM_ID } =
  await import("../../src/store/viewSlice");

beforeEach(() => {
  useModelStore.setState({
    result: { displacements: new Float64Array(3), reactions: null },
    densityResult: {
      density: new Float64Array([0.5]),
      history: [],
      converged: true,
      iterations: 1,
    },
    activeResult: "density",
    showReactions: false,
    reactionsShown: false,
  });
});

test("adding the reactions output puts the static result on view", () => {
  useModelStore.getState().addReactions();
  const state = useModelStore.getState();
  expect(state.reactionsShown).toBe(true);
  expect(state.activeResult).toBe("static");
});

test("reopening the reactions row after the density puts the static result back", () => {
  useModelStore.getState().addReactions();
  useModelStore.setState({ activeResult: "density" });
  useModelStore
    .getState()
    .selectTreeNode(itemSelection("results", "reactions", REACTIONS_ITEM_ID));
  expect(useModelStore.getState().activeResult).toBe("static");
});

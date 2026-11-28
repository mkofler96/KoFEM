// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-412: a topology optimization that stops at its iteration limit is not a
// finished design. The run's result says whether it converged and how many
// iterations it took; Results and the Optimize panel say so, and offer to run
// again with a higher limit.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  notConvergedNotice,
  raisedIterationLimit,
} from "../../src/lib/topOptConvergence";

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
const { topOptChartVisible } = await import("../../src/store/topOptSlice");

const run = (converged: boolean, iterations: number) => ({
  density: new Float64Array([0.2, 0.9]),
  history: [],
  converged,
  iterations,
});

describe("the not-converged notice", () => {
  test("a converged run has none", () => {
    expect(notConvergedNotice(run(true, 12))).toBeNull();
  });

  test("a run stopped at its limit says it did not converge, and at which limit", () => {
    const notice = notConvergedNotice(run(false, 10));
    expect(notice).toContain("Not converged");
    expect(notice).toContain("10 iterations");
  });

  test("the rerun doubles the limit", () => {
    expect(raisedIterationLimit(10)).toBe(20);
    expect(raisedIterationLimit(50)).toBe(100);
  });
});

describe("the density result in the store", () => {
  beforeEach(() => {
    useModelStore.getState().setDensityResult(null);
    useModelStore.getState().setTopOptSetting("maxIterations", "10");
    useModelStore.getState().clearTopOptRunRequest();
  });

  test("keeps whether the run converged and its iteration count", () => {
    useModelStore.getState().setDensityResult(run(false, 10));
    const result = useModelStore.getState().densityResult;
    expect(result?.converged).toBe(false);
    expect(result?.iterations).toBe(10);
  });

  test("a rerun of a capped run raises the limit and asks for a run", () => {
    useModelStore.getState().setDensityResult(run(false, 10));
    useModelStore.getState().rerunTopOptWithMoreIterations();
    const state = useModelStore.getState();
    expect(state.topOpt.maxIterations).toBe("20");
    // The old design was computed with the old limit: it is stale now.
    expect(state.densityResult).toBeNull();
    expect(state.topOptRunRequested).toBe(true);
    state.clearTopOptRunRequest();
    expect(useModelStore.getState().topOptRunRequested).toBe(false);
  });

  test("a converged run has nothing to rerun", () => {
    useModelStore.getState().setDensityResult(run(true, 7));
    expect(() =>
      useModelStore.getState().rerunTopOptWithMoreIterations(),
    ).toThrow("converged");
  });
});

// The run hands off to Results at once, like the mesh refinement study: the
// right panel switches between the density in 3D (live while the run goes)
// and the convergence chart, which the centre draws in place of the 3D view.
describe("the optimization's result view", () => {
  beforeEach(() => {
    const state = useModelStore.getState();
    state.setDensityResult(null);
    state.setOptimizing(false);
    state.setTopOptError(null);
  });

  test("opening it shows Results → Density, in 3D", () => {
    useModelStore.getState().showTopOptResult();
    const state = useModelStore.getState();
    expect(state.mode).toBe("results");
    expect(state.activeResult).toBe("density");
    const plot = state.resultPlots.find((p) => p.source === "density");
    expect(plot).toBeDefined();
    expect(state.treeSelection.target).toEqual({
      type: "item",
      kind: "plot",
      id: plot?.id,
    });
    expect(state.topOptView).toBe("density");
    expect(topOptChartVisible(state)).toBe(false);
  });

  test("the chart fills the centre while the run goes and after it", () => {
    const store = useModelStore.getState();
    store.showTopOptResult();
    store.setTopOptView("chart");
    // Nothing to chart before a run.
    expect(topOptChartVisible(useModelStore.getState())).toBe(false);
    store.setOptimizing(true);
    expect(topOptChartVisible(useModelStore.getState())).toBe(true);
    store.setOptimizing(false);
    store.setDensityResult(run(true, 4));
    expect(topOptChartVisible(useModelStore.getState())).toBe(true);
    store.setTopOptView("density");
    expect(topOptChartVisible(useModelStore.getState())).toBe(false);
  });

  test("the chart is the density plot's: another step or plot hides it", () => {
    const store = useModelStore.getState();
    store.showTopOptResult();
    store.setTopOptView("chart");
    store.setDensityResult(run(true, 4));
    store.setMode("optimize");
    expect(topOptChartVisible(useModelStore.getState())).toBe(false);
  });

  test("a failed run keeps its error for Results to show", () => {
    const notice = { advice: null, detail: "Optimization error: boom" };
    useModelStore.getState().setTopOptError(notice);
    expect(useModelStore.getState().topOptError).toEqual(notice);
  });
});

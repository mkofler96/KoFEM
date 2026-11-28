// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The analysis report's numbers through the Rust module, as the report calls
// it (KOF-391): reportStats(displacements, nodal von Mises) → [max |u|, its
// node, max von Mises, 99th percentile]. The numerics are covered in
// crates/kofem-fem/tests/report_stats.rs.

import { beforeAll, expect, test } from "bun:test";
import { loadFem } from "../support/wasm.mjs";

let fem = null;
beforeAll(async () => {
  fem = await loadFem();
});

test("reportStats reads the peaks and the 99th percentile", () => {
  const displacements = Float64Array.from([1, 0, 0, 3, -4, 0, 0, 0, 2]);
  const vonMises = Float64Array.from({ length: 101 }, (_, i) => i);
  const [maxU, node, maxVm, p99] = fem.reportStats(displacements, vonMises);
  expect(maxU).toBe(5);
  expect(node).toBe(1);
  expect(maxVm).toBe(100);
  expect(p99).toBeCloseTo(99, 12);
});

test("reportStats refuses a field that is not three values per node", () => {
  expect(() =>
    fem.reportStats(Float64Array.from([1, 2]), Float64Array.from([1])),
  ).toThrow(/not three per node/);
});

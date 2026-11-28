// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The meshing benchmark's measurements (KOF-456), on a small part: the time
// of each Netgen stage, read from the lines the engine logs as it starts
// each one, and the shape quality of the tetrahedra from the Rust module.
// The quality numerics are covered in crates/kofem-fem/tests/tet_quality.rs.

import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { meshTimed, qualitySummary, STAGES } from "../bench_meshing.mjs";
import { loadFem } from "../support/wasm.mjs";

let fem;
beforeAll(async () => {
  fem = await loadFem();
});

const step = readFileSync(
  join(import.meta.dir, "../../../test_files/two_boxes.stp"),
);

test("each Netgen stage is timed and the stages fit in the meshing time", async () => {
  const run = await meshTimed(step, { max_element_size: 5 });
  expect(Object.keys(run.stages)).toEqual(STAGES);
  for (const name of STAGES) expect(run.stages[name]).toBeGreaterThanOrEqual(0);
  const staged = STAGES.reduce((sum, name) => sum + run.stages[name], 0);
  expect(staged).toBeLessThanOrEqual(run.seconds);
  expect(run.tetrahedra.length % 4).toBe(0);
  expect(run.tetrahedra.length).toBeGreaterThan(0);
});

test("the quality of a Netgen mesh lies between a sliver and a regular tetrahedron", async () => {
  const run = await meshTimed(step, { max_element_size: 5 });
  const summary = qualitySummary(fem, run.vertices, run.tetrahedra);
  expect(summary.tets).toBe(run.tetrahedra.length / 4);
  expect(summary.minDihedralDeg).toBeGreaterThan(0);
  expect(summary.minDihedralDeg).toBeLessThanOrEqual(summary.p01DihedralDeg);
  expect(summary.p01DihedralDeg).toBeLessThanOrEqual(70.53);
  expect(summary.meanAspectRatio).toBeGreaterThanOrEqual(1);
  expect(summary.maxAspectRatio).toBeGreaterThanOrEqual(
    summary.meanAspectRatio,
  );
});

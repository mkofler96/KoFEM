// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The MBB beam example (/examples/mbb-beam-topopt/) publishes the run the app
// makes (KOF-360): its generator optimizes through the app's own optimizer
// (optimizeSolidInRust, the worker's path), the recipe's settings let that run
// meet its tolerance well inside the iteration cap, and the published record
// is that run.

import { beforeAll, describe, expect, test } from "bun:test";
import recipes from "../../../examples/gallery/recipes/index.mjs";
import { showcaseRecord } from "../../../examples/validation/catalog.mjs";
import { buildFromRecipe } from "../../../examples/validation/lib/pipeline.mjs";
import { optimizeSolidInRust } from "../../src/lib/solve/topOptRust.ts";
import { loadFem } from "../support/wasm.mjs";

const ID = "mbb-beam-topopt";

let fem = null;
let build = null;
beforeAll(async () => {
  fem = await loadFem();
  build = await buildFromRecipe(ID, recipes[ID]);
});

describe("the MBB beam example", () => {
  test("is optimized by the app's optimizer", () => {
    // The Rust optimizer is deterministic, so its first steps on the built
    // model are the build's own, to the last bit. Another optimizer's differ
    // by round-off from the first solve on.
    const STEPS = 5;
    const { settings, history } = build.optimization;
    const app = optimizeSolidInRust(
      fem,
      {
        ...build.solvePayload,
        settings: { ...settings, maxIterations: STEPS },
      },
      () => {},
      () => {},
    );
    expect(history.slice(0, STEPS)).toEqual(app.history);
  });

  test("meets its tolerance with room to spare under the iteration cap", () => {
    // The design does not come to rest: it meets the tolerance in the quiet
    // stretch of a cycle about 20 iterations long, and which cycle's stretch
    // is the first one deep enough changes with round-off and the mesh. A run
    // that stops close to the cap converged only because that stretch
    // happened to come in time; this one must leave a third of its cap,
    // several cycles, unused.
    const { settings, history } = build.optimization;
    expect(history.at(-1).max_change).toBeLessThan(settings.tolerance);
    expect(history.length).toBeLessThanOrEqual(
      (2 / 3) * settings.maxIterations,
    );
  });

  test("publishes this run", () => {
    const record = showcaseRecord(ID);
    const { history } = build.optimization;
    expect(record.history).toHaveLength(history.length);
    expect(Math.abs(record.fe - build.fe)).toBeLessThanOrEqual(
      1e-9 * Math.abs(build.fe),
    );
    // The record names the build of the Rust module that optimized it, which
    // the page's solver line cites.
    expect(record.fem).toMatch(/^fem-[0-9a-f]{12}$/);
  });
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A STEP file that holds only a tessellated mesh (AP242
// COMPLEX_TRIANGULATED_FACE, no BRep solid or face) has nothing to mesh. The
// engine must refuse it with a readable error instead of crashing (KOF-361).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadEngine } from "../support/wasm.mjs";

const stepFile = (name) =>
  new Uint8Array(
    readFileSync(new URL(`../../../test_files/${name}`, import.meta.url)),
  );
const options = JSON.stringify({
  deflection_relative: 0.001,
  angular_deflection: 0.5,
  format: "step",
});

describe("tessellate_step", () => {
  test("refuses a STEP that holds only a tessellated mesh", async () => {
    const engine = await loadEngine();
    let caught = null;
    let thrown = false;
    try {
      engine.tessellate_step(stepFile("tessellated_only_tetra.step"), options);
    } catch (error) {
      thrown = true;
      caught = error;
    }
    expect(thrown).toBe(true);
    expect(typeof caught, "expected a C++ runtime_error, not a crash").toBe(
      "number",
    );
    const [type, message] = engine.getExceptionMessage(caught);
    expect(type).toMatch(/runtime_error/);
    expect(message).toMatch(/only a tessellated mesh/);
    expect(message).toMatch(/BRep/);
  });

  test("still loads a STEP with BRep geometry", async () => {
    const engine = await loadEngine();
    const { triangles, bodyCount } = engine.tessellate_step(
      stepFile("I_beam.step"),
      options,
    );
    expect(bodyCount).toBe(1);
    expect(triangles.length).toBeGreaterThan(0);
  });
});

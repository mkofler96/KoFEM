// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Memory the engine holds after a mesh succeeds (KOF-431). Netgen allocates
// its local mesh-size tree from a pool that grows with mesh fineness and used
// to keep every block for the life of the worker.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { loadEngine } from "../support/wasm.mjs";

const SAMPLE = fileURLToPath(
  new URL("../../public/samples/wall-bracket.step", import.meta.url),
);

function meshOptions(maxElementSize) {
  return JSON.stringify({
    max_element_size: maxElementSize,
    min_element_size: maxElementSize / 10,
    grading: 0.3,
    second_order: false,
    elementsperedge: 2.0,
    elementspercurve: 2.0,
    optsteps_2d: 0,
    optsteps_3d: 0,
  });
}

// Megabytes malloc holds at each [mem] line with this label, in log order.
function allocatedAt(lines, label) {
  return lines
    .filter((l) => l.startsWith("[mem]") && l.includes(label))
    .map((l) => Number(/alloc~(-?\d+) MB/.exec(l)[1]));
}

// At 2 mm the bracket's local mesh-size tree takes about 14 MB. Each mesh
// logs malloc's in-use bytes before it builds the Netgen geometry, so the
// second mesh's line shows what the first one left behind.
test("a mesh that succeeds gives its memory back", async () => {
  const lines = [];
  const engine = await loadEngine({ print: (line) => lines.push(line) });
  engine.tessellate_step(
    new Uint8Array(readFileSync(SAMPLE)),
    JSON.stringify({ deflection_relative: 0.001, angular_deflection: 0.5 }),
  );

  const fine = engine.generate_fem_mesh(meshOptions(2));
  expect(fine.tetrahedra.length).toBeGreaterThan(0);
  const coarse = engine.generate_fem_mesh(meshOptions(20));
  expect(coarse.tetrahedra.length).toBeGreaterThan(0);

  const [beforeFine, afterFine] = allocatedAt(
    lines,
    "generate_fem_mesh: before OCC geometry build",
  );
  expect(afterFine - beforeFine).toBeLessThanOrEqual(1);
});

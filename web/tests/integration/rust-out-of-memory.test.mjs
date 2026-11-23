// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A Rust solve that runs out of memory (KOF-454). The module's WebAssembly
// memory is filled to just below its 4 GB limit from outside, standing in for
// a mesh too fine for the browser, so the next allocation in Rust fails. The
// trap must reach the user as "ran out of memory", not as the error the
// model's free() throws after it.
//
// The test loads its own instance of the module: the filled memory stays
// filled, and the other test files share loadFem()'s instance.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "bun:test";
import { boxHexMesh } from "../../../examples/validation/lib/mesh.mjs";
import { solveSolidInRust } from "../../src/lib/solve/amg.ts";
import { explainRustFailure } from "../../src/lib/solve/rustFailure.ts";
import { buildVertexIndexer } from "../../src/lib/solveMeshPacking.ts";

const PAGE = 64 * 1024;
// wasm32: 65536 pages of 64 KiB.
const MAX_PAGES = 65536;
// What is left free: far less than the solve's stiffness matrix.
const HEADROOM_PAGES = 16;

let fem;
let memory;

beforeAll(async () => {
  const bytes = readFileSync(
    fileURLToPath(
      new URL("../../src/wasm/fem/kofem_wasm_bg.wasm", import.meta.url),
    ),
  );
  fem = await import("../../src/wasm/fem/kofem_wasm.js?instance=out-of-memory");
  memory = (await fem.default({ module_or_path: bytes })).memory;
});

// A 20 × 4 × 4 block of quadratic hexahedra, clamped at x = 0.
function block() {
  const box = boxHexMesh(200, 40, 40, 20, 4, 4);
  const nodes = box.vertices.map(([x, y, z], index) => ({
    id: index + 1,
    x,
    y,
    z,
  }));
  const elements = box.hexahedra.map((corners, index) => ({
    id: index + 1,
    type: "CHEXA",
    nodeIds: corners.map((corner) => corner + 1),
    propertyId: 1,
  }));
  const clamped = nodes.filter((node) => node.x === 0).map((node) => node.id);
  return {
    nodes,
    elements,
    materials: [
      { id: 1, name: "Steel", young: 210000, poisson: 0.3, density: 7850 },
    ],
    properties: [{ id: 1, materialId: 1 }],
    constraints: clamped.flatMap((nodeId) =>
      [1, 2, 3].map((dof) => ({ nodeId, dof })),
    ),
    loads: [],
  };
}

describe("a Rust solve that runs out of memory", () => {
  test("reports that it ran out of memory", async () => {
    const model = block();
    const vid = buildVertexIndexer(model.nodes);
    memory.grow(MAX_PAGES - memory.buffer.byteLength / PAGE - HEADROOM_PAGES);

    let failure;
    try {
      await solveSolidInRust(
        fem,
        model,
        2,
        "amg",
        vid,
        vid,
        undefined,
        () => Promise.resolve(0),
        () => undefined,
      );
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(WebAssembly.RuntimeError);
    const explained = explainRustFailure(failure, fem.takePanicMessage);
    expect(explained.message).toMatch(/^The solver ran out of memory\./);
  });
});

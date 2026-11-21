// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A mesh that runs out of memory (KOF-425). The engine's WebAssembly memory is
// held at the size it starts with, standing in for a phone or a low-memory
// browser, and the sample bracket is meshed finer than that memory allows.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import { categorizeError } from "../../src/lib/analytics.ts";
import { loadEngine } from "../support/wasm.mjs";

const SAMPLE = fileURLToPath(
  new URL("../../public/samples/wall-bracket.step", import.meta.url),
);
const MB = 1 << 20;
const PAGE = 64 * 1024;

// Replaces WebAssembly.Memory.prototype.grow for one memory; the original is
// restored after each test.
const nativeGrow = WebAssembly.Memory.prototype.grow;
function onGrow(memory, grow) {
  WebAssembly.Memory.prototype.grow = function (delta) {
    return this === memory
      ? grow.call(this, delta)
      : nativeGrow.call(this, delta);
  };
}
afterEach(() => {
  WebAssembly.Memory.prototype.grow = nativeGrow;
});

// The engine with the bracket loaded, its memory, and the lines it printed.
async function engineWithSample() {
  let memory = null;
  const lines = [];
  const engine = await loadEngine({
    onMemory: (instanceMemory) => (memory = instanceMemory),
    print: (line) => lines.push(line),
  });
  engine.tessellate_step(
    new Uint8Array(readFileSync(SAMPLE)),
    JSON.stringify({ deflection_relative: 0.001, angular_deflection: 0.5 }),
  );
  return { engine, memory, lines };
}

// Surface and volume optimisation are off: they make the run slower, not the
// memory it runs out of.
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

// The what() text of the C++ exception generate_fem_mesh throws.
function meshError(engine, maxElementSize) {
  try {
    engine.generate_fem_mesh(meshOptions(maxElementSize));
  } catch (err) {
    if (err instanceof Error) throw err;
    const [type, message] = engine.getExceptionMessage(err);
    return `${type}: ${message}`;
  }
  throw new Error(`meshing at ${maxElementSize} mm did not fail`);
}

// Megabytes malloc holds at a [mem] log line, the latest with this label.
function allocatedAt(lines, label) {
  const line = lines.findLast(
    (l) => l.startsWith("[mem]") && l.includes(label),
  );
  if (!line) throw new Error(`no [mem] line "${label}" was printed`);
  return Number(/alloc~(-?\d+) MB/.exec(line)[1]);
}

function refuseToGrow(memory) {
  onGrow(memory, () => {
    throw new RangeError("WebAssembly.Memory.grow: held at its start size");
  });
}

describe("a mesh that runs out of memory", () => {
  // At 0.805 mm the surface mesh alone outgrows the memory: Netgen throws
  // std::bad_alloc out of generate_fem_mesh.
  // Netgen keeps buffers sized by the finest mesh so far, after a mesh that
  // succeeds as well, so memory held after the first failure is not a leak.
  // A geometry or mesh left allocated is: it adds up with every failure.
  test("frees the geometry and the mesh, so a coarser mesh fits again", async () => {
    const { engine, memory, lines } = await engineWithSample();
    refuseToGrow(memory);
    const coarseMesh = () => {
      const mesh = engine.generate_fem_mesh(meshOptions(20));
      expect(mesh.tetrahedra.length).toBeGreaterThan(0);
      return allocatedAt(lines, "generate_fem_mesh: before OCC geometry build");
    };

    meshError(engine, 0.805);
    const heldAfterOneFailure = coarseMesh();
    meshError(engine, 0.805);
    const heldAfterTwoFailures = coarseMesh();

    expect(heldAfterTwoFailures - heldAfterOneFailure).toBeLessThanOrEqual(1);
  });

  test("is reported as out of memory, with what to change", async () => {
    const { engine, memory } = await engineWithSample();
    refuseToGrow(memory);

    const message = meshError(engine, 0.805);
    expect(message).toMatch(/out of memory/i);
    expect(message).toMatch(/element size/i);
    expect(categorizeError(new Error(message))).toBe("resource_limit");
  });

  // At 1.0 mm the surface mesh fits, the volume fill does not. Netgen catches
  // its own std::bad_alloc there and returns no tetrahedra.
  test("in the volume fill is reported as out of memory, not as a bad CAD file", async () => {
    const { engine, memory } = await engineWithSample();
    refuseToGrow(memory);

    const message = meshError(engine, 1.0);
    expect(message).toMatch(/out of memory/i);
    expect(message).toMatch(/element size/i);
    expect(message).not.toMatch(/0 tetrahedra|free surfaces|watertight/i);
    expect(categorizeError(new Error(message))).toBe("resource_limit");
  });
});

describe("the memory log", () => {
  // The engine's first growth is stretched past 2 GB; the 1.61 mm volume fill
  // is the first step that grows the memory.
  test("prints sizes above 2 GB", async () => {
    const { engine, memory, lines } = await engineWithSample();
    const target = 2560 * MB;
    onGrow(memory, function (delta) {
      const pages = Math.max(delta, (target - this.buffer.byteLength) / PAGE);
      return nativeGrow.call(this, pages);
    });

    engine.generate_fem_mesh(meshOptions(1.61));
    expect(memory.buffer.byteLength).toBeGreaterThanOrEqual(target);

    const line = lines.findLast((l) =>
      l.includes("generate_fem_mesh: after Ng_DeleteMesh"),
    );
    expect(line).toBeDefined();
    const wasmMb = Number(/wasm=(-?\d+) MB/.exec(line)[1]);
    expect(wasmMb).toBe(memory.buffer.byteLength / MB);
  });
});

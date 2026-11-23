// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A call into the Rust module that traps (out of memory, or a panic) leaves
// the object it was called on borrowed, and its free() then throws
// "attempted to take ownership of Rust value while it was borrowed". That
// error must not replace the one that stopped the solve, and the trap must be
// reported as what it was (KOF-454).

import { describe, expect, test } from "bun:test";
import { explainRustFailure, release } from "../../src/lib/solve/rustFailure";
import { solveSolidInRust, type SolidFemModule } from "../../src/lib/solve/amg";
import { buildVertexIndexer } from "../../src/lib/solveMeshPacking";
import type {
  Element,
  Material,
  Node,
  Property,
} from "../../src/workers/solverTypes";

const BORROWED =
  "attempted to take ownership of Rust value while it was borrowed";

// What the browsers say when WebAssembly reaches an `unreachable` instruction.
function unreachableTrap(message: string): Error {
  return new WebAssembly.RuntimeError(message);
}

describe("release", () => {
  test("frees the object", () => {
    let freed = 0;
    release({
      free: () => {
        freed++;
      },
    });
    expect(freed).toBe(1);
  });

  test("leaves a borrowed object to the error that left it borrowed", () => {
    expect(() =>
      release({
        free: () => {
          throw new Error(BORROWED);
        },
      }),
    ).not.toThrow();
  });

  test("any other failure to free is thrown", () => {
    expect(() =>
      release({
        free: () => {
          throw new Error("null pointer passed to rust");
        },
      }),
    ).toThrow("null pointer passed to rust");
  });
});

describe("explainRustFailure", () => {
  const noPanic = () => undefined;

  test.each([
    "unreachable",
    "unreachable executed",
    "Unreachable code should not be executed (evaluating 'wasm.elasticmodel_assemble(this.__wbg_ptr)')",
  ])("a trap without a panic is out of memory (%s)", (message) => {
    const trap = unreachableTrap(message);
    const explained = explainRustFailure(trap, noPanic);
    expect(explained).toBeInstanceOf(Error);
    expect((explained as Error).message).toBe(
      "The solver ran out of memory. Use a coarser mesh, or linear elements instead of quadratic ones, and solve again.",
    );
    expect((explained as Error).cause).toBe(trap);
  });

  test("the browser failing to allocate a result array is out of memory", () => {
    const explained = explainRustFailure(
      new RangeError("Array buffer allocation failed"),
      noPanic,
    );
    expect((explained as Error).message).toMatch(
      /^The solver ran out of memory/,
    );
  });

  test("a trap after a panic is a bug and names the panic", () => {
    const explained = explainRustFailure(
      unreachableTrap("unreachable"),
      () => "index out of bounds: the len is 0 but the index is 3",
    );
    expect((explained as Error).message).toBe(
      "The Rust solver stopped on an internal error (a bug, please report it): index out of bounds: the len is 0 but the index is 3",
    );
  });

  test("an ordinary error from the module is kept unchanged", () => {
    const refusal = new Error("PCG breakdown: p'Ap = 0");
    let asked = false;
    expect(
      explainRustFailure(refusal, () => {
        asked = true;
        return undefined;
      }),
    ).toBe(refusal);
    expect(asked).toBe(false);
  });

  test("other WebAssembly traps are kept unchanged", () => {
    const trap = unreachableTrap("memory access out of bounds");
    expect(explainRustFailure(trap, noPanic)).toBe(trap);
  });
});

// One unit cube of a single linear tetrahedron, fixed at one corner.
const nodes: Node[] = [
  { id: 1, x: 0, y: 0, z: 0 },
  { id: 2, x: 1, y: 0, z: 0 },
  { id: 3, x: 0, y: 1, z: 0 },
  { id: 4, x: 0, y: 0, z: 1 },
];
const elements: Element[] = [
  { id: 1, type: "CTETRA", nodeIds: [1, 2, 3, 4], propertyId: 1 },
];
const materials: Material[] = [
  { id: 1, name: "Steel", young: 210000, poisson: 0.3, density: 7850 },
];
const properties: Property[] = [{ id: 1, materialId: 1 }];

// A Rust module whose model traps in assemble() and then, still borrowed,
// refuses to be freed — what wasm-bindgen does after an out-of-memory trap.
// The solve stops at assemble(), so the module needs no other class.
function trappingModule(trap: Error): SolidFemModule {
  class ElasticModel {
    readonly vertexCount = nodes.length;
    readonly assemble = (): number => {
      throw trap;
    };
    readonly free = (): void => {
      throw new Error(BORROWED);
    };
  }
  return { ElasticModel } as unknown as SolidFemModule;
}

describe("a solid solve that traps", () => {
  test("reports the trap, not the failed free", async () => {
    const trap = unreachableTrap("unreachable");
    const vid = buildVertexIndexer(nodes);
    const solve = solveSolidInRust(
      trappingModule(trap),
      { nodes, elements, materials, properties, constraints: [], loads: [] },
      1,
      "amg",
      vid,
      vid,
      undefined,
      () => Promise.resolve(0),
      () => undefined,
    );
    await expect(solve).rejects.toBe(trap);
  });
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A temperature change on a solid model (KOF-449), through the app's solid
// solve (solveSolidInRust) and the Rust module: the formula is evaluated at
// every node, the thermal load added to the forces, and the stress recovered
// with the thermal strain removed.
//
//   - a block held only against rigid motion expands freely under a uniform
//     ΔT: u = α·ΔT·x and no stress;
//   - a block with every face held normally carries σ = −E·α·ΔT/(1 − 2ν);
//   - a material without an expansion coefficient, or a formula that does not
//     parse, is refused with a message naming it.

import { beforeAll, describe, expect, test } from "bun:test";
import { buildVertexIndexer } from "../../src/lib/solveMeshPacking.ts";
import { solveSolidInRust } from "../../src/lib/solve/amg.ts";
import { boxHexMesh } from "../../../examples/validation/lib/mesh.mjs";
import { loadFem } from "../support/wasm.mjs";

const YOUNG = 210000;
const NU = 0.3;
const ALPHA = 1.2e-5;
const [L, W, H] = [40, 20, 10];

function blockModel(expansion, formula) {
  const mesh = boxHexMesh(L, W, H, 4, 2, 2);
  const nodes = mesh.vertices.map(([x, y, z], i) => ({ id: i + 1, x, y, z }));
  const elements = mesh.hexahedra.map((hex, i) => ({
    id: i + 1,
    type: "CHEXA",
    nodeIds: hex.map((v) => v + 1),
    propertyId: 1,
  }));
  return {
    nodes,
    elements,
    materials: [
      {
        id: 1,
        name: "Steel",
        young: YOUNG,
        poisson: NU,
        density: 7.85e-9,
        ...(expansion === undefined ? {} : { expansion }),
      },
    ],
    properties: [{ id: 1, materialId: 1, discretization: "solid" }],
    constraints: [],
    loads: [],
    temperature: { formula },
  };
}

const at = (model, [x, y, z]) =>
  model.nodes.find((n) => n.x === x && n.y === y && n.z === z).id;

// Rigid motion held at three corners, nothing else.
function threeTwoOne(model) {
  const origin = at(model, [0, 0, 0]);
  const alongX = at(model, [L, 0, 0]);
  const alongY = at(model, [0, W, 0]);
  return [
    ...[0, 1, 2].map((dof) => ({ nodeId: origin, dof })),
    { nodeId: alongX, dof: 1 },
    { nodeId: alongX, dof: 2 },
    { nodeId: alongY, dof: 2 },
  ];
}

// Every face held against motion along its normal.
function normalSupports(model) {
  const out = [];
  for (const n of model.nodes) {
    const point = [n.x, n.y, n.z];
    [L, W, H].forEach((size, axis) => {
      if (point[axis] === 0 || point[axis] === size)
        out.push({ nodeId: n.id, dof: axis });
    });
  }
  return out;
}

const solve = (fem, model) => {
  const vid = buildVertexIndexer(model.nodes);
  return solveSolidInRust(
    fem,
    model,
    1,
    "amg",
    vid,
    vid,
    undefined,
    () => {
      throw new Error("iteration limit");
    },
    () => {},
  );
};

let fem = null;
beforeAll(async () => {
  fem = await loadFem();
});

describe("a temperature change on a solid", () => {
  test("a free block expands by α·ΔT without stress", async () => {
    const model = blockModel(ALPHA, "80");
    const result = await solve(fem, {
      ...model,
      constraints: threeTwoOne(model),
    });
    const strain = ALPHA * 80;
    model.nodes.forEach((n, i) => {
      [n.x, n.y, n.z].forEach((x, axis) =>
        expect(
          Math.abs(result.displacements[3 * i + axis] - strain * x),
        ).toBeLessThan(1e-9 * strain * L),
      );
    });
    const restrained = (YOUNG * strain) / (1 - 2 * NU);
    for (const v of result.stress.top)
      expect(Math.abs(v)).toBeLessThan(1e-6 * restrained);
  });

  test("a block held on every face carries −E·α·ΔT/(1 − 2ν)", async () => {
    const model = blockModel(ALPHA, "60");
    const result = await solve(fem, {
      ...model,
      constraints: normalSupports(model),
    });
    const expected = (-YOUNG * ALPHA * 60) / (1 - 2 * NU);
    const tensors = result.stress.middle;
    for (let c = 0; c < tensors.length / 6; c++)
      for (let k = 0; k < 6; k++)
        expect(
          Math.abs(tensors[6 * c + k] - (k < 3 ? expected : 0)),
        ).toBeLessThan(1e-8 * Math.abs(expected));
  });

  test("a material without an expansion coefficient is refused", async () => {
    const model = blockModel(undefined, "60");
    await expect(
      solve(fem, { ...model, constraints: threeTwoOne(model) }),
    ).rejects.toThrow(/Steel.*thermal expansion coefficient/);
  });

  test("a formula that does not parse is refused", async () => {
    const model = blockModel(ALPHA, "2 * (x + ");
    await expect(
      solve(fem, { ...model, constraints: threeTwoOne(model) }),
    ).rejects.toThrow(/temperature change/i);
  });
});

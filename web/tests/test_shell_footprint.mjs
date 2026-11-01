// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import {
  buildExplicitCoupledModel,
  couplingMpcCodes,
  dropCouplingsOnFixedNodes,
} from "../src/lib/shellize.ts";

// A non-conforming solid section: the middle row has no coincident shell node.
const vertices = [
  0, -1, 6, 0, 1, 6, 2, -1, 6, 2, 1, 6, 1, -1, 6, 1, 1, 6, 0, 0, 6, 2, 0, 6, 0,
  0, 9, 2, 0, 9, 0, -1, 3,
];
const tets = [0, 1, 4, 10, 1, 4, 5, 10, 4, 5, 2, 10, 5, 2, 3, 10];
const tris = [6, 7, 9, 6, 9, 8];
const model = buildExplicitCoupledModel(vertices, tets, tris, [2, 2]);
const codes = couplingMpcCodes(model.coupling);
assert.ok(
  codes.includes(3),
  "physical shell footprint must interpolate shell-edge kinematics, not average a solid search ball",
);
const middle = model.poolOfVertex.get(4);
const row = model.coupling.ref.indexOf(middle);
assert.ok(row >= 0, "every solid footprint node must be coupled");
assert.deepEqual(
  model.coupling.weights.slice(
    model.coupling.offsets[row],
    model.coupling.offsets[row + 1],
  ),
  [0.5, 0.5],
);
assert.throws(
  () => dropCouplingsOnFixedNodes(model.coupling, [6 * middle]),
  /transition.*prescribed|prescribed.*transition/i,
);
console.log("physical shell footprint interpolation passed");

const { shellJunction, tetVolume } =
  await import("./fixtures/shell-junction.mjs");
const { extractThinWallShells, buildShellTransitionModel } =
  await import("../src/lib/shellize.ts");
// The 6 mm transition cuts through existing tets and surface facets (4 mm rows).
for (const wallStep of [3, 4]) {
  const original = shellJunction(1, wallStep);
  const shells = extractThinWallShells(original, {
    shellBodyIds: new Set([1]),
  });
  assert.equal(shells.shellBody, 1);
  const { mesh: clipped, model: mixed } = buildShellTransitionModel(
    original,
    shells,
  );
  const retainedVolume = clipped.body.reduce(
    (sum, body, index) =>
      sum +
      (body === 1
        ? tetVolume(clipped.V, clipped.tet.slice(4 * index, 4 * index + 4))
        : 0),
    0,
  );
  assert.ok(
    Math.abs(retainedVolume - 60 * 2 * 6) < 1e-6,
    `retain exactly the physical 6 mm solid section, got ${retainedVolume}`,
  );
  assert.ok(
    shells.shellVerts.every(
      (value, index) => index % 3 !== 2 || value >= 12 - 1e-7,
    ),
  );
  assert.ok(couplingMpcCodes(mixed.coupling).includes(3));
  const faceCounts = new Map();
  for (let element = 0; element < clipped.body.length; element++)
    for (const corners of [
      [0, 1, 2],
      [0, 1, 3],
      [0, 2, 3],
      [1, 2, 3],
    ]) {
      const nodes = corners.map((corner) => clipped.tet[4 * element + corner]);
      const key = nodes.toSorted((left, right) => left - right).join(",");
      const entry = faceCounts.get(key);
      if (entry) entry.count++;
      else faceCounts.set(key, { nodes, count: 1 });
    }
  for (const face of faceCounts.values()) {
    assert.ok(face.count <= 2, "cut solid mesh must remain manifold");
    if (face.count !== 1) continue;
    const center = [0, 1, 2].map((axis) =>
      face.nodes.reduce((sum, node) => sum + clipped.V[3 * node + axis] / 3, 0),
    );
    const internal =
      center[0] > 1e-6 &&
      center[0] < 60 - 1e-6 &&
      center[1] > 19 + 1e-6 &&
      center[1] < 21 - 1e-6 &&
      center[2] > 6 + 1e-6 &&
      center[2] < 12 - 1e-6;
    assert.ok(
      !internal,
      "clipping must not introduce interior cracks or hanging tetrahedron faces",
    );
  }

  const shellArea = mixed.triangles.reduce((sum, _, index) => {
    if (index % 3) return sum;
    const [first, second, third] = mixed.triangles
      .slice(index, index + 3)
      .map((node) => mixed.pool.slice(3 * node, 3 * node + 3));
    return (
      sum +
      Math.abs(
        (second[0] - first[0]) * (third[2] - first[2]) -
          (third[0] - first[0]) * (second[2] - first[2]),
      ) /
        2
    );
  }, 0);
  assert.ok(
    Math.abs(shellArea * 2 + retainedVolume - 60 * 2 * 30) < 1e-6,
    "shell and retained solids must represent wall volume exactly once",
  );
}
console.log(
  "automatic solid sections conserve volume and move the shell transition",
);

// Two perpendicular supports share solid interfaces with the retained wall.
// Every face inside those interfaces needs a matching neighbour after cutting.
{
  const original = shellJunction(1, 4, true);
  const shells = extractThinWallShells(original, {
    shellBodyIds: new Set([1]),
  });
  const { mesh: clipped } = buildShellTransitionModel(original, shells);
  const counts = new Map();
  for (let element = 0; element < clipped.body.length; element++)
    for (const corners of [
      [0, 1, 2],
      [0, 1, 3],
      [0, 2, 3],
      [1, 2, 3],
    ]) {
      const nodes = corners.map((corner) => clipped.tet[4 * element + corner]);
      const key = nodes.toSorted((left, right) => left - right).join(",");
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { nodes, count: 1 });
    }
  const between = (value, minimum, maximum) =>
    value > minimum + 1e-7 && value < maximum - 1e-7;
  const insideBox = (point, lower, upper) =>
    point.every((value, axis) => between(value, lower[axis], upper[axis]));
  const onInterface = (point) =>
    between(point[1], 19, 21) &&
    ((Math.abs(point[0]) < 1e-7 && between(point[2], 6, 36)) ||
      (Math.abs(point[2] - 6) < 1e-7 && between(point[0], 0, 60)));
  const insideRetainedWall = (point) =>
    insideBox(point, [0, 19, 6], [60, 21, 36]) &&
    (point[0] < 6 - 1e-7 || point[2] < 12 - 1e-7);
  const unmatched = [...counts.values()].filter((face) => {
    assert.ok(face.count <= 2, "solid faces must remain manifold");
    if (face.count !== 1) return false;
    const center = [0, 1, 2].map((axis) =>
      face.nodes.reduce((sum, node) => sum + clipped.V[3 * node + axis] / 3, 0),
    );
    return (
      insideBox(center, [0, 0, 0], [60, 40, 6]) ||
      insideBox(center, [-5, 19, 6], [0, 21, 36]) ||
      insideRetainedWall(center) ||
      onInterface(center)
    );
  });
  assert.equal(
    unmatched.length,
    0,
    "perpendicular support interfaces must have no hanging faces",
  );
  for (let triangle = 0; triangle < clipped.surfFace.length; triangle++) {
    const key = clipped.surfTri
      .slice(3 * triangle, 3 * triangle + 3)
      .toSorted((left, right) => left - right)
      .join(",");
    assert.ok(
      counts.has(key),
      "CAD surface triangles must match the subdivided FEM faces",
    );
  }

  for (const [bodyId, expected] of [
    [1, 1008],
    [2, 14400],
    [3, 300],
  ]) {
    const volume = clipped.body.reduce(
      (sum, body, index) =>
        sum +
        (body === bodyId
          ? tetVolume(clipped.V, clipped.tet.slice(4 * index, 4 * index + 4))
          : 0),
      0,
    );
    assert.ok(
      Math.abs(volume - expected) < 1e-6,
      `body ${bodyId} volume changed: ${volume}`,
    );
  }
}
console.log(
  "perpendicular solid supports remain conforming after transition cuts",
);

if (process.argv.includes("--wasm")) {
  const { readFileSync } = await import("node:fs");
  const { default: createModule } =
    await import("../src/wasm/pkg/kofem_wasm_emcc.js");
  const engine = await createModule({
    wasmBinary: readFileSync(
      new URL("../src/wasm/pkg/kofem_wasm_emcc.wasm", import.meta.url),
    ),
  });
  const solve = (candidate, axis, optimize = false) => {
    const point = (index) => candidate.pool.slice(3 * index, 3 * index + 3);
    const fixed = [];
    for (let index = 0; index < candidate.pool.length / 3; index++)
      if (Math.abs(point(index)[2]) < 1e-8)
        for (let component = 0; component < 3; component++)
          fixed.push(6 * index + component);
    const tips = [];
    for (let index = 0; index < candidate.pool.length / 3; index++)
      if (Math.abs(point(index)[2] - 36) < 1e-8) tips.push(index);
    const forceWeights = tips.map((index) => {
      const [coordX, coordY] = point(index);
      const along =
        Math.abs(coordX) < 1e-8 || Math.abs(coordX - 60) < 1e-8 ? 0.5 : 1;
      const across =
        Math.abs(coordY - 19) < 1e-8 || Math.abs(coordY - 21) < 1e-8 ? 0.5 : 1;
      return along * across;
    });
    const sum = forceWeights.reduce((total, value) => total + value, 0);
    const forces = forceWeights.map((value) => (100 * value) / sum);
    const engineArguments = [
      {
        vertices: Float64Array.from(candidate.pool),
        tets: Int32Array.from(candidate.tets),
        triangles: Int32Array.from(candidate.triangles),
        thicknesses: Float64Array.from(candidate.thicknesses),
        attributes: Int32Array.from(
          candidate.tetBody.map((body) => (body === 1 ? 1 : 2)),
        ),
      },
      {
        ref: Int32Array.from(candidate.coupling.ref),
        offsets: Int32Array.from(candidate.coupling.offsets),
        solid: Int32Array.from(candidate.coupling.solid),
        mpc: Int32Array.from(couplingMpcCodes(candidate.coupling)),
        weights: candidate.coupling.weights
          ? Float64Array.from(candidate.coupling.weights)
          : undefined,
      },
      {
        fixed_dofs: Int32Array.from(fixed),
        load_dofs: Int32Array.from(tips.map((index) => 6 * index + axis)),
        load_vals: Float64Array.from(forces),
      },
      JSON.stringify({
        solid: [
          { young_modulus: 210000, poisson_ratio: 0.3 },
          { young_modulus: 210000, poisson_ratio: 0.3 },
        ],
        shell: { young_modulus: 210000, poisson_ratio: 0.3 },
      }),
    ];
    const result = engine.solve_coupled(...engineArguments);
    if (optimize) {
      const optimized = engine.optimize_topology_coupled(
        ...engineArguments,
        JSON.stringify({
          objective: "min_compliance",
          constraints: { volumeFraction: 0.5 },
          filterRadius: 4,
          maxIterations: 1,
          tolerance: 0.01,
        }),
        null,
      );
      assert.ok(!("error" in optimized), JSON.stringify(optimized.error));
      assert.equal(
        optimized.density.length,
        candidate.tets.length / 4 + candidate.triangles.length / 3,
      );
      assert.ok(
        optimized.density.every(Number.isFinite),
        "footprint constraints must also reach the coupled optimizer",
      );
    }
    assert.ok(!("error" in result), JSON.stringify(result.error));
    const block = candidate.tetBody.flatMap((body, index) =>
      body === 2 ? [result.von_mises_tets[index]] : [],
    );
    const peak = Math.max(...block);
    const tip = tips.reduce(
      (total, index, load) =>
        total + (forces[load] * result.displacements[3 * index + axis]) / 100,
      0,
    );
    assert.ok(block.every(Number.isFinite));
    assert.ok(Number.isFinite(tip) && tip > 0);
    return { peak, tip, block };
  };
  for (const wallStep of [3, 4]) {
    const original = shellJunction(2, wallStep);
    const shells = extractThinWallShells(original, {
      shellBodyIds: new Set([1]),
    });
    const { model: generated } = buildShellTransitionModel(original, shells);
    const points = generated.pool;
    // Reload the stored mixed mesh: rederive the same physical footprint.
    const reloaded = buildExplicitCoupledModel(
      points,
      generated.tets,
      generated.triangles,
      generated.thicknesses,
    );
    reloaded.tetBody = generated.tetBody;
    const reference = {
      pool: original.V,
      tets: original.tet,
      tetBody: original.body,
      triangles: [],
      thicknesses: [],
      coupling: { ref: [], offsets: [0], solid: [] },
    };
    for (const axis of [2, 0]) {
      const expected = solve(reference, axis),
        actual = solve(reloaded, axis, wallStep === 3 && axis === 2);
      assert.ok(
        Math.abs(actual.peak / expected.peak - 1) < 0.01,
        `junction peak: actual ${actual.peak}, reference ${expected.peak}`,
      );
      assert.ok(
        Math.abs(actual.tip / expected.tip - 1) < 0.02,
        `tip: actual ${actual.tip}, reference ${expected.tip}`,
      );
      const difference = actual.block.reduce(
        (total, value, index) => total + (value - expected.block[index]) ** 2,
        0,
      );
      const magnitude = expected.block.reduce(
        (total, value) => total + value ** 2,
        0,
      );
      assert.ok(
        Math.sqrt(difference / magnitude) < 0.01,
        "solid stress distribution must match the same-mesh reference",
      );
      console.log(
        `WASM step=${wallStep} axis=${axis} peak ratio=${actual.peak / expected.peak}, field error=${Math.sqrt(difference / magnitude)}`,
      );
    }
  }
  console.log(
    "automatic solid-section footprint survives reload and passes WASM stress regression",
  );
}

// A physical joint at the lower edge must not drop a separate gapped joint
// at the upper edge of the same connected shell panel.
const extendedVertices = [
  ...vertices,
  0,
  -1,
  9.5,
  2,
  -1,
  9.5,
  0,
  1,
  9.5,
  0,
  -1,
  11.5,
];
const twoEnds = buildExplicitCoupledModel(
  extendedVertices,
  [...tets, 11, 12, 13, 14],
  tris,
  [2, 2],
);
assert.ok(couplingMpcCodes(twoEnds.coupling).includes(3));
assert.ok(
  couplingMpcCodes(twoEnds.coupling).includes(1),
  "a footprint must not suppress a distinct seam elsewhere on the shell",
);

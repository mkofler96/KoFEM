// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Physical shell footprint of the shell/solid coupling (src/lib/shellize.ts):
// shell-edge kinematics are interpolated rather than averaged over a search
// ball, automatic solid sections conserve volume and stay conforming after the
// transition cuts, and the coupled solve and optimizer accept the footprint
// constraints (C++ engine, shell idealisation in the Rust module).

import { beforeAll, describe, expect, test } from "bun:test";
import {
  buildExplicitCoupledModel,
  buildShellTransitionModel,
  couplingMpcCodes,
  dropCouplingsOnFixedNodes,
  extractThinWallShells,
} from "../../src/lib/shellize.ts";
import { shellJunction, tetVolume } from "../fixtures/shell-junction.mjs";
import { loadEngine, loadFem } from "../support/wasm.mjs";

// A non-conforming solid section: the middle row has no coincident shell node.
const vertices = [
  0, -1, 6, 0, 1, 6, 2, -1, 6, 2, 1, 6, 1, -1, 6, 1, 1, 6, 0, 0, 6, 2, 0, 6, 0,
  0, 9, 2, 0, 9, 0, -1, 3,
];
const tets = [0, 1, 4, 10, 1, 4, 5, 10, 4, 5, 2, 10, 5, 2, 3, 10];
const tris = [6, 7, 9, 6, 9, 8];

const TET_FACES = [
  [0, 1, 2],
  [0, 1, 3],
  [0, 2, 3],
  [1, 2, 3],
];

/** Count how many tetrahedra share each face of a clipped solid mesh. */
function countFaces(clipped) {
  const faceCounts = new Map();
  for (let element = 0; element < clipped.body.length; element++)
    for (const corners of TET_FACES) {
      const nodes = corners.map((corner) => clipped.tet[4 * element + corner]);
      const key = nodes.toSorted((left, right) => left - right).join(",");
      const entry = faceCounts.get(key);
      if (entry) entry.count++;
      else faceCounts.set(key, { nodes, count: 1 });
    }
  return faceCounts;
}

function faceCenter(clipped, face) {
  return [0, 1, 2].map((axis) =>
    face.nodes.reduce((sum, node) => sum + clipped.V[3 * node + axis] / 3, 0),
  );
}

function bodyVolume(clipped, bodyId) {
  return clipped.body.reduce(
    (sum, body, index) =>
      sum +
      (body === bodyId
        ? tetVolume(clipped.V, clipped.tet.slice(4 * index, 4 * index + 4))
        : 0),
    0,
  );
}

describe("physical shell footprint", () => {
  let model = null;

  beforeAll(async () => {
    await loadFem();
    model = buildExplicitCoupledModel(vertices, tets, tris, [2, 2]);
  });

  test("interpolates shell-edge kinematics instead of averaging a solid search ball", () => {
    expect(couplingMpcCodes(model.coupling)).toContain(3);
  });

  test("couples every solid footprint node with equal edge weights", () => {
    const middle = model.poolOfVertex.get(4);
    const row = model.coupling.ref.indexOf(middle);
    expect(row, "every solid footprint node must be coupled").toBeGreaterThan(
      -1,
    );
    expect(
      model.coupling.weights.slice(
        model.coupling.offsets[row],
        model.coupling.offsets[row + 1],
      ),
    ).toEqual([0.5, 0.5]);
  });

  test("a prescribed displacement on a transition node is rejected", () => {
    const middle = model.poolOfVertex.get(4);
    expect(() =>
      dropCouplingsOnFixedNodes(model.coupling, [6 * middle]),
    ).toThrow(/transition.*prescribed|prescribed.*transition/i);
  });

  test("a footprint does not suppress a distinct seam elsewhere on the shell", () => {
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
    const codes = couplingMpcCodes(twoEnds.coupling);
    expect(codes).toContain(3);
    expect(codes).toContain(1);
  });
});

describe("automatic solid sections", () => {
  beforeAll(async () => {
    await loadFem();
  });

  // The 6 mm transition cuts through existing tets and surface facets (4 mm rows).
  test.each([3, 4])(
    "conserve volume and move the shell transition (wall step %d)",
    (wallStep) => {
      const original = shellJunction(1, wallStep);
      const shells = extractThinWallShells(original, {
        shellBodyIds: new Set([1]),
      });
      expect(shells.shellBody).toBe(1);
      const {
        mesh: clipped,
        shells: clippedShells,
        model: mixed,
      } = buildShellTransitionModel(original, shells);
      const retainedVolume = bodyVolume(clipped, 1);
      expect(
        Math.abs(retainedVolume - 60 * 2 * 6),
        `retain exactly the physical 6 mm solid section, got ${retainedVolume}`,
      ).toBeLessThan(1e-6);
      clippedShells.shellVerts.forEach((value, index) => {
        if (index % 3 === 2) expect(value).toBeGreaterThanOrEqual(12 - 1e-7);
      });
      expect(couplingMpcCodes(mixed.coupling)).toContain(3);

      for (const face of countFaces(clipped).values()) {
        expect(
          face.count,
          "cut solid mesh must remain manifold",
        ).toBeLessThanOrEqual(2);
        if (face.count !== 1) continue;
        const center = faceCenter(clipped, face);
        const internal =
          center[0] > 1e-6 &&
          center[0] < 60 - 1e-6 &&
          center[1] > 19 + 1e-6 &&
          center[1] < 21 - 1e-6 &&
          center[2] > 6 + 1e-6 &&
          center[2] < 12 - 1e-6;
        expect(
          internal,
          "clipping must not introduce interior cracks or hanging tetrahedron faces",
        ).toBe(false);
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
      expect(
        Math.abs(shellArea * 2 + retainedVolume - 60 * 2 * 30),
        "shell and retained solids must represent wall volume exactly once",
      ).toBeLessThan(1e-6);
    },
  );

  // Two perpendicular supports share solid interfaces with the retained wall.
  // Every face inside those interfaces needs a matching neighbour after cutting.
  test("perpendicular solid supports remain conforming after transition cuts", () => {
    const original = shellJunction(1, 4, true);
    const shells = extractThinWallShells(original, {
      shellBodyIds: new Set([1]),
    });
    const { mesh: clipped } = buildShellTransitionModel(original, shells);
    const counts = countFaces(clipped);
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
      expect(
        face.count,
        "solid faces must remain manifold",
      ).toBeLessThanOrEqual(2);
      if (face.count !== 1) return false;
      const center = faceCenter(clipped, face);
      return (
        insideBox(center, [0, 0, 0], [60, 40, 6]) ||
        insideBox(center, [-5, 19, 6], [0, 21, 36]) ||
        insideRetainedWall(center) ||
        onInterface(center)
      );
    });
    expect(
      unmatched.length,
      "perpendicular support interfaces must have no hanging faces",
    ).toBe(0);
    for (let triangle = 0; triangle < clipped.surfFace.length; triangle++) {
      const key = clipped.surfTri
        .slice(3 * triangle, 3 * triangle + 3)
        .toSorted((left, right) => left - right)
        .join(",");
      expect(
        counts.has(key),
        "CAD surface triangles must match the subdivided FEM faces",
      ).toBe(true);
    }

    for (const [bodyId, expected] of [
      [1, 1008],
      [2, 14400],
      [3, 300],
    ]) {
      const volume = bodyVolume(clipped, bodyId);
      expect(
        Math.abs(volume - expected),
        `body ${bodyId} volume changed: ${volume}`,
      ).toBeLessThan(1e-6);
    }
  });
});

// The coupled solve and optimizer of the C++ engine on the same footprint.
describe("footprint survives reload and passes the engine stress regression", () => {
  let engine = null;

  beforeAll(async () => {
    await loadFem();
    engine = await loadEngine();
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
      expect("error" in optimized, JSON.stringify(optimized.error)).toBe(false);
      expect(optimized.density).toHaveLength(
        candidate.tets.length / 4 + candidate.triangles.length / 3,
      );
      expect(
        optimized.density.every(Number.isFinite),
        "footprint constraints must also reach the coupled optimizer",
      ).toBe(true);
    }
    expect("error" in result, JSON.stringify(result.error)).toBe(false);
    const block = candidate.tetBody.flatMap((body, index) =>
      body === 2 ? [result.von_mises_tets[index]] : [],
    );
    const peak = Math.max(...block);
    const tip = tips.reduce(
      (total, index, load) =>
        total + (forces[load] * result.displacements[3 * index + axis]) / 100,
      0,
    );
    expect(block.every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(tip)).toBe(true);
    expect(tip).toBeGreaterThan(0);
    return { peak, tip, block };
  };

  test.each([
    [3, 2],
    [3, 0],
    [4, 2],
    [4, 0],
  ])(
    "wall step %d, load axis %d matches the same-mesh reference",
    (wallStep, axis) => {
      const original = shellJunction(2, wallStep);
      const shells = extractThinWallShells(original, {
        shellBodyIds: new Set([1]),
      });
      const { model: generated } = buildShellTransitionModel(original, shells);
      // Reload the stored mixed mesh: rederive the same physical footprint.
      const reloaded = buildExplicitCoupledModel(
        generated.pool,
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
      const expected = solve(reference, axis);
      const actual = solve(reloaded, axis, wallStep === 3 && axis === 2);
      expect(
        Math.abs(actual.peak / expected.peak - 1),
        `junction peak: actual ${actual.peak}, reference ${expected.peak}`,
      ).toBeLessThan(0.01);
      expect(
        Math.abs(actual.tip / expected.tip - 1),
        `tip: actual ${actual.tip}, reference ${expected.tip}`,
      ).toBeLessThan(0.02);
      const difference = actual.block.reduce(
        (total, value, index) => total + (value - expected.block[index]) ** 2,
        0,
      );
      const magnitude = expected.block.reduce(
        (total, value) => total + value ** 2,
        0,
      );
      expect(
        Math.sqrt(difference / magnitude),
        "solid stress distribution must match the same-mesh reference",
      ).toBeLessThan(0.01);
    },
  );
});

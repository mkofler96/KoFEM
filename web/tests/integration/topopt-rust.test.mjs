// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The app's all-solid topology optimization through the Rust module must give
// the same designs and objective histories as through the C++ engine. Both
// take the SAME store model: the engine through buildSolidEngineInputs →
// optimize_topology (the worker's path until KOF-310), Rust through
// optimizeSolidInRust (the worker's path now).
//
// The models are the topology-optimization validation benchmarks
// (examples/validation/topopt): the MBB half-beam and the 3D cantilever, both
// hexahedra, plus a tetrahedral cantilever under a surface pressure that runs
// min_volume, passive regions and the maximum-stress constraint. Node ids are
// offset from vertex indices, as in saved analyses.

import { beforeAll, describe, expect, test } from "bun:test";
import { buildVertexIndexer } from "../../src/lib/solveMeshPacking.ts";
import { buildSolidEngineInputs } from "../../src/lib/solve/solid.ts";
import { optimizeSolidInRust } from "../../src/lib/solve/topOptRust.ts";
import { parseTopOptLogLine } from "../../src/lib/topOptProgress.ts";
import { buildCantilever } from "../../../examples/validation/topopt/cases/cantilever-3d.mjs";
import {
  boxHexMesh,
  dirichletBuilder,
  distributeForce,
  verticesWhere,
} from "../../../examples/validation/topopt/lib/topopt.mjs";
import { loadEngine, loadFem } from "../support/wasm.mjs";

const NODE_OFFSET = 101;

let fem = null;
beforeAll(async () => {
  fem = await loadFem();
});

// A store model (the app's payload) from a benchmark's engine-shaped mesh and
// supports/point loads.
function storeModel({ vertices, tetrahedra = [], hexahedra = [] }, bcs) {
  const nodeId = (vertex) => vertex + NODE_OFFSET;
  const nodes = vertices.map(([x, y, z], vertex) => ({
    id: nodeId(vertex),
    x,
    y,
    z,
  }));
  let elementId = 1;
  const elements = [
    ...tetrahedra.map((corners) => ({
      id: elementId++,
      type: "CTETRA",
      nodeIds: corners.map(nodeId),
      propertyId: 1,
    })),
    ...hexahedra.map((corners) => ({
      id: elementId++,
      type: "CHEXA",
      nodeIds: corners.map(nodeId),
      propertyId: 1,
    })),
  ];
  const constraints = [
    ...(bcs.fixed_vertices ?? []).flatMap((vertex) =>
      [0, 1, 2].map((dof) => ({ nodeId: nodeId(vertex), dof })),
    ),
    ...(bcs.fixed_dofs ?? []).flatMap(({ vertex, dofs }) =>
      dofs.map((dof) => ({ nodeId: nodeId(vertex), dof })),
    ),
  ];
  const loads = (bcs.point_loads ?? []).flatMap(({ vertex, force }) =>
    force
      .map((value, dof) => ({ nodeId: nodeId(vertex), dof, value }))
      .filter(({ value }) => value !== 0),
  );
  return {
    nodes,
    elements,
    materials: [{ id: 1, name: "Unit", young: 1, poisson: 0.3, density: 1 }],
    properties: [{ id: 1, materialId: 1 }],
    constraints,
    loads,
    surfaceLoads: (bcs.surface_loads ?? []).map((load) => ({
      ...load,
      faces: load.faces.map((face) => face.map(nodeId)),
    })),
  };
}

// The MBB half-beam of examples/validation/topopt/cases/mbb-beam.mjs.
function mbb() {
  const [L, H, T] = [6, 2, 0.5];
  const mesh = boxHexMesh(L, H, T, 36, 12, 1);
  const bc = dirichletBuilder();
  for (let vertex = 0; vertex < mesh.vertices.length; vertex++) {
    const [x, y] = mesh.vertices[vertex];
    bc.fix(vertex, 2);
    if (x <= 1e-9) bc.fix(vertex, 0);
    if (x >= L - 1e-9 && y <= 1e-9) bc.fix(vertex, 1);
  }
  const loaded = verticesWhere(mesh, (x, y) => x <= 1e-9 && y >= H - 1e-9);
  return storeModel(mesh, {
    ...bc.build(),
    point_loads: distributeForce(loaded, [0, -1, 0]),
  });
}

const MBB_SETTINGS = {
  method: "simp",
  objective: "min_compliance",
  constraints: { volumeFraction: 0.5 },
  penalty: 3,
  filterRadius: 0.3,
  moveLimit: 0.2,
  maxIterations: 80,
  tolerance: 0.01,
};

// A 4×1×1 tetrahedral cantilever (Kuhn-split cubes, 16×4×4), clamped at
// x = 0, with a downward pressure on the top face of its last quarter.
function tetCantilever() {
  const [nx, ny, nz] = [16, 4, 4];
  const [L, W, H] = [4, 1, 1];
  const index = (i, j, k) => i + (nx + 1) * (j + (ny + 1) * k);
  const vertices = [];
  for (let k = 0; k <= nz; k++)
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i <= nx; i++)
        vertices.push([(i * L) / nx, (j * W) / ny, (k * H) / nz]);
  const kuhn = [
    [0, 1, 3, 7],
    [0, 3, 2, 7],
    [0, 2, 6, 7],
    [0, 6, 4, 7],
    [0, 4, 5, 7],
    [0, 5, 1, 7],
  ];
  const tetrahedra = [];
  const top = [];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const corner = (bits) =>
          index(i + (bits & 1), j + ((bits >> 1) & 1), k + ((bits >> 2) & 1));
        for (const tet of kuhn) tetrahedra.push(tet.map(corner));
        // The two triangles of this cube's top face (y = W), last quarter.
        if (j === ny - 1 && i >= (3 * nx) / 4) {
          top.push([corner(2), corner(3), corner(7)]);
          top.push([corner(2), corner(7), corner(6)]);
        }
      }
  const bc = dirichletBuilder();
  vertices.forEach(([x], vertex) => {
    if (x <= 1e-9) for (const dof of [0, 1, 2]) bc.fix(vertex, dof);
  });
  return storeModel(
    { vertices, tetrahedra },
    {
      ...bc.build(),
      surface_loads: [{ type: "pressure", pressure: 0.05, faces: top }],
    },
  );
}

// Run the engine's optimize_topology on the model as the worker did, keeping
// its log.
async function optimizeInEngine(model, settings) {
  const logs = [];
  const streamed = [];
  const engine = await loadEngine({ print: (line) => logs.push(line) });
  const inputs = buildSolidEngineInputs(model, buildVertexIndexer(model.nodes));
  const result = engine.optimize_topology(
    inputs.mesh,
    inputs.matJson,
    inputs.bcsJson,
    JSON.stringify(settings),
    (iteration, density) =>
      streamed.push({ iteration, density: Array.from(density) }),
  );
  if ("error" in result) throw new Error(result.error);
  return {
    density: Array.from(result.density),
    ...(result.levelSet ? { levelSet: Array.from(result.levelSet) } : {}),
    history: result.history.map((entry) => ({ ...entry })),
    logs,
    streamed,
  };
}

// Every iteration a run logged (a capped run that falls back returns fewer).
const loggedIterations = (logs) =>
  logs
    .map((line) => parseTopOptLogLine(line))
    .filter((point) => point !== null);

function optimizeInRust(model, settings) {
  const logs = [];
  const streamed = [];
  const result = optimizeSolidInRust(
    fem,
    { ...model, settings },
    (line) => logs.push(line),
    (iteration, density) => streamed.push({ iteration, density }),
  );
  return { ...result, logs, streamed };
}

// Largest relative difference of a history field over the first `count`
// entries, and the largest absolute density difference.
function compare(rust, engine, count) {
  let compliance = 0;
  let volume = 0;
  for (let index = 0; index < count; index++) {
    const lhs = rust.history[index];
    const rhs = engine.history[index];
    compliance = Math.max(
      compliance,
      Math.abs(lhs.compliance - rhs.compliance) / Math.abs(rhs.compliance),
    );
    volume = Math.max(volume, Math.abs(lhs.volume - rhs.volume));
  }
  let density = 0;
  for (let index = 0; index < engine.density.length; index++)
    density = Math.max(
      density,
      Math.abs(rust.density[index] - engine.density[index]),
    );
  return { compliance, volume, density };
}

describe("solid topology optimization: Rust against the C++ engine", () => {
  test("the MBB half-beam gives the engine's history and design", async () => {
    const model = mbb();
    const engine = await optimizeInEngine(model, MBB_SETTINGS);
    const rust = optimizeInRust(model, MBB_SETTINGS);
    expect(rust.history.length).toBe(engine.history.length);
    const difference = compare(rust, engine, engine.history.length);
    expect(difference.compliance).toBeLessThan(1e-4);
    expect(difference.volume).toBeLessThan(1e-4);
    expect(difference.density).toBeLessThan(1e-3);
  });

  test("the 3D cantilever gives the engine's history and design", async () => {
    const { mesh, bcs, settings } = buildCantilever(10, 5, 5);
    const model = storeModel(mesh, bcs);
    const engine = await optimizeInEngine(model, settings);
    const rust = optimizeInRust(model, settings);
    expect(rust.history.length).toBe(engine.history.length);
    const difference = compare(rust, engine, engine.history.length);
    expect(difference.compliance).toBeLessThan(1e-4);
    expect(difference.density).toBeLessThan(1e-3);
  });

  test("min_volume with passive regions under a pressure matches", async () => {
    const model = tetCantilever();
    const reference = await optimizeInEngine(model, {
      ...MBB_SETTINGS,
      filterRadius: 0.4,
      maxIterations: 40,
    });
    const elementCount = model.elements.length;
    const settings = {
      ...MBB_SETTINGS,
      objective: "min_volume",
      constraints: { complianceLimit: reference.history.at(-1).compliance },
      filterRadius: 0.4,
      maxIterations: 40,
      passive: {
        solid: [0, 1, 2, 3, 4, 5],
        void: [elementCount - 1],
      },
    };
    const engine = await optimizeInEngine(model, settings);
    const rust = optimizeInRust(model, settings);
    expect(rust.history.length).toBe(engine.history.length);
    const difference = compare(rust, engine, engine.history.length);
    expect(difference.compliance).toBeLessThan(1e-4);
    expect(difference.density).toBeLessThan(1e-3);
    expect(rust.density.slice(0, 6).every((rho) => rho === 1)).toBe(true);
    expect(rust.history[0].objective).toBe(rust.history[0].volume);
  });

  test("a stress-constrained run takes the engine's every step", async () => {
    const model = tetCantilever();
    const settings = {
      ...MBB_SETTINGS,
      filterRadius: 0.4,
      maxIterations: 30,
      stress: { aggregation: "pnorm" },
    };
    // The limit: 0.8 × the peak of the uniform start, binding from the outset.
    const probe = optimizeInRust(model, {
      ...settings,
      constraints: { volumeFraction: 0.5, maxStress: 1e12 },
      maxIterations: 1,
    });
    settings.constraints = {
      volumeFraction: 0.5,
      maxStress: 0.8 * probe.history[0].max_stress,
    };
    const engine = await optimizeInEngine(model, settings);
    const rust = optimizeInRust(model, settings);
    const engineSteps = loggedIterations(engine.logs);
    const rustSteps = loggedIterations(rust.logs);
    expect(rustSteps.length).toBe(engineSteps.length);
    expect(rust.history.length).toBe(engine.history.length);
    // The log prints 6 significant digits.
    for (const [index, step] of engineSteps.entries())
      for (const field of ["compliance", "volume", "stress", "maxStress"])
        expect(
          Math.abs(rustSteps[index][field] - step[field]) / step[field],
        ).toBeLessThan(1e-4);
    const difference = compare(rust, engine, engine.history.length);
    expect(difference.density).toBeLessThan(1e-3);
    expect(rust.history.at(-1).max_stress).toBeGreaterThan(0);
  });

  test("streams the engine's designs on its cadence, and logs lines the progress plot parses", async () => {
    const model = mbb();
    const settings = { ...MBB_SETTINGS, maxIterations: 7, streamEvery: 3 };
    const engine = await optimizeInEngine(model, settings);
    const rust = optimizeInRust(model, settings);
    expect(rust.streamed.map(({ iteration }) => iteration)).toEqual([3, 6, 7]);
    expect(engine.streamed.map(({ iteration }) => iteration)).toEqual([
      3, 6, 7,
    ]);
    // Each streamed field is the design that iteration analysed, as the
    // engine streams it — not the next one.
    for (const [index, { density }] of rust.streamed.entries()) {
      const reference = engine.streamed[index].density;
      const largest = Math.max(
        ...Array.from(density, (rho, element) =>
          Math.abs(rho - reference[element]),
        ),
      );
      expect(largest).toBeLessThan(1e-6);
    }
    expect(Array.from(rust.streamed.at(-1).density)).toEqual(
      Array.from(rust.density),
    );
    const points = rust.logs
      .map((line) => parseTopOptLogLine(line))
      .filter((point) => point !== null);
    expect(points.map((point) => point.it)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const [index, point] of points.entries())
      expect(point.compliance).toBeCloseTo(rust.history[index].compliance, 2);
    expect(rust.logs.at(-1)).toContain("[topopt] complete: 7 iteration(s)");
  });

  test("refuses what the engine refuses, with its messages", () => {
    const model = mbb();
    const run = (settings) => () => optimizeInRust(model, settings);
    expect(run({ ...MBB_SETTINGS, constraints: {} })).toThrow(
      "requires constraints.volumeFraction",
    );
    expect(
      run({ ...MBB_SETTINGS, objective: "min_volume", constraints: {} }),
    ).toThrow("requires constraints.complianceLimit");
    expect(run({ ...MBB_SETTINGS, objective: "max_stiffness" })).toThrow(
      "unknown topology-optimization objective",
    );
    expect(run({ ...MBB_SETTINGS, stress: { aggregation: "ks" } })).toThrow(
      "needs constraints.maxStress",
    );
    expect(run({ ...MBB_SETTINGS, maxIterations: 0 })).toThrow(
      "maxIterations must be a positive integer",
    );
    const prescribed = {
      ...model,
      constraints: [
        ...model.constraints,
        { nodeId: NODE_OFFSET + 5, dof: 0, prescribedValue: 0.1 },
      ],
    };
    expect(() =>
      optimizeSolidInRust(
        fem,
        { ...prescribed, settings: MBB_SETTINGS },
        () => undefined,
        () => undefined,
      ),
    ).toThrow("does not support prescribed (non-zero) displacements");
  });
});

// The level-set method (KOF-358): minimum compliance on a solid design
// domain, a nodal φ alongside the element densities.
const LEVEL_SET_SETTINGS = {
  method: "level_set",
  objective: "min_compliance",
  constraints: { volumeFraction: 0.5 },
  filterRadius: 0,
  maxIterations: 60,
  tolerance: 0.01,
};

// Largest absolute difference of two equally long arrays.
const largestDifference = (lhs, rhs) =>
  Math.max(...Array.from(lhs, (value, index) => Math.abs(value - rhs[index])));

describe("level-set topology optimization: Rust against the C++ engine", () => {
  // Both paths reach the same design; the bisection on the volume can flip a
  // boundary element a few iterations earlier or later, so the histories are
  // compared entry by entry up to the shorter one.
  function expectEngineDesign(rust, engine) {
    const count = Math.min(rust.history.length, engine.history.length);
    expect(Math.abs(rust.history.length - engine.history.length)).toBeLessThan(
      5,
    );
    const difference = compare(rust, engine, count);
    expect(difference.compliance).toBeLessThan(1e-3);
    expect(difference.volume).toBeLessThan(1e-3);
    const last = (run) => run.history.at(-1);
    expect(
      Math.abs(last(rust).compliance - last(engine).compliance) /
        last(engine).compliance,
    ).toBeLessThan(1e-2);
    expect(rust.levelSet).toBeInstanceOf(Float64Array);
    expect(rust.levelSet.length).toBe(engine.levelSet.length);
    // Store node order, not a renumbering: the viewport contours φ over the
    // store's nodes.
    const crossings = (levelSet) =>
      levelSet.filter((phi) => phi > -1 && phi < 1).length;
    expect(
      Math.abs(crossings(rust.levelSet) - crossings(engine.levelSet)),
    ).toBeLessThanOrEqual(0.05 * crossings(engine.levelSet) + 2);
    const differing = Array.from(rust.density).filter(
      (rho, element) => Math.abs(rho - engine.density[element]) > 0.1,
    ).length;
    expect(differing).toBeLessThanOrEqual(0.02 * engine.density.length);
  }

  test("the MBB half-beam (hexahedra) gives the engine's level set, densities and history", async () => {
    const model = mbb();
    const engine = await optimizeInEngine(model, LEVEL_SET_SETTINGS);
    const rust = optimizeInRust(model, LEVEL_SET_SETTINGS);
    expectEngineDesign(rust, engine);
  });

  // On this cantilever neither path settles: once the volume is met the
  // design keeps flipping boundary elements (max|Δρ| stays near 1), so the
  // runs drift apart after about 25 iterations. The 20 iterations before
  // that carve out most of the material and must match.
  test("a tet cantilever under pressure takes the engine's first 20 steps", async () => {
    const model = tetCantilever();
    const settings = {
      ...LEVEL_SET_SETTINGS,
      constraints: { volumeFraction: 0.4 },
      maxIterations: 20,
    };
    const engine = await optimizeInEngine(model, settings);
    const rust = optimizeInRust(model, settings);
    expect(rust.history.length).toBe(20);
    expect(engine.history.length).toBe(20);
    const difference = compare(rust, engine, 20);
    expect(difference.compliance).toBeLessThan(1e-4);
    expect(difference.volume).toBeLessThan(1e-5);
    expect(difference.density).toBeLessThan(1e-3);
    expect(largestDifference(rust.levelSet, engine.levelSet)).toBeLessThan(
      1e-3,
    );
  });

  test("the first iterations match the engine closely, and the stream ends on the result", async () => {
    const model = mbb();
    const settings = {
      ...LEVEL_SET_SETTINGS,
      maxIterations: 6,
      streamEvery: 4,
    };
    const engine = await optimizeInEngine(model, settings);
    const rust = optimizeInRust(model, settings);
    expect(rust.history.length).toBe(6);
    expect(compare(rust, engine, 6).compliance).toBeLessThan(1e-5);
    expect(largestDifference(rust.density, engine.density)).toBeLessThan(1e-4);
    expect(largestDifference(rust.levelSet, engine.levelSet)).toBeLessThan(
      1e-4,
    );
    expect(rust.streamed.map(({ iteration }) => iteration)).toEqual([4, 6]);
    // Each streamed field is the design that iteration analysed, as the
    // engine streams it — not the next one.
    for (const [index, { density }] of rust.streamed.entries())
      expect(
        largestDifference(density, engine.streamed[index].density),
      ).toBeLessThan(1e-4);
    expect(Array.from(rust.streamed.at(-1).density)).toEqual(
      Array.from(rust.density),
    );
    const points = rust.logs
      .map((line) => parseTopOptLogLine(line))
      .filter((point) => point !== null);
    expect(points.map((point) => point.it)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rust.logs.at(-1)).toContain(
      `returning ${rust.density.length} densities and ${rust.levelSet.length} level-set values`,
    );
  });

  test("passive regions stay pinned", () => {
    const model = mbb();
    const solid = [0, 1, 2, 36, 37, 38];
    const result = optimizeInRust(model, {
      ...LEVEL_SET_SETTINGS,
      maxIterations: 20,
      passive: { solid, void: [400, 401] },
    });
    for (const element of solid) expect(result.density[element]).toBe(1);
    expect(result.density[400]).toBe(0);
    expect(result.density[401]).toBe(0);
  });

  test("refuses what the engine refuses, with its messages", () => {
    const model = mbb();
    const run = (settings) => () => optimizeInRust(model, settings);
    expect(
      run({
        ...LEVEL_SET_SETTINGS,
        constraints: { volumeFraction: 0.5, maxStress: 10 },
      }),
    ).toThrow(
      "the level-set method does not support the maximum-stress constraint",
    );
    expect(
      run({
        ...LEVEL_SET_SETTINGS,
        objective: "min_volume",
        constraints: { complianceLimit: 10 },
      }),
    ).toThrow(
      "the level-set method supports the min_compliance objective only",
    );
    expect(run({ ...LEVEL_SET_SETTINGS, constraints: {} })).toThrow(
      "requires constraints.volumeFraction",
    );
    expect(run({ ...LEVEL_SET_SETTINGS, maxIterations: 0 })).toThrow(
      "maxIterations must be a positive integer",
    );
    expect(run({ ...LEVEL_SET_SETTINGS, method: "genetic" })).toThrow(
      'unknown topology-optimization method "genetic"',
    );
  });
});

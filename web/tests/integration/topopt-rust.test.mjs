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
import {
  optimizeSolidInRust,
  usesRustTopOpt,
} from "../../src/lib/solve/topOptRust.ts";
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

let fem;
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
  const engine = await loadEngine({ print: (line) => logs.push(line) });
  const inputs = buildSolidEngineInputs(model, buildVertexIndexer(model.nodes));
  const result = engine.optimize_topology(
    inputs.mesh,
    inputs.matJson,
    inputs.bcsJson,
    JSON.stringify(settings),
    null,
  );
  if ("error" in result) throw new Error(result.error);
  return {
    density: Array.from(result.density),
    history: result.history.map((entry) => ({ ...entry })),
    logs,
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
  test("routes SIMP to Rust and keeps the level set with the engine", () => {
    expect(usesRustTopOpt(MBB_SETTINGS)).toBe(true);
    expect(usesRustTopOpt({ ...MBB_SETTINGS, method: undefined })).toBe(true);
    expect(usesRustTopOpt({ ...MBB_SETTINGS, method: "level_set" })).toBe(
      false,
    );
  });

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

  test("streams on its cadence, and logs lines the progress plot parses", () => {
    const model = mbb();
    const rust = optimizeInRust(model, {
      ...MBB_SETTINGS,
      maxIterations: 7,
      streamEvery: 3,
    });
    expect(rust.streamed.map(({ iteration }) => iteration)).toEqual([3, 6, 7]);
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

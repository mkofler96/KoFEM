// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shell and coupled shell/solid topology optimization through the Rust module
// must give the same designs and objective histories as through the C++
// engine. Both take the SAME arguments: the engine through
// optimize_topology_shell / optimize_topology_coupled (the worker's path
// until KOF-310), Rust through optimizeShellInRust / optimizeCoupledInRust
// (the worker's path now).
//
// The models are the cases of engine/tests/topology_shell_validation.cpp: a
// simply-supported plate under a uniform pressure (a store model, through
// buildShellEngineInputs as the worker builds it), and a solid block with a
// thin shell wall hanging from it on distributing couplings. The wall's
// stored C++ runs carry the KOF-410 coupling error, so it is checked on its
// own (see its describe below); the refusals still match the engine.

import { beforeAll, describe, expect, test } from "bun:test";
import { buildShellEngineInputs } from "../../src/lib/solve/shell.ts";
import {
  optimizeCoupledInRust,
  optimizeShellInRust,
} from "../../src/lib/solve/topOptRust.ts";
import { parseTopOptLogLine } from "../../src/lib/topOptProgress.ts";
import { loadEngine, loadFem } from "../support/wasm.mjs";

const NODE_OFFSET = 101;

let fem = null;
beforeAll(async () => {
  fem = await loadFem();
});

// The C++ suite's plate as a store model: [0, 100]² in z = 0, n×n cells of
// two CTRIA3 each, 2 thick, u, v, w held on the boundary and a unit
// downward load on every interior node.
function plateModel(n) {
  const side = 100;
  const id = (i, j) => i * (n + 1) + j + NODE_OFFSET;
  const nodes = [];
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= n; j++)
      nodes.push({ id: id(i, j), x: (side * i) / n, y: (side * j) / n, z: 0 });
  const elements = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const corners = [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)];
      for (const facet of [
        [0, 1, 2],
        [0, 2, 3],
      ])
        elements.push({
          id: elements.length + 1,
          type: "CTRIA3",
          nodeIds: facet.map((corner) => corners[corner]),
          propertyId: 1,
        });
    }
  const constraints = [];
  const loads = [];
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= n; j++) {
      if (i === 0 || j === 0 || i === n || j === n)
        for (const dof of [0, 1, 2])
          constraints.push({ nodeId: id(i, j), dof });
      else loads.push({ nodeId: id(i, j), dof: 2, value: -1 });
    }
  return {
    nodes,
    elements,
    materials: [
      { id: 1, name: "Steel", young: 210000, poisson: 0.3, density: 1 },
    ],
    properties: [{ id: 1, materialId: 1, thickness: 2 }],
    constraints,
    loads,
  };
}

const PLATE_SETTINGS = {
  method: "simp",
  objective: "min_compliance",
  constraints: { volumeFraction: 0.4 },
  penalty: 3,
  filterRadius: 2.5 * (100 / 16),
  moveLimit: 0.2,
  maxIterations: 40,
  tolerance: 0.01,
};

// The C++ suite's coupled case as solve_coupled arguments: a 40×8×8 block
// (2×1×1 Kuhn-split cells) clamped at x = 0, a 20 deep shell wall on y = 4
// below it, its top row tied to the block by distributing couplings, its
// bottom row pulled along x.
function wallOnBlock() {
  const [L, W, H, Hw, t] = [40, 8, 8, 20, 1.5];
  const [nx, ny, nz, nzw] = [2, 1, 1, 2];
  const sid = (i, j, k) => (i * (ny + 1) + j) * (nz + 1) + k;
  const points = [];
  for (let i = 0; i <= nx; i++)
    for (let j = 0; j <= ny; j++)
      for (let k = 0; k <= nz; k++)
        points.push([(L * i) / nx, (W * j) / ny, (H * k) / nz]);
  const tets = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      for (let k = 0; k < nz; k++) {
        const [a, b, c, d] = [
          sid(i, j, k),
          sid(i + 1, j, k),
          sid(i + 1, j + 1, k),
          sid(i, j + 1, k),
        ];
        const [e, f, g, h] = [
          sid(i, j, k + 1),
          sid(i + 1, j, k + 1),
          sid(i + 1, j + 1, k + 1),
          sid(i, j + 1, k + 1),
        ];
        for (const tet of [
          [a, b, c, g],
          [a, c, d, g],
          [a, d, h, g],
          [a, h, e, g],
          [a, e, f, g],
          [a, f, b, g],
        ])
          tets.push(...tet);
      }
  const solidNodes = points.length;
  const wid = (i, k) => solidNodes + i * (nzw + 1) + k;
  for (let i = 0; i <= nx; i++)
    for (let k = 0; k <= nzw; k++)
      points.push([(L * i) / nx, W / 2, (-Hw * k) / nzw]);
  const triangles = [];
  for (let i = 0; i < nx; i++)
    for (let k = 0; k < nzw; k++) {
      const [a, b, c, d] = [
        wid(i, k),
        wid(i + 1, k),
        wid(i + 1, k + 1),
        wid(i, k + 1),
      ];
      triangles.push(a, b, c, a, c, d);
    }

  const radius = 1.3 * L;
  const ref = [];
  const offsets = [0];
  const solid = [];
  for (let i = 0; i <= nx; i++) {
    const reference = wid(i, 0);
    const patch = [];
    for (let node = 0; node < solidNodes; node++) {
      const distance = [0, 1, 2].reduce(
        (sum, axis) =>
          sum + (points[node][axis] - points[reference][axis]) ** 2,
        0,
      );
      if (distance <= radius * radius) patch.push(node);
    }
    if (patch.length < 3) continue;
    ref.push(reference);
    solid.push(...patch);
    offsets.push(solid.length);
  }
  const fixed = [];
  for (let j = 0; j <= ny; j++)
    for (let k = 0; k <= nz; k++)
      for (const component of [0, 1, 2])
        fixed.push(6 * sid(0, j, k) + component);
  const loadDofs = [];
  for (let i = 0; i <= nx; i++) loadDofs.push(6 * wid(i, nzw));
  return {
    mesh: {
      vertices: Float64Array.from(points.flat()),
      tets: Int32Array.from(tets),
      triangles: Int32Array.from(triangles),
      thicknesses: new Float64Array(triangles.length / 3).fill(t),
    },
    coupling: {
      ref: Int32Array.from(ref),
      offsets: Int32Array.from(offsets),
      solid: Int32Array.from(solid),
      mpc: Int32Array.from(ref, () => 0),
      dof_mask: Int32Array.from(ref, () => 0),
      relaxation: 1,
    },
    bcs: {
      fixed_dofs: Int32Array.from(fixed),
      prescribed_dofs: new Int32Array(0),
      prescribed_vals: new Float64Array(0),
      load_dofs: Int32Array.from(loadDofs),
      load_vals: Float64Array.from(loadDofs, () => 30),
    },
    matJson: JSON.stringify({
      solid: { young_modulus: 210000, poisson_ratio: 0.3 },
      shell: { young_modulus: 70000, poisson_ratio: 0.33 },
    }),
  };
}

const WALL_SETTINGS = {
  method: "simp",
  objective: "min_compliance",
  constraints: { volumeFraction: 0.5 },
  penalty: 3,
  filterRadius: 25,
  moveLimit: 0.2,
  maxIterations: 30,
  tolerance: 0.01,
};

// Run one engine entry, keeping its log and stream.
async function inEngine(domain, args, settings) {
  const logs = [];
  const streamed = [];
  const engine = await loadEngine({
    solves: import.meta.url,
    print: (line) => logs.push(line),
  });
  const onDensity = (iteration, density) =>
    streamed.push({ iteration, density: Array.from(density) });
  const json = JSON.stringify(settings);
  const result =
    domain === "shell"
      ? engine.optimize_topology_shell(
          args.mesh,
          args.matJson,
          args.bcsJson,
          json,
          onDensity,
        )
      : engine.optimize_topology_coupled(
          args.mesh,
          args.coupling,
          args.bcs,
          args.matJson,
          json,
          onDensity,
        );
  if ("error" in result) throw new Error(result.error);
  return {
    density: Array.from(result.density),
    history: result.history.map((entry) => ({ ...entry })),
    logs,
    streamed,
  };
}

function inRust(domain, args, settings) {
  const logs = [];
  const streamed = [];
  const optimize =
    domain === "shell" ? optimizeShellInRust : optimizeCoupledInRust;
  const result = optimize(
    fem,
    args,
    settings,
    (line) => logs.push(line),
    (iteration, density) =>
      streamed.push({ iteration, density: Array.from(density) }),
  );
  return { ...result, logs, streamed };
}

// Largest relative compliance and absolute volume difference over the
// histories, and the largest absolute density difference.
function compare(rust, engine) {
  let compliance = 0;
  let volume = 0;
  for (const [index, rhs] of engine.history.entries()) {
    const lhs = rust.history[index];
    compliance = Math.max(
      compliance,
      Math.abs(lhs.compliance - rhs.compliance) / Math.abs(rhs.compliance),
    );
    volume = Math.max(volume, Math.abs(lhs.volume - rhs.volume));
  }
  let density = 0;
  for (const [index, rho] of engine.density.entries())
    density = Math.max(density, Math.abs(rust.density[index] - rho));
  return { compliance, volume, density };
}

// Both solve to a 1e-5 relative force residual with IC(0) CG, the engine's
// setting for these domains. Measured: the plate's histories agree to 1e-11.
function expectSameRun(rust, engine) {
  expect(rust.history.length).toBe(engine.history.length);
  const difference = compare(rust, engine);
  expect(difference.compliance).toBeLessThan(1e-5);
  expect(difference.volume).toBeLessThan(1e-5);
  expect(difference.density).toBeLessThan(1e-5);
}

describe("shell topology optimization: Rust against the C++ engine", () => {
  const plate = () => buildShellEngineInputs(plateModel(16));

  test("the pressure-loaded plate gives the engine's history and design", async () => {
    const engine = await inEngine("shell", plate(), PLATE_SETTINGS);
    const rust = inRust("shell", plate(), PLATE_SETTINGS);
    expectSameRun(rust, engine);
    expect(rust.history.at(-1).compliance).toBeLessThan(
      rust.history[0].compliance,
    );
  });

  test("min_volume at the min_compliance optimum matches", async () => {
    // The limit is part of the stored C++ call's inputs, so it stays the
    // value it was recorded with: the min-compliance optimum's compliance as
    // the Rust solve gave it then. A later element may reach the same optimum
    // in different last bits (KOF-453), which would leave the stored call
    // unmatched, so the optimum is checked against it instead.
    const reference = inRust("shell", plate(), PLATE_SETTINGS);
    const complianceLimit = 58.42887254130326;
    expect(
      Math.abs(reference.history.at(-1).compliance - complianceLimit) /
        complianceLimit,
    ).toBeLessThan(1e-5);
    const settings = {
      ...PLATE_SETTINGS,
      objective: "min_volume",
      constraints: { complianceLimit },
      maxIterations: 60,
      passive: { solid: [0, 1, 2, 3], void: [300] },
    };
    const engine = await inEngine("shell", plate(), settings);
    const rust = inRust("shell", plate(), settings);
    expectSameRun(rust, engine);
    expect(rust.density.slice(0, 4).every((rho) => rho === 1)).toBe(true);
    expect(rust.density[300]).toBe(0);
    expect(rust.history[0].objective).toBe(rust.history[0].volume);
  });

  test("streams the engine's designs on its cadence, and logs lines the progress plot parses", async () => {
    const settings = { ...PLATE_SETTINGS, maxIterations: 7, streamEvery: 3 };
    const engine = await inEngine("shell", plate(), settings);
    const rust = inRust("shell", plate(), settings);
    expect(rust.streamed.map(({ iteration }) => iteration)).toEqual([3, 6, 7]);
    expect(engine.streamed.map(({ iteration }) => iteration)).toEqual([
      3, 6, 7,
    ]);
    for (const [index, { density }] of rust.streamed.entries()) {
      const reference = engine.streamed[index].density;
      const largest = Math.max(
        ...density.map((rho, element) => Math.abs(rho - reference[element])),
      );
      expect(largest).toBeLessThan(1e-6);
    }
    const points = rust.logs
      .map((line) => parseTopOptLogLine(line))
      .filter((point) => point !== null);
    expect(points.map((point) => point.it)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rust.logs[0]).toContain("[topopt] shell min_compliance");
    expect(rust.logs.at(-1)).toContain("[topopt] complete: 7 iteration(s)");
  });

  test("refuses a stress limit, as the engine does", async () => {
    const settings = {
      ...PLATE_SETTINGS,
      constraints: { volumeFraction: 0.4, maxStress: 100 },
    };
    expect(() => inRust("shell", plate(), settings)).toThrow(
      "all-solid models only",
    );
    await expect(inEngine("shell", plate(), settings)).rejects.toThrow(
      "all-solid models only",
    );
  });
});

// The wall hangs from the block on distributing couplings whose reference
// nodes sit up to 20 mm from their patches' centroids. The C++ engine measured
// the patch motion at the centroid, not at the reference node (KOF-410), so
// its stored runs of this model are no reference: the wall's run is checked
// for what an optimum must satisfy instead, and the two objectives against
// each other.
describe("coupled topology optimization: the wall on a block", () => {
  test("min_compliance meets its volume and lowers the compliance", () => {
    const rust = inRust("coupled", wallOnBlock(), WALL_SETTINGS);
    expect(rust.density).toHaveLength(12 + 8);
    expect(rust.logs[0]).toContain("12 tets + 8 facets");
    expect(rust.logs.at(-1)).toContain("converged");
    const [first, last] = [rust.history[0], rust.history.at(-1)];
    expect(last.compliance).toBeLessThan(first.compliance);
    expect(Math.abs(last.volume - 0.5)).toBeLessThan(1e-3);
    for (const rho of rust.density) {
      expect(rho).toBeGreaterThan(0);
      expect(rho).toBeLessThanOrEqual(1);
    }
  });

  test("min_volume at the min_compliance optimum returns to its volume", () => {
    const reference = inRust("coupled", wallOnBlock(), WALL_SETTINGS);
    const limit = reference.history.at(-1).compliance;
    const settings = {
      ...WALL_SETTINGS,
      objective: "min_volume",
      constraints: { complianceLimit: limit },
    };
    const rust = inRust("coupled", wallOnBlock(), settings);
    expect(rust.logs.at(-1)).toContain("converged");
    const last = rust.history.at(-1);
    expect(last.compliance).toBeLessThanOrEqual(
      limit * (1 + WALL_SETTINGS.tolerance),
    );
    expect(Math.abs(last.volume - 0.5)).toBeLessThan(WALL_SETTINGS.tolerance);
  });

  test("refuses a prescribed displacement, as the engine does", async () => {
    const args = wallOnBlock();
    args.bcs.prescribed_dofs = Int32Array.from([6 * 20]);
    args.bcs.prescribed_vals = Float64Array.from([0.1]);
    expect(() => inRust("coupled", args, WALL_SETTINGS)).toThrow(
      "does not support prescribed (non-zero) displacements",
    );
    await expect(inEngine("coupled", args, WALL_SETTINGS)).rejects.toThrow(
      "does not support prescribed (non-zero) displacements",
    );
  });
});

// Topology optimization takes per-body materials (KOF-415): every facet and
// tet is assembled with its own body's material. Each case compares the
// first-iteration compliance: two bodies of one material must give the
// one-body run, and a 4× stiffer second body must lower the compliance, but
// less than a 4× stiffer whole model (C/4).
describe("shell and coupled topology optimization keep each body's material", () => {
  const firstCompliance = (domain, args, settings) =>
    inRust(domain, args, { ...settings, maxIterations: 1 }).history[0]
      .compliance;
  const expectBetween = (mixed, unit) => {
    expect(mixed).toBeLessThan(unit * 0.99);
    expect(mixed).toBeGreaterThan((unit / 4) * 1.01);
  };

  // The plate with its facets in x > 50 on a second body of `young`, built
  // through buildShellEngineInputs as the worker builds it.
  function twoBodyPlate(young) {
    const model = plateModel(16);
    const byId = new Map(model.nodes.map((node) => [node.id, node]));
    const rightHalf = (element) =>
      element.nodeIds.reduce((sum, id) => sum + byId.get(id).x, 0) / 3 > 50;
    return buildShellEngineInputs({
      ...model,
      materials: [
        ...model.materials,
        { id: 2, name: "Second", young, poisson: 0.3, density: 1 },
      ],
      properties: [...model.properties, { id: 2, materialId: 2, thickness: 2 }],
      elements: model.elements.map((element) =>
        rightHalf(element) ? { ...element, propertyId: 2 } : element,
      ),
    });
  }

  test("shell: two bodies of one material give the one-body run", () => {
    const one = firstCompliance(
      "shell",
      buildShellEngineInputs(plateModel(16)),
      PLATE_SETTINGS,
    );
    expect(firstCompliance("shell", twoBodyPlate(210000), PLATE_SETTINGS)).toBe(
      one,
    );
  });

  test("shell: a stiffer second body lowers the compliance, but less than a stiffer whole plate", () => {
    const unit = firstCompliance(
      "shell",
      buildShellEngineInputs(plateModel(16)),
      PLATE_SETTINGS,
    );
    expectBetween(
      firstCompliance("shell", twoBodyPlate(4 * 210000), PLATE_SETTINGS),
      unit,
    );
  });

  // The wall on the block with the second half of the tets or of the facets
  // on a second material of `young`, selected by 1-based attributes as
  // mixedCoupledMaterials passes several materials per domain.
  function twoMaterialWall(domain, young) {
    const args = wallOnBlock();
    const { solid, shell } = JSON.parse(args.matJson);
    const base = domain === "solid" ? solid : shell;
    const count =
      domain === "solid"
        ? args.mesh.tets.length / 4
        : args.mesh.triangles.length / 3;
    const attributes = Int32Array.from({ length: count }, (_, index) =>
      index < count / 2 ? 1 : 2,
    );
    const pair = [base, { ...base, young_modulus: young }];
    return {
      ...args,
      mesh: {
        ...args.mesh,
        ...(domain === "solid"
          ? { attributes }
          : { shell_attributes: attributes }),
      },
      matJson: JSON.stringify(
        domain === "solid" ? { solid: pair, shell } : { solid, shell: pair },
      ),
    };
  }

  for (const [domain, young] of [
    ["solid", 210000],
    ["shell", 70000],
  ]) {
    test(`coupled ${domain} domain: two materials of the same stiffness give the one-material run`, () => {
      const one = firstCompliance("coupled", wallOnBlock(), WALL_SETTINGS);
      expect(
        firstCompliance(
          "coupled",
          twoMaterialWall(domain, young),
          WALL_SETTINGS,
        ),
      ).toBe(one);
    });

    test(`coupled ${domain} domain: a stiffer second material lowers the compliance, but less than a stiffer whole model`, () => {
      const unit = firstCompliance("coupled", wallOnBlock(), WALL_SETTINGS);
      expectBetween(
        firstCompliance(
          "coupled",
          twoMaterialWall(domain, 4 * young),
          WALL_SETTINGS,
        ),
        unit,
      );
    });
  }
});

// KOF-412: a run that stops at its iteration cap says so.
describe("shell and coupled topology optimization report whether they converged", () => {
  test("a shell run capped before it settles is not converged", () => {
    const rust = inRust("shell", buildShellEngineInputs(plateModel(16)), {
      ...PLATE_SETTINGS,
      maxIterations: 3,
    });
    expect(rust.converged).toBe(false);
    expect(rust.iterations).toBe(3);
  });

  test("a coupled run capped before it settles is not converged", () => {
    const rust = inRust("coupled", wallOnBlock(), {
      ...WALL_SETTINGS,
      maxIterations: 2,
    });
    expect(rust.converged).toBe(false);
    expect(rust.iterations).toBe(2);
  });
});

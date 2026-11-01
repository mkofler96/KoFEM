// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for the per-path solve payload builders (src/lib/solve/*). They
// run without a worker or the WASM engine: each builder is checked on the
// payload it hands the engine, and the router on the path it picks.

import { test, expect } from "@playwright/test";
import type {
  Constraint,
  Element,
  Material,
  Node,
  Property,
  SolvePayload,
  TopOptPayload,
} from "../src/workers/solverTypes";
import {
  coupledFixedDofs,
  coupledToShellDirichlet,
  coupledToShellPointLoads,
  shellDirichlet,
  surfaceLoadsToVertices,
} from "../src/lib/solve/bcs";
import {
  maxFacetStressPerNode,
  buildNearestVertexLocator,
} from "../src/lib/solve/shellMapping";
import { buildShellEngineInputs } from "../src/lib/solve/shell";
import {
  buildSolidEngineInputs,
  expandTiedDisplacements,
  weldTies,
} from "../src/lib/solve/solid";
import {
  buildCoupledEngineInputs,
  mapMixedResult,
} from "../src/lib/solve/coupled";
import {
  routeSolve,
  routeTopOpt,
  topOptStartLog,
} from "../src/lib/solve/route";
import { buildVertexIndexer } from "../src/lib/solveMeshPacking";

const steel: Material = {
  id: 1,
  name: "Steel",
  young: 210000,
  poisson: 0.3,
  density: 7850,
};

// Node ids deliberately not 0-based, so every builder must remap them.
const quadNodes: Node[] = [
  { id: 11, x: 0, y: 0, z: 0 },
  { id: 12, x: 1, y: 0, z: 0 },
  { id: 13, x: 1, y: 1, z: 0 },
  { id: 14, x: 0, y: 1, z: 0 },
];
const shellElements: Element[] = [
  { id: 1, type: "CTRIA3", nodeIds: [11, 12, 13], propertyId: 5 },
  { id: 2, type: "CTRIA3", nodeIds: [11, 13, 14], propertyId: 5 },
];

function payload(over: Partial<SolvePayload>): SolvePayload {
  return {
    nodes: quadNodes,
    elements: shellElements,
    materials: [steel],
    properties: [{ id: 5, materialId: 1, thickness: 2 }],
    constraints: [],
    loads: [],
    ...over,
  };
}

test("shellDirichlet splits full clamps, partial fixes and driven DOFs", () => {
  const vid = buildVertexIndexer(quadNodes);
  const constraints: Constraint[] = [
    ...[0, 1, 2, 3, 4, 5].map((dof) => ({ nodeId: 11, dof })),
    { nodeId: 12, dof: 2 },
    { nodeId: 12, dof: 0 },
    { nodeId: 13, dof: 1, prescribedValue: 0.5 },
  ];
  expect(shellDirichlet(constraints, vid)).toEqual({
    fixed_vertices: [0],
    fixed_dofs: [{ vertex: 1, dofs: [0, 2] }],
    prescribed_dofs: [{ vertex: 2, dof: 1, value: 0.5 }],
  });
  expect(() => shellDirichlet([{ nodeId: 11, dof: 6 }], vid)).toThrow(
    /valid shell DOFs are 0\.\.5/,
  );
});

test("coupledFixedDofs clamps fully pinned shell nodes and refuses contradictions", () => {
  const poolOf = (nodeId: number) => nodeId - 11;
  const isShell = (pi: number) => pi === 0;
  const noRef = () => false;
  const pinned = [0, 1, 2].map((dof) => ({ nodeId: 11, dof }));
  expect(coupledFixedDofs(pinned, poolOf, isShell, noRef)).toEqual({
    fixed_dofs: [0, 1, 2, 3, 4, 5],
    prescribed_dofs: [],
    prescribed_vals: [],
  });
  // A solid node pinned in all translations is not given rotations.
  expect(
    coupledFixedDofs(
      [0, 1, 2].map((dof) => ({ nodeId: 12, dof })),
      poolOf,
      isShell,
      noRef,
    ).fixed_dofs,
  ).toEqual([6, 7, 8]);
  // Rotational clamps off a reference point are dropped; driven ones refused.
  expect(
    coupledFixedDofs([{ nodeId: 12, dof: 4 }], poolOf, isShell, noRef)
      .fixed_dofs,
  ).toEqual([]);
  expect(() =>
    coupledFixedDofs(
      [{ nodeId: 12, dof: 4, prescribedValue: 0.1 }],
      poolOf,
      isShell,
      noRef,
    ),
  ).toThrow(/prescribes a rotation/);
  expect(() =>
    coupledFixedDofs(
      [
        { nodeId: 12, dof: 0 },
        { nodeId: 12, dof: 0, prescribedValue: 1 },
      ],
      poolOf,
      isShell,
      noRef,
    ),
  ).toThrow(/fixed to 0 and also prescribed to 1/);
  expect(() =>
    coupledFixedDofs(
      [
        { nodeId: 12, dof: 0, prescribedValue: 1 },
        { nodeId: 12, dof: 0, prescribedValue: 2 },
      ],
      poolOf,
      isShell,
      noRef,
    ),
  ).toThrow(/two different displacements/);
});

test("coupled-form BCs and loads fold into the shell solver's form", () => {
  expect(
    coupledToShellDirichlet({
      fixed_dofs: [0, 1, 2, 3, 4, 5, 7, 6],
      prescribed_dofs: [14],
      prescribed_vals: [0.25],
    }),
  ).toEqual({
    fixed_vertices: [0],
    fixed_dofs: [{ vertex: 1, dofs: [0, 1] }],
    prescribed_dofs: [{ vertex: 2, dof: 2, value: 0.25 }],
  });
  expect(coupledToShellPointLoads([6, 8, 6, 9], [1, 2, 3, 99])).toEqual([
    { vertex: 1, force: [4, 0, 2] },
  ]);
});

test("surface-load faces are remapped to engine vertex indices", () => {
  const vid = buildVertexIndexer(quadNodes);
  expect(
    surfaceLoadsToVertices(
      [{ type: "pressure", pressure: 3, faces: [[14, 12, 11]] }],
      vid,
    ),
  ).toEqual([{ type: "pressure", pressure: 3, faces: [[3, 1, 0]] }]);
  expect(surfaceLoadsToVertices(undefined, vid)).toEqual([]);
});

test("shell mapping recovers the worst adjacent-facet stress per node", () => {
  expect([
    ...maxFacetStressPerNode([0, 1, 2, 0, 2, 3], [5, 7]).entries(),
  ]).toEqual([
    [0, 7],
    [1, 5],
    [2, 7],
    [3, 7],
  ]);
  const nearest = buildNearestVertexLocator([0, 0, 0, 10, 0, 0, 0, 10, 0]);
  expect(nearest([9, 1, 0])).toBe(1);
  expect(nearest([0.2, 8, 0])).toBe(2);
});

test("shell builder packs remapped facets, thickness, material and BCs", () => {
  const inp = buildShellEngineInputs(
    payload({
      constraints: [0, 1, 2, 3, 4, 5].map((dof) => ({ nodeId: 11, dof })),
      loads: [{ nodeId: 13, dof: 2, value: -10 }],
    }),
  );
  expect([...inp.mesh.triangles]).toEqual([0, 1, 2, 0, 2, 3]);
  expect([...inp.mesh.thicknesses]).toEqual([2, 2]);
  expect(JSON.parse(inp.matJson)).toEqual({
    young_modulus: 210000,
    poisson_ratio: 0.3,
  });
  expect(JSON.parse(inp.bcsJson)).toEqual({
    fixed_vertices: [0],
    fixed_dofs: [],
    prescribed_dofs: [],
    point_loads: [{ vertex: 2, force: [0, 0, -10] }],
  });
  expect(() =>
    buildShellEngineInputs(payload({ properties: [{ id: 5, materialId: 1 }] })),
  ).toThrow(/no positive shell thickness/);
});

// Two tets sharing no nodes, one per body, with a coincident face pair at x = 1.
const tetNodes: Node[] = [
  { id: 1, x: 0, y: 0, z: 0 },
  { id: 2, x: 1, y: 0, z: 0 },
  { id: 3, x: 1, y: 1, z: 0 },
  { id: 4, x: 1, y: 0, z: 1 },
  { id: 5, x: 1, y: 0, z: 0 },
  { id: 6, x: 1, y: 1, z: 0 },
  { id: 7, x: 1, y: 0, z: 1 },
  { id: 8, x: 2, y: 0, z: 0 },
];
const tetElements: Element[] = [
  { id: 1, type: "CTETRA", nodeIds: [1, 2, 3, 4], propertyId: 1 },
  { id: 2, type: "CTETRA", nodeIds: [5, 6, 7, 8], propertyId: 2 },
];
const twoBodies: Property[] = [
  { id: 1, materialId: 1 },
  { id: 2, materialId: 1 },
];

test("solid builder welds tie connections and maps BCs through them", () => {
  const logs: string[] = [];
  const tied = weldTies(
    tetNodes,
    tetElements,
    [
      {
        name: "seam",
        facesA: [{ nodeIds: [2, 3, 4] }],
        facesB: [{ nodeIds: [5, 6, 7] }],
        extent: "region",
        searchDistance: 0.01,
      },
    ],
    (line) => logs.push(line),
  );
  expect(tied.solveNodes.length).toBe(5);
  expect(logs.join("\n")).toMatch(/Tie "seam": welded 3 node pair/);

  const inp = buildSolidEngineInputs(
    {
      nodes: tied.solveNodes,
      elements: tied.tiedElements,
      materials: [steel],
      properties: twoBodies,
      constraints: [{ nodeId: 5, dof: 0 }],
      loads: [{ nodeId: 8, dof: 0, value: 1 }],
    },
    tied.vid,
    tied.vidTied,
  );
  expect(inp.elementCount).toBe(2);
  // Both tets reference the welded seam vertices.
  const tets = [...inp.mesh.tetrahedra];
  expect(tets.slice(1, 4)).toEqual(tets.slice(4, 7));
  // Node 5 was merged into node 2: its constraint lands on node 2's vertex.
  const bcs = JSON.parse(inp.bcsJson);
  expect(JSON.stringify(bcs)).toContain(`${tets[1]}`);

  const solveDisp = Float64Array.from(
    { length: 3 * tied.solveNodes.length },
    (_, i) => i,
  );
  const expanded = expandTiedDisplacements(tetNodes, tied, solveDisp);
  expect(expanded.length).toBe(3 * tetNodes.length);
  // Merged-away nodes take their representative's displacement.
  expect([...expanded.slice(12, 15)]).toEqual([...expanded.slice(3, 6)]);
});

test("a tie that joins nothing is refused", () => {
  expect(() =>
    weldTies(
      tetNodes,
      tetElements,
      [
        {
          name: "far",
          facesA: [{ nodeIds: [1] }],
          facesB: [{ nodeIds: [8] }],
          extent: "region",
          searchDistance: 0.01,
        },
      ],
      () => undefined,
    ),
  ).toThrow(/Tie "far" connected no nodes/);
});

test("mixed result mapping follows element type order", () => {
  const mixed = mapMixedResult(
    {
      nodes: quadNodes,
      elements: [shellElements[0], tetElements[0], shellElements[1]],
    },
    {
      poolOfVertex: new Map([
        [0, 1],
        [2, 0],
      ]),
    } as unknown as Parameters<typeof mapMixedResult>[1],
    {
      displacements: Float64Array.from([1, 2, 3, 4, 5, 6]),
      von_mises_tets: Float64Array.from([100]),
      von_mises_tris: Float64Array.from([10, 20]),
    },
  );
  expect([...mixed.vonMises]).toEqual([10, 100, 20]);
  expect([...mixed.displacements]).toEqual([
    4, 5, 6, 0, 0, 0, 1, 2, 3, 0, 0, 0,
  ]);
});

test("coupled builder refuses non-tet solids and models with no solid", () => {
  expect(() =>
    buildCoupledEngineInputs(
      payload({
        elements: [
          ...shellElements,
          { id: 3, type: "CHEXA", nodeIds: [], propertyId: 5 },
        ],
      }),
      () => undefined,
    ),
  ).toThrow(/supports CTETRA solids only/);
  expect(() => buildCoupledEngineInputs(payload({}), () => undefined)).toThrow(
    /no solid \(CTETRA\) elements/,
  );
});

test("solve routing follows the element mix, couplings and Shell choice", () => {
  const coupling = {
    name: "c",
    kind: "kinematic",
    referencePoint: 99,
    nodes: [11],
  } as unknown as NonNullable<SolvePayload["couplings"]>[number];
  expect(routeSolve(payload({}))).toEqual({ path: "shell" });
  expect(() => routeSolve(payload({ couplings: [coupling] }))).toThrow(
    /all shell elements and declares 1/,
  );
  expect(
    routeSolve(payload({ elements: [...shellElements, tetElements[0]] })),
  ).toEqual({ path: "coupled" });
  const solid = payload({
    nodes: tetNodes,
    elements: tetElements,
    properties: twoBodies,
  });
  expect(routeSolve(solid)).toEqual({ path: "solid" });
  expect(routeSolve({ ...solid, couplings: [coupling] })).toEqual({
    path: "coupled",
  });
  expect(
    routeSolve({
      ...solid,
      properties: [
        { id: 1, materialId: 1, discretization: "shell" },
        twoBodies[1],
      ],
    }),
  ).toEqual({ path: "auto-shell", shellBodyIds: new Set([1]) });
  expect(() =>
    routeSolve({
      ...solid,
      properties: twoBodies.map((p) => ({ ...p, discretization: "shell" })),
    }),
  ).toThrow(/are all marked "Shell"/);
});

test("topology optimization routing refuses models it would optimize wrongly", () => {
  const settings: TopOptPayload["settings"] = {
    objective: "min_compliance",
    constraints: { volumeFraction: 0.4 },
    filterRadius: 1,
    maxIterations: 20,
    tolerance: 0.01,
  };
  const solid: TopOptPayload = {
    nodes: tetNodes,
    elements: tetElements,
    materials: [steel],
    properties: twoBodies,
    constraints: [],
    loads: [],
    settings,
  };
  expect(routeTopOpt(solid)).toBe("solid");
  expect(routeTopOpt({ ...solid, ...payload({}), settings })).toBe("shell");
  expect(
    routeTopOpt({
      ...solid,
      elements: [...tetElements, shellElements[0]],
    }),
  ).toBe("coupled");
  expect(() =>
    routeTopOpt({
      ...solid,
      properties: [{ id: 1, materialId: 1, discretization: "shell" }],
    }),
  ).toThrow(/were not idealised into shell elements/);
  expect(() =>
    routeTopOpt({
      ...solid,
      elements: [...tetElements, shellElements[0]],
      settings: { ...settings, method: "level_set" },
    }),
  ).toThrow(/level-set method supports solid models only/);
  expect(topOptStartLog(solid, 2, "solid")).toBe(
    "Starting solid topology optimization: 8 nodes, 2 elements (min_compliance, volume fraction 0.4, max 20 iterations)…",
  );
});

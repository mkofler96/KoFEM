// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// No load leaves the solve smaller than the user entered without an error
// (KOF-411). A surface load whose faces miss the mesh, a load group none of
// whose selections spans a face, and a nodal moment on a node without
// rotations were each dropped or concentrated without a word; every solve
// path now refuses them by name, or applies them where the node can take
// them.

import { expect, test } from "bun:test";
import type {
  Element,
  Load,
  Material,
  Node,
  Property,
  SolveModel,
  SurfaceLoad,
  TopOptPayload,
} from "../../src/workers/solverTypes";
import { routeSolve, routeTopOpt } from "../../src/lib/solve/route";
import {
  coupledLoads,
  coupledToShellPointLoads,
} from "../../src/lib/solve/bcs";
import { buildVertexIndexer } from "../../src/lib/solveMeshPacking";
import { rebuildSurfaceLoads } from "../../src/store/boundaryRebuild";
import type { NamedLoadGroup } from "../../src/store/boundaryGroups";

const steel: Material = {
  id: 1,
  name: "Steel",
  young: 210000,
  poisson: 0.3,
  density: 7850,
};

// A unit cube of six tetrahedra (Kuhn split around the 0–7 diagonal), node
// ids 50 + corner bits. Its boundary is 12 triangles; 6 more faces lie
// inside, each shared by two tets.
const cubeNodes: Node[] = [0, 1, 2, 3, 4, 5, 6, 7].map((bits) => ({
  id: 50 + bits,
  x: bits & 1,
  y: (bits >> 1) & 1,
  z: (bits >> 2) & 1,
}));
const kuhn = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
];
const cubeTets: Element[] = kuhn.map((tet, index) => ({
  id: index + 1,
  type: "CTETRA",
  nodeIds: tet.map((corner) => 50 + corner),
  propertyId: 1,
}));
const at = (...corners: number[]) => corners.map((corner) => 50 + corner);
// The two boundary triangles of the top face (z = 1), and a face inside the
// cube, shared by the first two tets.
const topFaces = [at(4, 5, 7), at(4, 6, 7)];
const interiorFace = at(0, 3, 7);

// A second body beside the cube, so a body can be marked Shell.
const sideNodes: Node[] = [
  { id: 70, x: 2, y: 0, z: 0 },
  { id: 71, x: 3, y: 0, z: 0 },
  { id: 72, x: 2, y: 1, z: 0 },
  { id: 73, x: 2, y: 0, z: 1 },
];
const sideTet: Element = {
  id: 7,
  type: "CTETRA",
  nodeIds: [70, 71, 72, 73],
  propertyId: 2,
};
// A shell facet on the cube's top, for the mixed shell/solid models.
const topShell: Element = {
  id: 8,
  type: "CTRIA3",
  nodeIds: at(4, 5, 7),
  propertyId: 3,
};
const properties: Property[] = [
  { id: 1, materialId: 1 },
  { id: 2, materialId: 1 },
  { id: 3, materialId: 1, thickness: 0.1 },
];

function solid(surfaceLoads: SurfaceLoad[]): SolveModel {
  return {
    nodes: [...cubeNodes, ...sideNodes],
    elements: [...cubeTets, sideTet],
    materials: [steel],
    properties,
    constraints: [],
    loads: [],
    surfaceLoads,
  };
}

// The same surface load on every route the static solve takes.
function everyRoute(surfaceLoads: SurfaceLoad[]): [string, SolveModel][] {
  const base = solid(surfaceLoads);
  const coupling = {
    name: "c",
    kind: "kinematic",
    referencePoint: 99,
    nodes: at(4, 5, 6, 7),
  } as unknown as NonNullable<SolveModel["couplings"]>[number];
  return [
    ["solid", base],
    [
      "coupled (shell + solid)",
      { ...base, elements: [...base.elements, topShell] },
    ],
    [
      "coupled (solid + coupling)",
      {
        ...base,
        nodes: [...base.nodes, { id: 99, x: 0.5, y: 0.5, z: 2 }],
        couplings: [coupling],
      },
    ],
    [
      "auto-shell",
      {
        ...base,
        properties: [
          properties[0],
          { ...properties[1], discretization: "shell" },
          properties[2],
        ],
      },
    ],
  ];
}

const topOptSettings: TopOptPayload["settings"] = {
  objective: "min_compliance",
  constraints: { volumeFraction: 0.4 },
  filterRadius: 1,
  maxIterations: 20,
  tolerance: 0.01,
};

test("every solve route refuses a surface load with faces off the mesh boundary, naming it", () => {
  const load: SurfaceLoad = {
    type: "force",
    force: [0, 0, -1000],
    faces: [...topFaces, interiorFace],
    name: "Top",
  };
  for (const [route, model] of everyRoute([load]))
    expect(() => routeSolve(model), route).toThrow(
      /Load "Top": 1 of its 3 faces is not on the mesh boundary/,
    );
});

test("topology optimization refuses a surface load with faces off the mesh boundary in every domain", () => {
  const load: SurfaceLoad = {
    type: "pressure",
    pressure: 2,
    faces: [...topFaces, interiorFace, at(1, 2, 4)],
    name: "Lid",
  };
  const base = { ...solid([load]), settings: topOptSettings };
  expect(() => routeTopOpt(base), "solid").toThrow(
    /Load "Lid": 2 of its 4 faces are not on the mesh boundary/,
  );
  expect(
    () => routeTopOpt({ ...base, elements: [...base.elements, topShell] }),
    "coupled",
  ).toThrow(/Load "Lid": 2 of its 4 faces are not on the mesh boundary/);
});

test("a shell model refuses a surface load on a facet that is not in the mesh", () => {
  const quadNodes: Node[] = [
    { id: 11, x: 0, y: 0, z: 0 },
    { id: 12, x: 1, y: 0, z: 0 },
    { id: 13, x: 1, y: 1, z: 0 },
    { id: 14, x: 0, y: 1, z: 0 },
  ];
  const facets: Element[] = [
    { id: 1, type: "CTRIA3", nodeIds: [11, 12, 13], propertyId: 3 },
    { id: 2, type: "CTRIA3", nodeIds: [11, 13, 14], propertyId: 3 },
  ];
  const model: SolveModel = {
    nodes: quadNodes,
    elements: facets,
    materials: [steel],
    properties,
    constraints: [],
    loads: [],
    surfaceLoads: [
      // [12, 14] is a diagonal no facet has as an edge, [11, 12, 14] no facet.
      {
        type: "force",
        force: [0, 0, 1],
        faces: [
          [11, 12],
          [12, 14],
        ],
        name: "Rim",
      },
      { type: "pressure", pressure: 1, faces: [[11, 12, 14]], name: "Skin" },
    ],
  };
  expect(() => routeSolve(model)).toThrow(
    /Load "Rim": 1 of its 2 faces is not on the mesh/,
  );
  expect(() => routeTopOpt({ ...model, settings: topOptSettings })).toThrow(
    /Load "Rim": 1 of its 2 faces is not on the mesh/,
  );
  expect(() =>
    routeSolve({ ...model, surfaceLoads: model.surfaceLoads?.slice(1) }),
  ).toThrow(/Load "Skin": 1 of its 1 faces is not on the mesh/);
  // Both facets and an edge of one are loadable.
  expect(
    routeSolve({
      ...model,
      surfaceLoads: [
        { type: "force", force: [0, 0, 1], faces: [[11, 12]], name: "Rim" },
        { type: "pressure", pressure: 1, faces: [[13, 12, 11]], name: "Skin" },
      ],
    }),
  ).toEqual({ path: "shell" });
});

test("a surface load on boundary faces still routes", () => {
  const load: SurfaceLoad = {
    type: "force",
    force: [0, 0, -1000],
    faces: topFaces,
    name: "Top",
  };
  expect(routeSolve(solid([load]))).toEqual({ path: "solid" });
});

const group = (faces: NamedLoadGroup["faces"]): NamedLoadGroup => ({
  id: 1,
  name: "Top",
  dof: 2,
  totalForce: -1000,
  components: [0, 0, -1000],
  kind: "force",
  faces,
});
const face = (id: number, nodeIds: number[]) => ({
  id,
  label: `Face ${id}`,
  nodeIds,
});

test("a load group keeps only the boundary faces of its selection", () => {
  // The whole cube's nodes span all 18 distinct tet faces; 6 of them are
  // inside the cube and would carry nothing in the solid solve, but force on
  // the coupled one.
  const [load] = rebuildSurfaceLoads(
    [group([face(1, at(0, 1, 2, 3, 4, 5, 6, 7))])],
    cubeTets,
  );
  expect(load.faces).toHaveLength(12);
  expect(load.name).toBe("Top");
  expect(load.unmatchedSelections).toBe(0);
});

test("a load group whose selections span no face is kept, and the solve refuses it", () => {
  // A cube edge spans no face of a solid, and a stale pick names nodes the
  // mesh no longer has.
  const loads = rebuildSurfaceLoads(
    [group([face(1, at(0, 1)), face(2, [900, 901, 902])])],
    cubeTets,
  );
  expect(loads).toEqual([
    {
      type: "force",
      force: [0, 0, -1000],
      faces: [],
      name: "Top",
      unmatchedSelections: 2,
    },
  ]);
  for (const [route, model] of everyRoute(loads))
    expect(() => routeSolve(model), route).toThrow(
      /Load "Top": 2 of its selections match no face of the current mesh, so it would apply no load at all/,
    );
  expect(() =>
    routeTopOpt({ ...solid(loads), settings: topOptSettings }),
  ).toThrow(/Load "Top": 2 of its selections match no face/);
});

test("a load group with one stale selection is refused, not concentrated on the rest", () => {
  const loads = rebuildSurfaceLoads(
    [group([face(1, at(4, 5, 6, 7)), face(2, [900, 901, 902])])],
    cubeTets,
  );
  expect(loads[0].faces).toHaveLength(2);
  expect(loads[0].unmatchedSelections).toBe(1);
  expect(() => routeSolve(solid(loads))).toThrow(
    /Load "Top": 1 of its selections matches no face of the current mesh, so its total would act on the other selections alone/,
  );
});

test("a pressure group with no matching face is kept for the solve to refuse", () => {
  const loads = rebuildSurfaceLoads(
    [{ ...group([face(1, at(0, 1))]), kind: "pressure", totalForce: 3 }],
    cubeTets,
  );
  expect(loads).toEqual([
    {
      type: "pressure",
      pressure: 3,
      faces: [],
      name: "Top",
      unmatchedSelections: 1,
    },
  ]);
});

// The nodal moment cases: coupledLoads takes 6·pool+dof loads, and a node
// either carries rotations (a shell node, a coupling reference point) or not
// (a solid node).
const moment: Load[] = [{ nodeId: 51, dof: 3, value: 5 }];
const cubeVid = buildVertexIndexer(cubeNodes);
const poolOf = (nodeId: number) => cubeVid(nodeId, "test");

test("a nodal moment on a node with rotations is applied", () => {
  expect(
    coupledLoads(moment, undefined, poolOf, () => true, cubeNodes, cubeVid),
  ).toEqual({ load_dofs: [6 * 1 + 3], load_vals: [5] });
});

test("a nodal moment on a node without rotations is refused, not dropped", () => {
  expect(() =>
    coupledLoads(moment, undefined, poolOf, () => false, cubeNodes, cubeVid),
  ).toThrow(/Node 51 carries a moment \(DOF 3 = 5\).*no rotational DOF/);
  // A zero moment restrains nothing and is ignored, as on the solid path.
  expect(
    coupledLoads(
      [{ nodeId: 51, dof: 4, value: 0 }],
      undefined,
      poolOf,
      () => false,
      cubeNodes,
      cubeVid,
    ),
  ).toEqual({ load_dofs: [], load_vals: [] });
});

test("the pure auto-shell path keeps nodal moments when it folds loads into the shell form", () => {
  expect(coupledToShellPointLoads([6, 8, 9, 13, 17], [1, 2, 7, 3, 4])).toEqual([
    { vertex: 1, force: [1, 0, 2], moment: [7, 0, 0] },
    { vertex: 2, force: [0, 3, 0], moment: [0, 0, 4] },
  ]);
});

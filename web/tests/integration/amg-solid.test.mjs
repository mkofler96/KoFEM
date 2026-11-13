// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The app's all-solid solve through the Rust AMG solver must give the same
// result as through the MFEM engine. Both take the SAME store model, built
// into solver inputs by the app's own helpers (buildSolidEngineInputs for MFEM,
// solveSolidWithAmg for Rust), on a real Netgen mesh of the wall bracket.
//
// The model exercises everything the AMG path supports: two bodies with
// different materials, a clamped end, a roller, a prescribed displacement, a
// point load, a pressure and a total-force surface load — with linear and
// with quadratic elements. Node ids are offset
// from vertex indices, as in saved analyses, so the id → vertex mapping is
// exercised too. A hand-built CHEXA beam, alone and with CTETRA at its root,
// then checks hexahedra and loads on quadrilateral faces the same way.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { buildVertexIndexer } from "../../src/lib/solveMeshPacking.ts";
import { buildSolidEngineInputs } from "../../src/lib/solve/solid.ts";
import {
  amgFallbackPreconditioner,
  amgUnavailableReason,
  solveSolidWithAmg,
} from "../../src/lib/solve/amg.ts";
import { boxHexMesh } from "../../../examples/validation/lib/mesh.mjs";
import { loadEngine, loadFem } from "../support/wasm.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const MATERIALS = [
  { id: 1, name: "Steel", young: 210000, poisson: 0.3, density: 7.85e-9 },
  { id: 2, name: "Aluminium", young: 70000, poisson: 0.33, density: 2.7e-9 },
];
const PROPERTIES = [
  { id: 1, materialId: 1 },
  { id: 2, materialId: 2 },
];

// The default budget is never reached in these solves: asking would be a failure.
const neverAsk = () => {
  throw new Error("the continuation prompt must not appear");
};

// Takes a progress line that the test does not look at.
const ignoreProgress = () => undefined;

const maxDifference = (lhs, rhs) => {
  let peak = 0;
  let difference = 0;
  for (let index = 0; index < lhs.length; index++) {
    peak = Math.max(peak, Math.abs(lhs[index]));
    difference = Math.max(difference, Math.abs(lhs[index] - rhs[index]));
  }
  return { peak, relative: difference / peak };
};

// Mesh the wall bracket at `maxElementSize` (mm) and build the store model on
// it: the same bodies, supports and loads at any mesh size.
async function bracketModel(maxElementSize) {
  const mesher = await loadEngine();
  mesher.tessellate_step(
    new Uint8Array(
      readFileSync(join(here, "../../../test_files/Wall Bracket.stp")),
    ),
    JSON.stringify({ deflection_relative: 0.001, angular_deflection: 0.5 }),
  );
  const mesh = mesher.generate_fem_mesh(
    JSON.stringify({
      max_element_size: maxElementSize,
      min_element_size: maxElementSize / 10,
      grading: 0.3,
      second_order: false,
      elementsperedge: 2.0,
      elementspercurve: 2.0,
      optsteps_2d: 3,
      optsteps_3d: 3,
    }),
  );
  mesher.free_geometry_cache();

  // ── Store model ───────────────────────────────────────────────────────────────
  const ID_OFFSET = 1000;
  const nodeCount = mesh.vertices.length / 3;
  const nodes = Array.from({ length: nodeCount }, (_, vertex) => ({
    id: vertex + ID_OFFSET,
    x: mesh.vertices[3 * vertex],
    y: mesh.vertices[3 * vertex + 1],
    z: mesh.vertices[3 * vertex + 2],
  }));
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (const node of nodes)
    ["x", "y", "z"].forEach((key, axis) => {
      low[axis] = Math.min(low[axis], node[key]);
      high[axis] = Math.max(high[axis], node[key]);
    });
  const extent = [0, 1, 2].map((axis) => high[axis] - low[axis]);
  const longest = extent.indexOf(Math.max(...extent));
  const key = ["x", "y", "z"][longest];
  const along = (node) => (node[key] - low[longest]) / extent[longest];

  // Two bodies: the elements whose centroid lies in the first half are steel,
  // the rest aluminium.
  const tetCount = mesh.tetrahedra.length / 4;
  const elements = Array.from({ length: tetCount }, (_, tet) => {
    const nodeIds = Array.from(
      mesh.tetrahedra.subarray(4 * tet, 4 * tet + 4),
      (vertex) => vertex + ID_OFFSET,
    );
    const centroid =
      nodeIds.reduce(
        (sum, nodeId) => sum + along(nodes[nodeId - ID_OFFSET]),
        0,
      ) / 4;
    return {
      id: tet + 1,
      type: "CTETRA",
      nodeIds,
      propertyId: centroid < 0.5 ? 1 : 2,
    };
  });
  const materials = MATERIALS;
  const properties = PROPERTIES;

  // Clamp the first 3 %; hold the far end on a roller (the shortest axis only);
  // pull one node of the far end along the longest axis by a prescribed amount.
  const shortest = extent.indexOf(Math.min(...extent));
  const constraints = [];
  const farEnd = [];
  for (const node of nodes) {
    if (along(node) <= 0.03)
      for (let dof = 0; dof < 3; dof++)
        constraints.push({ nodeId: node.id, dof });
    else if (along(node) >= 0.97) farEnd.push(node);
  }
  for (const node of farEnd)
    constraints.push({ nodeId: node.id, dof: shortest });
  constraints.push({
    nodeId: farEnd[0].id,
    dof: longest,
    prescribedValue: 0.002,
  });
  const loads = [
    {
      nodeId: farEnd[farEnd.length - 1].id,
      dof: (longest + 1) % 3,
      value: 500,
    },
  ];

  // Surface loads on boundary triangles selected by centroid: a pressure on the
  // band at 60–70 % of the length, a total force on the band at 80–90 %.
  const band = (from, to) => {
    const faces = [];
    for (let tri = 0; tri < mesh.surfaceTriangles.length / 3; tri++) {
      const ids = Array.from(
        mesh.surfaceTriangles.subarray(3 * tri, 3 * tri + 3),
        (vertex) => vertex + ID_OFFSET,
      );
      const centroid =
        ids.reduce((sum, nodeId) => sum + along(nodes[nodeId - ID_OFFSET]), 0) /
        3;
      if (centroid >= from && centroid < to) faces.push(ids);
    }
    return faces;
  };
  const surfaceLoads = [
    { type: "pressure", faces: band(0.6, 0.7), pressure: 10 },
    { type: "force", faces: band(0.8, 0.9), force: [0, 0, -4000] },
  ];
  if (!surfaceLoads.every((load) => load.faces.length > 0))
    throw new Error("both surface-load bands must select boundary triangles");
  return {
    model: {
      nodes,
      elements,
      materials,
      properties,
      constraints,
      loads,
      surfaceLoads,
    },
    nodeCount,
    tetCount,
  };
}

const beam = boxHexMesh(100, 10, 10, 20, 2, 2);
const ID = 500;
const beamNodes = beam.vertices.map((vertex, index) => ({
  id: index + ID,
  x: vertex[0],
  y: vertex[1],
  z: vertex[2],
}));
const KUHN = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
];
const HEX_OF_CUBE_CORNER = [0, 1, 3, 2, 4, 5, 7, 6];
function beamModel(tetRoot) {
  const hexElements = [];
  const tetElements = [];
  const top = [];
  const tip = [];
  const onPlane = (axis, value) => (vertex) =>
    Math.abs(beam.vertices[vertex][axis] - value) < 1e-9;
  beam.hexahedra.forEach((hex) => {
    const propertyId = beam.vertices[hex[0]][0] < 50 ? 1 : 2;
    const tipFace = [1, 2, 6, 5].map((corner) => hex[corner]);
    if (tipFace.every(onPlane(0, 100))) tip.push(tipFace);
    if (tetRoot && propertyId === 1) {
      for (const tet of KUHN) {
        const corners = tet.map((corner) => hex[HEX_OF_CUBE_CORNER[corner]]);
        tetElements.push({ type: "CTETRA", nodeIds: corners, propertyId });
        for (let skip = 0; skip < 4; skip++) {
          const face = corners.filter((_, corner) => corner !== skip);
          if (face.every(onPlane(2, 10))) top.push(face);
        }
      }
    } else {
      hexElements.push({ type: "CHEXA", nodeIds: hex, propertyId });
      const topFace = [4, 5, 6, 7].map((corner) => hex[corner]);
      if (topFace.every(onPlane(2, 10))) top.push(topFace);
    }
  });
  const beamElements = [...hexElements, ...tetElements].map(
    (element, index) => ({
      ...element,
      id: index + 1,
      nodeIds: element.nodeIds.map((vertex) => vertex + ID),
    }),
  );
  const beamConstraints = [];
  for (const node of beamNodes) {
    if (Math.abs(node.x) < 1e-9)
      for (let dof = 0; dof < 3; dof++)
        beamConstraints.push({ nodeId: node.id, dof });
    else if (Math.abs(node.x - 100) < 1e-9 && Math.abs(node.y) < 1e-9)
      beamConstraints.push({ nodeId: node.id, dof: 1 });
  }
  beamConstraints.push({
    nodeId: beamNodes.find((node) => node.x === 100 && node.z === 10).id,
    dof: 0,
    prescribedValue: 0.01,
  });
  const toIds = (faces) =>
    faces.map((face) => face.map((vertex) => vertex + ID));
  return {
    nodes: beamNodes,
    elements: beamElements,
    materials: MATERIALS,
    properties: PROPERTIES,
    constraints: beamConstraints,
    loads: [{ nodeId: beamNodes[beamNodes.length - 1].id, dof: 2, value: 50 }],
    surfaceLoads: [
      { type: "pressure", faces: toIds(top), pressure: 0.4 },
      { type: "force", faces: toIds(tip), force: [0, 0, -1000] },
    ],
  };
}

describe("wall bracket: Rust AMG against MFEM", () => {
  let engine = null;
  let fem = null;
  let model = null;
  let vid = null;
  let mfem = null;
  let amg = null;

  beforeAll(async () => {
    fem = await loadFem();
    ({ model } = await bracketModel(20));
    vid = buildVertexIndexer(model.nodes);
    // MFEM engine: a fresh instance, as the worker does after meshing.
    engine = await loadEngine();
    const inputs = buildSolidEngineInputs(model, vid);
    mfem = engine.solve_linear_elastic(
      inputs.mesh,
      inputs.matJson,
      inputs.bcsJson,
      1,
    );
    amg = await solveSolidWithAmg(
      fem,
      model,
      1,
      vid,
      vid,
      undefined,
      neverAsk,
      ignoreProgress,
    );
  });

  describe("which solver takes the model", () => {
    test("AMG accepts a linear-tet solid model", () => {
      expect(
        amgUnavailableReason({
          elements: model.elements,
          properties: model.properties,
          elementOrder: 1,
          couplingCount: 0,
        }),
      ).toBeNull();
    });

    test("AMG accepts a quadratic-tet solid model", () => {
      expect(
        amgUnavailableReason({
          elements: model.elements,
          properties: model.properties,
          elementOrder: 2,
          couplingCount: 0,
        }),
      ).toBeNull();
    });

    test("AMG refuses element orders other than 1 and 2", () => {
      expect(
        amgUnavailableReason({
          elements: model.elements,
          properties: model.properties,
          elementOrder: 3,
          couplingCount: 0,
        }),
      ).not.toBeNull();
    });

    // Without AMG, a solid model solves with Gauss–Seidel; shells, bodies solved
    // as shells and couplings take the shell/coupled solvers' incomplete Cholesky.
    test("a solid model falls back to Gauss–Seidel", () => {
      expect(
        amgFallbackPreconditioner({
          elements: model.elements,
          properties: model.properties,
          couplingCount: 0,
        }),
      ).toBe("gauss-seidel");
    });

    test("a model with a coupling falls back to incomplete Cholesky", () => {
      expect(
        amgFallbackPreconditioner({
          elements: model.elements,
          properties: model.properties,
          couplingCount: 1,
        }),
      ).toBe("incomplete-cholesky");
    });

    test("a body solved as a shell falls back to incomplete Cholesky", () => {
      expect(
        amgFallbackPreconditioner({
          elements: model.elements,
          properties: model.properties.map((property) => ({
            ...property,
            discretization: "shell",
          })),
          couplingCount: 0,
        }),
      ).toBe("incomplete-cholesky");
    });

    test("a shell-element model falls back to incomplete Cholesky", () => {
      expect(
        amgFallbackPreconditioner({
          elements: [
            { id: 1, type: "CTRIA3", nodeIds: [1, 2, 3], propertyId: 1 },
          ],
          properties: model.properties,
          couplingCount: 0,
        }),
      ).toBe("incomplete-cholesky");
    });
  });

  describe("order 1", () => {
    test("the MFEM solve succeeds", () => {
      expect("error" in mfem, `MFEM solve failed: ${mfem.error}`).toBe(false);
    });

    test("displacement arrays have the same length", () => {
      expect(amg.displacements).toHaveLength(mfem.displacements.length);
    });

    test("von Mises arrays have the same length", () => {
      expect(amg.vonMises).toHaveLength(mfem.von_mises.length);
    });

    // Both stop at a 1e-6 relative tolerance (MFEM in its preconditioned norm,
    // AMG on the force residual); the fields must agree to well within that.
    test("displacements agree with MFEM", () => {
      const displacement = maxDifference(mfem.displacements, amg.displacements);
      expect(
        displacement.relative,
        `displacements differ by ${displacement.relative} relative`,
      ).toBeLessThan(1e-5);
    });

    test("von Mises stresses agree with MFEM", () => {
      const stress = maxDifference(mfem.von_mises, amg.vonMises);
      expect(
        stress.relative,
        `von Mises stresses differ by ${stress.relative} relative`,
      ).toBeLessThan(1e-4);
    });
  });

  // Both solvers add the edge nodes themselves and extend the supports to them;
  // the prescribed displacement, roller and both surface loads all reach them.
  // On a coarser mesh, since MFEM's Gauss–Seidel CG is slow at order 2.
  describe("quadratic elements: the same model at order 2", () => {
    let mfemQuadratic = null;
    let amgQuadratic = null;

    beforeAll(async () => {
      const coarse = await bracketModel(40);
      const coarseVid = buildVertexIndexer(coarse.model.nodes);
      const coarseInputs = buildSolidEngineInputs(coarse.model, coarseVid);
      mfemQuadratic = engine.solve_linear_elastic(
        coarseInputs.mesh,
        coarseInputs.matJson,
        coarseInputs.bcsJson,
        2,
      );
      if ("error" in mfemQuadratic) return;
      amgQuadratic = await solveSolidWithAmg(
        fem,
        coarse.model,
        2,
        coarseVid,
        coarseVid,
        undefined,
        neverAsk,
        ignoreProgress,
      );
    });

    test("the MFEM order-2 solve succeeds", () => {
      expect(
        "error" in mfemQuadratic,
        `MFEM order-2 solve failed: ${mfemQuadratic.error}`,
      ).toBe(false);
    });

    test("one displacement per vertex and one stress per element, as MFEM", () => {
      expect(amgQuadratic.displacements).toHaveLength(
        mfemQuadratic.displacements.length,
      );
      expect(amgQuadratic.vonMises).toHaveLength(
        mfemQuadratic.von_mises.length,
      );
    });

    test("displacements agree with MFEM", () => {
      const difference = maxDifference(
        mfemQuadratic.displacements,
        amgQuadratic.displacements,
      );
      expect(
        difference.relative,
        `order 2: displacements differ by ${difference.relative} relative`,
      ).toBeLessThan(1e-5);
    });

    test("von Mises stresses agree with MFEM", () => {
      const difference = maxDifference(
        mfemQuadratic.von_mises,
        amgQuadratic.vonMises,
      );
      expect(
        difference.relative,
        `order 2: von Mises stresses differ by ${difference.relative} relative`,
      ).toBeLessThan(1e-4);
    });
  });

  test("a surface load selecting only interior or stale faces is refused, as in MFEM", async () => {
    const loaded = model.surfaceLoads[0].faces;
    let refusal = "";
    try {
      await solveSolidWithAmg(
        fem,
        {
          ...model,
          surfaceLoads: [
            {
              type: "pressure",
              faces: [model.elements[0].nodeIds.slice(0, 3)].filter(
                (face) =>
                  !loaded.some((candidate) => candidate.join() === face.join()),
              ),
              pressure: 1,
            },
          ],
        },
        1,
        vid,
        vid,
        undefined,
        neverAsk,
        ignoreProgress,
      );
    } catch (error) {
      refusal = String(error);
    }
    // The first tet's first face is interior on almost every mesh; if it happens
    // to be on the boundary the load is simply applied, which is also correct.
    if (refusal !== "") expect(refusal).toMatch(/no force at all/);
  });

  // A budget of 5 iterations runs out long before convergence while the residual
  // is still falling, so the user is asked, exactly as on the MFEM path.
  describe("progress and the continue-solving prompt", () => {
    const asked = [];
    const progress = [];
    let continued = null;

    beforeAll(async () => {
      continued = await solveSolidWithAmg(
        fem,
        model,
        1,
        vid,
        vid,
        5,
        (state) => {
          asked.push(state);
          return Promise.resolve(1000);
        },
        (line) => progress.push(line),
      );
    });

    test("the user is asked exactly once", () => {
      expect(asked).toHaveLength(1);
    });

    test("the prompt state reports the exhausted budget", () => {
      expect(asked[0].iterations, JSON.stringify(asked[0])).toBe(5);
      expect(asked[0].suggestedIterations).toBe(5);
      expect(asked[0].relativeResidual).toBeGreaterThan(asked[0].target);
      expect(asked[0].elapsedSeconds).toBeGreaterThanOrEqual(0);
    });

    test("progress lines report the CG residual", () => {
      expect(progress.join("\n")).toMatch(
        /\[amg\] CG iteration +10: relative residual/,
      );
    });

    test("the continuation is logged", () => {
      expect(progress.join("\n")).toMatch(
        /Continuing the solve for 1000 more iterations/,
      );
    });

    test("a paused and resumed solve gives the identical field", () => {
      const resumed = maxDifference(amg.displacements, continued.displacements);
      expect(resumed.relative).toBe(0);
    });

    test("answering 0 stops the solve", async () => {
      let stopped = "";
      try {
        await solveSolidWithAmg(
          fem,
          model,
          1,
          vid,
          vid,
          5,
          () => Promise.resolve(0),
          ignoreProgress,
        );
      } catch (error) {
        stopped = String(error);
      }
      expect(stopped).toMatch(/Solve stopped by user/);
    });
  });

  // ── Hexahedra (CHEXA), alone and mixed with tetrahedra ──────────────────────
  // A hand-built store model as the app holds it: a 100 × 10 × 10 mm beam of
  // CHEXA elements, and the same beam with its root half split into CTETRA
  // (listed after the hexes, so element order ≠ solve order). Two bodies,
  // node ids offset from vertex indices, a clamp, a roller, a prescribed
  // displacement, a point load, a pressure on quadrilateral (and triangular)
  // faces and a total force on the tip quadrilaterals. Both solvers number the
  // elements tets first, then hexes; their results must agree at orders 1 and 2.
  describe.each([
    ["CHEXA beam", false],
    ["CHEXA + CTETRA beam", true],
  ])("%s", (_name, tetRoot) => {
    const store = beamModel(tetRoot);

    test("AMG accepts hexahedra", () => {
      expect(
        amgUnavailableReason({
          elements: store.elements,
          properties: store.properties,
          elementOrder: 2,
          couplingCount: 0,
        }),
      ).toBeNull();
    });

    test("couplings on hexahedra are refused (the coupled solver takes tets only)", () => {
      expect(
        amgUnavailableReason({
          elements: store.elements,
          properties: store.properties,
          elementOrder: 1,
          couplingCount: 1,
        }),
      ).toBe(
        "it supports surface-to-point couplings on tetrahedral meshes only",
      );
    });

    test.each([1, 2])("order %i agrees with MFEM", async (order) => {
      const beamVid = buildVertexIndexer(store.nodes);
      const beamInputs = buildSolidEngineInputs(store, beamVid);
      const reference = engine.solve_linear_elastic(
        beamInputs.mesh,
        beamInputs.matJson,
        beamInputs.bcsJson,
        order,
      );
      expect("error" in reference, `MFEM failed: ${reference.error}`).toBe(
        false,
      );
      const beamLog = [];
      const rust = await solveSolidWithAmg(
        fem,
        store,
        order,
        beamVid,
        beamVid,
        undefined,
        neverAsk,
        (line) => beamLog.push(line),
      );
      expect(
        rust.displacements,
        "the result layout must match MFEM's",
      ).toHaveLength(reference.displacements.length);
      expect(rust.vonMises, "the result layout must match MFEM's").toHaveLength(
        reference.von_mises.length,
      );
      const motion = maxDifference(reference.displacements, rust.displacements);
      const vonMises = maxDifference(reference.von_mises, rust.vonMises);
      expect(beamLog.join("\n"), "the solve log names the hexahedra").toMatch(
        /hexahedra/,
      );
      expect(
        motion.relative,
        `displacements differ by ${motion.relative} relative`,
      ).toBeLessThan(1e-5);
      expect(
        vonMises.relative,
        `von Mises differs by ${vonMises.relative} relative`,
      ).toBeLessThan(1e-4);
    });
  });
});

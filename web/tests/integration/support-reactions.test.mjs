// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Support reactions through the app's solve functions and the Rust module
// (KOF-387). A cantilever clamped at x = 0 with a tip load of 1000 N: the
// clamp carries the load on every path — solid (linear and quadratic tets),
// solid with a coupling, pure shell and mixed shell + solid — and its
// reaction balances the applied load.

import { beforeAll, describe, expect, test } from "bun:test";
import {
  solveCoupledSolidInRust,
  solveSolidInRust,
} from "../../src/lib/solve/amg.ts";
import {
  buildCoupledEngineInputs,
  coupledSupportOwners,
} from "../../src/lib/solve/coupled.ts";
import { solveCoupledInRust } from "../../src/lib/solve/coupledRust.ts";
import { buildShellEngineInputs } from "../../src/lib/solve/shell.ts";
import { solveShellInRust } from "../../src/lib/solve/shellRust.ts";
import {
  payloadSupportOwners,
  reactionBalance,
} from "../../src/lib/solve/reactions.ts";
import { buildVertexIndexer } from "../../src/lib/solveMeshPacking.ts";
import { loadFem } from "../support/wasm.mjs";

const discard = () => undefined;
const neverAsk = () => {
  throw new Error("the continuation prompt must not appear");
};

const LENGTH = 100;
const HEIGHT = 20;
const TIP = -1000;
const STEEL = {
  id: 1,
  name: "Steel",
  young: 210000,
  poisson: 0.3,
  density: 7.85e-9,
};
const PROPERTIES = [
  { id: 1, materialId: 1 },
  { id: 2, materialId: 1, thickness: 2 },
];

const KUHN = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
];

const near = (a, b) => Math.abs(a - b) < 1e-6;

function emptyModel() {
  return {
    nodes: [],
    elements: [],
    materials: [STEEL],
    properties: PROPERTIES,
    constraints: [],
    loads: [],
    surfaceLoads: [],
    couplings: [],
    tieGroups: [],
  };
}

// A node at (x, y, z), shared with any earlier node there.
function nodeAt(model, x, y, z) {
  const found = model.nodes.find(
    (node) => near(node.x, x) && near(node.y, y) && near(node.z, z),
  );
  if (found) return found.id;
  const id = 1000 + model.nodes.length;
  model.nodes.push({ id, x, y, z });
  return id;
}

// Kuhn tets over [x0, x0 + length] × [0, h] × [0, h].
function addBeam(model, x0, length, nx, nt = 2) {
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nt; j++)
      for (let k = 0; k < nt; k++) {
        const corner = [0, 1, 2, 3, 4, 5, 6, 7].map((bits) =>
          nodeAt(
            model,
            x0 + ((i + (bits & 1)) * length) / nx,
            ((j + ((bits >> 1) & 1)) * HEIGHT) / nt,
            ((k + ((bits >> 2) & 1)) * HEIGHT) / nt,
          ),
        );
        for (const tet of KUHN)
          model.elements.push({
            id: model.elements.length + 1,
            type: "CTETRA",
            nodeIds: tet.map((c) => corner[c]),
            propertyId: 1,
          });
      }
}

// CTRIA3 facets over [x0, x0 + length] × [0, h] at height z.
function addPlate(model, x0, length, z, nx, ny = 2) {
  const at = (i, j) =>
    nodeAt(model, x0 + (i * length) / nx, (j * HEIGHT) / ny, z);
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      for (const nodeIds of [
        [at(i, j), at(i + 1, j), at(i + 1, j + 1)],
        [at(i, j), at(i + 1, j + 1), at(i, j + 1)],
      ])
        model.elements.push({
          id: model.elements.length + 1,
          type: "CTRIA3",
          nodeIds,
          propertyId: 2,
        });
}

const idsWhere = (model, predicate) =>
  model.nodes.filter(predicate).map((node) => node.id);

// The clamp at x = 0 as BC group 0, holding `dofs`.
function clamp(model, dofs = [0, 1, 2]) {
  model.constraints = idsWhere(model, (node) => near(node.x, 0)).flatMap(
    (nodeId) => dofs.map((dof) => ({ nodeId, dof, group: 0 })),
  );
}

// The tip load spread over the nodes at x = LENGTH.
function tipLoad(model) {
  const tip = idsWhere(model, (node) => near(node.x, LENGTH));
  model.loads = tip.map((nodeId) => ({
    nodeId,
    dof: 2,
    value: TIP / tip.length,
  }));
}

// The clamp carries the tip load, and the reactions balance it.
function expectClampCarriesTip(summary) {
  expect(summary).not.toBeNull();
  const [support] = summary.supports;
  expect(support.vertices).toBeGreaterThan(0);
  expect(support.force[2]).toBeCloseTo(-TIP, 3);
  expect(Math.abs(support.force[0])).toBeLessThan(1e-3);
  expect(Math.abs(support.force[1])).toBeLessThan(1e-3);
  expect(summary.applied[2]).toBeCloseTo(TIP, 6);
  const balance = reactionBalance(summary);
  expect(balance.balanced).toBe(true);
  expect(balance.loadOnSupports).toBe(false);
  // The nodal reactions drawn in the view sum to the support's resultant,
  // all of them on the clamp plane x = 0.
  expect(summary.nodal.length).toBe(support.vertices);
  const sum = [0, 0, 0];
  for (const node of summary.nodal) {
    expect(node.support).toBe(0);
    expect(node.position[0]).toBe(0);
    for (let axis = 0; axis < 3; axis++) sum[axis] += node.force[axis];
  }
  for (let axis = 0; axis < 3; axis++)
    expect(sum[axis]).toBeCloseTo(support.force[axis], 6);
}

let fem = null;
beforeAll(async () => {
  fem = await loadFem();
});

describe("support reactions", () => {
  test("a solid cantilever's clamp carries the tip load and its moment", async () => {
    for (const order of [1, 2]) {
      const model = emptyModel();
      addBeam(model, 0, LENGTH, 10);
      clamp(model);
      tipLoad(model);
      const vid = buildVertexIndexer(model.nodes);
      const { reactions } = await solveSolidInRust(
        fem,
        model,
        order,
        "amg",
        vid,
        vid,
        undefined,
        neverAsk,
        discard,
      );
      expectClampCarriesTip(reactions);
      // About the clamp's centroid (0, h/2, h/2): the tip load's lever arm L.
      expect(reactions.supports[0].moment[1]).toBeCloseTo(TIP * LENGTH, 0);
    }
  });

  test("a load on a supported node is flagged and still balances", async () => {
    const model = emptyModel();
    addBeam(model, 0, LENGTH, 10);
    clamp(model);
    tipLoad(model);
    const held = idsWhere(model, (node) => near(node.x, 0))[0];
    model.loads.push({ nodeId: held, dof: 2, value: -50 });
    const vid = buildVertexIndexer(model.nodes);
    const { reactions } = await solveSolidInRust(
      fem,
      model,
      1,
      "amg",
      vid,
      vid,
      undefined,
      neverAsk,
      discard,
    );
    const balance = reactionBalance(reactions);
    expect(balance.balanced).toBe(true);
    expect(balance.loadOnSupports).toBe(true);
    expect(reactions.appliedOnSupports[2]).toBeCloseTo(-50, 9);
    expect(reactions.supports[0].force[2]).toBeCloseTo(1050, 3);
  });

  test("a tip load through a coupling reaches the clamp", async () => {
    for (const kind of ["kinematic", "distributing"]) {
      const model = emptyModel();
      addBeam(model, 0, LENGTH, 10);
      const tipFace = idsWhere(model, (node) => near(node.x, LENGTH));
      const point = nodeAt(model, LENGTH + 10, HEIGHT / 2, HEIGHT / 2);
      model.couplings = [
        {
          name: "Tip",
          kind,
          dofs: [0, 1, 2, 3, 4, 5],
          refNodeId: point,
          faces: [{ nodeIds: tipFace }],
        },
      ];
      clamp(model);
      model.loads = [{ nodeId: point, dof: 2, value: TIP }];
      const inputs = buildCoupledEngineInputs(model, discard);
      const { reactions } = await solveCoupledSolidInRust(
        fem,
        inputs,
        1,
        "amg",
        undefined,
        neverAsk,
        discard,
        coupledSupportOwners(model, inputs.model),
      );
      expectClampCarriesTip(reactions);
      expect(reactions.supports[0].moment[1]).toBeCloseTo(
        TIP * (LENGTH + 10),
        0,
      );
    }
  });

  test("a shell plate's clamp carries the tip load and its moment", async () => {
    const model = emptyModel();
    addPlate(model, 0, LENGTH, 0, 10);
    clamp(model, [0, 1, 2, 3, 4, 5]);
    tipLoad(model);
    const { reactions } = await solveShellInRust(
      fem,
      buildShellEngineInputs(model),
      undefined,
      neverAsk,
      discard,
      payloadSupportOwners(model),
    );
    expectClampCarriesTip(reactions);
    expect(reactions.supports[0].moment[1]).toBeCloseTo(TIP * LENGTH, 0);
  });

  test("a shell on a solid root: the clamp on the solid carries the load", async () => {
    const model = emptyModel();
    addBeam(model, 0, LENGTH / 2, 5);
    // The plate's root overlaps the solid by one cell, so the two rows of
    // shared nodes carry its moment (one row alone would be a hinge).
    addPlate(model, (2 * LENGTH) / 5, (3 * LENGTH) / 5, HEIGHT / 2, 6);
    clamp(model);
    tipLoad(model);
    const inputs = buildCoupledEngineInputs(model, discard);
    expect(inputs.shellElements.length).toBeGreaterThan(0);
    const { reactions } = await solveCoupledInRust(
      fem,
      inputs,
      "amg",
      undefined,
      neverAsk,
      discard,
      coupledSupportOwners(model, inputs.model),
    );
    expectClampCarriesTip(reactions);
  });

  test("a model without support groups reports no reactions", async () => {
    const model = emptyModel();
    addBeam(model, 0, LENGTH, 4);
    clamp(model);
    model.constraints = model.constraints.map(({ nodeId, dof }) => ({
      nodeId,
      dof,
    }));
    tipLoad(model);
    const vid = buildVertexIndexer(model.nodes);
    const { reactions } = await solveSolidInRust(
      fem,
      model,
      1,
      "amg",
      vid,
      vid,
      undefined,
      neverAsk,
      discard,
    );
    expect(reactions).toBeNull();
  });
});

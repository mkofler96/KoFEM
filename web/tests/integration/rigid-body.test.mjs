// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The rigid-body check before a solve (KOF-388), from the store model through
// the adapters of lib/solve/rigidBody.ts into the Rust module: which body the
// supports leave free to slide or spin, counting supports, ties, couplings and
// the shell-to-solid joins the coupled builder derives.

import { beforeAll, describe, expect, test } from "bun:test";
import {
  coupledRigidBodyInput,
  modelRigidBodyInput,
  unheldBodiesMessage,
} from "../../src/lib/solve/rigidBody.ts";
import { buildCoupledEngineInputs } from "../../src/lib/solve/coupled.ts";
import { loadFem } from "../support/wasm.mjs";

let fem = null;
beforeAll(async () => {
  fem = await loadFem();
});

const silent = () => undefined;
const near = (lhs, rhs) => Math.abs(lhs - rhs) < 1e-6;
const STEEL = {
  id: 1,
  name: "Steel",
  young: 210000,
  poisson: 0.3,
  density: 7.85e-9,
};
const FREE_IN_ALL_SIX =
  "can still move along X, Y and Z, and rotate about X, Y and Z.";
const ONE_BODY_ADVICE = "Add a support or connect it to another body.";

const KUHN = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
];

// A store model under construction: nodes are merged by position within one
// `scope`, so two blocks in different scopes do not share nodes.
function builder() {
  const nodes = [];
  const elements = [];
  const index = new Map();
  const node = (x, y, z, scope = "") => {
    const key = `${scope}|${x},${y},${z}`;
    let id = index.get(key);
    if (id === undefined) {
      id = nodes.length + 1;
      index.set(key, id);
      nodes.push({ id, x, y, z });
    }
    return id;
  };
  // Unit-cube cells of Kuhn tets from `origin`, `cells` per axis.
  const block = (origin, cells, propertyId, scope) => {
    const ids = new Set();
    for (let i = 0; i < cells[0]; i++)
      for (let j = 0; j < cells[1]; j++)
        for (let k = 0; k < cells[2]; k++) {
          const corner = [0, 1, 2, 3, 4, 5, 6, 7].map((bits) => {
            const id = node(
              origin[0] + i + (bits & 1),
              origin[1] + j + ((bits >> 1) & 1),
              origin[2] + k + ((bits >> 2) & 1),
              scope,
            );
            ids.add(id);
            return id;
          });
          for (const tet of KUHN)
            elements.push({
              id: elements.length + 1,
              type: "CTETRA",
              nodeIds: tet.map((c) => corner[c]),
              propertyId,
            });
        }
    return [...ids];
  };
  // A wall of CTRIA3 in the plane y = `y`, x ∈ [0, width], z ∈ [z0, z0 + height].
  const wall = (y, z0, width, height, propertyId) => {
    const ids = new Set();
    for (let i = 0; i < width; i++)
      for (let k = 0; k < height; k++) {
        const quad = [
          [i, k],
          [i + 1, k],
          [i + 1, k + 1],
          [i, k + 1],
        ].map(([a, b]) => {
          const id = node(a, y, z0 + b, `wall ${propertyId}`);
          ids.add(id);
          return id;
        });
        for (const tri of [
          [0, 1, 2],
          [0, 2, 3],
        ])
          elements.push({
            id: elements.length + 1,
            type: "CTRIA3",
            nodeIds: tri.map((c) => quad[c]),
            propertyId,
          });
      }
    return [...ids];
  };
  const where = (ids, predicate) =>
    ids.filter((id) => predicate(nodes[id - 1]));
  const fix = (ids, dofs = [0, 1, 2]) =>
    ids.flatMap((nodeId) => dofs.map((dof) => ({ nodeId, dof })));
  const faces = (ids) => [{ nodeIds: ids }];
  return { nodes, elements, node, block, wall, where, fix, faces };
}

function solidMessage(model) {
  return unheldBodiesMessage(fem, modelRigidBodyInput(model), model.properties);
}

const twoBodies = () => {
  const model = builder();
  const first = model.block([0, 0, 0], [2, 1, 1], 1, "first");
  const second = model.block([2, 0, 0], [2, 1, 1], 2, "second");
  return { model, first, second };
};

describe("solid models", () => {
  test("a body clamped on one face is held", () => {
    const model = builder();
    const block = model.block([0, 0, 0], [3, 1, 1], 1);
    const constraints = model.fix(model.where(block, (n) => near(n.x, 0)));
    expect(
      solidMessage({
        ...model,
        constraints,
        properties: [{ id: 1, materialId: 1 }],
      }),
    ).toBeNull();
  });

  test("a roller base leaves the in-plane motion, named in plain words", () => {
    const model = builder();
    const block = model.block([0, 0, 0], [2, 2, 1], 1);
    const constraints = model.fix(
      model.where(block, (n) => near(n.z, 0)),
      [2],
    );
    expect(
      solidMessage({
        ...model,
        constraints,
        properties: [{ id: 1, materialId: 1 }],
      }),
    ).toBe(
      `Body 1 can still move along X and Y, and rotate about Z. ${ONE_BODY_ADVICE}`,
    );
  });

  test("a second body without a support or a connection is named", () => {
    const { model, first } = twoBodies();
    const constraints = model.fix(model.where(first, (n) => near(n.x, 0)));
    expect(
      solidMessage({
        ...model,
        constraints,
        properties: [
          { id: 1, materialId: 1 },
          { id: 2, materialId: 1 },
        ],
      }),
    ).toBe(`Body 2 ${FREE_IN_ALL_SIX} ${ONE_BODY_ADVICE}`);
  });

  test("a body held only through a tie is held", () => {
    const { model, first, second } = twoBodies();
    const constraints = model.fix(model.where(first, (n) => near(n.x, 0)));
    const tieGroups = [
      {
        name: "Joint",
        facesA: model.faces(model.where(first, (n) => near(n.x, 2))),
        facesB: model.faces(model.where(second, (n) => near(n.x, 2))),
        extent: "full",
        searchDistance: 0,
        method: "mpc",
      },
    ];
    expect(
      solidMessage({
        ...model,
        constraints,
        tieGroups,
        properties: [
          { id: 1, materialId: 1 },
          { id: 2, materialId: 1 },
        ],
      }),
    ).toBeNull();
  });

  test("two loose bodies are both named", () => {
    const { model } = twoBodies();
    expect(
      solidMessage({
        ...model,
        constraints: [],
        properties: [
          { id: 1, materialId: 1 },
          { id: 2, materialId: 1 },
        ],
      }),
    ).toBe(
      `Body 1 ${FREE_IN_ALL_SIX} Body 2 ${FREE_IN_ALL_SIX} ` +
        "Add supports or connect them to other bodies.",
    );
  });
});

describe("couplings", () => {
  // A block gripped at its x = 0 face by a reference point at (−1, 0.5, 0.5).
  const coupledBlock = (referenceDofs) => {
    const model = builder();
    const block = model.block([0, 0, 0], [2, 1, 1], 1);
    const reference = model.node(-1, 0.5, 0.5, "reference");
    return {
      ...model,
      constraints: model.fix([reference], referenceDofs),
      couplings: [
        {
          name: "Bolt",
          kind: "kinematic",
          dofs: [0, 1, 2, 3, 4, 5],
          refNodeId: reference,
          faces: model.faces(model.where(block, (n) => near(n.x, 0))),
        },
      ],
      properties: [{ id: 1, materialId: 1 }],
    };
  };

  test("a body held only through a clamped reference point is held", () => {
    expect(solidMessage(coupledBlock([0, 1, 2, 3, 4, 5]))).toBeNull();
  });

  test("a reference point fixed in translation only lets the body spin about it", () => {
    expect(solidMessage(coupledBlock([0, 1, 2]))).toBe(
      `Body 1 can still rotate about X, Y and Z. ${ONE_BODY_ADVICE}`,
    );
  });

  test("the coupled solve's own inputs give the same verdict", () => {
    for (const [dofs, expected] of [
      [[0, 1, 2, 3, 4, 5], null],
      [
        [0, 1, 2],
        `Body 1 can still rotate about X, Y and Z. ${ONE_BODY_ADVICE}`,
      ],
    ]) {
      const model = { ...coupledBlock(dofs), materials: [STEEL], loads: [] };
      const inputs = buildCoupledEngineInputs(model, silent);
      expect(
        unheldBodiesMessage(
          fem,
          coupledRigidBodyInput(model, inputs),
          model.properties,
        ),
      ).toBe(expected);
    }
  });
});

describe("shell models", () => {
  const plate = (fixedOf) => {
    const model = builder();
    const ids = model.wall(0, 0, 3, 2, 1);
    return {
      ...model,
      constraints: fixedOf(model, ids),
      properties: [{ id: 1, materialId: 1, thickness: 0.1 }],
    };
  };

  test("a plate clamped along an edge is held", () => {
    const model = plate((m, ids) =>
      m.fix(
        m.where(ids, (n) => near(n.x, 0)),
        [0, 1, 2, 3, 4, 5],
      ),
    );
    expect(solidMessage(model)).toBeNull();
  });

  test("a plate pinned at one node can spin about it", () => {
    const model = plate((m, ids) => m.fix(ids.slice(0, 1)));
    expect(solidMessage(model)).toBe(
      `Body 1 can still rotate about X, Y and Z. ${ONE_BODY_ADVICE}`,
    );
  });
});

describe("mixed shell and solid models", () => {
  // A block [0, 4]×[0, 2]×[0, 1] clamped at its base, and a CTRIA3 wall
  // (body 2) in the plane y = 1 from z = `wallBase` up. Standing on the
  // block (wallBase 1), its bottom edge is a straight seam on block nodes,
  // which the coupled builder joins to the block.
  const mixed = (wallBase) => {
    const model = builder();
    const block = model.block([0, 0, 0], [4, 2, 1], 1);
    model.wall(1, wallBase, 4, 3, 2);
    return {
      ...model,
      constraints: model.fix(model.where(block, (n) => near(n.z, 0))),
      loads: [],
      materials: [STEEL],
      properties: [
        { id: 1, materialId: 1 },
        { id: 2, materialId: 1, thickness: 0.2, discretization: "shell" },
      ],
      couplings: [],
      tieGroups: [],
    };
  };
  const message = (model) =>
    unheldBodiesMessage(
      fem,
      coupledRigidBodyInput(model, buildCoupledEngineInputs(model, silent)),
      model.properties,
    );

  test("a wall standing on a clamped block is held through the seam", () => {
    expect(message(mixed(1))).toBeNull();
  });

  test("a wall that does not reach the block is named", () => {
    expect(message(mixed(5))).toBe(
      `Body 2 ${FREE_IN_ALL_SIX} ${ONE_BODY_ADVICE}`,
    );
  });
});

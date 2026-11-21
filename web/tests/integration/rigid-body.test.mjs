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
  routedRigidBodyInput,
  unheldBodiesMessage,
} from "../../src/lib/solve/rigidBody.ts";
import { buildCoupledEngineInputs } from "../../src/lib/solve/coupled.ts";
import { routeSolve } from "../../src/lib/solve/route.ts";
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
      `Bodies 1 and 2 ${FREE_IN_ALL_SIX} ` +
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

describe("a body marked Shell, idealised at solve time", () => {
  // A 20×20×0.5 plate (body 1, marked Shell) cantilevering off a 16×20×16
  // block (body 2), as in auto-shell.spec.ts. The plate touches the block only
  // through duplicated nodes: as solid meshes they are apart, and only the
  // idealisation joins the shell to the block.
  const plateOnBlock = (constraintsOf) => {
    const nodes = [];
    const elements = [];
    const grid = (origin, cells, step, body) => {
      const base = nodes.length;
      const id = (i, j, k) =>
        base + i + (cells[0] + 1) * (j + (cells[1] + 1) * k) + 1;
      for (let k = 0; k <= cells[2]; k++)
        for (let j = 0; j <= cells[1]; j++)
          for (let i = 0; i <= cells[0]; i++)
            nodes.push({
              id: id(i, j, k),
              x: origin[0] + i * step[0],
              y: origin[1] + j * step[1],
              z: origin[2] + k * step[2],
            });
      for (let k = 0; k < cells[2]; k++)
        for (let j = 0; j < cells[1]; j++)
          for (let i = 0; i < cells[0]; i++) {
            const corner = [0, 1, 2, 3, 4, 5, 6, 7].map((bits) =>
              id(i + (bits & 1), j + ((bits >> 1) & 1), k + ((bits >> 2) & 1)),
            );
            for (const tet of KUHN)
              elements.push({
                id: elements.length + 1,
                type: "CTETRA",
                nodeIds: tet.map((c) => corner[c]),
                propertyId: body,
              });
          }
    };
    grid([0, 0, 0], [4, 4, 1], [5, 5, 0.5], 1);
    grid([-6, 0, -16], [4, 4, 4], [4, 5, 4], 2);
    // Boundary triangles, wound outward, with a face id per box plane.
    const faces = new Map();
    for (const element of elements)
      for (const corners of [
        [0, 1, 2, 3],
        [0, 1, 3, 2],
        [0, 2, 3, 1],
        [1, 2, 3, 0],
      ]) {
        const tri = corners.slice(0, 3).map((c) => element.nodeIds[c]);
        const key = [...tri].sort((a, b) => a - b).join(",");
        if (faces.has(key)) faces.delete(key);
        else
          faces.set(key, {
            tri,
            opposite: element.nodeIds[corners[3]],
            body: element.propertyId,
          });
      }
    const planes = [
      [1, "z", 0.5],
      [1, "z", 0],
      [1, "x", 0],
      [1, "x", 20],
      [1, "y", 0],
      [1, "y", 20],
      [2, "z", 0],
      [2, "z", -16],
      [2, "x", -6],
      [2, "x", 10],
      [2, "y", 0],
      [2, "y", 20],
    ];
    const at = (id) => nodes[id - 1];
    const surfaceTriangles = [];
    const surfaceFaceIds = [];
    for (const { tri, opposite, body } of faces.values()) {
      const [pa, pb, pc, po] = [...tri, opposite].map(at);
      const ab = [pb.x - pa.x, pb.y - pa.y, pb.z - pa.z];
      const ac = [pc.x - pa.x, pc.y - pa.y, pc.z - pa.z];
      const normal = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
      ];
      const inward =
        normal[0] * (po.x - pa.x) +
          normal[1] * (po.y - pa.y) +
          normal[2] * (po.z - pa.z) >
        0;
      surfaceTriangles.push(inward ? [tri[0], tri[2], tri[1]] : tri);
      const face = planes.findIndex(
        ([plane, axis, value]) =>
          plane === body && tri.every((id) => near(at(id)[axis], value)),
      );
      if (face < 0) throw new Error("a boundary face lies on no box plane");
      surfaceFaceIds.push(face + 1);
    }
    return {
      nodes,
      elements,
      materials: [STEEL],
      properties: [
        { id: 1, materialId: 1, discretization: "shell" },
        { id: 2, materialId: 1, discretization: "solid" },
      ],
      constraints: constraintsOf(nodes),
      loads: [],
      surfaceLoads: [],
      couplings: [],
      tieGroups: [],
      surfaceTriangles,
      surfaceFaceIds,
    };
  };
  const fixWhere = (predicate, dofs) => (nodes) =>
    nodes
      .filter(predicate)
      .flatMap((n) => dofs.map((dof) => ({ nodeId: n.id, dof })));
  const message = (model) => {
    const route = routeSolve(model);
    expect(route.path).toBe("auto-shell");
    return unheldBodiesMessage(
      fem,
      routedRigidBodyInput(model, route, silent),
      model.properties,
    );
  };

  test("a plate held only through its join to a clamped block is held", () => {
    expect(
      message(plateOnBlock(fixWhere((n) => near(n.z, -16), [0, 1, 2]))),
    ).toBeNull();
  });

  test("a block held only through the plate is held", () => {
    expect(
      message(plateOnBlock(fixWhere((n) => near(n.x, 20), [0, 1, 2]))),
    ).toBeNull();
  });

  test("a plate and block that slide together are named together", () => {
    expect(message(plateOnBlock(fixWhere((n) => near(n.x, 20), [2])))).toBe(
      "Bodies 1 and 2 can still move along X and Y, and rotate about Y and Z. " +
        "Add supports or connect them to other bodies.",
    );
  });
});

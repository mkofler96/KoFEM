// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A tie connection that couples nothing must stop the coupled solve and say why
// (KOF-203). The four ways a tie can fail each have a different fix, so each
// carries its own sentence — and the refusal has to reach the user, which means
// crossing the worker boundary the way the Solve button does.
//
// The builder-side unit checks live in tests/test_shellize_mpc.mjs; these pin
// the worker path: handleMixedSolve reports every tie BEFORE it solves, so a
// declared connection that produced no load path is refused rather than solved
// as a split assembly returning a plausible-looking but wrong shape.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";

const STEP = 5; // element edge
const SIDE = 10; // cube side, two elements across
const GAP = 1; // clearance between the two facing cubes

interface Node {
  id: number;
  x: number;
  y: number;
  z: number;
}
interface Element {
  id: number;
  type: string;
  nodeIds: number[];
  propertyId: number;
}
interface TieGroup {
  name: string;
  facesA: { nodeIds: number[] }[];
  facesB: { nodeIds: number[] }[];
  extent: "full" | "region";
  searchDistance: number;
}
interface SolvePayload {
  nodes: Node[];
  elements: Element[];
  materials: unknown[];
  properties: unknown[];
  constraints: unknown[];
  loads: unknown[];
  surfaceLoads: unknown[];
  tieGroups: TieGroup[];
}

// Splitting a hex cell into 6 tets (Kuhn), the same decomposition the builder
// unit tests use — it keeps every tet edge on the 5 mm grid, so the median edge
// the coupling search derives its distances from is exactly STEP.
const KUHN = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
];

// Cubes of CTETRA elements at the given x offsets, one body (property) each,
// plus two CTRIA3 facets capping the first cube. The shells are what routes the
// solve to the mixed shell/solid path — they share the cube's own nodes, so they
// are welded to it and play no part in the tie under test.
function assembly(xOffsets: number[]) {
  const nodes: Node[] = [];
  const elements: Element[] = [];
  const index = new Map<string, number>();
  const at = (x: number, y: number, z: number): number => {
    const key = `${x},${y},${z}`;
    let id = index.get(key);
    if (id === undefined) {
      id = nodes.length;
      index.set(key, id);
      nodes.push({ id, x, y, z });
    }
    return id;
  };

  xOffsets.forEach((x0, body) => {
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 2; j++)
        for (let k = 0; k < 2; k++) {
          const corner = [
            at(x0 + i * STEP, j * STEP, k * STEP),
            at(x0 + (i + 1) * STEP, j * STEP, k * STEP),
            at(x0 + i * STEP, (j + 1) * STEP, k * STEP),
            at(x0 + (i + 1) * STEP, (j + 1) * STEP, k * STEP),
            at(x0 + i * STEP, j * STEP, (k + 1) * STEP),
            at(x0 + (i + 1) * STEP, j * STEP, (k + 1) * STEP),
            at(x0 + i * STEP, (j + 1) * STEP, (k + 1) * STEP),
            at(x0 + (i + 1) * STEP, (j + 1) * STEP, (k + 1) * STEP),
          ];
          for (const t of KUHN)
            elements.push({
              id: elements.length,
              type: "CTETRA",
              nodeIds: [corner[t[0]], corner[t[1]], corner[t[2]], corner[t[3]]],
              propertyId: body + 1,
            });
        }
  });

  const cap = [
    at(xOffsets[0], 0, SIDE),
    at(xOffsets[0] + SIDE, 0, SIDE),
    at(xOffsets[0] + SIDE, SIDE, SIDE),
    at(xOffsets[0], SIDE, SIDE),
  ];
  elements.push(
    {
      id: elements.length,
      type: "CTRIA3",
      nodeIds: [cap[0], cap[1], cap[2]],
      propertyId: 99,
    },
    {
      id: elements.length + 1,
      type: "CTRIA3",
      nodeIds: [cap[0], cap[2], cap[3]],
      propertyId: 99,
    },
  );

  // Every node of the plane x = value: one face of one cube, a 3x3 grid.
  const faceAt = (value: number): number[] =>
    nodes.filter((n) => Math.abs(n.x - value) < 1e-9).map((n) => n.id);

  return { nodes, elements, faceAt };
}

function payloadFor(
  model: ReturnType<typeof assembly>,
  tie: TieGroup,
  extraNodes: Node[] = [],
): SolvePayload {
  return {
    nodes: [...model.nodes, ...extraNodes],
    elements: model.elements,
    materials: [
      {
        id: 1,
        name: "Steel",
        young: 210000,
        poisson: 0.3,
        density: 7.85e-9,
        color: "#8899aa",
      },
    ],
    properties: [
      { id: 1, materialId: 1 },
      { id: 2, materialId: 1 },
      { id: 3, materialId: 1 },
      { id: 99, materialId: 1, thickness: 2 },
    ],
    constraints: [],
    loads: [],
    surfaceLoads: [],
    tieGroups: [tie],
  };
}

// Send the payload through the same worker entry point the Solve button uses,
// and return the refusal. A tie that couples nothing is reported before the
// engine is ever called, so these never run a solve.
async function solveError(page: Page, payload: SolvePayload): Promise<string> {
  await page.goto("/app/");
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __kofem?: unknown }).__kofem),
  );
  return page.evaluate(async (sent) => {
    try {
      await (
        window as unknown as {
          __kofem: {
            sendToWorker(name: string, payload: object): Promise<unknown>;
          };
        }
      ).__kofem.sendToWorker("solve", sent);
      return "";
    } catch (err) {
      return (err as Error).message;
    }
  }, payload);
}

test("a tie whose search distance is shorter than the clearance is refused", async ({
  page,
}) => {
  const model = assembly([0, SIDE + GAP]);
  const message = await solveError(
    page,
    payloadFor(model, {
      name: "Pin to eye",
      facesA: [{ nodeIds: model.faceAt(SIDE) }],
      facesB: [{ nodeIds: model.faceAt(SIDE + GAP) }],
      extent: "region",
      searchDistance: 0.5 * GAP,
    }),
  );

  // The clearance and the distance the user set are both named, because the fix
  // is to raise one above the other.
  expect(message).toContain('Tie "Pin to eye" coupled no nodes');
  expect(message).toContain(`no closer than ${GAP.toFixed(4)} mm`);
  expect(message).toContain(`${(0.5 * GAP).toFixed(4)} mm search distance`);
});

test("a tie between surfaces the search never reaches is refused", async ({
  page,
}) => {
  // A third cube 2 m away — past the seven doublings of the widening search, so
  // the two surfaces never see each other at all.
  const model = assembly([0, SIDE + GAP, 2000]);
  const message = await solveError(
    page,
    payloadFor(model, {
      name: "Distant body",
      facesA: [{ nodeIds: model.faceAt(0) }],
      facesB: [{ nodeIds: model.faceAt(2000 + SIDE) }],
      extent: "full",
      searchDistance: 0,
    }),
  );

  expect(message).toContain('Tie "Distant body" coupled no nodes');
  expect(message).toContain("apart");
  expect(message).toContain("re-pick them");
});

test("a tie onto a surface with no node in the solved model is refused", async ({
  page,
}) => {
  // A pick that survived a re-mesh: the node is still named by the connection
  // but belongs to no element, so it reaches the solve as nothing at all.
  const model = assembly([0, SIDE + GAP]);
  const orphan = { id: 100000, x: SIDE + 0.5 * GAP, y: 0, z: 0 };
  const message = await solveError(
    page,
    payloadFor(
      model,
      {
        name: "Stale pick",
        facesA: [{ nodeIds: model.faceAt(SIDE) }],
        facesB: [{ nodeIds: [orphan.id] }],
        extent: "full",
        searchDistance: 0,
      },
      [orphan],
    ),
  );

  expect(message).toContain('Tie "Stale pick" coupled no nodes');
  expect(message).toContain("picked surface B has no node in the solved model");
});

test("a tie onto a surface too sparse to distribute onto is refused", async ({
  page,
}) => {
  // The two cubes' OUTWARD faces: a whole assembly apart, so each reference
  // finds only the one node directly opposite — short of the three partners a
  // distributing coupling needs.
  const model = assembly([0, SIDE + GAP]);
  const message = await solveError(
    page,
    payloadFor(model, {
      name: "Wrong faces",
      facesA: [{ nodeIds: model.faceAt(0) }],
      facesB: [{ nodeIds: model.faceAt(2 * SIDE + GAP) }],
      extent: "full",
      searchDistance: 0,
    }),
  );

  expect(message).toContain('Tie "Wrong faces" coupled no nodes');
  expect(message).toContain("three partners a distributing coupling needs");
});

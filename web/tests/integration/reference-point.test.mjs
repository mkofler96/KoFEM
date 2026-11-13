// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Surface-to-point coupling, from the model down to the engine (KOF-208, part 2).
//
// tests/integration/coupling.test.mjs already pins the ENGINE's kinematic
// coupling against hand-built pool arrays. This one drives the same engine
// through the model-side pipeline the app actually uses — store-shaped
// nodes/elements, a coupling declared over a picked surface,
// buildExplicitCoupledModel + buildReferenceCouplings, then solve_coupled — so
// a break anywhere in that chain fails here rather than only in a browser.
//
// Checks:
//   1. Reference point placement. On a cylindrical bore, referencePointOptions
//      offers the surface centre AND the two ends of the fitted axis (the "up
//      and down centre" of KOF-208); on a flat face it offers the centre alone,
//      because axis-end positions on a flat patch would be meaningless.
//   2. An all-solid model with a coupling reaches the engine at all: the model
//      has no shell element, so this is the routing PR #417 left for part 2.
//   3. A force at the reference point of a KINEMATIC coupling produces the same
//      tip deflection as the same force applied straight to the coupled face.
//   4. A MOMENT at the reference point bends the beam — the whole point of the
//      feature, and impossible on a solid mesh without it (a solid node has no
//      rotational DOF, and momentToNodalForces cannot build a couple from one
//      node). rebuildLoads must turn it into a rotational DOF load.
//      Both kinds of load on a point are pinned here, including that exactly one
//      builder claims the face: rebuildLoads applies it as a nodal DOF load and
//      rebuildSurfaceLoads leaves it alone, so it is neither dropped nor applied
//      twice.
//   5. A kinematic reference point can be FIXED, which a distributing one
//      cannot: clamping the point clamps the surface it grips.
//   6. Modelling errors are named, not left to the engine: a distributing
//      coupling that grips fewer than 3 nodes, and two kinematic couplings
//      fighting over the same node.

import { beforeAll, describe, expect, test } from "bun:test";
import { buildExplicitCoupledModel } from "../../src/lib/shellize.ts";
import {
  buildReferenceCouplings,
  referencePointOptions,
} from "../../src/lib/coupling.ts";
import {
  rebuildLoads,
  rebuildSurfaceLoads,
} from "../../src/store/boundaryRebuild.ts";
import { loadEngine, loadFem } from "../support/wasm.mjs";

const YOUNG = 210000; // MPa
const POISSON = 0.3;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const KUHN = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
];

// Store-shaped cantilever: a box [0,L] × [0,h] × [0,h] of Kuhn tets.
function beamModel(length, height, nx, nt = 2) {
  const nodes = [];
  const index = new Map();
  const dx = length / nx;
  const dy = height / nt;
  const at = (i, j, k) => {
    const [x, y, z] = [i * dx, j * dy, k * dy];
    const key = `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`;
    let id = index.get(key);
    if (id === undefined) {
      id = nodes.length;
      index.set(key, id);
      nodes.push({ id, x, y, z });
    }
    return id;
  };
  const elements = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nt; j++)
      for (let k = 0; k < nt; k++) {
        const corner = [
          at(i, j, k),
          at(i + 1, j, k),
          at(i, j + 1, k),
          at(i + 1, j + 1, k),
          at(i, j, k + 1),
          at(i + 1, j, k + 1),
          at(i, j + 1, k + 1),
          at(i + 1, j + 1, k + 1),
        ];
        for (const tet of KUHN)
          elements.push({
            id: elements.length,
            type: "CTETRA",
            nodeIds: [
              corner[tet[0]],
              corner[tet[1]],
              corner[tet[2]],
              corner[tet[3]],
            ],
            propertyId: 1,
          });
      }
  return { nodes, elements };
}

// A hollow cylinder (annulus extruded along z) as store-shaped tets, so the
// bore is a real cylindrical surface the axis fit has to recognise.
function boreModel({
  radius = 10,
  wall = 4,
  height = 24,
  nTheta = 16,
  nz = 4,
}) {
  const nodes = [];
  const elements = [];
  const id = (ring, theta, layer) =>
    layer * (2 * nTheta) + ring * nTheta + (theta % nTheta);
  for (let layer = 0; layer <= nz; layer++)
    for (let ring = 0; ring < 2; ring++)
      for (let theta = 0; theta < nTheta; theta++) {
        const angle = (2 * Math.PI * theta) / nTheta;
        const ringRadius = ring === 0 ? radius : radius + wall;
        nodes.push({
          id: nodes.length,
          x: ringRadius * Math.cos(angle),
          y: ringRadius * Math.sin(angle),
          z: (height * layer) / nz,
        });
      }
  for (let layer = 0; layer < nz; layer++)
    for (let theta = 0; theta < nTheta; theta++) {
      const corner = [
        id(0, theta, layer),
        id(0, theta + 1, layer),
        id(1, theta, layer),
        id(1, theta + 1, layer),
        id(0, theta, layer + 1),
        id(0, theta + 1, layer + 1),
        id(1, theta, layer + 1),
        id(1, theta + 1, layer + 1),
      ];
      for (const tet of KUHN)
        elements.push({
          id: elements.length,
          type: "CTETRA",
          nodeIds: [
            corner[tet[0]],
            corner[tet[1]],
            corner[tet[2]],
            corner[tet[3]],
          ],
          propertyId: 1,
        });
    }
  return { nodes, elements };
}

// ── The solve, exactly as handleMixedSolve assembles it ──────────────────────

function solve(Module, { nodes, elements, couplings, constraints, loads }) {
  const vertexIndex = new Map(nodes.map((node, i) => [node.id, i]));
  const vid = (nodeId) => {
    const index = vertexIndex.get(nodeId);
    if (index === undefined) throw new Error(`unknown node ${nodeId}`);
    return index;
  };
  const verts = [];
  for (const node of nodes) verts.push(node.x, node.y, node.z);
  const solidTets = [];
  for (const el of elements)
    for (const nid of el.nodeIds) solidTets.push(vid(nid));

  const refIds = [...new Set(couplings.map((c) => c.refNodeId))];
  const model = buildExplicitCoupledModel(verts, solidTets, [], [], {
    referencePoints: refIds.map(vid),
  });
  const poolOf = (nodeId) => {
    const pi = model.poolOfVertex.get(vid(nodeId));
    if (pi === undefined) throw new Error(`node ${nodeId} is not in the pool`);
    return pi;
  };
  const refPool = new Set(refIds.map(poolOf));
  const coupling = buildReferenceCouplings(couplings, (nodeId) =>
    poolOf(nodeId),
  );

  const fixed = [];
  for (const c of constraints) {
    const pi = poolOf(c.nodeId);
    if (c.dof > 2 && !refPool.has(pi)) continue;
    fixed.push(6 * pi + c.dof);
  }
  const loadDofs = [];
  const loadVals = [];
  for (const l of loads) {
    const pi = poolOf(l.nodeId);
    if (l.dof > 2 && !refPool.has(pi)) continue;
    loadDofs.push(6 * pi + l.dof);
    loadVals.push(l.value);
  }

  const result = Module.solve_coupled(
    {
      vertices: Float64Array.from(model.pool),
      tets: Int32Array.from(model.tets),
      triangles: Int32Array.from([]),
      thicknesses: Float64Array.from([]),
    },
    {
      ref: Int32Array.from(coupling.ref),
      offsets: Int32Array.from(coupling.offsets),
      solid: Int32Array.from(coupling.solid),
      mpc: Int32Array.from(coupling.mpc),
      dof_mask: Int32Array.from(coupling.dofMask),
      relaxation: 1.0,
    },
    {
      fixed_dofs: Int32Array.from(fixed),
      load_dofs: Int32Array.from(loadDofs),
      load_vals: Float64Array.from(loadVals),
    },
    JSON.stringify({
      solid: { young_modulus: YOUNG, poisson_ratio: POISSON },
      shell: { young_modulus: YOUNG, poisson_ratio: POISSON },
    }),
  );
  if ("error" in result) throw new Error(result.error);
  return { result, poolOf };
}

// Largest |u| over a set of store node ids.
function maxDisplacement(result, poolOf, nodeIds) {
  let best = 0;
  for (const nodeId of nodeIds) {
    const pi = poolOf(nodeId);
    const mag = Math.hypot(
      result.displacements[3 * pi],
      result.displacements[3 * pi + 1],
      result.displacements[3 * pi + 2],
    );
    if (mag > best) best = mag;
  }
  return best;
}

// One displacement component of one store node.
function displacement(result, poolOf, nodeId, dof) {
  return result.displacements[3 * poolOf(nodeId) + dof];
}

// ── 1. Reference point placement ─────────────────────────────────────────────

describe("reference point placement", () => {
  const bore = boreModel({});
  // The bore surface: the inner ring of nodes, which is exactly what a face
  // pick on the hole would return.
  const boreFace = {
    nodeIds: bore.nodes
      .filter((n) => Math.hypot(n.x, n.y) < 10 + 1e-6)
      .map((n) => n.id),
  };
  const options = referencePointOptions([boreFace], bore.nodes, bore.elements);

  test("a cylindrical bore offers the centre plus both axis ends", () => {
    expect(
      options,
      `got ${options.map((o) => o.label).join(", ")}`,
    ).toHaveLength(3);
  });

  test("the selection centre is on the bore axis at mid-height", () => {
    const centre = options[0].point;
    const got = `got (${centre.join(", ")})`;
    expect(Math.hypot(centre[0], centre[1]), got).toBeLessThan(1e-6);
    expect(Math.abs(centre[2] - 12), got).toBeLessThan(1e-6);
  });

  test("the axis ends sit at the two ends of the bore", () => {
    const ends = options.slice(1).map((o) => o.point);
    const zs = ends.map((p) => p[2]).sort((a, b) => a - b);
    const got = `got z = ${zs.join(", ")}`;
    for (const end of ends)
      expect(Math.hypot(end[0], end[1]), got).toBeLessThan(1e-6);
    expect(Math.abs(zs[0]), got).toBeLessThan(1e-6);
    expect(Math.abs(zs[1] - 24), got).toBeLessThan(1e-6);
  });

  // A flat face is not a cylinder — offering it "axis ends" would place the
  // reference point somewhere with no meaning.
  test("a flat face offers only the selection centre", () => {
    const beam = beamModel(100, 20, 5);
    const endFace = {
      nodeIds: beam.nodes.filter((n) => n.x > 100 - 1e-6).map((n) => n.id),
    };
    const flatOptions = referencePointOptions(
      [endFace],
      beam.nodes,
      beam.elements,
    );
    expect(
      flatOptions,
      `got ${flatOptions.map((o) => o.label).join(", ")}`,
    ).toHaveLength(1);
    expect(flatOptions[0].label).toBe("Selection centre");
  });
});

// ── 2-5. An all-solid model with a coupling, loaded at its point ─────────────

const LENGTH = 100;
const HEIGHT = 20;
const FORCE = -5000; // N, in −y
const MOMENT = 2e5; // N·mm about z

const beam = beamModel(LENGTH, HEIGHT, 8);
const tipNodeIds = beam.nodes
  .filter((node) => node.x > LENGTH - 1e-6)
  .map((node) => node.id);
const rootNodeIds = beam.nodes
  .filter((node) => node.x < 1e-6)
  .map((node) => node.id);
// The reference point is a node of the model, as the store creates it.
const REF_ID = beam.nodes.length;
const refNode = { id: REF_ID, x: LENGTH, y: HEIGHT / 2, z: HEIGHT / 2 };
const withRef = { ...beam, nodes: [...beam.nodes, refNode] };

const clamp = rootNodeIds.flatMap((nodeId) =>
  [0, 1, 2].map((dof) => ({ nodeId, dof })),
);
const coupling = {
  name: "Coupling1",
  kind: "kinematic",
  dofs: [0, 1, 2, 3, 4, 5],
  refNodeId: REF_ID,
  faces: [{ nodeIds: tipNodeIds }],
};

// Centre of the tip face, on the beam's neutral axis. Deflection is read there
// rather than as a max over the face: under an end moment the face ROTATES, so
// a magnitude over its corners mixes bending deflection with that rotation.
const centreTipId = beam.nodes.find(
  (node) =>
    node.x > LENGTH - 1e-6 &&
    Math.abs(node.y - HEIGHT / 2) < 1e-6 &&
    Math.abs(node.z - HEIGHT / 2) < 1e-6,
).id;

describe("kinematic coupling on an all-solid cantilever", () => {
  // Tip deflection under the end force, on this mesh. Linear tets lock in
  // bending, so the absolute value is well short of FL³/(3EI) at this element
  // size — which is why the moment check below compares against THIS rather than
  // against the analytic beam: the ratio of the two load cases isolates the
  // coupling from the element's own stiffness error.
  let forceDeflection = null;
  // The same, with the force spread straight over the coupled face.
  let uDirect = null;
  // Tip deflection under the end moment.
  let momentDeflection = null;
  // Largest |u| over the tip face while the reference point is clamped.
  let clampedTip = null;

  beforeAll(async () => {
    // The shell idealisation runs in the Rust module (crates/kofem-shellize).
    await loadFem();
    const Module = await loadEngine();

    // The same total force, once through the reference point and once spread
    // straight over the coupled face.
    const throughPoint = solve(Module, {
      ...withRef,
      couplings: [coupling],
      constraints: clamp,
      loads: [{ nodeId: REF_ID, dof: 1, value: FORCE }],
    });
    const direct = solve(Module, {
      ...beam,
      couplings: [],
      constraints: clamp,
      loads: tipNodeIds.map((nodeId) => ({
        nodeId,
        dof: 1,
        value: FORCE / tipNodeIds.length,
      })),
    });
    forceDeflection = Math.abs(
      displacement(throughPoint.result, throughPoint.poolOf, centreTipId, 1),
    );
    uDirect = Math.abs(
      displacement(direct.result, direct.poolOf, centreTipId, 1),
    );

    // A MOMENT at the reference point. Only a rigid spider can produce one on a
    // solid mesh: it is the θ_R × r term of u_i = u_R + θ_R × r_i that turns the
    // couple into a self-equilibrated force pattern over the face.
    const underMoment = solve(Module, {
      ...withRef,
      couplings: [coupling],
      constraints: clamp,
      loads: [{ nodeId: REF_ID, dof: 5, value: MOMENT }],
    });
    momentDeflection = Math.abs(
      displacement(underMoment.result, underMoment.poolOf, centreTipId, 1),
    );

    // Clamping the reference point clamps the surface it grips — the bolted-hole
    // idealisation, and the thing a distributing coupling cannot do.
    const clamped = solve(Module, {
      ...withRef,
      couplings: [coupling],
      constraints: [
        ...clamp,
        ...[0, 1, 2, 3, 4, 5].map((dof) => ({ nodeId: REF_ID, dof })),
      ],
      loads: rootNodeIds
        .slice(0, 1)
        .map((nodeId) => ({ nodeId, dof: 1, value: 0 })),
    });
    clampedTip = maxDisplacement(clamped.result, clamped.poolOf, tipNodeIds);
  });

  test("an all-solid model with a coupling solves at all", () => {
    expect(forceDeflection).toBeGreaterThan(0);
  });

  test("a force at the reference point matches the force on the face", () => {
    const relative = Math.abs(forceDeflection - uDirect) / uDirect;
    expect(
      relative,
      `${forceDeflection.toFixed(5)} vs ${uDirect.toFixed(5)} mm (${(100 * relative).toFixed(2)} %)`,
    ).toBeLessThan(0.05);
  });

  test("a moment at the reference point bends the beam", () => {
    expect(momentDeflection).toBeGreaterThan(0);
  });

  // Compared against the force case on the same mesh, where the ratio is pure
  // beam theory and independent of how stiff the discretisation is:
  //   δ_M/δ_F = [M·L²/(2EI)] / [F·L³/(3EI)] = 3M/(2FL)
  test("the moment's tip deflection is 3M/(2FL) of the force case, as beam theory says", () => {
    const expectedRatio = (3 * MOMENT) / (2 * Math.abs(FORCE) * LENGTH);
    const ratio = momentDeflection / forceDeflection;
    const relative = Math.abs(ratio - expectedRatio) / expectedRatio;
    expect(
      relative,
      `ratio ${ratio.toFixed(4)} vs ${expectedRatio.toFixed(4)} (${(100 * relative).toFixed(2)} %)`,
    ).toBeLessThan(0.05);
  });

  test("a clamped kinematic reference point holds its coupled surface still", () => {
    expect(clampedTip).toBeLessThan(1e-9);
  });
});

describe("loads on a reference point or a picked node", () => {
  // The model layer is what turns a moment group on a reference point into a
  // rotational DOF load. Without this, momentToNodalForces would see a one-node
  // face, find every lever arm zero, and drop the load with a console warning.
  test("a moment on a reference point becomes a rotational DOF load", () => {
    const loads = rebuildLoads(
      [
        {
          id: 1,
          name: "Load1",
          dof: 5,
          totalForce: MOMENT,
          components: [0, 0, MOMENT],
          kind: "moment",
          faces: [
            { id: 1, label: "Coupling1 reference point", nodeIds: [REF_ID] },
          ],
        },
      ],
      withRef.nodes,
      [
        {
          ...coupling,
          id: 1,
          point: [refNode.x, refNode.y, refNode.z],
          faces: [],
        },
      ],
    );
    const built = JSON.stringify(loads);
    expect(loads, built).toHaveLength(1);
    expect(loads[0].dof, built).toBe(5);
    expect(loads[0].value, built).toBe(MOMENT);
  });

  // A FORCE on a reference point has the same problem from the other side: it
  // would normally be integrated as a traction over the boundary faces of the
  // selection, and a lone point spans none, so it too has to become a nodal DOF
  // load rather than silently integrate to nothing.
  test("a force on a reference point becomes a translational DOF load", () => {
    const forceLoads = rebuildLoads(
      [
        {
          id: 2,
          name: "Load2",
          dof: 1,
          totalForce: FORCE,
          components: [0, FORCE, 0],
          kind: "force",
          faces: [
            { id: 2, label: "Coupling1 reference point", nodeIds: [REF_ID] },
          ],
        },
      ],
      withRef.nodes,
      [
        {
          ...coupling,
          id: 1,
          point: [refNode.x, refNode.y, refNode.z],
          faces: [],
        },
      ],
    );
    const built = JSON.stringify(forceLoads);
    expect(forceLoads, built).toHaveLength(1);
    expect(forceLoads[0].dof, built).toBe(1);
    expect(forceLoads[0].value, built).toBe(FORCE);
  });

  // …and the surface-load builder must NOT also claim that face, or the force
  // would be applied twice. The two builders partition a group's faces by the
  // same test, so this pins the split rather than trusting that the boundary
  // matcher happens to find nothing on a one-node selection.
  const pointForceGroup = {
    id: 2,
    name: "Load2",
    dof: 1,
    totalForce: FORCE,
    components: [0, FORCE, 0],
    kind: "force",
    faces: [{ id: 2, label: "Coupling1 reference point", nodeIds: [REF_ID] }],
  };
  const couplingGroups = [
    { ...coupling, id: 1, point: [refNode.x, refNode.y, refNode.z], faces: [] },
  ];

  test("a force on a reference point produces no surface load to double-apply it", () => {
    expect(
      rebuildSurfaceLoads([pointForceGroup], withRef.elements, couplingGroups),
    ).toHaveLength(0);
  });

  // A force on a real surface still takes the traction route, untouched.
  test("a force on a picked surface still becomes a surface load", () => {
    expect(
      rebuildSurfaceLoads(
        [
          {
            ...pointForceGroup,
            faces: [{ id: 3, label: "Face 1", nodeIds: tipNodeIds }],
          },
        ],
        withRef.elements,
        couplingGroups,
      ),
    ).toHaveLength(1);
  });

  // A POINT pick — a single mesh node, marked `geometry: "point"` — goes the
  // same way as a reference point, and for the same reason: one node spans no
  // element face, so an integrated traction over it is a traction over nothing.
  // The marker is explicit rather than inferred from the node count, so the two
  // builders agree by construction instead of by coincidence.
  const pointPickGroup = {
    id: 3,
    name: "Load3",
    dof: 1,
    totalForce: FORCE,
    components: [0, FORCE, 0],
    kind: "force",
    faces: [
      {
        id: 4,
        label: "Node 1",
        nodeIds: [centreTipId],
        geometry: "point",
      },
    ],
  };

  test("a force on a picked node becomes a nodal DOF load", () => {
    const nodeLoads = rebuildLoads([pointPickGroup], withRef.nodes, []);
    const built = JSON.stringify(nodeLoads);
    expect(nodeLoads, built).toHaveLength(1);
    expect(nodeLoads[0].nodeId, built).toBe(centreTipId);
    expect(nodeLoads[0].dof, built).toBe(1);
    expect(nodeLoads[0].value, built).toBe(FORCE);
  });

  test("a force on a picked node produces no surface load to double-apply it", () => {
    expect(
      rebuildSurfaceLoads([pointPickGroup], withRef.elements, []),
    ).toHaveLength(0);
  });
});

// ── 6. Modelling errors are named ────────────────────────────────────────────

describe("modelling errors", () => {
  const poolOf = (nodeId) => nodeId;

  test("a distributing coupling with fewer than 3 nodes is refused by name", () => {
    const build = () =>
      buildReferenceCouplings(
        [
          {
            name: "Coupling1",
            kind: "distributing",
            dofs: [0, 1, 2, 3, 4, 5],
            refNodeId: 99,
            faces: [{ nodeIds: [1, 2] }],
          },
        ],
        poolOf,
      );
    expect(build).toThrow("Coupling1");
    expect(build).toThrow("at least 3");
  });

  test("two kinematic couplings gripping the same node name both of them", () => {
    const build = () =>
      buildReferenceCouplings(
        [
          {
            name: "Bolt",
            kind: "kinematic",
            dofs: [0, 1, 2],
            refNodeId: 90,
            faces: [{ nodeIds: [1, 2, 3] }],
          },
          {
            name: "Bearing",
            kind: "kinematic",
            dofs: [0, 1, 2],
            refNodeId: 91,
            faces: [{ nodeIds: [3, 4, 5] }],
          },
        ],
        poolOf,
      );
    expect(build).toThrow("Bolt");
    expect(build).toThrow("Bearing");
  });

  test("a kinematic coupling that ties no DOF is refused", () => {
    const build = () =>
      buildReferenceCouplings(
        [
          {
            name: "Coupling1",
            kind: "kinematic",
            dofs: [],
            refNodeId: 90,
            faces: [{ nodeIds: [1, 2, 3] }],
          },
        ],
        poolOf,
      );
    expect(build).toThrow("ties no DOF");
  });
});

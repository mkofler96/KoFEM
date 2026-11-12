// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/handCheck.ts — an example's hand calculation is
// compared with the solve only while the model is the problem the formula was
// worked out for: the same loads, supports and material. Each probe (mean
// displacement over CAD faces, displacement at a point, twist of a face, peak
// von Mises stress) is read on the current mesh, solid or shell. The browser
// path is covered by tests/first-simulation.spec.ts.
//
// Run:  bun tests/test_hand_check.mjs

import {
  evaluateHandCheck,
  formatHandCheckValue,
  parseHandCheck,
} from "../src/lib/handCheck.ts";
import { nodeVonMisesField } from "../src/lib/resultField.ts";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const close = (a, b, tol = 1e-12) =>
  Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
function thrown(fn) {
  try {
    fn();
  } catch (err) {
    return err.message;
  }
  return "";
}

// A cantilever along z: CAD face 1 (z = 0) clamped, CAD face 2 (z = 100) loaded
// with Fy = −10 kN. Face 2 is a cross of nodes around the beam axis, so the
// twist probe has arms in both directions and one node on the axis.
const assumes = {
  loads: [{ kind: "force", force: [0, -10000, 0], cadFaceIds: [2] }],
  supports: [{ dofs: [0, 1, 2], value: 0, cadFaceIds: [1] }],
  young: 210000,
  poisson: 0.3,
};
const handCheck = (overrides = {}) =>
  parseHandCheck({
    quantity: "Tip deflection",
    formula: "−P·L³ / (3·E·I)",
    reference: -1.905,
    unit: "mm",
    probe: { kind: "displacement", component: 1, cadFaceIds: [2] },
    assumes,
    ...overrides,
  });

const face = (id, cadFaceId, nodeIds) => ({
  id,
  label: `Face ${id}`,
  nodeIds,
  geometry: "face",
  cadFaceId,
});
const tipLoad = (overrides = {}) => ({
  id: 1,
  name: "Tip load",
  dof: 1,
  totalForce: -10000,
  components: [0, -10000, 0],
  kind: "force",
  faces: [face(2, 2, [4, 5, 6, 7, 8])],
  ...overrides,
});
const clamp = (overrides = {}) => ({
  id: 1,
  name: "Clamped end",
  dofs: [0, 1, 2],
  value: 0,
  faces: [face(1, 1, [1, 2, 3])],
  ...overrides,
});

// Root nodes 1–3 at z = 0; tip nodes 4 (on the axis), 5–8 at radius 10.
const NODES = [
  [1, 0, 0, 0],
  [2, 10, 0, 0],
  [3, 0, 10, 0],
  [4, 0, 0, 100],
  [5, 10, 0, 100],
  [6, 0, 10, 100],
  [7, -10, 0, 100],
  [8, 0, -10, 100],
].map(([id, x, y, z]) => ({ id, x, y, z }));

// The tip twists by THETA about z and drops, more off the neutral axis:
// u = θ ẑ × r + (0, −1.9 − 0.001·y², 0).
const THETA = 0.004;
function tipField(nodes) {
  const disp = new Float64Array(3 * nodes.length);
  nodes.forEach((node, i) => {
    if (node.z === 0) return;
    disp[3 * i] = -THETA * node.y;
    disp[3 * i + 1] = THETA * node.x - 1.9 - 0.001 * node.y * node.y;
  });
  return disp;
}

function model(overrides = {}) {
  return {
    nodes: NODES,
    elements: [
      { id: 0, type: "CTETRA", nodeIds: [1, 2, 3, 4], propertyId: 1 },
      { id: 1, type: "CTETRA", nodeIds: [2, 3, 4, 5], propertyId: 1 },
      { id: 2, type: "CTETRA", nodeIds: [3, 4, 6, 7], propertyId: 1 },
      { id: 3, type: "CTETRA", nodeIds: [1, 4, 7, 8], propertyId: 1 },
    ],
    surfaceTriangles: [
      [1, 2, 3],
      [4, 5, 6],
      [4, 6, 7],
      [4, 7, 8],
      [4, 8, 5],
    ],
    surfaceFaceIds: [1, 2, 2, 2, 2],
    loadGroups: [tipLoad()],
    bcGroups: [clamp()],
    materials: [{ id: 1, name: "Steel", young: 210000, poisson: 0.3 }],
    properties: [{ id: 1, materialId: 1, discretization: "solid" }],
    result: {
      displacements: tipField(NODES),
      vonMises: new Float64Array([120, 80, 310, 40]),
    },
    ...overrides,
  };
}

const compared = (outcome) =>
  outcome.kind === "compare" ? outcome.fe : JSON.stringify(outcome);

console.log("\n=== Hand check: probes ===");

// Mean Uy of the tip face's nodes (indices 3–7).
const meanTipUy =
  [3, 4, 5, 6, 7].reduce((sum, i) => sum + tipField(NODES)[3 * i + 1], 0) / 5;
const shipped = evaluateHandCheck(handCheck(), model());
check(
  "displacement over CAD faces: the mean Uy of the tip face's nodes",
  shipped.kind === "compare" && close(shipped.fe, meanTipUy),
  `${compared(shipped)} vs ${meanTipUy}`,
);

// Re-meshed: new node ids and a new surface, the same CAD faces.
const remeshNodes = [
  [11, 0, 0, 0],
  [12, 10, 0, 0],
  [13, 0, 10, 0],
  [14, 10, 0, 100],
  [15, -10, 0, 100],
  [16, 0, 0, 100],
].map(([id, x, y, z]) => ({ id, x, y, z }));
const remeshed = evaluateHandCheck(
  handCheck(),
  model({
    nodes: remeshNodes,
    elements: [
      { id: 0, type: "CTETRA", nodeIds: [11, 12, 13, 14], propertyId: 1 },
    ],
    surfaceTriangles: [
      [11, 12, 13],
      [14, 15, 16],
    ],
    surfaceFaceIds: [1, 2],
    loadGroups: [tipLoad({ faces: [face(2, 2, [14, 15, 16])] })],
    bcGroups: [clamp({ faces: [face(1, 1, [11, 12, 13])] })],
    result: { displacements: tipField(remeshNodes) },
  }),
);
const remeshUy =
  [3, 4, 5].reduce((sum, i) => sum + tipField(remeshNodes)[3 * i + 1], 0) / 3;
check(
  "a re-mesh keeps the check: the probe faces are resolved on the new mesh",
  remeshed.kind === "compare" && close(remeshed.fe, remeshUy),
  `${compared(remeshed)} vs ${remeshUy}`,
);

const atPoint = evaluateHandCheck(
  handCheck({
    probe: { kind: "displacement", component: 0, point: [0.4, 9.7, 100.2] },
  }),
  model(),
);
check(
  "displacement at a point: the component at the nearest mesh node",
  atPoint.kind === "compare" && close(atPoint.fe, -THETA * 10),
  compared(atPoint),
);

const twist = evaluateHandCheck(
  handCheck({
    quantity: "End twist",
    unit: "rad",
    reference: THETA,
    probe: { kind: "twist", axis: 2, cadFaceIds: [2] },
  }),
  model(),
);
check(
  "twist: the rotation of the tip face about z, skipping the node on the axis",
  twist.kind === "compare" && close(twist.fe, THETA),
  compared(twist),
);

const nodalVm = nodeVonMisesField(model().result, NODES, model().elements);
const peak = evaluateHandCheck(
  handCheck({
    quantity: "Peak stress",
    unit: "MPa",
    reference: 300,
    probe: { kind: "stress", field: "vonMises", stat: "max" },
  }),
  model(),
);
check(
  "stress: the largest von Mises averaged to the nodes like the result plot",
  peak.kind === "compare" && close(peak.fe, Math.max(...nodalVm)),
  `${compared(peak)} vs ${Math.max(...nodalVm)}`,
);
const rootPeak = evaluateHandCheck(
  handCheck({
    quantity: "Peak root stress",
    unit: "MPa",
    reference: 100,
    probe: { kind: "stress", field: "vonMises", stat: "max", cadFaceIds: [1] },
  }),
  model(),
);
check(
  "stress over CAD faces: the largest nodal von Mises of the root face",
  rootPeak.kind === "compare" &&
    close(rootPeak.fe, Math.max(nodalVm[0], nodalVm[1], nodalVm[2])) &&
    rootPeak.fe < Math.max(...nodalVm),
  compared(rootPeak),
);
const kt = evaluateHandCheck(
  handCheck({
    quantity: "Kt",
    unit: "",
    reference: 3,
    divideBy: 50,
    probe: { kind: "stress", field: "vonMises", stat: "max" },
  }),
  model(),
);
check(
  "divideBy turns the peak stress into a concentration factor",
  kt.kind === "compare" && close(kt.fe, Math.max(...nodalVm) / 50),
  compared(kt),
);

// A mesh-time shell: a plate's mid-surface, its facets on the wall's CAD face 7
// (the face it was collapsed from), one facet stress each.
const plateNodes = [
  [0, 0, 0, 0],
  [1, 100, 0, 0],
  [2, 100, 50, 0],
  [3, 0, 50, 0],
].map(([id, x, y, z]) => ({ id, x, y, z }));
const shellModel = model({
  nodes: plateNodes,
  elements: [
    { id: 0, type: "CTRIA3", nodeIds: [0, 1, 2], propertyId: 2 },
    { id: 1, type: "CTRIA3", nodeIds: [0, 2, 3], propertyId: 2 },
  ],
  surfaceTriangles: [
    [0, 1, 2],
    [0, 2, 3],
  ],
  surfaceFaceIds: [7, 7],
  loadGroups: [],
  bcGroups: [],
  properties: [
    { id: 1, materialId: 1, discretization: "shell" },
    {
      id: 2,
      materialId: 1,
      thickness: 2,
      discretization: "shell",
      sourceBodyId: 1,
    },
  ],
  result: {
    displacements: new Float64Array([0, 0, 0, 0.1, 0, 0, 0.1, 0, 0, 0, 0, 0]),
    vonMises: new Float64Array([90, 30]),
  },
});
const shellCheck = (probe) =>
  handCheck({
    probe,
    assumes: { loads: [], supports: [], young: 210000, poisson: 0.3 },
  });
const shellPeak = evaluateHandCheck(
  shellCheck({ kind: "stress", field: "vonMises", stat: "max" }),
  shellModel,
);
check(
  "shell: the peak stress is the area-averaged nodal facet stress",
  shellPeak.kind === "compare" && close(shellPeak.fe, 90),
  compared(shellPeak),
);
const shellMean = evaluateHandCheck(
  shellCheck({ kind: "displacement", component: 0, cadFaceIds: [7] }),
  shellModel,
);
check(
  "shell: a wall's CAD face resolves to its mid-surface nodes",
  shellMean.kind === "compare" && close(shellMean.fe, 0.05),
  compared(shellMean),
);
const sideFace = thrown(() =>
  evaluateHandCheck(
    shellCheck({ kind: "twist", axis: 0, cadFaceIds: [8] }),
    shellModel,
  ),
);
check(
  "shell: a face the idealisation collapsed is an error naming the face",
  sideFace.includes("CAD face 8 is not on the current mesh's surface"),
  sideFace,
);

console.log("\n=== Hand check: unreadable probes ===");

const noNumbering = thrown(() =>
  evaluateHandCheck(
    handCheck(),
    model({ surfaceTriangles: null, surfaceFaceIds: null }),
  ),
);
check(
  "a mesh without CAD face numbering is an error",
  noNumbering.includes("no CAD face numbering"),
  noNumbering,
);
const stale = thrown(() =>
  evaluateHandCheck(
    handCheck(),
    model({ result: { displacements: new Float64Array(6) } }),
  ),
);
check(
  "a result of another mesh is an error",
  stale.includes("belongs to a different mesh"),
  stale,
);
const noStress = thrown(() =>
  evaluateHandCheck(
    handCheck({ probe: { kind: "stress", field: "vonMises", stat: "max" } }),
    model({ result: { displacements: tipField(NODES) } }),
  ),
);
check(
  "a stress probe on a result without stresses is an error",
  noStress.includes("no von Mises stress"),
  noStress,
);
const onAxisOnly = thrown(() =>
  evaluateHandCheck(
    handCheck({ probe: { kind: "twist", axis: 2, cadFaceIds: [2] } }),
    model({
      nodes: [{ id: 4, x: 0, y: 0, z: 100 }],
      elements: [],
      surfaceTriangles: [[4, 4, 4]],
      surfaceFaceIds: [2],
      result: { displacements: new Float64Array(3) },
    }),
  ),
);
check(
  "a twist probe with no node off the axis is an error",
  onAxisOnly.includes("no node off the twist axis"),
  onAxisOnly,
);

console.log("\n=== Hand check: withheld when the model changed ===");

// A model loaded by a pressure and a moment, for those kinds of change.
const mixedAssumes = {
  loads: [
    { kind: "pressure", value: 5, cadFaceIds: [3] },
    { kind: "moment", axis: 2, value: 2e6, cadFaceIds: [2] },
  ],
  supports: [{ dofs: [0, 1, 2], value: 0, cadFaceIds: [1] }],
  young: 210000,
  poisson: 0.3,
};
const pressure = (overrides = {}) => ({
  id: 2,
  name: "Pressure",
  dof: 0,
  totalForce: 5,
  kind: "pressure",
  faces: [face(3, 3, [5, 6])],
  ...overrides,
});
const moment = (overrides = {}) => ({
  id: 3,
  name: "Torque",
  dof: 5,
  totalForce: 2e6,
  components: [0, 0, 2e6],
  kind: "moment",
  faces: [face(4, 2, [4, 5, 6, 7, 8])],
  ...overrides,
});
const mixedCheck = handCheck({ assumes: mixedAssumes });
const mixedModel = (overrides = {}) =>
  model({ loadGroups: [pressure(), moment()], ...overrides });
const mixedShipped = evaluateHandCheck(mixedCheck, mixedModel());
check(
  "pressure and moment loads as assumed: compared",
  mixedShipped.kind === "compare",
  JSON.stringify(mixedShipped),
);

const changedCases = [
  [
    "the load is doubled",
    handCheck(),
    model({ loadGroups: [tipLoad({ components: [0, -20000, 0] })] }),
  ],
  [
    "a second load is added",
    handCheck(),
    model({
      loadGroups: [
        tipLoad(),
        tipLoad({ id: 2, name: "Extra", faces: [face(3, 2, [4, 5])] }),
      ],
    }),
  ],
  [
    "the load moves to another CAD face",
    handCheck(),
    model({ loadGroups: [tipLoad({ faces: [face(2, 5, [4, 5])] })] }),
  ],
  [
    "the force becomes a pressure",
    handCheck(),
    model({
      loadGroups: [tipLoad({ kind: "pressure", components: undefined })],
    }),
  ],
  [
    "the pressure is raised",
    mixedCheck,
    mixedModel({ loadGroups: [pressure({ totalForce: 6 }), moment()] }),
  ],
  [
    "the pressure becomes a force",
    mixedCheck,
    mixedModel({
      loadGroups: [
        pressure({ kind: "force", dof: 0, components: [5, 0, 0] }),
        moment(),
      ],
    }),
  ],
  [
    "the moment turns about another axis",
    mixedCheck,
    mixedModel({
      loadGroups: [pressure(), moment({ components: [2e6, 0, 0] })],
    }),
  ],
  [
    "the moment is halved",
    mixedCheck,
    mixedModel({
      loadGroups: [pressure(), moment({ components: [0, 0, 1e6] })],
    }),
  ],
  [
    "the moment is removed",
    mixedCheck,
    mixedModel({ loadGroups: [pressure()] }),
  ],
  ["the support is removed", handCheck(), model({ bcGroups: [] })],
  [
    "the clamp becomes a roller",
    handCheck(),
    model({ bcGroups: [clamp({ dofs: [0] })] }),
  ],
  [
    "a second support is added at the tip",
    handCheck(),
    model({
      bcGroups: [clamp(), clamp({ id: 2, faces: [face(4, 2, [4, 5])] })],
    }),
  ],
  [
    "the support is picked as an edge",
    handCheck(),
    model({
      bcGroups: [
        clamp({ faces: [{ ...face(1, 1, [1, 2]), cadFaceId: undefined }] }),
      ],
    }),
  ],
  [
    "the material is aluminium",
    handCheck(),
    model({
      materials: [{ id: 1, name: "Aluminium", young: 70000, poisson: 0.33 }],
    }),
  ],
  [
    "only Poisson's ratio is edited (a twist depends on G = E / (2(1 + ν)))",
    handCheck({
      quantity: "End twist",
      unit: "rad",
      reference: THETA,
      probe: { kind: "twist", axis: 2, cadFaceIds: [2] },
    }),
    model({
      materials: [{ id: 1, name: "Steel", young: 210000, poisson: 0.25 }],
    }),
  ],
];
for (const [name, hc, changedModel] of changedCases) {
  const outcome = evaluateHandCheck(hc, changedModel);
  check(
    `${name}: withheld`,
    outcome.kind === "changed",
    JSON.stringify(outcome),
  );
}

console.log("\n=== Hand check: parsing ===");

const valid = {
  quantity: "Tip deflection",
  formula: "−P·L³ / (3·E·I)",
  reference: -1.905,
  unit: "mm",
  probe: { kind: "displacement", component: 1, cadFaceIds: [2] },
  assumes,
};
const parseCases = [
  [
    "a load-group probe in a check with a unit (not the legacy shape)",
    { ...valid, probe: { loadGroupId: 1, component: 1 } },
    'handCheck.probe.kind must be "displacement", "twist" or "stress"',
  ],
  [
    "a check without Poisson's ratio",
    { ...valid, assumes: { ...assumes, poisson: undefined } },
    "handCheck.assumes.poisson must be a finite number",
  ],
  [
    "a migrated check that assumes a Poisson's ratio",
    { ...valid, migratedFrom: "v0.6" },
    "handCheck.assumes.poisson is set, but the block is migrated from v0.6",
  ],
  [
    "an unknown migration source",
    { ...valid, migratedFrom: "v0.4" },
    'handCheck.migratedFrom must be "v0.6" when set',
  ],
  [
    "a load without its kind",
    {
      ...valid,
      assumes: {
        ...assumes,
        loads: [{ force: [0, -10000, 0], cadFaceIds: [2] }],
      },
    },
    'handCheck.assumes.loads[0].kind must be "force", "pressure" or "moment"',
  ],
  [
    "a check without its load list",
    { ...valid, assumes: { force: [0, -10000, 0], young: 210000 } },
    "handCheck.assumes.loads must be an array",
  ],
  [
    "a check without a unit",
    { ...valid, unit: undefined },
    "handCheck.unit must be",
  ],
  [
    "a displacement probe with both a point and faces",
    {
      ...valid,
      probe: {
        kind: "displacement",
        component: 1,
        point: [0, 0, 100],
        cadFaceIds: [2],
      },
    },
    "either point or cadFaceIds",
  ],
  [
    "a twist probe on no face",
    { ...valid, probe: { kind: "twist", axis: 2, cadFaceIds: [] } },
    "handCheck.probe.cadFaceIds must name at least one CAD face",
  ],
  [
    "a stress probe of another statistic",
    { ...valid, probe: { kind: "stress", field: "vonMises", stat: "mean" } },
    'handCheck.probe.stat must be "max"',
  ],
  [
    "a zero divideBy",
    { ...valid, divideBy: 0 },
    "handCheck.divideBy must be greater than 0",
  ],
  [
    "a moment about axis 3",
    {
      ...valid,
      assumes: {
        ...assumes,
        loads: [{ kind: "moment", axis: 3, value: 1, cadFaceIds: [2] }],
      },
    },
    "handCheck.assumes.loads[0].axis must be 0, 1 or 2",
  ],
];
for (const [name, raw, expected] of parseCases) {
  const message = thrown(() => parseHandCheck(raw));
  check(
    `${name} is rejected with the field named`,
    message.includes(expected),
    message,
  );
}
const parsed = parseHandCheck({
  ...valid,
  unit: "",
  divideBy: 100,
  probe: { kind: "stress", field: "vonMises", stat: "max" },
});
check(
  "a stress probe without faces and a divideBy parse as written",
  parsed.divideBy === 100 &&
    parsed.unit === "" &&
    parsed.probe.kind === "stress" &&
    parsed.probe.cadFaceIds === undefined,
  JSON.stringify(parsed),
);

console.log("\n=== Hand check: v0.5.0 / v0.6.0 analysis files ===");

// The handCheck block of examples/gallery/site/cantilever-beam.vtu as released
// in v0.6.0 (identical in v0.5.0), decoded from its KoFEM field data: the
// probe reads the mean Uy over load group 1's faces, the loads carry no kind
// and the block no unit. Its load is on CAD face 2, its clamp on CAD face 4.
const V060_CANTILEVER = {
  quantity: "Tip deflection",
  probe: { loadGroupId: 1, component: 1 },
  formula: "−P·L³ / (3·E·I)",
  reference: -1.9047619047619047,
  assumes: {
    loads: [{ force: [0, -10000, 0], cadFaceIds: [2] }],
    supports: [{ dofs: [0, 1, 2], value: 0, cadFaceIds: [4] }],
    young: 210000,
  },
};
const legacy = parseHandCheck(structuredClone(V060_CANTILEVER));
check(
  "the v0.6.0 block migrates to a force load and a displacement probe of its faces",
  legacy.unit === "mm" &&
    legacy.migratedFrom === "v0.6" &&
    legacy.assumes.poisson === undefined &&
    legacy.assumes.loads[0].kind === "force" &&
    legacy.probe.kind === "displacement" &&
    legacy.probe.component === 1 &&
    JSON.stringify(legacy.probe.cadFaceIds) === "[2]",
  JSON.stringify(legacy),
);
// The same check written in the current shape.
const current = parseHandCheck({
  quantity: "Tip deflection",
  formula: "−P·L³ / (3·E·I)",
  reference: -1.9047619047619047,
  unit: "mm",
  probe: { kind: "displacement", component: 1, cadFaceIds: [2] },
  assumes: {
    loads: [{ kind: "force", force: [0, -10000, 0], cadFaceIds: [2] }],
    supports: [{ dofs: [0, 1, 2], value: 0, cadFaceIds: [4] }],
    young: 210000,
    poisson: 0.3,
  },
});
// The test cantilever with its clamp on CAD face 4, as in the v0.6.0 model.
const legacyModel = (overrides = {}) =>
  model({
    surfaceFaceIds: [4, 2, 2, 2, 2],
    bcGroups: [clamp({ faces: [face(1, 4, [1, 2, 3])] })],
    ...overrides,
  });
const legacyOutcome = evaluateHandCheck(legacy, legacyModel());
const currentOutcome = evaluateHandCheck(current, legacyModel());
check(
  "the migrated block reads what v0.6.0 read: the mean Uy over the load group's faces",
  legacyOutcome.kind === "compare" &&
    currentOutcome.kind === "compare" &&
    legacyOutcome.fe === currentOutcome.fe &&
    close(legacyOutcome.fe, meanTipUy),
  `${compared(legacyOutcome)} vs ${compared(currentOutcome)} vs ${meanTipUy}`,
);
const resaved = parseHandCheck(JSON.parse(JSON.stringify(legacy)));
check(
  "a migrated block saved again opens unchanged",
  JSON.stringify(resaved) === JSON.stringify(legacy),
  JSON.stringify(resaved),
);
const legacyNu = evaluateHandCheck(
  legacy,
  legacyModel({
    materials: [{ id: 1, name: "Steel", young: 210000, poisson: 0.25 }],
  }),
);
check(
  "a migrated bending check assumes no ν: editing ν keeps it",
  legacyNu.kind === "compare",
  JSON.stringify(legacyNu),
);
const legacyE = evaluateHandCheck(
  legacy,
  legacyModel({
    materials: [{ id: 1, name: "Steel", young: 200000, poisson: 0.3 }],
  }),
);
check(
  "a migrated check is still withheld once E is edited",
  legacyE.kind === "changed",
  JSON.stringify(legacyE),
);

const legacyCases = [
  [
    "a v0.6.0 block that assumes two loads",
    {
      ...V060_CANTILEVER,
      assumes: {
        ...V060_CANTILEVER.assumes,
        loads: [
          { force: [0, -10000, 0], cadFaceIds: [2] },
          { force: [0, -5000, 0], cadFaceIds: [3] },
        ],
      },
    },
    "handCheck.probe reads load group 1 (the v0.5/v0.6 shape), but the block assumes 2 loads, so the faces it read are unknown: it must assume exactly one load",
  ],
  [
    "a v0.6.0 block that assumes no load",
    {
      ...V060_CANTILEVER,
      assumes: { ...V060_CANTILEVER.assumes, loads: [] },
    },
    "but the block assumes 0 loads",
  ],
  [
    "a v0.6.0 block whose load has a kind",
    {
      ...V060_CANTILEVER,
      assumes: {
        ...V060_CANTILEVER.assumes,
        loads: [{ kind: "force", force: [0, -10000, 0], cadFaceIds: [2] }],
      },
    },
    "handCheck.assumes.loads[0].kind is set, but the block is in the v0.5/v0.6 shape",
  ],
];
for (const [name, raw, expected] of legacyCases) {
  const message = thrown(() => parseHandCheck(raw));
  check(
    `${name} is rejected, not guessed`,
    message.includes(expected),
    message,
  );
}

console.log("\n=== Hand check: formatting ===");

for (const [value, unit, expected] of [
  [-1.90476, "mm", "−1.905 mm"],
  [-1.9, "mm", "−1.900 mm"],
  [0.0123456, "rad", "0.01235 rad"],
  [0.000123456, "rad", "1.235×10⁻⁴ rad"],
  [302.66, "MPa", "302.7 MPa"],
  [12345.6, "MPa", "12346 MPa"],
  [3.0214, "", "3.021"],
  [0, "mm", "0.000 mm"],
]) {
  const shown = formatHandCheckValue(value, unit);
  check(
    `${value} ${unit || "(dimensionless)"} shows as ${expected}`,
    shown === expected,
    shown,
  );
}

if (failures > 0) {
  console.log(`\n${failures} hand check test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll hand check tests passed");

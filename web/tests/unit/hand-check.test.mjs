// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/handCheck.ts — an example's hand calculation is
// compared with the solve only while the model is the problem the formula was
// worked out for: the same loads, supports and material. Each probe (mean
// displacement over CAD faces, displacement at a point, twist of a face, peak
// von Mises stress) is read on the current mesh, solid or shell. The browser
// path is covered by tests/first-simulation.spec.ts.

import { describe, expect, test } from "bun:test";
import {
  evaluateHandCheck,
  formatHandCheckValue,
  parseHandCheck,
} from "../../src/lib/handCheck.ts";
import { nodeVonMisesField } from "../../src/lib/resultField.ts";

// How far a probe's value may be from the expected one: 1e-12, times the
// expected value where that is above 1.
const tolerance = (expected) => 1e-12 * Math.max(1, Math.abs(expected));

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

// Mean Uy of the tip face's nodes (indices 3–7).
const meanTipUy =
  [3, 4, 5, 6, 7].reduce((sum, i) => sum + tipField(NODES)[3 * i + 1], 0) / 5;

describe("Hand check: probes", () => {
  test("displacement over CAD faces: the mean Uy of the tip face's nodes", () => {
    const shipped = evaluateHandCheck(handCheck(), model());
    expect(shipped.kind).toBe("compare");
    expect(
      Math.abs(shipped.fe - meanTipUy),
      `${shipped.fe} vs ${meanTipUy}`,
    ).toBeLessThanOrEqual(tolerance(meanTipUy));
  });

  // Re-meshed: new node ids and a new surface, the same CAD faces.
  test("a re-mesh keeps the check: the probe faces are resolved on the new mesh", () => {
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
      [3, 4, 5].reduce((sum, i) => sum + tipField(remeshNodes)[3 * i + 1], 0) /
      3;
    expect(remeshed.kind).toBe("compare");
    expect(
      Math.abs(remeshed.fe - remeshUy),
      `${remeshed.fe} vs ${remeshUy}`,
    ).toBeLessThanOrEqual(tolerance(remeshUy));
  });

  test("displacement at a point: the component at the nearest mesh node", () => {
    const atPoint = evaluateHandCheck(
      handCheck({
        probe: { kind: "displacement", component: 0, point: [0.4, 9.7, 100.2] },
      }),
      model(),
    );
    const nearestUx = -THETA * 10;
    expect(atPoint.kind).toBe("compare");
    expect(
      Math.abs(atPoint.fe - nearestUx),
      `${atPoint.fe} vs ${nearestUx}`,
    ).toBeLessThanOrEqual(tolerance(nearestUx));
  });

  test("twist: the rotation of the tip face about z, skipping the node on the axis", () => {
    const twist = evaluateHandCheck(
      handCheck({
        quantity: "End twist",
        unit: "rad",
        reference: THETA,
        probe: { kind: "twist", axis: 2, cadFaceIds: [2] },
      }),
      model(),
    );
    expect(twist.kind).toBe("compare");
    expect(
      Math.abs(twist.fe - THETA),
      `${twist.fe} vs ${THETA}`,
    ).toBeLessThanOrEqual(tolerance(THETA));
  });

  const nodalVm = nodeVonMisesField(model().result, NODES, model().elements);

  test("stress: the largest von Mises averaged to the nodes like the result plot", () => {
    const peak = evaluateHandCheck(
      handCheck({
        quantity: "Peak stress",
        unit: "MPa",
        reference: 300,
        probe: { kind: "stress", field: "vonMises", stat: "max" },
      }),
      model(),
    );
    const largest = Math.max(...nodalVm);
    expect(peak.kind).toBe("compare");
    expect(
      Math.abs(peak.fe - largest),
      `${peak.fe} vs ${largest}`,
    ).toBeLessThanOrEqual(tolerance(largest));
  });

  test("stress over CAD faces: the largest nodal von Mises of the root face", () => {
    const rootPeak = evaluateHandCheck(
      handCheck({
        quantity: "Peak root stress",
        unit: "MPa",
        reference: 100,
        probe: {
          kind: "stress",
          field: "vonMises",
          stat: "max",
          cadFaceIds: [1],
        },
      }),
      model(),
    );
    const rootLargest = Math.max(nodalVm[0], nodalVm[1], nodalVm[2]);
    expect(rootPeak.kind).toBe("compare");
    expect(
      Math.abs(rootPeak.fe - rootLargest),
      `${rootPeak.fe} vs ${rootLargest}`,
    ).toBeLessThanOrEqual(tolerance(rootLargest));
    expect(rootPeak.fe).toBeLessThan(Math.max(...nodalVm));
  });

  test("divideBy turns the peak stress into a concentration factor", () => {
    const factor = evaluateHandCheck(
      handCheck({
        quantity: "Kt",
        unit: "",
        reference: 3,
        divideBy: 50,
        probe: { kind: "stress", field: "vonMises", stat: "max" },
      }),
      model(),
    );
    const largestOverNominal = Math.max(...nodalVm) / 50;
    expect(factor.kind).toBe("compare");
    expect(
      Math.abs(factor.fe - largestOverNominal),
      `${factor.fe} vs ${largestOverNominal}`,
    ).toBeLessThanOrEqual(tolerance(largestOverNominal));
  });

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

  test("shell: the peak stress is the area-averaged nodal facet stress", () => {
    const shellPeak = evaluateHandCheck(
      shellCheck({ kind: "stress", field: "vonMises", stat: "max" }),
      shellModel,
    );
    expect(shellPeak.kind).toBe("compare");
    expect(
      Math.abs(shellPeak.fe - 90),
      `${shellPeak.fe} vs 90`,
    ).toBeLessThanOrEqual(tolerance(90));
  });

  test("shell: a wall's CAD face resolves to its mid-surface nodes", () => {
    const shellMean = evaluateHandCheck(
      shellCheck({ kind: "displacement", component: 0, cadFaceIds: [7] }),
      shellModel,
    );
    expect(shellMean.kind).toBe("compare");
    expect(
      Math.abs(shellMean.fe - 0.05),
      `${shellMean.fe} vs 0.05`,
    ).toBeLessThanOrEqual(tolerance(0.05));
  });

  test("shell: a face the idealisation collapsed is an error naming the face", () => {
    expect(() =>
      evaluateHandCheck(
        shellCheck({ kind: "twist", axis: 0, cadFaceIds: [8] }),
        shellModel,
      ),
    ).toThrow("CAD face 8 is not on the current mesh's surface");
  });
});

describe("Hand check: unreadable probes", () => {
  test("a mesh without CAD face numbering is an error", () => {
    expect(() =>
      evaluateHandCheck(
        handCheck(),
        model({ surfaceTriangles: null, surfaceFaceIds: null }),
      ),
    ).toThrow("no CAD face numbering");
  });

  test("a result of another mesh is an error", () => {
    expect(() =>
      evaluateHandCheck(
        handCheck(),
        model({ result: { displacements: new Float64Array(6) } }),
      ),
    ).toThrow("belongs to a different mesh");
  });

  test("a stress probe on a result without stresses is an error", () => {
    expect(() =>
      evaluateHandCheck(
        handCheck({
          probe: { kind: "stress", field: "vonMises", stat: "max" },
        }),
        model({ result: { displacements: tipField(NODES) } }),
      ),
    ).toThrow("no von Mises stress");
  });

  test("a twist probe with no node off the axis is an error", () => {
    expect(() =>
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
    ).toThrow("no node off the twist axis");
  });
});

describe("Hand check: withheld when the model changed", () => {
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

  test("pressure and moment loads as assumed: compared", () => {
    const mixedShipped = evaluateHandCheck(mixedCheck, mixedModel());
    expect(mixedShipped.kind).toBe("compare");
  });

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
  test.each(changedCases)("%s: withheld", (_name, check, changedModel) => {
    const outcome = evaluateHandCheck(check, changedModel);
    expect(outcome.kind, JSON.stringify(outcome)).toBe("changed");
  });
});

describe("Hand check: parsing", () => {
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
  test.each(parseCases)(
    "%s is rejected with the field named",
    (_name, raw, expected) => {
      expect(() => parseHandCheck(raw)).toThrow(expected);
    },
  );

  test("a stress probe without faces and a divideBy parse as written", () => {
    const parsed = parseHandCheck({
      ...valid,
      unit: "",
      divideBy: 100,
      probe: { kind: "stress", field: "vonMises", stat: "max" },
    });
    expect(parsed.divideBy).toBe(100);
    expect(parsed.unit).toBe("");
    expect(parsed.probe.kind).toBe("stress");
    expect(parsed.probe.cadFaceIds).toBeUndefined();
  });
});

describe("Hand check: v0.5.0 / v0.6.0 analysis files", () => {
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

  test("the v0.6.0 block migrates to a force load and a displacement probe of its faces", () => {
    expect(legacy.unit).toBe("mm");
    expect(legacy.migratedFrom).toBe("v0.6");
    expect(legacy.assumes.poisson).toBeUndefined();
    expect(legacy.assumes.loads[0].kind).toBe("force");
    expect(legacy.probe.kind).toBe("displacement");
    expect(legacy.probe.component).toBe(1);
    expect(legacy.probe.cadFaceIds).toEqual([2]);
  });

  // The test cantilever with its clamp on CAD face 4, as in the v0.6.0 model.
  const legacyModel = (overrides = {}) =>
    model({
      surfaceFaceIds: [4, 2, 2, 2, 2],
      bcGroups: [clamp({ faces: [face(1, 4, [1, 2, 3])] })],
      ...overrides,
    });

  test("the migrated block reads what v0.6.0 read: the mean Uy over the load group's faces", () => {
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
    const legacyOutcome = evaluateHandCheck(legacy, legacyModel());
    const currentOutcome = evaluateHandCheck(current, legacyModel());
    expect(legacyOutcome.kind).toBe("compare");
    expect(currentOutcome.kind).toBe("compare");
    expect(legacyOutcome.fe).toBe(currentOutcome.fe);
    expect(
      Math.abs(legacyOutcome.fe - meanTipUy),
      `${legacyOutcome.fe} vs ${meanTipUy}`,
    ).toBeLessThanOrEqual(tolerance(meanTipUy));
  });

  test("a migrated block saved again opens unchanged", () => {
    const resaved = parseHandCheck(JSON.parse(JSON.stringify(legacy)));
    expect(resaved).toEqual(legacy);
  });

  test("a migrated bending check assumes no ν: editing ν keeps it", () => {
    const legacyNu = evaluateHandCheck(
      legacy,
      legacyModel({
        materials: [{ id: 1, name: "Steel", young: 210000, poisson: 0.25 }],
      }),
    );
    expect(legacyNu.kind).toBe("compare");
  });

  test("a migrated check is still withheld once E is edited", () => {
    const legacyE = evaluateHandCheck(
      legacy,
      legacyModel({
        materials: [{ id: 1, name: "Steel", young: 200000, poisson: 0.3 }],
      }),
    );
    expect(legacyE.kind, JSON.stringify(legacyE)).toBe("changed");
  });

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
  test.each(legacyCases)(
    "%s is rejected, not guessed",
    (_name, raw, expected) => {
      expect(() => parseHandCheck(raw)).toThrow(expected);
    },
  );
});

describe("Hand check: formatting", () => {
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
    test(`${value} ${unit || "(dimensionless)"} shows as ${expected}`, () => {
      expect(formatHandCheckValue(value, unit)).toBe(expected);
    });
  }
});

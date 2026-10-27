// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/handCheck.ts — an example's hand calculation is
// compared with the solve only while the model is the problem the formula was
// worked out for: the same loads, supports and material. The browser path is
// covered by tests/first-simulation.spec.ts.
//
// Run:  bun tests/test_hand_check.mjs

import { evaluateHandCheck, parseHandCheck } from "../src/lib/handCheck.ts";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// The cantilever's check: Fy = −10 kN on CAD face 2, CAD face 1 clamped.
const handCheck = parseHandCheck({
  quantity: "Tip deflection",
  probe: { loadGroupId: 1, component: 1 },
  formula: "−P·L³ / (3·E·I)",
  reference: -1.905,
  assumes: {
    loads: [{ force: [0, -10000, 0], cadFaceIds: [2] }],
    supports: [{ dofs: [0, 1, 2], value: 0, cadFaceIds: [1] }],
    young: 210000,
  },
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
  faces: [face(2, 2, [3, 4])],
  ...overrides,
});
const clamp = (overrides = {}) => ({
  id: 1,
  name: "Clamped end",
  dofs: [0, 1, 2],
  value: 0,
  faces: [face(1, 1, [1, 2])],
  ...overrides,
});

// Four nodes; the tip nodes 3 and 4 deflect −1.9 and −2.0 mm in y.
function model(overrides = {}) {
  return {
    nodes: [1, 2, 3, 4].map((id) => ({ id, x: 0, y: 0, z: 0 })),
    loadGroups: [tipLoad()],
    bcGroups: [clamp()],
    materials: [{ id: 1, name: "Steel", young: 210000, poisson: 0.3 }],
    properties: [{ id: 1, materialId: 1, discretization: "solid" }],
    result: {
      displacements: [0, 0, 0, 0, 0, 0, 0, -1.9, 0, 0, -2.0, 0],
    },
    ...overrides,
  };
}

console.log("\n=== Hand check ===");

const shipped = evaluateHandCheck(handCheck, model());
check(
  "the model as shipped compares the mean tip deflection",
  shipped?.kind === "compare" && Math.abs(shipped.fe - -1.95) < 1e-12,
  JSON.stringify(shipped),
);

const remeshed = evaluateHandCheck(
  handCheck,
  model({
    nodes: [7, 8, 9].map((id) => ({ id, x: 0, y: 0, z: 0 })),
    loadGroups: [tipLoad({ faces: [face(2, 2, [9])] })],
    bcGroups: [clamp({ faces: [face(1, 1, [7, 8])] })],
    result: { displacements: [0, 0, 0, 0, 0, 0, 0, -1.93, 0] },
  }),
);
check(
  "a re-mesh keeps the check: the groups are on the same CAD faces",
  remeshed?.kind === "compare" && Math.abs(remeshed.fe - -1.93) < 1e-12,
  JSON.stringify(remeshed),
);

const changedCases = [
  [
    "the load is doubled",
    { loadGroups: [tipLoad({ components: [0, -20000, 0] })] },
  ],
  [
    "a second load is added",
    {
      loadGroups: [
        tipLoad(),
        tipLoad({ id: 2, name: "Extra", faces: [face(3, 2, [3, 4])] }),
      ],
    },
  ],
  [
    "the load moves to another CAD face",
    { loadGroups: [tipLoad({ faces: [face(2, 5, [3, 4])] })] },
  ],
  [
    "the load becomes a pressure",
    { loadGroups: [tipLoad({ kind: "pressure", components: undefined })] },
  ],
  ["the support is removed", { bcGroups: [] }],
  ["the clamp becomes a roller", { bcGroups: [clamp({ dofs: [0] })] }],
  [
    "a second support is added at the tip",
    { bcGroups: [clamp(), clamp({ id: 2, faces: [face(4, 2, [3, 4])] })] },
  ],
  [
    "the support is picked as an edge",
    {
      bcGroups: [
        clamp({ faces: [{ ...face(1, 1, [1, 2]), cadFaceId: undefined }] }),
      ],
    },
  ],
  [
    "the material is aluminium",
    { materials: [{ id: 1, name: "Aluminium", young: 70000, poisson: 0.33 }] },
  ],
];
for (const [name, overrides] of changedCases) {
  const outcome = evaluateHandCheck(handCheck, model(overrides));
  check(
    `${name}: withheld`,
    outcome?.kind === "changed",
    JSON.stringify(outcome),
  );
}

check(
  "deleting the probed load group drops the check",
  evaluateHandCheck(handCheck, model({ loadGroups: [] })) === null,
);

let parseError = "";
try {
  parseHandCheck({
    quantity: "Tip deflection",
    probe: { loadGroupId: 1, component: 1 },
    formula: "−P·L³ / (3·E·I)",
    reference: -1.905,
    assumes: { force: [0, -10000, 0], young: 210000 },
  });
} catch (err) {
  parseError = err.message;
}
check(
  "a check without its load list is rejected with the field named",
  parseError.includes("handCheck.assumes.loads must be an array"),
  parseError,
);

if (failures > 0) {
  console.log(`\n${failures} hand check test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll hand check tests passed");

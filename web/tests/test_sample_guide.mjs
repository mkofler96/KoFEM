// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/sampleGuide.ts — the guide through the empty
// workspace's sample (KOF-261): which step the model is on, and that the CAD
// faces it asks the user to pick are the bolt holes and the hub bore of the
// shipped wall bracket. The browser path is tests/first-simulation.spec.ts.
//
// Run:  bun tests/test_sample_guide.mjs   (from the web/ directory)

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { SAMPLE, guideStep, guideTargets } from "../src/lib/sampleGuide.ts";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const face = (cadFaceId) => ({
  id: cadFaceId,
  label: `Face ${cadFaceId}`,
  nodeIds: [cadFaceId],
  geometry: "face",
  cadFaceId,
});
const support = (faces, dofs = [0, 1, 2], value = 0) => ({
  id: 1,
  name: "BC1",
  dofs,
  value,
  faces: faces.map(face),
});
const force = (faces, components = [0, -2000, 0], kind = "force") => ({
  id: 1,
  name: "Load1",
  dof: 1,
  totalForce: components[1],
  components,
  kind,
  faces: faces.map(face),
});
const holes = [...SAMPLE.boltHoleFaces];
const bore = [...SAMPLE.hubBoreFaces];
const step = (model) =>
  guideStep({
    meshed: true,
    bcGroups: [],
    loadGroups: [],
    solved: false,
    ...model,
  });

console.log("\nSteps");
check("no mesh: mesh", step({ meshed: false }) === "mesh");
check("meshed, nothing else: support", step({}) === "support");
check(
  "two of the three holes: still support",
  step({ bcGroups: [support(holes.slice(0, 2))] }) === "support",
);
check(
  "all three holes, in two supports: load",
  step({
    bcGroups: [support(holes.slice(0, 1)), support(holes.slice(1))],
  }) === "load",
);
check(
  "holes held in Ux only: still support",
  step({ bcGroups: [support(holes, [0])] }) === "support",
);
check(
  "holes moved by a prescribed displacement: still support",
  step({ bcGroups: [support(holes, [0, 1, 2], 0.1)] }) === "support",
);
const fixed = { bcGroups: [support(holes)] };
check(
  "a force on the wrong face: still load",
  step({ ...fixed, loadGroups: [force([1])] }) === "load",
);
check(
  "a zero force on the bore: still load",
  step({ ...fixed, loadGroups: [force(bore, [0, 0, 0])] }) === "load",
);
check(
  "a pressure on the bore: still load",
  step({ ...fixed, loadGroups: [force(bore, [0, 0, 0], "pressure")] }) ===
    "load",
);
const loaded = { ...fixed, loadGroups: [force(bore, [500, 0, 0])] };
check("any force on the bore: run", step(loaded) === "run");
check("solved: done", step({ ...loaded, solved: true }) === "done");
check(
  "a result without the setup does not skip a step",
  step({ solved: true }) === "support",
);
check(
  "targets: the holes, then the bore, else none",
  guideTargets("support") === SAMPLE.boltHoleFaces &&
    guideTargets("load") === SAMPLE.hubBoreFaces &&
    guideTargets("mesh") === null &&
    guideTargets("run") === null &&
    guideTargets("done") === null,
);

// The guide names faces by number, and those numbers are only right for the
// file the app ships. Mesh it the way the app does and check them.
console.log("\nThe shipped wall bracket");
const here = dirname(fileURLToPath(import.meta.url));
const wasmPkg = join(here, "../src/wasm/pkg");
const { default: createModule } = await import(
  join(wasmPkg, "kofem_wasm_emcc.js")
);
const Module = await createModule({
  wasmBinary: readFileSync(join(wasmPkg, "kofem_wasm_emcc.wasm")).buffer,
  print: () => {},
  printErr: (t) => console.error("[wasm:err]", t),
});
Module.tessellate_step(
  new Uint8Array(readFileSync(join(here, "../public", SAMPLE.url))),
  JSON.stringify({ deflection_relative: 0.001, angular_deflection: 0.5 }),
);
const mesh = Module.generate_fem_mesh(
  JSON.stringify({
    max_element_size: 20,
    min_element_size: 2,
    grading: 0.3,
    second_order: false,
    elementsperedge: 2.0,
    elementspercurve: 2.0,
    optsteps_2d: 3,
    optsteps_3d: 3,
  }),
);
Module.free_geometry_cache();

// The mesh's points on CAD face `id`, and the cylinder they lie on: the axis
// along `axis`, through the middle of the points' extent across it.
function cylinder(id, axis) {
  const nodes = new Set();
  mesh.surfaceFaceIds.forEach((f, t) => {
    if (f === id)
      for (let k = 0; k < 3; k++) nodes.add(mesh.surfaceTriangles[3 * t + k]);
  });
  const pts = [...nodes].map((n) =>
    [0, 1, 2].map((k) => mesh.vertices[3 * n + k]),
  );
  const across = [0, 1, 2].filter((k) => k !== axis);
  const lo = (k) => Math.min(...pts.map((p) => p[k]));
  const hi = (k) => Math.max(...pts.map((p) => p[k]));
  const centre = across.map((k) => (lo(k) + hi(k)) / 2);
  const radii = pts.map((p) =>
    Math.hypot(p[across[0]] - centre[0], p[across[1]] - centre[1]),
  );
  return {
    centre,
    length: hi(axis) - lo(axis),
    rMin: Math.min(...radii),
    rMax: Math.max(...radii),
  };
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Bolt holes: Ø16 mm through the 10 mm wall plate (normal x), at
// (y, z) = (±38, −20) and (0, −118).
const holeCentres = holes.map((id) => {
  const bolt = cylinder(id, 0);
  check(
    `face ${id} is a Ø16 bore through the 10 mm plate`,
    bolt.rMin > 7.9 && bolt.rMax < 8.1 && near(bolt.length, 10, 0.01),
    JSON.stringify(bolt),
  );
  return bolt.centre.map((v) => Math.round(v)).join(",");
});
check(
  "…at the three bolt positions",
  holeCentres.sort().join(" ") === "-38,-20 0,-118 38,-20",
  holeCentres.join(" "),
);

// Hub bore: Ø20 mm along z, the full 54 mm length of the hub.
const hub = cylinder(bore[0], 2);
check(
  `face ${bore[0]} is the Ø20 bore through the hub`,
  bore.length === 1 &&
    hub.rMin > 9.9 &&
    hub.rMax < 10.1 &&
    near(hub.length, 54, 0.01) &&
    near(hub.centre[0], 85, 0.01) &&
    near(hub.centre[1], 0, 0.01),
  JSON.stringify(hub),
);

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll sample guide checks passed");

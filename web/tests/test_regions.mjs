#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit test for bodies and their regions (src/lib/regions.ts, KOF-257): body
// grouping and names, region element sizes, the optimizer's passive elements,
// and the mesh-type label.
//
// Run: bun tests/test_regions.mjs   (from the web/ directory)

import {
  bodyGroups,
  nextBodyNumber,
  passiveElements,
  regionMaxSizes,
  sameBody,
  solidName,
  solidsWithOwnSize,
} from "../src/lib/regions.ts";
import { meshKind, meshSizesChanged } from "../src/store/geometrySlice.ts";

let failed = 0;
function check(label, ok, detail = "") {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failed++;
}
function throws(label, fn, pattern) {
  try {
    fn();
    check(label, false, "did not throw");
  } catch (err) {
    check(label, pattern.test(err.message), err.message);
  }
}

// Body 1 split into solids 1 and 2; solid 3 is Body 2; solid 4 is a shell
// section the mesh derived from solid 2.
const props = [
  { id: 1, materialId: 1, body: 1 },
  { id: 2, materialId: 1, body: 1, optimizationRole: "solid" },
  { id: 3, materialId: 1, body: 2, optimizationRole: "void" },
  { id: 4, materialId: 1, sourceBodyId: 2, thickness: 2 },
];

const groups = bodyGroups(props);
check(
  "solids group into bodies; a derived shell section is not a region",
  JSON.stringify(groups.map((g) => [g.body, g.regions.map((r) => r.id)])) ===
    "[[1,[1,2]],[2,[3]]]",
  JSON.stringify(groups),
);
check(
  "a solid without a body number is a body of its own",
  JSON.stringify(
    bodyGroups([
      { id: 1, materialId: 1 },
      { id: 2, materialId: 1 },
    ]).map((g) => g.body),
  ) === "[1,2]",
);
check(
  "names: a region of a split body, a one-region body",
  solidName(props, 2) === "Body 1 · Region 2" &&
    solidName(props, 3) === "Body 2",
);
check("same body", sameBody(props, 1, 2) && !sameBody(props, 2, 3));
check("next body number", nextBodyNumber(props) === 3);
throws(
  "naming a solid that is not in the model throws",
  () => solidName(props, 9),
  /Region 9 is not a CAD solid/,
);

check(
  "region sizes: only the regions that set one",
  JSON.stringify([
    ...regionMaxSizes([
      { id: 1, materialId: 1, maxElementSize: "2.5" },
      { id: 2, materialId: 1, maxElementSize: " " },
      { id: 3, materialId: 1 },
    ]),
  ]) === "[[1,2.5]]",
);
check(
  "own sizes: the CAD solids that set one, not blanks or shell sections",
  JSON.stringify(
    solidsWithOwnSize([
      { id: 3, materialId: 1, maxElementSize: "4" },
      { id: 1, materialId: 1, maxElementSize: "2.5" },
      { id: 2, materialId: 1, maxElementSize: " " },
      { id: 4, materialId: 1, sourceBodyId: 1, maxElementSize: "1" },
    ]).map((p) => p.id),
  ) === "[1,3]",
);
throws(
  "a region size that is not a positive number is refused, naming the region",
  () =>
    regionMaxSizes([
      { id: 1, materialId: 1, body: 1 },
      { id: 2, materialId: 1, body: 1, maxElementSize: "-1" },
    ]),
  /Body 1 · Region 2 must be a positive number of mm — got "-1"/,
);

// Elements in store order: a hex of solid 1, tets of solids 1/2/3, and a
// facet of the shell section of solid 2. Design order: tets, hexes, facets.
const elements = [
  { id: 1, type: "CHEXA", nodeIds: [], propertyId: 1 },
  { id: 2, type: "CTETRA", nodeIds: [], propertyId: 1 },
  { id: 3, type: "CTETRA", nodeIds: [], propertyId: 2 },
  { id: 4, type: "CTETRA", nodeIds: [], propertyId: 3 },
  { id: 5, type: "CTRIA3", nodeIds: [], propertyId: 4 },
];
const passive = passiveElements(elements, props);
check(
  "passive elements in design order; a shell section takes its region's role",
  JSON.stringify(passive) === '{"solid":[1,4],"void":[2]}',
  JSON.stringify(passive),
);
check(
  "every region a design region: nothing passive",
  passiveElements(elements, [
    { id: 1, materialId: 1 },
    { id: 2, materialId: 1 },
    { id: 3, materialId: 1 },
    { id: 4, materialId: 1, sourceBodyId: 2 },
  ]) === undefined,
);
throws(
  "an element of an unknown property is refused",
  () =>
    passiveElements(
      [{ id: 1, type: "CTETRA", nodeIds: [], propertyId: 7 }],
      props,
    ),
  /property 7 is not in the model's property table/,
);

check(
  "mesh kind from its elements",
  meshKind([{ type: "CTETRA" }]) === "volume" &&
    meshKind([{ type: "CTRIA3" }]) === "shell" &&
    meshKind([{ type: "CTETRA" }, { type: "CTRIA3" }]) === "mixed",
);

const meshed = { max: 5, min: 0.5, regions: { 2: 1 } };
const withSize = (size) =>
  props.map((p) => (p.id === 2 ? { ...p, maxElementSize: size } : p));
check(
  "mesh sizes: unchanged settings match the mesh",
  !meshSizesChanged(meshed, "5", "0.5", withSize("1")),
);
check(
  "mesh sizes: a changed region size, or a region size cleared, is a change",
  meshSizesChanged(meshed, "5", "0.5", withSize("2")) &&
    meshSizesChanged(meshed, "5", "0.5", withSize("")),
);

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll region checks passed");

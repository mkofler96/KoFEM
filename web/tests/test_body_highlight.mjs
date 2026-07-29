// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/bodyHighlight.ts — resolving a hovered Bodies-panel
// row to the CAD body the geometry view can highlight.
//
// The viewport expresses a highlight as "dim every body except this one", so an
// id that no tessellated body carries fades the whole assembly to 15 % opacity
// and the model reads as gone. The resolver is what keeps that from happening:
// a mesh-time PSHELL resolves back to the body it was idealised from, and
// anything still unmatched resolves to null (highlight nothing) rather than to
// an id nobody has.
//
// Run:  bun tests/test_body_highlight.mjs

import {
  resolveHighlightedBody,
  tessellationBodyIds,
} from "../src/lib/bodyHighlight.ts";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Two CAD bodies; body 2 is thin-walled and was idealised at mesh time, which
// appended PSHELL id 3 (the fin_two_parts.step shape of the model).
const tessellation = {
  points: [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ],
  triangles: [
    [0, 1, 2],
    [0, 1, 2],
  ],
  bodyIds: [1, 2],
};
const properties = [
  { id: 1, materialId: 1, discretization: "solid" },
  { id: 2, materialId: 1, discretization: "shell" },
  {
    id: 3,
    materialId: 1,
    thickness: 2,
    discretization: "shell",
    sourceBodyId: 2,
  },
];

check(
  "tessellation body ids come from bodyIds",
  [...tessellationBodyIds(tessellation)].sort().join(",") === "1,2",
);
check(
  "a tessellation saved before per-body ids is all body 1",
  [...tessellationBodyIds({ ...tessellation, bodyIds: undefined })].join(
    ",",
  ) === "1",
);
check("no tessellation → no bodies", tessellationBodyIds(null).size === 0);

check(
  "a CAD body resolves to itself",
  resolveHighlightedBody(1, properties, tessellation) === 1,
);
check(
  "a derived PSHELL resolves to the body it was idealised from",
  resolveHighlightedBody(3, properties, tessellation) === 2,
);
check(
  "nothing hovered → nothing highlighted",
  resolveHighlightedBody(null, properties, tessellation) === null,
);
check(
  "a property the tessellation has no body for highlights nothing",
  resolveHighlightedBody(
    3,
    [...properties.slice(0, 2), { id: 3, materialId: 1, thickness: 2 }],
    tessellation,
  ) === null,
  "without sourceBodyId the PSHELL id must not be treated as a body id",
);
check(
  "a mesh with no CAD geometry behind it highlights nothing",
  resolveHighlightedBody(1, properties, null) === null,
);
check(
  "an empty tessellation highlights nothing",
  resolveHighlightedBody(1, properties, {
    ...tessellation,
    triangles: [],
    bodyIds: [],
  }) === null,
);

console.log(
  failures === 0 ? "\nAll checks passed" : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);

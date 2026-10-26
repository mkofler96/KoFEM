// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The "reproduce it in the app" model behind the validation page (/validation/).
//
// The cantilever case solved the way the app solves the gallery example
// /app/?example=cantilever-beam (examples/gallery/examples.mjs): the same beam
// and mesh in the app's units (mm · N · MPa), with the tip force applied as a
// work-equivalent surface traction over the end face (rebuildSurfaceLoads in
// web/src/store/boundarySlice.ts) instead of the case's equal nodal split. The page
// publishes what the app's Result summary then shows, and
// web/tests/validation-page.spec.ts checks the app shows exactly that.

import { boxHexMesh, nodesWhere, boxMaxXQuads } from "./lib/mesh.mjs";

const E = 210000; // MPa
const nu = 0.3;
const L = 1000, // mm
  b = 100,
  h = 100; // mm
const P = 1.0e4; // N, downward
const DIV = [40, 4, 4];
const I = (b * h ** 3) / 12;

export default {
  caseId: "cantilever",
  galleryId: "cantilever-beam",
  unit: "mm",
  reference: -(P * L ** 3) / (3 * E * I),
  // The app's Result summary: field Uy, row "Min Uy" (ResultsPanel.tsx), the
  // minimum over all nodes printed with toExponential(3).
  field: "Uy",
  stat: "Min Uy",
  run(solve) {
    const [nx, ny, nz] = DIV;
    const m = boxHexMesh(L, b, h, nx, ny, nz);
    const fixed = nodesWhere(m.vertices, (x) => x <= 1e-9);
    const loaded = nodesWhere(m.vertices, (x) => x >= L - 1e-9);
    const result = solve(
      { vertices: m.vertices, hexahedra: m.hexahedra },
      { young_modulus: E, poisson_ratio: nu, density: 7.85e-9 },
      {
        fixed_vertices: fixed,
        surface_loads: [
          {
            type: "force",
            force: [0, -P, 0],
            faces: boxMaxXQuads(m.nid, nx, ny, nz),
          },
        ],
      },
      1,
    );
    let minUy = Infinity;
    for (let v = 0; v < m.vertices.length; v++)
      minUy = Math.min(minUy, result.displacements[v * 3 + 1]);
    const faceMean =
      loaded.reduce((s, v) => s + result.displacements[v * 3 + 1], 0) /
      loaded.length;
    return { appValue: minUy, faceMean };
  },
};

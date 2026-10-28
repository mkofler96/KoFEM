// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The "reproduce it in the app" model behind the validation page (/validation/).
//
// The gallery example /app/?example=axial-bar (examples/gallery/examples.mjs)
// is the surface-traction case in the app's units (mm · N · MPa): the same bar
// and mesh, the force applied as a work-equivalent surface traction over the
// end face (rebuildSurfaceLoads in web/src/store/boundarySlice.ts). This solves
// it as the app does; the page publishes what the app's Result summary shows
// after a fresh solve, and web/tests/validation-page.spec.ts checks the app
// shows exactly that.

import { boxHexMesh, nodesWhere, boxMaxXQuads } from "./lib/mesh.mjs";

const E = 210000; // MPa
const nu = 0.3;
const L = 1000, // mm
  W = 100,
  H = 100; // mm
const P = 1.0e6; // N, +x
const DIV = [20, 4, 4];

export default {
  caseId: "surface-traction",
  galleryId: "axial-bar",
  title: "the axial bar",
  unit: "mm",
  reference: (P * L) / (E * (W * H)),
  // The app's Result summary: field Ux, row "Max Ux" (ResultsPanel.tsx), the
  // maximum over all nodes printed with toExponential(3).
  field: "Ux",
  stat: "Max Ux",
  run(solve) {
    const [nx, ny, nz] = DIV;
    const m = boxHexMesh(L, W, H, nx, ny, nz);
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
            force: [P, 0, 0],
            faces: boxMaxXQuads(m.nid, nx, ny, nz),
          },
        ],
      },
      1,
    );
    let maxUx = -Infinity;
    for (let v = 0; v < m.vertices.length; v++)
      maxUx = Math.max(maxUx, result.displacements[v * 3]);
    const faceMean =
      loaded.reduce((s, v) => s + result.displacements[v * 3], 0) /
      loaded.length;
    return { appValue: maxUx, faceMean };
  },
};

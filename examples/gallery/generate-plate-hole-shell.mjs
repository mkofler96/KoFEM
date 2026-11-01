// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Generates the SHELL version of the plate with a hole,
// /examples/plate-with-hole-shell/:
//
//   plate-with-hole-shell.vtu — a complete KoFEM analysis (CTRIA3 shell mesh +
//                               PSHELL property with thickness + BC/load groups
//                               + solved fields). This is what "Open in KoFEM"
//                               loads, and the app re-solves it through its
//                               pure-shell solve path.
//   plate-with-hole-shell.png — the page's figure;
//   showcase/plate-with-hole-shell.json — the numbers on the page.
//
// It is the exact same Kirsch stress-concentration problem as the solid
// `plate-with-hole` benchmark — same geometry, material and remote tension —
// but the through-thickness hexes are replaced by a single-layer Kirchhoff
// shell (DKT bending + CST membrane) mid-surface. Loaded in its own plane the
// shell reduces to plane stress, so the peak facet stress at the hole edge
// still approaches Kirsch's Kt = 3.
//
//   bun examples/gallery/generate-plate-hole-shell.mjs
//
// It has its own generator because the validation runner only knows solid
// hex meshes and solve_linear_elastic. Regenerate the pages afterwards
// (bun run validate:report).

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEngine } from "../shell-coupling/lib.mjs";
import { plateWithHoleShellMesh, nodesWhere } from "../validation/lib/mesh.mjs";
import { appReadout } from "../validation/lib/app-model.mjs";
import { resultFigure } from "../validation/lib/render.mjs";
import { writeShowcase } from "../validation/catalog.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "site");

// Same canonical mm/MPa system and geometry as the solid plate with a hole
// (examples/validation/cases/plate-with-hole.mjs): steel, a/b = 0.1 ⇒
// ≈ infinite-plate Kt, σ = 100 MPa tension.
const STEEL = { young_modulus: 210000, poisson_ratio: 0.3, density: 7.85e-9 };
const a = 1000, // hole radius (mm)
  b = 10000, // plate half-width (mm)
  t = 500, // shell thickness (mm)
  sigma = 100; // remote tension (MPa)

const m = plateWithHoleShellMesh(a, b, 12, 64, 2);
const nNodes = m.vertices.length;

// Fix the left edge (all 6 DOF); pull the right edge in +x with the remote
// tension σ as a work-equivalent line load q = σ·t along the edge: each edge
// segment contributes q·L/2 to its two end nodes (consistent nodal load of a
// uniform line load on linear shape functions), so the graded node spacing is
// honoured and the resultant is the gross axial force P = σ·(2b·t). This is
// applied per edge segment — NOT as an equal nodal split — and mirrors the
// app's shell solve path 1:1: the saved load group re-derives the same edge
// segments (boundarySlice loadedFaces edge fallback) and the same q·L/2 split
// (solver.worker.ts distributeShellSurfaceLoad), so reopening the .vtu and
// re-solving reproduces this exact field.
const left = nodesWhere(m.vertices, (x) => x <= -b + 1e-6);
const right = nodesWhere(m.vertices, (x) => x >= b - 1e-6).sort(
  (i, j) => m.vertices[i][1] - m.vertices[j][1],
);
const P = sigma * (2 * b * t);
const q = sigma * t; // line load along the edge (force per unit length)
const forceAt = new Map(right.map((vertex) => [vertex, 0]));
for (let k = 0; k + 1 < right.length; k++) {
  const L = m.vertices[right[k + 1]][1] - m.vertices[right[k]][1];
  forceAt.set(right[k], forceAt.get(right[k]) + (q * L) / 2);
  forceAt.set(right[k + 1], forceAt.get(right[k + 1]) + (q * L) / 2);
}
const point_loads = [...forceAt.entries()].map(([vertex, fx]) => ({
  vertex,
  force: [fx, 0, 0],
}));

const Module = await loadEngine();
const r = Module.solve_shell(
  {
    vertices: Float64Array.from(m.vertices.flat()),
    triangles: Int32Array.from(m.triangles.flat()),
  },
  JSON.stringify({ ...STEEL, thickness: t }),
  JSON.stringify({ fixed_vertices: left, point_loads }),
);
if ("error" in r) throw new Error(r.error);

// Peak facet von Mises sits in the hole-ring elements — the first 2·nth triangles
// (two per ring quad). Kt = peak / σ.
const holeRing = 2 * m.nth;
let peak = 0;
for (let e = 0; e < holeRing; e++) peak = Math.max(peak, r.von_mises[e]);
const Kt = peak / sigma;
const errPct = (Math.abs(Kt - 3.0) / 3.0) * 100;

// ── Analysis file (.vtu) — matches web/src/lib/analysisFile.ts ─────────────────

function encodeKofemFieldData(jsonText) {
  const data = Buffer.from(jsonText, "utf8");
  const bytes = Buffer.alloc(4 + data.length);
  bytes.writeUInt32LE(data.length, 0);
  data.copy(bytes, 4);
  return { b64: bytes.toString("base64"), byteLength: data.length };
}

function joinTuples(values, stride) {
  const lines = [];
  for (let i = 0; i < values.length; i += stride)
    lines.push(values.slice(i, i + stride).join(" "));
  return lines.join("\n");
}

function dataArray(type, name, body, components) {
  const comp =
    components !== undefined ? ` NumberOfComponents="${components}"` : "";
  return `<DataArray type="${type}" Name="${name}"${comp} format="ascii">\n${body}\n</DataArray>`;
}

function buildShellVtu() {
  const nCells = m.triangles.length;
  // Node / element IDs are 1-based; BC/load group faces reference these IDs.
  const fixedIds = left.map((v) => v + 1);
  const loadIds = right.map((v) => v + 1);

  const meta = {
    format: "kofem-analysis",
    version: 1,
    modelName: "Plate with a hole — shells",
    mode: "results",
    viewRepr: "surface",
    resultType: "Von Mises stress",
    elementTypes: m.triangles.map(() => "CTRIA3"),
    materials: [
      {
        id: 1,
        name: "Steel",
        young: STEEL.young_modulus,
        poisson: STEEL.poisson_ratio,
        density: STEEL.density,
      },
    ],
    // PSHELL: the shell thickness is a section property of the idealised wall.
    properties: [{ id: 1, type: "PSHELL", materialId: 1, thickness: t }],
    bcGroups: [
      {
        id: 1,
        name: "BC1",
        // All six DOFs — shell nodes carry rotations; the left edge is clamped.
        dofs: [0, 1, 2, 3, 4, 5],
        value: 0,
        faces: [
          {
            id: 1,
            label: `Fixed edge (${fixedIds.length} nodes)`,
            nodeIds: fixedIds,
          },
        ],
      },
    ],
    loadGroups: [
      {
        id: 1,
        name: "Load1",
        dof: 0,
        totalForce: P,
        kind: "force",
        faces: [
          {
            id: 2,
            label: `Tension (+X) (${loadIds.length} nodes)`,
            nodeIds: loadIds,
          },
        ],
      },
    ],
    nextBcGroupId: 2,
    nextLoadGroupId: 2,
    nextFaceEntryId: 3,
    nextMatId: 2,
    stepSurface: null,
    volMesh: null,
    surfaceTriangles: null,
    surfaceFaceIds: null,
  };

  const connectivity = [];
  const offsets = [];
  let offset = 0;
  for (const tri of m.triangles) {
    connectivity.push(tri.join(" "));
    offset += tri.length;
    offsets.push(offset);
  }
  const types = m.triangles.map(() => 5); // VTK_TRIANGLE

  const points = m.vertices.map((v) => `${v[0]} ${v[1]} ${v[2]}`).join("\n");
  const nodeIds = m.vertices.map((_, i) => i + 1).join(" ");
  const elementIds = m.triangles.map((_, i) => i + 1).join(" ");
  const propertyIds = m.triangles.map(() => 1).join(" ");
  const encoded = encodeKofemFieldData(JSON.stringify(meta));

  return [
    `<?xml version="1.0"?>`,
    `<VTKFile type="UnstructuredGrid" version="1.0" byte_order="LittleEndian" header_type="UInt32">`,
    `<UnstructuredGrid>`,
    `<FieldData>`,
    `<DataArray type="UInt8" Name="KoFEM" NumberOfTuples="${encoded.byteLength}" format="binary">`,
    encoded.b64,
    `</DataArray>`,
    `</FieldData>`,
    `<Piece NumberOfPoints="${nNodes}" NumberOfCells="${nCells}">`,
    `<Points>`,
    dataArray("Float64", "Points", points, 3),
    `</Points>`,
    `<Cells>`,
    dataArray("Int64", "connectivity", connectivity.join("\n")),
    dataArray("Int64", "offsets", offsets.join(" ")),
    dataArray("UInt8", "types", types.join(" ")),
    `</Cells>`,
    `<PointData>`,
    dataArray("Int64", "NodeId", nodeIds),
    dataArray("Float64", "Displacement", joinTuples(r.displacements, 3), 3),
    `</PointData>`,
    `<CellData>`,
    dataArray("Int64", "ElementId", elementIds),
    dataArray("Int64", "PropertyId", propertyIds),
    dataArray("Float64", "VonMises", joinTuples(r.von_mises, 1)),
    `</CellData>`,
    `</Piece>`,
    `</UnstructuredGrid>`,
    `</VTKFile>`,
    ``,
  ].join("\n");
}

// ── The example page: record and figure ────────────────────────────────────────
// The figure: the facet von Mises stress averaged to the nodes (as the app
// averages it), face-on around the hole, like the solid plate's.
const disp = r.displacements;
const vmSum = new Float64Array(nNodes);
const vmCount = new Uint32Array(nNodes);
m.triangles.forEach((tri, e) => {
  for (const v of tri) {
    vmSum[v] += r.von_mises[e];
    vmCount[v]++;
  }
});
const { png, meta: figure } = resultFigure(
  {
    positions: m.vertices.flat(),
    displacements: Array.from(disp),
    scalars: Array.from(vmSum, (sum, v) => sum / vmCount[v]),
    triangles: m.triangles.flat(),
  },
  {
    field: "vonMises",
    unit: "MPa",
    view: [0, 0, -1],
    deform: false,
    focus: { center: [0, 0, 0], half: 3200, aspect: 0.6 },
  },
);

writeFileSync(join(outDir, "plate-with-hole-shell.vtu"), buildShellVtu());
writeShowcase(
  {
    id: "plate-with-hole-shell",
    name: "Plate with a hole, shell elements",
    script: "examples:generate-plate-hole-shell",
    quantity: "stress-concentration factor Kt",
    unit: "",
    reference: 3,
    referenceLabel: "Kt = 3 (infinite plate)",
    fe: Kt,
    errPct: ((Kt - 3) / 3) * 100,
    inputs: [
      { symbol: "a", value: a, unit: "mm" },
      { symbol: "b", value: b, unit: "mm" },
      { symbol: "t", value: t, unit: "mm" },
      { symbol: "E", value: STEEL.young_modulus, unit: "MPa" },
      { symbol: "ν", value: STEEL.poisson_ratio, unit: "" },
      { symbol: "σ", value: sigma, unit: "MPa" },
    ],
    mesh: {
      elements: `${m.triangles.length.toLocaleString("en-US")} 3-node Kirchhoff shell triangles (DKT bending, CST membrane)`,
      nodes: nNodes,
      dofs: 6 * nNodes,
      rings: m.nr,
      around: m.nth,
    },
    readout: {
      field: "Ux",
      stat: "Max",
      value: appReadout({ displacements: disp }, "Ux", "Max"),
    },
    figure,
    page: {
      summary:
        "The same plate as a single layer of shell triangles on its mid-surface instead of solid elements.",
      model:
        "Square plate of half-width b and thickness t, central hole of radius a, as a mid-surface.",
      supports: "x = −b edge fixed (all six DOFs).",
      loads: "σ·2b·t in +x as a force on the x = +b edge.",
      measured: "Peak facet von Mises stress around the hole, divided by σ.",
      mesh: `O-grid, ${m.nr} rings × ${m.nth} around the hole, two triangles per quad`,
      source: "Kirsch (1898); Timoshenko & Goodier",
    },
  },
  png,
);
console.log(
  `plate-with-hole-shell: ${r.iterations} it, ${nNodes} nodes, ` +
    `${m.triangles.length} triangles, Kt=${Kt.toFixed(3)} (err ${errPct.toFixed(1)}%) → plate-with-hole-shell.{vtu,png} + showcase/plate-with-hole-shell.json`,
);

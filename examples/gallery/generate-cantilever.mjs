// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Generates the cantilever beam: the gallery's bending check and the sample the
// app offers a first-time user ("Try a sample simulation", KOF-261). It is built
// with KoFEM's own pipeline — STEP geometry → OCCT tessellation → Netgen volume
// mesh → MFEM solve — by the steps a user takes in the app:
//
//   1. Geometry → import a plain 1000 × 100 × 100 mm block (six faces).
//   2. Mesh with a 25 mm max element size and quadratic (2nd-order) elements.
//   3. Constraints: the end face x = 0 fixed (Ux Uy Uz);
//      Loads: Fy = −10 kN on the free end face x = 1000.
//   4. Static study → Run.
//
// No split is needed: both end faces are whole CAD faces, so the support and the
// load follow them through a re-mesh.
//
//   cantilever-beam.step — the block, as a user would import it.
//   cantilever-beam.vtu  — what "Open in KoFEM web" and the app's sample button
//                          load: geometry, mesh, support, load and the static
//                          study, UNSOLVED — it opens on the study, ready to run.
//                          It also carries the hand check (δ = P·L³ / (3·E·I))
//                          the Results panel compares the solved tip deflection
//                          with. The .step next to it is restored by the app, so
//                          the model can be re-meshed.
//   examples.json        — the gallery card, solved here so the card can show
//                          the deformed beam and the FE-vs-hand-calculation error.
//
// Quadratic tetrahedra, because linear ones lock in bending: at 25 mm a linear
// mesh gives a tip deflection ~15 % short of δ, the quadratic one matches it.
// The hex-mesh version of this check stays a regression benchmark in
// examples/validation/.
//
//   bun examples/gallery/generate-cantilever.mjs
//
// It replaces the "cantilever-beam" entry of examples.json in place, leaving the
// other entries untouched. Netgen is not bit-reproducible across builds, so a
// re-run can move the numbers on the card slightly.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEngine } from "../shell-coupling/lib.mjs";
import { prismStep } from "./step-prism.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "site");
const ID = "cantilever-beam";
const TITLE = "Cantilever beam under tip load";

// Canonical N · mm · MPa system; steel exactly as the app seeds it.
const STEEL = {
  id: 1,
  name: "Steel",
  young: 210000,
  poisson: 0.3,
  density: 7.85e-9,
};
const L = 1000; // length along x (mm)
const H = 100; // section height along y (mm)
const B = 100; // section width along z (mm)
const P = 10000; // tip load (N), downward (−y)
const MAX_ELEMENT_SIZE = 25; // mm — four elements through the section
const ELEMENT_ORDER = 2;

// Euler–Bernoulli tip deflection of a cantilever under an end load.
const I = (B * H ** 3) / 12;
const REFERENCE = -(P * L ** 3) / (3 * STEEL.young * I);

// ── Geometry: the plain block a user imports ──────────────────────────────────
const step = prismStep(
  [
    [0, 0],
    [L, 0],
    [L, H],
    [0, H],
  ],
  B,
  "Cantilever beam",
);
const mesher = await loadEngine();
const tess = mesher.tessellate_step(
  new TextEncoder().encode(step),
  JSON.stringify({
    deflection_relative: 0.001,
    angular_deflection: 0.5,
    format: "step",
  }),
);

// ── Mesh, with the exact options the app's worker uses ────────────────────────
const dto = mesher.generate_fem_mesh(
  JSON.stringify({
    max_element_size: MAX_ELEMENT_SIZE,
    min_element_size: MAX_ELEMENT_SIZE / 10,
    grading: 0.3,
    second_order: false,
    elementsperedge: 2.0,
    elementspercurve: 2.0,
    optsteps_2d: 3,
    optsteps_3d: 3,
  }),
);
const V = Array.from(dto.vertices);
const tets = Array.from(dto.tetrahedra);
const surfTri = Array.from(dto.surfaceTriangles);
const surfFace = Array.from(dto.surfaceFaceIds);
const nNodes = V.length / 3;
const nTets = tets.length / 4;

// The CAD face whose surface triangles all satisfy `pred` — the face a user
// clicks to pick it. Exactly one must match.
function cadFaceWhere(label, pred) {
  const inside = new Set();
  const outside = new Set();
  for (let t = 0; t < surfFace.length; t++) {
    const onIt = [0, 1, 2].every((k) => {
      const v = surfTri[3 * t + k];
      return pred(V[3 * v], V[3 * v + 1], V[3 * v + 2]);
    });
    (onIt ? inside : outside).add(surfFace[t]);
  }
  const exact = [...inside].filter((id) => !outside.has(id));
  if (exact.length !== 1)
    throw new Error(
      `${label}: expected exactly one CAD face, found [${exact.join(", ")}]`,
    );
  return exact[0];
}
const eps = 1e-6;
const fixedFace = cadFaceWhere("clamped end", (x) => Math.abs(x) < eps);
const loadFace = cadFaceWhere("free end", (x) => Math.abs(x - L) < eps);
const nodesOfFace = (id) => {
  const s = new Set();
  for (let t = 0; t < surfFace.length; t++)
    if (surfFace[t] === id)
      for (let k = 0; k < 3; k++) s.add(surfTri[3 * t + k]);
  return [...s].sort((a, b) => a - b);
};
const fixedNodes = nodesOfFace(fixedFace);
const loadNodes = nodesOfFace(loadFace);
const loadTris = [];
for (let t = 0; t < surfFace.length; t++)
  if (surfFace[t] === loadFace)
    loadTris.push([surfTri[3 * t], surfTri[3 * t + 1], surfTri[3 * t + 2]]);

// ── Solve ─────────────────────────────────────────────────────────────────────
// Node ids equal vertex indices (as after meshing in the app), so these BCs are
// what the worker's groupDirichlet / rebuildSurfaceLoads build from the groups
// written below. A fresh engine instance runs the solve: the app resets its
// worker after meshing because Netgen's global state contaminates MFEM.
const solver = await loadEngine();
const t0 = performance.now();
const result = solver.solve_linear_elastic(
  {
    vertices: Float64Array.from(V),
    tetrahedra: Int32Array.from(tets),
    hexahedra: new Int32Array(0),
  },
  JSON.stringify([
    { young_modulus: STEEL.young, poisson_ratio: STEEL.poisson },
  ]),
  JSON.stringify({
    fixed_vertices: fixedNodes,
    point_loads: [],
    surface_loads: [{ type: "force", force: [0, -P, 0], faces: loadTris }],
  }),
  ELEMENT_ORDER,
);
if ("error" in result) throw new Error(result.error);
const seconds = (performance.now() - t0) / 1000;
const disp = Array.from(result.displacements);
if (disp.length !== 3 * nNodes)
  throw new Error(
    `solve returned ${disp.length / 3} displacements for ${nNodes} nodes`,
  );
// The tip deflection the app's hand check reads: mean Uy over the loaded face.
const feValue =
  loadNodes.reduce((sum, v) => sum + disp[3 * v + 1], 0) / loadNodes.length;
const errPct = Math.abs((feValue - REFERENCE) / REFERENCE) * 100;
if (errPct > 2)
  throw new Error(
    `tip deflection ${feValue.toFixed(4)} mm is ${errPct.toFixed(1)}% off δ = ${REFERENCE.toFixed(4)} mm`,
  );

// ── Analysis file (.vtu) — matches web/src/lib/analysisFile.ts ─────────────────

function encodeKofemFieldData(jsonText) {
  const data = Buffer.from(jsonText, "utf8");
  const bytes = Buffer.alloc(4 + data.length);
  bytes.writeUInt32LE(data.length, 0);
  data.copy(bytes, 4);
  return { b64: bytes.toString("base64"), byteLength: data.length };
}

function dataArray(type, name, body, components) {
  const comp =
    components !== undefined ? ` NumberOfComponents="${components}"` : "";
  return `<DataArray type="${type}" Name="${name}"${comp} format="ascii">\n${body}\n</DataArray>`;
}

const chunk = (arr, n) =>
  Array.from({ length: arr.length / n }, (_, i) => arr.slice(n * i, n * i + n));

function buildVtu() {
  // Each entry is a whole CAD face, picked as one — so it carries the face id
  // and survives a re-mesh in the app (BcFaceEntry.cadFaceId).
  const faceEntry = (id, cadFaceId, nodeIds) => ({
    id,
    label: "Face 1",
    nodeIds,
    geometry: "face",
    cadFaceId,
  });
  const meta = {
    format: "kofem-analysis",
    version: 1,
    modelName: TITLE,
    // Opens on the static study: the first thing to do is press Run.
    mode: "solve",
    viewRepr: "surface",
    resultType: "Displacement (magnitude)",
    elementTypes: Array(nTets).fill("CTETRA"),
    materials: [STEEL],
    properties: [{ id: 1, materialId: 1, discretization: "solid" }],
    bcGroups: [
      {
        id: 1,
        name: "Clamped end",
        dofs: [0, 1, 2],
        value: 0,
        faces: [faceEntry(1, fixedFace, fixedNodes)],
      },
    ],
    loadGroups: [
      {
        id: 1,
        name: "Tip load",
        dof: 1,
        totalForce: -P,
        components: [0, -P, 0],
        kind: "force",
        faces: [faceEntry(2, loadFace, loadNodes)],
      },
    ],
    tieGroups: [],
    couplingGroups: [],
    nextBcGroupId: 2,
    nextLoadGroupId: 2,
    nextTieGroupId: 1,
    nextCouplingGroupId: 1,
    nextFaceEntryId: 3,
    nextMatId: 2,
    // The geometry and the CAD face of every boundary triangle, exactly as the
    // app holds them after import + mesh, so faces can be picked on the model.
    stepSurface: {
      points: chunk(Array.from(tess.vertices), 3),
      triangles: chunk(Array.from(tess.triangles), 3),
      bodyIds: Array.from(tess.triangleBodyIds),
      faceIds: Array.from(tess.triangleFaceIds),
    },
    volMesh: null,
    surfaceTriangles: chunk(surfTri, 3),
    surfaceFaceIds: surfFace,
    elementOrder: ELEMENT_ORDER,
    // The tip deflection, read as the mean Uy of the loaded end face.
    handCheck: {
      quantity: "Tip deflection",
      probe: { loadGroupId: 1, component: 1 },
      formula: "−P·L³ / (3·E·I)",
      reference: REFERENCE,
      assumes: { force: [0, -P, 0], young: STEEL.young },
    },
  };

  const encoded = encodeKofemFieldData(JSON.stringify(meta));
  const ids = (n) => Array.from({ length: n }, (_, i) => i).join(" ");
  return [
    `<?xml version="1.0"?>`,
    `<VTKFile type="UnstructuredGrid" version="1.0" byte_order="LittleEndian" header_type="UInt32">`,
    `<UnstructuredGrid>`,
    `<FieldData>`,
    `<DataArray type="UInt8" Name="KoFEM" NumberOfTuples="${encoded.byteLength}" format="binary">`,
    encoded.b64,
    `</DataArray>`,
    `</FieldData>`,
    `<Piece NumberOfPoints="${nNodes}" NumberOfCells="${nTets}">`,
    `<Points>`,
    dataArray(
      "Float64",
      "Points",
      chunk(V, 3)
        .map((p) => p.join(" "))
        .join("\n"),
      3,
    ),
    `</Points>`,
    `<Cells>`,
    dataArray(
      "Int64",
      "connectivity",
      chunk(tets, 4)
        .map((t) => t.join(" "))
        .join("\n"),
    ),
    dataArray(
      "Int64",
      "offsets",
      Array.from({ length: nTets }, (_, i) => 4 * (i + 1)).join(" "),
    ),
    dataArray("UInt8", "types", Array(nTets).fill(10).join(" ")), // VTK_TETRA
    `</Cells>`,
    `<PointData>`,
    dataArray("Int64", "NodeId", ids(nNodes)),
    `</PointData>`,
    `<CellData>`,
    dataArray("Int64", "ElementId", ids(nTets)),
    dataArray("Int64", "PropertyId", Array(nTets).fill(1).join(" ")),
    `</CellData>`,
    `</Piece>`,
    `</UnstructuredGrid>`,
    `</VTKFile>`,
    ``,
  ].join("\n");
}

// ── Gallery viewer: the solved boundary surface ───────────────────────────────
// Netgen's surface triangles are the tet boundary. The deformation scale matches
// the app's (TARGET_DEFORM_FRACTION = 0.2 of the model size).
const local = new Map();
const positions = [];
const displacements = [];
const magnitudes = [];
const triangles = [];
for (const v of surfTri) {
  if (!local.has(v)) {
    local.set(v, positions.length / 3);
    const [dx, dy, dz] = [disp[3 * v], disp[3 * v + 1], disp[3 * v + 2]];
    positions.push(V[3 * v], V[3 * v + 1], V[3 * v + 2]);
    displacements.push(dx, dy, dz);
    magnitudes.push(Math.hypot(dx, dy, dz));
  }
  triangles.push(local.get(v));
}
const maxComp = disp.reduce((m, d) => Math.max(m, Math.abs(d)), 0);
const round = (arr, p) => arr.map((x) => Number(x.toPrecision(p)));

const entry = {
  id: ID,
  title: TITLE,
  blurb:
    "A beam clamped at the wall with a transverse load over its free-end face — the classic Euler–Bernoulli bending check, δ = P·L³ / (3·E·I).",
  quantity: "tip deflection δ",
  unit: "mm",
  reference: REFERENCE,
  referenceLabel: "δ = P·L³ / (3·E·I)",
  feValue,
  errPct,
  colorLabel: "Displacement magnitude",
  viewer: {
    center: [L / 2, H / 2, B / 2],
    modelSize: L,
    deformScale: (0.2 * L) / maxComp,
    magMin: Math.min(...magnitudes),
    magMax: Math.max(...magnitudes),
    positions: round(positions, 7),
    displacements: round(displacements, 6),
    magnitudes: round(magnitudes, 6),
    triangles,
  },
};

writeFileSync(join(outDir, `${ID}.step`), step);
writeFileSync(join(outDir, `${ID}.vtu`), buildVtu());
const manifestPath = join(outDir, "examples.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const at = manifest.findIndex((e) => e.id === ID);
if (at >= 0) manifest[at] = entry;
else manifest.push(entry);
writeFileSync(manifestPath, JSON.stringify(manifest));

console.log(
  `${ID}: ${nNodes} nodes, ${nTets} tets, order ${ELEMENT_ORDER}; solved in ` +
    `${seconds.toFixed(1)} s; tip deflection ${feValue.toFixed(4)} mm vs ` +
    `δ = ${REFERENCE.toFixed(4)} mm (err ${errPct.toFixed(2)}%) → ${ID}.{step,vtu} + examples.json`,
);

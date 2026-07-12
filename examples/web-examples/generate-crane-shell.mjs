// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Generates the interactive gallery card for the coupled solid+shell crane
// showcase and merges it into web/public/examples/examples.json (the manifest
// the /examples/ gallery renders). Unlike the benchmark examples, this one meshes
// a STEP assembly, turns the thin holder into shells, and solves the coupled
// system — so it has its own generator rather than living in examples.mjs.
//
//   bun examples/web-examples/generate-crane-shell.mjs
//
// It appends/replaces the "crane-hook-shell" entry, leaving the benchmark
// entries produced by generate.mjs untouched.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadEngine,
  meshStep,
  extractThinWallShells,
  tieSolidBodies,
  buildCoupledModel,
} from "../shell-coupling/lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const STEP = join(here, "../../test_files/full-crane-hook.step");
const outDir = join(here, "../../web/public/examples");
const STEEL = { young_modulus: 210000, poisson_ratio: 0.3 };
const BC_FIXED_FACE = 7;
const LOAD_FACES = { 66: [0, -1000, 0], 67: [0, -1000, 0] };

const Module = await loadEngine();
const mesh = meshStep(Module, STEP, { maxElementSize: 6 });
const shells = extractThinWallShells(mesh);
const tie = tieSolidBodies(mesh, shells.shellBody);
const model = buildCoupledModel(mesh, shells, tie);
const nShell = model.shellPool.length;

// BCs + loads by CAD face (see crane-holder-shell.mjs). `fixedShellNodes` are the
// shell POOL nodes clamped on the holder's fixed edge — kept alongside the flat
// DOF list so the openable .vtu can persist them as a BC group (all 6 DOF).
const fixed = [];
const fixedShellNodes = [];
for (let s = 0; s < nShell; s++)
  if (shells.shellSrc[s] === BC_FIXED_FACE) {
    fixedShellNodes.push(model.shellPool[s]);
    for (let c = 0; c < 6; c++) fixed.push(6 * model.shellPool[s] + c);
  }
const loadNodes = new Map(Object.keys(LOAD_FACES).map((f) => [Number(f), new Set()]));
for (let t = 0; t < mesh.surfFace.length; t++) {
  const F = LOAD_FACES[mesh.surfFace[t]];
  if (!F) continue;
  for (const oi of [mesh.surfTri[3 * t], mesh.surfTri[3 * t + 1], mesh.surfTri[3 * t + 2]]) {
    const pi = model.solidPool.get(model.tied(oi));
    if (pi !== undefined) loadNodes.get(mesh.surfFace[t]).add(pi);
  }
}
const load_dofs = [], load_vals = [];
for (const [fid, F] of Object.entries(LOAD_FACES)) {
  const ns = [...loadNodes.get(Number(fid))];
  for (const pi of ns) for (let c = 0; c < 3; c++) if (F[c] !== 0) { load_dofs.push(6 * pi + c); load_vals.push(F[c] / ns.length); }
}

const r = Module.solve_coupled(
  { vertices: Float64Array.from(model.pool), tets: Int32Array.from(model.tets),
    triangles: Int32Array.from(model.triangles), thicknesses: Float64Array.from(model.thicknesses) },
  { ref: Int32Array.from(model.coupling.ref), offsets: Int32Array.from(model.coupling.offsets), solid: Int32Array.from(model.coupling.solid) },
  { fixed_dofs: Int32Array.from(fixed), load_dofs: Int32Array.from(load_dofs), load_vals: Float64Array.from(load_vals) },
  JSON.stringify({ solid: STEEL, shell: STEEL }),
);
if ("error" in r) throw new Error(r.error);
if (!r.von_mises_tets || !r.von_mises_tris)
  throw new Error("solve_coupled did not return per-element von Mises fields — rebuild the WASM engine");

// ── Openable analysis (.vtu) — a MIXED CTRIA3 + CTETRA model ───────────────────
//
// crane-hook-shell.vtu is a complete KoFEM analysis: the coupled node pool
// becomes the store nodes, the solid tets become CTETRA elements and the shell
// mid-surface facets become CTRIA3 elements (per-facet thickness on their PSHELL
// property). This is what the card's "Open in KoFEM web" button loads, and the
// app re-solves it through the worker's mixed shell/solid path (handleMixedSolve
// → solve_coupled), which re-derives the RBE3 couplings from proximity exactly as
// this generator does. The solved fields below are saved so the card opens
// straight into results; re-solving reproduces them. Matches the schema in
// web/src/lib/analysisFile.ts.

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
    lines.push([...values.slice(i, i + stride)].join(" "));
  return lines.join("\n");
}

function dataArray(type, name, body, components) {
  const comp =
    components !== undefined ? ` NumberOfComponents="${components}"` : "";
  return `<DataArray type="${type}" Name="${name}"${comp} format="ascii">\n${body}\n</DataArray>`;
}

function buildCraneVtu() {
  const nPool = model.pool.length / 3;
  const nTets = model.tets.length / 4;
  const nTris = model.triangles.length / 3;

  // One solid property (PSOLID) plus one shell property (PSHELL) per distinct
  // wall thickness — the store carries a single thickness per property.
  const SOLID_PROP = 1;
  const thkKey = (t) => Number(t.toFixed(6));
  const propOfThk = new Map();
  const properties = [{ id: SOLID_PROP, type: "PSOLID", materialId: 1 }];
  let nextProp = 2;
  for (const t of model.thicknesses) {
    const key = thkKey(t);
    if (propOfThk.has(key)) continue;
    propOfThk.set(key, nextProp);
    properties.push({ id: nextProp, type: "PSHELL", materialId: 1, thickness: key });
    nextProp++;
  }

  // Elements: solid tets (CTETRA) first, then shell facets (CTRIA3) — the exact
  // order the fields below (von_mises_tets then von_mises_tris) are laid out in.
  const elementTypes = [];
  const connectivity = [];
  const offsets = [];
  const types = [];
  const propertyIds = [];
  let offset = 0;
  const pushCell = (nodeIdxs, vtkType, elType, propId) => {
    connectivity.push(nodeIdxs.join(" "));
    offset += nodeIdxs.length;
    offsets.push(offset);
    types.push(vtkType);
    elementTypes.push(elType);
    propertyIds.push(propId);
  };
  for (let e = 0; e < nTets; e++)
    pushCell(
      [model.tets[4 * e], model.tets[4 * e + 1], model.tets[4 * e + 2], model.tets[4 * e + 3]],
      10, // VTK_TETRA
      "CTETRA",
      SOLID_PROP,
    );
  for (let t = 0; t < nTris; t++)
    pushCell(
      [model.triangles[3 * t], model.triangles[3 * t + 1], model.triangles[3 * t + 2]],
      5, // VTK_TRIANGLE
      "CTRIA3",
      propOfThk.get(thkKey(model.thicknesses[t])),
    );

  // Node / element ids are 1-based; BC/load group faces reference these ids.
  const fixedIds = fixedShellNodes.map((pi) => pi + 1);
  const loadFaceEntries = [];
  let faceEntryId = 2; // id 1 is the BC face below
  for (const fid of Object.keys(LOAD_FACES)) {
    const ns = [...loadNodes.get(Number(fid))].map((pi) => pi + 1);
    loadFaceEntries.push({
      id: faceEntryId++,
      label: `Pin load face ${fid} (${ns.length} nodes)`,
      nodeIds: ns,
    });
  }
  // LOAD_FACES applies the same vector to every listed face; take it as the
  // group's per-face force vector (rebuildSurfaceLoads applies it to each face).
  const perFace = LOAD_FACES[Object.keys(LOAD_FACES)[0]];

  const meta = {
    format: "kofem-analysis",
    version: 1,
    modelName: "Crane hook — coupled shell + solid",
    mode: "results",
    viewRepr: "surface",
    resultType: "Von Mises stress",
    elementTypes,
    materials: [
      {
        id: 1,
        name: "Steel",
        young: STEEL.young_modulus,
        poisson: STEEL.poisson_ratio,
        density: 7.85e-9,
      },
    ],
    properties,
    bcGroups: [
      {
        id: 1,
        name: "BC1",
        // All six DOF — shell nodes carry rotations; the holder edge is clamped.
        dofs: [0, 1, 2, 3, 4, 5],
        value: 0,
        faces: [
          { id: 1, label: `Fixed holder edge (${fixedIds.length} nodes)`, nodeIds: fixedIds },
        ],
      },
    ],
    loadGroups: [
      {
        id: 1,
        name: "Load1",
        dof: 1, // primary axis of the per-face force (−Y)
        totalForce: perFace[1],
        kind: "force",
        components: perFace,
        faces: loadFaceEntries,
      },
    ],
    nextBcGroupId: 2,
    nextLoadGroupId: 2,
    nextFaceEntryId: faceEntryId,
    nextMatId: 2,
    stepSurface: null,
    volMesh: null,
    surfaceTriangles: null,
    surfaceFaceIds: null,
  };

  const points = [];
  for (let v = 0; v < nPool; v++)
    points.push(`${model.pool[3 * v]} ${model.pool[3 * v + 1]} ${model.pool[3 * v + 2]}`);
  const nodeIds = Array.from({ length: nPool }, (_, i) => i + 1).join(" ");
  const elementIds = Array.from({ length: nTets + nTris }, (_, i) => i + 1).join(" ");
  const vonMises = [...r.von_mises_tets, ...r.von_mises_tris];
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
    `<Piece NumberOfPoints="${nPool}" NumberOfCells="${nTets + nTris}">`,
    `<Points>`,
    dataArray("Float64", "Points", points.join("\n"), 3),
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
    dataArray("Int64", "PropertyId", propertyIds.join(" ")),
    dataArray("Float64", "VonMises", joinTuples(vonMises, 1)),
    `</CellData>`,
    `</Piece>`,
    `</UnstructuredGrid>`,
    `</VTKFile>`,
    ``,
  ].join("\n");
}

// ── Build the gallery viewer surface: shell triangles + solid boundary faces ───
const disp = r.displacements;
const pool = model.pool;

// solid boundary = tet faces used by exactly one solid tet
const TF = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]];
const fc = new Map(), fn = new Map();
for (let e = 0; e < model.tets.length / 4; e++) {
  const p = [model.tets[4 * e], model.tets[4 * e + 1], model.tets[4 * e + 2], model.tets[4 * e + 3]];
  for (const f of TF) { const v = [p[f[0]], p[f[1]], p[f[2]]]; const k = [...v].sort((a, b) => a - b).join(","); const c = fc.get(k); if (c) c.n++; else { fc.set(k, { n: 1 }); fn.set(k, v); } }
}
const surfaceTris = [];
for (const [k, c] of fc) if (c.n === 1) surfaceTris.push(fn.get(k));
for (let t = 0; t < model.triangles.length / 3; t++) surfaceTris.push([model.triangles[3 * t], model.triangles[3 * t + 1], model.triangles[3 * t + 2]]);

// compact remap to used surface vertices, with per-vertex displacement + magnitude
const remap = new Map(), positions = [], displacements = [], magnitudes = [];
let magMin = Infinity, magMax = -Infinity;
const idxOf = (g) => {
  let i = remap.get(g);
  if (i === undefined) {
    i = remap.size; remap.set(g, i);
    positions.push(pool[3 * g], pool[3 * g + 1], pool[3 * g + 2]);
    const dx = disp[3 * g], dy = disp[3 * g + 1], dz = disp[3 * g + 2];
    displacements.push(dx, dy, dz);
    const m = Math.hypot(dx, dy, dz); magnitudes.push(m);
    magMin = Math.min(magMin, m); magMax = Math.max(magMax, m);
  }
  return i;
};
const triangles = [];
for (const [a, b, c] of surfaceTris) triangles.push(idxOf(a), idxOf(b), idxOf(c));

let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < positions.length / 3; i++) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], positions[3 * i + k]); mx[k] = Math.max(mx[k], positions[3 * i + k]); }
const modelSize = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-9);
const deformScale = magMax < 1e-30 ? 1 : (0.2 * modelSize) / magMax;
const round = (a, p) => a.map((x) => Number(x.toPrecision(p)));

const entry = {
  id: "crane-hook-shell",
  title: "Crane hook — coupled shell + solid",
  blurb:
    "A multibody crane hook: the thin holder is modelled as Kirchhoff shells, " +
    "the pin and hook stay solid, and the two are joined by a distributing (RBE3) " +
    "coupling. This coupled model converges where the all-solid mesh stalls (#358).",
  showcase: true,
  // "Open in KoFEM web" opens this card's own mixed shell+solid analysis — the
  // app re-solves it through the worker's coupled shell/solid path (#387).
  appId: "crane-hook-shell",
  metrics: [
    { k: "max displacement", v: `${magMax.toPrecision(3)} mm` },
    { k: "coupled solve", v: `converged · ${r.iterations} it`, pass: true },
  ],
  referenceLabel: "shell holder ↔ solid pin/hook · distributing (RBE3) coupling",
  colorLabel: "Displacement magnitude",
  viewer: {
    center: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2],
    modelSize, deformScale, magMin, magMax,
    positions: round(positions, 7),
    displacements: round(displacements, 6),
    magnitudes: round(magnitudes, 6),
    triangles,
  },
};

writeFileSync(join(outDir, "crane-hook-shell.vtu"), buildCraneVtu());

const manifestPath = join(outDir, "examples.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")).filter((e) => e.id !== entry.id);
manifest.push(entry);
writeFileSync(manifestPath, JSON.stringify(manifest));
console.log(
  `crane-hook-shell: ${r.iterations} it, max |u| ${magMax.toPrecision(3)} mm, ` +
    `${model.tets.length / 4} tets + ${model.triangles.length / 3} shells, ` +
    `${triangles.length / 3} surface tris → ${manifestPath} + crane-hook-shell.vtu`,
);

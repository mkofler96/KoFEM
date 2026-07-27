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

import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadEngine,
  meshStep,
  extractThinWallShells,
  shellWallTets,
  buildCoupledModel,
  dropCouplingsOnFixedNodes,
} from "../shell-coupling/lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const STEP = join(here, "../../test_files/full-crane-hook.step");
const outDir = join(here, "../../web/public/examples");
const STEEL = { young_modulus: 210000, poisson_ratio: 0.3 };
const ALUMINIUM = { young_modulus: 70000, poisson_ratio: 0.33 };
// The real part: the holder and the cylinder are steel, the hook is aluminium.
// Body ids come from the STEP — 1 holder, 2 hook, 3 cylinder. The values here are
// 1-based indices into SOLID_MATERIALS, which is what `mesh.attributes` selects
// per tet. The holder is the shelled body, so the shell material is steel too.
const SOLID_MATERIALS = [STEEL, ALUMINIUM];
const MATERIAL_NAMES = ["Steel", "Aluminium"];
const MATERIAL_OF_BODY = { 1: 1, 2: 2, 3: 1 };
const SHELL_MATERIAL = 1;
const BC_FIXED_FACE = 7;
// PER-FACE force vector, not the model total: faces 66 and 67 are the two sides
// of the pin cylinder and each carries 1 kN, so the hook is loaded with 2 kN in
// −Y altogether. The .vtu's load group stores the same per-face vector, because
// rebuildSurfaceLoads applies a group's components once per face entry.
const LOAD_FACES = { 66: [0, -1000, 0], 67: [0, -1000, 0] };

const Module = await loadEngine();
const mesh = meshStep(Module, STEP, { maxElementSize: 6 });
const shells = extractThinWallShells(mesh);
// Only the holder's thin walls become shells; its thick base block stays solid
// (kept in the pool) so the load path through it into the pin/hook is preserved.
// The pin/hook/base stay separate solid bodies joined by distributing couplings
// (a gapped pin/hole interface is a force-and-moment tie, not a sparse hinge).
const wallTets = shellWallTets(mesh, shells);
const model = buildCoupledModel(mesh, shells, wallTets);
const nShell = model.shellPool.length;

// BCs + loads by CAD face (see crane-holder-shell.mjs). `fixedShellNodes` are the
// shell POOL nodes clamped on the holder's fixed edge — kept alongside the flat
// DOF list so the openable .vtu can persist them as a BC group (all 6 DOF).
// Fix every shell node of a face-7 FACET (not just nodes labelled face 7): a fold
// node where the flange meets a side wall is welded and carries the side wall's
// label, so a per-node test drops the whole fold ring and lets the walls hinge
// about it. Selecting per facet clamps the complete flange, fold included.
const fixed = [];
const fixedShellNodes = [];
const fixedLocal = new Set();
for (let t = 0; t < shells.shellTris.length / 3; t++)
  if (shells.shellTriSrc[t] === BC_FIXED_FACE)
    for (let k = 0; k < 3; k++) fixedLocal.add(shells.shellTris[3 * t + k]);
for (const s of fixedLocal) {
  fixedShellNodes.push(model.shellPool[s]);
  for (let c = 0; c < 6; c++) fixed.push(6 * model.shellPool[s] + c);
}
const loadNodes = new Map(
  Object.keys(LOAD_FACES).map((f) => [Number(f), new Set()]),
);
for (let t = 0; t < mesh.surfFace.length; t++) {
  const F = LOAD_FACES[mesh.surfFace[t]];
  if (!F) continue;
  for (const oi of [
    mesh.surfTri[3 * t],
    mesh.surfTri[3 * t + 1],
    mesh.surfTri[3 * t + 2],
  ]) {
    const pi = model.solidPool.get(oi);
    if (pi !== undefined) loadNodes.get(mesh.surfFace[t]).add(pi);
  }
}
const load_dofs = [],
  load_vals = [];
for (const [fid, F] of Object.entries(LOAD_FACES)) {
  const ns = [...loadNodes.get(Number(fid))];
  for (const pi of ns)
    for (let c = 0; c < 3; c++)
      if (F[c] !== 0) {
        load_dofs.push(6 * pi + c);
        load_vals.push(F[c] / ns.length);
      }
}

// The clamped holder rim (face 7) sits next to the retained base solid; drop any
// distributing coupling on those fixed nodes (a fixed RBE3 dependent is refused, #377).
const coupling = dropCouplingsOnFixedNodes(model.coupling, fixed);
const r = Module.solve_coupled(
  {
    vertices: Float64Array.from(model.pool),
    tets: Int32Array.from(model.tets),
    triangles: Int32Array.from(model.triangles),
    thicknesses: Float64Array.from(model.thicknesses),
    attributes: Int32Array.from(
      model.tetBody.map((b) => {
        const at = MATERIAL_OF_BODY[b];
        if (!at) throw new Error(`no material assigned to STEP body ${b}`);
        return at;
      }),
    ),
  },
  {
    ref: Int32Array.from(coupling.ref),
    offsets: Int32Array.from(coupling.offsets),
    solid: Int32Array.from(coupling.solid),
    // Shell<->solid seam tied with the relaxed MPC coupling, exactly as the app
    // does when this .vtu is loaded and re-solved (web/src/workers/solver.worker.ts).
    mpc: Int32Array.from(coupling.mpc ?? coupling.ref.map(() => 0)),
    relaxation: 1.0,
  },
  {
    fixed_dofs: Int32Array.from(fixed),
    load_dofs: Int32Array.from(load_dofs),
    load_vals: Float64Array.from(load_vals),
  },
  JSON.stringify({
    solid: SOLID_MATERIALS,
    shell: SOLID_MATERIALS[SHELL_MATERIAL - 1],
  }),
);
if ("error" in r) throw new Error(r.error);
if (!r.von_mises_tets || !r.von_mises_tris)
  throw new Error(
    "solve_coupled did not return per-element von Mises fields — rebuild the WASM engine",
  );

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

  // One PSOLID per distinct solid body (pin / hook / holder base) so the re-solved
  // .vtu can tell the bodies apart and re-derive the distributing tie across the
  // pin/hole clearance; plus one PSHELL per distinct wall thickness.
  const properties = [];
  const propOfBody = new Map();
  let nextProp = 1;
  for (const b of model.tetBody) {
    if (propOfBody.has(b)) continue;
    propOfBody.set(b, nextProp);
    properties.push({
      id: nextProp,
      type: "PSOLID",
      materialId: MATERIAL_OF_BODY[b],
    });
    nextProp++;
  }
  const thkKey = (t) => Number(t.toFixed(6));
  const propOfThk = new Map();
  for (const t of model.thicknesses) {
    const key = thkKey(t);
    if (propOfThk.has(key)) continue;
    propOfThk.set(key, nextProp);
    properties.push({
      id: nextProp,
      type: "PSHELL",
      materialId: SHELL_MATERIAL,
      thickness: key,
    });
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
      [
        model.tets[4 * e],
        model.tets[4 * e + 1],
        model.tets[4 * e + 2],
        model.tets[4 * e + 3],
      ],
      10, // VTK_TETRA
      "CTETRA",
      propOfBody.get(model.tetBody[e]),
    );
  for (let t = 0; t < nTris; t++)
    pushCell(
      [
        model.triangles[3 * t],
        model.triangles[3 * t + 1],
        model.triangles[3 * t + 2],
      ],
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
  // With both pin faces in the group that is 1 kN each — 2 kN on the model, the
  // same resultant the solve above was run with. `totalForce` below names the
  // group's primary component, which is per-face too, NOT the model total.
  const perFace = LOAD_FACES[Object.keys(LOAD_FACES)[0]];

  const meta = {
    format: "kofem-analysis",
    version: 1,
    modelName: "Crane hook — coupled shell + solid",
    mode: "results",
    viewRepr: "surface",
    resultType: "Von Mises stress",
    elementTypes,
    materials: SOLID_MATERIALS.map((mat, i) => ({
      id: i + 1,
      name: MATERIAL_NAMES[i],
      young: mat.young_modulus,
      poisson: mat.poisson_ratio,
      density: i === 0 ? 7.85e-9 : 2.7e-9,
    })),
    properties,
    bcGroups: [
      {
        id: 1,
        name: "BC1",
        // All six DOF — shell nodes carry rotations; the holder edge is clamped.
        dofs: [0, 1, 2, 3, 4, 5],
        value: 0,
        faces: [
          {
            id: 1,
            label: `Fixed holder edge (${fixedIds.length} nodes)`,
            nodeIds: fixedIds,
          },
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
    nextMatId: SOLID_MATERIALS.length + 1,
    stepSurface: null,
    volMesh: null,
    surfaceTriangles: null,
    surfaceFaceIds: null,
  };

  const points = [];
  for (let v = 0; v < nPool; v++)
    points.push(
      `${model.pool[3 * v]} ${model.pool[3 * v + 1]} ${model.pool[3 * v + 2]}`,
    );
  const nodeIds = Array.from({ length: nPool }, (_, i) => i + 1).join(" ");
  const elementIds = Array.from(
    { length: nTets + nTris },
    (_, i) => i + 1,
  ).join(" ");
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
const TF = [
  [0, 1, 2],
  [0, 1, 3],
  [0, 2, 3],
  [1, 2, 3],
];
const fc = new Map(),
  fn = new Map();
for (let e = 0; e < model.tets.length / 4; e++) {
  const p = [
    model.tets[4 * e],
    model.tets[4 * e + 1],
    model.tets[4 * e + 2],
    model.tets[4 * e + 3],
  ];
  for (const f of TF) {
    const v = [p[f[0]], p[f[1]], p[f[2]]];
    const k = [...v].sort((a, b) => a - b).join(",");
    const c = fc.get(k);
    if (c) c.n++;
    else {
      fc.set(k, { n: 1 });
      fn.set(k, v);
    }
  }
}
const surfaceTris = [];
for (const [k, c] of fc) if (c.n === 1) surfaceTris.push(fn.get(k));
for (let t = 0; t < model.triangles.length / 3; t++)
  surfaceTris.push([
    model.triangles[3 * t],
    model.triangles[3 * t + 1],
    model.triangles[3 * t + 2],
  ]);

// compact remap to used surface vertices, with per-vertex displacement + magnitude
const remap = new Map(),
  positions = [],
  displacements = [],
  magnitudes = [];
let magMin = Infinity,
  magMax = -Infinity;
const idxOf = (g) => {
  let i = remap.get(g);
  if (i === undefined) {
    i = remap.size;
    remap.set(g, i);
    positions.push(pool[3 * g], pool[3 * g + 1], pool[3 * g + 2]);
    const dx = disp[3 * g],
      dy = disp[3 * g + 1],
      dz = disp[3 * g + 2];
    displacements.push(dx, dy, dz);
    const m = Math.hypot(dx, dy, dz);
    magnitudes.push(m);
    magMin = Math.min(magMin, m);
    magMax = Math.max(magMax, m);
  }
  return i;
};
const triangles = [];
for (const [a, b, c] of surfaceTris)
  triangles.push(idxOf(a), idxOf(b), idxOf(c));

let mn = [Infinity, Infinity, Infinity],
  mx = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < positions.length / 3; i++)
  for (let k = 0; k < 3; k++) {
    mn[k] = Math.min(mn[k], positions[3 * i + k]);
    mx[k] = Math.max(mx[k], positions[3 * i + k]);
  }
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
  referenceLabel:
    "shell holder ↔ solid pin/hook · distributing (RBE3) coupling",
  colorLabel: "Displacement magnitude",
  viewer: {
    center: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2],
    modelSize,
    deformScale,
    magMin,
    magMax,
    positions: round(positions, 7),
    displacements: round(displacements, 6),
    magnitudes: round(magnitudes, 6),
    triangles,
  },
};

writeFileSync(join(outDir, "crane-hook-shell.vtu"), buildCraneVtu());

// Ship the source STEP next to the .vtu so "Open in KoFEM web" can re-mesh and
// re-solve the model (App.tsx restores stepBytes from /examples/<id>.step). The
// saved .vtu itself carries no STEP.
copyFileSync(STEP, join(outDir, "crane-hook-shell.step"));

const manifestPath = join(outDir, "examples.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")).filter(
  (e) => e.id !== entry.id,
);
manifest.push(entry);
writeFileSync(manifestPath, JSON.stringify(manifest));
console.log(
  `crane-hook-shell: ${r.iterations} it, max |u| ${magMax.toPrecision(3)} mm, ` +
    `${model.tets.length / 4} tets + ${model.triangles.length / 3} shells, ` +
    `${triangles.length / 3} surface tris → ${manifestPath} + crane-hook-shell.vtu`,
);

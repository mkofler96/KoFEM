// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Generates the classical MBB beam topology-optimization example, built end to
// end with KoFEM's own pipeline — STEP geometry → OCCT tessellation → Netgen
// volume mesh → SIMP/MMA optimizer — so what the gallery shows is exactly what
// the app produces, and the user can re-mesh and re-optimize it:
//
//   mbb-beam-topopt.step — the design domain: a 300 × 50 × 10 mm block whose
//                          bottom and top faces were cut with the app's split
//                          tool, so the two supports and the load sit on their
//                          own CAD faces (pickable in one click, and still there
//                          after a re-mesh).
//   mbb-beam-topopt.vtu  — the analysis the "Open in KoFEM web" button loads:
//                          the Netgen mesh, the tessellation and CAD face ids
//                          (face picking), the support/load groups and the
//                          optimization settings. It opens in the Optimize step,
//                          ready to run; the .step next to it is restored by
//                          App.tsx, so the model can also be re-meshed.
//   examples.json        — the gallery card. Its viewer shows the OPTIMIZED
//                          design: the boundary of every tet with density ≥ 0.5.
//
// The MBB (Messerschmitt-Bölkow-Blohm) beam is the canonical minimum-compliance
// benchmark (Olhoff et al. 1991; Sigmund 2001, "A 99 line topology optimization
// code"; Andreassen et al. 2011, "88 lines"): a simply-supported beam with a
// central load, 6 : 1 span-to-height, half the material to spend. The whole beam
// is modelled — pin at the bottom-left, roller at the bottom-right, load at the
// top of mid-span — rather than the symmetric half, so the model reads as drawn
// in the textbooks. The regression-locked half-model on a structured hex grid is
// examples/validation/topopt/cases/mbb-beam.mjs.
//
//   bun examples/gallery/generate-mbb-topopt.mjs
//
// Everything here is something a user does in the app, in the same order and
// through the same engine calls, so the example can be rebuilt by hand:
//
//   1. Geometry → import a plain 300 × 50 × 10 mm block (six faces).
//   2. Split faces or bodies with a plane… → Faces, cut plane x = …:
//        bottom face at x = 5, then its long piece at x = 295  (the two pads)
//        top face at x = 145, then its right piece at x = 155  (the load pad)
//   3. Mesh with a 5 mm max element size.
//   4. Constraints: the left pad fixed (Ux Uy Uz), the right pad Uy only;
//      Loads: Fy = −1000 N on the mid-span pad.
//   5. Optimize: minimum compliance, volume fraction 0.5, p = 3, r_min = 10 mm.
//
// web/tests/mbb-by-hand.spec.ts walks exactly this path through the UI.
//
// It appends/replaces the "mbb-beam-topopt" entry in examples.json, leaving the
// other entries untouched. Netgen is not bit-reproducible across builds, so a
// re-run can move the numbers on the card slightly.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEngine } from "../shell-coupling/lib.mjs";
import { prismStep } from "./step-prism.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "site");
const ID = "mbb-beam-topopt";
const TITLE = "MBB beam — topology optimization";

// Canonical N · mm · MPa system; steel exactly as the app seeds it.
const STEEL = {
  id: 1,
  name: "Steel",
  young: 210000,
  poisson: 0.3,
  density: 7.85e-9,
};
const L = 300; // span (mm)
const H = 50; // height (mm)
const T = 10; // thickness (mm)
const PAD = 5; // width of each support pad (mm)
const LOAD_PAD = 10; // width of the load pad at mid-span (mm)
const F = 1000; // central load (N), downward
// The app's mesher settings (solver.worker.ts handleVolumeMesh) at a 5 mm max
// element size: two tets through the thickness, ~8k elements — about half a
// second per optimizer iteration in the browser.
const MAX_ELEMENT_SIZE = 5;
const SETTINGS = {
  objective: "min_compliance",
  constraints: { volumeFraction: 0.5 },
  penalty: 3,
  // mm — two element sizes. At 1.5 (the 88-line code's ratio) the tet design
  // keeps flipping elements at the move limit and never meets the tolerance;
  // at 2 it converges in ~70 iterations to the same truss.
  filterRadius: 10,
  moveLimit: 0.2,
  maxIterations: 100,
  tolerance: 0.01,
};

// ── Geometry: a plain block, cut with the split tool ──────────────────────────
const TESSELLATE = JSON.stringify({
  deflection_relative: 0.001,
  angular_deflection: 0.5,
  format: "step",
});
const mesher = await loadEngine();
let stepBytes = new TextEncoder().encode(
  prismStep(
    [
      [0, 0],
      [L, 0],
      [L, H],
      [0, H],
    ],
    T,
    "MBB beam",
  ),
);
let tess = mesher.tessellate_step(stepBytes, TESSELLATE);

// The CAD face whose tessellation triangles all satisfy `pred` — the face a user
// clicks to pick it. Exactly one must match.
function tessellatedFaceWhere(label, pred) {
  const inside = new Set();
  const outside = new Set();
  for (let t = 0; t < tess.triangleFaceIds.length; t++) {
    const onIt = [0, 1, 2].every((k) => {
      const v = tess.triangles[3 * t + k];
      return pred(
        tess.vertices[3 * v],
        tess.vertices[3 * v + 1],
        tess.vertices[3 * v + 2],
      );
    });
    (onIt ? inside : outside).add(tess.triangleFaceIds[t]);
  }
  const exact = [...inside].filter((id) => !outside.has(id));
  if (exact.length !== 1)
    throw new Error(
      `${label}: expected exactly one CAD face, found [${exact.join(", ")}]`,
    );
  return exact[0];
}

// One use of the split tool: pick the face, cut it with the plane x = `x`. The
// request is exactly the one the app's worker sends (useGeometryEdit), and the
// edited file is loaded back, as the app does.
function splitFaceAtX(label, pred, x) {
  const faceId = tessellatedFaceWhere(label, pred);
  const { bytes } = mesher.split_geometry(
    JSON.stringify({
      mode: "faces",
      origin: [x, 0, 0],
      normal: [1, 0, 0],
      faceIds: [faceId],
    }),
  );
  stepBytes = bytes;
  tess = mesher.tessellate_step(stepBytes, TESSELLATE);
}
const eps = 1e-6;
const onBottom = (y) => Math.abs(y) < eps;
const onTop = (y) => Math.abs(y - H) < eps;
splitFaceAtX("bottom face", (x, y) => onBottom(y), PAD);
splitFaceAtX(
  "bottom face right of the pin pad",
  (x, y) => onBottom(y) && x >= PAD - eps,
  L - PAD,
);
splitFaceAtX("top face", (x, y) => onTop(y), L / 2 - LOAD_PAD / 2);
splitFaceAtX(
  "top face right of the cut",
  (x, y) => onTop(y) && x >= L / 2 - LOAD_PAD / 2 - eps,
  L / 2 + LOAD_PAD / 2,
);
const step = new TextDecoder().decode(stepBytes);

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

// Find each pad's CAD face by where it lies rather than trusting OCCT's face
// numbering: the face whose triangles all sit on the given plane strip.
function cadFaceWhere(label, pred) {
  const ids = new Set();
  const rejected = new Set();
  for (let t = 0; t < surfFace.length; t++) {
    const onIt = [0, 1, 2].every((k) => {
      const v = surfTri[3 * t + k];
      return pred(V[3 * v], V[3 * v + 1], V[3 * v + 2]);
    });
    (onIt ? ids : rejected).add(surfFace[t]);
  }
  const exact = [...ids].filter((id) => !rejected.has(id));
  if (exact.length !== 1)
    throw new Error(
      `${label}: expected exactly one CAD face, found [${exact.join(", ")}]`,
    );
  return exact[0];
}
const pinFace = cadFaceWhere(
  "pin pad",
  (x, y) => Math.abs(y) < eps && x <= PAD + eps,
);
const rollerFace = cadFaceWhere(
  "roller pad",
  (x, y) => Math.abs(y) < eps && x >= L - PAD - eps,
);
const loadFace = cadFaceWhere(
  "load pad",
  (x, y) => Math.abs(y - H) < eps && Math.abs(x - L / 2) <= LOAD_PAD / 2 + eps,
);
const nodesOfFace = (id) => {
  const s = new Set();
  for (let t = 0; t < surfFace.length; t++)
    if (surfFace[t] === id)
      for (let k = 0; k < 3; k++) s.add(surfTri[3 * t + k]);
  return [...s].sort((a, b) => a - b);
};
const pinNodes = nodesOfFace(pinFace);
const rollerNodes = nodesOfFace(rollerFace);
const loadNodes = nodesOfFace(loadFace);
const loadTris = [];
for (let t = 0; t < surfFace.length; t++)
  if (surfFace[t] === loadFace)
    loadTris.push([surfTri[3 * t], surfTri[3 * t + 1], surfTri[3 * t + 2]]);

// ── Optimize ──────────────────────────────────────────────────────────────────
// Node ids equal vertex indices (as after meshing in the app), so these BCs are
// what the worker's groupDirichlet / rebuildSurfaceLoads build from the groups
// written below. Pin: u = 0. Roller: u_y = 0 only — the pad slides freely in x
// and z. A fresh engine instance runs the solve: the app resets its worker after
// meshing because Netgen's global state contaminates MFEM (useMesh.ts).
const optimizer = await loadEngine();
const t0 = performance.now();
const result = optimizer.optimize_topology(
  {
    vertices: Float64Array.from(V),
    tetrahedra: Int32Array.from(tets),
    hexahedra: new Int32Array(0),
  },
  JSON.stringify([
    { young_modulus: STEEL.young, poisson_ratio: STEEL.poisson },
  ]),
  JSON.stringify({
    fixed_vertices: pinNodes,
    fixed_dofs: rollerNodes.map((vertex) => ({ vertex, dofs: [1] })),
    prescribed_dofs: [],
    point_loads: [],
    surface_loads: [{ type: "force", force: [0, -F, 0], faces: loadTris }],
  }),
  JSON.stringify(SETTINGS),
  null, // no live density stream
);
if ("error" in result) throw new Error(result.error);
const seconds = (performance.now() - t0) / 1000;
const density = Array.from(result.density);
const history = result.history.map((h) => ({ ...h }));
const c0 = history[0].objective;
const cN = history.at(-1).objective;
const volN = history.at(-1).volume;
const converged = history.at(-1).max_change < SETTINGS.tolerance;
if (!converged)
  throw new Error(
    `not converged in ${history.length} iterations (max change ${history.at(-1).max_change})`,
  );
if (Math.abs(volN - SETTINGS.constraints.volumeFraction) > 0.01)
  throw new Error(`volume fraction ${volN} missed the 0.5 target`);
const nSolid = density.filter((r) => r > 0.9).length;
const nVoid = density.filter((r) => r < 0.1).length;
if (nSolid < 0.2 * nTets || nVoid < 0.2 * nTets)
  throw new Error(
    `no clear topology emerged (${nSolid} solid, ${nVoid} void of ${nTets})`,
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
    mode: "optimize",
    viewRepr: "surface",
    resultType: "Displacement (magnitude)",
    elementTypes: Array(nTets).fill("CTETRA"),
    materials: [STEEL],
    properties: [{ id: 1, materialId: 1, discretization: "solid" }],
    bcGroups: [
      {
        id: 1,
        name: "Pin",
        dofs: [0, 1, 2],
        value: 0,
        faces: [faceEntry(1, pinFace, pinNodes)],
      },
      {
        id: 2,
        name: "Roller",
        dofs: [1],
        value: 0,
        faces: [faceEntry(2, rollerFace, rollerNodes)],
      },
    ],
    loadGroups: [
      {
        id: 1,
        name: "Central load",
        dof: 1,
        totalForce: -F,
        components: [0, -F, 0],
        kind: "force",
        faces: [faceEntry(3, loadFace, loadNodes)],
      },
    ],
    tieGroups: [],
    couplingGroups: [],
    nextBcGroupId: 3,
    nextLoadGroupId: 2,
    nextTieGroupId: 1,
    nextCouplingGroupId: 1,
    nextFaceEntryId: 4,
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
    // The panel holds the settings as the strings the user would type.
    topOpt: {
      objective: SETTINGS.objective,
      volumeFraction: String(SETTINGS.constraints.volumeFraction),
      complianceLimit: "",
      penalty: String(SETTINGS.penalty),
      filterRadius: String(SETTINGS.filterRadius),
      moveLimit: String(SETTINGS.moveLimit),
      maxIterations: String(SETTINGS.maxIterations),
      tolerance: String(SETTINGS.tolerance),
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

// ── Gallery viewer: the boundary of the solid (ρ ≥ 0.5) design ────────────────
// A tet face is on the boundary of the thresholded design when exactly one solid
// tet owns it. Vertex colour is the mean density of the solid tets meeting at
// that vertex, which reads as a smooth field rather than per-tet speckle.
const THRESHOLD = 0.5;
const TET_FACES = [
  [0, 2, 1],
  [0, 1, 3],
  [0, 3, 2],
  [1, 2, 3],
];
const owners = new Map();
const densitySum = new Map();
for (let e = 0; e < nTets; e++) {
  if (density[e] < THRESHOLD) continue;
  for (let k = 0; k < 4; k++) {
    const v = tets[4 * e + k];
    const acc = densitySum.get(v) ?? [0, 0];
    densitySum.set(v, [acc[0] + density[e], acc[1] + 1]);
  }
  for (const def of TET_FACES) {
    const face = def.map((i) => tets[4 * e + i]);
    const key = [...face].sort((a, b) => a - b).join(",");
    const entry = owners.get(key);
    if (entry) entry.count++;
    else owners.set(key, { face, count: 1 });
  }
}
const positions = [];
const magnitudes = [];
const triangles = [];
const local = new Map();
for (const { face, count } of owners.values()) {
  if (count !== 1) continue;
  for (const v of face) {
    if (!local.has(v)) {
      local.set(v, positions.length / 3);
      positions.push(V[3 * v], V[3 * v + 1], V[3 * v + 2]);
      const [sum, n] = densitySum.get(v);
      magnitudes.push(sum / n);
    }
    triangles.push(local.get(v));
  }
}
const round = (arr, p) => arr.map((x) => Number(x.toPrecision(p)));

const entry = {
  id: ID,
  title: TITLE,
  blurb:
    "The classical minimum-compliance benchmark: a simply-supported beam with a " +
    "central load and half its material to spend. SIMP + MMA carves the solid " +
    "block into the textbook truss: a compression chord sloping down to the " +
    "supports, a straight tension tie and a web of diagonals. Open it in KoFEM " +
    "web and press Optimize to watch it emerge, or re-mesh it first.",
  showcase: true,
  appId: ID,
  metrics: [
    {
      k: `compliance · ${history.length} iterations`,
      v: `${c0.toFixed(0)} → ${cN.toFixed(0)} N·mm (−${((1 - cN / c0) * 100).toFixed(0)}%)`,
    },
    {
      k: "volume fraction",
      v: `${volN.toFixed(3)} (target ${SETTINGS.constraints.volumeFraction})`,
      pass: converged,
    },
  ],
  referenceLabel:
    "Sigmund 99-line / Andreassen 88-line MBB · SIMP p = 3 · MMA · Netgen tet mesh · density ≥ 0.5 shown",
  colorLabel: "Element density",
  viewer: {
    center: [L / 2, H / 2, T / 2],
    // Framing, not a measure: the slender beam fills the card at ~0.6·L.
    modelSize: 0.6 * L,
    deformScale: 0,
    magMin: 0,
    magMax: 1,
    positions: round(positions, 7),
    displacements: positions.map(() => 0),
    magnitudes: round(magnitudes, 3),
    triangles,
  },
};

writeFileSync(join(outDir, `${ID}.step`), step);
writeFileSync(join(outDir, `${ID}.vtu`), buildVtu());
const manifestPath = join(outDir, "examples.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")).filter(
  (e) => e.id !== entry.id,
);
manifest.push(entry);
writeFileSync(manifestPath, JSON.stringify(manifest));

console.log(
  `${ID}: ${nNodes} nodes, ${nTets} tets; ${history.length} it (converged: ${converged}) ` +
    `in ${seconds.toFixed(1)} s, compliance ${c0.toFixed(1)} → ${cN.toFixed(1)}, ` +
    `volume ${volN.toFixed(4)}, ${nSolid} solid / ${nVoid} void → ${ID}.{step,vtu} + examples.json`,
);

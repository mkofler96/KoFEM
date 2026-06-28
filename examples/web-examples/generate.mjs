// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Generates the data behind the interactive examples gallery (/examples/).
//
// For every example in examples.mjs it runs the real KoFEM WASM solver and
// writes two artifacts into web/public/examples/:
//
//   <id>.vtu       — a complete KoFEM analysis file (mesh + BC/load groups +
//                    solved displacement / von-Mises fields). This is what the
//                    "Open in KoFEM web" button loads via /app/?example=<id>.
//   examples.json  — one manifest with per-example metadata plus a compact
//                    boundary-surface payload the gallery's WebGL viewer renders
//                    (undeformed positions, per-vertex displacement, triangles).
//
// Run with:  bun examples/web-examples/generate.mjs   (or `bun run examples:generate`)

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadSolver } from "../validation/lib/solver.mjs";
import examples from "./examples.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "../../web/public/examples");

// ── Boundary-surface extraction (hex faces appearing exactly once) ────────────

const HEX_FACE_DEFS = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [2, 3, 7, 6],
  [0, 3, 7, 4],
  [1, 2, 6, 5],
];

function boundaryQuads(hexahedra) {
  const faces = new Map();
  for (const hex of hexahedra) {
    for (const [a, b, c, d] of HEX_FACE_DEFS) {
      const face = [hex[a], hex[b], hex[c], hex[d]];
      const key = [...face].sort((x, y) => x - y).join(",");
      const entry = faces.get(key);
      if (entry) entry.count++;
      else faces.set(key, { face, count: 1 });
    }
  }
  return [...faces.values()].filter((e) => e.count === 1).map((e) => e.face);
}

// ── VTK analysis-file writer (matches web/src/lib/analysisFile.ts) ────────────

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

function buildVtu(example, result) {
  const { vertices, hexahedra } = example.mesh;
  const nNodes = vertices.length;
  const nCells = hexahedra.length;

  // Node / element IDs are 1-based; load/BC group faces reference these IDs.
  const fixedIds = example.fixed.map((v) => v + 1);
  const loadIds = example.load.nodes.map((v) => v + 1);

  const meta = {
    format: "kofem-analysis",
    version: 1,
    modelName: example.title,
    mode: "results",
    viewRepr: "surface",
    resultType: example.resultType ?? "Displacement (magnitude)",
    elementTypes: hexahedra.map(() => "CHEXA"),
    materials: [
      {
        id: 1,
        name: example.material.name,
        young: example.material.young_modulus,
        poisson: example.material.poisson_ratio,
        density: example.material.density,
      },
    ],
    properties: [{ id: 1, type: "PSOLID", materialId: 1 }],
    bcGroups: [
      {
        id: 1,
        name: "BC1",
        dofs: [0, 1, 2],
        value: 0,
        faces: [
          {
            id: 1,
            label: `Fixed face (${fixedIds.length} nodes)`,
            nodeIds: fixedIds,
          },
        ],
      },
    ],
    loadGroups: [
      {
        id: 1,
        name: "Load1",
        dof: example.load.dof,
        totalForce: example.load.totalForce,
        faces: [
          {
            id: 2,
            label: `${example.load.label} (${loadIds.length} nodes)`,
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
  for (const hex of hexahedra) {
    connectivity.push(hex.join(" "));
    offset += hex.length;
    offsets.push(offset);
  }
  const types = hexahedra.map(() => 12); // VTK_HEXAHEDRON

  const points = vertices.map((v) => `${v[0]} ${v[1]} ${v[2]}`).join("\n");
  const nodeIds = vertices.map((_, i) => i + 1).join(" ");
  const elementIds = hexahedra.map((_, i) => i + 1).join(" ");
  const propertyIds = hexahedra.map(() => 1).join(" ");
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
    dataArray(
      "Float64",
      "Displacement",
      joinTuples(result.displacements, 3),
      3,
    ),
    `</PointData>`,
    `<CellData>`,
    dataArray("Int64", "ElementId", elementIds),
    dataArray("Int64", "PropertyId", propertyIds),
    dataArray("Float64", "VonMises", joinTuples(result.von_mises, 1)),
    `</CellData>`,
    `</Piece>`,
    `</UnstructuredGrid>`,
    `</VTKFile>`,
    ``,
  ].join("\n");
}

// ── Compact viewer payload (boundary surface only) ────────────────────────────

function buildViewer(example, result) {
  const { vertices, hexahedra } = example.mesh;
  const disp = result.displacements;

  // Bounding box → characteristic model size and a deformation scale matching
  // the app (TARGET_DEFORM_FRACTION = 0.2 of the model size).
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const v of vertices) {
    minX = Math.min(minX, v[0]);
    maxX = Math.max(maxX, v[0]);
    minY = Math.min(minY, v[1]);
    maxY = Math.max(maxY, v[1]);
    minZ = Math.min(minZ, v[2]);
    maxZ = Math.max(maxZ, v[2]);
  }
  const modelSize = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-9);
  let maxComp = 0;
  for (let i = 0; i < disp.length; i++)
    maxComp = Math.max(maxComp, Math.abs(disp[i]));
  const deformScale = maxComp < 1e-30 ? 1 : (0.2 * modelSize) / maxComp;

  // Remap the boundary-surface vertices to a compact 0..m index range.
  const quads = boundaryQuads(hexahedra);
  const remap = new Map();
  const surfPos = [];
  const surfDisp = [];
  const surfMag = [];
  const idxOf = (orig) => {
    let i = remap.get(orig);
    if (i === undefined) {
      i = remap.size;
      remap.set(orig, i);
      const v = vertices[orig];
      surfPos.push(v[0], v[1], v[2]);
      const dx = disp[orig * 3],
        dy = disp[orig * 3 + 1],
        dz = disp[orig * 3 + 2];
      surfDisp.push(dx, dy, dz);
      surfMag.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    return i;
  };
  const tris = [];
  for (const [a, b, c, d] of quads) {
    const ia = idxOf(a),
      ib = idxOf(b),
      ic = idxOf(c),
      id = idxOf(d);
    tris.push(ia, ib, ic, ia, ic, id);
  }

  let magMin = Infinity,
    magMax = -Infinity;
  for (const m of surfMag) {
    magMin = Math.min(magMin, m);
    magMax = Math.max(magMax, m);
  }

  const round = (a, p) => a.map((x) => Number(x.toPrecision(p)));
  return {
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    modelSize,
    deformScale,
    magMin,
    magMax,
    positions: round(surfPos, 7),
    displacements: round(surfDisp, 6),
    magnitudes: round(surfMag, 6),
    triangles: tris,
  };
}

// ── Load → nodal forces ───────────────────────────────────────────────────────
// Mirrors web/src/store/modelStore.ts rebuildLoads so the solved field here is
// identical to what the app shows when it reopens the .vtu:
//   dof 0–2 (force)  — total force spread equally over the loaded face nodes
//   dof 3–5 (moment) — tangential couple F = (M/S)·(axis × r) about the face
//                      centroid, S = Σ|r⊥|² (zero net force, net moment = M)
function pointLoadsFor(example) {
  const { vertices } = example.mesh;
  const { dof, totalForce, nodes } = example.load;
  if (dof <= 2) {
    return nodes.map((vertex) => {
      const f = [0, 0, 0];
      f[dof] = totalForce / nodes.length;
      return { vertex, force: f };
    });
  }
  const axis = dof - 3; // 0=x, 1=y, 2=z
  const c = [0, 1, 2].map(
    (k) => nodes.reduce((s, v) => s + vertices[v][k], 0) / nodes.length,
  );
  let S = 0;
  for (const v of nodes) {
    const [rx, ry, rz] = [0, 1, 2].map((k) => vertices[v][k] - c[k]);
    S +=
      axis === 0
        ? ry * ry + rz * rz
        : axis === 1
          ? rx * rx + rz * rz
          : rx * rx + ry * ry;
  }
  const scale = totalForce / S;
  return nodes.map((vertex) => {
    const [rx, ry, rz] = [0, 1, 2].map((k) => vertices[vertex][k] - c[k]);
    const f =
      axis === 0
        ? [0, -scale * rz, scale * ry] // Mx → (0, −rz, ry)
        : axis === 1
          ? [scale * rz, 0, -scale * rx] // My → (rz, 0, −rx)
          : [-scale * ry, scale * rx, 0]; // Mz → (−ry, rx, 0)
    return { vertex, force: f };
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

const solve = await loadSolver();
mkdirSync(outDir, { recursive: true });

const manifest = [];
for (const ex of examples) {
  const result = solve(ex.mesh, ex.material, {
    fixed_vertices: ex.fixed,
    point_loads: pointLoadsFor(ex),
  });

  writeFileSync(join(outDir, `${ex.id}.vtu`), buildVtu(ex, result));

  const fe = ex.feValue(result, ex.load.nodes);
  const errPct = Math.abs((fe - ex.reference) / ex.reference) * 100;
  manifest.push({
    id: ex.id,
    title: ex.title,
    blurb: ex.blurb,
    quantity: ex.quantity,
    unit: ex.unit,
    reference: ex.reference,
    referenceLabel: ex.referenceLabel,
    feValue: fe,
    errPct,
    colorLabel: "Displacement magnitude",
    viewer: buildViewer(ex, result),
  });

  console.log(
    `${ex.id.padEnd(18)} fe=${fe.toExponential(4)} ref=${ex.reference.toExponential(4)} err=${errPct.toFixed(2)}%`,
  );
}

writeFileSync(join(outDir, "examples.json"), JSON.stringify(manifest));
console.log(`\nWrote ${manifest.length} examples to ${outDir}`);

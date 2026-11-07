// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Interactive result viewers for the Theory Guide. generate.mjs extracts the
// boundary surface of a solved public example (examples/gallery/site/<id>.vtu)
// into public/theory/viewers/<id>.json; public/theory/viewer.js draws it with
// three.js. Without JavaScript or WebGL, the example's own figure is shown.

import { readFileSync } from "node:fs";

const repo = new URL("../../../", import.meta.url);
const site = new URL("examples/gallery/site/", repo);
const caseRecords = JSON.parse(
  readFileSync(new URL("web/public/examples/results.json", repo), "utf8"),
).cases;
const showcaseRecord = (id) =>
  JSON.parse(
    readFileSync(new URL(`examples/gallery/showcase/${id}.json`, repo), "utf8"),
  );

// The solved examples a Theory article may embed, with the field the
// example's own figure shows.
const sources = {
  cantilever: { title: "Cantilever beam", record: "case" },
  "plate-with-hole": { title: "Plate with a hole", record: "case" },
  "plate-with-hole-shell": {
    title: "Plate with a hole, shell model",
    record: "showcase",
  },
  "axial-bar": { title: "Axial bar", record: "case" },
};

const fieldNames = {
  displacement: "Displacement magnitude",
  vonMises: "von Mises stress",
};

function figureMeta(id) {
  const source = sources[id];
  if (!source) throw new Error(`No theory viewer source for example "${id}"`);
  const record =
    source.record === "case"
      ? caseRecords.find((entry) => entry.id === id)
      : showcaseRecord(id);
  if (!record?.figure)
    throw new Error(`Example "${id}" has no figure record to match`);
  return { ...source, ...record.figure };
}

// ── A minimal reader for the ASCII arrays of a KoFEM analysis file ──────────

function dataArray(xml, name) {
  const match = xml.match(
    new RegExp(`<DataArray[^>]*Name="${name}"[^>]*>([\\s\\S]*?)</DataArray>`),
  );
  if (!match) throw new Error(`Analysis file is missing DataArray "${name}"`);
  const values = match[1].trim().split(/\s+/).map(Number);
  if (values.some(Number.isNaN))
    throw new Error(`DataArray "${name}" has a non-numeric value`);
  return values;
}

// Corner-node faces of each VTK cell type, outward-ordered.
const cellFaces = {
  12: [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ],
  10: [
    [0, 2, 1],
    [0, 1, 3],
    [1, 2, 3],
    [0, 3, 2],
  ],
  5: [[0, 1, 2]],
};

const round = (value, digits) => Number(value.toPrecision(digits));

/** The viewer payload of one solved example. */
export function viewerData(id) {
  const meta = figureMeta(id);
  const xml = readFileSync(new URL(`${id}.vtu`, site), "utf8");
  const points = dataArray(xml, "Points");
  const connectivity = dataArray(xml, "connectivity");
  const offsets = dataArray(xml, "offsets");
  const types = dataArray(xml, "types");
  const displacement = dataArray(xml, "Displacement");
  const nPoints = points.length / 3;
  if (displacement.length !== points.length)
    throw new Error(`${id}: displacement does not match the point count`);

  const cells = [];
  let start = 0;
  offsets.forEach((end, c) => {
    if (!cellFaces[types[c]])
      throw new Error(`${id}: unsupported VTK cell type ${types[c]}`);
    cells.push({ type: types[c], nodes: connectivity.slice(start, end) });
    start = end;
  });

  let nodal;
  if (meta.field === "displacement") {
    nodal = Array.from({ length: nPoints }, (_, i) =>
      Math.hypot(
        displacement[3 * i],
        displacement[3 * i + 1],
        displacement[3 * i + 2],
      ),
    );
  } else if (meta.field === "vonMises") {
    const vonMises = dataArray(xml, "VonMises");
    if (vonMises.length !== cells.length)
      throw new Error(`${id}: one von Mises value per element expected`);
    const sum = new Float64Array(nPoints);
    const count = new Uint32Array(nPoints);
    cells.forEach(({ nodes }, c) => {
      for (const v of nodes) {
        sum[v] += vonMises[c];
        count[v]++;
      }
    });
    nodal = Array.from(sum, (s, i) => (count[i] ? s / count[i] : 0));
  } else throw new Error(`${id}: unknown field "${meta.field}"`);

  // Boundary faces: faces used once (all faces of shell triangles).
  const faces = new Map();
  for (const { type, nodes } of cells)
    for (const local of cellFaces[type]) {
      const face = local.map((k) => nodes[k]);
      const key = [...face].sort((a, b) => a - b).join(",");
      const entry = faces.get(key);
      if (entry) entry.count++;
      else faces.set(key, { face, count: 1 });
    }
  const index = new Map();
  const surface = { positions: [], displacements: [], values: [] };
  const vertex = (v) => {
    if (!index.has(v)) {
      index.set(v, index.size);
      for (let k = 0; k < 3; k++) {
        surface.positions.push(round(points[3 * v + k], 7));
        surface.displacements.push(round(displacement[3 * v + k], 5));
      }
      surface.values.push(round(nodal[v], 5));
    }
    return index.get(v);
  };
  const triangles = [];
  const edges = new Set();
  for (const { face, count } of faces.values()) {
    if (count !== 1) continue;
    const ids = face.map(vertex);
    for (let k = 1; k + 1 < ids.length; k++)
      triangles.push(ids[0], ids[k], ids[k + 1]);
    ids.forEach((a, k) => {
      const b = ids[(k + 1) % ids.length];
      edges.add(a < b ? `${a},${b}` : `${b},${a}`);
    });
  }
  const values = surface.values;
  return {
    id,
    title: meta.title,
    field: fieldNames[meta.field],
    unit: meta.unit,
    min: Math.min(...values),
    max: Math.max(...values),
    deformScale: meta.deform,
    positions: surface.positions,
    displacements: surface.displacements,
    values,
    triangles,
    edges: [...edges].flatMap((key) => key.split(",").map(Number)),
  };
}

export const viewerIds = () => Object.keys(sources);
export const viewerUrl = (id) => `/theory/viewers/${id}.json`;

const formatValue = (value) => {
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1e4 || abs < 1e-2) return value.toExponential(2);
  return String(Number(value.toPrecision(3)));
};

/**
 * An interactive viewer of a solved example. The example's figure is the
 * static fallback; viewer.js replaces it with a rotatable 3D model.
 */
export function resultViewer(id, { caption }) {
  const data = viewerData(id);
  const meta = figureMeta(id);
  const unit = data.unit ? ` ${data.unit}` : "";
  const deformation =
    data.deformScale > 0
      ? `Displacements enlarged ${data.deformScale}×.`
      : "Undeformed shape.";
  return `<figure class="result-viewer" data-viewer="${viewerUrl(id)}" id="viewer-${id}">
      <div class="viewer-stage">
        <img src="/examples/${id}.png" width="${meta.width}" height="${meta.height}" alt="${data.title}: ${data.field.toLowerCase()} on the solved model, coloured from blue (low) to red (high)." loading="lazy" decoding="async" />
        <div class="viewer-legend" aria-hidden="true"><span>${formatValue(data.max)}${unit}</span><span class="viewer-bar"></span><span>${formatValue(data.min)}${unit}</span></div>
        <p class="viewer-hint" hidden>Drag to rotate · scroll to zoom</p>
      </div>
      <figcaption>${caption} ${deformation}
        <a href="/examples/${id}/">${data.title} example</a> ·
        <a href="/app/?example=${id}">Open in KoFEM</a></figcaption>
    </figure>`;
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Interactive result viewers for the Theory Guide. Every example's analysis
// file opens unsolved, so examples/validation/run.mjs --report writes the
// solved boundary surface of each case to examples/validation/surfaces/<id>.json;
// generate.mjs turns it into public/theory/viewers/<id>.json, and
// public/theory/viewer.js draws it with three.js. Without JavaScript or WebGL,
// the example's own figure is shown.

import { readFileSync } from "node:fs";

const repo = new URL("../../../", import.meta.url);
const surfaces = new URL("examples/validation/surfaces/", repo);
const caseRecords = JSON.parse(
  readFileSync(new URL("web/public/examples/results.json", repo), "utf8"),
).cases;

// The solved validation cases a Theory article may embed, with their titles.
const sources = {
  "cantilever-beam": { title: "Cantilever beam" },
  "plate-with-hole": { title: "Plate with a hole" },
  "plate-with-hole-shell": { title: "Plate with a hole, shell model" },
  "axial-bar": { title: "Axial bar" },
};

const fieldNames = {
  displacement: "Displacement magnitude",
  vonMises: "von Mises stress",
};

function figureMeta(id) {
  const source = sources[id];
  if (!source) throw new Error(`No theory viewer source for example "${id}"`);
  const record = caseRecords.find((entry) => entry.id === id);
  if (!record?.figure)
    throw new Error(`Example "${id}" has no figure record to match`);
  return { ...source, ...record.figure };
}

/** The viewer payload of one solved example: its surface from run.mjs. */
export function viewerData(id) {
  const meta = figureMeta(id);
  const surface = JSON.parse(
    readFileSync(new URL(`${id}.json`, surfaces), "utf8"),
  );
  if (surface.id !== id || surface.field !== meta.field)
    throw new Error(
      `${id}: the solved surface is "${surface.id}" / ${surface.field}, the figure shows ${meta.field}`,
    );
  const edges = new Set();
  const { triangles } = surface;
  for (let t = 0; t < triangles.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k];
      const b = triangles[t + ((k + 1) % 3)];
      edges.add(a < b ? `${a},${b}` : `${b},${a}`);
    }
  return {
    id,
    title: meta.title,
    field: fieldNames[meta.field],
    unit: meta.unit,
    min: Math.min(...surface.values),
    max: Math.max(...surface.values),
    deformScale: meta.deform,
    positions: surface.positions,
    displacements: surface.displacements,
    values: surface.values,
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

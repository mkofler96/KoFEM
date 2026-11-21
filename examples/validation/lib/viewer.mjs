// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The interactive 3D view on an example page. Every example's analysis file
// opens unsolved, so run.mjs --report (and a showcase's generator) writes the
// solved boundary surface next to the page's figure, as
// examples/gallery/site/<id>.result.json, served at /examples/<id>.result.json.
// web/public/theory/viewer.js draws it with three.js in place of the static
// figure, which stays for readers without JavaScript or WebGL. The Theory
// Guide's viewers of the same examples read it too (web/theory/viewers).
//
// The payload holds the surface vertices only, numbered in the order the
// triangles first use them, with every field the reader can switch between,
// the figure's field first, and the view and enlargement of the figure.

import { join } from "node:path";

/** Field names and units, as the page's figure caption names them. */
export const FIELDS = {
  displacement: { name: "Displacement magnitude |U|", unit: "mm" },
  vonMises: { name: "Von Mises stress", unit: "MPa" },
  density: { name: "Element density", unit: "" },
};

export const viewerFile = (dir, id) => join(dir, `${id}.result.json`);
export const viewerUrl = (id) => `/examples/${id}.result.json`;

const round = (v, digits) => Number(v.toPrecision(digits));

/**
 * The payload as JSON text.
 *
 * `surface` is { positions, displacements?, triangles }: flat xyz per node
 * and vertex-index triples. `fields` maps a field key to one value per node.
 * `figure` is the static figure's { field, deform, view, focus? }.
 */
export function viewerPayload(id, surface, fields, figure) {
  const nodes = surface.positions.length / 3;
  const keys = Object.keys(fields);
  for (const key of keys) {
    if (!FIELDS[key]) throw new Error(`${id}: no name for field "${key}"`);
    if (fields[key].length !== nodes)
      throw new Error(
        `${id}: ${key} has ${fields[key].length} values for ${nodes} nodes`,
      );
  }
  if (!keys.includes(figure.field))
    throw new Error(
      `${id}: the figure shows ${figure.field}, the view has ${keys.join(", ")}`,
    );
  const order = [figure.field, ...keys.filter((k) => k !== figure.field)];

  const index = new Map();
  const positions = [];
  const displacements = surface.displacements ? [] : undefined;
  const values = order.map(() => []);
  const triangles = surface.triangles.map((v) => {
    if (!index.has(v)) {
      index.set(v, index.size);
      for (let k = 0; k < 3; k++) {
        positions.push(round(surface.positions[3 * v + k], 7));
        displacements?.push(round(surface.displacements[3 * v + k], 5));
      }
      order.forEach((key, f) => values[f].push(round(fields[key][v], 5)));
    }
    return index.get(v);
  });

  const view = { direction: figure.view };
  if (figure.focus) {
    view.target = figure.focus.center;
    view.half = figure.focus.half;
  }
  return (
    JSON.stringify({
      id,
      deformScale: figure.deform,
      view,
      positions,
      displacements,
      triangles,
      fields: order.map((key, f) => ({
        key,
        ...FIELDS[key],
        values: values[f],
      })),
    }) + "\n"
  );
}

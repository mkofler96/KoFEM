// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Registry of the Theory Guide figures. Each is written by generate.mjs to
// public/theory/figures/<id>.svg and embedded with an <img>, so search
// engines index it as an image and it stays a crisp vector drawing.

import { esc, svgDocument } from "./svg.mjs";
import intro from "./intro.mjs";
import mechanics from "./mechanics.mjs";
import numerics from "./numerics.mjs";
import applications from "./applications.mjs";

const all = [...intro, ...mechanics, ...numerics, ...applications];

export const figures = new Map();
for (const definition of all) {
  if (figures.has(definition.id))
    throw new Error(`Duplicate theory figure id: ${definition.id}`);
  for (const key of ["title", "alt", "width", "height", "body"])
    if (!definition[key])
      throw new Error(`Theory figure ${definition.id} is missing ${key}`);
  figures.set(definition.id, definition);
}

export const figureUrl = (id) => `/theory/figures/${id}.svg`;

/** The standalone SVG file of a figure. */
export function figureSvg(id) {
  const definition = figures.get(id);
  if (!definition) throw new Error(`Unknown theory figure: ${id}`);
  return svgDocument({
    width: definition.width,
    height: definition.height,
    title: definition.title,
    description: definition.alt,
    body: definition.body,
  });
}

/**
 * An article figure: the SVG as an image with its alt text and a caption.
 * `size` is "full" (full column, default) or "narrow" (centred, smaller).
 */
export function figure(id, caption, size = "full") {
  const definition = figures.get(id);
  if (!definition) throw new Error(`Unknown theory figure: ${id}`);
  return `<figure class="theory-figure ${size}" id="figure-${id}">
      <a href="${figureUrl(id)}" class="figure-link"><img src="${figureUrl(id)}" width="${definition.width}" height="${definition.height}" alt="${esc(definition.alt)}" loading="lazy" decoding="async" /></a>
      <figcaption>${caption}</figcaption>
    </figure>`;
}

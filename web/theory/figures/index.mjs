// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Registry of the Theory Guide figures. generate.mjs publishes each through
// web/figure-assets.mjs as public/theory/figures/<id>.svg (site fonts
// embedded) and <id>.png (2×, the crawlable fallback); articles show them
// with a <picture>.

import { renderFigureFiles } from "../../figure-assets.mjs";
import { esc, FIGURE_DEFS, FIGURE_STYLE } from "./svg.mjs";
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

export const figureUrl = (id, format = "svg") =>
  `/theory/figures/${id}.${format}`;

/** A figure's files: { svg, png }, rendered from its definition. */
export async function figureFiles(id) {
  const definition = figures.get(id);
  if (!definition) throw new Error(`Unknown theory figure: ${id}`);
  const { light, png } = await renderFigureFiles(
    {
      body: `${FIGURE_DEFS}\n${definition.body}`,
      width: definition.width,
      height: definition.height,
      title: definition.title,
      alt: definition.alt,
      className: "",
    },
    { styles: { light: FIGURE_STYLE }, background: "#ffffff" },
  );
  return { svg: light, png };
}

/**
 * An article figure: the SVG for the browser, the PNG as the crawlable
 * fallback, alt text and a caption. The link opens the full-size SVG.
 * `size` is "full" (full column, default) or "narrow" (centred, smaller).
 */
export function figure(id, caption, size = "full") {
  const definition = figures.get(id);
  if (!definition) throw new Error(`Unknown theory figure: ${id}`);
  return `<figure class="theory-figure ${size}" id="figure-${id}">
      <a href="${figureUrl(id)}" class="figure-link"><picture class="figure-image"><source srcset="${figureUrl(id)}" type="image/svg+xml" /><img src="${figureUrl(id, "png")}" width="${definition.width}" height="${definition.height}" alt="${esc(definition.alt)}" loading="lazy" decoding="async" /></picture></a>
      <figcaption>${caption}</figcaption>
    </figure>`;
}

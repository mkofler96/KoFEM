// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  tex as sharedTex,
  texBlock as sharedTexBlock,
} from "../../../examples/validation/lib/tex.mjs";

// TeX sets ∂ and ∇ as ordinary symbols; MathML's default operator spacing
// would put gaps around them ("( ∂q/ ∂x)"). Tighten them for Theory pages
// without changing the generated example pages that share the renderer.
const ordinary = (mathml) =>
  mathml.replaceAll(/<mo>([∂∇])<\/mo>/gu, '<mo lspace="0" rspace="0">$1</mo>');

// Browsers do not line-break inside MathML. Split inline math after each
// top-level relation, where TeX breaks, so a long chain such as "a = b = c"
// can wrap on a phone; on one line the pieces render like the whole expression.
const RELATIONS = ["=", "≈", "\\approx", "≤", "≥", "<", ">"];
function splitAtRelations(src) {
  const pieces = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const char = src[i];
    if (char === "\\" && "{}".includes(src[i + 1] ?? "")) {
      i++;
      continue;
    }
    if ("({[".includes(char)) depth++;
    else if (")}]".includes(char)) depth--;
    else if (depth === 0 && i > start) {
      const relation = RELATIONS.find((r) => src.startsWith(r, i));
      const end = relation ? i + relation.length : i;
      if (relation && src.slice(start, i).trim() && src.slice(end).trim()) {
        pieces.push(src.slice(start, end));
        start = end;
        i = end - 1;
      }
    }
  }
  pieces.push(src.slice(start));
  return pieces;
}

/** Inline math for Theory prose: every symbol and expression, not plain text. */
export const tex = (src) =>
  splitAtRelations(src)
    .map((piece) => ordinary(sharedTex(piece)))
    .join("\u200b");
const texBlock = (src) => ordinary(sharedTexBlock(src));
// One unsplit expression's MathML children, for embedding in a larger <math>.
const inner = (src) => ordinary(sharedTex(src)).slice(6, -7);

const region = (math, label) =>
  `<div class="equation" tabindex="0" role="region" aria-label="${label}; scroll horizontally if needed">${math}</div>`;

export const equation = (expression, label) =>
  region(texBlock(expression), label);

// Native matrix layout complements the existing scalar TeX subset. Every cell
// still goes through its strict parser, and the result stays selectable MathML.
export const matrixEquation = (left, rows, label) =>
  region(
    `<math display="block">${inner(left)}<mrow><mo stretchy="true">[</mo><mtable>${rows.map((row) => `<mtr>${row.map((cell) => `<mtd>${inner(String(cell))}</mtd>`).join("")}</mtr>`).join("")}</mtable><mo stretchy="true">]</mo></mrow></math>`,
    label,
  );

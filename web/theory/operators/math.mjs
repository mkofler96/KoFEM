// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { tex, texBlock } from "../../../examples/validation/lib/tex.mjs";

const region = (math, label) =>
  `<div class="equation" tabindex="0" role="region" aria-label="${label}; scroll horizontally if needed">${math}</div>`;

export const equation = (expression, label) =>
  region(texBlock(expression), label);

// Native matrix layout complements the existing scalar TeX subset. Every cell
// still goes through its strict parser, and the result stays selectable MathML.
export const matrixEquation = (left, rows, label) =>
  region(
    `<math display="block">${tex(left).slice(6, -7)}<mrow><mo stretchy="true">[</mo><mtable>${rows.map((row) => `<mtr>${row.map((cell) => `<mtd>${tex(String(cell)).slice(6, -7)}</mtd>`).join("")}</mtr>`).join("")}</mtable><mo stretchy="true">]</mo></mrow></math>`,
    label,
  );

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";

export const evidence = JSON.parse(
  readFileSync(
    new URL("../../public/theory/shells.json", import.meta.url),
    "utf8",
  ),
);
export const source = (path, line, label) =>
  `<a href="https://github.com/mkofler96/KoFEM/blob/${evidence.sourceRevision}/${path}#L${line}">${label}</a>`;
export const number = (value, digits = 6) =>
  Number(value.toPrecision(digits)).toString();
export const percentError = (measured, reference) =>
  number(100 * Math.abs(measured / reference - 1), 3);
export const table = (caption, headings, rows) =>
  `<div class="table-wrap" tabindex="0" role="region" aria-label="${caption}; scroll horizontally if needed"><table class="shell-table">
    <caption>${caption}</caption><thead><tr>${headings.map((heading) => `<th scope="col">${heading}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(([label, ...cells]) => `<tr><th scope="row">${label}</th>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;

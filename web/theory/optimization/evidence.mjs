// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";

// Recorded by capture-evidence.mjs; articles render it, never retype it.
export const evidence = JSON.parse(
  readFileSync(
    new URL("../../public/theory/optimization.json", import.meta.url),
    "utf8",
  ),
);
export const revision = evidence.sourceRevision;
export const source = (path, line, label) =>
  `<a href="https://github.com/mkofler96/KoFEM/blob/${revision}/${path}#L${line}">${label}</a>`;
export const number = (value, digits = 4) =>
  Number(value.toPrecision(digits)).toString();
export const table = (caption, headings, rows) =>
  `<div class="table-wrap" tabindex="0" role="region" aria-label="${caption}; scroll horizontally if needed"><table class="shell-table">
    <caption>${caption}</caption><thead><tr>${headings.map((heading) => `<th scope="col">${heading}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(([label, ...cells]) => `<tr><th scope="row">${label}</th>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;

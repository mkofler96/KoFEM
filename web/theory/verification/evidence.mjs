// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";

// One numerical record feeds the article and the live WASM regression check.
export const evidence = JSON.parse(
  readFileSync(
    new URL("../../public/theory/axial-bar.json", import.meta.url),
    "utf8",
  ),
);
export const source = (path, line, label) =>
  `<a href="https://github.com/mkofler96/KoFEM/blob/${evidence.sourceRevision}/${path}#L${line}">${label}</a>`;
export const number = (value, digits = 6) =>
  Number(value.toPrecision(digits)).toString();

const examples = JSON.parse(
  readFileSync(
    new URL("../../public/examples/results.json", import.meta.url),
    "utf8",
  ),
);
export const publicCase = examples.cases.find(
  (entry) => entry.id === "axial-bar",
);
if (!publicCase) throw new Error("Published example record lacks axial-bar");

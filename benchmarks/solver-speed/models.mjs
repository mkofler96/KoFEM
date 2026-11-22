// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The models of the solver-speed study. The validation cases are meshed at
// the levels of their convergence studies (examples/validation/
// convergence.mjs); the wall bracket at the sizes below (mm), per order.
export const MODELS = [
  { kind: "case", id: "plate-with-hole" },
  { kind: "case", id: "cantilever-beam" },
  { kind: "case", id: "cooks-membrane" },
  {
    kind: "sample",
    id: "wall-bracket",
    levels: { 1: [40, 20, 3, 2.5, 2], 2: [40, 20, 3] },
  },
];

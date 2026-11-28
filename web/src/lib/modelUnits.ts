// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The units every model is in: the engine reads CAD in millimetres, so lengths
// are mm, forces N and stresses MPa (N/mm²), consistently from import to result.
export const MODEL_UNITS = {
  length: "mm",
  force: "N",
  stress: "MPa",
} as const;

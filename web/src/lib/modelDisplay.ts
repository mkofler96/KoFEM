// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

export function fmt(v: number, digits = 3) {
  if (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-2 && v !== 0))
    return v.toExponential(digits);
  return v.toPrecision(digits + 1);
}

export const PROP_TYPE_LABEL: Record<string, string> = {
  PSOLID: "3-D Solid",
  PSHELL: "Shell",
  PLPLANE: "Plane",
  PBAR: "Bar/Beam",
  PBEAM: "Beam",
};

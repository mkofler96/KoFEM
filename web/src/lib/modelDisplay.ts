// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

export function fmt(v: number, digits = 3) {
  if (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-2 && v !== 0))
    return v.toExponential(digits);
  return v.toPrecision(digits + 1);
}

// The pre-flight line for an applied load. Forces and pressures reach the
// solver as face tractions, moments and point loads as nodal DOFs — counting
// only the DOFs told a face-loaded model it had "0 load DOFs".
export function loadsSummary(nodalLoadDofs: number, faceLoads: number): string {
  const parts: string[] = [];
  if (faceLoads > 0)
    parts.push(`${faceLoads} face load${faceLoads > 1 ? "s" : ""}`);
  if (nodalLoadDofs > 0)
    parts.push(
      `${nodalLoadDofs} nodal load DOF${nodalLoadDofs > 1 ? "s" : ""}`,
    );
  return `Loads applied · ${parts.join(" · ")}`;
}

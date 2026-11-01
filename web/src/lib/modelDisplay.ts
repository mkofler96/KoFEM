// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

export function fmt(v: number, digits = 3) {
  if (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-2 && v !== 0))
    return v.toExponential(digits);
  return v.toPrecision(digits + 1);
}

// What is loaded, as the pre-flight checks and the status bar show it. Forces
// and pressures on faces (and shell edges) reach the solver as surface loads,
// moments and point loads as nodal DOFs — counting only the DOFs told a
// face-loaded model it had "0 load DOFs" (KOF-250).
export function loadCounts(nodalLoadDofs: number, faceLoads: number): string[] {
  const parts: string[] = [];
  if (faceLoads > 0)
    parts.push(`${faceLoads} face load${faceLoads > 1 ? "s" : ""}`);
  if (nodalLoadDofs > 0)
    parts.push(
      `${nodalLoadDofs} nodal load DOF${nodalLoadDofs > 1 ? "s" : ""}`,
    );
  return parts;
}

export function loadsSummary(nodalLoadDofs: number, faceLoads: number): string {
  return `Loads applied · ${loadCounts(nodalLoadDofs, faceLoads).join(" · ")}`;
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { tr } from "../i18n/useLocale";
import { modelSummaryMessages } from "../i18n/messages/viewport";

// eslint-disable-next-line kofem/no-silent-fallback -- display precision of a formatter, not model data
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
  const text = tr(modelSummaryMessages);
  const parts: string[] = [];
  if (faceLoads > 0) parts.push(text.faceLoads(faceLoads));
  if (nodalLoadDofs > 0) parts.push(text.nodalLoadDofs(nodalLoadDofs));
  return parts;
}

export function loadsSummary(nodalLoadDofs: number, faceLoads: number): string {
  return tr(modelSummaryMessages).loadsApplied(
    loadCounts(nodalLoadDofs, faceLoads).join(" · "),
  );
}

// The mesh row of the Solve and Optimize pre-flight checks. A mesh made before
// a body was suppressed or restored is stale, and `stale` says why.
export function meshCheckLabel(
  nodeCount: number,
  elementCount: number,
  stale: string | null,
): string {
  if (stale !== null) return stale;
  const text = tr(modelSummaryMessages);
  if (nodeCount === 0) return text.noMesh;
  return text.meshReady(nodeCount, elementCount);
}

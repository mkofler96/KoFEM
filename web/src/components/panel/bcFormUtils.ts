// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { loadKind, loadComponents } from "../../store/modelStore";
import type {
  FaceSelection,
  LoadKind,
  NamedLoadGroup,
} from "../../store/modelStore";
import { fmt } from "../../lib/modelDisplay";

export const DOF_LABELS = ["Ux", "Uy", "Uz", "Rx", "Ry", "Rz"];
export const FORCE_LABELS = ["Fx", "Fy", "Fz"];
export const MOMENT_LABELS = ["Mx", "My", "Mz"];

// One-line summary of a load group for the group list: pressure magnitude, or
// the non-zero force/moment components (e.g. "Fx = 100, Fz = -50 N").
export function loadGroupMeta(group: NamedLoadGroup): string {
  const kind = loadKind(group);
  if (kind === "pressure") return `p = ${fmt(group.totalForce)} MPa`;
  const labels = kind === "moment" ? MOMENT_LABELS : FORCE_LABELS;
  const unit = kind === "moment" ? "N·mm" : "N";
  const parts = loadComponents(group)
    .map((value, i) => (value !== 0 ? `${labels[i]} = ${fmt(value)}` : null))
    .filter((part): part is string => part !== null);
  return `${parts.join(", ")} ${unit}`;
}

// Stable list key for a picked face: a face is uniquely determined by its node
// set, so a compact signature of it identifies the entry across re-renders.
export function faceKey(face: FaceSelection): string {
  return `${face.nodeIds.length}-${face.nodeIds[0]}-${face.nodeIds[face.nodeIds.length - 1]}`;
}

export function toFaceEntries(
  faces: FaceSelection[],
  existingCount: number,
  noun: "Face" | "Edge" = "Face",
) {
  return faces.map((face, i) => ({
    label: `${noun} ${existingCount + i + 1}`,
    nodeIds: face.nodeIds,
  }));
}

// A zero pressure is a no-op load: it contributes nothing to the RHS and the
// solver returns a plausible-looking field with the input silently discarded.
// Reject it (and non-finite input) instead of coercing to 0.
export function parsePressure(
  raw: string,
  onError: (msg: string) => void,
): number | null {
  const pressure = parseFloat(raw);
  if (!isFinite(pressure) || pressure === 0) {
    onError("Pressure must be a non-zero finite number");
    return null;
  }
  return pressure;
}

// Parse a componentwise force/moment vector. Reject non-finite components and
// the all-zero vector (a no-op load that would be silently discarded).
export function parseLoadVector(
  vec: [string, string, string],
  kind: LoadKind,
  onError: (msg: string) => void,
): [number, number, number] | null {
  const noun = kind === "moment" ? "moment" : "force";
  const parsed = vec.map((comp) => parseFloat(comp));
  if (parsed.some((comp) => !isFinite(comp))) {
    onError(`Each ${noun} component must be a finite number`);
    return null;
  }
  if (parsed.every((comp) => comp === 0)) {
    onError(`Specify a non-zero ${noun} component`);
    return null;
  }
  return [parsed[0], parsed[1], parsed[2]];
}

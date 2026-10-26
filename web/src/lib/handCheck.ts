// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  Material,
  NamedLoadGroup,
  Node,
  Property,
  SolverResult,
} from "../store/modelStore";
import { loadComponents, loadKind } from "../store/modelStore";

// A closed-form result an example carries so a first-time user can judge the
// solve (KOF-261): the quantity read off the solved field, the hand formula it
// should match, and the model the formula was worked out for. Written by the
// gallery generator into the analysis file; the app never makes one up.
export interface HandCheck {
  // What is compared, e.g. "Tip deflection".
  quantity: string;
  // Where it is read: one displacement component averaged over the nodes of a
  // load group's faces.
  probe: { loadGroupId: number; component: 0 | 1 | 2 };
  // The hand formula and its value in mm, both signed like the probed component.
  formula: string;
  reference: number;
  // The load and material the formula assumes. Once the user changes either,
  // the hand calculation no longer describes the model and is withheld.
  assumes: { force: [number, number, number]; young: number };
}

export type HandCheckOutcome =
  { kind: "compare"; fe: number } | { kind: "changed" };

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(
      `Invalid analysis file: handCheck.${field} must be a non-empty string, got ${JSON.stringify(value)}`,
    );
  return value;
}

function expectFinite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(
      `Invalid analysis file: handCheck.${field} must be a finite number, got ${JSON.stringify(value)}`,
    );
  return value;
}

function expectObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(
      `Invalid analysis file: handCheck${field} must be an object, got ${JSON.stringify(value)}`,
    );
  return value as Record<string, unknown>;
}

// Validates the `handCheck` block of an analysis file.
export function parseHandCheck(raw: unknown): HandCheck {
  const check = expectObject(raw, "");
  const probe = expectObject(check.probe, ".probe");
  const assumes = expectObject(check.assumes, ".assumes");
  const component = probe.component;
  if (component !== 0 && component !== 1 && component !== 2)
    throw new Error(
      `Invalid analysis file: handCheck.probe.component must be 0, 1 or 2 (Ux, Uy, Uz), got ${JSON.stringify(component)}`,
    );
  const force = assumes.force;
  if (!Array.isArray(force) || force.length !== 3)
    throw new Error(
      `Invalid analysis file: handCheck.assumes.force must be [Fx, Fy, Fz], got ${JSON.stringify(force)}`,
    );
  return {
    quantity: expectString(check.quantity, "quantity"),
    probe: {
      loadGroupId: expectFinite(probe.loadGroupId, "probe.loadGroupId"),
      component,
    },
    formula: expectString(check.formula, "formula"),
    reference: expectFinite(check.reference, "reference"),
    assumes: {
      force: [
        expectFinite(force[0], "assumes.force[0]"),
        expectFinite(force[1], "assumes.force[1]"),
        expectFinite(force[2], "assumes.force[2]"),
      ],
      young: expectFinite(assumes.young, "assumes.young"),
    },
  };
}

const sameValue = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

// The FE value of the check on the solved field, or "changed" when the load or
// a body's material no longer is the one the formula assumes. Null when the
// probed load group is gone or empty — the check has nothing left to read.
export function evaluateHandCheck(
  check: HandCheck,
  model: {
    nodes: Node[];
    loadGroups: NamedLoadGroup[];
    materials: Material[];
    properties: Property[];
    result: SolverResult;
  },
): HandCheckOutcome | null {
  const group = model.loadGroups.find((g) => g.id === check.probe.loadGroupId);
  if (!group) return null;
  const force = loadComponents(group);
  const loadUnchanged =
    loadKind(group) === "force" &&
    force.every((value, axis) => sameValue(value, check.assumes.force[axis]));
  const materialUnchanged = model.properties.every((prop) => {
    const material = model.materials.find((m) => m.id === prop.materialId);
    return (
      material !== undefined && sameValue(material.young, check.assumes.young)
    );
  });
  if (!loadUnchanged || !materialUnchanged) return { kind: "changed" };

  const index = new Map(model.nodes.map((node, i) => [node.id, i]));
  const probed = new Set(group.faces.flatMap((face) => face.nodeIds));
  if (probed.size === 0) return null;
  let sum = 0;
  for (const nodeId of probed) {
    const i = index.get(nodeId);
    if (i === undefined)
      throw new Error(
        `Hand check: load group "${group.name}" references node ${nodeId}, which is not in the mesh`,
      );
    sum += model.result.displacements[3 * i + check.probe.component];
  }
  return { kind: "compare", fe: sum / probed.size };
}

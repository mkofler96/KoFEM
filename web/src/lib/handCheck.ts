// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BcFaceEntry,
  Material,
  NamedBcGroup,
  NamedLoadGroup,
  Node,
  Property,
  SolverResult,
} from "../store/modelStore";
import { loadComponents, loadKind } from "../store/boundarySlice";

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
  // The problem the formula was worked out for: every load and every support,
  // each on whole CAD faces, and the Young's modulus of every body. Once the
  // model differs in any of them, the hand calculation no longer describes it
  // and is withheld.
  assumes: {
    loads: { force: [number, number, number]; cadFaceIds: number[] }[];
    supports: { dofs: number[]; value: number; cadFaceIds: number[] }[];
    young: number;
  };
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

function expectArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value))
    throw new Error(
      `Invalid analysis file: handCheck.${field} must be an array, got ${JSON.stringify(value)}`,
    );
  return value;
}

const expectNumbers = (value: unknown, field: string) =>
  expectArray(value, field).map((v, i) => expectFinite(v, `${field}[${i}]`));

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
  return {
    quantity: expectString(check.quantity, "quantity"),
    probe: {
      loadGroupId: expectFinite(probe.loadGroupId, "probe.loadGroupId"),
      component,
    },
    formula: expectString(check.formula, "formula"),
    reference: expectFinite(check.reference, "reference"),
    assumes: {
      loads: expectArray(assumes.loads, "assumes.loads").map((raw, i) => {
        const field = `assumes.loads[${i}]`;
        const load = expectObject(raw, `.${field}`);
        const force = expectNumbers(load.force, `${field}.force`);
        if (force.length !== 3)
          throw new Error(
            `Invalid analysis file: handCheck.${field}.force must be [Fx, Fy, Fz], got ${JSON.stringify(load.force)}`,
          );
        return {
          force: [force[0], force[1], force[2]],
          cadFaceIds: expectNumbers(load.cadFaceIds, `${field}.cadFaceIds`),
        };
      }),
      supports: expectArray(assumes.supports, "assumes.supports").map(
        (raw, i) => {
          const field = `assumes.supports[${i}]`;
          const support = expectObject(raw, `.${field}`);
          return {
            dofs: expectNumbers(support.dofs, `${field}.dofs`),
            value: expectFinite(support.value, `${field}.value`),
            cadFaceIds: expectNumbers(
              support.cadFaceIds,
              `${field}.cadFaceIds`,
            ),
          };
        },
      ),
      young: expectFinite(assumes.young, "assumes.young"),
    },
  };
}

const sameValue = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

const sameMembers = (actual: number[], expected: number[]) =>
  actual.length === expected.length &&
  expected.every((value) => actual.includes(value));

const onFaces = (faces: BcFaceEntry[], cadFaceIds: number[]) =>
  faces.length === cadFaceIds.length &&
  cadFaceIds.every((id) => faces.some((face) => face.cadFaceId === id));

// Whether every group pairs up with one of the assumed ones, and none is extra
// or missing.
function sameGroups<G, A>(
  groups: G[],
  assumed: A[],
  matches: (group: G, assumption: A) => boolean,
): boolean {
  return (
    groups.length === assumed.length &&
    groups.every((group) => assumed.some((a) => matches(group, a)))
  );
}

// The FE value of the check on the solved field, or "changed" when a load, a
// support or a body's material no longer is the one the formula assumes. Null
// when the probed load group is gone or empty — the check has nothing left to
// read.
export function evaluateHandCheck(
  check: HandCheck,
  model: {
    nodes: Node[];
    loadGroups: NamedLoadGroup[];
    bcGroups: NamedBcGroup[];
    materials: Material[];
    properties: Property[];
    result: SolverResult;
  },
): HandCheckOutcome | null {
  const group = model.loadGroups.find((g) => g.id === check.probe.loadGroupId);
  if (!group) return null;
  const loadsUnchanged = sameGroups(
    model.loadGroups,
    check.assumes.loads,
    (g, load) =>
      loadKind(g) === "force" &&
      loadComponents(g).every((value, axis) =>
        sameValue(value, load.force[axis]),
      ) &&
      onFaces(g.faces, load.cadFaceIds),
  );
  const supportsUnchanged = sameGroups(
    model.bcGroups,
    check.assumes.supports,
    (g, support) =>
      sameMembers(g.dofs, support.dofs) &&
      sameValue(g.value, support.value) &&
      onFaces(g.faces, support.cadFaceIds),
  );
  const materialUnchanged = model.properties.every((prop) => {
    const material = model.materials.find((m) => m.id === prop.materialId);
    return (
      material !== undefined && sameValue(material.young, check.assumes.young)
    );
  });
  if (!loadsUnchanged || !supportsUnchanged || !materialUnchanged)
    return { kind: "changed" };

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

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BcFaceEntry,
  Element,
  Material,
  NamedBcGroup,
  NamedLoadGroup,
  Node,
  Property,
  SolverResult,
} from "../store/modelStore";
import { loadComponents, loadKind } from "../store/boundaryGroups";
import { nodeVonMisesField } from "./resultField";

// A closed-form result an example carries so a user can judge the solve
// (KOF-261, KOF-322): the quantity read off the solved field, the hand formula
// it should match, and the model the formula was worked out for. Written by
// the example generators into the analysis file; the app never makes one up.

export type Axis = 0 | 1 | 2;

// The unit of the probe's value and of `reference`; "" is dimensionless (e.g. a
// stress concentration factor Kt = σmax / σnom, read with `divideBy`).
export type HandCheckUnit = "mm" | "rad" | "MPa" | "";

// Where the FE value is read. CAD faces are resolved on the current mesh (its
// surfaceTriangles / surfaceFaceIds), so a probe survives a re-mesh.
export type HandCheckProbe =
  // One displacement component, the mean over the nodes of these CAD faces.
  | { kind: "displacement"; component: Axis; cadFaceIds: number[] }
  // One displacement component at the mesh node nearest the point (mm).
  | { kind: "displacement"; component: Axis; point: [number, number, number] }
  // Rotation about a global axis through the faces' node centroid (rad): the
  // mean over the faces' nodes off that axis of (r × u)_axis / |r⊥|².
  | { kind: "twist"; axis: Axis; cadFaceIds: number[] }
  // The largest nodal von Mises stress (MPa), averaged to the nodes exactly as
  // the result plot averages it, over these CAD faces' nodes or all nodes.
  | { kind: "stress"; field: "vonMises"; stat: "max"; cadFaceIds?: number[] };

// A load the formula assumes, on whole CAD faces: a force vector (N), a
// pressure (MPa) or a moment about a global axis (N·mm).
export type AssumedLoad =
  | { kind: "force"; force: [number, number, number]; cadFaceIds: number[] }
  | { kind: "pressure"; value: number; cadFaceIds: number[] }
  | { kind: "moment"; axis: Axis; value: number; cadFaceIds: number[] };

export interface AssumedSupport {
  dofs: number[];
  value: number;
  cadFaceIds: number[];
}

export interface HandCheck {
  // What is compared, e.g. "Tip deflection".
  quantity: string;
  // The hand formula and its value in `unit`, both signed like the probe.
  formula: string;
  reference: number;
  unit: HandCheckUnit;
  // When set (> 0), the value read by the probe is divided by it before the
  // comparison — e.g. the nominal stress, to compare a Kt.
  divideBy?: number;
  probe: HandCheckProbe;
  // The problem the formula was worked out for: every load and every support,
  // each on whole CAD faces, and the Young's modulus and Poisson's ratio of
  // every body. Once the model differs in any of them, the hand calculation no
  // longer describes it and is withheld.
  assumes: {
    loads: AssumedLoad[];
    supports: AssumedSupport[];
    young: number;
    // Required, except on a block migrated from v0.5/v0.6 (`migratedFrom`):
    // those were bending checks, δ = P·L³ / (3·E·I), independent of ν, so they
    // assume none and ν is not compared.
    poisson?: number;
  };
  // Set only on a block migrated from the shape released in v0.5.0 / v0.6.0
  // (migrateLegacyHandCheck). It is kept when the file is saved again, so the
  // migrated block, which assumes no ν, still opens.
  migratedFrom?: typeof LEGACY_SHAPE;
}

// The `migratedFrom` value of a block migrated from the v0.5.0 / v0.6.0 shape.
export const LEGACY_SHAPE = "v0.6";

export type HandCheckOutcome =
  { kind: "compare"; fe: number } | { kind: "changed" };

const fail = (message: string): never => {
  throw new Error(`Invalid analysis file: handCheck.${message}`);
};

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    fail(`${field} must be a non-empty string, got ${JSON.stringify(value)}`);
  return value as string;
}

function expectFinite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(`${field} must be a finite number, got ${JSON.stringify(value)}`);
  return value as number;
}

function expectArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value))
    fail(`${field} must be an array, got ${JSON.stringify(value)}`);
  return value as unknown[];
}

const expectNumbers = (value: unknown, field: string) =>
  expectArray(value, field).map((v, i) => expectFinite(v, `${field}[${i}]`));

function expectVector(value: unknown, field: string): [number, number, number] {
  const vec = expectNumbers(value, field);
  if (vec.length !== 3)
    fail(`${field} must be [x, y, z], got ${JSON.stringify(value)}`);
  return [vec[0], vec[1], vec[2]];
}

function expectAxis(value: unknown, field: string): Axis {
  if (value !== 0 && value !== 1 && value !== 2)
    fail(`${field} must be 0, 1 or 2 (x, y, z), got ${JSON.stringify(value)}`);
  return value as Axis;
}

function expectFaceIds(value: unknown, field: string): number[] {
  const ids = expectArray(value, field);
  if (ids.length === 0) fail(`${field} must name at least one CAD face`);
  return ids.map((id, i) => {
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1)
      fail(
        `${field}[${i}] must be a CAD face id (a positive integer), got ${JSON.stringify(id)}`,
      );
    return id as number;
  });
}

function expectObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(
      `Invalid analysis file: handCheck${field ? `.${field}` : ""} must be an object, got ${JSON.stringify(value)}`,
    );
  return value as Record<string, unknown>;
}

const UNITS: readonly HandCheckUnit[] = ["mm", "rad", "MPa", ""];

function parseProbe(raw: unknown): HandCheckProbe {
  const probe = expectObject(raw, "probe");
  switch (probe.kind) {
    case "displacement": {
      const component = expectAxis(probe.component, "probe.component");
      if ((probe.point === undefined) === (probe.cadFaceIds === undefined))
        fail(
          "probe must give either point or cadFaceIds for a displacement, not both or neither",
        );
      return probe.point !== undefined
        ? {
            kind: "displacement",
            component,
            point: expectVector(probe.point, "probe.point"),
          }
        : {
            kind: "displacement",
            component,
            cadFaceIds: expectFaceIds(probe.cadFaceIds, "probe.cadFaceIds"),
          };
    }
    case "twist":
      return {
        kind: "twist",
        axis: expectAxis(probe.axis, "probe.axis"),
        cadFaceIds: expectFaceIds(probe.cadFaceIds, "probe.cadFaceIds"),
      };
    case "stress":
      if (probe.field !== "vonMises")
        fail(
          `probe.field must be "vonMises", got ${JSON.stringify(probe.field)}`,
        );
      if (probe.stat !== "max")
        fail(`probe.stat must be "max", got ${JSON.stringify(probe.stat)}`);
      return probe.cadFaceIds === undefined
        ? { kind: "stress", field: "vonMises", stat: "max" }
        : {
            kind: "stress",
            field: "vonMises",
            stat: "max",
            cadFaceIds: expectFaceIds(probe.cadFaceIds, "probe.cadFaceIds"),
          };
    default:
      return fail(
        `probe.kind must be "displacement", "twist" or "stress", got ${JSON.stringify(probe.kind)}`,
      );
  }
}

function parseLoad(raw: unknown, i: number): AssumedLoad {
  const field = `assumes.loads[${i}]`;
  const load = expectObject(raw, field);
  const cadFaceIds = expectFaceIds(load.cadFaceIds, `${field}.cadFaceIds`);
  switch (load.kind) {
    case "force":
      return {
        kind: "force",
        force: expectVector(load.force, `${field}.force`),
        cadFaceIds,
      };
    case "pressure":
      return {
        kind: "pressure",
        value: expectFinite(load.value, `${field}.value`),
        cadFaceIds,
      };
    case "moment":
      return {
        kind: "moment",
        axis: expectAxis(load.axis, `${field}.axis`),
        value: expectFinite(load.value, `${field}.value`),
        cadFaceIds,
      };
    default:
      return fail(
        `${field}.kind must be "force", "pressure" or "moment", got ${JSON.stringify(load.kind)}`,
      );
  }
}

function parseSupport(raw: unknown, i: number): AssumedSupport {
  const field = `assumes.supports[${i}]`;
  const support = expectObject(raw, field);
  return {
    dofs: expectNumbers(support.dofs, `${field}.dofs`),
    value: expectFinite(support.value, `${field}.value`),
    cadFaceIds: expectFaceIds(support.cadFaceIds, `${field}.cadFaceIds`),
  };
}

// Whether a handCheck block is in the shape released in v0.5.0 and v0.6.0: no
// unit, and a probe that names a load group and a component but no kind.
function isLegacyShape(check: Record<string, unknown>): boolean {
  const probe = check.probe;
  return (
    check.unit === undefined &&
    typeof probe === "object" &&
    probe !== null &&
    !Array.isArray(probe) &&
    "loadGroupId" in probe &&
    "component" in probe &&
    !("kind" in probe)
  );
}

// Migrates a handCheck block in the v0.5.0 / v0.6.0 shape:
//
//   { quantity, formula, reference,
//     probe: { loadGroupId, component },
//     assumes: { loads: [{ force, cadFaceIds }], supports, young } }
//
// That shape could only express a deflection of a force-loaded model: a
// displacement in mm, the mean `component` over the nodes of the probed load
// group's faces. So the unit is "mm", each load is a force, and the probe reads
// the faces of the one assumed load: while the loads are as assumed (the check
// is withheld otherwise), that load is the probed group. A block with no or
// several assumed loads does not say which faces the probe read and is
// rejected. The checks shipped in that shape were bending checks, independent
// of ν, so the migrated block assumes no ν.
function migrateLegacyHandCheck(check: Record<string, unknown>): HandCheck {
  const probe = expectObject(check.probe, "probe");
  const assumes = expectObject(check.assumes, "assumes");
  const loadGroupId = expectFinite(probe.loadGroupId, "probe.loadGroupId");
  const loads = expectArray(assumes.loads, "assumes.loads").map((raw, i) => {
    const field = `assumes.loads[${i}]`;
    const load = expectObject(raw, field);
    if (load.kind !== undefined)
      fail(
        `${field}.kind is set, but the block is in the v0.5/v0.6 shape (no unit, a probe of load group ${loadGroupId}), whose loads are forces without a kind`,
      );
    return {
      kind: "force" as const,
      force: expectVector(load.force, `${field}.force`),
      cadFaceIds: expectFaceIds(load.cadFaceIds, `${field}.cadFaceIds`),
    };
  });
  if (loads.length !== 1)
    fail(
      `probe reads load group ${loadGroupId} (the v0.5/v0.6 shape), but the block assumes ${loads.length} loads, so the faces it read are unknown: it must assume exactly one load`,
    );
  if (assumes.poisson !== undefined)
    fail(
      "assumes.poisson is set, but the block is in the v0.5/v0.6 shape, which assumes no Poisson's ratio",
    );
  return {
    quantity: expectString(check.quantity, "quantity"),
    formula: expectString(check.formula, "formula"),
    reference: expectFinite(check.reference, "reference"),
    unit: "mm",
    probe: {
      kind: "displacement",
      component: expectAxis(probe.component, "probe.component"),
      cadFaceIds: [...loads[0].cadFaceIds],
    },
    assumes: {
      loads,
      supports: expectArray(assumes.supports, "assumes.supports").map(
        parseSupport,
      ),
      young: expectFinite(assumes.young, "assumes.young"),
    },
    migratedFrom: LEGACY_SHAPE,
  };
}

// Validates the `handCheck` block of an analysis file; a block in the shape
// released in v0.5.0 / v0.6.0 is migrated first (migrateLegacyHandCheck).
export function parseHandCheck(raw: unknown): HandCheck {
  const check = expectObject(raw, "");
  if (isLegacyShape(check)) return migrateLegacyHandCheck(check);
  const assumes = expectObject(check.assumes, "assumes");
  if (check.migratedFrom !== undefined && check.migratedFrom !== LEGACY_SHAPE)
    fail(
      `migratedFrom must be "${LEGACY_SHAPE}" when set, got ${JSON.stringify(check.migratedFrom)}`,
    );
  const migrated = check.migratedFrom === LEGACY_SHAPE;
  if (migrated && assumes.poisson !== undefined)
    fail(
      `assumes.poisson is set, but the block is migrated from ${LEGACY_SHAPE}, which assumes no Poisson's ratio`,
    );
  if (!UNITS.includes(check.unit as HandCheckUnit))
    fail(
      `unit must be "mm", "rad", "MPa" or "" (dimensionless), got ${JSON.stringify(check.unit)}`,
    );
  const parsed: HandCheck = {
    quantity: expectString(check.quantity, "quantity"),
    formula: expectString(check.formula, "formula"),
    reference: expectFinite(check.reference, "reference"),
    unit: check.unit as HandCheckUnit,
    probe: parseProbe(check.probe),
    assumes: {
      loads: expectArray(assumes.loads, "assumes.loads").map(parseLoad),
      supports: expectArray(assumes.supports, "assumes.supports").map(
        parseSupport,
      ),
      young: expectFinite(assumes.young, "assumes.young"),
    },
  };
  if (migrated) parsed.migratedFrom = LEGACY_SHAPE;
  else
    parsed.assumes.poisson = expectFinite(assumes.poisson, "assumes.poisson");
  if (check.divideBy !== undefined) {
    const divideBy = expectFinite(check.divideBy, "divideBy");
    if (divideBy <= 0) fail(`divideBy must be greater than 0, got ${divideBy}`);
    parsed.divideBy = divideBy;
  }
  return parsed;
}

const sameValue = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

const sameMembers = (actual: number[], expected: number[]) =>
  actual.length === expected.length &&
  expected.every((value) => actual.includes(value));

const onFaces = (faces: BcFaceEntry[], cadFaceIds: number[]) =>
  faces.length === cadFaceIds.length &&
  cadFaceIds.every((id) => faces.some((face) => face.cadFaceId === id));

const sameVector = (actual: number[], expected: number[]) =>
  actual.every((value, axis) => sameValue(value, expected[axis]));

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

function sameLoad(group: NamedLoadGroup, load: AssumedLoad): boolean {
  if (loadKind(group) !== load.kind || !onFaces(group.faces, load.cadFaceIds))
    return false;
  switch (load.kind) {
    case "force":
      return sameVector(loadComponents(group), load.force);
    case "pressure":
      return sameValue(group.totalForce, load.value);
    case "moment": {
      const moment: [number, number, number] = [0, 0, 0];
      moment[load.axis] = load.value;
      return sameVector(loadComponents(group), moment);
    }
  }
}

export interface HandCheckModel {
  nodes: Node[];
  elements: Element[];
  // The current mesh's surface triangles (node ids) and the CAD face of each.
  surfaceTriangles: [number, number, number][] | null;
  surfaceFaceIds: number[] | null;
  loadGroups: NamedLoadGroup[];
  bcGroups: NamedBcGroup[];
  materials: Material[];
  properties: Property[];
  result: SolverResult;
}

// Indices (into `nodes`) of the nodes of these CAD faces on the current mesh.
// Shell mid-surface facets carry the CAD face of the wall they were collapsed
// from, so a wall face resolves to its mid-surface nodes; a face the mesh no
// longer has on its surface (e.g. a wall's thin side face) is an error.
function cadFaceNodes(
  cadFaceIds: number[],
  model: HandCheckModel,
  index: Map<number, number>,
): number[] {
  const { surfaceTriangles, surfaceFaceIds } = model;
  if (!surfaceTriangles || !surfaceFaceIds)
    throw new Error(
      "Hand check: the mesh has no CAD face numbering, so its probe faces cannot be found",
    );
  if (surfaceTriangles.length !== surfaceFaceIds.length)
    throw new Error(
      `Hand check: the mesh has ${surfaceTriangles.length} surface triangles but ${surfaceFaceIds.length} CAD face ids`,
    );
  const wanted = new Set(cadFaceIds);
  const found = new Set<number>();
  const out = new Set<number>();
  surfaceTriangles.forEach((tri, t) => {
    const face = surfaceFaceIds[t];
    if (!wanted.has(face)) return;
    found.add(face);
    for (const nodeId of tri) {
      const i = index.get(nodeId);
      if (i === undefined)
        throw new Error(
          `Hand check: CAD face ${face} references node ${nodeId}, which is not in the mesh`,
        );
      out.add(i);
    }
  });
  const missing = cadFaceIds.filter((id) => !found.has(id));
  if (missing.length > 0)
    throw new Error(
      `Hand check: CAD face${missing.length === 1 ? "" : "s"} ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not on the current mesh's surface`,
    );
  return [...out].sort((a, b) => a - b);
}

function nearestNode(nodes: Node[], point: [number, number, number]): number {
  let best = -1;
  let bestDist = Infinity;
  nodes.forEach((node, i) => {
    const dist =
      (node.x - point[0]) ** 2 +
      (node.y - point[1]) ** 2 +
      (node.z - point[2]) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  if (best < 0) throw new Error("Hand check: the mesh has no nodes");
  return best;
}

// Mean rotation about `axis` through the nodes' centroid, from their
// translations: θ ≈ (r × u)_axis / |r⊥|² per node, for small rotations.
function meanTwist(
  picked: number[],
  axis: Axis,
  nodes: Node[],
  disp: Float64Array,
): number {
  const coords = picked.map((i) => [nodes[i].x, nodes[i].y, nodes[i].z]);
  const centroid = [0, 1, 2].map(
    (c) => coords.reduce((sum, p) => sum + p[c], 0) / coords.length,
  );
  // The two axes spanning the plane normal to `axis`, in right-handed order so
  // (r × u)_axis = r_a·u_b − r_b·u_a.
  const axisA = (axis + 1) % 3;
  const axisB = (axis + 2) % 3;
  const arms = coords.map((p) => [
    p[axisA] - centroid[axisA],
    p[axisB] - centroid[axisB],
  ]);
  const armSq = arms.map(([ra, rb]) => ra * ra + rb * rb);
  // Nodes on the axis itself carry no rotation information.
  const onAxis = 1e-12 * Math.max(...armSq);
  let sum = 0;
  let count = 0;
  picked.forEach((i, k) => {
    if (armSq[k] <= onAxis) return;
    const [ra, rb] = arms[k];
    sum += (ra * disp[3 * i + axisB] - rb * disp[3 * i + axisA]) / armSq[k];
    count++;
  });
  if (count === 0)
    throw new Error(
      "Hand check: the twist probe's faces have no node off the twist axis",
    );
  return sum / count;
}

// The value the probe reads off the solved field, before `divideBy`.
function readProbe(probe: HandCheckProbe, model: HandCheckModel): number {
  const { nodes, result } = model;
  const disp = result.displacements;
  if (disp.length !== 3 * nodes.length)
    throw new Error(
      `Hand check: the result has ${disp.length} displacement values for ${nodes.length} nodes — it belongs to a different mesh`,
    );
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  switch (probe.kind) {
    case "displacement": {
      if ("point" in probe)
        return disp[3 * nearestNode(nodes, probe.point) + probe.component];
      const picked = cadFaceNodes(probe.cadFaceIds, model, index);
      return (
        picked.reduce((sum, i) => sum + disp[3 * i + probe.component], 0) /
        picked.length
      );
    }
    case "twist":
      return meanTwist(
        cadFaceNodes(probe.cadFaceIds, model, index),
        probe.axis,
        nodes,
        disp,
      );
    case "stress": {
      const vm = nodeVonMisesField(result, nodes, model.elements);
      if (!vm)
        throw new Error(
          "Hand check: the result has no von Mises stress to read",
        );
      const picked = probe.cadFaceIds
        ? cadFaceNodes(probe.cadFaceIds, model, index)
        : nodes.map((_, i) => i);
      return picked.reduce((max, i) => Math.max(max, vm[i]), -Infinity);
    }
  }
}

// The FE value of the check on the solved field, or "changed" when a load, a
// support or a body's material (E, and ν unless the check assumes none) no
// longer is the one the formula assumes.
// Throws when the probe cannot be read on this mesh and result.
export function evaluateHandCheck(
  check: HandCheck,
  model: HandCheckModel,
): HandCheckOutcome {
  const loadsUnchanged = sameGroups(
    model.loadGroups,
    check.assumes.loads,
    sameLoad,
  );
  const supportsUnchanged = sameGroups(
    model.bcGroups,
    check.assumes.supports,
    (g, support) =>
      sameMembers(g.dofs, support.dofs) &&
      sameValue(g.value, support.value) &&
      onFaces(g.faces, support.cadFaceIds),
  );
  const { young, poisson } = check.assumes;
  const materialUnchanged = model.properties.every((prop) => {
    const material = model.materials.find((m) => m.id === prop.materialId);
    return (
      material !== undefined &&
      sameValue(material.young, young) &&
      // A migrated v0.5/v0.6 bending check assumes no ν (HandCheck.assumes).
      (poisson === undefined || sameValue(material.poisson, poisson))
    );
  });
  if (!loadsUnchanged || !supportsUnchanged || !materialUnchanged)
    return { kind: "changed" };
  const value = readProbe(check.probe, model);
  return {
    kind: "compare",
    fe: check.divideBy === undefined ? value : value / check.divideBy,
  };
}

const SUPERSCRIPT: Record<string, string> = {
  "-": "⁻",
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
};

// A hand-check value as the Results panel shows it: four significant digits
// (scientific notation outside 0.001–10⁶), a typographic minus like the
// formula's, and the unit (none when dimensionless).
export function formatHandCheckValue(
  value: number,
  unit: HandCheckUnit,
): string {
  const magnitude = Math.abs(value);
  let digits: string;
  if (magnitude !== 0 && (magnitude < 1e-3 || magnitude >= 1e6)) {
    const [mantissa, exponent] = value.toExponential(3).split("e");
    const power = [...exponent.replace("+", "")]
      .map((char) => SUPERSCRIPT[char])
      .join("");
    digits = `${mantissa}×10${power}`;
  } else digits = magnitude >= 1000 ? value.toFixed(0) : value.toPrecision(4);
  const text = digits.replace("-", "−");
  return unit === "" ? text : `${text} ${unit}`;
}

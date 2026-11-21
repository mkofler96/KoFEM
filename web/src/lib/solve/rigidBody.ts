// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Before a solve, say which body the supports leave free to slide or spin
// (KOF-388). A loose body makes the stiffness matrix singular, and the solve
// would fail later with a message about numbers; this check names the body and
// the motion instead.
//
// The check itself is Rust (kofem_fem::rigid_body, through `freeRigidMotions`);
// this module builds its input from a model and words its answer. Two inputs:
//
//   modelRigidBodyInput   — the store model: elements, supports, ties and
//                           couplings as the user defined them. For the solid,
//                           shell and auto-shell paths (the auto-shell path is
//                           checked on the solid model the user sees, before
//                           its Shell bodies are idealised).
//   coupledRigidBodyInput — the coupled solve's own inputs, where shells and
//                           solids are separate node sets joined by couplings
//                           the builder derives from proximity. Only these
//                           show whether a shell reaches the solid it stands on.

import type {
  Constraint,
  Element,
  Node,
  Property,
  SolveModel,
} from "../../workers/solverTypes.js";
import type { CoupledEngineInputs } from "./coupled.js";
import { bodyMembership, tieSides, type TieDefinition } from "../tie.js";
import {
  coupledNodeIds,
  couplingDofMask,
  referencePointIds,
  type CouplingDefinition,
} from "../coupling.js";
import { buildVertexIndexer } from "../solveMeshPacking.js";

type Vec3 = [number, number, number];

// What the Rust check reads (kofem-wasm `freeRigidMotions`): node indices
// throughout, links and elements in CSR form, supports as 6·node + dof.
export interface RigidBodyInput {
  positions: Float64Array;
  elementOffsets: Uint32Array;
  elementNodes: Uint32Array;
  elementLabels: Uint32Array;
  rotationalNodes: Uint32Array;
  primaryOffsets: Uint32Array;
  primaryNodes: Uint32Array;
  secondaryOffsets: Uint32Array;
  secondaryNodes: Uint32Array;
  masks: Uint8Array;
  fixedDofs: Uint32Array;
}

// The Rust module's answer (kofem-wasm `FreeMotions`).
interface FreeMotions {
  readonly count: number;
  readonly labelOffsets: Uint32Array;
  readonly labels: Uint32Array;
  readonly translationOffsets: Uint32Array;
  readonly translations: Float64Array;
  readonly rotationOffsets: Uint32Array;
  readonly rotationAxes: Float64Array;
  free(): void;
}

// The part of the Rust module the check calls; the worker passes the module's
// export, the tests the module they loaded.
export interface RigidBodyModule {
  freeRigidMotions(
    positions: Float64Array,
    elementOffsets: Uint32Array,
    elementNodes: Uint32Array,
    elementLabels: Uint32Array,
    rotationalNodes: Uint32Array,
    primaryOffsets: Uint32Array,
    primaryNodes: Uint32Array,
    secondaryOffsets: Uint32Array,
    secondaryNodes: Uint32Array,
    masks: Uint8Array,
    fixedDofs: Uint32Array,
  ): FreeMotions;
}

// A piece of the model the supports leave loose: the bodies (property ids) in
// it and the motion still free, as unit directions.
export interface LooseComponent {
  labels: number[];
  translations: Vec3[];
  rotationAxes: Vec3[];
}

// Element connectivity, links and supports, collected before packing.
class InputBuilder {
  private readonly elementOffsets = [0];
  private readonly elementNodes: number[] = [];
  private readonly elementLabels: number[] = [];
  private readonly primaryOffsets = [0];
  private readonly primaryNodes: number[] = [];
  private readonly secondaryOffsets = [0];
  private readonly secondaryNodes: number[] = [];
  private readonly masks: number[] = [];

  element(nodes: number[], label: number): void {
    this.elementNodes.push(...nodes);
    this.elementOffsets.push(this.elementNodes.length);
    this.elementLabels.push(label);
  }

  // `secondary` moves with every piece a `primary` node is in, on the DOFs of
  // `mask` (bit d for DOF d).
  link(primary: number[], secondary: number[], mask: number): void {
    this.primaryNodes.push(...primary);
    this.primaryOffsets.push(this.primaryNodes.length);
    this.secondaryNodes.push(...secondary);
    this.secondaryOffsets.push(this.secondaryNodes.length);
    this.masks.push(mask);
  }

  build(
    positions: Float64Array,
    rotationalNodes: Iterable<number>,
    fixedDofs: Iterable<number>,
  ): RigidBodyInput {
    return {
      positions,
      elementOffsets: Uint32Array.from(this.elementOffsets),
      elementNodes: Uint32Array.from(this.elementNodes),
      elementLabels: Uint32Array.from(this.elementLabels),
      rotationalNodes: Uint32Array.from(rotationalNodes),
      primaryOffsets: Uint32Array.from(this.primaryOffsets),
      primaryNodes: Uint32Array.from(this.primaryNodes),
      secondaryOffsets: Uint32Array.from(this.secondaryOffsets),
      secondaryNodes: Uint32Array.from(this.secondaryNodes),
      masks: Uint8Array.from(this.masks),
      fixedDofs: Uint32Array.from(fixedDofs),
    };
  }
}

// Translations x, y, z: what a tie joins.
const TRANSLATIONS = 0b111;

function positionsOf(nodes: Node[]): Float64Array {
  const positions = new Float64Array(3 * nodes.length);
  nodes.forEach((node, index) => {
    positions[3 * index] = node.x;
    positions[3 * index + 1] = node.y;
    positions[3 * index + 2] = node.z;
  });
  return positions;
}

function supportDof(constraint: Constraint, vertex: number): number {
  if (
    !Number.isInteger(constraint.dof) ||
    constraint.dof < 0 ||
    constraint.dof > 5
  )
    throw new Error(
      `Support on node ${constraint.nodeId} names DOF ${constraint.dof} — valid DOFs are 0..5`,
    );
  return 6 * vertex + constraint.dof;
}

// The rigid-body input of a store model: its elements, the supports, and a
// link per tie (each node of one side moves with the other side) and per
// coupling (the coupled nodes move with the reference point on its DOFs).
export function modelRigidBodyInput(
  model: Pick<SolveModel, "nodes" | "elements" | "constraints"> & {
    tieGroups?: TieDefinition[];
    couplings?: CouplingDefinition[];
  },
): RigidBodyInput {
  const { nodes, elements, constraints } = model;
  const vid = buildVertexIndexer(nodes);
  const input = new InputBuilder();
  const rotational = new Set<number>();
  for (const element of elements) {
    const vertices = element.nodeIds.map((id) =>
      vid(id, `Element ${element.id}`),
    );
    input.element(vertices, element.propertyId);
    // Shell facets carry rotations at their nodes; solids do not.
    if (element.type === "CTRIA3")
      for (const vertex of vertices) rotational.add(vertex);
  }
  if (model.tieGroups && model.tieGroups.length > 0) {
    const bodyOf = bodyMembership(elements);
    for (const tie of model.tieGroups) {
      const sides = tieSides(tie, bodyOf);
      input.link(
        sides.b.map((id) => vid(id, `Tie "${tie.name}"`)),
        sides.a.map((id) => vid(id, `Tie "${tie.name}"`)),
        TRANSLATIONS,
      );
    }
  }
  for (const coupling of model.couplings ?? []) {
    const context = `Coupling "${coupling.name}"`;
    const reference = vid(coupling.refNodeId, context);
    rotational.add(reference);
    input.link(
      [reference],
      coupledNodeIds(coupling).map((id) => vid(id, context)),
      couplingDofMask(coupling.kind, coupling.dofs),
    );
  }
  const fixed = constraints.map((constraint) =>
    supportDof(constraint, vid(constraint.nodeId, "Support")),
  );
  return input.build(positionsOf(nodes), rotational, fixed);
}

// The rigid-body input of the coupled solve's inputs: its pool of solid,
// shell and reference-point nodes, its tets and shell facets (labelled by the
// store element they came from), every coupling it will apply — the user's,
// the ties, and the shell-to-solid joins it derived — and its essential BCs.
export function coupledRigidBodyInput(
  model: Pick<SolveModel, "nodes" | "couplings">,
  inputs: Pick<
    CoupledEngineInputs,
    "mesh" | "coupling" | "bcs" | "model" | "solidElements" | "shellElements"
  >,
): RigidBodyInput {
  const { mesh, coupling, bcs, solidElements, shellElements } = inputs;
  const input = new InputBuilder();
  addPooledElements(input, mesh.tets, 4, solidElements, "solid tets");
  addPooledElements(input, mesh.triangles, 3, shellElements, "shell facets");
  for (let k = 0; k < coupling.ref.length; k++)
    input.link(
      [coupling.ref[k]],
      Array.from(
        coupling.solid.subarray(coupling.offsets[k], coupling.offsets[k + 1]),
      ),
      coupling.dof_mask[k],
    );
  const vid = buildVertexIndexer(model.nodes);
  const rotational = new Set(inputs.model.shellPoolIndex);
  for (const nodeId of referencePointIds(model.couplings ?? [])) {
    const pool = inputs.model.poolOfVertex.get(
      vid(nodeId, "Coupling reference point"),
    );
    if (pool === undefined)
      throw new Error(
        `Coupling reference point ${nodeId} is not part of the coupled model — the model is inconsistent`,
      );
    rotational.add(pool);
  }
  return input.build(mesh.vertices, rotational, [
    ...bcs.fixed_dofs,
    ...bcs.prescribed_dofs,
  ]);
}

function addPooledElements(
  input: InputBuilder,
  connectivity: Int32Array,
  size: number,
  elements: Element[],
  what: string,
): void {
  if (connectivity.length !== size * elements.length)
    throw new Error(
      `The coupled model has ${connectivity.length / size} ${what} for ${elements.length} store elements — the model is inconsistent`,
    );
  elements.forEach((element, index) =>
    input.element(
      Array.from(connectivity.subarray(size * index, size * (index + 1))),
      element.propertyId,
    ),
  );
}

// The loose pieces of a model, from the Rust check.
export function looseComponents(
  fem: RigidBodyModule,
  input: RigidBodyInput,
): LooseComponent[] {
  const motions = fem.freeRigidMotions(
    input.positions,
    input.elementOffsets,
    input.elementNodes,
    input.elementLabels,
    input.rotationalNodes,
    input.primaryOffsets,
    input.primaryNodes,
    input.secondaryOffsets,
    input.secondaryNodes,
    input.masks,
    input.fixedDofs,
  );
  try {
    const { labelOffsets, labels, translationOffsets, translations } = motions;
    const { rotationOffsets, rotationAxes } = motions;
    const directions = (flat: Float64Array, from: number, to: number): Vec3[] =>
      Array.from({ length: to - from }, (_, k): Vec3 => [
        flat[3 * (from + k)],
        flat[3 * (from + k) + 1],
        flat[3 * (from + k) + 2],
      ]);
    return Array.from({ length: motions.count }, (_, k) => ({
      labels: Array.from(labels.subarray(labelOffsets[k], labelOffsets[k + 1])),
      translations: directions(
        translations,
        translationOffsets[k],
        translationOffsets[k + 1],
      ),
      rotationAxes: directions(
        rotationAxes,
        rotationOffsets[k],
        rotationOffsets[k + 1],
      ),
    }));
  } finally {
    motions.free();
  }
}

// What the user calls the body a property belongs to: a region's body
// number, or for a shell the solve-time idealisation derived, the body whose
// walls it replaces.
function bodyNumber(properties: Property[], propertyId: number): number {
  const property = properties.find((p) => p.id === propertyId);
  if (!property)
    throw new Error(
      `Elements of body ${propertyId} have no property — the model is inconsistent`,
    );
  if (property.sourceBodyId !== undefined)
    return bodyNumber(properties, property.sourceBodyId);
  // A solid without a body number is a body of its own (lib/regions.ts bodyOf).
  return property.body ?? property.id;
}

const AXIS_NAMES = ["X", "Y", "Z"];

// "X" for a coordinate axis (the check reports those exactly), the rounded
// components otherwise.
function directionName(direction: Vec3): string {
  const axis = direction.findIndex((component) => component === 1);
  if (axis >= 0 && direction.every((c, k) => k === axis || c === 0))
    return AXIS_NAMES[axis];
  const rounded = direction.map(
    (component) => Number(component.toFixed(2)) + 0,
  );
  return `(${rounded.join(", ")})`;
}

// "X", "X and Y", "X, Y and Z".
function listed(items: string[]): string {
  return items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function motionPhrase(component: LooseComponent): string {
  const clauses: string[] = [];
  if (component.translations.length > 0)
    clauses.push(
      `move along ${listed(component.translations.map(directionName))}`,
    );
  if (component.rotationAxes.length > 0)
    clauses.push(
      `rotate about ${listed(component.rotationAxes.map(directionName))}`,
    );
  // A list in the first clause needs a comma before the second one.
  const separator = component.translations.length > 1 ? ", and " : " and ";
  return clauses.join(separator);
}

// The refusal for loose bodies, e.g. "Body 2 can still move along X and
// rotate about Z. Add a support or connect it to another body." Null when
// nothing is loose.
export function freeMotionMessage(
  components: LooseComponent[],
  properties: Property[],
): string | null {
  if (components.length === 0) return null;
  const named = new Set<number>();
  const sentences = new Set<string>();
  for (const component of components) {
    const numbers = [
      ...new Set(
        component.labels.map((label) => bodyNumber(properties, label)),
      ),
    ].sort((a, b) => a - b);
    for (const number of numbers) named.add(number);
    const who =
      numbers.length === 1
        ? `Body ${numbers[0]}`
        : `Bodies ${listed(numbers.map(String))}`;
    sentences.add(`${who} can still ${motionPhrase(component)}.`);
  }
  const advice =
    named.size === 1
      ? "Add a support or connect it to another body."
      : "Add supports or connect them to other bodies.";
  return `${[...sentences].join(" ")} ${advice}`;
}

// The check and its words in one call: the refusal, or null when every body
// is held.
export function unheldBodiesMessage(
  fem: RigidBodyModule,
  input: RigidBodyInput,
  properties: Property[],
): string | null {
  return freeMotionMessage(looseComponents(fem, input), properties);
}

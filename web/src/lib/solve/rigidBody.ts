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
//   modelRigidBodyInput   — the store model: elements, supports, ties,
//                           couplings and contacts as the user defined them. For the solid
//                           and shell paths.
//   coupledRigidBodyInput — the coupled solve's own inputs, where shells and
//                           solids are separate node sets joined by couplings
//                           the builder derives from proximity. Only these
//                           show whether a shell reaches the solid it stands on.
//                           autoCoupledRigidBodyInput reads the same from the
//                           auto-shell route's coupled solve, and
//                           pureShellRigidBodyInput its pure shell solve, where
//                           a support held in X, Y and Z also clamps rotation.
//
// routedRigidBodyInput picks the input the route a model takes calls for.

import type {
  Constraint,
  Element,
  Node,
  Property,
  SolveModel,
} from "../../workers/solverTypes.js";
import {
  buildCoupledEngineInputs,
  type CoupledEngineInputs,
  type EngineCoupledBcs,
  type EngineCoupling,
  type SolveLog,
} from "./coupled.js";
import {
  prepareAutoShellSolve,
  type AutoCoupledSolve,
  type PureShellSolve,
} from "./autoShell.js";
import type { SolveRoute } from "./route.js";
import { bodyMembership, tieSides, type TieDefinition } from "../tie.js";
import {
  coupledNodeIds,
  couplingDofMask,
  referencePointIds,
  type CouplingDefinition,
} from "../coupling.js";
import type { ContactDefinition } from "../contact.js";
import { buildVertexIndexer } from "../solveMeshPacking.js";
import { release } from "./rustFailure.js";
import { tr } from "../../i18n/useLocale.js";
import { refusalMessages } from "../../i18n/messages/refusals.js";

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
  contactSurfaceOffsets: Uint32Array;
  contactSurfaceNodes: Uint32Array;
  contactOtherOffsets: Uint32Array;
  contactOtherNodes: Uint32Array;
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
    contactSurfaceOffsets: Uint32Array,
    contactSurfaceNodes: Uint32Array,
    contactOtherOffsets: Uint32Array,
    contactOtherNodes: Uint32Array,
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
  private readonly contactSurfaceOffsets = [0];
  private readonly contactSurfaceNodes: number[] = [];
  private readonly contactOtherOffsets = [0];
  private readonly contactOtherNodes: number[] = [];

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

  // The nodes of the solid faces on `surface` press on the pieces an `other`
  // node is in: held along the surface normal, free across it.
  contact(surface: number[], other: number[]): void {
    this.contactSurfaceNodes.push(...surface);
    this.contactSurfaceOffsets.push(this.contactSurfaceNodes.length);
    this.contactOtherNodes.push(...other);
    this.contactOtherOffsets.push(this.contactOtherNodes.length);
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
      contactSurfaceOffsets: Uint32Array.from(this.contactSurfaceOffsets),
      contactSurfaceNodes: Uint32Array.from(this.contactSurfaceNodes),
      contactOtherOffsets: Uint32Array.from(this.contactOtherOffsets),
      contactOtherNodes: Uint32Array.from(this.contactOtherNodes),
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

// The rigid-body input of a store model: its elements, the supports, a link
// per tie (each node of one side moves with the other side) and per coupling
// (the coupled nodes move with the reference point on its DOFs), and per
// contact the surfaces holding each other along their normal.
export function modelRigidBodyInput(
  model: Pick<SolveModel, "nodes" | "elements" | "constraints"> & {
    tieGroups?: TieDefinition[];
    couplings?: CouplingDefinition[];
    contacts?: ContactDefinition[];
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
  for (const contact of model.contacts ?? []) {
    const side = (faces: ContactDefinition["facesA"]) => [
      ...new Set(
        faces.flatMap((face) =>
          face.nodeIds.map((id) => vid(id, `Contact "${contact.name}"`)),
        ),
      ),
    ];
    input.contact(side(contact.facesA), side(contact.facesB));
  }
  const fixed = constraints.map((constraint) =>
    supportDof(constraint, vid(constraint.nodeId, "Support")),
  );
  return input.build(positionsOf(nodes), rotational, fixed);
}

// A coupled solve's model: a pool of solid, shell and reference-point nodes,
// its tets and shell facets with the body each came from, every coupling it
// applies (the user's, the ties, the shell-to-solid joins it derived) and its
// essential BCs (6·pool + dof).
interface PooledModel {
  vertices: Float64Array;
  tets: Int32Array;
  triangles: Int32Array;
  tetBodies: number[];
  triangleBodies: number[];
  rotationalPool: Iterable<number>;
  coupling: Pick<EngineCoupling, "ref" | "offsets" | "solid" | "dof_mask">;
  bcs: Pick<EngineCoupledBcs, "fixed_dofs" | "prescribed_dofs">;
}

function pooledRigidBodyInput(model: PooledModel): RigidBodyInput {
  const { coupling, bcs } = model;
  const input = new InputBuilder();
  addPooledElements(input, model.tets, 4, model.tetBodies, "solid tets");
  addPooledElements(
    input,
    model.triangles,
    3,
    model.triangleBodies,
    "shell facets",
  );
  for (let k = 0; k < coupling.ref.length; k++)
    input.link(
      [coupling.ref[k]],
      Array.from(
        coupling.solid.subarray(coupling.offsets[k], coupling.offsets[k + 1]),
      ),
      coupling.dof_mask[k],
    );
  return input.build(model.vertices, model.rotationalPool, [
    ...bcs.fixed_dofs,
    ...bcs.prescribed_dofs,
  ]);
}

function addPooledElements(
  input: InputBuilder,
  connectivity: Int32Array,
  size: number,
  bodies: number[],
  what: string,
): void {
  if (connectivity.length !== size * bodies.length)
    throw new Error(
      `The coupled model has ${connectivity.length / size} ${what} but ${bodies.length} bodies for them — the model is inconsistent`,
    );
  bodies.forEach((body, index) =>
    input.element(
      Array.from(connectivity.subarray(size * index, size * (index + 1))),
      body,
    ),
  );
}

// The rigid-body input of the coupled solve's inputs. Its tets and facets are
// the store's solid and shell elements, in order.
export function coupledRigidBodyInput(
  model: Pick<SolveModel, "nodes" | "couplings">,
  inputs: Pick<
    CoupledEngineInputs,
    "mesh" | "coupling" | "bcs" | "model" | "solidElements" | "shellElements"
  >,
): RigidBodyInput {
  const vid = buildVertexIndexer(model.nodes);
  const rotationalPool = new Set(inputs.model.shellPoolIndex);
  for (const nodeId of referencePointIds(model.couplings ?? [])) {
    const pool = inputs.model.poolOfVertex.get(
      vid(nodeId, "Coupling reference point"),
    );
    if (pool === undefined)
      throw new Error(
        `Coupling reference point ${nodeId} is not part of the coupled model — the model is inconsistent`,
      );
    rotationalPool.add(pool);
  }
  return pooledRigidBodyInput({
    vertices: inputs.mesh.vertices,
    tets: inputs.mesh.tets,
    triangles: inputs.mesh.triangles,
    tetBodies: inputs.solidElements.map((element) => element.propertyId),
    triangleBodies: inputs.shellElements.map((element) => element.propertyId),
    rotationalPool,
    coupling: inputs.coupling,
    bcs: inputs.bcs,
  });
}

// The rigid-body input of the auto-shell route's coupled solve, where the
// Shell body's walls have become shells joined to the solid bodies.
export function autoCoupledRigidBodyInput(
  solve: AutoCoupledSolve,
): RigidBodyInput {
  return pooledRigidBodyInput({
    vertices: solve.mesh.vertices,
    tets: solve.mesh.tets,
    triangles: solve.mesh.triangles,
    tetBodies: solve.tetBodies,
    triangleBodies: solve.triangleBodies,
    rotationalPool: solve.rotationalPool,
    coupling: solve.coupling,
    bcs: solve.bcs,
  });
}

// The rigid-body input of the auto-shell route's pure shell solve: the
// mid-surface facets of the one Shell body, every node with rotations, and the
// supports as mapped onto it.
export function pureShellRigidBodyInput(solve: PureShellSolve): RigidBodyInput {
  const { mesh, dirichlet, shellBody } = solve;
  const input = new InputBuilder();
  for (let k = 0; k < mesh.triangles.length / 3; k++)
    input.element(
      Array.from(mesh.triangles.subarray(3 * k, 3 * k + 3)),
      shellBody,
    );
  const fixed = [
    ...dirichlet.fixed_vertices.flatMap((vertex) =>
      [0, 1, 2, 3, 4, 5].map((dof) => 6 * vertex + dof),
    ),
    ...dirichlet.fixed_dofs.flatMap(({ vertex, dofs }) =>
      dofs.map((dof) => 6 * vertex + dof),
    ),
    ...dirichlet.prescribed_dofs.map(({ vertex, dof }) => 6 * vertex + dof),
  ];
  const vertexCount = mesh.vertices.length / 3;
  return input.build(
    mesh.vertices,
    Array.from({ length: vertexCount }, (_, vertex) => vertex),
    fixed,
  );
}

// The rigid-body input of the model a route solves: the coupled solve's own
// inputs where the route builds them (only there are shells joined to
// solids), the model as the user defined it otherwise.
export function routedRigidBodyInput(
  model: SolveModel,
  route: SolveRoute,
  log: SolveLog,
): RigidBodyInput {
  switch (route.path) {
    case "coupled":
      return coupledRigidBodyInput(model, buildCoupledEngineInputs(model, log));
    case "auto-shell": {
      const prepared = prepareAutoShellSolve(model, route.shellBodyIds, log);
      return prepared.kind === "coupled"
        ? autoCoupledRigidBodyInput(prepared.solve)
        : pureShellRigidBodyInput(prepared.solve);
    }
    case "shell":
    case "solid":
      return modelRigidBodyInput(model);
    default: {
      const unhandled: never = route;
      throw new Error(
        `rigid-body check: unhandled route ${JSON.stringify(unhandled)}`,
      );
    }
  }
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
    input.contactSurfaceOffsets,
    input.contactSurfaceNodes,
    input.contactOtherOffsets,
    input.contactOtherNodes,
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
    release(motions);
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
    : tr(refusalMessages).listTwo(
        items.slice(0, -1).join(", "),
        items[items.length - 1],
      );
}

function motionPhrase(component: LooseComponent): string {
  const text = tr(refusalMessages);
  const move =
    component.translations.length > 0
      ? text.moveAlong(listed(component.translations.map(directionName)))
      : null;
  const rotate =
    component.rotationAxes.length > 0
      ? text.rotateAbout(listed(component.rotationAxes.map(directionName)))
      : null;
  if (move === null || rotate === null) return move ?? rotate ?? "";
  // English puts a comma before the second clause after a list in the first.
  return component.translations.length > 1
    ? text.motionAndAfterList(move, rotate)
    : text.motionAnd(move, rotate);
}

// The refusal for loose bodies, e.g. "Body 2 can still move along X and
// rotate about Z. Add a support or connect it to another body." Null when
// nothing is loose.
export function freeMotionMessage(
  components: LooseComponent[],
  properties: Property[],
): string | null {
  if (components.length === 0) return null;
  // Pieces that can make the same motion share a sentence: the plate and the
  // block it is joined to, or two loose parts alike.
  const bodiesByMotion = new Map<string, Set<number>>();
  for (const component of components) {
    const phrase = motionPhrase(component);
    let numbers = bodiesByMotion.get(phrase);
    if (!numbers) bodiesByMotion.set(phrase, (numbers = new Set()));
    for (const label of component.labels)
      numbers.add(bodyNumber(properties, label));
  }
  const text = tr(refusalMessages);
  const named = new Set<number>();
  const sentences = [...bodiesByMotion].map(([phrase, numberSet]) => {
    const numbers = [...numberSet].sort((a, b) => a - b);
    for (const number of numbers) named.add(number);
    return numbers.length === 1
      ? text.bodyCanStill(numbers[0], phrase)
      : text.bodiesCanStill(listed(numbers.map(String)), phrase);
  });
  const advice = named.size === 1 ? text.holdOneBody : text.holdBodies;
  return `${sentences.join(" ")} ${advice}`;
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

// cos 5°: a direction this close to a coordinate axis is named as the axis.
const NEAR_AXIS = 0.996;

// A body only contact holds, refused by the contact solve because its load
// drives it in a motion nothing holds (KOF-501): a node of it, and the motion
// as a unit direction, or a unit axis where it turns.
export interface UnheldByContact {
  nodeId: number;
  direction: Vec3;
  turns: boolean;
}

// The refusal for `unheld`, e.g. "Body 2 is held only by contact, which
// cannot stop it: its load would make it move along Y. Add a support or
// connect it to another body."
export function contactUnheldMessage(
  unheld: UnheldByContact,
  elements: readonly Pick<Element, "nodeIds" | "propertyId">[],
  properties: Property[],
): string {
  const element = elements.find((candidate) =>
    candidate.nodeIds.includes(unheld.nodeId),
  );
  if (!element)
    throw new Error(
      `Node ${unheld.nodeId} of the body the contact cannot hold is in no element — the model is inconsistent`,
    );
  // The phrase names a line, not a sense ("move along X"), so the direction
  // is turned to point its largest component the positive way, as the
  // pre-check reports its directions. The springs' share of a held motion
  // tilts it a little, so within NEAR_AXIS of an axis it is that axis.
  const largest = unheld.direction.reduce((best, component) =>
    Math.abs(component) > Math.abs(best) ? component : best,
  );
  const axis = unheld.direction.indexOf(largest);
  // + 0 turns a negated zero into a plain one.
  const positive = (component: number) =>
    (largest < 0 ? -component : component) + 0;
  const [x, y, z] = unheld.direction;
  const line: Vec3 =
    Math.abs(largest) >= NEAR_AXIS
      ? [axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0]
      : [positive(x), positive(y), positive(z)];
  const phrase = motionPhrase({
    labels: [element.propertyId],
    translations: unheld.turns ? [] : [line],
    rotationAxes: unheld.turns ? [line] : [],
  });
  const text = tr(refusalMessages);
  return `${text.contactCannotHold(bodyNumber(properties, element.propertyId), phrase)} ${text.holdOneBody}`;
}

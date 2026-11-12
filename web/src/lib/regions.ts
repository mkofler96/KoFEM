// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Bodies and their regions (KOF-257).
//
// Every CAD solid of the geometry is a region: it carries its own material,
// element type, mesh size and optimization role, and its id (Property.id) is
// the id the mesh, the interfaces and suppression use. Regions are grouped into
// bodies. An import makes every solid a body of its own; splitting a body
// makes more regions of the same body, which stay connected at the cut — the
// cut face is shared, so the mesh is conforming across it — and are not
// listed as interfaces. A region can be promoted to a body of its own.

import type { Element, Property } from "../store/geometrySlice";
import { isCadBody } from "../store/geometrySlice";
import { orderedDesignElements } from "./designElements";

export type OptimizationRole = "design" | "solid" | "void";

export const OPTIMIZATION_ROLE_LABELS: Record<OptimizationRole, string> = {
  design: "Design",
  solid: "Keep solid",
  void: "Keep empty",
};

// The body a CAD solid is a region of.
export function bodyOf(prop: Property): number {
  // A solid without a body number is a body of its own: every import starts
  // that way, and files saved before regions carry none.
  return prop.body ?? prop.id;
}

// A region's optimization role; absent means the optimizer may shape it.
export function roleOf(prop: Property): OptimizationRole {
  // eslint-disable-next-line kofem/no-silent-fallback -- "design" is the role every region starts with, not a guess: the whole model is the design domain unless the user fixes a region
  return prop.optimizationRole ?? "design";
}

export interface BodyGroup {
  body: number;
  // The body's regions in solid-id order; their position is the region number.
  regions: Property[];
}

// The bodies of the model, in body-number order.
export function bodyGroups(properties: Property[]): BodyGroup[] {
  const byBody = new Map<number, Property[]>();
  for (const p of properties.filter(isCadBody)) {
    const body = bodyOf(p);
    const list = byBody.get(body);
    if (list) list.push(p);
    else byBody.set(body, [p]);
  }
  return [...byBody.entries()]
    .sort(([a], [b]) => a - b)
    .map(([body, regions]) => ({
      body,
      regions: regions.sort((a, b) => a.id - b.id),
    }));
}

function groupOf(properties: Property[], solidId: number): BodyGroup {
  const group = bodyGroups(properties).find((g) =>
    g.regions.some((r) => r.id === solidId),
  );
  if (!group)
    throw new Error(`Region ${solidId} is not a CAD solid of the model`);
  return group;
}

// The body that holds `solidId` and its regions.
export function bodyGroupOf(
  properties: Property[],
  solidId: number,
): BodyGroup {
  return groupOf(properties, solidId);
}

// What the user calls a solid: "Body 2" when it is the body's only region,
// "Body 1 · Region 2" when the body has several.
export function solidName(properties: Property[], solidId: number): string {
  const group = groupOf(properties, solidId);
  if (group.regions.length === 1) return `Body ${group.body}`;
  const k = group.regions.findIndex((r) => r.id === solidId) + 1;
  return `Body ${group.body} · Region ${k}`;
}

// The label of a region under its body in the model tree.
export function regionLabel(properties: Property[], solidId: number): string {
  const group = groupOf(properties, solidId);
  return `Region ${group.regions.findIndex((r) => r.id === solidId) + 1}`;
}

export function sameBody(
  properties: Property[],
  solidA: number,
  solidB: number,
): boolean {
  return (
    bodyOf(groupOf(properties, solidA).regions[0]) ===
    bodyOf(groupOf(properties, solidB).regions[0])
  );
}

// A body number no body uses yet.
export function nextBodyNumber(properties: Property[]): number {
  return Math.max(0, ...properties.filter(isCadBody).map((p) => bodyOf(p))) + 1;
}

// The region max element sizes as numbers, keyed by solid id: only the regions
// that set one. Throws, naming the region, on a size that is not a positive
// number — meshing must not guess what was meant.
export function regionMaxSizes(properties: Property[]): Map<number, number> {
  const sizes = new Map<number, number>();
  for (const p of properties.filter(isCadBody)) {
    const raw = p.maxElementSize?.trim();
    if (raw === undefined || raw === "") continue;
    const size = parseFloat(raw);
    if (!Number.isFinite(size) || size <= 0)
      throw new Error(
        `The max element size of ${solidName(properties, p.id)} must be a positive number of mm — got "${raw}".`,
      );
    sizes.set(p.id, size);
  }
  return sizes;
}

// The elements topology optimization must keep solid or empty, as indices in
// the optimizer's design-element order (orderedDesignElements), from the
// regions' roles. A shell section the mesh derived takes the role of the region
// it came from. Undefined when every region is a design region.
export function passiveElements(
  elements: Element[],
  properties: Property[],
): { solid: number[]; void: number[] } | undefined {
  const byId = new Map(properties.map((p) => [p.id, p]));
  const regionRole = (propertyId: number): OptimizationRole => {
    const prop = byId.get(propertyId);
    if (!prop)
      throw new Error(
        `Element property ${propertyId} is not in the model's property table`,
      );
    if (prop.sourceBodyId === undefined) return roleOf(prop);
    const region = byId.get(prop.sourceBodyId);
    if (!region)
      throw new Error(
        `Shell section ${propertyId} comes from region ${prop.sourceBodyId}, which does not exist`,
      );
    return roleOf(region);
  };
  const solid: number[] = [];
  const empty: number[] = [];
  orderedDesignElements(elements).forEach((e, i) => {
    const role = regionRole(e.propertyId);
    if (role === "solid") solid.push(i);
    else if (role === "void") empty.push(i);
  });
  if (solid.length === 0 && empty.length === 0) return undefined;
  return { solid, void: empty };
}

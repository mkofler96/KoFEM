// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Body-to-body interfaces of a multibody assembly (KOF-170, issue #354).
//
// On import the engine imprints touching solids (BOPAlgo_MakeConnected, issue
// #353): where two bodies touch, the face exists once and both solids own it,
// so the mesh is conforming across it and the bodies are bonded. The engine
// reports which solid owns each tessellation triangle (`bodyIds`) and which CAD
// face it lies on (`faceIds`), emitting a shared face once per owning solid.
// A CAD face that appears under two bodies is therefore an interface between
// them — detection reads only that face → body ownership, never the triangle
// geometry.
//
// An interface groups every face shared by one pair of bodies. Its `type` is a
// per-interface choice; "bonded" is the only one for now — the conforming mesh
// already models it, so the solver needs nothing extra. Further types
// (frictional, adhesive) extend INTERFACE_TYPES without a redesign.

import type { Property, StepTessellation } from "../store/geometrySlice";
import { isCadBody } from "../store/geometrySlice";

export const INTERFACE_TYPES = ["bonded"] as const;
export type InterfaceType = (typeof INTERFACE_TYPES)[number];

export const INTERFACE_TYPE_LABELS: Record<InterfaceType, string> = {
  bonded: "Bonded",
};

export interface BodyInterface {
  // 1-based, in (bodyA, bodyB) order — stable for a given geometry.
  id: number;
  // The two CAD bodies (1-based solid indices), bodyA < bodyB.
  bodyA: number;
  bodyB: number;
  // The shared CAD face ids (the tessellation's / mesh's 1-based face ids),
  // ascending.
  faceIds: number[];
  type: InterfaceType;
}

// The interfaces of a tessellated geometry, or null when the tessellation
// cannot tell: an analysis saved before CAD face ids carries body ids but no
// face ids, so which faces are shared is unknown — not "none". A tessellation
// without body ids (saved before per-body ids) is a single body: no interfaces.
export function detectInterfaces(
  tessellation: StepTessellation | null,
): BodyInterface[] | null {
  if (!tessellation) return [];
  const { triangles, bodyIds, faceIds } = tessellation;
  if (!bodyIds) return [];
  if (!faceIds) return null;
  if (
    bodyIds.length !== triangles.length ||
    faceIds.length !== triangles.length
  )
    throw new Error(
      `Cannot detect interfaces: ${triangles.length} triangles but ` +
        `${bodyIds.length} body ids and ${faceIds.length} face ids`,
    );

  // CAD face → the bodies that own it.
  const owners = new Map<number, Set<number>>();
  for (let t = 0; t < triangles.length; t++) {
    let set = owners.get(faceIds[t]);
    if (!set) {
      set = new Set();
      owners.set(faceIds[t], set);
    }
    set.add(bodyIds[t]);
  }

  // Body pair → the faces they share.
  const byPair = new Map<string, { a: number; b: number; faces: number[] }>();
  for (const [faceId, bodies] of owners) {
    if (bodies.size < 2) continue;
    // A face bounds at most two solids; more owners means the tessellation's
    // ids are inconsistent, and guessing a pair would invent an interface.
    if (bodies.size > 2)
      throw new Error(
        `Cannot detect interfaces: CAD face ${faceId} is owned by ` +
          `${bodies.size} bodies (${[...bodies].join(", ")}) — a face bounds at most two`,
      );
    const [a, b] = [...bodies].sort((x, y) => x - y);
    const key = `${a}:${b}`;
    let entry = byPair.get(key);
    if (!entry) {
      entry = { a, b, faces: [] };
      byPair.set(key, entry);
    }
    entry.faces.push(faceId);
  }

  return [...byPair.values()]
    .sort((p, q) => p.a - q.a || p.b - q.b)
    .map((p, i) => ({
      id: i + 1,
      bodyA: p.a,
      bodyB: p.b,
      faceIds: p.faces.sort((x, y) => x - y),
      type: "bonded" as const,
    }));
}

export function interfaceLabel(i: { bodyA: number; bodyB: number }): string {
  return `Body ${i.bodyA} ↔ Body ${i.bodyB}`;
}

function suppressedIds(properties: Property[]): Set<number> {
  return new Set(
    properties.filter((p) => isCadBody(p) && p.suppressed).map((p) => p.id),
  );
}

// An interface takes part in the analysis only while both its bodies do.
export function isInterfaceActive(
  i: BodyInterface,
  properties: Property[],
): boolean {
  const off = suppressedIds(properties);
  return !off.has(i.bodyA) && !off.has(i.bodyB);
}

// The bodies of an assembly that share no active interface with any other
// body: nothing bonds them to the rest, so they float unless a support or tie
// holds them. Empty for a single-body model (nothing to bond to), and when the
// interfaces are unknown (null) — a flag there would be a guess.
export function unconnectedBodies(
  interfaces: BodyInterface[] | null,
  properties: Property[],
): number[] {
  if (interfaces === null) return [];
  const active = properties.filter((p) => isCadBody(p) && !p.suppressed);
  if (active.length < 2) return [];
  const connected = new Set<number>();
  for (const i of interfaces)
    if (isInterfaceActive(i, properties)) {
      connected.add(i.bodyA);
      connected.add(i.bodyB);
    }
  return active
    .map((p) => p.id)
    .filter((id) => !connected.has(id))
    .sort((a, b) => a - b);
}

// Restore the interfaces of a saved analysis: the list is re-detected from the
// saved tessellation and must match what was saved — the user's per-interface
// type is the only thing the file adds. A mismatch means the file was edited
// or its geometry changed underneath it, so it is refused rather than guessed.
// `saved` is undefined for files written before interfaces existed: they were
// all bonded, which is what detection yields.
export function restoreInterfaces(
  tessellation: StepTessellation | null,
  saved: unknown,
): BodyInterface[] | null {
  const detected = detectInterfaces(tessellation);
  if (saved === undefined) return detected;
  if (!Array.isArray(saved))
    throw new Error(
      `Invalid analysis file: "interfaces" must be an array, got ${typeof saved}`,
    );
  if (detected === null)
    throw new Error(
      "Invalid analysis file: it lists interfaces, but its geometry carries no CAD face ids to locate them",
    );
  if (saved.length !== detected.length)
    throw new Error(
      `Invalid analysis file: it lists ${saved.length} interface(s), but its geometry has ${detected.length}`,
    );
  return detected.map((d, k) => {
    const raw: unknown = saved[k];
    if (typeof raw !== "object" || raw === null)
      throw new Error(
        `Invalid analysis file: interface ${k + 1} is not an object`,
      );
    const entry = raw as Record<string, unknown>;
    const faces = entry.faceIds;
    const sameFaces =
      Array.isArray(faces) &&
      faces.length === d.faceIds.length &&
      faces.every((f, j) => f === d.faceIds[j]);
    if (entry.bodyA !== d.bodyA || entry.bodyB !== d.bodyB || !sameFaces)
      throw new Error(
        `Invalid analysis file: interface ${k + 1} does not match the geometry ` +
          `(expected ${interfaceLabel(d)} on faces ${d.faceIds.join(", ")})`,
      );
    if (!INTERFACE_TYPES.includes(entry.type as InterfaceType))
      throw new Error(
        `Invalid analysis file: interface ${k + 1} has unknown type "${String(entry.type)}"`,
      );
    return { ...d, type: entry.type as InterfaceType };
  });
}

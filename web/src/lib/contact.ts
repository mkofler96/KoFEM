// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Frictionless contact between two picked surfaces (KOF-485): the surfaces
// are not connected, carry load where they touch under the load, and
// separate where they pull apart. Small sliding on linear-elastic solids,
// solved in Rust by dual mortar contact with a primal–dual active set
// (crates/kofem-fem/src/contact.rs). The solve makes the finer surface the
// slave side.

// The result fields of a contact solve: the pressure on the slave nodes, and
// whether each touches (1) or is apart (0). Zero on every other node, where
// nothing presses.
export const CONTACT_FIELDS = ["Contact pressure", "Contact status"] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];

export function isContactField(field: string): field is ContactField {
  return (CONTACT_FIELDS as readonly string[]).includes(field);
}

// One contact connection: its name and the faces of its two surfaces, as
// node ids.
export interface ContactDefinition {
  name: string;
  facesA: { nodeIds: number[] }[];
  facesB: { nodeIds: number[] }[];
}

// What a contact solve found on the slave side of every contact: one entry
// per slave node.
export interface ContactResult {
  nodeIds: number[];
  // Contact pressure (force per area, ≥ 0 pressing).
  pressure: Float64Array;
  // Gap along the surface normal (≥ 0 apart).
  gap: Float64Array;
  // 1 where the surfaces touch, 0 where they are apart.
  closed: Uint8Array;
  // The area each node's pressure acts on.
  area: Float64Array;
  // Total normal force across every contact.
  force: number;
  // Active-set iterations until the touching nodes stopped changing.
  iterations: number;
}

// What one contact carried in a solve: its slave nodes (those on either of
// its surfaces), how many of them touch, and the normal force over them.
export function contactSummaryOf(
  contact: ContactDefinition,
  result: ContactResult,
): { touching: number; total: number; force: number } {
  const onContact = new Set<number>();
  for (const face of [...contact.facesA, ...contact.facesB])
    for (const id of face.nodeIds) onContact.add(id);
  let touching = 0;
  let total = 0;
  let force = 0;
  result.nodeIds.forEach((id, index) => {
    if (!onContact.has(id)) return;
    total++;
    touching += result.closed[index];
    force += result.pressure[index] * result.area[index];
  });
  return { touching, total, force };
}

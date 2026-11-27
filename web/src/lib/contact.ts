// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Frictionless contact between two picked surfaces (KOF-485): the surfaces
// are not connected, carry load where they touch under the load, and
// separate where they pull apart. Small sliding on linear-elastic solids,
// solved in Rust by dual mortar contact with a primal–dual active set
// (crates/kofem-fem/src/contact.rs). The solve makes the finer surface the
// slave side.

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
  // Total normal force across every contact.
  force: number;
  // Active-set iterations until the touching nodes stopped changing.
  iterations: number;
}

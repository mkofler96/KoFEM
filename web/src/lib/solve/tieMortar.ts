// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The weights of a constraint tie for the solve (KOF-318): dual mortar
// weights from the Rust module on linear elements (crates/kofem-fem/src/
// mortar.rs), the node-to-surface projection on quadratic ones, whose master
// field the Rust solver evaluates itself (crates/kofem-fem/src/tie.rs). Which
// nodes a connection ties is found in lib/tieConstraints.ts.

import type {
  MortarSurface,
  tieMortarWeights,
} from "../../wasm/fem/kofem_wasm.js";
import type {
  MortarFace,
  MortarRow,
  MortarWeights,
  TieWeighting,
} from "../tieConstraints.js";

// The parts of the Rust module the mortar weights need, passed in so the
// worker and the node-side tests can each load the module their own way.
export interface TieMortarModule {
  MortarSurface: typeof MortarSurface;
  tieMortarWeights: typeof tieMortarWeights;
}

// One side's faces over a local numbering of their nodes: the Rust module
// takes indices into a point array, the app names nodes by id.
function packFaces(
  faces: MortarFace[],
  localOf: Map<number, number>,
  points: number[],
): { sizes: Uint32Array; nodes: Uint32Array; centroids: Float64Array } {
  const nodes: number[] = [];
  const centroids: number[] = [];
  for (const face of faces) {
    face.ids.forEach((id, corner) => {
      let local = localOf.get(id);
      if (local === undefined) {
        local = localOf.size;
        localOf.set(id, local);
        points.push(...face.points[corner]);
      }
      nodes.push(local);
    });
    centroids.push(...face.elementCentroid);
  }
  return {
    sizes: Uint32Array.from(faces, (face) => face.ids.length),
    nodes: Uint32Array.from(nodes),
    centroids: Float64Array.from(centroids),
  };
}

// The Rust module's dual mortar weights, in the form tieConstraints takes.
export function rustMortarWeights(fem: TieMortarModule): MortarWeights {
  return (slaveFaces, masterFaces, limit) => {
    const localOf = new Map<number, number>();
    const points: number[] = [];
    const slave = packFaces(slaveFaces, localOf, points);
    const master = packFaces(masterFaces, localOf, points);
    const idOf = Array.from(localOf.keys());
    const allPoints = Float64Array.from(points);
    const slaveSurface = new fem.MortarSurface(
      allPoints,
      slave.sizes,
      slave.nodes,
      slave.centroids,
    );
    const masterSurface = new fem.MortarSurface(
      allPoints,
      master.sizes,
      master.nodes,
      master.centroids,
    );
    try {
      const ties = fem.tieMortarWeights(slaveSurface, masterSurface, limit);
      try {
        const { slaves, offsets, masters, weights, coverage } = ties;
        const rows = new Map<number, MortarRow>();
        slaves.forEach((slaveLocal, row) => {
          const range = Array.from(
            { length: offsets[row + 1] - offsets[row] },
            (_, k) => offsets[row] + k,
          );
          rows.set(idOf[slaveLocal], {
            masterIds: range.map((index) => idOf[masters[index]]),
            weights: range.map((index) => weights[index]),
            coverage: coverage[row],
          });
        });
        return rows;
      } finally {
        ties.free();
      }
    } finally {
      slaveSurface.free();
      masterSurface.free();
    }
  };
}

// How a solve at element order `order` weighs its tied nodes (see the header).
export function tieWeighting(
  order: number,
  fem: TieMortarModule,
): TieWeighting {
  if (order === 1) return { kind: "mortar", weights: rustMortarWeights(fem) };
  if (order === 2) return { kind: "projection" };
  throw new Error(
    `tie: constraint ties support element order 1 and 2, not ${order}`,
  );
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Drive a contact solve in the Rust module (crates/kofem-wasm ContactRun) to
// convergence: one active-set iteration per correction solve, logged as it
// finishes, handing control back to the worker's event loop now and then.
// The contact pairs reach the module as the vertices of their two surfaces;
// it finds the faces and picks the slave side.

import type {
  ContactPairs,
  ContactSolution,
  ElasticModel,
  SolveOptions,
  Ties,
} from "../../wasm/fem/kofem_wasm.js";
import type { ContactDefinition, ContactResult } from "../contact.js";
import type { VertexIndexer } from "../solveMeshPacking.js";
import type { Node } from "../../workers/solverTypes.js";
import { release } from "./rustFailure.js";

export interface ContactFemModule {
  ContactPairs: typeof ContactPairs;
}

// The active set settles in a handful of iterations; one still changing
// after this many is reported rather than iterated on.
const ACTIVE_SET_LIMIT = 50;

// CG iterations between checks of the clock.
const CG_STEP = 50;

// How long the solve may run without handing control back to the worker's
// event loop.
const YIELD_AFTER_MS = 200;

// The contact pairs as the Rust module takes them: each side's vertices.
export function contactPairs(
  fem: ContactFemModule,
  contacts: readonly ContactDefinition[],
  refVid: VertexIndexer,
): ContactPairs {
  const pairs = new fem.ContactPairs();
  for (const contact of contacts) {
    const side = (faces: ContactDefinition["facesA"], name: string) => {
      const vertices = new Set<number>();
      for (const face of faces)
        for (const id of face.nodeIds)
          vertices.add(refVid(id, `contact "${contact.name}" side ${name}`));
      return Uint32Array.from(vertices);
    };
    pairs.add(side(contact.facesA, "A"), side(contact.facesB, "B"));
  }
  return pairs;
}

// Solve `elastic` (assembled) with contact over `pairs` and the ties `ties`
// (an empty table for none); `options` sets each correction's tolerance,
// preconditioner and CG budget. The caller frees the solution.
export async function runContactSolve(
  elastic: ElasticModel,
  pairs: ContactPairs,
  ties: Ties,
  fixedDofs: Uint32Array,
  fixedValues: Float64Array,
  forces: Float64Array,
  options: SolveOptions,
  log: (line: string) => void,
): Promise<ContactSolution> {
  const run = elastic.startContactSolve(
    pairs,
    ties,
    fixedDofs,
    fixedValues,
    forces,
    options,
    ACTIVE_SET_LIMIT,
  );
  let finished = false;
  try {
    let lastYield = performance.now();
    for (;;) {
      const converged = run.advance(CG_STEP);
      if (converged) {
        finished = true;
        return run.finish();
      }
      if (run.cgIterations === 0)
        log(
          `Contact iteration ${run.iteration}: ${run.closedNodes} of ${run.slaveNodes} slave nodes touching, residual ${run.relativeResidual.toExponential(2)}`,
        );
      if (performance.now() - lastYield >= YIELD_AFTER_MS) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        lastYield = performance.now();
      }
    }
  } finally {
    // finish() consumes the run; free it only when it was not reached.
    if (!finished) release(run);
  }
}

// A converged contact solution's contact data, with the slave vertices as
// node ids of `nodes` (indexed as the solve's vertices).
export function readContact(
  solution: ContactSolution,
  nodes: readonly Node[],
): ContactResult {
  return {
    nodeIds: Array.from(solution.nodes, (vertex) => nodes[vertex].id),
    pressure: solution.pressure,
    gap: solution.gap,
    closed: solution.closed,
    area: solution.area,
    force: solution.force,
    iterations: solution.iterations,
  };
}

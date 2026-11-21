// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Whether a topology optimization reached its optimum (KOF-412). A run that
// stops at its iteration limit returns its last design, which is not a
// finished one: Results and the Optimize panel say so, and offer to run again
// with a higher limit.

export interface TopOptConvergence {
  converged: boolean;
  // The iterations the run took; at the limit when it did not converge.
  iterations: number;
}

// The notice for a run that stopped at its limit, or null for a converged run.
export function notConvergedNotice(run: TopOptConvergence): string | null {
  if (run.converged) return null;
  return `Not converged: the optimization stopped at its limit of ${run.iterations} iterations, so the design may still change.`;
}

// The limit a rerun of a capped run gets: twice the one it stopped at.
export function raisedIterationLimit(iterations: number): number {
  if (!Number.isInteger(iterations) || iterations <= 0)
    throw new Error(
      `raisedIterationLimit: expected a whole number of iterations > 0, got ${iterations}`,
    );
  return 2 * iterations;
}

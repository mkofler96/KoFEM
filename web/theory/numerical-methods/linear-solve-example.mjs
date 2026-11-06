// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Educational two-DOF bar, not a replacement for an engine regression test.
// Units: stiffness N/mm, load N, displacement mm. One forward/backward GS
// pair applies inverse(M) = [[3/4, 1/2], [1/2, 1]] for K = [[2,-1],[-1,1]].
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const dot = (left, right) =>
  left.reduce((sum, value, i) => sum + value * right[i], 0);
const multiply = ([first, second]) => [2 * first - second, -first + second];
const precondition = ([first, second]) => [
  0.75 * first + 0.5 * second,
  0.5 * first + second,
];
const add = (left, scale, right) =>
  left.map((value, i) => value + scale * right[i]);

export function barSolve({ relative = 1e-6, absolute = 0, limit = 2 } = {}) {
  const load = [1, 1];
  let displacement = [0, 0];
  let residual = [...load];
  let direction = precondition(residual);
  let squaredNorm = dot(residual, direction);
  const initialSquaredNorm = squaredNorm;
  const threshold = Math.max(initialSquaredNorm * relative ** 2, absolute ** 2);
  const steps = [];
  for (let iteration = 0; iteration <= limit; iteration++) {
    const actualResidual = add(load, -1, multiply(displacement));
    steps.push({
      iteration,
      displacement: [...displacement],
      residual: actualResidual,
      squaredNorm,
      relativeResidual: Math.sqrt(squaredNorm / initialSquaredNorm),
    });
    if (squaredNorm <= threshold) return { converged: true, steps };
    if (iteration === limit) return { converged: false, steps };
    const product = multiply(direction);
    const alpha = squaredNorm / dot(direction, product);
    displacement = add(displacement, alpha, direction);
    residual = add(residual, -alpha, product);
    const transformed = precondition(residual);
    const nextSquaredNorm = dot(residual, transformed);
    direction = add(transformed, nextSquaredNorm / squaredNorm, direction);
    squaredNorm = nextSquaredNorm;
  }
  throw new Error("The iteration budget did not produce an outcome");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = barSolve();
  const close = (actual, expected) =>
    assert.ok(
      Math.abs(actual - expected) < 1e-12,
      `Expected ${expected}, got ${actual}`,
    );
  // Hand-derived rational iterates and analytical bar displacements.
  close(result.steps[0].squaredNorm, 11 / 4);
  close(result.steps[1].displacement[0], 55 / 26);
  close(result.steps[1].displacement[1], 33 / 13);
  close(result.steps[1].squaredNorm, 99 / 338);
  close(result.steps[1].relativeResidual, Math.sqrt(18 / 169));
  assert.equal(result.converged, true);
  close(result.steps[2].displacement[0], 2);
  close(result.steps[2].displacement[1], 3);
  result.steps[2].residual.forEach((value) => close(value, 0));
  assert.equal(barSolve({ limit: 1 }).converged, false);
  assert.equal(barSolve({ relative: 0.5 }).steps.length, 2);
  assert.equal(barSolve({ relative: 0.1, absolute: 0.6 }).steps.length, 2);
  console.table(
    result.steps.map((step) => ({
      iteration: step.iteration,
      displacement: step.displacement.join(", "),
      relativeResidual: step.relativeResidual,
    })),
  );
  console.log(
    "PASS: exact bar values, preconditioned residual, relative/absolute stopping and budget failure.",
  );
}

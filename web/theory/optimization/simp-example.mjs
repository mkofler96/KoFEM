// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Educational SIMP calculation: two parallel bars share one load. Units are
// N and mm. This checks the article's arithmetic and the self-adjoint
// sensitivity by finite differences; it is not the production optimizer.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export const inputs = {
  young: 200000, // MPa
  area: 5, // mm²
  length: 1000, // mm
  load: 100, // N
  penalty: 3,
  eminRel: 1e-9,
};
// Full-material bar stiffness k0 = EA/L in N/mm.
export const barStiffness = (inputs.young * inputs.area) / inputs.length;

// The production interpolation (engine/cpp/topology_simp_core.cpp).
export const scale = (rho, p = inputs.penalty) =>
  inputs.eminRel + rho ** p * (1 - inputs.eminRel);
export const scaleDerivative = (rho, p = inputs.penalty) =>
  p * rho ** (p - 1) * (1 - inputs.eminRel);

// Both bars connect the same two nodes, so they share one extension u.
export function evaluate(densities, p = inputs.penalty) {
  const stiffness = densities.reduce(
    (sum, rho) => sum + scale(rho, p) * barStiffness,
    0,
  );
  const extension = inputs.load / stiffness; // mm
  const compliance = inputs.load * extension; // N·mm
  // q_e = u_eᵀ k0_e u_e: the full-material strain energy of each bar (×2).
  const energy = densities.map(() => barStiffness * extension ** 2);
  const sensitivity = densities.map(
    (rho, e) => -scaleDerivative(rho, p) * energy[e],
  );
  return { stiffness, extension, compliance, energy, sensitivity };
}

export const gray = evaluate([0.5, 0.5]);
export const solidVoid = evaluate([1, 0]);
export const linearGray = evaluate([0.5, 0.5], 1);

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const close = (actual, expected, tolerance = 1e-6) =>
    assert.ok(
      Math.abs(actual - expected) <=
        tolerance * Math.max(1, Math.abs(expected)),
      `${actual} != ${expected}`,
    );
  close(barStiffness, 1000);
  close(gray.stiffness, 250);
  close(gray.extension, 0.4);
  close(gray.compliance, 40);
  close(gray.energy[0], 160);
  close(gray.sensitivity[0], -120);
  close(solidVoid.compliance, 10);
  close(solidVoid.sensitivity[0], -30);
  close(solidVoid.sensitivity[1], 0);
  close(linearGray.compliance, 10);
  // Central finite difference of the full model matches −s′(ρ)·q.
  const h = 1e-6;
  for (const densities of [
    [0.5, 0.5],
    [0.8, 0.3],
  ]) {
    const analytic = evaluate(densities).sensitivity;
    for (const e of [0, 1]) {
      const plus = [...densities];
      const minus = [...densities];
      plus[e] += h;
      minus[e] -= h;
      const fd =
        (evaluate(plus).compliance - evaluate(minus).compliance) / (2 * h);
      close(fd, analytic[e], 1e-6);
    }
  }
  console.log("SIMP two-bar compliance and sensitivity example checks pass.");
}

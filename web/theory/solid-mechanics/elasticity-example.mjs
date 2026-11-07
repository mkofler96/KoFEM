// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Checks the arithmetic of the solid-mechanics worked examples: lengths in mm,
// forces in N, E and stress in MPa. This checks the articles' calculations, not
// the production FEM solver; the axial-bar study covers that.
import assert from "node:assert/strict";

const close = (actual, expected, label) =>
  assert.ok(
    Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)),
    `${label}: ${actual} != ${expected}`,
  );

// Isotropic constants (Linear elasticity, material-constants table).
const E = 210000;
const nu = 0.3;
const mu = E / (2 * (1 + nu));
const lambda = (E * nu) / ((1 + nu) * (1 - 2 * nu));
close(mu, 1050000 / 13, "mu");
close(lambda, 1575000 / 13, "lambda");
close(E / (3 * (1 - 2 * nu)), 175000, "bulk modulus");
close(lambda / mu, 1.5, "lambda/mu at nu = 0.3");
close((2 * 0.49) / (1 - 2 * 0.49), 49, "lambda/mu at nu = 0.49");

// Uniaxial bar: P / A, inverse law, then the forward law must return it.
const P = 1e6;
const A = 100 * 100;
const L = 1000;
const sxx = P / A;
close(sxx, 100, "axial stress");
const exx = sxx / E;
const eyy = (-nu * sxx) / E;
close(exx, 1 / 2100, "axial strain");
close(eyy, -1 / 7000, "lateral strain");
const trace = exx + 2 * eyy;
close(trace, 1 / 5250, "strain trace");
close(lambda * trace, 300 / 13, "volumetric stress part");
close(2 * mu * exx, 1000 / 13, "deviatoric axial part");
close(lambda * trace + 2 * mu * exx, 100, "forward axial stress");
close(lambda * trace + 2 * mu * eyy, 0, "forward lateral stress");
const extension = exx * L;
close(extension, (P * L) / (E * A), "extension PL/(EA)");
close(100 * eyy, -1 / 70, "lateral contraction of a 100 mm side");
close(mu * 1e-3, 1050 / 13, "shear stress for gamma = 1e-3");

// Strain energy equals the work of the slowly applied load.
const W = 0.5 * sxx * exx;
close(W, 1 / 42, "strain energy density");
close(W * L * A, 0.5 * P * extension, "stored energy = P delta / 2");
close(W * L * A, 1e7 / 42, "stored energy");

// Small-rotation error of the linearised strain.
close(Math.cos(0.01) - 1, -5e-5, "rotation 0.01 rad");
assert.ok(Math.abs(Math.cos(0.1) - 1 + 4.9958e-3) < 1e-7, "rotation 0.1 rad");

// Two-material bar (Equilibrium and weak form).
const steel = sxx / 210000;
const aluminium = sxx / 70000;
close(steel, 1 / 2100, "steel strain");
close(aluminium, 1 / 700, "aluminium strain");
close(500 * steel + 500 * aluminium, 20 / 21, "two-material tip displacement");
console.log("Solid-mechanics worked examples check out.");

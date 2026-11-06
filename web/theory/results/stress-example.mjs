// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Educational recovery calculation: x and u in mm, E and stress in MPa.
// This checks the article's arithmetic, not the production FEM solver.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export const gradient = [
  [0.000525, 0.000375, 0],
  [0, 0.00015, 0],
  [0, 0, -0.000225],
];
export function recover(grad, young = 200000, poisson = 0.25) {
  const shear = young / (2 * (1 + poisson));
  const lame = (young * poisson) / ((1 + poisson) * (1 - 2 * poisson));
  const strain = grad.map((row, i) =>
    row.map((value, j) => (value + grad[j][i]) / 2),
  );
  const trace = strain.reduce((sum, row, i) => sum + row[i], 0);
  const stress = strain.map((row, i) =>
    row.map((value, j) => 2 * shear * value + (i === j ? lame * trace : 0)),
  );
  const mean = stress.reduce((sum, row, i) => sum + row[i], 0) / 3;
  const contraction = stress.reduce(
    (sum, row, i) =>
      sum +
      row.reduce(
        (total, value, j) => total + (value - (i === j ? mean : 0)) ** 2,
        0,
      ),
    0,
  );
  return { strain, stress, vonMises: Math.sqrt(1.5 * contraction) };
}
export const worked = recover(gradient);

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const close = (actual, expected) =>
    assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
  const expected = [
    [120, 30, 0],
    [30, 60, 0],
    [0, 0, 0],
  ];
  worked.stress.forEach((row, i) =>
    row.forEach((value, j) => close(value, expected[i][j])),
  );
  close(worked.strain[0][1], 0.0001875); // tensor shear = engineering shear / 2
  close(worked.vonMises, Math.sqrt(13500));
  // Adding hydrostatic stress changes the tensor but not von Mises.
  const shifted = gradient.map((row, i) =>
    row.map((value, j) => value + (i === j ? 0.001 : 0)),
  );
  close(recover(shifted).vonMises, worked.vonMises);
  close(
    recover([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]).vonMises,
    0,
  );
  close(
    recover([
      [0, 0.000375, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]).vonMises,
    30 * Math.sqrt(3),
  );
  // Equal-magnitude uniaxial tension and compression have the same scalar.
  const uniaxial = [
    [0.0005, 0, 0],
    [0, -0.000125, 0],
    [0, 0, -0.000125],
  ];
  close(recover(uniaxial).vonMises, 100);
  close(
    recover(uniaxial.map((row) => row.map((value) => -value))).vonMises,
    100,
  );
  console.log(
    `PASS: stress tensor, tensor shear, von Mises ${worked.vonMises.toFixed(2)} MPa, hydrostatic invariance, pure shear and stress sign.`,
  );
}

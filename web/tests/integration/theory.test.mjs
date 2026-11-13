// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The Theory Guide. Its pages are generated, its worked examples are computed
// and its evidence is recorded from the engine; each of those is a program
// with a check mode (docs/theory/README.md). These tests run the check modes,
// so an article cannot drift from the code it describes.

import { expect, test } from "bun:test";
import { runProgram } from "../support/program.mjs";

const CHECKS = [
  ["the generated pages are current", "theory/generate.mjs", ["--check"]],
  [
    "the solid-mechanics worked examples add up",
    "theory/solid-mechanics/elasticity-example.mjs",
    [],
  ],
  [
    "the two-DOF linear-solve example adds up",
    "theory/numerical-methods/linear-solve-example.mjs",
    [],
  ],
  [
    "the stress-recovery example adds up",
    "theory/results/stress-example.mjs",
    [],
  ],
  [
    "the SIMP example adds up, sensitivities included",
    "theory/optimization/simp-example.mjs",
    [],
  ],
  [
    "the axial-bar study still matches its recorded evidence",
    "../examples/validation/axial-bar-study.mjs",
    [],
  ],
  [
    "the topology-optimization benchmarks still match their recorded evidence",
    "theory/optimization/capture-evidence.mjs",
    [],
  ],
];

test.each(CHECKS)("%s", async (_name, file, args) => {
  const { exitCode, output } = await runProgram(file, args);
  expect(exitCode, output).toBe(0);
});

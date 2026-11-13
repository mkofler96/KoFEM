// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The public examples (/examples/). Each one is built and solved from its
// recipe and compared with its closed-form or published value by
// examples/validation/run.mjs, which also checks that the generated pages are
// current; rules.mjs holds what every example must meet (KOF-322). They are
// command-line programs (`bun run validate`), so these tests run them as such.

import { expect, test } from "bun:test";
import { runProgram } from "../support/program.mjs";

const CHECKS = [
  [
    "every example reproduces its reference value and its page is current",
    "../examples/validation/run.mjs",
    [],
  ],
  [
    "every example meets the rules for examples",
    "../examples/validation/rules.mjs",
    [],
  ],
  [
    "the crane holder solves as shells coupled to the solid pin and hook",
    "../examples/shell-coupling/crane-holder-shell.mjs",
    [],
  ],
];

test.each(CHECKS)("%s", async (_name, file, args) => {
  const { exitCode, output } = await runProgram(file, args);
  expect(exitCode, output).toBe(0);
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for scripts/run-validation.mjs (KOF-336): which steps the
// validation runner finds, how the explicit list merges with the discovered
// tests/test_*.mjs files, and how the command line selects among them.
//
// Run:  bun test ./tests/unit

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  EXPLICIT_STEPS,
  THEORY_STEPS,
  discoverTestFiles,
  parseCli,
  parseJobs,
  planSteps,
  selectSteps,
} from "../../scripts/run-validation.mjs";

const WEB = resolve(import.meta.dir, "../..");

const scratchDirs = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/**
 * A throwaway checkout: returns its web/ directory, holding the given files
 * (empty) at paths relative to web/, so "../examples/…" lands beside it.
 */
function fakeWeb(files) {
  const root = mkdtempSync(join(tmpdir(), "kofem-runner-"));
  scratchDirs.push(root);
  const web = join(root, "web");
  mkdirSync(web);
  for (const file of files) {
    const path = join(web, file);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, "");
  }
  return web;
}

const commands = (steps) => steps.map((step) => step.argv.join(" "));

describe("discoverTestFiles", () => {
  test("finds tests/test_*.mjs only, sorted", () => {
    const web = fakeWeb([
      "tests/test_b.mjs",
      "tests/test_a.mjs",
      "tests/bench_solid_solvers.mjs",
      "tests/helper.mjs",
      "tests/solve.spec.ts",
      "tests/test_notes.md",
      "tests/fixtures/test_fixture.mjs",
    ]);
    expect(discoverTestFiles(web)).toEqual([
      "tests/test_a.mjs",
      "tests/test_b.mjs",
    ]);
  });
});

describe("planSteps", () => {
  test("a discovered file that is also listed runs once, with its arguments", () => {
    const web = fakeWeb(["tests/test_a.mjs", "tests/test_b.mjs"]);
    const steps = planSteps({
      webDir: web,
      theory: [],
      explicit: [["tests/test_b.mjs", "20.0"]],
    });
    expect(commands(steps)).toEqual([
      "bun tests/test_b.mjs 20.0",
      "bun tests/test_a.mjs",
    ]);
  });

  test("keeps listed steps outside tests/ and tags theory steps", () => {
    const web = fakeWeb([
      "tests/test_a.mjs",
      "theory/generate.mjs",
      "../examples/case.mjs",
    ]);
    const steps = planSteps({
      webDir: web,
      theory: [["theory/generate.mjs", "--check"]],
      explicit: [["../examples/case.mjs"]],
    });
    expect(steps.map((step) => [step.group, step.argv.join(" ")])).toEqual([
      ["theory", "bun theory/generate.mjs --check"],
      ["validation", "bun ../examples/case.mjs"],
      ["validation", "bun tests/test_a.mjs"],
    ]);
  });

  test("a listed file that does not exist is an error, not a skipped step", () => {
    const web = fakeWeb(["tests/test_a.mjs"]);
    expect(() =>
      planSteps({ webDir: web, theory: [], explicit: [["tests/gone.mjs"]] }),
    ).toThrow(/tests\/gone\.mjs.*does not exist/);
  });

  test("a file listed twice is an error", () => {
    const web = fakeWeb(["tests/test_a.mjs"]);
    expect(() =>
      planSteps({
        webDir: web,
        theory: [["tests/test_a.mjs"]],
        explicit: [["tests/test_a.mjs", "--wasm"]],
      }),
    ).toThrow(/tests\/test_a\.mjs.*listed more than once/);
  });

  test("runs bun test on tests/unit only when it holds test files", () => {
    const empty = fakeWeb(["tests/test_a.mjs", "tests/unit/README.md"]);
    expect(
      commands(planSteps({ webDir: empty, theory: [], explicit: [] })),
    ).toEqual(["bun tests/test_a.mjs"]);

    const seeded = fakeWeb(["tests/test_a.mjs", "tests/unit/x.test.mjs"]);
    const steps = planSteps({ webDir: seeded, theory: [], explicit: [] });
    expect(commands(steps)).toEqual([
      "bun tests/test_a.mjs",
      // ./ makes bun treat it as a path, so the Playwright specs one level
      // up in tests/ are never collected.
      "bun test ./tests/unit",
    ]);
    expect(steps[1].group).toBe("unit");
  });
});

describe("the real step list", () => {
  const steps = planSteps({ webDir: WEB });
  const forFile = (file) => steps.filter((step) => step.argv[1] === file);

  test("argument steps run exactly once, with their arguments", () => {
    expect(commands(forFile("tests/test_wall_bracket.mjs"))).toEqual([
      "bun tests/test_wall_bracket.mjs 20.0",
    ]);
    expect(commands(forFile("tests/test_shell_footprint.mjs"))).toEqual([
      "bun tests/test_shell_footprint.mjs --wasm",
    ]);
  });

  test("never runs the solver benchmark", () => {
    expect(forFile("tests/bench_solid_solvers.mjs")).toEqual([]);
  });

  test("every step name is unique", () => {
    const names = steps.map((step) => step.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("the lists hold no test_*.mjs file without arguments", () => {
    // Those are discovered; listing them again is the merge conflict the
    // runner exists to avoid.
    const redundant = [...THEORY_STEPS, ...EXPLICIT_STEPS].filter(
      ([file, ...args]) =>
        /^tests\/test_[^/]+\.mjs$/.test(file) && !args.length,
    );
    expect(redundant).toEqual([]);
  });
});

describe("selectSteps", () => {
  const web = fakeWeb([
    "tests/test_amg_solid.mjs",
    "tests/test_amg_coupling.mjs",
    "tests/test_tie.mjs",
    "theory/generate.mjs",
  ]);
  const steps = planSteps({
    webDir: web,
    theory: [["theory/generate.mjs", "--check"]],
    explicit: [],
  });

  test("no filter selects everything", () => {
    expect(selectSteps(steps, { group: null, filters: [] })).toEqual(steps);
  });

  test("filters match step names as substrings, any of them", () => {
    expect(
      commands(selectSteps(steps, { group: null, filters: ["amg", "tie"] })),
    ).toEqual([
      "bun tests/test_amg_coupling.mjs",
      "bun tests/test_amg_solid.mjs",
      "bun tests/test_tie.mjs",
    ]);
  });

  test("a group selects its steps", () => {
    expect(
      commands(selectSteps(steps, { group: "theory", filters: [] })),
    ).toEqual(["bun theory/generate.mjs --check"]);
  });

  test("a filter that matches nothing is an error", () => {
    expect(() =>
      selectSteps(steps, { group: null, filters: ["nonesuch"] }),
    ).toThrow(/nonesuch/);
  });

  test("an unknown group is an error", () => {
    expect(() => selectSteps(steps, { group: "bogus", filters: [] })).toThrow(
      /bogus/,
    );
  });
});

describe("parseJobs", () => {
  test("defaults to the CPU count, capped at 3", () => {
    expect(parseJobs(undefined, 16)).toBe(3);
    expect(parseJobs(undefined, 2)).toBe(2);
    expect(parseJobs("", 16)).toBe(3);
  });

  test("takes a positive integer", () => {
    expect(parseJobs("1", 16)).toBe(1);
    expect(parseJobs("8", 2)).toBe(8);
  });

  test("rejects anything else", () => {
    for (const bad of ["0", "-2", "2.5", "two", "3x"])
      expect(() => parseJobs(bad, 4)).toThrow(/VALIDATION_JOBS/);
  });
});

describe("parseCli", () => {
  test("reads --list, --group and name filters", () => {
    expect(parseCli(["--list", "--group", "theory", "amg"])).toEqual({
      list: true,
      group: "theory",
      filters: ["amg"],
    });
    expect(parseCli([])).toEqual({ list: false, group: null, filters: [] });
  });

  test("rejects unknown flags and a --group without a value", () => {
    expect(() => parseCli(["--lsit"])).toThrow(/--lsit/);
    expect(() => parseCli(["--group"])).toThrow(/--group/);
  });
});

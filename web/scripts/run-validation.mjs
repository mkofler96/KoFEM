// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Validation runner (KOF-336): runs the node-side checks behind
// `bun run test:validation` and `bun run test:theory`.
//
//   bun scripts/run-validation.mjs [--list] [--group <name>] [filter …]
//
//   --list           print the steps that would run, one per line, and exit
//   --group <name>   only the steps of one group: theory, validation or unit
//   filter …         only the steps whose name contains one of the filters
//   VALIDATION_JOBS  steps run at once (default: CPU count, at most 3;
//                    VALIDATION_JOBS=1 runs them one after another)
//
// Every tests/test_*.mjs file runs without being listed anywhere. Only the
// steps that take arguments or live outside tests/ are listed below, one per
// line. Every step runs even when an earlier one fails; each step's output
// is printed in one block when it finishes, and the summary at the end
// repeats the output of every failed step. The exit code is non-zero when
// any step failed.

import { existsSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { posix, resolve } from "node:path";
import { spawn } from "bun";

/** Theory-page checks; also `bun run test:theory` (`--group theory`). */
export const THEORY_STEPS = [
  ["theory/generate.mjs", "--check"],
  ["theory/solid-mechanics/elasticity-example.mjs"],
  ["theory/numerical-methods/linear-solve-example.mjs"],
  ["theory/results/stress-example.mjs"],
  ["theory/optimization/simp-example.mjs"],
  ["../examples/validation/axial-bar-study.mjs"],
  ["theory/optimization/capture-evidence.mjs"],
];

/**
 * Validation steps that are not a plain tests/test_*.mjs file: scripts
 * outside tests/, and tests/ files that take arguments. A tests/ file listed
 * here runs once, with these arguments, instead of being discovered.
 */
export const EXPLICIT_STEPS = [
  ["../examples/validation/run.mjs"],
  ["../examples/validation/rules.mjs"],
  ["../examples/validation/dof-constraint.test.mjs"],
  ["../examples/validation/prescribed-displacement.test.mjs"],
  ["../examples/validation/shell-prescribed-displacement.test.mjs"],
  ["../examples/validation/multiple-loads.test.mjs"],
  ["../examples/gallery/step-prism.test.mjs"],
  ["../examples/shell-coupling/crane-holder-shell.mjs"],
  ["tests/test_wall_bracket.mjs", "20.0"],
  ["tests/test_shell_footprint.mjs", "--wasm"],
];

export const GROUPS = ["theory", "validation", "unit"];

/** Bun test files for the unit step; bun's own default naming. */
const UNIT_DIR = "tests/unit";
const UNIT_TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/;
const DISCOVERED_TEST_FILE = /^test_.+\.mjs$/;
const DEFAULT_MAX_JOBS = 3;

/** The tests/test_*.mjs files under `webDir`, as sorted web-relative paths. */
export function discoverTestFiles(webDir) {
  return readdirSync(resolve(webDir, "tests"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && DISCOVERED_TEST_FILE.test(entry.name))
    .map((entry) => `tests/${entry.name}`)
    .sort();
}

function hasUnitTests(webDir) {
  const dir = resolve(webDir, UNIT_DIR);
  if (!existsSync(dir)) return false;
  return readdirSync(dir, { recursive: true, withFileTypes: true }).some(
    (entry) => entry.isFile() && UNIT_TEST_FILE.test(entry.name),
  );
}

function scriptStep(group, [file, ...args]) {
  const argv = ["bun", file, ...args];
  return { name: argv.slice(1).join(" "), group, file, argv };
}

/**
 * Every step, in run order: the theory list, the explicit list, the
 * discovered tests/test_*.mjs files not already listed, then the unit tests.
 * A listed file that is missing, or listed twice, is an error.
 */
export function planSteps({
  webDir,
  theory = THEORY_STEPS,
  explicit = EXPLICIT_STEPS,
}) {
  const listed = [
    ...theory.map((entry) => scriptStep("theory", entry)),
    ...explicit.map((entry) => scriptStep("validation", entry)),
  ];
  const seen = new Set();
  for (const step of listed) {
    const file = posix.normalize(step.file);
    if (seen.has(file))
      throw new Error(
        `run-validation: ${step.file} is listed more than once; give each file one entry`,
      );
    seen.add(file);
    if (!existsSync(resolve(webDir, file)))
      throw new Error(
        `run-validation: listed step ${step.file} does not exist (relative to ${webDir}); update the list in scripts/run-validation.mjs`,
      );
  }
  const discovered = discoverTestFiles(webDir)
    .filter((file) => !seen.has(file))
    .map((file) => scriptStep("validation", [file]));
  const steps = [...listed, ...discovered];
  if (hasUnitTests(webDir)) {
    // The ./ prefix makes bun read the argument as a path rather than a name
    // filter, so the Playwright *.spec.ts files in tests/ are never collected.
    const argv = ["bun", "test", `./${UNIT_DIR}`];
    steps.push({ name: argv.join(" "), group: "unit", file: UNIT_DIR, argv });
  }
  return steps;
}

/**
 * The steps of `group` (all when null) whose name contains any of `filters`
 * (all when empty). A group or filter that selects nothing is an error.
 */
export function selectSteps(steps, { group, filters }) {
  if (group !== null && !GROUPS.includes(group))
    throw new Error(
      `run-validation: unknown group "${group}"; expected one of ${GROUPS.join(", ")}`,
    );
  const inGroup =
    group === null ? steps : steps.filter((step) => step.group === group);
  if (group !== null && !inGroup.length)
    throw new Error(
      `run-validation: group "${group}" selects no steps; see --list`,
    );
  if (!filters.length) return inGroup;
  for (const filter of filters)
    if (!inGroup.some((step) => step.name.includes(filter)))
      throw new Error(
        `run-validation: no step name contains "${filter}"; see --list`,
      );
  return inGroup.filter((step) =>
    filters.some((filter) => step.name.includes(filter)),
  );
}

/** Pool size from VALIDATION_JOBS; unset or empty means min(CPUs, 3). */
export function parseJobs(value, cpuCount) {
  if (value === undefined || value === "")
    return Math.max(1, Math.min(cpuCount, DEFAULT_MAX_JOBS));
  if (!/^[1-9]\d*$/.test(value))
    throw new Error(
      `run-validation: VALIDATION_JOBS must be a positive integer, got "${value}"`,
    );
  return Number(value);
}

export function parseCli(args) {
  const options = { list: false, group: null, filters: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--list") options.list = true;
    else if (arg === "--group") {
      const value = args[++i];
      if (value === undefined || value.startsWith("--"))
        throw new Error("run-validation: --group needs a group name");
      options.group = value;
    } else if (arg.startsWith("-"))
      throw new Error(
        `run-validation: unknown option ${arg}; expected --list, --group <name> or name filters`,
      );
    else options.filters.push(arg);
  }
  return options;
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
// Peak memory is null when the step never started.
const megabytes = (bytes) =>
  bytes === null ? "–" : `${Math.round(bytes / 2 ** 20)} MB`;

/** Spawn a step's command, or return why it could not start. */
function startProcess(step, webDir) {
  try {
    return {
      proc: spawn(step.argv, {
        cwd: webDir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

async function runStep(step, webDir) {
  const start = performance.now();
  // stdout and stderr go into one buffer in arrival order, printed when the
  // step finishes so parallel steps never interleave.
  const chunks = [];
  const collect = async (stream) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream)
      chunks.push(decoder.decode(chunk, { stream: true }));
    chunks.push(decoder.decode());
  };
  const started = startProcess(step, webDir);
  if ("error" in started)
    return {
      step,
      ok: false,
      durationMs: performance.now() - start,
      exit: `could not start: ${started.error.message}`,
      maxRss: null,
      output: "",
    };
  const { proc } = started;
  await Promise.all([collect(proc.stdout), collect(proc.stderr)]);
  const code = await proc.exited;
  const usage = proc.resourceUsage();
  if (!usage)
    throw new Error(`run-validation: no resource usage for ${step.name}`);
  return {
    step,
    ok: code === 0,
    durationMs: performance.now() - start,
    exit: proc.signalCode ? `signal ${proc.signalCode}` : `exit ${code}`,
    maxRss: usage.maxRSS,
    output: chunks.join(""),
  };
}

function printBlock(result, done, total) {
  const status = result.ok ? "PASS" : "FAIL";
  console.log(
    `── ${status} ${result.step.name} (${seconds(result.durationMs)}, ${result.exit}) [${done}/${total}]`,
  );
  const output = result.output.trimEnd();
  if (output) console.log(output);
}

/** Run `steps` with at most `jobs` at once; results in step order. */
export async function runSteps(steps, { jobs, webDir }) {
  const results = new Array(steps.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < steps.length) {
      const index = next++;
      const result = await runStep(steps[index], webDir);
      results[index] = result;
      printBlock(result, ++done, steps.length);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(jobs, steps.length) }, worker),
  );
  return results;
}

function printSummary(results, wallMs, jobs) {
  const failed = results.filter((result) => !result.ok);
  for (const result of failed) {
    console.log(`\n══ Output of failed step: ${result.step.name}`);
    console.log(result.output.trimEnd() || "(no output)");
  }
  const width = Math.max(...results.map((result) => result.step.name.length));
  console.log("\n══ Validation summary");
  for (const result of results)
    console.log(
      `  ${result.ok ? "PASS" : "FAIL"}  ${seconds(result.durationMs).padStart(8)}  ${megabytes(result.maxRss).padStart(7)}  ${result.ok ? result.step.name : `${result.step.name.padEnd(width)}  (${result.exit})`}`,
    );
  console.log(
    `\n${results.length - failed.length}/${results.length} steps passed${failed.length ? `, ${failed.length} FAILED` : ""} in ${seconds(wallMs)} wall time (up to ${jobs} at once; columns: duration, peak memory)`,
  );
  if (failed.length) {
    console.log("Failed:");
    for (const result of failed) console.log(`  ${result.step.name}`);
  }
}

async function main() {
  const webDir = resolve(import.meta.dir, "..");
  const options = parseCli(process.argv.slice(2));
  const steps = selectSteps(planSteps({ webDir }), options);
  if (options.list) {
    for (const step of steps) console.log(step.argv.join(" "));
    return 0;
  }
  if (!hasUnitTests(webDir) && [null, "unit"].includes(options.group))
    console.log(`Note: no bun test files in ${UNIT_DIR}/; no unit step.`);
  const jobs = parseJobs(process.env.VALIDATION_JOBS, availableParallelism());
  console.log(
    `Running ${steps.length} validation step(s), up to ${jobs} at once (VALIDATION_JOBS).\n`,
  );
  const start = performance.now();
  const results = await runSteps(steps, { jobs, webDir });
  printSummary(results, performance.now() - start, jobs);
  return results.every((result) => result.ok) ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}

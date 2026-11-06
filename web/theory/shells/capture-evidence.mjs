// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Run the existing production-core checks; never transcribe measured values
// into the articles. This native check is separate from the WASM web suite.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = new URL("../../public/theory/shells.json", import.meta.url);
const compiler = process.env.CXX || "g++";
const run = (command, args) =>
  execFileSync(command, args, {
    cwd: root,
    env: { ...process.env, CXX: compiler },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
const commands = [
  ["scripts/test-shell.sh"],
  ["scripts/study-shell-solid-footprint.sh", "2"],
];
const [shellLog, footprintLog] = commands.map((args) => run("bash", args));
assert.match(shellLog, /all checks passed/);
assert.match(footprintLog, /PASS: rigid motion/);
const plate = [
  ...shellLog.matchAll(
    /\[PASS\]\s+(clamped-plate|simply-supported-plate|ss-plate-von-mises)\s+got=(\S+) ref=(\S+) err=(\S+)% \(tol (\S+)%\)/g,
  ),
].map((match) => ({
  name: match[1],
  measured: Number(match[2]),
  reference: Number(match[3]),
  tolerancePercent: Number(match[5]),
}));
assert.equal(plate.length, 3);
const lines = footprintLog
  .split("\n")
  .filter((line) => line.startsWith("CSV,"));
const columns = lines.shift().split(",").slice(1);
const transition = lines.map((line) =>
  Object.fromEntries(
    line
      .split(",")
      .slice(1)
      .map((value, index) => [
        columns[index],
        index === 0 ? value : Number(value),
      ]),
  ),
);
assert.equal(transition.length, 16);
for (const row of transition)
  for (const [key, value] of Object.entries(row))
    if (key !== "load") assert.ok(Number.isFinite(value), key);
const measured = { plate, transition };
if (process.argv.includes("--report")) {
  // The linked revision must contain the native implementations that ran.
  run("git", [
    "diff",
    "--exit-code",
    "HEAD",
    "--",
    "engine/cpp",
    "engine/tests",
    ...commands.map(([path]) => path),
  ]);
  const record = {
    sourceRevision: run("git", ["rev-parse", "HEAD"]).trim(),
    recordedAt: new Date().toISOString(),
    execution:
      "Native production C++ shell/coupling core; no WASM wrapper or CAD extraction in these measurements",
    compiler: run(compiler, ["--version"]).split("\n")[0],
    commands: commands.map((args) => `CXX=${compiler} bash ${args.join(" ")}`),
    precision:
      "Values retain the precision printed by the existing native checks (7 significant figures for plates, 9 for transition values, 6 decimal places for ratios)",
    ...measured,
  };
  writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`);
  console.log("Recorded native shell and planar-transition evidence.");
} else {
  const record = JSON.parse(readFileSync(output, "utf8"));
  // Compare the measured quantities, allowing compiler/printed-rounding drift;
  // each existing native suite also enforces its own physical tolerance bands.
  for (const [index, row] of plate.entries()) {
    assert.equal(row.name, record.plate[index].name);
    assert.ok(Math.abs(row.measured / record.plate[index].measured - 1) < 1e-5);
  }
  for (const [index, row] of transition.entries()) {
    const prior = record.transition[index];
    for (const key of ["load", "refinement", "collar_mm"])
      assert.equal(row[key], prior[key]);
    for (const key of [
      "peak_vm",
      "work_tip_u",
      "near_vm",
      "gauge_vm",
      "block_vm_l2_error",
    ])
      assert.ok(
        Math.abs(row[key] - prior[key]) <=
          1e-5 * Math.max(Math.abs(prior[key]), 1e-8),
        `${index}: ${key}`,
      );
  }
  console.log(
    "Native plate and two-refinement planar-transition evidence matches the record.",
  );
}

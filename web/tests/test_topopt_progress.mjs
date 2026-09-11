// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/topOptProgress.ts — parsing the engine's streamed
// "[topopt] it N: c=… vol=… change=…" log lines into convergence points so the
// plot can animate live during a run (KOF-233), before the final history array
// crosses the WASM boundary.
//
// Run:  bun tests/test_topopt_progress.mjs

import {
  parseTopOptLogLine,
  convergenceFromLogs,
} from "../src/lib/topOptProgress.ts";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── parseTopOptLogLine ───────────────────────────────────────────────────────
{
  const point = parseTopOptLogLine(
    "[topopt] it 7: c=1.234e+03 vol=0.4998 change=0.012",
  );
  check(
    "parses iteration, compliance (objective) and volume fraction",
    point !== null &&
      point.it === 7 &&
      Math.abs(point.objective - 1234) < 1e-6 &&
      Math.abs(point.volume - 0.4998) < 1e-9,
    JSON.stringify(point),
  );

  check(
    "returns null for a non-progress line",
    parseTopOptLogLine("Starting topology optimization: 274 nodes") === null,
  );
  check("returns null for an empty string", parseTopOptLogLine("") === null);
}

// ── convergenceFromLogs ──────────────────────────────────────────────────────
{
  const logs = [
    { text: "Starting topology optimization: 40 elements" },
    { text: "[topopt] it 1: c=5.0e+02 vol=0.90 change=0.4" },
    { text: "[topopt] it 2: c=3.0e+02 vol=0.70 change=0.2" },
    { text: "[topopt] it 3: c=2.5e+02 vol=0.50 change=0.05" },
    { text: "Topology optimization complete: 40 element densities" },
  ];
  const curve = convergenceFromLogs(logs);
  check(
    "reduces a streamed log to one point per iteration, in order",
    curve.length === 3 &&
      curve[0].it === 1 &&
      curve[2].it === 3 &&
      curve[2].volume === 0.5,
    `got ${curve.map((p) => p.it).join(",")}`,
  );

  // A repeated iteration line keeps the latest value (robust to re-emits).
  const withRepeat = convergenceFromLogs([
    { text: "[topopt] it 1: c=5.0e+02 vol=0.90 change=0.4" },
    { text: "[topopt] it 1: c=4.0e+02 vol=0.80 change=0.3" },
  ]);
  check(
    "a repeated iteration index keeps the last value",
    withRepeat.length === 1 && Math.abs(withRepeat[0].objective - 400) < 1e-6,
    JSON.stringify(withRepeat),
  );

  check("empty log → empty curve", convergenceFromLogs([]).length === 0);
}

console.log(
  failures === 0
    ? "\nAll topopt-progress tests passed."
    : `\n${failures} topopt-progress test(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);

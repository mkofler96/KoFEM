// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/topOptProgress.ts — parsing the engine's streamed
// "[topopt] it N: c=… vol=… change=…" log lines into convergence points so the
// plot can animate live during a run (KOF-233), before the final history array
// crosses the WASM boundary.

import { describe, expect, test } from "bun:test";
import {
  parseTopOptLogLine,
  convergenceFromLogs,
} from "../../src/lib/topOptProgress.ts";

describe("parseTopOptLogLine", () => {
  const point = parseTopOptLogLine(
    "[topopt] it 7: c=1.234e+03 vol=0.4998 change=0.012",
  );

  test("parses iteration, compliance and volume fraction", () => {
    expect(point).not.toBeNull();
    expect(point.it).toBe(7);
    expect(Math.abs(point.compliance - 1234)).toBeLessThan(1e-6);
    expect(Math.abs(point.volume - 0.4998)).toBeLessThan(1e-9);
  });

  test("returns null for a non-progress line", () => {
    expect(
      parseTopOptLogLine("Starting topology optimization: 274 nodes"),
    ).toBeNull();
  });

  test("returns null for an empty string", () => {
    expect(parseTopOptLogLine("")).toBeNull();
  });

  test("a compliance/volume-only line carries no stress fields", () => {
    expect(point).not.toBeNull();
    expect(point.stress).toBeUndefined();
    expect(point.maxStress).toBeUndefined();
  });

  // A stress-constrained run (KOF-236) appends the aggregated and the true max
  // von Mises stress.
  test("parses the aggregated and true max stress of a stress-constrained run", () => {
    const stressed = parseTopOptLogLine(
      "[topopt] it 12: c=4443.67 vol=0.5484 change=0.0065 sigma=1063.52 sigma_max=1061.9",
    );
    expect(stressed).not.toBeNull();
    expect(stressed.it).toBe(12);
    expect(Math.abs(stressed.volume - 0.5484)).toBeLessThan(1e-9);
    expect(Math.abs(stressed.stress - 1063.52)).toBeLessThan(1e-9);
    expect(Math.abs(stressed.maxStress - 1061.9)).toBeLessThan(1e-9);
  });
});

describe("convergenceFromLogs", () => {
  test("reduces a streamed log to one point per iteration, in order", () => {
    const curve = convergenceFromLogs([
      { text: "Starting topology optimization: 40 elements" },
      { text: "[topopt] it 1: c=5.0e+02 vol=0.90 change=0.4" },
      { text: "[topopt] it 2: c=3.0e+02 vol=0.70 change=0.2" },
      { text: "[topopt] it 3: c=2.5e+02 vol=0.50 change=0.05" },
      { text: "Topology optimization complete: 40 element densities" },
    ]);
    expect(curve).toHaveLength(3);
    expect(curve[0].it).toBe(1);
    expect(curve[2].it).toBe(3);
    expect(curve[2].volume).toBe(0.5);
  });

  // A repeated iteration line keeps the latest value (robust to re-emits).
  test("a repeated iteration index keeps the last value", () => {
    const withRepeat = convergenceFromLogs([
      { text: "[topopt] it 1: c=5.0e+02 vol=0.90 change=0.4" },
      { text: "[topopt] it 1: c=4.0e+02 vol=0.80 change=0.3" },
    ]);
    expect(withRepeat).toHaveLength(1);
    expect(Math.abs(withRepeat[0].compliance - 400)).toBeLessThan(1e-6);
  });

  test("empty log gives an empty curve", () => {
    expect(convergenceFromLogs([])).toHaveLength(0);
  });
});

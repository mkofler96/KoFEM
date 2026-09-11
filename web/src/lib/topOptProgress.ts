// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Live topology-optimization progress (KOF-233). The engine emits one
// `[topopt] it N: c=… vol=… change=…` line per iteration over the print→worker
// log channel (topology_optimize.cpp) — the density field itself only crosses
// the WASM boundary once, at the end (ADR-0002 decision 1). Parsing those lines
// lets the convergence plot animate live during the run, before the final
// history array is available.

// One point on the convergence curve: the objective (compliance for
// min_compliance) and the current volume fraction at iteration `it`. Both the
// live log parse and the final history array reduce to this shape so the plot
// draws from a single source.
export interface ConvergencePoint {
  it: number;
  objective: number;
  volume: number;
}

// Matches "[topopt] it 7: c=1.234e+03 vol=0.4998 change=0.012". `c` is the
// compliance the loop minimizes (the objective for v1's min_compliance); `vol`
// is the volume fraction. Returns null for any other log line.
const LINE_RE =
  /\[topopt\] it (\d+): c=([-+0-9.eE]+) vol=([-+0-9.eE]+) change=/;

export function parseTopOptLogLine(text: string): ConvergencePoint | null {
  const match = LINE_RE.exec(text);
  if (!match) return null;
  const it = Number(match[1]);
  const objective = Number(match[2]);
  const volume = Number(match[3]);
  if (
    !Number.isFinite(it) ||
    !Number.isFinite(objective) ||
    !Number.isFinite(volume)
  )
    return null;
  return { it, objective, volume };
}

// Reduce a streamed log channel to the convergence curve so far. Keeps the last
// entry per iteration index (the engine prints each iteration once, but this is
// robust to a repeat) in iteration order.
export function convergenceFromLogs(
  logs: { text: string }[],
): ConvergencePoint[] {
  const byIt = new Map<number, ConvergencePoint>();
  for (const { text } of logs) {
    const point = parseTopOptLogLine(text);
    if (point) byIt.set(point.it, point);
  }
  return [...byIt.values()].sort((a, b) => a.it - b.it);
}

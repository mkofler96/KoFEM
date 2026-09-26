// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Live topology-optimization progress (KOF-233). The engine emits one
// `[topopt] it N: c=… vol=… change=…` line per iteration over the print→worker
// log channel (topology_optimize.cpp). Parsing those lines lets the convergence
// plot animate live during the run, before the final history array is
// available. The density field streams on its own channel (KOF-240).

// One point on the convergence curve: the compliance and the current volume
// fraction at iteration `it`. Both formulations track the same pair — one is the
// objective, the other the constraint (min_compliance / min_volume, KOF-235) — so
// the plot needs no objective switch. Both the live log parse and the final
// history array reduce to this shape so the plot draws from a single source.
export interface ConvergencePoint {
  it: number;
  compliance: number;
  volume: number;
}

// Matches "[topopt] it 7: c=1.234e+03 vol=0.4998 change=0.012". `c` is the
// compliance and `vol` the volume fraction, whichever objective is running.
// Returns null for any other log line.
const LINE_RE =
  /\[topopt\] it (\d+): c=([-+0-9.eE]+) vol=([-+0-9.eE]+) change=/;

export function parseTopOptLogLine(text: string): ConvergencePoint | null {
  const match = LINE_RE.exec(text);
  if (!match) return null;
  const it = Number(match[1]);
  const compliance = Number(match[2]);
  const volume = Number(match[3]);
  if (
    !Number.isFinite(it) ||
    !Number.isFinite(compliance) ||
    !Number.isFinite(volume)
  )
    return null;
  return { it, compliance, volume };
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

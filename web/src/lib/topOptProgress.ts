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
//
// A stress-constrained run (KOF-236) also carries `stress`, the aggregated value
// the constraint bounds, and `maxStress`, the true max relaxed von Mises stress
// it tracks — so the plot can show how closely the aggregate follows the peak.
export interface ConvergencePoint {
  it: number;
  compliance: number;
  volume: number;
  stress?: number;
  maxStress?: number;
}

// Matches "[topopt] it 7: c=1.234e+03 vol=0.4998 change=0.012", optionally
// followed by " sigma=812.3 sigma_max=815.1" on a stress-constrained run. `c` is
// the compliance and `vol` the volume fraction, whichever objective is running.
// Returns null for any other log line.
const NUM = "([-+0-9.eE]+)";
const LINE_RE = new RegExp(
  `\\[topopt\\] it (\\d+): c=${NUM} vol=${NUM} change=${NUM}(?: sigma=${NUM} sigma_max=${NUM})?`,
);

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
  if (match[5] === undefined) return { it, compliance, volume };
  const stress = Number(match[5]);
  const maxStress = Number(match[6]);
  if (!Number.isFinite(stress) || !Number.isFinite(maxStress)) return null;
  return { it, compliance, volume, stress, maxStress };
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

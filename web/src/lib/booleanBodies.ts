// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BooleanOp } from "../hooks/useGeometryEdit";

// Which body each body of a Boolean's result came from: entry j is the old id
// of new Body j+1. boolean_geometry rebuilds the shape in the input's solid
// order — the result takes the target's place (one or more pieces: a subtract
// can cut it apart), consumed tools drop out, every other body keeps its place
// — so the result's body count fixes how many pieces the target became.
// Settings (material, element type, suppression) follow their body through the
// renumbering instead of being reset or attached to the wrong one.
export function booleanBodySources(
  bodyIds: number[],
  op: BooleanOp,
  target: number,
  tools: number[],
  keepTools: boolean,
  resultBodyCount: number,
): number[] {
  const consumed = new Set(op === "subtract" && keepTools ? [] : tools);
  const others = bodyIds.filter((id) => id !== target && !consumed.has(id));
  const pieces = resultBodyCount - others.length;
  if (pieces < 1)
    throw new Error(
      `The ${op} returned ${resultBodyCount} bodies, but ${others.length} untouched bodies alone need that many — cannot tell which result is Body ${target}. The geometry was not changed.`,
    );
  const sources: number[] = [];
  for (const id of bodyIds) {
    if (id === target) for (let k = 0; k < pieces; k++) sources.push(target);
    else if (!consumed.has(id)) sources.push(id);
  }
  return sources;
}

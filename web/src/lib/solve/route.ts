// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Which solver path a model takes, decided from its element mix, its couplings
// and the per-body Shell/Solid choice — shared by the static solve and the
// topology optimizer so both route the same model the same way.

import type { SolvePayload, TopOptPayload } from "../../workers/solverTypes.js";
import { shellMarkedBodies, requireOneShellBody } from "./autoShell.js";

export type SolveRoute =
  // All CTRIA3 → the Kirchhoff shell solver (solve_shell).
  | { path: "shell" }
  // CTRIA3 mixed with solids, or any surface-to-point coupling → the coupled
  // solid-shell assembler (solve_coupled).
  | { path: "coupled" }
  // All solid with a body marked Shell → idealised at solve time, coupled to the
  // solid bodies or as a pure shell.
  | { path: "auto-shell"; shellBodyIds: Set<number> }
  // All solid, no Shell body, no coupling → solve_linear_elastic.
  | { path: "solid" };

export function routeSolve(payload: SolvePayload): SolveRoute {
  // Shell models route away from the all-solid path. A model that is ALL CTRIA3
  // solves via the Kirchhoff shell solver; a model that MIXES CTRIA3 shells with
  // solid elements solves via the coupled solid-shell solver (the shells are
  // explicit here, unlike the auto-shell path, which idealises thin SOLID
  // bodies itself).
  const nShells = payload.elements.filter((e) => e.type === "CTRIA3").length;
  // eslint-disable-next-line kofem/no-silent-fallback -- `couplings` is optional in the solve message; a model with none is the ordinary case
  const nCouplings = payload.couplings?.length ?? 0;
  if (nShells > 0) {
    // A coupling is an RBE2/RBE3 constraint, and only the coupled assembler
    // applies one — the pure Kirchhoff shell solver has no couplings, and the
    // coupled assembler needs a solid domain to assemble. An all-shell model
    // therefore cannot carry a coupling today; say so, rather than solve it
    // as if the coupling were not there.
    if (nShells === payload.elements.length && nCouplings > 0)
      throw new Error(
        `This model is all shell elements and declares ${nCouplings} surface-to-point ` +
          "coupling(s), which the shell solver cannot apply — a coupling needs the " +
          "coupled solid-shell assembler, and that needs at least one solid body. " +
          "Delete the coupling, or keep one body solid.",
      );
    return nShells === payload.elements.length
      ? { path: "shell" }
      : { path: "coupled" };
  }
  // An all-solid model that declares a surface-to-point coupling still needs the
  // coupled assembler — solve_linear_elastic has no notion of an RBE2/RBE3
  // constraint, and the reference point is not even a node it could carry.
  if (nCouplings > 0) return { path: "coupled" };

  // A body marked "Shell" is idealised as shells and solved coupled to the solid
  // bodies — this converges where the all-solid solve of the thin part stalls
  // (#358). Which bodies are shells is the per-body Shell/Solid choice
  // (Property.discretization). No bodies marked Shell ⇒ the all-solid path.
  const shellBodyIds = new Set(
    shellMarkedBodies(payload.properties).map((p) => p.id),
  );
  if (shellBodyIds.size > 0) {
    requireOneShellBody(shellBodyIds);
    return { path: "auto-shell", shellBodyIds };
  }
  return { path: "solid" };
}

export type TopOptDomain = "shell" | "coupled" | "solid";

// The topology optimizer's design domain follows the element mix, exactly as
// the static solve routes: all CTRIA3 → optimize_topology_shell; mixed
// shell/solid or any coupling → optimize_topology_coupled; all solid →
// optimize_topology. Unlike the solve, the optimizer never idealises a Shell
// body itself, and the level-set method runs through the solid entry only —
// both are refused here rather than optimizing the wrong model.
export function routeTopOpt(payload: TopOptPayload): TopOptDomain {
  const { elements, properties, settings } = payload;
  const shellElements = elements.filter((e) => e.type === "CTRIA3");
  const solidElements = elements.filter((e) => e.type !== "CTRIA3");
  const couplings = payload.couplings ?? [];

  // A body marked "Shell" that has NOT been idealised into shell (CTRIA3)
  // elements would be turned into a mid-surface mesh only at solve time — the
  // optimizer never runs that idealisation, so it would silently optimize the
  // solid tets the user does not intend. Re-meshing idealises the shell bodies up
  // front (#397), so ask for that rather than optimize the wrong model.
  const shellBodies = shellMarkedBodies(properties);
  if (shellBodies.length > 0 && shellElements.length === 0)
    throw new Error(
      `Topology optimization: ${shellBodies.length} body/bodies are marked "Shell" ` +
        "but were not idealised into shell elements. Re-mesh (which collapses their " +
        "thin walls to a shell mid-surface), then optimize the mixed model — or switch " +
        "them to Solid.",
    );

  // The level-set optimizer runs through the plain solid entry only; a model
  // with shells or with a coupling routes to the shell/coupled entries (which
  // refuse it too), so say so before building their inputs.
  if (settings.method === "level_set" && shellElements.length > 0)
    throw new Error(
      `Topology optimization: the level-set method supports solid models only, but this model has ${shellElements.length} shell (CTRIA3) element(s) — use SIMP for shell and coupled models.`,
    );
  if (settings.method === "level_set" && couplings.length > 0)
    throw new Error(
      `Topology optimization: the level-set method does not support couplings yet, but this model has ${couplings.length} — remove them or use SIMP.`,
    );

  if (solidElements.length === 0 && couplings.length === 0) return "shell";
  if (shellElements.length > 0 || couplings.length > 0) return "coupled";
  return "solid";
}

// The "Starting … topology optimization" progress line.
export function topOptStartLog(
  payload: TopOptPayload,
  nElems: number,
  domain: TopOptDomain,
): string {
  const { settings } = payload;
  const { volumeFraction, complianceLimit, maxStress } = settings.constraints;
  const volfracNote =
    (volumeFraction !== undefined
      ? `, volume fraction ${volumeFraction}`
      : "") +
    (complianceLimit !== undefined ? `, compliance ≤ ${complianceLimit}` : "") +
    (maxStress !== undefined ? `, von Mises ≤ ${maxStress}` : "");
  return `Starting ${domain} topology optimization: ${payload.nodes.length} nodes, ${nElems} elements (${settings.objective}${volfracNote}, max ${settings.maxIterations} iterations)…`;
}

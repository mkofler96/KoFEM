// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Results → Reactions (KOF-387): each support's reaction force, its moment
// where the support holds rotations, and whether the reactions balance the
// applied load.

import { useModelStore } from "../../store/modelStore";
import {
  reactionBalance,
  type ReactionSummary,
  type Vec3,
} from "../../lib/solve/reactions";
import styles from "./Panel.module.css";

// A component as the panel shows it: four significant digits, and 0 for what
// four digits of the largest value in the summary would not show (solver
// noise, typically).
function component(value: number, scale: number): string {
  if (Math.abs(value) < 5e-5 * scale) return "0";
  return String(Number(value.toPrecision(4)));
}

const vector = (v: Vec3, scale: number) =>
  `(${v.map((c) => component(c, scale)).join(", ")})`;

const magnitude = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

export function SupportReactions({ summary }: { summary: ReactionSummary }) {
  const bcGroups = useModelStore((s) => s.bcGroups);
  const balance = reactionBalance(summary);
  const scale = Math.max(
    magnitude(summary.applied),
    ...summary.supports.map((support) => magnitude(support.force)),
  );
  const momentScale = Math.max(
    ...summary.supports.map((support) => magnitude(support.moment)),
  );
  const offBy = magnitude(balance.difference);
  return (
    <div data-testid="support-reactions">
      <div className={styles.sectionLabel}>Reactions</div>
      {summary.supports.map((support) => {
        const group = bcGroups.at(support.support);
        const name = group?.name ?? `Support ${support.support + 1}`;
        const holdsRotation =
          group !== undefined && group.dofs.some((dof) => dof >= 3);
        return (
          <div
            key={support.support}
            data-testid={`reaction-${support.support}`}
            data-force={support.force.join(",")}
          >
            <div className={styles.statRow}>
              <span className={styles.statKey}>{name}</span>
              <span className={styles.statVal}>
                {support.vertices === 0
                  ? "not in the mesh"
                  : `${component(magnitude(support.force), scale)} N`}
              </span>
            </div>
            {support.vertices > 0 && (
              <div className={styles.reactionDetail}>
                F = {vector(support.force, scale)} N
                {holdsRotation && (
                  <>
                    <br />M = {vector(support.moment, momentScale)} N·mm
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
      <p
        className={
          balance.balanced ? styles.reactionBalance : styles.reactionImbalance
        }
        data-testid="reaction-balance"
        data-balanced={String(balance.balanced)}
      >
        Applied: {vector(balance.applied, scale)} N · Reactions:{" "}
        {vector(balance.reaction, scale)} N ·{" "}
        {balance.balanced
          ? "balanced"
          : `off by ${component(offBy, scale)} N. The solve may have stopped short of its tolerance, or a coupling or tie carries load to a node no support lists.`}
        {balance.loadOnSupports &&
          ` ${component(magnitude(summary.appliedOnSupports), scale)} N of the load acts on supported nodes and goes straight into the support.`}
      </p>
    </div>
  );
}

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
  const anyRotation = summary.supports.some((support) =>
    bcGroups.at(support.support)?.dofs.some((dof) => dof >= 3),
  );
  const nameOf = (support: number) =>
    bcGroups.at(support)?.name ?? `Support ${support + 1}`;
  return (
    <div data-testid="support-reactions">
      <table className={styles.reactionTable} aria-label="Reaction forces">
        <caption className={styles.sectionLabel}>Forces (N)</caption>
        <thead>
          <tr>
            <th />
            <th>Fx</th>
            <th>Fy</th>
            <th>Fz</th>
            <th>|F|</th>
          </tr>
        </thead>
        <tbody>
          {summary.supports.map((support) => (
            <tr
              key={support.support}
              data-testid={`reaction-${support.support}`}
              data-force={support.force.join(",")}
            >
              <td>{nameOf(support.support)}</td>
              {support.vertices === 0 ? (
                <td colSpan={4} className={styles.reactionMissing}>
                  not in the mesh
                </td>
              ) : (
                <VectorCells v={support.force} scale={scale} />
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Σ reactions</td>
            <VectorCells v={balance.reaction} scale={scale} />
          </tr>
          <tr>
            <td>Applied</td>
            <VectorCells v={balance.applied} scale={scale} />
          </tr>
        </tfoot>
      </table>
      {anyRotation && (
        <table className={styles.reactionTable} aria-label="Reaction moments">
          <caption className={styles.sectionLabel}>
            Moments about each support's centre (N·mm)
          </caption>
          <thead>
            <tr>
              <th />
              <th>Mx</th>
              <th>My</th>
              <th>Mz</th>
              <th>|M|</th>
            </tr>
          </thead>
          <tbody>
            {summary.supports
              .filter((support) =>
                bcGroups.at(support.support)?.dofs.some((dof) => dof >= 3),
              )
              .map((support) => (
                <tr key={support.support}>
                  <td>{nameOf(support.support)}</td>
                  <VectorCells v={support.moment} scale={momentScale} />
                </tr>
              ))}
          </tbody>
        </table>
      )}
      <p
        className={
          balance.balanced ? styles.reactionBalance : styles.reactionImbalance
        }
        data-testid="reaction-balance"
        data-balanced={String(balance.balanced)}
      >
        {balance.balanced
          ? "Balanced"
          : `Off by ${component(offBy, scale)} N. The solve may have stopped short of its tolerance, or a coupling or tie carries load to a node no support lists.`}
      </p>
      {balance.loadOnSupports && (
        <p className={styles.formNote}>
          {component(magnitude(summary.appliedOnSupports), scale)} N of the load
          acts on supported nodes and goes straight into the support.
        </p>
      )}
    </div>
  );
}

// A vector's components and its length, as table cells.
function VectorCells({ v, scale }: { v: Vec3; scale: number }) {
  return (
    <>
      <td>{component(v[0], scale)}</td>
      <td>{component(v[1], scale)}</td>
      <td>{component(v[2], scale)}</td>
      <td>{component(magnitude(v), scale)}</td>
    </>
  );
}

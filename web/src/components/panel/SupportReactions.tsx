// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Results → Reactions (KOF-387): each support's reaction force, its moment
// where the support holds rotations, and whether the reactions balance the
// applied load.

import { useModelStore } from "../../store/modelStore";
import {
  reactionBalance,
  reactionComponent as component,
  type ReactionSummary,
  type Vec3,
} from "../../lib/solve/reactions";
import { useT } from "../../i18n/useLocale";
import { resultsMessages } from "../../i18n/messages/results";
import styles from "./Panel.module.css";

const magnitude = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

export function SupportReactions({ summary }: { summary: ReactionSummary }) {
  const bcGroups = useModelStore((s) => s.bcGroups);
  const text = useT(resultsMessages);
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
    bcGroups.at(support)?.name ?? text.support(support + 1);
  return (
    <div data-testid="support-reactions">
      <VectorTable
        label={text.reactionForces}
        caption={text.forcesCaption}
        symbol="F"
        scale={scale}
        rows={summary.supports.map((support) => ({
          key: String(support.support),
          name: nameOf(support.support),
          vector: support.vertices === 0 ? null : support.force,
          testId: `reaction-${support.support}`,
          force: support.force,
        }))}
        footer={[
          {
            key: "sum",
            name: text.sumOfReactions,
            vector: balance.reaction,
          },
          { key: "applied", name: text.applied, vector: balance.applied },
        ]}
      />
      {anyRotation && (
        <VectorTable
          label={text.reactionMoments}
          caption={text.momentsCaption}
          symbol="M"
          scale={momentScale}
          rows={summary.supports
            .filter((support) =>
              bcGroups.at(support.support)?.dofs.some((dof) => dof >= 3),
            )
            .map((support) => ({
              key: String(support.support),
              name: nameOf(support.support),
              vector: support.moment,
            }))}
        />
      )}
      <p
        className={
          balance.balanced ? styles.reactionBalance : styles.reactionImbalance
        }
        data-testid="reaction-balance"
        data-balanced={String(balance.balanced)}
      >
        {balance.balanced ? text.balanced : text.offBy(component(offBy, scale))}
      </p>
      {balance.loadOnSupports && (
        <p className={styles.formNote}>
          {text.loadOnSupports(
            component(magnitude(summary.appliedOnSupports), scale),
          )}
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

interface VectorRowData {
  key: string;
  name: string;
  // Null for a support none of whose nodes reached the solve.
  vector: Vec3 | null;
  testId?: string;
  // The support's force, for tests to read exactly.
  force?: Vec3;
}

// A table of vectors: a row per support (or sum), its x, y, z components and
// length; `symbol` heads the columns (F or M).
function VectorTable({
  label,
  caption,
  symbol,
  scale,
  rows,
  footer,
}: {
  label: string;
  caption: string;
  symbol: string;
  scale: number;
  rows: VectorRowData[];
  footer?: VectorRowData[];
}) {
  const heads = ["", `${symbol}x`, `${symbol}y`, `${symbol}z`, `|${symbol}|`];
  const headCells = heads.map((head) => <th key={head}>{head}</th>);
  const row = (data: VectorRowData) => (
    <VectorRow key={data.key} data={data} scale={scale} />
  );
  return (
    <table className={styles.reactionTable} aria-label={label}>
      <caption className={styles.sectionLabel}>{caption}</caption>
      <thead>
        <tr>{headCells}</tr>
      </thead>
      <tbody>{rows.map(row)}</tbody>
      {footer && <tfoot>{footer.map(row)}</tfoot>}
    </table>
  );
}

function VectorRow({ data, scale }: { data: VectorRowData; scale: number }) {
  const text = useT(resultsMessages);
  return (
    <tr data-testid={data.testId} data-force={data.force?.join(",")}>
      <td>{data.name}</td>
      {data.vector === null ? (
        <td colSpan={4} className={styles.reactionMissing}>
          {text.notInMesh}
        </td>
      ) : (
        <VectorCells v={data.vector} scale={scale} />
      )}
    </tr>
  );
}

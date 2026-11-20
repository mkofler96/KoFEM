// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  notConvergedNotice,
  raisedIterationLimit,
  type TopOptConvergence,
} from "../../lib/topOptConvergence";
import styles from "./Panel.module.css";

// The warning for an optimization that stopped at its iteration limit
// (KOF-412), with the way out: run again with a higher limit. Renders nothing
// for a converged run.
export function NotConvergedNotice({
  run,
  onRerun,
}: {
  run: TopOptConvergence;
  onRerun: () => void;
}) {
  const notice = notConvergedNotice(run);
  if (notice === null) return null;
  return (
    <div
      className={styles.warnNotice}
      role="status"
      data-testid="topopt-not-converged"
    >
      <span>{notice}</span>
      <button className={styles.outlineBtn} onClick={onRerun}>
        Run again with {raisedIterationLimit(run.iterations)} iterations
      </button>
    </div>
  );
}

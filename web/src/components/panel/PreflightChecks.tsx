// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from "./Panel.module.css";

const TICK = (
  <svg viewBox="0 0 8 8" width="7" height="7" aria-hidden="true">
    <path
      d="M1.5 4L3 5.5L6.5 2"
      stroke="currentColor"
      strokeWidth="1.8"
      fill="none"
      strokeLinecap="round"
    />
  </svg>
);

const CROSS = (
  <svg viewBox="0 0 8 8" width="6" height="6" aria-hidden="true">
    <path
      d="M2 2l4 4M6 2L2 6"
      stroke="currentColor"
      strokeWidth="1.6"
      fill="none"
      strokeLinecap="round"
    />
  </svg>
);

// The readiness list a study shows before it runs: one badge per check, green
// tick when it holds, amber cross when it does not.
export function PreflightChecks({ checks }: { checks: [boolean, string][] }) {
  return (
    <>
      <div className={styles.sectionLabel}>Pre-flight check</div>
      {checks.map(([ok, label]) => (
        <div
          key={label}
          className={styles.checkRow}
          data-testid={ok ? "check-ok" : "check-fail"}
        >
          <span
            className={ok ? styles.checkOk : styles.checkFail}
            aria-label={ok ? "passed" : "failed"}
          >
            {ok ? TICK : CROSS}
          </span>
          <span className={styles.checkLabel}>{label}</span>
        </div>
      ))}
    </>
  );
}

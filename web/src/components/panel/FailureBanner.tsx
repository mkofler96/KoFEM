// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FailureNotice } from "../../lib/solve/failureAdvice";
import styles from "./Panel.module.css";

/** A failed solve or optimization: what to change, then the solver's words. */
export function FailureBanner({
  notice,
  onClose,
  testId,
}: {
  notice: FailureNotice;
  onClose: () => void;
  testId: string;
}) {
  return (
    <div className={styles.errorBanner} data-testid={testId}>
      <span>
        {notice.advice !== null && (
          <span className={styles.errorAdvice}>{notice.advice}</span>
        )}
        {notice.detail}
      </span>
      <button onClick={onClose}>×</button>
    </div>
  );
}

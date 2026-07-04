// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useModelStore } from "../../store/modelStore";
import { BcSection } from "./BcSection";
import { LoadSection } from "./LoadSection";
import styles from "./LeftPanel.module.css";

export function BoundaryConditionsPanel() {
  // Boundary conditions and loads reference mesh nodes, so they can only be
  // defined once a volume mesh exists.
  const meshOk = useModelStore((s) => s.nodes.length > 0);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        {error && (
          <div className={styles.errorBanner} data-testid="constraints-error">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}
        {!meshOk && (
          <div className={styles.empty} data-testid="no-mesh-hint">
            Generate a mesh before adding boundary conditions.
          </div>
        )}
        {meshOk && (
          <>
            <BcSection onError={setError} />
            <LoadSection onError={setError} />
          </>
        )}
      </div>
    </div>
  );
}

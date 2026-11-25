// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useModelStore } from "../../store/modelStore";
import { useExampleLoad } from "../../lib/examples";
import { useGeometry } from "../../hooks/useGeometry";
import { categorizeError, track } from "../../lib/analytics";
import { SAMPLE, startSampleGuide } from "../../lib/sampleGuide";
import { tr, useT } from "../../i18n/useLocale";
import { geometryMessages } from "../../i18n/messages/geometry";
import styles from "./EmptyState.module.css";

// An empty workspace offers the sample (KOF-261): the wall bracket's CAD file,
// which the user then meshes, supports, loads and solves with the guide
// (SampleGuide). Gone as soon as there is a model.
export function EmptyState() {
  const hasStarted = useModelStore((s) => s.hasStarted);
  const busy = useModelStore((s) => s.isRunning);
  const loadingExample = useExampleLoad((s) => s.loading);
  const { importCadFile } = useGeometry();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = useT(geometryMessages);
  if (hasStarted) return null;

  async function openSample() {
    setOpening(true);
    setError(null);
    let bytes: ArrayBuffer;
    try {
      const res = await fetch(SAMPLE.url);
      if (!res.ok)
        throw new Error(tr(geometryMessages).sampleHttpError(res.status));
      bytes = await res.arrayBuffer();
    } catch (err) {
      setError(tr(geometryMessages).sampleFailed((err as Error).message));
      setOpening(false);
      track("example_load_failed", {
        example_id: SAMPLE.exampleId,
        error_category: categorizeError(err),
      });
      return;
    }
    const file = new File([bytes], SAMPLE.fileName);
    if (await importCadFile(file, SAMPLE.exampleId)) {
      const geometry = useModelStore.getState().stepSurface;
      if (geometry) startSampleGuide(geometry);
      return;
    }
    // useGeometry tracked the failure and holds the reason.
    const reason = useModelStore.getState().stepImportError;
    const failed = tr(geometryMessages);
    setError(
      reason ? failed.sampleFailed(reason) : failed.sampleFailedNoReason,
    );
    setOpening(false);
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.entry} data-testid="empty-state">
        <button
          className={styles.sampleBtn}
          disabled={busy || opening || loadingExample !== null}
          onClick={openSample}
        >
          {opening || loadingExample !== null ? text.opening : text.trySample}
        </button>
        <p className={styles.note}>{text.sampleNote}</p>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

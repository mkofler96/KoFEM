// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRef, type ChangeEvent } from "react";
import { useModelStore } from "../../store/modelStore";
import {
  analysisFileName,
  parseAnalysisFile,
  serializeAnalysis,
} from "../../lib/analysisFile";
import { resetWorker } from "../../workers/sharedWorker";
import styles from "./TopBar.module.css";

export function TopBar() {
  const modelName = useModelStore((s) => s.modelName);
  const loadAnalysis = useModelStore((s) => s.loadAnalysis);
  const loadInputRef = useRef<HTMLInputElement | null>(null);

  function handleNewAnalysis() {
    const store = useModelStore.getState();
    if (
      store.hasStarted &&
      !window.confirm(
        "Start a new analysis? Unsaved changes will be lost — save the current analysis first if you want to keep it.",
      )
    )
      return;
    // Drop the worker too: it may still hold the imported OCCT shape, and any
    // in-flight mesh/solve belongs to the analysis being discarded.
    resetWorker();
    store.reset();
  }

  function handleSave() {
    const state = useModelStore.getState();
    const xml = serializeAnalysis(state);
    const url = URL.createObjectURL(
      new Blob([xml], { type: "application/xml" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = analysisFileName(state.modelName);
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleLoadFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    try {
      loadAnalysis(parseAnalysisFile(await file.text()));
    } catch (err) {
      window.alert(`Could not load analysis: ${(err as Error).message}`);
    }
  }

  return (
    <header className={styles.bar}>
      {/* Brand */}
      <div className={styles.brand}>
        <img
          className={styles.mark}
          src="/kofem_logo.svg"
          alt="KoFEM logo"
          width={24}
          height={24}
        />
        <span className={styles.name}>KoFEM</span>
        <span className={styles.crumb}>
          <span className={styles.crumbMuted}>Workspace</span>
          <span className={styles.crumbSep}>/</span>
          {/* eslint-disable-next-line kofem/no-silent-fallback -- breadcrumb label for an unnamed model; cosmetic, never fed back into the analysis */}
          <span className={styles.crumbPage}>{modelName || "Untitled"}</span>
        </span>
      </div>

      {/* Right */}
      <div className={styles.right}>
        <input
          ref={loadInputRef}
          type="file"
          accept=".vtu"
          style={{ display: "none" }}
          onChange={handleLoadFile}
        />
        <button
          className={styles.iconBtn}
          title="New analysis"
          aria-label="New analysis"
          onClick={handleNewAnalysis}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <path
              d="M9 2H4a1 1 0 00-1 1v10a1 1 0 001 1h8a1 1 0 001-1V6L9 2z"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
            <path
              d="M9 2v4h4"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
            <path
              d="M8 8.5v3M6.5 10h3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button
          className={styles.iconBtn}
          title="Save analysis (.vtu)"
          aria-label="Save analysis"
          onClick={handleSave}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 2v8M8 10l-3-3M8 10l3-3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M2.5 11v2a1 1 0 001 1h9a1 1 0 001-1v-2"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button
          className={styles.iconBtn}
          title="Load analysis (.vtu)"
          aria-label="Load analysis"
          onClick={() => loadInputRef.current?.click()}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 12V4M8 4L5 7M8 4l3 3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M2.5 11v2a1 1 0 001 1h9a1 1 0 001-1v-2"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button
          className={styles.iconBtn}
          title="Settings"
          onClick={() => {}}
          aria-label="Settings"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <circle
              cx="8"
              cy="8"
              r="2.5"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <path
              d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <div className={styles.avatar}>K</div>
      </div>
    </header>
  );
}

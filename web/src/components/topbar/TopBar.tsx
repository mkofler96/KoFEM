// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRef, type ChangeEvent } from "react";
import { useModelStore } from "../../store/modelStore";
import {
  analysisFileName,
  parseAnalysisFile,
  serializeAnalysis,
} from "../../lib/analysisFile";
import { parseReport } from "../../lib/bugReport";
import { looksLikeZip } from "../../lib/zip";
import { resetWorker } from "../../workers/sharedWorker";
import { setWorkflow } from "../../lib/analytics";
import { clearWorkerLogs } from "../../hooks/useWorkerLogs";
import { FeedbackMenu } from "./FeedbackMenu";
import { SiteMenu, confirmLeave } from "./SiteMenu";
import { SettingsMenu } from "./SettingsMenu";
import { tr, useT } from "../../i18n/useLocale";
import { topbarMessages } from "../../i18n/messages/topbar";
import { sendToWorker } from "../../workers/sharedWorker";
import type { CadFaceProperties } from "../../lib/cadFaceProperties";
import styles from "./TopBar.module.css";

// A development deployment is marked at container start with
// <meta name="kofem-channel" content="dev"> (web/docker-entrypoint.d/
// 30-kofem-channel.sh); production and local builds carry no such tag.
const DEV_CHANNEL =
  document
    .querySelector<HTMLMetaElement>('meta[name="kofem-channel"]')
    ?.getAttribute("content") === "dev";

export function TopBar() {
  const modelName = useModelStore((s) => s.modelName);
  const loadAnalysis = useModelStore((s) => s.loadAnalysis);
  const loadInputRef = useRef<HTMLInputElement | null>(null);
  const text = useT(topbarMessages);

  function handleNewAnalysis() {
    const store = useModelStore.getState();
    if (store.hasStarted && !window.confirm(text.confirmNewAnalysis)) return;
    // Drop the worker too: it may still hold the imported OCCT shape, and any
    // in-flight mesh/solve belongs to the analysis being discarded.
    resetWorker();
    store.reset();
    clearWorkerLogs();
    setWorkflow("none");
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
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (looksLikeZip(bytes)) {
        // A problem report (lib/bugReport): its analysis, then the CAD file it
        // was built from, so the model can be re-meshed and solved again.
        const report = await parseReport(bytes);
        // Loaded into the engine first, so a file it cannot read leaves the
        // current model as it was.
        const cad = report.cad && {
          ...report.cad,
          faces: (
            await sendToWorker<{ cadFaces: CadFaceProperties[] }>(
              "parse_step",
              { bytes: report.cad.bytes, format: report.cad.format },
            )
          ).cadFaces,
        };
        loadAnalysis(report.analysis);
        clearWorkerLogs();
        if (cad) {
          const { bytes: cadBytes, format, faces: cadFaces } = cad;
          const store = useModelStore.getState();
          store.setGeometryFormat(format);
          store.setStepBytes(cadBytes, cadFaces);
        }
      } else {
        loadAnalysis(parseAnalysisFile(new TextDecoder("utf-8").decode(bytes)));
        clearWorkerLogs();
      }
      setWorkflow("saved_file");
    } catch (err) {
      window.alert(tr(topbarMessages).loadFailed((err as Error).message));
    }
  }

  return (
    <header className={styles.bar}>
      {/* Brand */}
      <div className={styles.brand}>
        <a
          className={styles.home}
          href="/"
          aria-label={text.home}
          onClick={confirmLeave}
        >
          <img
            className={styles.mark}
            src="/kofem_logo.svg"
            alt=""
            width={24}
            height={24}
          />
          <span className={styles.name}>KoFEM</span>
        </a>
        {DEV_CHANNEL && (
          <span
            className={styles.devBadge}
            data-testid="dev-badge"
            title={text.devBuild}
          >
            DEV
          </span>
        )}
        <span className={styles.crumb}>
          <span className={styles.crumbMuted}>{text.workspace}</span>
          <span className={styles.crumbSep}>/</span>
          <span className={styles.crumbPage}>{modelName || text.untitled}</span>
        </span>
      </div>

      {/* Right */}
      <div className={styles.right}>
        <input
          ref={loadInputRef}
          type="file"
          accept=".vtu,.zip"
          data-testid="load-analysis-input"
          style={{ display: "none" }}
          onChange={handleLoadFile}
        />
        <FeedbackMenu />
        <button
          className={styles.iconBtn}
          title={text.newAnalysis}
          aria-label={text.newAnalysis}
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
          title={text.saveAnalysisTitle}
          aria-label={text.saveAnalysis}
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
          title={text.loadAnalysisTitle}
          aria-label={text.loadAnalysis}
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
        <SettingsMenu />
        <SiteMenu />
      </div>
    </header>
  );
}

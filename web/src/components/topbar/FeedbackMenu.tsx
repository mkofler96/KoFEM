// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useModelStore } from "../../store/modelStore";
import { APP_VERSION } from "../../lib/version";
import { ENGINE_ID } from "../../lib/engineId";
import { track } from "../../lib/analytics";
import {
  buildDiagnostics,
  feedbackIssueUrl,
  formatDiagnostics,
  type Diagnostics,
  type WebGlSupport,
} from "../../lib/feedback";
import {
  REPORT_EMAIL,
  buildReport,
  reportFileName,
  reportMailtoUrl,
} from "../../lib/bugReport";
import { workerLogLines } from "../../hooks/useWorkerLogs";
import { lastShownError, watchShownErrors } from "./shownErrors";
import styles from "./Feedback.module.css";

// Top-bar entry for feedback. "Report a problem" saves a report ZIP
// (lib/bugReport) and opens the user's email program to send it to
// REPORT_EMAIL (KOF-202); a public GitHub issue stays available from the same
// dialog. "Suggest an improvement" opens the GitHub form. No path sends
// anything from KoFEM: the user sends the email or submits the issue.
// rel="noreferrer" keeps the app URL (which may name a gallery example) out of
// GitHub's referrer as well.

let webGl: WebGlSupport | null = null;
function webGlSupport(): WebGlSupport {
  if (webGl !== null) return webGl;
  // A throwaway context per probe, released at once: browsers cap how many a
  // page may hold, and the viewport needs its own.
  const released = (
    ctx: WebGLRenderingContext | WebGL2RenderingContext | null,
  ) => {
    ctx?.getExtension("WEBGL_lose_context")?.loseContext();
    return ctx !== null;
  };
  const canvas = () => document.createElement("canvas");
  webGl = released(canvas().getContext("webgl2"))
    ? "WebGL 2"
    : released(canvas().getContext("webgl"))
      ? "WebGL 1"
      : "unavailable";
  return webGl;
}

function collectDiagnostics(): Diagnostics {
  return buildDiagnostics(
    {
      appVersion: APP_VERSION,
      engineId: ENGINE_ID,
      userAgent: navigator.userAgent,
      webAssembly: typeof WebAssembly === "object",
      webGl: webGlSupport(),
      lastShownError: lastShownError(),
    },
    useModelStore.getState(),
  );
}

export function FeedbackMenu() {
  const [menuOpen, setMenuOpen] = useState(false);
  // The diagnostics of an open report, taken when the user chose to report:
  // the state they are about to describe.
  const [report, setReport] = useState<Diagnostics | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => watchShownErrors(), []);

  useEffect(() => {
    if (!menuOpen) return undefined;
    function onPointerDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        className={styles.trigger}
        aria-label="Feedback"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Report a problem or suggest an improvement"
        data-testid="feedback-button"
        onClick={() => setMenuOpen((open) => !open)}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <path
            d="M2.5 3.5a1 1 0 011-1h9a1 1 0 011 1v6.5a1 1 0 01-1 1H7l-3 2.5V11H3.5a1 1 0 01-1-1V3.5z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
        <span className={styles.triggerLabel}>Feedback</span>
      </button>

      {menuOpen && (
        <div
          className={styles.menu}
          role="menu"
          aria-label="Feedback"
          data-testid="feedback-menu"
        >
          <button
            className={styles.item}
            role="menuitem"
            data-testid="feedback-report"
            onClick={() => {
              setMenuOpen(false);
              setReport(collectDiagnostics());
              track("feedback_report_opened", {});
            }}
          >
            Report a problem
          </button>
          <a
            className={styles.item}
            role="menuitem"
            data-testid="feedback-suggest"
            href={feedbackIssueUrl("improvement", null)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              setMenuOpen(false);
              track("feedback_suggestion_opened", {});
            }}
          >
            Suggest an improvement
          </a>
          <p className={styles.menuNote}>
            Problems go by email, suggestions to a public GitHub issue.
          </p>
        </div>
      )}

      {report && (
        <ReportDialog diagnostics={report} onClose={() => setReport(null)} />
      )}
    </div>
  );
}

type ReportState =
  | { phase: "choose"; error: string | null }
  | { phase: "saving" }
  | { phase: "saved"; fileName: string; mailto: string; withCad: boolean };

function downloadBytes(bytes: Uint8Array, fileName: string) {
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(bytes)], { type: "application/zip" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  // Some browsers start the download after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function openMail(mailto: string) {
  const anchor = document.createElement("a");
  anchor.href = mailto;
  anchor.click();
}

async function saveReport(withCad: boolean, diagnostics: Diagnostics) {
  const state = useModelStore.getState();
  if (withCad && state.stepBytes === null)
    throw new Error("there is no CAD file to include");
  const created = new Date();
  const zip = await buildReport({
    analysis: state,
    cad:
      withCad && state.stepBytes
        ? { bytes: state.stepBytes, format: state.geometryFormat }
        : null,
    diagnostics,
    lastError: lastShownError(),
    logs: workerLogLines(),
    created,
  });
  const fileName = reportFileName(state.modelName, created);
  const mailto = reportMailtoUrl(fileName, diagnostics.appVersion);
  downloadBytes(zip, fileName);
  openMail(mailto);
  return { fileName, mailto };
}

function ReportDialog({
  diagnostics,
  onClose,
}: {
  diagnostics: Diagnostics;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const hasCad = useModelStore((s) => s.stepBytes !== null);
  const [state, setState] = useState<ReportState>({
    phase: "choose",
    error: null,
  });
  // Opt-in: a GitHub report is a public issue, so diagnostics go in only when
  // the user ticks the box after reading them.
  const [include, setInclude] = useState(false);
  const url = feedbackIssueUrl("problem", include ? diagnostics : null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) throw new Error("ReportDialog: the <dialog> did not mount");
    // StrictMode runs this twice; the dialog closes with its unmount.
    if (!dialog.open) dialog.showModal();
  }, []);

  function save(withCad: boolean) {
    setState({ phase: "saving" });
    saveReport(withCad, diagnostics).then(
      ({ fileName, mailto }) =>
        setState({ phase: "saved", fileName, mailto, withCad }),
      (err: unknown) =>
        setState({
          phase: "choose",
          error: `Could not save the report: ${(err as Error).message}`,
        }),
    );
  }

  const close = () => dialogRef.current?.close();

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="feedback-report-title"
      data-testid="feedback-dialog"
      onClose={onClose}
      // A click on the backdrop lands on the <dialog> itself; the content
      // fills it, so any click inside lands on a child.
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
    >
      <div className={styles.body}>
        <h2 id="feedback-report-title" className={styles.title}>
          Report a problem
        </h2>

        {state.phase === "saved" ? (
          <div data-testid="report-saved">
            <p className={styles.text}>
              Attach <strong>{state.fileName}</strong> from your downloads to
              the email and send it.
            </p>
            <p className={styles.text}>
              Email did not open? Write to{" "}
              <a href={state.mailto} data-testid="report-mailto">
                {REPORT_EMAIL}
              </a>
              .
            </p>
            <div className={styles.actions}>
              <button type="button" className={styles.primary} onClick={close}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className={styles.text}>
              Save a report and email it to <strong>{REPORT_EMAIL}</strong>.
              KoFEM sends nothing itself.{" "}
              <a href="/privacy/#feedback" target="_blank" rel="noopener">
                Privacy
              </a>
            </p>
            <p className={styles.listTitle}>The report contains</p>
            <ul className={styles.contents} data-testid="report-contents">
              <li>
                Your analysis: settings, supports, loads, mesh and results
              </li>
              <li>
                {hasCad
                  ? "Your CAD file — choose Without CAD for a confidential model"
                  : "No CAD file: this analysis has none loaded"}
              </li>
              <li>
                App and engine versions, browser, the recent log and the last
                error shown
              </li>
            </ul>
            {state.phase === "choose" && state.error && (
              <p
                className={styles.error}
                role="alert"
                data-testid="report-error"
              >
                {state.error}
              </p>
            )}
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondary}
                onClick={close}
              >
                Cancel
              </button>
              {hasCad && (
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={state.phase === "saving"}
                  data-testid="report-without-cad"
                  onClick={() => save(false)}
                >
                  Without CAD
                </button>
              )}
              <button
                type="button"
                className={styles.primary}
                disabled={state.phase === "saving"}
                data-testid="report-save"
                onClick={() => save(hasCad)}
              >
                {state.phase === "saving" ? "Saving…" : "Save and email"}
              </button>
            </div>

            <details className={styles.github} data-testid="feedback-github">
              <summary>Report publicly on GitHub instead</summary>
              <p className={styles.text}>
                Opens a public GitHub issue without your model.
              </p>
              <label className={styles.optIn}>
                <input
                  type="checkbox"
                  checked={include}
                  onChange={(e) => setInclude(e.target.checked)}
                  data-testid="feedback-include"
                />
                Include diagnostics (no geometry, file names or results)
              </label>
              <pre
                className={`${styles.preview} ${include ? styles.previewOn : ""}`}
                data-testid="feedback-diagnostics"
                aria-label="Diagnostics preview"
              >
                {formatDiagnostics(diagnostics)}
              </pre>
              <div className={styles.actions}>
                <a
                  className={styles.secondary}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="feedback-continue"
                  onClick={close}
                >
                  Continue on GitHub ↗
                </a>
              </div>
            </details>
          </>
        )}
      </div>
    </dialog>
  );
}

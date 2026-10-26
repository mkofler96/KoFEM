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
import { lastShownError, watchShownErrors } from "./shownErrors";
import styles from "./Feedback.module.css";

// Top-bar entry to the two GitHub issue forms. Neither path sends anything
// from KoFEM: both are links the user follows, and the report exists only once
// they submit it on GitHub. rel="noreferrer" keeps the app URL (which may name
// a gallery example) out of GitHub's referrer as well.

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
    if (!menuOpen) return;
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
        title="Feedback — report a problem or suggest an improvement"
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
            <span className={styles.itemTitle}>Report a problem</span>
            <span className={styles.itemSub}>
              Something broke, or a result looks wrong
            </span>
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
            <span className={styles.itemTitle}>Suggest an improvement</span>
            <span className={styles.itemSub}>
              A short form on GitHub — opens in a new tab
            </span>
          </a>
          <p className={styles.menuNote}>
            Both go to public GitHub issues. KoFEM sends nothing on its own.{" "}
            <a href="/privacy/#feedback" target="_blank" rel="noopener">
              Privacy
            </a>
          </p>
        </div>
      )}

      {report && (
        <ReportDialog diagnostics={report} onClose={() => setReport(null)} />
      )}
    </div>
  );
}

function ReportDialog({
  diagnostics,
  onClose,
}: {
  diagnostics: Diagnostics;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  // Opt-in: the report is a public issue, so diagnostics go in only when the
  // user ticks the box after reading them.
  const [include, setInclude] = useState(false);
  const url = feedbackIssueUrl("problem", include ? diagnostics : null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) throw new Error("ReportDialog: the <dialog> did not mount");
    // StrictMode runs this twice; the dialog closes with its unmount.
    if (!dialog.open) dialog.showModal();
  }, []);

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
        <p className={styles.text}>
          You describe what happened on GitHub: the form asks for the steps to
          reproduce it and what you expected instead. KoFEM sends nothing — the
          report exists only once you submit it there, and{" "}
          <strong>GitHub issues are public</strong>.
        </p>

        <label className={styles.optIn}>
          <input
            type="checkbox"
            checked={include}
            onChange={(e) => setInclude(e.target.checked)}
            data-testid="feedback-include"
          />
          Include these diagnostics in the report
        </label>
        <pre
          className={`${styles.preview} ${include ? styles.previewOn : ""}`}
          data-testid="feedback-diagnostics"
          aria-label="Diagnostics preview"
        >
          {formatDiagnostics(diagnostics)}
        </pre>
        <p className={styles.fine}>
          Never included: your geometry, file names, coordinates, mesh, results
          or any other model data. Please don&apos;t attach confidential CAD
          files to the issue — a gallery example or a simple model that shows
          the problem helps just as much.{" "}
          <a href="/privacy/#feedback" target="_blank" rel="noopener">
            Privacy
          </a>
        </p>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => dialogRef.current?.close()}
          >
            Cancel
          </button>
          <a
            className={styles.primary}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="feedback-continue"
            onClick={() => dialogRef.current?.close()}
          >
            Continue on GitHub ↗
          </a>
        </div>
      </div>
    </dialog>
  );
}

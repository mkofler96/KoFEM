// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useModelStore } from "../../store/modelStore";
import { APP_VERSION } from "../../lib/version";
import { ENGINE_ID } from "../../lib/engineId";
import { track } from "../../lib/analytics";
import {
  REPORT_EMAIL,
  buildDiagnostics,
  feedbackIssueUrl,
  formatDiagnostics,
  reportMailtoUrl,
  type Diagnostics,
  type FeedbackKind,
  type WebGlSupport,
} from "../../lib/feedback";
import { buildReport, reportFileName } from "../../lib/bugReport";
import { workerLogLines } from "../../hooks/useWorkerLogs";
import { lastShownError, watchShownErrors } from "./shownErrors";
import { useT } from "../../i18n/useLocale";
import { feedbackMessages } from "../../i18n/messages/feedback";
import styles from "./Feedback.module.css";

// Top-bar "Report a problem" button. One click opens the dialog, for problems
// and ideas alike (KOF-380). The user picks how to send it:
//   - "Send an email" opens their email program addressed to REPORT_EMAIL with
//     the diagnostics in the body. A report ZIP with the model (lib/bugReport,
//     KOF-202) downloads only if they ask for it, to attach themselves.
//   - "Open a GitHub issue" opens the bug or feature form, with diagnostics
//     only when they tick them in.
// No path sends anything from KoFEM: the user sends the email or submits the
// issue. rel="noreferrer" keeps the app URL (which may name a gallery example)
// out of GitHub's referrer as well.

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

// The top-bar "Report a problem" button: one click opens the dialog. (The
// component keeps its old name so TopBar.tsx needs no change.)
export function FeedbackMenu() {
  // The diagnostics of an open report, taken when the user chose to report:
  // the state they are about to describe.
  const [report, setReport] = useState<Diagnostics | null>(null);
  const text = useT(feedbackMessages);

  useEffect(() => watchShownErrors(), []);

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.trigger}
        aria-label={text.reportProblem}
        aria-haspopup="dialog"
        title={text.reportTitle}
        data-testid="feedback-button"
        onClick={() => {
          setReport(collectDiagnostics());
          track("feedback_report_opened", {});
        }}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <path
            d="M2.5 3.5a1 1 0 011-1h9a1 1 0 011 1v6.5a1 1 0 01-1 1H7l-3 2.5V11H3.5a1 1 0 01-1-1V3.5z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
        <span className={styles.triggerLabel}>{text.reportProblem}</span>
      </button>

      {report && (
        <ReportDialog diagnostics={report} onClose={() => setReport(null)} />
      )}
    </div>
  );
}

// The dialog's steps: the choice, then the email path or the GitHub path.
type Step = "choose" | "email" | "github";

type ZipState =
  | { phase: "idle"; error: string | null }
  | { phase: "saving" }
  | { phase: "saved"; fileName: string };

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

async function downloadReport(withCad: boolean, diagnostics: Diagnostics) {
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
  downloadBytes(zip, fileName);
  return fileName;
}

function ReportDialog({
  diagnostics,
  onClose,
}: {
  diagnostics: Diagnostics;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [step, setStep] = useState<Step>("choose");
  const mailto = reportMailtoUrl(diagnostics);
  const text = useT(feedbackMessages);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) throw new Error("ReportDialog: the <dialog> did not mount");
    // StrictMode runs this twice; the dialog closes with its unmount.
    if (!dialog.open) dialog.showModal();
  }, []);

  const close = () => dialogRef.current?.close();
  const back = () => setStep("choose");

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
          {text.reportProblem}
        </h2>

        {step === "choose" && (
          <>
            <p className={styles.text}>
              {text.intro}{" "}
              <a href="/privacy/#feedback" target="_blank" rel="noopener">
                {text.privacy}
              </a>
            </p>
            <div className={styles.choices}>
              <button
                type="button"
                className={styles.choice}
                data-testid="report-email"
                onClick={() => {
                  openMail(mailto);
                  setStep("email");
                  track("feedback_email_opened", {});
                }}
              >
                <span className={styles.choiceTitle}>{text.sendEmail}</span>
                <span className={styles.choiceText}>
                  {text.emailPrivate(REPORT_EMAIL)}
                </span>
              </button>
              <button
                type="button"
                className={styles.choice}
                data-testid="report-github"
                onClick={() => setStep("github")}
              >
                <span className={styles.choiceTitle}>{text.openIssue}</span>
                <span className={styles.choiceText}>{text.issuePublic}</span>
              </button>
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondary}
                onClick={close}
              >
                {text.cancel}
              </button>
            </div>
          </>
        )}

        {step === "email" && (
          <EmailStep
            diagnostics={diagnostics}
            mailto={mailto}
            onBack={back}
            onDone={close}
          />
        )}

        {step === "github" && (
          <GitHubStep
            diagnostics={diagnostics}
            onBack={back}
            onContinue={close}
          />
        )}
      </div>
    </dialog>
  );
}

function EmailStep({
  diagnostics,
  mailto,
  onBack,
  onDone,
}: {
  diagnostics: Diagnostics;
  mailto: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const hasCad = useModelStore((s) => s.stepBytes !== null);
  const [zip, setZip] = useState<ZipState>({ phase: "idle", error: null });
  const text = useT(feedbackMessages);

  function download(withCad: boolean) {
    setZip({ phase: "saving" });
    downloadReport(withCad, diagnostics).then(
      (fileName) => setZip({ phase: "saved", fileName }),
      (err: unknown) =>
        setZip({
          phase: "idle",
          error: text.saveFailed((err as Error).message),
        }),
    );
  }

  return (
    <div data-testid="report-email-sent">
      <p className={styles.text}>
        {text.emailOpened}{" "}
        <a href={mailto} data-testid="report-mailto">
          {REPORT_EMAIL}
        </a>
        .
      </p>
      <pre
        className={`${styles.preview} ${styles.previewOn}`}
        data-testid="email-diagnostics"
        aria-label={text.diagnosticsInEmail}
      >
        {formatDiagnostics(diagnostics)}
      </pre>

      <div className={styles.section}>
        <p className={styles.listTitle}>{text.attachModel}</p>
        <p className={styles.text}>{text.downloadToAttach}</p>
        <ul className={styles.contents} data-testid="report-contents">
          <li>{text.containsAnalysis}</li>
          <li>{hasCad ? text.containsCad : text.noCad}</li>
          <li>{text.containsVersions}</li>
        </ul>
        {zip.phase === "idle" && zip.error && (
          <p className={styles.error} role="alert" data-testid="report-error">
            {zip.error}
          </p>
        )}
        {zip.phase === "saved" && (
          <p className={styles.text} data-testid="report-saved">
            {text.savedBefore} <strong>{zip.fileName}</strong> {text.savedAfter}
          </p>
        )}
        <div className={styles.actions}>
          {hasCad && (
            <button
              type="button"
              className={styles.secondary}
              disabled={zip.phase === "saving"}
              data-testid="report-without-cad"
              onClick={() => download(false)}
            >
              {text.withoutCad}
            </button>
          )}
          <button
            type="button"
            className={styles.secondary}
            disabled={zip.phase === "saving"}
            data-testid="report-download"
            onClick={() => download(hasCad)}
          >
            {zip.phase === "saving" ? text.saving : text.downloadReport}
          </button>
        </div>
      </div>

      <div className={`${styles.actions} ${styles.footer}`}>
        <button type="button" className={styles.secondary} onClick={onBack}>
          {text.back}
        </button>
        <button type="button" className={styles.primary} onClick={onDone}>
          {text.done}
        </button>
      </div>
    </div>
  );
}

function GitHubStep({
  diagnostics,
  onBack,
  onContinue,
}: {
  diagnostics: Diagnostics;
  onBack: () => void;
  onContinue: () => void;
}) {
  const [kind, setKind] = useState<FeedbackKind>("problem");
  // Opt-in: a GitHub report is a public issue, so diagnostics go in only when
  // the user ticks the box after reading them. The feature form has no field
  // for them.
  const [include, setInclude] = useState(false);
  const text = useT(feedbackMessages);
  const url = feedbackIssueUrl(
    kind,
    kind === "problem" && include ? diagnostics : null,
  );

  return (
    <div data-testid="feedback-github">
      <p className={styles.text}>{text.publicIssue}</p>
      <fieldset className={styles.kind}>
        <legend className={styles.listTitle}>{text.whatIsIt}</legend>
        <label className={styles.optIn}>
          <input
            type="radio"
            name="feedback-kind"
            checked={kind === "problem"}
            onChange={() => setKind("problem")}
          />
          {text.aProblem}
        </label>
        <label className={styles.optIn}>
          <input
            type="radio"
            name="feedback-kind"
            checked={kind === "improvement"}
            onChange={() => setKind("improvement")}
          />
          {text.anIdea}
        </label>
      </fieldset>
      {kind === "problem" && (
        <>
          <label className={styles.optIn}>
            <input
              type="checkbox"
              checked={include}
              onChange={(e) => setInclude(e.target.checked)}
              data-testid="feedback-include"
            />
            {text.includeDiagnostics}
          </label>
          <pre
            className={`${styles.preview} ${include ? styles.previewOn : ""}`}
            data-testid="feedback-diagnostics"
            aria-label={text.diagnosticsPreview}
          >
            {formatDiagnostics(diagnostics)}
          </pre>
        </>
      )}
      <div className={`${styles.actions} ${styles.footer}`}>
        <button type="button" className={styles.secondary} onClick={onBack}>
          {text.back}
        </button>
        <a
          className={styles.primary}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="feedback-continue"
          onClick={() => {
            track("feedback_github_opened", {});
            onContinue();
          }}
        >
          {text.continueGithub}
        </a>
      </div>
    </div>
  );
}

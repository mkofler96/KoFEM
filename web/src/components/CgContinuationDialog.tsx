// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useCgContinuation, type CgPrompt } from "../workers/cgContinuation";
import { useIntlTag, useT } from "../i18n/useLocale";
import { dialogMessages } from "../i18n/messages/dialogs";
import styles from "./CgContinuationDialog.module.css";

export function CgContinuationDialog() {
  const prompt = useCgContinuation((state) => state.prompt);
  return prompt ? (
    <ContinuationPrompt key={prompt.progress.iterations} prompt={prompt} />
  ) : null;
}

function ContinuationPrompt({ prompt }: { prompt: CgPrompt }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const text = useT(dialogMessages);
  const intl = useIntlTag();
  const [extra, setExtra] = useState(
    String(prompt.progress.suggestedIterations),
  );
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) throw new Error("Solver continuation dialog did not mount");
    if (!dialog.open) dialog.showModal();
  }, []);
  const { progress, respond } = prompt;
  const iterations = Number(extra);
  const valid =
    Number.isSafeInteger(iterations) &&
    iterations >= 1 &&
    iterations <= 1_000_000;
  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="cg-limit-title"
      aria-describedby="cg-limit-description"
      onCancel={(event) => {
        event.preventDefault();
        respond(0);
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) respond(iterations);
        }}
      >
        <h2 id="cg-limit-title">{text.keepSolving}</h2>
        <p id="cg-limit-description">{text.limitReached}</p>
        <p className={styles.stats}>
          {text.iterationsSolving(
            progress.iterations.toLocaleString(intl),
            (progress.elapsedSeconds / 60).toFixed(1),
          )}
          <br />
          {text.residual(
            progress.relativeResidual.toExponential(2),
            progress.target.toExponential(1),
          )}
        </p>
        <label className={styles.input}>
          {text.extraIterations}
          <input
            type="number"
            min="1"
            max="1000000"
            step="1"
            required
            value={extra}
            onChange={(event) => setExtra(event.target.value)}
          />
        </label>
        <div className={styles.actions}>
          <button type="button" onClick={() => respond(0)}>
            {text.stop}
          </button>
          <button type="submit" disabled={!valid} className={styles.continue}>
            {text.continue}
          </button>
        </div>
      </form>
    </dialog>
  );
}

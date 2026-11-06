// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useCgContinuation, type CgPrompt } from "../workers/cgContinuation";
import styles from "./CgContinuationDialog.module.css";

export function CgContinuationDialog() {
  const prompt = useCgContinuation((state) => state.prompt);
  return prompt ? (
    <ContinuationPrompt key={prompt.progress.iterations} prompt={prompt} />
  ) : null;
}

function ContinuationPrompt({ prompt }: { prompt: CgPrompt }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
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
        <h2 id="cg-limit-title">Keep solving?</h2>
        <p id="cg-limit-description">
          The iteration limit was reached, but the residual is still falling.
          Continue from the current solution or stop and discard it.
        </p>
        <p className={styles.stats}>
          {progress.iterations.toLocaleString()} iterations ·{" "}
          {(progress.elapsedSeconds / 60).toFixed(1)} min solving
          <br />
          Relative residual {progress.relativeResidual.toExponential(2)} ·
          target {progress.target.toExponential(1)}
        </p>
        <label className={styles.input}>
          Extra iterations
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
            Stop
          </button>
          <button type="submit" disabled={!valid} className={styles.continue}>
            Continue
          </button>
        </div>
      </form>
    </dialog>
  );
}

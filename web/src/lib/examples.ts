// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { create } from "zustand";
import { useModelStore } from "../store/modelStore";
import { parseAnalysisFile } from "./analysisFile";
import { categorizeError, setWorkflow, startTimer, track } from "./analytics";
import { clearWorkerLogs } from "../hooks/useWorkerLogs";

// Opening an example (examples/gallery/site/, served at /examples/) in the
// app, from the `/app/?example=<id>` deep-link the example pages' "Open in
// KoFEM" links use.

const EXAMPLE_ID_PATTERN = /^[\w-]+$/;

export function isExampleId(id: string): boolean {
  return EXAMPLE_ID_PATTERN.test(id);
}

// The example being fetched, so the empty viewport does not offer the sample
// meanwhile.
export const useExampleLoad = create<{ loading: string | null }>(() => ({
  loading: null,
}));

// Fetches and loads the example; a failure is reported to the user. Aborting
// the signal drops the result of a load that is no longer wanted (an effect
// cleanup), without clearing the loading state a newer load set.
export async function openExample(
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!isExampleId(id)) throw new Error(`Invalid example id: "${id}"`);
  useExampleLoad.setState({ loading: id });
  const elapsed = startTimer();
  try {
    const res = await fetch(`/examples/${id}.vtu`);
    if (!res.ok) throw new Error(`example "${id}" returned HTTP ${res.status}`);
    const text = await res.text();
    if (signal?.aborted) return;
    const store = useModelStore.getState();
    store.loadAnalysis(parseAnalysisFile(text));
    clearWorkerLogs();
    setWorkflow("example");
    track("example_loaded", {
      example_id: id,
      duration_bucket: elapsed(),
    });

    // A saved .vtu carries no STEP, so loadAnalysis drops stepBytes and the
    // loaded model can't be re-meshed. An example built from a STEP file ships
    // <id>.model.step: the geometry its CAD face ids refer to, i.e. the
    // imported file after any splits (examples/validation/lib/model-step.mjs).
    // Restoring that one, not the <id>.step the page offers for import, lets a
    // re-mesh carry every support and load onto the same CAD faces. Examples
    // still built from a structured mesh (KOF-322) have none: a 404 (or
    // dev-server SPA fallback to index.html) fails the ISO-10303-21 header
    // check and the model simply stays non-re-meshable.
    const stepRes = await fetch(`/examples/${id}.model.step`);
    if (signal?.aborted || !stepRes.ok) return;
    const buf = await stepRes.arrayBuffer();
    const head = new TextDecoder().decode(buf.slice(0, 16));
    if (!signal?.aborted && head.startsWith("ISO-10303-21")) {
      store.setGeometryFormat("step");
      store.setStepBytes(new Uint8Array(buf));
    }
  } catch (err) {
    window.alert(`Could not load example: ${(err as Error).message}`);
    track("example_load_failed", {
      example_id: id,
      error_category: categorizeError(err),
    });
  } finally {
    if (!signal?.aborted) useExampleLoad.setState({ loading: null });
  }
}

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
    const analysis = parseAnalysisFile(await res.text());
    if (signal?.aborted) return;
    // Every example is built from a STEP file a user can import (KOF-322). A
    // model without its geometry shows no body and cannot be re-meshed or
    // changed, so it is refused rather than opened half-usable. A missing
    // file, or the dev server's SPA fallback to index.html, fails here.
    //
    // The app restores <id>.model.step, not the <id>.step the page offers for
    // import: it is the imported file after the recipe's splits, the geometry
    // the analysis file's CAD face ids refer to, so a re-mesh carries every
    // support and load onto the same faces (examples/validation/lib/model-step.mjs).
    if (analysis.stepSurface === null)
      throw new Error(`example "${id}" carries no geometry to mesh on`);
    const stepRes = await fetch(`/examples/${id}.model.step`);
    if (!stepRes.ok)
      throw new Error(
        `example "${id}" ships no geometry: ${id}.model.step returned HTTP ${stepRes.status}`,
      );
    const stepBytes = new Uint8Array(await stepRes.arrayBuffer());
    if (
      !new TextDecoder()
        .decode(stepBytes.slice(0, 16))
        .startsWith("ISO-10303-21")
    )
      throw new Error(
        `example "${id}" ships no geometry: ${id}.model.step is not a STEP file`,
      );
    if (signal?.aborted) return;

    // A saved .vtu carries the tessellation but not the STEP file, so
    // loadAnalysis drops stepBytes; the example's own file restores it.
    const store = useModelStore.getState();
    store.loadAnalysis(analysis);
    store.setGeometryFormat("step");
    store.setStepBytes(stepBytes);
    clearWorkerLogs();
    setWorkflow("example");
    track("example_loaded", {
      example_id: id,
      duration_bucket: elapsed(),
    });
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

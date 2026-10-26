// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { create } from "zustand";
import { useModelStore } from "../store/modelStore";
import { parseAnalysisFile } from "./analysisFile";
import { categorizeError, setWorkflow, startTimer, track } from "./analytics";

// Opening a gallery example (examples/gallery/site/, served at /examples/) in
// the app: from the `/app/?example=<id>` deep-link the gallery's "Open in KoFEM
// web" buttons use, and from the empty workspace's "Try a sample simulation".

// The example a first-time user is offered (KOF-261): it opens with geometry,
// mesh, support and load in place, on the static study, ready to run, and
// carries a hand check for its result.
export const SAMPLE_EXAMPLE_ID = "cantilever-beam";

const EXAMPLE_ID_PATTERN = /^[\w-]+$/;

export function isExampleId(id: string): boolean {
  return EXAMPLE_ID_PATTERN.test(id);
}

// The example being fetched, so the empty viewport does not offer another.
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
    setWorkflow("example");
    track("example_loaded", {
      example_id: id,
      duration_bucket: elapsed(),
    });

    // A saved .vtu carries no STEP, so loadAnalysis drops stepBytes and the
    // loaded model can't be re-meshed. Examples that ship their source CAD
    // (e.g. cantilever-beam.step) restore it here so the user can re-mesh and
    // re-solve. Procedurally-generated benchmarks have no .step: a 404 (or
    // dev-server SPA fallback to index.html) fails the ISO-10303-21 header
    // check and the model simply stays non-re-meshable.
    const stepRes = await fetch(`/examples/${id}.step`);
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

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { TopBar } from "./components/topbar/TopBar";
import { Sidebar } from "./components/panel/Sidebar";
import { ModelTree } from "./components/panel/ModelTree";
import { useTreeSelectionSync } from "./components/panel/modelTreeItems";
import { Viewport } from "./components/viewport/Viewport";
import { StatusBar } from "./components/statusbar/StatusBar";
import { useModelStore } from "./store/modelStore";
import { SMALL_SCREEN_QUERY } from "./store/viewSlice";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { parseAnalysisFile } from "./lib/analysisFile";
import {
  categorizeError,
  currentWorkflow,
  durationBucket,
  setWorkflow,
  startTimer,
  track,
  trackOnce,
} from "./lib/analytics";
import styles from "./App.module.css";

// `/app/?example=<id>` loads a pre-solved example shipped in examples/gallery/site/.
// This is the target of the "Open in KoFEM web" buttons on the examples gallery.
function useExampleFromUrl() {
  const loadAnalysis = useModelStore((s) => s.loadAnalysis);
  const setStepBytes = useModelStore((s) => s.setStepBytes);
  const setGeometryFormat = useModelStore((s) => s.setGeometryFormat);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("example");
    if (!id) return;
    if (!/^[\w-]+$/.test(id)) {
      window.alert(`Invalid example id: "${id}"`);
      return;
    }
    let cancelled = false;
    (async () => {
      const elapsed = startTimer();
      try {
        const res = await fetch(`/examples/${id}.vtu`);
        if (!res.ok)
          throw new Error(`example "${id}" returned HTTP ${res.status}`);
        if (cancelled) return;
        loadAnalysis(parseAnalysisFile(await res.text()));
        setWorkflow("example");
        track("example_loaded", {
          example_id: id,
          duration_bucket: elapsed(),
        });

        // A saved .vtu carries no STEP, so loadAnalysis drops stepBytes and the
        // loaded model can't be re-meshed. Examples that ship their source CAD
        // (e.g. mbb-beam-topopt.step) restore it here so the user can re-mesh
        // and re-solve. Procedurally-generated benchmarks have no .step: a 404
        // (or dev-server SPA fallback to index.html) fails the ISO-10303-21
        // header check and the model simply stays non-re-meshable.
        const stepRes = await fetch(`/examples/${id}.step`);
        if (cancelled || !stepRes.ok) return;
        const buf = await stepRes.arrayBuffer();
        const head = new TextDecoder().decode(buf.slice(0, 16));
        if (!cancelled && head.startsWith("ISO-10303-21")) {
          setGeometryFormat("step");
          setStepBytes(new Uint8Array(buf));
        }
      } catch (err) {
        window.alert(`Could not load example: ${(err as Error).message}`);
        track("example_load_failed", {
          example_id: id,
          error_category: categorizeError(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAnalysis, setStepBytes, setGeometryFormat]);
}

// The funnel's ends: the app opening, and each arrival in the results view
// (from a solve, an optimization, or a pre-solved example or saved file).
function useWorkflowAnalytics() {
  useEffect(() => {
    // performance.now() counts from navigation start: the time until the
    // workspace is on screen and usable.
    trackOnce("solver_opened", {
      entry: new URLSearchParams(window.location.search).has("example")
        ? "example"
        : "direct",
      duration_bucket: durationBucket(performance.now()),
    });
  }, []);
  const inResults = useModelStore(
    (s) => s.mode === "results" && (!!s.result || !!s.densityResult),
  );
  useEffect(() => {
    if (inResults) track("results_viewed", { workflow: currentWorkflow() });
  }, [inResults]);
}

function Workspace() {
  useWorkflowAnalytics();
  useExampleFromUrl();
  useTreeSelectionSync();
  // Model tree left, viewport centre, properties right. Small screens have no
  // room for the tree column; the properties drawer carries it instead.
  const small = useMediaQuery(SMALL_SCREEN_QUERY);
  return (
    <div className={styles.layout}>
      <TopBar />
      <div className={styles.main}>
        {!small && (
          <div className={styles.treeColumn}>
            <ModelTree />
          </div>
        )}
        <main className={styles.viewport}>
          <Viewport />
        </main>
        <Sidebar />
      </div>
      <StatusBar />
    </div>
  );
}

// The solver app is mounted at /app/ (see app/index.html + vite.config.ts).
// The marketing landing at "/" is a separate static HTML page.
export default function App() {
  return (
    <BrowserRouter basename="/app">
      <Routes>
        <Route path="/" element={<Workspace />} />
      </Routes>
    </BrowserRouter>
  );
}

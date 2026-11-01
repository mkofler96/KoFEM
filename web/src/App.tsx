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
import { isExampleId, openExample } from "./lib/examples";
import {
  currentWorkflow,
  durationBucket,
  track,
  trackOnce,
} from "./lib/analytics";
import styles from "./App.module.css";

// `/app/?example=<id>` loads an example shipped in examples/gallery/site/.
// This is the target of the "Open in KoFEM" links on the example pages.
function useExampleFromUrl() {
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("example");
    const controller = new AbortController();
    if (id && !isExampleId(id)) window.alert(`Invalid example id: "${id}"`);
    else if (id) openExample(id, controller.signal);
    return () => controller.abort();
  }, []);
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
    (s) =>
      s.mode === "results" && (Boolean(s.result) || Boolean(s.densityResult)),
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

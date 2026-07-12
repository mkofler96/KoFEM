// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { TopBar } from "./components/topbar/TopBar";
import { Sidebar } from "./components/panel/Sidebar";
import { Viewport } from "./components/viewport/Viewport";
import { StatusBar } from "./components/statusbar/StatusBar";
import { useModelStore } from "./store/modelStore";
import { parseAnalysisFile } from "./lib/analysisFile";
import styles from "./App.module.css";

// `/app/?example=<id>` loads a pre-solved example shipped in public/examples/.
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
      try {
        const res = await fetch(`/examples/${id}.vtu`);
        if (!res.ok)
          throw new Error(`example "${id}" returned HTTP ${res.status}`);
        if (cancelled) return;
        loadAnalysis(parseAnalysisFile(await res.text()));

        // A saved .vtu carries no STEP, so loadAnalysis drops stepBytes and the
        // loaded model can't be re-meshed. Examples that ship their source CAD
        // (e.g. crane-hook-shell.step) restore it here so the user can re-mesh
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
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAnalysis, setStepBytes, setGeometryFormat]);
}

function Workspace() {
  useExampleFromUrl();
  return (
    <div className={styles.layout}>
      <TopBar />
      <div className={styles.main}>
        <Sidebar />
        <main className={styles.viewport}>
          <Viewport />
        </main>
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

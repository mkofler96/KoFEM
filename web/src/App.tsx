import { useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { TopBar } from "./components/topbar/TopBar";
import { LeftPanel } from "./components/panel/LeftPanel";
import { Viewport } from "./components/viewport/Viewport";
import { StatusBar } from "./components/statusbar/StatusBar";
import { useModelStore } from "./store/modelStore";
import { parseAnalysisFile } from "./lib/analysisFile";
import styles from "./App.module.css";

// `/app/?example=<id>` loads a pre-solved example shipped in public/examples/.
// This is the target of the "Open in KoFEM web" buttons on the examples gallery.
function useExampleFromUrl() {
  const loadAnalysis = useModelStore((s) => s.loadAnalysis);
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
        if (!cancelled) loadAnalysis(parseAnalysisFile(await res.text()));
      } catch (err) {
        window.alert(`Could not load example: ${(err as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAnalysis]);
}

function Workspace() {
  useExampleFromUrl();
  return (
    <div className={styles.layout}>
      <TopBar />
      <LeftPanel />
      <main className={styles.viewport}>
        <Viewport />
      </main>
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

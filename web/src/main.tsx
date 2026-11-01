// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import {
  sendToWorker,
  resetWorker,
  setProgressCallback,
  startEngine,
} from "./workers/sharedWorker";

// Exposed for Playwright tests — not part of the public API.
(
  window as Window & {
    __kofem?: {
      sendToWorker: typeof sendToWorker;
      resetWorker: typeof resetWorker;
      setProgressCallback: typeof setProgressCallback;
    };
  }
).__kofem = { sendToWorker, resetWorker, setProgressCallback };

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Every workflow but viewing a pre-solved example needs the engine. Loading it
// now overlaps its download with the visitor picking a file; on first request
// the whole wait came after the pick (KOF-263).
startEngine();

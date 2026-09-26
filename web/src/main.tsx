// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import {
  sendToWorker,
  resetWorker,
  setProgressCallback,
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

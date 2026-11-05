// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { create } from "zustand";
import type { CgLimitProgress } from "../wasm/pkg/kofem_wasm.js";

export interface CgPrompt {
  progress: CgLimitProgress;
  respond: (extraIterations: number) => void;
}

export const useCgContinuation = create<{ prompt: CgPrompt | null }>(() => ({
  prompt: null,
}));

export function dismissCgContinuation() {
  useCgContinuation.getState().prompt?.respond(0);
}

export function askCgContinuation(progress: CgLimitProgress): Promise<number> {
  if (useCgContinuation.getState().prompt)
    return Promise.reject(
      new Error("A solver continuation is already pending"),
    );
  return new Promise((resolve) => {
    const prompt: CgPrompt = {
      progress,
      respond(extraIterations) {
        if (useCgContinuation.getState().prompt !== prompt) return;
        if (
          !Number.isSafeInteger(extraIterations) ||
          extraIterations < 0 ||
          extraIterations > 1_000_000
        )
          throw new Error(
            "Extra iterations must be an integer from 1 to 1000000",
          );
        useCgContinuation.setState({ prompt: null });
        resolve(extraIterations);
      },
    };
    useCgContinuation.setState({ prompt });
  });
}

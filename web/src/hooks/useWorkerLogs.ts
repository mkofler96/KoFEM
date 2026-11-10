// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";
import { setLogCallback } from "../workers/sharedWorker";

export type LogChannel = "mesh" | "solve" | "optimize";

// A worker log line with a monotonically increasing id, so log lists can use
// a stable React key even though the text itself may repeat.
export interface WorkerLogEntry {
  id: number;
  text: string;
}

// Log lines live in a store keyed by channel rather than in component state,
// so a panel's log survives unmounting: after a successful solve the app
// switches to Results, and switching back to the Solve tab must still show
// the solve log. Each channel keeps its own history — the mesh log and the
// solve log don't overwrite each other.
interface WorkerLogState {
  channels: Record<string, WorkerLogEntry[]>;
  nextId: number;
  append: (channel: string, text: string) => void;
  clear: (channel: string) => void;
}

const useWorkerLogStore = create<WorkerLogState>((set) => ({
  channels: {},
  nextId: 0,
  append: (channel, text) =>
    set((s) => ({
      channels: {
        ...s.channels,
        [channel]: [...(s.channels[channel] ?? []), { id: s.nextId, text }],
      },
      nextId: s.nextId + 1,
    })),
  clear: (channel) =>
    set((s) => ({ channels: { ...s.channels, [channel]: [] } })),
}));

// Stable empty result for channels that have no lines yet — a fresh [] per
// selector call would change identity on every store update and re-render
// (or loop) subscribers.
const NO_LOGS: WorkerLogEntry[] = [];

// Collects the shared worker's log stream (WASM stdout/stderr plus the
// worker's own status lines) into the given channel for display in a log
// panel. PropertiesPanel mounts one step panel at a time, so the sharedWorker's
// single log-callback slot always belongs to whichever panel is active — the
// mesh log while meshing on the Geometry tab, the solver log while solving on
// the Solve tab, the optimizer log while optimizing on the Optimize tab.
export function useWorkerLogs(channel: LogChannel) {
  const logs = useWorkerLogStore((s) => s.channels[channel] ?? NO_LOGS);
  const append = useWorkerLogStore((s) => s.append);
  const clear = useWorkerLogStore((s) => s.clear);

  useEffect(() => {
    setLogCallback((msg) => append(channel, msg));
    return () => setLogCallback(null);
  }, [channel, append]);

  const clearLogs = useCallback(() => clear(channel), [channel, clear]);

  return { logs, clearLogs };
}

export const LOG_CHANNEL_LABELS: Record<LogChannel, string> = {
  mesh: "Mesh",
  solve: "Solve",
  optimize: "Optimize",
};

export interface TaggedLogEntry extends WorkerLogEntry {
  channel: LogChannel;
}

// All channels merged into one chronological stream (ids increase across
// channels), for the log drawer.
export function mergeChannels(
  channels: Record<string, WorkerLogEntry[]>,
): TaggedLogEntry[] {
  const merged: TaggedLogEntry[] = [];
  for (const channel of Object.keys(LOG_CHANNEL_LABELS) as LogChannel[]) {
    for (const entry of channels[channel] ?? NO_LOGS) {
      merged.push({ ...entry, channel });
    }
  }
  return merged.sort((a, b) => a.id - b.id);
}

// Whether the right-hand log drawer is open. Hidden by default.
interface LogDrawerState {
  open: boolean;
  // Lines with an id below this are hidden (drawer "Clear").
  clearedBefore: number;
  toggle: () => void;
}

export const useLogDrawer = create<LogDrawerState>((set) => ({
  open: false,
  clearedBefore: 0,
  toggle: () => set((s) => ({ open: !s.open })),
}));

// "Clear" in the drawer only hides what is shown so far: the channels keep
// their lines, because the optimizer's convergence plot is derived from them.
export function useAllLogs() {
  const channels = useWorkerLogStore((s) => s.channels);
  const clearedBefore = useLogDrawer((s) => s.clearedBefore);
  return useMemo(
    () => mergeChannels(channels).filter((e) => e.id >= clearedBefore),
    [channels, clearedBefore],
  );
}

export function clearAllLogs() {
  useLogDrawer.setState({ clearedBefore: useWorkerLogStore.getState().nextId });
}

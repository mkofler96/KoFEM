// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Whether the Rust finite-element module is loaded on this thread, loading it
// on first use (lib/femModule). The viewport needs it to find what of a mesh
// to draw (lib/meshOutline); every caller shares one load.

import { useEffect, useState } from "react";
import { loadFemModule } from "../lib/femModule";

export interface FemModuleState {
  ready: boolean;
  // The load failure, for the user; null while loading or once loaded.
  error: string | null;
}

export function useFemModule(): FemModuleState {
  const [state, setState] = useState<FemModuleState>({
    ready: false,
    error: null,
  });
  useEffect(() => {
    let live = true;
    loadFemModule().then(
      () => live && setState({ ready: true, error: null }),
      (error: unknown) =>
        live &&
        setState({
          ready: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}

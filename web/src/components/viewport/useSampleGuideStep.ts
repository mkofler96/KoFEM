// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from "react";
import { useModelStore } from "../../store/modelStore";
import {
  dismissSampleGuide,
  guideStep,
  useSampleGuide,
  type GuideStep,
} from "../../lib/sampleGuide";

// The sample guide's current step, or null when there is no guide: the
// workspace is not the sample's, or the user closed it.
export function useSampleGuideStep(): GuideStep | null {
  const geometry = useSampleGuide((s) => s.geometry);
  const stepSurface = useModelStore((s) => s.stepSurface);
  const meshed = useModelStore((s) => s.nodes.length > 0);
  const bcGroups = useModelStore((s) => s.bcGroups);
  const loadGroups = useModelStore((s) => s.loadGroups);
  const solved = useModelStore((s) => s.result !== null);
  const ours = geometry !== null && geometry === stepSurface;

  // Other geometry replaced the sample's: the guide is over.
  useEffect(() => {
    if (geometry !== null && !ours) dismissSampleGuide();
  }, [geometry, ours]);

  if (!ours) return null;
  return guideStep({ meshed, bcGroups, loadGroups, solved });
}

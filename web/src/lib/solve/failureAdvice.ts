// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What the user should change after a failed solve (KOF-490): the solver's
// own words say what went wrong, the advice for a numerical failure what to
// do about it.

import type { FailureClass, NumericalReason } from "../analytics";
import { tr } from "../../i18n/useLocale";
import { solveMessages } from "../../i18n/messages/solve";

/** A failure as a panel shows it. */
export interface FailureNotice {
  advice: string | null;
  detail: string;
}

/** The notice for `failure`, whose solver's words are `detail`. */
export function failureNotice(
  failure: FailureClass,
  detail: string,
): FailureNotice {
  if (failure.error_category !== "numerical_failure")
    return { advice: null, detail };
  const text = tr(solveMessages);
  const advice: Record<NumericalReason, string> = {
    singular_matrix: text.adviceSingularMatrix,
    not_converged: text.adviceNotConverged,
    newton_not_converged: text.adviceNewtonNotConverged,
    unstable_tangent: text.adviceUnstableTangent,
    inverted_element: text.adviceInvertedElement,
    non_finite_result: text.adviceNonFiniteResult,
  };
  return { advice: advice[failure.numerical_reason], detail };
}

/** A failure with no advice: only its words. */
export function plainNotice(detail: string): FailureNotice {
  return { advice: null, detail };
}

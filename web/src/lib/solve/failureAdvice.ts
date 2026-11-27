// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What the user should change after a failed solve (KOF-490). The solver's own
// words say what went wrong, in its terms; for a numerical failure the reason
// it knows (lib/analytics.ts) also says what to do about it.

import type { FailureClass } from "../analytics";
import { tr } from "../../i18n/useLocale";
import { solveMessages } from "../../i18n/messages/solve";

/** The advice for a failure, or null when the solver's words are all there is. */
export function failureAdvice(failure: FailureClass): string | null {
  if (failure.error_category !== "numerical_failure") return null;
  const text = tr(solveMessages);
  const reason = failure.numerical_reason;
  switch (reason) {
    case "singular_matrix":
      return text.adviceSingularMatrix;
    case "not_converged":
      return text.adviceNotConverged;
    case "newton_not_converged":
      return text.adviceNewtonNotConverged;
    case "unstable_tangent":
      return text.adviceUnstableTangent;
    case "inverted_element":
      return text.adviceInvertedElement;
    case "non_finite_result":
      return text.adviceNonFiniteResult;
    default: {
      const unhandled: never = reason;
      throw new Error(`failureAdvice: unhandled reason ${String(unhandled)}`);
    }
  }
}

/** The error a panel shows: the advice, when there is one, above `error`. */
export function withAdvice(failure: FailureClass, error: string): string {
  const advice = failureAdvice(failure);
  return advice === null ? error : `${advice}\n${error}`;
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The solve message's optional fields with a documented meaning when absent.
// Each is read here and nowhere else, so the meaning is decided once.

import type { Constraint, SolveModel } from "../../workers/solverTypes.js";

export function prescribedValueOf(
  constraint: Pick<Constraint, "prescribedValue">,
): number {
  // eslint-disable-next-line kofem/no-silent-fallback -- a constraint without prescribedValue is a fixed BC: u = 0
  return constraint.prescribedValue ?? 0;
}

export function elementOrderOf(
  model: Pick<SolveModel, "elementOrder">,
): number {
  // eslint-disable-next-line kofem/no-silent-fallback -- a solve message without elementOrder asks for linear elements
  return model.elementOrder ?? 1;
}

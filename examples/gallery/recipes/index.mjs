// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The recipes of the showcase examples (KOF-322), by example id: the GUI steps
// that rebuild each from its STEP file (examples/validation/lib/recipe.mjs).
// A showcase's generator builds it from this recipe; the rule check
// (examples/validation/rules.mjs), the example page and the GUI test
// (web/tests/examples-by-hand.spec.ts) read it from here. Validation cases
// carry their recipe in their case module instead.

import { validateRecipe } from "../../validation/lib/recipe.mjs";
import mbbBeamTopopt from "./mbb-beam-topopt.mjs";

const recipes = {
  "mbb-beam-topopt": mbbBeamTopopt,
};

for (const [id, recipe] of Object.entries(recipes)) validateRecipe(id, recipe);

export default recipes;

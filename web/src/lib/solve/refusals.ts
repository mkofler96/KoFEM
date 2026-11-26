// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What a solve path cannot apply yet, in words for the user (KOF-353). A path
// that cannot honour a tie or an element order refuses the model by name rather
// than solve a different model; the panels show the same words before the run.

import type { TieDefinition } from "../tie.js";
import type { ContactDefinition } from "../contact.js";
import type { Element, SurfaceLoad } from "../../workers/solverTypes.js";
import { faceKey, loadableFaceKeys } from "../../store/boundaryRebuild.js";
import { tr } from "../../i18n/useLocale.js";
import { refusalMessages } from "../../i18n/messages/refusals.js";

// `tie "Tie1"`, or `2 ties ("Tie1", "Pin")`.
function namedTies(ties: TieDefinition[]): string {
  const text = tr(refusalMessages);
  return ties.length === 1
    ? text.namedTie(ties[0].name)
    : text.namedTies(
        ties.length,
        ties.map((tie) => `"${tie.name}"`).join(", "),
      );
}

// `contact "Contact1"`, or `2 contacts ("Contact1", "Lock")`.
function namedContacts(contacts: ContactDefinition[]): string {
  const text = tr(refusalMessages);
  return contacts.length === 1
    ? text.namedContact(contacts[0].name)
    : text.namedContacts(
        contacts.length,
        contacts.map((contact) => `"${contact.name}"`).join(", "),
      );
}

// Contact is solved by the solid solve on linear elements only (KOF-485): its
// mortar integrals are taken over linear faces, and neither the shell nor the
// coupled assembler carries its constraints. Null when the route and the
// element order take the model's contacts.
export function contactRefusal(
  contacts: ContactDefinition[] | undefined,
  path: "solid" | "shell" | "coupled" | "auto-shell",
  elementOrder: number,
): string | null {
  if (!contacts || contacts.length === 0) return null;
  const text = tr(refusalMessages);
  if (path !== "solid")
    return text.contactNotSolid(namedContacts(contacts), contacts.length);
  if (elementOrder !== 1)
    return text.contactOrder(namedContacts(contacts), elementOrder);
  return null;
}

// The topology optimizer solves no contact.
export function topOptContactRefusal(
  contacts: ContactDefinition[] | undefined,
): string | null {
  if (!contacts || contacts.length === 0) return null;
  return tr(refusalMessages).topOptContacts(
    namedContacts(contacts),
    contacts.length,
  );
}

// The topology optimizer applies no tie in any design domain: a tied assembly
// would be optimized as separate, disconnected parts.
export function topOptTieRefusal(
  ties: TieDefinition[] | undefined,
): string | null {
  if (!ties || ties.length === 0) return null;
  return tr(refusalMessages).topOptTies(namedTies(ties), ties.length);
}

// The Kirchhoff shell solver applies no tie: shell-to-shell ties need
// rotations and a mid-surface mapping of the picked faces.
export function shellTieRefusal(
  ties: TieDefinition[] | undefined,
): string | null {
  if (!ties || ties.length === 0) return null;
  return tr(refusalMessages).shellTies(namedTies(ties), ties.length);
}

// Shell (DKT) facets are linear, and so are the tetrahedra the mixed
// shell/solid assembler couples to them.
export function shellOrderRefusal(elementOrder: number): string | null {
  if (elementOrder === 1) return null;
  return tr(refusalMessages).shellOrder(elementOrder);
}

// A coupling is an RBE2/RBE3 constraint, and only the coupled assembler applies
// one — the pure Kirchhoff shell solver has no couplings, and the coupled
// assembler needs a solid domain to assemble. An all-shell model therefore
// cannot carry a coupling, in the solve or the optimizer.
export function shellCouplingRefusal(couplingCount: number): string {
  return tr(refusalMessages).shellCoupling(couplingCount);
}

// A solid model the Rust solver does not take (amgUnavailableReason). The C++
// solvers that once took these left the engine (KOF-309).
export function solidModelRefusal(reason: string): string {
  return tr(refusalMessages).solidModel(reason);
}

// A surface load the solve cannot apply in full (KOF-411): a selection that
// spans no face of the mesh, or a face that is not on the mesh boundary (nor
// a shell facet or a shell edge). Applying the rest would put a total force
// on a smaller area than the user picked, or drop the load, while the result
// looks plausible. Every solve path and the optimizer route through here, so
// none can apply such a load (routeSolve, routeTopOpt).
//
// Checked on the store payload rather than in the Rust module: the Solve
// panel runs this routing on the main thread, which does not load the Rust
// module, and the shell paths build no solid boundary in Rust at all.
export function surfaceLoadRefusal(
  elements: readonly Element[],
  surfaceLoads: readonly SurfaceLoad[] | undefined,
): string | null {
  if (!surfaceLoads || surfaceLoads.length === 0) return null;
  const loadable = loadableFaceKeys(elements);
  const text = tr(refusalMessages);
  for (const [index, load] of surfaceLoads.entries()) {
    const name =
      load.name !== undefined
        ? text.namedLoad(load.name)
        : text.numberedLoad(index + 1);
    const stale =
      // eslint-disable-next-line kofem/no-silent-fallback -- counted only for loads rebuilt from groups (boundaryRebuild); a load built from faces directly has no selection that can have gone stale
      load.unmatchedSelections !== undefined ? load.unmatchedSelections : 0;
    if (stale === 0 && load.faces.length === 0)
      return text.loadMatchesNoFace(name);
    if (stale > 0)
      return load.faces.length === 0
        ? text.loadStaleNoLoad(name, stale)
        : text.loadStalePartial(name, stale);
    const off = load.faces.filter(
      (face) => !loadable.has(faceKey(face)),
    ).length;
    if (off > 0) return text.loadOffBoundary(name, off, load.faces.length);
  }
  return null;
}

// A temperature change on a model that is not solved on the solid path
// (KOF-449): the shell, coupled and auto-shell solves and the optimizer apply
// no thermal load yet, so they refuse it rather than solve without it.
export function temperatureRefusal(
  where: "shell" | "coupled" | "auto-shell" | "optimization",
): string {
  const text = tr(refusalMessages);
  return where === "optimization"
    ? text.temperatureOptimization
    : where === "shell"
      ? text.temperatureShell
      : where === "coupled"
        ? text.temperatureCoupled
        : text.temperatureAutoShell;
}

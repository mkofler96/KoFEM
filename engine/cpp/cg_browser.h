// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

#ifndef KOFEM_CG_BROWSER_H
#define KOFEM_CG_BROWSER_H

#include "cg_continuation.h"

// WASM-only adapter. The numerical cores and their native tests have no JS
// dependency. Asyncify suspends the existing C++ stack while the worker awaits
// a UI response; no matrices or iteration vectors are rebuilt.
kofem::CgControl browser_cg_control();

#endif

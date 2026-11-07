// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

#ifndef KOFEM_CG_MFEM_H
#define KOFEM_CG_MFEM_H

#include "cg_continuation.h"
#include <mfem.hpp>

namespace kofem {
// Static solid solve: same MFEM CG/Gauss-Seidel and fixed 1e-6 tolerance.
// Throws on non-convergence or user stop; returns total iterations on success.
int solve_mfem_cg(mfem::SparseMatrix& matrix, const mfem::Vector& rhs,
                  mfem::Vector& solution, const CgControl& control = {});
}

#endif

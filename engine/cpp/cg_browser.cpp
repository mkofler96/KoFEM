// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

#include "cg_browser.h"
#include <emscripten.h>

EM_JS(int, initial_cg_iterations, (), {
    const value = Module['cgIterationLimit'];
    if (value === undefined) return 0;
    if (!Number.isSafeInteger(value) || value < 1 || value > 1000000)
        throw new Error('CG iteration limit must be an integer from 1 to 1000000');
    return value;
});

EM_ASYNC_JS(int, ask_cg_limit,
    (int iterations, double residual, double target, double seconds, int suggested), {
    // Asyncify's handleAsync does not resume on a rejected Promise. Return an
    // error sentinel and throw in C++ AFTER restoring the suspended stack.
    try {
        const extra = await Module['onCgLimit']({
            iterations, relativeResidual: residual, target,
            elapsedSeconds: seconds, suggestedIterations: suggested
        });
        if (!Number.isSafeInteger(extra) || extra < 0 || extra > 1000000) return -1;
        return extra;
    } catch (error) {
        console.error('CG continuation request failed:', error);
        return -1;
    }
});

EM_JS(bool, has_cg_callback, (), { return typeof Module['onCgLimit'] === 'function'; });

kofem::CgControl browser_cg_control() {
    kofem::CgControl control;
    control.initial_iterations = initial_cg_iterations();
    if (has_cg_callback())
        control.on_limit = [](const kofem::CgProgress& progress) {
            const int extra = ask_cg_limit(progress.iterations, progress.relative_residual,
                progress.target, progress.elapsed_seconds, progress.suggested_iterations);
            if (extra < 0)
                throw std::runtime_error(
                    "CG continuation failed: expected an integer from 1 to 1000000, "
                    "or zero to stop. The partial result was discarded.");
            return extra;
        };
    return control;
}

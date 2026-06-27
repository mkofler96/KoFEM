// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

#include "wasm_util.h"

#include <emscripten.h>

#include <cstdio>
#include <malloc.h>

using emscripten::val;

// ── Memory diagnostics ────────────────────────────────────────────────────────
// Reports total WASM linear-memory size (grows with ALLOW_MEMORY_GROWTH) and
// the approximate amount of that memory currently in-use by malloc.
void log_mem(const char* label) {
    struct mallinfo mi = mallinfo();
    // HEAP8.length == current WASM linear-memory size in bytes.
    int wasm_mb = EM_ASM_INT({ return HEAP8.length >> 20; });
    // uordblks is bytes allocated by malloc (does not include mmap'd regions).
    int used_mb = (int)((unsigned)mi.uordblks >> 20);
    printf("[mem] %-44s  wasm=%d MB  alloc~%d MB\n", label, wasm_mb, used_mb);
    fflush(stdout);
}

// ── Binary output helpers ─────────────────────────────────────────────────────
// Return tessellation data as JS typed arrays instead of a JSON text string.
// The string path built a multi-MB buffer with ostringstream — formatting every
// coordinate to decimal text — which JS then re-parsed with JSON.parse.  Both are
// O(triangles) and dominated STEP-load time on large parts.  new Float32Array(view)
// copies the WASM-heap view into a JS-owned buffer synchronously (no intervening
// allocation under ALLOW_MEMORY_GROWTH), so the data survives the source vector's
// destruction when the function returns.

val float32_array(const std::vector<float>& v) {
    return val::global("Float32Array")
        .new_(val(emscripten::typed_memory_view(v.size(), v.data())));
}

val uint32_array(const std::vector<uint32_t>& v) {
    return val::global("Uint32Array")
        .new_(val(emscripten::typed_memory_view(v.size(), v.data())));
}

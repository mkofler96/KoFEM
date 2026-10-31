// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

#include "json_util.h"

using emscripten::val;

// ── JSON input helpers (delegate parsing to the JS engine via emscripten::val) ─

val parse_json(const std::string& s) {
    return val::global("JSON").call<val>("parse", s);
}

double jdouble(const val& o, const char* k, double def) {
    val v = o[k];
    return (v.isNull() || v.isUndefined()) ? def : v.as<double>();
}

int jint(const val& o, const char* k, int def) {
    val v = o[k];
    return (v.isNull() || v.isUndefined()) ? def : v.as<int>();
}

bool jbool(const val& o, const char* k, bool def) {
    val v = o[k];
    return (v.isNull() || v.isUndefined()) ? def : v.as<bool>();
}

std::string jstring(const val& o, const char* k, const char* def) {
    val v = o[k];
    return (v.isNull() || v.isUndefined()) ? std::string(def) : v.as<std::string>();
}

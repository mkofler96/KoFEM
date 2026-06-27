// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

#include "json_util.h"

#include <sstream>

using emscripten::val;

// ── Minimal JSON output helpers ───────────────────────────────────────────────
// We build JSON manually to avoid a third-party parser dependency.  The output
// format is machine-generated and tightly controlled so this is safe.

std::string json_vec3(const std::vector<double>& d) {
    std::ostringstream ss;
    ss << '[';
    size_t n = d.size() / 3;
    for (size_t i = 0; i < n; ++i) {
        if (i) ss << ',';
        ss << '[' << d[3*i] << ',' << d[3*i+1] << ',' << d[3*i+2] << ']';
    }
    ss << ']';
    return ss.str();
}

std::string json_ivec3(const std::vector<int>& d) {
    std::ostringstream ss;
    ss << '[';
    size_t n = d.size() / 3;
    for (size_t i = 0; i < n; ++i) {
        if (i) ss << ',';
        ss << '[' << d[3*i] << ',' << d[3*i+1] << ',' << d[3*i+2] << ']';
    }
    ss << ']';
    return ss.str();
}

std::string json_ivec4(const std::vector<int>& d) {
    std::ostringstream ss;
    ss << '[';
    size_t n = d.size() / 4;
    for (size_t i = 0; i < n; ++i) {
        if (i) ss << ',';
        ss << '[' << d[4*i] << ',' << d[4*i+1] << ',' << d[4*i+2] << ',' << d[4*i+3] << ']';
    }
    ss << ']';
    return ss.str();
}

std::string json_ints(const std::vector<int>& d) {
    std::ostringstream ss;
    ss << '[';
    for (size_t i = 0; i < d.size(); ++i) {
        if (i != 0) ss << ',';
        ss << d[i];
    }
    ss << ']';
    return ss.str();
}

std::string json_doubles(const std::vector<double>& d) {
    std::ostringstream ss;
    ss << '[';
    for (size_t i = 0; i < d.size(); ++i) {
        if (i) ss << ',';
        ss << d[i];
    }
    ss << ']';
    return ss.str();
}

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

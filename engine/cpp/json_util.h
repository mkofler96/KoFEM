// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Minimal JSON helpers shared across the engine's pipeline stages.
//
// Output is built manually to avoid a third-party parser dependency — the
// format is machine-generated and tightly controlled so this is safe. Input
// parsing is delegated to the JS engine via emscripten::val.
#pragma once

#include <emscripten/val.h>

#include <string>
#include <vector>

// ── JSON output ───────────────────────────────────────────────────────────────
std::string json_vec3(const std::vector<double>& d);
std::string json_ivec3(const std::vector<int>& d);
std::string json_ivec4(const std::vector<int>& d);
std::string json_ints(const std::vector<int>& d);
std::string json_doubles(const std::vector<double>& d);

// ── JSON input (delegate parsing to the JS engine via emscripten::val) ─────────
emscripten::val parse_json(const std::string& s);
double      jdouble(const emscripten::val& o, const char* k, double def);
int         jint(const emscripten::val& o, const char* k, int def);
bool        jbool(const emscripten::val& o, const char* k, bool def);
std::string jstring(const emscripten::val& o, const char* k, const char* def);

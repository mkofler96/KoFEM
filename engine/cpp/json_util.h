// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Minimal JSON input helpers shared across the engine's pipeline stages.
// Parsing is delegated to the JS engine via emscripten::val, so there is no
// third-party parser dependency.
#pragma once

#include <emscripten/val.h>

#include <string>

// ── JSON input (delegate parsing to the JS engine via emscripten::val) ─────────
emscripten::val parse_json(const std::string& s);
double      jdouble(const emscripten::val& o, const char* k, double def);
int         jint(const emscripten::val& o, const char* k, int def);
bool        jbool(const emscripten::val& o, const char* k, bool def);
std::string jstring(const emscripten::val& o, const char* k, const char* def);

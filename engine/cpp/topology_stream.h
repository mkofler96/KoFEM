// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Per-iteration density streaming for the SIMP loops (KOF-240). This revises
// ADR-0002 decision 1: the loop still runs entirely in C++, but it now hands the
// analysed design ρ to an optional observer every `stream_every` iterations, so
// the viewport can show the shape emerging during the run instead of only at the
// end. JS-free — the Embind entries adapt a JS callback into a DensityCallback
// (topology_stream_js.h).
#pragma once

#include <functional>
#include <stdexcept>
#include <string>
#include <vector>

namespace kofem::topopt {

// Called with the iteration number and the design ρ that iteration analysed (one
// value per design element, the same order as the returned density). Invoked
// synchronously inside the loop; the reference is valid only for the call.
using DensityCallback = std::function<void(int it, const std::vector<double>& rho)>;

// The streaming knobs both optimizer configs carry. An empty callback streams
// nothing. The final iteration is always streamed regardless of `stream_every`,
// so the last streamed field is exactly the returned density.
struct DensityStream {
    DensityCallback on_density;
    int stream_every = 1;

    void validate(const char* who) const {
        if (stream_every <= 0)
            throw std::runtime_error(std::string(who) +
                                     ": stream_every must be a positive integer, got " +
                                     std::to_string(stream_every));
    }

    void emit(int it, bool last, const std::vector<double>& rho) const {
        if (!on_density) return;
        if (last || it % stream_every == 0) on_density(it, rho);
    }
};

}  // namespace kofem::topopt

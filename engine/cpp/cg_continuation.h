// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

#ifndef KOFEM_CG_CONTINUATION_H
#define KOFEM_CG_CONTINUATION_H

#include <algorithm>
#include <chrono>
#include <cmath>
#include <deque>
#include <functional>
#include <limits>
#include <stdexcept>

namespace kofem {

struct CgProgress {
    int iterations;
    double relative_residual;
    double target;
    double elapsed_seconds;
    int suggested_iterations;
};

struct CgControl {
    // Zero selects the solver's usual cap. Useful for callers with a smaller
    // initial budget, and for exercising continuation without a huge model.
    int initial_iterations = 0;
    // Return extra iterations, or zero to stop. Absent means fail at the cap.
    std::function<int(const CgProgress&)> on_limit;
};

// Shared progress policy; neither this class nor the callback owns solver
// vectors. Extending the live loop preserves x, r, p and the preconditioner.
class CgContinuation {
    using Clock = std::chrono::steady_clock;
    CgControl control_;
    int limit_;
    int budget_;
    size_t window_;
    std::deque<double> recent_;
    Clock::time_point started_ = Clock::now();

public:
    CgContinuation(const CgControl& control, int default_limit)
        : control_(control),
          limit_(control.initial_iterations == 0 ? default_limit : control.initial_iterations),
          budget_(limit_), window_(std::min(100, std::max(2, limit_ / 2))) {
        if (limit_ <= 0) throw std::runtime_error("CG iteration limit must be positive");
    }

    int limit() const { return limit_; }

    void observe(double residual) {
        recent_.push_back(residual);
        if (recent_.size() > window_) recent_.pop_front();
    }

    bool extend(int iterations, double residual, double target) {
        if (!control_.on_limit || recent_.size() < window_ ||
            !std::isfinite(residual) || residual <= target)
            return false;
        // CG residuals oscillate. Compare geometric means of the two halves
        // of a recent window, and require the endpoint to fall too. A net
        // improvement since iteration zero alone would offer stalled solves
        // unlimited extensions. A one-part-per-million margin rejects roundoff
        // without excluding slowly converging systems.
        double early = 0.0, late = 0.0;
        const size_t half = recent_.size() / 2;
        for (size_t i = 0; i < recent_.size(); ++i) {
            if (!std::isfinite(recent_[i]) || recent_[i] <= 0.0) return false;
            (i < half ? early : late) += std::log(recent_[i]);
        }
        if (residual >= recent_.front() * 0.999999 ||
            late / static_cast<double>(recent_.size() - half) >=
                early / static_cast<double>(half) + std::log(0.999999))
            return false;
        const auto paused = Clock::now();
        const int extra = control_.on_limit({iterations, residual, target,
            std::chrono::duration<double>(paused - started_).count(), budget_});
        started_ += Clock::now() - paused;  // exclude time waiting for a person
        if (extra == 0)
            throw std::runtime_error("Solve stopped by user. The partial result was discarded.");
        if (extra < 0 || extra > 1000000 || extra > std::numeric_limits<int>::max() - limit_)
            throw std::runtime_error("Extra CG iterations must be an integer from 1 to 1000000");
        budget_ = extra;
        limit_ += extra;
        return true;
    }
};

}  // namespace kofem

#endif

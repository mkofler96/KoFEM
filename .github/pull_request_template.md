## Summary

<!-- What does this PR change, and why? -->

closes #

## Checklist

- [ ] **No silent fallbacks** — no code path in this PR substitutes a plausible default (`x ?? someValue`, `x || someValue`, `parseFloat(x) || n`, empty `catch`, no-op stub) when data is missing, invalid, or mismatched, instead of raising a clear error. Genuinely optional fields carry an `eslint-disable` comment with a justification. See [CONTRIBUTING.md](../CONTRIBUTING.md#no-silent-fallbacks) — this is the most common bug class in this codebase (issue #322).
- [ ] Every input accepted by the UI or an API is actually consumed downstream (no fields that are silently never read — issue #205).
- [ ] Geometry/mesh terminology follows CLAUDE.md: tessellation ≠ surface mesh ≠ volume mesh; "mesh" only refers to FEM data.
- [ ] Rust: `cargo fmt` and `cargo clippy` are clean. TypeScript: `bun run typecheck` and `bun run lint` pass.

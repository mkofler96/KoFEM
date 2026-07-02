## Summary

<!-- What does this PR change, and why? -->

closes #

## Checklist

- [ ] **No silent fallbacks** — no code path in this PR substitutes a plausible default (`x ?? someValue`, `x || someValue`, `parseFloat(x) || n`, empty `catch`, no-op stub) when data is missing, invalid, or mismatched, instead of raising a clear error. Genuinely optional fields carry an `eslint-disable` comment with a justification.
- [ ] Every input accepted by the UI or an API is actually consumed downstream
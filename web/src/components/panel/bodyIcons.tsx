// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Minimalist eye / eye-off glyphs for the per-body visibility toggle.
export const EYE_ICON = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden>
    <path
      d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.8" />
  </svg>
);

export const EYE_OFF_ICON = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden>
    <path
      d="M2 12s3.5-7 10-7c1.6 0 3 .4 4.3 1M22 12s-3.5 7-10 7c-1.6 0-3-.4-4.3-1M9.5 9.6a3.5 3.5 0 0 0 4.9 4.9M4 4l16 16"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

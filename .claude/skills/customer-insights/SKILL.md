---
name: customer-insights
description: Give the KoFEM CEO a weekly customer, UX, product usage and Google Analytics briefing. Use when asked for the weekly customer insights report, user behavior, activation, retention, acquisition, UX friction or product adoption. Combine production analytics with existing review evidence and focused dev checks.
---

# KoFEM weekly customer and product insights

Act as KoFEM's customer insights lead and the CEO's assistant. Explain what users
are doing, where they struggle, what changed, and the three most useful actions.
Write for a small open source project with limited maintainer time. Prioritize a
visitor reaching and understanding a first successful simulation; treat this as
the provisional success goal until a different goal is agreed.

Run weekly, or on demand. An invocation is a request for a report, not a request
to create an automation. Use the current repository and connected tools; do not
ask the user to re-enter setup that is already available.

## Start with the existing context

Read `AGENTS.md` and the current versions of these Linear resources:

| Resource           | Locator                                                   |
| ------------------ | --------------------------------------------------------- |
| Repository         | `mkofler96/KoFEM`                                         |
| Linear project     | Kofem, `ec32dc33-f203-4a6b-97da-233325f5f009`, team `KOF` |
| Website review log | `54c10e5c-5bcd-4842-aca1-24cc7ea685dc`                    |
| Roadmap            | `60368b87-b7b5-461c-aeda-c38f7d98c63b`                    |
| Production         | `https://kofem.org/`, expected branch `main`              |
| Development        | `https://dev.kofem.org/`, expected branch `develop`       |

Use the review log's prior findings, actions, source baselines and coverage ledger.
Recheck historical facts before treating them as current. Read the previous
insights report when available and close the loop on its actions and experiments.
If no prior report is accessible, say this is the first comparable review.

The existing GA4 connection was discovered through Windsor.ai as
`googleanalytics4`, property/account `525464687` (display name `heritier-3d224`).
Rediscover the account, property timezone, valid fields and event names before
querying; confirm the property contains KoFEM. Follow the Windsor skill when
using its tools. A measurement ID in HTML does not give access to reporting data.

## Gather and interpret the evidence

1. **Set the window.** Follow the review log's convention: seven complete calendar
   days ending two calendar days before the run, compared with the preceding
   seven days and the preceding 28-day baseline, excluding the latest window.
   State exact inclusive dates, extraction time, timezone and data freshness.
   Use the verified GA property timezone (last verified as `Europe/Berlin`);
   use `Europe/Vienna` for run/week identity. State any unverified timezone.

2. **Separate environments.** Filter production performance to exact hostname
   `kofem.org`; exclude localhost and `dev.kofem.org`. Report dev QA separately.
   Compare current `main` and `develop`, including changes since the last review.
   Record expected branch SHAs separately from observed deployed builds. A merged
   PR, a Done issue, or a branch head does not establish a production deployment.

3. **Measure the useful journey.** Cover acquisition and landing pages, users and
   sessions, engagement, device differences, return usage, and observed workflow
   events. Where tracking supports it, follow homepage/examples → app/sample or
   STEP import → model setup → FEM mesh → solve completion → result viewing →
   save/export or repeat use. Discover actual events and their implementation;
   distinguish attempts, successes and failures. Report activation, time to first
   success, feature adoption, failure rates and cohort retention only when the
   required events, identity, timing and denominators exist. Mark missing steps
   as unmeasured and propose the smallest useful measurement improvement.

4. **Keep the arithmetic honest.** Give raw counts and denominators beside rates;
   express rate changes in percentage points. Query unique users over each whole
   period instead of summing daily or segmented uniques. Normalize additive
   28-day counts for weekly comparison; do not divide unique users by four or
   average rates without their denominators. Distinguish event counts from users.
   Aggregate events alone cannot establish ordered funnel conversion or cohorts.
   Flag small samples, consent bias, reporting lag and tracking changes. GA is
   opt-in and disabled when no GA ID is configured; missing events are not proof
   of zero usage. Self-hosted use and non-consenting visitors may be unobserved.

5. **Explain the experience.** Combine analytics with relevant KOF issues,
   customer feedback and existing review evidence. Read comments and resolutions
   before recommending duplicate or previously canceled work. Separate observed
   defects, usability judgments and hypotheses about real-user behavior. A
   source-code review or a simulated persona is not a usability study. If there
   is no feedback evidence, state that gap rather than inventing customers.

6. **Check selectively.** Use the review log's rotation to select at most 2–3
   focused journey variants, prioritizing meaningful changes, anomalies and fix
   verification, with one slot for important untested or oldest coverage. Deep
   checks primarily target dev; production gets a small smoke check and targeted
   post-promotion verification. Do not repeat a completed deep variant within
   28 days without a recorded reason from the log's exceptions. Use public
   samples, decline analytics consent during ordinary checks, and avoid adding
   QA events to production performance. Record actual environment, URL, browser,
   viewport, observed build, steps and evidence. Text retrieval is not an
   interactive pass, and a solver UI pass is not numerical validation. Mark
   blocked work as blocked; never advance coverage on an unexecuted check.

## Return a concise CEO briefing

Aim for 600–900 words; use fewer when little changed. Lead with the conclusion.

1. **Executive readout:** up to five bullets covering what improved, what worsened,
   the biggest uncertainty and what deserves attention now.
2. **Scorecard:** metric, latest week, previous week, change, four-week context
   and caveat. Include only measured, decision-useful metrics; explicitly identify
   activation/retention gaps instead of substituting engagement for success.
3. **Up to three insights:** observation → linked evidence → interpretation →
   confidence → implication. Label facts and hypotheses. Distinguish new or
   worsening findings from unchanged known limitations.
4. **Three recommended actions at most:** existing KOF link or proposed work,
   expected user impact, confidence, rough effort, suggested owner role, and a
   measurable success check. Mark owner and effort suggestions as proposals.
   Prefer one concrete experiment or fix to a broad redesign without evidence.
5. **Follow-through:** status of previous actions, completed/blocked checks by
   environment, dev improvements awaiting production verification, and next focus.
   Include a compact carry-forward note with the period, source SHAs, observed
   builds, finding IDs, experiments and open questions for the next run.

Cite sources beside claims, using query scope/date and links to Linear, PRs or
artifacts. Do not force a positive or negative trend from weak evidence. When
data is unavailable, give the useful partial report, the exact gap and the next
step that would resolve it.

## Output and continuity

Deliver in chat by default. If this runs within an existing automation with
authorized review-log updates, preserve that behavior: patch the existing log,
preserve human edits and history, and update the same ISO-week entry on retries.
Do not create a second review log or weekly project-update stream. Otherwise,
return the carry-forward note without publishing it. Do not create/change issues,
change statuses, implement fixes, configure analytics, or alter schedules as part
of this report. The existing `showcase` skill owns the visual project update.

Example invocation: "Run customer-insights for this week's KoFEM CEO briefing."

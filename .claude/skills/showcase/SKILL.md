---
name: showcase
description: Publish the weekly KoFEM project update to Linear — a progress digest plus the workflow screenshots, as a single post, with the screenshots included only when the app actually looks different. Use when asked to run, refresh, or publish the weekly showcase or the weekly update.
---

# Weekly Linear project update

Publishes **one** project update per week on the **Kofem** Linear project,
combining a written progress digest with the five-step workflow capture.

Everything goes over the Linear MCP connection. **There is no API key and none
should be introduced.**

| Thing | Value |
| -- | -- |
| Project ID | `ec32dc33-f203-4a6b-97da-233325f5f009` |
| Upload anchor issue | **KOF-209** (Linear uploads are issue-scoped) |
| Roadmap document | "Roadmap", in the same project |

## The rules

These exist because this replaced a Slack pipeline that posted every screenshot
on every CI run and became noise. Do not relax them:

1. **One project update per week.** Digest and screenshots go in the same body —
   never a separate post per section, and never one post per image.
2. **Screenshots only when they changed.** Check the fingerprint before uploading
   anything. If the app looks identical, post the digest without a showcase
   section, or post nothing at all if there is also nothing to report.
3. **No filler.** If a week produced nothing worth reading, say so in one line.
   A padded update trains people to skip the next one.

## Steps

### 1. Capture

```bash
cd web && bun install && bun run test:showcase
```

Screenshots land in `web/playwright-results/screenshots/showcase/`. Playwright's
`webServer` builds and serves the app itself.

If the spec fails, **report the failure and do not publish a showcase section**.
A showcase silently displaying last week's app is worse than none. The digest can
still go out, and the failure itself is worth reporting.

### 2. Fingerprint

```bash
cd web/playwright-results/screenshots/showcase && \
  for f in $(ls *.png | sort); do printf '%s' "$f"; cat "$f"; done | sha256sum
```

Name-then-bytes in sorted order, so a rename counts as a change.

### 3. Compare against the last update

`get_status_updates` with `type: "project"`, the project ID, `limit: 1`,
`orderBy: createdAt`. Look for `<!-- kofem-showcase-sha256:… -->`.

If it matches, **skip the upload entirely** and omit the showcase section from
this week's body (keep the fingerprint comment so the next run still compares
correctly).

### 4. Upload, only if the fingerprint changed

One file at a time — the signed URL expires in 60 seconds, so never batch the
prepare calls:

1. `prepare_attachment_upload` with `issue: "KOF-209"`, the filename,
   `contentType: "image/png"`, exact byte size (`stat -c%s <file>`).
2. PUT the raw bytes to `uploadRequest.url`, sending **every** header from
   `uploadRequest.headers` verbatim — casing included, or it returns 403:

   ```bash
   curl -sS -X PUT --data-binary @<file> \
     -H "content-type: image/png" \
     -H "x-goog-content-length-range: N,N" \
     ... \
     "<uploadRequest.url>"
   ```
3. Keep the returned `assetUrl`. Skip `create_attachment_from_upload` — the images
   are embedded in the update body, and an attachment row per image per week would
   clutter the issue.

### 5. Post the update

`save_status_update` with `type: "project"`, the project ID, and a `health` that
reflects what you actually found (`onTrack` / `atRisk` / `offTrack`) — not a
reflex `onTrack`.

```markdown
## Week of YYYY-MM-DD

<2–5 sentences: what shipped, what regressed, what is now the biggest risk.
Concrete. "Shell coupling landed for I-beams; Playwright suite is up to 213s
from 131s three weeks ago" beats "good progress on several fronts".>

### Roadmap

<Only when there is a real deviation between where the code is going and what
the Roadmap document says. Name the deviation and what you did about it —
reprioritised issue X, filed issue Y. Omit this section entirely when the
roadmap and the code agree.>

### Filed this week

<Only when you filed issues. One line each: `KOF-nn` — title. Omit if none.>

### Workflow showcase

<Only when the fingerprint changed. Note in one line what looks different.>

![Step 1 · Select geometry](<assetUrl>)
![Step 2 · Geometry & options](<assetUrl>)
![Step 3 · Mesh generation](<assetUrl>)
![Step 4 · Load application](<assetUrl>)
![Step 5 · Analysis results](<assetUrl>)

<!-- kofem-showcase-sha256:<fingerprint> -->
```

The fingerprint comment is what makes step 3 work next week. **It is not
optional** — omit it and every subsequent run reposts the images.

File-name-to-title mapping:

| File | Title |
| -- | -- |
| `01-select-geometry.png` | Step 1 · Select geometry |
| `02-geometry-options.png` | Step 2 · Geometry & options |
| `03-mesh-generation.png` | Step 3 · Mesh generation |
| `04-load-application.png` | Step 4 · Load application |
| `05-results.png` | Step 5 · Analysis results |

If the spec produces a file not in this table, use its filename as the title and
say so — do not silently drop the image.

## Report back

One or two lines: the update URL and what changed, or "nothing worth posting".
Do not narrate the intermediate steps.

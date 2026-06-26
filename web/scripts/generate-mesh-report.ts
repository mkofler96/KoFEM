#!/usr/bin/env -S bun run
// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Upload KoFEM Playwright render screenshots + test failure screenshots to Slack.
 *
 * Reads:
 *   web/playwright-results/screenshots/report/    — geometry renders (mesh-report.spec.ts)
 *   web/playwright-results/screenshots/showcase/  — full workflow showcase (showcase.spec.ts)
 *   web/playwright-results/<test-name>/            — failure screenshots from any failing test
 *
 * Posts one message per section (failures, renders, showcase) to the configured channel.
 *
 * Env vars:
 *   SLACK_BOT_TOKEN  — bot token with chat:write + files:write scope
 *   SLACK_CHANNEL    — channel ID (optional, defaults to #product-showcases lookup)
 */
import fs from "fs";
import path from "path";

const RESULTS_DIR = path.join("playwright-results");
const SCREENSHOTS_DIR = path.join(RESULTS_DIR, "screenshots", "report");
const SHOWCASE_DIR = path.join(RESULTS_DIR, "screenshots", "showcase");
const DEFAULT_CHANNEL = "product-showcases";

const SHOWCASE_TITLES: Record<string, string> = {
  "01-select-geometry.png": "Step 1 · Select geometry window",
  "02-geometry-options.png": "Step 2 · Geometry & options",
  "03-mesh-generation.png": "Step 3 · Mesh generation",
  "04-load-application.png": "Step 4 · Load application",
  "05-results.png": "Step 5 · Analysis results",
};

// ── Slack helpers ─────────────────────────────────────────────────────────────

async function findChannel(token: string, name: string): Promise<string> {
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({
      types: "public_channel,private_channel",
      limit: "200",
    });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(
      `https://slack.com/api/conversations.list?${params}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    const data = (await res.json()) as {
      ok: boolean;
      channels?: { id: string; name: string }[];
      response_metadata?: { next_cursor?: string };
      error?: string;
    };
    if (!data.ok) throw new Error(`conversations.list: ${data.error}`);
    const match = data.channels?.find((c) => c.name === name);
    if (match) return match.id;
    cursor = data.response_metadata?.next_cursor;
  } while (cursor);
  throw new Error(
    `Channel "${name}" not found — make sure the bot is in that channel`,
  );
}

async function postMessage(
  token: string,
  channelId: string,
  text: string,
): Promise<string> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: channelId, text }),
  });
  const data = (await res.json()) as {
    ok: boolean;
    ts?: string;
    error?: string;
  };
  if (!data.ok) throw new Error(`chat.postMessage: ${data.error}`);
  return data.ts!;
}

async function uploadFile(
  token: string,
  filePath: string,
  channelId: string,
  threadTs: string,
  title?: string,
): Promise<void> {
  const fileContent = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  const urlRes = await fetch(
    "https://slack.com/api/files.getUploadURLExternal",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        filename: fileName,
        length: fileContent.length.toString(),
      }),
    },
  );
  const urlData = (await urlRes.json()) as {
    ok: boolean;
    upload_url?: string;
    file_id?: string;
    error?: string;
  };
  if (!urlData.ok)
    throw new Error(`files.getUploadURLExternal: ${urlData.error}`);

  await fetch(urlData.upload_url!, { method: "POST", body: fileContent });

  const completeRes = await fetch(
    "https://slack.com/api/files.completeUploadExternal",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        files: [{ id: urlData.file_id, title: title ?? fileName }],
        channel_id: channelId,
        thread_ts: threadTs,
      }),
    },
  );
  const completeData = (await completeRes.json()) as {
    ok: boolean;
    error?: string;
  };
  if (!completeData.ok)
    throw new Error(`files.completeUploadExternal: ${completeData.error}`);
}

// ── Failure screenshot discovery ──────────────────────────────────────────────

interface FailureResult {
  testDir: string; // e.g. "solve-vol-mesh-stores-FEM-nodes-in-the-store-for-solving"
  screenshot: string; // absolute path to .png
  context: string | null; // text from error-context.md if present
}

function findFailureScreenshots(): FailureResult[] {
  if (!fs.existsSync(RESULTS_DIR)) return [];

  const results: FailureResult[] = [];

  for (const entry of fs.readdirSync(RESULTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "screenshots") continue; // skip geometry renders dir

    const dir = path.join(RESULTS_DIR, entry.name);
    const pngs = fs.readdirSync(dir).filter((f) => f.endsWith(".png"));
    if (pngs.length === 0) continue;

    const contextFile = path.join(dir, "error-context.md");
    const context = fs.existsSync(contextFile)
      ? fs.readFileSync(contextFile, "utf8").slice(0, 2000) // cap at 2 KB for Slack
      : null;

    for (const png of pngs) {
      results.push({
        testDir: entry.name,
        screenshot: path.join(dir, png),
        context,
      });
    }
  }

  return results;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.log("SLACK_BOT_TOKEN not set — skipping Slack upload");
    return;
  }

  const channelId =
    process.env.SLACK_CHANNEL ?? (await findChannel(token, DEFAULT_CHANNEL));
  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // ── 1. Post failure screenshots ───────────────────────────────────────────
  const failures = findFailureScreenshots();
  if (failures.length > 0) {
    const failureTs = await postMessage(
      token,
      channelId,
      `:red_circle: *KoFEM test failures* — ${failures.length} screenshot(s) — ${dateStr}`,
    );
    console.log(
      `Posted failure thread, uploading ${failures.length} failure screenshot(s)…`,
    );

    const seenContexts = new Set<string>();
    for (const { testDir, screenshot, context } of failures) {
      const label = testDir.replace(/-/g, " ");
      try {
        await uploadFile(token, screenshot, channelId, failureTs, label);
        console.log(`  ✓ ${path.basename(screenshot)} (${testDir})`);
      } catch (err) {
        console.error(`  ✗ ${path.basename(screenshot)}: ${err}`);
      }

      // Post error-context.md text once per test directory
      if (context && !seenContexts.has(testDir)) {
        seenContexts.add(testDir);
        try {
          await postMessage(token, channelId, `\`\`\`\n${context}\n\`\`\``);
        } catch (err) {
          console.error(`  ✗ could not post context for ${testDir}: ${err}`);
        }
      }
    }
  }

  // ── 2. Post geometry render screenshots ──────────────────────────────────
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    console.log(
      `No geometry screenshots at ${SCREENSHOTS_DIR} — skipping render report`,
    );
    return;
  }

  const screenshots = fs
    .readdirSync(SCREENSHOTS_DIR)
    .filter((f) => f.endsWith(".png"))
    .sort();
  if (screenshots.length === 0) {
    console.log("No geometry screenshots found — skipping render report");
    return;
  }

  const renderTs = await postMessage(
    token,
    channelId,
    `KoFEM render report — ${screenshots.length} screenshots — ${dateStr}`,
  );
  console.log(
    `Posted render thread, uploading ${screenshots.length} screenshot(s)…`,
  );

  for (const file of screenshots) {
    try {
      await uploadFile(
        token,
        path.join(SCREENSHOTS_DIR, file),
        channelId,
        renderTs,
      );
      console.log(`  ✓ ${file}`);
    } catch (err) {
      console.error(`  ✗ ${file}: ${err}`);
    }
  }

  // ── 3. Post full workflow showcase screenshots ──────────────────────────────
  if (!fs.existsSync(SHOWCASE_DIR)) {
    console.log(
      `No showcase screenshots at ${SHOWCASE_DIR} — skipping showcase report`,
    );
    return;
  }

  const showcaseFiles = fs
    .readdirSync(SHOWCASE_DIR)
    .filter((f) => f.endsWith(".png"))
    .sort();
  if (showcaseFiles.length === 0) {
    console.log("No showcase screenshots found — skipping showcase report");
    return;
  }

  const showcaseTs = await postMessage(
    token,
    channelId,
    `:sparkles: *KoFEM full workflow showcase* — ${showcaseFiles.length} steps — ${dateStr}`,
  );
  console.log(
    `Posted showcase thread, uploading ${showcaseFiles.length} screenshot(s)…`,
  );

  for (const file of showcaseFiles) {
    const title = SHOWCASE_TITLES[file] ?? file;
    try {
      await uploadFile(
        token,
        path.join(SHOWCASE_DIR, file),
        channelId,
        showcaseTs,
        title,
      );
      console.log(`  ✓ ${file} → "${title}"`);
    } catch (err) {
      console.error(`  ✗ ${file}: ${err}`);
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

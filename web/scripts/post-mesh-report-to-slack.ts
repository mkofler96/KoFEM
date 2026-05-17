#!/usr/bin/env -S bun run
/**
 * Post comprehensive KoFEM mesh quality report to Slack with stats and screenshots.
 *
 * Reads:
 *   - web/test-results/mesh-quality.json (from Rust quality tests)
 *   - web/screenshots/report/*.png (from Playwright tests)
 *
 * Posts to Slack:
 *   - Summary stats with pass/fail counts
 *   - Quality metrics table (triangle counts, chamfer distances)
 *   - Screenshot collage of sample geometries
 *
 * Usage: bun scripts/post-mesh-report-to-slack.ts
 *
 * Env vars:
 *   SLACK_BOT_TOKEN  (required) — bot token with chat:write, files:write scopes
 *   SLACK_CHANNEL    (optional) — channel ID override
 */
import fs from 'fs'
import path from 'path'

const JSON_PATH = path.join(import.meta.dir, '..', 'test-results', 'mesh-quality.json')
const SCREENSHOTS_DIR = path.join(import.meta.dir, '..', 'screenshots', 'report')
const DEFAULT_CHANNEL = 'product-showcases'

interface QualityResult {
  name: string
  label: string
  kofem_triangles: number | null
  ref_triangles: number | null
  chamfer_mean_mm: number | null
  chamfer_max_mm: number | null
  time_ms: number
  error: string | null
  pass: boolean
}

interface QualityReport {
  generated_at: number
  results: QualityResult[]
}

// ── formatting ────────────────────────────────────────────────────────────────

function pad(s: string, w: number, right = false): string {
  const str = s.length > w ? s.slice(0, w) : s
  return right ? str.padStart(w) : str.padEnd(w)
}

function fmtK(v: number | null): string {
  if (v === null) return '—'
  return v >= 10_000 ? `${(v / 1000).toFixed(0)}k`
       : v >= 1_000  ? `${(v / 1000).toFixed(1)}k`
       : v.toString()
}

function fmtMm(v: number | null): string {
  if (v === null) return '—'
  return v.toFixed(1)
}

function buildCompactTable(results: QualityResult[]): string {
  const W = { label: 24, kt: 6, rt: 6, mean: 6, max: 6, ms: 5, st: 4 }
  const SEP = ' '

  const header =
    pad('Geometry', W.label) + SEP +
    pad('Tris', W.kt, true) + SEP +
    pad('Ref', W.rt, true) + SEP +
    pad('Mean', W.mean, true) + SEP +
    pad('Max', W.max, true) + SEP +
    pad('ms', W.ms, true) + SEP +
    pad('', W.st)

  const divider = '─'.repeat(header.length)

  const rows = results.map(r => {
    const status = r.pass ? '✅' : (r.error ? '⛔' : '❌')
    return (
      pad(r.label, W.label) + SEP +
      pad(fmtK(r.kofem_triangles), W.kt, true) + SEP +
      pad(fmtK(r.ref_triangles), W.rt, true) + SEP +
      pad(fmtMm(r.chamfer_mean_mm), W.mean, true) + SEP +
      pad(fmtMm(r.chamfer_max_mm), W.max, true) + SEP +
      pad(r.time_ms.toString(), W.ms, true) + SEP +
      status
    )
  })

  return [header, divider, ...rows].join('\n')
}

function buildSummaryStats(results: QualityResult[]): string {
  const passed = results.filter(r => r.pass).length
  const failed = results.filter(r => !r.pass && !r.error).length
  const errors = results.filter(r => r.error).length
  const totalTris = results.reduce((sum, r) => sum + (r.kofem_triangles ?? 0), 0)
  const totalTime = results.reduce((sum, r) => sum + r.time_ms, 0)
  const avgChamfer = results
    .filter(r => r.chamfer_mean_mm !== null)
    .reduce((sum, r, _, arr) => sum + r.chamfer_mean_mm! / arr.length, 0)

  return [
    `*${passed}* passed · *${failed}* failed · *${errors}* errors`,
    `Total: *${fmtK(totalTris)}* triangles in *${(totalTime / 1000).toFixed(1)}s*`,
    `Avg chamfer: *${avgChamfer.toFixed(1)} mm*`,
  ].join('\n')
}

// ── Slack API ─────────────────────────────────────────────────────────────────

async function findChannel(token: string, name: string): Promise<string> {
  let cursor: string | undefined
  do {
    const params = new URLSearchParams({ types: 'public_channel,private_channel', limit: '200' })
    if (cursor) params.set('cursor', cursor)
    const res = await fetch(`https://slack.com/api/conversations.list?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json() as {
      ok: boolean
      channels?: { id: string; name: string }[]
      response_metadata?: { next_cursor?: string }
      error?: string
    }
    if (!data.ok) throw new Error(`conversations.list: ${data.error}`)
    const match = data.channels?.find(c => c.name === name)
    if (match) return match.id
    cursor = data.response_metadata?.next_cursor
  } while (cursor)
  throw new Error(`Channel "${name}" not found`)
}

async function postMessage(token: string, payload: object): Promise<string> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const data = await res.json() as { ok: boolean; ts?: string; error?: string }
  if (!data.ok) throw new Error(`chat.postMessage: ${data.error}`)
  return data.ts!
}

async function uploadFile(
  token: string,
  filePath: string,
  channelId: string,
  threadTs?: string,
): Promise<void> {
  const fileContent = fs.readFileSync(filePath)
  const fileName = path.basename(filePath)

  // Get upload URL
  const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      filename: fileName,
      length: fileContent.length.toString(),
    }),
  })
  const urlData = await urlRes.json() as { ok: boolean; upload_url?: string; file_id?: string; error?: string }
  if (!urlData.ok) throw new Error(`files.getUploadURLExternal: ${urlData.error}`)

  // Upload content
  await fetch(urlData.upload_url!, { method: 'POST', body: fileContent })

  // Complete upload
  const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: [{ id: urlData.file_id, title: fileName }],
      channel_id: channelId,
      thread_ts: threadTs,
    }),
  })
  const completeData = await completeRes.json() as { ok: boolean; error?: string }
  if (!completeData.ok) throw new Error(`files.completeUploadExternal: ${completeData.error}`)
}

// ── main ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  // Load quality report
  if (!fs.existsSync(JSON_PATH)) {
    console.error(`Quality JSON not found: ${JSON_PATH}`)
    console.error('Run: cargo test -p kofem-geom mesh_quality_report -- --nocapture')
    process.exit(1)
  }

  const report: QualityReport = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'))
  const results = report.results
  const dateStr = new Date(report.generated_at * 1000).toISOString().split('T')[0]

  // Print locally
  console.log(buildCompactTable(results))
  console.log()
  console.log(buildSummaryStats(results))

  const token = process.env.SLACK_BOT_TOKEN
  if (!token) {
    console.warn('\nSLACK_BOT_TOKEN not set — skipping Slack post')
    return
  }

  const channelId = process.env.SLACK_CHANNEL ?? await findChannel(token, DEFAULT_CHANNEL)
  console.log(`\nPosting to channel ${channelId}...`)

  // Find screenshots
  const screenshots: string[] = []
  if (fs.existsSync(SCREENSHOTS_DIR)) {
    const files = fs.readdirSync(SCREENSHOTS_DIR)
      .filter(f => f.endsWith('-mesh.png'))
      .sort()

    // Select representative samples: first 3 standard + first 2 complex
    const standardShots = files.filter(f => !f.startsWith('nist_')).slice(0, 3)
    const nistShots = files.filter(f => f.startsWith('nist_')).slice(0, 2)
    screenshots.push(...standardShots.map(f => path.join(SCREENSHOTS_DIR, f)))
    screenshots.push(...nistShots.map(f => path.join(SCREENSHOTS_DIR, f)))
  }

  // Build Slack message
  const passed = results.filter(r => r.pass).length
  const total = results.length
  const statusEmoji = passed === total ? '✅' : '⚠️'

  const payload = {
    channel: channelId,
    text: `KoFEM Mesh Report — ${passed}/${total} passed`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${statusEmoji} KoFEM Mesh Quality Report`, emoji: true },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${dateStr} · Chamfer distance vs gmsh reference STL` }],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: buildSummaryStats(results) },
      },
      {
        type: 'rich_text',
        elements: [{
          type: 'rich_text_preformatted',
          elements: [{ type: 'text', text: buildCompactTable(results) }],
        }],
      },
    ],
  }

  // Post main message
  const ts = await postMessage(token, payload)
  console.log(`Posted message (ts=${ts})`)

  // Upload screenshots as thread replies
  if (screenshots.length > 0) {
    console.log(`Uploading ${screenshots.length} screenshots to thread...`)
    for (const screenshot of screenshots) {
      try {
        await uploadFile(token, screenshot, channelId, ts)
        console.log(`  ✓ ${path.basename(screenshot)}`)
      } catch (err) {
        console.error(`  ✗ ${path.basename(screenshot)}: ${err}`)
      }
    }
  } else {
    console.log('No screenshots found in screenshots/report/')
  }

  console.log('Done!')
}

run().catch(err => { console.error(err); process.exit(1) })

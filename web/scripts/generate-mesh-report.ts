#!/usr/bin/env -S bun run
/**
 * Post the KoFEM mesh quality report to Slack as a formatted text table.
 *
 * Reads:  web/test-results/mesh-quality.json  (written by Rust quality test)
 * Posts:  chat.postMessage to #product-showcases
 *
 * Run after:  cargo test -p kofem-geom mesh_quality_report -- --nocapture
 * Usage:      bun scripts/generate-mesh-report.ts
 *
 * Env vars:
 *   SLACK_BOT_TOKEN  (required) — bot token with chat:write scope
 *   SLACK_CHANNEL    (optional) — channel ID override
 */
import fs from 'fs'
import path from 'path'

const JSON_IN = path.join(import.meta.dir, '..', 'test-results', 'mesh-quality.json')
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
  return v.toFixed(2)
}

function buildTable(results: QualityResult[]): string {
  // Column widths
  const W = { label: 30, kt: 7, rt: 7, mean: 8, max: 8, ms: 7, st: 6 }
  const SEP = '  '

  const header =
    pad('Geometry', W.label) + SEP +
    pad('KoFEM△', W.kt, true) + SEP +
    pad('Ref△', W.rt, true) + SEP +
    pad('Mean mm', W.mean, true) + SEP +
    pad('Max mm', W.max, true) + SEP +
    pad('ms', W.ms, true) + SEP +
    pad('Status', W.st)

  const divider = '─'.repeat(header.length)

  const rows = results.map(r => {
    const status = r.pass ? '✅' : (r.error ? '❌ ERR' : '❌ FAIL')
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

function buildSlackPayload(report: QualityReport, channelId: string): object {
  const results = report.results
  const passed = results.filter(r => r.pass).length
  const failed = results.length - passed
  const dateStr = new Date(report.generated_at * 1000).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  })

  const summary = failed === 0
    ? `✅ All ${results.length} geometries passed`
    : `❌ ${failed}/${results.length} failed`

  const table = buildTable(results)

  return {
    channel: channelId,
    text: `KoFEM Mesh Quality — ${summary}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'KoFEM Mesh Quality Report', emoji: false },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${summary}  ·  ${dateStr}\n_Symmetric chamfer distance on triangle centroids vs. gmsh reference (≤5 000 samples)_`,
        },
      },
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_preformatted',
            elements: [{ type: 'text', text: table }],
          },
        ],
      },
    ],
  }
}

// ── Slack helpers ─────────────────────────────────────────────────────────────

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
  throw new Error(`Channel "${name}" not found — make sure the bot is in that channel`)
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

async function uploadFile(token: string, filePath: string, channelId: string, threadTs: string): Promise<void> {
  const fileContent = fs.readFileSync(filePath)
  const fileName = path.basename(filePath)

  const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ filename: fileName, length: fileContent.length.toString() }),
  })
  const urlData = await urlRes.json() as { ok: boolean; upload_url?: string; file_id?: string; error?: string }
  if (!urlData.ok) throw new Error(`files.getUploadURLExternal: ${urlData.error}`)

  await fetch(urlData.upload_url!, { method: 'POST', body: fileContent })

  const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [{ id: urlData.file_id, title: fileName }], channel_id: channelId, thread_ts: threadTs }),
  })
  const completeData = await completeRes.json() as { ok: boolean; error?: string }
  if (!completeData.ok) throw new Error(`files.completeUploadExternal: ${completeData.error}`)
}

// ── main ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  if (!fs.existsSync(JSON_IN)) {
    console.error(`Quality JSON not found: ${JSON_IN}`)
    console.error('The mesh_quality_report Rust test should generate this file.')
    console.error('Run: cargo test -p kofem-geom mesh_quality_report -- --nocapture')
    process.exit(1)
  }

  const report: QualityReport = JSON.parse(fs.readFileSync(JSON_IN, 'utf8'))
  const results = report.results
  const passed = results.filter(r => r.pass).length

  // Print table locally regardless of Slack
  console.log(buildTable(results))
  console.log(`\n${passed}/${results.length} passed`)

  const token = process.env.SLACK_BOT_TOKEN
  if (!token) {
    console.warn('SLACK_BOT_TOKEN not set — skipping Slack post')
    return
  }

  const channelId = process.env.SLACK_CHANNEL
    ?? await findChannel(token, DEFAULT_CHANNEL)
  console.log(`Posting to channel ${channelId}...`)

  const payload = buildSlackPayload(report, channelId)
  const threadTs = await postMessage(token, payload)
  console.log('Posted to Slack.')

  // Upload screenshots from Playwright tests as thread replies
  if (fs.existsSync(SCREENSHOTS_DIR)) {
    const files = fs.readdirSync(SCREENSHOTS_DIR).filter(f => f.endsWith('-mesh.png')).sort()
    const standardShots = files.filter(f => !f.startsWith('nist_')).slice(0, 3)
    const nistShots = files.filter(f => f.startsWith('nist_')).slice(0, 2)
    const screenshots = [...standardShots, ...nistShots]

    if (screenshots.length > 0) {
      console.log(`Uploading ${screenshots.length} screenshots...`)
      for (const file of screenshots) {
        try {
          await uploadFile(token, path.join(SCREENSHOTS_DIR, file), channelId, threadTs)
          console.log(`  ✓ ${file}`)
        } catch (err) {
          console.error(`  ✗ ${file}: ${err}`)
        }
      }
    }
  }
}

run().catch(err => { console.error(err); process.exit(1) })

#!/usr/bin/env -S bun run
/**
 * Upload KoFEM Playwright render screenshots to Slack.
 *
 * Reads:  web/playwright-results/screenshots/report/  (written by mesh-report.spec.ts)
 * Posts:  one message + screenshot attachments to the configured channel
 *
 * Env vars:
 *   SLACK_BOT_TOKEN  — bot token with chat:write + files:write scope
 *   SLACK_CHANNEL    — channel ID (optional, defaults to #product-showcases lookup)
 */
import fs from 'fs'
import path from 'path'

const SCREENSHOTS_DIR = path.join('playwright-results', 'screenshots', 'report')
const DEFAULT_CHANNEL = 'product-showcases'

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

async function postMessage(token: string, channelId: string, text: string): Promise<string> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: channelId, text }),
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
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) {
    console.log('SLACK_BOT_TOKEN not set — skipping Slack upload')
    return
  }

  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    console.log(`No screenshots directory found at ${SCREENSHOTS_DIR} — nothing to upload`)
    return
  }

  const screenshots = fs.readdirSync(SCREENSHOTS_DIR)
    .filter(f => f.endsWith('.png'))
    .sort()

  if (screenshots.length === 0) {
    console.log('No screenshots found — nothing to upload')
    return
  }

  const channelId = process.env.SLACK_CHANNEL ?? await findChannel(token, DEFAULT_CHANNEL)
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  const threadTs = await postMessage(token, channelId, `KoFEM render report — ${screenshots.length} screenshots — ${dateStr}`)
  console.log(`Posted thread to Slack, uploading ${screenshots.length} screenshots...`)

  for (const file of screenshots) {
    try {
      await uploadFile(token, path.join(SCREENSHOTS_DIR, file), channelId, threadTs)
      console.log(`  ✓ ${file}`)
    } catch (err) {
      console.error(`  ✗ ${file}: ${err}`)
    }
  }
}

run().catch(err => { console.error(err); process.exit(1) })

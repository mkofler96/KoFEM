#!/usr/bin/env npx tsx
/**
 * Upload screenshots to Slack
 *
 * Usage:
 *   SLACK_BOT_TOKEN=xoxb-... npx tsx scripts/upload-to-slack.ts [screenshot-path]
 *
 * Environment variables:
 *   SLACK_BOT_TOKEN - Bot token with files:write, chat:write, and channels:read scopes
 *   SLACK_CHANNEL   - (Optional) Channel ID override (e.g., C0123456789)
 *
 * If no screenshot path is provided, reads from screenshots/latest.json
 * Default channel: product-showcases
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN
const SLACK_CHANNEL_OVERRIDE = process.env.SLACK_CHANNEL
const DEFAULT_CHANNEL_NAME = 'product-showcases'

interface LatestManifest {
  fullPage: string
  viewport: string
  timestamp: string
}

interface SlackChannel {
  id: string
  name: string
}

async function findChannelByName(channelName: string): Promise<string> {
  let cursor: string | undefined

  do {
    const params = new URLSearchParams({ types: 'public_channel,private_channel', limit: '200' })
    if (cursor) params.set('cursor', cursor)

    const response = await fetch(`https://slack.com/api/conversations.list?${params}`, {
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` },
    })

    const data = await response.json() as {
      ok: boolean
      channels?: SlackChannel[]
      response_metadata?: { next_cursor?: string }
      error?: string
    }

    if (!data.ok) {
      throw new Error(`Failed to list channels: ${data.error}`)
    }

    const match = data.channels?.find(c => c.name === channelName)
    if (match) return match.id

    cursor = data.response_metadata?.next_cursor
  } while (cursor)

  throw new Error(`Channel "${channelName}" not found. Make sure the bot is added to the channel.`)
}

async function getChannelId(): Promise<string> {
  if (SLACK_CHANNEL_OVERRIDE) {
    return SLACK_CHANNEL_OVERRIDE
  }
  console.log(`Looking up channel: ${DEFAULT_CHANNEL_NAME}`)
  return findChannelByName(DEFAULT_CHANNEL_NAME)
}

async function uploadFileToSlack(filePath: string, comment: string, channelId: string): Promise<string> {
  if (!SLACK_BOT_TOKEN) {
    throw new Error('SLACK_BOT_TOKEN environment variable is required')
  }

  const fileContent = fs.readFileSync(filePath)
  const fileName = path.basename(filePath)

  // Step 1: Get upload URL
  const getUrlResponse = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      filename: fileName,
      length: fileContent.length.toString(),
    }),
  })

  const urlData = await getUrlResponse.json() as { ok: boolean; upload_url?: string; file_id?: string; error?: string }
  if (!urlData.ok) {
    throw new Error(`Failed to get upload URL: ${urlData.error}`)
  }

  // Step 2: Upload file content
  const uploadResponse = await fetch(urlData.upload_url!, {
    method: 'POST',
    body: fileContent,
  })

  if (!uploadResponse.ok) {
    throw new Error(`Failed to upload file: ${uploadResponse.statusText}`)
  }

  // Step 3: Complete upload and share to channel
  const completeResponse = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: [{ id: urlData.file_id, title: fileName }],
      channel_id: channelId,
      initial_comment: comment,
    }),
  })

  const completeData = await completeResponse.json() as { ok: boolean; error?: string }
  if (!completeData.ok) {
    throw new Error(`Failed to complete upload: ${completeData.error}`)
  }

  return urlData.file_id!
}

async function main() {
  const args = process.argv.slice(2)

  let filesToUpload: string[] = []
  let comment = 'KoFEM Screenshot'

  if (args.length > 0) {
    // Use provided file path(s)
    filesToUpload = args.filter(arg => !arg.startsWith('--'))
    const commentArg = args.find(arg => arg.startsWith('--comment='))
    if (commentArg) {
      comment = commentArg.split('=').slice(1).join('=')
    }
  } else {
    // Look for screenshot directly
    const screenshotPath = path.resolve(__dirname, '../screenshots/step-fit-view.png')
    if (!fs.existsSync(screenshotPath)) {
      console.error('No screenshot found at screenshots/step-fit-view.png')
      console.error('Run the screenshot test first: bun run test:screenshot')
      process.exit(1)
    }

    filesToUpload = [screenshotPath]
    comment = `KoFEM Screenshot (${new Date().toISOString()})`
  }

  const channelId = await getChannelId()
  console.log(`Uploading to channel: ${channelId}`)

  for (const filePath of filesToUpload) {
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`)
      continue
    }

    console.log(`Uploading ${filePath}...`)
    try {
      const fileId = await uploadFileToSlack(filePath, comment, channelId)
      console.log(`Uploaded successfully! File ID: ${fileId}`)
    } catch (error) {
      console.error(`Failed to upload ${filePath}:`, error)
      process.exit(1)
    }
  }

  console.log('Done!')
}

main()

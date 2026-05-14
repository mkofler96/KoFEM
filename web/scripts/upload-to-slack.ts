#!/usr/bin/env npx tsx
/**
 * Upload screenshots to Slack
 *
 * Usage:
 *   SLACK_BOT_TOKEN=xoxb-... SLACK_CHANNEL=C0123456789 npx tsx scripts/upload-to-slack.ts [screenshot-path]
 *
 * Environment variables:
 *   SLACK_BOT_TOKEN - Bot token with files:write and chat:write scopes
 *   SLACK_CHANNEL   - Channel ID to post to (e.g., C0123456789)
 *
 * If no screenshot path is provided, reads from screenshots/latest.json
 */

import * as fs from 'fs'
import * as path from 'path'

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN
const SLACK_CHANNEL = process.env.SLACK_CHANNEL

interface LatestManifest {
  fullPage: string
  viewport: string
  timestamp: string
}

async function uploadFileToSlack(filePath: string, comment: string): Promise<string> {
  if (!SLACK_BOT_TOKEN) {
    throw new Error('SLACK_BOT_TOKEN environment variable is required')
  }
  if (!SLACK_CHANNEL) {
    throw new Error('SLACK_CHANNEL environment variable is required')
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
      channel_id: SLACK_CHANNEL,
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
    // Read from latest.json manifest
    const manifestPath = path.resolve(__dirname, '../screenshots/latest.json')
    if (!fs.existsSync(manifestPath)) {
      console.error('No screenshot manifest found at screenshots/latest.json')
      console.error('Run the screenshot test first: bun run test:screenshot')
      process.exit(1)
    }

    const manifest: LatestManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    filesToUpload = [manifest.viewport]
    comment = `KoFEM Screenshot (${manifest.timestamp})`
  }

  for (const filePath of filesToUpload) {
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`)
      continue
    }

    console.log(`Uploading ${filePath}...`)
    try {
      const fileId = await uploadFileToSlack(filePath, comment)
      console.log(`Uploaded successfully! File ID: ${fileId}`)
    } catch (error) {
      console.error(`Failed to upload ${filePath}:`, error)
      process.exit(1)
    }
  }

  console.log('Done!')
}

main()

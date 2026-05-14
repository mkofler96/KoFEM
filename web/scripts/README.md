# Screenshot & Slack Upload Scripts

## Prerequisites

1. Install Playwright browsers:
   ```bash
   bunx playwright install chromium
   ```

2. Create a Slack App with a Bot Token:
   - Go to https://api.slack.com/apps
   - Create New App > From scratch
   - Add OAuth scopes: `files:write`, `chat:write`
   - Install to workspace and copy the Bot User OAuth Token (`xoxb-...`)

## Usage

### Take Screenshots Only

```bash
bun run test:screenshot
```

Screenshots are saved to `web/screenshots/` with timestamps.

### Upload to Slack Only

```bash
SLACK_BOT_TOKEN=xoxb-your-token SLACK_CHANNEL=C0123456789 bun run upload:slack
```

This reads from `screenshots/latest.json` (created by the screenshot test).

### Take Screenshot and Upload to Slack

```bash
SLACK_BOT_TOKEN=xoxb-your-token SLACK_CHANNEL=C0123456789 bun run screenshot:slack
```

### Upload a Specific File

```bash
SLACK_BOT_TOKEN=xoxb-your-token SLACK_CHANNEL=C0123456789 npx tsx scripts/upload-to-slack.ts /path/to/screenshot.png --comment="Custom message"
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Slack Bot User OAuth Token (starts with `xoxb-`) |
| `SLACK_CHANNEL` | Slack channel ID (e.g., `C0123456789`) |

## Finding Your Channel ID

1. Open Slack in a browser
2. Navigate to the channel
3. The URL will be like `https://app.slack.com/client/T.../C0123456789`
4. The channel ID is the `C...` part

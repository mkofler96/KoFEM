# Screenshot & Slack Upload Scripts

## Prerequisites

1. Install Playwright browsers:
   ```bash
   bunx playwright install chromium
   ```

2. Create a Slack App with a Bot Token:
   - Go to https://api.slack.com/apps
   - Create New App > From scratch
   - Add OAuth scopes: `files:write`, `chat:write`, `channels:read`
   - Install to workspace and copy the Bot User OAuth Token (`xoxb-...`)
   - **Important:** Add the bot to the `product-showcases` channel

## Usage

### Take Screenshots Only

```bash
bun run test:screenshot
```

Screenshots are saved to `web/screenshots/` with timestamps.

### Upload to Slack

```bash
SLACK_BOT_TOKEN=xoxb-your-token bun run upload:slack
```

By default, uploads to `#product-showcases`. To override:

```bash
SLACK_BOT_TOKEN=xoxb-your-token SLACK_CHANNEL=C0123456789 bun run upload:slack
```

### Take Screenshot and Upload to Slack

```bash
SLACK_BOT_TOKEN=xoxb-your-token bun run screenshot:slack
```

### Upload a Specific File

```bash
SLACK_BOT_TOKEN=xoxb-your-token npx tsx scripts/upload-to-slack.ts /path/to/screenshot.png --comment="Custom message"
```

## CI Integration

The GitHub Actions workflow automatically takes screenshots and uploads to Slack on pushes to `main`.

Required GitHub secret:
- `SLACK_BOT_TOKEN` - Slack Bot User OAuth Token

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Slack Bot User OAuth Token (starts with `xoxb-`) |
| `SLACK_CHANNEL` | No | Channel ID override (defaults to `product-showcases`) |

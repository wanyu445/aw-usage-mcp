# aw-usage-mcp

MCP Server that turns [ActivityWatch](https://activitywatch.net/) data into intelligent app usage summaries — smart session merging, AFK-based blocking, and cross-device timeline (computer + phone).

## Quick Start

```bash
# 1. ActivityWatch must be running
# 2. Install this package
npm install -g aw-usage-mcp

# 3. Add to your MCP client config:
```

```json
{
  "mcpServers": {
    "aw-usage": {
      "command": "node",
      "args": ["path/to/aw-usage-mcp/index.js"]
    }
  }
}
```

Then your Agent can use two tools:

| Tool | Purpose |
|---|---|
| `get_usage_summary` | Quick check-in — one line per source, saves context |
| `get_usage_sessions` | Full timeline with blocks, per-app breakdown, window titles |

## CLI Usage

```bash
# Quick summary (default 3h)
npx aw-usage summary
npx aw-usage summary --hours 6 --phone

# Full timeline
npx aw-usage sessions
npx aw-usage sessions --hours 24 --computer
```

## Features

**Smart Blocking** — Raw AFK heartbeats are merged into meaningful activity blocks. 5-minute inactivity gaps automatically split segments.

**Cross-Device Timeline** — Computer and phone data from ActivityWatch is merged into a unified view, automatically labeled (电脑 / 手机 / 电脑+手机).

**Two-Layer Design** — `summary` for quick state checks (Agent-friendly, low token usage), `sessions` for detailed drill-down.

## Phone Sync (Optional)

To track phone usage alongside your computer:

**Option A (Recommended):** Install [ActivityWatch Android App](https://activitywatch.net/downloads/) on your phone — data syncs automatically.

**Option B (Tasker):** The package includes `lib/phone-sync/tasker-receiver.js` — a lightweight HTTP server that receives app events from Tasker and forwards them to ActivityWatch. It works on any platform.

**Option C (ADB):** The package bundles platform-appropriate ADB via postinstall.

```bash
# Start Tasker receiver
node lib/phone-sync/tasker-receiver.js

# Sync Android ActivityWatch data via ADB
node lib/phone-sync/aw-phone-sync.js --adb
```

## Requirements

- [ActivityWatch](https://activitywatch.net/downloads/) running (default: `localhost:5600`)
- Node.js >= 18
- Optional: ADB for ADB-based phone sync

## License

MIT

#!/usr/bin/env node
const { SessionService, formatSummary, formatTimeline } = require("../lib/session-service");

const args = process.argv.slice(2);
const command = args[0] || "summary";
const opts = {};

for (let i = 1; i < args.length; i++) {
  switch (args[i]) {
    case "--phone": opts.source = "phone"; break;
    case "--computer": opts.source = "computer"; break;
    case "--hours": opts.hours = parseInt(args[++i]) || 3; break;
    case "--since": opts.since = args[++i] || ""; break;
    case "--limit": opts.limit = parseInt(args[++i]) || 0; break;
    case "--help": printHelp(); process.exit(0);
  }
}

function printHelp() {
  console.log(`
Usage: aw-usage <command> [options]

Commands:
  summary              Quick usage summary (default)
  sessions             Full timeline with blocks

Options:
  --phone              Filter: phone only
  --computer           Filter: computer only
  --hours N            Lookback window (default: 3)
  --since ISO          Explicit start time
  --limit N            Max results
  --help               Show this help
`);
}

const service = new SessionService();
service.getSessions(opts).then((r) => {
  if (command === "summary" || command === "s") {
    console.log(formatSummary(r, opts.hours || 3));
  } else if (command === "sessions" || command === "ss") {
    console.log(formatTimeline(r));
  } else {
    console.log("Unknown command. Use --help for usage.");
  }
}).catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

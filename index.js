#!/usr/bin/env node
const { SessionService, formatSummary, formatTimeline } = require("./lib/session-service");

const service = new SessionService();

// MCP stdio transport — JSON-RPC 2.0 over stdin/stdout
function sendMsg(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(json + "\n");
}

async function handleRequest(req) {
  const { id, method, params = {} } = req;

  switch (method) {
    case "initialize":
      sendMsg({
        id,
        jsonrpc: "2.0",
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "aw-usage-mcp", version: "0.1.0" },
          capabilities: { tools: {} },
        },
      });
      break;

    case "notifications/initialized":
      // Client ready, nothing to do
      break;

    case "tools/list":
      sendMsg({
        id,
        jsonrpc: "2.0",
        result: {
          tools: [
            {
              name: "get_usage_summary",
              description: "Quick summary of total app usage time over a period. Returns one line per source: total time + top apps. Use this for quick check-ins instead of the detailed timeline.",
              inputSchema: {
                type: "object",
                properties: {
                  source: {
                    type: "string",
                    description: "Filter: 'phone', 'computer', or empty for both.",
                  },
                  hours: {
                    type: "integer",
                    description: "How many hours to look back. Default 3.",
                  },
                },
                additionalProperties: false,
              },
            },
            {
              name: "get_usage_sessions",
              description: "Detailed app usage timeline with intelligent block merging. Returns sessions grouped into meaningful blocks based on AFK events. Includes per-app breakdown and window titles.",
              inputSchema: {
                type: "object",
                properties: {
                  source: {
                    type: "string",
                    description: "Filter: 'phone', 'computer', or empty for both.",
                  },
                  hours: {
                    type: "integer",
                    description: "How many hours to look back. Default 3.",
                  },
                  limit: {
                    type: "integer",
                    description: "Max blocks/sessions to return. 0 = all.",
                  },
                },
                additionalProperties: false,
              },
            },
          ],
        },
      });
      break;

    case "tools/call": {
      const { name, arguments: args } = params;

      if (name === "get_usage_summary") {
        try {
          const r = await service.getSessions({
            source: args?.source || "",
            hours: args?.hours || 3,
          });
          const text = formatSummary(r, args?.hours || 3);
          sendMsg({ id, jsonrpc: "2.0", result: { content: [{ type: "text", text }], data: r } });
        } catch (err) {
          sendMsg({ id, jsonrpc: "2.0", error: { code: -32603, message: err.message } });
        }
        break;
      }

      if (name === "get_usage_sessions") {
        try {
          const r = await service.getSessions({
            source: args?.source || "",
            hours: args?.hours || 3,
            limit: args?.limit || 0,
          });
          const text = formatTimeline(r);
          sendMsg({ id, jsonrpc: "2.0", result: { content: [{ type: "text", text }], data: r } });
        } catch (err) {
          sendMsg({ id, jsonrpc: "2.0", error: { code: -32603, message: err.message } });
        }
        break;
      }

      sendMsg({ id, jsonrpc: "2.0", error: { code: -32601, message: `Unknown tool: ${name}` } });
      break;
    }

    default:
      if (id !== undefined) {
        sendMsg({ id, jsonrpc: "2.0", error: { code: -32601, message: `Unknown method: ${method}` } });
      }
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const req = JSON.parse(line);
      handleRequest(req);
    } catch {
      // ignore malformed JSON
    }
  }
});

process.stdin.on("end", () => process.exit(0));

// Send startup log to stderr (not stdout — MCP protocol uses stdout for JSON-RPC)
process.stderr.write("[aw-usage-mcp] ActivityWatch Usage MCP Server started\n");
process.stderr.write("[aw-usage-mcp] Connect to ActivityWatch at localhost:5600\n");

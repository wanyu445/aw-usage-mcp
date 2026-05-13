#!/usr/bin/env node
/**
 * tasker-receiver.js — Lightweight HTTP server that receives Tasker push data
 * and injects it into the Windows ActivityWatch server as events.
 *
 * Usage:
 *   node scripts/tasker-receiver.js                    # default port 5602
 *   node scripts/tasker-receiver.js --port 5602
 *
 * Tasker config on Android:
 *   Action: HTTP Post
 *   URL: http://<WINDOWS_LAN_IP>:5602/api/heartbeat
 *   Headers: Content-Type: application/json
 *   Body: {"app":"com.example.app","label":"抖音"}
 *
 * For continuous monitoring, use a Tasker profile:
 *   Profile: App > any app opened
 *   Task: HTTP Post with the current app info
 */

const http = require("http");
const path = require("path");
const os = require("os");

const WIN_AW_HOST = "localhost";
const WIN_AW_PORT = 5600;
const PHONE_HOSTNAME = "android_tasker";

function parseArgs() {
  const args = process.argv.slice(2);
  let port = 5602;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") port = parseInt(args[++i], 10) || 5602;
    if (args[i] === "--help") {
      console.log(`
Usage: node scripts/tasker-receiver.js [options]

Options:
  --port PORT  Listen port (default: 5602)
  --help       Show this help

Tasker HTTP Post config:
  URL:    http://<WINDOWS_LAN_IP>:PORT/api/heartbeat
  Method: POST
  Content-Type: application/json
  Body:   {"app":"com.example.app","label":"抖音"}
      `);
      process.exit(0);
    }
  }
  return { port };
}

function postToAw(endpoint, body) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const options = {
      hostname: WIN_AW_HOST,
      port: WIN_AW_PORT,
      path: `/api/0${endpoint}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(json),
      },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, data: data.slice(0, 200) }));
    });
    req.on("error", reject);
    req.write(json);
    req.end();
  });
}

function getWinBuckets() {
  return new Promise((resolve, reject) => {
    http.get(`http://${WIN_AW_HOST}:${WIN_AW_PORT}/api/0/buckets`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
      });
    }).on("error", reject);
  });
}

async function ensureBuckets() {
  const appBucket = `tasker-phone-app_${PHONE_HOSTNAME}`;
  const afkBucket = `tasker-phone-afk_${PHONE_HOSTNAME}`;
  const existing = await getWinBuckets();

  const toCreate = [];
  if (!existing[appBucket]) {
    toCreate.push(
      postToAw(`/buckets/${encodeURIComponent(appBucket)}`, {
        client: "tasker-receiver",
        type: "app",
        hostname: PHONE_HOSTNAME,
      })
    );
  }
  if (!existing[afkBucket]) {
    toCreate.push(
      postToAw(`/buckets/${encodeURIComponent(afkBucket)}`, {
        client: "tasker-receiver",
        type: "afkstatus",
        hostname: PHONE_HOSTNAME,
      })
    );
  }
  if (toCreate.length) {
    await Promise.all(toCreate);
    console.log(`[tasker-receiver] buckets created on Windows AW`);
  }
  return { appBucket, afkBucket };
}

/**
 * Handle heartbeat from Tasker.
 * Body: { app: "com.example.package", label: "抖音" }
 * If screenOn: false — marks as AFK.
 * If screenOn: true / label provided — logs as app usage.
 */
async function handleHeartbeat(body) {
  const { appBucket, afkBucket } = await ensureBuckets();

  const app = String(body.app || body.package || "").trim();
  const label = String(body.label || body.appName || "").trim();
  const screenOn = body.screenOn !== false; // default true
  const now = new Date().toISOString();
  const appName = label || app || "unknown";

  // Push app heartbeat to Windows AW
  await postToAw(`/buckets/${encodeURIComponent(appBucket)}/heartbeat?pulsetime=60`, {
    timestamp: now,
    duration: 1,
    data: {
      app: appName,
      package: app,
      label: label,
    },
  });

  // Push AFK status
  await postToAw(`/buckets/${encodeURIComponent(afkBucket)}/heartbeat?pulsetime=120`, {
    timestamp: now,
    duration: 1,
    data: {
      status: screenOn ? "not-afk" : "afk",
    },
  });

  const status = screenOn ? "not-afk" : "afk";
  console.log(`[tasker-receiver] ${now} app=${appName} status=${status}`);
  return { app: appName, status };
}

function startServer(port) {
  const server = http.createServer(async (req, res) => {
    const startTime = Date.now();

    // CORS headers for Tasker
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/heartbeat") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const data = JSON.parse(body);
          const result = await handleHeartbeat(data);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ...result, elapsed: Date.now() - startTime }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === "GET" && req.url === "/api/tasker-config") {
      // Returns Tasker configuration instructions
      const ips = getLanIps();
      const hostname = getHostname();
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Tasker 配置说明
================

在 Tasker 的 "HTTP 请求" 中使用以下地址：

  推荐（跨网络通用）：http://${hostname}:${port}/api/heartbeat
  或 IP 地址（当前网络）：http://${ips[0] || "你的电脑IP"}:${port}/api/heartbeat

HTTP 请求配置：
  方法: POST
  内容类型: application/json
  正文: {"app":"%app_name","label":"%app_name"}

  或者更多信息（推荐）：
  {"app":"%app_name","label":"%app_name","package":"%app_package","screenOn":%SCREEN}

注意：%app_name 等是 Tasker 内置变量，会自动替换为当前 APP 的信息。
`);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(port, "0.0.0.0", () => {
    const ips = getLanIps();
    const hostname = getHostname();
    console.log(`[tasker-receiver] listening on 0.0.0.0:${port}`);
    console.log(`[tasker-receiver] Windows AW: http://${WIN_AW_HOST}:${WIN_AW_PORT}`);
    console.log(`[tasker-receiver] Tasker POST to:`);
    console.log(`  http://${hostname}:${port}/api/heartbeat  (hostname, recommended)`);
    ips.forEach((ip) => {
      console.log(`  http://${ip}:${port}/api/heartbeat`);
    });
    console.log(`[tasker-receiver] Tasker config: http://${hostname}:${port}/api/tasker-config`);
  });

  return server;
}

function getLanIps() {
  const ips = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      if (info.family === "IPv4" && !info.internal) {
        ips.push(info.address);
      }
    }
  }
  return ips.length ? ips : ["localhost"];
}

function getHostname() {
  return "10.243.167.23";
}

function main() {
  const opts = parseArgs();
  startServer(opts.port);
}

main();

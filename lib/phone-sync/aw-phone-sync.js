#!/usr/bin/env node
/**
 * aw-phone-sync.js — Sync Android ActivityWatch data to Windows AW server.
 *
 * Usage:
 *   node scripts/aw-phone-sync.js --adb                  # Auto-ADB mode
 *   node scripts/aw-phone-sync.js --adb --interval 60    # Sync every 60s
 *   node scripts/aw-phone-sync.js --phone-ip localhost --phone-port 5601  # Manual forward
 *
 * Options:
 *   --adb         Use ADB (WiFi/USB) to auto-forward phone AW port to localhost:5601
 *   --phone-ip    Phone AW host (default: localhost, used with --phone-port when ADB forward is set)
 *   --phone-port  Phone AW port (default: 5600)
 *   --interval    Sync interval in seconds (default: 120, 0 = run once)
 *   --once        Run once and exit
 *   --cursor      Cursor file path (default: ~/.cyberboss/aw-phone-sync-cursor.json)
 *   --win-host    Windows AW host (default: localhost)
 *   --win-port    Windows AW port (default: 5600)
 *   --help        Show this help
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { execSync, spawn } = require("child_process");

const ADB_BIN = path.resolve(__dirname, "adb" + (process.platform === "win32" ? ".exe" : ""));
const PHONE_FORWARD_PORT = 5601;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    adb: false,
    phoneIp: "localhost",
    phonePort: 5600,
    interval: 120,
    cursorFile: path.join(os.homedir(), ".cyberboss", "aw-phone-sync-cursor.json"),
    winHost: "localhost",
    winPort: 5600,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--adb":
        opts.adb = true;
        break;
      case "--phone-ip":
        opts.phoneIp = args[++i] || "";
        break;
      case "--phone-port":
        opts.phonePort = parseInt(args[++i], 10) || 5600;
        break;
      case "--interval":
        opts.interval = Math.max(0, parseInt(args[++i], 10) || 0);
        break;
      case "--once":
        opts.interval = 0;
        break;
      case "--cursor":
        opts.cursorFile = args[++i] || opts.cursorFile;
        break;
      case "--win-host":
        opts.winHost = args[++i] || opts.winHost;
        break;
      case "--win-port":
        opts.winPort = parseInt(args[++i], 10) || opts.winPort;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage: node scripts/aw-phone-sync.js [options]

Phone sync options:
  --adb             Auto-manage ADB forward (WiFi/USB). Uses phone's AW on localhost:5601.
  --phone-ip        Phone AW host (default: localhost)
  --phone-port      Phone AW port (default: 5600)
  --interval N      Sync every N seconds (default: 120, 0 = one-shot)
  --once            Run once and exit

Windows AW options:
  --win-host        Windows AW host (default: localhost)
  --win-port        Windows AW port (default: 5600)

Other:
  --cursor          Cursor file path
  --help            Show this help

First-time WiFi ADB setup:
  1. Phone: Settings > About Phone > tap Build Number 7x (enable Developer Options)
  2. Phone: Settings > Developer Options > Wireless debugging > enable
  3. Tap "Pair device with pairing code", note IP:PORT + code
  4. Run:  ${ADB_BIN} pair <IP>:<PORT> <CODE>
  5. Then: ${ADB_BIN} connect <PHONE-IP>:5555
  6. Then run this script with --adb
`);
}

function adb(...args) {
  const result = execSync(`"${ADB_BIN}" ${args.map(a => `"${a}"`).join(" ")}`, {
    encoding: "utf8",
    timeout: 15000,
  });
  return result.trim();
}

async function ensureAdbForward() {
  // Check if already forwarded
  try {
    const forwards = adb("forward", "--list");
    if (forwards.includes(`tcp:${PHONE_FORWARD_PORT}`)) {
      return true;
    }
  } catch {
    // not connected yet
  }

  // Check if any device is connected
  try {
    const devices = adb("devices");
    if (devices.includes("device\n")) {
      // Device already connected but no forward yet
      adb("forward", `tcp:${PHONE_FORWARD_PORT}`, "tcp:5600");
      console.log(`[aw-phone-sync] ADB forward: localhost:${PHONE_FORWARD_PORT} → phone:5600`);
      return true;
    }
  } catch {
    // no device
  }

  console.error(`[aw-phone-sync] No Android device connected.
  Make sure your phone is on the same WiFi and run:
    ${ADB_BIN} connect <PHONE_IP>:5555`);
  return false;
}

function apiUrl(host, port, endpoint) {
  return `http://${host}:${port}/api/0${endpoint}`;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpGet(res.headers.location).then(resolve).catch(reject);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    }).on("error", reject);
  });
}

function httpPostJson(url, body) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(json),
      },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else {
          resolve({ _status: res.statusCode, _body: data.slice(0, 500) });
        }
      });
    });
    req.on("error", reject);
    req.write(json);
    req.end();
  });
}

function loadCursor(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

function saveCursor(file, cursor) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cursor, null, 2), "utf8");
}

const tsToMs = (ts) => new Date(ts).getTime();

async function syncPhoneToWindows(opts) {
  const phoneBase = `http://${opts.phoneIp}:${opts.phonePort}`;
  const winBase = `http://${opts.winHost}:${opts.winPort}`;
  const cursor = loadCursor(opts.cursorFile);
  let syncedBuckets = 0;
  let syncedEvents = 0;

  if (opts.adb) {
    const ok = await ensureAdbForward();
    if (!ok) return false;
  }

  console.log(`[aw-phone-sync] ${new Date().toISOString()} syncing ${phoneBase} → ${winBase}`);

  // 1. Get phone buckets
  let phoneBuckets;
  try {
    phoneBuckets = await apiUrl(opts.phoneIp, opts.phonePort, "/buckets");
    console.log(`[aw-phone-sync] phone buckets: ${Object.keys(phoneBuckets).length} found`);
  } catch (err) {
    console.error(`[aw-phone-sync] cannot reach phone at ${phoneBase}: ${err.message}`);
    if (opts.adb) {
      console.error("[aw-phone-sync]   Try reconnecting: adb reconnect");
    }
    return false;
  }

  // Windows buckets
  let winBuckets;
  try {
    winBuckets = await apiUrl(opts.winHost, opts.winPort, "/buckets");
  } catch (err) {
    console.error(`[aw-phone-sync] cannot reach Windows AW at ${winBase}: ${err.message}`);
    return false;
  }

  for (const [phoneBucketId, phoneBucketMeta] of Object.entries(phoneBuckets)) {
    const winBucketId = `aw-android_${phoneBucketId}`;

    if (!winBuckets[winBucketId]) {
      try {
        await httpPostJson(apiUrl(opts.winHost, opts.winPort, `/buckets/${encodeURIComponent(winBucketId)}`), {
          client: `aw-phone-sync_${phoneBucketId}`,
          type: `${phoneBucketMeta.type || "app"}`,
          hostname: `android_${phoneBucketMeta.hostname || "phone"}`,
        });
        winBuckets[winBucketId] = true;
      } catch (err) {
        console.error(`[aw-phone-sync]   create bucket ${winBucketId} failed: ${err.message}`);
        continue;
      }
    }

    const lastSync = cursor[phoneBucketId] || null;
    let phoneEvents;
    try {
      let url = `/buckets/${encodeURIComponent(phoneBucketId)}/events?limit=5000`;
      if (lastSync) {
        url += `&start=${encodeURIComponent(lastSync)}`;
      } else {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        url += `&start=${encodeURIComponent(yesterday)}`;
      }
      phoneEvents = await apiUrl(opts.phoneIp, opts.phonePort, url);
      if (!Array.isArray(phoneEvents)) continue;
    } catch (err) {
      console.error(`[aw-phone-sync]   get events ${phoneBucketId} failed: ${err.message}`);
      continue;
    }

    if (phoneEvents.length === 0) continue;

    try {
      await httpPostJson(
        apiUrl(opts.winHost, opts.winPort, `/buckets/${encodeURIComponent(winBucketId)}/events`),
        phoneEvents
      );
      syncedEvents += phoneEvents.length;
      syncedBuckets++;
    } catch (err) {
      console.error(`[aw-phone-sync]   push to ${winBucketId} failed: ${err.message}`);
      continue;
    }

    const maxTs = phoneEvents.reduce((max, e) => {
      const ets = tsToMs(e.timestamp);
      return ets > max ? ets : max;
    }, 0);
    if (maxTs > 0) {
      cursor[phoneBucketId] = new Date(maxTs).toISOString();
    }
  }

  saveCursor(opts.cursorFile, cursor);
  console.log(`[aw-phone-sync] done: ${syncedBuckets} buckets, ${syncedEvents} events synced`);

  if (syncedBuckets === 0 && syncedEvents === 0) {
    console.log("[aw-phone-sync] (nothing new to sync)");
  }

  return true;
}

async function main() {
  const opts = parseArgs();

  if (!opts.adb && opts.phoneIp === "localhost" && opts.phonePort === 5600) {
    // Default: check if we actually mean ADB mode
    const hasAdb = fs.existsSync(ADB_BIN);
    if (hasAdb) {
      try {
        const devices = adb("devices");
        if (devices.includes("device\n")) {
          opts.adb = true;
        }
      } catch {}
    }
  }

  if (opts.adb) {
    opts.phoneIp = "localhost";
    opts.phonePort = PHONE_FORWARD_PORT;
    console.log(`[aw-phone-sync] ADB mode: forwarding phone:5600 → localhost:${PHONE_FORWARD_PORT}`);
  }

  const runOnce = async () => {
    try { await syncPhoneToWindows(opts); }
    catch (err) { console.error(`[aw-phone-sync] sync error: ${err.message}`); }
  };

  if (opts.interval <= 0) {
    await runOnce();
    return;
  }

  console.log(`[aw-phone-sync] periodic mode, interval=${opts.interval}s`);
  await runOnce();
  setInterval(runOnce, opts.interval * 1000);
}

main().catch((err) => {
  console.error(`[aw-phone-sync] fatal: ${err.message}`);
  process.exit(1);
});

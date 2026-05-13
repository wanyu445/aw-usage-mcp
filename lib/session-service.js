const http = require("http");

const AW_API_BASE = "http://localhost:5600/api/0";
const AFK_GAP_THRESHOLD_MS = 5 * 60 * 1000; // 5min gap → assume AFK

class SessionService {
  constructor({ awBaseUrl } = {}) {
    this.awBaseUrl = awBaseUrl || AW_API_BASE;
  }

  async getSessions({ since = "", hours, mergeMinutes, limit, source = "" } = {}) {
    const sinceParam = since || new Date(Date.now() - (hours || 3) * 3600000).toISOString();
    const sessionLimit = limit > 0 ? limit : 0;

    const allBuckets = await this.listBuckets();
    const usageBuckets = pickUsageBuckets(allBuckets, source);
    if (!usageBuckets.length) return emptyResult();

    const sources = new Set();
    const allSessions = [];
    for (const { id, type, hostname } of usageBuckets) {
      const events = await this.fetchEvents(id, sinceParam);
      sources.add(hostname || "");
      const sessions = type === "afkstatus"
        ? []
        : buildSessions(events, id, hostname, mergeMinutes || 5);
      allSessions.push(...sessions);
    }
    if (!allSessions.length) return emptyResult();

    const filtered = allSessions.filter((s) => !isNoiseSession(s));

    let blocks;
    if (source) {
      blocks = await this.groupWithAfk(filtered, sinceParam, source);
    } else {
      const phoneSessions = filtered.filter((s) => !/\.exe$/i.test(s.app));
      const compSessions = filtered.filter((s) => /\.exe$/i.test(s.app));
      blocks = await this.buildMergedBlocks(phoneSessions, compSessions, sinceParam);
    }

    const top = sessionLimit > 0 ? blocks.slice(0, sessionLimit) : blocks;
    const totalDurationMs = filtered.reduce((sum, s) => sum + (s.durationMs || 0), 0);
    const appTotals = aggregateAppTotals(filtered);

    return {
      source: sources.size === 1 ? [...sources][0] : "both",
      sessionCount: filtered.length,
      blockCount: blocks.length,
      displayedCount: top.length,
      totalDurationMinutes: Math.round(totalDurationMs / 60000),
      topApps: appTotals.slice(0, 10).map((a) => ({
        ...a,
        source: a.app.endsWith(".exe") ? "电脑" : "手机",
      })),
      blocks: top,
    };
  }

  async groupWithAfk(sessions, sinceParam, sourceFilter) {
    if (!sessions.length) return [];

    const allBuckets = await this.listBuckets();
    const afkPrefix = sourceFilter === "phone" ? "tasker-phone-afk_" : "aw-watcher-afk_";
    const afkBucket = Object.keys(allBuckets).find((id) => id.startsWith(afkPrefix));
    if (!afkBucket) {
      return sessions.map((s) => ({ kind: "session", ...s }));
    }

    const afkEvents = await this.fetchEvents(afkBucket, sinceParam);
    if (!afkEvents.length) {
      return sessions.map((s) => ({ kind: "session", ...s }));
    }

    const activeWindows = buildActiveWindows(afkEvents);
    const chrono = [...sessions].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const result = [];

    for (const win of activeWindows) {
      const inWindow = chrono.filter((s) => {
        const sStart = Date.parse(s.start);
        return sStart >= win.start && sStart < win.end;
      });
      if (!inWindow.length) continue;

      const apps = new Set(inWindow.map((s) => s.app));
      const appCounts = new Map();
      for (const s of inWindow) appCounts.set(s.app, (appCounts.get(s.app) || 0) + 1);
      const hasRepeats = [...appCounts.values()].some((c) => c >= 2);
      const fragmented = apps.size >= 2 && hasRepeats && inWindow.length >= 3;

      if (fragmented) {
        result.push({
          kind: "block",
          start: inWindow[0].start,
          end: inWindow[inWindow.length - 1].end,
          durationMinutes: Math.round(
            (Date.parse(inWindow[inWindow.length - 1].end) -
              Date.parse(inWindow[0].start)) / 60000
          ),
          sessionCount: inWindow.length,
          source: sourceFilter === "phone" ? "手机" : "电脑",
          apps: aggregateBlockApps(inWindow),
          windows: buildBlockWindows(inWindow),
        });
      } else {
        for (const s of inWindow) result.push({ kind: "session", ...s });
      }
    }

    // Sessions before first active window
    const firstStart = activeWindows.length ? activeWindows[0].start : 0;
    const foreleft = firstStart ? chrono.filter((s) => Date.parse(s.start) < firstStart) : [];
    for (const s of foreleft) result.push({ kind: "session", ...s });

    // Sessions after last active window
    const lastEnd = activeWindows.length ? activeWindows[activeWindows.length - 1].end : 0;
    const leftover = lastEnd ? chrono.filter((s) => Date.parse(s.start) >= lastEnd) : chrono;
    if (leftover.length) {
      const apps = new Set(leftover.map((s) => s.app));
      const appCounts = new Map();
      for (const s of leftover) appCounts.set(s.app, (appCounts.get(s.app) || 0) + 1);
      const hasRepeats = [...appCounts.values()].some((c) => c >= 2);
      const fragmented = apps.size >= 2 && hasRepeats && leftover.length >= 3;
      if (fragmented) {
        result.push({
          kind: "block",
          start: leftover[0].start,
          end: leftover[leftover.length - 1].end,
          durationMinutes: Math.round(
            (Date.parse(leftover[leftover.length - 1].end) -
              Date.parse(leftover[0].start)) / 60000
          ),
          sessionCount: leftover.length,
          source: sourceFilter === "phone" ? "手机" : "电脑",
          apps: aggregateBlockApps(leftover),
          windows: buildBlockWindows(leftover),
        });
      } else {
        for (const s of leftover) result.push({ kind: "session", ...s });
      }
    }

    return result;
  }

  async buildMergedBlocks(phoneSessions, compSessions, sinceParam) {
    const [compWindows, phoneWindows] = await Promise.all([
      this.getActiveWindows("computer", sinceParam),
      this.getActiveWindows("phone", sinceParam),
    ]);
    const segments = mergeActiveWindows(compWindows, phoneWindows);
    return buildBlocksFromSegments(phoneSessions, compSessions, segments);
  }

  async getActiveWindows(source, sinceParam) {
    const allBuckets = await this.listBuckets();
    const prefix = source === "phone" ? "tasker-phone-afk_" : "aw-watcher-afk_";
    const bid = Object.keys(allBuckets).find((id) => id.startsWith(prefix));
    if (!bid) return [];
    const events = await this.fetchEvents(bid, sinceParam);
    if (!events.length) return [];
    return buildActiveWindows(events);
  }

  async listBuckets() {
    return this.apiGet("/buckets");
  }

  async fetchEvents(bucketId, since) {
    return this.apiGet(
      `/buckets/${encodeURIComponent(bucketId)}/events?limit=10000&start=${encodeURIComponent(since)}`
    );
  }

  apiGet(endpoint) {
    return new Promise((resolve, reject) => {
      const url = `${this.awBaseUrl}${endpoint}`;
      http.get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve([]);
            }
          } else {
            resolve([]);
          }
        });
      }).on("error", (err) => {
        if (err.code === "ECONNREFUSED") {
          resolve([]);
        } else {
          reject(err);
        }
      });
    });
  }
}

// --- Pure functions ---

function buildActiveWindows(afkEvents) {
  const sorted = [...afkEvents]
    .filter((e) => e.data && e.data.status)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const windows = [];
  let activeStart = null;
  let lastEnd = 0;

  for (const e of sorted) {
    const ts = Date.parse(e.timestamp);
    const dur = (Number(e.duration) || 0) * 1000;
    const end = ts + dur;
    const isAfk = e.data.status === "afk";

    const gapMs = activeStart !== null ? ts - lastEnd : 0;
    const gapAfk = gapMs > AFK_GAP_THRESHOLD_MS;

    if (isAfk || gapAfk) {
      if (activeStart !== null) {
        windows.push({ start: activeStart, end: isAfk ? ts : lastEnd });
        activeStart = null;
      }
      if (!isAfk) {
        activeStart = ts;
      }
    } else {
      if (activeStart === null) activeStart = ts;
    }
    lastEnd = Math.max(lastEnd, end);
  }
  if (activeStart !== null) {
    const now = Date.now();
    if (lastEnd > 0 && now - lastEnd > AFK_GAP_THRESHOLD_MS) {
      windows.push({ start: activeStart, end: lastEnd });
    } else {
      windows.push({ start: activeStart, end: now });
    }
  }
  return windows;
}

function buildSessions(events, bucketId, hostname, mergeMinutes) {
  if (!events || !events.length) return [];
  const sorted = [...events].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
  );
  const sessions = [];
  let current = null;
  const mergeWindow = mergeMinutes * 60 * 1000;

  for (const e of sorted) {
    if (!e.data) continue;
    const app = e.data.app || e.data.title || "unknown";
    const ts = Date.parse(e.timestamp);
    const dur = (Number(e.duration) || 0) * 1000;

    if (
      current &&
      current.app === app &&
      ts - (current.lastSeen || 0) <= mergeWindow
    ) {
      current.lastSeen = Math.max(current.lastSeen || 0, ts + dur);
      current.durationMs = current.lastSeen - current.start;
      if (e.data.title) {
        if (!current.windowTitles) current.windowTitles = [];
        if (!current.windowTitles.includes(e.data.title))
          current.windowTitles.push(e.data.title);
      }
    } else {
      if (current) sessions.push(current);
      current = {
        app,
        start: ts,
        lastSeen: ts + dur,
        durationMs: dur,
        windowTitles: e.data.title ? [e.data.title] : [],
        bucketId,
        source: hostname,
      };
    }
  }
  if (current) sessions.push(current);

  return sessions.map((s) => ({
    ...s,
    start: new Date(s.start).toISOString(),
    end: new Date(s.lastSeen).toISOString(),
    durationMinutes: Math.max(1, Math.round(s.durationMs / 60000)),
    lastSeen: undefined,
  }));
}

function isNoiseSession(s) {
  const noiseApps = [
    "unknown", "屏保", "screen", "screensaver", "锁屏",
    "com.android.systemui", "com.android.systemui.screen",
  ];
  if (noiseApps.includes(s.app)) return true;
  if (s.durationMs < 2000) return true;
  return false;
}

function aggregateAppTotals(sessions) {
  const map = new Map();
  for (const s of sessions) {
    map.set(s.app, (map.get(s.app) || 0) + (s.durationMs || 0));
  }
  return [...map.entries()]
    .map(([app, ms]) => ({
      app,
      totalMinutes: Math.round(ms / 60000),
      totalSeconds: Math.round(ms / 1000),
    }))
    .sort((a, b) => b.totalMinutes - a.totalMinutes);
}

function aggregateBlockApps(sessions) {
  const map = new Map();
  for (const s of sessions) {
    map.set(s.app, (map.get(s.app) || 0) + (s.durationMs || 0));
  }
  return [...map.entries()]
    .map(([app, ms]) => ({
      app,
      totalMinutes: Math.round(ms / 60000),
      totalSeconds: Math.round(ms / 1000),
    }))
    .sort((a, b) => b.totalMinutes - a.totalMinutes);
}

function mergeActiveWindows(compWindows, phoneWindows) {
  const points = new Set();
  for (const w of compWindows) { points.add(w.start); points.add(w.end); }
  for (const w of phoneWindows) { points.add(w.start); points.add(w.end); }
  const sorted = [...points].sort((a, b) => a - b);
  const segments = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    const compActive = compWindows.some((w) => start >= w.start && end <= w.end);
    const phoneActive = phoneWindows.some((w) => start >= w.start && end <= w.end);
    if (!compActive && !phoneActive) continue;
    const type = compActive && phoneActive ? "电脑+手机" : compActive ? "电脑" : "手机";
    segments.push({ type, start, end });
  }
  return segments;
}

function buildBlocksFromSegments(phoneSessions, compSessions, segments) {
  const result = [];
  for (const seg of segments) {
    const srcSessions =
      seg.type === "电脑" ? compSessions
      : seg.type === "手机" ? phoneSessions
      : [...compSessions, ...phoneSessions];
    const inSeg = srcSessions.filter((s) => {
      const sStart = Date.parse(s.start);
      return sStart >= seg.start && sStart < seg.end;
    });
    if (!inSeg.length) continue;

    const apps = new Set(inSeg.map((s) => s.app));
    const appCounts = new Map();
    for (const s of inSeg) appCounts.set(s.app, (appCounts.get(s.app) || 0) + 1);
    const hasRepeats = [...appCounts.values()].some((c) => c >= 2);
    const fragmented = apps.size >= 2 && hasRepeats && inSeg.length >= 3;

    if (fragmented) {
      result.push({
        kind: "block",
        source: seg.type,
        start: new Date(seg.start).toISOString(),
        end: new Date(seg.end).toISOString(),
        durationMinutes: Math.max(1, Math.round((seg.end - seg.start) / 60000)),
        sessionCount: inSeg.length,
        apps: aggregateBlockApps(inSeg),
        windows: buildBlockWindows(inSeg),
      });
    } else {
      for (const s of inSeg) result.push({ kind: "session", ...s });
    }
  }
  return result;
}

function cleanWindowTitle(title) {
  let t = title
    .replace(/ 和另外 \d+ 个页面.*$/, "")
    .replace(/ - (个人 - )?Microsoft Edge$/, "")
    .replace(/ -?联想浏览器$/, "")
    .replace(/ 和另外 \d+ 个窗口$/, "")
    .replace(/\(.*?\)/g, "").trim();
  t = t.replace(/([a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,})\/.*/g, "$1");
  return t;
}

function buildBlockWindows(sessions) {
  const byApp = new Map();
  for (const s of sessions) {
    if (!s.windowTitles || !s.windowTitles.length) continue;
    const existing = byApp.get(s.app) || { app: s.app, titles: new Set(), totalMs: 0 };
    for (const t of s.windowTitles) {
      const cleaned = cleanWindowTitle(t);
      if (cleaned) existing.titles.add(cleaned);
    }
    existing.totalMs += s.durationMs || 0;
    byApp.set(s.app, existing);
  }
  return [...byApp.values()]
    .map(({ app, titles, totalMs }) => ({
      app,
      titles: [...titles],
      totalMinutes: Math.round(totalMs / 60000),
    }))
    .sort((a, b) => b.totalMinutes - a.totalMinutes);
}

function pickUsageBuckets(buckets, sourceFilter) {
  if (!buckets || typeof buckets !== "object") return [];
  return Object.entries(buckets)
    .filter(([id, meta]) => {
      if (meta.type === "afkstatus" || meta.type === "afk") return false;
      if (!id.includes("watcher") && !id.includes("tasker")) return false;
      if (sourceFilter === "phone" && !id.includes("tasker")) return false;
      if (sourceFilter === "computer" && !id.includes("watcher")) return false;
      return true;
    })
    .map(([id, meta]) => ({
      id,
      type: meta.type,
      hostname: meta.hostname || "",
    }));
}

function emptyResult() {
  return {
    source: "",
    sessionCount: 0,
    blockCount: 0,
    displayedCount: 0,
    totalDurationMinutes: 0,
    topApps: [],
    blocks: [],
  };
}

// --- CLI helpers ---

function formatSummary(r, hours) {
  if (!r.sessionCount) return "暂无使用数据";
  const pc = r.topApps.filter((a) => /\.exe$/i.test(a.app) && a.totalMinutes > 0);
  const ph = r.topApps.filter((a) => !/\.exe$/i.test(a.app) && a.totalMinutes > 0);
  const lines = [`最近 ${hours} 小时使用总结`];
  if (pc.length) lines.push("电脑：" + pc.map((a) => `${a.app} ${a.totalMinutes}m`).join("、"));
  if (ph.length) lines.push("手机：" + ph.map((a) => `${a.app} ${a.totalMinutes}m`).join("、"));
  lines.push(`总计 ${r.totalDurationMinutes}m，${r.blockCount} 个时段`);
  return lines.join("\n");
}

function formatTimeline(r) {
  if (!r.sessionCount) return "暂无数据";
  const label = r.source || "手机+电脑";
  const lines = [
    `来源: ${label} | 会话: ${r.sessionCount} | 合并块: ${r.blockCount} | 总时长: ${r.totalDurationMinutes}m\n`,
  ];

  const pcApps = r.topApps.filter((a) => /\.exe$/i.test(a.app) && a.totalMinutes > 0);
  const phoneApps = r.topApps.filter((a) => !/\.exe$/i.test(a.app) && a.totalMinutes > 0);
  if (pcApps.length) lines.push("电脑：" + pcApps.map((a) => `${a.app} ${a.totalMinutes}m`).join("、"));
  if (phoneApps.length) lines.push("手机：" + phoneApps.map((a) => `${a.app} ${a.totalMinutes}m`).join("、"));

  lines.push("\n--- 时间线 ---");
  const sorted = [...(r.blocks || [])].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (const item of sorted) {
    const st = new Date(item.start).toLocaleTimeString("zh-CN", {
      hour12: false, hour: "2-digit", minute: "2-digit",
    });
    const et = new Date(item.end).toLocaleTimeString("zh-CN", {
      hour12: false, hour: "2-digit", minute: "2-digit",
    });
    if (item.kind === "block") {
      const tag = item.source ? ` ${item.source}` : "";
      lines.push(`  📦 ${st}→${et} ${tag} ${item.durationMinutes}m`);
      for (const a of item.apps || []) {
        const d = a.totalMinutes >= 1 ? `${a.totalMinutes}m` : `${a.totalSeconds || 0}s`;
        lines.push(`    ${a.app}  ${d}`);
      }
    } else {
      const tag = /\.exe$/i.test(item.app) ? "电脑" : "手机";
      const titles = item.windowTitles?.length ? ` (${item.windowTitles.join(", ")})` : "";
      lines.push(`  ${st}→${et}  ${tag}  ${item.app}  ${item.durationMinutes}m${titles}`);
    }
  }
  return lines.join("\n");
}

module.exports = { SessionService, formatSummary, formatTimeline };

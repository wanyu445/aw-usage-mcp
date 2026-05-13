#!/usr/bin/env node
/**
 * download-adb.js — Postinstall script.
 * Downloads the platform-specific ADB binary from Google's official source.
 * The MCP Server works without ADB; this only enables optional phone sync.
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");
const os = require("os");

const TARGET_DIR = path.resolve(__dirname, "..", "lib", "phone-sync");
const ADB_NAME = process.platform === "win32" ? "adb.exe" : "adb";
const TARGET_PATH = path.join(TARGET_DIR, ADB_NAME);

const DOWNLOAD_URLS = {
  linux: "https://dl.google.com/android/repository/platform-tools-latest-linux.zip",
  darwin: "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip",
  win32: "https://dl.google.com/android/repository/platform-tools-latest-windows.zip",
};

function log(msg) {
  process.stderr.write(`[download-adb] ${msg}\n`);
}

function hasSystemAdb() {
  try {
    execSync("adb version", { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function getUnzipCommand(zipPath, extractDir) {
  if (process.platform === "win32") {
    return `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force 2>$null"`;
  }
  // Linux / macOS
  try {
    execSync("unzip -v", { stdio: "ignore" });
    return `unzip -o '${zipPath}' -d '${extractDir}' 2>/dev/null`;
  } catch {
    return null; // no unzip available
  }
}

async function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = https.get(url, (response) => {
      // Handle redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        download(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    });
    request.on("error", (err) => {
      file.close();
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

async function main() {
  // Already exists? Skip
  if (fs.existsSync(TARGET_PATH)) {
    log(`ADB already exists at ${TARGET_PATH}, skipping download`);
    return;
  }

  // Has system ADB? No need to download
  if (hasSystemAdb()) {
    log("System ADB found in PATH, skipping download");
    return;
  }

  const platform = process.platform;
  const url = DOWNLOAD_URLS[platform];
  if (!url) {
    log(`Unsupported platform: ${platform}. Install ADB manually.`);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "adb-dl-"));
  const zipPath = path.join(tmpDir, "platform-tools.zip");

  try {
    log(`Downloading ADB for ${platform}...`);
    await download(url, zipPath);

    const extractDir = path.join(tmpDir, "extract");
    fs.mkdirSync(extractDir, { recursive: true });

    const unzipCmd = getUnzipCommand(zipPath, extractDir);
    if (unzipCmd) {
      execSync(unzipCmd, { stdio: "ignore", timeout: 30000 });
    } else {
      log("unzip not found, install it manually: apt-get install unzip / brew install unzip");
      cleanUp(tmpDir);
      return;
    }

    const extractedAdb = path.join(extractDir, "platform-tools", ADB_NAME);
    if (fs.existsSync(extractedAdb)) {
      fs.mkdirSync(TARGET_DIR, { recursive: true });
      fs.copyFileSync(extractedAdb, TARGET_PATH);
      fs.chmodSync(TARGET_PATH, 0o755);
      log(`ADB installed at ${TARGET_PATH}`);
    } else {
      log(`ADB not found in extracted archive (expected: ${extractedAdb})`);
    }
  } catch (err) {
    log(`Download failed: ${err.message}. Install ADB manually.`);
  } finally {
    cleanUp(tmpDir);
  }
}

function cleanUp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

main();

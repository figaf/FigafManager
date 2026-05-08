#!/usr/bin/env node
// Assembles figaf-manager-app-<version>.zip for BTP Cockpit "Deploy Application".
//
// What it does:
//   1. Download Linux x86_64 btp + cf binaries (versions pinned in package.json)
//      into bin/ (skipped if already present)
//   2. Run  `npm ci --omit=dev`  to get production node_modules
//   3. Zip: cloud/, installer/, lib/, bin/btp, bin/cf, node_modules/,
//           manifest.yml, package.json, figaf-logo.png
//      → dist/figaf-manager-app-<version>.zip
//
// Requires: npm install (archiver available as devDependency)
// Run from inside figaf-manager/:  node scripts/build-zip.js

"use strict";
const fs   = require("fs");
const fsp  = fs.promises;
const path = require("path");
const os   = require("os");
const https = require("https");
const { execSync, spawnSync } = require("child_process");
const { createGunzip } = require("zlib");
const { Extract } = require("tar"); // Node built-in (via tar package if present) — fallback to tar CLI

const ROOT = path.join(__dirname, "..");
const pkg  = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

// Load archiver now (before npm ci --omit=dev removes devDependencies)
let archiver;
try {
  archiver = require("archiver");
} catch {
  console.error("\narchiver not found — run  npm install  first (installs devDependencies)");
  process.exit(1);
}

const VERSION      = pkg.version;
const BTP_VERSION  = pkg.btpCliVersion  || "2.106.1";

const BIN_DIR  = path.join(ROOT, "bin");
const DIST_DIR = path.join(ROOT, "dist");
const OUT_ZIP  = path.join(DIST_DIR, `figaf-manager-app-${VERSION}.zip`);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) { process.stdout.write(msg + "\n"); }

function httpsGet(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    function fetch(currentUrl, hops) {
      if (hops > 8) return reject(new Error("Too many redirects"));
      const headers = {
        "User-Agent": "figaf-manager-build",
        // Required by tools.hana.ondemand.com downloads
        "Cookie": "eula_3_2_agreed=tools.hana.ondemand.com/developer-license-3_2.txt",
      };
      https.get(currentUrl, { headers }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume(); // drain body so the socket closes and the event loop doesn't stall
          return fetch(res.headers.location, hops + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
        }
        const total = parseInt(res.headers["content-length"] || "0", 10);
        let got = 0;
        const out = fs.createWriteStream(destPath);
        res.on("data", (chunk) => {
          got += chunk.length;
          if (onProgress && total) onProgress(got, total);
        });
        res.pipe(out);
        out.on("finish", resolve);
        out.on("error", reject);
        res.on("error", reject);
      }).on("error", reject);
    }
    fetch(url, 0);
  });
}

function extractTarGz(tarPath, destDir, stripComponents = 1) {
  // Use system tar (available on macOS, Linux, and Windows 10+)
  const result = spawnSync("tar", [
    "-xzf", tarPath,
    "-C", destDir,
    `--strip-components=${stripComponents}`,
  ], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`tar extraction failed (exit ${result.status})`);
}

// ─── Step 1: Download CLI binaries ────────────────────────────────────────────

async function ensureBinaries() {
  await fsp.mkdir(BIN_DIR, { recursive: true });

  // btp CLI (Linux x86_64)
  const btpBin = path.join(BIN_DIR, "btp");
  if (!fs.existsSync(btpBin)) {
    const btpTarName = `btp-cli-linux-amd64-${BTP_VERSION}.tar.gz`;
    const btpUrl = `https://tools.hana.ondemand.com/additional/${btpTarName}`;
    const tmpTar = path.join(os.tmpdir(), btpTarName);
    log(`[btp] Downloading ${btpTarName}…`);
    await httpsGet(btpUrl, tmpTar, (got, total) =>
      process.stdout.write(`\r[btp] ${Math.round((got / total) * 100)}%   `));
    process.stdout.write("\n");
    log("[btp] Extracting…");
    extractTarGz(tmpTar, BIN_DIR);
    // The tarball may extract as 'btp' or include a subdirectory; find the binary
    const extracted = fs.readdirSync(BIN_DIR).find(f => f === "btp" || f.startsWith("btp"));
    if (!extracted || extracted !== "btp") {
      // Rename if needed
      const found = fs.readdirSync(BIN_DIR).find(f => !f.endsWith(".tar.gz") && !f.endsWith(".gitkeep"));
      if (found && found !== "btp") fs.renameSync(path.join(BIN_DIR, found), btpBin);
    }
    fs.chmodSync(btpBin, "755");
    try { fs.unlinkSync(tmpTar); } catch {}
    log("[btp] Done.");
  } else {
    log("[btp] Already in bin/ — skipping download.");
  }

  // cf CLI v8 (Linux x86_64) — stable channel always resolves to latest v8 release
  const cfBin = path.join(BIN_DIR, "cf");
  if (!fs.existsSync(cfBin)) {
    const cfUrl = "https://packages.cloudfoundry.org/stable?release=linux64-binary&version=v8&source=github";
    const tmpTar = path.join(os.tmpdir(), "cf8-cli-linux-x86-64.tar.gz");
    log("[cf]  Downloading cf CLI v8 (latest stable for linux64)…");
    await httpsGet(cfUrl, tmpTar, (got, total) =>
      total ? process.stdout.write(`\r[cf]  ${Math.round((got / total) * 100)}%   `) : null);
    process.stdout.write("\n");
    log("[cf]  Extracting…");
    extractTarGz(tmpTar, BIN_DIR, 0); // tarball puts 'cf8' at root
    // Rename cf8 → cf
    const cf8 = path.join(BIN_DIR, "cf8");
    if (fs.existsSync(cf8)) fs.renameSync(cf8, cfBin);
    fs.chmodSync(cfBin, "755");
    try { fs.unlinkSync(tmpTar); } catch {}
    log("[cf]  Done.");
  } else {
    log("[cf]  Already in bin/ — skipping download.");
  }
}

// ─── Step 2: npm ci --omit=dev ────────────────────────────────────────────────

function installProdDeps() {
  log("[npm] Running npm ci --omit=dev…");
  execSync("npm ci --omit=dev", { cwd: ROOT, stdio: "inherit" });
  log("[npm] Done.");
}

// ─── Step 3: Build zip ────────────────────────────────────────────────────────

async function buildZip() {
  await fsp.mkdir(DIST_DIR, { recursive: true });

  log(`[zip] Building ${path.basename(OUT_ZIP)}…`);

  const output = fs.createWriteStream(OUT_ZIP);
  const archive = archiver("zip", { zlib: { level: 6 } });

  await new Promise((resolve, reject) => {
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);

    // cloud/ — server + client + index.html
    archive.directory(path.join(ROOT, "cloud"), "cloud");

    // installer/ — React UI assets (mode-aware copies)
    archive.directory(path.join(ROOT, "installer"), "installer");

    // lib/ — host-agnostic orchestrator
    archive.directory(path.join(ROOT, "lib"), "lib");

    // bin/ — Linux btp + cf binaries (gitignored, populated above)
    archive.file(path.join(ROOT, "bin", "btp"), { name: "bin/btp" });
    archive.file(path.join(ROOT, "bin", "cf"),  { name: "bin/cf"  });

    // node_modules/ (production only, after npm ci --omit=dev)
    archive.directory(path.join(ROOT, "node_modules"), "node_modules");

    // Root files
    archive.file(path.join(ROOT, "manifest.yml"),     { name: "manifest.yml" });
    archive.file(path.join(ROOT, "package.json"),      { name: "package.json" });
    archive.file(path.join(ROOT, "figaf-logo.png"),    { name: "figaf-logo.png" });

    archive.finalize();
  });

  const bytes = fs.statSync(OUT_ZIP).size;
  const mb = (bytes / 1024 / 1024).toFixed(1);
  log(`[zip] Done → ${OUT_ZIP}  (${mb} MB)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  log(`\nfigaf-manager build  v${VERSION}`);
  log(`  btp CLI: ${BTP_VERSION}`);
  log(`  cf  CLI: v8 latest-stable\n`);

  const skipBinaries = process.argv.includes("--skip-binaries");
  const skipNpm      = process.argv.includes("--skip-npm");
  const skipZip      = process.argv.includes("--skip-zip");

  if (!skipBinaries) await ensureBinaries();
  if (!skipNpm)      installProdDeps();
  if (!skipZip) {
    await buildZip();
    log("\nBuild complete.");
    log(`Upload to BTP Cockpit → Space → Applications → Deploy Application:`);
    log(`  ${OUT_ZIP}`);
  } else {
    log("\nBinaries ready in bin/ — skipped zip build.");
  }
})().catch((err) => {
  console.error("\nBuild failed:", err.message);
  process.exit(1);
});

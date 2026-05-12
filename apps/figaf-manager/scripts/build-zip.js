#!/usr/bin/env node
// Assembles figaf-manager-app-<version>.zip for BTP Cockpit "Deploy Application".
//
// What it does:
//   1. Download Linux x86_64 btp + cf binaries (versions pinned in package.json)
//      into bin/ (skipped if already present).
//   2. Stage a self-contained app tree in apps/figaf-manager/.staging/:
//        cloud/, host.cloud.js, bin/, manifest.yml, package.json,
//        node_modules/@figaf/{core,ui}/  (copied from packages/, NOT symlinked —
//                                         the logo lives inside @figaf/ui),
//        node_modules/{express,ws,…}      (installed by npm install in staging).
//   3. Zip the staging directory contents → dist/figaf-manager-app-<version>.zip
//
// Run from inside apps/figaf-manager/:  node scripts/build-zip.js

"use strict";
const fs   = require("fs");
const fsp  = fs.promises;
const path = require("path");
const os   = require("os");
const https = require("https");
const { execSync, spawnSync } = require("child_process");

const APP_DIR        = path.join(__dirname, "..");
const WORKSPACE_ROOT = path.join(APP_DIR, "..", "..");
const pkg            = JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8"));

let archiver;
try {
  archiver = require("archiver");
} catch {
  console.error("\narchiver not found — run  npm install  at the workspace root first (installs devDependencies)");
  process.exit(1);
}

const VERSION      = pkg.version;
const BTP_VERSION  = pkg.btpCliVersion  || "2.106.1";

const BIN_DIR   = path.join(APP_DIR, "bin");
const STAGE_DIR = path.join(APP_DIR, ".staging");
const DIST_DIR  = path.join(APP_DIR, "dist");
const OUT_ZIP   = path.join(DIST_DIR, `figaf-manager-app-${VERSION}.zip`);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) { process.stdout.write(msg + "\n"); }

function copyDir(src, dest, shouldSkip = () => false) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (shouldSkip(entry.name)) continue;
    if (entry.isDirectory()) copyDir(s, d, shouldSkip);
    else if (entry.isFile() || entry.isSymbolicLink()) {
      try { fs.copyFileSync(s, d); } catch (e) { /* skip dangling symlinks */ }
    }
  }
}

function httpsGet(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    function fetch(currentUrl, hops) {
      if (hops > 8) return reject(new Error("Too many redirects"));
      const headers = {
        "User-Agent": "figaf-manager-build",
        "Cookie": "eula_3_2_agreed=tools.hana.ondemand.com/developer-license-3_2.txt",
      };
      https.get(currentUrl, { headers }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
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
    const found = fs.readdirSync(BIN_DIR).find(f => !f.endsWith(".tar.gz") && !f.endsWith(".gitkeep") && f !== "btp" && f !== "cf" && f !== "LICENSE" && f !== "NOTICE");
    if (found) fs.renameSync(path.join(BIN_DIR, found), btpBin);
    fs.chmodSync(btpBin, "755");
    try { fs.unlinkSync(tmpTar); } catch {}
    log("[btp] Done.");
  } else {
    log("[btp] Already in bin/ — skipping download.");
  }

  const cfBin = path.join(BIN_DIR, "cf");
  if (!fs.existsSync(cfBin)) {
    const cfUrl = "https://packages.cloudfoundry.org/stable?release=linux64-binary&version=v8&source=github";
    const tmpTar = path.join(os.tmpdir(), "cf8-cli-linux-x86-64.tar.gz");
    log("[cf]  Downloading cf CLI v8 (latest stable for linux64)…");
    await httpsGet(cfUrl, tmpTar, (got, total) =>
      total ? process.stdout.write(`\r[cf]  ${Math.round((got / total) * 100)}%   `) : null);
    process.stdout.write("\n");
    log("[cf]  Extracting…");
    extractTarGz(tmpTar, BIN_DIR, 0);
    const cf8 = path.join(BIN_DIR, "cf8");
    if (fs.existsSync(cf8)) fs.renameSync(cf8, cfBin);
    fs.chmodSync(cfBin, "755");
    try { fs.unlinkSync(tmpTar); } catch {}
    log("[cf]  Done.");
  } else {
    log("[cf]  Already in bin/ — skipping download.");
  }
}

// ─── Step 2: Stage a self-contained app tree ──────────────────────────────────

function stage() {
  log("[stage] Preparing .staging/…");
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  fs.mkdirSync(STAGE_DIR);

  copyDir(path.join(APP_DIR, "cloud"), path.join(STAGE_DIR, "cloud"), name => name.endsWith(".test.js"));
  copyDir(BIN_DIR,                     path.join(STAGE_DIR, "bin"));
  fs.copyFileSync(path.join(APP_DIR, "host.cloud.js"),    path.join(STAGE_DIR, "host.cloud.js"));
  fs.copyFileSync(path.join(APP_DIR, "manifest.yml"),     path.join(STAGE_DIR, "manifest.yml"));

  // We rewrite @figaf/* dependencies to point to local file paths
  // so the CF buildpack's npm install natively installs them from the local dir
  // instead of pruning them.
  const stagedPkg = JSON.parse(JSON.stringify(pkg));
  stagedPkg.dependencies["@figaf/core"] = "file:packages/core";
  stagedPkg.dependencies["@figaf/ui"] = "file:packages/ui";
  delete stagedPkg.bundleDependencies;
  fs.writeFileSync(path.join(STAGE_DIR, "package.json"), JSON.stringify(stagedPkg, null, 2));

  // Copy the local packages into the staging dir FIRST
  const stagedPackagesDir = path.join(STAGE_DIR, "packages");
  fs.mkdirSync(path.join(stagedPackagesDir, "core"), { recursive: true });
  fs.mkdirSync(path.join(stagedPackagesDir, "ui"), { recursive: true });
  copyDir(path.join(WORKSPACE_ROOT, "packages", "core"), path.join(stagedPackagesDir, "core"));
  copyDir(path.join(WORKSPACE_ROOT, "packages", "ui"),   path.join(stagedPackagesDir, "ui"));

  log("[stage] Running npm install --omit=dev in staging…");
  execSync("npm install --omit=dev --no-package-lock --no-audit --no-fund", {
    cwd: STAGE_DIR,
    stdio: "inherit",
  });

  log("[stage] Done.");
}

// ─── Step 3: Build zip from staging ───────────────────────────────────────────

async function buildZip() {
  await fsp.mkdir(DIST_DIR, { recursive: true });
  log(`[zip] Building ${path.basename(OUT_ZIP)}…`);

  const output = fs.createWriteStream(OUT_ZIP);
  const archive = archiver("zip", { zlib: { level: 6 } });

  await new Promise((resolve, reject) => {
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(STAGE_DIR, false);
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
  if (!skipNpm)      stage();
  if (!skipZip) {
    await buildZip();
    log("\nBuild complete.");
    log(`Upload to BTP Cockpit → Space → Applications → Deploy Application:`);
    log(`  ${OUT_ZIP}`);
  } else {
    log("\nBinaries ready in bin/ — skipped staging + zip.");
  }
})().catch((err) => {
  console.error("\nBuild failed:", err.message);
  process.exit(1);
});

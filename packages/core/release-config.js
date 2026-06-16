"use strict";
// Single source of truth for self-update release discovery.
//
// Override the repo at runtime with FIGAF_RELEASE_REPO=<owner>/<name> when
// staging from a fork. The GitHub Release for each version is expected to
// carry these assets:
//   figaf-manager-app-<semver>.zip            (cloud zip the dyno self-pushes)
//   Figaf-Installer-Setup-<semver>-x64.exe    (Windows NSIS installer)
// Plus electron-updater metadata (latest.yml, blockmap) — not parsed here.

const RELEASE_REPO = process.env.FIGAF_RELEASE_REPO || "afl-figaf/figaf-manager-release";

const RELEASE_LATEST_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

const CLOUD_ASSET_REGEX   = /^figaf-manager-app-(\d+\.\d+\.\d+)\.zip$/;
const DESKTOP_ASSET_REGEX = /^Figaf-Installer-Setup-(\d+\.\d+\.\d+)-x64\.exe$/;

// Strict three-part semver comparator. Pre-release tags and build metadata
// are not supported (we never ship them from this repo's release flow).
// Returns -1 if a < b, 0 if equal, +1 if a > b. Non-semver input → NaN-safe
// comparison treats missing parts as 0.
function compareSemver(a, b) {
  const pa = String(a || "").split(".").map((n) => parseInt(n, 10));
  const pb = String(b || "").split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x < y) return -1;
    if (x > y) return  1;
  }
  return 0;
}

module.exports = {
  RELEASE_REPO,
  RELEASE_LATEST_URL,
  CLOUD_ASSET_REGEX,
  DESKTOP_ASSET_REGEX,
  compareSemver,
};

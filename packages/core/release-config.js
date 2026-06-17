"use strict";
// Single source of truth for self-update release discovery.
//
// Override the repo at runtime with FIGAF_RELEASE_REPO=<owner>/<name> when
// staging from a fork. The GitHub Release for each version is expected to
// carry these assets:
//   figaf-manager-app-<semver>.zip       (cloud zip the dyno self-pushes)
//   Figaf-Installer-<semver>-x64.exe     (Windows PORTABLE exe — runs without install)
// The release workflow also attaches the cloud manifest.yml; it carries no
// version and is not parsed here.
//
// The desktop asset is the PORTABLE exe, not the NSIS "Setup" installer — a
// running portable can't overwrite itself in place, so the desktop self-update
// only DETECTS a newer version here and sends the operator to the release page
// to download + replace manually (see triggerSelfUpdate in self-update-banner.jsx).
// The regex deliberately requires a digit right after "Figaf-Installer-" so it
// matches the portable name but never the "Figaf-Installer-Setup-..." installer.

const RELEASE_REPO = process.env.FIGAF_RELEASE_REPO || "figaf/FigafManager";

const RELEASE_LATEST_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

const CLOUD_ASSET_REGEX   = /^figaf-manager-app-(\d+\.\d+\.\d+)\.zip$/;
const DESKTOP_ASSET_REGEX = /^Figaf-Installer-(\d+\.\d+\.\d+)-x64\.exe$/;

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

"use strict";
// Pure-logic tests for release-config helpers. No I/O.
// Run via `node --test packages/core/release-config.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");

// Module reads process.env.FIGAF_RELEASE_REPO at require-time, so reset
// the cache between tests to exercise both branches.
function loadFresh(envValue) {
  if (envValue == null) delete process.env.FIGAF_RELEASE_REPO;
  else process.env.FIGAF_RELEASE_REPO = envValue;
  delete require.cache[require.resolve("./release-config")];
  return require("./release-config");
}

test("compareSemver: equal versions", () => {
  const { compareSemver } = loadFresh();
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  assert.equal(compareSemver("0.0.0", "0.0.0"), 0);
});

test("compareSemver: simple ordering", () => {
  const { compareSemver } = loadFresh();
  assert.equal(compareSemver("1.0.0", "1.0.1"), -1);
  assert.equal(compareSemver("1.0.1", "1.0.0"),  1);
  assert.equal(compareSemver("1.0.0", "1.1.0"), -1);
  assert.equal(compareSemver("1.1.0", "1.0.0"),  1);
  assert.equal(compareSemver("1.0.0", "2.0.0"), -1);
  assert.equal(compareSemver("2.0.0", "1.0.0"),  1);
});

test("compareSemver: ten-vs-two segment lexicographic trap", () => {
  // Must compare numerically, not lex: "10" > "2".
  const { compareSemver } = loadFresh();
  assert.equal(compareSemver("1.2.0", "1.10.0"), -1);
  assert.equal(compareSemver("1.10.0", "1.2.0"),  1);
});

test("compareSemver: missing parts default to 0", () => {
  const { compareSemver } = loadFresh();
  assert.equal(compareSemver("1", "1.0.0"), 0);
  assert.equal(compareSemver("1.0", "1.0.0"), 0);
  assert.equal(compareSemver("", "0.0.0"), 0);
});

test("compareSemver: malformed input is NaN-safe", () => {
  const { compareSemver } = loadFresh();
  assert.equal(compareSemver("garbage", "garbage"), 0);
  assert.equal(compareSemver(null, undefined), 0);
});

test("RELEASE_REPO defaults to the public Figaf release repo", () => {
  const { RELEASE_REPO, RELEASE_LATEST_URL } = loadFresh(null);
  assert.equal(RELEASE_REPO, "afl-figaf/figaf-manager-release");
  assert.equal(
    RELEASE_LATEST_URL,
    "https://api.github.com/repos/afl-figaf/figaf-manager-release/releases/latest"
  );
});

test("FIGAF_RELEASE_REPO env overrides the default", () => {
  const { RELEASE_REPO, RELEASE_LATEST_URL } = loadFresh("acme/staging-repo");
  assert.equal(RELEASE_REPO, "acme/staging-repo");
  assert.equal(
    RELEASE_LATEST_URL,
    "https://api.github.com/repos/acme/staging-repo/releases/latest"
  );
});

test("CLOUD_ASSET_REGEX: matches the build-zip naming", () => {
  const { CLOUD_ASSET_REGEX } = loadFresh();
  const m = CLOUD_ASSET_REGEX.exec("figaf-manager-app-1.2.3.zip");
  assert.ok(m, "should match");
  assert.equal(m[1], "1.2.3");
  assert.equal(CLOUD_ASSET_REGEX.exec("figaf-manager-app-1.2.3.tar.gz"), null);
  assert.equal(CLOUD_ASSET_REGEX.exec("Figaf-Installer-Setup-1.2.3-x64.exe"), null);
});

test("DESKTOP_ASSET_REGEX: matches the NSIS installer naming", () => {
  const { DESKTOP_ASSET_REGEX } = loadFresh();
  const m = DESKTOP_ASSET_REGEX.exec("Figaf-Installer-Setup-1.2.3-x64.exe");
  assert.ok(m, "should match");
  assert.equal(m[1], "1.2.3");
  // Portable artifact must NOT match (different installable flow).
  assert.equal(DESKTOP_ASSET_REGEX.exec("Figaf-Installer-1.2.3-x64.exe"), null);
  assert.equal(DESKTOP_ASSET_REGEX.exec("figaf-manager-app-1.2.3.zip"), null);
});

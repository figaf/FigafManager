#!/usr/bin/env node
// Windows build wrapper for figaf-local.
//
// Why this exists
// ---------------
// On Windows, on-access antivirus (e.g. Windows Defender real-time protection)
// opens every file the moment it is written, to scan it. electron-builder copies
// the bundled resources (packages/deploy-templates/**) into dist\ and then calls
// chmod()/utimes() on each file microseconds later to preserve the source mode
// and timestamps. While the scanner still holds its handle, that chmod hits a
// sharing violation that Node surfaces as EPERM — and the build aborts. The file
// that loses the race is different every run (README.md, notes.txt, db.json, …),
// which is the tell-tale signature of a scanner race rather than a bad file.
//
// We can't turn off that chmod (electron-builder always preserves source mode),
// and an AV exclusion is unreliable on policy-managed corporate machines, so we
// make the post-write fs operations resilient instead: retry on EPERM/EBUSY with
// a short backoff, which gives the scanner a few ms to release the handle.
//
// electron-builder reads `fs/promises` methods dynamically (builder-util does
// `promises_1.chmod(...)`), so replacing the property on the shared module object
// — before requiring electron-builder — is picked up transparently by its copier.

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");

const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
const MAX_RETRIES = 15;
const BACKOFF_MS = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wrap an async fs/promises method so transient AV-scan collisions retry.
function retrying(orig) {
  return async function (...args) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await orig.apply(this, args);
      } catch (err) {
        if (err && TRANSIENT.has(err.code) && attempt < MAX_RETRIES) {
          await sleep(BACKOFF_MS * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  };
}

// Patch the post-write operations that race with the scanner. Patch on both
// `require("fs/promises")` and `require("fs").promises` (same object in current
// Node, but belt-and-suspenders) before electron-builder is loaded.
for (const target of [fsp, fs.promises]) {
  if (!target) continue;
  for (const method of ["chmod", "lchmod", "utimes", "lutimes", "copyFile", "rename", "unlink", "link"]) {
    if (typeof target[method] === "function" && !target[method].__figafPatched) {
      const wrapped = retrying(target[method].bind(target));
      wrapped.__figafPatched = true;
      target[method] = wrapped;
    }
  }
}

// A GitHub token in the environment makes electron-builder treat GitHub as the
// implicit publish provider and try to RESOLVE it (to publish, and/or to write
// electron-updater metadata). In CI the repository isn't detectable from
// .git/config, so that resolution fails — either throwing "Cannot detect
// repository" or yielding a null config that crashes update-info generation
// ("Cannot read properties of null (reading 'channel')"). We publish via
// `gh release upload` in a separate workflow step and don't use electron-
// updater, so this build never needs a token. Strip them here (this child
// process only — the upload step keeps its own GH_TOKEN) so electron-builder
// does no GitHub resolution at all. (Belt-and-suspenders: the sole Windows
// target is "portable", which isn't an electron-updater target, so the
// update-info path wouldn't run anyway.)
delete process.env.GH_TOKEN;
delete process.env.GITHUB_TOKEN;

const { build, Platform } = require("electron-builder");

// publish: "never" — we attach artifacts ourselves via `gh release upload` in
// .github/workflows/release.yml. Without this, electron-builder sees the git
// tag in CI (its default is publish-on-tag), tries to publish to GitHub on its
// own, fails to detect a `repository`, and aborts with "Cannot detect
// repository by .git/config". It also silences the v27 implicit-publish
// deprecation warning. We don't use electron-updater, so the latest.yml /
// blockmap metadata that publishing would emit is not needed.
build({ targets: Platform.WINDOWS.createTarget(), publish: "never" })
  .then((artifacts) => {
    const exes = artifacts.filter((f) => f.toLowerCase().endsWith(".exe"));
    process.stdout.write("\nBuild complete. Artifacts:\n");
    for (const f of exes.length ? exes : artifacts) process.stdout.write("  " + f + "\n");
  })
  .catch((err) => {
    process.stderr.write((err && err.stack ? err.stack : String(err)) + "\n");
    process.exit(1);
  });

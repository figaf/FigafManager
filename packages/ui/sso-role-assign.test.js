"use strict";
// Unit tests for the role-assignment plan (packages/ui/sso-role-assign.js).
// The module is a browser-globals script; we fake `window` and load it.
// Run via `node --test packages/ui/sso-role-assign.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "sso-role-assign.js"), "utf8");

function load() {
  const w = {};
  new Function("window", SRC)(w);
  return { plan: w.figafRoleAssignPlan, isEmail: w.figafIsEmailLike };
}

test("no BTP login: assignment unavailable and off, the notice names the restart trap", () => {
  const { plan } = load();
  const p = plan({ ok: true, btpLoggedIn: false, cfUser: "ais@figaf.com", cfUserIsStoredUser: false, storedUsername: null });
  assert.equal(p.available, false);
  assert.equal(p.autoAssign, false);
  assert.equal(p.reason, "no-btp-login");
  assert.equal(p.prefillUser, "");
  assert.match(p.notice, /before the last restart does not count/);
});

test("BTP login, person signed in with a passcode: on, prefilled with the cf user, no input needed", () => {
  const { plan } = load();
  const p = plan({ ok: true, btpLoggedIn: true, cfUser: "ais@figaf.com", cfUserIsStoredUser: false, storedUsername: "tech@figaf.com" });
  assert.equal(p.available, true);
  assert.equal(p.autoAssign, true);
  assert.equal(p.prefillUser, "ais@figaf.com");
  assert.equal(p.needsUserInput, false);
  assert.equal(p.notice, "");
});

test("BTP login, manager signed in as the stored technical user: on, EMPTY field, operator must name a person", () => {
  const { plan } = load();
  const p = plan({ ok: true, btpLoggedIn: true, cfUser: "tech@figaf.com", cfUserIsStoredUser: true, storedUsername: "tech@figaf.com" });
  assert.equal(p.available, true);
  assert.equal(p.autoAssign, true);
  assert.equal(p.prefillUser, "");
  assert.equal(p.needsUserInput, true);
  assert.match(p.notice, /technical user tech@figaf.com/);
  assert.match(p.notice, /enter your own e-mail/);
});

test("precheck failed or missing: unavailable, off, cockpit fallback named", () => {
  const { plan } = load();
  for (const pre of [null, undefined, { ok: false, error: "btp not found" }]) {
    const p = plan(pre);
    assert.equal(p.available, false);
    assert.equal(p.autoAssign, false);
    assert.equal(p.reason, "precheck-failed");
    assert.match(p.notice, /cockpit/);
  }
  assert.match(load().plan({ ok: false, error: "btp not found" }).notice, /btp not found/);
});

test("BTP login but no cf user known: on, needs input", () => {
  const { plan } = load();
  const p = plan({ ok: true, btpLoggedIn: true, cfUser: null, cfUserIsStoredUser: false, storedUsername: null });
  assert.equal(p.available, true);
  assert.equal(p.prefillUser, "");
  assert.equal(p.needsUserInput, true);
});

test("figafIsEmailLike: accepts a plain address, rejects blanks, spaces, and overlong values", () => {
  const { isEmail } = load();
  assert.equal(isEmail("ais@figaf.com"), true);
  assert.equal(isEmail("  ais@figaf.com  "), true);
  assert.equal(isEmail(""), false);
  assert.equal(isEmail(null), false);
  assert.equal(isEmail("ais figaf.com"), false);
  assert.equal(isEmail("ais@"), false);
  assert.equal(isEmail("@figaf.com"), false);
  assert.equal(isEmail("a".repeat(250) + "@figaf.com"), false);
});

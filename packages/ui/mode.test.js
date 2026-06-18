"use strict";
// Unit tests for the suppression helper in packages/ui/mode.js.
// mode.js is a browser-globals script; we fake `window` and load it.
// Run via `node --test packages/ui/mode.test.js`.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const MODE_SRC = fs.readFileSync(path.join(__dirname, "mode.js"), "utf8");

function loadFresh(extraWindow) {
  const w = Object.assign({}, extraWindow || {});
  // The IIFE in mode.js writes to window. Run it in a synthetic context.
  // Equivalent to evaluating it with `window` bound to our object.
  const fn = new Function("window", MODE_SRC);
  fn(w);
  return w;
}

test("isLongRunningFlow: empty ctx → false", () => {
  const w = loadFresh();
  assert.equal(w.figafIsLongRunningFlow({}, null), false);
});

test("isLongRunningFlow: pending prereqs after prereqsStarted → true", () => {
  const w = loadFresh();
  assert.equal(w.figafIsLongRunningFlow({
    prereqsStarted: true,
    prereqs: [{ status: "ok" }, { status: "pending" }],
  }, null), true);
});

test("isLongRunningFlow: all prereqs done → false", () => {
  const w = loadFresh();
  assert.equal(w.figafIsLongRunningFlow({
    prereqsStarted: true,
    prereqs: [{ status: "ok" }, { status: "ok" }],
  }, null), false);
});

test("isLongRunningFlow: btp/cf login running → false (banner stays visible during login)", () => {
  const w = loadFresh();
  assert.equal(w.figafIsLongRunningFlow({ login: { btpStatus: "running" } }, null), false);
  assert.equal(w.figafIsLongRunningFlow({ login: { cfStatus: "running" } }, null), false);
});

test("isLongRunningFlow: cf push in flight → true", () => {
  const w = loadFresh();
  assert.equal(w.figafIsLongRunningFlow({ pushStatus: "running" }, null), true);
});

test("isLongRunningFlow: deployStarted mid-flight (not done/error/idle) → true", () => {
  const w = loadFresh();
  assert.equal(
    w.figafIsLongRunningFlow({ deployStarted: true, pushStatus: "pushing" }, null),
    true
  );
});

test("isLongRunningFlow: deployStarted but pushStatus idle → false (the user hasn't actually started)", () => {
  const w = loadFresh();
  assert.equal(
    w.figafIsLongRunningFlow({ deployStarted: true, pushStatus: "idle" }, null),
    false
  );
});

test("isLongRunningFlow: noisy step IDs → true", () => {
  const w = loadFresh();
  for (const id of ["xsuaa-upgrade", "xsuaa-assign-role",
                    "connect-idp-custom-trust", "connect-idp-custom-assign", "updateProgress"]) {
    assert.equal(w.figafIsLongRunningFlow({}, id), true, `step ${id} should suppress`);
  }
});

test("isLongRunningFlow: arbitrary step IDs → false", () => {
  const w = loadFresh();
  assert.equal(w.figafIsLongRunningFlow({}, "welcome"), false);
  assert.equal(w.figafIsLongRunningFlow({}, "choice"), false);
});

test("isLongRunningFlow: preflight modal open → true (no recursive banner)", () => {
  const w = loadFresh();
  assert.equal(w.figafIsLongRunningFlow({ selfUpdate: { preflightOpen: true } }, null), true);
});

test("isLongRunningFlow: update resume state present → true", () => {
  const w = loadFresh();
  assert.equal(w.figafIsLongRunningFlow({ update: { resumeState: { phase: "x" } } }, null), true);
});

test("features.selfUpdateBanner: default ON", () => {
  const w = loadFresh();
  assert.equal(w.figafModeFlags.features.selfUpdateBanner, true);
});

test("features.selfUpdateBanner: disabled when figafDisableSelfUpdate=true (air-gap escape hatch)", () => {
  const w = loadFresh({ figafDisableSelfUpdate: true });
  assert.equal(w.figafModeFlags.features.selfUpdateBanner, false);
});

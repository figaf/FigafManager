"use strict";
// Unit tests for the setup checklist model (packages/ui/setup-checklist.js).
// The module is a browser-globals script; we fake `window` and load it.
// Run via `node --test packages/ui/setup-checklist.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "setup-checklist.js"), "utf8");

function load() {
  const w = {};
  new Function("window", SRC)(w);
  return w.figafSetupSteps;
}

const svc = (status, extra) => ({ name: "x", status, ...(extra || {}) });
const V3 = (db, xsuaa, cred, boundToManager) => ({
  ok: true,
  services: [
    { name: "figaf-l3l4-db", status: db },
    { name: "figaf-l3l4-xsuaa", status: xsuaa },
    { name: "figaf-l3l4-credstore", status: cred, bindToManager: true, boundToManager },
  ],
});
const ids = (r) => r.steps.map((s) => s.id);
const byId = (r, id) => r.steps.find((s) => s.id === id);

test("v3, empty space: five steps in install order, dense numbering, step 1 current", () => {
  const r = load()({ services: V3("missing", "missing", "missing", false), stored: { available: false, bindingPresent: false }, l3: { ok: true, platform: { status: "missing" } }, figaf: { configured: false } });
  assert.deepEqual(ids(r), ["services", "mgmt-user", "platform", "figaf-connection", "sso"]);
  assert.deepEqual(r.steps.map((s) => s.n), [1, 2, 3, 4, 5]);
  assert.equal(r.done, 0);
  assert.equal(r.total, 5);
  assert.equal(byId(r, "services").current, true);
  assert.match(byId(r, "services").when, /3 of 3 instances missing/);
  assert.equal(byId(r, "mgmt-user").blocked, "after step 1");
  assert.equal(byId(r, "platform").blocked, "after step 1");
  assert.equal(byId(r, "figaf-connection").blocked, "after step 1");
  assert.equal(byId(r, "sso").blocked, "after step 2");
  // Exactly one current step.
  assert.equal(r.steps.filter((s) => s.current).length, 1);
});

test("v3, kept database: the when-line counts only the missing instances", () => {
  const r = load()({ services: V3("ready", "missing", "missing", false), stored: { available: false, bindingPresent: false } });
  assert.match(byId(r, "services").when, /2 of 3 instances missing/);
  assert.equal(byId(r, "services").done, false);
});

test("v3, instances ready but credstore not bound: step 1 says bind, platform unblocks, 2 and 4 stay blocked", () => {
  const r = load()({ services: V3("ready", "ready", "ready", false), stored: { available: false, bindingPresent: false } });
  const s1 = byId(r, "services");
  assert.equal(s1.done, false);
  assert.match(s1.when, /Bind to manager/);
  assert.equal(s1.current, true);
  assert.equal(byId(r, "platform").blocked, "");
  assert.equal(byId(r, "mgmt-user").blocked, "after step 1");
  assert.equal(byId(r, "figaf-connection").blocked, "after step 1");
});

test("v3, bound but binding not active yet: step 1 says restart", () => {
  const r = load()({ services: V3("ready", "ready", "ready", true), stored: { available: false, bindingPresent: false } });
  const s1 = byId(r, "services");
  assert.equal(s1.done, false);
  assert.match(s1.when, /Restart the manager/);
  assert.equal(byId(r, "mgmt-user").blocked, "after step 1");
});

test("v3, binding active: step 1 done, management user becomes the current step, SSO still after step 2", () => {
  const r = load()({ services: V3("ready", "ready", "ready", true), stored: { available: false, bindingPresent: true } });
  assert.equal(byId(r, "services").done, true);
  assert.equal(byId(r, "services").when, "");
  assert.equal(byId(r, "mgmt-user").current, true);
  assert.equal(byId(r, "mgmt-user").blocked, "");
  assert.equal(byId(r, "figaf-connection").blocked, "");
  assert.equal(byId(r, "sso").blocked, "after step 2");
  assert.equal(r.done, 1);
});

test("v3, management user stored: SSO unblocks; platform is current (install does it)", () => {
  const r = load()({ services: V3("ready", "ready", "ready", true), stored: { available: true, bindingPresent: true }, l3: { ok: true, platform: { status: "missing" } }, figaf: { configured: false } });
  assert.equal(byId(r, "mgmt-user").done, true);
  assert.equal(byId(r, "sso").blocked, "");
  assert.equal(byId(r, "platform").current, true);
  assert.equal(r.done, 2);
});

test("v3, everything done incl. SSO: 5 of 5, no current step", () => {
  const r = load()({ services: V3("ready", "ready", "ready", true), stored: { available: true, bindingPresent: true }, l3: { ok: true, platform: { status: "running" } }, figaf: { configured: true } }, { ssoDone: true });
  assert.equal(r.done, 5);
  assert.equal(r.steps.every((s) => s.done), true);
  assert.equal(r.steps.some((s) => s.current), false);
});

test("v2 release (no services block): four steps, numbering 1-4, binding reason spelled out", () => {
  const r = load()({ services: { ok: true, services: [] }, stored: { available: false, bindingPresent: false } });
  assert.deepEqual(ids(r), ["mgmt-user", "platform", "figaf-connection", "sso"]);
  assert.deepEqual(r.steps.map((s) => s.n), [1, 2, 3, 4]);
  assert.equal(byId(r, "mgmt-user").blocked, "Credential Store binding not active");
  assert.equal(byId(r, "platform").blocked, "");
  assert.equal(byId(r, "platform").current, true);
  assert.equal(byId(r, "sso").blocked, "after step 1");
});

test("services fetch failed: treated like v2 (no false 'to do' for unknown instances)", () => {
  const r = load()({ services: { ok: false, error: "boom" }, stored: { available: false, bindingPresent: true } });
  assert.deepEqual(ids(r), ["mgmt-user", "platform", "figaf-connection", "sso"]);
  assert.equal(byId(r, "mgmt-user").current, true);
});

test("missing inputs: nothing throws, nothing is done", () => {
  const r = load()(undefined);
  assert.equal(r.done, 0);
  assert.equal(r.total, 4);
  assert.equal(byId(r, "mgmt-user").blocked, "Credential Store binding not active");
});

test("every step carries a title and a why-line; SSO and the CTA steps carry a when-line", () => {
  const r = load()({ services: V3("missing", "missing", "missing", false), stored: {} });
  for (const s of r.steps) {
    assert.ok(s.title.length > 0, s.id + " title");
    assert.ok(s.why.length > 0, s.id + " why");
  }
  assert.match(byId(r, "sso").when, /30-90 s/);
  assert.match(byId(r, "sso").when, /after step 2/);
  assert.equal(byId(r, "sso").cta, "Start upgrade");
  assert.equal(byId(r, "mgmt-user").cta, "Session & access");
  assert.equal(byId(r, "figaf-connection").cta, "Connections");
  assert.equal(byId(r, "services").cta, null);
  assert.equal(byId(r, "platform").cta, null);
});

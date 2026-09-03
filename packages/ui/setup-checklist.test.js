"use strict";
// Unit tests for the setup checklist model (packages/ui/setup-checklist.js).
// The module is a browser-globals script; we fake `window` and load it.
// Run via `node --test packages/ui/setup-checklist.test.js`.
//
// Order under test (figaf-l3-l4 decision 0009): 1 Secure access (SSO),
// 2 Management user, 3 Base services, 4 Shared backend, 5 Figaf tool
// connection. Everything is blocked until step 1 is done.

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

test("v3, empty space, token mode: SSO is step 1 and current; every other step is blocked 'after step 1'", () => {
  const r = load()({ services: V3("missing", "missing", "missing", false), stored: { available: false, bindingPresent: false }, l3: { ok: true, platform: { status: "missing" } }, figaf: { configured: false } });
  assert.deepEqual(ids(r), ["sso", "mgmt-user", "services", "platform", "figaf-connection"]);
  assert.deepEqual(r.steps.map((s) => s.n), [1, 2, 3, 4, 5]);
  assert.equal(r.done, 0);
  assert.equal(r.total, 5);
  assert.equal(byId(r, "sso").current, true);
  assert.equal(byId(r, "sso").blocked, "");
  assert.equal(byId(r, "sso").cta, "Start upgrade");
  for (const id of ["mgmt-user", "services", "platform", "figaf-connection"]) {
    assert.equal(byId(r, id).blocked, "after step 1", id);
    assert.equal(byId(r, id).current, false, id);
  }
  assert.equal(r.steps.filter((s) => s.current).length, 1);
});

test("v3, token mode, instances already ready and bound: still everything after step 1 is blocked (no restart before SSO)", () => {
  const r = load()({ services: V3("ready", "ready", "ready", true), stored: { available: false, bindingPresent: false } });
  assert.equal(byId(r, "sso").current, true);
  assert.equal(byId(r, "services").blocked, "after step 1");
  assert.match(byId(r, "services").when, /Restart the manager/);
  assert.equal(byId(r, "mgmt-user").blocked, "after step 1");
});

test("SSO done, binding active, nothing stored: management user is current; services blocked only by their own state", () => {
  const r = load()({ services: V3("missing", "ready", "ready", true), stored: { available: false, bindingPresent: true }, l3: { ok: true, platform: { status: "missing" } }, figaf: { configured: false } }, { ssoDone: true });
  assert.equal(byId(r, "sso").done, true);
  assert.equal(byId(r, "mgmt-user").current, true);
  assert.equal(byId(r, "mgmt-user").blocked, "");
  const s3 = byId(r, "services");
  assert.equal(s3.done, false);
  assert.equal(s3.blocked, "");
  assert.match(s3.when, /1 of 3 instances missing/);
  assert.equal(byId(r, "platform").blocked, "after step 3");
  assert.equal(byId(r, "figaf-connection").blocked, "");
  assert.equal(r.done, 1);
});

test("SSO done but the Credential Store binding is NOT active (step 1 failed to bind): management user and connection say so", () => {
  const r = load()({ services: V3("ready", "ready", "ready", false), stored: { available: false, bindingPresent: false } }, { ssoDone: true });
  assert.equal(byId(r, "mgmt-user").blocked, "Credential Store binding not active");
  assert.equal(byId(r, "figaf-connection").blocked, "Credential Store binding not active");
  assert.match(byId(r, "services").when, /Bind to manager/);
  assert.equal(byId(r, "services").current, true);
});

test("SSO done, user stored, all instances ready and bound: shared backend is current (install does it)", () => {
  const r = load()({ services: V3("ready", "ready", "ready", true), stored: { available: true, bindingPresent: true }, l3: { ok: true, platform: { status: "missing" } }, figaf: { configured: false } }, { ssoDone: true });
  assert.equal(byId(r, "mgmt-user").done, true);
  assert.equal(byId(r, "services").done, true);
  assert.equal(byId(r, "platform").current, true);
  assert.equal(byId(r, "figaf-connection").blocked, "");
  assert.equal(r.done, 3);
});

test("everything done: 5 of 5, no current step", () => {
  const r = load()({ services: V3("ready", "ready", "ready", true), stored: { available: true, bindingPresent: true }, l3: { ok: true, platform: { status: "running" } }, figaf: { configured: true } }, { ssoDone: true });
  assert.equal(r.done, 5);
  assert.equal(r.steps.every((s) => s.done), true);
  assert.equal(r.steps.some((s) => s.current), false);
});

test("v2 release (no services block): four steps, numbering 1-4, SSO first", () => {
  const r = load()({ services: { ok: true, services: [] }, stored: { available: false, bindingPresent: false } });
  assert.deepEqual(ids(r), ["sso", "mgmt-user", "platform", "figaf-connection"]);
  assert.deepEqual(r.steps.map((s) => s.n), [1, 2, 3, 4]);
  assert.equal(byId(r, "sso").current, true);
  assert.equal(byId(r, "platform").blocked, "after step 1");
});

test("v2 release, SSO done, binding not active: the reason is spelled out", () => {
  const r = load()({ services: { ok: true, services: [] }, stored: { available: false, bindingPresent: false } }, { ssoDone: true });
  assert.equal(byId(r, "mgmt-user").blocked, "Credential Store binding not active");
  assert.equal(byId(r, "platform").blocked, "");
  assert.equal(byId(r, "platform").current, true);
});

test("services fetch failed: treated like v2 (no false 'to do' for unknown instances)", () => {
  const r = load()({ services: { ok: false, error: "boom" }, stored: { available: false, bindingPresent: true } }, { ssoDone: true });
  assert.deepEqual(ids(r), ["sso", "mgmt-user", "platform", "figaf-connection"]);
  assert.equal(byId(r, "mgmt-user").current, true);
});

test("missing inputs: nothing throws, SSO is the only actionable step", () => {
  const r = load()(undefined);
  assert.equal(r.done, 0);
  assert.equal(r.total, 4);
  assert.equal(byId(r, "sso").current, true);
  assert.equal(byId(r, "mgmt-user").blocked, "after step 1");
});

test("every step carries a title and a why-line; step 1 names the passcode, the restart and the role collection", () => {
  const r = load()({ services: V3("missing", "missing", "missing", false), stored: {} });
  for (const s of r.steps) {
    assert.ok(s.title.length > 0, s.id + " title");
    assert.ok(s.why.length > 0, s.id + " why");
  }
  const sso = byId(r, "sso");
  assert.match(sso.title, /Secure access/);
  assert.match(sso.when, /passcode/);
  assert.match(sso.when, /30-90 s/);
  assert.match(sso.when, /FigafL3L4-Manager-Admin/);
  assert.match(sso.why, /Credential Store/);
  assert.equal(byId(r, "mgmt-user").cta, "Session & access");
  assert.match(byId(r, "mgmt-user").when, /sign-in gate/);
  assert.equal(byId(r, "figaf-connection").cta, "Connections");
  assert.equal(byId(r, "services").cta, null);
  assert.equal(byId(r, "platform").cta, null);
  assert.equal(byId(r, "platform").title, "Shared backend");
});

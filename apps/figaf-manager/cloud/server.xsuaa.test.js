"use strict";
// XSUAA-mode server tests. Runs in a separate node:test file (and thus a
// separate Node process) from server.test.js so the boot-time VCAP_SERVICES
// capture inside auth.js + xsuaa-auth.js sees the xsuaa binding.
//
// We set VCAP_SERVICES BEFORE require()ing ./server so:
//   - server.js's XSUAA_ACTIVE = true
//   - requireAuth is the JWT middleware
//   - bootMintToken() is a no-op apart from a single [INFO] line
//   - /setup/claim returns 410
//
// We do NOT exercise real JWT validation here — that would require a live
// xsuaa signing key. Instead we use xsuaa-auth's __setVerifier seam.

// IMPORTANT: env injection MUST happen before any require() that touches
// auth.js / xsuaa-auth.js — both capture at module load.
process.env.VCAP_SERVICES = JSON.stringify({
  xsuaa: [{
    credentials: {
      xsappname: "figaf-manager-xsuaa",
      clientid: "test-client",
      clientsecret: "test-secret",
      url: "https://test.authentication.eu10.hana.ondemand.com",
    },
  }],
});

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const xa = require("./xsuaa-auth");
// Inject a synthetic verifier — every JWT "good-jwt" is treated as a valid
// FigafManagerOperator-scoped session; everything else is rejected.
xa.__setVerifier((jwt) => {
  if (jwt === "good-jwt") return Promise.resolve({ ok: true, user: "tester", email: "tester@example.com" });
  if (jwt === "no-scope-jwt") return Promise.resolve({ ok: false, code: "NO_SCOPE", reason: "missing scope" });
  return Promise.resolve({ ok: false, code: "INVALID", reason: "bad sig" });
});

const { server, XSUAA_ACTIVE } = require("./server");

let baseUrl;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  baseUrl = "http://127.0.0.1:" + addr.port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("server boots with XSUAA_ACTIVE=true when VCAP_SERVICES has xsuaa binding", () => {
  assert.equal(XSUAA_ACTIVE, true);
});

test("GET /health returns mode=xsuaa", async () => {
  const r = await fetch(baseUrl + "/health");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, "xsuaa");
});

test("POST /setup/claim returns 410 (xsuaa_mode_active) under XSUAA", async () => {
  const r = await fetch(baseUrl + "/setup/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "anything" }),
  });
  assert.equal(r.status, 410);
  const body = await r.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, "xsuaa_mode_active");
});

test("GET /setup under XSUAA returns 302 to / (stale tabs bounce home, not to a dead claim page)", async () => {
  // A pre-upgrade tab whose client.js still has xsuaaMode=false will redirect
  // the browser to /setup on any auth-kick; once XSUAA is active the manager
  // must NOT serve setup.html (the claim POST is 410 and the operator can't
  // satisfy it). The approuter has already gated this request with the
  // FigafManagerOperator scope, so an unauthenticated browser can't reach
  // this handler under XSUAA — no risk of an IAS-redirect loop.
  const r = await fetch(baseUrl + "/setup", { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/");
});

test("GET / without JWT returns 401 (no /setup redirect under XSUAA)", async () => {
  const r = await fetch(baseUrl + "/", { redirect: "manual", headers: { accept: "text/html" } });
  assert.equal(r.status, 401);
});

test("GET / with valid JWT returns wizard HTML with figafXsuaaMode=true injection", async () => {
  const r = await fetch(baseUrl + "/", {
    headers: { authorization: "Bearer good-jwt", accept: "text/html" },
  });
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /window\.figafXsuaaMode\s*=\s*true/);
});

test("POST /rpc/<any> without JWT → 401", async () => {
  const r = await fetch(baseUrl + "/rpc/prereq:whichBtp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(r.status, 401);
});

test("POST /rpc/<any> with valid-but-scope-less JWT → 403", async () => {
  const r = await fetch(baseUrl + "/rpc/prereq:whichBtp", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer no-scope-jwt" },
    body: "{}",
  });
  assert.equal(r.status, 403);
});

test("POST /rpc/<any> with invalid JWT → 401", async () => {
  const r = await fetch(baseUrl + "/rpc/prereq:whichBtp", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer garbage" },
    body: "{}",
  });
  assert.equal(r.status, 401);
});

// ─── v1 dormancy assertions ────────────────────────────────────────────────

test("auth.generateSetupToken() throws under XSUAA mode (token gate dormant)", () => {
  const auth = require("./auth");
  assert.equal(auth.__xsuaaModeAtInit, true);
  assert.throws(() => auth.generateSetupToken(), /XSUAA mode/);
});

test("auth.verifyAuth() returns XSUAA_MODE_ACTIVE reason under XSUAA mode", () => {
  const auth = require("./auth");
  // Even with a header that LOOKS like a valid v1 cookie shape, refuse it.
  const fakeReq = { headers: { cookie: "figaf_auth=v1.deadbeef.1700000000" } };
  const r = auth.verifyAuth(fakeReq);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "XSUAA_MODE_ACTIVE");
});

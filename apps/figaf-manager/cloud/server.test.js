"use strict";
// Tests for the Express surface of cloud/server.js — exercises:
//   - GET /setup (returns HTML, never gated)
//   - POST /setup/claim (correct, wrong, double)
//   - GET / (302 → /setup without cookie, 200 with cookie)
//   - POST /rpc/:channel (401 without cookie, channel-shape with cookie)
//
// We boot the real Express + http.Server on :0 (random port) so tests exercise
// the actual middleware stack including the upgrade handler (covered in
// ws-auth.test.js). No mocks of Express internals.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const auth = require("./auth");
const { server } = require("./server");

let baseUrl;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  baseUrl = "http://127.0.0.1:" + addr.port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  // Each test starts with a fresh unclaimed token. We do NOT call
  // generateSetupToken() here to keep room for the "no-token" test paths;
  // tests that need a live token call it explicitly.
  auth.__resetForTests();
});

// ─── /setup ────────────────────────────────────────────────────────────────

test("GET /setup returns HTML with the claim form", async () => {
  const r = await fetch(baseUrl + "/setup", { redirect: "manual" });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /^text\/html/);
  const body = await r.text();
  assert.match(body, /Figaf Installer.*Setup/);
  assert.match(body, /<input[^>]+id="token"/);
  assert.match(body, /action|fetch\(/);
});

// ─── /setup/claim ──────────────────────────────────────────────────────────

test("POST /setup/claim with correct token → 200 + auth cookie + redirect", async () => {
  const token = auth.generateSetupToken();
  const r = await fetch(baseUrl + "/setup/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    redirect: "manual",
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.redirect, "/");
  const setCookieHeader = r.headers.get("set-cookie") || "";
  // figaf_auth=v1.<mac>.<iat>; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800
  assert.match(setCookieHeader, /figaf_auth=v1\.[0-9a-f]{64}\.\d+/);
  assert.match(setCookieHeader, /HttpOnly/);
  assert.match(setCookieHeader, /SameSite=Strict/);
});

test("POST /setup/claim with wrong token → 401", async () => {
  auth.generateSetupToken();
  const r = await fetch(baseUrl + "/setup/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "not-the-real-token" }),
  });
  assert.equal(r.status, 401);
  const body = await r.json();
  assert.equal(body.ok, false);
});

test("POST /setup/claim a second time → 410 Gone", async () => {
  const token = auth.generateSetupToken();
  // First claim succeeds
  const r1 = await fetch(baseUrl + "/setup/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(r1.status, 200);
  // Second claim with the same token now returns 410
  const r2 = await fetch(baseUrl + "/setup/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(r2.status, 410);
});

// ─── / (root, gated) ───────────────────────────────────────────────────────

test("GET / without auth cookie → 302 redirect to /setup", async () => {
  const r = await fetch(baseUrl + "/", {
    redirect: "manual",
    headers: { Accept: "text/html" },
  });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/setup");
});

test("GET / with valid auth cookie → 200 wizard HTML", async () => {
  // Mint a cookie via the real claim path so the IP/UA used to sign matches
  // the one the verifier recomputes on the GET.
  const token = auth.generateSetupToken();
  const claim = await fetch(baseUrl + "/setup/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "test-ua/1" },
    body: JSON.stringify({ token }),
  });
  assert.equal(claim.status, 200);
  const cookieHdr = claim.headers.get("set-cookie") || "";
  const authCookie = (cookieHdr.match(/figaf_auth=[^;]+/) || [])[0];
  assert.ok(authCookie, "auth cookie present in Set-Cookie");

  const r = await fetch(baseUrl + "/", {
    redirect: "manual",
    headers: {
      Accept: "text/html",
      "User-Agent": "test-ua/1",
      Cookie: authCookie,
    },
  });
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /<div id="root">/);
  assert.match(body, /window\.figafMode = "hosted"/);
});

// ─── /rpc/* (gated) ────────────────────────────────────────────────────────

test("POST /rpc/<any> without auth cookie → 401 JSON", async () => {
  auth.generateSetupToken(); // not claimed
  const r = await fetch(baseUrl + "/rpc/prereq:whichBtp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 401);
  const body = await r.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, "unauthenticated");
});

test("POST /rpc/<unknown> with valid auth cookie → 404 (auth passes, channel doesn't)", async () => {
  const token = auth.generateSetupToken();
  const claim = await fetch(baseUrl + "/setup/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "test-ua/2" },
    body: JSON.stringify({ token }),
  });
  const authCookie = ((claim.headers.get("set-cookie") || "").match(/figaf_auth=[^;]+/) || [])[0];
  assert.ok(authCookie);

  const r = await fetch(baseUrl + "/rpc/this-channel-does-not-exist", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "test-ua/2",
      Cookie: authCookie,
    },
    body: JSON.stringify({}),
  });
  // Auth passed (we got past 401), now the handler reports unknown channel.
  assert.equal(r.status, 404);
  const body = await r.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /Unknown channel/);
});

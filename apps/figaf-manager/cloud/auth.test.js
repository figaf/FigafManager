"use strict";
// Tests for cloud/auth.js — run via `node --test apps/figaf-manager/cloud/auth.test.js`.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// We require auth.js fresh in each test file so the per-module per-boot
// secret is stable across this file's tests; __resetForTests() handles the
// authState. We intentionally do NOT clear the module cache.
const auth = require("./auth");

beforeEach(() => {
  auth.__resetForTests();
  auth.__setNow(() => Date.now());
});

// ─── 1. Token generation ───────────────────────────────────────────────────

test("generateSetupToken returns a 32-char base64url string", () => {
  const tok = auth.generateSetupToken();
  assert.equal(typeof tok, "string");
  assert.equal(tok.length, 32, "24 random bytes → 32 base64url chars (no padding)");
  assert.match(tok, /^[A-Za-z0-9_-]{32}$/, "base64url charset only");
});

test("generateSetupToken stores SHA-256(token) in module state and not the cleartext", () => {
  const tok = auth.generateSetupToken();
  const state = auth.__authState;
  assert.ok(Buffer.isBuffer(state.setupTokenHash), "hash is a Buffer");
  assert.equal(state.setupTokenHash.length, 32, "SHA-256 = 32 bytes");
  // Defense-in-depth: the stored hash must not equal the raw token bytes.
  assert.notDeepStrictEqual(state.setupTokenHash, Buffer.from(tok, "utf8"));
});

test("generateSetupToken produces a different token on each call", () => {
  const a = auth.generateSetupToken();
  const b = auth.generateSetupToken();
  assert.notEqual(a, b);
});

test("formatSetupLogLine starts with the [SETUP] tag", () => {
  const tok = auth.generateSetupToken();
  const line = auth.formatSetupLogLine(tok);
  assert.ok(line.startsWith("[SETUP] Token: "));
  assert.ok(line.includes(tok), "log line carries the cleartext token");
  assert.ok(line.includes("/setup"), "log line points the operator at /setup");
});

// ─── 2. verifySetupToken ───────────────────────────────────────────────────

test("verifySetupToken: NO_TOKEN before generate", () => {
  const r = auth.verifySetupToken("anything");
  assert.deepEqual(r, { ok: false, code: "NO_TOKEN" });
});

test("verifySetupToken: ok on exact match, then ALREADY_CLAIMED after recordClaim", () => {
  const tok = auth.generateSetupToken();
  assert.deepEqual(auth.verifySetupToken(tok), { ok: true });
  auth.recordClaim({ ip: "203.0.113.7", ua: "Mozilla/5.0" });
  const r = auth.verifySetupToken(tok);
  assert.deepEqual(r, { ok: false, code: "ALREADY_CLAIMED" });
});

test("verifySetupToken: INVALID on wrong token", () => {
  auth.generateSetupToken();
  const r = auth.verifySetupToken("a-different-32-char-base64url-A!");
  assert.equal(r.ok, false);
  assert.equal(r.code, "INVALID");
});

test("recordClaim wipes the stored hash and stamps claim metadata", () => {
  auth.generateSetupToken();
  assert.ok(auth.__authState.setupTokenHash);
  auth.recordClaim({ ip: "10.0.0.1", ua: "ua/1" });
  assert.equal(auth.__authState.setupTokenHash, null);
  assert.equal(auth.isClaimed(), true);
  assert.equal(auth.__authState.claimantIp, "10.0.0.1");
});

// ─── 3. Cookie sign/verify round-trip ──────────────────────────────────────

function fakeReq({ ip = "203.0.113.7", ua = "test-ua/1.0", cookie } = {}) {
  return {
    headers: {
      "user-agent": ua,
      "x-forwarded-for": ip,
      cookie,
    },
    socket: { remoteAddress: ip },
  };
}

test("signSession + verifyAuth round-trip succeeds for the matching IP+UA", () => {
  const ip = "198.51.100.42";
  const ua = "Mozilla/5.0 (test)";
  const cookieVal = auth.signSession({ ip, ua, iat: Math.floor(Date.now() / 1000) });
  const req = fakeReq({ ip, ua, cookie: `${auth.COOKIE_NAME}=${cookieVal}` });
  const r = auth.verifyAuth(req);
  assert.equal(r.ok, true);
});

test("verifyAuth rejects cookie when IP changes (binding to claiming IP)", () => {
  const cookieVal = auth.signSession({ ip: "1.1.1.1", ua: "ua", iat: Math.floor(Date.now() / 1000) });
  const req = fakeReq({ ip: "2.2.2.2", ua: "ua", cookie: `${auth.COOKIE_NAME}=${cookieVal}` });
  const r = auth.verifyAuth(req);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "BAD_MAC");
});

test("verifyAuth rejects cookie when UA changes", () => {
  const cookieVal = auth.signSession({ ip: "1.1.1.1", ua: "ua-A", iat: Math.floor(Date.now() / 1000) });
  const req = fakeReq({ ip: "1.1.1.1", ua: "ua-B", cookie: `${auth.COOKIE_NAME}=${cookieVal}` });
  const r = auth.verifyAuth(req);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "BAD_MAC");
});

test("verifyAuth rejects when cookie missing or malformed", () => {
  assert.equal(auth.verifyAuth(fakeReq({ cookie: "" })).reason, "NO_COOKIE");
  assert.equal(
    auth.verifyAuth(fakeReq({ cookie: `${auth.COOKIE_NAME}=v1.too.few` })).reason,
    "MALFORMED"
  );
  assert.equal(
    auth.verifyAuth(fakeReq({ cookie: `${auth.COOKIE_NAME}=v2.deadbeef.${Math.floor(Date.now() / 1000)}` })).reason,
    "MALFORMED",
    "wrong version prefix rejected"
  );
});

test("verifyAuth rejects expired cookie (iat older than max-age)", () => {
  // Mint cookie at T=0; verify at T = max-age + 1.
  auth.__setNow(() => 0);
  const cookieVal = auth.signSession({ ip: "1.1.1.1", ua: "ua", iat: 0 });
  auth.__setNow(() => (auth.COOKIE_MAX_AGE_SECONDS + 1) * 1000);
  const req = fakeReq({ ip: "1.1.1.1", ua: "ua", cookie: `${auth.COOKIE_NAME}=${cookieVal}` });
  const r = auth.verifyAuth(req);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "EXPIRED");
});

// ─── 4. clientIp ──────────────────────────────────────────────────────────

test("clientIp prefers first X-Forwarded-For value over socket.remoteAddress", () => {
  const req = {
    headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    socket: { remoteAddress: "10.0.0.99" },
  };
  assert.equal(auth.clientIp(req), "203.0.113.7");
});

test("clientIp falls back to socket.remoteAddress when X-Forwarded-For absent", () => {
  const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(auth.clientIp(req), "127.0.0.1");
});

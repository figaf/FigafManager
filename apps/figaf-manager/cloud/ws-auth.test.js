"use strict";
// Tests for the WS upgrade-handler authentication.
// Boots the real server and uses `ws` client to attempt connections to /stream.
// Run via `node --test apps/figaf-manager/cloud/ws-auth.test.js`.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const auth = require("./auth");
const { server } = require("./server");

let baseUrl;
let wsBase;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  baseUrl = "http://127.0.0.1:" + addr.port;
  wsBase = "ws://127.0.0.1:" + addr.port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  auth.__resetForTests();
});

// ─── Helpers ───────────────────────────────────────────────────────────────

async function mintAuthCookie({ ua = "ws-test-ua/1" } = {}) {
  const token = auth.generateSetupToken();
  const r = await fetch(baseUrl + "/setup/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": ua },
    body: JSON.stringify({ token }),
  });
  assert.equal(r.status, 200);
  const setCookie = r.headers.get("set-cookie") || "";
  const cookie = (setCookie.match(/figaf_auth=[^;]+/) || [])[0];
  assert.ok(cookie, "auth cookie issued");
  return cookie;
}

function openWs(urlPath, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsBase + urlPath, { headers });
    let resolved = false;
    const done = (outcome) => { if (!resolved) { resolved = true; resolve(outcome); } };
    ws.on("open", () => done({ ws, opened: true }));
    ws.on("unexpected-response", (_req, res) => {
      done({ unexpectedStatus: res.statusCode });
      try { res.destroy(); } catch {}
    });
    ws.on("error", () => done({ error: true }));
    ws.on("close", (code) => done({ closed: true, code }));
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test("WS upgrade without cookie → server replies 401 (no upgrade)", async () => {
  const r = await openWs("/stream");
  // `ws` surfaces non-101 responses via 'unexpected-response'.
  assert.equal(r.unexpectedStatus, 401);
});

test("WS upgrade with malformed cookie → 401", async () => {
  const r = await openWs("/stream", { Cookie: "figaf_auth=v1.not-a-mac.42" });
  assert.equal(r.unexpectedStatus, 401);
});

test("WS upgrade with wrong-version cookie → 401", async () => {
  const r = await openWs("/stream", {
    Cookie: "figaf_auth=v9." + "a".repeat(64) + "." + Math.floor(Date.now() / 1000),
  });
  assert.equal(r.unexpectedStatus, 401);
});

test("WS upgrade with valid cookie → opens", async () => {
  const ua = "ws-valid-ua/1";
  const cookie = await mintAuthCookie({ ua });
  const r = await openWs("/stream", {
    Cookie: cookie,
    "User-Agent": ua,
  });
  assert.equal(r.opened, true);
  r.ws.close();
});

test("WS upgrade with cookie minted for different UA → 401 (binding rejects)", async () => {
  const cookie = await mintAuthCookie({ ua: "ua-A" });
  const r = await openWs("/stream", {
    Cookie: cookie,
    "User-Agent": "ua-B-different",
  });
  assert.equal(r.unexpectedStatus, 401);
});

test("two concurrent WS attempts produce independent outcomes", async () => {
  const ua = "ws-concurrent-ua/1";
  const cookie = await mintAuthCookie({ ua });
  const [authedRes, unauthedRes] = await Promise.all([
    openWs("/stream", { Cookie: cookie, "User-Agent": ua }),
    openWs("/stream"),
  ]);
  assert.equal(authedRes.opened, true);
  assert.equal(unauthedRes.unexpectedStatus, 401);
  authedRes.ws.close();
});

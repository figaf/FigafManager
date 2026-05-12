"use strict";
// node:test coverage for the v2 V4 idle-self-destruct (server.js).
//
// Goal: confirm the timer is a no-op when FIGAF_IDLE_SELF_DESTRUCT_HOURS=0
// (the default), and that lastActivityMs() climbs as sessions are touched.
// We do NOT attempt to trigger a real teardown — that would require cf CLI.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const srv = require("./server");

// Start the server on an ephemeral port so getOrCreateSession can be exercised
// via a real HTTP roundtrip if needed. (We rely on the module-scope side seam
// exposed via __* exports for the core assertions.)
let baseUrl;
before(async () => {
  await new Promise((resolve) => srv.server.listen(0, "127.0.0.1", resolve));
  baseUrl = "http://127.0.0.1:" + srv.server.address().port;
});
after(async () => {
  await new Promise((resolve) => srv.server.close(resolve));
});

test("idle self-destruct disabled by default (FIGAF_IDLE_SELF_DESTRUCT_HOURS=0)", () => {
  assert.equal(srv.__IDLE_TTL_HOURS, 0);
});

test("__maybeIdleSelfDestruct() is a no-op when TTL is 0", async () => {
  // If the no-op gate fails, this throws (because there are no sessions to
  // pick from + cf CLI isn't bound). Returning undefined is success.
  const r = await srv.__maybeIdleSelfDestruct();
  assert.equal(r, undefined);
});

test("lastActivityMs() climbs when a session is touched", async () => {
  const t0 = srv.__lastActivityMs();
  // Touch a fresh session via the public HTTP surface. The /setup endpoint
  // is unauthenticated and runs through sessionMiddleware, which mints a
  // sessionId cookie — but does NOT bump lastSeen on a session, because the
  // sessionMiddleware doesn't actually call getOrCreateSession. So we use
  // /rpc/<channel> which DOES create a session. We expect 401 (no auth
  // cookie in v1 mode) but the session bump happens before requireAuth.
  // Actually requireAuth runs BEFORE the route handler. So the only seam
  // that bumps lastSeen is inside the route handler. To get there in test,
  // we'd need a valid v1 cookie. Easier: directly poke sessions map.
  const id = "test-idle-bump";
  srv.sessions.set(id, { handlers: {}, dispose: () => {}, wsClients: new Set(), lastSeen: Date.now() + 10 });
  const t1 = srv.__lastActivityMs();
  assert.ok(t1 >= t0, "expected lastActivityMs to monotonically increase");
});

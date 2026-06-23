"use strict";
// Unit test for the cf:suggestedApiUrl handler (CF-only login pre-fill).
// The handler surfaces the host's own CF API endpoint so the renderer can
// pre-fill the manual API-URL field when BTP login is skipped.
// Run via `node --test packages/core/orchestrator-cf-suggested-apiurl.test.js`
// (also picked up by the root `npm test` glob).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createOrchestrator } = require("./orchestrator");

// Minimal HostAdapter sufficient to construct the orchestrator. `extra` lets a
// test override / add getDeployTargetForSelf, which is what this handler reads.
function makeHost(extra) {
  return Object.assign({
    isHosted: true,
    resolveBinary: (name) => `/fake/${name}`,
    getUserDataDir: () => "/tmp/figaf-fake",
    pickFile: async () => null,
    openExternal: async () => {},
    readClipboard: async () => "",
  }, extra);
}
const send = () => {};

test("cf:suggestedApiUrl returns the host's VCAP-derived apiUrl", async () => {
  const host = makeHost({ getDeployTargetForSelf: () => ({ apiUrl: "https://api.cf.us10.hana.ondemand.com" }) });
  const { handlers } = createOrchestrator({ host, send });
  const r = await handlers["cf:suggestedApiUrl"]();
  assert.deepEqual(r, { ok: true, apiUrl: "https://api.cf.us10.hana.ondemand.com" });
});

test("cf:suggestedApiUrl returns empty string when the host has no deploy target", async () => {
  const host = makeHost({ getDeployTargetForSelf: () => null });
  const { handlers } = createOrchestrator({ host, send });
  const r = await handlers["cf:suggestedApiUrl"]();
  assert.deepEqual(r, { ok: true, apiUrl: "" });
});

test("cf:suggestedApiUrl tolerates a host without getDeployTargetForSelf (desktop)", async () => {
  const host = makeHost(); // no getDeployTargetForSelf at all
  const { handlers } = createOrchestrator({ host, send });
  const r = await handlers["cf:suggestedApiUrl"]();
  assert.deepEqual(r, { ok: true, apiUrl: "" });
});

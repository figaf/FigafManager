"use strict";
// E2E harness for the hosted manager (see e2e/README.md).
// The server under test is started by e2e/global-setup.js on port 8087 and
// runs the REAL orchestrator with the REAL cf CLI from PATH — no mocks.
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.js",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  // All specs share one server-side wizard session (same storageState), so
  // they must not run concurrently.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8087",
    storageState: "e2e/.auth/state.json",
    trace: "retain-on-failure",
  },
});

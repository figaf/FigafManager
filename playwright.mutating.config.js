"use strict";
// MUTATING e2e — the install smoke. It pushes the bundled release into the
// REAL space the local cf CLI is targeted at (platform base + app), verifies
// both run, then removes what it created. Run it deliberately:
//
//     npm run test:e2e:install
//
// Gate rule (e2e/README.md): run it green before every manager build that is
// pushed or uploaded. It is the only test that executes a real `cf push` from
// the manager process, so it is the only one that can catch what the unit
// tests' fake `run` cannot (e.g. the 2026-09-03 manifest leak).
const { defineConfig } = require("@playwright/test");

// Only the main server is needed; the failure fixture would be idle.
process.env.E2E_SERVERS = process.env.E2E_SERVERS || "main";

module.exports = defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.js",
  testMatch: ["**/*.mutating.spec.js"],
  // A fresh install stages two apps: minutes, not seconds.
  timeout: 15 * 60_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  // Own results dir: the smoke may run next to the read-only suite.
  outputDir: "test-results-mutating",
  use: {
    baseURL: "http://127.0.0.1:8087",
    storageState: "e2e/.auth/state.json",
    trace: "retain-on-failure",
  },
});

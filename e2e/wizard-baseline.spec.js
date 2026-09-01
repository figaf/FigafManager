"use strict";
// Baseline specs for the CURRENT wizard UI. Purpose: prove the e2e harness
// end to end (server boot, token claim, seeded cf session, real cf calls)
// BEFORE the console redesign starts. These specs also serve as the
// regression net while the frame is reworked.

const { test, expect } = require("@playwright/test");

test("unauthenticated visitor is redirected to /setup", async ({ browser }) => {
  // Fresh context WITHOUT the claimed storage state.
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();
  const resp = await page.goto("/");
  expect(resp.url()).toContain("/setup");
  await context.close();
});

test("a signed-in session resumes on the choice screen, not on Welcome", async ({ page }) => {
  await page.goto("/");
  // Session resume: the server verifies the seeded cf login with a real
  // `cf target`, and the app skips Welcome + Sign in.
  await expect(page.locator("h1.pane-title")).toHaveText("What would you like to do?");
});

test("deep link #/apps opens the L3 dashboard directly", async ({ page }) => {
  await page.goto("/#/apps");
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf L3 applications");
  // The dashboard reads the bundled release catalog and shows real rows.
  await expect(page.locator("body")).toContainText("B2B Archiving Setup");
});

test("deep link #/connections opens the connections screen", async ({ page }) => {
  await page.goto("/#/connections");
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf tool & SAP systems");
});

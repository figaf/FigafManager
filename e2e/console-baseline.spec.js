"use strict";
// Console-frame specs (the default hosted frame since the redesign).
// The signed-in state comes from the seeded cf login (see global-setup.js);
// every cf-backed assertion runs against the real space. READ-ONLY: these
// specs never install, remove, or start a deploy.

const { test, expect } = require("@playwright/test");

test("unauthenticated visitor is redirected to /setup", async ({ browser }) => {
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();
  const resp = await page.goto("/");
  expect(resp.url()).toContain("/setup");
  await context.close();
});

test("signed-in reload lands on the L3 dashboard (#/apps), no wizard", async ({ page }) => {
  await page.goto("/");
  // Auto sign-in: session resume or stored user; then the console landing page.
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf L3 applications");
  expect(page.url()).toContain("#/apps");
  // The rail is navigation now, not wizard steps.
  await expect(page.locator(".cnav-item")).toHaveCount(5);
  // Signed-in footer shows who the manager works as.
  await expect(page.locator(".rail-foot")).toContainText("/");
});

test("first-run checklist banner lists the open setup steps", async ({ page }) => {
  // On this dev setup SSO/credstore are absent, so the banner must show.
  await page.goto("/#/apps");
  const banner = page.locator(".setup-checklist");
  await expect(banner).toContainText("Finish setting up this installation");
  await expect(banner).toContainText("persistent SSO");
  // Hide is per page load.
  await banner.getByRole("button", { name: "Hide" }).click();
  await expect(banner).toHaveCount(0);
});

test("rail navigation reaches every page and updates the address", async ({ page }) => {
  await page.goto("/#/apps");
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf L3 applications");

  await page.locator('.cnav-item[data-route="connections"]').click();
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf tool & SAP systems");
  expect(page.url()).toContain("#/connections");

  await page.locator('.cnav-item[data-route="figaf-tool"]').click();
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf Tool deployments");
  expect(page.url()).toContain("#/figaf-tool");

  await page.locator('.cnav-item[data-route="session"]').click();
  await expect(page.locator("h1.pane-title")).toHaveText("Who the manager works as");
  expect(page.url()).toContain("#/session");

  await page.locator('.cnav-item[data-route="about"]').click();
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf Manager");
  expect(page.url()).toContain("#/about");
});

test("session page shows the CF session and the management-user card", async ({ page }) => {
  await page.goto("/#/session");
  await expect(page.locator("h1.pane-title")).toHaveText("Who the manager works as");
  await expect(page.locator(".card").first()).toContainText("Cloud Foundry session");
  await expect(page.locator(".card").first()).toContainText("signed in");
  await expect(page.getByText("Management user (automatic sign-in)")).toBeVisible();
});

test("about page shows version, update state, and environment checks", async ({ page }) => {
  await page.goto("/#/about");
  await expect(page.locator(".pane-desc .kbd")).toContainText("v");
  await expect(page.getByText("Manager updates")).toBeVisible();
  await expect(page.getByText("Environment checks")).toBeVisible();
  // The hosted checks: bundled CLIs + container marked ok, Docker Hub probed.
  await expect(page.getByText("bundled in container").first()).toBeVisible();
});

test("figaf tool hub starts the update flow as a local stepper, and abandon returns", async ({ page }) => {
  await page.goto("/#/figaf-tool");
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf Tool deployments");
  await page.getByRole("button", { name: "Start update" }).click();
  // The flow renders inside the page with a local stepper strip.
  await expect(page.locator(".flow-strip")).toBeVisible();
  await expect(page.locator(".flow-chip.is-active")).toContainText("Configure update");
  await expect(page.locator("h1.pane-title")).toHaveText("Update Figaf Tool");
  // Leaving the flow returns to the hub.
  await page.getByRole("button", { name: "← Figaf Tool overview" }).click();
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf Tool deployments");
});

test("deep link #/connections opens directly after auto sign-in", async ({ page }) => {
  await page.goto("/#/connections");
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf tool & SAP systems");
});

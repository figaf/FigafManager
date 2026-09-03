"use strict";
// Failed actions must explain themselves (project "failure-visibility",
// server :8088 with the fixture release — see global-setup.js).
//
// The fixture's platform base needs a service instance that does not exist,
// so every Install is REFUSED before any cf change: a real failure with zero
// side effects. Locks the 2026-09-03 lesson ("no logs, nothing"): a failed
// action stays on the page with what failed, what was said and what to do
// next; the status refresh that follows every action must not wipe it; the
// terminal drawer ends with a red summary line; a report can be copied.

const { test, expect } = require("@playwright/test");
const { execFileSync } = require("child_process");

const APP_ID = "b2b-archiving-setup-e2e";
const isRpc = (name) => (r) => decodeURIComponent(r.url()).includes("/rpc/" + name);

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("a refused install stays visible (where / what / next), survives the status refresh, opens the terminal, copies a report, can be dismissed", async ({ page }) => {
  await page.goto("/#/apps");
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf L3 applications");
  const row = page.locator(`.l3-app-row[data-app="${APP_ID}"]`);
  await expect(row).toContainText("Not installed");
  const panel = page.locator('[data-outcome="error"]');
  await expect(panel).toHaveCount(0);

  // Both waits BEFORE the click: the install answer, then the status refresh
  // the screen runs right after every action (the one that used to wipe the
  // error). The page-load status has already answered — the row says
  // "Not installed" — so the second wait can only catch the post-action one.
  const installDone = page.waitForResponse(isRpc("l3:install"));
  const statusAfter = page.waitForResponse(isRpc("l3:status"));
  await row.getByRole("button", { name: /^Install / }).click();

  const result = await (await installDone).json();
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/required service instance\(s\) missing: figaf-l3l4-e2e-missing/);

  // 1. The outcome panel: action + app, the error, the next step.
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Install of B2B Archiving Setup (e2e fixture) failed");
  await expect(panel).toContainText("figaf-l3l4-e2e-missing");
  await expect(panel).toContainText("Create the base services first");

  // 2. The refresh comes back, the row is re-rendered — and the panel stays.
  await statusAfter;
  await expect(row).toContainText("Not installed");
  await expect(panel).toBeVisible();

  // 3. The terminal drawer ends the action with one red line.
  await panel.getByRole("button", { name: "Show CLI output" }).click();
  const terminal = page.locator(".terminal");
  await expect(terminal).toBeVisible();
  await expect(terminal).toContainText(`install ${APP_ID} FAILED: required service instance(s) missing`);
  await expect(terminal.locator(".t-err").last()).toContainText("FAILED");

  // 4. Copy report: a self-contained text for a support ticket.
  await panel.getByRole("button", { name: "Copy report" }).click();
  await expect(panel.getByRole("button", { name: "Copied" })).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("Figaf App Manager - action report");
  expect(clip).toContain("release: 0.0.0-e2e");
  expect(clip).toContain("action: Install of B2B Archiving Setup (e2e fixture)");
  expect(clip).toContain("figaf-l3l4-e2e-missing");
  expect(clip).toContain("next: Create the base services first");
  expect(clip).not.toMatch(/Token:/);

  // 5. Dismiss removes it; nothing else changed.
  await panel.getByRole("button", { name: "Dismiss" }).click();
  await expect(panel).toHaveCount(0);
  await expect(row).toContainText("Not installed");
});

test("the refused install touched nothing in Cloud Foundry", async () => {
  const cf = process.platform === "win32" ? "cf.exe" : "cf";
  for (const name of ["figaf-l3l4-e2e-backend", "figaf-l3-e2e-frontend"]) {
    let exists = true;
    try { execFileSync(cf, ["app", name, "--guid"], { stdio: ["ignore", "pipe", "pipe"] }); } catch { exists = false; }
    expect(exists, `${name} must not exist`).toBe(false);
  }
});

test("a failed status refresh is shown too (the manager answers, the space listing fails)", async ({ page }) => {
  // The fixture server has a real cf login, so l3:status succeeds. This spec
  // only pins the UI contract on the RPC surface: a status error opens the
  // panel with the "Status refresh" title. It intercepts ONE status answer.
  await page.route("**/rpc/l3%3Astatus", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, error: "cf curl /v3/apps failed — are you logged in and targeted?" }) });
    await page.unroute("**/rpc/l3%3Astatus");
  });
  await page.goto("/#/apps");
  const panel = page.locator('[data-outcome="error"]');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Status refresh failed");
  await expect(panel).toContainText("Sign in again on Session & access");
});

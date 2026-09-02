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

test("base services card (catalog v3) reports the real instances of the space", async ({ page }) => {
  await page.goto("/#/apps");
  const card = page.getByText("Base services", { exact: true }).locator("..").locator("..");
  await expect(card).toBeVisible();
  // The dev space has all three instances: nothing to create.
  await expect(card).toContainText("figaf-l3l4-db");
  await expect(card).toContainText("figaf-l3l4-xsuaa");
  await expect(card).toContainText("figaf-l3l4-credstore");
  await expect(card.getByText("all ready")).toBeVisible();
  await expect(card.getByRole("button", { name: /Create missing services/ })).toBeDisabled();
});

test("setup checklist shows the numbered install steps with why-lines, SSO last", async ({ page }) => {
  // Locally the manager has no credstore binding and no SSO, so the banner must show.
  await page.goto("/#/apps");
  const banner = page.locator(".setup-checklist");
  await expect(banner).toContainText("Set up this installation");
  await expect(banner.locator(".pill.blue").first()).toHaveText(/^\d of 5 done$/);
  // Catalog v3: five steps, in the install order, all visible (done ones compact).
  const steps = banner.locator(".setup-step");
  await expect(steps).toHaveCount(5);
  await expect(steps.nth(0)).toContainText("1. Base services");
  await expect(steps.nth(1)).toContainText("2. Management user");
  await expect(steps.nth(2)).toContainText("3. Platform base");
  await expect(steps.nth(3)).toContainText("4. Figaf tool connection");
  await expect(steps.nth(4)).toContainText("5. Persistent SSO");
  // Exactly one current step; every open step explains itself.
  await expect(banner.locator(".setup-step.is-current")).toHaveCount(1);
  const openSteps = banner.locator(".setup-step:not(.is-done)");
  expect(await openSteps.count()).toBeGreaterThan(0);
  expect(await banner.locator(".setup-why").count()).toBe(await openSteps.count());
  // SSO explains its side effect and its prerequisite; its button is gated on the stored user.
  const sso = banner.locator('.setup-step[data-step="sso"]');
  await expect(sso).toContainText("30-90 s");
  await expect(sso).toContainText("after step 2");
  await expect(sso.getByRole("button", { name: "Start upgrade" })).toBeVisible();
  // Hide is per page load.
  await banner.getByRole("button", { name: "Hide" }).click();
  await expect(banner).toHaveCount(0);
});

test("setup checklist re-reads the management-user and Figaf states when the dashboard is shown again", async ({ page }) => {
  // Run #3 finding 4: after storing the management user on Session & access,
  // step 2 stayed "current step" until a page reload. The dashboard must read
  // those two states again every time it comes back into view.
  await page.goto("/#/apps");
  await expect(page.locator(".setup-checklist")).toBeVisible();
  await page.locator('.cnav-item[data-route="session"]').click();
  await expect(page.locator("h1.pane-title")).toHaveText("Who the manager works as");
  const isRpc = (name) => (r) => decodeURIComponent(r.url()).includes("/rpc/" + name);
  const storedRead = page.waitForRequest(isRpc("login:storedUserStatus"));
  const figafRead = page.waitForRequest(isRpc("connections:figafStatus"));
  await page.locator('.cnav-item[data-route="apps"]').click();
  await Promise.all([storedRead, figafRead]);
  await expect(page.locator(".setup-checklist")).toBeVisible();
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

test("session page: access map first, then CF session, BTP, management user, persistent SSO", async ({ page }) => {
  await page.goto("/#/session");
  await expect(page.locator("h1.pane-title")).toHaveText("Who the manager works as");
  // The access map: one row per sign-in concept, each with a purpose and a state.
  const map = page.locator(".access-map");
  await expect(map).toContainText("How this manager signs you in");
  await expect(map.locator(".access-row")).toHaveCount(4);
  for (const name of ["Browser access", "Cloud Foundry login", "SAP BTP login", "Management user"]) {
    await expect(map.locator(`.access-row[data-access="${name}"] .access-purpose`)).not.toBeEmpty();
  }
  // Locally the manager runs in token mode: bootstrap mode, setup token.
  await expect(map).toContainText("bootstrap mode");
  await expect(map.locator('.access-row[data-access="Browser access"]')).toContainText("setup token");
  await expect(map.locator('.access-row[data-access="Cloud Foundry login"]')).toContainText("signed in");
  // The cards below.
  await expect(page.getByText("Cloud Foundry session")).toBeVisible();
  await expect(page.getByText("SAP BTP session")).toBeVisible();
  await expect(page.getByText("Management user (automatic sign-in)")).toBeVisible();
  const sso = page.locator('[data-card="persistent-sso"]');
  await expect(sso).toContainText("Persistent SSO");
  await expect(sso).toContainText("30-90 s");
  // No BTP login in this session: the card says so and offers it BEFORE the upgrade.
  await expect(sso).toContainText("no BTP login");
  await expect(sso).toContainText("before the last restart does not count");
  await expect(sso.getByRole("button", { name: "Add BTP login first" })).toBeVisible();
  await expect(sso.getByRole("button", { name: "Start upgrade" })).toBeVisible();
});

test("persistent SSO upgrade opens on its own route under Session & access, and back returns", async ({ page }) => {
  await page.goto("/#/session");
  await page.locator('[data-card="persistent-sso"]').getByRole("button", { name: "Start upgrade" }).click();
  await expect(page.locator("h1.pane-title")).toHaveText("Enable persistent SSO login");
  expect(page.url()).toContain("#/session/sso-upgrade");
  await expect(page.locator(".flow-strip")).toBeVisible();
  // Run #4 finding 2: the role assignment is decided BEFORE Start. Locally there
  // is no BTP login, so the panel says so, offers the BTP login, and the primary
  // button names the consequence. Nothing is clicked: the upgrade must not start.
  const panel = page.locator('[data-panel="role-assign"]');
  await expect(panel).toContainText("no BTP login");
  await expect(panel).toContainText("before the last restart does not count");
  await expect(panel.getByRole("button", { name: "Add BTP login first" })).toBeVisible();
  await expect(panel.locator('input[type="checkbox"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start upgrade without role assignment" })).toBeVisible();
  await page.getByRole("button", { name: "← Session & access" }).click();
  await expect(page.locator("h1.pane-title")).toHaveText("Who the manager works as");
  expect(page.url()).toContain("#/session");
  expect(page.url()).not.toContain("sso-upgrade");
});

test("deep link #/session/sso-upgrade renders the upgrade screen after auto sign-in", async ({ page }) => {
  await page.goto("/#/session/sso-upgrade");
  await expect(page.locator("h1.pane-title")).toHaveText("Enable persistent SSO login");
  await expect(page.locator(".flow-chip.is-active")).toContainText("Authentication");
});

test("figaf tool hub no longer offers the SSO upgrade (it lives on Session & access)", async ({ page }) => {
  await page.goto("/#/figaf-tool");
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf Tool deployments");
  await expect(page.getByRole("button", { name: "Start upgrade" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start update" })).toBeVisible();
});

test("/health reports token state without the value (token mode, claimed by this harness)", async ({ page }) => {
  const r = await page.request.get("/health");
  expect(r.status()).toBe(200);
  const j = await r.json();
  expect(j.mode).toBe("token");
  expect(j.tokenMinted).toBe(true);
  expect(j.claimed).toBe(true);
  expect(JSON.stringify(j)).not.toMatch(/Token:/);
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

test("auth gate shows the sign-in card without wizard wording", async ({ browser }) => {
  // Keep the claimed auth cookie but drop the wizard-session cookie: the next
  // request mints a fresh server session with no cf login and (locally) no
  // stored user, so the gate must render - as a gate, not as wizard step 2.
  const context = await browser.newContext({ storageState: "e2e/.auth/state.json" });
  await context.clearCookies({ name: "figaf_session" });
  const page = await context.newPage();
  await page.goto("/#/apps");
  // Console gate, first sign-in: Cloud Foundry first and required, BTP optional.
  await expect(page.locator("h1.pane-title")).toHaveText("Sign in to Cloud Foundry");
  await expect(page.getByText("Step 2", { exact: false })).toHaveCount(0);
  const cards = page.locator(".login-cards > .card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("Cloud Foundry CLI");
  await expect(cards.nth(0)).toContainText("required");
  await expect(cards.nth(0).getByRole("button", { name: /Get passcode in browser/ })).toBeVisible();
  await expect(cards.nth(1)).toContainText("SAP BTP CLI");
  await expect(cards.nth(1)).toContainText("Optional");
  await expect(cards.nth(1).getByRole("button", { name: "Sign in with SSO instead" })).toBeVisible();
  // No wizard footer on the gate (the page swaps in by itself after sign-in).
  await expect(page.locator(".pane-foot")).toHaveCount(0);
  // The rail stays usable: About needs no CF session.
  await page.locator('.cnav-item[data-route="about"]').click();
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf Manager");
  await context.close();
});

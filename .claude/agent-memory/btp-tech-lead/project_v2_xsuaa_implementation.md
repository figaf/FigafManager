---
name: v2 XSUAA upgrade — implementation state
description: 8-commit v2 implementation landed on main; lays approuter sibling + JWT mode-switch on top of v1 token gate
type: project
---

The v2 XSUAA-upgrade (auth-gate-implementation-plan.md Part II) was implemented as 8 sequential commits on `main`, on top of v1 (commit `2db85d8`) plus a `chore(v1-polish)` prep commit. End-to-end PR not yet opened — owner reviews the branch first.

**Why:** v1 ships with known limitations (log-drain leaks, kick-on-restart with per-boot secret). v2 layers proper SAP IdP auth via a wizard-scoped approuter sibling and an auto-provisioned XSUAA service, triggered by an in-wizard "Enable persistent SSO login" button after a successful Figaf Tool deploy.

**How to apply:**
- Working assumptions baked in:
  - `xsappname: figaf-manager-xsuaa` is DISTINCT from the tool's `figaf-xsuaa` — never share XSUAA instances between wizard and tool (privilege-isolation seam from §2.3).
  - `packages/manager-approuter/` is a NEW workspace package, NOT a reuse of `packages/deploy-templates/approuter/` (which is for the Figaf Tool).
  - The approuter is bundled INSIDE the cloud zip (not fetched at runtime). build-zip.js `npm install --omit=dev`s inside `.staging/manager-approuter/` so the dyno gets a self-contained @sap/approuter tree.
  - Mode-switch is a one-shot at boot: `XSUAA_ACTIVE = xsuaa.isXsuaaActive()` from VCAP_SERVICES. NO per-request branching, NO live mode switching — the restage is the seam.
- HostAdapter contract added: `host.resolveManagerApprouterDir(): string|null`. Implemented in both adapters: cloud returns `__dirname/manager-approuter` (with dev fallback); Electron returns `null`.
- Orchestrator handlers added (~10): all gate on `host.isHosted` and return `{ ok: false, error: "not available in desktop mode" }` outside hosted.
- WS close codes: 4003 (no/invalid JWT or cookie) vs 4004 (JWT valid, missing scope). Distinguished server-side in `verifyWsUpgrade()` and client-side in `cloud/client.js`.
- Idle-self-destruct: opt-in via `FIGAF_IDLE_SELF_DESTRUCT_HOURS` env (default 0 = disabled). Tears down via `cf:uninstallManager`.

**Known operational gaps (flag if owner asks):**
1. `xs-app.json` uses `csrfProtection: false` on RPC routes because the wizard's fetch calls don't carry the approuter's x-csrf-token. Secondary defenses (XSUAA auth, SameSite cookies) make this acceptable, but a future hardening pass should add CSRF token plumbing through the renderer.
2. Cross-landscape verification (EU10/US10/AP*) per §2.12 is still owner-driven manual; cannot be done from this dev host.
3. The phase-2 reload handoff to the approuter's maintenance page is implemented optimistically — the wizard's tab will lose its WS during restage; recovery relies on the operator hitting refresh (the maintenance page polls /_manager-health independently).
4. The ScreenXsuaaAssignRole's cockpit URL is a best-effort derivation from `state.globalAccountSubdomain` + `state.subaccount`. Real-world cockpit URL shape may differ per landscape — the link form was not verified against live cockpit pages.

**Test coverage:** 71 node:test cases pass (`apps/figaf-manager/cloud/*.test.js`), including the new `xsuaa-auth.test.js` (21 cases), `server.xsuaa.test.js` (11), `idle-self-destruct.test.js` (3).

**Gate-detection layering (one-time misdiagnosis worth remembering):** the v2 mode-switch is split across THREE distinct places, and a fix that touches only one of them silently breaks the others:
1. `requireAuth` pointer-swap in server.js (line ~172): `XSUAA_ACTIVE ? xsuaa.requireJwt : requireAuthV1`. Governs `/` and `/rpc/*`.
2. `/setup` and `/setup/claim` route bodies: must each check `XSUAA_ACTIVE` themselves because they are PRE-`requireAuth` (the setup flow is intentionally ungated in token mode so the operator can claim without a session). Originally `/setup` "soft-failed" under XSUAA and still served setup.html — this caused a real symptom: a pre-upgrade tab whose `cloud/client.js` cached `xsuaaMode=false` (from the page's original injection) would `window.location.href = "/setup"` on any auth-kick during the restage's WS-disconnect window. The approuter then ran IAS auth on the way in, forwarded to the manager, and the operator landed on a token-claim form they couldn't satisfy (`/setup/claim` is 410 under XSUAA). Fix is to `302 → /` from `/setup` when `XSUAA_ACTIVE`; the approuter has already enforced scope, so no IAS-loop risk. Updated `server.xsuaa.test.js` test "GET /setup under XSUAA returns 302 to /".
3. `xs-app.json` catch-all (`^(.*)$`) forwards EVERY path to the manager with xsuaa auth enforced, including `/setup`. This means the manager's `/setup` handler ALWAYS runs behind approuter auth under XSUAA — there is no unauthenticated/legitimate reason for the setup page to ever render once XSUAA is bound.

**Post-v2 refinements (uncommitted on working tree):**
- New handler `xsuaa:assignRoleCollection({ role })`: spawns `btp assign security/role-collection <role> --to-user <state.user> --subaccount <state.subaccount>`. Default role `FigafManagerAdmin` (covers Operator via scope-refs). Non-fatal on failure — upgrade stays committed. Used by the upgrade screen's "Assign me FigafManagerAdmin after upgrade" checkbox (default on, local screen state, not in global ctx). Does NOT pass `--of-idp`; relies on subaccount's primary IDP.
- ScreenXsuaaUpgrade no longer auto-advances after restage. Phases now: `create-xsuaa → assign-role (optional) → push-approuter → map-route → restage`. The screen ends with an explicit "Continue to wizard" button that does `window.location.href = "/"` — the only reboot moment. Re-auth messaging in success state explains JWT staleness and recommends private/incognito if cookies linger. Assignment-failure path surfaces the cockpit deep-link via the existing ScreenXsuaaAssignRole fallback.
- **Why assign-role sits between create-xsuaa and push-approuter (not after map-route):** xs-security.json declares role-collections inline, so they're materialized atomically when create-service reaches `status: succeeded`. Once `map-route` swaps the public hostname onto the (XSUAA-bound) approuter, the operator's very next request gets bounced to IAS — and if the assignment hasn't committed by then, the freshly-minted JWT has no scope and the auto-assign feature is effectively useless. Running assign-role early guarantees the role lands before the route-swap triggers re-authentication. The assignment only needs state.user (from cf:targetOrgSpace) and state.subaccount (from btp:listEnvInstances), both populated during login.
- preload.js + cloud/client.js both expose `figaf.xsuaa.assignRoleCollection(role)` for shape symmetry; in Electron the orchestrator returns "not available in desktop mode".

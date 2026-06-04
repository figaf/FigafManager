# Custom IDP connect flow — design

**Date:** 2026-06-04
**Status:** Approved (design); pending implementation plan
**Scope:** The "Custom IDP" branch of the *Connect to Integration Suite* wizard
flow, in both `figaf-local` (Electron) and `figaf-manager` (cloud).

---

## 1. Purpose

When a Figaf customer wants the Figaf Tool to authenticate against BTP through
their **own SAML identity provider**, three things must happen after they create
a SAML trust in the BTP cockpit:

1. The right BTP role collections (`PI_Administrator`, `PI_Business_Expert`,
   `PI_Integration_Developer`) must be assigned to the SAML **group** `Admin`
   *for that IDP origin*.
2. The Figaf Tool must be given the subaccount's **SSO URL** (the SAML
   `AssertionConsumerService` endpoint, including the landscape-specific
   `…aws-live` alias).

There is **no `btp` CLI command** to create a SAML trust from a metadata file
(confirmed by live CLI enumeration — `btp create security/trust` only connects
SAP Cloud Identity Services *tenants*, and `list security/available-idp` only
lists those tenants, never custom SAML trusts). So step "create the trust" stays
**manual in the cockpit**; the wizard automates everything around it.

This replaces the current `ScreenConnectIdpCustom` stub.

---

## 2. User-facing flow

The `custom-idp` mode (selected on `ScreenConnectIdp`) expands into **two
screens**:

### Screen A — "Create trust" (`connect-idp-custom-trust`)
Manual-prep guidance. The wizard:
- Shows an **"Open Trust Configuration in cockpit"** button (deep-link via
  `shell.openExternal`) plus the raw URL with a copy button.
- Shows a **screenshot** (`saml-trust-cockpit.png`) of how the *New SAML Trust
  Configuration* form should look, in a bordered "Cockpit reference" card.
- Shows numbered instructions: open *New SAML Trust Configuration* (NOT
  *Establish Trust* — that's the IAS path) → upload the file downloaded from the
  Figaf Tool → save it with a name.
- Offers two textboxes:
  - **IDP name** — default `figaf-saml`, stored as `ctx.connect.idpName`.
  - **SAML group** — default `Admin`, stored as `ctx.connect.samlGroup`.
- On **Next**, calls `connect.resolveIdpOrigin({ idpName })` (verify-on-submit).
  On success it stores `originKey` + `trustList` and advances. On no-match it
  stays put and shows a clear error listing the trust names that *were* found.
  There is no separate "Re-check" button — pressing **Next** again (after the
  user has saved the trust in the cockpit or corrected the name) simply re-runs
  the same resolution. `Next` is disabled while `idpName` is blank.

### Screen B — "Assign & link" (`connect-idp-custom-assign`)
Automated. On mount (guarded by a `started` flag), runs two **independent**
chains:
- **Roles chain** — loops the three role collections sequentially, each via
  `connect.assignPiRole({ role, originKey, group })`, rendering a per-row
  checklist (`pending`/`running`/`done`/`error`) with verbatim stderr.
- **SSO chain** — `connect.samlSsoUrl()` → renders the resulting URL in a
  copy card (same shape as the provision screen's `KeyCard`).

A **"Retry failed"** button re-runs only the `error` rows; a **"Retry SSO"**
appears if that fetch failed. **Finish** is enabled once the SSO URL resolves;
a failed role assignment does **not** block Finish (resilient by design) but
surfaces a warning banner naming the unassigned roles.

### Step rail
`connect-provision → connect-idp → [Screen A, Screen B] → done` for custom-IDP;
`connect-provision → connect-idp → [single stub] → done` for the other three
modes (`s-user`, `sap-passport`, `ias`), which are unchanged.

---

## 3. Architecture

The feature follows the established seam: host-agnostic logic in
`packages/core/orchestrator.js`, exposed identically on `window.figaf.connect.*`
in **both** host shims, consumed by shared React screens. No new dependencies,
no bundler, no `mode.js` gate (the flow works in both apps; gating would imply
an asymmetry that does not exist).

### 3.1 New orchestrator handlers

All registered in the `handlers` map (auto-wired by both apps). Inputs are
passed to `run()` as an **args array** — never shell-concatenated — so the
user-typed `idpName`/`samlGroup` cannot inject shell syntax.

| Handler | Input | Returns | Behavior |
|---|---|---|---|
| `connect:trustConfigUrl` | — | `{ ok, url, isTrial }` | Builds the cockpit deep-link from `state.globalAccountGuid` + `state.subaccount` + `state.licenseType`, via the shared `cockpitHost()` helper. Fragment: `#/globalaccount/<gaGuid>/subaccount/<subGuid>/trustConfiguration`. |
| `connect:resolveIdpOrigin` | `{ idpName }` | `{ ok, originKey, all, error? }` | Runs `btp --format json list security/trust --subaccount <sub>`, parses JSON, finds the entry whose `name === idpName`, returns its `originKey`. `all` is `[{name, originKey}]` for a helpful "not found" message. **This is the verify-on-submit call** — invoked once on leaving Screen A; Screen B reuses the stored result and does NOT call it again. |
| `connect:assignPiRole` | `{ role, originKey, group }` | `{ ok, alreadyAssigned, stderr, sessionExpired }` | Runs `btp assign security/role-collection <role> --subaccount <sub> --of-idp <originKey> --to-group <group>`. **One handler per role** so the UI drives the loop and owns per-row state (mirrors `ScreenConnectProvision` + `cf:createService`). Exit 0 → ok (incl. "already assigned"). Detects `Unknown session. Please log in.` → `sessionExpired: true`. |
| `connect:samlSsoUrl` | — | `{ ok, ssoUrl, alias, error? }` | Fetches `https://<subaccountSubdomain>.authentication.<region>.hana.ondemand.com/saml/metadata` over HTTPS (reusing the orchestrator's https helper with its existing 5-redirect cap), regex-extracts the `AssertionConsumerService` `HTTP-POST` `Location`. `region = state.landscape.replace(/^cf-/, "")`. `alias` is the suffix after `/alias/`. |

### 3.2 Shared `cockpitHost()` helper

A small orchestrator-internal helper that returns the correct cockpit base from
`state.licenseType`:
- Trial (`licenseType === "TRIAL"`): `https://cockpit.hanatrial.ondemand.com/trial/`
- Productive: `https://cockpit.btp.cloud.sap/cockpit/`

Used by the new `connect:trustConfigUrl` **and** retrofitted into
`xsuaa:assignRoleCollectionPreflight`, whose current trial/prod ternary is dead
(both branches return `cockpit.btp.cloud.sap`, so it always emits the productive
host even on trial). One correct implementation, both call sites fixed.

### 3.3 State-capture fixes in the orchestrator

Two values the flow needs are not captured today:
- **`state.subaccountSubdomain`** — set in `applySubaccountSelection` from
  `entry.subdomain`. Required by `connect:samlSsoUrl` (the metadata host uses the
  *subaccount* subdomain, e.g. `9c492946trial`, **not** the GA subdomain
  `9c492946trial-ga`).
- **`state.globalAccountGuid`** and **`state.licenseType`** — captured in the
  `btp:loginStart` close handler where the GA JSON is already parsed (we already
  read `subdomain` there from `btp --format json get accounts/global-account`,
  which also returns `guid` and `licenseType`).

### 3.4 UI state (`ctx.connect`)

Existing: `{ marketplaceOk, tasks, keys, idpMode }`. Added:

```js
idpName:   "figaf-saml",   // Screen A textbox, default
samlGroup: "Admin",        // Screen A textbox, default (parameterized, not hardcoded)
originKey: null,           // resolved on leaving Screen A
trustList: null,           // [{name, originKey}] for a precise not-found message
piRoles: [                 // per-row status for Screen B
  { id: "PI_Administrator",         status: "pending" },
  { id: "PI_Business_Expert",       status: "pending" },
  { id: "PI_Integration_Developer", status: "pending" },
],
sso: { status: "idle", url: null, alias: null, error: null },
```

**Reset semantics:**
- Back from **Screen B → Screen A**: keep `idpName`/`samlGroup`; clear
  `originKey`, `trustList`, every `piRoles[].status` → `pending`, and `sso`.
  (Changing the name must force re-resolution.)
- Back from **Screen A → IDP picker**: reset `idpName`/`samlGroup` to defaults
  and clear the rest.
- Backing out of the whole connect flow keeps the existing key-clearing behavior
  in `ScreenConnectProvision`.

---

## 4. Region / cockpit / trial derivation (correctness-critical)

Verified live against a trial account (GA `9c492946trial`, subaccount `trial`):

| Need | Source | Example value |
|---|---|---|
| Trial vs productive | `state.licenseType` (`TRIAL` ⇒ trial) | `TRIAL` |
| GA GUID (cockpit fragment) | `state.globalAccountGuid` | `1c8cdf14-d67c-4385-a3ea-5609c246ac60` |
| Subaccount GUID (cockpit fragment + role cmds) | `state.subaccount` | `dd9a9c34-d48c-4995-854c-bdced0431e8e` |
| Subaccount subdomain (metadata host) | `state.subaccountSubdomain` | `9c492946trial` |
| Region (metadata host) | `state.landscape` minus `cf-` | `us10` |

- **Cockpit deep-link** (trial): `https://cockpit.hanatrial.ondemand.com/trial/#/globalaccount/1c8cdf14-…/subaccount/dd9a9c34-…/trustConfiguration`
- **SSO metadata endpoint**: `https://9c492946trial.authentication.us10.hana.ondemand.com/saml/metadata` → `AssertionConsumerService` HTTP-POST `Location` = `https://9c492946trial.authentication.us10.hana.ondemand.com/saml/SSO/alias/9c492946trial.aws-live`

The `…aws-live` alias is **not** exposed by any `btp` CLI command or by login
state, which is exactly why we fetch-and-parse the public metadata endpoint
rather than constructing the URL.

---

## 5. Asset serving (`saml-trust-cockpit.png`)

The screenshot lives at `packages/ui/saml-trust-cockpit.png` (added by the user).
Path resolution differs by shell, mirroring `figaf-logo.png`:
- **Electron** (`packages/ui/index.html`): sibling-relative `./saml-trust-cockpit.png`
  resolves to the file next to `index.html`. Works in dev and in the packaged
  asar.
- **Cloud** (`cloud/index.html`, served from `/`): a sibling-relative path would
  resolve to `/saml-trust-cockpit.png`, which has no route. So we add an explicit
  `app.get("/saml-trust-cockpit.png", …)` route in `cloud/server.js` exactly like
  the existing `/figaf-logo.png` route, and reference the image with the same
  convention the logo uses.

---

## 6. `--of-idp` / `--to-group` semantics

The new flow uses `--of-idp <originKey> --to-group <group>` — distinct from
`xsuaa:assignRoleCollection`, which deliberately omits `--of-idp` and uses
`--to-user`. Here it is correct because the role collections must be bound to a
**SAML group** assertion (`Admin` by default) **scoped to the custom IDP's
origin**. The group is parameterized (`ctx.connect.samlGroup`) rather than
hardcoded: a wrong group literal would let `btp assign` exit 0 while binding to a
group no SAML assertion ever emits — a green wizard that provisions zero users.

---

## 7. Idempotency & re-entry

- **Re-running role assignment** (already-assigned): `btp assign` exits 0 and the
  row is marked `done` — safe to re-run via "Retry failed".
- **Changing `idpName` after resolving**: handled by the Back-from-B reset
  (§3.4) — `originKey`/`trustList`/`piRoles`/`sso` are cleared so Screen A
  re-resolves on the next Next.
- **Session expiry mid-flow**: `connect:assignPiRole` flags `sessionExpired`; the
  row shows a "session expired — go Back and sign in again" hint. SSO fetch is
  independent and unaffected.

---

## 8. Files touched

| File | Change |
|---|---|
| `packages/core/orchestrator.js` | +4 handlers; +`cockpitHost()` helper; capture `subaccountSubdomain` + `globalAccountGuid` + `licenseType`; retrofit `xsuaa:assignRoleCollectionPreflight` onto the helper |
| `apps/figaf-local/main-process/preload.js` | extend `connect.*` with the 4 methods |
| `apps/figaf-manager/cloud/client.js` | mirror the 4 methods |
| `apps/figaf-manager/cloud/server.js` | +`app.get("/saml-trust-cockpit.png")` |
| `packages/ui/app.jsx` | `connectSteps` derived from `idpMode`; +2 switch cases; extend `ctx.connect` initial state |
| `packages/ui/screens/screen-connect-idp-custom.jsx` | replace stub with `ScreenConnectIdpCustomTrust` (Screen A) |
| `packages/ui/screens/screen-connect-idp-custom-assign.jsx` | **new** — `ScreenConnectIdpCustomAssign` (Screen B) |
| `packages/ui/index.html` + `apps/figaf-manager/cloud/index.html` | +`<script>` tag for Screen B (both shells) |
| `packages/ui/saml-trust-cockpit.png` | already added ✓ |

No new dependencies. Works in both apps.

---

## 9. Out of scope

- Automating the SAML-trust creation itself (no CLI support; stays manual).
- The other three IDP modes (`s-user`, `sap-passport`, `ias`) — still stubs.
- Pushing the SSO URL into the Figaf Tool automatically (the user copies it).
- Attribute-mapping configuration beyond the `Admin` group assignment.

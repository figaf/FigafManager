---
name: Cockpit URL + auth-region derivation (trial vs productive)
description: How to correctly build BTP cockpit deep-links and SAML auth-host URLs from login state; status of the dead-ternary fix and the remaining GUID-vs-subdomain fragment inconsistency
metadata:
  type: project
---

Anywhere the wizard builds a BTP cockpit deep-link or a `*.authentication.<region>.hana.ondemand.com` URL, three DISTINCT derivations are needed off login `state` — do not conflate them. As of the custom-IDP connect flow (branch feat/custom-idp-connect-flow), the canonical helpers live in `packages/core/saml-connect.js`: `cockpitBaseFromLicense(licenseType)`, `trustConfigUrl({licenseType,gaGuid,subGuid})`, `regionFromLandscape(landscape)`. Use these, do not re-derive inline.

**The three derivations:**
1. **Auth region** (SAML metadata URL): `state.landscape` → `regionFromLandscape`. CRITICAL: this must strip BOTH `cf-` AND a trailing CF-cluster discriminator `-<digits>` (`cf-us10-001` → `us10`, `cf-eu10-004` → `eu10`) but PRESERVE a trailing alphabetic segment (`cf-eu10-canary` → `eu10-canary`). Regex: `.replace(/^cf-/,"").replace(/-\d+$/,"")`. The XSUAA/IAS authentication host is REGIONAL, not per-CF-cluster, so the `-NNN` has no meaning there and 404s. Verified against the SP metadata XML in `apps/figaf-manager/saml-9c492946trial-sp.xml` (entityID = `…authentication.us10.hana.ondemand.com`, no `-001`).

   **ASYMMETRY INVARIANT — do not let a refactor unify these:** the CF API host and passcode host (`api.cf.<…>`, `login.<…>`) build via `landscape.replace(/^cf-/,"cf.")` and KEEP the `-NNN` cluster suffix (`api.cf.us10-001.hana.ondemand.com` is correct). Only the *authentication* host drops it. CF hosts keep the cluster discriminator; the auth host drops it. This is intentional and was the source of the 2026-06 custom-IDP 404 bug. Safety net: `connect:samlSsoUrl` fetches-and-parses the metadata, so custom auth domains / sovereign landscapes (where the `<region>.hana.ondemand.com` template doesn't hold) degrade to a clean fetch failure rather than a wrong SSO URL — add an explicit "may use a custom authentication domain" error string there.
2. **Cockpit base** (host + account path prefix together): `cockpitBaseFromLicense` returns trial → `https://cockpit.hanatrial.ondemand.com/trial/`, prod → `https://cockpit.btp.cloud.sap/cockpit/`. Fragment appended: `#/globalaccount/<x>/subaccount/<sub>/<route>`.

**Trial signal — NOW `state.licenseType === "TRIAL"`** (captured at btp login from `btp --format json get accounts/global-account`, field `licenseType`). This replaced the old subdomain-suffix heuristic — it is authoritative; never sniff the subdomain.

**State now captured at login (all present, verified):** `state.globalAccountGuid` + `state.licenseType` (GA-JSON parse block, orchestrator ~line 777-779, runs on every successful btp login); `state.subaccountSubdomain` (applySubaccountSelection ~line 460, from `entry.subdomain`). The SAML metadata endpoint uses the SUBACCOUNT subdomain (`state.subaccountSubdomain`), NOT `state.globalAccountSubdomain` — on a productive account these differ and the wrong one 404s.

**FIXED:** the dead ternary in `xsuaa:assignRoleCollectionPreflight` (both branches emitted prod host) is gone — it now uses `cockpitBaseFromLicense(state.licenseType)`, so trial routing is correct.

**STILL OPEN — GUID-vs-subdomain in the `#/globalaccount/` fragment (the old "BLOCKING UNKNOWN", now a located inconsistency):**
- `connect:trustConfigUrl` puts the GA **GUID** (`state.globalAccountGuid`) in the fragment — believed correct (cockpit fragments want GUIDs in both slots).
- `xsuaa:assignRoleCollectionPreflight` (orchestrator ~line 1903) still puts the GA **SUBDOMAIN** (`ga = state.globalAccountSubdomain`) in the same fragment slot. The two handlers disagree.
- `state.globalAccountGuid` is now captured, so switching the preflight to the GUID is a one-token change. Before doing so, VERIFY on a real subaccount which form the `/users` deep-link actually resolves with — do not assume. If GUID is right, fix the preflight; if subdomain is right, fix trustConfigUrl. They must not stay divergent.

**Why:** Trial and productive BTP use different cockpit hosts AND fragment shapes; the wrong one sends operators to a 404/login-loop. Auth-host region is independent (landscape-derived) and used only for SAML metadata.

**How to apply:** return the URL from the handler; let the screen open it (host.openExternal is a no-op in hosted mode — the browser shim does window.open). Mirror the preflight's return-url-not-open pattern.

Related: [[project_xsuaa_manager_activation]] (the other cockpit/auth-mode flow).
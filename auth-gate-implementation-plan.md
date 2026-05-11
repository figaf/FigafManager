# figaf-manager Auth — Consolidated Implementation Plan (v1 + v2)

> **Scope:** Add authentication to `apps/figaf-manager` (the BTP-hosted installer wizard) in two phases:
>
> - **v1 — Token Gate.** Cockpit-log setup token + single-use claim + signed session cookie. Zero pre-deploy operator config. Ships first.
> - **v2 — XSUAA Upgrade.** Operator-triggered, in-wizard upgrade to persistent SAP IdP auth via a bundled approuter and an auto-provisioned XSUAA service. Layers on top of v1; ships after v1 has been validated in real cockpit deployments.
>
> **Audience:** A senior engineer executing this in a fresh session with no prior conversation context. Read top to bottom; every term is defined.

---

## 0. Phasing & High-Level Direction

### 0.1 Why two phases

v1 solves "the wizard is unauthenticated on the public internet" with the minimum possible operator friction (one zip upload to cockpit, one token paste). v2 solves "the cockpit-log token model has known limitations" (log-drain leaks, Space Auditor caveat, kick-on-restart) by layering proper SAP IdP authentication on top — but only after v1 has shipped, gathered operator feedback, and proven the bootstrap path works.

Both phases are operator-friendly in their own way:

- **v1 operator path:** upload one zip → read token from cockpit Logs → paste → use wizard.
- **v2 operator path (after upgrade):** same as v1 once, then click "Enable persistent SSO login" → wizard does the heavy lifting → assign self to role collection in cockpit (~30 sec) → next time, just navigate to the approuter URL and sign in via SAP IdP.

The operator uploads only ONE zip in either phase. The v2 approuter app is bundled inside the same cloud zip and is pushed from inside the dyno using the operator's already-authenticated cf CLI.

### 0.2 Confirmed design decisions

| Decision | Choice | Reasoning |
|---|---|---|
| Bootstrap auth | Option A (cockpit-log token) + Option D (single-use claim), layered | Zero pre-deploy setup; cockpit logs are the only post-deploy capability the operator reliably has. |
| Persistent management surface | Yes — operators come back to the wizard over time | YAGNI gate cleared. Justifies the v2 complexity. |
| v2 architecture | Two-app approuter (figaf-manager + figaf-manager-approuter) | Battle-tested `@sap/approuter` handles the OAuth/OIDC dance; single-app would mean hand-rolling 200-400 LOC of subtle OAuth client code and harder security review. |
| v2 packaging | Bundled approuter in the cloud zip (~6-8 MB delta) | Deterministic, no runtime GitHub egress dependency. CVE-update story: bump bundled version + redeploy. |
| `FIGAF_AUTH_SECRET` default | Per-boot random when unset | No long-lived secret material exists by default. v2 makes the cookie irrelevant in steady state, so the v1 restart-kicks-operator scenario only matters between deploy and upgrade. |
| Role-collection auto-assignment | No — wizard auto-creates the role collection via xs-security.json; operator self-assigns via cockpit deep link (~30 sec) | Auto-assignment would require `xsuaa apiaccess` service (more attack surface, more cleanup). The friction is one-time and post-deploy. |
| v2 phasing | Single PR, after v1 ships and is proven | Multi-PR split creates dead code in production; standalone "hardening kit" overkill. |

### 0.3 Sequencing

1. **v1 PR opens.** 7 stable commits (see §1.7).
2. **v1 ships.** Validate in at least one real cockpit deployment on each landscape (EU10, US10 minimum).
3. **v2 PR opens.** Single big PR (~1,500 LOC delta). Estimated ~3 weeks focused work + cross-landscape manual testing.
4. **v2 ships.** Token gate becomes dormant code; XSUAA upgrade button surfaces.

---

# Part I — v1: Token Gate

## 1.1 Context

### 1.1.1 What is figaf-manager

`apps/figaf-manager` is one of two wizards in the Figaf Installer monorepo. It is an Express + WebSocket Node.js app, packaged as a zip via `apps/figaf-manager/scripts/build-zip.js`, that an operator deploys into their own SAP BTP Cloud Foundry space. Once running, the operator opens the app's public CF route in their browser and runs the same React wizard (`packages/ui`) that the Electron installer (`apps/figaf-local`) runs locally — but the orchestration (CF login, `cf push`, service creation) executes inside the CF container instead of on the operator's desktop.

The wizard is driven by a `window.figaf` IPC surface that the cloud app implements as `POST /rpc/:channel` plus a streaming `WebSocket /stream` for `cli:line` events from spawned `btp` / `cf` processes.

### 1.1.2 Why an auth gate is required

The app is deployed to a public CF route. Today there is **no authentication** on `/`, `/rpc/*`, or `/stream`. Anyone who guesses or scrapes the route URL can drive the wizard, log into the operator's BTP account (interactively, using the operator's credentials when they get prompted on the wizard), and push Docker images into the operator's space. This is unacceptable for production.

### 1.1.3 The hard constraint

**The operator deploys via the SAP BTP cockpit UI only — they do not have local `cf` CLI installed or configured.** Any auth scheme that requires the operator to read a value out of an environment variable, a service binding, or a generated file via `cf ssh` / `cf env` is a non-starter. The operator's only reliable post-deploy capability is **reading application stdout logs in the cockpit's "Logs" view**.

This rules out: pre-shared env-var secrets the operator pastes back, one-time bootstrap files written to a volume, and (for v1) approuter-fronted XSUAA — XSUAA requires the operator to first complete a deployment that creates the XSUAA instance, a chicken-and-egg with this very installer. v2 breaks the chicken-and-egg by using v1 as the bootstrap.

### 1.1.4 The accepted design — Option A + Option D, layered

Two mechanisms compose:

- **Option A — Cockpit-log token.** At boot, the app generates a 24-byte random token, hashes it (SHA-256), holds the hash in memory, and prints the cleartext token **once** to stdout in a single line tagged `[SETUP]`. The operator reads this line from the cockpit's Logs view and pastes it into a `/setup` claim page in the browser.

- **Option D — Single-use claim.** The token is **single-use**. The first successful POST to `/setup/claim` consumes it, mints a signed session cookie, wipes the in-memory hash, and from that moment forward the `/setup` endpoint returns `410 Gone`.

The two layers compose so that even if the log line leaks (e.g., a log drain feeds it to a SIEM), the attacker still has to win the race against the legitimate operator's first claim. Once claimed, the gate is closed: only the holder of the signed cookie can speak to the app.

## 1.2 Architecture Decisions

### Q1. Where does the `/setup` claim page live?

**Decision:** Static HTML served by Express at `GET /setup`, hand-written, no React, no `packages/ui` dependency.

**Reasoning:** The wizard renderer is behind the gate. Reusing it for `/setup` would require carving out an exception in the WS auth path. A hand-written page is smaller, has no JS dependencies that could fail to load and lock the operator out, and keeps the gate's attack surface minimal. The page is one form with one input and two POST handlers.

### Q2. Post-claim session credential format?

**Decision:** Signed flag cookie. Cookie value is `v1.<hex-mac>.<issued-at-epoch-seconds>`, where `<hex-mac>` is HMAC-SHA256 over `<issued-at>|<client-ip>|<ua-hash>` keyed by `FIGAF_AUTH_SECRET`. IP and UA hash are recomputed server-side on each request — they are NOT stored in the cookie.

**Reasoning:** A bare opaque token gives no binding to the claiming browser. Embedding IP/UA in the cookie leaks reconnaissance. HMAC over server-recomputed inputs gives tamper-evidence and soft binding to the original claiming session without exposing the bound values. `v1.` prefix is a version tag.

Cookie attributes: `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800` (8 hours).

### Q3. Where does the post-boot authentication state live?

**Decision:** In-memory module-scoped object in `cloud/auth.js`:

```js
const authState = {
  setupTokenHash: null,    // 32-byte Buffer, wiped after claim
  claimed: false,
  claimedAt: null,         // epoch ms
  claimantIp: null,        // for audit only, not for re-validation
};
```

**Reasoning:** No persistent store needed. Token is single-use within one process lifetime. CF restart = new token, which is the correct behavior. Avoiding disk/DB state avoids whole classes of failure during initial deployment.

### Q4. WebSocket authentication?

**Decision:** Auth check happens in the `upgrade` event handler, **before** `wss.handleUpgrade`. Parses the `Cookie` header, validates the signed flag, on failure responds with raw HTTP `401 Unauthorized` and destroys the socket. WS close code for auth failure after upgrade is **4003** (application-private range, RFC 6455).

**Reasoning:** Auth-at-upgrade is the only correct seam — once the socket is upgraded, you can no longer reply with a meaningful HTTP error. Doing the check at upgrade means an unauthenticated WS attempt never gets a chance to allocate a session.

### Q5. Renderer reaction to 401/4003?

**Decision:** Both the fetch shim in `cloud/client.js` and the WS handler redirect to `/setup` on `401` (HTTP) or close code `4003` (WS). One-line "Session expired — redirecting…" toast for ~800 ms before navigation.

A new wizard guard in `packages/ui/screens.jsx` (~+20 LOC) listens for a `btp:browserAuth` event and shows a banner if the session was kicked.

### Q6. Where is redaction enforced for the setup token?

**Decision:** Layered — upstream parsing AND downstream regex redaction. Both must be in place.

- **Upstream:** the boot-time `[SETUP] Token: <value>` line is the only place the cleartext is serialized. After successful claim, the in-memory hash is wiped. A second line `[SETUP] Token redacted post-claim` is logged at T+5 minutes (or immediately on claim, whichever comes first).

- **Downstream:** the orchestrator's existing `cli:line` event stream passes through `redact()` in `cloud/server.js`. Regex `/\b[A-Za-z0-9_-]{32,44}\b/g` (matches base64url-shaped tokens) plus explicit allow-prefix for lines starting with `[SETUP]`.

**Reasoning:** Single-layer redaction is brittle. Both layers cost ~20 LOC combined and any one is sufficient on its own. The allow-prefix for `[SETUP]` is critical: without it, the orchestrator's scrubber would mangle the operator's only copy of the token.

### Q7. Test framework?

**Decision:** `node:test` (Node's built-in test runner). No new dependency. Tests live next to file under test as `*.test.js`; invoked via `node --test`.

### Q8. Does `build-zip.js` need v1 changes?

**Decision:** No for v1. The new files (`cloud/auth.js`, `cloud/setup.html`, `cloud/*.test.js`) are under `apps/figaf-manager/cloud/` which is already staged wholesale. (v2 changes `build-zip.js` — see §2.4.)

## 1.3 Token Model — Full Lifecycle

### 1.3.1 Generation (boot)

In `cloud/server.js` startup, **before** the HTTP server begins listening:

```js
const { generateSetupToken, formatSetupLogLine } = require("./auth");
const token = generateSetupToken();      // 24 random bytes → base64url → 32 chars
console.log(formatSetupLogLine(token));  // exactly one line, tagged [SETUP]
```

Token is **24 bytes** (`crypto.randomBytes(24)`) encoded as **base64url** (no padding) → 32 ASCII characters. 192 bits of entropy. Format chosen so it copy-pastes cleanly out of cockpit log views.

The single log line:

```
[SETUP] Token: <32-char-base64url> — visit https://<route>/setup within 30 minutes to claim. This token is single-use and will not appear in logs again.
```

Route URL is read from `process.env.CF_APP_URI` with fallback to `process.env.FIGAF_PUBLIC_URL`. If neither is set, the route portion is omitted.

`generateSetupToken()` stores `SHA-256(token)` in `authState.setupTokenHash` and returns the cleartext for logging. Cleartext does not survive the call frame.

### 1.3.2 Claim (operator-driven)

1. Operator opens `https://<route>/setup` in browser.
2. Static HTML loads. Form has one password-type input.
3. Operator pastes token, submits → `POST /setup/claim` with `Content-Type: application/json` body `{ "token": "<value>" }`.
4. Server calls `verifySetupToken(submitted)`:
   - Constant-time compare `SHA-256(submitted)` to `authState.setupTokenHash`.
   - If `authState.claimed === true` → `{ ok: false, code: "ALREADY_CLAIMED" }` → HTTP **410 Gone**.
   - If hash mismatch → `{ ok: false, code: "INVALID" }` → HTTP **401**. No rate limit in v1 (see §1.10).
   - If match → `recordClaim({ ip, ua })`, wipe `authState.setupTokenHash = null`, set `authState.claimed = true`, return `{ ok: true }`.
5. On success: `issueCookie(res, { ip, ua })` sets the signed flag cookie, responds `200` with `{ redirect: "/" }`.
6. Browser navigates to `/`, wizard loads, every subsequent request carries the cookie.

### 1.3.3 Post-claim audit line

A `setTimeout(..., 5 * 60 * 1000)` scheduled at boot fires `console.log("[SETUP] Token redacted post-claim")` if `authState.claimed === true` at that moment. If not claimed within 5 min, the line is deferred until claim. Marker for log searchers: "everything before this point in the log may contain the token; everything after does not."

### 1.3.4 `FIGAF_AUTH_SECRET` — cookie-signing key

`auth.js` reads `process.env.FIGAF_AUTH_SECRET` at module init. If unset, generates a **per-boot random 32-byte secret** and logs at info level:

```
[INFO] FIGAF_AUTH_SECRET not set — using ephemeral per-boot secret. All sessions will invalidate on restart.
```

**Implication:** Every CF restart invalidates all live cookies → operator must re-claim. This is the safer default; v2 makes this scenario short-lived (cookie becomes irrelevant post-upgrade). If `FIGAF_AUTH_SECRET` is explicitly set in the manifest, it's used and survives restarts.

## 1.4 File-by-File Change List (v1)

All paths absolute, Windows form. LOC is "added lines including imports and comments, excluding tests."

| # | File | Action | ~LOC | Purpose |
|---|------|--------|------|---------|
| 1 | `C:\Figaf-installer\apps\figaf-manager\cloud\auth.js` | **New** | ~220 | Token generation, hashing, claim state, cookie sign/verify, redaction allow-prefix helper, clock injection for tests. |
| 2 | `C:\Figaf-installer\apps\figaf-manager\cloud\setup.html` | **New** | ~80 | Static `/setup` claim page. No JS framework. Vanilla `fetch` for POST. |
| 3 | `C:\Figaf-installer\apps\figaf-manager\cloud\server.js` | **Modified** | ~+90 | Wire `auth.js` into startup, mount `/setup` (GET) and `/setup/claim` (POST), add `requireAuth` middleware to `/`, `/rpc/*`, and to the WS `upgrade` handler. Extend `redact()` with the base64url-shaped pattern and `[SETUP]` allow-prefix. |
| 4 | `C:\Figaf-installer\apps\figaf-manager\cloud\client.js` | **Modified** | ~+25 | Intercept `401` from `fetch` and `4003` from WS, fire `btp:browserAuth` event, redirect to `/setup` after 800 ms. |
| 5 | `C:\Figaf-installer\apps\figaf-manager\cloud\index.html` | **Modified** | ~+3 | Add one-shot sessionStorage check on load to surface "session-expired" banner. |
| 6 | `C:\Figaf-installer\packages\ui\screens.jsx` | **Modified** | ~+20 | Subscribe to `btp:browserAuth` event in the wizard's top-level component; render banner if `window.sessionStorage.getItem("figaf:auth-kicked") === "1"`. Hosted-only — gate on `window.figafModeFlags.isHosted`. |
| 7 | `C:\Figaf-installer\apps\figaf-manager\cloud\auth.test.js` | **New** | ~250 | `node:test` cases — see §1.9.2. |
| 8 | `C:\Figaf-installer\apps\figaf-manager\cloud\redact.test.js` | **New** | ~80 | `node:test` cases for redaction regex + `[SETUP]` allow-prefix. |
| 9 | `C:\Figaf-installer\apps\figaf-manager\cloud\server.test.js` | **New** | ~180 | `node:test` cases for `/setup`, `/setup/claim`, `requireAuth` on `/rpc/*`. |
| 10 | `C:\Figaf-installer\apps\figaf-manager\cloud\ws-auth.test.js` | **New** | ~120 | `node:test` cases for upgrade-handler auth. |

**Files NOT touched in v1:**
- `packages/core/orchestrator.js` — auth is a cloud-only concern in v1.
- `apps/figaf-local/**` — Electron app has no public surface.
- `apps/figaf-manager/scripts/build-zip.js` — see Q8.
- `apps/figaf-manager/manifest.yml` — no required new env vars.

### Critical detail — redact allow-prefix

```js
function redact(line) {
  if (typeof line === "string" && line.startsWith("[SETUP]")) return line; // allow-prefix
  return line.replace(/\b[A-Za-z0-9_-]{32,44}\b/g, "[redacted]");
}
```

The boot line is printed via `console.log` (stdout) — NOT via `cli:line`, so the operator never sees it through the wizard. The allow-prefix is belt-and-braces.

## 1.5 Module Surface — `cloud/auth.js` (v1)

```js
// Token lifecycle
generateSetupToken() → string                  // mints token, stores hash, returns cleartext (call exactly once at boot)
formatSetupLogLine(token) → string             // assembles the [SETUP] Token: ... line
verifySetupToken(submitted) → { ok, code? }    // constant-time compare; codes: INVALID | ALREADY_CLAIMED | NO_TOKEN
recordClaim({ ip, ua }) → void                 // sets claimed=true, wipes hash, stamps claimedAt/claimantIp
isClaimed() → boolean

// Per-request auth
verifyAuth(req) → { ok, reason? }              // parses cookie, recomputes MAC against req IP+UA, returns ok/no
clientIp(req) → string                         // centralized X-Forwarded-For handling (see R2)
parseAuthCookie(cookieHeader) → { v, mac, iat } | null
signSession({ ip, ua, iat }) → string          // builds cookie value
issueCookie(res, { ip, ua }) → void            // sets Set-Cookie header with attributes

// Test seams
__setNow(fn)                                   // dependency-injects a clock for time-based tests
const _now = () => Date.now()                  // default, replaced by __setNow
```

State lives in module-scoped `authState`; everything else is deterministic given inputs and `_now`. Tests use `__setNow(() => fixed)` to assert cookie expiry and the +5min audit line.

## 1.6 `/setup` HTML — User-Facing Copy

Body content of `cloud/setup.html`:

**Title (h1):** `Figaf Installer — Setup`

**Lead paragraph:**
> This installer requires one-time setup before you can use it. The deployment generated a one-time setup token and printed it to this app's startup logs in the BTP cockpit. Paste it below to claim this installer instance.

**How-to panel:**
> **Where to find the token:** In the SAP BTP cockpit, open the Cloud Foundry space where you deployed this app → open the app `figaf-manager` → "Logs" tab → find the most recent line beginning with `[SETUP] Token:`.

**Field label:** `Setup token`

**Submit button:** `Claim and continue`

**Trust-scope notice:**
> Anyone in your Cloud Foundry space with the `Space Developer` or `Space Auditor` role can read this app's logs and therefore could claim this installer. Only the first claim succeeds; subsequent attempts return `Gone`. After you claim, your browser receives a session cookie that expires in 8 hours.

**Log-drain warning (yellow):**
> **Note:** if you have configured a log drain (e.g., an SIEM, Loggregator forwarder, or Application Logging Service) for this space, the setup token has also been forwarded there. Treat any system that received your CF logs at deploy time as trusted, or redeploy to rotate the token.

**CF role-requirement note (footer):**
> The operator who deploys this app must have the `Space Developer` role to view the startup logs in the cockpit. If you see only `Space Auditor` in your role assignments, ask your space manager to either grant `Space Developer` or read the token for you out of the cockpit Logs view.

**Error states:**

- 401: `That token is not valid. Check that you copied the full value from the [SETUP] Token line in the cockpit logs and try again.`
- 410: `This installer has already been claimed. If you are the operator, your browser may have lost its session cookie — clear the cookie for this domain and reload the app to be redirected to the wizard. If you are not the operator, this installer is no longer accepting new claims; redeploy the app to issue a fresh setup token.`

## 1.7 Implementation Sequence — Stable Commits (v1)

### Commit 1 — `cloud/auth.js` module, no wiring

Add `auth.js` with all exports stubbed and tested. Add `auth.test.js`. Server is unchanged. App still has no gate. `node --test` passes.

### Commit 2 — Redaction layer

Modify `redact()` in `cloud/server.js`. Add `redact.test.js`. Base64url-shaped pattern is now scrubbed from every `cli:line`, with the `[SETUP]` allow-prefix. Lands the defensive net before commit 3 adds the thing that needs defending.

### Commit 3 — `[SETUP]` boot log line

Call `generateSetupToken()` and `console.log(formatSetupLogLine(token))` in `server.js` startup. Schedule the T+5min audit line. **Do not** mount `/setup` or `requireAuth` yet. Token is now minted on every boot. No-op from user perspective.

### Commit 4 — `/setup` and `/setup/claim` endpoints

Mount the static HTML route, mount the POST handler, wire `issueCookie`. Add `server.test.js` coverage. **Still no gate** — claiming works but doesn't gate anything.

### Commit 5 — `requireAuth` on `/` and `/rpc/*`

Add the middleware. HTTP surface is gated. WS still open. Add `server.test.js` cases for 401 unauthed and redirect on 401 of `/`.

### Commit 6 — WS upgrade-handler auth

Wire the upgrade handler. Add `ws-auth.test.js`. Full gate active. Add `client.js` interception of `4003` and redirect to `/setup`.

### Commit 7 — UX polish

Add the `btp:browserAuth` event, sessionStorage one-shot, banner in `packages/ui/screens.jsx`, toast in `client.js`. Verify the manual cockpit run-through (§1.9.1).

## 1.8 Risk Register (v1)

| ID | Risk | Severity | Mitigation |
|----|------|----------|------------|
| R1 | `cli:line` UX regression — operator sees mid-stream `[redacted]` and thinks something is broken | Low | Emit placeholder line `[cli] <output line redacted by security policy>` instead of bare `[redacted]`. |
| R2 | GoRouter X-Forwarded-For — `req.socket.remoteAddress` is the GoRouter IP, not the operator's | High | Centralize in `clientIp(req)` — use `X-Forwarded-For` first value, fall back to `req.socket.remoteAddress`. All auth paths must go through this helper. |
| R3 | WS cookie-on-upgrade — some browsers/proxies strip cookies from the WS upgrade request | Medium | Test on Chrome, Edge, Firefox during commit 6 smoke. Fallback: token-in-URL `?auth=<short-lived-handle>` issued by an authed `/rpc/ws-handshake` endpoint. Not implemented unless smoke uncovers a failure. |
| R4 | Operator lacks `Space Developer` role and cannot read CF logs | Medium | Surface in `/setup` page footer. No technical mitigation. |
| R5 | Race on log read — log forwarder reads `[SETUP]` line before operator and attacker claims first | Accepted | Documented in `/setup` log-drain warning. Option D (single-use) mitigates partially. |
| R6 | `FIGAF_AUTH_SECRET` per-boot default invalidates cookies on CF auto-restart, kicking operator mid-install | By design | Info log line at boot signals this. Operator can set explicitly to opt into persistence. v2 makes this scenario irrelevant in steady state. |
| R7 | `figaf-local` regression — auth code accidentally gates Electron app | High | Manual smoke required: build figaf-local, run installer, verify no `[SETUP]` line, verify wizard loads with no claim flow. Auth code lives in `apps/figaf-manager/cloud/` only. |
| R8 | Redaction false positives — legitimate output gets mangled | Medium | Regex is narrow: `\b[A-Za-z0-9_-]{32,44}\b` — base64url charset only, word boundaries. Service binding creds typically contain `+/=` and won't match. Tests assert this. |

## 1.9 Verification Plan (v1)

### 1.9.1 Manual cockpit run-through

1. `npm --workspace apps/figaf-manager run build-zip`. Verify zip is produced.
2. `unzip -l` the zip; verify `cloud/auth.js` and `cloud/setup.html` are present; no `*.test.js`.
3. Upload zip to BTP cockpit. Wait for `RUNNING`.
4. Cockpit → Logs tab. Find `[SETUP] Token: <value>` line. Copy token.
5. Open app's public route in fresh private window. Verify redirect to `/setup` (or `/` returns 401 → `/setup`).
6. Paste token. Submit. Verify redirect to `/` and wizard loads.
7. In second private window, navigate to `/`. Verify redirect to `/setup`. Paste same token. Verify 410.
8. Navigate first window's wizard. Confirm WS connects, `cli:line` streams, nothing in terminal contains 32-char base64url.
9. Cockpit Logs at T+5min. Verify `[SETUP] Token redacted post-claim` is present.
10. Restart app via cockpit. Verify new `[SETUP]` line and original cookie now redirects.

### 1.9.2 `node:test` cases

**`auth.test.js` (~12 cases):** generateSetupToken format, hash storage, no leftover cleartext, verifySetupToken positive/negative/already-claimed/no-token, recordClaim wipes hash, signSession/verifyAuth round-trip, ip/ua/expiry rejection.

**`redact.test.js` (~5 cases):** 32-char base64url redacted, 44-char redacted, 31-char NOT redacted (below threshold), `[SETUP]` prefix passed through, JSON with `+/=` NOT redacted.

**`server.test.js` (~8 cases):** GET /setup returns HTML, POST /setup/claim correct/wrong/double, GET / without/with cookie, POST /rpc/* without/with cookie.

**`ws-auth.test.js` (~5 cases):** upgrade without cookie → 401, invalid cookie → 401, valid cookie → open, mid-session expiry → 4003 close, concurrent independent outcomes.

### 1.9.3 Build-zip verification

Inline check in commit 7 confirms `cloud/auth.js` and `cloud/setup.html` present; no `*.test.js` files included.

## 1.10 Out of Scope for v1

The following are deliberately not in v1. Some are addressed by v2; others are future hardening.

- **Cookie rotation** — bounded utility of a stolen cookie. Future.
- **Audit log of claim attempts** — ring buffer of failed claims. Future.
- **Rate limiting on `/setup/claim`** — token entropy (192 bits) is the primary defense. Per-IP limit is cheap defense-in-depth. Future.
- **Multi-user concurrent claims** — v1 is single-claim.
- **CSRF tokens on `/rpc/*`** — `SameSite=Strict` is primary defense in v1.
- **CSP headers** — independently valuable, not auth-specific.
- **Encrypted-at-rest secrets** — future SAP Credential Store integration.
- **Replacing `cli:line` with structured event protocol** — large refactor.

---

# Part II — v2: XSUAA Upgrade

## 2.0 When to Start v2

**Wait until v1 has shipped and been validated** in at least one real cockpit deployment on each major BTP landscape (EU10, US10 minimum). Real-world feedback from v1 informs v2 UX (button placement, copy, error messages).

The v2 PR is single, large (~1,500 LOC delta), and estimated ~3 weeks of focused work + cross-landscape manual testing because `cf restage` and IAS behavior have known landscape variance.

## 2.1 The Upgrade Flow at a Glance

After the operator has claimed the wizard via the v1 token and authenticated to BTP/CF via the wizard's normal flow, a new button appears: **"Enable persistent SSO login."** Clicking it triggers an orchestration sequence run from inside the dyno using the operator's already-authenticated cf CLI:

1. Create XSUAA service: `cf create-service xsuaa application figaf-manager-xsuaa -c xs-security.json`
2. Push a small approuter app (`figaf-manager-approuter`) as a second CF app in the same space, bound to the XSUAA instance
3. Map the wizard's existing public route to the approuter, then unmap from the manager
4. Bind manager to the XSUAA instance; restage manager so it can validate JWTs via `@sap/xssec`
5. Operator clicks a deep-link to cockpit, assigns self to `FigafManagerOperator` role collection (~30 sec)
6. From that point on, any user in the role collection visits the approuter URL, gets redirected to SAP IdP, signs in, and reaches the wizard

The token-based bootstrap path is **disabled** when XSUAA mode is active. v1 code stays in the codebase as dormant code (gated by `isXsuaaActive()` check at boot).

## 2.2 The Restage-Self Handoff Sequence

The naive sequence (`cf bind-service` then `cf restage`) creates a silent 30-90s dead window. The correct sequence is **approuter-first with maintenance page**:

### Phase 1 — Pre-flight (fully reversible)

```
1.1  cf create-service xsuaa application figaf-manager-xsuaa
       -c xs-security.json    (wizard-scoped — see §2.6)
1.2  Poll until status=succeeded                      [emit cf:serviceStatus]
1.3  Stage approuter app dir on disk inside the dyno
       (writes ./figaf-manager-approuter/ from bundled template)
1.4  cf push figaf-manager-approuter -p ./figaf-manager-approuter
       --no-route --no-start
1.5  cf bind-service figaf-manager-approuter figaf-manager-xsuaa
1.6  cf start figaf-manager-approuter
       (serves "maintenance" HTML on /, plus /_health endpoint;
        not yet routed anywhere public)
```

### Phase 2 — Cutover (short, explainable destructive window)

```
2.1  Capture manager's current public route hostname.
2.2  cf map-route figaf-manager-approuter <route>
       (route resolves to BOTH apps; CF round-robins. ~3-5s
        ambiguous window. v1 gate still in force on manager.)
2.3  cf unmap-route figaf-manager <route>
       (route now resolves only to approuter)
2.4  cf bind-service figaf-manager figaf-manager-xsuaa
2.5  cf restage figaf-manager
       (manager down 30-90s; approuter serves maintenance page)
2.6  Poll manager's /_health via approuter's internal forwarding.
```

### Phase 3 — Handoff

```
3.1  Maintenance page switches to "ready" state.
3.2  Operator clicks "Sign in via SAP IAS" → approuter redirects
     to IAS → operator authenticates → approuter validates JWT
     → forwards to manager with Authorization header.
3.3  Manager's @sap/xssec middleware validates JWT, sees
     FigafManagerOperator scope, lets request through.
```

### What the operator sees, end-to-end

| Time | What's on screen |
|---|---|
| 0s | Wizard. Operator clicks "Enable persistent SSO login" |
| 0-10s | "Creating XSUAA instance…" with `cf:serviceStatus` stream |
| 10-30s | "Deploying authentication proxy…" with `cli:line` stream |
| 30-35s | Full-screen modal: "Your browser is about to be redirected. This page will refresh automatically." Wizard starts polling approuter's `/_health`. |
| 35-90s | Poll succeeds. Wizard hard-reloads. Maintenance page now served. Maintenance page polls `/_manager-health` until manager is back. |
| 90s+ | "Authentication upgrade complete. Click to sign in via SAP IAS." Operator clicks, IdP flow, lands back on wizard. |

### Cookie/session implications

- v1 auth-gate cookie is discarded. Only JWT-from-approuter is trusted post-upgrade.
- Token-claim path (`/setup`, `/setup/claim`) is **disabled** when XSUAA mode is active.
- XSUAA-mode determination is read at boot from `VCAP_SERVICES` — if `xsuaa` is bound, XSUAA mode is on. No runtime mode-switching; the restage is the seam.

### Why this sequence wins

1. Every destructive step has a visible UI counterpart.
2. Maintenance page is served by an app whose lifecycle we control during the only window where manager is down.
3. If any Phase 1 step fails, nothing about manager's route/bindings has changed — clean rollback.
4. Phase 2 rollback window is narrow (~5s between 2.5 and 2.6).

## 2.3 Architecture Choice: Two-App Approuter

**Decision: two-app approuter.** Not route-service, not embedded approuter.

Why route-service variant doesn't fit:
- Standard XSUAA service plan doesn't expose a route-service URL by default
- IAS login redirect dance (302 → IAS → callback → set session cookie) is the approuter's specialty — reimplementing in route-service code means PKCE, state param, nonce validation by hand
- WS forwarding through CF route services has known cross-version brittleness
- Every SAP reference implementation uses approuter, not route services

Why two-app wins:
- `packages/deploy-templates/` already uses two-app for the Figaf Tool deployment — same pattern, applied to the wizard
- WS forwarding through approuter is supported out of the box (`forwardAuthToken: true` + default WS upgrade handling)
- Standard logout, session, CSRF from the approuter package
- Existing `xs-app.json` in the repo as a reference shape (do NOT reuse directly — see §2.4)

### Non-obvious consideration

After v2 upgrade, the operator's space contains **two approuters and two XSUAA instances** — one for the wizard, one for the Figaf Tool. That's correct but worth flagging:
- Both approuters consume 128 MB memory each. Space quota needs ~256 MB headroom on top of the 1 GB manager and 4-8 GB tool.
- Two XSUAA instances with independent `xsappname` and independent role collections. Operator assigns to `FigafManagerOperator` (wizard) and `IRTAdmin` (tool) separately.
- **Do NOT share XSUAA instances between wizard and tool** — mixing them is a privilege-escalation seam.

## 2.4 Approuter Packaging

**Decision: bundle the wizard's approuter into the cloud zip** (Option 4a in the prior analysis).

The existing `packages/deploy-templates/approuter/` is for the **Figaf Tool**, not the wizard. Routing rules are different. Must NOT reuse directly. Create a new workspace package.

### File layout

```
C:\Figaf-installer\packages\manager-approuter\        ← NEW workspace package
├── package.json                                       (name: @figaf/manager-approuter; deps: @sap/approuter)
├── xs-app.json                                        wizard-specific routing
├── xs-security.json                                   wizard XSUAA descriptor (see §2.6)
├── maintenance.html                                   served during restage
└── server.js                                          wraps @sap/approuter + /_health + /_manager-health
```

### Build-zip changes (~30 LOC)

- Copy `packages/manager-approuter/` into `.staging/manager-approuter/` during build
- Run `npm install --omit=dev` inside `.staging/manager-approuter/` to populate its `node_modules`
- Existing zip step automatically includes it (~6-8 MB delta)

### Why not download from GitHub at runtime

- Adds outbound egress dependency from the dyno
- Operator's CF space may have restrictive egress rules
- Atomic upgrade story: bundled = every wizard version ships with a pinned approuter version
- **Trade-off:** CVE updates to `@sap/approuter` require redeploying the wizard. Mitigation: release notes line "redeploy wizard to receive approuter security updates."

## 2.5 Role-Collection Auto-Assignment

**Decision: partial — auto-create the role collection via xs-security.json; do NOT auto-assign the user.**

### Why not full auto-assignment

The CF token the wizard obtains via `cf login --sso` is scoped to **CF resources** in the operator's space. It cannot call subaccount-level XSUAA admin APIs. To assign users to role collections programmatically, you'd need either:
- A bound `xsuaa apiaccess` service (more attack surface, more cleanup)
- A `cis-central!b14` Cloud Management Service binding (same)
- Global Account Admin role on the operator's user (often not present)

Provisioning `xsuaa apiaccess` from inside the dyno is technically feasible but adds another service to clean up and code that calls subaccount-admin APIs with elevated privilege. Cost-benefit is wrong.

### The deep-link approach

- `xs-security.json` declares `role-collections: [{ name: "FigafManagerOperator", ... }]` so XSUAA auto-creates the role collection on service-instance creation.
- After upgrade, wizard renders a one-step screen:

  > "Assign yourself to the FigafManagerOperator role"
  >
  > Click here to open BTP cockpit: `https://emea.cockpit.btp.cloud.sap/cockpit#/globalaccount/<gaId>/subaccount/<subId>/users` (constructed from data the wizard already has via `btp accounts subaccount list`).

- Operator clicks deep-link → cockpit user-management UI → finds self → "Assign Role Collection" → picks `FigafManagerOperator` → ~30 seconds.
- Wizard polls approuter's `/` for an authenticated probe; once operator has the role and has logged in via IAS, probe succeeds and wizard advances.

This is the same friction Option B in v1 rejected for being the primary auth mechanism. As a **one-time post-deploy upgrade step**, the friction is acceptable.

## 2.6 `xs-security.json` Sketch

For the wizard's own XSUAA. Lives at `C:\Figaf-installer\packages\manager-approuter\xs-security.json`.

```json
{
  "xsappname": "figaf-manager-xsuaa",
  "tenant-mode": "dedicated",
  "description": "XSUAA for the Figaf Installer wizard (figaf-manager)",
  "scopes": [
    {
      "name": "$XSAPPNAME.FigafManagerOperator",
      "description": "Run the Figaf installer wizard"
    },
    {
      "name": "$XSAPPNAME.FigafManagerAdmin",
      "description": "Destructive operations (delete tool deployment, rotate roles)"
    }
  ],
  "role-templates": [
    {
      "name": "FigafManagerOperator",
      "description": "Deploy and configure the Figaf Tool via the installer wizard.",
      "scope-references": ["$XSAPPNAME.FigafManagerOperator"]
    },
    {
      "name": "FigafManagerAdmin",
      "description": "Includes operator + destructive operations.",
      "scope-references": [
        "$XSAPPNAME.FigafManagerOperator",
        "$XSAPPNAME.FigafManagerAdmin"
      ]
    }
  ],
  "role-collections": [
    {
      "name": "FigafManagerOperator",
      "description": "Run the Figaf installer wizard.",
      "role-template-references": ["$XSAPPNAME.FigafManagerOperator"]
    },
    {
      "name": "FigafManagerAdmin",
      "description": "Full control of the installer including destructive operations.",
      "role-template-references": ["$XSAPPNAME.FigafManagerAdmin"]
    }
  ],
  "oauth2-configuration": {
    "redirect-uris": ["https://**.hana.ondemand.com/**"],
    "token-validity": 3600,
    "refresh-token-validity": 86400
  }
}
```

### Design choices

- **Two role templates** — Operator (normal use), Admin (destructive ops). Minimum-privilege by default.
- **`xsappname: figaf-manager-xsuaa`** — distinct from `figaf-xsuaa` (the tool's). Strict scope namespace isolation.
- **`tenant-mode: dedicated`** — wizard is operator-owned, not multi-tenant SaaS.
- **Role-collections auto-declared** — XSUAA auto-creates them on service-instance creation. Removes one cockpit step.
- **`redirect-uris: ["https://**.hana.ondemand.com/**"]`** — tight enough to prevent open-redirect via OAuth flow, permissive enough for all BTP landscapes.
- **Token validity 1h, refresh 24h** — matches normal SAP defaults.
- **No `foreign-scope-references`, no `authorities`** — strict isolation from the tool's XSUAA.

## 2.7 Reconciliation with v1

| v1 component | v2 fate | Rationale |
|---|---|---|
| `cloud/auth.js` token-mode logic | **Retained, gated.** A `function isXsuaaActive()` checks `VCAP_SERVICES` for an `xsuaa` binding. If active, token-gate code paths short-circuit. | Bootstrap path is still token-gate. Post-upgrade, same code is dormant. No deletion = no regression risk on bootstrap. |
| `[SETUP] Token:` boot log line | **Suppressed when XSUAA is active.** Print `[INFO] XSUAA mode active — token gate disabled` instead. | Leaking a token line post-upgrade is both useless and confusing. |
| Base64url redaction regex + `[SETUP]` allow-prefix | **Retained, unchanged.** | Defensive depth. Costs nothing to keep. |
| `/setup` static HTML page | **Returns 410 Gone when XSUAA active.** Or redirect to `/` (approuter sends to IAS). | Setup flow is meaningless under XSUAA. |
| `/setup/claim` POST endpoint | **Returns 410 Gone when XSUAA active.** | Stale tab or attacker probe. 410 is correct. |
| `requireAuth` HTTP middleware | **Replaced by `@sap/xssec` JWT validation when XSUAA active.** Middleware function pointer is swapped at boot based on `isXsuaaActive()`. | Two middlewares, one code path each, selected once at boot. No per-request branching. |
| WS upgrade auth handler | **Switched to JWT extraction from cookie/header when XSUAA active.** | Approuter forwards JWT in `Authorization: Bearer` or `JSESSIONID`-style cookie. Validate via `@sap/xssec.createSecurityContext()`. |
| Signed-cookie `figaf_session` | **Removed when XSUAA active.** | Session lifecycle is approuter's job. |
| `FIGAF_AUTH_SECRET` env var | **Irrelevant when XSUAA active.** | No signed cookies to verify. Approuter has own session secret. |
| 4003 WS close code | **Retained for cookie expiry; supplemented by 4004 for JWT-invalid.** | Distinguishes client-side redirect target (4003 → `/setup`, 4004 → `/` → IAS re-login). |
| `client.js` 401-redirect-to-`/setup` | **Modified: 401 redirects to `/` when XSUAA detected client-side.** | Client knows XSUAA is active via `window.figafXsuaaMode` flag injected into HTML. |

**One genuine flex from v1:** the §1.3.4 `FIGAF_AUTH_SECRET` per-boot-vs-fixed question becomes less load-bearing. If the operator is going to upgrade to XSUAA anyway, the kick-on-restart problem stops mattering post-upgrade. **Locks in the per-boot random default.**

## 2.8 Cleanup Story

After upgrade, the existing `cf:deleteApp` flow becomes a multi-step teardown. **Order matters:**

```
1. cf unbind-service figaf-manager-approuter figaf-manager-xsuaa
2. cf unbind-service figaf-manager           figaf-manager-xsuaa
3. cf delete figaf-manager-approuter -r -f      (-r unmaps routes)
4. cf delete figaf-manager           -r -f
5. cf delete-service figaf-manager-xsuaa -f
6. btp delete security/role-collection --role-collection FigafManagerOperator
7. btp delete security/role-collection --role-collection FigafManagerAdmin
```

| Resource | Auto-cleaned? |
|---|---|
| `figaf-manager` app | Yes (step 4) |
| `figaf-manager-approuter` app | Yes (step 3) |
| Public route | Yes (`-r` flag on step 3) |
| `figaf-manager-xsuaa` service instance | Yes (step 5) |
| `FigafManagerOperator` role collection | **No by default** — best-effort via step 6 |
| `FigafManagerAdmin` role collection | **No by default** — best-effort via step 7 |

If steps 6/7 fail (e.g., btp session expired), fall back to a wizard screen instructing manual cleanup. This is non-blocking — the role collections are orphaned but harmless.

### The fire-and-forget delete-self problem

The wizard runs inside the manager. When the operator clicks "Uninstall wizard," the manager is going to delete itself. The HTTP response must complete BEFORE the manager dies, or the operator sees a broken page.

Pattern:
```js
res.json({ ok: true, message: "Uninstall in progress. Page will go offline in ~30s." });
setImmediate(() => runDeleteSteps());
```

Detach the actual delete steps from the response cycle.

## 2.9 v2 File-by-File Change List

| # | File | Action | ~LOC | Purpose |
|---|---|---|---|---|
| 1 | `packages/manager-approuter/package.json` | New | ~15 | Workspace package; deps: `@sap/approuter`. |
| 2 | `packages/manager-approuter/xs-app.json` | New | ~30 | Routing config: forward to `figaf-manager-internal`, WS pass-through, IAS auth on all but `/_health`. |
| 3 | `packages/manager-approuter/xs-security.json` | New | ~50 | Wizard XSUAA descriptor (see §2.6). |
| 4 | `packages/manager-approuter/maintenance.html` | New | ~80 | Maintenance page during restage. Polls `/_health` and `/_manager-health`, swaps body when ready. |
| 5 | `packages/manager-approuter/server.js` | New | ~120 | Wraps `@sap/approuter` with `/_health` (always 200) and `/_manager-health` (proxies to manager). Serves maintenance HTML during manager downtime. |
| 6 | `apps/figaf-manager/cloud/server.js` | Modified | +~150 | `isXsuaaActive()` gate, conditional middleware swap, `/health` endpoint, suppress `[SETUP]` under XSUAA, WS auth switch. |
| 7 | `apps/figaf-manager/cloud/auth.js` (v1) | Modified | +~30 | Gate token-mode behind `isXsuaaActive()` check. |
| 8 | `apps/figaf-manager/cloud/xsuaa-auth.js` | New | ~150 | `@sap/xssec` integration: middleware, WS upgrade auth, scope check, JWT extraction from approuter headers. |
| 9 | `apps/figaf-manager/cloud/client.js` | Modified | +~40 | Detect `window.figafXsuaaMode`, redirect to `/` (not `/setup`) on 401, distinguish 4003 vs 4004. |
| 10 | `apps/figaf-manager/cloud/index.html` | Modified | +~5 | Inject `window.figafXsuaaMode` flag. |
| 11 | `apps/figaf-manager/scripts/build-zip.js` | Modified | +~40 | Stage `packages/manager-approuter/` into `.staging/manager-approuter/`, `npm install --omit=dev` inside it. |
| 12 | `apps/figaf-manager/package.json` | Modified | +~5 | Add `@sap/xssec` to dependencies. |
| 13 | `packages/core/orchestrator.js` | Modified | +~250 | New handlers: `xsuaa:upgradeStart`, `xsuaa:upgradePhase`, `cf:createXsuaa`, `cf:pushManagerApprouter`, `cf:mapRoute`, `cf:unmapRoute`, `cf:restage`, `xsuaa:assignRoleCollectionPreflight`, `cf:uninstallManager` (replaces single-app delete). |
| 14 | `packages/ui/screens.jsx` | Modified | +~200 | `ScreenXsuaaUpgrade` (phase-aware UI), `ScreenXsuaaAssignRole` (deep-link), maintenance-page polling. |
| 15 | `packages/ui/app.jsx` | Modified | +~30 | New wizard branch `xsuaaSteps`; new feature flag `features.xsuaaUpgrade`. |
| 16 | `packages/ui/mode.js` | Modified | +~10 | Add `xsuaaUpgrade` feature flag (hosted-only, post-deploy only). |
| 17 | `apps/figaf-manager/cloud/xsuaa-auth.test.js` | New | ~150 | JWT validation, scope check, WS auth tests. |
| 18 | `apps/figaf-manager/cloud/server.test.js` | Modified | +~80 | Test mode-switch behavior (set `VCAP_SERVICES` env to simulate XSUAA-bound). |

**Total v2 delta:** ~1,420 LOC added, ~75 LOC modified across 18 files. Round to **~1,500 LOC**; padding for BTP-CLI corner cases puts ship-time at ~1,800 LOC.

**New dependencies:** `@sap/xssec` (~2 MB transitive) in manager. `@sap/approuter` (~5 MB) in `packages/manager-approuter/node_modules/`.

**New CF resources at runtime:** 1 service instance (xsuaa application plan), 1 app (figaf-manager-approuter), 2 role collections in subaccount.

**Zip size delta:** ~6-8 MB.

## 2.10 Risks Specific to v2

| ID | Risk | Severity | Mitigation |
|----|------|----------|------------|
| V1 | Restage-self handoff fails mid-Phase-2 (between unmap and restage complete) | High | Phase 1 is fully reversible; Phase 2 rollback window is ~5s. Document recovery procedure in wizard error UI. |
| V2 | 3-5s window of route ambiguity during map → unmap (both apps serve the same route) | Low | v1 gate still in force on manager during this window. Acceptable. Alternative (unmap first, then map) creates strictly worse ~3-5s of 404s. |
| V3 | Bundled `@sap/approuter` pins version at wizard-build time; CVE patch requires wizard redeploy | Medium | Release notes line "redeploy wizard to receive approuter security updates." Trade-off vs runtime GitHub download dependency. |
| V4 | Subaccount admin grants self FigafManagerOperator weeks after deploy (creeping-privilege risk) | Medium | Wizard ships an idle-self-destruct independent of auth mode: after N hours of no activity, wizard `cf:uninstallManager`s itself. Bound the exposure window. |
| V5 | Operator cannot reach IAS during upgrade (network policy, IdP outage) | Medium | Wizard polls IAS reachability before starting Phase 2. Abort with friendly error if unreachable. |
| V6 | Role-collection cleanup fails (steps 6/7) on uninstall | Low | Fallback wizard screen instructs manual cockpit cleanup. Orphaned role collections are harmless. |

## 2.11 v2 Implementation Sequence

Single PR, but internally structured as logical commits for review:

1. **`packages/manager-approuter/` workspace package** — package.json, xs-app.json, xs-security.json, maintenance.html, server.js. Standalone, no wiring yet.
2. **build-zip.js updates** — stage the new package, run `npm install` in it.
3. **`@sap/xssec` integration in manager** — `cloud/xsuaa-auth.js` module + tests. Standalone, not wired.
4. **Mode-switch in `cloud/server.js`** — `isXsuaaActive()` gate, middleware function-pointer swap. Token-gate gated by negation.
5. **Orchestrator handlers** — the new ~10 handlers in `packages/core/orchestrator.js`. Standalone, not wired to UI.
6. **UI screens** — `ScreenXsuaaUpgrade`, `ScreenXsuaaAssignRole`, wizard branch wiring.
7. **End-to-end integration** — manual cockpit testing on EU10, US10, and one AP landscape.
8. **Idle-self-destruct** — V4 mitigation. Independent of upgrade.

## 2.12 v2 Verification Plan

### Manual cockpit run-through (after upgrade)

1. Deploy wizard via cockpit. Claim with token. Run wizard to deploy Figaf Tool.
2. Click "Enable persistent SSO login" button.
3. Watch Phase 1 progress (~30s) — XSUAA service create, approuter push.
4. Watch Phase 2 progress (~60s) — route swap, manager restage, approuter serves maintenance page.
5. Phase 3 — click "Sign in via SAP IAS". Verify IdP redirect, callback, wizard loads.
6. Open private window, navigate to approuter URL. Verify IAS redirect. Sign in as a user WITHOUT the role collection. Verify 403.
7. Cockpit → Security → Role Collections → assign that user to FigafManagerOperator. Re-login. Verify wizard loads.
8. Click "Uninstall wizard." Verify multi-step teardown: both apps deleted, xsuaa service deleted, role collections deleted (or fallback message).
9. Cockpit → confirm no figaf-manager artifacts remain.

### Cross-landscape verification

Repeat the run-through on at least: EU10, US10, AP10/AP11. `cf restage` timing and IAS cert chains vary by landscape.

### `node:test` cases

- `xsuaa-auth.test.js` — JWT validation with mock approuter-forwarded JWT, scope check positive/negative, WS upgrade with valid/invalid JWT.
- `server.test.js` extensions — boot with `VCAP_SERVICES` containing xsuaa binding; verify token-gate is dormant, JWT validation is active.

---

# Appendix

## A. File Paths Quick Reference

### v1 (Part I)

- `C:\Figaf-installer\apps\figaf-manager\cloud\auth.js` *(new)*
- `C:\Figaf-installer\apps\figaf-manager\cloud\setup.html` *(new)*
- `C:\Figaf-installer\apps\figaf-manager\cloud\server.js` *(modified)*
- `C:\Figaf-installer\apps\figaf-manager\cloud\client.js` *(modified)*
- `C:\Figaf-installer\apps\figaf-manager\cloud\index.html` *(modified)*
- `C:\Figaf-installer\packages\ui\screens.jsx` *(modified)*
- `C:\Figaf-installer\apps\figaf-manager\cloud\auth.test.js` *(new)*
- `C:\Figaf-installer\apps\figaf-manager\cloud\redact.test.js` *(new)*
- `C:\Figaf-installer\apps\figaf-manager\cloud\server.test.js` *(new)*
- `C:\Figaf-installer\apps\figaf-manager\cloud\ws-auth.test.js` *(new)*

### v2 (Part II)

- `C:\Figaf-installer\packages\manager-approuter\package.json` *(new)*
- `C:\Figaf-installer\packages\manager-approuter\xs-app.json` *(new)*
- `C:\Figaf-installer\packages\manager-approuter\xs-security.json` *(new)*
- `C:\Figaf-installer\packages\manager-approuter\maintenance.html` *(new)*
- `C:\Figaf-installer\packages\manager-approuter\server.js` *(new)*
- `C:\Figaf-installer\apps\figaf-manager\cloud\xsuaa-auth.js` *(new)*
- `C:\Figaf-installer\apps\figaf-manager\cloud\xsuaa-auth.test.js` *(new)*
- `C:\Figaf-installer\apps\figaf-manager\cloud\server.js` *(modified — XSUAA mode-switch)*
- `C:\Figaf-installer\apps\figaf-manager\cloud\auth.js` *(modified — gate behind isXsuaaActive)*
- `C:\Figaf-installer\apps\figaf-manager\cloud\client.js` *(modified)*
- `C:\Figaf-installer\apps\figaf-manager\cloud\index.html` *(modified)*
- `C:\Figaf-installer\apps\figaf-manager\scripts\build-zip.js` *(modified)*
- `C:\Figaf-installer\apps\figaf-manager\package.json` *(modified — @sap/xssec)*
- `C:\Figaf-installer\packages\core\orchestrator.js` *(modified)*
- `C:\Figaf-installer\packages\ui\screens.jsx` *(modified)*
- `C:\Figaf-installer\packages\ui\app.jsx` *(modified)*
- `C:\Figaf-installer\packages\ui\mode.js` *(modified)*

## B. Resolved Decisions Summary

| Decision | Resolution |
|---|---|
| Bootstrap auth mechanism | Option A (cockpit-log token) + Option D (single-use claim), layered |
| `/setup` UI location | Static HTML, no React |
| Cookie format | Signed flag, IP/UA server-side via HMAC |
| Auth state storage | In-memory, per-boot |
| WS auth | Upgrade handler, close code 4003 (v1) + 4004 (v2 JWT-invalid) |
| Client-side 401 handling | Redirect to `/setup` (v1) or `/` (v2 XSUAA mode) |
| Redaction philosophy | Layered upstream parsing + downstream regex |
| Test framework | `node:test` built-in |
| `FIGAF_AUTH_SECRET` default | Per-boot random (irrelevant post-v2 upgrade) |
| Use case (YAGNI gate) | Persistent management surface — v2 justified |
| v2 architecture | Two-app approuter |
| v2 approuter packaging | Bundled in cloud zip |
| Role-collection auto-assignment | No — auto-create RC, operator self-assigns via deep-link |
| v2 phasing | Single PR after v1 ships and is proven |

---

*End of plan.*

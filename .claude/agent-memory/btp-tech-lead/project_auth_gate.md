---
name: figaf-manager auth-gate accepted design
description: Option A (cockpit-log setup token) + Option D (single-use claim), layered, plus leak-path fixes that must ship together
type: project
---

Two-round security audit on `apps/figaf-manager` resulted in this accepted design (owner: afl@figaf.com):

**Auth model:** First `GET /` lazily generates a 24-byte random token, stores SHA-256 hash + 15-min expiry. Server emits ONE `[SETUP] One-time setup token: <token> ...` line to stdout, which lands in BTP cockpit's Application Logs tab — readable only by users with Space Developer / Space Auditor / Subaccount Admin role. Operator pastes into a separate static `/setup` page. Server constant-time compares (`crypto.timingSafeEqual`), captures `claimantIp` + `claimantUa`, sets `figaf_auth=1` signed cookie (HttpOnly, Secure, SameSite=Strict), wipes token hash. After claim, all subsequent `POST /setup` return 410 Gone. `requireAuth` gates `/rpc/*` and the WS upgrade — both check the cookie AND match request IP + User-Agent against the stored claimant.

**Driving constraint:** Operator deploys via BTP cockpit UI only — no local `cf` CLI, so `cf ssh` / `cf set-env` patterns aren't available. The cockpit's own log-read capability is the indirect auth anchor.

**Why:** Pre-design, the figaf-manager had no auth. After deploy, anyone hitting the route could control the wizard. The cockpit-logs-only flow gates the wizard with credentials only space-trusted users can read.

**How to apply:**
- This is being designed as ONE PR / ONE release. Do not split into smaller PRs without explicit owner sign-off — the auth gate is incomplete without all its co-dependent leak fixes.
- Co-required leak fixes that must ship in the same PR: SSO URL redaction at orchestrator `log()`, console.log scrubbing at server boot, per-session `CF_HOME`/`BLUEMIX_HOME` in spawn env.
- Deferred to follow-up: hardened XSUAA manifest, Dockerfile non-root user, full orchestrator state migration. Owner explicitly wants a tight, shippable PR.
- Setup token must NEVER appear in build artifacts (zip/Dockerfile) — it's runtime-generated from `crypto.randomBytes`.
- See `feedback_auth_gate_decisions.md` for the 8 architectural decisions made during planning.

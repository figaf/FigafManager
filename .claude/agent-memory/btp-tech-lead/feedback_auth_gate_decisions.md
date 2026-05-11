---
name: figaf-manager auth-gate architectural decisions
description: Resolutions to the 8 open design questions for the auth-gate PR — for use during implementation and review
type: feedback
---

The 8 architectural decisions agreed during planning for the figaf-manager auth-gate PR:

1. **`/setup` view location:** Separate static HTML page at `/setup`, NOT a React wizard step. Keeps the auth gate out of the wizard's state machine and means the JSX bundle only loads for authenticated callers.

2. **Cookie strategy:** Single signed cookie `figaf_auth=s:1.<hmac>` using the existing `signCookieValue`/`unsignCookieValue` helpers (server.js:58-82). IP and UA live server-side in `authState`, NOT encoded in the cookie. Avoids drift and reuses crypto already in the codebase.

3. **`authState` storage:** In-memory module-level, lost on container restart. Persisting to disk would re-introduce file-system attack surface. Restart = operator re-claims from cockpit logs (correct failure mode).

4. **WebSocket auth:** Handle in the existing `wss.on("connection")` handler with `ws.close(4003, "Auth required")`. Do NOT use `verifyClient`. Use a shared `clientIp(req)` helper that reads X-Forwarded-For (first hop) consistently between Express `requireAuth` and the WS handler.

5. **Restart failure mode:** On 401 from `/rpc/*`, client.js redirects to `/setup`. On WS close-code 4003, same redirect. Mid-deploy interruption (cf push killed by dyno restart) is acknowledged but not fixed in this PR — documented on `/setup` help text instead.

6. **Redaction philosophy: both upstream AND downstream.** Upstream detection in orchestrator.js `ingest` (line 541-546) catches the cli.btp.cloud.sap SSO URL and emits a structured `btp:browserAuth { url }` event instead of letting it flow into `cli:line`. Downstream regex scrubbing in `log()` (line 65-67) is the safety net for novel leak shapes. See `feedback_redaction_philosophy.md` for full reasoning.

7. **Test strategy:** node:test (built-in). NO new dev dependency. Test file at `apps/figaf-manager/test/auth.test.js`. Manual cockpit walkthrough remains the integration-test source of truth. See `feedback_no_new_test_framework.md`.

8. **build-zip.js impact:** Zero. The new `cloud/setup.html` rides along via the existing wholesale `copyDir(cloud/, ...)` at build-zip.js:154. Dockerfile:19 covers it for the container build.

**Why these decisions:** Each was argued through tradeoffs specific to this project: no-bundler renderer architecture, dual-app symmetry (figaf-local must not regress), single-PR shipping discipline, and the constraint that BTP cockpit's log-read capability is the indirect auth anchor.

**How to apply:** When implementing the auth-gate PR or reviewing it, use these as the reference for "why was X chosen." If a reviewer pushes back on any of these, the owner has already accepted the decision — don't re-litigate without explicit owner re-engagement.

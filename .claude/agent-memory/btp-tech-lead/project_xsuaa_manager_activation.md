---
name: XSUAA upgrade — manager-side activation mechanism + post-restage continue-gate
description: How figaf-manager actually flips into XSUAA mode (bind + restage), and the polling pattern that gates the "Continue to wizard" click
type: project
---

Manager activation under v2 is **VCAP_SERVICES-driven, never env-var-driven**. This is fixed by `xsuaa-auth.js#isXsuaaActive()` which reads `process.env.VCAP_SERVICES` and looks for an `xsuaa` binding entry. The only legitimate way to flip the manager into XSUAA mode is to `cf bind-service figaf-manager figaf-manager-xsuaa` + `cf restage figaf-manager`. Both steps live in the orchestrator's `cf:restage` handler when called with `{ bindXsuaa: true }`.

**Why:** Tying activation to the service binding (not an env var) keeps the mode-flip impossible to spoof from app code, keeps the JWT-validation key material reachable via VCAP at boot, and means there is exactly ONE seam (the restage) — no per-request mode-switch, no live toggling.

**How to apply (orchestrator-side):**
- `cf:restage` accepts `{ app, bindXsuaa, skipIfBound }`:
  - `bindXsuaa: true` → runs `cf bind-service` first; "already bound" stderr is treated as success.
  - `skipIfBound: true` → probes `cf curl /v3/service_credential_bindings?service_instance_names=figaf-manager-xsuaa&app_names=<app>` and short-circuits with `{ ok: true, alreadyBound: true }` if the binding already exists. This is the re-run idempotency path; first-time runs don't hit it.
- The `cf restage` itself is fire-and-forget via raw `spawn()` because the dyno will be SIGTERMed mid-call. A `log("cmd","cmd", "cf restage <app>")` is emitted before spawn so the operator sees the command in the terminal drawer (run() would do this automatically; spawn() does NOT).
- Pre-flight `xsuaa:upgradeStatus` returns `managerBound` via the same v3 curl probe.

**How to apply (UI-side, screen-xsuaa.jsx):**
- The "Continue to wizard" button MUST be gated by a `/_manager-health` poll. The approuter's `/_manager-health` route proxies to manager's `/health` and forwards the JSON body verbatim (modified May 2026 to include the manager's `mode` field). Continue is disabled until the probe returns `{ ok: true, mode: "xsuaa" }`.
  - **Why this gate exists:** without it, a too-eager click navigates to `/`, the still-running v1 manager dyno (mid-restage) sees no `figaf_auth` cookie, and `requireAuthV1` 302s to `/setup`. The operator lands on a legacy claim page they can't satisfy (claim hash already wiped, returns 410). This was the symptom that drove the May 2026 fix.
- `/_manager-health` is **unauthenticated by design** (xs-app.json has `authenticationType: none` on it) precisely so the wizard's tab can poll it during the restage window without a JWT.
- DO NOT use `api.xsuaa.upgradeStatus` (or any `/rpc/*`) for this poll — those go through the gated surface and 401 the moment XSUAA flips on.
- Set `window.figafSuppressAuthKick = true` BEFORE the restage await, not after. The orchestrator spawns `cf restage` synchronously inside the handler, so the dyno can begin shutting down while the HTTP response is still in flight. A flag set only after the await resolves can leak a /setup redirect through `cloud/client.js#handleAuthKick` during the gap.
- 5-minute budget on the poll; on timeout, enable Continue with "Continue anyway" copy so operators aren't stuck if the bind/restage truly failed silently.

**Idempotency contract for re-runs:**
- Phase 1 (create-xsuaa): `pre.hasXsuaaService` skip-flag.
- Phase 1.3-1.6 (push-approuter): `pre.hasApprouterApp` skip-flag.
- Phase 2 (map/unmap routes): commands themselves are idempotent — "already mapped" / "not mapped" stderr accepted.
- Phase 2.5 (bind + restage): `skipIfBound: true` in the RPC payload triggers the v3 probe; on found-binding, the entire bind+restage is skipped and the UI's success state shows `managerMode: "xsuaa"` immediately.

**Test seam:** `apps/figaf-manager/cloud/orchestrator-restage.test.js` patches `child_process.spawn` to a recording stub and exercises:
1. fresh bind + restage
2. already-bound bind → still ok
3. bind-fail → no restage
4. skipIfBound + curl-found → short-circuit
5. skipIfBound + curl-empty → fall through
6. observability: `cli:line cmd` for the restage spawn

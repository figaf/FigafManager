---
name: figaf-manager XSUAA upgrade — security evaluation outcome
description: Conditions under which the optional in-wizard XSUAA upgrade is a real security win vs. a parallel-doors lateral move; constraints on its implementation.
type: project
---

The owner proposed an optional in-wizard "Enable persistent SSO login" upgrade on top of the approved cockpit-log token + single-use claim plan (see `auth-gate-implementation-plan.md`). The upgrade creates `figaf-manager-xsuaa`, deploys a `figaf-manager-approuter` app, binds XSUAA to `figaf-manager`, and restages. Evaluated 2026-05-11.

**Why:** As proposed (token-mode-as-fallback after upgrade), the upgrade is a parallel-doors design — an attacker only needs to break the weaker gate. It is a security win only if three conditions are enforced: (1) one-shot token gen (`isXsuaaBound()` short-circuits `[SETUP]` boot line + the entire `/setup` mount), (2) approuter is the only public ingress (figaf-manager gets `no-route: true` + c2c networking), (3) a real persistent-management-surface use case exists to justify the new attack surface.

**How to apply:** Treat these as load-bearing constraints if the upgrade is implemented.

1. **Do not reuse `packages/deploy-templates/xs-security.json` for `figaf-manager-xsuaa`.** That file declares 18 IRT-app roles and has `redirect-uris: ["https://**.hana.ondemand.com/**"]` (broad wildcard). The wizard needs its own `apps/figaf-manager/xs-security.figaf-manager.json` with: single scope `$XSAPPNAME.Operator`, single role-template `FigafManagerOperator`, `tenant-mode: dedicated`, redirect-uris pinned to the approuter's exact route, default token-validity (do not extend).

2. **Do not auto-assign the FigafManagerOperator role-collection from the dyno.** Cross-identity confused-deputy risk — the dyno cannot reliably tell who the "deployer" is (btp CLI state is dyno-global, multiple sessions can claim the token). Manual cockpit assignment only; surface the operator's email (from `btp whoami` inside the dyno) for confirmation and provide a deep link.

3. **Do not reuse `packages/deploy-templates/approuter/xs-app.json`.** That config has `csrfProtection: false` on all routes and a broad `authenticationType: none` allow-list for IRT-app paths. Wizard approuter needs csrfProtection enabled (default), narrow static-asset allow-list only, CSP + HSTS + X-Frame-Options via httpHeaders, `logoutEndpoint: /logout`.

4. **Hard switch in middleware, not parallel coexistence.** When `isXsuaaBound()`, the token-mode middleware must not be mounted at all. Otherwise a pre-upgrade cookie can bypass the XSUAA gate. The `FIGAF_AUTH_SECRET` per-boot rotation handles this implicitly today because restage = new secret, but do not rely on it — make the middleware switch explicit.

5. **Cleanup-on-`cf:deleteApp` must extend to: unbind XSUAA, delete approuter app, delete manager app, delete XSUAA service instance.** In that order. Skipping the service-instance deletion leaves an orphaned XSUAA whose role-collection assignments persist at subaccount level — cross-deployment confused-deputy risk if anyone redeploys and binds the same instance. The role-collection itself stays (global-account admin scope to delete); surface as manual cleanup step.

6. **Restage-self handoff is fail-closed by construction** (the `@sap/xssec` middleware returns 401 to non-JWT requests as soon as bind+restage completes). Direct-route removal is hygiene, not the security gate. But still always remove the direct route as the final upgrade step.

7. **Phase-2 marker for restage-self** (the upgrade handler dies when it restarts itself): write the marker to `$HOME/sessions/<sessionId>/upgrade-phase` signed with `SESSION_SECRET`. Never to `/tmp` or any world-writable path. The marker is a privileged signal that triggers continuation of the upgrade on next boot.

8. **Time-bomb the wizard regardless of auth mode** — self-delete after N hours of inactivity (24h default). Independent hardening but load-bearing for the persistent-management-surface threat model. Without it, "wizard left running for weeks" becomes "subaccount admin grants themselves FigafManagerOperator and drives the wizard's RCE-equivalent handlers."

**YAGNI test:** if the product remains an install-tool (deploy → wizard → `cf:deleteApp`), the upgrade is over-engineered. Defer until a named customer asks for management-tool mode. Until then, focus on auth-agnostic fixes: F-02 SSO URL redaction, F-06 CSRF on `/rpc/*`, F-09 cross-session stdout isolation, CLI state isolation (CF_HOME / BLUEMIX_HOME per session), input validation on hotspot handlers. These deliver most of the security value without the new attack surface.

**Reconciliation with saved plan:** preserves Q1-Q7 architectural decisions and commits 1-7. Adds commits 8 (XSUAA upgrade handler), 9 (extended cleanup), 10 (time-bomb). Invalidates Q8's "no build-zip changes" claim (needs @sap/xssec, possibly @sap/approuter bundled or fetched at runtime). R5 partially mitigated, R6 decommissioned post-upgrade.

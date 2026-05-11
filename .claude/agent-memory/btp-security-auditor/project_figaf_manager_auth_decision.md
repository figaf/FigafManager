---
name: figaf-manager auth design decision (cockpit-only constraint)
description: Auth mechanism evaluation outcome for figaf-manager — cockpit-log token + single-use self-destruct chosen as primary; XSUAA manifest as fallback.
type: project
---

The figaf-manager deployment flow is cockpit-only: operator uploads zip via BTP cockpit "Deploy Application", clicks the route, drives the wizard. There is no cf CLI on the operator's machine and no terminal. This rules out any auth mechanism requiring cf set-env, service-key copy-paste, or cf ssh tunneling at deploy time.

**Why:** Operator persona is non-CLI ops staff; the whole purpose of figaf-manager existing is to spare them the cf/btp CLI walkthrough in instructions.md. Any auth scheme must be drivable from the cockpit UI alone.

**How to apply:** When recommending auth fixes for figaf-manager, prefer mechanisms that piggyback on cockpit-native capabilities (logs pane, env-var display, role collections). Reject suggestions that require local CLI access. The agreed primary design is Option A (cockpit-log setup token + lazy generation on first GET / + 15min TTL + IP/UA binding on claim) layered with Option D (single-use, 410-Gone after first claim) for defense in depth. Option B (manifest-declared XSUAA + approuter) is the fallback "hardened mode" for customers who want it, NOT the default — its 6-8 cockpit-click role-assignment friction violates the no-supplementary-setup constraint, and it depends on MTA Deploy Service entitlement which is not universal across BTP subaccounts.

Regardless of which auth mechanism is chosen, these must still be fixed independently: F-02 SSO URL redaction in cli:line, F-06 CSRF check on /rpc/*, F-09 cross-session stdout audit, F-11 secret scrubbing in log fan-out. Auth only blocks the door; the orchestrator's data-leak surfaces are auth-agnostic.

Notable threat-model nuance: Space Auditor role can read cockpit logs (so can claim the setup token) but cannot deploy. Documented as accepted residual risk — an auditor in the space already has cf env access to every other secret in scope. Log drains bound at the space level are the underestimated leak path; document explicitly.

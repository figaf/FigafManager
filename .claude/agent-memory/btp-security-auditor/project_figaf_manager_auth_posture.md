---
name: figaf-manager auth posture
description: figaf-manager cloud app has no XSUAA/approuter; routes are unauthenticated, server self-mints session cookies, RPC layer is a public RCE surface
type: project
---

As audited 2026-05-11, `apps/figaf-manager` is deployed via `manifest.yml` with `random-route: true` and **no** approuter or XSUAA binding. The Express server at `apps/figaf-manager/cloud/server.js` mounts every route (`/`, `/rpc/:channel`, `/stream`, `/installer/*`, `/cloud/client.js`) as fully public. `sessionMiddleware` (server.js:104) mints a fresh HMAC-signed cookie for any caller that doesn't present one, so "having a session" provides zero identity assurance.

**Why:** The wizard was originally designed as a single-operator install tool deployed briefly and deleted (`cf:deleteApp` self-destruct is the intended final step). The threat model assumed the random route was unguessable enough that no one else would find it. That assumption does not hold against scanners of `*.cfapps.<region>.hana.ondemand.com` and provides no defense against an attacker who has any reason to look.

**How to apply:** Treat any new RPC channel registered in `packages/core/orchestrator.js` as exposed to unauthenticated internet attackers when running in cloud mode, until/unless an approuter+XSUAA gate is added in front of `figaf-manager`. The wizard already deploys this exact pattern for `figaf-app` (`packages/deploy-templates/{xs-security.json,approuter/xs-app.json}`) — recommend eating its own dog food.

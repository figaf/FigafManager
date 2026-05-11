---
name: Orchestrator handler hotspots
description: Which RPC handlers in packages/core/orchestrator.js are highest-impact if reached unauthenticated, with the dangerous arg in each
type: project
---

As audited 2026-05-11, the highest-impact handlers in `packages/core/orchestrator.js` when reachable by an unauthenticated attacker (current cloud deployment posture):

- `cf:push` (`:819-823`) — deploys whatever is in deployDir to the bound CF org/space. Most damaging when paired with `config:writeVars` tampering.
- `config:writeVars` (`:869-894`) — values are unvalidated and `text.replace(re, "$1 ${value}")` allows newline injection into vars.yml. An attacker can prime the deployment to use an attacker-controlled docker image/tag before the operator pushes.
- `cf:deleteApp` (`:826-830`) — `name` is caller-controlled; defaults to `figaf-manager` but accepts any app the bound user can delete.
- `btp:assignRole` (`:692-697`) — `role` and `user` are caller-controlled; defaults to `PI_Administrator`. Persists privilege grants in the BTP global account.
- `cf:loginStart` (`:701-730`) — `apiUrl` is caller-controlled and flows into `cf login -a`; can be pointed at attacker-controlled CF API.
- `cf:createService` (`:789-796`) — `configFile` is caller-controlled and flows into `cf create-service -c <path>`; allows reading arbitrary files via error-message echo.
- `btp:loginStart` (`:485-583`) — triggers SSO URL leak via the streamed CLI output (see SSO URL leak memory).

**Why:** When P0.1 (XSUAA + approuter) is in place, these handlers' threat model shifts from "any internet attacker" to "rogue authorized operator", which is acceptable. Until then, treat them all as RCE-equivalent.

**How to apply:** Before merging changes that touch any of these handlers, verify (a) the input is validated server-side (don't trust the client.js / preload.js client at all), (b) no new caller-controlled value flows into a `spawn` argument or filesystem path without a regex/allow-list, and (c) any new lines emitted via `log()` are checked against the redaction allow-list.

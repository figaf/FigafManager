---
name: SSO URL leak threat model
description: The btp login --sso continue-login URL printed by btp CLI is a per-session bearer credential and must never reach unauthenticated browsers
type: project
---

The line `Please continue login at: https://cli.btp.cloud.sap/login/v2.106.1/browser/<GUID>` is printed by `btp login --sso` to its stdout and currently flows through `packages/core/orchestrator.js:65-67` `log()` → `send("cli:line", ...)` → `apps/figaf-manager/cloud/server.js:23-28` fan-out to every WebSocket on the session. The GUID is the binding identifier between SAP's CLI server and the spawned `btp` process inside the container; whoever opens that URL and completes the SSO flow causes the bound CLI process to receive a token.

**Why:** This is the actual credential leak the user spotted while watching the streamed CLI output. The certificate fingerprint on the previous line is intrinsically public (TLS leaf cert), so it is not the leak — it's the marker that confirmed raw CLI output reaches an unauthenticated browser. The URL on the next line is the real bearer pre-auth code.

**How to apply:** Any change to `btp:loginStart` (`orchestrator.js:485-583`), `cf:loginStart` (`orchestrator.js:701-730`), the `log()` helper (`orchestrator.js:65-67`), or the server-side `send()` (`server.js:23-28`) must preserve a server-side allow-list that drops/redacts lines matching `cli.btp.cloud.sap/login/.+/browser/`, `.+/passcode`, `One Time Code`, `passcode[:= ]`, etc. Deny-by-default is the only safe posture — future btp/cf CLI versions can introduce new sensitive output formats.

The clean architectural fix is to never stream the SSO URL: have the orchestrator emit a structured `openExternal` event with the URL only to the *originating* session's WebSocket (or, post-XSUAA, only to the authenticated operator's tab), and have the browser client open it via `window.open` without ever putting it into the terminal drawer.

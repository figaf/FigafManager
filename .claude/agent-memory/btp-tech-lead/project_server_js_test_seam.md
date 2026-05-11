---
name: figaf-manager server.js test seam
description: cloud/server.js exports the Express app/server/wss and gates boot side-effects on require.main === module so node:test can require it without starting a listener
type: project
---

`apps/figaf-manager/cloud/server.js` was refactored (during v1 auth-gate landing) to support `node:test` integration tests without spawning the real listener at require-time.

Two shapes:

1. **Side-effect gate.** All boot-time work — `bootMintToken()` (which calls `auth.generateSetupToken()` + prints the `[SETUP]` line) and `server.listen()` and the `SIGTERM` shutdown handler — lives inside an `if (require.main === module)` block. Production `node cloud/server.js` runs them; `require("./server")` from a test file does not.

2. **Module exports.** `module.exports = { app, server, wss, sessions, bootMintToken }`. Tests use `server` to call `.listen(0, "127.0.0.1", ...)` on a random port, hit it with `fetch` / `ws`, then `server.close()` in `after()`.

**Why:** The plan picked `node:test` over Jest/Vitest (no new dep). `node:test` has no built-in HTTP test client — tests boot the real server and use `fetch`/`ws`. The refactor was the cleanest way to share the Express+WS wiring between production and tests without duplicating it.

**How to apply:**
- When v2 (XSUAA upgrade) lands, the same pattern carries forward — any new boot-time side-effects must live inside `if (require.main === module)`, not at module scope, or tests will start failing with "address already in use" / "boot line printed".
- Anything a test needs to reach (`requireAuth`, new middleware, the orchestrator session map) should be added to `module.exports`.
- Do NOT refactor this into an `app.js` factory + `server.js` driver split for the sake of "cleanliness" — the current shape is intentional and minimal.

---
name: Auth-kick suppression mechanism
description: window.figafSuppressAuthKick flag — what it gates, who sets it, who reads it, why it exists
type: project
---

The cloud renderer's auth-kick (apps/figaf-manager/cloud/client.js → handleAuthKick) has a single
suppression escape hatch: a `window.figafSuppressAuthKick` boolean.

**Why:** During the XSUAA upgrade's restage phase the manager dyno dies; the WebSocket drops; the
reconnect attempt 2s later is auth-bounced by the now-XSUAA-gated server (4003/4004) or by
approuter sitting on the public route. Without suppression the client immediately redirects away
from the success state, stealing the explicit "Continue to wizard" reboot that the operator was
supposed to control. The whole point of the manual-reboot button is operator-controlled
re-authentication; the auto-kick defeats it.

**How to apply:**

- Setter: `packages/ui/screens/screen-xsuaa.jsx`
  - In `ScreenXsuaaUpgrade.runUpgrade()`, set `window.figafSuppressAuthKick = true` **BEFORE the
    `await api.cf.restage(...)` call**, not after. The orchestrator spawns `cf restage`
    synchronously inside its handler — the dyno can begin shutting down while the HTTP response
    is still in flight. A flag set only after the await resolves can leak a /setup redirect
    through `client.js#handleAuthKick` during the gap. (Updated May 2026 in response to a real
    /setup-redirect incident.)
  - In `ScreenXsuaaAssignRole`, set the same flag on mount as belt-and-suspenders for the
    failed-auto-assign branch (restage may still be in flight when the operator routes there).
- Reader: `apps/figaf-manager/cloud/client.js` → top of `handleAuthKick(reason, opts)`. Guard sits
  BEFORE the `kicked` latch so the suppression is reentrant — repeated suppressed kicks during the
  restage window are silently dropped (no subscriber-bus broadcasts, no console spam, no state
  flip).
- Lifecycle: the flag self-clears on the next page reload (the IIFE re-evaluates with a fresh
  closure). "Continue to wizard" buttons all do `window.location.href = "/"`, which is enough.
  Don't add explicit cleanup — it isn't needed and complicates reasoning about which screens
  honor the flag.

**Naming convention:** matches the existing `window.figafXsuaaMode` and `window.figafModeFlags`
pattern — UI-layer flags injected/set on `window`. Stays in the renderer; never crosses into
the orchestrator or HostAdapter.

**Scope boundaries — must not regress:**
- Token expiry on a regular (non-upgrade) wizard session must still auth-kick — that's why the
  flag is OFF by default and only set by the XSUAA screens.
- WS code 4001 (legacy/no-session) is unaffected — it never called `handleAuthKick`.
- RPC 401/403 outside an XSUAA upgrade must still kick — same reason.

Originally introduced in response to the user's report that the "Continue to wizard" button was
unreachable because the renderer auto-redirected during restage. The /setup 302 redirect (server-
side safety net for the same kick path) and this client-side suppression are layered: server
catches missed kicks; client suppresses expected ones.

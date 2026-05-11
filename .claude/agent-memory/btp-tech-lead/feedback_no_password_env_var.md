---
name: figaf-manager auth-gate uses NO operator-supplied password env var
description: The auth gate is runtime-token-only; FIGAF_INSTALLER_PASSWORD or any operator-secret env var would violate Option A
type: feedback
---

The figaf-manager auth-gate design is Option A (runtime-generated token surfaced through cockpit Application Logs) layered with Option D (single-use claim). The setup credential is NEVER an operator-supplied env var.

**Why:** Option A's defining property is zero pre-deploy operator setup — the operator uploads the zip via BTP cockpit UI and never edits manifest.yml. Putting an installer password in manifest.yml or requiring `cf set-env FIGAF_INSTALLER_PASSWORD=...` is Option C, which was explicitly rejected by the security audit. The owner caught this drift in a prior plan revision and re-anchored on the audit's actual Option A.

**How to apply:**
- The only auth-related env var is `FIGAF_AUTH_SECRET` (HMAC key for the signed `figaf_auth=1` cookie). Even that should default to `crypto.randomBytes(32).toString("hex")` at boot if unset, so the operator has zero required env config.
- The setup credential is a 24-byte `crypto.randomBytes(24).toString("base64url")` token minted at runtime, SHA-256 hashed in `authState`, surfaced via one stdout line beginning `[SETUP]`, and wiped on first successful claim.
- Generation is **eager at boot**, not lazy on first GET — lazy lets an attacker scanning the route trigger token mint before the operator does. Eager makes the token mint timestamp deterministic from the operator's perspective (it equals app boot).
- Token NEVER appears in build artifacts (zip / Dockerfile / extraResources). It is purely runtime crypto.
- If a future reviewer or LLM proposes `FIGAF_INSTALLER_PASSWORD`, `INSTALLER_TOKEN`, or any operator-supplied env-var secret: reject it and point to this memory + the audit's Option A vs C distinction.

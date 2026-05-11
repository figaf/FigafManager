---
name: Redaction strategy — both upstream and downstream
description: For credential/URL leak prevention, do BOTH upstream structured-event emission AND downstream regex scrubbing — not either alone
type: feedback
---

For credential and SSO URL leaks in the orchestrator's log stream, the correct strategy is BOTH upstream detection AND downstream regex scrubbing.

**Why:**
- **Upstream-only is brittle to CLI version drift.** The BTP/CF CLIs are owned by SAP/CF Foundation. A minor-version output-format change (URL prefix, prompt wording) silently bypasses upstream detection and we leak.
- **Downstream-only is brittle to coverage gaps.** A new login flow with a novel URL shape bypasses a deny-list regex.
- **Together they're complementary, not redundant.** Upstream catches known leaks at the source so the regex never has to fire for them (and so the structured event can drive better UX — e.g. `btp:browserAuth { url }` flows directly to the Login screen instead of being parsed out of the terminal). Downstream is the tripwire for what the upstream missed.

**How to apply:**
- For known leak shapes (BTP SSO URL, CF passcode URL): detect upstream in the orchestrator (`ingest` function around line 541-546 in orchestrator.js), emit a structured event, strip from the line buffer before fan-out.
- For everything else (Bearer tokens, Authorization headers, Set-Cookie, --passcode args, the figaf-manager setup token shape): scrub in `log()` (line 65-67) with a deny-list regex that replaces matches with `<redacted>`.
- Apply the same scrub function to `console.log`/`error`/`warn` at server.js boot via monkey-patch. The server's own console output bypasses `cli:line` entirely and lands directly in dyno stdout, which is the cockpit Logs tab — this is the underestimated leak path.
- The security auditor preferred upstream-only; the tech-lead decision (accepted by owner) is to do both. If a reviewer pushes back, the rationale above is the answer.

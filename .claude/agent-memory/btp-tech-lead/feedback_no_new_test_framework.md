---
name: Use node:test, don't add a test framework
description: This repo has no test framework and we're not adopting one — use built-in node:test for any new tests
type: feedback
---

When tests are required, use `node:test` (built-in since Node 18, stable; we're on Node 20).

**Why:**
- The repo has consciously avoided a test framework. Adding Jest/Vitest/Mocha introduces a dev-dependency cost the project has refused to pay.
- `node:test` is zero-dependency, ships with Node, and is sufficient for HTTP/WS contract testing — which is the level we're operating at, not unit-level coverage.
- The integration-test source of truth for BTP/CF flows is a manual cockpit walkthrough. Automated tests are the regression net for the auth gate and server contracts, not a replacement for the manual walkthrough.

**How to apply:**
- Test files: `apps/<app>/test/<feature>.test.js`. Run via `node --test test/`.
- Add `"test": "node --test test/"` to the relevant workspace's `package.json` scripts. No new devDependencies.
- For HTTP/WS tests: spawn the server as a child process per test, parse stdout for any expected emissions (e.g. setup token line), use built-in `http`/`ws` modules to exercise endpoints.
- If a reviewer suggests adopting Jest/Vitest/Mocha "for ergonomics", push back — the cost is real and the ergonomics gain is marginal for this scale.
- Exception: if test scope grows significantly beyond contract tests (e.g. component tests for the React renderer), revisit the framework question with the owner.

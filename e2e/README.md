# E2E specs (Playwright) — hosted manager against real Cloud Foundry

No mocks. The specs boot the REAL cloud server locally (`e2e/global-setup.js`,
port 8087) with the REAL orchestrator, which runs the REAL `cf` CLI from PATH
against whatever space that CLI is logged into. UI changes are served straight
from `packages/ui` source, so the loop is: edit -> re-run specs. No build, no
`cf push`.

Run:

    npm run test:e2e            # all specs
    npx playwright test e2e/wizard-baseline.spec.js   # one file

Prerequisites on the dev machine:

- `cf` CLI on PATH, logged in (`cf login --sso`) and targeted at the dev
  space (today: org `Figaf ApS_figafpartner-1`, space `figaf-l3-l4`).
- Node deps installed at the repo root (`npm install`).

## How auth works here (all real, nothing bypassed)

1. **Setup-token gate**: global-setup reads the single-use `[SETUP]` token
   from the server's stdout and claims it through the real `/setup/claim`
   endpoint, from a real browser context (the cookie is bound to IP + UA).
   The resulting storage state is shared by all specs.
2. **cf login seeding (dev machine only)**: the server scopes each wizard
   session's CLI state to `<home>/sessions/<sid>/cli` (multi-user isolation
   in the hosted dyno). Locally there is exactly one user — the developer —
   so global-setup copies the developer's own `~/.cf/config.json` into that
   scoped directory. `session:state` then resumes the session as signed-in,
   exactly as it would after a passcode login. This is a harness convenience
   on the developer's own machine with the developer's own login; product
   code and its session isolation stay untouched.

## Rules

- **Read-only by default.** Specs in this folder must not change CF state
  (no install/remove/update/start/stop). State-changing specs get their own
  clearly named file and are run deliberately, never in the default suite.
- One worker, no parallelism: all specs share one server-side session.
- Assertions use generous timeouts: real `cf` calls take seconds.

---
name: CF/BTP CLI state is dyno-global, not session-scoped
description: host.cloud.js only namespaces userDataDir; CF_HOME/BLUEMIX_HOME are not set on spawn, so cf/btp config files are shared across all wizard sessions in the same dyno
type: project
---

`apps/figaf-manager/host.cloud.js:19` scopes `getUserDataDir` to `$HOME/sessions/<sessionId>`, but this is only used for the unpacked deploy template (`orchestrator.js:244-272`). The actual `~/.cf/config.json` and `~/.bluemix/config.json` files live in `$HOME` (i.e., `/home/vcap/app` or similar in CF) and are **shared across every wizard session in the same dyno**. Neither `run()` (`orchestrator.js:74-114`) nor the long-lived login spawns (`btp:loginStart`, `cf:loginStart`) set `CF_HOME` or `BLUEMIX_HOME` in the child process env.

**Why:** Originally this didn't matter because Electron is single-user. The cloud variant inherited the same orchestrator without rescoping CLI state. Result: after any single user completes `cf login` in any session, every other session — including an attacker's — inherits authenticated CLI state and can drive `cf push` / `cf delete` / `btp assign` as that user.

**How to apply:** When auditing or modifying any spawn in `orchestrator.js`, check whether the child needs CLI state isolation. The fix is to set `env.CF_HOME = path.join(host.getUserDataDir(), "cf")` and `env.BLUEMIX_HOME = path.join(host.getUserDataDir(), "btp")` for every spawn, ideally centralized in the `run()` helper and in the bespoke `spawn()` calls for the long-lived login processes. This is independent of the XSUAA gating fix — both are needed.

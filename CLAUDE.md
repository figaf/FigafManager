# CLAUDE.md

Architecture backbone for **Figaf Installer** — a Windows Electron desktop wizard that
deploys the [Figaf Tool](https://figaf.com) to **SAP BTP Cloud Foundry**, and (planned)
will also wire it up to **SAP Integration Suite**.

This file is a graph-shaped reference: top-level nodes, edges between them, and the
contract each node exposes. Skim the graph first, drill into the file table second.

---

## Top-level graph

```
                ┌──────────────────────────────────────────────────────┐
                │                  ELECTRON APP (this repo)            │
                │                                                      │
                │   ┌────────────────┐   IPC   ┌───────────────────┐   │
   user input ──┼─▶ │   Renderer     │ ──────▶ │   Main process    │   │
                │   │  (React UI)    │ ◀────── │  (Node, child_proc) │   │
                │   └────────────────┘ events  └─────────┬─────────┘   │
                │                                        │             │
                └────────────────────────────────────────┼─────────────┘
                                                         │ spawns
                       ┌─────────────────────────────────┼──────────────────────┐
                       │                                 │                      │
                       ▼                                 ▼                      ▼
                ┌────────────┐                    ┌────────────┐         ┌──────────────┐
                │  btp CLI   │                    │   cf CLI   │         │   web APIs   │
                │  (SAP)     │                    │ (CF Found.)│         │ (DockerHub,  │
                └─────┬──────┘                    └─────┬──────┘         │  GH releases)│
                      │ SSO                             │ SSO+passcode   └──────────────┘
                      ▼                                 ▼
              ┌───────────────────────────────────────────────────┐
              │             SAP BTP Cloud Foundry                 │
              │                                                   │
              │   approuter (Node) ──▶ figaf-app (Docker)         │
              │        │                    │                     │
              │        ▼                    ▼                     │
              │   figaf-xsuaa          figaf-db (PG 16)           │
              └───────────────────────────────────────────────────┘
```

The renderer never spawns processes; the main process never touches the DOM.
Everything between them is an IPC channel defined in
[main-process/preload.js](main-process/preload.js).

---

## Node A — Renderer (React, no bundler)

Loaded by [installer/index.html](installer/index.html), which pulls React 18 + Babel
standalone from CDN, then runs three JSX files via in-browser Babel:

```
installer/
├── index.html       — shell, mounts <App/>
├── components.jsx   — Ico (SVGs), WinFrame, StepperRail, WizardFooter, TerminalDrawer, CheckRow
├── screens.jsx      — one component per wizard step (see "wizard graph")
├── app.jsx          — <App/>: state machine, step routing, log buffer, IPC subscription
├── styles.css       — design tokens + components
└── electron-app.css — frameless-window chrome (drag region, traffic lights)
```

State lives in a single `ctx` object inside `<App/>`. Each screen receives
`{ ctx, setCtx, onNext, onBack, appendLog }` and patches `ctx` immutably.

**Wizard graph** (steps are derived from `ctx.choice`):

```
Welcome ─▶ Login ─▶ Choice ─┬─▶ Config ─▶ Progress ─▶ Deploy ─▶ Done    (deploy path)
                            │
                            └─▶ Done                                    (connect path — TBD)
```

| Step       | Screen          | Drives                                                                   |
|------------|-----------------|--------------------------------------------------------------------------|
| `welcome`  | ScreenWelcome   | Parallel prereq probes: btp, cf, Docker Hub reachability, free disk      |
| `login`    | ScreenLogin     | `btp login --sso` → discover landscape → `cf login --sso` + passcode     |
| `choice`   | ScreenChoice    | Branch: deploy (default) or connect-to-IS (placeholder)                  |
| `config`   | ScreenConfig    | Auto-fills domain (`cf domains`), DB plan (`cf marketplace`), latest tag |
| `progress` | ScreenProgress  | Parallel: create figaf-db, create figaf-xsuaa, assign role               |
| `deploy`   | ScreenDeploy    | `cf push --vars-file vars.yml`                                           |
| `done`     | ScreenDone      | Success splash + opens `https://<id>.<domain>`                           |

`TerminalDrawer` subscribes to the `cli:line` IPC event so every spawned command
streams into a collapsible drawer at the bottom of the window.

---

## Node B — Main process (Electron, Node.js)

```
main-process/
├── main.js     — BrowserWindow boot, frameless chrome, registers bridge
├── preload.js  — contextBridge → window.figaf  (the renderer's only API surface)
└── bridge.js   — all IPC handlers + child_process orchestration
```

### IPC surface (window.figaf.*)

Defined in [main-process/preload.js](main-process/preload.js); implemented in
[main-process/bridge.js](main-process/bridge.js).

```
window.figaf
├── window.{minimize, toggleMax, close}              ─▶ titlebar buttons
├── prereq.*                                         ─▶ CLI detection & install
│   ├── whichBtp / whichCf                              probe stored path → fallback to `where`
│   ├── installBtp                                      download tar.gz from tools.hana.ondemand.com
│   ├── installCf                                       latest GitHub release of cloudfoundry/cli
│   ├── locateCli(cli)                                  user picks .exe/.zip via dialog
│   ├── getCliPaths / clearCliPath                      manage userData/cliPaths.json
│   ├── dockerHub                                       latest figaf/app:btp tag
│   └── disk                                            free GB on system drive
├── btp.*                                            ─▶ SAP BTP CLI
│   ├── login                                           btp login --sso
│   ├── listEnvInstances                                discovers landscape + subaccount
│   ├── listUsers                                       btp list security/user
│   └── assignRole(user, role)                          btp assign security/role-collection
├── cf.*                                             ─▶ Cloud Foundry CLI
│   ├── loginStart(apiUrl)                              spawns `cf login --sso`, holds stdin open
│   ├── submitPasscode(code)                            writes passcode to live cf stdin
│   ├── targetOrgSpace                                  parses `cf target`
│   ├── domains                                         filters cfapps.* from `cf domains`
│   ├── marketplacePostgresql                           `cf marketplace -e postgresql-db`
│   ├── createService({offering,plan,name,configFile})  cf create-service (idempotent on "already exists")
│   ├── service(name) / pollService(name)               status:* line; pollService loops 10s up to 15min
│   └── push                                            cf push --vars-file vars.yml in deployDir
├── config.*                                         ─▶ files & metadata
│   ├── readVars / writeVars(vars)                      mutate vars.yml in deployDir
│   ├── deployDir                                       resolves writable copy (see "deploy dir resolution")
│   └── dockerHubLatestBtpTag                           same source as prereq.dockerHub
├── shell.{openPasscodeUrl, openExternal}            ─▶ Electron shell.openExternal
└── on(channel, handler)                             ─▶ unsubscribe-returning listener
```

### Streamed IPC events (main → renderer)

| Channel             | Payload                                       | Emitted by                |
|---------------------|-----------------------------------------------|---------------------------|
| `cli:line`          | `{source, type: cmd\|line\|err\|ok\|warn, text}` | every spawned process     |
| `cli:install`       | `{cli, phase: start\|download\|extract\|done\|error, percent?, error?}` | installBtp/installCf/locateCli |
| `cf:loggedIn`       | `{}`                                          | `cf login` exits 0        |
| `cf:loginFailed`    | `{code}`                                      | `cf login` exits non-zero |
| `cf:serviceStatus`  | `{name, status}`                              | each `pollService` tick   |

### Subprocess invariants

- `spawn(cmd, args, { shell: false })` — **shell aliases (`doskey`) and `$PATH`
  globbing are deliberately bypassed.** That's why we persist absolute paths in
  `userData/cliPaths.json` (`btp`, `cf`). `resolveBtp() / resolveCf()` return the
  stored path or fall back to the bare command name.
- All stdout/stderr is fan-routed: captured in the resolved promise *and* streamed
  line-by-line as `cli:line` events.
- The **CF login child process is long-lived**: `cf:loginStart` spawns it, keeps
  stdin open, then `cf:submitPasscode` writes the user-pasted passcode. Closing the
  window calls `bridge.dispose()` which kills it.

### Deploy dir resolution

[bridge.js#resolveDeployDir](main-process/bridge.js) — the bundled
`Figaf-BTP-Deployment-btp-users/` is **read-only when packaged** (lives under
`process.resourcesPath`), so on first use the installer copies it to
`app.getPath('userData')/deploy/`. All `vars.yml` writes and `cf push` invocations
target that writable copy.

---

## Node C — Bundled deployment templates

```
Figaf-BTP-Deployment-btp-users/        (origin: github.com/figaf/Figaf-BTP-Deployment, btp-users branch)
├── manifest.yml          two CF apps: ((ID))-app (Docker) + ((ID))-router (Node approuter)
├── vars.yml              placeholders rewritten by config.writeVars
├── db.json               PG 16, locale en_US, extensions: ltree, citext, pgcrypto, hstore, btree_gist/gin, pg_trgm, uuid-ossp
├── xs-security.json      18 IRT* role scopes + role templates → role collection PI_Administrator
├── approuter/            @sap/approuter package + xs-app.json (route → token-destination, xsuaa auth)
├── notes.txt             reference CLI commands
└── README.md             upstream readme
```

The renderer never reads these directly; the main process is the only consumer.
**Routing on BTP**: `https://<ID>.<domain>` → approuter (XSUAA-protected) → forwards
to internal route `https://<ID>-internal.<domain>` → figaf-app on port 8080.

---

## Node D — External dependencies

| External                          | Used for                                              | Reached via                    |
|-----------------------------------|-------------------------------------------------------|--------------------------------|
| `tools.hana.ondemand.com`         | btp CLI tar.gz download                               | `httpsDownload` (sets EULA cookie) |
| `api.github.com/repos/cloudfoundry/cli/releases/latest` | cf CLI windows zip                | `httpsJson`                    |
| `hub.docker.com/v2/repositories/figaf/app/tags`        | latest `figaf/app:*-btp` tag       | `httpsJson`                    |
| `cli.btp.cloud.sap`               | btp login endpoint                                    | `btp login --url`              |
| `api.cf.<landscape>.hana.ondemand.com` | cf API endpoint (landscape-derived)              | `cf login -a`                  |
| `login.cf.<landscape>.hana.ondemand.com/passcode` | one-time passcode page                | `shell.openExternal`           |

---

## Node E — Packaging

- [package.json](package.json) — `electron`, `electron-builder`. No bundler; React is a CDN script.
- `npm start` → `electron .` (loads `main-process/main.js`).
- `npm run build:win` → NSIS installer at `dist/Figaf-Installer-<version>-x64.exe`.
- `extraResources` ships `Figaf-BTP-Deployment-btp-users/` and `instructions.md`
  alongside the asar — that's why `resolveDeployDir()` looks under
  `process.resourcesPath` in production.

---

## File map (single source of truth)

| Path | Role |
|------|------|
| [main-process/main.js](main-process/main.js) | Electron entry, BrowserWindow, frameless chrome |
| [main-process/preload.js](main-process/preload.js) | `window.figaf` IPC surface |
| [main-process/bridge.js](main-process/bridge.js) | All IPC handlers, subprocess orchestration, downloads |
| [installer/index.html](installer/index.html) | Renderer shell |
| [installer/app.jsx](installer/app.jsx) | `<App/>`, wizard state machine |
| [installer/screens.jsx](installer/screens.jsx) | Per-step screens + their IPC choreography |
| [installer/components.jsx](installer/components.jsx) | Shared primitives (icons, frame, stepper, terminal) |
| [installer/styles.css](installer/styles.css) | Design tokens & component styles |
| [installer/electron-app.css](installer/electron-app.css) | Frameless window chrome |
| [Figaf-BTP-Deployment-btp-users/manifest.yml](Figaf-BTP-Deployment-btp-users/manifest.yml) | CF manifest (apps + service bindings) |
| [Figaf-BTP-Deployment-btp-users/vars.yml](Figaf-BTP-Deployment-btp-users/vars.yml) | Variable template (rewritten at runtime) |
| [Figaf-BTP-Deployment-btp-users/xs-security.json](Figaf-BTP-Deployment-btp-users/xs-security.json) | XSUAA roles |
| [Figaf-BTP-Deployment-btp-users/db.json](Figaf-BTP-Deployment-btp-users/db.json) | PG service parameters |
| [Figaf-BTP-Deployment-btp-users/approuter/xs-app.json](Figaf-BTP-Deployment-btp-users/approuter/xs-app.json) | Approuter routing |
| [package.json](package.json) | Electron app + electron-builder NSIS config |
| [instructions.md](instructions.md) | Manual CLI walkthrough that the GUI automates |
| [BTP-CLI/bttp-cli-commands.md](BTP-CLI/bttp-cli-commands.md) | btp CLI reference dump |

---

## Conventions when editing

- **Add a new IPC handler**: register it in `bridge.js#handlers`, then expose it on
  `window.figaf` in `preload.js`. Renderer code consumes only via `window.figaf`.
- **Stream output to the terminal drawer**: use `run(cmd, args, { source })` in
  bridge — it handles fan-out automatically. Manual `spawn()` (e.g. the
  long-lived `cf login`) must wire stdout/stderr to `log(source, type, line)`.
- **New wizard step**: add to `baseSteps` / `deploySteps` / `connectSteps` in
  `app.jsx`, write a `Screen<X>` in `screens.jsx`, switch on `id` in `<App/>`,
  expose it on `window`.
- **No bundler**: don't `import`/`export`. JSX files declare globals and reach each
  other via `window.X` (see the bottom of every `.jsx` file).
- **Path persistence over PATH**: when adding a new external CLI, follow the
  `cliPaths` / `userData/cliPaths.json` pattern — never assume `$PATH`.

## Roadmap markers in code

- `ScreenChoice` exposes a "Connect to Integration Suite" branch that currently
  drops straight to `done`. The plan is to grow this into a separate flow that
  links an existing Figaf deployment to an IS tenant — when implementing,
  add `connectSteps` to `app.jsx` and corresponding screens.
- `xs-app.json` and `manifest.yml` already contain commented-out
  `figaf-connectivity` / `figaf-destination` services for PI/PO agent integration —
  re-enable when that scenario is wired into the wizard.

# CLAUDE.md

Architecture backbone for **Figaf Installer** — an npm-workspaces monorepo that
ships **two parallel wizards** for deploying the [Figaf Tool](https://figaf.com)
to **SAP BTP Cloud Foundry**:

- **figaf-local** — a Windows Electron desktop installer.
- **figaf-manager** — a BTP-hosted (Express + WebSocket) installer that runs in
  a Cloud Foundry space and is driven from the user's browser.

Both share their entire orchestration layer and React renderer; they only
diverge at the host-environment seam (file dialogs, persistent storage, deploy
template sourcing). Skim the graph first, drill into the file table second.

---

## Top-level graph

```
   ┌─── apps/figaf-local (Electron) ────┐    ┌─── apps/figaf-manager (Cloud) ─────┐
   │ ┌──────────┐  IPC ┌──────────────┐ │    │ ┌──────────┐  fetch+ws ┌────────┐ │
   │ │ Renderer │─────▶│ Main process │ │    │ │ Browser  │──────────▶│ Express│ │
   │ │ (React)  │◀─────│ (Node,spawn) │ │    │ │ (React)  │◀──────────│ +ws    │ │
   │ └──────────┘ evts └──────┬───────┘ │    │ └──────────┘   events  └───┬────┘ │
   │                          │         │    │                            │      │
   │   host.electron.js ──────┘         │    │       host.cloud.js ───────┘      │
   └──────────────────┬─────────────────┘    └──────────────────┬────────────────┘
                      │                                         │
                      └──────────► packages/core/orchestrator.js ◄
                                   (shared CLI + login + push logic)
                                              │
                       ┌──────────────────────┼──────────────────────────┐
                       ▼                      ▼                          ▼
                 ┌────────────┐         ┌────────────┐            ┌──────────────┐
                 │  btp CLI   │         │   cf CLI   │            │   web APIs   │
                 │  (SAP)     │         │ (CF Found.)│            │ (DockerHub,  │
                 └─────┬──────┘         └─────┬──────┘            │  GH releases)│
                       │ SSO                  │ SSO+passcode      └──────────────┘
                       ▼                      ▼
                ┌──────────────────────────────────────────────┐
                │              SAP BTP Cloud Foundry           │
                │   approuter (Node) ─▶ figaf-app (Docker)     │
                │        │                    │                │
                │        ▼                    ▼                │
                │   figaf-xsuaa          figaf-db (PG 16)      │
                └──────────────────────────────────────────────┘
```

Both renderers consume the **same** `window.figaf` IPC surface (`prereq.*`,
`btp.*`, `cf.*`, `config.*`, `shell.*`, `on(channel, handler)`). figaf-local
implements that surface with `ipcRenderer.invoke`; figaf-manager implements it
with `fetch("/rpc/:channel")` + `WebSocket(/stream)`. The orchestrator handlers
are byte-identical between the two.

---

## Workspace layout

```
figaf-installer/                          ← workspace root (npm workspaces)
├── package.json                          (workspaces: ["apps/*","packages/*"])
├── apps/
│   ├── figaf-local/                      Electron desktop installer
│   │   ├── package.json                  (electron, electron-builder; renderer shell + logo
│   │   │                                  resolved via require.resolve("@figaf/ui/..."))
│   │   └── main-process/
│   │       ├── main.js                   BrowserWindow, frameless chrome
│   │       ├── preload.js                window.figaf bridge → ipcRenderer
│   │       ├── ipc-bridge.js             wires orchestrator handlers to ipcMain
│   │       └── host.electron.js          HostAdapter (dialog, userData, clipboard)
│   └── figaf-manager/                    Cloud-hosted installer
│       ├── package.json                  (express, ws)
│       ├── cloud/
│       │   ├── server.js                 Express + WebSocketServer
│       │   ├── client.js                 browser shim → window.figaf via fetch+ws
│       │   └── index.html                cloud shell with FIGAF_MODE_INJECT
│       ├── host.cloud.js                 HostAdapter (session-scoped, bundled bin)
│       ├── bin/                          Linux btp + cf binaries (gitignored, populated by build-zip)
│       ├── scripts/build-zip.js          assembles dist/figaf-manager-app-<v>.zip
│       ├── manifest.yml                  CF deployment manifest for the wizard itself
│       └── Dockerfile                    workspace-root build context required
└── packages/
    ├── core/                             host-agnostic orchestrator
    │   ├── package.json                  name: @figaf/core
    │   ├── index.js                      re-exports orchestrator
    │   └── orchestrator.js               every IPC handler + the HostAdapter @typedef
    ├── ui/                               shared React renderer (no bundler)
    │   ├── package.json                  name: @figaf/ui
    │   ├── app.jsx                       <App/> state machine
    │   ├── components.jsx                shared primitives (WinFrame, StepperRail, …)
    │   ├── screens.jsx                   per-step screens
    │   ├── styles.css                    design tokens + components
    │   ├── electron-app.css              frameless titlebar (loaded only by figaf-local)
    │   ├── mode.js                       window.figafModeFlags (isHosted + features)
    │   ├── index.html                    Electron renderer shell (cloud has its own)
    │   └── figaf-logo.png                shared brand mark (also used as Win exe icon + BrowserWindow icon)
    └── deploy-templates/                 BTP CF deployment templates
        ├── package.json                  name: @figaf/deploy-templates
        ├── manifest.yml                  CF apps + service bindings (figaf-app, approuter)
        ├── vars.yml                      template (rewritten at runtime by config:writeVars)
        ├── db.json                       PG 16 service params
        ├── xs-security.json              XSUAA roles
        └── approuter/                    @sap/approuter package + xs-app.json
```

---

## Node A — Renderer (`packages/ui`)

Single React tree. Each app reaches the renderer through its own `index.html` shell because the
loading strategy differs (file:// vs http://):

- `packages/ui/index.html` — sibling-relative paths; loaded by figaf-local's
  main.js via `mainWindow.loadFile(require.resolve("@figaf/ui/package.json")
  → dirname → /index.html)`. Works in dev (workspace symlink) and packaged
  (electron-builder bundles `node_modules/@figaf/ui` into the asar).
- `apps/figaf-manager/cloud/index.html` — absolute paths under `/installer/*`
  (express.static mounts `@figaf/ui` at that prefix).

`window.figafModeFlags` (set by `packages/ui/mode.js`) drives all
mode-conditional behavior:

```js
window.figafModeFlags = {
  isHosted: <bool>,
  features: { cliInstall, diskCheck, windowChrome, selfDelete },
};
```

Add new conditionals to `mode.js` rather than scattering `isHosted` ternaries
across screens.

**Wizard graph** (steps derived from `ctx.choice`):

```
Welcome ─▶ Login ─▶ Choice ─┬─▶ Config ─▶ Progress ─▶ Deploy ─▶ Done
                            └─▶ Done                            (connect-to-IS — TBD)
```

`TerminalDrawer` subscribes to `cli:line` events streamed by the orchestrator.

---

## Node B — Orchestrator (`packages/core/orchestrator.js`)

`createOrchestrator({ host, send })` returns `{ handlers, dispose }` —
~38 channel handlers covering: prereq probes, btp/cf login state machines
(GA prompt detection, passcode pipe), service create/poll, `cf push`,
vars.yml mutation, shell helpers. Streamed events:

| Channel             | Payload                                       | Emitted by                |
|---------------------|-----------------------------------------------|---------------------------|
| `cli:line`          | `{source, type: cmd\|line\|err\|ok\|warn, text}`        | every spawned process     |
| `cli:install`       | `{cli, phase, percent?, error?}`              | install/locate flows      |
| `cf:loggedIn`       | `{}`                                          | cf login exits 0          |
| `cf:loginFailed`    | `{code}`                                      | cf login exits non-zero   |
| `cf:serviceStatus`  | `{name, status}`                              | each pollService tick     |

The HostAdapter contract (`@typedef HostAdapter` at the top of orchestrator.js)
is the only seam between the two apps — see file for full JSDoc.

---

## Node C — Host adapters

Both adapters expose the exact same shape; they differ only in implementation.

| HostAdapter method      | figaf-local (Electron)                  | figaf-manager (Cloud)            |
|-------------------------|-----------------------------------------|----------------------------------|
| `getUserDataDir`        | `app.getPath("userData")`               | `$HOME/sessions/<sessionId>`     |
| `resolveBinary`         | userData/cliPaths.json or PATH fallback | `apps/figaf-manager/bin/<name>` (or PATH in dev) |
| `storeCliPath`          | persists to cliPaths.json               | not implemented                  |
| `pickFile`              | `dialog.showOpenDialog`                 | no-op (returns null)             |
| `openExternal`          | `shell.openExternal`                    | no-op (browser uses window.open) |
| `readClipboard`         | `clipboard.readText`                    | no-op (browser uses navigator.clipboard) |
| `resolveDeployTemplate` | `{ kind: "bundle", src: <bundled dir> }`| `{ kind: "github", src: <zip URL> }` |
| `isHosted`              | `false`                                 | `true`                           |

---

## Node D — External dependencies

| External                          | Used for                                              | Reached via                    |
|-----------------------------------|-------------------------------------------------------|--------------------------------|
| `tools.hana.ondemand.com`         | btp CLI tar.gz download (Win) / EULA cookie           | `httpsDownload`                |
| `api.github.com/repos/cloudfoundry/cli/releases/latest` | cf CLI windows zip                | `httpsJson`                    |
| `packages.cloudfoundry.org/stable`| cf CLI Linux tar.gz (build-zip.js)                    | `httpsGet`                     |
| `hub.docker.com/v2/repositories/figaf/app/tags`        | latest `figaf/app:*-btp` tag       | `httpsJson`                    |
| `github.com/figaf/Figaf-BTP-Deployment` | deploy template zip (cloud only at runtime)     | `httpsDownload`                |
| `cli.btp.cloud.sap`               | btp login endpoint                                    | `btp login --url`              |
| `api.cf.<landscape>.hana.ondemand.com` | cf API endpoint (landscape-derived)              | `cf login -a`                  |

---

## Node E — Packaging

| App | Build command | Output |
|---|---|---|
| figaf-local | `npm --workspace apps/figaf-local run build:win` | `apps/figaf-local/dist/Figaf-Installer-<v>-x64.exe` |
| figaf-manager | `npm --workspace apps/figaf-manager run build-zip` | `apps/figaf-manager/dist/figaf-manager-app-<v>.zip` |

- electron-builder `extraResources` copies `packages/deploy-templates/` next to
  the asar; `host.electron.js` resolves it from `process.resourcesPath`.
- `build-zip.js` stages a self-contained tree under
  `apps/figaf-manager/.staging/` (with `@figaf/core` and `@figaf/ui` as plain
  directories under `node_modules/`), then `npm install --omit=dev` for the
  public deps, then zips.

---

## File map (single source of truth)

| Path | Role |
|------|------|
| [apps/figaf-local/main-process/main.js](apps/figaf-local/main-process/main.js) | Electron entry, BrowserWindow, frameless chrome |
| [apps/figaf-local/main-process/preload.js](apps/figaf-local/main-process/preload.js) | `window.figaf` IPC surface |
| [apps/figaf-local/main-process/ipc-bridge.js](apps/figaf-local/main-process/ipc-bridge.js) | wires orchestrator handlers to ipcMain |
| [apps/figaf-local/main-process/host.electron.js](apps/figaf-local/main-process/host.electron.js) | Electron HostAdapter |
| [packages/ui/index.html](packages/ui/index.html) | Electron renderer shell (resolved by main.js via require.resolve) |
| [apps/figaf-manager/cloud/server.js](apps/figaf-manager/cloud/server.js) | Express RPC + WebSocketServer |
| [apps/figaf-manager/cloud/client.js](apps/figaf-manager/cloud/client.js) | browser `window.figaf` shim (fetch + ws) |
| [apps/figaf-manager/cloud/index.html](apps/figaf-manager/cloud/index.html) | Cloud renderer shell with mode injection |
| [apps/figaf-manager/host.cloud.js](apps/figaf-manager/host.cloud.js) | Cloud HostAdapter |
| [apps/figaf-manager/Dockerfile](apps/figaf-manager/Dockerfile) | container build (workspace root context) |
| [apps/figaf-manager/manifest.yml](apps/figaf-manager/manifest.yml) | CF manifest for the wizard itself |
| [apps/figaf-manager/scripts/build-zip.js](apps/figaf-manager/scripts/build-zip.js) | Assemble the cockpit-deployable zip |
| [packages/core/orchestrator.js](packages/core/orchestrator.js) | All ~38 IPC handlers + HostAdapter typedef |
| [packages/core/index.js](packages/core/index.js) | re-export of orchestrator |
| [packages/ui/app.jsx](packages/ui/app.jsx) | `<App/>`, wizard state machine |
| [packages/ui/screens.jsx](packages/ui/screens.jsx) | Per-step screens + their IPC choreography |
| [packages/ui/components.jsx](packages/ui/components.jsx) | Shared primitives (icons, frame, stepper, terminal) |
| [packages/ui/mode.js](packages/ui/mode.js) | window.figafModeFlags (isHosted + feature flags) |
| [packages/ui/styles.css](packages/ui/styles.css) | Design tokens & component styles |
| [packages/ui/electron-app.css](packages/ui/electron-app.css) | Frameless window chrome (figaf-local only) |
| [packages/deploy-templates/manifest.yml](packages/deploy-templates/manifest.yml) | CF manifest (figaf-app + approuter) |
| [packages/deploy-templates/vars.yml](packages/deploy-templates/vars.yml) | Variable template (rewritten at runtime) |
| [packages/deploy-templates/xs-security.json](packages/deploy-templates/xs-security.json) | XSUAA roles |
| [packages/deploy-templates/db.json](packages/deploy-templates/db.json) | PG service parameters |
| [packages/deploy-templates/approuter/xs-app.json](packages/deploy-templates/approuter/xs-app.json) | Approuter routing |
| [package.json](package.json) | workspace root |
| [instructions.md](instructions.md) | Manual CLI walkthrough that the GUI automates |
| [BTP-CLI/bttp-cli-commands.md](BTP-CLI/bttp-cli-commands.md) | btp CLI reference dump |

---

## Conventions when editing

- **Add a new IPC handler**: register it in `packages/core/orchestrator.js`'s
  `handlers` map. It is automatically wired by both apps:
  - `apps/figaf-local/main-process/ipc-bridge.js` iterates `Object.entries(handlers)`.
  - `apps/figaf-manager/cloud/server.js` looks up `sess.handlers[channel]` per RPC.
  Then expose it on `window.figaf` in **both**:
  - `apps/figaf-local/main-process/preload.js` (`ipcRenderer.invoke(...)`)
  - `apps/figaf-manager/cloud/client.js` (`rpc(...)`)
- **Stream output to the terminal drawer**: use `run(cmd, args, { source })` in
  the orchestrator — it handles fan-out automatically. Manual `spawn()` (the
  long-lived `cf login` and `btp login` procs) must wire stdout/stderr to
  `log(source, type, line)`.
- **New wizard step**: add to `baseSteps` / `deploySteps` / `connectSteps` in
  `packages/ui/app.jsx`, write a `Screen<X>` in `packages/ui/screens.jsx`,
  switch on `id` in `<App/>`. Both apps pick it up automatically.
- **Mode-conditional UI**: declare a flag in `packages/ui/mode.js`, then read it
  from `window.figafModeFlags.features.<flag>`. Don't inline `isHosted` ternaries.
- **No bundler**: don't `import`/`export` in renderer code. JSX files declare
  globals on `window` and reach each other that way.
- **Path persistence over PATH**: when adding a new external CLI, follow the
  `cliPaths.json` pattern in `host.electron.js` — never assume `$PATH`.

## Roadmap markers in code

- `ScreenChoice` exposes a "Connect to Integration Suite" branch that currently
  drops to `done`. The plan is to grow this into a separate flow (`connectSteps`
  in `packages/ui/app.jsx` + corresponding screens). Both apps will pick it up.
- `xs-app.json` and `manifest.yml` in `packages/deploy-templates/` already
  contain commented-out `figaf-connectivity` / `figaf-destination` services for
  PI/PO agent integration — re-enable when that scenario is wired into the wizard.

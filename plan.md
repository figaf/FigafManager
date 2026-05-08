# Plan — Path 1: BTP-Hosted Figaf Manager App

This plan operationalizes the strategy in [let-s-look-at-security-and-distribution-jolly-panda.md](let-s-look-at-security-and-distribution-jolly-panda.md). The target is a `cf push`'d admin app — branded **Figaf Manager** to signal the long-term shape (install today, manage/update tomorrow) — deployed into the customer's own BTP subaccount, that hosts the existing wizard UI and orchestrates btp/cf CLI commands inside its own container.

---

## Progress (as of 2026-05-08)

### Completed

- **`figaf-manager/` directory created** inside the Electron repo (`c:\Figaf-installer\figaf-manager\`)
- **`manifest.yml`** — CF manifest written; fixed twice:
  1. Removed `routes: - route: figaf-manager.((domain))` (cockpit cannot resolve `((var))` placeholders at deploy time)
  2. Changed `random-route: false` → `random-route: true` (false + no routes block = 0 mapped routes)
- **`scripts/build-zip.js`** — build script operational; fixed:
  - BTP CLI version updated `2.72.0` → `2.106.1` (old version 404'd)
  - CF CLI download URL changed to stable channel (`packages.cloudfoundry.org/stable?...`)
  - `require("archiver")` moved to top-of-file so Node.js caches it before `npm ci --omit=dev` removes it from disk
  - Added `res.resume()` in redirect branch of `httpsGet` to drain socket and prevent event-loop hang
- **`Dockerfile`** — local Docker image working; fixed: `npm ci` → `npm install --omit=dev` (no `package-lock.json`)
- **`.dockerignore`** — created (excludes Windows `node_modules/`, `dist/`, `scripts/`)
- **`.cfignore`** — created
- **`package.json`** — `btpCliVersion: "2.106.1"`, deps `express` + `ws`, devDep `archiver`
- **Docker local test** — `docker run --rm -p 8080:8080 figaf-manager` serves UI at `http://localhost:8080` ✓
- **BTP Cockpit deploy** — `figaf-manager` app deployed and `RUNNING` on `cfapps.us10-001.hana.ondemand.com`

### In Progress

- **Route mapping** — app is running but has 0 mapped routes. Fix committed (`random-route: true`). Next step: rebuild zip (`npm install && npm run build-zip`), redeploy, confirm URL is accessible.

### Not Started (plan phases below)

- Phase 1A — host-agnostic refactor (`lib/cli-orchestrator.js`)
- Phase 1B — CF server adapter (`cloud/server.js` is a stub; no Express/WS yet)
- Phase 1C — renderer client shim (`cloud/client.js`)
- Phase 1D — renderer mode-aware behavior (`window.figafMode`)
- Phase 1G — open-source repo + cosign release workflow

### Resolved open questions

- **§5 open question — manifest variable substitution via cockpit**: confirmed the cockpit does NOT resolve `((var))` placeholders. Fix: `random-route: true`, no `routes:` block. ✓
- **§5 open question — cockpit upload size limit**: no size error encountered at ~120 MB. Not a blocker. ✓

---

---

## 1. Architecture

```
Customer's browser                              Customer's BTP subaccount
─────────────────────                           ─────────────────────────────────────────────────────

[ figaf.com/manager ]                           BTP Cockpit (already-authenticated browser session)
   • download                                   ┌─ Space → Applications → "Deploy Application" ───┐
     figaf-manager-app-<ver>.zip                │   File location:  figaf-manager-app.zip         │
                          │                     │   Deploy with:    Manifest                      │
                          ▼                     │   ✔ Start application after deploy             │
                  ┌─────────────┐               └────────────────┬────────────────────────────────┘
                  │ local file  │  upload                        │ cockpit performs cf push
                  │   .zip      │ ───────────────────▶          │
                  └─────────────┘                                ▼

                                                ┌─ figaf-manager-app  (Node.js) ──────────────────┐
[ open URL in browser ] ◀──────HTTPS+WSS───────│  https://figaf-manager.<cfdomain>               │
   • renders existing React UI                  │  (public-but-powerless: every state-changing    │
   • pastes passcode for cf login               │   action requires a fresh `cf login --sso`)     │
   • watches Terminal Drawer stream             │                                                  │
                                                │  ├─ cloud/server.js     (Express + WS)          │
                                                │  ├─ lib/cli-orchestrator.js (host-agnostic)     │
                                                │  ├─ bin/btp             (Linux binary)          │
                                                │  └─ bin/cf              (Linux binary)          │
                                                │                                                  │
                                                │  At wizard-deploy time, fetches and unzips:      │
                                                │  └─ Figaf-BTP-Deployment-btp-users/              │
                                                │      from github.com/figaf/Figaf-BTP-Deployment  │
                                                │      → $HOME/deploy/                             │
                                                │                                                  │
                                                │  spawns cf/btp as child processes                │
                                                │  per-session $CF_HOME, $SAPCP_CLIENTCONFIG       │
                                                └──────────────────────────────────────────────────┘

                                                  Targets the customer's own org/space.
                                                  Uses the user's own SSO authority — no stored creds.
                                                  After deploy completes, `cf delete figaf-manager`.
```

One deployable artifact:

**figaf-manager-app.zip** — an ephemeral CF app inside the customer's subaccount. Customer downloads the zip from figaf.com, signs into the BTP cockpit they already use, navigates to their CF space, clicks "Deploy Application", and uploads the zip. Cockpit handles `cf push` internally. After ~5–10 minutes the app is staged and started; the customer opens `https://figaf-manager.<cfdomain>` and proceeds through the wizard there. When the deploy completes, the wizard's final screen offers a **Delete this manager app** action (or the customer runs `cf delete figaf-manager` from the cockpit themselves).

**No client-side install. Not even Node.js.** A browser and BTP cockpit access — both already in the customer's hands — are the only prerequisites.

**No XSUAA, no service instances, no role collection.** The manager app has no service bindings and is gated only by SAP's own SSO during the wizard flow (see §2.3). The route is publicly reachable but harmless: every state-changing action in the wizard requires the user to paste a fresh `cf login --sso` passcode obtained from SAP's own login endpoint in their browser session.

---

## 2. Key technical challenges

### 2.1 Bundling btp and cf into the CF droplet

Both CLIs are statically-linked Linux binaries. They are vendored into `bin/` and copied to the droplet by the standard `nodejs_buildpack`. Total size ~80 MB (cf ~50 MB, btp ~30 MB) — well under the default disk quota of 1 GB.

```
bin/
├── btp           # Linux x86_64, from tools.hana.ondemand.com
└── cf            # Linux x86_64, from github.com/cloudfoundry/cli/releases/latest
```

`package.json` `scripts.postinstall` runs `chmod +x bin/btp bin/cf` so the staged droplet has executable bits. (Alternatively, the build pipeline pre-sets them in the tarball.)

The orchestrator resolves binaries via the HostAdapter's `resolveBinary(name)` (already conceptually present today via `userData/cliPaths.json`); we seed it with absolute `bin/btp` and `bin/cf` on container start.

**Open question:** version pinning. Today the Electron app downloads the latest btp/cf at install time. For the CF-hosted app, we pin to specific known-good versions per release tag. Updating btp/cf becomes a tagged Figaf Manager release — easier to QA, but slower to follow upstream.

### 2.2 Token-cache directory inside the container

CF apps have a writable but ephemeral filesystem at `$HOME` (the staged droplet's working dir). Both CLIs want to write config:

| CLI | Default config path | Override env var |
|---|---|---|
| btp | `~/.config/.btp/`  | `SAPCP_CLIENTCONFIG` (full config file path) |
| cf  | `~/.cf/`           | `CF_HOME` (directory path) |

Set both per session (see §2.3). Token caches are container-scoped: when the manager app restarts (redeploy, scale, container reschedule), the user re-authenticates. Acceptable for the wizard use-case; not a problem for one-shot deploys.

If we need persistence across restarts (Phase 2 manage/update scenarios), bind a small Object Store / HANA service and write the token cache there. Out of scope for the initial wizard.

### 2.3 Authentication: interactive SSO inside the container, no XSUAA

The manager app has **no XSUAA binding**. Authority comes entirely from each `cf login --sso` exchange the user performs inside the wizard. The route `https://figaf-manager.<cfdomain>` is public but does nothing of consequence on its own — every state-changing handler in `lib/cli-orchestrator.js` either spawns a `cf` / `btp` child process that requires an active login, or reads from the user's already-authenticated child-process state. A drive-by visitor sees the wizard UI and a login screen asking for a passcode they don't have.

Why this is acceptable:

- **Powerless without a passcode.** The wizard cannot do anything against the customer's BTP subaccount until the user pastes a fresh `--sso` passcode obtained from SAP's own one-time-passcode page. That page is gated by SAP's central SSO (Identity Authentication / IAS), with whatever MFA/SSO controls the customer has configured at the IAS level.
- **Ephemeral.** The customer is encouraged to `cf delete figaf-manager` after the deploy succeeds. The window of public exposure is the duration of one wizard session (typically <30 minutes).
- **Same authority model as the Electron build today.** The current desktop installer also requires the user to paste a passcode — XSUAA wouldn't add anything beyond what `cf login --sso` already gives us.
- **Avoids the self-restage problem.** Adding XSUAA later via `cf bind-service` + `cf restage` would kill the running container mid-wizard. Skipping XSUAA dodges that entirely.

Same long-lived child-process pattern from [main-process/bridge.js](main-process/bridge.js):

- `cf:loginStart` spawns `bin/cf login --sso -a <api>`, keeps stdin open.
- The user pastes their passcode in the React UI; renderer sends it via WS / fetch to `cf:submitPasscode`.
- The handler writes to the cf child process's stdin.
- cf exits 0 on success → `cf:loggedIn` event over WS → renderer advances.

The btp side is identical (today's `btp:loginStart` / `btp:submitChoice` for global-account selection).

**Per-session state isolation.** Cloud Foundry expects a single `cf` config per `CF_HOME`. If two users hit the same app instance simultaneously, their cf state would collide. Without an XSUAA JWT to key off, the server issues an opaque session cookie on first request and derives `CF_HOME` and `SAPCP_CLIENTCONFIG` from the cookie:

```js
function sessionEnv(sessionId) {
  const root = path.join(os.homedir(), 'sessions', sessionId);
  return {
    CF_HOME: path.join(root, '.cf'),
    SAPCP_CLIENTCONFIG: path.join(root, '.btp', 'config.json'),
  };
}
```

Each spawned child process inherits the right env. Cookies are `HttpOnly`, `Secure`, `SameSite=Lax`, signed with a per-app-instance secret (random on boot). Sessions auto-expire after N minutes of inactivity, and `dispose()` kills the corresponding `cfLoginProc` / `btpLoginProc` children.

(Verify in implementation that no `cf` CLI command relies on hidden global state outside `CF_HOME`.)

### 2.4 Bootstrap: getting the manager app onto BTP in the first place

The customer uses the BTP cockpit's own **Deploy Application** dialog. No CLI, no npm, no Node.js, no scripts on the local machine. **No XSUAA service instance to pre-create.**

Walkthrough:

1. Customer visits `figaf.com/manager` and downloads `figaf-manager-app-<ver>.zip` (with detached signature `.sig` and certificate `.cert` for optional out-of-band verification).
2. Signs into the BTP cockpit (browser session — they already use this for everything else).
3. Navigates to their global account → subaccount → CF org → space → **Applications**.
4. Clicks **Deploy Application** (top-right of the cockpit Applications view):
   - **File location:** `figaf-manager-app-<ver>.zip`
   - **Deploy with:** Manifest (the zip contains `manifest.yml` at root)
   - **Start application after deploy:** ✔
5. Clicks **Deploy**. Cockpit uploads the zip, runs `cf push` server-side, streams progress in the cockpit UI.
6. ~5–10 minutes later the app is `RUNNING`. Customer clicks the route `https://figaf-manager.<cfdomain>` from the cockpit's Applications view.
7. Wizard renders directly (no XSUAA login redirect). Customer authenticates the inner `cf login --sso` and continues through the existing flow.
8. After the figaf product is deployed, the wizard's final screen offers **Delete this manager app** (`cf delete figaf-manager -f`). Customer can keep the app around for re-runs / future maintenance, or delete it now and re-upload from figaf.com next time.

Why this is strictly better than an npm bootstrap:

- **Zero client surface.** No `npx`, no Node.js, no shell script, no `cf` / `btp` CLI on the user's machine. The cockpit is the *only* substrate touched.
- **Trust anchor is SAP's own UI.** Customers already trust the cockpit to perform `cf push` — that is literally what its Deploy Application button does. We are not asking them to trust a new tool, we are giving them an artifact to feed into a tool they already use.
- **No npm registry hijack risk.** The artifact is a versioned zip from `figaf.com`, served with a cosign signature. Distribution is one channel (figaf.com) plus an optional out-of-band integrity check, not a transitive npm graph.
- **No "what if my corporate proxy blocks npm" failure mode.** Most enterprise networks allow downloads from vendor sites and SAP cockpit traffic; few allow arbitrary `npx` invocations.

**Single-app deploy is now the natural shape.** With no XSUAA there is no separate approuter — one zip, one app, one Deploy click. The cockpit Deploy Application flow handles it natively.

### 2.5 Runtime download of the figaf product deployment template

The deployment artifacts that the wizard pushes into the customer's space (`manifest.yml`, `vars.yml`, `xs-security.json`, `db.json`, `approuter/`) live in the public repo [figaf/Figaf-BTP-Deployment, branch `btp-users`](https://github.com/figaf/Figaf-BTP-Deployment/tree/btp-users). Today the Electron build bundles a snapshot of this directory under `Figaf-BTP-Deployment-btp-users/` and copies it into the deploy dir at first use.

For the manager app we **fetch the deployment zip on demand**, not bundle it. Source URL:

```
https://github.com/figaf/Figaf-BTP-Deployment/archive/refs/heads/btp-users.zip
```

Flow:

- **At wizard deploy time** (when the user advances from `ScreenConfig` to `ScreenProgress`), the orchestrator calls `httpsDownload(url, $HOME/deploy/btp-users.zip)` and `extractZip($HOME/deploy/btp-users.zip, $HOME/deploy/)`. Both helpers already exist in [main-process/bridge.js](main-process/bridge.js) (used today for the cf/btp CLI downloads). GitHub's archive zip extracts to `Figaf-BTP-Deployment-btp-users/` — the same directory layout the existing code expects.
- **Cached for the container lifetime.** Subsequent users on the same container reuse `$HOME/deploy/Figaf-BTP-Deployment-btp-users/` without re-downloading.
- **The orchestrator's `resolveDeployDir()` becomes host-aware.** Electron mode keeps today's "copy from `process.resourcesPath`" behavior (works offline). Hosted mode does the GitHub download.
- **Streamed feedback.** The download and extract emit `cli:line` events ("Downloading deployment template...", "Extracting...") that show up in the Terminal Drawer just like every other long-running step.

Benefits:

- **Smaller manager zip.** The deployment artifacts are not in `figaf-manager-app-<ver>.zip` at all — manager releases are decoupled from deployment-template churn.
- **Always-current template.** Customers get whatever is on the `btp-users` branch tip at the moment they run the wizard, without us cutting a new manager release every time the deployment manifest changes.
- **Simpler manager release pipeline.** CI no longer has to vendor the upstream branch state.
- **Decoupled iteration.** The figaf product's deployment manifest can be updated independently of the manager UI; a customer who already deployed the manager once still gets the latest deployment template the next time they run the wizard.

Trust note for IT review: the GitHub URL is hardcoded in [lib/cli-orchestrator.js](lib/cli-orchestrator.js) and surfaced in the `BTP_HOSTED.md` command-surface document. Customers who want pinned deploys can fork the repo and set an env var (`FIGAF_DEPLOYMENT_ZIP_URL`) on the manager app pointing at their fork or a self-hosted mirror.

**Open question:** subaccounts with egress restrictions blocking raw `github.com` / `codeload.github.com`. Mitigations in priority order:

1. Document that egress to `github.com` and `codeload.github.com` is required for the hosted manager.
2. `FIGAF_DEPLOYMENT_ZIP_URL` env override → S3 / Object Store / Nexus mirror.
3. Keep the Electron build as the air-gapped fallback (it bundles the deployment dir).

---

## 3. Phased implementation

### Phase 1A — Host-agnostic refactor (foundation)

The win: Electron and CF-hosted server ship from a single codebase via thin host adapters.

**Move out of [main-process/bridge.js](main-process/bridge.js) into `lib/cli-orchestrator.js`:**

- All 26 IPC handlers across 5 prefixes:
  - `prereq:*` (10): `whichBtp`, `whichCf`, `getCliPaths`, `clearCliPath`, `installBtp`, `installCf`, `locateCli`, `dockerHub`, `disk`, `openBtpDownloadPage`
  - `btp:*` (8): `loginStart`, `submitChoice`, `cancelLogin`, `selectGlobalAccount`, `logout`, `listEnvInstances`, `listUsers`, `assignRole`
  - `cf:*` (10): `loginStart`, `submitPasscode`, `logout`, `targetOrgSpace`, `domains`, `marketplacePostgresql`, `createService`, `service`, `pollService`, `push`
  - `config:*` (5): `dockerHubLatestBtpTag`, `dockerHubBtpTags`, `deployDir`, `readVars`, `writeVars`
  - `shell:*` (3): `openPasscodeUrl`, `openExternal`, `readClipboard`
- Helpers: `run()`, `parseTable()`, `resolveDeployDir()`, `httpsJson()`, `httpsDownload()`, `walkSync()`, `extractZip()`.
- Long-lived process state: `cfLoginProc`, `btpLoginProc`, GA-choice detection regex.

**`resolveDeployDir()` becomes host-aware.** New signature: `async function resolveDeployDir(host, log)`. Electron path: copy from `process.resourcesPath` to writable userData (today's behavior). Hosted path: download `https://github.com/figaf/Figaf-BTP-Deployment/archive/refs/heads/btp-users.zip` to `$HOME/deploy/`, `extractZip()`, return `$HOME/deploy/Figaf-BTP-Deployment-btp-users/`. Memoized — second call within the same container returns the cached path. Both paths emit progress lines via `log()`.

The orchestrator exports a single factory:

```js
function createOrchestrator({ host, log }) { /* … */ return { handlers, dispose }; }
```

where `host` is the **HostAdapter** and `log(source, type, text)` is the line-streaming sink (Electron wires it to `mainWindow.webContents.send('cli:line', …)`; CF-hosted wires it to per-connection WebSocket frames).

**Define the HostAdapter contract:**

```js
{
  getUserDataDir(req?): string,                // Electron: app.getPath('userData'); CF: per-session subdir
  resolveBinary(name): string,                 // Electron: cliPaths.json or 'btp' on PATH; CF: 'bin/btp' (absolute)
  openExternal(url): Promise<void>,            // Electron: shell.openExternal; CF: no-op (renderer opens client-side)
  pickFile(opts): Promise<string|null>,        // Electron: dialog.showOpenDialog; CF: no-op (locateCli unreachable)
  readClipboard(): Promise<string>,            // Electron: clipboard.readText; CF: no-op (renderer)
  resolveDeployTemplate(): {kind:'bundle'|'github', src:string},  // Electron: bundled path; CF: github zip URL
  isHosted: boolean,
}
```

CF-hosted's adapter returns no-ops for capabilities that don't apply. The renderer's mode-aware code (Phase 1D) ensures those handlers are not called in hosted mode anyway.

**Rewrite [main-process/bridge.js](main-process/bridge.js) as a ~30-line Electron adapter:**

```js
const { app, ipcMain, dialog, clipboard, shell } = require('electron');
const { createOrchestrator } = require('../lib/cli-orchestrator');

function createBridge(mainWindow) {
  const log = (source, type, text) =>
    mainWindow.webContents.send('cli:line', { source, type, text });

  const host = {
    getUserDataDir: () => app.getPath('userData'),
    resolveBinary: (name) => /* existing whichBtp/whichCf flow */,
    openExternal: (url) => shell.openExternal(url),
    pickFile: (opts) => dialog.showOpenDialog(opts).then(r => r.canceled ? null : r.filePaths[0]),
    readClipboard: () => Promise.resolve(clipboard.readText()),
    resolveDeployTemplate: () => ({ kind: 'bundle', src: path.join(process.resourcesPath, 'Figaf-BTP-Deployment-btp-users') }),
    isHosted: false,
  };

  const { handlers, dispose } = createOrchestrator({ host, log });
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_e, args) => fn(args));
  }
  return { dispose };
}
module.exports = { createBridge };
```

**Regression bar:** behavior of the Electron app must remain bit-identical after this refactor. `npm start` deploys end-to-end identically.

### Phase 1B — CF-hosted server adapter `cloud/server.js`

Stack: Express for HTTP routes, `ws` for streaming, `cookie-parser` for session cookies. None currently in `package.json`; add as `dependencies`.

Responsibilities:

1. Serve the renderer at `/` — a templated copy of [installer/index.html](installer/index.html) with a server-injected `<script>window.figafMode = "hosted"; window.figafSession = {...}</script>` block before `<script src="./app.jsx">`.
2. Serve `/installer/*` static assets (JSX, CSS files unchanged).
3. POST `/rpc/:channel` — body is the args object, response is the handler's return value. One route per IPC channel name (`cf:targetOrgSpace` → POST `/rpc/cf:targetOrgSpace`).
4. WebSocket `/stream` — broadcasts every `log()` and event-emit call as `{channel, payload}` JSON frames. Renderer's `figaf.on(channel, handler)` translates to subscribing on this WS and filtering by channel.
5. Bind to `0.0.0.0:$PORT` — Cloud Foundry's buildpack sets `$PORT`; gorouter forwards external HTTPS traffic to it directly (no internal-route indirection — there is no approuter).
6. Per-session orchestrator: derive `CF_HOME` / `SAPCP_CLIENTCONFIG` from the signed session cookie, instantiate (or look up) a per-user orchestrator, route the call through it. Sessions auto-expire after configurable inactivity.
7. On `SIGTERM` (CF shutdown): call `orchestrator.dispose()` for every active session to kill long-lived `cfLoginProc` / `btpLoginProc` children.

CF host adapter:

```js
const host = {
  getUserDataDir: (req) => path.join(os.homedir(), 'sessions', req.sessionId),
  resolveBinary: (name) => path.join(__dirname, '..', 'bin', name),
  openExternal: () => Promise.resolve(),     // renderer handles client-side
  pickFile: () => Promise.resolve(null),     // locateCli is unreachable in hosted mode
  readClipboard: () => Promise.resolve(''),  // renderer uses navigator.clipboard
  resolveDeployTemplate: () => ({
    kind: 'github',
    src: process.env.FIGAF_DEPLOYMENT_ZIP_URL
      ?? 'https://github.com/figaf/Figaf-BTP-Deployment/archive/refs/heads/btp-users.zip',
  }),
  isHosted: true,
};
```

### Phase 1C — Renderer client shim `cloud/client.js`

Loaded by the templated `index.html` *before* `app.jsx`. Provides `window.figaf` with the same surface as Electron's preload, but over fetch + WebSocket:

```js
const ws = new WebSocket(`wss://${location.host}/stream`);
const subscribers = new Map();

ws.addEventListener('message', (e) => {
  const { channel, payload } = JSON.parse(e.data);
  for (const h of (subscribers.get(channel) ?? [])) h(payload);
});

const rpc = (channel, args) => fetch(`/rpc/${channel}`, {
  method: 'POST', headers: {'Content-Type': 'application/json'},
  body: JSON.stringify(args ?? {}),
  credentials: 'same-origin', // session cookie travels with every RPC
}).then(r => r.json());

window.figaf = {
  prereq: { whichBtp: () => rpc('prereq:whichBtp'), /* …all 10… */ },
  btp:    { loginStart: () => rpc('btp:loginStart'), submitChoice: (c) => rpc('btp:submitChoice', c), /* … */ },
  cf:     { loginStart: () => rpc('cf:loginStart'), submitPasscode: (p) => rpc('cf:submitPasscode', p), /* … */ },
  config: { /* … */ },
  shell: {
    openExternal: (url) => { window.open(url, '_blank', 'noopener'); return Promise.resolve(); },
    openPasscodeUrl: (url) => { window.open(url, '_blank', 'noopener'); return Promise.resolve(); },
    readClipboard: () => navigator.clipboard.readText(),
  },
  window: { minimize: () => {}, toggleMax: () => {}, close: () => {} },
  on: (channel, handler) => {
    if (!subscribers.has(channel)) subscribers.set(channel, new Set());
    subscribers.get(channel).add(handler);
    return () => subscribers.get(channel).delete(handler);
  },
};
```

Important: `shell.openExternal`, `shell.openPasscodeUrl`, and `shell.readClipboard` are implemented in the **browser**, not the server. The URL opens in the user's local browser (which is already where the wizard runs in hosted mode), and the clipboard is the user's local clipboard. No server roundtrip.

### Phase 1D — Renderer mode-aware behavior

The JSX is framework-agnostic (no bundler, all globals). Mode-gating is done by checking `window.figafMode` at runtime.

**D.1 — Inject the mode flag**

CF server templates `index.html` to insert (before `<script src="./app.jsx">`):

```html
<script>
  window.figafMode = "hosted";
  window.figafSession = { /* sessionId, landscape — pre-detected by server */ };
</script>
```

Electron sets `window.figafMode = "electron"` in [main-process/preload.js](main-process/preload.js) for symmetry.

**D.2 — `ScreenWelcome` skips bundled-CLI probes** ([installer/screens.jsx:104–193](installer/screens.jsx#L104-L193))

Today's four parallel probes:

- `whichBtp` / `whichCf` — **skip in hosted mode**; CLIs are bundled and resolved via `host.resolveBinary`.
- `dockerHub` — **keep**; `ScreenConfig` still needs the latest tag list.
- `disk` — **skip**; CF container has its own quota and `cf push` happens server-side.

Display a much shorter "Ready in your BTP subaccount" panel when `window.figafMode === "hosted"`.

**D.3 — `ScreenLogin` is preserved**

Login flow is unchanged from today — the CLI child processes live in the CF container instead of the user's machine, but the UX is identical: passcode page opens in a new tab, user pastes back, deploy proceeds.

**D.4 — Hide WinFrame chrome in hosted mode** ([installer/components.jsx](installer/components.jsx))

Frameless-window chrome (traffic lights, drag region, custom titlebar) is meaningless in a browser tab. Conditional in `WinFrame`: when hosted, render a normal page header (or nothing) instead.

**D.5 — `ScreenDone` adds a "Delete this manager app" CTA in hosted mode**

After printing the figaf URL and the **Open Figaf** button, hosted mode shows a secondary action: **Delete this manager app**. Clicking it calls a new `cf:deleteApp` orchestrator handler that runs `cf delete figaf-manager -f` and shows a final "App deleted — this tab will stop responding shortly" toast. In Electron mode the button is hidden (the desktop installer has nothing to clean up server-side).

A README note also tells the customer they can run `cf delete figaf-manager` themselves from the cockpit if they prefer.

### Phase 1E — Manifest (single-app, no services) ✓ DONE

`manifest.yml` (at the root of the deployable zip):

```yaml
applications:
  - name: figaf-manager
    memory: 1G
    disk_quota: 2G
    instances: 1
    buildpack: nodejs_buildpack
    command: node cloud/server.js
    random-route: true
    env:
      NODE_ENV: production
```

**Verified in trial**: the BTP cockpit's Deploy Application does NOT resolve `((var))` placeholders. `random-route: true` makes CF auto-assign the route; no `routes:` block needed.

**No services, no role collection, no `xs-security.json`.** The app is publicly reachable on `https://figaf-manager.<cfdomain>`. The wizard inside is gated by the user's `cf login --sso` passcode (see §2.3).

### Phase 1F — Build & publish the deployable zip

The artifact is a versioned zip published to figaf.com (and as a GitHub release asset, for IT teams that prefer to verify upstream).

`scripts/build-zip.js` (or a Makefile target):

1. Install Node deps (`npm ci --omit=dev`) into `node_modules/`.
2. Download Linux x86_64 binaries for `btp` and `cf` at the version pinned in `package.json` → `bin/btp`, `bin/cf`. `chmod +x`.
3. Bundle:
   - `cloud/server.js`, `cloud/client.js`, `cloud/index.html`
   - `lib/cli-orchestrator.js`
   - `installer/` (the JSX/CSS UI assets)
   - `bin/btp`, `bin/cf`
   - `node_modules/` (production deps only)
   - `manifest.yml`, `package.json`, `README.md`
4. Zip → `figaf-manager-app-<version>.zip` (~120–180 MB, dominated by CLIs and node_modules; `Figaf-BTP-Deployment-btp-users/` is **not** bundled — fetched at runtime per §2.5).
5. Cosign sign: `figaf-manager-app-<version>.zip.sig` + `.cert`.

`README.md` inside the zip is the IT-review document. It lists:

- Every `cf` and `btp` command the orchestrator can issue (generated from `lib/cli-orchestrator.js`).
- The exact env vars set inside the container.
- The external URLs the manager fetches (`hub.docker.com`, `github.com/figaf/Figaf-BTP-Deployment`, optional `tools.hana.ondemand.com` for stage-time CLI download).
- That the app has **no XSUAA / service-instance prerequisites**.
- Verification: `cosign verify-blob ...` with the public OIDC issuer.

### Phase 1G — Open-source + signed releases

- **Public repo** `figaf/figaf-manager`. Pre-publication audit: `git log -p` review for internal SAP URLs, credentials, non-public references.
- **Top-level docs:** `SECURITY.md` (trust model + disclosure address) and `BTP_HOSTED.md` (IT-review documentation linked from figaf.com).
- **GitHub Actions release workflow** (`.github/workflows/release.yml`) on tag push:
  - Run `scripts/build-zip.js` to produce `figaf-manager-app-<ref>.zip`.
  - `cosign sign-blob --yes` with GitHub OIDC keyless flow.
  - Attach `figaf-manager-app-<ref>.zip`, `.zip.sig`, `.zip.cert` to the GitHub release.
  - Mirror the same three files to figaf.com via the existing release-publish step.
- **Customer-side verification (optional but documented):** `cosign verify-blob --certificate <cert> --signature <sig> --certificate-identity-regexp '...' figaf-manager-app-<ver>.zip`. Documented in `BTP_HOSTED.md`; not required for cockpit upload.
- **Pinning:** the customer downloads a specific versioned zip from figaf.com. There is no "latest" autoloader to hijack; the URL itself is the pin.

---

## 4. File map (deltas vs. today)

**New files:**

- `lib/cli-orchestrator.js` — host-agnostic core extracted from bridge.js (incl. host-aware `resolveDeployDir()` with GitHub fetch path)
- `cloud/server.js` — Express + ws CF-hosted adapter, with cookie-based session middleware (no XSUAA)
- `cloud/client.js` — `window.figaf` over fetch + WebSocket
- `cloud/index.html` — templated copy of installer/index.html with mode-flag injection
- `bin/btp`, `bin/cf` — bundled Linux binaries (gitignored; CI populates from upstream releases at zip-build time)
- `manifest.yml` — manager app deployment (single-app, no services)
- `scripts/build-zip.js` — assembles `figaf-manager-app-<ver>.zip` for cockpit upload
- `SECURITY.md`, `BTP_HOSTED.md`
- `.github/workflows/release.yml`

**Modified files:**

- [main-process/bridge.js](main-process/bridge.js) — collapse to ~30-line Electron adapter
- [main-process/preload.js](main-process/preload.js) — set `window.figafMode = "electron"` for symmetry
- [installer/app.jsx](installer/app.jsx) — gate UI shell on `window.figafMode`; consume `window.figafSession`
- [installer/screens.jsx](installer/screens.jsx) — `ScreenWelcome` skips bundled-CLI probes; `ScreenLogin` preserved; `ScreenDone` gains a hosted-mode "Delete this manager app" CTA
- [installer/components.jsx](installer/components.jsx) — `WinFrame` conditional chrome
- [package.json](package.json) — add `dependencies`: `express`, `ws`, `cookie-parser`; add `scripts.cloud`: `node cloud/server.js`; keep electron-builder config intact

**Untouched:**

- All of [Figaf-BTP-Deployment-btp-users/](Figaf-BTP-Deployment-btp-users/) — kept as the bundled snapshot for the Electron build (offline fallback). The hosted manager fetches the live branch from GitHub at runtime instead, so the manager zip does **not** contain this directory.
- [main-process/main.js](main-process/main.js) — Electron bootstrap unchanged.
- All `installer/*.css` — design tokens identical; WinFrame conditional handles the chrome difference.

**Naming note:** the existing Electron app's product name remains "Figaf Installer" for now; this rename to "Figaf Manager" applies to the BTP-hosted artifact and the new umbrella product framing. Rebranding the Electron build is a follow-up out of scope for this plan.

---

## 5. Verification

**Unit-level (local):**

1. `npm start` (Electron) — bit-identical to current `main`. Smoke test: deploy to a trial subaccount end-to-end.
2. `npm run cloud` — starts the CF server on `localhost:8080` with a stub HostAdapter using local `bin/btp` / `bin/cf`. Walk the wizard end-to-end against a trial subaccount. Confirm the deployment-zip download from GitHub fires when leaving `ScreenConfig`.
3. Mock-CLI mode: stub `cf` / `btp` with shell scripts that echo expected output; walk end-to-end without hitting BTP.

**Integration (staging subaccount, cockpit upload path):**

1. Build a release zip locally via `scripts/build-zip.js`; tag a pre-release on GitHub.
2. Sign into the BTP cockpit, navigate to the CF space, click **Deploy Application**, upload `figaf-manager-app-<pre-release>.zip` with **Deploy with: Manifest** and **Start application after deploy** ✔. **No XSUAA service instance to pre-create.**
3. Wait for `RUNNING` (~5–10 min). Click the route from the cockpit's Applications view → wizard renders directly (no XSUAA login redirect).
4. Run the deploy path inside the wizard:
   - At ScreenConfig → ScreenProgress, watch the Terminal Drawer for "Downloading deployment template..." and "Extracting...". Confirm `Figaf-BTP-Deployment-btp-users/` lands at `$HOME/deploy/`.
   - Confirm `cf create-service`, `cf push` of the figaf product, role assignment all stream into the Terminal Drawer over WSS.
5. On Done, the figaf URL is printed and clickable.
6. Click **Delete this manager app** → confirm `cf delete figaf-manager -f` runs, then the wizard tab stops responding (expected — the app is gone).
7. Repeat: re-upload the zip via cockpit, log in, complete a second deploy, confirm the cycle works.

**Concurrent-user verification:**

1. Two users hit the same manager app instance from different browsers.
2. Confirm cookie-based session isolation — User A's `cf login` does not affect User B's `cf` state (separate `CF_HOME` per session cookie).
3. Confirm both can run independent `cf push` operations to different orgs/spaces (if their authority allows it).

**Egress / mirror verification:**

1. With the default `FIGAF_DEPLOYMENT_ZIP_URL` (GitHub), confirm the deployment-zip download succeeds from a CF container.
2. Override `FIGAF_DEPLOYMENT_ZIP_URL` to a self-hosted mirror (e.g., a presigned S3 URL); restage; confirm the wizard fetches from the mirror instead.

**Trust-model verification:**

1. `cosign verify-blob --certificate ...zip.cert --signature ...zip.sig figaf-manager-app-<ver>.zip` succeeds against published signature.
2. The figaf.com download page shows the version, the SHA256, the cert/sig links, and a copy-pasteable verification command.
3. `--dry-run` mode in the manager app prints commands without side-effects; output matches the published command-surface document.
4. `git log -p` review of `figaf/figaf-manager` at the released tag shows nothing internal/credentialed.

**Regression bar:** `npm start` (Electron) still works locally; `npm run build:win` still produces a working NSIS installer. The refactor extracts shared logic without removing the Electron host.

---

## 6. Open questions / decisions before committing

1. **Cookie session lifetime + secret rotation.** Per-app-instance random secret is simple; if we ever scale to multiple instances we need a shared secret. For the wizard use-case (single instance, ephemeral) the simple form is fine — flag this when Phase 2 moves to a persistent multi-instance admin app.
2. **Deployment-zip download URL pinning.** Should the manager fetch a specific commit SHA or always the branch tip? Tip means customers always get the latest manifest fixes; pinning gives reproducibility. Default to tip with `FIGAF_DEPLOYMENT_ZIP_URL` override for IT teams that want pinning.
3. **Egress to github.com from the CF container.** Any landscape with strict egress rules will block the deployment-zip download. Document the requirement; the env-var override + a self-hosted mirror is the escape hatch.
4. **Cockpit upload size limit.** The Deploy Application dialog accepts zip/war/jar/ear, but the upload size limit is undocumented. With +80 MB of CLI binaries plus `node_modules` we land around 120–180 MB. If the cockpit caps uploads (some landscapes do, around 100 MB), we either trim node_modules with a custom buildpack that fetches deps at stage time, or fall back to download-on-stage for the CLIs (a stage-time `curl` of `bin/btp` and `bin/cf` from a Figaf-hosted URL or from `tools.hana.ondemand.com`).
5. **Manifest variable substitution via cockpit.** The `((domain))` placeholder works with `cf push --vars-file`, but the cockpit's Deploy Application path may not run vars substitution the same way. If it doesn't, we ship a manifest with the route line removed and let CF auto-assign the route on the customer's default domain. Verify in trial.
6. **Per-user CF state isolation.** Verify in implementation that no `cf` CLI command relies on hidden global state outside `CF_HOME`. If any does, we need to serialize per-user invocations or run a worker process per session.
7. **btp/cf binary licensing.** Confirm we can bundle the official `btp` CLI binary in our own distribution (vs. download-on-stage). The `eula_3_1_agreed=tools.hana.ondemand.com` cookie pattern in [bridge.js](main-process/bridge.js) hints at the licensing model. If bundling is forbidden, fall back to a stage-time download.
8. **Manage/update Phase 2 timing.** When does that ship? The "Figaf Manager" rename above sets up the framing — Phase 2 grows the same app into a persistent admin console (XSUAA-bound from the start, never restaged after binding because it ships with services in the manifest). Biggest open decision is whether to add a service-bound persistence layer (HANA / Object Store) for unattended ops in Phase 2.
9. **BAS as a tertiary path.** If a prospect already has SAP Business Application Studio, we could let them clone the repo and run a development copy inside BAS's terminal — useful for Figaf-internal dev, probably not worth promoting to customers since the cockpit upload path is already zero-install.

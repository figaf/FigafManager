# Figaf Installer

A Windows desktop wizard that deploys the [Figaf Tool](https://figaf.com) to your
**SAP BTP Cloud Foundry** subaccount in a few clicks — no manual CLI work, no PATH
gymnastics.

> Built as an Electron app. Wraps `btp` and `cf` CLIs, ships the BTP deployment
> templates, and walks you through prerequisites → login → service creation →
> `cf push` → ready-to-use URL.

---

## What it does

1. **Checks your environment** — looks for `btp` and `cf` CLIs, Docker Hub
   reachability, and free disk space. If a CLI is missing, downloads and installs
   it for you (kept under your user data folder, no admin rights, no PATH edits).
2. **Signs you in** — `btp login --sso` opens your browser, then we discover your
   landscape and run `cf login --sso` with the one-time passcode.
3. **Lets you choose** — *Deploy Figaf Tool* (default) or *Connect to Integration
   Suite* (planned).
4. **Configures the deployment** — auto-detects the apps domain, the latest
   `figaf/app` Docker tag, and the available PostgreSQL plans; you fill in the ID
   and pick a plan.
5. **Provisions services in parallel** — creates `figaf-db` (PostgreSQL),
   `figaf-xsuaa` (OAuth2/role scopes), and assigns the `PI_Administrator` role
   collection to your user.
6. **Pushes the app** — `cf push --vars-file vars.yml`, then opens the deployed
   URL once it's live.

A collapsible terminal drawer streams every CLI command in real time, so nothing is
hidden behind the GUI.

---

## Requirements

- Windows 10 / 11 (x64). The installer builds an NSIS package targeting Windows.
- An **SAP BTP** subaccount with a **Cloud Foundry** environment instance and
  permissions to create services and push apps.
- Internet access to:
  - `tools.hana.ondemand.com` (BTP CLI download)
  - `github.com/cloudfoundry/cli/releases` (CF CLI download)
  - `hub.docker.com` (image tag lookup + image pull)

> The installer downloads the BTP and CF CLIs for you on first run if they're not
> already present. You can also point it at an existing `.exe`/`.zip` via
> *Locate existing…*.

---

## Install (end users)

Download the latest `Figaf-Installer-<version>-x64.exe` from your release source
and run it. The NSIS installer offers per-user install with desktop and start-menu
shortcuts. Launch **Figaf Installer** and follow the wizard.

---

## Run from source (developers)

```sh
npm install
npm start
```

That launches the Electron app in dev mode (DevTools opens detached).

### Build a Windows installer

```sh
npm run build:win
```

Output lands in `dist/Figaf-Installer-<version>-x64.exe`. The build uses
`electron-builder` configured in [package.json](package.json); the BTP deployment
templates and `instructions.md` are bundled as `extraResources`.

### Project layout

```
figaf-installer/
├── main-process/                       Electron main + IPC bridge (Node)
│   ├── main.js                           BrowserWindow boot
│   ├── preload.js                        contextBridge → window.figaf
│   └── bridge.js                         CLI orchestration, downloads, file I/O
├── installer/                          Renderer (React 18 via CDN, no bundler)
│   ├── index.html
│   ├── app.jsx                           wizard state machine
│   ├── screens.jsx                       Welcome / Login / Choice / Config / Progress / Deploy / Done
│   ├── components.jsx                    shared primitives + frameless window chrome
│   └── styles.css, electron-app.css
├── Figaf-BTP-Deployment-btp-users/     bundled BTP deployment templates
│   ├── manifest.yml                      approuter + figaf-app
│   ├── vars.yml                          rewritten at runtime
│   ├── db.json, xs-security.json
│   └── approuter/                        @sap/approuter
├── BTP-CLI/                            btp CLI command reference
├── instructions.md                     manual CLI walkthrough (what the GUI automates)
├── CLAUDE.md                           architecture backbone (for AI assistants)
└── package.json                        electron + electron-builder config
```

For a deeper architectural reference (IPC surface, event channels, subprocess
invariants), see [CLAUDE.md](CLAUDE.md).

---

## Architecture at a glance

```
   user input  ─▶  Renderer (React)  ──IPC──▶  Main process (Node)  ──spawn──▶  btp / cf CLIs
                        ▲                          │                                │
                        └──── cli:line events ─────┘                                ▼
                                                                       SAP BTP Cloud Foundry
                                                                       (approuter → figaf-app
                                                                        + figaf-db + figaf-xsuaa)
```

The renderer never spawns a process; the main process never touches the DOM.
Everything between them is the `window.figaf` IPC surface defined in
[main-process/preload.js](main-process/preload.js).

---

## What's bundled vs. what's downloaded

- **Bundled with the installer**: BTP deployment templates
  ([Figaf-BTP-Deployment-btp-users/](Figaf-BTP-Deployment-btp-users/)) — `manifest.yml`,
  `vars.yml`, `db.json`, `xs-security.json`, and the approuter package.
- **Downloaded on first run if missing**: `btp` CLI, `cf` CLI. Stored under your
  user data folder; absolute paths persisted to `cliPaths.json`. PATH is never
  modified.

---

## Roadmap

- **Connect to Integration Suite** — the wizard already exposes the choice, but
  the flow is a placeholder. Will allow linking an existing Figaf deployment to an
  SAP Integration Suite tenant for tracking and testing.
- **PI/PO connectivity** — `figaf-connectivity` and `figaf-destination` services
  are reserved (commented out) in `manifest.yml` for cloud-connector-based PI/PO
  agent integration.

---

## License

Unlicensed (private). The bundled BTP deployment templates are © Figaf and
distributed under their original license — see
[Figaf-BTP-Deployment-btp-users/LICENSE](Figaf-BTP-Deployment-btp-users/LICENSE).

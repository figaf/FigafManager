# Connect to Integration Suite — design

**Date:** 2026-06-02
**Owner:** afl@figaf.com
**Branch:** main (no PR yet)

## 1. Goal

Grow the dormant "Connect to Integration Suite" tile in
`ScreenChoice` into a real two-step flow that:

1. Provisions two SAP **Integration Suite Runtime (`it-rt`)** service
   instances and their service keys in the targeted Cloud Foundry space, then
   shows each key JSON to the operator with a "Copy" button.
2. Asks the operator which BTP-access mode to use (4 options) and routes
   to a per-mode stub screen that future PRs will fill in.

The two underlying it-rt service param files (`figaf-api.json`,
`figaf-iflow.json`) ship inside the wizard — operator never edits them.

System ID + IS/CPI URL collection happens **inside the deployed Figaf
Tool**, not in this wizard, and is out of scope here.

Works in **both** apps (figaf-local and figaf-manager) — the connect flow has
no hosted/desktop asymmetry beyond what the host adapter already handles
(clipboard).

## 2. Wizard topology change

`packages/ui/app.jsx` currently declares:

```js
const connectSteps = [
  { id: "done", label: "Finish", sub: "Integration Suite setup" },
];
```

After this work:

```js
const connectSteps = [
  { id: "connect-provision",   label: "Provision",      sub: "it-rt · service keys" },
  { id: "connect-idp",         label: "BTP access",     sub: "Pick auth mode" },
  { id: "connect-idp-stub",    label: "Configure",      sub: "Mode-specific setup" },
  { id: "done",                label: "Finish",         sub: "Integration Suite linked" },
];
```

`connect-idp-stub` is a placeholder step-id resolved at render-time
inside `app.jsx`'s switch to one of four real screen components based
on `ctx.connect.idpMode`. The stepper rail shows a single "Configure"
entry regardless of which mode is picked — the choice happens inside
the wizard, the rail doesn't fork.

## 3. New wizard state slice

Added to `ctx` initial state in `app.jsx`:

```js
connect: {
  // Phase 1 — provisioning
  marketplaceOk: null,          // null | true | false   (it-rt entitlement probe)
  tasks: [
    { id: "create-api",    status: "pending", title: "Create it-rt/api service",            sub: "cf create-service it-rt api figaf-api" },
    { id: "create-iflow",  status: "pending", title: "Create it-rt/integration-flow service", sub: "cf create-service it-rt integration-flow figaf-iflow" },
    { id: "key-api",       status: "pending", title: "Create + fetch API service key",      sub: "cf create-service-key + cf service-key" },
    { id: "key-iflow",     status: "pending", title: "Create + fetch iFlow service key",    sub: "cf create-service-key + cf service-key" },
  ],
  keys: { api: null, iflow: null },   // each: { json: object, raw: string } — populated by screen, NOT serialized
  // Phase 2 — IDP mode
  idpMode: null,                       // "s-user" | "sap-passport" | "ias" | "custom-idp"
},
```

The parsed key JSONs live on `ctx.connect.keys` because the operator
needs them across re-renders of the Provision screen. They're cleared
when the user backs out to ScreenChoice.

## 4. New IPC handlers (`packages/core/orchestrator.js`)

### 4.1 `cf:createService` — already works, no change

Current implementation (line 1113) joins `configFile` to args
verbatim, then runs cf with `cwd: resolveDeployDir()`. `cf` itself
accepts both absolute and relative paths after `-c`. The connect screen
calls `cf:createService` with the absolute path it gets from
`connect:templatePath` (§4.2). No code change to this handler.

### 4.2 `connect:templatePath({ name })`

Returns the absolute path to a connect template inside `@figaf/core`.
Read-only, no IO beyond an existence check:

```js
async "connect:templatePath"({ name }) {
  const allowed = new Set(["figaf-api.json", "figaf-iflow.json"]);
  if (!allowed.has(name)) return { ok: false, error: "unknown template" };
  const p = path.join(__dirname, "connect-templates", name);
  return { ok: fs.existsSync(p), path: p };
}
```

Whitelist is hardcoded so the channel can't be coerced into reading
arbitrary paths.

### 4.3 `cf:createServiceKey({ service, key })`

```js
async "cf:createServiceKey"({ service, key }) {
  const r = await run(resolveCf(), ["create-service-key", service, key], { source: "cf" });
  const alreadyExists = /already exists/i.test(r.stdout + r.stderr);
  return { ok: r.code === 0 || alreadyExists, alreadyExists, stderr: r.stderr };
}
```

Same idempotency pattern as `cf:createService`.

### 4.4 `cf:serviceKey({ service, key })`

Reads a service key. cf prints a few prefix lines then a pretty JSON
block. The handler spawns cf directly (not via `run()`), buffers
**raw** stdout for JSON parsing, and **emits a redacted variant** to
the `cli:line` stream line by line as data arrives. The unredacted raw
stays in memory only.

Implementation outline:

```js
async "cf:serviceKey"({ service, key }) {
  return new Promise((resolve) => {
    const cfBin = resolveCf();
    log("cmd", "cmd", `${cfBin} service-key ${service} ${key}`);
    const proc = spawn(cfBin, ["service-key", service, key], { shell: false, windowsHide: true });
    let rawStdout = "", rawStderr = "";
    let lineRemainder = "";
    proc.stdout.on("data", (buf) => {
      const chunk = buf.toString();
      rawStdout += chunk;
      lineRemainder += chunk;
      const parts = lineRemainder.split(/\r?\n/);
      lineRemainder = parts.pop();
      for (const line of parts) log("cf", "line", redactServiceKeyLine(line));
    });
    proc.stderr.on("data", (buf) => {
      rawStderr += buf.toString();
      for (const line of buf.toString().split(/\r?\n/)) {
        if (line) log("cf", "err", redactServiceKeyLine(line));
      }
    });
    proc.on("close", (code) => {
      if (lineRemainder) log("cf", "line", redactServiceKeyLine(lineRemainder));
      if (code !== 0) return resolve({ ok: false, code, stderr: rawStderr });
      const jsonStart = rawStdout.indexOf("{");
      const jsonEnd   = rawStdout.lastIndexOf("}");
      if (jsonStart < 0 || jsonEnd <= jsonStart) {
        return resolve({ ok: false, error: "could not locate JSON in cf service-key output" });
      }
      try {
        const json = JSON.parse(rawStdout.slice(jsonStart, jsonEnd + 1));
        resolve({ ok: true, json, raw: rawStdout.slice(jsonStart, jsonEnd + 1) });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
    proc.on("error", (e) => resolve({ ok: false, error: e.message }));
  });
}
```

`redactServiceKeyLine(line)` is a small pure helper exported from a
new `packages/core/redact-service-key.js` module (so the existing
`apps/figaf-manager/cloud/redact.test.js` suite can target it
unit-style). Rules — case-insensitive line match; if the line contains
a marker key, replace its **value** segment with `"********"`:

- `clientsecret`, `client_secret`
- `clientid`, `client_id` (defense-in-depth — not strictly a secret
  but operators routinely treat it as one in audit logs)
- `tokenurl`, `token_url`
- `url` lines whose value embeds a `clientsecret` query param
- `password`
- Any `"key":` line beginning with `-----BEGIN`

Return shape: `{ ok: true, json: <parsed object>, raw: <unredacted JSON string> }`.

The raw string is needed by the UI's clipboard handler — the wire
travels post-XSUAA, same-origin RPC; the operator already has
authority to see this in the cockpit. We do **not** persist raw to
disk, and the audit log only ever sees the redacted form.

### 4.5 `cf:marketplaceCheck({ offering })`

Probes a service-offering's presence in the marketplace.

```js
async "cf:marketplaceCheck"({ offering }) {
  const r = await run(resolveCf(), ["marketplace", "-e", offering], { source: "cf" });
  // cf exits 0 even when the offering is missing in some versions; key off
  // a "Service offering '<x>' not found" string OR an empty plan table.
  const notFound = /not\s+found|no service offerings/i.test(r.stdout + r.stderr);
  return { ok: r.code === 0 && !notFound, offering, stderr: r.stderr };
}
```

### 4.6 `shell:writeClipboard({ text })`

A new server handler **and** HostAdapter method `writeClipboard(text)`.

- **Electron host:** `clipboard.writeText(text)` from the `electron`
  module — symmetric with the existing `readClipboard` impl.
- **Cloud host:** no-op returning `{ ok: false, error: "use browser API" }`.
  The browser shim in `cloud/client.js` short-circuits before reaching
  the server, calling `navigator.clipboard.writeText(text)` directly —
  so the cloud server handler is only there for shape symmetry.

## 5. New files

### 5.1 `packages/core/connect-templates/`

Move from `apps/figaf-manager/`:
- `packages/core/connect-templates/figaf-api.json`
- `packages/core/connect-templates/figaf-iflow.json`

Delete the originals. Verify `build-zip.js` ships these (it copies
`@figaf/core` wholesale, so it will).

### 5.2 `packages/ui/screens/screen-connect-provision.jsx`

Mirrors `ScreenProgress`'s pattern (mount-effect kicks off the work,
`mark(id, patch)` updates `ctx.connect.tasks`, allDone gates Next).
The 4-row checklist:
1. Create it-rt/api service (and poll until succeeded).
2. Create it-rt/integration-flow service (parallel).
3. Create + fetch key-api (after row 1 succeeds).
4. Create + fetch key-iflow (after row 2 succeeds).

Pre-flight: in the SAME mount effect, before launching the four rows,
call `cf:marketplaceCheck({ offering: "it-rt" })`. If it fails, render
a hard-stop card pointing to the SAP Integration Suite tenant page and
do NOT start the four rows. "Retry" re-runs the probe.

After all 4 rows are done, render the two key blocks side-by-side, each
in a card with:
- A read-only `<pre>` showing the JSON.
- A Copy button using `window.figaf.shell.writeClipboard(JSON.stringify(json))`.
- A "Copied!" badge that flips back after 2s.

WizardFooter's Next is enabled once allDone is true, regardless of
whether the operator has clicked Copy.

### 5.3 `packages/ui/screens/screen-connect-idp.jsx`

Four cards (radio-style — same `choice-grid` class ScreenChoice uses).
Picking one sets `ctx.connect.idpMode`. Next is disabled until set.

Cards (label / sub-text):
1. **S-User** — *Communication user; ideal for shared deployments. (Coming soon)*
2. **SAP Passport** — *Certificate-based; for managed SAP cloud customers. (Coming soon)*
3. **SAP User Identity Service** — *IAS-backed user federation. (Coming soon)*
4. **Custom IDP** — *Bring your own SAML IDP. (Coming soon)*

The "Coming soon" tag is rendered with the existing `pill` class so it's
visually clear these branches are placeholders.

### 5.4 Four per-mode stub screens

Each one is a thin shell:

```jsx
// screen-connect-idp-suser.jsx
function ScreenConnectIdpSuser({ ctx, setCtx, onBack, onNext }) {
  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step · BTP access · S-User</div>
          <h1 className="pane-title">S-User authentication — coming soon</h1>
          <p className="pane-desc">
            We're working on automating this path. For now, configure
            S-User access manually in the Figaf Tool and continue.
          </p>
        </div>
      </div>
      <WizardFooter onBack={onBack} onNext={onNext} nextLabel="Continue to finish" />
    </>
  );
}
Object.assign(window, { ScreenConnectIdpSuser });
```

`onNext` advances to the `done` step (the final entry in
`connectSteps`). When a future PR turns one of these stubs into a real
flow, it stays in-place — the new screen can replace the stub or
expand into its own multi-step branch by adding entries to
`connectSteps` and routing on `ctx.connect.idpMode`.

Same shape for `-passport`, `-ias`, `-custom`. Each one is its own
file so future implementers don't collide. The on-disk filenames map
1:1 to `ctx.connect.idpMode` values via a tiny switch in `app.jsx`:

```js
case "connect-idp-stub":
  switch (ctx.connect.idpMode) {
    case "s-user":       Screen = <ScreenConnectIdpSuser    .../>; break;
    case "sap-passport": Screen = <ScreenConnectIdpPassport .../>; break;
    case "ias":          Screen = <ScreenConnectIdpIas      .../>; break;
    case "custom-idp":   Screen = <ScreenConnectIdpCustom   .../>; break;
    default:             Screen = null;
  }
  break;
```

## 6. Surface plumbing

### 6.1 `apps/figaf-local/main-process/preload.js`

Append to existing namespaces:
```js
connect: {
  templatePath: (name) => ipcRenderer.invoke("connect:templatePath", { name }),
},
cf: {
  ...existing,
  createServiceKey: (a) => ipcRenderer.invoke("cf:createServiceKey", a),
  serviceKey:       (a) => ipcRenderer.invoke("cf:serviceKey", a),
  marketplaceCheck: (a) => ipcRenderer.invoke("cf:marketplaceCheck", a),
},
shell: {
  ...existing,
  writeClipboard:  (text) => ipcRenderer.invoke("shell:writeClipboard", { text }),
},
```

### 6.2 `apps/figaf-manager/cloud/client.js`

Same surface, RPC-flavored. **`shell.writeClipboard` is browser-side
only** — does `navigator.clipboard.writeText(text)`, never calls server.

### 6.3 `apps/figaf-local/main-process/host.electron.js` and `apps/figaf-manager/host.cloud.js`

Add `writeClipboard(text)` to both adapters. Electron implements via
`clipboard.writeText`; cloud returns `{ ok: false, error: "use browser" }`
which the server handler `shell:writeClipboard` surfaces but the browser
shim short-circuits before reaching.

### 6.4 Index.html shells

Add `<script>` tags for the 6 new screens in both:
- `packages/ui/index.html`
- `apps/figaf-manager/cloud/index.html`

## 7. Idempotency guarantees

- `cf create-service` already returns `alreadyExists` (line 1118).
- `cf create-service-key` — handler returns `alreadyExists` on the
  "already exists" stderr match.
- `cf service-key` — always called fresh; output reflects live state.
- A re-entry to the connect flow re-runs the 4 rows; "already exists"
  short-circuits each create. Keys are re-fetched and re-displayed.

## 8. Security & redaction

- Service-key payloads contain client secrets.
- The `cf:serviceKey` handler runs cf via spawn directly (not `run()`)
  so stdout can be redacted **before** `log("cf", "line", ...)` emits
  cli:line frames.
- The unredacted JSON travels back through the handler's return value
  only.
- The screen stores `keys.api` and `keys.iflow` in `ctx.connect.keys`.
  When the operator clicks Back to leave the connect flow, an
  `onBack` cleanup clears them: `setCtx(c => ({ ...c, connect: { ...c.connect, keys: { api: null, iflow: null } } }))`.
- No persistence to disk, no log, no audit-trail entry.

## 9. Out of scope (deferred to future PRs)

- The 4 IDP-mode implementations. Today's PR ships only the stub
  screens.
- Capturing System ID / IS URL in the wizard (the deployed Figaf Tool
  owns this).
- Unbinding / deleting the it-rt services from the wizard. If the
  operator wants to start over, they `cf delete-service` manually or
  via the cockpit — the wizard's job is one-way setup.
- Polling `it-rt` services until status: succeeded. Per discussion
  these instances provision near-instantly (unlike postgresql-db /
  xsuaa). If telemetry shows that's wrong, add `cf:pollService` calls
  in a follow-up.

## 10. Testing

This branch is a UI feature with thin orchestrator additions. There's
no end-to-end test harness for the wizard today. The implementation
plan will include:

- Unit-level: redaction function tests under
  `apps/figaf-manager/cloud/redact.test.js` (existing redaction-test
  file) — extend with samples of real `cf service-key` output.
- Manual: run the connect flow against a sandbox CF space that has
  it-rt entitlement and re-run it to confirm idempotency.
- Manual: run against a space without it-rt entitlement to confirm
  the pre-flight hard-stop renders.

## 11. File-level change summary

| File | Change |
|---|---|
| `packages/core/connect-templates/figaf-api.json` | **new** (moved) |
| `packages/core/connect-templates/figaf-iflow.json` | **new** (moved) |
| `apps/figaf-manager/figaf-api.json` | **deleted** |
| `apps/figaf-manager/figaf-iflow.json` | **deleted** |
| `packages/core/orchestrator.js` | add 4 new handlers (`connect:templatePath`, `cf:createServiceKey`, `cf:serviceKey`, `cf:marketplaceCheck`, `shell:writeClipboard`) + extend HostAdapter typedef for `writeClipboard` |
| `packages/core/redact-service-key.js` | **new** — pure helper used by `cf:serviceKey` |
| `apps/figaf-local/main-process/host.electron.js` | implement `writeClipboard` |
| `apps/figaf-manager/host.cloud.js` | stub `writeClipboard` |
| `apps/figaf-local/main-process/preload.js` | expose 4 new channels |
| `apps/figaf-manager/cloud/client.js` | expose 4 new channels; browser-side clipboard |
| `packages/ui/app.jsx` | new `ctx.connect`, expand `connectSteps`, route `connect-idp-stub` |
| `packages/ui/screens/screen-connect-provision.jsx` | **new** |
| `packages/ui/screens/screen-connect-idp.jsx` | **new** |
| `packages/ui/screens/screen-connect-idp-suser.jsx` | **new** stub |
| `packages/ui/screens/screen-connect-idp-passport.jsx` | **new** stub |
| `packages/ui/screens/screen-connect-idp-ias.jsx` | **new** stub |
| `packages/ui/screens/screen-connect-idp-custom.jsx` | **new** stub |
| `packages/ui/index.html` | add 6 `<script>` tags |
| `apps/figaf-manager/cloud/index.html` | add 6 `<script>` tags |

No changes to: `manifest.yml`, `xs-security.json`, `db.json`,
approuter, build-zip.js, deploy-templates package, Dockerfile.

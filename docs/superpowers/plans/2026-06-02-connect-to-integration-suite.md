# Connect to Integration Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the dormant "Connect to Integration Suite" tile in `ScreenChoice` into a working two-phase flow (provision two `it-rt` services + show their keys, then pick a BTP-access mode out of four stubs), working in both figaf-local (Electron) and figaf-manager (Cloud).

**Architecture:** UI orchestrates 4 cf operations as a checklist (same pattern as `ScreenProgress`). New thin orchestrator handlers (`cf:createServiceKey`, `cf:serviceKey`, `cf:marketplaceCheck`, `shell:writeClipboard`, `connect:templatePath`) added behind the existing HostAdapter contract. The 4 IDP modes fan out to 4 stub screens so future implementers don't collide.

**Tech Stack:** Node.js (no bundler in renderer), React 18 (Babel-standalone in browser), `cf` CLI, npm workspaces, `node --test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-06-02-connect-to-integration-suite-design.md`

---

## File map

**New:**
- `packages/core/connect-templates/figaf-api.json` — moved from `apps/figaf-manager/`
- `packages/core/connect-templates/figaf-iflow.json` — moved from `apps/figaf-manager/`
- `packages/core/redact-service-key.js` — pure helper, exports `redactServiceKeyLine(line)`
- `packages/core/redact-service-key.test.js` — `node --test` suite
- `packages/ui/screens/screen-connect-provision.jsx`
- `packages/ui/screens/screen-connect-idp.jsx`
- `packages/ui/screens/screen-connect-idp-suser.jsx`
- `packages/ui/screens/screen-connect-idp-passport.jsx`
- `packages/ui/screens/screen-connect-idp-ias.jsx`
- `packages/ui/screens/screen-connect-idp-custom.jsx`

**Deleted:**
- `apps/figaf-manager/figaf-api.json`
- `apps/figaf-manager/figaf-iflow.json`

**Modified:**
- `packages/core/orchestrator.js` — 4 new handlers + HostAdapter typedef extension
- `apps/figaf-local/main-process/host.electron.js` — implement `writeClipboard`
- `apps/figaf-manager/host.cloud.js` — stub `writeClipboard`
- `apps/figaf-local/main-process/preload.js` — expose 5 new channels
- `apps/figaf-manager/cloud/client.js` — expose 5 new channels (browser-side clipboard)
- `packages/ui/app.jsx` — new `ctx.connect`, expand `connectSteps`, route 4 IDP stubs
- `packages/ui/index.html` — `<script>` tags for 6 new screens
- `apps/figaf-manager/cloud/index.html` — `<script>` tags for 6 new screens

---

## Task 1: Move connect templates into `@figaf/core`

**Files:**
- Create: `packages/core/connect-templates/figaf-api.json`
- Create: `packages/core/connect-templates/figaf-iflow.json`
- Delete: `apps/figaf-manager/figaf-api.json`
- Delete: `apps/figaf-manager/figaf-iflow.json`

- [ ] **Step 1: Create the destination directory**

Run: `mkdir -p C:/Figaf-installer/packages/core/connect-templates`
Expected: command exits 0 (creates directory or is no-op if it already exists)

- [ ] **Step 2: Move `figaf-api.json` into the package**

Use the Bash tool:

```bash
mv C:/Figaf-installer/apps/figaf-manager/figaf-api.json \
   C:/Figaf-installer/packages/core/connect-templates/figaf-api.json
```

Expected: file disappears from `apps/figaf-manager/`, appears under `packages/core/connect-templates/`.

- [ ] **Step 3: Move `figaf-iflow.json` into the package**

```bash
mv C:/Figaf-installer/apps/figaf-manager/figaf-iflow.json \
   C:/Figaf-installer/packages/core/connect-templates/figaf-iflow.json
```

- [ ] **Step 4: Sanity-check the contents survived the move**

Read both files back. Expected:

`figaf-api.json`:
```json
{
    "roles": [
        "AccessAllAccessPoliciesArtifacts",
        "AuthGroup_Administrator",
        "AuthGroup_BusinessExpert",
        "AuthGroup_IntegrationDeveloper"
    ],
    "grant-types": [
        "client_credentials"
    ],
    "redirect-uris": [],
    "token-validity": 43200
}
```

`figaf-iflow.json`:
```json
{
    "roles": [
        "ESBMessaging.send"
    ],
    "grant-types": [
        "client_credentials"
    ],
    "redirect-uris": [],
    "token-validity": 3600
}
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/connect-templates/figaf-api.json \
        packages/core/connect-templates/figaf-iflow.json \
        apps/figaf-manager/figaf-api.json \
        apps/figaf-manager/figaf-iflow.json
git commit -m "chore(connect): move it-rt service params into @figaf/core/connect-templates

These JSONs are wizard-owned static inputs (not Figaf-Tool deploy
artifacts), so they belong with the orchestrator that consumes them
rather than inside one app. @figaf/core is symlinked into both apps
and is bundled by build-zip, so the cloud path picks them up
automatically.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

Expected: clean commit with 2 files renamed (git detects rename via similarity).

---

## Task 2: Pure redaction helper + tests

**Files:**
- Create: `packages/core/redact-service-key.js`
- Create: `packages/core/redact-service-key.test.js`

- [ ] **Step 1: Write the failing tests**

Create `C:/Figaf-installer/packages/core/redact-service-key.test.js`:

```javascript
"use strict";
// Tests for the per-line redaction helper used by the cf:serviceKey handler.
// Run via `node --test packages/core/redact-service-key.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { redactServiceKeyLine } = require("./redact-service-key");

test("redacts clientsecret JSON value", () => {
  const line = '  "clientsecret": "QqWeRtYuIoP1234567890",';
  const out = redactServiceKeyLine(line);
  assert.equal(out, '  "clientsecret": "********",');
});

test("redacts client_secret (snake_case) JSON value", () => {
  const line = '  "client_secret": "abc-def-123",';
  assert.equal(redactServiceKeyLine(line), '  "client_secret": "********",');
});

test("redacts clientid JSON value", () => {
  const line = '  "clientid": "sb-figaf-api!t12345",';
  assert.equal(redactServiceKeyLine(line), '  "clientid": "********",');
});

test("redacts tokenurl JSON value", () => {
  const line = '  "tokenurl": "https://example.authentication.eu10.hana.ondemand.com/oauth/token",';
  assert.equal(redactServiceKeyLine(line), '  "tokenurl": "********",');
});

test("redacts password JSON value", () => {
  const line = '  "password": "hunter2",';
  assert.equal(redactServiceKeyLine(line), '  "password": "********",');
});

test("redacts a PEM-style BEGIN line entirely", () => {
  const line = "-----BEGIN PRIVATE KEY-----";
  assert.equal(redactServiceKeyLine(line), "********");
});

test("redacts a URL containing a clientsecret query parameter", () => {
  const line = "  Visit https://example.com/cb?clientsecret=SECRETVALUE&state=ok";
  const out = redactServiceKeyLine(line);
  // Whole line is replaced because the value is embedded in a URL we can't
  // safely segment with the simple "value-of-key" rule.
  assert.equal(out, "********");
});

test("non-sensitive line passes through unchanged", () => {
  const line = "Getting key key-api for service instance figaf-api as you@example.com...";
  assert.equal(redactServiceKeyLine(line), line);
});

test("a JSON brace line passes through unchanged", () => {
  assert.equal(redactServiceKeyLine("{"), "{");
  assert.equal(redactServiceKeyLine("}"), "}");
});

test("case-insensitive match on key name", () => {
  const line = '  "ClientSecret": "MixedCase",';
  assert.equal(redactServiceKeyLine(line), '  "ClientSecret": "********",');
});

test("preserves leading whitespace", () => {
  const line = '      "clientsecret": "x",';
  assert.equal(redactServiceKeyLine(line), '      "clientsecret": "********",');
});

test("non-string input passes through", () => {
  assert.equal(redactServiceKeyLine(null), null);
  assert.equal(redactServiceKeyLine(undefined), undefined);
});
```

- [ ] **Step 2: Run the failing tests**

Run: `node --test C:/Figaf-installer/packages/core/redact-service-key.test.js`
Expected: every test fails with "Cannot find module './redact-service-key'".

- [ ] **Step 3: Implement the helper**

Create `C:/Figaf-installer/packages/core/redact-service-key.js`:

```javascript
"use strict";
// Per-line redactor used by the cf:serviceKey handler in orchestrator.js.
// Mutates an it-rt service-key JSON line by replacing sensitive values with
// "********" so the cli:line stream (which feeds the TerminalDrawer in the
// UI and the server-side audit log) never carries client secrets.
//
// The orchestrator handler still returns the UNREDACTED parsed JSON via its
// return value — that is what the screen displays + copies to clipboard.
// The redaction is per-line because the cf output is streamed line by line;
// matching on whole JSON would force buffering and break live progress.

// Marker keys: when one of these appears as a JSON key on the line, the
// value is masked. Case-insensitive substring match.
const SENSITIVE_KEYS = [
  "clientsecret",
  "client_secret",
  "clientid",
  "client_id",
  "tokenurl",
  "token_url",
  "password",
];

// Lines that should always be replaced wholesale (no safe partial redaction).
function shouldFullyMask(lower) {
  // PEM headers/footers and any URL that embeds a "clientsecret=" query param.
  if (/^[\s-]*-----BEGIN /.test(lower)) return true;
  if (/clientsecret=/.test(lower) || /client_secret=/.test(lower)) return true;
  return false;
}

function redactServiceKeyLine(line) {
  if (typeof line !== "string") return line;
  const lower = line.toLowerCase();
  if (shouldFullyMask(lower)) return "********";

  for (const key of SENSITIVE_KEYS) {
    if (!lower.includes(key)) continue;
    // Match: optional leading whitespace, "key" (case-insensitive), :, whitespace, "value", optional trailing punctuation.
    // The value can be quoted (most fields) or unquoted (e.g., booleans, numbers).
    const re = new RegExp(
      '("' + escapeRe(key) + '"\\s*:\\s*)"[^"]*"',
      "i"
    );
    if (re.test(line)) {
      return line.replace(re, '$1"********"');
    }
  }
  return line;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { redactServiceKeyLine };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test C:/Figaf-installer/packages/core/redact-service-key.test.js`
Expected: all 12 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/redact-service-key.js packages/core/redact-service-key.test.js
git commit -m "feat(core): add redact-service-key helper for cf:serviceKey output

Per-line redactor that masks client_secret/client_id/tokenurl/password
fields in the streamed JSON the cf service-key command emits. Used by
the upcoming cf:serviceKey handler so cli:line frames (which fan out
to the TerminalDrawer and audit log) never carry secrets. The handler
still returns the unredacted parsed JSON via its return value for the
screen's Copy-to-Clipboard payload.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add `connect:templatePath` handler

**Files:**
- Modify: `packages/core/orchestrator.js` (add handler near the existing `config:*` group)

- [ ] **Step 1: Add the handler**

Open `C:/Figaf-installer/packages/core/orchestrator.js`. Find the `config:deployDir` handler (around line 1182):

```javascript
    async "config:deployDir"() {
      return { path: await resolveDeployDir() };
    },
```

Insert directly after it:

```javascript
    // connect ──────────────────────────────────────────────────────────────────

    /**
     * Return the absolute path to a connect-flow template shipped with
     * @figaf/core. Whitelisted filenames only — the channel cannot be
     * coerced into reading arbitrary paths. The UI uses this to feed an
     * absolute path into cf:createService's -c argument.
     */
    async "connect:templatePath"({ name } = {}) {
      const allowed = new Set(["figaf-api.json", "figaf-iflow.json"]);
      if (!allowed.has(name)) return { ok: false, error: "unknown template" };
      const p = path.join(__dirname, "connect-templates", name);
      return { ok: fs.existsSync(p), path: p };
    },
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/orchestrator.js
git commit -m "feat(orchestrator): add connect:templatePath handler

Returns the absolute path to a whitelisted connect-flow template under
packages/core/connect-templates/. The UI feeds this absolute path into
cf:createService's configFile argument so the create-service command
sees a valid -c path no matter what cwd it runs in.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Add `cf:createServiceKey` handler

**Files:**
- Modify: `packages/core/orchestrator.js` (insert near other `cf:` service handlers)

- [ ] **Step 1: Add the handler**

Open `C:/Figaf-installer/packages/core/orchestrator.js`. Find the `cf:pollService` handler. Insert directly after it (right before `cf:push`):

```javascript
    async "cf:createServiceKey"({ service, key } = {}) {
      if (!service || !key) return { ok: false, error: "service and key required" };
      const r = await run(resolveCf(), ["create-service-key", service, key], { source: "cf" });
      const alreadyExists = /already exists/i.test(r.stdout + r.stderr);
      return { ok: r.code === 0 || alreadyExists, alreadyExists, stderr: r.stderr };
    },
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/orchestrator.js
git commit -m "feat(orchestrator): add cf:createServiceKey handler

Idempotent wrapper around cf create-service-key. Mirrors the
alreadyExists semantics of cf:createService so re-runs of the connect
flow don't blow up when the keys are already there.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Add `cf:serviceKey` handler with stdout redaction

**Files:**
- Modify: `packages/core/orchestrator.js` (insert after `cf:createServiceKey`)

- [ ] **Step 1: Add the import for the redactor**

Open `C:/Figaf-installer/packages/core/orchestrator.js`. Near the top of the file, after `const dbSchemas = require("./db-schemas");` (around line 9), add:

```javascript
const { redactServiceKeyLine } = require("./redact-service-key");
```

- [ ] **Step 2: Add the handler**

Insert directly after `cf:createServiceKey` (the handler from Task 4):

```javascript
    /**
     * Read a service key. cf prints a few prefix lines then a pretty-printed
     * JSON block (the service-key payload). We spawn cf directly (not via
     * run()) so we can route stdout through redactServiceKeyLine BEFORE the
     * cli:line frames are emitted — the TerminalDrawer and audit log only
     * ever see the redacted form. The unredacted JSON travels back to the
     * UI via this handler's return value so the screen can render +
     * copy-to-clipboard the real keys.
     *
     * Returns: { ok, json, raw } on success, { ok: false, error|stderr|code }
     * on failure. `raw` is the unredacted JSON substring (not the full
     * stdout) so the UI can copy a clean payload.
     */
    async "cf:serviceKey"({ service, key } = {}) {
      if (!service || !key) return { ok: false, error: "service and key required" };
      return new Promise((resolve) => {
        const cfBin = resolveCf();
        log("cmd", "cmd", `${cfBin} service-key ${service} ${key}`);
        const proc = spawn(cfBin, ["service-key", service, key], { shell: false, windowsHide: true });
        let rawStdout = "";
        let rawStderr = "";
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
          const chunk = buf.toString();
          rawStderr += chunk;
          for (const line of chunk.split(/\r?\n/)) {
            if (line) log("cf", "err", redactServiceKeyLine(line));
          }
        });
        proc.on("error", (e) => resolve({ ok: false, error: e.message }));
        proc.on("close", (code) => {
          if (lineRemainder) log("cf", "line", redactServiceKeyLine(lineRemainder));
          if (code !== 0) return resolve({ ok: false, code, stderr: rawStderr });
          const jsonStart = rawStdout.indexOf("{");
          const jsonEnd   = rawStdout.lastIndexOf("}");
          if (jsonStart < 0 || jsonEnd <= jsonStart) {
            return resolve({ ok: false, error: "could not locate JSON in cf service-key output" });
          }
          const slice = rawStdout.slice(jsonStart, jsonEnd + 1);
          try {
            const json = JSON.parse(slice);
            resolve({ ok: true, json, raw: slice });
          } catch (e) {
            resolve({ ok: false, error: "JSON parse failed: " + e.message });
          }
        });
      });
    },
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/orchestrator.js
git commit -m "feat(orchestrator): add cf:serviceKey handler with redacted streaming

Spawns cf service-key directly so each stdout/stderr line passes
through redactServiceKeyLine BEFORE emit as a cli:line frame. The
unredacted JSON is parsed from the buffered raw stdout and returned
via the handler's return value — the only path that ever carries
the real secret. The audit log and TerminalDrawer see only masked
values.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Add `cf:marketplaceCheck` handler

**Files:**
- Modify: `packages/core/orchestrator.js` (insert after the existing `cf:marketplacePostgresql` handler)

- [ ] **Step 1: Add the handler**

Open `C:/Figaf-installer/packages/core/orchestrator.js`. Find `cf:marketplacePostgresql` (around line 1099). Insert directly after it:

```javascript
    async "cf:marketplaceCheck"({ offering } = {}) {
      if (!offering) return { ok: false, error: "offering required" };
      const r = await run(resolveCf(), ["marketplace", "-e", offering], { source: "cf" });
      // cf v8 returns code 1 with a "Service offering 'X' not found." stderr
      // on a missing offering. cf v7 returns 0 with a "No service offerings
      // found" stdout line. Handle both.
      const blob = r.stdout + r.stderr;
      const notFound = /not\s+found|no service offerings found/i.test(blob);
      return { ok: r.code === 0 && !notFound, offering, stderr: r.stderr };
    },
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/orchestrator.js
git commit -m "feat(orchestrator): add cf:marketplaceCheck handler

Probes a service offering's presence in the marketplace. The connect
flow uses this as a pre-flight before running create-service so the
operator sees a clear 'no Integration Suite entitlement' message
instead of a ~30s create-service timeout.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Extend HostAdapter with `writeClipboard` + add `shell:writeClipboard` handler

**Files:**
- Modify: `packages/core/orchestrator.js` (typedef + new shell handler)
- Modify: `apps/figaf-local/main-process/host.electron.js` — implement it
- Modify: `apps/figaf-manager/host.cloud.js` — stub it

- [ ] **Step 1: Extend the HostAdapter JSDoc typedef**

Open `C:/Figaf-installer/packages/core/orchestrator.js`. Find the existing `readClipboard` line in the `@typedef HostAdapter` block (around line 41-43):

```javascript
 * @property {() => Promise<string>} readClipboard
 *   Return the system clipboard contents. Cloud: no-op (the browser shim
 *   uses navigator.clipboard).
```

Insert directly after it:

```javascript
 *
 * @property {(text: string) => Promise<{ ok: boolean, error?: string }>} writeClipboard
 *   Write `text` to the system clipboard. Electron: clipboard.writeText.
 *   Cloud: no-op returning { ok: false } — the cloud/client.js browser
 *   shim calls navigator.clipboard.writeText directly and never reaches
 *   the server handler.
```

- [ ] **Step 2: Add the `shell:writeClipboard` handler**

In the same file, find the `shell:readClipboard` handler (around line 2105). Insert directly after it (before the closing brace of the `handlers` object):

```javascript
    async "shell:writeClipboard"({ text } = {}) {
      if (typeof text !== "string") return { ok: false, error: "text must be a string" };
      try {
        const r = await host.writeClipboard(text);
        // host may return undefined for a successful write
        return r && typeof r === "object" ? r : { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
```

- [ ] **Step 3: Implement `writeClipboard` in the Electron host**

Open `C:/Figaf-installer/apps/figaf-local/main-process/host.electron.js`. Find the `readClipboard` method (line 76-78). Insert directly after it:

```javascript

    async writeClipboard(text) {
      clipboard.writeText(typeof text === "string" ? text : "");
      return { ok: true };
    },
```

- [ ] **Step 4: Stub `writeClipboard` in the Cloud host**

Open `C:/Figaf-installer/apps/figaf-manager/host.cloud.js`. Find the line `readClipboard:() => Promise.resolve(""),` (line 33). Replace that line with:

```javascript
    readClipboard:() => Promise.resolve(""),
    writeClipboard:() => Promise.resolve({ ok: false, error: "use browser API" }),
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/orchestrator.js \
        apps/figaf-local/main-process/host.electron.js \
        apps/figaf-manager/host.cloud.js
git commit -m "feat(host,orchestrator): add writeClipboard to HostAdapter contract

Symmetric to the existing readClipboard. Electron writes via the
clipboard module; the cloud host returns ok:false because the browser
shim in cloud/client.js bypasses the server and calls
navigator.clipboard.writeText directly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Expose the new channels in the Electron preload

**Files:**
- Modify: `apps/figaf-local/main-process/preload.js`

- [ ] **Step 1: Add `cf.createServiceKey`, `cf.serviceKey`, `cf.marketplaceCheck`**

Open `C:/Figaf-installer/apps/figaf-local/main-process/preload.js`. Find the `cf:` block. Inside it, locate the line:

```javascript
    pollService: (name) => ipcRenderer.invoke("cf:pollService", { name }),
```

Insert directly after it:

```javascript
    createServiceKey: (a) => ipcRenderer.invoke("cf:createServiceKey", a),
    serviceKey:       (a) => ipcRenderer.invoke("cf:serviceKey", a),
    marketplaceCheck: (a) => ipcRenderer.invoke("cf:marketplaceCheck", a),
```

- [ ] **Step 2: Add the `connect` namespace**

Find the closing brace of the `config:` block and the comma after it. Insert before the `shell:` block:

```javascript
  connect: {
    templatePath: (name) => ipcRenderer.invoke("connect:templatePath", { name }),
  },

```

- [ ] **Step 3: Add `shell.writeClipboard`**

Inside the `shell:` block, after `readClipboard: ...`, insert:

```javascript
    writeClipboard:  (text) => ipcRenderer.invoke("shell:writeClipboard", { text }),
```

- [ ] **Step 4: Commit**

```bash
git add apps/figaf-local/main-process/preload.js
git commit -m "feat(preload): expose connect/serviceKey/marketplaceCheck/writeClipboard

Adds the renderer-side surface for the new orchestrator handlers
that power the Connect-to-Integration-Suite flow.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Expose the new channels in the cloud browser shim

**Files:**
- Modify: `apps/figaf-manager/cloud/client.js`

- [ ] **Step 1: Add `cf.createServiceKey`, `cf.serviceKey`, `cf.marketplaceCheck`**

Open `C:/Figaf-installer/apps/figaf-manager/cloud/client.js`. Find the `cf:` block. After:

```javascript
      pollService:          function (name) { return rpc("cf:pollService", { name: name }); },
```

Insert:

```javascript
      createServiceKey:     function (a) { return rpc("cf:createServiceKey", a); },
      serviceKey:           function (a) { return rpc("cf:serviceKey", a); },
      marketplaceCheck:     function (a) { return rpc("cf:marketplaceCheck", a); },
```

- [ ] **Step 2: Add the `connect` namespace**

Find the line `config: {` (the start of the config block). Insert directly BEFORE it:

```javascript
    connect: {
      templatePath:         function (name) { return rpc("connect:templatePath", { name: name }); },
    },

```

- [ ] **Step 3: Override `shell.writeClipboard` browser-side**

In the `shell:` block, after `readClipboard: ...`, insert:

```javascript
      writeClipboard:  function (text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(String(text || "")).then(
            function () { return { ok: true }; },
            function (e) { return { ok: false, error: e && e.message }; }
          );
        }
        return Promise.resolve({ ok: false, error: "clipboard API unavailable" });
      },
```

The browser-side override means the server-side `shell:writeClipboard` handler is never reached from the cloud — but it stays in place for shape symmetry and as a fallback if a future client implementation needs it.

- [ ] **Step 4: Commit**

```bash
git add apps/figaf-manager/cloud/client.js
git commit -m "feat(cloud-client): expose connect/serviceKey/marketplaceCheck channels

Browser-side writeClipboard goes through navigator.clipboard.writeText
directly — never touches the server. The rest of the new surface
forwards to the orchestrator via /rpc.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Add `ctx.connect` state and expand `connectSteps` in `app.jsx`

**Files:**
- Modify: `packages/ui/app.jsx`

- [ ] **Step 1: Add `ctx.connect` to the initial state**

Open `C:/Figaf-installer/packages/ui/app.jsx`. Find the `update:` block in `setCtx` initial state (around line 76-90). Insert directly after it (just before the closing `}` of the `setCtx` initial state):

```javascript
    // Populated by the Connect-to-Integration-Suite branch (ScreenConnect*).
    // tasks: 4-row checklist driving ScreenConnectProvision.
    // keys: parsed service-key JSONs; cleared when the operator backs out.
    // idpMode: selected on ScreenConnectIdp, drives which stub renders next.
    connect: {
      marketplaceOk: null,
      tasks: [
        { id: "create-api",   status: "pending", title: "Create it-rt/api service",              sub: "cf create-service it-rt api figaf-api" },
        { id: "create-iflow", status: "pending", title: "Create it-rt/integration-flow service", sub: "cf create-service it-rt integration-flow figaf-iflow" },
        { id: "key-api",      status: "pending", title: "Create + fetch API service key",        sub: "cf create-service-key + cf service-key" },
        { id: "key-iflow",    status: "pending", title: "Create + fetch iFlow service key",      sub: "cf create-service-key + cf service-key" },
      ],
      keys: { api: null, iflow: null },
      idpMode: null,
    },
```

- [ ] **Step 2: Replace `connectSteps`**

Find:

```javascript
  const connectSteps = [
    { id: "done",     label: "Finish",             sub: "Integration Suite setup" },
  ];
```

Replace with:

```javascript
  const connectSteps = [
    { id: "connect-provision", label: "Provision",   sub: "it-rt · service keys" },
    { id: "connect-idp",       label: "BTP access",  sub: "Pick auth mode" },
    { id: "connect-idp-stub",  label: "Configure",   sub: "Mode-specific setup" },
    { id: "done",              label: "Finish",      sub: "Integration Suite linked" },
  ];
```

- [ ] **Step 3: Extend the `switch` to route the new step ids**

Find the `switch (STEPS[currentStep].id)` block (around line 166). Right BEFORE the existing `case "done":` line, insert:

```javascript
    case "connect-provision": Screen = <ScreenConnectProvision ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} appendLog={appendLog} />; break;
    case "connect-idp":       Screen = <ScreenConnectIdp ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
    case "connect-idp-stub":
      switch (ctx.connect && ctx.connect.idpMode) {
        case "s-user":       Screen = <ScreenConnectIdpSuser    ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
        case "sap-passport": Screen = <ScreenConnectIdpPassport ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
        case "ias":          Screen = <ScreenConnectIdpIas      ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
        case "custom-idp":   Screen = <ScreenConnectIdpCustom   ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
        default:             Screen = null;
      }
      break;
```

- [ ] **Step 4: Update the `/* global */` comment at the top of the file**

Find the existing `/* global React, ReactDOM, ... */` block (lines 1-5). Replace its 4th line:

```javascript
   ScreenXsuaaUpgrade, ScreenXsuaaAssignRole,
   ScreenUpdateConfig, ScreenUpdateProgress */
```

with:

```javascript
   ScreenXsuaaUpgrade, ScreenXsuaaAssignRole,
   ScreenUpdateConfig, ScreenUpdateProgress,
   ScreenConnectProvision, ScreenConnectIdp,
   ScreenConnectIdpSuser, ScreenConnectIdpPassport, ScreenConnectIdpIas, ScreenConnectIdpCustom */
```

- [ ] **Step 5: Commit**

```bash
git add packages/ui/app.jsx
git commit -m "feat(ui): wire connect flow into the wizard state machine

Adds ctx.connect (provision checklist, keys, idpMode), expands
connectSteps from a single 'done' entry to four real steps, and
routes the new step ids to the screens introduced in the next
commits. The stub-screen switch fan-out keeps the IDP-mode pick
inside the wizard while the stepper rail shows a single 'Configure'
entry.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: ScreenConnectProvision

**Files:**
- Create: `packages/ui/screens/screen-connect-provision.jsx`

- [ ] **Step 1: Write the screen**

Create `C:/Figaf-installer/packages/ui/screens/screen-connect-provision.jsx`:

```jsx
/* global React, Ico, CheckRow, WizardFooter */

const fgcp = () => (typeof window !== "undefined" && window.figaf) || null;

// ═══════════════════════════════════════════════════════════
// Connect · 1. Provision it-rt services + read service keys
// ═══════════════════════════════════════════════════════════
function ScreenConnectProvision({ ctx, setCtx, onNext, onBack }) {
  const tasks = ctx.connect.tasks;
  const allDone = tasks.every((t) => t.status === "done");
  const keys = ctx.connect.keys;
  const marketplaceOk = ctx.connect.marketplaceOk;
  const [started, setStarted] = React.useState(false);

  const mark = React.useCallback(
    (id, patch) =>
      setCtx((c) => ({
        ...c,
        connect: {
          ...c.connect,
          tasks: c.connect.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        },
      })),
    [setCtx]
  );

  const setKey = React.useCallback(
    (which, payload) =>
      setCtx((c) => ({
        ...c,
        connect: { ...c.connect, keys: { ...c.connect.keys, [which]: payload } },
      })),
    [setCtx]
  );

  // Clear keys when the operator backs out (so credentials don't linger in ctx).
  const handleBack = () => {
    setCtx((c) => ({
      ...c,
      connect: { ...c.connect, keys: { api: null, iflow: null } },
    }));
    onBack && onBack();
  };

  async function runFlow() {
    const api = fgcp();
    if (!api) return;
    setStarted(true);

    // Pre-flight: probe it-rt entitlement.
    const mk = await api.cf.marketplaceCheck({ offering: "it-rt" });
    if (!mk.ok) {
      setCtx((c) => ({ ...c, connect: { ...c.connect, marketplaceOk: false } }));
      return;
    }
    setCtx((c) => ({ ...c, connect: { ...c.connect, marketplaceOk: true } }));

    const apiTplP   = await api.connect.templatePath("figaf-api.json");
    const iflowTplP = await api.connect.templatePath("figaf-iflow.json");
    if (!apiTplP.ok || !iflowTplP.ok) {
      mark("create-api", { status: "error", sub: "missing connect template" });
      mark("create-iflow", { status: "error", sub: "missing connect template" });
      return;
    }

    // Create both services in parallel; chain each key creation off its
    // service's success so we don't try create-service-key against an
    // unprovisioned service.
    const apiChain = (async () => {
      mark("create-api", { status: "running" });
      const r1 = await api.cf.createService({
        offering: "it-rt", plan: "api", name: "figaf-api", configFile: apiTplP.path,
      });
      if (!r1.ok) { mark("create-api", { status: "error", sub: r1.stderr || "create-service failed" }); return; }
      mark("create-api", { status: "done", sub: r1.alreadyExists ? "already exists" : "created" });

      mark("key-api", { status: "running" });
      const r2 = await api.cf.createServiceKey({ service: "figaf-api", key: "key-api" });
      if (!r2.ok) { mark("key-api", { status: "error", sub: r2.stderr || "create-service-key failed" }); return; }
      const r3 = await api.cf.serviceKey({ service: "figaf-api", key: "key-api" });
      if (!r3.ok) { mark("key-api", { status: "error", sub: r3.error || r3.stderr || "service-key read failed" }); return; }
      setKey("api", { json: r3.json, raw: r3.raw });
      mark("key-api", { status: "done", sub: r2.alreadyExists ? "key already existed; refreshed" : "key created + fetched" });
    })();

    const iflowChain = (async () => {
      mark("create-iflow", { status: "running" });
      const r1 = await api.cf.createService({
        offering: "it-rt", plan: "integration-flow", name: "figaf-iflow", configFile: iflowTplP.path,
      });
      if (!r1.ok) { mark("create-iflow", { status: "error", sub: r1.stderr || "create-service failed" }); return; }
      mark("create-iflow", { status: "done", sub: r1.alreadyExists ? "already exists" : "created" });

      mark("key-iflow", { status: "running" });
      const r2 = await api.cf.createServiceKey({ service: "figaf-iflow", key: "key-iflow" });
      if (!r2.ok) { mark("key-iflow", { status: "error", sub: r2.stderr || "create-service-key failed" }); return; }
      const r3 = await api.cf.serviceKey({ service: "figaf-iflow", key: "key-iflow" });
      if (!r3.ok) { mark("key-iflow", { status: "error", sub: r3.error || r3.stderr || "service-key read failed" }); return; }
      setKey("iflow", { json: r3.json, raw: r3.raw });
      mark("key-iflow", { status: "done", sub: r2.alreadyExists ? "key already existed; refreshed" : "key created + fetched" });
    })();

    await Promise.all([apiChain, iflowChain]);
  }

  React.useEffect(() => {
    if (!started) runFlow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function retryProbe() {
    // Reset task rows + marketplaceOk and re-run.
    setCtx((c) => ({
      ...c,
      connect: {
        ...c.connect,
        marketplaceOk: null,
        tasks: c.connect.tasks.map((t) => ({ ...t, status: "pending", sub: t.sub })),
        keys: { api: null, iflow: null },
      },
    }));
    setStarted(false);
  }

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 4 · Provision</div>
          <h1 className="pane-title">
            {marketplaceOk === false ? "Integration Suite not entitled"
              : allDone ? "Service keys ready"
              : "Creating Integration Suite services…"}
          </h1>
          <p className="pane-desc">
            {marketplaceOk === false ? (
              <>
                The <span className="kbd">it-rt</span> service offering is not
                available in this subaccount. Subscribe to Integration Suite
                first, then retry.
              </>
            ) : allDone ? (
              <>Copy each key block into the matching field in the Figaf Tool.</>
            ) : (
              <>Provisioning <span className="kbd">figaf-api</span> and <span className="kbd">figaf-iflow</span> in <span className="kbd">{ctx.login.org || "?"} / {ctx.login.space || "?"}</span>.</>
            )}
          </p>
        </div>

        {marketplaceOk === false ? (
          <div className="card" style={{ padding: 18 }}>
            <p style={{ marginTop: 0 }}>
              Open the SAP cockpit and subscribe the <strong>Integration Suite</strong>
              tenant to this subaccount, then click Retry.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-primary" onClick={retryProbe}>
                Retry
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="card" style={{ padding: "4px 18px" }}>
              <div className="checklist">
                {tasks.map((t) => <CheckRow key={t.id} {...t} />)}
              </div>
            </div>

            {allDone && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 16 }}>
                <KeyCard label="API key (figaf-api / key-api)" keyData={keys.api} />
                <KeyCard label="iFlow key (figaf-iflow / key-iflow)" keyData={keys.iflow} />
              </div>
            )}
          </>
        )}
      </div>

      <WizardFooter
        onBack={handleBack}
        onNext={onNext}
        nextDisabled={!allDone || marketplaceOk === false}
        nextLabel={allDone ? "Continue to BTP access" : "Provisioning…"}
      />
    </>
  );
}

function KeyCard({ label, keyData }) {
  const [copied, setCopied] = React.useState(false);
  if (!keyData) return null;
  const text = keyData.raw || JSON.stringify(keyData.json, null, 2);
  async function copy() {
    const api = fgcp();
    if (!api) return;
    try {
      await api.shell.writeClipboard(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{label}</div>
        <button className="btn" onClick={copy}>
          <Ico.Copy /> {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre style={{
        margin: 0, maxHeight: 260, overflow: "auto",
        background: "var(--surface-2)", padding: 10, borderRadius: 6,
        fontSize: 11, lineHeight: 1.4,
      }}>
{text}
      </pre>
    </div>
  );
}

Object.assign(window, { ScreenConnectProvision });
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/screens/screen-connect-provision.jsx
git commit -m "feat(ui): add ScreenConnectProvision

Drives the 4-row CF service-provisioning checklist for the
Connect-to-Integration-Suite flow. Pre-flights it-rt entitlement,
parallelizes the two service+key chains, and renders the two key
JSONs side-by-side with Copy-to-Clipboard buttons after both chains
succeed. Idempotent on re-entry — already-exists short-circuits land
in the same 'done' bucket.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: ScreenConnectIdp (the 4-card picker)

**Files:**
- Create: `packages/ui/screens/screen-connect-idp.jsx`

- [ ] **Step 1: Write the screen**

Create `C:/Figaf-installer/packages/ui/screens/screen-connect-idp.jsx`:

```jsx
/* global React, Ico, WizardFooter */

// ═══════════════════════════════════════════════════════════
// Connect · 2. Pick BTP access mode
// ═══════════════════════════════════════════════════════════
function ScreenConnectIdp({ ctx, setCtx, onNext, onBack }) {
  const sel = ctx.connect.idpMode;
  function pick(v) {
    setCtx((c) => ({ ...c, connect: { ...c.connect, idpMode: v } }));
  }

  const modes = [
    {
      id: "s-user",
      icon: <Ico.User />,
      title: "S-User",
      desc: "Communication user; the simplest fit for shared deployments and most SAP customers.",
    },
    {
      id: "sap-passport",
      icon: <Ico.Shield />,
      title: "SAP Passport",
      desc: "Certificate-based authentication for SAP-managed cloud customers.",
    },
    {
      id: "ias",
      icon: <Ico.Cloud />,
      title: "SAP User Identity Service",
      desc: "Federate through your IAS tenant — single sign-on for the same users as the cockpit.",
    },
    {
      id: "custom-idp",
      icon: <Ico.Link />,
      title: "Custom IDP",
      desc: "Bring your own SAML/OIDC identity provider.",
    },
  ];

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 5 · BTP access</div>
          <h1 className="pane-title">How should Figaf authenticate against BTP?</h1>
          <p className="pane-desc">
            Pick the identity model that matches your subaccount. Each path
            will run a separate, mode-specific configuration step.
          </p>
        </div>

        <div className="choice-grid">
          {modes.map((m) => (
            <button
              key={m.id}
              className={`choice ${sel === m.id ? "selected" : ""}`}
              onClick={() => pick(m.id)}
            >
              <div className="choice-icon">{m.icon}</div>
              <div className="choice-title">
                {m.title}
                <span className="pill gray">Coming soon</span>
              </div>
              <div className="choice-desc">{m.desc}</div>
            </button>
          ))}
        </div>
      </div>

      <WizardFooter
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!sel}
        nextLabel={sel ? "Configure access" : "Choose a mode"}
      />
    </>
  );
}

Object.assign(window, { ScreenConnectIdp });
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/screens/screen-connect-idp.jsx
git commit -m "feat(ui): add ScreenConnectIdp — BTP access mode picker

Four-card chooser that sets ctx.connect.idpMode. The 'Coming soon'
pill on each card is intentional — the per-mode stub screens land
in the next commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Four IDP-mode stub screens

**Files:**
- Create: `packages/ui/screens/screen-connect-idp-suser.jsx`
- Create: `packages/ui/screens/screen-connect-idp-passport.jsx`
- Create: `packages/ui/screens/screen-connect-idp-ias.jsx`
- Create: `packages/ui/screens/screen-connect-idp-custom.jsx`

- [ ] **Step 1: Create `screen-connect-idp-suser.jsx`**

```jsx
/* global React, WizardFooter */

// ═══════════════════════════════════════════════════════════
// Connect · 3a. S-User stub (future PR replaces this)
// ═══════════════════════════════════════════════════════════
function ScreenConnectIdpSuser({ ctx, setCtx, onNext, onBack }) {
  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 6 · BTP access · S-User</div>
          <h1 className="pane-title">S-User authentication — coming soon</h1>
          <p className="pane-desc">
            We're working on automating this path. For now, configure
            S-User access manually inside the Figaf Tool and continue.
          </p>
        </div>
      </div>
      <WizardFooter onBack={onBack} onNext={onNext} nextLabel="Continue to finish" />
    </>
  );
}

Object.assign(window, { ScreenConnectIdpSuser });
```

- [ ] **Step 2: Create `screen-connect-idp-passport.jsx`**

```jsx
/* global React, WizardFooter */

// ═══════════════════════════════════════════════════════════
// Connect · 3b. SAP Passport stub (future PR replaces this)
// ═══════════════════════════════════════════════════════════
function ScreenConnectIdpPassport({ ctx, setCtx, onNext, onBack }) {
  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 6 · BTP access · SAP Passport</div>
          <h1 className="pane-title">SAP Passport — coming soon</h1>
          <p className="pane-desc">
            Certificate-based access for SAP-managed customers. We'll wire
            up certificate selection + binding here. For now, finish the
            setup manually in the Figaf Tool and continue.
          </p>
        </div>
      </div>
      <WizardFooter onBack={onBack} onNext={onNext} nextLabel="Continue to finish" />
    </>
  );
}

Object.assign(window, { ScreenConnectIdpPassport });
```

- [ ] **Step 3: Create `screen-connect-idp-ias.jsx`**

```jsx
/* global React, WizardFooter */

// ═══════════════════════════════════════════════════════════
// Connect · 3c. SAP User Identity Service stub (future PR replaces this)
// ═══════════════════════════════════════════════════════════
function ScreenConnectIdpIas({ ctx, setCtx, onNext, onBack }) {
  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 6 · BTP access · SAP User Identity Service</div>
          <h1 className="pane-title">SAP User Identity Service — coming soon</h1>
          <p className="pane-desc">
            IAS-backed federation: same identity as the cockpit. We'll wire
            up trust-bundle import + SAML mapping here. For now, configure
            it manually in the Figaf Tool and continue.
          </p>
        </div>
      </div>
      <WizardFooter onBack={onBack} onNext={onNext} nextLabel="Continue to finish" />
    </>
  );
}

Object.assign(window, { ScreenConnectIdpIas });
```

- [ ] **Step 4: Create `screen-connect-idp-custom.jsx`**

```jsx
/* global React, WizardFooter */

// ═══════════════════════════════════════════════════════════
// Connect · 3d. Custom IDP stub (future PR replaces this)
// ═══════════════════════════════════════════════════════════
function ScreenConnectIdpCustom({ ctx, setCtx, onNext, onBack }) {
  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 6 · BTP access · Custom IDP</div>
          <h1 className="pane-title">Custom IDP — coming soon</h1>
          <p className="pane-desc">
            Bring your own SAML/OIDC provider. We'll wire up metadata
            import + attribute mapping here. For now, configure your IDP
            manually in the Figaf Tool and continue.
          </p>
        </div>
      </div>
      <WizardFooter onBack={onBack} onNext={onNext} nextLabel="Continue to finish" />
    </>
  );
}

Object.assign(window, { ScreenConnectIdpCustom });
```

- [ ] **Step 5: Commit**

```bash
git add packages/ui/screens/screen-connect-idp-suser.jsx \
        packages/ui/screens/screen-connect-idp-passport.jsx \
        packages/ui/screens/screen-connect-idp-ias.jsx \
        packages/ui/screens/screen-connect-idp-custom.jsx
git commit -m "feat(ui): add 4 IDP-mode stub screens

Each stub is its own file so future PRs implementing one BTP access
mode (S-User / Passport / IAS / Custom IDP) don't collide on the
same file. The stubs all share the same shape today; when one grows
into a real flow it can either replace its file in place or expand
connectSteps to add follow-up screens.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Register the 6 new screens in both index.html shells

**Files:**
- Modify: `packages/ui/index.html`
- Modify: `apps/figaf-manager/cloud/index.html`

- [ ] **Step 1: Register in the Electron shell**

Open `C:/Figaf-installer/packages/ui/index.html`. Find the existing screen `<script>` tags. The current block (around lines 25-33) ends with:

```html
  <script type="text/babel" src="screens/screen-update.jsx"></script>
  <script type="text/babel" src="screens/screen-done.jsx"></script>
```

Replace those two lines with:

```html
  <script type="text/babel" src="screens/screen-update.jsx"></script>
  <script type="text/babel" src="screens/screen-connect-provision.jsx"></script>
  <script type="text/babel" src="screens/screen-connect-idp.jsx"></script>
  <script type="text/babel" src="screens/screen-connect-idp-suser.jsx"></script>
  <script type="text/babel" src="screens/screen-connect-idp-passport.jsx"></script>
  <script type="text/babel" src="screens/screen-connect-idp-ias.jsx"></script>
  <script type="text/babel" src="screens/screen-connect-idp-custom.jsx"></script>
  <script type="text/babel" src="screens/screen-done.jsx"></script>
```

- [ ] **Step 2: Register in the Cloud shell**

Open `C:/Figaf-installer/apps/figaf-manager/cloud/index.html`. Find the existing screen `<script>` tags (around lines 53-62). The end of that block reads:

```html
  <script type="text/babel" src="/installer/screens/screen-update.jsx"></script>
  <script type="text/babel" src="/installer/screens/screen-done.jsx"></script>
  <script type="text/babel" src="/installer/app.jsx"></script>
```

Replace those three lines with:

```html
  <script type="text/babel" src="/installer/screens/screen-update.jsx"></script>
  <script type="text/babel" src="/installer/screens/screen-connect-provision.jsx"></script>
  <script type="text/babel" src="/installer/screens/screen-connect-idp.jsx"></script>
  <script type="text/babel" src="/installer/screens/screen-connect-idp-suser.jsx"></script>
  <script type="text/babel" src="/installer/screens/screen-connect-idp-passport.jsx"></script>
  <script type="text/babel" src="/installer/screens/screen-connect-idp-ias.jsx"></script>
  <script type="text/babel" src="/installer/screens/screen-connect-idp-custom.jsx"></script>
  <script type="text/babel" src="/installer/screens/screen-done.jsx"></script>
  <script type="text/babel" src="/installer/app.jsx"></script>
```

- [ ] **Step 3: Commit**

```bash
git add packages/ui/index.html apps/figaf-manager/cloud/index.html
git commit -m "feat(ui): register 6 connect-flow screens in both shell HTMLs

The connect-flow screens are loaded via separate <script> tags in
both the Electron file:// shell and the cloud http:// shell so the
no-bundler renderer can find them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Verify the existing test suites still pass

**Files:**
- (verification only — no edits)

- [ ] **Step 1: Run the redaction tests**

Run: `node --test C:/Figaf-installer/packages/core/redact-service-key.test.js`
Expected: all tests pass.

- [ ] **Step 2: Run the cloud test suites**

Run: `node --test C:/Figaf-installer/apps/figaf-manager/cloud/`
Expected: all existing suites still pass (we didn't touch them; this catches accidental regressions from the orchestrator changes).

- [ ] **Step 3: Verify the build-zip flow still works for the cloud zip**

Run: `npm --workspace apps/figaf-manager run build-zip`
Expected: a `dist/figaf-manager-app-*.zip` file is produced and the staging shows `node_modules/@figaf/core/connect-templates/figaf-api.json` and `figaf-iflow.json` inside.

If any test or the build fails, stop and fix the regression in the relevant task before continuing.

- [ ] **Step 4: Quick smoke-list of the renderer entry points**

Using Glob, confirm all 6 new screen files exist:
- `packages/ui/screens/screen-connect-provision.jsx`
- `packages/ui/screens/screen-connect-idp.jsx`
- `packages/ui/screens/screen-connect-idp-suser.jsx`
- `packages/ui/screens/screen-connect-idp-passport.jsx`
- `packages/ui/screens/screen-connect-idp-ias.jsx`
- `packages/ui/screens/screen-connect-idp-custom.jsx`

Expected: 6 hits.

---

## Task 16: Manual verification checklist (cannot be automated)

The wizard's renderer has no end-to-end harness — the final pass is a manual walkthrough recorded as a checklist comment on the PR or as session notes. Do **not** mark this task done without a real cf-logged-in environment.

- [ ] **Step 1: Manual smoke — figaf-local**

From a workspace with `npm install` already run:

```bash
npm --workspace apps/figaf-local run start
```

Walk: Welcome → Login (sign in with btp+cf SSO) → Choose action → Connect to Integration Suite.

Confirm:
1. ScreenConnectProvision mounts and the 4-row checklist progresses.
2. If the subaccount has it-rt: all 4 rows go green, two KeyCards render with the JSON payloads, Copy button puts the payload on the system clipboard.
3. If the subaccount does NOT have it-rt: the marketplace pre-flight card renders instead and Retry re-runs the probe.
4. The TerminalDrawer shows the cf service-key lines with the secret values redacted as `********`.
5. Next button advances to ScreenConnectIdp.
6. Picking any of the 4 modes routes to that mode's stub screen, and "Continue to finish" lands on ScreenDone.

- [ ] **Step 2: Manual smoke — figaf-manager**

```bash
npm --workspace apps/figaf-manager run build-zip
```

Upload the resulting zip to a CF space and walk the same path in the browser. Confirm everything in Step 1 plus:
- Copy button uses `navigator.clipboard.writeText` (look for the `/rpc/shell:writeClipboard` call to NOT appear in the network tab).

- [ ] **Step 3: Commit nothing — record findings in the PR description**

If both walkthroughs pass, mark this task done and announce verification-before-completion gate cleared. If something is off, file a fix and add a task here.

---

## Self-review

**Spec coverage:**
- §1 Goal: tasks 10–14 wire the screens and state.
- §2 Wizard topology change: task 10.
- §3 New wizard state slice: task 10 step 1.
- §4.1 cf:createService no change: explicit in spec, no task needed.
- §4.2 connect:templatePath: task 3.
- §4.3 cf:createServiceKey: task 4.
- §4.4 cf:serviceKey with redaction: task 5; redaction helper + tests: task 2.
- §4.5 cf:marketplaceCheck: task 6.
- §4.6 shell:writeClipboard + HostAdapter: task 7.
- §5.1 connect-templates move: task 1.
- §5.2 ScreenConnectProvision: task 11.
- §5.3 ScreenConnectIdp: task 12.
- §5.4 Four stubs: task 13.
- §6.1 preload.js: task 8.
- §6.2 cloud client.js: task 9.
- §6.3 host adapters: task 7.
- §6.4 index.html shells: task 14.
- §7 Idempotency: covered by the alreadyExists handling in tasks 4–5 and the screen logic in task 11.
- §8 Security/redaction: tasks 2 + 5 + the back-button cleanup in task 11.
- §9 Out of scope: explicitly deferred, no tasks.
- §10 Testing: redaction unit tests (task 2) + verification task 15 + manual task 16.
- §11 File-level change summary: matches the 16 tasks above.

**Placeholder scan:** No "TBD", "TODO", or "fill in details" in the plan. Every step has the exact code or command.

**Type/name consistency:**
- `redactServiceKeyLine` — defined in task 2, used in task 5. ✓
- `ScreenConnectProvision` / `ScreenConnectIdp` / `ScreenConnectIdpSuser` / `…Passport` / `…Ias` / `…Custom` — defined in tasks 11–13, referenced in task 10 (switch) and task 14 (script tags). ✓
- `ctx.connect.tasks` row ids: `create-api`, `create-iflow`, `key-api`, `key-iflow` — used consistently in tasks 10 + 11. ✓
- `ctx.connect.idpMode` values: `s-user`, `sap-passport`, `ias`, `custom-idp` — used consistently in tasks 10 (switch), 12 (picker), 13 (stub headers via setCtx don't reference them by name but pickup is correct). ✓
- `api.connect.templatePath`, `api.cf.createServiceKey`, `api.cf.serviceKey`, `api.cf.marketplaceCheck`, `api.shell.writeClipboard` — wired in tasks 8 + 9, called in task 11. ✓
- Whitelisted template names: `figaf-api.json`, `figaf-iflow.json` — task 1 puts them in place, task 3 whitelists them, task 11 requests them by name. ✓

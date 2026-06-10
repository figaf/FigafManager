# BTP Login Global-Account Picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move BTP global-account (GA) selection out of the blind `btp login` prompt into a `btp target --hierarchy true` tree picker that shows each GA's subaccounts and navigates by index, fixing the "can't re-pick a GA after sign-out" and "indistinguishable same-named GAs" bugs.

**Architecture:** A new pure parser (`packages/core/btp-target.js`) turns the `btp target` tree text into `{ accounts, currentIndex }`. The orchestrator gains a `runTargetHierarchy` helper and a `btp:listGlobalAccounts` handler; `btp:loginStart` auto-answers the login GA prompt with `1` (throwaway "land somewhere") then delegates to the tree picker; `btp:selectGlobalAccount` switches from `{subdomain}` to `{index}`. The React login screen renders GA cards with their subaccounts, shows the chosen GA atop the subaccount step, and gains a "Back" button.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert/strict` with a fake-`spawn` harness, React-on-`window` (no bundler), Electron (figaf-local) + Express/WS (figaf-manager).

**Spec:** `docs/superpowers/specs/2026-06-10-btp-login-global-account-picker-design.md`

**Verified CLI facts (live, btp v2.106.1):**
- `btp target --hierarchy true` prints the full tree even when global config `--target.hierarchy` is `false` (per-invocation flag works).
- GA rows: `   [1] 17b44102trial (global account)`. Subaccount rows: `   [2]  └─ trial (subaccount)` (box-drawing prefix `├─`/`└─`). Indices are globally sequential.
- The prompt `Choose, or hit ENTER to stay in 'X' [6]>` reveals the current target's index.
- Spawning `btp target --hierarchy true` and writing `"<index>" + os.EOL` to stdin targets that node and exits 0 (verified `9` vs `6` → `figafaps-03` vs `figafaps-02`).

**Run tests from the workspace root** (`c:\Figaf-installer`), so `@figaf/core` resolves via the npm-workspaces symlink.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/core/btp-target.js` | Pure parser for `btp target --hierarchy true` output | **Create** |
| `packages/core/btp-target.test.js` | Unit tests for the parser | **Create** |
| `packages/core/orchestrator.js` | `runTargetHierarchy` helper, `btp:listGlobalAccounts`, reworked `btp:selectGlobalAccount` / `btp:loginStart` / `btp:cancelLogin`, `listEnvInstances` payload | **Modify** |
| `apps/figaf-manager/cloud/orchestrator-btp-login.test.js` | Integration tests (fake-spawn) for the reworked handlers | **Create** |
| `apps/figaf-local/main-process/preload.js` | `window.figaf.btp` IPC surface (Electron) | **Modify** |
| `apps/figaf-manager/cloud/client.js` | `window.figaf.btp` IPC surface (cloud) | **Modify** |
| `packages/ui/screens/screen-login.jsx` | GA picker (with subaccounts), subaccount picker (GA header + Back), Cancel only at GA level | **Modify** |

---

## Task 1: Pure tree parser (`packages/core/btp-target.js`)

**Files:**
- Create: `packages/core/btp-target.js`
- Test: `packages/core/btp-target.test.js`

- [ ] **Step 1: Write the failing test**

Create `packages/core/btp-target.test.js`:

```js
"use strict";
// Pure-logic tests for the `btp target --hierarchy true` parser. No CLI, no I/O.
// Run via `node --test packages/core/btp-target.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseGlobalAccountTree } = require("./btp-target");

const SAMPLE = [
  "Current target:",
  " Figaf ApS (global account, subdomain: figafaps-02)",
  "",
  "Choose global account, subaccount, or directory:",
  "   [1] 17b44102trial (global account)",
  "   [2]  └─ trial (subaccount)",
  "",
  "   [3] 9c492946trial (global account)",
  "   [4]  ├─ account2 (subaccount)",
  "   [5]  └─ trial (subaccount)",
  "",
  "   [6] Figaf ApS (global account)",
  "   [7]  ├─ demotest (subaccount)",
  "   [8]  └─ figafpartner (subaccount)",
  "",
  "   [9] Figaf ApS (global account)",
  "  [10]  ├─ demoprod (subaccount)",
  "  [11]  ├─ Freetier (subaccount)",
  "  [12]  └─ freetieraws (subaccount)",
  "Choose, or hit ENTER to stay in 'Figaf ApS' [6]> ",
].join("\n");

test("parses every global account in order", () => {
  const { accounts } = parseGlobalAccountTree(SAMPLE);
  assert.equal(accounts.length, 4);
  assert.deepEqual(accounts.map((a) => a.index), [1, 3, 6, 9]);
  assert.deepEqual(accounts.map((a) => a.name), ["17b44102trial", "9c492946trial", "Figaf ApS", "Figaf ApS"]);
});

test("attaches subaccounts to their parent GA with tree chars stripped", () => {
  const { accounts } = parseGlobalAccountTree(SAMPLE);
  const ga9 = accounts.find((a) => a.index === 9);
  assert.deepEqual(ga9.subaccounts.map((s) => s.index), [10, 11, 12]);
  assert.deepEqual(ga9.subaccounts.map((s) => s.name), ["demoprod", "Freetier", "freetieraws"]);
  const ga1 = accounts.find((a) => a.index === 1);
  assert.deepEqual(ga1.subaccounts, [{ index: 2, name: "trial" }]);
});

test("captures the current target index from the prompt", () => {
  assert.equal(parseGlobalAccountTree(SAMPLE).currentIndex, 6);
});

test("ignores the Current target / Now targeting summary lines", () => {
  const { accounts } = parseGlobalAccountTree(SAMPLE);
  // 'Figaf ApS (global account, subdomain: figafaps-02)' has no [N] and must not become an account.
  assert.ok(accounts.every((a) => Number.isInteger(a.index)));
  assert.equal(accounts.length, 4);
});

test("strips ANSI escapes before parsing", () => {
  const withAnsi = "\x1b[1m   [1] MyGA (global account)\x1b[0m\nChoose, or hit ENTER to stay in 'MyGA' [1]> ";
  const { accounts, currentIndex } = parseGlobalAccountTree(withAnsi);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].name, "MyGA");
  assert.equal(currentIndex, 1);
});

test("returns empty accounts and null currentIndex on garbage", () => {
  const r = parseGlobalAccountTree("nothing useful here");
  assert.deepEqual(r.accounts, []);
  assert.equal(r.currentIndex, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test packages/core/btp-target.test.js`
Expected: FAIL — `Cannot find module './btp-target'`.

- [ ] **Step 3: Write the parser**

Create `packages/core/btp-target.js`:

```js
"use strict";
// Pure parser for `btp target --hierarchy true` output. No CLI, no I/O.
// The tree lists every reachable global account (GA) and its subaccounts with
// globally-sequential [N] indices; GA navigation is by index — the only thing
// that disambiguates same-named GAs (e.g. two "Figaf ApS"). See
// docs/superpowers/specs/2026-06-10-btp-login-global-account-picker-design.md

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
// A tree row: optional indent, [N], optional box-drawing prefix, name, "(type)".
const ROW_RE = /^\s*\[(\d+)\]\s+(.*?)\s+\((global account|subaccount|directory)\)\s*$/;
// The trailing prompt reveals the current target's index: "... [6]>".
const CURRENT_RE = /hit ENTER to stay in '[^']*'\s*\[(\d+)\]/;

function cleanText(raw) {
  return String(raw || "").replace(ANSI_RE, "").replace(/\r/g, "");
}

// Remove leading box-drawing chars (│ ├ └ ─) and whitespace from a subaccount name.
function stripTreeChars(s) {
  return s.replace(/^[\s│├└─]+/, "").trim();
}

// Parse raw `btp target --hierarchy true` stdout.
// Returns { accounts: [{ index, name, subaccounts: [{ index, name }] }], currentIndex }.
function parseGlobalAccountTree(raw) {
  const text = cleanText(raw);
  const accounts = [];
  let current = null;
  let currentIndex = null;

  for (const line of text.split("\n")) {
    const cm = CURRENT_RE.exec(line);
    if (cm) currentIndex = Number(cm[1]);

    const m = ROW_RE.exec(line);
    if (!m) continue;
    const index = Number(m[1]);
    const type = m[3];
    if (type === "global account") {
      current = { index, name: m[2].trim(), subaccounts: [] };
      accounts.push(current);
    } else if (type === "subaccount") {
      if (current) current.subaccounts.push({ index, name: stripTreeChars(m[2]) });
    }
    // "directory" rows are intentionally ignored.
  }
  return { accounts, currentIndex };
}

module.exports = { parseGlobalAccountTree, cleanText };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test packages/core/btp-target.test.js`
Expected: PASS — 6 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add packages/core/btp-target.js packages/core/btp-target.test.js
git commit -m "feat(core): add btp target hierarchy tree parser" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Orchestrator `runTargetHierarchy` + `btp:listGlobalAccounts`

**Files:**
- Modify: `packages/core/orchestrator.js`
- Create: `apps/figaf-manager/cloud/orchestrator-btp-login.test.js`

- [ ] **Step 1: Write the failing test (creates the shared integration harness)**

Create `apps/figaf-manager/cloud/orchestrator-btp-login.test.js`:

```js
"use strict";
// Integration tests for the reworked BTP login / global-account flow.
// Harness mirrors orchestrator-restage.test.js: patch child_process.spawn with a
// programmable stub BEFORE requiring @figaf/core. Interactive procs (btp login /
// btp target) record stdin writes and close only AFTER the orchestrator answers
// the prompt, modelling the real CLI handshake.
// Run: node --test apps/figaf-manager/cloud/orchestrator-btp-login.test.js

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const child_process = require("child_process");
const EventEmitter = require("events");

const originalSpawn = child_process.spawn;
const spawnCalls = [];
let responses = []; // [{ match, stdout, stderr, code, interactive?, afterStdin? }]

function popResponse(args) {
  for (let i = 0; i < responses.length; i++) {
    const r = responses[i];
    if (!r.match || r.match(args)) { responses.splice(i, 1); return r; }
  }
  return { stdout: "", stderr: "", code: 0 };
}

function fakeSpawn(cmd, args, opts) {
  const resp = popResponse(args);
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  const stdinData = [];
  proc.stdin = {
    write: (s) => {
      stdinData.push(String(s));
      // Interactive procs proceed + close once the prompt is answered.
      if (resp.interactive) {
        setImmediate(() => {
          if (resp.afterStdin) proc.stdout.emit("data", Buffer.from(resp.afterStdin));
          proc.emit("close", resp.code || 0);
        });
      }
      return true;
    },
    end: () => {},
  };
  spawnCalls.push({ cmd, args: args.slice(), opts, proc, stdinData });
  setImmediate(() => {
    if (resp.stdout) proc.stdout.emit("data", Buffer.from(resp.stdout));
    if (resp.stderr) proc.stderr.emit("data", Buffer.from(resp.stderr));
    // Non-interactive procs close immediately (like `run()` consumers).
    if (!resp.interactive) proc.emit("close", resp.code || 0);
  });
  return proc;
}

child_process.spawn = fakeSpawn;
const { createOrchestrator } = require("@figaf/core");
process.on("exit", () => { child_process.spawn = originalSpawn; });

beforeEach(() => { spawnCalls.length = 0; responses.length = 0; });

function makeHost() {
  return {
    isHosted: true,
    resolveBinary: (name) => `/fake/path/${name}`,
    getUserDataDir: () => "/tmp/figaf-fake",
    pickFile: async () => null,
    openExternal: async () => {},
    readClipboard: async () => "",
  };
}
function makeSend() {
  const events = [];
  return { fn: (channel, payload) => events.push({ channel, payload }), events };
}
// loginStart returns before its background proc chain finishes; settle drains it.
async function settle() { await new Promise((r) => setTimeout(r, 40)); }

const SAMPLE_TREE = [
  "Current target:",
  " Figaf ApS (global account, subdomain: figafaps-02)",
  "",
  "Choose global account, subaccount, or directory:",
  "   [1] 17b44102trial (global account)",
  "   [2]  └─ trial (subaccount)",
  "",
  "   [6] Figaf ApS (global account)",
  "   [7]  ├─ demotest (subaccount)",
  "   [8]  └─ figafpartner (subaccount)",
  "",
  "   [9] Figaf ApS (global account)",
  "  [10]  ├─ demoprod (subaccount)",
  "  [11]  └─ freetieraws (subaccount)",
  "Choose, or hit ENTER to stay in 'Figaf ApS' [6]> ",
].join("\n");

// ─── tests ───────────────────────────────────────────────────────────────────

test("btp:listGlobalAccounts parses the tree and emits btp:gaChoice", async () => {
  responses.push({ match: (a) => a[0] === "target", interactive: true, stdout: SAMPLE_TREE, code: 0 });
  const send = makeSend();
  const orch = createOrchestrator({ host: makeHost(), send: send.fn });
  await orch.handlers["btp:listGlobalAccounts"]();

  const ga = send.events.find((e) => e.channel === "btp:gaChoice");
  assert.ok(ga, "gaChoice emitted");
  assert.deepEqual(ga.payload.accounts.map((a) => a.index), [1, 6, 9]);
  const ga9 = ga.payload.accounts.find((a) => a.index === 9);
  assert.deepEqual(ga9.subaccounts.map((s) => s.name), ["demoprod", "freetieraws"]);

  // Stayed on the current index (6) — read-only enumeration must not re-target.
  const targetCall = spawnCalls.find((c) => c.args[0] === "target");
  assert.equal(targetCall.stdinData.join("").trim(), "6");
  assert.deepEqual(targetCall.args, ["target", "--hierarchy", "true"]);
});
```

(The single-GA auto-select case is tested in Task 3, since it depends on `btp:selectGlobalAccount`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test apps/figaf-manager/cloud/orchestrator-btp-login.test.js`
Expected: FAIL — `orch.handlers["btp:listGlobalAccounts"] is not a function`.

- [ ] **Step 3: Add the require, state fields, helper, and handler**

In `packages/core/orchestrator.js`:

(a) After the `saml-connect` require block (currently ending at line 19), add:

```js
const { parseGlobalAccountTree } = require("./btp-target");
```

(b) In the `state` object (currently lines 82-103), add two fields next to `subaccountList`:

```js
    subaccountList: null,
    gaTree: null,
    globalAccountName: null,
```

(c) Immediately before the `// ─── handlers ───` comment (currently line 485), add the helper:

```js
  // Spawn `btp target --hierarchy true`, wait for the interactive prompt, parse
  // the tree, then write `chooseIndex` to stdin so the CLI targets that node and
  // exits 0. `chooseIndex` is a number, or a fn(parsed) -> number (e.g. stay on
  // the current target). Resolves { code, parsed }. This is the same long-lived
  // proc + stdin mechanism btp login uses; verified against btp v2.106.1.
  function runTargetHierarchy(chooseIndex) {
    return new Promise((resolve) => {
      const btpBin = resolveBtp();
      const args = ["target", "--hierarchy", "true"];
      log("cmd", "cmd", `${btpBin} ${args.join(" ")}`);
      const proc = spawn(btpBin, args, { shell: false, windowsHide: true });
      const ansiRe = /\x1b\[[0-9;?]*[a-zA-Z]/g;
      let clean = "";
      let parsed = null;
      let wrote = false;

      const onData = (buf) => {
        const text = buf.toString();
        clean += text.replace(ansiRe, "").replace(/\r(?!\n)/g, "\n");
        for (const raw of text.split(/\r\n|\n/)) {
          const line = raw.replace(ansiRe, "").replace(/\r/g, "").trim();
          if (line.length) log("btp", "line", line);
        }
        if (!wrote && /hit ENTER to stay in '[^']*'\s*\[\d+\]/.test(clean)) {
          wrote = true;
          parsed = parseGlobalAccountTree(clean);
          const idx = typeof chooseIndex === "function" ? chooseIndex(parsed) : chooseIndex;
          try { proc.stdin.write((idx != null ? String(idx) : "") + os.EOL); } catch {}
        }
      };

      proc.stdout.on("data", onData);
      proc.stderr.on("data", (b) => {
        for (const line of b.toString().split(/\r?\n/)) if (line.trim()) log("btp", "err", line.trim());
      });
      proc.on("error", (err) => { log("btp", "err", `btp target spawn error: ${err.message}`); resolve({ code: -1, parsed }); });
      proc.on("close", (code) => {
        if (!parsed && clean) parsed = parseGlobalAccountTree(clean);
        resolve({ code, parsed });
      });
    });
  }
```

(d) In the `handlers` object, directly after the `"btp:cancelLogin"` handler (currently ends at line 826), add:

```js
    // Enumerate all reachable global accounts via `btp target --hierarchy true`.
    // Stays on the current target (writes its index) — read-only. Single GA →
    // auto-select; otherwise emit btp:gaChoice with each GA's subaccounts (which
    // disambiguate same-named GAs). Reused by the UI's "Back" button.
    async "btp:listGlobalAccounts"() {
      const { code, parsed } = await runTargetHierarchy((p) => (p ? p.currentIndex : null));
      if (code !== 0 || !parsed || parsed.accounts.length === 0) {
        send("btp:loginFailed", { code });
        return { ok: false, error: "Could not list global accounts" };
      }
      state.gaTree = parsed.accounts;
      if (parsed.accounts.length === 1) {
        return await handlers["btp:selectGlobalAccount"]({ index: parsed.accounts[0].index });
      }
      send("btp:gaChoice", { accounts: parsed.accounts });
      return { ok: true, choicePending: true };
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test apps/figaf-manager/cloud/orchestrator-btp-login.test.js`
Expected: PASS — the "parses the tree and emits btp:gaChoice" test passes.

Run: `node --test packages/core/btp-target.test.js` (still PASS — no regression).

- [ ] **Step 5: Commit**

```bash
git add packages/core/orchestrator.js apps/figaf-manager/cloud/orchestrator-btp-login.test.js
git commit -m "feat(core): add runTargetHierarchy + btp:listGlobalAccounts" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Rework `btp:selectGlobalAccount` to target by index

**Files:**
- Modify: `packages/core/orchestrator.js` (replace the `"btp:selectGlobalAccount"` handler)
- Test: `apps/figaf-manager/cloud/orchestrator-btp-login.test.js` (append)

- [ ] **Step 1: Write the failing test (append to the file from Task 2)**

Append to `apps/figaf-manager/cloud/orchestrator-btp-login.test.js`:

```js
test("btp:selectGlobalAccount targets by index and emits subaccountChoice with the GA name", async () => {
  // listGlobalAccounts first (populates state.gaTree), then select GA index 6.
  const twoSubs = JSON.stringify({ value: [
    { guid: "SUB-A", displayName: "demotest", region: "us10" },
    { guid: "SUB-B", displayName: "figafpartner", region: "eu10" },
  ] });
  responses.push(
    { match: (a) => a[0] === "target", interactive: true, stdout: SAMPLE_TREE, code: 0 }, // listGlobalAccounts (stay on 6)
    { match: (a) => a[0] === "target", interactive: true, stdout: SAMPLE_TREE, code: 0 }, // selectGlobalAccount (write 6)
    { match: (a) => a.includes("accounts/global-account"), stdout: JSON.stringify({ subdomain: "figafaps-02", guid: "GA-6", licenseType: "Subscription" }), code: 0 },
    { match: (a) => a.includes("accounts/subaccount"), stdout: twoSubs, code: 0 },
    { match: (a) => a.includes("accounts/environment-instance"), stdout: JSON.stringify({ environmentInstances: [{ environmentType: "cloudfoundry", landscapeLabel: "cf-us10", subaccountGUID: "SUB-A", labels: '{"Org Name":"org-a"}' }] }), code: 0 },
    { match: (a) => a.includes("accounts/environment-instance"), stdout: JSON.stringify({ environmentInstances: [{ environmentType: "cloudfoundry", landscapeLabel: "cf-eu10", subaccountGUID: "SUB-B", labels: '{"Org Name":"org-b"}' }] }), code: 0 },
  );
  const send = makeSend();
  const orch = createOrchestrator({ host: makeHost(), send: send.fn });
  await orch.handlers["btp:listGlobalAccounts"]();
  await orch.handlers["btp:selectGlobalAccount"]({ index: 6 });
  await settle();

  // The second target spawn received "6" (disambiguating the two Figaf ApS GAs).
  const targetCalls = spawnCalls.filter((c) => c.args[0] === "target");
  assert.equal(targetCalls.length, 2);
  assert.equal(targetCalls[1].stdinData.join("").trim(), "6");

  const sub = send.events.find((e) => e.channel === "btp:subaccountChoice");
  assert.ok(sub, "subaccountChoice emitted (2 CF subaccounts)");
  assert.equal(sub.payload.globalAccountName, "Figaf ApS");
  assert.equal(sub.payload.subaccounts.length, 2);
  assert.ok(!send.events.some((e) => e.channel === "btp:loggedIn"), "no loggedIn while a subaccount choice is pending");
});

test("btp:selectGlobalAccount rejects an unknown index without spawning target", async () => {
  const send = makeSend();
  const orch = createOrchestrator({ host: makeHost(), send: send.fn });
  const r = await orch.handlers["btp:selectGlobalAccount"]({ index: 999 });
  assert.equal(r.ok, false);
  assert.ok(!spawnCalls.some((c) => c.args[0] === "target"), "no target spawn for unknown GA");
});

test("btp:listGlobalAccounts with a single GA auto-selects it (no gaChoice, loggedIn)", async () => {
  const oneGa = [
    "Choose global account, subaccount, or directory:",
    "   [1] OnlyGA (global account)",
    "   [2]  └─ dev (subaccount)",
    "Choose, or hit ENTER to stay in 'OnlyGA' [1]> ",
  ].join("\n");
  responses.push(
    { match: (a) => a[0] === "target", interactive: true, stdout: oneGa, code: 0 }, // listGlobalAccounts (stay on 1)
    { match: (a) => a[0] === "target" && a.includes("--hierarchy"), interactive: true, stdout: oneGa, code: 0 }, // selectGlobalAccount (write 1)
    { match: (a) => a.includes("accounts/global-account"), stdout: JSON.stringify({ subdomain: "onlyga", guid: "GA-1", licenseType: "TRIAL" }), code: 0 },
    { match: (a) => a.includes("accounts/subaccount"), stdout: JSON.stringify({ value: [{ guid: "SUB-1", displayName: "dev", region: "us10" }] }), code: 0 },
    { match: (a) => a.includes("accounts/environment-instance"), stdout: JSON.stringify({ environmentInstances: [{ environmentType: "cloudfoundry", landscapeLabel: "cf-us10", subaccountGUID: "SUB-1", labels: '{"Org Name":"org-dev"}' }] }), code: 0 },
    // applySubaccountSelection runs `btp target --subaccount SUB-1`; the default
    // (unmatched, non-interactive, code 0) response covers it.
  );
  const send = makeSend();
  const orch = createOrchestrator({ host: makeHost(), send: send.fn });
  await orch.handlers["btp:listGlobalAccounts"]();
  await settle();

  assert.ok(!send.events.some((e) => e.channel === "btp:gaChoice"), "no gaChoice for a single GA");
  assert.ok(send.events.some((e) => e.channel === "btp:loggedIn"), "loggedIn emitted via auto-pick");
});

test("btp:selectGlobalAccount on a GA with no CF subaccount re-opens the GA picker", async () => {
  responses.push(
    { match: (a) => a[0] === "target", interactive: true, stdout: SAMPLE_TREE, code: 0 }, // listGlobalAccounts
    { match: (a) => a[0] === "target" && a.includes("--hierarchy"), interactive: true, stdout: SAMPLE_TREE, code: 0 }, // select GA 6
    { match: (a) => a.includes("accounts/global-account"), stdout: JSON.stringify({ subdomain: "figafaps-02", guid: "GA-6" }), code: 0 },
    { match: (a) => a.includes("accounts/subaccount"), stdout: JSON.stringify({ value: [{ guid: "SUB-A", displayName: "demotest", region: "us10" }] }), code: 0 },
    { match: (a) => a.includes("accounts/environment-instance"), stdout: JSON.stringify({ environmentInstances: [] }), code: 0 }, // no CF env
  );
  const send = makeSend();
  const orch = createOrchestrator({ host: makeHost(), send: send.fn });
  await orch.handlers["btp:listGlobalAccounts"]();
  const before = send.events.filter((e) => e.channel === "btp:gaChoice").length;
  await orch.handlers["btp:selectGlobalAccount"]({ index: 6 });
  await settle();
  const after = send.events.filter((e) => e.channel === "btp:gaChoice").length;
  assert.ok(after > before, "GA picker re-emitted when the GA has no CF subaccount");
  assert.ok(!send.events.some((e) => e.channel === "btp:subaccountChoice"), "no subaccount picker for a CF-less GA");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test apps/figaf-manager/cloud/orchestrator-btp-login.test.js`
Expected: FAIL — the new tests fail because the old handler runs `btp target --global-account <subdomain>` (no index written; no `state.gaTree` lookup; single-GA path calls a still-`{subdomain}` handler).

- [ ] **Step 3: Replace the handler**

In `packages/core/orchestrator.js`, replace the entire current `"btp:selectGlobalAccount"` handler (currently lines 828-844, the `{ subdomain }` version) with:

```js
    async "btp:selectGlobalAccount"({ index }) {
      const ga = (state.gaTree || []).find((g) => g.index === Number(index));
      if (!ga) return { ok: false, error: "Unknown global account index" };

      const { code } = await runTargetHierarchy(Number(index));
      if (code !== 0) {
        send("btp:loginFailed", { code });
        return { ok: false, error: "Failed to target global account" };
      }
      state.globalAccountName = ga.name;
      // GA switch invalidates the previous subaccount enumeration.
      state.subaccountList = null;
      state.subaccountWaitingForChoice = false;
      state.provider = null;

      // Authoritative GA metadata (subdomain / guid / license) from JSON — the
      // current target is now the chosen GA.
      const gaInfo = await run(resolveBtp(), ["--format", "json", "get", "accounts/global-account"], { source: "btp" });
      if (gaInfo.code === 0) {
        try {
          const js = gaInfo.stdout.indexOf("{");
          if (js >= 0) {
            const data = JSON.parse(gaInfo.stdout.slice(js));
            state.globalAccountSubdomain = data.subdomain || null;
            state.globalAccountGuid = data.guid || null;
            state.licenseType = data.licenseType || null;
            log("btp", "line", `Global account subdomain: ${state.globalAccountSubdomain}`);
          }
        } catch (e) {
          log("btp", "warn", `Could not parse GA info: ${e.message}`);
        }
      }

      const env = await handlers["btp:listEnvInstances"]();
      if (env.ok === false) {
        // e.g. this GA has no Cloud-Foundry-enabled subaccount. Surface the
        // reason, and if there are other GAs, drop back to the GA picker so the
        // user can choose a different one rather than restarting the whole login.
        log("btp", "warn", env.error || "No Cloud Foundry environment in this global account");
        if ((state.gaTree || []).length > 1) {
          send("btp:gaChoice", { accounts: state.gaTree });
        } else {
          send("btp:loggedIn", { ...env, subdomain: state.globalAccountSubdomain });
        }
        return env;
      }
      if (!env.choicePending) {
        send("btp:loggedIn", { ...env, subdomain: state.globalAccountSubdomain });
      }
      return env;
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test apps/figaf-manager/cloud/orchestrator-btp-login.test.js`
Expected: PASS — all four tests so far (listGlobalAccounts ×2, selectGlobalAccount ×2) pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/orchestrator.js apps/figaf-manager/cloud/orchestrator-btp-login.test.js
git commit -m "feat(core): target global account by tree index in btp:selectGlobalAccount" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `btp:loginStart` — set config, auto-pick GA #1, delegate to the tree picker

**Files:**
- Modify: `packages/core/orchestrator.js` (`"btp:loginStart"` handler)
- Test: `apps/figaf-manager/cloud/orchestrator-btp-login.test.js` (append)

- [ ] **Step 1: Write the failing test (append)**

Append to `apps/figaf-manager/cloud/orchestrator-btp-login.test.js`:

```js
test("btp:loginStart sets showglobalaccounts, auto-answers the GA prompt with 1, then lists GAs", async () => {
  const GA_PROMPT = [
    "Authentication successful",
    "Choose a global account:",
    "  [1] 17b44102trial",
    "  [2] Figaf ApS",
    "Choose option> ",
  ].join("\n");
  responses.push(
    { match: (a) => a[0] === "set" && a.includes("--login.showglobalaccounts"), stdout: "", code: 0 },
    { match: (a) => a[0] === "login", interactive: true, stdout: GA_PROMPT, code: 0 },
    { match: (a) => a[0] === "target", interactive: true, stdout: SAMPLE_TREE, code: 0 },
  );
  const send = makeSend();
  const orch = createOrchestrator({ host: makeHost(), send: send.fn });
  await orch.handlers["btp:loginStart"]();
  await settle();

  // config was enabled before login
  const setCfg = spawnCalls.find((c) => c.args[0] === "set");
  assert.ok(setCfg, "btp set config invoked");
  assert.deepEqual(setCfg.args, ["set", "config", "--login.showglobalaccounts", "true"]);

  // GA prompt auto-answered with "1"
  const loginCall = spawnCalls.find((c) => c.args[0] === "login");
  assert.equal(loginCall.stdinData.join("").trim(), "1");

  // delegated to the tree picker → gaChoice
  assert.ok(send.events.some((e) => e.channel === "btp:gaChoice"), "gaChoice emitted after login");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test apps/figaf-manager/cloud/orchestrator-btp-login.test.js`
Expected: FAIL — current `loginStart` emits `btp:gaChoice` directly from the login prompt (with `{accounts:[{index,displayName}]}`) and never runs `set config` nor writes `1`.

- [ ] **Step 3: Modify `btp:loginStart`**

In `packages/core/orchestrator.js`, inside `"btp:loginStart"`:

(a) Right after the re-invocation guard, before `const btpBin = resolveBtp();` (currently line 704), add:

```js
      // Force `btp login` to always prompt for a GA so our handling is
      // deterministic; we auto-answer it below and re-pick via `btp target`.
      await run(resolveBtp(), ["set", "config", "--login.showglobalaccounts", "true"], { source: "btp" });
```

(b) Replace the `tryDetectGaPrompt` function (currently lines 729-749) with an auto-pick that answers the prompt instead of surfacing it:

```js
      const tryAutoPickGa = () => {
        if (promptEmitted) return;
        const m = /Choose a global account:?[\s\S]*?Choose option\s*[>:]/i.exec(cleanBuffer);
        if (!m) return;
        promptEmitted = true;
        log("btp", "line", "Multiple global accounts — selecting the first to enumerate via 'btp target'.");
        try { proc.stdin.write("1" + os.EOL); } catch {}
        cleanBuffer = cleanBuffer.slice(m.index + m[0].length);
      };
```

(c) In `ingest` (currently line 759-765), rename the call `tryDetectGaPrompt();` to `tryAutoPickGa();`.

(d) In the `proc.on("close", async (code, signal) => {...})` handler, replace the **entire** `if (code === 0) { ... } else { ... }` block (currently lines 780-802 — the `gaInfo` fetch, the `listEnvInstances` call + `btp:loggedIn` emit, and the existing `else` that emits `btp:loginFailed`) with:

```js
        if (code === 0) {
          await handlers["btp:listGlobalAccounts"]();
        } else {
          send("btp:loginFailed", { code, signal });
        }
```

Keep the logging lines that precede this block (the `if (lineRemainder.trim())` flush, the `log("btp", ...)` exit line, and `state.btpLoginProc = null;`) intact. The old `gaInfo` fetch + `listEnvInstances` logic now lives in `btp:selectGlobalAccount` (Task 3).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test apps/figaf-manager/cloud/orchestrator-btp-login.test.js`
Expected: PASS — all five tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/orchestrator.js apps/figaf-manager/cloud/orchestrator-btp-login.test.js
git commit -m "feat(core): auto-pick GA at login and delegate to btp target picker" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `btp:cancelLogin` logs out + `listEnvInstances` carries the GA name

**Files:**
- Modify: `packages/core/orchestrator.js` (`"btp:cancelLogin"`, `"btp:listEnvInstances"`)
- Test: `apps/figaf-manager/cloud/orchestrator-btp-login.test.js` (append)

- [ ] **Step 1: Write the failing test (append)**

Append to `apps/figaf-manager/cloud/orchestrator-btp-login.test.js`:

```js
test("btp:cancelLogin runs btp logout and cf logout", async () => {
  responses.push(
    { match: (a) => a[0] === "logout", stdout: "", code: 0 },
    { match: (a) => a[0] === "logout", stdout: "", code: 0 },
  );
  const send = makeSend();
  const orch = createOrchestrator({ host: makeHost(), send: send.fn });
  const r = await orch.handlers["btp:cancelLogin"]();
  assert.equal(r.ok, true);
  const logouts = spawnCalls.filter((c) => c.args[0] === "logout");
  assert.equal(logouts.length, 2, "both btp and cf logout invoked");
  const bins = logouts.map((c) => c.cmd).sort();
  assert.deepEqual(bins, ["/fake/path/btp", "/fake/path/cf"]);
});

test("btp:subaccountChoice payload includes globalAccountName", async () => {
  // Reuse the select flow; assert the GA name rides along on the subaccount step.
  responses.push(
    { match: (a) => a[0] === "target", interactive: true, stdout: SAMPLE_TREE, code: 0 },
    { match: (a) => a[0] === "target", interactive: true, stdout: SAMPLE_TREE, code: 0 },
    { match: (a) => a.includes("accounts/global-account"), stdout: JSON.stringify({ subdomain: "figafaps-02", guid: "GA-6" }), code: 0 },
    { match: (a) => a.includes("accounts/subaccount"), stdout: JSON.stringify({ value: [
      { guid: "SUB-A", displayName: "demotest", region: "us10" },
      { guid: "SUB-B", displayName: "figafpartner", region: "us10" },
    ] }), code: 0 },
    { match: (a) => a.includes("accounts/environment-instance"), stdout: JSON.stringify({ environmentInstances: [{ environmentType: "cloudfoundry", landscapeLabel: "cf-us10", subaccountGUID: "SUB-A" }] }), code: 0 },
    { match: (a) => a.includes("accounts/environment-instance"), stdout: JSON.stringify({ environmentInstances: [{ environmentType: "cloudfoundry", landscapeLabel: "cf-us10", subaccountGUID: "SUB-B" }] }), code: 0 },
  );
  const send = makeSend();
  const orch = createOrchestrator({ host: makeHost(), send: send.fn });
  await orch.handlers["btp:listGlobalAccounts"]();
  await orch.handlers["btp:selectGlobalAccount"]({ index: 6 });
  await settle();
  const sub = send.events.find((e) => e.channel === "btp:subaccountChoice");
  assert.equal(sub.payload.globalAccountName, "Figaf ApS");
  assert.equal(sub.payload.globalAccountSubdomain, "figafaps-02");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test apps/figaf-manager/cloud/orchestrator-btp-login.test.js`
Expected: FAIL — current `cancelLogin` only kills the proc (no logout); current `subaccountChoice` payload has no `globalAccountName`.

- [ ] **Step 3: Modify both handlers**

In `packages/core/orchestrator.js`:

(a) Replace the entire `"btp:cancelLogin"` handler (currently lines 820-826) with:

```js
    async "btp:cancelLogin"() {
      const proc = state.btpLoginProc;
      if (proc && !proc.killed) { try { proc.kill(); } catch {} }
      state.btpLoginProc = null;
      state.btpLoginWaitingForChoice = false;
      // Per design: cancel must also log out so a half-finished session can't
      // strand the user on a stale global account.
      await run(resolveBtp(), ["logout"], { source: "btp" }).catch(() => {});
      await run(resolveCf(), ["logout"], { source: "cf" }).catch(() => {});
      state.globalAccountSubdomain = null;
      state.globalAccountName = null;
      state.landscape = null;
      state.subaccount = null;
      state.org = null;
      state.space = null;
      state.user = null;
      state.provider = null;
      state.subaccountList = null;
      state.subaccountWaitingForChoice = false;
      state.gaTree = null;
      return { ok: true };
    },
```

(b) In `"btp:listEnvInstances"`, find the `send("btp:subaccountChoice", {` call (currently line 943) and add the two GA fields at the top of the payload object:

```js
      send("btp:subaccountChoice", {
        globalAccountName: state.globalAccountName || null,
        globalAccountSubdomain: state.globalAccountSubdomain || null,
        subaccounts: enumerated.map((e) => ({
```

(Leave the rest of the `subaccounts` mapping unchanged.)

- [ ] **Step 4: Run the full orchestrator suite to verify it passes**

Run: `node --test apps/figaf-manager/cloud/orchestrator-btp-login.test.js`
Expected: PASS — all seven tests pass.

Run the broader core/manager suites to confirm no regression:
Run: `node --test packages/core/btp-target.test.js apps/figaf-manager/cloud/orchestrator-restage.test.js apps/figaf-manager/cloud/orchestrator-audit.test.js`
Expected: PASS for all.

- [ ] **Step 5: Commit**

```bash
git add packages/core/orchestrator.js apps/figaf-manager/cloud/orchestrator-btp-login.test.js
git commit -m "feat(core): cancelLogin logs out; subaccountChoice carries GA name" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: IPC surface — `selectGlobalAccount(index)` + `listGlobalAccounts`

**Files:**
- Modify: `apps/figaf-local/main-process/preload.js:41` (and add a line)
- Modify: `apps/figaf-manager/cloud/client.js:151` (and add a line)

No automated test (pure IPC wiring); verified by Task 9's end-to-end run.

- [ ] **Step 1: Update the Electron preload**

In `apps/figaf-local/main-process/preload.js`, in the `btp:` block, replace:

```js
    selectGlobalAccount: (subdomain) => ipcRenderer.invoke("btp:selectGlobalAccount", { subdomain }),
```

with:

```js
    selectGlobalAccount: (index) => ipcRenderer.invoke("btp:selectGlobalAccount", { index }),
    listGlobalAccounts: () => ipcRenderer.invoke("btp:listGlobalAccounts"),
```

- [ ] **Step 2: Update the cloud client shim**

In `apps/figaf-manager/cloud/client.js`, in the `btp:` block, replace:

```js
      selectGlobalAccount:  function (subdomain) { return rpc("btp:selectGlobalAccount", { subdomain: subdomain }); },
```

with:

```js
      selectGlobalAccount:  function (index) { return rpc("btp:selectGlobalAccount", { index: index }); },
      listGlobalAccounts:   function ()  { return rpc("btp:listGlobalAccounts"); },
```

- [ ] **Step 3: Sanity-check the files parse**

Run: `node --check apps/figaf-local/main-process/preload.js`
Run: `node --check apps/figaf-manager/cloud/client.js`
Expected: no output (both parse cleanly).

- [ ] **Step 4: Commit**

```bash
git add apps/figaf-local/main-process/preload.js apps/figaf-manager/cloud/client.js
git commit -m "feat(ipc): selectGlobalAccount by index + listGlobalAccounts on both hosts" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: UI — GA picker shows subaccounts, selects by index

**Files:**
- Modify: `packages/ui/screens/screen-login.jsx`

No renderer test harness exists; verify by running figaf-local in Task 9. This task is a careful edit + a JS syntax check.

- [ ] **Step 1: Track whether the GA picker had multiple GAs**

In `ScreenLogin`, alongside the other `useState` hooks (currently lines 11-14), add:

```js
  const [multiGa, setMultiGa] = React.useState(false);
```

In the `btp:gaChoice` handler (currently lines 40-42), set the flag:

```js
    const offGaChoice = api.on("btp:gaChoice", (p) => {
      setGaChoice(p);
      setMultiGa(!!(p && p.accounts && p.accounts.length > 1));
    });
```

- [ ] **Step 2: Simplify `selectGa` to index-only**

Replace the current `selectGa` function (currently lines 117-130) with:

```js
  async function selectGa(index) {
    const api = fg();
    if (!api) return;
    setGaChoice(null);
    setSubaccountChoice(null);
    setLogin({ btpStatus: "running" });
    const r = await api.btp.selectGlobalAccount(index);
    if (r && r.ok === false) {
      appendLog([{ type: "err", text: r.error || "Failed to select global account" }]);
      setLogin({ btpStatus: "error" });
    }
  }
```

- [ ] **Step 3: Rework the GA picker markup**

Replace the GA-picker block — the entire `{!btpLoggedIn && gaChoice && gaChoice.accounts && gaChoice.accounts.length > 0 && (...)}` JSX (currently lines 282-340) — with:

```jsx
          {!btpLoggedIn && gaChoice && gaChoice.accounts && gaChoice.accounts.length > 0 && (
            <ScrollReveal>
            <div className="slide-in" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 4 }}>
                Choose a global account
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>
                Your account can reach multiple global accounts. The subaccounts under each help tell them apart.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {gaChoice.accounts.map((acct, i) => {
                  const subs = acct.subaccounts || [];
                  return (
                    <button
                      key={acct.index}
                      className="choice"
                      style={{ flexDirection: "row", alignItems: "center", padding: "12px 14px", gap: 14, textAlign: "left" }}
                      onClick={() => selectGa(acct.index)}
                    >
                      <div style={{ width: 28, height: 28, borderRadius: 6, background: "var(--fg-blue-soft)", color: "var(--fg-blue)", display: "grid", placeItems: "center", flexShrink: 0, fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
                        {acct.index}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-0)" }}>{acct.name}</div>
                        {subs.length > 0 && (
                          <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {subs.length} subaccount{subs.length === 1 ? "" : "s"}: {subs.map((s) => s.name).join(", ")}
                          </div>
                        )}
                      </div>
                      <Ico.ArrowRight />
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={cancelBtpLogin}>
                  Cancel sign-in
                </button>
              </div>
            </div>
            </ScrollReveal>
          )}
```

(This removes the old `{index, displayName}` rendering and the duplicate-display-name warning banner — subaccounts now disambiguate.)

- [ ] **Step 4: Reset `multiGa` on sign-out and cancel**

In `handleLogout` (currently lines 132-144), at the start of its body (right after the `api` guard), add:

```js
    setGaChoice(null);
    setSubaccountChoice(null);
    setMultiGa(false);
```

In `cancelBtpLogin` (currently lines 96-103), add `setMultiGa(false);` next to its existing `setGaChoice(null); setSubaccountChoice(null);` lines so a cancelled GA picker doesn't leave a stale `multiGa`.

- [ ] **Step 5: Syntax-check**

Run: `node --check packages/ui/screens/screen-login.jsx`
Expected: FAIL — `node --check` does not understand JSX. Instead confirm balanced braces visually and rely on Task 9's live run. (Do NOT treat the `node --check` error as a code defect; JSX is not plain JS.)

- [ ] **Step 6: Commit**

```bash
git add packages/ui/screens/screen-login.jsx
git commit -m "feat(ui): GA picker lists subaccounts and selects by index" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: UI — subaccount picker GA header + Back button

**Files:**
- Modify: `packages/ui/screens/screen-login.jsx`

- [ ] **Step 1: Add a `goBackToGaPicker` handler**

In `ScreenLogin`, after `selectGa` (from Task 7), add:

```js
  async function goBackToGaPicker() {
    const api = fg();
    if (!api) return;
    setSubaccountChoice(null);
    setLogin({ btpStatus: "running" });
    await api.btp.listGlobalAccounts();
  }
```

- [ ] **Step 2: Add the GA-name header + Back button to the subaccount picker**

In the subaccount-picker block (currently lines 342-404), replace the header `<div>` (the "Choose a subaccount" label + its description, currently lines 345-350) with a version that shows the selected GA, and replace the footer "Cancel sign-in" button (currently lines 397-401) with a conditional "Back" button.

Replace the header portion:

```jsx
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 4 }}>
                Choose a subaccount
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>
                This global account has multiple subaccounts. Pick the one you want to deploy to.
              </div>
```

with:

```jsx
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 4 }}>
                Choose a subaccount
              </div>
              {subaccountChoice.globalAccountName && (
                <div style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 6 }}>
                  Global account: <strong style={{ color: "var(--ink-0)" }}>{subaccountChoice.globalAccountName}</strong>
                </div>
              )}
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>
                Pick the subaccount you want to deploy to.
              </div>
```

Replace the footer button:

```jsx
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={cancelBtpLogin}>
                  Cancel sign-in
                </button>
              </div>
```

with:

```jsx
              {multiGa && (
                <div style={{ display: "flex", justifyContent: "flex-start", marginTop: 10 }}>
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={goBackToGaPicker}>
                    <Ico.ArrowLeft /> Back to global accounts
                  </button>
                </div>
              )}
```

- [ ] **Step 3: Ensure an `ArrowLeft` icon exists**

Check `packages/ui/components.jsx` for `Ico.ArrowLeft`.

Run: `grep -n "ArrowLeft" packages/ui/components.jsx` (or use the editor search).

If absent, add it next to `ArrowRight` in the `Ico` object in `packages/ui/components.jsx`:

```jsx
  ArrowLeft: (p) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
    </svg>
  ),
```

(If `Ico.ArrowRight` uses a different style/signature, mirror that style instead so the new icon matches.)

- [ ] **Step 4: Commit**

```bash
git add packages/ui/screens/screen-login.jsx packages/ui/components.jsx
git commit -m "feat(ui): subaccount step shows GA name and a Back button" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: End-to-end manual verification (real BTP) + cleanup

**Files:** none (verification only)

- [ ] **Step 1: Launch figaf-local**

Run: `npm run start:local`
Expected: the Electron installer opens.

- [ ] **Step 2: Walk the login flow against a real multi-GA account**

Verify, in order:
1. Click **Sign in with SSO** → browser opens → after auth, the wizard does NOT show the raw `Choose option>` list. It shows the **"Choose a global account"** picker built from `btp target`.
2. Each GA card shows its **subaccount names** beneath it; the two same-named GAs (e.g. `Figaf ApS`) are distinguishable by their subaccount lists.
3. Pick a GA → the **subaccount picker** appears with the **selected GA name at the top** and only the CF-enabled subaccounts pickable.
4. The **"Back to global accounts"** button returns to the GA picker (and is absent when the account has only one GA).
5. **"Cancel sign-in"** appears only on the GA picker; clicking it logs out (confirm `btp logout` + `cf logout` in the terminal drawer) and returns to idle.
6. Pick a subaccount → CF passcode step works as before → reaching **Connected** for both BTP and CF.
7. Sign out, sign back in, and choose a **different** GA than before — confirm the picker reappears every time (the original "can't re-pick" bug is gone).

- [ ] **Step 3: Confirm the full automated suite is green**

Run: `node --test packages/core/btp-target.test.js apps/figaf-manager/cloud/orchestrator-btp-login.test.js apps/figaf-manager/cloud/orchestrator-restage.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 4: Final review commit (if any tweaks were needed during verification)**

```bash
git add -A
git commit -m "fix(ui): adjustments from BTP login end-to-end verification" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

(Skip this commit if Step 2 needed no changes.)

---

## Notes for the implementer

- **`btp:submitChoice` is now internal/unused** by the UI (the orchestrator auto-answers the login prompt). Leave the handler and its preload/client entries in place — harmless, and removing them is out of scope.
- **Do not touch the CF login path** (passcode / org / space) — it is unchanged.
- **Cloud build:** `apps/figaf-manager/scripts/build-zip.js` copies the entire `packages/core` directory, so `btp-target.js` ships automatically. No build-script change needed.
- **`node --check` cannot validate JSX** — the renderer has no bundler/test harness, so screen-login.jsx is validated by the live run in Task 9, not by a parser.
- **Test isolation:** `node --test` runs each file in its own process, so the `child_process.spawn` patch in the new test file does not leak into `orchestrator-restage.test.js`.

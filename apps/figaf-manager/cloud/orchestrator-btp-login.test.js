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

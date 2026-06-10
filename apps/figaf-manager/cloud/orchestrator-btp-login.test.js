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
  const loggedIn = send.events.find((e) => e.channel === "btp:loggedIn");
  assert.ok(loggedIn.payload.ok, "loggedIn payload is ok");
  assert.equal(loggedIn.payload.subdomain, "onlyga", "subdomain carried from gaInfo");
  assert.equal(loggedIn.payload.landscape, "cf-us10", "landscape carried from the env probe");
});

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

  // set config ran BEFORE login
  const loginIdx = spawnCalls.findIndex((c) => c.args[0] === "login");
  const setIdx = spawnCalls.findIndex((c) => c.args[0] === "set");
  assert.ok(setIdx !== -1 && loginIdx !== -1, "both set config and login were spawned");
  assert.ok(setIdx < loginIdx, "set config ran before btp login");

  // no loginFailed emitted
  assert.ok(!send.events.some((e) => e.channel === "btp:loginFailed"), "no loginFailed emitted");

  // delegated to the tree picker → gaChoice with correct indices
  const gaChoice = send.events.find((e) => e.channel === "btp:gaChoice");
  assert.ok(gaChoice, "gaChoice emitted after login");
  assert.deepEqual(gaChoice.payload.accounts.map((a) => a.index), [1, 6, 9], "gaChoice carries all three GA indices");
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
  assert.ok(!send.events.some((e) => e.channel === "btp:loggedIn"), "no loggedIn for a CF-less multi-GA");
});

"use strict";
// Integration test: the audit logger is wired into the orchestrator's run()
// helper. When a handler invokes a subprocess, cli.spawn + cli.exit records
// should land on the audit sink — including stdout/stderr tails and the
// correlation id.
//
// This is the smoke test for the FIGAF_LOG_LEVEL feature. The contract-level
// behavior (levels, redaction, tail caps) is exercised in audit-log.test.js;
// this file proves the wiring is correct end-to-end.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const child_process = require("child_process");
const EventEmitter = require("events");

// Patch spawn so the orchestrator's run() helper can be exercised without
// touching the host. Same pattern as orchestrator-restage.test.js — see
// that file for the rationale on require-after-patch.
const spawnCalls = [];
let responses = [];

function popResponse(args) {
  for (let i = 0; i < responses.length; i++) {
    const r = responses[i];
    if (!r.match || r.match(args)) {
      responses.splice(i, 1);
      return r;
    }
  }
  return { stdout: "", stderr: "", code: 0 };
}

function fakeSpawn(cmd, args /*, opts*/) {
  spawnCalls.push({ cmd, args: args.slice() });
  const resp = popResponse(args);
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write() {}, end() {} };
  setImmediate(() => {
    if (resp.stdout) proc.stdout.emit("data", Buffer.from(resp.stdout));
    if (resp.stderr) proc.stderr.emit("data", Buffer.from(resp.stderr));
    proc.emit("close", resp.code || 0);
  });
  return proc;
}

child_process.spawn = fakeSpawn;

const { createOrchestrator, createAuditLogger } = require("@figaf/core");

function makeHost() {
  return {
    isHosted: true,
    resolveBinary: () => "/fake/cf",
    getUserDataDir: () => "/tmp/figaf-fake",
    resolveManagerApprouterDir: () => null,
    resolveDeployTemplate: () => ({ kind: "bundle", src: "/tmp/figaf-fake" }),
    pickFile: async () => null,
    openExternal: async () => {},
    readClipboard: async () => "",
  };
}

function noopSend() {}

beforeEach(() => {
  spawnCalls.length = 0;
  responses.length = 0;
});

async function flush() { await new Promise((r) => setImmediate(r)); }

test("orchestrator + audit: cf:restage produces cli.spawn + cli.exit pair", async () => {
  responses.push(
    { match: (a) => a[0] === "bind-service", stdout: "OK\n", stderr: "", code: 0 },
    { match: (a) => a[0] === "restage", stdout: "Restaging app figaf-manager...\n", stderr: "", code: 0 },
  );
  const records = [];
  const audit = createAuditLogger({
    level: "cli",
    sink: (line) => records.push(JSON.parse(line)),
  });
  const orch = createOrchestrator({ host: makeHost(), send: noopSend, audit });
  const r = await orch.handlers["cf:restage"]({ app: "figaf-manager", bindXsuaa: true });
  await flush();
  assert.equal(r.ok, true);

  // bind-service was via run(): we should see a paired spawn + exit.
  const bindSpawn = records.find((x) => x.kind === "cli.spawn" && x.args[0] === "bind-service");
  const bindExit  = records.find((x) => x.kind === "cli.exit"  && x.code === 0
                                       && /OK/.test(x.stdoutTail));
  assert.ok(bindSpawn, "cli.spawn emitted for bind-service");
  assert.ok(bindExit, "cli.exit emitted with stdout tail");
  assert.equal(bindSpawn.id, bindExit.id, "spawn and exit share an id");
  assert.ok(typeof bindExit.durationMs === "number", "durationMs is a number");
});

test("orchestrator + audit: level=off silences cli.spawn even when handler runs subprocess", async () => {
  responses.push({ match: (a) => a[0] === "bind-service", stdout: "", stderr: "", code: 0 });
  responses.push({ match: (a) => a[0] === "restage", stdout: "", stderr: "", code: 0 });
  const records = [];
  const audit = createAuditLogger({
    level: "off",
    sink: (line) => records.push(JSON.parse(line)),
  });
  const orch = createOrchestrator({ host: makeHost(), send: noopSend, audit });
  await orch.handlers["cf:restage"]({ app: "figaf-manager", bindXsuaa: true });
  await flush();
  assert.equal(records.length, 0, "no audit records emitted at level=off");
});

test("orchestrator: optional audit param defaults to a no-op (no breakage when omitted)", async () => {
  responses.push({ match: (a) => a[0] === "bind-service", stdout: "", stderr: "", code: 0 });
  responses.push({ match: (a) => a[0] === "restage", stdout: "", stderr: "", code: 0 });
  // No audit passed — must not throw.
  const orch = createOrchestrator({ host: makeHost(), send: noopSend });
  const r = await orch.handlers["cf:restage"]({ app: "figaf-manager", bindXsuaa: true });
  await flush();
  assert.equal(r.ok, true);
});

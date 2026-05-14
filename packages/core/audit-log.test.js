"use strict";
// Tests for the audit logger. These exercise the contract surface that the
// rest of the codebase relies on: level filtering, redaction of structured
// values, JWT scrub on free-form text, tail caps, and the correlation-id
// pair-up between spawn/exit (or in/out, or start/end).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createAuditLogger, _redact, _tail } = require("./audit-log");

function makeSink() {
  const lines = [];
  return {
    fn: (line) => lines.push(line),
    lines,
    records() { return lines.map((l) => JSON.parse(l)); },
  };
}

// ─── level filtering ────────────────────────────────────────────────────────

test("level=off silences every emit", () => {
  const sink = makeSink();
  const log = createAuditLogger({ level: "off", sink: sink.fn });
  log.beginCli({ cmd: "cf", args: ["target"] }).exit({ code: 0 });
  log.beginRpc({ channel: "cf:push", args: {} }).out({ ok: true });
  log.beginNet({ url: "https://example.com" }).end({ status: 200 });
  assert.equal(sink.lines.length, 0);
});

test("level=cli emits cli.* but not rpc.* or net.*", () => {
  const sink = makeSink();
  const log = createAuditLogger({ level: "cli", sink: sink.fn });
  log.beginCli({ cmd: "cf", args: ["target"] }).exit({ code: 0 });
  log.beginRpc({ channel: "cf:push", args: {} }).out({ ok: true });
  log.beginNet({ url: "https://example.com" }).end({ status: 200 });
  const kinds = sink.records().map((r) => r.kind);
  assert.deepEqual(kinds, ["cli.spawn", "cli.exit"]);
});

test("level=ipc emits cli.* and rpc.* but not net.*", () => {
  const sink = makeSink();
  const log = createAuditLogger({ level: "ipc", sink: sink.fn });
  log.beginCli({ cmd: "cf", args: ["target"] }).exit({ code: 0 });
  log.beginRpc({ channel: "cf:push", args: {} }).out({ ok: true });
  log.beginNet({ url: "https://example.com" }).end({ status: 200 });
  const kinds = sink.records().map((r) => r.kind);
  assert.deepEqual(kinds, ["cli.spawn", "cli.exit", "rpc.in", "rpc.out"]);
});

test("level=net emits all three families", () => {
  const sink = makeSink();
  const log = createAuditLogger({ level: "net", sink: sink.fn });
  log.beginCli({ cmd: "cf", args: ["target"] }).exit({ code: 0 });
  log.beginRpc({ channel: "cf:push", args: {} }).out({ ok: true });
  log.beginNet({ url: "https://example.com" }).end({ status: 200 });
  const kinds = sink.records().map((r) => r.kind);
  assert.deepEqual(kinds, ["cli.spawn", "cli.exit", "rpc.in", "rpc.out", "net.start", "net.end"]);
});

test("unknown level string falls back to cli (safer than off)", () => {
  const sink = makeSink();
  const log = createAuditLogger({ level: "verbose", sink: sink.fn });
  log.beginCli({ cmd: "cf", args: ["target"] }).exit({ code: 0 });
  assert.equal(log.level, "cli");
  assert.equal(sink.records()[0].kind, "cli.spawn");
});

// ─── correlation ids ────────────────────────────────────────────────────────

test("cli spawn/exit share an id; consecutive spawns get distinct ids", () => {
  const sink = makeSink();
  const log = createAuditLogger({ level: "cli", sink: sink.fn });
  const h1 = log.beginCli({ cmd: "cf", args: ["target"] });
  const h2 = log.beginCli({ cmd: "btp", args: ["whoami"] });
  h1.exit({ code: 0 });
  h2.exit({ code: 1 });
  const r = sink.records();
  const spawn1 = r.find((x) => x.kind === "cli.spawn" && x.cmd === "cf");
  const exit1  = r.find((x) => x.kind === "cli.exit"  && x.code === 0);
  const spawn2 = r.find((x) => x.kind === "cli.spawn" && x.cmd === "btp");
  const exit2  = r.find((x) => x.kind === "cli.exit"  && x.code === 1);
  assert.equal(spawn1.id, exit1.id);
  assert.equal(spawn2.id, exit2.id);
  assert.notEqual(spawn1.id, spawn2.id);
});

test("rpc in/out share an id; result body is recorded on out", () => {
  const sink = makeSink();
  const log = createAuditLogger({ level: "ipc", sink: sink.fn });
  log.beginRpc({ channel: "cf:restage", args: { app: "figaf-manager" } })
     .out({ ok: true, message: "restage initiated" });
  const r = sink.records();
  assert.equal(r[0].kind, "rpc.in");
  assert.equal(r[1].kind, "rpc.out");
  assert.equal(r[0].id, r[1].id);
  assert.equal(r[1].ok, true);
  assert.equal(r[1].result.message, "restage initiated");
});

// ─── redaction by key name ──────────────────────────────────────────────────

test("redact: top-level secret-like keys are replaced", () => {
  const r = _redact({
    user: "alex@figaf.com",
    password: "hunter2",
    token: "abc",
    client_secret: "xyz",
    clientSecret: "xyz2",
    apiKey: "k",
    Authorization: "Bearer foo",
    credentials: { user: "u", password: "p" },
  });
  assert.equal(r.user, "alex@figaf.com");
  assert.equal(r.password, "[REDACTED]");
  assert.equal(r.token, "[REDACTED]");
  assert.equal(r.client_secret, "[REDACTED]");
  assert.equal(r.clientSecret, "[REDACTED]");
  assert.equal(r.apiKey, "[REDACTED]");
  assert.equal(r.Authorization, "[REDACTED]");
  assert.equal(r.credentials, "[REDACTED]");
});

test("redact: nested objects are walked", () => {
  const r = _redact({
    config: { db: { user: "u", password: "p" } },
    list: [{ token: "a" }, { name: "ok" }],
  });
  assert.equal(r.config.db.user, "u");
  assert.equal(r.config.db.password, "[REDACTED]");
  assert.equal(r.list[0].token, "[REDACTED]");
  assert.equal(r.list[1].name, "ok");
});

test("redact: non-objects pass through (string, number, null, undefined)", () => {
  assert.equal(_redact("hello"), "hello");
  assert.equal(_redact(42), 42);
  assert.equal(_redact(null), null);
  assert.equal(_redact(undefined), undefined);
});

// ─── JWT scrub ──────────────────────────────────────────────────────────────

test("JWT in a free-form string is replaced", () => {
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyMTIzIiwidGVzdCI6dHJ1ZX0.abc123def456ghi789jkl0";
  const out = _tail("Authorization: Bearer " + jwt + " — request ok", 4096);
  assert.match(out, /\[JWT_REDACTED\]/);
  assert.ok(!out.includes(jwt));
});

test("JWT inside a redact-walked string value is scrubbed too", () => {
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyMTIzIiwidGVzdCI6dHJ1ZX0.abc123def456ghi789jkl0";
  const r = _redact({ note: "logs: " + jwt });
  assert.match(r.note, /\[JWT_REDACTED\]/);
});

// ─── tail cap ───────────────────────────────────────────────────────────────

test("tail truncates oversize stdout/stderr to the configured byte budget", () => {
  const big = "x".repeat(50_000);
  const sink = makeSink();
  const log = createAuditLogger({ level: "cli", sink: sink.fn, tailBytes: 256 });
  log.beginCli({ cmd: "cf", args: ["push"] }).exit({ code: 0, stdout: big });
  const exit = sink.records().find((r) => r.kind === "cli.exit");
  assert.ok(exit.stdoutTail.length <= 257, "tail respects the configured cap (+1 for ellipsis)");
  assert.ok(exit.stdoutTail.startsWith("…"), "truncated output gets an ellipsis prefix");
});

test("tail leaves small stdout untouched", () => {
  const sink = makeSink();
  const log = createAuditLogger({ level: "cli", sink: sink.fn });
  log.beginCli({ cmd: "cf", args: ["target"] }).exit({ code: 0, stdout: "OK\n" });
  const exit = sink.records().find((r) => r.kind === "cli.exit");
  assert.equal(exit.stdoutTail, "OK\n");
});

// ─── context propagation ────────────────────────────────────────────────────

test("withContext stamps user+sessionId on every record", () => {
  const sink = makeSink();
  const log = createAuditLogger({ level: "ipc", sink: sink.fn })
    .withContext({ user: "alex@figaf.com", sessionId: "S42" });
  log.beginRpc({ channel: "cf:push", args: {} }).out({ ok: true });
  const records = sink.records();
  for (const r of records) {
    if (r.kind === "rpc.in") {
      assert.equal(r.user, "alex@figaf.com");
      assert.equal(r.sessionId, "S42");
    }
  }
});

test("per-call user overrides context user (RPC initiated by someone else)", () => {
  const sink = makeSink();
  const log = createAuditLogger({ level: "ipc", sink: sink.fn })
    .withContext({ user: "default@figaf.com" });
  log.beginRpc({ channel: "cf:push", args: {}, user: "alex@figaf.com" }).out({ ok: true });
  const rin = sink.records().find((r) => r.kind === "rpc.in");
  assert.equal(rin.user, "alex@figaf.com");
});

// ─── shape stability ───────────────────────────────────────────────────────

test("every record is one JSON object, on one line", () => {
  const sink = makeSink();
  const log = createAuditLogger({ level: "net", sink: sink.fn });
  log.beginCli({ cmd: "cf", args: ["t"] }).exit({ code: 0, stdout: "a\nb\nc" });
  log.beginRpc({ channel: "x", args: { a: 1 } }).out({ ok: true });
  log.beginNet({ url: "https://example.com" }).end({ status: 200 });
  for (const line of sink.lines) {
    assert.ok(!line.includes("\n"), "no embedded newlines: " + line);
    const parsed = JSON.parse(line);
    assert.ok(parsed.ts, "every record has a ts");
    assert.ok(parsed.kind, "every record has a kind");
  }
});

test("sink throws → emit doesn't propagate (must not crash orchestrator)", () => {
  const log = createAuditLogger({
    level: "cli",
    sink: () => { throw new Error("disk full"); },
  });
  assert.doesNotThrow(() => {
    log.beginCli({ cmd: "cf", args: ["target"] }).exit({ code: 0 });
  });
});

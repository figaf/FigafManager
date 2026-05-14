"use strict";

// Audit logger for the Figaf installer.
//
// Two purposes in one stream:
//   1. Diagnostics — every CLI invocation (cf, btp, ssh, powershell) is recorded
//      with stdout/stderr tails so an operator can replay a failing upgrade
//      flow against the log instead of asking the user "what did it print?".
//   2. Audit trail — every RPC the renderer fires, every external HTTPS call
//      the orchestrator makes, and who triggered them, is timestamped and
//      retained so post-incident review and compliance asks have a single
//      source of truth.
//
// Format: JSON Lines on a single sink. Each line is a self-contained record;
// no multi-line frames. Easy to grep, easy to ship to Splunk/Loki/etc.
//
// Levels (cumulative):
//   off → no events at all (the log file/stdout stays silent).
//   cli → cli.spawn + cli.exit. Covers every cf/btp invocation.
//   ipc → cli.* plus rpc.in + rpc.out (every renderer→orchestrator call).
//   net → cli.* + rpc.* plus net.start + net.end (every outbound HTTPS hop).
//
// Sinks are pluggable so figaf-manager can write to stdout (CF log drain) and
// figaf-local can write to a rolling file in userData/. The logger itself
// doesn't know or care.

const LEVELS = { off: 0, cli: 1, ipc: 2, net: 3 };

// Keys whose values should be replaced with [REDACTED] when an object is
// serialized into a log record. Case-insensitive substring match against the
// key, so "client_secret", "ClientSecret", "myAuthorization" are all caught.
// CLI argv is NOT walked — operators want to see the actual cf/btp arguments,
// and CLI tools don't accept secrets on the command line for the flows this
// installer drives. stdout/stderr tails are scrubbed by regex only, since
// they're unstructured text.
const REDACT_KEY_PATTERNS = [
  /password/i, /passcode/i, /token/i, /secret/i,
  /apikey/i, /authorization/i, /credentials?$/i,
];

// JWT regex: header.payload.signature — three base64url chunks separated by
// dots, header always starts "eyJ". 20+ char minimum on each chunk to avoid
// false positives against things like "eyJhi.test.foo". Applied to any string
// value, including stdout/stderr tails.
const JWT_RE = /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g;

// Default tail cap. The audit log isn't a log shipper — CF already captures
// the raw cf output via the buildpack — so 2 KB per side is enough to keep
// the failure breadcrumb without bloating the log file. Operators who need
// more can set FIGAF_LOG_TAIL_BYTES.
const DEFAULT_TAIL_BYTES = 2048;

function normalizeLevel(raw) {
  const v = String(raw == null ? "cli" : raw).toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(LEVELS, v) ? v : "cli";
}

function tail(s, bytes) {
  if (!s) return "";
  const str = String(s);
  if (str.length <= bytes) return scrubJwt(str);
  return scrubJwt("…" + str.slice(str.length - bytes));
}

function scrubJwt(s) {
  return String(s).replace(JWT_RE, "[JWT_REDACTED]");
}

function shouldRedactKey(key) {
  for (let i = 0; i < REDACT_KEY_PATTERNS.length; i++) {
    if (REDACT_KEY_PATTERNS[i].test(key)) return true;
  }
  return false;
}

// Walk arbitrary JSON-safe objects and replace flagged keys + scrub JWTs.
// Returns a new value; never mutates input. Cycles aren't expected for RPC
// args/results (they're JSON-serializable by design) so no cycle guard.
function redact(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubJwt(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const k of Object.keys(value)) {
    out[k] = shouldRedactKey(k) ? "[REDACTED]" : redact(value[k]);
  }
  return out;
}

let nextIdSeq = 0;
function newId() {
  // Short, monotonic-ish id for correlating spawn/exit and in/out pairs in a
  // single process. Not a cryptographic identifier — collisions only matter
  // within ~60s windows of the same kind, and the counter handles that.
  nextIdSeq = (nextIdSeq + 1) & 0xffffffff;
  return Date.now().toString(36) + "-" + nextIdSeq.toString(36);
}

function createAuditLogger(opts) {
  const level = normalizeLevel(opts && opts.level);
  const sink = (opts && opts.sink) || ((line) => process.stdout.write(line + "\n"));
  const tailBytes = (opts && Number(opts.tailBytes)) || DEFAULT_TAIL_BYTES;
  const ctx = (opts && opts.context) || {};

  function passes(kind) {
    if (level === "off") return false;
    const head = kind.split(".")[0];
    if (head === "cli") return LEVELS[level] >= LEVELS.cli;
    if (head === "rpc") return LEVELS[level] >= LEVELS.ipc;
    if (head === "net") return LEVELS[level] >= LEVELS.net;
    return false;
  }

  function emit(kind, fields) {
    if (!passes(kind)) return;
    const record = {
      ts: new Date().toISOString(),
      kind,
      ...ctx,
      ...fields,
    };
    try {
      sink(JSON.stringify(record));
    } catch {
      // Sink failures must never break the orchestrator. Swallow.
    }
  }

  // ─── public API ──────────────────────────────────────────────────────────

  // Begin a CLI invocation. Returns a handle whose .exit() emits cli.exit
  // with the correlated id, duration, and stdout/stderr tails. Caller passes
  // raw output strings; tail truncation + JWT scrub happens here.
  function beginCli({ cmd, args, cwd, user, sessionId }) {
    const id = newId();
    const startedAt = Date.now();
    emit("cli.spawn", {
      id,
      cmd: String(cmd || ""),
      args: Array.isArray(args) ? args.map(String) : [],
      cwd: cwd || undefined,
      user: user || ctx.user,
      sessionId: sessionId || ctx.sessionId,
    });
    return {
      id,
      exit({ code, stdout, stderr, errorMessage } = {}) {
        emit("cli.exit", {
          id,
          code: code == null ? -1 : Number(code),
          durationMs: Date.now() - startedAt,
          stdoutTail: tail(stdout, tailBytes),
          stderrTail: tail(stderr, tailBytes),
          error: errorMessage || undefined,
        });
      },
    };
  }

  function beginRpc({ channel, args, user, sessionId, source }) {
    const id = newId();
    const startedAt = Date.now();
    emit("rpc.in", {
      id,
      channel: String(channel || ""),
      source: source || undefined,
      args: redact(args),
      user: user || ctx.user,
      sessionId: sessionId || ctx.sessionId,
    });
    return {
      id,
      out(result) {
        const ok = !!(result && (result.ok === undefined || result.ok));
        emit("rpc.out", {
          id,
          ok,
          durationMs: Date.now() - startedAt,
          // Full result, redacted. RPC results are small (status codes, ids,
          // error strings) so we keep the body rather than just a flag.
          result: redact(result),
        });
      },
      error(err) {
        emit("rpc.out", {
          id,
          ok: false,
          durationMs: Date.now() - startedAt,
          error: String((err && err.message) || err || "unknown"),
        });
      },
    };
  }

  function beginNet({ url, method }) {
    const id = newId();
    const startedAt = Date.now();
    emit("net.start", {
      id,
      url: scrubJwt(String(url || "")),
      method: method || "GET",
    });
    return {
      id,
      end({ status, error } = {}) {
        emit("net.end", {
          id,
          status: status == null ? null : Number(status),
          durationMs: Date.now() - startedAt,
          error: error ? String((error && error.message) || error) : undefined,
        });
      },
    };
  }

  return {
    level,
    beginCli,
    beginRpc,
    beginNet,
    // Internal-but-exposed for tests / direct emit cases. Kind must be a known
    // family (cli/rpc/net) for level filtering to apply.
    _emit: emit,
    // For instrumentation that wants to attach a per-call context (sessionId
    // captured at RPC entry, etc.) without losing the parent logger's level.
    withContext(extra) {
      return createAuditLogger({
        level,
        sink,
        tailBytes,
        context: { ...ctx, ...extra },
      });
    },
  };
}

module.exports = { createAuditLogger, LEVELS, _redact: redact, _tail: tail };

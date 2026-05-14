"use strict";
// Wires the host-agnostic orchestrator (@figaf/core) to Electron IPC.
// Replaces the former main-process/bridge.js (which inlined everything).
//
// register({ ipcMain, getWindow, app }) → for each handler key returned by
// createOrchestrator, register an ipcMain.handle(channel, payload). Streamed
// events from the orchestrator (cli:line, cli:install, cf:loggedIn, …) are
// forwarded to the renderer via webContents.send.
//
// Audit log: every CLI/RPC invocation (and HTTPS hop, at level=net) is
// written as JSON Lines to <userData>/audit.log with size-based rotation.
// Level is read from FIGAF_LOG_LEVEL at process start; default 'cli' covers
// the diagnostic use case without bloating the file.

const fs = require("fs");
const path = require("path");
const { createOrchestrator, createAuditLogger } = require("@figaf/core");
const { createHost } = require("./host.electron");

let orchestrator = null;
let auditDispose = null;

// Simple rotating file sink. The file is opened in append mode; once it
// crosses maxBytes we shift audit.log → audit.log.1 → audit.log.2 → … up to
// maxFiles. No async I/O on the hot path (write() is buffered by Node so
// the cost is just a memcpy until a tick boundary). The sink is synchronous
// for failure-mode reasons: if the disk is full or the path is unwritable,
// we want the throw caught by audit-log's emit (which swallows it) rather
// than a dangling promise rejection.
function createRotatingFileSink({ filePath, maxBytes, maxFiles }) {
  let stream = null;
  let bytesWritten = 0;

  function open() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch { /* fine if it exists */ }
    try {
      const st = fs.statSync(filePath);
      bytesWritten = st.size;
    } catch { bytesWritten = 0; }
    stream = fs.createWriteStream(filePath, { flags: "a" });
  }

  function rotate() {
    if (stream) { try { stream.end(); } catch {} stream = null; }
    // Shift audit.log.(N-1) → audit.log.N, …, audit.log → audit.log.1.
    for (let i = maxFiles - 1; i >= 1; i--) {
      const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
      const dst = `${filePath}.${i}`;
      try { fs.renameSync(src, dst); } catch { /* missing file: skip */ }
    }
    bytesWritten = 0;
    open();
  }

  open();

  function write(line) {
    if (!stream) open();
    const buf = Buffer.from(line + "\n", "utf8");
    stream.write(buf);
    bytesWritten += buf.length;
    if (bytesWritten >= maxBytes) rotate();
  }

  function close() {
    if (stream) { try { stream.end(); } catch {} stream = null; }
  }

  return { write, close };
}

function register({ ipcMain, getWindow, app }) {
  const host = createHost({ getWindow });

  function send(channel, payload) {
    const win = getWindow && getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }

  // Audit log → <userData>/audit.log with 5×5 MB rotation. If the userData
  // path isn't available (Electron not yet ready), fall back to a no-op sink
  // — the orchestrator's audit param treats undefined as off.
  let auditOpts = null;
  try {
    const userData = app && app.getPath && app.getPath("userData");
    if (userData) {
      const sinkObj = createRotatingFileSink({
        filePath: path.join(userData, "audit.log"),
        maxBytes: Number(process.env.FIGAF_LOG_MAX_BYTES) || 5 * 1024 * 1024,
        maxFiles: Number(process.env.FIGAF_LOG_MAX_FILES) || 5,
      });
      auditDispose = sinkObj.close;
      auditOpts = {
        level: process.env.FIGAF_LOG_LEVEL || "cli",
        tailBytes: Number(process.env.FIGAF_LOG_TAIL_BYTES) || undefined,
        sink: sinkObj.write,
      };
    }
  } catch { /* fall through; audit stays a no-op */ }
  const audit = auditOpts ? createAuditLogger(auditOpts) : undefined;

  orchestrator = createOrchestrator({ host, send, audit });

  for (const [channel, handler] of Object.entries(orchestrator.handlers)) {
    ipcMain.handle(channel, async (_evt, payload) => {
      if (!audit) return handler(payload || {});
      const h = audit.beginRpc({ channel, args: payload || {}, source: "ipc" });
      try {
        const result = await handler(payload || {});
        h.out(result);
        return result;
      } catch (err) {
        h.error(err);
        throw err;
      }
    });
  }
}

function dispose() {
  if (orchestrator) {
    try { orchestrator.dispose(); } catch {}
    orchestrator = null;
  }
  if (auditDispose) {
    try { auditDispose(); } catch {}
    auditDispose = null;
  }
}

module.exports = { register, dispose };

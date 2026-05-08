"use strict";
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { createOrchestrator, DEPLOYMENT_ZIP_URL } = require("../lib/cli-orchestrator");

const PORT = process.env.PORT || 8080;
// Random per-boot secret — all sessions invalidate on container restart (acceptable for wizard use-case).
const SESSION_SECRET = crypto.randomBytes(32).toString("hex");
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour idle expiry

// ─── Session store ─────────────────────────────────────────────────────────────

const sessions = new Map(); // sessionId → { handlers, dispose, wsClients, lastSeen }

function newSession(sessionId) {
  const wsClients = new Set();

  function send(channel, payload) {
    const frame = JSON.stringify({ channel, payload });
    for (const ws of wsClients) {
      if (ws.readyState === 1 /* OPEN */) ws.send(frame);
    }
  }

  const host = {
    getUserDataDir: () => path.join(os.homedir(), "sessions", sessionId),
    resolveBinary: (name) => {
      const bundled = path.join(__dirname, "..", "bin", name);
      // Dev fallback: if the Linux binary hasn't been downloaded yet, use the
      // system-installed CLI (works on a Windows/Mac dev machine with btp+cf on PATH)
      if (!fs.existsSync(bundled) && process.env.NODE_ENV !== "production") return name;
      return bundled;
    },
    openExternal: () => Promise.resolve(),
    pickFile: () => Promise.resolve(null),
    readClipboard: () => Promise.resolve(""),
    resolveDeployTemplate: () => ({
      kind: "github",
      src:
        process.env.FIGAF_DEPLOYMENT_ZIP_URL ||
        "https://github.com/figaf/Figaf-BTP-Deployment/archive/refs/heads/btp-users.zip",
    }),
    isHosted: true,
  };

  const { handlers, dispose } = createOrchestrator({ host, send });
  const sess = { handlers, dispose, wsClients, lastSeen: Date.now() };
  sessions.set(sessionId, sess);
  return sess;
}

function getOrCreateSession(sessionId) {
  let sess = sessions.get(sessionId);
  if (sess) { sess.lastSeen = Date.now(); return sess; }
  return newSession(sessionId);
}

// Prune idle sessions every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, sess] of sessions) {
    if (sess.lastSeen < cutoff) {
      try { sess.dispose(); } catch {}
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

// ─── Signed-cookie helpers ─────────────────────────────────────────────────────
// Mirrors the cookie-signature package (used by cookie-parser) so we can verify
// signed cookies in the WS upgrade handler where middleware doesn't run.

function signCookieValue(val) {
  const mac = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return "s:" + val + "." + mac;
}

function unsignCookieValue(signed) {
  if (!signed || !signed.startsWith("s:")) return null;
  const inner = signed.slice(2);
  const dot = inner.lastIndexOf(".");
  if (dot === -1) return null;
  const val = inner.slice(0, dot);
  const mac = inner.slice(dot + 1);
  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  return val;
}

function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function sessionIdFromReq(req) {
  const cookies = parseCookieHeader(req.headers.cookie);
  const raw = cookies["figaf_session"];
  if (!raw) return null;
  return unsignCookieValue(raw);
}

// ─── Session middleware ────────────────────────────────────────────────────────

function sessionMiddleware(req, res, next) {
  let sessionId = sessionIdFromReq(req);
  if (!sessionId) {
    sessionId = crypto.randomBytes(16).toString("hex");
    const cookieVal = encodeURIComponent(signCookieValue(sessionId));
    const attrs = [
      `figaf_session=${cookieVal}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${4 * 60 * 60}`,
    ];
    if (process.env.NODE_ENV === "production") attrs.push("Secure");
    res.setHeader("Set-Cookie", attrs.join("; "));
  }
  req.sessionId = sessionId;
  next();
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(sessionMiddleware);

const rootDir = path.join(__dirname, "..");
const installerDir = path.join(rootDir, "installer");

// Static: installer UI assets (JSX, CSS)
app.use("/installer", express.static(installerDir));

// Static: logo — installer's "../figaf-logo.png" resolves to /figaf-logo.png in browser
app.get("/figaf-logo.png", (_req, res) => res.sendFile(path.join(rootDir, "figaf-logo.png")));

// Static: browser shim
app.get("/cloud/client.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.sendFile(path.join(__dirname, "client.js"));
});

// Root: serve templated index.html with mode-flag injection
app.get("/", (req, res) => {
  const tmpl = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const injection = [
    "<script>",
    `window.figafMode = "hosted";`,
    `window.figafSession = ${JSON.stringify({ sessionId: req.sessionId })};`,
    "</script>",
  ].join("\n");
  const html = tmpl.replace("<!-- FIGAF_MODE_INJECT -->", injection);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// RPC: POST /rpc/:channel → orchestrator handler
app.post("/rpc/:channel", async (req, res) => {
  const { channel } = req.params;
  const sess = getOrCreateSession(req.sessionId);
  const handler = sess.handlers[channel];
  if (!handler) {
    return res.status(404).json({ ok: false, error: `Unknown channel: ${channel}` });
  }
  try {
    const result = await handler(req.body || {});
    res.json(result !== undefined ? result : { ok: true });
  } catch (err) {
    console.error(`[rpc] ${channel} error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── HTTP + WebSocket server ────────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/stream" });

wss.on("connection", (ws, req) => {
  const sessionId = sessionIdFromReq(req);
  if (!sessionId) {
    ws.close(4001, "No valid session cookie");
    return;
  }
  const sess = getOrCreateSession(sessionId);
  sess.wsClients.add(ws);
  ws.on("close", () => sess.wsClients.delete(ws));
  ws.on("error", () => sess.wsClients.delete(ws));
  // Simple ping/pong keepalive
  ws.on("message", (data) => {
    try {
      if (JSON.parse(data).ping) ws.send(JSON.stringify({ pong: true }));
    } catch {}
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`figaf-manager listening on :${PORT}`);
  console.log(`DEPLOYMENT_ZIP_URL: ${DEPLOYMENT_ZIP_URL}`);
});

// ─── Graceful shutdown (CF SIGTERM) ────────────────────────────────────────────

process.on("SIGTERM", () => {
  for (const sess of sessions.values()) {
    try { sess.dispose(); } catch {}
  }
  server.close(() => process.exit(0));
});

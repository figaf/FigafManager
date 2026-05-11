"use strict";
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { createOrchestrator, DEPLOYMENT_ZIP_URL } = require("@figaf/core");
const { createHost } = require("../host.cloud");
const auth = require("./auth");

const PORT = process.env.PORT || 8080;
// Random per-boot secret — all sessions invalidate on container restart (acceptable for wizard use-case).
const SESSION_SECRET = crypto.randomBytes(32).toString("hex");
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour idle expiry

// ─── Session store ─────────────────────────────────────────────────────────────

const sessions = new Map(); // sessionId → { handlers, dispose, wsClients, lastSeen }

function newSession(sessionId) {
  const wsClients = new Set();

  function send(channel, payload) {
    // Defensive downstream redaction layer (auth-gate plan §1.4).
    // cli:line text is scrubbed for base64url-shaped tokens before fan-out.
    // The boot [SETUP] line is printed via console.log (not cli:line), so the
    // operator's only copy of the token never crosses this seam — this is
    // belt-and-braces in case future orchestrator code accidentally echoes it.
    let outPayload = payload;
    if (channel === "cli:line" && payload && typeof payload.text === "string") {
      const redacted = auth.redact(payload.text);
      if (redacted !== payload.text) {
        outPayload = Object.assign({}, payload, { text: redacted });
      }
    }
    const frame = JSON.stringify({ channel, payload: outPayload });
    for (const ws of wsClients) {
      if (ws.readyState === 1 /* OPEN */) ws.send(frame);
    }
  }

  const host = createHost({ sessionId });
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

// ─── Auth gate (v1 token model) ────────────────────────────────────────────
// See auth-gate-implementation-plan.md Part I. The cookie issued by
// /setup/claim is checked on every gated request via auth.verifyAuth().

function requireAuth(req, res, next) {
  const v = auth.verifyAuth(req);
  if (v.ok) return next();
  // Browser-style HTML GETs (anything except /rpc/* and not XHR) get a 302
  // redirect to /setup so the operator lands on the claim page. RPC clients
  // get a structured 401 they can react to.
  const isRpc = req.path.startsWith("/rpc/");
  const accept = String(req.headers["accept"] || "");
  const wantsHtml = !isRpc && (req.method === "GET") && (accept.includes("text/html") || accept === "" || accept.includes("*/*"));
  if (wantsHtml) {
    res.redirect(302, "/setup");
    return;
  }
  res.status(401).json({ ok: false, error: "unauthenticated", reason: v.reason });
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(sessionMiddleware);

// Shared renderer lives in @figaf/ui (resolved through the workspace symlink in
// node_modules); we keep the public URL prefix /installer so the cloud-mode
// index.html template doesn't need to change.
const installerDir = path.dirname(require.resolve("@figaf/ui/package.json"));

// Static (ungated): installer UI assets (JSX, CSS) — public source code, no
// secrets. Gating them adds friction (Babel-standalone fetches mode.js before
// the auth cookie is set during the post-claim navigation) without security
// benefit.
app.use("/installer", express.static(installerDir));

// Static (ungated): logo
app.get("/figaf-logo.png", (_req, res) => res.sendFile(path.join(installerDir, "figaf-logo.png")));

// Static (ungated): browser shim
app.get("/cloud/client.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.sendFile(path.join(__dirname, "client.js"));
});

// ─── /setup (ungated) ───────────────────────────────────────────────────────
// Operator-facing claim flow. The page is intentionally vanilla HTML; no React,
// no module imports, so it cannot be locked out by the same kind of failure
// that would lock the wizard out.

app.get("/setup", (req, res) => {
  if (auth.isClaimed()) {
    // Browser convention: still serve the page so the operator can see the
    // "already-claimed" copy. The form will receive 410 on submit; matches §1.6.
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "setup.html"));
});

app.post("/setup/claim", (req, res) => {
  const submitted = (req.body && typeof req.body.token === "string") ? req.body.token.trim() : "";
  const v = auth.verifySetupToken(submitted);
  if (!v.ok) {
    if (v.code === "ALREADY_CLAIMED" || v.code === "NO_TOKEN") {
      // NO_TOKEN here means "hash already wiped post-claim" → semantically Gone.
      return res.status(410).json({ ok: false, error: "already_claimed" });
    }
    return res.status(401).json({ ok: false, error: "invalid_token" });
  }
  const ip = auth.clientIp(req);
  const ua = req.headers["user-agent"] || "";
  auth.recordClaim({ ip, ua });
  // Audit line: token is gone from memory; mark the log boundary.
  console.log("[SETUP] Token redacted post-claim");
  auth.issueCookie(res, { ip, ua });
  res.status(200).json({ ok: true, redirect: "/" });
});

// ─── Gated surface ─────────────────────────────────────────────────────────

// Root: serve templated index.html with mode-flag injection (gated).
app.get("/", requireAuth, (req, res) => {
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

// RPC: POST /rpc/:channel → orchestrator handler (gated).
app.post("/rpc/:channel", requireAuth, async (req, res) => {
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
// `noServer: true` — we own the upgrade event so we can authenticate BEFORE
// the WS handshake completes. Once handleUpgrade resolves, we can no longer
// send an HTTP error code; pre-upgrade is the only correct seam (plan Q4).
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  // Only intercept our /stream path; let other upgrade-able protocols pass.
  const url = req.url || "";
  if (!url.startsWith("/stream")) {
    socket.destroy();
    return;
  }
  const v = auth.verifyAuth(req);
  if (!v.ok) {
    // RFC 6455: before upgrade, respond with a real HTTP status. The browser
    // surfaces this as a WS construction error; client.js handles it.
    socket.write(
      "HTTP/1.1 401 Unauthorized\r\n" +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n" +
      "\r\n"
    );
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const sessionId = sessionIdFromReq(req);
  if (!sessionId) {
    // Should be unreachable: requireAuth on /rpc/* and sessionMiddleware on
    // the upgrade request both run, but defensively close with 4003 (auth)
    // rather than 4001 (no session) so the client redirects to /setup.
    ws.close(4003, "Unauthenticated");
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

// ─── Boot: mint setup token + emit [SETUP] line BEFORE app.listen() ────────
// One-shot operation. The cleartext is printed to stdout exactly once; the
// SHA-256 hash lives in cloud/auth.js module state for the lifetime of the
// process. Cockpit operator reads this line from the Logs view to claim.
function bootMintToken() {
  const token = auth.generateSetupToken();
  console.log(auth.formatSetupLogLine(token));
  if (auth.secretIsEphemeral) {
    console.log(
      "[INFO] FIGAF_AUTH_SECRET not set — using ephemeral per-boot secret. " +
      "All sessions will invalidate on restart."
    );
  }
  // T+5min audit boundary marker. If the operator claims earlier, the
  // /setup/claim handler emits the same line; this timer ensures the marker
  // appears even if the operator never claims (token-rotation story is
  // "redeploy the app").
  setTimeout(() => {
    if (auth.isClaimed()) return; // claim handler already emitted the line
    console.log("[SETUP] Token redacted post-claim");
  }, 5 * 60 * 1000).unref();
}

// Only run boot side-effects + .listen() when invoked as the main entry-point
// (e.g., `node server.js`). When the test runner require()s this file, it
// gets the Express app, HTTP server, and WS server without auto-starting.
if (require.main === module) {
  bootMintToken();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`figaf-manager listening on :${PORT}`);
    console.log(`DEPLOYMENT_ZIP_URL: ${DEPLOYMENT_ZIP_URL}`);
  });

  // ─── Graceful shutdown (CF SIGTERM) ──────────────────────────────────────
  process.on("SIGTERM", () => {
    for (const sess of sessions.values()) {
      try { sess.dispose(); } catch {}
    }
    server.close(() => process.exit(0));
  });
}

// ─── Test seam ─────────────────────────────────────────────────────────────
// Tests require("./server") and start the server on a random port themselves.
module.exports = { app, server, wss, sessions, bootMintToken };

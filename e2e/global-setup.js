"use strict";
// Boots the real cloud server locally, claims the single-use setup token,
// and seeds the browser session's scoped CF_HOME with the developer's own
// cf login (see e2e/README.md — dev machine only, never product code).
// Returns a teardown function that stops the server.

const { chromium } = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 8087;
const BASE = `http://127.0.0.1:${PORT}`;

module.exports = async () => {
  const appDir = path.join(__dirname, "..", "apps", "figaf-manager");
  const child = spawn(process.execPath, ["cloud/server.js"], {
    cwd: appDir,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // The setup token is printed exactly once to stdout at boot.
  let out = "";
  const token = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("no [SETUP] token within 15s. Server output:\n" + out)),
      15_000
    );
    const onData = (d) => {
      out += d.toString();
      const m = /\[SETUP\] Token: (\S+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code}). Output:\n` + out));
    });
  });
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (/listening on :/.test(out)) return resolve();
      if (Date.now() - t0 > 15_000) return reject(new Error("server not listening. Output:\n" + out));
      setTimeout(poll, 100);
    })();
  });

  // Claim from a real browser context: the auth cookie is HMAC-bound to the
  // claiming IP + user agent, so the claim must use the same UA the specs use.
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  const resp = await page.request.post("/setup/claim", { data: { token } });
  if (!resp.ok()) {
    throw new Error(`setup claim failed: HTTP ${resp.status()} ${await resp.text()}`);
  }

  // Load the app once so the server mints the wizard session (figaf_session
  // cookie + server-side state), then seed that session's scoped CF_HOME with
  // the developer's own cf login so `session:state` resumes as signed-in.
  await page.goto("/");
  const sid = await page.evaluate(
    () => window.figafSession && window.figafSession.sessionId
  );
  if (!sid || !/^[0-9a-f]{32}$/.test(String(sid))) {
    throw new Error("could not read the wizard session id from the page");
  }
  const cfConfig = path.join(os.homedir(), ".cf", "config.json");
  if (fs.existsSync(cfConfig)) {
    // cf reads $CF_HOME/.cf/config.json — note the .cf level.
    const dstDir = path.join(os.homedir(), "sessions", sid, "cli", ".cf");
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(cfConfig, path.join(dstDir, "config.json"));
  } else {
    // Specs that need a signed-in session will fail with a clear message.
    console.warn("[e2e] no ~/.cf/config.json — run `cf login` once; continuing without a seeded session");
  }

  fs.mkdirSync(path.join(__dirname, ".auth"), { recursive: true });
  await context.storageState({ path: path.join(__dirname, ".auth", "state.json") });
  await browser.close();

  return async () => {
    try { child.kill(); } catch { /* already gone */ }
  };
};

"use strict";
// Boots the real cloud server(s) locally, claims each single-use setup token,
// and seeds every browser session's scoped CF_HOME with the developer's own
// cf login (see e2e/README.md — dev machine only, never product code).
// Returns a teardown function that stops the servers.
//
// Servers (pick with E2E_SERVERS=main,failure; default: both):
//   main     :8087  the bundled release (apps/figaf-manager/l3-artifacts).
//                   The read-only console specs and the deliberate install
//                   smoke (*.mutating.spec.js) run here.
//   failure  :8088  the fixture release e2e/fixtures/release-missing-service:
//                   its platform base needs a service instance that does not
//                   exist, so every Install is refused EARLY, before any cf
//                   change. failure-visibility.spec.js runs here.
//
// Both servers run with apps/figaf-manager as their working directory — the
// same shape as the CF container (manifest.yml next to the server). A
// manifest leaking into `cf push` therefore shows up locally exactly as it
// did live on 2026-09-03.

const { chromium } = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SERVERS = {
  main: { port: 8087, state: "state.json", env: {} },
  failure: {
    port: 8088,
    state: "state-failure.json",
    env: { FIGAF_L3_ARTIFACTS_DIR: path.join(__dirname, "fixtures", "release-missing-service") },
  },
};

async function bootServer(name, def) {
  const tag = `[e2e:${name}]`;
  const appDir = path.join(__dirname, "..", "apps", "figaf-manager");
  const base = `http://127.0.0.1:${def.port}`;
  const child = spawn(process.execPath, ["cloud/server.js"], {
    cwd: appDir,
    env: { ...process.env, ...def.env, PORT: String(def.port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // The setup token is printed exactly once to stdout at boot.
  let out = "";
  const token = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${tag} no [SETUP] token within 15s. Server output:\n` + out)),
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
      reject(new Error(`${tag} server exited early (code ${code}). Output:\n` + out));
    });
  });
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (/listening on :/.test(out)) return resolve();
      if (Date.now() - t0 > 15_000) return reject(new Error(`${tag} server not listening. Output:\n` + out));
      setTimeout(poll, 100);
    })();
  });

  // Claim from a real browser context: the auth cookie is HMAC-bound to the
  // claiming IP + user agent, so the claim must use the same UA the specs use.
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: base });
  const page = await context.newPage();
  const resp = await page.request.post("/setup/claim", { data: { token } });
  if (!resp.ok()) {
    throw new Error(`${tag} setup claim failed: HTTP ${resp.status()} ${await resp.text()}`);
  }

  // Load the app once so the server mints the wizard session (figaf_session
  // cookie + server-side state), then seed that session's scoped CF_HOME with
  // the developer's own cf login so `session:state` resumes as signed-in.
  await page.goto("/");
  const sid = await page.evaluate(
    () => window.figafSession && window.figafSession.sessionId
  );
  if (!sid || !/^[0-9a-f]{32}$/.test(String(sid))) {
    throw new Error(`${tag} could not read the wizard session id from the page`);
  }
  const cfConfig = path.join(os.homedir(), ".cf", "config.json");
  if (fs.existsSync(cfConfig)) {
    // cf reads $CF_HOME/.cf/config.json — note the .cf level.
    const dstDir = path.join(os.homedir(), "sessions", sid, "cli", ".cf");
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(cfConfig, path.join(dstDir, "config.json"));
  } else {
    // Specs that need a signed-in session will fail with a clear message.
    console.warn(`${tag} no ~/.cf/config.json — run \`cf login\` once; continuing without a seeded session`);
  }

  fs.mkdirSync(path.join(__dirname, ".auth"), { recursive: true });
  await context.storageState({ path: path.join(__dirname, ".auth", def.state) });
  await browser.close();
  return child;
}

module.exports = async () => {
  const wanted = (process.env.E2E_SERVERS || "main,failure").split(",").map((s) => s.trim()).filter(Boolean);
  const children = [];
  try {
    for (const name of wanted) {
      if (!SERVERS[name]) throw new Error(`unknown e2e server '${name}' (known: ${Object.keys(SERVERS).join(", ")})`);
      children.push(await bootServer(name, SERVERS[name]));
    }
  } catch (e) {
    for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
    throw e;
  }
  return async () => {
    for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  };
};

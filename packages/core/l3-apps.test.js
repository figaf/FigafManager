"use strict";
// Tests for the L3 App Manager PoC (l3-apps.js).
//
// Coverage:
//   A. Pure helpers: loadCatalog validation, computeAppStatus rollup,
//      buildPushArgs, buildDestinationsEnv, validateConfigEnv whitelist.
//   B. Handler flows with an injected fake `run` recorder (no processes):
//      - l3:install happy path — command order per CF app:
//        push --no-start → bind-service (required + optional-if-present)
//        → set-env (masked) → start; frontend gets a destinations env
//        pointing at the backend route.
//      - required bind failure aborts the install.
//      - l3:configure — whitelist enforced, values masked in logCmd/auditArgs,
//        restart follows, unknown key rejected.
//      - l3:disable stops in reverse order; l3:remove deletes in reverse order.
//      - l3:status maps /v3 responses to app status + installed version.
//      - l3:health hits <route><healthPath> via httpsText.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  VERSION_ENV,
  loadCatalog,
  computeAppStatus,
  buildDestinationsEnv,
  buildPushArgs,
  validateConfigEnv,
  createL3Handlers,
} = require("./l3-apps");

// ─── fixtures ────────────────────────────────────────────────────────────────

const CATALOG = {
  channelVersion: "0.2.0",
  apps: [
    {
      id: "arch",
      name: "B2B Archiving Setup",
      version: "0.2.0",
      cfApps: [
        {
          name: "arch-backend", artifact: "backend.zip", buildpack: "nodejs_buildpack",
          memory: "256M", disk: "1024M",
          services: ["db", "xsuaa"], optionalServices: ["credstore"],
          env: { FIGAF_PAGE_SIZE: "200" },
        },
        {
          name: "arch-frontend", artifact: "frontend.zip", buildpack: "nodejs_buildpack",
          memory: "128M", disk: "512M",
          services: ["xsuaa"],
          destinationTo: "arch-backend", destinationName: "figaf-b2b-gov-backend",
        },
      ],
      configForm: [
        { key: "FIGAF_BASE_URL", secret: false },
        { key: "FIGAF_API_CLIENT_SECRET", secret: true },
      ],
      healthPath: "/health/connections",
    },
  ],
};

function makeChannelDir(catalog = CATALOG) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l3-test-"));
  fs.writeFileSync(path.join(dir, "catalog.json"), JSON.stringify(catalog));
  fs.writeFileSync(path.join(dir, "backend.zip"), "zip");
  fs.writeFileSync(path.join(dir, "frontend.zip"), "zip");
  return dir;
}

/**
 * Fake ctx for createL3Handlers. `responses` maps a predicate over the args
 * array to a canned { code, stdout }. Calls are recorded in `calls`
 * ({ args, opts }); log lines in `logLines`.
 */
function makeCtx(channelDir, respond) {
  const calls = [];
  const logLines = [];
  const events = [];
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "l3-user-"));
  return {
    calls, logLines, events,
    ctx: {
      host: {
        isHosted: true,
        getUserDataDir: () => userDir,
        resolveL3ArtifactsDir: () => channelDir,
      },
      run: async (cmd, args, opts = {}) => {
        calls.push({ cmd, args, opts });
        logLines.push(opts.logCmd || `${cmd} ${args.join(" ")}`);
        return respond(args, opts) || { code: 0, stdout: "", stderr: "" };
      },
      log: (source, type, text) => logLines.push(text),
      send: (channel, payload) => events.push({ channel, payload }),
      resolveCf: () => "cf",
      extractZip: async () => {},
      httpsText: async (url) => { events.push({ channel: "httpsText", payload: url }); return "{\"ok\":true}"; },
      // health endpoints return diagnostics WITH non-2xx statuses; the ctx
      // fetcher must hand back both. Tests override `httpsBodyResult`.
      httpsBody: async (url) => {
        events.push({ channel: "httpsBody", payload: url });
        return httpsBodyResult;
      },
    },
  };
}

let httpsBodyResult = { status: 200, body: "{\"ok\":true}" };

// ─── A. pure helpers ─────────────────────────────────────────────────────────

test("loadCatalog: accepts a valid catalog", () => {
  const dir = makeChannelDir();
  const r = loadCatalog(dir);
  assert.equal(r.ok, true);
  assert.equal(r.catalog.apps[0].id, "arch");
});

test("loadCatalog: missing file / bad JSON / missing fields are rejected", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "l3-empty-"));
  assert.equal(loadCatalog(empty).ok, false);

  const badJson = fs.mkdtempSync(path.join(os.tmpdir(), "l3-bad-"));
  fs.writeFileSync(path.join(badJson, "catalog.json"), "{nope");
  assert.equal(loadCatalog(badJson).ok, false);

  const noApps = fs.mkdtempSync(path.join(os.tmpdir(), "l3-noapps-"));
  fs.writeFileSync(path.join(noApps, "catalog.json"), JSON.stringify({ apps: [{ id: "x", version: "1", cfApps: [] }] }));
  assert.equal(loadCatalog(noApps).ok, false);
});

test("computeAppStatus rollup", () => {
  assert.equal(computeAppStatus([{ exists: false }, { exists: false }]), "not-installed");
  assert.equal(computeAppStatus([{ exists: true, state: "STARTED" }, { exists: false }]), "partial");
  assert.equal(computeAppStatus([{ exists: true, state: "STARTED" }, { exists: true, state: "STARTED" }]), "running");
  assert.equal(computeAppStatus([{ exists: true, state: "STOPPED" }, { exists: true, state: "STOPPED" }]), "stopped");
  assert.equal(computeAppStatus([{ exists: true, state: "STARTED" }, { exists: true, state: "STOPPED" }]), "mixed");
});

test("buildPushArgs / buildDestinationsEnv", () => {
  const args = buildPushArgs(CATALOG.apps[0].cfApps[0], "/tmp/x", { noStart: true });
  assert.deepEqual(args, ["push", "arch-backend", "-p", "/tmp/x", "-b", "nodejs_buildpack", "-m", "256M", "-k", "1024M", "--no-start"]);
  const dest = JSON.parse(buildDestinationsEnv("figaf-b2b-gov-backend", "https://x.example"));
  assert.deepEqual(dest, [{ name: "figaf-b2b-gov-backend", url: "https://x.example", forwardAuthToken: true }]);
});

test("validateConfigEnv: whitelist, empty-skip, type and length checks", () => {
  const app = CATALOG.apps[0];
  const ok = validateConfigEnv(app, { FIGAF_BASE_URL: "https://f", FIGAF_API_CLIENT_SECRET: "s3cret", });
  assert.equal(ok.ok, true);
  assert.equal(ok.entries.length, 2);
  assert.equal(ok.entries.find(e => e.key === "FIGAF_API_CLIENT_SECRET").secret, true);

  assert.equal(validateConfigEnv(app, { NOT_ALLOWED: "x" }).ok, false);
  assert.equal(validateConfigEnv(app, { FIGAF_BASE_URL: 42 }).ok, false);
  assert.equal(validateConfigEnv(app, { FIGAF_BASE_URL: "x".repeat(5000) }).ok, false);

  const skip = validateConfigEnv(app, { FIGAF_BASE_URL: "" });
  assert.equal(skip.ok, true);
  assert.equal(skip.entries.length, 0);
});

// ─── B. handler flows ────────────────────────────────────────────────────────

test("l3:install: full command sequence, optional bind skipped when absent, destinations env set", async () => {
  const dir = makeChannelDir();
  const { ctx, calls, logLines } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[1] === "arch-backend" && args[2] === "--guid") return { code: 1, stdout: "" }; // fresh
    if (args[0] === "app" && args[1] === "arch-frontend" && args[2] === "--guid") return { code: 1, stdout: "" };
    if (args[0] === "service" && args[1] === "credstore") return { code: 1, stdout: "" }; // optional absent
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "name: arch-backend\nroutes:   arch-backend.cfapps.eu10.hana.ondemand.com\n" };
    return { code: 0, stdout: "" };
  });
  const handlers = createL3Handlers(ctx);
  const r = await handlers["l3:install"]({ appId: "arch" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.version, "0.2.0");

  const seq = calls.map((c) => c.args.slice(0, 2).join(" "));
  // backend: push --no-start … bind db, bind xsuaa, (probe credstore), env×2, start
  assert.ok(seq.includes("push arch-backend"));
  assert.ok(seq.includes("bind-service arch-backend"));
  assert.ok(seq.includes("start arch-backend"));
  // optional service absent → no bind of credstore
  assert.ok(!calls.some((c) => c.args[0] === "bind-service" && c.args[2] === "credstore"));
  // version stamp on both apps
  const stamps = calls.filter((c) => c.args[0] === "set-env" && c.args[2] === VERSION_ENV);
  assert.equal(stamps.length, 2);
  assert.equal(stamps[0].args[3], "0.2.0");
  // frontend destinations env carries the backend route
  const destSet = calls.find((c) => c.args[0] === "set-env" && c.args[1] === "arch-frontend" && c.args[2] === "destinations");
  assert.ok(destSet, "destinations env must be set on the frontend");
  assert.match(destSet.args[3], /arch-backend\.cfapps\.eu10/);
  // backend pushed before frontend
  assert.ok(seq.indexOf("push arch-backend") < seq.indexOf("push arch-frontend"));
  // env values are masked in the terminal stream
  assert.ok(logLines.some((l) => /set-env .*<value hidden>/.test(l)));
  assert.ok(!logLines.some((l) => l.includes("cfapps.eu10") && l.startsWith("cf set-env")));
});

test("l3:install: required bind failure aborts with an error", async () => {
  const dir = makeChannelDir();
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[2] === "--guid") return { code: 1, stdout: "" };
    if (args[0] === "bind-service" && args[2] === "db") return { code: 1, stdout: "", stderr: "not found" };
    return { code: 0, stdout: "" };
  });
  const handlers = createL3Handlers(ctx);
  const r = await handlers["l3:install"]({ appId: "arch" });
  assert.equal(r.ok, false);
  assert.match(r.error, /bind-service db failed/);
  assert.equal(r.failedApp, "arch-backend");
  // frontend never touched
  assert.ok(!calls.some((c) => c.args.includes("arch-frontend")));
});

test("l3:update on an existing app: set-env then push (no --no-start, no bind)", async () => {
  const dir = makeChannelDir();
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[2] === "--guid") return { code: 0, stdout: "guid" }; // exists
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "routes:   b.example.com\n" };
    return { code: 0, stdout: "" };
  });
  const handlers = createL3Handlers(ctx);
  const r = await handlers["l3:update"]({ appId: "arch" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!calls.some((c) => c.args.includes("--no-start")));
  assert.ok(!calls.some((c) => c.args[0] === "bind-service"));
  assert.ok(calls.some((c) => c.args[0] === "push" && c.args[1] === "arch-backend"));
});

test("l3:configure: masked set-env + restart; unknown key rejected; not-deployed rejected", async () => {
  const dir = makeChannelDir();
  let exists = true;
  const { ctx, calls, logLines } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[2] === "--guid") return { code: exists ? 0 : 1, stdout: "" };
    return { code: 0, stdout: "" };
  });
  const handlers = createL3Handlers(ctx);

  const r = await handlers["l3:configure"]({ appId: "arch", env: { FIGAF_API_CLIENT_SECRET: "super-secret" } });
  assert.equal(r.ok, true);
  assert.equal(r.applied, 1);
  const setCall = calls.find((c) => c.args[0] === "set-env");
  assert.equal(setCall.args[3], "super-secret");                       // real value reaches cf
  assert.ok(!logLines.some((l) => l.includes("super-secret")));        // …but never the terminal
  assert.deepEqual(setCall.opts.auditArgs.slice(-1), ["<value hidden>"]); // …or the audit log
  assert.ok(calls.some((c) => c.args[0] === "restart" && c.args[1] === "arch-backend"));

  const bad = await handlers["l3:configure"]({ appId: "arch", env: { EVIL: "x" } });
  assert.equal(bad.ok, false);

  exists = false;
  const notDeployed = await handlers["l3:configure"]({ appId: "arch", env: { FIGAF_BASE_URL: "https://x" } });
  assert.equal(notDeployed.ok, false);
  assert.match(notDeployed.error, /not deployed/);
});

test("l3:disable stops frontend before backend; l3:remove deletes in the same reverse order", async () => {
  const dir = makeChannelDir();
  const { ctx, calls } = makeCtx(dir, () => ({ code: 0, stdout: "" }));
  const handlers = createL3Handlers(ctx);

  await handlers["l3:disable"]({ appId: "arch" });
  const stops = calls.filter((c) => c.args[0] === "stop").map((c) => c.args[1]);
  assert.deepEqual(stops, ["arch-frontend", "arch-backend"]);

  calls.length = 0;
  await handlers["l3:remove"]({ appId: "arch" });
  const dels = calls.filter((c) => c.args[0] === "delete").map((c) => c.args[1]);
  assert.deepEqual(dels, ["arch-frontend", "arch-backend"]);
  assert.ok(calls.every((c) => c.args[0] !== "delete" || c.args[2] === "-f"));
});

test("l3:status: rolls up states, reads FIGAF_APP_VERSION and routes", async () => {
  const dir = makeChannelDir();
  const { ctx } = makeCtx(dir, (args) => {
    if (args[0] === "target") return { code: 0, stdout: "org: o\nspace: myspace\n" };
    if (args[0] === "space") return { code: 0, stdout: "space-guid-1\n" };
    if (args[0] === "curl" && /\/v3\/apps\?/.test(args[1])) {
      return { code: 0, stdout: JSON.stringify({ resources: [
        { name: "arch-backend", guid: "g1", state: "STARTED" },
        { name: "arch-frontend", guid: "g2", state: "STARTED" },
      ] }) };
    }
    if (args[0] === "curl" && args[1] === "/v3/apps/g1/environment_variables") {
      return { code: 0, stdout: JSON.stringify({ var: { [VERSION_ENV]: "0.1.9" } }) };
    }
    if (args[0] === "curl" && /routes$/.test(args[1])) {
      return { code: 0, stdout: JSON.stringify({ resources: [{ url: "arch.example.com" }] }) };
    }
    return { code: 0, stdout: "" };
  });
  const handlers = createL3Handlers(ctx);
  const r = await handlers["l3:status"]();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.apps[0].status, "running");
  assert.equal(r.apps[0].installedVersion, "0.1.9");
  assert.equal(r.apps[0].catalogVersion, "0.2.0");
  assert.equal(r.apps[0].parts[0].route, "arch.example.com");
});

test("l3:health: GETs route + healthPath and parses JSON", async () => {
  const dir = makeChannelDir();
  const { ctx, events } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "routes:   arch.example.com\n" };
    return { code: 0, stdout: "" };
  });
  const handlers = createL3Handlers(ctx);

  httpsBodyResult = { status: 200, body: "{\"ok\":true}" };
  const r = await handlers["l3:health"]({ appId: "arch" });
  assert.equal(r.ok, true);
  assert.equal(r.httpStatus, 200);
  assert.equal(r.url, "https://arch.example.com/health/connections");
  assert.deepEqual(r.body, { ok: true });
  assert.ok(events.some((e) => e.channel === "httpsBody" && e.payload === r.url));

  // 503 with a diagnostic body (unconfigured connections): body must survive.
  httpsBodyResult = { status: 503, body: "{\"ok\":false,\"postgres\":{\"ok\":true}}" };
  const bad = await handlers["l3:health"]({ appId: "arch" });
  assert.equal(bad.ok, false);
  assert.equal(bad.httpStatus, 503);
  assert.deepEqual(bad.body, { ok: false, postgres: { ok: true } });
});

test("l3:figafSystems: finds app+router pairs running figaf/app images, returns router URLs", async () => {
  const dir = makeChannelDir();
  const { ctx } = makeCtx(dir, (args) => {
    if (args[0] === "curl" && /\/v3\/apps\?/.test(args[1])) {
      return { code: 0, stdout: JSON.stringify({ pagination: {}, resources: [
        { name: "qa-figaf-app",    guid: "a1", state: "STARTED" },   // internal CI image (ilnfigaf)
        { name: "qa-figaf-router", guid: "r1", state: "STARTED" },
        { name: "demo-app",        guid: "a4", state: "STARTED" },   // official image, no "figaf" in id
        { name: "demo-router",     guid: "r4", state: "STARTED" },
        { name: "lonely-app",      guid: "a2", state: "STARTED" },   // no router → skipped
        { name: "other-app",       guid: "a3", state: "STARTED" },   // wrong image
        { name: "other-router",    guid: "r3", state: "STARTED" },
        { name: "figaf-manager",   guid: "m1", state: "STARTED" },   // no pair pattern
      ] }) };
    }
    if (args[1] === "/v3/apps/a1/droplets/current") return { code: 0, stdout: JSON.stringify({ image: "ilnfigaf/app:2608.1-btp" }) };
    if (args[1] === "/v3/apps/a4/droplets/current") return { code: 0, stdout: JSON.stringify({ image: "figaf/app:2608-btp" }) };
    if (args[1] === "/v3/apps/a3/droplets/current") return { code: 0, stdout: JSON.stringify({ image: "someone/else:1" }) };
    if (args[1] === "/v3/apps/r1/routes") return { code: 0, stdout: JSON.stringify({ resources: [{ url: "qa-figaf.cfapps.eu10-004.hana.ondemand.com" }] }) };
    if (args[1] === "/v3/apps/r4/routes") return { code: 0, stdout: JSON.stringify({ resources: [{ url: "demo.cfapps.eu10-004.hana.ondemand.com" }] }) };
    return { code: 0, stdout: "" };
  });
  const handlers = createL3Handlers(ctx);
  const r = await handlers["l3:figafSystems"]();
  assert.equal(r.ok, true, JSON.stringify(r));
  // "figaf"-named candidates are checked first; both image repos are accepted.
  assert.deepEqual(r.systems, [
    { id: "qa-figaf", url: "https://qa-figaf.cfapps.eu10-004.hana.ondemand.com", image: "ilnfigaf/app:2608.1-btp" },
    { id: "demo", url: "https://demo.cfapps.eu10-004.hana.ondemand.com", image: "figaf/app:2608-btp" },
  ]);
});

test("handlers report a friendly error when the host has no artifact channel", async () => {
  const { ctx } = makeCtx(null, () => ({ code: 0, stdout: "" }));
  ctx.host.resolveL3ArtifactsDir = () => null;
  const handlers = createL3Handlers(ctx);
  for (const ch of ["l3:catalog", "l3:status"]) {
    const r = await handlers[ch]({});
    assert.equal(r.ok, false);
    assert.match(r.error, /artifact channel/);
  }
});

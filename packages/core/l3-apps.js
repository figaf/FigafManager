"use strict";
// L3 App Manager (PoC) — catalog-driven install / update / disable / enable /
// remove / configure / health for Figaf L3 applications.
//
// Architecture:
//   - An artifact-store directory (host.resolveL3ArtifactsDir()) holds one
//     RELEASE: catalog.json plus one zip artifact per CF app. ("Release" =
//     the versioned set; the store is where releases live — the word
//     "channel" is retired, 2026-09-01.) For the PoC the release is bundled
//     inside the manager build; the seam is this one host method, so a
//     remote store (Cloudflare R2, GitHub releases) is a later swap.
//   - One catalog "app" (e.g. B2B Archiving Setup) maps to 1..n CF apps
//     (backend, frontend), deployed in catalog order with `cf push`.
//   - Bindings go to EXISTING service instances named in the catalog
//     (`services` must exist; `optionalServices` are bound only when present).
//   - The manager stamps FIGAF_APP_VERSION on every CF app it deploys and
//     reads it back for the status view.
//   - Config values (Figaf/SAP connection settings) are applied via
//     `cf set-env` with the value masked in the terminal stream and in the
//     audit log — secret values must never appear in either.
//
// Handlers are created by createL3Handlers(ctx) and spread into the
// orchestrator's handlers map. ctx carries the orchestrator's own helpers so
// this module spawns nothing on its own (tests inject a fake `run`).

const path = require("path");
const fs = require("fs");

const VERSION_ENV = "FIGAF_APP_VERSION";
const MAX_ENV_VALUE_LEN = 4096;

// ─── pure helpers (unit-tested in l3-apps.test.js) ──────────────────────────

/** Read + validate <dir>/catalog.json. Returns { ok, catalog } or { ok:false, error }. */
function loadCatalog(dir) {
  const file = path.join(dir, "catalog.json");
  if (!fs.existsSync(file)) return { ok: false, error: `catalog.json not found in ${dir}` };
  let parsed;
  try {
    // strip a UTF-8 BOM — Windows-side writers (PowerShell 5.1) often add one
    parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    return { ok: false, error: `catalog.json is not valid JSON: ${e.message}` };
  }
  if (!parsed || !Array.isArray(parsed.apps)) {
    return { ok: false, error: "catalog.json must have an 'apps' array" };
  }
  for (const app of parsed.apps) {
    if (!app.id || !app.version || !Array.isArray(app.cfApps) || app.cfApps.length === 0) {
      return { ok: false, error: `catalog app '${app.id || "?"}' needs id, version and a non-empty cfApps array` };
    }
    for (const c of app.cfApps) {
      if (!c.name || !c.artifact) {
        return { ok: false, error: `catalog app '${app.id}' has a cfApp without name/artifact` };
      }
    }
  }
  return { ok: true, catalog: parsed };
}

/**
 * Roll the per-CF-app states up to one app-level status.
 * parts: [{ exists: bool, state: "STARTED"|"STOPPED"|null }]
 */
function computeAppStatus(parts) {
  const existing = parts.filter((p) => p.exists);
  if (existing.length === 0) return "not-installed";
  if (existing.length < parts.length) return "partial";
  if (existing.every((p) => p.state === "STARTED")) return "running";
  if (existing.every((p) => p.state === "STOPPED")) return "stopped";
  return "mixed";
}

/** approuter `destinations` env value pointing a frontend at its backend. */
function buildDestinationsEnv(destinationName, url) {
  return JSON.stringify([{ name: destinationName, url, forwardAuthToken: true }]);
}

/** cf push argument list for one catalog cfApp. */
function buildPushArgs(cfApp, dir, { noStart } = {}) {
  const args = ["push", cfApp.name, "-p", dir];
  if (cfApp.buildpack) args.push("-b", cfApp.buildpack);
  if (cfApp.memory) args.push("-m", cfApp.memory);
  if (cfApp.disk) args.push("-k", cfApp.disk);
  if (noStart) args.push("--no-start");
  return args;
}

/**
 * Whitelist-validate the env object a renderer sends to l3:configure.
 * Only keys declared in the catalog app's configForm are accepted — the RPC
 * channel must not be usable to set arbitrary env vars on arbitrary apps.
 * Empty values are skipped (meaning: leave unchanged).
 */
function validateConfigEnv(app, env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return { ok: false, error: "env must be an object" };
  }
  const form = new Map((app.configForm || []).map((f) => [f.key, f]));
  const entries = [];
  for (const [key, value] of Object.entries(env)) {
    const field = form.get(key);
    if (!field) return { ok: false, error: `key '${key}' is not in this app's configForm` };
    if (value == null || value === "") continue;
    if (typeof value !== "string") return { ok: false, error: `value of '${key}' must be a string` };
    if (value.length > MAX_ENV_VALUE_LEN) return { ok: false, error: `value of '${key}' is too long` };
    entries.push({ key, value, secret: !!field.secret });
  }
  return { ok: true, entries };
}

// ─── handler factory ─────────────────────────────────────────────────────────

/**
 * @param {object} ctx
 * @param {object} ctx.host        HostAdapter (needs resolveL3ArtifactsDir + getUserDataDir)
 * @param {Function} ctx.run       orchestrator subprocess helper
 * @param {Function} ctx.log       cli:line logger (source, type, text)
 * @param {Function} ctx.send      event emitter to the renderer
 * @param {Function} ctx.resolveCf () => cf binary path
 * @param {Function} ctx.extractZip (zipPath, destDir) => Promise
 * @param {Function} ctx.httpsText (url) => Promise<string>
 */
function createL3Handlers(ctx) {
  const { host, run, log, send, resolveCf, extractZip, httpsText } = ctx;

  function artifactsDir() {
    if (typeof host.resolveL3ArtifactsDir !== "function") return null;
    return host.resolveL3ArtifactsDir();
  }

  function requireApp(appId) {
    const dir = artifactsDir();
    if (!dir) return { error: "No L3 artifact store on this host (l3-artifacts/ missing)" };
    const c = loadCatalog(dir);
    if (!c.ok) return { error: c.error };
    const app = c.catalog.apps.find((a) => a.id === appId);
    if (!app) return { error: `unknown app id '${appId}'` };
    return { dir, app, catalog: c.catalog };
  }

  function phase(appId, cfApp, step, state, detail) {
    send("l3:phase", { appId, cfApp, step, state, detail: detail || null });
  }

  async function cfAppExists(name) {
    const r = await run(resolveCf(), ["app", name, "--guid"], { source: "cf", quiet: true });
    return r.code === 0;
  }

  /** First HTTPS route of a CF app, or null. */
  async function routeUrl(appName) {
    const r = await run(resolveCf(), ["app", appName], { source: "cf", quiet: true });
    if (r.code !== 0) return null;
    const m = /routes:\s+([^\s,]+)/i.exec(r.stdout);
    return m ? "https://" + m[1] : null;
  }

  /**
   * Zips built on Windows carry no Unix permission info; unzip on Linux can
   * extract their directories WITHOUT write permission. Re-grant owner
   * read/write (+x on dirs) so cf push can read the tree and a retry can
   * delete it. No-op on Windows.
   */
  async function normalizeTreePerms(dir) {
    if (process.platform === "win32") return;
    await run("chmod", ["-R", "u+rwX", dir], { source: "sh", quiet: true });
  }

  /** rm -rf that survives a previous extraction with unwritable directories. */
  async function removeTree(dir) {
    if (!fs.existsSync(dir)) return;
    await normalizeTreePerms(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /** cf set-env with the VALUE hidden from terminal stream + audit log. */
  async function setEnvMasked(appName, key, value) {
    return run(resolveCf(), ["set-env", appName, key, String(value)], {
      source: "cf",
      quiet: true,
      logCmd: `cf set-env ${appName} ${key} <value hidden>`,
      auditArgs: ["set-env", appName, key, "<value hidden>"],
    });
  }

  /**
   * Deploy one catalog cfApp: fresh install (push --no-start, bind, env,
   * start) or in-place update (env refresh, push). Returns { ok } or
   * { ok:false, error }.
   */
  async function deployPart(app, cfApp, channelDir) {
    const name = cfApp.name;

    phase(app.id, name, "extract", "running");
    const workDir = path.join(host.getUserDataDir(), "l3-apps", app.id, name);
    try {
      await removeTree(workDir);
      await extractZip(path.join(channelDir, cfApp.artifact), workDir);
      await normalizeTreePerms(workDir);
    } catch (e) {
      phase(app.id, name, "extract", "error", e.message);
      return { ok: false, error: `extract ${cfApp.artifact} failed: ${e.message}` };
    }
    phase(app.id, name, "extract", "ok");

    const fresh = !(await cfAppExists(name));

    if (fresh) {
      phase(app.id, name, "push", "running");
      let r = await run(resolveCf(), buildPushArgs(cfApp, workDir, { noStart: true }), { source: "cf" });
      if (r.code !== 0) { phase(app.id, name, "push", "error"); return { ok: false, error: `cf push ${name} failed` }; }
      phase(app.id, name, "push", "ok");

      phase(app.id, name, "bind", "running");
      for (const s of cfApp.services || []) {
        r = await run(resolveCf(), ["bind-service", name, s], { source: "cf" });
        if (r.code !== 0) {
          phase(app.id, name, "bind", "error", s);
          return { ok: false, error: `bind-service ${s} failed — does the service instance exist in this space?` };
        }
      }
      for (const s of cfApp.optionalServices || []) {
        const probe = await run(resolveCf(), ["service", s], { source: "cf", quiet: true });
        if (probe.code === 0) {
          r = await run(resolveCf(), ["bind-service", name, s], { source: "cf" });
          if (r.code !== 0) log("cf", "warn", `optional bind-service ${s} failed — continuing without it`);
        } else {
          log("cf", "warn", `optional service ${s} not found — skipping bind`);
        }
      }
      phase(app.id, name, "bind", "ok");
    }

    phase(app.id, name, "env", "running");
    const envPairs = { ...(cfApp.env || {}), [VERSION_ENV]: app.version };
    if (cfApp.destinationTo) {
      const url = await routeUrl(cfApp.destinationTo);
      if (!url) { phase(app.id, name, "env", "error"); return { ok: false, error: `could not resolve the route of ${cfApp.destinationTo}` }; }
      envPairs.destinations = buildDestinationsEnv(cfApp.destinationName || cfApp.destinationTo, url);
    }
    for (const [k, v] of Object.entries(envPairs)) {
      const r = await setEnvMasked(name, k, v);
      if (r.code !== 0) { phase(app.id, name, "env", "error", k); return { ok: false, error: `cf set-env ${k} failed` }; }
    }
    phase(app.id, name, "env", "ok");

    phase(app.id, name, "start", "running");
    const startArgs = fresh ? ["start", name] : buildPushArgs(cfApp, workDir, { noStart: false });
    const r = await run(resolveCf(), startArgs, { source: "cf" });
    if (r.code !== 0) {
      phase(app.id, name, "start", "error");
      return { ok: false, error: `${fresh ? "cf start" : "cf push"} ${name} failed — see the staging log in the terminal` };
    }
    phase(app.id, name, "start", "ok");
    return { ok: true };
  }

  async function deployAll(appId) {
    const req = requireApp(appId);
    if (req.error) return { ok: false, error: req.error };
    for (const cfApp of req.app.cfApps) {
      const r = await deployPart(req.app, cfApp, req.dir);
      if (!r.ok) return { ...r, failedApp: cfApp.name };
    }
    return { ok: true, version: req.app.version };
  }

  /** stop/start/delete every CF app of a catalog app. Reverse order for teardown. */
  async function forEachPart(appId, argsFor, { reverse } = {}) {
    const req = requireApp(appId);
    if (req.error) return { ok: false, error: req.error };
    const parts = reverse ? [...req.app.cfApps].reverse() : req.app.cfApps;
    for (const cfApp of parts) {
      const r = await run(resolveCf(), argsFor(cfApp), { source: "cf" });
      if (r.code !== 0) return { ok: false, error: `cf ${argsFor(cfApp)[0]} ${cfApp.name} failed`, failedApp: cfApp.name };
    }
    return { ok: true };
  }

  return {
    async "l3:catalog"() {
      const dir = artifactsDir();
      if (!dir) return { ok: false, error: "No L3 artifact store on this host (l3-artifacts/ missing)" };
      const c = loadCatalog(dir);
      if (!c.ok) return c;
      return {
        ok: true,
        // releaseVersion is the name; releases built before 2026-09-01 carry
        // only the legacy field channelVersion (kept as a read fallback).
        releaseVersion: c.catalog.releaseVersion || c.catalog.channelVersion || null,
        apps: c.catalog.apps.map((a) => ({
          id: a.id,
          name: a.name || a.id,
          version: a.version,
          description: a.description || "",
          cfApps: a.cfApps.map((p) => ({ name: p.name })),
          configForm: a.configForm || [],
          healthPath: a.healthPath || null,
          roleCollections: a.roleCollections || [],
        })),
      };
    },

    async "l3:status"() {
      const dir = artifactsDir();
      if (!dir) return { ok: false, error: "No L3 artifact store on this host" };
      const c = loadCatalog(dir);
      if (!c.ok) return c;

      // Scope the app listing to the targeted space; fall back to unscoped.
      let spaceGuid = null;
      const t = await run(resolveCf(), ["target"], { source: "cf", quiet: true });
      const spaceName = /space:\s+(\S+)/i.exec(t.stdout || "")?.[1] || null;
      if (spaceName) {
        const sg = await run(resolveCf(), ["space", spaceName, "--guid"], { source: "cf", quiet: true });
        if (sg.code === 0) spaceGuid = (sg.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || null;
      }
      const q = spaceGuid ? `/v3/apps?space_guids=${spaceGuid}&per_page=200` : "/v3/apps?per_page=200";
      const list = await run(resolveCf(), ["curl", q], { source: "cf", quiet: true });
      if (list.code !== 0) return { ok: false, error: "cf curl /v3/apps failed — are you logged in and targeted?" };
      let resources = [];
      try { resources = JSON.parse(list.stdout).resources || []; } catch {}
      const byName = new Map(resources.map((r) => [r.name, r]));

      const apps = [];
      for (const app of c.catalog.apps) {
        const parts = [];
        for (const p of app.cfApps) {
          const res = byName.get(p.name);
          parts.push({ name: p.name, exists: !!res, state: res ? res.state : null, guid: res ? res.guid : null, route: null });
        }
        let installedVersion = null;
        const first = parts.find((p) => p.exists);
        if (first) {
          const e = await run(resolveCf(), ["curl", `/v3/apps/${first.guid}/environment_variables`], { source: "cf", quiet: true });
          if (e.code === 0) { try { installedVersion = (JSON.parse(e.stdout).var || {})[VERSION_ENV] || null; } catch {} }
        }
        for (const p of parts) {
          if (!p.exists) continue;
          const rr = await run(resolveCf(), ["curl", `/v3/apps/${p.guid}/routes`], { source: "cf", quiet: true });
          if (rr.code === 0) { try { p.route = (((JSON.parse(rr.stdout).resources || [])[0]) || {}).url || null; } catch {} }
        }
        apps.push({
          id: app.id,
          status: computeAppStatus(parts),
          installedVersion,
          catalogVersion: app.version,
          parts: parts.map(({ guid, ...rest }) => rest),
        });
      }
      return { ok: true, apps };
    },

    async "l3:install"({ appId } = {}) {
      if (!appId) return { ok: false, error: "appId required" };
      log("l3", "line", `Installing ${appId} …`);
      return deployAll(appId);
    },

    async "l3:update"({ appId } = {}) {
      if (!appId) return { ok: false, error: "appId required" };
      log("l3", "line", `Updating ${appId} …`);
      return deployAll(appId);
    },

    async "l3:disable"({ appId } = {}) {
      if (!appId) return { ok: false, error: "appId required" };
      return forEachPart(appId, (c) => ["stop", c.name], { reverse: true });
    },

    async "l3:enable"({ appId } = {}) {
      if (!appId) return { ok: false, error: "appId required" };
      return forEachPart(appId, (c) => ["start", c.name]);
    },

    async "l3:remove"({ appId } = {}) {
      if (!appId) return { ok: false, error: "appId required" };
      return forEachPart(appId, (c) => ["delete", c.name, "-f"], { reverse: true });
    },

    /**
     * Discover Figaf Tool deployments visible to the current cf login, so the
     * Configure form can offer them as a dropdown instead of a typed URL.
     * Detection (same as the manager's Update flow): app pairs `X-app` +
     * `X-router` where X-app runs a `figaf/app:*` Docker image. The URL an L3
     * app needs is the ROUTER's route. Note: visibility follows the cf login —
     * a single-space technical user only sees its own space; the form keeps
     * manual URL entry as the fallback.
     */
    async "l3:figafSystems"() {
      // Accepted Figaf Tool Docker repos. `figaf/app` = official releases
      // (what Alex's wizard deploys); `ilnfigaf/app` = Figaf's internal CI
      // builds (run-btp-instance-pipeline.Jenkinsfile). Override / extend via
      // FIGAF_TOOL_IMAGE_PREFIXES (comma-separated) without a redeploy of code.
      const prefixes = (process.env.FIGAF_TOOL_IMAGE_PREFIXES || "figaf/app:,ilnfigaf/app:")
        .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

      // List all apps visible to this cf login, following pagination.
      let resources = [];
      let pagePath = "/v3/apps?per_page=500";
      for (let page = 0; page < 4 && pagePath; page++) {
        const list = await run(resolveCf(), ["curl", pagePath], { source: "cf", quiet: true });
        if (list.code !== 0) {
          if (page === 0) return { ok: false, error: "cf curl /v3/apps failed — are you logged in?" };
          break;
        }
        try {
          const parsed = JSON.parse(list.stdout);
          resources = resources.concat(parsed.resources || []);
          const next = parsed.pagination && parsed.pagination.next && parsed.pagination.next.href;
          pagePath = next ? next.replace(/^https?:\/\/[^/]+/, "") : null;
        } catch { break; }
      }

      const byId = new Map();
      for (const app of resources) {
        const m = /^(.+)-(app|router)$/.exec(app.name || "");
        if (!m) continue;
        if (!byId.has(m[1])) byId.set(m[1], {});
        byId.get(m[1])[m[2]] = app;
      }
      // Complete pairs only; check ids containing "figaf" first — the droplet
      // lookup costs one cf curl per candidate, so spend them wisely.
      const candidates = [...byId.entries()]
        .filter(([, pair]) => pair.app && pair.router)
        .sort(([a], [b]) => (b.toLowerCase().includes("figaf") ? 1 : 0) - (a.toLowerCase().includes("figaf") ? 1 : 0));

      const systems = [];
      let lookups = 0;
      for (const [id, pair] of candidates) {
        if (lookups >= 25 || systems.length >= 15) break;
        lookups++;
        const d = await run(resolveCf(), ["curl", `/v3/apps/${pair.app.guid}/droplets/current`], { source: "cf", quiet: true });
        if (d.code !== 0) continue;
        let image = null;
        try { image = JSON.parse(d.stdout).image || null; } catch {}
        if (!image || !prefixes.some((p) => image.toLowerCase().startsWith(p))) continue;
        const rr = await run(resolveCf(), ["curl", `/v3/apps/${pair.router.guid}/routes`], { source: "cf", quiet: true });
        let route = null;
        if (rr.code === 0) { try { route = (((JSON.parse(rr.stdout).resources || [])[0]) || {}).url || null; } catch {} }
        if (!route) continue;
        systems.push({ id, url: "https://" + route, image });
      }
      return { ok: true, systems };
    },

    async "l3:configure"({ appId, env } = {}) {
      if (!appId) return { ok: false, error: "appId required" };
      const req = requireApp(appId);
      if (req.error) return { ok: false, error: req.error };
      const v = validateConfigEnv(req.app, env);
      if (!v.ok) return v;
      if (v.entries.length === 0) return { ok: true, applied: 0, note: "nothing to apply" };
      const target = req.app.configTargetCfApp || req.app.cfApps[0].name;
      if (!(await cfAppExists(target))) return { ok: false, error: `${target} is not deployed — install the app first` };
      for (const { key, value } of v.entries) {
        const r = await setEnvMasked(target, key, value);
        if (r.code !== 0) return { ok: false, error: `cf set-env ${key} failed` };
      }
      const r = await run(resolveCf(), ["restart", target], { source: "cf" });
      if (r.code !== 0) return { ok: false, error: `cf restart ${target} failed` };
      return { ok: true, applied: v.entries.length };
    },

    async "l3:health"({ appId } = {}) {
      const req = requireApp(appId);
      if (req.error) return { ok: false, error: req.error };
      if (!req.app.healthPath) return { ok: false, error: "app declares no healthPath" };
      const target = req.app.configTargetCfApp || req.app.cfApps[0].name;
      const base = await routeUrl(target);
      if (!base) return { ok: false, error: `${target} has no route — is it deployed?` };
      const url = base + req.app.healthPath;
      log("l3", "line", `GET ${url}`);
      // Health endpoints answer non-2xx WITH a diagnostic body (e.g. 503 when
      // a connection is unconfigured) — keep the body either way.
      const get = ctx.httpsBody || (async (u) => ({ status: 200, body: await httpsText(u) }));
      try {
        const r = await get(url);
        let parsed = null;
        try { parsed = JSON.parse(r.body); } catch {}
        return {
          ok: r.status >= 200 && r.status < 300,
          httpStatus: r.status,
          url,
          body: parsed || r.body,
        };
      } catch (e) {
        return { ok: false, url, error: e.message };
      }
    },
  };
}

module.exports = {
  VERSION_ENV,
  loadCatalog,
  computeAppStatus,
  buildDestinationsEnv,
  buildPushArgs,
  validateConfigEnv,
  createL3Handlers,
};

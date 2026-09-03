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
//   - Catalog v2 (release 0.3.0+): a `platform` block holds the SHARED
//     BACKEND CONNECTOR's CF apps; each catalog "app" holds only its
//     frontend(s). Install/update deploy the platform FIRST, then the app —
//     the new connector must serve old frontends during that window
//     (decision 0005's backward-compatibility gate). Disable/enable/remove
//     touch only the app's own CF apps; the platform stays for the others.
//     A catalog WITHOUT a platform block keeps the v1 behavior.
//   - Artifacts may carry a sha256; the zip is verified before extraction.
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
const crypto = require("crypto");

const VERSION_ENV = "FIGAF_APP_VERSION";
// Landscape-independent releases (decision 0008, figaf-l3-l4 repo): a service
// config file in the release (xs-security.json) may carry this placeholder in
// its redirect URI; provisionServices fills it with the cfapps domain of the
// landscape we are logged into. No landscape is ever hard-coded in a release.
const APPS_DOMAIN_PLACEHOLDER = "__CF_APPS_DOMAIN__";
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
  if (parsed.platform != null) {
    if (!Array.isArray(parsed.platform.cfApps) || parsed.platform.cfApps.length === 0) {
      return { ok: false, error: "catalog 'platform' needs a non-empty cfApps array" };
    }
    for (const c of parsed.platform.cfApps) {
      if (!c.name || !c.artifact) {
        return { ok: false, error: "catalog 'platform' has a cfApp without name/artifact" };
      }
    }
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
  // Catalog v3: service INSTANCES the manager creates when missing.
  if (parsed.services != null) {
    if (!Array.isArray(parsed.services)) return { ok: false, error: "catalog 'services' must be an array" };
    for (const s of parsed.services) {
      if (!s.name || !s.offering || !s.plan) {
        return { ok: false, error: `catalog service '${s.name || "?"}' needs name, offering and plan` };
      }
      if (s.plans != null && (!Array.isArray(s.plans) || !s.plans.includes(s.plan))) {
        return { ok: false, error: `catalog service '${s.name}': 'plans' must be an array containing the default plan` };
      }
    }
  }
  return { ok: true, catalog: parsed };
}

/**
 * Map `cf service <name>` output to one status word.
 * exitCode != 0 → "missing"; otherwise from the `status:` line.
 */
function serviceStatusFromCf(exitCode, stdout) {
  if (exitCode !== 0) return "missing";
  const m = /^\s*status:\s*(.+)$/im.exec(stdout || "");
  const op = m ? m[1].trim().toLowerCase() : "";
  if (/succeeded/.test(op)) return "ready";
  if (/in progress/.test(op)) return "in-progress";
  if (/failed/.test(op)) return "failed";
  return "unknown";
}

/**
 * The platform base (shared backend connector) as a pseudo-app, so the deploy
 * machinery treats it exactly like an app's CF apps. Null on v1 catalogs.
 */
function platformPseudoApp(catalog) {
  const p = catalog && catalog.platform;
  if (!p || !Array.isArray(p.cfApps) || p.cfApps.length === 0) return null;
  return {
    id: "platform",
    name: p.name || "Platform base (shared backend)",
    version: catalog.releaseVersion || catalog.channelVersion || "unknown",
    cfApps: p.cfApps,
  };
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

/**
 * What a failed CLI call said, for the operator: the last (up to `lines`)
 * non-empty stderr lines; when stderr is empty, the last stdout line that is
 * not the bare "FAILED" marker; when both are empty, the spawn error.
 * Trimmed to `maxLen` characters. Never throws.
 */
function cliFailureDetail(r, { lines = 3, maxLen = 400 } = {}) {
  const pick = (text) => String(text || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== "FAILED");
  let tail = pick(r && r.stderr).slice(-lines);
  if (!tail.length) tail = pick(r && r.stdout).slice(-1);
  if (!tail.length && r && r.error) tail = [String(r.error)];
  return tail.join(" | ").slice(0, maxLen);
}

/**
 * cf push argument list for one catalog cfApp.
 *
 * `--no-manifest` is mandatory. Without it the cf CLI applies any manifest.yml
 * it finds in ITS working directory — and inside the CF container that is the
 * manager's OWN /home/vcap/app/manifest.yml. That file is present whenever the
 * manager was deployed through the BTP cockpit upload (the customer path):
 * `cf push` strips manifest.yml from what it uploads, the cockpit does not.
 * The manager's manifest then becomes the base of the L3 app push (its
 * buildpack, command, random-route, env) and CAPI rejects the mix:
 * "Buildpack and Buildpacks fields cannot be used together" — found live on
 * 2026-09-03, install of release 0.4.0. An L3 app is described ONLY by the
 * release catalog; no manifest is ever part of its push.
 */
function buildPushArgs(cfApp, dir, { noStart } = {}) {
  const args = ["push", cfApp.name, "-p", dir, "--no-manifest"];
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
  // Polling knobs (tests inject a no-op sleep and a short deadline).
  const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const POLL_MS = ctx.pollIntervalMs != null ? ctx.pollIntervalMs : 10_000;
  const PROVISION_TIMEOUT_MS = ctx.provisionTimeoutMs != null ? ctx.provisionTimeoutMs : 15 * 60_000;

  /** The manager's own CF app name (cloud only; null on desktop / outside CF). */
  /** The landscape's shared `cfapps.` domain, read from the CF API (never hard-coded). */
  async function resolveAppsDomain() {
    const r = await run(resolveCf(), ["curl", "/v3/domains"], { source: "cf", quiet: true });
    if (r.code !== 0) return { ok: false, error: `cf curl /v3/domains failed: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}` };
    let names = [];
    try { names = (JSON.parse(r.stdout).resources || []).map((d) => d.name).filter(Boolean); }
    catch { return { ok: false, error: "cf curl /v3/domains returned no JSON" }; }
    const domain = names.find((n) => n.startsWith("cfapps."));
    if (!domain) return { ok: false, error: `no cfapps.* domain in this landscape (domains: ${names.join(", ") || "none"}) - cannot fill ${APPS_DOMAIN_PLACEHOLDER}` };
    return { ok: true, domain };
  }

  function selfAppName() {
    const t = host.getDeployTargetForSelf && host.getDeployTargetForSelf();
    return t && t.appName ? t.appName : null;
  }

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
   * The structured failure of one deploy step. Carries what cf said (`detail`),
   * WHERE it happened (`step`, `cfApp`) and the exact command (masked where it
   * carried a secret), so the console can show it and the operator can report
   * it. Also emits the l3:phase error event with the detail.
   */
  function stepFailure(app, cfApp, step, r, summary, command) {
    const detail = cliFailureDetail(r);
    phase(app.id, cfApp.name, step, "error", detail || null);
    return {
      ok: false,
      error: detail ? `${summary}: ${detail}` : summary,
      step,
      cfApp: cfApp.name,
      command: command || undefined,
      detail: detail || undefined,
    };
  }

  /**
   * Deploy one catalog cfApp: fresh install (push --no-start, bind, env,
   * start) or in-place update (env refresh, push). Returns { ok } or
   * { ok:false, error, step, cfApp, command?, detail? }.
   */
  async function deployPart(app, cfApp, channelDir) {
    const name = cfApp.name;

    // Verify the artifact against its release checksum BEFORE extracting.
    if (cfApp.sha256) {
      const zipPath = path.join(channelDir, cfApp.artifact);
      let actual;
      try {
        actual = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
      } catch (e) {
        phase(app.id, name, "extract", "error", e.message);
        return { ok: false, error: `could not read ${cfApp.artifact}: ${e.message}`, step: "extract", cfApp: name };
      }
      if (actual !== String(cfApp.sha256).toLowerCase()) {
        phase(app.id, name, "extract", "error", "checksum mismatch");
        return { ok: false, error: `checksum mismatch for ${cfApp.artifact} — the release is corrupt or was tampered with; nothing was deployed`, step: "extract", cfApp: name };
      }
    }

    phase(app.id, name, "extract", "running");
    const workDir = path.join(host.getUserDataDir(), "l3-apps", app.id, name);
    try {
      await removeTree(workDir);
      await extractZip(path.join(channelDir, cfApp.artifact), workDir);
      await normalizeTreePerms(workDir);
    } catch (e) {
      phase(app.id, name, "extract", "error", e.message);
      return { ok: false, error: `extract ${cfApp.artifact} failed: ${e.message}`, step: "extract", cfApp: name };
    }
    phase(app.id, name, "extract", "ok");

    const fresh = !(await cfAppExists(name));

    if (fresh) {
      phase(app.id, name, "push", "running");
      const pushArgs = buildPushArgs(cfApp, workDir, { noStart: true });
      let r = await run(resolveCf(), pushArgs, { source: "cf" });
      if (r.code !== 0) return stepFailure(app, cfApp, "push", r, `cf push ${name} failed`, `cf ${pushArgs.join(" ")}`);
      phase(app.id, name, "push", "ok");

      phase(app.id, name, "bind", "running");
      for (const s of cfApp.services || []) {
        const bindArgs = ["bind-service", name, s];
        r = await run(resolveCf(), bindArgs, { source: "cf" });
        if (r.code !== 0) {
          return stepFailure(app, cfApp, "bind", r, `bind-service ${s} failed — does the service instance exist in this space?`, `cf ${bindArgs.join(" ")}`);
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
      if (!url) {
        phase(app.id, name, "env", "error", `no route on ${cfApp.destinationTo}`);
        return { ok: false, error: `could not resolve the route of ${cfApp.destinationTo} — is the platform base deployed and started?`, step: "env", cfApp: name, command: `cf app ${cfApp.destinationTo}` };
      }
      envPairs.destinations = buildDestinationsEnv(cfApp.destinationName || cfApp.destinationTo, url);
    }
    for (const [k, v] of Object.entries(envPairs)) {
      const r = await setEnvMasked(name, k, v);
      if (r.code !== 0) return stepFailure(app, cfApp, "env", r, `cf set-env ${k} failed`, `cf set-env ${name} ${k} <value hidden>`);
    }
    phase(app.id, name, "env", "ok");

    phase(app.id, name, "start", "running");
    const startArgs = fresh ? ["start", name] : buildPushArgs(cfApp, workDir, { noStart: false });
    const r = await run(resolveCf(), startArgs, { source: "cf" });
    if (r.code !== 0) {
      return stepFailure(app, cfApp, "start", r, `${fresh ? "cf start" : "cf push"} ${name} failed — see the staging log in the terminal`, `cf ${startArgs.join(" ")}`);
    }
    phase(app.id, name, "start", "ok");
    return { ok: true };
  }

  /**
   * Catalog v3 guard: every REQUIRED service instance (any name in a cfApp's
   * `services`) must exist before a deploy starts — a clear early error
   * instead of `bind-service` failing halfway through.
   */
  async function missingRequiredServices(catalog, app) {
    const platform = platformPseudoApp(catalog);
    const names = new Set();
    for (const c of [...(platform ? platform.cfApps : []), ...app.cfApps]) {
      for (const s of c.services || []) names.add(s);
    }
    const missing = [];
    for (const name of names) {
      const r = await run(resolveCf(), ["service", name], { source: "cf", quiet: true });
      if (r.code !== 0) missing.push(name);
    }
    return missing;
  }

  async function deployAll(appId) {
    const req = requireApp(appId);
    if (req.error) return { ok: false, error: req.error };
    if (Array.isArray(req.catalog.services)) {
      const missing = await missingRequiredServices(req.catalog, req.app);
      if (missing.length) {
        return {
          ok: false,
          error: `required service instance(s) missing: ${missing.join(", ")} — create them first (Base services card)`,
        };
      }
    }
    // Platform base FIRST (catalog v2): the shared connector is deployed /
    // updated before any frontend, so the only mixed state that ever exists
    // is "new backend + old frontend" — the state the backward-compatibility
    // gate (decision 0005) covers. Idempotent: an already-current connector
    // is simply pushed again (same as the app "Re-deploy").
    const platform = platformPseudoApp(req.catalog);
    if (platform) {
      for (const cfApp of platform.cfApps) {
        const r = await deployPart(platform, cfApp, req.dir);
        if (!r.ok) return { ...r, failedApp: cfApp.name };
      }
    }
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
      const args = argsFor(cfApp);
      const r = await run(resolveCf(), args, { source: "cf" });
      if (r.code !== 0) {
        const detail = cliFailureDetail(r);
        return {
          ok: false,
          error: `cf ${args[0]} ${cfApp.name} failed${detail ? `: ${detail}` : ""}`,
          failedApp: cfApp.name,
          step: args[0],
          cfApp: cfApp.name,
          command: `cf ${args.join(" ")}`,
          detail: detail || undefined,
        };
      }
    }
    return { ok: true };
  }

  /**
   * Every state-changing action ends with ONE clear line in the terminal
   * drawer: green "done" or red "FAILED at step … (cf app): what cf said".
   * The RPC result carries the same facts for the console's outcome panel.
   */
  function reportOutcome(action, appId, r) {
    if (r && r.ok) {
      log("l3", "ok", `${action} ${appId}: done`);
    } else {
      const where = [r && r.step ? `at step "${r.step}"` : "", r && r.cfApp ? `(${r.cfApp})` : ""].filter(Boolean).join(" ");
      log("l3", "err", `${action} ${appId} FAILED${where ? " " + where : ""}: ${(r && r.error) || "unknown error"}`);
    }
    return r;
  }

  return {
    async "l3:catalog"() {
      const dir = artifactsDir();
      if (!dir) return { ok: false, error: "No L3 artifact store on this host (l3-artifacts/ missing)" };
      const c = loadCatalog(dir);
      if (!c.ok) return c;
      const platform = platformPseudoApp(c.catalog);
      return {
        ok: true,
        // releaseVersion is the name; releases built before 2026-09-01 carry
        // only the legacy field channelVersion (kept as a read fallback).
        releaseVersion: c.catalog.releaseVersion || c.catalog.channelVersion || null,
        platform: platform ? { name: platform.name, cfApps: platform.cfApps.map((p) => ({ name: p.name })) } : null,
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

      // The platform base is reported as its own row, computed the same way
      // as the app rows (catalog v2; null on v1 catalogs).
      const platform = platformPseudoApp(c.catalog);
      const entries = platform ? [platform, ...c.catalog.apps] : c.catalog.apps;
      const apps = [];
      for (const app of entries) {
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
          name: app.name || app.id,
          status: computeAppStatus(parts),
          installedVersion,
          catalogVersion: app.version,
          parts: parts.map(({ guid, ...rest }) => rest),
        });
      }
      const platformRow = platform ? apps.shift() : null;
      return { ok: true, platform: platformRow, apps };
    },

    /**
     * Catalog v3: the service instances the platform needs, with their live
     * state. `boundToManager` is filled for bindToManager entries (a binding
     * exists in CF; it is effective in THIS process only after a restart —
     * the renderer combines it with login:storedUserStatus.bindingPresent).
     */
    async "l3:services"() {
      const dir = artifactsDir();
      if (!dir) return { ok: false, error: "No L3 artifact store on this host" };
      const c = loadCatalog(dir);
      if (!c.ok) return c;
      const self = selfAppName();
      const services = [];
      for (const s of c.catalog.services || []) {
        const r = await run(resolveCf(), ["service", s.name], { source: "cf", quiet: true });
        const status = serviceStatusFromCf(r.code, r.stdout);
        let boundToManager = null;
        if (s.bindToManager && self && status !== "missing") {
          const b = await run(resolveCf(), ["curl", `/v3/service_credential_bindings?type=app&service_instance_names=${s.name}&app_names=${self}`], { source: "cf", quiet: true });
          if (b.code === 0) { try { boundToManager = (JSON.parse(b.stdout).resources || []).length > 0; } catch {} }
        }
        services.push({
          name: s.name, offering: s.offering, plan: s.plan, plans: s.plans || [s.plan],
          purpose: s.purpose || "", bindToManager: !!s.bindToManager,
          exists: status !== "missing", status, boundToManager,
        });
      }
      return { ok: true, selfApp: self, services };
    },

    /**
     * Create every MISSING catalog service, then wait until all are ready.
     * plans: optional { <name>: <plan> } overrides, validated against the
     * catalog's allowed plans. Progress lines go to the terminal drawer.
     */
    async "l3:provisionServices"({ plans } = {}) {
      const dir = artifactsDir();
      if (!dir) return { ok: false, error: "No L3 artifact store on this host" };
      const c = loadCatalog(dir);
      if (!c.ok) return c;
      const declared = c.catalog.services || [];
      if (declared.length === 0) return { ok: true, created: [], note: "this release declares no services" };

      const created = [];
      const failed = [];
      const cfTail = (r) => ((r.stderr || r.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "").slice(0, 300);
      for (const s of declared) {
        const probe = await run(resolveCf(), ["service", s.name], { source: "cf", quiet: true });
        if (probe.code === 0) {
          // Exists. A FAILED instance blocks re-creation under the same name;
          // remove it and create again (the admin already asked to provision).
          if (serviceStatusFromCf(probe.code, probe.stdout) !== "failed") continue;
          log("l3", "warn", `${s.name} is in a failed state — deleting it before creating again`);
          const del = await run(resolveCf(), ["delete-service", s.name, "-f"], { source: "cf" });
          if (del.code !== 0) { failed.push({ name: s.name, error: `could not delete the failed instance: ${cfTail(del)}` }); continue; }
          // Deletion is asynchronous — wait until the name is free.
          const gone = Date.now() + PROVISION_TIMEOUT_MS;
          while ((await run(resolveCf(), ["service", s.name], { source: "cf", quiet: true })).code === 0) {
            if (Date.now() > gone) break;
            await sleep(POLL_MS);
          }
        }
        const allowed = s.plans || [s.plan];
        const plan = (plans && plans[s.name]) || s.plan;
        if (!allowed.includes(plan)) {
          failed.push({ name: s.name, error: `plan '${plan}' is not allowed for ${s.name} (allowed: ${allowed.join(", ")})` });
          continue;
        }
        const args = ["create-service", s.offering, plan, s.name];
        if (s.configFile) {
          const file = path.join(dir, s.configFile);
          if (!fs.existsSync(file)) { failed.push({ name: s.name, error: `config file ${s.configFile} missing from the release` }); continue; }
          let cfgPath = file;
          const text = fs.readFileSync(file, "utf8");
          if (text.includes(APPS_DOMAIN_PLACEHOLDER)) {
            const dom = await resolveAppsDomain();
            if (!dom.ok) { failed.push({ name: s.name, error: dom.error }); continue; }
            const cfgDir = path.join(host.getUserDataDir(), "l3-services");
            fs.mkdirSync(cfgDir, { recursive: true });
            cfgPath = path.join(cfgDir, s.configFile);
            fs.writeFileSync(cfgPath, text.split(APPS_DOMAIN_PLACEHOLDER).join(dom.domain));
            log("l3", "dim", `${s.configFile}: ${APPS_DOMAIN_PLACEHOLDER} -> ${dom.domain}`);
          }
          args.push("-c", cfgPath);
        } else if (s.config && typeof s.config === "object") {
          // cf -c accepts a file path; never pass JSON on the command line.
          const cfgDir = path.join(host.getUserDataDir(), "l3-services");
          fs.mkdirSync(cfgDir, { recursive: true });
          const file = path.join(cfgDir, `${s.name}.json`);
          fs.writeFileSync(file, JSON.stringify(s.config));
          args.push("-c", file);
        }
        log("l3", "line", `Creating service instance ${s.name} (${s.offering} / ${plan}) …`);
        const r = await run(resolveCf(), args, { source: "cf" });
        if (r.code !== 0) { failed.push({ name: s.name, error: `cf create-service ${s.name} failed: ${cfTail(r)}` }); continue; }
        created.push(s.name);
      }

      // Wait for asynchronous creations (PostgreSQL takes minutes).
      const timedOut = [];
      const deadline = Date.now() + PROVISION_TIMEOUT_MS;
      let pending = declared.filter((s) => !failed.some((f) => f.name === s.name)).map((s) => s.name);
      while (pending.length) {
        const still = [];
        for (const name of pending) {
          const r = await run(resolveCf(), ["service", name], { source: "cf", quiet: true });
          const status = serviceStatusFromCf(r.code, r.stdout);
          if (status === "ready") continue;
          if (status === "failed") { failed.push({ name, error: "service operation failed (see cf service)" }); continue; }
          still.push(name);
        }
        pending = still;
        if (!pending.length) break;
        if (Date.now() > deadline) { timedOut.push(...pending); break; }
        log("l3", "dim", `waiting for: ${pending.join(", ")} …`);
        await sleep(POLL_MS);
      }
      const ok = failed.length === 0 && timedOut.length === 0;
      return {
        ok, created, failed, timedOut,
        error: ok ? undefined :
          [failed.map((f) => `${f.name}: ${f.error}`).join("; "), timedOut.length ? `still not ready: ${timedOut.join(", ")}` : ""]
            .filter(Boolean).join(" | "),
      };
    },

    /** Bind a bindToManager catalog service to the manager app itself. */
    async "l3:bindManagerService"({ name } = {}) {
      const dir = artifactsDir();
      if (!dir) return { ok: false, error: "No L3 artifact store on this host" };
      const c = loadCatalog(dir);
      if (!c.ok) return c;
      const s = (c.catalog.services || []).find((x) => x.name === name);
      if (!s || !s.bindToManager) return { ok: false, error: `${name || "?"} is not a manager-bound service in this release` };
      const self = selfAppName();
      if (!self) return { ok: false, error: "cannot determine the manager's own app name (not running in CF?)" };
      const r = await run(resolveCf(), ["bind-service", self, name], { source: "cf" });
      if (r.code !== 0) return { ok: false, error: `cf bind-service ${self} ${name} failed` };
      return { ok: true, restartRequired: true, note: `${name} is bound to ${self}; the binding becomes active after a restart of the manager` };
    },

    /**
     * Restart the manager itself so new bindings take effect. Fire-and-forget:
     * this process is stopped by the restart, so the command never "returns".
     */
    async "l3:restartSelf"() {
      const self = selfAppName();
      if (!self) return { ok: false, error: "cannot determine the manager's own app name (not running in CF?)" };
      log("l3", "warn", `Restarting ${self} — this session ends; reload the page in ~30 s (token mode: claim a new token from the logs).`);
      run(resolveCf(), ["restart", self], { source: "cf" }).catch(() => {});
      return { ok: true, note: "restart started" };
    },

    async "l3:install"({ appId } = {}) {
      if (!appId) return { ok: false, error: "appId required" };
      log("l3", "line", `Installing ${appId} …`);
      return reportOutcome("install", appId, await deployAll(appId));
    },

    async "l3:update"({ appId } = {}) {
      if (!appId) return { ok: false, error: "appId required" };
      log("l3", "line", `Updating ${appId} …`);
      return reportOutcome("update", appId, await deployAll(appId));
    },

    async "l3:disable"({ appId } = {}) {
      if (!appId) return { ok: false, error: "appId required" };
      return reportOutcome("disable", appId, await forEachPart(appId, (c) => ["stop", c.name], { reverse: true }));
    },

    async "l3:enable"({ appId } = {}) {
      if (!appId) return { ok: false, error: "appId required" };
      return reportOutcome("enable", appId, await forEachPart(appId, (c) => ["start", c.name]));
    },

    async "l3:remove"({ appId } = {}) {
      if (!appId) return { ok: false, error: "appId required" };
      return reportOutcome("remove", appId, await forEachPart(appId, (c) => ["delete", c.name, "-f"], { reverse: true }));
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
  APPS_DOMAIN_PLACEHOLDER,
  VERSION_ENV,
  loadCatalog,
  platformPseudoApp,
  computeAppStatus,
  buildDestinationsEnv,
  buildPushArgs,
  cliFailureDetail,
  validateConfigEnv,
  serviceStatusFromCf,
  createL3Handlers,
};

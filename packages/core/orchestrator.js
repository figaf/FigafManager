"use strict";
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const https = require("https");
const dbSchemas = require("./db-schemas");

const DEPLOYMENT_ZIP_URL =
  process.env.FIGAF_DEPLOYMENT_ZIP_URL ||
  "https://github.com/figaf/Figaf-BTP-Deployment/archive/refs/heads/btp-users.zip";

/**
 * @typedef {Object} HostAdapter
 * @property {boolean} isHosted
 *   true → cloud deployment (figaf-manager); false → desktop (figaf-local).
 *   Drives all environment-specific branches in the orchestrator.
 *
 * @property {() => string} getUserDataDir
 *   Per-host writable directory. Electron: app.getPath("userData").
 *   Cloud: $HOME/sessions/<sessionId>.
 *
 * @property {(name: "btp"|"cf") => string} resolveBinary
 *   Returns the full path (or bare name to fall back to PATH) for a CLI
 *   binary. Electron: persisted under userData/cliPaths.json.
 *   Cloud: bundled at /app/bin/<name>.
 *
 * @property {(name: "btp"|"cf", value: string|null) => void} [storeCliPath]
 *   Persist a resolved CLI path. Electron only — cloud has no need.
 *
 * @property {(opts: object) => Promise<string|null>} pickFile
 *   Native file picker. Returns absolute path, or null if cancelled.
 *   Cloud: no-op (returns null).
 *
 * @property {(url: string) => Promise<void>} openExternal
 *   Open URL in the OS's default browser. Cloud: no-op (the browser shim
 *   in cloud/client.js handles this client-side via window.open).
 *
 * @property {() => Promise<string>} readClipboard
 *   Return the system clipboard contents. Cloud: no-op (the browser shim
 *   uses navigator.clipboard).
 *
 * @property {() => { kind: "bundle"|"github", src: string }} resolveDeployTemplate
 *   Where to materialize the deployment template tree from.
 *   Electron: { kind: "bundle", src: <bundled directory> } — copied to
 *             userData/deploy/ on first use.
 *   Cloud:    { kind: "github", src: <zip URL> } — downloaded into
 *             getUserDataDir() on first use.
 *
 * @property {() => string|null} [resolveManagerApprouterDir]
 *   Absolute path to the bundled @figaf/manager-approuter directory (server.js,
 *   xs-app.json, xs-security.json, maintenance.html, node_modules/). Returned
 *   ONLY by hosts that ship the approuter payload — figaf-manager in cloud
 *   mode after a v2-aware build-zip run. Electron returns null (the v2
 *   XSUAA upgrade flow does not apply to the desktop installer).
 */

function createOrchestrator({ host, send, audit }) {
  const state = {
    landscape: null,
    org: null,
    space: null,
    user: null,
    subaccount: null,
    provider: null,
    globalAccountSubdomain: null,
    btpLoginWaitingForChoice: false,
    subaccountWaitingForChoice: false,
    subaccountList: null,
    cfLoginProc: null,
    btpLoginProc: null,
    deployDirResolved: null,
  };

  // SAP BTP region → hyperscaler mapping. Suffix tells you the provider for
  // every region we've seen so far (*10/11/12 = AWS, *20/21 = Azure, *30/31 = GCP),
  // Unknown regions fall through to null so the UI just hides the chip.
  function providerFromRegion(region) {
    if (!region) return null;
    const r = String(region).toLowerCase();
    if (/1\d$/.test(r)) return "AWS";
    if (/2\d$/.test(r)) return "Microsoft Azure";
    if (/3\d$/.test(r)) return "Google Cloud Platform";
    return null;
  }

  // Audit logger is optional — callers that don't pass one get a no-op shim
  // so the orchestrator stays runnable in test harnesses and from any
  // host adapter that hasn't been upgraded to v3 yet. See audit-log.js for
  // the full contract.
  const noopHandle = { id: null, exit() {}, out() {}, error() {}, end() {} };
  const auditor = audit || {
    beginCli: () => noopHandle,
    beginRpc: () => noopHandle,
    beginNet: () => noopHandle,
  };

  function log(source, type, text) {
    send("cli:line", { source, type, text });
  }

  function resolveBtp() { return host.resolveBinary("btp"); }
  function resolveCf()  { return host.resolveBinary("cf");  }

  // ─── subprocess helpers ────────────────────────────────────────────────────

  function run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
      const proc = spawn(cmd, args, {
        shell: false,
        windowsHide: true,
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env || {}) },
      });
      let stdout = "";
      let stderr = "";
      const auditHandle = auditor.beginCli({
        cmd,
        args,
        cwd: opts.cwd,
        user: state.user,
      });

      log("cmd", "cmd", `${cmd} ${args.join(" ")}`);

      proc.stdout.on("data", (buf) => {
        const text = buf.toString();
        stdout += text;
        for (const line of text.split(/\r?\n/)) {
          if (line.length) log(opts.source || cmd, "line", line);
        }
      });
      proc.stderr.on("data", (buf) => {
        const text = buf.toString();
        stderr += text;
        for (const line of text.split(/\r?\n/)) {
          if (line.length) log(opts.source || cmd, "err", line);
        }
      });
      proc.on("error", (err) => {
        log(opts.source || cmd, "err", err.message);
        auditHandle.exit({ code: -1, stdout, stderr, errorMessage: err.message });
        resolve({ code: -1, stdout, stderr, error: err.message });
      });
      proc.on("close", (code) => {
        auditHandle.exit({ code: code ?? 0, stdout, stderr });
        resolve({ code: code ?? 0, stdout, stderr });
      });

      if (opts.stdin) {
        proc.stdin.write(opts.stdin);
        proc.stdin.end();
      }
    });
  }

  function httpsJson(url) {
    return new Promise((resolve, reject) => {
      const netHandle = auditor.beginNet({ url, method: "GET" });
      https.get(url, { headers: { "User-Agent": "Figaf-Manager" } }, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          netHandle.end({ status: res.statusCode });
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      }).on("error", (err) => {
        netHandle.end({ error: err });
        reject(err);
      });
    });
  }

  function httpsDownload(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
      const netHandle = auditor.beginNet({ url, method: "GET" });
      let finalStatus = null;
      const handle = (currentUrl, hops = 0) => {
        if (hops > 5) {
          netHandle.end({ status: finalStatus, error: "too many redirects" });
          return reject(new Error("Too many redirects"));
        }
        const headers = {
          "User-Agent": "Figaf-Manager",
          "Cookie": "eula_3_2_agreed=tools.hana.ondemand.com/developer-license-3_2.txt",
        };
        https.get(currentUrl, { headers }, (res) => {
          finalStatus = res.statusCode;
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            res.resume();
            const nextUrl = new URL(res.headers.location, currentUrl).href;
            return handle(nextUrl, hops + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            netHandle.end({ status: res.statusCode, error: `HTTP ${res.statusCode}` });
            return reject(new Error(`HTTP ${res.statusCode} fetching ${currentUrl}`));
          }
          const total = Number(res.headers["content-length"]) || 0;
          let received = 0;
          const ws = fs.createWriteStream(destPath);
          res.on("data", (chunk) => {
            received += chunk.length;
            if (onProgress) onProgress(received, total);
          });
          res.pipe(ws);
          ws.on("finish", () => ws.close(() => {
            netHandle.end({ status: 200 });
            resolve(destPath);
          }));
          ws.on("error", (err) => {
            netHandle.end({ status: 200, error: err });
            reject(err);
          });
        }).on("error", (err) => {
          netHandle.end({ status: finalStatus, error: err });
          reject(err);
        });
      };
      handle(url);
    });
  }

  async function extractZip(zipPath, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    let r;
    if (process.platform === "win32") {
      r = await run("powershell", [
        "-NoProfile", "-Command",
        `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`,
      ]);
    } else {
      r = await run("unzip", ["-o", zipPath, "-d", destDir]);
    }
    if (r.code !== 0) throw new Error(`zip extract failed: ${r.stderr || "unknown"}`);
  }

  function walkSync(dir, results = []) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walkSync(full, results);
      else results.push(full);
    }
    return results;
  }

  function parseTable(text, headerKeys) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    const headerIdx = lines.findIndex((l) => {
      const low = l.toLowerCase();
      return headerKeys.every((k) => low.includes(k.toLowerCase()));
    });
    if (headerIdx < 0) return [];
    const header = lines[headerIdx];
    const cols = [];
    let i = 0;
    while (i < header.length) {
      while (i < header.length && header[i] === " ") i++;
      const start = i;
      while (i < header.length && header[i] !== " ") i++;
      const name = header.slice(start, i).trim();
      cols.push({ name, start });
    }
    for (let j = 0; j < cols.length; j++) {
      cols[j].end = j + 1 < cols.length ? cols[j + 1].start : 9999;
    }
    const rows = [];
    for (let k = headerIdx + 1; k < lines.length; k++) {
      const line = lines[k];
      if (!line.trim() || line.trim().startsWith("-")) continue;
      if (/^Getting |^OK$|^FAILED/.test(line)) continue;
      const row = {};
      for (const col of cols) {
        row[col.name] = (line.slice(col.start, col.end) || "").trim();
      }
      rows.push(row);
    }
    return rows;
  }

  function copyRecursiveSync(src, dest) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      for (const name of fs.readdirSync(src)) {
        copyRecursiveSync(path.join(src, name), path.join(dest, name));
      }
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  // ─── deploy dir ───────────────────────────────────────────────────────────
  // Electron: copies the bundled snapshot to userData/deploy/ on first use.
  // Hosted:   downloads the GitHub archive into $HOME/deploy/ on first use
  //           and caches for the container lifetime.
  //
  // {force:true} wipes both the in-memory cache and the on-disk extraction
  // before falling through to the normal first-use path. Used by the Update
  // flow to guarantee the operator gets the live GitHub HEAD and not whatever
  // template was downloaded during the original install.

  async function resolveDeployDir(opts) {
    const force = !!(opts && opts.force);
    if (state.deployDirResolved && !force) return state.deployDirResolved;

    const tmpl = host.resolveDeployTemplate();
    const userDir = host.getUserDataDir();

    if (force && tmpl.kind === "github") {
      const extracted = path.join(userDir, "Figaf-BTP-Deployment-btp-users");
      try { fs.rmSync(extracted, { recursive: true, force: true }); } catch {}
      state.deployDirResolved = null;
    }

    if (tmpl.kind === "bundle") {
      const dest = path.join(userDir, "deploy");
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
        copyRecursiveSync(tmpl.src, dest);
      }
      state.deployDirResolved = dest;
    } else {
      fs.mkdirSync(userDir, { recursive: true });
      const zipPath = path.join(userDir, "btp-users.zip");
      log("deploy", "line", "Downloading deployment template…");
      await httpsDownload(tmpl.src, zipPath, (got, total) => {
        if (total) log("deploy", "line", `Downloading… ${Math.round((got / total) * 100)}%`);
      });
      log("deploy", "line", "Extracting deployment template…");
      await extractZip(zipPath, userDir);
      try { fs.unlinkSync(zipPath); } catch {}
      const extracted = path.join(userDir, "Figaf-BTP-Deployment-btp-users");
      if (!fs.existsSync(extracted)) {
        throw new Error("Deployment template extraction failed — directory not found");
      }
      state.deployDirResolved = extracted;
      log("deploy", "ok", "Deployment template ready.");
    }

    return state.deployDirResolved;
  }

  // ─── update-state.json helpers ────────────────────────────────────────────
  // Persisted under <userDataDir>/figaf-tool-update/update-state.json. Each
  // phase handler in the Update flow reads it on entry (to short-circuit
  // already-completed phases on resume) and writes back its own phase marker
  // on success. The file is intentionally scoped to the session dir — a fresh
  // dyno gets a fresh state, which is the correct "resume window" boundary.

  function updateStateDir() {
    return path.join(host.getUserDataDir(), "figaf-tool-update");
  }
  function updateStatePath() {
    return path.join(updateStateDir(), "update-state.json");
  }

  function readUpdateState() {
    try {
      const text = fs.readFileSync(updateStatePath(), "utf8");
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function writeUpdateState(patch) {
    const dir = updateStateDir();
    fs.mkdirSync(dir, { recursive: true });
    const prev = readUpdateState() || {};
    const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    fs.writeFileSync(updateStatePath(), JSON.stringify(next, null, 2) + "\n", "utf8");
    return next;
  }

  function clearUpdateState() {
    try { fs.rmSync(updateStateDir(), { recursive: true, force: true }); } catch {}
  }

  function sha256OfFile(p) {
    try {
      const buf = fs.readFileSync(p);
      return crypto.createHash("sha256").update(buf).digest("hex");
    } catch {
      return null;
    }
  }

  // Commit an enumerated subaccount entry as the active target: runs
  // `btp target --subaccount <guid>` so the CLI's notion of the target stays
  // in sync with our state, then writes state.landscape/subaccount/org and
  // returns the env payload shape that callers feed into `btp:loggedIn`.
  async function applySubaccountSelection(entry) {
    const t = await run(resolveBtp(), ["target", "--subaccount", entry.guid], { source: "btp" });
    if (t.code !== 0) {
      return { ok: false, error: t.stderr || "Failed to target subaccount" };
    }
    state.landscape = entry.landscape;
    state.subaccount = entry.guid;
    state.org = entry.org;
    state.provider = entry.provider || null;
    return {
      ok: true,
      landscape: entry.landscape,
      apiUrl: `https://api.${entry.landscape.replace(/^cf-/, "cf.")}.hana.ondemand.com`,
      org: entry.org,
      subaccount: entry.guid,
      subaccountName: entry.displayName,
      subdomain: state.globalAccountSubdomain,
      provider: entry.provider || null,
    };
  }

  // ─── handlers ─────────────────────────────────────────────────────────────

  const handlers = {

    // prerequisites ───────────────────────────────────────────────────────────

    async "prereq:whichBtp"() {
      if (host.isHosted) {
        const p = host.resolveBinary("btp");
        return { ok: fs.existsSync(p), path: p, source: "bundled" };
      }
      const stored = host.resolveBinary("btp");
      if (path.isAbsolute(stored) && fs.existsSync(stored)) {
        return { ok: true, path: stored, source: "stored" };
      }
      const r = await run(process.platform === "win32" ? "where" : "which", ["btp"]);
      const first = r.stdout.split(/\r?\n/).find(Boolean);
      return { ok: r.code === 0 && !!first, path: first || null, source: first ? "path" : null };
    },

    async "prereq:whichCf"() {
      if (host.isHosted) {
        const p = host.resolveBinary("cf");
        return { ok: fs.existsSync(p), path: p, source: "bundled" };
      }
      const stored = host.resolveBinary("cf");
      if (path.isAbsolute(stored) && fs.existsSync(stored)) {
        return { ok: true, path: stored, source: "stored" };
      }
      const r = await run(process.platform === "win32" ? "where" : "which", ["cf"]);
      const first = r.stdout.split(/\r?\n/).find(Boolean);
      return { ok: r.code === 0 && !!first, path: first || null, source: first ? "path" : null };
    },

    async "prereq:getCliPaths"() {
      return {
        btp: host.resolveBinary("btp"),
        cf: host.resolveBinary("cf"),
        binDir: host.getUserDataDir(),
      };
    },

    async "prereq:clearCliPath"({ cli }) {
      if (host.isHosted) return { ok: false, error: "not available in hosted mode" };
      if (cli !== "btp" && cli !== "cf") return { ok: false, error: "invalid cli" };
      await host.storeCliPath?.(cli, null);
      return { ok: true };
    },

    async "prereq:openBtpDownloadPage"() {
      const url = "https://tools.hana.ondemand.com/#cloud";
      await host.openExternal(url);
      return { ok: true, url };
    },

    async "prereq:installBtp"() {
      if (host.isHosted) return { ok: false, error: "not available in hosted mode" };
      send("cli:install", { cli: "btp", phase: "start" });
      try {
        const url = "https://tools.hana.ondemand.com/additional/btp-cli-windows-amd64-2.106.1.tar.gz";
        const filename = "btp-cli-windows-amd64-2.106.1.tar.gz";
        log("install", "line", `Downloading ${filename}`);
        const binDir = path.join(host.getUserDataDir(), "bin");
        fs.mkdirSync(binDir, { recursive: true });
        const tmpTar = path.join(os.tmpdir(), `figaf-${filename}`);
        await httpsDownload(url, tmpTar, (got, total) => {
          if (!total) return;
          send("cli:install", { cli: "btp", phase: "download", percent: Math.round((got / total) * 100) });
        });
        send("cli:install", { cli: "btp", phase: "extract" });
        log("install", "line", "Extracting…");
        const tmpDir = path.join(os.tmpdir(), `figaf-btpcli-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        const r = await run("tar", ["-xzf", tmpTar, "-C", tmpDir]);
        if (r.code !== 0) throw new Error(`Extract failed: ${r.stderr || "unknown"}`);
        const files = walkSync(tmpDir);
        const btpExe = files.find(f => /[\\/]btp\.exe$/i.test(f));
        if (!btpExe) throw new Error("btp.exe not found in downloaded archive");
        const dest = path.join(binDir, "btp.exe");
        try { fs.unlinkSync(dest); } catch {}
        fs.copyFileSync(btpExe, dest);
        await host.storeCliPath?.("btp", dest);
        try { fs.unlinkSync(tmpTar); } catch {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        const v = await run(dest, ["--version"], { source: "btp" });
        send("cli:install", { cli: "btp", phase: "done", path: dest });
        return { ok: true, path: dest, version: (v.stdout || "").split(/\r?\n/)[0].trim() || "2.106.1" };
      } catch (e) {
        log("install", "err", `btp install failed: ${e.message}`);
        send("cli:install", { cli: "btp", phase: "error", error: e.message });
        return { ok: false, error: e.message };
      }
    },

    async "prereq:installCf"() {
      if (host.isHosted) return { ok: false, error: "not available in hosted mode" };
      send("cli:install", { cli: "cf", phase: "start" });
      try {
        const rel = await httpsJson("https://api.github.com/repos/cloudfoundry/cli/releases/latest");
        const asset = (rel.assets || []).find(a => /winx64\.zip$/i.test(a.name) && !/installer/i.test(a.name));
        if (!asset) throw new Error("No Windows zip asset in cloudfoundry/cli latest release");
        log("install", "line", `Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);
        const binDir = path.join(host.getUserDataDir(), "bin");
        fs.mkdirSync(binDir, { recursive: true });
        const tmpZip = path.join(os.tmpdir(), `figaf-${asset.name}`);
        await httpsDownload(asset.browser_download_url, tmpZip, (got, total) => {
          if (!total) return;
          send("cli:install", { cli: "cf", phase: "download", percent: Math.round((got / total) * 100) });
        });
        send("cli:install", { cli: "cf", phase: "extract" });
        log("install", "line", "Extracting…");
        const tmpDir = path.join(os.tmpdir(), `figaf-cfcli-${Date.now()}`);
        await extractZip(tmpZip, tmpDir);
        const files = walkSync(tmpDir);
        const cfExe = files.find(f => /[\\/]cf\d*\.exe$/i.test(f));
        if (!cfExe) throw new Error("cf.exe not found in downloaded archive");
        const dest = path.join(binDir, "cf.exe");
        try { fs.unlinkSync(dest); } catch {}
        fs.copyFileSync(cfExe, dest);
        await host.storeCliPath?.("cf", dest);
        try { fs.unlinkSync(tmpZip); } catch {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        const v = await run(dest, ["--version"], { source: "cf" });
        send("cli:install", { cli: "cf", phase: "done", path: dest });
        return { ok: true, path: dest, version: (v.stdout || "").trim() };
      } catch (e) {
        log("install", "err", `cf install failed: ${e.message}`);
        send("cli:install", { cli: "cf", phase: "error", error: e.message });
        return { ok: false, error: e.message };
      }
    },

    async "prereq:locateCli"({ cli }) {
      if (host.isHosted) return { ok: false, error: "not available in hosted mode" };
      if (cli !== "btp" && cli !== "cf") return { ok: false, error: "invalid cli" };
      const src = await host.pickFile({
        title: `Locate ${cli} executable or archive`,
        properties: ["openFile"],
        filters: [
          { name: "Executable or archive", extensions: ["exe", "zip"] },
          { name: "Executable", extensions: ["exe"] },
          { name: "Archive", extensions: ["zip"] },
        ],
      });
      if (!src) return { ok: false, cancelled: true };
      const ext = path.extname(src).toLowerCase();
      const binDir = path.join(host.getUserDataDir(), "bin");
      fs.mkdirSync(binDir, { recursive: true });
      const dest = path.join(binDir, `${cli}.exe`);
      try {
        if (ext === ".zip") {
          send("cli:install", { cli, phase: "extract" });
          const tmpDir = path.join(os.tmpdir(), `figaf-${cli}-${Date.now()}`);
          await extractZip(src, tmpDir);
          const files = walkSync(tmpDir);
          const match = cli === "btp"
            ? files.find(f => /[\\/]btp\.exe$/i.test(f))
            : files.find(f => /[\\/]cf\d*\.exe$/i.test(f));
          if (!match) throw new Error(`${cli}.exe not found in archive`);
          try { fs.unlinkSync(dest); } catch {}
          fs.copyFileSync(match, dest);
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        } else if (ext === ".exe") {
          try { fs.unlinkSync(dest); } catch {}
          fs.copyFileSync(src, dest);
        } else {
          throw new Error("Please select a .exe or .zip file");
        }
        await host.storeCliPath?.(cli, dest);
        const v = await run(dest, ["--version"], { source: cli });
        const version = ((v.stdout || "") + (v.stderr || "")).split(/\r?\n/).find(Boolean) || "";
        send("cli:install", { cli, phase: "done", path: dest });
        return { ok: true, path: dest, version };
      } catch (e) {
        send("cli:install", { cli, phase: "error", error: e.message });
        return { ok: false, error: e.message };
      }
    },

    async "prereq:dockerHub"() {
      try {
        const data = await httpsJson(
          "https://hub.docker.com/v2/repositories/figaf/app/tags?name=btp&page_size=1&ordering=last_updated"
        );
        const latest = data?.results?.[0]?.name || null;
        return { ok: !!latest, latest };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    async "prereq:disk"() {
      if (host.isHosted) return { ok: true, gb: 999, drive: "/" };
      if (process.platform !== "win32") {
        const r = await run("df", ["-BG", "."], { source: "disk" });
        const match = /(\d+)G\s/.exec((r.stdout.split("\n")[1]) || "");
        const gb = match ? Number(match[1]) : 0;
        return { ok: gb >= 2, gb, drive: "/" };
      }
      const drive = (process.env.SystemDrive || "C:") + "\\";
      const r = await run("powershell", ["-NoProfile", "-Command", `(Get-PSDrive ${drive[0]}).Free`]);
      const bytes = Number(r.stdout.trim());
      const gb = Number.isFinite(bytes) ? bytes / (1024 ** 3) : 0;
      return { ok: gb >= 2, gb: Number(gb.toFixed(1)), drive };
    },

    // BTP login ───────────────────────────────────────────────────────────────

    // Long-lived `btp login` process — kept alive so we can write the GA choice
    // number to its stdin when the multi-account prompt appears.
    async "btp:loginStart"() {
      if (state.btpLoginProc && !state.btpLoginProc.killed) {
        if (state.btpLoginWaitingForChoice) {
          log("btp", "warn", "Login in progress (awaiting GA choice), ignoring re-invocation");
          return { ok: true };
        }
        try { state.btpLoginProc.kill(); } catch {}
      }
      state.btpLoginWaitingForChoice = false;
      const btpBin = resolveBtp();
      const args = ["login", "--url", "https://cli.btp.cloud.sap", "--sso"];
      const proc = spawn(btpBin, args, { shell: false, windowsHide: true });
      state.btpLoginProc = proc;
      log("cmd", "cmd", `${btpBin} ${args.join(" ")}`);

      // ANSI escapes + the BTP CLI spinner's `\r` redraws can corrupt line-by-line
      // parsing (e.g. a leading `\r` glued to "Choose a global account:" defeats `^`).
      // Keep a rolling "clean" buffer (ANSI/CR stripped) and pattern-match the whole
      // multi-GA block at once.
      const ansiRe = /\x1b\[[0-9;?]*[a-zA-Z]/g;
      let cleanBuffer = "";
      let lineRemainder = "";
      let promptEmitted = false;

      const flushLines = (chunk, source) => {
        lineRemainder += chunk;
        const parts = lineRemainder.split(/\r\n|\n/);
        lineRemainder = parts.pop();
        for (const raw of parts) {
          const line = raw.replace(ansiRe, "").replace(/\r/g, "").trim();
          if (line.length) log("btp", source, line);
        }
      };

      const tryDetectGaPrompt = () => {
        if (promptEmitted) return;
        const m = /Choose a global account:?[\s\S]*?Choose option\s*[>:]/i.exec(cleanBuffer);
        if (!m) return;
        const block = m[0];
        const accounts = [];
        const optRe = /\[(\d+)\]\s+([^\r\n]+?)\s*$/gm;
        let am;
        while ((am = optRe.exec(block))) {
          accounts.push({ index: Number(am[1]), displayName: am[2].trim() });
        }
        if (accounts.length === 0) return;
        promptEmitted = true;
        if (lineRemainder.trim()) {
          log("btp", "line", lineRemainder.replace(ansiRe, "").replace(/\r/g, "").trim());
          lineRemainder = "";
        }
        state.btpLoginWaitingForChoice = true;
        send("btp:gaChoice", { accounts });
        cleanBuffer = cleanBuffer.slice(m.index + m[0].length);
      };

      const tryDetectSsoUrl = () => {
        const m = /Please continue login at:\s*(https:\/\/\S+)/i.exec(cleanBuffer);
        if (m) {
          send("btp:ssoUrl", { url: m[1] });
          cleanBuffer = cleanBuffer.replace(m[0], "");
        }
      };

      const ingest = (text, source) => {
        cleanBuffer += text.replace(ansiRe, "").replace(/\r(?!\n)/g, "\n");
        if (cleanBuffer.length > 16384) cleanBuffer = cleanBuffer.slice(-8192);
        flushLines(text, source);
        tryDetectGaPrompt();
        tryDetectSsoUrl();
      };

      proc.stdout.on("data", (buf) => ingest(buf.toString(), "line"));
      proc.stderr.on("data", (buf) => ingest(buf.toString(), "err"));
      proc.on("error", (err) => log("btp", "err", `btp spawn error: ${err.message}`));

      proc.on("close", async (code, signal) => {
        if (lineRemainder.trim()) {
          log("btp", "line", lineRemainder.replace(ansiRe, "").replace(/\r/g, "").trim());
          lineRemainder = "";
        }
        const detail = signal ? `code=${code} signal=${signal}` : `code=${code}`;
        log("btp", code === 0 ? "ok" : "err", `btp login exited (${detail})`);
        state.btpLoginProc = null;
        state.btpLoginWaitingForChoice = false;
        if (code === 0) {
          const gaInfo = await run(resolveBtp(), ["--format", "json", "get", "accounts/global-account"], { source: "btp" });
          if (gaInfo.code === 0) {
            try {
              const js = gaInfo.stdout.indexOf("{");
              if (js >= 0) {
                const data = JSON.parse(gaInfo.stdout.slice(js));
                state.globalAccountSubdomain = data.subdomain || null;
                log("btp", "line", `Global account subdomain: ${state.globalAccountSubdomain}`);
              }
            } catch (e) {
              log("btp", "warn", `Could not parse GA info: ${e.message}`);
            }
          }
          const env = await handlers["btp:listEnvInstances"]();
          if (!env.choicePending) {
            send("btp:loggedIn", { ...env, subdomain: state.globalAccountSubdomain });
          }
        } else {
          send("btp:loginFailed", { code, signal });
        }
      });

      return { ok: true };
    },

    async "btp:submitChoice"({ choice }) {
      const proc = state.btpLoginProc;
      if (!proc || proc.killed) return { ok: false, error: "No active btp login session" };
      try {
        state.btpLoginWaitingForChoice = false;
        proc.stdin.write(String(choice).trim() + os.EOL);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    async "btp:cancelLogin"() {
      const proc = state.btpLoginProc;
      if (proc && !proc.killed) { try { proc.kill(); } catch {} }
      state.btpLoginProc = null;
      state.btpLoginWaitingForChoice = false;
      return { ok: true };
    },

    async "btp:selectGlobalAccount"({ subdomain }) {
      const r = await run(resolveBtp(), ["target", "--global-account", subdomain], { source: "btp" });
      if (r.code !== 0) {
        send("btp:loggedIn", { ok: false, error: r.stderr || "Failed to target global account" });
        return { ok: false, error: r.stderr || "Failed to target global account" };
      }
      state.globalAccountSubdomain = subdomain;
      // GA switch invalidates the previous subaccount enumeration.
      state.subaccountList = null;
      state.subaccountWaitingForChoice = false;
      state.provider = null;
      const env = await handlers["btp:listEnvInstances"]();
      if (!env.choicePending) {
        send("btp:loggedIn", { ...env, subdomain });
      }
      return { ok: true };
    },

    async "btp:logout"() {
      await run(resolveBtp(), ["logout"], { source: "btp" });
      await run(resolveCf(), ["logout"], { source: "cf" }).catch(() => {});
      state.globalAccountSubdomain = null;
      state.landscape = null;
      state.subaccount = null;
      state.org = null;
      state.space = null;
      state.user = null;
      state.provider = null;
      state.subaccountList = null;
      state.subaccountWaitingForChoice = false;
      return { ok: true };
    },

    // Enumerate every subaccount in the targeted GA and probe each for a
    // Cloud Foundry environment instance. Outcomes:
    //   0 CF-enabled  → return error (today's behavior)
    //   1 CF-enabled  → silent auto-pick, target it, return env payload
    //   >1 CF-enabled → cache the list, emit `btp:subaccountChoice`, return
    //                   { ok: true, choicePending: true } — callers must NOT
    //                   emit `btp:loggedIn` until the user picks via
    //                   `btp:selectSubaccount`.
    // Non-CF subaccounts are still returned in the choice payload (with
    // cfEnabled:false) so the picker can render them as disabled — gives users
    // visibility into the full GA, mirroring `btp target`'s output.
    async "btp:listEnvInstances"() {
      const subRes = await run(resolveBtp(), ["--format", "json", "list", "accounts/subaccount"], { source: "btp" });
      if (subRes.code !== 0) return { ok: false, error: subRes.stderr || "Failed to list subaccounts" };

      let subaccounts = [];
      try {
        const jsonStart = subRes.stdout.indexOf("{");
        const data = jsonStart >= 0 ? JSON.parse(subRes.stdout.slice(jsonStart)) : null;
        subaccounts = (data && (data.value || data.subaccounts || data.children)) || [];
      } catch (e) {
        return { ok: false, error: "Cannot parse subaccount list: " + e.message };
      }
      if (!subaccounts.length) return { ok: false, error: "No subaccounts found in current global account" };

      const enumerated = [];
      for (const sa of subaccounts) {
        const said = sa.guid || sa.subaccountGUID || sa.id;
        if (!said) continue;
        const entry = {
          guid: said,
          displayName: sa.displayName || sa.name || said,
          subdomain: sa.subdomain || null,
          region: sa.region || null,
          provider: providerFromRegion(sa.region),
          state: sa.state || null,
          cfEnabled: false,
          landscape: null,
          org: null,
        };

        const r = await run(resolveBtp(), ["--format", "json", "list", "accounts/environment-instance", "--subaccount", said], { source: "btp" });
        if (r.code === 0) {
          let parsed = null;
          try {
            const jsonStart = r.stdout.indexOf("{");
            parsed = jsonStart >= 0 ? JSON.parse(r.stdout.slice(jsonStart)) : null;
          } catch {}
          const cf = parsed && (parsed.environmentInstances || []).find((e) => e.environmentType === "cloudfoundry");
          if (cf) {
            entry.cfEnabled = true;
            entry.landscape = cf.landscapeLabel;
            entry.guid = cf.subaccountGUID || said;
            try {
              const labels = typeof cf.labels === "string" ? JSON.parse(cf.labels) : cf.labels;
              entry.org = labels?.["Org Name"] || null;
            } catch {}
          }
        }
        enumerated.push(entry);
      }

      state.subaccountList = enumerated;
      const cfList = enumerated.filter((e) => e.cfEnabled);

      if (cfList.length === 0) {
        return { ok: false, error: "No Cloud Foundry environment found in any subaccount" };
      }
      if (cfList.length === 1) {
        return await applySubaccountSelection(cfList[0]);
      }

      state.subaccountWaitingForChoice = true;
      send("btp:subaccountChoice", {
        subaccounts: enumerated.map((e) => ({
          guid: e.guid,
          displayName: e.displayName,
          subdomain: e.subdomain,
          region: e.region,
          provider: e.provider,
          cfEnabled: e.cfEnabled,
        })),
      });
      return { ok: true, choicePending: true };
    },

    async "btp:selectSubaccount"({ guid }) {
      const entry = (state.subaccountList || []).find((e) => e.guid === guid);
      if (!entry) return { ok: false, error: "Unknown subaccount" };
      if (!entry.cfEnabled) return { ok: false, error: "Subaccount has no Cloud Foundry environment" };
      state.subaccountWaitingForChoice = false;
      const env = await applySubaccountSelection(entry);
      send("btp:loggedIn", { ...env, subdomain: state.globalAccountSubdomain });
      return env;
    },

    async "btp:listUsers"() {
      const args = ["list", "security/user"];
      if (state.subaccount) args.push("--subaccount", state.subaccount);
      const r = await run(resolveBtp(), args, { source: "btp" });
      if (r.code !== 0) return { ok: false, users: [], error: r.stderr };
      const users = r.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /@/.test(l) && !/username/i.test(l));
      return { ok: true, users };
    },

    async "btp:assignRole"({ user, role }) {
      const args = ["assign", "security/role-collection", role || "PI_Administrator", "--to-user", user];
      if (state.subaccount) args.push("--subaccount", state.subaccount);
      const r = await run(resolveBtp(), args, { source: "btp" });
      return { ok: r.code === 0, stdout: r.stdout, stderr: r.stderr };
    },

    // CF login ────────────────────────────────────────────────────────────────

    async "cf:loginStart"({ apiUrl }) {
      const target = apiUrl ||
        (state.landscape ? `https://api.${state.landscape.replace(/^cf-/, "cf.")}.hana.ondemand.com` : null);
      if (!target) return { ok: false, error: "No API URL" };
      if (state.cfLoginProc && !state.cfLoginProc.killed) {
        try { state.cfLoginProc.kill(); } catch {}
      }
      const cfBin = resolveCf();
      const proc = spawn(cfBin, ["login", "-a", target, "--sso"], { shell: false, windowsHide: true });
      state.cfLoginProc = proc;
      log("cmd", "cmd", `${cfBin} login -a ${target} --sso`);

      proc.stdout.on("data", (buf) => {
        for (const line of buf.toString().split(/\r?\n/)) {
          if (line.length) log("cf", "line", line);
        }
      });
      proc.stderr.on("data", (buf) => {
        for (const line of buf.toString().split(/\r?\n/)) {
          if (line.length) log("cf", "err", line);
        }
      });
      proc.on("close", (code) => {
        log("cf", code === 0 ? "ok" : "err", `cf login exited (${code})`);
        if (code === 0) send("cf:loggedIn", {});
        else send("cf:loginFailed", { code });
        state.cfLoginProc = null;
      });
      return { ok: true, apiUrl: target };
    },

    async "cf:submitPasscode"({ code }) {
      const proc = state.cfLoginProc;
      if (!proc || proc.killed) return { ok: false, error: "No active cf login session" };
      try {
        proc.stdin.write(code.trim() + os.EOL);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    async "cf:logout"() {
      if (state.cfLoginProc && !state.cfLoginProc.killed) {
        try { state.cfLoginProc.kill(); } catch {}
      }
      state.cfLoginProc = null;
      await run(resolveCf(), ["logout"], { source: "cf" }).catch(() => {});
      state.org = null;
      state.space = null;
      state.user = null;
      return { ok: true };
    },

    async "cf:targetOrgSpace"() {
      const r = await run(resolveCf(), ["target"], { source: "cf" });
      if (r.code !== 0) return { ok: false, error: r.stderr };
      const org   = /org:\s+(\S+)/i.exec(r.stdout)?.[1] || null;
      const space = /space:\s+(\S+)/i.exec(r.stdout)?.[1] || null;
      const user  = /user:\s+(\S+)/i.exec(r.stdout)?.[1] || null;
      state.org   = org   || state.org;
      state.space = space || state.space;
      state.user  = user  || state.user;
      return { ok: true, org, space, user };
    },

    async "cf:domains"() {
      const r = await run(resolveCf(), ["domains"], { source: "cf" });
      if (r.code !== 0) return { ok: false, error: r.stderr };
      const rows = parseTable(r.stdout, ["name", "availability"]);
      const cfapps = rows.map((row) => row.name).filter((n) => n && n.startsWith("cfapps."));
      return { ok: true, domains: cfapps };
    },

    async "cf:marketplacePostgresql"() {
      const r = await run(resolveCf(), ["marketplace", "-e", "postgresql-db"], { source: "cf" });
      if (r.code !== 0) return { ok: false, error: r.stderr, plans: [] };
      const rows = parseTable(r.stdout, ["plan", "description"]);
      const plans = rows
        .filter((row) => row.plan && !/^-+$/.test(row.plan))
        .map((row) => ({
          name: row.plan,
          description: row.description || "",
          free: /free/i.test(row["free or paid"] || row.costs || ""),
        }));
      return { ok: true, plans };
    },

    async "cf:createService"({ offering, plan, name, configFile }) {
      const deployDir = await resolveDeployDir();
      const args = ["create-service", offering, plan, name];
      if (configFile) args.push("-c", configFile);
      const r = await run(resolveCf(), args, { source: "cf", cwd: deployDir });
      const alreadyExists = /already exists/i.test(r.stdout + r.stderr);
      return { ok: r.code === 0 || alreadyExists, alreadyExists, stderr: r.stderr };
    },

    async "cf:service"({ name }) {
      const r = await run(resolveCf(), ["service", name], { source: "cf" });
      if (r.code !== 0) return { ok: false, error: r.stderr };
      const statusLine = /status:\s+(.+)/i.exec(r.stdout);
      return { ok: true, status: statusLine ? statusLine[1].trim() : "unknown", raw: r.stdout };
    },

    async "cf:pollService"({ name }) {
      const start = Date.now();
      const timeoutMs = 15 * 60 * 1000;
      while (Date.now() - start < timeoutMs) {
        const r = await run(resolveCf(), ["service", name], { source: "cf" });
        const line = /status:\s+(.+)/i.exec(r.stdout)?.[1]?.trim() || "unknown";
        send("cf:serviceStatus", { name, status: line });
        if (/succeeded/i.test(line)) return { ok: true, status: line };
        if (/failed/i.test(line)) return { ok: false, status: line };
        await new Promise((r) => setTimeout(r, 10000));
      }
      return { ok: false, status: "timeout" };
    },

    async "cf:push"() {
      const deployDir = await resolveDeployDir();
      const r = await run(resolveCf(), ["push", "--vars-file", "vars.yml"], { source: "cf", cwd: deployDir });
      return { ok: r.code === 0, code: r.code };
    },

    // Deletes the manager app itself — surfaced as the final wizard step in hosted mode.
    async "cf:deleteApp"({ name }) {
      const appName = name || "figaf-manager";
      const r = await run(resolveCf(), ["delete", appName, "-f"], { source: "cf" });
      return { ok: r.code === 0, code: r.code };
    },

    // config ──────────────────────────────────────────────────────────────────

    async "config:dockerHubLatestBtpTag"() {
      try {
        const data = await httpsJson(
          "https://hub.docker.com/v2/repositories/figaf/app/tags?name=btp&page_size=1&ordering=last_updated"
        );
        const latest = data?.results?.[0]?.name || null;
        return { ok: !!latest, tag: latest };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    async "config:dockerHubBtpTags"() {
      try {
        const data = await httpsJson(
          "https://hub.docker.com/v2/repositories/figaf/app/tags?name=btp&page_size=10&ordering=last_updated"
        );
        const tags = (data?.results || []).map(r => r.name).filter(Boolean);
        return { ok: tags.length > 0, tags };
      } catch (e) {
        return { ok: false, tags: [], error: e.message };
      }
    },

    async "config:deployDir"() {
      return { path: await resolveDeployDir() };
    },

    async "config:readVars"() {
      const deployDir = await resolveDeployDir();
      const file = path.join(deployDir, "vars.yml");
      const text = await fsp.readFile(file, "utf8");
      return { ok: true, text, path: file };
    },

    async "config:writeVars"(vars) {
      const deployDir = await resolveDeployDir();
      const file = path.join(deployDir, "vars.yml");
      let text = await fsp.readFile(file, "utf8");
      const mutations = [
        ["ID", vars.id],
        ["LANDSCAPE_APPS_DOMAIN", vars.domain],
        ["LOCATION_ID", vars.locationId],
        ["DOCKER_IMAGE_VERSION", vars.dockerVersion],
        ["DOCKER_USERNAME", vars.dockerUsername],
        ["INSTANCE_MEMORY", vars.instanceMemory],
        ["MAX_RAM_PERCENTAGE", vars.maxRamPercentage],
        ["LOGS_TOTAL_SIZE_CAP", vars.logsTotalSizeCap],
        ["ENABLE_INSTANCE_MONITORING", vars.enableInstanceMonitoring],
        ["USE_CLOUD_CONNECTOR_FOR_SMTP_INTEGRATION", vars.useCloudConnectorForSmtpIntegration],
        ["CLOUD_CONNECTOR_DESTINATION_NAME_FOR_SMTP_INTEGRATION", vars.cloudConnectorDestinationNameForSmtpIntegration],
      ];
      for (const [key, value] of mutations) {
        if (value == null || value === "") continue;
        const re = new RegExp(`^(${key}\\s*:).*$`, "m");
        if (re.test(text)) text = text.replace(re, `$1 ${value}`);
        else text += `\n${key}: ${value}`;
      }
      await fsp.writeFile(file, text, "utf8");
      return { ok: true, path: file };
    },

    /**
     * Read the current db.json verbatim. Used by the UI to seed the
     * PostgreSQL parameters form (and to keep parity with config:readVars).
     */
    async "config:readDbConfig"() {
      const deployDir = await resolveDeployDir();
      const file = path.join(deployDir, "db.json");
      try {
        const text = await fsp.readFile(file, "utf8");
        return { ok: true, text, path: file };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    /**
     * Write <deployDir>/db.json from a structured input. The renderer sends:
     *   { trial: boolean, provider: "AWS"|"Microsoft Azure"|"Google Cloud Platform"|null,
     *     fields: { engine_version, locale, storage, memory, ... } }
     * The orchestrator owns the schema map (packages/core/db-schemas.js); the
     * renderer cannot inject arbitrary keys. Trial schema is the limited
     * { engine_version, locale } the broker accepts on trial subaccounts;
     * hyperscaler schema is the full per-provider shape and includes the
     * Figaf-required postgresql_extensions list.
     */
    async "config:writeDbConfig"({ trial, provider, fields } = {}) {
      const built = dbSchemas.buildDbConfig({ trial: !!trial, provider, fields: fields || {} });
      if (!built.ok) return built;
      const deployDir = await resolveDeployDir();
      const file = path.join(deployDir, "db.json");
      await fsp.writeFile(file, JSON.stringify(built.json, null, 4) + "\n", "utf8");
      return { ok: true, path: file, json: built.json };
    },

    /**
     * Inspect the schema metadata (defaults + allowed UI fields) for a
     * (trial, provider) pair. Lets the renderer render a sane form without
     * embedding SAP-side schema knowledge.
     */
    async "config:dbSchema"({ trial, provider } = {}) {
      const defaults = dbSchemas.defaultsFor(!!trial, provider);
      const fields = dbSchemas.allowedFields(!!trial, provider);
      return { ok: !!defaults, defaults: defaults || null, fields };
    },

    // XSUAA upgrade (v2) ──────────────────────────────────────────────────────
    // See auth-gate-implementation-plan.md §2. The upgrade runs from inside
    // the manager dyno using the operator's already-authenticated cf CLI.
    // All handlers below are hosted-mode only — in figaf-local they return
    // safe { ok: false, error: "not available in desktop mode" }.

    /**
     * Detect mid-upgrade state. Returns { hasXsuaaService, hasApprouterApp,
     * managerBound, route, mode }. Pure inspection — never mutates.
     */
    async "xsuaa:upgradeStatus"() {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      const result = { ok: true, hasXsuaaService: false, hasApprouterApp: false, managerBound: false, route: null, mode: "token" };
      const svc = await run(resolveCf(), ["service", "figaf-manager-xsuaa"], { source: "cf" });
      result.hasXsuaaService = svc.code === 0;
      const app = await run(resolveCf(), ["app", "figaf-manager-approuter"], { source: "cf" });
      result.hasApprouterApp = app.code === 0;
      // Read manager's own routes from VCAP_APPLICATION (set by CF on every dyno).
      try {
        const va = JSON.parse(process.env.VCAP_APPLICATION || "{}");
        result.route = (va.uris && va.uris[0]) || null;
      } catch { /* leave null */ }
      // managerBound: try cf services and look for figaf-manager in the
      // bound apps column. CF v8 doesn't have a direct "show bindings for
      // service X" CLI, so we use cf curl on the service binding endpoint.
      const sb = await run(resolveCf(), ["curl", "/v3/service_credential_bindings?service_instance_names=figaf-manager-xsuaa&app_names=figaf-manager"], { source: "cf" });
      if (sb.code === 0) {
        try {
          const parsed = JSON.parse(sb.stdout);
          result.managerBound = Array.isArray(parsed.resources) && parsed.resources.length > 0;
        } catch { /* ignore */ }
      }
      result.mode = result.managerBound ? "xsuaa" : "token";
      return result;
    },

    /**
     * Phase 1.1 — create the wizard's XSUAA service instance using the
     * bundled xs-security.json. Idempotent: if the service already exists,
     * we return ok with alreadyExists=true.
     */
    async "cf:createXsuaa"() {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      const approuterDir = host.resolveManagerApprouterDir && host.resolveManagerApprouterDir();
      if (!approuterDir) {
        return { ok: false, error: "manager-approuter not bundled in this build; redeploy with v2 zip" };
      }
      const xsSecurityPath = path.join(approuterDir, "xs-security.json");
      if (!fs.existsSync(xsSecurityPath)) {
        return { ok: false, error: `xs-security.json not found at ${xsSecurityPath}` };
      }
      send("xsuaa:upgradePhase", { phase: "create-xsuaa", state: "running" });
      const args = ["create-service", "xsuaa", "application", "figaf-manager-xsuaa", "-c", xsSecurityPath];
      const r = await run(resolveCf(), args, { source: "cf" });
      const alreadyExists = /already exists/i.test(r.stdout + r.stderr);
      if (r.code !== 0 && !alreadyExists) {
        send("xsuaa:upgradePhase", { phase: "create-xsuaa", state: "failed", error: r.stderr || "create-service failed" });
        return { ok: false, error: r.stderr || "create-service failed" };
      }
      // Poll until provisioning succeeds. Reuse the cf:pollService loop
      // pattern; emit cf:serviceStatus so the UI's existing polling-screen
      // pattern lights up.
      const start = Date.now();
      const timeoutMs = 10 * 60 * 1000;
      while (Date.now() - start < timeoutMs) {
        const s = await run(resolveCf(), ["service", "figaf-manager-xsuaa"], { source: "cf" });
        const line = /status:\s+(.+)/i.exec(s.stdout)?.[1]?.trim() || "unknown";
        send("cf:serviceStatus", { name: "figaf-manager-xsuaa", status: line });
        if (/succeeded/i.test(line)) {
          send("xsuaa:upgradePhase", { phase: "create-xsuaa", state: "done" });
          return { ok: true, alreadyExists, status: line };
        }
        if (/failed/i.test(line)) {
          send("xsuaa:upgradePhase", { phase: "create-xsuaa", state: "failed", error: line });
          return { ok: false, error: line };
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      send("xsuaa:upgradePhase", { phase: "create-xsuaa", state: "failed", error: "timeout" });
      return { ok: false, error: "timeout polling figaf-manager-xsuaa" };
    },

    /**
     * Phase 1.3-1.6 — push, bind, start the manager-approuter app.
     * Reads the bundled approuter dir, materializes a synthetic manifest
     * with the wizard's route info, then runs cf push.
     *
     * Destination wiring (the reason this handler does more than just push):
     * @sap/approuter validates xs-app.json at boot — every route that names
     * a `destination` must have a matching entry in either a bound destination
     * service or the `destinations` env var. The wizard's xs-app.json forwards
     * every non-/_health request to a destination named `figaf-manager-internal`.
     * We don't bind a CF destination service (it would be one more service to
     * provision and clean up); we wire the destination via env var instead.
     *
     * The destination URL must outlive the public-route swap in Phase 2: after
     * `cf unmap-route figaf-manager <public>` the manager has no public route
     * left, so we map an additional `<hostname>-internal` route to figaf-manager
     * here, BEFORE the approuter starts, and point the destination at that URL.
     * This mirrors the pattern in `packages/deploy-templates/manifest.yml` where
     * the Figaf Tool sits behind a `-internal` hostname and its approuter
     * forwards via a `destinations` env var.
     */
    async "cf:pushManagerApprouter"() {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      const approuterDir = host.resolveManagerApprouterDir && host.resolveManagerApprouterDir();
      if (!approuterDir || !fs.existsSync(approuterDir)) {
        return { ok: false, error: "manager-approuter not bundled in this build; redeploy with v2 zip" };
      }

      // Read the manager's own current route(s) from VCAP_APPLICATION (set on
      // every CF dyno). We need both the hostname (to derive an internal
      // sibling) and the domain (to map the internal route on the same
      // landscape apps domain). On a retry after Phase 2.3 the only remaining
      // uri will already be the -internal hostname; in that case strip the
      // suffix back to the canonical hostname so we don't double-suffix.
      let managerHostname, managerDomain;
      try {
        const va = JSON.parse(process.env.VCAP_APPLICATION || "{}");
        const uri = (va.uris && va.uris[0]) || "";
        const dot = uri.indexOf(".");
        if (dot > 0) {
          let host = uri.slice(0, dot);
          if (host.endsWith("-internal")) host = host.slice(0, -"-internal".length);
          managerHostname = host;
          managerDomain   = uri.slice(dot + 1);
        }
      } catch { /* leave undefined */ }
      if (!managerHostname || !managerDomain) {
        return { ok: false, error: "could not derive manager route from VCAP_APPLICATION" };
      }
      const internalHostname = `${managerHostname}-internal`;
      const internalUrl      = `https://${internalHostname}.${managerDomain}`;

      send("xsuaa:upgradePhase", { phase: "push-approuter", state: "running" });

      // We push with --no-route --no-start so phase 2 can map the route
      // atomically. The approuter's own internal port comes from $PORT (CF
      // sets it). Memory: 128 MB is fine for @sap/approuter under steady load.
      const pushArgs = [
        "push", "figaf-manager-approuter",
        "-p", approuterDir,
        "-m", "128M",
        "-k", "256M",
        "--no-route",
        "--no-start",
        "--no-manifest",
      ];
      const r = await run(resolveCf(), pushArgs, { source: "cf" });
      if (r.code !== 0) {
        send("xsuaa:upgradePhase", { phase: "push-approuter", state: "failed", error: r.stderr });
        return { ok: false, error: r.stderr || "cf push failed" };
      }
      // 1.5 bind-service
      const b = await run(resolveCf(), ["bind-service", "figaf-manager-approuter", "figaf-manager-xsuaa"], { source: "cf" });
      if (b.code !== 0 && !/already bound/i.test(b.stdout + b.stderr)) {
        send("xsuaa:upgradePhase", { phase: "push-approuter", state: "failed", error: b.stderr });
        return { ok: false, error: b.stderr || "bind-service failed" };
      }

      // 1.5b — map the internal route to figaf-manager. Idempotent: cf
      // map-route returns 0 on a fresh map and a recognizable message on a
      // pre-existing one. We accept both (a re-run of the upgrade flow must
      // not blow up here).
      const mr = await run(resolveCf(), ["map-route", "figaf-manager", managerDomain, "--hostname", internalHostname], { source: "cf" });
      const alreadyMapped = /already exists|already mapped/i.test(mr.stdout + mr.stderr);
      if (mr.code !== 0 && !alreadyMapped) {
        send("xsuaa:upgradePhase", { phase: "push-approuter", state: "failed", error: mr.stderr });
        return { ok: false, error: mr.stderr || "map-route (internal) failed" };
      }

      // 1.5c — declare the figaf-manager-internal destination on the approuter
      // before first start, so @sap/approuter's JsonValidator finds it when it
      // loads xs-app.json. forwardAuthToken=true is essential: the manager's
      // @sap/xssec middleware needs the JWT the approuter validated.
      const destinations = JSON.stringify([{
        name: "figaf-manager-internal",
        url: internalUrl,
        forwardAuthToken: true,
        timeout: 86400000,
      }]);
      const se1 = await run(resolveCf(), ["set-env", "figaf-manager-approuter", "destinations", destinations], { source: "cf" });
      if (se1.code !== 0) {
        send("xsuaa:upgradePhase", { phase: "push-approuter", state: "failed", error: se1.stderr });
        return { ok: false, error: se1.stderr || "set-env destinations failed" };
      }
      // server.js (the approuter's own custom wrapper) reads this convenience
      // env var to probe the manager's /health from /_manager-health.
      const se2 = await run(resolveCf(), ["set-env", "figaf-manager-approuter", "destinations_figaf_manager_internal_url", internalUrl], { source: "cf" });
      if (se2.code !== 0) {
        send("xsuaa:upgradePhase", { phase: "push-approuter", state: "failed", error: se2.stderr });
        return { ok: false, error: se2.stderr || "set-env destinations_figaf_manager_internal_url failed" };
      }

      // 1.6 start
      const s = await run(resolveCf(), ["start", "figaf-manager-approuter"], { source: "cf" });
      if (s.code !== 0) {
        send("xsuaa:upgradePhase", { phase: "push-approuter", state: "failed", error: s.stderr });
        return { ok: false, error: s.stderr || "cf start failed" };
      }
      send("xsuaa:upgradePhase", { phase: "push-approuter", state: "done" });
      return { ok: true, internalUrl };
    },

    async "cf:mapRoute"({ app, domain, hostname }) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      if (!app || !domain || !hostname) return { ok: false, error: "app/domain/hostname required" };
      const r = await run(resolveCf(), ["map-route", app, domain, "--hostname", hostname], { source: "cf" });
      const exists = /already exists|already mapped/i.test(r.stdout + r.stderr);
      return { ok: r.code === 0 || exists, alreadyMapped: exists, stderr: r.stderr };
    },

    async "cf:unmapRoute"({ app, domain, hostname }) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      if (!app || !domain || !hostname) return { ok: false, error: "app/domain/hostname required" };
      const r = await run(resolveCf(), ["unmap-route", app, domain, "--hostname", hostname], { source: "cf" });
      // cf unmap-route returns non-zero if the route wasn't mapped — treat
      // as success (idempotent rollback).
      const notMapped = /not mapped|does not exist/i.test(r.stdout + r.stderr);
      return { ok: r.code === 0 || notMapped, notMapped, stderr: r.stderr };
    },

    /**
     * Phase 2.5 — bind manager to xsuaa, then restage. After restage the
     * manager comes back up with VCAP_SERVICES.xsuaa populated, which flips
     * XSUAA_ACTIVE=true in server.js at the new process's boot.
     *
     * The handler returns BEFORE restage completes — the dyno is going to
     * die in the next ~30-90s and the response would never reach the
     * browser otherwise. The UI polls via the approuter's /_manager-health
     * to detect when the manager is back.
     *
     * Args:
     *   app          — defaults to figaf-manager
     *   bindXsuaa    — when true, runs `cf bind-service <app> figaf-manager-xsuaa`
     *                  before the restage. Idempotent: "already bound" is treated
     *                  as success.
     *   skipIfBound  — when true, probes the v3 service_credential_bindings
     *                  endpoint and short-circuits the entire bind+restage if
     *                  the binding already exists. Used by the upgrade flow to
     *                  avoid an unnecessary 30-90s restage on re-runs.
     *   unmapRoute   — { domain, hostname }. When supplied, runs
     *                  `cf unmap-route <app> <domain> --hostname <hostname>` as
     *                  the first step of the cutover, BEFORE the bind. The
     *                  XSUAA upgrade splits the public route off the manager
     *                  onto the approuter — if the wizard fires the unmap as a
     *                  separate browser RPC, the next request (this restage)
     *                  arrives after the gorouter has switched the hostname
     *                  to the approuter, which 401s before the manager is ever
     *                  reached. Bundling the unmap server-side keeps the whole
     *                  cutover on one TCP connection: the RPC arrives while
     *                  the manager still serves the route, and the response
     *                  flows back over the already-open socket. Idempotent:
     *                  "not mapped / does not exist" is treated as success
     *                  so re-runs of the upgrade flow don't bail here.
     *
     * Observability: every cf call run here emits a cli:line cmd event before
     * execution. This is important during the upgrade: the restage spawn would
     * otherwise be invisible in the terminal drawer because spawn() doesn't go
     * through run(). When the bind step's frame is the last frame the browser
     * receives before the dyno bounces, operators can at least see that the
     * bind happened and the restage was initiated.
     */
    async "cf:restage"({ app, bindXsuaa, skipIfBound, unmapRoute } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      const appName = app || "figaf-manager";

      // Short-circuit: if the caller asked us to be conservative AND the
      // binding already exists, do nothing. The manager is already (or will
      // be on next natural boot) in XSUAA mode. The phase-running/done events
      // are still emitted so the UI's phase row resolves either way.
      if (skipIfBound) {
        const probe = await run(
          resolveCf(),
          ["curl", `/v3/service_credential_bindings?service_instance_names=figaf-manager-xsuaa&app_names=${appName}`],
          { source: "cf" }
        );
        if (probe.code === 0) {
          try {
            const parsed = JSON.parse(probe.stdout);
            if (Array.isArray(parsed.resources) && parsed.resources.length > 0) {
              send("xsuaa:upgradePhase", { phase: "restage", state: "done" });
              return { ok: true, alreadyBound: true, message: "manager already bound to figaf-manager-xsuaa; bind+restage skipped" };
            }
          } catch { /* fall through to the real bind path */ }
        }
      }

      // Optional cutover step: unmap the public route off this app BEFORE
      // bind/restage. See the JSDoc above for why this has to be bundled
      // into the same RPC as the restage rather than fired separately.
      if (unmapRoute && unmapRoute.domain && unmapRoute.hostname) {
        const u = await run(
          resolveCf(),
          ["unmap-route", appName, unmapRoute.domain, "--hostname", unmapRoute.hostname],
          { source: "cf" }
        );
        if (u.code !== 0 && !/not mapped|does not exist/i.test(u.stdout + u.stderr)) {
          return { ok: false, error: u.stderr || "unmap-route failed" };
        }
      }

      if (bindXsuaa) {
        const b = await run(resolveCf(), ["bind-service", appName, "figaf-manager-xsuaa"], { source: "cf" });
        if (b.code !== 0 && !/already bound/i.test(b.stdout + b.stderr)) {
          return { ok: false, error: b.stderr || "bind-service failed" };
        }
      }
      send("xsuaa:upgradePhase", { phase: "restage", state: "running" });
      // Fire-and-forget: spawn cf restage in the background so we can
      // return success to the browser before the dyno dies.
      const cfBin = resolveCf();
      // Log the command line ourselves — spawn() bypasses run()'s cmd-emit.
      // Without this the only signal that the restage was initiated is a
      // potentially-undelivered "Restaging app ..." stdout frame from cf.
      log("cmd", "cmd", `${cfBin} restage ${appName}`);
      const restageAudit = auditor.beginCli({ cmd: cfBin, args: ["restage", appName], user: state.user });
      let restageStdout = "";
      let restageStderr = "";
      const proc = spawn(cfBin, ["restage", appName], { shell: false, windowsHide: true, detached: false });
      proc.stdout.on("data", (b) => { const s = b.toString(); restageStdout += s; log("cf", "line", s); });
      proc.stderr.on("data", (b) => { const s = b.toString(); restageStderr += s; log("cf", "err", s); });
      // proc.on("error") is rare here (cf binary is bundled + resolveCf was
      // already called for the bind step) but a missing/unexecutable binary
      // would otherwise produce a silent failure. We log and don't reject —
      // the HTTP response is already in flight by the time this fires. The
      // audit log might still flush before the dyno bounces if the failure
      // is fast (e.g., missing binary), so we record what we can.
      proc.on("error", (err) => {
        log("cf", "err", "cf restage spawn failed: " + (err && err.message));
        restageAudit.exit({ code: -1, stdout: restageStdout, stderr: restageStderr, errorMessage: err && err.message });
      });
      // close handler is best-effort: most of the time the dyno is gone
      // before cf restage returns, but in re-run scenarios (where the
      // dyno survives) we still want the cli.exit record.
      proc.on("close", (code) => {
        restageAudit.exit({ code: code ?? 0, stdout: restageStdout, stderr: restageStderr });
      });
      return { ok: true, message: "restage initiated; manager will be unavailable for 30-90s" };
    },

    /**
     * Self-assign the operator to a manager role collection via the btp CLI.
     * Used by ScreenXsuaaUpgrade's "Assign me FigafManagerAdmin after upgrade"
     * checkbox (default on). Operates against the subaccount captured during
     * btp:listEnvInstances; the user identity is the BTP/IAS email reported
     * by `cf target` (state.user).
     *
     * Default role is FigafManagerAdmin because the Admin role-template's
     * scope-references include FigafManagerOperator (xs-security.json), so a
     * single assignment covers both. The role parameter is plumbed through
     * to make swapping to FigafManagerOperator a one-line change at the
     * caller, no contract change here.
     *
     * NOT shell-concatenated: spawn() with an args array via run(). No user
     * input ever lands in shell syntax. The user/subaccount values come from
     * trusted internal state (CF target output + btp env-instance JSON).
     *
     * Identity provider: we deliberately do NOT pass `--of-idp ORIGIN`. The
     * btp CLI defaults to the subaccount's primary IDP, which on standard
     * BTP/IAS setups is exactly what the wizard authenticates against. For
     * subaccounts with multiple IDPs the operator can re-run via the cockpit
     * fallback screen (ScreenXsuaaAssignRole) to pick the right origin.
     *
     * Failure handling: surfaces the stderr verbatim. The wizard treats this
     * as non-fatal — the XSUAA upgrade itself stays committed; the operator
     * just has to assign the role collection manually in the cockpit before
     * the new scope appears in their next JWT.
     */
    async "xsuaa:assignRoleCollection"({ role } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      const rc = role || "FigafManagerAdmin";
      const user = state.user;
      const sub = state.subaccount;
      if (!user) return { ok: false, error: "current user not captured (cf target has not run); assign manually in the cockpit" };
      if (!sub)  return { ok: false, error: "subaccount GUID not captured (btp:listEnvInstances has not run); assign manually in the cockpit" };

      send("xsuaa:upgradePhase", { phase: "assign-role", state: "running" });
      const args = ["assign", "security/role-collection", rc, "--to-user", user, "--subaccount", sub];
      const r = await run(resolveBtp(), args, { source: "btp" });
      // btp CLI returns 0 on a fresh assignment AND on a re-assignment (it
      // prints "already assigned" but exits 0). Treat any 0-exit as success.
      // If non-zero, capture both stdout (sometimes carries the error line)
      // and stderr so the UI has a meaningful message to display.
      if (r.code !== 0) {
        const detail = (r.stderr || r.stdout || "").trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" / ");
        send("xsuaa:upgradePhase", { phase: "assign-role", state: "failed", error: detail || "btp assign failed" });
        return { ok: false, error: detail || "btp assign failed", role: rc, user, subaccount: sub };
      }
      send("xsuaa:upgradePhase", { phase: "assign-role", state: "done" });
      return { ok: true, role: rc, user, subaccount: sub };
    },

    /**
     * Build the cockpit URL the operator should click to self-assign to the
     * FigafManagerOperator role collection. Composed from data the wizard
     * already has via btp accounts subaccount list.
     */
    async "xsuaa:assignRoleCollectionPreflight"() {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      const ga = state.globalAccountSubdomain;
      const sub = state.subaccount;
      if (!ga || !sub) return { ok: false, error: "missing globalAccountSubdomain or subaccount" };
      // Cockpit URL shape varies by region (eu10, us10, ap20…). Derive from
      // the cf landscape; fall back to the EMEA cockpit if landscape unknown.
      const landscape = state.landscape || "";
      // landscape values: cf-eu10, cf-us10, cf-ap20 … → region: eu10/us10/ap20
      const region = landscape.replace(/^cf-/, "");
      const cockpitHost = region
        ? `cockpit.btp.cloud.sap`
        : `cockpit.btp.cloud.sap`;
      const url = `https://${cockpitHost}/cockpit/?idpId=&globalaccount=${encodeURIComponent(ga)}#/globalaccount/${encodeURIComponent(ga)}/subaccount/${encodeURIComponent(sub)}/users`;
      return { ok: true, url, roleCollection: "FigafManagerOperator" };
    },

    /**
     * Multi-step teardown (§2.8). Fire-and-forget delete-self pattern: we
     * respond { ok: true } first, then run the teardown in a setImmediate.
     * By the time the operator's browser re-polls, the manager and its
     * approuter are both gone.
     */
    async "cf:uninstallManager"({ deleteRoleCollections } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      // Schedule teardown after the current call frame so the RPC response
      // can flush back to the browser before any blocking work begins.
      setImmediate(async () => {
        const steps = [
          { name: "unbind-service approuter", args: ["unbind-service", "figaf-manager-approuter", "figaf-manager-xsuaa"] },
          { name: "unbind-service manager",   args: ["unbind-service", "figaf-manager", "figaf-manager-xsuaa"] },
          { name: "delete approuter",         args: ["delete", "figaf-manager-approuter", "-r", "-f"] },
          { name: "delete manager",           args: ["delete", "figaf-manager", "-r", "-f"] },
          { name: "delete-service xsuaa",     args: ["delete-service", "figaf-manager-xsuaa", "-f"] },
        ];
        for (const step of steps) {
          log("teardown", "line", `Running: cf ${step.args.join(" ")}`);
          await run(resolveCf(), step.args, { source: "cf" }).catch((e) => {
            log("teardown", "err", `${step.name} failed: ${e.message}`);
          });
        }
        if (deleteRoleCollections) {
          for (const rc of ["FigafManagerOperator", "FigafManagerAdmin"]) {
            const args = ["delete", "security/role-collection", rc, "--force"];
            if (state.subaccount) args.push("--subaccount", state.subaccount);
            await run(resolveBtp(), args, { source: "btp" }).catch(() => {});
          }
        }
        // We are about to be killed (the manager just delete'd itself).
        // Nothing else to do.
      });
      return { ok: true, message: "Uninstall in progress. Page will go offline in ~30s." };
    },

    // Update Figaf Tool (hosted-only) ─────────────────────────────────────────
    // See update-figaf-tool-plan.md. The flow detects an existing
    // <ID>-app / <ID>-router deployment, force-refreshes the GitHub deploy
    // templates, optionally updates the figaf-xsuaa service, and rolling-
    // pushes the two apps to the operator's chosen Docker tag. State is
    // persisted under <userDataDir>/figaf-tool-update/update-state.json
    // so a mid-flow dyno restart can pick up where it left off.

    async "update:resumeStatus"() {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      const s = readUpdateState();
      if (!s) return { ok: true, hasInFlight: false };
      const terminal = s.phase === "verified" || s.phase === "failed";
      return { ok: true, hasInFlight: !terminal, state: s };
    },

    async "update:clear"() {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      clearUpdateState();
      return { ok: true };
    },

    async "update:detectDeployment"({ deployId } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };

      // Helper: read current image tag for a Docker app via the v3 droplets
      // endpoint. cf curl-only; cf app's text output is too brittle here.
      async function readImage(appName) {
        const g = await run(resolveCf(), ["app", "--guid", appName], { source: "cf" });
        if (g.code !== 0) return null;
        const guid = g.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
        if (!guid) return null;
        const d = await run(resolveCf(), ["curl", `/v3/apps/${guid}/droplets/current`], { source: "cf" });
        if (d.code !== 0) return null;
        try {
          const parsed = JSON.parse(d.stdout);
          return parsed.image || null;
        } catch {
          return null;
        }
      }

      if (deployId) {
        const appName = `${deployId}-app`;
        const routerName = `${deployId}-router`;
        const a = await run(resolveCf(), ["app", appName], { source: "cf" });
        const r = await run(resolveCf(), ["app", routerName], { source: "cf" });
        const foundApp = a.code === 0;
        const foundRouter = r.code === 0;
        if (!foundApp && !foundRouter) {
          return { ok: true, found: false, deployId, app: null, router: null, candidates: [] };
        }
        const image = foundApp ? await readImage(appName) : null;
        return {
          ok: true,
          found: true,
          deployId,
          app:    foundApp    ? { name: appName,    image, exists: true }  : { name: appName,    image: null, exists: false },
          router: foundRouter ? { name: routerName, exists: true }          : { name: routerName, exists: false },
        };
      }

      // No deployId provided — try to enumerate candidates in the current
      // space. The space GUID is read via cf curl /v3/organizations/.../spaces
      // chains is too long; the simpler "cf app --guid" lookup is per-app, so
      // we list apps in the targeted space and post-filter by name regex plus
      // docker image prefix.
      const list = await run(resolveCf(), ["curl", "/v3/apps?per_page=500"], { source: "cf" });
      if (list.code !== 0) {
        return { ok: true, found: false, deployId: null, candidates: [], error: "cf curl /v3/apps failed" };
      }
      let resources = [];
      try { resources = (JSON.parse(list.stdout).resources) || []; } catch {}
      const byId = new Map();
      for (const app of resources) {
        const m = /^(.+)-(app|router)$/.exec(app.name || "");
        if (!m) continue;
        const id = m[1];
        const role = m[2];
        if (!byId.has(id)) byId.set(id, { id, app: null, router: null });
        byId.get(id)[role] = { name: app.name, guid: app.guid };
      }
      const candidates = [];
      for (const [id, pair] of byId) {
        if (!pair.app) continue;
        const image = await readImage(pair.app.name);
        if (!image || !/^figaf\/app:/i.test(image)) continue;
        candidates.push({ id, app: pair.app.name, router: pair.router ? pair.router.name : null, image });
      }
      return { ok: true, found: false, deployId: null, candidates };
    },

    async "update:begin"({ deployId, targetImageTag } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      if (!deployId) return { ok: false, error: "deployId required" };
      send("update:phase", { phase: "refresh-templates", state: "running" });
      try {
        await resolveDeployDir({ force: true });
      } catch (e) {
        send("update:phase", { phase: "refresh-templates", state: "failed", error: e.message });
        return { ok: false, error: e.message };
      }
      writeUpdateState({
        deployId,
        targetImageTag: targetImageTag || null,
        phase: "starting",
        startedAt: new Date().toISOString(),
        lastError: null,
      });
      send("update:phase", { phase: "refresh-templates", state: "done" });
      return { ok: true };
    },

    // Rewrite vars.yml with the operator's chosen ID + Docker tag (and any
    // additional overrides). Reuses config:writeVars' mutation logic but
    // forces ID + DOCKER_IMAGE_VERSION from the Update flow inputs so the
    // operator can't accidentally drop them by leaving the advanced form
    // blank. Persists the chosen tag into update-state.json for downstream
    // hash-skip + verify steps.
    async "update:writeVars"({ deployId, dockerTag, vars } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      if (!deployId) return { ok: false, error: "deployId required" };
      if (!dockerTag) return { ok: false, error: "dockerTag required" };
      const deployDir = await resolveDeployDir();
      const file = path.join(deployDir, "vars.yml");
      const merged = {
        ...(vars || {}),
        id: deployId,
        dockerVersion: dockerTag,
      };
      const r = await handlers["config:writeVars"](merged);
      if (!r.ok) return r;
      writeUpdateState({ deployId, targetImageTag: dockerTag, phase: "vars-written" });
      return { ok: true, path: file };
    },

    async "update:updateXsuaa"({ deployId, skip } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      if (!deployId) return { ok: false, error: "deployId required" };
      const phase = "update-xsuaa";
      if (skip) {
        send("update:phase", { phase, state: "done", detail: "skipped by operator" });
        writeUpdateState({ phase: "xsuaa-updated", xsuaaSkipped: true });
        return { ok: true, skipped: true };
      }
      const deployDir = await resolveDeployDir();
      const xsPath = path.join(deployDir, "xs-security.json");
      if (!fs.existsSync(xsPath)) {
        send("update:phase", { phase, state: "failed", error: "xs-security.json missing" });
        return { ok: false, error: `xs-security.json not found at ${xsPath}` };
      }
      const hash = sha256OfFile(xsPath);
      const prev = readUpdateState() || {};
      // Plan D8: skip update-service when the refreshed template hashes
      // identically to the one we applied on a previous successful run.
      // First-run-after-deployment has no prior hash → always update.
      if (hash && prev["xs-security-hash"] === hash) {
        send("update:phase", { phase, state: "done", detail: "unchanged (hash match)" });
        writeUpdateState({ phase: "xsuaa-updated" });
        return { ok: true, skipped: true, reason: "hash-match" };
      }
      send("update:phase", { phase, state: "running" });
      const upd = await run(resolveCf(), ["update-service", "figaf-xsuaa", "-c", xsPath], { source: "cf" });
      if (upd.code !== 0) {
        const errText = upd.stderr || "update-service failed";
        send("update:phase", { phase, state: "failed", error: errText });
        writeUpdateState({ lastError: errText });
        return { ok: false, error: errText };
      }
      // Poll until the broker reports update succeeded/failed. 10-minute
      // timeout matches the cf:pollService shape; XSUAA updates are usually
      // sub-minute but the broker can be sluggish during landscape events.
      const start = Date.now();
      const timeoutMs = 10 * 60 * 1000;
      while (Date.now() - start < timeoutMs) {
        const s = await run(resolveCf(), ["service", "figaf-xsuaa"], { source: "cf" });
        const line = /status:\s+(.+)/i.exec(s.stdout)?.[1]?.trim() || "unknown";
        send("cf:serviceStatus", { name: "figaf-xsuaa", status: line });
        if (/update succeeded|create succeeded|succeeded/i.test(line)) {
          send("update:phase", { phase, state: "done" });
          writeUpdateState({ phase: "xsuaa-updated", "xs-security-hash": hash });
          return { ok: true, status: line };
        }
        if (/failed/i.test(line)) {
          send("update:phase", { phase, state: "failed", error: line });
          writeUpdateState({ lastError: line });
          return { ok: false, error: line };
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      send("update:phase", { phase, state: "failed", error: "timeout" });
      writeUpdateState({ lastError: "timeout polling figaf-xsuaa" });
      return { ok: false, error: "timeout polling figaf-xsuaa" };
    },

    // Rolling push of <deployId>-<role>. The manifest names both apps
    // (<id>-app via the figaf-app block, <id>-router via the approuter
    // block) using ((ID)) from vars.yml, so a single -f manifest.yml + the
    // already-rewritten vars.yml suffices. --strategy rolling keeps the
    // old instance serving until the new one is healthy (plan D2).
    async "update:pushApp"({ deployId, role } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      if (!deployId) return { ok: false, error: "deployId required" };
      if (role !== "app" && role !== "router") return { ok: false, error: "role must be 'app' or 'router'" };
      const name = `${deployId}-${role}`;
      const phase = role === "app" ? "push-app" : "push-router";
      const deployDir = await resolveDeployDir();
      send("update:phase", { phase, state: "running" });
      const args = ["push", name, "--strategy", "rolling", "--vars-file", "vars.yml", "-f", "manifest.yml"];
      const r = await run(resolveCf(), args, { source: "cf", cwd: deployDir });
      if (r.code !== 0) {
        const errText = r.stderr || `cf push ${name} failed`;
        send("update:phase", { phase, state: "failed", error: errText });
        writeUpdateState({ lastError: errText, lastFailedPhase: phase });
        return { ok: false, name, error: errText };
      }
      writeUpdateState({ phase: role === "app" ? "app-pushed" : "router-pushed" });
      send("update:phase", { phase, state: "done" });
      return { ok: true, name, strategy: "rolling" };
    },

    async "update:verify"({ deployId } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      if (!deployId) return { ok: false, error: "deployId required" };
      const appName = `${deployId}-app`;
      const routerName = `${deployId}-router`;
      const phase = "verify";
      send("update:phase", { phase, state: "running" });

      const g = await run(resolveCf(), ["app", "--guid", appName], { source: "cf" });
      const guid = g.code === 0 ? g.stdout.trim().split(/\r?\n/).filter(Boolean).pop() : null;
      let appImage = null;
      if (guid) {
        const d = await run(resolveCf(), ["curl", `/v3/apps/${guid}/droplets/current`], { source: "cf" });
        if (d.code === 0) {
          try { appImage = (JSON.parse(d.stdout).image) || null; } catch {}
        }
      }

      const r = await run(resolveCf(), ["app", routerName], { source: "cf" });
      const routerHealthy = r.code === 0 && /running|started/i.test(r.stdout);
      // Public route comes from the router's "routes" line in cf app output.
      // The exact text varies across cf versions, so we match a broad URL
      // shape rather than a fragile header keyword.
      let route = null;
      const urlMatch = /(https?:\/\/[^\s,]+)/i.exec(r.stdout);
      if (urlMatch) route = urlMatch[1].replace(/^https?:\/\//, "");
      if (!route) {
        const lineMatch = /^routes:\s+(\S+)/im.exec(r.stdout);
        if (lineMatch) route = lineMatch[1];
      }

      const state = readUpdateState() || {};
      const targetTag = state.targetImageTag;
      const tagMatches = !targetTag || (appImage && appImage.endsWith(`:${targetTag}`));

      if (!appImage || !routerHealthy || !tagMatches) {
        const detail = !appImage ? "could not read app image"
          : !tagMatches ? `image tag mismatch (got ${appImage}, expected ${targetTag})`
          : "router not in running state";
        send("update:phase", { phase, state: "failed", error: detail });
        writeUpdateState({ lastError: detail });
        return { ok: false, appImage, routerHealth: routerHealthy ? "running" : "unhealthy", route, error: detail };
      }

      writeUpdateState({ phase: "verified", completedAt: new Date().toISOString(), lastError: null });
      send("update:phase", { phase, state: "done" });
      return { ok: true, appImage, routerHealth: "running", route };
    },

    // shell ───────────────────────────────────────────────────────────────────
    // In hosted mode these are implemented client-side in cloud/client.js via
    // window.open / navigator.clipboard — the server handlers are never invoked.

    async "shell:openPasscodeUrl"({ landscape }) {
      const lp = landscape || state.landscape;
      if (!lp) return { ok: false, error: "No landscape yet" };
      const url = `https://login.${lp.replace(/^cf-/, "cf.")}.hana.ondemand.com/passcode`;
      await host.openExternal(url);
      return { ok: true, url };
    },

    async "shell:openExternal"({ url }) {
      await host.openExternal(url);
      return { ok: true };
    },

    async "shell:readClipboard"() {
      try {
        return { ok: true, text: (await host.readClipboard()) || "" };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  };

  function dispose() {
    if (state.cfLoginProc && !state.cfLoginProc.killed) {
      try { state.cfLoginProc.kill(); } catch {}
    }
    if (state.btpLoginProc && !state.btpLoginProc.killed) {
      try { state.btpLoginProc.kill(); } catch {}
    }
  }

  return { handlers, dispose };
}

module.exports = { createOrchestrator, DEPLOYMENT_ZIP_URL };

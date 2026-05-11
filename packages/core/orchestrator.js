"use strict";
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const { spawn } = require("child_process");
const https = require("https");

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
 */

function createOrchestrator({ host, send }) {
  const state = {
    landscape: null,
    org: null,
    space: null,
    user: null,
    subaccount: null,
    globalAccountSubdomain: null,
    btpLoginWaitingForChoice: false,
    cfLoginProc: null,
    btpLoginProc: null,
    deployDirResolved: null,
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
        resolve({ code: -1, stdout, stderr, error: err.message });
      });
      proc.on("close", (code) => {
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
      https.get(url, { headers: { "User-Agent": "Figaf-Manager" } }, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      }).on("error", reject);
    });
  }

  function httpsDownload(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
      const handle = (currentUrl, hops = 0) => {
        if (hops > 5) return reject(new Error("Too many redirects"));
        const headers = {
          "User-Agent": "Figaf-Manager",
          "Cookie": "eula_3_2_agreed=tools.hana.ondemand.com/developer-license-3_2.txt",
        };
        https.get(currentUrl, { headers }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            res.resume();
            const nextUrl = new URL(res.headers.location, currentUrl).href;
            return handle(nextUrl, hops + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
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
          ws.on("finish", () => ws.close(() => resolve(destPath)));
          ws.on("error", reject);
        }).on("error", reject);
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

  async function resolveDeployDir() {
    if (state.deployDirResolved) return state.deployDirResolved;

    const tmpl = host.resolveDeployTemplate();
    const userDir = host.getUserDataDir();

    if (tmpl.kind === "bundle") {
      const dest = path.join(userDir, "deploy");
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
        copyRecursiveSync(tmpl.src, dest);
      }
      state.deployDirResolved = dest;
    } else {
      // GitHub zip: extracts to <userDir>/Figaf-BTP-Deployment-btp-users/
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

      const ingest = (text, source) => {
        cleanBuffer += text.replace(ansiRe, "").replace(/\r(?!\n)/g, "\n");
        if (cleanBuffer.length > 16384) cleanBuffer = cleanBuffer.slice(-8192);
        flushLines(text, source);
        tryDetectGaPrompt();
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
          send("btp:loggedIn", { ...env, subdomain: state.globalAccountSubdomain });
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
      const env = await handlers["btp:listEnvInstances"]();
      send("btp:loggedIn", { ...env, subdomain });
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
      return { ok: true };
    },

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

      for (const sa of subaccounts) {
        const said = sa.guid || sa.subaccountGUID || sa.id;
        if (!said) continue;
        const r = await run(resolveBtp(), ["--format", "json", "list", "accounts/environment-instance", "--subaccount", said], { source: "btp" });
        if (r.code !== 0) continue;

        let parsed;
        try {
          const jsonStart = r.stdout.indexOf("{");
          parsed = jsonStart >= 0 ? JSON.parse(r.stdout.slice(jsonStart)) : null;
        } catch { continue; }
        if (!parsed) continue;

        const cf = (parsed.environmentInstances || []).find((e) => e.environmentType === "cloudfoundry");
        if (!cf) continue;

        state.landscape = cf.landscapeLabel;
        state.subaccount = cf.subaccountGUID || said;
        let org = null;
        try {
          const labels = typeof cf.labels === "string" ? JSON.parse(cf.labels) : cf.labels;
          org = labels?.["Org Name"] || null;
        } catch {}
        state.org = org;
        return {
          ok: true,
          landscape: cf.landscapeLabel,
          apiUrl: `https://api.${cf.landscapeLabel.replace(/^cf-/, "cf.")}.hana.ondemand.com`,
          org,
          subaccount: state.subaccount,
          subaccountName: sa.displayName || sa.name || null,
          subdomain: state.globalAccountSubdomain,
        };
      }
      return { ok: false, error: "No Cloud Foundry environment found in any subaccount" };
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

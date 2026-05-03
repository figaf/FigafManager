const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const { app, dialog } = require("electron");
const { spawn } = require("child_process");
const https = require("https");

let ipcMain = null;
let getWindow = null;
let shellApi = null;

const state = {
  landscape: null,
  org: null,
  space: null,
  user: null,
  subaccount: null,
  cfLoginProc: null,
  deployDirResolved: null,
  cliPaths: { btp: null, cf: null },
  cliPathsLoaded: false,
};

// ═══════════════════════════════════════════════════════════
//  CLI path persistence — we don't rely on PATH or shell aliases.
//  Spawn() with shell:false ignores aliases, so storing absolute
//  paths in userData/cliPaths.json is the right equivalent.
// ═══════════════════════════════════════════════════════════
function cliPathsFile() {
  return path.join(app.getPath("userData"), "cliPaths.json");
}
function loadCliPaths() {
  if (state.cliPathsLoaded) return state.cliPaths;
  state.cliPathsLoaded = true;
  try {
    const obj = JSON.parse(fs.readFileSync(cliPathsFile(), "utf8"));
    if (obj.btp && fs.existsSync(obj.btp)) state.cliPaths.btp = obj.btp;
    if (obj.cf && fs.existsSync(obj.cf)) state.cliPaths.cf = obj.cf;
  } catch {}
  return state.cliPaths;
}
function saveCliPaths() {
  fs.mkdirSync(path.dirname(cliPathsFile()), { recursive: true });
  fs.writeFileSync(cliPathsFile(), JSON.stringify(state.cliPaths, null, 2));
}
function resolveBtp() { loadCliPaths(); return state.cliPaths.btp || "btp"; }
function resolveCf()  { loadCliPaths(); return state.cliPaths.cf  || "cf";  }
function binDir() { return path.join(app.getPath("userData"), "bin"); }
function ensureBinDir() { fs.mkdirSync(binDir(), { recursive: true }); return binDir(); }

function emit(channel, payload) {
  const win = getWindow && getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function log(source, type, text) {
  emit("cli:line", { source, type, text });
}

function resolveDeployDir() {
  if (state.deployDirResolved) return state.deployDirResolved;

  const packedRoot = process.resourcesPath
    ? path.join(process.resourcesPath, "Figaf-BTP-Deployment-btp-users")
    : null;
  const devRoot = path.join(__dirname, "..", "Figaf-BTP-Deployment-btp-users");

  const source = packedRoot && fs.existsSync(packedRoot) ? packedRoot : devRoot;
  const writable = path.join(app.getPath("userData"), "deploy");

  if (!fs.existsSync(writable)) {
    fs.mkdirSync(writable, { recursive: true });
    copyRecursiveSync(source, writable);
  }
  state.deployDirResolved = writable;
  return writable;
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
    https.get(url, { headers: { "User-Agent": "Figaf-Installer" } }, (res) => {
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
        "User-Agent": "Figaf-Installer",
        "Cookie": "eula_3_2_agreed=tools.hana.ondemand.com/developer-license-3_2.txt"
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
  const r = await run("powershell", [
    "-NoProfile", "-Command",
    `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`,
  ]);
  if (r.code !== 0) throw new Error(`Expand-Archive failed: ${r.stderr || "unknown"}`);
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

const handlers = {
  // --- prerequisites ---
  async "prereq:whichBtp"() {
    loadCliPaths();
    if (state.cliPaths.btp && fs.existsSync(state.cliPaths.btp)) {
      return { ok: true, path: state.cliPaths.btp, source: "stored" };
    }
    const r = await run("where", ["btp"]);
    const first = r.stdout.split(/\r?\n/).find(Boolean);
    return { ok: r.code === 0 && !!first, path: first || null, source: first ? "path" : null };
  },
  async "prereq:whichCf"() {
    loadCliPaths();
    if (state.cliPaths.cf && fs.existsSync(state.cliPaths.cf)) {
      return { ok: true, path: state.cliPaths.cf, source: "stored" };
    }
    const r = await run("where", ["cf"]);
    const first = r.stdout.split(/\r?\n/).find(Boolean);
    return { ok: r.code === 0 && !!first, path: first || null, source: first ? "path" : null };
  },
  async "prereq:getCliPaths"() {
    loadCliPaths();
    return { btp: state.cliPaths.btp, cf: state.cliPaths.cf, binDir: binDir() };
  },
  async "prereq:clearCliPath"(_evt, { cli }) {
    if (cli !== "btp" && cli !== "cf") return { ok: false, error: "invalid cli" };
    state.cliPaths[cli] = null;
    saveCliPaths();
    return { ok: true };
  },
  async "prereq:openBtpDownloadPage"() {
    const url = "https://tools.hana.ondemand.com/#cloud";
    await shellApi.openExternal(url);
    return { ok: true, url };
  },
  async "prereq:installBtp"() {
    emit("cli:install", { cli: "btp", phase: "start" });
    try {
      const url = "https://tools.hana.ondemand.com/additional/btp-cli-windows-amd64-2.106.1.tar.gz";
      const filename = "btp-cli-windows-amd64-2.106.1.tar.gz";
      log("install", "line", `Downloading ${filename}`);
      const tmpTar = path.join(os.tmpdir(), `figaf-${filename}`);
      await httpsDownload(url, tmpTar, (got, total) => {
        if (!total) return;
        const pct = Math.round((got / total) * 100);
        emit("cli:install", { cli: "btp", phase: "download", percent: pct });
      });
      emit("cli:install", { cli: "btp", phase: "extract" });
      log("install", "line", "Extracting…");
      const tmpDir = path.join(os.tmpdir(), `figaf-btpcli-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      const r = await run("tar", ["-xzf", tmpTar, "-C", tmpDir]);
      if (r.code !== 0) throw new Error(`Extract failed: ${r.stderr || "unknown"}`);
      const files = walkSync(tmpDir);
      const btpExe = files.find(f => /[\\/]btp\.exe$/i.test(f));
      if (!btpExe) throw new Error("btp.exe not found in downloaded archive");
      const dest = path.join(ensureBinDir(), "btp.exe");
      try { fs.unlinkSync(dest); } catch {}
      fs.copyFileSync(btpExe, dest);
      state.cliPaths.btp = dest;
      saveCliPaths();
      try { fs.unlinkSync(tmpTar); } catch {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      const v = await run(dest, ["--version"], { source: "btp" });
      emit("cli:install", { cli: "btp", phase: "done", path: dest });
      return { ok: true, path: dest, version: (v.stdout || "").split(/\r?\n/)[0].trim() || "2.106.1" };
    } catch (e) {
      log("install", "err", `btp install failed: ${e.message}`);
      emit("cli:install", { cli: "btp", phase: "error", error: e.message });
      return { ok: false, error: e.message };
    }
  },
  async "prereq:installCf"() {
    emit("cli:install", { cli: "cf", phase: "start" });
    try {
      const rel = await httpsJson("https://api.github.com/repos/cloudfoundry/cli/releases/latest");
      const assets = rel.assets || [];
      const asset = assets.find(a => /winx64\.zip$/i.test(a.name) && !/installer/i.test(a.name));
      if (!asset) throw new Error("No Windows zip asset in cloudfoundry/cli latest release");
      log("install", "line", `Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);
      const tmpZip = path.join(os.tmpdir(), `figaf-${asset.name}`);
      await httpsDownload(asset.browser_download_url, tmpZip, (got, total) => {
        if (!total) return;
        const pct = Math.round((got / total) * 100);
        emit("cli:install", { cli: "cf", phase: "download", percent: pct });
      });
      emit("cli:install", { cli: "cf", phase: "extract" });
      log("install", "line", "Extracting…");
      const tmpDir = path.join(os.tmpdir(), `figaf-cfcli-${Date.now()}`);
      await extractZip(tmpZip, tmpDir);
      const files = walkSync(tmpDir);
      const cfExe = files.find(f => /[\\/]cf\d*\.exe$/i.test(f));
      if (!cfExe) throw new Error("cf.exe not found in downloaded archive");
      const dest = path.join(ensureBinDir(), "cf.exe");
      try { fs.unlinkSync(dest); } catch {}
      fs.copyFileSync(cfExe, dest);
      state.cliPaths.cf = dest;
      saveCliPaths();
      try { fs.unlinkSync(tmpZip); } catch {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      const v = await run(dest, ["--version"], { source: "cf" });
      emit("cli:install", { cli: "cf", phase: "done", path: dest });
      return { ok: true, path: dest, version: (v.stdout || "").trim() };
    } catch (e) {
      log("install", "err", `cf install failed: ${e.message}`);
      emit("cli:install", { cli: "cf", phase: "error", error: e.message });
      return { ok: false, error: e.message };
    }
  },
  async "prereq:locateCli"(_evt, { cli }) {
    if (cli !== "btp" && cli !== "cf") return { ok: false, error: "invalid cli" };
    const win = getWindow && getWindow();
    const picked = await dialog.showOpenDialog(win || null, {
      title: `Locate ${cli} executable or archive`,
      properties: ["openFile"],
      filters: [
        { name: "Executable or archive", extensions: ["exe", "zip"] },
        { name: "Executable", extensions: ["exe"] },
        { name: "Archive", extensions: ["zip"] },
      ],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, cancelled: true };
    const src = picked.filePaths[0];
    const ext = path.extname(src).toLowerCase();
    const dest = path.join(ensureBinDir(), `${cli}.exe`);
    try {
      if (ext === ".zip") {
        emit("cli:install", { cli, phase: "extract" });
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
      state.cliPaths[cli] = dest;
      saveCliPaths();
      const v = await run(dest, ["--version"], { source: cli });
      const version = ((v.stdout || "") + (v.stderr || "")).split(/\r?\n/).find(Boolean) || "";
      emit("cli:install", { cli, phase: "done", path: dest });
      return { ok: true, path: dest, version };
    } catch (e) {
      emit("cli:install", { cli, phase: "error", error: e.message });
      return { ok: false, error: e.message };
    }
  },
  async "prereq:dockerHub"() {
    try {
      const data = await httpsJson(
        "https://hub.docker.com/v2/repositories/figaf/app/tags?name=btp&page_size=1&ordering=-last_updated"
      );
      const latest = data?.results?.[0]?.name || null;
      return { ok: !!latest, latest };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
  async "prereq:disk"() {
    const drive = (process.env.SystemDrive || "C:") + "\\";
    const r = await run("powershell", [
      "-NoProfile",
      "-Command",
      `(Get-PSDrive ${drive[0]}).Free`,
    ]);
    const bytes = Number(r.stdout.trim());
    const gb = Number.isFinite(bytes) ? bytes / (1024 ** 3) : 0;
    return { ok: gb >= 2, gb: Number(gb.toFixed(1)), drive };
  },

  // --- BTP login + landscape ---
  async "btp:login"() {
    const r = await run(resolveBtp(), ["login", "--url", "https://cli.btp.cloud.sap", "--sso"], {
      source: "btp",
    });
    return { ok: r.code === 0, stdout: r.stdout, stderr: r.stderr };
  },
  async "btp:listEnvInstances"() {
    const r = await run(resolveBtp(), ["--format", "json", "list", "accounts/environment-instance"], {
      source: "btp",
    });
    if (r.code !== 0) return { ok: false, error: r.stderr || "btp failed" };
    const jsonStart = r.stdout.indexOf("{");
    let parsed;
    try {
      parsed = JSON.parse(r.stdout.slice(jsonStart));
    } catch (e) {
      return { ok: false, error: "Cannot parse btp output" };
    }
    const cf = (parsed.environmentInstances || []).find(
      (e) => e.environmentType === "cloudfoundry"
    );
    if (!cf) return { ok: false, error: "No Cloud Foundry environment" };
    state.landscape = cf.landscapeLabel;
    let org = null;
    try {
      const labels = typeof cf.labels === "string" ? JSON.parse(cf.labels) : cf.labels;
      org = labels?.["Org Name"] || null;
    } catch {}
    state.org = org;
    state.subaccount = cf.subaccountGUID || null;
    return {
      ok: true,
      landscape: cf.landscapeLabel,
      apiUrl: `https://api.${cf.landscapeLabel.replace(/^cf-/, 'cf.')}.hana.ondemand.com`,
      org,
      subaccount: state.subaccount,
    };
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
  async "btp:assignRole"(_evt, { user, role }) {
    const args = [
      "assign",
      "security/role-collection",
      role || "PI_Administrator",
      "--to-user",
      user,
    ];
    if (state.subaccount) args.push("--subaccount", state.subaccount);
    const r = await run(resolveBtp(), args, { source: "btp" });
    return { ok: r.code === 0, stdout: r.stdout, stderr: r.stderr };
  },

  // --- CF login + passcode ---
  async "cf:loginStart"(_evt, { apiUrl }) {
    const target = apiUrl || (state.landscape ? `https://api.${state.landscape.replace(/^cf-/, 'cf.')}.hana.ondemand.com` : null);
    if (!target) return { ok: false, error: "No API URL" };
    if (state.cfLoginProc && !state.cfLoginProc.killed) {
      try { state.cfLoginProc.kill(); } catch {}
    }
    const cfBin = resolveCf();
    const proc = spawn(cfBin, ["login", "-a", target, "--sso"], {
      shell: false,
      windowsHide: true,
    });
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
      if (code === 0) emit("cf:loggedIn", {});
      else emit("cf:loginFailed", { code });
      state.cfLoginProc = null;
    });
    return { ok: true, apiUrl: target };
  },
  async "cf:submitPasscode"(_evt, { code }) {
    const proc = state.cfLoginProc;
    if (!proc || proc.killed) return { ok: false, error: "No active cf login session" };
    try {
      proc.stdin.write(code.trim() + os.EOL);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
  async "cf:targetOrgSpace"() {
    const r = await run(resolveCf(), ["target"], { source: "cf" });
    if (r.code !== 0) return { ok: false, error: r.stderr };
    const org = /org:\s+(\S+)/i.exec(r.stdout)?.[1] || null;
    const space = /space:\s+(\S+)/i.exec(r.stdout)?.[1] || null;
    const user = /user:\s+(\S+)/i.exec(r.stdout)?.[1] || null;
    state.org = org || state.org;
    state.space = space || state.space;
    state.user = user || state.user;
    return { ok: true, org, space, user };
  },

  // --- config ---
  async "cf:domains"() {
    const r = await run(resolveCf(), ["domains"], { source: "cf" });
    if (r.code !== 0) return { ok: false, error: r.stderr };
    const rows = parseTable(r.stdout, ["name", "availability"]);
    const cfapps = rows
      .map((row) => row.name)
      .filter((n) => n && n.startsWith("cfapps."));
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
  async "config:dockerHubLatestBtpTag"() {
    try {
      const data = await httpsJson(
        "https://hub.docker.com/v2/repositories/figaf/app/tags?name=btp&page_size=1&ordering=-last_updated"
      );
      const latest = data?.results?.[0]?.name || null;
      return { ok: !!latest, tag: latest };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
  async "config:deployDir"() {
    return { path: resolveDeployDir() };
  },
  async "config:readVars"() {
    const file = path.join(resolveDeployDir(), "vars.yml");
    const text = await fsp.readFile(file, "utf8");
    return { ok: true, text, path: file };
  },
  async "config:writeVars"(_evt, vars) {
    const file = path.join(resolveDeployDir(), "vars.yml");
    let text = await fsp.readFile(file, "utf8");
    const mutations = [
      ["ID", vars.id],
      ["LANDSCAPE_APPS_DOMAIN", vars.domain],
      ["LOCATION_ID", vars.locationId],
      ["DOCKER_IMAGE_VERSION", vars.dockerVersion],
      ["DOCKER_USERNAME", vars.dockerUsername],
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

  // --- provision ---
  async "cf:createService"(_evt, { offering, plan, name, configFile }) {
    const deployDir = resolveDeployDir();
    const args = ["create-service", offering, plan, name];
    if (configFile) args.push("-c", configFile);
    const r = await run(resolveCf(), args, { source: "cf", cwd: deployDir });
    const alreadyExists = /already exists/i.test(r.stdout + r.stderr);
    return { ok: r.code === 0 || alreadyExists, alreadyExists, stderr: r.stderr };
  },
  async "cf:service"(_evt, { name }) {
    const r = await run(resolveCf(), ["service", name], { source: "cf" });
    if (r.code !== 0) return { ok: false, error: r.stderr };
    const statusLine = /status:\s+(.+)/i.exec(r.stdout);
    return {
      ok: true,
      status: statusLine ? statusLine[1].trim() : "unknown",
      raw: r.stdout,
    };
  },
  async "cf:pollService"(_evt, { name }) {
    const start = Date.now();
    const timeoutMs = 15 * 60 * 1000;
    while (Date.now() - start < timeoutMs) {
      const r = await run(resolveCf(), ["service", name], { source: "cf" });
      const line = /status:\s+(.+)/i.exec(r.stdout)?.[1]?.trim() || "unknown";
      emit("cf:serviceStatus", { name, status: line });
      if (/succeeded/i.test(line)) return { ok: true, status: line };
      if (/failed/i.test(line)) return { ok: false, status: line };
      await new Promise((r) => setTimeout(r, 10000));
    }
    return { ok: false, status: "timeout" };
  },

  // --- deploy ---
  async "cf:push"() {
    const deployDir = resolveDeployDir();
    const r = await run(resolveCf(), ["push", "--vars-file", "vars.yml"], {
      source: "cf",
      cwd: deployDir,
    });
    return { ok: r.code === 0, code: r.code };
  },

  // --- shell ---
  async "shell:openPasscodeUrl"(_evt, { landscape }) {
    const lp = landscape || state.landscape;
    if (!lp) return { ok: false, error: "No landscape yet" };
    const url = `https://login.${lp.replace(/^cf-/, 'cf.')}.hana.ondemand.com/passcode`;
    await shellApi.openExternal(url);
    return { ok: true, url };
  },
  async "shell:openExternal"(_evt, { url }) {
    await shellApi.openExternal(url);
    return { ok: true };
  },
};

module.exports = {
  register({ ipcMain: ipc, getWindow: gw, shell }) {
    ipcMain = ipc;
    getWindow = gw;
    shellApi = shell;
    for (const [channel, fn] of Object.entries(handlers)) {
      ipcMain.handle(channel, (_evt, payload) => fn(_evt, payload));
    }
  },
  dispose() {
    if (state.cfLoginProc && !state.cfLoginProc.killed) {
      try { state.cfLoginProc.kill(); } catch {}
    }
  },
};

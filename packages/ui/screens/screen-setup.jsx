/* global React, Ico, CheckRow, WizardFooter */

const fg = () => (typeof window !== "undefined" && window.figaf) || null;

// ═══════════════════════════════════════════════════════════
// Self-update check row — shown in the welcome checklist.
// ═══════════════════════════════════════════════════════════
// Pure view over ctx.selfUpdate (the actual check runs once in app.jsx and is
// stored at ctx.selfUpdate.check). Maps the result to a CheckRow state:
//   no result yet         → running  ("checking for updates…")
//   ok:false (404/network)→ unreachable (gray — NOT an error; current build is fine)
//   updateAvailable       → update (blue) + an "Update…" button in the meta slot
//   up to date            → done (green)
// Crucially this row is NOT part of ctx.prereqs, so it never gates the
// "Continue" button — an unreachable update server must not block the wizard.
function SelfUpdateCheckRow({ ctx, setCtx }) {
  const flags = (typeof window !== "undefined") && window.figafModeFlags;
  if (flags && flags.features && flags.features.selfUpdateBanner === false) return null;

  const su = ctx.selfUpdate || {};
  const check = su.check;

  if (su.installing) {
    return <CheckRow status="running" title="Installer update" sub="downloading installer…" />;
  }
  if (su.installError) {
    return <CheckRow status="unreachable" title="Installer update" sub={"install failed: " + su.installError} />;
  }
  if (!check) {
    return <CheckRow status="running" title="Installer version" sub="checking for updates…" />;
  }
  if (check.ok === false) {
    return <CheckRow status="unreachable" title="Installer version" sub="update server unreachable" />;
  }
  if (check.updateAvailable) {
    const isCloud = check.host === "cloud";
    const hasAsset = isCloud ? !!(check.assets && check.assets.cloud) : !!(check.assets && check.assets.desktop);
    const meta = hasAsset ? (
      <button
        className="btn btn-primary"
        style={{ padding: "5px 12px", fontSize: 12 }}
        onClick={() => window.figafTriggerSelfUpdate && window.figafTriggerSelfUpdate(check, setCtx)}
      >
        {isCloud ? "Update wizard…" : "Update installer…"}
      </button>
    ) : null;
    const sub = hasAsset
      ? `v${check.current} → v${check.latest}`
      : `v${check.current} → v${check.latest} · release missing artifact`;
    return <CheckRow status="update" title="Installer update available" sub={sub} meta={meta} />;
  }
  return <CheckRow status="done" title="Installer version" sub={`v${check.current} · up to date`} />;
}

// ═══════════════════════════════════════════════════════════
// 0. Browser-auth banner (hosted-only)
// ═══════════════════════════════════════════════════════════
// Surfaces "your session was kicked" feedback when the cloud server has
// invalidated this browser's auth cookie mid-flow. Driven by two signals:
//   1. window.figafAuthKicked — set by index.html's one-shot sessionStorage
//      check on page load (i.e., we just came back from /setup after a kick).
//   2. btp:browserAuth event — fired by cloud/client.js when a live request
//      hits 401/4003 (i.e., we're about to redirect now).
// Gated on window.figafModeFlags.isHosted so figaf-local never renders this.
function BrowserAuthBanner() {
  const isHosted = (typeof window !== "undefined") && window.figafModeFlags && window.figafModeFlags.isHosted;
  const [visible, setVisible] = React.useState(false);
  const [message, setMessage] = React.useState("");

  React.useEffect(() => {
    if (!isHosted) return;
    // 1. Cold-load case: we were just redirected back from /setup.
    if (window.figafAuthKicked) {
      setMessage("Your previous session expired and was re-authenticated. Pick up where you left off.");
      setVisible(true);
      window.figafAuthKicked = false;
    }
    // 2. Live case: a kick is happening right now (about to redirect).
    const api = fg();
    if (!api || !api.on) return;
    const off = api.on("btp:browserAuth", () => {
      setMessage("Session expired — redirecting to setup…");
      setVisible(true);
    });
    return () => off && off();
  }, [isHosted]);

  if (!isHosted || !visible) return null;
  return (
    <div
      role="status"
      style={{
        padding: "10px 14px",
        marginBottom: 12,
        borderRadius: 8,
        background: "rgba(234, 179, 8, 0.10)",
        border: "1px solid rgba(234, 179, 8, 0.35)",
        color: "#7c4a03",
        fontSize: 13,
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <Ico.Info style={{ flexShrink: 0 }} />
      <span style={{ flex: 1 }}>{message}</span>
      <button
        type="button"
        onClick={() => setVisible(false)}
        style={{ background: "transparent", border: "none", color: "#7c4a03", cursor: "pointer", fontSize: 12 }}
      >
        Dismiss
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 1. Welcome / Prerequisites
// ═══════════════════════════════════════════════════════════
function CliInstaller({ id, onInstalled }) {
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    const api = fg();
    if (!api) return;
    const off = api.on("cli:install", (msg) => {
      if (!msg || msg.cli !== id) return;
      if (msg.phase === "error") setError(msg.error || "Install failed");
      else setError(null);
      setProgress(msg);
    });
    return () => off && off();
  }, [id]);

  async function clickInstall() {
    const api = fg();
    if (!api) return;
    setError(null);
    setBusy(true);
    try {
      if (id === "cf") {
        const r = await api.prereq.installCf();
        if (r.ok) onInstalled(r.path, r.version);
        else setError(r.error || "Install failed");
      } else {
        const r = await api.prereq.installBtp();
        if (r.ok) onInstalled(r.path, r.version);
        else setError(r.error || "Install failed");
      }
    } finally {
      setBusy(false);
    }
  }

  async function clickLocate() {
    const api = fg();
    if (!api) return;
    setError(null);
    setBusy(true);
    try {
      const r = await api.prereq.locateCli(id);
      if (r.ok) onInstalled(r.path, r.version);
      else if (!r.cancelled) setError(r.error || "Could not register CLI");
    } finally {
      setBusy(false);
    }
  }

  const label = id === "btp" ? "SAP BTP CLI" : "Cloud Foundry CLI";
  const installLabel = id === "btp"
    ? "Download BTP CLI"
    : "Download CF CLI";

  let statusText = "";
  if (progress && busy) {
    if (progress.phase === "start")    statusText = `Preparing ${label}…`;
    else if (progress.phase === "download") statusText = `Downloading… ${progress.percent || 0}%`;
    else if (progress.phase === "extract")  statusText = "Extracting…";
    else if (progress.phase === "done")     statusText = "Verifying…";
  }

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 10,
        padding: "10px 12px",
        borderRadius: 8,
        background: "var(--fg-blue-soft, rgba(21,101,216,0.07))",
        border: "1px solid rgba(21,101,216,0.18)",
      }}
    >
      <div style={{ flex: "1 1 200px", fontSize: 12, color: "var(--ink-2)" }}>
        <strong style={{ color: "var(--ink-0)" }}>{label}</strong> not found.{" "}
        {id === "btp"
          ? "Downloads the SAP BTP CLI."
          : "Downloads the latest release from GitHub."}
        {statusText && <span style={{ marginLeft: 8, color: "var(--fg-blue)" }}>{statusText}</span>}
        {error && <div style={{ marginTop: 4, color: "var(--error, #e11d48)" }}>{error}</div>}
      </div>
            <button className="btn btn-primary" style={{ width: "165px" }} onClick={clickInstall} disabled={busy}>
        {busy ? <Ico.Spinner /> : <Ico.ArrowRight />} {installLabel}
      </button>
      <button className="btn" onClick={clickLocate} disabled={busy}>
        <Ico.Search /> Locate existing…
      </button>
    </div>
  );
}

function ScreenWelcome({ ctx, setCtx, onNext }) {
  const checks = ctx.prereqs;
  const allDone = checks.every(c => c.status === "done");
  const anyRunning = checks.some(c => c.status === "running");

  const markRunning = React.useCallback((id) =>
    setCtx(c => ({ ...c, prereqs: c.prereqs.map(p => p.id === id ? { ...p, status: "running" } : p) })), [setCtx]);
  const markDone = React.useCallback((id, sub) =>
    setCtx(c => ({ ...c, prereqs: c.prereqs.map(p => p.id === id ? { ...p, status: "done", sub } : p) })), [setCtx]);
  const markError = React.useCallback((id, sub) =>
    setCtx(c => ({ ...c, prereqs: c.prereqs.map(p => p.id === id ? { ...p, status: "error", sub } : p) })), [setCtx]);

  const recheckCli = React.useCallback(async (id) => {
    const api = fg();
    if (!api) return;
    markRunning(id);
    const r = id === "btp" ? await api.prereq.whichBtp() : await api.prereq.whichCf();
    if (r.ok) markDone(id, r.path || `${id} detected`);
    else markError(id, r.error || "Not found");
  }, [markRunning, markDone, markError]);

  const isHosted = window.figafModeFlags.isHosted;

  React.useEffect(() => {
    if (ctx.prereqsStarted) return;
    setCtx(c => ({ ...c, prereqsStarted: true }));
    const api = fg();
    if (!api) return;

    (async () => {
      const run = async (id, label, fn) => {
        markRunning(id);
        try {
          const res = await fn();
          if (res && res.ok) markDone(id, label(res));
          else markError(id, (res && res.error) || "Not found");
        } catch (e) { markError(id, e.message); }
      };

      if (isHosted) {
        // CLIs are bundled in the container; skip local probe + disk check
        markDone("btp", "bundled in container");
        markDone("cf", "bundled in container");
        markDone("disk", "container filesystem ready");
        await run("net", (r) => r.latest ? `hub.docker.com · ${r.latest}` : "docker hub reachable", () => api.prereq.dockerHub());
      } else {
        await Promise.all([
          run("btp",  (r) => r.path ? r.path : "btp detected", () => api.prereq.whichBtp()),
          run("cf",   (r) => r.path ? r.path : "cf detected", () => api.prereq.whichCf()),
          run("net",  (r) => r.latest ? `hub.docker.com · ${r.latest}` : "docker hub reachable", () => api.prereq.dockerHub()),
          run("disk", (r) => `${r.gb} GB free on ${r.drive}`, () => api.prereq.disk()),
        ]);
      }
    })();
    // eslint-disable-next-line
  }, []);

  const btpMissing = !isHosted && checks.find(c => c.id === "btp")?.status === "error";
  const cfMissing  = !isHosted && checks.find(c => c.id === "cf")?.status === "error";

  return (
    <>
      <div className="pane-body">
        <BrowserAuthBanner />
        <div className="pane-head">
          <div className="pane-eyebrow">Step 1 · Welcome</div>
          {isHosted
            ? <h1 className="pane-title">Figaf Manager is running in your BTP subaccount</h1>
            : <h1 className="pane-title">Let's get Figaf running on SAP BTP</h1>
          }
          {isHosted
            ? <p className="pane-desc">The manager app is live in your Cloud Foundry space. We'll confirm Docker Hub is reachable, then walk you through the deployment.</p>
            : <p className="pane-desc">This installer deploys the Figaf Tool to your SAP BTP Cloud Foundry space and wires up the services it needs. We'll check your environment first.</p>
          }
        </div>

        <div className="card" style={{ padding: "4px 18px" }}>
          <div className="checklist">
            {checks.map(c => <CheckRow key={c.id} {...c} />)}
            <SelfUpdateCheckRow ctx={ctx} setCtx={setCtx} />
          </div>
        </div>

        {(btpMissing || cfMissing) && (
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, color: "var(--ink-3)" }}>
              <Ico.Info style={{ color: "var(--fg-blue)", flexShrink: 0, marginTop: 2 }} />
              <span>
                Install the missing CLI below — we'll remember where it lives, so no PATH changes are needed.
              </span>
            </div>
            {btpMissing && <CliInstaller id="btp" onInstalled={() => recheckCli("btp")} />}
            {cfMissing  && <CliInstaller id="cf"  onInstalled={() => recheckCli("cf")}  />}
          </div>
        )}
      </div>

      <WizardFooter
        showBack={false}
        nextLabel={anyRunning ? "Checking…" : "Continue"}
        nextDisabled={!allDone}
        onNext={onNext}
      />
    </>
  );
}

Object.assign(window, { ScreenWelcome });

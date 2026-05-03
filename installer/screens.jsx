/* global React, Ico, CheckRow, WizardFooter */
// Screens for the Figaf Installer — wired to the main-process CLI bridge via window.figaf.

const fg = () => (typeof window !== "undefined" && window.figaf) || null;

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
      await Promise.all([
        run("btp",  (r) => r.path ? r.path : "btp detected", () => api.prereq.whichBtp()),
        run("cf",   (r) => r.path ? r.path : "cf detected", () => api.prereq.whichCf()),
        run("net",  (r) => r.latest ? `hub.docker.com · ${r.latest}` : "docker hub reachable", () => api.prereq.dockerHub()),
        run("disk", (r) => `${r.gb} GB free on ${r.drive}`, () => api.prereq.disk()),
      ]);
    })();
    // eslint-disable-next-line
  }, []);

  const btpMissing = checks.find(c => c.id === "btp")?.status === "error";
  const cfMissing  = checks.find(c => c.id === "cf")?.status === "error";

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 1 · Welcome</div>
          <h1 className="pane-title">Let's get Figaf running on SAP BTP</h1>
          <p className="pane-desc">
            This installer deploys the Figaf Tool to your SAP BTP Cloud Foundry space and
            wires up the services it needs. We'll check your environment first.
          </p>
        </div>

        <div className="card" style={{ padding: "4px 18px" }}>
          <div className="checklist">
            {checks.map(c => <CheckRow key={c.id} {...c} />)}
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

// ═══════════════════════════════════════════════════════════
// 2. CLI Login — SSO + passcode
// ═══════════════════════════════════════════════════════════
function ScreenLogin({ ctx, setCtx, onNext, appendLog }) {
  const { login } = ctx;
  const setLogin = (patch) => setCtx(c => ({ ...c, login: { ...c.login, ...patch } }));
  const [gaChoice, setGaChoice] = React.useState(null);

  const btpLoggedIn = login.btpStatus === "done";
  const cfLoggedIn = login.cfStatus === "done";
  const canContinue = btpLoggedIn && cfLoggedIn;

  React.useEffect(() => {
    const api = fg();
    if (!api) return;
    const offCf1 = api.on("cf:loggedIn", () => {
      setLogin({ cfStatus: "done" });
      (async () => {
        const t = await api.cf.targetOrgSpace();
        if (t && t.ok) setLogin({ org: t.org, space: t.space, user: t.user || login.user });
      })();
    });
    const offCf2 = api.on("cf:loginFailed", () => setLogin({ cfStatus: "error" }));

    const offGaChoice = api.on("btp:gaChoice", (p) => {
      setGaChoice(p);
    });
    const offBtpOk = api.on("btp:loggedIn", (env) => {
      setGaChoice(null);
      if (env && env.ok) {
        setLogin({
          btpStatus: "done",
          landscape: env.landscape,
          subaccount: env.subaccount || "",
          subaccountName: env.subaccountName || "",
          subdomain: env.subdomain || "",
          org: env.org || "",
          apiUrl: env.apiUrl,
        });
      } else {
        setLogin({ btpStatus: "error" });
      }
    });
    const offBtpFail = api.on("btp:loginFailed", () => {
      setGaChoice(null);
      setLogin({ btpStatus: "error" });
    });

    return () => {
      offCf1 && offCf1();
      offCf2 && offCf2();
      offGaChoice && offGaChoice();
      offBtpOk && offBtpOk();
      offBtpFail && offBtpFail();
    };
    // eslint-disable-next-line
  }, []);

  async function startBtpLogin() {
    const api = fg();
    if (!api) return;
    setGaChoice(null);
    setLogin({ btpStatus: "running" });
    await api.btp.loginStart();
  }

  async function cancelBtpLogin() {
    const api = fg();
    if (!api) return;
    setGaChoice(null);
    await api.btp.cancelLogin();
    setLogin({ btpStatus: "idle" });
  }

  async function selectGa(val) {
    const api = fg();
    if (!api) return;
    setGaChoice(null);
    setLogin({ btpStatus: "running" });
    if (typeof val === "number") {
      // Interactive mode: write the choice index to the live btp login stdin
      await api.btp.submitChoice(val);
    } else {
      // Post-login mode: target the GA by subdomain in a separate btp call
      await api.btp.selectGlobalAccount(val);
    }
  }

  async function handleLogout() {
    const api = fg();
    if (!api) return;
    await api.btp.logout();
    setLogin({
      btpStatus: "idle", cfStatus: "idle",
      landscape: "", subaccount: "", subaccountName: "", subdomain: "", org: "", space: "", user: "", apiUrl: "",
      passcode: "", passcodeRequested: false,
    });
  }

  async function handleCfLogout() {
    const api = fg();
    if (!api) return;
    await api.cf.logout();
    setLogin({
      cfStatus: "idle",
      org: "", space: "",
      passcode: "", passcodeRequested: false,
    });
  }

  async function requestPasscode() {
    const api = fg();
    if (!api) return;
    setLogin({ passcodeRequested: true });
    await api.shell.openPasscodeUrl(login.landscape);
    await api.cf.loginStart(login.apiUrl || `https://api.${login.landscape.replace(/^cf-/, 'cf.')}.hana.ondemand.com`);
  }

  async function submitPasscode() {
    const api = fg();
    if (!api) return;
    if (!login.passcode || login.passcode.length < 4) return;
    setLogin({ cfStatus: "running" });
    await api.cf.submitPasscode(login.passcode);
  }

  async function pastePasscode() {
    const api = fg();
    if (!api) return;
    try {
      const r = await api.shell.readClipboard();
      if (!r || !r.ok) {
        appendLog([{ type: "warn", text: "Could not read clipboard." }]);
        return;
      }
      const value = (r.text || "").trim();
      if (!value) {
        appendLog([{ type: "warn", text: "Clipboard is empty." }]);
        return;
      }
      setLogin({ passcode: value });
    } catch {
      appendLog([{ type: "warn", text: "Could not read clipboard." }]);
    }
  }

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 2 · Authenticate</div>
          <h1 className="pane-title">Sign in to SAP BTP and Cloud Foundry</h1>
          <p className="pane-desc">
            Both CLIs use single sign-on. We'll open your browser, then you'll paste a one-time passcode for the Cloud Foundry CLI.
          </p>
        </div>

        <div className="field" style={{ marginBottom: 22 }}>
          <div className="field-label">Sign-in method</div>
          <div className="radio-row">
            <div className="radio-tile selected">
              <Ico.Shield style={{ width: 14, height: 14 }} /> Single sign-on (SSO)
            </div>
            <div className="radio-tile" style={{ opacity: 0.55 }}>
              <Ico.User style={{ width: 14, height: 14 }} /> Username & password
              <span className="pill gray" style={{ marginLeft: 4 }}>Coming soon</span>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: (btpLoggedIn || gaChoice) ? 10 : 14 }}>
            <div style={{ width: 36, height: 36, borderRadius: 8, background: "var(--fg-blue-soft)", color: "var(--fg-blue)", display: "grid", placeItems: "center" }}>
              <Ico.Cloud />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-0)" }}>SAP BTP CLI</div>
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>cli.btp.cloud.sap</div>
            </div>
            {btpLoggedIn && <span className="pill green"><Ico.Check /> Connected</span>}
            {btpLoggedIn && (
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={handleLogout}>
                Sign out
              </button>
            )}
            {!btpLoggedIn && login.btpStatus === "running" && gaChoice && (
              <span className="pill blue">Awaiting selection</span>
            )}
            {!btpLoggedIn && login.btpStatus === "running" && !gaChoice && (
              <span className="pill blue"><Ico.Spinner /> Connecting…</span>
            )}
            {login.btpStatus === "idle" && (
              <button className="btn btn-primary" onClick={startBtpLogin}>
                Sign in with SSO <Ico.External />
              </button>
            )}
            {login.btpStatus === "error" && (
              <button className="btn btn-primary" onClick={startBtpLogin}>
                Retry <Ico.External />
              </button>
            )}
          </div>

          {!btpLoggedIn && gaChoice && gaChoice.accounts && gaChoice.accounts.length > 0 && (
            <div className="slide-in" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 4 }}>
                Choose a global account
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>
                Your account has access to multiple global accounts. Pick the one you want to use.
              </div>
              {(() => {
                const names = gaChoice.accounts.map(a => a.displayName || "");
                const hasDuplicates = names.some((n, i) => n && names.indexOf(n) !== i);
                return hasDuplicates ? (
                  <div style={{ marginBottom: 10, padding: "8px 10px", borderRadius: 6, background: "rgba(234,179,8,0.1)", border: "1px solid rgba(234,179,8,0.3)", fontSize: 11.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
                    Some accounts share the same display name. The order matches the BTP cockpit's global account switcher — if unsure, try option 1 and you can sign out to retry.
                  </div>
                ) : null;
              })()}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {gaChoice.accounts.map((acct, i) => {
                  const name = acct.displayName || acct.subdomain || acct.guid || `Account ${i + 1}`;
                  const sub = acct.subdomain;
                  const region = acct.region || acct.commercialRegion;
                  const meta = [
                    sub && sub !== name && `subdomain: ${sub}`,
                    region && `region: ${region}`,
                    acct.commercialModel,
                  ].filter(Boolean);
                  return (
                    <button
                      key={acct.index || acct.guid || i}
                      className="choice"
                      style={{ flexDirection: "row", alignItems: "center", padding: "12px 14px", gap: 14, textAlign: "left" }}
                      onClick={() => selectGa(typeof acct.index === "number" ? acct.index : (acct.subdomain || acct.guid))}
                    >
                      <div style={{ width: 28, height: 28, borderRadius: 6, background: "var(--fg-blue-soft)", color: "var(--fg-blue)", display: "grid", placeItems: "center", flexShrink: 0, fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
                        {acct.index || (i + 1)}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-0)" }}>{name}</div>
                        {meta.length > 0 && (
                          <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2, fontFamily: "var(--font-mono)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {meta.join(" · ")}
                          </div>
                        )}
                      </div>
                      <Ico.ArrowRight />
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={cancelBtpLogin}>
                  Cancel sign-in
                </button>
              </div>
            </div>
          )}

          {btpLoggedIn && (
            <div className="summary-grid slide-in">
              {login.subdomain && <div className="cell"><div className="k">Global account</div><div className="v">{login.subdomain}</div></div>}
              {login.subaccountName && <div className="cell"><div className="k">Subaccount</div><div className="v">{login.subaccountName}</div></div>}
              {login.org && <div className="cell"><div className="k">Org</div><div className="v">{login.org}</div></div>}
              <div className="cell"><div className="k">Landscape</div><div className="v">{login.landscape}</div></div>
              <div className="cell"><div className="k">API endpoint</div><div className="v">api.{login.landscape.replace(/^cf-/, 'cf.')}.hana.ondemand.com</div></div>
            </div>
          )}
        </div>

        <div className="card" style={{ opacity: btpLoggedIn ? 1 : 0.55 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <div style={{ width: 36, height: 36, borderRadius: 8, background: "var(--fg-blue-soft)", color: "var(--fg-blue)", display: "grid", placeItems: "center" }}>
              <Ico.Box />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-0)" }}>Cloud Foundry CLI</div>
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                {btpLoggedIn ? `api.${login.landscape.replace(/^cf-/, 'cf.')}.hana.ondemand.com` : "Detected after BTP login"}
              </div>
            </div>
            {cfLoggedIn && <span className="pill green"><Ico.Check /> Connected</span>}
            {cfLoggedIn && (
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={handleCfLogout}>
                Sign out
              </button>
            )}
          </div>

          {btpLoggedIn && !cfLoggedIn && (
            <div className="slide-in">
              {!login.passcodeRequested ? (
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <button className="btn btn-primary" onClick={requestPasscode}>
                    Get passcode in browser <Ico.External />
                  </button>
                  <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                    Opens <span className="kbd">login.{login.landscape.replace(/^cf-/, 'cf.')}.hana.ondemand.com/passcode</span>
                  </span>
                </div>
              ) : (
                <div className="slide-in">
                  <div className="sso-mock" style={{ marginBottom: 12 }}>
                    <div className="sso-mock-icon"><Ico.Shield /></div>
                    <div style={{ flex: 1, fontSize: 12, color: "var(--ink-2)" }}>
                      Browser opened to get a one-time passcode. Copy it from SAP and paste below.
                    </div>
                  </div>
                  <div className="field">
                    <label className="field-label">
                      One-time passcode <span className="field-required">*</span>
                    </label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        className="input is-mono"
                        placeholder="paste passcode"
                        value={login.passcode}
                        onChange={(e) => setLogin({ passcode: e.target.value.trim() })}
                        disabled={login.cfStatus === "running"}
                        style={{ flex: 1, letterSpacing: "0.12em" }}
                      />
                      <button
                        className="btn"
                        onClick={pastePasscode}
                        disabled={login.cfStatus === "running"}
                      >
                        Paste
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={submitPasscode}
                        disabled={!login.passcode || login.cfStatus === "running"}
                      >
                        {login.cfStatus === "running" ? <><Ico.Spinner /> Authenticating</> : <>Continue <Ico.ArrowRight /></>}
                      </button>
                    </div>
                    <div className="field-hint">
                      Passcodes expire after a few minutes. <button className="btn-link" onClick={() => fg()?.shell.openPasscodeUrl(login.landscape)}>Get a new one</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {cfLoggedIn && (
            <div className="summary-grid slide-in">
              {login.org && <div className="cell"><div className="k">Org</div><div className="v">{login.org}</div></div>}
              {login.space && <div className="cell"><div className="k">Space</div><div className="v">{login.space}</div></div>}
            </div>
          )}
        </div>
      </div>

      <WizardFooter nextDisabled={!canContinue} onNext={onNext} onBack={null} />
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// 3. Post-login choice
// ═══════════════════════════════════════════════════════════
function ScreenChoice({ ctx, setCtx, onNext, onBack }) {
  const sel = ctx.choice;
  function pick(v) { setCtx(c => ({ ...c, choice: v })); }

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 3 · Choose action</div>
          <h1 className="pane-title">What would you like to do?</h1>
          <p className="pane-desc">
            Signed in as <strong>{ctx.login.user || "you"}</strong> on <span className="kbd">{ctx.login.landscape}</span>. Pick how you'd like to continue — you can do the other later.
          </p>
        </div>

        <div className="choice-grid">
          <button
            className={`choice ${sel === "deploy" ? "selected" : ""}`}
            onClick={() => pick("deploy")}
          >
            <div className="choice-icon"><Ico.Box /></div>
            <div className="choice-title">
              Deploy Figaf Tool
              <span className="pill blue">Recommended</span>
            </div>
            <div className="choice-desc">
              Push the Figaf Tool to your Cloud Foundry space along with its PostgreSQL and XSUAA services.
            </div>
          </button>

          <button
            className={`choice ${sel === "connect" ? "selected" : ""}`}
            onClick={() => pick("connect")}
          >
            <div className="choice-icon"><Ico.Link /></div>
            <div className="choice-title">
              Connect to Integration Suite
            </div>
            <div className="choice-desc">
              Link an existing Figaf deployment to your SAP Integration Suite tenant for tracking & testing.
            </div>
          </button>
        </div>

        <div className="divider" />

        <div style={{ fontSize: 12, color: "var(--ink-3)", display: "flex", gap: 8, alignItems: "flex-start" }}>
          <Ico.Info style={{ color: "var(--fg-blue)", flexShrink: 0, marginTop: 1 }} />
          <span>
            Fresh install? Choose <strong>Deploy</strong>. Already running Figaf and just need to wire up Integration Suite? Choose <strong>Connect</strong>.
          </span>
        </div>
      </div>

      <WizardFooter
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!sel}
        nextLabel={sel === "connect" ? "Configure connection" : "Configure deployment"}
      />
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// 4. Deploy config
// ═══════════════════════════════════════════════════════════
function ScreenConfig({ ctx, setCtx, onNext, onBack, appendLog }) {
  const cfg = ctx.config;
  const setCfg = (patch) => setCtx(c => ({ ...c, config: { ...c.config, ...patch } }));
  const [domains, setDomains] = React.useState([]);
  const [plans, setPlans] = React.useState(ctx.dbPlans);
  const [dockerTags, setDockerTags] = React.useState([]);
  const [writing, setWriting] = React.useState(false);

  const valid = cfg.id && cfg.domain && cfg.dbPlan && cfg.dockerVersion;

  React.useEffect(() => {
    const api = fg();
    if (!api) return;
    (async () => {
      const landscape = ctx.login.landscape;

      const d = await api.cf.domains();
      let doms = d.ok ? d.domains : [];
      if (!doms.length && landscape) doms = [`cfapps.${landscape.replace(/^cf-/, '')}.hana.ondemand.com`];
      setDomains(doms);
      if (!cfg.domain && doms.length) setCfg({ domain: doms[0] });

      const tag = await api.config.dockerHubLatestBtpTag();
      if (tag.ok) {
        setCfg({ dockerVersion: tag.tag });
      }

      const tags = await api.config.dockerHubBtpTags();
      if (tags.ok && tags.tags.length) {
        setDockerTags(tags.tags);
      }

      const mk = await api.cf.marketplacePostgresql();
      if (mk.ok && mk.plans.length) {
        const mapped = mk.plans.map((p) => ({ name: p.name, description: p.description, free: p.free, size: p.free ? "shared" : "—" }));
        setPlans(mapped);
        setCtx(c => ({ ...c, dbPlans: mapped }));
        if (!mapped.find(p => p.name === cfg.dbPlan)) setCfg({ dbPlan: mapped[0].name });
      }
    })();
    // eslint-disable-next-line
  }, []);

  async function handleNext() {
    const api = fg();
    if (!api) return onNext();
    setWriting(true);
    const r = await api.config.writeVars({
      id: cfg.id,
      domain: cfg.domain,
      locationId: cfg.locationId,
      dockerVersion: cfg.dockerVersion,
      instanceMemory: cfg.instanceMemory,
      maxRamPercentage: cfg.maxRamPercentage,
      logsTotalSizeCap: cfg.logsTotalSizeCap,
      enableInstanceMonitoring: cfg.enableInstanceMonitoring,
      useCloudConnectorForSmtpIntegration: cfg.useCloudConnectorForSmtpIntegration,
      cloudConnectorDestinationNameForSmtpIntegration: cfg.cloudConnectorDestinationNameForSmtpIntegration,
    });
    setWriting(false);
    if (r && r.ok) onNext();
  }

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 4 · Configuration</div>
          <h1 className="pane-title">Configure the deployment</h1>
          <p className="pane-desc">
            We'll write these values to <span className="kbd">vars.yml</span> and create the PostgreSQL service from the selected plan.
          </p>
        </div>

        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", margin: "0 0 12px" }}>General</div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 8 }}>
          <div className="field">
            <label className="field-label">
              Application ID <span className="field-required">*</span>
            </label>
            <input
              className="input is-mono"
              value={cfg.id}
              onChange={(e) => setCfg({ id: e.target.value })}
              placeholder="figaf-tool"
            />
            <div className="field-hint">Route path — lowercase, no spaces.</div>
          </div>

          <div className="field">
            <label className="field-label">
              Location ID
            </label>
            <input
              className="input is-mono"
              value={cfg.locationId}
              onChange={(e) => setCfg({ locationId: e.target.value })}
              placeholder="location-1"
              maxLength={20}
            />
            <div className="field-hint">Must be configured properly for integration with PI system through a Cloud connection.</div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 4 }}>
          <div className="field">
            <label className="field-label">
              Landscape apps domain <span className="field-required">*</span>
            </label>
            <select
              className="select is-mono"
              value={cfg.domain}
              onChange={(e) => setCfg({ domain: e.target.value })}
            >
              <option value="">Select a domain…</option>
              {domains.map(d => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            <div className="field-hint">
              Detected from <span className="kbd">cf domains</span>.
            </div>
          </div>

          <div className="field">
            <label className="field-label">
              Docker image version <span className="field-required">*</span>
            </label>
            <input
              list="dockerVersionsList"
              className="select is-mono"
              value={cfg.dockerVersion || ""}
              onChange={(e) => setCfg({ dockerVersion: e.target.value })}
              placeholder="2403-btp"
            />
            <datalist id="dockerVersionsList">
              {dockerTags.map((tag) => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
            <div className="field-hint">Latest Figaf image tag from Docker Hub (auto-detected). Select from dropdown or enter manually.</div>
          </div>
        </div>

        <div className="divider" />

        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", margin: "0 0 12px" }}>Application settings</div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 8 }}>
          <div className="field">
            <label className="field-label">
              Instance memory <span className="field-required">*</span>
            </label>
            <input
              className="input is-mono"
              value={cfg.instanceMemory}
              onChange={(e) => setCfg({ instanceMemory: e.target.value })}
              placeholder="3700M"
            />
            <div className="field-hint">RAM allocated for the app. Possible units: K, M, G, k, m, g</div>
          </div>

          <div className="field">
            <label className="field-label">
              Max RAM percentage <span className="field-required">*</span>
            </label>
            <input
              className="input is-mono"
              value={cfg.maxRamPercentage}
              onChange={(e) => setCfg({ maxRamPercentage: e.target.value })}
              placeholder="50"
            />
            <div className="field-hint">Percentage of physical memory used as maximum heap size</div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 8 }}>
          <div className="field">
            <label className="field-label">
              Logs total size cap <span className="field-required">*</span>
            </label>
            <input
              className="input is-mono"
              value={cfg.logsTotalSizeCap}
              onChange={(e) => setCfg({ logsTotalSizeCap: e.target.value })}
              placeholder="2GB"
            />
            <div className="field-hint">Max capacity of 'logs' folder</div>
          </div>

          <div className="field">
            <label className="field-label">
              Enable instance monitoring
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 0" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={cfg.enableInstanceMonitoring === true}
                  onChange={(e) => setCfg({ enableInstanceMonitoring: e.target.checked })}
                  style={{ cursor: "pointer" }}
                />
                Enable Glowroot monitoring
              </label>
            </div>
            <div className="field-hint">Adds Glowroot agent for instance monitoring endpoint</div>
          </div>
        </div>

        <div className="divider" />

        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", margin: "0 0 12px" }}>Cloud connector settings</div>

        <div className="field">
          <label className="field-label">
            Use cloud connector for SMTP integration
          </label>
          <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 0" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input
                type="radio"
                name="smtp-connector"
                value="false"
                checked={cfg.useCloudConnectorForSmtpIntegration === false}
                onChange={() => setCfg({ useCloudConnectorForSmtpIntegration: false })}
                style={{ cursor: "pointer" }}
              />
              <span style={{ fontSize: 13 }}>No</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input
                type="radio"
                name="smtp-connector"
                value="true"
                checked={cfg.useCloudConnectorForSmtpIntegration === true}
                onChange={() => setCfg({ useCloudConnectorForSmtpIntegration: true })}
                style={{ cursor: "pointer" }}
              />
              <span style={{ fontSize: 13 }}>Yes</span>
            </label>
          </div>
          <div className="field-hint">Whether the application should use a cloud connector for SMTP integration</div>
        </div>

        {cfg.useCloudConnectorForSmtpIntegration && (
          <div className="field" style={{ marginTop: 12 }}>
            <label className="field-label">
              Cloud connector destination name
            </label>
            <input
              className="input is-mono"
              value={cfg.cloudConnectorDestinationNameForSmtpIntegration}
              onChange={(e) => setCfg({ cloudConnectorDestinationNameForSmtpIntegration: e.target.value })}
              placeholder="smtp-destination"
            />
            <div className="field-hint">Name of destination configured in SAP BTP Destination service for local SMTP server</div>
          </div>
        )}

        <div className="divider" />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "0 0 12px" }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)" }}>PostgreSQL service</div>
          <span className="pill gray">postgresql-db · from marketplace</span>
        </div>

        <div className="field">
          <label className="field-label">
            Service plan <span className="field-required">*</span>
          </label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {plans.map(p => (
              <button
                key={p.name}
                className={`choice ${cfg.dbPlan === p.name ? "selected" : ""}`}
                style={{ flexDirection: "row", alignItems: "center", padding: "12px 14px", gap: 14 }}
                onClick={() => setCfg({ dbPlan: p.name })}
              >
                <div style={{ width: 30, height: 30, borderRadius: 6, background: "var(--fg-blue-soft)", color: "var(--fg-blue)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                  <Ico.Database style={{ width: 16, height: 16 }} />
                </div>
                <div style={{ flex: 1, textAlign: "left" }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-0)", display: "flex", alignItems: "center", gap: 8 }}>
                    {p.name}
                    {p.free && <span className="pill green">Free</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }}>
                    {p.description}
                  </div>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>
                  {p.size}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <WizardFooter
        onBack={onBack}
        onNext={handleNext}
        nextDisabled={!valid || writing}
        nextLabel={writing ? "Writing vars.yml…" : "Start deployment"}
      />
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// 5. Service creation + role assignment
// ═══════════════════════════════════════════════════════════
function ScreenProgress({ ctx, setCtx, onNext, onBack, appendLog }) {
  const tasks = ctx.tasks;
  const allDone = tasks.every(t => t.status === "done");

  React.useEffect(() => {
    if (ctx.deployStarted) return;
    setCtx(c => ({ ...c, deployStarted: true }));
    const api = fg();
    if (!api) return;

    const mark = (id, patch) =>
      setCtx(c => ({ ...c, tasks: c.tasks.map(t => t.id === id ? { ...t, ...patch } : t) }));

    (async () => {
      // 1. vars.yml — written in config step; just mark done
      mark("vars", { status: "done", sub: "vars.yml updated" });

      // 2. parallel: create db, create xsuaa, list/assign role
      const dbPromise = (async () => {
        mark("db", { status: "running" });
        const c1 = await api.cf.createService({
          offering: "postgresql-db", plan: ctx.config.dbPlan, name: "figaf-db", configFile: "db.json",
        });
        if (!c1.ok) { mark("db", { status: "error", sub: c1.stderr || "create-service failed" }); return; }
        const p1 = await api.cf.pollService("figaf-db");
        mark("db", { status: p1.ok ? "done" : "error", sub: p1.status });
      })();

      const xsPromise = (async () => {
        mark("xsuaa", { status: "running" });
        const c2 = await api.cf.createService({
          offering: "xsuaa", plan: "application", name: "figaf-xsuaa", configFile: "xs-security.json",
        });
        if (!c2.ok) { mark("xsuaa", { status: "error", sub: c2.stderr || "create-service failed" }); return; }
        const p2 = await api.cf.pollService("figaf-xsuaa");
        mark("xsuaa", { status: p2.ok ? "done" : "error", sub: p2.status });
      })();

      const rolePromise = (async () => {
        mark("roles", { status: "running" });
        const users = await api.btp.listUsers();
        const who = ctx.login.user || (users.ok && users.users[0]) || "";
        if (!who) { mark("roles", { status: "error", sub: "no user found" }); return; }
        const r = await api.btp.assignRole(who, "PI_Administrator");
        mark("roles", { status: r.ok ? "done" : "error", sub: r.ok ? `assigned to ${who}` : (r.stderr || "failed") });
      })();

      await Promise.all([dbPromise, xsPromise, rolePromise]);
    })();
    // eslint-disable-next-line
  }, []);

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 5 · Provisioning</div>
          <h1 className="pane-title">
            {allDone ? "Services ready" : "Creating services & assigning roles…"}
          </h1>
          <p className="pane-desc">
            {allDone
              ? "PostgreSQL, XSUAA, and PI_Administrator role are configured. Ready to deploy the app."
              : <>Creating services in <span className="kbd">{ctx.login.org || "?"} / {ctx.login.space || "?"}</span> and assigning role collections. Most tasks run in parallel.</>}
          </p>
        </div>

        <div className="card" style={{ padding: "4px 18px" }}>
          <div className="checklist">
            {tasks.map(t => <CheckRow key={t.id} {...t} />)}
          </div>
        </div>

        {!allDone && (
          <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center", fontSize: 12, color: "var(--ink-3)" }}>
            <Ico.Terminal style={{ color: "var(--fg-blue)" }} />
            <span>Expand <strong>CLI details</strong> below to watch raw output.</span>
          </div>
        )}
      </div>

      <WizardFooter
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!allDone}
        nextLabel={allDone ? "Continue to deploy" : "Provisioning…"}
        backLabel="Cancel"
      />
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// 6. Deploy app (cf push)
// ═══════════════════════════════════════════════════════════
function ScreenDeploy({ ctx, setCtx, onNext, onBack, appendLog }) {
  const pushStatus = ctx.pushStatus;
  const done = pushStatus === "done";
  const failed = pushStatus === "error";

  React.useEffect(() => {
    if (ctx.pushStarted) return;
    setCtx(c => ({ ...c, pushStarted: true, pushStatus: "running" }));
    const api = fg();
    if (!api) return;
    (async () => {
      const r = await api.cf.push();
      setCtx(c => ({ ...c, pushStatus: r.ok ? "done" : "error" }));
    })();
    // eslint-disable-next-line
  }, []);

  const appUrl = `https://${ctx.config.id}.${ctx.config.domain}`;

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 6 · Deploy</div>
          <h1 className="pane-title">
            {done ? "Application deployed" : failed ? "Deployment failed" : "Pushing Figaf Tool to Cloud Foundry…"}
          </h1>
          <p className="pane-desc">
            {done
              ? "The Figaf Tool is live and bound to all services."
              : failed
                ? "cf push exited with a non-zero code. Expand the CLI drawer to see the error."
                : <>Running <span className="kbd">cf push --vars-file vars.yml</span> — uploading, staging, and starting instances.</>}
          </p>
        </div>

        <div className="card" style={{ padding: "20px 18px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 44, height: 44, borderRadius: 10, background: done ? "var(--success-soft)" : "var(--fg-blue-soft)", border: `2px solid ${done ? "var(--success)" : "var(--fg-blue)"}`, color: done ? "var(--success)" : "var(--fg-blue)", display: "grid", placeItems: "center" }}>
              {done ? <Ico.Check style={{ width: 20, height: 20 }} /> : <Ico.Spinner style={{ width: 20, height: 20 }} />}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-0)", marginBottom: 4 }}>
                {done ? "Deployment complete" : failed ? "Push failed" : "Uploading and staging…"}
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>
                {done ? appUrl : "cf push --vars-file vars.yml"}
              </div>
            </div>
            {done && <span className="pill green">Live</span>}
          </div>
        </div>

        <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center", fontSize: 12, color: "var(--ink-3)" }}>
          <Ico.Info style={{ color: "var(--fg-blue)" }} />
          <span>
            This step uploads the Docker image, binds services, and starts the app. Typically takes 2–5 minutes.
          </span>
        </div>
      </div>

      <WizardFooter
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!done}
        nextLabel={done ? "Finish" : failed ? "Retry or cancel" : "Deploying…"}
        backLabel="Cancel"
      />
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// 7. Completion
// ═══════════════════════════════════════════════════════════
function ScreenDone({ ctx }) {
  const appUrl = `https://${ctx.config.id || "figaf-tool"}.${ctx.config.domain || `cfapps.${ctx.login.landscape.replace(/^cf-/, '')}.hana.ondemand.com`}`;
  const open = () => fg()?.shell.openExternal(appUrl);

  return (
    <>
      <div className="pane-body">
        <div className="success-splash">
          <div className="success-ring">
            <div className="sr-inner">
              <Ico.Check style={{ width: 24, height: 24, strokeWidth: 2.5 }} />
            </div>
          </div>
          <h1 className="pane-title" style={{ textAlign: "center" }}>Figaf is live.</h1>
          <p className="pane-desc" style={{ textAlign: "center", maxWidth: "48ch" }}>
            Your deployment is running on SAP BTP Cloud Foundry. Open the tool to sign in and start configuring your test suites.
          </p>
        </div>

        <div className="summary-grid" style={{ marginBottom: 18 }}>
          <div className="cell"><div className="k">App URL</div><div className="v" style={{ color: "var(--fg-blue)" }}>{appUrl}</div></div>
          <div className="cell"><div className="k">Image tag</div><div className="v">figaf/app:{ctx.config.dockerVersion || ctx.config.locationId}</div></div>
          <div className="cell"><div className="k">Database</div><div className="v">figaf-db · {ctx.config.dbPlan}</div></div>
          <div className="cell"><div className="k">Auth</div><div className="v">figaf-xsuaa</div></div>
          <div className="cell"><div className="k">Org / Space</div><div className="v">{ctx.login.org || "—"} / {ctx.login.space || "—"}</div></div>
          <div className="cell"><div className="k">Location ID</div><div className="v">{ctx.config.locationId || "—"}</div></div>
        </div>
      </div>

      <div className="pane-foot">
        <div className="spacer" />
        <button className="btn btn-primary" onClick={open}>
          Open Figaf Tool <Ico.External />
        </button>
      </div>
    </>
  );
}

Object.assign(window, {
  ScreenWelcome, ScreenLogin, ScreenChoice, ScreenConfig, ScreenProgress, ScreenDeploy, ScreenDone,
});

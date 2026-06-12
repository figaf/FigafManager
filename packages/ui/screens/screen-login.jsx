/* global React, Ico, WizardFooter, ScrollReveal */

const fg = () => (typeof window !== "undefined" && window.figaf) || null;

// ═══════════════════════════════════════════════════════════
// 2. CLI Login — SSO + passcode
// ═══════════════════════════════════════════════════════════
function ScreenLogin({ ctx, setCtx, onNext, appendLog }) {
  const { login } = ctx;
  const setLogin = (patch) => setCtx(c => ({ ...c, login: { ...c.login, ...patch } }));
  const [gaChoice, setGaChoice] = React.useState(null);
  const [subaccountChoice, setSubaccountChoice] = React.useState(null);
  const [orgChoice, setOrgChoice] = React.useState(null);
  const [spaceChoice, setSpaceChoice] = React.useState(null);
  const [cfSwitchingOrg, setCfSwitchingOrg] = React.useState(false);

  const btpLoggedIn = login.btpStatus === "done";
  const cfLoggedIn = login.cfStatus === "done";
  const canContinue = btpLoggedIn && cfLoggedIn;

  React.useEffect(() => {
    const api = fg();
    if (!api) return;
    const offCf1 = api.on("cf:loggedIn", () => {
      setOrgChoice(null);
      setSpaceChoice(null);
      setCfSwitchingOrg(false);
      setLogin({ cfStatus: "done" });
      (async () => {
        const t = await api.cf.targetOrgSpace();
        if (t && t.ok) setLogin({ org: t.org, space: t.space, user: t.user || login.user });
      })();
    });
    const offCf2 = api.on("cf:loginFailed", () => {
      setOrgChoice(null);
      setSpaceChoice(null);
      setCfSwitchingOrg(false);
      setLogin({ cfStatus: "error" });
    });
    const offCfOrgChoice = api.on("cf:orgChoice", (p) => setOrgChoice(p));
    const offCfSpaceChoice = api.on("cf:spaceChoice", (p) => setSpaceChoice(p));
    const offSwitchDone = api.on("cf:switchOrgDone", ({ org, space }) => {
      setCfSwitchingOrg(false);
      setOrgChoice(null);
      setSpaceChoice(null);
      setLogin(l => ({ ...l, org, space }));
    });

    const offGaChoice = api.on("btp:gaChoice", (p) => {
      setSubaccountChoice(null);
      setGaChoice(p);
    });
    const offSubChoice = api.on("btp:subaccountChoice", (p) => {
      setSubaccountChoice(p);
    });
    const offBtpOk = api.on("btp:loggedIn", (env) => {
      setGaChoice(null);
      setSubaccountChoice(null);
      if (env && env.ok) {
        setLogin({
          btpStatus: "done",
          landscape: env.landscape,
          subaccount: env.subaccount || "",
          subaccountName: env.subaccountName || "",
          subdomain: env.subdomain || "",
          provider: env.provider || "",
          org: env.org || "",
          apiUrl: env.apiUrl,
        });
      } else {
        setLogin({ btpStatus: "error" });
      }
    });
    const offBtpFail = api.on("btp:loginFailed", () => {
      setGaChoice(null);
      setSubaccountChoice(null);
      setLogin({ btpStatus: "error" });
    });
    const offBtpSso = api.on("btp:ssoUrl", ({ url }) => {
      api.shell.openExternal(url);
    });

    return () => {
      offCf1 && offCf1();
      offCf2 && offCf2();
      offCfOrgChoice && offCfOrgChoice();
      offCfSpaceChoice && offCfSpaceChoice();
      offSwitchDone && offSwitchDone();
      offGaChoice && offGaChoice();
      offSubChoice && offSubChoice();
      offBtpOk && offBtpOk();
      offBtpFail && offBtpFail();
      offBtpSso && offBtpSso();
    };
    // eslint-disable-next-line
  }, []);

  async function startBtpLogin() {
    const api = fg();
    if (!api) return;
    setGaChoice(null);
    setSubaccountChoice(null);
    setLogin({ btpStatus: "running" });
    await api.btp.loginStart();
  }

  async function cancelBtpLogin() {
    const api = fg();
    if (!api) return;
    setGaChoice(null);
    setSubaccountChoice(null);
    await api.btp.cancelLogin();
    setLogin({ btpStatus: "idle" });
  }

  async function selectSubaccount(guid) {
    const api = fg();
    if (!api) return;
    setSubaccountChoice(null);
    setLogin({ btpStatus: "running" });
    const r = await api.btp.selectSubaccount(guid);
    if (r && r.ok === false) {
      appendLog([{ type: "err", text: r.error || "Failed to target subaccount" }]);
      setLogin({ btpStatus: "error" });
    }
  }

  async function selectGa(index) {
    const api = fg();
    if (!api) return;
    setGaChoice(null);
    setSubaccountChoice(null);
    setLogin({ btpStatus: "running" });
    await api.btp.selectGlobalAccount(index);
  }

  async function goBackToGaPicker() {
    const api = fg();
    if (!api) return;
    setSubaccountChoice(null);
    setLogin({ btpStatus: "running" });
    await api.btp.listGlobalAccounts();
  }

  async function switchGlobalAccount() {
    const api = fg();
    if (!api) return;
    setGaChoice(null);
    setSubaccountChoice(null);
    setOrgChoice(null);
    setSpaceChoice(null);
    setLogin({
      btpStatus: "running",
      cfStatus: "idle",
      landscape: "", subaccount: "", subaccountName: "", subdomain: "", provider: "", org: "", space: "", user: "", apiUrl: "",
      passcode: "", passcodeRequested: false,
    });
    setCtx(c => ({ ...c, config: { ...c.config, trialPg: undefined, dbParams: {} } }));
    await api.btp.listGlobalAccounts();
  }

  async function handleLogout() {
    const api = fg();
    if (!api) return;
    await api.btp.logout();
    setLogin({
      btpStatus: "idle", cfStatus: "idle",
      landscape: "", subaccount: "", subaccountName: "", subdomain: "", provider: "", org: "", space: "", user: "", apiUrl: "",
      passcode: "", passcodeRequested: false,
    });
    // Clear PostgreSQL auto-detection so the next login re-seeds it from the
    // new global account's subdomain (trial vs real tenant can differ).
    setCtx(c => ({ ...c, config: { ...c.config, trialPg: undefined, dbParams: {} } }));
  }

  async function handleCfLogout() {
    const api = fg();
    if (!api) return;
    await api.cf.logout();
    setCfSwitchingOrg(false);
    setOrgChoice(null);
    setSpaceChoice(null);
    setLogin({
      cfStatus: "idle",
      org: "", space: "",
      passcode: "", passcodeRequested: false,
    });
  }

  async function switchCfOrg() {
    const api = fg();
    if (!api) return;
    setOrgChoice(null);
    setSpaceChoice(null);
    setCfSwitchingOrg(true);
    const r = await api.cf.switchOrgStart();
    if (r && r.ok === false) {
      appendLog([{ type: "err", text: r.error || "Failed to list orgs" }]);
      setCfSwitchingOrg(false);
    }
  }

  function cancelCfSwitch() {
    setCfSwitchingOrg(false);
    setOrgChoice(null);
    setSpaceChoice(null);
  }

  async function selectCfOrg(index) {
    const api = fg();
    if (!api) return;
    setOrgChoice(null);
    if (cfSwitchingOrg) {
      const r = await api.cf.switchSelectOrg(index);
      if (r && r.ok === false) {
        appendLog([{ type: "err", text: r.error || "Failed to select org" }]);
        setCfSwitchingOrg(false);
      }
      return;
    }
    const r = await api.cf.selectOrg(index);
    if (r && r.ok === false) {
      appendLog([{ type: "err", text: r.error || "Failed to select org" }]);
      setLogin({ cfStatus: "error" });
    }
  }

  async function selectCfSpace(index) {
    const api = fg();
    if (!api) return;
    setSpaceChoice(null);
    if (cfSwitchingOrg) {
      const r = await api.cf.switchSelectSpace(index);
      if (r && r.ok === false) {
        appendLog([{ type: "err", text: r.error || "Failed to select space" }]);
        setCfSwitchingOrg(false);
      }
      return;
    }
    const r = await api.cf.selectSpace(index);
    if (r && r.ok === false) {
      appendLog([{ type: "err", text: r.error || "Failed to select space" }]);
      setLogin({ cfStatus: "error" });
    }
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
    // Success path: cf process closes → cf:loggedIn / cf:loginFailed events flip
    // cfStatus. If the handler itself reports failure (e.g. cf already exited,
    // bad shim wiring) we have to flip back here — otherwise the button is
    // stuck on "Authenticating…" forever.
    const r = await api.cf.submitPasscode(login.passcode);
    if (r && r.ok === false) {
      appendLog([{ type: "err", text: r.error || "Failed to submit passcode" }]);
      setLogin({ cfStatus: "error" });
    }
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
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: (btpLoggedIn || gaChoice || subaccountChoice) ? 10 : 14 }}>
            <div style={{ width: 36, height: 36, borderRadius: 8, background: "var(--fg-blue-soft)", color: "var(--fg-blue)", display: "grid", placeItems: "center" }}>
              <Ico.Cloud />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-0)" }}>SAP BTP CLI</div>
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>cli.btp.cloud.sap</div>
            </div>
            {btpLoggedIn && <span className="pill green"><Ico.Check /> Connected</span>}
            {btpLoggedIn && (
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={switchGlobalAccount}>
                <Ico.Refresh /> Switch Account
              </button>
            )}
            {btpLoggedIn && (
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={handleLogout}>
                Sign out
              </button>
            )}
            {!btpLoggedIn && login.btpStatus === "running" && (gaChoice || subaccountChoice) && (
              <span className="pill blue">Awaiting selection</span>
            )}
            {!btpLoggedIn && login.btpStatus === "running" && !gaChoice && !subaccountChoice && (
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
            <ScrollReveal>
            <div className="slide-in" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 4 }}>
                Choose a global account
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>
                Your account has access to multiple global accounts. Pick the one you want to deploy to.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {gaChoice.accounts.map((acct) => (
                  <button
                    key={acct.index}
                    className="choice"
                    style={{ flexDirection: "row", alignItems: "center", padding: "12px 14px", gap: 14, textAlign: "left" }}
                    onClick={() => selectGa(acct.index)}
                  >
                    <div style={{ width: 28, height: 28, borderRadius: 6, background: "var(--fg-blue-soft)", color: "var(--fg-blue)", display: "grid", placeItems: "center", flexShrink: 0, fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
                      {acct.index}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-0)" }}>{acct.name}</div>
                      {acct.subaccounts && acct.subaccounts.length > 0 && (
                        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 3, display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {acct.subaccounts.map((s) => (
                            <span key={s.index} style={{ background: "var(--bg-2)", borderRadius: 4, padding: "1px 6px", fontFamily: "var(--font-mono)" }}>{s.name}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <Ico.ArrowRight />
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={cancelBtpLogin}>
                  Cancel sign-in
                </button>
              </div>
            </div>
            </ScrollReveal>
          )}

          {!btpLoggedIn && subaccountChoice && subaccountChoice.subaccounts && subaccountChoice.subaccounts.length > 0 && (
            <ScrollReveal>
            <div className="slide-in" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 4 }}>
                Choose a subaccount
              </div>
              {subaccountChoice.globalAccountName && (
                <div style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 6 }}>
                  Global account: <strong>{subaccountChoice.globalAccountName}</strong>
                </div>
              )}
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>
                Pick the subaccount you want to deploy to. Subaccounts without a Cloud Foundry environment are shown but cannot be selected.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {subaccountChoice.subaccounts.map((sa, i) => {
                  const region = sa.region;
                  const provider = sa.provider;
                  const meta = [
                    region && `region: ${region}`,
                    provider && `provider: ${provider}`,
                    sa.subdomain && `subdomain: ${sa.subdomain}`,
                  ].filter(Boolean);
                  const disabled = !sa.cfEnabled;
                  return (
                    <button
                      key={sa.guid || i}
                      className="choice"
                      disabled={disabled}
                      title={disabled ? "No Cloud Foundry environment in this subaccount" : undefined}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        padding: "12px 14px",
                        gap: 14,
                        textAlign: "left",
                        opacity: disabled ? 0.5 : 1,
                        cursor: disabled ? "not-allowed" : "pointer",
                      }}
                      onClick={() => { if (!disabled) selectSubaccount(sa.guid); }}
                    >
                      <div style={{ width: 28, height: 28, borderRadius: 6, background: "var(--fg-blue-soft)", color: "var(--fg-blue)", display: "grid", placeItems: "center", flexShrink: 0, fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
                        {i + 1}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-0)", display: "flex", alignItems: "center", gap: 8 }}>
                          {sa.displayName || sa.guid || `Subaccount ${i + 1}`}
                          {disabled && <span className="pill gray" style={{ fontSize: 10 }}>No CF</span>}
                        </div>
                        {meta.length > 0 && (
                          <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2, fontFamily: "var(--font-mono)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {meta.join(" · ")}
                          </div>
                        )}
                      </div>
                      {!disabled && <Ico.ArrowRight />}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10 }}>
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={goBackToGaPicker}>
                  <Ico.Refresh /> Switch global account
                </button>
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={cancelBtpLogin}>
                  Cancel sign-in
                </button>
              </div>
            </div>
            </ScrollReveal>
          )}

          {btpLoggedIn && (
            <ScrollReveal>
            <div className="summary-grid slide-in">
              {login.subdomain && <div className="cell"><div className="k">Global account</div><div className="v">{login.subdomain}</div></div>}
              {login.subaccountName && <div className="cell"><div className="k">Subaccount</div><div className="v">{login.subaccountName}</div></div>}
              {login.subaccount && <div className="cell"><div className="k">Subaccount ID</div><div className="v">{login.subaccount}</div></div>}
              {login.org && <div className="cell"><div className="k">Org</div><div className="v">{login.org}</div></div>}
              <div className="cell"><div className="k">Landscape</div><div className="v">{login.landscape}</div></div>
              <div className="cell"><div className="k">API endpoint</div><div className="v">api.{login.landscape.replace(/^cf-/, 'cf.')}.hana.ondemand.com</div></div>
            </div>
            </ScrollReveal>
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
            {cfLoggedIn && !cfSwitchingOrg && (
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={switchCfOrg}>
                <Ico.Refresh /> Switch Org
              </button>
            )}
          </div>

          {btpLoggedIn && !cfLoggedIn && !cfSwitchingOrg && (
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
                <ScrollReveal>
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
                </ScrollReveal>
              )}
            </div>
          )}

          {(!cfLoggedIn || cfSwitchingOrg) && orgChoice && orgChoice.orgs && orgChoice.orgs.length > 0 && (
            <ScrollReveal>
            <div className="slide-in" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 4 }}>
                Choose a Cloud Foundry org
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>
                The CLI returned multiple orgs. {orgChoice.orgs.some(o => o.recommended)
                  ? <>The one matching your BTP subaccount org (<span className="kbd">{login.org}</span>) is recommended.</>
                  : "None match your BTP subaccount org — pick the one you want to deploy to."}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {orgChoice.orgs.map((o) => (
                  <button
                    key={o.index}
                    className="choice"
                    style={{ flexDirection: "row", alignItems: "center", padding: "12px 14px", gap: 14, textAlign: "left" }}
                    onClick={() => selectCfOrg(o.index)}
                  >
                    <div style={{ width: 28, height: 28, borderRadius: 6, background: "var(--fg-blue-soft)", color: "var(--fg-blue)", display: "grid", placeItems: "center", flexShrink: 0, fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
                      {o.index}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-0)", display: "flex", alignItems: "center", gap: 8 }}>
                        {o.name}
                        {o.recommended && <span className="pill green" style={{ fontSize: 10 }}><Ico.Check /> Recommended</span>}
                      </div>
                    </div>
                    <Ico.ArrowRight />
                  </button>
                ))}
              </div>
              {cfSwitchingOrg && (
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={cancelCfSwitch}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
            </ScrollReveal>
          )}

          {(!cfLoggedIn || cfSwitchingOrg) && spaceChoice && spaceChoice.spaces && spaceChoice.spaces.length > 0 && (
            <ScrollReveal>
            <div className="slide-in" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 4 }}>
                Choose a space
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>
                The selected org has multiple spaces. Pick the one you want to deploy to.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {spaceChoice.spaces.map((s) => (
                  <button
                    key={s.index}
                    className="choice"
                    style={{ flexDirection: "row", alignItems: "center", padding: "12px 14px", gap: 14, textAlign: "left" }}
                    onClick={() => selectCfSpace(s.index)}
                  >
                    <div style={{ width: 28, height: 28, borderRadius: 6, background: "var(--fg-blue-soft)", color: "var(--fg-blue)", display: "grid", placeItems: "center", flexShrink: 0, fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
                      {s.index}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-0)" }}>{s.name}</div>
                    </div>
                    <Ico.ArrowRight />
                  </button>
                ))}
              </div>
              {cfSwitchingOrg && (
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={cancelCfSwitch}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
            </ScrollReveal>
          )}

          {cfLoggedIn && (
            <ScrollReveal>
            <div className="summary-grid slide-in">
              {login.org && <div className="cell"><div className="k">Org</div><div className="v">{login.org}</div></div>}
              {login.space && <div className="cell"><div className="k">Space</div><div className="v">{login.space}</div></div>}
            </div>
            </ScrollReveal>
          )}
        </div>
      </div>

      <WizardFooter nextDisabled={!canContinue} onNext={onNext} onBack={null} />
    </>
  );
}

Object.assign(window, { ScreenLogin });

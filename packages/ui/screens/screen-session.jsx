/* global React, ScreenLogin, Ico */
// Console page: Session & access (#/session).
// The old wizard "Sign in" step, reframed as a settings page:
//   - signed out  → the full ScreenLogin (passcode, stored user, CF-only)
//   - signed in   → the access map (what each sign-in is for, and its state),
//                   then the cards: CF session, BTP session, management user,
//                   and the persistent-SSO upgrade (started from HERE; it runs
//                   on #/session/sso-upgrade, see console.jsx).
// Sign-out clears the server-side CLI login AND the client login context,
// which makes the console's auth gate take over again.

function SessionInfoRow({ label, value }) {
  return (
    <div style={{ display: "flex", gap: 10, fontSize: 13, margin: "4px 0" }}>
      <div style={{ width: 110, color: "var(--ink-3)" }}>{label}</div>
      <div><span className="kbd">{value || "—"}</span></div>
    </div>
  );
}

// Management user card — set up / replace the technical CF user stored in
// the SAP Credential Store (namespace figaf-manager, name cf-management-user).
// Mirrors the card inside ScreenLogin, but standalone so it is usable while
// signed in. The handler verifies the credentials against CF before storing.
function MgmtUserCard() {
  const api = typeof window !== "undefined" ? window.figaf : null;
  const [status, setStatus] = React.useState(null); // login:storedUserStatus result
  const [formOpen, setFormOpen] = React.useState(false);
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState(null); // { ok, text }

  const loadStatus = React.useCallback(async () => {
    try { setStatus(await api.login.storedUserStatus()); }
    catch (e) { setStatus({ available: false, bindingPresent: false, error: e.message }); }
  }, []);
  React.useEffect(() => { loadStatus(); }, [loadStatus]);

  async function store() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.login.storeManagementUser({ username, password });
      if (r && r.ok) {
        setMsg({ ok: true, text: "Verified against Cloud Foundry and stored." });
        setFormOpen(false);
        setUsername("");
        setPassword("");
        await loadStatus();
      } else {
        setMsg({ ok: false, text: (r && r.error) || "storing failed" });
      }
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>Management user (automatic sign-in)</div>
      <p style={{ fontSize: 13, color: "var(--ink-3)", margin: "0 0 10px" }}>
        A technical CF user stored in the SAP Credential Store. With it, the manager
        signs in by itself — no passcode — and scheduled actions become possible.
      </p>

      {!status && <div style={{ fontSize: 13, color: "var(--ink-3)" }}>Checking…</div>}

      {status && !status.bindingPresent && (
        <div style={{ fontSize: 13, color: "var(--ink-3)" }}>
          The manager is not bound to a Credential Store instance, so no user can be
          stored. Bind <span className="kbd">figaf-l3l4-credstore</span> and restage.
        </div>
      )}

      {status && status.bindingPresent && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {status.available
            ? <span className="pill green">stored: {status.username || "…"}</span>
            : <span className="pill gray">not set up</span>}
          <button className="btn" onClick={() => { setFormOpen(o => !o); setMsg(null); }} disabled={busy}>
            {status.available ? "Replace user" : "Set up management user"}
          </button>
        </div>
      )}

      {status && status.bindingPresent && formOpen && (
        <div style={{ marginTop: 10, maxWidth: 420 }}>
          <input
            className="input"
            style={{ width: "100%", marginBottom: 8 }}
            placeholder="CF username (e-mail)"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
          />
          <input
            className="input"
            style={{ width: "100%", marginBottom: 8 }}
            type="password"
            placeholder="CF password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
          <button className="btn btn-primary" onClick={store} disabled={busy || !username || !password}>
            {busy ? "Verifying against CF…" : "Verify & store"}
          </button>
        </div>
      )}

      {msg && (
        <div style={{ marginTop: 8, fontSize: 13, color: msg.ok ? "var(--fg-blue)" : "var(--fg-red, #c0392b)" }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}

// One picture of the four things called "sign-in" here (virgin run #3:
// "various ways of authentication"): what each is FOR, and its state now.
function AccessMapCard({ ctx }) {
  const api = typeof window !== "undefined" ? window.figaf : null;
  const ssoMode = typeof window !== "undefined" && window.figafXsuaaMode === true;
  const [stored, setStored] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = api && api.login ? await api.login.storedUserStatus() : null;
        if (!cancelled) setStored(r || { available: false, bindingPresent: false });
      } catch {
        if (!cancelled) setStored({ available: false, bindingPresent: false });
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const cfOn = ctx.login.cfStatus === "done";
  const btpOn = ctx.login.btpStatus === "done";
  const rows = [
    {
      name: "Browser access",
      purpose: ssoMode
        ? "SAP IAS sign-in through the approuter; the FigafManagerAdmin role is required. Survives restarts and redeploys."
        : "A one-time setup token from the app logs, until persistent SSO is enabled. Dies on every restart.",
      state: ssoMode ? { cls: "green", text: "SAP IAS" } : { cls: "gray", text: "setup token" },
    },
    {
      name: "Cloud Foundry login",
      purpose: "Runs the cf commands (services, apps, logs). Required. By passcode, or automatic with the management user.",
      state: cfOn ? { cls: "green", text: `signed in: ${ctx.login.user || "…"}` } : { cls: "gray", text: "not signed in" },
    },
    {
      name: "SAP BTP login",
      purpose: "Optional. Only for the automatic role assignment in the SSO upgrade and for Figaf Tool deployments.",
      state: btpOn ? { cls: "green", text: "signed in" } : { cls: "gray", text: "not signed in" },
    },
    {
      name: "Management user",
      purpose: "A technical CF user in the Credential Store. Lets the manager sign in by itself after every restart.",
      state: stored === null
        ? { cls: "gray", text: "checking…" }
        : stored.available
          ? { cls: "green", text: `stored: ${stored.username || ""}` }
          : { cls: "gray", text: stored.bindingPresent ? "not set up" : "needs the Credential Store binding" },
    },
  ];
  return (
    <div className="card access-map">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <div style={{ fontWeight: 700 }}>How this manager signs you in</div>
        <span className={`pill ${ssoMode ? "green" : "gray"}`}>{ssoMode ? "persistent SSO active" : "bootstrap mode"}</span>
      </div>
      <p style={{ fontSize: 13, color: "var(--ink-3)", margin: "0 0 6px" }}>
        Four things are called "sign-in" here. This is what each one is for, and where it stands.
      </p>
      {rows.map((r) => (
        <div key={r.name} className="access-row" data-access={r.name}>
          <div className="access-name">{r.name}</div>
          <div className="access-purpose">{r.purpose}</div>
          <span className={`pill ${r.state.cls}`}>{r.state.text}</span>
        </div>
      ))}
    </div>
  );
}

// The persistent-SSO upgrade is started from here, not from the Figaf Tool
// page: it is about the manager's own sign-in. Says what it does, what it
// costs, and what the BTP login is for - BEFORE the operator starts it
// (virgin run #3, finding 5: started without a BTP login, the role
// assignment failed with no warning up front).
function PersistentSsoCard({ ctx, onAddBtp, onStart }) {
  const features = window.figafModeFlags.features || {};
  const ssoMode = typeof window !== "undefined" && window.figafXsuaaMode === true;
  if (ssoMode || !features.xsuaaUpgrade) return null;
  const btpOn = ctx.login.btpStatus === "done";
  return (
    <div className="card" style={{ marginTop: 14 }} data-card="persistent-sso">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <div style={{ fontWeight: 700 }}>Persistent SSO (once per installation)</div>
        <span className="pill gray">not enabled</span>
      </div>
      <p style={{ fontSize: 13, color: "var(--ink-3)", margin: "0 0 8px" }}>
        Replaces the setup token with SAP IAS sign-in and the <span className="kbd">FigafManagerAdmin</span> role.
        After it, access survives restarts and redeploys, and nobody needs the logs to get in.
      </p>
      <p style={{ fontSize: 13, color: "var(--ink-3)", margin: "0 0 10px" }}>
        What happens: one XSUAA instance is created, an approuter app is pushed and takes over the public URL,
        the manager moves to an internal URL and restarts (30-90 s offline). About 3 minutes in total.
        Do it after the management user is stored, so the manager signs itself back in.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 13 }}>
        {btpOn ? (
          <>
            <span className="pill green">BTP login present</span>
            <span style={{ color: "var(--ink-3)" }}>The upgrade assigns the role to your user automatically.</span>
          </>
        ) : (
          <>
            <span className="pill gray">no BTP login</span>
            <span style={{ color: "var(--ink-3)", flex: 1, minWidth: 200 }}>
              Without it the upgrade cannot assign the role. You then add <span className="kbd">FigafManagerAdmin</span> to
              your user in the BTP cockpit before you continue.
            </span>
            <button className="btn" onClick={onAddBtp}>Add BTP login first</button>
          </>
        )}
      </div>
      <button className="btn btn-primary" onClick={onStart}>Start upgrade</button>
    </div>
  );
}

function ScreenSession({ ctx, setCtx, appendLog, onStartSso }) {
  const api = typeof window !== "undefined" ? window.figaf : null;
  const [addBtp, setAddBtp] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);
  const signedIn = ctx.login.cfStatus === "done";

  async function signOut() {
    setSigningOut(true);
    try { await api.cf.logout(); } catch { /* already logged out */ }
    try { await api.btp.logout(); } catch { /* btp may not be logged in */ }
    setSigningOut(false);
    setAddBtp(false);
    setCtx((c) => ({
      ...c,
      login: {
        ...c.login,
        btpStatus: "idle",
        cfStatus: "idle",
        cfOnly: false,
        passcodeRequested: false,
        passcode: "",
        user: "",
        landscape: "",
        apiUrl: "",
        subaccount: "",
        subdomain: "",
        provider: "",
        org: "",
        space: "",
      },
    }));
  }

  // Signed out, or deliberately adding a BTP login: the full sign-in screen.
  if (!signedIn || addBtp) {
    return (
      <>
        {addBtp && (
          <div style={{ padding: "10px 28px 0" }}>
            <button className="btn-link" onClick={() => setAddBtp(false)}>
              ← Back to the session overview
            </button>
          </div>
        )}
        <ScreenLogin ctx={ctx} setCtx={setCtx} onNext={() => setAddBtp(false)} appendLog={appendLog} gate />
      </>
    );
  }

  return (
    <div className="pane-body">
      <div className="pane-head">
        <div className="pane-eyebrow">Session &amp; access</div>
        <h1 className="pane-title">Who the manager works as</h1>
        <p className="pane-desc">
          Every action runs real <span className="kbd">btp</span> / <span className="kbd">cf</span> commands
          under this session's logins.
        </p>
      </div>

      <AccessMapCard ctx={ctx} />

      <div className="card" style={{ marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <div style={{ fontWeight: 700 }}>Cloud Foundry session</div>
          <span className="pill green">signed in</span>
          {ctx.login.cfOnly && <span className="pill gray">CF-only</span>}
        </div>
        <SessionInfoRow label="User" value={ctx.login.user} />
        <SessionInfoRow label="Org" value={ctx.login.org} />
        <SessionInfoRow label="Space" value={ctx.login.space} />
        <SessionInfoRow label="API" value={ctx.login.apiUrl} />
        <div style={{ marginTop: 10 }}>
          <button className="btn" onClick={signOut} disabled={signingOut}>
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <div style={{ fontWeight: 700 }}>SAP BTP session</div>
          {ctx.login.btpStatus === "done"
            ? <span className="pill green">signed in</span>
            : <span className="pill gray">not signed in</span>}
        </div>
        {ctx.login.btpStatus === "done" ? (
          <>
            <SessionInfoRow label="Subaccount" value={ctx.login.subaccount} />
            <SessionInfoRow label="Subdomain" value={ctx.login.subdomain} />
            <SessionInfoRow label="Landscape" value={ctx.login.landscape} />
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, color: "var(--ink-3)", margin: "0 0 10px" }}>
              Optional. Needed only for: deploying a new Figaf Tool, connecting it to Integration
              Suite, and the automatic role assignment in the persistent-SSO upgrade. Everything
              else works without it.
            </p>
            <button className="btn" onClick={() => setAddBtp(true)}>Add BTP login</button>
          </>
        )}
      </div>

      <MgmtUserCard />
      <PersistentSsoCard ctx={ctx} onAddBtp={() => setAddBtp(true)} onStart={onStartSso} />
    </div>
  );
}

Object.assign(window, { ScreenSession });

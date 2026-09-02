/* global React, ScreenLogin, Ico */
// Console page: Session & access (#/session).
// The old wizard "Sign in" step, reframed as a settings page:
//   - signed out  → the full ScreenLogin (passcode, stored user, CF-only)
//   - signed in   → status cards: CF session, BTP session, management user.
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

function ScreenSession({ ctx, setCtx, appendLog }) {
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

      <div className="card">
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
              Needed only for: deploying a new Figaf Tool, connecting it to Integration
              Suite, and the persistent-SSO upgrade. Everything else works without it.
            </p>
            <button className="btn" onClick={() => setAddBtp(true)}>Add BTP login</button>
          </>
        )}
      </div>

      <MgmtUserCard />
    </div>
  );
}

Object.assign(window, { ScreenSession });

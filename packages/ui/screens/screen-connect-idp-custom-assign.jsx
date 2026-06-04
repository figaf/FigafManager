/* global React, Ico, CheckRow, WizardFooter */

const fgca = () => (typeof window !== "undefined" && window.figaf) || null;

const PI_ROLE_TITLES = {
  PI_Administrator:         "Assign PI_Administrator",
  PI_Business_Expert:       "Assign PI_Business_Expert",
  PI_Integration_Developer: "Assign PI_Integration_Developer",
};

// ═══════════════════════════════════════════════════════════
// Connect · 3d-B. Custom IDP — assign PI roles + fetch SSO URL
// ═══════════════════════════════════════════════════════════
function ScreenConnectIdpCustomAssign({ ctx, setCtx, onNext, onBack }) {
  const [started, setStarted] = React.useState(false);
  const piRoles = ctx.connect.piRoles;
  const sso = ctx.connect.sso;
  const originKey = ctx.connect.originKey;
  const group = ctx.connect.samlGroup;

  const markRole = React.useCallback((id, patch) => {
    setCtx((c) => ({
      ...c,
      connect: { ...c.connect, piRoles: c.connect.piRoles.map((r) => (r.id === id ? { ...r, ...patch } : r)) },
    }));
  }, [setCtx]);

  const setSso = React.useCallback((patch) => {
    setCtx((c) => ({ ...c, connect: { ...c.connect, sso: { ...c.connect.sso, ...patch } } }));
  }, [setCtx]);

  async function assignOne(role) {
    const api = fgca();
    if (!api) { markRole(role, { status: "error", sub: "figaf API not available" }); return; }
    markRole(role, { status: "running", sub: undefined });
    const r = await api.connect.assignPiRole({ role, originKey, group });
    if (r && r.ok) {
      markRole(role, { status: "done", sub: r.alreadyAssigned ? "already assigned" : `assigned to group "${group}"` });
    } else {
      const hint = r && r.sessionExpired
        ? "BTP session expired — go Back and sign in again"
        : (r && r.stderr) || (r && r.error) || "assign failed";
      markRole(role, { status: "error", sub: hint });
    }
  }

  async function runRoles(ids) {
    for (const id of ids) { await assignOne(id); } // sequential, resilient per-row
  }

  async function fetchSso() {
    const api = fgca();
    if (!api) { setSso({ status: "error", error: "figaf API not available" }); return; }
    setSso({ status: "running", error: null });
    const r = await api.connect.samlSsoUrl();
    if (r && r.ok) setSso({ status: "done", url: r.ssoUrl, alias: r.alias, error: null });
    else setSso({ status: "error", error: (r && r.error) || "could not fetch SSO URL" });
  }

  async function runFlow() {
    setStarted(true);
    await Promise.all([runRoles(piRoles.map((r) => r.id)), fetchSso()]);
  }

  React.useEffect(() => {
    if (!started) runFlow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function retryFailedRoles() {
    const failed = piRoles.filter((r) => r.status === "error").map((r) => r.id);
    runRoles(failed);
  }

  function handleBack() {
    // Back to Screen A — clear resolved/derived state so a changed name
    // forces re-resolution.
    setCtx((c) => ({
      ...c,
      connect: {
        ...c.connect,
        originKey: null,
        trustList: null,
        piRoles: c.connect.piRoles.map((r) => ({ id: r.id, status: "pending" })),
        sso: { status: "idle", url: null, alias: null, error: null },
      },
    }));
    onBack && onBack();
  }

  async function copySso() {
    const api = fgca();
    if (!api || !sso.url) return;
    try { await api.shell.writeClipboard(sso.url); } catch {}
  }

  const anyRoleFailed = piRoles.some((r) => r.status === "error");
  const ssoReady = sso.status === "done" && !!sso.url;

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 7 · BTP access · Custom IDP</div>
          <h1 className="pane-title">Assign roles &amp; get the SSO URL</h1>
          <p className="pane-desc">
            Assigning the PI role collections to the <span className="kbd">{group}</span> group
            of <span className="kbd">{ctx.connect.idpName}</span>, and fetching the SSO URL
            to paste into the Figaf Tool.
          </p>
        </div>

        <div className="card" style={{ padding: "4px 18px" }}>
          <div className="checklist">
            {piRoles.map((r) => (
              <CheckRow key={r.id} status={r.status} title={PI_ROLE_TITLES[r.id] || r.id} sub={r.sub} />
            ))}
          </div>
        </div>

        {anyRoleFailed && (
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
            <button className="btn" onClick={retryFailedRoles}><Ico.Refresh /> Retry failed</button>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
              You can still finish — unassigned roles can be assigned later in the cockpit.
            </span>
          </div>
        )}

        <div className="divider" />

        <div className="card" style={{ padding: 14, marginTop: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>SSO URL (paste into the Figaf Tool)</div>
            {ssoReady && <button className="btn" onClick={copySso}><Ico.Copy /> Copy</button>}
          </div>
          {sso.status === "running" && <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Fetching SAML metadata…</div>}
          {sso.status === "error" && (
            <div>
              <div style={{ color: "var(--fg-red, #c0392b)", fontSize: 13, marginBottom: 8 }}>{sso.error}</div>
              <button className="btn" onClick={fetchSso}><Ico.Refresh /> Retry SSO</button>
            </div>
          )}
          {ssoReady && (
            <pre style={{ margin: 0, overflow: "auto", background: "var(--surface-2)", padding: 10, borderRadius: 6, fontSize: 11, lineHeight: 1.4 }}>
{sso.url}
            </pre>
          )}
        </div>
      </div>

      <WizardFooter
        onBack={handleBack}
        onNext={onNext}
        nextDisabled={!ssoReady}
        nextLabel={ssoReady ? "Finish" : "Fetching SSO URL…"}
      />
    </>
  );
}

Object.assign(window, { ScreenConnectIdpCustomAssign });

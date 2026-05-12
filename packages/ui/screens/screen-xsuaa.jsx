/* global React, Ico, WizardFooter, CheckRow */

// ═══════════════════════════════════════════════════════════
// v2: XSUAA upgrade — auth-gate-implementation-plan.md §2
// ═══════════════════════════════════════════════════════════
//
// Two screens, both hosted-only:
//
//   ScreenXsuaaUpgrade
//     Runs phase 1 (create xsuaa, push approuter) and phase 2 (map/unmap
//     route, bind+restage). Subscribes to xsuaa:upgradePhase + cf:service-
//     Status events. The handoff to the maintenance page happens when the
//     manager's WS drops mid-restage — at that point client.js redirects
//     to / which the approuter serves as the maintenance page.
//
//   ScreenXsuaaAssignRole
//     Rendered after the upgrade when window.figafModeFlags.isXsuaaMode
//     is true (the post-restage wizard load). Deep-links to the BTP
//     cockpit's user-management page so the operator self-assigns to the
//     FigafManagerOperator role collection.

const fg = () => (typeof window !== "undefined" && window.figaf) || null;

const PHASES = [
  { id: "create-xsuaa",   label: "Create XSUAA service",        sub: "cf create-service xsuaa application figaf-manager-xsuaa" },
  { id: "push-approuter", label: "Deploy authentication proxy", sub: "cf push figaf-manager-approuter (bundled in zip)" },
  { id: "map-route",      label: "Hand off public route",       sub: "approuter now serves the public route" },
  { id: "restage",        label: "Restage manager",             sub: "manager rebinds to XSUAA — 30-90s downtime expected" },
];

function ScreenXsuaaUpgrade({ ctx, setCtx, onNext, onBack }) {
  const [phases, setPhases] = React.useState(() => PHASES.map(p => ({ ...p, status: "pending" })));
  const [started, setStarted] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [route, setRoute] = React.useState(null);

  const markPhase = React.useCallback((id, patch) => {
    setPhases(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p));
  }, []);

  // Subscribe to live phase + service status events from the orchestrator.
  React.useEffect(() => {
    const api = fg();
    if (!api || !api.on) return;
    const offPhase = api.on("xsuaa:upgradePhase", (msg) => {
      if (!msg || !msg.phase) return;
      markPhase(msg.phase, { status: msg.state === "running" ? "running" : msg.state === "done" ? "done" : "error", sub: msg.error || undefined });
    });
    const offSvc = api.on("cf:serviceStatus", (msg) => {
      if (msg && msg.name === "figaf-manager-xsuaa") {
        markPhase("create-xsuaa", { sub: `status: ${msg.status}` });
      }
    });
    return () => { offPhase && offPhase(); offSvc && offSvc(); };
  }, [markPhase]);

  async function runUpgrade() {
    setStarted(true);
    setError(null);
    const api = fg();
    if (!api) { setError("API unavailable"); return; }

    try {
      // Pre-flight status check — lets a resumed upgrade pick up where it
      // left off if the dyno restarted mid-flow.
      const pre = await api.xsuaa.upgradeStatus();
      if (pre && pre.route) setRoute(pre.route);

      // Phase 1.1-1.2
      if (!pre || !pre.hasXsuaaService) {
        markPhase("create-xsuaa", { status: "running" });
        const r1 = await api.cf.createXsuaa();
        if (!r1.ok) { setError("createXsuaa: " + (r1.error || "failed")); markPhase("create-xsuaa", { status: "error", sub: r1.error }); return; }
        markPhase("create-xsuaa", { status: "done" });
      } else {
        markPhase("create-xsuaa", { status: "done", sub: "already provisioned" });
      }

      // Phase 1.3-1.6
      if (!pre || !pre.hasApprouterApp) {
        markPhase("push-approuter", { status: "running" });
        const r2 = await api.cf.pushManagerApprouter();
        if (!r2.ok) { setError("pushManagerApprouter: " + (r2.error || "failed")); markPhase("push-approuter", { status: "error", sub: r2.error }); return; }
        markPhase("push-approuter", { status: "done" });
      } else {
        markPhase("push-approuter", { status: "done", sub: "approuter already deployed" });
      }

      // Phase 2: route swap. We need domain + hostname. VCAP_APPLICATION
      // gives us uris[0] which is "<host>.<domain>". Split on the first dot.
      let mapHost = null, mapDomain = null, fullRoute = pre && pre.route;
      if (fullRoute) {
        const dot = fullRoute.indexOf(".");
        if (dot > 0) { mapHost = fullRoute.slice(0, dot); mapDomain = fullRoute.slice(dot + 1); }
      }
      if (!mapHost || !mapDomain) {
        setError("Could not determine the manager's public route. Inspect cf app figaf-manager in cockpit.");
        markPhase("map-route", { status: "error", sub: "route unknown" });
        return;
      }

      markPhase("map-route", { status: "running" });
      const m1 = await api.cf.mapRoute({ app: "figaf-manager-approuter", domain: mapDomain, hostname: mapHost });
      if (!m1.ok) { setError("mapRoute: " + (m1.stderr || "failed")); markPhase("map-route", { status: "error" }); return; }
      const u1 = await api.cf.unmapRoute({ app: "figaf-manager", domain: mapDomain, hostname: mapHost });
      if (!u1.ok) { setError("unmapRoute: " + (u1.stderr || "failed")); markPhase("map-route", { status: "error" }); return; }
      markPhase("map-route", { status: "done", sub: "route now serves the approuter; maintenance page next" });

      // Phase 2.5: bind + restage (fire-and-forget — the dyno dies)
      markPhase("restage", { status: "running", sub: "manager will be offline for 30-90s" });
      await api.cf.restage({ app: "figaf-manager", bindXsuaa: true });
      // From this point on, the WebSocket will drop and the next page load
      // hits the approuter, which serves maintenance.html until the manager
      // restage completes. The wizard tab is effectively handed off.
      markPhase("restage", { status: "done", sub: "approuter serving maintenance page — refresh to continue" });
      setCtx(c => ({ ...c, xsuaaUpgradeInitiated: true }));
    } catch (e) {
      setError("Unexpected: " + e.message);
    }
  }

  const allDone = phases.every(p => p.status === "done");

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">XSUAA upgrade</div>
          <h1 className="pane-title">Enable persistent SSO login</h1>
          <p className="pane-desc">
            Replace the cockpit-log setup token with proper SAP IAS authentication. After this upgrade, anyone you add to the <strong>FigafManagerOperator</strong> role collection can come back to this wizard without the token dance.
          </p>
          <p className="pane-desc" style={{ fontSize: 12, color: "var(--ink-3)" }}>
            This will create one XSUAA service instance, push an approuter sibling app, and restage figaf-manager. Expect ~2-3 minutes total, with 30-90 seconds of downtime mid-flow.
          </p>
        </div>

        <div className="task-list">
          {phases.map(p => (
            <CheckRow
              key={p.id}
              status={p.status}
              title={p.label}
              sub={p.sub || ""}
            />
          ))}
        </div>

        {error && (
          <div style={{ marginTop: 16, padding: "12px 14px", borderRadius: 8, background: "rgba(225,29,72,0.07)", border: "1px solid rgba(225,29,72,0.25)", color: "var(--error, #b91c1c)", fontSize: 13 }}>
            <strong>Upgrade failed.</strong> {error}
          </div>
        )}
      </div>

      <WizardFooter
        onBack={started ? null : onBack}
        onNext={allDone ? onNext : null}
        nextDisabled={!allDone}
        nextLabel="Continue"
      >
        {!started && (
          <button className="btn btn-primary" onClick={runUpgrade}>
            <Ico.Shield /> Start upgrade
          </button>
        )}
      </WizardFooter>
    </>
  );
}

function ScreenXsuaaAssignRole({ ctx, setCtx, onNext, onBack }) {
  const [cockpitUrl, setCockpitUrl] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    const api = fg();
    if (!api) return;
    api.xsuaa.assignRoleCollectionPreflight().then((r) => {
      if (r && r.ok) setCockpitUrl(r.url);
      else setError((r && r.error) || "Could not derive cockpit URL");
    });
  }, []);

  function openCockpit() {
    if (!cockpitUrl) return;
    const api = fg();
    if (api && api.shell && api.shell.openExternal) api.shell.openExternal(cockpitUrl);
    else window.open(cockpitUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">XSUAA upgrade · final step</div>
          <h1 className="pane-title">Assign yourself to the operator role</h1>
          <p className="pane-desc">
            The wizard auto-created the <strong>FigafManagerOperator</strong> role collection. Open BTP cockpit, find your user, and assign it. Takes about 30 seconds.
          </p>
        </div>

        <ol style={{ margin: "0 0 18px", paddingLeft: 18, color: "var(--ink-1)", fontSize: 14, lineHeight: 1.6 }}>
          <li>Click the button below to open your subaccount's user-management page.</li>
          <li>Find yourself in the user list and open your row.</li>
          <li>In the "Role Collections" tab, assign <code>FigafManagerOperator</code>.</li>
          <li>Return to this wizard. Future visits go through SAP IAS — no token needed.</li>
        </ol>

        {error && (
          <div style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(225,29,72,0.07)", border: "1px solid rgba(225,29,72,0.25)", color: "var(--error, #b91c1c)", fontSize: 13 }}>
            {error}
          </div>
        )}
      </div>

      <div className="pane-foot">
        {onBack && <button className="btn" onClick={onBack}>Back</button>}
        <div className="spacer" />
        <button className="btn" onClick={openCockpit} disabled={!cockpitUrl}>
          <Ico.External /> Open cockpit
        </button>
        <button className="btn btn-primary" onClick={onNext}>
          I have assigned the role
        </button>
      </div>
    </>
  );
}

Object.assign(window, { ScreenXsuaaUpgrade, ScreenXsuaaAssignRole });

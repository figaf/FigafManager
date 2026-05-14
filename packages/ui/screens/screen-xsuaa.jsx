/* global React, Ico, WizardFooter, CheckRow */

// ═══════════════════════════════════════════════════════════
// v2: XSUAA upgrade — auth-gate-implementation-plan.md §2
// ═══════════════════════════════════════════════════════════
//
// Two screens, both hosted-only:
//
//   ScreenXsuaaUpgrade
//     Runs phase 1 (create xsuaa, push approuter), phase 2 (map/unmap route),
//     the optional self-assign step, and phase 3 (bind+restage). The screen
//     does NOT auto-redirect after restage initiates — the operator must
//     click "Continue to wizard" to navigate to /, at which point the
//     approuter triggers IAS sign-in (yielding a fresh JWT that includes
//     the just-assigned scope).
//
//     Subscribes to xsuaa:upgradePhase + cf:serviceStatus events. Reads
//     pre-state via xsuaa:upgradeStatus so a resumed upgrade picks up where
//     it left off (the manager dyno may have restarted mid-flow).
//
//   ScreenXsuaaAssignRole
//     Manual-assignment fallback. Only reached if the auto-assign step in
//     ScreenXsuaaUpgrade fails — the upgrade screen routes the operator
//     here via onNext in that case. Deep-links to the BTP cockpit's
//     user-management page.

const fg = () => (typeof window !== "undefined" && window.figaf) || null;

// Phase rows rendered on the upgrade screen. "assign-role" is conditional
// (only shown when the checkbox is on). Kept as a const array so the
// rendering loop stays declarative.
//
// Why assign-role sits immediately AFTER create-xsuaa (not after map-route):
// xs-security.json declares the role-collections inline, so they're
// materialized atomically when `cf create-service xsuaa application` reaches
// status: succeeded. The collections are then assignable via `btp assign
// security/role-collection` against state.subaccount/state.user — no
// dependency on the approuter being pushed, on routes being swapped, or on
// the manager being restaged. Running it here guarantees the assignment
// commits BEFORE the approuter starts enforcing XSUAA on the public route
// (map-route unmaps the manager and the next browser request is bounced to
// IAS); otherwise the operator would re-authenticate, get a JWT without the
// scope, and the auto-assign would land too late to matter for that session.
const ALL_PHASES = [
  { id: "create-xsuaa",   label: "Create XSUAA service",        sub: "cf create-service xsuaa application figaf-manager-xsuaa" },
  { id: "assign-role",    label: "Assign role collection",      sub: "btp assign security/role-collection (optional)" },
  { id: "push-approuter", label: "Deploy authentication proxy", sub: "cf push figaf-manager-approuter (bundled in zip)" },
  { id: "map-route",      label: "Hand off public route",       sub: "approuter now serves the public route" },
  { id: "restage",        label: "Restage manager",             sub: "manager rebinds to XSUAA — 30-90s downtime expected" },
];

// The role we self-assign. Admin includes Operator (its scope-references in
// xs-security.json include $XSAPPNAME.FigafManagerOperator), so this single
// assignment covers both scopes. To switch to FigafManagerOperator instead,
// change just this constant; the orchestrator handler accepts the role param.
const ASSIGN_ROLE = "FigafManagerAdmin";

function ScreenXsuaaUpgrade({ ctx, setCtx, onNext, onBack }) {
  // Checkbox state is local to this screen — not threaded through global ctx.
  // Default on per the task spec; the operator can opt out before "Start
  // upgrade" but not mid-run (the checkbox disables once started).
  const [autoAssign, setAutoAssign] = React.useState(true);

  // Initial phase set respects the checkbox value at mount. We refresh it
  // when autoAssign toggles BEFORE the upgrade starts (started=false).
  const buildPhases = React.useCallback((includeAssign) =>
    ALL_PHASES
      .filter(p => p.id !== "assign-role" || includeAssign)
      .map(p => ({ ...p, status: "pending" })),
  []);
  const [phases, setPhases] = React.useState(() => buildPhases(true));
  const [started, setStarted] = React.useState(false);
  const [error, setError] = React.useState(null);
  // outcome: null while running; after success:
  //   { restaging: true, assignFailed: <reason|null>, managerMode: "token"|"xsuaa"|null }
  // managerMode is updated by the post-restage poll against /_manager-health.
  // Until it flips to "xsuaa" the Continue button is disabled — clicking it
  // earlier sends the operator to / on the still-v1 manager, which 302s to
  // /setup (the root cause of the symptom that prompted this poll in the
  // first place).
  const [outcome, setOutcome] = React.useState(null);

  // Reflect checkbox toggles into the phase list while still in pre-run state.
  React.useEffect(() => {
    if (started) return;
    setPhases(buildPhases(autoAssign));
  }, [autoAssign, started, buildPhases]);

  const markPhase = React.useCallback((id, patch) => {
    setPhases(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p));
  }, []);

  // Subscribe to live phase + service status events from the orchestrator.
  // Note we ignore "assign-role" events when the checkbox is off — the
  // handler shouldn't fire in that case, but defense in depth.
  React.useEffect(() => {
    const api = fg();
    if (!api || !api.on) return;
    const offPhase = api.on("xsuaa:upgradePhase", (msg) => {
      if (!msg || !msg.phase) return;
      const status = msg.state === "running" ? "running" : msg.state === "done" ? "done" : "error";
      markPhase(msg.phase, { status, sub: msg.error || undefined });
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

      // Phase 1.1-1.2
      if (!pre || !pre.hasXsuaaService) {
        markPhase("create-xsuaa", { status: "running" });
        const r1 = await api.cf.createXsuaa();
        if (!r1.ok) { setError("createXsuaa: " + (r1.error || "failed")); markPhase("create-xsuaa", { status: "error", sub: r1.error }); return; }
        markPhase("create-xsuaa", { status: "done" });
      } else {
        markPhase("create-xsuaa", { status: "done", sub: "already provisioned" });
      }

      // Optional auto-assign step. Runs HERE — immediately after the XSUAA
      // service is up — because:
      //   1. Role-collections are materialized inline by xs-security.json the
      //      moment create-service reaches status: succeeded; the assignment
      //      only needs state.user + state.subaccount (both captured during
      //      login). It does NOT require the approuter, route swap, or
      //      restage.
      //   2. Once the approuter takes over the public route (map-route, below)
      //      the operator's next request is bounced to IAS for sign-in. If the
      //      assignment hasn't committed by then, the fresh JWT will lack the
      //      scope and the auto-assign would have zero practical effect.
      // Failure here is non-fatal — XSUAA is up, the upgrade can proceed, and
      // the success state surfaces the cockpit-fallback messaging so the
      // operator can self-assign before clicking Continue.
      let assignFailedReason = null;
      if (autoAssign) {
        markPhase("assign-role", { status: "running", sub: `btp assign ${ASSIGN_ROLE}` });
        const ar = await api.xsuaa.assignRoleCollection(ASSIGN_ROLE);
        if (!ar || ar.ok === false) {
          assignFailedReason = (ar && ar.error) || "unknown";
          markPhase("assign-role", { status: "error", sub: assignFailedReason });
          // No setError() — we don't want to halt the upgrade. The post-run
          // success state surfaces the fallback messaging instead.
        } else {
          markPhase("assign-role", { status: "done", sub: `assigned ${ar.role} to ${ar.user}` });
        }
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
      let mapHost = null, mapDomain = null;
      const fullRoute = pre && pre.route;
      if (fullRoute) {
        const dot = fullRoute.indexOf(".");
        if (dot > 0) { mapHost = fullRoute.slice(0, dot); mapDomain = fullRoute.slice(dot + 1); }
      }
      if (!mapHost || !mapDomain) {
        setError("Could not determine the manager's public route. Inspect cf app figaf-manager in cockpit.");
        markPhase("map-route", { status: "error", sub: "route unknown" });
        return;
      }

      // Phase 2: route swap. We map the approuter to the public hostname here
      // and let cf:restage handle the unmap server-side (see below). Splitting
      // map-route and unmap-route across two RPCs is fine because the manager
      // is still on the route after the map; splitting unmap-route from
      // restage is NOT — the gorouter starts resolving the hostname to the
      // approuter the moment the manager is unmapped, and the next RPC 401s
      // at the approuter before reaching the manager.
      markPhase("map-route", { status: "running" });
      const m1 = await api.cf.mapRoute({ app: "figaf-manager-approuter", domain: mapDomain, hostname: mapHost });
      if (!m1.ok) { setError("mapRoute: " + (m1.stderr || "failed")); markPhase("map-route", { status: "error" }); return; }
      markPhase("map-route", { status: "done", sub: "approuter now serves the public route" });

      // Phase 2.5: unmap + bind + restage, all in one RPC. The handler runs
      // unmap-route → bind-service → spawn cf restage (fire-and-forget) on
      // the manager itself. The request arrives while the manager is still
      // on the public route; the OK response flows back over the already-
      // open TCP connection even after unmap-route removes the manager from
      // the gorouter. After this returns, the dyno will die in the next
      // 30-90s and the UI polls the approuter's /_manager-health.
      //
      // Pre-set figafSuppressAuthKick BEFORE the await. The orchestrator
      // spawns `cf restage` synchronously inside the handler, so the dyno can
      // begin its shutdown sequence while the HTTP response is still in
      // flight. If we set the flag only after the await resolves, an in-the-
      // gap WS close (unmap already happened — reconnect routes through the
      // approuter and gets a generic close on the unauthenticated tab) can
      // leak a redirect to /setup before we get a chance to suppress.
      // Setting it here is safe: any auth-kick during the upgrade phase is
      // already either bogus (we caused it ourselves by initiating restage)
      // or about to be superseded by the explicit "Continue to wizard" click.
      if (typeof window !== "undefined") window.figafSuppressAuthKick = true;

      markPhase("restage", { status: "running", sub: "manager will be offline for 30-90s" });
      // skipIfBound: on a re-run where the manager is already bound to xsuaa,
      // the orchestrator probes cf curl /v3/service_credential_bindings and
      // returns alreadyBound=true without forcing a needless 30-90s restage.
      // The first-time path doesn't hit this branch (no binding yet).
      const r3 = await api.cf.restage({
        app: "figaf-manager",
        bindXsuaa: true,
        skipIfBound: true,
        unmapRoute: { domain: mapDomain, hostname: mapHost },
      });
      if (!r3 || r3.ok === false) {
        // bind-service failed for a non-"already bound" reason (quota, perms,
        // network). The route swap is already committed at this point, so
        // recovery requires either re-running the upgrade (idempotent for
        // already-mapped routes) or manually binding+restaging from the
        // cockpit. Surface the error and stop — the success state is wrong
        // when XSUAA mode hasn't taken effect.
        setError("restage: " + (r3 && r3.error || "failed"));
        markPhase("restage", { status: "error", sub: r3 && r3.error });
        return;
      }
      // From this point on, the WebSocket may drop as the dyno dies. We do
      // NOT auto-redirect — instead we show the success state with an
      // explicit "Continue to wizard" button. The operator clicks when ready.
      //
      // figafSuppressAuthKick was set above (pre-await) so the suppression
      // is already in place. It stays true until window.location reloads
      // (Continue button), which resets the closure naturally.
      const subTxt = r3.alreadyBound ? "manager already in XSUAA mode" : "restage initiated";
      markPhase("restage", { status: "done", sub: subTxt });
      setCtx(c => ({ ...c, xsuaaUpgradeInitiated: true }));
      setOutcome({
        restaging: true,
        assignFailed: assignFailedReason,
        // If the manager was already bound, it's already in XSUAA mode; the
        // poll below would otherwise wait pointlessly for a mode-flip that
        // already happened.
        managerMode: r3.alreadyBound ? "xsuaa" : null,
      });
    } catch (e) {
      setError("Unexpected: " + e.message);
    }
  }

  // Post-restage poll: wait for the manager to come back in XSUAA mode before
  // letting the operator click "Continue to wizard." Without this gate, a
  // too-eager click lands on / while the OLD manager dyno (still in v1 mode)
  // is mid-restage. The old v1 manager 302s any uncookied GET to /setup —
  // which is exactly the bug the operator reported (and the reason for this
  // entire poll). Probes the approuter's unauthenticated /_manager-health
  // route, which proxies to manager's /health and forwards its JSON body
  // (see packages/manager-approuter/server.js#probeManager). Stops on the
  // first successful mode==="xsuaa" response.
  //
  // We deliberately do NOT use api.xsuaa.upgradeStatus() here — that goes
  // through the gated /rpc/* surface, which fails 401 the moment XSUAA mode
  // kicks in (no JWT, since the operator hasn't reauthed yet). The
  // /_manager-health route is unauthenticated by design for exactly this
  // poll case.
  React.useEffect(() => {
    if (!outcome || outcome.managerMode === "xsuaa") return;
    let cancelled = false;
    let elapsed = 0;
    const startedAt = Date.now();
    async function tick() {
      if (cancelled) return;
      try {
        const r = await fetch("/_manager-health", { cache: "no-store", credentials: "same-origin" });
        if (cancelled) return;
        // 200 with mode==="xsuaa" → done. 200 with mode==="token" → manager
        // back but still on the old droplet (race between cf restage scheduling
        // and the new droplet's first boot); keep polling. 503 → manager
        // currently unreachable (mid-restage); keep polling. Other → also poll.
        let body = null;
        try { body = await r.json(); } catch { /* ignore */ }
        if (r.ok && body && body.mode === "xsuaa") {
          setOutcome((o) => o ? { ...o, managerMode: "xsuaa" } : o);
          return;
        }
      } catch {
        // network blip during restage is expected; loop on.
      }
      elapsed = Date.now() - startedAt;
      // Total budget: 5 minutes. Beyond that, stop polling and let the
      // operator click Continue manually — they'll see the v1 /setup if the
      // restage truly never took, which is recoverable from the cockpit.
      if (elapsed > 5 * 60 * 1000) {
        setOutcome((o) => o ? { ...o, managerMode: "timeout" } : o);
        return;
      }
      setTimeout(tick, 4000);
    }
    // First tick after 3s — gives the dyno a beat to start its shutdown so
    // the probe isn't just hitting the about-to-die v1 manager.
    const h = setTimeout(tick, 3000);
    return () => { cancelled = true; clearTimeout(h); };
  }, [outcome && outcome.managerMode === "xsuaa" ? "done" : (outcome ? "polling" : "idle")]);

  // Manual reboot — explicit user click after seeing the success state.
  // window.location is sufficient: the page reloads against the public route,
  // which is now served by the approuter; the approuter sees no XSUAA cookie
  // and triggers an IAS sign-in. The new JWT includes the scope (assuming
  // assignment succeeded or was done manually beforehand).
  function continueToWizard() {
    try { window.location.href = "/"; } catch (_) { /* defensive */ }
  }

  // Manual reboot via the assign-role fallback screen — the operator who
  // hit an assignment failure may want to assign via cockpit first. Routes
  // there via the existing onNext path, which leads to xsuaa-assign-role.
  function openManualAssignFallback() {
    if (onNext) onNext();
  }

  const isSuccess = !!outcome;
  // The footer Cancel/Back buttons should disappear once the upgrade is
  // running (no graceful rollback path mid-flow).

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">XSUAA upgrade</div>
          <h1 className="pane-title">Enable persistent SSO login</h1>
          <p className="pane-desc">
            Replace the cockpit-log setup token with proper SAP IAS authentication. After this upgrade, anyone you add to the <strong>{ASSIGN_ROLE}</strong> role collection can come back to this wizard without the token dance.
          </p>
          <p className="pane-desc" style={{ fontSize: 12, color: "var(--ink-3)" }}>
            This will create one XSUAA service instance, push an approuter sibling app, optionally assign you to the role collection, and restage figaf-manager. Expect ~2-3 minutes total, with 30-90 seconds of downtime mid-flow.
          </p>
        </div>

        {!started && (
          <label
            style={{
              display: "flex", alignItems: "flex-start", gap: 10,
              padding: "12px 14px", marginBottom: 14,
              borderRadius: 8, background: "rgba(21,101,216,0.05)",
              border: "1px solid rgba(21,101,216,0.18)",
              cursor: "pointer", fontSize: 13, color: "var(--ink-1)",
            }}
          >
            <input
              type="checkbox"
              checked={autoAssign}
              onChange={(e) => setAutoAssign(e.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span>
              <strong style={{ color: "var(--ink-0)" }}>Assign me {ASSIGN_ROLE} after upgrade</strong>
              <br />
              <span style={{ color: "var(--ink-2)" }}>
                Runs <code>btp assign security/role-collection {ASSIGN_ROLE}</code> against your subaccount after XSUAA is up. Without this, you'll see a 403 on the next sign-in until you assign yourself in the cockpit.
              </span>
            </span>
          </label>
        )}

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

        {isSuccess && (
          <div style={{ marginTop: 16, padding: "14px 16px", borderRadius: 10, background: "rgba(34,197,94,0.06)", border: "1px solid rgba(34,197,94,0.25)", fontSize: 13, color: "var(--ink-1)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <Ico.Check style={{ width: 18, height: 18, color: "var(--ok, #15803d)" }} />
              <strong style={{ color: "var(--ink-0)", fontSize: 14 }}>
                {outcome.managerMode === "xsuaa"
                  ? "Upgrade complete — manager is in XSUAA mode."
                  : "Upgrade initiated — manager is restaging."}
              </strong>
            </div>
            <p style={{ margin: "6px 0", lineHeight: 1.55 }}>
              {outcome.managerMode === "xsuaa"
                ? <>The approuter is serving the public route and figaf-manager has come back up bound to XSUAA. Click Continue to reauthenticate through SAP IAS.</>
                : <>The approuter has taken over the public route and figaf-manager is rebinding to XSUAA (~30-90s). The Continue button unlocks once the manager reports XSUAA mode.</>}
              {outcome.assignFailed
                ? <> The role assignment <strong style={{ color: "var(--error, #b91c1c)" }}>did not succeed</strong> — you'll need to assign yourself manually before continuing.</>
                : <> You've been assigned <code>{ASSIGN_ROLE}</code> in your subaccount.</>}
            </p>
            {/*
              Live restage status. We render a thin readiness banner so the
              operator has feedback during the 30-90s window. Three states:
                null      → polling not yet completed a successful probe
                "xsuaa"   → confirmed; Continue button is enabled
                "timeout" → polled for 5 min without confirmation; the operator
                            can still click Continue, but will probably land on
                            v1 /setup (recoverable from cockpit)
            */}
            {outcome.managerMode !== "xsuaa" && (
              <p style={{ margin: "10px 0 0", padding: "8px 10px", borderRadius: 6, background: "rgba(21,101,216,0.06)", border: "1px solid rgba(21,101,216,0.18)", color: "var(--ink-1)", lineHeight: 1.5, fontSize: 12 }}>
                {outcome.managerMode === "timeout"
                  ? <><strong>Probe timeout.</strong> The manager hasn't reported XSUAA mode in 5 minutes. You can still click Continue — if you land on the legacy setup page, the bind may have failed; verify <code>cf services figaf-manager-xsuaa</code> in the cockpit and re-run the upgrade.</>
                  : <><strong>Waiting for manager to come back…</strong> Probing <code>/_manager-health</code> through the approuter. Continue unlocks automatically once the manager reports <code>mode: "xsuaa"</code>.</>}
              </p>
            )}
            <p style={{ margin: "10px 0 0", lineHeight: 1.55 }}>
              <strong>You must fully re-authenticate</strong> for the new scope to appear in your JWT. Your current cookies were issued before the role assignment and won't have it. After you click Continue, the approuter will redirect you through SAP IAS — sign in there to get a fresh token. If you see anything unexpected, use a private/incognito window or clear cookies for this hostname.
            </p>
            {outcome.assignFailed && (
              <p style={{ margin: "10px 0 0", padding: "10px 12px", borderRadius: 6, background: "rgba(225,29,72,0.07)", border: "1px solid rgba(225,29,72,0.2)", color: "var(--ink-1)", lineHeight: 1.5 }}>
                <strong style={{ color: "var(--ink-0)" }}>Assignment error:</strong> {outcome.assignFailed}
                <br />
                <span style={{ color: "var(--ink-2)" }}>
                  Open the BTP cockpit, find your user under the subaccount's Users tab, and assign the <code>{ASSIGN_ROLE}</code> role collection. Then click Continue.
                </span>
              </p>
            )}
          </div>
        )}
      </div>

      <div className="pane-foot">
        {!started && (
          <>
            {onBack && <button className="btn" onClick={onBack}><Ico.ArrowLeft /> Back</button>}
            <div className="spacer" />
            <button className="btn btn-primary" onClick={runUpgrade}>
              <Ico.Shield /> Start upgrade
            </button>
          </>
        )}
        {started && !isSuccess && (
          <>
            <div className="spacer" />
            <button className="btn btn-primary" disabled>
              <Ico.Shield /> Upgrading…
            </button>
          </>
        )}
        {isSuccess && (
          <>
            <div className="spacer" />
            {outcome.assignFailed && (
              <button className="btn" onClick={openManualAssignFallback} title="Open the cockpit deep-link to assign the role manually">
                <Ico.External /> Assign role in cockpit
              </button>
            )}
            {/*
              Continue button is disabled while we're still waiting for the
              manager to come back in XSUAA mode. This is the gate that
              prevents the "lands on /setup" bug: a too-early click sends the
              operator to /, the still-v1 manager 302s to /setup (no figaf_auth
              cookie), and they end up on the legacy claim page. The "timeout"
              state (5 min of polling without xsuaa confirmation) enables the
              button so the operator isn't stuck; if the bind/restage failed
              silently, the resulting /setup landing is still recoverable.
            */}
            {outcome.managerMode === "xsuaa" ? (
              <button className="btn btn-primary" onClick={continueToWizard} title="Reload through the approuter — you'll be prompted to sign in via SAP IAS">
                Continue to wizard <Ico.ArrowRight />
              </button>
            ) : outcome.managerMode === "timeout" ? (
              <button className="btn btn-primary" onClick={continueToWizard} title="The probe timed out; the manager may or may not be ready. Click to attempt continuation anyway.">
                Continue anyway <Ico.ArrowRight />
              </button>
            ) : (
              <button className="btn btn-primary" disabled title="Waiting for manager to come back in XSUAA mode">
                <Ico.Shield /> Waiting for manager…
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

function ScreenXsuaaAssignRole({ ctx, setCtx, onNext, onBack }) {
  const [cockpitUrl, setCockpitUrl] = React.useState(null);
  const [error, setError] = React.useState(null);

  // Defensive: this screen is reachable from the failed-auto-assign branch
  // of the upgrade success state, which means restage may still be in flight
  // and the WS may drop. The upgrade screen already set this flag, but if
  // the operator lands here via some other path (e.g. a future direct link)
  // we want to keep the auth-kick suppressed while they're reading the
  // manual-assign instructions. The flag self-clears on the next page load.
  React.useEffect(() => {
    if (typeof window !== "undefined") window.figafSuppressAuthKick = true;
  }, []);

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

  // Manual reboot from this fallback screen too — same target as the
  // upgrade screen's Continue button.
  function continueToWizard() {
    try { window.location.href = "/"; } catch (_) {}
  }

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">XSUAA upgrade · manual role assignment</div>
          <h1 className="pane-title">Assign yourself a role collection</h1>
          <p className="pane-desc">
            The auto-assignment didn't complete (or you opted out). Open BTP cockpit, find your user under your subaccount's Users tab, and assign <code>FigafManagerAdmin</code> (or <code>FigafManagerOperator</code> if you prefer non-destructive scope only). Takes about 30 seconds.
          </p>
        </div>

        <ol style={{ margin: "0 0 18px", paddingLeft: 18, color: "var(--ink-1)", fontSize: 14, lineHeight: 1.6 }}>
          <li>Click "Open cockpit" below — it deep-links to your subaccount's user-management page.</li>
          <li>Find yourself in the user list and open your row.</li>
          <li>In the "Role Collections" tab, assign <code>FigafManagerAdmin</code>.</li>
          <li>Return here and click "Continue to wizard" — you'll be redirected through SAP IAS for a fresh sign-in.</li>
        </ol>

        {error && (
          <div style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(225,29,72,0.07)", border: "1px solid rgba(225,29,72,0.25)", color: "var(--error, #b91c1c)", fontSize: 13 }}>
            {error}
          </div>
        )}
      </div>

      <div className="pane-foot">
        {onBack && <button className="btn" onClick={onBack}><Ico.ArrowLeft /> Back</button>}
        <div className="spacer" />
        <button className="btn" onClick={openCockpit} disabled={!cockpitUrl}>
          <Ico.External /> Open cockpit
        </button>
        <button className="btn btn-primary" onClick={continueToWizard} title="Reload through the approuter — you'll be prompted to sign in via SAP IAS">
          Continue to wizard <Ico.ArrowRight />
        </button>
      </div>
    </>
  );
}

Object.assign(window, { ScreenXsuaaUpgrade, ScreenXsuaaAssignRole });

/* global React */
// <UpdatePreflightModal/> — pre-flight check + redeploy trigger for the
// self-update flow. PR 2 added the pre-flight UI; PR 3 wires the full
// download → extract → push chain in-place.
//
// On open: calls update.selfTarget() and update.checkSelf() in parallel,
// then renders one of:
//   - "idle"     : pre-flight comparison + version info + Update button
//   - "running"  : per-phase progress (download / extract / preflight / push)
//   - "done"     : success — instructs operator to reconnect at the route
//   - "failed"   : error message + Retry
//
// Subscribes to the `update:selfPhase` stream for live progress. After
// kicking off `update:pushSelf`, the dyno bounces during the rolling
// cutover — the WebSocket will drop. We surface "Connection lost — this
// is expected" rather than pretending to monitor completion.
//
// Manual trigger (until PR 5 wires a banner):
//   window.figafShowPreflight();

(function () {
  "use strict";

  var STYLE = `
    .pf-overlay {
      position: fixed; inset: 0; z-index: 1000;
      background: rgba(15, 23, 42, 0.55);
      display: flex; align-items: center; justify-content: center;
    }
    .pf-card {
      background: var(--surface, #fff); color: var(--ink-0, #0F172A);
      width: min(620px, 92vw); max-height: 88vh; overflow: auto;
      border: 1px solid var(--border, #E4E7EC); border-radius: 10px;
      box-shadow: 0 24px 60px rgba(15, 23, 42, 0.35);
    }
    .pf-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 18px; border-bottom: 1px solid var(--border, #E4E7EC);
    }
    .pf-header h2 { margin: 0; font-size: 15px; font-weight: 600; }
    .pf-close {
      background: transparent; border: 0; font-size: 22px; line-height: 1;
      cursor: pointer; color: var(--ink-3, #6B7280); padding: 0 4px;
    }
    .pf-body { padding: 16px 18px; }
    .pf-loading, .pf-err, .pf-info { padding: 8px 0; color: var(--ink-2, #475569); font-size: 13px; }
    .pf-err { color: var(--danger, #DC2626); }
    .pf-summary { margin: 0 0 12px; font-size: 13px; color: var(--ink-1, #1F2937); }
    .pf-version {
      display: flex; gap: 16px; margin: 0 0 12px; padding: 10px 12px;
      border: 1px solid var(--border, #E4E7EC); border-radius: 8px;
      background: var(--surface-2, #F8FAFC); font-size: 12px;
    }
    .pf-version .v-cur { color: var(--ink-2, #475569); }
    .pf-version .v-new { color: var(--fg-blue, #1565D8); font-weight: 600; }
    .pf-row {
      display: grid; grid-template-columns: 120px 1fr 24px; gap: 10px;
      padding: 10px 12px; margin: 6px 0; border-radius: 8px;
      border: 1px solid var(--border, #E4E7EC); background: var(--surface-2, #F8FAFC);
      font-size: 12px;
    }
    .pf-row.ok  { border-color: var(--success, #10B981); background: var(--success-soft, #E8F8F1); }
    .pf-row.bad { border-color: var(--danger,  #DC2626); background: #FEF2F2; }
    .pf-label { font-weight: 600; align-self: center; }
    .pf-vals div { word-break: break-all; line-height: 1.4; }
    .pf-vals strong { color: var(--ink-2, #475569); font-weight: 500; margin-right: 4px; }
    .pf-mark { align-self: center; text-align: center; font-weight: 700; }
    .pf-row.ok  .pf-mark { color: var(--success, #10B981); }
    .pf-row.bad .pf-mark { color: var(--danger,  #DC2626); }
    .pf-actions {
      display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;
    }
    .pf-actions button {
      padding: 8px 14px; border-radius: 6px; font-size: 13px; cursor: pointer;
      border: 1px solid var(--border-strong, #D0D5DD); background: #fff; color: var(--ink-1, #1F2937);
    }
    .pf-actions .btn-primary {
      background: var(--fg-blue, #1565D8); border-color: var(--fg-blue, #1565D8); color: #fff;
    }
    .pf-actions .btn-primary:disabled {
      background: var(--ink-5, #CBD5E1); border-color: var(--ink-5, #CBD5E1); cursor: not-allowed;
    }
    .pf-phase {
      display: grid; grid-template-columns: 24px 1fr 80px; gap: 10px;
      align-items: center; padding: 8px 12px; margin: 4px 0;
      border-radius: 6px; font-size: 12px;
      background: var(--surface-2, #F8FAFC); border: 1px solid var(--border, #E4E7EC);
    }
    .pf-phase.running { border-color: var(--fg-blue, #1565D8); background: var(--fg-blue-softer, #F3F7FD); }
    .pf-phase.done    { border-color: var(--success, #10B981); background: var(--success-soft, #E8F8F1); }
    .pf-phase.failed  { border-color: var(--danger,  #DC2626); background: #FEF2F2; }
    .pf-phase .icon   { text-align: center; font-weight: 700; }
    .pf-phase.done    .icon { color: var(--success, #10B981); }
    .pf-phase.failed  .icon { color: var(--danger,  #DC2626); }
    .pf-phase.running .icon { color: var(--fg-blue, #1565D8); }
    .pf-phase .pct    { text-align: right; color: var(--ink-3, #6B7280); }
    .pf-success {
      padding: 12px; margin-top: 8px;
      border: 1px solid var(--success, #10B981); background: var(--success-soft, #E8F8F1);
      border-radius: 8px; font-size: 13px;
    }
    .pf-success a { color: var(--fg-blue, #1565D8); }
  `;

  // Ordered list of phases the chain emits. push-approuter is shown only
  // when the zip carries the v2 approuter tarball AND the live space has
  // figaf-manager-approuter deployed (caller sets `includeApprouter`).
  function phasesFor(includeApprouter) {
    var out = [
      { id: "download",  label: "Download new manager zip" },
      { id: "extract",   label: "Extract and validate archive" },
      { id: "preflight", label: "Re-verify cf target" },
    ];
    if (includeApprouter) {
      out.push({ id: "push-approuter", label: "Rolling cf push of figaf-manager-approuter" });
    }
    out.push({ id: "push-manager", label: "Rolling cf push of figaf-manager" });
    return out;
  }

  function StatusRow({ label, want, got, match }) {
    return (
      <div className={"pf-row " + (match ? "ok" : "bad")}>
        <span className="pf-label">{label}</span>
        <div className="pf-vals">
          <div><strong>Manager:</strong> {want || <em>(missing)</em>}</div>
          <div><strong>Your cf:</strong> {got  || <em>(unset)</em>}</div>
        </div>
        <span className="pf-mark">{match ? "✓" : "✗"}</span>
      </div>
    );
  }

  function PhaseRow({ phase, info }) {
    var state = info && info.state ? info.state : "pending";
    var icon = state === "done" ? "✓"
            : state === "failed" ? "✗"
            : state === "running" ? "…"
            : "·";
    var pct = info && info.percent != null ? info.percent + "%"
            : info && info.detail ? info.detail
            : "";
    return (
      <div className={"pf-phase " + state}>
        <span className="icon">{icon}</span>
        <span>{phase.label}{info && info.error ? ` — ${info.error}` : ""}</span>
        <span className="pct">{pct}</span>
      </div>
    );
  }

  function UpdatePreflightModal({ onClose }) {
    // mode: "loading" | "idle" | "running" | "done" | "failed"
    const [mode, setMode]               = React.useState("loading");
    const [preflight, setPreflight]     = React.useState(null);
    const [check, setCheck]             = React.useState(null);
    const [error, setError]             = React.useState(null);
    const [phases, setPhases]           = React.useState({});  // { [phaseId]: { state, percent, error, detail } }
    const [pushResult, setPushResult]   = React.useState(null);
    // True iff the extracted zip carries the v2 approuter tarball AND the
    // live space has figaf-manager-approuter deployed — set from extractSelf.
    const [includeApprouter, setIncludeApprouter] = React.useState(false);

    const loadPreflight = React.useCallback(async () => {
      setMode("loading");
      setError(null);
      try {
        const [pf, ck] = await Promise.all([
          window.figaf.update.selfTarget(),
          window.figaf.update.checkSelf(),
        ]);
        setPreflight(pf);
        setCheck(ck);
        setMode("idle");
      } catch (e) {
        setError(e && e.message ? e.message : String(e));
        setMode("failed");
      }
    }, []);

    React.useEffect(() => { loadPreflight(); }, [loadPreflight]);

    // Live phase events. Subscribe ONCE; cleanup on unmount. The WS may
    // drop mid-cf-push — that's fine, the renderer handles it as "lost
    // connection" rather than treating it as a phase failure.
    React.useEffect(() => {
      if (!window.figaf || !window.figaf.on) return undefined;
      const off = window.figaf.on("update:selfPhase", (evt) => {
        if (!evt || !evt.phase) return;
        setPhases(prev => ({ ...prev, [evt.phase]: evt }));
      });
      return () => off && off();
    }, []);

    const runRedeploy = React.useCallback(async () => {
      if (!check || !check.assets || !check.assets.cloud) {
        setError("no cloud asset on latest release"); setMode("failed"); return;
      }
      setMode("running");
      setPhases({});
      setError(null);

      const dl = await window.figaf.update.downloadSelf({ assetUrl: check.assets.cloud.url });
      if (!dl.ok) { setError("download failed: " + dl.error); setMode("failed"); return; }

      const ex = await window.figaf.update.extractSelf({ zipPath: dl.zipPath });
      if (!ex.ok) { setError("extract failed: " + ex.error); setMode("failed"); return; }
      setIncludeApprouter(!!ex.hasApprouterTarball);

      // includeApprouter mirrors the zip's content; the server then probes
      // whether figaf-manager-approuter is actually present in this space.
      const push = await window.figaf.update.pushSelf({
        extractedDir: ex.extractedDir,
        includeApprouter: ex.hasApprouterTarball,
      });
      if (!push.ok) { setError("push failed: " + push.error); setMode("failed"); return; }

      setPushResult(push);
      setMode("done");
    }, [check]);

    // ── Render branches ─────────────────────────────────────────────────────

    let body = null;

    if (mode === "loading") {
      body = <div className="pf-loading">Checking cf CLI target and latest release…</div>;
    }
    else if (mode === "failed" && error) {
      body = (
        <>
          <div className="pf-err">{error}</div>
          <div className="pf-actions">
            <button className="btn-secondary" onClick={loadPreflight}>Retry</button>
          </div>
        </>
      );
    }
    else if (mode === "idle" && preflight && preflight.ok === false) {
      body = <div className="pf-err">{preflight.error || "Pre-flight not available."}</div>;
    }
    else if (mode === "idle" && preflight && preflight.ok) {
      const pf = preflight;
      const clean = pf.loggedIn && !pf.mismatch.apiUrl && !pf.mismatch.org && !pf.mismatch.space;
      const ck = check || {};
      const hasUpdate = ck.ok && ck.updateAvailable && ck.assets && ck.assets.cloud;
      const summary = !clean
        ? !pf.loggedIn
          ? "You're not logged in to cf. Log in to the manager's landscape on the Login screen, then reopen this dialog."
          : pf.mismatch.apiUrl
            ? "Your cf CLI is logged in to a different CF landscape. Log out + re-login to the manager's landscape."
            : "Your cf CLI is targeted at a different org/space. Use Switch Org on the Login screen to re-target."
        : !ck.ok
          ? "Could not check for updates: " + (ck.error || "unknown")
          : !ck.updateAvailable
            ? "You're already on the latest version (" + ck.current + ")."
            : !ck.assets.cloud
              ? "The latest release v" + ck.latest + " is missing a figaf-manager-app-*.zip asset."
              : "Ready to redeploy to v" + ck.latest + ". This will end your session — reconnect at the same URL in ~3 min.";
      body = (
        <>
          <p className="pf-summary">{summary}</p>

          {ck.ok && (
            <div className="pf-version">
              <span className="v-cur">Current: <strong>v{ck.current}</strong></span>
              {ck.updateAvailable
                ? <span className="v-new">Latest: v{ck.latest}</span>
                : <span>(up to date)</span>}
            </div>
          )}

          <StatusRow label="CF API"
            want={pf.target.apiUrl}    got={pf.current.apiUrl}    match={!pf.mismatch.apiUrl} />
          <StatusRow label="Organisation"
            want={pf.target.orgName}   got={pf.current.orgName}   match={!pf.mismatch.org} />
          <StatusRow label="Space"
            want={pf.target.spaceName} got={pf.current.spaceName} match={!pf.mismatch.space} />

          <div className="pf-actions">
            <button
              className="btn-primary"
              disabled={!clean || !hasUpdate}
              title={clean ? (hasUpdate ? "Redeploy figaf-manager from the latest release" : "Nothing newer to install") : "Resolve the mismatches above first"}
              onClick={runRedeploy}
            >Update now</button>
          </div>
        </>
      );
    }
    else if (mode === "running") {
      body = (
        <>
          <p className="pf-summary">
            Redeploying to v{check && check.latest}. Your session will end during the rolling cutover — reconnect at the same URL once the new dyno is healthy.
          </p>
          {phasesFor(includeApprouter).map(p => <PhaseRow key={p.id} phase={p} info={phases[p.id]} />)}
        </>
      );
    }
    else if (mode === "done" && pushResult) {
      const route = pushResult.expectedRoute;
      body = (
        <>
          {phasesFor(includeApprouter).map(p => {
            // push-manager never receives a "done" event because the dyno
            // bounces mid-stream; show it as running on the done screen.
            const info = phases[p.id] || (p.id === "push-manager" ? { state: "running" } : { state: "done" });
            return <PhaseRow key={p.id} phase={p} info={info} />;
          })}
          <div className="pf-success">
            Rolling cf push initiated for <strong>{pushResult.appName}</strong>.
            The new dyno should be healthy in ~{Math.round(pushResult.etaSec / 60)} min.
            {route && (
              <> Reconnect at <a href={"https://" + route} target="_blank" rel="noopener noreferrer">{route}</a>.</>
            )}
            <br />
            <em>You may see "connection lost" in this tab — that is expected; the old dyno is being terminated.</em>
          </div>
        </>
      );
    }

    return (
      <>
        <style>{STYLE}</style>
        <div className="pf-overlay" onClick={mode === "running" ? undefined : onClose}>
          <div className="pf-card" onClick={(e) => e.stopPropagation()}>
            <header className="pf-header">
              <h2>Self-update — figaf-manager</h2>
              <button className="pf-close" onClick={onClose} title="Close">×</button>
            </header>
            <div className="pf-body">{body}</div>
          </div>
        </div>
      </>
    );
  }

  window.UpdatePreflightModal = UpdatePreflightModal;
})();

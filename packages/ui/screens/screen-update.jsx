/* global React, Ico, CheckRow, WizardFooter */

// ═══════════════════════════════════════════════════════════
// Update Figaf Tool — hosted-only branch.
// See update-figaf-tool-plan.md for the full design (D1–D8).
//
// ScreenUpdateConfig
//   Lets the operator confirm/edit the deployment ID, runs detection
//   (cf app <id>-app + cf curl /v3/apps/<guid>/droplets/current to
//   read the live image), picks a target tag from Docker Hub's *-btp
//   list, and exposes a "Skip XSUAA update" checkbox for the
//   role-collection-drift mitigation. On mount we also check
//   update:resumeStatus — if a prior run hasn't reached verified or
//   failed, we surface a banner offering Resume or Discard.
//
// ScreenUpdateProgress
//   Subscribes to update:phase + cli:line + cf:serviceStatus and runs
//   the flow sequentially: writeVars → updateXsuaa → pushApp("app")
//   → pushApp("router") → verify. Idempotency lives in the
//   orchestrator (each handler checks update-state.json + does its
//   own short-circuits), so a Retry button just re-runs from the
//   first non-done phase.
// ═══════════════════════════════════════════════════════════

const fg = () => (typeof window !== "undefined" && window.figaf) || null;

const UPDATE_PHASES = [
  { id: "refresh-templates", label: "Refresh deploy templates",  sub: "github.com/figaf/Figaf-BTP-Deployment · btp-users" },
  { id: "update-xsuaa",      label: "Update XSUAA service",      sub: "cf update-service figaf-xsuaa -c xs-security.json" },
  { id: "push-app",          label: "Rolling push of app",       sub: "cf push <id>-app --strategy rolling" },
  { id: "push-router",       label: "Rolling push of router",    sub: "cf push <id>-router --strategy rolling" },
  { id: "verify",            label: "Verify deployment",         sub: "/v3/apps/<id>-app/droplets/current + route check" },
];

function ScreenUpdateConfig({ ctx, setCtx, onNext, onBack }) {
  const upd = ctx.update || {};
  const [deployId, setDeployId] = React.useState(upd.deployId || "figaf-tool");
  const [detection, setDetection] = React.useState(upd.detection || null);
  const [detecting, setDetecting] = React.useState(false);
  const [tags, setTags] = React.useState(upd.availableTags || []);
  const [targetTag, setTargetTag] = React.useState(upd.targetTag || "");
  const [skipXsuaa, setSkipXsuaa] = React.useState(!!upd.skipXsuaa);
  const [resume, setResume] = React.useState(null);
  const [beginning, setBeginning] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  React.useEffect(() => {
    const api = fg();
    if (!api) return;
    (async () => {
      try {
        const t = await api.config.dockerHubBtpTags();
        if (t && t.ok && Array.isArray(t.tags)) setTags(t.tags);
      } catch {}
      try {
        const r = await api.update.resumeStatus();
        if (r && r.ok && r.hasInFlight) setResume(r.state || null);
      } catch {}
    })();
  }, []);

  async function detect() {
    const api = fg();
    if (!api) return;
    setError(null);
    setDetecting(true);
    try {
      const r = await api.update.detectDeployment({ deployId });
      setDetection(r);
      if (r && r.found && r.app && r.app.image && !targetTag) {
        const colon = r.app.image.indexOf(":");
        if (colon > 0) setTargetTag(r.app.image.slice(colon + 1));
      }
    } catch (e) {
      setError(e.message || String(e));
    }
    setDetecting(false);
  }

  async function discardResume() {
    const api = fg();
    if (!api) return;
    try { await api.update.clear(); } catch {}
    setResume(null);
  }

  function pickCandidate(c) {
    setDeployId(c.id);
    setDetection({ ok: true, found: true, deployId: c.id, app: { name: c.app, image: c.image, exists: true }, router: { name: c.router, exists: !!c.router } });
    if (c.image) {
      const colon = c.image.indexOf(":");
      if (colon > 0) setTargetTag(c.image.slice(colon + 1));
    }
  }

  async function startUpdate() {
    const api = fg();
    if (!api) return;
    if (!targetTag) { setError("Pick a target tag"); return; }
    setError(null);
    setBeginning(true);
    const currentImage = detection && detection.app ? detection.app.image : null;
    const r = await api.update.begin({ deployId, targetImageTag: targetTag });
    setBeginning(false);
    if (!r || r.ok === false) {
      setError((r && r.error) || "update:begin failed");
      return;
    }
    setCtx(c => ({
      ...c,
      update: {
        ...(c.update || {}),
        deployId,
        detection,
        availableTags: tags,
        targetTag,
        skipXsuaa,
        resumeState: null,
        previousImage: currentImage,
        verify: null,
      },
    }));
    onNext();
  }

  async function resumeUpdate() {
    if (!resume) return;
    setDeployId(resume.deployId || deployId);
    if (resume.targetImageTag) setTargetTag(resume.targetImageTag);
    setCtx(c => ({
      ...c,
      update: {
        ...(c.update || {}),
        deployId: resume.deployId || deployId,
        targetTag: resume.targetImageTag || targetTag,
        resumeState: resume,
        previousImage: c.update?.previousImage || null,
      },
    }));
    onNext();
  }

  const currentImage = detection && detection.app ? detection.app.image : null;
  const found = detection && detection.found;
  const candidates = (detection && detection.candidates) || [];

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 4 · Configure update</div>
          <h1 className="pane-title">Update Figaf Tool</h1>
          <p className="pane-desc">
            Pull the latest deploy templates from GitHub and rolling-push <span className="kbd">{deployId}-app</span> and <span className="kbd">{deployId}-router</span> to a new Docker image. The old instance keeps serving until the new one passes its health check.
          </p>
        </div>

        {resume && (
          <div className="card" style={{ padding: 14, marginBottom: 14, borderLeft: "3px solid var(--fg-blue)" }}>
            <div style={{ fontSize: 13, color: "var(--ink-0)", marginBottom: 6 }}>
              <strong>Resume in-flight update?</strong>
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 10 }}>
              A previous run of <span className="kbd">{resume.deployId}</span> stopped at phase <span className="kbd">{resume.phase}</span>
              {resume.lastError ? <> with error: <em>{resume.lastError}</em></> : null}.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary" onClick={resumeUpdate}>Resume</button>
              <button className="btn" onClick={discardResume}>Discard &amp; start over</button>
            </div>
          </div>
        )}

        <div className="card" style={{ padding: 18, marginBottom: 14 }}>
          <label className="field-label">Deployment ID</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input is-mono"
              value={deployId}
              onChange={(e) => setDeployId(e.target.value.trim())}
              style={{ flex: 1 }}
              placeholder="figaf-tool"
            />
            <button className="btn" onClick={detect} disabled={detecting || !deployId}>
              {detecting ? "Detecting…" : "Detect"}
            </button>
          </div>

          {detection && found && (
            <div style={{ marginTop: 14, fontSize: 12.5, color: "var(--ink-2)" }}>
              <div>
                <strong style={{ color: "var(--ink-0)" }}>{detection.app.name}</strong>{" "}
                <span className="pill green">found</span>
              </div>
              <div style={{ marginTop: 4, fontFamily: "var(--font-mono)" }}>
                {currentImage ? <>Current image: <span style={{ color: "var(--fg-blue)" }}>{currentImage}</span></> : "Current image: (unknown)"}
              </div>
              <div style={{ marginTop: 2 }}>
                {detection.router && detection.router.exists
                  ? <>Router <span className="kbd">{detection.router.name}</span> present.</>
                  : <>Router <span className="kbd">{deployId}-router</span> not found — push will create it.</>}
              </div>
            </div>
          )}

          {detection && !found && candidates.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginBottom: 8 }}>
                No app named <span className="kbd">{deployId}-app</span>. Found {candidates.length} candidate deployment{candidates.length === 1 ? "" : "s"}:
              </div>
              {candidates.map((c) => (
                <button
                  key={c.id}
                  className="btn"
                  style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 6 }}
                  onClick={() => pickCandidate(c)}
                >
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>{c.id}</div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{c.image}</div>
                </button>
              ))}
            </div>
          )}

          {detection && !found && candidates.length === 0 && (
            <div style={{ marginTop: 14, fontSize: 12.5, color: "var(--ink-3)" }}>
              No matching deployment found in the current space. Check the ID, or switch to the Deploy flow to install fresh.
            </div>
          )}
        </div>

        <div className="card" style={{ padding: 18, marginBottom: 14 }}>
          <label className="field-label">Target Docker image tag</label>
          <select
            className="input is-mono"
            value={targetTag}
            onChange={(e) => setTargetTag(e.target.value)}
            style={{ width: "100%" }}
          >
            <option value="">— choose —</option>
            {tags.map((t) => {
              const isCurrent = currentImage && currentImage.endsWith(":" + t);
              return <option key={t} value={t}>{t}{isCurrent ? "  (current)" : ""}</option>;
            })}
          </select>
          <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--ink-3)" }}>
            Selecting the current tag is allowed — useful if you want to re-apply XSUAA role drift fixes without changing the image.
          </div>
        </div>

        <div className="card" style={{ padding: 18, marginBottom: 14 }}>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={skipXsuaa}
              onChange={(e) => setSkipXsuaa(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              <div style={{ fontSize: 13, color: "var(--ink-0)" }}>Skip XSUAA update</div>
              <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                Leaves <span className="kbd">figaf-xsuaa</span> untouched. Pick this if you've hand-edited role collections in the cockpit and don't want them reset to the template defaults.
              </div>
            </span>
          </label>
        </div>

        <div style={{ marginBottom: 14 }}>
          <button
            type="button"
            className="btn"
            onClick={() => setShowAdvanced(s => !s)}
            style={{ width: "100%", justifyContent: "space-between" }}
          >
            <span>Advanced (edit vars.yml)</span>
            <span style={{ color: "var(--ink-3)" }}>{showAdvanced ? "▴" : "▾"}</span>
          </button>
          {showAdvanced && (
            <div className="card" style={{ padding: 14, marginTop: 8, fontSize: 12, color: "var(--ink-2)" }}>
              vars.yml is rewritten at run-time with <span className="kbd">id={deployId}</span> and <span className="kbd">DOCKER_IMAGE_VERSION={targetTag || "…"}</span>. Other variables in vars.yml (memory, RAM%, log cap, CC destinations) are preserved from the refreshed template. To override them, edit the Deploy flow's Configuration screen on a future run — the Update flow keeps the vars form minimal.
            </div>
          )}
        </div>

        {error && (
          <div className="card" style={{ padding: 12, marginBottom: 12, borderLeft: "3px solid var(--error, #e11d48)", fontSize: 12.5, color: "var(--ink-1)" }}>
            <strong style={{ color: "var(--error, #e11d48)" }}>Error:</strong> {error}
          </div>
        )}
      </div>

      <WizardFooter
        onBack={onBack}
        onNext={startUpdate}
        nextDisabled={!targetTag || !found || beginning}
        nextLabel={beginning ? "Starting…" : "Start update"}
      />
    </>
  );
}

function ScreenUpdateProgress({ ctx, setCtx, onNext, onBack }) {
  const upd = ctx.update || {};
  const deployId = upd.deployId || "figaf-tool";
  const targetTag = upd.targetTag || "";
  const skipXsuaa = !!upd.skipXsuaa;

  const [phases, setPhases] = React.useState(() => UPDATE_PHASES.map(p => ({ ...p, status: "pending" })));
  const [error, setError] = React.useState(null);
  const [running, setRunning] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const startedRef = React.useRef(false);

  const markPhase = React.useCallback((id, patch) => {
    setPhases(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p));
  }, []);

  React.useEffect(() => {
    const api = fg();
    if (!api || !api.on) return;
    const offPhase = api.on("update:phase", (msg) => {
      if (!msg || !msg.phase) return;
      const status = msg.state === "running" ? "running" : msg.state === "done" ? "done" : "error";
      const patch = { status };
      if (msg.error)  patch.sub = msg.error;
      if (msg.detail) patch.sub = msg.detail;
      markPhase(msg.phase, patch);
    });
    const offSvc = api.on("cf:serviceStatus", (msg) => {
      if (msg && msg.name === "figaf-xsuaa") markPhase("update-xsuaa", { sub: `status: ${msg.status}` });
    });
    return () => { offPhase && offPhase(); offSvc && offSvc(); };
  }, [markPhase]);

  const runFlow = React.useCallback(async () => {
    const api = fg();
    if (!api) return;
    setRunning(true);
    setError(null);

    try {
      const wv = await api.update.writeVars({ deployId, dockerTag: targetTag });
      if (!wv.ok) { setError(wv.error || "writeVars failed"); setRunning(false); return; }

      const ux = await api.update.updateXsuaa({ deployId, skip: skipXsuaa });
      if (!ux.ok) { setError(ux.error || "updateXsuaa failed"); setRunning(false); return; }

      const pa = await api.update.pushApp({ deployId, role: "app" });
      if (!pa.ok) { setError(pa.error || "pushApp(app) failed"); setRunning(false); return; }

      const pr = await api.update.pushApp({ deployId, role: "router" });
      if (!pr.ok) { setError(pr.error || "pushApp(router) failed"); setRunning(false); return; }

      const vf = await api.update.verify({ deployId });
      if (!vf.ok) { setError(vf.error || "verify failed"); setRunning(false); return; }

      setCtx(c => ({ ...c, update: { ...(c.update || {}), verify: vf } }));
      setRunning(false);
      setDone(true);
    } catch (e) {
      setError(e.message || String(e));
      setRunning(false);
    }
  }, [deployId, targetTag, skipXsuaa, setCtx]);

  React.useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    runFlow();
  }, [runFlow]);

  async function abort() {
    const api = fg();
    try { await api?.update?.clear(); } catch {}
    if (onBack) onBack();
  }

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 5 · Apply update</div>
          <h1 className="pane-title">
            {done ? "Update applied" : error ? "Update halted" : "Updating Figaf Tool…"}
          </h1>
          <p className="pane-desc">
            {done
              ? <>Rolling push completed with target tag <span className="kbd">{targetTag}</span>. The new instance is healthy and serving the public route.</>
              : error
                ? "A phase failed. The orchestrator has persisted state under update-state.json — retry resumes from the failed phase."
                : <>Updating <span className="kbd">{deployId}-app</span> and <span className="kbd">{deployId}-router</span> to <span className="kbd">{targetTag}</span>. Expand the CLI drawer to watch progress.</>}
          </p>
        </div>

        <div className="card" style={{ padding: "4px 18px" }}>
          <div className="checklist">
            {phases.map(p => <CheckRow key={p.id} {...p} />)}
          </div>
        </div>

        {error && (
          <div className="card" style={{ padding: 14, marginTop: 14, borderLeft: "3px solid var(--error, #e11d48)" }}>
            <div style={{ fontSize: 13, color: "var(--error, #e11d48)", marginBottom: 6 }}>
              <strong>Error:</strong> {error}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary" disabled={running} onClick={() => {
                setPhases(UPDATE_PHASES.map(p => ({ ...p, status: "pending" })));
                runFlow();
              }}>Retry from failed phase</button>
              <button className="btn" onClick={abort}>Abort &amp; clear state</button>
            </div>
          </div>
        )}

        {!done && !error && (
          <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center", fontSize: 12, color: "var(--ink-3)" }}>
            <Ico.Terminal style={{ color: "var(--fg-blue)" }} />
            <span>Rolling push keeps the old instance live until the new one's health check passes.</span>
          </div>
        )}
      </div>

      <WizardFooter
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!done}
        nextLabel={done ? "Finish" : running ? "Updating…" : "Halted"}
        backLabel="Cancel"
      />
    </>
  );
}

Object.assign(window, { ScreenUpdateConfig, ScreenUpdateProgress });

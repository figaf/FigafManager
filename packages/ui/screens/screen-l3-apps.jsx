/* global React, Ico */

// ═══════════════════════════════════════════════════════════
// L3 App Manager (PoC) — catalog dashboard
// One row per catalog app: status, versions, and the actions
// Install / Update / Configure / Health / Disable / Enable / Remove.
// Every action streams its cf commands into the terminal drawer.
// ═══════════════════════════════════════════════════════════

const L3_STATUS_META = {
  "not-installed": { label: "Not installed", cls: "gray" },
  "running":       { label: "Running",       cls: "blue" },
  "stopped":       { label: "Stopped",       cls: "gray" },
  "partial":       { label: "Partial",       cls: "gray" },
  "mixed":         { label: "Mixed",         cls: "gray" },
};

function L3StatusPill({ status }) {
  const meta = L3_STATUS_META[status] || { label: status || "…", cls: "gray" };
  return <span className={`pill ${meta.cls}`}>{meta.label}</span>;
}

function L3ConfigForm({ app, busy, figafSystems, onApply, onCancel }) {
  const [values, setValues] = React.useState({});
  const fields = app.configForm || [];
  return (
    <div style={{ marginTop: 10, padding: 12, border: "1px solid var(--line)", borderRadius: 8 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Configure {app.name}</div>
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>
        Values are applied with <span className="kbd">cf set-env</span> and never shown in the
        terminal or logs. Leave a field empty to keep its current value. The app restarts after apply.
      </div>
      {fields.map((f) => (
        <div className="field" key={f.key}>
          <div className="field-label">{f.key}{f.secret ? " (secret)" : ""}</div>
          {f.type === "figaf-system" && (
            <select
              className="input"
              value=""
              disabled={busy}
              style={{ marginBottom: 6 }}
              onChange={(e) => {
                if (e.target.value) setValues((v) => ({ ...v, [f.key]: e.target.value }));
              }}
            >
              <option value="">
                {figafSystems === null
                  ? "Looking for Figaf Tool deployments…"
                  : figafSystems.length === 0
                    ? "No Figaf Tool deployments visible to this login — enter the URL below"
                    : "Pick a discovered Figaf Tool deployment…"}
              </option>
              {(figafSystems || []).map((s) => (
                <option key={s.id} value={s.url}>{s.id} — {s.url}</option>
              ))}
            </select>
          )}
          <input
            className="input is-mono"
            type={f.secret ? "password" : "text"}
            autoComplete="off"
            value={values[f.key] || ""}
            placeholder={f.hint || (f.secret ? "unchanged" : "unchanged")}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          />
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="btn btn-primary" disabled={busy} onClick={() => onApply(values)}>
          Apply &amp; restart
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function L3AppRow({ app, status, busy, busyLabel, figafSystems, onAction }) {
  const [showConfig, setShowConfig] = React.useState(false);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const [health, setHealth] = React.useState(null);

  const st = status ? status.status : null;
  const installed = st && st !== "not-installed";
  const updateAvailable =
    installed && status.installedVersion && status.installedVersion !== status.catalogVersion;

  async function health_() {
    setHealth({ loading: true });
    const r = await onAction("health");
    setHealth(r || { ok: false, error: "no response" });
  }

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 14, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700 }}>{app.name}</div>
        <L3StatusPill status={st} />
        {busy && <span className="pill gray">{busyLabel || "working…"}</span>}
        <div className="spacer" style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
          installed: <span className="kbd">{(status && status.installedVersion) || "—"}</span>
          {" · "}channel: <span className="kbd">{app.version}</span>
          {updateAvailable && <span className="pill blue" style={{ marginLeft: 6 }}>update available</span>}
        </div>
      </div>

      {app.description && (
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}>{app.description}</div>
      )}

      <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>
        {(status ? status.parts : app.cfApps.map((c) => ({ name: c.name }))).map((p) => (
          <span key={p.name} style={{ marginRight: 12 }}>
            <span className="kbd">{p.name}</span>
            {" "}{p.exists === false ? "absent" : (p.state || "").toLowerCase()}
            {p.route ? <> · <a href={"https://" + p.route} target="_blank" rel="noopener noreferrer">{p.route}</a></> : null}
          </span>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        {!installed && (
          <button className="btn btn-primary" disabled={busy} onClick={() => onAction("install")}>
            Install {app.version}
          </button>
        )}
        {installed && (
          <button className="btn btn-primary" disabled={busy} onClick={() => onAction("update")}>
            {updateAvailable ? `Update to ${app.version}` : "Re-deploy"}
          </button>
        )}
        {installed && (app.configForm || []).length > 0 && (
          <button className="btn" disabled={busy} onClick={() => setShowConfig((s) => !s)}>Configure</button>
        )}
        {installed && app.healthPath && (
          <button className="btn" disabled={busy} onClick={health_}>Health</button>
        )}
        {st === "running" && (
          <button className="btn" disabled={busy} onClick={() => onAction("disable")}>Disable</button>
        )}
        {st === "stopped" && (
          <button className="btn" disabled={busy} onClick={() => onAction("enable")}>Enable</button>
        )}
        {installed && !confirmRemove && (
          <button className="btn" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove</button>
        )}
        {installed && confirmRemove && (
          <>
            <button
              className="btn"
              style={{ color: "var(--fg-red, #c0392b)" }}
              disabled={busy}
              onClick={() => { setConfirmRemove(false); onAction("remove"); }}
            >
              Confirm remove
            </button>
            <button className="btn" disabled={busy} onClick={() => setConfirmRemove(false)}>Keep</button>
          </>
        )}
      </div>

      {showConfig && (
        <L3ConfigForm
          app={app}
          figafSystems={figafSystems}
          busy={busy}
          onCancel={() => setShowConfig(false)}
          onApply={async (values) => {
            const r = await onAction("configure", { env: values });
            if (r && r.ok) setShowConfig(false);
          }}
        />
      )}

      {health && (
        <div style={{ marginTop: 10, fontSize: 12 }}>
          {health.loading ? (
            <span style={{ color: "var(--ink-3)" }}>Checking {app.healthPath} …</span>
          ) : (
            <>
              <div style={{ color: "var(--ink-3)", marginBottom: 4 }}>
                {health.url || app.healthPath} —{" "}
                {health.ok
                  ? "all connections ok"
                  : health.httpStatus
                    ? `HTTP ${health.httpStatus} — some connections are not ok (details below)`
                    : `error: ${health.error || "?"}`}
              </div>
              {health.body != null && (
                <pre style={{ margin: 0, padding: 10, background: "var(--terminal-bg, #111)", color: "var(--terminal-fg, #ddd)", borderRadius: 8, overflowX: "auto", maxHeight: 220 }}>
                  {typeof health.body === "string" ? health.body : JSON.stringify(health.body, null, 2)}
                </pre>
              )}
            </>
          )}
        </div>
      )}

      {(app.roleCollections || []).length > 0 && (
        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 8 }}>
          Access roles (assign to users in the BTP cockpit): {app.roleCollections.join(", ")}
        </div>
      )}
    </div>
  );
}

function ScreenL3Apps({ ctx, setCtx, onBack, onConnections }) {
  const [catalog, setCatalog] = React.useState(null);   // { channelVersion, apps } | { error }
  const [statuses, setStatuses] = React.useState({});   // appId → status row
  const [refreshing, setRefreshing] = React.useState(false);
  const [busyApp, setBusyApp] = React.useState(null);   // appId currently running an action
  const [busyLabel, setBusyLabel] = React.useState("");
  const [lastError, setLastError] = React.useState(null);
  // Discovered Figaf Tool deployments for "figaf-system" config fields.
  // null = not loaded yet; [] = looked and found none (manual entry stays).
  const [figafSystems, setFigafSystems] = React.useState(null);

  const api = typeof window !== "undefined" ? window.figaf : null;

  const refresh = React.useCallback(async () => {
    if (!api || !api.l3) return;
    setRefreshing(true);
    try {
      const s = await api.l3.status();
      if (s && s.ok) {
        const map = {};
        for (const row of s.apps) map[row.id] = row;
        setStatuses(map);
        setLastError(null);
      } else if (s && s.error) {
        setLastError(s.error);
      }
    } finally {
      setRefreshing(false);
    }
  }, [api]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!api || !api.l3) { setCatalog({ error: "l3 surface unavailable" }); return; }
      const c = await api.l3.catalog();
      if (cancelled) return;
      setCatalog(c && c.ok ? c : { error: (c && c.error) || "catalog load failed" });
      if (c && c.ok) {
        refresh();
        // Discover Figaf Tool deployments only when some app's form wants one.
        const wantsFigaf = c.apps.some((a) => (a.configForm || []).some((f) => f.type === "figaf-system"));
        if (wantsFigaf && api.l3.figafSystems) {
          const fs = await api.l3.figafSystems();
          if (!cancelled) setFigafSystems(fs && fs.ok ? fs.systems : []);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [api, refresh]);

  async function doAction(app, action, extra) {
    if (!api || !api.l3 || busyApp) return { ok: false, error: "busy" };
    const labels = {
      install: "installing…", update: "updating…", disable: "stopping…",
      enable: "starting…", remove: "removing…", configure: "configuring…", health: "health check…",
    };
    setBusyApp(app.id);
    setBusyLabel(labels[action] || "working…");
    setLastError(null);
    try {
      const r = await api.l3[action]({ appId: app.id, ...(extra || {}) });
      if (r && !r.ok && r.error) setLastError(`${app.name}: ${r.error}`);
      return r;
    } catch (e) {
      setLastError(`${app.name}: ${(e && e.message) || "action failed"}`);
      return { ok: false, error: (e && e.message) || "action failed" };
    } finally {
      setBusyApp(null);
      setBusyLabel("");
      if (action !== "health") refresh();
    }
  }

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Manage L3 apps</div>
          <h1 className="pane-title">Figaf L3 applications</h1>
          <p className="pane-desc">
            Installed into <span className="kbd">{ctx.login.org || "?"} / {ctx.login.space || "?"}</span>.
            Artifacts come from the bundled channel
            {catalog && catalog.channelVersion ? <> (version <span className="kbd">{catalog.channelVersion}</span>)</> : null}.
            Every action runs plain <span className="kbd">cf</span> commands — open the terminal drawer to follow along.
          </p>
        </div>

        {lastError && (
          <div style={{ marginBottom: 12, padding: 10, border: "1px solid var(--fg-red, #c0392b)", borderRadius: 8, fontSize: 13 }}>
            {lastError}
          </div>
        )}

        {!catalog && <div style={{ color: "var(--ink-3)" }}>Loading catalog…</div>}
        {catalog && catalog.error && (
          <div style={{ color: "var(--ink-3)" }}>
            <strong>No app catalog available.</strong> {catalog.error}
          </div>
        )}

        {catalog && catalog.apps && catalog.apps.map((app) => (
          <L3AppRow
            key={app.id}
            app={app}
            status={statuses[app.id]}
            busy={busyApp === app.id}
            busyLabel={busyLabel}
            figafSystems={figafSystems}
            onAction={(action, extra) => doAction(app, action, extra)}
          />
        ))}

        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button className="btn" onClick={refresh} disabled={refreshing || !!busyApp}>
            {refreshing ? "Refreshing…" : "Refresh status"}
          </button>
        </div>
      </div>

      <div className="pane-foot">
        <div className="spacer" />
        {onConnections && (
          <button className="btn" onClick={onConnections} disabled={!!busyApp}>
            Connections
          </button>
        )}
        <button className="btn" onClick={onBack} disabled={!!busyApp}>
          <Ico.ArrowLeft /> Back
        </button>
      </div>
    </>
  );
}

Object.assign(window, { ScreenL3Apps });
